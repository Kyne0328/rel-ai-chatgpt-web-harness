import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { evaluateSkillBehavior } from '../scripts/evaluate-skill-behavior.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = ['rel-ai-debugging', 'rel-ai-dev-process', 'rel-ai-investigation', 'rel-ai-planning', 'rel-ai-verification', 'rel-ai-workflow'];
assert.deepEqual(validatePlugin(root).skills, expected);

const workflow = read('skills/rel-ai-workflow/SKILL.md');
assert.match(descriptionOf(workflow), /inspect.*read.*edit.*test.*build.*debug.*validate.*review.*publish/i);
assert.match(descriptionOf(workflow), /Do not use.*no repository or local runtime access/i);
for (const heading of ['Shortest sufficient path', 'Route specialists only when needed', 'Tool boundaries', 'Approved plan execution', 'Definition of done']) {
  assert.match(workflow, new RegExp('## ' + heading, 'i'), 'workflow skill must keep the ' + heading + ' boundary');
}
for (const term of ['work_id', 'taskProgress', 'rel-ai-planning', 'rel-ai-investigation', 'rel-ai-debugging', 'rel-ai-verification', 'rel-ai-dev-process', 'relai_exec', 'relai_validate', 'relai_process', 'relai://server/tool-surface']) {
  assert.ok(workflow.includes(term), 'workflow skill must retain ' + term + ' routing guidance');
}
assert.match(workflow, /Projectless.*taskless/i);
assert.match(workflow, /Do not invoke specialists ceremonially/i);
assert.match(workflow, /references\/workflows\.md/);
assert.match(workflow, /references\/safety\.md/);

const specialistContracts = {
  'rel-ai-planning': {
    use: /non-trivial repository features|refactors|migrations|multi-stage/i,
    avoid: /Do not use for small localized changes/i,
    body: /architecture|sequencing|dependencies|completion conditions/i
  },
  'rel-ai-investigation': {
    use: /read-only repository questions.*evidence/i,
    avoid: /Do not use to implement fixes|Do not use.*final completion/i,
    body: /sufficient proof|targeted reads|bounded measurement/i
  },
  'rel-ai-debugging': {
    use: /reproducibly wrong|errors|broken tests|crashes|regressions/i,
    avoid: /Do not use for general audits|final verification/i,
    body: /root cause|targeted regression|speculative edits/i
  },
  'rel-ai-verification': {
    use: /after repository changes|fixes|release work/i,
    avoid: /Do not use for open-ended architecture|feasibility/i,
    body: /risk|existing coverage|distinct meaningful concern/i
  },
  'rel-ai-dev-process': {
    use: /persistent development server|file watcher|long-lived preview|interactive CLI/i,
    avoid: /Do not use for one-shot tests|builds|linters/i,
    body: /readiness|reuse|stop/i
  }
};

for (const [name, contract] of Object.entries(specialistContracts)) {
  const source = read('skills/' + name + '/SKILL.md');
  assert.match(descriptionOf(source), contract.use, name + ' must state its positive trigger');
  assert.match(descriptionOf(source), contract.avoid, name + ' must state its negative trigger');
  assert.match(source, contract.body, name + ' must preserve its behavioral boundary');
  assert.match(source, /Reuse an active `work_id`/);
}

const prompts = JSON.parse(read('test/fixtures/skill-behavior-prompts.json'));
const knownSkills = new Set(expected);
assert.ok(prompts.length >= 10);
assert.ok(prompts.some(item => item.skills.length === 0), 'prompt suite needs negative cases');
for (const specialist of expected.filter(name => name !== 'rel-ai-workflow')) {
  assert.ok(prompts.some(item => item.skills.includes(specialist)), 'prompt suite must exercise ' + specialist);
}
assert.ok(prompts.some(item => item.scenario === 'pressure' && item.skills.length === 1), 'prompt suite must reject ceremonial specialist over-invocation');
assert.ok(prompts.some(item => item.forbiddenTool === 'relai_process'), 'prompt suite must keep a one-shot-process negative case');
assert.ok(prompts.some(item => item.taskMode === 'existing' && item.firstTool !== 'relai_work'), 'continuation must reuse an existing task');

for (const item of prompts) {
  assert.equal(new Set(item.skills).size, item.skills.length, 'duplicate skill in ' + item.prompt);
  for (const skill of item.skills) assert.ok(knownSkills.has(skill), 'unknown skill ' + skill + ' in ' + item.prompt);
  if (item.skills.length) {
    assert.equal(item.skills[0], 'rel-ai-workflow');
    if ((item.taskMode || 'required') === 'required') {
      assert.equal(item.firstTool, 'relai_work');
      assert.equal(item.firstAction, 'begin');
    }
  } else {
    assert.equal(item.firstTool, null);
    assert.equal(item.firstAction, null);
  }
}

const observationFixture = JSON.parse(read('test/fixtures/skill-behavior-observations.json'));
assert.match(observationFixture.provenance, /maintainer-authored.*not.*live.*trace/i);
const observations = observationFixture.observations;
assert.deepEqual(observations.map(item => item.id), prompts.map(item => item.id), 'observations must cover every prompt in stable order');
assert.equal(evaluateSkillBehavior(prompts, observations).ok, true, 'deterministic skill-routing contract must remain executable');

const planRequiredIndex = prompts.findIndex(item => item.requiresPlan === true);
const missingPlan = structuredClone(observations);
missingPlan[planRequiredIndex].calls = (missingPlan[planRequiredIndex].calls || []).filter(call =>
  !(call.tool === 'relai_work' && ['begin', 'plan'].includes(call.action)) && call.taskProgress !== true
);
const missingPlanReport = evaluateSkillBehavior(prompts, missingPlan);
assert.equal(missingPlanReport.ok, false);
assert.ok(missingPlanReport.failures.some(item => item.kind === 'missing_plan'));

const pressureIndex = prompts.findIndex(item => item.scenario === 'pressure');
const overInvoked = structuredClone(observations);
overInvoked[pressureIndex].skills = expected;
assert.equal(evaluateSkillBehavior(prompts, overInvoked).ok, false, 'pressure-driven specialist over-invocation must fail');

console.log('Skill package boundaries, negative triggers, and deterministic routing contracts passed.');

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8').replaceAll('\r\n', '\n');
}

function descriptionOf(source) {
  const description = source.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(description, 'SKILL.md requires a frontmatter description');
  return description;
}
