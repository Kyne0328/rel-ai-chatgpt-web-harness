import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DatabasePersistenceResult } from './contracts/persistence.ts';
import { statePath } from './stateLayout.js';
import { TASK_HISTORY_PROJECTION_SCHEMA_SQL } from './taskHistoryProjectionSchema.ts';
import {
  assertSqliteIntegrity,
  checkpointSqlite,
  createSqliteBackup,
  isSqliteCorruptionError,
  isSqliteValidationCurrent,
  restoreSqliteBackup,
  sqliteBackupPath,
  writeSqliteValidationStamp
} from './sqliteDurability.ts';

// Extensions are additive to the schema-2 contract shipped in 1.1.3.
// Keep its compatibility marker stable so installing that release remains safe.
const STATE_SCHEMA_VERSION = 2;
const STATE_EXTENSION_VERSION = 6;
const MAX_LEGACY_SCHEMA_VERSION = 5;
const STATE_VALIDATION_KEY = `state-v${STATE_SCHEMA_VERSION}-extensions-${STATE_EXTENSION_VERSION}`;

interface StateDatabaseConfig extends Record<string, unknown> {
  stateDir?: string;
}

interface OpenStateDatabaseOptions {
  readonly?: boolean;
  timeoutMs?: number;
}

interface WithStateDatabaseOptions<TMissing = undefined> extends OpenStateDatabaseOptions {
  missingValue?: TMissing;
  transaction?: boolean;
}

interface StateMigration {
  version: number;
  apply(db: DatabaseSync): void;
}

const META_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS state_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

const SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS task_history(
  id TEXT PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS task_history_updated_idx
  ON task_history(updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS session_policies(
  workspace TEXT NOT NULL,
  task_id TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(workspace, task_id)
) STRICT;
CREATE INDEX IF NOT EXISTS session_policies_workspace_idx
  ON session_policies(workspace, updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS analytics_months(
  month TEXT PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
`;

const SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS task_integrity_tasks(
  task_id TEXT PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS task_integrity_tasks_updated_idx
  ON task_integrity_tasks(updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS workspace_integrity(
  workspace TEXT PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS workspace_integrity_updated_idx
  ON workspace_integrity(updated_at_ms DESC);
`;

const SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS analytics_counter_state(
  month TEXT PRIMARY KEY,
  source_updated_at_ms INTEGER NOT NULL,
  dirty INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS analytics_counter_rows(
  month TEXT NOT NULL,
  bucket TEXT NOT NULL,
  kind TEXT NOT NULL,
  dimension_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(month,bucket,kind,dimension_key)
) STRICT;
CREATE INDEX IF NOT EXISTS analytics_counter_rows_month_idx
  ON analytics_counter_rows(month,bucket,kind);
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
INSERT INTO state_meta(key,value) VALUES('task_history_event_index_v1','1')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
`;

const SCHEMA_V5_SQL = `
DROP TRIGGER IF EXISTS task_history_events_after_insert;
DROP TRIGGER IF EXISTS task_history_events_after_update;
DROP TRIGGER IF EXISTS task_history_events_after_delete;
CREATE INDEX IF NOT EXISTS task_history_events_task_recent_idx
  ON task_history_events(task_id,event_timestamp DESC,task_updated_at_ms DESC,event_index DESC);
DELETE FROM task_history_events;
INSERT INTO task_history_events(
  task_id,event_key,event_index,task_updated_at_ms,event_timestamp,workspace,session_id,payload
)
SELECT
  task.id,
  CASE
    WHEN COALESCE(
      NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
      NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
      NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),'')
    ) IS NOT NULL
      THEN 'id:' || COALESCE(
        NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),'')
      )
    ELSE 'snapshot-index:' || CAST(event.key AS TEXT)
  END,
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
WHERE event.type='object'
ON CONFLICT(task_id,event_key) DO UPDATE SET
  event_index=excluded.event_index,
  task_updated_at_ms=excluded.task_updated_at_ms,
  event_timestamp=excluded.event_timestamp,
  workspace=excluded.workspace,
  session_id=excluded.session_id,
  payload=excluded.payload;
CREATE TRIGGER task_history_events_after_insert
AFTER INSERT ON task_history
BEGIN
  DELETE FROM task_history_events WHERE task_id=NEW.id AND event_key LIKE 'snapshot-index:%';
  INSERT INTO task_history_events(
    task_id,event_key,event_index,task_updated_at_ms,event_timestamp,workspace,session_id,payload
  )
  SELECT
    NEW.id,
    CASE
      WHEN COALESCE(
        NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),'')
      ) IS NOT NULL
        THEN 'id:' || COALESCE(
          NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),'')
        )
      ELSE 'snapshot-index:' || CAST(event.key AS TEXT)
    END,
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
  WHERE event.type='object'
  ON CONFLICT(task_id,event_key) DO UPDATE SET
    event_index=excluded.event_index,
    task_updated_at_ms=excluded.task_updated_at_ms,
    event_timestamp=excluded.event_timestamp,
    workspace=excluded.workspace,
    session_id=excluded.session_id,
    payload=excluded.payload;
END;
CREATE TRIGGER task_history_events_after_update
AFTER UPDATE OF updated_at_ms,payload ON task_history
BEGIN
  DELETE FROM task_history_events WHERE task_id=NEW.id AND event_key LIKE 'snapshot-index:%';
  INSERT INTO task_history_events(
    task_id,event_key,event_index,task_updated_at_ms,event_timestamp,workspace,session_id,payload
  )
  SELECT
    NEW.id,
    CASE
      WHEN COALESCE(
        NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
        NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),'')
      ) IS NOT NULL
        THEN 'id:' || COALESCE(
          NULLIF(CAST(json_extract(event.value,'$.eventId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.operationId') AS TEXT),''),
          NULLIF(CAST(json_extract(event.value,'$.id') AS TEXT),'')
        )
      ELSE 'snapshot-index:' || CAST(event.key AS TEXT)
    END,
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
  WHERE event.type='object'
  ON CONFLICT(task_id,event_key) DO UPDATE SET
    event_index=excluded.event_index,
    task_updated_at_ms=excluded.task_updated_at_ms,
    event_timestamp=excluded.event_timestamp,
    workspace=excluded.workspace,
    session_id=excluded.session_id,
    payload=excluded.payload;
END;
CREATE TRIGGER task_history_events_after_delete
AFTER DELETE ON task_history
BEGIN
  DELETE FROM task_history_events WHERE task_id=OLD.id;
END;
`;

const STATE_MIGRATIONS: readonly StateMigration[] = Object.freeze([
  { version: 1, apply: (db: DatabaseSync) => db.exec(SCHEMA_V1_SQL) },
  { version: 2, apply: (db: DatabaseSync) => db.exec(SCHEMA_V2_SQL) },
  { version: 3, apply: (db: DatabaseSync) => db.exec(SCHEMA_V3_SQL) },
  // Legacy native-task tables are retained for clients installed by a downgrade.
  { version: 4, apply: () => {} },
  { version: 5, apply: (db: DatabaseSync) => db.exec(SCHEMA_V5_SQL) },
  { version: 6, apply: (db: DatabaseSync) => db.exec(TASK_HISTORY_PROJECTION_SCHEMA_SQL) }
]);

function stateDatabasePath(config: StateDatabaseConfig = {}): string {
  return statePath(config, 'durable-state.sqlite');
}

function stateDatabaseBackupPath(config: StateDatabaseConfig = {}): string {
  return sqliteBackupPath(stateDatabasePath(config));
}

function openStateDatabase(config: StateDatabaseConfig = {}, options: OpenStateDatabaseOptions = {}): DatabaseSync | null {
  const readonly = options.readonly === true;
  const file = stateDatabasePath(config);
  if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (readonly && !fs.existsSync(file)) return null;
  const timeout = Math.max(0, Math.floor(Number(options.timeoutMs ?? 0)));
  const db = new DatabaseSync(file, { readOnly: readonly, timeout });
  try {
    db.enableLoadExtension(false);
    db.exec('PRAGMA foreign_keys=ON');
    if (!readonly) {
      // Reasserting WAL requires more locking than opening an existing WAL
      // database. Only change its mode when migration actually needs it.
      const mode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined)?.journal_mode;
      if (mode?.toLowerCase() !== 'wal') db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
      ensureStateSchema(db, file);
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function withStateDatabase<TResult, TMissing = undefined>(
  config: StateDatabaseConfig,
  operation: (db: DatabaseSync) => TResult,
  options: WithStateDatabaseOptions<TMissing> = {}
): TResult | TMissing {
  const db = openStateDatabase(config, options);
  if (!db) return options.missingValue as TMissing;
  const transaction = options.transaction === true;
  try {
    if (transaction) db.exec(options.readonly === true ? 'BEGIN' : 'BEGIN IMMEDIATE');
    const result = operation(db);
    if (transaction) db.exec('COMMIT');
    return result;
  } catch (error) {
    if (transaction) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    try { db.close(); } catch {}
  }
}

function ensureStateSchema(db: DatabaseSync, file: string): void {
  db.exec(META_SCHEMA_SQL);
  const current = Number(stateMetaValue(db, 'schema_version', 0));
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`Durable state schema version '${current}' is invalid.`);
  }
  if (current > MAX_LEGACY_SCHEMA_VERSION) {
    throw new Error(`Durable state schema ${current} is newer than supported schema ${MAX_LEGACY_SCHEMA_VERSION}.`);
  }
  const extensions = Number(stateMetaValue(db, 'extension_schema_version', current));
  if (!Number.isInteger(extensions) || extensions < 0 || extensions > STATE_EXTENSION_VERSION) {
    throw new Error(`Durable state extension schema '${extensions}' is unsupported.`);
  }
  if (current === STATE_SCHEMA_VERSION && extensions === STATE_EXTENSION_VERSION) return;

  if (current > 0) createSqliteBackup(db, file, { label: 'Durable state database' });
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of STATE_MIGRATIONS) {
      if (migration.version <= extensions) continue;
      migration.apply(db);
    }
    setStateMeta(db, 'extension_schema_version', STATE_EXTENSION_VERSION);
    setStateMeta(db, 'schema_version', STATE_SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function initializeStateDatabase(config: StateDatabaseConfig = {}): DatabasePersistenceResult {
  const file = stateDatabasePath(config);
  const validated = isSqliteValidationCurrent(file, STATE_VALIDATION_KEY);
  try {
    const db = openStateDatabase(config);
    if (!db) throw new Error('Durable state database could not be opened.');
    try {
      if (!validated) assertSqliteIntegrity(db, 'Durable state database');
    } finally {
      db.close();
    }
    if (!validated) {
      try { writeSqliteValidationStamp(file, STATE_VALIDATION_KEY); } catch {}
    }
    return { ok: true, recovered: false, path: file };
  } catch (error) {
    if (!isSqliteCorruptionError(error)) throw error;
    const recovery = restoreSqliteBackup(file, { label: 'Durable state database' });
    const db = openStateDatabase(config);
    if (!db) throw new Error('Recovered durable state database could not be opened.');
    try { assertSqliteIntegrity(db, 'Durable state database'); }
    finally { db.close(); }
    try { writeSqliteValidationStamp(file, STATE_VALIDATION_KEY); } catch {}
    return { path: file, ...recovery };
  }
}

function maintainStateDatabase(config: StateDatabaseConfig = {}): DatabasePersistenceResult {
  const file = stateDatabasePath(config);
  if (!fs.existsSync(file)) return { ok: true, skipped: true, path: file };
  const db = openStateDatabase(config);
  if (!db) return { ok: true, skipped: true, path: file };
  let result: DatabasePersistenceResult;
  try {
    const checkpoint = checkpointSqlite(db, 'Durable state database');
    const integrity = assertSqliteIntegrity(db, 'Durable state database');
    const backup = createSqliteBackup(db, file, { label: 'Durable state database' });
    result = { ok: true, path: file, checkpoint, integrity, backupPath: backup.path };
  } finally {
    db.close();
  }
  try { writeSqliteValidationStamp(file, STATE_VALIDATION_KEY); } catch {}
  return result;
}

function stateMetaValue(db: DatabaseSync, key: unknown, fallback: unknown = ''): unknown {
  const row = db.prepare('SELECT value FROM state_meta WHERE key=?').get(String(key)) as Record<string, unknown> | undefined;
  return row?.value ?? fallback;
}

function setStateMeta(db: DatabaseSync, key: unknown, value: unknown): void {
  db.prepare(`INSERT INTO state_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(key), String(value));
}

export {
  initializeStateDatabase,
  maintainStateDatabase,
  openStateDatabase,
  setStateMeta,
  stateDatabaseBackupPath,
  stateDatabasePath,
  stateMetaValue,
  withStateDatabase
};
