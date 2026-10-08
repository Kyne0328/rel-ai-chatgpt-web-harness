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
const fallbackPersistenceRetries = new Map();
const FALLBACK_PERSISTENCE_RETRY_DELAYS_MS = [25, 100, 500, 2000, 5000];
const legacyScopeRecoveries = new Map();
const LEGACY_SYNC_ENTRIES = 256;
const LEGACY_SYNC_BYTES = 512 * 1024;
const LEGACY_SYNC_MS = 20;
const LEGACY_RECOVERY_MAX_ENTRIES = 200_000;
const LEGACY_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;
const LEGACY_RECOVERY_FILE_BYTES = 1024 * 1024;

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

  const protectedCount = [...executionsByOperationId.values()].filter(record =>
    record.status === FALLBACK_EXECUTION_STATUS.RUNNING || record.durability === 'memory_only').length;
  if (protectedCount >= MAX_FALLBACK_RECORDS) {
    throw Object.assign(new Error('Background receipt capacity is occupied by live or unpersisted operations. Retrieve existing results before starting more work.'),
      { code: 'FALLBACK_RECOVERY_CAPACITY', executed: false, retryable: true });
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
    stateRoot: config ? getStateDir(config) : '',
    deliveryAcknowledged: false,
    controller,
    promise: null
  };

  // Durable admission must precede even scheduling the handler microtask.
  // A failed write must not return an accepted operation that disappears on restart.
  persistFallbackRecord(config, record, { required: true });

  record.promise = Promise.resolve()
    .then(() => {
      // Shutdown or cancellation can arrive after durable admission but
      // before the handler microtask starts. Never start that handler then.
      if (controller.signal.aborted && record.shutdownInterrupted === true) throw controller.signal.reason || new Error('Operation interrupted before execution.');
      return run(controller.signal, record.operationId);
    })
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
        const serviceShutdown = controller.signal.reason?.code === 'SERVICE_SHUTDOWN';
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
            status: serviceShutdown ? 'interrupted' : 'cancelled',
            ...(serviceShutdown ? { shutdownInterrupted: true, retryable: false } : { cancelled: true }),
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
        return { ok: false, ...(serviceShutdown ? { interrupted: true } : { cancelled: true }),
          error: controller.signal.reason, result: record.result };
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
        return { ok: false, ...(controller.signal.reason?.code === 'SERVICE_SHUTDOWN'
          ? { interrupted: true } : { cancelled: true }), error: controller.signal.reason || error };
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

function legacyRecoveryError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'FALLBACK_RECOVERY_UNAVAILABLE', executed: false, retryable: true
  });
}

function legacyDirectoryStamp(root) {
  try {
    const stat = fs.statSync(root);
    if (!stat.isDirectory()) throw new Error('Operation storage is not a directory.');
    return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw legacyRecoveryError('Retained operation storage is unavailable. Restore it before retrying.', cause);
  }
}

// A missing pre-index scope is not evidence of absence. An overflowing
// synchronous probe continues in small asynchronous slices; retries use its
// progress instead of traversing the first entries again on every request.
function beginLegacyScopeRecovery(root, stamp) {
  const state = { stamp, status: 'running', candidates: [], error: null, generation: 0 };
  legacyScopeRecoveries.set(root, state);
  void (async () => {
    let entries = 0;
    let bytes = 0;
    let sliceStart = Date.now();
    try {
      const directory = await fs.promises.opendir(root);
      for await (const entry of directory) {
        if (legacyScopeRecoveries.get(root) !== state) return;
        if (++entries > LEGACY_RECOVERY_MAX_ENTRIES) {
          throw legacyRecoveryError('Legacy replay recovery exceeded the physical entry limit.');
        }
        if (entry.isFile() && /^fallback_[A-Za-z0-9_-]{20,160}\.json$/.test(entry.name)) {
          const file = path.join(root, entry.name);
          const stat = await fs.promises.stat(file);
          if (!stat.isFile() || stat.size > LEGACY_RECOVERY_FILE_BYTES
            || bytes + stat.size > LEGACY_RECOVERY_MAX_BYTES) {
            throw legacyRecoveryError('Legacy replay recovery exceeded the retained byte limit.');
          }
          bytes += stat.size;
          const record = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          if (!record || record.operationId !== entry.name.slice(0, -5)) {
            throw legacyRecoveryError('A retained operation record has invalid ownership.');
          }
          if (!record.workId) state.candidates.push(record);
        }
        if (entries % 64 === 0 || Date.now() - sliceStart >= LEGACY_SYNC_MS) {
          await new Promise(resolve => setImmediate(resolve));
          sliceStart = Date.now();
        }
      }
      if (legacyDirectoryStamp(root) !== stamp) {
        throw legacyRecoveryError('Retained operation storage changed during replay recovery. Retry recovery.');
      }
      state.status = 'done';
    } catch (cause) {
      state.error = cause?.code === 'FALLBACK_RECOVERY_UNAVAILABLE' ? cause
        : legacyRecoveryError('A retained operation record is unreadable. Inspect storage before retrying.', cause);
      state.status = 'failed';
    }
  })();
  return state;
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
  const stamp = legacyDirectoryStamp(root);
  if (stamp === null) return [];
  let recovery = legacyScopeRecoveries.get(root);
  if (recovery && recovery.stamp !== stamp) {
    // Cleanup or another writer changed the directory while replay was running.
    // Restart in the background instead of redoing a synchronous scan on each retry.
    recovery = beginLegacyScopeRecovery(root, stamp);
  }
  if (recovery) {
    if (recovery.status === 'failed') throw recovery.error;
    if (recovery.status !== 'done') throw legacyRecoveryError('Legacy replay recovery is incomplete. Retry this admission; no operation has been started.');
    return recovery.candidates
      .filter(record => matching(record) && fresh(record))
      .map(record => {
        // The background scan is a discovery index, not proof that the file
        // remains intact. Verify exact durable state before replaying.
        const stored = readFallbackFile(config, record.operationId);
        if (!stored) throw legacyRecoveryError('A recovered operation disappeared before replay.');
        return stored;
      })
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }
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
  let bytes = 0;
  const startedAt = Date.now();
  try {
    let entry;
    while ((entry = directory.readSync())) {
      if (++count > LEGACY_SYNC_ENTRIES || bytes > LEGACY_SYNC_BYTES || Date.now() - startedAt > LEGACY_SYNC_MS) {
        beginLegacyScopeRecovery(root, stamp);
        throw legacyRecoveryError('Legacy replay recovery is continuing asynchronously. Retry admission without repeating the operation.');
      }
      if (!entry.isFile() || !/^fallback_[A-Za-z0-9_-]{20,160}\.json$/.test(entry.name)) continue;
      let record;
      try {
        const file = path.join(root, entry.name);
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > LEGACY_RECOVERY_FILE_BYTES
          || (bytes += stat.size) > LEGACY_SYNC_BYTES) {
          beginLegacyScopeRecovery(root, stamp);
          throw legacyRecoveryError('Legacy replay recovery is continuing asynchronously. Retry admission.');
        }
        record = readJsonFile(file);
      } catch (cause) {
        if (cause?.code === 'FALLBACK_RECOVERY_UNAVAILABLE') throw cause;
        throw legacyRecoveryError('A retained operation record is unreadable. Inspect storage before retrying.', cause);
      }
      if (!record || record.operationId !== entry.name.slice(0, -5)) {
        throw legacyRecoveryError('A retained operation record has invalid ownership.');
      }
      if (matching(record) && fresh(record)) candidates.push(record);
    }
  } finally { directory.closeSync(); }
  if (legacyDirectoryStamp(root) !== stamp) {
    throw legacyRecoveryError('Retained operation storage changed during replay recovery. Retry admission.');
  }
  return candidates.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function recoverExecutionRecords(reference, options = {}) {
  if (!options.config) return;
  const exactLive = executionsByOperationId.get(reference);
  if (exactLive) { reconcileLiveFallback(options.config, exactLive); return; }
  const persisted = reference.startsWith('fallback_')
    ? [readPersistedFallback(options.config, reference, options.workId)].filter(Boolean)
    : options.scopeOnly ? readPersistedScope(options.config, reference, options)
      : readTaskBackgroundOperations(options.config, reference);
  for (let record of persisted) {
    if (!record?.operationId) continue;
    if (executionsByOperationId.has(record.operationId)) {
      reconcileLiveFallback(options.config, executionsByOperationId.get(record.operationId));
      continue;
    }
    if (!reference.startsWith('fallback_') && !options.scopeOnly) {
      record = selectPersistedFallback(options.config, record, readFallbackFile(options.config, record.operationId));
    }
    canonicalizeFallbackWorkspace(record, options.config);
    if (options.noticeScope && record.noticeScope !== options.noticeScope) continue;
    if (options.workspace && record.workspace !== options.workspace) continue;
    if (options.workId && record.workId !== options.workId) continue;
    const recovered = recoverPersistedFallback(options.config, record.operationId, options.now || Date.now, record);
    if (recovered) {
      const hydrated = hydratePersistedRecord(recovered);
      hydrated.stateRoot = getStateDir(options.config);
      executionsByOperationId.set(recovered.operationId, hydrated);
      if (hydrated.pointerRepairPending) repairFallbackPointer(options.config, hydrated);
      else if (hydrated.durability === 'journaled' || hydrated.durability === 'memory_only') scheduleFallbackPersistenceRetry(options.config, hydrated);
    }
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
  // Resolve and authorize the existing record before handling a cancelled wait.
  // Cancellation of result delivery never changes the operation's durable state.
  const operation = fallbackExecutionStatus(reference, options);
  if (!operation) return null;
  if (options.signal?.aborted) return interruptedResultWait(operation);
  const record = executionsByOperationId.get(operation.operationId);
  const requestedWaitMs = Number(options.waitMs ?? MAX_FALLBACK_RESULT_WAIT_MS);
  const deadlineWaitMs = Number(options.deadlineAtMs) > 0
    ? Math.max(0, Number(options.deadlineAtMs) - Date.now()) : MAX_FALLBACK_RESULT_WAIT_MS;
  const waitMs = Math.min(MAX_FALLBACK_RESULT_WAIT_MS, deadlineWaitMs, Math.max(0, requestedWaitMs || 0));
  const waiterCount = [...fallbackResultWaiters.values()].reduce((count, listeners) => count + listeners.size, 0);
  if (!record?.promise || operation.status !== FALLBACK_EXECUTION_STATUS.RUNNING
    || waitMs <= 0 || waiterCount >= MAX_CONCURRENT_RESULT_WAITS) return operation;
  await new Promise(resolve => {
    const listeners = fallbackResultWaiters.get(record.operationId) || new Set();
    fallbackResultWaiters.set(record.operationId, listeners);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onSettled);
      listeners.delete(onSettled);
      if (!listeners.size) fallbackResultWaiters.delete(record.operationId);
    };
    const onSettled = () => { cleanup(); resolve(); };
    const timer = setTimeout(onSettled, waitMs);
    listeners.add(onSettled);
    options.signal?.addEventListener('abort', onSettled, { once: true });
    if (options.signal?.aborted) onSettled();
  });
  const latest = fallbackExecutionStatus(reference, options);
  return options.signal?.aborted ? interruptedResultWait(latest) : latest;
}

function interruptedResultWait(operation) {
  if (!operation) return null;
  return {
    ...operation,
    retrievalInterrupted: true,
    recovery: { action: 'result', operationId: operation.operationId, retryOriginalOperation: false, respectUserStop: true },
    nextAction: 'Result waiting was interrupted; the operation status and retained result above remain authoritative. Respect any explicit user stop. If still authorized and the result is needed, retrieve this same operationId; do not rerun the original operation.'
  };
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
    error: 'No live execution record is available for the last persisted running operation. Its final outcome is unknown. Inspect retained evidence before retrying.'
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
    durability: record.pointerRepairPending === true ? 'memory_only' : record.durability || (record.journalPending === true ? 'journaled' : 'persisted'),
    persistenceError: String(record.persistenceError || ''),
    journalPending: record.journalPending === true,
    pointerRepairPending: record.pointerRepairPending === true,
    controller: null,
    promise: null
  };
}

function persistentFallbackRecord(record) {
  const structured = withoutFallbackPersistenceWarning(record.result?.structuredContent || record.persistedResult || null);
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

function readFallbackFile(config, operationId) {
  if (!/^fallback_[A-Za-z0-9_-]{20,160}$/.test(String(operationId || ''))) return null;
  try {
    return readJsonFile(tasklessFallbackFile(config, operationId), {
      validate: value => Boolean(value && typeof value === 'object' && value.operationId === operationId)
    });
  } catch (cause) {
    if (cause?.code === 'ENOENT') return null;
    throw Object.assign(new Error('Retained operation storage could not be read safely. Inspect this operation before retrying.', { cause }),
      { code: 'FALLBACK_RECOVERY_UNAVAILABLE', executed: false });
  }
}

function selectPersistedFallback(config, canonical, stored, options = {}) {
  if (!canonical) return stored?.status ? stored : null;
  if (!stored?.status || stored.journalPending !== true) return canonical;
  const left = canonicalizeFallbackWorkspace({ ...canonical }, config);
  const right = canonicalizeFallbackWorkspace({ ...stored }, config);
  const owner = value => [value.operationId, value.workId || '', value.executionKey || value.workId || value.operationId,
    value.noticeScope || '', value.workspace || '', value.signature || ''];
  if (stableJson(owner(left)) !== stableJson(owner(right))) {
    throw Object.assign(new Error('Retained operation journal conflicts with its canonical ownership. Inspect this operation before retrying.'),
      { code: 'FALLBACK_RECOVERY_UNAVAILABLE', executed: false });
  }
  const leftRevision = Number(left.revision || 1), rightRevision = Number(right.revision || 1);
  if (leftRevision !== rightRevision) return rightRevision > leftRevision ? right : { ...left, pointerRepairPending: true };
  if (left.status !== right.status) {
    throw Object.assign(new Error('Retained operation records disagree at the same revision. Inspect this operation before retrying.'),
      { code: 'FALLBACK_RECOVERY_UNAVAILABLE', executed: false });
  }
  // Delivery metadata can change independently, but immutable terminal facts
  // cannot disagree at one revision. Fail before acknowledgement precedence.
  if (left.status !== FALLBACK_EXECUTION_STATUS.RUNNING) {
    const terminalFacts = value => [value.tool || '', value.startedAt || '', value.completedAt || '',
      value.error || '', value.isError === true, value.cancellationRequestedAt || '', value.cancellationReason || '',
      withoutFallbackPersistenceWarning(value.result || null)];
    if (stableJson(terminalFacts(left)) !== stableJson(terminalFacts(right))) {
      throw Object.assign(new Error('Retained operation terminal facts disagree at the same revision. Inspect this operation before retrying.'),
        { code: 'FALLBACK_RECOVERY_UNAVAILABLE', executed: false });
    }
  }
  // A delayed journal must never resurrect an already acknowledged replay.
  if ((left.deliveryAcknowledged === true) !== (right.deliveryAcknowledged === true)) {
    return left.deliveryAcknowledged === true ? { ...left, pointerRepairPending: true } : right;
  }
  return options.preferCanonicalOnEqual ? { ...left, pointerRepairPending: true } : right;
}

function readPersistedFallback(config, reference, workId = '') {
  const id = String(reference || '').trim();
  try {
    if (id.startsWith('fallback_')) {
      const stored = readFallbackFile(config, id);
      const taskId = stored?.workId || workId;
      if (!taskId) return stored;
      let canonical;
      try { canonical = readTaskBackgroundOperations(config, taskId).find(record => record.operationId === id); }
      catch (cause) {
        // A fresh process may encounter a migration/read lock before SQLite can
        // return its row. The independently durable exact journal still stands.
        if (stored?.journalPending === true && stored.status && stored.status !== FALLBACK_EXECUTION_STATUS.RUNNING) return stored;
        throw cause;
      }
      return selectPersistedFallback(config, canonical, stored);
    }
    return readTaskBackgroundOperation(config, id);
  } catch (error) {
    if (error?.code === 'FALLBACK_RECOVERY_UNAVAILABLE') throw error;
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] fallback operation read:', error);
    return null;
  }
}

function withoutFallbackPersistenceWarning(value) {
  if (!value || typeof value !== 'object') return value;
  const warning = value.operationPersistence;
  if (warning?.errorCode !== 'FALLBACK_PERSISTENCE_FAILED' && warning?.storage !== 'operation-journal') return value;
  const result = { ...value };
  delete result.operationPersistence;
  return result;
}

function clearFallbackPersistenceRetry(operationId) {
  const pending = fallbackPersistenceRetries.get(operationId);
  if (pending?.timer) clearTimeout(pending.timer);
  fallbackPersistenceRetries.delete(operationId);
}

function reconcileLiveFallback(config, record) {
  if (!record || (!record.pointerRepairPending && !record.persistenceError && record.durability !== 'memory_only' && record.durability !== 'journaled')) return;
  const now = Date.now();
  if (now - Number(record.lastPersistenceReconcileAtMs || 0) < 1000) return;
  record.lastPersistenceReconcileAtMs = now;
  if (record.pointerRepairPending) repairFallbackPointer(config, record);
  else persistFallbackRecord(config, record);
}

function repairFallbackPointer(config, record) {
  if (!record?.pointerRepairPending || !record.workId) return;
  try {
    const stored = readFallbackFile(config, record.operationId);
    if (stored && stored.workId !== record.workId) {
      throw new Error('Retained operation pointer ownership changed; preserve it for inspection.');
    }
    // The working-session projection can include uncommitted worker writes.
    // Only the physical row proves it is safe to discard the terminal journal.
    const session = readSession(getTaskHistoryDir(config), record.workId);
    const operations = session?.backgroundOperations || (session?.backgroundOperation ? [session.backgroundOperation] : []);
    const canonical = operations.find(value => value.operationId === record.operationId);
    if (!canonical || canonical.status === FALLBACK_EXECUTION_STATUS.RUNNING) {
      throw new Error('Task background operation has not reached durable history for pointer repair.');
    }
    const liveProjection = sanitizeTaskRecord({ status: 'planning', backgroundOperation: persistentFallbackRecord(record) })?.backgroundOperation;
    for (const candidate of [...(stored?.journalPending ? [stored] : []), { ...liveProjection, journalPending: true }]) {
      const selected = selectPersistedFallback(config, canonical, candidate, { preferCanonicalOnEqual: true });
      if (selected?.journalPending === true) {
        throw new Error('Task background operation has not reached durable history for pointer repair.');
      }
    }
    if (Number(canonical.revision || 1) > Number(record.revision || 1)) {
      Object.assign(record, hydratePersistedRecord(canonical));
    } else if (canonical.deliveryAcknowledged === true) record.deliveryAcknowledged = true;
    record.pointerRepairPending = true;
    record.durability = 'persisted';
    if (stableJson(readFallbackFile(config, record.operationId)) !== stableJson(stored)) {
      throw new Error('Retained operation journal changed before pointer repair; preserve it for later reconciliation.');
    }
    writeJsonAtomic(tasklessFallbackFile(config, record.operationId),
      { operationId: record.operationId, workId: record.workId }, { mode: 0o600 });
    record.pointerRepairPending = false;
    record.persistenceError = '';
    clearFallbackPersistenceRetry(record.operationId);
  } catch (error) {
    record.persistenceError = String(error?.message || error);
    scheduleFallbackPersistenceRetry(config, record);
  }
}

function scheduleFallbackPersistenceRetry(config, record) {
  if (!config || record.persist === false || executionsByOperationId.get(record.operationId) !== record) return;
  // Recovered journals do not persist transient SQLite error text. Give them
  // one initial reconciliation attempt, then classify the actual failure.
  const recoveredPending = (record.journalPending === true || record.pointerRepairPending === true) && !record.persistenceError;
  if (!recoveredPending && !/database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)|has not reached durable history/i.test(record.persistenceError || '')) {
    clearFallbackPersistenceRetry(record.operationId);
    return;
  }
  let pending = fallbackPersistenceRetries.get(record.operationId);
  if (pending && pending.record !== record) { clearFallbackPersistenceRetry(record.operationId); pending = null; }
  if (!pending) {
    if (fallbackPersistenceRetries.size >= MAX_FALLBACK_RECORDS) return;
    pending = { config, record, attempt: 0, timer: null };
    fallbackPersistenceRetries.set(record.operationId, pending);
  }
  if (pending.timer) return;
  const owned = pending;
  owned.timer = setTimeout(() => {
    owned.timer = null;
    if (fallbackPersistenceRetries.get(record.operationId) !== owned
      || executionsByOperationId.get(record.operationId) !== record) return;
    owned.attempt = Math.min(owned.attempt + 1, FALLBACK_PERSISTENCE_RETRY_DELAYS_MS.length - 1);
    // Rebuild from current state, including delivery acknowledgement. Never
    // retry a captured pre-ack snapshot or a record removed by reset/pruning.
    if (record.pointerRepairPending) repairFallbackPointer(owned.config, record);
    else persistFallbackRecord(owned.config, record);
  }, FALLBACK_PERSISTENCE_RETRY_DELAYS_MS[owned.attempt]);
  owned.timer.unref?.();
}

function persistFallbackRecord(config, record, options = {}) {
  if (!config || !record || record.persist === false) return;
  // A normal write may contain newer acknowledgement/state that must be saved.
  record.pointerRepairPending = false;
  try {
    const persisted = persistFallbackSnapshot(config, persistentFallbackRecord(record), {
      allowJournalFallback: options.required !== true && record.status !== FALLBACK_EXECUTION_STATUS.RUNNING,
      required: options.required === true
    });
    record.persistenceError = persisted.persistenceError || '';
    record.durability = persisted.journalPending === true ? 'journaled' : 'persisted';
    record.journalPending = persisted.journalPending === true;
    record.pointerRepairPending = persisted.pointerRepairPending === true;
    record.persistedResultCompacted = persisted.persistedResultCompacted === true;
    record.resultRetention = persisted.resultRetention || null;
    if (record.result?.structuredContent) {
      const structured = withoutFallbackPersistenceWarning(record.result.structuredContent);
      record.result = { ...record.result, structuredContent: record.journalPending
        ? { ...structured, operationPersistence: { durable: true, canonicalPending: true, storage: 'operation-journal',
          nextAction: 'Retrieve this operationId. Task history reconciliation is pending.' } } : structured };
    }
    record.persistedResult = withoutFallbackPersistenceWarning(record.persistedResult);
    if (record.persistenceError || record.journalPending || record.pointerRepairPending) scheduleFallbackPersistenceRetry(config, record);
    else clearFallbackPersistenceRetry(record.operationId);
  } catch (cause) {
    const previousError = record.persistenceError;
    record.persistenceError = String(cause?.message || cause);
    record.durability = 'memory_only';
    if (options.required === true) {
      const error = new Error('Background operation was not started because its acceptance record could not be persisted.', { cause });
      error.code = 'FALLBACK_PERSISTENCE_FAILED';
      error.executed = false;
      throw error;
    }
    if (record.result?.structuredContent) {
      record.result = { ...record.result, structuredContent: {
        ...record.result.structuredContent,
        operationPersistence: { durable: false, errorCode: 'FALLBACK_PERSISTENCE_FAILED',
          nextAction: 'Keep this result. Do not repeat the operation to repair persistence; reconcile this operationId.' }
      } };
    }
    scheduleFallbackPersistenceRetry(config, record);
    if (previousError !== record.persistenceError) console.error('[rel-ai-mcp] Background result retained only in memory:',
      record.operationId, record.persistenceError.slice(0, 240));
  }
}

async function retainFallbackOutput(config, record, result) {
  if (!config || record.persist === false || (record.workId && !readTaskBackgroundOperation(config, record.workId))) return;
  const owner = record.workId || (record.workspace && record.noticeScope ? `workspace:${record.workspace}:principal:${record.noticeScope}` : '');
  if (!owner) return;
  await retainOutputStreams(config, owner, result?.structuredContent);
}

function persistFallbackSnapshot(config, record, options = {}) {
  const projected = sanitizeTaskRecord({ status: 'planning', backgroundOperation: record })?.backgroundOperation || {};
  const originalResult = JSON.stringify(record.result);
  const retainedResult = JSON.stringify(projected.result);
  if (originalResult !== retainedResult) {
    projected.persistedResultCompacted = true;
    projected.resultRetention = { complete: false, compacted: true, originalBytes: Buffer.byteLength(originalResult || '', 'utf8'), retainedBytes: Buffer.byteLength(retainedResult || '', 'utf8'), reason: 'Durable history retains a sanitized bounded projection. Omitted fields cannot be restored by increasing the response budget.' };
  }
  record = projected;
  let taskAuthoritative = false;
  let canonicalError = null;
  if (record.workId) {
    try {
      const stored = recordTaskBackgroundOperation(config, record.workId, record);
      if (stored) {
        const session = readSession(getTaskHistoryDir(config), record.workId);
        const operations = session?.backgroundOperations || (session?.backgroundOperation ? [session.backgroundOperation] : []);
        taskAuthoritative = operations.some(value => value.operationId === record.operationId
          && value.revision === record.revision && value.status === record.status
          && value.deliveryAcknowledged === record.deliveryAcknowledged);
        if (!taskAuthoritative) throw new Error('Task background operation has not reached durable history.');
      }
    } catch (error) { canonicalError = error; }
  }
  const file = tasklessFallbackFile(config, record.operationId);
  if (canonicalError) {
    if (!options.allowJournalFallback) throw canonicalError;
    // A terminal result must survive process loss while SQLite is locked.
    // This is the same bounded projection and fsynced atomic file primitive
    // already used for taskless receipts; required admission is unchanged.
    const journal = { ...record, journalPending: true };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, journal, { mode: 0o600 });
    return { ...journal, persistenceError: String(canonicalError?.message || canonicalError) };
  }
  const sanitized = taskAuthoritative ? { operationId: record.operationId, workId: record.workId } : record;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, sanitized, { mode: 0o600 });
  } catch (error) {
    // An existing canonical terminal commit remains durable if only its
    // pointer refresh fails. Initial admission still requires both writes.
    if (!taskAuthoritative || options.required) throw error;
    return { ...record, pointerRepairPending: true, persistenceError: String(error?.message || error) };
  }
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
      if (record.workId && record.journalPending === true) continue;
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
  const status = reason?.code === 'SERVICE_SHUTDOWN'
    ? FALLBACK_EXECUTION_STATUS.INTERRUPTED : FALLBACK_EXECUTION_STATUS.CANCELLED;
  if (record.status !== status) settleRecord(record, status, now);
  record.error = reason instanceof Error ? reason.message : String(reason || record.error || 'Work session cancelled by request.');
}

function pruneFallbackExecutions(now = Date.now) {
  const current = timeValue(now);
  for (const record of executionsByOperationId.values()) {
    if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING || record.durability === 'memory_only') continue;
    const completed = Number(record.completedAtMs || record.startedAtMs || current);
    if (current - completed > FALLBACK_RECORD_TTL_MS) removeFallbackExecutionRecord(record);
  }
  if (executionsByOperationId.size <= MAX_FALLBACK_RECORDS) return;
  const removable = [...executionsByOperationId.values()]
    .filter(record => record.status !== FALLBACK_EXECUTION_STATUS.RUNNING && record.durability !== 'memory_only')
    .sort((left, right) => Number(left.completedAtMs || left.startedAtMs) - Number(right.completedAtMs || right.startedAtMs));
  while (executionsByOperationId.size > MAX_FALLBACK_RECORDS && removable.length) {
    removeFallbackExecutionRecord(removable.shift());
  }
}

function removeFallbackExecutionRecord(record) {
  if (!record) return;
  if (record.operationId) {
    clearFallbackPersistenceRetry(record.operationId);
    executionsByOperationId.delete(record.operationId);
  }
}

function timeValue(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function fallbackSignature(tool, args = {}) {
  return crypto.createHash('sha256').update(stableJson([String(tool || ''), args])).digest('base64url');
}

// The HTTP listener has stopped accepting work before this shutdown boundary.
// Stop only this state directory's live producers and wait a bounded interval
// for their terminal records. Incomplete work remains explicitly unclean.
async function stopFallbackExecutionsForShutdown(config, timeoutMs = 5000) {
  const root = getStateDir(config);
  const active = [...executionsByOperationId.values()].filter(record =>
    record.stateRoot === root && record.status === FALLBACK_EXECUTION_STATUS.RUNNING);
  const reason = Object.assign(new Error('Service shutdown interrupted the operation; inspect its retained result before retrying.'),
    { code: 'SERVICE_SHUTDOWN' });
  for (const record of active) {
    if (!record.controller || record.controller.signal.aborted) continue;
    record.shutdownInterrupted = true;
    record.controller.abort(reason);
    record.phase = 'stopping';
    record.updatedAt = new Date().toISOString();
    record.revision += 1;
    persistFallbackRecord(config, record);
  }
  let timer;
  let completed;
  try {
    completed = await Promise.race([
      Promise.allSettled(active.map(record => record.promise || Promise.resolve())).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, Math.min(30_000, Number(timeoutMs) || 5000))); })
    ]);
  } finally { if (timer) clearTimeout(timer); }
  return { attempted: active.length, settled: active.filter(record =>
    record.status !== FALLBACK_EXECUTION_STATUS.RUNNING).length,
    pending: active.filter(record => record.status === FALLBACK_EXECUTION_STATUS.RUNNING).length,
    timedOut: !completed };
}

// Must run *after* task-history flush: a terminal sidecar may have become
// canonical during that flush. Verify the exact physical receipt, not a live
// memory projection or a clean-looking HTTP response.
function verifyFallbackDurabilityForShutdown(config) {
  const root = getStateDir(config);
  const records = [...executionsByOperationId.values()].filter(record => record.stateRoot === root);
  const incompleteOperationIds = [];
  const interruptedOperationIds = [];
  for (const record of records) {
    if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) {
      incompleteOperationIds.push(record.operationId);
      continue;
    }
    if (record.shutdownInterrupted === true) {
      interruptedOperationIds.push(record.operationId);
    }
    if (record.persist === false) continue;
    if (record.pointerRepairPending) repairFallbackPointer(config, record);
    else if (record.durability === 'memory_only' || record.durability === 'journaled') {
      persistFallbackRecord(config, record);
    }
    try {
      const stored = readPersistedFallback(config, record.operationId, record.workId);
      const valid = stored?.operationId === record.operationId
        && stored.status === record.status
        && Number(stored.revision || 0) >= Number(record.revision || 0)
        && (stored.deliveryAcknowledged === true) === (record.deliveryAcknowledged === true);
      const indexed = Boolean(record.workId) || readJsonFile(scopeIndexFile(config, record.executionKey, record.noticeScope))?.operationId === record.operationId;
      if (!valid || !indexed || record.durability === 'memory_only') {
        incompleteOperationIds.push(record.operationId);
      }
    } catch {
      incompleteOperationIds.push(record.operationId);
    }
  }
  return {
    ok: incompleteOperationIds.length === 0 && interruptedOperationIds.length === 0,
    checked: records.length,
    incompleteOperationIds,
    interruptedOperationIds
  };
}

function resetFallbackExecutions() {
  for (const operationId of fallbackPersistenceRetries.keys()) clearFallbackPersistenceRetry(operationId);
  for (const listeners of fallbackResultWaiters.values()) {
    for (const notify of [...listeners]) notify();
  }
  executionsByOperationId.clear();
  legacyScopeRecoveries.clear();
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
  stopFallbackExecutionsForShutdown,
  verifyFallbackDurabilityForShutdown,
  resetFallbackExecutions,
  startFallbackExecution
};
