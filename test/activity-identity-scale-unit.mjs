import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { canonicalTaskSnapshot, reduceTaskLifecycleAuditEvent } from '../src/taskLifecycle.js';

const count = 3000;
const record = index => ({ eventId: `event-${index}`, taskId: 'scale', tool: 'read', ok: index % 2 === 0, ts: '2026-10-05T00:00:00.000Z' });
let task = { id: 'scale', taskId: 'scale', workspace: 'repo' };
const ingestStarted = performance.now();
for (let index = 0; index < count; index += 1) task = reduceTaskLifecycleAuditEvent(task, record(index));
const ingestMs = performance.now() - ingestStarted;
const ledger = task.eventCounterReceipts;
const ledgerBytes = Buffer.byteLength(JSON.stringify(ledger));
assert.equal(Array.isArray(ledger), false, 'receipts need keyed lookup independent of lifetime event count');
assert.equal(Object.keys(ledger.outcomes).length, count);
assert.ok(ledgerBytes < count * 80, `compact canonical-ID receipts exceeded 80 bytes/call: ${ledgerBytes}`);
assert.equal(canonicalTaskSnapshot(task).eventCounterReceipts, ledger, 'snapshot reads must reuse an unchanged receipt index');
const replayStarted = performance.now();
for (let index = 0; index < count; index += 1) task = reduceTaskLifecycleAuditEvent(task, record(index));
const replayMs = performance.now() - replayStarted;
assert.equal(task.eventCounterReceipts, ledger, 'a replay must not rebuild a lifetime receipt dictionary');
assert.equal(task.calls, count);
assert.equal(task.failures, count / 2);
assert.equal(task.events.length, 200);
// Broad regression guard; print timings for controlled runtime budget checks.
assert.ok(ingestMs < 15000 && replayMs < 15000, `3,000-record ingestion/replay exceeded 15s: ${ingestMs}/${replayMs}`);
console.log(JSON.stringify({ test: 'activity-identity-scale', count, ingestMs: Math.round(ingestMs), replayMs: Math.round(replayMs), ledgerBytes }));
