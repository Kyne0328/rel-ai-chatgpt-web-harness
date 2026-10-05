import assert from 'node:assert/strict';
import { createOperationTimeline } from '../src/operationTimeline.js';
import { runWorkspaceOperation, runWorkspaceMutationBoundary, pendingWorkspaceOperations } from '../src/workspaceOperationQueue.js';
import { sanitizeActivityMetadata, sanitizeTaskRecordForProjection } from '../src/taskObservability.js';

let now = 1_000;
const updates = [];
const timeline = createOperationTimeline({ now: () => now, onUpdate: value => updates.push(value), deadlineKind: 'operation' });
now = 1_020;
timeline.transition('queued', { blocking: { owner: 'Build', operationId: 'owner-1', taskId: 'task-1', secret: 'must not copy' }, queuePosition: 2 });
now = 1_070;
assert.equal(timeline.snapshot().phases.at(-1).durationMs, 50);
timeline.transition('admitted', { queueWaitMs: 50 });
assert.equal(timeline.snapshot().blocking, undefined);
assert.equal(timeline.snapshot().queuePosition, undefined);
timeline.transition('preparing');
timeline.transition('spawned', { executed: true });
now = 1_100;
timeline.transition('exited', { terminationConfirmed: true });
timeline.transition('draining-output');
now = 1_140;
timeline.transition('reconciling', { outputFinalizationTimedOut: true });
now = 1_150;
timeline.transition('persisting');
now = 1_160;
timeline.transition('result-ready');
const receipt = timeline.finish();
assert.equal(receipt.executed, true);
assert.equal(receipt.terminationCertainty, 'confirmed');
assert.equal(receipt.childExitedAt, new Date(1_100).toISOString());
assert.equal(receipt.phases.find(item => item.phase === 'draining-output').durationMs, 40);
assert.equal(receipt.phases.find(item => item.phase === 'persisting').durationMs, 10);
assert.equal(receipt.phases.reduce((sum, item) => sum + item.durationMs, 0), 160);
now = 2_000;
assert.deepEqual(timeline.snapshot(), receipt, 'settled timings must not grow on repeated polls');
assert.ok(updates.length > 5);
assert.equal(sanitizeActivityMetadata({ timeline: receipt }).timeline.phases.length, receipt.phases.length);
const projection = sanitizeTaskRecordForProjection({ id: 'task', eventCounterReceipts: { private: true }, currentOperations: [{ id: 'op', activity: { metadata: { timeline: receipt } } }] });
assert.equal(projection.eventCounterReceipts, undefined);
assert.equal(projection.currentOperations[0].metadata.timeline.phase, 'result-ready');
assert.equal(projection.currentOperations[0].metadata.timeline.phases.length, receipt.phases.length);

let release;
let admitted;
const started = new Promise(resolve => { admitted = resolve; });
const owner = runWorkspaceOperation('timeline-test', async () => { admitted(); await new Promise(resolve => { release = resolve; }); }, { taskId: 'owner', scope: 'mutation', owner: { taskId: 'owner', operationId: 'owner-op', operation: 'Build', principalFingerprint: 'fixture-principal-a' } });
await started;
const queued = [];
let executed = false;
const controller = new AbortController();
const waiter = runWorkspaceOperation('timeline-test', () => { executed = true; }, { taskId: 'waiting', scope: 'mutation', owner: { principalFingerprint: 'fixture-principal-a' }, signal: controller.signal, onQueueState: state => queued.push(state) });
await new Promise(resolve => setImmediate(resolve));
assert.equal(queued.at(-1).blocking.operationId, 'owner-op');
assert.equal(queued.at(-1).queuePosition, 1);
controller.abort(new Error('cancelled during admission'));
await assert.rejects(waiter, error => error.code === 'WORKSPACE_OPERATION_ABORTED' && error.executed === false);
assert.equal(executed, false);
release();
await owner;
assert.equal(pendingWorkspaceOperations(), 0);

await runWorkspaceOperation('timeline-diagnostic-failure', () => {}, { onQueueState: () => { throw new Error('observer'); } });
assert.equal(pendingWorkspaceOperations(), 0);


// Synthetic queue fixtures exercise disclosure independently of authorization.
// They do not make authenticated service requests or run external processes.
for (const nested of [false, true]) {
  for (const [ownerPrincipal, requesterPrincipal] of [
    ['fixture-principal-a', 'fixture-principal-b'],
    ['fixture-principal-a', undefined],
    [undefined, undefined],
    ['', ''],
    ['fixture-principal-a', 'fixture-principal-a']
  ]) {
    const fixtureWorkspace = `queue-disclosure-${nested}-${String(ownerPrincipal)}-${String(requesterPrincipal)}`;
    let unlock;
    let signalStarted;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const blockerOwner = {
      taskId: 'private-owner-task', operationId: 'private-owner-operation',
      operation: 'Private blocker label', startedAt: '2026-10-05T00:00:00.000Z',
      ...(ownerPrincipal === undefined ? {} : { principalFingerprint: ownerPrincipal })
    };
    const hold = async () => { signalStarted(); await new Promise(resolve => { unlock = resolve; }); };
    const blocker = runWorkspaceOperation(fixtureWorkspace,
      nested ? () => runWorkspaceMutationBoundary(fixtureWorkspace, hold, { taskId: 'private-owner-task' }) : hold,
      { taskId: 'private-owner-task', scope: nested ? 'task' : 'mutation', owner: blockerOwner });
    await started;
    const observations = [];
    let entered = false;
    try {
      const samePrincipal = Boolean(ownerPrincipal) && ownerPrincipal === requesterPrincipal;
      await assert.rejects(runWorkspaceOperation(fixtureWorkspace, () => { entered = true; }, {
        taskId: 'waiting-task', scope: 'mutation', queueTimeoutMs: 25,
        owner: { taskId: 'waiting-task', ...(requesterPrincipal === undefined ? {} : { principalFingerprint: requesterPrincipal }) },
        onQueueState: state => observations.push(state)
      }), error => {
        assert.equal(error.code, 'WORKSPACE_OPERATION_QUEUE_TIMEOUT');
        assert.equal(error.executed, false);
        assert.equal(error.retryable, true);
        assert.ok(error.queueTimeoutMs > 0);
        if (samePrincipal) {
          assert.equal(error.blockingTaskId, blockerOwner.taskId);
          assert.equal(error.blockingOperationId, blockerOwner.operationId);
          assert.equal(error.blockingOperation, blockerOwner.operation);
          assert.equal(error.blockingStartedAt, blockerOwner.startedAt);
        } else {
          for (const key of ['blockingTaskId', 'blockingOperationId', 'blockingOperation', 'blockingStartedAt']) assert.equal(error[key], undefined);
          assert.doesNotMatch(error.message, /private-owner|Private blocker/);
        }
        return true;
      });
      assert.equal(entered, false, 'diagnostic redaction cannot admit the blocked operation');
      const pending = observations.at(-1);
      assert.ok(pending.queuePosition >= 1);
      assert.equal(typeof pending.activeReaderCount, 'number');
      assert.equal(pending.blocking.principalFingerprint, undefined);
      if (samePrincipal) assert.equal(pending.blocking.operationId, blockerOwner.operationId);
      else assert.deepEqual(pending.blocking, {});
    } finally {
      unlock();
      await blocker;
    }
    assert.equal(pendingWorkspaceOperations(), 0);
  }
}

console.log('operation timeline and queue diagnostics tests passed');
