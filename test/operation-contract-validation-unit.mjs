import assert from 'node:assert/strict';
import { normalizePublicToolArguments, resolveToolOperation } from '../src/tools/actionCatalog.js';
import { validateExecutableOperationInput } from '../src/tools/runtimeRegistry.js';
import { serializeToolError } from '../src/tools/errors.js';
import { toolArgumentError } from '../src/tools/validationGuidance.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

const inferred = normalizePublicToolArguments('relai_search', { workspace: 'app', pattern: 'needle', contextBefore: 1, glob: 'src/**' });
assert.equal(inferred.action, 'text');
assert.equal(resolveToolOperation('relai_search', inferred).operationName, OP.SEARCH_TEXT);
assert.equal(normalizePublicToolArguments('relai_search', { workspace: 'app', query: 'configuration' }).action, 'semantic');
assert.throws(() => normalizePublicToolArguments('relai_search', { workspace: 'app', queries: ['a'] }), /Supply action explicitly/);
let unsupported;
try { normalizePublicToolArguments('relai_search', { workspace: 'app', action: 'text', pattern: 'x', pathPrefix: 'src' }); } catch (error) { unsupported = serializeToolError('relai_search', error); }
assert.equal(unsupported.validation.issues[0].field, 'pathPrefix');
assert.equal(unsupported.validation.action, 'text');
assert.equal(unsupported.validation.correctedExample.glob, 'src/**');
await assert.rejects(validateExecutableOperationInput(OP.SEARCH_TEXT, { workspace: 'app', queries: Array.from({ length: 9 }, (_, index) => `q${index}`) }), error => {
  const result = serializeToolError('relai_search', error);
  return result.errorCode === 'INVALID_TOOL_ARGUMENTS' && result.validation.maximumBatchSizes.queries === 8;
});
await assert.rejects(validateExecutableOperationInput(OP.SEARCH_TEXT, { workspace: 'app', pattern: 'x', maxFiles: 201 }), error => {
  const result = serializeToolError('relai_search', error);
  return result.errorCode === 'INVALID_TOOL_ARGUMENTS' && result.validation.issues.some(issue => issue.field === 'maxFiles');
});
const sdkIssue = issue => toolArgumentError({ publicTool: 'fixture', schema: { properties: { known: {} } }, issues: [issue] }).validation.issues[0].field;
for (const waitMs of [-1, 5001, 1.5]) {
  await assert.rejects(validateExecutableOperationInput(OP.WORK_RESULT, { operationId: 'fallback_abcdefghijklmnopqrstuvwx', waitMs }), /argument|valid|schema/i);
}
await validateExecutableOperationInput(OP.WORK_RESULT, { operationId: 'fallback_abcdefghijklmnopqrstuvwx', waitMs: 0 });
await validateExecutableOperationInput(OP.WORK_RESULT, { operationId: 'fallback_abcdefghijklmnopqrstuvwx', waitMs: 5000 });
assert.equal(sdkIssue({ message: 'data/maxFiles must be <= 200' }), 'maxFiles');
assert.equal(sdkIssue({ message: 'data/queries/0 must be string' }), 'queries.0');
assert.equal(sdkIssue({ message: 'data/a~1b/0/c~0d must be string' }), 'a/b.0.c~d');
assert.equal(sdkIssue({ field: 'explicit', path: ['other'], message: 'data/maxFiles must be <= 200' }), 'explicit');
assert.equal(sdkIssue({ path: ['queries', { key: 2 }], message: 'data/maxFiles must be <= 200' }), 'queries.2');
assert.equal(sdkIssue({ message: "data must have required property 'known'" }), 'known');
assert.equal(sdkIssue({ message: "data must have required property 'unrecognized'" }), '<root>');
assert.equal(sdkIssue({ message: 'A quoted payload mentions data/maxFiles, but has no path.' }), '<root>');
const stale = serializeToolError('relai_work', Object.assign(new Error('Unknown task'), { code: 'TASK_NOT_FOUND' }));
assert.equal(stale.recovery.action, 'inspect_history');
assert.match(stale.recovery.nextAction, /never adopt an unrelated task/);
const uncoded = serializeToolError('relai_exec', Object.assign(new Error('Reconciliation fixture failed'), { timeline: { phase: 'reconciling', executed: true }, executed: true, terminationCertainty: 'confirmed' }));
assert.equal(uncoded.executed, true);
assert.equal(uncoded.timeline.phase, 'reconciling');
assert.equal(uncoded.terminationCertainty, 'confirmed');
console.log('Action inference, structured validation and safe scope recovery checks passed.');


// Embedded edit validation retains diagnostics without obscuring the mutation receipt.
const { serializeConnectorResult } = await import('../src/tools/connector.js');
const { validateToolOutput } = await import('../src/tools/outputValidation.js');
for (const outcome of [
  { ok: false, exitCode: 1, executed: true, stderr: 'fixture failed', stderrOutputRef: 'spill_fixture', terminationConfirmed: true },
  { ok: false, exitCode: null, cancelled: true, executed: true, terminationConfirmed: true },
  { ok: false, exitCode: null, executed: false, admissionBlocked: true, errorCode: 'RESOURCE_BLOCKED', retryable: true },
  { ok: false, exitCode: 0, executed: true, terminationConfirmed: false }
]) {
  const checks = { ok: false, workspace: 'fixture', validationStatus: outcome.cancelled ? 'cancelled' : 'failed',
    checks: ['fixture check'], failedCheck: 'fixture check', results: [{ command: 'fixture check', ...outcome }],
    nextAction: 'Inspect the fixture result.', ...outcome };
  const value = { ok: false, workspace: 'fixture', path: 'app.js', changedFiles: ['app.js'], mutationEffect: 'applied',
    checks, validationStatus: checks.validationStatus, error: 'Post-edit validation failed.' };
  const compact = serializeConnectorResult({ publicName: 'relai_edit', operationName: OP.EDIT, value });
  await validateToolOutput({}, 'relai_edit', {}, compact);
  assert.equal(compact.mutationEffect, 'applied');
  assert.deepEqual(compact.changedFiles, ['app.js']);
  assert.equal(compact.checks.failedCheck, 'fixture check');
  assert.equal(compact.checks.validationStatus, checks.validationStatus);
  assert.equal(compact.checks.results[0].terminationConfirmed, outcome.terminationConfirmed);
  if (outcome.stderr) assert.equal(compact.checks.results[0].stderr, outcome.stderr);
  if (outcome.stderrOutputRef) assert.equal(compact.checks.results[0].stderrOutputRef, outcome.stderrOutputRef);
  if (outcome.admissionBlocked) assert.equal(compact.checks.admissionBlocked, true);
}
console.log('Embedded edit validation diagnostics contract passed.');
