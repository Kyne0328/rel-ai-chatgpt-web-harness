import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';

import { relaiApplyPatch, relaiDiff, relaiGitCommit, relaiGitDraftPr, relaiGitPush, relaiRestorePaths, workspaceWrite } from '../src/localRepoBridge.js';
import { workspaceGitStatus } from "../src/repo/gitOps.js";
import { writeSessionPolicy } from "../src/policyResolver.js";
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';
import { checkGitRepository } from '../src/repo/gitClient.ts';

function git(args, options = {}) {
  return execFileSync(GIT_EXECUTABLE, args, options);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-git-workflow-'));
  const remote = path.join(root, 'remote.git');
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  git(['init', '--bare', remote], { stdio: 'ignore' });
  git(['init'], { cwd: workspacePath, stdio: 'ignore' });
  git(['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
  git(['config', 'user.name', 'RelAI Git Smoke'], { cwd: workspacePath });
  fs.writeFileSync(path.join(workspacePath, 'README.md'), '# Git smoke\n');
  git(['add', 'README.md'], { cwd: workspacePath });
  git(['commit', '-m', 'init'], { cwd: workspacePath, stdio: 'ignore' });
  git(['branch', '-M', 'main'], { cwd: workspacePath });
  git(['remote', 'add', 'origin', remote], { cwd: workspacePath });
  git(['push', '-u', 'origin', 'main'], { cwd: workspacePath, stdio: 'ignore' });
  git(['checkout', '-b', 'production'], { cwd: workspacePath, stdio: 'ignore' });
  git(['push', '-u', 'origin', 'production'], { cwd: workspacePath, stdio: 'ignore' });
  git(['checkout', '-b', 'feature/ui-cleanup'], { cwd: workspacePath, stdio: 'ignore' });
  fs.writeFileSync(path.join(workspacePath, 'ui.txt'), 'feature branch\n');
  git(['add', 'ui.txt'], { cwd: workspacePath });
  git(['commit', '-m', 'feature'], { cwd: workspacePath, stdio: 'ignore' });
  git(['push', '-u', 'origin', 'feature/ui-cleanup'], { cwd: workspacePath, stdio: 'ignore' });
  git(['checkout', 'main'], { cwd: workspacePath, stdio: 'ignore' });
  return { root, workspacePath };
}

const { root, workspacePath } = makeRepo();
const nonRepositoryPath = path.join(root, 'not-a-repository');
const nestedRepositoryPath = path.join(workspacePath, 'nested');
fs.mkdirSync(nonRepositoryPath);
fs.mkdirSync(nestedRepositoryPath);
assert.equal(await checkGitRepository(workspacePath), true, 'repository detection accepts the configured worktree');
assert.equal(await checkGitRepository(nestedRepositoryPath), true, 'repository detection accepts nested worktree paths');
assert.equal(await checkGitRepository(nonRepositoryPath), false, 'repository detection rejects an unrelated directory');
assert.equal(await checkGitRepository(path.join(root, 'remote.git')), false, 'bare repositories are not worktrees');

// Repository detection must use its base directory rather than a caller's
// ambient Git selectors. simple-git v4 filters guarded ambient variables.
const guardedEnvironment = {
  GIT_DIR: path.join(workspacePath, '.git'),
  GIT_WORK_TREE: workspacePath,
  VISUAL: path.join(root, 'untrusted-editor')
};
const previousEnvironment = Object.fromEntries(Object.keys(guardedEnvironment).map(key => [key, process.env[key]]));
try {
  Object.assign(process.env, guardedEnvironment);
  assert.equal(await checkGitRepository(workspacePath), true, 'ambient guarded variables must not break valid repository detection');
  assert.equal(await checkGitRepository(nonRepositoryPath), false, 'ambient GIT_DIR and GIT_WORK_TREE must not redirect repository detection');
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// GHSA-v5rq-49vh-5v5c: permitting an environment name is insufficient to
// authorize executable editor values. Use a harmless command so this test
// cannot invoke an editor even if the dependency regresses.
for (const editorName of ['EDITOR', 'VISUAL', 'visual', 'ViSuAl']) {
  const guardedGit = simpleGit({
    baseDir: workspacePath,
    binary: GIT_EXECUTABLE,
    allowEnvironment: [editorName],
    unsafe: { allowUnsafeCustomBinary: true }
  });
  await assert.rejects(
    guardedGit.env({ [editorName]: path.join(root, 'untrusted-editor') }).raw(['--version']),
    /allowUnsafeEditor/,
    `${editorName} must require explicit unsafe-editor authorization`
  );
}
const workspace = {
  alias: 'smoke',
  path: workspacePath,
  testCommands: {},
  commands: {},
  context: { snapshotMaxFiles: 3000 }
};
const config = { stateDir: path.join(root, 'state') };

// Start a session against the clean worktree first — this mirrors the real
// connector flow (a write auto-starts a session before git_status is consulted),
// so files created afterward are correctly attributed as session-owned.
await writeSessionPolicy(config, workspace.alias, { workspaceRoot: workspacePath, taskId: 'task-git-workflow' });
fs.writeFileSync(path.join(workspacePath, 'notes.txt'), 'dirty session note\n');
const status = await workspaceGitStatus(workspace, config, {});
assert.equal(status.ok, true);
assert.equal(status.branch, 'main');
assert.ok(Array.isArray(status.untrackedSessionFiles) && status.untrackedSessionFiles.includes('notes.txt'));
assert.ok(Array.isArray(status.statusEntries) && status.statusEntries.some((item) => item.path === 'notes.txt'));

const implicitTasklessCommit = await relaiGitCommit(workspace, config, { message: 'must choose scope', dryRun: true });
assert.equal(implicitTasklessCommit.ok, false, 'taskless commits must not silently widen to the whole workspace');
assert.match(implicitTasklessCommit.error, /explicit paths|addAll:true/i);
const dryCommit = await relaiGitCommit(workspace, config, { message: 'dry run', addAll: true, dryRun: true });
assert.equal(dryCommit.ok, true);
assert.equal(dryCommit.dryRun, true);
assert.equal(dryCommit.addAll, true);

const dryScopedCommit = await relaiGitCommit(workspace, config, { message: 'dry scoped', paths: ['notes.txt'], dryRun: true });
assert.equal(dryScopedCommit.ok, true);
assert.equal(dryScopedCommit.addAll, false);
assert.deepEqual(dryScopedCommit.paths, ['notes.txt']);

const dryPatch = await relaiApplyPatch(workspace, config, {
  updateText: '--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n # Git smoke\n+dry patch\n',
  dryRun: true
});
assert.equal(dryPatch.ok, true);
assert.equal(dryPatch.dryRun, true);
assert.deepEqual(dryPatch.changedFiles, []);
assert.equal(fs.readFileSync(path.join(workspace.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n'), '# Git smoke\n');

// A path-scoped commit must not absorb unrelated files that another task or the user
// already staged. The unrelated index entry must remain staged after the commit.
fs.writeFileSync(path.join(workspace.path, 'unrelated-staged.txt'), 'keep staged\n');
git(['add', 'unrelated-staged.txt'], { cwd: workspace.path });
const commit = await relaiGitCommit(workspace, config, { message: 'add notes', paths: ['notes.txt'] });
assert.equal(commit.ok, true);
assert.ok(/add notes/.test(JSON.stringify(commit.commit)));
assert.equal(commit.head, git(['rev-parse', 'HEAD'], { cwd: workspace.path }).toString('utf8').trim(), 'successful commits must report the exact created HEAD');
const committedPaths = git(['show', '--name-only', '--format=', 'HEAD'], { cwd: workspace.path }).toString('utf8').split(/\r?\n/).filter(Boolean);
assert.ok(committedPaths.includes('notes.txt'), 'selected path must be included in the commit');
assert.ok(!committedPaths.includes('unrelated-staged.txt'), 'path-scoped commit must exclude unrelated staged files');
const stagedAfterScopedCommit = git(['diff', '--cached', '--name-only'], { cwd: workspace.path }).toString('utf8').split(/\r?\n/).filter(Boolean);
assert.ok(stagedAfterScopedCommit.includes('unrelated-staged.txt'), 'unrelated staged files must remain staged after a path-scoped commit');
git(['reset', 'HEAD', '--', 'unrelated-staged.txt'], { cwd: workspace.path, stdio: 'ignore' });
fs.rmSync(path.join(workspace.path, 'unrelated-staged.txt'), { force: true });

// A logical task commit with no explicit paths must default to its authoritative
// task-owned paths instead of falling back to `git add -A` over a dirty workspace.
fs.writeFileSync(path.join(workspace.path, 'task-owned.txt'), 'task owned\n');
fs.writeFileSync(path.join(workspace.path, 'ambient-staged.txt'), 'ambient staged\n');
git(['add', 'ambient-staged.txt'], { cwd: workspace.path });
const taskScopedCommit = await relaiGitCommit(workspace, config, {
  message: 'task owned default scope',
  _taskOwnedPaths: ['task-owned.txt']
});
assert.equal(taskScopedCommit.ok, true);
assert.equal(taskScopedCommit.addAll, false);
assert.deepEqual(taskScopedCommit.paths, ['task-owned.txt']);
const taskScopedCommitted = git(['show', '--name-only', '--format=', 'HEAD'], { cwd: workspace.path }).toString('utf8').split(/\r?\n/).filter(Boolean);
assert.deepEqual(taskScopedCommitted, ['task-owned.txt'], 'task-scoped default commit must not absorb ambient staged files');
assert.equal(git(['status', '--porcelain=v1', '--', 'task-owned.txt'], { cwd: workspace.path }).toString('utf8').trim(), '', 'committed task-owned paths must be clean in both index and worktree');
assert.equal(git(['diff', '--cached', '--name-only', '--', 'task-owned.txt'], { cwd: workspace.path }).toString('utf8').trim(), '', 'committed task-owned paths must never remain reverse-staged');
assert.equal(git(['diff', '--cached', '--name-only', '--', 'ambient-staged.txt'], { cwd: workspace.path }).toString('utf8').trim(), 'ambient-staged.txt', 'unrelated staged work must remain staged');
git(['reset', 'HEAD', '--', 'ambient-staged.txt'], { cwd: workspace.path, stdio: 'ignore' });
fs.rmSync(path.join(workspace.path, 'ambient-staged.txt'), { force: true });

fs.writeFileSync(path.join(workspace.path, 'must-not-auto-commit.txt'), 'ambient only\n');
const emptyTaskScope = await relaiGitCommit(workspace, config, {
  message: 'must not fall back',
  _taskOwnedPaths: []
});
assert.equal(emptyTaskScope.ok, false);
assert.equal(emptyTaskScope.addAll, false);
assert.match(emptyTaskScope.error, /will not fall back/i);
assert.equal(git(['status', '--porcelain=v1', '--', 'must-not-auto-commit.txt'], { cwd: workspace.path }).toString('utf8').trim().startsWith('??'), true);
fs.rmSync(path.join(workspace.path, 'must-not-auto-commit.txt'), { force: true });

fs.writeFileSync(path.join(workspace.path, 'aggregate-task.txt'), 'task\n');
fs.writeFileSync(path.join(workspace.path, 'aggregate-ambient.txt'), 'ambient\n');
const aggregateDryRun = await relaiGitCommit(workspace, config, {
  message: 'aggregate workspace dry run',
  _taskOwnedPaths: ['aggregate-task.txt'],
  addAll: true,
  dryRun: true
});
assert.equal(aggregateDryRun.ok, true);
assert.equal(aggregateDryRun.addAll, true);
assert.deepEqual(new Set(aggregateDryRun.paths), new Set(['aggregate-ambient.txt', 'aggregate-task.txt']));
const ambiguousAggregate = await relaiGitCommit(workspace, config, {
  message: 'ambiguous workspace selection',
  _taskOwnedPaths: ['aggregate-task.txt'],
  paths: ['aggregate-task.txt'],
  addAll: true
});
assert.equal(ambiguousAggregate.ok, false, 'addAll and explicit paths must not be combined');
assert.match(ambiguousAggregate.error, /cannot combine addAll:true with explicit paths/i);
fs.rmSync(path.join(workspace.path, 'aggregate-task.txt'), { force: true });
fs.rmSync(path.join(workspace.path, 'aggregate-ambient.txt'), { force: true });

const pushDryRun = await relaiGitPush(workspace, config, { remote: 'origin', branch: 'main', dryRun: true });
assert.equal(pushDryRun.ok, true);

// Publishing is derived from the repository itself: unknown remotes and command-executing
// remote-helper transports are refused without a workspace-level allowlist.
await assert.rejects(
  () => relaiGitPush(workspace, config, { remote: 'evil', branch: 'main', dryRun: true }),
  /not configured/,
  'push to a remote that is not configured in the repository must be refused'
);
git(['remote', 'add', 'unsafe', 'ext::sh -c echo'], { cwd: workspace.path });
await assert.rejects(
  () => relaiGitPush(workspace, config, { remote: 'unsafe', branch: 'main', dryRun: true }),
  /unsafe Git remote-helper transport/,
  'push must reject command-executing Git remote-helper transports before invoking git push'
);

// addAll commits must refuse secret-looking staged files (e.g. .env picked up by
// `git add -A`) unless every sensitive path has commit-scoped authorization.
fs.writeFileSync(path.join(workspace.path, '.env'), 'API_KEY=super-secret\n');
const secretCommit = await relaiGitCommit(workspace, config, { message: 'oops secrets', _taskOwnedPaths: [], addAll: true });
assert.equal(secretCommit.ok, false, 'commit with staged .env should be refused');
assert.ok(Array.isArray(secretCommit.secretStagedFiles) && secretCommit.secretStagedFiles.includes('.env'));
assert.equal(secretCommit.indexRestored, true, 'secret refusal must restore the pre-operation index');
assert.match(secretCommit.error, /matching commit authorization/);
assert.equal(git(['diff', '--cached', '--name-only'], { cwd: workspace.path }).toString('utf8').trim(), '', 'secret file must not remain staged');

const secretCommitAllowed = await relaiGitCommit(workspace, config, {
  message: 'intentional env commit',
  _taskOwnedPaths: [],
  addAll: true,
  sensitiveAuthorization: {
    operation: 'commit',
    paths: ['.env'],
    reason: 'The test explicitly approves this environment file.'
  }
});
assert.equal(secretCommitAllowed.ok, true, 'scoped sensitive authorization should permit the commit');
git(['rm', '--cached', '.env'], { cwd: workspace.path, stdio: 'ignore' });
git(['commit', '-m', 'remove env'], { cwd: workspace.path, stdio: 'ignore' });
fs.rmSync(path.join(workspace.path, '.env'), { force: true });

const draftPr = await relaiGitDraftPr(workspace, config, { head: 'feature/ui-cleanup' });
assert.equal(draftPr.ok, true);
assert.equal(draftPr.base, 'main', 'draft PR base branch must be detected from Git without workspace configuration');
assert.equal(draftPr.draftOnly, true);
assert.equal(draftPr.remoteChanged, false);
assert.equal(draftPr.deprecated, undefined);
assert.ok(draftPr.changedFiles.includes('ui.txt'));
assert.match(draftPr.title, /feature\/ui-cleanup/);
assert.match(draftPr.body, /ui\.txt/);

const emptyPr = await relaiGitDraftPr(workspace, config, { base: 'main', head: 'main' });
assert.equal(emptyPr.ok, false);
assert.equal(emptyPr.emptyDiff, true);
assert.equal(emptyPr.remoteChanged, false);
assert.match(emptyPr.warning, /No diff/);

// Path-scoped restore is tracked-only and rejects untracked paths.
fs.mkdirSync(path.join(workspace.path, 'tmp'), { recursive: true });
const untrackedRel = 'tmp/restore-untracked.txt';
fs.writeFileSync(path.join(workspace.path, untrackedRel), 'disposable\n');
const restoreNoClean = await relaiRestorePaths(workspace, config, { paths: [untrackedRel] });
assert.equal(restoreNoClean.ok, false, 'tracked path restore must reject an untracked path');
fs.rmSync(path.join(workspace.path, untrackedRel), { force: true });

assert.throws(() => workspaceWrite(workspace, config, { path: 'collapsed.js', content: 'const value = 1;'.repeat(400) }), /collapsed source-looking content/);

// Tracked-modified file: restore reverts it (regression: paths-mode still works).
fs.writeFileSync(path.join(workspace.path, 'README.md'), '# Git smoke\nlocal edit\n');
const restoreTracked = await relaiRestorePaths(workspace, config, { paths: ['README.md'] });
assert.equal(restoreTracked.ok, true, 'tracked file restore should succeed');
const revertedReadme = fs.readFileSync(path.join(workspace.path, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
assert.equal(revertedReadme, '# Git smoke\n', 'README reverted');

fs.writeFileSync(path.join(workspace.path, 'untracked-review.txt'), 'review this content\n');
const untrackedReview = await relaiDiff(workspace, config, { path: 'untracked-review.txt' });
assert.match(untrackedReview.diff, /new file mode/);
assert.match(untrackedReview.diff, /\+review this content/);

fs.rmSync(root, { recursive: true, force: true });
console.log('Git workflow smoke test passed.');
