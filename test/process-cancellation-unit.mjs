import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { listMutationProcessRecords, runWithMutationProcessOwnership } from '../src/mutationProcessOwnership.js';

import { isProcessTreeAlive, runProcess, summarizeCommand, terminateProcessTree } from '../src/process.js';
import { verifyWindowsRootExitTermination } from './fixtures/windows-root-exit-termination.mjs';

await verifyWindowsRootExitTermination(terminateProcessTree);

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

fs.writeFileSync(finiteScript, `process.stdout.write('ARG:' + process.argv[2]);\n`);
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
if (process.argv[3]) require('node:fs').writeFileSync(process.argv[3], String(child.pid));
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

  const finite = await runProcess(process.execPath, [finiteScript, 'finite'], {
    cwd: root,
    maxOutputBytes: 65536
  }, config);
  assert.equal(finite.exitCode, 0);
  assert.equal(finite.stdout, 'ARG:finite');


  // Deadline signals and explicit cancellation share cleanup, not classification.
  const directTimeout = await runProcess(process.execPath, [stubbornScript], {
    cwd: root, timeout: 200, forceWaitMs: 2000
  }, config);
  assert.equal(directTimeout.timedOut, true);
  assert.notEqual(directTimeout.cancelled, true);
  assert.equal(directTimeout.terminationConfirmed, true);

  const signalTimeout = await runProcess(process.execPath, [stubbornScript], {
    cwd: root, signal: AbortSignal.timeout(200), forceWaitMs: 2000
  }, config);
  assert.equal(signalTimeout.timedOut, true);
  assert.notEqual(signalTimeout.cancelled, true);
  assert.equal(signalTimeout.terminationConfirmed, true);
  assert.match(signalTimeout.stdout, /READY/);

  const noSpawnMarker = path.join(root, 'must-not-spawn');
  for (const reason of [new DOMException('Deadline expired.', 'TimeoutError'), new Error('manual timeout message'), new DOMException('Manual cancellation.', 'AbortError')]) {
    const controller = new AbortController();
    controller.abort(reason);
    const noSpawn = await runProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', noSpawnMarker], {
      cwd: root, signal: controller.signal
    }, config);
    assert.equal(noSpawn.timedOut, reason.name === 'TimeoutError');
    assert.equal(noSpawn.cancelled, reason.name !== 'TimeoutError');
    assert.equal(noSpawn.terminationConfirmed, true);
    assert.equal(noSpawn.forcedTermination, false);
    assert.equal(noSpawn.durationMs, 0);
    assert.equal(fs.existsSync(noSpawnMarker), false, 'an already aborted request must not spawn a process');
  }
  const markerArgs = ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', noSpawnMarker];
  const expired = await runProcess(process.execPath, markerArgs, {
    cwd: root, deadlineAtMs: Date.now() - 1, resourceClass: 'heavy', resourceOwner: 'deadline-fixture'
  }, config);
  assert.equal(fs.existsSync(noSpawnMarker), false, 'an expired absolute deadline must synchronously prevent the physical child');
  assert.equal(expired.executed, false, 'an expired absolute deadline must report no spawn');
  assert.equal(finite.executed, true, 'a normally completed child was physically started');
  assert.equal(expired.timedOut, true);
  assert.equal(expired.cancelled, false);
  assert.equal(fs.existsSync(noSpawnMarker), false);

  const originalNow = Date.now;
  const beforePreparation = originalNow();
  let clock = beforePreparation;
  const delayedEnvironment = {};
  Object.defineProperty(delayedEnvironment, 'RELAI_DEADLINE_FIXTURE', {
    enumerable: true,
    get() { clock = beforePreparation + 100; return 'prepared'; }
  });
  Date.now = () => clock;
  try {
    const expiredDuringPreparation = await runProcess(process.execPath, markerArgs, {
      cwd: root, env: delayedEnvironment, deadlineAtMs: beforePreparation + 50,
      resourceClass: 'heavy', resourceOwner: 'deadline-fixture'
    }, config);
    assert.equal(expiredDuringPreparation.executed, false, 'the final pre-spawn gate must recheck time after environment preparation');
    assert.equal(expiredDuringPreparation.timedOut, true);
    assert.equal(fs.existsSync(noSpawnMarker), false);
  } finally { Date.now = originalNow; }

  const cancelledBeforeDeadline = await runProcess(process.execPath, markerArgs, {
    cwd: root, signal: AbortSignal.abort(new DOMException('User stopped the operation.', 'AbortError')),
    deadlineAtMs: Date.now() - 1
  }, config);
  assert.equal(cancelledBeforeDeadline.executed, false);
  assert.equal(cancelledBeforeDeadline.cancelled, true);
  assert.equal(cancelledBeforeDeadline.timedOut, false, 'an existing user cancellation keeps its first-cause classification');
  const spawnFailure = await runProcess(path.join(root, 'missing-executable'), [], { cwd: root }, config);
  assert.equal(spawnFailure.executed, false, 'a spawn error is not physical command execution');
  assert.equal(spawnFailure.spawnError, true);
  const afterDeadline = await runProcess(process.execPath, [finiteScript, 'lease-released'], {
    cwd: root, resourceClass: 'heavy', resourceOwner: 'deadline-fixture', queueTimeoutMs: 1000
  }, config);
  assert.equal(afterDeadline.executed, true, 'pre-spawn exits must release the resource lease');
  assert.equal(afterDeadline.exitCode, 0);
  assert.equal(summarizeCommand({ executed: false, exitCode: -1 }).executed, false);

  assert.equal(summarizeCommand({ exitCode: 0, timedOut: true }).ok, false);
  assert.equal(summarizeCommand({ exitCode: 0, cancelled: true }).ok, false);

  const gracefulController = new AbortController();
  const gracefulPromise = runProcess(process.execPath, [gracefulScript], {
    cwd: root,
    signal: gracefulController.signal,
    terminationGraceMs: 1000,
    forceWaitMs: 2000,
    maxOutputBytes: 65536
  }, config);
  setTimeout(() => gracefulController.abort(new Error('operation cancelled')), 200);
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

  const forcedController = new AbortController();
  const forcedPromise = runProcess(process.execPath, [stubbornScript], {
    cwd: root,
    signal: forcedController.signal,
    terminationGraceMs: 100,
    forceWaitMs: 2000,
    maxOutputBytes: 65536
  }, config);
  setTimeout(() => forcedController.abort(new Error('operation cancelled')), 200);
  const forced = await forcedPromise;
  assert.equal(forced.cancelled, true);
  assert.equal(forced.terminationConfirmed, true);
  if (process.platform !== 'win32') {
    assert.equal(forced.forcedTermination, true);
    assert.equal(forced.signal, 'SIGKILL');
  } else {
    assert.equal(typeof forced.forcedTermination, 'boolean');
  }

  const treeController = new AbortController();
  const treePromise = runProcess(process.execPath, [treeScript, stubbornScript], {
    cwd: root,
    signal: treeController.signal,
    terminationGraceMs: 100,
    forceWaitMs: 3000,
    maxOutputBytes: 65536
  }, config);
  setTimeout(() => treeController.abort(new Error('operation cancelled')), 300);
  const treeResult = await treePromise;
  assert.equal(treeResult.cancelled, true);
  assert.equal(treeResult.terminationConfirmed, true);
  const childPid = Number(/CHILD:(\d+)/.exec(treeResult.stdout)?.[1]);
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.equal(await waitForPidExit(childPid, 2000), true);

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

  const preCancelledController = new AbortController();
  preCancelledController.abort(new Error('operation cancelled'));
  const preCancelled = await runProcess(process.execPath, [stubbornScript], {
    cwd: root,
    signal: preCancelledController.signal,
    terminationGraceMs: 0,
    forceWaitMs: 2000,
    maxOutputBytes: 65536
  }, config);
  assert.equal(preCancelled.cancelled, true);
  assert.equal(preCancelled.terminationConfirmed, true);

  // A helper that never closes must not turn a bounded Windows termination
  // attempt into an infinite wait. No real process is targeted by this fixture.
  const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const nativeSpawn = childProcess.spawn;
  const nativeKill = process.kill;
  let helperKilled = false;
  let helperTimer;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.kill = (pid, signal) => {
      assert.equal(pid, 987654321);
      assert.equal(signal, 0);
      return true;
    };
    childProcess.spawn = () => {
      const helper = new EventEmitter();
      helper.kill = () => { helperKilled = true; return true; };
      helper.unref = () => {};
      return helper;
    };
    syncBuiltinESMExports();
    const outcome = await Promise.race([
      terminateProcessTree(987654321, { graceMs: 0, forceWaitMs: 25 }),
      new Promise((_, reject) => {
        helperTimer = setTimeout(() => reject(new Error('Hung taskkill helper exceeded its termination budget.')), 6000);
      })
    ]);
    assert.equal(outcome.exited, false, 'helper timeout must never claim the target stopped');
    assert.equal(helperKilled, true, 'the timed-out helper must release its own process handle');
  } finally {
    if (helperTimer) clearTimeout(helperTimer);
    childProcess.spawn = nativeSpawn;
    process.kill = nativeKill;
    Object.defineProperty(process, 'platform', nativePlatform);
    syncBuiltinESMExports();
  }

  if (process.platform === 'win32') {
    // This real Windows child exits before cancellation while its detached
    // descendant keeps inherited pipes open. Root exit is known, tree exit is
    // not; output settlement must not erase its durable mutation ownership.
    const controller = new AbortController();
    const owner = 'root-exited-descendant-alive';
    let descendantPid = 0;
    const descendantPidFile = path.join(root, 'windows-descendant.pid');
    try {
      const result = await runWithMutationProcessOwnership(config, owner, () => runProcess(
        process.execPath, [inheritedPipeParentScript, inheritedPipeChildScript, descendantPidFile],
        {
          cwd: root, signal: controller.signal, forceWaitMs: 25,
          onPhase(event) {
            if (event.phase === 'exited') controller.abort(new Error('Cancel after physical root exit.'));
          }
        }, config
      ));
      descendantPid = Number(/CHILD:(\d+)/.exec(result.stdout)?.[1]);
      assert.ok(descendantPid > 0, 'the isolated descendant must have a known cleanup PID');
      assert.equal(pidAlive(descendantPid), true, 'fixture must prove the descendant survived root exit');
      assert.equal(result.rootExitConfirmed, true);
      assert.equal(result.cancelled, true);
      assert.equal(result.terminationConfirmed, false, 'root exit alone cannot authorize mutation-lane release after cancellation');
      assert.equal(listMutationProcessRecords(config, owner).length, 1,
        'ambiguous Windows descendant termination must retain durable mutation ownership');
      assert.equal(listMutationProcessRecords(config, owner)[0].terminationUncertain, true,
        'known termination uncertainty must survive a service restart');
    } finally {
      if (!descendantPid && fs.existsSync(descendantPidFile)) descendantPid = Number(fs.readFileSync(descendantPidFile, 'utf8'));
      if (descendantPid > 0 && pidAlive(descendantPid)) {
        await terminateProcessTree(descendantPid, { graceMs: 0, forceWaitMs: 2000 });
        assert.equal(await waitForPidExit(descendantPid, 5000), true);
      }
    }
  }

  if (process.platform === 'win32') {
    // Execa must not keep the caller pending after our Windows termination
    // attempt fails. Retain the owner of the still-live, test-owned child.
    for (const mode of ['timeout', 'deadline', 'cancel']) {
      const children = [];
      const originalSpawn = childProcess.spawn;
      let budgetTimer;
      let abortTimer;
      try {
        childProcess.spawn = (command, args, options) => {
          if (String(command).toLowerCase().endsWith('taskkill.exe')) {
            const helper = new EventEmitter();
            helper.kill = () => true;
            helper.unref = () => {};
            return helper;
          }
          const child = originalSpawn(command, args, options);
          children.push(child);
          return child;
        };
        syncBuiltinESMExports();
        const controller = new AbortController();
        const owner = 'failed-' + mode;
        const operation = runWithMutationProcessOwnership(config, owner, () => runProcess(
          process.execPath, ['-e', 'setTimeout(() => {}, 12000)'],
          {
            cwd: root, forceWaitMs: 25,
            ...(mode === 'timeout' ? { timeout: 100 } : { signal: controller.signal })
          },
          config
        ));
        if (mode !== 'timeout') abortTimer = setTimeout(() => controller.abort(mode === 'deadline'
          ? new DOMException('Fixture deadline expired.', 'TimeoutError')
          : new Error('fixture cancellation')), 100);
        const result = await Promise.race([
          operation,
          new Promise((_, reject) => {
            budgetTimer = setTimeout(() => reject(new Error('Failed Windows termination left runProcess pending.')), 6000);
          })
        ]);
        assert.equal(result.terminationConfirmed, false);
        assert.equal(mode !== 'cancel' ? result.timedOut : result.cancelled, true);
        assert.notEqual(mode === 'cancel' ? result.timedOut : result.cancelled, true);
        const owners = listMutationProcessRecords(config, owner);
        assert.equal(owners.length, 1, 'unconfirmed child ownership must survive the bounded result');
        assert.equal(owners[0].terminationUncertain, true, 'cancellation uncertainty must be durable');
        assert.equal(isProcessTreeAlive(owners[0].pid), true, 'fixture proves the result did not pretend the child exited');
      } finally {
        if (budgetTimer) clearTimeout(budgetTimer);
        if (abortTimer) clearTimeout(abortTimer);
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
        for (const child of children) {
          if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch {} }
          if (child.pid) assert.equal(await waitForPidExit(child.pid, 5000), true, 'test-owned child must be cleaned up');
        }
      }
    }
  }

  console.log('Process cancellation, bounded Windows termination, retained uncertainty ownership, and inherited-pipe detachment tests passed.');
} finally {
  // Let Windows close the detached test-child handles between cleanup retries.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
