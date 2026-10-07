import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports, stripTypeScriptTypes } from 'node:module';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';
import { readGitObservation } from '../src/repo/gitObservation.ts';
import { internalReadOnlyProcessOutcome, isInternalReadOnlyProcessOutcome } from '../src/process.ts';
import { gitStatusArgs, parseGitStatus, statusMapFromOutput, INTERNAL_STATUS_MAX_BYTES } from '../src/repo/gitStatus.ts';
import { relaiExec } from '../src/bridge/exec.js';
import { workspaceWrite, workspaceReplace } from '../src/localRepoBridge.ts';
import { relaiGitCommit, workspaceGitStatus } from '../src/repo/gitOps.ts';
import { recordTaskIntegrityEvent, readTaskIntegrity, taskCommitOwnership } from '../src/taskIntegrity.ts';
import { ensureSessionStarted } from '../src/policyResolver.js';
import { workspaceTidyPlan } from '../src/bridge/tidy.js';
import { acquireHostResource, createFairResourceScheduler } from '../src/hostResourceScheduler.js';
import { relaiRestorePaths } from '../src/bridge/restore.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tiered-git-'));
const repo = path.join(temp, 'repo');
fs.mkdirSync(repo);
const config = { stateDir: path.join(temp, 'state'), workspaces: { fixture: { path: repo, commands: {} } } };
const workspace = { alias: 'fixture', path: repo };
const git = (...args) => childProcess.execFileSync(GIT_EXECUTABLE, args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const event = (taskId, tool, result = {}) => recordTaskIntegrityEvent(config, {
  taskId, workspace: 'fixture', taskIdentityVersion: 2, tool, ok: true, ...result
});
async function beginObservedTask(taskId) {
  await event(taskId, 'work.begin');
  const baseline = readTaskIntegrity(config, taskId, 'fixture').baseline;
  assert.equal(baseline.observationComplete, true, `Fixture baseline: ${JSON.stringify(baseline)}`);
  await ensureSessionStarted(config, 'fixture', repo, { taskId });
  return taskId;
}

function createProbeTracker() {
  const byRepo = new Map();
  let active = 0;
  let maximum = 0;
  return {
    get active() { return active; },
    get maximum() { return maximum; },
    spawn(cwd, createChild) {
      // Assert before launching, so a failed fixture assertion cannot orphan a
      // child or poison the counter before its cleanup listeners are attached.
      assert.equal(byRepo.get(cwd) || 0, 0, 'one native Git status process per repository');
      const child = createChild();
      byRepo.set(cwd, 1);
      maximum = Math.max(maximum, ++active);
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        active--;
        byRepo.delete(cwd);
      };
      // Execa can settle after root exit and stream completion but before the
      // raw ChildProcess close event. Count live roots, not lingering handles.
      child.once('exit', settle);
      child.once('close', settle); // Also releases a child that failed to spawn.
      return child;
    }
  };
}

// Exercise the native hook's exact tracker with deterministic lifecycle order.
{
  const tracker = createProbeTracker();
  const first = new EventEmitter();
  const second = new EventEmitter();
  const failedSpawn = new EventEmitter();
  tracker.spawn('fixture', () => first);
  let overlappingSpawn = false;
  assert.throws(() => tracker.spawn('fixture', () => { overlappingSpawn = true; }), /one native Git status process/);
  assert.equal(overlappingSpawn, false, 'a genuinely overlapping child is rejected before launch');
  first.emit('exit', 0);
  tracker.spawn('fixture', () => second);
  first.emit('close', 0);
  assert.equal(tracker.active, 1, 'a late close cannot release a newer child');
  assert.throws(() => tracker.spawn('fixture', () => new EventEmitter()), /one native Git status process/);
  second.emit('exit', 0);
  second.emit('close', 0);
  tracker.spawn('fixture', () => failedSpawn);
  failedSpawn.emit('close', -1);
  assert.equal(tracker.active, 0, 'failed-spawn close and duplicate lifecycle events release exactly once');
  assert.equal(tracker.maximum, 1);
}
const originalSpawn = childProcess.spawn;
const probes = [];
const probeTracker = createProbeTracker();
childProcess.spawn = function (command, args, options) {
  const requestFlag = process.platform === 'win32' ? args?.indexOf('-RequestPath') : -1;
  const request = requestFlag >= 0 ? JSON.parse(fs.readFileSync(args[requestFlag + 1], 'utf8')) : null;
  const probeArgs = request?.args || args;
  if (!probeArgs?.includes('status')) return originalSpawn.call(this, command, args, options);
  const cwd = request?.cwd || options.cwd;
  const relative = path.relative(temp, cwd);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'only fixture-owned native Git probes');
  return probeTracker.spawn(cwd, () => {
    const child = originalSpawn.call(this, command, args, options);
    probes.push([...probeArgs]);
    return child;
  });
};
syncBuiltinESMExports();
try {
  git('init', '-q');
  git('config', 'user.name', 'Tiered Test');
  git('config', 'user.email', 'tiered@example.test');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'app.txt'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  fs.mkdirSync(path.join(repo, 'firmware-extract'));
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(repo, 'firmware-extract', `file-${i}.txt`), 'user file\n');
  assert.throws(() => gitStatusArgs({ untracked: 'all' }), /bounded file scope/);
  const summary = await readGitObservation(repo, config);
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(parseGitStatus(summary.stdout).entries.filter(entry => entry.opaqueDirectory).map(entry => entry.path), ['firmware-extract/']);
  assert.equal(statusMapFromOutput(summary.stdout).has('firmware-extract/'), false);
  await assert.rejects(readGitObservation(repo, config, { paths: ['firmware-extract'] }), /directory paths/);
  await assert.rejects(readGitObservation(repo, config, { paths: ['.'] }), /relative file paths/);
  await assert.rejects(relaiRestorePaths(workspace, config, { paths: ['firmware-extract'] }), /directory paths/);

  const unavailable = [await acquireHostResource('gitObservation', 'baseline-busy-1'), await acquireHostResource('gitObservation', 'baseline-busy-2')];
  try {
    await event('unobserved', 'work.begin');
  } finally { for (const lease of unavailable) lease.release(); }
  await ensureSessionStarted(config, 'fixture', repo, { taskId: 'unobserved' });
  const incompleteBaseline = readTaskIntegrity(config, 'unobserved', 'fixture').baseline;
  assert.equal(incompleteBaseline.observationComplete, false, 'an unavailable observation cannot prove a clean baseline');
  assert.deepEqual(incompleteBaseline.opaqueDirectories, [], 'unknown trees are not complete empty trees');

  const nativeTask = await beginObservedTask('native');
  assert.deepEqual(readTaskIntegrity(config, nativeTask, 'fixture').baseline.opaqueDirectories, ['firmware-extract/']);
  const opendir = fs.promises.opendir;
  fs.promises.opendir = async () => { throw new Error('Unexpected bookkeeping crawl'); };
  let command;
  try {
    command = await relaiExec(workspace, config, { executable: process.execPath,
      argv: ['-e', "require('node:fs').writeFileSync('firmware-extract/file-0.txt','command output')"] }, { resourceClass: 'light' });
  } finally { fs.promises.opendir = opendir; }
  assert.equal(command.commandSucceeded, true);
  assert.equal(command.timedOut, false);
  assert.equal(command.mutationUnknown, true);
  assert.deepEqual(command.changedFiles, [], 'opaque directories are not retroactively claimed');
  await event(nativeTask, 'exec', command);
  assert.deepEqual(taskCommitOwnership(config, nativeTask, 'fixture').ownedFiles, []);
  const blockers = [await acquireHostResource('gitObservation', 'busy-1'), await acquireHostResource('gitObservation', 'busy-2')];
  try {
    const start = performance.now();
    const allowed = await relaiExec(workspace, config, { executable: process.execPath,
      argv: ['-e', "console.log('completed while Git bookkeeping was busy')"] }, { resourceClass: 'light' });
    assert.equal(allowed.commandSucceeded, true);
    assert.equal(allowed.timedOut, false);
    assert.equal(allowed.mutationUnknown, true);
    assert.ok(performance.now() - start < 500, 'ordinary execution skips occupied bookkeeping capacity');
    const head = git('rev-parse', 'HEAD').trim();
    const refused = await relaiGitCommit(workspace, config, { message: 'blocked observation', paths: ['src/app.txt'] });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /No files were staged or committed/);
    assert.equal(git('rev-parse', 'HEAD').trim(), head);
    assert.equal(git('diff', '--cached', '--name-only').trim(), '');
  } finally { for (const blocker of blockers) blocker.release(); }

  const added = workspaceWrite(workspace, config, { work_id: nativeTask, path: 'firmware-extract/native.txt', content: 'native output\n' });
  await event(nativeTask, 'edit', added);
  await event(nativeTask, 'validate.checks', { validationStatus: 'passed' });
  assert.deepEqual(taskCommitOwnership(config, nativeTask, 'fixture').ownedFiles, ['firmware-extract/native.txt']);
  const status = await workspaceGitStatus(workspace, config, { work_id: nativeTask });
  assert.equal(status.ok, true, `Task status: ${JSON.stringify(status)}`);
  assert.ok(status.sessionChangedFiles.includes('firmware-extract/native.txt'));
  assert.equal(status.sessionChangedFiles.includes('firmware-extract/'), false);
  const tidy = await workspaceTidyPlan(workspace, config, { work_id: nativeTask });
  assert.deepEqual(tidy.candidates.map(item => item.path), ['firmware-extract/native.txt']);
  const whole = await relaiGitCommit(workspace, config, { message: 'unsafe broad commit', addAll: true });
  assert.equal(whole.ok, false);
  const commit = await relaiGitCommit(workspace, config, { work_id: nativeTask, message: 'native output', _taskOwnedPaths: ['firmware-extract/native.txt'] });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  assert.equal(git('ls-files', 'firmware-extract').trim(), 'firmware-extract/native.txt', 'commit never stages the opaque directory');
  await event(nativeTask, 'publish.commit', { committedFiles: commit.paths });
  fs.appendFileSync(path.join(repo, 'firmware-extract/native.txt'), 'later user edit\n');
  const later = workspaceReplace(workspace, config, { work_id: nativeTask, path: 'firmware-extract/native.txt', oldText: 'native output', newText: 'new native output' });
  await event(nativeTask, 'edit', later);
  assert.ok(taskCommitOwnership(config, nativeTask, 'fixture').conflictingFiles.includes('firmware-extract/native.txt'), 'later user changes to a previously committed native file remain protected');

  const otherTask = await beginObservedTask('other');
  const replaced = workspaceReplace(workspace, config, { work_id: otherTask, path: 'firmware-extract/file-1.txt', oldText: 'user file', newText: 'edited file' });
  await event(otherTask, 'edit', replaced);
  assert.ok(taskCommitOwnership(config, otherTask, 'fixture').conflictingFiles.includes('firmware-extract/file-1.txt'), 'existing user files remain protected');
  const otherTidy = await workspaceTidyPlan(workspace, config, { work_id: otherTask });
  assert.equal(otherTidy.candidates.some(item => item.path === 'firmware-extract/file-1.txt'), false);

  const unobservedEdit = workspaceReplace(workspace, config, { work_id: 'unobserved', path: 'firmware-extract/file-2.txt', oldText: 'user file', newText: 'edited file' });
  await event('unobserved', 'edit', unobservedEdit);
  assert.ok(taskCommitOwnership(config, 'unobserved', 'fixture').conflictingFiles.includes('firmware-extract/file-2.txt'), 'incomplete baselines still protect existing user files');
  assert.deepEqual(readTaskIntegrity(config, 'unobserved', 'fixture').baseline.opaqueDirectories, incompleteBaseline.opaqueDirectories);
  assert.equal(readTaskIntegrity(config, 'unobserved', 'fixture').baseline.observationComplete, false, 'later observations cannot replace a pre-mutation baseline');

  const count = probes.length;
  await Promise.all(Array.from({ length: 6 }, () => readGitObservation(repo, config, { coalesce: true })));
  assert.equal(probes.length, count + 1, 'simultaneous compatible summaries share one probe');
  await Promise.all(Array.from({ length: 4 }, () => readGitObservation(repo, config)));
  const peers = [path.join(temp, 'peer-one'), path.join(temp, 'peer-two')];
  for (const [i, peer] of peers.entries()) git('worktree', 'add', '-qb', `peer-${i}`, peer);
  await Promise.all([repo, ...peers].flatMap(directory => Array.from({ length: 3 }, () => readGitObservation(directory, config))));
  assert.ok(probeTracker.maximum <= 2);
  assert.equal(probeTracker.active, 0);
  for (const args of probes) {
    if (!args.includes('--untracked-files=all')) continue;
    const boundary = args.indexOf('--');
    assert.ok(boundary >= 0 && boundary < args.length - 1);
    assert.ok(args.slice(boundary + 1).every(file => file.startsWith(':(literal)') && !file.endsWith('/')));
  }

  // Execute the actual observation module with only its process dependency
  // injected. No child is launched; isolated real scheduler instances prove
  // result/error capacity invariants without resetting production leases.
  {
    const source = stripTypeScriptTypes(fs.readFileSync(new URL('../src/repo/gitObservation.ts', import.meta.url), 'utf8'), { mode: 'strip' })
      .replace(/^import .+;\s*$/gm, '')
      .replace(/\bexport\s+(?=(?:async\s+)?function\b)/g, '');
    const factory = new Function('fs', 'path', 'runOwnedReadOnlyProcess', 'reconcileReadOnlyProcessTermination', 'createFairResourceScheduler',
      'acquireHostResource', 'hostResourceStats', 'gitStatusArgs', 'INTERNAL_STATUS_MAX_BYTES', 'internalReadOnlyProcessOutcome',
      source + '\nreturn { readGitObservation };');
    const make = (run, reconcile = () => false) => {
      const scheduler = createFairResourceScheduler({ gitObservation: 2 });
      const module = factory(fs, path, run, reconcile, createFairResourceScheduler,
        (resource, owner, options) => scheduler.acquire(resource, owner, options),
        () => scheduler.stats(), gitStatusArgs, INTERNAL_STATUS_MAX_BYTES, internalReadOnlyProcessOutcome);
      return { ...module, scheduler };
    };
    const successful = { executed: true, exitCode: 0, stdout: '', stderr: '', timedOut: false,
      stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, queueWaitMs: 0, durationMs: 0 };
    for (const control of [
      () => successful,
      () => ({ ...successful, exitCode: 1, terminationConfirmed: true }),
      () => { throw Object.assign(new Error('fixture pre-spawn failure'), { code: 'ENOENT', executed: false }); },
      () => { throw Object.assign(new Error('fixture settled failure'), { code: 'PROCESS_SETUP_FAILED', executed: true, terminationConfirmed: true, rootExitConfirmed: true }); }
    ]) {
      const fixture = make(control);
      await fixture.readGitObservation(repo, config);
      assert.equal(fixture.scheduler.stats().gitObservation.active, 0, 'success/settled/pre-spawn failure releases capacity');
    }
    for (const incomplete of [
      { timedOut: true }, { cancelled: true }, { terminationConfirmed: false },
      { stdoutTruncated: true }, { stdoutSpillTruncated: true }, { outputFinalizationTimedOut: true }
    ]) {
      const fixture = make(() => ({ ...successful, ...incomplete }));
      const result = await fixture.readGitObservation(repo, config);
      assert.notEqual(result.exitCode, 0, 'incomplete observations cannot look successful to status consumers');
      assert.equal(result.observedExitCode, 0);
      assert.equal(result.errorCode, 'GIT_OBSERVATION_INCOMPLETE');
    }
    let calls = 0;
    const aborted = new AbortController();
    const thrown = make(() => {
      calls++;
      aborted.abort(new Error('fixture caller cancellation'));
      throw Object.assign(new Error('fixture uncertain post-spawn failure'), {
        code: 'PROCESS_SETUP_FAILED', executed: true, terminationConfirmed: false, rootExitConfirmed: true
      });
    });
    const failure = await thrown.readGitObservation(repo, config, { signal: aborted.signal });
    assert.equal(failure.executed, true);
    assert.equal(failure.terminationConfirmed, false);
    assert.equal(failure.rootExitConfirmed, true);
    assert.equal(failure.errorCode, 'PROCESS_SETUP_FAILED');
    assert.equal(isInternalReadOnlyProcessOutcome(failure), true, 'caught observation errors keep private read-only provenance');
    assert.match(failure.error, /fixture uncertain post-spawn failure/);
    assert.equal(thrown.scheduler.stats().gitObservation.active, 1, 'thrown uncertainty retains capacity');
    const suspended = await thrown.readGitObservation(repo, config);
    assert.equal(suspended.executed, false);
    assert.match(suspended.error, /suspended/);
    assert.equal(calls, 1, 'suspended repositories never launch another probe');
    const returned = make(() => ({ ...successful, timedOut: true, terminationConfirmed: false }));
    await returned.readGitObservation(repo, config);
    assert.equal(returned.scheduler.stats().gitObservation.active, 1, 'returned uncertainty retains the same capacity');
    // A late proof must belong to the exact retained result/error object.
    // The injected predicate models the private native-owner lookup; merely
    // copying public result metadata cannot settle a lease.
    for (const thrownError of [false, true]) {
      let admitted = 0;
      let proofAvailable = false;
      const evidence = thrownError
        ? Object.assign(new Error('late owned cleanup'), { executed: true, terminationConfirmed: false })
        : { ...successful, terminationConfirmed: false };
      const late = make(() => {
        admitted++;
        if (admitted > 1) return successful;
        if (thrownError) throw evidence;
        return evidence;
      }, candidate => candidate === evidence && proofAvailable);
      await late.readGitObservation(repo, config);
      assert.equal(late.scheduler.stats().gitObservation.active, 1);
      const stillUnknown = await late.readGitObservation(repo, config);
      assert.equal(stillUnknown.executed, false);
      assert.equal(admitted, 1);
      proofAvailable = true;
      const reconciled = await late.readGitObservation(repo, config);
      assert.equal(reconciled.exitCode, 0);
      assert.equal(admitted, 2);
      assert.equal(late.scheduler.stats().gitObservation.active, 0, 'exact late proof releases both lanes before re-admission');
    }
    const cancelled = new AbortController();
    cancelled.abort(new Error('fixture pre-admission cancellation'));
    const beforeStart = make(() => { throw new Error('must not execute'); });
    await assert.rejects(beforeStart.readGitObservation(repo, config, { signal: cancelled.signal }),
      error => error === cancelled.signal.reason);
    assert.equal(beforeStart.scheduler.stats().gitObservation.active, 0);
  }
  console.log('Tiered Git accounting: opaque trees, command success, native ownership, scoped commit/tidy, coalescing and bounded probes passed.');
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
