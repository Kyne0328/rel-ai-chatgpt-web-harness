import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

import { dashboardManagedProcesses } from '../src/core/dashboard-data.ts';
import {
  activeProcessesForWorkSession,
  listManagedProcesses,
  onManagedProcessChange,
  readManagedProcess,
  readManagedProcessLogRange,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
  writeManagedProcess
} from '../src/processManager.js';
import { readProcessCreationIdentity } from '../src/process.js';


const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-manager-'));
const stateDir = path.join(root, 'state');
const workspaceRoot = path.join(root, 'workspace');
const config = { stateDir };
const maxLogBytes = 65536;
const workspace = { alias: 'app', path: workspaceRoot };
const otherWorkspace = { alias: 'other', path: path.join(root, 'other-workspace') };
const principalA = { clientId: 'client-a', authMode: 'oauth' };
const principalB = { clientId: 'client-b', authMode: 'oauth' };
const ownerStart = { taskId: 'work-session-a', principal: principalA, workspace: 'app' };
const ownerLater = { taskId: 'work-session-a', principal: principalA, workspace: 'app' };
const otherSession = { taskId: 'work-session-b', principal: principalA, workspace: 'app' };
const otherPrincipal = { taskId: 'work-session-c', principal: principalB, workspace: 'app' };
const otherWorkspaceContext = { taskId: 'work-session-d', principal: principalA, workspace: 'other' };
const workspaceRecovery = { principal: principalA, workspace: 'app' };
const createdProcessIds = [];
let externalChild = null;
let mismatchedChild = null;

fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(otherWorkspace.path, { recursive: true });
const persistentScript = path.join(workspaceRoot, 'persistent-child.cjs');
const exitScript = path.join(workspaceRoot, 'exit-child.cjs');
fs.writeFileSync(persistentScript, `
process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]));
process.stdout.write('READY\\n');
process.stdin.setEncoding('utf8');
let pendingInput = '';
process.stdin.on('data', value => {
  pendingInput += value;
  for (;;) {
    const newlineIndex = pendingInput.indexOf('\\n');
    if (newlineIndex < 0) break;
    const line = pendingInput.slice(0, newlineIndex + 1);
    pendingInput = pendingInput.slice(newlineIndex + 1);
    if (line.startsWith('NOISE:')) {
      const count = Number(line.slice(6).trim()) || 0;
      process.stdout.write('x'.repeat(count) + '\\n');
      continue;
    }
    process.stdout.write('ECHO:' + line);
  }
});
setInterval(() => {}, 1000);
`);
fs.writeFileSync(exitScript, `process.stderr.write('startup failed\\n'); process.exit(7);\n`);

try {
  await verifyWindowsJobRecovery();
  const initialInput = 'initial `$value "quoted"\n';
  const started = await startManagedProcess(workspace, config, {
    executable: process.execPath,
    argv: [persistentScript],
    input: initialInput,
    startupWaitMs: 100,
    maxLogBytes,
    label: 'persistent-managed-test',
    kind: 'service',
    purpose: 'Exercise persistent process lifecycle behavior.'
  }, ownerStart);
  createdProcessIds.push(started.processId);

  assert.match(started.processId, /^proc_[A-Za-z0-9_-]{20,160}$/);
  assert.equal(started.workspaceId, 'app');
  assert.equal(started.lifecycle, 'persistent');
  assert.equal(started.kind, 'service');
  assert.match(started.purpose, /persistent process lifecycle/);
  assert.match(started.metadataRevision, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(started.workSessionId, ownerStart.taskId);
  assert.equal(started.readiness.verified, true);
  assert.equal(started.status, 'running');
  assert.deepEqual(
    activeProcessesForWorkSession(config, 'app', ownerStart.taskId).map(item => item.processId),
    [started.processId],
    'workflow process discovery must stay scoped to the owning work session'
  );
  assert.deepEqual(
    activeProcessesForWorkSession(config, 'app', otherSession.taskId),
    [],
    'another logical task must not receive process records from the same workspace'
  );

  const first = await waitForProcess(started.processId, ownerStart, snapshot =>
    snapshot.stdout.text.includes('READY') && snapshot.stdout.text.includes(`ECHO:${initialInput}`)
  );
  assert.match(first.stdout.text, /READY/);
  assert.ok(first.stdout.text.includes(`ECHO:${initialInput}`), 'direct process input must preserve backticks, dollar signs, quotes, and newlines');
  const deltaOnly = readManagedProcess(config, {
    processId: started.processId,
    stdoutOffset: first.stdout.nextOffset,
    stderrOffset: first.stderr.nextOffset,
    metadataRevision: first.metadataRevision
  }, ownerLater);
  assert.equal(deltaOnly.label, undefined);
  assert.equal(deltaOnly.metadataRevision, first.metadataRevision);
  assert.equal(first.stdout.invalidUtf8, true);
  assert.ok(first.stdout.base64.length > 0);

  await sleep(100);
  const afterStartupCall = readManagedProcess(config, {
    processId: started.processId,
    stdoutOffset: first.stdout.nextOffset,
    stderrOffset: 0
  }, ownerLater);
  assert.equal(afterStartupCall.status, 'running');

  assert.throws(
    () => readManagedProcess(config, { processId: started.processId }, otherPrincipal),
    error => error?.code === 'PROCESS_ACCESS_DENIED',
    'distinct object principals must not collapse to one process identity'
  );
  assert.throws(
    () => readManagedProcess(config, { processId: started.processId }, otherWorkspaceContext),
    error => error?.code === 'PROCESS_WORKSPACE_MISMATCH'
  );
  const crossTaskRead = readManagedProcess(config, { processId: started.processId }, otherSession);
  assert.equal(crossTaskRead.processId, started.processId, 'same-principal same-workspace recovery must inspect a process from another logical task');
  const tasklessRead = readManagedProcess(config, { processId: started.processId, workspace: 'app' }, workspaceRecovery);
  assert.equal(tasklessRead.processId, started.processId, 'process inspection must not require resurrecting the original work session');
  await assert.rejects(
    () => writeManagedProcess(config, { processId: started.processId, input: 'cross-task\n' }, otherSession),
    error => error?.code === 'PROCESS_SESSION_MISMATCH',
    'interactive process input must remain bound to the owning logical task'
  );
  const tasklessWrite = await writeManagedProcess(config, {
    processId: started.processId,
    input: 'taskless-write\n',
    workspace: 'app'
  }, workspaceRecovery);
  assert.equal(tasklessWrite.acceptedBytes, 15, 'same-principal workspace-scoped process input must not require resurrecting the original task');

  let outputUpdate = null;
  const outputUpdated = new Promise(resolve => {
    const unsubscribe = onManagedProcessChange(event => {
      if (event.processId !== started.processId || event.status !== 'running') return;
      unsubscribe();
      outputUpdate = event;
      resolve(event);
    });
  });
  const written = await writeManagedProcess(config, {
    processId: started.processId,
    input: 'hello\n'
  }, ownerLater);
  assert.equal(written.acceptedBytes, 6);
  const echoed = await waitForProcess(started.processId, ownerLater, snapshot => snapshot.stdout.text.includes('ECHO:hello'), {
    stdoutOffset: first.stdout.nextOffset
  });
  assert.match(echoed.stdout.text, /ECHO:hello/);
  await Promise.race([outputUpdated, sleep(1000)]);
  assert.ok(outputUpdate, 'persisted stdout/stderr changes must notify dashboard subscribers while the process is still running');
  const listedWithOutput = listManagedProcesses(config, {
    workspace: 'app',
    includeTail: true,
    includeTailOffsets: true,
    tailBytes: 8192
  }, ownerLater);
  const listedProcessWithOutput = listedWithOutput.processes.find(item => item.processId === started.processId);
  assert.match(listedProcessWithOutput?.stdoutTail || '', /ECHO:hello/);
  assert.ok(Number.isSafeInteger(listedProcessWithOutput?.stdoutTailStartOffset), 'dashboard process tails must expose an exact retained byte offset');
  const listedWithoutOutput = listManagedProcesses(config, { workspace: 'app' }, ownerLater);
  const listedProcessWithoutOutput = listedWithoutOutput.processes.find(item => item.processId === started.processId);
  assert.equal(Object.hasOwn(listedProcessWithoutOutput || {}, 'stdoutTail'), false, 'public process listings must stay compact unless output tails are explicitly requested');

  await writeManagedProcess(config, {
    processId: started.processId,
    input: 'NOISE:120000\n'
  }, ownerLater);
  const noisy = await waitForProcess(started.processId, ownerLater, snapshot => snapshot.stdoutBytes >= 120000);
  assert.ok(noisy.stdoutRetainedFromOffset > 0);
  assert.equal(noisy.stdout.truncatedBefore, true);
  assert.equal(noisy.stdout.offset, noisy.stdout.retainedFromOffset);
  assert.ok(noisy.stdout.totalBytes >= 120000);
  assert.ok(
    noisy.stdout.totalBytes - noisy.stdoutRetainedFromOffset <= maxLogBytes,
    'retained stdout must stay within the configured log cap'
  );
  const earlierRange = readManagedProcessLogRange(config, {
    processId: started.processId,
    stream: 'stdout',
    beforeOffset: noisy.stdout.totalBytes,
    maxBytes: 4096
  }, ownerLater);
  assert.equal(earlierRange.stream, 'stdout');
  assert.equal(earlierRange.range.nextOffset, noisy.stdout.totalBytes, 'backward dashboard reads must end exactly at the requested byte boundary');
  assert.ok(earlierRange.range.offset >= noisy.stdoutRetainedFromOffset, 'backward dashboard reads must never cross the retained-log boundary');

  const cursor = noisy.stdout.totalBytes;
  await writeManagedProcess(config, {
    processId: started.processId,
    input: 'after-noise\n'
  }, ownerLater);
  const incremental = await waitForProcess(started.processId, ownerLater, snapshot => snapshot.stdout.text.includes('ECHO:after-noise'), {
    stdoutOffset: cursor
  });
  assert.equal(incremental.stdout.requestedOffset, cursor);
  assert.match(incremental.stdout.text, /ECHO:after-noise/);

  const listedByOwner = listManagedProcesses(config, { workspace: 'app' }, ownerLater);
  assert.ok(listedByOwner.processes.some(item => item.processId === started.processId));
  const visibleFromOtherSession = listManagedProcesses(config, { workspace: 'app' }, otherSession);
  assert.equal(visibleFromOtherSession.processes.some(item => item.processId === started.processId), true, 'same-principal same-workspace process listing must support recovery across task boundaries');
  const visibleWithoutTask = listManagedProcesses(config, { workspace: 'app' }, workspaceRecovery);
  assert.equal(visibleWithoutTask.processes.some(item => item.processId === started.processId), true, 'process listing must work without the original work_id');
  const hiddenFromOtherPrincipal = listManagedProcesses(config, { workspace: 'app' }, otherPrincipal);
  assert.equal(hiddenFromOtherPrincipal.processes.some(item => item.processId === started.processId), false);
  assert.throws(
    () => listManagedProcesses(config, { workspace: 'other' }, ownerLater),
    error => error?.code === 'PROCESS_WORKSPACE_MISMATCH'
  );

  const stopped = await stopManagedProcess(config, {
    processId: started.processId,
    graceMs: 500,
    workspace: 'app'
  }, workspaceRecovery);
  assert.equal(stopped.status, 'stopped');
  assert.ok(stopped.endedAt);
  assert.equal(stopped.duplicate, false);
  assert.equal(stopped.processId, started.processId, 'same-principal workspace recovery must stop a known process without the old work_id');
  const duplicateStop = await stopManagedProcess(config, {
    processId: started.processId,
    graceMs: 0
  }, ownerLater);
  assert.equal(duplicateStop.status, stopped.status);
  assert.equal(duplicateStop.endedAt, stopped.endedAt);
  assert.equal(duplicateStop.duplicate, true);
  const activeAfterStop = listManagedProcesses(config, { workspace: 'app' }, ownerLater);
  assert.equal(activeAfterStop.processes.some(item => item.processId === started.processId), false);
  const historyAfterStop = listManagedProcesses(config, { workspace: 'app', includeTerminal: true }, ownerLater);
  assert.equal(historyAfterStop.processes.some(item => item.processId === started.processId), true);
  const terminalAfterStop = listManagedProcesses(config, { workspace: 'app', terminalOnly: true }, ownerLater);
  assert.equal(terminalAfterStop.processes.some(item => item.processId === started.processId), true, 'terminal-only process projection must expose recently ended processes');
  assert.equal(terminalAfterStop.processes.every(item => ['stopped', 'exited', 'failed'].includes(item.status)), true);
  assert.equal(dashboardManagedProcesses(config).some(item => item.processId === started.processId), true,
    'dashboard projection must retain a bounded recently-ended process tail instead of dropping terminal processes');

  const cancellationController = new AbortController();
  const cancelledStart = startManagedProcess(workspace, config, {
    executable: process.execPath,
    argv: [persistentScript],
    startupWaitMs: 3000,
    label: 'cancel-during-startup',
    kind: 'service',
    purpose: 'Exercise startup cancellation.'
  }, {
    taskId: 'work-session-cancel',
    principal: 'client-a',
    workspace: 'app',
    signal: cancellationController.signal
  });
  setTimeout(() => cancellationController.abort(), 100);
  await assert.rejects(
    cancelledStart,
    error => error?.code === 'TASK_CANCELLED' && error.cancelled === true
  );
  const afterStartupCancellation = listManagedProcesses(config, { workspace: 'app' }, ownerLater);
  assert.equal(afterStartupCancellation.processes.some(item => item.label === 'cancel-during-startup'
    && ['starting', 'running', 'stopping'].includes(item.status)), false);

  await assert.rejects(
    startManagedProcess(workspace, config, {
      executable: process.execPath,
      argv: [exitScript],
      startupWaitMs: 5000,
      label: 'startup-failure',
      kind: 'service',
      purpose: 'Exercise startup failure cleanup.'
    }, ownerLater),
    /exited during startup|Could not start managed process/i
  );
  const afterStartupFailure = listManagedProcesses(config, { workspace: 'app' }, ownerLater);
  assert.equal(afterStartupFailure.processes.some(item => item.label === 'startup-failure'
    && ['starting', 'running', 'stopping'].includes(item.status)), false);

  externalChild = spawn(process.execPath, [persistentScript], {
    cwd: workspaceRoot,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  await once(externalChild, 'spawn');
  const externalCreationIdentity = await readProcessCreationIdentity(externalChild.pid);
  assert.ok(externalCreationIdentity, 'restart recovery fixture requires a verifiable OS process creation identity');
  const staleProcessId = `proc_${'r'.repeat(24)}`;
  const staleDirectory = path.join(stateDir, 'processes', staleProcessId);
  fs.mkdirSync(staleDirectory, { recursive: true });
  fs.writeFileSync(path.join(staleDirectory, 'stdout.log'), 'historical output\n');
  fs.writeFileSync(path.join(staleDirectory, 'stderr.log'), '');
  fs.writeFileSync(path.join(staleDirectory, 'metadata.json'), JSON.stringify({
    schemaVersion: 4,
    runtimeId: 'previous-runtime',
    processId: staleProcessId,
    workspaceId: 'app',
    workspacePath: workspaceRoot,
    lifecycle: 'persistent',
    commandSummary: 'stale child',
    label: 'stale-restart-record',
    cwd: '.',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: '',
    exitCode: null,
    signal: '',
    pid: externalChild.pid,
    processCreationIdentity: externalCreationIdentity,
    stdoutBytes: 18,
    stderrBytes: 0,
    stdoutStartOffset: 0,
    stderrStartOffset: 0,
    environmentKeys: [],
    maxLogBytes: 65536
  }, null, 2));

  assert.throws(
    () => readManagedProcess(config, { processId: staleProcessId }, {
      connector: true,
      principal: 'client-a',
      workspace: 'app'
    }),
    error => error?.code === 'PROCESS_ACCESS_DENIED'
  );
  const restored = readManagedProcess(config, { processId: staleProcessId });
  assert.equal(restored.status, 'orphaned');
  assert.match(restored.error, /creation identity must be verified/i);
  const restoredStop = await stopManagedProcess(config, { processId: staleProcessId, graceMs: 250 });
  assert.equal(restoredStop.status, 'stopped');
  assert.equal(restoredStop.duplicate, false);
  assert.equal(await waitForChildExit(externalChild, 3000), true);
  externalChild = null;

  mismatchedChild = spawn(process.execPath, [persistentScript], {
    cwd: workspaceRoot,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore']
  });
  await once(mismatchedChild, 'spawn');
  const mismatchedProcessId = `proc_${'m'.repeat(24)}`;
  const mismatchedDirectory = path.join(stateDir, 'processes', mismatchedProcessId);
  fs.mkdirSync(mismatchedDirectory, { recursive: true });
  fs.writeFileSync(path.join(mismatchedDirectory, 'stdout.log'), '');
  fs.writeFileSync(path.join(mismatchedDirectory, 'stderr.log'), '');
  fs.writeFileSync(path.join(mismatchedDirectory, 'metadata.json'), JSON.stringify({
    schemaVersion: 4,
    runtimeId: 'previous-runtime',
    processId: mismatchedProcessId,
    workspaceId: 'app',
    workspacePath: workspaceRoot,
    lifecycle: 'persistent',
    kind: 'service',
    purpose: 'PID reuse safety fixture.',
    commandSummary: 'stale mismatched child',
    label: 'stale-mismatched-record',
    cwd: '.',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: '',
    exitCode: null,
    signal: '',
    pid: mismatchedChild.pid,
    processCreationIdentity: 'mismatched-process-creation-identity',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutStartOffset: 0,
    stderrStartOffset: 0,
    environmentKeys: [],
    maxLogBytes: 65536
  }, null, 2));
  const mismatchedRestored = readManagedProcess(config, { processId: mismatchedProcessId });
  assert.equal(mismatchedRestored.status, 'orphaned');
  await assert.rejects(
    stopManagedProcess(config, { processId: mismatchedProcessId, graceMs: 0 }),
    error => error?.code === 'PROCESS_IDENTITY_MISMATCH'
  );
  assert.equal(mismatchedChild.exitCode, null,
    'a live PID with mismatching creation identity must never be terminated by restart recovery');
  mismatchedChild.kill('SIGKILL');
  await waitForChildExit(mismatchedChild, 3000);
  mismatchedChild = null;

  const shutdownPersistence = await startManagedProcess(workspace, config, {
    executable: process.execPath,
    argv: [persistentScript],
    startupWaitMs: 100,
    label: 'shutdown-persistence',
    kind: 'service',
    purpose: 'Verify shutdown drains managed process persistence.'
  }, ownerLater);
  const shutdownDirectory = path.join(stateDir, 'processes', shutdownPersistence.processId);
  const shutdownResult = await stopAllManagedProcesses(config);
  assert.ok(shutdownResult.stopped >= 1, 'shutdown must stop the active persistence probe');
  fs.rmSync(shutdownDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  await sleep(150);
  assert.equal(fs.existsSync(shutdownDirectory), false,
    'managed process shutdown must not return while a late metadata write can recreate removed state');

  await verifyUnresolvedShutdownAccounting();

  console.log('Managed process identity, ownership, persistence, bounded output, restart, cancellation, shutdown durability, and idempotent stop tests passed.');
} finally {
  await stopAllManagedProcesses(config).catch(() => {});
  if (externalChild) {
    try { externalChild.kill('SIGKILL'); } catch {}
    await waitForChildExit(externalChild, 3000).catch(() => false);
  }
  if (mismatchedChild) {
    try { mismatchedChild.kill('SIGKILL'); } catch {}
    await waitForChildExit(mismatchedChild, 3000).catch(() => false);
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}


async function verifyWindowsJobRecovery() {
  const boot = { platform: 'win32', host: 'a'.repeat(64), boot: 'b'.repeat(64) };
  let observedBoot = boot;
  let instance = 0;
  const modulePrefix = new URL('../src/processManager.ts', import.meta.url).href + '?windows-recovery-';
  const bootModule = 'data:text/javascript,' + encodeURIComponent('export const currentMutationBootIdentity = () => globalThis.__relaiManagedRecoveryBoot();');
  globalThis.__relaiManagedRecoveryBoot = async () => observedBoot;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(modulePrefix) && specifier === './mutationBootIdentity.js') return { url: bootModule, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  });
  const recoveryConfig = { stateDir: path.join(root, 'windows-recovery') };
  const managers = [];
  const manager = async () => {
    const value = await import(modulePrefix + (++instance));
    managers.push(value);
    return value;
  };
  let scenario = 0;
  function fixture(fields = {}) {
    const processId = 'proc_' + String(++scenario).padStart(24, '0');
    const directory = path.join(recoveryConfig.stateDir, 'processes', processId);
    const jobDirectory = path.join(directory, 'job-fixture');
    const nonce = 'c'.repeat(64);
    const pid = 2000000000;
    fs.mkdirSync(jobDirectory, { recursive: true });
    fs.writeFileSync(path.join(jobDirectory, 'request.json'), JSON.stringify({ protocol: 1, nonce }));
    const receipt = { protocol: 1, nonce, helperPid: pid, rootPid: pid - 1, commandStarted: true,
      rootExited: false, activeProcesses: 1, final: false, jobComplete: false, cleanupConfirmed: false };
    fs.writeFileSync(path.join(jobDirectory, 'receipt.json'), JSON.stringify(receipt));
    const metadata = { schemaVersion: 4, runtimeId: 'previous-runtime', processId, workspaceId: 'recovery',
      workspacePath: workspaceRoot, workSessionId: 'recovery-session', lifecycle: 'persistent',
      status: 'orphaned', startedAt: new Date().toISOString(), endedAt: '', pid,
      processCreationIdentity: 'win32:1', windowsJobOwned: true, windowsJobDirectory: 'job-fixture',
      terminationConfirmed: false, terminationError: 'old cleanup error', error: 'old cleanup error', ...fields };
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata));
    return { processId, directory, jobDirectory, receipt };
  }
  const readMetadata = item => JSON.parse(fs.readFileSync(path.join(item.directory, 'metadata.json'), 'utf8'));
  try {
    const m = await manager();
    const late = fixture();
    assert.equal(m.readManagedProcess(recoveryConfig, late).status, 'orphaned');
    const record = m.activeProcessesForWorkSession(recoveryConfig, 'recovery', 'recovery-session').find(item => item.processId === late.processId);
    let releases = 0;
    record.hostResourceRelease = () => { releases++; };
    const changes = [];
    const unsubscribe = m.onManagedProcessChange(event => changes.push(event));
    fs.writeFileSync(path.join(late.jobDirectory, 'receipt.json'), JSON.stringify({ ...late.receipt,
      rootExited: true, rootExitCode: 0, activeProcesses: 0, final: true, jobComplete: true, cleanupConfirmed: true }));
    const originalRemove = fs.rmSync;
    const cleanupStates = [];
    fs.rmSync = (target, options) => {
      if (target === late.jobDirectory) cleanupStates.push(readMetadata(late));
      return originalRemove(target, options);
    };
    syncBuiltinESMExports();
    try {
      const resolved = m.readManagedProcess(recoveryConfig, late);
      assert.equal(resolved.status, 'exited', 'a cached orphan must reconcile a late exact native completion receipt');
      assert.equal(resolved.terminationConfirmed, true);
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.terminationError, undefined);
      assert.equal(releases, 1, 'late completion releases retained capacity exactly once');
      assert.equal(changes.filter(event => event.processId === late.processId).length, 1);
      assert.equal(m.listManagedProcesses(recoveryConfig).processes.some(item => item.processId === late.processId), false);
      assert.equal((await m.stopManagedProcess(recoveryConfig, late)).duplicate, true);
      assert.equal(releases, 1);
      assert.equal(readMetadata(late).status, 'exited');
      assert.ok(cleanupStates.length > 0, 'persisted terminal state permits native evidence cleanup');
      assert.ok(cleanupStates.every(item => item.terminationConfirmed === true && item.status === 'exited'), 'completion proof must survive until terminal metadata is saved');
    } finally { fs.rmSync = originalRemove; syncBuiltinESMExports(); unsubscribe(); }
    assert.equal((await manager()).readManagedProcess(recoveryConfig, late).status, 'exited', 'a second restart preserves resolved state after receipt cleanup');

    const alreadyConfirmed = fixture({ terminationConfirmed: true });
    assert.equal(m.readManagedProcess(recoveryConfig, alreadyConfirmed).status, 'stopped', 'durable cleanup confirmation must survive a missing native receipt');

    const failedPersistence = fixture();
    m.readManagedProcess(recoveryConfig, failedPersistence);
    fs.writeFileSync(path.join(failedPersistence.jobDirectory, 'receipt.json'), JSON.stringify({ ...failedPersistence.receipt,
      rootExited: true, rootExitCode: 0, activeProcesses: 0, final: true, jobComplete: true, cleanupConfirmed: true }));
    const mkdir = fs.promises.mkdir;
    let failedWrites = 0;
    fs.promises.mkdir = async (target, ...args) => {
      if (target === failedPersistence.directory) {
        failedWrites++;
        throw Object.assign(new Error('Fixture terminal metadata write denied'), { code: 'EACCES' });
      }
      return mkdir(target, ...args);
    };
    try {
      await m.stopManagedProcess(recoveryConfig, failedPersistence);
      assert.ok(failedWrites > 0, 'the fixture must exercise terminal persistence failure');
      assert.ok(fs.existsSync(path.join(failedPersistence.jobDirectory, 'receipt.json')), 'failed terminal persistence must retain native completion proof');
    } finally { fs.promises.mkdir = mkdir; }

    const previousBoot = fixture({ bootIdentity: { ...boot, boot: 'd'.repeat(64) } });
    const resolvedBoot = await m.stopManagedProcess(recoveryConfig, previousBoot);
    assert.equal(resolvedBoot.status, 'stopped', 'a verified kernel reboot settles jobs from the same host');
    assert.equal(resolvedBoot.terminationConfirmed, true);
    assert.equal(fs.existsSync(path.join(previousBoot.jobDirectory, 'control.json')), false, 'reboot recovery must never signal an old PID or helper');

    const sameBoot = fixture({ bootIdentity: boot });
    const pending = await m.stopManagedProcess(recoveryConfig, sameBoot);
    assert.equal(pending.status, 'orphaned', 'helper disappearance on the same boot is not native job-zero proof');
    assert.equal(pending.terminationConfirmed, false);
    assert.match(pending.recovery, /execution container|queryable Windows job identity/i, 'recovery must describe the missing execution evidence');
    assert.doesNotMatch(pending.recovery, /Choose Restart|Windows power menu/i, 'missing receipts must not prescribe a Windows reboot');
    assert.notEqual(pending.error, pending.recovery, 'the failure reason and recovery action must not repeat each other');
    assert.equal(pending.canStop, false, 'a missing controller must not advertise an ineffective Stop action');
    assert.equal(fs.existsSync(path.join(sameBoot.jobDirectory, 'control.json')), false);
    const refreshing = await manager();
    const checking = refreshing.readManagedProcess(recoveryConfig, sameBoot);
    await refreshing.stopManagedProcess(recoveryConfig, sameBoot);
    const refreshed = refreshing.readManagedProcess(recoveryConfig, { ...sameBoot, metadataRevision: checking.metadataRevision });
    assert.match(refreshed.recovery, /execution container|queryable Windows job identity/i, 'incremental reads must receive execution recovery guidance');

    const missingControl = fixture({ bootIdentity: boot, pid: process.pid });
    fs.rmSync(path.join(missingControl.jobDirectory, 'request.json'));
    const noControl = await m.stopManagedProcess(recoveryConfig, missingControl);
    assert.equal(noControl.terminationConfirmed, false, 'missing control identity cannot authorize terminating a live PID');
    assert.equal(noControl.canStop, false);

    const legacy = fixture();
    assert.equal((await m.stopManagedProcess(recoveryConfig, legacy)).terminationConfirmed, false);
    assert.deepEqual(readMetadata(legacy).recoveryBootIdentity, boot, 'legacy recovery saves a checkpoint before trusting a later reboot');
    assert.equal((await (await manager()).stopManagedProcess(recoveryConfig, legacy)).terminationConfirmed, false, 'app restart on the same boot cannot settle a legacy job');
    observedBoot = { ...boot, boot: 'e'.repeat(64) };
    const afterReboot = await manager();
    const reconciled = Promise.withResolvers();
    const unsubscribeReboot = afterReboot.onManagedProcessChange(event => {
      if (event.processId === legacy.processId && event.status === 'stopped') reconciled.resolve();
    });
    const timeout = setTimeout(() => reconciled.reject(new Error('Dashboard recovery did not publish verified reboot completion.')), 2000);
    try {
      afterReboot.readManagedProcess(recoveryConfig, legacy);
      await reconciled.promise;
      assert.equal(afterReboot.readManagedProcess(recoveryConfig, legacy).terminationConfirmed, true, 'dashboard reads recover legacy checkpoints after a changed boot without a Stop request');
    } finally { clearTimeout(timeout); unsubscribeReboot(); }

    observedBoot = { ...boot, host: 'f'.repeat(64) };
    const otherHost = fixture({ bootIdentity: boot });
    assert.equal((await (await manager()).stopManagedProcess(recoveryConfig, otherHost)).terminationConfirmed, false, 'another host cannot prove cleanup');
    observedBoot = null;
    const unavailable = fixture({ bootIdentity: boot });
    const unavailableResult = await (await manager()).stopManagedProcess(recoveryConfig, unavailable);
    assert.equal(unavailableResult.terminationConfirmed, false, 'a failed boot probe must retain ownership');
    assert.match(unavailableResult.recovery, /boot verification is unavailable/i);
    assert.equal(readMetadata(unavailable).recoveryBootIdentity, undefined);
  } finally {
    for (const value of managers) await value.stopAllManagedProcesses(recoveryConfig);
    hooks.deregister();
    delete globalThis.__relaiManagedRecoveryBoot;
  }
}

async function verifyUnresolvedShutdownAccounting() {
  const { createRelaiCoreRuntime } = await import('../src/core/runtime.ts');
  const isolatedState = path.join(root, 'unresolved-state');
  const isolatedConfig = {
    version: 3, stateDir: isolatedState, auditLogPath: path.join(isolatedState, 'audit.jsonl'),
    workspaces: { app: { path: workspaceRoot, commands: {}, testCommands: {} } }
  };
  const unresolvedId = `proc_${'u'.repeat(24)}`;
  const confirmedId = `proc_${'d'.repeat(24)}`;
  const syntheticPid = 987654321;
  const originalKill = process.kill;
  const observedSignals = [];
  process.kill = (pid, signal) => {
    if (Math.abs(pid) !== syntheticPid) return originalKill(pid, signal);
    observedSignals.push(signal);
    assert.equal(signal, 0, 'unverified synthetic identities must never receive a termination signal');
    return true;
  };
  try {
    for (const [processId, confirmed] of [[unresolvedId, false], [confirmedId, true]]) {
      const directory = path.join(isolatedState, 'processes', processId);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'stdout.log'), '');
      fs.writeFileSync(path.join(directory, 'stderr.log'), '');
      fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({
        schemaVersion: 4, runtimeId: 'previous-runtime', processId, workspaceId: 'app',
        workspacePath: workspaceRoot, lifecycle: 'persistent', kind: 'service',
        purpose: 'Synthetic shutdown accounting fixture.', commandSummary: 'synthetic fixture', cwd: '.',
        status: confirmed ? 'stopped' : 'running', startedAt: new Date().toISOString(),
        endedAt: confirmed ? new Date().toISOString() : '', pid: confirmed ? null : syntheticPid,
        terminationConfirmed: confirmed ? true : null, processCreationIdentity: '',
        stdoutBytes: 0, stderrBytes: 0, stdoutStartOffset: 0, stderrStartOffset: 0,
        environmentKeys: [], maxLogBytes: 65536
      }));
      readManagedProcess(isolatedConfig, { processId });
    }
    const summary = await stopAllManagedProcesses(isolatedConfig);
    assert.equal(summary.complete, false);
    assert.equal(summary.attempted, 1, 'confirmed terminal records must not be retried');
    assert.equal(summary.stopped, 0);
    assert.equal(summary.orphaned, 1);
    assert.equal(summary.unresolved, 1);
    assert.equal(summary.rejected, 1, 'identity refusal must remain represented as a rejected stop');
    assert.deepEqual(summary.leftovers.map(record => record.processId), [unresolvedId]);
    assert.match(summary.leftovers[0].reason, /cannot prove|identity|unverified/i);
    assert.equal(readManagedProcess(isolatedConfig, { processId: unresolvedId }).status, 'orphaned');

    const runtime = createRelaiCoreRuntime({ config: isolatedConfig });
    runtime.start();
    const shutdown = await runtime.shutdown();
    assert.equal(shutdown.clean, false, 'core shutdown must not certify unresolved process recovery as clean');
    assert.equal(shutdown.managedProcesses.complete, false);
    assert.equal(shutdown.managedProcesses.unresolved, 1);
    assert.ok(observedSignals.length > 0);
    assert.ok(observedSignals.every(signal => signal === 0));

    const failedState = path.join(root, 'failed-persistence-state');
    const failedConfig = { ...isolatedConfig, stateDir: failedState };
    const failedId = `proc_${'f'.repeat(24)}`;
    const failedDirectory = path.join(failedState, 'processes', failedId);
    fs.mkdirSync(failedDirectory, { recursive: true });
    const terminalMetadata = JSON.parse(fs.readFileSync(path.join(isolatedState, 'processes', confirmedId, 'metadata.json'), 'utf8'));
    fs.writeFileSync(path.join(failedDirectory, 'metadata.json'), JSON.stringify({ ...terminalMetadata, processId: failedId }));
    readManagedProcess(failedConfig, { processId: failedId });
    // Replace only the fixture's directory with a file, making every attempted
    // metadata write fail without relying on platform-specific file permissions.
    fs.rmSync(failedDirectory, { recursive: true, force: true });
    fs.writeFileSync(failedDirectory, 'synthetic storage failure');
    const failedPersistence = await stopAllManagedProcesses(failedConfig);
    assert.equal(failedPersistence.attempted, 0, 'confirmed terminal fixture needs no process stop');
    assert.equal(failedPersistence.complete, false, 'a consumed persistence rejection must prevent clean shutdown');
    assert.equal(failedPersistence.unresolved, 1);
    assert.match(failedPersistence.leftovers[0].reason, /persistence/i);
    const repeatedFailure = await stopAllManagedProcesses(failedConfig);
    assert.equal(repeatedFailure.complete, false, 'a retained persistence failure cannot disappear on a later flush');
  } finally {
    process.kill = originalKill;
  }
}

async function waitForProcess(processId, context, predicate, options = {}, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = readManagedProcess(config, {
      processId,
      stdoutOffset: options.stdoutOffset || 0,
      stderrOffset: options.stderrOffset || 0,
      maxBytes: options.maxBytes || 65536
    }, context);
    if (predicate(snapshot)) return snapshot;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for managed process ${processId}: ${JSON.stringify(snapshot)}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode) return true;
  return Promise.race([
    once(child, 'close').then(() => true),
    sleep(timeoutMs).then(() => child.exitCode !== null || Boolean(child.signalCode))
  ]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
