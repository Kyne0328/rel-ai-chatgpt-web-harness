// Consolidated execution coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly deferred-operation-unit.mjs
async function case_deferred_operation_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:url");
    const { fileURLToPath } = __m4;
  
    const __m5 = await import("./helpers/mcp-client.mjs");
    const { startMcpClient } = __m5;
  
    const __m6 = await import("../src/mcp/protocol.js");
    const { TASKS_EXTENSION_REVISION } = __m6;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-deferred-operation-cutover-'));
  const workspaceRoot = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const configPath = path.join(temp, 'config.json');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'pass.cjs'), `console.log('done');\n`);
  fs.writeFileSync(configPath, JSON.stringify({
    version: 3,
    stateDir,
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    workspaces: {
      app: {
        path: workspaceRoot,
        testCommands: {},
        commands: {},
        context: { snapshotMaxFiles: 1000, includeRoots: [], excludePaths: ['.git', 'node_modules'] },
        validationRules: {}
      }
    }
  }, null, 2));
  
  const client = startMcpClient({
    root,
    configPath,
    timeoutMs: 15000,
    env: { REL_AI_MCP_STATE_DIR: stateDir },
    clientInfo: { name: 'deferred-operation-cutover-test', version: '1.0.0' }
  });
  let requestId = 0;
  
  async function call(name, args) {
    requestId += 1;
    client.call(requestId, name, args);
    return client.waitFor(requestId);
  }
  
  try {
    client.initialize(++requestId);
    const discovery = await client.waitFor(requestId);
    assert.deepEqual(
      discovery.result.capabilities.extensions?.['io.modelcontextprotocol/tasks'],
      { revision: TASKS_EXTENSION_REVISION }
    );
  
    client.send(++requestId, 'tools/list');
    const listed = await client.waitFor(requestId);
    const tools = listed.result.tools;
    const names = tools.map(tool => tool.name);
    assert.equal(names.includes('relai_operation_task_get'), false);
    assert.equal(names.includes('relai_operation_task_cancel'), false);
    for (const name of ['relai_exec', 'relai_validate']) {
      const tool = tools.find(candidate => candidate.name === name);
      assert.equal(tool.inputSchema.properties.defer, undefined, `${name} must not expose defer`);
      assert.equal(tool.outputSchema?.properties?.operationTask, undefined, `${name} must not expose operationTask`);
    }
  
    const started = await call('relai_work', { action: 'begin', workspace: 'app' });
    assert.equal(started.result?.isError, false, JSON.stringify(started));
    const logicalTaskId = started.result.structuredContent.work_id;
  
    const rejectedDefer = await call('relai_exec', {
      workspace: 'app',
      work_id: logicalTaskId,
      command: 'node pass.cjs',
      timeoutMs: 10000,
      defer: true
    });
    assert.ok(rejectedDefer.error || rejectedDefer.result?.isError, JSON.stringify(rejectedDefer));
  
    for (const removed of ['relai_operation_task_get', 'relai_operation_task_cancel']) {
      const response = await call(removed, {
        work_id: logicalTaskId,
        operationTaskId: 'task_removed'
      });
      assert.ok(response.error || response.result?.isError, JSON.stringify(response));
      assert.match(JSON.stringify(response), /not found|Unknown tool/i);
    }
  
    const synchronous = await call('relai_exec', {
      workspace: 'app',
      work_id: logicalTaskId,
      executable: process.execPath,
      argv: ['pass.cjs'],
      timeoutMs: 10000
    });
    assert.equal(synchronous.result?.isError, false, JSON.stringify(synchronous));
    assert.equal(synchronous.result?.structuredContent?.exitCode, 0);
    assert.match(synchronous.result?.structuredContent?.stdout || '', /done/);
  } finally {
    await client.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('Legacy deferred-operation controls are absent and non-capable requests use bounded synchronous execution.');
}
await case_deferred_operation_unit();

// Formerly edit-consolidation-unit.mjs
async function case_edit_consolidation_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("../src/executionPlanner.js");
    const { planEdit } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-consolidation-'));
  const workspace = { alias: 'repo', path: root };
  const config = { stateDir: path.join(root, '.state') };
  const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  
  try {
    fs.writeFileSync(path.join(root, 'duplicate.txt'), 'item\nitem\nitem\n');
    const occurrence = await planEdit(workspace, config, {
      path: 'duplicate.txt',
      oldText: 'item',
      newText: 'selected',
      occurrence: 2
    });
    assert.equal(occurrence.ok, true);
    assert.equal(occurrence.deprecated, undefined, 'primary edit results must not carry compatibility metadata');
    assert.equal(fs.readFileSync(path.join(root, 'duplicate.txt'), 'utf8'), 'item\nselected\nitem\n');
  
    fs.writeFileSync(path.join(root, 'multi.txt'), 'alpha beta gamma\n');
    const multi = await planEdit(workspace, config, {
      path: 'multi.txt',
      expectedSha256: sha('alpha beta gamma\n'),
      replacements: [
        { oldText: 'alpha', newText: 'one' },
        { oldText: 'gamma', newText: 'three' }
      ]
    });
    assert.equal(multi.ok, true);
    assert.equal(multi.replacements.length, 2);
    assert.equal(fs.readFileSync(path.join(root, 'multi.txt'), 'utf8'), 'one beta three\n');
  
    fs.writeFileSync(path.join(root, 'batch.txt'), 'left middle right\n');
    const batch = await planEdit(workspace, config, {
      edits: [{
        path: 'batch.txt',
        replacements: [
          { oldText: 'left', newText: 'L' },
          { oldText: 'right', newText: 'R' }
        ]
      }]
    });
    assert.equal(batch.ok, true);
    assert.equal(batch.appliedCount, 1);
    assert.equal(fs.readFileSync(path.join(root, 'batch.txt'), 'utf8'), 'L middle R\n');
  
    const stagedStart = await planEdit(workspace, config, {
      stage: 'start',
      path: 'staged.txt',
      content: 'chunk-one\n'
    });
    assert.equal(stagedStart.plannerPath, 'write:staged');
    assert.equal(stagedStart.deprecated, undefined);
    await planEdit(workspace, config, {
      stage: 'append',
      writeId: stagedStart.writeId,
      content: 'chunk-two\n'
    });
    const stagedCommit = await planEdit(workspace, config, {
      stage: 'commit',
      writeId: stagedStart.writeId
    });
    assert.equal(stagedCommit.ok, true);
    assert.equal(stagedCommit.plannerPath, 'write:staged');
    assert.equal(stagedCommit.deprecated, undefined);
    assert.equal(fs.readFileSync(path.join(root, 'staged.txt'), 'utf8'), 'chunk-one\nchunk-two\n');
  
    fs.writeFileSync(path.join(root, 'protected.txt'), 'unchanged\n');
    await assert.rejects(
      () => planEdit(workspace, config, {
        path: 'protected.txt',
        content: 'replacement\n',
        oldText: 'unchanged',
        newText: 'changed'
      }),
      /conflicting primary edit forms.*Use exactly one public edit form/i
    );
    assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'unchanged\n');
  
    await assert.rejects(
      () => planEdit(workspace, config, { path: 'protected.txt' }),
      /no primary edit forms.*\{ path, content \}/i
    );
    assert.equal(fs.readFileSync(path.join(root, 'protected.txt'), 'utf8'), 'unchanged\n');
  
    await assert.rejects(
      () => planEdit(workspace, config, { stage: 'start', path: 'never-created.txt' }),
      /requires exactly one of content or updateText/i
    );
    assert.equal(fs.existsSync(path.join(root, 'never-created.txt')), false);
  
    console.log('Unified edit parity tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_edit_consolidation_unit();

// Formerly edit-recovery-unit.mjs
async function case_edit_recovery_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/localRepoBridge.js");
    const { workspaceReplace } = __m4;
  
    const __m5 = await import("../src/tools/errors.js");
    const { enhanceToolError, serializeToolError } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-recovery-'));
  const workspace = { alias: 'app', path: root };
  const config = { stateDir: path.join(root, '.state') };
  const target = path.join(root, 'sample.js');
  
  try {
    fs.writeFileSync(target, [
      'function first() {',
      '  return shared();',
      '}',
      '',
      'function second() {',
      '  return shared();',
      '}',
      ''
    ].join('\n'));
  
    assert.throws(
      () => workspaceReplace(workspace, config, {
        path: 'sample.js',
        oldText: '  return shared();',
        newText: '  return changed();'
      }),
      error => {
        assert.equal(error.code, 'EDIT_CONTEXT_MISMATCH');
        assert.equal(error.retryable, true);
        assert.equal(error.candidateCount, 2);
        assert.deepEqual(error.matchLines, [2, 6]);
        assert.equal(error.candidateContexts.length, 2);
        assert.match(error.message, /lines 2, 6/);
        assert.match(error.currentSha256, /^[a-f0-9]{64}$/);
        return true;
      }
    );
  
    let zeroMatchError;
    try {
      workspaceReplace(workspace, config, {
        path: 'sample.js',
        oldText: 'function first() {\n  return shared();\n  console.log("new line");\n}',
        newText: 'function first() {}'
      });
    } catch (error) {
      zeroMatchError = error;
    }
    assert.equal(zeroMatchError?.code, 'EDIT_CONTEXT_MISMATCH');
    assert.equal(zeroMatchError?.candidateCount, 0);
    assert.ok(zeroMatchError?.candidateContexts.length > 0, 'zero-match recovery should return bounded nearby current context when an anchor still exists');
  
    const enhanced = enhanceToolError('relai_edit', zeroMatchError);
    assert.equal(enhanced.code, 'EDIT_CONTEXT_MISMATCH', 'edit guidance must preserve structured recovery metadata');
    const serialized = serializeToolError('relai_edit', enhanced);
    assert.equal(serialized.errorDetails.code, 'EDIT_CONTEXT_MISMATCH');
    assert.equal(serialized.errorDetails.retryable, true);
    assert.match(serialized.errorDetails.currentSha256, /^[a-f0-9]{64}$/);
    assert.ok(serialized.errorDetails.candidateContexts.length > 0);
  
    console.log('Exact edit mismatch recovery metadata tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_edit_recovery_unit();

// Formerly exec-dirty-mutation-unit.mjs
async function case_exec_dirty_mutation_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:child_process");
    const { execFileSync } = __m1;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("../src/bridge/exec.js");
    const { relaiExec } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-exec-dirty-mutation-'));
  const workspacePath = path.join(root, 'workspace');
  const scriptPath = path.join(workspacePath, 'mutate.js');
  const dirtyPath = path.join(workspacePath, 'dirty.txt');
  const workspace = { alias: 'app', path: workspacePath };
  const config = {};
  
  function quote(value) {
    const text = String(value);
    if (process.platform === 'win32') return `'${text.replaceAll("'", "''")}'`;
    return `'${text.replaceAll("'", `'"'"'`)}'`;
  }
  
  try {
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(dirtyPath, 'committed\n');
    fs.writeFileSync(scriptPath, "require('node:fs').writeFileSync(process.argv[2], 'changed again\\n');\n");
    execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
    execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspacePath });
    execFileSync('git', ['add', '.'], { cwd: workspacePath });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspacePath, stdio: 'ignore' });
    fs.writeFileSync(dirtyPath, 'already dirty\n');
  
    const command = process.platform === 'win32'
      ? `& ${quote(process.execPath)} ${quote(scriptPath)} ${quote('dirty.txt')}`
      : `${quote(process.execPath)} ${quote(scriptPath)} ${quote('dirty.txt')}`;
    const result = await relaiExec(workspace, config, { command });
    assert.equal(result.ok, true);
    assert.deepEqual(result.changedFiles, ['dirty.txt']);
  
    const commandSecret = 'exec-command-secret-123456';
    const redacted = await relaiExec(workspace, config, {
      executable: process.execPath,
      argv: [scriptPath, 'dirty.txt', `--token=${commandSecret}`]
    });
    assert.equal(redacted.ok, true);
    assert.doesNotMatch(redacted.command, new RegExp(commandSecret));
    assert.match(redacted.command, /\[REDACTED\]/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('relai_exec detects mutations to files that were already dirty before the command.');
}
await case_exec_dirty_mutation_unit();

// Formerly exec-discovery-guidance-unit.mjs
async function case_exec_discovery_guidance_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools/schema.js");
    const { getPublicToolSchemas } = __m1;
  
  const tool = getPublicToolSchemas().find(item => item.name === 'relai_exec');
  assert.ok(tool, 'relai_exec must remain present in the public MCP contract');
  assert.equal(tool.inputSchema?.oneOf, undefined, 'relai_exec must expose a flat connector input schema');
  assert.match(tool.description || '', /one-shot workspace commands/i);
  assert.match(tool.description || '', /direct executable \+ argv.*command string/i);
  assert.match(tool.inputSchema?.description || '', /direct executable \+ argv.*shell command/i);
  assert.match(tool.inputSchema?.properties?.command?.description || '', /shell command/i);
  assert.match(tool.inputSchema?.properties?.executable?.description || '', /shell:false/i);
  assert.ok(tool.inputSchema?.properties?.argv, 'relai_exec discovery must keep argv callable');
  assert.match(tool.inputSchema?.properties?.input?.description || '', /multiline scripts or structured text/i);
  console.log('ChatGPT-facing relai_exec first-call direct-mode guidance passed.');
}
await case_exec_discovery_guidance_unit();

// Formerly exec-phase-benchmark-contract.mjs
async function case_exec_phase_benchmark_contract() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:child_process");
    const { spawnSync } = __m1;
  
  const run = spawnSync(process.execPath, ['scripts/benchmark-exec-phases.mjs', '--samples=2'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 60000
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const lines = String(run.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  assert.equal(result.samples, 2);
  for (const key of ['commandMs', 'relaiExecWallMs', 'callToolWallMs', 'executorOverheadMs', 'orchestrationOverheadMs', 'readCallMs', 'searchCallMs', 'readResponseBytes', 'searchResponseBytes']) {
    assert.equal(typeof result.medians?.[key], 'number', `${key} median missing`);
    assert.ok(result.medians[key] >= 0, `${key} median must be non-negative`);
    assert.equal(typeof result.percentiles?.[key]?.p50, 'number', `${key} p50 missing`);
    assert.equal(typeof result.percentiles?.[key]?.p95, 'number', `${key} p95 missing`);
    assert.ok(result.percentiles[key].p95 >= result.percentiles[key].p50, `${key} p95 must be at least p50`);
  }
  assert.ok(result.workBegin?.wallMs >= 0);
  assert.ok(result.workBegin?.responseBytes > 0);
  assert.equal(typeof result.environment?.platform, 'string');
  assert.equal(typeof result.environment?.node, 'string');
  console.log('Exec phase benchmark emits machine-readable timing partitions.');
}
await case_exec_phase_benchmark_contract();

// Formerly execution-observability-unit.mjs
async function case_execution_observability_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/executionObservability.js");
    const { createExecutionPlanObserver, executionMetricAttributes } = __m1;
  
  const updates = [];
  const observe = createExecutionPlanObserver({
    source: 'validation',
    title: 'Running validation',
    noun: 'checks',
    category: 'validation',
    update: patch => updates.push(patch)
  });
  
  observe({ type: 'step_started', name: 'a', metadata: { displayName: 'Lint' }, active: 1, completed: 0, total: 3 });
  observe({ type: 'step_started', name: 'b', metadata: { displayName: 'Typecheck' }, active: 2, completed: 0, total: 3 });
  let latest = updates.at(-1);
  assert.equal(latest.currentStage, '2 checks running in parallel');
  assert.equal(latest.activity.metadata.parallelActiveCount, 2);
  assert.equal(latest.activity.metadata.pendingCount, 1);
  assert.deepEqual(latest.activity.metadata.running, ['Lint', 'Typecheck']);
  assert.equal(latest.progress.completedUnits, 0);
  assert.equal(latest.progress.totalUnits, 3);
  
  observe({ type: 'step_completed', name: 'a', metadata: { displayName: 'Lint' }, active: 1, completed: 1, total: 3 });
  latest = updates.at(-1);
  assert.equal(latest.activity.metadata.parallelActiveCount, 1);
  assert.equal(latest.activity.metadata.completedCount, 1);
  assert.equal(latest.activity.metadata.pendingCount, 1);
  assert.deepEqual(latest.activity.metadata.running, ['Typecheck']);
  
  const attributes = executionMetricAttributes('validation', {
    stepCount: 4,
    parallelGroupCount: 1,
    maxConcurrentSteps: 3,
    wallTimeMs: 120,
    accumulatedStepTimeMs: 290,
    overlapTimeMs: 170
  });
  assert.deepEqual(attributes, {
    'relai.plan.kind': 'validation',
    'relai.plan.total_steps': 4,
    'relai.plan.parallel_groups': 1,
    'relai.plan.max_concurrent_steps': 3,
    'relai.plan.wall_time_ms': 120,
    'relai.plan.accumulated_step_time_ms': 290,
    'relai.plan.overlap_time_ms': 170
  });
  
  console.log('Execution observability tests passed.');
}
await case_execution_observability_unit();

// Formerly execution-plan-unit.mjs
async function case_execution_plan_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:perf_hooks");
    const { performance } = __m1;
  
    const __m2 = await import("../src/executionPlan.js");
    const { parallel, runPlan, sequence, step } = __m2;
  
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  
  let active = 0;
  let observedMax = 0;
  const started = performance.now();
  const parallelResult = await runPlan(parallel(
    [0, 1, 2, 3].map(index => step(`parallel-${index}`, async () => {
      active += 1;
      observedMax = Math.max(observedMax, active);
      await sleep(70);
      active -= 1;
      return index;
    })),
    { maxConcurrency: 2 }
  ));
  const parallelWallMs = performance.now() - started;
  assert.equal(parallelResult.ok, true);
  assert.deepEqual(parallelResult.results.map(item => item.value), [0, 1, 2, 3]);
  assert.equal(observedMax, 2, 'bounded execution should never exceed configured concurrency');
  assert.equal(parallelResult.metrics.maxConcurrentSteps, 2);
  assert.equal(parallelResult.metrics.parallelGroupCount, 1);
  assert.ok(parallelResult.metrics.overlapTimeMs > 50, `expected measurable step overlap, got ${parallelResult.metrics.overlapTimeMs}ms`);
  assert.ok(parallelWallMs < 260, `four 70ms steps at concurrency 2 should overlap, got ${parallelWallMs}ms`);
  
  const sequenceStarted = performance.now();
  const sequenceResult = await runPlan(sequence([
    step('a', () => sleep(55).then(() => 'a')),
    step('b', () => sleep(55).then(() => 'b')),
    step('c', () => sleep(55).then(() => 'c'))
  ]));
  const sequenceWallMs = performance.now() - sequenceStarted;
  assert.equal(sequenceResult.ok, true);
  assert.deepEqual(sequenceResult.results.map(item => item.value), ['a', 'b', 'c']);
  assert.ok(sequenceWallMs >= 140, `sequence should preserve ordering, got ${sequenceWallMs}ms`);
  
  let shouldNotRun = false;
  const failed = await runPlan(sequence([
    step('fails-by-value', async () => ({ ok: false }), { isSuccess: value => value.ok }),
    step('blocked', async () => { shouldNotRun = true; })
  ]));
  assert.equal(failed.ok, false);
  assert.equal(failed.results.length, 1);
  assert.equal(shouldNotRun, false, 'sequence should stop scheduling after a failed step by default');
  
  const controller = new AbortController();
  controller.abort(new Error('cancelled for test'));
  const cancelled = await runPlan(parallel([
    step('cancelled-a', async () => 'a'),
    step('cancelled-b', async () => 'b')
  ]), { signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.results.length, 0, 'already-aborted parallel groups should not start work');
  
  console.log('Execution plan unit tests passed.');
}
await case_execution_plan_unit();

// Formerly execution-planner-unit.mjs
async function case_execution_planner_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { execSync } = __m4;
  
    const __m5 = await import("../src/executionPlanner.js");
    const { planEdit } = __m5;
  
    const __m6 = await import("../src/editLimits.js");
    const { MAX_BATCH_EDITS, MAX_BATCH_REPLACEMENTS, MAX_BATCH_INPUT_BYTES, MAX_BATCH_SNAPSHOT_BYTES } = __m6;
  
  for (const [name, value] of Object.entries({ MAX_BATCH_EDITS, MAX_BATCH_REPLACEMENTS, MAX_BATCH_INPUT_BYTES, MAX_BATCH_SNAPSHOT_BYTES })) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must remain a positive finite bound`);
  }
  
  function gitShell(command, options = {}) {
    return execSync(command, options);
  }
  
  function makeTempRepo(filename = 'hello.js', content = 'module.exports = {};') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-ep-'));
    gitShell('git init', { cwd: dir, stdio: 'pipe' });
    gitShell('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    gitShell('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    fs.mkdirSync(path.dirname(path.join(dir, filename)), { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content);
    gitShell('git add .', { cwd: dir, stdio: 'pipe' });
    gitShell('git commit -m "init"', { cwd: dir, stdio: 'pipe' });
    return dir;
  }
  
  // 1. replace path
  {
    const dir = makeTempRepo('foo.js', 'const x = 1;');
    const workspace = { alias: 'test', path: dir };
    const config = {};
    try {
      const result = await planEdit(workspace, config, { path: 'foo.js', oldText: 'const x = 1;', newText: 'const x = 2;' });
      assert.equal(result.plannerPath, 'replace', 'replace path: plannerPath must be replace');
      assert.ok(result.plannerReason, 'replace path: plannerReason must be present');
      assert.ok('ok' in result, 'replace path: result must have ok field');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 2. write path (direct)
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    const config = {};
    try {
      const result = await planEdit(workspace, config, { path: 'new.js', content: 'module.exports = {};' });
      assert.equal(result.plannerPath, 'write', 'write path: plannerPath must be write');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 3. staged write threshold
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    const config = {};
    try {
      const result = await planEdit(workspace, config, { path: 'big.js', content: 'x'.repeat(8001) });
      assert.equal(result.plannerPath, 'write:staged', 'staged write: plannerPath must be write:staged');
      const written = fs.readFileSync(path.join(dir, 'big.js'), 'utf8');
      assert.equal(written.length, 8001, 'staged: file must be written to disk');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 4. apply-update path
  {
    const dir = makeTempRepo('foo.js', 'const a = 1;\n');
    const workspace = { alias: 'test', path: dir };
    const config = {};
    try {
      const patch = `--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n`;
      const result = await planEdit(workspace, config, { updateText: patch });
      assert.equal(result.plannerPath, 'apply-update', 'apply-update path: plannerPath must be apply-update');
      assert.equal(result.diff, undefined, 'apply-update path: diff must only be returned when explicitly requested');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 5. ambiguous error
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    const config = {};
    try {
      await assert.rejects(
        () => planEdit(workspace, config, { path: 'x.js', oldText: 'a', content: 'b' }),
        (err) => {
          assert.ok(err.message.includes('ambiguous'), `ambiguous error: message must contain 'ambiguous', got: ${err.message}`);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 6. no-intent error
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    const config = {};
    try {
      await assert.rejects(
        () => planEdit(workspace, config, { path: 'x.js' }),
        (err) => {
          assert.ok(err.message.includes('must provide one of'), `no-intent error: message must contain 'must provide one of', got: ${err.message}`);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 7. oldText without newText → validation error
  {
    const dir = makeTempRepo('foo.js', 'const x = 1;\n');
    const workspace = { alias: 'test', path: dir };
    try {
      await planEdit(workspace, {}, { path: 'foo.js', oldText: 'const x = 1;' });
      assert.fail('should have thrown for missing newText');
    } catch (err) {
      assert.ok(err.message.includes('newText'), 'missing-newtext: error must mention newText');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 8. batch edits (T3): several edits in one call after atomic preflight
  {
    const dir = makeTempRepo('a.js', 'let a = 1;\n');
    fs.writeFileSync(path.join(dir, 'b.js'), 'let b = 1;\n');
    gitShell('git add . && git commit -m more', { cwd: dir, stdio: 'pipe' });
    const workspace = { alias: 'test', path: dir };
    try {
      const result = await planEdit(workspace, {}, { edits: [
        { path: 'a.js', oldText: 'let a = 1;', newText: 'let a = 2;' },
        { path: 'b.js', content: 'let b = 99;\n' }
      ] });
      assert.equal(result.plannerPath, 'batch', 'batch: plannerPath must be batch');
      assert.equal(result.ok, true, 'batch: all edits should succeed');
      assert.equal(result.editCount, 2, 'batch: two edits reported');
      assert.equal(result.preflightAtomic, true, 'batch: preflightAtomic flag must be true');
      assert.equal(result.rollbackAtomic, true, 'batch: rollback support must be active');
      assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').replaceAll('\r\n', '\n'), 'let a = 2;\n', 'batch: replace applied');
      assert.equal(fs.readFileSync(path.join(dir, 'b.js'), 'utf8').replaceAll('\r\n', '\n'), 'let b = 99;\n', 'batch: write applied');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 9. batch atomicity: one bad edit fails preflight and no earlier edit is written
  {
    const dir = makeTempRepo('a.js', 'let a = 1;\n');
    const workspace = { alias: 'test', path: dir };
    try {
      const result = await planEdit(workspace, {}, { edits: [
        { path: 'a.js', oldText: 'let a = 1;', newText: 'let a = 2;' },
        { path: 'a.js', oldText: 'NOT PRESENT', newText: 'x' }
      ] });
      assert.equal(result.ok, false, 'batch: overall ok false when one edit fails');
      assert.equal(result.preflightAtomic, true, 'batch: preflightAtomic flag must be true');
      assert.equal(result.rollbackAtomic, true, 'batch: preflight refusal is atomic');
      assert.equal(result.appliedCount, 0, 'batch: no edit should be applied after preflight failure');
      assert.equal(result.results.length, 2, 'batch: both preflight results present');
      assert.ok(result.results.some((r) => r.ok === false), 'batch: a failure is reported');
      assert.match(result.error, /Atomic batch preflight failed.*No files were changed.*connector remains available/s, 'batch: preflight failure must preserve its cause and distinguish it from connector availability');
      assert.match(result.next, /Re-read a\.js.*Do not treat this edit failure as a connector disconnect/s, 'batch: failure must provide a safe retry path');
      assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').replaceAll('\r\n', '\n'), 'let a = 1;\n', 'batch: failed preflight leaves original file unchanged');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 10. batch runtime rollback: a later write failure restores earlier applied files.
  {
    const dir = makeTempRepo('a.js', 'let a = 1;\n');
    const workspace = { alias: 'test', path: dir };
    try {
      const result = await planEdit(workspace, {}, { edits: [
        { path: 'a.js', oldText: 'let a = 1;', newText: 'let a = 2;' },
        { path: 'a.js', oldText: 'let a = 1;', newText: 'let a = 3;' }
      ] });
      assert.equal(result.ok, false);
      assert.equal(result.rollbackAtomic, true);
      assert.equal(result.rollback?.ok, true);
      assert.equal(result.appliedCount, 0);
      assert.match(result.error, /Atomic batch application failed.*No files were changed.*connector remains available/s);
      assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').replaceAll('\r\n', '\n'), 'let a = 1;\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 11. runChecks + returnDiff post-actions in one call
  {
    const dir = makeTempRepo('foo.js', 'const x = 1;\n');
    const workspace = { alias: 'test', path: dir };
    try {
      const result = await planEdit(workspace, {}, { path: 'foo.js', oldText: 'const x = 1;', newText: 'const x = 2;', returnDiff: true });
      assert.ok(result.diff, 'post-actions: returnDiff attaches a diff');
      assert.ok(String(result.diff.diff || '').includes('const x = 2'), 'post-actions: diff reflects the edit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 12. patch returnDiff is owned by the planner, not the patch primitive
  {
    const dir = makeTempRepo('foo.js', 'const a = 1;\n');
    const workspace = { alias: 'test', path: dir };
    try {
      const patch = `--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n`;
      const result = await planEdit(workspace, {}, { updateText: patch, returnDiff: true });
      assert.ok(result.diff, 'patch post-actions: returnDiff attaches one review result');
      assert.match(String(result.diff.diff || ''), /const a = 2/, 'patch post-actions: diff reflects the edit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 13. staged patch (T4): start/append/commit applies the joined diff
  {
    const dir = makeTempRepo('foo.js', 'const a = 1;\n');
    const workspace = { alias: 'test', path: dir };
    const config = { stateDir: path.join(dir, '.state') };
    try {
      const patch = `--- a/foo.js\n+++ b/foo.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n`;
      const mid = Math.floor(patch.length / 2);
      const start = await planEdit(workspace, config, { stage: 'start', updateText: patch.slice(0, mid) });
      assert.ok(start.writeId, 'staged patch: start returns writeId');
      await planEdit(workspace, config, { stage: 'append', writeId: start.writeId, updateText: patch.slice(mid) });
      const commit = await planEdit(workspace, config, { stage: 'commit', writeId: start.writeId });
      assert.equal(commit.plannerPath, 'apply-update:staged', 'staged patch: commit routes to staged apply-update');
      assert.equal(fs.readFileSync(path.join(dir, 'foo.js'), 'utf8').replaceAll('\r\n', '\n'), 'const a = 2;\n', 'staged patch: diff applied on commit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 14. large batch dry-run must not create files, journals, or staged payloads.
  {
    const dir = makeTempRepo();
    const stateDir = path.join(dir, '.state');
    const workspace = { alias: 'test', path: dir };
    const config = { stateDir };
    try {
      const result = await planEdit(workspace, config, {
        dryRun: true,
        edits: [{ path: 'large.txt', content: `${'line\n'.repeat(2000)}` }]
      });
      assert.equal(result.ok, true);
      assert.equal(result.appliedCount, 0);
      assert.equal(fs.existsSync(path.join(dir, 'large.txt')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'write-staging')), false);
      assert.equal(fs.existsSync(path.join(stateDir, 'operation-journal')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 15. dry-run returnDiff must never return unrelated live-workspace changes.
  {
    const dir = makeTempRepo('foo.js', 'const x = 1;\n');
    const workspace = { alias: 'test', path: dir };
    try {
      fs.writeFileSync(path.join(dir, 'ambient.txt'), 'unrelated dirty file\n');
      const result = await planEdit(workspace, {}, {
        path: 'foo.js',
        oldText: 'const x = 1;',
        newText: 'const x = 2;',
        dryRun: true,
        returnDiff: true
      });
      assert.equal(result.ok, true);
      assert.equal(result.changed, true, 'dry-run still reports whether the proposed edit would change content');
      assert.deepEqual(result.changedFiles, [], 'dry-run must not report files as actually changed');
      assert.equal(result.diff, undefined, 'dry-run must not attach the current workspace diff as if it were the proposed edit');
      assert.equal(fs.readFileSync(path.join(dir, 'foo.js'), 'utf8'), 'const x = 1;\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 16. structured batches accept 100 edits and compact their response details.
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    try {
      const edits = Array.from({ length: MAX_BATCH_EDITS }, (_, index) => ({
        path: `batch/file-${index}.txt`,
        content: `value-${index}\n`
      }));
      const result = await planEdit(workspace, {}, { edits });
      assert.equal(result.ok, true);
      assert.equal(result.editCount, MAX_BATCH_EDITS);
      assert.equal(result.appliedCount, MAX_BATCH_EDITS);
      assert.equal(result.resultDetailsCompacted, true);
      assert.equal(result.results.length, MAX_BATCH_EDITS);
      assert.equal(fs.readFileSync(path.join(dir, 'batch', 'file-0.txt'), 'utf8'), 'value-0\n');
      const lastIndex = MAX_BATCH_EDITS - 1;
      assert.equal(fs.readFileSync(path.join(dir, 'batch', `file-${lastIndex}.txt`), 'utf8'), `value-${lastIndex}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 16. runtime enforcement rejects more than 100 structured edits before mutation.
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    try {
      const edits = Array.from({ length: MAX_BATCH_EDITS + 1 }, (_, index) => ({
        path: `too-many-${index}.txt`,
        content: 'x'
      }));
      await assert.rejects(
        () => planEdit(workspace, {}, { edits }),
        new RegExp(`at most ${MAX_BATCH_EDITS} structured batch edits`)
      );
      assert.equal(fs.existsSync(path.join(dir, 'too-many-0.txt')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 17. aggregate replacement operations are bounded across the whole batch.
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    try {
      const edits = Array.from({ length: 11 }, (_, editIndex) => ({
        path: `replace-${editIndex}.txt`,
        replacements: Array.from(
          { length: editIndex === 10 ? 1 : 50 },
          (_, replacementIndex) => ({ oldText: `old-${replacementIndex}`, newText: `new-${replacementIndex}` })
        )
      }));
      await assert.rejects(
        () => planEdit(workspace, {}, { edits }),
        new RegExp(`at most ${MAX_BATCH_REPLACEMENTS} total replacement operations`)
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 18. aggregate structured batch payloads are capped below the HTTP body limit.
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    try {
      await assert.rejects(
        () => planEdit(workspace, {}, {
          edits: [{ path: 'oversized.txt', content: 'x'.repeat(MAX_BATCH_INPUT_BYTES) }]
        }),
        new RegExp(`max is ${MAX_BATCH_INPUT_BYTES}`)
      );
      assert.equal(fs.existsSync(path.join(dir, 'oversized.txt')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  // 19. rollback snapshot size is checked before preflight reads a large target.
  {
    const dir = makeTempRepo();
    const workspace = { alias: 'test', path: dir };
    const target = path.join(dir, 'large-existing.txt');
    try {
      fs.writeFileSync(target, '');
      fs.truncateSync(target, MAX_BATCH_SNAPSHOT_BYTES + 1);
      await assert.rejects(
        () => planEdit(workspace, {}, { edits: [{ path: 'large-existing.txt', content: 'replacement\n' }] }),
        new RegExp(`max is ${MAX_BATCH_SNAPSHOT_BYTES}`)
      );
      assert.equal(fs.statSync(target).size, MAX_BATCH_SNAPSHOT_BYTES + 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  
  console.log('execution-planner unit tests passed.');
}
await case_execution_planner_unit();

// Formerly process-discovery-guidance-unit.mjs
async function case_process_discovery_guidance_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools/schema.js");
    const { getPublicToolSchemas, getToolSurfaceManifest } = __m1;
  
  const processTool = getPublicToolSchemas().find(tool => tool.name === 'relai_process');
  assert.ok(processTool, 'relai_process must be present in the public MCP contract');
  assert.match(processTool.description, /direct executable \+ argv.*command string/i);
  assert.match(processTool.description, /one-shot work belongs in relai_exec or relai_validate/i);
  
  const properties = processTool.inputSchema?.properties || {};
  for (const field of ['command', 'executable', 'argv', 'input']) {
    assert.ok(properties[field], `relai_process public input schema must expose ${field}`);
  }
  assert.equal(processTool.inputSchema?.oneOf, undefined, 'relai_process must expose a flat connector input schema');
  
  const processManifest = getToolSurfaceManifest().tools.find(tool => tool.name === 'relai_process');
  assert.ok(processManifest, 'relai_process execution metadata must be present');
  const startAction = processManifest.actions?.find(action => action.action === 'start');
  assert.ok(startAction, 'relai_process start execution metadata must be present');
  assert.deepEqual(startAction.required, ['kind', 'purpose'], 'work_id is optional attribution for managed process startup');
  for (const field of ['command', 'executable', 'argv', 'input', 'reuseExisting']) {
    assert.ok(startAction.fields.includes(field), `relai_process start must expose ${field}`);
  }
  assert.equal(startAction.taskSupport, 'forbidden');
  assert.equal(startAction.executionClass, 'persistent_process');
  
  console.log('Managed-process direct startup discovery guidance passed.');
}
await case_process_discovery_guidance_unit();

// Formerly process-environment-unit.mjs
async function case_process_environment_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:path");
    const path = __m1.default;
  
    const __m2 = await import("../src/processEnvironment.js");
    const { makeProcessEnvironment, normalizeAllowedKeys } = __m2;
  
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/test',
    GITHUB_TOKEN: 'secret',
    AWS_SECRET_ACCESS_KEY: 'secret',
    CUSTOM_SAFE: 'kept only when allowed',
    NODE_OPTIONS: '--inspect'
  };
  
  const safe = makeProcessEnvironment({}, { source });
  if (process.platform === 'win32') {
    assert.equal(safe.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
    assert.ok(safe.PATH.split(path.delimiter).includes('/usr/bin'));
  } else {
    assert.equal(safe.PATH, '/usr/bin');
  }
  assert.equal(safe.HOME, '/home/test');
  assert.equal(safe.REL_AI_MCP, '1');
  assert.equal(safe.GITHUB_TOKEN, undefined);
  assert.equal(safe.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(safe.CUSTOM_SAFE, undefined);
  assert.equal(safe.NODE_OPTIONS, undefined);
  
  const managedBin = path.resolve('/relai/extensions/.bin');
  const withManagedBin = makeProcessEnvironment({}, { source, pathAppend: [managedBin, managedBin] });
  assert.equal(withManagedBin.PATH.split(path.delimiter).at(-1), managedBin);
  assert.equal(withManagedBin.PATH.split(path.delimiter).filter(entry => path.resolve(entry) === managedBin).length, 1);
  
  const allowed = makeProcessEnvironment({}, { source, allow: ['CUSTOM_SAFE', 'GITHUB_TOKEN'] });
  assert.equal(allowed.CUSTOM_SAFE, 'kept only when allowed');
  assert.equal(allowed.GITHUB_TOKEN, 'secret');
  
  const explicit = makeProcessEnvironment({ API_TOKEN: 'explicit' }, { source });
  assert.equal(explicit.API_TOKEN, 'explicit');
  assert.throws(() => makeProcessEnvironment({ NODE_OPTIONS: '--inspect' }, { source }), /cannot be passed/);
  assert.deepEqual(normalizeAllowedKeys('ONE, TWO THREE'), ['ONE', 'TWO', 'THREE']);
  
  console.log('process environment policy passed');
}
await case_process_environment_unit();

// Formerly validation-plan-unit.mjs
async function case_validation_plan_unit() {
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
    const { createValidationPlan, readValidationPlan } = __m5;
  
    const __m6 = await import("../src/bridge/validation.js");
    const { relaiVerify } = __m6;
  
    const __m7 = await import("../src/repository/intelligence/service.js");
    const { repositoryIntelligence } = __m7;
  
  const validationPlanSource = fs.readFileSync(new URL('../src/bridge/validationPlan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(validationPlanSource, /gitDigest|indexHash|worktreeHash/, 'validation fingerprints must not hash whole-worktree Git state');
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-plan-'));
  const stateDir = path.join(root, 'state');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init');
  git('config', 'user.email', 'relai@example.test');
  git('config', 'user.name', 'RelAI Test');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { check: 'node --check src/app.js', test: 'node test/app.test.js' } }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(root, 'test', 'app.test.js'), "require('../src/app')();\n");
  git('add', '.');
  git('commit', '-m', 'fixture');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = () => 2;\n');
  for (let index = 0; index < 30; index += 1) {
    const ambient = path.join(root, 'ambient', `file-${index}.txt`);
    fs.mkdirSync(path.dirname(ambient), { recursive: true });
    fs.writeFileSync(ambient, `ambient-${index}\n`);
  }
  const workspace = { alias: 'app', path: root, testCommands: {}, commands: {} };
  const config = { stateDir };
  
  try {
    const plan = await createValidationPlan(workspace, config, { changedFiles: ['src/app.js'] });
    assert.equal(plan.ok, true);
    assert.match(plan.planId, /^vplan_/);
    assert.deepEqual(plan.changedFiles, ['src/app.js']);
    assert.equal(plan.validationScope.includes('src/app.js'), true);
    assert.equal(plan.validationScope.includes('package.json'), true);
    assert.equal(plan.validationScope.some(file => file.startsWith('ambient/')), false);
    assert.equal(plan.recommended, 'focused');
    assert.ok(plan.checks.quick.length > 0);
    const loaded = readValidationPlan(config, plan.planId, workspace);
    assert.equal(loaded.signature, plan.signature);
  
    fs.writeFileSync(path.join(root, 'ambient', 'file-0.txt'), 'external change\n');
    const afterUnrelatedChange = await relaiVerify(workspace, config, { planId: plan.planId, planLevel: 'quick' });
    assert.equal(afterUnrelatedChange.ok, true, 'unrelated workspace changes must not stale a task-scoped validation plan');
  
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = () => 3;\n');
    await assert.rejects(
      () => relaiVerify(workspace, config, { planId: plan.planId, planLevel: 'quick' }),
      /stale because relevant workspace content changed/i
    );
  
    const file = path.join(stateDir, 'validation-plans', `${plan.planId}.json`);
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
    tampered.recommended = 'release';
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2));
    assert.throws(() => readValidationPlan(config, plan.planId, workspace), /signature is invalid/);
  } finally {
    repositoryIntelligence.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Signed validation-plan creation and tamper detection tests passed.');
}
await case_validation_plan_unit();

// Formerly validation-strategy-unit.mjs
async function case_validation_strategy_unit() {
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
  
    const __m5 = await import("../src/validationStrategy.js");
    const { classifyFiles, selectValidationLevel } = __m5;
  
    const __m6 = await import("./helpers/git-executable.mjs");
    const { GIT_EXECUTABLE } = __m6;
  
  const classificationCases = [
    { name: 'no changes', files: [], level: 'focused', boundary: 'file', risk: 'low', reason: /no changed files/ },
    { name: 'single documentation file', files: ['README.md'], level: 'minimal', boundary: 'file', risk: 'low', reason: /file boundary with low risk/ },
    { name: 'single source file', files: ['src/foo.js'], level: 'focused', boundary: 'package', risk: 'medium', reason: /package boundary with medium risk/ },
    { name: 'package manifest', files: ['package.json'], level: 'broad', boundary: 'repository', risk: 'high', reason: /repository boundary with high risk/ },
    { name: 'CI workflow', files: ['.github/workflows/ci.yml'], level: 'extended', boundary: 'release', risk: 'high' },
    { name: 'server source', files: ['src/server.js'], level: 'focused', boundary: 'package', risk: 'medium' },
    { name: 'UI source', files: ['src/ui/foo.js'], level: 'focused', boundary: 'package', risk: 'medium' },
    { name: 'HTML source', files: ['index.html'], level: 'focused', boundary: 'file', risk: 'medium' },
    { name: 'CSS source', files: ['styles.css'], level: 'focused', boundary: 'file', risk: 'medium' },
    { name: 'six files across two directories', files: ['a/1.js', 'a/2.js', 'a/3.js', 'b/1.js', 'b/2.js', 'b/3.js'], level: 'broad', boundary: 'repository', risk: 'medium' },
    { name: 'five files across two directories', files: ['a/1.js', 'a/2.js', 'a/3.js', 'b/1.js', 'b/2.js'], level: 'broad', boundary: 'repository', risk: 'medium' },
    { name: 'six files in one directory', files: ['a/1.js', 'a/2.js', 'a/3.js', 'a/4.js', 'a/5.js', 'a/6.js'], level: 'focused', boundary: 'package', risk: 'medium' },
    { name: 'configuration change raises risk', files: ['src/foo.js', 'config.json'], level: 'broad', boundary: 'package', risk: 'high' },
    { name: 'mixed root and package source', files: ['src/foo.js', 'index.html'], level: 'focused', boundary: 'package', risk: 'medium' },
    {
      name: 'custom path rule',
      files: ['src/payments/api.js'],
      config: { validationRules: { customRules: [{ level: 'broad', pattern: 'src/payments/', reason: 'payments touched' }] } },
      level: 'broad',
      reason: /payments touched/
    },
    {
      name: 'custom rule overrides default',
      files: ['package.json'],
      config: { validationRules: { customRules: [{ level: 'broad', pattern: 'package.json', reason: 'manifest policy' }] } },
      level: 'broad',
      reason: /manifest policy/
    },
    {
      name: 'non-matching custom rule falls through',
      files: ['package.json'],
      config: { validationRules: { customRules: [{ level: 'broad', pattern: 'src/payments/' }] } },
      level: 'broad',
      boundary: 'repository',
      risk: 'high'
    },
    {
      name: 'invalid custom level is ignored',
      files: ['src/foo.js'],
      config: { validationRules: { customRules: [{ level: 'invalid', pattern: 'src/' }] } },
      level: 'focused',
      boundary: 'package',
      risk: 'medium'
    }
  ];
  
  for (const testCase of classificationCases) {
    const result = classifyFiles(testCase.files, testCase.config);
    assert.equal(result.level, testCase.level, `${testCase.name}: ${result.reason}`);
    if (testCase.boundary) assert.equal(result.boundary, testCase.boundary, `${testCase.name} boundary`);
    if (testCase.risk) assert.equal(result.risk, testCase.risk, `${testCase.name} risk`);
    if (testCase.reason) assert.match(result.reason, testCase.reason, testCase.name);
  }
  
  assert.deepEqual(selectValidationLevel(os.tmpdir(), {}, 'extended'), {
    level: 'extended',
    reason: 'caller-specified',
    changedFiles: []
  });
  
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-vs-nogit-'));
  try {
    const result = selectValidationLevel(nonGit, {}, null);
    assert.equal(result.level, 'focused');
    assert.match(result.reason, /unavailable/);
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
  
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-vs-repo-'));
  try {
    git(['init'], repo);
    git(['config', 'user.email', 'test@test.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    fs.writeFileSync(path.join(repo, 'initial.txt'), 'init');
    git(['add', '.'], repo);
    git(['commit', '-m', 'init'], repo);
  
    assertDetected('package.json', '{}', 'broad', { stage: true });
    assertDetected('src/ui/dashboard.js', 'export default {};', 'focused');
    assertDetected('CHANGELOG.md', '# changes', 'extended');
  
    resetRepo();
    for (const file of ['a/1.js', 'a/2.js', 'a/3.js', 'b/1.js', 'b/2.js', 'b/3.js']) write(file, 'x');
    assert.equal(selectValidationLevel(repo, {}, null).level, 'focused');
    const taskScoped = selectValidationLevel(repo, {}, null, ['src/task-owned.js']);
    assert.equal(taskScoped.level, 'focused');
    assert.equal(taskScoped.reason, 'package boundary with medium risk');
    assert.deepEqual(taskScoped.changedFiles, ['src/task-owned.js']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
  
  function assertDetected(relativePath, content, expectedLevel, options = {}) {
    resetRepo();
    write(relativePath, content);
    if (options.stage) git(['add', relativePath], repo);
    const result = selectValidationLevel(repo, {}, null);
    assert.equal(result.level, expectedLevel, `${relativePath}: ${result.reason}`);
  }
  
  function write(relativePath, content) {
    const target = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  
  function resetRepo() {
    git(['reset', '--hard', 'HEAD'], repo);
    git(['clean', '-fd'], repo);
  }
  
  function git(args, cwd) {
    execFileSync(GIT_EXECUTABLE, args, { cwd, stdio: 'pipe' });
  }
  
  console.log(`Validation strategy tests passed across ${classificationCases.length} classification cases and Git integration coverage.`);
}
await case_validation_strategy_unit();
