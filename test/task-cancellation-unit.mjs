import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { isProcessTreeAlive } from '../src/process.ts';
import { stopAllManagedProcesses } from '../src/processManager.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { isTerminalTaskReference } from '../src/tools/task.js';
import { createToolActivityTracker, resetToolActivity } from '../src/toolActivity.js';

let now = 1000;
const phases = [];
const tracker = createToolActivityTracker({ idleMs: 60_000, now: () => now });
tracker.onToolActivity(event => phases.push(event.phase));
const start = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin', workspace: 'repo', createTask: true });
const taskId = start.taskId;
start({ ok: true });
now = 2000;
const active = tracker.beginConnectorToolCall({ tool: 'relai_validate', internalOperation: 'validate.checks', workspace: 'repo', taskId });
active.update({
  status: 'validating',
  currentStage: 'Validating 1 of 3',
  currentActivity: 'First check passed.',
  progress: { mode: 'determinate', completedUnits: 1, totalUnits: 3, source: 'validation', label: '1 of 3 checks' }
});
assert.equal(active.signal.aborted, false);
assert.throws(() => tracker.cancelTask('unrelated-task', { reason: 'wrong task' }), error => error?.code === 'TASK_NOT_FOUND');
now = 3000;
const cancelled = tracker.cancelTask(taskId, { reason: 'Stop token=synthetic-cancel-secret now.', initiator: 'test' });
assert.equal(cancelled.status, 'cancelling');
assert.equal(cancelled.duplicate, false);
assert.equal(cancelled.progress.completedUnits, 1);
assert.equal(cancelled.progress.totalUnits, 3);
assert.equal(cancelled.endedAt, null, 'cancellation must not publish a terminal timestamp before owned work settles');
assert.equal(cancelled.cancelledAt, null, 'cancellation must not claim completion while an operation is still stopping');
assert.equal(active.signal.aborted, true);
assert.doesNotMatch(cancelled.terminalReason, /synthetic-cancel-secret/);
assert.equal(tracker.cancelTask(taskId, { reason: 'duplicate' }).duplicate, true);
assert.throws(() => active.requestCompletion({ summary: 'must not complete' }), error => error?.code === 'INVALID_TASK_STATE');
assert.throws(
  () => tracker.beginConnectorToolCall({ tool: 'relai_read', internalOperation: OP.READ, workspace: 'repo', taskId }),
  error => error?.code === 'INVALID_TASK_STATE',
  'new task work must not start after cancellation is requested'
);
active({ ok: false, error: 'Operation cancelled.', activity: { status: 'cancelled', summary: 'Validation cancelled.' } });
const final = tracker.getToolActivity();
assert.equal(final.state, 'idle');
assert.equal(final.lastTask.status, 'cancelled');
assert.equal(final.lastTask.endReason, 'explicit_cancellation');
assert.equal(final.lastTask.endedAt, 3000);
assert.equal(final.lastTask.cancelledAt, 3000);
assert.equal(final.lastTask.progress.completedUnits, 1);
assert.equal(final.lastTask.progress.totalUnits, 3);
assert.equal(phases.filter(phase => phase === 'cancelled').length, 1, 'cancellation must emit one terminal lifecycle transition');

const stopTracker = createToolActivityTracker({ idleMs: 60_000, now: () => now });
const stopStart = stopTracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: OP.WORK_BEGIN, workspace: 'repo', createTask: true });
const stopTaskId = stopStart.taskId;
stopStart({ ok: true });
const firstOperation = stopTracker.beginConnectorToolCall({ tool: 'relai_exec', internalOperation: OP.EXEC, workspace: 'repo', taskId: stopTaskId });
const secondOperation = stopTracker.beginConnectorToolCall({ tool: 'relai_read', internalOperation: OP.READ, workspace: 'repo', taskId: stopTaskId });
const stoppedOne = stopTracker.stopTaskOperations(stopTaskId, { operationId: firstOperation.operationId, reason: 'Stop only the hanging command.' });
assert.equal(stoppedOne.stoppedOperationCount, 1);
assert.deepEqual(stoppedOne.stoppedOperationIds, [firstOperation.operationId]);
assert.equal(firstOperation.signal.aborted, true);
assert.equal(secondOperation.signal.aborted, false, 'stopping one operation must not abort sibling operations or the task');
assert.notEqual(stopTracker.getToolActivity().tasks.find(task => task.taskId === stopTaskId)?.status, 'cancelled');
firstOperation({ ok: false, cancelled: true });
const stoppedRest = stopTracker.stopTaskOperations(stopTaskId, { reason: 'Stop remaining finite work.' });
assert.equal(stoppedRest.stoppedOperationCount, 1);
assert.equal(secondOperation.signal.aborted, true);
secondOperation({ ok: false, cancelled: true });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-cancellation-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
assert.equal(isTerminalTaskReference({ status: 'cancelled' }, OP.PROCESS_STOP), true);
assert.equal(isTerminalTaskReference({ status: 'completed' }, OP.UI, { action: 'stop' }), true);
assert.equal(isTerminalTaskReference({ status: 'cancelled' }, OP.UI, { action: 'snapshot' }), false);
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'cancel-fixture' }));
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  const { callTool: rawCallTool } = await import('../src/tools.js');
  const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });
  const { readTaskHistorySession } = await import('../src/taskHistoryStore.ts');
  const { readAudit } = await import('../src/audit.js');
  const { fallbackExecutionStatus, startFallbackExecution } = await import('../src/mcp/fallbackExecutions.js');
  resetToolActivity();
  const context = { publicHttpOnly: true, requestId: 'cancel-test' };
  const started = await callTool('relai_work', { action: 'begin', workspace: 'app', title: 'Cancelable task' }, context);
  assert.equal(started.status, 'planning');
  const managed = await callTool('relai_process', {
    action: 'start',
    workspace: 'app',
    work_id: started.work_id,
    executable: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    kind: 'service',
    purpose: 'Verify terminal task cleanup.',
    startupWaitMs: 20
  }, context);
  assert.equal(managed.status, 'running');
  let fallbackAbortObserved = false;
  let releaseFallback = null;
  const fallback = startFallbackExecution({
    config: { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') },
    workId: started.work_id,
    tool: 'relai_validate',
    workspace: 'app',
    signature: 'task-cancellation-fallback',
    run: signal => new Promise(resolve => {
      releaseFallback = () => resolve({ isError: true, structuredContent: { ok: false, cancelled: true } });
      const observeAbort = () => { fallbackAbortObserved = true; };
      if (signal.aborted) observeAbort();
      else signal.addEventListener('abort', observeAbort, { once: true });
    })
  });
  const result = await callTool('relai_work', { action: 'cancel',
    workspace: 'app',
    work_id: started.work_id,
    reason: 'User stopped this work.'
  }, context);
  assert.equal(result.ok, true);
  assert.equal(result.work_id, started.work_id);
  assert.equal(result.status, 'cancelling');
  assert.equal(result.duplicate, false);
  assert.equal(result.endReason, 'cancellation_requested');
  assert.equal(result.endedAt, undefined, 'nonterminal cancellation must not publish a terminal timestamp');
  assert.equal(fallbackAbortObserved, true, 'relai_work cancel must abort detached fallback execution, not only the logical task tracker');
  const stoppingFallback = fallbackExecutionStatus(started.work_id);
  assert.equal(stoppingFallback.status, 'running', 'task cancellation must remain nonterminal while detached work has not settled');
  assert.equal(stoppingFallback.stopping, true);
  releaseFallback();
  await fallback.record.promise;
  await Promise.resolve();
  assert.equal(fallbackExecutionStatus(started.work_id).status, 'cancelled');
  const stopped = await callTool('relai_process', {
    action: 'stop',
    workspace: 'app',
    work_id: started.work_id,
    processId: managed.processId,
    graceMs: 0
  }, context);
  assert.equal(stopped.status, 'stopped', 'terminal task identity must remain usable for owned resource cleanup');
  assert.equal(isProcessTreeAlive(stopped.pid), false, 'managed process stop must not report stopped while its PID is still alive');

  const persisted = readTaskHistorySession({ stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') }, started.work_id);
  assert.equal(persisted.status, 'cancelled');
  assert.equal(persisted.endReason, 'explicit_cancellation');
  assert.ok(persisted.endedAt);
  assert.equal(persisted.progress.percentage === 100, false, 'cancelled work must not be fabricated as complete');

  const duplicate = await callTool('relai_work', { action: 'cancel',
    workspace: 'app', work_id: started.work_id, reason: 'Retry'
  }, context);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(
    () => callTool('relai_read', { workspace: 'app', work_id: started.work_id, paths: ['package.json'] }, context),
    error => error?.code === 'INVALID_TASK_STATE'
  );
  await assert.rejects(
    () => callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: 'unknown-task', reason: 'Wrong target' }, context),
    error => error?.code === 'TASK_NOT_FOUND'
  );
  let cancellationRequestedAudit = false;
  let cancellationCommittedAudit = false;
  for (let index = 0; index < 100 && !cancellationCommittedAudit; index += 1) {
    await flushAuditWrites();
    const audit = readAudit({ stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') }, { limit: 100 });
    cancellationRequestedAudit = audit.entries.some(entry => entry.taskId === started.work_id && entry.eventType === 'task.cancellation.requested');
    cancellationCommittedAudit = audit.entries.some(entry => entry.taskId === started.work_id && entry.eventType === 'task.cancellation.committed');
    if (!cancellationCommittedAudit) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(cancellationRequestedAudit, true, 'two-phase cancellation must preserve the initial cancellation-request audit event');
  assert.equal(cancellationCommittedAudit, true, 'deferred task cancellation must persist a terminal cancellation audit event after owned work settles');
} finally {
  await stopAllManagedProcesses({ stateDir }).catch(() => {});
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  await repositoryIntelligence.shutdown();
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log('Explicit logical-task cancellation is exact, idempotent, terminal, persistent, and preserves partial progress.');
