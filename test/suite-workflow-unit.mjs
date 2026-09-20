// Consolidated workflow coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly workflow-check-catalog-unit.mjs
async function case_workflow_check_catalog_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/bridge/checkDetection.js");
    const { detectVerifyCheckUnits } = __m4;
  
    const __m5 = await import("../src/workflow/topology.js");
    const { discoverRepositoryTopology } = __m5;
  
    const __m6 = await import("../src/workflow/checkCatalog.js");
    const { buildCheckCatalog, selectChecksForPackages } = __m6;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workflow-checks-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        'check:quick': 'node --check index.js',
        check: 'npm run check:quick && eslint .',
        test: 'npm run test:all',
        'test:all': 'node --test',
        'benchmark:observability': 'node benchmark.js',
        release: 'node release.js',
        'watch:css': 'node watch.js',
        'fetch:tool': 'node fetch.js',
        'electron:dist': 'node package.js'
      }
    }));
    fs.mkdirSync(path.join(root, 'back-end'), { recursive: true });
    fs.mkdirSync(path.join(root, 'front-end'), { recursive: true });
    fs.writeFileSync(path.join(root, 'back-end', 'package.json'), JSON.stringify({ scripts: { test: 'node --test', migrate: 'node migrate.js' } }));
    fs.writeFileSync(path.join(root, 'front-end', 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint src', build: 'vite build' } }));
  
    const catalog = buildCheckCatalog(discoverRepositoryTopology(root));
    const front = catalog.filter(item => item.packageId === 'npm:front-end');
    const back = catalog.filter(item => item.packageId === 'npm:back-end');
    assert.ok(front.some(item => item.id === 'npm:front-end:test' && item.cwd === 'front-end' && item.command === 'npm test' && item.kind === 'test'));
    assert.ok(back.some(item => item.id === 'npm:back-end:test' && item.cwd === 'back-end'));
    assert.ok(back.some(item => item.kind === 'migration'));
    assert.equal(selectChecksForPackages(catalog, ['npm:back-end']).some(item => item.kind === 'migration'), false, 'migration must never be auto-selected');
    assert.equal(new Set(catalog.map(item => `${item.command}|${item.cwd}`)).size, catalog.length, 'duplicate command names in different package cwd must be preserved');
  
    for (const level of ['quick', 'standard', 'release']) {
      const units = detectVerifyCheckUnits(root, level);
      const serialized = units.map(item => `${item.command}@${item.cwd}`).join('\n');
      assert.doesNotMatch(serialized, /benchmark:|\brelease\b|watch:|fetch:|electron:dist/, `${level} validation must not auto-select operational scripts`);
      assert.ok(units.length <= 8, `${level} validation should stay bounded, got ${units.length}: ${serialized}`);
    }
    assert.deepEqual(detectVerifyCheckUnits(root, 'quick').map(item => item.command), ['npm run check:quick', 'npm run lint']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Package-aware structured check catalog tests passed.');
}
await case_workflow_check_catalog_unit();

// Formerly workflow-check-execution-unit.mjs
async function case_workflow_check_execution_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/bridge/validationChecks.js");
    const { normalizeVerifyChecks } = __m4;
  
    const __m5 = await import("../src/bridge/validation.js");
    const { relaiVerify } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workflow-check-exec-'));
  try {
    const frontend = path.join(root, 'front-end');
    const backend = path.join(root, 'back-end');
    fs.mkdirSync(frontend, { recursive: true });
    fs.mkdirSync(backend, { recursive: true });
    fs.writeFileSync(path.join(frontend, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('frontend-marker.txt','ok')"` } }));
    fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('fs').writeFileSync('backend-marker.txt','wrong')"` } }));
    const normalized = normalizeVerifyChecks({ checks: ['npm:front-end:test'] }, root, 'quick');
    assert.equal(normalized.checkUnits.length, 1);
    assert.equal(normalized.checkUnits[0].cwd, 'front-end');
    assert.equal(normalized.checkUnits[0].command, 'npm test');
  
    const result = await relaiVerify({ alias: 'repo', path: root, commands: {}, testCommands: {} }, { stateDir: path.join(root, '.state') }, {
      checks: ['npm:front-end:test'],
      changedFiles: ['front-end/src/app.js'],
      timeoutMs: 30000
    });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(frontend, 'frontend-marker.txt')), true);
    assert.equal(fs.existsSync(path.join(root, 'frontend-marker.txt')), false);
    assert.equal(fs.existsSync(path.join(backend, 'backend-marker.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Structured nested validation executes in package cwd.');
}
await case_workflow_check_execution_unit();

// Formerly workflow-context-ranking-unit.mjs
async function case_workflow_context_ranking_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/bridge/searchPlanner.js");
    const { rankMatchGroups } = __m1;
  
  const groups = [
    { path: 'back-end/src/user.js', matches: [{ line: 1 }] },
    { path: 'front-end/src/user-card.js', matches: [{ line: 1 }] },
    { path: 'shared/user.js', matches: [{ line: 1 }, { line: 2 }] }
  ];
  const ranked = rankMatchGroups(groups, 'user', {
    packagePaths: ['front-end'],
    taskOwnedPaths: ['front-end/src/user-card.js'],
    impactedPaths: ['shared/user.js']
  });
  assert.equal(ranked[0].path, 'front-end/src/user-card.js', 'task-owned/current-package matches should receive a ranking boost');
  assert.deepEqual(new Set(ranked.map(item => item.path)), new Set(groups.map(item => item.path)), 'workflow ranking must not hard-filter search results');
  
  console.log('Workflow-aware context ranking tests passed.');
}
await case_workflow_context_ranking_unit();

// Formerly workflow-contract-unit.mjs
async function case_workflow_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/workflow/contracts.js");
    const { WORKFLOW_INTENTS, deterministicActionId, stableJson } = __m1;
  
  assert.deepEqual(WORKFLOW_INTENTS, ['auto', 'investigation', 'bugfix', 'feature', 'refactor', 'migration', 'cleanup', 'documentation', 'performance', 'review', 'release', 'other']);
  
  const action = { tool: 'relai_validate', action: 'checks', args: { cwd: 'front-end', check: 'npm test' } };
  assert.equal(deterministicActionId(action), deterministicActionId(structuredClone(action)));
  assert.match(deterministicActionId(action), /^relai_validate:checks:/);
  assert.equal(stableJson({ b: 2, a: 1 }), stableJson({ a: 1, b: 2 }), 'stable JSON must remain deterministic for evidence and repeat-call fingerprints');
  
  console.log('Shared task-intent and deterministic fingerprint contracts passed.');
}
await case_workflow_contract_unit();

// Formerly workflow-dashboard-projection-unit.mjs
async function case_workflow_dashboard_projection_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("../src/taskObservability.js");
    const { sanitizeTaskRecordForProjection } = __m2;
  
    const __m3 = await import("../src/ui/task-identity.js");
    const { workSessionStateView } = __m3;
  
  const sanitized = sanitizeTaskRecordForProjection({
    id: 'task-1',
    status: 'inactive',
    workflowEvidence: [{ metadata: { stdout: 'must-not-leak' }, command: 'npm test' }],
    workflow: {
      stage: 'verify',
      risk: { level: 'medium', reasons: ['private detail'] },
      boundary: { level: 'package', changedFiles: ['secret/private.js'] },
      evidence: { fresh: 2, stale: 1, reusable: 1 },
      repeatCount: 3,
      recommendedActions: [{ tool: 'relai_validate', action: 'checks', reason: 'Run affected frontend test', args: { command: 'secret command' } }]
    }
  });
  assert.equal(Object.hasOwn(sanitized, 'workflow'), false, 'obsolete advisory workflow state must not reach the dashboard projection');
  assert.equal(Object.hasOwn(sanitized, 'workflowEvidence'), false, 'dashboard-safe task records must never include raw evidence receipts');
  assert.equal(JSON.stringify(sanitized).includes('secret command'), false);
  assert.equal(JSON.stringify(sanitized).includes('secret/private.js'), false);
  
  const inactive = workSessionStateView({ status: 'inactive' });
  assert.equal(inactive.status, 'inactive');
  assert.equal(inactive.label, 'Inactive');
  assert.equal(inactive.terminal, false);
  assert.equal(inactive.active, false);
  const inactiveValidationFailure = workSessionStateView({ status: 'inactive', resumeStatus: 'validation_failed' });
  assert.equal(inactiveValidationFailure.status, 'inactive');
  assert.equal(inactiveValidationFailure.label, 'Validation failed', 'inactive history should surface its last meaningful state instead of flattening every session to Inactive');
  assert.equal(inactiveValidationFailure.terminal, false);
  assert.equal(workSessionStateView({ status: 'inactive', validation: 'failed' }).label, 'Validation failed', 'existing inactive history with failed validation must recover useful context');
  
  const ui = fs.readFileSync('src/ui/features/sessions/index.js', 'utf8');
  assert.doesNotMatch(ui, /workflow\.stage|workflow\.recommendedAction/);
  
  console.log('Dashboard strips obsolete workflow guidance while preserving resumable inactivity state.');
}
await case_workflow_dashboard_projection_unit();

// Formerly workflow-edit-cadence-unit.mjs
async function case_workflow_edit_cadence_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/executionPlanner.js");
    const { postActionRecommendation } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-cadence-'));
  try {
    fs.mkdirSync(path.join(root, 'front-end', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'front-end', 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const workspace = { alias: 'repo', path: root };
    const docs = postActionRecommendation(workspace, ['README.md']);
    assert.equal(docs.runChecks, false);
    assert.equal(docs.returnDiff, true);
    const local = postActionRecommendation(workspace, ['front-end/src/app.js']);
    assert.equal(local.runChecks, true);
    assert.equal(local.returnDiff, true);
    assert.match(local.reason, /package|medium|source/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Risk-aware edit cadence recommendations passed.');
}
await case_workflow_edit_cadence_unit();

// Formerly workflow-evidence-history-unit.mjs
async function case_workflow_evidence_history_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/taskHistoryStore.ts");
    const { readRecentWorkflowEvidence, readTaskHistorySession, recordTaskHistoryEvent, recordWorkflowEvidence } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workflow-evidence-history-'));
  const config = { stateDir: path.join(root, 'state') };
  try {
    recordTaskHistoryEvent(config, { taskId: 'task-1', taskHistoryEligible: true, taskIdentityVersion: 2, taskIdExplicit: true, tool: 'work.begin', workspace: 'repo', ok: true, ts: new Date().toISOString() });
    const receipt = { version: 1, key: 'check:a', kind: 'check', sourceTool: 'relai_exec', createdAt: new Date().toISOString(), commandId: 'npm:test', command: 'npm test', cwd: '.', outcome: 'passed', repositoryFingerprint: 'fp', mutationGeneration: 1, workspaceGeneration: 2, paths: [], metadata: { exitCode: 0 } };
    recordWorkflowEvidence(config, 'task-1', receipt);
    assert.deepEqual(readRecentWorkflowEvidence(config, 'task-1'), [receipt]);
    assert.equal(Object.hasOwn(readTaskHistorySession(config, 'task-1'), 'workflowEvidence'), false, 'public task history must not expose raw receipts');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Workflow evidence persists privately in task history.');
}
await case_workflow_evidence_history_unit();

// Formerly workflow-hris-audit-unit.mjs
async function case_workflow_hris_audit_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { execFileSync } = __m4;
  
    const __m5 = await import("../src/bridge/validationPlan.js");
    const { createValidationPlan } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-hris-audit-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-hris-state-'));
  try {
    for (const pkg of ['front-end', 'back-end']) {
      fs.mkdirSync(path.join(root, pkg, 'src'), { recursive: true });
      fs.mkdirSync(path.join(root, pkg, 'test'), { recursive: true });
      fs.writeFileSync(path.join(root, pkg, 'package.json'), JSON.stringify({
        name: pkg,
        scripts: {
          test: 'node --test',
          build: 'node -e "void 0"',
          knip: 'node -e "void 0"'
        }
      }));
      fs.writeFileSync(path.join(root, pkg, 'src', 'app.js'), `export const ${pkg.replace('-', '')} = true;\n`);
      fs.writeFileSync(path.join(root, pkg, 'test', 'app.test.js'), 'export {};\n');
    }
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    fs.appendFileSync(path.join(root, 'front-end', 'src', 'app.js'), 'export const changed = true;\n');
  
    const plan = await createValidationPlan(
      { alias: 'hris', path: root, commands: {}, testCommands: {} },
      { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') },
      { changedFiles: ['front-end/src/app.js'] }
    );
    assert.equal(plan.recommended, 'focused');
    assert.ok(plan.checks.focused.length >= 1);
    assert.equal(plan.checks.focused.some(check => /back-end/i.test(check)), false, 'frontend work must not select backend validation');
    assert.equal(plan.checks.focused.some(check => /build|knip/i.test(check)), false, 'focused local work must not routinely select build/Knip');
    assert.equal(plan.checks.quick.some(check => /back-end|build|knip/i.test(check)), false, 'quick package validation must stay frontend-local and cheap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log('HRIS-equivalent frontend-only workflow audit passed.');
}
await case_workflow_hris_audit_unit();

// Formerly workflow-intent-unit.mjs
async function case_workflow_intent_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/workflow/contracts.js");
    const { WORKFLOW_INTENTS } = __m1;
  
    const __m2 = await import("../src/workflow/intent.js");
    const { classifyTaskIntent, normalizeTaskIntent } = __m2;
  
  const scenarios = [
    ['Fix this failing unit test', 'bugfix'],
    ['Add OAuth login support', 'feature'],
    ['Explain how this module works', 'investigation'],
    ['Clean up duplicate code without changing behavior', 'cleanup'],
    ['Refactor the task history ownership model', 'refactor'],
    ['Hard cutover the old dashboard transport', 'migration'],
    ['Optimize dashboard update latency', 'performance'],
    ['Update the README documentation', 'documentation'],
    ['Review the repository architecture', 'review'],
    ['Publish the next release', 'release'],
    ['Make this better somehow', 'other']
  ];
  
  for (const [objective, expected] of scenarios) {
    assert.ok(WORKFLOW_INTENTS.includes(expected), `${expected} must be a canonical workflow intent`);
    assert.equal(classifyTaskIntent(objective), expected, objective);
  }
  assert.equal(classifyTaskIntent(''), 'auto');
  assert.equal(normalizeTaskIntent('performance'), 'performance');
  assert.equal(normalizeTaskIntent('not-a-real-intent', 'feature'), 'feature');
  
  console.log('Task intent classification tests passed.');
}
await case_workflow_intent_unit();

// Formerly workflow-risk-unit.mjs
async function case_workflow_risk_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/workflow/risk.js");
    const { classifyWorkflowRisk } = __m1;
  
    const __m2 = await import("../src/validationStrategy.js");
    const { selectValidationLevel } = __m2;
  
  const cases = [
    [['README.md'], 'file', 'low'],
    [['front-end/src/app.js'], 'package', 'medium'],
    [['types/boundaries.d.ts'], 'cross_package', 'high'],
    [['front-end/package.json'], 'package', 'high'],
    [['.github/workflows/release.yml'], 'release', 'high'],
    [['src/tools/outputSchemas.js'], 'repository', 'high']
  ];
  for (const [changedFiles, boundary, risk] of cases) {
    const result = classifyWorkflowRisk({ changedFiles, packageIds: changedFiles[0].startsWith('front-end/') ? ['npm:front-end'] : [] });
    assert.equal(result.boundary.level, boundary, changedFiles[0]);
    assert.equal(result.risk.level, risk, changedFiles[0]);
  }
  const migration = classifyWorkflowRisk({ changedFiles: ['db/schema.sql'], operation: { kind: 'migration' } });
  assert.equal(migration.boundary.level, 'repository');
  assert.equal(migration.risk.level, 'critical');
  
  const manyLocal = classifyWorkflowRisk({ changedFiles: Array.from({ length: 40 }, (_, index) => `front-end/src/${index}.js`), packageIds: ['npm:front-end'] });
  assert.equal(manyLocal.boundary.level, 'package', 'file count alone must not escalate boundary');
  assert.equal(manyLocal.risk.level, 'medium');
  
  const selected = selectValidationLevel('.', {}, '', Array.from({ length: 40 }, (_, index) => 'front-end/src/' + index + '.js'), { packageIds: ['npm:front-end'] });
  assert.equal(selected.level, 'focused');
  
  console.log('Shared workflow boundary and risk classification tests passed.');
}
await case_workflow_risk_unit();

// Formerly workflow-skill-guidance-unit.mjs
async function case_workflow_skill_guidance_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
  const files = [
    'skills/rel-ai-workflow/SKILL.md',
    'skills/rel-ai-debugging/SKILL.md',
    'skills/rel-ai-investigation/SKILL.md',
    'skills/rel-ai-verification/SKILL.md',
    'skills/rel-ai-dev-process/SKILL.md',
    'skills/rel-ai-planning/SKILL.md'
  ];
  const text = Object.fromEntries(files.map(file => [file, fs.readFileSync(file, 'utf8')]));
  const workflow = text['skills/rel-ai-workflow/SKILL.md'];
  assert.doesNotMatch(workflow, /^## Standard workflow$/m, 'routing skill must not present one mandatory numbered workflow');
  assert.match(workflow, /agent chooses|agent.*next action/i, 'routing skill must leave next-action judgment with the agent');
  for (const label of ['documentation', 'bugfix', 'feature', 'investigation', 'release']) {
    assert.match(workflow.toLowerCase(), new RegExp(label), `routing skill must include a shortest-path ${label} example`);
  }
  for (const [file, contents] of Object.entries(text)) {
    assert.doesNotMatch(contents, /workflow\.recommendedActions|workflow\.avoidActions|runtime workflow guidance/i, `${file} must not defer planning to a duplicate runtime workflow coach`);
    assert.doesNotMatch(contents, /runChecks:\s*true/i, `${file} must not universally prescribe runChecks:true`);
  }
  assert.match(text['skills/rel-ai-verification/SKILL.md'], /reuse.*fresh|fresh.*reuse/i, 'verification skill must avoid rerunning exact fresh evidence');
  assert.match(text['skills/rel-ai-dev-process/SKILL.md'], /reused:\s*true|reused process/i, 'process skill must recognize exact same-task runtime reuse');
  
  console.log('Evidence-driven built-in skill guidance tests passed.');
}
await case_workflow_skill_guidance_unit();

// Formerly workflow-task-review-unit.mjs
async function case_workflow_task_review_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { execFileSync } = __m4;
  
    const __m5 = await import("../src/bridge/review.js");
    const { relaiDiff } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-review-'));
  try {
    fs.writeFileSync(path.join(root, 'task.txt'), 'base task\n');
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'base unrelated\n');
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'task.txt'), 'changed task\n');
    fs.writeFileSync(path.join(root, 'unrelated.txt'), 'changed unrelated\n');
    const workspace = { alias: 'repo', path: root };
    const config = {};
  
    const taskOnly = await relaiDiff(workspace, config, { _taskOwnedPaths: ['task.txt'] });
    assert.equal(taskOnly.reviewScope, 'task');
    assert.equal(taskOnly.reviewedScope, 'task');
    assert.match(taskOnly.reviewHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(taskOnly.reviewedFiles, ['task.txt']);
    assert.deepEqual(taskOnly.excludedWorkspaceFiles, ['unrelated.txt']);
    assert.match(taskOnly.diff, /task\.txt/);
    assert.doesNotMatch(taskOnly.diff, /unrelated\.txt/);
  
    const workspaceWide = await relaiDiff(workspace, config, { _taskOwnedPaths: ['task.txt'], scope: 'workspace' });
    assert.equal(workspaceWide.reviewScope, 'workspace');
    assert.equal(workspaceWide.reviewedScope, 'workspace');
    assert.deepEqual(new Set(workspaceWide.reviewedFiles), new Set(['task.txt', 'unrelated.txt']));
    assert.match(workspaceWide.diff, /task\.txt/);
    assert.match(workspaceWide.diff, /unrelated\.txt/);
  
    await assert.rejects(
      () => relaiDiff(workspace, config, { _taskOwnedPaths: ['task.txt'], path: 'unrelated.txt' }),
      /task-owned review scope/i
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Task-owned review scoping tests passed.');
}
await case_workflow_task_review_unit();

// Formerly workflow-topology-unit.mjs
async function case_workflow_topology_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/workflow/topology.js");
    const { TOPOLOGY_RECHECK_MS,
    clearTopologyCache,
    discoverRepositoryTopology,
    invalidateRepositoryTopology,
    packageForPath } = __m4;
  
    const __m5 = await import("../src/commandDiscovery.js");
    const { commandDiscoveryWarnings, discoverCommands } = __m5;
  
  const nestedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workflow-topology-'));
  try {
    fs.mkdirSync(path.join(nestedRoot, 'back-end', 'src'), { recursive: true });
    fs.mkdirSync(path.join(nestedRoot, 'front-end', 'src'), { recursive: true });
    fs.mkdirSync(path.join(nestedRoot, 'front-end', 'test'), { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, 'back-end', 'package.json'), JSON.stringify({ name: 'api', scripts: { test: 'node --test', lint: 'eslint .' } }));
    fs.writeFileSync(path.join(nestedRoot, 'front-end', 'package.json'), JSON.stringify({ name: 'web', scripts: { test: 'node --test', build: 'vite build' }, devDependencies: { vite: '^7' } }));
    fs.writeFileSync(path.join(nestedRoot, 'front-end', 'src', 'app.js'), 'export const app = true;\n');
    fs.writeFileSync(path.join(nestedRoot, 'front-end', 'test', 'app.test.js'), 'export {};\n');
    fs.mkdirSync(path.join(nestedRoot, 'node_modules', 'ignored'), { recursive: true });
    fs.writeFileSync(path.join(nestedRoot, 'node_modules', 'ignored', 'package.json'), '{}');
  
    const topology = discoverRepositoryTopology(nestedRoot);
    assert.deepEqual(topology.packages.map(item => item.id).sort(), ['npm:back-end', 'npm:front-end']);
    assert.equal(packageForPath(topology, 'front-end/src/app.js')?.id, 'npm:front-end');
    assert.equal(packageForPath(topology, 'back-end/src/api.js')?.id, 'npm:back-end');
    assert.match(topology.fingerprint, /^[a-f0-9]{64}$/);
  
    const commands = discoverCommands(nestedRoot);
    assert.equal(commands['npm:front-end:test'], 'npm test');
    assert.equal(commands['npm:back-end:test'], 'npm test');
    assert.equal(commands['npm:front-end:build'], 'npm run build');
  
    const malformed = path.join(nestedRoot, 'malformed');
    fs.mkdirSync(malformed, { recursive: true });
    fs.writeFileSync(path.join(malformed, 'package.json'), '{malformed', 'utf8');
    assert.deepEqual(discoverCommands(malformed), {});
    assert.ok(commandDiscoveryWarnings(malformed).some(item => item.source === 'package.json'), 'manifest discovery failures must remain visible to diagnostics');
  } finally {
    clearTopologyCache();
    fs.rmSync(nestedRoot, { recursive: true, force: true });
  }
  
  const invalidationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-topology-invalidation-'));
  try {
    fs.mkdirSync(path.join(invalidationRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(invalidationRoot, 'src', 'index.js'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(invalidationRoot, 'package.json'), JSON.stringify({ name: 'root-a', scripts: { test: 'node test.js' } }, null, 2));
  
    clearTopologyCache();
    const initial = discoverRepositoryTopology(invalidationRoot);
    assert.equal(initial.packages.length, 1);
    assert.equal(initial.packages[0].name, 'root-a');
    assert.deepEqual(initial.packages[0].sourceRoots, ['src']);
  
    fs.writeFileSync(path.join(invalidationRoot, 'src', 'index.js'), 'export const value = 2;\n');
    assert.equal(
      invalidateRepositoryTopology(invalidationRoot, ['src/index.js']),
      false,
      'ordinary edits inside an already-known source root must not invalidate topology'
    );
    assert.equal(discoverRepositoryTopology(invalidationRoot).fingerprint, initial.fingerprint);
  
    fs.writeFileSync(path.join(invalidationRoot, 'package.json'), JSON.stringify({
      name: 'root-renamed',
      scripts: { test: 'node test.js', lint: 'node lint.js' },
      dependencies: { example: '^1.0.0' }
    }, null, 2));
    assert.equal(discoverRepositoryTopology(invalidationRoot).fingerprint, initial.fingerprint, 'the hot cache should avoid repeated manifest stats inside its short recheck window');
    await new Promise(resolve => setTimeout(resolve, TOPOLOGY_RECHECK_MS + 20));
    const manifestChanged = discoverRepositoryTopology(invalidationRoot);
    assert.notEqual(manifestChanged.fingerprint, initial.fingerprint, 'external manifest edits must invalidate after the bounded recheck window');
    assert.equal(manifestChanged.packages[0].name, 'root-renamed');
    assert.deepEqual(manifestChanged.packages[0].dependencies, ['example']);
  
    fs.mkdirSync(path.join(invalidationRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(invalidationRoot, 'lib', 'new.js'), 'export {};\n');
    assert.equal(
      invalidateRepositoryTopology(invalidationRoot, ['lib/new.js']),
      true,
      'creating a previously absent package source root must invalidate topology'
    );
    const withLib = discoverRepositoryTopology(invalidationRoot);
    assert.deepEqual(withLib.packages[0].sourceRoots, ['src', 'lib']);
    assert.equal(invalidateRepositoryTopology(invalidationRoot, ['lib/new.js']), false, 'ordinary edits in the now-known root stay cached');
  
    fs.mkdirSync(path.join(invalidationRoot, 'packages', 'child'), { recursive: true });
    fs.writeFileSync(path.join(invalidationRoot, 'packages', 'child', 'package.json'), JSON.stringify({ name: 'child-package' }, null, 2));
    assert.equal(
      invalidateRepositoryTopology(invalidationRoot, ['packages/child/package.json']),
      true,
      'new manifest paths explicitly invalidate the cached manifest set'
    );
    const withChild = discoverRepositoryTopology(invalidationRoot);
    assert.ok(withChild.manifests.includes('packages/child/package.json'));
    assert.equal(withChild.packages.some(item => item.name === 'child-package'), true);
  
    assert.equal(invalidateRepositoryTopology(invalidationRoot, []), true, 'broad mutations invalidate topology conservatively');
  } finally {
    clearTopologyCache();
    fs.rmSync(invalidationRoot, { recursive: true, force: true });
  }
  
  console.log('Nested repository topology, command projection, and invalidation tests passed.');
}
await case_workflow_topology_unit();
