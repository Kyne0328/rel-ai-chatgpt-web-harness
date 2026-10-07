import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';
import { callTool as rawCallTool } from '../src/tools.js';
import { readConfig } from '../src/config.js';
import { activeProcessesForWorkSession, writeManagedProcess, cleanupTaskManagedProcesses, listManagedProcesses, readManagedProcess, startManagedProcess, stopAllManagedProcesses } from '../src/processManager.js';
import { isProcessTreeAlive } from '../src/process.js';
import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { resetToolActivity } from '../src/toolActivity.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const restoreMemory = installDeterministicHostMemory();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-lifetime-'));
const workspaceRoot = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configFile = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
fs.mkdirSync(workspaceRoot);
fs.writeFileSync(configFile, JSON.stringify({
  version: 3, stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspaceRoot, commands: {}, testCommands: {} } }
}));
process.env.REL_AI_MCP_CONFIG = configFile;
const context = { publicHttpOnly: true, principal: 'local:trusted' };
const callTool = (name, args) => rawCallTool(name, args, context);
const startArgs = {
  action: 'start', workspace: 'app', executable: process.execPath,
  argv: ['-e', 'setInterval(() => {}, 1000)'], kind: 'service',
  purpose: 'Lifecycle cleanup fixture.', startupWaitMs: 20
};

try {
  resetToolActivity();
  const config = readConfig();
  const workspace = { alias: 'app', path: workspaceRoot };
  await assert.rejects(() => startManagedProcess(workspace, config, { ...startArgs, lifecycle: 'task' }),
    error => error.code === 'PROCESS_TASK_LIFETIME_REQUIRES_WORK_ID');
  const projectless = await callTool('relai_work', { action: 'begin', bootstrap: 'none', title: 'Projectless process guard fixture' });
  await assert.rejects(() => callTool('relai_process', { ...startArgs, work_id: projectless.work_id, lifecycle: 'task' }),
    error => error.code === 'PROCESS_TASK_WORKSPACE_REQUIRED');
  const first = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Finish lifetime fixture' });
  const second = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Cancel lifetime fixture' });
  const persistent = await callTool('relai_process', { ...startArgs, work_id: first.work_id });
  const owned = await callTool('relai_process', { ...startArgs, work_id: first.work_id, lifecycle: 'task' });
  assert.notEqual(owned.processId, persistent.processId, 'task lifetime must never adopt an existing persistent service');
  assert.equal(owned.lifecycle, 'task');
  const ownedReleaseCalls = [];
  const ownedRecord = activeProcessesForWorkSession(config, 'app', first.work_id).find(item => item.processId === owned.processId);
  const ownedRelease = ownedRecord.hostResourceRelease;
  ownedRecord.hostResourceRelease = options => { ownedReleaseCalls.push(options); ownedRelease(options); };
  const reused = await callTool('relai_process', { ...startArgs, work_id: first.work_id, lifecycle: 'task' });
  assert.equal(reused.processId, owned.processId, 'same-owner task services retain safe deduplication');
  assert.equal(reused.reused, true);
  const other = await callTool('relai_process', { ...startArgs, work_id: second.work_id, lifecycle: 'task' });
  const finished = await callTool('relai_work', { action: 'finish', workspace: 'app', work_id: first.work_id, summary: 'Finish task-lifetime fixture.' });
  assert.equal(finished.processCleanup.complete, true);
  assert.equal(finished.processCleanup.stopped, 1);
  assert.deepEqual(ownedReleaseCalls, [undefined], 'task cleanup releases its concurrency slot exactly once');
  assert.equal(finished.processCleanup.preservedPersistent, 1);
  assert.equal(isProcessTreeAlive(owned.pid), false);
  assert.equal(isProcessTreeAlive(persistent.pid), true, 'persistent services survive finish');
  assert.equal(isProcessTreeAlive(other.pid), true, 'another task service survives finish');
  const duplicateFinish = await callTool('relai_work', { action: 'finish', workspace: 'app', work_id: first.work_id, summary: 'Retry finish.' });
  assert.equal(duplicateFinish.duplicate, true);
  assert.equal(duplicateFinish.processCleanup.stopped, 0);

  const cancelled = await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: second.work_id });
  assert.equal(cancelled.processCleanup.complete, true);
  assert.equal(cancelled.processCleanup.stopped, 1);
  assert.equal(isProcessTreeAlive(other.pid), false, 'cancel returns after bounded owned-process cleanup');
  assert.equal(isProcessTreeAlive(persistent.pid), true, 'persistent services survive another task cancellation');
  const duplicateCancel = await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: second.work_id });
  assert.equal(duplicateCancel.duplicate, true);
  assert.equal(duplicateCancel.processCleanup, undefined, 'terminal duplicate cancellation is a read-only result replay');
  await assert.rejects(() => rawCallTool('relai_work', { action: 'cancel', workspace: 'app', work_id: second.work_id }, { ...context, principal: 'other-principal' }),
    error => error.code === 'TASK_NOT_FOUND', 'terminal retries must still reject another principal');

  const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'processes', owned.processId, 'metadata.json'), 'utf8'));
  assert.equal(persisted.lifecycle, 'task');
  assert.equal(persisted.terminationConfirmed, true);
  const ownerContext = { taskId: first.work_id, workspace: 'app', principal: 'local:trusted', connector: true };
  const synthetic = (suffix, fields) => {
    const processId = 'proc_' + suffix.repeat(24);
    const directory = path.join(stateDir, 'processes', processId);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'stdout.log'), '');
    fs.writeFileSync(path.join(directory, 'stderr.log'), '');
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify({
      ...persisted, processId, runtimeId: 'previous-runtime', status: 'running', endedAt: '',
      terminationConfirmed: null, rootExitConfirmed: false, pid: persistent.pid,
      ...fields
    }));
    readManagedProcess(config, { processId }, { internal: true });
    return processId;
  };
  const mismatchId = synthetic('m', { processCreationIdentity: 'wrong-fixture-identity' });
  const foreignId = synthetic('f', { principalKey: 'different-principal' });
  const protectedCleanup = await cleanupTaskManagedProcesses(config, 'app', first.work_id, ownerContext);
  assert.equal(protectedCleanup.complete, false);
  assert.ok(protectedCleanup.leftovers.some(item => item.processId === mismatchId && /identity/i.test(item.reason)));
  assert.ok(protectedCleanup.leftovers.some(item => item.processId === foreignId && /ownership/i.test(item.reason)));
  assert.equal(isProcessTreeAlive(persistent.pid), true, 'identity mismatches and foreign principals must not be signalled');
  await assert.rejects(() => cleanupTaskManagedProcesses(config, 'app', first.work_id, { ...ownerContext, taskId: second.work_id }),
    error => error.code === 'PROCESS_SESSION_MISMATCH');

  const blockedTask = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Unconfirmed cleanup fixture' });
  synthetic('b', { workSessionId: blockedTask.work_id, processCreationIdentity: 'unverified-cleanup-fixture' });
  const blockedFinish = await callTool('relai_work', { action: 'finish', workspace: 'app', work_id: blockedTask.work_id, summary: 'Must not falsely finish.' });
  assert.equal(blockedFinish.ok, false);
  assert.equal(blockedFinish.completionKnown, false);
  assert.equal(blockedFinish.errorCode, 'PROCESS_CLEANUP_INCOMPLETE');
  assert.equal(blockedFinish.processCleanup.admissionBudgetMs, 10000);
  const blockedCancel = await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: blockedTask.work_id });
  assert.equal(blockedCancel.processCleanup.complete, false, 'cancellation must preserve unresolved cleanup diagnostics');
  assert.equal(isProcessTreeAlive(persistent.pid), true);

  const startupTask = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Startup race fixture' });
  const startupController = new AbortController();
  const startupContext = { ...ownerContext, taskId: startupTask.work_id, signal: startupController.signal };
  const pendingStart = startManagedProcess(workspace, config, {
    ...startArgs, lifecycle: 'task', purpose: 'Startup cancellation race.', startupWaitMs: 3000
  }, startupContext);
  // Observe rejection immediately to avoid an unhandled rejection during cleanup.
  const startOutcome = pendingStart.then(value => ({ value }), error => ({ error }));
  let starting;
  const startupDeadline = Date.now() + 5000;
  while (!starting && Date.now() < startupDeadline) {
    starting = listManagedProcesses(config, { workspace: 'app' }, startupContext).processes.find(item => item.workSessionId === startupContext.taskId);
    if (!starting) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(starting, 'startup-race fixture must reach its owned process record');
  startupController.abort();
  const raceCleanup = await cleanupTaskManagedProcesses(config, 'app', startupContext.taskId, startupContext);
  assert.equal((await startOutcome).error?.code, 'TASK_CANCELLED');
  assert.equal(raceCleanup.complete, true, JSON.stringify(raceCleanup));
  const afterRace = readManagedProcess(config, { processId: starting.processId }, { internal: true });
  assert.equal(afterRace.terminationConfirmed, true, 'startup failure cleanup must preserve a concurrent confirmed stop');
  assert.equal(afterRace.status, 'stopped');

  const naturalTask = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Natural root fixture' });
  const naturalPersistent = await startManagedProcess(workspace, config, {
    ...startArgs, purpose: 'Natural persistent root exit proof.',
    argv: ['-e', 'process.stdin.once("data", () => process.exit(0)); setInterval(() => {}, 1000)']
  }, { ...ownerContext, taskId: naturalTask.work_id });
  const naturalReleaseCalls = [];
  const naturalRecord = activeProcessesForWorkSession(config, 'app', naturalTask.work_id).find(item => item.processId === naturalPersistent.processId);
  const naturalRelease = naturalRecord.hostResourceRelease;
  naturalRecord.hostResourceRelease = options => { naturalReleaseCalls.push(options); naturalRelease(options); };
  await writeManagedProcess(config, { processId: naturalPersistent.processId, input: 'exit\n' }, { ...ownerContext, taskId: naturalTask.work_id });
  const naturalDeadline = Date.now() + 5000;
  while (!naturalReleaseCalls.length && Date.now() < naturalDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(naturalReleaseCalls, [undefined], 'root exit releases the concurrency slot without memory settling credits');
  const natural = await startManagedProcess(workspace, config, {
    ...startArgs, lifecycle: 'task', purpose: 'Natural root exit evidence.',
    argv: ['-e', 'setTimeout(() => process.exit(0), 2000)']
  }, { ...ownerContext, taskId: naturalTask.work_id });
  let nativeCompletion;
  let completedNativeJob;
  if (process.platform === 'win32') {
    const nativeRecord = activeProcessesForWorkSession(config, 'app', naturalTask.work_id).find(item => item.processId === natural.processId);
    const nativeJob = nativeRecord.windowsJob;
    completedNativeJob = nativeJob;
    const cleanup = nativeJob.cleanup;
    nativeJob.cleanup = function(...args) {
      nativeCompletion = { receipt: this.receipt(), outcome: this.outcome() };
      return cleanup.apply(this, args);
    };
  }
  let rootExit;
  const naturalExitDeadline = Date.now() + 6000;
  do {
    await new Promise(resolve => setTimeout(resolve, 20));
    rootExit = readManagedProcess(config, { processId: natural.processId }, { internal: true });
  } while ((!rootExit.rootExitConfirmed || (process.platform === 'win32' && !nativeCompletion)) && Date.now() < naturalExitDeadline);
  assert.equal(rootExit.rootExitConfirmed, true);
  if (process.platform === 'win32') {
    assert.equal(nativeCompletion?.receipt?.final, true);
    assert.equal(nativeCompletion.receipt.activeProcesses, 0);
    assert.equal(nativeCompletion.receipt.cleanupConfirmed, true);
    assert.equal(nativeCompletion.outcome.exited, true);
    assert.equal(fs.existsSync(completedNativeJob.directory), false, 'the actual native receipt directory was cleaned up');
    assert.equal(completedNativeJob.outcome().exited, true, 'real native-zero proof survives receipt cleanup');
    assert.equal((await completedNativeJob.stop('stop', 1000)).exited, true, 'repeated stop retains real native completion proof');
    assert.equal(rootExit.terminationConfirmed, true, 'native job-zero evidence confirms the entire owned lifetime');
    assert.equal(rootExit.status, 'exited');
    const nativeCleanup = await cleanupTaskManagedProcesses(config, 'app', naturalTask.work_id, { ...ownerContext, taskId: naturalTask.work_id });
    assert.equal(nativeCleanup.complete, true);
    // Keep the original conservative contract for legacy records with only
    // root-death evidence. This dead PID belongs to the completed fixture.
    const legacyNatural = synthetic('r', {
      workSessionId: naturalTask.work_id, pid: natural.pid, processCreationIdentity: '',
      windowsJobOwned: false, windowsJobDirectory: '', windowsRootPid: null, windowsRootCreationIdentity: ''
    });
    const legacyExit = readManagedProcess(config, { processId: legacyNatural }, { internal: true });
    assert.equal(legacyExit.terminationConfirmed, false);
    assert.equal(legacyExit.status, 'orphaned');
    const rootCleanup = await cleanupTaskManagedProcesses(config, 'app', naturalTask.work_id, { ...ownerContext, taskId: naturalTask.work_id });
    assert.equal(rootCleanup.complete, false, 'legacy root death cannot prove detached descendants are gone');
    assert.match(rootCleanup.leftovers[0].reason, /descendant/i);
  } else {
    assert.equal(rootExit.terminationConfirmed, false, 'natural root exit alone must not imply descendant cleanup');
    assert.equal(rootExit.status, 'orphaned');
    const rootCleanup = await cleanupTaskManagedProcesses(config, 'app', naturalTask.work_id, { ...ownerContext, taskId: naturalTask.work_id });
    assert.equal(rootCleanup.complete, true, 'an absent owned POSIX process group permits confirmed cleanup');
  }
  console.log('Task process lifetimes, finish/cancel cleanup, persistent/cross-task preservation, PID identity checks, and root-exit evidence passed.');
} finally {
  await stopAllManagedProcesses(readConfig()).catch(() => {});
  await repositoryIntelligence.shutdown();
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  resetTaskHistoryCaches();
  resetToolActivity();
  restoreMemory();
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
