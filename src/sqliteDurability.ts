import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { promoteFile } from './durableState.ts';

interface SqliteIntegrityResult {
  ok: boolean;
  messages: string[];
}

interface SqliteCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}

interface SqliteBackupOptions {
  backupPath?: string;
  label?: string;
}

interface SqliteBackupResult {
  ok: true;
  path: string;
}

interface SqliteRecoveryResult {
  ok: true;
  recovered: true;
  backupPath: string;
  corruptPath: string;
}

type CodedError = Error & {
  code: string;
  integrity?: SqliteIntegrityResult;
};

function sqliteBackupPath(file: unknown): string {
  return `${String(file)}.bak`;
}

function sqliteValidationStampPath(file: unknown): string {
  return `${String(file)}.validated.json`;
}

function isSqliteValidationCurrent(file: unknown, validationKey: unknown): boolean {
  const source = path.resolve(String(file));
  try {
    const stored = JSON.parse(fs.readFileSync(sqliteValidationStampPath(source), 'utf8')) as Record<string, unknown>;
    return Number(stored.version || 0) === 1
      && String(stored.validationKey || '') === String(validationKey || '')
      && JSON.stringify(stored.files || null) === JSON.stringify(sqliteFileSignatures(source));
  } catch {
    return false;
  }
}

function writeSqliteValidationStamp(file: unknown, validationKey: unknown): void {
  const source = path.resolve(String(file));
  if (!fs.existsSync(source)) return;
  const target = sqliteValidationStampPath(source);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      version: 1,
      validationKey: String(validationKey || ''),
      files: sqliteFileSignatures(source)
    }), { mode: 0o600 });
    promoteFile(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch {}
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function sqliteFileSignatures(file: string): Record<string, unknown> {
  return Object.fromEntries(['', '-wal', '-shm'].map(suffix => {
    const target = `${file}${suffix}`;
    try {
      const stat = fs.statSync(target);
      return [suffix || 'primary', { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }];
    } catch {
      return [suffix || 'primary', null];
    }
  }));
}

function checkSqliteIntegrity(db: DatabaseSync, options: { full?: boolean } = {}): SqliteIntegrityResult {
  const pragma = options.full === true ? 'integrity_check' : 'quick_check';
  const rows = db.prepare(`PRAGMA ${pragma}`).all() as Array<Record<string, unknown>>;
  const messages = rows.map(row => String(Object.values(row)[0] ?? '')).filter(Boolean);
  return {
    ok: messages.length === 1 && messages[0]?.toLowerCase() === 'ok',
    messages
  };
}

function assertSqliteIntegrity(db: DatabaseSync, label = 'SQLite database'): SqliteIntegrityResult {
  const result = checkSqliteIntegrity(db);
  if (result.ok) return result;
  const error = new Error(`${label} failed its integrity check: ${result.messages.join('; ') || 'unknown integrity failure'}.`) as CodedError;
  error.code = 'SQLITE_INTEGRITY_CHECK_FAILED';
  error.integrity = result;
  throw error;
}

function checkpointSqlite(db: DatabaseSync, label = 'SQLite database'): SqliteCheckpointResult {
  const row = (db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {}) as Record<string, unknown>;
  const busy = Number(row.busy || 0);
  if (busy > 0) {
    const error = new Error(`${label} could not checkpoint because ${busy} SQLite connection(s) are still busy.`) as CodedError;
    error.code = 'SQLITE_BUSY';
    throw error;
  }
  return {
    busy,
    logFrames: Number(row.log || 0),
    checkpointedFrames: Number(row.checkpointed || 0)
  };
}

function createSqliteBackup(db: DatabaseSync, file: unknown, options: SqliteBackupOptions = {}): SqliteBackupResult {
  const source = path.resolve(String(file));
  const backup = path.resolve(String(options.backupPath || sqliteBackupPath(source)));
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
  assertSqliteIntegrity(db, options.label || path.basename(source));
  const temporary = `${backup}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.rmSync(temporary, { force: true });
    db.exec(`VACUUM INTO '${escapeSqliteLiteral(temporary)}'`);
    validateSqliteFile(temporary, options.label || path.basename(source));
    try { fs.chmodSync(temporary, 0o600); } catch {}
    promoteFile(temporary, backup);
    try { fs.chmodSync(backup, 0o600); } catch {}
    return { ok: true, path: backup };
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function restoreSqliteBackup(file: unknown, options: SqliteBackupOptions = {}): SqliteRecoveryResult {
  const target = path.resolve(String(file));
  const backup = path.resolve(String(options.backupPath || sqliteBackupPath(target)));
  if (!fs.existsSync(backup)) {
    const error = new Error(`${options.label || path.basename(target)} has no recovery backup.`) as CodedError;
    error.code = 'SQLITE_BACKUP_UNAVAILABLE';
    throw error;
  }
  validateSqliteFile(backup, options.label || path.basename(target));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.recovery.tmp`;
  const corrupt = `${target}.corrupt-${Date.now()}`;
  let movedPrimary = false;
  try {
    fs.copyFileSync(backup, temporary, fs.constants.COPYFILE_EXCL);
    try { fs.chmodSync(temporary, 0o600); } catch {}
    if (fs.existsSync(target)) {
      fs.renameSync(target, corrupt);
      movedPrimary = true;
    }
    removeSqliteSidecars(target);
    fs.renameSync(temporary, target);
    validateSqliteFile(target, options.label || path.basename(target));
    try { fs.chmodSync(target, 0o600); } catch {}
    return { ok: true, recovered: true, backupPath: backup, corruptPath: movedPrimary ? corrupt : '' };
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    if (!fs.existsSync(target) && movedPrimary && fs.existsSync(corrupt)) {
      try { fs.renameSync(corrupt, target); } catch {}
    }
    throw error;
  }
}

function validateSqliteFile(file: string, label = 'SQLite database'): SqliteIntegrityResult {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 3000 });
  try {
    db.enableLoadExtension(false);
    return assertSqliteIntegrity(db, label);
  } finally {
    try { db.close(); } catch {}
  }
}

function isSqliteCorruptionError(error: unknown): boolean {
  const code = errorCode(error);
  const message = errorMessage(error);
  return code === 'SQLITE_CORRUPT'
    || code === 'SQLITE_NOTADB'
    || code === 'SQLITE_INTEGRITY_CHECK_FAILED'
    || /database disk image is malformed/i.test(message)
    || /file is not a database/i.test(message)
    || /integrity check/i.test(message);
}

function removeSqliteSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try { fs.rmSync(`${file}${suffix}`, { force: true }); } catch {}
  }
}

function escapeSqliteLiteral(value: unknown): string {
  return String(value).replaceAll("'", "''");
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || '');
}

export {
  assertSqliteIntegrity,
  checkpointSqlite,
  createSqliteBackup,
  isSqliteCorruptionError,
  restoreSqliteBackup,
  isSqliteValidationCurrent,
  sqliteBackupPath,
  writeSqliteValidationStamp
};
