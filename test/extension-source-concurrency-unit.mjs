import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { invalidateConfigCache, makeDefaultConfig, readConfig, writeConfig } from '../src/config.js';
import { addDashboardExtensionSource } from '../src/core/extensions.ts';
import { extensionDashboard } from '../src/extensions/registry.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-source-concurrency-'));
const previous = { fetch: globalThis.fetch, config: process.env.REL_AI_MCP_CONFIG, catalog: process.env.REL_AI_EXTENSIONS_CATALOG_URL };
process.env.REL_AI_MCP_CONFIG = path.join(root, 'config.json');
const officialUrl = 'https://fixture.test/official.json';
process.env.REL_AI_EXTENSIONS_CATALOG_URL = officialUrl;
const sourceA = 'https://fixture.test/a.json';
const sourceB = 'https://fixture.test/b.json';
const catalog = { schemaVersion: 1, updatedAt: '2026-10-04T00:00:00.000Z', extensions: [] };
const reset = sources => writeConfig({ ...makeDefaultConfig(), stateDir: path.join(root, 'state'), extensions: { sources } });
const source = catalogUrl => ({ repositoryUrl: '', catalogUrl });
try {
  for (const length of [null, '1']) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 8) controller.enqueue(new Uint8Array(256 * 1024));
        else controller.close();
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    globalThis.fetch = async () => new Response(body, { headers: length ? { 'content-length': length } : {} });
    const oversized = await extensionDashboard({ stateDir: path.join(root, 'bounded-state') }, { catalogUrl: 'https://fixture.test/oversized.json', refresh: true });
    assert.match(oversized.catalogError, /exceeds the allowed size/);
    assert.equal(cancelled, true, 'chunked catalog overflow must cancel instead of retaining the entire body');
    assert.equal(pulls, 5, 'stop at the first chunk beyond the 1 MiB catalog limit');
    assert.equal(body.locked, false, 'overflow must release its stream reader');
  }
  let firstChunkCancelled = false;
  const firstChunkBody = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { firstChunkCancelled = true; }
  }, { highWaterMark: 0 });
  globalThis.fetch = async () => new Response(firstChunkBody);
  const tooLarge = await extensionDashboard({ stateDir: path.join(root, 'bounded-state') }, { catalogUrl: 'https://fixture.test/first-chunk.json', refresh: true });
  assert.match(tooLarge.catalogError, /exceeds the allowed size/);
  assert.equal(firstChunkCancelled, true);
  assert.equal(firstChunkBody.locked, false);

  const validBytes = new TextEncoder().encode(JSON.stringify(catalog));
  const validBody = new ReadableStream({
    start(controller) {
      for (let index = 0; index < validBytes.length; index += 7) controller.enqueue(validBytes.slice(index, index + 7));
      controller.close();
    }
  });
  globalThis.fetch = async () => new Response(validBody);
  const fragmented = await extensionDashboard({ stateDir: path.join(root, 'bounded-state') }, { catalogUrl: 'https://fixture.test/fragmented.json', refresh: true });
  assert.equal(fragmented.sources[0].status, 'ready');
  assert.equal(validBody.locked, false);

  const originalSetTimeout = globalThis.setTimeout;
  let timeoutBody;
  let downloadSignal;
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 8000 ? 0 : delay, ...args);
  globalThis.fetch = async (_url, options) => {
    downloadSignal = options.signal;
    timeoutBody = new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted fixture download', 'AbortError')), { once: true });
      }
    });
    return new Response(timeoutBody);
  };
  try {
    const timedOut = await extensionDashboard({ stateDir: path.join(root, 'bounded-state') }, { catalogUrl: 'https://fixture.test/timeout.json', refresh: true });
    assert.match(timedOut.catalogError, /Timed out downloading/);
    assert.equal(downloadSignal.aborted, true);
    assert.equal(timeoutBody.locked, false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  reset([]);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.fetch = async url => {
    if (String(url) === sourceA) { entered.resolve(); await release.promise; }
    return new Response(JSON.stringify(catalog));
  };
  const addingA = addDashboardExtensionSource(sourceA);
  await entered.promise;
  writeConfig({ ...readConfig(), projectAccess: { directFilesystem: true } });
  const addingB = addDashboardExtensionSource(sourceB);
  release.resolve();
  await Promise.all([addingA, addingB]);
  const persisted = readConfig();
  assert.equal(persisted.projectAccess.directFilesystem, true, 'source validation must not roll back an unrelated settings save');
  assert.deepEqual(persisted.extensions.sources.map(item => item.catalogUrl).sort(), [sourceA, sourceB]);

  reset([]);
  globalThis.fetch = async () => new Response(JSON.stringify(catalog));
  const duplicates = await Promise.allSettled([addDashboardExtensionSource(sourceA), addDashboardExtensionSource(sourceA)]);
  assert.equal(duplicates.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(duplicates.filter(item => item.status === 'rejected').length, 1);
  assert.equal(readConfig().extensions.sources.length, 1);

  const conflictA = 'https://fixture.test/conflict-a.json';
  const conflictB = 'https://fixture.test/conflict-b.json';
  const collisionCatalog = { ...catalog, extensions: [{
    id: 'fixture.shared', name: 'Shared fixture', version: '1.0.0', description: 'Conflicting source fixture',
    kind: 'skill', manifestUrl: 'https://fixture.test/shared/relai-extension.json',
    repository: 'https://fixture.test/repository', publisher: 'Fixture', permissions: ['workspace.read']
  }] };
  reset([]);
  globalThis.fetch = async url => new Response(JSON.stringify(
    [conflictA, conflictB].includes(String(url)) ? collisionCatalog : catalog
  ));
  const conflicts = await Promise.allSettled([addDashboardExtensionSource(conflictA), addDashboardExtensionSource(conflictB)]);
  assert.equal(conflicts.filter(item => item.status === 'fulfilled').length, 1, 'conflicting source validations must see earlier additions');
  assert.equal(conflicts.filter(item => item.status === 'rejected').length, 1);
  assert.equal(readConfig().extensions.sources.length, 1);

  reset(Array.from({ length: 20 }, (_, index) => source(`https://fixture.test/existing-${index}.json`)));
  await assert.rejects(addDashboardExtensionSource(sourceA), /20|maximum|limit/i);
  assert.equal(readConfig().extensions.sources.length, 20, 'a full source list must reject instead of silently discarding a successful addition');

  const failedSource = 'https://fixture.test/failed.json';
  const fetched = [];
  const releaseCatalogs = Promise.withResolvers();
  globalThis.fetch = async url => {
    fetched.push(String(url));
    await releaseCatalogs.promise;
    if (String(url) === failedSource) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify([conflictA, conflictB].includes(String(url)) ? collisionCatalog : catalog));
  };
  const dashboard = extensionDashboard({ stateDir: path.join(root, 'parallel-state'), extensions: { sources: [source(conflictA), source(conflictB), source(failedSource)] } }, { refresh: true });
  await nextTurn();
  const startedBeforeRelease = [...fetched];
  releaseCatalogs.resolve();
  const result = await dashboard;
  assert.deepEqual(startedBeforeRelease.sort(), [officialUrl, conflictA, conflictB, failedSource].sort(), 'all independent catalogs must start before any one resolves');
  assert.deepEqual(result.sources.map(item => item.status), ['ready', 'ready', 'conflict', 'error'], 'parallel loading must preserve deterministic conflict priority and isolate source failures');
  console.log('Extension source updates preserve concurrent settings and additions; catalog fetches run independently.');
} finally {
  globalThis.fetch = previous.fetch;
  if (previous.config === undefined) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previous.config;
  if (previous.catalog === undefined) delete process.env.REL_AI_EXTENSIONS_CATALOG_URL;
  else process.env.REL_AI_EXTENSIONS_CATALOG_URL = previous.catalog;
  invalidateConfigCache();
  fs.rmSync(root, { recursive: true, force: true });
}
