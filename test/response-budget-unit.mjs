import assert from 'node:assert/strict';
import { boundResponsePayload, jsonBytes } from '../src/tools/responseBudget.js';
import { toolResult } from '../src/mcp/results.js';

for (const limit of [2048, 4096, 8000, 16000]) {
  const operations = Array.from({ length: 250 }, (_, index) => ({ operationId: `fallback_${String(index).padStart(24, '0')}`, status: 'completed', cursor: `cursor-${index}`, resultAvailable: true, resultSummary: { terminationConfirmed: true, stdoutOutputRef: `spill_${index}` } }));
  const result = toolResult({ ok: true, backgroundOperations: operations, operationCursor: 'cursor-249', operationsHasMore: false, task: { title: '🐱'.repeat(20000) } }, false, undefined, { maxResponseBytes: limit });
  assert.ok(jsonBytes(result) <= limit, `whole tool result must fit ${limit} UTF-8 bytes`);
  assert.equal(result.structuredContent.responseBudget.returnedBytes, jsonBytes(result));
  assert.equal(result.structuredContent.responseBudget.complete, false);
  const page = result.structuredContent.backgroundOperations;
  if (page?.length) assert.equal(result.structuredContent.operationCursor, page.at(-1).cursor, 'cursor must follow the last delivered row');
}
const giant = { ok: true, entries: [{ eventId: 'one', cursor: 'after-one', summary: '🐱'.repeat(50000) }], cursor: 'after-one', hasMore: false };
const single = boundResponsePayload(giant, 1024);
assert.ok(jsonBytes(single) <= 1024);
assert.equal(single.entries[0].eventId, 'one');
assert.equal(single.entries[0].receiptTruncated, true);
assert.equal(single.cursor, 'after-one');
const oversizeCursor = boundResponsePayload({ ...giant, entries: [{ ...giant.entries[0], cursor: 'x'.repeat(9000) }] }, 1024);
assert.equal(oversizeCursor.entries.length, 0);
assert.equal(oversizeCursor.cursor, null, 'an undelivered giant row must never advance the cursor');
assert.equal(oversizeCursor.hasMore, true);
const droppedBody = boundResponsePayload({ ok: true, operationId: 'fallback_fixture_operation_000001', backgroundOperation: { operationId: 'fallback_fixture_operation_000001', status: 'completed', resultSource: 'live', result: { diff: 'x'.repeat(50000) }, resultRetention: { complete: false } }, extraMetadata: 'x'.repeat(50000) }, 2048);
assert.match(droppedBody.nextAction, /relai_work action result/);
assert.doesNotMatch(droppedBody.nextAction, /cannot restore/);
assert.ok(jsonBytes(droppedBody) <= 2048);
const omittedImage = toolResult({ ok: true, image: { data: 'a'.repeat(10000), mimeType: 'image/png' } }, false, undefined, { maxResponseBytes: 2048 });
assert.ok(jsonBytes(omittedImage) <= 2048);
assert.ok(omittedImage.content.every(item => item.type === 'text'));
assert.equal(omittedImage.structuredContent.truncated, true, 'dropping non-text MCP content must disclose incompleteness');
assert.equal(omittedImage.structuredContent.responseBudget.complete, false);
console.log('UTF-8 response budgets and no-skip pagination checks passed.');
