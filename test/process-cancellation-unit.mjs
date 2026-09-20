import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  acknowledgeNativeTaskCancellation,
  cancelNativeTask,
  getNativeTask
} from '../src/mcp/nativeTaskService.js';
import {
  completeNativeToolTask,
  createNativeToolTask,
  nativeToolTaskSignal
} from '../src/mcp/nativeToolTasks.js';
import { isProcessTreeAlive, runProcess, terminateProcessTree } from '../src/process.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-cancellation-'));
const stateDir = path.join(root, 'state');
const config = {
  stateDir,
  processTerminationGraceMs: 250,
  processForceWaitMs: 2000
};
const finiteScript = path.join(root, 'finite.cjs');
const gracefulScript = path.join(root, 'graceful.cjs');
const stubbornScript = path.join(root, 'stubborn.cjs');
const treeScript = path.join(root, 'tree-parent.cjs');
const inheritedPipeChildScript = path.join(root, 'inherited-pipe-child.cjs');
const inheritedPipeParentScript = path.join(root, 'inherited-pipe-parent.cjs');

fs.writeFileSync(finiteScript, `process.stdout.write('TASK:' + process.argv[2]);\n`);
fs.writeFileSync(gracefulScript, `
process.stdout.write('READY\\n');
process.on('SIGTERM', () => {
  process.stderr.write('GRACEFUL\\n');
  setTimeout(() => process.exit(0), 50);
});
setInterval(() => {}, 1000);
`);
fs.writeFileSync(stubbornScript, `
process.stdout.write('READY\\n');
process.on('SIGTERM', () => process.stderr.write('IGNORED\\n'));
setInterval(() => {}, 1000);
`);
fs.writeFileSync(treeScript, `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2]], { stdio: 'ignore' });
process.stdout.write('CHILD:' + child.pid + '\\n');
setInterval(() => {}, 1000);
`);
fs.writeFileSync(inheritedPipeChildScript, `
setTimeout(() => process.exit(0), 5000);
`);
fs.writeFileSync(inheritedPipeParentScript, `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.argv[2]], {
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true,
  windowsHide: true
});
process.stdout.write('CHILD:' + child.pid + '\\n');
child.unref();
`);

try {
  if (process.platform === 'win32') {
    assert.equal(
      isProcessTreeAlive({ pid: process.pid, exitCode: null, signalCode: 'SIGTERM' }),
      true,
      'Windows liveness must verify the OS PID instead of trusting a synthetic ChildProcess signalCode'
    );
  }

  const finiteTask = createNativeToolTask(config, {
    method: 'tools/call',
    name: 'relai_exec',
    logicalTaskId: 'work-finite',
    workspace: 'app',
    principal: 'client-a'
  });
  const finite = await runProcess(process.execPath, [finiteScript, finiteTask.taskId], {
    cwd: root,
    signal: nativeToolTaskSignal(finiteTask.taskId),
    maxOutputBytes: 65536
  }, config);
  assert.equal(finite.exitCode, 0);
  assert.equal(finite.stdout, `TASK:${finiteTask.taskId}`);
  const finiteCompleted = await completeNativeToolTask(config, finiteTask.taskId, {
    exitCode: finite.exitCode,
    stdout: finite.stdout
  });
  assert.equal(finiteCompleted.status, 'completed');
  assert.equal(finiteCompleted.result.exitCode, 0);

  const gracefulTask = createNativeToolTask(config, {
    method: 'tools/call',
    name: 'relai_exec',
    logicalTaskId: 'work-graceful',
    workspace: 'app',
    principal: 'client-a'
  });
  const gracefulPromise = runProcess(process.execPath, [gracefulScript], {
    cwd: root,
    signal: nativeToolTaskSignal(gracefulTask.taskId),
    terminationGraceMs: 1000,
    forceWaitMs: 2000,
    maxOutputBytes: 65536
  }, config);
  setTimeout(() => cancelNativeTask(config, gracefulTask.taskId), 200);
  const graceful = await gracefulPromise;
  assert.equal(graceful.cancelled, true);
  assert.equal(graceful.terminationConfirmed, true);
  if (process.platform !== 'win32') {
    assert.equal(graceful.forcedTermination, false);
    assert.match(graceful.stderr, /GRACEFUL/);
  } else {
    assert.equal(typeof graceful.forcedTermination, 'boolean');
  }
  assert.match(graceful.stderr, /operation cancelled/i);
  acknowledgeNativeTaskCancellation(config, gracefulTask.taskId, { executionStopped: true });
  assert.equal(getNativeTask(config, gracefulTask.taskId).status, 'cancelled');

  const forcedTask = createNativeToolTask(config, {
    method: 'tools/call',
    name: 'relai_exec',
    logicalTaskId: 'work-forced',
    workspace: 'app',
    principal: 'client-a'
  });
  const forcedPromise = runProcess(process.execPath, [stubbornScript], {
    cwd: root,
    signal: nativeToolTaskSignal(forcedTask.taskId),
    terminationGraceMs: 100,
    forceWaitMs: 2000,
    maxOutputBytes: 65536
  }, config);
  setTimeout(() => cancelNativeTask(config, forcedTask.taskId), 200);
  const forced = await forcedPromise;
  assert.equal(forced.cancelled, true);
  assert.equal(forced.terminationConfirmed, true);
  if (process.platform !== 'win32') {
    assert.equal(forced.forcedTermination, true);
    assert.equal(forced.signal, 'SIGKILL');
  } else {
    assert.equal(typeof forced.forcedTermination, 'boolean');
  }
  acknowledgeNativeTaskCancellation(config, forcedTask.taskId, { executionStopped: true });
  assert.equal(getNativeTask(config, forcedTask.taskId).status, 'cancelled');

  const treeTask = createNativeToolTask(config, {
    method: 'tools/call',
    name: 'relai_exec',
    logicalTaskId: 'work-tree',
    workspace: 'app',
    principal: 'client-a'
  });
  const treePromise = runProcess(process.execPath, [treeScript, stubbornScript], {
    cwd: root,
    signal: nativeToolTaskSignal(treeTask.taskId),
    terminationGraceMs: 100,
    forceWaitMs: 3000,
    maxOutputBytes: 65536
  }, config);
  setTimeout(() => cancelNativeTask(config, treeTask.taskId), 300);
  const treeResult = await treePromise;
  assert.equal(treeResult.cancelled, true);
  assert.equal(treeResult.terminationConfirmed, true);
  const childPid = Number(/CHILD:(\d+)/.exec(treeResult.stdout)?.[1]);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.equal(await waitForPidExit(childPid, 2000), true);
  acknowledgeNativeTaskCancellation(config, treeTask.taskId, { executionStopped: true });
  assert.equal(getNativeTask(config, treeTask.taskId).status, 'cancelled');

  const inheritedPipeStartedAt = Date.now();
  const inheritedPipe = await runProcess(process.execPath, [inheritedPipeParentScript, inheritedPipeChildScript], {
    cwd: root,
    maxOutputBytes: 65536
  }, config);
  const inheritedPipeWallMs = Date.now() - inheritedPipeStartedAt;
  const inheritedPipeChildPid = Number(/CHILD:(\d+)/.exec(inheritedPipe.stdout)?.[1]);
  assert.equal(inheritedPipe.exitCode, 0);
  assert.ok(Number.isSafeInteger(inheritedPipeChildPid) && inheritedPipeChildPid > 0);
  assert.ok(
    inheritedPipeWallMs < 3000,
    `a one-shot parent must not wait for a descendant that only inherited its output pipes (wall=${inheritedPipeWallMs}ms)`
  );
  assert.equal(pidAlive(inheritedPipeChildPid), true, 'pipe detachment must not kill an intentionally surviving background child');
  const inheritedPipeCleanup = await terminateProcessTree(inheritedPipeChildPid, { graceMs: 0, forceWaitMs: 2000 });
  assert.equal(inheritedPipeCleanup.exited, true);

  const alreadyCancelledTask = createNativeToolTask(config, {
    method: 'tools/call',
    name: 'relai_exec',
    logicalTaskId: 'work-pre-cancelled',
    workspace: 'app',
    principal: 'client-a'
  });
  cancelNativeTask(config, alreadyCancelledTask.taskId);
  const preCancelled = await runProcess(process.execPath, [stubbornScript], {
    cwd: root,
    signal: nativeToolTaskSignal(alreadyCancelledTask.taskId),
    terminationGraceMs: 0,
    forceWaitMs: 2000,
    maxOutputBytes: 65536
  }, config);
  assert.equal(preCancelled.cancelled, true);
  assert.equal(preCancelled.terminationConfirmed, true);
  acknowledgeNativeTaskCancellation(config, alreadyCancelledTask.taskId, { executionStopped: true });
  assert.equal(getNativeTask(config, alreadyCancelledTask.taskId).status, 'cancelled');

  console.log('Finite task linkage, inherited-pipe detachment, two-phase cancellation, descendant exit confirmation, graceful termination, and forced escalation tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !pidAlive(pid);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
