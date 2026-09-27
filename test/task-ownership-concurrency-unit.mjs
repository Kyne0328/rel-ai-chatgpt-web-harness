import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { readConfig } from '../src/config.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { classifyStatusOwnership } from '../src/repo/gitOps.js';
import { gitStatusArgs } from '../src/repo/gitStatus.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { taskCommitOwnership } from '../src/taskIntegrity.ts';
import { resetToolActivity } from '../src/toolActivity.js';
import { callTool as rawCallTool } from '../src/tools.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-ownership-concurrency-'));
const workspacePath = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const context = { principal: 'local:trusted', publicHttpOnly: true, transportType: 'test', transportSessionId: 'ownership-concurrency' };
const callTool = (name, args) => rawCallTool(name, args, context);

function git(...args) {
  return execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8' });
}

try {
  fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'src', 'base.js'), 'export const base = true;\n');
  fs.writeFileSync(path.join(workspacePath, 'src', 'shared.js'), 'export const left = 0;\nexport const right = 0;\n');
  fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'relai@example.test');
  git('config', 'user.name', 'RelAI Test');
  git('add', '.');
  git('commit', '-m', 'fixture');

  fs.writeFileSync(configPath, JSON.stringify({
    version: 4,
    stateDir,
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    workspaces: { app: { path: workspacePath, commands: {}, testCommands: {} } }
  }, null, 2));
  process.env.REL_AI_MCP_CONFIG = configPath;
  resetToolActivity();

  const taskA = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Independent writer A' });
  const taskB = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Independent writer B' });

  await Promise.all([
    callTool('relai_edit', {
      workspace: 'app', work_id: taskA.work_id, path: 'src/task-a.js', content: 'export const taskA = true;\n'
    }),
    callTool('relai_edit', {
      workspace: 'app', work_id: taskB.work_id, path: 'src/task-b.js', content: 'export const taskB = true;\n'
    })
  ]);

  assert.equal(fs.readFileSync(path.join(workspacePath, 'src', 'task-a.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const taskA = true;\n');
  assert.equal(fs.readFileSync(path.join(workspacePath, 'src', 'task-b.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const taskB = true;\n');

  const config = readConfig();
  const workspace = config.workspaces.app;
  const status = git(...gitStatusArgs());
  const ownedA = classifyStatusOwnership({ alias: 'app', ...workspace }, config, status, taskA.work_id);
  const ownedB = classifyStatusOwnership({ alias: 'app', ...workspace }, config, status, taskB.work_id);
  assert.deepEqual(ownedA.sessionTouched, ['src/task-a.js'], 'task A must not claim task B changes from the shared session baseline');
  assert.deepEqual(ownedB.sessionTouched, ['src/task-b.js'], 'task B must not claim task A changes from the shared session baseline');

  await callTool('relai_edit', {
    workspace: 'app', work_id: taskA.work_id, path: 'src/shared.js', content: 'export const left = 1;\nexport const right = 0;\n'
  });
  await callTool('relai_edit', {
    workspace: 'app', work_id: taskB.work_id, path: 'src/shared.js', content: 'export const left = 1;\nexport const right = 2;\n'
  });
  assert.equal(fs.readFileSync(path.join(workspacePath, 'src', 'shared.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const left = 1;\nexport const right = 2;\n');

  const headBeforeRejectedPublish = git('rev-parse', 'HEAD').trim();
  const sharedPublish = await callTool('relai_publish', {
    action: 'commit', workspace: 'app', work_id: taskA.work_id, message: 'must not absorb shared task work'
  });
  assert.equal(sharedPublish.ok, false, 'a task commit must refuse paths currently owned by another logical task');
  assert.match(String(sharedPublish.error || ''), /other-task work|ownership/i);
  assert.equal(git('rev-parse', 'HEAD').trim(), headBeforeRejectedPublish, 'rejected shared ownership must not create Git history');
  assert.equal(git('diff', '--cached', '--name-only').trim(), '', 'rejected shared ownership must not disturb the visible Git index');

  const foreignPublish = await callTool('relai_publish', {
    action: 'commit', workspace: 'app', work_id: taskA.work_id, message: 'commit explicitly selected earlier task path', paths: ['src/task-b.js']
  });
  assert.equal(foreignPublish.ok, true, 'explicit paths must cross logical-task ownership without widening beyond the selected files');
  assert.equal(foreignPublish.paths, undefined, 'publish success must not echo caller-owned explicit paths');
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'src/task-b.js', 'cross-task explicit commit must contain only the selected path');
  assert.ok(git('status', '--porcelain=v1', '--', 'src/task-a.js').trim(), 'unselected task A work must remain dirty');
  assert.ok(git('status', '--porcelain=v1', '--', 'src/shared.js').trim(), 'unselected shared work must remain dirty');

  fs.writeFileSync(path.join(workspacePath, 'src', 'taskless.js'), 'export const taskless = true;\n');
  const tasklessPublish = await callTool('relai_publish', {
    action: 'commit', workspace: 'app', message: 'commit explicit workspace path without resurrecting a task', paths: ['src/taskless.js']
  });
  assert.equal(tasklessPublish.ok, true, 'an explicitly scoped commit must not require a live work_id');
  assert.equal(tasklessPublish.paths, undefined, 'taskless publish success must not echo caller-owned explicit paths');
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'src/taskless.js');

  const addAllPublish = await callTool('relai_publish', {
    action: 'commit', workspace: 'app', work_id: taskA.work_id, message: 'aggregate reviewed workspace changes', addAll: true
  });
  assert.equal(addAllPublish.ok, true, 'explicit addAll must aggregate the remaining visible workspace even from a logical task');
  assert.equal(addAllPublish.addAll, undefined, 'publish success must not echo caller-owned addAll');
  assert.deepEqual(new Set(addAllPublish.paths), new Set(['src/shared.js', 'src/task-a.js']), 'addAll must report the derived files it actually committed');
  assert.deepEqual(new Set(git('show', '--name-only', '--format=', 'HEAD').trim().split(/\r?\n/).filter(Boolean)), new Set(['src/shared.js', 'src/task-a.js']), 'workspace aggregation must commit exactly the remaining visible files');
  assert.equal(git('status', '--porcelain=v1').trim(), '', 'workspace aggregation must leave the committed repository clean');
  assert.deepEqual(taskCommitOwnership(readConfig(), taskA.work_id, 'app').ownedFiles, [], 'workspace aggregation must reconcile task A ownership');
  assert.deepEqual(taskCommitOwnership(readConfig(), taskB.work_id, 'app').ownedFiles, [], 'workspace aggregation must reconcile task B ownership');

  await Promise.all([
    callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: taskA.work_id, reason: 'Ownership concurrency coverage complete.' }),
    callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: taskB.work_id, reason: 'Ownership concurrency coverage complete.' })
  ]);

  assert.equal(fs.existsSync(path.join(workspacePath, 'src', 'task-a.js')), true, 'cancellation must preserve already-visible task A changes');
  assert.equal(fs.existsSync(path.join(workspacePath, 'src', 'task-b.js')), true, 'cancellation must preserve already-visible task B changes');

  fs.writeFileSync(path.join(workspacePath, 'src', 'stale-task.js'), 'export const staleTask = true;\n');
  await assert.rejects(
    () => callTool('relai_publish', {
      action: 'commit', workspace: 'app', work_id: taskA.work_id, message: 'commit after old task ended', paths: ['src/stale-task.js']
    }),
    error => error?.code === 'INVALID_TASK_STATE',
    'an explicitly supplied terminal work_id must be rejected instead of silently becoming taskless'
  );
  const staleOptionalPublish = await callTool('relai_publish', {
    action: 'commit', workspace: 'app', message: 'commit after old task ended', paths: ['src/stale-task.js']
  });
  assert.equal(staleOptionalPublish.ok, true, 'omitting work_id must allow the explicitly scoped workspace commit');
  assert.equal(staleOptionalPublish.paths, undefined, 'taskless explicit publish must not echo caller-owned paths');
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'src/stale-task.js');

  fs.writeFileSync(path.join(workspacePath, 'src', 'stale-add-all.js'), 'export const staleAddAll = true;\n');
  await assert.rejects(
    () => callTool('relai_publish', {
      action: 'commit', workspace: 'app', work_id: taskA.work_id, message: 'commit all requested workspace changes after old task ended', addAll: true
    }),
    error => error?.code === 'INVALID_TASK_STATE',
    'addAll must not silently discard an explicitly supplied terminal work_id'
  );
  const staleAddAllPublish = await callTool('relai_publish', {
    action: 'commit', workspace: 'app', message: 'commit all requested workspace changes after old task ended', addAll: true
  });
  assert.equal(staleAddAllPublish.ok, true, 'taskless addAll must execute from explicit workspace scope without a dashboard approval');
  assert.equal(staleAddAllPublish.addAll, undefined, 'taskless addAll publish must not echo caller-owned addAll');
  assert.deepEqual(staleAddAllPublish.paths, ['src/stale-add-all.js']);
  assert.equal(git('show', '--name-only', '--format=', 'HEAD').trim(), 'src/stale-add-all.js');

  console.log('Independent concurrent task ownership stays narrow by default and supports explicit workspace aggregation.');
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  repositoryIntelligence.shutdown();
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

process.exit(0);
