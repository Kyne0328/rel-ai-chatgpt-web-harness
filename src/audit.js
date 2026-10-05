import { clearTaskHistory, recordTaskHistoryEvent } from './taskHistoryStore.ts';
import { recordTaskIntegrityEvent } from './taskIntegrity.ts';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateDir } from './statePaths.js';
import { ensureActivityEventIdentity } from './taskEventIdentity.js';
import { sanitizeDisplayText } from './taskObservability.js';

function getAuditPath(config = {}) {
  return config.auditLogPath || path.join(getStateDir(config), 'audit.jsonl');
}

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const READ_TAIL_BYTES = 256 * 1024;
const AUDIT_FLUSH_DELAY_MS = 50;
const AUDIT_RETRY_BASE_MS = 500;
const AUDIT_RETRY_MAX_MS = 15_000;
const MAX_PENDING_AUDIT_ENTRIES = 1000;
const auditWriteStates = new Map();
const pendingAuditOperations = new Set();

async function logAudit(config, event) {
  const auditPath = getAuditPath(config);
  const redacted = redactEvent(event || {});
  const entry = ensureActivityEventIdentity({
    ts: new Date().toISOString(),
    pid: process.pid,
    ...redacted,
    auditId: redacted.auditId || crypto.randomUUID()
  });
  const integrity = await recordTaskIntegrityEvent(config, entry);
  if (integrity) Object.assign(entry, integrity);
  enqueueAuditWrite(auditPath, entry);
  try {
    recordTaskHistoryEvent(config, entry);
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task history audit projection:', error);
  }
  return entry;
}

function safeLogAudit(config, event, options = {}) {
  const operation = (async () => {
    try {
      return await logAudit(config, event);
    } catch (error) {
      if (options.strictIntegrity === true && /^TASK_INTEGRITY_/.test(String(error?.code || ''))) throw error;
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] audit write:', error);
      return null;
    }
  })();
  pendingAuditOperations.add(operation);
  void operation.then(
    () => pendingAuditOperations.delete(operation),
    () => pendingAuditOperations.delete(operation)
  );
  return operation;
}

function enqueueAuditWrite(auditPath, entry) {
  let state = auditWriteStates.get(auditPath);
  if (!state) {
    state = {
      pending: [], inFlight: [], timer: null, promise: Promise.resolve(), clearing: false,
      retryCount: 0, lastError: '', lastFailureAt: null, droppedEntries: 0
    };
    auditWriteStates.set(auditPath, state);
  }
  if (state.clearing) return;
  state.pending.push(entry);
  trimPendingAuditEntries(state);
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushAuditState(auditPath, state);
  }, AUDIT_FLUSH_DELAY_MS);
  state.timer.unref?.();
}

function flushAuditState(auditPath, state) {
  if (!state || state.clearing || state.pending.length === 0) return state?.promise || Promise.resolve();
  const batch = state.pending.splice(0);
  state.inFlight.push(...batch);
  state.promise = state.promise
    .then(async () => {
      await fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
      await rotateIfNeededAsync(auditPath);
      await fs.promises.appendFile(auditPath, batch.map(entry => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 });
      removeInFlight(state, batch);
      state.retryCount = 0;
      state.lastError = '';
      state.lastFailureAt = null;
    })
    .catch(error => {
      removeInFlight(state, batch);
      state.pending.unshift(...batch);
      trimPendingAuditEntries(state);
      state.retryCount += 1;
      state.lastError = sanitizeDisplayText(error instanceof Error ? error.message : String(error || 'Audit persistence failed.'), 500);
      state.lastFailureAt = new Date().toISOString();
      if (process.env.REL_AI_MCP_DEBUG && (state.retryCount === 1 || state.retryCount % 10 === 0)) {
        console.error('[rel-ai-mcp] deferred audit write:', error);
      }
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      if (!state.clearing) {
        const retryDelay = Math.min(AUDIT_RETRY_MAX_MS, AUDIT_RETRY_BASE_MS * (2 ** Math.min(state.retryCount - 1, 5)));
        state.timer = setTimeout(() => {
          state.timer = null;
          void flushAuditState(auditPath, state);
        }, retryDelay);
        state.timer.unref?.();
      }
    });
  return state.promise;
}

function removeInFlight(state, batch) {
  const ids = new Set(batch.map(entry => entry.auditId));
  state.inFlight = state.inFlight.filter(entry => !ids.has(entry.auditId));
}

function trimPendingAuditEntries(state) {
  const overflow = Math.max(0, state.pending.length - MAX_PENDING_AUDIT_ENTRIES);
  if (!overflow) return;
  state.pending.splice(0, overflow);
  state.droppedEntries += overflow;
}

function auditPersistenceSnapshot(state) {
  if (!state) {
    return { healthy: true, pending: 0, retryCount: 0, droppedEntries: 0, lastError: '', lastFailureAt: null };
  }
  return {
    healthy: !state.lastError && state.droppedEntries === 0,
    pending: state.pending.length + state.inFlight.length,
    retryCount: state.retryCount,
    droppedEntries: state.droppedEntries,
    lastError: state.lastError,
    lastFailureAt: state.lastFailureAt
  };
}

async function rotateIfNeededAsync(auditPath) {
  try {
    const stat = await fs.promises.stat(auditPath);
    if (stat.size <= MAX_AUDIT_BYTES) return;
    await fs.promises.rm(`${auditPath}.1`, { force: true });
    await fs.promises.rename(auditPath, `${auditPath}.1`);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code) && process.env.REL_AI_MCP_DEBUG) {
      console.error('[rel-ai-mcp] audit rotation:', error);
    }
  }
}

async function flushAuditWrites(auditPath = '') {
  while (pendingAuditOperations.size > 0) {
    await Promise.allSettled([...pendingAuditOperations]);
  }
  const targets = auditPath
    ? [[auditPath, auditWriteStates.get(auditPath)]]
    : [...auditWriteStates.entries()];
  for (const [target, state] of targets) {
    if (!state) continue;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    await flushAuditState(target, state);
    await state.promise;
  }
}

function readAuditFileEntries(file, auditPath, tail = false) {
  const stat = fs.statSync(file);
  const start = tail ? Math.max(0, stat.size - READ_TAIL_BYTES) : 0;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(stat.size - start);
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, read);
    let offset = start > 0 ? bytes.indexOf(10) + 1 : 0;
    if (start > 0 && offset === 0) return [];
    // File identity survives normal rename-based rotation; absolute offsets
    // make full scans and bounded tails assign the same imported IDs.
    const source = `audit-file:${path.resolve(auditPath)}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const entries = [];
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline;
      const line = bytes.subarray(offset, end).toString('utf8').trim();
      if (line) {
        let entry;
        try { entry = JSON.parse(line); } catch { entry = { malformed: true, message: 'Unreadable audit entry omitted.' }; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) entry = { malformed: true, message: 'Unreadable audit entry omitted.' };
        entries.push(ensureActivityEventIdentity(entry, { source, occurrence: start + offset }));
      }
      offset = end + 1;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

function readAudit(config, options = {}) {
  const auditPath = getAuditPath(config);
  const taskId = String(options.taskId || '').trim();
  const workspace = String(options.workspace || '').trim();
  const fullScan = Boolean(options.fullScan || taskId || workspace);
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), fullScan ? 10000 : 1000);
  let persistedEntries = [];
  const files = (fullScan ? [`${auditPath}.1`, auditPath] : [auditPath]).filter(file => fs.existsSync(file));
  for (const file of files) persistedEntries.push(...readAuditFileEntries(file, auditPath, !fullScan));
  const state = auditWriteStates.get(auditPath);
  const queuedEntries = state ? [...state.inFlight, ...state.pending] : [];
  const entries = dedupeAuditEntries([...persistedEntries, ...queuedEntries])
    .filter(entry => (!taskId || entry.taskId === taskId) && (!workspace || entry.workspace === workspace))
    .slice(-limit);
  return { path: auditPath, entries, persistence: auditPersistenceSnapshot(state) };
}

function dedupeAuditEntries(entries) {
  const seen = new Set();
  return entries.filter(entry => {
    const id = String(entry?.auditId || '');
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

async function clearAuditHistory(config) {
  const auditPath = getAuditPath(config);
  const state = auditWriteStates.get(auditPath);
  if (state) {
    state.clearing = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.pending = [];
    await state.promise.catch(() => {});
    auditWriteStates.delete(auditPath);
  }
  const files = [`${auditPath}.1`, auditPath];
  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of files) {
    try {
      const stat = await fs.promises.stat(file);
      removedBytes += stat.size;
      await fs.promises.rm(file, { force: true });
      removedFiles += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  await fs.promises.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(auditPath, '', { mode: 0o600 });
  try { clearTaskHistory(config); } catch {}
  return { auditPath, removedFiles, removedBytes };
}

function redactEvent(value) {
  if (typeof value === 'string') {
    const bounded = value.length > 12000
      ? `${value.slice(0, 12000)}\n[rel-ai-mcp audit truncated ${value.length - 12000} chars]`
      : value;
    return sanitizeDisplayText(bounded, 12100);
  }
  if (Array.isArray(value)) return value.map(redactEvent);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = redactEvent(item);
    }
  }
  return out;
}

export { getAuditPath, safeLogAudit, readAudit, clearAuditHistory, flushAuditWrites };
