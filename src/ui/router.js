// @ts-check
// Hash-based dashboard navigation with workspace scope.
import { clearUnsavedChanges, hasUnsavedChanges, initInteractionSafety } from './interaction-safety.js';
import { confirmAction } from './components/confirm-dialog.js';
import { normalizeRouteKey } from './route-policy.js';

/** @type {string | null} */
let _currentRouteKey = null;
let _bound = false;
let _guardPending = false;
let _queuedRouteKey = null;
/** @type {{ key: string, path: string, search: string } | null} */
let _routeSnapshot = null;
/** @type {Set<() => void>} */
const _routeListeners = new Set();

export function initRouter() {
  initInteractionSafety();
  if (!_bound) {
    window.addEventListener('hashchange', _route);
    window.addEventListener('popstate', _route);
    _bound = true;
  }
  void _route();
}

/** @param {() => void} listener */
export function subscribeRoute(listener) {
  _routeListeners.add(listener);
  return () => _routeListeners.delete(listener);
}

export function getRouteSnapshot() {
  return _routeSnapshot || commitRoute(normalizeRouteKey(rawRouteKey()), false);
}

export function currentRoutePath() {
  return routeParts().path;
}

export function getRouteParams() {
  return routeParts().params;
}

export function getWorkspaceFilter() {
  return getRouteParams().get('workspace') || '';
}

/** @param {string} sectionId @param {Record<string, unknown>} [params] */
export function routeHref(sectionId, params = {}) {
  const query = new URLSearchParams();
  const workspace = Object.hasOwn(params, 'workspace') ? params.workspace : getWorkspaceFilter();
  if (workspace) query.set('workspace', String(workspace));
  for (const [key, value] of Object.entries(params)) {
    if (key === 'workspace' || value == null || value === '') continue;
    query.set(key, String(value));
  }
  return `#${normalizeRouteKey(`${sectionId}${querySuffix(query)}`)}`;
}

/** @param {string} workspace */
export function setWorkspaceFilter(workspace) {
  if (_guardPending) return;
  const parts = routeParts();
  if (workspace) parts.params.set('workspace', workspace);
  else parts.params.delete('workspace');
  parts.params.delete('focus');
  location.hash = `#${normalizeRouteKey(`${parts.path}${querySuffix(parts.params)}`)}`;
}

/** @param {Record<string, unknown>} [patch] */
export function replaceRouteParams(patch = {}) {
  if (_guardPending) return getRouteParams();
  const parts = routeParts();
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') parts.params.delete(key);
    else parts.params.set(key, String(value));
  }
  const routeKey = normalizeRouteKey(`${parts.path}${querySuffix(parts.params)}`);
  replaceRouteState(routeKey);
  commitRoute(routeKey);
  return routeParts().params;
}

/** @param {string} sectionId @param {Record<string, unknown>} [params] */
export function navigate(sectionId, params = {}) {
  location.hash = routeHref(sectionId, params);
}

/** @param {URLSearchParams} params */
function querySuffix(params) {
  const value = params.toString();
  return value ? `?${value}` : '';
}

function routeParts() {
  const raw = getRouteSnapshot().key;
  const separator = raw.indexOf('?');
  const path = separator >= 0 ? raw.slice(0, separator) : raw;
  const query = separator >= 0 ? raw.slice(separator + 1) : '';
  return { path: path || 'home', params: new URLSearchParams(query) };
}

function rawRouteKey() {
  return (location.hash || '#home').slice(1) || 'home';
}

/** @param {string} routeKey */
function replaceRouteState(routeKey) {
  history.replaceState(null, '', `${location.pathname}${location.search}#${routeKey}`);
}

async function _route() {
  const rawKey = rawRouteKey();
  const routeKey = normalizeRouteKey(rawKey);
  if (routeKey !== rawKey) replaceRouteState(routeKey);
  if (routeKey === _currentRouteKey) return;
  if (_guardPending) {
    _queuedRouteKey = routeKey;
    replaceRouteState(_currentRouteKey || routeKey);
    return;
  }
  if (_currentRouteKey && hasUnsavedChanges()) {
    _guardPending = true;
    _queuedRouteKey = routeKey;
    const previousRouteKey = _currentRouteKey;
    replaceRouteState(previousRouteKey);
    let confirmed;
    try {
      confirmed = await confirmAction({
        title: 'Discard changes?',
        message: 'Discard unsaved changes and leave this page?',
        detail: 'Your changes will not be saved.',
        confirmLabel: 'Discard changes',
        danger: true
      });
    } finally {
      _guardPending = false;
    }
    const approvedRouteKey = _queuedRouteKey;
    _queuedRouteKey = null;
    if (!confirmed) {
      replaceRouteState(previousRouteKey);
      return;
    }
    clearUnsavedChanges();
    const approved = approvedRouteKey || routeKey;
    replaceRouteState(approved);
    commitRoute(approved);
    return;
  }

  commitRoute(routeKey);
}

/** @param {string} routeKey @param {boolean} [dispatch] */
function commitRoute(routeKey, dispatch = true) {
  _currentRouteKey = routeKey;
  const separator = routeKey.indexOf('?');
  const path = (separator >= 0 ? routeKey.slice(0, separator) : routeKey) || 'home';
  const search = separator >= 0 ? routeKey.slice(separator) : '';
  _routeSnapshot = Object.freeze({ key: routeKey, path, search });
  _routeListeners.forEach(listener => listener());
  if (dispatch && typeof window !== 'undefined') {
    const id = path.split('/')[0] || 'home';
    window.dispatchEvent(new CustomEvent('relai:route-change', {
      detail: { section: id, path, params: new URLSearchParams(search.slice(1)) }
    }));
  }
  return _routeSnapshot;
}
