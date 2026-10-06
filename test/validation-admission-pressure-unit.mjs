import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';
import { installForcedLowHostMemory } from './helpers/forced-low-host-memory.mjs';
const previousQueueTimeout = process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS;
process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS = '100';
const restoreMemory = installForcedLowHostMemory();
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

const blockers = [];
try {
  assert.equal(hostResourceDiagnosticSnapshot().pressure.admissionEnforced, false);
  const readOnly = await relaiVerify(workspace, config, { checks: ['git diff --check'], complete: false });
  assert.equal(readOnly.ok, true, JSON.stringify(readOnly));
  assert.equal(readOnly.results[0].executed, true);
  assert.equal(readOnly.executedUnits, 1);
  assert.equal(readOnly.completedUnits, 1);
  assert.equal(readOnly.validated, true);

  const allowed = await relaiVerify(workspace, config, { checks: ['npm run check'], complete: false });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.results[0].executed, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'started', 'package commands execute under very low reported RAM');
  fs.rmSync(marker);
  for (let i = 0; i < hostResourceDiagnosticSnapshot().lanes.heavy.limit; i++) blockers.push(await acquireHostResource('heavy', 'occupied-slot'));
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
  assert.equal(blocked.resourcePressure, undefined);
  assert.match(blocked.resourceReason, /capacity/i);
  assert.equal(blocked.cancelled, false, 'capacity expiry is not a caller cancellation');
  assert.match(blocked.nextAction, /did not start|retry/i);
  assert.doesNotMatch(blocked.nextAction, /correct the checks or code/i);
  assert.equal(fs.existsSync(marker), false, 'commands wait only when all execution slots are occupied');
  const compact = compactCommandResult(blocked.results[0]);
  assert.equal(compact.admissionBlocked, true);
  assert.equal(compact.queueTimedOut, true);
  assert.equal(compact.errorCode, 'HOST_RESOURCE_QUEUE_TIMEOUT');
  assert.equal(compact.blockedResource, 'heavy');
  assert.equal(compact.resourcePressure, undefined);
  const publicResult = serializeConnectorResult({ publicName: 'relai_validate', action: 'checks',
    operationName: OP.VALIDATE_CHECKS, value: blocked, args: { workspace: workspace.alias } });
  assert.equal(publicResult.admissionBlocked, true);
  assert.equal(publicResult.executedUnits, 0);
  assert.equal(publicResult.results[0].queueTimedOut, true);
  const schema = outputSchemaFor(OP.VALIDATE_CHECKS);
  for (const field of ['admissionBlocked', 'queueTimedOut', 'errorCode', 'blockedResource', 'resourceReason', 'resourcePressure']) {
    assert.ok(schema.properties[field], 'validation output schema retains ' + field);
  }
  console.log('Very low reported memory permits validation; actual occupied slots still produce explicit queue timeout provenance.');
} finally {
  for (const blocker of blockers) blocker.release();
  await flushAuditWrites();
  restoreMemory();
  if (previousQueueTimeout === undefined) delete process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS;
  else process.env.REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS = previousQueueTimeout;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
