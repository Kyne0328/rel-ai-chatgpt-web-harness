import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';

import {
  MAX_RESULT_BYTES,
  NativeTaskRequestError,
  NativeTaskStoreError,
  TASK_TRANSITIONS,
  acknowledgeNativeTaskCancellation,
  assertTaskTransition,
  cancelNativeTask,
  completeNativeTask,
  createNativeTask,
  failNativeTask,
  getNativeTask,
  getNativeTaskRecord,
  nativeTaskSignal,
  normalizePrincipalKey,
  principalFingerprint,
  pruneNativeTasks,
  requestNativeTaskInput,
  updateNativeTask,
  updateNativeTaskInputs,
  updateNativeTaskRecovery
} from '../src/mcp/nativeTaskService.js';
import { createNativeToolTask } from '../src/mcp/nativeToolTasks.js';
import {
  MCP_PROTOCOL_VERSION,
  TASKS_EXTENSION_ID,
  TASKS_EXTENSION_REVISION
} from '../src/mcp/protocol.js';
import { handleTransportTaskRequest } from '../src/mcp/transportTasks.js';
import { openStateDatabase, stateDatabasePath, withStateDatabase } from '../src/stateDatabase.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-task-service-'));
const config = { stateDir: root };
const serviceUrl = new URL('../src/mcp/nativeTaskService.js', import.meta.url);
const owner = {
  issuer: 'https://issuer.example',
  clientId: 'client-a',
  subject: 'subject-a',
  tenant: 'tenant-a',
  authorizationPolicy: { role: 'developer' },
  scopes: ['offline_access', 'mcp']
};
const sameOwner = {
  scopes: ['mcp', 'offline_access'],
  authorizationPolicy: { role: 'developer' },
  tenant: 'tenant-a',
  subject: 'subject-a',
  clientId: 'client-a',
  issuer: 'https://issuer.example'
};
const otherOwner = { ...owner, subject: 'subject-b' };

function activeTask(name, options = {}) {
  const controller = options.controller || new AbortController();
  return createNativeTask(config, {
    principal: options.principal ?? owner,
    method: 'tools/call',
    name,
    logicalTaskId: options.logicalTaskId || '',
    executor: { controller, ...(options.resume ? { resume: options.resume } : {}) },
    ...options.taskOptions
  });
}

function assertUnavailable(operation) {
  assert.throws(operation, error => error?.code === 'NATIVE_TASK_UNAVAILABLE');
}

function assertRequestError(operation, reason) {
  assert.throws(operation, error => error instanceof NativeTaskRequestError && (!reason || error.reason === reason));
}

function runInputWorker(taskId, key) {
  const source = `
    import { retryNativeTaskOperation, updateNativeTaskInputs } from ${JSON.stringify(serviceUrl.href)};
    const [root, taskId, key] = process.argv.slice(1);
    await retryNativeTaskOperation(() => updateNativeTaskInputs({ stateDir: root }, taskId, { [key]: { value: key } }, { principal: 'client-a' }));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, taskId, key], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Input worker ${key} failed with code ${code}: ${stderr}`));
    });
  });
}

try {
  const toolTask = createNativeToolTask(config, {
    principal: owner,
    method: 'tools/call',
    name: 'relai_exec',
    workspace: 'repo'
  });
  assert.ok(toolTask.ttlMs > 24 * 60 * 60 * 1000,
    'tool task tracking must outlive the maximum supported 24-hour operation runtime');
  completeNativeTask(config, toolTask.taskId, { ok: true }, { principal: owner });

  assert.equal(normalizePrincipalKey('client-a'), 'client-a', 'string principal fingerprints remain restart-compatible');
  assert.equal(normalizePrincipalKey(owner), normalizePrincipalKey(sameOwner));
  assert.equal(principalFingerprint(owner), principalFingerprint(sameOwner));
  assert.notEqual(principalFingerprint(owner), principalFingerprint(otherOwner));

  const legalTransitions = {
    working: ['working', 'input_required', 'completed', 'failed', 'cancelled'],
    input_required: ['input_required', 'working', 'completed', 'failed', 'cancelled'],
    completed: ['completed'],
    failed: ['failed'],
    cancelled: ['cancelled']
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(TASK_TRANSITIONS).map(([status, next]) => [status, [...next]])),
    legalTransitions
  );
  for (const [from, destinations] of Object.entries(legalTransitions)) {
    for (const to of destinations) assert.equal(assertTaskTransition(from, to), to);
  }
  for (const [from, to] of [
    ['completed', 'working'], ['completed', 'failed'], ['completed', 'cancelled'],
    ['failed', 'working'], ['failed', 'completed'], ['failed', 'cancelled'],
    ['cancelled', 'working'], ['cancelled', 'completed'], ['cancelled', 'failed']
  ]) {
    assertRequestError(() => assertTaskTransition(from, to), 'invalid_transition');
  }

  const owned = activeTask('ownership-test', { logicalTaskId: 'logical-a' });
  assert.match(owned.taskId, /^task_[A-Za-z0-9_-]{32,160}$/);

  const contentionDb = openStateDatabase(config, { timeoutMs: 0 });
  contentionDb.exec('BEGIN IMMEDIATE');
  const contentionStartedAt = Date.now();
  assert.throws(
    () => getNativeTask(config, owned.taskId, { principal: owner }),
    error => error instanceof NativeTaskStoreError && error.reason === 'lock_busy',
    'SQLite writer contention must fail fast rather than block the MCP event loop'
  );
  assert.ok(Date.now() - contentionStartedAt < 1000, 'SQLite writer contention must return in under one second');
  contentionDb.exec('ROLLBACK');
  contentionDb.close();

  const nativeTasksCapabilities = {
    extensions: {
      [TASKS_EXTENSION_ID]: { revision: TASKS_EXTENSION_REVISION }
    }
  };
  let creationContentionDb = openStateDatabase(config, { timeoutMs: 0 });
  creationContentionDb.exec('BEGIN IMMEDIATE');
  const releaseCreationContention = setTimeout(() => {
    const db = creationContentionDb;
    creationContentionDb = null;
    if (!db) return;
    db.exec('ROLLBACK');
    db.close();
  }, 75);
  const transportResponse = await handleTransportTaskRequest(config, {
    jsonrpc: '2.0',
    id: 1001,
    method: 'tools/call',
    params: {
      name: 'relai_edit',
      arguments: {
        workspace: 'missing-for-creation-retry-test',
        work_id: 'creation-retry-test',
        path: 'acceptance.txt',
        oldText: 'before',
        newText: 'after'
      },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_INFO_META_KEY]: { name: 'native-task-creation-retry-test', version: '1.0.0' },
        [CLIENT_CAPABILITIES_META_KEY]: nativeTasksCapabilities
      }
    }
  }, {
    principal: owner,
    transportType: 'streamable-http'
  });
  clearTimeout(releaseCreationContention);
  if (creationContentionDb) {
    creationContentionDb.exec('ROLLBACK');
    creationContentionDb.close();
    creationContentionDb = null;
  }
  assert.equal(transportResponse?.body?.error, undefined,
    'transient native-task store contention must not escape tools/call as a transport failure');
  assert.equal(transportResponse?.body?.result?.resultType, 'task');
  const retriedCreationTaskId = transportResponse?.body?.result?.taskId;
  assert.match(retriedCreationTaskId || '', /^task_[A-Za-z0-9_-]{32,160}$/);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = getNativeTask(config, retriedCreationTaskId, { principal: owner });
    if (['completed', 'failed', 'cancelled'].includes(current.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.notEqual(getNativeTask(config, retriedCreationTaskId, { principal: owner }).status, 'working',
    'the test tool execution should settle before its temporary state is cleaned up');

  assert.equal(getNativeTask(config, owned.taskId, { principal: sameOwner }).status, 'working');
  const beforeNoopUpdate = getNativeTaskRecord(config, owned.taskId, { principal: owner });
  updateNativeTask(config, owned.taskId, { status: 'working' }, { principal: owner });
  const afterNoopUpdate = getNativeTaskRecord(config, owned.taskId, { principal: owner });
  assert.equal(afterNoopUpdate.revision, beforeNoopUpdate.revision, 'identical native-task status updates must not perform another durable write');
  updateNativeTaskRecovery(config, owned.taskId, null, { principal: owner });
  const afterNoopRecovery = getNativeTaskRecord(config, owned.taskId, { principal: owner });
  assert.equal(afterNoopRecovery.revision, afterNoopUpdate.revision, 'identical native-task recovery updates must not perform another durable write');
  assertUnavailable(() => getNativeTask(config, owned.taskId, { principal: otherOwner }));
  assertUnavailable(() => updateNativeTask(config, owned.taskId, { statusMessage: 'cross-principal update' }, { principal: otherOwner }));
  assertUnavailable(() => getNativeTask(config, 'task_invalid', { principal: owner }));

  const completed = completeNativeTask(config, owned.taskId, {
    ok: true,
    nested: { b: 2, a: 1 },
    token: 'must-not-persist'
  }, { principal: sameOwner });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, {
    ok: true,
    nested: { b: 2, a: 1 },
    token: '[redacted]'
  });
  const repeatedCompletion = completeNativeTask(config, owned.taskId, {
    token: 'different-secret-redacts-to-same-value',
    nested: { a: 1, b: 2 },
    ok: true
  }, { principal: owner });
  assert.deepEqual(repeatedCompletion, completed, 'an exact normalized completion repeat is idempotent');
  assertRequestError(
    () => completeNativeTask(config, owned.taskId, { ok: false }, { principal: owner }),
    'terminal_conflict'
  );
  assertRequestError(() => failNativeTask(config, owned.taskId, 'late failure', { principal: owner }), 'terminal_conflict');
  assertRequestError(() => cancelNativeTask(config, owned.taskId, { principal: owner }), 'terminal_conflict');

  const failedTask = activeTask('failure-idempotency-test');
  const failure = {
    code: -32000,
    message: 'Failure token=secret-value at C:\\Users\\Kyne\\private.txt',
    data: { authorization: 'Bearer abc', nested: { password: 'secret', safe: true } }
  };
  const failed = failNativeTask(config, failedTask.taskId, failure, { principal: owner });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.data.authorization, '[redacted]');
  assert.equal(failed.error.data.nested.password, '[redacted]');
  assert.equal(failed.error.data.nested.safe, true);
  assert.doesNotMatch(failed.error.message, /secret-value|Users\\Kyne|private\.txt/);
  assert.deepEqual(failNativeTask(config, failedTask.taskId, failure, { principal: owner }), failed);
  assertRequestError(
    () => failNativeTask(config, failedTask.taskId, { ...failure, code: -32001 }, { principal: owner }),
    'terminal_conflict'
  );

  const genericErrorTask = activeTask('generic-error-redaction-test');
  const genericFailed = failNativeTask(
    config,
    genericErrorTask.taskId,
    new Error('password=top-secret\nstack C:\\Users\\Kyne\\source.js'),
    { principal: owner }
  );
  assert.equal(genericFailed.error.message, 'Task execution failed.');

  const interruptedInput = createNativeTask(config, {
    principal: owner,
    method: 'tools/call',
    name: 'interrupted-input-test',
    status: 'input_required',
    inputRequests: {
      approval: {
        responseSchema: {
          type: 'object',
          required: ['approved'],
          additionalProperties: false,
          properties: { approved: { type: 'boolean' } }
        }
      }
    }
  });
  assert.equal(interruptedInput.status, 'input_required');
  const interruptedInputState = getNativeTask(config, interruptedInput.taskId, { principal: owner });
  assert.equal(interruptedInputState.status, 'failed', 'input_required tasks without their executor must fail before accepting client input');
  assert.equal(interruptedInputState.error?.data?.reason, 'executor_interrupted');
  assert.equal(interruptedInputState.inputRequests, undefined, 'failed tasks must stop advertising stale input requests');
  assertRequestError(
    () => updateNativeTaskInputs(config, interruptedInput.taskId, { approval: { approved: true } }, { principal: owner }),
    'terminal_conflict'
  );

  let resumeCount = 0;
  let receivedResponses = null;
  const inputTask = activeTask('input-schema-test', {
    resume(responses) {
      resumeCount += 1;
      receivedResponses = responses;
    }
  });
  const waiting = requestNativeTaskInput(config, inputTask.taskId, {
    approval: {
      mode: 'elicitation',
      message: 'Approve?',
      responseSchema: {
        type: 'object',
        required: ['approved'],
        additionalProperties: false,
        properties: { approved: { type: 'boolean' } }
      }
    },
    credentials: {
      mode: 'elicitation',
      responseSchema: {
        type: 'object',
        required: ['token'],
        additionalProperties: false,
        properties: { token: { type: 'string', minLength: 3 } }
      }
    }
  }, { principal: owner });
  assert.equal(waiting.status, 'input_required');
  assert.deepEqual(Object.keys(waiting.inputRequests).sort(), ['approval', 'credentials']);

  assertRequestError(
    () => updateNativeTaskInputs(config, inputTask.taskId, { approval: { approved: 'yes' } }, { principal: owner })
  );
  assert.deepEqual(getNativeTaskRecord(config, inputTask.taskId, { principal: owner }).satisfiedInputKeys, []);
  assertUnavailable(() => updateNativeTaskInputs(
    config,
    inputTask.taskId,
    { approval: { approved: true } },
    { principal: otherOwner }
  ));

  const partial = updateNativeTaskInputs(
    config,
    inputTask.taskId,
    { approval: { approved: true }, unknown: { ignored: true } },
    { principal: owner }
  );
  assert.equal(partial.status, 'input_required');
  assert.deepEqual(Object.keys(partial.inputRequests), ['credentials']);
  let inputRecord = getNativeTaskRecord(config, inputTask.taskId, { principal: owner });
  assert.equal(inputRecord.inputUpdateSequence, 1);
  assert.deepEqual(inputRecord.inputUpdates[0].acceptedKeys, ['approval']);
  const replayed = updateNativeTaskInputs(
    config,
    inputTask.taskId,
    { approval: { approved: false }, unknown: { ignored: true } },
    { principal: owner }
  );
  assert.equal(replayed.status, 'input_required');
  assert.equal(getNativeTaskRecord(config, inputTask.taskId, { principal: owner }).inputUpdateSequence, 1);

  const resumed = updateNativeTaskInputs(
    config,
    inputTask.taskId,
    { credentials: { token: 'raw-client-secret' } },
    { principal: owner }
  );
  assert.equal(resumed.status, 'working');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resumeCount, 1);
  assert.deepEqual(receivedResponses, {
    approval: { approved: true },
    credentials: { token: 'raw-client-secret' }
  });
  inputRecord = getNativeTaskRecord(config, inputTask.taskId, { principal: owner });
  assert.equal(inputRecord.inputResponses.credentials.token, '[redacted]');
  assert.equal(inputRecord.inputUpdateSequence, 2);
  assert.deepEqual(inputRecord.inputUpdates.map(item => item.sequence), [1, 2]);
  completeNativeTask(config, inputTask.taskId, { ok: true }, { principal: owner });
  assertRequestError(
    () => updateNativeTaskInputs(config, inputTask.taskId, { credentials: { token: 'late' } }, { principal: owner }),
    'terminal_conflict'
  );

  const rejectedResume = activeTask('input-resume-failure-test', {
    resume: async () => {
      throw new Error('resume handler failed with token=private-value');
    }
  });
  requestNativeTaskInput(config, rejectedResume.taskId, {
    approval: {
      responseSchema: {
        type: 'object',
        required: ['approved'],
        additionalProperties: false,
        properties: { approved: { type: 'boolean' } }
      }
    }
  }, { principal: owner });
  updateNativeTaskInputs(
    config,
    rejectedResume.taskId,
    { approval: { approved: true } },
    { principal: owner }
  );
  await new Promise(resolve => setImmediate(resolve));
  const rejectedResumeState = getNativeTask(config, rejectedResume.taskId, { principal: owner });
  assert.equal(rejectedResumeState.status, 'failed');
  assert.equal(rejectedResumeState.statusMessage, 'Task failed while resuming after client input.');
  assert.equal(rejectedResumeState.error.message, 'Task execution failed.');

  const cancelController = new AbortController();
  const cancellable = activeTask('cancellation-ack-test', { controller: cancelController });
  assert.equal(nativeTaskSignal(cancellable.taskId)?.aborted, false);
  const cancellationRequested = cancelNativeTask(config, cancellable.taskId, { principal: owner });
  assert.equal(cancellationRequested.status, 'working');
  assert.equal(cancelController.signal.aborted, true);
  let cancellationRecord = getNativeTaskRecord(config, cancellable.taskId, { principal: owner });
  assert.equal(cancellationRecord.cancelRequested, true);
  assert.ok(cancellationRecord.cancellationRequestedAt);
  assert.equal(cancellationRecord.cancellationAcknowledgedAt, null);
  assert.equal(cancelNativeTask(config, cancellable.taskId, { principal: owner }).status, 'working');
  const cancelled = acknowledgeNativeTaskCancellation(config, cancellable.taskId, { principal: owner });
  assert.equal(cancelled.status, 'cancelled');
  cancellationRecord = getNativeTaskRecord(config, cancellable.taskId, { principal: owner });
  assert.ok(cancellationRecord.cancellationAcknowledgedAt);
  assert.equal(acknowledgeNativeTaskCancellation(config, cancellable.taskId, { principal: owner }).status, 'cancelled');
  assert.equal(cancelNativeTask(config, cancellable.taskId, { principal: owner }).status, 'cancelled');

  const noExecutorCancellation = createNativeTask(config, {
    principal: owner,
    method: 'tools/call',
    name: 'immediate-domain-cancellation',
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
  });
  assert.equal(cancelNativeTask(config, noExecutorCancellation.taskId, { principal: owner }).status, 'cancelled');

  const completionRaceController = new AbortController();
  const completionRace = activeTask('completion-cancellation-race', { controller: completionRaceController });
  assert.equal(cancelNativeTask(config, completionRace.taskId, { principal: owner }).status, 'working');
  const completionWon = completeNativeTask(config, completionRace.taskId, { winner: 'completion' }, { principal: owner });
  assert.equal(completionWon.status, 'completed');
  assert.equal(acknowledgeNativeTaskCancellation(config, completionRace.taskId, { principal: owner }).status, 'completed');

  const failureRaceController = new AbortController();
  const failureRace = activeTask('failure-cancellation-race', { controller: failureRaceController });
  assert.equal(cancelNativeTask(config, failureRace.taskId, { principal: owner }).status, 'working');
  const failureWon = failNativeTask(config, failureRace.taskId, 'operation failed after cancellation request', { principal: owner });
  assert.equal(failureWon.status, 'failed');
  assert.equal(acknowledgeNativeTaskCancellation(config, failureRace.taskId, { principal: owner }).status, 'failed');

  const interrupted = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'interrupted-test',
    restartPolicy: 'non_resumable'
  });
  const interruptedState = getNativeTask(config, interrupted.taskId, { principal: 'client-a' });
  assert.equal(interruptedState.status, 'failed');
  assert.equal(interruptedState.error.data.retryable, true);
  assert.equal(interruptedState.error.data.reason, 'executor_interrupted');

  const reconcilable = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'deadline-test',
    restartPolicy: 'restart_reconcilable',
    now: 1_000,
    recovery: {
      mode: 'deadline',
      completeAtMs: 2_000,
      statusMessage: 'Deadline completed.',
      result: { ok: true, source: 'durable-deadline', token: 'recovery-secret' }
    }
  });
  assert.equal(getNativeTask(config, reconcilable.taskId, { principal: 'client-a', now: 1_500 }).status, 'working');
  const reconciled = getNativeTask(config, reconcilable.taskId, { principal: 'client-a', now: 2_000 });
  assert.equal(reconciled.status, 'completed');
  assert.deepEqual(reconciled.result, { ok: true, source: 'durable-deadline', token: '[redacted]' });
  assert.deepEqual(
    getNativeTask(config, reconcilable.taskId, { principal: 'client-a', now: 2_500 }).result,
    reconciled.result,
    'final result remains durable and deterministic after reconciliation'
  );

  const oversized = activeTask('oversized-result-test', { principal: 'client-a' });
  const oversizedState = completeNativeTask(
    config,
    oversized.taskId,
    { payload: 'x'.repeat(MAX_RESULT_BYTES + 1) },
    { principal: 'client-a' }
  );
  assert.equal(oversizedState.status, 'failed');
  assert.equal(oversizedState.error.data.reason, 'result_too_large');
  const oversizedPayload = withStateDatabase(config, db => String(db.prepare('SELECT payload FROM native_tasks WHERE task_id=?').get(oversized.taskId)?.payload || ''));
  assert.ok(Buffer.byteLength(oversizedPayload) < 100_000, 'oversized results must not become oversized task records');
  assert.equal(fs.existsSync(path.join(root, 'native-tasks')), false, 'native tasks must not create canonical JSON or lock-file directories');

  const expiring = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'expiry-test',
    ttlMs: 100,
    now: 10_000,
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: 50_000, result: { ok: true } }
  });
  assertUnavailable(() => getNativeTask(config, expiring.taskId, { principal: 'client-a', now: 10_100 }));

  const expiryController = new AbortController();
  const activeExpiring = activeTask('active-expiry-test', {
    controller: expiryController,
    taskOptions: { ttlMs: 100, now: 11_000 }
  });
  assertUnavailable(() => getNativeTask(config, activeExpiring.taskId, { principal: owner, now: 11_100 }));
  assert.equal(expiryController.signal.aborted, true,
    'expiring an active native task must abort its executor before discarding the durable record');
  assert.match(String(expiryController.signal.reason?.message || ''), /expired/i);

  const concurrent = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'concurrent-input-update-test',
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
  });
  requestNativeTaskInput(config, concurrent.taskId, {
    alpha: {
      responseSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { const: 'alpha' } }
      }
    },
    beta: {
      responseSchema: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: { const: 'beta' } }
      }
    }
  }, { principal: 'client-a' });
  await Promise.all([
    runInputWorker(concurrent.taskId, 'alpha'),
    runInputWorker(concurrent.taskId, 'beta')
  ]);
  const concurrentRecord = getNativeTaskRecord(config, concurrent.taskId, { principal: 'client-a' });
  assert.equal(concurrentRecord.status, 'working');
  assert.deepEqual(Object.keys(concurrentRecord.inputResponses).sort(), ['alpha', 'beta']);
  assert.equal(concurrentRecord.inputUpdateSequence, 2);
  assert.equal(concurrentRecord.inputUpdates.length, 2);

  const atomic = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'atomic-sqlite-write-test',
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
  });
  assert.equal(getNativeTask(config, atomic.taskId, { principal: 'client-a' }).status, 'working');
  assert.equal(pruneNativeTasks(config).artifactsRemoved, 0, 'SQLite persistence has no stale native-task temp or lock artifacts to prune');
  assert.equal(fs.existsSync(stateDatabasePath(config)), true);

  const pruneTarget = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'prune-test',
    ttlMs: 100,
    now: 20_000,
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: 50_000, result: { ok: true } }
  });
  const pruned = pruneNativeTasks(config, { now: 20_100 });
  assert.ok(pruned.removed >= 1);
  assertUnavailable(() => getNativeTask(config, pruneTarget.taskId, { principal: 'client-a', now: 20_100 }));

  const opportunisticConfig = { stateDir: path.join(root, 'opportunistic-state') };
  const opportunisticExpired = createNativeTask(opportunisticConfig, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'opportunistic-prune-expired',
    ttlMs: 100,
    now: 1_000,
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: 60_000, result: { ok: true } }
  });
  assert.equal(withStateDatabase(opportunisticConfig, db => Number(db.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE task_id=?').get(opportunisticExpired.taskId)?.count || 0)), 1);
  createNativeTask(opportunisticConfig, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'opportunistic-prune-trigger',
    now: 1_000 + 60 * 60 * 1000,
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: 10_000_000, result: { ok: true } }
  });
  assert.equal(withStateDatabase(opportunisticConfig, db => Number(db.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE task_id=?').get(opportunisticExpired.taskId)?.count || 0)), 0,
    'creating native tasks after the prune interval must opportunistically remove expired SQLite records');

  const corrupt = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'corrupt-record-test',
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
  });
  withStateDatabase(config, db => db.prepare('UPDATE native_tasks SET payload=? WHERE task_id=?').run('{corrupt', corrupt.taskId), { transaction: true });
  assert.throws(
    () => getNativeTask(config, corrupt.taskId, { principal: 'client-a' }),
    error => error instanceof NativeTaskStoreError
      && error.reason === 'record_corrupt'
      && error.retryable === false
      && !error.message.includes(root)
  );
  assert.equal(withStateDatabase(config, db => Number(db.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE task_id=?').get(corrupt.taskId)?.count || 0)), 0, 'a corrupt record must leave the active task table');
  assert.equal(withStateDatabase(config, db => Number(db.prepare('SELECT COUNT(*) AS count FROM native_task_quarantine WHERE task_id=?').get(corrupt.taskId)?.count || 0)), 1, 'corrupt native tasks must move to SQLite quarantine');

  const pruneCorrupt = createNativeTask(config, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'prune-corrupt-record-test',
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
  });
  withStateDatabase(config, db => db.prepare('UPDATE native_tasks SET payload=? WHERE task_id=?').run('{}', pruneCorrupt.taskId), { transaction: true });
  const corruptionPrune = pruneNativeTasks(config);
  assert.equal(corruptionPrune.quarantined, 1);

  const quarantineConfig = { stateDir: path.join(root, 'quarantine-retention-state') };
  const quarantineTarget = createNativeTask(quarantineConfig, {
    principal: 'client-a',
    method: 'tools/call',
    name: 'quarantine-retention-test',
    restartPolicy: 'restart_reconcilable',
    recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
  });
  withStateDatabase(quarantineConfig, db => db.prepare('UPDATE native_tasks SET payload=? WHERE task_id=?').run('{corrupt', quarantineTarget.taskId), { transaction: true });
  assert.throws(
    () => getNativeTask(quarantineConfig, quarantineTarget.taskId, { principal: 'client-a' }),
    error => error instanceof NativeTaskStoreError && error.reason === 'record_corrupt'
  );
  withStateDatabase(quarantineConfig, db => db.prepare('UPDATE native_task_quarantine SET quarantined_at_ms=0 WHERE task_id=?').run(quarantineTarget.taskId), { transaction: true });
  const retentionPrune = pruneNativeTasks(quarantineConfig, { now: 8 * 24 * 60 * 60 * 1000 });
  assert.equal(retentionPrune.quarantineRemoved, 1,
    'native task pruning must remove SQLite quarantine rows older than the retention window');
  assert.equal(withStateDatabase(quarantineConfig, db => Number(db.prepare('SELECT COUNT(*) AS count FROM native_task_quarantine WHERE task_id=?').get(quarantineTarget.taskId)?.count || 0)), 0);

  const blockedState = path.join(root, 'blocked-state');
  fs.writeFileSync(blockedState, 'not a directory', 'utf8');
  assert.throws(
    () => createNativeTask({ stateDir: blockedState }, { principal: 'client-a' }),
    error => error instanceof NativeTaskStoreError
      && error.reason === 'write_failed'
      && error.retryable === true
      && error.message === 'Native task storage is unavailable.'
      && !error.message.includes(root)
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Native task lifecycle, persistence, cancellation, authorization, input safety, and result safety tests passed.');
