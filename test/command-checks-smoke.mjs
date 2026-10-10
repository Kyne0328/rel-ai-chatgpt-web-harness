import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiVerify } from "../src/localRepoBridge.js";
import { outputSpillOwner, readOutputSpill } from '../src/outputSpill.js';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

const { mapCheckArgs } = (() => {
  // mapCheckArgs is not exported from localRepoBridge; replicate it here as the internal bridge does
  return {
    mapCheckArgs(args = {}) {
      return {
        ...args,
        command: args.command || args.check,
        commands: args.commands || args.checks,
        commandsText: args.commandsText || args.checksText
      };
    }
  };
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-checks-smoke-'));
const workspace = { path: tmp, alias: 'test', commands: { lint: 'echo lint ok' }, testCommands: {} };
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-checks-state-'));
const config = { stateDir };

try {
fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
  scripts: {
    check: 'node -e "console.log(\'check should not run for release\')"',
    test: 'npm run test:all',
    'test:all': 'npm run check && node -e "console.log(\'release all\')"'
  }
}, null, 2));

// 0a. Standard validation must not run check twice when npm test already
// delegates to a script that includes it.
{
  const result = await relaiVerify(workspace, config, { level: 'standard' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.checks, ['npm run test:all']);
  assert.ok(result.results[0].stdout.includes('release all'));
}

// 0b. Release level prefers test:all over piecemeal check/test scripts.
{
  const result = await relaiVerify(workspace, config, { level: 'release' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, ['npm run test:all']);
  assert.ok(result.results[0].stdout.includes('release all'));
}

// 0c. Independent check and test scripts both run when neither covers the other.
{
  const independent = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-checks-independent-'));
  fs.writeFileSync(path.join(independent, 'package.json'), JSON.stringify({
    scripts: {
      check: 'node -e "console.log(\'independent check\')"',
      test: 'node -e "console.log(\'independent test\')"'
    }
  }, null, 2));
  const result = await relaiVerify({ path: independent, alias: 'independent' }, config, { level: 'standard' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, ['npm run check', 'npm test']);
  fs.rmSync(independent, { recursive: true, force: true });
}

// 0d. Build-only package scripts are real validation, not "no checks detected".
{
  const buildOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-checks-build-only-'));
  fs.writeFileSync(path.join(buildOnly, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node -e "console.log(\'build ok\')"'
    }
  }, null, 2));
  const result = await relaiVerify({ path: buildOnly, alias: 'build-only' }, config, {});
  assert.equal(result.ok, true, 'build-only package should validate successfully');
  assert.deepEqual(result.checks, ['npm run build']);
  assert.ok(result.results[0].stdout.includes('build ok'), 'build script stdout should be present');
  fs.rmSync(buildOnly, { recursive: true, force: true });
}

// 0e. No detected checks must be explicit non-validation.
{
  const noChecks = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-checks-none-'));
  const result = await relaiVerify({ path: noChecks, alias: 'no-checks' }, config, {});
  assert.equal(result.ok, false, 'no-check result must not look like a passed validation');
  assert.equal(result.validationStatus, 'not_run');
  assert.equal(result.validated, false);
  assert.ok(result.message.includes('NOT RUN'));
  fs.rmSync(noChecks, { recursive: true, force: true });
}

// 1. Configured check by key — call relaiVerify with explicit check key mapped from commands
{
  const args = mapCheckArgs({ check: workspace.commands.lint });
  const result = await relaiVerify(workspace, config, args);
  assert.equal(result.ok, true, 'configured check by key should succeed');
  assert.ok(result.checks.includes('echo lint ok'), 'checks should include the configured command');
  assert.ok(result.results[0].stdout.includes('lint ok'), 'stdout should contain lint ok');
}

// 2. Ad-hoc check via check field
{
  const result = await relaiVerify(workspace, config, mapCheckArgs({ check: 'echo hello' }));
  assert.equal(result.ok, true, 'ad-hoc check should succeed');
  assert.ok(result.results[0].stdout.includes('hello'), 'stdout should contain hello');
}

// 3. checksText multi-line
{
  const result = await relaiVerify(workspace, config, mapCheckArgs({ checksText: 'echo line1\necho line2' }));
  assert.equal(result.ok, true, 'checksText multi-line should succeed');
  assert.equal(result.results.length, 2, 'should run 2 checks from checksText');
  assert.ok(result.results[0].stdout.includes('line1'), 'first check stdout should include line1');
  assert.ok(result.results[1].stdout.includes('line2'), 'second check stdout should include line2');
}

// 4. checks array
{
  const result = await relaiVerify(workspace, config, mapCheckArgs({ checks: ['echo a', 'echo b'] }));
  assert.equal(result.ok, true, 'checks array should succeed');
  assert.equal(result.results.length, 2, 'should run 2 checks from array');
  assert.ok(result.results[0].stdout.includes('a'), 'first array check stdout should contain a');
  assert.ok(result.results[1].stdout.includes('b'), 'second array check stdout should contain b');
}

// 5. Failing check returns structured failure with ok: false
{
  const result = await relaiVerify(workspace, config, mapCheckArgs({ check: 'node -e "process.exit(1)"' }));
  assert.equal(result.ok, false, 'failing check should return ok: false');
  assert.equal(result.results[0].ok, false, 'result entry should have ok: false');
  assert.notEqual(result.results[0].exitCode, 0, 'exitCode should be non-zero');
}

// 6. Timeout returns structured timeout result (very short timeout)
{
  // Use a sleep-like command: node -e with a long-running loop
  const sleepCmd = 'node -e "setTimeout(()=>{},30000)"';
  const result = await relaiVerify(workspace, config, mapCheckArgs({ check: sleepCmd, timeoutMs: 50 }));
  assert.equal(result.ok, false, 'timeout should return ok: false');
  assert.ok(
    result.results[0].error || result.results[0].exitCode === -1,
    'timeout result should have error field or exitCode -1'
  );
}

// 7. Large output is truncated safely
{
  const largeCmd = 'node -e "process.stdout.write(\'x\'.repeat(5000000))"';
  const result = await relaiVerify(workspace, config, mapCheckArgs({ check: largeCmd, timeoutMs: 30000 }));
  // Should not throw; result should be an object with results array
  assert.ok(result && Array.isArray(result.results), 'large output result should have results array');
  const resultEntry = result.results[0];
  const stdout = resultEntry.stdout || '';
  const totalBytes = Buffer.byteLength(stdout, 'utf8');
  // Output should be capped — well below 5 MB
  assert.ok(totalBytes < 2 * 1024 * 1024, `output should be truncated, got ${totalBytes} bytes`);

  assert.equal(resultEntry.stdoutSpillTruncated, false,
    `the actual producer must retain the complete oversized stream: ${JSON.stringify({
      stdoutBytes: resultEntry.stdoutBytes,
      stdoutOutputRef: resultEntry.stdoutOutputRef,
      outputFinalizationTimedOut: resultEntry.outputFinalizationTimedOut,
      outputFinalizationError: resultEntry.outputFinalizationError,
      exitCode: resultEntry.exitCode
    })}`);
  assert.ok(resultEntry.stdoutOutputRef, 'validation must return a real output recovery reference');
  const owner = outputSpillOwner({ workspace: workspace.alias });
  const retained = readOutputSpill(config, owner, resultEntry.stdoutOutputRef);
  assert.equal(retained.bytes, 5000000, 'the spill retains bytes omitted from the bounded response tail');
  const fd = fs.openSync(retained.file, 'r');
  try {
    const tail = Buffer.alloc(32);
    fs.readSync(fd, tail, 0, tail.length, retained.bytes - tail.length);
    assert.equal(tail.toString('utf8'), 'x'.repeat(32));
  } finally { fs.closeSync(fd); }
  const publicResult = serializeConnectorResult({
    publicName: 'relai_validate', action: 'checks', operationName: OP.VALIDATE_CHECKS,
    value: result, args: { workspace: workspace.alias }
  });
  assert.equal(publicResult.results[0].stdout, undefined, 'successful output remains compact by default');
  assert.equal(publicResult.results[0].stdoutOutputRef, resultEntry.stdoutOutputRef, 'a real spill handle survives public serialization');
  assert.equal(publicResult.results[0].stdoutSpillTruncated, false);

}

// 8. Old command alias still maps internally (passes command: "echo aliased" and gets ok result)
{
  // mapCheckArgs maps command -> command (already is command), so we pass through as-is
  const args = mapCheckArgs({ command: 'echo aliased' });
  assert.equal(args.command, 'echo aliased', 'mapCheckArgs should keep command alias');
  const result = await relaiVerify(workspace, config, args);
  assert.equal(result.ok, true, 'command alias should work and produce ok result');
  assert.ok(result.results[0].stdout.includes('aliased'), 'stdout should include aliased');
}

// 9. run_checks bounds each command to a TAIL so the failing end survives the
//    server-level result cap; fullOutput keeps a larger tail.
{
  const cmd = 'node -e "process.stdout.write(\'a\'.repeat(50000)+\'END_MARKER_Z\')"';
  const result = await relaiVerify(workspace, config, mapCheckArgs({ check: cmd, timeoutMs: 30000 }));
  const stdout = result.results[0].stdout || '';
  assert.ok(stdout.length <= 4000 + 120, `default tail should bound stdout near 4000, got ${stdout.length}`);
  assert.ok(stdout.includes('END_MARKER_Z'), 'tail must keep the END of output where failures/summaries live');
  assert.ok(/kept last 4000 of \d+ chars/.test(stdout), 'tail marker should note how much was dropped');

  const full = await relaiVerify(workspace, config, mapCheckArgs({ check: cmd, fullOutput: true, timeoutMs: 30000 }));
  const fullStdout = full.results[0].stdout || '';
  assert.ok(fullStdout.length > 4000, 'fullOutput should keep a larger tail');
  assert.ok(fullStdout.includes('END_MARKER_Z'), 'fullOutput tail must keep the END of output');

  const publicFull = serializeConnectorResult({
    publicName: 'relai_validate', action: 'checks', operationName: OP.VALIDATE_CHECKS,
    value: full, args: { workspace: workspace.alias, fullOutput: true }
  });
  assert.equal(publicFull.results[0].stdout, fullStdout, 'explicit fullOutput retains the producer-bounded success tail');
  assert.ok(publicFull.results[0].stdout.includes('END_MARKER_Z'));

}

console.log('Check-command smoke tests passed.');
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
