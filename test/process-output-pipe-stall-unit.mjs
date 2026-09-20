import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess, terminateProcessTree } from '../src/process.js';
import { pendingWorkspaceOperations, runWorkspaceOperation } from '../src/workspaceOperationQueue.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-output-pipe-stall-'));
const stateDir = path.join(root, 'state');
const childScript = path.join(root, 'child.mjs');
const parentScript = path.join(root, 'parent.mjs');
const pidFile = path.join(root, 'child.pid');

fs.writeFileSync(childScript, 'setTimeout(() => process.exit(0), 15000);\n');
fs.writeFileSync(parentScript, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const child = spawn(process.execPath, [process.argv[2]], {
  stdio: ['ignore', process.stdout, process.stderr],
  detached: true,
  windowsHide: true
});
fs.writeFileSync(process.argv[3], String(child.pid));
child.unref();
`);

let childPid = 0;
let cleanupTimer = null;
let forcedFixtureCleanup = false;
try {
  const holder = runWorkspaceOperation('output-pipe-stall', () => runProcess(
    process.execPath,
    [parentScript, childScript, pidFile],
    {
      cwd: root,
      timeout: 5000,
      terminationGraceMs: 50,
      forceWaitMs: 100,
      maxOutputBytes: 65536
    },
    { stateDir }
  ), { mode: 'write', scope: 'mutation', taskId: 'holder' });

  for (let index = 0; index < 100 && !fs.existsSync(pidFile); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(pidFile), true, 'fixture background child must start');
  childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);

  let waiterEntered = false;
  const waiter = runWorkspaceOperation('output-pipe-stall', async () => {
    waiterEntered = true;
    return 'entered';
  }, { mode: 'write', scope: 'mutation', taskId: 'waiter' });

  cleanupTimer = setTimeout(() => {
    forcedFixtureCleanup = true;
    try { process.kill(childPid, 'SIGKILL'); } catch {}
  }, 1200);

  const startedAt = Date.now();
  const result = await holder;
  const elapsedMs = Date.now() - startedAt;
  clearTimeout(cleanupTimer);
  cleanupTimer = null;

  assert.equal(forcedFixtureCleanup, false,
    'runProcess must settle without relying on external cleanup when a descendant keeps inherited output pipes open');
  assert.equal(result.exitCode, 0,
    'a detached descendant keeping inherited output handles open must not change the completed parent exit code');
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, undefined);
  assert.ok(elapsedMs < 1200, `output-pipe stall should settle before external cleanup, took ${elapsedMs}ms`);

  assert.equal(await waiter, 'entered',
    'the workspace mutation lane must release after the inherited-pipe guard settles the holder');
  assert.equal(waiterEntered, true);
  assert.equal(pendingWorkspaceOperations(), 0);
} finally {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  if (childPid > 0) {
    await terminateProcessTree(childPid, { graceMs: 0, forceWaitMs: 2000 });
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('Inherited output-pipe stalls settle promptly and release the workspace mutation lane.');
