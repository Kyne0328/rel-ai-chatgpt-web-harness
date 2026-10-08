import {
  completeProgress,
  normalizeTaskProgress,
  taskPlanRuntimeState,
  sanitizeActivityEventRecord,
  sanitizeDisplayText,
  sanitizeTaskRecord
} from './taskObservability.js';
import { isTerminalTaskStatus, normalizeHistoricalTaskStatus } from './taskState.js';
import { eventIdentityAliases, eventIdentityKey, eventTimestampMs, operationForTool, timestampMs, unique } from './taskEvents.js';
import { classifyTaskChangedFiles } from './taskSemanticProgress.js';
import { canonicalizeActivityEvents, ensureActivityEventIdentity } from './taskEventIdentity.js';
import { OPERATION_IDS as OP } from './tools/operationIds.js';

const MAX_SESSION_EVENTS = 200;
const MAX_TASK_CHANGED_FILE_PREVIEW = 200;
const DURABLE_FIELDS = Object.freeze([
  'changedFiles', 'changedFileCount', 'changedFilesTruncated', 'productChangedFileCount', 'supportArtifactCount',
  'validation', 'committed', 'commitHead', 'commitHeads', 'pushed', 'prDrafted',
  'workflow', 'workflowEvidence', 'backgroundOperation', 'backgroundOperations', 'principalFingerprint', 'repairable', 'contextSummary'
]);

function canonicalTaskSnapshot(record = {}, options = {}) {
  const sanitized = sanitizeTaskRecord(record, { eventsAlreadySanitized: options.eventsAlreadySanitized === true }) || {};
  const id = String(sanitized.taskId || sanitized.id || sanitized.sessionId || '').trim();
  const status = normalizeHistoricalTaskStatus(sanitized.status || sanitized.state, sanitized);
  const terminal = isTerminalTaskStatus(status);
  const inactive = status === 'inactive';
  const activeCalls = terminal || inactive ? 0 : Math.max(0, Number(sanitized.activeCalls || 0));
  const importedEvents = Array.isArray(sanitized.events)
    ? canonicalizeActivityEvents(sanitized.events, { source: options.eventSource || `task-history:${sanitized.workspace || ''}:${id}` })
    : [];
  const events = importedEvents.slice(-MAX_SESSION_EVENTS);
  const currentOperations = terminal || inactive
    ? []
    : Array.isArray(sanitized.currentOperations) ? sanitized.currentOperations : [];
  const completionKnown = status === 'completed' || sanitized.completionKnown === true;
  const allChangedFiles = unique((Array.isArray(sanitized.changedFiles) ? sanitized.changedFiles : []).map(String).filter(Boolean));
  const classifiedChangedFiles = classifyTaskChangedFiles(allChangedFiles);
  const changedFileCount = Number.isFinite(Number(sanitized.changedFileCount))
    ? Math.max(0, Number(sanitized.changedFileCount), allChangedFiles.length)
    : allChangedFiles.length;
  const productChangedFileCount = Number.isFinite(Number(sanitized.productChangedFileCount))
    ? Math.max(0, Number(sanitized.productChangedFileCount), classifiedChangedFiles.productChangedFileCount)
    : classifiedChangedFiles.productChangedFileCount;
  const supportArtifactCount = Number.isFinite(Number(sanitized.supportArtifactCount))
    ? Math.max(0, Number(sanitized.supportArtifactCount), classifiedChangedFiles.supportArtifactCount)
    : classifiedChangedFiles.supportArtifactCount;
  const changedFiles = allChangedFiles.slice(0, MAX_TASK_CHANGED_FILE_PREVIEW);
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
    eventCounterReceipts: counterReceipts(sanitized.eventCounterReceipts, importedEvents),
    calls: Math.max(0, Number(sanitized.calls ?? sanitized.toolCallCount ?? 0)),
    toolCallCount: Math.max(0, Number(sanitized.toolCallCount ?? sanitized.calls ?? 0)),
    successfulToolCallCount: Math.max(0, Number(sanitized.successfulToolCallCount || 0)),
    failedToolCallCount: Math.max(0, Number(sanitized.failedToolCallCount ?? sanitized.failures ?? 0)),
    failures: Math.max(0, Number(sanitized.failures ?? sanitized.failedToolCallCount ?? 0)),
    changedFiles,
    changedFileCount,
    changedFilesTruncated: sanitized.changedFilesTruncated === true || changedFileCount > changedFiles.length,
    productChangedFileCount,
    supportArtifactCount,
    endedAt: terminal ? sanitized.endedAt || sanitized.completedAt || sanitized.cancelledAt || sanitized.updatedAt || null : null,
    completedAt: status === 'completed' ? sanitized.completedAt || sanitized.endedAt || sanitized.updatedAt || null : null,
    cancelledAt: status === 'cancelled' ? sanitized.cancelledAt || sanitized.endedAt || sanitized.updatedAt || null : null
  }, { eventsAlreadySanitized: true });
}

function reduceTaskLifecycleAuditEvent(session, event = {}, options = {}) {
  const current = canonicalTaskSnapshot(session, { eventsAlreadySanitized: options.eventsAlreadySanitized === true });
  event = ensureActivityEventIdentity(event, { source: options.eventSource, occurrence: options.eventOccurrence });
  const aliases = new Set(eventIdentityAliases(event));
  const lifecycleIndex = (current.events || []).findIndex(item => eventIdentityAliases(item).some(id => aliases.has(id)));
  const previousEvent = current.events[lifecycleIndex];
  const receipt = findCounterReceipt(current.eventCounterReceipts, aliases);
  const eventId = receipt?.eventId || (previousEvent && eventIdentityKey(previousEvent)) || eventIdentityKey(event);
  event = { ...event, eventId };
  const represented = Boolean(receipt) || lifecycleIndex >= 0;
  const timestamp = timestampMs(event.ts || event.timestamp) || eventTimestampMs(previousEvent || {}) || Date.now();
  const ended = timestamp + Math.max(0, Number(event.ms || event.durationMs || 0));
  const resultFactsEligible = event.taskResultFactsEligible !== false && event.metadata?.taskResultFactsEligible !== false;
  const completion = resultFactsEligible && event.ok !== false && (event.completionKnown === true || event.tool === OP.WORK_FINISH);
  const cancellationStatus = String(event.taskCancellationStatus || '').trim().toLowerCase();
  const cancellationPending = resultFactsEligible && event.ok !== false && event.tool === OP.WORK_CANCEL && cancellationStatus === 'cancelling';
  const cancellation = resultFactsEligible && event.ok !== false && event.tool === OP.WORK_CANCEL && !cancellationPending;
  const changedFiles = unique([
    ...(current.changedFiles || []),
    ...(resultFactsEligible && Array.isArray(event.taskOwnedChangedFiles) ? event.taskOwnedChangedFiles : []),
    ...(resultFactsEligible && Array.isArray(event.changedFiles) ? event.changedFiles : [])
  ].map(String).filter(Boolean));
  const recoverableValidationFailure = resultFactsEligible && event.tool === OP.VALIDATE_CHECKS && ['failed', 'not_run'].includes(String(event.validationStatus || ''));
  const priorOutcome = receipt?.outcome || eventCounterOutcome(previousEvent);
  const incomingOutcome = eventCounterOutcome(event, true);
  const outcome = incomingOutcome === 'pending' && priorOutcome !== 'pending' ? priorOutcome : incomingOutcome;
  const failures = Math.max(0, Math.max(Number(current.failures || 0), Number(current.failedToolCallCount || 0))
    + Number(outcome === 'failed') - Number(priorOutcome === 'failed'));
  const calls = Number(current.calls || 0) + (represented ? 0 : 1);
  const successfulToolCallCount = Math.max(0, Number(current.successfulToolCallCount || 0)
    + Number(outcome === 'succeeded') - Number(priorOutcome === 'succeeded'));
  const eventCounterReceipts = updateCounterReceipt(current.eventCounterReceipts, eventId, outcome, aliases);
  const compact = compactLifecycleEvent(event);
  const events = lifecycleIndex >= 0
    ? current.events.map((item, index) => index === lifecycleIndex ? { ...item, ...compact } : item)
    : [...current.events, compact];
  const status = !resultFactsEligible ? current.status : completion || current.completionKnown
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
  const startedAt = !resultFactsEligible ? current.startedAt : startedAtMs && startedAtMs <= timestamp
    ? current.startedAt
    : new Date(timestamp).toISOString();
  const updatedAt = new Date(Math.max(ended, timestampMs(current.updatedAt), timestampMs(current.endedAt))).toISOString();
  const validation = !resultFactsEligible ? current.validation || 'not_run' : event.validationStatus === 'not_required'
    ? 'not_required'
    : completion && ['passed', 'failed', 'stale', 'not_run'].includes(String(event.validationStatus || ''))
      ? String(event.validationStatus)
      : event.tool === OP.VALIDATE_CHECKS
        ? validationState(event)
        : current.validation || 'not_run';
  const eventCommitHead = resultFactsEligible ? String(event.commitHead || event.metadata?.commitHead || '').trim() : '';
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
    endedAt: !resultFactsEligible ? current.endedAt : terminal ? updatedAt : null,
    completedAt: !resultFactsEligible ? current.completedAt : status === 'completed' ? updatedAt : null,
    cancelledAt: !resultFactsEligible ? current.cancelledAt : status === 'cancelled' ? updatedAt : null,
    durationMs: !resultFactsEligible ? current.durationMs : Math.max(0, timestampMs(updatedAt) - timestampMs(startedAt)),
    calls,
    toolCallCount: Math.max(Number(current.toolCallCount || 0), calls),
    successfulToolCallCount,
    eventCounterReceipts,
    failedToolCallCount: failures,
    failures,
    changedFiles,
    changedFileCount: changedFiles.length,
    validation,
    committed: Boolean(current.committed || (resultFactsEligible && event.tool === OP.PUBLISH_COMMIT && event.commitCreated === true)),
    commitHead: eventCommitHead || current.commitHead || '',
    commitHeads,
    pushed: Boolean(current.pushed || (resultFactsEligible && event.tool === OP.PUBLISH_PUSH && event.pushPublished === true)),
    prDrafted: Boolean(current.prDrafted || (resultFactsEligible && event.tool === OP.PUBLISH_DRAFT_PR && event.ok !== false)),
    lastTool: event.tool || current.lastTool || '',
    operation: event.operation || current.operation || operationForTool(event.tool),
    lastOutcome: event.ok === false ? 'failed' : 'succeeded',
    activeCalls: resultFactsEligible ? 0 : current.activeCalls,
    currentOperations: resultFactsEligible ? [] : current.currentOperations,
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
  merged.changedFiles = unique([...(durable.changedFiles || []), ...(active.changedFiles || [])]).slice(0, MAX_TASK_CHANGED_FILE_PREVIEW);
  merged.changedFileCount = Math.max(Number(durable.changedFileCount || 0), Number(active.changedFileCount || 0), merged.changedFiles.length);
  merged.productChangedFileCount = Math.max(Number(durable.productChangedFileCount || 0), Number(active.productChangedFileCount || 0));
  merged.supportArtifactCount = Math.max(Number(durable.supportArtifactCount || 0), Number(active.supportArtifactCount || 0));
  merged.changedFilesTruncated = durable.changedFilesTruncated === true
    || active.changedFilesTruncated === true
    || merged.changedFileCount > merged.changedFiles.length;
  merged.completionKnown = durable.completionKnown === true || active.completionKnown === true;
  merged.events = mergeLifecycleEvents(durable.events || [], active.events || []);
  merged.eventCounterReceipts = mergeCounterReceipts(durable.eventCounterReceipts, active.eventCounterReceipts, merged.events);
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
    'id', 'eventId', 'auditId', 'eventIdentitySource', 'eventIdentityOccurrence', 'ts', 'timestamp', 'startedAt', 'completedAt', 'durationMs', 'pid', 'taskId',
    'operationId', 'requestId', 'serverInstanceId', 'transportType', 'clientName', 'clientVersion',
    'taskIdentityVersion', 'taskIdExplicit', 'taskHistoryEligible', 'taskResultFactsEligible', 'duplicateRequest', 'eventType',
    'category', 'action', 'status', 'title', 'summary', 'currentStage', 'currentActivity', 'tool',
    'operation', 'workspace', 'target', 'result', 'metadata', 'progress', 'ok', 'ms', 'changedFiles',
    'taskOwnedChangedFiles', 'externalChangedFiles', 'validationStatus', 'validationFingerprint',
    'taskMutationGeneration', 'taskValidatedMutationGeneration', 'taskWorkspaceGeneration',
    'completionKnown', 'endReason', 'completionSource', 'taskSummary', 'commitHead', 'commitCreated', 'pushPublished',
    'mutationEffect', 'mutationUnknown', 'possibleChangedFiles', 'message', 'error', 'path'
  ];
  const compact = Object.fromEntries(keep.filter(key => event[key] !== undefined).map(key => [key, event[key]]));
  for (const key of ['taskSummary', 'message', 'error']) {
    if (compact[key] != null) compact[key] = sanitizeDisplayText(compact[key], 500);
  }
  if (!compact.eventId) compact.eventId = eventIdentityKey(event);
  return sanitizeActivityEventRecord(compact);
}


function eventCounterOutcome(event, audit = false) {
  if (!event) return 'pending';
  if (['running', 'queued', 'pending', 'accepted'].includes(event.status)) return 'pending';
  if (event.taskResultFactsEligible !== false && event.metadata?.taskResultFactsEligible !== false
    && event.tool === OP.VALIDATE_CHECKS && ['failed', 'not_run'].includes(String(event.validationStatus || ''))) return 'validation_failed';
  if (event.ok === false || event.status === 'failed') return 'failed';
  if (event.status === 'cancelled') return 'cancelled';
  return audit || event.ok === true || event.status === 'succeeded' ? 'succeeded' : 'pending';
}

// The durable receipt index is independent of the bounded display tail. It has
// no last-N eviction: old audit replays must remain idempotent. Canonical reads
// reuse it unchanged; lookups are O(1), and only a new receipt copies the compact
// outcome dictionary (the task snapshot must already be serialized on writes).
function counterReceipts(receipts = {}, events = []) {
  let result = receipts?.version === 1 && receipts.outcomes && receipts.aliases
    ? receipts
    : { version: 1, outcomes: Object.create(null), aliases: Object.create(null) };
  let writable = result !== receipts;
  const write = () => {
    if (writable) return;
    result = { version: 1, outcomes: { ...result.outcomes }, aliases: { ...result.aliases } };
    writable = true;
  };
  const set = (eventId, outcome, aliases = []) => {
    const existing = Object.hasOwn(result.outcomes, eventId) ? result.outcomes[eventId] : undefined;
    if (existing === undefined || (existing === 'pending' && outcome !== 'pending')) {
      write();
      Object.defineProperty(result.outcomes, eventId, { value: outcome, enumerable: true, configurable: true, writable: true });
    }
    for (const alias of aliases) {
      if (alias === eventId || (Object.hasOwn(result.aliases, alias) && result.aliases[alias] === eventId)) continue;
      write();
      Object.defineProperty(result.aliases, alias, { value: eventId, enumerable: true, configurable: true, writable: true });
    }
  };
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (receipt?.eventId) set(String(receipt.eventId), String(receipt.outcome || 'pending'), Array.isArray(receipt.aliases) ? receipt.aliases.map(String) : []);
  }
  for (const event of events) set(eventIdentityKey(event), eventCounterOutcome(event), eventIdentityAliases(event));
  return result;
}

function findCounterReceipt(receipts, aliases) {
  for (const alias of aliases) {
    const eventId = Object.hasOwn(receipts.outcomes, alias) ? alias
      : Object.hasOwn(receipts.aliases, alias) ? receipts.aliases[alias] : '';
    if (eventId && Object.hasOwn(receipts.outcomes, eventId)) return { eventId, outcome: receipts.outcomes[eventId] };
  }
  return null;
}

function updateCounterReceipt(receipts, eventId, outcome, aliases) {
  let result = receipts;
  if (!Object.hasOwn(receipts.outcomes, eventId) || receipts.outcomes[eventId] !== outcome) {
    result = { ...result, outcomes: { ...receipts.outcomes, [eventId]: outcome } };
  }
  for (const alias of aliases) {
    if (alias === eventId || (Object.hasOwn(result.aliases, alias) && result.aliases[alias] === eventId)) continue;
    if (result.aliases === receipts.aliases) result = { ...result, aliases: { ...receipts.aliases } };
    Object.defineProperty(result.aliases, alias, { value: eventId, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function mergeCounterReceipts(left, right, events) {
  if (left === right) return counterReceipts(left, events);
  const outcomes = { ...left.outcomes };
  for (const [eventId, outcome] of Object.entries(right.outcomes)) {
    if (outcome !== 'pending' || !Object.hasOwn(outcomes, eventId)) {
      Object.defineProperty(outcomes, eventId, { value: outcome, enumerable: true, configurable: true, writable: true });
    }
  }
  return counterReceipts({ version: 1, outcomes, aliases: { ...left.aliases, ...right.aliases } }, events);
}

function validationState(event) {
  if (event.validationStatus === 'stale') return 'stale';
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
