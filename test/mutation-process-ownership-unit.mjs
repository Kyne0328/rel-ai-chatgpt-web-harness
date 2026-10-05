import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

import { runProcess, isProcessTreeAlive, terminateProcessTree } from '../src/process.ts';
import { assertNoRecoveredMutationProcess } from '../src/tools/execution.js';
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
