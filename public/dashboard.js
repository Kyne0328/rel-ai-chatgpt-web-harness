import { fetchJson, invalidateCache, DASHBOARD_DATA_URL } from './ui/api.js';
import { applyLiveEvent, clearShellDashboardState, clearShellRecoveryNotice, getSnapshot as getStore, init as initStore, initConnectorRefreshModal, initUpdateAvailableModal, mountReactFoundation, patchLocalConnection, preloadReactRoute, preloadReactRoutes, setShellConnectionOverride, setShellLastEventAt, showShellDashboardState, showShellRecoveryNotice, subscribe as subscribeStore } from './dashboard-react.js';
import { initRouter } from './ui/router.js';
import { initEvents, startSSE } from './ui/events.js';
import { initUiPreferences } from './ui/preferences.js';
import { withConnectionState } from './ui/connection-state.js';
import { normalizeRouteKey } from './ui/route-policy.js';
import { closeDrawer } from './ui/components/drawer.js';
import { createDashboardClock } from './ui/clock.js';
import { syncDesktopSetupState } from './ui/features/onboarding/index.js';

initUiPreferences();

const launchParams = new URLSearchParams(location.search);
const surface = launchParams.get('surface') === 'desktop' ? 'desktop' : 'browser';
const requestedChrome = surface === 'desktop' && launchParams.get('chrome') === 'custom' ? 'custom' : 'native';
const requestedPlatform = ['win32', 'darwin', 'linux', 'other'].includes(launchParams.get('platform')) ? launchParams.get('platform') : 'other';
document.documentElement.dataset.surface = surface;
document.documentElement.dataset.windowChrome = requestedChrome;
document.documentElement.dataset.platform = requestedPlatform;
cleanLaunchQuery();

let _routerReady = false;
let _lastEventAt = null;
let _dashboardClock = null;
let _liveState = 'connecting';
let _refreshPromise = null;
let _refreshLiveEvents = null;
let _refreshLiveEventOverflow = false;
let _hiddenViewDirty = false;
let _hiddenCatchUpRequired = false;
let _hiddenRecoveryRequired = false;
const AUTO_RECOVERY_DELAYS_MS = [0, 600, 1600];
const MAX_REFRESH_LIVE_EVENTS = 500;

function cleanLaunchQuery() {
  const clean = new URLSearchParams(location.search);
  clean.delete('token');
  clean.delete('bootstrap');
  const query = clean.toString();
  let cleanUrl = location.pathname;
  if (query) cleanUrl += `?${query}`;
  const rawHash = (location.hash || '').slice(1);
  if (rawHash) cleanUrl += `#${normalizeRouteKey(rawHash)}`;
  history.replaceState(null, '', cleanUrl);
}

function readInitialPayload() {
  try {
    const element = document.getElementById('initialDashboardData');
    return element?.textContent ? JSON.parse(element.textContent) : null;
  } catch {
    return null;
  }
}

function ensureDashboardRoot() {
  let root = document.getElementById('dashboardRoot');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'dashboardRoot';
  document.body.appendChild(root);
  return root;
}

async function boot() {
  _dashboardClock = createDashboardClock({
    onTick: currentTime => {
      window.dispatchEvent(new CustomEvent('relai:clock-tick', { detail: { now: currentTime } }));
    }
  }).start();
  window.addEventListener('pagehide', () => _dashboardClock?.stop(), { once: true });
  const initialPayload = readInitialPayload();
  const initial = initialPayload == null
    ? null
    : initialPayload.ok !== false
      ? withConnectionState(initialPayload, _liveState)
      : initialPayload;
  if (initial?.onboarding) syncDesktopSetupState(initial.onboarding);
  initStore(initial?.ok !== false ? initial || {} : {});
  if (!initial) showShellDashboardState({ kind: 'loading' });
  mountReactFoundation(ensureDashboardRoot(), { getSnapshot: getStore, subscribe: subscribeStore }, {
    desktop: window.relaiDesktop || null,
    onAddWorkspace: async () => {
      location.hash = '#workspaces?create=1';
    }
  });
  if (surface === 'desktop') {
    initConnectorRefreshModal();
    initUpdateAvailableModal();
  }
  initDesktopBridge();
  window.addEventListener('relai:route-change', closeDrawer);
  if (initial && initial.ok !== false) {
    activateRouter();
    updateShell(initial);
  }
  if (initial?.ok === false || !initial) {
    const refreshed = await recoverDashboard({ source: 'boot' });
    if (refreshed?.ok !== false && !_routerReady) activateRouter();
  }
  window.addEventListener('relai:dashboard-refresh', () => doRefresh({ source: 'local-change' }));
  window.addEventListener('relai:desktop-status-refresh', event => applyDesktopStatus(event.detail));
  document.addEventListener('visibilitychange', () => { void handleDashboardVisibility(); });
  initEvents(liveOnEvent, liveStateChange);
  startSSE();
}

function activateRouter() {
  if (_routerReady) return;
  _routerReady = true;
  initRouter();
  const initialSection = currentRouteSection();
  void preloadReactRoutes(initialSection);
  window.addEventListener('relai:route-change', event => {
    const section = String(event?.detail?.section || '').trim();
    if (section) void preloadReactRoute(section);
  });
}

function currentRouteSection() {
  try {
    const raw = String(location.hash || '').slice(1);
    const key = normalizeRouteKey(raw || 'home');
    return key.split('?')[0].split('/')[0] || 'home';
  } catch { return 'home'; }
}

function initDesktopBridge() {
  const desktop = window.relaiDesktop;
  if (!desktop) {
    document.documentElement.dataset.windowChrome = 'native';
    return;
  }
  desktop.onStatus(applyDesktopStatus);
  desktop.getStatus().then(applyDesktopStatus).catch(debugError);
}

function applyDesktopStatus(status) {
  if (!status) return;
  const projected = withConnectionState({ ...getStore(), desktopStatus: status }, _liveState);
  patchLocalConnection({ desktopStatus: status, connectionState: projected.connectionState });
  if (dashboardHidden()) {
    _hiddenViewDirty = true;
    return;
  }
  updateShell(getStore());
}

async function doRefresh(options = {}) {
  if (_refreshPromise) return _refreshPromise;
  _refreshLiveEvents = [];
  _refreshLiveEventOverflow = false;
  _refreshPromise = performRefresh(options);
  try {
    return await _refreshPromise;
  } finally {
    const needsCatchUp = _refreshLiveEventOverflow;
    _refreshPromise = null;
    _refreshLiveEvents = null;
    _refreshLiveEventOverflow = false;
    if (needsCatchUp) queueMicrotask(() => { void doRefresh({ source: 'live-refresh-overflow', quietFailure: true }); });
  }
}

async function performRefresh(options = {}) {
  invalidateCache(DASHBOARD_DATA_URL);
  try {
    const data = await fetchJson(DASHBOARD_DATA_URL, { cache: 'no-store' });
    if (data && data.ok !== false) {
      const hydrated = withConnectionState(data, _liveState);
      if (hydrated.onboarding) syncDesktopSetupState(hydrated.onboarding);
      initStore(hydrated);
      replayLiveEventsDuringRefresh();
      const projected = withConnectionState(getStore(), _liveState);
      patchLocalConnection({ connectionState: projected.connectionState });
      const refreshed = getStore();
      updateShell(refreshed);
      if (!_routerReady) activateRouter();
      clearShellDashboardState();
      _lastEventAt = Date.now();
      setShellLastEventAt(_lastEventAt);
      clearRecoveryNotice({ announce: options.announceRecovery === true });
      return refreshed;
    }
    return options.quietFailure === true ? data : renderRefreshFailure(data);
  } catch (error) {
    const failure = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
    return options.quietFailure === true ? failure : renderRefreshFailure(failure);
  }
}

async function recoverDashboard(options = {}) {
  let latest = { ok: false, error: 'The dashboard could not connect to Rel.AI.' };
  for (let attempt = 0; attempt < AUTO_RECOVERY_DELAYS_MS.length; attempt += 1) {
    const delay = AUTO_RECOVERY_DELAYS_MS[attempt];
    if (delay) await wait(delay);
    latest = await doRefresh({
      ...options,
      source: options.source || 'automatic-recovery',
      quietFailure: true,
      announceRecovery: true
    });
    if (latest?.ok !== false) return latest;
    if (latest?.status === 401) break;
  }
  return renderRefreshFailure(latest);
}

function renderRefreshFailure(data = {}) {
  const message = data?.error || 'The dashboard could not connect to Rel.AI.';
  const liveRefreshTimeout = _routerReady && _liveState === 'live' && data?.status !== 401 && /request timed out/i.test(message);
  if (liveRefreshTimeout) return data;
  setShellConnectionOverride({ label: data?.status === 401 ? 'Authentication failed' : 'Disconnected', tone: 'bad' });
  const title = data?.status === 401 ? 'Dashboard authentication failed.' : 'Rel.AI is not responding.';
  if (!_routerReady) showDashboardFailure(title, message, data);
  else showRecoveryNotice(title, message, data);
  return data;
}

function showDashboardFailure(title, description, data = {}) {
  const recovery = recoveryAction(data);
  const canRelaunch = typeof window.relaiDesktop?.relaunchApp === 'function';
  showShellDashboardState({
    kind: 'error',
    title,
    description,
    primaryLabel: recovery.label,
    primaryBusyLabel: recovery.busyLabel,
    onPrimary: () => runDashboardRecovery(recovery, data),
    secondaryLabel: canRelaunch ? 'Restart Rel.AI' : '',
    secondaryBusyLabel: 'Restarting Rel.AI…',
    onSecondary: canRelaunch ? runAppRelaunch : null,
    diagnosticsHref: '#diagnostics'
  });
}

function showRecoveryNotice(title, description, data = {}) {
  const recovery = recoveryAction(data);
  const canRelaunch = typeof window.relaiDesktop?.relaunchApp === 'function';
  showShellRecoveryNotice({
    kind: 'error',
    title,
    description,
    primaryLabel: recovery.label,
    primaryBusyLabel: recovery.busyLabel,
    onPrimary: () => runDashboardRecovery(recovery, data),
    secondaryLabel: canRelaunch ? 'Restart Rel.AI' : '',
    secondaryBusyLabel: 'Restarting Rel.AI…',
    onSecondary: canRelaunch ? () => runAppRelaunch() : null,
    diagnosticsHref: '#diagnostics'
  });
}

function clearRecoveryNotice(options = {}) {
  if (options.announce === true) {
    showShellRecoveryNotice({
      kind: 'restored',
      title: 'Connection restored.',
      description: 'Rel.AI is responding again.'
    });
    return;
  }
  clearShellRecoveryNotice();
}

function recoveryAction(data = {}) {
  if (data?.status === 401 && typeof window.relaiDesktop?.reloadDashboard === 'function') {
    return { kind: 'reload', label: 'Reload dashboard', busyLabel: 'Reloading dashboard…' };
  }
  if (typeof window.relaiDesktop?.restartConnection === 'function') {
    return { kind: 'restart', label: 'Retry connection', busyLabel: 'Retrying connection…' };
  }
  return { kind: 'retry', label: 'Retry connection', busyLabel: 'Retrying connection…' };
}

async function runDashboardRecovery(recovery, data) {
  try {
    if (recovery.kind === 'reload') {
      await window.relaiDesktop.reloadDashboard(location.hash || '#home');
      return;
    }
    if (recovery.kind === 'restart') {
      const status = await window.relaiDesktop.restartConnection();
      if (status) applyDesktopStatus(status);
    }
    await recoverDashboard({ source: 'manual-recovery' });
  } catch (error) {
    renderRefreshFailure({ ...data, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function runAppRelaunch() {
  try {
    await window.relaiDesktop.relaunchApp();
  } catch (error) {
    renderRefreshFailure({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function wait(milliseconds) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

function bufferLiveEventDuringRefresh(event) {
  if (!_refreshLiveEvents) return false;
  if (_refreshLiveEvents.length >= MAX_REFRESH_LIVE_EVENTS) {
    _refreshLiveEvents.shift();
    _refreshLiveEventOverflow = true;
  }
  _refreshLiveEvents.push(event);
  return true;
}

function replayLiveEventsDuringRefresh() {
  for (const event of _refreshLiveEvents || []) {
    if (!event?.type || !event.data || event.data.ok === false) continue;
    applyLiveEvent(event.type, event.data);
  }
}

function dashboardHidden() {
  return document.visibilityState !== 'visible';
}

async function handleDashboardVisibility() {
  if (dashboardHidden()) return;
  const recoveryRequired = _hiddenRecoveryRequired;
  const catchUpRequired = _hiddenCatchUpRequired;
  const viewDirty = _hiddenViewDirty;
  _hiddenRecoveryRequired = false;
  _hiddenCatchUpRequired = false;
  _hiddenViewDirty = false;

  if (recoveryRequired) {
    await recoverDashboard({ source: 'visibility-live-recovery' });
    return;
  }
  if (catchUpRequired) {
    await doRefresh({ source: 'visibility-catch-up' });
    return;
  }
  if (viewDirty) updateShell(getStore());
  if (!_routerReady) activateRouter();
}

async function liveOnEvent(event) {
  if (!event?.type || !event.data) return;
  if (event.type === 'dashboard.error') {
    debugError(new Error(event.data.error || 'A live dashboard update failed.'));
    if (dashboardHidden()) {
      _hiddenRecoveryRequired = true;
      _hiddenViewDirty = true;
      return;
    }
    await recoverDashboard({ source: 'live-event-recovery' });
    return;
  }
  if (event.data.ok === false) return;
  bufferLiveEventDuringRefresh(event);
  const applied = applyLiveEvent(event.type, event.data);
  if (!applied.accepted) return;
  if (event.type !== 'diagnostics.updated') {
    const projected = withConnectionState(applied.state, _liveState);
    patchLocalConnection({ connectionState: projected.connectionState });
  }
  if (dashboardHidden()) {
    _hiddenViewDirty = true;
    return;
  }
  window.dispatchEvent(new CustomEvent('relai:diagnostics-live', { detail: event }));
  if (event.type === 'diagnostics.updated') return;
  updateShell(getStore());
  if (!_routerReady) activateRouter();
}

function liveStateChange(detail) {
  const catchUpRequired = detail.state === 'live' && liveCatchUpRequired(getStore().live, detail);
  const reconnectProbeRequired = surface === 'desktop'
    && detail.state === 'reconnecting'
    && detail.recoveryProbe === true
    && _liveState !== 'reconnecting';
  _liveState = detail.state || 'connecting';
  if (detail.lastEventAt) {
    _lastEventAt = detail.lastEventAt;
    setShellLastEventAt(_lastEventAt);
  }
  const projected = withConnectionState(getStore(), _liveState);
  patchLocalConnection({ connectionState: projected.connectionState });
  if (dashboardHidden()) {
    _hiddenViewDirty = true;
    if (reconnectProbeRequired || catchUpRequired) _hiddenCatchUpRequired = true;
    return;
  }
  if (reconnectProbeRequired) void doRefresh({ source: 'sse-reconnect-probe', quietFailure: true });
  if (catchUpRequired) void doRefresh({ source: 'sse-catch-up' });
}

function liveCatchUpRequired(localLive = {}, remote = {}) {
  const localStreamId = String(localLive?.streamId || '');
  const remoteStreamId = String(remote?.streamId || '');
  if (remoteStreamId && localStreamId !== remoteStreamId) return true;
  const localRevisions = localLive?.revisions || {};
  const remoteRevisions = remote?.revisions || {};
  return Object.entries(remoteRevisions).some(([domain, revision]) => (
    Number(revision || 0) > Number(localRevisions[domain] || 0)
  ));
}

function updateShell(data) {
  setShellConnectionOverride(null);
  _lastEventAt ||= Date.parse(data?.generatedAt || '') || Date.now();
  setShellLastEventAt(_lastEventAt);
}

function debugError(error) {
  if (window.localStorage?.getItem('relai_debug') === '1') console.error(error);
}


boot();
