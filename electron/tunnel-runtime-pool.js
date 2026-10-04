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
  const supervisors = new Map();
  const statuses = new Map();
  let generation = 0;

  async function sync({ connections = [], port, localToken } = {}) {
    const syncGeneration = ++generation;
    await stopAllRuntimes();
    if (syncGeneration !== generation) return snapshot();
    statuses.clear();
    onStatus(snapshot());

    const desired = connections.filter(connection => connection?.enabled !== false);
    const results = await Promise.all(desired.map(async connection => {
      const tunnelId = String(connection.tunnelId || '').trim();
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
      const startConfig = {
        tunnelId,
        port,
        localToken,
        apiKey: connection.apiKey
      };
      let supervisor = null;
      const runtime = createRuntime({
        ...runtimeOptions,
        instanceId: tunnelId,
        onLog: entry => onLog({ ...entry, tunnelId }),
        onStatus: status => {
          if (syncGeneration !== generation) return;
          supervisor?.observe(status);
          statuses.set(tunnelId, normalizeStatus(connection, {
            ...status,
            retry: supervisor?.snapshot?.() || null
          }));
          onStatus(snapshot());
        }
      });
      supervisor = createTunnelRecoverySupervisor({
        restartConnection: async () => {
          await runtime.stop().catch(() => {});
          if (syncGeneration !== generation) return { state: 'cancelled', errorCode: '', error: '' };
          return runtime.start(startConfig);
        },
        onSchedule: retry => {
          if (syncGeneration !== generation) return;
          const current = statuses.get(tunnelId) || normalizeStatus(connection, { state: 'degraded', tunnelId });
          statuses.set(tunnelId, { ...current, retry });
          onStatus(snapshot());
        }
      });
      runtimes.set(tunnelId, runtime);
      supervisors.set(tunnelId, supervisor);
      statuses.set(tunnelId, normalizeStatus(connection, { state: 'starting', tunnelId }));
      onStatus(snapshot());
      try {
        const result = await runtime.start(startConfig);
        if (syncGeneration !== generation) return { ok: false, cancelled: true, tunnelId };
        statuses.set(tunnelId, normalizeStatus(connection, {
          ...result,
          retry: supervisor?.snapshot?.() || null
        }));
        onStatus(snapshot());
        return { ok: result?.state === 'running' || result?.state === 'degraded', tunnelId, status: statuses.get(tunnelId) };
      } catch (error) {
        if (syncGeneration !== generation) return { ok: false, cancelled: true, tunnelId };
        const current = runtime.snapshot();
        statuses.set(tunnelId, normalizeStatus(connection, {
          ...current,
          state: 'failed',
          error: current.error || messageOf(error),
          errorCode: current.errorCode || String(error?.code || 'secure_tunnel_failed'),
          retry: supervisor?.snapshot?.() || null
        }));
        onStatus(snapshot());
        return { ok: false, tunnelId, status: statuses.get(tunnelId), error: messageOf(error) };
      }
    }));

    return { ...snapshot(), results };
  }

  async function stop() {
    ++generation;
    await stopAllRuntimes();
    onStatus(snapshot());
    return { stopped: true, ...snapshot() };
  }

  function snapshot() {
    return {
      connections: [...statuses.values()].sort((a, b) => a.label.localeCompare(b.label))
    };
  }

  async function stopAllRuntimes() {
    const active = [...runtimes.entries()];
    for (const supervisor of supervisors.values()) supervisor.cancel();
    supervisors.clear();
    runtimes.clear();
    await Promise.all(active.map(async ([tunnelId, runtime]) => {
      try {
        await runtime.stop();
      } catch (error) {
        const previous = statuses.get(tunnelId) || { tunnelId, label: tunnelId };
        statuses.set(tunnelId, {
          ...previous,
          state: 'failed',
          error: messageOf(error),
          errorCode: 'secure_tunnel_failed'
        });
      }
    }));
    for (const status of statuses.values()) {
      if (status.state !== 'failed') status.state = 'stopped';
    }
  }

  return Object.freeze({ sync, stop, snapshot });
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
