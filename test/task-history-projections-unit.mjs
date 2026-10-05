import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { clearTaskHistory, flushTaskHistoryPersistence, readTaskHistory, readTaskHistoryPage, readRecentTaskHistoryEvents, readRecentTaskHistoryEventsPage, recordTaskActivityEvent } from '../src/taskHistoryStore.ts';
import { openStateDatabase } from '../src/stateDatabase.ts';
import { listSessionSummaries, listSessionSummaryPage, pruneSessionsAsync, readSession, writeSession } from '../src/taskHistoryStorage.ts';
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

  const clearConfig = { stateDir: path.join(stateDir, 'clear-boundary') };
  const historyDirectory = path.join(clearConfig.stateDir, 'sessions');
  const stage = (id, eventId) => recordTaskActivityEvent(clearConfig, {
    task: { id, taskId: id, sessionId: id, workspace: 'app', status: 'planning', title: eventId, startedAt: new Date().toISOString() },
    activityEvent: { eventId, timestamp: new Date().toISOString(), summary: eventId }
  }, { defer: true });

  stage('old-task', 'old-event');
  const oldFlush = flushTaskHistoryPersistence();
  const clearing = clearTaskHistory(clearConfig);
  assert.equal(clearTaskHistory(clearConfig), clearing, 'overlapping clears must share one bounded deletion');
  await clearing;
  await oldFlush;
  assert.equal(readSession(historyDirectory, 'old-task'), null, 'an already-posted worker write must not resurrect cleared history');

  stage('same-task', 'before-clear');
  const oldSameTaskFlush = flushTaskHistoryPersistence();
  const clearWithFreshEvents = clearTaskHistory(clearConfig);
  stage('same-task', 'after-clear');
  stage('fresh-task', 'fresh-event');
  await clearWithFreshEvents;
  await oldSameTaskFlush;
  await flushTaskHistoryPersistence();
  const sameTask = readSession(historyDirectory, 'same-task');
  assert.ok(sameTask.events.some(event => event.eventId === 'after-clear'), 'fresh events must persist after deletion');
  assert.equal(sameTask.events.some(event => event.eventId === 'before-clear'), false, 'fresh events must not merge cleared timeline data back in');
  assert.ok(readSession(historyDirectory, 'fresh-task'), 'new tasks accepted during clear must survive');

  const staleTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const [name, read] of [
    ['page', () => readTaskHistoryPage(clearConfig, { activeTaskIds: [] }).tasks],
    ['full', () => readTaskHistory(clearConfig, {}, { activeTaskIds: [] })],
    ['summary', () => readTaskHistory(clearConfig, {}, { activeTaskIds: [], summary: true })]
  ]) {
    await clearTaskHistory(clearConfig);
    writeSession(historyDirectory, {
      id: 'stale-reader-task', taskId: 'stale-reader-task', sessionId: 'stale-reader-task',
      workspace: 'app', title: 'Persisted stale task', status: 'planning', state: 'planning',
      startedAt: staleTime, updatedAt: staleTime, lastActivityAt: staleTime,
      events: [{ eventId: 'stale-reader-event', timestamp: staleTime, summary: 'Old event' }]
    });
    const readerClear = clearTaskHistory(clearConfig);
    stage('fresh-reader-task', `fresh-${name}`);
    assert.equal(read().some(task => task.id === 'stale-reader-task'), false, `${name} reader must not reconcile a pre-clear stored row back into pending history`);
    assert.deepEqual(readRecentTaskHistoryEvents(clearConfig), [], 'storage event readers must respect the clear boundary');
    assert.deepEqual(readRecentTaskHistoryEventsPage(clearConfig).entries, [], 'paged event readers must respect the clear boundary');
    await readerClear;
    await flushTaskHistoryPersistence();
    assert.equal(readSession(historyDirectory, 'stale-reader-task'), null, `${name} reader must not resurrect cleared history after flushing`);
    assert.ok(readSession(historyDirectory, 'fresh-reader-task'), `${name} reader must preserve legitimate post-clear events`);
  }

  const originalExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === 'DELETE FROM task_history') throw new Error('fixture history deletion failure');
    return originalExec.call(this, sql);
  };
  try {
    stage('pending-only', 'unsaved-before-failed-clear');
    const failedClear = clearTaskHistory(clearConfig);
    stage('pending-only', 'fresh-during-failed-clear');
    await assert.rejects(failedClear, /fixture history deletion failure/, 'durable deletion failures must reach the caller');
    assert.ok(readSession(historyDirectory, 'fresh-reader-task'), 'failed deletion must not claim persisted history was removed');
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  await flushTaskHistoryPersistence();
  const restoredPending = readSession(historyDirectory, 'pending-only');
  assert.ok(restoredPending.events.some(event => event.eventId === 'unsaved-before-failed-clear'), 'failed clear must restore unposted pre-clear events');
  assert.ok(restoredPending.events.some(event => event.eventId === 'fresh-during-failed-clear'), 'rollback must merge rather than overwrite fresh same-task events');
  await clearTaskHistory(clearConfig);
  assert.equal(readSession(historyDirectory, 'fresh-reader-task'), null, 'a subsequent clear must recover after a failed deletion');
  assert.equal(readSession(historyDirectory, 'pending-only'), null, 'a subsequent successful clear must delete restored pending history');
} finally {
  db.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
console.log('Task history projection and worker maintenance checks passed');
