import assert from 'node:assert/strict';
import { diagnosticDuration, diagnosticTime, operationDiagnostics, runtimeBuildDiagnostics } from '../src/ui/operation-diagnostics.js';

const now = Date.parse('2026-10-05T01:00:10Z');
const start = '2026-10-05T01:00:00Z';
const waiting = {
  id: 'operation-1', status: 'running', metadata: { timeline: {
    phase: 'queued', phaseStartedAt: start, lastProgressAt: start, executed: false,
    deadlineKind: 'admission', terminationCertainty: 'not-started', queuePosition: 2,
    blocking: { owner: 'Workspace writer', operationId: 'operation-owner', taskId: 'task-owner' },
    phases: [{ phase: 'accepted', startedAt: '2026-10-05T00:59:59Z', endedAt: start, durationMs: 1000 }, { phase: 'queued', startedAt: start, durationMs: 3000 }]
  } }
};
const waitingCopy = structuredClone(waiting);
const view = operationDiagnostics(waiting, now);
assert.equal(view.title, 'Waiting for this owner');
assert.equal(view.owner, 'Workspace writer');
assert.equal(view.blockingOperationId, 'operation-owner');
assert.equal(view.blockingTaskId, 'task-owner');
assert.equal(view.queuePosition, 2);
assert.equal(view.executed, false);
assert.equal(view.currentElapsedMs, 10_000);
assert.equal(view.phases[0].durationMs, 1000);
assert.equal(view.phases[1].durationMs, 3000, 'server-measured duration must not be overwritten by the browser clock');
assert.deepEqual(operationDiagnostics(waiting, now), view, 'repeated polling must preserve the same presentation');
assert.deepEqual(waiting, waitingCopy, 'presentation must not mutate the authoritative receipt');
assert.equal(operationDiagnostics({ activity: { metadata: waiting.metadata } }, now).title, view.title, 'active-operation metadata wrapper is supported');

const exited = { ...waiting.metadata.timeline, phase: 'draining-output', executed: true, childExitedAt: start, terminationCertainty: 'unknown' };
assert.equal(operationDiagnostics({ timeline: exited }, now).title, 'Command exited, collecting result');
assert.equal(operationDiagnostics({ timeline: { ...exited, phase: 'reconciling' } }, now).title, 'Command exited, collecting result');
assert.equal(operationDiagnostics({ timeline: { ...exited, phase: 'persisting', childExitedAt: null } }, now).title, 'Collecting result', 'saving a result alone does not prove a child exited');
assert.equal(operationDiagnostics({ timeline: { phase: 'spawned' } }, now).title, 'Command running');
assert.equal(operationDiagnostics({ timeline: { phase: 'running' } }, now).title, 'Executing action');
assert.equal(operationDiagnostics({ timeline: { phase: 'host-queued' } }, now).title, 'Waiting for host capacity');
assert.equal(operationDiagnostics({ timeline: { phase: 'queued' } }, now).title, 'Waiting for admission');
assert.equal(operationDiagnostics({ status: 'failed', metadata: waiting.metadata }, now).title, 'Stopped before execution', 'admission failure is not a hung command');

const ready = operationDiagnostics({ id: 'operation-1', result: { timeline: { ...exited, phase: 'result-ready', terminationCertainty: 'unconfirmed' } } }, now);
assert.equal(ready.title, 'Result ready');
assert.equal(ready.currentElapsedMs, null, 'terminal phases must not continue a live clock');
assert.match(ready.detail, /existing operation result/);
assert.doesNotMatch(ready.detail, /acknowledged/i, 'result availability is not delivery acknowledgement');
assert.match(ready.warning, /termination is unconfirmed/);
assert.match(operationDiagnostics({ timeline: { phase: 'delivered' } }).detail, /acknowledged/);
assert.equal(operationDiagnostics({ timeline: { phase: 'result-ready' }, resultAvailable: false }).title, 'Result unavailable');
assert.match(operationDiagnostics({ timeline: { phase: 'result-ready' }, resultAvailable: false }).detail, /absence does not prove/);
assert.match(operationDiagnostics({ timeline: { phase: 'result-ready', outputFinalizationTimedOut: true } }).warning, /incomplete output/);
const combinedWarning = operationDiagnostics({ timeline: {
  phase: 'result-ready', terminationCertainty: 'unconfirmed', outputFinalizationTimedOut: true
} }).warning;
assert.match(combinedWarning, /termination is unconfirmed/, 'incomplete output must not hide the safety warning');
assert.match(combinedWarning, /incomplete output/, 'unconfirmed termination must not hide the output completeness warning');

for (const legacy of [undefined, null, {}, { status: 'completed' }, { status: 'cancelled' }, { metadata: {} }]) {
  const old = operationDiagnostics(legacy, now);
  assert.equal(old.executed, null);
  assert.equal(old.terminationCertainty, 'unknown');
  assert.equal(old.lastProgressAt, null);
  assert.equal(old.queuePosition, null);
  assert.equal(old.currentElapsedMs, null);
  assert.deepEqual(old.phases, []);
}
assert.equal(operationDiagnostics({ status: 'completed' }).title, 'Operation ended', 'legacy terminal status does not claim a retained result is available');
const partial = operationDiagnostics({ timeline: { phase: 'unknown-future-phase', phaseStartedAt: 'bad-date', queuePosition: -2, phases: [
  { phase: 'accepted', durationMs: null },
  { phase: 'queued', durationMs: -1 },
  { phase: 'admitted', durationMs: Number.NaN },
  { phase: 'preparing', startedAt: start, endedAt: '2026-10-05T01:00:02Z' },
  { phase: 'spawned', startedAt: start, endedAt: '2026-10-04T01:00:00Z' },
  { phase: 'draining-output', durationMs: 0 }
] } }, now);
assert.equal(partial.phaseLabel, 'Unknown');
assert.deepEqual(partial.phases.map(item => item.durationMs), [null, null, null, 2000, null, 0]);
assert.equal(partial.phaseStartedAt, null);
assert.equal(operationDiagnostics({ timeline: { phaseStartedAt: now + 1000 } }, now).currentElapsedMs, null, 'clock skew must not fabricate negative or zero timing');
assert.equal(operationDiagnostics({ timeline: { phases: Array.from({ length: 100 }, () => ({ phase: 'queued', durationMs: 1 })), phasesTruncated: true } }).phases.length, 24);
assert.equal(diagnosticDuration(null), 'Unknown');
assert.equal(diagnosticDuration(0), '0 ms');
assert.equal(diagnosticDuration(123), '123 ms');
assert.equal(diagnosticDuration(1234), '1.23 s');
assert.equal(diagnosticDuration(61_234), '1m 1.2s');
assert.equal(diagnosticTime(null), 'Unknown');
assert.equal(diagnosticTime('bad-date'), 'Unknown');
assert.equal(diagnosticTime(String(now)), '2026-10-05T01:00:10.000Z');

const identity = runtimeBuildDiagnostics({ buildIdentity: {
  buildId: 'build-1', sourceRevision: 'abc', dirty: true, sourceFingerprint: 'sha256:abc', startedAt: start, schemaDigest: 'schema-1'
} }, { metadataMatches: true, sourceParity: { status: 'unknown', verified: false } });
const facts = Object.fromEntries(identity.facts);
assert.equal(identity.buildId, 'build-1');
assert.equal(facts['Dirty source'], 'Yes');
assert.equal(facts['Release metadata'], 'Matches');
assert.equal(facts['Source/build parity'], 'Unknown', 'matching release metadata must not claim code parity');
assert.equal(facts['Built at'], 'Unknown');
assert.equal(Object.fromEntries(runtimeBuildDiagnostics({}, { sourceParity: { status: 'matches', verified: false } }).facts)['Source/build parity'], 'Unknown');
assert.equal(Object.fromEntries(runtimeBuildDiagnostics({}, { sourceParity: { status: 'matches', verified: true } }).facts)['Source/build parity'], 'Verified match');
assert.equal(Object.fromEntries(runtimeBuildDiagnostics({}, { sourceParity: { status: 'different' } }).facts)['Source/build parity'], 'Different');
const cachedParity = Object.fromEntries(runtimeBuildDiagnostics({}, { sourceParity: { status: 'matches', verified: true, cached: true, checkedAt: start } }).facts);
assert.equal(cachedParity['Source/build parity'], 'Matches last measured snapshot');
assert.equal(cachedParity['Parity checked'], '2026-10-05T01:00:00.000Z');
for (const legacy of [undefined, null, {}]) {
  assert.equal(runtimeBuildDiagnostics(legacy, null).buildId, 'Unknown');
  assert.equal(Object.fromEntries(runtimeBuildDiagnostics(legacy).facts)['Dirty source'], 'Unknown');
}
console.log('Operation diagnostics: waiting, finalization, retained results, unknown legacy data, timing and build-identity behavior passed.');
