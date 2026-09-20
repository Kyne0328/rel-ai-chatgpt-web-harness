import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess, isProcessTreeAlive, terminateProcessTree } from '../src/process.ts';
import { assertNoRecoveredMutationProcess } from '../src/tools/execution.js';
import {
  listMutationProcessRecords,
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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Mutation subprocess ownership survives interruption state and clears only after confirmed process exit.');
