import pRetry from 'p-retry';

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
const TERMINAL_TUNNEL_CODES = new Set([
  'tunnel_authentication_failed',
  'tunnel_access_denied',
  'tunnel_not_found',
  'tunnel_runtime_unavailable'
]);

function createTunnelRecoverySupervisor({
  restartConnection,
  onSchedule = () => {},
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (typeof restartConnection !== 'function') throw new TypeError('restartConnection is required.');
  if (typeof onSchedule !== 'function') throw new TypeError('onSchedule must be a function.');

  const delays = normalizeRetryDelays(retryDelaysMs);
  let retryTimer = null;
  let releaseRetryDelay = null;
  let recoveryPromise = null;
  let attemptInFlight = false;
  let attempt = 0;
  let nextRetryAt = null;
  let recoveryGeneration = 0;

  function observe(status = {}) {
    const tunnelStatus = String(status.state || status.tunnelStatus || '');
    const errorCode = String(status.errorCode || '');
    if (tunnelStatus === 'running') {
      reset(true);
      return snapshot();
    }
    if (tunnelStatus === 'degraded') {
      if (String(status.recoveryMode || status.tunnelRecoveryMode || '') === 'in_place') {
        reset(true);
        return snapshot();
      }
      scheduleInitial(status.error || 'The Secure MCP Tunnel is degraded.');
      return snapshot();
    }
    if (tunnelStatus === 'failed') {
      if (isTerminalTunnelCode(errorCode)) {
        reset(true);
        return snapshot();
      }
      scheduleInitial(status.error || 'The Secure MCP Tunnel stopped unexpectedly.');
      return snapshot();
    }
    if (tunnelStatus === 'stopped' && !attemptInFlight) reset(true);
    return snapshot();
  }

  function scheduleInitial(lastError = '') {
    if (retryTimer || attemptInFlight) return snapshot();
    const runGeneration = recoveryGeneration;
    scheduleDelay(lastError).then(shouldRun => {
      if (!shouldRun || runGeneration !== recoveryGeneration) return;
      void runRecovery(runGeneration);
    });
    return snapshot();
  }

  function retryNow() {
    clearScheduledRetry();
    attempt = 0;
    if (attemptInFlight && recoveryPromise) return recoveryPromise;
    const runGeneration = recoveryGeneration;
    return runRecovery(runGeneration);
  }

  function runRecovery(runGeneration = recoveryGeneration) {
    if (recoveryPromise && runGeneration === recoveryGeneration) return recoveryPromise;

    const pending = pRetry(async () => {
      if (runGeneration !== recoveryGeneration) return cancelledStatus();
      attemptInFlight = true;
      let status;
      try {
        status = await restartConnection();
      } catch (error) {
        status = {
          serverRunning: true,
          tunnelStatus: 'failed',
          errorCode: String(error?.code || 'secure_tunnel_failed'),
          error: error instanceof Error ? error.message : String(error || 'Secure MCP Tunnel retry failed.')
        };
      } finally {
        attemptInFlight = false;
      }

      if (runGeneration !== recoveryGeneration) return status;
      const tunnelStatus = String(status?.tunnelStatus || status?.state || '');
      const errorCode = String(status?.errorCode || '');
      const recoveryMode = String(status?.tunnelRecoveryMode || status?.recoveryMode || '');
      if (tunnelStatus === 'running' || (tunnelStatus === 'degraded' && recoveryMode === 'in_place') || isTerminalTunnelCode(errorCode) || status?.serverRunning === false) return status;
      throw new RetryableTunnelStatus(status);
    }, {
      retries: Infinity,
      minTimeout: 0,
      maxTimeout: 0,
      factor: 1,
      shouldRetry: ({ error }) => error instanceof RetryableTunnelStatus && runGeneration === recoveryGeneration,
      onFailedAttempt: async ({ error }) => {
        if (!(error instanceof RetryableTunnelStatus) || runGeneration !== recoveryGeneration) return;
        await scheduleDelay(error.status?.error || 'The Secure MCP Tunnel is still unavailable.');
      }
    }).then(status => {
      if (runGeneration === recoveryGeneration) reset();
      return status;
    }).catch(error => {
      if (runGeneration !== recoveryGeneration) {
        return error instanceof RetryableTunnelStatus ? error.status : cancelledStatus();
      }
      throw error;
    }).finally(() => {
      if (recoveryPromise === pending) recoveryPromise = null;
    });

    recoveryPromise = pending;
    return pending;
  }

  function scheduleDelay(lastError = '') {
    clearScheduledRetry();
    attempt += 1;
    const delayMs = delays[Math.min(attempt - 1, delays.length - 1)];
    nextRetryAt = now() + delayMs;
    onSchedule({ attempt, delayMs, nextRetryAt, lastError: String(lastError || '') });
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        retryTimer = null;
        releaseRetryDelay = null;
        nextRetryAt = null;
        resolve(value);
      };
      releaseRetryDelay = () => finish(false);
      retryTimer = setTimer(() => finish(true), delayMs);
      retryTimer?.unref?.();
    });
  }

  function cancel() {
    reset(true);
    return snapshot();
  }

  function reset(invalidateInFlight = false) {
    if (invalidateInFlight) recoveryGeneration += 1;
    clearScheduledRetry();
    attempt = 0;
    nextRetryAt = null;
  }

  function clearScheduledRetry() {
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    nextRetryAt = null;
    const release = releaseRetryDelay;
    releaseRetryDelay = null;
    release?.();
  }

  function snapshot() {
    return Object.freeze({
      attempt,
      nextRetryAt,
      scheduled: Boolean(retryTimer),
      inFlight: attemptInFlight
    });
  }

  return Object.freeze({ observe, retryNow, cancel, snapshot });
}

class RetryableTunnelStatus extends Error {
  constructor(status) {
    super(String(status?.error || 'Secure MCP Tunnel is still unavailable.'));
    this.status = status;
  }
}

function cancelledStatus() {
  return { serverRunning: true, tunnelStatus: 'cancelled', errorCode: '', error: '' };
}

function normalizeRetryDelays(values) {
  const delays = Array.isArray(values)
    ? values.map(Number).filter(value => Number.isFinite(value) && value >= 0)
    : [];
  return delays.length ? delays : [...DEFAULT_RETRY_DELAYS_MS];
}

function isTerminalTunnelCode(value) {
  return TERMINAL_TUNNEL_CODES.has(String(value || ''));
}

export { createTunnelRecoverySupervisor };
