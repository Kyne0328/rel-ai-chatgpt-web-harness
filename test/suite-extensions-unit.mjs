// Consolidated extensions coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly plugin-skill-content-policy-unit.mjs
async function case_plugin_skill_content_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../scripts/validate-plugin.mjs");
    const { validatePlugin } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-skill-policy-'));
  try {
    fs.mkdirSync(path.join(root, 'skills', 'rel-ai-workflow', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'rel-ai-workflow', 'references'), { recursive: true });
    fs.mkdirSync(path.join(root, 'skills', 'rel-ai-workflow', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'skills', 'PROVENANCE.md'), '# provenance\n');
    fs.writeFileSync(path.join(root, 'skills', 'rel-ai-workflow', 'SKILL.md'), `---\nname: rel-ai-workflow\ndescription: A sufficiently long workflow skill description used only by this plugin validation fixture.\n---\n\nSee references/workflows.md and references/safety.md. A skill may mention curl when that is part of its own instructions.\n`);
    const agentPath = path.join(root, 'skills', 'rel-ai-workflow', 'agents', 'openai.yaml');
    fs.writeFileSync(agentPath, 'interface:\n  display_name: "Fixture"\n  short_description: "Fixture skill"\n  default_prompt: "Use $rel-ai-workflow and curl when the user asks."\n');
    fs.writeFileSync(path.join(root, 'skills', 'rel-ai-workflow', 'references', 'workflows.md'), '# workflows\n');
    fs.writeFileSync(path.join(root, 'skills', 'rel-ai-workflow', 'references', 'safety.md'), '# safety\n');
    fs.writeFileSync(path.join(root, 'skills', 'rel-ai-workflow', 'scripts', 'helper.js'), 'console.log("helper")\n');
  
    assert.equal(validatePlugin(root).ok, true);
  
    fs.writeFileSync(agentPath, '# display_name: Decoy\ninterface:\n  short_description: "Fixture skill"\n  default_prompt: "Use $rel-ai-workflow."\n');
    assert.throws(
      () => validatePlugin(root),
      /interface\.display_name must be a non-empty string/,
      'metadata fields hidden in comments must not satisfy structural validation'
    );
  
    fs.writeFileSync(agentPath, 'display_name: "Wrong root"\nshort_description: "Fixture skill"\ndefault_prompt: "Use $rel-ai-workflow."\n');
    assert.throws(
      () => validatePlugin(root),
      /must contain an interface root mapping/,
      'flat metadata must not pass when ChatGPT expects the interface mapping'
    );
  
    fs.writeFileSync(agentPath, 'interface:\n  display_name: "Fixture"\n  display_name: "Duplicate"\n  short_description: "Fixture skill"\n  default_prompt: "Use $rel-ai-workflow."\n');
    assert.throws(
      () => validatePlugin(root),
      /duplicate key 'display_name'/,
      'duplicate YAML metadata keys must be rejected instead of silently winning'
    );
  
    console.log('Skill package validation structurally validates agent metadata.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_plugin_skill_content_policy_unit();

// Formerly skill-behavior-evaluator-unit.mjs
async function case_skill_behavior_evaluator_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("../scripts/evaluate-skill-behavior.mjs");
    const { assertSkillBehavior, evaluateSkillBehavior } = __m2;
  
  const expectations = JSON.parse(fs.readFileSync(new URL('./fixtures/skill-behavior-prompts.json', import.meta.url), 'utf8'));
  const observations = expectations.map(item => ({
    id: item.id,
    prompt: item.prompt,
    skills: [...item.skills],
    firstTool: item.firstTool,
    firstAction: item.firstAction,
    tools: item.firstTool ? [item.firstTool] : []
  }));
  
  const passing = evaluateSkillBehavior(expectations, observations);
  assert.equal(passing.ok, true);
  assert.equal(passing.evaluated, expectations.length);
  assert.equal(passing.failed, 0);
  assert.doesNotThrow(() => assertSkillBehavior(passing));
  
  const pressureIndex = expectations.findIndex(item => item.scenario === 'pressure');
  const oneShotIndex = expectations.findIndex(item => item.forbiddenTool === 'relai_process');
  const negativeIndex = expectations.findIndex(item => item.skills.length === 0);
  assert.ok(pressureIndex >= 0 && oneShotIndex >= 0 && negativeIndex >= 0, 'fixture must include pressure, forbidden-tool, and negative cases');
  
  const wrong = structuredClone(observations);
  wrong[pressureIndex].skills = ['rel-ai-workflow', 'rel-ai-planning', 'rel-ai-debugging', 'rel-ai-investigation', 'rel-ai-verification', 'rel-ai-dev-process'];
  wrong[oneShotIndex].tools.push('relai_process');
  wrong[negativeIndex].skills = ['rel-ai-workflow'];
  wrong[negativeIndex].firstTool = 'relai_work';
  wrong[negativeIndex].firstAction = 'status';
  wrong.pop();
  
  const failing = evaluateSkillBehavior(expectations, wrong);
  assert.equal(failing.ok, false);
  assert.ok(failing.failures.some(item => item.kind === 'skills' && item.scenario === 'pressure'), 'over-invoking specialists must fail the eval');
  assert.ok(failing.failures.some(item => item.kind === 'forbidden_tool'), 'using a managed process for one-shot work must fail the eval');
  assert.ok(failing.failures.some(item => item.kind === 'first_tool'), 'repository tooling on a non-repository prompt must fail the eval');
  assert.ok(failing.failures.some(item => item.kind === 'first_action'), 'wrong first relai_work action must fail the eval');
  assert.ok(failing.failures.some(item => item.kind === 'missing_observation'), 'missing recorded cases must fail the eval');
  assert.throws(() => assertSkillBehavior(failing), /Skill behavior evaluation failed/);
  
  assert.throws(
    () => evaluateSkillBehavior([{ prompt: 'Repo task', skills: ['rel-ai-workflow'], firstTool: 'relai_work', firstAction: 'status' }], []),
    /must expect relai_work begin first/,
    'repository behavior expectations must encode the task-begin invariant'
  );
  
  console.log('Provider-agnostic skill behavior evaluator catches routing, first-action, forbidden-tool, and missing-case regressions.');
}
await case_skill_behavior_evaluator_unit();

// Formerly skill-discovery-unit.mjs
async function case_skill_discovery_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/localRepoBridge.js");
    const { repoSnapshot, relaiReadAsync } = __m4;
  
    const __m5 = await import("../src/skillDiscovery.js");
    const { discoverSkills, readDiscoveredSkill, selectRelevantSkills } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-skill-discovery-'));
  const repo = path.join(root, 'repo');
  const userRoot = path.join(root, 'user-skills');
  const stateDir = path.join(root, 'state');
  const workspace = { alias: 'app', path: repo, commands: {}, testCommands: {} };
  const config = { stateDir, workspaces: { app: workspace } };
  
  function writeSkill(base, directory, name, description, body) {
    const target = path.join(base, directory);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8');
  }
  
  try {
    fs.mkdirSync(repo, { recursive: true });
    writeSkill(path.join(repo, '.agents', 'skills'), 'release', 'release-check', 'Project release checks.', 'Use the project release workflow.');
    writeSkill(userRoot, 'release-user', 'release-check', 'User fallback release checks.', 'User version.');
    writeSkill(userRoot, 'review', 'code-review', 'Review repository changes.', 'Read only.');
    writeSkill(userRoot, 'debug', 'debug-runtime', 'Debug runtime failures and timeout problems.', 'Trace the failure.');
    writeSkill(userRoot, 'find', 'find-skills', 'Helps users discover skills and existing functionality.', 'Find relevant skills.');
    writeSkill(userRoot, 'general', 'general-helper', 'General guidance and repository assistance.', 'Generic help.');
  
    const discovered = discoverSkills(workspace, { userRoot });
    assert.deepEqual(discovered.map(item => item.name), ['code-review', 'debug-runtime', 'find-skills', 'general-helper', 'release-check']);
    assert.equal(discovered.find(item => item.name === 'release-check').source, 'project', 'project skills must override user skills with the same name');
    assert.equal(discovered.find(item => item.name === 'code-review').path, 'user:code-review', 'user skill discovery must not disclose the home path');
    const suggested = selectRelevantSkills(discovered, 'Fix the runtime timeout and debug the failing connection.', { limit: 10 });
    assert.equal(suggested[0].name, 'debug-runtime', 'task wording should rank the most relevant discovered skill first');
    assert.match(suggested[0].reason, /runtime|debug|timeout/i);
    assert.equal(suggested.some(item => item.name === 'general-helper'), false, 'common function words must not make an unrelated skill relevant');
  
    const genericDiscovery = selectRelevantSkills(discovered, 'Optimize the skill discovery context and remove generic matches.', { limit: 10 });
    assert.equal(genericDiscovery.some(item => item.name === 'find-skills'), false, 'generic skill/discovery vocabulary must not inject an unrelated skill');
    const explicitDiscovery = selectRelevantSkills(discovered, 'Find a skill for database migrations.', { limit: 10 });
    assert.equal(explicitDiscovery[0]?.name, 'find-skills', 'an explicit multi-term skill-name intent must still discover the matching skill');
  
    const userSkill = readDiscoveredSkill(workspace, 'code-review', { userRoot });
    assert.match(userSkill.content, /Read only/);
    assert.match(userSkill.securityBoundary, /not authorization/i);
  
    const snapshot = await repoSnapshot(workspace, config, { includeFiles: true, maxEntries: 50 });
    assert.ok(snapshot.skills.some(item => item.name === 'release-check' && item.source === 'project'));
    assert.equal(snapshot.files?.some?.(file => String(file).includes('.agents/skills')), false, 'skill implementations must stay out of repository snapshot indexing');
  
    const loaded = await relaiReadAsync(workspace, config, { skill: 'release-check', maxBytes: 4096 });
    assert.equal(loaded.items[0].type, 'skill');
    assert.match(loaded.items[0].content, /project release workflow/i);
    await assert.rejects(
      () => relaiReadAsync(workspace, config, { skill: 'release-check', paths: ['package.json'] }),
      /cannot be combined/i
    );
  
    console.log('Dynamic project/user skill discovery, precedence, safe loading, and snapshot tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_skill_discovery_unit();
