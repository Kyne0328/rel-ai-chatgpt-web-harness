import { closeHttpServer } from './shutdown-coordinator.js';
import { importResourceModule } from './resource-path.js';
import { applyRuntimeLogChange } from './runtime-log-snapshot.js';
import { projectServiceActivityEvent, projectServiceActivitySnapshot } from './service-activity-projection.js';

const parentPort = process.parentPort;
if (!parentPort) throw new Error('Rel.AI service process requires an Electron utility-process parent port.');

const LISTEN_TIMEOUT_MS = 10_000;
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 5_000;

let httpModulePromise = null;
let toolActivityPromise = null;
let dashboardSessionsPromise = null;
let coreDesktopOperationsPromise = null;
let desktopManagerPromise = null;
let browserDriverPromise = null;
let loadedToolActivity = null;
let unsubscribeActivity = null;

let httpServer = null;
let activeToken = '';
let activePort = 0;
let lifecycleQueue = Promise.resolve();
let desktopContext = {
  status: null,
  runtimeAccess: { blocked: false, errorCode: '', message: '' },
  runtimeLogs: { available: true, revision: 0, count: 0, entries: [] },
  reducedBackgroundWork: false
};
let nativeRequestSequence = 0;
const pendingNativeRequests = new Map();
const runtimeLogListeners = new Set();
const desktopStatusListeners = new Set();

parentPort.on('message', event => {
  const message = event?.data || {};
  if (message.type === 'request') {
    void handleRequest(message);
    return;
  }
  if (message.type === 'context') {
    updateDesktopContext(message.context);
    return;
  }
  if (message.type === 'native-event') {
    void loadBrowserDriver()
      .then(browserDriver => browserDriver.dispatchBrowserNativeEvent(message.event || {}))
      .catch(error => post({ type: 'log', level: 'warning', message: `Browser event bridge failed: ${errorMessage(error)}` }));
    return;
  }
  if (message.type === 'native-response') settleNativeRequest(message);
});

async function handleRequest(message) {
  const id = String(message.id || '');
  try {
    const result = await dispatchRequest(String(message.method || ''), message.payload || {});
    post({ type: 'response', id, ok: true, result });
  } catch (error) {
    post({
      type: 'response',
      id,
      ok: false,
      error: {
        message: errorMessage(error),
        code: String(error?.code || '')
      }
    });
  }
}

async function dispatchRequest(method, payload) {
  if (method === 'start') return runLifecycle(() => startService(payload));
  if (method === 'stop') return runLifecycle(stopService);
  if (method === 'dashboard-bootstrap') return createDashboardBootstrap();
  if (method === 'activity-snapshot') return projectServiceActivitySnapshot((await loadToolActivity()).getToolActivity());
  if (method === 'desktop-local-usage') return (await loadCoreDesktopOperations()).getDesktopLocalUsage(payload.month);
  if (method === 'desktop-onboarding-handoff') return (await loadCoreDesktopOperations()).markDesktopOnboardingHandoff();
  if (method === 'desktop-task-code-workspace') return (await loadCoreDesktopOperations()).getDesktopTaskCodeWorkspace(payload);
  if (method === 'desktop-task-code-diff') return (await loadCoreDesktopOperations()).readDesktopTaskCodeDiff(payload);
  if (method === 'desktop-task-code-workspace-path') return (await loadCoreDesktopOperations()).getDesktopTaskCodeWorkspacePath(payload);
  throw new Error(`Unknown service-process request: ${method}`);
}

function runLifecycle(action) {
  const next = lifecycleQueue.then(action, action);
  lifecycleQueue = next.catch(() => {});
  return next;
}

async function startService(payload = {}) {
  if (httpServer?.listening) {
    publishActivitySnapshot();
    return { ok: true, port: activePort };
  }
  const host = String(payload.host || '127.0.0.1');
  const port = Number(payload.port || 3333);
  const token = String(payload.token || '');
  let server = null;
  try {
    const [httpModule, toolActivity] = await Promise.all([
      loadHttpModule(),
      loadToolActivity(),
      loadDesktopManager(),
      loadBrowserDriver()
    ]);
    server = httpModule.startHttpServer({
      host,
      port,
      token,
      publicUrl: '',
      exitOnError: false,
      writeProfile: false,
      pickFolder: () => callNative('pickFolder'),
      openFolder: folderPath => callNative('openFolder', { path: folderPath }),
      getTaskActivity: () => toolActivity.getToolActivity(),
      getDesktopStatus: () => desktopContext.status,
      onDesktopStatusChange: listener => {
        if (typeof listener !== 'function') return () => {};
        desktopStatusListeners.add(listener);
        return () => desktopStatusListeners.delete(listener);
      },
      getRuntimeAccess: () => desktopContext.runtimeAccess,
      resetTaskActivity: () => {
        toolActivity.resetToolActivity();
        return { ok: true };
      },
      getRuntimeLogs: options => runtimeLogSnapshot(options),
      clearRuntimeLogs: () => callNative('clearRuntimeLogs'),
      onRuntimeLogChange: listener => {
        if (typeof listener !== 'function') return () => {};
        runtimeLogListeners.add(listener);
        return () => runtimeLogListeners.delete(listener);
      }
    });
    const actualPort = await waitForListening(server);
    httpServer = server;
    activeToken = token;
    activePort = actualPort;
    publishActivitySnapshot();
    return { ok: true, port: actualPort };
  } catch (error) {
    try { server?.closeAllConnections?.(); } catch {}
    if (server) await closeHttpServer(server).catch(() => {});
    httpServer = null;
    activeToken = '';
    activePort = 0;
    throw error;
  }
}

async function stopService() {
  const ownedServer = httpServer;
  httpServer = null;
  activeToken = '';
  activePort = 0;
  const localService = await closeHttpServer(ownedServer);
  const shutdownResult = ownedServer?.waitForShutdown
    ? await waitForShutdownCleanup(ownedServer)
    : null;
  const runtimeCleanup = normalizeRuntimeCleanup(shutdownResult);
  if (dashboardSessionsPromise) {
    const dashboardSessions = await dashboardSessionsPromise.catch(() => null);
    dashboardSessions?.clearDashboardSessions?.();
  }
  publishActivitySnapshot();
  const clean = localService.closed !== false && runtimeCleanup.clean !== false;
  return {
    ok: clean,
    cleanup: {
      clean,
      managedProcesses: runtimeCleanup.managedProcesses,
      localService,
      repositoryIntelligence: runtimeCleanup.repositoryIntelligence,
      ...(runtimeCleanup.errors.length ? { errors: runtimeCleanup.errors } : {}),
      ...(runtimeCleanup.reported ? {} : { runtimeCleanupReported: false })
    }
  };
}

async function waitForShutdownCleanup(server) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(server.waitForShutdown()),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({
          clean: false,
          managedProcesses: { attempted: 0, stopped: 0, orphaned: 1 },
          repositoryIntelligence: { closed: false },
          errors: [{ step: 'runtimeCleanup', error: `Runtime cleanup did not finish within ${SHUTDOWN_CLEANUP_TIMEOUT_MS / 1000} seconds.` }]
        }), SHUTDOWN_CLEANUP_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeRuntimeCleanup(value) {
  const reported = Boolean(value && typeof value === 'object');
  const cleanup = reported ? value : {};
  return {
    reported,
    clean: cleanup.clean !== false,
    managedProcesses: cleanup.managedProcesses || {
      attempted: 0,
      stopped: 0,
      orphaned: 0,
      delegated: true
    },
    repositoryIntelligence: cleanup.repositoryIntelligence || {
      closed: true,
      delegated: true
    },
    errors: Array.isArray(cleanup.errors) ? cleanup.errors : []
  };
}

async function createDashboardBootstrap() {
  if (!httpServer?.listening || !activeToken || !activePort) throw new Error('Local service is not running.');
  const dashboardSessions = await loadDashboardSessions();
  return {
    ok: true,
    port: activePort,
    bootstrap: dashboardSessions.createDashboardBootstrap(activeToken)
  };
}

function updateDesktopContext(next = {}) {
  const hasStatus = Object.hasOwn(next, 'status');
  desktopContext = {
    ...desktopContext,
    ...(hasStatus ? { status: next.status } : {}),
    ...(Object.hasOwn(next, 'runtimeAccess') ? { runtimeAccess: next.runtimeAccess } : {}),
    ...(Object.hasOwn(next, 'runtimeLogs') ? { runtimeLogs: next.runtimeLogs } : {}),
    ...(Object.hasOwn(next, 'reducedBackgroundWork') ? { reducedBackgroundWork: next.reducedBackgroundWork === true } : {})
  };
  process.env.REL_AI_REDUCED_BACKGROUND_WORK = desktopContext.reducedBackgroundWork ? '1' : '';
  if (hasStatus) {
    for (const listener of [...desktopStatusListeners]) {
      try { listener(desktopContext.status); } catch {}
    }
  }
  if (next.runtimeLogChange) {
    desktopContext.runtimeLogs = applyRuntimeLogChange(desktopContext.runtimeLogs, next.runtimeLogChange);
    for (const listener of [...runtimeLogListeners]) {
      try { listener(next.runtimeLogChange); } catch {}
    }
  }
  if (next.transportEvent) {
    void loadCoreDesktopOperations()
      .then(coreDesktopOperations => coreDesktopOperations.recordDesktopTransportEvent(next.transportEvent))
      .catch(error => post({ type: 'log', level: 'warning', message: `Desktop transport telemetry failed: ${errorMessage(error)}` }));
  }
}

function runtimeLogSnapshot(options = {}) {
  const snapshot = desktopContext.runtimeLogs || { available: true, revision: 0, count: 0, entries: [] };
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const limit = Math.max(1, Math.min(entries.length || 1, Number(options.limit || entries.length || 1)));
  return { ...snapshot, entries: entries.slice(-limit) };
}

function callNative(method, payload = {}, options = {}) {
  const id = `native-${++nativeRequestSequence}`;
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(nativeCancelledError(signal.reason));
  return new Promise((resolve, reject) => {
    const timeoutMs = nativeRequestTimeoutMs(method, payload);
    const finish = () => {
      const entry = pendingNativeRequests.get(id);
      if (!entry) return false;
      pendingNativeRequests.delete(id);
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      post({ type: 'native-cancel', id });
      reject(nativeCancelledError(signal?.reason));
    };
    const timer = setTimeout(() => {
      if (!finish()) return;
      post({ type: 'native-cancel', id });
      reject(new Error(`Native desktop request timed out: ${method}`));
    }, timeoutMs);
    timer.unref?.();
    pendingNativeRequests.set(id, { resolve, reject, timer, signal, onAbort });
    signal?.addEventListener('abort', onAbort, { once: true });
    post({ type: 'native-request', id, method, payload });
  });
}

function settleNativeRequest(message) {
  const id = String(message.id || '');
  const entry = pendingNativeRequests.get(id);
  if (!entry) return;
  pendingNativeRequests.delete(id);
  clearTimeout(entry.timer);
  if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  if (message.ok) entry.resolve(message.result);
  else {
    const error = new Error(String(message.error?.message || 'Native desktop request failed.'));
    if (message.error?.code) error.code = String(message.error.code);
    entry.reject(error);
  }
}

function nativeRequestTimeoutMs(method, payload) {
  const requested = Number(payload?.timeoutMs);
  if (method === 'browserOperation' && Number.isFinite(requested)) {
    return Math.max(5_000, Math.min(35_000, Math.floor(requested) + 5_000));
  }
  return 30_000;
}

function nativeCancelledError(reason) {
  const error = new Error(reason instanceof Error ? reason.message : String(reason || 'Browser operation cancelled.'));
  error.code = 'BROWSER_OPERATION_CANCELLED';
  return error;
}

function publishActivitySnapshot() {
  if (!loadedToolActivity) return;
  post({
    type: 'activity',
    event: { phase: 'snapshot', snapshot: projectServiceActivitySnapshot(loadedToolActivity.getToolActivity()) }
  });
}

function loadHttpModule() {
  httpModulePromise ||= importResourceModule('src/httpServer.ts');
  return httpModulePromise;
}

function loadToolActivity() {
  if (!toolActivityPromise) {
    toolActivityPromise = importResourceModule('src/toolActivity.js').then(toolActivity => {
      loadedToolActivity = toolActivity;
      unsubscribeActivity ||= toolActivity.onToolActivity(event => {
        const projected = projectServiceActivityEvent(event);
        if (projected) post({ type: 'activity', event: projected });
      });
      return toolActivity;
    });
  }
  return toolActivityPromise;
}

function loadDashboardSessions() {
  dashboardSessionsPromise ||= importResourceModule('src/http/dashboardSessions.ts');
  return dashboardSessionsPromise;
}

function loadCoreDesktopOperations() {
  coreDesktopOperationsPromise ||= importResourceModule('src/core/desktop-operations.ts');
  return coreDesktopOperationsPromise;
}

function loadDesktopManager() {
  if (!desktopManagerPromise) {
    desktopManagerPromise = importResourceModule('src/desktopManager.ts').then(desktopManager => {
      desktopManager.configureDesktopNativeBridge(payload => callNative('desktopOperation', payload));
      return desktopManager;
    });
  }
  return desktopManagerPromise;
}

function loadBrowserDriver() {
  if (!browserDriverPromise) {
    browserDriverPromise = importResourceModule('src/browser/browserDriver.ts').then(browserDriver => {
      browserDriver.configureBrowserNativeBridge((payload, options) => callNative('browserOperation', payload, options));
      return browserDriver;
    });
  }
  return browserDriverPromise;
}

function waitForListening(server, timeoutMs = LISTEN_TIMEOUT_MS) {
  if (server?.listening) return Promise.resolve(server.address().port);
  return new Promise((resolve, reject) => {
    const onListening = () => finish(() => resolve(server.address().port));
    const onError = error => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error(
      `Local Rel.AI HTTP server did not begin listening within ${Math.round(timeoutMs / 1000)} seconds.`
    ))), Math.max(1, Number(timeoutMs || LISTEN_TIMEOUT_MS)));
    server.once('listening', onListening);
    server.once('error', onError);
    function finish(action) {
      clearTimeout(timer);
      server.off('listening', onListening);
      server.off('error', onError);
      action();
    }
  });
}

function post(message) {
  parentPort.postMessage(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

process.once('beforeExit', () => {
  unsubscribeActivity?.();
});
