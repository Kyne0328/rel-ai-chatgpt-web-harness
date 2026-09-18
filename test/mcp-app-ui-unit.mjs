import assert from 'node:assert/strict';
import { ToolSchema } from '@modelcontextprotocol/core';

import { toolUiMetadata } from '../src/mcp/appUi.js';
import { goalModeAppHtml, readGoalModeResource } from '../src/mcp/goalModeApp.js';
import { GOAL_CONTINUATION_DELAY_MS, GOAL_MODE_RESOURCE_MIME_TYPE, GOAL_MODE_RESOURCE_URI } from '../src/mcp/goalModeContract.js';
import { openAiConversationId, toolContext } from '../src/mcp/context.js';
import { LOCAL_DEVELOPER_SECURITY_SCHEMES } from '../src/mcp/localDeveloperMode.js';
import { PUBLIC_MCP_SERVER_INSTRUCTIONS } from '../src/mcp/serverInstructions.js';
import { getMcpToolSchemas, getPublicToolSchemas, getToolSchemas } from '../src/tools/schema.js';

const publicSchemas = getPublicToolSchemas();
const mcpSchemas = getMcpToolSchemas();
const canonicalByName = new Map(getToolSchemas().map(schema => [schema.name, schema]));
const mcpByName = new Map(mcpSchemas.map(schema => [schema.name, schema]));

assert.equal(publicSchemas.length, mcpSchemas.length, 'public and MCP discovery must expose the same canonical surface');
assert.equal(mcpSchemas.length, canonicalByName.size, 'MCP discovery must not add app-only helper tools');
assert.deepEqual(mcpSchemas.filter(schema => schema.name.startsWith('relai_app_')).map(schema => schema.name), []);
for (const schema of mcpSchemas) assert.equal(ToolSchema.safeParse(schema).success, true, `${schema.name} must remain a valid MCP tool descriptor`);

const invocationLabels = new Map([
  ['relai_work', ['Updating Rel.AI task…', 'Rel.AI task updated']],
  ['relai_snapshot', ['Scanning repository…', 'Repository scanned']],
  ['relai_read', ['Reading repository…', 'Repository read']],
  ['relai_search', ['Searching repository…', 'Repository searched']],
  ['relai_inspect', ['Inspecting code…', 'Code inspected']],
  ['relai_edit', ['Applying changes…', 'Changes applied']],
  ['relai_exec', ['Running command…', 'Command finished']],
  ['relai_process', ['Managing process…', 'Process updated']],
  ['relai_ui', ['Testing local UI…', 'Local UI tested']],
  ['relai_browser', ['Using local browser…', 'Local browser updated']],
  ['relai_desktop', ['Using local desktop…', 'Desktop action finished']],
  ['relai_computer', ['Controlling computer… Press Esc to stop.', 'Computer action finished']],
  ['relai_validate', ['Validating changes…', 'Validation finished']],
  ['relai_changes', ['Reviewing changes…', 'Changes reviewed']],
  ['relai_publish', ['Publishing changes…', 'Changes published']]
]);

for (const schema of publicSchemas) {
  assert.deepEqual(schema.annotations, canonicalByName.get(schema.name)?.annotations, `${schema.name} must preserve truthful canonical annotations`);
  assert.deepEqual(schema._meta?.securitySchemes, LOCAL_DEVELOPER_SECURITY_SCHEMES, `${schema.name} must advertise noauth compatibility metadata`);
  const expected = invocationLabels.get(schema.name);
  assert.deepEqual([
    schema._meta?.['openai/toolInvocation/invoking'],
    schema._meta?.['openai/toolInvocation/invoked']
  ], expected, `${schema.name} must retain concise native invocation labels`);
  assert.deepEqual(toolUiMetadata(schema.name), {
    'openai/toolInvocation/invoking': expected[0],
    'openai/toolInvocation/invoked': expected[1],
    ...(schema.name === 'relai_work' ? { ui: { resourceUri: GOAL_MODE_RESOURCE_URI } } : {})
  });
  if (schema.name === 'relai_work') assert.deepEqual(schema._meta?.ui, { resourceUri: GOAL_MODE_RESOURCE_URI }, 'relai_work must attach the Goal continuation MCP App');
  else assert.equal(schema._meta?.ui, undefined, `${schema.name} must stay iframe-free`);
  assert.equal(schema._meta?.['openai/outputTemplate'], undefined, `${schema.name} must not attach a ChatGPT output template`);
  assert.ok(expected.every(label => label.length <= 64));
}

assert.deepEqual(mcpByName.get('relai_publish')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });

const goalResource = readGoalModeResource(GOAL_MODE_RESOURCE_URI);
assert.equal(goalResource.contents?.[0]?.mimeType, GOAL_MODE_RESOURCE_MIME_TYPE);
assert.equal(goalResource.contents?.[0]?.uri, GOAL_MODE_RESOURCE_URI);
const goalHtml = goalModeAppHtml();
assert.match(goalHtml, /ui\/initialize/);
assert.match(goalHtml, /ui\/notifications\/initialized/);
assert.match(goalHtml, /ui\/notifications\/tool-result/);
assert.match(goalHtml, /tools\/call/);
assert.match(goalHtml, /ui\/message/);
assert.match(goalHtml, /goal_completed/);
assert.match(goalHtml, /claimContinuation/);
assert.match(goalHtml, /releaseContinuationClaim/);
assert.match(goalHtml, /hostCapabilities\.message\.text/);
assert.match(goalHtml, /hostCapabilities\.serverTools/);
assert.match(goalHtml, /Safe Goal continuation requires serverTools/);
assert.match(goalHtml, new RegExp(String(GOAL_CONTINUATION_DELAY_MS)));
assert.doesNotMatch(goalHtml, /sendFollowUpMessage|dispatchEvent|\.click\(\)/, 'Goal continuation must use the MCP Apps bridge rather than synthetic user activation');

assert.match(PUBLIC_MCP_SERVER_INSTRUCTIONS, /work_id omission never selects another task/i, 'server instructions must preserve explicit task-attribution isolation');
assert.doesNotMatch(PUBLIC_MCP_SERVER_INSTRUCTIONS, /brief normal assistant progress|Native tool invocation labels|private chain-of-thought/i,
  'host-owned presentation and reasoning policy must not be duplicated into MCP instructions');

const openAiEnvelope = { 'openai/session': 'chat-session-regression' };
assert.equal(openAiConversationId(openAiEnvelope), 'chat-session-regression');
assert.equal(toolContext({ mcpReq: { id: 42, _meta: openAiEnvelope, envelope: {} } }).conversationId, 'chat-session-regression');

console.log('Canonical tools keep native status labels without mounting an MCP approval card.');
