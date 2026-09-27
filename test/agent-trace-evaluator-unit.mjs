import assert from 'node:assert/strict';

import { evaluateAgentTraces } from '../scripts/evaluate-agent-traces.mjs';

const expectations = [{
  id: 'focused-fix',
  taskMode: 'required',
  requiredTools: ['relai_edit', 'relai_validate'],
  forbiddenTools: ['relai_process'],
  expectedSkills: ['rel-ai-workflow', 'rel-ai-debugging'],
  forbiddenSkills: ['rel-ai-dev-process'],
  requireLiveTrace: true,
  maxCalls: 6,
  maxDuplicateCalls: 0,
  minPollIntervalMs: 30_000,
  maxResultBytes: 20_000,
  maxLatencyMs: 120_000
}];
const trace = {
  id: 'focused-fix',
  metadata: { model: 'recorded-model-version', instructionVersion: 'instruction-hash', toolSurfaceVersion: 'surface-version', source: 'live-agent-trace', capturedAt: '2026-09-26T00:00:00.000Z' },
  skills: ['rel-ai-workflow', 'rel-ai-debugging'],
  completed: true,
  durationMs: 60_000,
  calls: [
    { tool: 'relai_work', action: 'begin', signature: 'begin', startedAtMs: 1_000, resultBytes: 300 },
    { tool: 'relai_edit', action: 'patch', signature: 'edit:a', startedAtMs: 2_000, resultBytes: 500 },
    { tool: 'relai_validate', action: 'checks', signature: 'validate:a', startedAtMs: 3_000, resultBytes: 800 },
    { tool: 'relai_work', action: 'status', signature: 'status', startedAtMs: 4_000, resultBytes: 200 },
    { tool: 'relai_work', action: 'status', signature: 'status', startedAtMs: 35_000, resultBytes: 200 }
  ]
};
assert.equal(evaluateAgentTraces(expectations, [trace]).ok, true);

const wasteful = structuredClone(trace);
wasteful.calls.splice(2, 0, { ...wasteful.calls[1], startedAtMs: 2_100 });
wasteful.calls.at(-1).startedAtMs = 10_000;
wasteful.metadata.model = '';
wasteful.metadata.source = 'maintainer-fixture';
wasteful.skills = ['rel-ai-workflow', 'rel-ai-dev-process'];
wasteful.completed = false;
const report = evaluateAgentTraces(expectations, [wasteful]);
assert.equal(report.ok, false);
for (const kind of ['missing_version', 'trace_provenance', 'skills', 'forbidden_skill', 'incomplete', 'duplicate_calls', 'poll_interval']) {
  assert.ok(report.failures.some(item => item.kind === kind), `recorded-trace evaluator must catch ${kind}`);
}

console.log('Recorded agent trace evaluator preserves call order and measures completion, versions, duplicate calls, polling, result bytes, and latency.');
