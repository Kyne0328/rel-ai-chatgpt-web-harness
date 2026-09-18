import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

process.env.REL_AI_MCP_HEAVY_WORK_LIMIT = '2';
process.env.REL_AI_MCP_PERSISTENT_PROCESS_LIMIT = '2';

const {
  acquireHostResource,
  createFairResourceScheduler,
  hostResourceStats
} = await import('../src/hostResourceScheduler.js');
const { runProcess } = await import('../src/process.js');
const { repositoryIntelligence } = await import('../src/repository/intelligence/service.js');
const {
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess
} = await import('../src/processManager.js');

await verifyRoundRobinFairness();
await verifyQueueCancellation();
await verifyExecutionTimeoutExcludesQueueWait();
await verifyRepositoryQueryTimeoutExcludesQueueWait();
await verifyPersistentCapacityIncludesRestartOrphans();

console.log('Host resource scheduling, fairness, timeout, and restart-capacity tests passed.');

async function verifyRoundRobinFairness() {
  const scheduler = createFairResourceScheduler({ heavy: 1 });
  const first = await scheduler.acquire('heavy', 'repo-a');
  const order = [];
  const queued = [
    scheduler.acquire('heavy', 'repo-a').then(lease => finishLease('a2', lease)),
    scheduler.acquire('heavy', 'repo-a').then(lease => finishLease('a3', lease)),
    scheduler.acquire('heavy', 'repo-b').then(lease => finishLease('b1', lease))
  ];
  assert.deepEqual(scheduler.stats().heavy, { limit: 1, active: 1, queued: 3, queuedOwners: 2 });
  first.release();
  await Promise.all(queued);
  assert.deepEqual(order, ['a2', 'b1', 'a3'], 'queued repositories must receive round-robin admission rather than one repository draining its backlog first');
  assert.deepEqual(scheduler.stats().heavy, { limit: 1, active: 0, queued: 0, queuedOwners: 0 });

  function finishLease(name, lease) {
    order.push(name);
    lease.release();
  }
}

async function verifyQueueCancellation() {
  const scheduler = createFairResourceScheduler({ heavy: 1 });
  const first = await scheduler.acquire('heavy', 'repo-a');
  const controller = new AbortController();
  const waiting = scheduler.acquire('heavy', 'repo-b', { signal: controller.signal });
  assert.equal(scheduler.stats().heavy.queued, 1);
  controller.abort(new Error('cancel queued work'));
  await assert.rejects(waiting, error => error?.code === 'HOST_RESOURCE_ABORTED');
  assert.equal(scheduler.stats().heavy.queued, 0, 'cancelled tickets must leave no queue residue');
  first.release();
  assert.equal(scheduler.stats().heavy.active, 0);
}

async function verifyExecutionTimeoutExcludesQueueWait() {
  const blockerA = await acquireHostResource('heavy', 'blocker-a');
  const blockerB = await acquireHostResource('heavy', 'blocker-b');
  const started = performance.now();
  const command = runProcess(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 10)'], {
    resourceClass: 'heavy',
    resourceOwner: 'repo-c',
    queueTimeoutMs: 5000,
    timeout: 3000
  });
  await waitFor(() => hostResourceStats().heavy.queued === 1, 'one-shot command to enter the host queue');
  await sleep(3300);
  blockerA.release();
  const result = await command;
  blockerB.release();

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.queueTimedOut, undefined);
  assert.ok(result.queueWaitMs >= 3000, `expected queue wait to exceed the execution timeout, got ${result.queueWaitMs}ms`);
  assert.ok(performance.now() - started >= 3000, 'the command must actually have waited longer than its execution timeout before admission');
  assert.equal(hostResourceStats().heavy.active, 0);
}

async function verifyRepositoryQueryTimeoutExcludesQueueWait() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-host-ri-'));
  const stateDir = path.join(root, 'state');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'app.js'), 'export function value() { return 42; }\n');
  const workspace = { alias: 'ri-repo', path: workspaceRoot, context: {}, commands: {}, testCommands: {} };
  const config = {
    stateDir,
    repositoryIntelligence: {
      zoektSearchExecutable: path.join(root, 'missing-zoekt-search'),
      zoektIndexExecutable: path.join(root, 'missing-zoekt-index')
    }
  };

  let blockerA;
  let blockerB;
  try {
    await repositoryIntelligence.ensure(workspace, config, { watch: false });
    const warmSummary = await repositoryIntelligence.cachedSummary(workspace, config, {
      queryTimeoutMs: 5000,
      queryQueueTimeoutMs: 5000
    });
    assert.equal(warmSummary?.available, true, 'warm-up must prove the query worker is ready before queue timing is measured');
    blockerA = await acquireHostResource('heavy', 'ri-blocker-a');
    blockerB = await acquireHostResource('heavy', 'ri-blocker-b');
    const query = repositoryIntelligence.cachedSummary(workspace, config, {
      queryTimeoutMs: 1000,
      queryQueueTimeoutMs: 3000
    });
    await waitFor(() => hostResourceStats().heavy.queued === 1, 'Repository Intelligence query to enter the host queue');
    await sleep(1200);
    blockerA.release();
    blockerA = null;
    const summary = await query;
    assert.equal(summary?.available, true);
    assert.equal(summary?.source, 'persistent-code-graph');
  } finally {
    blockerA?.release();
    blockerB?.release();
    await repositoryIntelligence.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  assert.equal(hostResourceStats().heavy.active, 0);
}

async function verifyPersistentCapacityIncludesRestartOrphans() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-host-process-'));
  const stateDir = path.join(root, 'state');
  const staleWorkspaceRoot = path.join(root, 'stale-workspace');
  const workspaceB = { alias: 'repo-b', path: path.join(root, 'repo-b') };
  const workspaceC = { alias: 'repo-c', path: path.join(root, 'repo-c') };
  for (const directory of [staleWorkspaceRoot, workspaceB.path, workspaceC.path]) fs.mkdirSync(directory, { recursive: true });
  const config = { stateDir };
  const principal = { clientId: 'host-resource-test', authMode: 'local' };
  const contextB = { taskId: 'work-b', principal, workspace: workspaceB.alias };
  const contextC = { taskId: 'work-c', principal, workspace: workspaceC.alias };
  const childArgs = ['-e', 'setInterval(() => {}, 1000)'];
  let externalChild = null;

  try {
    externalChild = spawn(process.execPath, childArgs, {
      cwd: staleWorkspaceRoot,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    await once(externalChild, 'spawn');
    const staleProcessId = `proc_${'q'.repeat(24)}`;
    const staleDirectory = path.join(stateDir, 'processes', staleProcessId);
    fs.mkdirSync(staleDirectory, { recursive: true });
    fs.writeFileSync(path.join(staleDirectory, 'stdout.log'), '');
    fs.writeFileSync(path.join(staleDirectory, 'stderr.log'), '');
    fs.writeFileSync(path.join(staleDirectory, 'metadata.json'), JSON.stringify({
      schemaVersion: 2,
      runtimeId: 'previous-runtime',
      processId: staleProcessId,
      workspaceId: 'stale-repo',
      workspacePath: staleWorkspaceRoot,
      lifecycle: 'persistent',
      kind: 'service',
      purpose: 'Restart capacity fixture.',
      commandSummary: 'stale process',
      label: 'stale-process',
      cwd: '.',
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: '',
      exitCode: null,
      signal: '',
      pid: externalChild.pid,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutStartOffset: 0,
      stderrStartOffset: 0,
      environmentKeys: [],
      maxLogBytes: 65536
    }, null, 2));

    await startManagedProcess(workspaceB, config, {
      executable: process.execPath,
      argv: childArgs,
      startupWaitMs: 0,
      kind: 'service',
      purpose: 'Occupy the second host persistent-process slot.'
    }, contextB);
    assert.equal(hostResourceStats().persistent.active, 2, 'a process surviving restart must consume host capacity before a new managed process starts');

    const pendingC = startManagedProcess(workspaceC, config, {
      executable: process.execPath,
      argv: childArgs,
      startupWaitMs: 0,
      kind: 'service',
      purpose: 'Prove a third repository waits for persistent-process capacity.'
    }, contextC);
    await waitFor(() => hostResourceStats().persistent.queued === 1, 'third persistent process to queue');
    assert.equal(hostResourceStats().persistent.active, 2);

    const staleStop = await stopManagedProcess(config, { processId: staleProcessId, graceMs: 250 }, { internal: true });
    assert.equal(staleStop.status, 'stopped');
    const processC = await pendingC;
    assert.equal(processC.status, 'running');
    assert.equal(hostResourceStats().persistent.active, 2, 'releasing one slot must admit exactly one queued repository');
    assert.ok(processC.queueWaitMs >= 0);
    externalChild = null;
  } finally {
    await stopAllManagedProcesses(config).catch(() => {});
    if (externalChild) {
      try { externalChild.kill('SIGKILL'); } catch {}
      await waitForChildExit(externalChild, 3000).catch(() => false);
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  assert.equal(hostResourceStats().persistent.active, 0);
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${description}.`);
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return Promise.race([
    once(child, 'exit').then(() => true),
    sleep(timeoutMs).then(() => false)
  ]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
