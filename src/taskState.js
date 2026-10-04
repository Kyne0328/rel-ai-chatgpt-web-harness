'use strict';

import { CANONICAL_TASK_STATUSES } from './contracts/tasks.ts';

const CANONICAL_TASK_STATUS_SET = new Set(CANONICAL_TASK_STATUSES);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TASK_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['planning', 'running', 'inactive', 'cancelled']),
  planning: Object.freeze(['running', 'waiting_for_approval', 'blocked', 'validating', 'validation_failed', 'inactive', 'completed', 'failed', 'cancelled']),
  running: Object.freeze(['planning', 'waiting_for_approval', 'blocked', 'validating', 'validation_failed', 'inactive', 'completed', 'failed', 'cancelled']),
  waiting_for_approval: Object.freeze(['running', 'blocked', 'inactive', 'failed', 'cancelled']),
  blocked: Object.freeze(['running', 'waiting_for_approval', 'validating', 'validation_failed', 'inactive', 'failed', 'cancelled']),
  validating: Object.freeze(['planning', 'running', 'validation_failed', 'inactive', 'completed', 'failed', 'cancelled']),
  validation_failed: Object.freeze(['planning', 'running', 'blocked', 'validating', 'inactive', 'completed', 'failed', 'cancelled']),
  inactive: Object.freeze(['planning', 'running', 'blocked', 'validating']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([])
});

function normalizeStatusToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isCanonicalTaskStatus(value) {
  return CANONICAL_TASK_STATUS_SET.has(normalizeStatusToken(value));
}

function isTerminalTaskStatus(value) {
  return TERMINAL_TASK_STATUSES.has(normalizeStatusToken(value));
}

function activeLogicalTaskCount(activity = {}) {
  const declared = Math.max(0, Number(activity.activeTaskCount || 0));
  const activeCalls = Math.max(0, Number(activity.activeCalls || 0));
  const liveTasks = (Array.isArray(activity.tasks) ? activity.tasks : []).filter(task => {
    const status = normalizeHistoricalTaskStatus(task?.status, task);
    return status !== 'inactive' && !isTerminalTaskStatus(status);
  }).length;
  return Math.max(declared, liveTasks, activeCalls > 0 ? 1 : 0);
}

function normalizeHistoricalTaskStatus(value, record = {}) {
  const status = normalizeStatusToken(value);
  if (legacyInactivityRecord(record)) return 'inactive';
  if (status === 'inactive' && record.completionKnown === true) return 'completed';
  if (status === 'inactive' && String(record.cancellationInitiator || '').trim()) return 'cancelled';
  if (status === 'inactive' && (record.terminal === true || String(record.endReason || '') === 'terminal_failure')) return 'failed';
  if (status === 'completed_with_warnings') return 'completed';
  if (isCanonicalTaskStatus(status)) return status;
  if (status === 'working' || status === 'active') return 'running';
  if (status === 'waiting' || status === 'settling' || status === 'open') return 'planning';
  if (status === 'approval' || status === 'awaiting_approval') return 'waiting_for_approval';
  if (status === 'attention') return record.completionKnown === true ? 'completed' : 'failed';
  if (status === 'expired') return record.completionKnown === true ? 'completed' : 'inactive';
  if (record.completionKnown === true) return 'completed';
  if (hasFailureEvidence(record)) return 'failed';
  if (record.endedAt || record.completedAt) return 'cancelled';
  return 'planning';
}

function normalizeLiveTaskStatus(value, record = {}, options = {}) {
  const status = normalizeStatusToken(value);
  if (status === 'blocked' && options.blockedMeansApproval === true) return 'waiting_for_approval';
  return normalizeHistoricalTaskStatus(status, record);
}

function internalStatusToDashboardStatus(value, record = {}) {
  return normalizeHistoricalTaskStatus(value, record);
}

function isTerminalDashboardTaskStatus(value, record = {}) {
  return isTerminalTaskStatus(internalStatusToDashboardStatus(value, record));
}

function canTransitionTaskStatus(from, to) {
  const current = normalizeHistoricalTaskStatus(from);
  const next = normalizeHistoricalTaskStatus(to);
  if (current === next) return true;
  if (isTerminalTaskStatus(current)) return false;
  return TASK_TRANSITIONS[current]?.includes(next) === true;
}

function assertTaskStatusTransition(from, to) {
  const current = normalizeHistoricalTaskStatus(from);
  const next = normalizeHistoricalTaskStatus(to);
  if (!canTransitionTaskStatus(current, next)) {
    const error = new Error(`Invalid task status transition: ${current} -> ${next}`);
    error.code = 'INVALID_TASK_STATE';
    throw error;
  }
  return next;
}

function transitionTaskStatus(task, to, options = {}) {
  if (!task || typeof task !== 'object') throw new TypeError('task must be an object.');
  const current = normalizeLiveTaskStatus(task.status, task);
  const next = normalizeLiveTaskStatus(to, task, options);
  if (current === next) {
    task.status = next;
    return next;
  }
  assertTaskStatusTransition(current, next);
  task.status = next;
  return next;
}

function legacyInactivityRecord(record = {}) {
  if (record.completionKnown === true || String(record.endReason || '') !== 'inactivity_window') return false;
  if (String(record.cancellationInitiator || '').trim()) return false;
  return true;
}

function hasFailureEvidence(record = {}) {
  return Number(record.failures || record.failedToolCallCount || 0) > 0 ||
    Boolean(String(record.errorSummary || record.error || '').trim()) ||
    String(record.lastOutcome || '').toLowerCase() === 'failed' ||
    record.ok === false;
}

export {
  CANONICAL_TASK_STATUSES,
  TASK_TRANSITIONS,
  activeLogicalTaskCount,
  assertTaskStatusTransition,
  canTransitionTaskStatus,
  internalStatusToDashboardStatus,
  isCanonicalTaskStatus,
  isTerminalDashboardTaskStatus,
  isTerminalTaskStatus,
  normalizeHistoricalTaskStatus,
  normalizeLiveTaskStatus,
  transitionTaskStatus
};