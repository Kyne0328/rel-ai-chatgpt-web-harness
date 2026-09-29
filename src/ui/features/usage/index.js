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
