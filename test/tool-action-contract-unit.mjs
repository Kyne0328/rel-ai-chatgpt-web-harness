import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fromJsonSchema } from '@modelcontextprotocol/server';

import { approvalRequirement } from '../src/mcp/approval.js';
import { requiredCapability } from '../src/mcp/authorizationPolicy.js';
import { buildToolManifest, stableJson } from '../src/mcp/toolManifest.js';
import { catalogApprovalRequirement, getToolActionCatalog } from '../src/tools/actionCatalog.js';
import { OPERATION_REGISTRY, isToolSurfaceSourcePath } from '../src/tools/actionRegistry.js';
import { resolveExecutableToolCall } from '../src/tools/runtimeRegistry.js';
import { getToolDefinitions, getToolMetadata, getToolSurfaceManifest } from '../src/tools/schema.js';

const gatewayManifest = buildToolManifest({});
const gatewayCanonical = {
  schemaVersion: gatewayManifest.schemaVersion,
  toolSurfaceVersion: gatewayManifest.toolSurfaceVersion,
  instructions: gatewayManifest.instructions,
  tools: gatewayManifest.tools
};
const gatewayHash = value => crypto.createHash('sha256').update(stableJson(value)).digest('base64url');
assert.equal(gatewayManifest.hash, gatewayHash(gatewayCanonical), 'gateway manifest hash must cover the full canonical public contract');
assert.notEqual(
  gatewayHash({ ...gatewayCanonical, instructions: `${gatewayCanonical.instructions} changed` }),
  gatewayManifest.hash,
  'server instruction changes must change the gateway manifest hash'
);
const firstTool = gatewayCanonical.tools[0];
const outputChanged = {
  ...gatewayCanonical,
  tools: [{ ...firstTool, outputSchema: { ...firstTool.outputSchema, description: 'changed output contract' } }, ...gatewayCanonical.tools.slice(1)]
};
assert.notEqual(gatewayHash(outputChanged), gatewayManifest.hash, 'output schema changes must change the gateway manifest hash');

const definitions = getToolDefinitions();
const metadata = getToolMetadata();
const metadataByName = new Map(metadata.map(item => [item.name, item]));
const manifestByName = new Map(getToolSurfaceManifest().tools.map(item => [item.name, item]));
const catalog = getToolActionCatalog();

assert.ok(definitions.length > 0, 'the public tool contract must not be empty');
assert.ok(catalog.length >= definitions.length, 'every public tool must resolve to at least one operation');
assert.equal(new Set(definitions.map(item => item.name)).size, definitions.length, 'public tool names must remain unique');
assert.equal(new Set(catalog.map(item => `${item.publicTool}:${item.action}`)).size, catalog.length, 'public tool/action keys must remain unique');
assert.deepEqual(
  OPERATION_REGISTRY.map(record => record.definition.name).sort(),
  [...new Set(catalog.map(entry => entry.operationName))].sort(),
  'the canonical operation registry must own every executable operation exposed by the public catalog'
);
assert.ok(OPERATION_REGISTRY.every(record => record.publicActions.length > 0), 'stale unexposed operations must fail canonical registry construction');

const editDefinition = definitions.find(definition => definition.name === 'relai_edit');
assert.ok(editDefinition, 'relai_edit definition must exist');

const semanticWithMaxBytes = resolveExecutableToolCall('relai_search', {
  workspace: 'fixture', work_id: 'work_contract', action: 'semantic', query: 'needle', maxBytes: 4096
}, {});
assert.equal(semanticWithMaxBytes.operationArgs.maxBytes, 4096, 'semantic search must accept maxBytes advertised by the public tool schema');
const processReadWithWorkspace = resolveExecutableToolCall('relai_process', {
  workspace: 'fixture', work_id: 'work_contract', action: 'read', processId: 'proc_test'
}, {});
assert.equal(processReadWithWorkspace.operationArgs.workspace, 'fixture', 'process read must accept workspace advertised by the public action schema');
const processWriteWithWorkspace = resolveExecutableToolCall('relai_process', {
  workspace: 'fixture', work_id: 'work_contract', action: 'write', processId: 'proc_test', input: 'x'
}, {});
assert.equal(processWriteWithWorkspace.operationArgs.workspace, 'fixture', 'process write must accept workspace advertised by the public action schema');
const processStopWithWorkspace = resolveExecutableToolCall('relai_process', {
  workspace: 'fixture', work_id: 'work_contract', action: 'stop', processId: 'proc_test'
}, {});
assert.equal(processStopWithWorkspace.operationArgs.workspace, 'fixture', 'process stop must accept workspace advertised by the public action schema');
const scopedDiff = resolveExecutableToolCall('relai_changes', {
  workspace: 'fixture', work_id: 'work_contract', action: 'diff', scope: 'task'
}, {});
assert.equal(scopedDiff.operationArgs.scope, 'task', 'diff scope must be exposed by the public action contract');
assert.throws(() => resolveExecutableToolCall('relai_changes', {
  workspace: 'fixture', work_id: 'work_contract', action: 'restore', paths: ['README.md'], scope: 'task'
}, {}), /Unsupported field 'scope'/, 'fields owned by another action must be rejected instead of silently discarded');

assert.equal(isToolSurfaceSourcePath('src/tools/publicSchema.js'), true, 'public discovery schema changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/publicOperationSchemas.js'), true, 'public operation schema changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/outputValidation.js'), true, 'output validation changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/handlers.js'), true, 'handler registration changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/compactResult.js'), true, 'connector output compaction changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/execution.js'), true, 'tool execution changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/status.js'), true, 'tool status serialization changes are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/task.js'), true, 'tool task handlers are tool-surface changes');
assert.equal(isToolSurfaceSourcePath('src/tools/cancellation.js'), true, 'tool cancellation behavior is a tool-surface change');
assert.equal(isToolSurfaceSourcePath('src/tools/new-contract-module.js'), true, 'new tool-system files must inherit tool-surface risk without allowlist maintenance');
assert.equal(isToolSurfaceSourcePath('src/http/mcpTransport.ts'), false, 'non-tool-system paths keep their own risk classification');

const publicSchemaByName = new Map(gatewayManifest.tools.map(tool => [tool.name, tool.inputSchema]));
const resolvedKeys = [];
for (const entry of catalog) {
  const args = sampleArgs(entry);
  const resolved = resolveExecutableToolCall(entry.publicTool, args, {});
  assert.ok(resolved, `${entry.publicTool}:${entry.action} must resolve`);
  const advertisedSchema = publicSchemaByName.get(entry.publicTool);
  for (const field of entry.fields) {
    const internalEditTransportField = entry.publicTool === 'relai_edit' && ['stage', 'writeId'].includes(field);
    if (internalEditTransportField) {
      assert.equal(advertisedSchema?.properties?.[field], undefined, `${entry.publicTool}:${entry.action} internal transport field ${field} must stay out of public discovery`);
      continue;
    }
    assert.ok(advertisedSchema?.properties?.[field], `${entry.publicTool}:${entry.action} executable field ${field} must remain discoverable`);
  }
  if (entry.action !== 'default') {
    const publicValidation = await fromJsonSchema(advertisedSchema)['~standard'].validate(args);
    assert.equal(publicValidation.issues, undefined, `${entry.publicTool}:${entry.action} sample must satisfy advertised discovery schema`);
  }
  resolvedKeys.push(`${entry.publicTool}:${entry.action}`);
  assert.equal(resolved.operationName, entry.operationName);
  assert.equal(resolved.executionDefinition.handlerName, entry.handlerName);
  assert.equal(typeof resolved.executionDefinition.handler, 'function');
  assert.equal(requiredCapability(resolved.operationName), entry.capability);
  assert.deepEqual(resolved.executionDefinition.behavior, entry.behavior);
  assert.deepEqual(resolved.executionDefinition.execution, entry.execution);

  const publicMetadata = metadataByName.get(entry.publicTool);
  assert.ok(publicMetadata, `${entry.publicTool} must have public metadata`);
  const actionMetadata = entry.action === 'default'
    ? publicMetadata
    : publicMetadata.actions.find(item => item.action === entry.action);
  assert.ok(actionMetadata, `${entry.publicTool}:${entry.action} must have public action metadata`);
  assert.equal(actionMetadata.executionClass, entry.behavior.executionClass);
  assert.equal(actionMetadata.taskSupport, entry.execution?.taskSupport || 'forbidden');
  if (entry.action !== 'default') {
    assert.deepEqual(actionMetadata.annotations, resolved.executionDefinition.annotations);
    assert.equal(actionMetadata.taskScope, entry.behavior.taskScope);
    assert.equal(actionMetadata.concurrencyScope, entry.behavior.concurrencyScope);
  }

  const manifestTool = manifestByName.get(entry.publicTool);
  assert.ok(manifestTool, `${entry.publicTool} must be present in the tool-surface manifest`);
  const manifestAction = entry.action === 'default'
    ? manifestTool
    : manifestTool.actions.find(item => item.action === entry.action);
  assert.ok(manifestAction, `${entry.publicTool}:${entry.action} must be present in the tool-surface manifest`);
  assert.equal(manifestAction.executionClass, entry.behavior.executionClass);
  assert.equal(manifestAction.taskSupport, entry.execution?.taskSupport || 'forbidden');

  assert.deepEqual(
    catalogApprovalRequirement(entry.publicTool, args),
    approvalRequirement(entry.publicTool, args),
    `${entry.publicTool}:${entry.action} approval policy must have one meaning across the catalog and runtime`
  );
  if (entry.publicTool === 'relai_publish' && entry.action === 'commit') {
    const addAllArgs = { ...args, addAll: true };
    assert.deepEqual(catalogApprovalRequirement(entry.publicTool, addAllArgs), approvalRequirement(entry.publicTool, addAllArgs));
  }
}

for (const entry of catalog.filter(item => item.action !== 'default')) {
  const baseArgs = sampleArgs(entry);
  const siblings = catalog.filter(item => item.publicTool === entry.publicTool && item.action !== entry.action);
  const siblingSamples = siblings.map(sampleArgs);
  const foreignFields = siblingSamples.flatMap(sample => Object.entries(sample))
    .filter(([field]) => field !== 'action' && !entry.fields.includes(field));
  if (!foreignFields.length) continue;
  const [field, value] = foreignFields[0];
  const invalidArgs = { ...baseArgs, [field]: value };
  const publicValidation = await fromJsonSchema(publicSchemaByName.get(entry.publicTool))['~standard'].validate(invalidArgs);
  assert.equal(publicValidation.issues, undefined, `${entry.publicTool}:${entry.action} discovery keeps sibling field ${field} visible; runtime owns action-specific rejection`);
  assert.throws(
    () => resolveExecutableToolCall(entry.publicTool, invalidArgs, {}),
    new RegExp(`Unsupported field '${field}'`),
    `${entry.publicTool}:${entry.action} runtime resolver must reject sibling-only field ${field}`
  );
}

const discoveredKeys = definitions.flatMap(definition => {
  const actions = metadataByName.get(definition.name)?.actions || [];
  return actions.length ? actions.map(action => `${definition.name}:${action.action}`) : [`${definition.name}:default`];
});
assert.deepEqual(resolvedKeys.sort(), discoveredKeys.sort(), 'every discovered public action must be executable through the canonical resolver');

assert.ok(approvalRequirement('relai_changes', { action: 'reset', work_id: 'work_contract' }), 'workspace reset must remain approval-gated without a duplicate confirmation token');
const resetAction = catalog.find(entry => entry.publicTool === 'relai_changes' && entry.action === 'reset');
assert.equal(resetAction.fields.includes('confirmation'), false, 'reset must use native approval instead of a model-supplied magic confirmation field');
assert.equal(approvalRequirement('relai_publish', { action: 'push', work_id: 'work_contract' }), null, 'Git push must rely on publish capability authorization without a second approval interaction');
assert.equal(approvalRequirement('relai_publish', { action: 'push', work_id: 'work_contract', dryRun: true }), null, 'Git push dry-run must not request approval');
assert.equal(approvalRequirement('relai_publish', { action: 'commit', work_id: 'work_contract', message: 'Contract commit' }), null, 'implicit task-owned commit should not require extra approval');
assert.equal(approvalRequirement('relai_publish', { action: 'commit', work_id: 'work_contract', message: 'Contract commit', paths: ['src/selected.js'] }), null, 'explicit local commit scope must not require a second approval prompt');
assert.equal(approvalRequirement('relai_publish', { action: 'commit', message: 'Taskless explicit commit', paths: ['src/selected.js'] }), null, 'taskless explicit local commits must execute without dashboard approval');
assert.equal(approvalRequirement('relai_publish', { action: 'commit', work_id: 'work_contract', message: 'Contract commit', addAll: true }), null, 'explicit addAll local commits must not require dashboard approval');
assert.equal(approvalRequirement('relai_publish', { action: 'commit', message: 'Sensitive commit', paths: ['secret.txt'], sensitiveAuthorization: { operation: 'commit', paths: ['secret.txt'], reason: 'User explicitly requested this local commit.' } }), null, 'sensitiveAuthorization is the explicit local commit authorization and must not trigger a second approval layer');
for (const entry of catalog.filter(item => item.publicTool === 'relai_browser')) {
  assert.equal(entry.capability, 'process:manage', `relai_browser:${entry.action} must use structured process/browser authorization rather than raw computer control`);
  assert.equal(entry.behavior.taskScope, 'optional', `relai_browser:${entry.action} must allow principal/workspace/session authority without synthetic durable work`);
  assert.equal(approvalRequirement('relai_browser', sampleArgs(entry)), null, `relai_browser:${entry.action} must use principal authorization without a duplicate MCP approval flow`);
}
for (const entry of catalog.filter(item => item.publicTool === 'relai_desktop')) {
  assert.equal(approvalRequirement('relai_desktop', sampleArgs(entry)), null, `relai_desktop:${entry.action} must use principal authorization without a duplicate MCP approval flow`);
}
for (const entry of catalog.filter(item => item.publicTool === 'relai_computer')) {
  assert.equal(approvalRequirement('relai_computer', sampleArgs(entry)), null, `relai_computer:${entry.action} must never enter the MCP approval flow`);
}

console.log(`Dynamic public contract parity passed for ${definitions.length} tools and ${catalog.length} actions.`);

function sampleArgs(entry) {
  const key = `${entry.publicTool}:${entry.action}`;
  const args = entry.action === 'default' ? {} : { action: entry.action };
  if (entry.behavior?.taskScope === 'required') args.work_id = 'work_contract';
  switch (key) {
    case 'relai_work:begin': args.workspace = 'repo'; break;
    case 'relai_work:plan': args.steps = [{ title: 'Contract plan step', status: 'pending' }]; break;
    case 'relai_work:finish': args.summary = 'Completed.'; break;
    case 'relai_search:text': args.pattern = 'needle'; break;
    case 'relai_search:semantic': args.query = 'needle'; break;
    case 'relai_inspect:symbol':
    case 'relai_inspect:references':
    case 'relai_inspect:trace': args.symbol = 'target'; break;
    case 'relai_inspect:related': args.query = 'target'; break;
    case 'relai_inspect:impact': args.paths = ['src/index.js']; break;
    case 'relai_exec:default': args.command = 'node --version'; break;
    case 'relai_process:start': Object.assign(args, { command: 'node server.js', kind: 'service', purpose: 'Contract parity.' }); break;
    case 'relai_process:read':
    case 'relai_process:stop': args.processId = 'proc_contract'; break;
    case 'relai_process:write': Object.assign(args, { processId: 'proc_contract', input: 'status\n' }); break;
    case 'relai_ui:start': args.port = 3000; break;
    case 'relai_ui:navigate': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', route: '/' }); break;
    case 'relai_ui:snapshot':
    case 'relai_ui:screenshot':
    case 'relai_ui:console':
    case 'relai_ui:network':
    case 'relai_ui:reload':
    case 'relai_ui:stop': args.sessionId = 'ui_abcdefghijklmnopqrst'; break;
    case 'relai_ui:interact': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } }); break;
    case 'relai_ui:viewport': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', width: 1280, height: 720 }); break;
    case 'relai_browser:start': args.url = 'http://192.168.1.20/app'; break;
    case 'relai_browser:status': break;
    case 'relai_browser:tabs':
    case 'relai_browser:open_tab':
    case 'relai_browser:snapshot':
    case 'relai_browser:screenshot':
    case 'relai_browser:stop': args.sessionId = 'browser_abcdefghijklmnopqrst'; break;
    case 'relai_browser:close_tab': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', tabId: 'tab_abcdefghijklmnopqrst' }); break;
    case 'relai_browser:navigate': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', url: 'https://intranet.example.test/page' }); break;
    case 'relai_browser:interact': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } }); break;
    case 'relai_browser:upload': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', path: 'artifact.pdf', target: { by: 'label', value: 'Upload' } }); break;
    case 'relai_browser:download': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', path: 'downloads/report.pdf', interaction: 'click', target: { by: 'text', value: 'Download' } }); break;
    case 'relai_desktop:open_path':
    case 'relai_desktop:reveal_path': Object.assign(args, { workspace: 'fixture', path: 'README.md' }); break;
    case 'relai_desktop:open_uri': Object.assign(args, { workspace: 'fixture', uri: 'https://example.com' }); break;
    case 'relai_desktop:launch_application': Object.assign(args, { workspace: 'fixture', application: 'notepad.exe' }); break;
    case 'relai_desktop:clipboard_read': args.workspace = 'fixture'; break;
    case 'relai_desktop:clipboard_write': Object.assign(args, { workspace: 'fixture', text: 'hello' }); break;
    case 'relai_computer:move':
    case 'relai_computer:click':
    case 'relai_computer:double_click':
    case 'relai_computer:right_click': Object.assign(args, { x: 10, y: 20 }); break;
    case 'relai_computer:drag': Object.assign(args, { x: 10, y: 20, toX: 30, toY: 40 }); break;
    case 'relai_computer:scroll': Object.assign(args, { direction: 'down', distance: 500 }); break;
    case 'relai_computer:type': args.text = 'hello'; break;
    case 'relai_computer:key': args.key = 'enter'; break;
    case 'relai_computer:hotkey': args.keys = ['ctrl', 's']; break;
    case 'relai_computer:activate': Object.assign(args, { semanticObservationId: 'uia_fixture', targetId: 'e1' }); break;
    case 'relai_computer:set_value': Object.assign(args, { semanticObservationId: 'uia_fixture', targetId: 'e1', value: '' }); break;
    case 'relai_computer:batch': args.actions = [{ action: 'move', x: 10, y: 20 }]; break;
    case 'relai_computer:stop': break;
    case 'relai_computer:approve_app':
    case 'relai_computer:revoke_app': args.app = 'example-app'; break;
    case 'relai_validate:http': args.route = '/health'; break;
    case 'relai_changes:restore': args.paths = ['README.md']; break;
    case 'relai_changes:reset': break;
    case 'relai_changes:replay': args.checkpointId = 'review_abcdefghijklmnopqrstuvwx'; break;
    case 'relai_changes:tidy_run': args.planId = 'tidy_abcdefghijklmnopqrst'; break;
    case 'relai_publish:commit': args.message = 'Contract commit'; break;
  }
  if (entry.publicTool === 'relai_computer' && entry.required?.includes('app') && !args.app) args.app = 'example-app';
  return args;
}
