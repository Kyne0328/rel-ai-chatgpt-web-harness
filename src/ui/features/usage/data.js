import { analyticsBounds, analyticsMonths, analyticsRangeScope, normalizeUsageSnapshot } from './range-model.js';

const inFlightUsageRequests = new WeakMap();

function loadUsageMonth(desktop, month) {
  let requests = inFlightUsageRequests.get(desktop);
  if (!requests) {
    requests = new Map();
    inFlightUsageRequests.set(desktop, requests);
  }
  let request = requests.get(month);
  if (request) return request;
  request = Promise.resolve(desktop.getLocalUsage(month))
    .then(snapshot => normalizeUsageSnapshot(snapshot, month))
    .finally(() => {
      if (requests.get(month) === request) requests.delete(month);
    });
  requests.set(month, request);
  return request;
}

export async function loadAnalyticsModels({
  desktop,
  bounds = null,
  range = '24h',
  now = new Date(),
  customStart = '',
  customEnd = ''
} = {}) {
  if (!desktop?.getLocalUsage) throw new Error('Local analytics are available in the installed Rel.AI desktop app.');
  const resolvedBounds = bounds || analyticsBounds(range, { now, customStart, customEnd });
  const models = await Promise.all(analyticsMonths(resolvedBounds).map(month => loadUsageMonth(desktop, month)));
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
