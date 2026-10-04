import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { relaiExec } from '../src/bridge/exec.js';
import { invokeRelaiTool } from '../src/mcp/toolInvocation.js';
import { readConfig } from '../src/config.js';
import { readOutputSpill } from '../src/outputSpill.js';

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
  const previousConfig = process.env.REL_AI_MCP_CONFIG;
  const originalWrite = fs.write;
  const originalReadDir = fs.readdirSync;
  try {
    for (const operation of ['mkdir', 'open', 'write', 'unavailable-quota-scan']) {
      const stateDir = path.join(root, `transport-${operation}`, 'state');
      const configFile = path.join(root, `transport-${operation}.json`);
      fs.writeFileSync(configFile, JSON.stringify({ version: 3, stateDir, workspaces: { fixture: { path: root } } }));
      process.env.REL_AI_MCP_CONFIG = configFile;
      const spillRoot = path.join(stateDir, 'output-spills');
      const spillDescriptors = new Set();
      let injected = 0;
      const fail = () => {
        injected += 1;
        return Object.assign(new Error(`Injected transport spill ${operation} failure`), { code: 'ENOSPC' });
      };
      fs.mkdirSync = function(target, ...options) {
        if (operation === 'mkdir' && String(target).startsWith(`${spillRoot}${path.sep}`)) throw fail();
        return originalMkdir.call(fs, target, ...options);
      };
      fs.openSync = function(target, ...options) {
        const spill = String(target).startsWith(`${spillRoot}${path.sep}`) && String(target).endsWith('.log');
        if (operation === 'open' && spill) throw fail();
        const descriptor = originalOpen.call(fs, target, ...options);
        if (spill) spillDescriptors.add(descriptor);
        return descriptor;
      };
      fs.readdirSync = function(target, ...options) {
        if (operation === 'unavailable-quota-scan' && String(target) === spillRoot) throw fail();
        return originalReadDir.call(fs, target, ...options);
      };
      if (operation === 'unavailable-quota-scan') originalMkdir.call(fs, spillRoot, { recursive: true });
      fs.write = function(descriptor, ...options) {
        if (operation === 'write' && spillDescriptors.has(descriptor)) {
          queueMicrotask(() => options.at(-1)(fail(), 0));
          return;
        }
        return originalWrite.call(fs, descriptor, ...options);
      };
      syncBuiltinESMExports();
      let response;
      try {
        response = await invokeRelaiTool({
          config: readConfig(), name: 'relai_exec',
          args: { workspace: 'fixture', independent: true, executable: process.execPath,
            argv: ['-e', "process.stdout.write('s'.repeat(600 * 1024) + 'END'); process.exitCode = 7;"],
            maxOutputBytes: 2 * 1024 * 1024, timeoutMs: 10000 },
          context: { principal: 'local:trusted', publicHttpOnly: true }
        });
      } finally {
        fs.mkdirSync = originalMkdir; fs.openSync = originalOpen; fs.write = originalWrite; fs.readdirSync = originalReadDir;
        syncBuiltinESMExports();
      }
      assert.ok(injected > 0, `${operation} must exercise the transport retention boundary`);
      const result = response.structuredContent;
      assert.equal(result.executed, true);
      assert.equal(result.exitCode, 7);
      assert.equal(result.commandSucceeded, false);
      assert.equal(result.stdoutSpillTruncated, true);
      assert.equal(result.stdoutBytes, 600 * 1024 + 3);
      assert.match(result.stdout, /END$/);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512 * 1024);
    }
    const { retainOutputStreams } = await import('../src/outputSpill.js');
    const retainConfig = { stateDir: path.join(root, 'upstream-tail-state') };
    const partial = { executed: true, commandSucceeded: false, stdout: 'only an upstream tail', stdoutTruncated: true };
    await retainOutputStreams(retainConfig, 'fixture-owner', partial);
    assert.equal(partial.stdoutSpillTruncated, true, 'a retained upstream tail must never claim a complete original stream');
    const stored = readOutputSpill(retainConfig, 'fixture-owner', partial.stdoutOutputRef);
    assert.equal(fs.readFileSync(stored.file, 'utf8'), partial.stdout);
    const existingRef = partial.stdoutOutputRef;
    await retainOutputStreams(retainConfig, 'fixture-owner', partial);
    assert.equal(partial.stdoutOutputRef, existingRef, 'existing references must not be duplicated');
    const missingOwner = { executed: true, commandSucceeded: false, stdout: 'not authorized for retention' };
    await retainOutputStreams(retainConfig, '', missingOwner);
    assert.equal(missingOwner.stdoutOutputRef, undefined);
    assert.equal(missingOwner.commandSucceeded, false);
    assert.equal(missingOwner.stdoutSpillTruncated, undefined, 'unknown retention must not become a false full-retention claim');
  } finally {
    fs.mkdirSync = originalMkdir; fs.openSync = originalOpen; fs.write = originalWrite; fs.readdirSync = originalReadDir;
    syncBuiltinESMExports();
    if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
    else process.env.REL_AI_MCP_CONFIG = previousConfig;
  }
} finally {
  fs.mkdirSync = originalMkdir;
  fs.openSync = originalOpen;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('Command results survive output-storage failures and recover on the next execution.');
