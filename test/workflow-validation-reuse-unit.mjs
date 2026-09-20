import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createValidationFingerprint } from '../src/bridge/validationPlan.js';
import { relaiVerify } from '../src/bridge/validation.js';
import { recordTaskHistoryEvent, recordWorkflowEvidence } from '../src/taskHistoryStore.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-reuse-'));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-state-'));
const config = { stateDir: stateRoot };
try {
  fs.mkdirSync(path.join(root, 'front-end'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dependency.txt'), 'good-2');
  fs.writeFileSync(path.join(root, 'source.txt'), 'v1');
  fs.writeFileSync(path.join(root, 'front-end', 'package.json'), JSON.stringify({ scripts: {
    test: `node -e "const fs=require('fs');fs.writeFileSync('duplicate-marker.txt','ran');process.exit(fs.readFileSync('../dependency.txt','utf8')==='good'?0:1)"`
  } }));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  const workspace = { alias: 'repo', path: root, commands: {}, testCommands: {} };
  const fingerprint = (await createValidationFingerprint(workspace, config, { repositoryWide: true })).fingerprint;
  recordTaskHistoryEvent(config, { taskId: 'task-1', taskHistoryEligible: true, taskIdentityVersion: 2, taskIdExplicit: true, tool: 'work.begin', workspace: 'repo', ok: true, ts: new Date().toISOString() });
  recordWorkflowEvidence(config, 'task-1', {
    version: 1, key: 'check:front', kind: 'check', sourceTool: 'relai_exec', createdAt: new Date().toISOString(),
    commandId: 'npm:front-end:test', command: 'npm test', cwd: 'front-end', outcome: 'passed', repositoryFingerprint: fingerprint,
    mutationGeneration: 0, workspaceGeneration: 0, paths: [], metadata: { exitCode: 0 }
  });
  const result = await relaiVerify(workspace, config, { checks: ['npm:front-end:test'] }, { taskId: 'task-1' });
  assert.equal(result.ok, true);
  assert.equal(result.executedUnits, 0);
  assert.equal(result.reusedUnits, 1);
  assert.deepEqual(result.reusedChecks, ['npm:front-end:test']);
  assert.equal(fs.existsSync(path.join(root, 'front-end', 'duplicate-marker.txt')), false, 'exact fresh evidence must avoid duplicate execution');
  assert.equal(JSON.stringify(result).includes('stdout'), false, 'reused evidence must not replay prior stdout');

  const explicitCommand = `node -e "require('fs').writeFileSync('explicit-marker.txt','ran')"`;
  const explicitFingerprint = (await createValidationFingerprint(workspace, config)).fingerprint;
  recordTaskHistoryEvent(config, { taskId: 'task-explicit', taskHistoryEligible: true, taskIdentityVersion: 2, taskIdExplicit: true, tool: 'work.begin', workspace: 'repo', ok: true, ts: new Date().toISOString() });
  recordWorkflowEvidence(config, 'task-explicit', {
    version: 1, key: 'check:explicit', kind: 'check', sourceTool: 'relai_exec', createdAt: new Date().toISOString(),
    commandId: 'explicit:0', command: explicitCommand, cwd: '.', outcome: 'passed', repositoryFingerprint: explicitFingerprint,
    mutationGeneration: 0, workspaceGeneration: 0, paths: [], metadata: { exitCode: 0 }
  });
  const explicitResult = await relaiVerify(workspace, config, { checks: [explicitCommand] }, { taskId: 'task-explicit' });
  assert.equal(explicitResult.executedUnits, 1, 'arbitrary explicit checks must execute instead of reusing evidence with an unknowable input boundary');
  assert.equal(explicitResult.reusedUnits, 0);
  assert.equal(fs.existsSync(path.join(root, 'explicit-marker.txt')), true);
  fs.rmSync(path.join(root, 'explicit-marker.txt'), { force: true });

  fs.writeFileSync(path.join(root, 'dependency.txt'), 'bad');
  const staleInput = await relaiVerify(workspace, config, { checks: ['npm:front-end:test'] }, { taskId: 'task-1' });
  assert.equal(staleInput.ok, false, 'a changed dependency outside the task-owned scope must invalidate reused validation evidence');
  assert.equal(staleInput.executedUnits, 1);
  assert.equal(staleInput.reusedUnits, 0);
  assert.equal(fs.existsSync(path.join(root, 'front-end', 'duplicate-marker.txt')), true, 'stale evidence must execute the check again');

  fs.rmSync(path.join(root, 'front-end', 'duplicate-marker.txt'), { force: true });
  fs.writeFileSync(path.join(root, 'dependency.txt'), 'dirty-a');
  const dirtyA = await createValidationFingerprint(workspace, config, { paths: ['front-end/package.json'], repositoryWide: true });
  fs.writeFileSync(path.join(root, 'dependency.txt'), 'dirty-b');
  const dirtyB = await createValidationFingerprint(workspace, config, { paths: ['front-end/package.json'], repositoryWide: true });
  assert.notEqual(dirtyA.fingerprint, dirtyB.fingerprint, 'content changes to an already-dirty repository input must change the fingerprint');

  fs.writeFileSync(path.join(root, 'dependency.txt'), 'good');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'dependency update'], { cwd: root, stdio: 'ignore' });
  const cleanCommitA = await createValidationFingerprint(workspace, config, { paths: ['front-end/package.json'], repositoryWide: true });
  fs.writeFileSync(path.join(root, 'source.txt'), 'v2');
  execFileSync('git', ['add', 'source.txt'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'source update'], { cwd: root, stdio: 'ignore' });
  const cleanCommitB = await createValidationFingerprint(workspace, config, { paths: ['front-end/package.json'], repositoryWide: true });
  assert.notEqual(cleanCommitA.fingerprint, cleanCommitB.fingerprint, 'different clean repository HEADs must not share validation evidence');

  execFileSync('git', ['switch', '-c', 'validation-branch'], { cwd: root, stdio: 'ignore' });
  const branchFingerprint = await createValidationFingerprint(workspace, config, { paths: ['front-end/package.json'], repositoryWide: true });
  assert.notEqual(cleanCommitB.fingerprint, branchFingerprint.fingerprint, 'branch changes must invalidate validation evidence even when HEAD is unchanged');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Exact fresh validation evidence reuse tests passed.');