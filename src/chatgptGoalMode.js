// Goal Mode is an opt-in continuation controller distinct from the Rel.AI task lifecycle.
import { withStateDatabase } from './stateDatabase.ts';
import { getStateDir } from './statePaths.js';
import { getToolActivity, onToolActivity } from './toolActivity.js';
import { readTaskHistorySessionRecord } from './taskHistoryStore.ts';
import { isTerminalTaskStatus } from './taskState.js';
import { principalFingerprint } from './mcp/principal.ts';
import { principalTunnelId } from './mcp/tunnelIdentity.js';
import { chatgptCredentials, hasGoalBrowserTransport, getConversation, findRecentGoalCommand, findGoalConversation, turnState, parseConversationUrl, stopStalledTurn, goalContinuationPrompt, sendContinue } from './chatgptGoalProtocol.js';
import { goalMessageExists } from './chatgptConversationReader.js';

const PREFIX = 'chatgpt_goal:';
const DETECTION_PREFIX = 'chatgpt_goal_detection:';
const CLAIM_PREFIX = 'chatgpt_goal_command:';
const RATE_LIMIT_PREFIX = 'chatgpt_goal_rate_limit:';
const DETECTION_MAX_ATTEMPTS = 2;
const DISCOVERY_RETRY_MS = 120_000;
const activeDetections = new Map();
const SETTLE_MS = 30_000;
const UNFINISHED_TURN_IDLE_MS = 4 * 60_000 + 30_000;
const MAX_CONTINUATIONS = 8;
const RETRY_DELAYS_MS = [5_000, 5_000, 10_000, 15_000, 20_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;
const POLL_MS = 30_000;
const activePolls = new Map();
const retryTimers = new Map();
let monitorConfig = null;
let timer = null;
let lastDetectionCleanupAt = 0;

function goalKey(workId) { return PREFIX + workId; }
function detectionKey(workId) { return DETECTION_PREFIX + workId; }

function canMonitorGoal(record, deps = {}) {
  // Durable records are shared by desktop, CLI and HTTP runtimes. Only the
  // runtime with the matching transport may observe or mutate their progress.
  if (typeof deps.nativeTransport === 'function'
    || (!deps.fetch && !deps.credentials && hasGoalBrowserTransport())) return true;
  // A tunnel belongs to a particular native account. Process-wide credentials
  // cannot substitute for that account, even when another runtime has them.
  return !record?.tunnelId && Boolean(deps.credentials || chatgptCredentials(deps.env || process.env));
}

function scheduleGoalRetry(config, goal) {
  clearTimeout(retryTimers.get(goal?.workId));
  retryTimers.delete(goal?.workId);
  if (monitorConfig !== config || !goal?.active || !goal.nextAttemptAt || !canMonitorGoal(goal)) return;
  const task = statusForTask(config, goal);
  if ((!goal.pendingNode || ['accepted', 'not_sent'].includes(goal.pendingOutcome))
    && !continuationTaskUnchanged(task || {}, task)) return;
  // Retry deadlines are independent of the ordinary 30-second observation
  // cadence. An overdue retry waiting for task settlement must not busy-loop.
  const wake = setTimeout(() => {
    retryTimers.delete(goal.workId);
    void pollGoal(config, goal.workId);
  }, Math.max(1_000, goal.nextAttemptAt - Date.now()));
  wake.unref?.();
  retryTimers.set(goal.workId, wake);
}

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
    conversationCorrelation: String(context.conversationId),
    tunnelId: principalTunnelId(context.principal),
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
  if (record?.state !== 'checking' || Date.now() < record.nextAttemptAt || !canMonitorGoal(record, deps)) return;
  const controller = new AbortController();
  activeDetections.set(workId, controller);
  try {
    deps = coordinatedGoalDeps(config, record, deps);
    const task = deps.task || getToolActivity().tasks.find(item => (item.id || item.taskId) === workId)
      || readTaskHistorySessionRecord(config, workId, { reconcileInactive: true, persistReconciliation: false });
    if (!task || isTerminalTaskStatus(task.status)) {
      // The begin call may still be persisting the task record. Permit one
      // bounded retry; do not treat an unknown task as approval to activate.
      saveDetection(config, { ...record, attempts: record.attempts + 1,
        state: record.attempts + 1 >= DETECTION_MAX_ATTEMPTS ? 'unavailable' : 'checking',
        error: 'Work session is unavailable for goal detection.', nextAttemptAt: Date.now() + POLL_MS });
      return;
    }
    if (task.principalFingerprint && task.principalFingerprint !== record.owner) {
      saveDetection(config, { ...record, state: 'unavailable', error: 'Goal detection owner does not match the work session.' });
      return;
    }
    const match = await findRecentGoalCommand({ ...deps, startedAt: record.startedAt, signal: controller.signal,
      tunnelId: record.tunnelId,
      conversationCorrelation: verifiedCorrelation(config, record), workId, requireWorkReceipt: true });
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
          conversationCorrelation: record.conversationCorrelation,
          tunnelId: record.tunnelId,
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
      error: match.state === 'ambiguous' ? 'Multiple verified goal conversations; linking refused.' : '',
      nextAttemptAt: Date.now() + DISCOVERY_RETRY_MS });
  } catch (error) {
    if (!controller.signal.aborted) {
      const transient = error?.deferred || error?.status === 429;
      const attempts = record.attempts + (transient ? 0 : 1);
      const rateLimitRetries = Number(record.rateLimitRetries || 0) + (error?.status === 429 && !error?.deferred ? 1 : 0);
      saveDetection(config, { ...record, attempts, rateLimitRetries,
        state: error?.status === 401 ? 'needs_auth'
          : attempts >= DETECTION_MAX_ATTEMPTS || rateLimitRetries >= MAX_RETRIES ? 'unavailable' : 'checking',
        error: detectionError(error),
        nextAttemptAt: Math.max(Number(error?.retryAt || 0), Date.now() + DISCOVERY_RETRY_MS) });
    }
  } finally {
    activeDetections.delete(workId);
  }
}

function detectionError(error) {
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
    return `ChatGPT goal discovery failed (HTTP ${error.status}).${error.status === 429 ? ' Waiting for the account cooldown.' : ''}`;
  }
  if (error?.name === 'TimeoutError') return 'ChatGPT goal discovery timed out.';
  if (error?.code === 'GOAL_ACCOUNT_UNAVAILABLE') return 'The configured ChatGPT Goal Mode account is unavailable.';
  if (error?.deferred) return 'ChatGPT account read budget reached; waiting for the next read window.';
  return 'ChatGPT goal discovery failed; check local sign-in and the conversation transport.';
}

function coordinatedGoalDeps(config, record, deps) {
  const key = RATE_LIMIT_PREFIX + record.owner + ':' + (record.tunnelId || 'legacy');
  const limit = withStateDatabase(config, db => {
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : {};
  }, { readonly: true, missingValue: {} });
  return { ...deps, tunnelId: record.tunnelId || '', cooldownUntil: limit.until || 0,
    rateLimitCount: limit.count || 0,
    onRateLimit: value => withStateDatabase(config, db => {
      const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
      const old = row ? JSON.parse(row.value) : {};
      db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, JSON.stringify({ until: Math.max(old.until || 0, value.until), count: value.count }));
    }, { transaction: true }) };
}

function verifiedCorrelation(config, record) {
  if (!record.conversationCorrelation) return '';
  const ids = new Set(listGoals(config).filter(goal => goal.owner === record.owner
    && goal.tunnelId === record.tunnelId && goal.conversationCorrelation === record.conversationCorrelation
    && goal.conversationId).map(goal => goal.conversationId));
  return ids.size === 1 ? [...ids][0] : record.conversationCorrelation;
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
    const claimed = { ...current, pendingNode: nodeId, pendingOutcome: 'uncertain',
      pendingPrompt: goalContinuationPrompt(current.workId, current.objective),
      pendingTaskCalls: taskCalls, state: 'sending', updatedAt: Date.now() };
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

function pendingOutcome(goal) {
  // Earlier records persisted successful receipts as monitoring + a positive
  // continuation count. Keep their accepted claim rather than counting it again.
  return goal.pendingOutcome || (goal.pendingNode && goal.state === 'monitoring'
    && Number(goal.continuationCount || 0) > 0 ? 'accepted' : 'uncertain');
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
  const switchingConversation = Boolean(existing?.conversationId && conversationId && existing.conversationId !== conversationId);
  if (switchingConversation && existing.active) {
    throw new Error('An active goal cannot silently switch conversations; stop it first.');
  }
  if (switchingConversation && existing.pendingNode && !['accepted', 'not_sent'].includes(pendingOutcome(existing))) {
    throw new Error('Cannot switch conversations while a previous continuation receipt is unresolved; resume the original conversation to reconcile it.');
  }
  const goal = saveGoal(config, {
    ...(existing || {}), workId, owner, workspace: String(task.workspace || ''),
    createdAt: existing?.createdAt || Date.now(),
    objective, conversationId, active: true, state: 'linking',
    tunnelId: existing?.tunnelId || principalTunnelId(context.principal),
    conversationCorrelation: existing?.conversationCorrelation || String(context?.conversationId || task.correlation?.conversationId || ''),
    observedNode: switchingConversation ? '' : existing?.observedNode || '',
    stableSince: switchingConversation ? 0 : existing?.stableSince || 0,
    pendingNode: switchingConversation || existing?.pendingOutcome === 'not_sent' ? '' : existing?.pendingNode || '',
    pendingOutcome: switchingConversation ? 'not_sent' : pendingOutcome(existing || {}),
    ...(switchingConversation ? { pendingPrompt: '', pendingTaskCalls: 0,
      unfinishedTurnId: '', unfinishedTaskCalls: 0, unfinishedProgressAt: 0 } : {}),
    retryCount: existing?.active ? Number(existing.retryCount || 0) : 0,
    nextAttemptAt: existing?.active ? Number(existing.nextAttemptAt || 0) : 0,
    error: '', challenge: null, updatedAt: Date.now()
  }, { reactivate: true });
  return publicGoal(goal);
}

function goalStatus(config, args, context) {
  const goal = loadGoal(config, String(args.work_id || '').trim());
  if (goal) return publicGoal(requireOwnedGoal(config, args, context));
  const pending = loadDetection(config, String(args.work_id || '').trim());
  if (pending && pending.owner === ownerFingerprint(context)) return {
    ok: true, work_id: pending.workId, goalActive: false, state: pending.state,
    attempts: pending.attempts, nextAttemptAt: pending.nextAttemptAt,
    ...(pending.error ? { error: pending.error } : {})
  };
  return publicGoal(requireOwnedGoal(config, args, context));
}

function stopGoalRecord(config, goal) {
  activePolls.get(goal.workId)?.abort();
  const stopped = saveGoal(config, { ...goal, active: false, state: 'stopped', authRequired: false, nextAttemptAt: 0, updatedAt: Date.now() });
  scheduleGoalRetry(config, stopped);
  return publicGoal(stopped);
}

function resumeAuthenticatedGoals(config, tunnelId) {
  const resumed = [];
  const resumedDetections = [];
  for (const pending of pendingGoalDetections(config)) {
    if (pending.tunnelId !== tunnelId || pending.state !== 'needs_auth') continue;
    const task = statusForTask(config, pending);
    if (!task || terminalGoalState(task) || (task.principalFingerprint && task.principalFingerprint !== pending.owner)) continue;
    const reset = withStateDatabase(config, db => {
      const key = detectionKey(pending.workId);
      const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
      if (!row || db.prepare('SELECT 1 FROM state_meta WHERE key=?').get(goalKey(pending.workId))) return false;
      const current = JSON.parse(row.value);
      if (current.state !== 'needs_auth' || current.tunnelId !== tunnelId) return false;
      db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify({ ...current,
        state: 'checking', attempts: 0, nextAttemptAt: Date.now() }), key);
      return true;
    }, { transaction: true });
    if (reset) {
      resumedDetections.push(pending.workId);
      if (monitorConfig && getStateDir(monitorConfig) === getStateDir(config)) {
        setImmediate(() => { if (monitorConfig) void checkGoalDetection(monitorConfig, pending.workId); });
      }
    }
  }
  for (const goal of listGoals(config)) {
    if (goal.tunnelId !== tunnelId || !(goal.state === 'needs_auth' || (goal.active && goal.authRequired))) continue;
    const task = statusForTask(config, goal);
    if (!task || terminalGoalState(task) || resolvedGoalPlan(task)
      || (task.principalFingerprint && task.principalFingerprint !== goal.owner)) continue;
    const updated = withStateDatabase(config, db => {
      const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(goalKey(goal.workId));
      if (!row) return null;
      const current = JSON.parse(row.value);
      // A concurrent Stop or explicit restart wins over a delayed sign-in event.
      if (current.tunnelId !== tunnelId || !(current.state === 'needs_auth' || (current.active && current.authRequired))) return null;
      const next = { ...current, active: true, state: 'monitoring', authRequired: false,
        retryCount: 0, nextAttemptAt: 0, error: '', challenge: null, updatedAt: Date.now() };
      db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify(next), goalKey(goal.workId));
      return next;
    }, { transaction: true });
    if (!updated) continue;
    activePolls.get(goal.workId)?.abort(Object.assign(new Error('ChatGPT sign-in was refreshed.'), { code: 'GOAL_AUTH_REFRESHED' }));
    scheduleGoalRetry(config, updated);
    resumed.push(goal.workId);
    if (monitorConfig && getStateDir(monitorConfig) === getStateDir(config)) {
      setImmediate(() => { if (monitorConfig) void pollGoal(monitorConfig, goal.workId); });
    }
  }
  return { ok: true, resumedWorkIds: resumed, resumedDetectionWorkIds: resumedDetections };
}

function stopGoal(config, args, context) {
  const workId = String(args.work_id || '').trim();
  const owner = ownerFingerprint(context);
  const stopped = withStateDatabase(config, db => {
    const goal = db.prepare('SELECT value FROM state_meta WHERE key=?').get(goalKey(workId));
    const key = goal ? goalKey(workId) : detectionKey(workId);
    const row = goal || db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    if (!row || JSON.parse(row.value).owner !== owner) throw new Error('Goal Mode record not found for this authorized task.');
    const record = { ...JSON.parse(row.value), active: false, state: 'stopped', authRequired: false, nextAttemptAt: 0, updatedAt: Date.now() };
    db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify(record), key);
    return goal ? publicGoal(record) : { ok: true, work_id: workId, goalActive: false, state: 'stopped' };
  }, { transaction: true });
  activePolls.get(workId)?.abort();
  activeDetections.get(workId)?.abort();
  scheduleGoalRetry(config, { workId, active: false });
  return stopped;
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
    ...(goal.tunnelId ? { tunnelId: goal.tunnelId } : {}),
    continuationCount: Number(goal.continuationCount || 0), error: goal.error || undefined,
    retryCount: Number(goal.retryCount || 0), maxRetries: MAX_RETRIES,
    ...(goal.authRequired ? { authRequired: true } : {}),
    ...(goal.nextAttemptAt ? { nextAttemptAt: goal.nextAttemptAt } : {}),
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

function terminalGoalState(task) {
  if (!task) return 'unavailable';
  if (!isTerminalTaskStatus(task.status)) return null;
  if (task.status !== 'completed') return task.status;
  return resolvedGoalPlan(task) === 'blocked' ? 'blocked' : 'finished';
}

function continuationTaskUnchanged(previous, current) {
  return current && !terminalGoalState(current)
    && !current.cancellationRequestedAt
    && current.status !== 'waiting_for_approval' && current.status !== 'blocked'
    && Number(current.activeCalls || 0) === 0 && !resolvedGoalPlan(current)
    && Number(current.calls || 0) === Number(previous.calls || 0)
    && current.lastActivityAt === previous.lastActivityAt;
}

function retryGoal(config, goal, error, { notSent = false } = {}) {
  const terminal = terminalGoalState(statusForTask(config, goal));
  if (terminal) return saveGoal(config, { ...goal, active: false, state: terminal,
    error: terminal === 'unavailable' ? 'Work session is unavailable; completion is unknown.' : '', updatedAt: Date.now() });
  const count = Number(goal.retryCount || 0);
  const exhausted = !error?.deferred && count >= MAX_RETRIES;
  const reason = error instanceof Error ? error.message : 'Goal continuation failed.';
  const retried = saveGoal(config, { ...goal,
    ...(notSent && goal.pendingOutcome !== 'accepted'
      ? { pendingNode: '', pendingOutcome: 'not_sent', pendingPrompt: '' } : {}),
    active: !exhausted, state: exhausted ? (error?.status === 401 ? 'needs_auth' : 'paused')
      : error?.status === 429 ? 'rate_limited'
      : !notSent && goal.pendingNode ? 'verifying' : 'retrying',
    retryCount: exhausted || error?.deferred ? count : count + 1,
    nextAttemptAt: exhausted ? 0 : Math.max(Number(error?.retryAt || 0),
      Date.now() + (error?.deferred ? RETRY_DELAYS_MS[0] : RETRY_DELAYS_MS[count])),
    challenge: error?.challenge || null,
    authRequired: error?.status === 401,
    error: exhausted ? `Automatic continuation stopped after five retries: ${reason}` : reason, updatedAt: Date.now()
  });
  scheduleGoalRetry(config, retried);
  return retried;
}

function acceptContinuation(config, goal) {
  const terminal = terminalGoalState(statusForTask(config, goal));
  return saveGoal(config, { ...goal, active: !terminal, state: terminal || 'monitoring', error: '', challenge: null,
    pendingOutcome: 'accepted', pendingPrompt: '', authRequired: false, retryCount: 0, nextAttemptAt: 0,
    sentTaskCalls: Number(goal.pendingTaskCalls ?? goal.sentTaskCalls ?? 0),
    continuationCount: Number(goal.continuationCount || 0) + 1, updatedAt: Date.now() });
}

async function continueGoal(config, goal, snapshot, task, controller, deps, recover = false) {
  const claimed = claimContinuation(config, goal.workId, snapshot.nodeId, Number(task.calls || 0));
  if (!claimed) return;
  // The existing task owner invalidates native work throughout navigation and
  // composer preparation, not only at the monitor's earlier protocol read.
  const unsubscribe = onToolActivity(event => {
    if (String(event.taskId || event.task?.id || '') === goal.workId
      && !continuationTaskUnchanged(task, statusForTask(config, goal))) controller.abort();
  });
  let sendAttempted = false;
  try {
    controller.signal.throwIfAborted();
    if (!loadGoal(config, goal.workId)?.active) return;
    let parent = snapshot;
    if (recover) {
      const before = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
      if (before.nodeId !== snapshot.nodeId || before.role !== 'assistant'
        || !continuationTaskUnchanged(task, statusForTask(config, goal))) {
        throw new Error('ChatGPT conversation or task changed before stalled-turn recovery.');
      }
      await stopStalledTurn(goal.conversationId, snapshot.nodeId, { ...deps, signal: controller.signal });
      controller.signal.throwIfAborted();
      parent = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
      if (parent.nodeId !== snapshot.nodeId || parent.role !== 'assistant' || !parent.lastMessageId
        || !continuationTaskUnchanged(task, statusForTask(config, goal))) {
        throw new Error('ChatGPT conversation or task changed during stalled-turn recovery.');
      }
      if (!parent.settled) throw new Error('ChatGPT response is still unfinished.');
    }
    controller.signal.throwIfAborted();
    if (!loadGoal(config, goal.workId)?.active) return;
    if (!continuationTaskUnchanged(task, statusForTask(config, goal))) throw new Error('Work session changed before sending.');
    sendAttempted = true;
    await sendContinue(goal.conversationId, parent.lastMessageId, { ...deps,
      workId: claimed.workId, objective: claimed.objective, nodeId: parent.nodeId, signal: controller.signal });
    // An accepted send is a receipt even if the new turn immediately starts
    // MCP activity and invalidates the previous task snapshot.
    acceptContinuation(config, claimed);
  } catch (error) {
    if (controller.signal.reason?.code === 'GOAL_AUTH_REFRESHED') {
      const current = loadGoal(config, goal.workId);
      if (!sendAttempted && current?.active && current.state === 'monitoring' && current.pendingNode === claimed.pendingNode) {
        retryGoal(config, current, Object.assign(new Error('Sign-in refreshed; unsent recovery deferred.'), { deferred: true }), { notSent: true });
      }
      return;
    }
    retryGoal(config, claimed, error, { notSent: !sendAttempted || error?.notSent === true });
  } finally { unsubscribe(); }
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
    if (!goal?.active || !canMonitorGoal(goal, deps)) return;
    deps = coordinatedGoalDeps(config, goal, deps);
    if (goal.pendingNode && !goal.pendingOutcome) goal = saveGoal(config, { ...goal, pendingOutcome: pendingOutcome(goal) });
    const task = statusForTask(config, goal);
    const terminalState = terminalGoalState(task);
    if (terminalState) {
      saveGoal(config, { ...goal, active: false,
        state: terminalState, error: task ? '' : 'Work session is unavailable; completion is unknown.',
        updatedAt: Date.now() });
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
    if (Date.now() < Number(goal.nextAttemptAt || 0)) return;
    // Local work and approval waits cannot need another continuation. Avoid
    // remote reads until they settle; uncertain sends still need reconciliation.
    if ((!goal.pendingNode || ['accepted', 'not_sent'].includes(goal.pendingOutcome))
      && (Number(task.activeCalls || 0) > 0 || task.status === 'waiting_for_approval' || task.status === 'blocked')) return;
    // Consume the deadline once this retry can run. A successful observation
    // may need to wait for branch settlement instead of sending immediately.
    if (goal.nextAttemptAt) goal = saveGoal(config, { ...goal, nextAttemptAt: 0 });
    if (!goal.conversationId) {
      const id = await findGoalConversation(goal.objective, { ...deps, startedAt: goal.createdAt, signal: controller.signal,
        conversationCorrelation: verifiedCorrelation(config, goal), workId, requireWorkReceipt: true, explicitGoal: true });
      if (controller.signal.aborted) return;
      if (!id) {
        retryGoal(config, goal, Object.assign(new Error('No verified ChatGPT conversation is linked to this work session.'),
          { retryAt: Date.now() + DISCOVERY_RETRY_MS }), { notSent: true });
        return;
      }
      goal = saveGoal(config, { ...goal, conversationId: id, state: 'monitoring', updatedAt: Date.now() });
    }
    const conversation = await getConversation(goal.conversationId, { ...deps, signal: controller.signal });
    const snapshot = turnState(conversation);
    if (controller.signal.aborted) return;
    goal = loadGoal(config, workId);
    if (!goal?.active || !goal.conversationId) return;
    if (goal.pendingNode && !['accepted', 'not_sent'].includes(goal.pendingOutcome)) {
      if (goalMessageExists(conversation, goal.pendingPrompt || goalContinuationPrompt(goal.workId, goal.objective), goal.pendingNode)) {
        acceptContinuation(config, goal);
      } else {
        retryGoal(config, goal, new Error('ChatGPT submission remains unverified; checking its receipt without resending.'));
      }
      return;
    }
    if (goal.observedNode !== snapshot.nodeId) {
      saveGoal(config, { ...goal, observedNode: snapshot.nodeId, stableSince: Date.now(), state: 'monitoring', updatedAt: Date.now() });
      return;
    }
    const live = statusForTask(config, goal);
    if (!live || isTerminalTaskStatus(live.status) || live.status === 'waiting_for_approval' || live.status === 'blocked'
      || Number(live.activeCalls || 0) > 0) return;
    if (!snapshot.settled) {
      if (snapshot.role === 'assistant') {
        const update = unfinishedTurnUpdate(goal, snapshot, live);
        if (update?.state === 'stalled') {
          if (goal.pendingNode === snapshot.nodeId) return;
          if (Number(goal.continuationCount || 0) >= MAX_CONTINUATIONS) {
            saveGoal(config, { ...goal, active: false, state: 'paused',
              error: 'Automatic continuation limit reached.', updatedAt: Date.now() });
            return;
          }
          if (Number(goal.continuationCount || 0) > 0 && Number(live.calls || 0) <= Number(goal.sentTaskCalls || 0)) {
            saveGoal(config, { ...goal, active: false, state: 'paused',
              error: 'No new Rel.AI task activity after the previous continuation.', updatedAt: Date.now() });
            return;
          }
          await continueGoal(config, goal, snapshot, live, controller, deps, true);
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
    if (fresh.nodeId !== snapshot.nodeId || !fresh.settled || fresh.lastMessageId !== snapshot.lastMessageId
      || !continuationTaskUnchanged(live, statusForTask(config, goal))) return;
    await continueGoal(config, goal, snapshot, live, controller, deps);
  } catch (error) {
    if (!controller.signal.aborted) {
      const goal = loadGoal(config, workId);
      if (goal?.active) retryGoal(config, goal, error,
        { notSent: !goal.pendingNode || ['accepted', 'not_sent'].includes(goal.pendingOutcome) });
    }
  } finally {
    activePolls.delete(workId);
    // A busy/closing database must not turn a completed poll into an unhandled
    // rejection; the ordinary monitor cycle will restore the durable deadline.
    try { scheduleGoalRetry(config, loadGoal(config, workId)); } catch {}
  }
}

function startGoalMonitor(config) {
  if (timer) return;
  monitorConfig = config;
  for (const goal of listGoals(config)) scheduleGoalRetry(config, goal);
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
  monitorConfig = null;
  for (const wake of retryTimers.values()) clearTimeout(wake);
  retryTimers.clear();
  for (const controller of activePolls.values()) controller.abort();
  for (const controller of activeDetections.values()) controller.abort();
}

export { activateGoal, queueGoalDetection, checkGoalDetection, resolvedGoalPlan, unfinishedTurnUpdate, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal, resumeAuthenticatedGoals, pollGoal, startGoalMonitor, stopGoalMonitor };
