import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OUTCOME_CLASSES, classifyAnalyticsOutcome } from '../src/analyticsOutcome.js';
import { failureCategoryFromEvent, normalizeFailureCategory } from '../src/analyticsFailureCategory.ts';
import { withStateDatabase } from '../src/stateDatabase.ts';
import { flushLocalAnalytics, recordLocalToolOutcome, recordLocalTransportEvent, readLocalUsageSnapshot } from '../src/localAnalytics.js';
import { analyticsBounds, analyticsRangeScope, normalizeUsageSnapshot } from '../src/ui/features/usage/range-model.js';
import { analyticsMetrics } from '../src/ui/features/usage/render.js';

assert.equal(classifyAnalyticsOutcome({ ok: true }), OUTCOME_CLASSES.SUCCESS);
assert.equal(classifyAnalyticsOutcome({ ok: false, operationName: 'relai_validate', errorMessage: 'test exited 1' }), OUTCOME_CLASSES.OPERATION_FAILURE);
assert.equal(classifyAnalyticsOutcome({ ok: false, operationName: 'relai_edit', errorCode: 'EDIT_CONTEXT_MISMATCH' }), OUTCOME_CLASSES.RECOVERABLE_FAILURE);
assert.equal(classifyAnalyticsOutcome({ ok: false, errorMessage: 'Path is a directory: node_modules' }), OUTCOME_CLASSES.UNCLASSIFIED_FAILURE);
assert.equal(classifyAnalyticsOutcome({ ok: false, errorMessage: 'ExceptionGroup: unhandled errors in a TaskGroup' }), OUTCOME_CLASSES.INFRASTRUCTURE_FAILURE);
assert.equal(classifyAnalyticsOutcome({ ok: false, operationName: 'relai_validate', errorCode: 'ERR_MODULE_NOT_FOUND' }), OUTCOME_CLASSES.INFRASTRUCTURE_FAILURE, 'validator infrastructure crashes must not count as reliable operation failures');
assert.equal(classifyAnalyticsOutcome({ ok: false, errorMessage: 'Operation cancelled.' }), OUTCOME_CLASSES.CANCELLED);
assert.equal(failureCategoryFromEvent({ errorCode: 'TASK_NOT_FOUND' }), 'task');
assert.equal(failureCategoryFromEvent({ errorCode: 'EDIT_CONTEXT_MISMATCH' }), 'stale');
assert.equal(failureCategoryFromEvent({ errorCode: 'INDEX_NOT_READY' }), 'search');
assert.equal(failureCategoryFromEvent({ errorCode: 'BROWSER_TARGET_NOT_FOUND' }), 'desktop');
assert.equal(failureCategoryFromEvent({ errorCode: 'SQLITE_BUSY' }), 'app');
assert.equal(failureCategoryFromEvent({ errorCode: 'ERR_MODULE_NOT_FOUND' }), 'internal');
assert.equal(failureCategoryFromEvent({ errorCode: 'APPROVAL_PRINCIPAL_MISMATCH' }), 'policy');
assert.equal(failureCategoryFromEvent({ errorCode: 'TUNNEL_ACCESS_DENIED' }), 'authorization');
assert.equal(failureCategoryFromEvent({ operationName: 'relai_exec', errorMessage: 'spawn EINVAL' }), 'process');
assert.equal(failureCategoryFromEvent({ operationName: 'relai_exec', errorMessage: 'command exited with code 1' }), 'process');
assert.equal(failureCategoryFromEvent({ operationName: 'relai_validate', errorMessage: 'test exited 1' }), 'validation');
assert.equal(normalizeFailureCategory('runtime'), 'unclassified', 'legacy runtime buckets must be presented as unclassified rather than Other');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-reliability-'));
const config = { stateDir };
try {
  const at = '2026-08-15T02:00:00Z';
  recordLocalToolOutcome(config, { tool: 'relai_validate', operationName: 'relai_validate', workspace: 'repo', ok: false, errorMessage: 'test exited 1', durationMs: 10, at });
  recordLocalToolOutcome(config, { tool: 'relai_edit', operationName: 'relai_edit', workspace: 'repo', ok: false, errorCode: 'EDIT_CONTEXT_MISMATCH', errorMessage: 'found 2 matches', durationMs: 20, at });
  recordLocalToolOutcome(config, { tool: 'relai_exec', operationName: 'relai_exec', workspace: 'repo', ok: false, errorMessage: 'spawn EINVAL', durationMs: 30, at });
  recordLocalToolOutcome(config, { tool: 'relai_exec', operationName: 'relai_exec', workspace: 'repo', ok: false, errorMessage: 'Operation cancelled.', durationMs: 40, at });
  for (const event of ['request_started', 'request_reached_runtime', 'connection_closed', 'upstream_5xx', 'response_delivered']) {
    assert.equal(recordLocalTransportEvent(config, { event, at }), true);
  }

  const snapshot = readLocalUsageSnapshot(config, '2026-08');
  assert.equal(snapshot.totals.failures, 4, 'raw operation failures remain visible');
  assert.equal(snapshot.totals.reliabilityCalls, 2, 'cancellations and unclassified failures are excluded from the reliability denominator');
  assert.equal(snapshot.totals.reliableCalls, 2, 'validation and recoverable edit failures still count as reliable tool behavior');
  assert.equal(snapshot.totals.infrastructureFailures, 0);
  assert.equal(snapshot.totals.operationFailures, 1);
  assert.equal(snapshot.totals.recoverableFailures, 1);
  assert.equal(snapshot.totals.cancellations, 1);
  assert.deepEqual(snapshot.transport, {
    request_started: 1,
    request_reached_runtime: 1,
    request_cancelled: 0,
    connection_closed: 1,
    upstream_5xx: 1,
    response_delivered: 1
  }, 'transport failures must be accounted separately from tool reliability');
  assert.equal(snapshot.transportSeries[0].connection_closed, 1);

  const model = normalizeUsageSnapshot(snapshot, '2026-08');
  const bounds = analyticsBounds('24h', { now: new Date('2026-08-15T03:00:00Z') });
  const scope = analyticsRangeScope([model], bounds);
  assert.deepEqual(scope.transport, snapshot.transport, 'global analytics range must preserve transport delivery counters separately from tool outcomes');
  assert.equal(scope.requestDeliveryRate, 100, 'delivered server-error responses still count as delivered transport responses');
  assert.equal(analyticsRangeScope([model], bounds, { workspace: 'repo' }).transport, null, 'global tunnel delivery counters must not be misattributed to a project');
  assert.equal(scope.reliabilityRate.toFixed(2), '100.00');
  assert.equal(scope.operationSuccessRate, 0, 'all recorded operations in this fixture failed even though two failures were reliable tool behavior');

  const legacy = normalizeUsageSnapshot({
    source: 'local',
    month: '2026-08',
    totals: { requests: 2, toolCalls: 2, successes: 1, failures: 1, requestBytes: 0, resultBytes: 0, executionMs: 10, activeDays: 1 },
    tools: [], devices: [], workspaces: [], workspaceDimensions: [], workspaceTools: [],
    series: [{ hour: '2026-08-15T02', requests: 2, toolCalls: 2, successes: 1, failures: 1, requestBytes: 0, resultBytes: 0, executionMs: 10 }],
    toolSeries: [], workspaceSeries: [], workspaceToolSeries: []
  }, '2026-08');
  const legacyScope = analyticsRangeScope([legacy], bounds);
  assert.equal(legacyScope.operationSuccessRate, 50, 'legacy successes and failures remain available as raw operation success');
  assert.equal(legacyScope.reliabilityRate, null, 'legacy analytics must not be guessed into the new reliability denominator');
  assert.equal(legacyScope.reliabilityCalls, 0);

  const legacyMetrics = analyticsMetrics(legacyScope, analyticsRangeScope([], bounds));
  assert.equal(legacyMetrics.some(metric => metric.key === 'reliabilityRate'), false, 'Reliability classification must remain diagnostic rather than a normal metric tile');
  assert.equal(legacyMetrics.some(metric => metric.key === 'infrastructureFailures'), false, 'Internal errors must remain exceptional rather than a normal metric tile');
  assert.equal(legacyMetrics.some(metric => metric.label === 'Operation success'), false);

  const legacyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-reliability-v1-'));
  try {
    const analyticsDir = path.join(legacyStateDir, 'analytics', 'local');
    fs.mkdirSync(analyticsDir, { recursive: true });
    const legacyAggregate = {
      requests: 10, toolCalls: 10, successes: 9, failures: 1, executionMs: 100,
      reliabilityCalls: 10, reliableCalls: 9, infrastructureFailures: 1,
      operationFailures: 0, recoverableFailures: 0, cancellations: 0
    };
    fs.writeFileSync(path.join(analyticsDir, '2026-08.json'), JSON.stringify({
      schemaVersion: 1,
      month: '2026-08',
      totals: legacyAggregate,
      tools: [], workspaces: [], workspaceTools: [],
      failureCategories: [{ category: 'runtime', failures: 1 }], workspaceFailureCategories: [],
      hours: [{
        hour: '2026-08-15T02', ...legacyAggregate,
        tools: [], workspaces: [], workspaceTools: [],
        failureCategories: [{ category: 'runtime', failures: 1 }], workspaceFailureCategories: []
      }]
    }));
    const migrated = readLocalUsageSnapshot({ stateDir: legacyStateDir }, '2026-08');
    assert.equal(migrated.totals.successes, 9);
    assert.equal(migrated.totals.failures, 1);
    assert.equal(migrated.totals.reliabilityCalls, 0, 'schema-v1 reliability counters are ambiguous and must be reset during migration');
    assert.equal(migrated.totals.infrastructureFailures, 0);

    recordLocalToolOutcome({ stateDir: legacyStateDir }, { tool: 'relai_read', workspace: 'repo', ok: true, durationMs: 5, at: '2026-08-15T02:30:00Z' });
    const afterNewCall = readLocalUsageSnapshot({ stateDir: legacyStateDir }, '2026-08');
    assert.equal(afterNewCall.totals.successes, 10, 'raw operation history is preserved across the migration');
    assert.equal(afterNewCall.totals.failures, 1);
    assert.equal(afterNewCall.totals.reliabilityCalls, 1, 'reliability starts with the first newly classified call');
    assert.equal(afterNewCall.totals.reliableCalls, 1);
    await flushLocalAnalytics({ stateDir: legacyStateDir });
    assert.equal(fs.existsSync(analyticsDir), false, 'legacy analytics JSON must be removed after SQLite migration');
    const migratedDocument = withStateDatabase({ stateDir: legacyStateDir }, db => JSON.parse(db.prepare('SELECT payload FROM analytics_months WHERE month=?').get('2026-08').payload));
    assert.equal(migratedDocument.schemaVersion, 5);
    assert.equal(migratedDocument.totals.reliabilityCalls, 1);
  } finally {
    fs.rmSync(legacyStateDir, { recursive: true, force: true });
  }

  const previousStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-reliability-v2-'));
  try {
    const previousAggregate = {
      requests: 10, toolCalls: 10, successes: 9, failures: 1, executionMs: 100,
      reliabilityCalls: 10, reliableCalls: 9, infrastructureFailures: 1,
      operationFailures: 0, recoverableFailures: 0, cancellations: 0
    };
    const previousDocument = {
      schemaVersion: 2,
      month: '2026-08',
      totals: previousAggregate,
      tools: [], workspaces: [], workspaceTools: [],
      failureCategories: [{ category: 'runtime', failures: 1 }], workspaceFailureCategories: [],
      performancePhases: {},
      hours: [{
        hour: '2026-08-15T02', ...previousAggregate,
        tools: [], workspaces: [], workspaceTools: [],
        failureCategories: [{ category: 'runtime', failures: 1 }], workspaceFailureCategories: [], performancePhases: {}
      }]
    };
    withStateDatabase({ stateDir: previousStateDir }, db => {
      db.prepare('INSERT INTO analytics_months(month,updated_at_ms,payload) VALUES(?,?,?)').run('2026-08', Date.now(), JSON.stringify(previousDocument));
    });
    const migrated = readLocalUsageSnapshot({ stateDir: previousStateDir }, '2026-08');
    assert.equal(migrated.totals.successes, 9, 'schema-v2 raw successes must be preserved');
    assert.equal(migrated.totals.failures, 1, 'schema-v2 raw failures must be preserved');
    assert.equal(migrated.totals.reliabilityCalls, 0, 'schema-v2 reliability counters are ambiguous under the stricter classifier and must be reset');
    assert.equal(migrated.totals.infrastructureFailures, 0, 'schema-v2 internal-error counts must not be relabeled as confirmed failures');
    recordLocalToolOutcome({ stateDir: previousStateDir }, { tool: 'relai_read', workspace: 'repo', ok: true, durationMs: 5, at: '2026-08-15T02:30:00Z' });
    const persistedDocument = withStateDatabase({ stateDir: previousStateDir }, db => JSON.parse(db.prepare('SELECT payload FROM analytics_months WHERE month=?').get('2026-08').payload));
    assert.equal(persistedDocument.schemaVersion, 5);
    assert.equal(persistedDocument.totals.successes, 10);
    assert.equal(persistedDocument.totals.failures, 1);
    assert.equal(persistedDocument.totals.reliabilityCalls, 1);
  } finally {
    await flushLocalAnalytics({ stateDir: previousStateDir });
    fs.rmSync(previousStateDir, { recursive: true, force: true });
  }

  const v3StateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-reliability-v3-'));
  try {
    const v3Aggregate = {
      requests: 10, toolCalls: 10, successes: 9, failures: 1, executionMs: 100,
      reliabilityCalls: 10, reliableCalls: 9, infrastructureFailures: 0,
      operationFailures: 1, recoverableFailures: 0, cancellations: 0
    };
    const v3Document = {
      schemaVersion: 3,
      month: '2026-08',
      totals: v3Aggregate,
      tools: [], workspaces: [], workspaceTools: [],
      failureCategories: [{ category: 'process', failures: 1 }], workspaceFailureCategories: [],
      performancePhases: {},
      hours: [{
        hour: '2026-08-15T02', ...v3Aggregate,
        tools: [], workspaces: [], workspaceTools: [],
        failureCategories: [{ category: 'process', failures: 1 }], workspaceFailureCategories: [], performancePhases: {}
      }]
    };
    withStateDatabase({ stateDir: v3StateDir }, db => {
      db.prepare('INSERT INTO analytics_months(month,updated_at_ms,payload) VALUES(?,?,?)').run('2026-08', Date.now(), JSON.stringify(v3Document));
    });
    const migrated = readLocalUsageSnapshot({ stateDir: v3StateDir }, '2026-08');
    assert.equal(migrated.totals.reliabilityCalls, 10, 'schema-v3 reliability counters must survive later analytics schema migrations');
    assert.equal(migrated.totals.reliableCalls, 9);
    assert.equal(migrated.totals.operationFailures, 1);
    recordLocalToolOutcome({ stateDir: v3StateDir }, { tool: 'relai_read', operationName: 'read', taskIntent: 'investigation', workspace: 'repo', ok: true, durationMs: 5, at: '2026-08-15T02:30:00Z' });
    const persistedDocument = withStateDatabase({ stateDir: v3StateDir }, db => JSON.parse(db.prepare('SELECT payload FROM analytics_months WHERE month=?').get('2026-08').payload));
    assert.equal(persistedDocument.schemaVersion, 5);
    assert.equal(persistedDocument.totals.reliabilityCalls, 11);
    assert.equal(persistedDocument.totals.reliableCalls, 10);
    assert.equal(persistedDocument.activityMatrix.find(row => row.intent === 'investigation' && row.useCase === 'explore')?.toolCalls, 1);
  } finally {
    await flushLocalAnalytics({ stateDir: v3StateDir });
    fs.rmSync(v3StateDir, { recursive: true, force: true });
  }

  const metrics = analyticsMetrics(scope, analyticsRangeScope([], bounds));
  assert.equal(metrics.some(metric => metric.label === 'Reliable actions'), false);
  assert.equal(metrics.some(metric => metric.label === 'Internal errors'), false);
  assert.equal(metrics.some(metric => metric.label === 'Successful actions'), true);
  assert.equal(metrics.some(metric => metric.label === 'Retryable problems'), true);
  assert.equal(metrics.some(metric => metric.label === 'Operation success'), false);
  assert.equal(metrics.some(metric => metric.label === 'Retryable errors'), false);

  await flushLocalAnalytics(config);
  const persisted = withStateDatabase(config, db => String(db.prepare('SELECT payload FROM analytics_months WHERE month=?').get('2026-08')?.payload || ''));
  for (const secret of ['spawn EINVAL', 'Operation cancelled.', 'found 2 matches']) {
    assert.equal(persisted.includes(secret), false, `reliability classification must not persist raw error text: ${secret}`);
  }

  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-reliability-blocked-'));
  const blockedStateDir = path.join(blockedRoot, 'state-file');
  try {
    fs.writeFileSync(blockedStateDir, 'blocked');
    const blockedConfig = { stateDir: blockedStateDir };
    assert.equal(recordLocalToolOutcome(blockedConfig, {
      tool: 'relai_read', workspace: 'repo', ok: true, durationMs: 1, at: '2026-08-15T02:45:00Z'
    }), false, 'synchronous SQLite analytics writes must report a permanent persistence failure at the write boundary');
    assert.deepEqual(await flushLocalAnalytics(blockedConfig), { ok: true, failed: 0, pending: 0 }, 'SQLite analytics have no deferred JSON write queue to flush');
  } finally {
    fs.rmSync(blockedRoot, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log('Analytics reliability classification tests passed.');
