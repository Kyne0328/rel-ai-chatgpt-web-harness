'use strict';

import { safeLogAudit } from '../audit.js';
import { cancelFallbackExecution } from '../mcp/fallbackExecutions.js';
import { clearSessionPolicy } from '../policyResolver.js';
import { onToolActivity, releaseTaskCancellationHold, requestCurrentTaskCancellation, requestCurrentTaskOperationStop, taskError } from '../toolActivity.js';
import { readTaskHistorySession } from '../taskHistoryStore.ts';
import { sanitizeDisplayText } from '../taskObservability.js';
import { OPERATION_IDS as OP } from './operationIds.js';

async function stopTaskOperations(config, args = {}) {
  const taskId = String(args.work_id || '').trim();
  if (!taskId) throw taskError('TASK_ID_REQUIRED', 'work_id is required to stop running task operations.');

  const operationId = String(args.operationId || '').trim();
  const reason = sanitizeDisplayText(args.reason || 'Running operation stopped by request.', 500);
  if (operationId.startsWith('fallback_')) {
    const fallback = cancelFallbackExecution(operationId, { config, reason, expectedWorkId: taskId });
    const session = readTaskHistorySession(config, taskId);
    const stopRequested = fallback.cancelled === true || fallback.stopping === true;
    const stoppedOperationCount = stopRequested ? 1 : 0;
    return {
      ok: true,
      work_id: taskId,
      status: String(session?.status || 'running'),
      duplicate: fallback.duplicate || !stopRequested,
      operationId,
      stoppedOperationIds: stoppedOperationCount ? [operationId] : [],
      stoppedOperationCount,
      message: stoppedOperationCount
        ? 'Stop requested for 1 running operation.'
        : 'No matching running task operation needed to be stopped.'
    };
  }

  const fallback = !operationId ? cancelFallbackExecution(taskId, { config, reason }) : null;
  const stopped = requestCurrentTaskOperationStop({
    operationId,
    reason,
    initiator: 'connector_client'
  });
  const fallbackStopped = fallback?.cancelled === true || fallback?.stopping === true;
  const fallbackOperationId = fallbackStopped ? String(fallback?.record?.operationId || '').trim() : '';
  const stoppedOperationIds = [...new Set([
    ...stopped.stoppedOperationIds,
    ...(fallbackOperationId ? [fallbackOperationId] : [])
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

async function cancelTask(config, args = {}) {
  const taskId = String(args.work_id || '').trim();
  if (!taskId) throw taskError('TASK_ID_REQUIRED', 'work_id is required to cancel a work session.');

  const reason = sanitizeDisplayText(args.reason || 'Work session cancelled by request.', 500);
  const fallbackCancellation = cancelFallbackExecution(taskId, { config, reason });
  const fallbackSettlement = fallbackCancellation.stopping === true && fallbackCancellation.settlement
    ? fallbackCancellation.settlement
    : null;

  const session = readTaskHistorySession(config, taskId);
  const workspace = String(args.workspace || session?.workspace || '').trim();
  if (session?.status === 'cancelled') {
    if (workspace) clearSessionPolicy(config, workspace, taskId);
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

  const cancellation = requestCurrentTaskCancellation({
    reason,
    initiator: 'connector_client',
    externalPending: Boolean(fallbackSettlement)
  });
  if (cancellation.status === 'cancelling' && cancellation.duplicate !== true) {
    auditCancellationWhenCommitted(config, { taskId, workspace, reason });
  }
  if (fallbackSettlement) {
    const releaseCancellationHold = () => releaseTaskCancellationHold(taskId);
    void fallbackSettlement.then(releaseCancellationHold, releaseCancellationHold);
  }
  if (workspace) clearSessionPolicy(config, workspace, taskId);

  return {
    ok: true,
    work_id: cancellation.taskId,
    status: cancellation.status,
    duplicate: cancellation.duplicate,
    endReason: cancellation.endReason,
    terminalReason: cancellation.terminalReason,
    endedAt: cancellation.endedAt,
    cancelledAt: cancellation.cancelledAt,
    progress: cancellation.progress
  };
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
