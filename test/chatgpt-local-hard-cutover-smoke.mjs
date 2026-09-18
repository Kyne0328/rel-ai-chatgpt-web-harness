import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GOAL_MODE_RESOURCE_URI } from '../src/mcp/goalModeContract.js';
import { getOperationDefinitions } from '../src/tools/actionCatalog.js';
import { OPERATION_ID_VALUES } from '../src/tools/operationIds.js';
import { getToolSurfaceManifest } from '../src/tools/schema.js';
import { startMcpClient, structuredContentOf, MCP_VERSION } from './helpers/mcp-client.mjs';
import { activeMcpToolCount } from './helpers/tool-surface.mjs';

const removedTools = [
  'relai_begin_work', 'relai_repo_snapshot', 'relai_code_inspect',
  'relai_process_start', 'relai_process_read', 'relai_process_write', 'relai_process_stop', 'relai_process_list',
  'relai_semantic_search', 'relai_diagnostics_run', 'relai_run_checks', 'relai_http_probe',
  'relai_diff', 'relai_restore_paths', 'relai_reset_workspace', 'relai_status',
  'relai_git_commit', 'relai_git_push', 'relai_git_draft_pr',
  'relai_tidy_plan', 'relai_tidy_run', 'relai_cancel_work', 'relai_finish_work',
  'relai_worktree_create', 'relai_worktree_list', 'relai_worktree_remove',
  'relai_app_task'
];

const manifest = getToolSurfaceManifest({ workspaces: {} });
assert.equal(Object.hasOwn(manifest, 'compatibilityAliases'), false, 'hard cutover must not expose a compatibility alias map');
assert.equal(Object.hasOwn(manifest, 'migration'), false, 'hard cutover must not expose a migration route');
assert.ok(manifest.tools.flatMap(tool => tool.actions || []).every(action => !Object.hasOwn(action, 'operation')),
  'public discovery must not expose internal operation IDs');
assert.deepEqual(getOperationDefinitions().map(item => item.name).sort(), [...OPERATION_ID_VALUES].sort());
assert.ok(getOperationDefinitions().every(item => !item.name.startsWith('relai_')),
  'internal operation IDs must be distinct from public MCP names');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-hard-cutover-'));
const configPath = path.join(temp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir: path.join(temp, 'state'),
  workspaces: { repo: { path: root } }
}, null, 2));

const client = startMcpClient({ root, configPath, timeoutMs: 15_000 });
try {
  client.initialize(1);
  const discovery = await client.waitFor(1);
  assert.ok(discovery.result?.supportedVersions?.includes(MCP_VERSION));

  client.send(2, 'tools/list');
  const listed = await client.waitFor(2);
  assert.equal(listed.result?.tools?.length, activeMcpToolCount);
  assert.deepEqual(listed.result.tools.filter(tool => tool.name.startsWith('relai_app_')).map(tool => tool.name), []);
  const listedByName = new Map(listed.result.tools.map(tool => [tool.name, tool]));
  for (const tool of listed.result.tools.filter(tool => getToolSurfaceManifest({ workspaces: {} }).tools.some(item => item.name === tool.name))) {
    if (tool.name === 'relai_work') assert.deepEqual(tool._meta?.ui, { resourceUri: GOAL_MODE_RESOURCE_URI });
    else assert.equal(tool._meta?.ui, undefined, `${tool.name} must keep the canonical tool surface iframe-free`);
    assert.equal(tool._meta?.['openai/outputTemplate'], undefined, `${tool.name} must not attach a ChatGPT output template`);
  }
  assert.equal(listedByName.has('relai_approval'), false);
  assert.ok(listed.result.tools.every(tool => tool.outputSchema));
  assert.ok(removedTools.every(name => listed.result.tools.every(tool => tool.name !== name)));

  let requestId = 10;
  for (const removed of removedTools) {
    client.call(requestId, removed, { workspace: 'repo' });
    const response = await client.waitFor(requestId);
    assert.equal(response.error?.code, -32602);
    assert.match(response.error?.message || '', /not found/i);
    requestId += 1;
  }

  client.call(requestId, 'relai_work', { action: 'status', workspace: 'repo' });
  const status = structuredContentOf(await client.waitFor(requestId));
  assert.equal(status.ok, true);
  assert.equal(Object.hasOwn(status.toolSurface || {}, 'compatibilityAliases'), false);
  requestId += 1;

  client.call(requestId, 'relai_work', { action: 'begin', workspace: 'repo' });
  const task = structuredContentOf(await client.waitFor(requestId));
  requestId += 1;

  client.call(requestId, 'relai_validate', {
    action: 'checks', workspace: 'repo', work_id: task.work_id, check: 'node -e "process.exit(1)"', timeoutMs: 1000
  });
  const failedCheck = await client.waitFor(requestId);
  assert.equal(failedCheck.result.isError, true);
  assert.equal(failedCheck.result.structuredContent.ok, false);
  assert.equal(failedCheck.result.structuredContent.results[0].exitCode, 1);

  console.log('Hard cutover exposes only the current canonical public tool surface and canonical internal operation IDs.');
} finally {
  await client.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
