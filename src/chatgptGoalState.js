// Durable Goal/Loop records share the existing state_meta namespace so upgrades
// preserve stopped goals, spent counters and unresolved submission receipts.
import { withStateDatabase } from './stateDatabase.ts';
import { randomBytes } from 'node:crypto';
import { principalFingerprint } from './mcp/principal.ts';
import { principalTunnelId } from './mcp/tunnelIdentity.js';
import { goalContinuationPrompt } from './chatgptGoalProtocol.js';

const PREFIX = 'chatgpt_goal:';
const LINK_PREFIX = 'chatgpt_goal_link:';

// This receipt identifies a tool response, never authorizes task execution.
function ensureChatLink(config, workId, context) {
  if (!context?.connector) return null;
  const owner = principalFingerprint(context.principal || 'anonymous');
  const tunnelId = principalTunnelId(context.principal);
  return withStateDatabase(config, db => {
    const key = LINK_PREFIX + workId;
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(key);
    const link = row ? JSON.parse(row.value) : {
      workId, owner, tunnelId, issuedAt: Date.now(), linkId: randomBytes(24).toString('base64url')
    };
    if (link.owner !== owner || link.tunnelId !== tunnelId) throw new Error('Chat linking owner mismatch.');
    if (!row) db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?)').run(key, JSON.stringify(link));
    return { version: 1, link_id: link.linkId };
  }, { transaction: true });
}

function readChatLink(config, record) {
  return withStateDatabase(config, db => {
    const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(LINK_PREFIX + record.workId);
    const link = row ? JSON.parse(row.value) : null;
    return link?.owner === record.owner && link.tunnelId === (record.tunnelId || '') ? link : null;
  }, { readonly: true, missingValue: null });
}


function commitGoalBinding(config, goal, match, { detection = false } = {}) {
  return withStateDatabase(config, db => {
    const row = readGoalRow(db, goal.workId);
    const detectionKey = 'chatgpt_goal_detection:' + goal.workId;
    if (detection) {
      const pending = db.prepare('SELECT value FROM state_meta WHERE key=?').get(detectionKey);
      if (row || !pending || JSON.parse(pending.value).state !== 'checking') return null;
    } else if (!row?.goal.active || row.goal.revision !== goal.revision) return null;
    const linkRow = db.prepare('SELECT value FROM state_meta WHERE key=?').get(LINK_PREFIX + goal.workId);
    const link = linkRow ? JSON.parse(linkRow.value) : null;
    if (link && (link.owner !== goal.owner || link.tunnelId !== (goal.tunnelId || ''))) return null;
    const claimKey = 'chatgpt_goal_command:' + (link ? goal.owner + ':' + (goal.tunnelId || '') + ':' : '')
      + match.conversationId + ':' + match.messageId;
    const claim = db.prepare('SELECT value FROM state_meta WHERE key=?').get(claimKey);
    if (claim && claim.value !== goal.workId) return null;
    const binding = { version: link ? 1 : 0, conversationId: match.conversationId,
      owner: goal.owner, tunnelId: goal.tunnelId || '', messageId: match.messageId,
      receiptMessageId: match.receiptMessageId || '', verifiedAt: Date.now() };
    const saved = writeGoalRow(db, row, { ...goal, conversationId: match.conversationId,
      ...(match.projectId ? { chatgptProjectId: match.projectId } : {}),
      binding, discoveryScan: null, state: 'monitoring', error: '', retryCount: 0, nextAttemptAt: 0, updatedAt: Date.now() });
    if (!claim) db.prepare('INSERT INTO state_meta(key,value) VALUES(?,?)').run(claimKey, goal.workId);
    if (detection) db.prepare('DELETE FROM state_meta WHERE key=?').run(detectionKey);
    return saved;
  }, { transaction: true });
}

function goalKey(workId) { return PREFIX + String(workId); }

function nonnegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeGoalRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const sourceBounds = record.bounds && typeof record.bounds === 'object' && !Array.isArray(record.bounds)
    ? record.bounds : {};
  // Old total-count/time caps are no longer policy. Removing them from the
  // effective record does not change whether a previously stopped goal is active.
  const { maxContinuations: _maxContinuations, maxDurationMs: _maxDurationMs, ...bounds } = sourceBounds;
  const continuationCount = nonnegativeInteger(record.continuationCount);
  return {
    ...record,
    mode: record.mode === 'loop' ? 'loop' : 'goal',
    strategy: record.strategy === 'adaptive' ? 'adaptive' : 'fixed',
    objective: typeof record.objective === 'string' ? record.objective : '',
    successCriteria: Array.isArray(record.successCriteria) ? record.successCriteria : [],
    brief: typeof record.brief === 'string' ? record.brief : '',
    bounds: {
      ...bounds,
      maxNoProgress: nonnegativeInteger(bounds.maxNoProgress, 2),
      maxHelperFailures: nonnegativeInteger(bounds.maxHelperFailures, 3)
    },
    revision: nonnegativeInteger(record.revision),
    continuationCount,
    iterationCount: nonnegativeInteger(record.iterationCount),
    lastDecision: record.lastDecision ?? null,
    lastEvidenceFingerprint: typeof record.lastEvidenceFingerprint === 'string' ? record.lastEvidenceFingerprint : '',
    noProgressCount: nonnegativeInteger(record.noProgressCount),
    helperFailureCount: nonnegativeInteger(record.helperFailureCount),
    // Legacy successful sends were recorded as monitoring + a positive count.
    // Every other missing receipt remains uncertain, never implicitly unsent.
    ...(record.pendingNode && !record.pendingOutcome ? {
      pendingOutcome: record.state === 'monitoring' && continuationCount > 0 ? 'accepted' : 'uncertain'
    } : {})
  };
}

function readGoalRow(db, workId) {
  const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(goalKey(workId));
  return row ? { value: row.value, goal: normalizeGoalRecord(JSON.parse(row.value)) } : null;
}

function loadGoal(config, workId) {
  return withStateDatabase(config, db => readGoalRow(db, workId)?.goal || null,
    { readonly: true, missingValue: null });
}

function listGoals(config) {
  return withStateDatabase(config, db => db.prepare('SELECT value FROM state_meta WHERE key GLOB ?')
    .all(PREFIX + '*').map(row => normalizeGoalRecord(JSON.parse(row.value))).filter(Boolean),
  { readonly: true, missingValue: [] });
}

function writeGoalRow(db, row, goal, options = {}) {
  const current = row?.goal;
  const expectedRevision = options.expectedRevision ?? goal.revision ?? 0;
  if (current && current.revision !== expectedRevision) return current;
  if (current?.state === 'stopped' && options.reactivate !== true) {
    // An accepted transport receipt may arrive after Stop. Record it exactly
    // once, without letting the delayed sender alter Stop or newer settings.
    if (options.recordReceipt !== true || goal.active !== false || goal.state !== 'stopped'
      || !current.pendingNode || current.pendingNode !== goal.pendingNode
      || current.pendingOutcome !== 'uncertain' || goal.pendingOutcome !== 'accepted') return current;
    goal = { ...current, pendingOutcome: 'accepted', pendingPrompt: '',
      sentTaskCalls: current.pendingTaskCalls ?? current.sentTaskCalls ?? 0,
      continuationCount: current.continuationCount + 1, updatedAt: goal.updatedAt ?? Date.now() };
  }
  if (current && options.reactivate !== true && !current.active && goal.active) return current;
  if (current && current.owner !== goal.owner) throw new Error('Goal Mode owner mismatch.');
  const revision = (current?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('Goal revision exceeds the supported range.');
  const next = normalizeGoalRecord({ ...current, ...goal,
    revision,
    // Neither explicit reactivation nor a delayed write replenishes spent work.
    continuationCount: Math.max(current?.continuationCount || 0, nonnegativeInteger(goal.continuationCount)),
    iterationCount: Math.max(current?.iterationCount || 0, nonnegativeInteger(goal.iterationCount))
  });
  const key = goalKey(next.workId);
  if (row) {
    const update = db.prepare('UPDATE state_meta SET value=? WHERE key=? AND value=?')
      .run(JSON.stringify(next), key, row.value);
    return update.changes === 1 ? next : readGoalRow(db, next.workId)?.goal || null;
  }
  const inserted = db.prepare('INSERT OR IGNORE INTO state_meta(key,value) VALUES(?,?)').run(key, JSON.stringify(next));
  return inserted.changes === 1 ? next : readGoalRow(db, next.workId)?.goal || null;
}

function saveGoal(config, goal, options = {}) {
  if (!goal || !String(goal.workId || '').trim()) throw new Error('Goal work ID is required.');
  return withStateDatabase(config, db => writeGoalRow(db, readGoalRow(db, goal.workId), goal, options),
    { transaction: true });
}

// Synchronous mutations such as Stop must operate on the current record inside
// one transaction. Async observations instead pass the revision they observed.
function updateGoal(config, workId, updater, options = {}) {
  return withStateDatabase(config, db => {
    const row = readGoalRow(db, workId);
    if (!row?.goal) return null;
    if (options.expectedRevision !== undefined && options.expectedRevision !== row.goal.revision) return row.goal;
    const next = updater(structuredClone(row.goal));
    if (!next) return null;
    if (typeof next.then === 'function') throw new TypeError('Goal state updater must be synchronous.');
    if (next.workId !== row.goal.workId) throw new Error('Goal state updater cannot change the work ID.');
    return writeGoalRow(db, row, next, { ...options, expectedRevision: row.goal.revision });
  }, { transaction: true });
}

function claimContinuation(config, workId, nodeId, taskCalls, options = {}) {
  return withStateDatabase(config, db => {
    const row = readGoalRow(db, workId);
    const current = row?.goal;
    const link = db.prepare('SELECT 1 FROM state_meta WHERE key=?').get(LINK_PREFIX + workId);
    if (link && (!current?.binding || current.binding.version !== 1
      || current.binding.conversationId !== current.conversationId || current.binding.owner !== current.owner
      || current.binding.tunnelId !== (current.tunnelId || ''))) return null;
    if (!current?.active || !nodeId || options.expectedRevision !== current.revision
      || current.pendingNode === nodeId || current.observedNode !== nodeId
      || (current.pendingNode && !['accepted', 'not_sent'].includes(current.pendingOutcome))) return null;
    const prompt = typeof options.prompt === 'string' && options.prompt.trim()
      ? options.prompt : goalContinuationPrompt(current.workId, current.objective);
    return writeGoalRow(db, row, { ...current,
      pendingNode: nodeId, pendingOutcome: 'uncertain', pendingPrompt: prompt,
      pendingTaskCalls: nonnegativeInteger(taskCalls), state: 'sending', updatedAt: Date.now()
    }, { expectedRevision: current.revision });
  }, { transaction: true });
}

// Call only for a locally unattempted send or an explicit transport not-sent
// receipt. Revision changes do not turn known-unsent work into an ambiguous send.
function clearUnsentContinuation(config, claimed) {
  return withStateDatabase(config, db => {
    const row = readGoalRow(db, claimed.workId);
    const current = row?.goal;
    if (!current || !claimed.pendingNode || current.pendingNode !== claimed.pendingNode
      || current.pendingPrompt !== claimed.pendingPrompt || current.pendingOutcome !== 'uncertain') return current || null;
    const revision = current.revision + 1;
    if (!Number.isSafeInteger(revision)) throw new Error('Goal revision exceeds the supported range.');
    const next = { ...current, revision, pendingNode: '', pendingPrompt: '', pendingOutcome: 'not_sent',
      state: current.active && current.state === 'sending' ? 'monitoring' : current.state, updatedAt: Date.now() };
    const changed = db.prepare('UPDATE state_meta SET value=? WHERE key=? AND value=?')
      .run(JSON.stringify(next), goalKey(current.workId), row.value);
    return changed.changes === 1 ? next : readGoalRow(db, current.workId)?.goal || null;
  }, { transaction: true });
}

function assertCompletionRevision(current, options) {
  if (current && options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
    throw Object.assign(new Error('Goal state changed while completion evidence was being collected; retry against the current goal.'),
      { code: 'GOAL_STATE_CHANGED' });
  }
}

function recordLoopMilestone(config, workId, milestone, options = {}) {
  if (!milestone || typeof milestone !== 'object' || Array.isArray(milestone)) {
    throw new TypeError('Loop milestone must be an object.');
  }
  return withStateDatabase(config, db => {
    const row = readGoalRow(db, workId);
    const current = row?.goal;
    assertCompletionRevision(current, options);
    if (!current?.active || current.mode !== 'loop' || current.state === 'stopped') return null;
    if (milestone.operationId && milestone.operationId === current.lastMilestone?.operationId) return current;
    const iterationCount = current.iterationCount + 1;
    if (!Number.isSafeInteger(iterationCount)) throw new Error('Loop iteration count exceeds the supported range.');
    const now = Date.now();
    return writeGoalRow(db, row, { ...current, iterationCount,
      lastMilestone: { ...milestone, recordedAt: now }, updatedAt: now
    }, { expectedRevision: current.revision });
  }, { transaction: true });
}

function recordGoalCompletionRequest(config, workId, completion, options = {}) {
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
    throw new TypeError('Goal completion request must be an object.');
  }
  return withStateDatabase(config, db => {
    const row = readGoalRow(db, workId);
    const current = row?.goal;
    assertCompletionRevision(current, options);
    if (!current || current.mode !== 'goal' || current.strategy !== 'adaptive'
      || current.objectiveAchieved || current.state === 'stopped') return null;
    if (completion.operationId && completion.operationId === current.completionRequest?.operationId) return current;
    const now = Date.now();
    return writeGoalRow(db, row, { ...current,
      completionRequest: { ...completion, recordedAt: now }, updatedAt: now
    }, { expectedRevision: current.revision });
  }, { transaction: true });
}

export { ensureChatLink, readChatLink, commitGoalBinding, goalKey, normalizeGoalRecord, loadGoal, listGoals, saveGoal, updateGoal, claimContinuation, clearUnsentContinuation, recordLoopMilestone, recordGoalCompletionRequest };
