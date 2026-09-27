import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-changes-'));
const repo = path.join(root, 'repo');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'alpha.txt'), 'alpha baseline\n');
fs.writeFileSync(path.join(repo, 'beta.txt'), 'beta baseline\n');
fs.writeFileSync(path.join(repo, 'café.txt'), 'café baseline\n');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '--initial-branch=main');
git('config', 'user.email', 'relai@example.test');
git('config', 'user.name', 'RelAI Test');
git('add', '.');
git('commit', '-m', 'fixture');
fs.writeFileSync(path.join(repo, 'ambient.txt'), 'unrelated visible checkout change\n');

fs.writeFileSync(configPath, JSON.stringify({
  version: 7,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: repo, commands: {}, testCommands: {} } }
}, null, 2));

const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_CONFIG = configPath;

const { flushAuditWrites } = await import('../src/audit.js');
const { readConfig } = await import('../src/config.js');
const { updateWorkspace } = await import('../src/configEditor.js');
const { flushLocalAnalytics } = await import('../src/localAnalytics.js');
const { repositoryIntelligence } = await import('../src/repository/intelligence/service.js');
const { describeTaskCodeWorkspace, readTaskCodeDiff } = await import('../src/taskCodeWorkspace.js');
const { flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
const { readTaskIntegrity } = await import('../src/taskIntegrity.ts');
const { resetTaskHistoryCaches } = await import('../src/taskHistoryStorage.ts');
const { callTool } = await import('../src/tools.js');
const { resetToolActivity } = await import('../src/toolActivity.js');

const context = { principal: 'local:trusted', transportType: 'test' };
let taskId = '';

try {
  resetToolActivity();
  const task = await callTool('relai_work', {
    action: 'begin',
    workspace: 'app',
    bootstrap: 'none',
    title: 'Changes viewer test'
  }, context);
  taskId = task.work_id;
  const config = readConfig();

  const initial = await describeTaskCodeWorkspace(config, { taskId });
  assert.equal(initial.workspace, 'app');
  assert.equal(initial.workspaceMode, 'visible');
  assert.equal(initial.integrationStatus, 'not_applicable');
  assert.equal(initial.readOnly, true);
  assert.equal(initial.writable, false);
  assert.equal(initial.historyMode, 'live');
  assert.deepEqual(initial.changedFiles, [], 'ambient visible-checkout changes must not be presented as task-owned changes');

  const alphaEdit = await callTool('relai_edit', {
    workspace: 'app',
    work_id: taskId,
    path: 'alpha.txt',
    content: 'alpha from agent\n'
  }, context);
  assert.equal(alphaEdit.ok, true);
  const betaEdit = await callTool('relai_edit', {
    workspace: 'app',
    work_id: taskId,
    path: 'beta.txt',
    content: 'beta from agent\n'
  }, context);
  assert.equal(betaEdit.ok, true);
  const unicodeEdit = await callTool('relai_edit', {
    workspace: 'app',
    work_id: taskId,
    path: 'café.txt',
    content: 'café from agent\n'
  }, context);
  assert.equal(unicodeEdit.ok, true);

  const live = await describeTaskCodeWorkspace(config, { taskId });
  assert.deepEqual(new Set(live.changedFiles), new Set(['alpha.txt', 'beta.txt', 'café.txt']));
  assert.equal(live.changedFileStatuses?.['alpha.txt']?.code, 'M');
  assert.deepEqual(
    { additions: live.changedFileStatuses?.['alpha.txt']?.additions, deletions: live.changedFileStatuses?.['alpha.txt']?.deletions },
    { additions: 1, deletions: 1 },
    'live task changes should expose line-impact stats without reading every diff in the UI'
  );
  assert.equal(live.changedFiles.includes('ambient.txt'), false, 'unrelated dirty files must stay out of the task changes list');
  assert.equal(live.readOnly, true);
  assert.equal(live.writable, false);

  const renamed = updateWorkspace(readConfig(), {
    action: 'upsert',
    mode: 'update',
    originalAlias: 'app',
    alias: 'renamed-app',
    path: repo,
    sourcePaths: [repo],
    enforceUniquePath: true
  });
  assert.equal(renamed.ok, true);
  const renamedConfig = readConfig();
  const renamedLive = await describeTaskCodeWorkspace(renamedConfig, { taskId });
  assert.equal(renamedLive.workspace, 'renamed-app', 'task changes must follow a renamed project through its recorded workspace path');
  assert.deepEqual(new Set(renamedLive.changedFiles), new Set(['alpha.txt', 'beta.txt', 'café.txt']));
  const renamedLiveDiff = await readTaskCodeDiff(renamedConfig, { taskId, path: 'alpha.txt' });
  assert.equal(renamedLiveDiff.content.replaceAll('\r\n', '\n'), 'alpha from agent\n');

  const restoredAlias = updateWorkspace(readConfig(), {
    action: 'upsert',
    mode: 'update',
    originalAlias: 'renamed-app',
    alias: 'app',
    path: repo,
    sourcePaths: [repo],
    enforceUniquePath: true
  });
  assert.equal(restoredAlias.ok, true);

  const liveDiff = await readTaskCodeDiff(config, { taskId, path: 'alpha.txt' });
  assert.equal(liveDiff.baseContent.replaceAll('\r\n', '\n'), 'alpha baseline\n');
  assert.equal(liveDiff.content.replaceAll('\r\n', '\n'), 'alpha from agent\n');
  assert.equal(liveDiff.baseAvailable, true);
  assert.equal(liveDiff.historyMode, 'live');
  assert.equal(liveDiff.readOnly, true);
  assert.equal(liveDiff.writable, false);

  await assert.rejects(
    () => readTaskCodeDiff(config, { taskId, path: '../outside.txt' }),
    /Changes viewer path|traversal|outside/i,
    'diff access must preserve the repository safe-path boundary'
  );

  const integrity = readTaskIntegrity(config, taskId, 'app');
  assert.deepEqual(
    new Set(integrity.taskOwnedChangedFiles),
    new Set(['alpha.txt', 'beta.txt', 'café.txt']),
    'agent changes must remain attributed to the active task'
  );

  const committed = await callTool('relai_publish', {
    action: 'commit',
    workspace: 'app',
    work_id: taskId,
    message: 'commit changes viewer fixture'
  }, context);
  assert.equal(committed.ok, true);
  assert.match(committed.head || '', /^[a-f0-9]{40,64}$/i, 'task commits must return the exact commit identity');
  assert.equal(git('status', '--porcelain=v1', '--', 'alpha.txt', 'beta.txt', 'café.txt'), '', 'committed task files must be clean');
  assert.ok(git('status', '--porcelain=v1', '--', 'ambient.txt').startsWith('??'), 'ambient work must remain untouched');

  await flushAuditWrites();
  await flushTaskHistoryPersistence();

  const committedView = await describeTaskCodeWorkspace(config, { taskId });
  assert.equal(committedView.historyMode, 'committed', 'a clean committed task must fall back to its historical diff');
  assert.equal(committedView.historyAvailable, true);
  assert.equal(committedView.commitHead, committed.head);
  assert.deepEqual(new Set(committedView.changedFiles), new Set(['alpha.txt', 'beta.txt', 'café.txt']), 'historical task changes must preserve non-ASCII filenames');
  assert.equal(committedView.changedFileStatuses?.['alpha.txt']?.code, 'M');
  assert.deepEqual(
    { additions: committedView.changedFileStatuses?.['alpha.txt']?.additions, deletions: committedView.changedFileStatuses?.['alpha.txt']?.deletions },
    { additions: 1, deletions: 1 },
    'historical task changes should retain line-impact stats'
  );

  const committedDiff = await readTaskCodeDiff(config, { taskId, path: 'alpha.txt' });
  assert.equal(committedDiff.baseContent.replaceAll('\r\n', '\n'), 'alpha baseline\n');
  assert.equal(committedDiff.content.replaceAll('\r\n', '\n'), 'alpha from agent\n');
  assert.equal(committedDiff.historyMode, 'committed');
  assert.equal(committedDiff.commitHead, committed.head);
  assert.equal(committedDiff.readOnly, true);
  assert.equal(committedDiff.writable, false);
  const unicodeDiff = await readTaskCodeDiff(config, { taskId, path: 'café.txt' });
  assert.equal(unicodeDiff.baseContent.replaceAll('\r\n', '\n'), 'café baseline\n');
  assert.equal(unicodeDiff.content.replaceAll('\r\n', '\n'), 'café from agent\n');
  assert.equal(unicodeDiff.historyMode, 'committed');

  const completed = await callTool('relai_validate', {
    action: 'checks',
    workspace: 'app',
    work_id: taskId,
    checks: ['git diff --check'],
    complete: true,
    summary: 'Changes viewer fixture committed and validated.'
  }, context);
  assert.equal(completed.completionKnown, true);
  await flushAuditWrites();
  await flushTaskHistoryPersistence();

  const completedView = await describeTaskCodeWorkspace(config, { taskId });
  assert.equal(completedView.status, 'completed');
  assert.equal(completedView.historyMode, 'committed');
  assert.equal(completedView.readOnly, true);
  assert.equal(completedView.writable, false);
  assert.deepEqual(new Set(completedView.changedFiles), new Set(['alpha.txt', 'beta.txt', 'café.txt']), 'completed tasks must keep their committed file list reviewable');
  const completedDiff = await readTaskCodeDiff(config, { taskId, path: 'beta.txt' });
  assert.equal(completedDiff.baseContent.replaceAll('\r\n', '\n'), 'beta baseline\n');
  assert.equal(completedDiff.content.replaceAll('\r\n', '\n'), 'beta from agent\n');

  console.log('Task Changes viewer live and committed read-only diff behavior passed.');
} finally {
  await repositoryIntelligence.shutdown();
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  resetTaskHistoryCaches();
  resetToolActivity();
  await flushLocalAnalytics();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
}
