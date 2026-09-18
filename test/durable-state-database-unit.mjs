import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

import {
  initializeStateDatabase,
  maintainStateDatabase,
  openStateDatabase,
  stateDatabaseBackupPath,
  stateDatabasePath
} from '../src/stateDatabase.ts';
import {
  initializeKnowledgeDatabase,
  knowledgeDatabaseBackupPath,
  knowledgeDatabasePath,
  learnedValidationChecks,
  maintainKnowledgeDatabase,
  recordTaskValidationAffinity
} from '../src/knowledgeStore.js';
import { readTaskIntegrity, readWorkspaceIntegrity } from '../src/taskIntegrity.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-durable-db-'));

try {
  const contendedConfig = { stateDir: path.join(temp, 'contended') };
  const contendedFile = stateDatabasePath(contendedConfig);
  fs.mkdirSync(path.dirname(contendedFile), { recursive: true });
  const fixtureDb = new DatabaseSync(contendedFile);
  fixtureDb.exec('CREATE TABLE fixture(value TEXT)');
  fixtureDb.close();
  const writer = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO fixture VALUES('preserved')");
    parentPort.postMessage('locked');
    parentPort.once('message', () => {
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);
    });
  `, { eval: true, workerData: contendedFile });
  const writerExited = once(writer, 'exit');
  try {
    await once(writer, 'message');
    assert.throws(() => openStateDatabase(contendedConfig, { timeoutMs: 0 }), /database is locked/,
      'a zero timeout must still report journal-mode lock contention');
    writer.postMessage('release');
    const opened = openStateDatabase(contendedConfig, { timeoutMs: 5000 });
    try {
      assert.equal(opened.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(opened.prepare('SELECT value FROM fixture').get().value, 'preserved',
        'opening after contention must preserve the competing transaction');
    } finally {
      opened.close();
    }
    await writerExited;
  } finally {
    await writer.terminate();
  }

  const migrationConfig = { stateDir: path.join(temp, 'migration') };
  const migrationFile = stateDatabasePath(migrationConfig);
  fs.mkdirSync(path.dirname(migrationFile), { recursive: true });
  const legacyDb = new DatabaseSync(migrationFile);
  legacyDb.exec(`
    CREATE TABLE state_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE task_history(id TEXT PRIMARY KEY, updated_at_ms INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
    INSERT INTO state_meta(key,value) VALUES('schema_version','1');
    INSERT INTO task_history(id,updated_at_ms,payload) VALUES('task-old',1,'{"id":"task-old"}');
  `);
  legacyDb.close();

  const migratedDb = openStateDatabase(migrationConfig);
  try {
    assert.equal(migratedDb.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get().value, '2');
    assert.equal(migratedDb.prepare("SELECT COUNT(*) AS count FROM task_history WHERE id='task-old'").get().count, 1);
    assert.ok(migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_integrity_tasks'").get());
    assert.ok(migratedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_integrity'").get());
  } finally {
    migratedDb.close();
  }
  assert.equal(fs.existsSync(stateDatabaseBackupPath(migrationConfig)), true, 'schema migration must create a pre-migration backup');
  const migrationBackup = new DatabaseSync(stateDatabaseBackupPath(migrationConfig), { readOnly: true });
  try {
    assert.equal(migrationBackup.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get().value, '1');
  } finally {
    migrationBackup.close();
  }

  maintainStateDatabase(migrationConfig);
  assert.equal(fs.existsSync(`${migrationFile}.validated.json`), true, 'verified state maintenance must leave a lightweight startup validation stamp');
  fs.writeFileSync(migrationFile, 'not a sqlite database', 'utf8');
  const recovered = initializeStateDatabase(migrationConfig);
  assert.equal(recovered.recovered, true, 'corrupt durable state must recover from the last verified backup');
  const recoveredDb = openStateDatabase(migrationConfig, { readonly: true });
  try {
    assert.equal(recoveredDb.prepare("SELECT COUNT(*) AS count FROM task_history WHERE id='task-old'").get().count, 1);
  } finally {
    recoveredDb.close();
  }
  assert.equal(fs.readdirSync(path.dirname(migrationFile)).some(name => name.startsWith('durable-state.sqlite.corrupt-')), true, 'corrupt primary must be retained for diagnostics');

  const integrityConfig = { stateDir: path.join(temp, 'integrity') };
  const legacyIntegrityDir = path.join(integrityConfig.stateDir, 'task-integrity');
  fs.mkdirSync(path.join(legacyIntegrityDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(legacyIntegrityDir, 'workspaces'), { recursive: true });
  const authority = {
    version: 1,
    taskId: 'legacy-work',
    workspace: 'app',
    updatedAt: '2026-01-01T00:00:00.000Z',
    taskOwnedChangedFiles: ['src/a.js']
  };
  const workspaceState = {
    version: 1,
    workspace: 'app',
    generation: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    uncommittedOwners: { 'src/a.js': ['legacy-work'] }
  };
  fs.writeFileSync(path.join(legacyIntegrityDir, 'tasks', 'legacy.json'), `${JSON.stringify(authority)}\n`);
  fs.writeFileSync(path.join(legacyIntegrityDir, 'workspaces', 'legacy.json'), `${JSON.stringify(workspaceState)}\n`);
  assert.equal(readTaskIntegrity(integrityConfig, 'legacy-work', 'app').taskId, 'legacy-work');
  assert.deepEqual(readWorkspaceIntegrity(integrityConfig, 'app').uncommittedOwners, { 'src/a.js': ['legacy-work'] });
  assert.equal(fs.existsSync(legacyIntegrityDir), false, 'legacy task-integrity files must be removed only after transactional import');

  const knowledgeConfig = { stateDir: path.join(temp, 'knowledge') };
  recordTaskValidationAffinity(
    knowledgeConfig,
    'app',
    { changedFiles: ['src/feature/a.js'], workflowEvidence: [{ kind: 'check', command: 'npm test' }] },
    { validationStatus: 'passed', changedFiles: ['src/feature/a.js'] }
  );
  maintainKnowledgeDatabase(knowledgeConfig);
  assert.equal(fs.existsSync(knowledgeDatabaseBackupPath(knowledgeConfig)), true, 'knowledge shutdown maintenance must create a verified backup');
  assert.equal(fs.existsSync(`${knowledgeDatabasePath(knowledgeConfig)}.validated.json`), true, 'verified knowledge maintenance must leave a lightweight startup validation stamp');
  fs.writeFileSync(knowledgeDatabasePath(knowledgeConfig), 'corrupt knowledge database', 'utf8');
  const knowledgeRecovery = initializeKnowledgeDatabase(knowledgeConfig);
  assert.equal(knowledgeRecovery.recovered, true);
  assert.deepEqual(
    learnedValidationChecks(knowledgeConfig, 'app', ['src/feature/other.js']).map(item => item.command),
    ['npm test'],
    'knowledge recovery must preserve learned validation affinity'
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('Durable state database unit checks passed');
