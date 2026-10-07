import assert from 'node:assert/strict';
import { toolResult } from '../src/mcp/results.js';
import { executionOutcome } from '../src/executionOutcome.js';
import { summarizeCommand } from '../src/process.js';
import { compactCommandResult } from '../src/tools/connectorHelpers.js';
import { fromJsonSchema } from '@modelcontextprotocol/server';

import { serializeConnectorResult } from '../src/tools/connector.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { outputSchemaFor } from '../src/tools/outputSchemas.js';

async function assertValid(operation, value, message) {
  const validator = fromJsonSchema(outputSchemaFor(operation))['~standard'];
  const result = await validator.validate(value);
  assert.equal(result.issues, undefined, message);
}

const exec = serializeConnectorResult({
  publicName: 'relai_exec',
  action: '',
  operationName: OP.EXEC,
  value: {
    ok: true,
    executed: true,
    commandSucceeded: true,
    exitCode: 0,
    durationMs: 12,
    stdout: 'ok'
  },
  args: { workspace: 'repo', command: 'node --version' }
});
assert.equal(exec.workspace, 'repo', 'exec serialization must recover workspace identity from the request when the handler result omits it');
await assertValid(OP.EXEC, exec, 'serialized exec result must satisfy the advertised output contract');

const failedSpill = serializeConnectorResult({
  publicName: 'relai_exec', action: '', operationName: OP.EXEC,
  value: {
    ok: true, executed: true, commandSucceeded: false, exitCode: 7,
    durationMs: 12, stdout: 'retained stdout tail', stderr: 'retained stderr tail',
    stdoutTruncated: true, stderrTruncated: true,
    stdoutSpillTruncated: true, stderrSpillTruncated: true
  },
  args: { workspace: 'repo', executable: 'node', argv: ['fixture.js'] }
});
assert.equal(failedSpill.exitCode, 7);
assert.equal(failedSpill.stdoutSpillTruncated, true);
assert.equal(failedSpill.stderrSpillTruncated, true);
assert.equal(failedSpill.stdoutOutputRef, undefined);
assert.equal(failedSpill.stderrOutputRef, undefined);
await assertValid(OP.EXEC, failedSpill, 'output-storage failure diagnostics must satisfy the public exec contract');

const checks = serializeConnectorResult({
  publicName: 'relai_validate',
  action: 'checks',
  operationName: OP.VALIDATE_CHECKS,
  value: {
    ok: true,
    results: [{ command: 'npm test', ok: true, exitCode: 0 }],
    validationStatus: 'passed'
  },
  args: { workspace: 'repo', action: 'checks', checks: ['npm test'] }
});
assert.equal(checks.workspace, 'repo', 'validation serialization must recover workspace identity from the request when needed');
await assertValid(OP.VALIDATE_CHECKS, checks, 'serialized validation success must satisfy the advertised output contract');

await assertValid(OP.VALIDATE_CHECKS, {
  ok: false,
  workspace: 'repo',
  results: [{ command: 'npm test', ok: false, exitCode: 1 }],
  validationStatus: 'failed'
}, 'a failed validation is an ordinary validation outcome and must not require a synthetic error field');

await assertValid(OP.VALIDATE_DIAGNOSTICS, {
  ok: false,
  workspace: 'repo',
  commands: [],
  diagnostics: [],
  message: 'No diagnostic command was detected.'
}, 'a diagnostics outcome with no runnable command must serialize without a synthetic error field');


for (const confirmed of [false, true]) {
  const safety = {
    command: 'node fixture.js', ok: false, exitCode: -1, executed: false,
    timedOut: true, cancelled: false, terminationConfirmed: confirmed,
    forcedTermination: false, mutationUnknown: !confirmed,
    stdout: 'partial output', stderr: 'partial error', stdoutTruncated: true,
    privateFixtureField: 'must not leak'
  };
  const compacted = serializeConnectorResult({
    publicName: 'relai_validate', action: 'checks', operationName: OP.VALIDATE_CHECKS,
    value: { ok: false, validationStatus: 'failed', timedOut: true, cancelled: false, results: [safety] },
    args: { workspace: 'repo', checks: ['node fixture.js'] }
  });
  assert.equal(compacted.timedOut, true);
  assert.equal(compacted.cancelled, false);
  for (const key of ['executed', 'timedOut', 'cancelled', 'terminationConfirmed', 'forcedTermination', 'mutationUnknown']) {
    assert.equal(compacted.results[0][key], safety[key], key + ' must preserve explicit safety facts');
  }
  assert.equal(compacted.results[0].stdout, 'partial output');
  assert.equal(compacted.results[0].stderr, 'partial error');
  assert.equal(compacted.results[0].stdoutTruncated, true);
  assert.equal(Object.hasOwn(compacted.results[0], 'privateFixtureField'), false);
  await assertValid(OP.VALIDATE_CHECKS, compacted, 'timeout safety evidence must satisfy the existing schema');
}


const admissionOutcome = {
  executed: false, commandSucceeded: false, exitCode: -1, durationMs: 0,
  admissionBlocked: true, queueWaitMs: 17, queueTimedOut: true,
  errorCode: 'HOST_RESOURCE_QUEUE_TIMEOUT', blockedResource: 'heavy',
  resourceReason: 'Physical memory is below the admission floor.', retryable: true,
  resourcePressure: { state: 'pressured', physicalAvailableBytes: 0, requiredReservationBytes: 134217728 },
  timedOut: false, cancelled: false, rootExitConfirmed: false,
  terminationConfirmed: true, forcedTermination: false, mutationUnknown: false,
  outputFinalizationTimedOut: false,
  stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false,
  stdoutOutputRef: 'spill_abcdefghijklmnopqrstuvwx',
  stderrOutputRef: 'spill_yxwvutsrqponmlkjihgfedcb',
  stdoutSpillTruncated: false, stderrSpillTruncated: true,
  error: 'Host admission timed out before spawn.'
};
const privateExecution = { ...admissionOutcome, privateFixtureField: 'must not leak' };
const outcome = executionOutcome(privateExecution);
assert.deepEqual(outcome, admissionOutcome, 'one allowlist retains supplied execution facts without copying private fields');
assert.deepEqual(executionOutcome({}), {}, 'missing execution facts must remain missing');
const summarized = summarizeCommand(privateExecution);
const compactSummary = compactCommandResult(summarized);
const admittedExec = serializeConnectorResult({
  publicName: 'relai_exec', action: '', operationName: OP.EXEC,
  value: { ok: true, ...privateExecution },
  args: { workspace: 'repo', executable: 'node', argv: ['fixture.js'] }
});
const admittedChecks = serializeConnectorResult({
  publicName: 'relai_validate', action: 'checks', operationName: OP.VALIDATE_CHECKS,
  value: { ok: false, validationStatus: 'failed', results: [summarized] },
  args: { workspace: 'repo', checks: ['node fixture.js'] }
});
for (const [key, value] of Object.entries(admissionOutcome)) {
  for (const [label, projected] of [
    ['process summary', summarized], ['compact check', compactSummary],
    ['public exec', admittedExec], ['public check', admittedChecks.results[0]],
    ['framed exec', toolResult(admittedExec, false).structuredContent]
  ]) assert.deepEqual(projected[key], value, `${label} must preserve supplied ${key}`);
}
assert.equal(Object.hasOwn(admittedExec, 'privateFixtureField'), false);
assert.equal(Object.hasOwn(admittedChecks.results[0], 'privateFixtureField'), false);
await assertValid(OP.EXEC, admittedExec, 'host admission evidence is already part of the declared exec contract');
await assertValid(OP.VALIDATE_CHECKS, admittedChecks, 'validation retains command admission and output-recovery evidence');
const completedSummary = compactCommandResult(summarizeCommand({
  exitCode: 0, stdout: 'output hidden by compact presentation', stderr: '',
  stdoutOutputRef: admissionOutcome.stdoutOutputRef, stdoutSpillTruncated: false,
  timedOut: false, cancelled: false, forcedTermination: false
}));
assert.equal(completedSummary.stdout, undefined, 'ordinary successful-check presentation stays compact');
assert.equal(completedSummary.stdoutOutputRef, admissionOutcome.stdoutOutputRef, 'successful compact checks retain recovery handles');
assert.equal(completedSummary.stdoutSpillTruncated, false);
assert.equal(completedSummary.cancelled, false);


const nullableOutcome = { executed: false, commandSucceeded: false, exitCode: null, terminationConfirmed: null, durationMs: 0 };
assert.deepEqual(executionOutcome({ ...nullableOutcome, error: null }), nullableOutcome, 'nullable execution facts survive without retaining undeclared nulls');
const nullableSummary = compactCommandResult(summarizeCommand(nullableOutcome));
assert.equal(nullableSummary.exitCode, null);
assert.equal(nullableSummary.terminationConfirmed, null);
const nullableExec = serializeConnectorResult({
  publicName: 'relai_exec', action: '', operationName: OP.EXEC,
  value: { ok: true, ...nullableOutcome },
  args: { workspace: 'repo', executable: 'node', argv: ['fixture.js'] }
});
assert.equal(nullableExec.exitCode, null, 'both public pruning passes preserve a supplied null exit code');
assert.equal(nullableExec.terminationConfirmed, null, 'unknown termination must not disappear during public pruning');
await assertValid(OP.EXEC, nullableExec, 'nullable execution facts satisfy the existing schema');
const nullableChecks = serializeConnectorResult({
  publicName: 'relai_validate', action: 'checks', operationName: OP.VALIDATE_CHECKS,
  value: { ok: false, results: [nullableSummary] }, args: { workspace: 'repo' }
});
assert.equal(nullableChecks.results[0].exitCode, null, 'nested check nulls survive the same projection');
const emptyProcesses = serializeConnectorResult({
  publicName: 'relai_process', action: 'list', operationName: OP.PROCESS_LIST,
  value: { ok: true, processes: [], count: 0 }, args: {}
});
assert.deepEqual(emptyProcesses.processes, [], 'shared pruning retains required empty process arrays');
const emptyDiagnostics = serializeConnectorResult({
  publicName: 'relai_validate', action: 'diagnostics', operationName: OP.VALIDATE_DIAGNOSTICS,
  value: { ok: true, diagnostics: [], results: [] }, args: { workspace: 'repo' }
});
assert.deepEqual(emptyDiagnostics.diagnostics, [], 'shared pruning retains required empty diagnostic arrays');
assert.equal(emptyDiagnostics.results, undefined, 'optional empty arrays retain compact behavior');


const requestedFullCheck = serializeConnectorResult({
  publicName: 'relai_validate', action: 'checks', operationName: OP.VALIDATE_CHECKS,
  value: { ok: true, validationStatus: 'passed', results: [{ ok: true, exitCode: 0, stdout: 'full bounded success tail', stderr: 'bounded warning' }], fullOutput: true },
  args: { workspace: 'repo', fullOutput: true }
});
assert.equal(requestedFullCheck.results[0].stdout, 'full bounded success tail');
assert.equal(requestedFullCheck.results[0].stderr, 'bounded warning');
await assertValid(OP.VALIDATE_CHECKS, requestedFullCheck, 'explicit fullOutput uses existing output fields');

const cap = 512 * 1024;
const largeText = '\u0001'.repeat(700 * 1024);
const explicitSafety = {
  executed: false, commandSucceeded: false, timedOut: true, cancelled: false,
  terminationConfirmed: false, forcedTermination: false, mutationUnknown: true,
  cleanupPending: true, stdoutSpillTruncated: false, stderrSpillTruncated: true,
  stdoutOutputRef: 'spill_abcdefghijklmnopqrstuvwx', stdoutBytes: 700 * 1024
};
const oversizedExec = toolResult(serializeConnectorResult({
  publicName: 'relai_exec', action: '', operationName: OP.EXEC,
  value: { ok: true, exitCode: -1, durationMs: 0, ...explicitSafety, stdout: largeText },
  args: { workspace: 'repo', executable: 'node', argv: ['fixture.js'] }
}), false).structuredContent;
assert.equal(oversizedExec.truncated, true);
for (const [key, value] of Object.entries(explicitSafety)) {
  if (key === 'cleanupPending') continue; // This field is not part of the existing public exec contract.
  assert.equal(oversizedExec[key], value, `final MCP cap must preserve ${key}`);
}
const framedSafety = toolResult({ ok: false, ...explicitSafety, stdout: largeText }, true).structuredContent;
for (const [key, value] of Object.entries(explicitSafety)) assert.equal(framedSafety[key], value, `MCP framing must preserve explicit ${key}`);
assert.equal(oversizedExec.stdoutTruncated, true);
assert.ok(Buffer.byteLength(JSON.stringify(oversizedExec)) <= cap);
const unknownSafety = toolResult({ ok: true, stdout: largeText }, false).structuredContent;
assert.equal(Object.hasOwn(unknownSafety, 'terminationConfirmed'), false, 'missing safety facts must not become false');
assert.equal(Object.hasOwn(unknownSafety, 'executed'), false);


const discoveryStatus = {
  complete: false, resumable: true, truncated: true, resumed: true,
  reason: 'work-budget', source: 'project', scanId: 'fixture-skill-scan',
  consistency: 'sequential-observations',
  observationStartedAt: '2026-10-07T00:00:00.000Z',
  observationEndedAt: '2026-10-07T00:00:01.000Z',
  expiresAt: '2026-10-07T00:01:00.000Z',
  next: 'Repeat relai_snapshot with the same workspace to continue skill discovery.',
  work: { units: 2048, bytes: 65536, totalUnits: 4096, totalBytes: 131072 }
};
for (const [publicName, operationName, value] of [
  ['relai_snapshot', OP.SNAPSHOT, {
    skills: [], skillDiscovery: discoveryStatus, projectInstructions: { content: largeText }
  }],
  ['relai_work', OP.WORK_CONTEXT, {
    work_id: 'work_skill_status_fixture',
    bootstrap: { skillDiscovery: discoveryStatus, projectInstructions: { content: largeText } }
  }]
]) {
  const action = publicName === 'relai_work' ? 'context' : '';
  const publicResult = serializeConnectorResult({
    publicName, action, operationName,
    value: { ok: true, workspace: 'repo', ...value }, args: { workspace: 'repo', ...(action ? { action } : {}) }
  });
  const framed = toolResult(publicResult, false).structuredContent;
  assert.equal(framed.truncated, true, 'fixture must exercise the final MCP compaction path');
  const retained = publicName === 'relai_snapshot' ? framed.skillDiscovery : framed.bootstrap?.skillDiscovery;
  assert.deepEqual(retained, discoveryStatus, 'oversized public results must retain incomplete discovery and continuation facts');
  assert.ok(Buffer.byteLength(JSON.stringify(framed)) <= cap);
  await assertValid(operationName, framed, 'bounded discovery control facts must satisfy the public output schema');
}
const malformedDiscovery = {
  ...discoveryStatus,
  next: '\u0001'.repeat(cap),
  consistency: '\u0001'.repeat(cap),
  observationStartedAt: { privateFixtureField: largeText },
  observationEndedAt: '\u0001'.repeat(cap),
  reason: { privateFixtureField: largeText },
  work: { ...discoveryStatus.work, bytes: -1, totalBytes: Infinity, privateFixtureField: largeText },
  privateFixtureField: { content: largeText }
};
const boundedDiscovery = toolResult({
  ok: true, skillDiscovery: malformedDiscovery,
  bootstrap: { skillDiscovery: malformedDiscovery, privateFixtureField: largeText },
  projectInstructions: { content: largeText }
}, false).structuredContent;
for (const retained of [boundedDiscovery.skillDiscovery, boundedDiscovery.bootstrap.skillDiscovery]) {
  assert.equal(retained.complete, false);
  assert.equal(retained.resumable, true);
  assert.equal(retained.reason, undefined, 'structured values cannot become discovery prose');
  assert.ok(Buffer.byteLength(retained.next) <= 512, 'continuation text has its own byte bound');
  assert.ok(Buffer.byteLength(retained.consistency) <= 128, 'consistency metadata has its own byte bound');
  assert.equal(retained.observationStartedAt, undefined, 'structured values cannot become observation timestamps');
  assert.ok(Buffer.byteLength(retained.observationEndedAt) <= 128, 'observation timestamps have their own byte bound');
  assert.deepEqual(retained.work, { units: 2048, totalUnits: 4096 }, 'only valid known counters survive');
  assert.equal(retained.privateFixtureField, undefined);
}
assert.deepEqual(Object.keys(boundedDiscovery.bootstrap), ['skillDiscovery']);
assert.ok(Buffer.byteLength(JSON.stringify(boundedDiscovery)) <= cap);
assert.equal(unknownSafety.skillDiscovery, undefined, 'compaction must not invent discovery status');

const diagnostic = { ok: false, command: '\u0001'.repeat(1000), ...explicitSafety, stdout: '\u0001'.repeat(6000), stderr: '\u0001'.repeat(6000) };
const operations = Array.from({ length: 80 }, (_, index) => ({
  operationId: `op-${index}`, workspace: 'repo', status: index === 1 ? 'running' : 'completed',
  updatedAt: new Date(1700000000000 + index).toISOString(),
  result: { commandSucceeded: true, results: Array.from({ length: 8 }, () => ({ ...diagnostic, terminationConfirmed: true, mutationUnknown: false, cleanupPending: false })) }
}));
operations[0].result = { ...explicitSafety, results: [diagnostic] };
operations[3].result = { commandSucceeded: true, results: [diagnostic] };
operations[2].result.validationStatus = largeText;
const boundedHistory = toolResult({
  ok: true, workspace: { alias: 'repo', privateUnneededConfig: largeText }, operationId: 'op-2',
  backgroundOperation: operations[2], backgroundOperations: operations,
  results: [diagnostic], completedOperations: [{ operationId: 'done', status: 'completed', summary: largeText }]
}, false).structuredContent;
assert.ok(Buffer.byteLength(JSON.stringify(boundedHistory)) <= cap, 'the serialized byte cap must remain a hard bound for many nested diagnostics and escaped strings');
assert.equal(boundedHistory.workspace, 'repo');
assert.equal(boundedHistory.backgroundOperations[0].operationId, 'op-2', 'targeted operation is first');
assert.ok(boundedHistory.backgroundOperations.some(item => item.operationId === 'op-0'), 'uncertain termination must not be displaced by mundane completed operations');
assert.ok(boundedHistory.omittedOperationCount > 0);
assert.ok(boundedHistory.backgroundOperations.some(item => item.operationId === 'op-3'), 'nested unsafe diagnostics must protect their enclosing operation');
assert.equal(boundedHistory.backgroundOperation.operationId, 'op-2');
assert.equal(boundedHistory.results[0].terminationConfirmed, false);
assert.equal(boundedHistory.results[0].stdoutOutputRef, explicitSafety.stdoutOutputRef);
const retainedUnsafe = boundedHistory.backgroundOperations.find(item => item.operationId === 'op-0');
assert.equal(retainedUnsafe.result.terminationConfirmed, false);
assert.equal(retainedUnsafe.result.mutationUnknown, true);
assert.equal(retainedUnsafe.result.results[0].cancelled, false);

console.log('Exec and validation result serializer regression tests passed.');
