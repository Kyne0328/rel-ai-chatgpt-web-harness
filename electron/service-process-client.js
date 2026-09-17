import { applyRuntimeLogChange } from './runtime-log-snapshot.js';

const SPAWN_TIMEOUT_MS = 10_000;

function createServiceProcessClient(options = {}) {
  const {
    utilityProcess,
    modulePath,
    cwd,
    env,
    nativeHandlers = {},
    onLog = () => {},
    onExit = () => {},
    spawnTimeoutMs = SPAWN_TIMEOUT_MS,
    startTimeoutMs = 30_000,
    stopTimeoutMs = 12_000
  } = options;
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') throw new TypeError('Electron utilityProcess is required.');
  if (!modulePath) throw new TypeError('A service-process module path is required.');

  let child = null;
  let spawnPromise = null;
  let cancelSpawn = null;
  let requestSequence = 0;
  let activePort = 0;
  let context = {};
  let currentActivity = emptyActivity();
  const pending = new Map();
  const activeNativeRequests = new Map();
  const activityListeners = new Set();
  const failedActivityListeners = new WeakSet();

  const activitySource = {
    getToolActivity() { return cloneActivity(currentActivity); },
    onToolActivity(listener) {
      if (typeof listener !== 'function') return () => {};
      activityListeners.add(listener);
      return () => {
        activityListeners.delete(listener);
        failedActivityListeners.delete(listener);
      };
    },
    resetToolActivity() {}
  };

  async function start(payload = {}) {
    await ensureChild();
    const result = await request('start', payload, startTimeoutMs);
    activePort = Number(result?.port || 0);
    return result;
  }

  async function stop() {
    if (!child) return { ok: true, cleanup: { clean: true, managedProcesses: { attempted: 0, stopped: 0, orphaned: 0 }, localService: { closed: true, forced: false } } };
    activePort = 0;
    const owned = child;
    const result = await request('stop', {}, stopTimeoutMs);
    if (result?.ok === false || result?.cleanup?.clean === false) {
      invalidateChild(owned, new Error('Rel.AI service process could not confirm a clean stop.'));
    }
    return result;
  }

  async function dashboardBootstrap() {
    await ensureChild();
    return request('dashboard-bootstrap', {}, 5_000);
  }

  async function getLocalUsage(month) {
    await ensureChild();
    return request('desktop-local-usage', { month }, 5_000);
  }

  async function markOnboardingHandoff() {
    await ensureChild();
    return request('desktop-onboarding-handoff', {}, 5_000);
  }

  async function getTaskCodeWorkspace(payload) {
    await ensureChild();
    return request('desktop-task-code-workspace', payload || {}, 30_000);
  }

  async function readTaskCodeDiff(payload) {
    await ensureChild();
    return request('desktop-task-code-diff', payload || {}, 30_000);
  }

  async function getTaskCodeWorkspacePath(payload) {
    await ensureChild();
    return request('desktop-task-code-workspace-path', payload || {}, 5_000);
  }

  function updateContext(patch = {}) {
    context = { ...context, ...patch };
    if (patch.runtimeLogChange) {
      context.runtimeLogs = applyRuntimeLogChange(context.runtimeLogs, patch.runtimeLogChange);
      delete context.runtimeLogChange;
    }
    if (patch.transportEvent) delete context.transportEvent;
    sendContext(patch);
  }

  function sendNativeEvent(event) {
    if (!child?.pid) return false;
    child.postMessage({ type: 'native-event', event });
    return true;
  }

  async function dispose(options = {}) {
    const owned = child;
    if (!owned) return;
    const startupPending = typeof cancelSpawn === 'function';
    if (startupPending) cancelSpawn();
    if (options.stop !== false && !startupPending) {
      try { await stop(); } catch {}
    }
    if (child !== owned) return;
    rejectPending(new Error('Rel.AI service process closed.'));
    abortNativeRequests(new Error('Rel.AI service process closed.'));
    owned.removeAllListeners();
    try { owned.kill(); } catch {}
    child = null;
    spawnPromise = null;
    cancelSpawn = null;
    activePort = 0;
  }

  function isListening() {
    return activePort > 0 && Boolean(child?.pid);
  }

  function port() {
    return activePort;
  }

  async function ensureChild() {
    if (child && spawnPromise) return spawnPromise;
    const utility = utilityProcess.fork(modulePath, [], {
      serviceName: 'Rel.AI MCP Service',
      stdio: 'pipe',
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {})
    });
    child = utility;
    bindChild(utility);
    spawnPromise = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action) => {
        if (settled) return;
        settled = true;
        clearTimeout(spawnTimer);
        utility.off('spawn', onSpawn);
        utility.off('exit', onEarlyExit);
        if (cancelSpawn === onCancel) cancelSpawn = null;
        action();
      };
      const onSpawn = () => finish(resolve);
      const onEarlyExit = code => finish(() => reject(new Error(`Rel.AI service process exited during startup with code ${code}.`)));
      const onCancel = () => finish(() => reject(new Error('Rel.AI service process closed during startup.')));
      const waitMs = Math.max(1, Number(spawnTimeoutMs || SPAWN_TIMEOUT_MS));
      const spawnTimer = setTimeout(() => finish(() => {
        const error = new Error(`Rel.AI service process did not spawn within ${Math.round(waitMs / 100) / 10} seconds.`);
        error.code = 'REL_AI_SERVICE_SPAWN_TIMEOUT';
        invalidateChild(utility, error);
        reject(error);
      }), waitMs);
      cancelSpawn = onCancel;
      utility.once('spawn', onSpawn);
      utility.once('exit', onEarlyExit);
    });
    try {
      await spawnPromise;
      sendContext();
      return utility;
    } catch (error) {
      if (child === utility) {
        child = null;
        spawnPromise = null;
      }
      throw error;
    }
  }

  function bindChild(utility) {
    utility.on('message', message => handleMessage(utility, message));
    utility.on('exit', code => handleExit(utility, code));
    utility.stdout?.on('data', chunk => logChunk(chunk, 'info'));
    utility.stderr?.on('data', chunk => logChunk(chunk, 'warning'));
  }

  function handleMessage(utility, message = {}) {
    if (utility !== child) return;
    if (message.type === 'response') {
      settleResponse(message);
      return;
    }
    if (message.type === 'activity') {
      const event = message.event || {};
      // The dashboard receives coalesced live progress from the local service directly.
      // Electron only needs lifecycle edges for native power, notification, and recovery state.
      if (event.phase === 'progress') return;
      publishActivity(event);
      return;
    }
    if (message.type === 'native-cancel') {
      activeNativeRequests.get(String(message.id || ''))?.abort(new Error('Native browser operation cancelled by the service process.'));
      return;
    }
    if (message.type === 'native-request') void handleNativeRequest(utility, message);
  }

  function handleExit(utility, code) {
    if (utility !== child) return;
    child = null;
    spawnPromise = null;
    activePort = 0;
    currentActivity = emptyActivity();
    publishActivity({ phase: 'snapshot', snapshot: currentActivity });
    rejectPending(new Error(`Rel.AI service process exited with code ${code}.`));
    abortNativeRequests(new Error(`Rel.AI service process exited with code ${code}.`));
    onExit({ code: Number(code || 0) });
  }

  function request(method, payload, timeoutMs) {
    const utility = child;
    if (!utility) return Promise.reject(new Error('Rel.AI service process is not running.'));
    const id = `request-${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new Error(`Rel.AI service request timed out: ${method}`);
        error.code = 'REL_AI_SERVICE_REQUEST_TIMEOUT';
        error.method = method;
        reject(error);
        if (method === 'start' || method === 'stop') invalidateChild(utility, error);
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      utility.postMessage({ type: 'request', id, method, payload });
    });
  }

  function settleResponse(message) {
    const id = String(message.id || '');
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    const error = new Error(String(message.error?.message || 'Rel.AI service request failed.'));
    if (message.error?.code) error.code = String(message.error.code);
    entry.reject(error);
  }

  async function handleNativeRequest(utility, message) {
    const id = String(message.id || '');
    const method = String(message.method || '');
    const handler = nativeHandlers[method];
    const controller = new AbortController();
    activeNativeRequests.set(id, controller);
    try {
      if (typeof handler !== 'function') throw new Error(`Unsupported native desktop request: ${method}`);
      const result = await handler(message.payload || {}, { signal: controller.signal });
      if (utility === child) utility.postMessage({ type: 'native-response', id: message.id, ok: true, result });
    } catch (error) {
      if (utility === child) utility.postMessage({
        type: 'native-response', id: message.id, ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error || 'Native desktop request failed.'),
          ...(error?.code ? { code: String(error.code) } : {})
        }
      });
    } finally {
      if (activeNativeRequests.get(id) === controller) activeNativeRequests.delete(id);
    }
  }

  function abortNativeRequests(reason) {
    for (const controller of activeNativeRequests.values()) controller.abort(reason);
    activeNativeRequests.clear();
  }

  function publishActivity(event = {}) {
    if (event.phase === 'snapshot' && event.snapshot) currentActivity = cloneActivity(event.snapshot);
    for (const listener of [...activityListeners]) {
      try {
        listener(event);
        failedActivityListeners.delete(listener);
      } catch (error) {
        if (failedActivityListeners.has(listener)) continue;
        failedActivityListeners.add(listener);
        const activityEvent = event.activityEvent || {};
        const snapshotTasks = Array.isArray(event.snapshot?.tasks) ? event.snapshot.tasks : [];
        const relatedTask = event.task || (snapshotTasks.length === 1 ? snapshotTasks[0] : null);
        onLog(`Task activity subscriber failed: ${error instanceof Error ? error.message : String(error || 'Unknown listener error')}`, {
          level: 'warning',
          source: 'desktop-observability',
          code: 'activity_listener_failed',
          taskId: event.taskId || relatedTask?.taskId || relatedTask?.id || '',
          eventId: activityEvent.eventId || activityEvent.operationId || event.operationId || '',
          workspace: event.workspace || relatedTask?.workspace || '',
          tool: event.tool || relatedTask?.lastTool || relatedTask?.tool || '',
          operation: event.operation || relatedTask?.operation || relatedTask?.lastOperation || ''
        });
      }
    }
  }

  function sendContext(patch = context) {
    if (!child?.pid) return;
    child.postMessage({ type: 'context', context: patch });
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function invalidateChild(utility, reason) {
    if (utility !== child) return;
    child = null;
    spawnPromise = null;
    cancelSpawn = null;
    activePort = 0;
    currentActivity = emptyActivity();
    publishActivity({ phase: 'snapshot', snapshot: currentActivity });
    rejectPending(reason instanceof Error ? reason : new Error(String(reason || 'Rel.AI service process invalidated.')));
    abortNativeRequests(reason);
    utility.removeAllListeners();
    try { utility.kill(); } catch {}
  }

  function logChunk(chunk, level) {
    const text = String(chunk || '').trim();
    if (!text) return;
    onLog(text, { level, source: 'local-service' });
  }

  return {
    start,
    stop,
    dispose,
    dashboardBootstrap,
    getLocalUsage,
    markOnboardingHandoff,
    getTaskCodeWorkspace,
    readTaskCodeDiff,
    getTaskCodeWorkspacePath,
    updateContext,
    sendNativeEvent,
    isListening,
    port,
    activitySource
  };
}

function emptyActivity() {
  return { state: 'idle', activeConnectorCalls: 0, activeCalls: 0, activeTaskCount: 0, tasks: [], taskId: '', workspace: '', tool: '', operation: '', startedAt: null, lastTask: null };
}

function cloneActivity(activity = {}) {
  return {
    ...activity,
    tasks: Array.isArray(activity.tasks) ? activity.tasks.map(task => ({ ...task })) : [],
    lastTask: activity.lastTask ? { ...activity.lastTask } : null
  };
}

export { createServiceProcessClient };
