import {
  completeProgress,
  normalizeTaskProgress,
  taskPlanRuntimeState,
  sanitizeActivityEventRecord,
  sanitizeDisplayText,
  sanitizeTaskRecord
} from './taskObservability.js';
import { isTerminalTaskStatus, normalizeHistoricalTaskStatus } from './taskState.js';
import { eventIdentityKey, eventTimestampMs, operationForTool, timestampMs, unique } from './taskEvents.js';
import { OPERATION_IDS as OP } from './tools/operationIds.js';

const MAX_SESSION_EVENTS = 200;
const DURABLE_FIELDS = Object.freeze([
  'changedFiles', 'changedFileCount', 'validation', 'committed', 'commitHead', 'commitHeads', 'pushed', 'prDrafted',
  'workflow', 'workflowEvidence', 'backgroundOperation', 'principalFingerprint', 'repairable', 'contextSummary'
]);

function canonicalTaskSnapshot(record = {}, options = {}) {
  const sanitized = sanitizeTaskRecord(record, { eventsAlreadySanitized: options.eventsAlreadySanitized === true }) || {};
  const id = String(sanitized.taskId || sanitized.id || sanitized.sessionId || '').trim();
  const status = normalizeHistoricalTaskStatus(sanitized.status || sanitized.state, sanitized);
  const terminal = isTerminalTaskStatus(status);
  const inactive = status === 'inactive';
  const activeCalls = terminal || inactive ? 0 : Math.max(0, Number(sanitized.activeCalls || 0));
  const events = Array.isArray(sanitized.events)
    ? sanitized.events.slice(-MAX_SESSION_EVENTS)
    : [];
  const currentOperations = terminal || inactive
    ? []
    : Array.isArray(sanitized.currentOperations) ? sanitized.currentOperations : [];
  const completionKnown = status === 'completed' || sanitized.completionKnown === true;
  return sanitizeTaskRecord({
    ...sanitized,
    id,
    taskId: id,
    sessionId: sanitized.sessionId || id,
    status,
    state: terminal ? 'ended' : inactive ? 'inactive' : activeCalls > 0 ? 'working' : 'waiting',
    completionKnown,
    progress: normalizeTaskProgress(sanitized.progress, status),
    activeCalls,
    currentOperations,
    events,
    calls: Math.max(0, Number(sanitized.calls ?? sanitized.toolCallCount ?? 0)),
    toolCallCount: Math.max(0, Number(sanitized.toolCallCount ?? sanitized.calls ?? 0)),
    successfulToolCallCount: Math.max(0, Number(sanitized.successfulToolCallCount || 0)),
    failedToolCallCount: Math.max(0, Number(sanitized.failedToolCallCount ?? sanitized.failures ?? 0)),
    failures: Math.max(0, Number(sanitized.failures ?? sanitized.failedToolCallCount ?? 0)),
    changedFiles: unique((Array.isArray(sanitized.changedFiles) ? sanitized.changedFiles : []).map(String).filter(Boolean)),
    changedFileCount: Number.isFinite(Number(sanitized.changedFileCount))
      ? Math.max(0, Number(sanitized.changedFileCount))
      : Array.isArray(sanitized.changedFiles) ? unique(sanitized.changedFiles.map(String).filter(Boolean)).length : 0,
    endedAt: terminal ? sanitized.endedAt || sanitized.completedAt || sanitized.cancelledAt || sanitized.updatedAt || null : null,
    completedAt: status === 'completed' ? sanitized.completedAt || sanitized.endedAt || sanitized.updatedAt || null : null,
    cancelledAt: status === 'cancelled' ? sanitized.cancelledAt || sanitized.endedAt || sanitized.updatedAt || null : null
  }, { eventsAlreadySanitized: true });
}

function reduceTaskLifecycleAuditEvent(session, event = {}, options = {}) {
  const current = canonicalTaskSnapshot(session, { eventsAlreadySanitized: options.eventsAlreadySanitized === true });
  const timestamp = timestampMs(event.ts || event.timestamp) || Date.now();
  const ended = timestamp + Math.max(0, Number(event.ms || event.durationMs || 0));
  const completion = event.ok !== false && (event.completionKnown === true || event.tool === OP.WORK_FINISH);
  const cancellationStatus = String(event.taskCancellationStatus || '').trim().toLowerCase();
  const cancellationPending = event.ok !== false && event.tool === OP.WORK_CANCEL && cancellationStatus === 'cancelling';
  const cancellation = event.ok !== false && event.tool === OP.WORK_CANCEL && !cancellationPending;
  const changedFiles = unique([
    ...(current.changedFiles || []),
    ...(Array.isArray(event.taskOwnedChangedFiles) ? event.taskOwnedChangedFiles : []),
    ...(Array.isArray(event.changedFiles) ? event.changedFiles : [])
  ].map(String).filter(Boolean));
  const eventId = event.eventId || event.operationId || '';
  const lifecycleIndex = eventId
    ? (current.events || []).findIndex(item => item?.eventId === eventId || item?.operationId === eventId)
    : -1;
  const represented = lifecycleIndex >= 0;
  const recoverableValidationFailure = event.tool === OP.VALIDATE_CHECKS && ['failed', 'not_run'].includes(String(event.validationStatus || ''));
  const failures = Math.max(Number(current.failures || 0), Number(current.failedToolCallCount || 0))
    + (event.ok === false && !represented && !recoverableValidationFailure ? 1 : 0);
  const calls = Number(current.calls || 0) + (represented ? 0 : 1);
  const compact = compactLifecycleEvent(event);
  const events = represented
    ? current.events.map((item, index) => index === lifecycleIndex ? { ...item, ...compact } : item)
    : [...current.events, compact];
  const status = completion || current.completionKnown
    ? 'completed'
    : cancellation
      ? 'cancelled'
      : cancellationPending
        ? current.status
        : isTerminalTaskStatus(current.status)
        ? current.status
        : recoverableValidationFailure
          ? 'validation_failed'
          : 'planning';
  const terminal = isTerminalTaskStatus(status);
  const startedAtMs = timestampMs(current.startedAt);
  const startedAt = startedAtMs && startedAtMs <= timestamp
    ? current.startedAt
    : new Date(timestamp).toISOString();
  const updatedAt = new Date(Math.max(ended, timestampMs(current.updatedAt), timestampMs(current.endedAt))).toISOString();
  const validation = event.validationStatus === 'not_required'
    ? 'not_required'
    : event.tool === OP.VALIDATE_CHECKS
      ? validationState(event)
      : current.validation || 'not_run';
  const eventCommitHead = String(event.commitHead || event.metadata?.commitHead || '').trim();
  const commitHeads = unique([
    ...(Array.isArray(current.commitHeads) ? current.commitHeads : []),
    ...(eventCommitHead ? [eventCommitHead] : [])
  ]);
  return canonicalTaskSnapshot({
    ...current,
    id: current.id || event.taskId,
    taskId: current.taskId || event.taskId,
    sessionId: current.sessionId || event.taskId,
    title: current.title || historicalTitle(current, event),
    status,
    progress: status === 'completed' ? completeProgress(current.progress?.label || 'Complete') : current.progress,
    completionKnown: current.completionKnown || completion,
    endReason: completion || current.completionKnown
      ? 'explicit_completion'
      : cancellation ? 'explicit_cancellation' : current.endReason || '',
    summary: event.taskSummary || current.summary || '',
    resultSummary: event.taskSummary || current.resultSummary || current.summary || '',
    workspace: current.workspace || event.workspace || '',
    startedAt,
    updatedAt,
    lastActivityAt: updatedAt,
    endedAt: terminal ? updatedAt : null,
    completedAt: status === 'completed' ? updatedAt : null,
    cancelledAt: status === 'cancelled' ? updatedAt : null,
    durationMs: Math.max(0, timestampMs(updatedAt) - timestampMs(startedAt)),
    calls,
    toolCallCount: Math.max(Number(current.toolCallCount || 0), calls),
    successfulToolCallCount: Math.max(0, calls - failures),
    failedToolCallCount: failures,
    failures,
    changedFiles,
    changedFileCount: changedFiles.length,
    validation,
    committed: Boolean(current.committed || (event.tool === OP.PUBLISH_COMMIT && event.ok !== false)),
    commitHead: eventCommitHead || current.commitHead || '',
    commitHeads,
    pushed: Boolean(current.pushed || (event.tool === OP.PUBLISH_PUSH && event.ok !== false)),
    prDrafted: Boolean(current.prDrafted || (event.tool === OP.PUBLISH_DRAFT_PR && event.ok !== false)),
    lastTool: event.tool || current.lastTool || '',
    operation: event.operation || current.operation || operationForTool(event.tool),
    lastOutcome: event.ok === false ? 'failed' : 'succeeded',
    activeCalls: 0,
    currentOperations: [],
    events: events.slice(-MAX_SESSION_EVENTS)
  }, { eventsAlreadySanitized: true });
}

function mergeTaskLifecycleSnapshots(persisted, live, options = {}) {
  const snapshotOptions = { eventsAlreadySanitized: options.eventsAlreadySanitized === true };
  if (!persisted) return canonicalTaskSnapshot(live, snapshotOptions);
  if (!live) return canonicalTaskSnapshot(persisted, snapshotOptions);
  const durable = canonicalTaskSnapshot(persisted, snapshotOptions);
  const active = canonicalTaskSnapshot(live, snapshotOptions);
  if (isTerminalTaskStatus(durable.status) && lifecycleTimestamp(durable) >= lifecycleTimestamp(active)) return durable;
  const merged = { ...durable, ...active };
  for (const field of DURABLE_FIELDS) {
    if (durable[field] !== undefined) merged[field] = durable[field];
  }
  if (durable.plan !== undefined || active.plan !== undefined) {
    const durableRevision = Number(durable.plan?.revision ?? -1);
    const activeRevision = Number(active.plan?.revision ?? -1);
    const activePlanWins = active.plan !== undefined && (durable.plan === undefined || activeRevision >= durableRevision);
    const selected = activePlanWins ? active : durable;
    const losing = activePlanWins ? durable : active;
    merged.plan = selected.plan;
    const planState = taskPlanRuntimeState(merged.plan);
    const losingPlanState = taskPlanRuntimeState(losing.plan);
    if (planState) merged.progress = planState.progress;
    else if (merged.progress?.source === 'task_plan') {
      merged.progress = selected.progress?.source === 'task_plan'
        ? { mode: 'indeterminate', label: 'No task plan' }
        : selected.progress || { mode: 'indeterminate', label: 'No task plan' };
    }
    if (losingPlanState && merged.currentStage === losingPlanState.currentStage) {
      merged.currentStage = planState?.currentStage || selected.currentStage;
    }
    if (losingPlanState && merged.currentActivity === losingPlanState.currentActivity) {
      merged.currentActivity = planState?.currentActivity || selected.currentActivity;
    }
  }
  merged.calls = Math.max(Number(durable.calls || 0), Number(active.calls || 0));
  merged.toolCallCount = Math.max(Number(durable.toolCallCount || 0), Number(active.toolCallCount || 0));
  merged.successfulToolCallCount = Math.max(Number(durable.successfulToolCallCount || 0), Number(active.successfulToolCallCount || 0));
  merged.failedToolCallCount = Math.max(Number(durable.failedToolCallCount || 0), Number(active.failedToolCallCount || 0));
  merged.failures = Math.max(Number(durable.failures || 0), Number(active.failures || 0));
  merged.completionKnown = durable.completionKnown === true || active.completionKnown === true;
  merged.events = mergeLifecycleEvents(durable.events || [], active.events || []);
  return canonicalTaskSnapshot(merged, { eventsAlreadySanitized: true });
}

function lifecycleChangedFields(previous, current) {
  if (!current) return [];
  if (!previous) return Object.keys(current).filter(key => !['events', 'currentOperations'].includes(key));
  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  const changed = [];
  for (const key of keys) {
    if (key === 'events' || key === 'currentOperations') continue;
    if (!sameValue(previous[key], current[key])) changed.push(key);
  }
  if (!sameValue(previous.events, current.events)) changed.push('events');
  if (!sameValue(previous.currentOperations, current.currentOperations)) changed.push('currentOperations');
  return changed;
}

function mergeLifecycleEvents(left, right) {
  const output = [];
  const positions = new Map();
  for (const event of [...left, ...right]) {
    const key = eventIdentityKey(event, output.length);
    if (positions.has(key)) output[positions.get(key)] = { ...output[positions.get(key)], ...event };
    else {
      positions.set(key, output.length);
      output.push(event);
    }
  }
  return output
    .sort((a, b) => Number(a?.sequence || 0) - Number(b?.sequence || 0) || eventTimestampMs(a) - eventTimestampMs(b))
    .slice(-MAX_SESSION_EVENTS);
}

function compactLifecycleEvent(event) {
  const keep = [
    'id', 'eventId', 'ts', 'timestamp', 'startedAt', 'completedAt', 'durationMs', 'pid', 'taskId',
    'operationId', 'requestId', 'serverInstanceId', 'transportType', 'clientName', 'clientVersion',
    'taskIdentityVersion', 'taskIdExplicit', 'taskHistoryEligible', 'duplicateRequest', 'eventType',
    'category', 'action', 'status', 'title', 'summary', 'currentStage', 'currentActivity', 'tool',
    'operation', 'workspace', 'target', 'result', 'metadata', 'progress', 'ok', 'ms', 'changedFiles',
    'taskOwnedChangedFiles', 'externalChangedFiles', 'validationStatus', 'validationFingerprint',
    'taskMutationGeneration', 'taskValidatedMutationGeneration', 'taskWorkspaceGeneration',
    'completionKnown', 'endReason', 'completionSource', 'taskSummary', 'commitHead', 'message', 'error', 'path'
  ];
  const compact = Object.fromEntries(keep.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  for (const key of ['taskSummary', 'message', 'error']) {
    if (compact[key] != null) compact[key] = sanitizeDisplayText(compact[key], 500);
  }
  if (!compact.eventId && compact.operationId) compact.eventId = compact.operationId;
  return sanitizeActivityEventRecord(compact);
}

function validationState(event) {
  if (event.ok === false || event.validationStatus === 'failed') return 'failed';
  if (event.validationStatus === 'not_required') return 'not_required';
  return event.validationStatus === 'passed' ? 'passed' : 'not_run';
}

function lifecycleTimestamp(value) {
  return Math.max(0, timestampMs(value?.endedAt), timestampMs(value?.completedAt), timestampMs(value?.updatedAt), timestampMs(value?.startedAt));
}

function historicalTitle(session, event) {
  const operation = String(event?.operation || session?.operation || '').trim();
  if (operation && !/^(task|request|tool call|mcp operation)$/i.test(operation)) return operation;
  const workspace = String(event?.workspace || session?.workspace || '').trim();
  return workspace ? `Historical task in ${workspace}` : 'Historical Rel.AI task';
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export {
  canonicalTaskSnapshot,
  lifecycleChangedFields,
  mergeTaskLifecycleSnapshots,
  reduceTaskLifecycleAuditEvent
};
