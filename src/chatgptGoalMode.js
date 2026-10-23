// Goal Mode is an opt-in continuation controller distinct from the Rel.AI task lifecycle.
import { withStateDatabase } from './stateDatabase.ts';
import { getStateDir } from './statePaths.js';
import { getToolActivity, onToolActivity } from './toolActivity.js';
import { readTaskHistorySessionRecord, readRecentWorkflowEvidence } from './taskHistoryStore.ts';
import { readTaskIntegrity, readWorkspaceIntegrity } from './taskIntegrity.ts';
import { resolveWorkspace } from './config.js';
import { createValidationFingerprint } from './bridge/validationPlan.js';
import { goalKey, loadGoal, listGoals, saveGoal as persistGoal, updateGoal as mutateGoal, claimContinuation, clearUnsentContinuation, readChatLink, commitGoalBinding, goalDiscoveryStore } from './chatgptGoalState.js';
import { buildGoalEvidence } from './chatgptGoalEvidence.js';
import { evaluateGoalDecision } from './chatgptGoalEvaluator.js';
import { isTerminalTaskStatus } from './taskState.js';
import { principalFingerprint } from './mcp/principal.ts';
import { principalTunnelId } from './mcp/tunnelIdentity.js';
import { hasChatLinkReceipt, chatgptCredentials, hasGoalBrowserTransport, getConversation, findRecentGoalCommand, latestGoalCommand, initiatingGoalCommand, turnState, parseConversationUrl, stopStalledTurn, goalContinuationPrompt, sendContinue } from './chatgptGoalProtocol.js';
import { goalMessageExists } from './chatgptConversationReader.js';

const DETECTION_PREFIX = 'chatgpt_goal_detection:';
const RATE_LIMIT_PREFIX = 'chatgpt_goal_rate_limit:';
const DISCOVERY_RETRY_MS = 120_000;
const SETTLE_MS = 30_000;
const UNFINISHED_TURN_IDLE_MS = 4 * 60_000 + 30_000;
const RETRY_DELAYS_MS = [5_000, 5_000, 10_000, 15_000, 20_000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;
const POLL_MS = 30_000;
const activePolls = new Map();
const retryTimers = new Map();
let monitorConfig = null;
let timer = null;

// A persistence error may also break the error-state save. Background launches
// therefore have a final, storage-independent boundary and bounded short retries.
const backgroundGoals = new Map();
const MAX_BACKGROUND_GOALS = 128;

function clearBackgroundGoal(workId) {
  const key = 'poll:' + workId;
  clearTimeout(backgroundGoals.get(key)?.timer);
  backgroundGoals.delete(key);
}

function runGoalBackground(config, workId, kind, deps = {}) {
  const key = kind + ':' + workId;
  const previous = backgroundGoals.get(key);
  if (previous?.running || previous?.timer) return;
  const pending = previous || { attempts: 0, timer: null, running: false };
  pending.running = true;
  backgroundGoals.set(key, pending);
  while (backgroundGoals.size > MAX_BACKGROUND_GOALS) {
    const oldest = backgroundGoals.keys().next().value;
    clearTimeout(backgroundGoals.get(oldest)?.timer);
    backgroundGoals.delete(oldest);
  }
  // The promise chain itself is terminal: its rejection handler does not read
  // or write SQLite, and never resends a persisted uncertain continuation.
  void Promise.resolve().then(() => pollGoal(config, workId, deps)).then(() => {
    if (backgroundGoals.get(key) === pending) backgroundGoals.delete(key);
  }, error => {
    if (backgroundGoals.get(key) !== pending) return; // Stop/shutdown won.
    pending.running = false;
    pending.attempts = Math.min(pending.attempts + 1, MAX_RETRIES + 1);
    pending.diagnostic = String(error?.code || error?.name || 'GoalBackgroundError').slice(0, 80);
    try {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] goal background deferred:', kind, pending.diagnostic);
      if (pending.attempts > MAX_RETRIES) return; // Ordinary monitoring may retry later.
      pending.timer = setTimeout(() => {
        pending.timer = null;
        if (backgroundGoals.get(key) === pending) runGoalBackground(config, workId, kind, deps);
      }, RETRY_DELAYS_MS[pending.attempts - 1]);
      pending.timer.unref?.();
    } catch {
      // Even diagnostic/timer failure cannot escape a discarded background promise.
      backgroundGoals.delete(key);
    }
  });
}

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
  const linking = readChatLink(config, goal) && !goal.binding;
  if (!linking && (!goal.pendingNode || ['accepted', 'not_sent'].includes(goal.pendingOutcome))
    && !continuationTaskUnchanged(task || {}, task, goal)) return;
  // Retry deadlines are independent of the ordinary 30-second observation
  // cadence. An overdue retry waiting for task settlement must not busy-loop.
  const wake = setTimeout(() => {
    retryTimers.delete(goal.workId);
    runGoalBackground(config, goal.workId, 'poll');
  }, Math.max(1_000, goal.nextAttemptAt - Date.now()));
  wake.unref?.();
  retryTimers.set(goal.workId, wake);
}

function detectionError(error) {
  if (error?.code === 'GOAL_CATALOGUE_INVALID') return 'ChatGPT listing timestamps are incomplete; waiting for a fresh catalogue.';
  if (error?.code === 'GOAL_CATALOGUE_INCOMPLETE') return 'Completing the account chat catalogue; linking will continue automatically.';
  if (error?.code === 'GOAL_DISCOVERY_BUSY') return 'Account chat discovery is in progress in another runtime; waiting for its results.';
  if (error?.rateLimitReason === 'read_budget') return 'Rel.AI account read budget reached. Chat linking will resume automatically in the next read window.';
  if (error?.status === 429) return 'ChatGPT account requests are rate limited (HTTP 429). Chat linking will resume automatically after the cooldown.';
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
    return `ChatGPT goal discovery failed (HTTP ${error.status}).`;
  }
  if (error?.name === 'TimeoutError') return 'ChatGPT goal discovery timed out.';
  if (error?.code === 'GOAL_ACCOUNT_UNAVAILABLE') return 'The configured ChatGPT Goal Mode account is unavailable.';
  if (error?.deferred) return 'ChatGPT account read budget reached; waiting for the next read window.';
  return 'ChatGPT goal discovery failed; check local sign-in and the conversation transport.';
}

function coordinatedGoalDeps(config, record, deps) {
  const link = readChatLink(config, record);
  const key = RATE_LIMIT_PREFIX + record.owner + ':' + (record.tunnelId || 'legacy');
  const limit = withStateDatabase(config, db => {
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : {};
  }, { readonly: true, missingValue: {} });
  return { ...deps, discoveryStore: goalDiscoveryStore(config, record), chatgptProjectName: record.chatgptProjectName || '',
    chatgptProjectId: record.chatgptProjectId || '',
    ...(link ? { linkId: link.linkId, issuedAt: link.issuedAt } : {}),
    tunnelId: record.tunnelId || '', cooldownUntil: limit.until || 0,
    rateLimitCount: limit.count || 0, rateLimitReason: limit.reason || 'upstream',
    onRateLimit: value => withStateDatabase(config, db => {
      const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
      const old = row ? JSON.parse(row.value) : {};
      db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, JSON.stringify({ until: Math.max(old.until || 0, value.until), count: value.count,
          reason: value.until >= (old.until || 0) ? value.reason : old.reason || 'upstream' }));
    }, { transaction: true }) };
}

function verifiedCorrelation(config, record) {
  if (!record.conversationCorrelation) return '';
  const ids = new Set(listGoals(config).filter(goal => goal.owner === record.owner
    && goal.tunnelId === record.tunnelId && goal.conversationCorrelation === record.conversationCorrelation
    && goal.conversationId && goal.binding?.conversationId === goal.conversationId).map(goal => goal.conversationId));
  return ids.size === 1 ? [...ids][0] : record.conversationCorrelation;
}

function saveGoal(config, goal, options = {}) {
  const saved = persistGoal(config, goal, options);
  return saved;
}

function ownerFingerprint(context) {
  return principalFingerprint(context?.principal || 'anonymous');
}

function requireOwnedGoal(config, args, context) {
  const workId = String(args.work_id || '').trim();
  const goal = loadGoal(config, workId);
  if (!goal || goal.owner !== ownerFingerprint(context)) throw new Error('Goal Mode record not found for this authorized task.');
  if (args.mode && args.mode !== goal.mode) throw new Error('The requested command mode does not match this work session.');
  return goal;
}

function pendingOutcome(goal) {
  // Earlier records persisted successful receipts as monitoring + a positive
  // continuation count. Keep their accepted claim rather than counting it again.
  return goal.pendingOutcome || (goal.pendingNode && goal.state === 'monitoring'
    && Number(goal.continuationCount || 0) > 0 ? 'accepted' : 'uncertain');
}

function goalConfiguration(args = {}, existing = {}) {
  const mode = args.mode ?? existing?.mode ?? 'goal';
  const strategy = args.strategy ?? existing?.strategy ?? (args.mode ? 'adaptive' : 'fixed');
  if (!['goal', 'loop'].includes(mode)) throw new Error('Mode must be goal or loop.');
  if (!['fixed', 'adaptive'].includes(strategy)) throw new Error('Strategy must be fixed or adaptive.');
  const successCriteria = args.successCriteria ?? existing?.successCriteria ?? [];
  if (!Array.isArray(successCriteria) || successCriteria.length > 12
    || successCriteria.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) {
    throw new Error('Success criteria must contain at most 12 nonempty strings of at most 500 characters.');
  }
  const brief = String(args.brief ?? existing?.brief ?? (mode === 'loop' ? args.objective || existing?.objective || '' : ''));
  if (brief.length > 2_000) throw new Error('Loop brief must be at most 2000 characters.');
  return { mode, strategy, successCriteria: successCriteria.map(value => value.trim()), brief };
}

function goalRevisionCurrent(config, goal) {
  const current = loadGoal(config, goal.workId);
  return current?.active && current.revision === goal.revision;
}

function assertGoalCurrent(config, goal) {
  if (!goalRevisionCurrent(config, goal)) throw Object.assign(new Error('Goal state changed before submission.'),
    { code: 'GOAL_STATE_CHANGED', notSent: true });
}

function fixedContinuationPrompt(goal) {
  if (goal.mode !== 'loop') return goalContinuationPrompt(goal.workId, goal.objective);
  return 'Continue Loop work ' + goal.workId + ' within this original brief: ' + (goal.brief || goal.objective)
    + '. Inspect the exact work_id, receipts and latest plan first. Treat a finished iteration as a milestone. '
    + 'Choose the next useful step within the brief and update the plan through normal Rel.AI tools. '
    + 'Do not invent work outside the brief or repeat completed operations. Wait if no useful step is ready. '
    + 'Respect Stop, approvals and blockers; never bypass them. Loop has no total continuation limit.';
}

function invalidateGoalPoll(workId, code = 'GOAL_UPDATED') {
  clearBackgroundGoal(workId);
  activePolls.get(workId)?.abort(Object.assign(new Error('Goal configuration changed.'), { code }));
  clearTimeout(retryTimers.get(workId));
  retryTimers.delete(workId);
}

function pauseGoal(config, args, context) {
  const goal = requireOwnedGoal(config, args, context);
  const paused = mutateGoal(config, goal.workId, current => ({ ...current,
    active: false, state: 'paused', nextAttemptAt: 0, pauseReason: 'user', updatedAt: Date.now()
  }));
  invalidateGoalPoll(goal.workId, 'GOAL_PAUSED');
  return publicGoal(paused);
}

function resumeGoal(config, args, context) {
  const goal = requireOwnedGoal(config, args, context);
  const task = statusForTask(config, goal);
  if (!task || terminalGoalState(task)) throw new Error('Cannot resume a finished, cancelled or unavailable work session.');
  const conversationId = args.conversationUrl ? parseConversationUrl(args.conversationUrl) : goal.conversationId;
  const switching = conversationId !== goal.conversationId;
  if (switching && goal.active && goal.binding) throw new Error('Stop this goal before changing its linked conversation.');
  if (switching && goal.pendingNode && !['accepted', 'not_sent'].includes(pendingOutcome(goal))) {
    throw new Error('Reconcile the unresolved continuation in its original conversation before rebinding.');
  }
  const resumed = mutateGoal(config, goal.workId, current => ({ ...current,
    ...(switching ? { conversationId, binding: null, observedNode: '', stableSince: 0,
      pendingNode: '', pendingPrompt: '', pendingOutcome: 'not_sent' } : {}),
    active: true, state: 'monitoring', nextAttemptAt: 0, error: '', pauseReason: '',
    retryCount: 0, helperFailureCount: 0, noProgressCount: 0, objectiveAchieved: false, updatedAt: Date.now()
  }), { reactivate: true, expectedRevision: goal.revision });
  invalidateGoalPoll(goal.workId);
  if (monitorConfig && getStateDir(monitorConfig) === getStateDir(config)) {
    setImmediate(() => { if (monitorConfig) runGoalBackground(monitorConfig, goal.workId, 'poll'); });
  }
  return publicGoal(resumed);
}

function updateGoal(config, args, context) {
  // Mode is a configuration change here, not the namespace guard for controls.
  if (!loadGoal(config, String(args.work_id || '').trim())) {
    if (!['goal', 'loop'].includes(args.mode)) throw new Error('Select goal or loop to activate monitoring for this task.');
    return activateGoal(config, args, context);
  }
  const goal = requireOwnedGoal(config, { ...args, mode: undefined }, context);
  const objective = String(args.objective ?? goal.objective).trim();
  if (!objective || objective.length > 500) throw new Error('Goal objective must be 1-500 characters.');
  const configuration = goalConfiguration(args, goal);
  const updated = mutateGoal(config, goal.workId, current => ({ ...current, ...configuration, objective,
    commandResolutionPending: false,
    lastDecision: null, lastEvidenceFingerprint: '', helperFailureCount: 0, noProgressCount: 0, objectiveAchieved: false,
    nextAttemptAt: 0, updatedAt: Date.now()
  }), { reactivate: true });
  invalidateGoalPoll(goal.workId);
  return publicGoal(updated);
}

// This only consumes exact leading commands in the latest verified user turn.
// Paused/Stopped records require the normal authenticated resume tool; polling
// never wakes a stopped monitor merely because old chat text remains visible.
function observeGoalCommand(config, goal, conversation, snapshot) {
  const initiating = goal.commandResolutionPending
    ? initiatingGoalCommand(conversation, goal.workId, goal.createdAt) : null;
  // A later explicit Stop/Pause or new mode command wins over initial linking.
  const command = latestGoalCommand(conversation) || initiating;
  if (!command) return goal;
  const messageId = String(command.messageId || snapshot.userMessage?.id || '');
  if (!messageId || (!initiating && messageId === goal.lastCommandId)) return goal;
  if (command.action !== 'start' && command.mode !== (initiating?.mode || goal.mode)) return goal;
  const commandAt = snapshot.messages?.findIndex(node => node.message?.id === messageId) ?? -1;
  const exactWorkReceipt = initiating?.messageId === messageId || commandAt >= 0
    && snapshot.messages.slice(commandAt + 1).some(node => node.message?.author?.role === 'tool'
      && node.message?.content?.workIds?.includes(goal.workId));
  if (['stop', 'pause'].includes(command.action) && !exactWorkReceipt
    && listGoals(config).filter(item => item.owner === goal.owner && item.tunnelId === goal.tunnelId
      && item.conversationId === goal.conversationId
      && (item.active || item.pauseReason === 'ambiguous_command')).length > 1) {
    return saveGoal(config, { ...goal, lastCommandId: messageId, active: false, state: 'needs_user',
      pauseReason: 'ambiguous_command', nextAttemptAt: 0,
      error: 'Multiple work sessions share this conversation. Use the exact work_id to apply this command.', updatedAt: Date.now() });
  }
  let patch = { lastCommandId: messageId,
    ...(initiating ? { ...goalConfiguration(initiating, goal), objective: initiating.objective || goal.objective,
      commandResolutionPending: false } : {}), updatedAt: Date.now() };
  if (command.action === 'stop' || command.action === 'pause') {
    patch = { ...patch, active: false, state: command.action === 'stop' ? 'stopped' : 'paused',
      nextAttemptAt: 0, pauseReason: 'user' };
  } else if (command.action === 'start' && (goal.lastCommandId || initiating)) {
    const objective = String(command.objective || goal.objective).trim();
    const configuration = goalConfiguration(command, goal);
    const changedScope = objective !== goal.objective || configuration.brief !== (goal.brief || '');
    if (changedScope && !exactWorkReceipt) return saveGoal(config, { ...goal, lastCommandId: messageId,
      active: false, state: 'needs_user', nextAttemptAt: 0, pauseReason: 'scope_change',
      error: 'A new chat objective is not linked to this work_id. Update this exact goal or start separate work; its existing scope was preserved.',
      updatedAt: Date.now() });
    patch = { ...patch, ...configuration, objective,
      lastDecision: null, lastEvidenceFingerprint: '', helperFailureCount: 0, noProgressCount: 0, objectiveAchieved: false };
  }
  return saveGoal(config, { ...goal, ...patch });
}

function goalEvidence(config, goal, task, conversation, snapshot) {
  let integrity = null;
  try {
    const authority = readTaskIntegrity(config, goal.workId, goal.workspace);
    if (authority) integrity = { ...authority,
      workspaceGeneration: readWorkspaceIntegrity(config, goal.workspace).generation };
  } catch {
    // Missing authority is missing evidence, never proof of completion.
  }
  let workflowEvidence = [];
  try { workflowEvidence = readRecentWorkflowEvidence(config, goal.workId, 50); } catch {}
  return buildGoalEvidence({ goal, task: { ...task, workflowEvidence }, conversation, snapshot, integrity,
    previousFingerprint: goal.lastEvidenceFingerprint });
}

async function completionEvidenceCurrent(config, goal, evidence, signal) {
  if (!evidence.completionEligible || goal.mode === 'loop') return false;
  if (!goal.workspace || evidence.validation?.required === false) return true;
  const authority = readTaskIntegrity(config, goal.workId, goal.workspace);
  const fingerprint = String(authority?.validatedRepositoryFingerprint || authority?.validationFingerprint || '');
  if (!authority || authority.validationResult !== 'passed' || !fingerprint
    || authority.latestValidatedMutationGeneration !== authority.mutationGeneration
    || authority.validatedWorkspaceGeneration !== readWorkspaceIntegrity(config, goal.workspace).generation) return false;
  const workspace = resolveWorkspace(config, goal.workspace);
  const current = await createValidationFingerprint(workspace, config, { paths: authority.validationScope || [], signal });
  return current.fingerprint === fingerprint;
}

async function selectGoalContinuation(config, goal, task, conversation, snapshot, controller, deps) {
  if (goal.strategy !== 'adaptive') return { goal, prompt: fixedContinuationPrompt(goal) };
  const evidence = goalEvidence(config, goal, task, conversation, snapshot);
  const evaluate = deps.evaluateGoalDecision || evaluateGoalDecision;
  const decision = await evaluate({ ...deps, goal, evidence, signal: controller.signal,
    workId: goal.workId, expectedGoalRevision: goal.revision, conversationId: goal.conversationId,
    assertCurrent: () => assertGoalCurrent(config, goal) });
  if (controller.signal.aborted || !goalRevisionCurrent(config, goal)
    || !continuationTaskUnchanged(task, statusForTask(config, goal), goal)) return null;
  if (!decision || decision.expectedRevision !== goal.revision
    || decision.evidenceFingerprint !== evidence.fingerprint) return null;
  // A new user turn invalidates every decision, including completion and wait,
  // even when it did not invoke a local tool or alter the persisted revision.
  const fresh = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
  if (controller.signal.aborted || !goalRevisionCurrent(config, goal)
    || fresh.nodeId !== snapshot.nodeId || fresh.lastMessageId !== snapshot.lastMessageId
    || fresh.settled !== snapshot.settled
    || !continuationTaskUnchanged(task, statusForTask(config, goal), goal)) return null;
  if (goalEvidence(config, goal, statusForTask(config, goal), conversation, snapshot).fingerprint !== evidence.fingerprint) return null;
  const action = decision.action === 'complete' ? 'achieved' : decision.action;
  const outcome = { action, reason: String(decision.reason || '').slice(0, 1_000),
    evidenceRefs: Array.isArray(decision.evidenceRefs) ? decision.evidenceRefs.slice(0, 24) : [],
    criterionResults: Array.isArray(decision.criterionResults) ? decision.criterionResults.slice(0, 12) : [],
    evidenceFingerprint: evidence.fingerprint, at: Date.now() };
  const base = { ...goal, lastDecision: outcome, lastEvidenceFingerprint: evidence.fingerprint,
    evaluatorState: action === 'unavailable' ? 'unavailable_fixed_fallback' : 'adaptive',
    updatedAt: Date.now() };
  if (action === 'unavailable') {
    if (decision.code === 'GOAL_EVALUATOR_NEEDS_USER') {
      saveGoal(config, { ...base, active: false, state: 'needs_user',
        evaluatorState: 'needs_user', error: outcome.reason });
      return null;
    }
    if (['GOAL_EVALUATOR_QUOTA', 'GOAL_EVALUATOR_BUSY'].includes(decision.code)) {
      saveGoal(config, { ...base, state: decision.code === 'GOAL_EVALUATOR_QUOTA' ? 'rate_limited' : 'waiting',
        evaluatorState: 'unavailable_waiting', error: outcome.reason,
        nextAttemptAt: Date.now() + Math.max(POLL_MS, Math.min(24 * 60 * 60_000, Number(decision.retryAfterMs) || 60_000)) });
      return null;
    }
    const helperFailureCount = Number(goal.helperFailureCount || 0) + 1;
    if (helperFailureCount >= Math.max(1, Number(goal.bounds?.maxHelperFailures || 3))) {
      saveGoal(config, { ...base, helperFailureCount, active: false, state: 'paused',
        error: 'Adaptive helper is unavailable after repeated attempts. Resume or select fixed strategy to continue.' });
      return null;
    }
    const saved = saveGoal(config, { ...base, helperFailureCount, state: 'monitoring',
      error: 'Adaptive helper unavailable; using the fixed continuation fallback.' });
    return saved?.active && saved.revision === goal.revision + 1
      ? { goal: saved, prompt: fixedContinuationPrompt(saved) } : null;
  }
  base.helperFailureCount = 0;
  if (action === 'blocked' || action === 'needs_user') {
    saveGoal(config, { ...base, active: false, state: action === 'blocked' ? 'blocked' : 'needs_user',
      error: outcome.reason || 'The goal needs user attention before continuing.' });
    return null;
  }
  if (action === 'wait' || (action === 'achieved' && goal.mode === 'loop')) {
    const retryAfterMs = Math.max(POLL_MS, Math.min(5 * 60_000, Number(decision.retryAfterMs) || POLL_MS));
    saveGoal(config, { ...base, state: 'waiting', nextAttemptAt: Date.now() + retryAfterMs,
      error: '', noProgressCount: 0 });
    return null;
  }
  if (action === 'achieved') {
    const supported = await completionEvidenceCurrent(config, goal, evidence, controller.signal);
    if (controller.signal.aborted || !goalRevisionCurrent(config, goal)
      || !continuationTaskUnchanged(task, statusForTask(config, goal), goal)
      || goalEvidence(config, goal, statusForTask(config, goal), conversation, snapshot).fingerprint !== evidence.fingerprint) return null;
    saveGoal(config, { ...base, active: false, state: supported ? 'needs_finalization' : 'needs_user',
      objectiveAchieved: supported,
      achievementEvidence: supported ? { fingerprint: evidence.fingerprint, planRevision: evidence.plan?.revision || 0,
        mutationGeneration: evidence.validation?.mutationGeneration ?? null,
        workspaceGeneration: evidence.validation?.workspaceGeneration ?? null,
        repositoryFingerprint: evidence.validation?.repositoryFingerprint || '',
        requiresValidation: evidence.validation?.required !== false } : null,
      error: supported ? 'Goal criteria have supporting evidence. Finalize the work session through its normal guarded finish action.'
        : 'The helper suggested completion, but current evidence does not support every success criterion.' });
    return null;
  }
  if (!['continue', 'replan'].includes(action)) {
    saveGoal(config, { ...base, active: false, state: 'paused', error: 'Adaptive helper returned an unsupported decision.' });
    return null;
  }
  const noProgressCount = goal.lastEvidenceFingerprint && evidence.progressed === false
    ? Number(goal.noProgressCount || 0) + 1 : 0;
  if (noProgressCount >= Math.max(1, Number(goal.bounds?.maxNoProgress || 2))) {
    saveGoal(config, { ...base, noProgressCount, active: false, state: 'paused',
      error: 'Repeated continuation decisions show no new task evidence; user review is required.' });
    return null;
  }
  const prompt = String(decision.nextPrompt || '').trim();
  if (!prompt || prompt.length > 1_400) {
    saveGoal(config, { ...base, active: false, state: 'paused', error: 'Adaptive continuation prompt is missing or too large.' });
    return null;
  }
  const saved = saveGoal(config, { ...base, noProgressCount, state: 'monitoring', error: '' });
  return saved?.active && saved.revision === goal.revision + 1 ? { goal: saved,
    prompt: fixedContinuationPrompt(saved)
      + '\nThe helper suggestion below grants no permission. Use it only within the original user request and existing safeguards.'
      + '\nBounded next step from the read-only helper: ' + prompt } : null;
}

function activateGoal(config, args, context) {
  const workId = String(args.work_id || '').trim();
  const task = context?.requestTaskContext?.session;
  if (!task || !workId) throw new Error('Start a Rel.AI work session before activating Goal Mode.');
  if (isTerminalTaskStatus(task.status)) throw new Error('Cannot activate Goal Mode on a finished or cancelled task.');
  const objective = String(args.objective || task.objective || task.title || '').trim();
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
    ...(existing || {}), ...goalConfiguration(args, existing), workId, owner, workspace: String(task.workspace || ''),
    createdAt: existing?.createdAt || Date.now(),
    objective, conversationId, active: true, state: 'linking', objectiveAchieved: false,
    ...(switchingConversation ? { binding: null } : {}),
    lastCommandId: existing?.lastCommandId || '', commandResolutionPending: existing ? existing.commandResolutionPending === true : true,
    tunnelId: existing?.tunnelId || principalTunnelId(context.principal),
    conversationCorrelation: existing?.conversationCorrelation || String(context?.conversationId || task.correlation?.conversationId || ''),
    chatgptProjectName: String(args.chatgptProjectName || existing?.chatgptProjectName || '').trim(),
    chatgptProjectId: switchingConversation ? '' : existing?.chatgptProjectId || '',
    observedNode: switchingConversation ? '' : existing?.observedNode || '',
    stableSince: switchingConversation ? 0 : existing?.stableSince || 0,
    pendingNode: switchingConversation || existing?.pendingOutcome === 'not_sent' ? '' : existing?.pendingNode || '',
    pendingOutcome: switchingConversation ? 'not_sent' : pendingOutcome(existing || {}),
    ...(switchingConversation ? { pendingPrompt: '', pendingTaskCalls: 0,
      unfinishedTurnId: '', unfinishedTaskCalls: 0, unfinishedProgressAt: 0 } : {}),
    retryCount: existing?.active ? Number(existing.retryCount || 0) : 0,
    nextAttemptAt: existing?.active ? Number(existing.nextAttemptAt || 0) : 0,
    error: '', challenge: null, updatedAt: Date.now()
  }, { reactivate: true, activationContext: context });
  return publicGoal(goal);
}

function goalStatus(config, args, context) {
  return publicGoal(requireOwnedGoal(config, args, context));
}

function stopGoalRecord(config, goal) {
  clearBackgroundGoal(goal.workId);
  activePolls.get(goal.workId)?.abort();
  const stopped = mutateGoal(config, goal.workId, current => ({ ...current, active: false,
    state: 'stopped', authRequired: false, nextAttemptAt: 0, updatedAt: Date.now() }));
  scheduleGoalRetry(config, stopped);
  return publicGoal(stopped);
}

function resumeAuthenticatedGoals(config, tunnelId) {
  const resumed = [];
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
      const next = { ...current, revision: Number(current.revision || 0) + 1, active: true, state: 'monitoring', authRequired: false,
        retryCount: 0, nextAttemptAt: 0, error: '', challenge: null, updatedAt: Date.now() };
      db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify(next), goalKey(goal.workId));
      return next;
    }, { transaction: true });
    if (!updated) continue;
    activePolls.get(goal.workId)?.abort(Object.assign(new Error('ChatGPT sign-in was refreshed.'), { code: 'GOAL_AUTH_REFRESHED' }));
    scheduleGoalRetry(config, updated);
    resumed.push(goal.workId);
    if (monitorConfig && getStateDir(monitorConfig) === getStateDir(config)) {
      setImmediate(() => { if (monitorConfig) runGoalBackground(monitorConfig, goal.workId, 'poll'); });
    }
  }
  return { ok: true, resumedWorkIds: resumed, resumedDetectionWorkIds: [] };
}

function stopGoal(config, args, context) {
  const workId = String(args.work_id || '').trim();
  requireOwnedGoal(config, args, context);
  const stopped = publicGoal(mutateGoal(config, workId, current => ({ ...current,
    active: false, state: 'stopped', authRequired: false, nextAttemptAt: 0, updatedAt: Date.now()
  })));
  clearBackgroundGoal(workId);
  activePolls.get(workId)?.abort();
  scheduleGoalRetry(config, { workId, active: false });
  return stopped;
}

// Dashboard task control is authenticated locally and does not impersonate an MCP principal.
function dashboardGoalStatus(config, workId) {
  const goal = loadGoal(config, String(workId || '').trim());
  if (goal) return publicGoal(goal);
  return null;
}

function stopDashboardGoal(config, workId) {
  const goal = loadGoal(config, String(workId || '').trim());
  if (!goal) throw new Error('Goal Mode is not enabled for this task.');
  return stopGoalRecord(config, goal);
}

function publicGoal(goal) {
  return { ok: true, work_id: goal.workId, goalActive: goal.active,
    modeAcknowledgement: { requested: goal.mode || 'goal', effective: goal.mode || 'goal',
      readiness: goal.active && goal.binding && goal.state === 'monitoring' ? 'ready' : goal.state },
    state: goal.state, mode: goal.mode || 'goal', strategy: goal.strategy || 'fixed',
    revision: Number(goal.revision || 0), objective: goal.objective,
    successCriteria: goal.successCriteria || [], brief: goal.brief || '',
    objectiveAchieved: goal.objectiveAchieved === true,
    evaluatorState: goal.evaluatorState || (goal.strategy === 'adaptive' ? 'pending' : 'fixed'),
    lastDecision: goal.lastDecision || null, iterationCount: Number(goal.iterationCount || 0),
    helperFailureCount: Number(goal.helperFailureCount || 0), noProgressCount: Number(goal.noProgressCount || 0),
    conversationId: goal.conversationId || null,
    chatLink: { state: goal.pauseReason === 'binding_invalid' ? 'needs_attention' : goal.binding ? 'linked'
      : goal.authRequired || goal.state === 'needs_auth' ? 'waiting_for_account'
        : goal.state === 'rate_limited' ? 'rate_limited'
          : goal.active ? 'finding_chat' : 'needs_attention',
      ...(goal.state === 'rate_limited' ? { rateLimitReason: goal.rateLimitReason || 'upstream' } : {}),
      ...(goal.binding ? { version: goal.binding.version, verifiedAt: goal.binding.verifiedAt,
        conversationUrl: 'https://chatgpt.com/c/' + goal.conversationId } : {}) },
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

function terminalMonitorOutcome(goal, task) {
  const state = terminalGoalState(task);
  if (!state) return null;
  if (!task) return { state, error: 'Work session is unavailable; completion is unknown.' };
  if (task.status === 'completed' && goal.mode === 'loop') return {
    state: 'paused', error: 'The Loop work session was closed externally. It was not reopened.' };
  if (task.status === 'completed' && goal.strategy === 'adaptive' && !goal.objectiveAchieved) return {
    state: 'completed_unverified', error: 'The work session closed before adaptive success criteria were independently verified.' };
  return { state, error: '' };
}

function continuationTaskUnchanged(previous, current, goal = {}) {
  return current && !terminalGoalState(current)
    && !current.cancellationRequestedAt
    && current.status !== 'waiting_for_approval' && current.status !== 'blocked'
    && Number(current.activeCalls || 0) === 0 && (goal.mode === 'loop' || goal.strategy === 'adaptive' || !resolvedGoalPlan(current))
    && Number(current.calls || 0) === Number(previous.calls || 0)
    && current.lastActivityAt === previous.lastActivityAt;
}

function retryGoal(config, goal, error, { notSent = false } = {}) {
  const terminal = terminalMonitorOutcome(goal, statusForTask(config, goal));
  if (terminal) return saveGoal(config, { ...goal, active: false, ...terminal, updatedAt: Date.now() });
  const count = Number(goal.retryCount || 0);
  const exhausted = !error?.deferred && count >= MAX_RETRIES;
  const reason = error instanceof Error ? error.message : 'Goal continuation failed.';
  const retried = saveGoal(config, { ...goal,
    ...(notSent && goal.pendingOutcome !== 'accepted'
      ? { pendingNode: '', pendingOutcome: 'not_sent', pendingPrompt: '' } : {}),
    active: !exhausted, state: exhausted ? (error?.status === 401 ? 'needs_auth' : 'paused')
      : error?.status === 429 || error?.rateLimitReason === 'read_budget' ? 'rate_limited'
      : !notSent && goal.pendingNode ? 'verifying' : 'retrying',
    retryCount: exhausted || error?.deferred ? count : count + 1,
    nextAttemptAt: exhausted ? 0 : Math.max(Number(error?.retryAt || 0),
      Date.now() + (error?.deferred ? RETRY_DELAYS_MS[0] : RETRY_DELAYS_MS[count])),
    challenge: error?.challenge || null,
    rateLimitReason: error?.rateLimitReason === 'read_budget' ? 'read_budget' : 'upstream',
    authRequired: error?.status === 401,
    error: exhausted ? `Automatic continuation stopped after five retries: ${reason}` : reason, updatedAt: Date.now()
  });
  scheduleGoalRetry(config, retried);
  return retried;
}

function deferGoalDiscovery(config, goal, deps, error = null) {
  const terminal = terminalMonitorOutcome(goal, statusForTask(config, goal));
  if (terminal) return saveGoal(config, { ...goal, active: false, ...terminal, updatedAt: Date.now() });
  const count = Number(goal.retryCount || 0);
  return saveGoal(config, { ...goal, discoveryScan: deps.discovery?.scan || null,
    rateLimitReason: error?.rateLimitReason === 'read_budget' ? 'read_budget' : 'upstream',
    active: error?.status !== 401, state: error?.status === 401 ? 'needs_auth'
      : error?.status === 429 || error?.rateLimitReason === 'read_budget' ? 'rate_limited' : 'linking',
    retryCount: error?.deferred || error?.status === 429 ? count : Math.min(count + 1, MAX_RETRIES),
    nextAttemptAt: error?.status === 401 ? 0 : error?.retryAt ? Math.max(Number(error.retryAt), Date.now() + 1_000)
      : Date.now() + (RETRY_DELAYS_MS[count] || DISCOVERY_RETRY_MS),
    authRequired: error?.status === 401,
    error: error ? detectionError(error) : 'Waiting for the task receipt; chat discovery will continue automatically.',
    updatedAt: Date.now() });
}

function acceptContinuation(config, goal) {
  // Receipt acceptance is monotonic even if a user changed configuration while
  // the send was in flight. Keep their new state, and never reactivate Stop.
  return mutateGoal(config, goal.workId, current => {
    if (current.pendingNode !== goal.pendingNode || current.pendingOutcome === 'accepted') return null;
    const terminal = terminalMonitorOutcome(current, statusForTask(config, current));
    return { ...current, active: current.active && !terminal,
      state: !current.active ? current.state : terminal?.state || 'monitoring',
      ...(current.active ? { error: terminal?.error || '', challenge: null, authRequired: false, retryCount: 0, nextAttemptAt: 0 } : {}),
      pendingOutcome: 'accepted', pendingPrompt: '',
      sentTaskCalls: Number(goal.pendingTaskCalls ?? current.sentTaskCalls ?? 0),
      continuationCount: Number(current.continuationCount || 0) + 1, updatedAt: Date.now() };
  }, { recordReceipt: true });
}

async function continueGoal(config, goal, snapshot, task, controller, deps, recover = false, prompt = '') {
  const claimed = claimContinuation(config, goal.workId, snapshot.nodeId, Number(task.calls || 0), {
    expectedRevision: goal.revision, prompt: prompt || fixedContinuationPrompt(goal)
  });
  if (!claimed) return;
  // The existing task owner invalidates native work throughout navigation and
  // composer preparation, not only at the monitor's earlier protocol read.
  const unsubscribe = onToolActivity(event => {
    if (String(event.taskId || event.task?.id || '') === goal.workId
      && !continuationTaskUnchanged(task, statusForTask(config, goal), goal)) controller.abort();
  });
  let sendAttempted = false;
  try {
    controller.signal.throwIfAborted();
    if (!goalRevisionCurrent(config, claimed)) { clearUnsentContinuation(config, claimed); return; }
    let parent = snapshot;
    if (recover) {
      const before = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
      if (before.nodeId !== snapshot.nodeId || before.role !== 'assistant'
        || !continuationTaskUnchanged(task, statusForTask(config, goal), goal)) {
        throw new Error('ChatGPT conversation or task changed before stalled-turn recovery.');
      }
      if (!goalRevisionCurrent(config, claimed)) { clearUnsentContinuation(config, claimed); return; }
      await stopStalledTurn(goal.conversationId, snapshot.nodeId, { ...deps, signal: controller.signal,
        workId: claimed.workId, expectedGoalRevision: claimed.revision,
        assertCurrent: () => assertGoalCurrent(config, claimed) });
      controller.signal.throwIfAborted();
      parent = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
      if (parent.nodeId !== snapshot.nodeId || parent.role !== 'assistant' || !parent.lastMessageId
        || !continuationTaskUnchanged(task, statusForTask(config, goal), goal)) {
        throw new Error('ChatGPT conversation or task changed during stalled-turn recovery.');
      }
      if (!parent.settled) throw new Error('ChatGPT response is still unfinished.');
    }
    controller.signal.throwIfAborted();
    if (!goalRevisionCurrent(config, claimed)) { clearUnsentContinuation(config, claimed); return; }
    if (!continuationTaskUnchanged(task, statusForTask(config, goal), goal)) throw new Error('Work session changed before sending.');
    sendAttempted = true;
    await sendContinue(goal.conversationId, parent.lastMessageId, { ...deps,
      workId: claimed.workId, objective: claimed.objective, nodeId: parent.nodeId, prompt: claimed.pendingPrompt,
      signal: controller.signal, expectedGoalRevision: claimed.revision,
      assertCurrent: () => assertGoalCurrent(config, claimed) });
    // An accepted send is a receipt even if the new turn immediately starts
    // MCP activity and invalidates the previous task snapshot.
    acceptContinuation(config, claimed);
  } catch (error) {
    const latest = loadGoal(config, goal.workId);
    if ((!sendAttempted || error?.notSent === true)
      && (controller.signal.aborted || latest?.revision !== claimed.revision)) {
      clearUnsentContinuation(config, claimed);
      return;
    }
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
      const unverified = task?.status === 'completed' && goal.strategy === 'adaptive' && !goal.objectiveAchieved;
      const closedLoop = task?.status === 'completed' && goal.mode === 'loop';
      saveGoal(config, { ...goal, active: false,
        state: closedLoop ? 'paused' : unverified ? 'completed_unverified' : terminalState,
        error: closedLoop ? 'The Loop work session was closed externally. It was not reopened.'
          : unverified ? 'The work session closed before adaptive success criteria were independently verified.'
            : task ? '' : 'Work session is unavailable; completion is unknown.',
        updatedAt: Date.now() });
      return;
    }
    // A fully resolved plan needs work-session finalization, not another AI
    // response. Never let a browser handoff failure hide known blockers.
    const planOutcome = resolvedGoalPlan(task);
    if (planOutcome === 'blocked' && (goal.mode === 'loop' || goal.strategy === 'adaptive')
      && Number(task.activeCalls || 0) === 0) {
      saveGoal(config, { ...goal, active: false, state: 'blocked',
        error: 'The work plan contains a blocker that requires attention before continuing.', updatedAt: Date.now() });
      return;
    }
    if (planOutcome && goal.mode !== 'loop' && goal.strategy !== 'adaptive' && Number(task.activeCalls || 0) === 0) {
      saveGoal(config, { ...goal, active: false, state: 'needs_finalization',
        error: 'Work plan has no actionable steps left. Finalize with relai_work finish; preserve blocked steps.',
        updatedAt: Date.now() });
      return;
    }
    if (Date.now() < Number(goal.nextAttemptAt || 0)) return;
    // Local work and approval waits cannot need another continuation. Avoid
    // remote reads until they settle; uncertain sends still need reconciliation.
    if ((!deps.linkId || goal.binding) && (!goal.pendingNode || ['accepted', 'not_sent'].includes(goal.pendingOutcome))
      && (Number(task.activeCalls || 0) > 0 || task.status === 'waiting_for_approval' || task.status === 'blocked')) return;
    // Consume the deadline once this retry can run. A successful observation
    // may need to wait for branch settlement instead of sending immediately.
    if (goal.nextAttemptAt) goal = saveGoal(config, { ...goal, nextAttemptAt: 0 });
    const needsBinding = !goal.binding || deps.linkId && goal.binding.version !== 1;
    if ((!goal.conversationId || needsBinding) && (!goal.pendingNode || ['accepted', 'not_sent'].includes(pendingOutcome(goal)))) {
      deps = coordinatedGoalDeps(config, goal, deps);
      const match = await findRecentGoalCommand({ ...deps, startedAt: goal.createdAt, signal: controller.signal,
        conversationCorrelation: goal.conversationId || verifiedCorrelation(config, goal),
        explicitConversation: Boolean(goal.conversationId), workId,
        verifyLegacy: Boolean(goal.conversationId && !deps.linkId), requireWorkReceipt: true, explicitGoal: true });
      if (controller.signal.aborted) return;
      if (match.state === 'ambiguous') {
        saveGoal(config, { ...goal, active: false, state: 'needs_user',
          error: 'Multiple chats contain this task receipt; automatic linking cannot identify a unique conversation.' });
        return;
      }
      if (match.state !== 'matched') {
        deferGoalDiscovery(config, goal, deps);
        return;
      }
      const initiating = deps.linkId && goal.commandResolutionPending && match.command
        ? { ...goalConfiguration(match.command, goal), objective: match.command.objective || goal.objective } : {};
      goal = commitGoalBinding(config, { ...goal, ...initiating,
        ...(deps.linkId ? { commandResolutionPending: false, lastCommandId: match.messageId } : {}) }, match);
      if (!goal) return;
    }
    const observationRevision = goal.revision;
    const observationConversationId = goal.conversationId;
    const conversation = await getConversation(observationConversationId, { ...deps, signal: controller.signal });
    const snapshot = turnState(conversation);
    if (controller.signal.aborted) return;
    goal = loadGoal(config, workId);
    if (!goal?.active || goal.conversationId !== observationConversationId || goal.revision !== observationRevision) return;
    if (deps.linkId && goal.binding?.version === 1 && !hasChatLinkReceipt(conversation, workId, deps.linkId, goal.binding)) {
      saveGoal(config, { ...goal, active: false, state: 'needs_user', pauseReason: 'binding_invalid',
        error: 'The linked task receipt is no longer on this chat branch. Verify the intended conversation before continuing.' });
      return;
    }
    goal = observeGoalCommand(config, goal, conversation, snapshot);
    if (!goal?.active) return;
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
          if (Number(goal.continuationCount || 0) > 0 && Number(live.calls || 0) <= Number(goal.sentTaskCalls || 0)) {
            saveGoal(config, { ...goal, active: false, state: 'paused',
              error: 'No new Rel.AI task activity after the previous continuation.', updatedAt: Date.now() });
            return;
          }
          const selected = await selectGoalContinuation(config, goal, live, conversation, snapshot, controller, deps);
          if (selected) await continueGoal(config, selected.goal, snapshot, live, controller, deps, true, selected.prompt);
        } else if (update) saveGoal(config, update);
      }
      return;
    }
    if (!snapshot.lastMessageId || !snapshot.nodeId || Date.now() - Number(goal.stableSince || 0) < SETTLE_MS) return;
    if (goal.pendingNode === snapshot.nodeId) return; // Includes uncertain transport outcomes.
    if (Number(goal.continuationCount || 0) > 0 && Number(live.calls || 0) <= Number(goal.sentTaskCalls || 0)) {
      saveGoal(config, { ...goal, active: false, state: 'paused', error: 'No new Rel.AI task activity after the previous continuation.', updatedAt: Date.now() });
      return;
    }
    const selected = await selectGoalContinuation(config, goal, live, conversation, snapshot, controller, deps);
    if (!selected) return;
    goal = selected.goal;
    // Recheck before any write. Browser/user input may have advanced the branch since
    // the earlier poll; if so, wait for the new turn to settle instead of posting.
    const fresh = turnState(await getConversation(goal.conversationId, { ...deps, signal: controller.signal }));
    if (controller.signal.aborted || !goalRevisionCurrent(config, goal)) return;
    if (fresh.nodeId !== snapshot.nodeId || !fresh.settled || fresh.lastMessageId !== snapshot.lastMessageId
      || !continuationTaskUnchanged(live, statusForTask(config, goal), goal)) return;
    await continueGoal(config, goal, snapshot, live, controller, deps, false, selected.prompt);
  } catch (error) {
    if (!controller.signal.aborted) {
      const goal = loadGoal(config, workId);
      if (goal?.active) {
        if (!goal.binding && (!goal.pendingNode || ['accepted', 'not_sent'].includes(pendingOutcome(goal)))) {
          deferGoalDiscovery(config, goal, deps, error);
        } else retryGoal(config, goal, error,
          { notSent: !goal.pendingNode || ['accepted', 'not_sent'].includes(goal.pendingOutcome) });
      }
    }
  } finally {
    activePolls.delete(workId);
    // A busy/closing database must not turn a completed poll into an unhandled
    // rejection; the ordinary monitor cycle will restore the durable deadline.
    try { scheduleGoalRetry(config, loadGoal(config, workId)); } catch {}
  }
}

function recoverAutomaticDiscovery(config) {
  const lookupFailure = error => /^(?:The named ChatGPT Project was not found in the connected account\.|No matching work receipt in the ten most recently updated eligible chats\.|(?:Automatic continuation stopped after five retries: )?No matching Goal Mode receipt in the ten most recently updated eligible chats\.)$/.test(error || '');
  const eligible = record => {
    if (!canMonitorGoal(record) || record.binding || record.state === 'stopped' || record.pauseReason === 'user'
      || !lookupFailure(record.error)) return false;
    const task = statusForTask(config, record);
    return task && !terminalGoalState(task)
      && (!task.principalFingerprint || task.principalFingerprint === record.owner);
  };
  for (const goal of listGoals(config)) {
    if (!eligible(goal)) continue;
    mutateGoal(config, goal.workId, current => ({ ...current, active: true, state: 'linking',
      error: '', discoveryScan: null, retryCount: 0, nextAttemptAt: Date.now() }),
    { reactivate: true, expectedRevision: goal.revision });
  }
  // These records were speculative checks of ordinary connector tasks. They
  // carry no explicit monitoring intent and must never restart account scans.
  withStateDatabase(config, db => db.prepare('DELETE FROM state_meta WHERE key GLOB ?')
    .run(DETECTION_PREFIX + '*'), { transaction: true });
}

function startGoalMonitor(config) {
  if (timer) return;
  monitorConfig = config;
  recoverAutomaticDiscovery(config);
  for (const goal of listGoals(config)) scheduleGoalRetry(config, goal);
  timer = setInterval(() => {
    try {
      const goals = listGoals(config).sort((a, b) => {
        const priority = goal => goal.pendingNode && !['accepted', 'not_sent'].includes(pendingOutcome(goal)) ? 0 : goal.binding ? 1 : 2;
        return priority(a) - priority(b) || Number(a.nextAttemptAt || 0) - Number(b.nextAttemptAt || 0);
      });
      for (const goal of goals) {
        if (goal.active) runGoalBackground(config, goal.workId, 'poll');
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
  for (const pending of backgroundGoals.values()) clearTimeout(pending.timer);
  backgroundGoals.clear();
  for (const wake of retryTimers.values()) clearTimeout(wake);
  retryTimers.clear();
  for (const controller of activePolls.values()) controller.abort();
}

export { activateGoal, pauseGoal, resumeGoal, updateGoal, resolvedGoalPlan, unfinishedTurnUpdate, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal, resumeAuthenticatedGoals, pollGoal, startGoalMonitor, stopGoalMonitor };
