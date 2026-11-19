// Offline PR preparation: remote-tracking refs come only from fixture-local Git.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { relaiGitDraftPr } from '../../src/repo/gitOps.js';
import { GIT_EXECUTABLE } from '../helpers/git-executable.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-draft-base-'));
const workspace = { alias: 'draft', path: path.join(root, 'repo') };
fs.mkdirSync(workspace.path);
const git = (...args) => execFileSync(GIT_EXECUTABLE, ['-c', 'user.name=Fixture', '-c',
  'user.email=fixture@example.test', ...args], { cwd: workspace.path, stdio: 'pipe', encoding: 'utf8' }).trim();
const commit = filename => {
  fs.writeFileSync(path.join(workspace.path, filename), filename + '\n');
  git('add', '--', filename);
  git('commit', '-qm', 'Fixture file ' + filename);
  return git('rev-parse', 'HEAD');
};
const draft = (args = {}) => relaiGitDraftPr(workspace, { stateDir: path.join(root, 'state') }, args);
try {
  git('init', '-q', '--initial-branch=trunk');
  const original = commit('base.txt');
  git('checkout', '-q', '--detach');
  const upstream = commit('upstream.txt');
  git('remote', 'add', 'origin', path.join(root, 'unused-remote'));
  git('update-ref', 'refs/remotes/origin/trunk', upstream);
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  commit('feature.txt');
  const stale = await draft();
  assert.equal(stale.ok, true);
  assert.equal(stale.base, 'trunk');
  assert.equal(stale.remoteChanged, false);
  assert.deepEqual(stale.changedFiles, ['feature.txt']);
  assert.deepEqual((await draft({ base: 'trunk' })).changedFiles, ['feature.txt', 'upstream.txt']);
  git('update-ref', '-d', 'refs/heads/trunk');
  assert.deepEqual((await draft()).changedFiles, ['feature.txt'], 'a cached default branch need not be checked out locally');

  git('update-ref', '-d', 'refs/remotes/origin/trunk');
  const dangling = await draft();
  assert.equal(dangling.ok, false);
  assert.match(dangling.error, /no cached commit.*origin\/trunk/i);
  git('symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  git('update-ref', 'refs/heads/main', original);
  const local = await draft();
  assert.equal(local.base, 'main');
  assert.match(local.warning, /no cached remote default branch/i);
  assert.deepEqual(local.changedFiles, ['feature.txt', 'upstream.txt']);
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log('Detached PR drafts use the cached upstream commit and disclose local-only fallback.');
