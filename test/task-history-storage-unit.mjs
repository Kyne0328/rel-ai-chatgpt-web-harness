import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { listRecentSessionEvents, listSessionSummaries, listSessions, readSession, resetTaskHistoryCaches, writeSession, writeSessionAsync } from '../src/taskHistoryStorage.ts';
import { openStateDatabase, stateDatabasePath, withStateDatabase } from '../src/stateDatabase.ts';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-history-storage-'));
const directory = path.join(stateDir, 'sessions');
const config = { stateDir };

try {
  const id = 'shared-task';
  writeSession(directory, { id, workspace: 'repo', summary: 'before' });
  assert.equal(listSessions(directory, 10)[0]?.summary, 'before');
  assert.equal(fs.existsSync(stateDatabasePath(config)), true, 'task history must use the shared SQLite state database');
  assert.equal(fs.existsSync(path.join(directory, `${id}.json`)), false, 'task history must not create canonical JSON session files');

  withStateDatabase(config, db => {
    const row = db.prepare('SELECT payload FROM task_history WHERE id=?').get(id);
    const session = JSON.parse(row.payload);
    session.summary = 'after!';
    db.prepare('UPDATE task_history SET updated_at_ms=?,payload=? WHERE id=?').run(Date.now() + 1, JSON.stringify(session), id);
  }, { transaction: true });
  assert.equal(listSessions(directory, 10)[0]?.summary, 'after!', 'SQLite readers must observe another process durable update immediately');
  assert.equal(readSession(directory, id)?.summary, 'after!');

  const lock = openStateDatabase(config);
  assert.ok(lock, 'task-history async-write test requires the state database');
  lock.exec('BEGIN IMMEDIATE');
  try {
    const pendingWrite = writeSessionAsync(directory, { id: 'worker-write', workspace: 'repo', summary: 'worker' });
    const firstSettled = await Promise.race([
      pendingWrite.then(() => 'write'),
      new Promise(resolve => setTimeout(() => resolve('timer'), 25))
    ]);
    assert.equal(firstSettled, 'timer', 'a locked SQLite write must wait in the storage worker without stalling the service event loop');
    lock.exec('ROLLBACK');
    await pendingWrite;
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
  assert.equal(readSession(directory, 'worker-write')?.summary, 'worker', 'worker-backed async writes must preserve durability acknowledgements');

  const completedId = 'completed-task';
  writeSession(directory, {
    id: completedId,
    status: 'completed',
    summary: 'Completed work.',
    progress: { mode: 'indeterminate', label: 'Waiting for the next task step' }
  });
  const completed = readSession(directory, completedId);
  assert.equal(completed?.progress?.mode, 'complete');
  assert.equal(completed?.progress?.percentage, 100);
  assert.equal(completed?.resultSummary, 'Completed work.');

  const summaryId = 'summary-task';
  writeSession(directory, {
    id: summaryId,
    workspace: 'repo',
    status: 'completed',
    summary: 'Summary remains available.',
    backgroundOperation: { status: 'running', signature: 'detail-signature' },
    currentOperations: [{ operationId: 'op-1', status: 'running' }],
    workflowEvidence: Array.from({ length: 40 }, (_, index) => ({ kind: 'check', marker: `large-detail-${index}`, detail: 'e'.repeat(1000) })),
    events: Array.from({ length: 50 }, (_, index) => ({
      eventId: `summary-${index}`,
      tool: index % 2 ? 'edit' : 'read',
      timestamp: new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 1000).toISOString(),
      summary: `Event ${index} ${'x'.repeat(1000)}`
    }))
  });
  const summary = listSessionSummaries(directory, 10).find(session => session.id === summaryId);
  const fullSummary = readSession(directory, summaryId);
  assert.equal(summary?.summary, 'Summary remains available.');
  assert.deepEqual(summary?.events, [], 'summary reads must not materialize multi-event history payloads');
  assert.equal(summary?.workflowEvidence, undefined, 'summary reads must omit dedicated detail-only workflow evidence');
  assert.equal(summary?.backgroundOperation?.status, 'running', 'summary reads must preserve task-state fields used by dashboard projections');
  assert.equal(summary?.currentOperations?.length, 1, 'summary reads must preserve current operation state');
  assert.equal(fullSummary?.events?.length, 50, 'full task detail must remain available through the canonical record');
  assert.ok(JSON.stringify(summary).length * 4 < JSON.stringify(fullSummary).length,
    'summary reads must materially reduce the task-history payload instead of only hiding fields after parsing');
  const recentEvents = listRecentSessionEvents(directory, 2);
  assert.deepEqual(recentEvents.map(event => event.eventId), ['summary-49', 'summary-48'],
    'recent-event reads must retain the newest task activity without materializing every task payload');
  assert.equal(recentEvents[0]?.workspace, 'repo');
  assert.equal(recentEvents[0]?.taskId, summaryId);
  assert.equal(recentEvents[0]?.sessionId, summaryId);

  const corruptId = 'corrupt-summary-row';
  withStateDatabase(config, db => {
    db.prepare('INSERT INTO task_history(id,updated_at_ms,payload) VALUES(?,?,?)').run(corruptId, Date.now() + 10_000, '{not-json');
  }, { transaction: true });
  assert.doesNotThrow(() => listRecentSessionEvents(directory, 10), 'recent-event reads must ignore malformed task-history rows');
  assert.doesNotThrow(() => listSessionSummaries(directory, 10), 'summary reads must preserve corrupt-record quarantine behavior');
  const corruptCount = withStateDatabase(config, db => db.prepare('SELECT COUNT(*) AS count FROM task_history WHERE id=?').get(corruptId).count);
  assert.equal(Number(corruptCount), 0, 'invalid task-history rows must still be removed by summary reads');

  const singleEventId = 'single-event-summary';
  writeSession(directory, {
    id: singleEventId,
    status: 'inactive',
    events: [{ eventId: 'single-begin', tool: 'work.begin', timestamp: '2026-08-01T00:00:00.000Z' }]
  });
  assert.equal(listSessionSummaries(directory, 10).find(session => session.id === singleEventId)?.events?.[0]?.tool, 'work.begin',
    'summary reads must retain a lone begin event so stale-noise reconciliation keeps its existing behavior');

  const legacyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-history-legacy-'));
  try {
    const legacyDirectory = path.join(legacyStateDir, 'sessions');
    fs.mkdirSync(legacyDirectory, { recursive: true });
    fs.writeFileSync(path.join(legacyDirectory, 'legacy.json'), JSON.stringify({
      version: 3,
      id: 'legacy-task',
      taskId: 'legacy-task',
      sessionId: 'legacy-task',
      workspace: 'repo',
      status: 'completed',
      title: 'Legacy task',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:01:00.000Z',
      summary: 'legacy history'
    }));
    const policyFile = path.join(legacyDirectory, 'repo--task-policy-policy.json');
    fs.writeFileSync(policyFile, JSON.stringify({ workspace: 'repo', taskId: 'task-policy' }));
    assert.equal(listSessions(legacyDirectory, 10)[0]?.summary, 'legacy history');
    assert.equal(fs.existsSync(path.join(legacyDirectory, 'legacy.json')), false, 'legacy task-history JSON must be removed after migration');
    assert.equal(fs.existsSync(policyFile), true, 'task-history migration must leave legacy policy JSON for the policy migrator');
  } finally {
    fs.rmSync(legacyStateDir, { recursive: true, force: true });
  }

  console.log('Task-history SQLite persistence, migration, and completed-state normalization passed.');
} finally {
  resetTaskHistoryCaches();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
