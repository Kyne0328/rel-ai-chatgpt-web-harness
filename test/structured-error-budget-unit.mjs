import assert from 'node:assert/strict';
process.env.REL_AI_MCP_MAX_TOOL_RESULT_BYTES = '1200';
const { toolResult } = await import('../src/mcp/results.js');
const timeline = { phase: 'reconciling', executed: true, phases: Array.from({ length: 13 }, (_, index) => ({ phase: `phase-${index}`, startedAt: '2026-10-05T00:00:00.000Z', endedAt: '2026-10-05T00:00:01.000Z', durationMs: 1000 })) };
const response = toolResult({ ok: false, error: 'Ordinary EIO failure while reconciling', errorCode: 'EIO', executed: true, terminationConfirmed: false, mutationUnknown: true, timeline, errorDetails: { code: 'EIO', source: 'rel-ai-mcp', operation: 'write', executed: true, terminationCertainty: 'unknown', timeline, retryable: false, allowedAlternatives: ['Inspect the same operationId before attempting further mutations.'] } }, true).structuredContent;
assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') <= 1200);
assert.equal(response.errorCode, 'EIO');
assert.equal(response.executed, true);
assert.equal(response.terminationConfirmed, false);
assert.equal(response.mutationUnknown, true);
assert.equal(response.errorDetails.executed, true);
assert.equal(response.errorDetails.terminationCertainty, 'unknown');
assert.equal(response.errorDetails.timeline, undefined, 'duplicate timeline must not bypass the global cap');
console.log('Nested structured error timeline respects the 1200-byte cap.');

const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { randomUUID } = await import('node:crypto');
const { outputSpillOwner, retainOutputStreams, readOutputSpill } = await import('../src/outputSpill.js');
const { startFallbackExecution, fallbackExecutionStatus, resetFallbackExecutions } = await import('../src/mcp/fallbackExecutions.js');
const { principalFingerprint } = await import('../src/mcp/principal.ts');
const config = { stateDir: mkdtempSync(join(tmpdir(), 'relai-compose-budget-')) };
try {
  const workspace = 'budget-fixture', principal = 'local:budget-fixture', noticeScope = principalFingerprint(principal);
  const owner = outputSpillOwner({ workspace, principal });
  const compositionId = 'compose_' + randomUUID();
  const outputs = [{ type: 'text', text: 'fixture output'.repeat(3000) }];
  const document = { version: 1, compositionId, ok: true, outputs, calls: [] };
  const spill = { stdout: JSON.stringify(document) };
  await retainOutputStreams(config, owner, spill);
  const payload = { ...document, workspace, compositionOutputRef: spill.stdoutOutputRef, unsettledCalls: 0 };
  const wire = toolResult(payload, false);
  const verify = result => {
    assert.equal(result.compositionId, compositionId);
    assert.equal(result.compositionOutputRef, spill.stdoutOutputRef);
    assert.equal(result.unsettledCalls, 0);
    assert.equal(result.outputs, undefined);
  };
  assert.equal(wire.structuredContent.truncated, true);
  verify(wire.structuredContent);
  assert.ok(Buffer.byteLength(JSON.stringify(wire.structuredContent)) <= 1200);
  const admitted = startFallbackExecution({ config, scopeId: 'compose-budget', noticeScope, workspace,
    tool: 'relai_compose', signature: 'once', run: async () => wire });
  await admitted.record.promise;
  resetFallbackExecutions();
  const recovered = fallbackExecutionStatus(admitted.record.operationId, { config, noticeScope, workspace });
  verify(recovered.result);
  const recoveredFile = readOutputSpill(config, owner, recovered.result.compositionOutputRef).file;
  assert.deepEqual(JSON.parse(readFileSync(recoveredFile, 'utf8')), document);
  const nested = toolResult({ ok: true, backgroundOperation: { ...recovered, result: payload } }, false);
  verify(nested.structuredContent.backgroundOperation.result);
  assert.ok(Buffer.byteLength(JSON.stringify(nested.structuredContent)) <= 1200);
} finally {
  resetFallbackExecutions();
  rmSync(config.stateDir, { recursive: true, force: true });
}
