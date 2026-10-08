import { cleanupTaskManagedProcesses } from '../processManager.js';
import { resolveWorkspace } from '../config.js';
import { clearSessionPolicy, resolvePolicy } from '../policyResolver.js';
import { readTaskHistorySession, readTaskHistorySessionRecord } from '../taskHistoryStore.ts';
import { recordTaskValidationAffinity } from '../knowledgeStore.js';
import { readTaskIntegrity, taskOwnedChangedFiles } from '../taskIntegrity.ts';
import { cleanupTaskEphemeralDirectory, cleanupTaskWorkspaceEphemeralFiles } from '../taskEphemeral.ts';
import { workspaceDirtyPaths } from '../repo/gitOps.js';
import { createValidationFingerprint } from '../bridge/validationPlan.js';
import { sanitizeCompletionSummary } from '../taskObservability.js';
import { getCurrentTaskAbortSignal, getCurrentToolActivityContext, getToolActivity, requestCurrentTaskCompletion, taskError, normalizeTaskId } from '../toolActivity.js';
import { runWorkspaceMutationBoundary } from '../workspaceOperationQueue.js';
import { assertFallbackCompletionAvailable } from '../mcp/fallbackExecutions.js';

const WORK_FINISH_SOURCE = 'relai_work:finish';
const VALIDATE_CHECKS_SOURCE = 'relai_validate:checks';

async function completeTask(config, args = {}, handlerContext = {}) {
  const requestedTaskId = normalizeTaskId(args.work_id);
  if (!requestedTaskId) {
    throw taskError('TASK_ID_REQUIRED', 'relai_work with action "finish" requires the work_id returned by relai_work with action "begin".');
  }
  const context = requireMatchingTaskContext(requestedTaskId);
  const signal = handlerContext.signal || getCurrentTaskAbortSignal();
  signal?.throwIfAborted?.();
  const previous = readTaskHistorySession(config, requestedTaskId, {
    reconcileInactive: true, persistReconciliation: false,
    activeTaskIds: getToolActivity().tasks.map(task => String(task.id || task.taskId || '')).filter(Boolean)
  });
  const workspaceAlias = String(previous?.workspace || '').trim();
  const workspace = workspaceAlias ? resolveWorkspace(config, workspaceAlias) : null;
  if (previous?.completionKnown === true || previous?.status === 'completed') {
    return finalizeDuplicateCompletion(config, workspace, context, previous, handlerContext);
  }
  if (previous?.status === 'cancelled' || previous?.status === 'failed') {
    throw taskError(
      'INVALID_TASK_STATE',
      `Cannot complete a work session whose terminal status is '${previous.status}'. Start a new work session for additional work.`,
      { retryable: false }
    );
  }

  const summary = normalizeCompletionSummary(args.summary);
  assertFallbackCompletionAvailable(requestedTaskId, { config, excludeOperationId: handlerContext.fallbackOperationId });
  if (!workspace) return finalizeProjectlessTask(summary);
  const authority = readCompletionIntegrity(config, requestedTaskId, workspace.alias);
  const validation = await factualValidationState(config, workspace, authority, { signal });
  return finalizeValidatedTask(config, workspace, {
    summary,
    validationStatus: validation.status,
    validationLevel: authority?.validationLevel || '',
    validationAt: authority?.validationAt || '',
    validationFingerprint: validation.fingerprint,
    changedFiles: authority ? taskOwnedChangedFiles(config, requestedTaskId, workspace.alias) : previous?.changedFiles || [],
    completionSource: WORK_FINISH_SOURCE,
    processContext: handlerContext,
    signal
  });
}

function finalizeProjectlessTask(summary) {
  const completion = requestCurrentTaskCompletion({
    summary,
    validationStatus: 'not_required',
    validationLevel: '',
    validationAt: '',
    changedFiles: [],
    residualChangedFiles: [],
    residualState: 'clean'
  });
  return {
    ok: true,
    work_id: completion.taskId,
    duplicate: completion.duplicate === true,
    completionKnown: true,
    endReason: 'explicit_completion',
    completionSource: WORK_FINISH_SOURCE,
    summary,
    validationStatus: 'not_required',
    validationLevel: '',
    validationAt: '',
    validationFingerprint: '',
    changedFiles: [],
    residualChangedFiles: [],
    residualState: 'clean',
    message: completionMessage(WORK_FINISH_SOURCE, completion.duplicate === true, [])
  };
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
  const authority = options.completionSource === VALIDATE_CHECKS_SOURCE
    ? readTaskIntegrity(config, taskId, workspace.alias)
    : readCompletionIntegrity(config, taskId, workspace.alias);
  const processCleanup = await cleanupTaskManagedProcesses(config, workspace.alias, taskId, {
    ...options.processContext, taskId, workspace: workspace.alias
  });
  options.signal?.throwIfAborted?.();
  if (!processCleanup.complete) {
    return {
      ok: false, workspace: workspace.alias, work_id: taskId,
      completionKnown: false, summary, processCleanup,
      errorCode: 'PROCESS_CLEANUP_INCOMPLETE',
      error: 'Task completion is blocked because owned task-process cleanup is incomplete.',
      nextAction: 'Inspect processCleanup.leftovers and recover only the exact owned process IDs. If cleanup cannot be verified, preserve the evidence and cancel the work session instead of claiming completion.'
    };
  }
  const scratchCleanup = await cleanupTaskScratch(config, workspace, taskId, authority, options.signal);
  const changedFiles = Array.isArray(options.changedFiles)
    ? unique(options.changedFiles.map(String).filter(Boolean))
    : changedFilesForTask(config, workspace.alias, taskId);
  const completionSource = String(options.completionSource || WORK_FINISH_SOURCE);
  let validationStatus = String(options.validationStatus || 'not_run');
  // Manual finish reports existing evidence after all cleanup. Atomic
  // validate-close checks its own current result below, never the old audit.
  if (validationStatus === 'passed' && completionSource !== VALIDATE_CHECKS_SOURCE) {
    validationStatus = (await factualValidationState(config, workspace, readCompletionIntegrity(config, taskId, workspace.alias), { signal: options.signal })).status;
  }
  const residualChangedFiles = await workspaceDirtyPaths(workspace, config, changedFiles, { signal: options.signal });
  const residualState = residualChangedFiles.length ? 'preserved_uncommitted' : 'clean';
  const persistedLearningSession = readTaskHistorySessionRecord(config, taskId, { reconcileInactive: false }) || {};
  const liveLearningSession = getToolActivity().tasks.find(task => task.id === taskId || task.taskId === taskId) || {};
  const learningSession = {
    ...persistedLearningSession,
    ...liveLearningSession,
    workflowEvidence: persistedLearningSession.workflowEvidence || [],
    changedFiles
  };
  if (completionSource === VALIDATE_CHECKS_SOURCE) {
    const checked = options.currentValidationResult;
    const fingerprint = String(checked?.validationFingerprint || '');
    const scope = checked?.validationScope;
    const current = fingerprint && Array.isArray(scope)
      ? await createValidationFingerprint(workspace, config, { paths: scope, signal: options.signal })
      : null;
    if (checked?.ok !== true || checked?.validationStatus !== 'passed'
      || !current || current.fingerprint !== fingerprint) {
      return {
        ok: false, workspace: workspace.alias, work_id: taskId,
        completionKnown: false, summary, validationStatus: 'stale',
        validationLevel: String(options.validationLevel || ''),
        validationFingerprint: fingerprint, processCleanup,
        residualChangedFiles, residualState,
        nextAction: 'Validation is stale at the final completion boundary. The work session remains open; validate the current content before requesting atomic completion.'
      };
    }
  }
  options.signal?.throwIfAborted?.();
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
    processCleanup,
    message: completionMessage(completionSource, completion.duplicate === true, residualChangedFiles, scratchCleanup, processCleanup, validationStatus)
  };
  try { recordTaskValidationAffinity(config, workspace, learningSession, result); }
  catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] validation affinity learning:', error); }
  clearSessionPolicy(config, workspace.alias, taskId);
  return result;
}

async function finalizeValidationResult(config, workspace, validationResult, summary, executionContext = {}) {
  const activityContext = getCurrentToolActivityContext();
  const signal = executionContext.signal || getCurrentTaskAbortSignal();
  signal?.throwIfAborted?.();
  assertFallbackCompletionAvailable(activityContext?.taskId || '', { config, excludeOperationId: executionContext.fallbackOperationId });
  const completion = await runWorkspaceMutationBoundary(workspace.alias, () => finalizeValidatedTask(config, workspace, {
    summary,
    validationStatus: 'passed',
    validationLevel: validationResult.validationLevel,
    validationAt: new Date().toISOString(),
    validationFingerprint: validationResult.validationFingerprint,
    currentValidationResult: validationResult,
    completionSource: VALIDATE_CHECKS_SOURCE,
    processContext: executionContext,
    signal
  }), {
    taskId: activityContext?.taskId || '',
    signal
  });
  return {
    ...validationResult,
    ...completion,
    policy: resolvePolicy(workspace, config),
    nextAction: completion.completionKnown !== true ? completion.nextAction : completion.validationStatus === 'passed'
      ? 'Validation passed and explicit task completion was accepted. Do not call another Rel.AI tool for this completed task.'
      : `Work-session completion was accepted, but validation freshness is ${completion.validationStatus} after process cleanup. Use a new work session to revalidate the resulting files.`
  };
}

async function finalizeDuplicateCompletion(config, workspace, context, previous, handlerContext = {}) {
  const processCleanup = workspace ? await cleanupTaskManagedProcesses(config, workspace.alias, context.taskId, {
    ...handlerContext, taskId: context.taskId, workspace: workspace.alias
  }) : null;
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
  if (workspace) clearSessionPolicy(config, workspace.alias, context.taskId);
  return {
    ok: true,
    ...(workspace ? { workspace: workspace.alias } : {}),
    work_id: context.taskId,
    duplicate: true,
    completionKnown: true,
    endReason: 'explicit_completion',
    completionSource: WORK_FINISH_SOURCE,
    summary,
    validationStatus: previous.validation || 'not_run',
    validationLevel: previous.validationLevel || '',
    validationAt: previous.validationAt || previous.completedAt || '',
    changedFiles: Array.isArray(previous.changedFiles) ? previous.changedFiles : [],
    residualChangedFiles: Array.isArray(previous.residualChangedFiles) ? previous.residualChangedFiles : [],
    residualState: String(previous.residualState || (Array.isArray(previous.residualChangedFiles) && previous.residualChangedFiles.length ? 'preserved_uncommitted' : 'clean')),
    ...(processCleanup ? { processCleanup } : {}),
    message: (completion.duplicate === true
      ? 'Duplicate task completion request accepted; the task was already completing.'
      : 'Task was already completed. The original completion result is returned idempotently.') + completionProcessNote(processCleanup)
  };
}

function readCompletionIntegrity(config, taskId, workspace) {
  try { return readTaskIntegrity(config, taskId, workspace); }
  catch (error) {
    if (!/^TASK_INTEGRITY_/.test(String(error?.code || ''))) throw error;
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] completion integrity unavailable:', error);
    return null;
  }
}

async function factualValidationState(config, workspace, authority, options = {}) {
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
      : taskOwnedChangedFiles(config, authority.taskId, workspace.alias);
    const currentFingerprint = await createValidationFingerprint(workspace, config, { paths: validationScope, signal: options.signal });
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

async function cleanupTaskScratch(config, workspace, taskId, authority, signal) {
  let workspaceCleanup = { removedPaths: [], skippedPaths: [], error: '' };
  try {
    workspaceCleanup = {
      ...workspaceCleanup,
      ...await cleanupTaskWorkspaceEphemeralFiles(
        workspace,
        config,
        taskId,
        authority?.ephemeralWorkspaceFiles || [],
        { signal }
      )
    };
  } catch (error) {
    signal?.throwIfAborted?.();
    workspaceCleanup.error = error instanceof Error ? error.message : String(error);
  }

  const directoryCleanup = cleanupTaskEphemeralDirectory(config, taskId, workspace.path);
  return { workspace: workspaceCleanup, directory: directoryCleanup };
}

function completionScratchNote(cleanup) {
  if (!cleanup) return '';
  const removed = Array.isArray(cleanup.workspace?.removedPaths) ? cleanup.workspace.removedPaths.length : 0;
  const preserved = Array.isArray(cleanup.workspace?.skippedPaths) ? cleanup.workspace.skippedPaths.length : 0;
  const warnings = [
    cleanup.workspace?.error,
    cleanup.directory?.removed === false ? cleanup.directory?.error || 'task scratch directory could not be removed' : ''
  ].filter(Boolean);
  if (!removed && !preserved && !warnings.length) return '';
  const notes = [];
  if (removed) notes.push(`${removed} proven-ephemeral workspace file${removed === 1 ? '' : 's'} removed`);
  if (preserved) notes.push(`${preserved} declared scratch file${preserved === 1 ? '' : 's'} preserved because ownership, hash, or Git state changed`);
  if (warnings.length) notes.push(`scratch cleanup warning: ${warnings.join('; ')}`);
  return ` Scratch cleanup: ${notes.join('; ')}.`;
}

function completionProcessNote(cleanup) {
  if (!cleanup) return '';
  const notes = [];
  if (cleanup.stopped) notes.push(`${cleanup.stopped} task-lifetime process(es) stopped`);
  if (cleanup.preservedPersistent) notes.push(`${cleanup.preservedPersistent} persistent process(es) preserved`);
  if (cleanup.leftovers.length) notes.push(`${cleanup.leftovers.length} process(es) need recovery; see processCleanup.leftovers for identity and termination details`);
  return notes.length ? ` Process cleanup: ${notes.join('; ')}.` : '';
}

function completionMessage(source, duplicate, residualChangedFiles = [], scratchCleanup = null, processCleanup = null, validationStatus = 'passed') {
  if (duplicate) return 'Duplicate work-session completion request accepted idempotently.';
  const residualCount = Array.isArray(residualChangedFiles) ? residualChangedFiles.length : 0;
  const residualNote = residualCount
    ? ` ${residualCount} task-owned path${residualCount === 1 ? '' : 's'} remain as explicit preserved uncommitted work.`
    : ' Task-owned paths are reconciled with the current commit.';
  const scratchNote = completionScratchNote(scratchCleanup) + completionProcessNote(processCleanup);
  if (source === VALIDATE_CHECKS_SOURCE) {
    const validationNote = validationStatus === 'passed' ? 'Validation passed' : `Validation freshness is ${validationStatus} after process cleanup`;
    return `${validationNote} and this work session was completed in the same Rel.AI call. Other work sessions remain unchanged.${residualNote}${scratchNote}`;
  }
  return `Work-session completion accepted for this work_id. Other work sessions remain active and unchanged.${residualNote}${scratchNote}`;
}

function normalizeCompletionSummary(value) {
  return sanitizeCompletionSummary(value, 2000);
}

function changedFilesForTask(config, workspaceAlias, taskId) {
  return taskOwnedChangedFiles(config, taskId, workspaceAlias);
}

function unique(values) {
  return [...new Set(values)];
}

export { completeTask,  finalizeValidationResult, normalizeCompletionSummary,   };
