import assert from 'node:assert/strict';
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

console.log('Exec and validation result serializer regression tests passed.');
