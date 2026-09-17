import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpClient, MCP_VERSION } from './helpers/mcp-client.mjs';
import { activeMcpToolNames } from './helpers/tool-surface.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = startMcpClient({
  root,
  configPath: path.join(root, 'examples', 'config.example.json'),
  timeoutMs: 10000
});
const expectedToolNames = activeMcpToolNames;

try {
  client.initialize(1);
  const discovery = await client.waitFor(1);
  if (!discovery.result?.capabilities?.tools) throw new Error('server/discover did not advertise tools capability');
  if (!discovery.result?.capabilities?.resources) throw new Error('server/discover did not advertise resources capability');
  if (!discovery.result?.supportedVersions?.includes(MCP_VERSION)) throw new Error('server/discover did not advertise MCP 2026-07-28');
  if (!discovery.result?.capabilities?.extensions?.['io.modelcontextprotocol/tasks']) {
    throw new Error('stdio must advertise native Tasks support through the task-aware transport');
  }
  const serverInstructions = String(discovery.result?.instructions || '');
  if (!/work_id is durable task attribution/i.test(serverInstructions)
      || !/substantial or multi-step repository work, start relai_work begin before the first project operation and carry work_id/i.test(serverInstructions)
      || !/validation is factual evidence, not execution permission/i.test(serverInstructions)) {
    throw new Error('server/discover did not advertise the task-attribution and factual-validation invariants');
  }
  if (/Inspect relevant files|Validate after changes|recovery guidance/i.test(serverInstructions)) {
    throw new Error('server/discover must not duplicate specialist workflow tactics in global instructions');
  }

  client.send(2, 'tools/list');
  const list = await client.waitFor(2);
  if (!Array.isArray(list.result?.tools) || list.result.tools.length !== expectedToolNames.length) {
    throw new Error(`tools/list should expose ${expectedToolNames.length} runtime tools, got ${list.result?.tools?.length}`);
  }
  const names = list.result.tools.map(item => item.name).sort((a, b) => a.localeCompare(b));
  const expected = [...expectedToolNames].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected tool list: ${names.join(', ')}`);
  for (const tool of list.result.tools) {
    if (tool.inputSchema?.oneOf) throw new Error(`${tool.name} must expose a flat connector input schema`);
  }
  const workTool = list.result.tools.find(item => item.name === 'relai_work');
  for (const field of ['workspace', 'objective', 'bootstrap', 'summary', 'work_id']) {
    if (!workTool.inputSchema?.properties?.[field]) throw new Error(`relai_work schema should expose ${field}`);
  }
  const editTool = list.result.tools.find(item => item.name === 'relai_edit');
  if (!editTool.inputSchema?.properties?.content || !editTool.inputSchema?.properties?.replacements || !editTool.inputSchema?.properties?.edits) {
    throw new Error('relai_edit schema should expose content, replacement arrays, and batch edits');
  }
  if (editTool.inputSchema.oneOf) throw new Error('relai_edit must not expose a non-discriminated oneOf wrapper');
  const readTool = list.result.tools.find(item => item.name === 'relai_read');
  if (!readTool.inputSchema?.properties?.startLine || !readTool.inputSchema?.properties?.endLine || !readTool.inputSchema?.properties?.guidanceMode) {
    throw new Error('relai_read schema should expose bounded line ranges and guidance mode');
  }
  const execTool = list.result.tools.find(item => item.name === 'relai_exec');
  for (const field of ['command', 'executable', 'argv', 'input', 'work_id']) {
    if (!execTool.inputSchema?.properties?.[field]) throw new Error(`relai_exec schema should expose ${field}`);
  }
  for (const longRunning of ['relai_exec', 'relai_validate']) {
    const tool = list.result.tools.find(item => item.name === longRunning);
    if (tool.inputSchema?.properties?.defer) throw new Error(`${longRunning} must not expose legacy defer`);
    if (tool.outputSchema?.properties?.operationTask) throw new Error(`${longRunning} must not expose legacy operationTask`);
  }

  client.send(3, 'resources/list');
  const resources = await client.waitFor(3);
  if (!Array.isArray(resources.result?.resources) || !resources.result.resources.some(item => item.uri === 'relai://server/workspaces')) {
    throw new Error('resources/list did not expose workspace resource');
  }

  console.log(`MCP 2026-07-28 stdio smoke test passed. Tools: ${list.result.tools.length}`);
} finally {
  await client.close();
}
