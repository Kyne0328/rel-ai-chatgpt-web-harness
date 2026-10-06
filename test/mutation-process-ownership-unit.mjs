import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { runProcess, isProcessTreeAlive, terminateProcessTree } from '../src/process.ts';
import { assertNoRecoveredMutationProcess } from '../src/tools/execution.js';
import { readGitObservation } from '../src/repo/gitObservation.ts';
import {
  listMutationProcessRecords,
  markCurrentMutationProcessUncertain,
  recordCurrentMutationProcess,
  removeMutationProcessRecord,
  runWithMutationProcessOwnership
} from '../src/mutationProcessOwnership.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-mutation-process-ownership-'));
const config = { stateDir: path.join(root, 'state') };
const workspace = 'repo';

try {
  if (process.platform === 'win32') {
    // Reproduce Sagip's race: bookkeeping exits just before its cancellation
    // reaches the Windows tree terminator. This fixture has no descendants.
    const probeRoot = path.join(root, 'bookkeeping-probe');
    fs.mkdirSync(probeRoot);
    const originalSpawn = childProcess.spawn;
    const controller = new AbortController();
    let probePid = 0;
    childProcess.spawn = function(command, args, options) {
      if (args?.includes('status') && options?.cwd === probeRoot) {
        const child = originalSpawn.call(this, process.execPath,
          ['-e', 'setTimeout(() => process.stdout.write(""), 100)'], options);
        probePid = child.pid;
        child.once('exit', () => controller.abort(new DOMException('Bookkeeping deadline raced root exit.', 'TimeoutError')));
        return child;
      }
      return originalSpawn.call(this, command, args, options);
    };
    syncBuiltinESMExports();
    try {
      await runWithMutationProcessOwnership(config, 'bookkeeping-owner', async () => {
        const probe = await readGitObservation(probeRoot, config, { signal: controller.signal, timeoutMs: 3000 });
        assert.equal(probePid > 0, true);
        assert.equal(probe.rootExitConfirmed, true);
        assert.equal(probe.terminationConfirmed, false);
        assert.equal(probe.timedOut, true);
        assert.deepEqual(listMutationProcessRecords(config, 'bookkeeping-owner'), [],
          'a timed-out read-only Git observation must never create a workspace mutation quarantine');
        // Returning from observation must restore the surrounding mutation owner.
        recordCurrentMutationProcess(probePid);
        const marker = listMutationProcessRecords(config, 'bookkeeping-owner');
        assert.equal(marker.length, 1);
        removeMutationProcessRecord(marker[0]); // Known descendant-free test fixture only.
      });
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  }
  const result = await runWithMutationProcessOwnership(config, workspace, () => runProcess(
    process.execPath,
    ['-e', 'process.stdout.write("done")'],
    { timeout: 10_000 },
    config
  ));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(listMutationProcessRecords(config, workspace), [], 'settled mutation subprocesses must clear durable ownership');

  const child = await import('node:child_process').then(({ spawn }) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  }));
  const markerModule = await import('../src/mutationProcessOwnership.js');
  await runWithMutationProcessOwnership(config, workspace, () => markerModule.recordCurrentMutationProcess(child.pid));
  const records = listMutationProcessRecords(config, workspace);
  assert.equal(records.length, 1);
  assert.equal(isProcessTreeAlive(records[0].pid), true, 'live recovered mutator must remain detectable');
  assert.throws(
    () => assertNoRecoveredMutationProcess(config, workspace),
    error => error?.code === 'WORKSPACE_MUTATION_RECOVERY_PENDING' && error?.pid === child.pid,
    'a restarted mutation lane must stay blocked while the stale mutator is still alive'
  );
  await terminateProcessTree(child, { graceMs: 0, forceWaitMs: 2000 });
  assert.equal(isProcessTreeAlive(records[0].pid), false);
  assert.doesNotThrow(() => assertNoRecoveredMutationProcess(config, workspace), 'dead recovered mutators must be cleared automatically');
  assert.deepEqual(listMutationProcessRecords(config, workspace), []);

  // Reuse the exited fixture PID: unlike a random PID, its death is proven.
  // Load a fresh module instance to verify the flag survives runtime memory.
  await runWithMutationProcessOwnership(config, workspace, () => {
    recordCurrentMutationProcess(child.pid);
    assert.equal(markCurrentMutationProcessUncertain(child.pid, 'Fixture root exited while descendant termination was unconfirmed.'), true);
  });
  const reloaded = await import(`../src/mutationProcessOwnership.js?recovery-fixture=${Date.now()}`);
  const uncertain = reloaded.listMutationProcessRecords(config, workspace);
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].terminationUncertain, true);
  assert.match(uncertain[0].terminationUncertaintyReason, /unconfirmed/);
  assert.equal(isProcessTreeAlive(child.pid), false);
  assert.throws(
    () => assertNoRecoveredMutationProcess(config, workspace),
    error => error?.code === 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN'
      && error.retryable === false && error.pid === child.pid,
    'recovery must keep the mutation lane blocked when only the root is known to have exited'
  );
  assert.equal(fs.existsSync(uncertain[0].file), true, 'recovery must never delete explicit uncertainty on root-only evidence');
  assert.equal(reloaded.listMutationProcessRecords(config, workspace)[0].terminationUncertain, true);
  // Fixture cleanup only: operators must separately prove descendants stopped.
  removeMutationProcessRecord(uncertain[0]);

  await runWithMutationProcessOwnership(config, workspace, () => {
    const file = recordCurrentMutationProcess(child.pid);
    const before = fs.readFileSync(file, 'utf8');
    const originalMkdir = fs.mkdirSync;
    fs.mkdirSync = function(directory, ...args) {
      if (String(directory) === path.dirname(file)) {
        throw Object.assign(new Error('Injected ownership persistence failure.'), { code: 'ENOSPC' });
      }
      return originalMkdir.call(fs, directory, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(
        () => markCurrentMutationProcessUncertain(child.pid, 'Fixture uncertainty'),
        error => error?.code === 'MUTATION_TERMINATION_UNCERTAINTY_PERSIST_FAILED'
          && error.terminationConfirmed === false && /restart recovery cannot verify/i.test(error.message)
      );
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'failed uncertainty persistence must leave original ownership intact');
    } finally {
      fs.mkdirSync = originalMkdir;
      syncBuiltinESMExports();
    }
  });
  const failedPersistenceRecords = listMutationProcessRecords(config, workspace);
  assert.equal(failedPersistenceRecords.length, 1, 'a failed uncertainty update must never clear original ownership');
  removeMutationProcessRecord(failedPersistenceRecords[0]); // Isolated fixture cleanup, not automatic recovery.
  await runWithMutationProcessOwnership(config, workspace, () => recordCurrentMutationProcess(child.pid));
  assert.doesNotThrow(() => assertNoRecoveredMutationProcess(config, workspace),
    'a separate unflagged legacy marker retains its original root-only recovery behavior');
  assert.deepEqual(listMutationProcessRecords(config, workspace), []);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Mutation ownership preserves explicit uncertainty across reload, retains legacy cleanup, and reports persistence failure.');
