import assert from 'node:assert/strict';
import { ToolSchema } from '@modelcontextprotocol/core';
import { fromJsonSchema } from '@modelcontextprotocol/server';

import { connectorInstructions } from '../src/mcpServer.js';
import { getToolDefinitions } from '../src/tools.js';
import { getOperationDefinitions, resolveToolOperation } from '../src/tools/actionCatalog.js';
import { OPERATION_IDS as OP, OPERATION_ID_VALUES } from '../src/tools/operationIds.js';
import { validateExecutableOperationInput } from '../src/tools/runtimeRegistry.js';
import {
  TOOL_NAMES, getMcpToolSchemas, getPublicToolSchemas,
  getToolDefinitions as getDefinitionMetadata, getToolGroups, getToolMetadata,
  getToolSchemas, getToolSurfaceManifest
} from '../src/tools/schema.js';

const config = { workspaces: {} };
const requiredTools = [
  'relai_work', 'relai_snapshot', 'relai_read', 'relai_search', 'relai_inspect', 'relai_edit',
  'relai_exec', 'relai_process', 'relai_ui', 'relai_browser', 'relai_desktop', 'relai_computer', 'relai_validate', 'relai_changes', 'relai_publish'
];
const removedDirectNames = [
  'relai_begin_work', 'relai_repo_snapshot', 'relai_code_inspect', 'relai_process_start',
  'relai_process_read', 'relai_process_write', 'relai_process_stop', 'relai_process_list',
  'relai_worktree_create', 'relai_worktree_list', 'relai_worktree_remove', 'relai_semantic_search', 'relai_run_checks', 'relai_http_probe',
  'relai_diff', 'relai_status', 'relai_finish_work'
];

assert.ok(TOOL_NAMES.length > 0, 'the public tool registry must not be empty');
assert.equal(new Set(TOOL_NAMES).size, TOOL_NAMES.length, 'public tool names must remain unique');
for (const required of requiredTools) assert.ok(TOOL_NAMES.includes(required), `${required} must remain available`);
assert.deepEqual(getDefinitionMetadata(config).map(item => item.name), [...TOOL_NAMES]);
assert.equal(getToolDefinitions(config).length, TOOL_NAMES.length);

const schemas = getToolSchemas(config);
const publicSchemas = getPublicToolSchemas(config);
const mcpSchemas = getMcpToolSchemas(config);
const schemaByName = new Map(schemas.map(schema => [schema.name, schema]));
assert.equal(publicSchemas.length, requiredTools.length, 'local developer mode keeps the canonical model-facing tool surface');
assert.equal(mcpSchemas.length, requiredTools.length, 'MCP discovery must match the canonical model-facing tool surface');
assert.equal(mcpSchemas.some(item => item.name === 'relai_approval'), false, 'removed approval render tool must stay absent');
assert.deepEqual(
  mcpSchemas.filter(item => item.name.startsWith('relai_app_')).map(item => item.name),
  [],
  'removed approval app helpers must stay absent'
);
const schemaBytes = bytes(publicSchemas);
assert.ok(schemaBytes > 0, 'unified discovery schema must serialize to a non-empty payload');
assert.deepEqual(
  getPublicToolSchemas({ toolProfile: 'core', workspaces: {} }),
  publicSchemas,
  'stale profile configuration must not change discovery'
);
assert.ok(Buffer.byteLength(JSON.stringify(connectorInstructions(config)), 'utf8') > 0, 'connector instructions must serialize to a non-empty payload');
assert.match(connectorInstructions(config), /work_id is durable task attribution/i, 'global instructions must define durable task identity without framing substantial work as optional');
assert.match(connectorInstructions(config), /omit it for workspace\/resource work and never infer one/i, 'global instructions must prohibit ambiguous implicit task attribution');
assert.match(connectorInstructions(config), /approval/i, 'global instructions retain approval safety where defined');
assert.match(connectorInstructions(config), /authoritative evidence/i, 'global instructions retain truthful evidence semantics');
assert.match(connectorInstructions(config), /validation is factual evidence, not execution permission/i, 'global instructions must describe validation as evidence rather than permission');
assert.match(connectorInstructions(config), /work_id omission never selects another task/i, 'global instructions must preserve explicit task-attribution isolation');
assert.doesNotMatch(connectorInstructions(config), /workspace-resolution error|filesystem path that Rel\.AI already knows|brief normal assistant progress|Native tool invocation labels|private chain-of-thought|poll relai_work status/i,
  'conditional recovery and host presentation guidance must stay out of always-on MCP instructions');
assert.doesNotMatch(connectorInstructions(config), /Inspect relevant files|Validate after changes|recovery guidance/i, 'discretionary workflow tactics belong to the workflow runtime/skills, not global MCP instructions');

const manifest = getToolSurfaceManifest(config);
const planOperation = getOperationDefinitions().find(item => item.name === OP.WORK_PLAN);
assert.equal(planOperation?.outputSchema?.properties?.progress, undefined, 'work.plan must not advertise progress that its handler does not return');
assert.ok(Number.isSafeInteger(manifest.schemaVersion) && manifest.schemaVersion > 0, 'manifest schema revision must remain a positive integer');
assert.ok(Number.isSafeInteger(manifest.toolSurfaceVersion) && manifest.toolSurfaceVersion > 0, 'tool-surface revision must remain a positive integer');
assert.equal(Object.hasOwn(manifest, 'profile'), false);
assert.equal(manifest.toolCount, TOOL_NAMES.length);
assert.deepEqual(manifest.tools.map(item => item.name), [...TOOL_NAMES]);
assert.deepEqual(manifest.deprecations, []);
assert.equal(Object.hasOwn(manifest, 'compatibilityAliases'), false, 'hard cutover must not advertise compatibility aliases');
assert.equal(Object.hasOwn(manifest, 'migration'), false);
assert.ok(manifest.tools.flatMap(item => item.actions || []).every(action => !Object.hasOwn(action, 'operation')), 'public manifest actions must not leak internal operation IDs');
assert.deepEqual(getOperationDefinitions().map(item => item.name).sort(), [...OPERATION_ID_VALUES].sort(), 'internal operation registry must use only canonical hard-cut IDs');
assert.ok(getOperationDefinitions().every(item => !item.name.startsWith('relai_')), 'internal operation IDs must not masquerade as public MCP tool names');

for (const schema of schemas) {
  assert.equal(ToolSchema.safeParse(schema).success, true, `${schema.name} must satisfy ToolSchema`);
  const publicSchema = publicSchemas.find(item => item.name === schema.name);
  assert.ok(publicSchema?.outputSchema, `${schema.name} must advertise outputSchema`);
  assert.equal(publicSchema.outputSchema.type, 'object');
  assert.equal(publicSchema.outputSchema.additionalProperties, true, 'public discovery must keep detailed operation output fields on demand instead of embedding every action result shape');
  assert.deepEqual(publicSchema.outputSchema.required, ['ok']);
}
const importUnsafeRootKeywords = ['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'not', 'propertyNames'];
const capabilityRoutingDescriptions = new Set(['relai_work', 'relai_read', 'relai_edit', 'relai_ui', 'relai_browser', 'relai_desktop', 'relai_computer']);
for (const schema of publicSchemas) {
  for (const keyword of importUnsafeRootKeywords) {
    assert.equal(schema.inputSchema[keyword], undefined, `${schema.name} discovery must not use root ${keyword}`);
  }
  assert.equal(schema.inputSchema.additionalProperties, false, `${schema.name} discovery must reject unknown fields`);
  assert.deepEqual(schema.annotations, schemaByName.get(schema.name)?.annotations, `${schema.name} must preserve truthful canonical annotations`);
  assert.deepEqual(schema._meta?.securitySchemes, [{ type: 'noauth' }], `${schema.name} must advertise local noauth through ChatGPT compatibility metadata`);
  assert.equal(schema._meta?.ui, undefined, `${schema.name} must stay iframe-free`);
  assert.equal(schema._meta?.['openai/outputTemplate'], undefined, `${schema.name} must not attach a ChatGPT output template`);
  assert.ok(String(schema.description || '').trim().length > 0, `${schema.name} must have a concise connector description`);
  if (!capabilityRoutingDescriptions.has(schema.name)) {
    assert.doesNotMatch(schema.description || '', /\b(?:use when|use for|use to|do not|prefer|should|must)\b/i, `${schema.name} connector description must stay declarative unless it owns host/local capability routing`);
  }
}
const publicWork = publicSchemas.find(item => item.name === 'relai_work');
assert.match(publicWork?.description || '', /Use begin for substantial or multi-step repository work, including read-first investigations/i, 'relai_work discovery must tell the agent when durable task creation is expected');
assert.doesNotMatch(publicWork?.description || '', /one optional durable workspace task/i, 'relai_work discovery must not frame substantial task creation as merely optional');
const publicWorkSchema = publicWork?.inputSchema;
for (const field of ['workspace', 'title', 'objective', 'bootstrap', 'instructionPath', 'summary', 'reason', 'work_id']) {
  assert.ok(publicWorkSchema?.properties?.[field], `relai_work connector schema must expose ${field}`);
}
assert.equal(publicWorkSchema?.allOf, undefined, 'relai_work discovery stays import-safe; action-specific validation belongs to the canonical runtime contract');
const publicSearchInputSchema = publicSchemas.find(item => item.name === 'relai_search')?.inputSchema;
for (const field of ['queries', 'maxResults', 'maxFiles']) {
  assert.equal(publicSearchInputSchema?.properties?.[field]?.anyOf, undefined, `relai_search root ${field} schema must collapse bounded action variants instead of advertising a redundant union`);
}
assert.equal(publicSearchInputSchema?.properties?.pattern?.description, undefined, 'flat discovery must not repeat action ownership on individual fields');
assert.equal(publicSearchInputSchema?.properties?.query?.description, undefined, 'flat discovery must not repeat action ownership on individual fields');
assert.match(publicSearchInputSchema?.properties?.action?.description || '', /Fields: text\([^)]*pattern[^)]*\).*semantic\([^)]*query[^)]*\)/, 'flat discovery must summarize action-specific fields once on the action selector');
assert.match(publicSearchInputSchema?.properties?.action?.description || '', /text: pattern or queries.*semantic: queries or query|text: pattern or queries.*semantic: query or queries/, 'flat discovery must preserve canonical alternative input forms');
assert.doesNotMatch(publicSearchInputSchema?.properties?.action?.description || '', /\[\d+-\d+\]/, 'validation-only numeric bounds must stay out of compact discovery; canonical runtime validation below remains authoritative');
assert.match(publicWorkSchema?.properties?.action?.description || '', /status\([^)]*maxBytes[^)]*\)/, 'flat discovery must identify action-specific optional fields once on the action selector');
const publicValidateInputSchema = publicSchemas.find(item => item.name === 'relai_validate')?.inputSchema;
assert.equal(publicValidateInputSchema?.properties?.timeoutMs?.anyOf, undefined, 'relai_validate root timeoutMs schema must collapse bounded action variants instead of advertising a redundant union');
const publicReadSchema = publicSchemas.find(item => item.name === 'relai_read');
assert.equal(publicReadSchema?.inputSchema?.properties?.asResource?.type, 'boolean', 'relai_read discovery must expose private artifact transfer mode');
assert.match(publicReadSchema?.inputSchema?.properties?.asResource?.description || '', /resource_link.*transfer or download/i, 'relai_read discovery must explain artifact transfer mode');
assert.match(publicReadSchema?.description || '', /asResource:true.*resource_link.*transfer or download/i, 'relai_read tool description must identify whole-file artifact transfer declaratively');
const publicSearchSchema = publicSchemas.find(item => item.name === 'relai_search')?.outputSchema;
assert.equal(publicSearchSchema?.properties?.neuralEmbeddings, undefined, 'action-specific result fields must stay out of lightweight MCP discovery');
assert.equal(publicSearchSchema?.properties?.originalBytes, undefined, 'compaction metadata must stay out of lightweight MCP discovery');
const searchSurface = manifest.tools.find(item => item.name === 'relai_search');
assert.ok(searchSurface?.outputFields?.includes('neuralEmbeddings'), 'semantic-search output metadata must remain available on demand');
assert.ok(searchSurface?.outputFields?.includes('originalBytes'), 'compaction output metadata must remain available on demand');
const publicExecSchema = publicSchemas.find(item => item.name === 'relai_exec');
for (const field of ['command', 'executable', 'argv', 'input', 'cwd', 'env', 'timeoutMs', 'maxOutputBytes', 'work_id']) {
  assert.ok(publicExecSchema?.inputSchema?.properties?.[field], `relai_exec connector schema must expose ${field}`);
}
const publicEditSchema = publicSchemas.find(item => item.name === 'relai_edit');
assert.equal(publicEditSchema?.inputSchema?.properties?.content?.description, undefined, 'public edit discovery must not repeat obvious complete-file field prose');
assert.equal(publicEditSchema?.inputSchema?.properties?.content?.type, 'string', 'plain content must remain a text-only edit form');
assert.deepEqual(publicEditSchema?._meta?.['openai/fileParams'], ['file'], 'ChatGPT discovery must advertise the dedicated native file parameter');
assert.deepEqual(publicEditSchema?.inputSchema?.properties?.file?.required, ['download_url', 'file_id'], 'native file references require only the OpenAI download URL and opaque file ID');
for (const field of ['download_url', 'file_id', 'mime_type', 'file_name']) {
  assert.ok(publicEditSchema?.inputSchema?.properties?.file?.properties?.[field], `native file schema must declare ${field}`);
}
assert.equal(publicEditSchema?.inputSchema?.properties?.stage, undefined, 'internal staged-edit transport fallback must stay out of public discovery');
assert.equal(publicEditSchema?.inputSchema?.properties?.writeId, undefined, 'internal staged-edit identifiers must stay out of public discovery');
const publicProcessSchema = publicSchemas.find(item => item.name === 'relai_process');
assert.match(publicProcessSchema?.inputSchema?.properties?.command?.description || '', /shell syntax/i, 'public process discovery must retain shell guidance');
assert.doesNotMatch(publicProcessSchema?.inputSchema?.properties?.command?.description || '', /Action usage:/i, 'public process fields must not repeat action-routing prose');
assert.match(publicProcessSchema?.inputSchema?.properties?.action?.description || '', /start\([^)]*command[^)]*\).*read\([^)]*processId![^)]*\).*write\([^)]*processId![^)]*\).*stop\([^)]*processId![^)]*\)/, 'public process discovery must summarize action ownership and required fields once');
assert.match(publicExecSchema?.description || '', /direct executable \+ argv.*command string/i, 'ChatGPT discovery must describe both execution forms declaratively');
assert.match(publicExecSchema?.inputSchema?.description || '', /direct executable \+ argv, and shell command/i);
assert.match(publicExecSchema?.inputSchema?.description || '', /Input form: command or executable\./i, 'flat discovery must preserve canonical executable-mode alternatives');
assert.match(publicExecSchema?.inputSchema?.properties?.command?.description || '', /Multiline scripts or structured text can be supplied through input/i);
assert.match(publicExecSchema?.inputSchema?.properties?.executable?.description || '', /shell:false/i);
assert.equal(publicExecSchema?.inputSchema?.properties?.argv?.description, undefined, 'public discovery must not repeat argv semantics already expressed by the execution-form description');
assert.match(publicExecSchema?.inputSchema?.properties?.input?.description || '', /multiline scripts or structured text/i);
assert.equal(publicExecSchema?.inputSchema?.allOf, undefined, 'relai_exec discovery stays import-safe; execution-mode exclusivity is enforced at runtime');
for (const removed of removedDirectNames) {
  assert.equal(resolveToolOperation(removed, {}), null, `${removed} must not resolve as a public tool`);
  assert.equal(publicSchemas.some(tool => tool.name === removed), false, `${removed} must not be discovered`);
}

const publicSchemaByName = new Map(publicSchemas.map(schema => [schema.name, schema]));
assert.deepEqual(schemaByName.get('relai_work').inputSchema.properties.action.enum, ['begin', 'context', 'plan', 'status', 'finish', 'cancel']);
const processSchema = schemaByName.get('relai_process');
assert.deepEqual(processSchema.inputSchema.properties.action.enum, ['start', 'read', 'write', 'stop', 'list']);
assert.ok(processSchema.inputSchema.properties.kind.enum.includes('service'));
assert.match(processSchema.description, /direct executable \+ argv.*command string/i);
assert.match(processSchema.inputSchema.properties.executable.description, /shell:false/i);
assert.match(processSchema.inputSchema.properties.argv.description, /without shell parsing/i);
assert.match(processSchema.inputSchema.properties.input.description, /without closing the persistent stdin stream/i);
const editSchema = schemaByName.get('relai_edit');
assert.equal(editSchema.inputSchema.oneOf?.length, 10, 'relai_edit executable schema must retain all canonical edit-form variants');
assert.match(editSchema.description, /semantic rename.*structural symbol edits.*exact replacement.*full-file content/i);
assert.deepEqual(editSchema.inputSchema.properties.symbolEdit.properties.action.enum, ['replace', 'insert_before', 'insert_after']);
assert.doesNotMatch(editSchema.description, /transport-size fallback/i, 'normal edit guidance must not advertise the internal staged transport fallback');
assert.match(editSchema.inputSchema.properties.content.description, /staged internally when needed/i);
assert.match(editSchema.inputSchema.properties.updateText.description, /One logical patch can contain repository-wide changes/i);
assert.deepEqual(editSchema.inputSchema.properties.stage.enum, ['start', 'append', 'commit', 'abort'], 'canonical executable schema must retain the internal staged transport lifecycle');

await valid('relai_work', { action: 'begin', workspace: 'repo' });
await valid('relai_work', { action: 'begin' });
await valid('relai_work', { action: 'plan', workspace: 'repo', work_id: 'work', steps: [{ id: 'inspect', title: 'Inspect implementation', status: 'in_progress' }] });
await valid('relai_work', { action: 'plan', workspace: 'repo', work_id: 'work', steps: [] });
await invalid('relai_work', { action: 'plan', workspace: 'repo', work_id: 'work', steps: [{ title: 'Invalid state', status: 'working' }] });
await valid('relai_work', { action: 'finish', work_id: 'work', summary: 'Done.' });
await invalid('relai_work', { action: 'finish', work_id: 'work' });
await valid('relai_process', { action: 'start', workspace: 'repo', command: 'npm run dev', kind: 'service', purpose: 'Run the development server.', reuseExisting: true });
await valid('relai_process', { action: 'start', work_id: 'work', executable: 'node', argv: ['server.js', '--port', '3000'], input: 'ready\n', kind: 'service', purpose: 'Run the development server directly.' });
await invalid('relai_process', { action: 'start', work_id: 'work', command: 'npm run dev', executable: 'node', kind: 'service', purpose: 'Ambiguous execution mode.' });
await invalid('relai_process', { action: 'start', work_id: 'work', argv: ['server.js'], kind: 'service', purpose: 'Missing executable.' });
await invalid('relai_process', { action: 'start', work_id: 'work', command: 'npm test' });
await valid('relai_process', { action: 'read', work_id: 'work', processId: 'p', includeMetadata: false });
await invalid('relai_process', { action: 'read', work_id: 'work', processId: 'p', command: 'ignored' });
await invalid('relai_work', { action: 'status', title: 'ignored' });
await valid('relai_read', { work_id: 'work', paths: ['dist/report.zip'], asResource: true });
await valid('relai_search', { action: 'text', work_id: 'work', pattern: 'needle', maxFiles: 200, maxResults: 1000 });
await valid('relai_search', { action: 'text', work_id: 'work', queries: ['needle', 'haystack'], maxFiles: 200 });
await invalid('relai_search', { action: 'text', work_id: 'work', pattern: 'needle', queries: ['haystack'] });
await invalid('relai_search', { action: 'text', work_id: 'work', queries: ['a', 'b', 'c', 'd', 'e'] });
await invalid('relai_search', { action: 'text', work_id: 'work', pattern: 'needle', maxFiles: 201 });
await invalid('relai_search', { action: 'text', work_id: 'work', pattern: 'needle', maxResults: 1001 });
await valid('relai_search', { action: 'semantic', work_id: 'work', query: 'needle', maxResults: 100, maxFiles: 20000 });
await valid('relai_search', { action: 'semantic', work_id: 'work', queries: ['needle', 'haystack'], maxResults: 100 });
await invalid('relai_search', { action: 'semantic', work_id: 'work', query: 'needle', queries: ['haystack'] });
await invalid('relai_search', { action: 'semantic', work_id: 'work', maxResults: 101, queries: ['needle'] });
await invalid('relai_search', { action: 'semantic', work_id: 'work', query: 'needle', maxFiles: 20001 });
await valid('relai_validate', { action: 'http', work_id: 'work', route: '/health', timeoutMs: 600000 });
await invalid('relai_validate', { action: 'http', work_id: 'work', route: '/health', level: 'release' });
await invalid('relai_validate', { action: 'http', work_id: 'work', route: '/health', timeoutMs: 600001 });
await valid('relai_validate', { action: 'checks', work_id: 'work', level: 'standard', check: 'node -v' });
await valid('relai_validate', { action: 'checks', workspace: 'repo', level: 'standard', checks: ['node -v', 'npm -v'] });
await valid('relai_validate', { action: 'diagnostics', workspace: 'repo', level: 'quick', command: 'npm run lint' });
await valid('relai_exec', { workspace: 'repo', command: 'node -v' });
await valid('relai_exec', { work_id: 'work', executable: 'node', argv: ['-v'] });
await valid('relai_exec', { work_id: 'work', executable: 'node', argv: ['-'], input: 'process.stdout.write("ok")' });
await valid('relai_computer', { action: 'status' });
await valid('relai_computer', { action: 'observe', app: 'Notepad', maxElements: 120 });
await valid('relai_computer', { action: 'observe', app: 'Notepad', perception: 'hybrid' });
await valid('relai_computer', { action: 'activate', app: 'Notepad', semanticObservationId: 'uia_fixture', targetId: 'e1' });
await valid('relai_computer', { action: 'set_value', app: 'Notepad', semanticObservationId: 'uia_fixture', targetId: 'e1', value: '' });
await valid('relai_computer', { action: 'screenshot', app: 'Notepad', displayId: 'display-1' });
await valid('relai_computer', { action: 'wait_for_stable', app: 'Notepad', timeoutMs: 1000, pollMs: 50, stableMs: 200 });
await valid('relai_computer', { action: 'click', workspace: 'repo', app: 'Notepad', x: 10, y: 20 });
await valid('relai_computer', { action: 'drag', workspace: 'repo', app: 'Notepad', x: 10, y: 20, toX: 30, toY: 40 });
await valid('relai_computer', { action: 'scroll', workspace: 'repo', app: 'Notepad', direction: 'down', distance: 500 });
await valid('relai_computer', { action: 'type', workspace: 'repo', app: 'Notepad', text: 'hello' });
await valid('relai_computer', { action: 'key', workspace: 'repo', app: 'Notepad', key: 'enter' });
await valid('relai_computer', { action: 'hotkey', workspace: 'repo', app: 'Notepad', keys: ['ctrl', 's'] });
await invalid('relai_computer', { action: 'screenshot', displayId: 'display-1' });
await invalid('relai_computer', { action: 'activate', app: 'Notepad', semanticObservationId: 'uia_fixture' });
await invalid('relai_computer', { action: 'set_value', app: 'Notepad', semanticObservationId: 'uia_fixture', targetId: 'e1' });
await invalid('relai_computer', { action: 'observe', app: 'Notepad', perception: 'visual-only' });
await invalid('relai_computer', { action: 'click', work_id: 'work', x: 10 });
await invalid('relai_computer', { action: 'status', text: 'unexpected' });
await invalid('relai_exec', { work_id: 'work' });
await invalid('relai_exec', { work_id: 'work', command: 'node -v', executable: 'node' });
await invalid('relai_exec', { work_id: 'work', command: 'node -v', argv: ['-v'] });
await valid('relai_edit', { work_id: 'work', semantic: { action: 'rename', path: 'src/index.js', line: 1, column: 1, newName: 'renamed' } });
await valid('relai_edit', { work_id: 'work', symbolEdit: { action: 'replace', symbol: 'renderApp', content: 'function renderApp() {}' } });
await invalid('relai_edit', { work_id: 'work', symbolEdit: { action: 'replace', symbol: 'renderApp', content: 'function renderApp() {}' }, path: 'src/index.js', content: 'conflict' });
await valid('relai_edit', { work_id: 'work', path: 'README.md', content: '# Replacement\n' });
await valid('relai_edit', { work_id: 'work', path: 'artifact.bin', file: { download_url: 'https://files.oaiusercontent.com/download/test', file_id: 'file_test', mime_type: 'application/octet-stream', file_name: 'artifact.bin' } });
await invalid('relai_edit', { work_id: 'work', path: 'artifact.bin', content: { download_url: 'https://files.oaiusercontent.com/download/test', file_id: 'file_test' } });
await invalid('relai_edit', { work_id: 'work', path: 'artifact.bin', file: { download_url: 'https://files.oaiusercontent.com/download/test', file_id: 'file_test' }, stage: 'start' });
await invalid('relai_edit', { work_id: 'work', path: 'artifact.bin', file: { download_url: 'https://files.oaiusercontent.com/download/test', file_id: 'file_test' }, semantic: { action: 'rename', path: 'src/index.js', line: 1, column: 1, newName: 'renamed' } });
await valid('relai_edit', { work_id: 'work', path: 'README.md', oldText: 'before', newText: 'after' });
await valid('relai_edit', { work_id: 'work', path: 'README.md', replacements: [{ oldText: 'before', newText: 'after' }] });
await valid('relai_edit', { work_id: 'work', updateText: '*** Begin Patch\n*** End Patch' });
await valid('relai_edit', { work_id: 'work', edits: [{ path: 'README.md', content: '# Replacement\n' }] });
await valid('relai_edit', { work_id: 'work', stage: 'start', path: 'README.md', content: '# Chunk\n' });
await valid('relai_edit', { work_id: 'work', stage: 'append', writeId: 'write', content: '# Chunk\n' });
await valid('relai_edit', { work_id: 'work', stage: 'commit', writeId: 'write' });
await invalid('relai_edit', { work_id: 'work', path: 'README.md' });
await valid('relai_edit', { workspace: 'repo', path: 'README.md', content: '# Taskless workspace edit\n' });
await invalid('relai_edit', { work_id: 'work', path: 'README.md', content: 42 });
await invalid('relai_edit', { work_id: 'work', path: 'README.md', content: '# Replacement\n', overwrite: true });

// Connector discovery intentionally exposes a flat, import-safe superset of
// callable fields. Conditional requirements and cross-action ownership are
// enforced once by the canonical executable/runtime contract below.
await publicValid('relai_work', { action: 'begin', workspace: 'repo' });
await publicValid('relai_work', { action: 'begin' });
await publicValid('relai_work', { action: 'status', title: 'runtime-rejects-sibling-field' });
await valid('relai_work', { action: 'status', workspace: 'repo', operationId: 'fallback_12345678901234567890' });
await publicValid('relai_read', { work_id: 'work', paths: ['README.md'] });
await publicValid('relai_read', { work_id: 'work', ranges: [{ path: 'README.md', startLine: 1, endLine: 2 }] });
await publicValid('relai_search', { action: 'text', work_id: 'work', queries: ['needle', 'haystack'], maxFiles: 200 });
await publicValid('relai_search', { action: 'text', work_id: 'work', query: 'runtime-rejects-sibling-field' });
await publicValid('relai_search', { action: 'semantic', work_id: 'work', queries: ['needle', 'haystack'], maxResults: 100 });
await publicValid('relai_process', { action: 'start', work_id: 'work', command: 'npm run dev' });
await publicValid('relai_inspect', { action: 'symbol', work_id: 'work' });
await publicValid('relai_ui', { action: 'navigate', work_id: 'work', sessionId: 'ui_12345678901234567890' });
await publicValid('relai_validate', { action: 'http', work_id: 'work', route: '/health', level: 'release' });
await publicValid('relai_changes', { action: 'restore', work_id: 'work' });
await publicValid('relai_publish', { action: 'commit', work_id: 'work' });
await publicValid('relai_exec', { work_id: 'work' });
await publicValid('relai_exec', { work_id: 'work', command: 'node -v', executable: 'node' });
await publicValid('relai_edit', { work_id: 'work', symbolEdit: { action: 'insert_before', symbol: 'renderApp', content: '// before' } });
await publicValid('relai_edit', { work_id: 'work', path: 'README.md' });
await publicValid('relai_edit', { work_id: 'work', path: 'README.md', content: '# Replacement\n', oldText: 'before', newText: 'after' });
await publicValid('relai_edit', { work_id: 'work', path: 'artifact.bin', file: { download_url: 'https://files.oaiusercontent.com/download/test', file_id: 'file_test', mime_type: 'application/octet-stream', file_name: 'artifact.bin' } });

// Discovery allows task-optional actions to use an authorized workspace directly,
// while still rejecting unknown fields and wrong primitive types.
await publicValid('relai_search', { action: 'text', workspace: 'repo', pattern: 'needle' });
await publicInvalid('relai_search', { action: 'text', work_id: 'work', unknown: true });
await publicInvalid('relai_edit', { work_id: 'work', content: 42 });
await publicInvalid('relai_edit', { work_id: 'work', path: 'artifact.bin', content: { download_url: 'https://files.oaiusercontent.com/download/test', file_id: 'file_test' } });

// Internal/direct invocation gets the same canonical validation before a handler runs.
await validateExecutableOperationInput(OP.SEARCH_TEXT, { workspace: 'repo', work_id: 'work', pattern: 'needle', maxFiles: 200 });
await assert.rejects(() => validateExecutableOperationInput(OP.SEARCH_TEXT, { workspace: 'repo', pattern: 'needle', maxFiles: 201 }), /Input validation error for search\.text/);
await assert.rejects(() => validateExecutableOperationInput(OP.SEARCH_SEMANTIC, { workspace: 'repo', query: 'needle', maxResults: 101 }), /Input validation error for search\.semantic/);
await assert.rejects(() => validateExecutableOperationInput(OP.VALIDATE_HTTP, { workspace: 'repo', route: '/health', timeoutMs: 600001 }), /Input validation error for validate\.http/);
await assert.rejects(() => validateExecutableOperationInput(OP.EXEC, { workspace: 'repo' }), /Input validation error for exec/);
await assert.rejects(() => validateExecutableOperationInput(OP.EDIT, { workspace: 'repo', path: 'README.md' }), /Input validation error for edit/);

assert.throws(() => resolveToolOperation('relai_work', { action: 'begin', workspace: 'repo', work_id: 'wrong-action-field' }), /Unsupported field 'work_id'/);
assert.throws(() => resolveToolOperation('relai_work', { action: 'status', title: 'wrong-action-field' }), /Unsupported field 'title'/);
assert.throws(() => resolveToolOperation('relai_process', { action: 'read', work_id: 'work', processId: 'p', command: 'wrong-action-field' }), /Unsupported field 'command'/);
assert.throws(() => resolveToolOperation('relai_process', { action: 'read', work_id: 'work', processId: 'p', unknown: true }), /Unsupported field 'unknown'/);
assert.equal(resolveToolOperation('relai_validate', { action: 'checks', work_id: 'work' }).operationName, OP.VALIDATE_CHECKS);
assert.equal(resolveToolOperation('relai_validate', { action: 'http', work_id: 'work', route: '/health' }).operationName, OP.VALIDATE_HTTP);

const metadata = getToolMetadata(config);
const validateMetadata = metadata.find(item => item.name === 'relai_validate');
assert.equal(validateMetadata.taskSupport, 'optional');
assert.equal(validateMetadata.actions.find(item => item.action === 'checks').taskSupport, 'optional');
assert.equal(validateMetadata.actions.find(item => item.action === 'diagnostics').taskSupport, 'optional');
assert.equal(validateMetadata.actions.find(item => item.action === 'http').taskSupport, 'optional');
assert.equal(validateMetadata.actions.find(item => item.action === 'http').executionClass, 'native_task_eligible');
assert.ok(validateMetadata.actions.find(item => item.action === 'http').fields.includes('route'));
const processMetadata = metadata.find(item => item.name === 'relai_process');
assert.ok(processMetadata.actions.find(item => item.action === 'start').required.includes('kind'));
assert.ok(processMetadata.actions.find(item => item.action === 'start').required.includes('purpose'));
const groups = getToolGroups(config);
assert.ok(groups.git.includes('relai_publish'));
assert.ok(groups.cleanup.includes('relai_changes'));

console.log(`Unified tool surface and action contracts passed: ${schemaBytes} bytes.`);

function bytes(tools) { return Buffer.byteLength(JSON.stringify({ tools }), 'utf8'); }
async function valid(name, value) {
  const result = await fromJsonSchema(schemaByName.get(name).inputSchema)['~standard'].validate(value);
  assert.equal(result.issues, undefined, `${name} valid input: ${JSON.stringify(result.issues || [])}`);
}
async function invalid(name, value) {
  const result = await fromJsonSchema(schemaByName.get(name).inputSchema)['~standard'].validate(value);
  assert.ok(result.issues?.length, `${name} must reject ${JSON.stringify(value)}`);
}
async function publicValid(name, value) {
  const result = await fromJsonSchema(publicSchemaByName.get(name).inputSchema)['~standard'].validate(value);
  assert.equal(result.issues, undefined, `${name} public valid input: ${JSON.stringify(result.issues || [])}`);
}
async function publicInvalid(name, value) {
  const result = await fromJsonSchema(publicSchemaByName.get(name).inputSchema)['~standard'].validate(value);
  assert.ok(result.issues?.length, `${name} public schema must reject ${JSON.stringify(value)}`);
}
