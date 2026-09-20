import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { callTool as rawCallTool } from '../src/tools.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-taskless-queue-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const marker = path.join(temp, 'holder-started.txt');
const holderScript = path.join(workspace, 'holder.cjs');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const previousQueueTimeout = process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS;

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
fs.writeFileSync(holderScript, `
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'started');
setTimeout(() => process.exit(0), 1200);
`);
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspace });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS = '250';

const callTool = (name, args, requestId) => rawCallTool(name, args, {
  principal: 'local:trusted',
  publicHttpOnly: true,
  requestId
});

try {
  const holder = callTool('relai_exec', {
    workspace: 'app',
    executable: process.execPath,
    argv: [holderScript, marker]
  }, 'taskless-holder');

  for (let index = 0; index < 100 && !fs.existsSync(marker); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(marker), true, 'taskless mutation fixture must enter the command before the read starts');

  const snapshot = callTool('relai_snapshot', { workspace: 'app', maxEntries: 20 }, 'taskless-reader');
  const first = await Promise.race([
    snapshot.then(() => 'snapshot'),
    new Promise(resolve => setTimeout(() => resolve('blocked'), 400))
  ]);
  assert.equal(
    first,
    'snapshot',
    'a taskless mutation-scope command must not be promoted to a workspace-wide lock that blocks unrelated reads'
  );

  const queuedStartedAt = Date.now();
  await assert.rejects(
    callTool('relai_exec', {
      workspace: 'app',
      executable: process.execPath,
      argv: ['-e', "require('node:fs').writeFileSync('must-not-run.txt', 'unexpected')"]
    }, 'taskless-queued-writer'),
    error => error?.code === 'WORKSPACE_OPERATION_QUEUE_TIMEOUT'
      && error?.retryable === true
      && Number(error?.queueTimeoutMs) > 0
      && Number(error?.queueTimeoutMs) <= 250
      && Boolean(error?.blockingOperationId)
  );
  const queuedWaitMs = Date.now() - queuedStartedAt;
  assert.ok(queuedWaitMs >= 150 && queuedWaitMs < 800, `foreground mutation queue wait should be bounded near 250ms, observed ${queuedWaitMs}ms`);
  assert.equal(fs.existsSync(path.join(workspace, 'must-not-run.txt')), false, 'a timed-out queued mutation must never execute later');

  const [snapshotResult, holderResult] = await Promise.all([snapshot, holder]);
  assert.equal(snapshotResult.ok, true);
  assert.equal(holderResult.commandSucceeded, true);
} finally {
  await repositoryIntelligence.shutdown();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  if (previousQueueTimeout == null) delete process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS;
  else process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS = previousQueueTimeout;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('Taskless mutation-scope commands keep mutation serialization without blocking unrelated workspace reads.');
