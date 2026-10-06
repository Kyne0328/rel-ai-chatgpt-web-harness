import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import type { TaskDto } from './contracts/tasks.ts';
import { getStateDir } from './statePaths.js';
import { setStateMeta, stateMetaValue, withStateDatabase } from './stateDatabase.ts';
import { TASK_HISTORY_EVENT_SEARCH_SCHEMA_SQL } from './taskHistoryProjectionSchema.ts';
import { normalizeTaskProgress, sanitizeTaskRecord } from './taskObservability.js';
import { canonicalizeActivityEvents } from './taskEventIdentity.js';
import { upsertTaskHistorySession } from './taskHistoryPersistence.ts';

const MAX_HISTORY_QUERY_SESSIONS = 500;
const MAX_HISTORY_PAGE_SIZE = 500;
const TASK_HISTORY_RETENTION_DAYS = 180;
const TASK_HISTORY_STORAGE_BUDGET_BYTES = 1024 * 1024 * 1024;
const TASK_HISTORY_VERSION = 3;
const HISTORY_FORMAT_MARKER = '.task-history-v3';
const LEGACY_MIGRATION_KEY = 'task_history_legacy_migrated_v1';
const migratedStateDirs = new Set<string>();
let writeWorker: Worker | null = null;
let writeRequestSequence = 0;
const pendingWriteRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
let storageMetrics = { writes: 0, bytes: 0, durationMs: 0 };

type TaskHistoryConfig = Record<string, unknown> & { stateDir?: string };
type StoredTaskSession = TaskDto & Record<string, any>;

interface TaskHistoryRow {
  id: string;
  payload: string;
  updated_at_ms?: number;
}

interface TaskHistoryEventRow {
  id: string;
  workspace?: string;
  task_id?: string;
  session_id?: string;
  event_timestamp?: string;
  task_updated_at_ms?: number;
  event_index?: number;
  payload: string;
}

interface SessionPageCursor {
  updatedAtMs: number;
  id: string;
}

interface SessionPageOptions {
  includeCursors?: boolean;
  limit?: number;
  cursor?: SessionPageCursor | null;
  workspace?: string;
  principalFingerprint?: string;
}

interface EventPageCursor {
  eventTimestamp: string;
  taskUpdatedAtMs: number;
  taskId: string;
  eventIndex: number;
}

interface EventPageOptions {
  includeCursors?: boolean;
  limit?: number;
  cursor?: EventPageCursor | null;
  taskId?: string;
  workspace?: string;
  principalFingerprint?: string;
}

interface TaskHistoryRetentionOptions {
  retentionDays?: number;
  storageBudgetBytes?: number;
  nowMs?: number;
  timeoutMs?: number;
}

interface SessionTextSearchOptions {
  limit?: number;
  workspace?: string;
  excludeWorkspace?: string;
}

function getTaskHistoryDir(config: TaskHistoryConfig = {}): string {
  return path.join(getStateDir(config), 'sessions');
}

function configForDirectory(directory: string): TaskHistoryConfig {
  return { stateDir: path.dirname(path.resolve(directory)) };
}

function ensureCurrentHistory(config: TaskHistoryConfig = {}): void {
  migrateLegacyTaskHistory(config);
}

function listSessions(directory: string, limit = MAX_HISTORY_QUERY_SESSIONS): StoredTaskSession[] {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare('SELECT id,updated_at_ms,payload FROM task_history ORDER BY updated_at_ms DESC,id ASC LIMIT ?')
      .all(Math.max(0, Math.floor(Number(limit) || 0))) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows);
  }, { transaction: true }) as StoredTaskSession[];
}

function listSessionSummaries(directory: string, limit = MAX_HISTORY_QUERY_SESSIONS): StoredTaskSession[] {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  const invalid: string[] = [];
  const sessions = withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare(`
      SELECT id,updated_at_ms,payload
      FROM task_history_summaries
      ORDER BY updated_at_ms DESC,id ASC
      LIMIT ?
    `).all(Math.max(0, Math.floor(Number(limit) || 0))) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows, true, invalid);
  }, { readonly: true }) as StoredTaskSession[];
  removeInvalidSessions(config, invalid);
  return sessions;
}

function findSessionsContaining(directory: string, values: unknown, options: SessionTextSearchOptions = {}): StoredTaskSession[] {
  const needles = [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').replace(/\p{Cc}+/gu, ' ').trim().toLowerCase())
    .filter(value => value.length >= 4)
    .map(value => value.slice(0, 500)))]
    .slice(0, 12);
  if (!needles.length) return [];
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    ensureTaskHistoryEventSearchProjection(db);
    const needleFilters = needles.map(() => `(
      instr(lower(summary.payload), ?) > 0
      OR instr(lower(summary.id), ?) > 0
      OR EXISTS (
        SELECT 1 FROM task_history_event_search AS event
        WHERE event.task_id = summary.id
          AND (
            instr(event.search_text, ?) > 0
            OR instr(lower(event.event_key), ?) > 0
            OR instr(lower(event.session_id), ?) > 0
          )
      )
    )`);
    const filters = [`(${needleFilters.join(' OR ')})`];
    const parameters: Array<string | number> = [];
    for (const needle of needles) parameters.push(needle, needle, needle, needle, needle);
    const workspace = String(options.workspace || '').trim();
    const excludeWorkspace = String(options.excludeWorkspace || '').trim();
    if (workspace) {
      filters.push('summary.workspace = ?');
      parameters.push(workspace);
    } else if (excludeWorkspace) {
      filters.push('summary.workspace <> ?');
      parameters.push(excludeWorkspace);
    }
    const limit = Math.min(MAX_HISTORY_QUERY_SESSIONS, Math.max(1, Math.floor(Number(options.limit) || 40)));
    parameters.push(limit);
    const rows = db.prepare(`
      WITH candidates AS (
        SELECT summary.id, summary.updated_at_ms
        FROM task_history_summaries AS summary
        WHERE ${filters.join(' AND ')}
        ORDER BY summary.updated_at_ms DESC, summary.id ASC
        LIMIT ?
      )
      SELECT history.id, history.updated_at_ms, history.payload
      FROM candidates
      JOIN task_history AS history ON history.id = candidates.id
      ORDER BY candidates.updated_at_ms DESC, candidates.id ASC
    `).all(...parameters) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows);
  }, { transaction: true }) as StoredTaskSession[];
}

function findConversationSessions(directory: string, workspace: string, conversationId: string, limit = 24): StoredTaskSession[] {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare(`SELECT id,updated_at_ms,payload FROM task_history_summaries
      WHERE workspace=? AND conversation_id=? ORDER BY updated_at_ms DESC,id ASC LIMIT ?`)
      .all(workspace, conversationId, Math.min(MAX_HISTORY_QUERY_SESSIONS, Math.max(1, Math.floor(limit)))) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows, true);
  }, { readonly: true }) as StoredTaskSession[];
}

function listSessionSummaryPage(directory: string, options: SessionPageOptions = {}): { items: StoredTaskSession[]; cursor: SessionPageCursor | null; hasMore: boolean } {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const pageSize = Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(Number(options.limit) || 100)));
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    const workspace = String(options.workspace || '').trim();
    if (workspace) {
      filters.push('workspace = ?');
      parameters.push(workspace);
    }
    if (options.principalFingerprint !== undefined) {
      filters.push("COALESCE(json_extract(payload, '$.principalFingerprint'), '') = ?");
      parameters.push(String(options.principalFingerprint));
    }
    const cursorUpdatedAtMs = Math.max(0, Math.floor(Number(options.cursor?.updatedAtMs || 0)));
    const cursorId = String(options.cursor?.id || '').trim();
    if (cursorUpdatedAtMs && cursorId) {
      filters.push('(updated_at_ms < ? OR (updated_at_ms = ? AND id > ?))');
      parameters.push(cursorUpdatedAtMs, cursorUpdatedAtMs, cursorId);
    }
    parameters.push(pageSize + 1);
    const rows = db.prepare(`
      SELECT id,updated_at_ms,payload FROM task_history_summaries
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY updated_at_ms DESC,id ASC
      LIMIT ?
    `).all(...parameters) as unknown as TaskHistoryRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const items = parseSessionRows(db, pageRows, true).map(session => ({
      ...session, events: [],
      ...(options.includeCursors ? { _pageCursor: { updatedAtMs: Number(session.historyUpdatedAtMs || 0), id: String(session.id || '') } } : {})
    }));
    const last = pageRows.at(-1);
    return {
      items,
      cursor: last ? { updatedAtMs: Number(last.updated_at_ms || 0), id: String(last.id || '') } : null,
      hasMore
    };
  }, { readonly: true }) as { items: StoredTaskSession[]; cursor: SessionPageCursor | null; hasMore: boolean };
}

function listRecentSessionEvents(directory: string, limit = MAX_HISTORY_QUERY_SESSIONS): Record<string, any>[] {
  return listRecentSessionEventPage(directory, { limit }).items;
}

function listRecentSessionEventPage(directory: string, options: EventPageOptions = {}): { items: Record<string, any>[]; cursor: EventPageCursor | null; hasMore: boolean } {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const pageSize = Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(Number(options.limit) || 100)));
    const filters: string[] = [];
    const parameters: Array<string | number> = [];
    const taskIdFilter = String(options.taskId || '').trim();
    if (taskIdFilter) {
      filters.push('task_id = ?');
      parameters.push(taskIdFilter);
    }
    if (options.workspace !== undefined || options.principalFingerprint !== undefined) {
      const scope = ['scope.id = task_history_events.task_id'];
      if (options.workspace !== undefined) {
        scope.push('scope.workspace = ?');
        parameters.push(String(options.workspace));
      }
      if (options.principalFingerprint !== undefined) {
        scope.push("COALESCE(json_extract(scope.payload, '$.principalFingerprint'), '') = ?");
        parameters.push(String(options.principalFingerprint));
      }
      filters.push(`EXISTS (SELECT 1 FROM task_history_summaries AS scope WHERE ${scope.join(' AND ')})`);
    }
    const cursor = options.cursor;
    const eventTimestamp = String(cursor?.eventTimestamp || '').trim();
    const taskUpdatedAtMs = Math.max(0, Math.floor(Number(cursor?.taskUpdatedAtMs || 0)));
    const taskId = String(cursor?.taskId || '').trim();
    const eventIndex = Math.floor(Number(cursor?.eventIndex ?? -1));
    if (eventTimestamp && taskUpdatedAtMs && taskId && eventIndex >= 0) {
      filters.push(`(
        event_timestamp < ?
        OR (event_timestamp = ? AND task_updated_at_ms < ?)
        OR (event_timestamp = ? AND task_updated_at_ms = ? AND task_id > ?)
        OR (event_timestamp = ? AND task_updated_at_ms = ? AND task_id = ? AND event_index < ?)
      )`);
      parameters.push(
        eventTimestamp,
        eventTimestamp, taskUpdatedAtMs,
        eventTimestamp, taskUpdatedAtMs, taskId,
        eventTimestamp, taskUpdatedAtMs, taskId, eventIndex
      );
    }
    parameters.push(pageSize + 1);
    const rows = db.prepare(`
      SELECT
        task_id AS id,
        workspace,
        session_id,
        event_timestamp,
        task_updated_at_ms,
        event_index,
        payload
      FROM task_history_events
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY
        event_timestamp DESC,
        task_updated_at_ms DESC,
        task_id ASC,
        event_index DESC
      LIMIT ?
    `).all(...parameters) as unknown as TaskHistoryEventRow[];
    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const items = pageRows.flatMap(row => {
      try {
        const event = JSON.parse(String(row.payload || '')) as Record<string, any>;
        if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
        return [{
          ...event,
          workspace: event.workspace || row.workspace || '',
          taskId: event.taskId || row.task_id || row.id,
          sessionId: event.sessionId || row.session_id || row.id,
          ...(options.includeCursors ? { _pageCursor: {
            eventTimestamp: String(row.event_timestamp || ''), taskUpdatedAtMs: Number(row.task_updated_at_ms || 0),
            taskId: String(row.task_id || row.id || ''), eventIndex: Number(row.event_index || 0)
          } } : {})
        }];
      } catch {
        return [];
      }
    });
    const last = pageRows.at(-1);
    return {
      items,
      cursor: last ? {
        eventTimestamp: String(last.event_timestamp || ''),
        taskUpdatedAtMs: Number(last.task_updated_at_ms || 0),
        taskId: String(last.task_id || last.id || ''),
        eventIndex: Number(last.event_index || 0)
      } : null,
      hasMore
    };
  }, { readonly: true }) as { items: Record<string, any>[]; cursor: EventPageCursor | null; hasMore: boolean };
}

function parseSessionRows(db: DatabaseSync, rows: TaskHistoryRow[], readonly = false, invalidRows?: string[]): StoredTaskSession[] {
  const sessions: StoredTaskSession[] = [];
  const invalid: string[] = [];
  for (const row of rows) {
    const session = parseStoredSession(row.payload);
    if (session) sessions.push({ ...session, historyUpdatedAtMs: Number(row.updated_at_ms || 0) });
    else invalid.push(String(row.id));
  }
  if (invalid.length && !readonly) {
    const remove = db.prepare('DELETE FROM task_history WHERE id=?');
    for (const id of invalid) remove.run(id);
  }
  if (readonly) invalidRows?.push(...invalid);
  return sessions;
}

function removeInvalidSessions(config: TaskHistoryConfig, ids: string[]): void {
  if (!ids.length) return;
  // Corrupt-row cleanup is exceptional. Do it after closing the reader, and
  // fail fast if a writer is busy so valid dashboard reads remain available.
  try {
    withStateDatabase(config, (db: DatabaseSync) => {
      const remove = db.prepare('DELETE FROM task_history WHERE id=?');
      for (const id of ids) remove.run(id);
    }, { transaction: true });
  } catch {}
}

function readSession(directory: string, id: unknown): StoredTaskSession | null {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  let invalid = false;
  const session = withStateDatabase(config, (db: DatabaseSync) => {
    const row = db.prepare('SELECT payload FROM task_history WHERE id=?').get(String(id || '')) as Pick<TaskHistoryRow, 'payload'> | undefined;
    if (!row) return null;
    const session = parseStoredSession(row.payload);
    if (session) return session;
    invalid = true;
    return null;
  }, { readonly: true }) as StoredTaskSession | null;
  if (invalid) removeInvalidSessions(config, [String(id || '')]);
  return session;
}

function removeSession(directory: string, id: unknown): void {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  withStateDatabase(config, (db: DatabaseSync) => {
    db.prepare('DELETE FROM task_history WHERE id=?').run(String(id || ''));
  }, { transaction: true });
}

function ensureTaskHistoryEventSearchProjection(db: DatabaseSync): void {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_history_event_search'").get();
  if (!exists) db.exec(TASK_HISTORY_EVENT_SEARCH_SCHEMA_SQL);
}

function removeWorkspaceSessions(config: TaskHistoryConfig = {}, workspaceValue: unknown): string[] {
  const workspace = String(workspaceValue || '').trim();
  if (!workspace) return [];
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare('SELECT id FROM task_history_summaries WHERE workspace=?').all(workspace) as unknown as Array<{ id: string }>;
    const removed: string[] = [];
    const remove = db.prepare('DELETE FROM task_history WHERE id=?');
    for (const row of rows) {
      remove.run(String(row.id));
      removed.push(String(row.id));
    }
    return removed;
  }, { transaction: true }) as string[];
}

function normalizeStoredSession(session: unknown, { forWrite = false }: { forWrite?: boolean } = {}): StoredTaskSession | null {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  const input = session as Record<string, any>;
  const id = String(input.id || '').trim();
  if (!id) return null;
  if (!forWrite) {
    if (Number(input.version || 0) !== TASK_HISTORY_VERSION) return null;
    if (String(input.taskId || '') !== id || String(input.sessionId || '') !== id) return null;
  }
  const current = forWrite
    ? { ...input, id, taskId: id, sessionId: id, version: TASK_HISTORY_VERSION }
    : input;
  const sanitized = sanitizeTaskRecord(current) as StoredTaskSession | null;
  if (!sanitized) return null;
  const resultSummary = sanitized.resultSummary
    || (sanitized.status === 'completed' ? sanitized.summary || '' : '');
  return {
    ...sanitized,
    events: canonicalizeActivityEvents(Array.isArray(sanitized.events) ? sanitized.events : [], { source: `task-history:${sanitized.workspace || ''}:${id}` }),
    ...(resultSummary ? { resultSummary } : {}),
    progress: normalizeTaskProgress(sanitized.progress, sanitized.status)
  } as StoredTaskSession;
}

function writeSession(directory: string, session: StoredTaskSession | Record<string, any>): void {
  if (!session?.id) return;
  const sanitized = normalizeStoredSession(session, { forWrite: true });
  if (!sanitized) throw new Error('Task history writes require a current session record.');
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  const started = Date.now();
  const result = withStateDatabase(config, (db: DatabaseSync) => upsertTaskHistorySession(db, sanitized), { transaction: true });
  recordStorageWrite(Number(result?.bytes || 0), Date.now() - started);
}

async function writeSessionAsync(directory: string, session: StoredTaskSession | Record<string, any>): Promise<void> {
  if (!session?.id) return;
  const sanitized = normalizeStoredSession(session, { forWrite: true });
  if (!sanitized) throw new Error('Task history writes require a current session record.');
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  await enqueueWorkerWrite(config, sanitized);
}

function pruneSessions(directory: string, options: TaskHistoryRetentionOptions = {}): void {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  const retentionDays = Math.max(1, Math.floor(Number(options.retentionDays || TASK_HISTORY_RETENTION_DAYS)));
  const storageBudgetBytes = Math.max(0, Math.floor(Number(options.storageBudgetBytes ?? TASK_HISTORY_STORAGE_BUDGET_BYTES)));
  const nowMs = Math.max(0, Math.floor(Number(options.nowMs || Date.now())));
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  withStateDatabase(config, (db: DatabaseSync) => {
    const prunedIds: string[] = [];
    const removeHistory = db.prepare('DELETE FROM task_history WHERE id=?');
    const expired = db.prepare(`SELECT id FROM task_history_summaries
      WHERE updated_at_ms < ? AND status IN ('completed','failed','cancelled','invalid')
      ORDER BY updated_at_ms ASC,id DESC
    `).all(cutoffMs) as unknown as Array<{ id: string }>;
    for (const row of expired) {
      const taskId = String(row.id || '');
      if (!taskId) continue;
      removeHistory.run(taskId);
      prunedIds.push(taskId);
    }

    let retainedBytes = taskHistoryStorageBytes(db);
    if (retainedBytes > storageBudgetBytes) {
      const candidates = db.prepare(`
        SELECT history.id,
          length(CAST(history.payload AS BLOB)) + COALESCE(SUM(length(CAST(events.payload AS BLOB))), 0) AS bytes
        FROM task_history AS history
        LEFT JOIN task_history_events AS events ON events.task_id=history.id
        WHERE CASE
          WHEN json_valid(history.payload) THEN lower(COALESCE(json_extract(history.payload, '$.status'), '')) IN ('completed','failed','cancelled')
          ELSE 1
        END
        GROUP BY history.id,history.updated_at_ms
        ORDER BY history.updated_at_ms ASC,history.id DESC
      `).all() as unknown as Array<{ id: string; bytes?: number }>;
      for (const candidate of candidates) {
        if (retainedBytes <= storageBudgetBytes) break;
        const taskId = String(candidate.id || '');
        if (!taskId) continue;
        removeHistory.run(taskId);
        prunedIds.push(taskId);
        retainedBytes = Math.max(0, retainedBytes - Math.max(0, Number(candidate.bytes || 0)));
      }
    }
    retireObsoleteTaskIntegrity(db, [...new Set(prunedIds)]);
  }, { transaction: true, timeoutMs: options.timeoutMs ?? 0 });
}

function taskHistoryStorageBytes(db: DatabaseSync): number {
  const usage = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM task_history_storage_usage').get() as { bytes?: unknown } | undefined;
  return Math.max(0, Number(usage?.bytes || 0));
}

function pruneSessionsAsync(directory: string): Promise<void> {
  return enqueueWorkerRequest(configForDirectory(directory), { action: 'prune', directory });
}

function retireObsoleteTaskIntegrity(db: DatabaseSync, prunedTaskIds: string[]): void {
  const protectedTasks = workspaceOwnershipTaskIds(db);
  const removeIntegrity = db.prepare('DELETE FROM task_integrity_tasks WHERE task_id=?');
  for (const taskId of prunedTaskIds) {
    if (!protectedTasks.has(taskId)) removeIntegrity.run(taskId);
  }

  const orphaned = db.prepare(`
    SELECT integrity.task_id,integrity.payload
    FROM task_integrity_tasks AS integrity
    LEFT JOIN task_history AS history ON history.id=integrity.task_id
    WHERE history.id IS NULL
  `).all() as unknown as Array<{ task_id: string; payload: string }>;
  for (const row of orphaned) {
    const taskId = String(row.task_id || '');
    if (!taskId || protectedTasks.has(taskId) || !terminalIntegrityPayload(row.payload)) continue;
    removeIntegrity.run(taskId);
  }
}

function workspaceOwnershipTaskIds(db: DatabaseSync): Set<string> {
  const owners = new Set<string>();
  const rows = db.prepare('SELECT payload FROM workspace_integrity').all() as unknown as Array<{ payload: string }>;
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload || '{}'));
      const uncommittedOwners = payload?.uncommittedOwners;
      if (!uncommittedOwners || typeof uncommittedOwners !== 'object' || Array.isArray(uncommittedOwners)) continue;
      for (const values of Object.values(uncommittedOwners)) {
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          const owner = String(value || '').trim();
          if (owner && owner !== '@ambient') owners.add(owner);
        }
      }
    } catch {}
  }
  return owners;
}

function terminalIntegrityPayload(value: unknown): boolean {
  try {
    const payload = JSON.parse(String(value || '{}'));
    return Boolean(String(payload?.completedAt || '').trim() || String(payload?.cancelledAt || '').trim());
  } catch {
    return false;
  }
}

function clearTaskHistory(config: TaskHistoryConfig = {}): void {
  migrateLegacyTaskHistory(config);
  withStateDatabase(config, (db: DatabaseSync) => db.exec('DELETE FROM task_history'), { transaction: true });
  removeLegacyHistoryFiles(config);
}

function parseStoredSession(payload: unknown): StoredTaskSession | null {
  try {
    return normalizeStoredSession(JSON.parse(String(payload || '')) as unknown);
  } catch {
    return null;
  }
}

function migrateLegacyTaskHistory(config: TaskHistoryConfig = {}): void {
  let stateKey = '';
  try {
    stateKey = path.resolve(getStateDir(config));
  } catch {
    stateKey = '';
  }
  if (stateKey && migratedStateDirs.has(stateKey)) return;
  let migrated = false;
  withStateDatabase(config, (db: DatabaseSync) => {
    if (stateMetaValue(db, LEGACY_MIGRATION_KEY, '') === '1') return;
    const directory = getTaskHistoryDir(config);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(directory, entry.name);
      try {
        const source = fs.readFileSync(file, 'utf8');
        const session = normalizeStoredSession(JSON.parse(source) as unknown);
        if (!session) continue;
        let mtimeMs = Date.now();
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
        upsertTaskHistorySession(db, session, mtimeMs);
      } catch {}
    }
    setStateMeta(db, LEGACY_MIGRATION_KEY, '1');
    migrated = true;
  }, { transaction: true });
  if (stateKey) migratedStateDirs.add(stateKey);
  if (migrated) removeLegacyHistoryFiles(config);
}

/**
 * Keep a small, indexed projection of retained activity events. Dashboard
 * reads should never have to expand every task's JSON timeline just to find
 * the newest rows. Triggers keep the projection in sync for both the service
 * process and the task-history storage worker.
 */
function removeLegacyHistoryFiles(config: TaskHistoryConfig = {}): void {
  const directory = getTaskHistoryDir(config);
  try {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('-policy.json')) continue;
      try { fs.rmSync(path.join(directory, entry.name), { force: true }); } catch {}
    }
    try { fs.rmdirSync(directory); } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
    }
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  try { fs.rmSync(path.join(getStateDir(config), HISTORY_FORMAT_MARKER), { force: true }); } catch {}
}

function resetTaskHistoryCaches(): void {
  migratedStateDirs.clear();
}

function taskHistoryStorageMetricsSnapshot(): { writes: number; bytes: number; durationMs: number } {
  return { ...storageMetrics };
}

function resetTaskHistoryStorageMetrics(): void {
  storageMetrics = { writes: 0, bytes: 0, durationMs: 0 };
}

function enqueueWorkerWrite(config: TaskHistoryConfig, session: StoredTaskSession): Promise<void> {
  return enqueueWorkerRequest(config, { action: 'write', session });
}

function enqueueWorkerRequest(config: TaskHistoryConfig, payload: Record<string, unknown>): Promise<void> {
  const worker = ensureWriteWorker();
  const id = ++writeRequestSequence;
  worker.ref();
  return new Promise((resolve, reject) => {
    pendingWriteRequests.set(id, { resolve, reject });
    worker.postMessage({ ...payload, id, stateDir: getStateDir(config) });
  });
}

function ensureWriteWorker(): Worker {
  if (writeWorker) return writeWorker;
  const worker = new Worker(new URL('./taskHistoryStorageWorker.js', import.meta.url));
  writeWorker = worker;
  worker.on('message', message => settleWorkerWrite(worker, message));
  worker.on('error', error => failWriteWorker(worker, error));
  worker.on('exit', code => {
    if (writeWorker !== worker) return;
    failWriteWorker(worker, new Error(`Task history storage worker exited with code ${code}.`));
  });
  worker.unref();
  return worker;
}

function settleWorkerWrite(worker: Worker, message: Record<string, any>): void {
  const id = Number(message?.id || 0);
  const pending = pendingWriteRequests.get(id);
  if (!pending) return;
  pendingWriteRequests.delete(id);
  if (message.ok === true) {
    if (message.action !== 'prune') recordStorageWrite(Number(message.bytes || 0), Number(message.durationMs || 0));
    pending.resolve();
  } else {
    const error = new Error(String(message.error?.message || 'Task history write failed.')) as Error & { code?: string };
    if (message.error?.code) error.code = String(message.error.code);
    pending.reject(error);
  }
  if (pendingWriteRequests.size === 0 && writeWorker === worker) worker.unref();
}

function failWriteWorker(worker: Worker, error: unknown): void {
  if (writeWorker === worker) writeWorker = null;
  const failure = error instanceof Error ? error : new Error(String(error || 'Task history storage worker failed.'));
  for (const pending of pendingWriteRequests.values()) pending.reject(failure);
  pendingWriteRequests.clear();
  try { worker.unref(); } catch {}
}

function recordStorageWrite(bytes: number, durationMs: number): void {
  storageMetrics.writes += 1;
  storageMetrics.bytes += Math.max(0, Number(bytes || 0));
  storageMetrics.durationMs += Math.max(0, Number(durationMs || 0));
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}

export {
  MAX_HISTORY_QUERY_SESSIONS,
  clearTaskHistory,
  ensureCurrentHistory,
  findSessionsContaining,
  findConversationSessions,
  getTaskHistoryDir,
  listRecentSessionEventPage,
  listRecentSessionEvents,
  listSessionSummaries,
  listSessionSummaryPage,
  listSessions,
  pruneSessions,
  pruneSessionsAsync,
  readSession,
  removeSession,
  removeWorkspaceSessions,
  resetTaskHistoryCaches,
  resetTaskHistoryStorageMetrics,
  taskHistoryStorageMetricsSnapshot,
  writeSession,
  writeSessionAsync
};

export type { EventPageCursor, SessionPageCursor, StoredTaskSession, TaskHistoryConfig };
