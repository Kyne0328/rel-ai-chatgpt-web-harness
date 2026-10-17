import { analyticsBounds, analyticsMonths, analyticsRangeScope, normalizeUsageSnapshot } from './range-model.js';

const usageRequestsByDesktop = new WeakMap();
const USAGE_CACHE_TTL_MS = 15_000;
const MAX_CACHED_MONTHS = 8;

function loadUsageMonth(desktop, month, fresh = false) {
  let months = usageRequestsByDesktop.get(desktop);
  if (!months) {
    months = new Map();
    usageRequestsByDesktop.set(desktop, months);
  }
  const cached = months.get(month);
  if (cached?.request) return cached.request;
  if (!fresh && cached?.value && Date.now() - cached.savedAt < USAGE_CACHE_TTL_MS) return Promise.resolve(cached.value);

  const entry = { request: null, value: cached?.value || null, savedAt: cached?.savedAt || 0 };
  const request = Promise.resolve().then(() => desktop.getLocalUsage(month))
    .then(snapshot => {
      const value = normalizeUsageSnapshot(snapshot, month);
      entry.value = value;
      entry.savedAt = Date.now();
      return value;
    })
    .finally(() => {
      entry.request = null;
      if (!entry.value && months.get(month) === entry) months.delete(month);
    });
  entry.request = request;
  months.delete(month);
  months.set(month, entry);
  while (months.size > MAX_CACHED_MONTHS) months.delete(months.keys().next().value);
  return request;
}

export async function loadAnalyticsModels({
  desktop,
  bounds = null,
  range = '24h',
  now = new Date(),
  customStart = '',
  customEnd = '',
  fresh = false
} = {}) {
  if (!desktop?.getLocalUsage) throw new Error('Local analytics are available in the installed Rel.AI desktop app.');
  const resolvedBounds = bounds || analyticsBounds(range, { now, customStart, customEnd });
  const models = await Promise.all(analyticsMonths(resolvedBounds).map(month => loadUsageMonth(desktop, month, fresh)));
  return { bounds: resolvedBounds, models };
}

export async function loadAnalyticsData(options = {}) {
  const workspace = String(options.workspace || '');
  const { bounds, models } = await loadAnalyticsModels(options);
  const current = analyticsRangeScope(models, bounds, { workspace, monthlyFallback: true });
  const previous = analyticsRangeScope(models, {
    range: 'comparison',
    start: bounds.previousStart,
    end: bounds.previousEnd
  }, { workspace });
  const allCurrent = analyticsRangeScope(models, bounds, { monthlyFallback: true });
  const privacy = models.find(model => model?.privacy)?.privacy || null;
  return { bounds, models, current, previous, allCurrent, privacy };
}
