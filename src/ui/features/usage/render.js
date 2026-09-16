import { deltaFor } from './range-model.js';

const METRIC_HELP = Object.freeze({
  toolCalls: 'Total Rel.AI tool actions recorded in this range. The change compares with the previous equivalent period.',
  recoverableFailures: 'Actions with a recoverable task or context problem. A retry or context refresh can usually resolve the problem.',
  operationSuccessRate: 'Share of recorded actions where the requested command or check succeeded. Rate changes use percentage points (pp); 90% to 95% is +5 pp.',
  averageDuration: 'Average elapsed time per completed action in this range. The change compares with the previous equivalent period when available.',
  requestDeliveryRate: 'Share of MCP requests that finished delivering a response. Server-error responses can still be delivered, so this measures delivery rather than tool success.'
});

export function analyticsMetrics(scope, previous) {
  const values = key => scope.points.map(point => pointMetric(point, key));
  const compare = (key, options = {}) => scope.usedMonthlyFallback || options.available === false || options.previousAvailable === false
    ? null
    : deltaFor(scope, previous, key, options);
  const metric = (label, key, value, detail = '', options = {}) => ({
    key, label, value, detail, help: METRIC_HELP[key] || '',
    delta: compare(key, options), values: options.spark === false ? [] : values(options.sparkKey || key),
    tone: options.metricTone || ''
  });
  return [
    metric('Actions', 'toolCalls', integer(scope.toolCalls), '', { neutral: true }),
    metric('Retryable problems', 'recoverableFailures', integer(scope.recoverableFailures), 'Usually fixed by retrying or refreshing context', { inverse: true }),
    metric('Successful actions', 'operationSuccessRate', scope.completed ? percent(scope.operationSuccessRate) : '—', 'Whether the command or check itself succeeded', { rate: true, sparkKey: 'operationSuccessRate', available: scope.completed > 0, previousAvailable: Number(previous?.completed || 0) > 0 }),
    metric('Average time', 'averageDuration', duration(scope.averageDuration), scope.completed ? 'Per completed action' : '', { inverse: true, sparkKey: 'averageDuration', available: scope.completed > 0, previousAvailable: Number(previous?.completed || 0) > 0 }),
    ...(scope.transport && Number(scope.transport.request_started || 0) > 0
      ? [metric(
          'Request delivery',
          'requestDeliveryRate',
          percent(scope.requestDeliveryRate),
          `${integer(scope.transport.response_delivered)} of ${integer(scope.transport.request_started)} responses delivered${Number(scope.transport.connection_closed || 0) > 0 ? ` · ${integer(scope.transport.connection_closed)} closed early` : ''}${Number(scope.transport.upstream_5xx || 0) > 0 ? ` · ${integer(scope.transport.upstream_5xx)} server-error responses` : ''}`,
          { rate: true, spark: false, available: true, previousAvailable: Number(previous?.transport?.request_started || 0) > 0 }
        )]
      : [])
  ];
}

export function pointMetric(point, key) {
  const completed = Number(point?.successes || 0) + Number(point?.failures || 0);
  if (key === 'reliabilityRate') return point?.reliabilityCalls ? Number(point.reliableCalls || 0) / Number(point.reliabilityCalls) * 100 : null;
  if (key === 'operationSuccessRate' || key === 'successRate') return completed ? Number(point.successes || 0) / completed * 100 : null;
  if (key === 'averageDuration') return completed ? Number(point.executionMs || 0) / completed : null;
  return Number(point?.[key] || 0);
}

export function timelineModel(values, metricLabel = 'Actions') {
  const data = nullableValues(values);
  const observed = data.map((value, index) => ({ value, index })).filter(row => row.value !== null);
  if (!observed.length || (metricLabel === 'Actions' && observed.every(row => row.value === 0))) {
    return { empty: true, data, summary: 'No activity in this range.' };
  }
  const peakRow = observed.reduce((best, row) => row.value > best.value ? row : best, observed[0]);
  const latestRow = observed.at(-1);
  const first = observed[0].value;
  const latest = latestRow.value;
  const bucketsAgo = Math.max(0, latestRow.index - peakRow.index);
  const trend = latest > first ? 'increasing' : latest < first ? 'decreasing' : 'steady';
  return {
    empty: false,
    data,
    max: Math.max(peakRow.value, 1),
    peak: peakRow.value,
    peakIndex: peakRow.index,
    latestIndex: latestRow.index,
    summary: `${metricLabel} trend. Peak ${formatChartValue(peakRow.value, metricLabel)} ${bucketsAgo ? `${bucketsAgo} periods ago` : 'in the latest measured period'}. Latest ${formatChartValue(latest, metricLabel)}. Overall trend ${trend}.`
  };
}

export function failureCategoryLabel(category) {
  return ({
    cancelled: 'Cancelled',
    timeout: 'Timed out',
    authorization: 'Sign-in & access',
    capacity: 'Busy / resources',
    transport: 'Connection',
    policy: 'Safety & approval',
    workspace: 'Project & files',
    git: 'Git',
    process: 'Command',
    validation: 'Input or check',
    task: 'Task state',
    stale: 'Changed state',
    search: 'Search & index',
    desktop: 'Browser & desktop',
    app: 'App & local data',
    internal: 'Internal error',
    unclassified: 'Unclassified'
  })[String(category || '').toLowerCase()] || 'Unclassified';
}

export function integer(value) {
  return Math.floor(Number(value) || 0).toLocaleString();
}

function percent(value) {
  const number = Number(value) || 0;
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

export function duration(value) {
  const ms = Number(value) || 0;
  if (ms < 1000) return `${Math.floor(ms).toLocaleString()} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)} min`;
  return `${(minutes / 60).toFixed(2)} h`;
}

export function formatChartValue(value, metricLabel) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  if (metricLabel === 'Successful actions' || metricLabel === 'Success rate') return percent(value);
  if (/duration|tool time|average time/i.test(metricLabel)) return duration(value);
  return integer(value);
}

function nullableValues(values) {
  return (values || []).map(value => {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  });
}
