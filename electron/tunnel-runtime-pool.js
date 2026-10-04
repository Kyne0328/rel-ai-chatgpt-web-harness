import { createTunnelRecoverySupervisor } from './tunnel-recovery-supervisor.js';

function createTunnelRuntimePool({
  createRuntime,
  runtimeOptions = {},
  onLog = () => {},
  onStatus = () => {}
} = {}) {
  if (typeof createRuntime !== 'function') throw new TypeError('createRuntime is required.');
  if (typeof onLog !== 'function' || typeof onStatus !== 'function') throw new TypeError('Tunnel pool callbacks must be functions.');

  const runtimes = new Map();
  const statuses = new Map();
  let generation = 0;

  async function sync({ connections = [], port, localToken } = {}) {
    const syncGeneration = ++generation;
    const desiredById = new Map(connections.filter(connection => connection?.enabled !== false)
      .map(connection => [String(connection.tunnelId || '').trim(), connection]));
    const desired = [...desiredById.values()];

    await Promise.all([...runtimes.entries()].map(async ([tunnelId, entry]) => {
      const connection = desiredById.get(tunnelId);
      const nextConfig = connection && !connection.credentialError
        ? startConfigFor(connection, port, localToken)
        : null;
      if (!nextConfig || entry.stopPromise || entry.stopFailed || !sameStartConfig(entry.startConfig, nextConfig)) {
        await stopRuntime(tunnelId);
      }
    }));
    if (syncGeneration !== generation) return snapshot();

    let removedStaleStatus = false;
    for (const tunnelId of [...statuses.keys()]) {
      if (!desiredById.has(tunnelId) && !runtimes.has(tunnelId)) {
        statuses.delete(tunnelId);
        removedStaleStatus = true;
      }
    }
    if (removedStaleStatus) onStatus(snapshot());

    const results = await Promise.all(desired.map(async connection => {
      const tunnelId = String(connection.tunnelId || '').trim();
      const stoppingFailed = runtimes.get(tunnelId);
      if (stoppingFailed?.stopFailed) {
        const status = statuses.get(tunnelId);
        return { ok: false, tunnelId, status, error: status?.error || 'Tunnel termination could not be confirmed.' };
      }
      if (connection.credentialError) {
        const status = normalizeStatus(connection, {
          state: 'failed',
          error: 'This additional tunnel runtime key is unavailable or cannot be decrypted. Save its runtime API key again.',
          errorCode: 'additional_tunnel_credentials_unavailable'
        });
        statuses.set(tunnelId, status);
        onStatus(snapshot());
        return { ok: false, tunnelId, status, error: status.error };
      }

      const startConfig = startConfigFor(connection, port, localToken);
      const existing = runtimes.get(tunnelId);
      if (existing && !existing.stopPromise && sameStartConfig(existing.startConfig, startConfig)) {
        existing.connection = connection;
        const current = statuses.get(tunnelId) || existing.runtime.snapshot();
        const status = normalizeStatus(connection, {
          ...current,
          retry: existing.supervisor?.snapshot?.() || current.retry || null
        });
        statuses.set(tunnelId, status);
        onStatus(snapshot());
        return {
          ok: status.state === 'running' || status.state === 'degraded',
          tunnelId,
          status
        };
      }

      return startRuntime({ connection, startConfig });
    }));

    const stopFailed = [...runtimes.values()].some(entry => entry.stopFailed);
    return {
      ...snapshot(),
      results,
      ...(stopFailed ? { error: 'A tunnel process could not be stopped. Stop Rel.AI and retry before changing the connection again.' } : {})
    };
  }

  async function startRuntime({ connection, startConfig }) {
    const tunnelId = startConfig.tunnelId;
    const entry = {
      connection,
      startConfig,
      runtime: null,
      supervisor: null,
      stopPromise: null,
      stopFailed: false
    };
    const isCurrent = () => runtimes.get(tunnelId) === entry && !entry.stopPromise;

    const runtime = createRuntime({
      ...runtimeOptions,
      instanceId: tunnelId,
      onLog: value => onLog({ ...value, tunnelId }),
      onStatus: status => {
        if (!isCurrent()) return;
        entry.supervisor?.observe(status);
        statuses.set(tunnelId, normalizeStatus(entry.connection, {
          ...status,
          retry: entry.supervisor?.snapshot?.() || null
        }));
        onStatus(snapshot());
      }
    });
    entry.runtime = runtime;
    entry.supervisor = createTunnelRecoverySupervisor({
      restartConnection: async () => {
        await runtime.stop().catch(() => {});
        if (!isCurrent()) return { state: 'cancelled', errorCode: '', error: '' };
        return runtime.start(entry.startConfig);
      },
      onSchedule: retry => {
        if (!isCurrent()) return;
        const current = statuses.get(tunnelId) || normalizeStatus(entry.connection, { state: 'degraded', tunnelId });
        statuses.set(tunnelId, { ...current, retry });
        onStatus(snapshot());
      }
    });

    runtimes.set(tunnelId, entry);
    statuses.set(tunnelId, normalizeStatus(connection, { state: 'starting', tunnelId }));
    onStatus(snapshot());

    try {
      const result = await runtime.start(startConfig);
      if (!isCurrent()) return { ok: false, cancelled: true, tunnelId };
      const status = normalizeStatus(entry.connection, {
        ...result,
        retry: entry.supervisor?.snapshot?.() || null
      });
      statuses.set(tunnelId, status);
      onStatus(snapshot());
      return { ok: result?.state === 'running' || result?.state === 'degraded', tunnelId, status };
    } catch (error) {
      if (!isCurrent()) return { ok: false, cancelled: true, tunnelId };
      const current = runtime.snapshot();
      const status = normalizeStatus(entry.connection, {
        ...current,
        state: 'failed',
        error: current.error || messageOf(error),
        errorCode: current.errorCode || String(error?.code || 'secure_tunnel_failed'),
        retry: entry.supervisor?.snapshot?.() || null
      });
      statuses.set(tunnelId, status);
      onStatus(snapshot());
      return { ok: false, tunnelId, status, error: messageOf(error) };
    }
  }

  async function stopRuntime(tunnelId, { preserveStatus = false } = {}) {
    const entry = runtimes.get(tunnelId);
    if (!entry) {
      if (!preserveStatus) statuses.delete(tunnelId);
      return { stopped: true, exited: true };
    }
    if (entry.stopPromise) return entry.stopPromise;

    const previous = statuses.get(tunnelId) || normalizeStatus(entry.connection, entry.runtime.snapshot());
    entry.supervisor?.cancel();
    entry.stopPromise = (async () => {
      let result;
      try {
        result = await entry.runtime.stop();
      } catch (error) {
        result = { stopped: false, exited: false, error: messageOf(error) };
      }
      const stopped = result?.stopped !== false && result?.exited !== false;
      entry.stopFailed = !stopped;
      if (!stopped) {
        statuses.set(tunnelId, {
          ...previous,
          state: 'failed',
          error: result.error || 'Tunnel termination could not be confirmed.',
          errorCode: 'secure_tunnel_stop_failed',
          retry: null
        });
      } else {
        if (runtimes.get(tunnelId) === entry) runtimes.delete(tunnelId);
        if (preserveStatus) statuses.set(tunnelId, { ...previous, state: 'stopped', error: '', errorCode: '', retry: null });
        else statuses.delete(tunnelId);
      }
      onStatus(snapshot());
      return { ...result, stopped };
    })();
    try { return await entry.stopPromise; }
    finally { entry.stopPromise = null; }
  }

  async function stop() {
    ++generation;
    const results = await Promise.all([...runtimes.keys()].map(tunnelId => stopRuntime(tunnelId, { preserveStatus: true })));
    onStatus(snapshot());
    return { stopped: results.every(result => result.stopped !== false), ...snapshot() };
  }

  function snapshot() {
    return {
      connections: [...statuses.values()].sort((a, b) => a.label.localeCompare(b.label))
    };
  }

  return Object.freeze({ sync, stop, snapshot });
}

function startConfigFor(connection, port, localToken) {
  return {
    tunnelId: String(connection.tunnelId || '').trim(),
    port,
    localToken,
    apiKey: connection.apiKey
  };
}

function sameStartConfig(left = {}, right = {}) {
  return String(left.tunnelId || '') === String(right.tunnelId || '')
    && Number(left.port || 0) === Number(right.port || 0)
    && String(left.localToken || '') === String(right.localToken || '')
    && String(left.apiKey || '') === String(right.apiKey || '');
}

function normalizeStatus(connection, status = {}) {
  return {
    tunnelId: String(connection?.tunnelId || status.tunnelId || ''),
    label: String(connection?.label || connection?.tunnelId || status.tunnelId || ''),
    enabled: connection?.enabled !== false,
    state: String(status.state || 'stopped'),
    healthUrl: String(status.healthUrl || ''),
    recoveryMode: String(status.recoveryMode || ''),
    error: String(status.error || ''),
    errorCode: String(status.errorCode || ''),
    lastConnectedAt: status.lastConnectedAt || null,
    tunnelHealth: status.tunnelHealth || null,
    retry: status.retry || null
  };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown tunnel error');
}

export { createTunnelRuntimePool };
