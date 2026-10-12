// Goal Mode is an opt-in, protocol-only controller distinct from the Rel.AI task lifecycle.
import { withStateDatabase } from './stateDatabase.ts';
import { getToolActivity } from './toolActivity.js';
import { readTaskHistorySessionRecord } from './taskHistoryStore.ts';
import { isTerminalTaskStatus } from './taskState.js';
import { principalFingerprint } from './mcp/principal.ts';
import { chatgptCredentials, hasGoalBrowserTransport, getConversation, findGoalConversation, turnState, parseConversationUrl, sendContinue } from './chatgptGoalProtocol.js';

const PREFIX = 'chatgpt_goal:';
const SETTLE_MS = 30_000;
const MAX_CONTINUATIONS = 8;
const POLL_MS = 30_000;
const activePolls = new Map();
let timer = null;

function goalKey(workId) { return PREFIX + workId; }

function loadGoal(config, workId) {
  return withStateDatabase(config, db => {
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(goalKey(workId));
    return row ? JSON.parse(row.value) : null;
  }, { readonly: true, missingValue: null });
}

function saveGoal(config, goal, options = {}) {
  return withStateDatabase(config, db => {
    const key = goalKey(goal.workId);
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    if (row && options.reactivate !== true) {
      const current = JSON.parse(row.value);
      // A monitor running in another process must never reactivate or overwrite
      // a stopped goal after its own asynchronous request completes.
      if (current.state === 'stopped' || (!current.active && goal.active)) return current;
    }
    db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(goal));
    return goal;
  }, { transaction: true });
}

function claimContinuation(config, workId, nodeId, taskCalls) {
  return withStateDatabase(config, db => {
    const key = goalKey(workId);
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    if (!row) return null;
    const current = JSON.parse(row.value);
    if (!current.active || current.pendingNode === nodeId || current.observedNode !== nodeId) return null;
    const claimed = { ...current, pendingNode: nodeId, sentTaskCalls: taskCalls, state: 'sending', updatedAt: Date.now() };
    const update = db.prepare('UPDATE state_meta SET value=? WHERE key=? AND value=?').run(JSON.stringify(claimed), key, row.value);
    return update.changes === 1 ? claimed : null;
  }, { transaction: true });
}

function listGoals(config) {
  return withStateDatabase(config, db => db.prepare('SELECT value FROM state_meta WHERE key LIKE ?')
    .all(PREFIX + '%').map(row => JSON.parse(row.value)), { readonly: true, missingValue: [] });
}

function ownerFingerprint(context) {
  return principalFingerprint(context?.principal || 'anonymous');
}

function requireOwnedGoal(config, args, context) {
  const workId = String(args.work_id || '').trim();
  const goal = loadGoal(config, workId);
  if (!goal || goal.owner !== ownerFingerprint(context)) throw new Error('Goal Mode record not found for this authorized task.');
  return goal;
}

function activateGoal(config, args, context) {
  const workId = String(args.work_id || '').trim();
  const task = context?.requestTaskContext?.session;
  if (!task || !workId) throw new Error('Start a Rel.AI work session before activating Goal Mode.');
  if (isTerminalTaskStatus(task.status)) throw new Error('Cannot activate Goal Mode on a finished or cancelled task.');
  const objective = String(args.objective || task.objective || '').trim();
  if (!objective || objective.length > 500) throw new Error('Goal objective must be 1-500 characters.');
  const owner = ownerFingerprint(context);
  const existing = loadGoal(config, workId);
  if (existing && existing.owner !== owner) throw new Error('Goal Mode owner mismatch.');
  const conversationId = args.conversationUrl ? parseConversationUrl(args.conversationUrl) : existing?.conversationId || '';
  if (existing && existing.active && existing.conversationId && conversationId && existing.conversationId !== conversationId) {
    throw new Error('An active goal cannot silently switch conversations; stop it first.');
  }
  const goal = saveGoal(config, {
    ...(existing || {}), workId, owner, workspace: String(task.workspace || ''),
    createdAt: existing?.createdAt || Date.now(),
    objective, conversationId, active: true, state: 'linking',
    observedNode: existing?.observedNode || '', stableSince: existing?.stableSince || 0,
    pendingNode: existing?.pendingNode || '', error: '', updatedAt: Date.now()
  }, { reactivate: true });
  return publicGoal(goal);
}

function goalStatus(config, args, context) {
  return publicGoal(requireOwnedGoal(config, args, context));
}

function stopGoalRecord(config, goal) {
  activePolls.get(goal.workId)?.abort();
  return publicGoal(saveGoal(config, { ...goal, active: false, state: 'stopped', updatedAt: Date.now() }));
}

function stopGoal(config, args, context) {
  return stopGoalRecord(config, requireOwnedGoal(config, args, context));
}

// Dashboard task control is authenticated locally and does not impersonate an MCP principal.
function dashboardGoalStatus(config, workId) {
  const goal = loadGoal(config, String(workId || '').trim());
  return goal ? publicGoal(goal) : null;
}

function stopDashboardGoal(config, workId) {
  const goal = loadGoal(config, String(workId || '').trim());
  if (!goal) throw new Error('Goal Mode is not enabled for this task.');
  return stopGoalRecord(config, goal);
}

function publicGoal(goal) {
  return { ok: true, work_id: goal.workId, goalActive: goal.active,
    state: goal.state, conversationId: goal.conversationId || null,
    continuationCount: Number(goal.continuationCount || 0), error: goal.error || undefined };
}

function statusForTask(config, goal) {
  const current = getToolActivity().tasks.find(t => String(t.id || t.taskId) === goal.workId);
  const history = current || readTaskHistorySessionRecord(config, goal.workId, { reconcileInactive: true, persistReconciliation: false });
  return history || null;
}

async function pollGoal(config, workId, deps = {}) {
  if (activePolls.has(workId)) return;
  const controller = new AbortController();
  activePolls.set(workId, controller);
  try {
    let goal = loadGoal(config, workId);
    if (!goal?.active) return;
    const task = statusForTask(config, goal);
    if (!task || isTerminalTaskStatus(task.status)) {
      saveGoal(config, { ...goal, active: false, state: 'finished', updatedAt: Date.now() });
      return;
    }
    if (!chatgptCredentials(deps.env || process.env) && !deps.nativeTransport && !hasGoalBrowserTransport()) {
      saveGoal(config, { ...goal, state: 'needs_auth', error: 'ChatGPT Web authentication is not configured.', updatedAt: Date.now() });
      return;
    }
    if (!goal.conversationId) {
      const id = await findGoalConversation(goal.objective, { ...deps, startedAt: goal.createdAt, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!id) return; // Ambiguous or not yet visible. Never bind by guess.
      goal = saveGoal(config, { ...goal, conversationId: id, state: 'monitoring', updatedAt: Date.now() });
    }
    const snapshot = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
    if (controller.signal.aborted) return;
    goal = loadGoal(config, workId);
    if (!goal?.active || !goal.conversationId) return;
    if (goal.observedNode !== snapshot.nodeId) {
      saveGoal(config, { ...goal, observedNode: snapshot.nodeId, stableSince: Date.now(), state: 'monitoring', updatedAt: Date.now() });
      return;
    }
    const live = statusForTask(config, goal);
    if (!live || isTerminalTaskStatus(live.status) || live.status === 'waiting_for_approval' || live.status === 'blocked'
      || Number(live.activeCalls || 0) > 0) return;
    if (!snapshot.complete || !snapshot.lastMessageId || !snapshot.nodeId || Date.now() - Number(goal.stableSince || 0) < SETTLE_MS) return;
    if (goal.pendingNode === snapshot.nodeId) return; // Includes uncertain transport outcomes.
    if (Number(goal.continuationCount || 0) >= MAX_CONTINUATIONS) {
      saveGoal(config, { ...goal, active: false, state: 'paused', error: 'Automatic continuation limit reached.', updatedAt: Date.now() });
      return;
    }
    if (Number(goal.continuationCount || 0) > 0 && Number(live.calls || 0) <= Number(goal.sentTaskCalls || 0)) {
      saveGoal(config, { ...goal, active: false, state: 'paused', error: 'No new Rel.AI task activity after the previous continuation.', updatedAt: Date.now() });
      return;
    }
    // Recheck before any write. Browser/user input may have advanced the branch since
    // the earlier poll; if so, wait for the new turn to settle instead of posting.
    const fresh = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
    if (controller.signal.aborted || !loadGoal(config, workId)?.active) return;
    if (fresh.nodeId !== snapshot.nodeId || !fresh.complete || fresh.lastMessageId !== snapshot.lastMessageId) return;
    // Record the intent BEFORE a request is attempted. A network failure never auto-replays.
    goal = claimContinuation(config, workId, snapshot.nodeId, Number(live.calls || 0));
    if (!goal || controller.signal.aborted || !loadGoal(config, workId)?.active) return;
    try {
      await sendContinue(goal.conversationId, snapshot.lastMessageId, { ...deps, workId: goal.workId, objective: goal.objective, signal: controller.signal });
      if (controller.signal.aborted || !loadGoal(config, workId)?.active) return;
      saveGoal(config, { ...goal, state: 'monitoring',
        continuationCount: Number(goal.continuationCount || 0) + 1,
        updatedAt: Date.now() });
    } catch (error) {
      if (controller.signal.aborted) return;
      saveGoal(config, { ...goal, active: false, state: 'paused',
        error: error instanceof Error ? error.message : 'ChatGPT Web request failed.', updatedAt: Date.now() });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const goal = loadGoal(config, workId);
      if (goal?.active) saveGoal(config, { ...goal,
        state: error?.status === 401 ? 'needs_auth' : 'paused', active: error?.status === 401,
        error: error?.status === 401 ? 'Sign in to ChatGPT from the Rel.AI Browser page.'
          : error instanceof Error ? error.message : 'Goal monitor failed.', updatedAt: Date.now() });
    }
  } finally {
    activePolls.delete(workId);
  }
}

function startGoalMonitor(config) {
  if (timer) return;
  timer = setInterval(() => {
    try {
      for (const goal of listGoals(config)) {
        if (goal.active) void pollGoal(config, goal.workId);
      }
    } catch (error) {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] goal monitor:', error);
    }
  }, POLL_MS);
  timer.unref?.();
}

function stopGoalMonitor() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const controller of activePolls.values()) controller.abort();
}

export { activateGoal, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal, startGoalMonitor, stopGoalMonitor, pollGoal };
