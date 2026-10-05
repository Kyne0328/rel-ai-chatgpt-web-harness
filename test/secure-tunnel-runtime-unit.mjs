import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSecureTunnelRuntime } from '../electron/secure-tunnel-runtime.js';
import { makeTunnelProcessEnvironment } from '../src/processEnvironment.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-secure-tunnel-'));
let spawned = null;
let primaryChild;
let operational = true;
let localAlive = true;
let controlPlaneDegraded = false;
let deliveryDegraded = false;
const statuses = [];
const logs = [];

function fakeSpawn(executable, args, options) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = signal => {
    child.killedWith = signal;
    child.exitCode = 1;
    return true;
  };
  const healthIndex = args.indexOf('--health.url-file');
  fs.writeFileSync(args[healthIndex + 1], 'http://127.0.0.1:49001\n');
  spawned = { executable, args, options, child };
  return child;
}

function fetchTunnel(url) {
  if (url === 'http://127.0.0.1:49001/healthz') return Promise.resolve(response(localAlive ? 200 : 503));
  if (url === 'http://127.0.0.1:49001/readyz') return Promise.resolve(response(operational ? 200 : 503));
  if (url === 'http://127.0.0.1:49001/api/status') {
    return Promise.resolve(response(200, {
      tunnel_metadata: { id: 'tunnel_example123456' },
      mcp_probe: { status: operational ? 'ok' : 'pending' }
    }));
  }
  if (url === 'http://127.0.0.1:49001/health/control-plane') {
    return Promise.resolve(response(200, {
      schema_version: 1,
      component: 'control-plane',
      status: controlPlaneDegraded ? 'degraded' : 'ok',
      state: controlPlaneDegraded ? 'backoff' : 'idle',
      reason_code: controlPlaneDegraded ? 'http_error' : '',
      limited: false,
      details: {
        consecutive_failures: controlPlaneDegraded ? 2 : 0,
        next_retry: controlPlaneDegraded ? '2026-09-25T09:30:00Z' : '',
        http_status: controlPlaneDegraded ? 409 : 0
      }
    }));
  }
  if (url === 'http://127.0.0.1:49001/health/response-delivery') {
    return Promise.resolve(response(200, {
      schema_version: 1,
      component: 'response-delivery',
      status: deliveryDegraded ? 'degraded' : 'ok',
      state: deliveryDegraded ? 'failed' : 'accepted',
      reason_code: deliveryDegraded ? 'http_error' : '',
      limited: false,
      details: {
        in_progress: 0,
        disposition: deliveryDegraded ? 'failed' : 'accepted',
        failure_category: deliveryDegraded ? 'http_error' : '',
        http_status: deliveryDegraded ? 502 : 200,
        attempts: 4,
        retries: deliveryDegraded ? 2 : 0,
        accepted: deliveryDegraded ? 2 : 4,
        completed: 4,
        terminal_failures: deliveryDegraded ? 1 : 0
      }
    }));
  }
  return Promise.resolve(response(404));
}

try {
  const runtime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: fetchTunnel,
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    monitorIntervalMs: 10,
    degradedFailureThreshold: 2,
    onLog: entry => logs.push(entry),
    onStatus: status => statuses.push(status)
  });
  const result = await runtime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-example-123456789', timeoutMs: 2000 });
  primaryChild = spawned.child;
  assert.equal(result.ok, true);
  assert.equal(runtime.snapshot().state, 'running');
  assert.equal(spawned.executable, process.execPath);
  assert.ok(spawned.args.includes('--control-plane.tunnel-id'));
  assert.ok(spawned.args.includes('tunnel_example123456'));
  assert.ok(spawned.args.includes('url=http://127.0.0.1:3333/mcp,channel=main'));
  assert.equal(spawned.options.env.CONTROL_PLANE_API_KEY, 'sk-runtime-example-123456789');
  assert.equal(spawned.options.env.REL_AI_LOCAL_AUTH_HEADER, 'Bearer local-secret');
  assert.equal(spawned.options.env.OPENAI_API_KEY, undefined, 'the tunnel must not inherit unrelated application credentials');
  assert.equal(spawned.options.env.SSH_AUTH_SOCK, undefined, 'the tunnel must not inherit the user SSH agent');
  assert.equal(spawned.args.includes('cloudflared'), false);
  for (const phase of ['starting', 'locally_ready', 'authenticating', 'running']) {
    assert.ok(statuses.some(status => status.state === phase), `startup must publish ${phase}`);
  }

  primaryChild.stdout.emit('data', '{"level":"WARN","msg":"command response deadline reached; dropping without posting a response","component":"dispatcher"}\n');
  primaryChild.stdout.emit('data', '{"level":"ERROR","msg":"dispatcher received MCP upstream error; posted error response to control plane","component":"dispatcher","status_code":502}\n');
  await waitFor(() => runtime.snapshot().transportFailureStreak === 2);
  assert.equal(runtime.snapshot().state, 'running', 'log wording must remain diagnostic and must not drive tunnel lifecycle state');

  deliveryDegraded = true;
  await waitFor(() => runtime.snapshot().state === 'degraded' && runtime.snapshot().errorCode === 'tunnel_command_delivery_degraded');
  assert.equal(runtime.snapshot().recoveryMode, 'in_place');
  assert.equal(primaryChild.exitCode, null, 'structured delivery degradation must preserve the live tunnel-client process');
  assert.equal(runtime.snapshot().tunnelHealth.responseDelivery.status, 'degraded');
  deliveryDegraded = false;
  await waitFor(() => runtime.snapshot().state === 'running');
  assert.equal(runtime.snapshot().transportFailureStreak, 0, 'a structured healthy observation must clear the diagnostic log streak');

  operational = false;
  controlPlaneDegraded = true;
  await waitFor(() => runtime.snapshot().state === 'degraded' && runtime.snapshot().recoveryMode === 'in_place');
  assert.equal(primaryChild.exitCode, null, 'control-plane backoff must recover in place without an outer restart');
  operational = true;
  controlPlaneDegraded = false;
  await waitFor(() => runtime.snapshot().state === 'running');
  await runtime.stop();
  assert.equal(primaryChild.exitCode, 0, 'manual stop must terminate the original tunnel child');
  assert.equal(runtime.snapshot().state, 'stopped');
  assert.equal(runtime.snapshot().recoveryMode, '', 'stopped tunnel state must not retain stale recovery ownership');
  assert.equal(runtime.snapshot().tunnelHealth, null, 'stopped tunnel state must not retain stale structured health');
  assert.ok(logs.some(entry => entry.source === 'openai-tunnel'));

  operational = false;
  controlPlaneDegraded = true;
  const degradedStartupRuntime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: fetchTunnel,
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    monitorIntervalMs: 10,
    degradedFailureThreshold: 2
  });
  const degradedStartup = await degradedStartupRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-degraded-startup-123456', timeoutMs: 1000 });
  const degradedStartupChild = spawned.child;
  assert.equal(degradedStartup.state, 'degraded', 'a live client still in remote routing/backoff after the startup window must stay owned instead of being killed');
  assert.equal(degradedStartup.recoveryMode, 'in_place');
  assert.equal(degradedStartupChild.exitCode, null);
  operational = true;
  controlPlaneDegraded = false;
  await waitFor(() => degradedStartupRuntime.snapshot().state === 'running');
  await degradedStartupRuntime.stop();

  const inPlaceRuntime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: fetchTunnel,
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    monitorIntervalMs: 10,
    degradedFailureThreshold: 2,
    failedFailureThreshold: 4,
    failedOutageTimeoutMs: 50
  });
  await inPlaceRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-in-place-123456', timeoutMs: 1000 });
  const inPlaceChild = spawned.child;
  operational = false;
  controlPlaneDegraded = true;
  await waitFor(() => inPlaceRuntime.snapshot().state === 'degraded' && inPlaceRuntime.snapshot().recoveryMode === 'in_place');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(inPlaceRuntime.snapshot().state, 'degraded', 'remote routing/backoff may outlive the old outage timeout without forcing a restart');
  assert.equal(inPlaceChild.exitCode, null, 'remote degradation must preserve tunnel-client in-memory routing state');
  operational = true;
  controlPlaneDegraded = false;
  await waitFor(() => inPlaceRuntime.snapshot().state === 'running');
  await inPlaceRuntime.stop();

  const localFailureRuntime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: fetchTunnel,
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    monitorIntervalMs: 10,
    degradedFailureThreshold: 2,
    failedFailureThreshold: 1000,
    failedOutageTimeoutMs: 50
  });
  await localFailureRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-local-failure-123456', timeoutMs: 1000 });
  const localFailureChild = spawned.child;
  localAlive = false;
  await waitFor(() => localFailureRuntime.snapshot().state === 'failed');
  assert.equal(localFailureRuntime.snapshot().errorCode, 'tunnel_connection_interrupted');
  assert.equal(localFailureRuntime.snapshot().recoveryMode, 'restart');
  assert.equal(localFailureChild.exitCode, 0, 'failed local liveness must still terminate the child for canonical restart recovery');
  assert.ok(localFailureRuntime.snapshot().consecutiveFailures < 1000,
    'local liveness failure escalation must remain bounded by elapsed outage time');
  localAlive = true;

  const boundedStopRuntime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: fetchTunnel,
    stopProcess: () => new Promise(() => {}),
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    stopProcessTimeoutMs: 50
  });
  await boundedStopRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-bounded-stop-123456', timeoutMs: 1000 });
  const boundedStopChild = spawned.child;
  const boundedStopStartedAt = Date.now();
  const boundedStopResult = await boundedStopRuntime.stop();
  assert.ok(Date.now() - boundedStopStartedAt < 500, 'tunnel shutdown must not wait indefinitely for an unresponsive process supervisor');
  assert.equal(boundedStopResult.stopped, false);
  assert.equal(boundedStopResult.forced, true);
  assert.equal(boundedStopChild.killedWith, 'SIGKILL', 'stop timeout must make a final direct termination attempt');
  assert.equal(boundedStopRuntime.snapshot().state, 'stopped');

  let stopAttempt = 0;
  let failNextStop = false;
  let unconfirmedChild;
  const unconfirmedRuntime = createSecureTunnelRuntime({
    spawnImpl(...args) {
      unconfirmedChild = fakeSpawn(...args);
      unconfirmedChild.kill = () => false;
      return unconfirmedChild;
    },
    fetchImpl: fetchTunnel,
    stopProcess: async child => {
      stopAttempt += 1;
      if (stopAttempt === 1 || failNextStop) {
        failNextStop = false;
        return { exited: false, forced: true, error: 'fixture termination not confirmed' };
      }
      child.exitCode = 0;
      return { exited: true, forced: false };
    },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir: path.join(stateDir, 'unconfirmed-stop')
  });
  const fixtureConfig = { tunnelId: 'tunnel_example123456', port: 3333, localToken: 'fixture-token', apiKey: 'fixture-key', timeoutMs: 1000 };
  await unconfirmedRuntime.start(fixtureConfig);
  try {
    const failedStop = await unconfirmedRuntime.stop();
    assert.equal(failedStop.stopped, false, 'unconfirmed exit must not report a successful stop');
    assert.equal(unconfirmedRuntime.snapshot().processOwned, true, 'failed termination must retain process ownership');
    assert.equal(unconfirmedRuntime.snapshot().state, 'failed');
    await assert.rejects(() => unconfirmedRuntime.start(fixtureConfig), /already running/, 'unknown live child must block a duplicate start');
    const retryStop = await unconfirmedRuntime.stop();
    assert.equal(retryStop.exited, true);
    assert.equal(stopAttempt, 2, 'repeat stop must retry the same owned process');
    assert.equal(unconfirmedRuntime.snapshot().processOwned, false);
    assert.equal(unconfirmedRuntime.snapshot().state, 'stopped');
    assert.equal(unconfirmedRuntime.snapshot().errorCode, '', 'a confirmed retry must clear the terminal stop error');
    const previousChild = unconfirmedChild;
    await unconfirmedRuntime.start(fixtureConfig);
    previousChild.emit('exit', 0, null);
    assert.equal(unconfirmedRuntime.snapshot().processOwned, true, 'late exit of the old child must not clear its replacement');
    assert.equal(unconfirmedChild.exitCode, null);
    await unconfirmedRuntime.stop();
    await unconfirmedRuntime.start(fixtureConfig);
    failNextStop = true;
    assert.equal((await unconfirmedRuntime.stop()).stopped, false);
    assert.equal(unconfirmedRuntime.snapshot().errorCode, 'secure_tunnel_stop_failed');
    unconfirmedChild.exitCode = 0;
    unconfirmedChild.emit('exit', 0, null);
    assert.equal(unconfirmedRuntime.snapshot().processOwned, false);
    assert.equal(unconfirmedRuntime.snapshot().state, 'stopped', 'the matching late exit must complete an explicit stop');
    assert.equal(unconfirmedRuntime.snapshot().errorCode, '', 'confirmed late exit must clear the terminal stop error');
    await unconfirmedRuntime.start(fixtureConfig);
    await unconfirmedRuntime.stop();
  } finally {
    unconfirmedChild.exitCode = 0;
    await unconfirmedRuntime.stop();
  }

  let releaseHealthProbe;
  let beginHealthProbe;
  const healthProbeStarted = new Promise(resolve => { beginHealthProbe = resolve; });
  const healthProbeResult = new Promise(resolve => { releaseHealthProbe = resolve; });
  let deferHealth = false;
  const staleProbeRuntime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: url => {
      if (deferHealth && url.endsWith('/healthz')) {
        beginHealthProbe();
        return healthProbeResult;
      }
      return fetchTunnel(url);
    },
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir: path.join(stateDir, 'stale-probe'),
    monitorIntervalMs: 50,
    degradedFailureThreshold: 1
  });
  await staleProbeRuntime.start(fixtureConfig);
  deferHealth = true;
  await healthProbeStarted;
  await staleProbeRuntime.stop();
  deferHealth = false;
  await staleProbeRuntime.start(fixtureConfig);
  deliveryDegraded = true;
  releaseHealthProbe(response(200));
  await new Promise(resolve => setImmediate(resolve));
  deliveryDegraded = false;
  try {
    assert.equal(staleProbeRuntime.snapshot().state, 'running', 'a late old health probe must never corrupt a replacement tunnel');
  } finally { await staleProbeRuntime.stop(); }

  let authChild = null;
  let authStopped = false;
  const authRuntime = createSecureTunnelRuntime({
    spawnImpl(executable, args, options) {
      authChild = fakeSpawn(executable, args, options);
      setImmediate(() => authChild.stderr.emit('data', '{"level":"ERROR","msg":"request failed","component":"controlplane","status_code":401}'));
      return authChild;
    },
    fetchImpl: async url => url.endsWith('/healthz') ? response(200) : response(503),
    stopProcess: async child => { authStopped = child === authChild; child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    monitorIntervalMs: 10
  });
  await assert.rejects(
    () => authRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-rejected-123456789', timeoutMs: 1000 }),
    error => error.code === 'tunnel_authentication_failed'
  );
  assert.equal(authRuntime.snapshot().state, 'failed');
  assert.equal(authRuntime.snapshot().errorCode, 'tunnel_authentication_failed');
  assert.equal(authStopped, true, 'authoritative authentication failure must stop endless tunnel retries');

  let statusOnlyChild = null;
  const statusOnlyRuntime = createSecureTunnelRuntime({
    spawnImpl(executable, args, options) {
      statusOnlyChild = fakeSpawn(executable, args, options);
      return statusOnlyChild;
    },
    fetchImpl: async url => {
      if (url.endsWith('/healthz') || url.endsWith('/readyz')) return response(200);
      if (url.endsWith('/api/status')) return response(401);
      return response(404);
    },
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir
  });
  await assert.rejects(
    () => statusOnlyRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-rejected-status-123456', timeoutMs: 1000 }),
    error => error.code === 'tunnel_authentication_failed'
  );
  assert.equal(statusOnlyRuntime.snapshot().errorCode, 'tunnel_authentication_failed', 'admin status must classify 401 even if no matching log event arrives');

  let revoked = false;
  let revokedChild = null;
  let revokedStopped = false;
  const revokedRuntime = createSecureTunnelRuntime({
    spawnImpl(executable, args, options) {
      revokedChild = fakeSpawn(executable, args, options);
      return revokedChild;
    },
    fetchImpl: async url => {
      if (url.endsWith('/healthz') || url.endsWith('/readyz')) return response(200);
      if (url.endsWith('/api/status')) {
        return revoked
          ? response(401)
          : response(200, { tunnel_metadata: { id: 'tunnel_example123456' }, mcp_probe: { status: 'ok' } });
      }
      return response(404);
    },
    stopProcess: async child => { revokedStopped = child === revokedChild; child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir,
    monitorIntervalMs: 10
  });
  await revokedRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-revoked-later-123456', timeoutMs: 1000 });
  revoked = true;
  await waitFor(() => revokedRuntime.snapshot().state === 'failed');
  assert.equal(revokedRuntime.snapshot().errorCode, 'tunnel_authentication_failed');
  assert.equal(revokedStopped, true, 'a runtime key rejected after startup must stop the tunnel child instead of degrading forever');

  let doctorSpawned = null;
  const doctorRuntime = createSecureTunnelRuntime({
    spawnImpl(executable, args, options) {
      const doctorChild = new EventEmitter();
      doctorChild.stdout = new EventEmitter();
      doctorChild.stderr = new EventEmitter();
      doctorChild.exitCode = null;
      doctorSpawned = { executable, args, options, child: doctorChild };
      queueMicrotask(() => {
        doctorChild.stdout.emit('data', JSON.stringify({
          result: 'fail',
          failed_checks: ['mcp_server_reachable'],
          checks: [
            { id: 'config_source', status: 'PASS', summary: 'flags/environment only' },
            {
              id: 'mcp_server_reachable',
              status: 'FAIL',
              summary: 'Bearer local-secret api_key=sk-doctor-secret',
              why: 'The local MCP target could not be reached.',
              next: ['Start the local MCP service.']
            }
          ]
        }));
        doctorChild.exitCode = 2;
        doctorChild.emit('exit', 2, null);
      });
      return doctorChild;
    },
    fetchImpl: fetchTunnel,
    stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
    resolveExecutable: () => process.execPath,
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir
  });
  const diagnosis = await doctorRuntime.doctor({
    tunnelId: 'tunnel_example123456',
    port: 3333,
    localToken: 'local-secret',
    apiKey: 'sk-doctor-secret'
  });
  assert.equal(doctorSpawned.args[0], 'doctor');
  assert.ok(doctorSpawned.args.includes('--json'));
  assert.ok(doctorSpawned.args.includes('--explain'));
  assert.ok(doctorSpawned.args.includes('url=http://127.0.0.1:3333/mcp,channel=main'));
  assert.equal(doctorSpawned.options.env.CONTROL_PLANE_API_KEY, 'sk-doctor-secret');
  assert.equal(doctorSpawned.options.env.REL_AI_LOCAL_AUTH_HEADER, 'Bearer local-secret');
  assert.equal(diagnosis.ok, false, 'failed doctor checks must remain a completed diagnostic result rather than a spawn failure');
  assert.equal(diagnosis.exitCode, 2);
  assert.deepEqual(diagnosis.failedChecks, ['mcp_server_reachable']);
  assert.equal(diagnosis.checks.find(check => check.id === 'mcp_server_reachable')?.status, 'FAIL');
  assert.doesNotMatch(JSON.stringify(diagnosis), /local-secret|sk-doctor-secret/, 'doctor results must redact tunnel credentials before reaching the renderer');


  {
    const { mock } = await import('node:test');
    let markSpawned;
    const didSpawn = new Promise(resolve => { markSpawned = resolve; });
    const hungDoctor = new EventEmitter();
    hungDoctor.stdout = new EventEmitter();
    hungDoctor.stderr = new EventEmitter();
    hungDoctor.exitCode = null;
    hungDoctor.kill = signal => { hungDoctor.killedWith = signal; return true; };
    const boundedDoctor = createSecureTunnelRuntime({
      spawnImpl: () => { markSpawned(); return hungDoctor; },
      fetchImpl: fetchTunnel,
      stopProcess: () => new Promise(() => {}),
      stopProcessTimeoutMs: 50,
      resolveExecutable: () => process.execPath,
      makeEnvironment: makeTunnelProcessEnvironment,
      stateDir
    });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const result = boundedDoctor.doctor({
        tunnelId: 'tunnel_example123456', port: 3333,
        localToken: 'local-fixture', apiKey: 'synthetic-doctor-key', timeoutMs: 1000
      });
      const rejected = assert.rejects(result, /doctor timed out after 1 seconds/);
      await didSpawn;
      mock.timers.tick(1000);
      mock.timers.tick(50);
      await rejected;
      assert.equal(hungDoctor.killedWith, 'SIGKILL', 'the existing termination watchdog must attempt final cleanup');
      assert.equal(hungDoctor.exitCode, null, 'a timeout result must not invent confirmation that the fake child exited');
    } finally {
      mock.timers.reset();
    }
  }

  const unavailableRuntime = createSecureTunnelRuntime({
    spawnImpl: fakeSpawn,
    fetchImpl: fetchTunnel,
    stopProcess: async () => ({ exited: true, forced: false }),
    resolveExecutable: () => '',
    makeEnvironment: makeTunnelProcessEnvironment,
    stateDir
  });
  await assert.rejects(
    () => unavailableRuntime.start({ tunnelId: 'tunnel_example123456', port: 3333, localToken: 'local-secret', apiKey: 'sk-runtime-missing-client-123456', timeoutMs: 1000 }),
    error => error.code === 'tunnel_runtime_unavailable'
  );
  assert.equal(unavailableRuntime.snapshot().state, 'failed');
  assert.equal(unavailableRuntime.snapshot().errorCode, 'tunnel_runtime_unavailable', 'missing local tunnel runtime must be terminal instead of entering automatic reconnect');


  for (const startReplacement of [false, true]) {
    let releaseExecutable;
    const executableReady = new Promise(resolve => { releaseExecutable = resolve; });
    let resolveCalls = 0;
    let spawnCalls = 0;
    let replacementChild = null;
    const cancelledStartupRuntime = createSecureTunnelRuntime({
      spawnImpl(executable, args, options) {
        spawnCalls += 1;
        replacementChild = fakeSpawn(executable, args, options);
        return replacementChild;
      },
      fetchImpl: fetchTunnel,
      stopProcess: async child => { child.exitCode = 0; return { exited: true, forced: false }; },
      resolveExecutable: () => ++resolveCalls === 1 ? executableReady : process.execPath,
      makeEnvironment: makeTunnelProcessEnvironment,
      stateDir: path.join(stateDir, startReplacement ? 'cancel-replace' : 'cancel-stop')
    });
    const cancelledStart = cancelledStartupRuntime.start({
      tunnelId: 'tunnel_example123456', port: 3333,
      localToken: 'local-secret', apiKey: 'test-cancelled-start', timeoutMs: 1000
    });
    const cancelledStop = await cancelledStartupRuntime.stop();
    assert.equal(cancelledStop.exited, true);
    assert.equal(spawnCalls, 0, 'stopping during executable resolution must happen before any child exists');
    try {
      if (startReplacement) {
        await cancelledStartupRuntime.start({
          tunnelId: 'tunnel_example123456', port: 3333,
          localToken: 'local-secret', apiKey: 'test-replacement-start', timeoutMs: 1000
        });
      }
      releaseExecutable(process.execPath);
      const cancelledResult = await cancelledStart;
      assert.equal(cancelledResult.cancelled, true);
      assert.equal(spawnCalls, startReplacement ? 1 : 0,
        'a cancelled preparation must never spawn after stop or duplicate a replacement');
      assert.equal(cancelledStartupRuntime.snapshot().state, startReplacement ? 'running' : 'stopped');
      assert.equal(cancelledStartupRuntime.snapshot().processOwned, startReplacement);
      if (startReplacement) assert.equal(replacementChild.exitCode, null,
        'late cancelled startup must not terminate the replacement child');
    } finally {
      releaseExecutable(process.execPath);
      await cancelledStartupRuntime.stop();
      await cancelledStart;
      const attemptDir = path.join(stateDir, startReplacement ? 'cancel-replace' : 'cancel-stop');
      const remaining = fs.existsSync(attemptDir) ? fs.readdirSync(attemptDir) : [];
      assert.equal(remaining.filter(name => name.endsWith('.url')).length, 0, 'stopped attempts must not leave per-generation health files');
    }
  }

  console.log('secure-tunnel-runtime-unit: ok');
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

function response(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for secure tunnel state transition.');
}
