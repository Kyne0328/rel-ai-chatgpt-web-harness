import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createTestOutputTail } from './helpers/test-output-tail.mjs';

const tail = createTestOutputTail(1024);
assert.throws(() => createTestOutputTail(0), /positive/);
for (let index = 0; index < 4096; index++) tail.append(Buffer.alloc(512, 65 + index % 26));
let result = tail.snapshot();
assert.equal(result.retainedBytes, 1024);
assert.equal(result.totalBytes, 2097152);
assert.equal(result.truncated, true);
assert.equal(Buffer.byteLength(result.text), 1024);
tail.append('last marker');
result = tail.snapshot();
assert.equal(result.text.endsWith('last marker'), true);
assert.equal(result.retainedBytes, 1024);
const original = Buffer.alloc(2048, 120);
const single = createTestOutputTail(128);
single.append(original);
original.fill(0);
assert.equal(single.snapshot().text, 'x'.repeat(128), 'retained tail must own its bytes');
const small = createTestOutputTail(128);
small.append('small');
assert.deepEqual(small.snapshot(), { text: 'small', totalBytes: 5, retainedBytes: 5, truncated: false });
console.log('Test output retention stays byte-bounded while preserving the final failure detail.');

const { runTestProcess } = await import('./helpers/run-test-process.mjs');
const { terminateProcessTree } = await import('../src/process.ts');
const verbose = await runTestProcess(process.execPath, ['-e', 'process.stdout.write("a".repeat(2*1024*1024))'],
  { timeoutMs: 5000, maxOutputBytes: 1024 });
assert.equal(verbose.exitCode, 0);
assert.equal(verbose.stdoutBytes, 2 * 1024 * 1024);
assert.equal(Buffer.byteLength(verbose.stdout), 1024);
assert.equal(verbose.stdoutTruncated, true);
const timeout = await runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 100)'],
  { timeoutMs: 100, maxOutputBytes: 1024 });
assert.equal(timeout.timedOut, true);
assert.equal(timeout.exitCode, 1);
assert.equal(timeout.terminationUncertain, false);
let fixtureJob;
const uncertain = await runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
  timeoutMs: 1000,
  terminate: async (child, options) => {
    fixtureJob = options.ownerJob;
    const actual = fixtureJob ? await fixtureJob.stop('timeout', 3000) : await terminateProcessTree(child, options);
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
    assert.equal(actual.exited, true, 'the synthetic uncertainty fixture must actually clean up its owned child');
    return { ...actual, exited: false };
  }
});
assert.equal(uncertain.terminationUncertain, true);
assert.match(uncertain.error.message, /Stop launching more tests/);
if (fixtureJob) {
  assert.equal(fixtureJob.outcome().exited, true, 'The uncertainty injection must leave no actual owned child alive.');
  assert.equal(fixtureJob.cleanup(), true);
  fs.rmdirSync(path.dirname(fixtureJob.directory));
}
if (process.platform === 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-test-detached-'));
  const marker = path.join(root, 'completed.txt');
  const childCode = 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "owned-complete"), 700);';
  const parentCode = 'const child = require("node:child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(childCode) + ', ' + JSON.stringify(marker) + '], {detached:true,stdio:"ignore"}); child.unref();';
  try {
    const detached = await runTestProcess(process.execPath, ['-e', parentCode], { timeoutMs: 10000 });
    assert.equal(detached.exitCode, 0, detached.error?.message);
    assert.equal(detached.terminationUncertain, false);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'owned-complete', 'A finite test job must not finish before its detached descendant.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
console.log('Test runner bounds native output and preserves timeout/tree-cleanup uncertainty.');
