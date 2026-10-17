import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearAuditHistory } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.ts';
import { callTool as rawCallTool } from '../src/tools.js';
import { clearTaskHistory, flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetToolActivity } from '../src/toolActivity.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-run-checks-'));
const workspacePath = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;

fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'src', 'index.js'), 'export const ready = true;\n');
fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({}, null, 2));

execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspacePath });
execFileSync('git', ['add', '.'], { cwd: workspacePath });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspacePath, stdio: 'ignore' });
for (let index = 0; index < 30; index += 1) {
  const ambient = path.join(workspacePath, 'ambient', `file-${index}.txt`);
  fs.mkdirSync(path.dirname(ambient), { recursive: true });
  fs.writeFileSync(ambient, `baseline-${index}\n`);
}
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    app: { path: workspacePath, commands: {}, testCommands: { check: 'npm run check' } }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  const context = { publicHttpOnly: true };
  resetToolActivity();
  const task = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' }, context);
  const edit = await callTool('relai_edit', {
    workspace: 'app',
    work_id: task.work_id,
    path: 'src/tools.js',
    content: 'export const taskOwned = true;\n',
    runChecks: true
  }, context);
  assert.equal(edit.ok, true);
  assert.equal(edit.checks, undefined, 'compact edit results omit embedded validation details; successful completion below proves the evidence was recorded');

  const completion = await callTool('relai_work', {
    action: 'finish',
    workspace: 'app',
    work_id: task.work_id,
    summary: 'Embedded edit checks validated the task.'
  }, context);
  assert.equal(completion.ok, true, 'passed embedded checks must allow completion without rerunning validation');
  assert.equal(completion.validationStatus, 'passed');

  fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ scripts: { check: 'node --check src/failing.js' } }));
  const failingTask = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none' }, context);
  const failingEdit = await callTool('relai_edit', { workspace: 'app', work_id: failingTask.work_id,
    path: 'src/failing.js', content: 'const = invalid;\n', runChecks: true }, context);
  assert.equal(failingEdit.ok, false);
  assert.equal(failingEdit.mutationEffect, 'applied');
  assert.deepEqual(failingEdit.changedFiles, ['src/failing.js']);
  assert.equal(failingEdit.validationStatus, 'failed');
  assert.match(failingEdit.error, /Post-edit validation failed/);
  assert.ok(failingEdit.checks.failedCheck);
  assert.equal(failingEdit.checks.results.some(result => result.exitCode !== 0 && /SyntaxError/.test(result.stderr)), true,
    'the failed embedded check must keep its actionable diagnostics in the compact response');
  assert.equal(fs.readFileSync(path.join(workspacePath, 'src/failing.js'), 'utf8'), 'const = invalid;\n',
    'failed validation must not obscure or repeat the completed mutation');
  await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: failingTask.work_id,
    reason: 'Failed embedded-check fixture completed.' }, context);

} finally {
  await repositoryIntelligence.shutdown();
  await flushLocalAnalytics();
  resetToolActivity();
  await flushTaskHistoryPersistence();
  await clearTaskHistory({ stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') });
  await clearAuditHistory({ stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') });
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('Passing embedded edit checks can satisfy completion validation without a second validation call.');
