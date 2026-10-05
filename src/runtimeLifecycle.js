// @ts-check

const PROCESS_LIFECYCLE_STATUSES = Object.freeze(['starting', 'running', 'stopping', 'orphaned', 'stopped', 'exited', 'failed']);
const TUNNEL_LIFECYCLE_STATUSES = Object.freeze(['stopped', 'starting', 'locally_ready', 'authenticating', 'running', 'degraded', 'failed']);
const UPDATER_LIFECYCLE_STATUSES = Object.freeze(['unsupported', 'idle', 'checking', 'up_to_date', 'available', 'downloading', 'downloaded', 'installing', 'error']);

const TUNNEL_TRANSITIONS = Object.freeze({
  stopped: Object.freeze(['stopped', 'starting']),
  starting: Object.freeze(['starting', 'locally_ready', 'authenticating', 'running', 'failed', 'stopped']),
  locally_ready: Object.freeze(['locally_ready', 'authenticating', 'running', 'failed', 'stopped']),
  authenticating: Object.freeze(['authenticating', 'running', 'degraded', 'failed', 'stopped']),
  running: Object.freeze(['running', 'degraded', 'failed', 'stopped']),
  degraded: Object.freeze(['degraded', 'running', 'failed', 'stopped']),
  failed: Object.freeze(['failed', 'starting', 'stopped'])
});

const PROCESS_STATUS_SET = new Set(PROCESS_LIFECYCLE_STATUSES);
const TUNNEL_STATUS_SET = new Set(TUNNEL_LIFECYCLE_STATUSES);
const UPDATER_STATUS_SET = new Set(UPDATER_LIFECYCLE_STATUSES);

function normalizeProcessLifecycleStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return PROCESS_STATUS_SET.has(status) ? status : '';
}

function normalizeTunnelLifecycleStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return TUNNEL_STATUS_SET.has(status) ? status : '';
}

function normalizeUpdaterLifecycleStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return UPDATER_STATUS_SET.has(status) ? status : '';
}

function isActiveProcessStatus(value) {
  return ['starting', 'running', 'stopping'].includes(normalizeProcessLifecycleStatus(value));
}

function isTerminalProcessStatus(value) {
  return ['stopped', 'exited', 'failed'].includes(normalizeProcessLifecycleStatus(value));
}

function assertTunnelLifecycleTransition(from, to) {
  const current = normalizeTunnelLifecycleStatus(from);
  const next = normalizeTunnelLifecycleStatus(to);
  if (!current || !next || !TUNNEL_TRANSITIONS[current]?.includes(next)) {
    throw Object.assign(
      new Error(`Invalid tunnel state transition: ${current || String(from || '')} -> ${next || String(to || '')}`),
      { code: 'INVALID_TUNNEL_STATE' }
    );
  }
  return next;
}

export {
  assertTunnelLifecycleTransition,
  isActiveProcessStatus,
  isTerminalProcessStatus,
  normalizeProcessLifecycleStatus,
  normalizeUpdaterLifecycleStatus
};
