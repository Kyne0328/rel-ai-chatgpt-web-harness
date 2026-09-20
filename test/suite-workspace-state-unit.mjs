// Consolidated workspace state coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly auto-session-unit.mjs
async function case_auto_session_unit() {
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
  
    const __m5 = await import("./helpers/git-executable.mjs");
    const { GIT_EXECUTABLE } = __m5;
  
  function git(args, options = {}) {
    return execFileSync(GIT_EXECUTABLE, args, options);
  }
  
    const __m6 = await import("../src/policyResolver.js");
    const { ensureSessionStarted, touchSessionPolicy, readSessionPolicy, resolvePolicy, writeSessionPolicy, SESSION_IDLE_TTL_MS } = __m6;
  
    const __m7 = await import("../src/localRepoBridge.js");
    const { relaiRead, workspaceTidyPlan } = __m7;
  
    const __m8 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m8;
  
  function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-auto-session-'));
    const workspacePath = path.join(root, 'workspace');
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'README.md'), '# Auto session\n');
    git(['init'], { cwd: workspacePath, stdio: 'ignore' });
    git(['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
    git(['config', 'user.name', 'RelAI Auto'], { cwd: workspacePath });
    git(['add', '.'], { cwd: workspacePath });
    git(['commit', '-m', 'init'], { cwd: workspacePath, stdio: 'ignore' });
    return { root, workspacePath, stateDir: path.join(root, 'state') };
  }
  
  
  // 1. ensureSessionStarted creates a session and captures the pre-write baseline.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    // A pre-existing untracked file must be fenced as baseline, not session-owned.
    fs.writeFileSync(path.join(workspacePath, 'preexisting.txt'), 'user file\n');
    const started = await ensureSessionStarted(config, 'ws', workspacePath, { taskId: 'task-baseline' });
    assert.equal(started, true, 'first call must start a session');
    const policy = resolvePolicy({ alias: 'ws', path: workspacePath }, config);
    assert.equal(policy.sessionActive, true);
    assert.equal(policy.baselineCaptured, true);
    assert.equal(policy.trusted, true);
    assert.ok(policy.baselineDirty.includes('preexisting.txt'), 'pre-existing untracked file must be in baseline');
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 2b. A new task ID must recapture ownership rather than inheriting another task.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    await ensureSessionStarted(config, 'ws', workspacePath, { taskId: 'task-a' });
    fs.writeFileSync(path.join(workspacePath, 'between-tasks.txt'), 'new baseline\n');
    const restarted = await ensureSessionStarted(config, 'ws', workspacePath, { taskId: 'task-b' });
    assert.equal(restarted, true);
    const sessionA = readSessionPolicy(config, 'ws', 'task-a');
    const sessionB = readSessionPolicy(config, 'ws', 'task-b');
    assert.equal(sessionA.taskId, 'task-a');
    assert.equal(sessionB.taskId, 'task-b');
    assert.ok(sessionB.baselineDirty.includes('between-tasks.txt'));
    assert.equal(readSessionPolicy(config, 'ws'), null, 'implicit policy lookup must reject multiple active tasks');
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 2. ensureSessionStarted is idempotent — a second call does not restart or
  //    recapture the baseline; it only refreshes the idle clock.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    const taskId = 'task-idempotent';
    await ensureSessionStarted(config, 'ws', workspacePath, { taskId });
    const first = readSessionPolicy(config, 'ws', taskId);
    // New file appears AFTER the session started — it must NOT enter the baseline.
    fs.writeFileSync(path.join(workspacePath, 'session-made.txt'), 'agent file\n');
    const startedAgain = await ensureSessionStarted(config, 'ws', workspacePath, { taskId });
    assert.equal(startedAgain, false, 'second call must not start a new session');
    const second = readSessionPolicy(config, 'ws', taskId);
    assert.equal(second.createdAt, first.createdAt, 'createdAt must be preserved');
    assert.ok(!(second.baselineDirty || []).includes('session-made.txt'), 'post-session file must not enter baseline');
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 3. Idle TTL — a session whose last activity is older than the TTL is treated as
  //    expired (readSessionPolicy returns null), so the next write recaptures.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    const taskId = 'task-expired';
    await writeSessionPolicy(config, 'ws', { workspaceRoot: workspacePath, taskId });
    const data = readSessionPolicy(config, 'ws', taskId);
    const expiredAt = Date.now() - SESSION_IDLE_TTL_MS - 1000;
    data.updatedAt = new Date(expiredAt).toISOString();
    withStateDatabase(config, db => db.prepare('UPDATE session_policies SET updated_at_ms=?,payload=? WHERE workspace=? AND task_id=?')
      .run(expiredAt, JSON.stringify(data), 'ws', taskId), { transaction: true });
    assert.equal(readSessionPolicy(config, 'ws', taskId), null, 'stale SQLite session must read as expired immediately');
    const restarted = await ensureSessionStarted(config, 'ws', workspacePath, { taskId });
    assert.equal(restarted, true, 'expired session must be restartable');
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 4. touchSessionPolicy refreshes updatedAt without touching the baseline.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    fs.writeFileSync(path.join(workspacePath, 'preexisting.txt'), 'user file\n');
    const taskId = 'task-touch';
    await writeSessionPolicy(config, 'ws', { workspaceRoot: workspacePath, taskId });
    const before = readSessionPolicy(config, 'ws', taskId);
    const oldUpdatedAtMs = Date.now() - 60_000;
    before.updatedAt = new Date(oldUpdatedAtMs).toISOString();
    withStateDatabase(config, db => db.prepare('UPDATE session_policies SET updated_at_ms=?,payload=? WHERE workspace=? AND task_id=?')
      .run(oldUpdatedAtMs, JSON.stringify(before), 'ws', taskId), { transaction: true });
    const ok = touchSessionPolicy(config, 'ws', taskId);
    assert.equal(ok, true);
    const after = readSessionPolicy(config, 'ws', taskId);
    assert.ok(Date.parse(after.updatedAt) > Date.parse(before.updatedAt), 'updatedAt must advance');
    assert.deepEqual(after.baselineDirty, before.baselineDirty, 'baseline must be untouched');
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 5. Tidy-plan safety fence — with NO session baseline, relai_changes tidy_plan refuses
  //    instead of offering pre-existing untracked files for deletion.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    fs.writeFileSync(path.join(workspacePath, 'user-untracked.txt'), 'not from any session\n');
    const plan = await workspaceTidyPlan({ alias: 'ws', path: workspacePath }, config, { mode: 'session_untracked' });
    assert.equal(plan.ok, false, 'tidy must refuse without a session baseline');
    assert.equal(plan.reason, 'no_session_baseline');
    assert.equal(plan.candidateCount, 0);
    assert.deepEqual(plan.candidates, []);
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 6. Tidy-plan WITH a session only offers session-owned untracked files, never
  //    the pre-existing baseline file.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    fs.writeFileSync(path.join(workspacePath, 'pre-existing.txt'), 'baseline\n');
    await writeSessionPolicy(config, 'ws', { workspaceRoot: workspacePath, taskId: 'task-tidy' });
    fs.writeFileSync(path.join(workspacePath, 'session-artifact.txt'), 'made during session\n');
    const plan = await workspaceTidyPlan({ alias: 'ws', path: workspacePath }, config, { mode: 'session_untracked' });
    assert.equal(plan.ok, true);
    const paths = new Set(plan.candidates.map((c) => c.path));
    assert.ok(paths.has('session-artifact.txt'), 'session file must be a candidate');
    assert.ok(!paths.has('pre-existing.txt'), 'baseline file must never be a tidy candidate');
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  // 7. Repeated reads during an active session must return cached text instead of
  //    misclassifying the cache hit as a binary file.
  {
    const { root, workspacePath, stateDir } = makeRepo();
    const config = { stateDir };
    const workspace = { alias: 'ws', path: workspacePath };
    await writeSessionPolicy(config, 'ws', { workspaceRoot: workspacePath, taskId: 'task-read' });
    const first = relaiRead(workspace, config, { paths: ['README.md'] });
    const second = relaiRead(workspace, config, { paths: ['README.md'] });
    assert.equal(first.items[0]?.content, '# Auto session\n');
    assert.equal(first.items[0]?.cacheHit, false);
    assert.equal(second.items[0]?.content, '# Auto session\n');
    assert.equal(second.items[0]?.cacheHit, true);
    assert.deepEqual(second.skipped, []);
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('auto-session unit tests passed.');
}
await case_auto_session_unit();

// Formerly baseline-tracking-unit.mjs
async function case_baseline_tracking_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("./helpers/git-executable.mjs");
    const { GIT_EXECUTABLE } = __m5;
  
  function git(args, options = {}) {
    return spawnSync(GIT_EXECUTABLE, args, options);
  }
  
    const __m6 = await import("../src/policyResolver.js");
    const { writeSessionPolicy, resolvePolicy, captureBaselineDirty, readSessionPolicy } = __m6;
  
    const __m7 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m7;
  
    const __m8 = await import("../src/taskIntegrity.ts");
    const { recordTaskIntegrityEvent } = __m8;
  
    const __m9 = await import("../src/workspaceState.js");
    const { buildWorkspaceStates } = __m9;
  
  const policyResolverSource = fs.readFileSync(new URL('../src/policyResolver.js', import.meta.url), 'utf8');
  assert.doesNotMatch(policyResolverSource, /spawnSync/, 'session baseline capture must never block the MCP event loop');
  assert.match(policyResolverSource, /await runProcess\('git'/, 'session baseline capture must use the asynchronous process runner');
    const __m10 = await import("../src/localRepoBridge.js");
    const { classifyStatusOwnership } = __m10;
  
    const __m11 = await import("../src/repo/gitOps.js");
    const { workspaceGitStatus } = __m11;
  
  function makeRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-baseline-'));
    const run = (args) => git(args, { cwd: root, encoding: 'utf8' });
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'test']);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'initial\n');
    run(['add', 'tracked.txt']);
    run(['commit', '-qm', 'init']);
    return root;
  }
  
  // 1. captureBaselineDirty returns dirty file list from real git status
  {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'pre-existing.txt'), 'dirty\n');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'modified\n');
    const baseline = await captureBaselineDirty(repo);
    assert.ok(baseline.includes('pre-existing.txt'), 'untracked file must appear in baseline');
    assert.ok(baseline.includes('tracked.txt'), 'modified tracked file must appear in baseline');
    fs.rmSync(repo, { recursive: true, force: true });
  }
  
  // 2. captureBaselineDirty returns [] for non-git dir
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-baseline-nogit-'));
    const baseline = await captureBaselineDirty(dir);
    assert.deepEqual(baseline, [], 'non-git dir must return empty array');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  
  // 3. captureBaselineDirty with null/undefined → []
  assert.deepEqual(await captureBaselineDirty(null), []);
  assert.deepEqual(await captureBaselineDirty(undefined), []);
  assert.deepEqual(await captureBaselineDirty(''), []);
  
  // 4. writeSessionPolicy persists baselineDirty and resolvePolicy exposes it
  {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'leftover.txt'), 'x\n');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-pr-'));
    const config = { stateDir };
    await writeSessionPolicy(config, 'myapp', { taskHint: 'fix bug', workspaceRoot: repo, taskId: 'task-baseline-policy' });
    const policy = resolvePolicy({ alias: 'myapp', path: repo }, config);
    assert.equal(policy.sessionActive, true);
    assert.ok(Array.isArray(policy.baselineDirty), 'baselineDirty must be array');
    assert.ok(policy.baselineDirty.includes('leftover.txt'), 'pre-existing dirty file must be in policy.baselineDirty');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  // 5. classifyStatusOwnership splits files into baseline vs. session
  {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-pr-'));
    const config = { stateDir };
    // Seed session file with baseline
    const taskId = 'task-ownership';
    await writeSessionPolicy(config, 'myapp', { taskHint: 'x', taskId });
    // Manually inject baselineDirty into the task-scoped SQLite session row.
    const data = readSessionPolicy(config, 'myapp', taskId);
    data.baselineDirty = ['old/generated.cmake', 'old/registrant.swift'];
    data.baselineCaptured = true;
    withStateDatabase(config, db => db.prepare('UPDATE session_policies SET updated_at_ms=?,payload=? WHERE workspace=? AND task_id=?')
      .run(Date.now() + 1, JSON.stringify(data), 'myapp', taskId), { transaction: true });
  
    const statusOutput = ' M old/generated.cmake\0 M old/registrant.swift\0 M lib/new_edit.dart\0?? new/untracked.dart\0';
    const workspace = { alias: 'myapp' };
    const { sessionChanged, baselineChanged, baselineSource } = classifyStatusOwnership(workspace, config, statusOutput);
    assert.deepEqual([...baselineChanged].sort((a, b) => a.localeCompare(b)), ['old/generated.cmake', 'old/registrant.swift']);
    assert.deepEqual([...sessionChanged].sort((a, b) => a.localeCompare(b)), ['lib/new_edit.dart', 'new/untracked.dart']);
    assert.equal(baselineSource, 'session');
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  // 6. classifyStatusOwnership with no session: ownership is UNKNOWN, not session.
  // Claiming session ownership without a captured baseline is a safety bug: it let
  // relai_changes tidy_plan treat pre-existing untracked user files as disposable session
  // artifacts. With no session the session-owned arrays must stay empty.
  {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-pr-'));
    const config = { stateDir };
    const workspace = { alias: 'noses' };
    const statusOutput = ' M a.txt\0 M b.txt\0?? c.txt\0';
    const { sessionChanged, baselineChanged, untrackedSession, unknownChanged, untrackedUnknown, hasSession, baselineSource } = classifyStatusOwnership(workspace, config, statusOutput);
    assert.deepEqual(sessionChanged, []);
    assert.deepEqual(untrackedSession, []);
    assert.deepEqual(baselineChanged, []);
    assert.deepEqual([...unknownChanged].sort((a, b) => a.localeCompare(b)), ['a.txt', 'b.txt', 'c.txt']);
    assert.deepEqual(untrackedUnknown, ['c.txt']);
    assert.equal(hasSession, false);
    assert.equal(baselineSource, null);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  // 7. Rename status line ("R  from -> to") classifies destination file
  {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-pr-'));
    const config = { stateDir };
    const taskId = 'task-rename';
    await writeSessionPolicy(config, 'myapp', { taskId });
    const data = readSessionPolicy(config, 'myapp', taskId);
    data.baselineDirty = ['lib/old/zone_validator.dart'];
    data.baselineCaptured = true;
    withStateDatabase(config, db => db.prepare('UPDATE session_policies SET updated_at_ms=?,payload=? WHERE workspace=? AND task_id=?')
      .run(Date.now() + 1, JSON.stringify(data), 'myapp', taskId), { transaction: true });
    const status = 'R  lib/new/schedule_validator.dart\0lib/old/zone_validator.dart\0';
    const { sessionChanged, baselineChanged } = classifyStatusOwnership({ alias: 'myapp' }, config, status);
    // Destination path is what shows in current worktree, so classify on destination
    assert.deepEqual(sessionChanged, ['lib/new/schedule_validator.dart']);
    assert.deepEqual(baselineChanged, []);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  // 8. A task touching a file that was already dirty is counted as task-touched
  // without changing baseline ownership. This keeps tidy/restore safety intact while
  // giving the workspace UI an accurate current-task edit count.
  {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'user dirty before task\n');
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-pr-'));
    const config = { stateDir, workspaces: { myapp: { path: repo } } };
    const taskId = 'task-touches-baseline';
    await writeSessionPolicy(config, 'myapp', { taskId, workspaceRoot: repo });
    await recordTaskIntegrityEvent(config, {
      ts: new Date().toISOString(), taskId, workspace: 'myapp', taskIdentityVersion: 2, tool: 'work.begin', ok: true
    });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'user dirty plus task edit\n');
    await recordTaskIntegrityEvent(config, {
      ts: new Date().toISOString(), taskId, workspace: 'myapp', taskIdentityVersion: 2, tool: 'edit', ok: true, changedFiles: ['tracked.txt']
    });
    const status = git(['status', '--short', '--branch', '-z', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).stdout;
    await writeSessionPolicy(config, 'myapp', { taskId: 'other-active-task', workspaceRoot: repo });
    const ambiguousOwnership = classifyStatusOwnership({ alias: 'myapp', path: repo }, config, status);
    assert.deepEqual(ambiguousOwnership.sessionTouched, [], 'multiple active sessions must not guess which task touched a file');
    const ownership = classifyStatusOwnership({ alias: 'myapp', path: repo }, config, status, taskId);
    assert.deepEqual(ownership.baselineChanged, ['tracked.txt'], 'pre-existing dirty content must remain baseline-owned for safety');
    assert.deepEqual(ownership.sessionChanged, [], 'baseline ownership must not be reclassified as disposable session work');
    assert.deepEqual(ownership.sessionTouched, ['tracked.txt'], 'an explicit active task must count its mutation even with concurrent sessions');
  
    await recordTaskIntegrityEvent(config, {
      ts: new Date().toISOString(), taskId: 'other-active-task', workspace: 'myapp', taskIdentityVersion: 2, tool: 'work.begin', ok: true
    });
    fs.writeFileSync(path.join(repo, 'other-task.txt'), 'owned by another task\n');
    await recordTaskIntegrityEvent(config, {
      ts: new Date().toISOString(), taskId: 'other-active-task', workspace: 'myapp', taskIdentityVersion: 2, tool: 'edit', ok: true, changedFiles: ['other-task.txt']
    });
    const scopedStatus = await workspaceGitStatus({ alias: 'myapp', path: repo }, config, { work_id: taskId });
    assert.deepEqual(scopedStatus.sessionChangedFiles, ['tracked.txt'], 'work-scoped repository status must not absorb concurrent edits from another task');
  
    const activity = { tasks: [{ id: taskId, workspace: 'myapp', state: 'working', status: 'planning' }] };
    let workspaceState = buildWorkspaceStates(config, [], activity).myapp;
    const deadline = Date.now() + 3000;
    while (workspaceState.sessionChangedFileCount !== 1 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      workspaceState = buildWorkspaceStates(config, [], activity).myapp;
    }
    assert.equal(workspaceState.sessionChangedFileCount, 1, 'workspace UI state must count the active task mutation even when the file began dirty');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  // 9. Exact work_id ownership survives loss/expiry of the short-lived session policy.
  // The task-integrity ledger is the durable authority for which dirty paths belong to
  // a resumable task; the policy file is only needed to classify ambient baseline work.
  {
    const repo = makeRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-pr-'));
    const config = { stateDir, workspaces: { myapp: { path: repo } } };
    const taskId = 'task-durable-ownership';
    await recordTaskIntegrityEvent(config, {
      ts: new Date().toISOString(), taskId, workspace: 'myapp', taskIdentityVersion: 2, tool: 'work.begin', ok: true
    });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'durable task mutation\n');
    await recordTaskIntegrityEvent(config, {
      ts: new Date().toISOString(), taskId, workspace: 'myapp', taskIdentityVersion: 2, tool: 'edit', ok: true, changedFiles: ['tracked.txt']
    });
  
    const status = git(['status', '--short', '--branch', '-z', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).stdout;
    const ownership = classifyStatusOwnership({ alias: 'myapp', path: repo }, config, status, taskId);
    assert.equal(ownership.hasSession, false, 'the fixture intentionally has no live policy file');
    assert.equal(ownership.baselineSource, null, 'missing policy must keep ambient baseline ownership conservative');
    assert.deepEqual(ownership.sessionTouched, ['tracked.txt'], 'explicit task ownership must come from durable task integrity even without a policy file');
  
    const scopedStatus = await workspaceGitStatus({ alias: 'myapp', path: repo }, config, { work_id: taskId });
    assert.deepEqual(scopedStatus.sessionChangedFiles, ['tracked.txt'], 'resumed task status must keep showing its durable changed files after policy expiry/loss');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  console.log('baseline-tracking unit tests passed.');
}
await case_baseline_tracking_unit();

// Formerly durable-state-unit.mjs
async function case_durable_state_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:url");
    const { fileURLToPath, pathToFileURL } = __m4;
  
    const __m5 = await import("../src/durableState.ts");
    const { DurableStateError, readJsonFile, readJsonFileAsync, writeJsonAtomic, writeJsonAtomicAsync } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-durable-state-'));
  const file = path.join(root, 'state.json');
  
  try {
    // Load from outside the checkout so local node_modules cannot hide packaging omissions.
    const repo = fileURLToPath(new URL('../', import.meta.url));
    const packaged = path.join(root, 'resources');
    fs.mkdirSync(path.join(packaged, 'src'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'src/durableState.ts'), path.join(packaged, 'src/durableState.ts'));
    fs.writeFileSync(path.join(packaged, 'package.json'), '{"type":"module"}');
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'electron/package.json'), 'utf8'));
    const filters = manifest.build.extraResources.find(resource => resource.to === 'node_modules').filter;
    for (const name of ['write-file-atomic', 'signal-exit']) {
      const source = path.join(repo, 'node_modules', name);
      fs.cpSync(source, path.join(packaged, 'node_modules', name), {
        recursive: true,
        filter: candidate => {
          if (fs.statSync(candidate).isDirectory()) return true;
          const relative = path.relative(path.join(repo, 'node_modules'), candidate).replaceAll('\\', '/');
          return filters.some(pattern => !pattern.startsWith('!') && path.matchesGlob(relative, pattern))
            && !filters.some(pattern => pattern.startsWith('!') && path.matchesGlob(relative, pattern.slice(1)));
        }
      });
    }
    const packagedState = await import(pathToFileURL(path.join(packaged, 'src/durableState.ts')).href);
    const packagedFile = path.join(packaged, 'state.json');
    packagedState.writeJsonAtomic(packagedFile, { revision: 1 });
    assert.deepEqual(packagedState.readJsonFile(packagedFile), { revision: 1 });
    await packagedState.writeJsonAtomicAsync(packagedFile, { revision: 2 });
    assert.deepEqual(await packagedState.readJsonFileAsync(packagedFile), { revision: 2 });
  
    writeJsonAtomic(file, { revision: 1, value: 'first' }, { backup: true });
    assert.deepEqual(readJsonFile(file), { revision: 1, value: 'first' });
  
    writeJsonAtomic(file, { revision: 2, value: 'second' }, { backup: true });
    assert.deepEqual(readJsonFile(file), { revision: 2, value: 'second' });
    assert.deepEqual(readJsonFile(`${file}.bak`), { revision: 1, value: 'first' });
  
    const concurrentFile = path.join(root, 'concurrent.json');
    writeJsonAtomic(concurrentFile, { revision: 0 }, { backup: true });
    await Promise.all([
      writeJsonAtomicAsync(concurrentFile, { revision: 1 }, { backup: true, durable: false }),
      writeJsonAtomicAsync(concurrentFile, { revision: 2 }, { backup: true, durable: false })
    ]);
    assert.deepEqual(readJsonFile(concurrentFile), { revision: 2 });
    assert.deepEqual(
      readJsonFile(`${concurrentFile}.bak`),
      { revision: 1 },
      'concurrent saves must serialize the backup+primary transaction so the backup is the immediately previous revision'
    );
  
    fs.writeFileSync(file, '{truncated', 'utf8');
    let recovery = null;
    const recovered = readJsonFile(file, {
      backup: true,
      onRecovery: details => { recovery = details; }
    });
    assert.deepEqual(recovered, { revision: 1, value: 'first' });
    assert.equal(recovery.reason, 'malformed_json');
    assert.deepEqual(readJsonFile(file), recovered, 'backup recovery must restore the primary record');
  
    await writeJsonAtomicAsync(file, { revision: 3, value: 'async' }, { backup: true, durable: false });
    assert.deepEqual(readJsonFile(file), { revision: 3, value: 'async' });
    assert.deepEqual(await readJsonFileAsync(file), { revision: 3, value: 'async' });
    assert.deepEqual(readJsonFile(`${file}.bak`), recovered, 'async atomic writes must preserve the previous record when backup is requested');
  
    fs.writeFileSync(file, '{}', 'utf8');
    assert.throws(
      () => readJsonFile(file, { validate: value => Number.isInteger(value.revision) }),
      error => error instanceof DurableStateError && error.code === 'DURABLE_STATE_READ_FAILED'
    );
  
    assert.deepEqual(
      fs.readdirSync(root).filter(name => /\.(?:tmp|old)$/.test(name)),
      [],
      'atomic state writes must not leave temporary promotion artifacts'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Durable state atomic write, backup recovery, validation, and cleanup tests passed.');
}
await case_durable_state_unit();

// Formerly git-status-porcelain-unit.mjs
async function case_git_status_porcelain_unit() {
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
  
    const __m5 = await import("../src/repo/gitOps.js");
    const { workspaceGitStatus } = __m5;
  
    const __m6 = await import("../src/bridge/review.js");
    const { relaiDiff } = __m6;
  
    const __m7 = await import("../src/policyResolver.js");
    const { writeSessionPolicy, captureBaselineDirty } = __m7;
  
    const __m8 = await import("./helpers/git-executable.mjs");
    const { GIT_EXECUTABLE } = __m8;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-status-z-'));
  const stateDir = path.join(root, '.state');
  const workspace = { alias: 'repo', path: root };
  const config = { stateDir };
  const git = (args) => execFileSync(GIT_EXECUTABLE, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Rel AI Status Test']);
    fs.writeFileSync(path.join(root, 'space file.txt'), 'space base\n');
    fs.writeFileSync(path.join(root, 'café.txt'), 'unicode base\n');
    fs.writeFileSync(path.join(root, 'old name.txt'), 'rename base\n');
    git(['add', '.']);
    git(['commit', '-qm', 'base']);
  
    await writeSessionPolicy(config, workspace.alias, { workspaceRoot: root, taskId: 'task-status' });
    fs.appendFileSync(path.join(root, 'space file.txt'), 'space changed\n');
    fs.appendFileSync(path.join(root, 'café.txt'), 'unicode changed\n');
    git(['mv', 'old name.txt', 'new café name.txt']);
    fs.writeFileSync(path.join(root, 'untracked café file.txt'), 'untracked\n');
  
    const status = await workspaceGitStatus(workspace, config);
    assert.equal(status.ok, true);
    const paths = new Set(status.statusEntries.map((entry) => entry.path));
    for (const expected of ['space file.txt', 'café.txt', 'new café name.txt', 'untracked café file.txt']) {
      assert.ok(paths.has(expected), `status must preserve exact path: ${expected}`);
      assert.match(status.status, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    const rename = status.statusEntries.find((entry) => entry.path === 'new café name.txt');
    assert.equal(rename.originalPath, 'old name.txt');
  
    const review = await relaiDiff(workspace, config, {});
    assert.match(review.diff, /space changed/);
    assert.match(review.diff, /unicode changed/);
    assert.ok(review.statusEntries.some((entry) => entry.path === 'café.txt'));
    assert.ok(review.statusEntries.some((entry) => entry.path === 'space file.txt'));
  
    const baseline = await captureBaselineDirty(root);
    assert.ok(baseline.includes('café.txt'));
    assert.ok(baseline.includes('space file.txt'));
    assert.ok(baseline.includes('new café name.txt'));
    assert.ok(baseline.includes('untracked café file.txt'));
  
    console.log('NUL-delimited Git status preserves quoted and non-ASCII paths.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_git_status_porcelain_unit();

// Formerly journal-unit.mjs
async function case_journal_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:assert/strict");
    const assert = __m3.default;
  
    const __m4 = await import("../src/journal.js");
    const { appendOperation, readRecentOperations, summarizeOperations } = __m4;
  
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-journal-'));
  const config = { stateDir: path.join(tmp, 'state') };
  const workspace = { alias: 'app', path: path.join(tmp, 'repo') };
  fs.mkdirSync(workspace.path, { recursive: true });
  
  try {
    const journal = summarizeOperations(config, workspace, 1).path;
    fs.mkdirSync(path.dirname(journal), { recursive: true });
  
    const old = [
      { id: 'old-1', type: 'old-1' },
      { id: 'old-2', type: 'old-2' }
    ].map(item => `${JSON.stringify(item)}\n`).join('');
    fs.writeFileSync(`${journal}.1`, old, 'utf8');
    fs.writeFileSync(journal, `${JSON.stringify({ id: 'new-1', type: 'new-1' })}\n`, 'utf8');
    assert.deepEqual(
      readRecentOperations(config, workspace, 3).map(item => item.id),
      ['old-1', 'old-2', 'new-1'],
      'recent reads should span the one retained rotation without reading older history'
    );
  
    fs.rmSync(`${journal}.1`, { force: true });
    fs.writeFileSync(journal, Buffer.alloc(8 * 1024 * 1024, 0x20));
    appendOperation(config, workspace, { type: 'after-rotation', ok: true });
    assert.equal(fs.existsSync(`${journal}.1`), true, 'oversized journal rotates before the next append');
    const recent = readRecentOperations(config, workspace, 1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].type, 'after-rotation');
    assert.ok(fs.statSync(journal).size < 1024 * 1024, 'active journal stays bounded after rotation');
  
    console.log('Operation journal bounded tail/rotation tests passed.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await case_journal_unit();

// Formerly persistence-contract-unit.mjs
async function case_persistence_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/durableState.ts");
    const { DurableStateError } = __m4;
  
    const __m5 = await import("../src/mcp/connectionGenerations.js");
    const { resolveConnectionGenerations } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-persistence-contract-'));
  const generationFile = path.join(root, 'connection-generations.json');
  const generationOptions = {
    file: generationFile,
    key: Buffer.from('contract-key'),
    token: 'token-a',
    host: '127.0.0.1',
    port: 3333
  };
  
  try {
    const first = resolveConnectionGenerations({}, generationOptions);
    assert.deepEqual(first, { credentialGeneration: 1, configurationGeneration: 1 });
    const firstSource = fs.readFileSync(generationFile, 'utf8');
    const stable = resolveConnectionGenerations({}, generationOptions);
    assert.deepEqual(stable, first);
    assert.equal(fs.readFileSync(generationFile, 'utf8'), firstSource, 'unchanged generation state avoids a rewrite');
    assert.doesNotMatch(firstSource, /token-a/);
  
    fs.writeFileSync(`${generationFile}.interrupted.tmp`, '{partial', 'utf8');
    assert.deepEqual(resolveConnectionGenerations({}, generationOptions), stable);
  
    const changedOptions = { ...generationOptions, token: 'token-b' };
    const changed = resolveConnectionGenerations({}, changedOptions);
    assert.deepEqual(changed, { credentialGeneration: 2, configurationGeneration: 1 });
    const backupBeforeRecovery = JSON.parse(fs.readFileSync(`${generationFile}.bak`, 'utf8'));
    assert.equal(backupBeforeRecovery.credentialGeneration, 1);
  
    fs.writeFileSync(generationFile, '{malformed', 'utf8');
    assert.deepEqual(resolveConnectionGenerations({}, changedOptions), changed, 'malformed primary must recover the prior valid generation and preserve increment rules');
    assert.deepEqual(JSON.parse(fs.readFileSync(generationFile, 'utf8')).credentialGeneration, 2);
  
    fs.writeFileSync(generationFile, '{malformed', 'utf8');
    fs.writeFileSync(`${generationFile}.bak`, '{also-malformed', 'utf8');
    assert.throws(
      () => resolveConnectionGenerations({}, changedOptions),
      error => error instanceof DurableStateError
        && error.code === 'DURABLE_STATE_READ_FAILED'
        && error.details.path === path.resolve(generationFile)
        && error.details.reason === 'malformed_json'
        && error.details.backupAttempted === true
        && error.details.backupReason === 'malformed_json'
    );
  
    fs.writeFileSync(generationFile, JSON.stringify({ version: 999, credentialGeneration: 'invalid' }), 'utf8');
    fs.rmSync(`${generationFile}.bak`, { force: true });
    assert.throws(
      () => resolveConnectionGenerations({}, generationOptions),
      error => error instanceof DurableStateError
        && error.details.reason === 'validation_failed'
        && error.details.backupReason === 'missing'
    );
  
    if (process.platform !== 'win32') assert.equal(fs.statSync(generationFile).mode & 0o777, 0o600);
  
    const blockedParent = path.join(root, 'blocked-parent');
    fs.writeFileSync(blockedParent, 'not a directory', 'utf8');
    const blockedFile = path.join(blockedParent, 'state.json');
    assert.throws(
      () => resolveConnectionGenerations({}, { ...generationOptions, file: blockedFile }),
      error => error instanceof DurableStateError
        && error.code === 'DURABLE_STATE_WRITE_FAILED'
        && error.details.path === path.resolve(blockedFile)
        && Boolean(error.details.fsCode)
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Connection-generation persistence failure contracts passed.');
}
await case_persistence_contract_unit();

// Formerly policy-resolver-cache-unit.mjs
async function case_policy_resolver_cache_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/policyResolver.js");
    const { clearSessionPolicy,
    ensureSessionStarted,
    readSessionPolicy,
    touchSessionPolicy,
    writeSessionPolicy,
    SESSION_TOUCH_PERSIST_INTERVAL_MS } = __m4;
  
    const __m5 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-policy-store-'));
  const config = { stateDir: path.join(root, 'state') };
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  
  try {
    const alias = 'app';
    const taskId = 'task-1';
    await writeSessionPolicy(config, alias, { workspaceRoot, taskId, taskHint: 'store test' });
    const before = withStateDatabase(config, db => db.prepare('SELECT updated_at_ms,payload FROM session_policies WHERE workspace=? AND task_id=?').get(alias, taskId));
  
    assert.equal(touchSessionPolicy(config, alias, taskId), true);
    const afterHotTouch = withStateDatabase(config, db => db.prepare('SELECT updated_at_ms,payload FROM session_policies WHERE workspace=? AND task_id=?').get(alias, taskId));
    assert.deepEqual(afterHotTouch, before, 'hot-path touches must not rewrite SQLite inside the persistence interval');
    assert.equal(readSessionPolicy(config, alias, taskId)?.taskHint, 'store test');
    assert.equal(await ensureSessionStarted(config, alias, workspaceRoot, { taskId, taskHint: 'ignored' }), false);
  
    const externallyEdited = JSON.parse(before.payload);
    externallyEdited.taskHint = 'external edit';
    withStateDatabase(config, db => db.prepare('UPDATE session_policies SET updated_at_ms=?,payload=? WHERE workspace=? AND task_id=?')
      .run(Date.now() + 1, JSON.stringify(externallyEdited), alias, taskId), { transaction: true });
    assert.equal(readSessionPolicy(config, alias, taskId)?.taskHint, 'external edit', 'SQLite reads must observe external durable updates immediately');
  
    assert.equal(clearSessionPolicy(config, alias, taskId).cleared, true);
    assert.equal(readSessionPolicy(config, alias, taskId), null);
  
    const oldTaskId = 'task-old';
    const oldUpdatedAtMs = Date.now() - SESSION_TOUCH_PERSIST_INTERVAL_MS - 5_000;
    const oldUpdatedAt = new Date(oldUpdatedAtMs).toISOString();
    const oldPolicy = { workspace: alias, taskId: oldTaskId, createdAt: oldUpdatedAt, updatedAt: oldUpdatedAt, baselineCaptured: true, baselineDirty: [] };
    withStateDatabase(config, db => db.prepare('INSERT INTO session_policies(workspace,task_id,updated_at_ms,payload) VALUES(?,?,?,?)')
      .run(alias, oldTaskId, oldUpdatedAtMs, JSON.stringify(oldPolicy)), { transaction: true });
    assert.equal(touchSessionPolicy(config, alias, oldTaskId), true);
    const persistedOldTouch = readSessionPolicy(config, alias, oldTaskId);
    assert.ok(Date.parse(persistedOldTouch.updatedAt) > oldUpdatedAtMs);
    clearSessionPolicy(config, alias, oldTaskId);
  
    console.log('Session policy SQLite visibility and persistence-throttle tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_policy_resolver_cache_unit();

// Formerly policy-resolver-unit.mjs
async function case_policy_resolver_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/policyResolver.js");
    const { resolvePolicy, writeSessionPolicy, clearSessionPolicy, readSessionPolicy } = __m4;
  
    const __m5 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m5;
  
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-policy-'));
  const config = { stateDir };
  const alias = 'myapp';
  const taskId = 'task-policy';
  
  try {
    for (const workspace of [{ alias, path: stateDir }, alias, null, {}]) {
      clearSessionPolicy(config, alias, taskId);
      const policy = resolvePolicy(workspace, config);
      assert.equal(policy.sessionActive, false);
      assert.equal(policy.source, 'default');
      assert.equal(policy.trusted, true);
    }
  
    await assert.rejects(() => writeSessionPolicy(config, alias, { taskHint: 'missing identity' }), /taskId/);
  
    await writeSessionPolicy(config, alias, { taskHint: 'fix auth bug', taskId });
    const session = readSessionPolicy(config, alias, taskId);
    assert.equal(session.workspace, alias);
    assert.equal(session.taskId, taskId);
    assert.equal(session.taskHint, 'fix auth bug');
    assert.match(session.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  
    const active = resolvePolicy({ alias, path: stateDir }, config);
    assert.equal(active.trusted, false);
    assert.equal(active.sessionActive, true);
    assert.equal(active.baselineCaptured, false);
    assert.equal(active.taskHint, 'fix auth bug');
    assert.equal(active.source, 'task_session_store');
  
    clearSessionPolicy(config, alias, taskId);
    await writeSessionPolicy(config, alias, { workspaceRoot: path.join(stateDir, 'missing-workspace'), taskId });
    const failedBaseline = resolvePolicy({ alias }, config);
    assert.equal(failedBaseline.sessionActive, true);
    assert.equal(failedBaseline.baselineCaptured, false);
    assert.equal(failedBaseline.trusted, false);
    assert.ok(failedBaseline.baselineCaptureError);
  
    assert.equal(clearSessionPolicy(config, alias, taskId).cleared, true);
    assert.equal(resolvePolicy({ alias }, config).sessionActive, false);
    assert.equal(clearSessionPolicy(config, alias, taskId).cleared, false);
    assert.equal(clearSessionPolicy(config, alias).cleared, false);
  
    for (const payload of ['NOT JSON', '[1,2,3]', '{}', '42', '"sneaky"', 'null']) {
      withStateDatabase(config, db => db.prepare(`INSERT INTO session_policies(workspace,task_id,updated_at_ms,payload) VALUES(?,?,?,?)
        ON CONFLICT(workspace,task_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`).run(alias, taskId, Date.now(), payload), { transaction: true });
      assert.equal(readSessionPolicy(config, alias, taskId), null, `invalid session payload must be rejected: ${payload}`);
      assert.equal(resolvePolicy({ alias }, config).sessionActive, false);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  console.log('Policy resolver tests passed with SQLite-backed task-scoped sessions and malformed-state rejection.');
}
await case_policy_resolver_unit();

// Formerly request-state-key-unit.mjs
async function case_request_state_key_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/mcp/context.js");
    const { requestStateKey } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-request-state-key-'));
  const config = { stateDir: root };
  const file = path.join(root, 'request-state.key');
  
  try {
    const generated = requestStateKey(config);
    assert.ok(Buffer.byteLength(generated, 'utf8') >= 32);
    assert.equal(requestStateKey(config), generated, 'request-state signing identity must survive repeated reads');
  
    fs.writeFileSync(file, 'truncated', 'utf8');
    const recovered = requestStateKey(config);
    assert.notEqual(recovered, 'truncated');
    assert.ok(Buffer.byteLength(recovered, 'utf8') >= 32);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), recovered);
    assert.deepEqual(
      fs.readdirSync(root).filter(name => /\.(?:tmp|old)$/.test(name)),
      [],
      'request-state key replacement must not leave promotion artifacts'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Request-state signing key durability and truncated-key recovery tests passed.');
}
await case_request_state_key_unit();

// Formerly state-backup-unit.mjs
async function case_state_backup_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/productUx.js");
    const { stateExport, stateImport } = __m4;
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-state-backup-'));
  const sourceDir = path.join(temp, 'source');
  const restoredDir = path.join(temp, 'restored');
  fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'root-state.json'), '{"root":true}\n');
  fs.writeFileSync(path.join(sourceDir, 'nested', 'child.txt'), 'nested-state\n');
  const largeState = Buffer.alloc(1024 * 1024 + 4096, 0xff);
  fs.writeFileSync(path.join(sourceDir, 'durable-state.sqlite'), largeState);
  
  try {
    const exported = stateExport({ stateDir: sourceDir }).export;
    assert.equal(exported.version, 2);
    assert.ok(exported.files.some(item => item.path === 'root-state.json'), 'root-level state files must be exported');
    const exportedSqlite = exported.files.find(item => item.path === 'durable-state.sqlite');
    assert.equal(exportedSqlite?.encoding, 'base64', 'large binary state must be exported instead of silently omitted');
  
    const imported = stateImport({ stateDir: restoredDir }, { confirm: true, payload: exported });
    assert.equal(imported.ok, true);
    assert.equal(fs.readFileSync(path.join(restoredDir, 'root-state.json'), 'utf8'), '{"root":true}\n');
    assert.deepEqual(fs.readFileSync(path.join(restoredDir, 'durable-state.sqlite')), largeState);
  
    fs.writeFileSync(path.join(restoredDir, 'root-state.json'), 'original\n');
    const invalidPayload = {
      version: 2,
      files: [
        { path: 'root-state.json', content: 'replacement\n' },
        { path: 'nested/bad.bin', encoding: 'base64', content: 'not-valid-base64!' }
      ]
    };
    assert.throws(() => stateImport({ stateDir: restoredDir }, { confirm: true, payload: invalidPayload }), /Invalid base64/);
    assert.equal(fs.readFileSync(path.join(restoredDir, 'root-state.json'), 'utf8'), 'original\n', 'failed imports must leave the existing state untouched');
  
    assert.throws(
      () => stateImport({ stateDir: restoredDir }, { confirm: true, payload: { version: 999, files: [{ path: 'root-state.json', content: 'future\n' }] } }),
      /Unsupported state import version/
    );
    assert.equal(fs.readFileSync(path.join(restoredDir, 'root-state.json'), 'utf8'), 'original\n');
  
    assert.throws(
      () => stateExport({ stateDir: sourceDir }, { maxFileBytes: 1024 * 1024 }),
      /exceeds the maximum size/,
      'an explicit export size limit must fail closed instead of producing an incomplete backup'
    );
  
    console.log('State backup export/import regression tests passed.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
await case_state_backup_unit();

// Formerly workspace-multi-source-runtime-unit.mjs
async function case_workspace_multi_source_runtime_unit() {
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
  
    const __m5 = await import("../src/bridge/search.js");
    const { relaiSearch } = __m5;
  
    const __m6 = await import("../src/repository/intelligence/queryWorkerClient.js");
    const { repositoryQueryWorkerStats } = __m6;
  
    const __m7 = await import("../src/repository/intelligence/service.js");
    const { repositoryIntelligence } = __m7;
  
    const __m8 = await import("../src/repository/intelligence/database.js");
    const { repositoryIndexPath } = __m8;
  
    const __m9 = await import("../src/workspaceSources.js");
    const { sourceWorkspace, workspaceSourceEntries } = __m9;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-multi-source-'));
  const primary = path.join(root, 'primary');
  const secondary = path.join(root, 'secondary');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(primary, 'src'), { recursive: true });
  fs.mkdirSync(path.join(secondary, 'src'), { recursive: true });
  fs.writeFileSync(path.join(primary, 'src', 'primary.js'), "export const primaryMarker = 'primary-only-marker';\n");
  fs.writeFileSync(path.join(secondary, 'src', 'secondary.js'), [
    "export function secondaryMarker() {",
    "  return 'secondary-only-marker connection recovery';",
    "}",
    ''
  ].join('\n'));
  
  const workspace = {
    alias: 'multi-source',
    path: primary,
    sourcePaths: [primary, secondary],
    context: {},
    commands: {},
    testCommands: {}
  };
  const config = { stateDir };
  
  try {
    const snapshot = await repoSnapshot(workspace, config, { includeFiles: true });
    assert.ok(snapshot.files.includes('src/primary.js'));
    assert.ok(snapshot.files.includes('source:2/src/secondary.js'), 'snapshot must expose secondary roots with an unambiguous virtual prefix');
  
    const read = await relaiReadAsync(workspace, config, {
      paths: ['source:2/src/secondary.js'], guidanceMode: 'compact'
    }, { connector: true });
    assert.equal(read.ok, true);
    assert.equal(read.items[0].path, 'source:2/src/secondary.js');
    assert.match(read.items[0].content, /secondary-only-marker/);
    assert.match(read.items[0].writeHint, /read-only context/i);
  
    const directory = await relaiReadAsync(workspace, config, {
      paths: ['source:2'], guidanceMode: 'none'
    }, { connector: true });
    assert.equal(directory.items[0].type, 'directory');
    assert.ok(directory.items[0].files.includes('source:2/src/secondary.js'));
  
    const lexical = await relaiSearch(workspace, config, {
      pattern: 'secondary-only-marker', fixed: true, mode: 'context', maxResults: 10
    });
    assert.equal(lexical.matchCount, 1);
    assert.equal(lexical.matches[0].path, 'source:2/src/secondary.js');
    assert.equal(lexical.files[0].path, 'source:2/src/secondary.js');
  
    const semantic = await repositoryIntelligence.semanticSearch(workspace, config, {
      query: 'secondary connection recovery marker', maxResults: 10, maxBytes: 32000
    }, { watch: false });
    assert.ok(semantic.results.some(item => item.path === 'source:2/src/secondary.js'),
      'semantic search must fan out across attached source roots');
    assert.equal(Array.isArray(semantic.retrieval?.sources), true,
      'multi-source semantic search must preserve per-source retrieval degradation metadata');
    assert.ok(repositoryQueryWorkerStats().liveWorkerCount <= 4,
      'attached source roots must share the global query worker budget');
  
    const symbol = await repositoryIntelligence.codeInspect(workspace, config, {
      action: 'symbol', symbol: 'secondaryMarker', maxResults: 20
    }, { watch: false });
    assert.ok(symbol.definitions.some(item => item.path === 'source:2/src/secondary.js'),
      'structural symbol lookup must retain the secondary source identity');
  
    const architecture = await repositoryIntelligence.architecture(workspace, config, { maxResults: 20 }, { watch: false });
    assert.equal(architecture.architecture.strategy, 'multi-source-bounded-file-graph');
    assert.ok(architecture.entryPoints.every(item => !path.isAbsolute(item.path)), 'multi-source architecture must return virtual repository paths, not host paths');
  
    const sourceWorkspaces = workspaceSourceEntries(workspace).map(source => sourceWorkspace(workspace, source));
    for (const scopedWorkspace of sourceWorkspaces) {
      await repositoryIntelligence.ensure(scopedWorkspace, config);
      assert.equal(repositoryIntelligence.status(scopedWorkspace, config).watching, true,
        'attached source roots must have a live watcher after normal intelligence startup');
      assert.equal(fs.existsSync(path.dirname(repositoryIndexPath(config, scopedWorkspace))), true);
    }
    const disposed = await repositoryIntelligence.dispose(workspace, config, { removeCache: true });
    assert.equal(disposed.ok, true);
    for (const scopedWorkspace of sourceWorkspaces) {
      assert.equal(repositoryIntelligence.status(scopedWorkspace, config).watching, false,
        'workspace disposal must detach every source-root watcher');
      assert.equal(fs.existsSync(path.dirname(repositoryIndexPath(config, scopedWorkspace))), false,
        'delete-style disposal must remove the source-root intelligence cache');
    }
  } finally {
    await repositoryIntelligence.shutdown();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  
  console.log('Multi-source snapshot, read, lexical search, semantic search, structural inspect, and architecture paths passed.');
}
await case_workspace_multi_source_runtime_unit();

// Formerly workspace-state-unit.mjs
async function case_workspace_state_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("../src/workspaceState.js");
    const { buildWorkspaceStates, onWorkspaceStateChange, resolveGitExecutable } = __m5;
  
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workspace-state-'));
  const repo = path.join(sandbox, 'repo');
  fs.mkdirSync(repo);
  
  function git(args) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  
  try {
    const trustedGit = resolveGitExecutable();
    assert.ok(path.isAbsolute(trustedGit), 'workspace state must use an absolute trusted Git executable');
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'RelAI Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'initial']);
    git(['remote', 'add', 'origin', 'https://example.com/repo.git']);
    fs.appendFileSync(path.join(repo, 'README.md'), 'changed\n');
  
    const config = {
      stateDir: path.join(sandbox, 'state'),
      workspaces: { repo: { path: repo } }
    };
    const tasks = [{ workspace: 'repo', status: 'completed', validation: 'passed', completedAt: '2026-07-11T06:00:00.000Z' }];
    const activity = { state: 'working', workspace: 'repo', tool: 'relai_read', startedAt: Date.now() };
    let unsubscribe = () => {};
    const refreshedState = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error('workspace Git state refresh timed out'));
      }, 5000);
      unsubscribe = onWorkspaceStateChange(event => {
        if (event.alias !== 'repo') return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event.state);
      });
    });
    buildWorkspaceStates(config, tasks, activity);
    await refreshedState;
    const states = buildWorkspaceStates(config, tasks, activity);
    const state = states.repo;
    assert.equal(state.exists, true);
    assert.equal(state.isGit, true);
    assert.equal(state.dirty, true);
    assert.equal(state.changedFileCount, 1);
    assert.equal(state.remoteAvailable, true);
    assert.deepEqual(state.remotes, ['origin']);
    assert.ok(state.branch);
    assert.equal(state.lastValidation.status, 'passed');
    assert.equal(state.currentActivity.state, 'working');
  
    const refreshed = buildWorkspaceStates(config, tasks, { state: 'working', workspace: 'repo', tool: 'relai_edit', startedAt: Date.now() });
    assert.equal(refreshed.repo.currentActivity.tool, 'relai_edit', 'dynamic activity must not be frozen by the Git-state cache');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  
  console.log('Operational workspace state tests passed.');
}
await case_workspace_state_unit();

// Formerly workspace-tidy-unit.mjs
async function case_workspace_tidy_unit() {
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
  
    const __m5 = await import("../src/localRepoBridge.js");
    const { workspaceTidyPlan, workspaceTidyRun } = __m5;
  
    const __m6 = await import("../src/policyResolver.js");
    const { writeSessionPolicy } = __m6;
  
    const __m7 = await import("./helpers/git-executable.mjs");
    const { GIT_EXECUTABLE } = __m7;
  
  function git(args, cwd) {
    execFileSync(GIT_EXECUTABLE, args, { cwd, stdio: 'pipe' });
  }
  
  function makeTempRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tidy-'));
    git(['init'], dir);
    git(['config', 'user.email', 'test@test.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    fs.writeFileSync(path.join(dir, 'initial.txt'), 'init');
    git(['add', '.'], dir);
    git(['commit', '-m', 'init'], dir);
    return dir;
  }
  
  // 1. Plan discovers session-owned untracked files and run tidies them by planId.
  {
    const dir = makeTempRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tidy-state-'));
    const workspace = { alias: 'test', path: dir };
    const config = { stateDir };
    const workId = 'task-tidy-1';
    try {
      await writeSessionPolicy(config, workspace.alias, { workspaceRoot: dir, taskId: workId });
      const artifact = path.join(dir, 'generated.svg');
      fs.writeFileSync(artifact, '<svg></svg>');
  
      const plan = await workspaceTidyPlan(workspace, config, { work_id: workId });
      assert.equal(plan.ok, true);
      assert.equal(plan.mode, 'session_untracked');
      assert.equal(plan.candidateCount, 1);
      assert.equal(plan.candidates[0].path, 'generated.svg');
  
      const result = await workspaceTidyRun(workspace, config, { work_id: workId, planId: plan.planId });
      assert.equal(result.ok, true);
      assert.equal(result.appliedCount, 1);
      assert.equal(fs.existsSync(artifact), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
  
  // 2. Plan run refuses candidates that changed after planning.
  {
    const dir = makeTempRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tidy-state-'));
    const workspace = { alias: 'test', path: dir };
    const config = { stateDir };
    const workId = 'task-tidy-2';
    try {
      await writeSessionPolicy(config, workspace.alias, { workspaceRoot: dir, taskId: workId });
      const artifact = path.join(dir, 'generated.svg');
      fs.writeFileSync(artifact, '<svg>old</svg>');
      const plan = await workspaceTidyPlan(workspace, config, { work_id: workId });
      fs.writeFileSync(artifact, '<svg>changed</svg>');
  
      const result = await workspaceTidyRun(workspace, config, { work_id: workId, planId: plan.planId });
      assert.equal(result.ok, false);
      assert.equal(result.changed, false);
      assert.match(result.refused[0].reason, /sha256 mismatch/);
      assert.equal(fs.readFileSync(artifact, 'utf8'), '<svg>changed</svg>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
  
  // 3. Explicit work_id selects the correct baseline when two tasks share a workspace.
  {
    const dir = makeTempRepo();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tidy-state-'));
    const workspace = { alias: 'test', path: dir };
    const config = { stateDir };
    try {
      await writeSessionPolicy(config, workspace.alias, { workspaceRoot: dir, taskId: 'task-a' });
      fs.writeFileSync(path.join(dir, 'from-a.tmp'), 'a');
      await writeSessionPolicy(config, workspace.alias, { workspaceRoot: dir, taskId: 'task-b' });
      fs.writeFileSync(path.join(dir, 'from-b.tmp'), 'b');
  
      const plan = await workspaceTidyPlan(workspace, config, { work_id: 'task-b' });
      assert.deepEqual(plan.candidates.map(item => item.path), ['from-b.tmp'], 'task B must not claim task A pre-existing untracked output');
      await assert.rejects(
        () => workspaceTidyRun(workspace, config, { work_id: 'task-a', planId: plan.planId }),
        /different work session/i,
        'a tidy plan must remain bound to the task whose baseline produced it'
      );
      const result = await workspaceTidyRun(workspace, config, { work_id: 'task-b', planId: plan.planId });
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(path.join(dir, 'from-a.tmp')), true);
      assert.equal(fs.existsSync(path.join(dir, 'from-b.tmp')), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
  
  console.log('workspace tidy ownership and preflight unit tests passed.');
}
await case_workspace_tidy_unit();
