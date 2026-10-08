'use strict';

import { cleanupTaskManagedProcesses } from '../processManager.js';
import { safeLogAudit } from '../audit.js';
import { cancelFallbackExecution } from '../mcp/fallbackExecutions.js';
import { clearSessionPolicy } from '../policyResolver.js';
import { getCurrentToolActivityContext, getToolActivity, onToolActivity, releaseTaskCancellationHold, requestCurrentTaskCancellation, requestCurrentTaskOperationStop, taskError } from '../toolActivity.js';
import { readTaskHistorySession } from '../taskHistoryStore.ts';
import { sanitizeDisplayText } from '../taskObservability.js';
import { OPERATION_IDS as OP } from './operationIds.js';

async function stopTaskOperations(config, args = {}) {
  const taskId = String(args.work_id || '').trim();
  if (!taskId) throw taskError('TASK_ID_REQUIRED', 'work_id is required to stop running task operations.');

  const operationId = String(args.operationId || '').trim();
  const reason = sanitizeDisplayText(args.reason || 'Running operation stopped by request.', 500);
  // A resilient receipt may be taskless while this exact operation is tracked
  // by the verified task. Each owner checks its own association; a receipt
  // mismatch must not bypass the task operation controller.
  const fallback = operationId.startsWith('fallback_')
    ? cancelFallbackExecution(operationId, { config, reason, expectedWorkId: taskId })
    : !operationId ? cancelFallbackExecution(taskId, { config, reason }) : null;
  const stopped = requestCurrentTaskOperationStop({
    operationId,
    reason,
    initiator: 'connector_client'
  });
  const fallbackStopped = fallback?.cancelled === true || fallback?.stopping === true;
  const fallbackOperationIds = fallbackStopped
    ? (fallback.records || [fallback.record]).map(record => String(record?.operationId || '')).filter(Boolean)
    : [];
  const stoppedOperationIds = [...new Set([
    ...stopped.stoppedOperationIds,
    ...fallbackOperationIds
  ])];
  const stoppedOperationCount = stoppedOperationIds.length;
  return {
    ok: true,
    work_id: stopped.taskId,
    status: stopped.status,
    duplicate: stoppedOperationCount === 0,
    ...(operationId ? { operationId } : {}),
    stoppedOperationIds,
    stoppedOperationCount,
    message: stoppedOperationCount
      ? `Stop requested for ${stoppedOperationCount} running operation${stoppedOperationCount === 1 ? '' : 's'}.`
      : 'No matching running task operation needed to be stopped.'
  };
}

async function cancelTask(config, args = {}, handlerContext = {}) {
  const taskId = String(args.work_id || '').trim();
  if (!taskId) throw taskError('TASK_ID_REQUIRED', 'work_id is required to cancel a work session.');
  const session = readTaskHistorySession(config, taskId, {
    reconcileInactive: true, persistReconciliation: false,
    activeTaskIds: getToolActivity().tasks.map(task => String(task.id || task.taskId || '')).filter(Boolean)
  });
  const workspace = String(session?.workspace || '').trim();
  if (session?.status === 'cancelled') {
    // callTool already verified the persisted task/principal. Terminal retries
    // are read-only and have no live activity context: do not perform cleanup
    // or request fallback cancellation again.
    return {
      ok: true,
      work_id: taskId,
      status: 'cancelled',
      duplicate: true,
      endReason: session.endReason || 'explicit_cancellation',
      terminalReason: session.terminalReason || session.currentActivity || 'Work session cancelled.',
      endedAt: session.endedAt || null,
      cancelledAt: session.cancelledAt || session.endedAt || null,
      progress: session.progress
    };
  }

  // Every new side effect still requires the exact active task context.
  if (getCurrentToolActivityContext()?.taskId !== taskId) {
    throw taskError('TASK_OWNERSHIP_MISMATCH', 'The supplied work_id does not match the active cancellation invocation.');
  }
  const reason = sanitizeDisplayText(args.reason || 'Work session cancelled by request.', 500);
  const fallbackCancellation = cancelFallbackExecution(taskId, { config, reason });
  const fallbackSettlement = fallbackCancellation.stopping === true && fallbackCancellation.settlement
    ? fallbackCancellation.settlement
    : null;
  const cancellation = requestCurrentTaskCancellation({
    reason,
    initiator: 'connector_client',
    externalPending: Boolean(fallbackSettlement) || Boolean(workspace)
  });
  if (cancellation.status === 'cancelling' && cancellation.duplicate !== true) {
    auditCancellationWhenCommitted(config, { taskId, workspace, reason });
  }
  const cleanupPromise = workspace
    ? cleanupCancelledTaskProcesses(config, workspace, taskId, handlerContext)
    : Promise.resolve(null);
  const releaseCancellationHold = () => releaseTaskCancellationHold(taskId);
  const settlement = Promise.all([fallbackSettlement, cleanupPromise]);
  void settlement.then(releaseCancellationHold, releaseCancellationHold);
  const processCleanup = await cleanupPromise;
  if (!fallbackSettlement) releaseCancellationHold();
  if (workspace) clearSessionPolicy(config, workspace, taskId);
  const settledCancellation = fallbackSettlement ? cancellation : requestCurrentTaskCancellation({ reason, initiator: 'connector_client' });

  return {
    ok: true,
    work_id: cancellation.taskId,
    status: settledCancellation.status,
    duplicate: cancellation.duplicate,
    endReason: cancellation.endReason,
    terminalReason: cancellation.terminalReason,
    endedAt: settledCancellation.endedAt,
    cancelledAt: settledCancellation.cancelledAt,
    progress: cancellation.progress,
    ...(processCleanup ? { processCleanup } : {})
  };
}

async function cleanupCancelledTaskProcesses(config, workspace, taskId, context) {
  try {
    // Cancellation has already aborted the task signal. Cleanup has its own
    // bounded termination waits and must still be allowed to settle.
    return await cleanupTaskManagedProcesses(config, workspace, taskId, { ...context, taskId, workspace });
  } catch (error) {
    return {
      attempted: 0, stopped: 0, preservedPersistent: 0, complete: false,
      admissionBudgetMs: 0, stopGraceMs: 500, forceWaitMs: 2000, leftovers: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function auditCancellationWhenCommitted(config, { taskId, workspace, reason }) {
  const stopListening = onToolActivity(activity => {
    if (String(activity?.phase || '') !== 'cancelled') return;
    const eventTaskId = String(activity?.taskId || activity?.task?.taskId || activity?.task?.id || '').trim();
    if (eventTaskId !== taskId) return;
    stopListening();
    void safeLogAudit(config, {
      taskId,
      taskIdentityVersion: 2,
      taskIdExplicit: true,
      taskHistoryEligible: true,
      eventType: 'task.cancellation.committed',
      tool: OP.WORK_CANCEL,
      publicTool: 'relai_work',
      action: 'cancel',
      ok: true,
      workspace,
      taskCancellationStatus: 'cancelled',
      endReason: 'explicit_cancellation',
      terminalReason: reason,
      deferredCancellation: true
    });
  });
}

export { cancelTask, stopTaskOperations };
