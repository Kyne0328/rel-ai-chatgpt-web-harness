import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversationUrl, activeMessages, turnState, findRecentGoalCommand, findGoalConversation, stopStalledTurn, sendContinue, configureGoalBrowserTransport, hasGoalBrowserTransport, getConversation } from '../src/chatgptGoalProtocol.js';
import { activateGoal, queueGoalDetection, checkGoalDetection, resolvedGoalPlan, unfinishedTurnUpdate, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal, resumeAuthenticatedGoals, pollGoal, startGoalMonitor, stopGoalMonitor } from '../src/chatgptGoalMode.js';
import { getToolSchemas } from '../src/tools/schema.js';
import { withStateDatabase, stateDatabasePath } from '../src/stateDatabase.ts';
import { DatabaseSync } from 'node:sqlite';
import { beginConnectorToolCall, getToolActivity, resetToolActivity, runWithToolActivity, requestCurrentTaskCancellation, onToolActivity } from '../src/toolActivity.js';
import { recordTaskActivityEvent, clearTaskHistory } from '../src/taskHistoryStore.ts';

const ID = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
const OTHER = 'ca32ef5a-77b0-49f0-983d-b39c12c45ff2';
const credentials = { bearer: 'placeholder', cookie: 'session=fake' };

function response(payload) {
  return { ok: true, json: async () => payload, text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

function emptyProjectCatalogue(url) {
  return url.includes('/gizmos/snorlax/sidebar') ? response({ items: [], cursor: null }) : null;
}

function conversation(id, goalText = '/goal Fix the current project') {
  return {
    conversation_id: id, current_node: 'a',
    mapping: {
      root: { parent: null, message: null },
      u: { parent: 'root', message: { id: 'user-1', author: { role: 'user' }, create_time: Date.now() / 1000, content: { parts: [goalText] } } },
      a: { parent: 'u', message: { id: 'assistant-1', author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Working'] }, end_turn: true, status: 'finished_successfully' } },
      unrelated: { parent: 'root', message: { id: 'unrelated', author: { role: 'assistant' },
        content: { parts: ['Wrong branch'] }, end_turn: true } }
    }
  };
}

function conversationWithReceipt(id, workId, goalText = '/goal start now') {
  const tree = conversation(id, goalText);
  tree.mapping.receipt = { parent: 'u', message: { id: 'tool-receipt', author: { role: 'tool' },
    content: { parts: [JSON.stringify({ ok: true, work_id: workId })] } } };
  tree.mapping.a.parent = 'receipt';
  return tree;
}

async function withMonitoredGoal(t, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-monitor-'));
  const config = { stateDir: dir, workspaces: {} };
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 1_000 });
  resetToolActivity();
  const unsubscribe = onToolActivity(activity => recordTaskActivityEvent(config, activity));
  const begin = beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin',
    createTask: true, scopeId: 'goal-monitor-fixture', input: { title: 'Monitor fixture' } });
  begin({ ok: true });
  const work_id = begin.taskId;
  const context = { principal: 'monitor-fixture', requestTaskContext: {
    session: getToolActivity().tasks.find(task => task.id === work_id) } };
  activateGoal(config, { work_id, objective: 'Complete monitor fixture',
    conversationUrl: 'https://chatgpt.com/c/' + ID }, context);
  const patchGoal = patch => withStateDatabase(config, db => {
    const key = 'chatgpt_goal:' + work_id;
    const goal = JSON.parse(db.prepare('SELECT value FROM state_meta WHERE key=?').get(key).value);
    db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify({ ...goal, ...patch }), key);
  }, { transaction: true });
  patchGoal({ observedNode: 'a', stableSince: Date.now() - 100_000 });
  const tree = conversation(ID);
  const calls = [];
  let onRead = () => {};
  let onStop = () => { tree.mapping.a.message.status = 'interrupted'; };
  const deps = { nativeTransport: async payload => {
    calls.push(payload);
    if (payload.action === 'continue') return { ok: true, accepted: true };
    if (payload.action === 'stop_stalled') { onStop(); return { ok: true, stopped: true }; }
    onRead();
    return { ok: true, data: structuredClone(tree) };
  } };
  const task = () => getToolActivity().tasks.find(item => item.id === work_id);
  const status = () => goalStatus(config, { work_id }, context);
  const unfinished = () => {
    tree.mapping.a.message.end_turn = false;
    tree.mapping.a.message.status = 'in_progress';
    t.mock.timers.tick(300_000);
    patchGoal({ unfinishedTurnId: 'user-1', unfinishedTaskCalls: task().calls,
      unfinishedProgressAt: task().lastActivityAt });
  };
  try {
    await run({ config, work_id, context, tree, calls, deps, task, status, patchGoal, unfinished,
      onRead: callback => { onRead = callback; }, onStop: callback => { onStop = callback; } });
  } finally {
    unsubscribe();
    resetToolActivity();
    t.mock.timers.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('monitor continues an interrupted turn without pressing Stop again', async t => {
  await withMonitoredGoal(t, async f => {
    f.tree.mapping.a.message.end_turn = false;
    f.tree.mapping.a.message.status = 'interrupted';
    await pollGoal(f.config, f.work_id, f.deps);
    assert.deepEqual(f.calls.filter(call => call.action).map(call => call.action), ['continue']);
    assert.match(f.calls.at(-1).prompt, new RegExp(f.work_id));
    assert.match(f.calls.at(-1).prompt, /Complete monitor fixture/);
    assert.equal(f.status().continuationCount, 1);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 1,
      'the same claimed branch must never receive another send');
  });
});

test('monitor rechecks task activity after its final conversation read', async t => {
  await withMonitoredGoal(t, async f => {
    let reads = 0;
    let operation;
    f.onRead(() => {
      if (++reads === 2) operation = beginConnectorToolCall({ tool: 'relai_read',
        internalOperation: 'read', taskId: f.work_id, scopeId: 'goal-monitor-fixture' });
    });
    try {
      await pollGoal(f.config, f.work_id, f.deps);
      assert.equal(f.calls.filter(call => call.action === 'continue').length, 0,
        'a new running operation must prevent a continuation');
      assert.notEqual(f.status().state, 'sending');
    } finally { operation?.({ ok: true }); }
  });
});

test('task cancellation aborts a browser continuation that has not submitted yet', async t => {
  await withMonitoredGoal(t, async f => {
    let attempted = false;
    let aborted = false;
    const transport = f.deps.nativeTransport;
    await pollGoal(f.config, f.work_id, { nativeTransport: async (payload, options) => {
      if (payload.action === 'continue') {
        attempted = true;
        runWithToolActivity({ taskId: f.work_id }, () => requestCurrentTaskCancellation());
        aborted = options.signal.aborted;
        options.signal.throwIfAborted();
      }
      return transport(payload);
    } });
    assert.equal(attempted, true);
    assert.equal(aborted, true, 'cancellation must reach the native sender before Send');
    assert.equal(f.status().continuationCount, 0);
    assert.equal(f.status().state, 'cancelled');
  });
});

test('confirmed unsent continuations get five durable retries and then pause', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ continuationCount: 1, sentTaskCalls: 0 });
    const transport = f.deps.nativeTransport;
    let attempts = 0;
    const deps = { nativeTransport: async payload => {
      if (payload.action === 'continue') {
        attempts++;
        return { ok: false, notSent: true, stage: 'navigation', reason: 'conversation_unavailable' };
      }
      return transport(payload);
    } };
    for (let i = 0; i < 6; i++) {
      const failedAt = Date.now();
      await pollGoal(f.config, f.work_id, deps);
      assert.equal(attempts, i + 1);
      if (i < 5) {
        assert.equal(f.status().state, 'retrying');
        assert.equal(f.status().goalActive, true);
        await pollGoal(f.config, f.work_id, deps);
        assert.equal(attempts, i + 1, 'retry deadline must prevent an immediate repeat');
        const delay = [5_000, 5_000, 10_000, 15_000, 20_000][i];
        assert.equal(f.status().nextAttemptAt - failedAt, delay);
        t.mock.timers.tick(delay);
      }
    }
    assert.equal(f.status().retryCount, 5);
    assert.equal(f.status().goalActive, false);
    assert.equal(f.status().state, 'paused');
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(attempts, 6, 'exhausted goals must stay stopped');
    activateGoal(f.config, { work_id: f.work_id, objective: 'Complete monitor fixture' }, f.context);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().continuationCount, 2, 'explicit restart can recover a confirmed unsent branch');
    assert.equal(f.status().retryCount, 0);
  });
});

test('persisted five-second retry wakes independently of the ordinary monitor cadence', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    let sends = 0;
    const transport = f.deps.nativeTransport;
    configureGoalBrowserTransport(async payload => {
      if (payload.action === 'continue' && ++sends === 1) return { ok: false, notSent: true, reason: 'send_unavailable' };
      return transport(payload);
    });
    try {
      await pollGoal(f.config, f.work_id);
      assert.equal(sends, 1);
      startGoalMonitor(f.config); // Restores an existing durable retry deadline.
      t.mock.timers.tick(4_999);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sends, 1);
      t.mock.timers.tick(1);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sends, 2, 'a five-second deadline must not wait for the 30-second monitor poll');
      assert.equal(f.status().continuationCount, 1);
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

test('a recovered read returns to ordinary monitoring without an overdue retry loop', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    let reads = 0;
    configureGoalBrowserTransport(async () => {
      if (++reads === 1) throw new Error('Temporary read failure');
      return { ok: true, data: structuredClone(f.tree) };
    });
    f.patchGoal({ observedNode: 'earlier-node', stableSince: 0 });
    try {
      await pollGoal(f.config, f.work_id);
      startGoalMonitor(f.config);
      t.mock.timers.tick(5_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 2);
      assert.equal(f.status().state, 'monitoring');
      for (let i = 0; i < 10; i++) {
        t.mock.timers.tick(1_000);
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(reads, 2, 'successful observation must not keep waking an expired retry');
      assert.equal(f.status().nextAttemptAt, undefined);
      t.mock.timers.tick(15_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 3, 'the ordinary monitor must still observe the conversation');
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

for (const trigger of ['interval', 'retry']) {
  test('Goal background ' + trigger + ' survives a locked observation save and retries after unlock', async t => {
    await withMonitoredGoal(t, async f => {
      const now = Date.now();
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
      f.patchGoal({ observedNode: 'earlier-node', stableSince: 0,
        ...(trigger === 'retry' ? { nextAttemptAt: now + 5_000 } : {}) });
      const writer = new DatabaseSync(stateDatabasePath(f.config));
      let locked = false;
      let reads = 0;
      configureGoalBrowserTransport(async () => {
        reads += 1;
        if (reads === 1) { writer.exec('BEGIN IMMEDIATE'); locked = true; }
        return { ok: true, data: structuredClone(f.tree) };
      });
      try {
        startGoalMonitor(f.config);
        t.mock.timers.tick(trigger === 'retry' ? 5_000 : 30_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(reads, 1);
        assert.equal(f.status().continuationCount, 0);
        const saved = JSON.parse(writer.prepare('SELECT value FROM state_meta WHERE key=?')
          .get('chatgpt_goal:' + f.work_id).value);
        assert.equal(saved.observedNode, 'earlier-node', 'failed observation and error saves must preserve durable state');
        writer.exec('ROLLBACK'); locked = false;
        t.mock.timers.tick(5_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(reads, 2, 'a memory-only retry must run before the ordinary monitor cadence');
        assert.equal(f.status().state, 'monitoring');
        assert.equal(f.status().continuationCount, 0);
      } finally {
        if (locked) writer.exec('ROLLBACK');
        writer.close();
        stopGoalMonitor();
        configureGoalBrowserTransport(null);
      }
    });
  });
}

test('Goal background retry reconciles an accepted send when receipt persistence was locked', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    const writer = new DatabaseSync(stateDatabasePath(f.config));
    let locked = false;
    let sends = 0;
    configureGoalBrowserTransport(async payload => {
      if (payload.action === 'continue') {
        sends += 1;
        writer.exec('BEGIN IMMEDIATE'); locked = true;
        const saved = JSON.parse(writer.prepare('SELECT value FROM state_meta WHERE key=?')
          .get('chatgpt_goal:' + f.work_id).value);
        f.tree.mapping.continuation = { parent: 'a', message: { id: 'continuation-receipt',
          author: { role: 'user' }, content: { parts: [saved.pendingPrompt] } } };
        f.tree.current_node = 'continuation';
        return { ok: true, accepted: true };
      }
      return { ok: true, data: structuredClone(f.tree) };
    });
    try {
      startGoalMonitor(f.config);
      t.mock.timers.tick(30_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sends, 1);
      assert.equal(f.status().continuationCount, 0);
      writer.exec('ROLLBACK'); locked = false;
      t.mock.timers.tick(5_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sends, 1, 'uncertain durable claim must be reconciled without resending');
      assert.equal(f.status().continuationCount, 1);
      t.mock.timers.tick(30_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sends, 1);
    } finally {
      if (locked) writer.exec('ROLLBACK');
      writer.close();
      stopGoalMonitor();
      configureGoalBrowserTransport(null);
    }
  });
});

test('automatic detection recovers from locked success and error saves without an unhandled rejection', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    const writer = new DatabaseSync(stateDatabasePath(f.config));
    const workId = 'locked-automatic-detection';
    let locked = false;
    let reads = 0;
    const deps = { task: { status: 'running' }, nativeTransport: async () => {
      if (++reads === 1) { writer.exec('BEGIN IMMEDIATE'); locked = true; }
      return { ok: true, data: conversationWithReceipt(ID, workId) };
    } };
    const context = { connector: true, conversationId: ID, principal: 'monitor-fixture' };
    try {
      queueGoalDetection(f.config, { work_id: workId, title: 'Locked detection' }, context, deps);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 1);
      assert.equal(goalStatus(f.config, { work_id: workId }, context).state, 'checking');
      writer.exec('ROLLBACK'); locked = false;
      t.mock.timers.tick(5_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 2);
      assert.equal(goalStatus(f.config, { work_id: workId }, context).state, 'monitoring');
    } finally {
      if (locked) writer.exec('ROLLBACK');
      writer.close();
      stopGoalMonitor();
    }
  });
});

test('Stop cancels a storage-independent Goal retry before another account read', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    f.patchGoal({ observedNode: 'earlier-node', stableSince: 0 });
    const writer = new DatabaseSync(stateDatabasePath(f.config));
    let locked = false;
    let reads = 0;
    configureGoalBrowserTransport(async () => {
      reads += 1;
      writer.exec('BEGIN IMMEDIATE'); locked = true;
      return { ok: true, data: f.tree };
    });
    try {
      startGoalMonitor(f.config);
      t.mock.timers.tick(30_000);
      await new Promise(resolve => setImmediate(resolve));
      writer.exec('ROLLBACK'); locked = false;
      stopGoal(f.config, { work_id: f.work_id }, f.context);
      t.mock.timers.tick(60_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reads, 1);
      assert.equal(f.status().state, 'stopped');
    } finally {
      if (locked) writer.exec('ROLLBACK');
      writer.close();
      stopGoalMonitor();
      configureGoalBrowserTransport(null);
    }
  });
});

test('transportless runtimes leave desktop goal progress and retry deadlines untouched', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    f.patchGoal({ tunnelId: 'tunnel_accountA12345', state: 'verifying', retryCount: 2,
      nextAttemptAt: now + 5_000, pendingNode: 'a', pendingOutcome: 'uncertain',
      pendingPrompt: 'Original unverified continuation' });
    const readRecord = () => withStateDatabase(f.config, db => db.prepare(
      'SELECT value FROM state_meta WHERE key=?').get('chatgpt_goal:' + f.work_id).value,
    { readonly: true });
    const original = readRecord();
    configureGoalBrowserTransport(null);
    try {
      startGoalMonitor(f.config);
      t.mock.timers.tick(30_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(readRecord(), original, 'a secondary runtime must not consume another transport\'s retry');
      await pollGoal(f.config, f.work_id, { env: {} });
      await pollGoal(f.config, f.work_id, { credentials, fetch: async () => {
        assert.fail('process credentials cannot access a native account-scoped goal');
      } });
      assert.equal(readRecord(), original, 'unavailable transport is not an authentication failure');
      configureGoalBrowserTransport(async () => ({ ok: false, status: 401 }));
      t.mock.timers.tick(30_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.status().authRequired, true, 'an actual owner-transport authentication failure remains actionable');
      assert.equal(f.status().retryCount, 3);
      assert.equal(JSON.parse(readRecord()).pendingPrompt, 'Original unverified continuation');
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

test('transportless runtimes leave queued desktop goal detection for its native owner', async t => {
  await withMonitoredGoal(t, async f => {
    const context = { connector: true, conversationId: ID,
      principal: { clientId: 'secure-tunnel:tunnel_accountA12345' } };
    const begin = beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin',
      createTask: true, scopeId: 'transportless-lookup', input: { title: 'Transport owner lookup' } });
    begin({ ok: true });
    const task = { work_id: begin.taskId, objective: 'Detect goal on the native owner' };
    configureGoalBrowserTransport(null);
    queueGoalDetection(f.config, task, context, { env: {} });
    await new Promise(resolve => setImmediate(resolve));
    await checkGoalDetection(f.config, task.work_id, { credentials, fetch: async () => {
      assert.fail('unrelated credentials cannot run native-account discovery');
    } });
    assert.equal(goalStatus(f.config, task, context).state, 'checking');
    assert.equal(goalStatus(f.config, task, context).attempts, 0);
    await checkGoalDetection(f.config, task.work_id, {
      nativeTransport: async () => ({ ok: false, status: 401 })
    });
    assert.equal(goalStatus(f.config, task, context).state, 'needs_auth');
    stopGoal(f.config, task, context);
  });
});

test('a scoped goal routes every browser read and Send through its authenticated tunnel', async t => {
  await withMonitoredGoal(t, async f => {
    const tunnelId = 'tunnel_accountA12345';
    f.patchGoal({ tunnelId });
    await pollGoal(f.config, f.work_id, f.deps);
    assert.ok(f.calls.length > 2);
    assert.equal(f.calls.every(call => call.tunnelId === tunnelId), true);
    assert.equal(f.status().tunnelId, tunnelId);
  });
});

test('verified sign-in resumes only its own authentication waits and preserves Stop and uncertain intent', async t => {
  await withMonitoredGoal(t, async f => {
    const tunnelId = 'tunnel_accountA12345';
    f.patchGoal({ tunnelId, active: false, state: 'needs_auth', authRequired: true, retryCount: 5,
      pendingNode: 'a', pendingOutcome: 'uncertain', pendingPrompt: 'Continue goal exact original attempt' });
    assert.deepEqual(resumeAuthenticatedGoals(f.config, 'tunnel_accountB12345').resumedWorkIds, []);
    assert.equal(f.status().goalActive, false);
    assert.deepEqual(resumeAuthenticatedGoals(f.config, tunnelId).resumedWorkIds, [f.work_id]);
    assert.equal(f.status().retryCount, 0);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().state, 'verifying');
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0, 'reauthentication must never replay uncertain intent');
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    assert.deepEqual(resumeAuthenticatedGoals(f.config, tunnelId).resumedWorkIds, []);
    assert.equal(f.status().state, 'stopped');
  });
});

test('sign-in refresh supersedes an in-flight obsolete authentication failure', async t => {
  await withMonitoredGoal(t, async f => {
    const tunnelId = 'tunnel_accountA12345';
    f.patchGoal({ tunnelId, authRequired: true, retryCount: 5 });
    const transport = f.deps.nativeTransport;
    await pollGoal(f.config, f.work_id, { nativeTransport: async (payload, options) => {
      if (payload.action === 'continue') {
        resumeAuthenticatedGoals(f.config, tunnelId);
        options.signal.throwIfAborted();
      }
      return transport(payload);
    } });
    assert.equal(f.status().state, 'monitoring');
    assert.equal(f.status().goalActive, true);
    assert.equal(f.status().retryCount, 0, 'late cancellation must not exhaust the refreshed retry budget');
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().state, 'verifying', 'the prepared attempt remains uncertain until receipt reconciliation');
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
  });
});

test('sign-in retries an unconfirmed slash-goal lookup without reviving a stopped lookup', async t => {
  await withMonitoredGoal(t, async f => {
    const tunnelId = 'tunnel_accountA12345';
    const principal = { clientId: 'secure-tunnel:' + tunnelId };
    const context = { connector: true, conversationId: ID, principal };
    const begin = beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin',
      createTask: true, scopeId: 'authentication-lookup', input: { title: 'Authentication lookup' } });
    begin({ ok: true });
    const task = { work_id: begin.taskId, objective: 'Resume slash goal after sign-in' };
    const unavailable = { nativeTransport: async () => ({ ok: false, status: 401 }) };
    queueGoalDetection(f.config, task, context, unavailable);
    await checkGoalDetection(f.config, task.work_id, unavailable);
    assert.equal(goalStatus(f.config, task, context).state, 'needs_auth');
    assert.deepEqual(resumeAuthenticatedGoals(f.config, 'tunnel_accountB12345').resumedDetectionWorkIds, []);
    assert.deepEqual(resumeAuthenticatedGoals(f.config, tunnelId).resumedDetectionWorkIds, [task.work_id]);
    await checkGoalDetection(f.config, task.work_id, { nativeTransport: async payload => {
      assert.equal(payload.tunnelId, tunnelId);
      return { ok: true, data: conversation(ID) };
    } });
    assert.equal(goalStatus(f.config, task, context).goalActive, true);
    stopGoal(f.config, task, context);
    const other = beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin',
      createTask: true, scopeId: 'stopped-authentication-lookup', input: { title: 'Stopped authentication lookup' } });
    other({ ok: true });
    const stoppedTask = { ...task, work_id: other.taskId };
    queueGoalDetection(f.config, stoppedTask, context, unavailable);
    await checkGoalDetection(f.config, stoppedTask.work_id, unavailable);
    assert.equal(stopGoal(f.config, stoppedTask, context).state, 'stopped');
    assert.deepEqual(resumeAuthenticatedGoals(f.config, tunnelId).resumedDetectionWorkIds, []);
    assert.equal(goalStatus(f.config, stoppedTask, context).state, 'stopped');
  });
});

test('uncertain submissions reconcile their exact receipt without another Send', async t => {
  await withMonitoredGoal(t, async f => {
    const transport = f.deps.nativeTransport;
    let prompt;
    let sends = 0;
    const deps = { nativeTransport: async payload => {
      if (payload.action === 'continue') {
        sends++;
        prompt = payload.prompt;
        return { ok: false, uncertain: true, stage: 'readback' };
      }
      return transport(payload);
    } };
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.status().state, 'verifying');
    // Explicit activation must retain uncertain intent across restart.
    activateGoal(f.config, { work_id: f.work_id, objective: 'Updated objective after the uncertain attempt' }, f.context);
    f.tree.mapping.sent = { parent: 'a', message: { id: 'receipt', author: { role: 'user' }, content: { parts: [prompt] } } };
    f.tree.current_node = 'sent';
    t.mock.timers.tick(30_000);
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(sends, 1);
    assert.equal(f.status().continuationCount, 1);
    assert.equal(f.status().state, 'monitoring');
  });
});

test('stopped uncertain goals reject rebinding and reconcile on their original conversation', async t => {
  await withMonitoredGoal(t, async f => {
    const transport = f.deps.nativeTransport;
    let prompt;
    const deps = { nativeTransport: async payload => {
      if (payload.action === 'continue') {
        prompt = payload.prompt;
        return { ok: false, uncertain: true, stage: 'readback' };
      }
      return transport(payload);
    } };
    await pollGoal(f.config, f.work_id, deps);
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    const readRecord = () => withStateDatabase(f.config, db => db.prepare(
      'SELECT value FROM state_meta WHERE key=?').get('chatgpt_goal:' + f.work_id).value,
    { readonly: true });
    const stopped = readRecord();
    assert.throws(() => activateGoal(f.config, { work_id: f.work_id, objective: 'Complete monitor fixture',
      conversationUrl: 'https://chatgpt.com/c/' + OTHER }, f.context), /receipt is unresolved/);
    assert.equal(readRecord(), stopped, 'a rejected rebind preserves the original conversation and uncertain receipt');
    activateGoal(f.config, { work_id: f.work_id, objective: 'Complete monitor fixture' }, f.context);
    f.tree.mapping.sent = { parent: 'a', message: { id: 'receipt',
      author: { role: 'user' }, content: { parts: [prompt] } } };
    f.tree.current_node = 'sent';
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.status().continuationCount, 1, 'the original receipt remains reconcilable after restart');
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    activateGoal(f.config, { work_id: f.work_id, objective: 'Complete monitor fixture',
      conversationUrl: 'https://chatgpt.com/c/' + OTHER }, f.context);
    const rebound = JSON.parse(readRecord());
    assert.equal(rebound.conversationId, OTHER);
    assert.equal(rebound.pendingNode, '', 'resolved receipt identity must not cross conversations');
    assert.equal(rebound.pendingPrompt, '');
    assert.equal(rebound.observedNode, '');
    assert.equal(rebound.stableSince, 0);
  });
});

test('unverified sends exhaust five receipt checks without replaying the message', async t => {
  await withMonitoredGoal(t, async f => {
    const transport = f.deps.nativeTransport;
    let sends = 0;
    const deps = { nativeTransport: async payload => {
      if (payload.action === 'continue') { sends++; throw new Error('Native response was lost.'); }
      return transport(payload);
    } };
    await pollGoal(f.config, f.work_id, deps);
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(30_000);
      await pollGoal(f.config, f.work_id, deps);
    }
    assert.equal(f.status().goalActive, false);
    assert.equal(f.status().retryCount, 5);
    assert.equal(sends, 1, 'absence of a receipt never proves it is safe to resend');
    activateGoal(f.config, { work_id: f.work_id, objective: 'Complete monitor fixture' }, f.context);
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(sends, 1, 'explicit restart still preserves uncertain send intent');
  });
});

test('read failures preserve accepted branch claims and Stop Goal wins against late receipts', async t => {
  await withMonitoredGoal(t, async f => {
    await pollGoal(f.config, f.work_id, f.deps);
    await pollGoal(f.config, f.work_id, { nativeTransport: async () => { throw new Error('Temporary read failure'); } });
    t.mock.timers.tick(30_000);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 1);
  });
  await withMonitoredGoal(t, async f => {
    const transport = f.deps.nativeTransport;
    await pollGoal(f.config, f.work_id, { nativeTransport: async payload => {
      if (payload.action === 'continue') stopGoal(f.config, { work_id: f.work_id }, f.context);
      return transport(payload);
    } });
    assert.equal(f.status().goalActive, false);
    assert.equal(f.status().state, 'stopped');
  });
});

test('temporary browser contention defers a goal without spending its retry budget', async t => {
  await withMonitoredGoal(t, async f => {
    const transport = f.deps.nativeTransport;
    await pollGoal(f.config, f.work_id, { nativeTransport: async payload => payload.action === 'continue'
      ? { ok: false, busy: true, notSent: true } : transport(payload) });
    assert.equal(f.status().goalActive, true);
    assert.equal(f.status().retryCount, 0);
    t.mock.timers.tick(30_000);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().continuationCount, 1);
  });
});

test('persisted receipts from before retry support keep their successful-send count', async t => {
  for (const reactivate of [false, true]) {
    await withMonitoredGoal(t, async f => {
      f.patchGoal({ state: 'monitoring', pendingNode: 'a', pendingOutcome: undefined,
        continuationCount: 1, sentTaskCalls: f.task().calls });
      if (reactivate) activateGoal(f.config, { work_id: f.work_id, objective: 'Complete monitor fixture' }, f.context);
      await pollGoal(f.config, f.work_id, f.deps);
      assert.equal(f.status().continuationCount, 1);
      assert.equal(f.calls.filter(call => call.action === 'continue').length, 0,
        'legacy successful receipt must remain spent after resume');
    });
  }
});

test('automatic detection cannot claim a slash goal from another correlated chat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-correlation-'));
  const config = { stateDir: dir };
  const task = { work_id: 'ordinary-chat-a', objective: 'Ordinary work' };
  const context = { principal: 'correlation-fixture', connector: true, conversationId: ID };
  const reads = [];
  const deps = { task: { status: 'planning' }, credentials, fetch: async url => {
    reads.push(url);
    return url.includes('/conversations?') ? response({ items: [{ id: OTHER }] })
      : response(conversation(url.endsWith(ID) ? ID : OTHER, url.endsWith(ID) ? 'Ordinary chat' : '/goal Other work'));
  } };
  try {
    queueGoalDetection(config, task, context, deps);
    await checkGoalDetection(config, task.work_id, deps);
    assert.equal(goalStatus(config, { work_id: task.work_id }, context).goalActive, false);
    assert.equal(reads.some(url => url.endsWith(OTHER)), false, 'a known chat ID must constrain discovery');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Project Goal Mode discovers an opaque-host conversation without a URL from its sidebar preview', async () => {
  const workId = 'project-preview-receipt';
  const projectId = 'g-p-6a68897d433881919527e08c99703cba';
  const requests = [];
  const fetch = async url => {
    requests.push(url);
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) return response({ items: [{
      gizmo: { gizmo: { id: projectId }, conversations: {
        items: [{ id: ID, update_time: new Date().toISOString() }]
      } }
    }], cursor: null });
    if (url.endsWith('/conversation/' + ID)) return response(conversationWithReceipt(ID, workId, 'do a goal mode test'));
    throw new Error('Unexpected ChatGPT request: ' + url);
  };
  const match = await findRecentGoalCommand({ credentials, fetch, startedAt: Date.now(),
    conversationCorrelation: 'v1/opaque-host-conversation', workId, explicitGoal: true, requireWorkReceipt: true });
  assert.equal(match.state, 'matched');
  assert.equal(match.conversationId, ID);
  assert.equal(requests.filter(url => url.endsWith('/conversation/' + ID)).length, 1);
  assert.equal(requests.some(url => url.includes('/gizmos/' + projectId + '/conversations')), false,
    'a sidebar preview should avoid an unnecessary per-project catalogue read');
});

test('Project Goal Mode finds a receipt through Project and sidebar cursor pages', async () => {
  const workId = 'project-pagination-receipt';
  const projectId = 'g-p-6a68897d433881919527e08c99703cba';
  const requests = [];
  const fetch = async url => {
    requests.push(url);
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) {
      if (url.includes('cursor=sidebar-next')) return response({ items: [{
        gizmo: { gizmo: { id: projectId }, conversations: { items: [] } }
      }], cursor: null });
      return response({ items: [], cursor: 'sidebar-next' });
    }
    if (url.includes('/gizmos/' + projectId + '/conversations?')) {
      if (url.includes('cursor=project-next')) return response({
        items: [{ id: ID, update_time: new Date().toISOString() }], cursor: null
      });
      return response({ items: [{ id: OTHER, update_time: new Date().toISOString() }], cursor: 'project-next' });
    }
    if (url.endsWith('/conversation/' + ID)) return response(conversationWithReceipt(ID, workId, 'run the test'));
    if (url.endsWith('/conversation/' + OTHER)) return response(conversation(OTHER, 'Unrelated'));
    throw new Error('Unexpected ChatGPT request: ' + url);
  };
  const match = await findRecentGoalCommand({ credentials, fetch, startedAt: Date.now(),
    conversationCorrelation: 'v1/another-opaque-session', workId, explicitGoal: true, requireWorkReceipt: true });
  assert.equal(match.conversationId, ID);
  assert.ok(requests.some(url => url.includes('cursor=sidebar-next')));
  assert.ok(requests.some(url => url.includes('cursor=project-next')));
});

test('live Goal Mode monitor links and continues a Project chat without supplying its URL', async t => {
  await withMonitoredGoal(t, async f => {
    const projectId = 'g-p-6a68897d433881919527e08c99703cba';
    f.tree.mapping.u.message.content.parts = ['do a goal mode test'];
    f.tree.mapping.receipt = { parent: 'u', message: {
      author: { role: 'tool' }, create_time: Date.now() / 1000,
      content: { workIds: [f.work_id] }
    } };
    f.tree.mapping.a.parent = 'receipt';
    f.patchGoal({ conversationId: '', conversationCorrelation: 'v1/opaque-host-project-session' });
    const transport = async payload => {
      if (payload.path?.includes('/backend-api/conversations?')) return { ok: true, data: { items: [] } };
      if (payload.path?.includes('/gizmos/snorlax/sidebar')) return { ok: true, data: { items: [{
        gizmo: { gizmo: { id: projectId }, conversations: { items: [
          { id: ID, update_time: new Date().toISOString() }
        ] } }
      }], cursor: null } };
      return f.deps.nativeTransport(payload);
    };
    await pollGoal(f.config, f.work_id, { nativeTransport: transport });
    assert.equal(f.status().conversationId, ID);
    assert.equal(f.status().retryCount, 0);
    assert.equal(f.status().continuationCount, 1);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 1);
  });
});

test('Project Goal Mode makes forward progress beyond the account read budget', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const workId = 'project-budget-progress';
  const ids = Array.from({ length: 42 }, (_, i) => ({
    project: 'g-p-' + String(i + 1).padStart(32, '0'),
    chat: 'aaaaaaaa-bbbb-4ccc-8ddd-' + String(i + 1).padStart(12, '0')
  }));
  const target = ids.at(-1);
  const targetTree = conversationWithReceipt(target.chat, workId, 'start Project Goal Mode');
  let readCount = 0;
  const fetch = async url => {
    readCount++;
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) return response({ items: ids.map(({ project }) => ({
      gizmo: { gizmo: { id: project }, conversations: { items: [] } }
    })), cursor: null });
    const project = ids.find(item => url.includes('/gizmos/' + item.project + '/conversations?'));
    if (project) return response({ items: [{ id: project.chat, update_time: new Date().toISOString() }], cursor: null });
    const chat = ids.find(item => url.endsWith('/conversation/' + item.chat));
    if (chat) return response(chat === target
      ? targetTree : conversation(chat.chat, 'Unrelated conversation'));
    throw new Error('Unexpected request ' + url);
  };
  const deps = { credentials, fetch, workId, explicitGoal: true,
    requireWorkReceipt: true, conversationCorrelation: 'v1/opaque-goal', startedAt: Date.now() };
  let match = null;
  for (let attempt = 0; attempt < 8 && !match; attempt++) {
    try { match = await findRecentGoalCommand(deps); }
    catch (error) {
      assert.equal(error.deferred, true, 'limited reads must defer without exhausting retries');
      t.mock.timers.tick(61_000);
    }
  }
  assert.equal(match?.conversationId, target.chat,
    'subsequent attempts must resume after previous projects, not repeat the first read window');
  assert.ok(readCount > 30);
});

test('Project goal searches later sidebar previews before unrelated deep Project histories', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const workId = 'sidebar-preview-priority';
  const calls = [];
  const targetTree = conversationWithReceipt(ID, workId, 'Start goal without URL');
  const fetch = async url => {
    calls.push(url);
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) {
      const cursor = new URL(url).searchParams.get('cursor');
      const page = cursor ? Number(cursor.slice(5)) : 0;
      return response({ items: [{ gizmo: {
        gizmo: { id: 'g-p-' + String(page + 1).padStart(32, '0') },
        conversations: { items: page === 4 ? [{ id: ID, update_time: new Date().toISOString() }] : [] }
      } }], cursor: page < 4 ? 'page-' + (page + 1) : null });
    }
    if (url.endsWith('/conversation/' + ID)) return response(targetTree);
    if (url.includes('/gizmos/') && url.includes('/conversations?')) {
      // Old Projects have long histories. No deep history should be required
      // before visiting the fifth sidebar page with a recent matching chat.
      const cursor = new URL(url).searchParams.get('cursor');
      return response({ items: [], cursor: 'more-' + (cursor === '0' ? 1 : Number(cursor.slice(5)) + 1) });
    }
    throw new Error('Unexpected Goal Mode request: ' + url);
  };
  const deps = { credentials, fetch, workId, explicitGoal: true, requireWorkReceipt: true,
    conversationCorrelation: 'v1/sidebar-target-later', startedAt: Date.now() };
  let found = null;
  for (let attempt = 0; attempt < 2 && !found; attempt++) {
    try { found = await findRecentGoalCommand(deps); }
    catch (error) { assert.equal(error.deferred, true); t.mock.timers.tick(21_000); }
  }
  assert.equal(found?.conversationId, ID,
    'a fresh chat in the next sidebar batch must not wait behind old Project histories');
  assert.equal(calls.some(url => url.includes('/gizmos/g-p-') && url.includes('/conversations?')), false,
    'recent sidebar previews should be checked before historical fallback');
});

test('Project discovery advances past bounded sidebar pagination', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const workId = 'project-sidebar-deep';
  const project = 'g-p-' + 'f'.repeat(32);
  const target = conversationWithReceipt(ID, workId, 'Goal Mode inside a Project');
  const fetch = async url => {
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) {
      const cursor = new URL(url).searchParams.get('cursor');
      const page = cursor ? Number(cursor.slice(8)) : 0;
      return response({ items: [{
        gizmo: { gizmo: { id: page === 4 ? project : 'g-p-' + String(page + 1).padStart(32, '0') },
          conversations: { items: [] } }
      }], cursor: page < 4 ? 'sidebar-' + (page + 1) : null });
    }
    if (url.includes('/gizmos/' + project + '/conversations?')) return response({ items: [{ id: ID }], cursor: null });
    if (url.includes('/gizmos/')) return response({ items: [], cursor: null });
    if (url.endsWith('/conversation/' + ID)) return response(target);
    throw new Error('Unexpected request ' + url);
  };
  const deps = { credentials, fetch, workId, explicitGoal: true, requireWorkReceipt: true,
    startedAt: Date.now(), conversationCorrelation: 'v1/sidebar-deep' };
  let match;
  for (let retry = 0; retry < 8 && !match; retry++) {
    try { match = await findRecentGoalCommand(deps); }
    catch (error) { assert.equal(error.deferred, true); t.mock.timers.tick(61_000); }
  }
  assert.equal(match?.conversationId, ID);
});

test('automatic Goal discovery advances sidebar pages after cache expiry without reading full histories', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const workId = 'automatic-sidebar-deep';
  const pages = [];
  const target = conversationWithReceipt(ID, workId);
  const fetch = async url => {
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) {
      const cursor = new URL(url).searchParams.get('cursor');
      const page = cursor ? Number(cursor.slice(8)) : 0;
      pages.push(page);
      return response({ items: [{ gizmo: {
        gizmo: { id: 'g-p-' + String(page + 1).padStart(32, '0') },
        conversations: { items: page === 4 ? [{ id: ID }] : [] }
      } }], cursor: page < 4 ? 'sidebar-' + (page + 1) : null });
    }
    if (url.endsWith('/conversation/' + ID)) return response(target);
    assert.fail('Automatic detection must not read full Project histories: ' + url);
  };
  const deps = { credentials, fetch, workId, requireWorkReceipt: true,
    startedAt: Date.now(), conversationCorrelation: 'v1/automatic-sidebar' };
  await assert.rejects(findRecentGoalCommand(deps), error => error.deferred === true);
  t.mock.timers.tick(121_000);
  const match = await findRecentGoalCommand(deps);
  assert.equal(match.state, 'matched');
  assert.equal(match.conversationId, ID);
  assert.deepEqual(pages, [0, 1, 2, 3, 4]);
});

test('Project discovery resumes beyond two Project conversation pages', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const workId = 'project-conversation-deep';
  const project = 'g-p-' + 'e'.repeat(32);
  const target = conversationWithReceipt(ID, workId, 'Goal Mode in long Project chat history');
  const fetch = async url => {
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) return response({ items: [{
      gizmo: { gizmo: { id: project }, conversations: { items: [] } }
    }], cursor: null });
    if (url.includes('/gizmos/' + project + '/conversations?')) {
      const cursor = new URL(url).searchParams.get('cursor');
      return response(cursor === 'page-2'
        ? { items: [{ id: ID }], cursor: null }
        : { items: [], cursor: cursor === '0' ? 'page-1' : 'page-2' });
    }
    if (url.endsWith('/conversation/' + ID)) return response(target);
    throw new Error('Unexpected request ' + url);
  };
  const deps = { credentials, fetch, workId, explicitGoal: true, requireWorkReceipt: true,
    startedAt: Date.now(), conversationCorrelation: 'v1/project-deep' };
  let match;
  for (let retry = 0; retry < 8 && !match; retry++) {
    try { match = await findRecentGoalCommand(deps); }
    catch (error) { assert.equal(error.deferred, true); t.mock.timers.tick(61_000); }
  }
  assert.equal(match?.conversationId, ID);
});

test('Project Goal Mode refuses missing or off-branch work receipts', async () => {
  const projectId = 'g-p-6a68897d433881919527e08c99703cba';
  const workId = 'project-branch-receipt';
  const tree = conversationWithReceipt(ID, workId, 'start goal');
  tree.mapping.a.parent = 'u';
  const fetch = async url => {
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) return response({ items: [{
      gizmo: { gizmo: { id: projectId }, conversations: { items: [{ id: ID }] } }
    }], cursor: null });
    if (url.includes('/gizmos/' + projectId + '/conversations')) return response({ items: [], cursor: null });
    return response(tree);
  };
  assert.equal((await findRecentGoalCommand({ credentials, fetch, startedAt: Date.now(),
    conversationCorrelation: 'v1/untrusted-host', workId, explicitGoal: true, requireWorkReceipt: true })).state, 'absent');
});

test('opaque host correlations require an exact tool receipt after the goal command on its active branch', async () => {
  const workId = 'receipt-owner';
  const fetchTree = tree => ({ credentials, startedAt: Date.now(), conversationCorrelation: 'opaque-session',
    workId, requireWorkReceipt: true, fetch: async url => url.includes('/conversations?')
      ? response({ items: [{ id: ID }] }) : emptyProjectCatalogue(url) || response(tree) });
  assert.equal((await findRecentGoalCommand(fetchTree(conversationWithReceipt(ID, workId)))).state, 'matched');
  for (const mutate of [
    tree => { tree.mapping.receipt.message.author.role = 'assistant'; },
    tree => { tree.mapping.receipt.message.author.role = 'user'; },
    tree => { tree.mapping.a.parent = 'u'; },
    tree => { tree.mapping.receipt.message.content.parts = [JSON.stringify({ work_id: 'different-owner' })]; },
    tree => { tree.mapping.receipt.parent = 'root'; tree.mapping.u.parent = 'receipt'; tree.mapping.a.parent = 'u'; }
  ]) {
    const tree = conversationWithReceipt(ID, workId);
    mutate(tree);
    assert.equal((await findRecentGoalCommand(fetchTree(tree))).state, 'absent', 'unrelated or model-authored evidence cannot link a goal');
  }
});

test('explicit goal links a natural-language request through its exact work receipt', async () => {
  const workId = 'explicit-natural-goal';
  const tree = conversationWithReceipt(ID, workId, 'I want you to do a test goal mode now');
  const lookup = (conversationTree, options = {}) => ({
    credentials, startedAt: Date.now(), conversationCorrelation: 'opaque-session',
    workId, requireWorkReceipt: true, explicitGoal: true, ...options,
    fetch: async url => url.includes('/conversations?')
      ? response({ items: [{ id: ID }] }) : emptyProjectCatalogue(url) || response(conversationTree)
  });
  assert.equal((await findRecentGoalCommand(lookup(tree))).conversationId, ID);
  assert.equal((await findRecentGoalCommand(lookup(tree, { explicitGoal: false }))).state, 'absent',
    'ordinary automatic detection still requires a literal /goal command');
  assert.equal((await findRecentGoalCommand(lookup(tree, { conversationCorrelation: ID }))).state, 'matched',
    'a known conversation ID still requires the explicit work receipt');

  tree.mapping.followup = { parent: 'a', message: {
    id: 'user-followup', author: { role: 'user' }, create_time: Date.now() / 1000 + 1,
    content: { parts: ['What happened?'] }
  } };
  tree.current_node = 'followup';
  assert.equal((await findRecentGoalCommand(lookup(tree))).conversationId, ID,
    'a later user message must not hide the initiating receipt');
});

test('explicit goal discovery reads a large work receipt without retaining its body', async () => {
  const workId = 'large-explicit-receipt';
  const tree = conversationWithReceipt(ID, workId, 'Test Goal Mode');
  const receipt = {
    ok: true, work_id: workId, bootstrap: { context: 'private context '.repeat(1000) }
  };
  const deps = { credentials, startedAt: Date.now(), conversationCorrelation: ID,
    workId, explicitGoal: true, requireWorkReceipt: true,
    fetch: async () => new Response(JSON.stringify(tree)) };
  for (const body of [receipt, { structuredContent: receipt },
    { content: [{ type: 'text', text: JSON.stringify(receipt) }] }]) {
    tree.mapping.receipt.message.content.parts = [JSON.stringify(body)];
    assert.equal((await findRecentGoalCommand(deps)).state, 'matched');
    const projected = await getConversation(ID, deps);
    assert.deepEqual(projected.mapping.receipt.message.content.workIds, [workId]);
    assert.equal(JSON.stringify(projected).includes('private context'), false);
  }
  tree.mapping.receipt.message.content.parts = [JSON.stringify({
    ...receipt, bootstrap: { context: 'x'.repeat(2 * 1024 * 1024) }
  })];
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'receipt parsing must retain a finite input budget');
});

test('explicit goal discovery dates an exact receipt by the tool response after a long initiating turn', async () => {
  const startedAt = Date.now();
  const workId = 'delayed-explicit-receipt';
  const tree = conversationWithReceipt(ID, workId, 'Test Goal Mode');
  tree.mapping.u.message.create_time = (startedAt - 5 * 60_000) / 1000;
  tree.mapping.receipt.message.create_time = startedAt / 1000;
  const deps = { credentials, startedAt, conversationCorrelation: ID,
    workId, explicitGoal: true, requireWorkReceipt: true,
    fetch: async () => new Response(JSON.stringify(tree)) };
  assert.equal((await findRecentGoalCommand(deps)).state, 'matched',
    'thinking or tool setup before work.begin must not age out its exact receipt');
  tree.mapping.u.message.create_time = startedAt / 1000;
  tree.mapping.receipt.message.create_time = (startedAt - 60 * 60_000) / 1000;
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'a fresh user timestamp cannot make a stale tool receipt current');
  tree.mapping.receipt.message.create_time = (startedAt + 60_000) / 1000;
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'a later receipt cannot claim to be the initiating receipt');
});

test('explicit goal discovery rejects unrelated, stale, off-branch and model-authored receipts', async () => {
  const workId = 'explicit-receipt-owner';
  const lookup = (tree, options = {}) => ({
    credentials, startedAt: Date.now(), workId, explicitGoal: true,
    requireWorkReceipt: true, conversationCorrelation: ID, ...options,
    fetch: async () => response(tree)
  });
  const valid = conversationWithReceipt(ID, workId, 'Start the test');
  assert.equal((await findRecentGoalCommand(lookup(valid))).state, 'matched');
  for (const mutate of [
    tree => { tree.mapping.receipt.message.author.role = 'assistant'; },
    tree => { tree.mapping.receipt.message.content.parts = [JSON.stringify({ work_id: 'someone-else' })]; },
    tree => { tree.mapping.a.parent = 'u'; },
    tree => { tree.mapping.u.message.create_time -= 3600; },
    tree => { tree.mapping.receipt.parent = 'root'; tree.mapping.u.parent = 'receipt'; tree.mapping.a.parent = 'u'; }
  ]) {
    const tree = conversationWithReceipt(ID, workId, 'Start the test');
    mutate(tree);
    assert.equal((await findRecentGoalCommand(lookup(tree))).state, 'absent');
  }
  assert.equal((await findRecentGoalCommand(lookup(conversation(ID, 'Start the test')))).state, 'absent',
    'an explicit goal cannot be linked using only the host conversation ID');
});

test('explicit goal discovery refuses ambiguous matches and rechecks cached receipts', async () => {
  const workId = 'explicit-unique-work';
  const trees = {
    [ID]: conversationWithReceipt(ID, workId, 'Test Goal Mode'),
    [OTHER]: conversationWithReceipt(OTHER, workId, 'Test Goal Mode')
  };
  const fetch = async url => url.includes('/conversations?')
    ? response({ items: [{ id: ID }, { id: OTHER }] })
    : emptyProjectCatalogue(url) || response(trees[url.endsWith(ID) ? ID : OTHER]);
  const deps = { credentials, fetch, startedAt: Date.now(), conversationCorrelation: 'opaque-session',
    workId, explicitGoal: true, requireWorkReceipt: true };
  assert.equal((await findRecentGoalCommand(deps)).state, 'ambiguous');
  trees[OTHER] = conversation(OTHER, 'Unrelated task');
  assert.equal((await findRecentGoalCommand(deps)).state, 'matched',
    'cached matching evidence must be reverified before linking');
  trees[ID] = conversation(ID, 'Unrelated task');
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'a vanished receipt must never authorize a cached match');
});

test('explicit goal monitor resolves a natural-language work receipt without a conversation URL', async t => {
  await withMonitoredGoal(t, async f => {
    f.tree.mapping.u.message.content.parts = ['I want you to do a test goal mode now'];
    f.tree.mapping.u.message.create_time -= 300;
    f.tree.mapping.receipt = { parent: 'u', message: {
      author: { role: 'tool' }, create_time: Date.now() / 1000,
      content: { workIds: [f.work_id] }
    } };
    f.tree.mapping.a.parent = 'receipt';
    f.patchGoal({ conversationId: '', conversationCorrelation: 'opaque-host-session' });
    const transport = async payload => payload.path?.includes('/conversations?')
      ? { ok: true, data: { items: [{ id: ID }] } } : f.deps.nativeTransport(payload);
    await pollGoal(f.config, f.work_id, { nativeTransport: transport });
    assert.equal(f.status().conversationId, ID);
    assert.equal(f.status().retryCount, 0, JSON.stringify(f.status()));
    assert.equal(f.status().continuationCount, 1);
    assert.match(f.calls.find(call => call.action === 'continue').prompt, new RegExp(f.work_id));
  });
});

test('monitor stops a stalled turn before sending once and refuses unconfirmed stop readback', async t => {
  await withMonitoredGoal(t, async f => {
    f.unfinished();
    await pollGoal(f.config, f.work_id, f.deps);
    assert.deepEqual(f.calls.filter(call => call.action).map(call => call.action), ['stop_stalled', 'continue']);
    assert.equal(f.status().continuationCount, 1);
  });
  await withMonitoredGoal(t, async f => {
    f.unfinished();
    f.onStop(() => {});
    await pollGoal(f.config, f.work_id, f.deps);
    assert.deepEqual(f.calls.filter(call => call.action).map(call => call.action), ['stop_stalled'],
      'a stop receipt with a still-running branch cannot authorize Send');
    assert.equal(f.status().state, 'retrying');
    assert.equal(f.status().continuationCount, 0);
  });
});

test('monitor never continues work cancelled during Stop', async t => {
  await withMonitoredGoal(t, async f => {
    f.unfinished();
    f.onStop(() => {
      f.tree.mapping.a.message.status = 'interrupted';
      runWithToolActivity({ taskId: f.work_id }, () => requestCurrentTaskCancellation());
    });
    await pollGoal(f.config, f.work_id, f.deps);
    assert.deepEqual(f.calls.filter(call => call.action).map(call => call.action), ['stop_stalled']);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().goalActive, false);
    assert.equal(f.status().state, 'cancelled', JSON.stringify(f.status()));
  });
});

test('monitor stops automatic recovery when a continuation has no new tool activity', async t => {
  await withMonitoredGoal(t, async f => {
    f.unfinished();
    f.patchGoal({ continuationCount: 1, sentTaskCalls: f.task().calls });
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.calls.filter(call => call.action).length, 0);
    assert.equal(f.status().goalActive, false);
    assert.match(f.status().error, /No new Rel.AI task activity/);
  });
});

test('monitor ends completed, failed and unavailable sessions without inventing success', async t => {
  await withMonitoredGoal(t, async f => {
    const finish = beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.finish',
      taskId: f.work_id, scopeId: 'goal-monitor-fixture' });
    finish.requestCompletion({ summary: 'Fixture complete' });
    finish({ ok: true });
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().state, 'finished');
    assert.equal(f.status().goalActive, false);
    assert.equal(f.calls.length, 0, 'completion must stop before any browser request');
  });
  await withMonitoredGoal(t, async f => {
    recordTaskActivityEvent(f.config, { task: { ...f.task(), status: 'failed', state: 'failed',
      endedAt: Date.now(), terminalReason: 'Fixture task-start failure' } });
    resetToolActivity();
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().state, 'failed');
    assert.equal(f.status().goalActive, false);
    assert.equal(f.calls.length, 0);
  });
  await withMonitoredGoal(t, async f => {
    resetToolActivity();
    await clearTaskHistory(f.config);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.status().state, 'unavailable');
    assert.equal(f.status().goalActive, false);
    assert.equal(f.calls.length, 0);
  });
});

test('Goal Mode reuses relai_work and is opt-in on begin', () => {
  const schemas = getToolSchemas();
  assert.equal(schemas.some(schema => schema.name === 'relai_goal'), false);
  const work = schemas.find(schema => schema.name === 'relai_work');
  assert.ok(work);
  const branches = work.inputSchema.oneOf || [];
  const begin = branches.find(branch => branch.properties?.action?.const === 'begin');
  assert.ok(begin);
  assert.equal(begin.properties.goal.type, 'boolean');
  assert.equal(begin.required.includes('goal'), false);
  assert.ok(branches.some(branch => branch.properties?.action?.const === 'goal_status'));
  assert.ok(branches.some(branch => branch.properties?.action?.const === 'goal_stop'));
});

test('conversation URL validation is bound to chatgpt.com', () => {
  assert.equal(parseConversationUrl('https://chatgpt.com/c/' + ID), ID);
  assert.equal(parseConversationUrl('https://chatgpt.com/g/g-p-rel-ai-mcp/c/' + ID), ID);
  assert.equal(parseConversationUrl('https://chatgpt.com/g/g-custom/c/' + ID + '/?view=chat#reply'), ID);
  assert.equal(parseConversationUrl(ID), ID);
  assert.throws(() => parseConversationUrl('https://evil.example/c/' + ID));
  assert.throws(() => parseConversationUrl('https://chatgpt.com/c/not-a-uuid'));
  assert.throws(() => parseConversationUrl('https://chatgpt.com/g/g-custom/c/' + ID + '/other'));
  assert.throws(() => parseConversationUrl('https://user:private@chatgpt.com/c/' + ID));
});

test('protocol conversation reads stream only branch metadata, even above the old 32 MiB limit', async () => {
  const payload = { ...conversation(ID), private_blob: 'x'.repeat(34 * 1024 * 1024) };
  const projection = await getConversation(ID, { credentials,
    fetch: async () => new Response(JSON.stringify(payload)) });
  assert.equal(turnState(projection).lastMessageId, 'assistant-1');
  assert.equal(turnState(projection).complete, true);
  assert.equal(turnState(projection).userMessage.content.parts[0], '/goal Fix the current project');
  assert.equal(JSON.stringify(projection).includes('xxxxxxxxxx'), false,
    'unrelated body must be discarded before reaching Goal Mode');
  assert.ok(JSON.stringify(projection).length < 3000);
  const split = conversation(ID);
  split.mapping.u.message.content.parts = ['/goal', 'stop'];
  const splitProjection = await getConversation(ID, { credentials,
    fetch: async () => new Response(JSON.stringify(split)) });
  assert.equal(turnState(splitProjection).userMessage.content.parts.join('\n'), '/goal\nstop',
    'split command text must not silently become bare /goal');
  const splitMatch = await findRecentGoalCommand({ startedAt: Date.now(), credentials,
    fetch: async url => url.includes('/conversations?')
      ? response({ items: [{ id: ID }] }) : emptyProjectCatalogue(url) || new Response(JSON.stringify(split)) });
  assert.equal(splitMatch.state, 'absent');
  const malformed = new Response('{"current_node":"a","mapping":');
  await assert.rejects(() => getConversation(ID, { credentials,
    fetch: async () => malformed }), /token|json|parsing|ended/i);
});

test('current conversation branch is parsed without side branches', () => {
  const tree = conversation(ID);
  const messages = activeMessages(tree);
  assert.equal(messages.length, 2);
  assert.equal(turnState(tree).lastMessageId, 'assistant-1');
  assert.equal(turnState(tree).complete, true);
  tree.mapping.a.message.end_turn = false;
  assert.equal(turnState(tree).complete, false);
});

test('resolved goal plans distinguish finished work from external blockers', () => {
  assert.equal(resolvedGoalPlan({ plan: { steps: [
    { status: 'completed' }, { status: 'blocked' }, { status: 'skipped' }
  ] } }), 'blocked');
  assert.equal(resolvedGoalPlan({ plan: { steps: [{ status: 'completed' }] } }), 'finished');
  assert.equal(resolvedGoalPlan({ plan: { steps: [{ status: 'completed' }, { status: 'pending' }] } }), null);
  assert.equal(resolvedGoalPlan({ plan: { steps: [{ status: 'in_progress' }] } }), null);
  assert.equal(resolvedGoalPlan({ plan: { steps: [{ status: 'blocked' }] } }), null);
});

test('unfinished assistant turns trigger one recovery at 4:30 since last Rel.AI call', () => {
  const snapshot = { nodeId: 'assistant-node', role: 'assistant', text: 'Thinking', complete: false };
  const task = { calls: 7, activeCalls: 0, lastActivityAt: 1_000 };
  const goal = { active: true, state: 'monitoring' };
  const first = unfinishedTurnUpdate(goal, snapshot, task, 1_000);
  assert.equal(first.unfinishedProgressAt, 1_000);
  assert.equal(first.active, true);
  assert.equal(unfinishedTurnUpdate(first, snapshot, task, 270_999), null,
    'the timer must not fire before 4 minutes 30 seconds');
  const expanded = unfinishedTurnUpdate(first, { ...snapshot, text: 'Thinking more' }, task, 150_000);
  assert.equal(expanded, null, 'generating text without new Rel.AI calls does not reset the timer');
  const newCall = unfinishedTurnUpdate(first, snapshot, { calls: 8, lastActivityAt: 269_000 }, 269_000);
  assert.equal(newCall.unfinishedProgressAt, 269_000, 'a new Rel.AI tool call resets the timer');
  assert.equal(unfinishedTurnUpdate(newCall, snapshot,
    { calls: 8, lastActivityAt: 269_000 }, 538_999), null);
  const stalled = unfinishedTurnUpdate(newCall, snapshot,
    { calls: 8, lastActivityAt: 269_000 }, 539_000);
  assert.equal(stalled.state, 'stalled');
  assert.equal(stalled.active, true, 'only verified recovery may send a new message');
  assert.equal(stalled.pendingNode, undefined, 'stall detection itself must never submit');
  const lateFirstPoll = unfinishedTurnUpdate({ active: true, state: 'monitoring' },
    { ...snapshot, startedAt: 1_000 }, { calls: 12, lastActivityAt: 2_000 }, 260_000);
  assert.equal(lateFirstPoll.unfinishedProgressAt, 2_000,
    'the last tool call, not the monitor first seeing the turn, starts the timer');
  assert.equal(unfinishedTurnUpdate(lateFirstPoll, { ...snapshot, startedAt: 1_000 },
    { calls: 12, lastActivityAt: 2_000 }, 272_000)?.state, 'stalled');
});

test('stalled-turn stop uses the authorized native browser once and fails closed', async () => {
  const calls = [];
  assert.equal(await stopStalledTurn(ID, 'assistant-node', { nativeTransport: async payload => {
    calls.push(payload);
    return { ok: true, stopped: true };
  } }), true);
  assert.deepEqual(calls.map(call => call.action), ['stop_stalled']);
  assert.equal(calls[0].expectedNodeId, 'assistant-node');
  await assert.rejects(() => stopStalledTurn(ID, 'assistant-node', {
    nativeTransport: async () => ({ ok: false, needsUser: true })
  }), /could not be stopped and verified/);
  await assert.rejects(() => stopStalledTurn(ID, 'assistant-node', { credentials,
    fetch: async () => { throw new Error('Unsafe fallback called'); }
  }), /requires the signed-in desktop browser/);
});

test('concurrent goals share account discovery instead of rescanning every task cycle', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const reads = [];
  const transport = async payload => {
    reads.push(payload);
    if (payload.path.includes('/conversations?')) return { ok: true, data: { items: [{ id: ID }, { id: OTHER }] } };
    const id = payload.path.endsWith(ID) ? ID : OTHER;
    const tree = conversation(id);
    tree.mapping.receipt = { parent: 'u', message: { author: { role: 'tool' }, content: { workIds: [id] } } };
    tree.mapping.a.parent = 'receipt';
    return { ok: true, data: tree };
  };
  const lookup = workId => findRecentGoalCommand({ nativeTransport: transport, tunnelId: 'account-a',
    workId, requireWorkReceipt: true, conversationCorrelation: 'opaque', startedAt: Date.now() });
  const first = await Promise.all([lookup(ID), lookup(OTHER)]);
  assert.deepEqual(first.map(r => r.conversationId), [ID, OTHER]);
  assert.equal(reads.length, 3, 'one catalog and one read per chat must serve both tasks');
  t.mock.timers.tick(30_000);
  await Promise.all([lookup(ID), lookup(OTHER)]);
  assert.equal(reads.filter(r => r.path.includes('/conversations?')).length, 1,
    'a new task cycle must not repeat the catalog scan');
  assert.equal(reads.length, 5, 'only matched chats need fresh receipt verification');
  await findRecentGoalCommand({ nativeTransport: transport, tunnelId: 'account-b',
    conversationCorrelation: ID, startedAt: Date.now() });
  assert.equal(reads.at(-1).tunnelId, 'account-b', 'accounts must never share cached evidence');
});

test('429 stops all reads for that account until Retry-After without affecting another account', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const calls = [];
  const transport = async payload => {
    calls.push(payload);
    return calls.length === 1 ? { ok: false, status: 429, retryAfterMs: 180_000 }
      : { ok: true, data: conversation(ID) };
  };
  const deps = { nativeTransport: transport, tunnelId: 'limited-account' };
  await assert.rejects(() => getConversation(ID, deps), e => e.status === 429 && e.retryAt === Date.now() + 180_000);
  await assert.rejects(() => getConversation(OTHER, deps), e => e.status === 429 && e.deferred === true);
  assert.equal(calls.length, 1, 'another task must not send a request during the cooldown');
  await getConversation(ID, { ...deps, tunnelId: 'other-account' });
  assert.equal(calls.length, 2);
  t.mock.timers.tick(180_000);
  await getConversation(ID, deps);
  assert.equal(calls.length, 3, 'reads resume only after the account deadline');
});

test('monitor avoids remote polling while a local operation is running', async t => {
  await withMonitoredGoal(t, async f => {
    const operation = beginConnectorToolCall({ tool: 'relai_exec', internalOperation: 'exec',
      taskId: f.work_id, scopeId: 'goal-monitor-fixture' });
    try {
      await pollGoal(f.config, f.work_id, f.deps);
      assert.equal(f.calls.length, 0);
    } finally { operation({ ok: true }); }
  });
});

test('simultaneous 429 responses count as one account cooldown, not one backoff per task', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const deps = { nativeTransport: async () => ({ ok: false, status: 429 }), tunnelId: 'shared-rate-window' };
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => getConversation(ID, deps)));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.retryAt === Date.now() + 300_000));
  t.mock.timers.tick(300_000);
  await assert.rejects(() => getConversation(ID, deps), error => error.retryAt === Date.now() + 600_000);
});

test('account read budget defers repeated reads and branch checks remain uncached', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let reads = 0;
  const deps = { tunnelId: 'budget-account', nativeTransport: async () => {
    reads++;
    const tree = conversation(ID);
    tree.current_node = reads === 1 ? 'u' : 'a';
    return { ok: true, data: tree };
  } };
  assert.equal((await getConversation(ID, deps)).current_node, 'u');
  assert.equal((await getConversation(ID, deps)).current_node, 'a', 'a branch change must be observed in a fresh read');
  for (let i = 2; i < 30; i++) await getConversation(ID, deps);
  await assert.rejects(() => getConversation(ID, deps), e => e.deferred && e.retryAt === Date.now() + 60_000);
  assert.equal(reads, 30);
  t.mock.timers.tick(60_000);
  await getConversation(ID, deps);
  assert.equal(reads, 31);
});

test('discovery cancellation does not cancel another task sharing the same read', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  let reads = 0;
  const transport = async payload => {
    reads++;
    if (payload.path.includes('/conversations?')) {
      await pending;
      return { ok: true, data: { items: [{ id: ID }] } };
    }
    return { ok: true, data: conversation(ID) };
  };
  const deps = { nativeTransport: transport, startedAt: Date.now() };
  const cancelled = findRecentGoalCommand({ ...deps, signal: controller.signal });
  const surviving = findRecentGoalCommand(deps);
  controller.abort();
  await assert.rejects(() => cancelled, e => e.name === 'AbortError');
  release();
  assert.equal((await surviving).state, 'matched');
  assert.equal(reads, 2, 'the surviving task must finish using the one shared catalog request');
});

test('429 cooldown survives transport restart and does not exhaust detection attempts', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ conversationId: '', conversationCorrelation: 'opaque', observedNode: '' });
    let requests = 0;
    const limited = { nativeTransport: async () => { requests++; return { ok: false, status: 429, retryAfterMs: 180_000 }; } };
    await pollGoal(f.config, f.work_id, limited);
    assert.equal(f.status().state, 'rate_limited');
    assert.equal(f.status().goalActive, true);
    assert.equal(f.status().nextAttemptAt, Date.now() + 180_000);
    const task = { work_id: 'new-during-cooldown', objective: 'Explicit work' };
    const context = { connector: true, conversationId: 'opaque', principal: 'monitor-fixture' };
    const restarted = { task: { status: 'planning' }, nativeTransport: async () => {
      requests++; return { ok: true, data: { items: [] } };
    } };
    queueGoalDetection(f.config, task, context, restarted);
    await checkGoalDetection(f.config, task.work_id, restarted);
    const status = goalStatus(f.config, { work_id: task.work_id }, context);
    assert.equal(requests, 1, 'a new transport must restore the durable account cooldown');
    assert.equal(status.attempts, 0, 'cooldown waits are not failed command detection');
    assert.match(status.error, /429/);
    assert.equal(status.nextAttemptAt, Date.now() + 180_000);
    stopGoal(f.config, { work_id: task.work_id }, context);
  });
});

test('detection preserves a sanitized read error without storing upstream payloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-detection-error-'));
  try {
    const config = { stateDir: dir };
    const task = { work_id: 'read-error-task', objective: 'Explicit work' };
    const context = { connector: true, conversationId: ID, principal: 'error-fixture' };
    const deps = { task: { status: 'planning' }, nativeTransport: async () => {
      throw new Error('private upstream content and accessToken=do-not-persist');
    } };
    queueGoalDetection(config, task, context, deps);
    await checkGoalDetection(config, task.work_id, deps);
    const status = goalStatus(config, { work_id: task.work_id }, context);
    assert.match(status.error, /discovery failed/);
    assert.equal(JSON.stringify(status).includes('do-not-persist'), false);
    stopGoal(config, { work_id: task.work_id }, context);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native sender rate limits preserve whether Send may already have happened', async t => {
  for (const notSent of [true, false]) await withMonitoredGoal(t, async f => {
    const deps = { nativeTransport: async payload => {
      f.calls.push(payload);
      return payload.action === 'continue' ? { ok: false, status: 429, retryAfterMs: 180_000, notSent }
        : { ok: true, data: structuredClone(f.tree) };
    } };
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.status().state, 'rate_limited');
    assert.equal(f.status().goalActive, true);
    const record = withStateDatabase(f.config, db => JSON.parse(db.prepare('SELECT value FROM state_meta WHERE key=?')
      .get('chatgpt_goal:' + f.work_id).value), { readonly: true });
    assert.equal(record.pendingNode, notSent ? '' : 'a');
    assert.equal(record.pendingOutcome, notSent ? 'not_sent' : 'uncertain');
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 1,
      'cooldown must prevent another send and uncertain intent must remain reserved');
  });
});

test('goal discovery links a unique recent slash command even when the objective is rewritten', async () => {
  const seen = [];
  const fetch = async url => {
    seen.push(url);
    if (url.includes('/backend-api/conversations?')) return response({ items: [{ id: ID }, { id: OTHER }] });
    if (emptyProjectCatalogue(url)) return emptyProjectCatalogue(url);
    return response(conversation(url.endsWith(ID) ? ID : OTHER,
      url.endsWith(ID) ? '/goal start now. Do everything possible until the firmware is finished' : 'Ordinary conversation'));
  };
  assert.equal(await findGoalConversation('Build offline HG6245D firmware', { credentials, fetch, startedAt: Date.now() }), ID);
  assert.ok(seen.some(url => url.endsWith(ID)));
  assert.deepEqual(await findRecentGoalCommand({ credentials, fetch, startedAt: Date.now() }),
    { state: 'matched', conversationId: ID, messageId: 'user-1' });
  const ambiguous = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }, { id: OTHER }] })
    : emptyProjectCatalogue(url) || response(conversation(ID));
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: ambiguous, startedAt: Date.now() }), null);
  const bareCommand = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] })
    : emptyProjectCatalogue(url) || response(conversation(ID, '/goal'));
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: bareCommand, startedAt: Date.now() }), ID);
  for (const control of ['/goal stop', '/goal status', '/goal cancel']) {
    const stopCommand = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] })
      : emptyProjectCatalogue(url) || response(conversation(ID, control));
    assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: stopCommand, startedAt: Date.now() }), null);
  }
  const old = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] })
    : emptyProjectCatalogue(url) || response({ ...conversation(ID), mapping: { ...conversation(ID).mapping,
      u: { parent: 'root', message: { id: 'old', author: { role: 'user' }, create_time: 1, content: { parts: ['/goal Fix the current project'] } } } } });
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: old, startedAt: Date.now() }), null);
  const laterOrdinary = conversation(ID, '/goal Build firmware');
  laterOrdinary.mapping.nextUser = { parent: 'a', message: { id: 'user-2', author: { role: 'user' },
    create_time: Date.now() / 1000, content: { parts: ['Now review my notes'] } } };
  laterOrdinary.mapping.nextAssistant = { parent: 'nextUser', message: { id: 'assistant-2',
    author: { role: 'assistant' }, end_turn: true, status: 'finished_successfully' } };
  laterOrdinary.current_node = 'nextAssistant';
  assert.deepEqual(await findRecentGoalCommand({ credentials,
    fetch: async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] }) : emptyProjectCatalogue(url) || response(laterOrdinary),
    startedAt: Date.now() }), { state: 'absent' }, 'an older /goal must not activate an unrelated later task');
});

test('goal record is scoped to principal and stopped without cancelling the task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-unit-'));
  try {
    const config = { stateDir: dir };
    const work_id = 'task-test';
    const context = { principal: 'test-principal', requestTaskContext: { session: {
      status: 'planning', workspace: 'sample', objective: 'Fix the current project'
    } } };
    const created = activateGoal(config, { work_id, objective: 'Fix the current project', conversationUrl: 'https://chatgpt.com/c/' + ID }, context);
    assert.equal(created.state, 'linking');
    assert.equal(goalStatus(config, { work_id }, context).goalActive, true);
    assert.throws(() => goalStatus(config, { work_id }, { principal: 'other-principal' }));
    const stopped = stopGoal(config, { work_id }, context);
    assert.equal(stopped.goalActive, false);
    assert.equal(goalStatus(config, { work_id }, context).state, 'stopped');
    assert.equal(dashboardGoalStatus(config, work_id).goalActive, false);
    assert.equal(stopDashboardGoal(config, work_id).state, 'stopped');
    assert.equal(activateGoal(config, { work_id, objective: 'Fix the current project' }, context).goalActive, true,
      'only an explicit new start may reactivate a stopped goal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('connector work begin detects /goal without an AI-supplied boolean and claims the command once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-auto-goal-'));
  try {
    const config = { stateDir: dir };
    const context = { connector: true, conversationId: 'opaque-host-session',
      principal: 'chatgpt-principal' };
    const calls = [];
    const fetch = async url => {
      calls.push(url);
      return url.includes('/conversations?')
        ? response({ items: [{ id: ID }] })
        : response(conversationWithReceipt(ID, 'firmware-work', '/goal start now. Do everything possible until firmware is finished'));
    };
    const deps = { credentials, fetch, task: { status: 'planning' } };
    const task = { work_id: 'firmware-work', workspace: 'pldt',
      objective: 'Create fully verifiable HG6245D firmware offline' };
    assert.deepEqual(queueGoalDetection(config, task, context, deps), { state: 'checking' });
    assert.equal(goalStatus(config, { work_id: task.work_id }, context).state, 'checking');
    for (let i = 0; i < 30 && goalStatus(config, { work_id: task.work_id }, context)?.state === 'checking'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const linked = goalStatus(config, { work_id: task.work_id }, context);
    assert.equal(linked.goalActive, true, JSON.stringify(linked));
    assert.equal(linked.conversationId, ID);
    assert.equal(linked.state, 'monitoring');
    assert.ok(calls.length >= 2);
    assert.equal(queueGoalDetection(config, task, context, deps), null,
      'an already registered goal must not be reset');
    assert.throws(() => goalStatus(config, { work_id: task.work_id },
      { ...context, principal: 'another-principal' }));
    const competing = { ...task, work_id: 'unrelated-work' };
    const correlated = { ...context, conversationId: ID };
    assert.deepEqual(queueGoalDetection(config, competing, correlated, deps), { state: 'checking' });
    for (let i = 0; i < 30 && goalStatus(config, { work_id: competing.work_id }, context).state === 'checking'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(goalStatus(config, { work_id: competing.work_id }, context).state, 'ambiguous',
      'one user command must not activate a second task');
    assert.equal(stopGoal(config, { work_id: task.work_id }, context).state, 'stopped');
    assert.equal(queueGoalDetection(config, { ...task, work_id: 'cli-work' },
      { ...context, connector: false }, deps), null);
    const stoppedEarly = { ...task, work_id: 'stopped-early' };
    queueGoalDetection(config, stoppedEarly, context, deps);
    assert.equal(stopGoal(config, { work_id: stoppedEarly.work_id }, context).state, 'stopped');
    await checkGoalDetection(config, stoppedEarly.work_id, deps);
    assert.equal(goalStatus(config, { work_id: stoppedEarly.work_id }, context).goalActive, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto detection is bounded, fails closed on ambiguity and does not invent a goal for ordinary work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-ambiguity-'));
  try {
    const config = { stateDir: dir };
    const context = { connector: true, conversationId: 'host-session', principal: 'principal' };
    const task = { work_id: 'ambiguous-test', workspace: 'example', objective: 'Make a build' };
    const fetch = async url => url.includes('/conversations?')
      ? response({ items: [{ id: ID }, { id: OTHER }] })
      : response(conversationWithReceipt(url.endsWith(ID) ? ID : OTHER, task.work_id));
    const deps = { credentials, fetch, task: { status: 'planning' } };
    queueGoalDetection(config, task, context, deps);
    for (let i = 0; i < 30 && goalStatus(config, { work_id: task.work_id }, context).state === 'checking'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(goalStatus(config, { work_id: task.work_id }, context).state, 'ambiguous');
    assert.equal(goalStatus(config, { work_id: task.work_id }, context).goalActive, false);
    assert.equal(dashboardGoalStatus(config, task.work_id), null,
      'ordinary task inspector must not show an unconfirmed Goal Mode');

    const normalTask = { ...task, work_id: 'ordinary-work' };
    queueGoalDetection(config, normalTask, context, { ...deps,
      fetch: async url => url.includes('/conversations?')
        ? response({ items: [{ id: ID }] }) : emptyProjectCatalogue(url) || response(conversation(ID, 'Please analyze this repository')) });
    for (let i = 0; i < 30 && goalStatus(config, { work_id: normalTask.work_id }, context).state === 'checking'
      && goalStatus(config, { work_id: normalTask.work_id }, context).state === 'checking'; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const waiting = goalStatus(config, { work_id: normalTask.work_id }, context);
    assert.equal(waiting.goalActive, false);
    assert.equal(waiting.state, 'checking', 'one absent result schedules one bounded retry');
    withStateDatabase(config, db => {
      const key = 'chatgpt_goal_detection:' + normalTask.work_id;
      const original = JSON.parse(db.prepare('SELECT value FROM state_meta WHERE key=?').get(key).value);
      db.prepare('UPDATE state_meta SET value=? WHERE key=?')
        .run(JSON.stringify({ ...original, nextAttemptAt: 0 }), key);
    }, { transaction: true });
    await checkGoalDetection(config, normalTask.work_id, { ...deps,
      fetch: async url => url.includes('/conversations?')
        ? response({ items: [{ id: ID }] }) : emptyProjectCatalogue(url) || response(conversation(ID, 'No /goal request')) });
    assert.equal(goalStatus(config, { work_id: normalTask.work_id }, context).state, 'not_requested');
    assert.equal(goalStatus(config, { work_id: normalTask.work_id }, context).goalActive, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native Goal Mode uses one background browser send without exposing session credentials', async () => {
  const requests = [];
  configureGoalBrowserTransport(async payload => {
    requests.push(payload);
    if (payload.action === 'continue') return { ok: true, accepted: true };
    return { ok: true, data: conversation(ID) };
  });
  try {
    assert.equal(hasGoalBrowserTransport(), true);
    assert.equal(turnState(await getConversation(ID)).complete, true);
    assert.equal((await sendContinue(ID, 'assistant-1', {
      workId: 'test-work', objective: 'Fix the current project', nodeId: 'a'
    })).accepted, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].action, 'continue');
    assert.equal(requests[1].conversationId, ID);
    assert.equal(requests[1].parentMessageId, 'assistant-1');
    assert.equal(requests[1].expectedNodeId, 'a');
    assert.match(requests[1].prompt, /test-work/);
    assert.ok(requests.every(request => !request.headers?.authorization && !request.headers?.cookie),
      'session credentials never cross the native request boundary');
  } finally {
    configureGoalBrowserTransport(null);
  }
  assert.equal(hasGoalBrowserTransport(), false);
});

test('native composer handoff reports bounded send reasons without exposing page text', async () => {
  for (const [reason, expected] of [
    ['text_mismatch', /Composer text could not be verified/],
    ['send_unavailable', /Send button was unavailable/],
    ['verification', /Browser verification is required/],
    ['conversation_unavailable', /did not reach the linked ChatGPT conversation/],
    ['composer_unavailable', /composer did not become ready/],
    ['focus_unavailable', /composer could not receive input/],
    ['unexpected-sensitive-input', /ChatGPT needs attention/]
  ]) {
    let calls = 0;
    await assert.rejects(() => sendContinue(ID, 'assistant-1', {
      workId: 'test-work', objective: 'test', nodeId: 'a',
      nativeTransport: async () => { calls++; return { ok: false, needsUser: true, reason }; }
    }), error => expected.test(error.message) && !error.message.includes('sensitive'));
    assert.equal(calls, 1, 'failed browser handoff never replays the send');
  }
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    workId: 'test-work', objective: 'test', nodeId: 'a',
    nativeTransport: async () => ({ ok: false, uncertain: true, stage: 'readback' })
  }), /could not be verified \(readback\).*without resending/);
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    workId: 'test-work', objective: 'test', nodeId: 'a',
    nativeTransport: async () => ({ ok: false, needsUser: true, stage: 'private-secret' })
  }), error => !error.message.includes('private-secret'));
});

test('continuation sends the exact parent and fails closed when verification is required', async () => {
  const sent = [];
  const fetch = async (url, options) => {
    sent.push({ url, options });
    if (url.includes('/conversation/prepare')) return response({ conduit_token: 'test-conduit' });
    if (url.includes('/chat-requirements/prepare')) return response({ prepare_token: 'test-prepare', proofofwork: { required: false } });
    if (url.includes('/chat-requirements/finalize')) return response({ token: 'test-requirement' });
    return response('event: delta_encoding\\ndata: "v1"\\n\\n');
  };
  const accepted = await sendContinue(ID, 'assistant-1', { credentials, fetch, workId: 'test-work', objective: 'Fix the current project' });
  assert.equal(accepted.accepted, true);
  assert.ok(sent[0].url.endsWith('/sentinel/chat-requirements/prepare'));
  assert.ok(sent[1].url.endsWith('/sentinel/chat-requirements/finalize'));
  assert.equal(JSON.parse(sent[1].options.body).prepare_token, 'test-prepare');
  assert.ok(sent[2].url.endsWith('/f/conversation/prepare'));
  const prepare = JSON.parse(sent[2].options.body);
  assert.equal(sent[2].options.headers['openai-sentinel-chat-requirements-token'], 'test-requirement');
  const payload = JSON.parse(sent[3].options.body);
  assert.equal(payload.messages[0].id, prepare.message_id);
  assert.equal(payload.parent_message_id, 'assistant-1');
  assert.equal(payload.conversation_id, ID);
  assert.match(payload.messages[0].content.parts[0], /test-work/);
  const challenged = async url => url.includes('/chat-requirements/prepare')
    ? response({ prepare_token: 'test-prepare', proofofwork: { required: true } })
    : response({ token: 'test-requirement' });
  await assert.rejects(() => sendContinue(ID, 'assistant-1', { credentials, fetch: challenged, workId: 'test-work', objective: 'Fix the current project' }), error =>
    error?.challenge?.phase === 'prepare' && error?.challenge?.types?.join(',') === 'proof-of-work'
      && /proof-of-work/.test(error.message) && !/interactive/.test(error.message));
});

test('challenge types are accurate and sanitized; no incomplete request reaches submission', async () => {
  const cases = [
    [{ proofofwork: { required: true, seed: 'secret-seed', difficulty: 'hidden' } }, 'prepare', ['proof-of-work']],
    [{ turnstile: { required: true, dx: 'secret-dx' }, so: { required: true, collector_dx: 'hidden' } }, 'prepare', ['Turnstile', 'so']],
    [{ arkose: { required: true, token: 'secret-token' } }, 'finalize', ['Arkose']]
  ];
  for (const [challenge, phase, types] of cases) {
    const paths = [];
    const fetch = async url => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith('/chat-requirements/prepare')) return response({ prepare_token: 'secret-prepare', ...(phase === 'prepare' ? challenge : {}) });
      if (path.endsWith('/chat-requirements/finalize')) return response({ token: 'secret-finalize', ...(phase === 'finalize' ? challenge : {}) });
      throw new Error('Conversation prepare or submit must not be called when challenged.');
    };
    await assert.rejects(() => sendContinue(ID, 'assistant-1', {
      credentials, fetch, workId: 'test-work', objective: 'Safe verification test'
    }), error => {
      assert.deepEqual(error.challenge, { phase, types });
      assert.equal(error.notSent, true, 'requirements refusal is proof that message submission was never attempted');
      assert.deepEqual(Object.keys(error.challenge).sort(), ['phase', 'types']);
      assert.ok(types.every(type => error.message.includes(type)));
      assert.doesNotMatch(error.message + JSON.stringify(error.challenge), /secret|hidden|difficulty|seed|dx|token/i);
      return true;
    });
    assert.equal(paths.length, phase === 'prepare' ? 1 : 2);
  }
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    credentials, workId: 'test-work', objective: 'Safe verification test', fetch: async url =>
      url.endsWith('/prepare') ? response({ prepare_token: 'secret-prepare' }) : response({})
  }), /finalization returned no token/);
});

test('authorized Goal Mode status exposes only challenge kinds and clears them on restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-challenge-'));
  try {
    const config = { stateDir: dir };
    const context = { principal: 'test-principal', requestTaskContext: { session: {
      status: 'planning', workspace: 'sample', objective: 'Safe verification test'
    } } };
    const args = { work_id: 'challenge-test', objective: 'Safe verification test', conversationUrl: 'https://chatgpt.com/c/' + ID };
    activateGoal(config, args, context);
    withStateDatabase(config, db => {
      const key = 'chatgpt_goal:challenge-test';
      const original = JSON.parse(db.prepare('SELECT value FROM state_meta WHERE key=?').get(key).value);
      db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify({ ...original, active: false,
        state: 'paused', error: 'ChatGPT requires proof-of-work; Goal Mode paused.',
        challenge: { phase: 'prepare', types: ['proof-of-work'] } }), key);
    }, { transaction: true });
    assert.deepEqual(goalStatus(config, args, context).challenge, { phase: 'prepare', types: ['proof-of-work'] });
    assert.equal(dashboardGoalStatus(config, args.work_id).error, 'ChatGPT requires proof-of-work; Goal Mode paused.');
    assert.equal(activateGoal(config, args, context).challenge, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 422 identifies the rejected stage without exposing response content or retrying', async () => {
  const stages = [
    ['chat requirements', '/backend-api/sentinel/chat-requirements/prepare'],
    ['chat requirements', '/backend-api/sentinel/chat-requirements/finalize'],
    ['conversation preparation', '/backend-api/f/conversation/prepare'],
    ['message submission', '/backend-api/f/conversation']
  ];
  for (const [index, [stage, path]] of stages.entries()) {
    const requested = [];
    const fetch = async url => {
      const name = new URL(url).pathname;
      requested.push(name);
      if (name === path) return { ok: false, status: 422, text: async () => 'sensitive account-equivalent data' };
      if (name.endsWith('/chat-requirements/prepare')) return response({ prepare_token: 'test-prepare', proofofwork: { required: false } });
      if (name.endsWith('/chat-requirements/finalize')) return response({ token: 'test-requirement' });
      if (name.includes('/prepare')) return response({ conduit_token: 'test-conduit' });
      return response('event: message\\ndata: {}\\n\\n');
    };
    await assert.rejects(
      () => sendContinue(ID, 'assistant-1', { credentials, fetch, workId: 'work', objective: 'test' }),
      error => error?.status === 422 && error?.stage === stage
        && error.message.includes('HTTP 422') && !error.message.includes('sensitive')
    );
    assert.equal(requested.at(-1), path, 'the adapter must stop at the first failed protocol stage');
    assert.equal(requested.length, index + 1);
  }
  const nativeRequests = [];
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    workId: 'work', objective: 'test', nativeTransport: async request => {
      nativeRequests.push(request);
      return { ok: false, status: 422, body: 'never disclose account or conversation data' };
    }
  }), error => /could not be verified/.test(error?.message)
    && !error.message.includes('account or conversation data'));
  assert.deepEqual(nativeRequests.map(request => request.action), ['continue'],
    'native failures must not retry or fall back to protocol message submission');
});
