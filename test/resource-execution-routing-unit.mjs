import assert from 'node:assert/strict';
import { isClearlyReadOnlyExec, executeToolCall } from '../src/tools/execution.js';
import { runWorkspaceOperation, pendingWorkspaceOperations } from '../src/workspaceOperationQueue.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

const inspect = (script, extra = {}) => isClearlyReadOnlyExec({
  executable: 'pwsh', argv: ['-NoProfile', '-NonInteractive', '-Command', script], ...extra
});
for (const script of ['Get-Location', 'Get-Process', 'Get-Service',
  "Get-Content -LiteralPath 'src/a file.js' -Raw",
  "Microsoft.PowerShell.Management\\Get-Item -LiteralPath 'C:\\Dev\\file.txt'"]) {
  assert.equal(inspect(script), true, script);
}
for (const script of ['Get-Location; Remove-Item x', 'Get-Process | Set-Content x',
  'Get-CustomCommand', 'Get-Content $path', 'gps', 'gc x', '& { Get-Location }',
  'function Get-Location { Remove-Item x }; Get-Location', 'Get-Location $(Remove-Item x)',
  "Get-Content -LiteralPath 'x;Remove-Item y'", "Get-Content -LiteralPath 'x`n'",
  "Get-Content -LiteralPath 'env:HOME'", "Get-Content -LiteralPath 'x' > y",
  "Get-Content -LiteralPath 'x';Write-Host y", "Get-Item -LiteralPath 'C:\\x:stream'",
  "Get-Item -LiteralPath 'x' -Raw", 'Get-Location\nGet-Date']) {
  assert.equal(inspect(script), false, script);
}
assert.equal(inspect('Get-Location', { input: 'Remove-Item x' }), false);
assert.equal(inspect('Get-Location', { env: { TEST: 'x' } }), false);
assert.equal(isClearlyReadOnlyExec({ executable: 'pwsh', argv: ['-Command', 'Get-Location'] }), false);
assert.equal(isClearlyReadOnlyExec({ executable: 'cmd', argv: ['/d', '/c', 'ver'] }), true);
assert.equal(isClearlyReadOnlyExec({ executable: 'cmd', argv: ['/c', 'ver'] }), false);
assert.equal(isClearlyReadOnlyExec({ executable: 'cmd', argv: ['/d', '/c', 'ver & del x'] }), false);

for (const operation of [OP.PROCESS_STOP, OP.PROCESS_READ, OP.PROCESS_LIST]) {
  let release;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const blocker = runWorkspaceOperation('resource-controls', async () => { started(); await held; },
    { mode: 'write', scope: 'task', taskId: 'same-task' });
  await start;
  try {
    const result = await executeToolCall({
      config: {}, name: operation, executionName: operation,
      effectiveArgs: { work_id: 'same-task' }, context: {},
      definition: { behavior: { concurrencyScope: 'task' }, handler: async () => ({ ok: true, reached: operation }) },
      workspaceOverride: { alias: 'resource-controls', path: process.cwd(), directFilesystem: true },
      started: Date.now()
    });
    assert.equal(result.value.reached, operation, 'process controls bypass an occupied same-task lane');
  } finally { release(); await blocker; }
}
let internalContext;
await executeToolCall({
  config: {}, name: OP.EXEC, executionName: OP.EXEC,
  effectiveArgs: { executable: 'node', argv: ['--version'] }, context: {},
  definition: { handler: async (_config, _args, context) => { internalContext = context; return { ok: true }; } },
  started: Date.now()
});
assert.equal(internalContext.resourceClass, 'light');
assert.equal(internalContext.mutationTrackingRequired, false);
assert.equal(pendingWorkspaceOperations(), 0);
console.log('resource execution routing passed');
