import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { openStateDatabase } from '../src/stateDatabase.ts';
import { listSessionSummaries, listSessionSummaryPage, pruneSessionsAsync, readSession } from '../src/taskHistoryStorage.ts';
import { readTaskIntegrity } from '../src/taskIntegrity.ts';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-history-projections-'));
const db = openStateDatabase({ stateDir });
try {
  const session = { version: 3, id: 'large', taskId: 'large', sessionId: 'large', status: 'completed', workspace: 'app',
    events: [{ eventId: 'one', timestamp: '2026-10-01T00:00:00Z', metadata: { text: 'x'.repeat(1024 * 1024) } },
      { eventId: 'two', timestamp: '2026-10-02T00:00:00Z' }] };
  const insert = db.prepare('INSERT INTO task_history(id,updated_at_ms,payload) VALUES(?,?,?)');
  insert.run(session.id, Date.now(), JSON.stringify(session));
  function assertAccounting() {
    const counted = db.prepare('SELECT SUM(bytes) AS bytes FROM task_history_storage_usage').get().bytes;
    const actual = db.prepare(`SELECT
      (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM task_history) +
      (SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) FROM task_history_events) AS bytes`).get().bytes;
    assert.equal(counted, actual, 'insert, update and delete must keep retained-byte counters exact');
  }
  assertAccounting();
  const summary = db.prepare('SELECT payload FROM task_history_summaries WHERE id=?').get(session.id).payload;
  assert.ok(summary.length < 1024, 'dashboard summaries must not contain multi-event timeline payloads');
  assert.equal(listSessionSummaries(path.join(stateDir, 'sessions'), 100)[0].id, 'large');
  assert.equal(listSessionSummaryPage(path.join(stateDir, 'sessions'), { workspace: 'app' }).items.length, 1);
  session.events = [session.events[1], { eventId: 'three', timestamp: '2026-10-03T00:00:00Z', summary: 'latest' }];
  db.prepare('UPDATE task_history SET payload=?,updated_at_ms=? WHERE id=?').run(JSON.stringify(session), Date.now(), session.id);
  assertAccounting();
  // Retained indexed events survive timeline rotation and remain counted.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_history_events').get().n, 3);
  db.exec('BEGIN IMMEDIATE');
  db.prepare('DELETE FROM task_history WHERE id=?').run(session.id);
  assertAccounting();
  db.exec('ROLLBACK');
  assertAccounting();
  db.prepare('INSERT INTO task_integrity_tasks(task_id,updated_at_ms,payload) VALUES(?,?,?)')
    .run('large', Date.now(), JSON.stringify({ version: 1, taskId: 'large', workspace: 'app', taskOwnedChangedFiles: [] }));
  assert.ok(readTaskIntegrity({ stateDir }, 'large', 'app'));

  // Maintenance waits in the worker while the service event loop remains usable.
  const blocker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => { db.exec('ROLLBACK'); db.close(); });
  `, { eval: true, workerData: path.join(stateDir, 'durable-state.sqlite') });
  const exited = once(blocker, 'exit');
  try {
    await once(blocker, 'message');
    const maintenance = pruneSessionsAsync(path.join(stateDir, 'sessions'));
    let timerFired = false;
    await new Promise(resolve => setTimeout(() => { timerFired = true; resolve(); }, 30));
    assert.equal(timerFired, true);
    assert.equal(listSessionSummaries(path.join(stateDir, 'sessions'), 100).length, 1,
      'summary readers must continue while another connection owns the writer lock');
    assert.equal(readSession(path.join(stateDir, 'sessions'), 'large').id, 'large');
    assert.equal(readTaskIntegrity({ stateDir }, 'large', 'app').taskId, 'large',
      'task authorization reads must remain available under writer contention');
    blocker.postMessage('release');
    await exited;
    await maintenance;
  } finally { await blocker.terminate(); }
  db.prepare('DELETE FROM task_history WHERE id=?').run(session.id);
  assertAccounting();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_history_summaries').get().n, 0);
} finally {
  db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
console.log('Task history projection and worker maintenance checks passed');
