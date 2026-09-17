import { normalizePort, normalizeTunnelId, readGuiConfig } from './launcher-utils.js';
import { desktopStatusFailure, initialDesktopStatus } from './desktop-status.js';
import { createPerformanceBreakdown } from '../src/performanceObservability.js';

const LOCAL_READY_TIMEOUT_MS = 5_000;
const LOCAL_READY_POLL_MS = 100;
const LOCAL_READY_REQUEST_TIMEOUT_MS = 750;
const STOP_STARTUP_WAIT_TIMEOUT_MS = 16_000;
const LOCAL_START_MAX_ATTEMPTS = 2;
const LOCAL_START_RETRY_DELAY_MS = 250;

function createDesktopServiceRuntime(deps) {
  const {
    app,
    connection,
    configModule,
    serviceProcessClient,
    dashboardWindowManager,
    runtimeLogs,
    secureTunnelRuntime,
    tunnelCredentials,
    buildStatus = {},
    errorCodes,
    getCurrentStatus,
    setStatus,
    replaceCurrentStatus,
    pushStatus,
    fetchImpl = globalThis.fetch,
    startupStopTimeoutMs = STOP_STARTUP_WAIT_TIMEOUT_MS
  } = deps;
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');

  let startPromise = null;
  let stopPromise = null;
  let restartPromise = null;
  let localReadyPromise = null;
  let lifecycleToken = 0;
  let activePort = 0;
  let activeToken = '';

  function isListening() { return serviceProcessClient.isListening(); }

  async function startServer() {
    if (stopPromise) {
      try { await stopPromise; } catch {}
    }

    if (isListening()) {
      const tunnel = secureTunnelRuntime.snapshot();
      if (tunnel.state === 'running' || tunnel.processOwned) {
        pushStatus();
        return getCurrentStatus();
      }
      if (activePort) return restartConnection();
    }

    if (startPromise) return startPromise;
    const runToken = ++lifecycleToken;
    const localReady = deferred();
    localReadyPromise = localReady.promise;
    const pendingStart = start(runToken, localReady.resolve);
    startPromise = pendingStart;
    void pendingStart
      .then(status => localReady.resolve(status), () => localReady.resolve(getCurrentStatus()))
      .finally(clearPending);
    return pendingStart;

    function clearPending() {
      if (startPromise === pendingStart) startPromise = null;
    }
  }

  async function start(runToken, markLocalReady) {
    const timing = createPerformanceBreakdown();
    const prepared = timing.measureSync('desktop.configuration', () => prepareConnectionConfig({ createToken: true }));
    if (!prepared.ok) {
      setStatus(desktopStatusFailure(errorCodes.CONFIGURATION_INVALID, prepared.error, {
        serverRunning: false,
        tunnelStatus: 'failed',
        tunnelId: '',
        mcpUrl: ''
      }));
      return getCurrentStatus();
    }
    const { guiConfig, apiKey } = prepared;

    setStatus({
      serverRunning: false,
      starting: true,
      tunnelStatus: 'starting',
      tunnelId: guiConfig.tunnelId,
      error: '',
      errorCode: ''
    });

    let actualPort;
    try {
      serviceProcessClient.updateContext({ runtimeLogs: runtimeLogs.snapshot() });
      let localService = null;
      for (let attempt = 1; attempt <= LOCAL_START_MAX_ATTEMPTS; attempt += 1) {
        try {
          localService = await timing.measure('desktop.local_service', () => serviceProcessClient.start({
            host: '127.0.0.1',
            port: guiConfig.port,
            token: guiConfig.token
          }));
          break;
        } catch (error) {
          const retryable = attempt < LOCAL_START_MAX_ATTEMPTS && isRetryableLocalStartupError(error);
          if (!retryable) throw error;
          runtimeLogs.append?.('Local service process did not spawn. Rel.AI is retrying once with a fresh service process.', {
            level: 'warning',
            source: 'desktop-lifecycle',
            code: 'local_service_start_retry',
            details: {
              attempt,
              errorCode: String(error?.code || ''),
              message: formatError(error)
            }
          });
          await delay(LOCAL_START_RETRY_DELAY_MS);
        }
      }
      actualPort = Number(localService.port || guiConfig.port);
      await timing.measure('desktop.readiness', () => waitForLocalApplicationReady(fetchImpl, actualPort, guiConfig.token));
      activePort = actualPort;
      activeToken = guiConfig.token;
    } catch (error) {
      await serviceProcessClient.stop().catch(() => {});
      activePort = 0;
      activeToken = '';
      const portInUse = error?.code === 'EADDRINUSE';
      const code = portInUse ? errorCodes.LOCAL_PORT_IN_USE : errorCodes.LOCAL_SERVICE_START_FAILED;
      const failure = portInUse ? `Port ${guiConfig.port} is already in use.` : error;
      recordDesktopTiming(runtimeLogs, 'connection_start', timing.snapshot(), false);
      setStatus(desktopStatusFailure(code, failure, {
        serverRunning: false,
        tunnelStatus: 'failed',
        tunnelId: guiConfig.tunnelId,
        mcpUrl: ''
      }));
      return getCurrentStatus();
    }

    const localUrl = `http://127.0.0.1:${actualPort}`;
    setStatus({
      serverRunning: true,
      starting: false,
      tunnelStatus: 'starting',
      tunnelId: guiConfig.tunnelId,
      tunnelHealthUrl: '',
      mcpUrl: '',
      localMcpUrl: `${localUrl}/mcp`,
      authenticationRequired: false,
      error: '',
      errorCode: '',
      localUrl
    });
    markLocalReady(getCurrentStatus());

    return startTunnel({ runToken, guiConfig, apiKey, actualPort, timing });
  }

  function restartConnection() {
    if (restartPromise) return restartPromise;
    const pendingRestart = restartConnectionNow();
    restartPromise = pendingRestart;
    const clearPending = () => {
      if (restartPromise === pendingRestart) restartPromise = null;
    };
    void pendingRestart.then(clearPending, clearPending);
    return pendingRestart;
  }

  async function restartConnectionNow() {
    if (stopPromise) {
      try { await stopPromise; } catch {}
    }
    if (!isListening() || !activePort) return startServer();
    if (startPromise) await startPromise.catch(() => {});

    const prepared = prepareConnectionConfig({ createToken: false });
    if (!prepared.ok) {
      setStatus(desktopStatusFailure(errorCodes.CONFIGURATION_INVALID, prepared.error, {
        serverRunning: true,
        tunnelStatus: 'failed',
        tunnelId: '',
        localMcpUrl: `http://127.0.0.1:${activePort}/mcp`
      }));
      return getCurrentStatus();
    }
    const { guiConfig, apiKey } = prepared;
    guiConfig.token ||= activeToken;
    if (!guiConfig.token) {
      const error = new Error('Rel.AI local authentication is unavailable. Restart the full connection.');
      setStatus(desktopStatusFailure(errorCodes.CONFIGURATION_INVALID, error, {
        serverRunning: true,
        tunnelStatus: 'failed',
        tunnelId: guiConfig.tunnelId
      }));
      return getCurrentStatus();
    }

    const runToken = ++lifecycleToken;
    await secureTunnelRuntime.stop().catch(() => {});
    const localUrl = `http://127.0.0.1:${activePort}`;
    setStatus({
      serverRunning: true,
      tunnelStatus: 'starting',
      tunnelId: guiConfig.tunnelId,
      tunnelHealthUrl: '',
      localMcpUrl: `${localUrl}/mcp`,
      localUrl,
      error: '',
      errorCode: ''
    });
    return startTunnel({ runToken, guiConfig, apiKey, actualPort: activePort });
  }

  async function startTunnel({ runToken, guiConfig, apiKey, actualPort, timing = null }) {
    const localUrl = `http://127.0.0.1:${actualPort}`;
    let result;
    try {
      connection.writeConnectionProfile({
        host: '127.0.0.1',
        port: actualPort,
        tunnelId: guiConfig.tunnelId,
        tunnelProvider: 'openai-secure-mcp',
        configPath: configModule.getConfigPath()
      });
      const startTunnelOperation = () => secureTunnelRuntime.start({
        tunnelId: guiConfig.tunnelId,
        port: actualPort,
        localToken: guiConfig.token,
        apiKey
      });
      result = timing
        ? await timing.measure('desktop.tunnel', startTunnelOperation)
        : await startTunnelOperation();
    } catch (error) {
      if (runToken !== lifecycleToken) return getCurrentStatus();
      const code = tunnelErrorCode(error, errorCodes);
      const terminal = isTerminalTunnelCode(code, errorCodes);
      const current = getCurrentStatus();
      recordDesktopTiming(runtimeLogs, 'connection_start', timing?.snapshot(), false);
      setStatus(desktopStatusFailure(
        terminal ? code : (errorCodes.TUNNEL_CONNECTION_INTERRUPTED || 'tunnel_connection_interrupted'),
        terminal ? error : 'Secure MCP Tunnel is unavailable. Rel.AI is retrying automatically.',
        {
          serverRunning: true,
          tunnelStatus: terminal ? 'failed' : 'degraded',
          tunnelId: guiConfig.tunnelId,
          tunnelHealthUrl: '',
          tunnelRetryAttempt: terminal ? 0 : Number(current.tunnelRetryAttempt || 0),
          tunnelNextRetryAt: terminal ? null : (current.tunnelNextRetryAt || null),
          mcpUrl: '',
          localMcpUrl: `${localUrl}/mcp`,
          localUrl
        }
      ));
      return getCurrentStatus();
    }
    if (runToken !== lifecycleToken || result.cancelled) return getCurrentStatus();

    recordDesktopTiming(runtimeLogs, 'connection_start', timing?.snapshot(), true);
    setStatus({
      serverRunning: true,
      tunnelStatus: 'running',
      tunnelId: guiConfig.tunnelId,
      tunnelHealthUrl: result.healthUrl || '',
      mcpUrl: '',
      localMcpUrl: `${localUrl}/mcp`,
      authenticationRequired: false,
      error: '',
      errorCode: '',
      localUrl
    });
    return getCurrentStatus();
  }

  async function runTunnelDoctor() {
    if (!isListening() || !activePort || !activeToken) {
      throw new Error('Start or retry the connection before running Secure MCP Tunnel diagnostics.');
    }
    const prepared = prepareConnectionConfig({ createToken: false });
    if (!prepared.ok) throw prepared.error;
    const { guiConfig, apiKey } = prepared;
    return secureTunnelRuntime.doctor({
      tunnelId: guiConfig.tunnelId,
      port: activePort,
      localToken: activeToken,
      apiKey
    });
  }

  function prepareConnectionConfig({ createToken }) {
    try {
      configModule.ensureConfig();
      const guiConfig = readGuiConfig();
      guiConfig.port = normalizePort(guiConfig.port || 3333);
      guiConfig.tunnelId = normalizeTunnelId(guiConfig.tunnelId);
      const apiKey = tunnelCredentials.getApiKey();
      if (!apiKey) throw new Error('OpenAI tunnel runtime API key is required. Open Connection settings to finish setup.');
      if (!guiConfig.token && createToken) {
        guiConfig.token = connection.generateToken(32);
        connection.writeLaunchEnv({ REL_AI_MCP_TOKEN: guiConfig.token });
      }
      return { ok: true, guiConfig, apiKey };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function waitUntilListening(timeoutMs = 10_000) {
    if (isListening() && activePort) return getCurrentStatus();
    const pending = localReadyPromise || startPromise;
    if (!pending) return getCurrentStatus();
    const waitMs = Number(timeoutMs);
    if (Number.isFinite(waitMs) && waitMs <= 0) return pending;
    let timer = null;
    try {
      return await Promise.race([
        pending,
        new Promise(resolve => {
          timer = setTimeout(() => resolve(getCurrentStatus()), Math.max(1, Number.isFinite(waitMs) ? waitMs : 10_000));
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function stopServer(options = {}) {
    if (stopPromise) return stopPromise;
    const pendingStop = stop(options);
    stopPromise = pendingStop;
    const clearPending = () => {
      if (stopPromise === pendingStop) stopPromise = null;
    };
    void pendingStop.then(clearPending, clearPending);
    return pendingStop;
  }

  async function stop(options) {
    const pendingLocalReady = localReadyPromise;
    lifecycleToken += 1;
    startPromise = null;
    localReadyPromise = null;
    if (pendingLocalReady) {
      const startupSettled = await waitForPromise(pendingLocalReady, startupStopTimeoutMs);
      if (!startupSettled) await serviceProcessClient.dispose({ stop: false }).catch(() => {});
    }
    const [localRuntime, secureTunnel] = await Promise.all([
      serviceProcessClient.stop().catch(error => ({
        ok: false,
        cleanup: {
          clean: false,
          managedProcesses: { attempted: 0, stopped: 0, orphaned: 1, error: formatError(error) },
          localService: { closed: false, forced: false, error: formatError(error) }
        }
      })),
      secureTunnelRuntime.stop().catch(error => ({ stopped: false, exited: false, error: formatError(error) }))
    ]);
    activePort = 0;
    activeToken = '';
    if (options.terminateUtility === true) await serviceProcessClient.dispose({ stop: false });
    if (!options.preserveDashboard) await dashboardWindowManager.close();
    const nextStatus = initialDesktopStatus(app.getVersion(), buildStatus);
    replaceCurrentStatus(nextStatus, { silent: options.silent === true });
    const runtimeCleanup = localRuntime.cleanup || {};
    const cleanup = {
      clean: runtimeCleanup.clean !== false && secureTunnel.stopped !== false && secureTunnel.exited !== false,
      managedProcesses: runtimeCleanup.managedProcesses || { attempted: 0, stopped: 0, orphaned: 0 },
      secureTunnel,
      localService: runtimeCleanup.localService || { closed: true, forced: false }
    };
    return { ...nextStatus, cleanup };
  }

  async function buildDashboardConnection() {
    if (!isListening()) throw new Error('Local service is not running.');
    const authorization = await serviceProcessClient.dashboardBootstrap();
    const chrome = dashboardWindowManager.getState();
    const chromeMode = chrome.customTitleBar ? 'custom' : 'native';
    return {
      url: `http://127.0.0.1:${authorization.port}/dashboard?surface=desktop&chrome=${chromeMode}&platform=${encodeURIComponent(chrome.platform)}&bootstrap=${encodeURIComponent(authorization.bootstrap)}`,
      authGeneration: lifecycleToken
    };
  }

  return { startServer, restartConnection, stopServer, isListening, waitUntilListening, buildDashboardConnection, runTunnelDoctor };
}

async function waitForLocalApplicationReady(fetchImpl, port, token, timeoutMs = LOCAL_READY_TIMEOUT_MS) {
  const totalTimeoutMs = Math.max(500, Number(timeoutMs || LOCAL_READY_TIMEOUT_MS));
  const deadline = Date.now() + totalTimeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const healthTimeoutMs = Math.max(1, Math.min(LOCAL_READY_REQUEST_TIMEOUT_MS, deadline - Date.now()));
      const health = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(healthTimeoutMs)
      });
      if (Date.now() >= deadline) break;
      const mcpTimeoutMs = Math.max(1, Math.min(LOCAL_READY_REQUEST_TIMEOUT_MS, deadline - Date.now()));
      const mcp = await fetchImpl(`http://127.0.0.1:${port}/mcp`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(mcpTimeoutMs)
      });
      if (health?.ok && Number(mcp?.status || 0) === 405) return true;
      lastError = `health=${health?.status || 0}, mcp=${mcp?.status || 0}`;
    } catch (error) {
      lastError = formatError(error);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(LOCAL_READY_POLL_MS, remainingMs));
  }
  throw new Error(`Local Rel.AI service did not become responsive within ${Math.round(totalTimeoutMs / 1000)} seconds${lastError ? `: ${lastError}` : '.'}`);
}

async function waitForPromise(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs || 1)));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRetryableLocalStartupError(error) {
  return String(error?.code || '') === 'REL_AI_SERVICE_SPAWN_TIMEOUT';
}

function tunnelErrorCode(error, errorCodes) {
  const code = String(error?.code || '');
  if (code === 'tunnel_authentication_failed') return errorCodes.TUNNEL_AUTHENTICATION_FAILED || code;
  if (code === 'tunnel_access_denied') return errorCodes.TUNNEL_ACCESS_DENIED || code;
  if (code === 'tunnel_not_found') return errorCodes.TUNNEL_NOT_FOUND || code;
  if (code === 'tunnel_connection_interrupted') return errorCodes.TUNNEL_CONNECTION_INTERRUPTED || code;
  if (code === 'tunnel_runtime_unavailable') return errorCodes.TUNNEL_RUNTIME_UNAVAILABLE || code;
  return errorCodes.SECURE_TUNNEL_FAILED;
}

function isTerminalTunnelCode(code, errorCodes) {
  return code === errorCodes.TUNNEL_AUTHENTICATION_FAILED
    || code === errorCodes.TUNNEL_ACCESS_DENIED
    || code === errorCodes.TUNNEL_NOT_FOUND
    || code === errorCodes.TUNNEL_RUNTIME_UNAVAILABLE
    || code === 'tunnel_authentication_failed'
    || code === 'tunnel_access_denied'
    || code === 'tunnel_not_found'
    || code === 'tunnel_runtime_unavailable';
}

function deferred() {
  let settled = false;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    }
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function recordDesktopTiming(runtimeLogs, operation, snapshot, ok) {
  if (!snapshot || !runtimeLogs?.append) return;
  runtimeLogs.append('Desktop lifecycle timing.', {
    level: 'debug',
    source: 'desktop-performance',
    operation,
    details: {
      ok: ok === true,
      totalMs: Number(snapshot.totalMs || 0),
      phaseMs: snapshot.phaseMs || {}
    }
  });
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export { createDesktopServiceRuntime };
