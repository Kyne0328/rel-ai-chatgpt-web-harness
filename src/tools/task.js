
import * as crypto from 'node:crypto';
import { getCurrentToolActivityContext, getToolActivity, taskError } from '../toolActivity.js';
import { findTaskReuseCandidates, readTaskHistory, readTaskHistorySessionRecord } from '../taskHistoryStore.ts';
import { principalFingerprint } from '../mcp/principal.js';
import { isTerminalTaskStatus } from '../taskState.js';
import { classifyTaskIntent } from '../workflow/intent.js';
import { buildTaskBootstrap } from '../context/context-builder.js';
import { OPERATION_IDS as OP } from './operationIds.js';

const TERMINAL_REFERENCE_OPERATIONS = new Set([OP.PROCESS_LIST, OP.PROCESS_READ, OP.PROCESS_STOP, OP.WORK_STATUS]);

function findReusableTask(config, workspace, args = {}, principal, conversationId = '') {
  const conversation = String(conversationId || '').trim();
  const workspaceAlias = String(workspace || '').trim();
  const objective = normalizeTaskGoal(args.objective);
  const title = normalizeTaskGoal(args.title);
  if (!conversation || !workspaceAlias || (!objective && !title)) return null;
  const expectedPrincipal = principalFingerprint(principal || 'anonymous');
  const matches = session => {
    if (!session || isTerminalTaskStatus(session.status)) return false;
    if (String(session.workspace || '') !== workspaceAlias) return false;
    if (String(session.correlation?.conversationId || '') !== conversation) return false;
    const sessionPrincipal = String(session.principalFingerprint || '');
    if (!sessionPrincipal || !safeEqual(sessionPrincipal, expectedPrincipal)) return false;
    if (objective) return normalizeTaskGoal(session.objective) === objective;
    return normalizeTaskGoal(session.title) === title;
  };
  const activity = getToolActivity();
  const live = activity.tasks.find(matches);
  if (live) return live;
  const narrowed = findTaskReuseCandidates(config, workspaceAlias, conversation, 24)
    .filter(session => !isTerminalTaskStatus(session?.status))
    .filter(session => String(session?.workspace || '') === workspaceAlias)
    .filter(session => String(session?.correlation?.conversationId || '') === conversation)
    .filter(session => objective
      ? normalizeTaskGoal(session?.objective) === objective
      : normalizeTaskGoal(session?.title) === title)
    .filter(matches);
  if (narrowed.length) return reuseResult(narrowed);
  // Fallback for short conversation ids (<4 chars, skipped by the SQL needle
  // search) or search quirks: bounded recent scan instead of the full 500.
  const persisted = readTaskHistory(config, activity, { limit: 50, summary: true })
    .filter(session => !isTerminalTaskStatus(session?.status))
    .filter(session => String(session?.workspace || '') === workspaceAlias)
    .filter(session => String(session?.correlation?.conversationId || '') === conversation)
    .filter(session => objective
      ? normalizeTaskGoal(session?.objective) === objective
      : normalizeTaskGoal(session?.title) === title)
    .map(session => readTaskHistorySessionRecord(config, session.id, { reconcileInactive: false }))
    .filter(matches);
  return reuseResult(persisted);
}

function reuseResult(candidates) {
  if (candidates.length > 1) {
    throw taskError(
      'TASK_RECOVERY_AMBIGUOUS',
      'Multiple unfinished Rel.AI work sessions match this ChatGPT conversation, project, and goal. Rel.AI will not create another duplicate task automatically.',
      {
        retryable: false,
        candidateCount: candidates.length,
        allowedAlternatives: [
          'Open Rel.AI Tasks and continue one of the matching unfinished work sessions by its work_id.',
          'Cancel obsolete matching tasks, then retry relai_work begin for this goal.'
        ]
      }
    );
  }
  return candidates[0] || null;
}

function normalizeTaskGoal(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Recovery suggestions must never cross a principal, conversation, or workspace.
// They do not select an implicit owner for an unattributed operation.
function taskAttributionHint(config, workspace, principal, conversationId) {
  const conversation = String(conversationId || '').trim();
  if (!conversation || !workspace) return '';
  const fingerprint = principalFingerprint(principal || 'anonymous');
  const activity = getToolActivity();
  const persisted = findTaskReuseCandidates(config, workspace, conversation, 24);
  const candidates = [...activity.tasks, ...persisted,
    ...(conversation.length < 4 ? readTaskHistory(config, activity, { limit: 50, summary: true })
      .filter(session => session.workspace === workspace && session.correlation?.conversationId === conversation)
      .map(session => readTaskHistorySessionRecord(config, session.id, { reconcileInactive: false })).filter(Boolean) : [])];
  const ids = [...new Set(candidates.filter(session =>
    !isTerminalTaskStatus(session.status)
    && String(session.workspace || '') === workspace
    && String(session.correlation?.conversationId || '') === conversation
    && safeEqual(String(session.principalFingerprint || ''), fingerprint)
  ).map(session => String(session.id || session.taskId || '')).filter(Boolean))];
  if (!ids.length) return '';
  return `Unfinished work in this conversation: ${ids.slice(0, 5).join(', ')}. Retry with the appropriate work_id to continue that task, or independent:true for intentionally separate workspace work. No task has been selected automatically.`;
}

function startTask(workspace, args = {}) {
  const context = getCurrentToolActivityContext();
  if (!context?.taskId) {
    throw taskError('CONNECTION_CONTEXT_UNAVAILABLE', 'Rel.AI could not create a work session for this request.');
  }
  return {
    ok: true,
    workspace: workspace.alias,
    work_id: context.taskId,
    status: 'planning',
    identity: 'work_session',
    workspaceBinding: { alias: workspace.alias },
    title: String(args.title || context.title || '').trim() || undefined,
    objective: String(args.objective || context.objective || '').trim() || undefined,
    intent: classifyTaskIntent(args.objective || context.objective),
    nextAction: 'Use this work_id on task operations and inspect directly with batched read/search/snapshot calls. relai_work context is optional deeper continuity retrieval, and relai_work status is for reconnect/recovery rather than routine polling.'
  };
}

function taskBootstrapFromSnapshot(snapshot, mode = 'compact') {
  return buildTaskBootstrap(snapshot, mode);
}

function assertKnownTask(config, taskId, workspace, toolName, principal, args = {}) {
  const activeTaskIds = new Set(getToolActivity().tasks.map(task => String(task.id || task.taskId || '')).filter(Boolean));
  const session = readTaskHistorySessionRecord(config, taskId, {
    reconcileInactive: true,
    activeTaskIds
  });
  if (!session) {
    throw taskError('TASK_NOT_FOUND', 'The supplied work_id is unknown or expired. Start a new work session with relai_work action "begin".');
  }
  const expectedPrincipal = String(session.principalFingerprint || '');
  const actualPrincipal = principalFingerprint(principal || 'anonymous');
  if (!expectedPrincipal || !safeEqual(expectedPrincipal, actualPrincipal)) {
    throw taskError('TASK_NOT_FOUND', 'The supplied work_id is unknown or expired. Start a new work session with relai_work action "begin".');
  }
  assertTaskWorkspaceOwnership(session, workspace);
  if (session.status === 'cancelled' && toolName === OP.WORK_CANCEL) return session;
  if (session.status === 'completed' && toolName === OP.WORK_FINISH) return session;
  if (isTerminalTaskReference(session, toolName, args)) return session;
  if (isTerminalTaskStatus(session.status)) {
    throw taskError('INVALID_TASK_STATE', `This work session is already ${session.status}. Start a new work session instead of reusing its work_id.`);
  }
  return session;
}

function assertTaskWorkspaceOwnership(session, workspace) {
  const requestedWorkspace = String(workspace || '').trim();
  const ownedWorkspace = String(session?.workspace || '').trim();
  if (requestedWorkspace && ownedWorkspace && requestedWorkspace !== ownedWorkspace) {
    throw taskError('TASK_OWNERSHIP_MISMATCH', 'The supplied work_id belongs to a different workspace.');
  }
}

function isTerminalTaskReference(session, toolName, args = {}) {
  if (!isTerminalTaskStatus(session?.status)) return false;
  const operation = String(toolName || '');
  if (TERMINAL_REFERENCE_OPERATIONS.has(operation)) return true;
  return (operation === OP.UI || operation === OP.BROWSER) && String(args?.action || '').trim().toLowerCase() === 'stop';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function taskAuditContext(context, activity, requestedTaskId, toolName, ok, value = null) {
  const duplicateCompletion = toolName === OP.WORK_FINISH && value?.duplicate === true;
  const duplicateCancellation = toolName === OP.WORK_CANCEL && value?.duplicate === true;
  const cancellationStatus = toolName === OP.WORK_CANCEL ? String(value?.status || '').trim().toLowerCase() : '';
  const cancellationPending = cancellationStatus === 'cancelling';
  const taskId = activity?.taskId || requestedTaskId || '';
  const taskHistoryEligible = toolName !== OP.WORK_STATUS
    && Boolean(taskId && (requestedTaskId || toolName === OP.WORK_BEGIN));
  return {
    taskId,
    scopeId: activity?.scopeId || '',
    operationId: activity?.operationId || '',
    requestId: context?.requestId == null ? '' : String(context.requestId),
    serverInstanceId: String(context?.serverInstanceId || ''),
    transportType: String(context?.transportType || ''),
    transportSessionId: String(context?.transportSessionId || ''),
    clientName: String(context?.clientName || ''),
    clientVersion: String(context?.clientVersion || ''),
    initializationRequestId: context?.initializationRequestId == null ? '' : String(context.initializationRequestId),
    taskIdentityVersion: taskHistoryEligible ? 2 : 0,
    taskIdExplicit: taskHistoryEligible,
    taskHistoryEligible,
    duplicateRequest: duplicateCompletion || duplicateCancellation,
    ...(cancellationStatus ? { taskCancellationStatus: cancellationStatus } : {}),
    eventType: toolName === OP.WORK_BEGIN
      ? (ok ? 'task.started' : 'task.start.rejected')
      : toolName === OP.WORK_FINISH
        ? (ok ? (duplicateCompletion ? 'task.completion.duplicate' : 'task.completion.committed') : 'task.completion.rejected')
        : toolName === OP.WORK_CANCEL
          ? (ok
            ? (cancellationPending ? 'task.cancellation.requested' : duplicateCancellation ? 'task.cancellation.duplicate' : 'task.cancellation.committed')
            : 'task.cancellation.rejected')
          : 'tool.call.completed'
  };
}

function withTaskIdentity(value, taskId) {
  const identity = String(taskId || '').trim();
  if (!identity) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value, work_id: identity };
  return { ok: true, value, work_id: identity };
}

export { startTask, taskBootstrapFromSnapshot, assertKnownTask, assertTaskWorkspaceOwnership, findReusableTask, taskAttributionHint, isTerminalTaskReference, taskAuditContext, withTaskIdentity };
