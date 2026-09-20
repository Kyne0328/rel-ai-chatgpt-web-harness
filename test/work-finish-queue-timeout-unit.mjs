import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { callTool as rawCallTool } from '../src/tools.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-finish-queue-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
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

let requestCounter = 0;
const callTool = (name, args) => rawCallTool(name, args, {
  principal: 'local:trusted',
  publicHttpOnly: true,
  requestId: `finish-queue-${++requestCounter}`
});

try {
  const blocker = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' });
  const finisher = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' });

  const activeMutation = callTool('relai_exec', {
    workspace: 'app',
    work_id: blocker.work_id,
    executable: process.execPath,
    argv: ['-e', 'setTimeout(() => process.exit(0), 4000)']
  });
  await new Promise(resolve => setTimeout(resolve, 150));

  const startedAt = Date.now();
  await assert.rejects(
    callTool('relai_work', {
      action: 'finish',
      workspace: 'app',
      work_id: finisher.work_id,
      summary: 'Completion should retry instead of waiting behind unrelated long mutation work.'
    }),
    error => error?.code === 'WORKSPACE_OPERATION_QUEUE_TIMEOUT' && error?.retryable === true
  );
  const waitMs = Date.now() - startedAt;
  assert.ok(waitMs >= 1500 && waitMs < 3500, `work.finish queue deadline should be bounded near 2s, observed ${waitMs}ms`);

  const activeResult = await activeMutation;
  assert.equal(activeResult.commandSucceeded, true);

  const completed = await callTool('relai_work', {
    action: 'finish',
    workspace: 'app',
    work_id: finisher.work_id,
    summary: 'Completion succeeds once the unrelated mutation barrier is free.'
  });
  assert.equal(completed.completionKnown, true);

  await callTool('relai_work', {
    action: 'cancel',
    workspace: 'app',
    work_id: blocker.work_id,
    reason: 'Queue deadline regression coverage complete.'
  });
} finally {
  repositoryIntelligence.shutdown();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('work.finish fails retryably instead of stalling behind an unrelated long mutation.');
