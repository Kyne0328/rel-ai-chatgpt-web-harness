import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  activeProcessesForWorkSession,
  listManagedProcesses,
  readManagedProcess,
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
const ownerStart = { taskId: 'work-session-a', nativeTaskId: 'native-start-a', principal: principalA, workspace: 'app' };
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
  assert.equal(started.originatingTaskId, ownerStart.nativeTaskId);
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

  const written = await writeManagedProcess(config, {
    processId: started.processId,
    input: 'hello\n'
  }, ownerLater);
  assert.equal(written.acceptedBytes, 6);
  const echoed = await waitForProcess(started.processId, ownerLater, snapshot => snapshot.stdout.text.includes('ECHO:hello'), {
    stdoutOffset: first.stdout.nextOffset
  });
  assert.match(echoed.stdout.text, /ECHO:hello/);

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
