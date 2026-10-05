import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOutputSpillWriter, readOutputSpill, retainOutputStreams } from '../../src/outputSpill.js';

// No third-party dependencies. The child really exits; only this fixture's
// spill write completions are withheld. All monkey patches are restored.
export async function verifyStalledSpillFinalization({ baseline = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-spill-finalization-'));
  const config = { stateDir: root };
  const owner = 'stalled-spill-fixture';
  const originalOpen = fs.openSync;
  const originalWrite = fs.write;
  const originalClose = fs.closeSync;
  const descriptors = new Set();
  const completions = [];
  let closedDuringPendingWrite = false;
  let writesAfterDeadline = 0;
  let deadlineReached = false;
  let timeout;
  let writer;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(fs, file, ...args);
    if (String(file).includes(`${path.sep}output-spills${path.sep}`)) descriptors.add(fd);
    return fd;
  };
  fs.write = function(fd, buffer, offset, length, position, callback) {
    if (!descriptors.has(fd)) return originalWrite.call(fs, fd, buffer, offset, length, position, callback);
    if (deadlineReached) writesAfterDeadline += 1;
    completions.push(() => callback(null, 1)); // Deliberate late partial completion.
  };
  fs.closeSync = function(fd) {
    if (descriptors.has(fd) && completions.length) closedDuringPendingWrite = true;
    descriptors.delete(fd);
    return originalClose.call(fs, fd);
  };
  syncBuiltinESMExports();
  try {
    writer = createOutputSpillWriter(config, owner);
    let childExited = false;
    const child = spawn(process.execPath, ['-e', "process.stdout.write('complete-child-output');"], {
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
    });
    let started = false;
    child.stdout.on('data', chunk => {
      if (!started) { started = true; writer.start(chunk); }
      else writer.append(chunk);
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => { assert.equal(code, 0); childExited = true; resolve(); });
    });
    assert.equal(childExited, true);
    assert.ok(completions.length > 0, 'the real child must reach the stalled filesystem boundary');
    const finishing = writer.finish({ timeoutMs: 30 });
    const outcome = await Promise.race([
      finishing,
      new Promise(resolve => { timeout = setTimeout(() => resolve('still-pending'), 180); })
    ]);
    if (baseline) {
      assert.equal(outcome, 'still-pending', 'baseline must expose a finished child with unresolved spill finalization');
      console.log('BASELINE REPRODUCED: child exited (code 0), fs.write callback withheld, finish still pending after 180 ms.');
      return;
    }
    assert.notEqual(outcome, 'still-pending', 'spill finalization must respect its independent deadline');
    clearTimeout(timeout);
    deadlineReached = true;
    assert.equal(outcome.finalizationTimedOut, true);
    assert.equal(outcome.spillTruncated, true);
    assert.match(outcome.outputRef, /^spill_/);
    assert.equal(readOutputSpill(config, owner, outcome.outputRef).bytes, 0);
    assert.equal(closedDuringPendingWrite, false, 'an unknown write must not race descriptor close/reuse');
    assert.equal(descriptors.size, 1, 'retain the in-flight descriptor until its callback really arrives');
    assert.equal(await writer.finish(), outcome, 'repeated finish must return one stable terminal result');
    await writer.waitForLowWatermark();
    const lateCompletion = completions.shift();
    lateCompletion();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writesAfterDeadline, 0, 'late partial completion must not start a write on an abandoned descriptor');
    assert.equal(descriptors.size, 0, 'late completion must release the retained descriptor');
    assert.equal(closedDuringPendingWrite, false);
    deadlineReached = false;
    const retained = { executed: true, exitCode: 7, stdout: 't'.repeat(3 * 1024 * 1024) + 'TRANSPORT-END' };
    const retainedTail = retained.stdout;
    const transport = await Promise.race([
      retainOutputStreams(config, owner, retained, { finalizationTimeoutMs: 30 }).then(() => 'settled'),
      new Promise(resolve => { timeout = setTimeout(() => resolve('still-pending'), 180); })
    ]);
    assert.equal(transport, 'settled', 'transport retention must bound a pre-finish low-water wait too');
    assert.equal(retained.stdout, retainedTail, 'storage timeout must preserve the caller output');
    assert.equal(retained.exitCode, 7);
    assert.equal(retained.outputFinalizationTimedOut, true);
    assert.equal(retained.stdoutSpillTruncated, true);
    assert.match(retained.stdoutOutputRef, /^spill_/);
    assert.equal(closedDuringPendingWrite, false);
    deadlineReached = true;
    while (completions.length) completions.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writesAfterDeadline, 0);
    assert.equal(descriptors.size, 0);
    console.log('Bounded process and transport spill finalization preserve references and safely handle late partial callbacks.');
  } finally {
    if (timeout) clearTimeout(timeout);
    fs.openSync = originalOpen;
    fs.write = originalWrite;
    fs.closeSync = originalClose;
    syncBuiltinESMExports();
    while (completions.length) completions.shift()();
    if (writer) await writer.finish();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyStalledSpillFinalization({ baseline: process.argv.includes('--baseline') });
}

export async function verifyRunProcessSpillFinalization(runProcess) {
  const { listMutationProcessRecords, runWithMutationProcessOwnership } = await import('../../src/mutationProcessOwnership.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-finalization-'));
  const config = { stateDir: root };
  const originalOpen = fs.openSync;
  const originalWrite = fs.write;
  const descriptors = new Set();
  const completions = [];
  const phases = [];
  let budgetTimer;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(fs, file, ...args);
    if (String(file).includes(`${path.sep}output-spills${path.sep}`)) descriptors.add(fd);
    return fd;
  };
  fs.write = function(fd, ...args) {
    if (!descriptors.has(fd)) return originalWrite.call(fs, fd, ...args);
    completions.push(() => args.at(-1)(null, 1));
  };
  syncBuiltinESMExports();
  try {
    const result = await Promise.race([
      runWithMutationProcessOwnership(config, 'completed-child', () => runProcess(
        process.execPath,
        ['-e', "process.stdout.write('o'.repeat(20000) + '\\nSTDOUT-END\\n'); process.exitCode = 7;"],
        {
          cwd: root, outputSpillTaskId: 'owner', maxOutputBytes: 1000,
          resourceClass: 'heavy', resourceOwner: 'finalization-fixture',
          timeout: 2000, outputFinalizationTimeoutMs: 30,
          onPhase: event => { phases.push(event); }
        }, config
      )),
      new Promise((_, reject) => {
        budgetTimer = setTimeout(() => reject(new Error('Exited child remained blocked on a stalled spill write.')), 1500);
      })
    ]);
    assert.ok(completions.length > 0);
    assert.equal(result.executed, true);
    assert.equal(result.rootExitConfirmed, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false, 'an output-storage timeout must not rewrite execution timeout status');
    assert.equal(result.outputFinalizationTimedOut, true);
    assert.match(result.outputFinalizationError, /retained output may be incomplete/);
    assert.match(result.stderr, /Output retention timed out/);
    assert.match(result.stdout, /STDOUT-END$/);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stdoutSpillTruncated, true);
    assert.match(result.stdoutOutputRef, /^spill_/);
    assert.deepEqual(listMutationProcessRecords(config, 'completed-child'), [],
      'completed-child ownership may clear only after the physical child exit');
    assert.deepEqual([...new Set(phases.map(event => event.phase))],
      ['host-queued', 'spawned', 'exited', 'draining-output', 'drained']);
    assert.equal(phases[0].executed, false);
    assert.equal(phases.find(event => event.phase === 'spawned').executed, true);
    assert.equal(phases.find(event => event.phase === 'exited').rootExitConfirmed, true);
    assert.equal(phases.at(-1).outputFinalizationTimedOut, true);
    assert.ok(phases.every((event, index) => index === 0 || event.atMs >= phases[index - 1].atMs));
    const recovered = await runProcess(process.execPath, ['-e', 'process.stdout.write("next-command")'], {
      cwd: root, resourceClass: 'heavy', resourceOwner: 'finalization-fixture', queueTimeoutMs: 1000,
      onPhase() { throw new Error('diagnostic listener must not break execution'); }
    }, config);
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.stdout, 'next-command');
    assert.equal(recovered.outputFinalizationTimedOut, undefined);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    fs.openSync = originalOpen;
    fs.write = originalWrite;
    syncBuiltinESMExports();
    while (completions.length) completions.shift()();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  console.log('Exited-child output deadline preserves its result, process phases, and the next host-resource admission.');
}
