import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-taskless-restart-'));
const configFile = path.join(root, 'config.json');
const config = { stateDir: path.join(root, 'state'), workspaces: { app: { path: root } }, telemetry: { enabled: false, diagnosticsEnabled: false } };
fs.writeFileSync(configFile, JSON.stringify(config));
const sourceRoot = path.resolve(import.meta.dirname, '..');
const moduleUrl = value => pathToFileURL(path.join(sourceRoot, value)).href;
const counter = path.join(root, 'counter.txt');
const source = `
import fs from 'node:fs';
const { startFallbackExecution } = await import(${JSON.stringify(moduleUrl('src/mcp/fallbackExecutions.js'))});
const { toolResult } = await import(${JSON.stringify(moduleUrl('src/mcp/results.js'))});
const config = ${JSON.stringify(config)};
const counter = ${JSON.stringify(counter)};
const operation = startFallbackExecution({ config, scopeId: 'workspace:fixture-principal:app:stable-signature',
  noticeScope: 'fixture-principal', workspace: 'app', tool: 'relai_read', signature: 'stable-signature',
  run: async () => {
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
    fs.writeFileSync(counter, String(count + 1));
    return toolResult({ ok: true, marker: 'unchanged terminal body' }, false);
  }
});
if (operation.record.promise) await operation.record.promise;
console.log(JSON.stringify({ operationId: operation.record.operationId, reused: operation.reused,
  status: operation.record.status, deliveryAcknowledged: operation.record.deliveryAcknowledged }));
`;
const env = { ...process.env, REL_AI_MCP_CONFIG: configFile };
delete env.REL_AI_MCP_STATE_DIR;
try {
  const receipts = [];
  for (let processNumber = 0; processNumber < 2; processNumber++) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr);
    receipts.push(JSON.parse(child.stdout.trim()));
  }
  const calls = Number(fs.readFileSync(counter, 'utf8'));
  console.log(JSON.stringify({ runtime: process.version, platform: process.platform, freshProcesses: 2, calls, expectedCalls: 1, receipts }));
  assert.equal(calls, 1, 'an undelivered taskless terminal result must retain replay identity across a process restart');
  assert.equal(receipts[1].reused, true);
  assert.equal(receipts[1].operationId, receipts[0].operationId);

  // Expiry is deliberate and scoped. Old retained records must not replay forever.
  const expiredAt = new Date(Date.now() - 16 * 60_000).toISOString();
  for (const directory of ['fallback-scopes', 'fallback-executions']) {
    for (const name of fs.readdirSync(path.join(config.stateDir, directory))) {
      const file = path.join(config.stateDir, directory, name);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.completedAt = expiredAt; record.updatedAt = expiredAt;
      fs.writeFileSync(file, JSON.stringify(record));
    }
  }
  const expired = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(expired.status, 0, expired.stderr);
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 2, 'documented TTL permits deliberate new execution');

  // A crash after a harmless side effect but before result settlement must not
  // turn restart recovery into a second execution.
  const interruptedCounter = path.join(root, 'interrupted-counter.txt');
  const normalInterrupted = source.replace(JSON.stringify(counter), JSON.stringify(interruptedCounter))
    .replaceAll('stable-signature', 'interrupted-signature');
  const crashing = normalInterrupted.replace("return toolResult({ ok: true, marker: 'unchanged terminal body' }, false);",
    "console.log(JSON.stringify({ operationId: operation.record.operationId, status: 'running' })); process.exit(0);");
  const crash = spawnSync(process.execPath, ['--input-type=module', '-'], { input: crashing, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(crash.status, 0, crash.stderr);
  const recovery = spawnSync(process.execPath, ['--input-type=module', '-'], { input: normalInterrupted, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(recovery.status, 0, recovery.stderr);
  const interrupted = JSON.parse(recovery.stdout.trim());
  assert.equal(interrupted.reused, true);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(Number(fs.readFileSync(interruptedCounter, 'utf8')), 1);
  console.log(JSON.stringify({ expiryRespected: true, interruptedReplayProtected: true }));

} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
