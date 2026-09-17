import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { saveLauncherConfig } from '../electron/launcher-config.js';
import { createDesktopServiceRuntime } from '../electron/service-runtime.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-service-runtime-'));
const configPath = path.join(stateDir, 'config.json');
const previousState = process.env.REL_AI_MCP_STATE_DIR;
const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_STATE_DIR = stateDir;
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  saveLauncherConfig({ port: 3333, tunnelId: 'tunnel_lifecycle123', token: 'local-token' });

  const localStart = deferred();
  const tunnelStart = deferred();
  let listening = false;
  let localStartCalls = 0;
  let localStopCalls = 0;
  let tunnelStopCalls = 0;
  let doctorArgs = null;
  let dashboardCloseCalls = 0;
  let localStopGate = null;
  let currentStatus = { serverRunning: false, tunnelStatus: 'stopped' };

  const runtime = createDesktopServiceRuntime({
    app: { getVersion: () => '0.26.0' },
    connection: {
      generateToken: () => 'generated-token',
      writeLaunchEnv() {},
      writeConnectionProfile() {}
    },
    configModule: {
      ensureConfig() {},
      getConfigPath: () => configPath
    },
    serviceProcessClient: {
      isListening: () => listening,
      updateContext() {},
      async start() {
        localStartCalls += 1;
        const result = await localStart.promise;
        listening = true;
        return result;
      },
      async stop() {
        localStopCalls += 1;
        if (localStopGate) await localStopGate.promise;
        listening = false;
        return {
          ok: true,
          cleanup: {
            clean: true,
            managedProcesses: { attempted: 0, stopped: 0, orphaned: 0 },
            localService: { closed: true, forced: false }
          }
        };
      },
      async dispose() {}
    },
    dashboardWindowManager: {
      async close() { dashboardCloseCalls += 1; }
    },
    runtimeLogs: { snapshot: () => ({ available: true, revision: 0, count: 0, entries: [] }) },
    fetchImpl: async url => ({ ok: url.endsWith('/health'), status: url.endsWith('/mcp') ? 405 : 200 }),
    secureTunnelRuntime: {
      snapshot: () => ({ state: currentStatus.tunnelStatus || 'stopped', processOwned: currentStatus.tunnelStatus === 'running' }),
      start: () => tunnelStart.promise,
      doctor: args => { doctorArgs = args; return { ok: true, result: 'pass' }; },
      async stop() {
        tunnelStopCalls += 1;
        tunnelStart.resolve({ cancelled: true });
        return { stopped: true, exited: true };
      }
    },
    tunnelCredentials: { getApiKey: () => 'test-api-key' },
    errorCodes: {
      CONFIGURATION_INVALID: 'configuration_invalid',
      LOCAL_PORT_IN_USE: 'local_port_in_use',
      LOCAL_SERVICE_START_FAILED: 'local_service_start_failed',
      SECURE_TUNNEL_FAILED: 'secure_tunnel_failed',
      TUNNEL_RUNTIME_UNAVAILABLE: 'tunnel_runtime_unavailable'
    },
    getCurrentStatus: () => currentStatus,
    setStatus: next => { currentStatus = { ...currentStatus, ...next }; },
    replaceCurrentStatus: next => { currentStatus = next; },
    pushStatus() {}
  });

  const startPromise = runtime.startServer();
  await new Promise(resolve => setImmediate(resolve));

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let readinessSettled = false;
  try {
    globalThis.setTimeout = callback => { callback(); return 1; };
    globalThis.clearTimeout = () => {};
    const readiness = runtime.waitUntilListening(0).then(status => {
      readinessSettled = true;
      return status;
    });
    await Promise.resolve();
    assert.equal(readinessSettled, false,
      'timeout 0 must follow the in-progress local readiness promise instead of scheduling an early recovery deadline');
    void readiness;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }

  const stopPromise = runtime.stopServer();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(localStopCalls, 0, 'shutdown must not race ahead while the local utility service is still binding');

  localStart.resolve({ ok: true, port: 4567 });
  const stopped = await stopPromise;
  await startPromise;
  assert.equal(localStopCalls, 1, 'shutdown must stop the local service after the pending bind resolves');
  assert.equal(tunnelStopCalls, 1, 'shutdown must still stop a tunnel start that follows local readiness');
  assert.equal(dashboardCloseCalls, 1);
  assert.equal(listening, false);
  assert.equal(stopped.cleanup.clean, true);

  listening = true;
  currentStatus = { serverRunning: true, tunnelStatus: 'running' };
  localStopGate = deferred();
  const racingStop = runtime.stopServer({ preserveDashboard: true });
  await new Promise(resolve => setImmediate(resolve));
  let racingStartSettled = false;
  const racingStart = runtime.startServer().then(status => {
    racingStartSettled = true;
    return status;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(racingStartSettled, false, 'a start requested during shutdown must wait for the stop transition instead of being lost');
  assert.equal(localStartCalls, 1, 'the replacement local service must not start until the previous stop finishes');
  localStopGate.resolve();
  await racingStop;
  await racingStart;
  assert.equal(localStartCalls, 2, 'the deferred start must run after shutdown completes');
  const doctor = await runtime.runTunnelDoctor();
  assert.equal(doctor.ok, true);
  assert.deepEqual(doctorArgs, {
    tunnelId: 'tunnel_lifecycle123',
    port: 4567,
    localToken: 'local-token',
    apiKey: 'test-api-key'
  }, 'tunnel diagnostics must use the active local MCP endpoint and encrypted tunnel credential');

  let hungDisposeCalls = 0;
  let hungStopCalls = 0;
  let hungStatus = { serverRunning: false, tunnelStatus: 'stopped' };
  const neverStartingLocalService = deferred();
  const hungRuntime = createDesktopServiceRuntime({
    app: { getVersion: () => '0.26.0' },
    connection: {
      generateToken: () => 'generated-token',
      writeLaunchEnv() {},
      writeConnectionProfile() {}
    },
    configModule: {
      ensureConfig() {},
      getConfigPath: () => configPath
    },
    serviceProcessClient: {
      isListening: () => false,
      updateContext() {},
      start: () => neverStartingLocalService.promise,
      async stop() {
        hungStopCalls += 1;
        return { ok: true, cleanup: { clean: true } };
      },
      async dispose() { hungDisposeCalls += 1; }
    },
    dashboardWindowManager: { async close() {} },
    runtimeLogs: { snapshot: () => ({ available: true, revision: 0, count: 0, entries: [] }) },
    fetchImpl: async () => ({ ok: true, status: 200 }),
    secureTunnelRuntime: {
      snapshot: () => ({ state: 'stopped', processOwned: false }),
      async start() { return { cancelled: true }; },
      async stop() { return { stopped: true, exited: true }; }
    },
    tunnelCredentials: { getApiKey: () => 'test-api-key' },
    errorCodes: {
      CONFIGURATION_INVALID: 'configuration_invalid',
      LOCAL_PORT_IN_USE: 'local_port_in_use',
      LOCAL_SERVICE_START_FAILED: 'local_service_start_failed',
      SECURE_TUNNEL_FAILED: 'secure_tunnel_failed',
      TUNNEL_RUNTIME_UNAVAILABLE: 'tunnel_runtime_unavailable'
    },
    getCurrentStatus: () => hungStatus,
    setStatus: next => { hungStatus = { ...hungStatus, ...next }; },
    replaceCurrentStatus: next => { hungStatus = next; },
    pushStatus() {},
    startupStopTimeoutMs: 20
  });
  void hungRuntime.startServer();
  await new Promise(resolve => setImmediate(resolve));
  const hungStopStartedAt = Date.now();
  const hungStopped = await hungRuntime.stopServer({ preserveDashboard: true });
  assert.ok(Date.now() - hungStopStartedAt < 500, 'shutdown must not wait indefinitely for a local startup that never settles');
  assert.equal(hungDisposeCalls, 1, 'expired startup wait must force-dispose the utility process generation');
  assert.equal(hungStopCalls, 1, 'shutdown must continue through the normal local cleanup path after forced invalidation');
  assert.equal(hungStopped.cleanup.clean, true);

  let retryListening = false;
  let retryStartCalls = 0;
  let retryFailureCode = 'REL_AI_SERVICE_SPAWN_TIMEOUT';
  const retryLogs = [];
  let retryStatus = { serverRunning: false, tunnelStatus: 'stopped' };
  const retryRuntime = createDesktopServiceRuntime({
    app: { getVersion: () => '0.26.0' },
    connection: {
      generateToken: () => 'generated-token',
      writeLaunchEnv() {},
      writeConnectionProfile() {}
    },
    configModule: {
      ensureConfig() {},
      getConfigPath: () => configPath
    },
    serviceProcessClient: {
      isListening: () => retryListening,
      updateContext() {},
      async start() {
        retryStartCalls += 1;
        if (retryStartCalls === 1 && retryFailureCode) {
          const error = new Error(retryFailureCode === 'REL_AI_SERVICE_SPAWN_TIMEOUT'
            ? 'Rel.AI service process did not spawn in time.'
            : 'Rel.AI service request timed out: start');
          error.code = retryFailureCode;
          if (retryFailureCode === 'REL_AI_SERVICE_REQUEST_TIMEOUT') error.method = 'start';
          throw error;
        }
        retryListening = true;
        return { ok: true, port: 4888 };
      },
      async stop() {
        retryListening = false;
        return { ok: true, cleanup: { clean: true } };
      },
      async dispose() {}
    },
    dashboardWindowManager: { async close() {} },
    runtimeLogs: {
      snapshot: () => ({ available: true, revision: 0, count: 0, entries: [] }),
      append: (message, options) => retryLogs.push({ message, options })
    },
    fetchImpl: async url => ({ ok: url.endsWith('/health'), status: url.endsWith('/mcp') ? 405 : 200 }),
    secureTunnelRuntime: {
      snapshot: () => ({ state: retryStatus.tunnelStatus || 'stopped', processOwned: false }),
      async start() { return { ok: true, healthUrl: 'http://127.0.0.1:49001' }; },
      async stop() { return { stopped: true, exited: true }; }
    },
    tunnelCredentials: { getApiKey: () => 'test-api-key' },
    errorCodes: {
      CONFIGURATION_INVALID: 'configuration_invalid',
      LOCAL_PORT_IN_USE: 'local_port_in_use',
      LOCAL_SERVICE_START_FAILED: 'local_service_start_failed',
      SECURE_TUNNEL_FAILED: 'secure_tunnel_failed',
      TUNNEL_RUNTIME_UNAVAILABLE: 'tunnel_runtime_unavailable'
    },
    getCurrentStatus: () => retryStatus,
    setStatus: next => { retryStatus = { ...retryStatus, ...next }; },
    replaceCurrentStatus: next => { retryStatus = next; },
    pushStatus() {}
  });
  const recoveredLaunch = await retryRuntime.startServer();
  assert.equal(retryStartCalls, 2, 'a utility-process spawn timeout must retry automatically once');
  assert.equal(recoveredLaunch.serverRunning, true);
  assert.equal(recoveredLaunch.tunnelStatus, 'running');
  assert.equal(retryLogs.filter(entry => entry.options?.code === 'local_service_start_retry').length, 1,
    'automatic spawn retry must be visible in diagnostics');

  await retryRuntime.stopServer({ preserveDashboard: true });
  retryStartCalls = 0;
  retryFailureCode = 'REL_AI_SERVICE_REQUEST_TIMEOUT';
  retryLogs.length = 0;
  const requestTimeoutFailure = await retryRuntime.startServer();
  assert.equal(retryStartCalls, 1, 'an expensive start-request timeout must not repeat the same initialization in a fresh process');
  assert.equal(requestTimeoutFailure.serverRunning, false);
  assert.equal(requestTimeoutFailure.errorCode, 'local_service_start_failed');
  assert.equal(retryLogs.filter(entry => entry.options?.code === 'local_service_start_retry').length, 0,
    'start-request timeouts must not be logged as retryable spawn failures');

  let terminalStatus = { serverRunning: false, tunnelStatus: 'stopped' };
  let terminalListening = false;
  const terminalRuntime = createDesktopServiceRuntime({
    app: { getVersion: () => '0.26.0' },
    connection: {
      generateToken: () => 'generated-token',
      writeLaunchEnv() {},
      writeConnectionProfile() {}
    },
    configModule: {
      ensureConfig() {},
      getConfigPath: () => configPath
    },
    serviceProcessClient: {
      isListening: () => terminalListening,
      updateContext() {},
      async start() { terminalListening = true; return { ok: true, port: 4777 }; },
      async stop() { terminalListening = false; return { ok: true, cleanup: { clean: true } }; },
      async dispose() {}
    },
    dashboardWindowManager: { async close() {} },
    runtimeLogs: { snapshot: () => ({ available: true, revision: 0, count: 0, entries: [] }) },
    fetchImpl: async url => ({ ok: url.endsWith('/health'), status: url.endsWith('/mcp') ? 405 : 200 }),
    secureTunnelRuntime: {
      snapshot: () => ({ state: terminalStatus.tunnelStatus || 'stopped', processOwned: false }),
      async start() {
        const error = new Error('Bundled tunnel-client is unavailable.');
        error.code = 'tunnel_runtime_unavailable';
        throw error;
      },
      async stop() { return { stopped: true, exited: true }; }
    },
    tunnelCredentials: { getApiKey: () => 'test-api-key' },
    errorCodes: {
      CONFIGURATION_INVALID: 'configuration_invalid',
      LOCAL_PORT_IN_USE: 'local_port_in_use',
      LOCAL_SERVICE_START_FAILED: 'local_service_start_failed',
      SECURE_TUNNEL_FAILED: 'secure_tunnel_failed',
      TUNNEL_RUNTIME_UNAVAILABLE: 'tunnel_runtime_unavailable'
    },
    getCurrentStatus: () => terminalStatus,
    setStatus: next => { terminalStatus = { ...terminalStatus, ...next }; },
    replaceCurrentStatus: next => { terminalStatus = next; },
    pushStatus() {}
  });
  const terminalFailure = await terminalRuntime.startServer();
  assert.equal(terminalFailure.tunnelStatus, 'failed');
  assert.equal(terminalFailure.errorCode, 'tunnel_runtime_unavailable', 'permanent local tunnel runtime failures must remain terminal through the desktop service layer');
} finally {
  if (previousState === undefined) delete process.env.REL_AI_MCP_STATE_DIR; else process.env.REL_AI_MCP_STATE_DIR = previousState;
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG; else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(stateDir, { recursive: true, force: true });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

console.log('Electron service runtime serializes shutdown behind local startup.');
