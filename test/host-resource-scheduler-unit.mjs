import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';

process.env.REL_AI_MCP_PERSISTENT_PROCESS_LIMIT = '2';
process.env.REL_AI_MCP_HEAVY_PROCESS_LIMIT = '1';
process.env.REL_AI_MCP_REPOSITORY_QUERY_LIMIT = '6';

process.env.REL_AI_MCP_PERSISTENT_QUEUE_TIMEOUT_MS = '1000';
await import('./host-memory-pressure-unit.js');
const restoreHostMemory = installDeterministicHostMemory();

const {
  acquireHostResource,
  createFairResourceScheduler,
  hostResourceStats
} = await import('../src/hostResourceScheduler.js');
const { readProcessCreationIdentity, runProcess } = await import('../src/process.js');
const { repositoryIntelligence } = await import('../src/repository/intelligence/service.js');
const {
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess
} = await import('../src/processManager.js');

try {
  await verifyRoundRobinFairness();
  await verifyQueueCancellation();
  await verifyProcessDeadlineQueue();
  await verifyBoundedHeavyAdmission();
  await verifyQueuedIndexDetach();
  await verifyDefaultPersistentQueueTimeout();
  await verifyRepositoryQueryTimeoutExcludesQueueWait();
  await verifyPersistentCapacityIncludesRestartOrphans();
} finally {
  restoreHostMemory();
}

console.log('Host resource scheduling, bounded heavy execution, fairness, timeout, and restart-capacity tests passed.');

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


async function verifyProcessDeadlineQueue() {
  const first = await acquireHostResource('persistent', 'deadline-blocker-a');
  const second = await acquireHostResource('persistent', 'deadline-blocker-b');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-queue-deadline-'));
  const marker = path.join(root, 'must-not-start');
  try {
    const result = await runProcess(process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', marker],
      { cwd: root, resourceClass: 'persistent', resourceOwner: 'deadline-waiter', signal: AbortSignal.timeout(50) });
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.terminationConfirmed, true);
    assert.equal(result.forcedTermination, false);
    assert.equal(result.durationMs, 0);
    assert.equal(fs.existsSync(marker), false, 'queued deadline must not launch a child');
    assert.equal(hostResourceStats().persistent.queued, 0);
  } finally {
    first.release();
    second.release();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function verifyBoundedHeavyAdmission() {
  const blocker = await acquireHostResource('heavy', 'bounded-a');
  try {
    assert.deepEqual(hostResourceStats().heavy, { limit: 1, active: 1, queued: 0, queuedOwners: 0 });
    const result = await runProcess(process.execPath, ['-e', 'process.exit(0)'], {
      resourceClass: 'heavy', resourceOwner: 'bounded-b', queueTimeoutMs: 20, timeout: 3000
    });
    assert.equal(result.executed, false, 'heavy admission waits before spawning a child');
    assert.equal(result.queueTimedOut, true);
    assert.deepEqual(hostResourceStats().heavy, { limit: 1, active: 1, queued: 0, queuedOwners: 0 });
  } finally {
    blocker.release();
  }
  assert.deepEqual(hostResourceStats().heavy, { limit: 1, active: 0, queued: 0, queuedOwners: 0 });
}

async function verifyQueuedIndexDetach() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-index-admission-cancel-'));
  const workspace = { alias: 'queued-index', path: path.join(root, 'repo'), context: {} };
  const config = { stateDir: path.join(root, 'state') };
  fs.mkdirSync(workspace.path, { recursive: true });
  fs.writeFileSync(path.join(workspace.path, 'app.js'), 'export const value = 1;\n');
  const blocker = await acquireHostResource('heavy', 'index-blocker');
  let pending;
  try {
    pending = repositoryIntelligence.ensure(workspace, config, { watch: false });
    const rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'INDEX_ABORTED');
    await waitFor(() => hostResourceStats().heavy.queued === 1, 'index admission to queue');
    const detached = await repositoryIntelligence.dispose(workspace, config);
    assert.equal(detached.ok, true);
    await rejected;
    assert.equal(hostResourceStats().heavy.queued, 0, 'detaching a workspace removes its queued index before spawning');
    assert.equal(hostResourceStats().heavy.active, 1, 'only the blocker retains admission');
  } finally {
    blocker.release();
    await pending?.catch(() => {});
    await repositoryIntelligence.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function verifyDefaultPersistentQueueTimeout() {
  const blockerA = await acquireHostResource('persistent', 'persistent-timeout-a');
  const blockerB = await acquireHostResource('persistent', 'persistent-timeout-b');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-host-persistent-timeout-'));
  const workspace = { alias: 'persistent-timeout-c', path: root };
  try {
    await assert.rejects(
      startManagedProcess(workspace, { stateDir: path.join(root, 'state') }, {
        executable: process.execPath,
        argv: ['-e', 'setInterval(() => {}, 1000)'],
        startupWaitMs: 0,
        kind: 'service',
        purpose: 'Verify bounded persistent-process admission.'
      }, {
        taskId: 'persistent-timeout-task',
        principal: { clientId: 'persistent-timeout-test', authMode: 'local' },
        workspace: workspace.alias
      }),
      error => error?.code === 'HOST_PROCESS_CAPACITY_EXHAUSTED'
        && error.retryable === true
        && error.active === 2
        && error.limit === 2
    );
    assert.equal(hostResourceStats().persistent.queued, 0,
      'timed-out persistent-process admission must leave no queue residue');
  } finally {
    blockerA.release();
    blockerB.release();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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

  const blockers = [];
  try {
    await repositoryIntelligence.ensure(workspace, config, { watch: false });
    const warmSummary = await repositoryIntelligence.cachedSummary(workspace, config, {
      queryTimeoutMs: 5000,
      queryQueueTimeoutMs: 5000
    });
    assert.equal(warmSummary?.available, true, 'warm-up must prove the query worker is ready before queue timing is measured');
    const heavy = await acquireHostResource('heavy', 'build-blocker');
    try {
      const independent = await repositoryIntelligence.cachedSummary(workspace, config, { queryTimeoutMs: 1000, queryQueueTimeoutMs: 1000 });
      assert.equal(independent.available, true, 'repository reads run while the heavy command lane is fully occupied');
      assert.equal(hostResourceStats().heavy.queued, 0);
      assert.equal(hostResourceStats().repositoryQuery.limit, 6, 'query concurrency is configurable above four');
    } finally { heavy.release(); }
    for (let index = 0; index < hostResourceStats().repositoryQuery.limit; index += 1) {
      blockers.push(await acquireHostResource('repositoryQuery', `ri-blocker-${index}`));
    }
    const query = repositoryIntelligence.cachedSummary(workspace, config, {
      queryTimeoutMs: 1000,
      queryQueueTimeoutMs: 3000
    });
    await waitFor(() => hostResourceStats().repositoryQuery.queued === 1, 'Repository Intelligence query to enter the host queue');
    await sleep(1200);
    blockers.shift()?.release();
    const summary = await query;
    assert.equal(summary?.available, true);
    assert.equal(summary?.source, 'persistent-code-graph');
  } finally {
    for (const blocker of blockers) blocker.release();
    await repositoryIntelligence.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  assert.equal(hostResourceStats().repositoryQuery.active, 0);
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
    const externalCreationIdentity = await readProcessCreationIdentity(externalChild.pid);
    assert.ok(externalCreationIdentity, 'restart-capacity fixture requires a verifiable OS process creation identity');
    const staleProcessId = `proc_${'q'.repeat(24)}`;
    const staleDirectory = path.join(stateDir, 'processes', staleProcessId);
    fs.mkdirSync(staleDirectory, { recursive: true });
    fs.writeFileSync(path.join(staleDirectory, 'stdout.log'), '');
    fs.writeFileSync(path.join(staleDirectory, 'stderr.log'), '');
    fs.writeFileSync(path.join(staleDirectory, 'metadata.json'), JSON.stringify({
      schemaVersion: 4,
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
      processCreationIdentity: externalCreationIdentity,
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
