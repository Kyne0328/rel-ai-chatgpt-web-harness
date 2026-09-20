import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';

import {
  DEFAULT_FALLBACK_GRACE_MS,
  acknowledgeFallbackCompletionNotice,
  cancelFallbackExecution,
  consumeFallbackCompletionNotices,
  enableFallbackCompletionNotice,
  fallbackExecutionStatus,
  resetFallbackExecutions,
  startFallbackExecution
} from '../src/mcp/fallbackExecutions.js';
import { MCP_PROTOCOL_VERSION } from '../src/mcp/protocol.js';
import { toolResult } from '../src/mcp/results.js';
import { enrichWithFallbackCompletions } from '../src/mcp/toolInvocation.js';
import { principalFingerprint } from '../src/mcp/principal.js';
import { handleTransportTaskRequest } from '../src/mcp/transportTasks.js';
import {
  readTaskHistorySessionRecord,
  recordTaskBackgroundOperation,
  recordTaskHistoryEvent
} from '../src/taskHistoryStore.ts';

function message(id, workId, command = 'node test.js') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'relai_exec',
      arguments: {
        workspace: 'app',
        ...(workId ? { work_id: workId } : {}),
        command,
        timeoutMs: 60_000
      },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  };
}

function readMessage(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'relai_read',
      arguments: { workspace: 'app', paths: ['README.md'] },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  };
}

function workBeginMessage(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'relai_work',
      arguments: {
        action: 'begin',
        workspace: 'app',
        title: 'Replay-safe start',
        objective: 'Prove a lost work.begin response does not create a duplicate task.'
      },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  };
}

function completedResult(workId, stdout = 'done') {
  return toolResult({
    ok: true,
    executed: true,
    commandSucceeded: true,
    workspace: 'app',
    work_id: workId,
    durationMs: 25,
    exitCode: 0,
    stdout
  }, false);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function seedTask(config, taskId) {
  recordTaskHistoryEvent(config, {
    taskId,
    taskIdentityVersion: 2,
    taskIdExplicit: true,
    taskHistoryEligible: true,
    eventType: 'task.started',
    tool: 'work.begin',
    workspace: 'app',
    ok: true,
    ts: new Date().toISOString()
  });
}

assert.equal(DEFAULT_FALLBACK_GRACE_MS, 1_000, 'non-Tasks fallback should detach quickly instead of holding the connector open');
resetFallbackExecutions();

const fastWorkId = 'work_fast_fallback_test';
const fast = await handleTransportTaskRequest({}, message(1, fastWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 50,
  executeToolResult: async () => completedResult(fastWorkId, 'fast')
});
assert.equal(fast.body.result.isError, false);
assert.equal(fast.body.result.structuredContent.exitCode, 0);
assert.equal(fast.body.result.structuredContent.stdout, 'fast');

const deliveredWorkId = 'work_delivered_fallback_test';
let deliveredWorkExecutions = 0;
const deliveredWorkExecute = async () => {
  deliveredWorkExecutions += 1;
  return completedResult(deliveredWorkId, `delivered-${deliveredWorkExecutions}`);
};
const deliveredWork = await handleTransportTaskRequest({}, message(900, deliveredWorkId), {
  principal: 'principal-delivered-work',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredWorkExecute
});
assert.equal(deliveredWorkExecutions, 1);
assert.equal(typeof deliveredWork.onDelivered, 'function');
deliveredWork.onDelivered();
const freshDeliveredWork = await handleTransportTaskRequest({}, message(901, deliveredWorkId), {
  principal: 'principal-delivered-work',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredWorkExecute
});
assert.equal(deliveredWorkExecutions, 2, 'a confirmed work-bound result must not be replayed as a fresh rerun');
assert.equal(freshDeliveredWork.body.result.structuredContent.stdout, 'delivered-2');
freshDeliveredWork.onDelivered();

const deliveredFailureWorkId = 'work_delivered_failure_fallback_test';
let deliveredFailureExecutions = 0;
const deliveredFailureExecute = async () => {
  deliveredFailureExecutions += 1;
  return toolResult({
    ok: false,
    executed: true,
    commandSucceeded: false,
    workspace: 'app',
    work_id: deliveredFailureWorkId,
    durationMs: 5,
    exitCode: 1,
    stderr: `failure-${deliveredFailureExecutions}`
  }, true);
};
const deliveredFailure = await handleTransportTaskRequest({}, message(902, deliveredFailureWorkId), {
  principal: 'principal-delivered-failure',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredFailureExecute
});
assert.equal(deliveredFailureExecutions, 1);
deliveredFailure.onDelivered();
const freshDeliveredFailure = await handleTransportTaskRequest({}, message(903, deliveredFailureWorkId), {
  principal: 'principal-delivered-failure',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredFailureExecute
});
assert.equal(deliveredFailureExecutions, 2, 'a confirmed failed work-bound result must execute again on an explicit rerun');
freshDeliveredFailure.onDelivered();

let resilientReadExecutions = 0;
const resilientReadExecute = async () => {
  resilientReadExecutions += 1;
  return toolResult({ ok: true, workspace: 'app', content: `read-${resilientReadExecutions}` }, false);
};
const resilientRead = await handleTransportTaskRequest({}, readMessage(1001), {
  principal: 'principal-resilient',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: resilientReadExecute
});
assert.equal(resilientReadExecutions, 1);
assert.equal(typeof resilientRead.onDelivered, 'function', 'delivery-aware fallback must retain a one-shot acknowledgement until HTTP delivery completes');
const lostResponseRetry = await handleTransportTaskRequest({}, readMessage(1002), {
  principal: 'principal-resilient',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: resilientReadExecute
});
assert.equal(resilientReadExecutions, 1, 'retry after a lost response must replay the accepted operation instead of executing it twice');
assert.equal(lostResponseRetry.body.result.structuredContent.content, 'read-1');
resilientRead.onDelivered();
const freshRead = await handleTransportTaskRequest({}, readMessage(1003), {
  principal: 'principal-resilient',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: resilientReadExecute
});
assert.equal(resilientReadExecutions, 2, 'after confirmed delivery, the same read must execute fresh instead of replaying stale data');
freshRead.onDelivered();

let workBeginExecutions = 0;
const workBeginExecute = async () => {
  workBeginExecutions += 1;
  await delay(30);
  return toolResult({
    ok: true,
    workspace: 'app',
    work_id: 'work_replay_safe_begin',
    status: 'planning',
    title: 'Replay-safe start',
    objective: 'Prove a lost work.begin response does not create a duplicate task.'
  }, false);
};
const acceptedWorkBegin = await handleTransportTaskRequest({}, workBeginMessage(1004), {
  principal: 'principal-work-begin-replay',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: workBeginExecute
});
assert.equal(workBeginExecutions, 1);
assert.equal(acceptedWorkBegin.body.result.structuredContent.work_id, 'work_replay_safe_begin', 'work.begin must not detach before returning its durable work_id');
assert.equal(typeof acceptedWorkBegin.onDelivered, 'function');
const retriedWorkBegin = await handleTransportTaskRequest({}, workBeginMessage(1005), {
  principal: 'principal-work-begin-replay',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: workBeginExecute
});
assert.equal(workBeginExecutions, 1, 'retrying work.begin after losing its response must replay the accepted task instead of creating a second task');
assert.equal(retriedWorkBegin.body.result.structuredContent.work_id, 'work_replay_safe_begin');
acceptedWorkBegin.onDelivered();

let detachedReadExecutions = 0;
const detachedReadExecute = async () => {
  detachedReadExecutions += 1;
  await delay(30);
  return toolResult({ ok: true, workspace: 'app', content: `detached-${detachedReadExecutions}` }, false);
};
const detachedRead = await handleTransportTaskRequest({}, readMessage(1010), {
  principal: 'principal-resilient-detached',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: detachedReadExecute
});
assert.equal(detachedRead.body.result.structuredContent.status, 'running');
assert.equal(typeof detachedRead.onDelivered, 'function');
const detachedOperationId = detachedRead.body.result.structuredContent.operationId;
detachedRead.onDelivered();
await delay(45);
assert.equal(fallbackExecutionStatus(detachedOperationId).status, 'completed', 'delivered detached work must remain queryable by operationId');
const expiredDetachedAt = Date.now() + (16 * 60_000);
assert.equal(fallbackExecutionStatus(detachedOperationId, { now: () => expiredDetachedAt }), null, 'delivered taskless operation records must expire from operationId lookup after the fallback TTL');
const freshAfterDetachedDelivery = await handleTransportTaskRequest({}, readMessage(1011), {
  principal: 'principal-resilient-detached',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: detachedReadExecute
});
assert.equal(detachedReadExecutions, 2, 'delivering a detached acknowledgement must release its request-signature replay key after completion');
freshAfterDetachedDelivery.onDelivered();

const slowWorkId = 'work_slow_fallback_test';
let executionCount = 0;
const requestAbort = new AbortController();
const slowExecute = async () => {
  executionCount += 1;
  await delay(40);
  return completedResult(slowWorkId, 'slow complete');
};
const slow = await handleTransportTaskRequest({}, message(2, slowWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  signal: requestAbort.signal,
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(slow.body.result.isError, false);
assert.equal(slow.body.result.structuredContent.status, 'running');
assert.equal(Object.hasOwn(slow.body.result.structuredContent, 'pollAfterMs'), false, 'fallback continuation must not prompt the agent to poll');
assert.equal(slow.body.result.structuredContent.revision, 1);
assert.ok(slow.body.result.structuredContent.operationId);
assert.ok(slow.body.result.structuredContent.updatedAt);
assert.match(slow.body.result.structuredContent.nextAction, /Continue independent work/i);
assert.match(slow.body.result.structuredContent.nextAction, /completedOperations/i);
assert.equal(executionCount, 1);

requestAbort.abort(new Error('simulated connector disconnect'));
const duplicate = await handleTransportTaskRequest({}, message(3, slowWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(duplicate.body.result.structuredContent.status, 'running');
assert.equal(executionCount, 1, 'a retry while the same fallback is running must not duplicate execution');

const busy = await handleTransportTaskRequest({}, message(4, slowWorkId, 'node other-test.js'), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(busy.body.result.isError, false, 'an occupied work session is recoverable control flow, not a tool-level failure');
assert.equal(busy.body.result.structuredContent.ok, false);
assert.equal(busy.body.result.structuredContent.errorCode, 'TASK_OPERATION_IN_PROGRESS');
assert.match(busy.body.result.structuredContent.nextAction, /relai_work.*status/i);
assert.equal(executionCount, 1, 'a different long operation must not start while the work session is occupied');

await delay(60);
const completed = fallbackExecutionStatus(slowWorkId);
assert.equal(completed.status, 'completed');
assert.equal(completed.revision, 2);
assert.equal(completed.result.exitCode, 0);
assert.equal(completed.result.stdout, 'slow complete');
assert.equal(executionCount, 1, 'request cancellation must not abort or restart detached fallback work');

const completedRetry = await handleTransportTaskRequest({}, message(5, slowWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(completedRetry.body.result.structuredContent.stdout, 'slow complete');
assert.equal(executionCount, 1, 'a completed retry with the same signature must replay instead of executing again');

const cancelledWorkId = 'work_cancelled_fallback_test';
let fallbackAbortObserved = false;
const cancellable = startFallbackExecution({
  workId: cancelledWorkId,
  tool: 'relai_validate',
  workspace: 'app',
  signature: 'cancel-signature',
  run: signal => new Promise(resolve => {
    const finish = () => {
      fallbackAbortObserved = true;
      resolve(toolResult({ ok: false, work_id: cancelledWorkId, cancelled: true }, true));
    };
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  })
});
const wrongOwnerCancellation = cancelFallbackExecution(cancellable.record.operationId, {
  reason: 'Must not cross task ownership.',
  expectedWorkId: 'work_other_fallback_test'
});
assert.equal(wrongOwnerCancellation.cancelled, false);
assert.equal(wrongOwnerCancellation.mismatch, true);
assert.equal(fallbackAbortObserved, false, 'a fallback operation ID must not cancel work owned by another logical task');
assert.equal(fallbackExecutionStatus(cancelledWorkId).status, 'running');
const cancellation = cancelFallbackExecution(cancellable.record.operationId, {
  reason: 'Explicit fallback cancellation test.',
  expectedWorkId: cancelledWorkId
});
assert.equal(cancellation.cancelled, false);
assert.equal(cancellation.stopping, true);
assert.equal(cancellation.record.status, 'running', 'fallback cancellation request must remain nonterminal until execution settles');
assert.equal(fallbackExecutionStatus(cancelledWorkId).status, 'running');
assert.equal(fallbackExecutionStatus(cancelledWorkId).stopping, true);
await cancellable.record.promise;
assert.equal(fallbackAbortObserved, true, 'explicit work-session cancellation must reach the detached operation signal');
assert.equal(fallbackExecutionStatus(cancelledWorkId).status, 'cancelled');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-fallback-durable-'));
const config = { stateDir: sandbox, auditLogPath: path.join(sandbox, 'audit.jsonl') };
try {
  resetFallbackExecutions();

  let tasklessExecutionCount = 0;
  const tasklessStarted = await handleTransportTaskRequest(config, message(9, ''), {
    principal: 'principal-taskless',
    transportType: 'test',
    synchronousFallbackGraceMs: 5,
    executeToolResult: async () => {
      tasklessExecutionCount += 1;
      await delay(30);
      return toolResult({ ok: true, executed: true, commandSucceeded: true, workspace: 'app', durationMs: 30, exitCode: 0, stdout: 'taskless complete' }, false);
    }
  });
  assert.equal(tasklessStarted.body.result.structuredContent.status, 'running');
  assert.equal(Object.hasOwn(tasklessStarted.body.result.structuredContent, 'work_id'), false, 'taskless fallback must not invent a work_id');
  const tasklessOperationId = tasklessStarted.body.result.structuredContent.operationId;
  assert.ok(tasklessOperationId);
  assert.match(tasklessStarted.body.result.structuredContent.nextAction, /completedOperations/i, 'taskless fallback completion should surface passively on a later Rel.AI call');
  assert.doesNotMatch(tasklessStarted.body.result.structuredContent.nextAction, /poll/i, 'fallback guidance must not encourage polling while useful work remains');
  await delay(50);
  assert.equal(fallbackExecutionStatus(tasklessOperationId, { config }).status, 'completed');
  resetFallbackExecutions();
  const recoveredTaskless = fallbackExecutionStatus(tasklessOperationId, { config });
  assert.equal(recoveredTaskless.status, 'completed', 'taskless fallback must recover by operationId after in-memory state is lost');
  assert.equal(recoveredTaskless.result.exitCode, 0);
  assert.equal(recoveredTaskless.result.stdout, undefined, 'persisted taskless fallback state must not retain command output');
  assert.equal(tasklessExecutionCount, 1);

  const durableWorkId = 'work_durable_fallback_test';
  seedTask(config, durableWorkId);
  let durableExecutionCount = 0;
  const durableExecute = async () => {
    durableExecutionCount += 1;
    await delay(30);
    return completedResult(durableWorkId, 'must-not-persist-raw-stdout');
  };
  const durableStarted = await handleTransportTaskRequest(config, message(10, durableWorkId), {
    principal: 'principal-a',
    transportType: 'test',
    synchronousFallbackGraceMs: 5,
    executeToolResult: durableExecute
  });
  assert.equal(durableStarted.body.result.structuredContent.status, 'running');
  await delay(50);

  const durableSession = readTaskHistorySessionRecord(config, durableWorkId);
  assert.equal(durableSession.backgroundOperation.status, 'completed');
  assert.equal(durableSession.backgroundOperation.revision, 2);
  assert.equal(durableSession.backgroundOperation.result.exitCode, 0);
  assert.equal(Object.hasOwn(durableSession.backgroundOperation.result, 'stdout'), false, 'durable task history must redact raw command output');
  assert.ok(durableSession.backgroundOperation.signature, 'private signature must persist for restart-safe deduplication');

  resetFallbackExecutions();
  const recovered = fallbackExecutionStatus(durableWorkId, { config });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.exitCode, 0);
  assert.equal(Object.hasOwn(recovered, 'signature'), false, 'public fallback status must not expose the replay signature');
  assert.equal(Object.hasOwn(recovered.result, 'stdout'), false);

  const durableReplay = await handleTransportTaskRequest(config, message(11, durableWorkId), {
    principal: 'principal-a',
    transportType: 'test',
    synchronousFallbackGraceMs: 5,
    executeToolResult: durableExecute
  });
  assert.equal(durableReplay.body.result.structuredContent.exitCode, 0);
  assert.equal(Object.hasOwn(durableReplay.body.result.structuredContent, 'stdout'), false, 'post-restart replay should use the sanitized durable result');
  assert.equal(durableExecutionCount, 1, 'completed work must remain idempotent after the in-memory fallback cache is lost');
  assert.deepEqual(
    consumeFallbackCompletionNotices(config, {
      noticeScope: principalFingerprint('principal-a'),
      workspace: 'app'
    }),
    [],
    'terminal fallback replay must acknowledge the queued completion notice'
  );

  const deliveredDurableWorkId = 'work_delivered_durable_fallback_test';
  seedTask(config, deliveredDurableWorkId);
  let deliveredDurableExecutions = 0;
  const deliveredDurableExecute = async () => {
    deliveredDurableExecutions += 1;
    return completedResult(deliveredDurableWorkId, `durable-delivered-${deliveredDurableExecutions}`);
  };
  const deliveredDurable = await handleTransportTaskRequest(config, message(12, deliveredDurableWorkId), {
    principal: 'principal-delivered-durable',
    transportType: 'streamable-http',
    synchronousFallbackGraceMs: 50,
    executeToolResult: deliveredDurableExecute
  });
  assert.equal(deliveredDurableExecutions, 1);
  deliveredDurable.onDelivered();
  assert.equal(readTaskHistorySessionRecord(config, deliveredDurableWorkId).backgroundOperation.deliveryAcknowledged, true);
  resetFallbackExecutions();
  const freshDurable = await handleTransportTaskRequest(config, message(13, deliveredDurableWorkId), {
    principal: 'principal-delivered-durable',
    transportType: 'streamable-http',
    synchronousFallbackGraceMs: 50,
    executeToolResult: deliveredDurableExecute
  });
  assert.equal(deliveredDurableExecutions, 2, 'confirmed delivery must survive restart so a later work-bound rerun executes fresh');
  assert.equal(freshDurable.body.result.structuredContent.stdout, 'durable-delivered-2');
  freshDurable.onDelivered();

  const noticeWorkId = 'work_completion_notice_test';
  seedTask(config, noticeWorkId);
  const noticePrincipal = 'principal-notice';
  const noticeScope = principalFingerprint(noticePrincipal);
  const noticeStarted = startFallbackExecution({
    config,
    workId: noticeWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'notice-signature',
    run: async () => completedResult(noticeWorkId, 'raw-output-must-not-enter-notice')
  });
  enableFallbackCompletionNotice(config, noticeStarted.record);
  await noticeStarted.record.promise;
  assert.deepEqual(consumeFallbackCompletionNotices(config, { noticeScope: 'other-principal', workspace: 'app' }), [], 'completion notices must remain principal scoped');
  assert.deepEqual(consumeFallbackCompletionNotices(config, { noticeScope, workspace: 'other-workspace' }), [], 'completion notices must remain workspace scoped');
  const notices = consumeFallbackCompletionNotices(config, { noticeScope, workspace: 'app' });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].work_id, noticeWorkId);
  assert.equal(notices[0].exitCode, 0);
  assert.equal(notices[0].commandSucceeded, true);
  assert.match(notices[0].summary, /exit code 0/i);
  assert.equal(JSON.stringify(notices).includes('raw-output-must-not-enter-notice'), false, 'completion notices must not carry raw stdout');
  assert.deepEqual(consumeFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }), [], 'completion notices must be delivered once');

  const acknowledgedWorkId = 'work_acknowledged_notice_test';
  seedTask(config, acknowledgedWorkId);
  const acknowledgedStarted = startFallbackExecution({
    config,
    workId: acknowledgedWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'acknowledged-notice-signature',
    run: async () => completedResult(acknowledgedWorkId, 'acknowledged')
  });
  enableFallbackCompletionNotice(config, acknowledgedStarted.record);
  await acknowledgedStarted.record.promise;
  assert.equal(acknowledgeFallbackCompletionNotice(config, acknowledgedWorkId, { noticeScope, workspace: 'app' }), true);
  assert.deepEqual(consumeFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }), [], 'explicit status acknowledgement must prevent duplicate piggyback delivery');

  const piggybackWorkId = 'work_piggyback_notice_test';
  seedTask(config, piggybackWorkId);
  const piggybackStarted = startFallbackExecution({
    config,
    workId: piggybackWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'piggyback-notice-signature',
    run: async () => completedResult(piggybackWorkId, 'piggyback')
  });
  enableFallbackCompletionNotice(config, piggybackStarted.record);
  await piggybackStarted.record.promise;
  const unrelated = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace: 'app' },
    { ok: true, workspace: 'app', items: [] },
    { principal: noticePrincipal }
  );
  assert.equal(unrelated.completedOperations.length, 1, 'the next unrelated same-workspace Rel.AI result must carry the background completion');
  assert.equal(unrelated.completedOperations[0].work_id, piggybackWorkId);
  assert.match(toolResult(unrelated, false).content[0].text, /Background completion: .*exit code 0/i, 'the MCP text summary must make the piggybacked completion visible to the model');
  const afterPiggyback = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace: 'app' },
    { ok: true, workspace: 'app', items: [] },
    { principal: noticePrincipal }
  );
  assert.equal(Object.hasOwn(afterPiggyback, 'completedOperations'), false, 'a piggybacked completion must be consumed exactly once');

  const directWorkId = 'work_direct_no_notice_test';
  seedTask(config, directWorkId);
  const directStarted = startFallbackExecution({
    config,
    workId: directWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'direct-no-notice-signature',
    run: async () => completedResult(directWorkId, 'direct')
  });
  await directStarted.record.promise;
  assert.deepEqual(consumeFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }), [], 'an operation delivered directly must not create a later duplicate completion notice');

  const nullExitWorkId = 'work_null_exit_notice_test';
  seedTask(config, nullExitWorkId);
  const nullExitStarted = startFallbackExecution({
    config,
    workId: nullExitWorkId,
    noticeScope,
    tool: 'relai_validate',
    workspace: 'app',
    signature: 'null-exit-notice-signature',
    run: async () => toolResult({ ok: true, work_id: nullExitWorkId, exitCode: null, validationStatus: 'passed' }, false)
  });
  enableFallbackCompletionNotice(config, nullExitStarted.record);
  await nullExitStarted.record.promise;
  const nullExitNotices = consumeFallbackCompletionNotices(config, { noticeScope, workspace: 'app' });
  assert.equal(Object.hasOwn(nullExitNotices[0], 'exitCode'), false, 'a null exit code must not be normalized to zero');

  const interruptedWorkId = 'work_interrupted_fallback_test';
  seedTask(config, interruptedWorkId);
  recordTaskBackgroundOperation(config, interruptedWorkId, {
    operationId: 'fallback_interrupted_fixture',
    workId: interruptedWorkId,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'interrupted-signature',
    status: 'running',
    startedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    revision: 1,
    result: { exitCode: 0, stdout: 'must-not-persist' }
  });
  resetFallbackExecutions();
  const interrupted = fallbackExecutionStatus(interruptedWorkId, { config, now: () => Date.parse('2026-08-27T00:01:00.000Z') });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.revision, 2);
  assert.match(interrupted.error, /runtime restarted/i);
  const interruptedSession = readTaskHistorySessionRecord(config, interruptedWorkId);
  assert.equal(interruptedSession.backgroundOperation.status, 'interrupted');
  assert.equal(Object.hasOwn(interruptedSession.backgroundOperation.result, 'stdout'), false);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
  resetFallbackExecutions();
}

console.log('Non-Tasks fallback detaches quickly, survives connector aborts, replays safely, persists sanitized state, recovers restarts, and supports explicit cancellation.');
