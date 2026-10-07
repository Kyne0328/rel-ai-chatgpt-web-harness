import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fallbackExecutionsPage, fallbackExecutionStatus, resetFallbackExecutions, startFallbackExecution, enableFallbackCompletionNotice, peekFallbackCompletionNotices, acknowledgeFallbackCompletionDelivery, waitForFallbackExecution, cancelFallbackExecution, updateFallbackExecutionPhase } from '../src/mcp/fallbackExecutions.js';
import { principalFingerprint, createStdioPrincipal } from '../src/mcp/principal.ts';
import { enrichWithFallbackCompletions, registerReturnedFallbackCompletions } from '../src/mcp/toolInvocation.js';
import { createActivityEvent } from '../src/taskObservability.js';
import { workspaceHistory } from '../src/tools/history.ts';
import { relaiStatus } from '../src/tools/status.js';
import { openStateDatabase } from '../src/stateDatabase.ts';
import { toolResult } from '../src/mcp/results.js';
import { jsonBytes } from '../src/tools/responseBudget.js';
import { taskAuditContext } from '../src/tools/task.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { HANDLERS } from '../src/tools/handlers.js';
import { getPublicToolSchemas, getToolSchemas } from '../src/tools/schema.js';

for (const operation of [OP.WORK_STATUS, OP.WORK_RESULT, OP.WORK_HISTORY]) {
  const audit = taskAuditContext({}, null, 'observed-terminal-task', operation, true);
  assert.equal(audit.taskHistoryEligible, false, `${operation} must never revise task activity or terminal timestamps`);
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-operation-receipts-'));
const config = { stateDir, workspaces: { app: { path: stateDir } } };
const principal = createStdioPrincipal();
const scope = principalFingerprint(principal);
let db;
try {
  await testBoundedResultWaits();
  let executions = 0;
  const first = startFallbackExecution({ config, scopeId: 'authorized-workspace-fixture', noticeScope: scope, workspace: 'app', tool: 'relai_edit', signature: 'mutation-one', run: async () => { executions += 1; return toolResult({ ok: true, changed: true, stdout: '🐱'.repeat(1000) }, false); } });
  await first.record.promise;
  // Simulate a lost terminal HTTP response. The same signature reuses the
  // unacknowledged result, and explicit operation retrieval never invokes run.
  const retry = startFallbackExecution({ config, scopeId: 'authorized-workspace-fixture', noticeScope: scope, workspace: 'app', tool: 'relai_edit', signature: 'mutation-one', run: async () => { executions += 1; return toolResult({ ok: true }, false); } });
  assert.equal(retry.reused, true);
  assert.equal(retry.record.operationId, first.record.operationId);
  assert.equal(executions, 1);
  const receiptPage = fallbackExecutionsPage('authorized-workspace-fixture', { config, noticeScope: scope, workspace: 'app' });
  assert.equal(receiptPage.operations[0].result, undefined);
  assert.equal(receiptPage.operations[0].resultAvailable, true);
  resetFallbackExecutions();
  const recovered = fallbackExecutionStatus(first.record.operationId, { config, noticeScope: scope, workspace: 'app' });
  assert.equal(recovered.result.changed, true, 'exact retained result survives restart');
  assert.equal(fallbackExecutionStatus(first.record.operationId, { config, noticeScope: 'other-principal', workspace: 'app' }), null);
  assert.equal(fallbackExecutionStatus(first.record.operationId, { config, noticeScope: scope, workspace: 'other-workspace' }), null);
  const result = await relaiStatus(config, { workspace: 'app', operationId: first.record.operationId, maxResponseBytes: 8000 }, { connector: true, principal });
  assert.equal(result.backgroundOperation.operationId, first.record.operationId);
  assert.equal(executions, 1, 'status/result retrieval must never rerun a mutation');
  const missing = await relaiStatus(config, { workspace: 'app', operationId: 'fallback_000000000000000000000000' }, { connector: true, principal });
  assert.equal(missing.errorCode, 'OPERATION_NOT_FOUND');

  const liveDiff = startFallbackExecution({ config, scopeId: 'live-diff-fixture', noticeScope: scope, workspace: 'app', tool: 'relai_edit', signature: 'live-diff', run: async () => toolResult({ ok: true, diff: 'x'.repeat(4000) }, false) });
  await liveDiff.record.promise;
  const smallLive = await relaiStatus(config, { workspace: 'app', operationId: liveDiff.record.operationId, maxResponseBytes: 2048 }, { connector: true, principal });
  assert.doesNotMatch(smallLive.nextAction || '', /cannot restore omitted data/, 'disk compaction must not imply that a still-live complete result is irrecoverable');
  const largeLive = await relaiStatus(config, { workspace: 'app', operationId: liveDiff.record.operationId, maxResponseBytes: 10000 }, { connector: true, principal });
  assert.equal(largeLive.backgroundOperation.result.diff.length, 4000);
  assert.equal(largeLive.backgroundOperation.resultSource, 'live');
  const retainedDiff = startFallbackExecution({ config, scopeId: 'compacted-diff-fixture', noticeScope: scope, workspace: 'app', tool: 'relai_edit', signature: 'compacted-diff', run: async () => toolResult({ ok: true, diff: 'x'.repeat(1500) }, false) });
  await retainedDiff.record.promise;
  resetFallbackExecutions();
  const partial = fallbackExecutionStatus(retainedDiff.record.operationId, { config, noticeScope: scope, workspace: 'app' });
  assert.ok(partial.result.diff.length < 1500);
  assert.equal(partial.resultTruncated, true);
  assert.equal(partial.resultSource, 'retained');
  assert.equal(partial.resultRetention.complete, false);
  assert.match(partial.nextAction, /cannot restore omitted data/);

  const noticeRecords = [];
  for (let i = 0; i < 16; i += 1) {
    const notice = startFallbackExecution({ config, scopeId: 'notice-fixture', noticeScope: scope, workspace: 'app', tool: 'relai_edit', signature: `notice-${i}`, run: async () => toolResult({ ok: true, summary: '🐱'.repeat(1000) }, false) });
    enableFallbackCompletionNotice(config, notice.record);
    await notice.record.promise;
    noticeRecords.push(notice.record);
  }
  const context = { principal, requestId: 'small-notice-response' };
  const enriched = enrichWithFallbackCompletions(config, 'relai_work', { workspace: 'app' }, { ok: true, workspace: 'app', task: { title: '🐱'.repeat(10000) } }, context);
  assert.equal(enriched.completedOperations.length, 16);
  const framed = toolResult(enriched, false, undefined, { maxResponseBytes: 2048 });
  registerReturnedFallbackCompletions(config, { workspace: 'app' }, framed, context, enriched);
  const sentIds = new Set((framed.structuredContent.completedOperations || []).map(item => item.operationId));
  acknowledgeFallbackCompletionDelivery(scope, context.requestId);
  const remainingNotices = peekFallbackCompletionNotices(config, { noticeScope: scope, workspace: 'app' });
  assert.equal(remainingNotices.length, 16 - sentIds.size, 'only final delivered notice IDs may be consumed');
  assert.ok(remainingNotices.every(item => !sentIds.has(item.operationId)));
  const omittedRecord = noticeRecords.find(item => !sentIds.has(item.operationId));
  assert.ok(omittedRecord, 'minimum-budget fixture omits at least one notice');
  const noticeRetry = startFallbackExecution({ config, scopeId: 'notice-fixture', noticeScope: scope, workspace: 'app', tool: 'relai_edit', signature: omittedRecord.signature, run: async () => { throw new Error('An unseen terminal result must not rerun its mutation'); } });
  assert.equal(noticeRetry.reused, true, 'omitted notices must retain unacknowledged terminal replay protection');

  db = openStateDatabase(config);
  const insert = db.prepare('INSERT INTO task_history(id,updated_at_ms,payload) VALUES(?,?,?)');
  for (let i = 0; i < 30; i += 1) {
    const id = `history-${i}`;
    const session = { version: 3, id, taskId: id, sessionId: id, workspace: i === 1 ? 'other' : 'app', principalFingerprint: i === 2 ? 'other' : scope, title: `Task ${i} ${'🐱'.repeat(200)}`, status: 'completed', updatedAt: new Date(1700000000000 + i).toISOString(), events: [createActivityEvent({ eventId: `event-${i}`, taskId: id, timestamp: '2026-10-01T00:00:00Z', tool: { name: 'relai_exec', operation: 'exec' }, status: 'succeeded', summary: '🐱'.repeat(5000) })] };
    insert.run(id, 1700000000000 + i, JSON.stringify(session));
  }
  const ids = new Set();
  let cursor;
  do {
    const page = workspaceHistory(config, { workspace: 'app', limit: 100, maxResponseBytes: 2048, ...(cursor ? { cursor } : {}) }, { principal });
    assert.ok(jsonBytes(page) <= 2048);
    for (const task of page.tasks) { assert.ok(!ids.has(task.work_id), 'paging must not repeat or skip trimmed summaries'); ids.add(task.work_id); }
    cursor = page.hasMore ? page.cursor : null;
    assert.ok(!page.hasMore || cursor, 'fixture rows must fit at least one minimum-budget summary');
  } while (cursor);
  assert.equal(ids.size, 28);
  assert.ok(!ids.has('history-1') && !ids.has('history-2'));
  const activity = workspaceHistory(config, { workspace: 'app', kind: 'activity', taskId: 'history-3', maxResponseBytes: 4096 }, { principal });
  assert.equal(activity.entries.length, 1);
  assert.equal(activity.entries[0].eventId, 'event-3');
  assert.equal(activity.entries[0].tool, 'relai_exec', 'modern structured tool identity must not become [object Object]');
  assert.equal(activity.entries[0].metadata, undefined, 'history returns a typed projection rather than arbitrary retained payloads');
  assert.throws(() => workspaceHistory(config, { workspace: 'app', kind: 'activity', cursor: activity.cursor }, { principal: createStdioPrincipal() }), /Invalid history cursor/);
} finally {
  db?.close(); resetFallbackExecutions(); fs.rmSync(stateDir, { recursive: true, force: true });
}
console.log('Retained operation retrieval, lost-response retry, history scoping and pagination checks passed.');

async function testBoundedResultWaits() {
  const context = { connector: true, principal, backgroundStatusMode: true };
  const options = { config, noticeScope: scope, workspace: 'app' };
  let sequence = 0;
  function pending() {
    let release;
    let runs = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const operation = startFallbackExecution({ ...options, scopeId: `result-wait-${++sequence}`, tool: 'relai_exec', signature: `wait-${sequence}`,
      run: async () => { runs++; await gate; return toolResult({ ok: true, marker: 'original-result' }, false); } });
    return { ...operation, release, runs: () => runs };
  }
  const operation = pending();
  const args = { workspace: 'app', operationId: operation.record.operationId };
  const waiting = HANDLERS.operationResult(config, args, context);
  const status = await relaiStatus(config, args, context);
  assert.equal(status.backgroundOperation.status, 'running', 'status stays immediate while result retrieval waits');
  const immediate = await HANDLERS.operationResult(config, { ...args, waitMs: 0 }, context);
  assert.equal(immediate.backgroundOperation.status, 'running');
  const foreign = await HANDLERS.operationResult(config, args, { ...context, principal: createStdioPrincipal(), signal: AbortSignal.timeout(100) });
  assert.equal(foreign.errorCode, 'OPERATION_NOT_FOUND', 'foreign result must be rejected before waiting');
  const wrongWorkspace = await waitForFallbackExecution(args.operationId, { ...options, workspace: 'other', signal: AbortSignal.timeout(100) });
  assert.equal(wrongWorkspace, null);
  const wrongTask = await waitForFallbackExecution(args.operationId, { ...options, workId: 'another-task', signal: AbortSignal.timeout(100) });
  assert.equal(wrongTask, null);
  operation.release();
  const completed = await waiting;
  assert.equal(completed.backgroundOperation.result.marker, 'original-result');
  assert.equal(completed.backgroundOperation.operationId, args.operationId);
  assert.equal(operation.runs(), 1, 'result wait must not execute the command again');

  const held = pending();
  const shortWait = await waitForFallbackExecution(held.record.operationId, { ...options, waitMs: 15 });
  assert.equal(shortWait.status, 'running');
  assert.equal(held.record.controller.signal.aborted, false, 'wait timeout must not cancel background work');
  const deadlineWait = await waitForFallbackExecution(held.record.operationId, { ...options, waitMs: 5000, deadlineAtMs: Date.now() + 15 });
  assert.equal(deadlineWait.status, 'running', 'an inherited deadline caps the wait');
  const abort = new AbortController();
  const abortedWait = HANDLERS.operationResult(config, { workspace: 'app', operationId: held.record.operationId }, { ...context, signal: abort.signal });
  abort.abort(new Error('caller disconnected'));
  const interrupted = await abortedWait;
  assert.equal(interrupted.backgroundOperation.status, 'running');
  assert.equal(interrupted.backgroundOperation.retrievalInterrupted, true);
  assert.equal(interrupted.backgroundOperation.recovery.operationId, held.record.operationId);
  assert.equal(interrupted.backgroundOperation.recovery.retryOriginalOperation, false);
  assert.equal(interrupted.backgroundOperation.recovery.respectUserStop, true);
  const preAborted = AbortSignal.abort(new Error('private abort details'));
  assert.equal(await waitForFallbackExecution(held.record.operationId, { ...options, noticeScope: 'foreign', signal: preAborted }), null);
  const authorizedPreAborted = await waitForFallbackExecution(held.record.operationId, { ...options, signal: preAborted });
  assert.equal(authorizedPreAborted.retrievalInterrupted, true);
  assert.doesNotMatch(JSON.stringify(authorizedPreAborted), /private abort details/);
  const completedPreAborted = await waitForFallbackExecution(operation.record.operationId, { ...options, signal: preAborted });
  assert.equal(completedPreAborted.status, 'completed');
  assert.equal(completedPreAborted.result.marker, 'original-result');
  assert.equal(held.record.controller.signal.aborted, false, 'disconnect cancels retrieval, not its existing execution');
  const cancelledWait = waitForFallbackExecution(held.record.operationId, options);
  cancelFallbackExecution(held.record.operationId, { config, reason: 'cancel the operation itself' });
  held.release();
  assert.equal((await cancelledWait).status, 'cancelled', 'operation cancellation wakes result retrieval');

  const occupied = Array.from({ length: 4 }, pending);
  const waiters = occupied.map(item => waitForFallbackExecution(item.record.operationId, options));
  const excess = pending();
  assert.equal((await waitForFallbackExecution(excess.record.operationId, { ...options, signal: AbortSignal.timeout(100) })).status, 'running',
    'excess result waits return a receipt without occupying another tunnel slot');
  occupied.forEach(item => item.release());
  assert.ok((await Promise.all(waiters)).every(item => item.status === 'completed'));
  const freshWait = waitForFallbackExecution(excess.record.operationId, options);
  excess.release();
  assert.equal((await freshWait).status, 'completed', 'settlement, timeouts and aborts release waiter admission');

  const failed = startFallbackExecution({ ...options, scopeId: 'failed-result-wait', tool: 'relai_exec', signature: 'failed-wait', run: async () => { throw new Error('fixture command failed'); } });
  const failure = await waitForFallbackExecution(failed.record.operationId, options);
  assert.equal(failure.status, 'failed');
  assert.match(failure.error, /fixture command failed/);

  const polling = pending();
  const started = polling.record.startedAtMs;
  const initial = fallbackExecutionStatus(polling.record.operationId, { now: () => started + 2000 });
  const older = fallbackExecutionStatus(polling.record.operationId, { now: () => started + 180000 });
  assert.ok(initial.pollAfterMs < 5000, 'recent work must not recommend a 30-second polling gap');
  assert.ok(older.pollAfterMs >= 60000, 'long-running work retains backoff');
  updateFallbackExecutionPhase(polling.record.operationId, 'persisting', config);
  assert.ok(fallbackExecutionStatus(polling.record.operationId, { now: () => started + 180000 }).pollAfterMs < 5000,
    'finalization recommends prompt retrieval even for an older operation');
  polling.release(); await polling.record.promise;
  const schema = getPublicToolSchemas().find(tool => tool.name === 'relai_work');
  assert.equal(schema.inputSchema.properties.waitMs.type, 'integer', 'waitMs must be discoverable');
  assert.equal(getToolSchemas().find(tool => tool.name === 'relai_work').inputSchema.properties.waitMs.maximum, 5000, 'the executable contract bounds waitMs');
}
