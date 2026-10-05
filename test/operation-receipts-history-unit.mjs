import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fallbackExecutionsPage, fallbackExecutionStatus, resetFallbackExecutions, startFallbackExecution, enableFallbackCompletionNotice, peekFallbackCompletionNotices, acknowledgeFallbackCompletionDelivery } from '../src/mcp/fallbackExecutions.js';
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
