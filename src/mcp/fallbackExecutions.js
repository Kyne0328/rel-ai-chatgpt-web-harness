import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../durableState.ts';
import { getStateDir } from '../statePaths.js';
import { readTaskBackgroundOperation, recordTaskBackgroundOperation } from '../taskHistoryStore.ts';
import { sanitizeTaskRecord } from '../taskObservability.js';
import { FALLBACK_EXECUTION_STATUS } from './contracts.ts';

const DEFAULT_FALLBACK_GRACE_MS = 1_000;
const FALLBACK_RECORD_TTL_MS = 15 * 60_000;
const MAX_FALLBACK_RECORDS = 128;
const MAX_COMPLETION_NOTICES = 16;
const REPLAYABLE_FALLBACK_STATUSES = new Set([
  FALLBACK_EXECUTION_STATUS.COMPLETED,
  FALLBACK_EXECUTION_STATUS.FAILED,
  FALLBACK_EXECUTION_STATUS.CANCELLED
]);
const executionsByWorkId = new Map();
const executionsByOperationId = new Map();

function startFallbackExecution({ config = null, workId = '', scopeId = '', noticeScope = '', tool, workspace = '', signature = '', run, persist = true, now = Date.now }) {
  const work = String(workId || '').trim();
  const id = work || String(scopeId || '').trim();
  if (!id) throw new Error('Fallback execution requires a durable work_id or authorized workspace execution scope.');
  if (typeof run !== 'function') throw new TypeError('Fallback execution requires a run function.');
  pruneFallbackExecutions(now);

  let existing = executionsByWorkId.get(id) || null;
  if (!existing && config) {
    const persisted = recoverPersistedFallback(config, id, now);
    if (persisted && persisted.deliveryAcknowledged !== true && REPLAYABLE_FALLBACK_STATUSES.has(persisted.status)) {
      existing = hydratePersistedRecord(persisted);
    }
  }
  if (existing?.status === FALLBACK_EXECUTION_STATUS.RUNNING) {
    if (existing.signature === signature) return { record: existing, reused: true };
    const error = new Error('Another long-running operation is already active for this work session. Check relai_work status before starting another operation.');
    error.code = 'TASK_OPERATION_IN_PROGRESS';
    error.retryable = true;
    throw error;
  }
  if (existing && existing.signature === signature && REPLAYABLE_FALLBACK_STATUSES.has(existing.status)) {
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
    .then(() => run(controller.signal))
    .then(result => {
      if (controller.signal.aborted) {
        settleCancelledRecord(record, now, controller.signal.reason);
        persistFallbackRecord(config, record);
        return { ok: false, cancelled: true, error: controller.signal.reason };
      }
      settleRecord(record, result?.isError === true ? FALLBACK_EXECUTION_STATUS.FAILED : FALLBACK_EXECUTION_STATUS.COMPLETED, now);
      record.result = result || null;
      record.isError = result?.isError === true;
      persistFallbackRecord(config, record);
      releaseDeliveredExecutionScope(record);
      if (record.noticeEnabled) enqueueFallbackCompletionNotice(config, record);
      return { ok: true, result };
    }, error => {
      if (controller.signal.aborted) {
        settleCancelledRecord(record, now, controller.signal.reason || error);
        persistFallbackRecord(config, record);
        return { ok: false, cancelled: true, error: controller.signal.reason || error };
      }
      settleRecord(record, FALLBACK_EXECUTION_STATUS.FAILED, now);
      record.error = error instanceof Error ? error.message : String(error);
      persistFallbackRecord(config, record);
      releaseDeliveredExecutionScope(record);
      if (record.noticeEnabled) enqueueFallbackCompletionNotice(config, record);
      return { ok: false, error };
    });

  executionsByWorkId.set(id, record);
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
  let record = executionsByOperationId.get(id) || executionsByWorkId.get(id) || null;
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
  if (record.status !== FALLBACK_EXECUTION_STATUS.RUNNING) return { cancelled: false, duplicate: true, record: publicFallbackRecord(record, now) };
  if (record.cancellationRequestedAt) {
    return { cancelled: false, duplicate: true, record: publicFallbackRecord(record, now), settlement: record.promise || null };
  }
  const requestedAt = new Date(timeValue(now)).toISOString();
  record.cancellationRequestedAt = requestedAt;
  record.cancellationReason = reason.message;
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
  if (record.status !== FALLBACK_EXECUTION_STATUS.RUNNING) enqueueFallbackCompletionNotice(config, record);
}

function acknowledgeFallbackDelivery(config, reference) {
  const id = String(reference || '').trim();
  if (!id) return false;
  const record = executionsByOperationId.get(id) || executionsByWorkId.get(id) || null;
  if (!record) return false;
  record.deliveryAcknowledged = true;
  persistFallbackRecord(config, record);
  if (record.status === FALLBACK_EXECUTION_STATUS.RUNNING) {
    return true;
  }
  executionsByWorkId.delete(record.executionKey || record.operationId);
  if (!record.workId) {
    executionsByOperationId.delete(record.operationId);
    if (config && record.operationId) {
      try { fs.rmSync(tasklessFallbackFile(config, record.operationId), { force: true }); } catch {}
    }
  }
  return true;
}

function releaseDeliveredExecutionScope(record) {
  if (!record || record.deliveryAcknowledged !== true) return;
  executionsByWorkId.delete(record.executionKey || record.operationId);
}

function fallbackExecutionStatus(reference, options = {}) {
  const now = options.now || Date.now;
  pruneFallbackExecutions(now);
  const id = String(reference || '').trim();
  const record = executionsByOperationId.get(id) || executionsByWorkId.get(id);
  if (record) return publicFallbackRecord(record, now);
  if (!options.config || !id) return null;
  const persisted = recoverPersistedFallback(options.config, id, now);
  if (!persisted) return null;
  const hydrated = hydratePersistedRecord(persisted);
  if (hydrated.operationId) executionsByOperationId.set(hydrated.operationId, hydrated);
  if (hydrated.executionKey || hydrated.workId) executionsByWorkId.set(hydrated.executionKey || hydrated.workId, hydrated);
  return publicFallbackRecord(hydrated, now);
}

function publicFallbackRecord(record, now = Date.now) {
  if (!record) return null;
  const structured = record.result?.structuredContent || record.persistedResult || record.result?.result || null;
  const running = record.status === FALLBACK_EXECUTION_STATUS.RUNNING;
  return {
    operationId: record.operationId,
    tool: record.tool,
    workspace: record.workspace,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt || record.startedAt,
    revision: Math.max(1, Number(record.revision || 1)),
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

function consumeFallbackCompletionNotices(config, options = {}) {
  const noticeScope = String(options.noticeScope || '').trim();
  const workspace = String(options.workspace || '').trim();
  if (!config || !noticeScope || !workspace) return [];
  const file = completionNoticeFile(config, noticeScope, workspace);
  const notices = readCompletionNoticeFile(file)
    .filter(notice => completionNoticeFresh(notice, options.now || Date.now));
  if (!notices.length) {
    try { fs.rmSync(file, { force: true }); } catch {}
    return [];
  }
  const limit = Math.min(MAX_COMPLETION_NOTICES, Math.max(1, Number(options.limit || MAX_COMPLETION_NOTICES)));
  const delivered = notices.slice(0, limit);
  const remaining = notices.slice(delivered.length);
  if (remaining.length) writeCompletionNoticeFile(file, remaining);
  else {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  return delivered;
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

function enqueueFallbackCompletionNotice(config, record) {
  if (!config || !record || record.status === FALLBACK_EXECUTION_STATUS.RUNNING) return;
  const noticeScope = String(record.noticeScope || '').trim();
  const workspace = String(record.workspace || '').trim();
  if (!noticeScope || !workspace || !record.operationId) return;
  const file = completionNoticeFile(config, noticeScope, workspace);
  const existing = readCompletionNoticeFile(file)
    .filter(notice => completionNoticeFresh(notice));
  const notice = fallbackCompletionNotice(record);
  const notices = [...existing.filter(item => item.operationId !== notice.operationId), notice]
    .sort((left, right) => Date.parse(left.completedAt || '') - Date.parse(right.completedAt || ''))
    .slice(-MAX_COMPLETION_NOTICES);
  writeCompletionNoticeFile(file, notices);
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

function completionNoticeFresh(notice, now = Date.now) {
  const completed = Date.parse(String(notice?.completedAt || ''));
  return Number.isFinite(completed) && timeValue(now) - completed <= FALLBACK_RECORD_TTL_MS;
}

function recoverPersistedFallback(config, reference, now = Date.now) {
  const persisted = readPersistedFallback(config, reference);
  if (!persisted) return null;
  if (persisted.status !== FALLBACK_EXECUTION_STATUS.RUNNING) return persisted;
  const timestamp = timeValue(now);
  const interrupted = {
    ...persisted,
    status: FALLBACK_EXECUTION_STATUS.INTERRUPTED,
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
    signature: String(record.signature || ''),
    status: String(record.status || ''),
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
    signature: record.signature,
    status: record.status,
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

function readPersistedFallback(config, reference) {
  const id = String(reference || '').trim();
  try {
    if (id.startsWith('fallback_')) {
      return readJsonFile(tasklessFallbackFile(config, id), {
        validate: value => Boolean(value && typeof value === 'object' && value.operationId === id)
      });
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

function persistFallbackSnapshot(config, record) {
  try {
    if (record.workId) {
      recordTaskBackgroundOperation(config, record.workId, record);
      return;
    }
    const file = tasklessFallbackFile(config, record.operationId);
    const sanitized = sanitizeTaskRecord({ status: 'planning', backgroundOperation: record })?.backgroundOperation || {};
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
    try { fs.rmSync(entry.file, { force: true }); } catch {}
  });
}

function settleRecord(record, status, now = Date.now) {
  const completedAtMs = timeValue(now);
  record.status = status;
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
  const executionKey = String(record.executionKey || record.workId || record.operationId || '').trim();
  if (executionKey && executionsByWorkId.get(executionKey) === record) executionsByWorkId.delete(executionKey);
}

function timeValue(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function fallbackSignature(tool, args = {}) {
  return crypto.createHash('sha256').update(stableJson([String(tool || ''), args])).digest('base64url');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function resetFallbackExecutions() {
  executionsByWorkId.clear();
  executionsByOperationId.clear();
}

export {
  DEFAULT_FALLBACK_GRACE_MS,
  acknowledgeFallbackCompletionNotice,
  acknowledgeFallbackDelivery,
  cancelFallbackExecution,
  consumeFallbackCompletionNotices,
  enableFallbackCompletionNotice,
  fallbackExecutionStatus,
  fallbackSignature,
  resetFallbackExecutions,
  startFallbackExecution
};
