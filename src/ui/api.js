// Consolidated fetch layer — replaces divergent fetchJson helpers across client files.
// Dashboard requests authenticate only with the HttpOnly session cookie established
// by the one-time /dashboard bootstrap. The MCP bearer token never enters renderer JS.

// Single source of truth for the aggregate dashboard payload URL. Used by the
// bootstrap, manual/live refresh, workspace mutations, and settings cache
// invalidation — keep them in sync via this constant, not copied literals.
export const DASHBOARD_DATA_URL = '/api/dashboard/v10?limit=100';
const CACHE_RETENTION_MS = 60_000;
const responseCache = new Map();
let _cacheGeneration = 0;
let _dashboardReloadPromise = null;


export function requestDashboardRefresh() {
  invalidateCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
}

function cacheKeyFor(url, fetchOpts) {
  const isGet = !fetchOpts.method || fetchOpts.method === 'GET';
  const bypassCache = fetchOpts.cache === 'no-store' || fetchOpts.cache === 'reload';
  return isGet && !bypassCache ? url : null;
}

function cachedValue(cacheKey, maxAgeMs = 1000) {
  if (!cacheKey || !(maxAgeMs > 0)) return null;
  const entry = responseCache.get(cacheKey);
  if (!entry || Date.now() - entry.updatedAt >= maxAgeMs) return null;
  return entry.data;
}

function cacheResponse(cacheKey, data) {
  let entry = responseCache.get(cacheKey);
  if (!entry) {
    // Retention starts on insertion; refreshing data does not extend it.
    const timer = setTimeout(() => responseCache.delete(cacheKey), CACHE_RETENTION_MS);
    timer.unref?.();
    entry = { data, updatedAt: 0, timer };
    responseCache.set(cacheKey, entry);
  }
  entry.data = data;
  entry.updatedAt = Date.now();
}

function timeoutFor(timeout) {
  return Number.isFinite(timeout) ? timeout : 8000;
}

function startVisibleRequestTimeout(controller, timeoutMs, pauseTimeoutWhenHidden = true) {
  if (!(timeoutMs > 0)) return () => {};
  const documentRef = globalThis.document;
  if (pauseTimeoutWhenHidden === false || !documentRef?.addEventListener || !documentRef?.removeEventListener) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return () => clearTimeout(timer);
  }

  let remainingMs = timeoutMs;
  let timer = null;
  let startedAt = 0;

  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remainingMs = Math.max(1, remainingMs - (Date.now() - startedAt));
  };
  const resume = () => {
    if (timer || remainingMs <= 0 || documentRef.visibilityState === 'hidden') return;
    startedAt = Date.now();
    timer = setTimeout(() => {
      timer = null;
      remainingMs = 0;
      controller.abort();
    }, remainingMs);
  };
  const onVisibilityChange = () => {
    if (documentRef.visibilityState === 'hidden') pause();
    else resume();
  };

  documentRef.addEventListener('visibilitychange', onVisibilityChange);
  resume();
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    documentRef.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

function requestHeaders(fetchOpts) {
  const headers = { 'Content-Type': 'application/json' };
  if (fetchOpts.headers) Object.assign(headers, fetchOpts.headers);
  return headers;
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    if (window.localStorage?.getItem('relai_debug') === '1') console.error(error);
    return structuredRequestError(text || `Dashboard returned HTTP ${res.status}.`, res.status);
  }
}

function normalizeResponseData(res, data) {
  data.httpStatus = res.status;
  if (!Object.hasOwn(data, 'status')) data.status = res.status;
  if (!res.ok && data.ok !== true) data.ok = false;
  if (res.status === 401) {
    data.error = data.error || 'Dashboard authorization expired. Reopening the dashboard…';
    recoverDashboardAuthorization();
  }
  return data;
}

function recoverDashboardAuthorization() {
  const desktop = globalThis.window?.relaiDesktop;
  if (typeof desktop?.reloadDashboard !== 'function' || _dashboardReloadPromise) return;
  _dashboardReloadPromise = Promise.resolve(desktop.reloadDashboard(globalThis.location?.hash || '#home'))
    .catch(error => {
      if (globalThis.window?.localStorage?.getItem('relai_debug') === '1') console.error(error);
    })
    .finally(() => { _dashboardReloadPromise = null; });
}

function structuredRequestError(message, status = 0) {
  return {
    ok: false,
    status,
    errorCode: 'dashboard_unavailable',
    title: 'Dashboard request failed',
    error: String(message || 'The Rel.AI dashboard did not respond.'),
    recovery: { message: 'Refresh the dashboard. Restart the connection service if the problem continues.', actionLabel: 'Open Connection', href: '#settings/connection', retryable: true }
  };
}

function requestError(err, timeoutMs) {
  const isAbort = err?.name === 'AbortError';
  return structuredRequestError(isAbort ? `Request timed out after ${Math.round(timeoutMs / 1000)} seconds.` : String(err));
}

export async function fetchJson(url, opts = {}) {
  // timeout (ms): overrides the 8s default; 0 or negative disables the abort timer
  // entirely. The native folder picker blocks on user input and must not be killed
  // mid-prompt, so it passes timeout: 0. Most requests pause timeout accounting while
  // hidden; callers that must not remain pending in the background can opt out.
  const { timeout, pauseTimeoutWhenHidden = true, cacheTtlMs = 1000, ...fetchOpts } = opts;
  const cacheKey = cacheKeyFor(url, fetchOpts);
  const cached = cachedValue(cacheKey, cacheTtlMs);
  if (cached) return cached;
  const cacheGeneration = _cacheGeneration;

  const timeoutMs = timeoutFor(timeout);
  const ctrl = new AbortController();
  const clearRequestTimeout = startVisibleRequestTimeout(ctrl, timeoutMs, pauseTimeoutWhenHidden);

  try {
    const res = await fetch(url, {
      ...fetchOpts,
      credentials: 'same-origin',
      signal: ctrl.signal,
      headers: requestHeaders(fetchOpts)
    });
    const data = normalizeResponseData(res, await parseJsonResponse(res));
    if (cacheKey && res.ok && data?.ok !== false && cacheGeneration === _cacheGeneration) {
      cacheResponse(cacheKey, data);
    }
    return data;
  } catch (err) {
    return requestError(err, timeoutMs);
  } finally {
    clearRequestTimeout();
  }
}

export async function postJson(url, body, opts = {}) {
  return fetchJson(url, { method: 'POST', body: JSON.stringify(body), ...opts });
}

export function invalidateCache(url) {
  _cacheGeneration += 1;
  const keys = url ? [url] : responseCache.keys();
  for (const key of keys) {
    const entry = responseCache.get(key);
    if (entry) clearTimeout(entry.timer);
    responseCache.delete(key);
  }
}
