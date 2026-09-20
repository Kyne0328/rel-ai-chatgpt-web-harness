import assert from 'node:assert/strict';

import {
  buildWorkflowEvidenceReceipt,
  checkEvidenceReusable,
  repeatFailureCount
} from '../src/workflow/evidence.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

const auditEntry = { ts: '2026-08-08T00:00:00.000Z', taskMutationGeneration: 3, taskWorkspaceGeneration: 8 };
const receipt = buildWorkflowEvidenceReceipt({
  tool: OP.EXEC,
  args: { command: 'npm test', cwd: 'front-end', env: { TOKEN: 'secret' } },
  result: { ok: true, exitCode: 0, stdout: 'private output', stderr: '', commandSummary: 'npm test' },
  auditEntry,
  repositoryFingerprint: 'fingerprint-a',
  commandId: 'npm:front-end:test'
});
assert.equal(receipt.kind, 'check');
assert.equal(receipt.commandId, 'npm:front-end:test');
assert.equal(receipt.command, 'npm test');
assert.equal(receipt.cwd, 'front-end');
assert.equal(receipt.outcome, 'passed');
assert.equal(receipt.mutationGeneration, 3);
assert.equal(receipt.workspaceGeneration, 8);
assert.equal(JSON.stringify(receipt).includes('private output'), false);
assert.equal(JSON.stringify(receipt).includes('secret'), false);
assert.equal(checkEvidenceReusable(receipt, { commandId: 'npm:front-end:test', command: 'npm test', cwd: 'front-end', repositoryFingerprint: 'fingerprint-a' }), true);
assert.equal(checkEvidenceReusable(receipt, { commandId: 'npm:front-end:test', command: 'npm test', cwd: 'front-end', repositoryFingerprint: 'fingerprint-b' }), false);
assert.equal(checkEvidenceReusable(receipt, {
  commandId: 'npm:front-end:test', command: 'npm test', cwd: 'front-end', repositoryFingerprint: 'fingerprint-a',
  mutationGeneration: 3, workspaceGeneration: 8
}), true);
assert.equal(checkEvidenceReusable(receipt, {
  commandId: 'npm:front-end:test', command: 'npm test', cwd: 'front-end', repositoryFingerprint: 'fingerprint-a',
  mutationGeneration: 4, workspaceGeneration: 8
}), false, 'task mutation generation changes must invalidate a prior pass');
assert.equal(checkEvidenceReusable(receipt, {
  commandId: 'npm:front-end:test', command: 'npm test', cwd: 'front-end', repositoryFingerprint: 'fingerprint-a',
  mutationGeneration: 3, workspaceGeneration: 9
}), false, 'workspace mutation generation changes must invalidate a prior pass');

const failures = [
  buildWorkflowEvidenceReceipt({ tool: OP.EXEC, args: { command: 'npm test', cwd: 'front-end' }, result: { ok: false, exitCode: 1, errorCode: 'EXIT_1' }, auditEntry, repositoryFingerprint: 'x', commandId: 'npm:front-end:test' }),
  buildWorkflowEvidenceReceipt({ tool: OP.EXEC, args: { command: 'npm test', cwd: 'front-end' }, result: { ok: false, exitCode: 1, errorCode: 'EXIT_1' }, auditEntry: { ...auditEntry, taskMutationGeneration: 4 }, repositoryFingerprint: 'y', commandId: 'npm:front-end:test' })
];
assert.equal(repeatFailureCount(failures), 2, 'the same failure family must survive mutation-generation boundaries');

const reviewReceipt = buildWorkflowEvidenceReceipt({
  tool: OP.CHANGES_DIFF,
  args: { action: 'diff' },
  result: { ok: true, reviewHash: 'abc123', reviewScope: 'task' },
  auditEntry,
  repositoryFingerprint: 'fingerprint-a'
});
assert.equal(reviewReceipt.kind, 'review');
assert.equal(reviewReceipt.metadata.reviewHash, 'abc123');
assert.equal(reviewReceipt.metadata.reviewScope, 'task');

const uiReceipt = buildWorkflowEvidenceReceipt({
  tool: OP.UI,
  args: { action: 'console' },
  result: { ok: true, action: 'console', sessionId: 'ui-1', route: '/settings', consoleErrorCount: 2, networkFailureCount: 1, evidenceId: 'shot-1' },
  auditEntry,
  repositoryFingerprint: 'fingerprint-a'
});
assert.equal(uiReceipt.kind, 'ui');
assert.equal(uiReceipt.metadata.uiAction, 'console');
assert.equal(uiReceipt.metadata.sessionId, 'ui-1');
assert.equal(uiReceipt.metadata.route, '/settings');
assert.equal(uiReceipt.metadata.consoleErrorCount, 2);
assert.equal(uiReceipt.metadata.networkFailureCount, 1);
assert.equal(uiReceipt.metadata.evidenceId, 'shot-1');

console.log('Safe workflow evidence receipt and reuse tests passed.');