import * as crypto from 'node:crypto';
import { stableJson } from '../stableJson.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../durableState.ts';
import { getStateDir } from '../statePaths.js';
import { readTaskBackgroundOperation, readTaskBackgroundOperations, recordTaskBackgroundOperation } from '../taskHistoryStore.ts';
import { sanitizeTaskRecord } from '../taskObservability.js';
import { createOutputSpillWriter } from '../outputSpill.js';
import { FALLBACK_EXECUTION_STATUS } from './contracts.ts';
import { publishMcpEvent } from './events.ts';

const DEFAULT_FALLBACK_GRACE_MS = 1_000;
const FALLBACK_RECORD_TTL_MS = 15 * 60_000;
const MAX_FALLBACK_RECORDS = 128;
const MAX_COMPLETION_NOTICES = 16;
const REPLAYABLE_FALLBACK_STATUSES = new Set([
  FALLBACK_EXECUTION_STATUS.COMPLETED,
  FALLBACK_EXECUTION_STATUS.FAILED,
  FALLBACK_EXECUTION_STATUS.CANCELLED
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

  recoverExecutionRecords(id, { config, now, noticeScope });
  const existing = recordsForReference(id).findLast(record => record.signature === signature
    && (!noticeScope || record.noticeScope === noticeScope)
    && (record.status === FALLBACK_EXECUTION_STATUS.RUNNING
      || (record.deliveryAcknowledged !== true && REPLAYABLE_FALLBACK_STATUSES.has(record.status))));
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
    phase: 'starting',
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

  record.promise = Promise.resolve()
    .then(() => run(controller.signal, record.operationId))
    .then(async result => {
      await retainFallbackOutput(config, record, result);
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
      return { ok: true, result };
    }, error => {
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
    });

  executionsByOperationId.set(record.operationId, record);
  persistFallbackRecord(config, record);
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

function acknowledgeFallbackDelivery(config, reference) {
  const id = String(reference || '').trim();
  if (!id) return false;
  const record = recordsForReference(id).at(-1) || null;
  if (!record) return false;
  // Delivery of a running acknowledgement confirms acceptance, not receipt of
  // the eventual result. Keep the replay identity until a terminal result arrives.
  if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) return true;
  record.deliveryAcknowledged = true;
  persistFallbackRecord(config, record);
  return true;
}

function recordsForReference(reference) {
  const exact = executionsByOperationId.get(reference);
  if (exact) return [exact];
  return [...executionsByOperationId.values()].filter(record => (record.executionKey || record.workId) === reference);
}

function recoverExecutionRecords(reference, options = {}) {
  if (!options.config) return;
  const persisted = reference.startsWith('fallback_')
    ? [readPersistedFallback(options.config, reference, options.workId)].filter(Boolean)
    : readTaskBackgroundOperations(options.config, reference);
  for (const record of persisted) {
    if (!record?.operationId) continue;
    if (executionsByOperationId.has(record.operationId)) continue;
    if (options.noticeScope && record.noticeScope && record.noticeScope !== options.noticeScope) continue;
    if (options.workId && record.workId !== options.workId) continue;
    const recovered = recoverPersistedFallback(options.config, record.operationId, options.now || Date.now, record);
    if (recovered) executionsByOperationId.set(recovered.operationId, hydratePersistedRecord(recovered));
  }
}

function fallbackExecutionsStatus(reference, options = {}) {
  const id = String(reference || '').trim();
  if (!id) return [];
  const now = options.now || Date.now;
  pruneFallbackExecutions(now);
  recoverExecutionRecords(id, options);
  return recordsForReference(id)
    .filter(record => !options.noticeScope || !record.noticeScope || record.noticeScope === options.noticeScope)
    .filter(record => !options.workId || record.workId === options.workId)
    .map(record => publicFallbackRecord(record, now));
}

function updateFallbackExecutionPhase(operationId, phase, config) {
  const record = executionsByOperationId.get(String(operationId || ''));
  if (!record || record.status !== FALLBACK_EXECUTION_STATUS.RUNNING || record.phase === phase) return;
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

function publicFallbackRecord(record, now = Date.now) {
  if (!record) return null;
  const structured = record.result?.structuredContent || record.persistedResult || record.result?.result || null;
  const running = record.status === FALLBACK_EXECUTION_STATUS.RUNNING;
  const currentMs = timeValue(now);
  const startedAtMs = Number(record.startedAtMs || Date.parse(record.startedAt) || currentMs);
  const deadlineAtMs = Number(record.deadlineAtMs || 0);
  return {
    operationId: record.operationId,
    ...(record.workId ? { work_id: record.workId } : {}),
    tool: record.tool,
    workspace: record.workspace,
    status: record.status,
    ...(record.phase ? { phase: record.phase } : {}),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt || record.startedAt,
    revision: Math.max(1, Number(record.revision || 1)),
    elapsedMs: Math.max(0, currentMs - startedAtMs),
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
  if (elapsed < 60_000) return 30_000;
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
  pendingCompletionDeliveries.set(completionDeliveryKey(noticeScope, requestId), {
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
  if (!pending) return false;
  pendingCompletionDeliveries.delete(key);
  let acknowledged = false;
  for (const operationId of pending.operationIds) {
    const consumed = acknowledgeFallbackCompletionNotice(pending.config, operationId, {
      noticeScope: pending.noticeScope,
      workspace: pending.workspace
    });
    if (consumed) acknowledgeFallbackDelivery(pending.config, operationId);
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
  void publishMcpEvent(config, {
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
  }).then(delivered => {
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
  upsertFallbackCompletionRecord(config, noticeScope, workspace, fallbackCompletionIntent(record));
}

function enqueueFallbackCompletionNotice(config, record) {
  if (!config || !record || record.status === FALLBACK_EXECUTION_STATUS.RUNNING) return;
  const noticeScope = String(record.noticeScope || '').trim();
  const workspace = String(record.workspace || '').trim();
  if (!noticeScope || !workspace || !record.operationId) return;
  upsertFallbackCompletionRecord(config, noticeScope, workspace, fallbackCompletionNotice(record));
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
  persistFallbackSnapshot(config, interrupted);
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
    deadlineAtMs: Number(record.deadlineAtMs || 0),
    startedAt: String(record.startedAt || ''),
    startedAtMs: Date.parse(record.startedAt) || 0,
    updatedAt: String(record.updatedAt || record.startedAt || ''),
    completedAt: String(record.completedAt || ''),
    completedAtMs: Date.parse(record.completedAt) || 0,
    revision: Math.max(1, Number(record.revision || 1)),
    result: null,
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
      return taskId ? readTaskBackgroundOperations(config, taskId).find(record => record.operationId === id) || null : stored;
    }
    return readTaskBackgroundOperation(config, id);
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] fallback operation read:', error);
    return null;
  }
}

function persistFallbackRecord(config, record) {
  if (!config || !record || record.persist === false) return;
  persistFallbackSnapshot(config, persistentFallbackRecord(record));
}

async function retainFallbackOutput(config, record, result) {
  if (!config || record.persist === false || (record.workId && !readTaskBackgroundOperation(config, record.workId))) return;
  const owner = record.workId || (record.workspace && record.noticeScope ? `workspace:${record.workspace}:principal:${record.noticeScope}` : '');
  if (!owner) return;
  async function retain(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 5) return;
    for (const stream of ['stdout', 'stderr']) {
      const refKey = `${stream}OutputRef`;
      if (typeof value[stream] !== 'string' || !value[stream] || value[refKey]) continue;
      const writer = createOutputSpillWriter(config, owner);
      writer.start(value[stream]);
      const retained = await writer.finish();
      if (retained?.outputRef) value[refKey] = retained.outputRef;
      if (retained?.spillTruncated) value[`${stream}SpillTruncated`] = true;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') await retain(child, depth + 1);
    }
  }
  try { await retain(result?.structuredContent); }
  catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] fallback output retention:', error);
  }
}

function persistFallbackSnapshot(config, record) {
  try {
    if (record.workId) {
      recordTaskBackgroundOperation(config, record.workId, record);
      // Work-bound records also need direct operationId lookup after restart.
      if (!readTaskBackgroundOperation(config, record.workId)) return;
    }
    const file = tasklessFallbackFile(config, record.operationId);
    // Task history is authoritative for work-bound operations; the file is an
    // operationId lookup index, not a second copy of the execution state.
    const sanitized = record.workId ? { operationId: record.operationId, workId: record.workId }
      : sanitizeTaskRecord({ status: 'planning', backgroundOperation: record })?.backgroundOperation || {};
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeJsonAtomic(file, sanitized, { mode: 0o600 });
    pruneTasklessFallbackFiles(config);
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] fallback operation persistence:', error);
  }
}

function tasklessFallbackFile(config, operationId) {
  const id = String(operationId || '').trim();
  if (!/^fallback_[A-Za-z0-9_-]{20,160}$/.test(id)) throw new Error('Invalid fallback operationId.');
  return path.join(getStateDir(config), 'fallback-executions', `${id}.json`);
}

function pruneTasklessFallbackFiles(config) {
  const root = path.join(getStateDir(config), 'fallback-executions');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - FALLBACK_RECORD_TTL_MS;
  const files = entries.filter(entry => entry.isFile() && /^fallback_[A-Za-z0-9_-]{20,160}\.json$/.test(entry.name)).map(entry => {
    const file = path.join(root, entry.name);
    try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
  files.forEach((entry, index) => {
    if (entry.mtimeMs >= cutoff && index < MAX_FALLBACK_RECORDS) return;
    const record = readPersistedFallback(config, path.basename(entry.file, '.json'));
    if (record?.status === FALLBACK_EXECUTION_STATUS.RUNNING) return;
    if (record?.workId) return;
    try { fs.rmSync(entry.file, { force: true }); } catch {}
  });
}

function settleRecord(record, status, now = Date.now) {
  const completedAtMs = timeValue(now);
  record.status = status;
  record.phase = '';
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
  fallbackExecutionsStatus,
  updateFallbackExecutionPhase,
  assertFallbackCompletionAvailable,
  fallbackSignature,
  resetFallbackExecutions,
  startFallbackExecution
};
