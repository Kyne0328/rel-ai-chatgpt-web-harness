import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';
import childProcess, { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readProcessCreationIdentity } from '../src/process.js';
import { HOST_PERSISTENT_PROCESS_LIMIT, acquireHostResource, hostResourceStats } from '../src/hostResourceScheduler.js';
import { startManagedProcess, stopManagedProcess } from '../src/processManager.js';
import { flushAuditWrites } from '../src/audit.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { flushLocalAnalytics } from '../src/localAnalytics.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-reuse-workspace-'));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-reuse-state-'));
const config = { stateDir: stateRoot, processEnvironment: { allow: [] } };
const workspace = { alias: 'repo', path: root };
const command = `node -e "setInterval(()=>{},1000)"`;
const started = [];
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const configFile = path.join(stateRoot, 'fixture-config.json');
fs.writeFileSync(configFile, JSON.stringify({ version: 3, ...config, workspaces: { repo: { path: root } } }));
process.env.REL_AI_MCP_CONFIG = configFile;
let testFailure;
let cleanupFailure;
const reservationCase = process.argv.find(value => value.startsWith('--reservation-case='))?.split('=')[1];
if (reservationCase) assert.ok(['preaborted', 'timeout', 'restoration'].includes(reservationCase));
// Assume 16 GiB total / 12 GiB available for real process/queue fixtures.
// Keep real deadlines and capacity leases; pressure has dedicated tests.
const restoreMemory = installDeterministicHostMemory();
try {
  if (!reservationCase) {
  const first = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'reuse fixture', startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  started.push(first.processId);
  assert.equal(first.reused, false);

  const reused = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'reuse fixture', startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  assert.equal(reused.processId, first.processId);
  assert.equal(reused.reused, true);
  assert.equal(reused.readiness?.verified, true);

  const concurrentArgs = { command, kind: 'service', purpose: 'concurrent reuse fixture', startupWaitMs: 25 };
  const [concurrentFirst, concurrentSecond] = await Promise.all([
    startManagedProcess(workspace, config, concurrentArgs, { taskId: 'task-concurrent', principal: 'principal-a' }),
    startManagedProcess(workspace, config, concurrentArgs, { taskId: 'task-concurrent', principal: 'principal-a' })
  ]);
  started.push(concurrentFirst.processId, concurrentSecond.processId);
  assert.equal(concurrentSecond.processId, concurrentFirst.processId, 'simultaneous identical starts must converge on one managed process');
  assert.equal([concurrentFirst, concurrentSecond].filter(result => result.reused === true).length, 1,
    'exactly one simultaneous caller must observe reuse after the initial process starts');

  await stopManagedProcess(config, { processId: concurrentFirst.processId, graceMs: 50 }, { internal: true });

  const otherTask = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'reuse fixture', startupWaitMs: 25 }, { taskId: 'task-b', principal: 'principal-a' });
  started.push(otherTask.processId);
  assert.notEqual(otherTask.processId, first.processId, 'processes must never be reused across logical tasks');
  await stopManagedProcess(config, { processId: otherTask.processId, graceMs: 50 }, { internal: true });

  const changedPurpose = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'different purpose', startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  started.push(changedPurpose.processId);
  assert.notEqual(changedPurpose.processId, first.processId, 'changed purpose must not reuse a process');
  await stopManagedProcess(config, { processId: changedPurpose.processId, graceMs: 50 }, { internal: true });

  const changedKind = await startManagedProcess(workspace, config, { command, kind: 'watcher', purpose: 'reuse fixture', startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  started.push(changedKind.processId);
  assert.notEqual(changedKind.processId, first.processId, 'changed process kind must not reuse a process');
  await stopManagedProcess(config, { processId: changedKind.processId, graceMs: 50 }, { internal: true });

  const reuseDisabled = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'reuse fixture', reuseExisting: false, startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  started.push(reuseDisabled.processId);
  assert.notEqual(reuseDisabled.processId, first.processId, 'reuseExisting:false must force a new managed process');
  await stopManagedProcess(config, { processId: reuseDisabled.processId, graceMs: 50 }, { internal: true });
  const changedEnvKeys = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'reuse fixture', env: { RELAI_REUSE_KEY: 'one' }, startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  started.push(changedEnvKeys.processId);
  assert.notEqual(changedEnvKeys.processId, first.processId, 'changed environment key sets must not reuse a process');

  const changedEnvValue = await startManagedProcess(workspace, config, { command, kind: 'service', purpose: 'reuse fixture', env: { RELAI_REUSE_KEY: 'two' }, startupWaitMs: 25 }, { taskId: 'task-a', principal: 'principal-a' });
  started.push(changedEnvValue.processId);
  assert.notEqual(changedEnvValue.processId, changedEnvKeys.processId, 'changed environment values must not reuse a process started with stale configuration');
  }
  await stopStarted();
  if (!reservationCase || reservationCase === 'preaborted') await testPreAbortedReservation();
  if (!reservationCase || reservationCase === 'timeout') await testTimedOutReservationOrdering();
  if (!reservationCase || reservationCase === 'restoration') await testRestorationOrdering();
} catch (error) {
  testFailure = error;
  throw error;
} finally {
  try {
    const cleanupFailures = [];
    for (const processId of [...new Set(started)]) {
      try { await stopManagedProcess(config, { processId, graceMs: 50 }, { internal: true }); }
      catch (error) { cleanupFailures.push(error); }
    }
    // Drain writes and close cached database handles for this isolated fixture.
    for (const drain of [
      () => flushAuditWrites(),
      () => flushTaskHistoryPersistence(),
      () => flushLocalAnalytics(config),
      () => flushLocalAnalytics({ ...config, stateDir: path.join(stateRoot, 'restore-ordering') })
    ]) {
      try { await drain(); } catch (error) { cleanupFailures.push(error); }
    }
    if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
    else process.env.REL_AI_MCP_CONFIG = previousConfig;
    for (const directory of [root, stateRoot]) {
      try { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length) {
      if (testFailure) console.error('Secondary fixture cleanup failure:', cleanupFailures);
      else cleanupFailure = new AggregateError(cleanupFailures, 'Managed process fixture cleanup failed.');
    }
  } finally {
    restoreMemory();
  }
}
if (cleanupFailure) throw cleanupFailure;
console.log('Exact same-task managed-process reuse tests passed.');
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await tick();
  }
}
async function stopStarted() {
  for (const processId of [...new Set(started.splice(0))]) {
    await stopManagedProcess(config, { processId, graceMs: 50 }, { internal: true });
  }
}
function persistentArgs(purpose, counter) {
  return { executable: process.execPath,
    argv: ['-e', 'require("node:fs").appendFileSync(process.argv[1], "1"); setInterval(() => {}, 1000);', counter],
    kind: 'service', purpose, startupWaitMs: 25 };
}
function rememberStart(args, context) {
  return startManagedProcess(workspace, config, args, context).then(result => {
    started.push(result.processId);
    return result;
  });
}
async function holdAllCapacity() {
  assert.equal(hostResourceStats().persistent.active, 0, 'fixture starts with no retained child leases');
  const leases = [];
  for (let index = 0; index < HOST_PERSISTENT_PROCESS_LIMIT; index += 1) {
    leases.push(await acquireHostResource('persistent', 'reservation-test-blocker'));
  }
  return () => { for (const lease of leases.splice(0)) lease.release(); };
}
async function testPreAbortedReservation() {
  const counter = path.join(root, 'preaborted-starts');
  const args = persistentArgs('preaborted reservation retry', counter);
  const context = { taskId: 'preaborted-retry', principal: 'principal-a', coordinationTimeoutMs: 1000 };
  await assert.rejects(() => rememberStart(args, { ...context, signal: AbortSignal.abort(new Error('Fixture cancellation.')) }),
    error => error?.code === 'TASK_CANCELLED');
  assert.equal(fs.existsSync(counter), false, 'already-cancelled admission must not start a physical child');
  let retryTimer;
  let retry;
  try {
    retry = await Promise.race([rememberStart(args, context), new Promise((_, reject) => {
      retryTimer = setTimeout(() => reject(new Error('Valid retry remained blocked after pre-aborted reservation.')), 2000);
    })]);
  } finally { clearTimeout(retryTimer); }
  assert.equal(retry.reused, false, 'a cancelled first reservation must not poison a later valid start');
  await until(() => fs.existsSync(counter), 'retry child must reach its physical marker');
  assert.equal(fs.readFileSync(counter, 'utf8'), '1');
  await stopStarted();
}
async function testTimedOutReservationOrdering() {
  const releaseCapacity = await holdAllCapacity();
  const counter = path.join(root, 'timedout-starts');
  const args = persistentArgs('timed-out reservation ordering', counter);
  const controller = new AbortController();
  const context = { taskId: 'timedout-retry', principal: 'principal-a', signal: controller.signal, coordinationTimeoutMs: 5000 };
  const pending = [];
  const first = rememberStart(args, context);
  pending.push(first); first.catch(() => {});
  try {
    await until(() => hostResourceStats().persistent.queued === 1, 'first startup must hold its reservation while waiting for fixture capacity');
    await assert.rejects(() => rememberStart(args, { ...context, coordinationTimeoutMs: 30 }),
      error => error?.code === 'PROCESS_START_COORDINATION_TIMEOUT');
    let thirdSettled = false;
    const third = rememberStart(args, context);
    pending.push(third);
    third.then(() => { thirdSettled = true; }, () => { thirdSettled = true; });
    await tick(); await tick();
    assert.equal(thirdSettled, false, 'third waiter must stay behind the original startup');
    assert.equal(hostResourceStats().persistent.queued, 1,
      'cancelling the middle waiter must not admit a second physical startup behind the same fingerprint');
    assert.equal(fs.existsSync(counter), false);
    releaseCapacity();
    const [original, following] = await Promise.all([first, third]);
    assert.equal(following.processId, original.processId, 'retry after timeout must recover and reuse the original child');
    assert.equal(following.reused, true);
    await until(() => fs.existsSync(counter), 'one physical child must reach its marker');
    assert.equal(fs.readFileSync(counter, 'utf8'), '1', 'reservation retries must not duplicate physical starts');
  } finally {
    controller.abort(new Error('Fixture teardown.'));
    releaseCapacity();
    await Promise.allSettled(pending);
    await stopStarted();
  }
}
async function testRestorationOrdering() {
  const restoreConfig = { ...config, stateDir: path.join(stateRoot, 'restore-ordering') };
  const orphanId = `proc_${'r'.repeat(24)}`;
  const orphanDirectory = path.join(restoreConfig.stateDir, 'processes', orphanId);
  const external = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore' });
  const externalClosed = new Promise(resolve => external.once('close', resolve));
  const restoreStarted = [];
  const controller = new AbortController();
  const pending = [];
  const originalSpawn = childProcess.spawn;
  const originalReadFile = fs.promises.readFile;
  let releaseIdentity;
  const identityBarrier = new Promise(resolve => { releaseIdentity = resolve; });
  let identityQueries = 0;
  try {
    await once(external, 'spawn');
    const identity = await readProcessCreationIdentity(external.pid);
    assert.ok(identity, 'test-owned orphan requires a real verifiable process identity');
    fs.mkdirSync(orphanDirectory, { recursive: true });
    fs.writeFileSync(path.join(orphanDirectory, 'stdout.log'), '');
    fs.writeFileSync(path.join(orphanDirectory, 'stderr.log'), '');
    fs.writeFileSync(path.join(orphanDirectory, 'metadata.json'), JSON.stringify({
      schemaVersion: 4, runtimeId: 'fixture-previous-runtime', processId: orphanId,
      workspaceId: workspace.alias, workspacePath: root, lifecycle: 'persistent', kind: 'service',
      purpose: 'Restoration ordering fixture.', commandSummary: 'owned fixture child', label: 'owned-orphan',
      cwd: '.', status: 'running', startedAt: new Date().toISOString(), pid: external.pid,
      processCreationIdentity: identity, stdoutBytes: 0, stderrBytes: 0,
      stdoutStartOffset: 0, stderrStartOffset: 0, environmentKeys: [], maxLogBytes: 65536
    }));
    // Hold only the identity lookup for this real test-owned orphan. The full
    // public restoration path remains active; no private queue helper is copied.
    fs.promises.readFile = async function(file, ...options) {
      if (process.platform === 'linux' && String(file) === `/proc/${external.pid}/stat`) {
        identityQueries += 1;
        await identityBarrier;
      }
      return originalReadFile.call(this, file, ...options);
    };
    childProcess.spawn = function(executable, argv = [], ...options) {
      const ownsIdentityLookup = process.platform === 'win32'
        ? argv.some(arg => String(arg).includes(`Get-Process -Id ${external.pid} -ErrorAction Stop`))
        : process.platform !== 'linux' && String(executable) === '/bin/ps' && argv[0] === '-p' && argv[1] === String(external.pid);
      if (!ownsIdentityLookup) return originalSpawn.call(this, executable, argv, ...options);
      identityQueries += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.kill = () => true;
      child.unref = () => {};
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(identity.slice(identity.indexOf(':') + 1))));
      void identityBarrier.then(() => child.emit('close', 0));
      return child;
    };
    syncBuiltinESMExports();
    const start = label => startManagedProcess(workspace, restoreConfig,
      { ...persistentArgs(label, path.join(root, label)), reuseExisting: false },
      { taskId: label, principal: 'principal-a', signal: controller.signal, coordinationTimeoutMs: 5000 }
    ).then(result => { restoreStarted.push(result.processId); return result; });
    const first = start('restore-first'); pending.push(first); first.catch(() => {});
    await until(() => identityQueries === 1, 'first restoration must enter its owned identity lookup');
    await assert.rejects(() => startManagedProcess(workspace, restoreConfig,
      { ...persistentArgs('restore-cancelled', path.join(root, 'restore-cancelled')), reuseExisting: false },
      { taskId: 'restore-cancelled', principal: 'principal-a', coordinationTimeoutMs: 30 }),
      error => error?.code === 'PROCESS_START_COORDINATION_TIMEOUT');
    const third = start('restore-third'); pending.push(third); third.catch(() => {});
    await tick(); await tick();
    assert.equal(identityQueries, 1,
      'a cancelled restoration waiter must not let a third caller overlap the unfinished restore');
    assert.equal(fs.existsSync(path.join(root, 'restore-first')), false);
    assert.equal(fs.existsSync(path.join(root, 'restore-third')), false);
  } finally {
    controller.abort(new Error('Restoration fixture teardown.'));
    releaseIdentity();
    await Promise.allSettled(pending);
    childProcess.spawn = originalSpawn;
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
    for (const processId of [...new Set([...restoreStarted, orphanId])]) {
      try { await stopManagedProcess(restoreConfig, { processId, graceMs: 50 }, { internal: true }); } catch {}
    }
    if (external.exitCode == null) external.kill('SIGKILL');
    await externalClosed;
  }
  assert.equal(hostResourceStats().persistent.active, 0, 'cancelled restoration callers must release all fixture leases');
  const retry = await startManagedProcess(workspace, restoreConfig,
    persistentArgs('restore-valid-retry', path.join(root, 'restore-valid-retry')),
    { taskId: 'restore-valid-retry', principal: 'principal-a', coordinationTimeoutMs: 1000 });
  try { assert.equal(retry.reused, false, 'restoration queue must allow a valid later startup'); }
  finally { await stopManagedProcess(restoreConfig, { processId: retry.processId, graceMs: 50 }, { internal: true }); }
}
