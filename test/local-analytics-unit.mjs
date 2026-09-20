import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_ANALYTICS_RETENTION_DAYS, clearLocalAnalytics, flushLocalAnalytics, pruneLocalAnalytics, recordLocalTaskCompletion, recordLocalToolOutcome, recordLocalTransportEvent, readLocalUsageSnapshot, readLocalUsageSnapshotAsync } from '../src/localAnalytics.js';
import { failureCategoryFromCode } from '../src/analyticsFailureCategory.js';
import { stateDatabasePath, withStateDatabase } from '../src/stateDatabase.ts';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-analytics-'));
const config = { stateDir };
try {
  assert.equal(recordLocalToolOutcome(config, { tool: 'relai_inspect', operationName: 'inspect', taskIntent: 'bugfix', workspace: 'repo', ok: true, durationMs: 100, at: '2026-08-08T10:15:00Z', prompt: 'SECRET_PROMPT', taskObjective: 'SECRET_OBJECTIVE', path: 'C:/SECRET_PATH', resultBody: 'SECRET_RESULT' }), true);
  assert.equal(recordLocalToolOutcome(config, { tool: 'relai_edit', operationName: 'edit', taskIntent: 'bugfix', workspace: 'repo', ok: false, durationMs: 300, at: '2026-08-08T11:15:00Z', errorCode: 'SENSITIVE_PATH_RESTRICTED', error: 'SECRET_ERROR_MESSAGE', command: 'SECRET_COMMAND' }), true);
  assert.equal(recordLocalToolOutcome(config, { tool: 'relai_inspect', operationName: 'inspect', taskIntent: 'investigation', workspace: 'other', ok: true, durationMs: 50, at: '2026-08-08T11:45:00Z' }), true);
  assert.equal(recordLocalTaskCompletion(config, { workspace: 'repo', taskIntent: 'bugfix', at: '2026-08-08T11:30:00Z' }), true);

  const preFlushStorage = withStateDatabase(config, db => ({
    monthlyRows: Number(db.prepare('SELECT COUNT(*) AS count FROM analytics_months WHERE month=?').get('2026-08')?.count || 0),
    counterRows: Number(db.prepare('SELECT COUNT(*) AS count FROM analytics_counter_rows WHERE month=?').get('2026-08')?.count || 0),
    dirty: Number(db.prepare('SELECT dirty FROM analytics_counter_state WHERE month=?').get('2026-08')?.dirty || 0)
  }));
  assert.equal(preFlushStorage.monthlyRows, 0, 'event writes must not rewrite the monthly JSON document before materialization');
  assert.ok(preFlushStorage.counterRows > 0, 'event writes must update indexed analytics counters');
  assert.equal(preFlushStorage.dirty, 1, 'normalized analytics must remain marked dirty until materialization');

  const snapshot = readLocalUsageSnapshot(config, '2026-08');
  assert.deepEqual(snapshot.privacy, {
    retentionDays: LOCAL_ANALYTICS_RETENTION_DAYS,
    externalTelemetry: { enabled: false, endpointConfigured: false, sampleRatio: 1 }
  });
  assert.equal(LOCAL_ANALYTICS_RETENTION_DAYS, 180);
  assert.deepEqual(snapshot.totals, {
    requests: 3, toolCalls: 3, successes: 2, failures: 1,
    reliabilityCalls: 3, reliableCalls: 3, infrastructureFailures: 0,
    operationFailures: 1, recoverableFailures: 0, cancellations: 0,
    executionMs: 450, activeDays: 1
  });
  assert.equal(snapshot.series.length, 2);
  assert.deepEqual(snapshot.series.map(row => [row.hour, row.toolCalls]), [['2026-08-08T10', 1], ['2026-08-08T11', 2]]);
  assert.equal(snapshot.tools.find(row => row.tool === 'relai_inspect')?.toolCalls, 2);
  assert.equal(snapshot.tools.find(row => row.tool === 'relai_edit')?.failures, 1);
  assert.equal(snapshot.workspaces.find(row => row.workspace === 'repo')?.toolCalls, 2);
  assert.equal(snapshot.workspaceTools.find(row => row.workspace === 'repo' && row.tool === 'relai_edit')?.failures, 1);
  assert.equal(snapshot.workspaceSeries.filter(row => row.workspace === 'repo').reduce((sum, row) => sum + row.toolCalls, 0), 2);
  assert.equal(snapshot.activityMatrix.find(row => row.intent === 'bugfix' && row.useCase === 'explore')?.toolCalls, 1);
  assert.equal(snapshot.activityMatrix.find(row => row.intent === 'bugfix' && row.useCase === 'edit')?.failures, 1);
  assert.equal(snapshot.workspaceActivityMatrix.find(row => row.workspace === 'repo' && row.intent === 'bugfix' && row.useCase === 'edit')?.toolCalls, 1);
  assert.deepEqual(snapshot.taskIntents, [{ intent: 'bugfix', tasks: 1 }]);
  assert.deepEqual(snapshot.workspaceTaskIntents, [{ workspace: 'repo', intent: 'bugfix', tasks: 1 }]);
  assert.equal(snapshot.activityMatrixSeries.filter(row => row.intent === 'bugfix').reduce((sum, row) => sum + row.toolCalls, 0), 2);
  assert.deepEqual(snapshot.taskIntentSeries, [{ hour: '2026-08-08T11', intent: 'bugfix', tasks: 1 }]);
  assert.equal('source' in snapshot, false, 'local-only analytics must not retain a cloud/local source discriminator');
  assert.equal('devices' in snapshot, false, 'single-device analytics must not expose a redundant device dimension');
  assert.equal('requestBytes' in snapshot.totals, false, 'unused byte counters must not remain in the analytics projection');
  assert.equal(failureCategoryFromCode('SENSITIVE_PATH_RESTRICTED'), 'policy');
  assert.deepEqual(snapshot.failureCategories, [{ category: 'policy', failures: 1 }]);
  assert.deepEqual(snapshot.workspaceFailureCategories, [{ workspace: 'repo', category: 'policy', failures: 1 }]);
  assert.deepEqual(snapshot.failureCategorySeries, [{ hour: '2026-08-08T11', category: 'policy', failures: 1 }]);
  assert.deepEqual(snapshot.workspaceFailureCategorySeries, [{ hour: '2026-08-08T11', workspace: 'repo', category: 'policy', failures: 1 }]);

  await flushLocalAnalytics(config);
  assert.equal(fs.existsSync(stateDatabasePath(config)), true, 'local analytics must use the shared SQLite state database');
  assert.equal(fs.existsSync(path.join(stateDir, 'analytics', 'local', '2026-08.json')), false, 'canonical analytics must not create monthly JSON files');
  const persisted = withStateDatabase(config, db => String(db.prepare('SELECT payload FROM analytics_months WHERE month=?').get('2026-08')?.payload || ''));
  for (const secret of ['SECRET_PROMPT', 'SECRET_OBJECTIVE', 'SECRET_PATH', 'SECRET_RESULT', 'SECRET_COMMAND', 'SECRET_ERROR_MESSAGE', 'SENSITIVE_PATH_RESTRICTED']) assert.equal(persisted.includes(secret), false, `local analytics must not persist ${secret}`);

  const external = JSON.parse(persisted);
  external.totals.requests = 9;
  external.totals.toolCalls = 9;
  external.totals.successes = 8;
  withStateDatabase(config, db => db.prepare('UPDATE analytics_months SET updated_at_ms=?,payload=? WHERE month=?').run(Date.now() + 1, JSON.stringify(external), '2026-08'), { transaction: true });
  assert.equal(readLocalUsageSnapshot(config, '2026-08').totals.toolCalls, 9, 'SQLite analytics reads must observe another process durable update immediately');
  assert.equal((await readLocalUsageSnapshotAsync(config, '2026-08')).totals.toolCalls, 9);

  recordLocalToolOutcome(config, { tool: 'relai_read', workspace: 'repo', ok: true, durationMs: 1, at: '2025-01-15T00:00:00Z' });
  const pruned = await pruneLocalAnalytics(config, { now: new Date('2026-09-04T00:00:00Z') });
  assert.equal(pruned.removedFiles, 1, 'analytics retention must remove SQLite monthly rows older than the supported history window');
  assert.equal(readLocalUsageSnapshot(config, '2025-01').totals.toolCalls, 0);
  assert.equal(readLocalUsageSnapshot(config, '2026-08').totals.toolCalls, 9, 'retention must preserve analytics inside the supported history window');

  const cleared = await clearLocalAnalytics(config);
  assert.equal(cleared.ok, true);
  assert.ok(cleared.removedFiles >= 1);
  assert.equal(readLocalUsageSnapshot(config, '2026-08').totals.toolCalls, 0, 'clearing analytics must clear the SQLite analytics rows');

  const freshResetStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-analytics-reset-'));
  try {
    const freshReset = await clearLocalAnalytics({ stateDir: freshResetStateDir });
    assert.equal(freshReset.ok, true, 'clearing analytics must work before normalized tables exist');
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(freshResetStateDir, { recursive: true, force: true });
  }

  const matureStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-analytics-mature-'));
  try {
    const aggregate = { toolCalls: 1, successes: 1, failures: 0, reliabilityCalls: 1, reliableCalls: 1, infrastructureFailures: 0, operationFailures: 0, recoverableFailures: 0, cancellations: 0, executionMs: 1 };
    const matureDocument = {
      schemaVersion: 5,
      month: '2026-08',
      totals: { requests: 512, ...aggregate },
      transport: { request_started: 0, request_reached_runtime: 0, request_cancelled: 0, connection_closed: 0, upstream_5xx: 0, response_delivered: 0 },
      tools: Array.from({ length: 512 }, (_, index) => ({ tool: `tool-${index}-${'x'.repeat(120)}`, ...aggregate })),
      workspaces: [], workspaceTools: [], activityMatrix: [], workspaceActivityMatrix: [], taskIntents: [], workspaceTaskIntents: [],
      failureCategories: [], workspaceFailureCategories: [], performancePhases: {}, hours: []
    };
    withStateDatabase({ stateDir: matureStateDir }, db => db.prepare('INSERT INTO analytics_months(month,updated_at_ms,payload) VALUES(?,?,?)').run('2026-08', 10, JSON.stringify(matureDocument)));
    assert.equal(recordLocalToolOutcome({ stateDir: matureStateDir }, { tool: 'hot-tool', workspace: 'repo', ok: true, durationMs: 5, at: '2026-08-15T02:30:00Z' }), true);
    assert.equal(recordLocalTransportEvent({ stateDir: matureStateDir }, { event: 'request_started', count: 2, at: '2026-08-15T02:30:00Z' }), true);
    assert.equal(recordLocalTaskCompletion({ stateDir: matureStateDir }, { workspace: 'repo', taskIntent: 'bugfix', at: '2026-08-15T02:30:00Z' }), true);
    const matureSnapshot = readLocalUsageSnapshot({ stateDir: matureStateDir }, '2026-08');
    assert.equal(matureSnapshot.totals.toolCalls, 2, 'mature analytics writes must update normalized total counters');
    assert.equal(matureSnapshot.tools.find(row => row.tool === 'hot-tool')?.toolCalls, 1, 'mature analytics writes must update only affected indexed dimensions');
    assert.equal(matureSnapshot.transport.request_started, 2, 'mature analytics transport writes must update normalized transport counters');
    assert.equal(matureSnapshot.taskIntents.find(row => row.intent === 'bugfix')?.tasks, 1, 'mature task completion writes must update normalized intent counters');
    assert.ok(withStateDatabase({ stateDir: matureStateDir }, db => Number(db.prepare('SELECT COUNT(*) AS count FROM analytics_counter_rows').get()?.count || 0)) > 512,
      'mature analytics must store counters in indexed rows instead of rewriting the monthly document on each event');
    await flushLocalAnalytics({ stateDir: matureStateDir });
    const materialized = withStateDatabase({ stateDir: matureStateDir }, db => JSON.parse(db.prepare('SELECT payload FROM analytics_months WHERE month=?').get('2026-08').payload));
    assert.equal(materialized.totals.toolCalls, 2, 'analytics counters must materialize to the durable monthly document on flush');
  } finally {
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(matureStateDir, { recursive: true, force: true });
  }

  const contentionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-analytics-contention-'));
  try {
    const contentionConfig = { stateDir: contentionRoot };
    withStateDatabase(contentionConfig, db => db.prepare('INSERT OR REPLACE INTO state_meta(key,value) VALUES(?,?)').run('contention-ready', '1'), { transaction: true });
    const lock = new DatabaseSync(stateDatabasePath(contentionConfig));
    try {
      lock.exec('BEGIN IMMEDIATE');
      const startedAt = Date.now();
      assert.equal(recordLocalToolOutcome(contentionConfig, { tool: 'relai_read', workspace: 'repo', ok: true, durationMs: 1 }), false);
      assert.equal(recordLocalTransportEvent(contentionConfig, { event: 'request_started' }), false);
      assert.equal(recordLocalTaskCompletion(contentionConfig, { workspace: 'repo', taskIntent: 'bugfix' }), false);
      assert.ok(Date.now() - startedAt < 1000, 'analytics contention must fail fast instead of blocking the service thread');
      lock.exec('ROLLBACK');
    } finally {
      if (lock.isTransaction) lock.exec('ROLLBACK');
      lock.close();
    }
  } finally {
    fs.rmSync(contentionRoot, { recursive: true, force: true });
  }

  const flushRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-analytics-flush-'));
  try {
    const flushConfig = { stateDir: flushRoot };
    assert.equal(recordLocalToolOutcome(flushConfig, { tool: 'relai_read', workspace: 'repo', ok: true, durationMs: 1 }), true);
    await flushLocalAnalytics(flushConfig);
    fs.rmSync(flushRoot, { recursive: true, force: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.existsSync(flushRoot), false, 'analytics flush must drain scheduled retention work before cleanup');
  } finally {
    fs.rmSync(flushRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log('Local aggregate SQLite analytics storage passed.');
