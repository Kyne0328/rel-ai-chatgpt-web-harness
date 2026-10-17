import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { createValidationFingerprint } from '../src/bridge/validationPlan.js';
import { relaiVerify } from '../src/bridge/validation.js';
import { recordTaskHistoryEvent, recordWorkflowEvidence, readRecentWorkflowEvidence, flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';

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

  // Inject execution facts only; use the real validation planner, summary,
  // evidence store and reuse path without launching an uncertain process.
  const validationUrl = new URL('../src/bridge/validation.js?termination-fixture', import.meta.url).href;
  const processUrl = new URL('../src/process.js', import.meta.url).href;
  const processStub = 'data:text/javascript,' + encodeURIComponent(
    'export { summarizeCommand } from ' + JSON.stringify(processUrl) + ';' +
    'export async function runProcess() { const f = globalThis.__relaiValidationTerminationFixture; f.calls += 1; return f.result; }'
  );
  const fixture = { calls: 0, result: { executed: true, exitCode: 0, rootExitConfirmed: true,
    terminationConfirmed: false, stdout: '', stderr: '', timedOut: false } };
  globalThis.__relaiValidationTerminationFixture = fixture;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === validationUrl && specifier === '../process.js') return { url: processStub, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  });
  try {
    const { relaiVerify: verifyFixture } = await import(validationUrl);
    hooks.deregister();
    recordTaskHistoryEvent(config, { taskId: 'task-uncertain', taskHistoryEligible: true, taskIdentityVersion: 2,
      taskIdExplicit: true, tool: 'work.begin', workspace: 'repo', ok: true, ts: new Date().toISOString() });
    const uncertain = await verifyFixture(workspace, config, { checks: ['npm:front-end:test'], complete: false }, { taskId: 'task-uncertain' });
    assert.equal(uncertain.ok, false);
    assert.notEqual(uncertain.validationStatus, 'passed');
    assert.equal(uncertain.results[0].exitCode, 0);
    assert.equal(uncertain.results[0].terminationConfirmed, false);
    assert.match(uncertain.nextAction, /termination.*confirmed/i);
    await flushTaskHistoryPersistence();
    assert.equal(readRecentWorkflowEvidence(config, 'task-uncertain', 100).some(item => item.outcome === 'passed'), false,
      'complete:false must not persist a reusable pass from uncertain termination');
    fixture.result = { ...fixture.result, terminationConfirmed: true };
    const settled = await verifyFixture(workspace, config, { checks: ['npm:front-end:test'], complete: false }, { taskId: 'task-uncertain' });
    assert.equal(settled.ok, true);
    assert.equal(settled.executedUnits, 1);
    assert.equal(settled.reusedUnits, 0, 'the earlier uncertain result must not suppress the next check');
    assert.equal(fixture.calls, 2);
  } finally {
    hooks.deregister();
    delete globalThis.__relaiValidationTerminationFixture;
  }

  const inputDirectory = path.join(root, 'untracked-inputs');
  fs.mkdirSync(inputDirectory);
  fs.writeFileSync(path.join(inputDirectory, 'input.txt'), 'before');
  const opaqueBefore = await createValidationFingerprint(workspace, config, { paths: ['source.txt'] });
  fs.writeFileSync(path.join(inputDirectory, 'input.txt'), 'after');
  const opaqueAfter = await createValidationFingerprint(workspace, config, { paths: ['source.txt'] });
  assert.notEqual(opaqueBefore.fingerprint, opaqueAfter.fingerprint, 'an opaque untracked directory must be fingerprinted by its files, not only its name');
  if (process.platform !== 'win32') {
    // Win32 strips trailing spaces at file creation; POSIX preserves this name.
    fs.writeFileSync(path.join(inputDirectory, 'nested-input '), 'non-canonical nested input');
    await assert.rejects(() => createValidationFingerprint(workspace, config, { paths: ['source.txt'] }),
      /fingerprint is incomplete.*non-canonical input path/, 'opaque inventories must reject names that fingerprint normalization would alias');
  }
  fs.rmSync(inputDirectory, { recursive: true });
  const unusualGitInput = path.join(root, ' dependency.txt');
  fs.writeFileSync(unusualGitInput, 'non-canonical repository input');
  await assert.rejects(() => createValidationFingerprint(workspace, config, { paths: ['source.txt'] }),
    /fingerprint is incomplete.*non-canonical input path/, 'Git status must reject names that fingerprint normalization would alias');
  fs.unlinkSync(unusualGitInput);

  const manyPaths = Array.from({ length: 1001 }, (_, index) => `scope-${String(index).padStart(4, '0')}.txt`);
  const observedStatus = { ok: true, changedFiles: [], statusEntries: [], branch: 'fixture', repositoryHead: 'fixture-head' };
  const uncappedBefore = await createValidationFingerprint(workspace, config, { paths: manyPaths, repositoryWide: false, status: observedStatus });
  assert.equal(manyPaths.every(file => uncappedBefore.scopePaths.includes(file)), true, 'no explicit input may silently fall outside the fingerprint');
  fs.writeFileSync(path.join(root, manyPaths.at(-1)), 'last input changed');
  const uncappedAfter = await createValidationFingerprint(workspace, config, { paths: manyPaths, repositoryWide: false, status: observedStatus });
  assert.notEqual(uncappedBefore.fingerprint, uncappedAfter.fingerprint);
  fs.rmSync(path.join(root, manyPaths.at(-1)));
  await assert.rejects(() => createValidationFingerprint(workspace, config, { paths: [], status: { ok: false } }), /fingerprint is incomplete/);

  for (const stateDir of [root, path.dirname(root), ...(process.platform === 'win32' ? [root.toUpperCase()] : [])]) {
    await assert.rejects(() => createValidationFingerprint(workspace, { stateDir }, { paths: [] }),
      /fingerprint is incomplete.*workspace or an ancestor/, 'runtime configuration cannot suppress the entire input tree');
  }
  const runtimeDirectory = path.join(root, 'runtime-meta');
  const runtimeConfig = { stateDir: path.join(runtimeDirectory, 'state'), auditLogPath: path.join(runtimeDirectory, 'audit.jsonl') };
  const beforeRuntime = await createValidationFingerprint(workspace, runtimeConfig, { paths: ['source.txt'] });
  fs.mkdirSync(runtimeConfig.stateDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeConfig.stateDir, 'receipt.json'), '{}');
  fs.writeFileSync(runtimeConfig.auditLogPath, 'runtime audit');
  const afterRuntime = await createValidationFingerprint(workspace, runtimeConfig, { paths: ['source.txt'] });
  assert.equal(afterRuntime.fingerprint, beforeRuntime.fingerprint, 'untracked runtime records must not self-invalidate evidence');
  fs.writeFileSync(path.join(runtimeDirectory, 'generated-input.txt'), 'still an input');
  const afterSibling = await createValidationFingerprint(workspace, runtimeConfig, { paths: ['source.txt'] });
  assert.notEqual(afterSibling.fingerprint, afterRuntime.fingerprint, 'opaque runtime parents must retain generated sibling inputs');
  fs.rmSync(runtimeDirectory, { recursive: true });
  const overlapConfig = { stateDir: path.join(root, 'front-end'), auditLogPath: path.join(root, 'dependency.txt') };
  for (const relative of ['front-end/package.json', 'dependency.txt']) {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file);
    const before = await createValidationFingerprint(workspace, overlapConfig, { paths: ['source.txt'] });
    fs.appendFileSync(file, '\n');
    const after = await createValidationFingerprint(workspace, overlapConfig, { paths: ['source.txt'] });
    assert.notEqual(after.fingerprint, before.fingerprint, 'tracked inputs cannot be hidden by runtime configuration: ' + relative);
    fs.writeFileSync(file, original);
  }

  const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-plain-'));
  try {
    const plainWorkspace = { alias: 'plain', path: plainRoot };
    fs.writeFileSync(path.join(plainRoot, 'owned.js'), 'export const value = 1;\n');
    fs.mkdirSync(path.join(plainRoot, 'inputs'));
    fs.writeFileSync(path.join(plainRoot, 'inputs', 'dependency.txt'), 'before');
    const nestedRuntimeConfig = { stateDir: path.join(plainRoot, 'runtime', 'state'), auditLogPath: path.join(plainRoot, 'runtime', 'audit.log') };
    const beforeNestedRuntime = await createValidationFingerprint(plainWorkspace, nestedRuntimeConfig, { paths: ['owned.js'] });
    fs.mkdirSync(nestedRuntimeConfig.stateDir, { recursive: true });
    fs.writeFileSync(path.join(nestedRuntimeConfig.stateDir, 'receipt.json'), '{}');
    fs.writeFileSync(nestedRuntimeConfig.auditLogPath, 'audit');
    const afterNestedRuntime = await createValidationFingerprint(plainWorkspace, nestedRuntimeConfig, { paths: ['owned.js'] });
    assert.equal(afterNestedRuntime.fingerprint, beforeNestedRuntime.fingerprint, 'new runtime ancestors must not self-invalidate non-Git plans');
    fs.writeFileSync(path.join(plainRoot, 'runtime', 'sibling.txt'), 'observed');
    const afterNestedSibling = await createValidationFingerprint(plainWorkspace, nestedRuntimeConfig, { paths: ['owned.js'] });
    assert.notEqual(afterNestedSibling.fingerprint, afterNestedRuntime.fingerprint, 'non-Git runtime parents must retain sibling inputs');
    fs.unlinkSync(nestedRuntimeConfig.auditLogPath);
    fs.mkdirSync(nestedRuntimeConfig.auditLogPath);
    fs.writeFileSync(path.join(nestedRuntimeConfig.auditLogPath, 'input.txt'), 'first');
    const auditDirectoryBefore = await createValidationFingerprint(plainWorkspace, nestedRuntimeConfig, { paths: ['owned.js'] });
    fs.writeFileSync(path.join(nestedRuntimeConfig.auditLogPath, 'input.txt'), 'second');
    const auditDirectoryAfter = await createValidationFingerprint(plainWorkspace, nestedRuntimeConfig, { paths: ['owned.js'] });
    assert.notEqual(auditDirectoryAfter.fingerprint, auditDirectoryBefore.fingerprint, 'an audit file setting cannot exclude a directory subtree');
    fs.rmSync(path.join(plainRoot, 'runtime'), { recursive: true });
    const plainBefore = await createValidationFingerprint(plainWorkspace, config, { paths: ['owned.js'] });
    fs.writeFileSync(path.join(plainRoot, 'inputs', 'dependency.txt'), 'after');
    const plainAfter = await createValidationFingerprint(plainWorkspace, config, { paths: ['owned.js'] });
    assert.notEqual(plainBefore.fingerprint, plainAfter.fingerprint, 'non-Git dependency changes outside ownership must invalidate evidence');
    fs.mkdirSync(path.join(plainRoot, 'new-empty-input'));
    const plainDirectory = await createValidationFingerprint(plainWorkspace, config, { paths: ['owned.js'] });
    assert.notEqual(plainAfter.fingerprint, plainDirectory.fingerprint, 'empty directory inputs belong to a complete non-Git snapshot');
    const nonCanonical = path.join(plainRoot, ' dependency.txt');
    fs.writeFileSync(nonCanonical, 'unowned non-canonical input');
    await assert.rejects(() => createValidationFingerprint(plainWorkspace, config, { paths: ['owned.js'] }),
      /fingerprint is incomplete.*non-canonical input path/, 'unrepresentable filesystem names must fail closed instead of aliasing missing paths');
    fs.unlinkSync(nonCanonical);
    const oversized = path.join(plainRoot, 'oversized-input');
    const descriptor = fs.openSync(oversized, 'w');
    try { fs.ftruncateSync(descriptor, 128 * 1024 * 1024 + 1); } finally { fs.closeSync(descriptor); }
    await assert.rejects(() => createValidationFingerprint(plainWorkspace, config, { paths: ['owned.js'] }),
      /fingerprint is incomplete.*snapshot budget/, 'oversized snapshots must fail closed, never certify partial coverage');
  } finally { fs.rmSync(plainRoot, { recursive: true, force: true }); }

  execFileSync('git', ['switch', '-c', 'validation-branch'], { cwd: root, stdio: 'ignore' });
  const branchFingerprint = await createValidationFingerprint(workspace, config, { paths: ['front-end/package.json'], repositoryWide: true });
  assert.notEqual(cleanCommitB.fingerprint, branchFingerprint.fingerprint, 'branch changes must invalidate validation evidence even when HEAD is unchanged');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Exact fresh validation evidence reuse tests passed.');
