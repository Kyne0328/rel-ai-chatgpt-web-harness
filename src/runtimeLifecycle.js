// @ts-check

import { CONNECTION_STATE_VALUES } from './contracts/connection.ts';

const PROCESS_LIFECYCLE_STATUSES = Object.freeze(['starting', 'running', 'stopping', 'orphaned', 'stopped', 'exited', 'failed']);
const TUNNEL_LIFECYCLE_STATUSES = Object.freeze(['stopped', 'starting', 'locally_ready', 'authenticating', 'running', 'degraded', 'failed']);
const UPDATER_LIFECYCLE_STATUSES = Object.freeze(['unsupported', 'idle', 'checking', 'up_to_date', 'available', 'downloading', 'downloaded', 'installing', 'error']);

const PROCESS_TRANSITIONS = Object.freeze({
  starting: Object.freeze(['running', 'stopping', 'orphaned', 'stopped', 'exited', 'failed']),
  running: Object.freeze(['stopping', 'orphaned', 'stopped', 'exited', 'failed']),
  stopping: Object.freeze(['orphaned', 'stopped', 'failed']),
  orphaned: Object.freeze(['orphaned', 'stopping', 'stopped', 'failed']),
  stopped: Object.freeze(['stopped']),
  exited: Object.freeze(['exited']),
  failed: Object.freeze(['failed'])
});

const TUNNEL_TRANSITIONS = Object.freeze({
  stopped: Object.freeze(['stopped', 'starting']),
  starting: Object.freeze(['starting', 'locally_ready', 'authenticating', 'running', 'failed', 'stopped']),
  locally_ready: Object.freeze(['locally_ready', 'authenticating', 'running', 'failed', 'stopped']),
  authenticating: Object.freeze(['authenticating', 'running', 'degraded', 'failed', 'stopped']),
  running: Object.freeze(['running', 'degraded', 'failed', 'stopped']),
  degraded: Object.freeze(['degraded', 'running', 'failed', 'stopped']),
  failed: Object.freeze(['failed', 'starting', 'stopped'])
});

const UPDATER_TRANSITIONS = Object.freeze({
  unsupported: Object.freeze(['unsupported']),
  idle: Object.freeze(['idle', 'checking', 'error']),
  checking: Object.freeze(['checking', 'up_to_date', 'available', 'idle', 'error']),
  up_to_date: Object.freeze(['up_to_date', 'checking', 'idle', 'error']),
  available: Object.freeze(['available', 'checking', 'downloading', 'idle', 'error']),
  downloading: Object.freeze(['downloading', 'downloaded', 'available', 'idle', 'error']),
  downloaded: Object.freeze(['downloaded', 'checking', 'installing', 'idle', 'error']),
  installing: Object.freeze(['installing', 'idle', 'error']),
  error: Object.freeze(['error', 'checking', 'idle'])
});

const CONNECTION_TRANSITIONS = Object.freeze({
  localService: Object.freeze({
    stopped: Object.freeze(['stopped', 'starting', 'failed']),
    starting: Object.freeze(['starting', 'running', 'stopped', 'failed']),
    running: Object.freeze(['running', 'stopped', 'failed']),
    failed: Object.freeze(['failed', 'starting', 'stopped'])
  }),
  publicEndpoint: Object.freeze({
    disabled: Object.freeze(['disabled', 'connecting']),
    connecting: Object.freeze(['connecting', 'available', 'degraded', 'unavailable', 'disabled']),
    available: Object.freeze(['available', 'degraded', 'unavailable', 'disabled']),
    degraded: Object.freeze(['degraded', 'connecting', 'available', 'unavailable', 'disabled']),
    unavailable: Object.freeze(['unavailable', 'connecting', 'disabled'])
  }),
  chatgptReadiness: Object.freeze({
    unavailable: Object.freeze(['unavailable', 'ready']),
    ready: Object.freeze(['ready', 'unavailable'])
  }),
  dashboardUpdates: Object.freeze({
    offline: Object.freeze(['offline', 'connecting']),
    connecting: Object.freeze(['connecting', 'live', 'reconnecting', 'offline']),
    live: Object.freeze(['live', 'reconnecting', 'paused', 'offline']),
    reconnecting: Object.freeze(['reconnecting', 'live', 'paused', 'offline']),
    paused: Object.freeze(['paused', 'connecting', 'live', 'offline'])
  })
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

function canTransition(map, normalize, from, to) {
  const current = normalize(from);
  const next = normalize(to);
  return Boolean(current && next && map[current]?.includes(next));
}

function normalizeConnectionLayerStatus(layer, value) {
  const allowed = CONNECTION_STATE_VALUES[layer];
  const status = String(value || '').trim().toLowerCase();
  return Array.isArray(allowed) && allowed.includes(status) ? status : '';
}

function canTransitionConnectionLayer(layer, from, to) {
  const current = normalizeConnectionLayerStatus(layer, from);
  const next = normalizeConnectionLayerStatus(layer, to);
  return Boolean(current && next && CONNECTION_TRANSITIONS[layer]?.[current]?.includes(next));
}

function assertConnectionLayerTransition(layer, from, to) {
  const current = normalizeConnectionLayerStatus(layer, from);
  const next = normalizeConnectionLayerStatus(layer, to);
  if (!current || !next || !canTransitionConnectionLayer(layer, current, next)) {
    throw Object.assign(
      new Error(`Invalid ${layer} connection transition: ${current || String(from || '')} -> ${next || String(to || '')}`),
      { code: 'INVALID_CONNECTION_STATE' }
    );
  }
  return next;
}

function canTransitionProcessStatus(from, to) {
  return canTransition(PROCESS_TRANSITIONS, normalizeProcessLifecycleStatus, from, to);
}

function canTransitionTunnelLifecycle(from, to) {
  return canTransition(TUNNEL_TRANSITIONS, normalizeTunnelLifecycleStatus, from, to);
}

function canTransitionUpdaterLifecycle(from, to) {
  return canTransition(UPDATER_TRANSITIONS, normalizeUpdaterLifecycleStatus, from, to);
}

function assertTransition(canTransition, normalize, code, label, from, to) {
  const current = normalize(from);
  const next = normalize(to);
  if (!current || !next || !canTransition(current, next)) {
    throw Object.assign(
      new Error(`Invalid ${label} transition: ${current || String(from || '')} -> ${next || String(to || '')}`),
      { code }
    );
  }
  return next;
}

function assertProcessStatusTransition(from, to) {
  return assertTransition(canTransitionProcessStatus, normalizeProcessLifecycleStatus, 'INVALID_PROCESS_STATE', 'process status', from, to);
}

function assertTunnelLifecycleTransition(from, to) {
  return assertTransition(canTransitionTunnelLifecycle, normalizeTunnelLifecycleStatus, 'INVALID_TUNNEL_STATE', 'tunnel state', from, to);
}

function assertUpdaterLifecycleTransition(from, to) {
  return assertTransition(canTransitionUpdaterLifecycle, normalizeUpdaterLifecycleStatus, 'INVALID_UPDATER_STATE', 'updater state', from, to);
}

export {
  PROCESS_LIFECYCLE_STATUSES,
  TUNNEL_LIFECYCLE_STATUSES,
  UPDATER_LIFECYCLE_STATUSES,
  assertConnectionLayerTransition,
  assertProcessStatusTransition,
  assertTunnelLifecycleTransition,
  assertUpdaterLifecycleTransition,
  canTransitionConnectionLayer,
  canTransitionProcessStatus,
  canTransitionTunnelLifecycle,
  canTransitionUpdaterLifecycle,
  isActiveProcessStatus,
  isTerminalProcessStatus,
  normalizeProcessLifecycleStatus,
  normalizeTunnelLifecycleStatus,
  normalizeUpdaterLifecycleStatus
};
