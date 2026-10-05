import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

// Exercise the Windows state machine on every platform without targeting any
// real process. A root-only liveness check cannot prove its descendants died.
export async function verifyWindowsRootExitTermination(terminateProcessTree) {
  const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const nativeKill = process.kill;
  const nativeSpawn = childProcess.spawn;
  const rootPid = 987654321;
  const descendantPid = 987654322;
  let rootAlive = false;
  let descendantAlive = true;
  let helperExitCode = 1;
  let helperCount = 0;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.kill = (pid, signal) => {
      assert.equal(signal, 0, 'the fixture only permits liveness checks');
      if (pid === descendantPid && descendantAlive) return true;
      if (pid === rootPid && rootAlive) return true;
      assert.ok(pid === rootPid || pid === descendantPid);
      throw Object.assign(new Error('Fixture PID exited.'), { code: 'ESRCH' });
    };
    childProcess.spawn = command => {
      assert.match(command, /taskkill\.exe$/i);
      helperCount += 1;
      const helper = new EventEmitter();
      helper.kill = () => true;
      helper.unref = () => {};
      queueMicrotask(() => {
        rootAlive = false;
        if (helperExitCode === 0) descendantAlive = false;
        helper.emit('close', helperExitCode);
      });
      return helper;
    };
    syncBuiltinESMExports();
    const alreadyExited = await terminateProcessTree(rootPid, { graceMs: 0, forceWaitMs: 10 });
    assert.equal(process.kill(descendantPid, 0), true);
    assert.equal(alreadyExited.exited, false, 'an absent Windows root is not evidence that descendants exited');
    assert.equal(helperCount, 0, 'do not send a late termination request to an absent root');

    rootAlive = true;
    const failedHelper = await terminateProcessTree(rootPid, { graceMs: 0, forceWaitMs: 10 });
    assert.equal(process.kill(descendantPid, 0), true);
    assert.equal(failedHelper.exited, false, 'root exit during a failed taskkill is not tree-exit proof');

    rootAlive = true;
    helperExitCode = 0;
    const successfulHelper = await terminateProcessTree(rootPid, { graceMs: 0, forceWaitMs: 10 });
    assert.equal(successfulHelper.exited, true, 'successful taskkill plus root exit preserves the confirmed-termination path');
    assert.equal(successfulHelper.forceSignalSent, true);
    assert.equal(descendantAlive, false);
  } finally {
    childProcess.spawn = nativeSpawn;
    process.kill = nativeKill;
    Object.defineProperty(process, 'platform', nativePlatform);
    syncBuiltinESMExports();
  }
  console.log('Windows root absence and failed taskkill never assert descendant termination.');
}
