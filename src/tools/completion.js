import { resolveWorkspace } from '../config.js';
import { clearSessionPolicy, resolvePolicy } from '../policyResolver.js';
import { readTaskHistorySession, readTaskHistorySessionRecord } from '../taskHistoryStore.ts';
import { recordTaskValidationAffinity } from '../knowledgeStore.js';
import { readTaskIntegrity } from '../taskIntegrity.ts';
import { workspaceDirtyPaths } from '../repo/gitOps.js';
import { createValidationFingerprint } from '../bridge/validationPlan.js';
import { sanitizeCompletionSummary } from '../taskObservability.js';
import { getCurrentTaskAbortSignal, getCurrentToolActivityContext, getToolActivity, requestCurrentTaskCompletion, taskError, normalizeTaskId } from '../toolActivity.js';
import { runWorkspaceMutationBoundary } from '../workspaceOperationQueue.js';

const WORK_FINISH_SOURCE = 'relai_work:finish';
const VALIDATE_CHECKS_SOURCE = 'relai_validate:checks';

async function completeTask(config, args = {}) {
  const workspace = resolveWorkspace(config, args.workspace);
  const requestedTaskId = normalizeTaskId(args.work_id);
  if (!requestedTaskId) {
    throw taskError('TASK_ID_REQUIRED', 'relai_work with action "finish" requires the work_id returned by relai_work with action "begin".');
  }
  const context = requireMatchingTaskContext(requestedTaskId);
  const previous = readTaskHistorySession(config, requestedTaskId);
  if (previous?.completionKnown === true || previous?.status === 'completed') {
    return finalizeDuplicateCompletion(config, workspace, context, previous);
  }
  if (previous?.status === 'cancelled' || previous?.status === 'failed') {
    throw taskError(
      'INVALID_TASK_STATE',
      `Cannot complete a work session whose terminal status is '${previous.status}'. Start a new work session for additional work.`,
      { retryable: false }
    );
  }

  const summary = normalizeCompletionSummary(args.summary);
  const authority = readTaskIntegrity(config, requestedTaskId, workspace.alias);
  const validation = await factualValidationState(config, workspace, authority);
  return finalizeValidatedTask(config, workspace, {
    summary,
    validationStatus: validation.status,
    validationLevel: authority?.validationLevel || '',
    validationAt: authority?.validationAt || '',
    validationFingerprint: validation.fingerprint,
    changedFiles: authority?.taskOwnedChangedFiles || previous?.changedFiles || [],
    completionSource: WORK_FINISH_SOURCE
  });
}

async function finalizeValidatedTask(config, workspace, options = {}) {
  const summary = normalizeCompletionSummary(options.summary);
  const context = getCurrentToolActivityContext();
  if (!context?.taskId) {
    throw taskError('CONNECTION_CONTEXT_UNAVAILABLE', 'Work-session completion requires an active Rel.AI tool invocation.');
  }
  const taskId = normalizeTaskId(context.taskId);
  if (!taskId) {
    throw taskError('TASK_OWNERSHIP_MISMATCH', 'The active invocation has no valid logical task identity.');
  }
  const changedFiles = Array.isArray(options.changedFiles)
    ? unique(options.changedFiles.map(String).filter(Boolean))
    : changedFilesForTask(config, workspace.alias, taskId);
  const completionSource = String(options.completionSource || WORK_FINISH_SOURCE);
  const validationStatus = String(options.validationStatus || 'not_run');
  const residualChangedFiles = await workspaceDirtyPaths(workspace, config, changedFiles);
  const residualState = residualChangedFiles.length ? 'preserved_uncommitted' : 'clean';
  const persistedLearningSession = readTaskHistorySessionRecord(config, taskId, { reconcileInactive: false }) || {};
  const liveLearningSession = getToolActivity().tasks.find(task => task.id === taskId || task.taskId === taskId) || {};
  const learningSession = {
    ...persistedLearningSession,
    ...liveLearningSession,
    workflowEvidence: persistedLearningSession.workflowEvidence || [],
    changedFiles
  };
  const goalMode = learningSession.goalMode === true || learningSession.mode === 'goal';
  const completion = requestCurrentTaskCompletion({
    summary,
    validationStatus,
    validationLevel: String(options.validationLevel || ''),
    validationAt: String(options.validationAt || ''),
    changedFiles,
    residualChangedFiles,
    residualState
  });
  const result = {
    ok: true,
    workspace: workspace.alias,
    work_id: completion.taskId,
    duplicate: completion.duplicate === true,
    completionKnown: true,
    ...(goalMode ? { mode: 'goal', goal_completed: true } : {}),
    endReason: 'explicit_completion',
    completionSource,
    summary,
    validationStatus,
    validationLevel: String(options.validationLevel || ''),
    validationAt: String(options.validationAt || ''),
    validationFingerprint: String(options.validationFingerprint || ''),
    changedFiles,
    residualChangedFiles,
    residualState,
    message: completionMessage(completionSource, completion.duplicate === true, residualChangedFiles)
  };
  try { recordTaskValidationAffinity(config, workspace, learningSession, result); }
  catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] validation affinity learning:', error); }
  clearSessionPolicy(config, workspace.alias, taskId);
  return result;
}

async function finalizeValidationResult(config, workspace, validationResult, summary) {
  const context = getCurrentToolActivityContext();
  const completion = await runWorkspaceMutationBoundary(workspace.alias, () => finalizeValidatedTask(config, workspace, {
    summary,
    validationStatus: 'passed',
    validationLevel: validationResult.validationLevel,
    validationAt: new Date().toISOString(),
    validationFingerprint: validationResult.validationFingerprint,
    completionSource: VALIDATE_CHECKS_SOURCE
  }), {
    taskId: context?.taskId || '',
    signal: getCurrentTaskAbortSignal()
  });
  return {
    ...validationResult,
    ...completion,
    policy: resolvePolicy(workspace, config),
    nextAction: 'Validation passed and explicit task completion was accepted. Do not call another Rel.AI tool for this completed task.'
  };
}

function finalizeDuplicateCompletion(config, workspace, context, previous) {
  const summary = String(previous.summary || '').trim() || 'Task already completed.';
  const completion = requestCurrentTaskCompletion({
    summary,
    validationStatus: previous.validation || 'not_run',
    validationLevel: previous.validationLevel || '',
    validationAt: previous.validationAt || previous.completedAt || '',
    changedFiles: Array.isArray(previous.changedFiles) ? previous.changedFiles : [],
    residualChangedFiles: Array.isArray(previous.residualChangedFiles) ? previous.residualChangedFiles : [],
    residualState: String(previous.residualState || (Array.isArray(previous.residualChangedFiles) && previous.residualChangedFiles.length ? 'preserved_uncommitted' : 'clean'))
  });
  clearSessionPolicy(config, workspace.alias, context.taskId);
  const goalMode = previous?.goalMode === true || previous?.mode === 'goal';
  return {
    ok: true,
    workspace: workspace.alias,
    work_id: context.taskId,
    duplicate: true,
    completionKnown: true,
    ...(goalMode ? { mode: 'goal', goal_completed: true } : {}),
    endReason: 'explicit_completion',
    completionSource: WORK_FINISH_SOURCE,
    summary,
    validationStatus: previous.validation || 'not_run',
    validationLevel: previous.validationLevel || '',
    validationAt: previous.validationAt || previous.completedAt || '',
    changedFiles: Array.isArray(previous.changedFiles) ? previous.changedFiles : [],
    residualChangedFiles: Array.isArray(previous.residualChangedFiles) ? previous.residualChangedFiles : [],
    residualState: String(previous.residualState || (Array.isArray(previous.residualChangedFiles) && previous.residualChangedFiles.length ? 'preserved_uncommitted' : 'clean')),
    message: completion.duplicate === true
      ? 'Duplicate task completion request accepted; the task was already completing.'
      : 'Task was already completed. The original completion result is returned idempotently.'
  };
}

async function factualValidationState(config, workspace, authority) {
  if (!authority) return { status: 'not_run', fingerprint: '' };
  const mutationGeneration = Number(authority.mutationGeneration || 0);
  const validationResult = String(authority.validationResult || 'not_run');
  const fingerprint = String(authority.validatedRepositoryFingerprint || authority.validationFingerprint || '');
  if (validationResult !== 'passed') {
    if (validationResult === 'failed' || validationResult === 'stale') return { status: validationResult, fingerprint };
    return { status: mutationGeneration > 0 ? 'not_run' : 'not_required', fingerprint };
  }
  if (Number(authority.latestValidatedMutationGeneration || 0) !== mutationGeneration) {
    return { status: 'stale', fingerprint };
  }
  if (fingerprint) {
    const validationScope = Array.isArray(authority.validationScope)
      ? authority.validationScope
      : (authority.taskOwnedChangedFiles || []);
    const currentFingerprint = await createValidationFingerprint(workspace, config, { paths: validationScope });
    if (currentFingerprint.fingerprint !== fingerprint) return { status: 'stale', fingerprint };
  }
  return { status: 'passed', fingerprint };
}

function requireMatchingTaskContext(taskId) {
  const context = getCurrentToolActivityContext();
  if (!context?.taskId) {
    throw taskError('CONNECTION_CONTEXT_UNAVAILABLE', 'Task completion requires an active Rel.AI tool invocation.');
  }
  if (context.taskId !== taskId) {
    throw taskError('TASK_OWNERSHIP_MISMATCH', 'The supplied work_id does not match the logical task bound to this invocation.');
  }
  return context;
}

function completionMessage(source, duplicate, residualChangedFiles = []) {
  if (duplicate) return 'Duplicate work-session completion request accepted idempotently.';
  const residualCount = Array.isArray(residualChangedFiles) ? residualChangedFiles.length : 0;
  const residualNote = residualCount
    ? ` ${residualCount} task-owned path${residualCount === 1 ? '' : 's'} remain as explicit preserved uncommitted work.`
    : ' Task-owned paths are reconciled with the current commit.';
  if (source === VALIDATE_CHECKS_SOURCE) {
    return `Validation passed and this work session was completed in the same Rel.AI call. Other work sessions remain unchanged.${residualNote}`;
  }
  return `Work-session completion accepted for this work_id. Other work sessions remain active and unchanged.${residualNote}`;
}

function normalizeCompletionSummary(value) {
  return sanitizeCompletionSummary(value, 2000);
}

function changedFilesForTask(config, workspaceAlias, taskId) {
  return readTaskIntegrity(config, taskId, workspaceAlias)?.taskOwnedChangedFiles || [];
}

function unique(values) {
  return [...new Set(values)];
}

export { completeTask,  finalizeValidationResult, normalizeCompletionSummary,   };
