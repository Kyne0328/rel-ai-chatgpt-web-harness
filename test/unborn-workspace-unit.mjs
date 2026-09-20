import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { callTool as rawCallTool } from '../src/tools.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { resetToolActivity } from '../src/toolActivity.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-unborn-workspace-'));
const workspacePath = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const context = { principal: 'local:trusted', publicHttpOnly: true, transportType: 'test' };

fs.mkdirSync(workspacePath, { recursive: true });
execFileSync('git', ['init', '--initial-branch=main'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/rel-ai-cloud.git'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['config', 'branch.main.remote', 'origin'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['config', 'branch.main.merge', 'refs/heads/main'], { cwd: workspacePath, stdio: 'ignore' });
fs.writeFileSync(path.join(workspacePath, 'seed.txt'), 'uncommitted seed\n');
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    app: { path: workspacePath, commands: {}, testCommands: {} }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  resetToolActivity();
  const task = await rawCallTool('relai_work', {
    action: 'begin',
    workspace: 'app',
    bootstrap: 'compact',
    objective: 'Modify a repository before its first commit.'
  }, context);
  assert.equal(task.ok, true);
  assert.match(task.work_id, /^[0-9a-f-]{36}$/i);
  const taskContext = await rawCallTool('relai_work', { action: 'context', work_id: task.work_id }, context);
  assert.equal(taskContext.bootstrap?.git?.branch, 'main');
  assert.equal(taskContext.bootstrap?.git?.unborn, true);

  const preview = await rawCallTool('relai_edit', {
    work_id: task.work_id,
    path: 'src/index.js',
    content: 'export const ready = true;\n',
    dryRun: true
  }, context);
  assert.equal(preview.ok, true);
  assert.equal(preview.dryRun, undefined, 'compact edit results omit the request-only dryRun flag');
  assert.equal(fs.existsSync(path.join(workspacePath, 'src', 'index.js')), false);

  const edit = await rawCallTool('relai_edit', {
    work_id: task.work_id,
    path: 'src/index.js',
    content: 'export const ready = true;\n'
  }, context);
  assert.equal(edit.ok, true);
  assert.deepEqual(edit.changedFiles, ['src/index.js']);
  assert.equal(fs.readFileSync(path.join(workspacePath, 'src', 'index.js'), 'utf8'), 'export const ready = true;\n');

  const patchEdit = await rawCallTool('relai_edit', {
    work_id: task.work_id,
    updateText: [
      '*** Begin Patch',
      '*** Add File: src/worker.js',
      '+export const worker = true;',
      '*** End Patch'
    ].join('\n'),
    returnDiff: false
  }, context);
  assert.equal(patchEdit.ok, true);
  assert.deepEqual(patchEdit.changedFiles, ['src/worker.js']);
  assert.equal(Object.hasOwn(patchEdit, 'backup'), false, 'removed advanced patch backups must not reappear for unborn repositories');

  const review = await rawCallTool('relai_changes', {
    action: 'diff',
    work_id: task.work_id
  }, context);
  assert.equal(review.ok, true);
  assert.equal(review.branch, 'main');
  assert.ok(review.reviewedFiles.includes('src/index.js'));
  assert.ok(review.reviewedFiles.includes('src/worker.js'));
  assert.match(review.diff, /\+export const ready = true;/);

  const commits = execFileSync('git', ['rev-list', '--all', '--count'], { cwd: workspacePath, encoding: 'utf8' }).trim();
  assert.equal(commits, '0');

  const cancelled = await rawCallTool('relai_work', {
    action: 'cancel',
    work_id: task.work_id,
    reason: 'Unborn repository regression completed.'
  }, context);
  assert.equal(cancelled.ok, true);
} finally {
  resetToolActivity();
  await repositoryIntelligence.shutdown();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('Guarded work sessions and edits support repositories with no commits.');
// Nested raw tool calls can leave Windows piped stdio referenced after app resources close.
// Teardown above is complete, so exit explicitly to keep this isolated integration test deterministic.
process.exit(0);
