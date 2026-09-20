import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { readConfig } from '../src/config.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { withStateDatabase } from '../src/stateDatabase.ts';
import { flushTaskHistoryPersistence, readTaskHistory, readTaskHistorySessionRecord } from '../src/taskHistoryStore.ts';
import { taskCommitOwnership } from '../src/taskIntegrity.ts';
import { ensureCurrentHistory, getTaskHistoryDir, listSessions, pruneSessions, writeSession } from '../src/taskHistoryStorage.ts';
import { DEFAULT_TASK_IDLE_MS, getToolActivity, resetToolActivity } from '../src/toolActivity.js';
import { callTool as rawCallTool } from '../src/tools.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-reconciliation-'));
const workspace = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const context = { principal: 'local:trusted', publicHttpOnly: true, transportType: 'test', transportSessionId: 'reconciliation-test', conversationId: 'reconciliation-chat' };

function git(...args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
}

async function begin(label) {
  const result = await rawCallTool('relai_work', { action: 'begin', workspace: 'app', title: label }, context);
  assert.ok(result.work_id);
  return result.work_id;
}

try {
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src', 'index.js'), 'export const ready = true;\n');
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { check: 'node --check src/index.js' } }, null, 2));
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'relai@example.test');
  git('config', 'user.name', 'RelAI Test');
  git('add', '.');
  git('commit', '-m', 'fixture');

  fs.writeFileSync(configPath, JSON.stringify({
    version: 4,
    stateDir,
    workspaces: { app: { path: workspace, commands: {}, testCommands: { check: 'npm run check' } } }
  }, null, 2));
  process.env.REL_AI_MCP_CONFIG = configPath;
  resetToolActivity();

  fs.writeFileSync(path.join(workspace, 'ambient-unrelated.txt'), 'do not absorb\n');
  const committedTask = await begin('Commit reconciliation fixture');
  await rawCallTool('relai_edit', {
    workspace: 'app', work_id: committedTask, path: 'src/committed-owned.js', content: 'export const committed = true;\n'
  }, context);

  const committed = await rawCallTool('relai_publish', {
    action: 'commit', workspace: 'app', work_id: committedTask, message: 'commit task-owned reconciliation fixture'
  }, context);
  assert.equal(committed.ok, true);
  assert.equal(committed.addAll, false);
  assert.deepEqual(committed.paths, ['src/committed-owned.js']);
  assert.deepEqual(taskCommitOwnership(readConfig(), committedTask, 'app').ownedFiles, [], 'successful task commit must release live path ownership before another task can publish');
  assert.equal(git('status', '--porcelain=v1', '--', 'src/committed-owned.js'), '', 'committed task-owned path must be clean immediately');
  assert.equal(git('diff', '--cached', '--name-only', '--', 'src/committed-owned.js'), '', 'committed path must not remain reverse-staged');
  assert.ok(git('status', '--porcelain=v1', '--', 'ambient-unrelated.txt').startsWith('??'), 'ambient untracked work must remain untouched');

  const completedCommitted = await rawCallTool('relai_validate', {
    action: 'checks', workspace: 'app', work_id: committedTask, checks: ['npm:check'], complete: true,
    summary: 'Committed task-owned work reconciled cleanly.'
  }, context);
  assert.equal(completedCommitted.completionKnown, true);
  assert.equal(completedCommitted.residualState, 'clean');
  assert.deepEqual(completedCommitted.residualChangedFiles || [], []);
  assert.equal(getToolActivity().lastTask?.residualState, 'clean');

  fs.rmSync(path.join(workspace, 'ambient-unrelated.txt'), { force: true });
  resetToolActivity();

  const residualTask = await begin('Residual preservation fixture');
  await rawCallTool('relai_edit', {
    workspace: 'app', work_id: residualTask, path: 'src/residual-owned.js', content: 'export const residual = true;\n'
  }, context);
  const completedResidual = await rawCallTool('relai_validate', {
    action: 'checks', workspace: 'app', work_id: residualTask, checks: ['npm:check'], complete: true,
    summary: 'Validated task intentionally remains uncommitted.'
  }, context);
  assert.equal(completedResidual.completionKnown, true);
  assert.equal(completedResidual.residualState, 'preserved_uncommitted');
  assert.deepEqual(completedResidual.residualChangedFiles, ['src/residual-owned.js']);
  assert.match(completedResidual.message, /explicit preserved uncommitted work/i);
  assert.equal(getToolActivity().lastTask?.residualState, 'preserved_uncommitted');
  assert.deepEqual(getToolActivity().lastTask?.residualChangedFiles, ['src/residual-owned.js']);

  resetToolActivity();
  const idleTask = await begin('Idle task must remain resumable');
  await flushTaskHistoryPersistence();
  const idleSession = readTaskHistorySessionRecord(readConfig(), idleTask);
  const inactiveAt = new Date(Date.now() - DEFAULT_TASK_IDLE_MS - 5_000).toISOString();
  writeSession(getTaskHistoryDir(readConfig()), {
    ...idleSession,
    status: 'planning',
    state: 'waiting',
    updatedAt: inactiveAt,
    lastActivityAt: inactiveAt,
    events: (idleSession.events || []).map(event => ({ ...event, timestamp: inactiveAt, ts: inactiveAt, startedAt: inactiveAt, completedAt: inactiveAt }))
  });
  resetToolActivity();
  const historyAfterIdle = readTaskHistory(readConfig(), getToolActivity(), { limit: 100 });
  assert.equal(historyAfterIdle.some(session => session.id === idleTask && session.status === 'inactive'), true, 'an idle no-op task must remain stored as resumable inactive work');
  const differentConversation = await rawCallTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Idle task must remain resumable', bootstrap: 'none'
  }, { ...context, conversationId: 'different-reconciliation-chat' });
  assert.notEqual(differentConversation.work_id, idleTask, 'durable recovery must not cross ChatGPT conversation identity');
  await rawCallTool('relai_work', { action: 'cancel', workspace: 'app', work_id: differentConversation.work_id, reason: 'Conversation isolation regression complete.' }, { ...context, conversationId: 'different-reconciliation-chat' });
  resetToolActivity();
  const recoveredBegin = await rawCallTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Idle task must remain resumable', bootstrap: 'compact'
  }, context);
  assert.equal(recoveredBegin.work_id, idleTask, 'relai_work begin must recover the persisted unfinished task after live context is lost');
  assert.equal(recoveredBegin.bootstrap?.recoveredTask?.goal, 'Idle task must remain resumable');
  assert.equal(recoveredBegin.bootstrap?.recoveredTask?.status, 'inactive');
  const resumedIdle = await rawCallTool('relai_read', { workspace: 'app', work_id: recoveredBegin.work_id, paths: ['src/index.js'] }, context);
  assert.equal(resumedIdle.work_id, idleTask, 'the recovered task must continue under its original identity');
  await rawCallTool('relai_work', { action: 'cancel', workspace: 'app', work_id: idleTask, reason: 'Idle recovery regression complete.' }, context);

  resetToolActivity();
  const statusResumeTask = await begin('Status reconnect reactivates task');
  await flushTaskHistoryPersistence();
  const statusResumeSession = readTaskHistorySessionRecord(readConfig(), statusResumeTask);
  const statusResumeInactiveAt = new Date(Date.now() - DEFAULT_TASK_IDLE_MS - 5_000).toISOString();
  writeSession(getTaskHistoryDir(readConfig()), {
    ...statusResumeSession,
    status: 'planning',
    state: 'waiting',
    updatedAt: statusResumeInactiveAt,
    lastActivityAt: statusResumeInactiveAt,
    events: (statusResumeSession.events || []).map(event => ({ ...event, timestamp: statusResumeInactiveAt, ts: statusResumeInactiveAt, startedAt: statusResumeInactiveAt, completedAt: statusResumeInactiveAt }))
  });
  resetToolActivity();
  readTaskHistory(readConfig(), getToolActivity(), { limit: 100 });
  assert.equal(readTaskHistorySessionRecord(readConfig(), statusResumeTask)?.status, 'inactive');
  await rawCallTool('relai_work', { action: 'status', workspace: 'app', work_id: statusResumeTask }, { ...context, conversationId: '' });
  assert.equal(getToolActivity().activeTaskCount, 0, 'monitor-only status reads without conversation identity must not reactivate inactive work');
  await rawCallTool('relai_work', { action: 'status', workspace: 'app', work_id: statusResumeTask }, context);
  assert.equal(getToolActivity().tasks.find(task => task.taskId === statusResumeTask)?.status, 'planning', 'same-conversation status recovery must reactivate the continued task');
  assert.equal(readTaskHistorySessionRecord(readConfig(), statusResumeTask, { reconcileInactive: false })?.status, 'planning', 'reactivated status must reach durable task history for the dashboard');
  await rawCallTool('relai_work', { action: 'cancel', workspace: 'app', work_id: statusResumeTask, reason: 'Status reconnect regression complete.' }, context);

  const pruneStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-open-history-prune-'));
  const pruneConfig = { stateDir: pruneStateDir };
  ensureCurrentHistory(pruneConfig);
  const pruneDirectory = getTaskHistoryDir(pruneConfig);
  const record = (id, status, extra = {}) => writeSession(pruneDirectory, {
    id,
    status,
    workspace: 'app',
    updatedAt: new Date().toISOString(),
    progress: { mode: 'indeterminate', label: status },
    ...extra
  });
  record('open-inactive', 'inactive', { resumeStatus: 'planning' });
  record('terminal-completed', 'completed', { completionKnown: true });
  record('terminal-cancelled', 'cancelled', { endReason: 'explicit_cancellation' });
  withStateDatabase(pruneConfig, db => {
    const insertIntegrity = db.prepare('INSERT INTO task_integrity_tasks(task_id,updated_at_ms,payload) VALUES(?,?,?)');
    insertIntegrity.run('terminal-completed', Date.now(), JSON.stringify({ taskId: 'terminal-completed', completedAt: new Date().toISOString() }));
    insertIntegrity.run('terminal-cancelled', Date.now(), JSON.stringify({ taskId: 'terminal-cancelled', cancelledAt: new Date().toISOString() }));
    insertIntegrity.run('orphan-terminal', Date.now(), JSON.stringify({ taskId: 'orphan-terminal', completedAt: new Date().toISOString() }));
    insertIntegrity.run('orphan-resumable', Date.now(), JSON.stringify({ taskId: 'orphan-resumable', completedAt: '', cancelledAt: '' }));
    db.prepare('INSERT INTO workspace_integrity(workspace,updated_at_ms,payload) VALUES(?,?,?)')
      .run('app', Date.now(), JSON.stringify({ workspace: 'app', uncommittedOwners: { 'owned.txt': ['terminal-completed'] } }));
  }, { transaction: true });
  pruneSessions(pruneDirectory, 1);
  assert.deepEqual(listSessions(pruneDirectory, 10).map(session => session.id), ['open-inactive'], 'history pruning must preserve nonterminal work even when it exceeds the nominal retention target');
  const retainedIntegrity = withStateDatabase(pruneConfig, db =>
    db.prepare('SELECT task_id FROM task_integrity_tasks ORDER BY task_id').all().map(row => row.task_id)
  , { transaction: true });
  assert.deepEqual(
    retainedIntegrity,
    ['orphan-resumable', 'terminal-completed'],
    'history pruning must retire unowned terminal integrity rows while preserving outstanding ownership and resumable authority'
  );
  withStateDatabase(pruneConfig, db => {
    db.prepare('UPDATE workspace_integrity SET payload=? WHERE workspace=?')
      .run(JSON.stringify({ workspace: 'app', uncommittedOwners: {} }), 'app');
  }, { transaction: true });
  pruneSessions(pruneDirectory, 1);
  const integrityAfterOwnershipRelease = withStateDatabase(pruneConfig, db =>
    db.prepare('SELECT task_id FROM task_integrity_tasks ORDER BY task_id').all().map(row => row.task_id)
  , { transaction: true });
  assert.deepEqual(
    integrityAfterOwnershipRelease,
    ['orphan-resumable'],
    'a previously protected terminal orphan must retire after its outstanding ownership is released'
  );
  fs.rmSync(pruneStateDir, { recursive: true, force: true });

  console.log('Task commit, inactivity recovery, cleanup retention, explicit completion, and residual-state tests passed.');
} finally {
  await flushAuditWrites();
  await repositoryIntelligence.shutdown();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  await removeDirectoryWithRetry(root);
}
process.exit(0);

async function removeDirectoryWithRetry(directory, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (process.platform === 'win32' && lastError?.code === 'EPERM') {
    process.once('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
    return;
  }
  throw lastError;
}
