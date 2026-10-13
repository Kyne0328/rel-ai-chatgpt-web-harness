// Goal Mode is an opt-in, protocol-only controller distinct from the Rel.AI task lifecycle.
import { withStateDatabase } from './stateDatabase.ts';
import { getToolActivity } from './toolActivity.js';
import { readTaskHistorySessionRecord } from './taskHistoryStore.ts';
import { isTerminalTaskStatus } from './taskState.js';
import { principalFingerprint } from './mcp/principal.ts';
import { chatgptCredentials, hasGoalBrowserTransport, getConversation, findRecentGoalCommand, findGoalConversation, turnState, parseConversationUrl, stopStalledTurn, sendContinue } from './chatgptGoalProtocol.js';

const PREFIX = 'chatgpt_goal:';
const DETECTION_PREFIX = 'chatgpt_goal_detection:';
const CLAIM_PREFIX = 'chatgpt_goal_command:';
const DETECTION_TIMEOUT_MS = 9_000;
const DETECTION_MAX_ATTEMPTS = 2;
const activeDetections = new Map();
const SETTLE_MS = 30_000;
const UNFINISHED_TURN_IDLE_MS = 4 * 60_000 + 30_000;
const MAX_CONTINUATIONS = 8;
const POLL_MS = 30_000;
const activePolls = new Map();
let timer = null;
let lastDetectionCleanupAt = 0;

function goalKey(workId) { return PREFIX + workId; }
function detectionKey(workId) { return DETECTION_PREFIX + workId; }

function loadDetection(config, workId) {
  return withStateDatabase(config, db => {
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(detectionKey(workId));
    return row ? JSON.parse(row.value) : null;
  }, { readonly: true, missingValue: null });
}

function saveDetection(config, value) {
  return withStateDatabase(config, db => {
    const key = detectionKey(value.workId);
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    if (!row || JSON.parse(row.value).state !== 'checking') return false;
    db.prepare('UPDATE state_meta SET value=? WHERE key=? AND value=?')
      .run(JSON.stringify(value), key, row.value);
    return true;
  }, { transaction: true });
}

function queueGoalDetection(config, task, context = {}, deps = {}) {
  // Only ChatGPT-hosted connector calls with a conversation correlation are
  // eligible. Normal CLI tasks never trigger ChatGPT account lookups.
  if (!context.connector || !context.conversationId) return null;
  const workId = String(task.work_id || '');
  if (!workId) return null;
  const detection = {
    workId, owner: ownerFingerprint(context), workspace: String(task.workspace || ''),
    objective: String(task.objective || task.title || '').slice(0, 500),
    startedAt: Date.now(), attempts: 0, state: 'checking', nextAttemptAt: Date.now()
  };
  const register = () => !loadGoal(config, workId) && withStateDatabase(config,
    db => db.prepare('INSERT OR IGNORE INTO state_meta(key,value) VALUES(?,?)')
      .run(detectionKey(workId), JSON.stringify(detection)).changes === 1, { transaction: true });
  try {
    const inserted = register();
    if (inserted) setImmediate(() => { void checkGoalDetection(config, workId, deps); });
    return inserted ? { state: 'checking' } : null;
  } catch {
    // Automatic detection must not fail an otherwise valid relai_work begin
    // when the local state database is momentarily busy.
    const retry = setTimeout(() => {
      try { if (register()) void checkGoalDetection(config, workId, deps); } catch {}
    }, 500);
    retry.unref?.();
    return null;
  }
}

async function checkGoalDetection(config, workId, deps = {}) {
  if (activeDetections.has(workId)) return;
  const record = loadDetection(config, workId);
  if (record?.state !== 'checking' || Date.now() < record.nextAttemptAt) return;
  const controller = new AbortController();
  activeDetections.set(workId, controller);
  try {
    const task = deps.task || getToolActivity().tasks.find(item => (item.id || item.taskId) === workId)
      || readTaskHistorySessionRecord(config, workId, { reconcileInactive: true, persistReconciliation: false });
    if (!task || isTerminalTaskStatus(task.status)) {
      // The begin call may still be persisting the task record. Permit one
      // bounded retry; do not treat an unknown task as approval to activate.
      saveDetection(config, { ...record, attempts: record.attempts + 1,
        state: record.attempts + 1 >= DETECTION_MAX_ATTEMPTS ? 'unavailable' : 'checking',
        nextAttemptAt: Date.now() + POLL_MS });
      return;
    }
    if (task.principalFingerprint && task.principalFingerprint !== record.owner) {
      saveDetection(config, { ...record, state: 'unavailable' });
      return;
    }
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(DETECTION_TIMEOUT_MS)]);
    const match = await findRecentGoalCommand({ ...deps, startedAt: record.startedAt, signal });
    if (controller.signal.aborted) return;
    if (match.state === 'matched') {
      const committed = withStateDatabase(config, db => {
        const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(detectionKey(workId));
        if (!row || JSON.parse(row.value).state !== 'checking') return false;
        if (db.prepare('SELECT 1 FROM state_meta WHERE key=?').get(goalKey(workId))) return false;
        const claimKey = CLAIM_PREFIX + match.conversationId + ':' + match.messageId;
        if (db.prepare('SELECT 1 FROM state_meta WHERE key=?').get(claimKey)) return false;
        db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?)').run(claimKey, workId);
        db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?)').run(goalKey(workId), JSON.stringify({
          workId, owner: record.owner, workspace: record.workspace, objective: record.objective,
          conversationId: match.conversationId, createdAt: record.startedAt,
          active: true, state: 'monitoring', observedNode: '', stableSince: 0,
          pendingNode: '', continuationCount: 0, updatedAt: Date.now()
        }));
        db.prepare('DELETE FROM state_meta WHERE key=?').run(detectionKey(workId));
        return true;
      }, { transaction: true });
      if (!committed) saveDetection(config, { ...record, state: 'ambiguous' });
      return;
    }
    const attempts = record.attempts + 1;
    saveDetection(config, { ...record, attempts,
      state: match.state === 'ambiguous' ? 'ambiguous'
        : attempts >= DETECTION_MAX_ATTEMPTS ? 'not_requested' : 'checking',
      nextAttemptAt: Date.now() + POLL_MS });
  } catch (error) {
    if (!controller.signal.aborted) {
      const attempts = record.attempts + 1;
      saveDetection(config, { ...record, attempts,
        state: error?.status === 401 ? 'needs_auth'
          : attempts >= DETECTION_MAX_ATTEMPTS ? 'unavailable' : 'checking',
        nextAttemptAt: Date.now() + POLL_MS });
    }
  } finally {
    activeDetections.delete(workId);
  }
}

function pendingGoalDetections(config) {
  const rows = withStateDatabase(config, db => db.prepare('SELECT value FROM state_meta WHERE key LIKE ?')
    .all(DETECTION_PREFIX + '%').map(row => JSON.parse(row.value)), { readonly: true, missingValue: [] });
  // Keep terminal results briefly for status inspection, not permanently for
  // every ordinary ChatGPT task. Cleanup is at most hourly.
  if (Date.now() - lastDetectionCleanupAt >= 60 * 60_000) {
    lastDetectionCleanupAt = Date.now();
    const obsolete = rows.filter(row => row.state !== 'checking' && Date.now() - row.startedAt > 24 * 60 * 60_000);
    if (obsolete.length) withStateDatabase(config, db => {
      const remove = db.prepare('DELETE FROM state_meta WHERE key=?');
      for (const row of obsolete) remove.run(detectionKey(row.workId));
    }, { transaction: true });
  }
  return rows;
}

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
    pendingNode: existing?.pendingNode || '', error: '', challenge: null, updatedAt: Date.now()
  }, { reactivate: true });
  return publicGoal(goal);
}

function goalStatus(config, args, context) {
  const goal = loadGoal(config, String(args.work_id || '').trim());
  if (goal) return publicGoal(requireOwnedGoal(config, args, context));
  const pending = loadDetection(config, String(args.work_id || '').trim());
  if (pending && pending.owner === ownerFingerprint(context)) return {
    ok: true, work_id: pending.workId, goalActive: false, state: pending.state,
    ...(pending.state === 'ambiguous' ? { error: 'Multiple recent /goal conversations; automatic linking refused.' } : {})
  };
  return publicGoal(requireOwnedGoal(config, args, context));
}

function stopGoalRecord(config, goal) {
  activePolls.get(goal.workId)?.abort();
  return publicGoal(saveGoal(config, { ...goal, active: false, state: 'stopped', updatedAt: Date.now() }));
}

function stopGoal(config, args, context) {
  const pending = loadDetection(config, String(args.work_id || '').trim());
  if (pending && pending.owner === ownerFingerprint(context) && pending.state === 'checking') {
    activeDetections.get(pending.workId)?.abort();
    saveDetection(config, { ...pending, state: 'stopped' });
    return { ok: true, work_id: pending.workId, goalActive: false, state: 'stopped' };
  }
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
    continuationCount: Number(goal.continuationCount || 0), error: goal.error || undefined,
    ...(goal.challenge ? { challenge: goal.challenge } : {}) };
}

function statusForTask(config, goal) {
  const current = getToolActivity().tasks.find(t => String(t.id || t.taskId) === goal.workId);
  const history = current || readTaskHistorySessionRecord(config, goal.workId, { reconcileInactive: true, persistReconciliation: false });
  return history || null;
}

function resolvedGoalPlan(task) {
  const steps = task?.plan?.steps;
  if (!Array.isArray(steps) || !steps.length
    || !steps.some(step => step.status === 'completed')
    || !steps.every(step => ['completed', 'blocked', 'skipped'].includes(step.status))) return null;
  return steps.some(step => step.status === 'blocked') ? 'blocked' : 'finished';
}

function unfinishedTurnUpdate(goal, snapshot, task, now = Date.now()) {
  const taskCalls = Number(task.calls || 0);
  const activityAt = typeof task.lastActivityAt === 'number'
    ? task.lastActivityAt : Date.parse(task.lastActivityAt || '') || 0;
  const turnId = String(snapshot.userMessage?.id || snapshot.nodeId);
  const startedAt = Number(snapshot.startedAt || 0);
  const lastCallOrStart = Math.max(activityAt, Number.isFinite(startedAt) ? startedAt : 0);
  if (goal.unfinishedTurnId !== turnId || !goal.unfinishedProgressAt) {
    return { ...goal, unfinishedTurnId: turnId, unfinishedTaskCalls: taskCalls,
      unfinishedProgressAt: Math.min(now, lastCallOrStart || now), updatedAt: now };
  }
  if (goal.unfinishedTaskCalls !== taskCalls || activityAt > goal.unfinishedProgressAt) {
    return { ...goal, unfinishedTaskCalls: taskCalls,
      unfinishedProgressAt: Math.min(now, activityAt || now), updatedAt: now };
  }
  if (now - goal.unfinishedProgressAt < UNFINISHED_TURN_IDLE_MS) return null;
  // Activity silence is only a recovery trigger, never proof a model finished.
  return { ...goal, state: 'stalled', updatedAt: now };
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
      saveGoal(config, { ...goal, active: false,
        state: resolvedGoalPlan(task) === 'blocked' ? 'blocked' : 'finished', updatedAt: Date.now() });
      return;
    }
    // A fully resolved plan needs work-session finalization, not another AI
    // response. Never let a browser handoff failure hide known blockers.
    const planOutcome = resolvedGoalPlan(task);
    if (planOutcome && Number(task.activeCalls || 0) === 0) {
      saveGoal(config, { ...goal, active: false, state: 'needs_finalization',
        error: 'Work plan has no actionable steps left. Finalize with relai_work finish; preserve blocked steps.',
        updatedAt: Date.now() });
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
    if (!snapshot.complete) {
      if (snapshot.role === 'assistant') {
        const update = unfinishedTurnUpdate(goal, snapshot, live);
        if (update?.state === 'stalled') {
          if (goal.pendingNode === snapshot.nodeId) return;
          if (Number(goal.continuationCount || 0) >= MAX_CONTINUATIONS) {
            saveGoal(config, { ...goal, active: false, state: 'paused',
              error: 'Automatic continuation limit reached.', updatedAt: Date.now() });
            return;
          }
          // Claim the branch before touching ChatGPT's Stop button. Any
          // uncertain stop/send can never replay the same recovery operation.
          const claimed = claimContinuation(config, workId, snapshot.nodeId, Number(live.calls || 0));
          if (!claimed) return;
          try {
            const before = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
            const latestTask = statusForTask(config, claimed);
            if (controller.signal.aborted || !loadGoal(config, workId)?.active) return;
            if (before.nodeId !== snapshot.nodeId || before.role !== 'assistant'
              || !latestTask || Number(latestTask.activeCalls || 0) > 0
              || Number(latestTask.calls || 0) !== Number(live.calls || 0)) {
              throw new Error('ChatGPT conversation or task changed before stalled-turn recovery.');
            }
            const stopped = await stopStalledTurn(goal.conversationId, snapshot.nodeId, { ...deps, signal: controller.signal });
            if (controller.signal.aborted || !loadGoal(config, workId)?.active) return;
            const after = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
            const current = statusForTask(config, claimed);
            if (after.nodeId !== snapshot.nodeId || after.role !== 'assistant' || !after.lastMessageId
              || !current || Number(current.activeCalls || 0) > 0
              || Number(current.calls || 0) !== Number(live.calls || 0)) {
              throw new Error('ChatGPT conversation or task changed during stalled-turn recovery.');
            }
            if (!stopped && !after.complete) throw new Error('ChatGPT response is still unfinished.');
            await sendContinue(goal.conversationId, after.lastMessageId, { ...deps,
              workId: claimed.workId, objective: claimed.objective, nodeId: after.nodeId,
              signal: controller.signal });
            if (controller.signal.aborted || !loadGoal(config, workId)?.active) return;
            saveGoal(config, { ...claimed, state: 'monitoring', error: '',
              continuationCount: Number(claimed.continuationCount || 0) + 1, updatedAt: Date.now() });
          } catch (error) {
            if (!controller.signal.aborted) saveGoal(config, { ...claimed, active: false,
              state: 'paused', error: error instanceof Error ? error.message : 'ChatGPT stalled-turn recovery failed.',
              updatedAt: Date.now() });
          }
        } else if (update) saveGoal(config, update);
      }
      return;
    }
    if (!snapshot.lastMessageId || !snapshot.nodeId || Date.now() - Number(goal.stableSince || 0) < SETTLE_MS) return;
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
      await sendContinue(goal.conversationId, snapshot.lastMessageId, { ...deps, workId: goal.workId, objective: goal.objective, nodeId: snapshot.nodeId, signal: controller.signal });
      if (controller.signal.aborted || !loadGoal(config, workId)?.active) return;
      saveGoal(config, { ...goal, state: 'monitoring', challenge: null,
        continuationCount: Number(goal.continuationCount || 0) + 1,
        updatedAt: Date.now() });
    } catch (error) {
      if (controller.signal.aborted) return;
      saveGoal(config, { ...goal, active: false, state: 'paused',
        challenge: error?.challenge || null,
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
      for (const pending of pendingGoalDetections(config).filter(item =>
        item.state === 'checking' && Date.now() >= item.nextAttemptAt).slice(0, 3)) {
        void checkGoalDetection(config, pending.workId);
      }
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
  for (const controller of activeDetections.values()) controller.abort();
}

export { activateGoal, queueGoalDetection, checkGoalDetection, resolvedGoalPlan, unfinishedTurnUpdate, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal, startGoalMonitor, stopGoalMonitor };
