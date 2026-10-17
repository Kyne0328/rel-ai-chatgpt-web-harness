import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { relaiGitCommit, completeStagedPaths } from '../src/repo/gitOps.ts';
import { beginGitIndexTransaction } from '../src/repo/gitIndexTransaction.ts';
import { executeToolCall } from '../src/tools/execution.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { buildUntrackedDiff } from '../src/bridge/reviewDiff.js';
import { cleanupTaskEphemeralDirectory, taskEphemeralDirectory, withTaskEphemeralEnvironment } from '../src/taskEphemeral.ts';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';

const complete = { executed: true, exitCode: 0, timedOut: false, stdout: 'file with spaces.txt\0', stdoutTruncated: false };
assert.deepEqual(completeStagedPaths(complete), ['file with spaces.txt']);
assert.deepEqual(completeStagedPaths({ ...complete, stdout: '' }), []);
for (const change of [{ executed: false }, { exitCode: 1 }, { timedOut: true }, { cancelled: true },
  { stdoutTruncated: true }, { stdoutSpillTruncated: true }, { terminationConfirmed: false },
  { outputFinalizationTimedOut: true }, { stdout: 'missing-nul' }]) {
  assert.throws(() => completeStagedPaths({ ...complete, ...change }), /Mandatory staged-file observation/);
}

// Filesystem observations are simulated; these regressions never create a link
// or invoke native recursive removal on a link-bearing fixture.
{
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originals = Object.fromEntries(['lstatSync', 'opendirSync', 'realpathSync', 'rmSync'].map(name => [name, fs[name]]));
  const fixtureConfig = { stateDir: path.join(os.tmpdir(), 'relai-cleanup-observation-fixture') };
  const target = taskEphemeralDirectory(fixtureConfig, 'cleanup-observation');
  const child = path.join(target, 'child');
  const directoryStat = { dev: 1, ino: 1, mode: 16832, size: 0, mtimeMs: 1, ctimeMs: 1,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
  const fileStat = { ...directoryStat, ino: 2, mode: 33152, size: 7,
    isDirectory: () => false, isFile: () => true };
  try {
    for (const scenario of ['windows', 'missing-root', 'root-link', 'ancestor-link', 'child-link', 'unknown-type', 'unsafe-identity', 'unavailable-inode', 'device-crossing', 'redirected', 'ancestor-activity', 'unreadable', 'budget', 'identity-change', 'remove-failure', 'ordinary']) {
      const removals = [];
      let childReads = 0;
      let ancestorReads = 0;
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: scenario === 'windows' ? 'win32' : 'linux' });
      fs.lstatSync = candidate => {
        const value = String(candidate);
        if (scenario === 'missing-root' && value === target) throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' });
        if (scenario === 'unavailable-inode') return { ...directoryStat, ino: 0 };
        if (scenario === 'ancestor-activity' && value !== target && value !== child) return { ...directoryStat, mtimeMs: ++ancestorReads };
        const link = (scenario === 'root-link' && value === target)
          || (scenario === 'ancestor-link' && value === path.dirname(target))
          || (scenario === 'child-link' && value === child);
        if (link) return { ...directoryStat, isSymbolicLink: () => true };
        if (scenario === 'unsafe-identity') return { ...directoryStat, ino: Number.MAX_SAFE_INTEGER + 1 };
        if (value !== child) return directoryStat;
        childReads += 1;
        if (scenario === 'device-crossing') return { ...fileStat, dev: 2 };
        if (scenario === 'unknown-type') return { ...fileStat, isFile: () => false };
        if (scenario === 'identity-change' && childReads > 1) return { ...fileStat, ino: 3 };
        return fileStat;
      };
      fs.realpathSync = candidate => path.resolve(scenario === 'redirected' && String(candidate) === child ? path.join(target, 'elsewhere') : String(candidate));
      fs.opendirSync = candidate => {
        assert.equal(String(candidate), target, 'never descend into a simulated link');
        if (scenario === 'unreadable') throw Object.assign(new Error('fixture inventory denied'), { code: 'EACCES' });
        let read = 0;
        return {
          readSync: () => read++ < (scenario === 'budget' ? 20001 : 1) ? { name: scenario === 'budget' ? 'entry-' + read : 'child' } : null,
          closeSync() {}
        };
      };
      fs.rmSync = (...args) => { removals.push(args); if (scenario === 'remove-failure') throw new Error('fixture native removal failed'); };
      syncBuiltinESMExports();
      const result = cleanupTaskEphemeralDirectory(fixtureConfig, 'cleanup-observation');
      if (scenario === 'ordinary' || scenario === 'ancestor-activity') {
        assert.equal(result.removed, true);
        assert.equal(result.removedFiles, 1);
        assert.equal(result.removedBytes, 7);
        assert.equal(removals.length, 1);
        assert.equal(removals[0][0], target);
      } else if (scenario === 'missing-root') {
        assert.equal(result.removed, true);
        assert.equal(result.removedFiles, 0);
        assert.equal(removals.length, 0, 'absent scratch needs no deletion');
      } else if (scenario === 'remove-failure') {
        assert.equal(result.removed, false);
        assert.equal(removals.length, 1);
        assert.match(result.retainedReason, /cleanup incomplete; remaining files retained/);
      } else {
        assert.equal(result.removed, false, scenario);
        assert.equal(removals.length, 0, scenario + ' must not reach recursive removal');
        assert.match(result.retainedReason, /Task scratch retained:/);
        if (scenario === 'windows') assert.match(result.retainedReason, /Windows.*reparse-point.*disk space/);
      }
    }
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-git-index-regression-'));
const workspace = { alias: 'index-regression', path: path.join(root, 'repo') };
fs.mkdirSync(workspace.path);
const config = { stateDir: path.join(root, 'state'), workspaces: { [workspace.alias]: { path: workspace.path, commands: {}, testCommands: {} } } };
const git = args => execFileSync(GIT_EXECUTABLE, args, { cwd: workspace.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const run = args => executeToolCall({
  config, name: OP.PUBLISH_COMMIT, executionName: OP.PUBLISH_COMMIT,
  effectiveArgs: { workspace: workspace.alias, ...args }, context: {},
  definition: { behavior: { concurrencyScope: 'mutation' }, handler: (_c, a) => relaiGitCommit(workspace, config, a) }, started: Date.now()
});
const index = path.join(workspace.path, '.git', 'index');
const originalSpawn = childProcess.spawn;
try {
  git(['init']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Local Fixture']);
  fs.writeFileSync(path.join(workspace.path, 'selected.txt'), 'base selected\n');
  fs.writeFileSync(path.join(workspace.path, 'unrelated.txt'), 'base unrelated\n');
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(workspace.path, 'selected.txt'), 'selected worktree\n');
  fs.writeFileSync(path.join(workspace.path, 'unrelated.txt'), 'staged unrelated\n');
  git(['add', 'unrelated.txt']);
  fs.writeFileSync(path.join(workspace.path, 'unrelated.txt'), 'unstaged unrelated\n');
  const originalIndex = fs.readFileSync(index);
  const originalHead = git(['rev-parse', 'HEAD']);
  for (const kind of ['add-scoped', 'add-all', 'staged-observation']) {
    let intercepted = false;
    childProcess.spawn = function(command, argv, options) {
      const failureArgs = ['-e', 'process.stderr.write("fixture failure"); process.exitCode=1'];
      const match = options?.env?.GIT_INDEX_FILE && options.cwd === workspace.path
        && (kind === 'staged-observation' ? argv?.includes('--cached') : argv?.includes('add'));
      if (match && !intercepted) {
        intercepted = true;
        return originalSpawn.call(this, process.execPath, failureArgs, options);
      }
      // Windows mutators start a native controller. Inject the same ordinary
      // target failure inside its job, rather than bypassing native completion.
      const requestFlag = process.platform === 'win32' ? argv?.indexOf('-RequestPath') : -1;
      if (!intercepted && requestFlag >= 0) {
        const requestPath = argv[requestFlag + 1];
        const relative = path.relative(path.join(config.stateDir, 'process-jobs'), requestPath);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'only fixture-owned job requests');
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        const environment = JSON.parse(options.env[request.environmentTransportKey]);
        assert.equal(environment.protocol, request.protocol);
        assert.equal(environment.nonce, request.nonce);
        const indexEntry = environment.entries.find(([key]) => key.toUpperCase() === 'GIT_INDEX_FILE');
        if (request.cwd === workspace.path && indexEntry
          && (kind === 'staged-observation' ? request.args.includes('--cached') : request.args.includes('add'))) {
          assert.equal(path.dirname(indexEntry[1]), path.dirname(index), 'only fixture-owned alternate index');
          intercepted = true;
          const failedRequest = { ...request, executable: process.execPath, args: failureArgs };
          delete failedRequest.argv0;
          delete failedRequest.windowsVerbatimArguments;
          delete failedRequest.rawCommandLine;
          fs.writeFileSync(requestPath, JSON.stringify(failedRequest));
        }
      }
      return originalSpawn.call(this, command, argv, options);
    };
    syncBuiltinESMExports();
    const result = await run({ message: 'must not commit', ...(kind === 'add-all' ? { addAll: true } : { paths: ['selected.txt'] }) });
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    assert.equal(intercepted, true, kind);
    assert.equal(result.value.ok, false, kind);
    assert.equal(result.value.indexPreserved, true, JSON.stringify(result.value));
    assert.deepEqual(fs.readFileSync(index), originalIndex, 'refusal preserves pre-existing staged hunks byte for byte');
    assert.equal(git(['rev-parse', 'HEAD']), originalHead, 'refusal must not commit');
    assert.equal(fs.existsSync(index + '.lock'), false);
  }
  // A non-Git writer that ignores the ordinary lock is never overwritten on refusal.
  const tx = await beginGitIndexTransaction(workspace.path, config);
  const externalIndex = Buffer.from(originalIndex);
  externalIndex[externalIndex.length - 1] ^= 1;
  fs.writeFileSync(index, externalIndex);
  assert.equal(tx.unchanged(), false);
  assert.throws(() => tx.publish(), /changed outside/);
  tx.dispose();
  assert.deepEqual(fs.readFileSync(index), externalIndex);
  fs.writeFileSync(index, originalIndex); // Owned disposable fixture repair only.

  const committed = await run({ message: 'selected only', paths: ['selected.txt'] });
  assert.equal(committed.value.ok, true, JSON.stringify(committed.value));
  assert.equal(git(['show', 'HEAD:selected.txt']), 'selected worktree\n');
  assert.equal(git(['show', 'HEAD:unrelated.txt']), 'base unrelated\n');
  assert.equal(git(['show', ':unrelated.txt']), 'staged unrelated\n');
  assert.equal(fs.readFileSync(path.join(workspace.path, 'unrelated.txt'), 'utf8'), 'unstaged unrelated\n');
  assert.equal(git(['diff', '--cached', '--name-only', '--', 'selected.txt']), '');
  assert.equal(fs.existsSync(index + '.lock'), false);

  // Moving an index to a freshly created file must preserve Git's racy-stat
  // protection for same-size edits on a coarse-stat filesystem.
  const racyRepo = path.join(root, 'racy-index');
  fs.mkdirSync(racyRepo);
  const racyGit = (args, env) => execFileSync(GIT_EXECUTABLE, args, {
    cwd: racyRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }
  });
  racyGit(['init']);
  racyGit(['config', 'user.email', 'fixture@example.test']);
  racyGit(['config', 'user.name', 'Local Fixture']);
  racyGit(['config', 'core.trustctime', 'false']);
  racyGit(['config', 'core.checkStat', 'minimal']);
  const racyFile = path.join(racyRepo, 'unselected.txt'), racyIndex = path.join(racyRepo, '.git', 'index');
  const stamp = Math.floor(Date.now() / 1000) - 10;
  fs.writeFileSync(racyFile, 'old-data\n');
  fs.utimesSync(racyFile, stamp, stamp);
  fs.writeFileSync(path.join(racyRepo, 'selected.txt'), 'base\n');
  racyGit(['add', '.']);
  racyGit(['commit', '-m', 'fixture']);
  fs.utimesSync(racyIndex, stamp, stamp);
  fs.writeFileSync(racyFile, 'new-data\n');
  fs.utimesSync(racyFile, stamp, stamp);
  fs.writeFileSync(path.join(racyRepo, 'selected.txt'), 'selected change\n');
  const racyTransaction = await beginGitIndexTransaction(racyRepo, config);
  try {
    racyGit(['add', '--', 'selected.txt'], racyTransaction.env);
    racyGit(['commit', '-m', 'selected only'], racyTransaction.env);
    racyTransaction.publish();
  } finally { racyTransaction.dispose(); }
  assert.equal(racyGit(['show', 'HEAD:unselected.txt']), 'old-data\n');
  assert.equal(fs.readFileSync(racyFile, 'utf8'), 'new-data\n');
  assert.ok(racyGit(['status', '--porcelain=v1', '--', 'unselected.txt']).trim(), 'index cloning must not hide an unselected same-size dirty file');

  // The read budget bounds actual file I/O, not only returned diff text.
  const large = path.join(workspace.path, 'large.txt');
  fs.writeFileSync(large, Buffer.alloc(128 * 1024, 65));
  let readBytes = 0;
  const originalRead = fs.readSync;
  fs.readSync = function(...args) { const count = originalRead.apply(this, args); readBytes += count; return count; };
  syncBuiltinESMExports();
  let diff;
  try { diff = buildUntrackedDiff(workspace, ['large.txt'], 2048); }
  finally { fs.readSync = originalRead; syncBuiltinESMExports(); }
  assert.ok(readBytes <= 2048, String(readBytes));
  assert.match(diff, /bounded file prefix/);
  assert.ok(Buffer.byteLength(diff) < 2300);

  const env = withTaskEphemeralEnvironment(config, 'long-running', workspace);
  const scratch = env.REL_AI_EPHEMERAL_DIR;
  const metadata = path.join(scratch, '.relai-ephemeral.json');
  const old = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  fs.writeFileSync(metadata, JSON.stringify({ ...old, updatedAt: '2000-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(scratch, 'still-needed.txt'), 'fixture');
  withTaskEphemeralEnvironment(config, 'other-task', workspace);
  assert.equal(fs.existsSync(path.join(scratch, 'still-needed.txt')), true, 'age does not retire active scratch');

  // Legacy retry eligibility must not bypass Windows retention or a no-follow
  // refusal. The link observation is mocked over an ordinary owned file.
  fs.writeFileSync(metadata, JSON.stringify({ ...old, cleanupEligible: true, updatedAt: '2000-01-01T00:00:00.000Z' }));
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalLstat = fs.lstatSync;
  const originalRemove = fs.rmSync;
  let staleRemovalCalls = 0;
  try {
    fs.rmSync = function(candidate, ...args) {
      if (String(candidate) === scratch) { staleRemovalCalls += 1; return; }
      return originalRemove.call(this, candidate, ...args);
    };
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
    syncBuiltinESMExports();
    withTaskEphemeralEnvironment(config, 'windows-retains-stale', workspace);
    assert.equal(staleRemovalCalls, 0, 'Windows never retries legacy eligible scratch deletion');
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
    fs.lstatSync = function(candidate, ...args) {
      const stat = originalLstat.call(this, candidate, ...args);
      if (String(candidate) === path.join(scratch, 'still-needed.txt')) {
        stat.isSymbolicLink = () => true;
      }
      return stat;
    };
    syncBuiltinESMExports();
    withTaskEphemeralEnvironment(config, 'posix-retains-stale-link', workspace);
    assert.equal(staleRemovalCalls, 0, 'stale pruning shares the fail-closed link observation gate');
    assert.equal(fs.existsSync(path.join(scratch, 'still-needed.txt')), true);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    fs.lstatSync = originalLstat;
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
  }

  fs.rmSync(path.dirname(scratch), { recursive: true, force: true });
  console.log('Complete staged evidence, isolated index rollback, scoped staging, external writer preservation, bounded diff I/O and active scratch retention passed.');
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
