import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveResourcePath } from './resource-path.js';
import { createTunnelLogParser } from './tunnel-log-parser.js';
import { sanitizeDiagnosticValue, sanitizeText } from '../src/diagnostics.js';
import { assertTunnelLifecycleTransition } from '../src/runtimeLifecycle.js';

const START_TIMEOUT_MS = 30_000;
const DOCTOR_TIMEOUT_MS = 15_000;
const DOCTOR_MAX_OUTPUT_BYTES = 128 * 1024;
const START_POLL_MS = 200;
const HEALTH_REQUEST_TIMEOUT_MS = 1_500;
const MONITOR_INTERVAL_MS = 2_000;
const DEGRADED_FAILURE_THRESHOLD = 3;
const FAILED_FAILURE_THRESHOLD = 30;
const FAILED_OUTAGE_TIMEOUT_MS = 30_000;
const STOP_PROCESS_TIMEOUT_MS = 5_000;
const TUNNEL_RUNTIME_UNAVAILABLE_CODE = 'tunnel_runtime_unavailable';
const FATAL_TUNNEL_CODES = new Set([
  'tunnel_authentication_failed',
  'tunnel_access_denied',
  'tunnel_not_found',
  TUNNEL_RUNTIME_UNAVAILABLE_CODE
]);
const TRANSPORT_FAILURE_CODES = new Set([
  'tunnel_response_deadline',
  'tunnel_upstream_5xx'
]);

function createSecureTunnelRuntime({
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  stopProcess,
  resolveExecutable = bundledTunnelClientPath,
  makeEnvironment,
  stateDir = process.env.REL_AI_MCP_STATE_DIR || path.join(os.homedir(), '.rel-ai-mcp'),
  onLog = () => {},
  onStatus = () => {},
  monitorIntervalMs = MONITOR_INTERVAL_MS,
  degradedFailureThreshold = DEGRADED_FAILURE_THRESHOLD,
  failedFailureThreshold = FAILED_FAILURE_THRESHOLD,
  failedOutageTimeoutMs = FAILED_OUTAGE_TIMEOUT_MS,
  stopProcessTimeoutMs = STOP_PROCESS_TIMEOUT_MS
} = {}) {
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
  if (typeof stopProcess !== 'function') throw new TypeError('stopProcess is required.');
  if (typeof resolveExecutable !== 'function') throw new TypeError('resolveExecutable is required.');
  if (typeof makeEnvironment !== 'function') throw new TypeError('makeEnvironment is required.');
  if (typeof onLog !== 'function' || typeof onStatus !== 'function') throw new TypeError('Tunnel callbacks must be functions.');

  let child = null;
  let generation = 0;
  let stopping = false;
  let monitorPromise = null;
  let transportFailureStreak = 0;
  const monitorDelayMs = Math.max(50, Number(monitorIntervalMs || MONITOR_INTERVAL_MS));
  const degradedAfterFailures = Math.max(1, Math.floor(Number(degradedFailureThreshold || DEGRADED_FAILURE_THRESHOLD)));
  const failedAfterFailures = Math.max(degradedAfterFailures + 1, Math.floor(Number(failedFailureThreshold || FAILED_FAILURE_THRESHOLD)));
  const failedAfterMs = Math.max(50, Number(failedOutageTimeoutMs || FAILED_OUTAGE_TIMEOUT_MS));
  const stopTimeoutMs = Math.max(50, Number(stopProcessTimeoutMs || STOP_PROCESS_TIMEOUT_MS));
  let state = freezeState({
    state: 'stopped',
    tunnelId: '',
    healthUrl: '',
    error: '',
    errorCode: '',
    lastConnectedAt: null,
    consecutiveFailures: 0,
    transportFailureStreak: 0,
    outageStartedAt: null
  });

  async function start(config = {}) {
    if (child && child.exitCode === null) throw new Error('OpenAI Secure MCP Tunnel is already running.');
    const tunnelId = normalizeTunnelId(config.tunnelId);
    const apiKey = normalizeRequiredSecret(config.apiKey, 'OpenAI tunnel runtime API key');
    const localToken = normalizeRequiredSecret(config.localToken, 'Rel.AI local bearer token');
    const port = normalizePort(config.port);
    const runGeneration = ++generation;
    stopping = false;
    transportFailureStreak = 0;
    update({ state: 'starting', tunnelId, healthUrl: '', error: '', errorCode: '', consecutiveFailures: 0, transportFailureStreak: 0, outageStartedAt: null });

    let executable;
    try {
      executable = await resolveExecutable();
      if (!executable) throw new Error('Bundled OpenAI tunnel-client is missing. Fetch and verify vendor/tunnel-client before starting Rel.AI.');
      await ensureExecutable(executable);
    } catch (error) {
      const failure = tunnelFailure(TUNNEL_RUNTIME_UNAVAILABLE_CODE, messageOf(error));
      if (runGeneration === generation) update({ state: 'failed', tunnelId, healthUrl: '', error: failure.message, errorCode: failure.code });
      throw failure;
    }

    const healthUrlFile = path.join(path.resolve(stateDir), `tunnel-health-${process.pid}.url`);
    await fs.promises.mkdir(path.dirname(healthUrlFile), { recursive: true, mode: 0o700 });
    await fs.promises.rm(healthUrlFile, { force: true });

    const args = [
      ...tunnelConnectionArgs('run', tunnelId, port),
      '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', healthUrlFile,
      '--log.format', 'json',
      '--log.level', 'info'
    ];

    onLog({
      level: 'info',
      source: 'openai-tunnel',
      component: 'runtime',
      message: `Starting OpenAI Secure MCP Tunnel ${tunnelId} for the local MCP service.`
    });

    let ownedChild = null;
    let fatalFailure = null;
    let fatalStopPromise = null;
    const acceptLogEntry = entry => {
      onLog(entry);
      if (TRANSPORT_FAILURE_CODES.has(entry.code) && runGeneration === generation) {
        transportFailureStreak += 1;
        if (transportFailureStreak >= degradedAfterFailures && ['running', 'degraded'].includes(state.state)) {
          update({
            state: 'degraded',
            tunnelId,
            healthUrl: state.healthUrl,
            errorCode: 'tunnel_command_delivery_degraded',
            error: 'Tunnel command responses are repeatedly failing to reach the control plane. Rel.AI will recover the secure tunnel automatically.',
            transportFailureStreak
          });
        } else if (state.transportFailureStreak !== transportFailureStreak) {
          update({ transportFailureStreak });
        }
      }
      if (!FATAL_TUNNEL_CODES.has(entry.code) || fatalFailure || runGeneration !== generation) return;
      fatalFailure = tunnelFailure(entry.code, entry.message);
      update({
        state: 'failed',
        tunnelId,
        error: fatalFailure.message,
        errorCode: fatalFailure.code,
        consecutiveFailures: 0,
        transportFailureStreak,
        outageStartedAt: null
      });
      if (ownedChild && ownedChild.exitCode === null) {
        fatalStopPromise = stopOwnedProcess(ownedChild, { graceMs: 1000, forceWaitMs: 2000 })
          .catch(() => ({ exited: false, forced: false }))
          .finally(() => {
            if (child === ownedChild) child = null;
          });
      }
    };

    try {
      ownedChild = spawnImpl(executable, args, {
        cwd: path.dirname(healthUrlFile),
        env: makeEnvironment({
          CONTROL_PLANE_API_KEY: apiKey,
          REL_AI_LOCAL_AUTH_HEADER: `Bearer ${localToken}`
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      const failure = tunnelFailure(TUNNEL_RUNTIME_UNAVAILABLE_CODE, messageOf(error));
      update({ state: 'failed', tunnelId, error: failure.message, errorCode: failure.code });
      throw failure;
    }

    child = ownedChild;
    pipeTunnelLogs(ownedChild.stdout, acceptLogEntry, 'info');
    pipeTunnelLogs(ownedChild.stderr, acceptLogEntry, 'warning');
    ownedChild.once('error', error => {
      if (runGeneration !== generation) return;
      fatalFailure ||= tunnelFailure(TUNNEL_RUNTIME_UNAVAILABLE_CODE, messageOf(error));
      update({ state: 'failed', tunnelId, error: fatalFailure.message, errorCode: fatalFailure.code });
    });
    ownedChild.once('exit', (code, signal) => {
      if (runGeneration !== generation || child !== ownedChild) return;
      child = null;
      void fs.promises.rm(healthUrlFile, { force: true }).catch(() => {});
      if (stopping) {
        update({ state: 'stopped', tunnelId: '', healthUrl: '', error: '', errorCode: '', consecutiveFailures: 0, outageStartedAt: null });
        return;
      }
      if (state.state === 'failed') return;
      update({
        state: 'failed',
        tunnelId,
        healthUrl: '',
        errorCode: 'secure_tunnel_failed',
        error: `OpenAI tunnel-client exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`
      });
    });

    try {
      const operational = await waitForOperational({
        ownedChild,
        healthUrlFile,
        fetchImpl,
        tunnelId,
        timeoutMs: Number(config.timeoutMs || START_TIMEOUT_MS),
        getFatalFailure: () => fatalFailure,
        onPhase: (phase, healthUrl = '') => {
          if (runGeneration !== generation || child !== ownedChild || fatalFailure) return;
          update({ state: phase, tunnelId, healthUrl: healthUrl || state.healthUrl, error: '', errorCode: '' });
        }
      });
      if (fatalStopPromise) await fatalStopPromise;
      if (fatalFailure) throw fatalFailure;
      if (runGeneration !== generation || child !== ownedChild) return { cancelled: true, ...snapshot() };

      update({
        state: 'running',
        tunnelId,
        healthUrl: operational.healthUrl,
        error: '',
        errorCode: '',
        lastConnectedAt: Date.now(),
        consecutiveFailures: 0,
        transportFailureStreak,
        outageStartedAt: null
      });
      monitorPromise = monitorTunnel({
        runGeneration,
        ownedChild,
        tunnelId,
        healthUrl: operational.healthUrl,
        fetchImpl,
        getFatalFailure: () => fatalFailure
      });
      return { ok: true, process: ownedChild, ...snapshot() };
    } catch (error) {
      const failure = fatalFailure || normalizeTunnelFailure(error);
      if (runGeneration === generation) {
        if (fatalStopPromise) await fatalStopPromise;
        else if (ownedChild?.exitCode === null) await stopOwnedProcess(ownedChild, { graceMs: 1000, forceWaitMs: 2000 }).catch(() => {});
        if (child === ownedChild) child = null;
        await fs.promises.rm(healthUrlFile, { force: true }).catch(() => {});
        update({ state: 'failed', tunnelId, healthUrl: '', error: failure.message, errorCode: failure.code, consecutiveFailures: 0, outageStartedAt: null });
      }
      throw failure;
    }
  }

  async function monitorTunnel({ runGeneration, ownedChild, tunnelId, healthUrl, fetchImpl, getFatalFailure }) {
    let consecutiveFailures = 0;
    let outageStartedAt = 0;
    while (runGeneration === generation && child === ownedChild && ownedChild.exitCode === null && !stopping) {
      await delay(monitorDelayMs);
      if (runGeneration !== generation || child !== ownedChild || stopping) return;
      const fatalFailure = getFatalFailure();
      if (fatalFailure) return;

      let operational;
      try {
        operational = await tunnelOperationalSnapshot({ fetchImpl, healthUrl, tunnelId });
      } catch (error) {
        if (FATAL_TUNNEL_CODES.has(String(error?.code || ''))) {
          if (child === ownedChild) child = null;
          await stopOwnedProcess(ownedChild, { graceMs: 1000, forceWaitMs: 2000 }).catch(() => {});
          update({
            state: 'failed',
            tunnelId,
            healthUrl: '',
            error: messageOf(error),
            errorCode: error.code,
            consecutiveFailures: 0,
            outageStartedAt: null
          });
          return;
        }
        operational = { ok: false, error: messageOf(error) };
      }
      if (operational.ok) {
        consecutiveFailures = 0;
        outageStartedAt = 0;
        if (state.errorCode === 'tunnel_command_delivery_degraded') {
          if (state.consecutiveFailures !== 0 || state.outageStartedAt !== null) {
            update({ consecutiveFailures: 0, outageStartedAt: null });
          }
          continue;
        }
        if (state.state !== 'running') {
          update({
            state: 'running',
            tunnelId,
            healthUrl,
            error: '',
            errorCode: '',
            lastConnectedAt: Date.now(),
            consecutiveFailures: 0,
            outageStartedAt: null
          });
        }
        continue;
      }

      consecutiveFailures += 1;
      outageStartedAt ||= Date.now();
      if (consecutiveFailures >= failedAfterFailures || Date.now() - outageStartedAt >= failedAfterMs) {
        if (child === ownedChild) child = null;
        await stopOwnedProcess(ownedChild, { graceMs: 1000, forceWaitMs: 2000 }).catch(() => {});
        update({
          state: 'failed',
          tunnelId,
          healthUrl: '',
          errorCode: 'tunnel_connection_interrupted',
          error: 'Tunnel connectivity remained interrupted. Rel.AI will restart the secure tunnel automatically.',
          consecutiveFailures,
          outageStartedAt
        });
        return;
      }
      if (consecutiveFailures < degradedAfterFailures) continue;
      if (state.errorCode === 'tunnel_command_delivery_degraded') {
        update({ consecutiveFailures, outageStartedAt });
        continue;
      }
      update({
        state: 'degraded',
        tunnelId,
        healthUrl,
        errorCode: 'tunnel_connection_interrupted',
        error: 'Tunnel connectivity is interrupted. Rel.AI is retrying automatically.',
        consecutiveFailures,
        outageStartedAt
      });
    }
  }

  async function doctor(config = {}) {
    const tunnelId = normalizeTunnelId(config.tunnelId);
    const apiKey = normalizeRequiredSecret(config.apiKey, 'OpenAI tunnel runtime API key');
    const localToken = normalizeRequiredSecret(config.localToken, 'Rel.AI local bearer token');
    const port = normalizePort(config.port);
    let executable;
    try {
      executable = await resolveExecutable();
      if (!executable) throw new Error('Bundled OpenAI tunnel-client is missing. Fetch and verify vendor/tunnel-client before running diagnostics.');
      await ensureExecutable(executable);
    } catch (error) {
      throw tunnelFailure(TUNNEL_RUNTIME_UNAVAILABLE_CODE, messageOf(error));
    }

    const args = [
      ...tunnelConnectionArgs('doctor', tunnelId, port),
      '--health.listen-addr', '127.0.0.1:0',
      '--json',
      '--explain'
    ];
    const startedAt = Date.now();
    let doctorChild;
    try {
      const doctorCwd = path.resolve(stateDir);
      await fs.promises.mkdir(doctorCwd, { recursive: true, mode: 0o700 });
      doctorChild = spawnImpl(executable, args, {
        cwd: doctorCwd,
        env: makeEnvironment({
          CONTROL_PLANE_API_KEY: apiKey,
          REL_AI_LOCAL_AUTH_HEADER: `Bearer ${localToken}`
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      throw tunnelFailure(TUNNEL_RUNTIME_UNAVAILABLE_CODE, messageOf(error));
    }

    const timeoutMs = Math.max(1_000, Math.min(30_000, Number(config.timeoutMs || DOCTOR_TIMEOUT_MS)));
    const completed = await collectDoctorOutput(doctorChild, {
      timeoutMs,
      maxBytes: DOCTOR_MAX_OUTPUT_BYTES,
      stopProcess
    });
    let parsed;
    try {
      parsed = JSON.parse(completed.stdout.trim());
    } catch {
      const detail = sanitizeText(completed.stderr || completed.stdout, 2_000);
      throw new Error(`OpenAI tunnel-client doctor returned invalid JSON${detail ? `: ${detail}` : '.'}`);
    }
    const sanitized = sanitizeDiagnosticValue(parsed);
    const checks = Array.isArray(sanitized?.checks) ? sanitized.checks : [];
    const failedChecks = Array.isArray(sanitized?.failed_checks)
      ? sanitized.failed_checks.map(value => String(value))
      : checks.filter(check => String(check?.status || '').toUpperCase() === 'FAIL').map(check => String(check?.id || '')).filter(Boolean);
    const result = String(sanitized?.result || (failedChecks.length ? 'fail' : 'unknown')).toLowerCase();
    return {
      ok: result === 'pass' && completed.exitCode === 0,
      result,
      exitCode: completed.exitCode,
      durationMs: Math.max(0, Date.now() - startedAt),
      failedChecks,
      checks,
      truncated: completed.truncated,
      rawOutput: sanitizeText([completed.stdout, completed.stderr].filter(Boolean).join('\n'), 64 * 1024)
    };
  }

  async function stop() {
    generation += 1;
    stopping = true;
    const ownedChild = child;
    child = null;
    if (!ownedChild) {
      transportFailureStreak = 0;
      update({ state: 'stopped', tunnelId: '', healthUrl: '', error: '', errorCode: '', consecutiveFailures: 0, transportFailureStreak: 0, outageStartedAt: null });
      return { stopped: true, exited: true, forced: false };
    }
    let result;
    try {
      result = await stopOwnedProcess(ownedChild, { graceMs: 1000, forceWaitMs: 2000 });
    } catch (error) {
      if (monitorPromise) await Promise.race([monitorPromise, delay(100)]).catch(() => {});
      monitorPromise = null;
      transportFailureStreak = 0;
      update({ state: 'stopped', tunnelId: '', healthUrl: '', error: '', errorCode: '', consecutiveFailures: 0, transportFailureStreak: 0, outageStartedAt: null });
      return { stopped: false, exited: false, forced: true, error: messageOf(error) };
    }
    if (monitorPromise) await Promise.race([monitorPromise, delay(100)]).catch(() => {});
    monitorPromise = null;
    transportFailureStreak = 0;
    update({ state: 'stopped', tunnelId: '', healthUrl: '', error: '', errorCode: '', consecutiveFailures: 0, transportFailureStreak: 0, outageStartedAt: null });
    return { stopped: true, ...result };
  }

  function snapshot() {
    return { ...state, processOwned: Boolean(child && child.exitCode === null) };
  }

  async function stopOwnedProcess(ownedChild, stopOptions) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve(stopProcess(ownedChild, stopOptions)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `OpenAI tunnel-client did not stop within ${Math.round(stopTimeoutMs / 100) / 10} seconds.`
          )), stopTimeoutMs);
        })
      ]);
    } catch (error) {
      try { ownedChild?.kill?.('SIGKILL'); } catch {}
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function update(patch) {
    const nextState = patch.state === undefined
      ? state.state
      : assertTunnelLifecycleTransition(state.state, patch.state);
    state = freezeState({ ...state, ...patch, state: nextState });
    onStatus(snapshot());
  }

  return Object.freeze({ start, doctor, stop, snapshot });
}

function tunnelConnectionArgs(command, tunnelId, port) {
  return [
    command,
    '--control-plane.tunnel-id', tunnelId,
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--mcp.server-url', `url=http://127.0.0.1:${port}/mcp,channel=main`,
    '--mcp.extra-headers', 'Authorization: env:REL_AI_LOCAL_AUTH_HEADER',
    '--mcp.discovery-extra-headers', 'Authorization: env:REL_AI_LOCAL_AUTH_HEADER'
  ];
}

function collectDoctorOutput(child, { timeoutMs, maxBytes, stopProcess }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let capturedBytes = 0;
    let truncated = false;
    let settled = false;
    let timer = null;
    const append = (current, chunk) => {
      if (capturedBytes >= maxBytes) {
        truncated = true;
        return current;
      }
      const text = String(chunk ?? '');
      const remaining = maxBytes - capturedBytes;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes <= remaining) {
        capturedBytes += bytes;
        return current + text;
      }
      truncated = true;
      const clipped = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
      capturedBytes += Buffer.byteLength(clipped, 'utf8');
      return current + clipped;
    };
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    const finish = callback => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
      return true;
    };
    child.once('error', error => finish(() => reject(error)));
    child.once('exit', (code, signal) => finish(() => resolve({
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      stdout,
      stderr,
      truncated
    })));
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void Promise.resolve(stopProcess(child, { graceMs: 500, forceWaitMs: 1_500 })).catch(() => {}).finally(() => {
        reject(new Error(`OpenAI tunnel-client doctor timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function waitForOperational({ ownedChild, healthUrlFile, fetchImpl, tunnelId, timeoutMs, getFatalFailure, onPhase }) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let healthUrl = '';
  let localReadyAnnounced = false;
  let authenticatingAnnounced = false;
  let lastError = '';
  while (Date.now() < deadline) {
    const fatalFailure = getFatalFailure();
    if (fatalFailure) throw fatalFailure;
    if (ownedChild.exitCode !== null) throw new Error(`OpenAI tunnel-client exited before becoming ready (code=${ownedChild.exitCode}).`);

    if (!healthUrl) {
      try { healthUrl = normalizeHealthUrl(await fs.promises.readFile(healthUrlFile, 'utf8')); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error; }
    }
    if (healthUrl) {
      const live = await probeUrl(fetchImpl, `${healthUrl}/healthz`);
      if (live.ok && !localReadyAnnounced) {
        localReadyAnnounced = true;
        onPhase('locally_ready', healthUrl);
      }
      if (live.ok && !authenticatingAnnounced) {
        authenticatingAnnounced = true;
        onPhase('authenticating', healthUrl);
      }
      if (live.ok) {
        const operational = await tunnelOperationalSnapshot({ fetchImpl, healthUrl, tunnelId });
        if (operational.ok) return { healthUrl, status: operational.status };
        lastError = operational.error || lastError;
      } else {
        lastError = live.error || lastError;
      }
    }
    await delay(START_POLL_MS);
  }
  throw new Error(`OpenAI Secure MCP Tunnel did not become ready within ${Math.round(timeoutMs / 1000)} seconds${lastError ? `: ${lastError}` : '.'}`);
}

async function tunnelOperationalSnapshot({ fetchImpl, healthUrl, tunnelId }) {
  const [ready, admin] = await Promise.all([
    probeUrl(fetchImpl, `${healthUrl}/readyz`),
    readTunnelAdminStatus(fetchImpl, healthUrl)
  ]);
  if (!ready.ok) return { ok: false, error: ready.error || `readyz returned HTTP ${ready.status || 0}` };
  if (!admin.ok) {
    if (admin.status === 401) throw tunnelFailure('tunnel_authentication_failed', 'OpenAI rejected the tunnel runtime API key.');
    if (admin.status === 403) throw tunnelFailure('tunnel_access_denied', 'OpenAI denied this runtime key access to the configured Secure MCP Tunnel.');
    if (admin.status === 404) throw tunnelFailure('tunnel_not_found', 'OpenAI could not find the configured Secure MCP Tunnel.');
    return { ok: false, error: admin.error || `status returned HTTP ${admin.status || 0}` };
  }
  const observedTunnelId = tunnelIdFromStatus(admin.value);
  if (observedTunnelId && observedTunnelId !== tunnelId) {
    throw tunnelFailure('tunnel_not_found', `Tunnel-client reported ${observedTunnelId}, but Rel.AI is configured for ${tunnelId}.`);
  }
  if (!observedTunnelId) return { ok: false, error: 'Tunnel metadata is not available yet.' };
  if (mcpProbeFailed(admin.value)) return { ok: false, error: 'The local MCP startup probe is not ready yet.' };
  return { ok: true, status: admin.value };
}

async function readTunnelAdminStatus(fetchImpl, healthUrl) {
  try {
    const response = await fetchImpl(`${healthUrl}/api/status`, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
    if (!response?.ok) return { ok: false, status: Number(response?.status || 0), error: `status returned HTTP ${response?.status || 0}` };
    if (typeof response.json !== 'function') return { ok: false, status: Number(response?.status || 0), error: 'status response was not JSON.' };
    const value = await response.json();
    return value && typeof value === 'object' ? { ok: true, status: Number(response.status || 200), value } : { ok: false, error: 'status response was empty.' };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

async function probeUrl(fetchImpl, url) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
    return response?.ok
      ? { ok: true, status: Number(response.status || 200) }
      : { ok: false, status: Number(response?.status || 0), error: `${new URL(url).pathname} returned HTTP ${response?.status || 0}` };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function tunnelIdFromStatus(status = {}) {
  const metadata = status.tunnel_metadata || status.tunnelMetadata || status.tunnel || {};
  return String(
    metadata.ID || metadata.id || metadata.tunnel_id || metadata.tunnelId
    || status.tunnel_id || status.tunnelId || ''
  ).trim();
}

function mcpProbeFailed(status = {}) {
  const candidates = [
    status.mcp_probe,
    status.mcpProbe,
    status.mcp?.probe,
    status.probe,
    status.routes?.main?.probe
  ].filter(value => value && typeof value === 'object');
  for (const probe of candidates) {
    const state = String(probe.status || probe.state || '').toLowerCase();
    if (['failed', 'error', 'unhealthy'].includes(state)) return true;
    if (probe.ok === false || probe.ready === false) return true;
  }
  return false;
}

async function bundledTunnelClientPath() {
  const platform = process.platform;
  const fileName = platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client';
  const candidates = [
    resolveResourcePath(path.join('bin', 'tunnel-client', platform, fileName)),
    resolveResourcePath(path.join('vendor', 'tunnel-client', platform, fileName))
  ];
  for (const candidate of candidates) {
    try { await fs.promises.access(candidate); return candidate; } catch {}
  }
  return '';
}

function normalizeTunnelId(value) {
  const text = String(value || '').trim();
  if (!/^tunnel_[A-Za-z0-9_-]{8,200}$/.test(text)) throw new Error('OpenAI Secure MCP Tunnel ID must start with tunnel_.');
  return text;
}

function normalizePort(value) {
  const port = Number(value || 3333);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Connection port must be between 1024 and 65535.');
  return port;
}

function normalizeRequiredSecret(value, label) {
  const text = String(value || '').trim();
  if (!text || text.length > 4096 || /[\r\n\0]/.test(text)) throw new Error(`${label} is missing or invalid.`);
  return text;
}

function normalizeHealthUrl(value) {
  const text = String(value || '').trim().replace(/\/$/, '');
  const url = new URL(text);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('OpenAI tunnel-client health URL must be loopback HTTP.');
  }
  return url.origin;
}

async function ensureExecutable(file) {
  if (process.platform === 'win32') return;
  try { await fs.promises.chmod(file, 0o700); } catch {}
}

function pipeTunnelLogs(stream, onEntry, defaultLevel) {
  const parser = createTunnelLogParser({ onEntry, defaultLevel });
  stream?.on?.('data', chunk => parser.write(chunk));
  stream?.once?.('end', () => parser.flush());
  stream?.once?.('close', () => parser.flush());
}

function tunnelFailure(code, message) {
  const error = new Error(String(message || 'OpenAI Secure MCP Tunnel failed.'));
  error.code = code || 'secure_tunnel_failed';
  return error;
}

function normalizeTunnelFailure(error) {
  if (error?.code && typeof error.code === 'string') return error;
  return tunnelFailure('secure_tunnel_failed', messageOf(error));
}

function freezeState(value) {
  return Object.freeze({ ...value });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown tunnel error');
}

export { createSecureTunnelRuntime };
