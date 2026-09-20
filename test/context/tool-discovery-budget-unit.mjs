import assert from 'node:assert/strict';
import fs from 'node:fs';

import { budget, measure } from '../../scripts/measure-tool-surface.mjs';
import { getToolSurfaceManifest } from '../../src/tools/schema.js';

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
