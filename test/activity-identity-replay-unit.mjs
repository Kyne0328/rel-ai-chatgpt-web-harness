import assert from 'node:assert/strict';
import { canonicalizeActivityEvents, ensureActivityEventIdentity, previewActivityReconciliation } from '../src/taskEventIdentity.js';
import { eventIdentityKey } from '../src/taskEvents.js';
import { canonicalTaskSnapshot, mergeTaskLifecycleSnapshots, reduceTaskLifecycleAuditEvent } from '../src/taskLifecycle.js';

const base = { id: 'task-replay', taskId: 'task-replay', workspace: 'repo', status: 'planning' };
const legacy = { taskId: base.id, ts: '2026-10-05T01:00:00.000Z', tool: 'read', ok: false, error: 'same failure' };
for (const key of ['id', 'auditId', 'operationId', 'eventId']) {
  const record = { ...legacy, [key]: `existing-${key}` };
  assert.equal(eventIdentityKey(record), `existing-${key}`);
  const once = reduceTaskLifecycleAuditEvent(base, record);
  const twice = reduceTaskLifecycleAuditEvent(JSON.parse(JSON.stringify(once)), { ...record });
  assert.equal(twice.calls, 1, `${key}-only replay must not increment calls`);
  assert.equal(twice.failures, 1, `${key}-only replay must not increment failures`);
  assert.equal(twice.events.length, 1);
}

const rawSnapshot = { ...base, calls: 2, failures: 2, failedToolCallCount: 2, events: [{ ...legacy }, { ...legacy }] };
const once = canonicalTaskSnapshot(rawSnapshot);
assert.equal(new Set(once.events.map(eventIdentityKey)).size, 2, 'distinct equal-looking occurrences in a snapshot remain distinct');
let merged = mergeTaskLifecycleSnapshots(once, rawSnapshot);
merged = mergeTaskLifecycleSnapshots(JSON.parse(JSON.stringify(merged)), rawSnapshot);
assert.equal(merged.events.length, 2, 'merging a snapshot repeatedly must not append its ID-less events');
assert.equal(merged.calls, 2);
assert.equal(merged.failures, 2);
assert.deepEqual(rawSnapshot.events, [{ ...legacy }, { ...legacy }], 'import does not mutate source records');

const imported = canonicalizeActivityEvents([{ ...legacy }, { ...legacy }], { source: 'audit-generation-A' });
const otherSource = canonicalizeActivityEvents([{ ...legacy }], { source: 'audit-generation-B' });
assert.notEqual(imported[0].eventId, imported[1].eventId);
assert.notEqual(imported[0].eventId, otherSource[0].eventId, 'identical records from distinct sources are not content-deduplicated');
let replayed = base;
for (const event of [...imported, ...imported, ...otherSource]) replayed = reduceTaskLifecycleAuditEvent(replayed, { ...event });
assert.equal(replayed.calls, 3);
assert.equal(replayed.failures, 3);
assert.equal(replayed.events.length, 3);

const fresh1 = ensureActivityEventIdentity({ ...legacy });
const fresh2 = ensureActivityEventIdentity({ ...legacy });
assert.notEqual(fresh1.eventId, fresh2.eventId, 'fresh identical invocations get unique IDs at ingestion');
const record = { ...legacy };
assert.equal(ensureActivityEventIdentity(record).eventId, ensureActivityEventIdentity(record).eventId, 'the same ingestion object is stable until persistence');
let directReplay = reduceTaskLifecycleAuditEvent(base, legacy, { eventSource: 'legacy-audit', eventOccurrence: 9 });
directReplay = reduceTaskLifecycleAuditEvent(directReplay, { ...legacy }, { eventSource: 'legacy-audit', eventOccurrence: 9 });
assert.equal(directReplay.calls, 1);

let running = canonicalTaskSnapshot({ ...base, calls: 1, toolCallCount: 1,
  events: [{ id: 'running-legacy', status: 'running', taskId: base.id, ts: legacy.ts, tool: 'read' }] });
running = reduceTaskLifecycleAuditEvent(JSON.parse(JSON.stringify(running)), { ...legacy, id: 'running-legacy', status: 'failed' });
assert.equal(running.calls, 1, 'running-to-terminal replay after restart replaces a single invocation');
assert.equal(running.failures, 1, 'a represented running invocation must still add its terminal failure once');
running = reduceTaskLifecycleAuditEvent(JSON.parse(JSON.stringify(running)), { ...legacy, id: 'running-legacy', status: 'failed' });
assert.equal(running.failures, 1);
assert.equal(running.events[0].status, 'failed');

let longTask = base;
for (let i = 0; i < 220; i += 1) longTask = reduceTaskLifecycleAuditEvent(longTask, { ...legacy, id: `retained-${i}` });
assert.equal(longTask.events.length, 200);
longTask = reduceTaskLifecycleAuditEvent(JSON.parse(JSON.stringify(longTask)), { ...legacy, id: 'retained-0' });
assert.equal(longTask.calls, 220, 'event receipts outlive the bounded display tail');
assert.equal(longTask.failures, 220);
const before = JSON.stringify(imported);
const preview = previewActivityReconciliation([...imported, imported[0]]);
assert.equal(preview.readOnly, true);
assert.equal(preview.repeatedIdentityGroupCount, 1);
assert.equal(preview.similarContentGroupCount, 1);
assert.equal(JSON.stringify(imported), before);
console.log('Activity identities preserve distinct occurrences, replay idempotently, and keep counters stable after restart and display-tail rollover.');

let aliasTask = canonicalTaskSnapshot({ ...base, calls: 1, events: [{ eventId: 'canonical-one', operationId: 'op-one', status: 'running' }] });
aliasTask = reduceTaskLifecycleAuditEvent(aliasTask, { ...legacy, operationId: 'op-one', auditId: 'audit-one' });
assert.equal(aliasTask.calls, 1, 'existing operation aliases must preserve the original canonical ID');
assert.equal(aliasTask.events[0].eventId, 'canonical-one');
assert.equal(aliasTask.failures, 1);
aliasTask = reduceTaskLifecycleAuditEvent(aliasTask, { ...legacy, auditId: 'audit-one' });
assert.equal(aliasTask.calls, 1, 'a persisted audit alias must replay against the same canonical identity');
assert.equal(aliasTask.failures, 1);

let projectedTerminal = canonicalTaskSnapshot({ ...base, calls: 1, failures: 1, failedToolCallCount: 1,
  eventCounterReceipts: [{ eventId: 'live-failure', outcome: 'pending' }],
  events: [{ eventId: 'live-failure', status: 'failed', ok: false }] });
projectedTerminal = reduceTaskLifecycleAuditEvent(projectedTerminal, { ...legacy, eventId: 'live-failure' });
assert.equal(projectedTerminal.failures, 1, 'terminal live projection counters must not be added again by its audit enrichment');

const boundedPreview = previewActivityReconciliation(Array.from({ length: 1000 }, () => imported[0]), { maxSamples: 3 });
assert.equal(boundedPreview.repeatedIdentities[0].count, 1000);
assert.equal(boundedPreview.repeatedIdentities[0].indexes.length, 3);
assert.equal(boundedPreview.similarContent[0].rows.length, 3);
assert.equal(boundedPreview.truncated, true);

const largeImport = canonicalTaskSnapshot({ ...base, calls: 250, failures: 250,
  events: Array.from({ length: 250 }, (_, index) => ({ ...legacy, id: `imported-${index}` })) });
assert.equal(largeImport.events.length, 200);
const importReplay = reduceTaskLifecycleAuditEvent(JSON.parse(JSON.stringify(largeImport)), { ...legacy, id: 'imported-0' });
assert.equal(importReplay.calls, 250, 'receipt import must precede display-tail truncation');
assert.equal(importReplay.failures, 250);
