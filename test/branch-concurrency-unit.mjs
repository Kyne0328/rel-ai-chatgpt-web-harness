import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { resetToolActivity } from '../src/toolActivity.js';
import { callTool as rawCallTool } from '../src/tools.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-branch-concurrency-'));
const workspacePath = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const startedPath = path.join(root, 'branch-a-started');
const releasePath = path.join(root, 'branch-a-release');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const context = { principal: 'local:trusted', publicHttpOnly: true, transportType: 'test', transportSessionId: 'branch-concurrency' };
const callTool = (name, args) => rawCallTool(name, args, context);

function git(...args) {
  return execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8' }).trim();
}

function waitForFile(file, timeoutMs = 10_000) {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const expected = path.basename(file);
    const poll = setInterval(() => {
      if (!fs.existsSync(file)) return;
      cleanup();
      resolve();
    }, 25);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(poll);
    };
    if (fs.existsSync(file)) {
      cleanup();
      resolve();
    }
  });
}

try {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'base.txt'), 'base\n');
  fs.writeFileSync(path.join(workspacePath, 'branch-gate.mjs'), `
  import fs from 'node:fs';
  const started = ${JSON.stringify(startedPath)};
  const release = ${JSON.stringify(releasePath)};
  fs.writeFileSync(started, 'started\\n');
  const finish = () => {
    if (!fs.existsSync(release)) return false;
    clearTimeout(timeout);
    clearInterval(poll);
    process.exit(0);
  };
  const poll = setInterval(finish, 50);
  const timeout = setTimeout(() => {
    clearInterval(poll);
    console.error('branch gate timed out');
    process.exit(2);
  }, 10_000);
  finish();
  `);
  fs.writeFileSync(path.join(workspacePath, 'branch-marker.mjs'), "import fs from 'node:fs'; fs.writeFileSync('branch-b-ran.txt', 'ran\\n');\n");
  fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

  git('init', '--initial-branch=main');
  git('config', 'user.email', 'relai@example.test');
  git('config', 'user.name', 'RelAI Test');
  git('add', '.');
  git('commit', '-m', 'fixture');
  git('branch', 'branch-a');
  git('branch', 'branch-b');

  fs.writeFileSync(configPath, JSON.stringify({
    version: 4,
    stateDir,
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    workspaces: { app: { path: workspacePath, commands: {}, testCommands: {} } }
  }, null, 2));
  process.env.REL_AI_MCP_CONFIG = configPath;
  resetToolActivity();

  const taskA = await callTool('relai_work', { mode: 'normal', action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Branch writer A' });
  const taskB = await callTool('relai_work', { mode: 'normal', action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Branch writer B' });

  const firstStarted = waitForFile(startedPath);
  const firstSwitch = callTool('relai_exec', {
    workspace: 'app',
    work_id: taskA.work_id,
    command: 'git switch branch-a && node branch-gate.mjs'
  });
  await firstStarted;
  assert.equal(git('branch', '--show-current'), 'branch-a');

  const secondSwitch = callTool('relai_exec', {
    workspace: 'app',
    work_id: taskB.work_id,
    command: 'git switch branch-b && node branch-marker.mjs'
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(git('branch', '--show-current'), 'branch-a', 'a second task must not switch the shared branch while another branch-changing command is active');
  assert.equal(fs.existsSync(path.join(workspacePath, 'branch-b-ran.txt')), false, 'the second branch-changing command must remain queued until the first releases the workspace');

  fs.writeFileSync(releasePath, 'release\n');
  const [firstResult, secondResult] = await Promise.all([firstSwitch, secondSwitch]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(git('branch', '--show-current'), 'branch-b');
  assert.equal(fs.readFileSync(path.join(workspacePath, 'branch-b-ran.txt'), 'utf8'), 'ran\n');

  await Promise.all([
    callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: taskA.work_id, reason: 'Branch concurrency coverage complete.' }),
    callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: taskB.work_id, reason: 'Branch concurrency coverage complete.' })
  ]);

  console.log('Branch-changing commands are workspace-exclusive while independent task operations remain task-scoped.');
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  await repositoryIntelligence.shutdown();
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

process.exit(0);
