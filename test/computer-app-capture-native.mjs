// Explicit acceptance fixture. Never included in ordinary unit runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const compileOnly = process.argv.includes('--compile-only');
if (process.platform !== 'win32') throw new Error('This native fixture requires Windows.');
if (!compileOnly && process.env.RELAI_NATIVE_APP_CAPTURE_FIXTURE !== '1') {
  throw new Error('Native acceptance requires explicit RELAI_NATIVE_APP_CAPTURE_FIXTURE=1. It briefly displays two owned synthetic windows.');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(process.env.REL_AI_EPHEMERAL_DIR || os.tmpdir(), 'relai-native-app-capture-'));
const output = path.join(scratch, 'receipt.json');
const begin = Date.now();
const args = ['-NoProfile', '-NonInteractive', '-Sta', '-File', path.join(root, 'test/fixtures/app-capture-probe.ps1'), '-OutputPath', output];
if (compileOnly) args.push('-CompileOnly');
const result = spawnSync('powershell.exe', args, { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
const receipt = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '')) : null;
const evidence = { mode: compileOnly ? 'compile-only' : 'native-synthetic', exitCode: result.status, signal: result.signal, durationMs: Date.now() - begin, error: result.error?.message, stdout: result.stdout, stderr: result.stderr, receipt, evidencePath: output };
fs.writeFileSync(path.join(scratch, 'runner.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
assert.equal(result.status, 0, 'Native app-capture fixture failed; inspect receipt.');
assert.equal(receipt?.compiled, true);
if (!compileOnly) {
  assert.equal(receipt?.nativePixels, true);
  assert.equal(receipt.cases.length, 7);
  assert.equal(receipt.cases.find(item => item.name === 'known-unavailable-owner-rendered-fallback').method, 'win32-print-window');
  assert.deepEqual(receipt.inputGuards, { visiblePointer: true, occludedPointerBlocked: true, occludedFocusBlocked: true, staleGeometryBlocked: true, staleIdentityBlocked: true }, 'native predicates must reject occlusion, focus, stale geometry, and stale identity without sending input');
  assert.equal(receipt.ocr?.passed, true, 'OCR must read only the target or fail closed when the native OCR engine is unavailable');
  assert.ok(receipt.cases.every(item => item.passed === true));
  assert.equal(receipt.cleanup.length, 2);
  assert.ok(receipt.cleanup.every(item => item.destroyed === true), 'Only owned fixture windows must be destroyed.');
  const { runOwnedDispatchAcceptance } = await import('./fixtures/app-capture-dispatch-probe.mjs');
  const dispatchReceipt = await runOwnedDispatchAcceptance(root, scratch);
  console.log(JSON.stringify({ mode: 'actual-manager-native-dispatch', receipt: dispatchReceipt }));
}
