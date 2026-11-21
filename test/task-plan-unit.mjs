import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { openStateDatabase } from '../src/stateDatabase.ts';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { callTool as rawCallTool } from '../src/tools.js';
import { getToolActivity, resetToolActivity } from '../src/toolActivity.js';
import { flushTaskHistoryPersistence, readTaskHistorySession } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { readTaskIntegrity } from '../src/taskIntegrity.ts';
import { applyTaskProgressPatch } from '../src/tools/taskProgress.js';

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

  // Each client exits immediately after its public response, without flushing
  // the service's deferred activity queue. The next client uses only SQLite.
  const planClient = path.join(sandbox, 'plan-client.mjs');
  fs.writeFileSync(planClient, `
    import { callTool } from ${JSON.stringify(new URL('../src/tools.js', import.meta.url).href)};
    const args = JSON.parse(process.argv[2]);
    try {
      const result = await callTool('relai_work', { workspace: 'repo', ...args }, { principal: 'local:trusted', publicHttpOnly: true });
      console.log(JSON.stringify({ ok: result.ok, id: result.work_id, plan: result.plan || result.task?.plan, message: result.message, code: result.errorCode }));
    } catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }
    process.exit(0);
  `);
  const fresh = args => JSON.parse(execFileSync(process.execPath, [planClient, JSON.stringify(args)],
    { encoding: 'utf8', timeout: 15000 }).trim());
  const initialSteps = [{ id: 'inspect', title: 'Inspect crash boundary', status: 'pending' }];
  const updatedSteps = [{ ...initialSteps[0], status: 'completed' }];
  const created = fresh({ action: 'begin', title: 'Crash boundary fixture', bootstrap: 'none', steps: initialSteps });
  assert.equal(created.plan.revision, 1);
  assert.deepEqual(fresh({ action: 'status', work_id: created.id }).plan, created.plan,
    'begin must recover its acknowledged initial plan in a new process');
  const planArgs = { action: 'plan', work_id: created.id, steps: updatedSteps };
  const db = openStateDatabase(config);
  try {
    db.exec("CREATE TRIGGER reject_new_plan BEFORE UPDATE ON task_history WHEN json_extract(NEW.payload,'$.plan.revision') > 1 BEGIN SELECT RAISE(ABORT,'fixture failed plan update'); END");
    assert.equal(fresh(planArgs).ok, false, 'a refused durable update cannot be reported as successful');
    assert.deepEqual(fresh({ action: 'status', work_id: created.id }).plan, created.plan);
    db.exec('DROP TRIGGER reject_new_plan');
    const saved = fresh(planArgs);
    assert.equal(saved.plan.revision, 2);
    assert.deepEqual(fresh({ action: 'status', work_id: created.id }).plan, saved.plan,
      'plan replacement must survive immediate exit without a graceful flush');
    const retry = fresh(planArgs);
    assert.deepEqual(retry.plan, saved.plan, 'retrying a recovered terminal step must not advance its revision');
    assert.equal(retry.message, 'Task plan is unchanged.');
  } finally { db.close(); }

  resetToolActivity();

  const started = await callTool('relai_work', { mode: 'normal',
    action: 'begin',
    workspace: 'repo',
    title: 'Task plan regression',
    objective: 'Verify durable plan creation, retries, restart recovery, and concurrent updates.',
    steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'pending' },
      { id: 'validate', title: 'Run focused validation', status: 'pending' }
    ]
  });
  assert.ok(started.work_id);
  assert.equal(started.plan?.revision, 1, 'begin must establish the initial durable plan atomically with task identity');
  assert.equal(readTaskIntegrity(config, started.work_id, 'repo')?.baseline?.pending, true,
    'begin must keep repository baseline capture deferred until a mutation or validation boundary actually needs it');

  const first = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'in_progress' },
      { id: 'validate', title: 'Run focused validation', status: 'pending' }
    ]
  });
  assert.equal(first.plan.revision, 2);
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
  assert.equal(second.plan.revision, 3);
  assert.deepEqual(second.plan.steps.map(step => step.status), ['completed', 'in_progress']);

  const live = getToolActivity().tasks.find(task => task.taskId === started.work_id || task.id === started.work_id);
  assert.equal(live?.plan?.revision, 3);
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
  assert.equal(readTaskIntegrity(config, started.work_id, 'repo')?.baseline?.pending, true,
    'ordinary read observation must not trigger the repository ownership baseline');
  const afterRead = getToolActivity().tasks.find(task => task.taskId === started.work_id || task.id === started.work_id);
  assert.equal(afterRead?.progress?.source, 'task_plan', 'ordinary tool activity must not replace explicit checklist progress');
  assert.equal(afterRead?.progress?.completedUnits, 1);
  assert.equal(afterRead?.progress?.totalUnits, 2);
  assert.match(afterRead?.currentActivity || '', /Step 2 of 2: Run focused validation/);

  await flushTaskHistoryPersistence();
  const persisted = readTaskHistorySession(config, started.work_id);
  assert.equal(persisted?.plan?.revision, 3, 'the second plan snapshot must replace the first persisted snapshot');
  assert.deepEqual(persisted?.plan?.steps.map(step => step.status), ['completed', 'in_progress']);

  resetToolActivity();
  const replayed = await callTool('relai_work', {
    action: 'plan',
    workspace: 'repo',
    work_id: started.work_id,
    steps: second.plan.steps
  });
  assert.equal(replayed.plan.revision, 3, 'an identical retry after restart must hydrate durable state without advancing the plan revision');
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
  assert.equal(third.plan.revision, 4, 'the first changed plan after restart must continue from the durable revision');

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
  assert.deepEqual(concurrent.map(result => result.plan.revision).sort((left, right) => left - right), [5, 6], 'same-task plan writes must serialize instead of racing the revision');

  await flushTaskHistoryPersistence();
  resetToolActivity();
  const restored = await callTool('relai_work', { action: 'status', work_id: started.work_id });
  assert.equal(restored.task?.plan?.revision, 6, 'the last serialized plan revision must survive restart recovery');

  const piggybackTask = await callTool('relai_work', { mode: 'normal',
    action: 'begin', workspace: 'repo', title: 'Piggyback plan regression', objective: 'Update plan state without separate plan calls.',
    steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'pending' },
      { id: 'validate', title: 'Validate implementation', status: 'pending' }
    ]
  });
  await callTool('relai_read', {
    workspace: 'repo', work_id: piggybackTask.work_id, paths: ['config.json'], guidanceMode: 'none',
    taskProgress: { id: 'inspect', status: 'in_progress' }
  });
  let piggybackLive = getToolActivity().tasks.find(task => task.taskId === piggybackTask.work_id || task.id === piggybackTask.work_id);
  assert.equal(piggybackLive?.plan?.revision, 2, 'ordinary task calls must advance an existing durable checklist');
  assert.deepEqual(piggybackLive?.plan?.steps.map(step => step.status), ['in_progress', 'pending']);
  await callTool('relai_read', {
    workspace: 'repo', work_id: piggybackTask.work_id, paths: ['config.json'], guidanceMode: 'none',
    taskProgress: { id: 'inspect', status: 'completed', detail: 'Inspection complete.' }
  });
  piggybackLive = getToolActivity().tasks.find(task => task.taskId === piggybackTask.work_id || task.id === piggybackTask.work_id);
  assert.equal(piggybackLive?.plan?.revision, 3, 'piggybacked step transitions must advance the durable plan revision');
  assert.deepEqual(piggybackLive?.plan?.steps.map(step => step.status), ['completed', 'pending']);

  await callTool('relai_work', {
    action: 'finish', workspace: 'repo', work_id: piggybackTask.work_id,
    summary: 'Piggyback plan regression completed.'
  });
  await flushTaskHistoryPersistence();
  const terminalPiggyback = readTaskHistorySession(config, piggybackTask.work_id);
  assert.equal(terminalPiggyback?.status, 'completed');
  assert.equal(terminalPiggyback?.plan?.revision, 4, 'terminal reconciliation must advance the plan revision once when unresolved steps remain');
  assert.deepEqual(terminalPiggyback?.plan?.steps.map(step => step.status), ['completed', 'skipped'],
    'a completed task must not persist pending, in-progress, or blocked checklist state');
  assert.match(terminalPiggyback?.plan?.steps[1]?.detail || '', /completed before this step reported a terminal outcome/i,
    'terminal reconciliation must preserve that an unresolved step was not explicitly reported as completed');

  const finishProgressTask = await callTool('relai_work', { mode: 'normal',
    action: 'begin', workspace: 'repo', title: 'Finish progress regression', objective: 'Finalize the last checklist step without a separate plan call.',
    steps: [{ id: 'finish', title: 'Finish the task', status: 'in_progress' }]
  });
  await callTool('relai_work', {
    action: 'finish', workspace: 'repo', work_id: finishProgressTask.work_id,
    summary: 'Finish progress regression completed.',
    taskProgress: { id: 'finish', status: 'completed' }
  });
  await flushTaskHistoryPersistence();
  const terminalFinishProgress = readTaskHistorySession(config, finishProgressTask.work_id);
  assert.equal(terminalFinishProgress?.status, 'completed');
  assert.equal(terminalFinishProgress?.plan?.revision, 2, 'finish must apply its final progress patch before terminal reconciliation');
  assert.deepEqual(terminalFinishProgress?.plan?.steps.map(step => step.status), ['completed'],
    'finish must preserve an explicitly completed final step instead of converting it to skipped');

  await assert.rejects(
    () => callTool('relai_work', { action: 'plan', workspace: 'repo', work_id: started.work_id, steps: [] }),
    /steps|item|empty/i,
    'durable task plans must not be clearable to an empty state'
  );

  const projectless = await callTool('relai_work', { mode: 'normal',
    action: 'begin', title: 'Projectless planning regression', objective: 'Inspect a project after it is selected.',
    steps: [{ id: 'inspect', title: 'Inspect the selected project', status: 'in_progress' }]
  });
  assert.ok(projectless.plan?.steps?.length > 0, 'projectless durable goals still carry a plan');
  await callTool('relai_read', { workspace: 'repo', work_id: projectless.work_id, paths: ['config.json'], guidanceMode: 'none' });

  await flushTaskHistoryPersistence();
  const persistedFinal = readTaskHistorySession(config, started.work_id);
  assert.equal(persistedFinal?.plan?.revision, 6);
  assert.ok(persistedFinal?.plan?.steps?.length > 0);

  // A different writer may hold the same database even after this task's
  // pending history is drained. Release it from a service timer so a
  // synchronous busy wait cannot pass this test.
  const writer = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => { db.exec('ROLLBACK'); db.close(); });
  `, { eval: true, execArgv: [], workerData: path.join(stateDir, 'durable-state.sqlite') });
  try {
    assert.deepEqual(await once(writer, 'message', { signal: AbortSignal.timeout(5000) }), ['locked']);
    const controller = new AbortController();
    const abortReason = new Error('Stop retrying a busy plan save');
    const publications = [];
    const apply = options => applyTaskProgressPatch(config, projectless.work_id,
      { id: 'inspect', status: 'completed' }, data => publications.push(data.plan), options);
    const abortTimer = setTimeout(() => controller.abort(abortReason), 40);
    try {
      await assert.rejects(apply({ signal: controller.signal }), error => error === abortReason);
      assert.deepEqual(publications, [], 'abort must not publish a revision');
    } finally {
      clearTimeout(abortTimer);
    }
    const release = setTimeout(() => writer.postMessage('release'), 60);
    try {
      const saved = await apply({});
      assert.equal(saved.plan.revision, projectless.plan.revision + 1);
      assert.deepEqual(publications, [saved.plan], 'a transient lock must publish only the committed revision');
      assert.deepEqual(readTaskHistorySession(config, projectless.work_id).plan, saved.plan);
    } finally {
      clearTimeout(release);
    }
  } finally {
    await writer.terminate();
  }
} finally {
  await flushAuditWrites().catch(() => {});
  await flushTaskHistoryPersistence().catch(() => {});
  await flushLocalAnalytics().catch(() => {});
  await repositoryIntelligence.shutdown().catch(() => {});
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log('Durable task plan create, retry, restart, concurrency, restore, and clear tests passed.');
