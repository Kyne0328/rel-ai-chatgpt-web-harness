// Memory probes are informational. Queue protection tests cover occupied slots only.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';
import { installForcedLowHostMemory } from './helpers/forced-low-host-memory.mjs';
import { createFairResourceScheduler, acquireHostResources, hostResourceDiagnosticSnapshot, refreshHostResourceDiagnostics } from '../src/hostResourceScheduler.js';
import { createHostMemoryMonitor } from '../src/hostMemoryPressure.js';
const GIB = 1024 ** 3;
await verifyOwnerFairness();
await verifyBoundedQueuesAndDeadlines();
await verifyCancellationRaces();
await verifyMonitorSingleFlight();
await verifyOperatingSystemSampling();
await verifyMemoryNeverGatesWork();
console.log('Informational host memory, concurrency fairness, deadlines, and cancellation passed.');

async function verifyOwnerFairness() {
  const scheduler = createFairResourceScheduler({ heavy: 1 });
  const first = await scheduler.acquire('heavy', 'repo-a');
  const order = [];
  const waiting = [['repo-a', 'a2'], ['repo-a', 'a3'], ['repo-b', 'b1']].map(([owner, label]) =>
    scheduler.acquire('heavy', owner).then(lease => { order.push(label); lease.release(); }));
  first.release();
  await Promise.all(waiting);
  assert.deepEqual(order, ['a2', 'b1', 'a3']);
  scheduler.dispose();
}


async function verifyBoundedQueuesAndDeadlines() {
  const scheduler = createFairResourceScheduler({ heavy: 1 }, { maxQueued: 2, maxQueuedPerOwner: 1 });
  const blocker = await scheduler.acquire('heavy', 'blocker');
  const a = scheduler.acquire('heavy', 'a', { deadlineAtMs: Date.now() + 15, timeoutMs: 1000 });
  await assert.rejects(scheduler.acquire('heavy', 'a'), error => error.code === 'HOST_RESOURCE_QUEUE_FULL' && error.retryable);
  const b = scheduler.acquire('heavy', 'b', { timeoutMs: 20 });
  await assert.rejects(scheduler.acquire('heavy', 'c'), error => error.code === 'HOST_RESOURCE_QUEUE_FULL');
  await Promise.all([
    assert.rejects(a, error => error.code === 'HOST_RESOURCE_QUEUE_TIMEOUT'),
    assert.rejects(b, error => error.code === 'HOST_RESOURCE_QUEUE_TIMEOUT')
  ]);
  assert.equal(scheduler.stats().heavy.queued, 0);
  blocker.release();
  await assert.rejects(scheduler.acquire('heavy', 'expired', { deadlineAtMs: Date.now() - 1 }),
    error => error.code === 'HOST_RESOURCE_QUEUE_TIMEOUT');
  assert.equal(scheduler.stats().heavy.active, 0);
  scheduler.dispose();
}


async function verifyCancellationRaces() {
  const scheduler = createFairResourceScheduler({ heavy: 1 });
  for (let index = 0; index < 20; index += 1) {
    const blocker = await scheduler.acquire('heavy', 'first');
    const controller = new AbortController();
    const pending = scheduler.acquireMany(['heavy'], 'second', { signal: controller.signal });
    controller.abort(new Error('cancel queued'));
    blocker.release();
    await assert.rejects(pending, error => error.code === 'HOST_RESOURCE_ABORTED');
    assert.deepEqual(scheduler.stats().heavy, { limit: 1, active: 0, queued: 0, queuedOwners: 0 });
  }
  const admittedController = new AbortController();
  const admitted = await scheduler.acquire('heavy', 'running', { signal: admittedController.signal });
  admittedController.abort();
  assert.equal(scheduler.stats().heavy.active, 1, 'cancelling a running job cannot release its resources before cleanup confirms exit');
  admitted.release();
  scheduler.dispose();
}


async function verifyMonitorSingleFlight() {
  let clock = 1000;
  let calls = 0;
  let finish;
  const monitor = createHostMemoryMonitor({
    now: () => clock, intervalMs: 5000, staleMs: 15000,
    sample: () => { calls += 1; return new Promise(resolve => { finish = resolve; }); }
  });
  assert.equal(monitor.snapshot().sampledAtMs, null);
  const first = monitor.refresh();
  const second = monitor.refresh();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ sampledAtMs: clock, physicalTotalBytes: 8 * GIB, physicalAvailableBytes: 4 * GIB });
  await first;
  await monitor.refresh();
  assert.equal(calls, 1, 'repeat refresh respects low-rate probe budget');
  clock += 16_000;
  assert.equal(monitor.snapshot().stale, true);
  monitor.dispose();
  await monitor.refresh();
  assert.equal(calls, 1, 'disposed monitor never starts another probe');
}


async function verifyOperatingSystemSampling() {
  const restore = installDeterministicHostMemory();
  const previousSecret = process.env.REL_AI_NATIVE_PROBE_SECRET;
  const previousModulePath = process.env.PSModulePath;
  process.env.REL_AI_NATIVE_PROBE_SECRET = 'synthetic-test-secret';
  process.env.PSModulePath = 'untrusted-test-module-location';
  const originalExecFile = childProcess.execFile;
  let nativeProbeChecked = false;
  childProcess.execFile = function (executable, args, options, callback) {
    if (args.some(value => String(value).includes('Win32_PerfFormattedData_PerfOS_Memory'))) {
      assert.equal(options.env?.REL_AI_NATIVE_PROBE_SECRET, undefined, 'native probes cannot inherit arbitrary secrets');
      assert.equal(options.env?.NODE_OPTIONS, undefined);
      assert.equal(options.env?.PSModulePath, path.join(path.dirname(executable), 'Modules'), 'native probe uses only trusted PowerShell modules');
      nativeProbeChecked = true;
    }
    return originalExecFile.call(this, executable, args, options, callback);
  };
  syncBuiltinESMExports();
  const monitor = createHostMemoryMonitor();
  try {
    const sample = await monitor.refresh();
    if (process.platform === 'win32') assert.equal(nativeProbeChecked, true);
    assert.equal(sample.physicalTotalBytes, 16 * GIB);
    assert.equal(sample.physicalAvailableBytes, 12 * GIB);
    assert.equal(sample.stale, false);
    assert.equal(sample.error, null);
    if (process.platform === 'win32' || process.platform === 'linux') {
      assert.equal(sample.commitLimitBytes, 16 * GIB);
      assert.equal(sample.commitAvailableBytes, 15 * GIB);
    }
    assert.equal(sample.pagesInputPerSecond, null, 'missing paging counters stay unknown');
  } finally {
    monitor.dispose();
    childProcess.execFile = originalExecFile;
    syncBuiltinESMExports();
    restore();
    if (previousSecret === undefined) delete process.env.REL_AI_NATIVE_PROBE_SECRET;
    else process.env.REL_AI_NATIVE_PROBE_SECRET = previousSecret;
    if (previousModulePath === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = previousModulePath;
  }
}



async function verifyMemoryNeverGatesWork() {
  const restore = installForcedLowHostMemory();
  const leases = [];
  try {
    const before = hostResourceDiagnosticSnapshot().pressure.sampledAtMs;
    for (let index = 0; index < hostResourceDiagnosticSnapshot().lanes.heavy.limit; index++) {
      leases.push(await acquireHostResources(['heavy'], 'low-memory', { timeoutMs: 100 }));
    }
    assert.equal(hostResourceDiagnosticSnapshot().pressure.sampledAtMs, before, 'execution never starts a memory probe');
    for (const lease of leases.splice(0)) lease.release();
    const sample = await refreshHostResourceDiagnostics();
    assert.equal(sample.pressure.admissionEnforced, false);
    assert.equal(sample.pressure.physicalAvailableBytes, 64 * 1024 ** 2);
    const startup = await acquireHostResources(['persistent', 'heavy'], 'low-memory', { timeoutMs: 100 });
    startup.releaseResource('heavy');
    const next = await acquireHostResources(['heavy'], 'next', { timeoutMs: 100 });
    next.release();
    startup.release();
    const unavailable = createHostMemoryMonitor({ sample: () => { throw new Error('Memory probe unavailable'); } });
    await unavailable.refresh();
    const scheduler = createFairResourceScheduler({ heavy: 1 });
    const lease = await scheduler.acquire('heavy', 'unknown-memory', { timeoutMs: 100 });
    lease.release();
    scheduler.dispose();
    unavailable.dispose();
  } finally {
    for (const lease of leases) lease.release();
    restore();
  }
}
