import assert from 'node:assert/strict';

import { approvalRequirement } from '../src/mcp/approval.js';
import { requiredCapability } from '../src/mcp/authorizationPolicy.js';
import {
  ACTION_REGISTRY,
  catalogApprovalRequirement,
  getCatalogAction,
  getCatalogToolDefinitions,
  getCatalogTools,
  getOperationDefinition,
  getOperationDefinitions,
  getToolActionCatalog,
  resolveToolOperation
} from '../src/tools/actionCatalog.js';
import { resolveExecutableToolCall } from '../src/tools/runtimeRegistry.js';
import { getToolDefinitions, getToolMetadata, getToolSchemas } from '../src/tools/schema.js';

const catalog = getToolActionCatalog();
const catalogTools = getCatalogTools();
const currentDefinitions = getToolDefinitions();
const currentSchemas = new Map(getToolSchemas().map(item => [item.name, item]));
const currentMetadata = new Map(getToolMetadata().map(item => [item.name, item]));

assert.ok(catalogTools.length > 0, 'the canonical tool catalog must not be empty');
assert.equal(catalogTools.length, currentDefinitions.length, 'catalog tools and public definitions must stay in parity');
assert.equal(new Set(catalog.map(entry => `${entry.publicTool}:${entry.action}`)).size, catalog.length, 'tool/action keys must stay unique');
assert.deepEqual(
  [...new Set(catalog.map(entry => entry.operationName))].sort(),
  getOperationDefinitions().map(operation => operation.name).sort(),
  'every canonical internal operation must be reachable from the public catalog'
);
assert.deepEqual(getCatalogToolDefinitions(), currentDefinitions);
assert.deepEqual(
  getCatalogToolDefinitions().map(definition => ({
    name: definition.name,
    title: definition.title,
    description: definition.description,
    annotations: definition.annotations
  })),
  getToolSchemas().map(schema => ({
    name: schema.name,
    title: schema.title,
    description: schema.description,
    annotations: schema.annotations
  }))
);
assert.deepEqual(
  catalogTools.map(tool => ({ name: tool.definition.name, actions: tool.actions.map(action => action.action) })),
  currentDefinitions.map(definition => ({
    name: definition.name,
    actions: currentMetadata.get(definition.name)?.actions?.map(action => action.action) || ['default']
  }))
);

for (const entry of catalog) {
  assert.equal(ACTION_REGISTRY[entry.publicTool][entry.action].operationName, entry.operationName);

  const operation = getOperationDefinition(entry.operationName);
  assert.ok(operation, `${entry.operationName} must exist in the current internal registry`);
  assert.equal(entry.title, operation.title);
  assert.equal(entry.description, operation.description);
  assert.deepEqual(entry.inputSchema, operation.inputSchema);
  assert.deepEqual(entry.outputSchema, operation.outputSchema);
  assert.deepEqual(entry.annotations, operation.annotations);
  assert.deepEqual(entry.behavior, { ...operation.behavior, ...(ACTION_REGISTRY[entry.publicTool][entry.action].behavior || {}) });
  assert.deepEqual(entry.execution, operation.execution);
  assert.deepEqual(entry.dashboard, operation.dashboard);
  assert.deepEqual(entry.groups, operation.groups);
  assert.equal(entry.handlerName, operation.handlerName);
  assert.equal(entry.capability, requiredCapability(entry.operationName));

  const args = sampleArgs(entry);
  assert.equal(getCatalogAction(entry.publicTool, args), entry);
  const resolution = resolveToolOperation(entry.publicTool, args);
  assert.equal(resolution.operationName, entry.operationName);
  const executable = resolveExecutableToolCall(entry.publicTool, args, {});
  assert.equal(entry.handlerName, executable.executionDefinition.handlerName);
  assert.equal(typeof executable.executionDefinition.handler, 'function');
  assert.equal(entry.operationName, executable.operationName);
  assert.deepEqual(entry.annotations, executable.executionDefinition.annotations);
  assert.deepEqual(entry.behavior, executable.executionDefinition.behavior);
  assert.deepEqual(entry.execution, executable.executionDefinition.execution);

  const toolMetadata = currentMetadata.get(entry.publicTool);
  if (entry.action === 'default') {
    const schema = currentSchemas.get(entry.publicTool).inputSchema;
    assert.deepEqual(entry.fields, Object.keys(schema.properties || {}).filter(field => field !== 'action').sort());
    assert.deepEqual(entry.required, [...(schema.required || [])].filter(field => field !== 'action').sort());
  } else {
    const actionMetadata = toolMetadata.actions.find(action => action.action === entry.action);
    assert.deepEqual(entry.fields, actionMetadata.fields);
    assert.deepEqual(entry.required, actionMetadata.required);
  }

  assert.deepEqual(catalogApprovalRequirement(entry.publicTool, args), approvalRequirement(entry.publicTool, args));
  if (entry.publicTool === 'relai_publish' && entry.action === 'commit') {
    const approvalArgs = { ...args, addAll: true };
    assert.deepEqual(catalogApprovalRequirement(entry.publicTool, approvalArgs), approvalRequirement(entry.publicTool, approvalArgs));
  }
}

assert.equal(getCatalogAction('unknown', {}), null);
assert.throws(() => getCatalogAction('relai_work', { action: 'unknown' }), /Unsupported action/);
console.log(`Canonical ${catalogTools.length}-tool, ${catalog.length}-action catalog execution and policy parity passed.`);

function sampleArgs(entry) {
  const key = `${entry.publicTool}:${entry.action}`;
  const args = entry.action === 'default' ? {} : { action: entry.action };
  if (entry.behavior.taskScope === 'required') args.work_id = 'work_catalog';
  switch (key) {
    case 'relai_work:begin': args.workspace = 'repo'; break;
    case 'relai_work:plan': args.steps = [{ title: 'Catalog plan step', status: 'pending' }]; break;
    case 'relai_work:finish': args.summary = 'Completed.'; break;
    case 'relai_search:text': args.pattern = 'needle'; break;
    case 'relai_search:semantic': args.query = 'needle'; break;
    case 'relai_inspect:symbol':
    case 'relai_inspect:references':
    case 'relai_inspect:trace': args.symbol = 'target'; break;
    case 'relai_inspect:related': args.query = 'target'; break;
    case 'relai_inspect:impact': args.paths = ['src/index.js']; break;
    case 'relai_exec:default': args.command = 'node --version'; break;
    case 'relai_process:start': Object.assign(args, { command: 'node server.js', kind: 'service', purpose: 'Catalog parity.' }); break;
    case 'relai_process:read':
    case 'relai_process:stop': args.processId = 'proc_catalog'; break;
    case 'relai_process:write': Object.assign(args, { processId: 'proc_catalog', input: 'status\n' }); break;
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
    case 'relai_desktop:reveal_path': Object.assign(args, { workspace: 'repo', path: 'README.md' }); break;
    case 'relai_desktop:open_uri': Object.assign(args, { workspace: 'repo', uri: 'https://example.com' }); break;
    case 'relai_desktop:launch_application': Object.assign(args, { workspace: 'repo', application: 'notepad.exe' }); break;
    case 'relai_desktop:clipboard_read': args.workspace = 'repo'; break;
    case 'relai_desktop:clipboard_write': Object.assign(args, { workspace: 'repo', text: 'hello' }); break;
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
    case 'relai_publish:commit': args.message = 'Catalog commit'; break;
  }
  if (entry.publicTool === 'relai_computer' && entry.required?.includes('app') && !args.app) args.app = 'example-app';
  return args;
}
