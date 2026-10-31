import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversationUrl, activeMessages, turnState, findRecentGoalCommand, findGoalConversation, stopStalledTurn, sendContinue, configureGoalBrowserTransport, hasGoalBrowserTransport, getConversation } from '../src/chatgptGoalProtocol.js';
import { updateGoal as updateGoalOptions, activateGoal, resumeGoal, resolvedGoalPlan, unfinishedTurnUpdate, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal, resumeAuthenticatedGoals, pollGoal, startGoalMonitor, stopGoalMonitor } from '../src/chatgptGoalMode.js';
import { getToolSchemas } from '../src/tools/schema.js';
import { parseGoalCommand, validateWorkMode } from '../src/goalCommands.js';
import { buildGoalEvidence } from '../src/chatgptGoalEvidence.js';
import { goalMessageExists, readConversationProjection } from '../src/chatgptConversationReader.js';
import { goalDiscoveryStore, ensureChatLink, readChatLink, commitGoalBinding, normalizeGoalRecord, loadGoal, saveGoal, updateGoal, claimContinuation, recordLoopMilestone } from '../src/chatgptGoalState.js';
import { withStateDatabase, stateDatabasePath } from '../src/stateDatabase.ts';
import { DatabaseSync } from 'node:sqlite';
import { beginConnectorToolCall, getToolActivity, resetToolActivity, runWithToolActivity, requestCurrentTaskCancellation, onToolActivity } from '../src/toolActivity.js';
import { recordTaskActivityEvent, clearTaskHistory, readTaskHistorySessionRecord } from '../src/taskHistoryStore.ts';
import { HANDLERS } from '../src/tools/handlers.js';
import { validateToolOutput } from '../src/tools/outputValidation.js';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { chatLinkResource, readChatLinkResource, chatPairingMarker } from '../src/chatgptChatLink.js';
import { toolResult } from '../src/mcp/results.js';
import { getPublicToolSchemas } from '../src/tools/schema.js';
import { createStdioPrincipal, principalFingerprint } from '../src/mcp/principal.ts';

const ID = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
const OTHER = 'ca32ef5a-77b0-49f0-983d-b39c12c45ff2';
const credentials = { bearer: 'placeholder', cookie: 'session=fake' };

function response(payload) {
  if (payload && Array.isArray(payload.items)) payload = { ...payload,
    items: payload.items.map(item => item.id && !item.update_time ? { ...item, update_time: Date.now() / 1000 } : item) };

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
  patchGoal({ observedNode: 'a', stableSince: Date.now() - 100_000,
    binding: { version: 0, conversationId: ID, owner: 'fixture', messageId: 'user-1', receiptMessageId: 'tool-receipt' } });
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


test('continuing progress is allowed beyond eight sends and old elapsed-time bounds', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ continuationCount: 8, sentTaskCalls: 0,
      createdAt: Date.now() - 10 * 3600000,
      bounds: { maxContinuations: 8, maxDurationMs: 3600000 } });
    for (let iteration = 0; iteration < 4; iteration++) {
      const progress = beginConnectorToolCall({ tool: 'relai_read', internalOperation: 'read',
        taskId: f.work_id, scopeId: 'goal-monitor-fixture' });
      progress({ ok: true });
      const node = 'iteration-' + iteration;
      f.tree.mapping[node] = { parent: 'u', message: { id: node, author: { role: 'assistant' },
        content: { parts: ['Next actionable step remains.'] }, end_turn: true, status: 'finished_successfully' } };
      f.tree.current_node = node;
      f.patchGoal({ observedNode: node, stableSince: Date.now() - 100000 });
      await pollGoal(f.config, f.work_id, f.deps);
      assert.equal(f.status().goalActive, true);
      assert.equal(f.status().continuationCount, 9 + iteration);
    }
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 4);
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 4);
    assert.equal(f.status().state, 'stopped', 'removing caps must never silently resume an explicit Stop');
  });
});


function adaptiveDecision({ goal, evidence }, action = 'continue') {
  return { action, reason: 'Use the observed task evidence', nextPrompt: action === 'continue'
    ? 'Inspect the remaining fixture failure and verify the focused repair.' : '',
  expectedRevision: goal.revision, evidenceFingerprint: evidence.fingerprint, evidenceRefs: [] };
}

test('Stop during adaptive evaluation aborts the decision before any continuation', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ strategy: 'adaptive', lastCommandId: 'user-1' });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let signal;
    const poll = pollGoal(f.config, f.work_id, { ...f.deps, evaluateGoalDecision: async input => {
      signal = input.signal; entered.resolve(); await release.promise; return adaptiveDecision(input);
    } });
    await entered.promise;
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    assert.equal(signal.aborted, true);
    release.resolve();
    await poll;
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
    assert.equal(f.status().state, 'stopped');
    assert.equal(f.status().continuationCount, 0);
  });
});

test('adaptive decisions cannot apply after the goal revision or conversation branch changes', async t => {
  for (const change of ['revision', 'branch']) await withMonitoredGoal(t, async f => {
    f.patchGoal({ strategy: 'adaptive', lastCommandId: 'user-1' });
    await pollGoal(f.config, f.work_id, { ...f.deps, evaluateGoalDecision: async input => {
      if (change === 'revision') updateGoal(f.config, f.work_id,
        current => ({ ...current, objective: 'Newer authorized scope' }));
      else {
        f.tree.mapping.newer = { parent: 'a', message: { id: 'newer-user', author: { role: 'user' },
          content: { parts: ['Wait for my next instruction'] } } };
        f.tree.current_node = 'newer';
      }
      return adaptiveDecision(input);
    } });
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0, change);
    assert.equal(f.status().continuationCount, 0);
    if (change === 'revision') assert.equal(loadGoal(f.config, f.work_id).objective, 'Newer authorized scope');
  });
});

test('adaptive achievement claims cannot finish an unsupported Goal or an ongoing Loop', async t => {
  for (const mode of ['goal', 'loop']) await withMonitoredGoal(t, async f => {
    f.patchGoal({ mode, strategy: 'adaptive', lastCommandId: 'user-1' });
    f.tree.mapping.a.message.content.parts = ['Done, everything passed.'];
    await pollGoal(f.config, f.work_id, { ...f.deps,
      evaluateGoalDecision: async input => adaptiveDecision(input, 'achieved') });
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
    assert.notEqual(f.task().status, 'completed');
    assert.notEqual(f.status().objectiveAchieved, true);
    assert.equal(f.status().state, mode === 'goal' ? 'needs_user' : 'waiting');
    assert.equal(f.status().goalActive, mode === 'loop');
  });
});


test('a supported finite Goal reaches guarded finalization without ending its work session', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ strategy: 'adaptive', lastCommandId: 'user-1' });
    const read = beginConnectorToolCall({ tool: 'relai_read', internalOperation: 'read',
      taskId: f.work_id, scopeId: 'goal-monitor-fixture' });
    read.update({ plan: { revision: 1,
      steps: [{ id: 'inspect', title: 'Inspect the requested fixture', status: 'completed' }] } });
    read({ ok: true });
    await pollGoal(f.config, f.work_id, { ...f.deps, evaluateGoalDecision: async input => {
      assert.equal(input.evidence.completion.eligible, true);
      assert.equal(input.evidence.validation.required, false,
        'read-only work need not invent a code-testing requirement');
      return adaptiveDecision(input, 'achieved');
    } });
    assert.equal(f.status().objectiveAchieved, true);
    assert.equal(f.status().state, 'needs_finalization');
    assert.equal(f.status().goalActive, false);
    assert.notEqual(f.task().status, 'completed', 'the normal guarded finish action still owns task completion');
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
  });
});

test('adaptive uncertain sends reconcile the exact persisted prompt without another evaluation or send', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ strategy: 'adaptive', lastCommandId: 'user-1' });
    let evaluations = 0;
    let sends = 0;
    const transport = f.deps.nativeTransport;
    const deps = { evaluateGoalDecision: async input => { evaluations++; return adaptiveDecision(input); },
      nativeTransport: async payload => {
        if (payload.action === 'continue') { sends++; return { ok: false, uncertain: true, stage: 'readback' }; }
        return transport(payload);
      } };
    await pollGoal(f.config, f.work_id, deps);
    const pending = loadGoal(f.config, f.work_id);
    assert.equal(pending.pendingOutcome, 'uncertain');
    assert.match(pending.pendingPrompt, /remaining fixture failure/);
    assert.equal(pending.continuationCount, 0);
    f.tree.mapping.accepted = { parent: 'a', message: { id: 'accepted-adaptive-user',
      author: { role: 'user' }, content: { parts: [pending.pendingPrompt] } } };
    f.tree.current_node = 'accepted';
    t.mock.timers.tick(5000);
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.status().continuationCount, 1);
    assert.equal(sends, 1);
    assert.equal(evaluations, 1);
  });
});


test('a scope update before stalled recovery sends nothing and clears only the proven-unsent claim', async t => {
  await withMonitoredGoal(t, async f => {
    f.unfinished();
    let reads = 0;
    f.onRead(() => {
      if (++reads === 2) updateGoalOptions(f.config,
        { work_id: f.work_id, objective: 'Newer authorized scope' }, f.context);
    });
    await pollGoal(f.config, f.work_id, f.deps);
    const saved = loadGoal(f.config, f.work_id);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
    assert.equal(saved.objective, 'Newer authorized scope');
    assert.equal(saved.pendingNode, '');
    assert.equal(saved.pendingOutcome, 'not_sent',
      'a send that never reached transport must not become permanent uncertainty');
    assert.equal(saved.continuationCount, 0);
    f.tree.mapping.a.message.status = 'interrupted';
    await pollGoal(f.config, f.work_id, f.deps);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 1,
      'the updated run can continue once the proven-unsent claim is cleared');
    assert.equal(f.status().continuationCount, 1);
  });
});

test('a conversation read cannot apply old-chat controls after another process relinks the goal', async t => {
  await withMonitoredGoal(t, async f => {
    f.tree.mapping.u.message.content.parts = ['/goal stop'];
    let changed = false;
    f.onRead(() => {
      if (changed) return;
      changed = true;
      updateGoal(f.config, f.work_id, current => ({ ...current, active: false, state: 'stopped' }));
      updateGoal(f.config, f.work_id, current => ({ ...current, active: true, state: 'monitoring',
        conversationId: OTHER, objective: 'New conversation objective', lastCommandId: 'new-chat-user' }), { reactivate: true });
    });
    await pollGoal(f.config, f.work_id, f.deps);
    const saved = loadGoal(f.config, f.work_id);
    assert.equal(saved.conversationId, OTHER);
    assert.equal(saved.active, true, 'old-chat Stop must not stop the newly linked run');
    assert.equal(saved.lastCommandId, 'new-chat-user');
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
  });
});


test('the initiating Loop command overrides a legacy goal flag and a newer Stop still wins', async t => {
  for (const stopped of [false, true]) await withMonitoredGoal(t, async f => {
    Object.assign(f.tree, conversationWithReceipt(ID, f.work_id, '/loop Review only the fixture queue'));
    f.tree.mapping.receipt.message.content = { workIds: [f.work_id] }; // Native reads are already projected.
    if (stopped) {
      f.tree.mapping.stop = { parent: 'a', message: { id: 'newer-stop', author: { role: 'user' },
        create_time: Date.now() / 1000, content: { parts: ['/loop stop'] } } };
      f.tree.current_node = 'stop';
    }
    let evaluations = 0;
    await pollGoal(f.config, f.work_id, { ...f.deps, evaluateGoalDecision: async input => {
      evaluations++;
      assert.equal(input.goal.mode, 'loop');
      assert.equal(input.goal.brief, 'Review only the fixture queue');
      return adaptiveDecision(input, 'wait');
    } });
    assert.equal(f.status().mode, 'loop');
    assert.equal(f.status().strategy, 'adaptive');
    assert.equal(f.status().state, stopped ? 'stopped' : 'waiting');
    assert.equal(f.status().goalActive, !stopped);
    assert.equal(evaluations, stopped ? 0 : 1);
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
  });
});


test('a later objective command needs an exact current work receipt before changing scope', async t => {
  for (const receipt of ['absent', 'other-work', 'matching']) await withMonitoredGoal(t, async f => {
    f.patchGoal({ lastCommandId: 'user-1', commandResolutionPending: false });
    f.tree.mapping.nextUser = { parent: 'a', message: { id: 'scope-user', author: { role: 'user' },
      create_time: Date.now() / 1000, content: { parts: ['/goal Inspect the explicitly linked next fixture'] } } };
    f.tree.mapping.nextReceipt = { parent: 'nextUser', message: { id: 'scope-receipt',
      author: { role: 'tool' }, create_time: Date.now() / 1000,
      content: { workIds: receipt === 'matching' ? [f.work_id] : ['another-work'] } } };
    f.tree.mapping.nextAssistant = { parent: receipt === 'absent' ? 'nextUser' : 'nextReceipt',
      message: { id: 'scope-assistant', author: { role: 'assistant' }, end_turn: true,
        status: 'finished_successfully', content: { parts: ['Ready to inspect.'] } } };
    f.tree.current_node = 'nextAssistant';
    f.patchGoal({ observedNode: 'nextAssistant', stableSince: Date.now() - 100000 });
    await pollGoal(f.config, f.work_id, { ...f.deps,
      evaluateGoalDecision: async input => adaptiveDecision(input, 'wait') });
    const saved = loadGoal(f.config, f.work_id);
    assert.equal(saved.objective, receipt === 'matching' ? 'Inspect the explicitly linked next fixture' : 'Complete monitor fixture');
    assert.equal(saved.active, receipt === 'matching');
    assert.equal(saved.state, receipt === 'matching' ? 'waiting' : 'needs_user');
    assert.equal(f.calls.filter(call => call.action === 'continue').length, 0);
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

test('Project Goal Mode discovers an opaque-host conversation without a URL from its sidebar preview', async () => {
  const workId = 'project-preview-receipt';
  const projectId = 'g-p-6a68897d433881919527e08c99703cba';
  const requests = [];
  const fetch = async url => {
    requests.push(url);
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) return response({ items: [{
      gizmo: { gizmo: { id: projectId } }, conversations: {
        items: [{ id: ID, update_time: new Date().toISOString() }]
      }
    }], cursor: null });
    if (url.endsWith('/conversation/' + ID)) return response(conversationWithReceipt(ID, workId, 'do a goal mode test'));
    throw new Error('Unexpected ChatGPT request: ' + url);
  };
  const match = await findRecentGoalCommand({ credentials, fetch, startedAt: Date.now(),
    conversationCorrelation: 'v1/opaque-host-conversation', workId, explicitGoal: true, requireWorkReceipt: true });
  assert.equal(match.state, 'matched');
  assert.equal(match.conversationId, ID);
  assert.equal(requests.filter(url => url.endsWith('/conversation/' + ID)).length, 2);
  assert.equal(requests.some(url => url.includes('/gizmos/' + projectId + '/conversations')), false,
    'a sidebar preview should avoid an unnecessary per-project catalogue read');
});

test('Project Goal Mode refuses missing or off-branch work receipts', async () => {
  const projectId = 'g-p-6a68897d433881919527e08c99703cba';
  const workId = 'project-branch-receipt';
  const tree = conversationWithReceipt(ID, workId, 'start goal');
  tree.mapping.a.parent = 'u';
  const fetch = async url => {
    if (url.includes('/backend-api/conversations?')) return response({ items: [] });
    if (url.includes('/gizmos/snorlax/sidebar')) return response({ items: [{
      gizmo: { gizmo: { id: projectId } }, conversations: { items: [{ id: ID, update_time: Date.now() / 1000 }] }
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
      ? { ok: true, data: { items: [{ id: ID, update_time: Date.now() / 1000 }] } }
      : payload.path?.includes('/snorlax/sidebar') ? { ok: true, data: { items: [] } }
        : f.deps.nativeTransport(payload);
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
  assert.equal(begin.required.includes('mode'), false, 'ordinary tasks must not require selecting Goal/Loop Mode');
  assert.deepEqual(begin.properties.mode.enum, ['normal', 'goal', 'loop']);
  assert.ok(branches.some(branch => branch.properties?.action?.const === 'goal_status'));
  assert.ok(branches.some(branch => branch.properties?.action?.const === 'goal_stop'));
});


test('chat-first Goal and Loop commands keep starts distinct from lifecycle controls', () => {
  const message = text => ({ author: { role: 'user' }, content: { parts: [text] } });
  for (const [mode, objective] of [['goal', 'Finish the validated repair'], ['loop', 'Review the queue']]) {
    const start = parseGoalCommand(message('/' + mode + ' ' + objective));
    assert.equal(start.mode, mode);
    assert.equal(start.action, 'start');
    assert.equal(start.strategy, 'adaptive');
    assert.equal(start.objective, objective);
    if (mode === 'loop') assert.equal(start.brief, objective);
    assert.equal(parseGoalCommand(message('/' + mode)).objective, '');
    for (const action of ['status', 'pause', 'resume', 'stop']) {
      assert.deepEqual(parseGoalCommand(message('/' + mode + ' ' + action)), { mode, action });
      assert.equal(parseGoalCommand(message('/' + mode + ' ' + action + ' another task')), null,
        'a malformed control must not silently start a different objective');
    }
    assert.deepEqual(parseGoalCommand(message('/' + mode + ' cancel')), { mode, action: 'stop' });
  }
});

test('chat commands require bounded user-authored command text, never quoted or embedded instructions', () => {
  const message = (text, role = 'user') => ({ author: { role }, content: { parts: [text] } });
  for (const role of ['assistant', 'tool', 'system']) {
    assert.equal(parseGoalCommand(message('/loop Continue indefinitely', role)), null);
  }
  for (const text of [
    'Please explain /goal stop', '> /goal start', '    /loop start',
    '```text\n/goal start\n```', '/goalkeeper build', '/looping build',
    '/goal status extra', '/loop resume extra', '/goal ' + 'x'.repeat(4096)
  ]) assert.equal(parseGoalCommand(message(text)), null, text.slice(0, 80));
  assert.equal(parseGoalCommand({ author: { role: 'user' }, content: { parts: Array(9).fill('/goal') } }), null);
  assert.equal(parseGoalCommand({ author: { role: 'user' }, content: { parts: [{ text: '/goal start' }] } }), null);
  assert.equal(parseGoalCommand(message('   /goal Safe objective')).objective, 'Safe objective');
});


test('durable Goal migration preserves Stop, spent work and unresolved receipts without lifetime caps', () => {
  const legacy = { workId: 'legacy-goal', owner: 'fixture', active: false, state: 'stopped',
    continuationCount: 12, pendingNode: 'prior-node', pendingOutcome: 'uncertain',
    pendingPrompt: 'Exact prior prompt', futureField: { retained: true },
    bounds: { maxContinuations: 8, maxDurationMs: 3600000, maxNoProgress: 4 } };
  const migrated = normalizeGoalRecord(legacy);
  assert.equal(migrated.active, false);
  assert.equal(migrated.state, 'stopped');
  assert.equal(migrated.continuationCount, 12);
  assert.equal(migrated.pendingNode, legacy.pendingNode);
  assert.equal(migrated.pendingPrompt, legacy.pendingPrompt);
  assert.equal(migrated.pendingOutcome, 'uncertain');
  assert.deepEqual(migrated.futureField, { retained: true });
  assert.equal(migrated.strategy, 'fixed', 'legacy records retain their explicit fallback policy');
  assert.equal(migrated.bounds.maxContinuations, undefined);
  assert.equal(migrated.bounds.maxDurationMs, undefined);
  assert.equal(migrated.bounds.maxNoProgress, 4);
  assert.equal(normalizeGoalRecord({ ...legacy, state: 'sending', pendingOutcome: undefined }).pendingOutcome, 'uncertain');
  assert.equal(normalizeGoalRecord({ ...legacy, state: 'monitoring', pendingOutcome: undefined }).pendingOutcome, 'accepted');
});

test('durable revisions reject stale decisions and cannot revive Stop or replenish spent counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-revision-'));
  const config = { stateDir: dir };
  try {
    const initial = saveGoal(config, { workId: 'revision-goal', owner: 'fixture', active: true,
      state: 'monitoring', mode: 'goal', strategy: 'adaptive', observedNode: 'a',
      continuationCount: 9, objective: 'Complete the fixture' });
    const stopped = updateGoal(config, initial.workId, current => ({ ...current, active: false, state: 'stopped' }));
    assert.ok(stopped.revision > initial.revision);
    const stale = saveGoal(config, { ...initial, active: true, state: 'monitoring', continuationCount: 0 });
    assert.equal(stale.state, 'stopped');
    assert.equal(stale.revision, stopped.revision);
    assert.equal(claimContinuation(config, initial.workId, 'a', 1,
      { expectedRevision: initial.revision, prompt: 'Stale decision' }), null);
    assert.equal(updateGoal(config, initial.workId, current => ({ ...current, active: true, state: 'monitoring' })).active, false);
    const resumed = updateGoal(config, initial.workId, current => ({ ...current, active: true,
      state: 'monitoring', continuationCount: 0 }), { reactivate: true });
    assert.equal(resumed.active, true);
    assert.equal(resumed.continuationCount, 9);
    const claim = claimContinuation(config, initial.workId, 'a', 3,
      { expectedRevision: resumed.revision, prompt: 'Continue exactly this task' });
    assert.equal(claim.pendingOutcome, 'uncertain');
    assert.equal(claim.pendingPrompt, 'Continue exactly this task');
    assert.equal(claim.continuationCount, 9, 'a claimed send is not an accepted send');
    assert.equal(claimContinuation(config, initial.workId, 'a', 3,
      { expectedRevision: claim.revision, prompt: 'Duplicate' }), null);
    const advanced = updateGoal(config, initial.workId, current => ({ ...current, observedNode: 'b' }));
    assert.equal(claimContinuation(config, initial.workId, 'b', 4,
      { expectedRevision: advanced.revision, prompt: 'Do not replay uncertainty' }), null);
    assert.equal(loadGoal(config, initial.workId).pendingPrompt, 'Continue exactly this task',
      'a fresh state read retains the original uncertain intent across restart');
    updateGoal(config, initial.workId, current => ({ ...current, active: false,
      state: 'stopped', objective: 'Newer authorized objective' }));
    const receipt = current => ({ ...current, pendingOutcome: 'accepted' });
    const acceptedAfterStop = updateGoal(config, initial.workId, receipt, { recordReceipt: true });
    assert.equal(acceptedAfterStop.state, 'stopped');
    assert.equal(acceptedAfterStop.active, false);
    assert.equal(acceptedAfterStop.continuationCount, 10);
    assert.equal(acceptedAfterStop.objective, 'Newer authorized objective');
    assert.equal(updateGoal(config, initial.workId, receipt, { recordReceipt: true }).continuationCount, 10,
      'duplicate late acceptance must not double count');
    const loop = saveGoal(config, { workId: 'loop-milestone', owner: 'fixture', active: true,
      state: 'monitoring', mode: 'loop', objective: 'Keep checking the fixture', brief: 'Original brief' });
    assert.equal(recordLoopMilestone(config, loop.workId, { operationId: 'iteration-1', summary: 'One item' }).iterationCount, 1);
    assert.equal(recordLoopMilestone(config, loop.workId, { operationId: 'iteration-1', summary: 'Duplicate' }).iterationCount, 1);
    updateGoal(config, loop.workId, current => ({ ...current, active: false, state: 'stopped' }));
    assert.equal(recordLoopMilestone(config, loop.workId, { operationId: 'iteration-2' }), null);
    assert.equal(loadGoal(config, loop.workId).iterationCount, 1);
    assert.equal(loadGoal(config, loop.workId).brief, 'Original brief');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('completion evidence treats assistant success prose and task labels as unverified claims', () => {
  const tree = conversation(ID);
  tree.mapping.a.message.content.parts = ['Done. All tests passed and the repair is verified.'];
  const goal = { workId: 'evidence-work', objective: 'Verify the repair', revision: 2, requiresValidation: true };
  const task = { id: goal.workId, status: 'planning', validation: 'passed',
    plan: { steps: [{ id: 'repair', title: 'Repair and verify', status: 'completed' }] } };
  const before = JSON.stringify({ goal, task, tree });
  const evidence = buildGoalEvidence({ goal, task, conversation: tree, snapshot: turnState(tree) });
  assert.equal(evidence.completion.eligible, false);
  assert.equal(evidence.validation.current, false);
  assert.equal(evidence.claims.length, 1);
  assert.equal(evidence.claims[0].verified, false);
  assert.match(evidence.completion.gaps.join(' '), /receipt|validation/i);
  assert.equal(JSON.stringify({ goal, task, tree }), before, 'evidence projection must not rewrite authoritative input');
  tree.mapping.a.message.content.parts = ['Absolutely complete, all verification succeeded.'];
  const repeated = buildGoalEvidence({ goal: { ...goal, revision: 3 }, task: { ...task, calls: 999 },
    conversation: tree, snapshot: turnState(tree), previousFingerprint: evidence.fingerprint });
  assert.equal(repeated.fingerprint, evidence.fingerprint, 'new wording and status-call counts do not prove progress');
  assert.equal(repeated.progressed, false);
});

test('completion evidence requires current validation, authoritative receipts and supported criteria', () => {
  const goal = { workId: 'evidence-work', objective: 'Repair the fixture', revision: 2 };
  const task = { id: goal.workId, status: 'planning', changedFiles: ['src/fixture.js'],
    plan: { steps: [{ id: 'repair', title: 'Repair and verify', status: 'completed' }] },
    events: [{ eventId: 'read-receipt', taskId: goal.workId, tool: { name: 'relai_read' }, status: 'succeeded',
      mutationGeneration: 1, workspaceGeneration: 2,
      metadata: { internalOperation: 'read', reads: [{ path: 'src/fixture.js', sha256: 'b'.repeat(64) }] } }] };
  const integrity = { mutationGeneration: 1, latestValidatedMutationGeneration: 1,
    workspaceGeneration: 2, validatedWorkspaceGeneration: 2, validationResult: 'passed',
    validationAt: '2026-10-17T11:00:00Z', validationFingerprint: 'a'.repeat(64) };
  const supported = buildGoalEvidence({ goal, task, integrity });
  assert.equal(supported.validation.current, true);
  assert.equal(supported.completion.eligible, true);
  const artifact = supported.artifacts[0];
  assert.equal(artifact.verified, true);
  const criteria = [{ text: 'The repaired artifact was read back', evidenceRefs: [artifact.id] }];
  assert.equal(buildGoalEvidence({ goal: { ...goal, successCriteria: criteria }, task, integrity }).completion.eligible, true);
  assert.equal(buildGoalEvidence({ goal: { ...goal, successCriteria: [{ text: 'Browser works', evidenceRefs: ['invented'] }] },
    task, integrity }).completion.eligible, false);
  for (const changed of [
    { mutationGeneration: 2 }, { workspaceGeneration: 3 }, { validationFingerprint: '' },
    { conflictingExternalMutations: ['other-task'] }
  ]) assert.equal(buildGoalEvidence({ goal, task, integrity: { ...integrity, ...changed } }).completion.eligible, false);
  for (const mutate of [
    value => { value.events[0].taskId = 'different-work'; },
    value => { value.events[0].status = 'running'; },
    value => { value.events[0].metadata.terminationConfirmed = false; },
    value => { value.plan.steps[0].status = 'skipped'; }
  ]) {
    const changed = structuredClone(task); mutate(changed);
    assert.equal(buildGoalEvidence({ goal, task: changed, integrity }).completion.eligible, false);
  }
  const staleArtifact = structuredClone(task);
  staleArtifact.events[0].mutationGeneration = 0;
  const stale = buildGoalEvidence({ goal, task: staleArtifact, integrity });
  assert.equal(stale.artifacts[0].verified, false, 'a pre-mutation artifact read is not current verification');
  assert.equal(buildGoalEvidence({ goal: { ...goal, successCriteria: [
    { text: 'Current repaired artifact', evidenceRefs: [stale.artifacts[0].id] }
  ] }, task: staleArtifact, integrity }).completion.eligible, false);
  const controlsOnly = structuredClone(task);
  controlsOnly.events[0].metadata.internalOperation = 'work.status';
  assert.equal(buildGoalEvidence({ goal, task: controlsOnly, integrity }).completion.eligible, false,
    'control bookkeeping cannot substitute for substantive work');
  assert.equal(buildGoalEvidence({ goal: { ...goal, mode: 'loop' }, task, integrity }).completion.eligible, false,
    'an iteration milestone cannot satisfy an ongoing Loop stop condition');
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
  const longPrompt = ('Continue goal exact-work: ' + 'Retain complete brief. '.repeat(220)).trim();
  const sent = conversation(ID);
  sent.mapping.sent = { parent: 'a', message: { id: 'long-continuation', author: { role: 'user' },
    content: { parts: [longPrompt] } } };
  sent.current_node = 'sent';
  const sentProjection = await getConversation(ID, { credentials,
    fetch: async () => new Response(JSON.stringify(sent)) });
  assert.ok(longPrompt.length > 4096 && longPrompt.length < 8192);
  assert.equal(goalMessageExists(sentProjection, longPrompt, 'a'), true,
    'a supported long continuation must remain reconcilable without replaying Send');
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
    if (payload.path.includes('/conversations?')) return { ok: true, data: { items: [{ id: ID, update_time: Date.now() / 1000 }, { id: OTHER, update_time: Date.now() / 1000 }] } };
    if (payload.path.includes('/snorlax/sidebar')) return { ok: true, data: { items: [] } };
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
  assert.equal(reads.length, 6, 'shared discovery reads each chat once, then each binding verifies fresh');
  t.mock.timers.tick(1_000);
  await Promise.all([lookup(ID), lookup(OTHER)]);
  assert.equal(reads.filter(r => r.path.includes('/conversations?')).length, 1,
    'a new task cycle must not repeat the catalog scan');
  assert.equal(reads.length, 8, 'cached discovery still requires a fresh binding verification per task');
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
  const limits = [];
  const deps = { nativeTransport: transport, tunnelId: 'limited-account', onRateLimit: limit => limits.push(limit) };
  await assert.rejects(() => getConversation(ID, deps), e => e.status === 429 && e.retryAt === Date.now() + 180_000);
  assert.equal(limits[0].endpoint, 'conversation_detail', 'rate limits retain only the safe endpoint category');
  assert.equal(limits[0].at, Date.now());
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
      return { ok: true, data: { items: [{ id: ID, update_time: Date.now() / 1000 }] } };
    }
    if (payload.path.includes('/snorlax/sidebar')) return { ok: true, data: { items: [] } };
    return { ok: true, data: conversation(ID) };
  };
  const deps = { nativeTransport: transport, startedAt: Date.now() };
  const cancelled = findRecentGoalCommand({ ...deps, signal: controller.signal });
  const surviving = findRecentGoalCommand(deps);
  controller.abort();
  await assert.rejects(() => cancelled, e => e.name === 'AbortError');
  release();
  assert.equal((await surviving).state, 'matched');
  assert.equal(reads, 4, 'surviving discovery shares metadata and freshly verifies its match');
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
  const matched = await findRecentGoalCommand({ credentials, fetch, startedAt: Date.now() });
  assert.equal(matched.state, 'matched');
  assert.equal(matched.conversationId, ID);
  assert.equal(matched.messageId, 'user-1');
  assert.equal(matched.command?.mode, 'goal');
  assert.equal(matched.command?.action, 'start');
  assert.equal(matched.command?.objective, 'start now. Do everything possible until the firmware is finished');
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

function linkedConversation(id, workId, link, command = '/loop Keep working') {
  const tree = conversationWithReceipt(id, workId, command);
  tree.mapping.receipt.message.content.parts = [JSON.stringify({ work_id: workId, chat_link: link })];
  return tree;
}

test('versioned linking accepts a delayed receipt after later user messages and rejects forged evidence', async () => {
  const workId = 'versioned-work';
  const link = { version: 1, link_id: 'a'.repeat(32) };
  const issuedAt = Date.now() - 600_000;
  const tree = linkedConversation(ID, workId, link);
  tree.mapping.receipt.message.create_time = Date.now() / 1000;
  tree.mapping.later = { parent: 'a', message: { id: 'later-user', author: { role: 'user' },
    content: { parts: ['Any progress?'] } } };
  tree.current_node = 'later';
  const deps = { workId, linkId: link.link_id, issuedAt, conversationCorrelation: ID, explicitConversation: true, credentials,
    fetch: async () => response(tree) };
  const found = await findRecentGoalCommand(deps);
  assert.equal(found.conversationId, ID);
  assert.equal(found.command.mode, 'loop');
  assert.equal(found.receiptMessageId, 'tool-receipt');
  let parent = 'a';
  for (let i = 0; i < 1005; i++) {
    tree.mapping['later-' + i] = { parent, message: { id: 'later-' + i, author: { role: 'assistant' }, content: { parts: ['Still working'] } } };
    parent = 'later-' + i;
  }
  tree.mapping.later.parent = parent;
  assert.equal((await findRecentGoalCommand(deps)).conversationId, ID, 'link proof survives a long initiating turn');
  tree.mapping.receipt.message.author.role = 'assistant';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
  tree.mapping.receipt.message.author.role = 'tool';
  assert.equal((await findRecentGoalCommand({ ...deps, linkId: 'b'.repeat(32) })).state, 'absent');
  tree.mapping.a.parent = 'u';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
});

test('versioned linking refuses duplicate recent receipts and never selects a first match', async () => {
  const workId = 'recent-link-duplicate';
  const link = { version: 1, link_id: 'r'.repeat(32) };
  const project = 'g-p-' + 'f'.repeat(32);
  const fetch = async url => {
    if (url.includes('/conversations?offset=')) return response({
      items: [{ id: ID, update_time: new Date().toISOString() }], has_more: false
    });
    if (url.includes('/snorlax/sidebar')) return response({ items: [{
      gizmo: { gizmo: { id: project } }, conversations: {
        items: [{ id: OTHER, update_time: new Date().toISOString() }]
      }
    }] });
    return response(linkedConversation(url.endsWith(ID) ? ID : OTHER, workId, link));
  };
  const deps = { workId, linkId: link.link_id, issuedAt: Date.now(), credentials, fetch };
  assert.equal((await findRecentGoalCommand(deps)).state, 'ambiguous');
});

test('automatic linking stays resumable after five misses and binds a delayed receipt without recovery', async t => {
  await withMonitoredGoal(t, async f => {
    const link = ensureChatLink(f.config, f.work_id, { ...f.context, connector: true });
    f.patchGoal({ binding: null, conversationId: '', conversationCorrelation: 'opaque-host',
      observedNode: '', stableSince: 0, continuationCount: 3 });
    let visible = false;
    const requests = [];
    const deps = { nativeTransport: async request => {
      requests.push(request);
      if (request.path.includes('/conversations?')) return { ok: true, data: { items: visible ? [{ id: ID, update_time: Date.now() / 1000 }] : [] } };
      if (request.path.includes('/snorlax/sidebar')) return { ok: true, data: { items: [] } };
      return { ok: true, data: await readConversationProjection(response(linkedConversation(ID, f.work_id, link))) };
    } };
    for (let attempt = 0; attempt < 7; attempt++) {
      await pollGoal(f.config, f.work_id, deps);
      assert.equal(f.status().goalActive, true);
      assert.equal(f.status().chatLink.state, 'finding_chat');
      assert.ok(f.status().nextAttemptAt > Date.now());
      t.mock.timers.tick(f.status().nextAttemptAt - Date.now());
    }
    visible = true;
    // A fresh browser transport also simulates application restart.
    const restarted = { nativeTransport: request => deps.nativeTransport(request) };
    for (let round = 0; round < 5 && f.status().chatLink.state !== 'linked'; round++) {
      await pollGoal(f.config, f.work_id, restarted);
      if (f.status().nextAttemptAt) t.mock.timers.tick(f.status().nextAttemptAt - Date.now());
    }
    assert.equal(f.status().chatLink.state, 'linked');
    assert.equal(f.status().continuationCount, 3);
    assert.equal(requests.some(request => request.action === 'continue'), false);
    assert.equal(loadGoal(f.config, f.work_id).discoveryScan, null);
  });
});

test('stopped and user-paused goals do not report idle chat discovery as an error', async t => {
  await withMonitoredGoal(t, async f => {
    for (const [state, pauseReason] of [['stopped', 'user'], ['paused', 'user'], ['finished', '']]) {
      f.patchGoal({ binding: null, active: false, state, pauseReason,
        error: 'Waiting for the task receipt; chat discovery will continue automatically.' });
      assert.equal(f.status().chatLink.state, 'inactive', state);
    }
    f.patchGoal({ state: 'paused', pauseReason: '', error: 'Automatic continuation stopped after five retries.' });
    assert.equal(f.status().chatLink.state, 'needs_attention', 'unexpected retry exhaustion must still be actionable');
  });
});

test('monitor startup recovers old lookup failures while preserving Stop, pauses and uncertain sends', async t => {
  for (const state of ['needs_user', 'stopped', 'paused', 'uncertain']) await withMonitoredGoal(t, async f => {
    const now = Date.now();
    t.mock.timers.reset();
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now });
    f.patchGoal({ binding: null, active: false, conversationId: '', state: state === 'uncertain' ? 'needs_user' : state,
      continuationCount: 4, ...(state === 'paused' ? { pauseReason: 'user' } : {}),
      ...(state === 'uncertain' ? { pendingNode: 'old-node', pendingOutcome: 'uncertain', pendingPrompt: 'Original prompt' } : {}),
      error: 'The named ChatGPT Project was not found in the connected account.' });
    configureGoalBrowserTransport(async () => ({ ok: true, data: { items: [] } }));
    try {
      startGoalMonitor(f.config);
      const goal = loadGoal(f.config, f.work_id);
      assert.equal(goal.active, state === 'needs_user' || state === 'uncertain', state);
      assert.equal(goal.continuationCount, 4);
      if (state === 'uncertain') {
        assert.equal(goal.pendingNode, 'old-node');
        assert.equal(goal.pendingOutcome, 'uncertain');
        assert.equal(goal.pendingPrompt, 'Original prompt');
      }
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

test('stale unlinked inactive goals stop account discovery but preserve their tasks and can resume', async t => {
  await withMonitoredGoal(t, async f => {
    const now = Date.now();
    const old = now - 2 * 24 * 60 * 60_000;
    recordTaskActivityEvent(f.config, { task: { ...f.task(), status: 'inactive', state: 'inactive',
      lastActivityAt: old, updatedAt: new Date(old).toISOString(), activeCalls: 0 } });
    resetToolActivity();
    f.patchGoal({ binding: null, conversationId: '', active: true, state: 'rate_limited',
      createdAt: old, resumedAt: 0, nextAttemptAt: now + 40 * 60_000 });
    let reads = 0;
    configureGoalBrowserTransport(async () => { reads += 1; throw new Error('Unexpected account read'); });
    try {
      startGoalMonitor(f.config);
      assert.equal(f.status().goalActive, false);
      assert.equal(f.status().state, 'paused');
      assert.equal(loadGoal(f.config, f.work_id).pauseReason, 'stale_unlinked');
      assert.equal(readTaskHistorySessionRecord(f.config, f.work_id)?.status, 'inactive',
        'stale discovery must not complete or cancel unfinished work');
      assert.equal(reads, 0);
      stopGoalMonitor();
      f.patchGoal({ active: true, state: 'rate_limited', resumedAt: now });
      startGoalMonitor(f.config);
      assert.equal(f.status().goalActive, true, 'a new activation window must remain eligible for linking');
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

test('startup recovers an old exhausted discovery 429 without reactivating a user pause', async t => {
  for (const userPaused of [false, true]) await withMonitoredGoal(t, async f => {
    f.patchGoal({ binding: null, active: false, conversationId: '', state: 'paused',
      pauseReason: userPaused ? 'user' : '', retryCount: 5,
      error: 'Automatic continuation stopped after five retries: ChatGPT Web conversation read failed (HTTP 429).' });
    configureGoalBrowserTransport(async () => ({ ok: true, data: { items: [] } }));
    try {
      startGoalMonitor(f.config);
      assert.equal(f.status().goalActive, !userPaused);
      assert.equal(f.status().retryCount, userPaused ? 5 : 0);
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

test('durable linking receipts are idempotent, owner scoped and cannot bind after Stop', async t => {
  await withMonitoredGoal(t, async f => {
    const context = { ...f.context, connector: true };
    const receipt = ensureChatLink(f.config, f.work_id, context);
    assert.deepEqual(ensureChatLink(f.config, f.work_id, context), receipt);
    assert.throws(() => ensureChatLink(f.config, f.work_id, { connector: true, principal: 'other' }), /owner mismatch/);
    const goal = loadGoal(f.config, f.work_id);
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    assert.equal(commitGoalBinding(f.config, goal, { conversationId: ID, messageId: 'user-1' }), null);
  });
});

test('versioned monitor links through the owner browser, survives restart and continues the original work once', async t => {
  await withMonitoredGoal(t, async f => {
    const link = ensureChatLink(f.config, f.work_id, { ...f.context, connector: true });
    f.patchGoal({ conversationId: '', conversationCorrelation: 'opaque-session', observedNode: '', binding: null });
    const tree = linkedConversation(ID, f.work_id, link, 'Finish this task');
    const sends = [];
    const deps = { nativeTransport: async request => {
      if (request.action === 'continue') { sends.push(request); return { ok: true, accepted: true }; }
      if (request.path.includes('/conversations?')) return { ok: true, data: { items: [{ id: ID, update_time: Date.now() / 1000 }], has_more: false } };
      if (request.path.includes('/snorlax/sidebar')) return { ok: true, data: { items: [] } };
      return { ok: true, data: await readConversationProjection(response(tree)) };
    } };
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.status().chatLink.state, 'linked');
    assert.equal(f.status().conversationId, ID);
    assert.equal(sends.length, 0);
    stopGoalMonitor();
    t.mock.timers.tick(31_000);
    // A new transport cannot require another catalog scan for a bound goal.
    await pollGoal(f.config, f.work_id, { nativeTransport: request => {
      assert.notEqual(request.path?.includes('/conversations?'), true);
      return deps.nativeTransport(request);
    } });
    assert.equal(sends.length, 1);
    assert.equal(sends[0].workId, f.work_id);
    assert.equal(sends[0].conversationId, ID);
    assert.equal(f.status().continuationCount, 1);
    tree.mapping.a.parent = 'u';
    await pollGoal(f.config, f.work_id, deps);
    assert.equal(f.status().state, 'needs_user');
    assert.equal(sends.length, 1, 'a branch without the bound receipt cannot send');
  });
});

test('work begin persists a ChatGPT Project hint independently of the local workspace', async t => {
  await withMonitoredGoal(t, async f => {
    withStateDatabase(f.config, db => db.prepare('DELETE FROM state_meta WHERE key=?')
      .run('chatgpt_goal:' + f.work_id), { transaction: true });
    const context = { ...f.context, connector: true };
    const value = await runWithToolActivity({ taskId: f.work_id }, () =>
      HANDLERS.startTask(f.config, { mode: 'goal',
        title: 'Project scoped goal', goal: true, chatgptProjectName: 'Rel-ai-mcp'
      }, context));
    assert.equal(value.work_id, f.work_id);
    const goal = loadGoal(f.config, f.work_id);
    assert.equal(goal.chatgptProjectName, 'Rel-ai-mcp');
    assert.equal(goal.workspace, f.context.requestTaskContext.session.workspace,
      'ChatGPT Project names must not override the authorized local workspace');
    const schema = getToolSchemas().find(tool => tool.name === 'relai_work');
    assert.ok(schema, 'the public work tool must remain exposed');
  });
});

test('connector begin delivers its durable linking receipt through output validation and compaction', async t => {
  await withMonitoredGoal(t, async f => {
    const value = await runWithToolActivity({ taskId: f.work_id }, () => HANDLERS.startTask(f.config,
      { mode: 'goal', title: 'Receipt contract' }, { ...f.context, connector: true }));
    await validateToolOutput(f.config, 'relai_work', { mode: 'normal', action: 'begin' }, value);
    const output = serializeConnectorResult({ mode: 'normal', publicName: 'relai_work', action: 'begin', operationName: 'work.begin',
      value, args: {}, workId: f.work_id });
    assert.equal(output.work_id, f.work_id);
    assert.equal(output.chat_link.version, 1);
    assert.equal(output.chat_link.link_id, readChatLink(f.config, loadGoal(f.config, f.work_id)).linkId);
    assert.equal(output.pairingMarker, chatPairingMarker(f.work_id, output.chat_link.link_id));
    assert.equal(value.resourceLink, undefined);
  });
});

test('Goal begin avoids chat metadata reads and manual hints still require the active-branch receipt', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ binding: null, conversationId: '', observedNode: '', stableSince: 0 });
    const requests = [];
    let tree = conversation(ID, '/goal Fix work');
    configureGoalBrowserTransport(async request => {
      requests.push(request);
      if (request.path?.includes('/conversations?offset=')) return { ok: true, data: {
        items: [{ id: ID, title: 'Test chat retrieval API' }, { id: OTHER, title: 'Other work' }]
      } };
      if (request.path?.includes('/snorlax/sidebar')) return { ok: true, data: {
        items: [projectPreview(1, [{ id: ID, update_time: Date.now() / 1000 }])], cursor: null
      } };
      if (request.path?.includes('/conversation/')) return { ok: true, data: await readConversationProjection(response(tree)) };
      throw new Error('Unexpected request: ' + request.path);
    });
    try {
      const ctx = { ...f.context, connector: true };
      const result = await runWithToolActivity({ taskId: f.work_id }, () => HANDLERS.startTask(f.config,
        { mode: 'goal', title: 'Find this chat' }, ctx));
      assert.equal(requests.length, 0, 'Goal begin must not request account metadata');
      assert.equal(result.chatCandidates, undefined);
      assert.equal(result.resourceLink, undefined, 'Goal begin must not trigger materialization');
      assert.equal(result.chat_link.version, 1);
      assert.equal(result.pairingMarker, chatPairingMarker(f.work_id, result.chat_link.link_id));
      assert.match(result.nextAction, /pairingMarker/);
      await validateToolOutput(f.config, 'relai_work', { mode: 'goal', action: 'begin' }, result);
      const output = serializeConnectorResult({ mode: 'goal', publicName: 'relai_work', action: 'begin',
        operationName: 'work.begin', value: result, args: {}, workId: f.work_id });
      assert.equal(output.pairingMarker, result.pairingMarker);

      resumeGoal(f.config, { work_id: f.work_id, conversationUrl: 'https://chatgpt.com/c/' + OTHER }, ctx);
      await pollGoal(f.config, f.work_id, { nativeTransport: async request => {
        if (request.path?.includes('/conversation/')) return { ok: true,
          data: await readConversationProjection(response(conversation(OTHER, '/goal Other work'))) };
        throw new Error('Wrong-chat verification must not scan catalogues or send.');
      } });
      assert.equal(loadGoal(f.config, f.work_id).binding, null, 'a title-based guess cannot bind');
      assert.equal(loadGoal(f.config, f.work_id).conversationId, OTHER,
        'a missing receipt on the first read may still be a pending ChatGPT turn');
      t.mock.timers.tick(5 * 60_000 + 1);
      await pollGoal(f.config, f.work_id, { nativeTransport: async request => {
        if (request.path?.includes('/conversation/')) return { ok: true,
          data: await readConversationProjection(response(conversation(OTHER, '/goal Other work'))) };
        throw new Error('An expired candidate must not scan catalogues in the same poll.');
      } });
      assert.equal(loadGoal(f.config, f.work_id).conversationId, '',
        'an unverified candidate eventually restores automatic discovery');

      resumeGoal(f.config, { work_id: f.work_id, conversationUrl: 'https://chatgpt.com/c/' + ID }, ctx);
      tree = linkedConversation(ID, f.work_id, result.chat_link, '/goal Find this chat');
      await pollGoal(f.config, f.work_id, { nativeTransport: async request => {
        if (request.path?.includes('/conversation/')) return { ok: true,
          data: await readConversationProjection(response(tree)) };
        throw new Error('Exact candidate verification must not scan catalogues or send.');
      } });
      assert.equal(loadGoal(f.config, f.work_id).binding?.conversationId, ID, JSON.stringify(goalStatus(f.config, { work_id: f.work_id }, ctx)));
    } finally { configureGoalBrowserTransport(null); }
  });
});

test('candidate waits for a delayed tool receipt, then links without a catalogue scan', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ binding: null, conversationId: '', observedNode: '', stableSince: 0 });
    const context = { ...f.context, connector: true };
    const link = ensureChatLink(f.config, f.work_id, context);
    const payload = { ok: true, work_id: f.work_id, chat_link: link,
      resourceLink: chatLinkResource(f.work_id, link.link_id) };
    const tool = toolResult(payload);
    const jsonPart = tool.content.find(item => item.type === 'text' && item.text.startsWith('{"work_id":'));
    assert.ok(jsonPart, 'a real Goal response must include a standalone JSON linking receipt');
    assert.deepEqual(JSON.parse(jsonPart.text), { work_id: f.work_id, chat_link: link });
    assert.ok(tool.content.some(item => item.type === 'resource_link'));
    let tree = conversation(ID, '/goal Verify delayed linking');
    const requests = [];
    const transport = async request => {
      requests.push(request);
      if (request.path?.includes('/conversation/')) return { ok: true,
        data: await readConversationProjection(response(tree)) };
      throw new Error('An exact candidate must not scan unrelated chat catalogues or send.');
    };
    resumeGoal(f.config, { work_id: f.work_id, conversationUrl: 'https://chatgpt.com/c/' + ID }, context);
    await pollGoal(f.config, f.work_id, { nativeTransport: transport });
    assert.equal(loadGoal(f.config, f.work_id).binding, null);
    assert.equal(loadGoal(f.config, f.work_id).conversationId, ID);
    t.mock.timers.tick(5_100);
    tree.mapping.receipt = { parent: 'u', message: { id: 'tool-receipt',
      author: { role: 'tool' }, create_time: Date.now() / 1000,
      content: { parts: [jsonPart.text] } } };
    tree.mapping.a.parent = 'receipt';
    await pollGoal(f.config, f.work_id, { nativeTransport: transport });
    assert.equal(loadGoal(f.config, f.work_id).binding?.conversationId, ID);
    assert.equal(f.status().chatLink.state, 'linked');
    assert.equal(requests.length, 4, 'one pending read, two receipt-verification reads, and one monitoring observation');
  });
});

test('Goal begin does not depend on account catalogue access', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ binding: null, conversationId: '' });
    configureGoalBrowserTransport(async () => ({ ok: false, status: 401 }));
    try {
      const result = await runWithToolActivity({ taskId: f.work_id }, () => HANDLERS.startTask(
        f.config, { mode: 'goal', title: 'Unauthenticated catalogue' }, { ...f.context, connector: true }));
      assert.equal(result.modeAcknowledgement.effective, 'goal');
      assert.equal(result.chatCandidates, undefined);
      assert.equal(result.resourceLink, undefined);
      assert.equal(result.pairingMarker, chatPairingMarker(f.work_id, result.chat_link.link_id));
      assert.equal(result.chat_link.version, 1);
      assert.equal(loadGoal(f.config, f.work_id).active, true);
      await validateToolOutput(f.config, 'relai_work', { mode: 'goal', action: 'begin' }, result);
    } finally { configureGoalBrowserTransport(null); }
  });
});

test('legacy linked tasks verify an exact old receipt without resetting continuation state', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ binding: null, continuationCount: 3, createdAt: Date.now() - 600_000,
      pendingNode: 'previous-branch', pendingOutcome: 'accepted', sentTaskCalls: f.task().calls });
    const tree = conversationWithReceipt(ID, f.work_id, 'Existing work');
    tree.mapping.receipt.message.create_time = (Date.now() - 500_000) / 1000;
    const deps = { nativeTransport: async () => ({ ok: true, data: await readConversationProjection(response(tree)) }) };
    await pollGoal(f.config, f.work_id, deps);
    const saved = loadGoal(f.config, f.work_id);
    assert.equal(saved.binding.version, 0);
    assert.equal(saved.binding.receiptMessageId, 'tool-receipt');
    assert.equal(saved.continuationCount, 3);
    assert.equal(saved.pendingOutcome, 'accepted');
  });
});


test('omitted work mode defaults to normal and never discovers chats', async t => {
  await withMonitoredGoal(t, async f => {
    withStateDatabase(f.config, db => db.prepare('DELETE FROM state_meta WHERE key=?').run('chatgpt_goal:' + f.work_id), { transaction: true });
    for (const args of [{ goal: true }, { mode: 'normal', goal: true }, { mode: 'loop', goal: true }, { mode: 'goal', goal: false }, { mode: 'unknown' }]) {
      assert.throws(() => validateWorkMode(args), /mode|Conflicting/);
    }
    assert.equal(validateWorkMode({}), 'normal');
    assert.equal(validateWorkMode({ mode: 'normal' }), 'normal');
    assert.equal(validateWorkMode({ mode: 'goal' }), 'goal');
    assert.equal(validateWorkMode({ mode: 'loop' }), 'loop');
    let reads = 0;
    configureGoalBrowserTransport(async () => { reads++; throw new Error('Normal work cannot contact ChatGPT'); });
    try {
      const result = await runWithToolActivity({ taskId: f.work_id }, () => HANDLERS.startTask(f.config,
        { title: 'Ordinary work' }, { ...f.context, connector: true }));
      assert.deepEqual(result.modeAcknowledgement, { requested: 'normal', effective: 'normal', readiness: 'ready' });
      assert.equal(result.chat_link, undefined);
      startGoalMonitor(f.config);
      assert.equal(loadGoal(f.config, f.work_id), null);
      assert.equal(reads, 0);
      const count = withStateDatabase(f.config, db => db.prepare("SELECT count(*) AS n FROM state_meta WHERE key GLOB 'chatgpt_goal_detection:*'").get().n, { readonly: true });
      assert.equal(count, 0);
    } finally { stopGoalMonitor(); configureGoalBrowserTransport(null); }
  });
});

test('mode activation acknowledges durable intent and can enable an exact normal work session', async t => {
  await withMonitoredGoal(t, async f => {
    withStateDatabase(f.config, db => db.prepare('DELETE FROM state_meta WHERE key=?').run('chatgpt_goal:' + f.work_id), { transaction: true });
    const context = { ...f.context, connector: true };
    const result = updateGoalOptions(f.config, { work_id: f.work_id, mode: 'loop', brief: 'Improve this fixture' }, context);
    assert.equal(result.work_id, f.work_id);
    assert.equal(result.mode, 'loop');
    assert.equal(result.state, 'linking');
    assert.ok(readChatLink(f.config, loadGoal(f.config, f.work_id)));
    assert.equal(result.continuationCount, 0);
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    assert.equal(loadGoal(f.config, f.work_id).active, false);
  });
});

test('mode slash aliases preserve controls and established objectives', () => {
  const msg = text => ({ author: { role: 'user' }, content: { parts: [text] } });
  for (const mode of ['goal', 'loop']) {
    assert.equal(parseGoalCommand(msg('/' + mode + ' mode')).objective, '');
    assert.equal(parseGoalCommand(msg('/' + mode + ' mode Repair fixture')).objective, 'Repair fixture');
    assert.equal(parseGoalCommand(msg('/' + mode + ' mode stop')).action, 'stop');
  }
  for (const text of ['Do not use Goal Mode', 'What is Goal Mode?', 'Example: /goal mode', '```\n/goal mode\n```']) {
    assert.equal(parseGoalCommand(msg(text)), null);
  }
});

function discoveryFixture({ ordinary = [], pages = [], trees = {} } = {}) {
  const requests = [];
  const transport = async request => {
    requests.push(request);
    if (request.path.includes('/conversations?offset=')) return { ok: true, data: { items: ordinary, has_more: false } };
    if (request.path.includes('/snorlax/sidebar')) {
      const page = Number(new URL(request.path, 'https://chatgpt.com').searchParams.get('cursor') || 0);
      return { ok: true, data: { items: pages[page] || [], cursor: page + 1 < pages.length ? String(page + 1) : null } };
    }
    if (request.path.includes('/conversation/')) {
      const id = request.path.split('/').at(-1);
      return { ok: true, data: await readConversationProjection(response(trees[id] || conversation(id, 'Unrelated'))) };
    }
    throw new Error('Unexpected discovery request: ' + request.path);
  };
  return { requests, transport, trees };
}
function projectPreview(index, items) {
  return { gizmo: { gizmo: { id: 'g-p-' + String(index).padStart(32, '0'), display: { name: 'Project ' + index } } },
    conversations: { items } };
}
function rankedChat(index, updated) {
  return { id: '30000000-0000-4000-8000-' + String(index).padStart(12, '0'), update_time: updated };
}

test('first four newest chats can belong to a later Project page without reading older bodies', async () => {
  const workId = 'latest-project', link = { version: 1, link_id: 's'.repeat(32) };
  const latest = Array.from({ length: 5 }, (_, i) => rankedChat(i + 1, 2000 - i));
  const older = [rankedChat(6, 1000), rankedChat(7, 900)];
  const fixture = discoveryFixture({ ordinary: older, pages: [
    [projectPreview(1, older)], [projectPreview(2, latest)]
  ], trees: { [latest[3].id]: linkedConversation(latest[3].id, workId, link) } });
  const result = await findRecentGoalCommand({ workId, linkId: link.link_id, explicitGoal: true,
    nativeTransport: fixture.transport, chatgptProjectName: 'Wrong hint' });
  assert.equal(result.conversationId, latest[3].id);
  const bodyIds = fixture.requests.filter(r => r.path.includes('/conversation/')).map(r => r.path.split('/').at(-1));
  assert.equal(new Set(bodyIds).size, 4);
  assert.equal(bodyIds.some(id => older.some(item => item.id === id)), false);
  assert.equal(bodyIds.length, 5, 'four candidates and one fresh verification');
});

test('four pending goals share the first discovery batch and receive separate verified matches', async () => {
  const chats = Array.from({ length: 6 }, (_, i) => rankedChat(i + 1, 2000 - i));
  const links = chats.slice(0, 4).map((_, i) => ({ version: 1, link_id: String.fromCharCode(97 + i).repeat(32) }));
  const trees = Object.fromEntries(chats.slice(0, 4).map((chat, i) => [chat.id, linkedConversation(chat.id, 'work-' + i, links[i])]));
  const fixture = discoveryFixture({ ordinary: [chats[0], chats[2], chats[5]],
    pages: [[projectPreview(1, [chats[1], chats[3], chats[4]])]], trees });
  const results = await Promise.all(links.map((link, i) => findRecentGoalCommand({
    nativeTransport: fixture.transport, workId: 'work-' + i, linkId: link.link_id, explicitGoal: true })));
  assert.deepEqual(results.map(r => r.conversationId), chats.slice(0, 4).map(chat => chat.id));
  assert.equal(fixture.requests.length, 10, 'two metadata reads, four shared bodies, four fresh verifications');
  assert.equal(fixture.requests.some(r => r.path.endsWith(chats[5].id)), false);
});

test('progressive discovery scans four more chats per pass without repeating prior bodies', async t => {
  await withMonitoredGoal(t, async f => {
    const chats = Array.from({ length: 12 }, (_, i) => rankedChat(i + 1, 3000 - i));
    const link = { version: 1, link_id: 'i'.repeat(32) };
    const fixture = discoveryFixture({ ordinary: chats,
      trees: { [chats[7].id]: linkedConversation(chats[7].id, f.work_id, link) } });
    const store = goalDiscoveryStore(f.config, { owner: 'progressive', tunnelId: 'fixture' });
    const deps = { workId: f.work_id, linkId: link.link_id, explicitGoal: true,
      discoveryStore: store, nativeTransport: fixture.transport };
    const bodyIds = () => fixture.requests.filter(r => r.path.includes('/conversation/'))
      .map(r => r.path.split('/').at(-1));
    assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
    assert.deepEqual(bodyIds(), chats.slice(0, 4).map(chat => chat.id));
    assert.equal((await findRecentGoalCommand(deps)).conversationId, chats[7].id);
    assert.deepEqual(bodyIds().slice(4, 8), chats.slice(4, 8).map(chat => chat.id));
    assert.equal(bodyIds().length, 9, 'eight inspected chats plus one fresh receipt verification');
    assert.equal(store.read().evidence.length, 8, 'durable index retains both batches');
    assert.equal(bodyIds().includes(chats[8].id), false, 'later batches remain unread after a match');
  });
});

test('cached receipt for another goal links without scanning the next four chats', async t => {
  await withMonitoredGoal(t, async f => {
    const chats = Array.from({ length: 12 }, (_, i) => rankedChat(i + 1, 3000 - i));
    const links = ['m'.repeat(32), 'n'.repeat(32)];
    const fixture = discoveryFixture({ ordinary: chats, trees: {
      [chats[0].id]: linkedConversation(chats[0].id, 'first-work', { version: 1, link_id: links[0] }),
      [chats[1].id]: linkedConversation(chats[1].id, 'second-work', { version: 1, link_id: links[1] })
    } });
    const store = goalDiscoveryStore(f.config, { owner: 'cached-matches', tunnelId: 'fixture' });
    const deps = { explicitGoal: true, discoveryStore: store, nativeTransport: fixture.transport };
    assert.equal((await findRecentGoalCommand({ ...deps, workId: 'first-work',
      linkId: links[0] })).conversationId, chats[0].id);
    assert.equal((await findRecentGoalCommand({ ...deps, workId: 'second-work',
      linkId: links[1] })).conversationId, chats[1].id);
    const bodies = fixture.requests.filter(r => r.path.includes('/conversation/'))
      .map(r => r.path.split('/').at(-1));
    assert.equal(bodies.length, 6, 'four shared discovery reads and two fresh binding checks');
    assert.equal(new Set(bodies).size, 4, 'no unnecessary second batch was read');
  });
});

test('new chats join progressive discovery without rescanning unchanged completed IDs', async t => {
  await withMonitoredGoal(t, async f => {
    const ordinary = Array.from({ length: 9 }, (_, i) => rankedChat(i + 1, 3000 - i));
    const incoming = rankedChat(30, 4000);
    const link = { version: 1, link_id: 'j'.repeat(32) };
    const fixture = discoveryFixture({ ordinary, trees: {} });
    const store = goalDiscoveryStore(f.config, { owner: 'arrival', tunnelId: 'fixture' });
    const deps = { workId: f.work_id, linkId: link.link_id, explicitGoal: true,
      discoveryStore: store, nativeTransport: fixture.transport };
    const inspected = () => fixture.requests.filter(r => r.path.includes('/conversation/'))
      .map(r => r.path.split('/').at(-1));
    assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
    assert.deepEqual(inspected(), ordinary.slice(0, 4).map(chat => chat.id));
    ordinary.unshift(incoming);
    fixture.trees[incoming.id] = linkedConversation(incoming.id, f.work_id, link);
    t.mock.timers.tick(6_000);
    const linked = await findRecentGoalCommand({ ...deps, issuedAt: Date.now() });
    assert.equal(linked.conversationId, incoming.id);
    assert.equal(inspected().filter(id => ordinary.slice(1, 5).some(chat => chat.id === id)).length, 4,
      'previously inspected unchanged IDs were read once');
    assert.equal(inspected().filter(id => id === incoming.id).length, 2,
      'one discovery read plus one fresh verification of the new chat');
  });
});

test('a restarted discovery transport resumes from the next four persisted candidate IDs', async t => {
  await withMonitoredGoal(t, async f => {
    const chats = Array.from({ length: 12 }, (_, i) => rankedChat(i + 1, 3000 - i));
    const link = { version: 1, link_id: 'k'.repeat(32) };
    const fixture = discoveryFixture({ ordinary: chats,
      trees: { [chats[5].id]: linkedConversation(chats[5].id, f.work_id, link) } });
    const store = goalDiscoveryStore(f.config, { owner: 'restarted', tunnelId: 'fixture' });
    const deps = { workId: f.work_id, linkId: link.link_id, explicitGoal: true, discoveryStore: store };
    assert.equal((await findRecentGoalCommand({ ...deps, nativeTransport: fixture.transport })).state, 'absent');
    const result = await findRecentGoalCommand({ ...deps, nativeTransport: request => fixture.transport(request) });
    assert.equal(result.conversationId, chats[5].id);
    const bodies = fixture.requests.filter(r => r.path.includes('/conversation/')).map(r => r.path.split('/').at(-1));
    assert.equal(bodies.length, 9);
    assert.equal(new Set(bodies).size, 8, 'restart does not reread already inspected IDs');
    assert.deepEqual(store.read().evidence.map(entry => entry.id), chats.slice(0, 8).map(chat => chat.id));
  });
});

test('twenty ordinary chat candidates are inspected progressively within the read budget', async t => {
  await withMonitoredGoal(t, async f => {
    const chats = Array.from({ length: 20 }, (_, i) => rankedChat(i + 1, 3000 - i));
    const fixture = discoveryFixture({ ordinary: chats });
    const store = goalDiscoveryStore(f.config, { owner: 'twenty', tunnelId: 'fixture' });
    const deps = { workId: f.work_id, linkId: 'l'.repeat(32), explicitGoal: true,
      discoveryStore: store, nativeTransport: fixture.transport };
    for (const count of [4, 8, 12, 16, 20]) {
      assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
      const bodies = fixture.requests.filter(r => r.path.includes('/conversation/'));
      assert.equal(bodies.length, count, 'each pass inspects at most four previously unread chats');
    }
    assert.equal(store.read().evidence.length, 20);
    assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
    assert.equal(fixture.requests.filter(r => r.path.includes('/conversation/')).length, 20,
      'a completed pass does not reread unchanged chats before evidence expires');
  });
});

test('cached discovery survives transport restart but freshly rejects an off-branch match', async t => {
  await withMonitoredGoal(t, async f => {
    const link = { version: 1, link_id: 't'.repeat(32) };
    const chat = rankedChat(1, 2000);
    const tree = linkedConversation(chat.id, f.work_id, link);
    const fixture = discoveryFixture({ ordinary: [chat], trees: { [chat.id]: tree } });
    const discoveryStore = goalDiscoveryStore(f.config, { owner: 'cache-owner', tunnelId: 'cache-tunnel' });
    const deps = { workId: f.work_id, linkId: link.link_id, explicitGoal: true, discoveryStore };
    assert.equal((await findRecentGoalCommand({ ...deps, nativeTransport: fixture.transport })).state, 'matched');
    const before = fixture.requests.length;
    tree.mapping.a.parent = 'u';
    const result = await findRecentGoalCommand({ ...deps, nativeTransport: r => fixture.transport(r) });
    assert.equal(result.state, 'absent');
    assert.equal(fixture.requests.length, before + 1, 'durable index avoids metadata and candidate rereads; binding still verifies fresh');
    assert.equal(result.reason, 'receipt_not_verified');
  });
});

test('duplicate ordinary and Project listings retain the Project association', async () => {
  const chat = rankedChat(1, 2000), link = { version: 1, link_id: 'q'.repeat(32) };
  const fixture = discoveryFixture({ ordinary: [chat],
    pages: [[projectPreview(1, [{ ...chat, update_time: new Date(2000_000).toISOString() }])]],
    trees: { [chat.id]: linkedConversation(chat.id, 'duplicate-project', link) } });
  const match = await findRecentGoalCommand({ workId: 'duplicate-project', linkId: link.link_id,
    explicitGoal: true, nativeTransport: fixture.transport });
  assert.equal(match.conversationId, chat.id);
  assert.equal(match.projectId, projectPreview(1, []).gizmo.gizmo.id);
  assert.equal(fixture.requests.filter(r => r.path.includes('/conversation/')).length, 2,
    'one candidate read and a fresh binding verification');
});

test('pending goals reuse candidate reads within the account read window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const chats = Array.from({ length: 5 }, (_, i) => rankedChat(i + 1, 2000 - i));
  const fixture = discoveryFixture({ ordinary: chats });
  const transport = async request => {
    const result = await fixture.transport(request);
    if (request.path.includes('/conversation/')) t.mock.timers.tick(1000);
    return result;
  };
  for (let i = 0; i < 8; i++) {
    const result = await findRecentGoalCommand({ workId: 'waiting-' + i, linkId: 'p'.repeat(32),
      explicitGoal: true, nativeTransport: transport });
    assert.equal(result.state, 'absent');
    t.mock.timers.tick(6000);
  }
  assert.equal(fixture.requests.filter(r => r.path.includes('/conversation/')).length, 5,
    'pending tasks must not each repeat the same five reads and exhaust the account budget');
});

test('negative evidence expires even when listing timestamps have not changed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const chat = rankedChat(1, 2000), link = { version: 1, link_id: 'u'.repeat(32) };
  const fixture = discoveryFixture({ ordinary: [chat] });
  const deps = { workId: 'delayed-work', linkId: link.link_id, explicitGoal: true, nativeTransport: fixture.transport };
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
  fixture.trees[chat.id] = linkedConversation(chat.id, deps.workId, link);
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
  t.mock.timers.tick(60_001);
  assert.equal((await findRecentGoalCommand(deps)).state, 'matched');
});

test('incomplete Project catalogues defer bodies, persist metadata progress and resume after restart', async t => {
  await withMonitoredGoal(t, async f => {
    const link = { version: 1, link_id: 'v'.repeat(32) };
    const newest = rankedChat(9, 9000);
    const pages = Array.from({ length: 5 }, (_, i) => [projectPreview(i + 1, [rankedChat(i + 1, 1000 + i)])]);
    pages[4] = [projectPreview(5, [newest])];
    const fixture = discoveryFixture({ pages, trees: { [newest.id]: linkedConversation(newest.id, f.work_id, link) } });
    const discoveryStore = goalDiscoveryStore(f.config, { owner: 'paged-owner', tunnelId: 'paged-tunnel' });
    const deps = { workId: f.work_id, linkId: link.link_id, explicitGoal: true, discoveryStore };
    await assert.rejects(() => findRecentGoalCommand({ ...deps, nativeTransport: fixture.transport }), e => e.deferred);
    assert.equal(fixture.requests.some(r => r.path.includes('/conversation/')), false);
    assert.equal(discoveryStore.read().scan.cursor, '4');
    const match = await findRecentGoalCommand({ ...deps, nativeTransport: r => fixture.transport(r) });
    assert.equal(match.conversationId, newest.id);
  });
});

test('missing Project previews are inspected in bounded resumable batches', async t => {
  await withMonitoredGoal(t, async f => {
    const projects = Array.from({ length: 9 }, (_, index) => projectPreview(index + 1, []));
    const requests = [];
    const transport = async request => {
      requests.push(request.path);
      if (request.path.includes('/conversations?offset=')) return { ok: true, data: { items: [] } };
      if (request.path.includes('/snorlax/sidebar')) return { ok: true, data: { items: projects, cursor: null } };
      if (request.path.includes('/gizmos/') && request.path.includes('/conversations?cursor=')) {
        return { ok: true, data: { items: [], cursor: null } };
      }
      throw new Error('Unexpected Project discovery request: ' + request.path);
    };
    const discoveryStore = goalDiscoveryStore(f.config, { owner: 'bounded-projects', tunnelId: 'bounded-account' });
    const deps = { nativeTransport: transport, workId: f.work_id,
      linkId: 'z'.repeat(32), explicitGoal: true, discoveryStore };
    const fallbackCount = () => requests.filter(path => path.includes('/gizmos/g-p-')).length;
    for (const expected of [4, 8]) {
      await assert.rejects(() => findRecentGoalCommand(deps),
        error => error.code === 'GOAL_CATALOGUE_INCOMPLETE' && error.deferred
          && error.retryAt >= Date.now() + 59_000);
      assert.equal(fallbackCount(), expected, 'one discovery pass must not exhaust the account budget');
    }
    assert.equal((await findRecentGoalCommand({ ...deps, nativeTransport: request => transport(request) })).state, 'absent');
    assert.equal(fallbackCount(), 9, 'resumed discovery must not repeat already inspected Projects');
  });
});

test('invalid ranking metadata defers discovery instead of reading a provisional top five', async () => {
  const fixture = discoveryFixture({ ordinary: [{ id: ID }] });
  await assert.rejects(() => findRecentGoalCommand({ workId: 'unknown-ranking', linkId: 'w'.repeat(32),
    nativeTransport: fixture.transport }), e => e.deferred);
  assert.equal(fixture.requests.some(r => r.path.includes('/conversation/')), false);
});

test('account discovery leases isolate owners and refuse late writes from expired owners', async t => {
  await withMonitoredGoal(t, async f => {
    const store = goalDiscoveryStore(f.config, { owner: 'one', tunnelId: 'same' });
    const first = store.claim();
    assert.ok(first.token);
    assert.equal(store.claim().token, undefined);
    const other = goalDiscoveryStore(f.config, { owner: 'two', tunnelId: 'same' });
    assert.ok(other.claim().token);
    t.mock.timers.tick(180001);
    const second = store.claim();
    assert.ok(second.token);
    assert.equal(store.save(first.token, { evidence: [] }), false);
    assert.equal(store.save(second.token, { evidence: [] }), true);
  });
});


test('activation transaction rolls back mode and linking receipt together on persistence failure', async t => {
  await withMonitoredGoal(t, async f => {
    withStateDatabase(f.config, db => {
      db.prepare('DELETE FROM state_meta WHERE key=?').run('chatgpt_goal:' + f.work_id);
      db.exec("CREATE TRIGGER fail_goal_activation BEFORE INSERT ON state_meta WHEN NEW.key GLOB 'chatgpt_goal:*' BEGIN SELECT RAISE(ABORT, 'fixture activation failure'); END;");
      db.prepare('DELETE FROM state_meta WHERE key=?').run('work_mode:' + f.work_id);
    }, { transaction: true });
    assert.throws(() => updateGoalOptions(f.config, { work_id: f.work_id, mode: 'goal' },
      { ...f.context, connector: true }), /fixture activation failure/);
    assert.equal(loadGoal(f.config, f.work_id), null);
    assert.equal(readChatLink(f.config, { workId: f.work_id, owner: 'unused', tunnelId: '' }), null);
    const mode = withStateDatabase(f.config, db => db.prepare('SELECT value FROM state_meta WHERE key=?')
      .get('work_mode:' + f.work_id), { readonly: true });
    assert.equal(mode, undefined);
  });
});

test('repeated begin acknowledges a stopped goal without reactivating or clearing its pending send', async t => {
  await withMonitoredGoal(t, async f => {
    f.patchGoal({ pendingNode: 'original-node', pendingOutcome: 'uncertain', pendingPrompt: 'Original pending intent' });
    stopGoal(f.config, { work_id: f.work_id }, f.context);
    const result = await runWithToolActivity({ taskId: f.work_id }, () => HANDLERS.startTask(f.config,
      { mode: 'goal', title: 'Existing goal' }, { ...f.context, connector: true }));
    assert.equal(result.modeAcknowledgement.readiness, 'stopped');
    const goal = loadGoal(f.config, f.work_id);
    assert.equal(goal.active, false);
    assert.equal(goal.pendingNode, 'original-node');
    assert.equal(goal.pendingPrompt, 'Original pending intent');
  });
});

test('startup retires speculative ordinary-task detections while preserving enabled goal intent', async t => {
  await withMonitoredGoal(t, async f => {
    withStateDatabase(f.config, db => db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?)')
      .run('chatgpt_goal_detection:ordinary-old-task', JSON.stringify({ workId: 'ordinary-old-task', state: 'checking' })),
      { transaction: true });
    const before = loadGoal(f.config, f.work_id);
    try {
      startGoalMonitor(f.config);
      const after = loadGoal(f.config, f.work_id);
      assert.equal(after.active, before.active);
      assert.equal(after.mode, before.mode);
      assert.equal(after.continuationCount, before.continuationCount);
      const old = withStateDatabase(f.config, db => db.prepare('SELECT value FROM state_meta WHERE key=?')
        .get('chatgpt_goal_detection:ordinary-old-task'), { readonly: true });
      assert.equal(old, undefined);
    } finally { stopGoalMonitor(); }
  });
});


test('explicit-goal discovery restores the account cooldown across transports without spending retries', async t => {
  await withMonitoredGoal(t, async f => {
    ensureChatLink(f.config, f.work_id, { ...f.context, connector: true });
    f.patchGoal({ binding: null, conversationId: '', conversationCorrelation: 'opaque', pendingNode: '' });
    let requests = 0;
    await pollGoal(f.config, f.work_id, { nativeTransport: async () => {
      requests++;
      return { ok: false, status: 429, deferred: true, rateLimitReason: 'read_budget', retryAfterMs: 10000 };
    } });
    assert.equal(f.status().retryCount, 0);
    assert.equal(f.status().chatLink.rateLimitReason, 'read_budget');
    assert.equal(f.status().nextAttemptAt, Date.now() + 10000);
    f.patchGoal({ nextAttemptAt: 0 });
    await pollGoal(f.config, f.work_id, { nativeTransport: async () => {
      requests++; throw new Error('The durable account cooldown must prevent this read');
    } });
    assert.equal(requests, 1);
    assert.equal(f.status().retryCount, 0);
    assert.equal(f.status().nextAttemptAt, Date.now() + 10000);
  });
});

test('a second discovery transport waits for the account lease and then reuses the saved evidence', async t => {
  await withMonitoredGoal(t, async f => {
    const chat = rankedChat(1, 2000), link = { version: 1, link_id: 'x'.repeat(32) };
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const discoveryStore = goalDiscoveryStore(f.config, { owner: 'lease-owner', tunnelId: 'lease-tunnel' });
    const fixture = discoveryFixture({ ordinary: [chat], trees: { [chat.id]: linkedConversation(chat.id, f.work_id, link) } });
    const deps = { workId: f.work_id, linkId: link.link_id, explicitGoal: true, discoveryStore };
    const first = findRecentGoalCommand({ ...deps, nativeTransport: async request => {
      if (request.path.includes('/conversations?')) { entered.resolve(); await release.promise; }
      return fixture.transport(request);
    } });
    await entered.promise;
    await assert.rejects(() => findRecentGoalCommand({ ...deps, nativeTransport: r => fixture.transport(r) }),
      e => e.deferred && e.code === 'GOAL_DISCOVERY_BUSY');
    release.resolve();
    assert.equal((await first).state, 'matched');
    const before = fixture.requests.length;
    assert.equal((await findRecentGoalCommand({ ...deps, nativeTransport: r => fixture.transport(r) })).state, 'matched');
    assert.equal(fixture.requests.length, before + 1);
  });
});

test('code.text receipts survive projection while empty host results cannot authorize linking', async () => {
  const workId = 'code-result', link = { version: 1, link_id: 'j'.repeat(32) };
  const tree = linkedConversation(ID, workId, link);
  tree.mapping.receipt.message.content = { content_type: 'code', language: 'json',
    text: JSON.stringify({ work_id: workId, chat_link: link }) };
  const deps = { workId, linkId: link.link_id, explicitGoal: true, conversationCorrelation: ID,
    nativeTransport: async () => ({ ok: true, data: await readConversationProjection(response(tree)) }) };
  assert.equal((await findRecentGoalCommand(deps)).state, 'matched');
  tree.mapping.receipt.message.content.text = '';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
});

test('structured MCP text parts bind delayed receipts without trusting other speakers or branches', async () => {
  const workId = 'structured-receipt', link = { version: 1, link_id: 'm'.repeat(32) };
  const tree = linkedConversation(ID, workId, link);
  tree.mapping.receipt.message.content.parts = [{ type: 'text',
    text: JSON.stringify({ work_id: workId, chat_link: link }) }];
  const deps = { workId, linkId: link.link_id, explicitGoal: true, conversationCorrelation: ID,
    nativeTransport: async () => ({ ok: true, data: await readConversationProjection(response(tree)) }) };
  tree.mapping.receipt.message.content.parts = [];
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent', 'unapproved receipt is not visible');
  tree.mapping.receipt.message.content.parts = [{ type: 'text',
    text: JSON.stringify({ work_id: workId, chat_link: link }) }];
  assert.equal((await findRecentGoalCommand(deps)).state, 'matched', 'approved tool text can link');
  tree.mapping.receipt.message.content.parts = [{ structuredContent: { work_id: workId, chat_link: link } }];
  assert.equal((await findRecentGoalCommand(deps)).state, 'matched', 'structured output can link');
  tree.mapping.receipt.message.author.role = 'assistant';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent', 'assistant-authored receipt is not proof');
  tree.mapping.receipt.message.author.role = 'tool';
  tree.mapping.receipt.message.content.parts[0].structuredContent.chat_link.link_id = 'n'.repeat(32);
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent', 'wrong link token is not proof');
  tree.mapping.receipt.message.content.parts[0].structuredContent.chat_link.link_id = link.link_id;
  tree.mapping.a.parent = 'u';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent', 'off-branch receipt is not proof');
});

function resourceLinkedConversation(id, workId, link) {
  const tree = linkedConversation(id, workId, link);
  tree.mapping.receipt.message = { id: 'resource-read', author: { role: 'tool', name: 'api_tool.read_resource' },
    status: 'finished_successfully', create_time: Date.now() / 1000,
    content: { content_type: 'text', parts: [''] },
    metadata: { invoked_resource: { resource_uri: chatLinkResource(workId, link.link_id).uri }, can_save: false } };
  return tree;
}

test('assistant pairing marker links after a delayed reply without any materialized resource', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const workId = 'approval-free-goal', link = { version: 1, link_id: 'r'.repeat(32) };
  const tree = conversation(ID, '/goal Verify approval-free linking');
  const marker = chatPairingMarker(workId, link.link_id);
  const deps = { workId, linkId: link.link_id, explicitGoal: true, conversationCorrelation: ID,
    nativeTransport: async () => ({ ok: true, data: await readConversationProjection(response(tree)) }) };
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent');
  t.mock.timers.tick(55_000);
  tree.mapping.a.message.create_time = Date.now() / 1000;
  tree.mapping.a.message.content.parts = ['Goal Mode is enabled.\n' + marker];
  assert.equal((await findRecentGoalCommand(deps)).conversationId, ID,
    'a reply after 50 seconds must link without a resource read');
  tree.mapping.a.message.status = 'in_progress';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'an unfinished assistant message cannot establish a link');
  tree.mapping.a.message.status = 'finished_successfully';
  tree.mapping.a.message.author.role = 'user';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'user-authored markers cannot establish a link');
  tree.mapping.a.message.author.role = 'assistant';
  tree.mapping.a.parent = 'root';
  assert.equal((await findRecentGoalCommand(deps)).state, 'absent',
    'a marker without an initiating user ancestor is invalid');
});

test('new marker goals verify the newest chat before any Project catalogue scan', async () => {
  const workId = 'fast-marker-work', link = { version: 1, link_id: 's'.repeat(32) };
  const chats = [rankedChat(1, 3000), rankedChat(2, 2900)];
  const tree = conversation(chats[0].id, '/goal Fast link');
  tree.mapping.a.message.content.parts = ['Started.\n' + chatPairingMarker(workId, link.link_id)];
  const fixture = discoveryFixture({ ordinary: chats,
    pages: [[projectPreview(1, [rankedChat(3, 4000)])]],
    trees: { [chats[0].id]: tree } });
  const result = await findRecentGoalCommand({ workId, linkId: link.link_id,
    pairingMarkerEnabled: true, explicitGoal: true, nativeTransport: fixture.transport });
  assert.equal(result.conversationId, chats[0].id);
  assert.deepEqual(fixture.requests.map(req => req.path), [
    '/backend-api/conversations?offset=0&limit=20&order=updated&is_archived=false',
    '/backend-api/conversation/' + chats[0].id,
    '/backend-api/conversation/' + chats[0].id
  ], 'first-chat match needs only catalogue head plus two fresh body checks');
});

test('newest-chat marker miss falls back to newer Project conversation', async () => {
  const workId = 'project-marker-work', link = { version: 1, link_id: 't'.repeat(32) };
  const ordinary = rankedChat(1, 2000), project = rankedChat(2, 4000);
  const tree = conversation(project.id, '/goal Project link');
  tree.mapping.a.message.content.parts = ['Started.\n' + chatPairingMarker(workId, link.link_id)];
  const fixture = discoveryFixture({ ordinary: [ordinary],
    pages: [[projectPreview(1, [project])]], trees: { [project.id]: tree } });
  const result = await findRecentGoalCommand({ workId, linkId: link.link_id,
    pairingMarkerEnabled: true, explicitGoal: true, nativeTransport: fixture.transport });
  assert.equal(result.conversationId, project.id);
  assert.equal(fixture.requests.filter(req => req.path.includes('/conversations?offset=')).length, 1,
    'fallback must reuse the first metadata page');
  assert.equal(fixture.requests.some(req => req.path.includes('snorlax/sidebar')), true);
});

test('redacted resource reads link only exact successful tool references on the active branch', async () => {
  const workId = 'reference-result', link = { version: 1, link_id: 'k'.repeat(32) };
  const original = resourceLinkedConversation(ID, workId, link);
  for (const variant of ['valid', 'assistant', 'user', 'wrong tool', 'failed', 'wrong link', 'off branch']) {
    const tree = structuredClone(original);
    if (variant === 'assistant' || variant === 'user') tree.mapping.receipt.message.author.role = variant;
    if (variant === 'wrong tool') tree.mapping.receipt.message.author.name = 'api_tool.call_tool';
    if (variant === 'failed') tree.mapping.receipt.message.status = 'in_progress';
    if (variant === 'wrong link') tree.mapping.receipt.message.metadata.invoked_resource.resource_uri = chatLinkResource(workId, 'z'.repeat(32)).uri;
    if (variant === 'off branch') tree.mapping.a.parent = 'u';
    const deps = { workId, linkId: link.link_id, explicitGoal: true, conversationCorrelation: ID,
      nativeTransport: async () => ({ ok: true, data: await readConversationProjection(response(tree)) }) };
    const result = await findRecentGoalCommand(deps);
    assert.equal(result.state, variant === 'valid' ? 'matched' : 'absent', variant);
    if (variant === 'valid') assert.equal(result.receiptMessageId, 'resource-read');
  }
  const fixture = discoveryFixture({ ordinary: [rankedChat(1, 2000), rankedChat(2, 1999)], trees: {
    [rankedChat(1).id]: resourceLinkedConversation(ID, workId, link),
    [rankedChat(2).id]: resourceLinkedConversation(OTHER, workId, link)
  } });
  assert.equal((await findRecentGoalCommand({ workId, linkId: link.link_id, explicitGoal: true,
    nativeTransport: fixture.transport })).state, 'ambiguous');
});

test('legacy receipt resources enforce owner and grants while pending goals advertise only markers', async t => {
  await withMonitoredGoal(t, async f => {
    const principal = createStdioPrincipal();
    const context = { ...f.context, principal, connector: true };
    f.patchGoal({ owner: principalFingerprint(principal), binding: null, conversationId: '' });
    const link = ensureChatLink(f.config, f.work_id, context);
    const uri = chatLinkResource(f.work_id, link.link_id).uri;
    const result = await readChatLinkResource(f.config, uri, context);
    assert.equal(JSON.parse(result.contents[0].text).chat_link.link_id, link.link_id);
    await assert.rejects(() => readChatLinkResource(f.config, uri, { principal: createStdioPrincipal() }), /unavailable/);
    await assert.rejects(() => readChatLinkResource(f.config, uri.replace(link.link_id, 'z'.repeat(32)), context), /unavailable/);
    f.patchGoal({ tunnelId: 'tunnel_different_account' });
    await assert.rejects(() => readChatLinkResource(f.config, uri, context), /unavailable/);
    f.patchGoal({ tunnelId: '' });
    const status = goalStatus(f.config, { work_id: f.work_id }, context);
    assert.equal(status.pairingMarker, chatPairingMarker(f.work_id, link.link_id));
    assert.equal(status.resourceLink, undefined);
    assert.equal(toolResult(status).content.some(c => c.type === 'resource_link'), false);
    stopGoal(f.config, { work_id: f.work_id }, context);
    assert.equal(goalStatus(f.config, { work_id: f.work_id }, context).resourceLink, undefined);
  });
  await withMonitoredGoal(t, async f => {
    const context = { ...f.context, principal: { clientId: 'client-without-grant' }, connector: true };
    f.patchGoal({ owner: principalFingerprint(context.principal), binding: null, conversationId: '' });
    const link = ensureChatLink(f.config, f.work_id, context);
    await assert.rejects(() => readChatLinkResource(f.config, chatLinkResource(f.work_id, link.link_id).uri, context), /authorization grant/);
  });
});

test('approval-free marker discovery binds Goal Mode and sends one verified continuation', async t => {
  await withMonitoredGoal(t, async f => {
    const link = ensureChatLink(f.config, f.work_id, { ...f.context, connector: true });
    f.patchGoal({ binding: null, conversationId: '', conversationCorrelation: 'opaque-host',
      observedNode: '', stableSince: 0 });
    const chat = rankedChat(1, 3000);
    const tree = conversation(chat.id, '/goal Continue the work');
    tree.mapping.a.message.content.parts = ['Goal Mode started.\n' + chatPairingMarker(f.work_id, link.link_id)];
    const fixture = discoveryFixture({ ordinary: [chat], trees: { [chat.id]: tree } });
    const sends = [];
    const nativeTransport = async request => {
      if (request.action === 'continue') { sends.push(request); return { ok: true, accepted: true }; }
      return fixture.transport(request);
    };
    await pollGoal(f.config, f.work_id, { nativeTransport });
    assert.equal(f.status().chatLink.state, 'linked');
    assert.equal(f.status().conversationId, chat.id);
    assert.equal(sends.length, 0);
    assert.equal(fixture.requests.some(request => request.action === 'read_resource'), false);
    t.mock.timers.tick(31_000);
    await pollGoal(f.config, f.work_id, { nativeTransport });
    await pollGoal(f.config, f.work_id, { nativeTransport });
    assert.equal(sends.length, 1);
    assert.equal(f.status().continuationCount, 1);
  });
});

test('resource receipt discovery binds a Project goal and continues once without replay', async t => {
  await withMonitoredGoal(t, async f => {
    const link = ensureChatLink(f.config, f.work_id, { ...f.context, connector: true });
    f.patchGoal({ binding: null, conversationId: '', conversationCorrelation: 'opaque', observedNode: '', stableSince: 0 });
    const chat = rankedChat(1, 2000);
    const tree = resourceLinkedConversation(chat.id, f.work_id, link);
    const fixture = discoveryFixture({ ordinary: [rankedChat(2, 1000)],
      pages: [[projectPreview(1, [chat])]], trees: { [chat.id]: tree } });
    const sends = [];
    const nativeTransport = async request => {
      if (request.action === 'continue') { sends.push(request); return { ok: true, accepted: true }; }
      return fixture.transport(request);
    };
    await pollGoal(f.config, f.work_id, { nativeTransport });
    assert.equal(f.status().chatLink.state, 'linked');
    assert.equal(loadGoal(f.config, f.work_id).chatgptProjectId, projectPreview(1, []).gizmo.gizmo.id);
    t.mock.timers.tick(31000);
    await pollGoal(f.config, f.work_id, { nativeTransport });
    await pollGoal(f.config, f.work_id, { nativeTransport });
    assert.equal(sends.length, 1);
    assert.equal(f.status().continuationCount, 1);
    tree.mapping.a.parent = 'u';
    await pollGoal(f.config, f.work_id, { nativeTransport });
    assert.equal(f.status().state, 'needs_user');
    assert.equal(sends.length, 1);
  });
});

test('public work mode discovery preserves normal, goal and loop across action unions', () => {
  assert.deepEqual(getPublicToolSchemas().find(tool => tool.name === 'relai_work').inputSchema.properties.mode,
    { type: 'string', enum: ['normal', 'goal', 'loop'] });
});
