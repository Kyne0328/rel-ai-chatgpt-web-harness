import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithMutationProcessOwnership, recordCurrentMutationProcess, listMutationProcessRecords, workspaceMutationSafetySummary, notifyRecoveryChange, markCurrentMutationProcessUncertain } from '../src/mutationProcessOwnership.js';
import { assertNoRecoveredMutationProcess } from '../src/tools/execution.js';
import { recoverMutationRecordsAtStartup, startAutomaticMutationRecovery } from '../src/mutationAutoRecovery.js';
import { runWorkspaceOperation, workspaceMutationBlockSummary, onWorkspaceMutationBlockChange } from '../src/workspaceOperationQueue.js';
import { currentMutationBootIdentity } from '../src/mutationBootIdentity.js';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';
import { getTaskHistoryDir, readTaskHistorySessionRecord } from '../src/taskHistoryStore.ts';
import { writeSession } from '../src/taskHistoryStorage.ts';
import { spawnSync } from 'node:child_process';

const fixtureParent = process.platform === 'win32' ? os.homedir() : os.tmpdir();
const root = fs.mkdtempSync(path.join(fixtureParent, 'relai-auto-mutation-recovery-'));
const native = await currentMutationBootIdentity();
const base = native || { platform: 'linux', host: 'host-fixture', boot: 'boot-one' };
const next = { ...base, boot: 'new-kernel-boot-fixture' };
let counter = 0;
function scenario() {
  const id = ++counter;
  const folder = path.join(root, 'workspace-' + id);
  fs.mkdirSync(folder, { recursive: true });
  const config = { stateDir: path.join(root, 'state-' + id), workspaces: { alpha: { path: folder } } };
  const file = runWithMutationProcessOwnership(config, 'alpha', () => recordCurrentMutationProcess(400000 + id), folder);
  return { config, file, folder };
}
try {
  if (process.platform === 'win32') {
    const moduleUrl = new URL('../src/executionRecovery.js?wsl-contract', import.meta.url).href;
    const facade = 'data:text/javascript,' + encodeURIComponent(`
      export function execFile() { throw new Error('Unexpected callback execution'); }
      execFile[Symbol.for('nodejs.util.promisify.custom')] = async (executable, args) => {
        const fixture = globalThis.__relaiWslRecovery;
        fixture.calls.push(args);
        if (fixture.error) throw new Error(fixture.error);
        if (args.includes('--list')) return {stdout:Buffer.from((args.includes('--running') ? fixture.running : ['Ubuntu']).join('\\r\\n'),'utf16le')};
        return {stdout:fixture.boot+'\\npopulated '+fixture.populated+'\\n'};
      };
    `);
    const hooks = registerHooks({ resolve(specifier, context, next) {
      return context.parentURL === moduleUrl && specifier === 'node:child_process'
        ? { url: facade, shortCircuit: true } : next(specifier, context);
    } });
    const { inspectOwnedExecution } = await import(moduleUrl);
    const { config } = scenario();
    const nonce = 'a'.repeat(64);
    const directory = path.join(config.stateDir, 'process-jobs', 'job-wsl-recovery');
    fs.mkdirSync(directory, { recursive: true });
    const request = { protocol: 1, nonce, executable: path.join(process.env.SystemRoot, 'System32', 'wsl.exe'), args: ['-d', 'Ubuntu', '--exec', 'python3', 'owned-fixture.py'] };
    const exitedPid = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true }).pid;
    const record = { pid: exitedPid, nativeJob: { directory, nonce } };
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify(request));
    const receipt = { protocol: 1, nonce, helperPid: exitedPid, rootPid: exitedPid, final: false, activeProcesses: 4 };
    fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt));
    const fixture = { running: [], boot: '11111111-1111-1111-1111-111111111111', populated: 1, calls: [] };
    globalThis.__relaiWslRecovery = fixture;
    try {
      assert.equal((await inspectOwnedExecution(config, record)).status, 'stopped', 'stopped execution host settles an older job without a final receipt');
      assert.equal((await inspectOwnedExecution(config, { ...record, pid: 0, phase: 'preparing' })).status, 'stopped',
        'the nonce-bound admission receipt survives a crash before parent PID attachment');
      assert.ok(fixture.calls.every(args => args.includes('--list')), 'legacy recovery must not start a WSL guest to inspect it');
      fixture.running = ['Ubuntu'];
      assert.equal((await inspectOwnedExecution(config, record)).status, 'unknown', 'a running guest without retained scope cannot unlock');
      request.guestScope = { nonce, distribution: 'Ubuntu' };
      fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify(request));
      fs.writeFileSync(path.join(directory, 'guest-scope.json'), JSON.stringify({ nonce, boot: fixture.boot, directory: '/sys/fs/cgroup/relai-mutation-' + nonce }));
      assert.equal((await inspectOwnedExecution(config, record)).status, 'running', 'a surviving guest descendant retains the owner');
      fixture.populated = 0;
      assert.equal((await inspectOwnedExecution(config, record)).status, 'stopped', 'empty guest scope confirms termination');
      fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify({ ...receipt, helperPid: process.pid }));
      assert.equal((await inspectOwnedExecution(config, { ...record, pid: process.pid })).status, 'unknown', 'a live or reused launcher PID cannot authorize legacy release');
      fs.writeFileSync(path.join(directory, 'receipt.json'), JSON.stringify(receipt));
      fixture.error = 'WSL inspection unavailable';
      assert.equal((await inspectOwnedExecution(config, record)).status, 'unknown', 'probe failures retain uncertainty');
    } finally { hooks.deregister(); delete globalThis.__relaiWslRecovery; }
  }
  // Recovery reconciles the exact task operation before releasing the owner.
  // Probe failure must preserve protection and retry, rather than strand the
  // startup barrier or erase another operation's state.
  {
    const moduleUrl = new URL('../src/mutationAutoRecovery.js?execution-contract', import.meta.url).href;
    const stub = 'data:text/javascript,' + encodeURIComponent('export async function inspectOwnedExecution() { const f=globalThis.__relaiRecoveryContract; if(f.error) throw new Error(f.error); return f.observation; }');
    const historyStub = 'data:text/javascript,' + encodeURIComponent(`
      import {reconcileTaskExecutionHistory as reconcile} from ${JSON.stringify(new URL('../src/taskHistoryStore.ts', import.meta.url).href)};
      export async function reconcileTaskExecutionHistory(...args) {
        globalThis.__relaiRecoveryContract.historyFailure?.();
        return reconcile(...args);
      }
    `);
    globalThis.__relaiRecoveryContract = { error: 'temporary execution probe failure' };
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === moduleUrl && specifier === './taskHistoryStore.ts') return { url: historyStub, shortCircuit: true };
      return context.parentURL === moduleUrl && specifier === './executionRecovery.js'
        ? { url: stub, shortCircuit: true } : next(specifier, context);
    } });
    const { startAutomaticMutationRecovery: start } = await import(moduleUrl);
    const { config, file, folder } = scenario();
    const taskId = randomUUID(), operationId = 'fallback_' + randomUUID();
    const otherId = 'fallback_' + randomUUID();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, taskId, operationId }));
    writeSession(getTaskHistoryDir(config), { id: taskId, taskId, version: 3, status: 'planning', workspace: 'alpha',
      events: [{ eventId: operationId, status: 'running', summary: 'original', timestamp: new Date().toISOString() },
        { eventId: otherId, status: 'running', summary: 'another operation', timestamp: new Date().toISOString() }],
      backgroundOperations: [{ operationId, workId: taskId, workspace: 'alpha', status: 'running', revision: 1 }] });
    const monitor = start(config, { bootIdentity: base, eventMinMs: 0, retryMs: [50] });
    try {
      const initial = await monitor.initial;
      assert.equal(initial.pending, 1);
      assert.match(initial.errors[0].reason, /temporary execution probe failure/u);
      const changed = (predicate, action) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { off(); reject(new Error('Execution recovery did not publish the expected state.')); }, 10000);
        const off = onWorkspaceMutationBlockChange(({ alias }) => {
          if (alias !== 'alpha' || !predicate()) return;
          clearTimeout(timeout); off(); resolve();
        });
        action();
      });
      await changed(() => readTaskHistorySessionRecord(config, taskId)?.backgroundOperations?.[0]?.executionRecovery?.status === 'running', () => {
        globalThis.__relaiRecoveryContract = { observation: { status: 'running', reason: 'fixture-container-populated' } };
      });
      assert.equal(fs.existsSync(file), true, 'a surviving execution retains its owner');
      await assert.rejects(runWorkspaceOperation('alpha', () => 'unsafe', { taskId, scope: 'mutation' }), error => error.code === 'WORKSPACE_MUTATION_BLOCKED');
      const failedHistory = Promise.withResolvers();
      globalThis.__relaiRecoveryContract = { observation: { status: 'stopped', reason: 'verified-native-job-membership' },
        historyFailure: () => { failedHistory.resolve(); throw new Error('Recovery history persistence denied'); } };
      const historyTimeout = setTimeout(() => failedHistory.reject(new Error('Recovery did not attempt history persistence.')), 10000);
      try { await failedHistory.promise; } finally { clearTimeout(historyTimeout); }
      assert.equal(fs.existsSync(file), true, 'failed history persistence cannot release process ownership');
      assert.equal(workspaceMutationBlockSummary('alpha', folder)?.blocked, true);
      await changed(() => workspaceMutationBlockSummary('alpha', folder) === null, () => {
        globalThis.__relaiRecoveryContract = { observation: { status: 'stopped', reason: 'verified-native-job-membership' } };
        notifyRecoveryChange();
      });
      const history = readTaskHistorySessionRecord(config, taskId);
      assert.equal(history.events.find(event => event.eventId === operationId).status, 'interrupted');
      assert.equal(history.events.find(event => event.eventId === otherId).status, 'running');
      assert.equal(history.backgroundOperations[0].status, 'interrupted');
      assert.equal(fs.existsSync(file), false);
      assert.equal(await runWorkspaceOperation('alpha', () => 'admitted', { taskId, scope: 'mutation' }), 'admitted');
    } finally { monitor.stop(); hooks.deregister(); delete globalThis.__relaiRecoveryContract; }
  }
  // The same boot and a missing original PID must NEVER unlock.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    assert.ok(fs.existsSync(file));
    const cp = path.join(config.stateDir, 'mutation-auto-recovery');
    assert.equal(fs.existsSync(cp), true, 'uncertain same-boot record receives future recovery evidence');
    const afterVerifiedBoot = await recoverMutationRecordsAtStartup(config, { bootIdentity: next });
    assert.equal(afterVerifiedBoot.released, 1, JSON.stringify(afterVerifiedBoot));
    assert.deepEqual(listMutationProcessRecords(config, 'alpha', config.workspaces.alpha.path), []);
  }
  // A new-format record containing original boot identity recovers without a checkpoint.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 1);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 0);
  }
  // Legacy records must collect a checkpoint on this boot and only recover on a later boot.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    assert.ok(fs.existsSync(file));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 1);
    assert.equal(fs.existsSync(file), false);
    // A finished checkpoint must never poison a subsequent independent crash.
    const fresh = runWithMutationProcessOwnership(config, 'alpha',
      () => recordCurrentMutationProcess(499996), config.workspaces.alpha.path);
    const future = (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    assert.equal(future.pending, 1);
    assert.ok(fs.existsSync(fresh));
  }
  // Tampering after checkpoint must preserve the lock.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    fs.appendFileSync(file, ' ');
    const outcome = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(outcome.released, 0);
    assert.equal(outcome.errors.length, 1);
    assert.ok(fs.existsSync(file));
  }
  // A missing record is not safe merely because the active directory is empty.
  {
    const { config, file, folder } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    fs.rmSync(file);
    const failed = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(failed.released, 0);
    assert.equal(failed.errors.length, 1);
    assert.equal(workspaceMutationSafetySummary(config, 'alpha', folder)?.code,
      'WORKSPACE_MUTATION_RECOVERY_STATE_INVALID');
    assert.throws(() => assertNoRecoveredMutationProcess(config, 'alpha', folder),
      error => error.code === 'WORKSPACE_MUTATION_RECOVERY_STATE_INVALID');
  }
  // New writers after checkpoint preparation invalidate the prior inventory.
  {
    const { config, file, folder } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    const another = runWithMutationProcessOwnership(config, 'alpha',
      () => recordCurrentMutationProcess(499997), folder);
    const failed = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(failed.released, 0);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(another));
  }
  // Windows recovery requires a full native-zero Job Object receipt.
  if (process.platform === 'win32') {
    for (const complete of [false, true]) {
      const { config, file } = scenario();
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete record.bootIdentity;
      const job = path.join(config.stateDir, 'process-jobs', 'job-synthetic');
      fs.mkdirSync(job, { recursive: true });
      const nonce = 'a'.repeat(64);
      record.nativeJob = { directory: job, nonce };
      fs.writeFileSync(file, JSON.stringify(record));
      fs.writeFileSync(path.join(job, 'request.json'), JSON.stringify({ protocol: 1, nonce }));
      fs.writeFileSync(path.join(job, 'receipt.json'), JSON.stringify({
        protocol: 1, nonce, helperPid: record.pid, final: true,
        jobComplete: true, cleanupConfirmed: complete, activeProcesses: 0,
        commandStarted: true, rootExited: true
      }));
      const outcome = (await recoverMutationRecordsAtStartup(config, { bootIdentity: null }));
      assert.equal(outcome.released, complete ? 1 : 0);
      assert.equal(fs.existsSync(file), !complete);
    }
  }
  // An unbound legacy record prevents automatic restoration.
  {
    const { config, file } = scenario();
    const legacy = path.join(config.stateDir, 'active-mutations', 'foreign');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'legacy.json'), JSON.stringify({
      schemaVersion: 2, workspace: 'alpha', runtimeId: 'unbound',
      pid: 1234, phase: 'active', terminationUncertain: true
    }));
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    const outcome = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(outcome.released, 0);
    assert.ok(fs.existsSync(file));
  }
  // Idle startup does not hold a mutation barrier or schedule recovery retries.
  {
    const { config, file, folder } = scenario();
    fs.rmSync(file);
    const monitor = startAutomaticMutationRecovery(config, { bootIdentity: next });
    assert.equal(monitor.pendingCount(), 0);
    assert.deepEqual(await monitor.initial, { released: 0, pending: 0, errors: [] });
    assert.equal(workspaceMutationBlockSummary('alpha', folder), null);
    monitor.stop();
  }
  // Startup blocks mutation admission synchronously, before verification yields.
  {
    const { config, file, folder } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    const monitor = startAutomaticMutationRecovery(config, { bootIdentity: next });
    assert.equal(monitor.pendingCount(), 1);
    assert.equal(workspaceMutationBlockSummary('alpha', folder)?.blocked, true);
    await assert.rejects(runWorkspaceOperation('alpha', () => 'unsafe', {
      taskId: 'startup-writer', scope: 'mutation'
    }), error => error.code === 'WORKSPACE_MUTATION_BLOCKED');
    assert.equal(await runWorkspaceOperation('alpha', () => 'readable', {
      taskId: 'startup-reader', scope: 'workspace', mode: 'read'
    }), 'readable');
    assert.equal((await monitor.initial).released, 1);
    assert.equal(monitor.pendingCount(), 0);
    assert.equal(workspaceMutationBlockSummary('alpha', folder), null);
    assert.equal(await runWorkspaceOperation('alpha', () => 'safe', {
      taskId: 'post-recovery', scope: 'mutation'
    }), 'safe');
    monitor.stop();
  }
  // A verified native completion arriving after startup must wake recovery
  // without a continuously running global process scanner.
  if (process.platform === 'win32') {
    const { config, file, folder } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const jobDir = path.join(config.stateDir, 'process-jobs', 'job-live-recovery');
    fs.mkdirSync(jobDir, { recursive: true });
    const nonce = 'b'.repeat(64);
    delete record.bootIdentity;
    record.nativeJob = { directory: jobDir, nonce };
    fs.writeFileSync(file, JSON.stringify(record));
    fs.writeFileSync(path.join(jobDir, 'request.json'), JSON.stringify({ protocol: 1, nonce }));
    const monitor = startAutomaticMutationRecovery(config, {
      bootIdentity: null, retryMs: [300000], eventMinMs: 0
    });
    assert.equal((await monitor.initial).pending, 1);
    assert.equal(workspaceMutationBlockSummary('alpha', folder)?.blocked, true);
    const recovered = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { off(); reject(new Error('Live ownership recovery did not settle.')); }, 10000);
      const off = onWorkspaceMutationBlockChange(({ alias, mutationBlock }) => {
        if (alias !== 'alpha' || mutationBlock?.blocked) return;
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
    fs.writeFileSync(path.join(jobDir, 'receipt.json'), JSON.stringify({
      protocol: 1, nonce, helperPid: record.pid, final: true,
      jobComplete: true, cleanupConfirmed: true, activeProcesses: 0,
      commandStarted: true, rootExited: true
    }));
    notifyRecoveryChange();
    await recovered;
    assert.equal(monitor.pendingCount(), 0);
    assert.equal(fs.existsSync(file), false);
    monitor.stop();
  }
  // A reboot checkpoint must not hide later native all-process proof on the
  // SAME OS boot. This previously forced an unnecessary reboot.
  if (process.platform === 'win32') {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const job = path.join(config.stateDir, 'process-jobs', 'job-checkpoint-native');
    fs.mkdirSync(job, { recursive: true });
    const nonce = 'c'.repeat(64);
    record.bootIdentity = base;
    record.nativeJob = { directory: job, nonce };
    fs.writeFileSync(file, JSON.stringify(record));
    fs.writeFileSync(path.join(job, 'request.json'), JSON.stringify({ protocol: 1, nonce }));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    fs.writeFileSync(path.join(job, 'receipt.json'), JSON.stringify({
      protocol: 1, nonce, helperPid: record.pid, final: true,
      jobComplete: true, cleanupConfirmed: true, activeProcesses: 0,
      commandStarted: true, rootExited: true
    }));
    const result = await recoverMutationRecordsAtStartup(config, { bootIdentity: base });
    assert.equal(result.released, 1, JSON.stringify(result));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(job), false, 'retired native proof must not leak its helper directory');
  }
  // An initially healthy service must also monitor a new uncertain subprocess.
  {
    const { config, file, folder } = scenario();
    fs.rmSync(file);
    const monitor = startAutomaticMutationRecovery(config, { bootIdentity: next });
    assert.equal((await monitor.initial).pending, 0);
    const pid = 599901;
    const uncertainFile = runWithMutationProcessOwnership(config, 'alpha',
      () => recordCurrentMutationProcess(pid), folder);
    const original = JSON.parse(fs.readFileSync(uncertainFile, 'utf8'));
    fs.writeFileSync(uncertainFile, JSON.stringify({ ...original, bootIdentity: base }));
    const settled = new Promise((resolve, reject) => {
      let sawBlocked = false;
      const timeout = setTimeout(() => { off(); reject(new Error('New uncertainty was not recovered.')); }, 10000);
      const off = onWorkspaceMutationBlockChange(({ alias, mutationBlock }) => {
        if (alias !== 'alpha') return;
        if (mutationBlock?.blocked) { sawBlocked = true; return; }
        if (!sawBlocked) return;
        clearTimeout(timeout);
        off();
        resolve();
      });
    });
    assert.equal(runWithMutationProcessOwnership(config, 'alpha',
      () => markCurrentMutationProcessUncertain(pid, 'simulated interruption', uncertainFile), folder), true);
    assert.equal(workspaceMutationBlockSummary('alpha', folder)?.blocked, true);
    await settled;
    assert.equal(monitor.pendingCount(), 0);
    assert.equal(fs.existsSync(uncertainFile), false);
    monitor.stop();
  }
  console.log('Automatic mutation restart and reboot recovery gates passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
