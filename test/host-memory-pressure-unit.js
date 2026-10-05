import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';
import { createFairResourceScheduler, hostResourceDiagnosticSnapshot } from '../src/hostResourceScheduler.js';
import { createHostMemoryMonitor, createMemoryAdmissionController, estimateProcessReservationBytes } from '../src/hostMemoryPressure.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

await verifyLowHeadroomCostClasses();
verifyCostEstimates();
await verifyOwnerFairness();
await verifyMemoryReservations();
await verifyPersistentStartupSettling();
await verifyConfirmedStopSettlingRelease();
await verifyPressureRecoveryAndProtectedLanes();
await verifyAtomicAdmission();
await verifyBoundedQueuesAndDeadlines();
await verifyCancellationRaces();
await verifyMonitorSingleFlight();
await verifyOperatingSystemSampling();
verifyUnknownMetrics();
verifyLinuxAdvisoryCommit();
verifyBoundedDiagnostics();

console.log('Host pressure admission: reservations, hysteresis, atomic lanes, cancellation, deadlines, bounded queues, and single-flight sampling passed.');

function fixture(overrides = {}) {
  let clock = 10_000;
  let memory = {
    sampledAtMs: clock, ageMs: 0, stale: false, sampling: false,
    physicalTotalBytes: 8 * GIB, physicalAvailableBytes: 6 * GIB,
    physicalAvailableKind: 'available',
    commitLimitBytes: 16 * GIB, commitUsedBytes: 4 * GIB,
    commitAvailableBytes: 12 * GIB, commitEnforced: true,
    source: 'test', error: null, ...overrides
  };
  const monitor = { snapshot: () => ({ ...memory }) };
  const admission = createMemoryAdmissionController({ monitor, now: () => clock, reservationBytes: 768 * MIB });
  return {
    admission,
    set(value) { clock += 5000; memory = { ...memory, ...value, sampledAtMs: clock }; },
    scheduler(limits = { heavy: 8, repositoryQuery: 4, persistent: 2 }) {
      return createFairResourceScheduler(limits, { admission });
    }
  };
}

async function verifyLowHeadroomCostClasses() {
  let sample = { sampledAtMs: 1000, stale: false, physicalTotalBytes: 15.6 * GIB,
    physicalAvailableBytes: 1.5 * GIB, commitEnforced: true, commitLimitBytes: 40 * GIB,
    commitAvailableBytes: 12 * GIB };
  const admission = createMemoryAdmissionController({ monitor: { snapshot: () => ({ ...sample }) } });
  const scheduler = createFairResourceScheduler({ heavy: 4 }, { admission });
  const controller = new AbortController();
  let largeStarted = false;
  const large = scheduler.acquire('heavy', 'large', { reservationBytes: 768 * MIB, signal: controller.signal })
    .then(lease => { largeStarted = true; return lease; });
  const small = await scheduler.acquire('heavy', 'small', { reservationBytes: 128 * MIB });
  assert.equal(largeStarted, false, 'a large queued job must not block an affordable job from another owner');
  small.release();
  sample = { ...sample, sampledAtMs: 2000, physicalAvailableBytes: 3 * GIB };
  scheduler.pump();
  (await large).release();
  sample = { ...sample, sampledAtMs: 3000, physicalAvailableBytes: GIB };
  assert.equal(admission.diagnostics().state, 'pressured');
  sample = { ...sample, sampledAtMs: 4000, physicalAvailableBytes: 1.5 * GIB };
  admission.diagnostics();
  sample = { ...sample, sampledAtMs: 5000 };
  admission.diagnostics();
  assert.equal(admission.diagnostics().state, 'normal', 'small recovery gap avoids requiring 14% of all RAM');
  scheduler.dispose();
}

function verifyCostEstimates() {
  assert.equal(estimateProcessReservationBytes('node', ['-e', '1']), 128 * MIB);
  assert.equal(estimateProcessReservationBytes('node', ['service.js'], { persistent: true }), 256 * MIB);
  assert.equal(estimateProcessReservationBytes('npm.cmd', ['run', 'build']), 768 * MIB);
  assert.equal(estimateProcessReservationBytes('gradlew', ['assembleDebug']), 768 * MIB);
  assert.equal(estimateProcessReservationBytes('node', ['test/run-tests.mjs']), 768 * MIB);
  assert.equal(estimateProcessReservationBytes('cmd.exe', ['/c', 'emulator -avd test']), GIB);
  assert.equal(estimateProcessReservationBytes('emulator', ['-avd', 'test']), GIB);
  assert.equal(estimateProcessReservationBytes('cmd', ['/c', '"npm run build"']), 768 * MIB);
}

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

async function verifyMemoryReservations() {
  const f = fixture({ physicalAvailableBytes: 2 * GIB });
  const scheduler = f.scheduler();
  const a = await scheduler.acquire('heavy', 'repo-a');
  let admitted = false;
  const pending = scheduler.acquire('heavy', 'repo-b').then(lease => { admitted = true; return lease; });
  assert.equal(scheduler.stats().heavy.active, 1);
  assert.equal(scheduler.stats().heavy.queued, 1);
  assert.match(scheduler.diagnostics().heavy.blockedReason, /physical headroom/);
  await Promise.resolve();
  assert.equal(admitted, false, 'concurrent work cannot spend the same memory budget');
  a.release();
  const b = await pending;
  b.release(); b.release();
  assert.equal(f.admission.diagnostics().reservedBytes, 0, 'release is idempotent');
  assert.equal(scheduler.stats().heavy.active, 0);
  scheduler.dispose();
}

async function verifyPersistentStartupSettling() {
  let clock = 1000;
  let memory = { sampledAtMs: clock, stale: false, physicalTotalBytes: 8 * GIB,
    physicalAvailableBytes: 2 * GIB, commitEnforced: true, commitLimitBytes: 16 * GIB,
    commitAvailableBytes: 12 * GIB };
  const admission = createMemoryAdmissionController({ monitor: { snapshot: () => ({ ...memory }) }, now: () => clock });
  const scheduler = createFairResourceScheduler({ heavy: 4, persistent: 12 }, { admission });
  const first = await scheduler.acquireMany(['persistent', 'heavy'], 'emulator-a', { reservationBytes: GIB });
  first.releaseResource('heavy');
  first.releaseResource('heavy');
  assert.equal(scheduler.stats().heavy.active, 0, 'readiness returns the heavy concurrency slot');
  assert.equal(admission.diagnostics().settlingReservedBytes, GIB, 'startup bytes remain reserved once after release');
  assert.equal(admission.hasPendingSettlements(), true, 'telemetry stays enabled until credits settle');
  let nextStarted = false;
  const next = scheduler.acquireMany(['persistent', 'heavy'], 'emulator-b', { reservationBytes: GIB })
    .then(lease => { nextStarted = true; return lease; });
  assert.equal(scheduler.stats().persistent.active, 1);
  clock = 2000; memory = { ...memory, sampledAtMs: clock };
  scheduler.pump();
  assert.equal(nextStarted, false, 'same/early telemetry cannot authorize repeated startup allocation');
  clock = 7000; memory = { ...memory, sampledAtMs: clock, stale: true };
  scheduler.pump();
  assert.equal(admission.diagnostics().settlingReservedBytes, GIB, 'stale telemetry cannot clear startup bytes');
  memory = { ...memory, stale: false, physicalAvailableBytes: null };
  scheduler.pump();
  assert.equal(admission.diagnostics().settlingReservedBytes, GIB, 'missing physical telemetry cannot clear startup bytes');
  memory = { ...memory, physicalAvailableBytes: 2 * GIB };
  scheduler.pump();
  const second = await next;
  assert.equal(admission.diagnostics().settlingReservedBytes, 0);
  assert.equal(admission.hasPendingSettlements(), false);
  second.release(); second.release(); first.release();
  const reverseOrder = await scheduler.acquireMany(['heavy', 'persistent'], 'reverse-order', { reservationBytes: GIB });
  reverseOrder.release(); reverseOrder.release();
  assert.equal(admission.diagnostics().settlingReservedBytes, 0, 'full release must not create settling credit in either resource order');
  assert.equal(admission.diagnostics().reservedBytes, 0);
  assert.equal(scheduler.stats().persistent.active, 0);
  scheduler.dispose();
}

async function verifyConfirmedStopSettlingRelease() {
  let clock = 1000;
  let memory = { sampledAtMs: clock, stale: false, physicalTotalBytes: 8 * GIB,
    physicalAvailableBytes: 2 * GIB, commitEnforced: false };
  const admission = createMemoryAdmissionController({ monitor: { snapshot: () => ({ ...memory }) }, now: () => clock });
  const scheduler = createFairResourceScheduler({ heavy: 4, persistent: 4 }, { admission });
  try {
    const first = await scheduler.acquireMany(['persistent', 'heavy'], 'first', { reservationBytes: 512 * MIB });
    const second = await scheduler.acquireMany(['persistent', 'heavy'], 'second', { reservationBytes: 512 * MIB });
    first.releaseResource('heavy'); second.releaseResource('heavy');
    assert.equal(admission.diagnostics().settlingReservedBytes, GIB);
    let nextStarted = false;
    const next = scheduler.acquireMany(['persistent', 'heavy'], 'next', { reservationBytes: 768 * MIB })
      .then(lease => { nextStarted = true; return lease; });
    first.release();
    await Promise.resolve();
    assert.equal(nextStarted, false, 'natural/uncertain root exit must retain its settling credit');
    first.release({ confirmedStopped: 'true' });
    await Promise.resolve();
    assert.equal(nextStarted, false, 'a truthy non-boolean value is not explicit termination proof');
    assert.equal(admission.diagnostics().settlingReservedBytes, GIB);
    first.release({ confirmedStopped: true });
    const third = await next;
    assert.equal(admission.diagnostics().settlingReservedBytes, 512 * MIB, 'proof clears only the first lease credit');
    const stillReserved = admission.diagnostics().reservedBytes;
    first.release({ confirmedStopped: true });
    assert.equal(admission.diagnostics().reservedBytes, stillReserved, 'confirmed release is idempotent');
    third.release();
    second.release();
    assert.equal(admission.diagnostics().settlingReservedBytes, 512 * MIB, 'another generic release remains conservative');
    second.release({ confirmedStopped: true });
    assert.equal(admission.diagnostics().reservedBytes, 0);
    assert.equal(admission.hasPendingSettlements(), false);

    const settled = await scheduler.acquireMany(['persistent', 'heavy'], 'settled', { reservationBytes: 512 * MIB });
    settled.releaseResource('heavy');
    clock += 6000; memory = { ...memory, sampledAtMs: clock };
    assert.equal(admission.diagnostics().settlingReservedBytes, 0);
    const unrelated = await scheduler.acquire('heavy', 'unrelated', { reservationBytes: 128 * MIB });
    settled.release({ confirmedStopped: true });
    assert.equal(admission.diagnostics().reservedBytes, 128 * MIB, 'late proof after a sample cannot release another lease bytes');
    unrelated.release();

    const releases = [];
    for (let index = 0; index < 65; index += 1) {
      const release = admission.reserve(['heavy'], { reservationBytes: 128 * MIB });
      releases.push(release);
      release({ settleUntilFreshSample: true });
    }
    assert.equal(admission.diagnostics().settlingReservationCount, 64);
    releases[64]({ confirmedStopped: true });
    assert.equal(admission.diagnostics().settlingReservedBytes, 64 * 128 * MIB, 'merged bookkeeping retains the other owner portion');
    releases[63]({ confirmedStopped: true });
    assert.equal(admission.diagnostics().settlingReservationCount, 63);
    for (const release of releases) release({ confirmedStopped: true });
    assert.equal(admission.diagnostics().reservedBytes, 0);
  } finally { scheduler.dispose(); }
}

async function verifyPressureRecoveryAndProtectedLanes() {
  const f = fixture({ commitAvailableBytes: 128 * MIB });
  const scheduler = f.scheduler();
  const controller = new AbortController();
  const heavy = scheduler.acquire('heavy', 'expensive', { signal: controller.signal });
  assert.equal(f.admission.diagnostics().state, 'pressured');
  const read = await scheduler.acquire('repositoryQuery', 'read');
  const control = await scheduler.acquire('persistent', 'restore');
  read.release(); control.release();
  assert.equal(scheduler.stats().heavy.active, 0);
  f.set({ commitAvailableBytes: 12 * GIB });
  scheduler.pump();
  scheduler.pump();
  assert.equal(scheduler.stats().heavy.active, 0, 're-reading one good sample must not defeat hysteresis');
  f.set({ commitAvailableBytes: 12 * GIB });
  scheduler.pump();
  const admitted = await heavy;
  assert.equal(f.admission.diagnostics().state, 'normal');
  admitted.release();
  f.set({ physicalAvailableBytes: 128 * MIB });
  const deadline = scheduler.acquire('heavy', 'deadline', { timeoutMs: 15 });
  await assert.rejects(deadline, error => error.code === 'HOST_RESOURCE_QUEUE_TIMEOUT');
  assert.equal(scheduler.stats().heavy.queued, 0);
  scheduler.dispose();
}

async function verifyAtomicAdmission() {
  const scheduler = createFairResourceScheduler({ heavy: 1, persistent: 1, repositoryQuery: 1 });
  const heavy = await scheduler.acquire('heavy', 'a');
  const both = scheduler.acquireMany(['persistent', 'heavy'], 'b');
  assert.equal(scheduler.stats().persistent.active, 0, 'multi-resource wait holds no partial capacity');
  const persistent = await scheduler.acquire('persistent', 'c');
  heavy.release();
  assert.equal(scheduler.stats().heavy.active, 0, 'blocked persistent launch holds no heavy slot');
  persistent.release();
  const lease = await both;
  assert.equal(scheduler.stats().heavy.active, 1);
  assert.equal(scheduler.stats().persistent.active, 1);
  lease.releaseResource('heavy'); lease.releaseResource('heavy');
  assert.equal(scheduler.stats().heavy.active, 0);
  assert.equal(scheduler.stats().persistent.active, 1, 'startup can return heavy headroom while retaining the lifetime lease');
  lease.release();
  assert.equal(scheduler.stats().persistent.active, 0);
  const query = await scheduler.acquireMany(['repositoryQuery', 'heavy'], 'query');
  query.release();
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

function verifyUnknownMetrics() {
  const f = fixture({ commitAvailableBytes: null, commitLimitBytes: null, commitUsedBytes: null });
  assert.equal(f.admission.diagnostics().state, 'unknown');
  assert.equal(f.admission.canAdmit(['heavy'], {}).allowed, true);
  const release = f.admission.reserve(['heavy'], {});
  assert.equal(f.admission.canAdmit(['heavy'], {}).allowed, false, 'unknown commit must reduce heavy concurrency');
  release();
  f.set({ stale: true });
  assert.equal(f.admission.canAdmit(['heavy'], {}).allowed, false, 'stale physical data cannot admit even one fresh job');
  f.set({ stale: false, physicalTotalBytes: 0 });
  assert.equal(f.admission.canAdmit(['heavy'], {}).allowed, false, 'zero total memory is unknown rather than a valid budget');
  f.set({ physicalTotalBytes: 8 * GIB, physicalAvailableBytes: null });
  assert.equal(f.admission.canAdmit(['heavy'], {}).allowed, false, 'unknown physical headroom cannot claim safe capacity');
  const snapshot = hostResourceDiagnosticSnapshot();
  assert.equal(snapshot.pressure.commitAvailableBytes, null, 'pure diagnostics does not force a system probe');
  assert.equal(snapshot.pressure.sampling, false);
}

function verifyLinuxAdvisoryCommit() {
  const f = fixture({ commitEnforced: false, commitAvailableBytes: 0 });
  assert.equal(f.admission.canAdmit(['heavy'], {}).allowed, true,
    'Linux overcommit modes 0/1 do not treat virtual commitments as a hard Windows-style commit limit');
}

function verifyBoundedDiagnostics() {
  const f = fixture();
  for (let index = 0; index < 200; index += 1) {
    f.set({ physicalAvailableBytes: index % 3 ? 6 * GIB : 0 });
    f.admission.diagnostics();
  }
  const snapshots = f.admission.diagnostics().recentDecisions;
  assert.ok(snapshots.length <= 20);
  for (let index = 1; index < snapshots.length; index += 1) {
    assert.ok(snapshots[index].atMs - snapshots[index - 1].atMs >= 10_000);
  }
}
