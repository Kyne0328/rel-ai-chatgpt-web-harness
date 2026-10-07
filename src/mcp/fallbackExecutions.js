import * as crypto from 'node:crypto';
import { resolveWorkspaceInput } from '../config.js';
import { getTaskHistoryDir, readSession } from '../taskHistoryStorage.ts';
import { withStateDatabase } from '../stateDatabase.ts';
import { stableJson } from '../stableJson.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../durableState.ts';
import { getStateDir } from '../statePaths.js';
import { readTaskBackgroundOperation, readTaskBackgroundOperations, recordTaskBackgroundOperation } from '../taskHistoryStore.ts';
import { sanitizeTaskRecord } from '../taskObservability.js';
import { retainOutputStreams } from '../outputSpill.js';
import { FALLBACK_EXECUTION_STATUS } from './contracts.ts';
import { publishMcpEvent } from './events.ts';

const DEFAULT_FALLBACK_GRACE_MS = 1_000;
const MAX_FALLBACK_RESULT_WAIT_MS = 5_000;
const MAX_CONCURRENT_RESULT_WAITS = 4;
const fallbackResultWaiters = new Map();
const FALLBACK_RECORD_TTL_MS = 15 * 60_000;
const MAX_FALLBACK_RECORDS = 128;
const MAX_COMPLETION_NOTICES = 16;
const FALLBACK_PRUNE_INTERVAL_MS = 30_000;
const fallbackPrunes = new Map();
const REPLAYABLE_FALLBACK_STATUSES = new Set([
  FALLBACK_EXECUTION_STATUS.COMPLETED,
  FALLBACK_EXECUTION_STATUS.FAILED,
  FALLBACK_EXECUTION_STATUS.CANCELLED,
  FALLBACK_EXECUTION_STATUS.INTERRUPTED
]);
const executionsByOperationId = new Map();
const pendingCompletionDeliveries = new Map();

function activeFallbackWorkIds() {
  return [...new Set([...executionsByOperationId.values()]
    .filter(record => record.status === FALLBACK_EXECUTION_STATUS.RUNNING && record.workId)
    .map(record => record.workId))];
}

function startFallbackExecution({ config = null, workId = '', scopeId = '', noticeScope = '', tool, workspace = '', signature = '', deadlineAtMs = 0, run, persist = true, now = Date.now }) {
  const work = String(workId || '').trim();
  const id = work || String(scopeId || '').trim();
  if (!id) throw new Error('Fallback execution requires a durable work_id or authorized workspace execution scope.');
  if (typeof run !== 'function') throw new TypeError('Fallback execution requires a run function.');
  pruneFallbackExecutions(now);

  const reusable = () => recordsForReference(id).findLast(record => record.signature === signature
    && (!noticeScope || record.noticeScope === noticeScope)
    && (!workspace || canonicalizeFallbackWorkspace(record, config).workspace === workspace)
    && (record.status === FALLBACK_EXECUTION_STATUS.RUNNING
      || (record.deliveryAcknowledged !== true && REPLAYABLE_FALLBACK_STATUSES.has(record.status))));
  // A disk failure must not make a still-live terminal result inaccessible.
  let existing = reusable();
  if (!existing && persist !== false) {
    recoverExecutionRecords(id, { config, now, noticeScope, workspace, scopeOnly: !work });
    existing = reusable();
  }
  if (existing) {
    return { record: existing, reused: true };
  }

  const startedAtMs = timeValue(now);
  const startedAt = new Date(startedAtMs).toISOString();
  const controller = new AbortController();
  const record = {
    operationId: `fallback_${crypto.randomUUID()}`,
    executionKey: id,
    workId: work,
    tool: String(tool || ''),
    workspace: String(workspace || ''),
    noticeScope: String(noticeScope || ''),
    noticeEnabled: false,
    signature,
    status: FALLBACK_EXECUTION_STATUS.RUNNING,
    phase: 'accepted',
    timeline: { phase: 'accepted', phaseStartedAt: startedAt, lastProgressAt: startedAt, executed: false, phases: [{ phase: 'accepted', startedAt }] },
    deadlineAtMs: Number.isFinite(Number(deadlineAtMs)) && Number(deadlineAtMs) > 0 ? Math.floor(Number(deadlineAtMs)) : 0,
    startedAt,
    startedAtMs,
    updatedAt: startedAt,
    completedAt: '',
    completedAtMs: 0,
    revision: 1,
    result: null,
    persistedResult: null,
    isError: false,
    error: '',
    cancellationRequestedAt: '',
    cancellationReason: '',
    persist: persist !== false,
    deliveryAcknowledged: false,
    controller,
    promise: null
  };

  // Durable admission must precede even scheduling the handler microtask.
  // A failed write must not return an accepted operation that disappears on restart.
  persistFallbackRecord(config, record, { required: true });

  record.promise = Promise.resolve()
    .then(() => run(controller.signal, record.operationId))
    .then(async result => {
      const resultTimeline = result?.structuredContent?.timeline || { ...record.timeline, executed: result?.structuredContent?.executed };
      updateFallbackExecutionPhase(record.operationId, 'persisting', config, resultTimeline);
      // Terminal facts must survive failures in post-handler retention.
      record.result = result || null;
      try { await retainFallbackOutput(config, record, result); }
      catch (error) {
        if (result?.structuredContent) {
          result.structuredContent.outputFinalizationError = String(error?.message || error);
          result.structuredContent.outputRetentionFailed = true;
        }
      }
      if (controller.signal.aborted) {
        // Cancellation stays terminal, but the handler may hold the only evidence
        // that a subprocess is still alive or its mutations are unknown.
        const structured = result?.structuredContent || result?.result || {};
        const reason = controller.signal.reason instanceof Error
          ? controller.signal.reason.message : String(controller.signal.reason || 'Work session cancelled by request.');
        record.result = {
          ...result,
          isError: true,
          content: [{ type: 'text', text: reason + (structured.terminationConfirmed === false
            ? ' Process termination was not confirmed; mutations may still be in progress.' : '') }],
          structuredContent: {
            ...structured,
            ok: false,
            status: 'cancelled',
            cancelled: true,
            ...(Object.hasOwn(structured, 'commandSucceeded') ? { commandSucceeded: false } : {}),
            ...(structured.error ? {} : { error: reason }),
            ...(structured.errorCode ? {} : { errorCode: 'CANCELLED' }),
            cancellationReason: reason
          }
        };
        record.isError = true;
        settleCancelledRecord(record, now, controller.signal.reason);
        persistFallbackRecord(config, record);
        deliverFallbackCompletion(config, record);
        return { ok: false, cancelled: true, error: controller.signal.reason, result: record.result };
      }
      settleRecord(record, result?.isError === true ? FALLBACK_EXECUTION_STATUS.FAILED : FALLBACK_EXECUTION_STATUS.COMPLETED, now);
      record.result = result || null;
      record.isError = result?.isError === true;
      persistFallbackRecord(config, record);
      deliverFallbackCompletion(config, record);
      return { ok: true, result: record.result };
    }, error => {
      record.timeline = error?.timeline || { ...record.timeline, executed: error?.executed };
      if (controller.signal.aborted) {
        settleCancelledRecord(record, now, controller.signal.reason || error);
        persistFallbackRecord(config, record);
        deliverFallbackCompletion(config, record);
        return { ok: false, cancelled: true, error: controller.signal.reason || error };
      }
      settleRecord(record, FALLBACK_EXECUTION_STATUS.FAILED, now);
      record.error = error instanceof Error ? error.message : String(error);
      persistFallbackRecord(config, record);
      deliverFallbackCompletion(config, record);
      return { ok: false, error };
    }).finally(() => {
      for (const notify of fallbackResultWaiters.get(record.operationId) || []) notify();
    });

  executionsByOperationId.set(record.operationId, record);
  pruneFallbackExecutions(now);
  return { record, reused: false };
}

function cancelFallbackExecution(workId, options = {}) {
  const id = String(workId || '').trim();
  if (!id) return { cancelled: false, duplicate: false, record: null };
  const now = options.now || Date.now;
  const expectedWorkId = String(options.expectedWorkId || '').trim();
  const reason = options.reason instanceof Error
    ? options.reason
    : new Error(String(options.reason || 'Work session cancelled by request.'));
  recoverExecutionRecords(id, options);
  const records = recordsForReference(id);
  if (records.length > 1) {
    const results = records.map(record => cancelFallbackExecution(record.operationId, options));
    const settlements = results.map(result => result.settlement).filter(Boolean);
    return {
      cancelled: results.some(result => result.cancelled),
      stopping: results.some(result => result.stopping),
      duplicate: results.every(result => result.duplicate),
      mismatch: results.some(result => result.mismatch),
      record: results.at(-1)?.record || null,
      records: results.filter(result => result.stopping).map(result => result.record),
      settlement: settlements.length ? Promise.allSettled(settlements) : null
    };
  }
  let record = records[0] || null;
  if (!record && options.config) {
    const persisted = recoverPersistedFallback(options.config, id, now);
    if (!persisted) return { cancelled: false, duplicate: false, record: null };
    if (expectedWorkId && String(persisted.workId || '') !== expectedWorkId) {
      return { cancelled: false, duplicate: false, mismatch: true, record: null };
    }
    return { cancelled: false, duplicate: persisted.status !== FALLBACK_EXECUTION_STATUS.INTERRUPTED, record: persisted };
  }
  if (expectedWorkId && String(record?.workId || '') !== expectedWorkId) {
    return { cancelled: false, duplicate: false, mismatch: true, record: null };
  }
  if (!record) return { cancelled: false, duplicate: false, record: null };
  if (record.status !== FALLBACK_EXECUTION_STATUS.RUNNING) return { cancelled: false, duplicate: true, record: publicFallbackRecord(record, now) };
  if (record.cancellationRequestedAt) {
    return { cancelled: false, duplicate: true, record: publicFallbackRecord(record, now), settlement: record.promise || null };
  }
  const requestedAt = new Date(timeValue(now)).toISOString();
  record.cancellationRequestedAt = requestedAt;
  record.cancellationReason = reason.message;
  record.phase = 'stopping';
  record.updatedAt = requestedAt;
  record.revision = Math.max(1, Number(record.revision || 1)) + 1;
  if (!record.controller.signal.aborted) record.controller.abort(reason);
  persistFallbackRecord(options.config, record);
  return {
    cancelled: false,
    stopping: true,
    duplicate: false,
    record: publicFallbackRecord(record, now),
    settlement: record.promise || null
  };
}

function enableFallbackCompletionNotice(config, record) {
  if (!record) return;
  record.noticeEnabled = true;
  if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) enqueueFallbackCompletionIntent(config, record);
  else enqueueFallbackCompletionNotice(config, record);
}

function acknowledgeFallbackDelivery(config, reference, delivery = {}) {
  const id = String(reference || '').trim();
  if (!id) return false;
  const record = recordsForReference(id).at(-1) || null;
  if (!record) return false;
  // Delivery of a running acknowledgement confirms acceptance, not receipt of
  // the eventual result. Keep the replay identity until a terminal result arrives.
  if (delivery.kind !== 'result' || delivery.operationId !== record.operationId
    || delivery.status !== record.status || delivery.revision !== record.revision
    || record.status === FALLBACK_EXECUTION_STATUS.RUNNING) return false;
  record.deliveryAcknowledged = true;
  record.phase = 'delivered';
  record.timeline = fallbackTimelinePhase(record.timeline, 'delivered', Date.now());
  persistFallbackRecord(config, record);
  return true;
}

function recordsForReference(reference) {
  const exact = executionsByOperationId.get(reference);
  if (exact) return [exact];
  return [...executionsByOperationId.values()].filter(record => (record.executionKey || record.workId) === reference);
}

function scopeIndexFile(config, executionKey, noticeScope) {
  const key = crypto.createHash('sha256').update(stableJson([executionKey, noticeScope])).digest('hex');
  return path.join(getStateDir(config), 'fallback-scopes', `${key}.json`);
}

function readPersistedScope(config, reference, options = {}) {
  const scope = String(options.noticeScope || '');
  const matching = record => Boolean(record && !record.workId && record.executionKey === reference
    && record.noticeScope === scope && (!options.workspace || canonicalizeFallbackWorkspace(record, config).workspace === options.workspace));
  const fresh = record => record.status === FALLBACK_EXECUTION_STATUS.RUNNING
    || timeValue(options.now || Date.now) - (Date.parse(record.completedAt || record.updatedAt || record.startedAt) || 0) <= FALLBACK_RECORD_TTL_MS;
  let index;
  try {
    index = readJsonFile(scopeIndexFile(config, reference, scope));
  } catch (cause) {
    const error = new Error('The persisted replay index is unreadable. Recover the known operationId before retrying this operation.', { cause });
    error.code = 'FALLBACK_RECOVERY_UNAVAILABLE';
    throw error;
  }
  if (index) {
    if (!fresh(index)) return [];
    const record = readPersistedFallback(config, index.operationId);
    if (!matching(record)) {
      const error = new Error('The replay index has no matching retained operation. Recover the known operationId before retrying.');
      error.code = 'FALLBACK_RECOVERY_UNAVAILABLE';
      error.executed = false;
      throw error;
    }
    return fresh(record) ? [record] : [];
  }
  // Compatibility for pre-index records. Bound synchronous recovery and fail
  // closed if its scan budget is exhausted rather than risk duplicate execution.
  const root = path.join(getStateDir(config), 'fallback-executions');
  let directory;
  try { directory = fs.opendirSync(root); }
  catch (cause) {
    if (cause?.code === 'ENOENT') return [];
    const error = new Error('Retained operation storage is unavailable. Restore it before retrying this operation.', { cause });
    error.code = 'FALLBACK_RECOVERY_UNAVAILABLE';
    error.executed = false;
    throw error;
  }
  const candidates = [];
  let count = 0;
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (++count > 4096) {
        const error = new Error('Legacy replay recovery exceeds its bounded scan. Retrieve the known operationId before retrying.');
        error.code = 'FALLBACK_RECOVERY_UNAVAILABLE';
        throw error;
      }
      if (!entry.isFile() || !/^fallback_[A-Za-z0-9_-]{20,160}\.json$/.test(entry.name)) continue;
      let record;
      try { record = readJsonFile(path.join(root, entry.name)); } catch { continue; }
      if (matching(record) && fresh(record)) candidates.push(record);
    }
  } finally { directory.closeSync(); }
  return candidates.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function recoverExecutionRecords(reference, options = {}) {
  if (!options.config) return;
  const persisted = reference.startsWith('fallback_')
    ? [readPersistedFallback(options.config, reference, options.workId)].filter(Boolean)
    : options.scopeOnly ? readPersistedScope(options.config, reference, options)
      : readTaskBackgroundOperations(options.config, reference);
  for (const record of persisted) {
    if (!record?.operationId) continue;
    canonicalizeFallbackWorkspace(record, options.config);
    if (executionsByOperationId.has(record.operationId)) continue;
    if (options.noticeScope && record.noticeScope !== options.noticeScope) continue;
    if (options.workspace && record.workspace !== options.workspace) continue;
    if (options.workId && record.workId !== options.workId) continue;
    const recovered = recoverPersistedFallback(options.config, record.operationId, options.now || Date.now, record);
    if (recovered) executionsByOperationId.set(recovered.operationId, hydratePersistedRecord(recovered));
  }
}

function canonicalizeFallbackWorkspace(record, config) {
  if (!config || !record) return record;
  try {
    if (!record.workspace && record.workId && record.noticeScope) {
      const task = readSession(getTaskHistoryDir(config), record.workId);
      if (task?.principalFingerprint === record.noticeScope) record.workspace = String(task.workspace || '');
    }
    if (!record.workspace) return record;
    const resolution = resolveWorkspaceInput(config, record.workspace);
    if (resolution.source === 'configured_path') record.workspace = resolution.alias;
  } catch {
    // Ambiguous or unavailable legacy paths remain invisible to alias lookup.
  }
  return record;
}

function fallbackExecutionsStatus(reference, options = {}) {
  const id = String(reference || '').trim();
  if (!id) return [];
  const now = options.now || Date.now;
  pruneFallbackExecutions(now);
  recoverExecutionRecords(id, options);
  return recordsForReference(id)
    .map(record => canonicalizeFallbackWorkspace(record, options.config))
    .filter(record => !options.noticeScope || record.noticeScope === options.noticeScope)
    .filter(record => !options.workspace || record.workspace === options.workspace)
    .filter(record => !options.workId || record.workId === options.workId)
    .map(record => publicFallbackRecord(record, now));
}


// Deliberately omit retained results from list/status receipts. Detailed retrieval
// remains a read of the exact same durable operation, never execution.
function fallbackOperationReceipt(operation) {
  if (!operation) return null;
  const { result, ...receipt } = operation;
  const fields = ['ok', 'executed', 'commandSucceeded', 'exitCode', 'errorCode', 'validationStatus',
    'timedOut', 'cancelled', 'rootExitConfirmed', 'terminationConfirmed', 'mutationUnknown', 'cleanupPending', 'outputFinalizationTimedOut', 'outputFinalizationError', 'mutationOwnershipPersistenceError',
    'stdoutOutputRef', 'stderrOutputRef', 'stdoutBytes', 'stderrBytes', 'stdoutTruncated',
    'stderrTruncated', 'stdoutSpillTruncated', 'stderrSpillTruncated'];
  return { ...receipt, resultAvailable: result != null || operation.resultAvailable === true,
    ...(result ? { resultSummary: Object.fromEntries(fields.filter(key => result[key] !== undefined).map(key => [key, result[key]])),
      resultTruncated: operation.resultTruncated === true || result.truncated === true || result.resultDetailsCompacted === true } : {}) };
}
function fallbackOperationCursor(operation) {
  return Buffer.from(JSON.stringify([operation.startedAt, operation.operationId])).toString('base64url');
}
function fallbackExecutionsPage(reference, options = {}) {
  let cursor = null;
  if (options.cursor) {
    try { cursor = JSON.parse(Buffer.from(String(options.cursor), 'base64url').toString('utf8')); } catch {}
    if (!Array.isArray(cursor) || cursor.length !== 2 || !cursor.every(value => typeof value === 'string')) {
      const error = new Error('Invalid operationCursor. Start a new status page without a cursor.');
      error.code = 'INVALID_OPERATION_CURSOR'; throw error;
    }
  }
  const records = fallbackExecutionsStatus(reference, options)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.operationId.localeCompare(b.operationId))
    .filter(record => !cursor || record.startedAt < cursor[0] || (record.startedAt === cursor[0] && record.operationId > cursor[1]));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(options.limit) || 10)));
  const operations = records.slice(0, limit).map(record => ({ ...fallbackOperationReceipt(record), cursor: fallbackOperationCursor(record) }));
  return { operations, cursor: operations.at(-1)?.cursor || null, hasMore: records.length > operations.length };
}

function updateFallbackExecutionPhase(operationId, phase, config, timeline = null) {
  const record = executionsByOperationId.get(String(operationId || ''));
  if (!record || record.status !== FALLBACK_EXECUTION_STATUS.RUNNING || (record.phase === phase && !timeline)) return;
  if (timeline && typeof timeline === 'object') record.timeline = timeline;
  record.timeline = fallbackTimelinePhase(record.timeline, phase, Date.now());
  record.phase = phase;
  record.updatedAt = new Date().toISOString();
  record.revision += 1;
  persistFallbackRecord(config, record);
}

function assertFallbackCompletionAvailable(workId, options = {}) {
  const pending = fallbackExecutionsStatus(workId, options).filter(record =>
    record.status === FALLBACK_EXECUTION_STATUS.RUNNING && record.operationId !== options.excludeOperationId);
  if (!pending.length) return;
  const error = new Error('Cannot complete this task while background operations are still queued or running.');
  error.code = 'TASK_COMPLETION_IN_PROGRESS';
  error.retryable = true;
  throw error;
}

function fallbackExecutionStatus(reference, options = {}) {
  const records = fallbackExecutionsStatus(reference, options);
  return records.findLast(record => record.status === FALLBACK_EXECUTION_STATUS.RUNNING) || records.at(-1) || null;
}

async function waitForFallbackExecution(reference, options = {}) {
  options.signal?.throwIfAborted();
  const operation = fallbackExecutionStatus(reference, options);
  const record = operation && executionsByOperationId.get(operation.operationId);
  const requestedWaitMs = Number(options.waitMs ?? MAX_FALLBACK_RESULT_WAIT_MS);
  const deadlineWaitMs = Number(options.deadlineAtMs) > 0
    ? Math.max(0, Number(options.deadlineAtMs) - Date.now()) : MAX_FALLBACK_RESULT_WAIT_MS;
  const waitMs = Math.min(MAX_FALLBACK_RESULT_WAIT_MS, deadlineWaitMs, Math.max(0, requestedWaitMs || 0));
  const waiterCount = [...fallbackResultWaiters.values()].reduce((count, listeners) => count + listeners.size, 0);
  // Wait only on this process's existing execution, after the same scope checks
  // as an immediate lookup. Never start/recover work to satisfy a result wait.
  if (!record?.promise || operation.status !== FALLBACK_EXECUTION_STATUS.RUNNING
    || waitMs <= 0 || waiterCount >= MAX_CONCURRENT_RESULT_WAITS) return operation;
  await new Promise((resolve, reject) => {
    const listeners = fallbackResultWaiters.get(record.operationId) || new Set();
    fallbackResultWaiters.set(record.operationId, listeners);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      listeners.delete(onSettled);
      if (!listeners.size) fallbackResultWaiters.delete(record.operationId);
    };
    const onSettled = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(options.signal.reason); };
    const timer = setTimeout(onSettled, waitMs);
    listeners.add(onSettled);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  options.signal?.throwIfAborted();
  return fallbackExecutionStatus(reference, options);
}

function publicFallbackRecord(record, now = Date.now) {
  if (!record) return null;
  const structured = record.result?.structuredContent || record.persistedResult || record.result?.result || null;
  const running = record.status === FALLBACK_EXECUTION_STATUS.RUNNING;
  const currentMs = timeValue(now);
  const startedAtMs = Number(record.startedAtMs || Date.parse(record.startedAt) || currentMs);
  const completedAtMs = Number(record.completedAtMs || Date.parse(record.completedAt) || 0);
  const elapsedEndMs = running || completedAtMs <= 0 ? currentMs : completedAtMs;
  const deadlineAtMs = Number(record.deadlineAtMs || 0);
  return {
    operationId: record.operationId,
    ...(record.workId ? { work_id: record.workId } : {}),
    tool: record.tool,
    workspace: record.workspace,
    status: record.status,
    ...(record.durability ? { durability: record.durability } : {}),
    ...(record.persistenceError ? { persistenceError: record.persistenceError } : {}),
    ...(record.noticePersistenceError ? { noticePersistenceError: record.noticePersistenceError } : {}),
    ...(record.phase ? { phase: record.phase } : {}),
    ...(record.timeline ? { timeline: record.timeline } : {}),
    ...(record.resultRetention ? { resultRetention: record.resultRetention } : {}),
    ...(record.persistedResultCompacted ? { persistedResultCompacted: true } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt || record.startedAt,
    revision: Math.max(1, Number(record.revision || 1)),
    elapsedMs: Math.max(0, elapsedEndMs - startedAtMs),
    ...(structured ? { resultSource: record.result ? 'live' : 'retained' } : {}),
    ...(record.persistedResultCompacted && !record.result ? { resultTruncated: true, nextAction: 'Only a compacted retained result remains. Read available output references or inspect artifacts read-only. A larger response budget cannot restore omitted data; do not rerun the mutation.' } : {}),
    ...(deadlineAtMs > 0 ? {
      deadlineAt: new Date(deadlineAtMs).toISOString(),
      remainingMs: Math.max(0, deadlineAtMs - currentMs)
    } : {}),
    ...(running ? { pollAfterMs: fallbackPollAfterMs(record, now) } : {}),
    ...(record.cancellationRequestedAt ? { cancellationRequestedAt: record.cancellationRequestedAt, stopping: true } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(structured && typeof structured === 'object' ? { result: structured } : {}),
    ...((record.result?.isError === true || record.isError === true) ? { isError: true } : {})
  };
}

function fallbackPollAfterMs(record, now = Date.now) {
  const current = timeValue(now);
  const started = Number(record.startedAtMs || Date.parse(record.startedAt) || current);
  const elapsed = Math.max(0, current - started);
  if (record.cancellationRequestedAt || ['stopping', 'exited', 'draining-output', 'drained', 'reconciling', 'persisting'].includes(record.phase)) return 1_000;
  if (elapsed < 10_000) return 1_000;
  if (elapsed < 30_000) return 5_000;
  if (elapsed < 60_000) return 10_000;
  if (elapsed < 2 * 60_000) return 30_000;
  if (elapsed < 5 * 60_000) return 60_000;
  return 120_000;
}

function peekFallbackCompletionNotices(config, options = {}) {
  const noticeScope = String(options.noticeScope || '').trim();
  const workspace = String(options.workspace || '').trim();
  if (!config || !noticeScope || !workspace) return [];
  const file = completionNoticeFile(config, noticeScope, workspace);
  const stored = readCompletionNoticeFile(file);
  const now = options.now || Date.now;
  const retained = [];
  const ready = [];
  let changed = false;

  for (const notice of stored) {
    if (notice.pending === true) {
      const operationId = String(notice.operationId || '').trim();
      const workId = String(notice.work_id || '').trim();
      const live = executionsByOperationId.get(operationId) || null;
      if (live?.status === FALLBACK_EXECUTION_STATUS.RUNNING) {
        retained.push(notice);
        continue;
      }
      const persisted = live || recoverPersistedFallback(config, operationId, now, readPersistedFallback(config, operationId, workId));
      if (persisted) {
        const terminal = fallbackCompletionNotice(hydratePersistedRecord(persisted));
        retained.push(terminal);
        ready.push(terminal);
        changed = true;
        continue;
      }
      if (completionNoticeFresh(notice, now)) retained.push(notice);
      else changed = true;
      continue;
    }
    if (!completionNoticeFresh(notice, now)) {
      changed = true;
      continue;
    }
    retained.push(notice);
    ready.push(notice);
  }

  if (changed) {
    if (retained.length) writeCompletionNoticeFile(file, retained);
    else {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
  const limit = Math.min(MAX_COMPLETION_NOTICES, Math.max(1, Number(options.limit || MAX_COMPLETION_NOTICES)));
  return ready.slice(0, limit);
}

function registerFallbackCompletionDelivery(config, notices, options = {}) {
  const noticeScope = String(options.noticeScope || '').trim();
  const workspace = String(options.workspace || '').trim();
  const requestId = options.requestId;
  if (!config || !noticeScope || !workspace || requestId === undefined || requestId === null || !Array.isArray(notices) || !notices.length) return false;
  prunePendingCompletionDeliveries();
  const operationIds = [...new Set(notices.map(notice => String(notice?.operationId || '').trim()).filter(Boolean))];
  if (!operationIds.length) return false;
  const key = completionDeliveryKey(noticeScope, requestId);
  const previous = pendingCompletionDeliveries.get(key);
  // JSON-RPC ids are scoped to a transport, not a principal. Without a unique
  // delivery token, overlapping registrations must not consume either payload.
  const ambiguous = Boolean(previous && (previous.ambiguous
    || previous.config !== config || previous.workspace !== workspace
    || stableJson(previous.operationIds) !== stableJson(operationIds)));
  pendingCompletionDeliveries.set(key, {
    ambiguous,
    config,
    noticeScope,
    workspace,
    operationIds,
    expiresAt: Date.now() + FALLBACK_RECORD_TTL_MS
  });
  return true;
}

function acknowledgeFallbackCompletionDelivery(noticeScope, requestId) {
  const scope = String(noticeScope || '').trim();
  if (!scope || requestId === undefined || requestId === null) return false;
  prunePendingCompletionDeliveries();
  const key = completionDeliveryKey(scope, requestId);
  const pending = pendingCompletionDeliveries.get(key);
  if (!pending || pending.ambiguous) return false;
  pendingCompletionDeliveries.delete(key);
  let acknowledged = false;
  for (const operationId of pending.operationIds) {
    const consumed = acknowledgeFallbackCompletionNotice(pending.config, operationId, {
      noticeScope: pending.noticeScope,
      workspace: pending.workspace
    });
    acknowledged = consumed || acknowledged;
  }
  return acknowledged;
}

function completionDeliveryKey(noticeScope, requestId) {
  return `${noticeScope}\0${typeof requestId}:${String(requestId)}`;
}

function prunePendingCompletionDeliveries(now = Date.now()) {
  for (const [key, pending] of pendingCompletionDeliveries) {
    if (Number(pending.expiresAt || 0) <= now) pendingCompletionDeliveries.delete(key);
  }
}

function acknowledgeFallbackCompletionNotice(config, reference, options = {}) {
  const noticeScope = String(options.noticeScope || '').trim();
  const workspace = String(options.workspace || '').trim();
  const id = String(reference || '').trim();
  if (!config || !noticeScope || !workspace || !id) return false;
  const file = completionNoticeFile(config, noticeScope, workspace);
  const notices = readCompletionNoticeFile(file);
  const remaining = notices.filter(notice => notice.operationId !== id && notice.work_id !== id);
  if (remaining.length === notices.length) return false;
  if (remaining.length) writeCompletionNoticeFile(file, remaining);
  else {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return true;
}

function deliverFallbackCompletion(config, record) {
  if (!config || !record || record.status === FALLBACK_EXECUTION_STATUS.RUNNING) return;

  const noticeScope = String(record.noticeScope || '').trim();
  const workspace = String(record.workspace || '').trim();
  const status = String(record.status || '');
  const name = status === FALLBACK_EXECUTION_STATUS.COMPLETED
    ? 'operation.completed'
    : status === FALLBACK_EXECUTION_STATUS.CANCELLED
      ? 'operation.cancelled'
      : 'operation.failed';
  if (!noticeScope || !record.operationId) {
    if (record.noticeEnabled) enqueueFallbackCompletionNotice(config, record);
    return;
  }
  void Promise.resolve().then(() => publishMcpEvent(config, {
    principalFingerprint: noticeScope,
    name,
    data: {
      workspace,
      work_id: String(record.workId || ''),
      operation_id: String(record.operationId || ''),
      tool: String(record.tool || ''),
      status,
      error: String(record.error || '').slice(0, 500)
    }
  })).then(delivered => {
    if (!record.noticeEnabled) return;
    if (delivered) acknowledgeFallbackCompletionNotice(config, record.operationId, { noticeScope, workspace });
    else enqueueFallbackCompletionNotice(config, record);
  }).catch(error => {
    if (record.noticeEnabled) enqueueFallbackCompletionNotice(config, record);
    if (process.env.REL_AI_MCP_DEBUG) {
      console.error('[rel-ai-mcp] fallback MCP Event delivery:', error instanceof Error ? error.message : String(error));
    }
  });
}

function enqueueFallbackCompletionIntent(config, record) {
  if (!config || !record || record.status !== FALLBACK_EXECUTION_STATUS.RUNNING) return;
  const noticeScope = String(record.noticeScope || '').trim();
  const workspace = String(record.workspace || '').trim();
  if (!noticeScope || !workspace || !record.operationId) return;
  persistFallbackNotice(config, record, noticeScope, workspace, fallbackCompletionIntent(record));
}

function enqueueFallbackCompletionNotice(config, record) {
  if (!config || !record || record.status === FALLBACK_EXECUTION_STATUS.RUNNING) return;
  const noticeScope = String(record.noticeScope || '').trim();
  const workspace = String(record.workspace || '').trim();
  if (!noticeScope || !workspace || !record.operationId) return;
  persistFallbackNotice(config, record, noticeScope, workspace, fallbackCompletionNotice(record));
}

function persistFallbackNotice(config, record, noticeScope, workspace, notice) {
  try {
    upsertFallbackCompletionRecord(config, noticeScope, workspace, notice);
    record.noticePersistenceError = '';
  } catch (error) {
    record.noticePersistenceError = String(error?.message || error);
    // Notice storage is independent of the execution/result. Preserve the
    // existing operation and never turn a notification failure into a rerun.
    console.error('[rel-ai-mcp] Completion notice could not be persisted:', record.operationId);
  }
}

function upsertFallbackCompletionRecord(config, noticeScope, workspace, notice) {
  const file = completionNoticeFile(config, noticeScope, workspace);
  const existing = readCompletionNoticeFile(file)
    .filter(item => completionNoticeFresh(item));
  const notices = [...existing.filter(item => item.operationId !== notice.operationId), notice]
    .sort((left, right) => completionNoticeTime(left) - completionNoticeTime(right))
    .slice(-MAX_COMPLETION_NOTICES);
  writeCompletionNoticeFile(file, notices);
}

function fallbackCompletionIntent(record) {
  return Object.fromEntries(Object.entries({
    operationId: record.operationId,
    work_id: record.workId || undefined,
    tool: record.tool,
    workspace: record.workspace,
    status: FALLBACK_EXECUTION_STATUS.RUNNING,
    startedAt: record.startedAt,
    revision: Math.max(1, Number(record.revision || 1)),
    pending: true
  }).filter(([, value]) => value !== undefined && value !== ''));
}

function fallbackCompletionNotice(record) {
  const result = record.result?.structuredContent || record.persistedResult || {};
  const hasExitCode = result?.exitCode !== undefined && result?.exitCode !== null && result?.exitCode !== '';
  const exitCode = hasExitCode && Number.isFinite(Number(result.exitCode)) ? Number(result.exitCode) : undefined;
  const validationStatus = typeof result?.validationStatus === 'string' ? result.validationStatus : undefined;
  const status = String(record.status || 'completed');
  const summary = validationStatus
    ? `${record.tool || 'Background operation'} ${status}: validation ${validationStatus}.`
    : exitCode !== undefined
      ? `${record.tool || 'Background operation'} ${status} with exit code ${exitCode}.`
      : `${record.tool || 'Background operation'} ${status}.`;
  return Object.fromEntries(Object.entries({
    operationId: record.operationId,
    work_id: record.workId || undefined,
    tool: record.tool,
    workspace: record.workspace,
    status,
    completedAt: record.completedAt || record.updatedAt,
    revision: Math.max(1, Number(record.revision || 1)),
    exitCode,
    commandSucceeded: typeof result?.commandSucceeded === 'boolean' ? result.commandSucceeded : undefined,
    validationStatus,
    failedCheck: typeof result?.failedCheck === 'string' ? result.failedCheck : undefined,
    durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : undefined,
    summary
  }).filter(([, value]) => value !== undefined && value !== ''));
}

function completionNoticeFile(config, noticeScope, workspace) {
  const key = crypto.createHash('sha256').update(`${noticeScope}\u0000${workspace}`).digest('base64url');
  return path.join(getStateDir(config), 'fallback-completions', `${key}.json`);
}

function readCompletionNoticeFile(file) {
  try {
    const value = readJsonFile(file, {
      validate: candidate => Boolean(candidate && typeof candidate === 'object' && Array.isArray(candidate.notices))
    });
    return Array.isArray(value?.notices) ? value.notices.filter(item => item && typeof item === 'object') : [];
  } catch {
    return [];
  }
}

function writeCompletionNoticeFile(file, notices) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, { version: 1, notices }, { mode: 0o600 });
}

function completionNoticeTime(notice) {
  return Date.parse(String(notice?.completedAt || notice?.startedAt || '')) || 0;
}

function completionNoticeFresh(notice, now = Date.now) {
  const timestamp = completionNoticeTime(notice);
  return timestamp > 0 && timeValue(now) - timestamp <= FALLBACK_RECORD_TTL_MS;
}

function recoverPersistedFallback(config, reference, now = Date.now, previous = null) {
  const persisted = previous || readPersistedFallback(config, reference);
  if (!persisted) return null;
  if (persisted.status !== FALLBACK_EXECUTION_STATUS.RUNNING) return persisted;
  const timestamp = timeValue(now);
  const interrupted = {
    ...persisted,
    status: FALLBACK_EXECUTION_STATUS.INTERRUPTED,
    phase: '',
    updatedAt: new Date(timestamp).toISOString(),
    completedAt: new Date(timestamp).toISOString(),
    revision: Math.max(1, Number(persisted.revision || 1)) + 1,
    error: 'Background operation was interrupted because the Rel.AI runtime restarted.'
  };
  try { persistFallbackSnapshot(config, interrupted); }
  catch (error) {
    // Recovery is a read of existing evidence. A write failure cannot erase or
    // hide the interrupted result, including older retained identifier formats.
    interrupted.durability = 'memory_only';
    interrupted.persistenceError = String(error?.message || error);
  }
  return interrupted;
}

function hydratePersistedRecord(record) {
  return {
    operationId: String(record.operationId || ''),
    executionKey: String(record.executionKey || record.workId || record.operationId || ''),
    workId: String(record.workId || ''),
    tool: String(record.tool || ''),
    workspace: String(record.workspace || ''),
    noticeScope: String(record.noticeScope || ''),
    signature: String(record.signature || ''),
    status: String(record.status || ''),
    phase: String(record.phase || ''),
    timeline: record.timeline || null,
    deadlineAtMs: Number(record.deadlineAtMs || 0),
    startedAt: String(record.startedAt || ''),
    startedAtMs: Date.parse(record.startedAt) || 0,
    updatedAt: String(record.updatedAt || record.startedAt || ''),
    completedAt: String(record.completedAt || ''),
    completedAtMs: Date.parse(record.completedAt) || 0,
    revision: Math.max(1, Number(record.revision || 1)),
    result: null,
    persistedResultCompacted: record.persistedResultCompacted === true,
    resultRetention: record.resultRetention || null,
    persistedResult: record.result && typeof record.result === 'object' ? record.result : null,
    isError: record.isError === true,
    error: String(record.error || ''),
    cancellationRequestedAt: String(record.cancellationRequestedAt || ''),
    cancellationReason: String(record.cancellationReason || ''),
    deliveryAcknowledged: record.deliveryAcknowledged === true,
    controller: null,
    promise: null
  };
}

function persistentFallbackRecord(record) {
  const structured = record.result?.structuredContent || record.persistedResult || null;
  return {
    operationId: record.operationId,
    executionKey: record.executionKey || record.workId || record.operationId,
    workId: record.workId,
    tool: record.tool,
    workspace: record.workspace,
    noticeScope: record.noticeScope,
    signature: record.signature,
    status: record.status,
    ...(record.phase ? { phase: record.phase } : {}),
    ...(record.timeline ? { timeline: record.timeline } : {}),
    ...(record.resultRetention ? { resultRetention: record.resultRetention } : {}),
    ...(record.persistedResultCompacted ? { persistedResultCompacted: true } : {}),
    ...(Number(record.deadlineAtMs) > 0 ? { deadlineAtMs: Math.floor(Number(record.deadlineAtMs)) } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt || record.startedAt,
    revision: Math.max(1, Number(record.revision || 1)),
    ...(record.deliveryAcknowledged === true ? { deliveryAcknowledged: true } : {}),
    ...(record.cancellationRequestedAt ? { cancellationRequestedAt: record.cancellationRequestedAt } : {}),
    ...(record.cancellationReason ? { cancellationReason: record.cancellationReason } : {}),
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(structured && typeof structured === 'object' ? { result: structured } : {}),
    ...((record.result?.isError === true || record.isError === true) ? { isError: true } : {})
  };
}

function readPersistedFallback(config, reference, workId = '') {
  const id = String(reference || '').trim();
  try {
    if (id.startsWith('fallback_')) {
      let stored = null;
      try {
        stored = readJsonFile(tasklessFallbackFile(config, id), {
          validate: value => Boolean(value && typeof value === 'object' && value.operationId === id)
        });
      } catch {}
      const taskId = stored?.workId || workId;
      return taskId ? readTaskBackgroundOperations(config, taskId).find(record => record.operationId === id) || (stored?.status ? stored : null) : stored;
    }
    return readTaskBackgroundOperation(config, id);
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] fallback operation read:', error);
    return null;
  }
}

function persistFallbackRecord(config, record, options = {}) {
  if (!config || !record || record.persist === false) return;
  try {
    const persisted = persistFallbackSnapshot(config, persistentFallbackRecord(record));
    record.persistenceError = '';
    record.durability = 'persisted';
    record.persistedResultCompacted = persisted.persistedResultCompacted === true;
    record.resultRetention = persisted.resultRetention || null;
  } catch (cause) {
    record.persistenceError = String(cause?.message || cause);
    record.durability = 'memory_only';
    if (options.required === true) {
      const error = new Error('Background operation was not started because its acceptance record could not be persisted.', { cause });
      error.code = 'FALLBACK_PERSISTENCE_FAILED';
      error.executed = false;
      throw error;
    }
    // Execution may already have happened. Preserve its result and replay key.
    if (record.result?.structuredContent) {
      record.result = { ...record.result, structuredContent: {
        ...record.result.structuredContent,
        operationPersistence: { durable: false, errorCode: 'FALLBACK_PERSISTENCE_FAILED',
          nextAction: 'Keep this result. Do not repeat the operation to repair persistence; reconcile this operationId.' }
      } };
    }
    console.error('[rel-ai-mcp] Background result retained only in memory:', record.operationId);
  }
}

async function retainFallbackOutput(config, record, result) {
  if (!config || record.persist === false || (record.workId && !readTaskBackgroundOperation(config, record.workId))) return;
  const owner = record.workId || (record.workspace && record.noticeScope ? `workspace:${record.workspace}:principal:${record.noticeScope}` : '');
  if (!owner) return;
  await retainOutputStreams(config, owner, result?.structuredContent);
}

function persistFallbackSnapshot(config, record) {
  const projected = sanitizeTaskRecord({ status: 'planning', backgroundOperation: record })?.backgroundOperation || {};
  const originalResult = JSON.stringify(record.result);
  const retainedResult = JSON.stringify(projected.result);
  if (originalResult !== retainedResult) {
    projected.persistedResultCompacted = true;
    projected.resultRetention = { complete: false, compacted: true, originalBytes: Buffer.byteLength(originalResult || '', 'utf8'), retainedBytes: Buffer.byteLength(retainedResult || '', 'utf8'), reason: 'Durable history retains a sanitized bounded projection. Omitted fields cannot be restored by increasing the response budget.' };
  }
  record = projected;
  let taskAuthoritative = false;
  if (record.workId) {
    const stored = recordTaskBackgroundOperation(config, record.workId, record);
    if (stored) {
      // A pending worker write is not a durable commit. Verify the canonical
      // row, bypassing the optimistic in-memory task-history projection.
      const session = readSession(getTaskHistoryDir(config), record.workId);
      const operations = session?.backgroundOperations || (session?.backgroundOperation ? [session.backgroundOperation] : []);
      taskAuthoritative = operations.some(value => value.operationId === record.operationId
        && value.revision === record.revision && value.status === record.status
        && value.deliveryAcknowledged === record.deliveryAcknowledged);
      if (!taskAuthoritative) throw new Error('Task background operation has not reached durable history.');
    }
  }
  const file = tasklessFallbackFile(config, record.operationId);
  // Existing tasks are authoritative. Records without a task (including
  // internal one-shot clients) retain their own snapshot instead of a dead pointer.
  const sanitized = taskAuthoritative ? { operationId: record.operationId, workId: record.workId } : record;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeJsonAtomic(file, sanitized, { mode: 0o600 });
  if (!record.workId) {
    const index = scopeIndexFile(config, record.executionKey, record.noticeScope);
    writeJsonAtomic(index, { operationId: record.operationId, executionKey: record.executionKey,
      noticeScope: record.noticeScope, workspace: record.workspace, status: record.status,
      completedAt: record.completedAt || '', updatedAt: record.updatedAt }, { mode: 0o600 });
  }
  scheduleTasklessFallbackPrune(config);
  return record;
}

function tasklessFallbackFile(config, operationId) {
  const id = String(operationId || '').trim();
  if (!/^fallback_[A-Za-z0-9_-]{20,160}$/.test(id)) throw new Error('Invalid fallback operationId.');
  return path.join(getStateDir(config), 'fallback-executions', `${id}.json`);
}

function scheduleTasklessFallbackPrune(config) {
  const root = path.join(getStateDir(config), 'fallback-executions');
  const previous = fallbackPrunes.get(root);
  if (previous?.pending || Date.now() - Number(previous?.startedAt || 0) < FALLBACK_PRUNE_INTERVAL_MS) return;
  const state = { pending: true, startedAt: Date.now(), promise: null };
  fallbackPrunes.set(root, state);
  state.promise = Promise.all([pruneTasklessFallbackFiles(root, config), pruneFallbackScopeFiles(config)])
    .catch(error => {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] fallback cleanup:', error);
    })
    .finally(() => { state.pending = false; });
}

async function pruneFallbackScopeFiles(config) {
  const root = path.join(getStateDir(config), 'fallback-scopes');
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  const removable = [];
  const cutoff = Date.now() - FALLBACK_RECORD_TTL_MS;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    try {
      const source = await fs.promises.readFile(file, 'utf8');
      const record = JSON.parse(source);
      if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) continue;
      const at = Date.parse(record.completedAt || record.updatedAt || '') || 0;
      removable.push({ file, source, at });
    } catch {}
  }
  removable.sort((a, b) => b.at - a.at);
  for (const [index, entry] of removable.entries()) {
    if (entry.at >= cutoff && index < MAX_FALLBACK_RECORDS) continue;
    try {
      if (await fs.promises.readFile(entry.file, 'utf8') === entry.source) await fs.promises.unlink(entry.file);
    } catch {}
  }
}

async function pruneTasklessFallbackFiles(root, config) {
  let entries;
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - FALLBACK_RECORD_TTL_MS;
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^fallback_[A-Za-z0-9_-]{20,160}\.json$/.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile()) continue;
      // Work-bound files are lookup pointers. Reading their authoritative task
      // here repeatedly hydrates large histories and blocks all tunnel clients.
      const record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      if (record?.operationId !== path.basename(file, '.json')) continue;
      if (record.workId && !record.status) {
        if (stat.mtimeMs >= cutoff) continue;
        // Read only the indexed payload's operation ids, never hydrate histories.
        // Any database error preserves the pointer for a later pass.
        const retained = withStateDatabase(config, db => db.prepare(`
          SELECT 1 FROM task_history WHERE id=? AND (
            CASE WHEN json_valid(payload) THEN
              json_extract(payload, '$.backgroundOperation.operationId') = ?
              OR EXISTS (SELECT 1 FROM json_each(payload, '$.backgroundOperations') WHERE json_extract(value, '$.operationId') = ?)
            ELSE 1 END)`).get(record.workId, record.operationId, record.operationId), { readonly: true });
        if (retained) continue;
      }
      if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) continue;
      files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [index, entry] of files.entries()) {
    if (entry.mtimeMs >= cutoff && index < MAX_FALLBACK_RECORDS) continue;
    try {
      const current = await fs.promises.lstat(entry.file);
      // A concurrent request may have replaced this record during cleanup.
      if (current.mtimeMs !== entry.mtimeMs || current.size !== entry.size || !current.isFile()) continue;
      await fs.promises.unlink(entry.file);
    } catch {}
  }
}

function fallbackTimelinePhase(timeline, phase, atMs) {
  const at = new Date(atMs).toISOString();
  if (timeline?.phase === phase) return { ...timeline, lastProgressAt: at };
  const phases = (timeline?.phases || []).map(item => ({ ...item }));
  const previous = phases.at(-1);
  if (previous && !previous.endedAt) {
    previous.endedAt = at;
    previous.durationMs = Math.max(0, atMs - (Date.parse(previous.startedAt) || atMs));
  }
  phases.push({ phase, startedAt: at });
  return { ...timeline, phase, phaseStartedAt: at, lastProgressAt: at, phases: phases.slice(-32) };
}

function settleRecord(record, status, now = Date.now) {
  const completedAtMs = timeValue(now);
  record.status = status;
  record.phase = 'result-ready';
  record.timeline = fallbackTimelinePhase(record.timeline, 'result-ready', completedAtMs);
  record.completedAtMs = completedAtMs;
  record.completedAt = new Date(completedAtMs).toISOString();
  record.updatedAt = record.completedAt;
  record.revision = Math.max(1, Number(record.revision || 1)) + 1;
}

function settleCancelledRecord(record, now = Date.now, reason = null) {
  if (record.status !== FALLBACK_EXECUTION_STATUS.CANCELLED) settleRecord(record, FALLBACK_EXECUTION_STATUS.CANCELLED, now);
  record.error = reason instanceof Error ? reason.message : String(reason || record.error || 'Work session cancelled by request.');
}

function pruneFallbackExecutions(now = Date.now) {
  const current = timeValue(now);
  for (const record of executionsByOperationId.values()) {
    if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) continue;
    const completed = Number(record.completedAtMs || record.startedAtMs || current);
    if (current - completed > FALLBACK_RECORD_TTL_MS) removeFallbackExecutionRecord(record);
  }
  if (executionsByOperationId.size <= MAX_FALLBACK_RECORDS) return;
  const removable = [...executionsByOperationId.values()]
    .filter(record => record.status !== FALLBACK_EXECUTION_STATUS.RUNNING)
    .sort((left, right) => Number(left.completedAtMs || left.startedAtMs) - Number(right.completedAtMs || right.startedAtMs));
  while (executionsByOperationId.size > MAX_FALLBACK_RECORDS && removable.length) {
    removeFallbackExecutionRecord(removable.shift());
  }
}

function removeFallbackExecutionRecord(record) {
  if (!record) return;
  if (record.operationId) executionsByOperationId.delete(record.operationId);
}

function timeValue(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function fallbackSignature(tool, args = {}) {
  return crypto.createHash('sha256').update(stableJson([String(tool || ''), args])).digest('base64url');
}

function resetFallbackExecutions() {
  for (const listeners of fallbackResultWaiters.values()) {
    for (const notify of [...listeners]) notify();
  }
  executionsByOperationId.clear();
  pendingCompletionDeliveries.clear();
}

export {
  DEFAULT_FALLBACK_GRACE_MS,
  acknowledgeFallbackCompletionDelivery,
  acknowledgeFallbackCompletionNotice,
  acknowledgeFallbackDelivery,
  activeFallbackWorkIds,
  cancelFallbackExecution,
  peekFallbackCompletionNotices,
  registerFallbackCompletionDelivery,
  enableFallbackCompletionNotice,
  fallbackExecutionStatus,
  waitForFallbackExecution,
  fallbackExecutionsStatus,
  fallbackExecutionsPage,
  fallbackOperationReceipt,
  updateFallbackExecutionPhase,
  assertFallbackCompletionAvailable,
  fallbackSignature,
  resetFallbackExecutions,
  startFallbackExecution
};
