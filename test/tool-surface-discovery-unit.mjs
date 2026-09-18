import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMcpClient, structuredContentOf } from './helpers/mcp-client.mjs';
import { activeMcpToolNames, activeToolCount, activeToolNames } from './helpers/tool-surface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const variants = [
  { name: 'canonical', extra: {} },
  { name: 'stale-profile-field', extra: { toolProfile: 'core' } }
];

for (const variant of variants) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `relai-${variant.name}-discovery-`));
  const configPath = path.join(temp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 3,
    ...variant.extra,
    stateDir: path.join(temp, 'state'),
    workspaces: { repo: { path: root } }
  }, null, 2));

  const client = startMcpClient({ root, configPath });
  try {
    client.initialize(1);
    const discovery = await client.waitFor(1);
    assert.equal(discovery.result?.capabilities?.experimental?.relai?.toolCount, activeToolCount);
    client.send(2, 'tools/list', {});
    const response = await client.waitFor(2);
    const tools = response.result?.tools || [];
    const names = tools.map(tool => tool.name);
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    assert.deepEqual(names, activeMcpToolNames);
    assert.deepEqual(tools.filter(tool => activeToolNames.includes(tool.name)).map(tool => tool.name), activeToolNames);
    assert.equal(byName.has('relai_approval'), false);
    assert.deepEqual(tools.filter(tool => tool.name.startsWith('relai_app_')).map(tool => tool.name), []);
    const readSchema = byName.get('relai_read')?.inputSchema;
    assert.ok(readSchema?.properties?.paths, 'raw MCP discovery must expose relai_read paths');
    assert.ok(readSchema?.properties?.ranges, 'raw MCP discovery must expose relai_read ranges');
    const searchSchema = byName.get('relai_search')?.inputSchema;
    assert.ok(searchSchema?.properties?.queries, 'raw MCP discovery must expose batched relai_search queries');
    for (const [toolName, schema] of [['relai_read', readSchema], ['relai_search', searchSchema]]) {
      for (const keyword of ['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'not', 'propertyNames']) {
        assert.equal(schema?.[keyword], undefined, `${toolName} raw discovery must stay import-safe at the root (${keyword})`);
      }
    }

    client.call(3, 'relai_work', { action: 'begin', workspace: 'repo', bootstrap: 'none' });
    const work = structuredContentOf(await client.waitFor(3));
    assert.ok(work.work_id, 'raw MCP dispatch must create a repository work session');

    client.call(4, 'relai_read', { work_id: work.work_id, paths: ['release-manifest.json'] });
    const read = structuredContentOf(await client.waitFor(4));
    assert.equal(read.items?.[0]?.path, 'release-manifest.json', 'advertised relai_read paths must dispatch successfully');

    client.call(5, 'relai_search', {
      action: 'text', work_id: work.work_id,
      queries: ['TOOL_SURFACE_VERSION', 'manifestHash'], glob: 'src/**/*.js', maxFiles: 20
    });
    const search = structuredContentOf(await client.waitFor(5));
    assert.equal(search.ok, true, 'advertised batched relai_search queries must dispatch successfully');

    client.call(6, 'relai_search', { action: 'text', work_id: work.work_id, pattern: 'surface', query: 'sibling-field' });
    const malformed = await client.waitFor(6);
    assert.equal(malformed.result?.isError, true, 'runtime validation must surface malformed cross-action input as a tool error');
    assert.equal(malformed.result?.structuredContent?.ok, false);
    assert.match(malformed.result?.structuredContent?.error || '', /Invalid arguments for tool relai_search/);
    assert.match(malformed.result?.structuredContent?.error || '', /additional properties|oneOf/i);

    client.call(7, 'relai_search', { action: 'text', work_id: work.work_id, pattern: 'surface', maxFiles: 201 });
    const boundedFailure = await client.waitFor(7);
    assert.equal(boundedFailure.result?.isError, true, 'action-specific canonical validation must surface as a tool error');
    assert.match(boundedFailure.result?.structuredContent?.error || '', /relai_search action 'text'/, 'public errors must identify the callable public tool/action');
    assert.doesNotMatch(boundedFailure.result?.structuredContent?.error || '', /search\.text/, 'public errors must not leak internal operation IDs');
  } finally {
    await client.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

console.log(`The unified ${activeToolCount}-tool MCP surface is always discovered; stale profile fields have no effect.`);
