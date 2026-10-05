import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cachedRepositoryBuildState, compareRuntimeBuildToRepository, createRuntimeBuildIdentityReader } from '../src/runtimeBuildIdentity.js';
import { readRepositoryBuildState } from '../src/buildProvenance.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-source-comparison-'));
function git(...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
try {
  git('init', '--quiet');
  git('config', 'user.name', 'RelAI Test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'implementation.js'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'test source');
  const original = await readRepositoryBuildState(root);
  const identity = { ...original, buildId: original.sourceFingerprint.slice(0, 12) };
  assert.equal(cachedRepositoryBuildState(root), undefined, 'status must not measure checkout bytes implicitly');
  const [first, concurrent] = await Promise.all([
    compareRuntimeBuildToRepository(identity, root), compareRuntimeBuildToRepository(identity, root)
  ]);
  assert.equal(first.status, 'matches');
  assert.equal(first.repositoryBuildState, concurrent.repositoryBuildState, 'concurrent explicit requests must share a single measurement');
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
  assert.equal(cachedRepositoryBuildState(root), first.repositoryBuildState);
  fs.writeFileSync(path.join(root, 'implementation.js'), 'export const value = 2;\n');
  const cached = await compareRuntimeBuildToRepository(identity, root);
  assert.equal(cached.repositoryBuildState, first.repositoryBuildState, 'repeat requests use a timestamped snapshot until explicit refresh');
  const refreshed = await compareRuntimeBuildToRepository(identity, root, { refresh: true });
  assert.equal(refreshed.status, 'different');
  assert.equal(refreshed.repositoryBuildState.dirty, true);
  assert.equal(refreshed.repositoryBuildState.sourceRevision, identity.sourceRevision, 'unchanged commit/version does not imply unchanged implementation');
  assert.notEqual(refreshed.repositoryBuildState.sourceFingerprint, identity.sourceFingerprint);
  assert.equal(cachedRepositoryBuildState(root), refreshed.repositoryBuildState);
  const incorrectVersion = createRuntimeBuildIdentityReader({ packageRoot: root, expectedVersion: '2.0.0',
    readFile: () => JSON.stringify({ schemaVersion: 1, version: '1.0.0', builtAt: new Date().toISOString(), ...original }) })('schema');
  assert.equal(incorrectVersion.state, 'unavailable', 'provenance for another package version must not identify the launched package');
  console.log('Explicit source comparison is measured once, timestamped, cached, concurrent-safe, and refreshable.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
