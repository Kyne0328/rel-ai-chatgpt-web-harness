import assert from 'node:assert/strict';
import fs from 'node:fs';

import { assertToolBehavior, evaluateToolBehavior } from '../scripts/evaluate-tool-behavior.mjs';

const expectations = JSON.parse(fs.readFileSync(new URL('./fixtures/tool-behavior-prompts.json', import.meta.url), 'utf8'));
const observations = expectations.map(item => ({
  id: item.id,
  tools: [...item.expectedTools],
  renderedTools: [...item.renderedTools]
}));

const passing = evaluateToolBehavior(expectations, observations);
assert.equal(passing.ok, true);
assert.equal(passing.evaluated, expectations.length);
assert.doesNotThrow(() => assertToolBehavior(passing));

const wasteful = observations.map(item => ({
  ...item,
  tools: item.tools.length ? Array.from({ length: 100 }, () => item.tools).flat() : []
}));
const wastefulReport = evaluateToolBehavior(expectations, wasteful);
assert.equal(wastefulReport.ok, false, 'repeating every selected tool must not pass the efficiency evaluator');
assert.ok(wastefulReport.failures.some(item => item.kind === 'excessive_calls'));
assert.ok(wastefulReport.failures.some(item => item.kind === 'duplicate_calls'));

const wrong = structuredClone(observations);
wrong.find(item => item.id === 'read-known-file').tools = ['relai_search'];
wrong.find(item => item.id === 'one-shot-test').tools.push('relai_process');
wrong.find(item => item.id === 'begin-task-card').renderedTools = ['relai_work', 'relai_validate'];
wrong.find(item => item.id === 'non-repository').tools = ['relai_work'];
wrong.find(item => item.id === 'trace-symbol-impact').tools.push('relai_app_probe');
wrong.pop();

const failing = evaluateToolBehavior(expectations, wrong);
assert.equal(failing.ok, false);
for (const kind of ['missing_tool', 'forbidden_tool', 'render_boundary', 'app_only_tool', 'missing_observation']) {
  assert.ok(failing.failures.some(item => item.kind === kind), `evaluator must catch ${kind}`);
}
assert.throws(() => assertToolBehavior(failing), /Tool behavior evaluation failed/);

console.log('Provider-agnostic tool metadata evaluator covers direct, indirect, negative, forbidden-tool, app-only, and widget-render boundaries.');
