import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { runProcess, isProcessTreeAlive, terminateProcessTree } from '../src/process.ts';
import { assertNoRecoveredMutationProcess } from '../src/tools/execution.js';
import {
  listMutationProcessRecords,
  markCurrentMutationProcessUncertain,
  recordCurrentMutationProcess,
  removeMutationProcessRecord,
  runWithMutationProcessOwnership
} from '../src/mutationProcessOwnership.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-mutation-process-ownership-'));
const config = { stateDir: path.join(root, 'state') };
const workspace = 'repo';

try {
  const result = await runWithMutationProcessOwnership(config, workspace, () => runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("done")'],
    { timeout: 10_000 },
    config
  ));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(listMutationProcessRecords(config, workspace), [], 'settled mutation subprocesses must clear durable ownership');

  const child = await import('node:child_process').then(({ spawn }) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  }));
  const markerModule = await import('../src/mutationProcessOwnership.js');
  await runWithMutationProcessOwnership(config, workspace, () => markerModule.recordCurrentMutationProcess(child.pid));
  const records = listMutationProcessRecords(config, workspace);
  assert.equal(records.length, 1);
  assert.equal(isProcessTreeAlive(records[0].pid), true, 'live recovered mutator must remain detectable');
  assert.throws(
    () => assertNoRecoveredMutationProcess(config, workspace),
    error => error?.code === 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN' && error?.pid === child.pid,
    'a restarted mutation lane must stay blocked while the stale mutator is still alive'
  );
  await terminateProcessTree(child, { graceMs: 0, forceWaitMs: 2000 });
  assert.equal(isProcessTreeAlive(records[0].pid), false);
  assert.throws(() => assertNoRecoveredMutationProcess(config, workspace),
    error => error?.code === 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN',
    'root death does not settle an active recovery record');
  removeMutationProcessRecord(records[0]); // The fixture explicitly terminated its own entire tree.

  // Reuse the exited fixture PID: unlike a random PID, its death is proven.
  // Load a fresh module instance to verify the flag survives runtime memory.
  await runWithMutationProcessOwnership(config, workspace, () => {
    recordCurrentMutationProcess(child.pid);
    assert.equal(markCurrentMutationProcessUncertain(child.pid, 'Fixture root exited while descendant termination was unconfirmed.'), true);
  });
  const reloaded = await import(`../src/mutationProcessOwnership.js?recovery-fixture=${Date.now()}`);
  const uncertain = reloaded.listMutationProcessRecords(config, workspace);
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].terminationUncertain, true);
  assert.match(uncertain[0].terminationUncertaintyReason, /unconfirmed/);
  assert.equal(isProcessTreeAlive(child.pid), false);
  assert.throws(
    () => assertNoRecoveredMutationProcess(config, workspace),
    error => error?.code === 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN'
      && error.retryable === false && error.pid === child.pid,
    'recovery must keep the mutation lane blocked when only the root is known to have exited'
  );
  assert.equal(fs.existsSync(uncertain[0].file), true, 'recovery must never delete explicit uncertainty on root-only evidence');
  assert.equal(reloaded.listMutationProcessRecords(config, workspace)[0].terminationUncertain, true);
  // Fixture cleanup only: operators must separately prove descendants stopped.
  removeMutationProcessRecord(uncertain[0]);

  await runWithMutationProcessOwnership(config, workspace, () => {
    const file = recordCurrentMutationProcess(child.pid);
    const before = fs.readFileSync(file, 'utf8');
    const originalMkdir = fs.mkdirSync;
    fs.mkdirSync = function(directory, ...args) {
      if (String(directory) === path.dirname(file)) {
        throw Object.assign(new Error('Injected ownership persistence failure.'), { code: 'ENOSPC' });
      }
      return originalMkdir.call(fs, directory, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => markCurrentMutationProcessUncertain(child.pid, 'Fixture uncertainty'),
        error => error?.code === 'MUTATION_TERMINATION_UNCERTAINTY_PERSIST_FAILED'
          && error.terminationConfirmed === false && /restart recovery cannot verify/i.test(error.message)
      );
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'failed uncertainty persistence must leave original ownership intact');
    } finally {
      fs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    }
  });
  const failedPersistenceRecords = listMutationProcessRecords(config, workspace);
  assert.equal(failedPersistenceRecords.length, 1, 'a failed uncertainty update must never clear original ownership');
  removeMutationProcessRecord(failedPersistenceRecords[0]); // Isolated fixture cleanup, not automatic recovery.
  await runWithMutationProcessOwnership(config, workspace, () => recordCurrentMutationProcess(child.pid));
  const legacy = listMutationProcessRecords(config, workspace)[0];
  const legacyData = JSON.parse(fs.readFileSync(legacy.file, 'utf8'));
  legacyData.schemaVersion = 1;
  delete legacyData.phase;
  delete legacyData.terminationUncertain;
  fs.writeFileSync(legacy.file, JSON.stringify(legacyData));
  assert.throws(() => assertNoRecoveredMutationProcess(config, workspace),
    error => error?.code === 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN',
    'legacy records without settled tree evidence must stay blocked');
  removeMutationProcessRecord(legacy);

  for (const failAt of [1, 2]) {
    const originalMkdir = fs.mkdirSync;
    const originalSpawn = childProcess.spawn;
    let writes = 0;
    let spawns = 0;
    let fixturePid = 0;
    fs.mkdirSync = function(directory, ...args) {
      if (String(directory).includes('active-mutations') && ++writes === failAt) {
        throw Object.assign(new Error('Injected initial ownership disk failure'), { code: 'ENOSPC' });
      }
      return originalMkdir.call(this, directory, ...args);
    };
    childProcess.spawn = function(command, args, options) {
      const spawned = originalSpawn.call(this, command, args, options);
      const requestFlag = process.platform === 'win32' ? args?.indexOf('-RequestPath') : -1;
      const nativeRequest = requestFlag >= 0 ? args[requestFlag + 1] : '';
      const relative = nativeRequest ? path.relative(config.stateDir, nativeRequest) : '';
      const ownedController = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        && JSON.parse(fs.readFileSync(nativeRequest, 'utf8')).executable === process.execPath;
      if (command === process.execPath || ownedController) { spawns++; fixturePid = spawned.pid; }
      return spawned;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(runWithMutationProcessOwnership(config, workspace, () => runProcess(
        process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 10000 }, config
      )), error => failAt === 1
        ? error.code === 'DURABLE_STATE_WRITE_FAILED' && error.details?.fsCode === 'ENOSPC'
        : error.code === 'PROCESS_SETUP_FAILED' && error.executed === true && error.terminationConfirmed === true);
      assert.equal(spawns, failAt === 1 ? 0 : 1, 'durable intent failure must happen before spawn');
      if (fixturePid) assert.equal(isProcessTreeAlive(fixturePid), false, 'post-spawn persistence failure must settle its fixture child');
      assert.deepEqual(listMutationProcessRecords(config, workspace), []);
      if (process.platform === 'win32' && failAt === 2) {
        assert.deepEqual(fs.readdirSync(path.join(config.stateDir, 'process-jobs')), [],
          'confirmed native cleanup removes the failed-start job directory');
      }
    } finally {
      fs.mkdirSync = originalMkdir;
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  }

  // Seeded records only: no process is launched or signalled for identity tests.
  {
    const rootA = path.join(root, 'authority-a');
    const rootB = path.join(root, 'authority-b');
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    const scoped = { stateDir: path.join(root, 'authority-state'), workspaces: { aliasA: { path: rootA } } };
    const file = runWithMutationProcessOwnership(scoped, 'aliasA', () => recordCurrentMutationProcess(424242));
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(original.schemaVersion, 3);
    assert.equal(original.authorityStatus, 'bound');
    fs.mkdirSync(path.join(rootA, '.git'));
    assert.equal(listMutationProcessRecords(scoped, 'aliasA')[0].file, file,
      'non-Git ownership remains discoverable after git init creates repository metadata');
    fs.rmdirSync(path.join(rootA, '.git'));
    scoped.workspaces.aliasA.path = rootB;
    scoped.workspaces.aliasC = { path: rootA };
    const reloadedAuthority = await import('../src/mutationProcessOwnership.js?authority-reload=' + Date.now());
    assert.deepEqual(reloadedAuthority.listMutationProcessRecords(scoped, 'aliasA'), [], 'retargeted alias must not inherit old physical ownership');
    assert.equal(reloadedAuthority.listMutationProcessRecords(scoped, 'aliasC')[0].file, file, 'renamed alias finds original physical ownership after reload');
    assert.doesNotThrow(() => assertNoRecoveredMutationProcess(scoped, 'aliasA'));
    assert.throws(() => assertNoRecoveredMutationProcess(scoped, 'aliasC'),
      error => error.code === 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN');
    scoped.workspaces.aliasD = { path: rootA };
    assert.equal(reloadedAuthority.listMutationProcessRecords(scoped, 'aliasD')[0].file, file);
    removeMutationProcessRecord({ file });

    // Context is captured before any later mutable config/alias change.
    scoped.workspaces.aliasA.path = rootA;
    const capturedFile = runWithMutationProcessOwnership(scoped, 'aliasA', () => {
      scoped.workspaces.aliasA.path = rootB;
      return recordCurrentMutationProcess(424243);
    });
    assert.equal(JSON.parse(fs.readFileSync(capturedFile, 'utf8')).authority, original.authority);
    assert.deepEqual(listMutationProcessRecords(scoped, 'aliasA'), []);
    assert.equal(listMutationProcessRecords(scoped, 'aliasC')[0].file, capturedFile);
    removeMutationProcessRecord({ file: capturedFile });

    // Linked-worktree metadata shares durable common-Git authority.
    const gitRoot = path.join(root, 'authority-git');
    const admin = path.join(gitRoot, '.git', 'worktrees', 'linked');
    const linked = path.join(root, 'authority-linked');
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(linked);
    fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ' + admin + '\n');
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    scoped.workspaces.gitA = { path: gitRoot };
    scoped.workspaces.gitB = { path: linked };
    const worktreeFile = runWithMutationProcessOwnership(scoped, 'gitA', () => recordCurrentMutationProcess(424244));
    assert.equal(listMutationProcessRecords(scoped, 'gitB')[0].file, worktreeFile);
    removeMutationProcessRecord({ file: worktreeFile });

    // A removed legacy alias is unbound uncertainty, never reassigned or cleared
    // from current config. Its diagnostic must not identify another alias/PID.
    const legacyRoot = path.join(scoped.stateDir, 'active-mutations');
    const legacyDir = path.join(legacyRoot, crypto.createHash('sha256').update('removed-alias').digest('hex'));
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'legacy.json');
    const legacyText = JSON.stringify({ schemaVersion: 2, runtimeId: 'fixture', workspace: 'removed-alias', pid: 424245, phase: 'active', terminationUncertain: true });
    fs.writeFileSync(legacyFile, legacyText);
    assert.equal(listMutationProcessRecords(scoped, 'aliasA')[0].legacyAuthorityUnknown, true);
    assert.throws(() => assertNoRecoveredMutationProcess(scoped, 'aliasC'), error =>
      error.code === 'WORKSPACE_MUTATION_LEGACY_AUTHORITY_UNCERTAIN'
      && !error.message.includes('removed-alias') && !error.message.includes('424245'));
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyText);
    fs.rmSync(legacyFile);

    const originalReaddir = fs.readdirSync;
    fs.readdirSync = function(directory, ...args) {
      if (path.resolve(String(directory)) === path.resolve(legacyRoot)) return Array.from({ length: 1001 }, (_, index) => ({ name: String(index) }));
      return originalReaddir.call(this, directory, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => assertNoRecoveredMutationProcess(scoped, 'aliasA'),
        error => error.code === 'WORKSPACE_MUTATION_RECOVERY_INCOMPLETE');
    } finally { fs.readdirSync = originalReaddir; syncBuiltinESMExports(); }
  }

  // Actual workspace/card/health payloads must project durable recovery without
  // confusing a legitimately active current-runtime command with a stale owner.
  {
    const { buildWorkspaceStates, onWorkspaceStateChange } = await import('../src/workspaceState.js');
    const { workspaceCardView } = await import('../src/ui/features/workspaces/model.js');
    const { healthMonitor } = await import('../src/productUx.js');
    const { clearCurrentMutationProcess } = await import('../src/mutationProcessOwnership.js');
    const { bindWorkspaceOperationIdentity, blockWorkspaceMutations } = await import('../src/workspaceOperationQueue.js');
    const folderA = path.join(root, 'projection-a'), folderB = path.join(root, 'projection-b');
    fs.mkdirSync(folderA); fs.mkdirSync(folderB);
    const uiConfig = { stateDir: path.join(root, 'projection-state'), auditLogPath: path.join(root, 'projection-audit.jsonl'),
      workspaces: { 'projection-original': { path: folderA } } };
    const alias = 'projection-original';
    const state = () => buildWorkspaceStates(uiConfig, [], { state: 'idle' })[alias];
    const healthRow = () => healthMonitor(uiConfig).workspaces.find(item => item.alias === alias);
    const events = [];
    const off = onWorkspaceStateChange(event => { if (event.alias === alias) events.push(event); });
    let liveFile;
    await runWithMutationProcessOwnership(uiConfig, alias, async () => {
      liveFile = recordCurrentMutationProcess(424247);
      const record = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
      record.startedAt = '2000-01-01T00:00:00.000Z';
      record.terminationUncertaintyReason = 'private-command --token HIDDEN-FIXTURE';
      fs.writeFileSync(liveFile, JSON.stringify(record));
      assert.equal(state().mutationBlock, null, 'even aged legitimately active ownership is not recovery-needed');
      assert.equal(healthRow().mutationBlock, null);
      await Promise.resolve();
      assert.equal(state().mutationBlock, null, 'active ownership survives an asynchronous turn');
    });
    assert.equal(state().mutationBlock.blocked, true, 'a settled scope with an uncleared record needs recovery');
    assert.equal(events.at(-1).state.mutationBlock.blocked, true, 'scope settlement publishes a live recovery delta');
    assert.equal(workspaceCardView({ alias, operational: state() }).ready, false);
    assert.equal(workspaceCardView({ alias, operational: state() }).statusLabel, 'Changes blocked');
    assert.equal(healthRow().ok, true, 'a blocked project is still an available folder');
    assert.equal(healthRow().mutationBlock.blocked, true);
    assert.ok(healthMonitor(uiConfig).findings.some(item => item.code === 'workspace_mutation_blocked'));
    assert.doesNotMatch(JSON.stringify(state().mutationBlock), /424247|HIDDEN-FIXTURE|private-command/);
    removeMutationProcessRecord({ file: liveFile });
    assert.equal(events.at(-1).state.mutationBlock, null);
    assert.equal(state().mutationBlock, null);

    // A failed marker removal is observable immediately, even inside its scope.
    await runWithMutationProcessOwnership(uiConfig, alias, async () => {
      const file = recordCurrentMutationProcess(424248);
      const originalRm = fs.rmSync;
      fs.rmSync = function(target, ...args) {
        if (String(target) === file) throw Object.assign(new Error('fixture removal denied'), { code: 'EACCES' });
        return originalRm.call(this, target, ...args);
      };
      syncBuiltinESMExports();
      try {
        assert.equal(clearCurrentMutationProcess(424248), false);
        assert.equal(state().mutationBlock.blocked, true);
      } finally { fs.rmSync = originalRm; syncBuiltinESMExports(); removeMutationProcessRecord({ file }); }
    });

    const previousRuntime = await import('../src/mutationProcessOwnership.js?ui-seed=' + Date.now());
    const recoveredFile = previousRuntime.runWithMutationProcessOwnership(uiConfig, alias,
      () => previousRuntime.recordCurrentMutationProcess(424249));
    const recovered = JSON.parse(fs.readFileSync(recoveredFile, 'utf8'));
    recovered.startedAt = '2000-01-01T00:00:00.000Z';
    fs.writeFileSync(recoveredFile, JSON.stringify(recovered));
    const freshState = await import('../src/workspaceState.js?projection-reload=' + Date.now());
    const fresh = freshState.buildWorkspaceStates(uiConfig, [], { state: 'idle' })[alias];
    assert.equal(fresh.mutationBlock.blocked, true, 'fresh payload projects an aged recovered record without a rejected write first');
    assert.equal(workspaceCardView({ alias, operational: fresh }).ready, false);
    bindWorkspaceOperationIdentity(alias, folderA);
    blockWorkspaceMutations(alias, 'fixture queue authority');
    uiConfig.workspaces[alias].path = folderB;
    uiConfig.workspaces['projection-renamed'] = { path: folderA };
    const moved = buildWorkspaceStates(uiConfig, [], { state: 'idle' });
    assert.equal(moved[alias].mutationBlock, null, 'old queue/persistent authority does not contaminate a retargeted alias');
    assert.equal(moved['projection-renamed'].mutationBlock.blocked, true);
    const movedHealth = healthMonitor(uiConfig);
    assert.equal(movedHealth.workspaces.find(item => item.alias === alias).mutationBlock, null);
    assert.equal(movedHealth.workspaces.find(item => item.alias === 'projection-renamed').mutationBlock.blocked, true);
    previousRuntime.removeMutationProcessRecord({ file: recoveredFile });

    const legacyRoot = path.join(uiConfig.stateDir, 'active-mutations');
    const legacyDirectory = path.join(legacyRoot, crypto.createHash('sha256').update('hidden-legacy-alias').digest('hex'));
    fs.mkdirSync(legacyDirectory, { recursive: true });
    const legacyFile = path.join(legacyDirectory, 'legacy.json');
    const legacyBytes = JSON.stringify({ schemaVersion: 2, workspace: 'hidden-legacy-alias', pid: 424250, phase: 'active' });
    fs.writeFileSync(legacyFile, legacyBytes);
    const legacyBlock = state().mutationBlock;
    assert.equal(legacyBlock.code, 'WORKSPACE_MUTATION_LEGACY_AUTHORITY_UNCERTAIN');
    assert.doesNotMatch(JSON.stringify(legacyBlock), /hidden-legacy-alias|424250/);
    assert.equal(fs.readFileSync(legacyFile, 'utf8'), legacyBytes, 'projection never migrates or clears legacy ownership');
    fs.rmSync(legacyFile);
    const originalReaddir = fs.readdirSync;
    fs.readdirSync = function(directory, ...args) {
      if (path.resolve(String(directory)) === path.resolve(legacyRoot)) return Array.from({ length: 1001 }, (_, index) => ({ name: String(index) }));
      return originalReaddir.call(this, directory, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.equal(state().mutationBlock.code, 'WORKSPACE_MUTATION_RECOVERY_INCOMPLETE');
      assert.equal(healthRow().mutationBlock.code, 'WORKSPACE_MUTATION_RECOVERY_INCOMPLETE');
    } finally { fs.readdirSync = originalReaddir; syncBuiltinESMExports(); }
    off();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Mutation ownership preserves explicit uncertainty across reload, retains active/legacy recovery uncertainty, and prevents or cleans up initial persistence failure.');
