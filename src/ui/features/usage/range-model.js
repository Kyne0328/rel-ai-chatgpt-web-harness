import { normalizeFailureCategory } from '../../../analyticsFailureCategory.js';
import {
  isPrimaryAnalyticsUseCase,
  normalizeAnalyticsTaskIntent,
  normalizeAnalyticsUseCase
} from '../../../contracts/analyticsTaxonomy.js';

const RANGE_MS = Object.freeze({
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
});

export const ANALYTICS_RANGES = Object.freeze([
  ['1h', 'Current UTC hour'],
  ['24h', 'Latest 24 UTC-hour buckets'],
  ['7d', 'Latest 7 days of UTC-hour buckets'],
  ['30d', 'Latest 30 days of UTC-hour buckets'],
  ['month', 'This month'],
  ['custom', 'Custom range']
]);

const HOUR_MS = 60 * 60 * 1000;
const RELIABILITY_KEYS = Object.freeze(['reliabilityCalls', 'reliableCalls', 'infrastructureFailures', 'operationFailures', 'recoverableFailures', 'cancellations']);
const TRANSPORT_KEYS = Object.freeze(['request_started', 'request_reached_runtime', 'request_cancelled', 'connection_closed', 'upstream_5xx', 'response_delivered']);
const TOTAL_KEYS = Object.freeze(['requests', 'toolCalls', 'successes', 'failures', 'executionMs', ...RELIABILITY_KEYS]);
const GROUP_KEYS = Object.freeze(['toolCalls', 'successes', 'failures', 'executionMs', ...RELIABILITY_KEYS]);

export function analyticsBounds(range = '24h', { now = new Date(), customStart = '', customEnd = '' } = {}) {
  const endNow = new Date(now);
  if (!Number.isFinite(endNow.getTime())) throw new Error('The selected analytics range has an invalid time.');
  let start;
  let end = endNow;
  if (range === 'month') {
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  } else if (range === 'custom') {
    start = parseDateStart(customStart);
    const inclusiveEnd = parseDateStart(customEnd);
    if (!start || !inclusiveEnd) throw new Error('Choose both custom dates.');
    end = new Date(inclusiveEnd.getTime() + 24 * HOUR_MS);
    if (end > endNow) end = endNow;
    if (start >= end) throw new Error('Custom analytics start must be before the end date.');
    if (end.getTime() - start.getTime() > 90 * 24 * HOUR_MS) throw new Error('Custom analytics ranges are limited to 90 days.');
  } else {
    end = ceilUtcHour(end);
    const duration = RANGE_MS[range] || RANGE_MS['24h'];
    start = new Date(end.getTime() - duration);
  }
  end = ceilUtcHour(end);
  const duration = Math.max(HOUR_MS, end.getTime() - start.getTime());
  const previousEnd = new Date(start);
  const previousStart = new Date(start.getTime() - duration);
  return { range, start, end, previousStart, previousEnd, label: rangeLabel(range, start, end) };
}

export function analyticsMonths(bounds) {
  const start = new Date(Math.min(bounds.previousStart.getTime(), bounds.start.getTime()));
  const end = new Date(Math.max(bounds.previousEnd.getTime(), bounds.end.getTime()) - 1);
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  const months = [];
  while (cursor.getTime() <= last && months.length < 8) {
    months.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

export function normalizeUsageSnapshot(snapshot, requestedMonth = '') {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.ok === false) throw new Error(String(snapshot?.error || 'Analytics unavailable.'));
  const month = normalizeMonth(snapshot.month || requestedMonth);
  if (!month) throw new Error('Analytics are unavailable for the selected month.');
  return {
    month,
    privacy: normalizePrivacy(snapshot.privacy),
    totals: normalizeTotals(snapshot.totals),
    transport: normalizeTransport(snapshot.transport, 'transport'),
    tools: normalizeBreakdown(snapshot.tools, 'tool'),
    workspaces: normalizeBreakdown(snapshot.workspaces, 'workspace'),
    workspaceTools: normalizeBreakdown(snapshot.workspaceTools, 'workspaceTool'),
    activityMatrix: normalizeActivityMatrix(snapshot.activityMatrix),
    workspaceActivityMatrix: normalizeActivityMatrix(snapshot.workspaceActivityMatrix, { workspace: true }),
    taskIntents: normalizeTaskIntentRows(snapshot.taskIntents),
    workspaceTaskIntents: normalizeTaskIntentRows(snapshot.workspaceTaskIntents, { workspace: true }),
    series: normalizeSeries(snapshot.series, 'overall'),
    transportSeries: normalizeTransportSeries(snapshot.transportSeries),
    toolSeries: normalizeSeries(snapshot.toolSeries, 'tool'),
    workspaceSeries: normalizeSeries(snapshot.workspaceSeries, 'workspace'),
    workspaceToolSeries: normalizeSeries(snapshot.workspaceToolSeries, 'workspaceTool'),
    activityMatrixSeries: normalizeActivityMatrix(snapshot.activityMatrixSeries, { series: true }),
    workspaceActivityMatrixSeries: normalizeActivityMatrix(snapshot.workspaceActivityMatrixSeries, { workspace: true, series: true }),
    taskIntentSeries: normalizeTaskIntentRows(snapshot.taskIntentSeries, { series: true }),
    workspaceTaskIntentSeries: normalizeTaskIntentRows(snapshot.workspaceTaskIntentSeries, { workspace: true, series: true }),
    failureCategories: normalizeFailureRows(snapshot.failureCategories),
    workspaceFailureCategories: normalizeFailureRows(snapshot.workspaceFailureCategories, { workspace: true }),
    failureCategorySeries: normalizeFailureRows(snapshot.failureCategorySeries, { series: true }),
    workspaceFailureCategorySeries: normalizeFailureRows(snapshot.workspaceFailureCategorySeries, { workspace: true, series: true })
  };
}

export function analyticsRangeScope(models, bounds, { workspace = '', monthlyFallback = false } = {}) {
  const all = Array.isArray(models) ? models : [];
  const rows = all.flatMap(model => model.series).filter(row => inRange(row.hour, bounds.start, bounds.end));
  const workspaceRows = all.flatMap(model => model.workspaceSeries).filter(row => inRange(row.hour, bounds.start, bounds.end) && workspaceMatch(row, workspace));
  const baseRows = workspace ? workspaceRows : rows;
  let totals = sumRows(baseRows);
  let transport = workspace
    ? null
    : sumTransportRows(all.flatMap(model => model.transportSeries).filter(row => inRange(row.hour, bounds.start, bounds.end)));
  let usedMonthlyFallback = false;
  let fallbackModel = null;
  if (monthlyFallback && bounds.range === 'month') {
    const model = all.find(item => item.month === monthKey(bounds.end.getTime() - 1));
    fallbackModel = model || null;
    if (model) {
      if (workspace) {
        const relevant = model.workspaces.filter(row => row.workspace === workspace);
        if (relevant.length) totals = sumRows(relevant);
      } else {
        totals = { ...model.totals };
        transport = { ...model.transport };
      }
      usedMonthlyFallback = true;
    }
  }
  if (!usedMonthlyFallback) totals.activeDays = uniqueActiveDays(baseRows);
  else if (!Number.isFinite(totals.activeDays)) totals.activeDays = uniqueActiveDays(baseRows);
  const toolRows = workspace
    ? all.flatMap(model => model.workspaceToolSeries).filter(row => inRange(row.hour, bounds.start, bounds.end) && workspaceMatch(row, workspace))
    : all.flatMap(model => model.toolSeries).filter(row => inRange(row.hour, bounds.start, bounds.end));
  const tools = groupRows(toolRows, row => row.tool || 'Unknown tool', 'tool');
  const workspaces = workspace ? [] : groupRows(all.flatMap(model => model.workspaceSeries).filter(row => inRange(row.hour, bounds.start, bounds.end)), row => row.workspace || 'Unattributed', 'workspace');
  let matrixRows = workspace
    ? all.flatMap(model => model.workspaceActivityMatrixSeries).filter(row => inRange(row.hour, bounds.start, bounds.end) && workspaceMatch(row, workspace))
    : all.flatMap(model => model.activityMatrixSeries).filter(row => inRange(row.hour, bounds.start, bounds.end));
  let taskRows = workspace
    ? all.flatMap(model => model.workspaceTaskIntentSeries).filter(row => inRange(row.hour, bounds.start, bounds.end) && workspaceMatch(row, workspace))
    : all.flatMap(model => model.taskIntentSeries).filter(row => inRange(row.hour, bounds.start, bounds.end));
  const categoryRows = workspace
    ? all.flatMap(model => model.workspaceFailureCategorySeries).filter(row => inRange(row.hour, bounds.start, bounds.end) && workspaceMatch(row, workspace))
    : all.flatMap(model => model.failureCategorySeries).filter(row => inRange(row.hour, bounds.start, bounds.end));
  let failureCategories = groupFailureCategories(categoryRows);
  if (usedMonthlyFallback && fallbackModel) {
    matrixRows = workspace
      ? fallbackModel.workspaceActivityMatrix.filter(row => workspaceMatch(row, workspace))
      : fallbackModel.activityMatrix;
    taskRows = workspace
      ? fallbackModel.workspaceTaskIntents.filter(row => workspaceMatch(row, workspace))
      : fallbackModel.taskIntents;
    const monthlyCategories = workspace
      ? fallbackModel.workspaceFailureCategories.filter(row => workspaceMatch(row, workspace))
      : fallbackModel.failureCategories;
    failureCategories = groupFailureCategories(monthlyCategories);
  }
  const primaryMatrixRows = matrixRows.filter(row => isPrimaryAnalyticsUseCase(row.useCase));
  const useCases = groupAnalyticsRows(primaryMatrixRows, row => row.useCase, 'useCase');
  const activityMatrix = groupAnalyticsMatrix(primaryMatrixRows.filter(row => row.intent !== 'untracked'));
  const taskTypes = groupTaskIntents(taskRows);
  const categorizedActions = primaryMatrixRows.reduce((sum, row) => sum + Number(row.toolCalls || 0), 0);
  const allMatrixActions = matrixRows.reduce((sum, row) => sum + Number(row.toolCalls || 0), 0);
  const untrackedActions = primaryMatrixRows.filter(row => row.intent === 'untracked').reduce((sum, row) => sum + Number(row.toolCalls || 0), 0);
  const completedTasks = taskTypes.reduce((sum, row) => sum + Number(row.tasks || 0), 0);
  const points = bucketSeries(baseRows, bounds.start, bounds.end);
  return {
    kind: workspace ? 'workspace' : 'all',
    label: workspace || 'All projects',
    workspace,
    ...totals,
    completed: totals.successes + totals.failures,
    successRate: totals.successes + totals.failures ? totals.successes / (totals.successes + totals.failures) * 100 : 0,
    operationSuccessRate: totals.successes + totals.failures ? totals.successes / (totals.successes + totals.failures) * 100 : 0,
    reliabilityRate: totals.reliabilityCalls ? totals.reliableCalls / totals.reliabilityCalls * 100 : null,
    averageDuration: totals.successes + totals.failures ? totals.executionMs / (totals.successes + totals.failures) : 0,
    requestDeliveryRate: transport && Number(transport.request_started || 0) > 0
      ? Number(transport.response_delivered || 0) / Number(transport.request_started) * 100
      : null,
    transport,
    tools,
    workspaces,
    useCases,
    taskTypes,
    activityMatrix,
    categorizedActions,
    untrackedActions,
    legacyUncategorizedActions: Math.max(0, Number(totals.toolCalls || 0) - allMatrixActions),
    completedTasks,
    failureCategories,
    points,
    usedMonthlyFallback
  };
}

export function deltaFor(current, previous, key, { rate = false, inverse = false, neutral = false } = {}) {
  const now = Number(current?.[key] || 0);
  const before = Number(previous?.[key] || 0);
  if (rate) {
    const delta = now - before;
    return { value: delta, text: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp`, tone: delta === 0 ? '' : (inverse ? delta < 0 : delta > 0) ? 'good' : 'bad' };
  }
  if (before === 0) return now === 0 ? { value: 0, text: 'No change', tone: '' } : { value: Infinity, text: 'New activity', tone: inverse ? 'bad' : '' };
  const value = (now - before) / before * 100;
  return { value, text: `${value < 0 ? '-' : '+'}${Math.abs(value) > 999 ? '>999' : Math.abs(value).toFixed(1)}%`, tone: neutral || value === 0 ? '' : (inverse ? value < 0 : value > 0) ? 'good' : 'bad' };
}

export function workspaceOptions(models) {
  const aliases = new Set((models || []).flatMap(model => model.workspaces).map(row => row.workspace).filter(Boolean));
  return [...aliases].sort((a, b) => a.localeCompare(b)).map(workspace => ({ workspace }));
}

function normalizePrivacy(value) {
  const telemetry = value?.externalTelemetry && typeof value.externalTelemetry === 'object'
    ? value.externalTelemetry
    : {};
  const retentionDays = Number(value?.retentionDays || 0);
  return {
    retentionDays: Number.isFinite(retentionDays) && retentionDays > 0 ? Math.floor(retentionDays) : 0,
    externalTelemetry: {
      enabled: telemetry.enabled === true,
      endpointConfigured: telemetry.endpointConfigured === true,
      sampleRatio: optionalNumber(telemetry.sampleRatio, 1, 'privacy.externalTelemetry.sampleRatio')
    }
  };
}

function normalizeTotals(value) {
  if (!value || typeof value !== 'object') throw new Error('Analytics are unavailable because monthly totals were not returned.');
  const result = {};
  for (const key of ['requests', 'toolCalls', 'successes', 'failures', 'executionMs', 'activeDays']) result[key] = exactNumber(value[key], key);
  return { ...result, ...normalizeReliability(value, 'totals') };
}

function normalizeTransport(value, label) {
  const row = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(TRANSPORT_KEYS.map(key => [key, optionalNumber(row[key], 0, `${label}.${key}`)]));
}

function normalizeTransportSeries(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    hour: String(item?.hour || ''),
    ...normalizeTransport(item, 'transportSeries')
  })).filter(row => hourTime(row.hour) !== null);
}

function normalizeBreakdown(value, kind) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const row = item && typeof item === 'object' ? item : {};
    const successes = exactNumber(row.successes, `${kind}.successes`);
    const failures = exactNumber(row.failures, `${kind}.failures`);
    return {
      ...(kind.toLowerCase().includes('tool') ? { tool: String(row.tool || '') } : {}),
      ...(kind.includes('workspace') || kind === 'workspace' ? { workspace: String(row.workspace || '') } : {}),
      toolCalls: exactNumber(row.toolCalls ?? row.calls, `${kind}.toolCalls`),
      successes,
      failures,
      ...normalizeReliability(row, kind),
      executionMs: exactNumber(row.executionMs, `${kind}.executionMs`)
    };
  });
}

function normalizeActivityMatrix(value, { workspace = false, series = false } = {}) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const row = item && typeof item === 'object' ? item : {};
    return {
      ...(series ? { hour: String(row.hour || '') } : {}),
      ...(workspace ? { workspace: String(row.workspace || '') } : {}),
      intent: normalizeAnalyticsTaskIntent(row.intent, 'untracked'),
      useCase: normalizeAnalyticsUseCase(row.useCase),
      toolCalls: exactNumber(row.toolCalls ?? row.calls ?? 0, 'activityMatrix.toolCalls'),
      successes: exactNumber(row.successes ?? 0, 'activityMatrix.successes'),
      failures: exactNumber(row.failures ?? 0, 'activityMatrix.failures'),
      ...normalizeReliability(row, 'activityMatrix'),
      executionMs: exactNumber(row.executionMs ?? 0, 'activityMatrix.executionMs')
    };
  }).filter(row => row.toolCalls > 0 && (!series || hourTime(row.hour) !== null));
}

function normalizeTaskIntentRows(value, { workspace = false, series = false } = {}) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    ...(series ? { hour: String(item?.hour || '') } : {}),
    ...(workspace ? { workspace: String(item?.workspace || '') } : {}),
    intent: normalizeAnalyticsTaskIntent(item?.intent, 'auto'),
    tasks: exactNumber(item?.tasks ?? 0, 'taskIntents.tasks')
  })).filter(row => row.tasks > 0 && (!series || hourTime(row.hour) !== null));
}

function normalizeSeries(value, kind) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    const successes = exactNumber(item?.successes ?? 0, `${kind}.successes`);
    const failures = exactNumber(item?.failures ?? 0, `${kind}.failures`);
    return {
      hour: String(item?.hour || ''),
      ...(kind.toLowerCase().includes('tool') ? { tool: String(item?.tool || '') } : {}),
      ...(kind.includes('workspace') ? { workspace: String(item?.workspace || '') } : {}),
      requests: exactNumber(item?.requests ?? 0, `${kind}.requests`),
      toolCalls: exactNumber(item?.toolCalls ?? 0, `${kind}.toolCalls`),
      successes,
      failures,
      ...normalizeReliability(item, kind),
      executionMs: exactNumber(item?.executionMs ?? 0, `${kind}.executionMs`)
    };
  }).filter(row => hourTime(row.hour) !== null);
}

function normalizeFailureRows(value, { workspace = false, series = false } = {}) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    ...(series ? { hour: String(item?.hour || '') } : {}),
    ...(workspace ? { workspace: String(item?.workspace || '') } : {}),
    category: normalizeFailureCategory(item?.category),
    failures: exactNumber(item?.failures ?? 0, 'failureCategory.failures')
  })).filter(row => row.failures > 0 && (!series || hourTime(row.hour) !== null));
}

function sumRows(rows) {
  const totals = Object.fromEntries(TOTAL_KEYS.map(key => [key, 0]));
  for (const row of rows || []) for (const key of TOTAL_KEYS) totals[key] += Number(row[key] || 0);
  return totals;
}

function sumTransportRows(rows) {
  const totals = Object.fromEntries(TRANSPORT_KEYS.map(key => [key, 0]));
  for (const row of rows || []) for (const key of TRANSPORT_KEYS) totals[key] += Number(row[key] || 0);
  return totals;
}

function groupFailureCategories(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const category = normalizeFailureCategory(row?.category);
    grouped.set(category, (grouped.get(category) || 0) + Number(row?.failures || 0));
  }
  return [...grouped.entries()].map(([category, failures]) => ({ category, failures })).filter(row => row.failures > 0).sort((a, b) => b.failures - a.failures || a.category.localeCompare(b.category));
}

function groupRows(rows, identity, kind) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = identity(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, Object.fromEntries(GROUP_KEYS.map(field => [field, 0])));
    const target = grouped.get(key);
    for (const field of GROUP_KEYS) target[field] += Number(row[field] || 0);
  }
  return [...grouped.entries()].map(([key, totals]) => ({
    ...(kind === 'tool' ? { tool: key } : {}),
    ...(kind === 'workspace' ? { workspace: key } : {}),
    ...totals
  })).sort((a, b) => b.toolCalls - a.toolCalls);
}

function groupAnalyticsRows(rows, identity, field) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = identity(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, Object.fromEntries(GROUP_KEYS.map(name => [name, 0])));
    const target = grouped.get(key);
    for (const name of GROUP_KEYS) target[name] += Number(row[name] || 0);
  }
  return [...grouped.entries()].map(([key, totals]) => ({ [field]: key, ...totals }))
    .sort((a, b) => b.toolCalls - a.toolCalls || String(a[field]).localeCompare(String(b[field])));
}

function groupAnalyticsMatrix(rows) {
  const grouped = new Map();
  for (const row of rows || []) {
    const key = `${row.intent}\u0000${row.useCase}`;
    if (!grouped.has(key)) grouped.set(key, { intent: row.intent, useCase: row.useCase, ...Object.fromEntries(GROUP_KEYS.map(name => [name, 0])) });
    const target = grouped.get(key);
    for (const name of GROUP_KEYS) target[name] += Number(row[name] || 0);
  }
  return [...grouped.values()].filter(row => row.toolCalls > 0)
    .sort((a, b) => b.toolCalls - a.toolCalls || a.intent.localeCompare(b.intent) || a.useCase.localeCompare(b.useCase));
}

function groupTaskIntents(rows) {
  const grouped = new Map();
  for (const row of rows || []) grouped.set(row.intent, (grouped.get(row.intent) || 0) + Number(row.tasks || 0));
  return [...grouped.entries()].map(([intent, tasks]) => ({ intent, tasks }))
    .filter(row => row.tasks > 0)
    .sort((a, b) => b.tasks - a.tasks || a.intent.localeCompare(b.intent));
}

function bucketSeries(rows, start, end) {
  const duration = end.getTime() - start.getTime();
  const bucketMs = duration <= 48 * 60 * 60 * 1000 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const count = Math.max(1, Math.ceil(duration / bucketMs));
  const points = Array.from({ length: count }, (_, index) => ({ at: start.getTime() + index * bucketMs, ...Object.fromEntries(TOTAL_KEYS.map(key => [key, 0])) }));
  for (const row of rows || []) {
    const time = hourTime(row.hour);
    if (time === null || !inRange(row.hour, start, end)) continue;
    const index = Math.floor((Math.max(time, start.getTime()) - start.getTime()) / bucketMs);
    if (index < 0 || index >= points.length) continue;
    for (const key of TOTAL_KEYS) points[index][key] += Number(row[key] || 0);
  }
  return points;
}

function uniqueActiveDays(rows) {
  return new Set((rows || []).map(row => row.hour.slice(0, 10))).size;
}

function workspaceMatch(row, workspace) {
  return !workspace || row.workspace === workspace;
}

function inRange(hour, start, end) {
  const time = hourTime(hour);
  return time !== null && time >= start.getTime() && time < end.getTime();
}

function hourTime(hour) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(String(hour || ''))) return null;
  const value = Date.parse(`${hour}:00:00Z`);
  return Number.isFinite(value) ? value : null;
}

function ceilUtcHour(value) {
  const time = value.getTime();
  const remainder = time % HOUR_MS;
  return new Date(remainder ? time + HOUR_MS - remainder : time);
}

function parseDateStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function rangeLabel(range, start, end) {
  const known = ANALYTICS_RANGES.find(([key]) => key === range)?.[1];
  if (range !== 'custom') return known || 'Last 24 hours';
  const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `${format.format(start)} – ${format.format(new Date(end.getTime() - 1))}`;
}

function monthKey(value) {
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeMonth(value) {
  const text = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : '';
}

function normalizeReliability(row, label) {
  return {
    reliabilityCalls: optionalNumber(row?.reliabilityCalls, 0, `${label}.reliabilityCalls`),
    reliableCalls: optionalNumber(row?.reliableCalls, 0, `${label}.reliableCalls`),
    infrastructureFailures: optionalNumber(row?.infrastructureFailures, 0, `${label}.infrastructureFailures`),
    operationFailures: optionalNumber(row?.operationFailures, 0, `${label}.operationFailures`),
    recoverableFailures: optionalNumber(row?.recoverableFailures, 0, `${label}.recoverableFailures`),
    cancellations: optionalNumber(row?.cancellations, 0, `${label}.cancellations`)
  };
}

function optionalNumber(value, fallback, field) {
  return value == null ? fallback : exactNumber(value, field);
}

function exactNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Analytics are unavailable because ${field} has an invalid value.`);
  return number;
}
