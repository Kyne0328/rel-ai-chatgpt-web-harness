import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

import type { TaskDto } from './contracts/tasks.ts';
import { getStateDir } from './statePaths.js';
import { setStateMeta, stateMetaValue, withStateDatabase } from './stateDatabase.ts';
import { normalizeTaskProgress, sanitizeTaskRecord } from './taskObservability.js';
import { upsertTaskHistorySession } from './taskHistoryPersistence.ts';

const MAX_SESSIONS = 500;
const TASK_HISTORY_VERSION = 3;
const HISTORY_FORMAT_MARKER = '.task-history-v3';
const LEGACY_MIGRATION_KEY = 'task_history_legacy_migrated_v1';
const EVENT_INDEX_MIGRATION_KEY = 'task_history_event_index_v1';
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
  payload: string;
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

function listSessions(directory: string, limit = MAX_SESSIONS): StoredTaskSession[] {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare('SELECT id,payload FROM task_history ORDER BY updated_at_ms DESC,id ASC LIMIT ?')
      .all(Math.max(0, Math.floor(Number(limit) || 0))) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows);
  }, { transaction: true }) as StoredTaskSession[];
}

function listSessionSummaries(directory: string, limit = MAX_SESSIONS): StoredTaskSession[] {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare(`
      SELECT id,
        CASE
          WHEN json_valid(payload) THEN json_set(
            json_remove(payload, '$.events', '$.workflowEvidence'),
            '$.events',
            CASE
              WHEN json_type(payload, '$.events') = 'array'
                AND json_array_length(json_extract(payload, '$.events')) = 1
                AND json_type(payload, '$.events[0]') = 'object'
                THEN json_array(json(json_extract(payload, '$.events[0]')))
              ELSE json('[]')
            END
          )
          ELSE payload
        END AS payload
      FROM task_history
      ORDER BY updated_at_ms DESC,id ASC
      LIMIT ?
    `).all(Math.max(0, Math.floor(Number(limit) || 0))) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows);
  }, { transaction: false }) as StoredTaskSession[];
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
    const filters = [`(${needles.map(() => 'instr(lower(payload), ?) > 0').join(' OR ')})`];
    const parameters: Array<string | number> = [...needles];
    const workspace = String(options.workspace || '').trim();
    const excludeWorkspace = String(options.excludeWorkspace || '').trim();
    if (workspace) {
      filters.push("COALESCE(json_extract(payload, '$.workspace'), '') = ?");
      parameters.push(workspace);
    } else if (excludeWorkspace) {
      filters.push("COALESCE(json_extract(payload, '$.workspace'), '') <> ?");
      parameters.push(excludeWorkspace);
    }
    const limit = Math.min(MAX_SESSIONS, Math.max(1, Math.floor(Number(options.limit) || 40)));
    parameters.push(limit);
    const rows = db.prepare(`SELECT id,payload FROM task_history
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at_ms DESC,id ASC
      LIMIT ?`).all(...parameters) as unknown as TaskHistoryRow[];
    return parseSessionRows(db, rows);
  }, { transaction: true }) as StoredTaskSession[];
}

function listRecentSessionEvents(directory: string, limit = MAX_SESSIONS): Record<string, any>[] {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    ensureTaskHistoryEventIndex(db);
    const rows = db.prepare(`
      SELECT
        task_id AS id,
        workspace,
        session_id,
        payload
      FROM task_history_events
      ORDER BY
        event_timestamp DESC,
        task_updated_at_ms DESC,
        task_id ASC,
        event_index DESC
      LIMIT ?
    `).all(Math.max(0, Math.floor(Number(limit) || 0))) as unknown as TaskHistoryEventRow[];
    return rows.flatMap(row => {
      try {
        const event = JSON.parse(String(row.payload || '')) as Record<string, any>;
        if (!event || typeof event !== 'object' || Array.isArray(event)) return [];
        return [{
          ...event,
          workspace: event.workspace || row.workspace || '',
          taskId: event.taskId || row.task_id || row.id,
          sessionId: event.sessionId || row.session_id || row.id
        }];
      } catch {
        return [];
      }
    });
  }, { transaction: false }) as Record<string, any>[];
}

function parseSessionRows(db: DatabaseSync, rows: TaskHistoryRow[]): StoredTaskSession[] {
  const sessions: StoredTaskSession[] = [];
  const invalid: string[] = [];
  for (const row of rows) {
    const session = parseStoredSession(row.payload);
    if (session) sessions.push(session);
    else invalid.push(String(row.id));
  }
  if (invalid.length) {
    const remove = db.prepare('DELETE FROM task_history WHERE id=?');
    for (const id of invalid) remove.run(id);
  }
  return sessions;
}

function readSession(directory: string, id: unknown): StoredTaskSession | null {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const row = db.prepare('SELECT payload FROM task_history WHERE id=?').get(String(id || '')) as Pick<TaskHistoryRow, 'payload'> | undefined;
    if (!row) return null;
    const session = parseStoredSession(row.payload);
    if (session) return session;
    db.prepare('DELETE FROM task_history WHERE id=?').run(String(id || ''));
    return null;
  }, { transaction: true }) as StoredTaskSession | null;
}

function removeSession(directory: string, id: unknown): void {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  withStateDatabase(config, (db: DatabaseSync) => {
    db.prepare('DELETE FROM task_history WHERE id=?').run(String(id || ''));
  }, { transaction: true });
}

function removeWorkspaceSessions(config: TaskHistoryConfig = {}, workspaceValue: unknown): string[] {
  const workspace = String(workspaceValue || '').trim();
  if (!workspace) return [];
  migrateLegacyTaskHistory(config);
  return withStateDatabase(config, (db: DatabaseSync) => {
    const rows = db.prepare('SELECT id,payload FROM task_history').all() as unknown as TaskHistoryRow[];
    const removed: string[] = [];
    const remove = db.prepare('DELETE FROM task_history WHERE id=?');
    for (const row of rows) {
      const session = parseStoredSession(row.payload);
      if (!session || String(session.workspace || '').trim() !== workspace) continue;
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

function pruneSessions(directory: string, limit = MAX_SESSIONS): void {
  const config = configForDirectory(directory);
  migrateLegacyTaskHistory(config);
  withStateDatabase(config, (db: DatabaseSync) => {
    const max = Math.max(0, Math.floor(Number(limit) || 0));
    const row = db.prepare('SELECT COUNT(*) AS count FROM task_history').get() as { count?: unknown } | undefined;
    const excess = Math.max(0, Number(row?.count || 0) - max);
    if (!excess) {
      retireObsoleteTaskIntegrity(db, []);
      return;
    }
    const rows = db.prepare(`SELECT id FROM task_history
      WHERE CASE
        WHEN json_valid(payload) THEN lower(COALESCE(json_extract(payload, '$.status'), '')) IN ('completed','failed','cancelled')
        ELSE 1
      END
      ORDER BY updated_at_ms ASC,id DESC
      LIMIT ?
    `).all(excess) as unknown as Array<{ id: string }>;
    const prunedIds = rows.map(row => String(row.id || '')).filter(Boolean);
    if (prunedIds.length) {
      const removeHistory = db.prepare('DELETE FROM task_history WHERE id=?');
      for (const taskId of prunedIds) removeHistory.run(taskId);
    }
    retireObsoleteTaskIntegrity(db, prunedIds);
  }, { transaction: true });
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
    ensureTaskHistoryEventIndex(db);
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
function ensureTaskHistoryEventIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_history_events(
      task_id TEXT NOT NULL,
      event_key TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      task_updated_at_ms INTEGER NOT NULL,
      event_timestamp TEXT NOT NULL,
      workspace TEXT NOT NULL,
      session_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY(task_id,event_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS task_history_events_recent_idx
      ON task_history_events(event_timestamp DESC,task_updated_at_ms DESC,task_id ASC,event_index DESC);
    CREATE TRIGGER IF NOT EXISTS task_history_events_after_insert
    AFTER INSERT ON task_history
    BEGIN
      DELETE FROM task_history_events WHERE task_id=NEW.id;
      INSERT OR REPLACE INTO task_history_events(
        task_id,event_key,event_index,task_updated_at_ms,event_timestamp,workspace,session_id,payload
      )
      SELECT
        NEW.id,
        COALESCE(
          NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),''),
          'index'
        ) || ':index:' || CAST(event.key AS TEXT),
        CAST(event.key AS INTEGER),
        NEW.updated_at_ms,
        COALESCE(
          CAST(json_extract(event.value,'$.timestamp') AS TEXT),
          CAST(json_extract(event.value,'$.ts') AS TEXT),
          CAST(json_extract(event.value,'$.at') AS TEXT),
          CAST(json_extract(event.value,'$.createdAt') AS TEXT),
          CAST(json_extract(event.value,'$.startedAt') AS TEXT),
          ''
        ),
        COALESCE(
          CAST(json_extract(event.value,'$.workspace') AS TEXT),
          CASE WHEN json_valid(NEW.payload) THEN CAST(json_extract(NEW.payload,'$.workspace') AS TEXT) END,
          ''
        ),
        COALESCE(
          CAST(json_extract(event.value,'$.sessionId') AS TEXT),
          CASE WHEN json_valid(NEW.payload) THEN CAST(json_extract(NEW.payload,'$.sessionId') AS TEXT) END,
          NEW.id
        ),
        event.value
      FROM json_each(
        CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{"events":[]}' END,
        '$.events'
      ) AS event
      WHERE event.type='object';
    END;
    CREATE TRIGGER IF NOT EXISTS task_history_events_after_update
    AFTER UPDATE OF updated_at_ms,payload ON task_history
    BEGIN
      DELETE FROM task_history_events WHERE task_id=NEW.id;
      INSERT OR REPLACE INTO task_history_events(
        task_id,event_key,event_index,task_updated_at_ms,event_timestamp,workspace,session_id,payload
      )
      SELECT
        NEW.id,
        COALESCE(
          NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),''),
          'index'
        ) || ':index:' || CAST(event.key AS TEXT),
        CAST(event.key AS INTEGER),
        NEW.updated_at_ms,
        COALESCE(
          CAST(json_extract(event.value,'$.timestamp') AS TEXT),
          CAST(json_extract(event.value,'$.ts') AS TEXT),
          CAST(json_extract(event.value,'$.at') AS TEXT),
          CAST(json_extract(event.value,'$.createdAt') AS TEXT),
          CAST(json_extract(event.value,'$.startedAt') AS TEXT),
          ''
        ),
        COALESCE(
          CAST(json_extract(event.value,'$.workspace') AS TEXT),
          CASE WHEN json_valid(NEW.payload) THEN CAST(json_extract(NEW.payload,'$.workspace') AS TEXT) END,
          ''
        ),
        COALESCE(
          CAST(json_extract(event.value,'$.sessionId') AS TEXT),
          CASE WHEN json_valid(NEW.payload) THEN CAST(json_extract(NEW.payload,'$.sessionId') AS TEXT) END,
          NEW.id
        ),
        event.value
      FROM json_each(
        CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{"events":[]}' END,
        '$.events'
      ) AS event
      WHERE event.type='object';
    END;
    CREATE TRIGGER IF NOT EXISTS task_history_events_after_delete
    AFTER DELETE ON task_history
    BEGIN
      DELETE FROM task_history_events WHERE task_id=OLD.id;
    END;
  `);
  if (stateMetaValue(db, EVENT_INDEX_MIGRATION_KEY, '') === '1') return;
  db.exec(`
    INSERT OR REPLACE INTO task_history_events(
      task_id,event_key,event_index,task_updated_at_ms,event_timestamp,workspace,session_id,payload
    )
    SELECT
      task.id,
      COALESCE(
        NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),''),
        'index'
      ) || ':index:' || CAST(event.key AS TEXT),
      CAST(event.key AS INTEGER),
      task.updated_at_ms,
      COALESCE(
        CAST(json_extract(event.value,'$.timestamp') AS TEXT),
        CAST(json_extract(event.value,'$.ts') AS TEXT),
        CAST(json_extract(event.value,'$.at') AS TEXT),
        CAST(json_extract(event.value,'$.createdAt') AS TEXT),
        CAST(json_extract(event.value,'$.startedAt') AS TEXT),
        ''
      ),
      COALESCE(
        CAST(json_extract(event.value,'$.workspace') AS TEXT),
        CASE WHEN json_valid(task.payload) THEN CAST(json_extract(task.payload,'$.workspace') AS TEXT) END,
        ''
      ),
      COALESCE(
        CAST(json_extract(event.value,'$.sessionId') AS TEXT),
        CASE WHEN json_valid(task.payload) THEN CAST(json_extract(task.payload,'$.sessionId') AS TEXT) END,
        task.id
      ),
      event.value
    FROM task_history AS task
    CROSS JOIN json_each(
      CASE WHEN json_valid(task.payload) THEN task.payload ELSE '{"events":[]}' END,
      '$.events'
    ) AS event
    WHERE event.type='object';
  `);
  setStateMeta(db, EVENT_INDEX_MIGRATION_KEY, '1');
}

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
  const worker = ensureWriteWorker();
  const id = ++writeRequestSequence;
  worker.ref();
  return new Promise((resolve, reject) => {
    pendingWriteRequests.set(id, { resolve, reject });
    worker.postMessage({ id, stateDir: getStateDir(config), session });
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
    recordStorageWrite(Number(message.bytes || 0), Number(message.durationMs || 0));
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
  MAX_SESSIONS,
  clearTaskHistory,
  ensureCurrentHistory,
  findSessionsContaining,
  getTaskHistoryDir,
  listRecentSessionEvents,
  listSessionSummaries,
  listSessions,
  pruneSessions,
  readSession,
  removeSession,
  removeWorkspaceSessions,
  resetTaskHistoryCaches,
  resetTaskHistoryStorageMetrics,
  taskHistoryStorageMetricsSnapshot,
  writeSession,
  writeSessionAsync
};

export type { StoredTaskSession, TaskHistoryConfig };
