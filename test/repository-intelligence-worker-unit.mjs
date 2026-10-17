import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  indexProducerVersion,
  openIndexDatabase,
  repositoryIndexPath,
  setIndexProducerVersion
} from '../src/repository/intelligence/database.js';
import {
  INDEX_FULL_TIMEOUT_MS,
  INDEX_INCREMENTAL_TIMEOUT_MS,
  evictIdleRepositoryWorkers
} from '../src/repository/intelligence/indexer.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { writeTextFileSafe } from '../src/safety.js';
import { intelligenceRuntimeFingerprint } from '../src/repository/intelligence/producer.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-repository-worker-'));
const stateDir = path.join(root, '.state');
const workspaceRoot = path.join(root, 'workspace');
fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'src', 'alpha.js'), 'export function alpha() { return 1; }\n');
fs.writeFileSync(path.join(workspaceRoot, 'src', 'beta.js'), 'export function beta() { return alpha(); }\n');
fs.mkdirSync(path.join(workspaceRoot, 'public', 'dashboard-chunks'), { recursive: true });
fs.writeFileSync(
  path.join(workspaceRoot, 'public', 'dashboard-chunks', 'generated.js'),
  `const generatedMarker=1;${'const bundledValue=generatedMarker;'.repeat(5000)}`,
  'utf8'
);

const workspace = { alias: 'worker-test', path: workspaceRoot, context: {}, testCommands: {}, commands: {} };
const config = { stateDir };
const plannedIndexPath = repositoryIndexPath(config, workspace);
assert.equal(INDEX_INCREMENTAL_TIMEOUT_MS, 60_000,
  'incremental refreshes should fail fast rather than inheriting the full-build budget');
assert.equal(INDEX_FULL_TIMEOUT_MS, 300_000,
  'full, rebuild, and recovery indexing need enough budget to include the bounded Zoekt rebuild');
assert.equal(fs.existsSync(path.dirname(plannedIndexPath)), false,
  'resolving an intelligence index path must not create runtime directories on a read-only path');

try {
  const initial = await repositoryIntelligence.ensure(workspace, config);
  assert.equal(initial.workerIsolated, true);
  assert.equal(initial.scanMode, 'full');
  assert.equal(initial.runtimeStatus, 'ready');
  assert.ok(initial.sourceFileCount >= 3);
  assert.equal(initial.structuralSkippedGeneratedFileCount, 1,
    'large minified/generated bundles must remain lexically indexed without building structural occurrence graphs');
  const initialDb = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const generated = initialDb.prepare("SELECT parser FROM files WHERE path='public/dashboard-chunks/generated.js'").get();
    assert.equal(generated?.parser, 'lexical-generated');
    assert.equal(Number(initialDb.prepare("SELECT COUNT(*) AS n FROM occurrences o JOIN files f ON f.id=o.file_id WHERE f.path='public/dashboard-chunks/generated.js'").get().n), 0);
  } finally { initialDb.close(); }
  assert.equal(repositoryIntelligence.status(workspace, config).watching, true,
    'interactive Repository Intelligence should retain live workspace watching');

  assert.equal(evictIdleRepositoryWorkers('test idle eviction'), 1);
  const afterEvictionStatus = repositoryIntelligence.status(workspace, config);
  assert.equal(afterEvictionStatus.status, 'ready');
  assert.equal(afterEvictionStatus.active, false);
  assert.equal(afterEvictionStatus.dirty, false);

  fs.writeFileSync(path.join(workspaceRoot, 'src', 'alpha.js'), 'export function alpha() { return 2; }\n');
  repositoryIntelligence.noteMutation(workspace, config, ['src/alpha.js']);
  const incremental = await repositoryIntelligence.ensure(workspace, config);
  assert.equal(incremental.scanMode, 'incremental');
  assert.equal(incremental.changedPathCount, 1);
  assert.equal(incremental.pendingRefresh, false);
  if (initial.zoekt?.current === true) {
    assert.equal(incremental.zoekt?.current, false,
      'incremental graph changes must mark the prior Zoekt generation stale immediately');
    assert.equal(repositoryIntelligence.status(workspace, config).zoektRefreshScheduled, true,
      'incremental graph changes must schedule a coalesced Zoekt refresh');
    await waitForZoektCurrent();
    const afterZoektRefresh = repositoryIntelligence.status(workspace, config);
    assert.equal(afterZoektRefresh.metadata?.scanMode, 'incremental',
      'refreshing Zoekt after a one-file edit must not force a full Repository Intelligence reconciliation');
    assert.equal(afterZoektRefresh.metadata?.generation, incremental.generation,
      'refreshing Zoekt must preserve the already-current graph generation');
  }

  assert.equal(evictIdleRepositoryWorkers('test second idle eviction'), 1);
  const cached = await repositoryIntelligence.ensure(workspace, config);
  assert.equal(cached.cacheHit, true);
  assert.equal(evictIdleRepositoryWorkers('cache hit must not recreate worker'), 0);

  const realNow = Date.now;
  try {
    const baselineNow = realNow();
    Date.now = () => baselineNow + 10 * 60_000;
    const watcherCached = await repositoryIntelligence.ensure(workspace, config);
    assert.equal(watcherCached.cacheHit, true,
      'a healthy watcher must remain authoritative instead of forcing periodic full scans');
    assert.equal(evictIdleRepositoryWorkers('healthy watcher cache hit must not recreate worker'), 0);
  } finally {
    Date.now = realNow;
  }

  const status = repositoryIntelligence.status(workspace, config);
  assert.equal(status.status, 'ready');
  assert.equal(status.active, false);
  assert.equal(status.dirty, false);

  const rebuilt = await repositoryIntelligence.rebuild(workspace, config);
  assert.equal(rebuilt.scanMode, 'full');
  assert.equal(rebuilt.rebuilt, true);
  assert.ok(rebuilt.generation > incremental.generation);

  const generationBeforeRestart = rebuilt.generation;
  await repositoryIntelligence.shutdown();
  const resumed = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(resumed.generation, generationBeforeRestart,
    'an unchanged restart must reuse the persisted generation instead of rebuilding it');
  assert.equal(resumed.cacheHit, true);
  assert.equal(resumed.changedPathCount, 0);

  const alphaPath = path.join(workspaceRoot, 'src', 'alpha.js');
  const alphaStat = fs.statSync(alphaPath);
  const generationBeforeTimestampCollision = rebuilt.generation;
  await repositoryIntelligence.shutdown();
  fs.writeFileSync(alphaPath, 'export function alpha() { return 3; }\n');
  fs.utimesSync(alphaPath, alphaStat.atime, alphaStat.mtime);
  const reconciled = await repositoryIntelligence.ensure(workspace, config, { force: true, watch: false });
  assert.ok(reconciled.generation > generationBeforeTimestampCollision,
    'a same-size edit with restored mtime must still be detected through ctime or content hashing');

  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(workspaceRoot, 'src', `extra-${index}.js`), `export const extra${index} = ${index};\n`);
  }
  const expanded = await repositoryIntelligence.rebuild(workspace, config, { watch: false });
  const partial = await repositoryIntelligence.ensure(workspace, config, { force: true, maxFiles: 1, watch: false });
  assert.equal(partial.truncated, true);
  assert.equal(partial.deletionDeferred, true,
    'a truncated full scan must never infer deletions for files outside the scan budget');
  assert.ok(partial.sourceFileCount >= expanded.sourceFileCount,
    'truncated reconciliation must retain previously indexed files');
  assert.equal(partial.freshness, 'partial');
  assert.equal(partial.needsReconcile, true);
  assert.equal(partial.zoekt?.current, false,
    'a partial repository scan must not publish an incomplete Zoekt index as current');
  const repairedPartial = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(repairedPartial.pendingRefresh, false,
    'a partial index must remain dirty until a complete reconciliation succeeds');

  await repositoryIntelligence.shutdown();
  const staleProducerDb = openIndexDatabase(repositoryIndexPath(config, workspace));
  try {
    setIndexProducerVersion(staleProducerDb, 'stale-producer-regression');
  } finally {
    staleProducerDb.close();
  }
  const producerRecovered = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(producerRecovered.recovered, true,
    'a producer-version change must rebuild the derived index from a clean database instead of rewriting the old index in place');
  assert.match(String(producerRecovered.recoveryReason || ''), /producer changed/i);
  const producerDb = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    assert.equal(indexProducerVersion(producerDb), intelligenceRuntimeFingerprint());
  } finally {
    producerDb.close();
  }

  await repositoryIntelligence.shutdown();
  fs.writeFileSync(repositoryIndexPath(config, workspace), 'not-a-sqlite-database', 'utf8');
  const recovered = await repositoryIntelligence.ensure(workspace, config);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.scanMode, 'full');
  assert.ok(recovered.sourceFileCount >= 2);

  const controller = new AbortController();
  const cancelled = repositoryIntelligence.ensure(workspace, config, { force: true, signal: controller.signal });
  controller.abort(new Error('test active cancellation'));
  await assert.rejects(
    cancelled,
    error => error?.code === 'INDEX_ABORTED' && error?.name === 'AbortError'
  );
  await waitForIdle();
  const afterCancellation = await repositoryIntelligence.ensure(workspace, config, { force: true });
  assert.equal(afterCancellation.runtimeStatus, 'ready');
  assert.equal(afterCancellation.workerIsolated, true);

  for (let index = 0; index < 1500; index += 1) {
    fs.writeFileSync(path.join(workspaceRoot, 'src', `timeout-${index}.js`), `export const timeout${index} = ${index};\n`);
  }
  await assert.rejects(
    repositoryIntelligence.ensure(workspace, config, { force: true, watch: false, indexTimeoutMs: 1 }),
    error => error?.code === 'INDEX_TIMEOUT',
    'indexing must fail with a bounded timeout instead of leaving callers waiting indefinitely'
  );
  await waitForIdle();
  const afterTimeout = await repositoryIntelligence.ensure(workspace, config, { force: true, watch: false });
  assert.equal(afterTimeout.runtimeStatus, 'ready', 'a timed-out index worker must recover for the next request');
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}

await verifyNativeAtomicWatcher();

async function verifyNativeAtomicWatcher() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-watcher-'));
  const workspace = { alias: 'native-watcher', path: path.join(fixture, 'workspace'), context: {} };
  const config = { stateDir: path.join(fixture, 'state') };
  fs.mkdirSync(path.join(workspace.path, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace.path, 'src', 'alpha.js'), 'export const beforeAtomicSave = 1;\n');
  const originalWatch = fs.watch;
  let watcher;
  const events = [];
  fs.watch = (...args) => {
    const callback = args[2];
    args[2] = (...event) => { events.push(event.map(String)); callback(...event); };
    watcher = originalWatch(...args);
    return watcher;
  };
  try {
    await repositoryIntelligence.ensure(workspace, config);
  } finally {
    fs.watch = originalWatch;
  }
  const indexed = () => {
    const db = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
    try {
      return { paths: db.prepare('SELECT path FROM files ORDER BY path').all().map(row => row.path),
        names: db.prepare('SELECT name FROM symbols ORDER BY name').all().map(row => row.name) };
    } finally { db.close(); }
  };
  const refreshAfter = async (mutate, expected, mode = 'incremental') => {
    events.length = 0;
    mutate();
    const deadline = Date.now() + 5000;
    let metadata;
    do {
      if (repositoryIntelligence.status(workspace, config).dirty) {
        metadata = await repositoryIntelligence.ensure(workspace, config);
        if (mode) assert.equal(metadata.scanMode, mode, `native watcher transition must use the expected observation scope: ${JSON.stringify(events)}`);
        if (expected(indexed()) && !metadata.pendingRefresh) return metadata;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    assert.fail('Native watcher did not publish the expected file and symbol state.');
  };
  try {
    assert.equal(repositoryIntelligence.status(workspace, config).watching, true);
    const saved = await refreshAfter(
      () => writeTextFileSafe(workspace.path, 'src/alpha.js', 'export const afterAtomicSave = 2;\n'),
      state => state.names.includes('afterAtomicSave') && !state.names.includes('beforeAtomicSave')
    );
    assert.equal(saved.changedPathCount, 1);
    assert.deepEqual(indexed().paths, ['src/alpha.js'], 'temporary safe-writer files must not enter the index');
    await refreshAfter(
      () => writeTextFileSafe(workspace.path, 'src/added.js', 'export const addedBySafeWriter = 3;\n'),
      state => state.names.includes('addedBySafeWriter')
    );
    await refreshAfter(
      () => fs.renameSync(path.join(workspace.path, 'src', 'added.js'), path.join(workspace.path, 'src', 'renamed.js')),
      state => state.paths.includes('src/renamed.js') && !state.paths.includes('src/added.js')
    );
    await refreshAfter(
      () => fs.rmSync(path.join(workspace.path, 'src', 'renamed.js')),
      state => !state.paths.includes('src/renamed.js') && !state.names.includes('addedBySafeWriter'),
      // Some native backends deliver a separate parent-directory event after
      // the exact deletion was consumed; that uncertain event stays full-scan.
      null
    );
    await refreshAfter(
      () => fs.renameSync(path.join(workspace.path, 'src'), path.join(workspace.path, 'moved')),
      state => state.paths.includes('moved/alpha.js') && !state.paths.includes('src/alpha.js'),
      'full'
    );
    await refreshAfter(
      () => fs.writeFileSync(path.join(workspace.path, '.relaiignore'), 'moved/\n'),
      state => !state.paths.includes('moved/alpha.js'),
      'full'
    );
    watcher.emit('error', new Error('injected watcher failure'));
    assert.equal(repositoryIntelligence.status(workspace, config).watching, false);
    const recovered = await repositoryIntelligence.ensure(workspace, config, { watch: false });
    assert.equal(recovered.scanMode, 'full', 'watcher failure must retain conservative reconciliation');
  } finally {
    await repositoryIntelligence.dispose(workspace, config);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

async function waitForZoektCurrent() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = repositoryIntelligence.status(workspace, config);
    if (status.metadata?.zoekt?.current === true && status.zoektRefreshScheduled === false) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Repository Intelligence did not refresh Zoekt after incremental changes.');
}

async function waitForIdle() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!repositoryIntelligence.status(workspace, config).active) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Repository Intelligence worker did not settle after cancellation.');
}

console.log('Repository Intelligence worker isolation, incremental refresh, rebuild, recovery, and cancellation tests passed.');
