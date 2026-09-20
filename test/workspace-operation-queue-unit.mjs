import assert from 'node:assert/strict';

import { getOperationDefinition } from '../src/tools/actionDefinitions.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { blockWorkspaceMutations, runWorkspaceMutationBoundary, runWorkspaceOperation, pendingWorkspaceOperations } from "../src/workspaceOperationQueue.js";

assert.equal(getOperationDefinition(OP.EDIT)?.behavior?.concurrencyScope, 'mutation', 'relai_edit mutations must coordinate with other mutations without blocking reads');
assert.equal(getOperationDefinition(OP.EXEC)?.behavior?.concurrencyScope, 'mutation', 'relai_exec mutating commands must advertise mutation-level coordination');

const order = [];
const first = runWorkspaceOperation('repo', async () => {
  order.push('first:start');
  await new Promise(resolve => setTimeout(resolve, 40));
  order.push('first:end');
});
const second = runWorkspaceOperation('repo', async () => {
  order.push('second:start');
  order.push('second:end');
});
const other = runWorkspaceOperation('other', async () => {
  order.push('other:start');
  order.push('other:end');
});

await Promise.all([first, second, other]);
assert.ok(order.indexOf('other:start') < order.indexOf('first:end'), 'different workspaces may run concurrently');
assert.ok(order.indexOf('second:start') > order.indexOf('first:end'), 'same-workspace operations must serialize');
assert.equal(pendingWorkspaceOperations(), 0);

// Read-only tool calls share the lock: a batch of reads on one workspace must overlap
// instead of serializing the way writes do.
const reads = [];
const readers = [0, 1, 2].map(index => runWorkspaceOperation('repo', async () => {
  reads.push(`read${index}:start`);
  await new Promise(resolve => setTimeout(resolve, 30));
  reads.push(`read${index}:end`);
}, { mode: 'read' }));
await Promise.all(readers);
assert.deepEqual(
  reads.slice(0, 3).sort(),
  ['read0:start', 'read1:start', 'read2:start'],
  'concurrent reads must all start before any of them finishes'
);
assert.equal(pendingWorkspaceOperations(), 0);

// A write must not overlap a read in either direction.
const mixed = [];
const runningRead = runWorkspaceOperation('repo', async () => {
  mixed.push('read:start');
  await new Promise(resolve => setTimeout(resolve, 40));
  mixed.push('read:end');
}, { mode: 'read' });
const blockedWrite = runWorkspaceOperation('repo', async () => {
  mixed.push('write:start');
  mixed.push('write:end');
}, { mode: 'write' });
await Promise.all([runningRead, blockedWrite]);
assert.deepEqual(mixed, ['read:start', 'read:end', 'write:start', 'write:end'], 'a write waits for in-flight reads');

// FIFO fairness: a queued write blocks reads that arrive after it, so a steady stream
// of reads cannot starve an edit.
const fairness = [];
const holdingRead = runWorkspaceOperation('fair', async () => {
  fairness.push('read1:start');
  await new Promise(resolve => setTimeout(resolve, 40));
  fairness.push('read1:end');
}, { mode: 'read' });
const queuedWrite = runWorkspaceOperation('fair', async () => {
  fairness.push('write:start');
  await new Promise(resolve => setTimeout(resolve, 10));
  fairness.push('write:end');
}, { mode: 'write' });
const lateRead = runWorkspaceOperation('fair', async () => {
  fairness.push('read2:start');
  fairness.push('read2:end');
}, { mode: 'read' });
await Promise.all([holdingRead, queuedWrite, lateRead]);
assert.deepEqual(
  fairness,
  ['read1:start', 'read1:end', 'write:start', 'write:end', 'read2:start', 'read2:end'],
  'a waiting write runs before reads queued behind it'
);
assert.equal(pendingWorkspaceOperations(), 0);

// Independent logical tasks in one workspace must not block each other.
const parallelTasks = [];
const taskA = runWorkspaceOperation('shared', async () => {
  parallelTasks.push('a:start');
  await new Promise(resolve => setTimeout(resolve, 40));
  parallelTasks.push('a:end');
}, { mode: 'write', taskId: 'task-a' });
const taskB = runWorkspaceOperation('shared', async () => {
  parallelTasks.push('b:start');
  await new Promise(resolve => setTimeout(resolve, 10));
  parallelTasks.push('b:end');
}, { mode: 'write', taskId: 'task-b' });
await Promise.all([taskA, taskB]);
assert.ok(
  parallelTasks.indexOf('b:start') < parallelTasks.indexOf('a:end'),
  'different tasks may write concurrently in one workspace'
);
assert.equal(pendingWorkspaceOperations(), 0);

// Mutations from different tasks serialize with each other but do not block an
// unrelated read. This is the narrow shared barrier used by edit/exec/completion.
const mutationOrder = [];
const mutationStarted = deferred();
const releaseMutation = deferred();
const mutationA = runWorkspaceOperation('mutations', async () => {
  mutationOrder.push('mutation-a:start');
  mutationStarted.resolve();
  await releaseMutation.promise;
  mutationOrder.push('mutation-a:end');
}, { mode: 'write', scope: 'mutation', taskId: 'task-a' });
await mutationStarted.promise;
const mutationB = runWorkspaceOperation('mutations', async () => {
  mutationOrder.push('mutation-b:start');
  mutationOrder.push('mutation-b:end');
}, { mode: 'write', scope: 'mutation', taskId: 'task-b' });
const concurrentRead = runWorkspaceOperation('mutations', async () => {
  mutationOrder.push('read:start');
  mutationOrder.push('read:end');
}, { mode: 'read', scope: 'task', taskId: 'task-c' });
await concurrentRead;
assert.ok(mutationOrder.includes('read:end'), 'an unrelated read must not wait for a long mutation');
assert.equal(mutationOrder.includes('mutation-b:start'), false, 'a second mutation must wait for the active mutation');
releaseMutation.resolve();
await Promise.all([mutationA, mutationB]);
assert.ok(mutationOrder.indexOf('mutation-b:start') > mutationOrder.indexOf('mutation-a:end'));
assert.equal(pendingWorkspaceOperations(), 0);

// Calls inside one logical task retain deterministic reader/writer ordering.
const sameTask = [];
const sameTaskWrite = runWorkspaceOperation('shared', async () => {
  sameTask.push('write:start');
  await new Promise(resolve => setTimeout(resolve, 30));
  sameTask.push('write:end');
}, { mode: 'write', taskId: 'task-one' });
const sameTaskRead = runWorkspaceOperation('shared', async () => {
  sameTask.push('read:start');
  sameTask.push('read:end');
}, { mode: 'read', taskId: 'task-one' });
await Promise.all([sameTaskWrite, sameTaskRead]);
assert.deepEqual(sameTask, ['write:start', 'write:end', 'read:start', 'read:end']);
assert.equal(pendingWorkspaceOperations(), 0);

// A repository-global operation excludes every task and blocks later task calls.
const globalOrder = [];
const activeTaskWrite = runWorkspaceOperation('global', async () => {
  globalOrder.push('task-a:start');
  await new Promise(resolve => setTimeout(resolve, 30));
  globalOrder.push('task-a:end');
}, { mode: 'write', taskId: 'task-a' });
const globalWrite = runWorkspaceOperation('global', async () => {
  globalOrder.push('global:start');
  await new Promise(resolve => setTimeout(resolve, 10));
  globalOrder.push('global:end');
}, { mode: 'write', taskId: 'maintenance', scope: 'workspace' });
const laterTaskRead = runWorkspaceOperation('global', async () => {
  globalOrder.push('task-b:start');
  globalOrder.push('task-b:end');
}, { mode: 'read', taskId: 'task-b' });
await Promise.all([activeTaskWrite, globalWrite, laterTaskRead]);
assert.deepEqual(globalOrder, [
  'task-a:start',
  'task-a:end',
  'global:start',
  'global:end',
  'task-b:start',
  'task-b:end'
]);
assert.equal(pendingWorkspaceOperations(), 0);

// Standalone task completion is a short repository-wide critical section. It must
// not race a source-workspace operation from another logical task after validation
// has been checked but before completion is accepted.
{
  const finishBehavior = getOperationDefinition(OP.WORK_FINISH)?.behavior;
  assert.equal(finishBehavior?.concurrencyScope, 'mutation', 'work.finish must use the short mutation barrier');

  const sourceOperationStarted = deferred();
  const releaseSourceOperation = deferred();
  const sourceOperation = runWorkspaceOperation('finish-barrier', async () => {
    sourceOperationStarted.resolve();
    await releaseSourceOperation.promise;
  }, { mode: 'write', scope: 'mutation', taskId: 'task-b' });
  await sourceOperationStarted.promise;

  let completionEntered = false;
  const completion = runWorkspaceMutationBoundary('finish-barrier', async () => {
    completionEntered = true;
  }, { taskId: 'task-a' });
  await nextTurn();
  assert.equal(completionEntered, false, 'work.finish must wait until concurrent source-workspace activity leaves the validation/completion boundary');

  releaseSourceOperation.resolve();
  await Promise.all([sourceOperation, completion]);
  assert.equal(completionEntered, true);
  assert.equal(pendingWorkspaceOperations(), 0);
}

// A rejected operation must still release the lock.
await assert.rejects(
  runWorkspaceOperation('repo', async () => { throw new Error('boom'); }, { mode: 'write' }),
  /boom/
);
assert.equal(pendingWorkspaceOperations(), 0);
await runWorkspaceOperation('repo', async () => 'ok', { mode: 'write' });

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function nextTurn() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// A disconnected request waiting behind a same-task writer must leave the queue
// immediately and must not execute after the writer eventually releases.
{
  const writerStarted = deferred();
  const releaseWriter = deferred();
  const writer = runWorkspaceOperation('abort-task', async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  }, { mode: 'write', scope: 'task', taskId: 'task-abort' });
  await writerStarted.promise;

  let readerRan = false;
  const controller = new AbortController();
  const reader = runWorkspaceOperation('abort-task', async () => {
    readerRan = true;
  }, { mode: 'read', scope: 'task', taskId: 'task-abort', signal: controller.signal });
  await nextTurn();
  controller.abort(new Error('client disconnected'));
  await assert.rejects(
    reader,
    error => error?.name === 'AbortError'
      && error?.code === 'WORKSPACE_OPERATION_ABORTED'
      && /client disconnected/i.test(error.message)
  );
  assert.equal(readerRan, false);

  releaseWriter.resolve();
  await writer;
  await nextTurn();
  assert.equal(readerRan, false, 'an aborted waiter must never run after its blocker releases');
  assert.equal(pendingWorkspaceOperations(), 0);
}

// Cancellation also applies while a task call is still waiting for the outer
// workspace barrier, before it can allocate/acquire the task-local lane.
{
  const globalStarted = deferred();
  const releaseGlobal = deferred();
  const globalWriter = runWorkspaceOperation('abort-global', async () => {
    globalStarted.resolve();
    await releaseGlobal.promise;
  }, { mode: 'write', scope: 'workspace', taskId: 'maintenance' });
  await globalStarted.promise;

  let taskCallRan = false;
  const controller = new AbortController();
  const taskCall = runWorkspaceOperation('abort-global', async () => {
    taskCallRan = true;
  }, { mode: 'read', scope: 'task', taskId: 'task-b', signal: controller.signal });
  await nextTurn();
  controller.abort(new Error('request deadline expired'));
  await assert.rejects(taskCall, error => error?.code === 'WORKSPACE_OPERATION_ABORTED');
  assert.equal(taskCallRan, false);

  releaseGlobal.resolve();
  await globalWriter;
  assert.equal(taskCallRan, false);
  assert.equal(pendingWorkspaceOperations(), 0);
}

// Detached/background callers can bound queue waiting without releasing the
// operation that currently owns the lock. This prevents hidden fallback work from
// forming an unbounded mutation backlog while preserving mutation exclusivity.
{
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const blocker = runWorkspaceOperation('queue-timeout', async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, {
    mode: 'write', scope: 'mutation', taskId: 'blocker',
    owner: { taskId: 'blocker', operationId: 'op-blocker', operation: 'Long mutation', startedAt: '2026-09-20T00:00:00.000Z' }
  });
  await blockerStarted.promise;

  let timedOutRan = false;
  await assert.rejects(
    runWorkspaceOperation('queue-timeout', async () => { timedOutRan = true; }, {
      mode: 'write', scope: 'mutation', taskId: 'queued', queueTimeoutMs: 25
    }),
    error => error?.code === 'WORKSPACE_OPERATION_QUEUE_TIMEOUT'
      && error?.retryable === true
      && error?.blockingTaskId === 'blocker'
      && error?.blockingOperationId === 'op-blocker'
      && error?.blockingOperation === 'Long mutation'
      && Number(error?.queueTimeoutMs) > 0
      && Number(error?.queueTimeoutMs) <= 25
      && /waiting operation was not started/i.test(error.message)
  );
  assert.equal(timedOutRan, false);

  releaseBlocker.resolve();
  await blocker;
  const after = await runWorkspaceOperation('queue-timeout', async () => 'released', {
    mode: 'write', scope: 'mutation', taskId: 'after-timeout', queueTimeoutMs: 25
  });
  assert.equal(after, 'released', 'a timed-out waiter must not poison the mutation lane');
  assert.equal(pendingWorkspaceOperations(), 0);
}

// If an active mutation cannot be proven stopped, quarantine that workspace's
// mutation lane. Already-queued and new writers fail immediately instead of
// waiting forever behind the stuck owner, while reads remain available.
{
  const blockerStarted = deferred();
  const releaseBlocker = deferred();
  const blocker = runWorkspaceOperation('mutation-quarantine', async () => {
    blockerStarted.resolve();
    await releaseBlocker.promise;
  }, { mode: 'write', scope: 'mutation', taskId: 'stuck-a' });
  await blockerStarted.promise;

  let queuedMutationRan = false;
  const queuedMutation = runWorkspaceOperation('mutation-quarantine', async () => {
    queuedMutationRan = true;
  }, { mode: 'write', scope: 'mutation', taskId: 'queued-b' });
  await nextTurn();

  blockWorkspaceMutations('mutation-quarantine', 'termination could not be confirmed');
  await assert.rejects(
    queuedMutation,
    error => error?.code === 'WORKSPACE_MUTATION_BLOCKED' && error?.retryable === false
  );
  assert.equal(queuedMutationRan, false, 'quarantined queued mutation must never start');

  await assert.rejects(
    runWorkspaceOperation('mutation-quarantine', async () => {}, {
      mode: 'write', scope: 'mutation', taskId: 'new-c'
    }),
    error => error?.code === 'WORKSPACE_MUTATION_BLOCKED'
  );
  await assert.rejects(
    runWorkspaceOperation('mutation-quarantine', async () => {}, {
      mode: 'write', scope: 'workspace', taskId: 'maintenance-d'
    }),
    error => error?.code === 'WORKSPACE_MUTATION_BLOCKED'
  );

  const read = await runWorkspaceOperation('mutation-quarantine', async () => 'read-ok', {
    mode: 'read', scope: 'task', taskId: 'reader'
  });
  assert.equal(read, 'read-ok', 'mutation quarantine must not disable safe reads');

  releaseBlocker.resolve();
  await blocker;
  assert.equal(pendingWorkspaceOperations(), 0);
}

// Already-aborted requests fail before their operation starts and leave no lock.
{
  const controller = new AbortController();
  controller.abort(new Error('already closed'));
  let ran = false;
  await assert.rejects(
    runWorkspaceOperation('pre-aborted', async () => { ran = true; }, {
      mode: 'read', scope: 'task', taskId: 'task-d', signal: controller.signal
    }),
    error => error?.code === 'WORKSPACE_OPERATION_ABORTED'
  );
  assert.equal(ran, false);
  assert.equal(pendingWorkspaceOperations(), 0);
}

console.log('Workspace operation queue tests passed.');
