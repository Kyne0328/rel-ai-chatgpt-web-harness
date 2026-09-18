import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { callTool as rawCallTool } from '../src/tools.js';
import { getToolActivity, resetToolActivity } from '../src/toolActivity.js';
import { flushTaskHistoryPersistence, readTaskHistorySession } from '../src/taskHistoryStore.ts';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-plan-'));
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const stateDir = path.join(sandbox, 'state');
const configPath = path.join(sandbox, 'config.json');
const config = {
  stateDir,
  version: 7,
  workspaces: { repo: { path: sandbox, commands: {}, testCommands: {} } }
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

const context = {
  principal: 'local:trusted',
  conversationId: 'task-plan-unit',
  publicHttpOnly: false
};
const callTool = (name, args) => rawCallTool(name, args, context);

try {
  resetToolActivity();

  const started = await callTool('relai_work', {
    action: 'begin',
    workspace: 'repo',
    title: 'Task plan regression',
    objective: 'Verify durable plan creation, retries, restart recovery, and concurrent updates.'
  });
  assert.ok(started.work_id);

  const initiallyCleared = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: []
  });
  assert.equal(initiallyCleared.plan.revision, 0, 'clearing a task that never had a plan must be an idempotent no-op');
  assert.deepEqual(initiallyCleared.plan.steps, []);
  assert.equal(initiallyCleared.message, 'Task plan is unchanged.');
  assert.equal(getToolActivity().tasks.find(task => task.taskId === started.work_id || task.id === started.work_id)?.plan, undefined,
    'an initial no-op clear must not materialize empty durable plan state');

  const first = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'in_progress' },
      { id: 'validate', title: 'Run focused validation', status: 'pending' }
    ]
  });
  assert.equal(first.plan.revision, 1);
  assert.deepEqual(first.plan.steps.map(step => step.status), ['in_progress', 'pending']);

  const second = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
      { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
    ]
  });
  assert.equal(second.plan.revision, 2);
  assert.deepEqual(second.plan.steps.map(step => step.status), ['completed', 'in_progress']);

  const live = getToolActivity().tasks.find(task => task.taskId === started.work_id || task.id === started.work_id);
  assert.equal(live?.plan?.revision, 2);
  assert.deepEqual(live?.plan?.steps.map(step => step.status), ['completed', 'in_progress']);
  assert.equal(live?.progress?.mode, 'determinate');
  assert.equal(live?.progress?.completedUnits, 1);
  assert.equal(live?.progress?.totalUnits, 2);

  await callTool('relai_read', {
    workspace: 'repo',
    work_id: started.work_id,
    paths: ['config.json'],
    guidanceMode: 'none'
  });
  const afterRead = getToolActivity().tasks.find(task => task.taskId === started.work_id || task.id === started.work_id);
  assert.equal(afterRead?.progress?.source, 'task_plan', 'ordinary tool activity must not replace explicit checklist progress');
  assert.equal(afterRead?.progress?.completedUnits, 1);
  assert.equal(afterRead?.progress?.totalUnits, 2);
  assert.match(afterRead?.currentActivity || '', /Step 2 of 2: Run focused validation/);

  await flushTaskHistoryPersistence();
  const persisted = readTaskHistorySession(config, started.work_id);
  assert.equal(persisted?.plan?.revision, 2, 'the second plan snapshot must replace the first persisted snapshot');
  assert.deepEqual(persisted?.plan?.steps.map(step => step.status), ['completed', 'in_progress']);

  resetToolActivity();
  const replayed = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: second.plan.steps
  });
  assert.equal(replayed.plan.revision, 2, 'an identical retry after restart must hydrate durable state without advancing the plan revision');
  assert.equal(replayed.message, 'Task plan is unchanged.');

  const third = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
      { id: 'validate', title: 'Run focused validation', status: 'completed' }
    ]
  });
  assert.equal(third.plan.revision, 3, 'the first changed plan after restart must continue from the durable revision');

  const concurrent = await Promise.all([
    callTool('relai_work', {
      action: 'plan', workspace: 'repo', work_id: started.work_id,
      steps: [
        { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
        { id: 'validate', title: 'Run focused validation', status: 'blocked' }
      ]
    }),
    callTool('relai_work', {
      action: 'plan', workspace: 'repo', work_id: started.work_id,
      steps: [
        { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
        { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
      ]
    })
  ]);
  assert.deepEqual(concurrent.map(result => result.plan.revision).sort((left, right) => left - right), [4, 5], 'same-task plan writes must serialize instead of racing the revision');

  await flushTaskHistoryPersistence();
  resetToolActivity();
  const restored = await callTool('relai_work', { action: 'status', work_id: started.work_id });
  assert.equal(restored.task?.plan?.revision, 5, 'the last serialized plan revision must survive restart recovery');

  const cleared = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: []
  });
  assert.equal(cleared.plan.revision, 6);
  assert.deepEqual(cleared.plan.steps, []);

  await flushTaskHistoryPersistence();
  const persistedCleared = readTaskHistorySession(config, started.work_id);
  assert.equal(persistedCleared?.plan?.revision, 6);
  assert.deepEqual(persistedCleared?.plan?.steps, []);
} finally {
  resetToolActivity();
  await flushTaskHistoryPersistence().catch(() => {});
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('Durable task plan create, retry, restart, concurrency, restore, and clear tests passed.');
