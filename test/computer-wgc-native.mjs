// Explicit owned-window acceptance fixture; never part of ordinary unit runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const compileOnly = process.argv.includes('--compile-only');
if (process.platform !== 'win32') throw new Error('WGC native acceptance requires Windows.');
if (!compileOnly && process.env.RELAI_NATIVE_WGC_FIXTURE !== '1') {
  throw new Error('Set RELAI_NATIVE_WGC_FIXTURE=1 to authorize the two owned synthetic fixture windows.');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(process.env.REL_AI_EPHEMERAL_DIR || os.tmpdir(), 'relai-wgc-fixture-'));
const output = path.join(scratch, 'receipt.json');
const args = ['-NoProfile', '-NonInteractive', '-Sta', '-File', path.join(root, 'test/fixtures/wgc-capture-probe.ps1'), '-OutputPath', output];
if (compileOnly) args.push('-CompileOnly');
const begin = Date.now();
const result = spawnSync('powershell.exe', args, { cwd: root, encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024 });
const receipt = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '')) : null;
const evidence = { mode: compileOnly ? 'compile-only' : 'owned-window-native', exitCode: result.status, signal: result.signal, durationMs: Date.now() - begin, error: result.error?.message, stdout: result.stdout, stderr: result.stderr, receipt, evidencePath: output };
fs.writeFileSync(path.join(scratch, 'runner.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
assert.equal(result.status, 0, 'WGC fixture failed; inspect bounded receipt.');
assert.equal(receipt?.compiled, true);
if (!compileOnly) {
  assert.equal(receipt.nativePixels, true);
  assert.equal(receipt.wmPrintNoOp, true);
  assert.equal(receipt.cases.length, 9);
  assert.ok(receipt.cases.every(item => item.passed === true));
  assert.equal(receipt.cleanup.length, 2);
  assert.ok(receipt.cleanup.every(item => item.destroyed === true));
}
