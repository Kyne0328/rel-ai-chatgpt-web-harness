import { normalizeUsageSnapshot } from './range-model.js';

export function buildUsageModel(snapshot, requestedMonth = '') {
  return normalizeUsageSnapshot(snapshot, requestedMonth);
}

export function currentUsageMonth(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function rangeButtonLabel(key, label) {
  return ({ '1h': '1h', '24h': '24h', '7d': '7d', '30d': '30d', month: 'Month', custom: 'Custom' })[key] || label;
}

export function customDateDefaults(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10)
  };
}

export function analyticsPrivacyCopy(privacy = {}) {
  const retentionDays = Math.max(0, Number(privacy?.retentionDays || 0));
  const telemetry = privacy?.externalTelemetry || {};
  const retention = retentionDays
    ? `Aggregate local analytics are retained for about ${Math.floor(retentionDays)} days.`
    : 'Aggregate local analytics are retained locally.';
  const telemetryCopy = telemetry.enabled === true
    ? `External developer telemetry is on at a ${Math.round(Number(telemetry.sampleRatio || 0) * 100)}% sample rate. Developer telemetry can include tool names, project names, task IDs, client/runtime information, timings, and command summaries. It does not include prompts, file contents, command output, or raw error messages.`
    : telemetry.endpointConfigured === true
      ? 'External developer telemetry is off. An OTLP endpoint is configured, but Rel.AI does not export traces while telemetry is off.'
      : 'External developer telemetry is off. No OTLP trace endpoint is active.';
  return {
    retention: `${retention} Rel.AI stores aggregate action categories and work-type labels locally. Local analytics do not store prompts, task objectives, file paths, command output, action results, or raw errors.`,
    telemetry: telemetryCopy
  };
}
