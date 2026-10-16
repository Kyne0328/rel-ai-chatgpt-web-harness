import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { updateWorkspace } from "../src/configEditor.js";
import { resolveWorkspace, resolveWorkspaceInput, normalizeWorkspacePathForComparison } from "../src/config.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workspace-management-'));
const configPath = path.join(tmp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  const first = path.join(tmp, 'first');
  const second = path.join(tmp, 'second');
  const third = path.join(tmp, 'third');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.mkdirSync(third, { recursive: true });
  const current = {
    stateDir: tmp,
    workspaces: {
      alpha: {
        path: first,
        context: { snapshotMaxFiles: 321 }
      }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(current, null, 2));

  const renamed = updateWorkspace(current, {
    action: 'upsert',
    mode: 'update',
    originalAlias: 'alpha',
    alias: 'beta',
    path: second,
    sourcePaths: [second, third],
    enforceUniquePath: true
  });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.renamedFrom, 'alpha');
  assert.equal(renamed.config.workspaces.some(item => item.alias === 'alpha'), false);
  const beta = renamed.config.workspaces.find(item => item.alias === 'beta');
  assert.equal(beta.path, second);
  assert.deepEqual(beta.sourcePaths, [second, third]);
  assert.equal(beta.context.snapshotMaxFiles, 321);

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(saved.workspaces.alpha, undefined);
  assert.equal(saved.workspaces.beta.path, second);
  assert.deepEqual(saved.workspaces.beta.sourcePaths, [second, third]);

  assert.throws(() => updateWorkspace(saved, {
    action: 'upsert',
    mode: 'create',
    alias: 'beta',
    path: first,
    enforceUniquePath: true
  }), /already exists/);

  assert.throws(() => updateWorkspace(saved, {
    action: 'upsert',
    mode: 'create',
    alias: 'duplicate-path',
    path: second,
    enforceUniquePath: true
  }), /already configured as workspace 'beta'/);
  assert.throws(() => updateWorkspace(saved, {
    action: 'upsert',
    mode: 'create',
    alias: 'duplicate-secondary-path',
    path: first,
    sourcePaths: [first, third],
    enforceUniquePath: true
  }), /already configured as workspace 'beta'/);

  for (const staleAction of ['remove', 'rename', 'prune-tests', 'prune-stale-tests']) {
    assert.throws(
      () => updateWorkspace(saved, { action: staleAction, alias: 'beta' }),
      /Unknown workspace action/,
      `${staleAction} must not survive as a compatibility workspace action`
    );
  }

  const unchanged = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(unchanged, saved, 'failed duplicate operations must not partially rename or rewrite configuration');

  const resolvedByAlias = resolveWorkspace(saved, 'beta');
  assert.deepEqual(resolvedByAlias.sourcePaths, [second, third]);
  const resolvedByPath = resolveWorkspace(saved, second + path.sep);
  assert.equal(resolvedByPath.alias, 'beta');
  assert.equal(resolvedByPath.path, resolvedByAlias.path);
  assert.equal(resolveWorkspaceInput(saved, second).source, 'configured_path');
  assert.equal(normalizeWorkspacePathForComparison('C:\\Dev\\Repo\\', 'win32'), 'c:\\dev\\repo');
  assert.equal(normalizeWorkspacePathForComparison('C:/DEV/Repo/', 'win32'), 'c:\\dev\\repo');
  assert.equal(normalizeWorkspacePathForComparison('\\\\Server\\Share\\Repo\\', 'win32'), '\\\\server\\share\\repo');
  assert.throws(() => resolveWorkspace(saved, first), error => error?.code === 'WORKSPACE_PATH_NOT_CONFIGURED');
  assert.throws(() => resolveWorkspace(saved, path.join(second, 'nested')), error => error?.code === 'WORKSPACE_PATH_UNAVAILABLE');
  fs.mkdirSync(path.join(second, 'nested'));
  assert.throws(() => resolveWorkspace(saved, path.join(second, 'nested')), error => error?.code === 'WORKSPACE_PATH_NOT_CONFIGURED');
  assert.throws(() => resolveWorkspace({ workspaces: { one: { path: second }, two: { path: second } } }, second), error => error?.code === 'WORKSPACE_PATH_AMBIGUOUS');

  const linked = path.join(tmp, 'linked-second');
  try {
    fs.symlinkSync(second, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(resolveWorkspace(saved, linked).alias, 'beta', 'realpath-equivalent configured paths must match');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }

  const sourceFile = path.join(second, 'keep-me.txt');
  fs.writeFileSync(sourceFile, 'local project data');
  assert.throws(
    () => updateWorkspace(saved, { action: 'delete', alias: 'beta' }),
    /requires confirmDelete=true/,
    'project deletion must require explicit confirmation'
  );
  const deleted = updateWorkspace(saved, { action: 'delete', alias: 'beta', confirmDelete: true });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.config.workspaces.some(item => item.alias === 'beta'), false, 'deletion removes only the Rel.AI project entry');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'local project data', 'deleting a project from Rel.AI must never delete source files');

  // Run real async cleanup and make unrelated writes while it is suspended.
  // The cleanup's first await gives a deterministic interleaving without sleeps.
  const { readConfig, writeConfig } = await import('../src/config.js');
  const { updateDashboardWorkspace } = await import('../src/core/dashboard-runtime.ts');
  const { updateComputerControlEnabled } = await import('../src/core/computer.ts');
  const { clearSessionPolicy, writeSessionPolicy } = await import('../src/policyResolver.js');
  writeConfig({
    ...readConfig(),
    computerControl: { enabled: false },
    workspaces: { removing: { path: first }, retained: { path: second } }
  });
  const deletion = updateDashboardWorkspace({ action: 'delete', alias: 'removing', confirmDelete: true });
  const savingSetting = updateComputerControlEnabled(true);
  updateWorkspace(readConfig(), { action: 'upsert', mode: 'create', alias: 'added-during-cleanup', path: third });
  await savingSetting;
  const deletionResult = await deletion;
  assert.equal(deletionResult.ok, true);
  const afterConcurrentDelete = readConfig();
  assert.equal(afterConcurrentDelete.workspaces.removing, undefined);
  assert.equal(afterConcurrentDelete.computerControl.enabled, true, 'async project cleanup must preserve a concurrent settings save');
  assert.equal(afterConcurrentDelete.workspaces['added-during-cleanup'].path, third, 'async project cleanup must preserve a concurrently added project');
  assert.equal(afterConcurrentDelete.workspaces.retained.path, second);

  // One idle but open task still owns its alias, even with no active tool call.
  await writeSessionPolicy(afterConcurrentDelete, 'retained', { taskId: 'idle-open-task', workspaceRoot: second });
  const renamePayload = { action: 'upsert', mode: 'update', originalAlias: 'retained', alias: 'renamed', path: second };
  await assert.rejects(() => updateDashboardWorkspace(renamePayload), /Cannot rename project 'retained'.*1 Rel\.AI task is still active/,
    'renaming an active project must not strand its task ownership and controls');
  await assert.rejects(() => updateDashboardWorkspace({ action: 'delete', alias: 'retained', confirmDelete: true }), /Cannot delete project 'retained'.*1 Rel\.AI task is still active/,
    'the single idle-task policy must also protect project deletion');
  assert.equal(readConfig().workspaces.retained.path, second, 'rejected rename/delete must leave the original alias available');
  assert.equal(readConfig().workspaces.renamed, undefined);
  clearSessionPolicy(afterConcurrentDelete, 'retained', 'idle-open-task');
  const inactiveRename = await updateDashboardWorkspace(renamePayload);
  assert.equal(inactiveRename.ok, true, 'a project may be renamed after all task ownership is released');
  assert.equal(readConfig().workspaces.renamed.path, second);

  const { getTaskHistoryDir, readTaskHistorySessionRecord, recordTaskActivityEvent, flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
  const { writeSession, readSession } = await import('../src/taskHistoryStorage.ts');
  const historyDirectory = getTaskHistoryDir(readConfig());
  for (const replacement of ['repointed', 'recreated']) {
    writeConfig({ ...readConfig(), workspaces: { target: { path: first } } });
    writeSession(historyDirectory, { id: `retained-${replacement}`, workspace: 'target', status: 'completed', title: 'Retained history' });
    const removingTarget = updateDashboardWorkspace({ action: 'delete', alias: 'target', confirmDelete: true });
    if (replacement === 'recreated') updateWorkspace(readConfig(), { action: 'delete', alias: 'target', confirmDelete: true });
    updateWorkspace(readConfig(), { action: 'upsert', alias: 'target', path: second });
    await assert.rejects(() => removingTarget, /changed while.*cleanup/i,
      'a concurrent replacement must not be removed using a stale delete request');
    assert.equal(readConfig().workspaces.target.path, second, 'concurrently replaced target must remain configured');
    assert.ok(readSession(historyDirectory, `retained-${replacement}`), 'a rejected replacement race must retain history before any cleanup deletion');
  }

  const { beginConnectorToolCall, resetToolActivity, getToolActivity } = await import('../src/toolActivity.js');
  writeConfig({ ...readConfig(), workspaces: { target: { path: first } } });
  const removingActiveTarget = updateDashboardWorkspace({ action: 'delete', alias: 'target', confirmDelete: true });
  const finishActive = beginConnectorToolCall({ createTask: true, workspace: 'target', tool: 'relai_read', connector: false });
  recordTaskActivityEvent(readConfig(), {
    phase: 'started',
    task: { id: finishActive.taskId, workspace: 'target', status: 'running', title: 'Started during cleanup' },
    activityEvent: { eventId: 'started-during-cleanup', status: 'running', timestamp: new Date().toISOString() }
  }, { defer: true });
  try {
    await assert.rejects(() => removingActiveTarget, /Cannot delete project 'target'.*still active/,
      'a task started during asynchronous cleanup must block the final removal');
    assert.equal(readConfig().workspaces.target.path, first);
    assert.equal(getToolActivity().tasks.some(task => task.id === finishActive.taskId), true, 'the new task must remain controllable under its original alias');
    const retainedActive = readTaskHistorySessionRecord(readConfig(), finishActive.taskId);
    assert.equal(retainedActive?.title, 'Started during cleanup', 'rejecting deletion must retain history accepted during its flush');
    assert.ok(retainedActive.events.some(event => event.eventId === 'started-during-cleanup'), 'the new task event must not be discarded from pending history');
    await flushTaskHistoryPersistence();
    assert.equal(readSession(historyDirectory, finishActive.taskId)?.title, 'Started during cleanup', 'retained pending task history must still reach durable storage');
  } finally {
    finishActive({ ok: true });
    resetToolActivity();
    await flushTaskHistoryPersistence();
  }
} finally {
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('Workspace management unit passed');
