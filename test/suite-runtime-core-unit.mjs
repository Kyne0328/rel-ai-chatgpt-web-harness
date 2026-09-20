// Consolidated runtime core coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly active-controller-guard-unit.mjs
async function case_active_controller_guard_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:path");
    const path = __m1.default;
  
    const __m2 = await import("../scripts/active-controller-guard.mjs");
    const { discoverActiveControllers, evaluateControllerSafety, pathsOverlap } = __m2;
  
  const repository = path.resolve('C:/Dev/rel-ai-mcp');
  const releaseTarget = path.join(repository, 'dist');
  const installedController = {
    pid: 4101,
    name: 'Rel.AI MCP.exe',
    execPath: 'C:/Program Files/Rel.AI MCP/Rel.AI MCP.exe',
    commandLine: '"C:/Program Files/Rel.AI MCP/Rel.AI MCP.exe"'
  };
  const unpackedController = {
    pid: 4102,
    name: 'Rel.AI MCP.exe',
    execPath: path.join(releaseTarget, 'win-unpacked', 'Rel.AI MCP.exe'),
    resourcesPath: path.join(releaseTarget, 'win-unpacked', 'resources')
  };
  
  assert.equal(pathsOverlap(path.join(releaseTarget, 'win-unpacked'), releaseTarget), true);
  assert.equal(pathsOverlap(installedController.execPath, releaseTarget), false);
  
  const safeBuild = evaluateControllerSafety({ operation: 'package', targetPaths: [releaseTarget], controllers: [installedController] });
  assert.equal(safeBuild.ok, true, 'packaging may run while an installed controller outside the output tree remains active');
  
  const blockedBuild = evaluateControllerSafety({ operation: 'package', targetPaths: [releaseTarget], controllers: [unpackedController] });
  assert.equal(blockedBuild.ok, false, 'packaging must not replace files used by an active unpacked controller');
  assert.equal(blockedBuild.blockingControllers[0].pid, unpackedController.pid);
  
  const releaseArtifact = path.join(releaseTarget, 'Rel.AI-MCP-1.0.0.exe');
  const siblingUnpacked = path.join(releaseTarget, 'unpacked-builds', 'win32-new');
  assert.equal(evaluateControllerSafety({ operation: 'package', targetPaths: [releaseArtifact], controllers: [unpackedController] }).ok, true,
    'an active unpacked controller must not block promotion of a sibling release artifact');
  assert.equal(evaluateControllerSafety({ operation: 'package', targetPaths: [siblingUnpacked], controllers: [unpackedController] }).ok, true,
    'an active unpacked controller must not block creation of an isolated sibling unpacked build');
  
  const blockedInstall = evaluateControllerSafety({ operation: 'install', targetPaths: [], controllers: [installedController] });
  assert.equal(blockedInstall.ok, false, 'production-identity install operations must stop when any Rel.AI controller is active');
  
  const discovered = discoverActiveControllers({
    markers: [{ pid: 5101, execPath: path.join(releaseTarget, 'build-check', 'win-unpacked', 'Rel.AI MCP.exe') }],
    processes: [
      { ProcessId: 5101, Name: 'Rel.AI MCP.exe', ExecutablePath: path.join(releaseTarget, 'build-check', 'win-unpacked', 'Rel.AI MCP.exe') },
      { ProcessId: 5102, Name: 'node.exe', CommandLine: 'node unrelated-service.js' },
      { ProcessId: 5103, Name: 'node.exe', CommandLine: 'node C:/Dev/rel-ai-mcp/bin/rel-ai-mcp-http.js' }
    ],
    isAlive: pid => pid !== 5102
  });
  assert.deepEqual(discovered.map(item => item.pid), [5101, 5103]);
  
  console.log('Active controller build and installer safety tests passed.');
}
await case_active_controller_guard_unit();

// Formerly analytics-reliability-unit.mjs
async function case_analytics_reliability_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/analyticsOutcome.js");
    const { OUTCOME_CLASSES, classifyAnalyticsOutcome } = __m4;
  
    const __m5 = await import("../src/analyticsFailureCategory.ts");
    const { failureCategoryFromEvent, normalizeFailureCategory } = __m5;
  
    const __m6 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m6;
  
    const __m7 = await import("../src/localAnalytics.js");
    const { flushLocalAnalytics, recordLocalToolOutcome, recordLocalTransportEvent, readLocalUsageSnapshot } = __m7;
  
    const __m8 = await import("../src/ui/features/usage/range-model.js");
    const { analyticsBounds, analyticsRangeScope, normalizeUsageSnapshot } = __m8;
  
    const __m9 = await import("../src/ui/features/usage/render.js");
    const { analyticsMetrics } = __m9;
  
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
      await flushLocalAnalytics({ stateDir: previousStateDir });
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
      await flushLocalAnalytics({ stateDir: v3StateDir });
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
}
await case_analytics_reliability_unit();

// Formerly analytics-taxonomy-unit.mjs
async function case_analytics_taxonomy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/analyticsTaxonomy.js");
    const { ANALYTICS_USE_CASES,
    analyticsTaskIntentLabel,
    analyticsUseCaseForOperation,
    analyticsUseCaseLabel,
    analyticsUseCaseShortLabel,
    isPrimaryAnalyticsUseCase,
    normalizeAnalyticsTaskIntent,
    normalizeAnalyticsUseCase } = __m1;
  
    const __m2 = await import("../src/tools/operationIds.js");
    const { OPERATION_ID_VALUES } = __m2;
  
  for (const operation of OPERATION_ID_VALUES) {
    assert.notEqual(analyticsUseCaseForOperation(operation), 'other', `operation ${operation} must have an explicit analytics use-case mapping`);
  }
  
  assert.equal(analyticsUseCaseForOperation('read'), 'explore');
  assert.equal(analyticsUseCaseForOperation('edit'), 'edit');
  assert.equal(analyticsUseCaseForOperation('process.start'), 'execute');
  assert.equal(analyticsUseCaseForOperation('validate.checks'), 'validate');
  assert.equal(analyticsUseCaseForOperation('browser'), 'browser');
  assert.equal(analyticsUseCaseForOperation('computer'), 'desktop');
  assert.equal(analyticsUseCaseForOperation('changes.restore'), 'review_recover');
  assert.equal(analyticsUseCaseForOperation('publish.push'), 'publish');
  assert.equal(analyticsUseCaseForOperation('work.finish'), 'work_session');
  assert.equal(analyticsUseCaseForOperation('future.unknown.operation'), 'other');
  
  assert.equal(normalizeAnalyticsUseCase('review_recover'), 'review_recover');
  assert.equal(normalizeAnalyticsUseCase('not-real'), 'other');
  assert.equal(isPrimaryAnalyticsUseCase('work_session'), false);
  assert.equal(isPrimaryAnalyticsUseCase('explore'), true);
  assert.equal(ANALYTICS_USE_CASES.filter(item => item.primary).length, 9);
  assert.equal(analyticsUseCaseLabel('review_recover'), 'Review & recover');
  assert.equal(analyticsUseCaseShortLabel('review_recover'), 'Review');
  
  assert.equal(normalizeAnalyticsTaskIntent('bugfix'), 'bugfix');
  assert.equal(normalizeAnalyticsTaskIntent('BUG-FIX', 'auto'), 'auto');
  assert.equal(normalizeAnalyticsTaskIntent('', 'untracked'), 'untracked');
  assert.equal(analyticsTaskIntentLabel('bugfix'), 'Bug fixes');
  assert.equal(analyticsTaskIntentLabel('auto'), 'Unclassified');
  assert.equal(analyticsTaskIntentLabel('untracked'), 'Untracked');
  
  console.log('Analytics taxonomy contracts passed.');
}
await case_analytics_taxonomy_unit();

// Formerly check-execution-unit.mjs
async function case_check_execution_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/workflow/checkCatalog.js");
    const { buildCheckCatalog, classifyCheckKind } = __m4;
  
    const __m5 = await import("../src/workflow/checkExecution.js");
    const { buildCheckExecutionStages, checkExecutionPolicy } = __m5;
  
    const __m6 = await import("../src/workflow/topology.js");
    const { discoverRepositoryTopology } = __m6;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-check-execution-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'check-execution-fixture',
      private: true,
      scripts: {
        lint: 'eslint .',
        'lint:fix': 'eslint . --fix',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        'test:all': 'npm run lint && npm run typecheck',
        'config:add': 'node bin/config.js workspace add',
        build: 'vite build'
      }
    }, null, 2));
  
    const catalog = buildCheckCatalog(discoverRepositoryTopology(root));
    const byName = name => catalog.find(item => item.id.endsWith(`:${name}`));
    const lint = byName('lint');
    const lintFix = byName('lint:fix');
    const typecheck = byName('typecheck');
    const test = byName('test');
    const testAll = byName('test:all');
    const configAdd = byName('config:add');
    const build = byName('build');
  
    assert.equal(classifyCheckKind('test:all', 'npm run lint && npm run typecheck'), 'test', 'script identity must win over nested tool names');
    assert.equal(configAdd.kind, 'other', 'configuration commands must not become validation checks');
    assert.equal(checkExecutionPolicy(lint).parallelSafe, true);
    assert.equal(checkExecutionPolicy(typecheck).parallelSafe, true);
    assert.equal(checkExecutionPolicy(lintFix).parallelSafe, false, 'mutating npm script bodies must stay serial');
    assert.equal(checkExecutionPolicy(test).parallelSafe, false, 'tests are not side-effect-free by default');
    assert.equal(checkExecutionPolicy(testAll).parallelSafe, false, 'composite test scripts must stay serial');
    assert.equal(checkExecutionPolicy(build).parallelSafe, false);
    assert.equal(
      checkExecutionPolicy({ command: 'npm run lint', kind: 'lint', scopeKey: 'package:root' }).parallelSafe,
      false,
      'unresolved npm wrappers must default to serial instead of trusting their names'
    );
    assert.equal(checkExecutionPolicy({ command: 'npm run lint:fix', scopeKey: 'repository' }).parallelSafe, false);
    assert.equal(checkExecutionPolicy({ command: 'npm run test:update', scopeKey: 'repository' }).parallelSafe, false);
    assert.equal(checkExecutionPolicy({ command: 'eslint . --fix', kind: 'lint', scopeKey: 'repository' }).parallelSafe, false);
    assert.equal(checkExecutionPolicy({ command: 'eslint .', kind: 'lint', scopeKey: 'repository' }).parallelSafe, true);
  
    const stages = buildCheckExecutionStages([lint, typecheck, test, build]);
    assert.equal(stages.length, 3);
    assert.equal(stages[0].parallel, true);
    assert.deepEqual(stages[0].items.map(item => item.policy.kind), ['lint', 'typecheck']);
    assert.equal(stages[1].parallel, false, 'test should be a serial barrier');
    assert.equal(stages[2].parallel, false, 'build should be a serial barrier');
  
    const unknown = checkExecutionPolicy({ command: 'node custom-check.js', kind: 'other', scopeKey: 'repository' });
    assert.equal(unknown.parallelSafe, false, 'unknown commands must stay serial by default');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Check execution policy resolves real script bodies and keeps mutation-capable work serial.');
}
await case_check_execution_unit();

// Formerly command-normalizer-unit.mjs
async function case_command_normalizer_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/commandNormalizer.js");
    const { normalizeCommandAlias } = __m1;
  
  const discovered = {
    'npm:test': 'npm test',
    'npm:lint': 'npm run lint',
    'go:test': 'go test ./...'
  };
  
  // 1. Falsy value → warning, command = key
  {
    const r = normalizeCommandAlias('mykey', '', discovered);
    assert.equal(r.normalized, false, 'falsy: normalized must be false');
    assert.equal(r.command, 'mykey', 'falsy: command falls back to key');
    assert.ok(r.warning, 'falsy: must have warning');
  }
  
  // 2. Value already matches a discovered command value → use as-is, no warning
  {
    const r = normalizeCommandAlias('something', 'npm test', discovered);
    assert.equal(r.normalized, false, 'canonical: normalized must be false');
    assert.equal(r.command, 'npm test', 'canonical: command unchanged');
    assert.equal(r.warning, undefined, 'canonical: no warning');
  }
  
  // 3. Key matches a discovered key → normalize to canonical form (key-match wins)
  {
    const r = normalizeCommandAlias('npm:lint', 'old-lint-command', discovered);
    assert.equal(r.normalized, true, 'key-match: normalized must be true');
    assert.equal(r.command, 'npm run lint', 'key-match: command is the discovered canonical form');
    assert.equal(r.originalValue, 'old-lint-command', 'key-match: originalValue preserved');
    assert.equal(r.warning, undefined, 'key-match: no warning');
  }
  
  // 3b. Key in discovered AND value matches another discovered value → key-match wins
  {
    // 'npm:lint' is in discovered; 'npm test' is a canonical value of 'npm:test'
    // Key-match must fire, not value-match
    const r = normalizeCommandAlias('npm:lint', 'npm test', discovered);
    assert.equal(r.normalized, true, 'key-wins: normalized must be true');
    assert.equal(r.command, 'npm run lint', 'key-wins: command from key lookup, not value lookup');
  }
  
  // 4. Value starts with recognized runnable prefix → use as-is, no warning
  {
    const r = normalizeCommandAlias('check', 'pytest --fast', discovered);
    assert.equal(r.normalized, false, 'runnable: normalized must be false');
    assert.equal(r.command, 'pytest --fast', 'runnable: command unchanged');
    assert.equal(r.warning, undefined, 'runnable: no warning');
  }
  
  // 5. Unknown/stale key, unrecognized value → warning present
  {
    const r = normalizeCommandAlias('old-renamed-key', 'some-obsolete-tool --run', discovered);
    assert.equal(r.normalized, false, 'stale: normalized must be false');
    assert.equal(r.command, 'some-obsolete-tool --run', 'stale: command unchanged');
    assert.ok(r.warning, 'stale: must have warning');
  }
  
  // 6. discoveredCommands is null → should not throw
  {
    const r = normalizeCommandAlias('mykey', 'some-cmd', null);
    assert.equal(r.normalized, false, 'null-disc: normalized must be false');
    assert.equal(r.command, 'some-cmd', 'null-disc: command unchanged');
  }
  
  console.log('commandNormalizer unit tests passed.');
}
await case_command_normalizer_unit();

// Formerly diagnostic-files-unit.mjs
async function case_diagnostic_files_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/diagnostic-files.js");
    const { createDiagnosticFiles, fileTimestamp } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-diagnostic-files-'));
  let opened = '';
  const files = createDiagnosticFiles({
    app: { getPath: name => name === 'userData' ? root : '' },
    shell: { openPath: async target => { opened = target; return ''; } },
    now: () => new Date('2026-07-25T07:30:45.123Z')
  });
  
  try {
    assert.equal(files.directory(), path.join(root, 'diagnostics'));
    assert.equal(files.serviceLogPath(), path.join(root, 'diagnostics', 'service.log'));
    assert.equal(fileTimestamp(new Date('2026-07-25T07:30:45.123Z')), '20260725-073045Z');
  
    const exported = await files.exportReport({ ok: true, token: 'secret', nested: { password: 'hidden', safe: 'visible' } });
    assert.equal(exported.filename, 'relai-diagnostic-state-20260725-073045Z.json');
    assert.equal(fs.existsSync(exported.path), true);
    const payload = JSON.parse(fs.readFileSync(exported.path, 'utf8'));
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.report.token, '[redacted]');
    assert.equal(payload.report.nested.password, '[redacted]');
    assert.equal(payload.report.nested.safe, 'visible');
  
    const openedResult = await files.openFolder();
    assert.equal(openedResult.ok, true);
    assert.equal(opened, files.directory());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Diagnostic files unit passed');
}
await case_diagnostic_files_unit();

// Formerly diagnostics-unit.mjs
async function case_diagnostics_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/diagnostics.js");
    const { sanitizeText, sanitizeDiagnosticValue, buildDiagnosticReport } = __m1;
  
  const secret = 'super-secret-value';
  const sanitized = sanitizeText([
    `Authorization: Bearer ${secret}`,
    `https://example.test/dashboard?token=${secret}&bootstrap=${secret}&code=${secret}`,
    `api_key: ${secret}`,
    `{"token":"${secret}","password":"${secret}"}`
  ].join('\n'));
  assert.doesNotMatch(sanitized, new RegExp(secret));
  assert.match(sanitized, /\[redacted\]/);
  
  const objectValue = sanitizeDiagnosticValue({
    token: secret,
    nested: { clientSecret: secret, safe: 'visible' },
    list: [{ authorization: secret }]
  });
  assert.equal(objectValue.token, '[redacted]');
  assert.equal(objectValue.nested.clientSecret, '[redacted]');
  assert.equal(objectValue.nested.safe, 'visible');
  assert.equal(objectValue.list[0].authorization, '[redacted]');
  
  const report = buildDiagnosticReport({
    workspace: 'example',
    application: { version: '1.0.1', build: 'aaaa1111bbbb' },
    health: { findings: [{ severity: 'error', code: 'workspace_unavailable', workspace: 'example', path: 'C:/missing', message: `token=${secret}` }] },
    aliasCheck: { workspaces: [{ alias: 'example', staleKeys: ['npm:test:old'] }] },
    cautionData: { windowHours: 24, workspaces: [{ alias: 'example', count: 1, recent: [{ tool: 'relai_edit', ts: '2026-07-25T00:00:00.000Z', reason: `Bearer ${secret}` }] }] },
    connection: { tunnelId: 'tunnel_12345678', token: 'set' },
    connectionState: { publicEndpoint: { status: 'available' }, error: { code: 'local_port_in_use', message: `password=${secret}` } },
    runtimeLogs: {
      available: true,
      persistent: true,
      revision: 7,
      persistence: { healthy: true, failureCount: 0, lastFailureAt: null, lastError: '' },
      entries: [
        { ts: '2026-07-25T00:03:00.000Z', level: 'info', source: 'desktop-observability', code: 'activity_listener_failed', taskId: 'task-runtime-7', eventId: 'event-runtime-7', workspace: 'example', tool: 'relai_read', operation: 'Read src/app.js', message: 'third' },
        { ts: '2026-07-25T00:01:00.000Z', level: 'error', source: 'openai-tunnel', code: 'public_endpoint_failed', message: `{"token":"${secret}"}` },
        { ts: '2026-07-25T00:02:00.000Z', level: 'warning', source: 'local-service', message: 'second' }
      ]
    },
    auditLogs: {
      entries: [
        { ts: '2026-07-25T00:04:00.000Z', eventId: 'event-edit-1', taskId: 'task-42', ok: false, tool: 'relai_edit', workspace: 'example', errorCode: 'PATCH_CONTEXT_MISMATCH', error: 'fourth failure' },
        { ts: '2026-07-25T00:02:00.000Z', ok: true, tool: 'relai_read', workspace: 'example' },
        { ts: '2026-07-25T00:03:00.000Z', ok: false, tool: 'relai_validate', workspace: 'example', error: `client_secret=${secret}` }
      ]
    },
    activeCalls: 2
  });
  
  assert.equal(report.ok, true);
  assert.deepEqual(report.application, { version: '1.0.1', build: 'aaaa1111bbbb' });
  assert.ok(report.summary.blocking >= 1);
  assert.ok(report.findings.some(item => item.code === 'workspace_unavailable'));
  assert.ok(report.findings.every(item => item.action?.href));
  assert.equal(report.findings.some(item => item.code === 'public_endpoint_failed'), false, 'a connected Secure MCP Tunnel must not be reported unavailable');
  assert.equal('maintenance' in report, false, 'Troubleshooting reports must not advertise duplicate data-clearing controls owned by App settings');
  assert.equal(report.logs.runtime.persistent, true);
  assert.equal(report.logs.runtime.revision, 7, 'diagnostic snapshots must preserve the runtime-log revision for live replay ordering');
  assert.equal(report.logs.runtime.persistence.healthy, true);
  assert.deepEqual(report.logs.runtime.entries.map(item => item.ts), ['2026-07-25T00:01:00.000Z','2026-07-25T00:02:00.000Z','2026-07-25T00:03:00.000Z']);
  assert.equal(report.logs.runtime.entries.at(-1).code, 'activity_listener_failed', 'technical log codes must not collapse to a generic UI error code');
  assert.equal(report.logs.runtime.entries.at(-1).taskId, 'task-runtime-7');
  assert.equal(report.logs.runtime.entries.at(-1).eventId, 'event-runtime-7');
  assert.equal(report.logs.runtime.entries.at(-1).tool, 'relai_read');
  assert.equal(report.logs.failedActivity.length, 2);
  assert.equal(report.logs.failedActivity.at(-1).taskId, 'task-42');
  assert.equal(report.logs.failedActivity.at(-1).eventId, 'event-edit-1');
  assert.equal(report.logs.failedActivity.at(-1).errorCode, 'PATCH_CONTEXT_MISMATCH');
  assert.match(report.reportText, /code=activity_listener_failed/);
  assert.match(report.reportText, /task=task-runtime-7 event=event-runtime-7 tool=relai_read operation=Read src\/app\.js/);
  assert.match(report.reportText, /code=PATCH_CONTEXT_MISMATCH workspace=example task=task-42 event=event-edit-1/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  assert.match(report.reportText, /Rel\.AI MCP diagnostic report/);
  assert.match(report.reportText, /Version: 1\.0\.1/);
  assert.match(report.reportText, /Build: aaaa1111bbbb/);
  assert.doesNotMatch(report.reportText, new RegExp(secret));
  
  const persistenceFailure = buildDiagnosticReport({
    connection: { tunnelId: 'tunnel_12345678', token: 'set' },
    connectionState: { publicEndpoint: { status: 'available' }, error: null },
    runtimeLogs: {
      available: true,
      persistent: true,
      entries: [],
      persistence: { healthy: false, failureCount: 2, lastFailureAt: '2026-07-25T00:05:30.000Z', lastError: `EACCES token=${secret}` }
    },
    taskHistoryPersistence: {
      healthy: false,
      pending: 2,
      retryCount: 3,
      lastFailureAt: '2026-07-25T00:05:15.000Z',
      lastError: `ENOSPC password=${secret}`
    },
    auditLogs: {
      entries: [],
      persistence: {
        healthy: false,
        pending: 3,
        retryCount: 4,
        droppedEntries: 0,
        lastFailureAt: '2026-07-25T00:05:00.000Z',
        lastError: `EACCES password=${secret}`
      }
    }
  });
  const persistenceFinding = persistenceFailure.findings.find(item => item.code === 'local_history_persistence_failed');
  assert.ok(persistenceFinding, 'persistent audit write failures must become a visible troubleshooting finding');
  assert.match(persistenceFinding.title, /Activity history/);
  assert.match(persistenceFinding.recommendation, /disk space|write permissions/i);
  assert.doesNotMatch(JSON.stringify(persistenceFinding), new RegExp(secret), 'technical persistence errors must still be sanitized');
  const taskHistoryPersistenceFinding = persistenceFailure.findings.find(item => item.code === 'task_history_persistence_failed');
  assert.ok(taskHistoryPersistenceFinding, 'persistent task-history write failures must become a visible troubleshooting finding');
  assert.match(taskHistoryPersistenceFinding.title, /Task history/);
  assert.match(taskHistoryPersistenceFinding.recommendation, /bounded backoff|disk space|write permissions/i);
  assert.doesNotMatch(JSON.stringify(taskHistoryPersistenceFinding), new RegExp(secret), 'task-history persistence errors must be sanitized');
  const runtimePersistenceFinding = persistenceFailure.findings.find(item => item.code === 'runtime_log_persistence_failed');
  assert.ok(runtimePersistenceFinding, 'persistent app-log write failures must become a visible troubleshooting finding');
  assert.match(runtimePersistenceFinding.title, /App log/);
  assert.match(runtimePersistenceFinding.recommendation, /disk space|write permissions/i);
  assert.doesNotMatch(JSON.stringify(runtimePersistenceFinding), new RegExp(secret), 'app-log persistence errors must be sanitized');
  
  const disconnected = buildDiagnosticReport({
    connection: { tunnelId: '', token: 'set' },
    connectionState: { publicEndpoint: { status: 'disabled' }, error: null },
    runtimeLogs: { available: false, entries: [] },
    activeCalls: 0
  });
  const disconnectedTunnelFinding = disconnected.findings.find(item => item.code === 'public_endpoint_failed');
  assert.ok(disconnectedTunnelFinding);
  assert.equal(disconnectedTunnelFinding.action.kind, 'restart_connection');
  assert.equal(disconnectedTunnelFinding.action.label, 'Retry now');
  assert.equal(disconnectedTunnelFinding.action.href, '#settings/connection');
  assert.equal(disconnected.findings.some(item => item.code === 'configuration_invalid'), false);
  
  const missingBearer = buildDiagnosticReport({
    connection: { tunnelId: 'tunnel_12345678', token: 'missing' },
    connectionState: { publicEndpoint: { status: 'available' }, error: null },
    runtimeLogs: { available: false, entries: [] }
  });
  assert.ok(missingBearer.findings.some(item => item.code === 'configuration_invalid'));
  assert.equal(JSON.stringify(missingBearer).includes('approval_token'), false);
  
  console.log('Secure tunnel diagnostics and sanitization tests passed.');
}
await case_diagnostics_unit();

// Formerly error-enhancer-unit.mjs
async function case_error_enhancer_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools.js");
    const { enhanceToolError } = __m1;
  
    const __m2 = await import("../src/tools/errors.js");
    const { serializeToolError } = __m2;
  
  assert.ok(typeof enhanceToolError === 'function');
  assert.ok(typeof serializeToolError === 'function');
  
  {
    const error = enhanceToolError('relai_edit', new Error('relai_edit operation 1 found 0 matches in lib/foo.dart.'));
    assert.match(error.message, /relai_read/);
    assert.match(error.message, /relai_edit with content/);
  }
  
  {
    const error = enhanceToolError('relai_edit', new Error('relai_edit operation 1 found 5 matches in lib/foo.dart.'));
    assert.match(error.message, /occurrence/);
  }
  
  {
    const error = enhanceToolError('relai_edit', new Error('ValueError: Invalid IPv6 URL'));
    assert.match(error.message, /content, updateText/);
  }
  
  for (const message of ['error: corrupt patch at line 24', 'Patch did not contain any valid workspace file paths.']) {
    const error = enhanceToolError('relai_edit', new Error(message));
    assert.match(error.message, /Git unified diff/);
    assert.match(error.message, /structured OpenAI patch format/);
  }
  
  {
    const error = enhanceToolError('relai_edit', new Error('OpenAI patch context mismatch.'));
    assert.match(error.message, /Re-read the file/);
  }
  
  {
    const original = new Error('Something else entirely.');
    assert.equal(enhanceToolError('relai_validate', original), original);
  }
  
  {
    const restricted = new Error('Path touches a blocked sensitive path: .env');
    restricted.code = 'SENSITIVE_PATH_RESTRICTED';
    restricted.source = 'rel-ai-mcp-policy';
    restricted.path = '.env';
    restricted.fileClass = 'secret_bearing_path';
    restricted.retryable = false;
    restricted.requiresUserConfirmation = false;
    restricted.allowedAlternatives = ['Use .env.example.'];
    const payload = serializeToolError('relai_read', restricted);
    assert.equal(payload.errorCode, 'SENSITIVE_PATH_RESTRICTED');
    assert.equal(payload.errorDetails.source, 'rel-ai-mcp-policy');
    assert.equal(payload.errorDetails.operation, 'read');
    assert.equal(payload.errorDetails.path, '.env');
    assert.deepEqual(payload.errorDetails.allowedAlternatives, ['Use .env.example.']);
  }
  
  console.log('Error enhancer unit tests passed for active tools.');
}
await case_error_enhancer_unit();

// Formerly full-write-concurrency-unit.mjs
async function case_full_write_concurrency_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("../src/localRepoBridge.js");
    const { workspaceWrite } = __m5;
  
    const __m6 = await import("../src/executionPlanner.js");
    const { planEdit } = __m6;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-full-write-concurrency-'));
  const workspace = {
    alias: 'repo',
    path: root,
    testCommands: {},
    commands: {},
    context: { snapshotMaxFiles: 100 }
  };
  const config = {
    stateDir: path.join(root, '.state'),
  };
  const target = path.join(root, 'config.txt');
  const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  
  try {
    fs.writeFileSync(target, 'version=1\n');
    const originalSha = sha('version=1\n');
  
    const direct = workspaceWrite(workspace, config, {
      path: 'config.txt',
      content: 'version=2\n',
      expectedSha256: originalSha
    });
    assert.equal(direct.ok, true);
    assert.equal(direct.result.oldSha256, originalSha);
    assert.equal(fs.readFileSync(target, 'utf8'), 'version=2\n');
  
    assert.throws(
      () => workspaceWrite(workspace, config, {
        path: 'config.txt',
        content: 'version=3\n',
        expectedSha256: originalSha
      }),
      /refused stale expectedSha256/,
      'direct full-file writes must reject a stale hash'
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'version=2\n');
  
    const currentSha = sha('version=2\n');
    const planned = await planEdit(workspace, config, {
      path: 'config.txt',
      content: 'version=3\n',
      expectedSha256: currentSha
    });
    assert.equal(planned.ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), 'version=3\n');
  
    await assert.rejects(
      () => planEdit(workspace, config, {
        path: 'config.txt',
        content: 'version=4\n',
        expectedSha256: currentSha
      }),
      /refused stale expectedSha256/,
      'relai_edit content mode must reject a stale hash'
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'version=3\n');
  
    const stagedStartSha = sha('version=3\n');
    const start = workspaceWrite(workspace, config, {
      stage: 'start',
      path: 'config.txt',
      content: 'version=',
      expectedSha256: stagedStartSha
    });
    workspaceWrite(workspace, config, { stage: 'append', writeId: start.writeId, content: '4\n' });
    fs.writeFileSync(target, 'user-change=true\n');
    assert.throws(
      () => workspaceWrite(workspace, config, { stage: 'commit', writeId: start.writeId }),
      /refused stale expectedSha256/,
      'staged writes must preserve the hash captured at start and reject a changed target at commit'
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'user-change=true\n');
  
    console.log('Full-file write concurrency protection passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_full_write_concurrency_unit();

// Formerly http-sse-backpressure-unit.mjs
async function case_http_sse_backpressure_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:events");
    const { EventEmitter } = __m1;
  
    const __m2 = await import("../src/http/io.ts");
    const { createSseWriter } = __m2;
  
  class FakeResponse extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    blocked = true;
    writes = [];
  
    write(value) {
      this.writes.push(String(value));
      return !this.blocked;
    }
  
    destroy() {
      this.destroyed = true;
      this.emit('close');
    }
  }
  
  const response = new FakeResponse();
  const stream = createSseWriter(response, { maxQueuedBytes: 256 });
  assert.equal(stream.send('first', { value: 1 }, { id: 'stream:1' }), true);
  assert.equal(response.writes.length, 1, 'the first frame should be attempted immediately');
  const second = stream.send('second', { value: 2 });
  const third = stream.send('third', { value: 3 });
  assert.equal(second, true);
  assert.equal(third, true);
  assert.ok(stream.queuedBytes > 0, 'frames should remain queued while the response is backpressured');
  
  response.blocked = false;
  response.emit('drain');
  assert.equal(stream.queuedBytes, 0, 'drain should release all queued frames');
  assert.deepEqual(response.writes.map(frame => frame.match(/^event: ([^\n]+)/m)?.[1]), ['first', 'second', 'third']);
  
  let overflowNotified = false;
  const overflowResponse = new FakeResponse();
  const overflowStream = createSseWriter(overflowResponse, {
    maxQueuedBytes: 64,
    onOverflow: () => { overflowNotified = true; }
  });
  overflowStream.send('first', 'x');
  assert.equal(overflowStream.send('large', 'x'.repeat(100)), false);
  assert.equal(overflowNotified, true, 'queue overflow should notify the connection owner');
  assert.equal(overflowResponse.destroyed, true, 'queue overflow should close a slow response');
  
  console.log('HTTP SSE FIFO, drain, and bounded queue tests passed.');
}
await case_http_sse_backpressure_unit();

// Formerly ipc-channel-contract-unit.mjs
async function case_ipc_channel_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1;
  
    const __m2 = await import("../electron/ipc-handlers.js");
    const { registerIpcHandlers } = __m2;
  
    const __m3 = await import("../src/contracts/desktop.ts");
    const { DESKTOP_IPC, DESKTOP_IPC_CHANNELS, DESKTOP_IPC_INPUT_CONTRACT } = __m3;
  
  const inventory = DESKTOP_IPC_INPUT_CONTRACT;
  
  const windows = { wizard: { id: 'wizard' }, fallback: { id: 'fallback' }, dashboard: { id: 'dashboard' }, pulse: { id: 'pulse' }, other: { id: 'other' } };
  const handles = new Map();
  const listeners = new Map();
  const calls = [];
  const ipcMain = {
    handle(channel, handler) { assert.equal(handles.has(channel) || listeners.has(channel), false, `duplicate IPC registration: ${channel}`); handles.set(channel, handler); },
    on(channel, handler) { assert.equal(handles.has(channel) || listeners.has(channel), false, `duplicate IPC registration: ${channel}`); listeners.set(channel, handler); }
  };
  
  registerIpcHandlers({
    ipcMain,
    BrowserWindow: { fromWebContents: sender => sender?.window || null },
    clipboard: { writeText: value => calls.push(['clipboard', value]) },
    shell: { openExternal: async value => { calls.push(['openExternal', value]); } },
    getWizardWindow: () => windows.wizard,
    closeWizard: value => calls.push(['closeWizard', value]),
    getFallbackWindow: () => windows.fallback,
    getDashboardWindow: () => windows.dashboard,
    getPulseWindow: () => windows.pulse,
    setPulseExpanded: value => { calls.push(['pulseExpanded', value]); return value; },
    getRecoveryConfig: () => ({ ok: true, tunnelId: 'tunnel_12345678', tunnelApiKeyConfigured: true, port: 3333 }),
    setTunnelApiKey: value => calls.push(['tunnelKey', value]),
    saveLauncherConfig: value => calls.push(['save', value]),
    launchConfiguredDesktop: async value => { calls.push(['launch', value]); return { serverRunning: true, tunnelStatus: 'running' }; },
    restartConnection: async () => { calls.push(['restartConnection']); return { serverRunning: true, tunnelStatus: 'running' }; },
    relaunchApplication: async () => { calls.push(['relaunch']); return { ok: true }; },
    logoutApplication: async value => { calls.push(['logout', value]); return { ok: true, ...value }; },
    quitApplication: async () => { calls.push(['quit']); return { ok: true }; },
    openRecoverySetup: () => ({ ok: true }),
    openDashboardWindow: () => ({ ok: true }),
    getNotificationsEnabled: () => true,
    setNotificationsEnabled: value => value,
    startServer: () => ({ serverRunning: true }),
    stopServer: () => { calls.push(['stop']); return { serverRunning: false }; },
    getCurrentStatus: () => ({ serverRunning: true }),
    getDashboardWindowState: () => ({ maximized: false }),
    minimizeDashboardWindow: () => ({ minimized: true }),
    toggleDashboardMaximize: () => ({ maximized: true }),
    requestDashboardClose: () => ({ ok: true }),
    openSettingsWindow: () => ({ ok: true }),
    getBrowserState: () => ({ sessionId: '', pages: [] }),
    setBrowserSurfaceBounds: value => ({ ok: true, value }),
    setBrowserControl: value => ({ ok: true, value }),
    selectBrowserSession: value => ({ ok: true, value }),
    selectBrowserTab: value => ({ ok: true, value }),
    closeBrowserTab: value => ({ ok: true, value }),
    stopActiveBrowserSession: () => ({ ok: true }),
    getLocalUsage: month => ({ ok: true, month, source: 'local' }),
    getDesktopSettings: () => ({ ok: true }),
    saveDesktopSettings: value => ({ ok: true, value }),
    getLifecycleStatus: () => ({ ok: true }),
    acknowledgeConnectorRefresh: () => ({ ok: true }),
    setLaunchAtLogin: value => value,
    setKeepAwake: value => value,
    setAppPreferences: value => ({ ok: true, status: value }),
    getLocalDataUsage: () => ({ ok: true, totalBytes: 0 }),
    clearTemporaryLocalData: () => ({ ok: true }),
    openLocalDataFolder: () => ({ ok: true }),
    getNotificationPreferences: () => ({ enabled: true }),
    updateNotificationPreferences: value => ({ ok: true, preferences: value }),
    getUpdateStatus: () => ({ state: 'idle' }),
    checkForUpdates: () => ({ ok: true }),
    downloadUpdate: () => ({ ok: true }),
    installUpdate: () => ({ ok: true }),
    exportDiagnosticState: value => ({ ok: true, value }),
    openDiagnosticsFolder: () => ({ ok: true }),
    runTunnelDoctor: () => ({ ok: true, result: 'pass' }),
    getTaskCodeWorkspace: value => ({ ok: true, value }),
    readTaskCodeDiff: value => ({ ok: true, value }),
    listCodeEditors: () => ({ ok: true, editors: [{ id: 'system', label: 'File Explorer' }] }),
    openTaskCodeIde: value => ({ ok: true, value }),
    fitWindowToContent: (window, value) => calls.push(['fit', window.id, value])
  });
  
  assert.deepEqual([...handles.keys()].sort(), Object.keys(inventory).filter(channel => inventory[channel].mode === 'handle').sort());
  assert.deepEqual([...listeners.keys()].sort(), Object.keys(inventory).filter(channel => inventory[channel].mode === 'on').sort());
  
  for (const [channel, expected] of Object.entries(inventory)) {
    const handler = expected.mode === 'handle' ? handles.get(channel) : listeners.get(channel);
    assert.equal(typeof handler, 'function', channel);
    if (expected.failure === 'reject') assert.throws(() => handler(eventFor(windows.other), ...argsFor(channel)), /not available to this renderer/, channel);
    else assert.doesNotThrow(() => handler(eventFor(windows.other), ...argsFor(channel)), channel);
    for (const windowName of expected.windows) {
      const result = handler(eventFor(windows[windowName]), ...argsFor(channel));
      if (result && typeof result.then === 'function') await result;
    }
  }
  
  assert.throws(() => handles.get('url:copy')(eventFor(windows.wizard), 'x'.repeat(64 * 1024 + 1)), /64 KiB/);
  assert.throws(() => handles.get('desktop:logout')(eventFor(windows.dashboard), { clearData: 'yes' }), /clearData as a boolean/);
  const logout = await handles.get('desktop:logout')(eventFor(windows.dashboard), { clearData: true });
  assert.equal(logout.clearData, true);
  assert.ok(calls.some(call => call[0] === 'logout' && call[1].clearData === true));
  const done = await handles.get('wizard:done')(eventFor(windows.wizard), { tunnelId: 'tunnel_12345678', tunnelApiKey: 'runtime-api-key-value', port: 3333, restart: false });
  assert.equal(done.ok, true);
  assert.ok(calls.some(call => call[0] === 'tunnelKey' && call[1] === 'runtime-api-key-value'));
  assert.ok(calls.some(call => call[0] === 'save' && call[1].tunnelId === 'tunnel_12345678'));
  assert.equal([...handles.keys()].some(channel => /gateway|approval|cloud|open-link/i.test(channel)), false);
  assert.ok(calls.some(call => call[0] === 'fit' && call[1] === 'wizard'));
  assert.ok(calls.some(call => call[0] === 'fit' && call[1] === 'fallback'));
  
  const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const preloadChannels = new Set([
    ...[...preloadSource.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]),
    ...[...preloadSource.matchAll(/subscribe\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
  ]);
  for (const channel of preloadChannels) {
    assert.ok(DESKTOP_IPC_CHANNELS.includes(channel), `preload channel must exist in canonical desktop contract: ${channel}`);
  }
  for (const channel of Object.keys(DESKTOP_IPC_INPUT_CONTRACT)) {
    assert.ok(preloadChannels.has(channel), `canonical renderer-to-main IPC channel must be exposed by preload: ${channel}`);
  }
  assert.equal(DESKTOP_IPC.DESKTOP_GET_STATUS, 'desktop:get-status');
  
  console.log(`${Object.keys(inventory).length} tunnel-only IPC channel contracts passed.`);
  function eventFor(window) { return { sender: { window } }; }
  function argsFor(channel) {
    switch (channel) {
      case 'wizard:done': return [{ tunnelId: 'tunnel_12345678', tunnelApiKey: 'runtime-api-key-value', port: 3333, restart: false }];
      case 'wizard:open-openai-setup': return ['tunnels'];
      case 'url:copy': return ['safe text'];
      case 'desktop:analytics:local': return ['2026-08'];
      case 'desktop:settings:save': return [{ port: 3333, tunnelId: 'tunnel_12345678' }];
      case 'desktop:reload-dashboard': return ['#tasks'];
      case 'desktop:browser:set-bounds': return [{ visible: false }];
      case 'desktop:browser:set-control': return ['user'];
      case 'desktop:browser:select-session': return ['embedded_browser_1234567890abcdef'];
      case 'desktop:browser:select-tab':
      case 'desktop:browser:close-tab': return ['embedded_page_1234567890abcdef'];
      case 'desktop:logout': return [{ clearData: false }];
      case 'desktop:app-preferences:set': return [{ keepRunningOnClose: true }];
      case 'desktop:startup:set':
      case 'desktop:keep-awake:set':
      case 'desktop:notifications:set':
      case 'desktop:notification-preferences:set':
      case 'notifications:set-enabled': return [true];
      case 'desktop:diagnostics:export': return [{ status: 'ready' }];
      case 'desktop:code:get': return [{ taskId: 'task-1' }];
      case 'desktop:code:diff': return [{ taskId: 'task-1', path: 'src/index.js' }];
      case 'desktop:code:open-ide': return [{ taskId: 'task-1', editorId: 'system' }];
      case 'window:fit-content': return [{ width: 500, height: 600 }];
      case 'pulse:set-expanded': return [true];
      default: return [];
    }
  }
}
await case_ipc_channel_contract_unit();

// Formerly native-task-protocol-unit.mjs
async function case_native_task_protocol_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("@modelcontextprotocol/server");
    const { CLIENT_CAPABILITIES_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    SERVER_INFO_META_KEY } = __m4;
  
    const __m5 = await import("../src/mcp/nativeTaskService.js");
    const { createNativeTask,
    requestNativeTaskInput } = __m5;
  
    const __m6 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m6;
  
    const __m7 = await import("../src/mcp/protocol.js");
    const { INVALID_TASKS_CAPABILITY_CODE,
    MCP_PROTOCOL_VERSION,
    MISSING_TASKS_CAPABILITY_CODE,
    TASKS_EXTENSION_REVISION } = __m7;
  
    const __m8 = await import("../src/mcp/transportTasks.js");
    const { handleTransportTaskRequest } = __m8;
  
  const extensionId = 'io.modelcontextprotocol/tasks';
  const tasksCapability = { extensions: { [extensionId]: { revision: TASKS_EXTENSION_REVISION } } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-task-protocol-'));
  const config = { stateDir: root };
  let resumeCount = 0;
  let resumedWith = null;
  
  function message(id, method, params = {}, capabilities = tasksCapability) {
    return {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: capabilities
        }
      }
    };
  }
  
  function handle(targetConfig, request, principal = 'principal-a') {
    return handleTransportTaskRequest(targetConfig, request, {
      principal,
      transportType: 'test'
    });
  }
  
  try {
    const created = createNativeTask(config, {
      principal: 'principal-a',
      method: 'tools/call',
      name: 'input-round-trip-test',
      executor: {
        resume(inputResponses) {
          resumeCount += 1;
          resumedWith = inputResponses;
        }
      }
    });
    requestNativeTaskInput(config, created.taskId, {
      approval: { mode: 'elicitation', message: 'Approve?' },
      note: { mode: 'elicitation', message: 'Add a note.' }
    }, { principal: 'principal-a' });
  
    const waiting = await handle(config, message(1, 'tasks/get', { taskId: created.taskId }));
    assert.equal(waiting.body.result.status, 'input_required');
    assert.ok(waiting.body.result._meta?.[SERVER_INFO_META_KEY]);
    assert.deepEqual(Object.keys(waiting.body.result.inputRequests).sort(), ['approval', 'note']);
  
    const partial = await handle(config, message(2, 'tasks/update', {
      taskId: created.taskId,
      inputResponses: {
        approval: { approved: true },
        unknown: { ignored: true }
      }
    }));
    assert.equal(partial.body.result.resultType, 'complete');
    assert.ok(partial.body.result._meta?.[SERVER_INFO_META_KEY]);
    const afterPartial = await handle(config, message(3, 'tasks/get', { taskId: created.taskId }));
    assert.equal(afterPartial.body.result.status, 'input_required');
    assert.deepEqual(Object.keys(afterPartial.body.result.inputRequests), ['note']);
    assert.equal(resumeCount, 0);
  
    const fulfilled = await handle(config, message(4, 'tasks/update', {
      taskId: created.taskId,
      inputResponses: { note: { text: 'Proceed.' } }
    }));
    assert.equal(fulfilled.body.result.resultType, 'complete');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resumeCount, 1);
    assert.deepEqual(resumedWith, {
      approval: { approved: true },
      note: { text: 'Proceed.' }
    });
  
    const replay = await handle(config, message(5, 'tasks/update', {
      taskId: created.taskId,
      inputResponses: { note: { text: 'Replay.' } }
    }));
    assert.equal(replay.body.error, undefined);
    assert.equal(replay.body.result.resultType, 'complete');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resumeCount, 1, 'already satisfied input must not resume the executor twice');
  
    const missingCapability = await handle(
      config,
      message(6, 'tasks/get', { taskId: created.taskId }, {})
    );
    assert.equal(missingCapability.body.error.code, MISSING_TASKS_CAPABILITY_CODE);
    assert.deepEqual(
      missingCapability.body.error.data.requiredCapabilities.extensions[extensionId],
      { revision: TASKS_EXTENSION_REVISION }
    );
  
    const malformedCapability = await handle(
      config,
      message(7, 'tasks/get', { taskId: created.taskId }, { extensions: [] })
    );
    assert.equal(malformedCapability.body.error.code, INVALID_TASKS_CAPABILITY_CODE);
    assert.deepEqual(malformedCapability.body.error.data, {
      reason: 'invalid_client_capabilities',
      capabilityReason: 'malformed_extensions',
      expectedCapabilities: tasksCapability
    });
  
    const wrongPrincipal = await handle(
      config,
      message(8, 'tasks/get', { taskId: created.taskId }),
      'principal-b'
    );
    const unknownTask = await handle(
      config,
      message(9, 'tasks/get', { taskId: 'task_invalid' })
    );
    assert.equal(wrongPrincipal.body.error.code, -32602);
    assert.equal(unknownTask.body.error.code, -32602);
    assert.equal(wrongPrincipal.body.error.message, unknownTask.body.error.message);
  
    const malformedInput = await handle(config, message(10, 'tasks/update', {
      taskId: created.taskId,
      inputResponses: []
    }));
    assert.equal(malformedInput.body.error.code, -32602);
    assert.match(malformedInput.body.error.message, /input map must be an object/i);
  
    const emptyInput = await handle(config, message(11, 'tasks/update', {
      taskId: created.taskId,
      inputResponses: {}
    }));
    assert.equal(emptyInput.body.error.code, -32602);
    assert.match(emptyInput.body.error.message, /at least one response/i);
  
    const unknownOnly = createNativeTask(config, {
      principal: 'principal-a',
      method: 'tools/call',
      name: 'unknown-input-test',
      executor: { controller: new AbortController() }
    });
    requestNativeTaskInput(config, unknownOnly.taskId, {
      approval: { mode: 'elicitation', message: 'Approve?' }
    }, { principal: 'principal-a' });
    const unmatchedInput = await handle(config, message(12, 'tasks/update', {
      taskId: unknownOnly.taskId,
      inputResponses: { unknown: true }
    }));
    assert.equal(unmatchedInput.body.error, undefined);
    assert.equal(unmatchedInput.body.result.resultType, 'complete');
    const unknownOnlyState = await handle(config, message(13, 'tasks/get', { taskId: unknownOnly.taskId }));
    assert.equal(unknownOnlyState.body.result.status, 'input_required');
  
    const notification = message(undefined, 'tasks/get', { taskId: unknownOnly.taskId });
    delete notification.id;
    const notificationResult = await handle(config, notification);
    assert.equal(notificationResult.status, 204);
    assert.equal(notificationResult.body, null);
  
    const corrupt = createNativeTask(config, {
      principal: 'principal-a',
      method: 'tools/call',
      name: 'protocol-corruption-test',
      restartPolicy: 'restart_reconcilable',
      recovery: { mode: 'deadline', completeAtMs: Date.now() + 60_000, result: { ok: true } }
    });
    withStateDatabase(config, db => db.prepare('UPDATE native_tasks SET payload=? WHERE task_id=?').run('{corrupt', corrupt.taskId), { transaction: true });
    const corruptResponse = await handle(config, message(14, 'tasks/get', { taskId: corrupt.taskId }));
    assert.equal(corruptResponse.body.error.code, -32603);
    assert.equal(corruptResponse.body.error.message, 'Native task record is corrupt.');
    assert.deepEqual(corruptResponse.body.error.data, {
      reason: 'task_record_corrupt',
      retryable: false
    });
    assert.doesNotMatch(JSON.stringify(corruptResponse), /[A-Za-z]:\\|\/Users\/|\/home\//);
    assert.equal(withStateDatabase(config, db => Number(db.prepare('SELECT COUNT(*) AS count FROM native_tasks WHERE task_id=?').get(corrupt.taskId)?.count || 0)), 0);
  
    const blockedState = path.join(root, 'blocked-state');
    fs.writeFileSync(blockedState, 'not a directory', 'utf8');
    const storageFailure = await handle(
      { stateDir: blockedState },
      message(15, 'tasks/get', { taskId: `task_${'A'.repeat(43)}` })
    );
    assert.equal(storageFailure.body.error.code, -32603);
    assert.equal(storageFailure.body.error.message, 'Native task storage is unavailable.');
    assert.equal(storageFailure.body.error.data.retryable, true);
    assert.doesNotMatch(JSON.stringify(storageFailure), /[A-Za-z]:\\|\/Users\/|\/home\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Canonical native task wire routing, input validation, capability gating, corruption handling, and ownership non-disclosure passed.');
}
await case_native_task_protocol_unit();

// Formerly operation-task-parity-unit.mjs
async function case_operation_task_parity_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/mcp/nativeToolTasks.js");
    const { completeNativeToolTask,
    createNativeToolTask,
    failNativeToolTask,
    nativeToolTaskSignal } = __m4;
  
    const __m5 = await import("../src/mcp/nativeTaskService.js");
    const { acknowledgeNativeTaskCancellation,
    cancelNativeTask,
    getNativeTask,
    getNativeTaskRecord } = __m5;
  
    const __m6 = await import("../src/stateDatabase.ts");
    const { stateDatabasePath } = __m6;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-tool-task-parity-'));
  const config = { stateDir: root };
  try {
    const created = createNativeToolTask(config, {
      method: 'tools/call',
      name: 'relai_validate',
      workspace: 'repo',
      logicalTaskId: 'logical-a',
      principal: 'principal-a',
      message: 'Starting validation.'
    });
    assert.equal(created.status, 'working');
    assert.equal(nativeToolTaskSignal(created.taskId)?.aborted, false);
  
    const nativeCreated = getNativeTaskRecord(config, created.taskId, {
      principal: 'principal-a',
      logicalTaskId: 'logical-a'
    });
    assert.equal(nativeCreated.origin.method, 'tools/call');
    assert.equal(nativeCreated.origin.name, 'relai_validate');
    assert.equal(nativeCreated.origin.logicalTaskId, 'logical-a');
    assert.equal(nativeCreated.internal.workspace, 'repo');
    assert.equal(Object.hasOwn(nativeCreated.internal, 'compatibilityOperation'), false);
    assert.ok(fs.existsSync(stateDatabasePath(config)));
    assert.equal(fs.existsSync(path.join(root, 'native-tasks')), false);
    assert.equal(fs.existsSync(path.join(root, 'operation-tasks')), false);
  
    assert.throws(
      () => getNativeTaskRecord(config, created.taskId, { principal: 'principal-b' }),
      error => error?.code === 'NATIVE_TASK_UNAVAILABLE'
    );
    assert.throws(
      () => getNativeTaskRecord(config, created.taskId, { principal: 'principal-a', logicalTaskId: 'logical-b' }),
      error => error?.code === 'NATIVE_TASK_UNAVAILABLE'
    );
  
    const completed = await completeNativeToolTask(config, created.taskId, { ok: true, checks: 3 });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, { ok: true, checks: 3 });
    assert.equal(completed.statusMessage, 'Tool execution completed.');
  
    const failedTask = createNativeToolTask(config, {
      method: 'tools/call',
      name: 'relai_exec',
      principal: 'principal-a'
    });
    const failed = await failNativeToolTask(config, failedTask.taskId, 'Command failed.');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error.message, 'Command failed.');
  
    const cancellable = createNativeToolTask(config, {
      method: 'tools/call',
      name: 'relai_exec',
      principal: 'principal-a'
    });
    const signal = nativeToolTaskSignal(cancellable.taskId);
    const requested = cancelNativeTask(config, cancellable.taskId, { principal: 'principal-a' });
    assert.equal(requested.status, 'working');
    assert.equal(signal.aborted, true);
    const requestedRecord = getNativeTaskRecord(config, cancellable.taskId, { principal: 'principal-a' });
    assert.equal(requestedRecord.cancelRequested, true);
    assert.equal(requestedRecord.cancellationAcknowledgedAt, null);
    acknowledgeNativeTaskCancellation(config, cancellable.taskId, {
      principal: 'principal-a',
      executionStopped: true
    });
    assert.equal(getNativeTask(config, cancellable.taskId, { principal: 'principal-a' }).status, 'cancelled');
  
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Native tool-task adapter, ownership, and cancellation passed without compatibility operation fields.');
}
await case_operation_task_parity_unit();

// Formerly performance-observability-unit.mjs
async function case_performance_observability_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/performanceObservability.js");
    const { createPerformanceBreakdown,
    measurePerformancePhase,
    performanceBreakdownSnapshot,
    performanceTimingAttributes,
    sanitizePerformancePhases,
    withPerformanceBreakdown } = __m1;
  
  let clock = 0;
  const recorder = createPerformanceBreakdown({ now: () => clock });
  recorder.add('repo.lookup', 12.345);
  recorder.add('repo.lookup', 7.655);
  recorder.add('unknown.phase', 999);
  clock = 25;
  assert.deepEqual(recorder.snapshot(), {
    totalMs: 25,
    phaseMs: { 'repo.lookup': 20 },
    counts: { 'repo.lookup': 2 }
  });
  
  const sanitized = sanitizePerformancePhases({
    'repo.lookup': 4.25,
    'mcp.authorization': 1,
    'user.supplied.secret.phase': 500,
    'repo.index_refresh': Number.POSITIVE_INFINITY
  });
  assert.deepEqual(sanitized, {
    'mcp.authorization': 1,
    'repo.lookup': 4.25
  });
  
  await withPerformanceBreakdown(async () => {
    await measurePerformancePhase('tool.execution', async () => {
      await Promise.resolve();
    });
    const snapshot = performanceBreakdownSnapshot();
    assert.ok(snapshot.phaseMs['tool.execution'] >= 0);
    const attributes = performanceTimingAttributes({
      phaseMs: { 'repo.lookup': 20, 'tool.execution': 40 },
      counts: { 'repo.lookup': 2, 'tool.execution': 1 }
    });
    assert.deepEqual(attributes, {
      'relai.timing.repo.lookup_ms': 20,
      'relai.timing.repo.lookup_count': 2,
      'relai.timing.tool.execution_ms': 40
    });
  });
  
  assert.deepEqual(performanceBreakdownSnapshot(), { totalMs: 0, phaseMs: {}, counts: {} });
  
  console.log('Performance observability uses bounded canonical phases and async request scope.');
}
await case_performance_observability_unit();

// Formerly recovery-window-unit.mjs
async function case_recovery_window_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/recovery-window.js");
    const { createRecoveryWindowManager } = __m1;
  
  const windows = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.focused = false;
      this.events = new Map();
      this.webEvents = new Map();
      this.sessionEvents = new Map();
      this.sent = [];
      this.permissionRequestHandler = null;
      this.permissionCheckHandler = null;
      this.windowOpenHandler = null;
      this.webContents = {
        session: {
          setPermissionRequestHandler: handler => { this.permissionRequestHandler = handler; },
          setPermissionCheckHandler: handler => { this.permissionCheckHandler = handler; },
          on: (name, callback) => this.sessionEvents.set(name, callback)
        },
        on: (name, callback) => this.webEvents.set(name, callback),
        setWindowOpenHandler: handler => { this.windowOpenHandler = handler; },
        send: (channel, payload) => this.sent.push({ channel, payload })
      };
      windows.push(this);
    }
  
    loadURL(url) { this.loadedUrl = url; }
    on(name, callback) { this.events.set(name, callback); }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    destroy() {
      this.destroyed = true;
      this.events.get('closed')?.();
    }
  }
  
  let quitting = false;
  let readyCalls = 0;
  const securityErrors = [];
  const manager = createRecoveryWindowManager({
    BrowserWindow: FakeWindow,
    iconPath: 'app-icon.png',
    preloadPath: 'preload.cjs',
    rendererUrl: 'relai-app://renderer/status.html',  limits: { minWidth: 480, minHeight: 420 },
    isQuitting: () => quitting,
    onReady: () => { readyCalls += 1; },
    onSecurityError: error => securityErrors.push(error.message)
  });
  
  const first = manager.show();
  assert.equal(windows.length, 1);
  assert.equal(first.loadedUrl, 'relai-app://renderer/status.html');
  assert.equal(first.options.title, 'Rel.AI MCP Recovery');
  assert.equal(first.options.icon, 'app-icon.png');
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.webSecurity, true);
  assert.equal(first.options.webPreferences.contextIsolation, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(first.options.webPreferences.partition, 'relai-recovery');
  assert.deepEqual(first.options.webPreferences.additionalArguments, ['--relai-preload-surface=application']);
  assert.match(first.options.backgroundColor, /^#[0-9a-f]{6}$/i, 'recovery window must provide an opaque fallback background while its UI loads');
  assert.equal(first.visible, true);
  assert.equal(first.focused, true);
  first.webEvents.get('did-finish-load')?.();
  assert.equal(readyCalls, 1);
  
  let permissionGranted = true;
  first.permissionRequestHandler(null, 'camera', allowed => { permissionGranted = allowed; });
  assert.equal(permissionGranted, false);
  assert.equal(first.permissionCheckHandler(), false);
  let prevented = false;
  first.sessionEvents.get('will-download')?.({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  first.webEvents.get('will-attach-webview')?.({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(first.windowOpenHandler({ url: 'https://example.com/' }), { action: 'deny' });
  prevented = false;
  first.webEvents.get('will-navigate')?.({ preventDefault: () => { prevented = true; } }, 'https://example.com/');
  assert.equal(prevented, true);
  assert.deepEqual(securityErrors, ['Blocked navigation outside the local Electron renderer.']);
  
  manager.sendStatus({ serverRunning: false });
  manager.sendLog('port in use');
  assert.deepEqual(first.sent, [
    { channel: 'server:status', payload: { serverRunning: false } },
    { channel: 'server:log', payload: 'port in use' }
  ]);
  
  prevented = false;
  first.events.get('close')?.({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(first.visible, false, 'routine close must hide the fallback while the tray app stays alive');
  const sentBeforeHiddenStatus = first.sent.length;
  manager.sendStatus({ serverRunning: true, taskActivity: { state: 'working', activeCalls: 2 } });
  manager.sendLog('hidden log one');
  manager.sendLog('hidden log two');
  assert.equal(first.sent.length, sentBeforeHiddenStatus, 'hidden recovery windows must not receive high-frequency status or log IPC');
  assert.equal(manager.show(), first, 'show must reuse the same fallback window');
  assert.equal(first.sent.length, sentBeforeHiddenStatus + 3, 'reopening recovery must receive the latest status and logs accumulated while hidden');
  assert.deepEqual(first.sent.slice(-3), [
    {
      channel: 'server:status',
      payload: { serverRunning: true, taskActivity: { state: 'working', activeCalls: 2 } }
    },
    { channel: 'server:log', payload: 'hidden log one' },
    { channel: 'server:log', payload: 'hidden log two' }
  ]);
  assert.equal(windows.length, 1);
  
  quitting = true;
  prevented = false;
  first.events.get('close')?.({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false, 'application shutdown must not block the window close');
  manager.close();
  assert.equal(first.destroyed, true);
  assert.equal(manager.getWindow(), null);
  
  console.log('Recovery-window manager unit tests passed.');
}
await case_recovery_window_unit();

// Formerly runtime-lifecycle-unit.mjs
async function case_runtime_lifecycle_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/runtimeLifecycle.js");
    const { PROCESS_LIFECYCLE_STATUSES,
    TUNNEL_LIFECYCLE_STATUSES,
    UPDATER_LIFECYCLE_STATUSES,
    assertConnectionLayerTransition,
    assertProcessStatusTransition,
    assertTunnelLifecycleTransition,
    assertUpdaterLifecycleTransition,
    canTransitionConnectionLayer,
    canTransitionProcessStatus,
    canTransitionTunnelLifecycle,
    canTransitionUpdaterLifecycle,
    normalizeProcessLifecycleStatus,
    normalizeTunnelLifecycleStatus,
    normalizeUpdaterLifecycleStatus } = __m1;
  
    const __m2 = await import("../src/taskState.js");
    const { NATIVE_TASK_TRANSITIONS,
    canTransitionNativeTaskStatus,
    normalizeNativeTaskStatus } = __m2;
  
  assert.deepEqual(PROCESS_LIFECYCLE_STATUSES, ['starting', 'running', 'stopping', 'orphaned', 'stopped', 'exited', 'failed']);
  assert.equal(normalizeProcessLifecycleStatus('RUNNING'), 'running');
  assert.equal(normalizeProcessLifecycleStatus('unknown'), '');
  assert.equal(canTransitionProcessStatus('starting', 'running'), true);
  assert.equal(canTransitionProcessStatus('running', 'stopping'), true);
  assert.equal(canTransitionProcessStatus('stopping', 'stopped'), true);
  assert.equal(canTransitionProcessStatus('stopped', 'running'), false);
  assert.equal(assertProcessStatusTransition('running', 'stopping'), 'stopping');
  assert.throws(() => assertProcessStatusTransition('stopped', 'running'), error => error?.code === 'INVALID_PROCESS_STATE');
  
  assert.deepEqual(TUNNEL_LIFECYCLE_STATUSES, ['stopped', 'starting', 'locally_ready', 'authenticating', 'running', 'degraded', 'failed']);
  assert.equal(normalizeTunnelLifecycleStatus('locally_ready'), 'locally_ready');
  assert.equal(canTransitionTunnelLifecycle('stopped', 'starting'), true);
  assert.equal(canTransitionTunnelLifecycle('starting', 'locally_ready'), true);
  assert.equal(canTransitionTunnelLifecycle('locally_ready', 'authenticating'), true);
  assert.equal(canTransitionTunnelLifecycle('authenticating', 'running'), true);
  assert.equal(canTransitionTunnelLifecycle('running', 'degraded'), true);
  assert.equal(canTransitionTunnelLifecycle('degraded', 'running'), true);
  assert.equal(canTransitionTunnelLifecycle('failed', 'running'), false);
  assert.equal(assertTunnelLifecycleTransition('degraded', 'failed'), 'failed');
  assert.throws(() => assertTunnelLifecycleTransition('stopped', 'running'), error => error?.code === 'INVALID_TUNNEL_STATE');
  
  assert.deepEqual(UPDATER_LIFECYCLE_STATUSES, ['unsupported', 'idle', 'checking', 'up_to_date', 'available', 'downloading', 'downloaded', 'installing', 'error']);
  assert.equal(normalizeUpdaterLifecycleStatus('DOWNLOADING'), 'downloading');
  assert.equal(normalizeUpdaterLifecycleStatus('mystery'), '');
  assert.equal(canTransitionUpdaterLifecycle('idle', 'checking'), true);
  assert.equal(canTransitionUpdaterLifecycle('checking', 'available'), true);
  assert.equal(canTransitionUpdaterLifecycle('available', 'downloading'), true);
  assert.equal(canTransitionUpdaterLifecycle('downloading', 'downloaded'), true);
  assert.equal(canTransitionUpdaterLifecycle('downloaded', 'installing'), true);
  assert.equal(canTransitionUpdaterLifecycle('unsupported', 'checking'), false);
  assert.equal(assertUpdaterLifecycleTransition('error', 'checking'), 'checking');
  assert.throws(() => assertUpdaterLifecycleTransition('unsupported', 'checking'), error => error?.code === 'INVALID_UPDATER_STATE');
  
  assert.equal(canTransitionConnectionLayer('localService', 'stopped', 'starting'), true);
  assert.equal(canTransitionConnectionLayer('localService', 'starting', 'running'), true);
  assert.equal(canTransitionConnectionLayer('publicEndpoint', 'connecting', 'available'), true);
  assert.equal(canTransitionConnectionLayer('publicEndpoint', 'available', 'degraded'), true);
  assert.equal(canTransitionConnectionLayer('chatgptReadiness', 'unavailable', 'ready'), true);
  assert.equal(canTransitionConnectionLayer('dashboardUpdates', 'live', 'reconnecting'), true);
  assert.equal(canTransitionConnectionLayer('localService', 'stopped', 'running'), false);
  assert.equal(assertConnectionLayerTransition('publicEndpoint', 'degraded', 'available'), 'available');
  assert.throws(() => assertConnectionLayerTransition('localService', 'stopped', 'running'), error => error?.code === 'INVALID_CONNECTION_STATE');
  
  assert.ok(Object.isFrozen(NATIVE_TASK_TRANSITIONS));
  assert.equal(normalizeNativeTaskStatus('INPUT_REQUIRED'), 'input_required');
  assert.equal(normalizeNativeTaskStatus('running'), '');
  assert.equal(canTransitionNativeTaskStatus('working', 'input_required'), true);
  assert.equal(canTransitionNativeTaskStatus('input_required', 'working'), true);
  assert.equal(canTransitionNativeTaskStatus('working', 'completed'), true);
  assert.equal(canTransitionNativeTaskStatus('completed', 'working'), false);
  
  console.log('Runtime lifecycle vocabularies and transition guards passed.');
}
await case_runtime_lifecycle_unit();

// Formerly runtime-log-buffer-unit.mjs
async function case_runtime_log_buffer_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/runtime-log-buffer.js");
    const { createRuntimeLogBuffer } = __m4;
  
    const __m5 = await import("../electron/runtime-log-snapshot.js");
    const { applyRuntimeLogChange } = __m5;
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-runtime-logs-'));
  const logPath = path.join(temp, 'diagnostics', 'service.log');
  const maxEntries = 3;
  let tick = 0;
  const buffer = createRuntimeLogBuffer({
    maxEntries,
    filePath: logPath,
    now: () => `2026-07-25T00:00:0${tick++}.000Z`
  });
  
  try {
    const changes = [];
    const unsubscribe = buffer.onChange(change => changes.push(change));
    buffer.append('first');
    buffer.append('Authorization: Bearer secret-token', { source: 'openai-tunnel', code: 'public_endpoint_failed' });
    buffer.append('{"token":"secret-token"}', { level: 'error' });
    buffer.append('OPENAI_API_KEY=runtime-env-secret', { source: 'local-service' });
    buffer.append('fourth', {
      source: 'desktop-observability',
      code: 'activity_listener_failed',
      taskId: 'task-42',
      eventId: 'event-7',
      workspace: 'repo',
      tool: 'relai_read',
      operation: 'Read src/app.js'
    });
    await buffer.flush();
  
    const bounded = buffer.snapshot();
    assert.equal(bounded.count, 3);
    assert.equal(bounded.revision, 5);
    assert.equal(changes.length, 5);
    assert.equal(changes.at(-1).type, 'append');
    assert.equal(changes.at(-1).entry.message, 'fourth');
    assert.equal(changes.at(-1).count, 3);
    assert.equal(changes.at(-1).maxEntries, 3);
    assert.equal(bounded.persistent, true);
    assert.equal(bounded.persistence.healthy, true);
    assert.equal(bounded.entries.length, 3);
    assert.equal(bounded.entries.at(-1).message, 'fourth');
    assert.deepEqual(
      {
        source: bounded.entries.at(-1).source,
        code: bounded.entries.at(-1).code,
        taskId: bounded.entries.at(-1).taskId,
        eventId: bounded.entries.at(-1).eventId,
        workspace: bounded.entries.at(-1).workspace,
        tool: bounded.entries.at(-1).tool,
        operation: bounded.entries.at(-1).operation
      },
      {
        source: 'desktop-observability',
        code: 'activity_listener_failed',
        taskId: 'task-42',
        eventId: 'event-7',
        workspace: 'repo',
        tool: 'relai_read',
        operation: 'Read src/app.js'
      },
      'structured correlation must survive the in-memory log path'
    );
    assert.doesNotMatch(JSON.stringify(bounded), /secret-token|runtime-env-secret/);
    assert.match(JSON.stringify(bounded), /\[redacted\]/);
    assert.equal(fs.existsSync(logPath), true);
    assert.doesNotMatch(fs.readFileSync(logPath, 'utf8'), /secret-token|runtime-env-secret/);
    const persistedLines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    assert.ok(persistedLines.length <= maxEntries * 2, 'persistent logs may use bounded compaction slack instead of rewriting on every overflow');
  
    bounded.entries[0].message = 'mutated';
    assert.notEqual(buffer.snapshot().entries[0].message, 'mutated');
  
    const restored = createRuntimeLogBuffer({ maxEntries: 3, filePath: logPath });
    assert.equal(restored.snapshot().entries.length, 3);
    assert.equal(restored.snapshot().entries.at(-1).message, 'fourth');
    assert.equal(restored.snapshot().entries.at(-1).taskId, 'task-42', 'structured correlation must survive restart hydration');
  
    const burstLogPath = path.join(temp, 'diagnostics', 'burst.log');
    const burst = createRuntimeLogBuffer({ maxEntries: 3, filePath: burstLogPath, now: () => '2026-07-25T00:00:00.000Z' });
    for (let index = 0; index < 30; index += 1) burst.append(`burst-${index}`);
    await burst.flush();
    const burstDiskEntries = fs.readFileSync(burstLogPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(burstDiskEntries.length <= 6, 'sustained diagnostic logging must periodically compact the persistent file');
    assert.equal(burstDiskEntries.at(-1).message, 'burst-29', 'compaction must retain the newest diagnostic entry');
    assert.deepEqual(burst.snapshot().entries.map(entry => entry.message), ['burst-27', 'burst-28', 'burst-29']);
  
    const blockedParent = path.join(temp, 'blocked-log-parent');
    fs.writeFileSync(blockedParent, 'not a directory');
    const failedChanges = [];
    const failedPersistence = createRuntimeLogBuffer({ maxEntries: 3, filePath: path.join(blockedParent, 'service.log') });
    failedPersistence.onChange(change => failedChanges.push(change));
    failedPersistence.append('still visible in memory');
    await failedPersistence.flush();
    const failedSnapshot = failedPersistence.snapshot();
    assert.equal(failedSnapshot.persistence.healthy, false, 'persistent app-log write failures must remain observable');
    assert.equal(failedSnapshot.persistence.failureCount, 1);
    assert.ok(failedSnapshot.persistence.lastError);
    assert.equal(failedChanges.at(-1).type, 'persistence');
    assert.equal(failedSnapshot.entries.at(-1).message, 'still visible in memory', 'persistence failure must not discard the in-memory diagnostic log');
  
    const transitions = createRuntimeLogBuffer({ maxEntries: 10, now: () => '2026-07-25T00:00:00.000Z' });
    transitions.recordStatusTransition({}, { serverRunning: true, tunnelStatus: 'connecting' });
    transitions.recordStatusTransition({ serverRunning: true, tunnelStatus: 'connecting' }, { serverRunning: true, tunnelStatus: 'running' });
    transitions.recordStatusTransition({ serverRunning: true }, { serverRunning: false });
    transitions.recordStatusTransition({}, { error: 'token=secret-token', errorCode: 'local_port_in_use' });
    const messages = transitions.snapshot().entries.map(entry => entry.message);
    assert.ok(messages.includes('Local service started.'));
    assert.ok(messages.includes('OpenAI Secure MCP Tunnel is connected.'));
    assert.ok(messages.includes('Local service stopped.'));
    assert.doesNotMatch(JSON.stringify(messages), /secret-token/);
  
    const grouped = createRuntimeLogBuffer({ maxEntries: 10, now: () => '2026-08-16T05:00:00.000Z' });
    const groupedChanges = [];
    grouped.onChange(change => groupedChanges.push(change));
    grouped.append('Tunnel polling was interrupted. Retrying automatically.', {
      level: 'warning', source: 'openai-tunnel', component: 'controlplane', code: 'tunnel_connection_interrupted',
      details: { retryInMs: 10000, lastError: 'unexpected EOF' }
    });
    grouped.append('Tunnel polling was interrupted. Retrying automatically.', {
      level: 'warning', source: 'openai-tunnel', component: 'controlplane', code: 'tunnel_connection_interrupted',
      details: { retryInMs: 10000, lastError: 'connection reset' }
    });
    const groupedSnapshot = grouped.snapshot();
    assert.equal(groupedSnapshot.count, 1, 'repeated tunnel failures must stay grouped');
    assert.equal(groupedSnapshot.entries[0].repeatCount, 2);
    assert.equal(groupedSnapshot.entries[0].component, 'controlplane');
    assert.equal(groupedSnapshot.entries[0].details.lastError, 'connection reset');
    assert.deepEqual(groupedChanges.map(change => change.type), ['append', 'replace']);
  
    const cleared = buffer.clear();
    await buffer.flush();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.removed, 3);
    assert.equal(changes.at(-1).type, 'reset');
    assert.equal(changes.at(-1).revision, 6);
    unsubscribe();
    assert.equal(buffer.snapshot().count, 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), '');
  
    let projected = { available: true, revision: 1, count: 2, entries: [{ message: 'one' }, { message: 'two' }] };
    projected = applyRuntimeLogChange(projected, { type: 'append', revision: 2, count: 3, maxEntries: 2, entry: { message: 'three' } });
    assert.equal(projected.revision, 2);
    assert.equal(projected.count, 3);
    assert.deepEqual(projected.entries.map(entry => entry.message), ['two', 'three']);
    projected = applyRuntimeLogChange(projected, { type: 'replace', revision: 3, count: 3, index: 1, entry: { message: 'three', repeatCount: 2, details: { retryInMs: 10000 } } });
    assert.equal(projected.entries[1].repeatCount, 2);
    assert.equal(projected.entries[1].details.retryInMs, 10000);
    const duplicate = applyRuntimeLogChange(projected, { type: 'append', revision: 3, count: 3, maxEntries: 2, entry: { message: 'duplicate' } });
    assert.equal(duplicate.revision, 3);
    assert.deepEqual(duplicate.entries.map(entry => entry.message), ['two', 'three'], 'replayed runtime-log revisions must be idempotent');
    const staleReset = applyRuntimeLogChange(projected, { type: 'reset', revision: 2, count: 0, maxEntries: 2 });
    assert.deepEqual(staleReset.entries.map(entry => entry.message), ['two', 'three'], 'stale resets must not erase newer runtime logs');
    projected = applyRuntimeLogChange(projected, { type: 'reset', revision: 4, count: 0, maxEntries: 2 });
    assert.equal(projected.revision, 4);
    assert.equal(projected.count, 0);
    assert.deepEqual(projected.entries, []);
    projected = applyRuntimeLogChange(projected, { type: 'persistence', revision: 5, persistence: { healthy: false, failureCount: 2, lastError: 'disk unavailable' } });
    assert.equal(projected.revision, 5);
    assert.equal(projected.persistence.healthy, false);
    assert.equal(projected.persistence.failureCount, 2);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('Runtime log buffer unit tests passed.');
}
await case_runtime_log_buffer_unit();

// Formerly runtime-version-skew-unit.mjs
async function case_runtime_version_skew_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
  const {
    assessRuntimeCompatibility,
    readRepositoryMetadata,
    runtimeMetadata
  } = await import('../src/runtimeCompatibility.js');
  
  const current = runtimeMetadata();
  assert.equal(runtimeMetadata(), current, 'unchanged runtime metadata should reuse the canonical manifest calculation');
  const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const releaseManifest = JSON.parse(fs.readFileSync(new URL('../release-manifest.json', import.meta.url), 'utf8'));
  assert.equal(current.applicationVersion, packageVersion);
  assert.equal(current.toolSurfaceVersion, releaseManifest.toolSurfaceVersion);
  assert.equal(current.toolCount, releaseManifest.toolCount);
  assert.match(current.manifestHash, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(current.schemaVersion, releaseManifest.schemaVersion);
  
  const configured = runtimeMetadata({
    toolProfile: 'core',
    workspaces: { repo: { path: process.cwd() }, another: { path: os.tmpdir() } }
  });
  assert.equal(configured.toolCount, current.toolCount, 'stale profile configuration must not reduce the public surface');
  assert.equal(configured.manifestHash, current.manifestHash, 'configuration fields must not change the runtime manifest hash');
  
  const equal = assessRuntimeCompatibility(current, { ...current, source: 'repository' });
  assert.equal(equal.status, 'compatible');
  assert.equal(equal.compatible, true);
  assert.equal(equal.metadataMatches, true);
  assert.equal(equal.restartRequired, false);
  
  const repositoryAhead = assessRuntimeCompatibility(
    { ...current, applicationVersion: '0.22.0', packageVersion: '0.22.0', toolSurfaceVersion: 22, toolCount: 33, manifestHash: 'old' },
    { ...current, source: 'repository' },
    { activeTaskCount: 2 }
  );
  assert.equal(repositoryAhead.status, 'restart_required');
  assert.equal(repositoryAhead.compatible, true);
  assert.equal(repositoryAhead.metadataMatches, false);
  assert.equal(repositoryAhead.restartRequired, true);
  assert.equal(repositoryAhead.schemaSensitiveOperationsBlocked, false);
  assert.equal(repositoryAhead.advisoryOnly, true);
  assert.equal(repositoryAhead.activeTasksPreventRestart, true);
  assert.match(repositoryAhead.message, /operationally compatible/i);
  
  const runtimeAhead = assessRuntimeCompatibility(
    { ...current, applicationVersion: '999.0.0', packageVersion: '999.0.0' },
    { ...current, source: 'repository' }
  );
  assert.equal(runtimeAhead.status, 'runtime_newer');
  assert.equal(runtimeAhead.compatible, true);
  assert.equal(runtimeAhead.metadataMatches, false);
  assert.equal(runtimeAhead.restartRequired, false);
  assert.equal(runtimeAhead.schemaSensitiveOperationsBlocked, false);
  assert.equal(runtimeAhead.advisoryOnly, true);
  
  const surfaceMismatch = assessRuntimeCompatibility(
    current,
    { ...current, source: 'repository', toolSurfaceVersion: current.toolSurfaceVersion + 1, manifestHash: 'changed' }
  );
  assert.equal(surfaceMismatch.status, 'restart_required');
  assert.equal(surfaceMismatch.compatible, true);
  assert.equal(surfaceMismatch.metadataMatches, false);
  assert.ok(surfaceMismatch.differences.some(item => item.field === 'toolSurfaceVersion'));
  
  const unavailable = assessRuntimeCompatibility(current, null);
  assert.equal(unavailable.status, 'repository_unavailable');
  assert.equal(unavailable.compatible, true);
  assert.equal(unavailable.metadataMatches, null);
  assert.equal(unavailable.schemaSensitiveOperationsBlocked, false);
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-runtime-skew-'));
  try {
    const repositoryVersion = '999.0.0';
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'rel-ai-mcp', version: repositoryVersion }));
    fs.writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify({
      schemaVersion: current.schemaVersion,
      applicationVersion: repositoryVersion,
      protocolVersion: current.protocolVersion,
      toolSurfaceVersion: current.toolSurfaceVersion + 1,
      toolCount: current.toolCount,
      manifestHash: 'new-surface'
    }));
    const repository = readRepositoryMetadata(temp, 'repo');
    assert.equal(repository.applicationVersion, repositoryVersion);
    assert.equal(repository.workspace, 'repo');
    const cachedAlias = readRepositoryMetadata(temp, 'secondary');
    assert.equal(cachedAlias.applicationVersion, repositoryVersion);
    assert.equal(cachedAlias.workspace, 'secondary', 'cached repository metadata must not retain the previous workspace alias');
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ name: 'rel-ai-mcp', version: current.applicationVersion }));
    fs.writeFileSync(path.join(temp, 'release-manifest.json'), JSON.stringify({
      schemaVersion: current.schemaVersion,
      applicationVersion: current.applicationVersion,
      protocolVersion: current.protocolVersion,
      toolSurfaceVersion: current.toolSurfaceVersion,
      toolCount: current.toolCount,
      manifestHash: current.manifestHash
    }));
    const refreshedRepository = readRepositoryMetadata(temp, 'repo');
    assert.equal(refreshedRepository.applicationVersion, current.applicationVersion, 'repository metadata cache must invalidate when source files change');
    assert.equal(refreshedRepository.manifestHash, current.manifestHash);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('Runtime/repository skew remains observable without blocking self-hosted editing or other tools.');
}
await case_runtime_version_skew_unit();

// Formerly shared-contracts-unit.mjs
async function case_shared_contracts_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/contracts/computer.ts");
    const { computerControlSettingsPatchSchema } = __m1;
  
    const __m2 = await import("../src/contracts/connection.ts");
    const { CONNECTION_STATE_VALUES } = __m2;
  
    const __m3 = await import("../src/contracts/dashboard.ts");
    const { createDashboardSnapshot, DASHBOARD_MODEL_VERSION } = __m3;
  
    const __m4 = await import("../src/contracts/desktop.ts");
    const { DESKTOP_IPC_CHANNELS, DESKTOP_IPC_INPUT_CONTRACT } = __m4;
  
    const __m5 = await import("../src/contracts/diagnostics.ts");
    const { diagnosticResetRequestSchema } = __m5;
  
    const __m6 = await import("../src/contracts/events.ts");
    const { createEmptyDashboardRevisions, DASHBOARD_LIVE_EVENT_TYPES } = __m6;
  
    const __m7 = await import("../src/contracts/mcp.ts");
    const { MCP_CONTENT_TYPES } = __m7;
  
    const __m8 = await import("../src/contracts/processes.ts");
    const { createManagedProcessList } = __m8;
  
    const __m9 = await import("../src/contracts/tasks.ts");
    const { CANONICAL_TASK_STATUSES, createEmptyTaskActivity } = __m9;
  
    const __m10 = await import("../src/contracts/workspaces.ts");
    const { createWorkspaceUpdatePayload } = __m10;
  
  assert.deepEqual(createEmptyTaskActivity(), {
    state: 'idle',
    activeCalls: 0,
    activeTaskCount: 0,
    tasks: [],
    taskId: '',
    workspace: '',
    tool: '',
    startedAt: null,
    lastTask: null
  });
  assert.ok(CANONICAL_TASK_STATUSES.includes('waiting_for_approval'));
  
  const snapshot = createDashboardSnapshot({ streamId: 'stream-1', sequence: 2, revision: 'rev-1', generatedAt: '2026-09-06T00:00:00.000Z' });
  assert.deepEqual(snapshot, {
    streamId: 'stream-1',
    sequence: 2,
    revision: 'rev-1',
    generatedAt: '2026-09-06T00:00:00.000Z',
    modelVersion: DASHBOARD_MODEL_VERSION
  });
  assert.deepEqual(createEmptyDashboardRevisions(), { task: 0, connection: 0, workspace: 0, process: 0, diagnostics: 0 });
  assert.ok(DASHBOARD_LIVE_EVENT_TYPES.includes('task.updated'));
  
  assert.ok(CONNECTION_STATE_VALUES.dashboardUpdates.includes('reconnecting'));
  assert.deepEqual(createWorkspaceUpdatePayload('repo', { exists: true }), { alias: 'repo', state: { exists: true } });
  assert.deepEqual(createManagedProcessList([{ processId: 'proc-1' }]), { ok: true, processes: [{ processId: 'proc-1' }], count: 1 });
  
  assert.equal(computerControlSettingsPatchSchema.safeParse({ enabled: true }).success, true);
  assert.equal(computerControlSettingsPatchSchema.safeParse({ enabled: 'yes' }).success, false);
  assert.equal(diagnosticResetRequestSchema.safeParse({ target: 'history', confirm: true }).success, true);
  assert.equal(diagnosticResetRequestSchema.safeParse({ target: 'other', confirm: true }).success, false);
  assert.equal(diagnosticResetRequestSchema.safeParse({ target: 'history', confirm: false }).success, false);
  
  assert.equal(new Set(DESKTOP_IPC_CHANNELS).size, DESKTOP_IPC_CHANNELS.length);
  for (const channel of Object.keys(DESKTOP_IPC_INPUT_CONTRACT)) assert.ok(DESKTOP_IPC_CHANNELS.includes(channel));
  assert.deepEqual(MCP_CONTENT_TYPES, { TEXT: 'text', IMAGE: 'image', RESOURCE_LINK: 'resource_link' });
  
  console.log('Canonical shared contract checks passed.');
}
await case_shared_contracts_unit();

// Formerly status-contract-unit.mjs
async function case_status_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { execFileSync } = __m4;
  
    const __m5 = await import("../src/tools/status.js");
    const { relaiStatus } = __m5;
  
    const __m6 = await import("../src/repo/gitOps.js");
    const { relaiGitCommit } = __m6;
  
    const __m7 = await import("../src/policyResolver.js");
    const { writeSessionPolicy } = __m7;
  
    const __m8 = await import("./helpers/git-executable.mjs");
    const { GIT_EXECUTABLE } = __m8;
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-status-contract-'));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  
  function git(args) {
    return execFileSync(GIT_EXECUTABLE, args, { cwd: repo, encoding: 'utf8' });
  }
  
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'status-test@example.com']);
    git(['config', 'user.name', 'Status Contract Test']);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'saved\n');
    git(['add', 'tracked.txt']);
    git(['commit', '-qm', 'initial']);
    git(['branch', '-M', 'main']);
  
    const workspace = {
      alias: 'app',
      path: repo,
      commands: { build: 'npm run build' },
      testCommands: { test: 'npm test' }
    };
    const config = {
      stateDir: path.join(temp, 'state'),
      workspaces: { app: workspace }
    };
  
    await writeSessionPolicy(config, workspace.alias, { workspaceRoot: repo, taskId: 'task-status-contract' });
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'new\n');
  
    const combined = await relaiStatus(config, { workspace: 'app' });
    assert.equal(combined.ok, true);
    assert.equal(combined.workspace.alias, 'app');
    assert.equal(combined.workspace.repository.ok, true);
    assert.equal(combined.workspace.repository.branch, 'main');
    assert.ok(combined.workspace.repository.changedFiles.includes('tracked.txt'));
    assert.ok(combined.workspace.repository.untrackedFiles.includes('untracked.txt'));
    assert.ok(combined.workspace.repository.sessionChangedFiles.includes('tracked.txt'));
    assert.ok(combined.workspace.repository.untrackedSessionFiles.includes('untracked.txt'));
    assert.equal(combined.workspace.repository.deprecated, undefined, 'primary status must not carry compatibility metadata');
  
    const commitPlan = await relaiGitCommit(workspace, config, {
      message: 'status contract dry run',
      dryRun: true,
      addAll: true
    });
    assert.equal(commitPlan.ok, true);
    assert.equal(commitPlan.statusBefore.deprecated, undefined, 'internal commit status must use the shared core without legacy metadata');
    assert.equal(commitPlan.statusBefore.branch, 'main');
  
    console.log('Combined workspace and repository status contract passed.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
await case_status_contract_unit();

// Formerly stdio-shutdown-persistence-unit.mjs
async function case_stdio_shutdown_persistence_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:url");
    const { fileURLToPath } = __m4;
  
    const __m5 = await import("../src/audit.js");
    const { readAudit } = __m5;
  
    const __m6 = await import("../src/localAnalytics.js");
    const { readLocalUsageSnapshot } = __m6;
  
    const __m7 = await import("./helpers/mcp-client.mjs");
    const { startMcpClient, structuredContentOf } = __m7;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-stdio-shutdown-persistence-'));
  const stateDir = path.join(temp, 'state');
  const workspacePath = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const config = {
    version: 3,
    stateDir,
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    workspaces: {
      repo: { path: workspacePath, commands: {}, testCommands: {} }
    }
  };
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ name: 'stdio-shutdown-fixture' }));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  const client = startMcpClient({
    root,
    configPath,
    env: { REL_AI_MCP_STATE_DIR: stateDir },
    timeoutMs: 15_000
  });
  
  try {
    client.initialize(1);
    await client.waitFor(1);
    client.call(2, 'relai_work', { action: 'begin', workspace: 'repo', bootstrap: 'none' });
    const started = structuredContentOf(await client.waitFor(2));
    assert.match(started.work_id || '', /^[0-9a-f-]{36}$/i);
  
    // Close immediately after the tool response. Delayed audit/analytics writes must
    // be flushed by the stdio server shutdown path rather than lost with the process.
    await client.closeGracefully();
  
    const audit = readAudit(config, { workspace: 'repo', limit: 50 });
    assert.ok(audit.entries.some(entry => entry.publicTool === 'relai_work' && entry.taskId === started.work_id),
      'stdio shutdown must flush the completed public tool audit record to disk');
  
    const usage = readLocalUsageSnapshot(config);
    const relaiWork = usage.tools.find(item => item.tool === 'relai_work');
    assert.ok(Number(relaiWork?.toolCalls || 0) >= 1,
      'stdio shutdown must flush local analytics for the completed tool call to disk');
  } finally {
    await client.closeGracefully().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('stdio shutdown flushes audit and local analytics persistence before exit.');
}
await case_stdio_shutdown_persistence_unit();

// Formerly usage-ui-contract-unit.mjs
async function case_usage_ui_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
    const __m4 = await import("../src/ui/features/usage/index.js");
    const { buildUsageModel, currentUsageMonth } = __m4;
  
    const __m5 = await import("../src/ui/features/usage/range-model.js");
    const { analyticsBounds, analyticsRangeScope } = __m5;
  
    const __m6 = await import("../src/ui/features/usage/data.js");
    const { loadAnalyticsData } = __m6;
  
    const __m7 = await import("../src/ui/features/usage/render.js");
    const { analyticsMetrics, formatChartValue, pointMetric, timelineModel } = __m7;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const navigationCatalog = read('src/ui/navigation-catalog.js');
  const dashboard = read('public/dashboard.js');
  const preload = read('electron/preload.cjs');
  const ipc = read('electron/ipc-handlers-dashboard.js');
  const desktopContract = read('src/contracts/desktop.ts');
  const usageSource = read('src/ui/features/usage/index.js');
  const usageReact = read('src/ui/features/usage/react.js');
  const usageRender = read('src/ui/features/usage/render.js');
  const settingsReact = read('src/ui/features/settings/react.js');
  const reactMain = read('src/ui/react/main.js');
  const usageRange = read('src/ui/features/usage/range-model.js');
  const usageData = read('src/ui/features/usage/data.js');
  const usageCss = read('src/ui/features/usage/styles.css');
  const charts = read('src/ui/components/charts.js');
  const homeReact = read('src/ui/features/home/react.js');
  const workspacesReact = read('src/ui/features/workspaces/react.js');
  const uiPackage = JSON.parse(read('src/ui/package.json'));
  const usageCombined = `${usageSource}\n${usageReact}\n${usageRender}\n${usageRange}\n${usageData}`;
  
  assert.match(navigationCatalog, /route\(['"]usage['"], ['"]Analytics['"]/);
  assert.match(navigationCatalog, /See activity trends, success rates, timing, and problem areas/i);
  assert.doesNotMatch(dashboard, /usage: systemSection\(['"]usage['"]\)/, 'Analytics must not retain the legacy System renderer');
  assert.match(reactMain, /registerReactSection\('usage'/, 'Analytics must be registered as a canonical React route');
  assert.match(preload, /getLocalUsage: month => ipcRenderer\.invoke\(['"]desktop:analytics:local['"], month\)/);
  assert.doesNotMatch(preload, /getGatewayUsage|desktop:gateway:usage/);
  assert.match(desktopContract, /DESKTOP_ANALYTICS_LOCAL:\s*['"]desktop:analytics:local['"]/);
  assert.match(ipc, /channels\.DESKTOP_ANALYTICS_LOCAL/);
  assert.match(ipc, /Analytics month must use YYYY-MM/);
  assert.doesNotMatch(ipc, /gateway/i);
  assert.match(usageData, /desktop\.getLocalUsage/);
  assert.doesNotMatch(`${usageSource}\n${usageData}`, /getGatewayUsage|connectionMode|pairing_required|cloudUsageAvailability/i);
  assert.doesNotMatch(`${usageSource}\n${usageData}`, /fetch\(|DASHBOARD_DATA_URL|auditTail|taskActivity/);
  assert.match(usageReact, /Analytics are stored on this computer\. Rel\.AI records aggregate action categories and work-type labels, not prompts, file paths, command output, or action results/i);
  assert.match(usageReact, /data-usage-privacy/, 'Analytics must disclose local retention and external telemetry state');
  assert.match(usageSource, /External developer telemetry is off/, 'Analytics must make the default external-telemetry state explicit');
  assert.match(usageSource, /OTLP endpoint is configured, but the telemetry switch is disabled/, 'Analytics must distinguish a configured endpoint from an enabled exporter');
  assert.match(usageSource, /raw exception messages are not exported/, 'Analytics must disclose the external trace redaction boundary');
  assert.doesNotMatch(usageReact, /target: 'analytics', confirm: true/, 'Analytics page must not expose the destructive local-history clear action');
  assert.match(settingsReact, /target: 'analytics', confirm: true/, 'Settings must retain an explicit local-history clear action');
  assert.doesNotMatch(`${usageSource}\n${usageRender}`, /innerHTML|replaceChildren|insertAdjacentHTML/, 'Analytics model/view helpers must not retain the legacy DOM renderer');
  assert.match(usageReact, /'data-usage-status': true, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true'/);
  assert.doesNotMatch(usageReact, /'data-usage-content'.*'aria-live'/);
  assert.match(usageReact, /Analytics updated for \$\{bounds\.label\}/);
  assert.match(usageReact, /taskRevision/, 'Analytics must refresh current local metrics from canonical live task activity');
  assert.match(homeReact, /revisions\?\.task/, 'Overview analytics must refresh from canonical live task revisions');
  assert.doesNotMatch(homeReact, /firstRequestObserved\s*\?\s*h\(HomeAnalytics/, 'Overview analytics must not disappear when volatile MCP request history resets on restart');
  assert.doesNotMatch(homeReact, /firstRequestObserved\s*\?\s*h\(RecentTasksCard/, 'Persisted recent tasks must not disappear when volatile MCP request history resets on restart');
  assert.match(workspacesReact, /taskRevision/, 'Project analytics must refresh from canonical live task revisions');
  assert.match(workspacesReact, /Loading analytics…/, 'Project cards must show an explicit analytics loading state instead of a blank region');
  assert.match(workspacesReact, /Analytics unavailable/, 'Project cards must show an explicit analytics failure state when initial analytics loading fails');
  assert.doesNotMatch(workspacesReact, /setTimeout\(\(\) => \{[\s\S]{0,500}loadAnalyticsModels/, 'Project analytics must not wait on an arbitrary timer before starting the initial load');
  assert.match(usageReact, /'aria-pressed': range === key \? 'true' : 'false'/);
  assert.match(usageReact, /role: 'tooltip'/, 'Analytics metric help must expose tooltip semantics');
  assert.match(usageReact, /'aria-describedby': helpId/, 'Analytics metric help triggers must reference their tooltip text');
  assert.match(usageReact, /event\.key === 'Escape'/, 'Analytics metric tooltips must be dismissible with Escape');
  assert.match(usageRender, /percentage points[\s\S]{0,80}90% to 95% is \+5 pp/i, 'Rate help must explain percentage points with an example');
  assert.match(usageCss, /\.usage-metric-help\.is-open \.usage-metric-tooltip/, 'Analytics metric tooltips must have an explicit visible state');
  assert.match(usageReact, /'aria-expanded': open \? 'true' : 'false'/, 'Analytics metric help must expose its expanded state to assistive technology');
  assert.match(usageReact, /onClick: \(\) => setOpen\(value => !value\)/, 'Analytics metric help must support explicit touch and click toggling');
  assert.match(charts, /event\.key === 'ArrowLeft'/, 'Analytics timeline must support keyboard period navigation');
  assert.match(charts, /event\.key === 'ArrowRight'/, 'Analytics timeline must support keyboard period navigation');
  assert.match(charts, /react-chartjs-2/, 'Analytics charts must use the canonical React Chart.js wrapper');
  assert.match(charts, /chart\.js/, 'Analytics charts must use Chart.js instead of first-party SVG geometry');
  assert.match(charts, /export function AnalyticsBubbleMatrixChart/, 'Analytics must expose one shared categorical matrix renderer');
  assert.match(charts, /analytics-matrix-grid/, 'The work-type matrix must render explicit categorical row and column labels instead of numeric chart axes');
  assert.doesNotMatch(charts, /BubbleController|import\s*\{\s*Bubble(?:\s*,|\s*\})/, 'The categorical matrix must not retain the generic Chart.js bubble plot implementation');
  assert.match(charts, /AccessibleMatrixTable/, 'The work-type matrix must provide an accessible data-table alternative');
  assert.doesNotMatch(charts, /\bBar(?:Element)?\b/, 'Temporal analytics must use line charts consistently');
  assert.match(charts, /export function SparkChart[\s\S]{0,1500}spanGaps: true/, 'Compact analytics sparklines must stay visually continuous across missing samples');
  assert.match(charts, /spanGaps: false/, 'Missing rate and duration samples must remain visible as gaps in the detailed timeline');
  assert.match(charts, /trailingGapContinuation/, 'Trailing idle buckets must keep the timeline visually connected to the range end');
  assert.match(charts, /borderDash: \[4, 4\]/, 'Trailing idle continuation must be visually distinct from measured samples');
  assert.match(usageCss, /\.usage-metric-value \{[^}]*flex-wrap/, 'Analytics metric values and deltas must wrap instead of overlapping neighboring tiles');
  assert.match(usageCss, /\.usage-metrics \{[^}]*display:\s*grid/, 'Primary Analytics metrics must stay in the responsive metrics grid');
  assert.ok(uiPackage.dependencies['chart.js'], 'Chart.js must be owned by the UI workspace');
  assert.ok(uiPackage.dependencies['react-chartjs-2'], 'The React Chart.js wrapper must be owned by the UI workspace');
  assert.doesNotMatch(`${usageReact}\n${homeReact}\n${workspacesReact}`, /h\(['"]svg['"]/, 'Analytics feature renderers must not retain first-party SVG chart markup');
  assert.doesNotMatch(usageRender, /coordinates|polyline|area:\s*`/, 'Analytics view models must not retain first-party chart geometry');
  assert.match(usageReact, /'aria-valuetext': valueText/, 'Analytics breakdown progress must expose readable values');
  assert.match(usageCss, /\.usage-privacy-body/, 'Analytics privacy disclosure must use a stable responsive layout');
  assert.match(usageCss, /\.usage-matrix-scroll \{[^}]*overflow-x:\s*auto/, 'The matrix must contain narrow-screen overflow inside its card instead of overflowing the page');
  assert.match(usageCss, /\.analytics-matrix-grid \{[^}]*grid-template-columns:[^}]*repeat\(var\(--matrix-columns\)/, 'The matrix must use a categorical grid with one visible column per use case');
  assert.match(usageCss, /\.analytics-matrix-bubble \{[^}]*width:\s*44px[^}]*height:\s*44px/, 'Matrix bubbles must keep a 44px interactive target while encoding magnitude in the inner visual'); // rigidity-ok: 44px is the minimum interactive target required by the matrix accessibility contract.
  assert.doesNotMatch(usageCss, /\.usage-matrix-stage \{[^}]*height:\s*(?:400|420)px/, 'The matrix must size to its rows instead of reserving a fixed tall plotting area');
  assert.match(usageReact, /Work type × use case/, 'Analytics must render the work-type by use-case matrix');
  assert.match(usageReact, /title: 'Use cases'/, 'Analytics must render a use-case distribution');
  assert.match(usageReact, /title: 'Work types'/, 'Analytics must render completed work-type counts');
  
  const currentMetricScope = {
    label: 'All projects', kind: 'all', usedMonthlyFallback: false,
    toolCalls: 10, reliabilityCalls: 10, reliableCalls: 9.68, reliabilityRate: 96.8,
    infrastructureFailures: 0, recoverableFailures: 0, failures: 1,
    completed: 10, operationSuccessRate: 92.7, averageDuration: 6120,
    points: [], tools: [], workspaces: [], failureCategories: []
  };
  const previousWithoutRateBaselines = {
    toolCalls: 0, reliabilityCalls: 0, reliableCalls: 0, reliabilityRate: 0,
    infrastructureFailures: 0, recoverableFailures: 0, completed: 0,
    operationSuccessRate: 0, averageDuration: 0
  };
  const noBaselineMetrics = analyticsMetrics(currentMetricScope, previousWithoutRateBaselines);
  assert.equal(noBaselineMetrics.some(metric => metric.key === 'reliabilityRate'), false, 'Reliability remains diagnostic instrumentation, not a normal Analytics metric');
  assert.equal(noBaselineMetrics.some(metric => metric.key === 'infrastructureFailures'), false, 'Internal errors must not occupy a normal Analytics metric tile');
  assert.equal(noBaselineMetrics.find(metric => metric.key === 'operationSuccessRate')?.help.length > 0, true, 'Rate metrics must retain contextual help');
  assert.equal(noBaselineMetrics.find(metric => metric.key === 'operationSuccessRate')?.delta, null, 'A missing prior success-rate baseline must not be displayed as a 0% comparison');
  
  const comparedMetrics = analyticsMetrics(currentMetricScope, { ...previousWithoutRateBaselines, toolCalls: 10, reliabilityCalls: 10, reliableCalls: 9, reliabilityRate: 90, completed: 10, operationSuccessRate: 90, averageDuration: 7000 });
  assert.equal(comparedMetrics.find(metric => metric.key === 'operationSuccessRate')?.delta?.text, '+2.7 pp', 'Measured success rates must compare in percentage points');
  const deliveryMetrics = analyticsMetrics({
    ...currentMetricScope,
    requestDeliveryRate: 99.91,
    transport: { request_started: 2193, response_delivered: 2191, connection_closed: 2, upstream_5xx: 15 }
  }, { ...previousWithoutRateBaselines, requestDeliveryRate: 100, transport: { request_started: 100, response_delivered: 100 } });
  const deliveryMetric = deliveryMetrics.find(metric => metric.key === 'requestDeliveryRate');
  assert.equal(deliveryMetric?.value, '99.9%');
  assert.match(deliveryMetric?.detail || '', /2,191 of 2,193 responses delivered/);
  assert.match(deliveryMetric?.detail || '', /2 closed early/);
  assert.match(deliveryMetric?.detail || '', /15 server-error responses/);
  const timeline = timelineModel([1, 3, 2], 'Actions');
  assert.match(timeline.summary, /Peak 3/);
  assert.match(timeline.summary, /Overall trend increasing/);
  assert.equal(timeline.max, 3);
  assert.equal(timeline.peakIndex, 1);
  assert.equal(timeline.latestIndex, 2);
  assert.deepEqual(timeline.data, [1, 3, 2]);
  assert.equal('coordinates' in timeline, false);
  assert.equal('points' in timeline, false);
  assert.equal('area' in timeline, false);
  const sparseRateTimeline = timelineModel([null, 100, null, 50], 'Successful actions');
  assert.deepEqual(sparseRateTimeline.data, [null, 100, null, 50]);
  assert.equal(sparseRateTimeline.peakIndex, 1);
  assert.equal(sparseRateTimeline.latestIndex, 3);
  assert.equal(pointMetric({ successes: 0, failures: 0 }, 'operationSuccessRate'), null, 'empty success-rate buckets must remain missing rather than becoming 0%');
  assert.equal(pointMetric({ successes: 0, failures: 0, executionMs: 0 }, 'averageDuration'), null, 'empty duration buckets must remain missing rather than becoming 0 ms');
  assert.equal(formatChartValue(null, 'Successful actions'), '—');
  assert.match(charts, /missingDataBandsPlugin/, 'Sparse timeline charts must visually distinguish missing buckets from rendered failures.');
  assert.match(charts, /missingValueRanges\(data\)/, 'Sparse timeline charts must derive explicit missing-data regions from null buckets.');
  assert.match(usageReact, /missingValueLabel: sparseMetric \? 'No completed actions' : ''/, 'Only sparse rate and duration metrics should label missing buckets as no completed actions.');
  assert.match(usageReact, /shaded gaps mean no completed actions were recorded in those buckets/i, 'Analytics help text must explain the missing-data treatment.');
  
  for (const label of ['Actions', 'Retryable problems', 'Successful actions', 'Average time']) {
    assert.match(usageCombined, new RegExp(label), `Usage must render ${label}.`);
  }
  assert.doesNotMatch(usageRender, /metric\('Reliable actions'|metric\('Internal errors'/, 'Reliability and internal errors must not occupy normal Analytics metric tiles');
  assert.doesNotMatch(usageReact, /\['infrastructureFailures', 'Internal errors'/, 'Internal errors must not remain in the normal timeline metric switcher');
  assert.match(usageReact, /usage-infrastructure-alert/, 'Confirmed infrastructure failures must surface only as an exceptional Analytics warning');
  assert.match(usageReact, /Open Troubleshooting/, 'Infrastructure warnings must link to Troubleshooting');
  assert.doesNotMatch(usageReact, /usage-transport-alert|Connection delivery/, 'Historical transport counters must not render as a standalone warning banner');
  assert.match(usageRender, /Request delivery/, 'Transport delivery must be integrated as a neutral Analytics metric');
  assert.match(workspacesReact, /Successful actions/, 'Project analytics must show normal success rate instead of the reliability percentage');
  assert.doesNotMatch(workspacesReact, /label: 'Reliable'/, 'Project analytics must not expose the diagnostic reliability percentage');
  for (const field of ['requests', 'toolCalls', 'successes', 'failures', 'executionMs', 'activeDays']) {
    assert.match(usageCombined, new RegExp(`\\b${field}\\b`), `Analytics must consume ${field}.`);
  }
  assert.match(usageReact, /Analytics unavailable/);
  assert.match(usageReact, /Retry/);
  assert.match(usageReact, /Refresh/);
  assert.match(usageRender, /operationSuccessRate/);
  assert.match(usageRender, /recoverableFailures/);
  assert.match(usageCombined, /Unsuccessful actions by reason/);
  assert.match(usageCombined, /Recent details are available in Troubleshooting/);
  for (const label of ['Task state', 'Changed state', 'Search & index', 'Browser & desktop', 'App & local data', 'Internal error', 'Unclassified']) {
    assert.match(usageRender, new RegExp(label.replace(/[&]/g, '\\&')), `Analytics must expose the refined failure label ${label}.`);
  }
  assert.doesNotMatch(usageRender, /Trend starts now|Completed outcomes|Workspace position|usage-fact-strip|<h3>Outcomes<\/h3>/);
  
  const snapshot = buildUsageModel({
    ok: true,
    month: '2026-08',
    totals: { requests: 8, toolCalls: 5, successes: 4, failures: 1, executionMs: 5600, activeDays: 2 },
    tools: [{ tool: 'relai_read', toolCalls: 3, successes: 3, failures: 0, executionMs: 900 }],
    workspaces: [{ workspace: 'repo', toolCalls: 5, successes: 4, failures: 1, executionMs: 5600 }],
    failureCategories: [{ category: 'SENSITIVE_PATH_RESTRICTED', failures: 1 }]
  }, '2026-08');
  assert.equal('source' in snapshot, false);
  assert.equal('devices' in snapshot, false);
  assert.equal(snapshot.totals.toolCalls, 5);
  assert.equal(snapshot.tools[0].tool, 'relai_read');
  assert.deepEqual(snapshot.failureCategories, [{ category: 'policy', failures: 1 }], 'known error-code values must normalize into a useful failure category');
  assert.equal(currentUsageMonth(new Date('2026-08-08T00:00:00.000Z')), '2026-08');
  assert.throws(() => buildUsageModel({ ok: true, month: '2026-08', totals: { requests: -1 } }), /Usage is unavailable|invalid value/);
  
  const bounds = analyticsBounds('24h', { now: new Date('2026-08-08T12:00:00.000Z') });
  assert.equal(bounds.start.toISOString(), '2026-08-07T12:00:00.000Z');
  const ranged = analyticsRangeScope([buildUsageModel({
    ok: true,
    month: '2026-08',
    totals: { requests: 2, toolCalls: 2, successes: 1, failures: 1, executionMs: 100, activeDays: 1 },
    tools: [], workspaces: [],
    series: [{ hour: '2026-08-08T10', requests: 2, toolCalls: 2, successes: 1, failures: 1, executionMs: 100 }],
    toolSeries: [], workspaceSeries: [], workspaceToolSeries: [],
    activityMatrixSeries: [
      { hour: '2026-08-08T10', intent: 'bugfix', useCase: 'edit', toolCalls: 1, successes: 1, failures: 0, executionMs: 40 },
      { hour: '2026-08-08T10', intent: 'untracked', useCase: 'execute', toolCalls: 1, successes: 0, failures: 1, executionMs: 60 }
    ],
    taskIntentSeries: [{ hour: '2026-08-08T10', intent: 'bugfix', tasks: 1 }],
    failureCategorySeries: [{ hour: '2026-08-08T10', category: 'policy', failures: 1 }]
  }, '2026-08')], bounds);
  assert.equal(ranged.toolCalls, 2);
  assert.equal(ranged.averageDuration, 50);
  assert.deepEqual(ranged.failureCategories, [{ category: 'policy', failures: 1 }]);
  assert.deepEqual(ranged.useCases.map(row => [row.useCase, row.toolCalls]), [['edit', 1], ['execute', 1]]);
  assert.deepEqual(ranged.taskTypes, [{ intent: 'bugfix', tasks: 1 }]);
  assert.deepEqual(ranged.activityMatrix.map(row => [row.intent, row.useCase, row.toolCalls]), [['bugfix', 'edit', 1]]);
  assert.equal(ranged.categorizedActions, 2);
  assert.equal(ranged.untrackedActions, 1);
  assert.equal(ranged.completedTasks, 1);
  
  const rollingHourBounds = analyticsBounds('1h', { now: new Date('2026-08-08T10:45:00.000Z') });
  assert.equal(rollingHourBounds.start.toISOString(), '2026-08-08T10:00:00.000Z');
  assert.equal(rollingHourBounds.end.toISOString(), '2026-08-08T11:00:00.000Z');
  const rollingHour = analyticsRangeScope([buildUsageModel({
    ok: true,
    month: '2026-08',
    totals: { requests: 2, toolCalls: 2, successes: 2, failures: 0, executionMs: 20, activeDays: 1 },
    tools: [], workspaces: [],
    series: [
      { hour: '2026-08-08T09', requests: 1, toolCalls: 1, successes: 1, failures: 0, executionMs: 10 },
      { hour: '2026-08-08T10', requests: 1, toolCalls: 1, successes: 1, failures: 0, executionMs: 10 }
    ],
    toolSeries: [], workspaceSeries: [], workspaceToolSeries: []
  }, '2026-08')], rollingHourBounds);
  assert.equal(rollingHour.toolCalls, 1, 'one-hour analytics must represent the current UTC-hour bucket without pulling in the previous partial bucket');
  assert.equal(rollingHour.points.reduce((sum, point) => sum + point.toolCalls, 0), 1, 'timeline totals must match the aligned UTC-hour range');
  
  const loaded = await loadAnalyticsData({
    desktop: { getLocalUsage: async () => ({
      ok: true,
      month: '2026-08',
      privacy: { retentionDays: 180, externalTelemetry: { enabled: false, endpointConfigured: true, sampleRatio: 0.25 } },
      totals: { requests: 2, toolCalls: 2, successes: 2, failures: 0, executionMs: 120, activeDays: 1 },
      tools: [], workspaces: [{ workspace: 'repo', toolCalls: 2, successes: 2, failures: 0, executionMs: 120 }],
      workspaceTools: [],
      series: [{ hour: '2026-08-08T10', requests: 2, toolCalls: 2, successes: 2, failures: 0, executionMs: 120 }],
      toolSeries: [], workspaceSeries: [{ hour: '2026-08-08T10', workspace: 'repo', toolCalls: 2, successes: 2, failures: 0, executionMs: 120 }], workspaceToolSeries: []
    }) },
    range: '24h',
    now: new Date('2026-08-08T12:00:00.000Z')
  });
  assert.equal(loaded.current.toolCalls, 2);
  assert.equal(loaded.current.workspaces[0].workspace, 'repo');
  assert.deepEqual(loaded.privacy, {
    retentionDays: 180,
    externalTelemetry: { enabled: false, endpointConfigured: true, sampleRatio: 0.25 }
  });
  
  console.log('Local analytics UI and privacy contracts passed.');
}
await case_usage_ui_contract_unit();
