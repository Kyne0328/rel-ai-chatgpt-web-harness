import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { DatabasePersistenceResult } from './contracts/persistence.ts';
import { statePath } from './stateLayout.js';
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

const STATE_SCHEMA_VERSION = 2;
const STATE_VALIDATION_KEY = `state-v${STATE_SCHEMA_VERSION}`;

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
CREATE TABLE IF NOT EXISTS native_tasks(
  task_id TEXT PRIMARY KEY,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS native_tasks_updated_idx
  ON native_tasks(updated_at_ms DESC);
CREATE TABLE IF NOT EXISTS native_task_quarantine(
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  quarantined_at_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS native_task_quarantine_age_idx
  ON native_task_quarantine(quarantined_at_ms);
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

const STATE_MIGRATIONS: readonly StateMigration[] = Object.freeze([
  { version: 1, apply: db => db.exec(SCHEMA_V1_SQL) },
  { version: 2, apply: db => db.exec(SCHEMA_V2_SQL) }
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
  const timeout = Math.max(0, Math.floor(Number(options.timeoutMs ?? 5000)));
  const db = new DatabaseSync(file, { readOnly: readonly, timeout });
  try {
    db.enableLoadExtension(false);
    db.exec('PRAGMA foreign_keys=ON');
    if (!readonly) {
      db.exec('PRAGMA journal_mode=WAL');
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
    if (transaction) db.exec('BEGIN IMMEDIATE');
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
  if (current > STATE_SCHEMA_VERSION) {
    throw new Error(`Durable state schema ${current} is newer than supported schema ${STATE_SCHEMA_VERSION}.`);
  }
  if (current === STATE_SCHEMA_VERSION) return;

  if (current > 0) createSqliteBackup(db, file, { label: 'Durable state database' });
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const migration of STATE_MIGRATIONS) {
      if (migration.version <= current) continue;
      migration.apply(db);
      setStateMeta(db, 'schema_version', migration.version);
    }
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

function isSqliteBusyError(error: unknown): boolean {
  const code = errorCode(error);
  const message = errorMessage(error);
  return code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || /database is (?:busy|locked)/i.test(message)
    || /SQLITE_(?:BUSY|LOCKED)/i.test(message);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  if ('code' in error && error.code != null) return String(error.code);
  if ('errcode' in error && error.errcode != null) return String(error.errcode);
  return '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

export {
  initializeStateDatabase,
  isSqliteBusyError,
  maintainStateDatabase,
  openStateDatabase,
  setStateMeta,
  stateDatabaseBackupPath,
  stateDatabasePath,
  stateMetaValue,
  withStateDatabase
};
