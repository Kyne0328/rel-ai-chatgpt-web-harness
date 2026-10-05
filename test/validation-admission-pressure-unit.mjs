import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';

// Bound the test wait, not the production pressure policy.
const previousQueueTimeout = process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS;
process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS = '100';
const restoreMemory = installDeterministicHostMemory();
const readFile = fsPromises.readFile;
const execFile = childProcess.execFile;
const gib = 1024 ** 3;
os.freemem = () => 0;
fsPromises.readFile = function (file, ...args) {
  if (String(file) === '/proc/meminfo') return Promise.resolve('MemTotal: 16777216 kB\nMemAvailable: 0 kB\nCommitted_AS: 1048576 kB\nCommitLimit: 16777216 kB\n');
  return readFile.call(this, file, ...args);
};
childProcess.execFile = function (file, args, options, callback) {
  if (Array.isArray(args) && args.some(value => String(value).includes('Win32_PerfFormattedData_PerfOS_Memory'))) {
    queueMicrotask(() => callback(null, JSON.stringify({ AvailableBytes: 0, CommittedBytes: gib, CommitLimit: 16 * gib }), ''));
    return { kill() { return true; } };
  }
  return execFile.call(this, file, args, options, callback);
};
syncBuiltinESMExports();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-pressure-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const marker = path.join(repo, 'must-not-start.txt');
fs.writeFileSync(path.join(repo, 'tracked.txt'), 'content\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
  scripts: { check: 'node -e "require(\'node:fs\').writeFileSync(\'must-not-start.txt\',\'started\')"' }
}));
childProcess.execFileSync(GIT_EXECUTABLE, ['init', '-q'], { cwd: repo });
childProcess.execFileSync(GIT_EXECUTABLE, ['add', '.'], { cwd: repo });
const { acquireHostResource, hostResourceDiagnosticSnapshot } = await import('../src/hostResourceScheduler.js');
const { relaiVerify } = await import('../src/bridge/validation.js');
const { compactCommandResult } = await import('../src/tools/connectorHelpers.js');
const { serializeConnectorResult } = await import('../src/tools/connector.js');
const { outputSchemaFor } = await import('../src/tools/outputSchemas.js');
const { OPERATION_IDS: OP } = await import('../src/tools/operationIds.js');
const { flushAuditWrites } = await import('../src/audit.js');
const config = { stateDir: path.join(root, 'state') };
const workspace = { alias: 'validation-pressure', path: repo, commands: {}, testCommands: {} };

try {
  await assert.rejects(acquireHostResource('heavy', 'pressure-primer', { timeoutMs: 50 }),
    error => error.code === 'HOST_RESOURCE_QUEUE_TIMEOUT');
  assert.equal(hostResourceDiagnosticSnapshot().pressure.state, 'pressured');
  const readOnly = await relaiVerify(workspace, config, { checks: ['git diff --check'], complete: false });
  assert.equal(readOnly.ok, true, JSON.stringify(readOnly));
  assert.equal(readOnly.results[0].executed, true);
  assert.equal(readOnly.executedUnits, 1);
  assert.equal(readOnly.completedUnits, 1);
  assert.equal(readOnly.validated, true);

  const blocked = await relaiVerify(workspace, config, { checks: ['npm run check'], complete: false });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  assert.equal(blocked.admissionBlocked, true);
  assert.equal(blocked.errorCode, 'HOST_RESOURCE_QUEUE_TIMEOUT');
  assert.equal(blocked.queueTimedOut, true);
  assert.equal(blocked.results[0].executed, false);
  assert.equal(blocked.results[0].durationMs, 0);
  assert.equal(blocked.executedUnits, 0);
  assert.equal(blocked.completedUnits, 0);
  assert.equal(blocked.validated, false);
  assert.equal(blocked.blockedResource, 'heavy');
  assert.equal(blocked.resourcePressure.physicalAvailableBytes, 0);
  assert.equal(blocked.resourcePressure.requiredReservationBytes, 768 * 1024 ** 2);
  assert.match(blocked.resourceReason, /memory|physical|headroom/i);
  assert.match(blocked.nextAction, /did not start|retry/i);
  assert.doesNotMatch(blocked.nextAction, /correct the checks or code/i);
  assert.equal(fs.existsSync(marker), false, 'package hooks must remain gated under low physical memory');
  const compact = compactCommandResult(blocked.results[0]);
  assert.equal(compact.admissionBlocked, true);
  assert.equal(compact.queueTimedOut, true);
  assert.equal(compact.errorCode, 'HOST_RESOURCE_QUEUE_TIMEOUT');
  assert.equal(compact.blockedResource, 'heavy');
  assert.equal(compact.resourcePressure.physicalAvailableBytes, 0);
  const publicResult = serializeConnectorResult({ publicName: 'relai_validate', action: 'checks',
    operationName: OP.VALIDATE_CHECKS, value: blocked, args: { workspace: workspace.alias } });
  assert.equal(publicResult.admissionBlocked, true);
  assert.equal(publicResult.executedUnits, 0);
  assert.equal(publicResult.results[0].queueTimedOut, true);
  const schema = outputSchemaFor(OP.VALIDATE_CHECKS);
  for (const field of ['admissionBlocked', 'queueTimedOut', 'errorCode', 'blockedResource', 'resourceReason', 'resourcePressure']) {
    assert.ok(schema.properties[field], 'validation output schema retains ' + field);
  }
  console.log('Forced-low-pressure validation: read-only Git runs; npm stays unspawned with admission provenance.');
} finally {
  await flushAuditWrites();
  restoreMemory();
  if (previousQueueTimeout === undefined) delete process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS;
  else process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS = previousQueueTimeout;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
