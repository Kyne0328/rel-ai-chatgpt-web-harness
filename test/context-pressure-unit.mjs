import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installForcedLowHostMemory } from './helpers/forced-low-host-memory.mjs';
import { startMcpClient } from './helpers/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-context-pressure-'));
const restoreMemory = installForcedLowHostMemory();
const { repositoryIntelligence } = await import('../src/repository/intelligence/service.js');
const { repositoryIndexPath, openIndexDatabase, ensureIndexSchema, beginGeneration, finishGeneration } = await import('../src/repository/intelligence/database.js');
const { repositoryQueryWorkerStats } = await import('../src/repository/intelligence/queryWorkerClient.js');
const { hostResourceDiagnosticSnapshot, acquireHostResource } = await import('../src/hostResourceScheduler.js');
const evidence = [];
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function settledByNextTurn(pending, message) {
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  await nextTurn();
  assert.equal(settled, true, message);
  return pending;
}

function fixture(name, cached = false) {
  const directory = path.join(temp, name);
  const workspace = { alias: 'fixture', path: path.join(directory, 'repo') };
  fs.mkdirSync(workspace.path, { recursive: true });
  fs.writeFileSync(path.join(workspace.path, 'index.js'), 'export const value = 1;\n');
  const config = { version: 3, stateDir: path.join(directory, 'state'), auditLogPath: path.join(directory, 'state', 'audit.jsonl'), workspaces: { fixture: { path: workspace.path, commands: {} } } };
  if (cached) {
    const db = openIndexDatabase(repositoryIndexPath(config, workspace));
    ensureIndexSchema(db);
    const generation = beginGeneration(db, 'full');
    finishGeneration(db, generation, 'committed', 0);
    db.close();
  }
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { directory, workspace, config, configPath };
}

const blockers = [];
try {
  const missing = fixture('missing');
  const before = hostResourceDiagnosticSnapshot();
  const absent = await settledByNextTurn(
    repositoryIntelligence.cachedSummary(missing.workspace, missing.config, { optional: true }),
    'missing cache must settle without waiting for resource admission'
  );
  assert.equal(absent.available, false);
  assert.equal(absent.reason, 'cache_missing');
  assert.equal(absent.cacheOnly, true);
  const after = hostResourceDiagnosticSnapshot();
  assert.equal(after.pressure.sampledAtMs, before.pressure.sampledAtMs, 'missing-cache lookup must not even trigger a host sample');
  assert.equal(after.lanes.heavy.active, 0);
  assert.equal(after.lanes.heavy.queued, 0);
  assert.equal(repositoryQueryWorkerStats().liveWorkerCount, 0);

  const cached = fixture('cached', true);
  for (let i = 0; i < hostResourceDiagnosticSnapshot().lanes.repositoryQuery.limit; i++) blockers.push(await acquireHostResource('repositoryQuery', 'occupied-query-slot'));
  // Advance only the service's timer clock. OS scheduling must not determine
  // whether the optional lookup honors its configured 120 ms budget.
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const pending = repositoryIntelligence.cachedSummary(cached.workspace, cached.config, { optional: true, cachedLookupBudgetMs: 120 });
  let lookupSettled = false;
  void pending.then(() => { lookupSettled = true; }, () => { lookupSettled = true; });
  await nextTurn();
  assert.equal(hostResourceDiagnosticSnapshot().pressure.admissionEnforced, false);
  assert.equal(hostResourceDiagnosticSnapshot().lanes.repositoryQuery.queued, 1);
  mock.timers.tick(119);
  await nextTurn();
  assert.equal(lookupSettled, false, 'optional lookup must retain its full configured budget');
  assert.equal(hostResourceDiagnosticSnapshot().lanes.repositoryQuery.queued, 1);
  mock.timers.tick(1);
  const deferred = await settledByNextTurn(pending, 'optional lookup must settle when its budget expires while every query slot remains occupied');
  assert.equal(deferred.available, false);
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.reason, 'cached_lookup_budget_exhausted');
  assert.equal(hostResourceDiagnosticSnapshot().lanes.heavy.queued, 0, 'optional budget expiry must remove its heavy ticket');
  assert.equal(hostResourceDiagnosticSnapshot().lanes.repositoryQuery.queued, 0);
  assert.equal(repositoryQueryWorkerStats().liveWorkerCount, 0, 'occupied query slots prevent a worker from spawning');
  for (let i = 0; i < 5; i += 1) {
    const retry = await settledByNextTurn(
      repositoryIntelligence.cachedContext(cached.workspace, cached.config, { optional: true }),
      'cached lookup backoff must settle without another admission attempt'
    );
    assert.equal(retry.reason, 'cached_lookup_backoff', 'repeated optional requests must not churn worker startup');
  }
  assert.equal(repositoryQueryWorkerStats().liveWorkerCount, 0);

  const cancelled = fixture('cancelled', true);
  const controller = new AbortController();
  const stopped = repositoryIntelligence.cachedSummary(cancelled.workspace, cancelled.config, { optional: true, signal: controller.signal });
  const reason = new Error('Owner requested cancellation.');
  const rejected = assert.rejects(stopped, error => error === reason);
  await nextTurn();
  assert.equal(hostResourceDiagnosticSnapshot().lanes.repositoryQuery.queued, 1);
  controller.abort(reason);
  await settledByNextTurn(rejected, 'owner cancellation must settle without waiting for the optional budget');
  assert.equal(hostResourceDiagnosticSnapshot().lanes.heavy.queued, 0);
  assert.equal(hostResourceDiagnosticSnapshot().lanes.repositoryQuery.queued, 0);
  await assert.rejects(repositoryIntelligence.cachedSummary(missing.workspace, missing.config, { optional: true, signal: controller.signal }), error => error === reason);
  evidence.push({ phase: 'forced-low-service', missing: absent, existing: deferred, workers: repositoryQueryWorkerStats().liveWorkerCount });
  mock.timers.reset();
  for (const blocker of blockers.splice(0)) blocker.release();
  const ready = await repositoryIntelligence.cachedSummary(cancelled.workspace, cancelled.config, { queryTimeoutMs: 5000 });
  assert.equal(ready.available, true, 'cached repository queries execute despite very low reported memory');
} finally {
  mock.timers.reset();
  for (const blocker of blockers) blocker.release();
  await repositoryIntelligence.shutdown();
  restoreMemory();
}

try {
  for (const mode of ['actual-missing', 'forced-low-missing', 'forced-low-existing']) {
    const item = fixture(mode, mode.endsWith('existing'));
    const env = { REL_AI_MCP_STATE_DIR: item.config.stateDir };
    // Hold both optional-work lanes before the cold server starts. They stay
    // occupied until process exit, so a real payload proves protected tools
    // do not wait for repository work. The existing transport watchdog bounds
    // hangs; elapsed wall time below is diagnostic, not a performance contract.
    const preload = path.join(item.directory, 'held-context-resources.mjs');
    const heldResourcesPath = path.join(item.directory, 'held-resources.json');
    const schedulerUrl = pathToFileURL(path.join(root, 'src/hostResourceScheduler.js')).href;
    const memoryFixtureUrl = pathToFileURL(path.join(root, 'test/helpers/forced-low-host-memory.mjs')).href;
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      mode.startsWith('forced-low')
        ? `const { installForcedLowHostMemory } = await import(${JSON.stringify(memoryFixtureUrl)}); installForcedLowHostMemory();`
        : '',
      `const { acquireHostResource, hostResourceDiagnosticSnapshot } = await import(${JSON.stringify(schedulerUrl)});`,
      'const held = [];',
      "for (const lane of ['heavy', 'repositoryQuery']) {",
      '  const limit = hostResourceDiagnosticSnapshot().lanes[lane].limit;',
      "  for (let i = 0; i < limit; i++) held.push(await acquireHostResource(lane, 'context-pressure-latch'));",
      '}',
      `fs.writeFileSync(${JSON.stringify(heldResourcesPath)}, JSON.stringify(hostResourceDiagnosticSnapshot().lanes));`,
      ''
    ].join('\n'));
    env.NODE_OPTIONS = '--import=' + pathToFileURL(preload).href;
    const client = startMcpClient({ root, configPath: item.configPath, env, timeoutMs: 10_000 });
    let id = 0;
    const rpc = async (name, args) => {
      const start = performance.now();
      client.call(++id, name, args);
      const response = await client.waitFor(id, 10_000);
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.equal(response.result?.isError, false, JSON.stringify(response));
      return { elapsedMs: Math.round(performance.now() - start), payload: response.result.structuredContent };
    };
    try {
      client.initialize(++id);
      await client.waitFor(id);
      const heldResources = JSON.parse(fs.readFileSync(heldResourcesPath, 'utf8'));
      for (const lane of ['heavy', 'repositoryQuery']) {
        assert.ok(heldResources[lane].limit > 0);
        assert.equal(heldResources[lane].active, heldResources[lane].limit, `${mode}: ${lane} slots must all be held before MCP startup`);
      }
      const begin = await rpc('relai_work', { action: 'begin', workspace: 'fixture', objective: 'Verify protected context under memory pressure.', bootstrap: 'compact' });
      assert.equal(begin.payload.status, 'planning', 'cold begin must complete while optional work is blocked');
      assert.ok(begin.payload.work_id);
      const context = await rpc('relai_work', { action: 'context', work_id: begin.payload.work_id, bootstrap: 'compact' });
      assert.ok(context.payload.bootstrap, 'Tiny context must finish without leaving the client with only a pending receipt: ' + JSON.stringify(context));
      assert.equal(context.payload.bootstrap.mode, 'compact');
      assert.equal(Number.isInteger(context.payload.bootstrap.fileCount), true);
      assert.equal(context.payload.bootstrap.repositoryIntelligence.available, false, 'missing cache or occupied query slots must not delay context');
      if (!context.payload.bootstrap.repositoryIntelligence.available) {
        assert.equal(context.payload.bootstrap.repositoryIntelligence.cacheOnly, true);
        assert.equal(context.payload.bootstrap.repositoryIntelligence.status, mode.endsWith('existing') ? 'deferred' : 'unavailable');
      }
      if (mode.endsWith('existing')) {
        assert.equal(context.payload.bootstrap.repositoryIntelligence.reason, 'cached_lookup_budget_exhausted');
      }
      const read = await rpc('relai_read', { workspace: 'fixture', paths: ['index.js'] });
      assert.equal(read.payload.returnedCount, 1);
      const status = await rpc('relai_work', { action: 'status', work_id: begin.payload.work_id });
      assert.equal(status.payload.ok, true);
      evidence.push({ mode, heldResources, begin, context, read, status });
    } finally {
      await client.close();
    }
  }
  if (process.env.RELAI_TEST_EVIDENCE_DIR) {
    fs.mkdirSync(process.env.RELAI_TEST_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.RELAI_TEST_EVIDENCE_DIR, 'context-pressure-after.json'), JSON.stringify(evidence, null, 2));
  }
  console.log(JSON.stringify(evidence.map(item => item.phase ? item : {
    mode: item.mode, heldResources: item.heldResources, beginMs: item.begin.elapsedMs, contextMs: item.context.elapsedMs,
    bootstrap: item.context.payload.bootstrap, readMs: item.read.elapsedMs,
    readOk: item.read.payload.ok, statusMs: item.status.elapsedMs, statusOk: item.status.payload.ok
  }), null, 2));
  console.log('Protected context actual/forced-low pressure, cache-only fallback, cancellation, and queue cleanup passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
