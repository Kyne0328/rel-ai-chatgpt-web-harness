import assert from 'node:assert/strict';
import fs from 'node:fs';

import { budget, measure } from '../../scripts/measure-tool-surface.mjs';
import { getPublicToolSchemas, getToolSurfaceManifest } from '../../src/tools/schema.js';

const current = measure();
assertWithinBudget(current);
assert.throws(
  () => assertWithinBudget({ ...current, discoverySchemaBytes: budget.discoverySchemaBytes + 1 }),
  /model-facing budget/,
  'the context gate must fail when discovery exceeds its budget'
);

const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const contextGateReferences = String(packageJson.scripts?.['test:all'] || '').match(/npm run test:context/g) || [];
assert.equal(contextGateReferences.length, 1, 'the shared test:all gate must execute test:context exactly once');

const publicTools = getPublicToolSchemas({ workspaces: {} });
const validateTool = publicTools.find(tool => tool.name === 'relai_validate');
const inspectTool = publicTools.find(tool => tool.name === 'relai_inspect');
assert.match(validateTool?.description || '', /complete:true.*succeeds/i, 'validation discovery must explain opt-in atomic completion');
assert.match(inspectTool?.description || '', /audit\/architecture\/diagnostics.*no symbol or query/i, 'inspect discovery must explain the audit action shape');
assert.doesNotMatch(publicTools.find(tool => tool.name === 'relai_browser')?.inputSchema?.properties?.action?.description || '', /work_id/, 'optional work_id must not be repeated in every action grammar');
for (const name of ['relai_work', 'relai_snapshot', 'relai_read', 'relai_search', 'relai_inspect']) {
  assert.equal(publicTools.find(tool => tool.name === name)?.inputSchema?.properties?.independent, undefined,
    `${name} discovery must not advertise independent when normal read/lifecycle calls do not need the escape hatch`);
}
for (const name of ['relai_edit', 'relai_exec', 'relai_validate']) {
  assert.ok(publicTools.find(tool => tool.name === name)?.inputSchema?.properties?.independent,
    `${name} discovery must retain independent for intentionally detached mutation or execution`);
}
assert.match(publicTools.find(tool => tool.name === 'relai_browser')?.inputSchema?.properties?.action?.description || '', /sessionId! except status\/start/i,
  'browser discovery must factor repeated session identity instead of repeating it on every action');
assert.match(publicTools.find(tool => tool.name === 'relai_computer')?.inputSchema?.properties?.action?.description || '', /app! except status\/displays\/stop/i,
  'computer discovery must factor repeated app identity instead of repeating it on every action');

const surface = getToolSurfaceManifest();
for (const tool of surface.tools) {
  assert.ok(Array.isArray(tool.outputFields), `${tool.name} must expose on-demand output metadata in the tool-surface resource`);
  assert.ok(tool.outputFields.includes('ok'), `${tool.name} output metadata must include ok`);
}

console.log('Tool discovery remains within the model-facing prompt budget and detailed output metadata stays on demand.');

function assertWithinBudget(measurement) {
  assert.ok(measurement.discoverySchemaBytes <= budget.discoverySchemaBytes, `tool discovery must stay within the ${budget.discoverySchemaBytes}-byte model-facing budget`);
  assert.ok(measurement.globalInstructionBytes < budget.globalInstructionBytes, 'global instructions must stay smaller than the historical baseline');
}
