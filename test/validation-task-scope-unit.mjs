import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { callTool as rawCallTool } from '../src/tools.js';
import { readConfig } from '../src/config.js';
import { readValidationPlan } from '../src/bridge/validationPlan.js';
import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetToolActivity } from '../src/toolActivity.js';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-task-scope-'));
const workspacePath = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;

fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'src', 'index.js'), 'export const ready = true;\n');
fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
  scripts: { check: 'node --check src/index.js' }
}, null, 2));
execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspacePath });
execFileSync('git', ['add', '.'], { cwd: workspacePath });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspacePath, stdio: 'ignore' });

for (let index = 0; index < 30; index += 1) {
  const ambient = path.join(workspacePath, 'ambient', `file-${index}.txt`);
  fs.mkdirSync(path.dirname(ambient), { recursive: true });
  fs.writeFileSync(ambient, `pre-existing-${index}\n`);
}

fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    app: {
      path: workspacePath,
      commands: {},
      testCommands: { check: 'npm run check' }
    }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  resetToolActivity();
  const context = { publicHttpOnly: true };
  const task = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' }, context);
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: task.work_id,
    path: 'src/task-owned.js',
    content: 'export const taskOwned = true;\n'
  }, context);

  const validation = await callTool('relai_validate', {
    action: 'checks',
    workspace: 'app',
    work_id: task.work_id,
    complete: false
  }, context);
  assert.equal(validation.ok, true);
  assert.equal(validation.planSelection, 'focused', 'pre-existing dirty files must not broaden a one-file task validation plan');
  const plan = readValidationPlan(readConfig(), validation.planId, { alias: 'app', path: workspacePath });
  assert.deepEqual(plan.changedFiles, ['src/task-owned.js']);
  assert.equal(plan.validationScope.includes('src/task-owned.js'), true);
  assert.equal(plan.validationScope.includes('package.json'), true, 'validation configuration must stay inside the task fingerprint');
  assert.equal(plan.validationScope.some(file => file.startsWith('ambient/')), false, 'ambient dirty files must stay outside the task fingerprint');
  assert.equal(plan.recommended, 'focused');
  assert.equal(repositoryIntelligence.status({ alias: 'app', path: workspacePath }, readConfig()).watching, false,
    'validation impact analysis must not start a live repository watcher');

  const unrelated = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' }, context);
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: unrelated.work_id,
    path: 'ambient/concurrent-task.txt',
    content: 'unrelated concurrent task\n'
  }, context);
  const completion = await callTool('relai_work', {
    action: 'finish',
    workspace: 'app',
    work_id: task.work_id,
    summary: 'Task-scoped validation remains current after an unrelated concurrent change.'
  }, context);
  assert.equal(completion.ok, true, 'unrelated task mutations must not invalidate task-scoped validation');
  await callTool('relai_work', {
    action: 'cancel', workspace: 'app', work_id: unrelated.work_id, reason: 'Concurrent scope coverage complete.'
  }, context);

  const configTask = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' }, context);
  await callTool('relai_edit', {
    workspace: 'app', work_id: configTask.work_id, path: 'src/config-owned.js', content: 'export const configOwned = true;\n'
  }, context);
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: configTask.work_id, complete: false }, context);
  const packagePath = path.join(workspacePath, 'package.json');
  const packageBefore = fs.readFileSync(packagePath, 'utf8');
  const packageJson = JSON.parse(packageBefore);
  packageJson.description = 'validation config changed after checks';
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const staleCompletion = await callTool('relai_work', {
    action: 'finish', workspace: 'app', work_id: configTask.work_id,
    summary: 'Validation configuration changed after checks; completion records stale evidence instead of blocking.'
  }, context);
  assert.equal(staleCompletion.completionKnown, true);
  assert.equal(staleCompletion.validationStatus, 'stale');
  fs.writeFileSync(packagePath, packageBefore);
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  await repositoryIntelligence.shutdown();
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 10 : 2,
    retryDelay: 50
  });
}

console.log('Task-owned validation scope ignores unrelated dirty baseline files.');