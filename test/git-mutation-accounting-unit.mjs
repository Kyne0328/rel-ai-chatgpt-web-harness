import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relaiExec, readFilesystemStatusMap, changedFilesystemFiles } from '../src/bridge/exec.js';
import { classifyStatusOwnership, workspaceGitStatus } from '../src/repo/gitOps.ts';
import { recordTaskIntegrityEvent, readTaskIntegrity, taskCommitOwnership } from '../src/taskIntegrity.ts';
import { readGitStatus } from '../src/repo/gitClient.ts';
import { parseGitStatus, statusMapFromOutput } from '../src/repo/gitStatus.ts';
import { createValidationFingerprint } from '../src/bridge/validationPlan.js';
import { buildGitBenchmarkLatencyBudgets } from './helpers/git-benchmark-latency.mjs';
import { withGitProcessCounts } from './helpers/git-process-counter.mjs';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-mutation-accounting-'));
const repo = path.join(root, 'repo');
const plain = path.join(root, 'plain');
const config = { stateDir: path.join(root, 'state'), auditLogPath: path.join(root, 'state', 'audit.jsonl') };
const workspace = { alias: 'fixture', path: repo };
config.workspaces = { fixture: { path: repo, commands: {}, testCommands: {} } };
const plainWorkspace = { alias: 'plain', path: plain, context: { includeRoots: ['nested'] } };
const git = (...args) => execFileSync(GIT_EXECUTABLE, args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
const execute = (ws, script, args = {}) => relaiExec(ws, config, {
  executable: process.execPath, argv: ['-e', script], ...args
}, { resourceClass: 'light' });
const oid = 'a'.repeat(40);
fs.mkdirSync(repo);
fs.mkdirSync(plain);

try {
  const timings = { cleanRawMs: 40, cleanV2Ms: 42, dirtyRawMs: 50, dirtyV2Ms: 52, rawSpawnMs: 30, readOnlyMs: 50, mutatingMs: 170 };
  const budgets = buildGitBenchmarkLatencyBudgets(timings);
  assert.equal(budgets.every(item => item.passed), true);
  assert.equal(budgets.find(item => item.label === 'read-only wrapper').maximumMs, 180);
  assert.equal(budgets.find(item => item.label === 'mutating wrapper').maximumMs, 304);
  assert.equal(budgets.find(item => item.label === 'mutating wrapper').componentBaselineMs, timings.readOnlyMs + 2 * timings.dirtyV2Ms);
  assert.equal(buildGitBenchmarkLatencyBudgets({ ...timings, readOnlyMs: 180 })[2].passed, true);
  assert.equal(buildGitBenchmarkLatencyBudgets({ ...timings, readOnlyMs: 180.1 })[2].passed, false);
  assert.equal(buildGitBenchmarkLatencyBudgets({ ...timings, mutatingMs: 304 })[3].passed, true);
  assert.equal(buildGitBenchmarkLatencyBudgets({ ...timings, mutatingMs: 304.1 })[3].passed, false);
  for (const [field, index] of [['cleanV2Ms', 0], ['dirtyV2Ms', 1], ['readOnlyMs', 2], ['mutatingMs', 3]]) {
    const injected = buildGitBenchmarkLatencyBudgets({ ...timings, [field]: timings[field] + 200 });
    assert.equal(injected[index].passed, false, 'injected 200ms regression must fail the ' + field + ' gate without sleeping');
  }
  assert.throws(() => buildGitBenchmarkLatencyBudgets({ ...timings, rawSpawnMs: NaN }), /Invalid benchmark timing/);
  const parsed = parseGitStatus([
    '# branch.oid ' + oid, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -3',
    '1 .M N... 100644 100644 100644 ' + oid + ' ' + oid + ' modified café.txt',
    '2 R. N... 100644 100644 100644 ' + oid + ' ' + oid + ' R100 new café.txt', 'old café.txt',
    'u UU N... 100644 100644 100644 100644 ' + oid + ' ' + oid + ' ' + oid + ' conflict.txt',
    '? untracked folder/file.txt', ''
  ].join('\0'));
  assert.equal(parsed.repositoryHead, oid);
  assert.equal(parsed.branch, 'main');
  assert.deepEqual(parsed.aheadBehind, { ahead: 2, behind: 3 });
  assert.equal(parsed.entries[0].path, 'modified café.txt');
  assert.equal(parsed.entries[0].indexStatus, ' ');
  assert.equal(parsed.entries[1].originalPath, 'old café.txt');
  assert.equal(parsed.entries[2].indexStatus, 'U');
  assert.equal(parsed.entries[3].untracked, true);
  const rename = statusMapFromOutput('R  new café.txt\0old café.txt\0');
  assert.ok(rename.has('old café.txt') && rename.has('new café.txt'));
  const displayOwnership = classifyStatusOwnership(workspace, config, 'R  new café.txt\0old café.txt\0');
  assert.deepEqual(displayOwnership.unknownChanged, ['new café.txt'], 'display groups describe one Git destination entry');
  assert.equal(displayOwnership.entries[0].originalPath, 'old café.txt', 'display entry retains its source without duplicating groups');
  assert.equal(statusMapFromOutput('C  copied.txt\0original.txt\0').has('original.txt'), false);
  assert.equal(parseGitStatus('# branch.oid (initial)\0# branch.head main\0').unborn, true);
  assert.equal(parseGitStatus('# branch.oid ' + oid + '\0# branch.head (detached)\0').branch, 'HEAD (no branch)');
  assert.throws(() => parseGitStatus('# branch.oid ' + oid + '\0broken record\0'), /Invalid Git status entry/);

  git('init', '-b', 'main');
  const unborn = await readGitStatus(repo);
  assert.equal(unborn.unborn, true);
  assert.equal(unborn.repositoryHead, '');
  fs.writeFileSync(path.join(repo, 'old café.txt'), 'original\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  git('add', '.');
  git('-c', 'user.name=Mutation Test', '-c', 'user.email=mutation@example.test', 'commit', '-m', 'initial');

  const { result: initial, counts: initialCounts } = await withGitProcessCounts(() => readGitStatus(repo));
  assert.equal(initial.repositoryHead, git('rev-parse', 'HEAD').trim());
  assert.equal(initialCounts.status, 1, 'one status call obtains entries, branch and HEAD');
  assert.equal(initialCounts.head, 0);
  const { result: first, counts: fingerprintCounts } = await withGitProcessCounts(() =>
    createValidationFingerprint(workspace, config, { paths: ['old café.txt'] }));
  assert.equal(fingerprintCounts.status, 1);
  assert.equal(fingerprintCounts.head, 0, 'fingerprint reuses HEAD from its own status');
  fs.appendFileSync(path.join(repo, 'old café.txt'), 'changed\n');
  const second = await createValidationFingerprint(workspace, config, { paths: ['old café.txt'] });
  assert.notEqual(first.fingerprint, second.fingerprint, 'separate calls never reuse stale snapshots');
  git('checkout', '--', 'old café.txt');

  const integrityEvent = (tool, extra = {}) => ({
    taskId: 'rename-task', workspace: 'fixture', taskIdentityVersion: 2, taskHistoryEligible: true,
    tool, ok: true, ts: new Date().toISOString(), ...extra
  });
  await recordTaskIntegrityEvent(config, integrityEvent('work.begin'));
  const renamed = await relaiExec(workspace, config, {
    executable: GIT_EXECUTABLE, argv: ['mv', 'old café.txt', 'new café.txt']
  }, { resourceClass: 'light' });
  assert.equal(renamed.commandSucceeded, true);
  assert.deepEqual(renamed.changedFiles, ['new café.txt', 'old café.txt']);
  await recordTaskIntegrityEvent(config, integrityEvent('exec', renamed));
  await recordTaskIntegrityEvent(config, integrityEvent('validate.checks', { validationStatus: 'passed' }));
  assert.deepEqual(taskCommitOwnership(config, 'rename-task', 'fixture').ownedFiles, ['new café.txt', 'old café.txt'],
    'repository reconciliation retains ownership of the renamed-away source');
  assert.deepEqual(readTaskIntegrity(config, 'rename-task', 'fixture').taskOwnedChangedFiles, ['new café.txt', 'old café.txt']);
  const ownedStatus = await workspaceGitStatus(workspace, config, { work_id: 'rename-task' });
  assert.deepEqual(ownedStatus.sessionChangedFiles.sort(), ['new café.txt', 'old café.txt']);
  assert.deepEqual(ownedStatus.changedFiles.sort(), ['new café.txt', 'old café.txt']);
  const gitDirectory = path.join(repo, '.git');
  const hiddenGitDirectory = path.join(root, 'temporarily-unavailable-git');
  fs.renameSync(gitDirectory, hiddenGitDirectory);
  try {
    await recordTaskIntegrityEvent(config, integrityEvent('validate.checks', { validationStatus: 'failed' }));
    assert.deepEqual(taskCommitOwnership(config, 'rename-task', 'fixture').ownedFiles, ['new café.txt', 'old café.txt'],
      'failed Git reconciliation cannot erase established ownership as if the tree were clean');
  } finally { fs.renameSync(hiddenGitDirectory, gitDirectory); }
  const dirtyAgain = await execute(workspace, "require('node:fs').appendFileSync('new café.txt', 'again\\n')");
  assert.deepEqual(dirtyAgain.changedFiles, ['new café.txt']);
  const many = await execute(workspace, "const fs=require('node:fs');for(let i=0;i<205;i++)fs.writeFileSync('new-'+i+'.txt','x')");
  assert.ok(many.changedFiles.length > 0 && many.changedFiles.length <= 200, 'metadata sampling stays bounded');
  assert.equal(many.mutationTrackingDetails.gitAfter, 'partial-path-limit');
  assert.equal(many.mutationUnknown, true, 'bounded returned paths must not imply complete ownership');
  git('checkout', '--detach', 'HEAD');
  const detached = await readGitStatus(repo);
  assert.equal(detached.branch, 'HEAD (no branch)');
  assert.equal(detached.unborn, false);
  assert.equal(detached.repositoryHead, initial.repositoryHead);

  fs.mkdirSync(path.join(plain, 'nested'));
  const outsideCwd = await execute(plainWorkspace, "require('node:fs').writeFileSync('../outside.txt','visible')", { cwd: 'nested' });
  assert.deepEqual(outsideCwd.changedFiles, [], 'arbitrary non-Git commands do not trigger discovery crawls');
  assert.equal(fs.existsSync(path.join(plain, 'outside.txt')), true, 'incomplete accounting does not stop the command');
  assert.equal(outsideCwd.mutationTracking, 'unavailable');
  assert.equal(outsideCwd.mutationUnknown, true);
  assert.equal(outsideCwd.mutationTrackingDetails.gitBefore, 'not-repository');
  fs.mkdirSync(path.join(plain, 'build'));
  fs.writeFileSync(path.join(plain, 'build', 'input.txt'), 'ignored input');
  const excluded = await readFilesystemStatusMap(plainWorkspace);
  assert.equal(excluded.complete, false);
  assert.ok(excluded.reasons.includes('excluded-path'), 'excluded generated-looking inputs remain unknown');

  const flat = path.join(root, 'flat');
  const dirs = path.join(root, 'dirs');
  fs.mkdirSync(flat);
  fs.mkdirSync(dirs);
  for (let i = 0; i < 20; i += 1) {
    fs.writeFileSync(path.join(flat, 'file-' + i), 'x');
    fs.mkdirSync(path.join(dirs, 'dir-' + i));
  }
  const limitedFiles = await readFilesystemStatusMap({ path: flat }, undefined, { maxFiles: 3 });
  assert.equal(limitedFiles.fileCount, 3);
  assert.ok(limitedFiles.reasons.includes('file-limit'));
  const limitedDirs = await readFilesystemStatusMap({ path: dirs }, undefined, { maxEntries: 5 });
  assert.equal(limitedDirs.entryCount, 5);
  assert.equal(limitedDirs.fileCount, 0);
  assert.ok(limitedDirs.reasons.includes('entry-limit'), 'empty directory floods consume the entry budget');
  const full = await readFilesystemStatusMap({ path: flat });
  assert.deepEqual(changedFilesystemFiles(limitedFiles, full).files, [], 'unvisited paths are not false additions');
  assert.deepEqual(changedFilesystemFiles(full, limitedFiles).files, [], 'unvisited paths are not false deletions');

  const originalOpen = fs.promises.opendir;
  try {
    fs.promises.opendir = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return originalOpen(...args);
    };
    const limitedTime = await readFilesystemStatusMap({ path: flat }, undefined, { maxMs: 1 });
    assert.ok(limitedTime.reasons.includes('time-limit'));
    assert.equal(limitedTime.complete, false);
  } finally { fs.promises.opendir = originalOpen; }
  try {
    fs.promises.opendir = async () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); };
    const denied = await readFilesystemStatusMap({ path: flat });
    assert.deepEqual(denied.reasons, ['directory-unreadable']);
    assert.equal(denied.complete, false);
  } finally { fs.promises.opendir = originalOpen; }
  const abort = new AbortController();
  abort.abort(new Error('stop accounting'));
  await assert.rejects(readFilesystemStatusMap({ path: flat }, abort.signal), /stop accounting/);
  await assert.rejects(readGitStatus(repo, { signal: abort.signal }), /stop accounting/);
  console.log('Git snapshots, rename sources, fresh fingerprints and bounded filesystem accounting passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
