import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { relaiExec } from '../src/bridge/exec.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-spill-failure-'));
const originalMkdir = fs.mkdirSync;
const originalOpen = fs.openSync;
const script = "process.stdout.write('o'.repeat(20000) + '\\nSTDOUT-END\\n'); process.stderr.write('e'.repeat(20000) + '\\nSTDERR-END\\n'); process.exitCode = 7;";
const workspace = { alias: 'spill-failure', path: root };
const context = { principal: 'spill-regression', mutationTrackingRequired: false };
const args = { executable: process.execPath, argv: ['-e', script], maxOutputBytes: 1000, timeoutMs: 10000 };
try {
  for (const operation of ['mkdir', 'open']) {
    const config = { stateDir: path.join(root, operation, 'state') };
    const spillRoot = path.join(config.stateDir, 'output-spills');
    let injected = 0;
    const fail = () => {
      injected += 1;
      throw Object.assign(new Error(`Injected spill ${operation} failure`), { code: operation === 'mkdir' ? 'EACCES' : 'ENOSPC' });
    };
    fs.mkdirSync = function(target, ...options) {
      if (operation === 'mkdir' && String(target).startsWith(`${spillRoot}${path.sep}`)) fail();
      return originalMkdir.call(fs, target, ...options);
    };
    fs.openSync = function(target, ...options) {
      if (operation === 'open' && String(target).startsWith(`${spillRoot}${path.sep}`) && String(target).endsWith('.log')) fail();
      return originalOpen.call(fs, target, ...options);
    };
    syncBuiltinESMExports();
    let result;
    try {
      result = await relaiExec(workspace, config, args, context);
    } finally {
      fs.mkdirSync = originalMkdir;
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
    assert.ok(injected >= 2, `${operation} must fail for both output streams`);
    assert.equal(result.executed, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.commandSucceeded, false);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.equal(result.stdoutSpillTruncated, true);
    assert.equal(result.stderrSpillTruncated, true);
    assert.equal(result.stdoutOutputRef, undefined);
    assert.equal(result.stderrOutputRef, undefined);
    assert.match(result.stdout, /STDOUT-END$/);
    assert.match(result.stderr, /STDERR-END$/);
    assert.ok(Buffer.byteLength(result.stdout) <= 1000);
    assert.ok(Buffer.byteLength(result.stderr) <= 1000);
    const recovered = await relaiExec(workspace, config, args, context);
    assert.equal(recovered.exitCode, 7);
    assert.match(recovered.stdoutOutputRef, /^spill_/);
    assert.match(recovered.stderrOutputRef, /^spill_/);
    assert.equal(recovered.stdoutSpillTruncated, false);
    assert.equal(recovered.stderrSpillTruncated, false);
  }
} finally {
  fs.mkdirSync = originalMkdir;
  fs.openSync = originalOpen;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Command results survive output-storage failures and recover on the next execution.');
