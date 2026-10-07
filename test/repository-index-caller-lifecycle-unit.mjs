import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { ensureRepositoryIndex, cancelRepositoryIndex, disposeRepositoryIndex, repositoryIndexStatus, shutdownRepositoryIndexes } from '../src/repository/intelligence/indexer.js';
import { repositoryIndexPath } from '../src/repository/intelligence/database.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-index-caller-lifecycle-'));
const config = { stateDir: path.join(root, 'state') };
const originalRm = fs.rmSync;
function workspaceFor(name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'fixture.js'), 'export function fixture() { return 1; }\n');
  return { alias: name, path: directory, context: {} };
}
async function waitUntilDrained(workspace) {
  const deadline = Date.now() + 10000;
  while (repositoryIndexStatus(workspace, config).active) {
    assert.ok(Date.now() < deadline, 'canceled shared build must release its active record');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  for (const canceled of ['initiator', 'joiner']) {
    const workspace = workspaceFor(canceled);
    const first = new AbortController(), second = new AbortController();
    const operations = [
      ensureRepositoryIndex(workspace, config, { watch: false, signal: first.signal }),
      ensureRepositoryIndex(workspace, config, { watch: false, signal: second.signal })
    ];
    (canceled === 'initiator' ? first : second).abort(new Error('Only this requester left'));
    const result = await Promise.allSettled(operations);
    const failed = canceled === 'initiator' ? 0 : 1;
    assert.equal(result[failed].status, 'rejected');
    assert.equal(result[failed].reason.code, 'INDEX_ABORTED');
    assert.equal(result[1 - failed].status, 'fulfilled', 'the other caller still owns shared indexing interest');
    assert.equal(result[1 - failed].value.runtimeStatus, 'ready');
    console.log(JSON.stringify({ case: canceled + '-only-cancel', outcomes: result.map(item => item.status) }));
  }
  {
    const workspace = workspaceFor('public-query-callers');
    const controller = new AbortController();
    const first = repositoryIntelligence.semanticSearch(workspace, config, { query: 'fixture', maxResults: 5 }, { watch: false, signal: controller.signal });
    const second = repositoryIntelligence.semanticSearch(workspace, config, { query: 'fixture', maxResults: 5 }, { watch: false });
    controller.abort(new Error('Cancel only the first service query'));
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes[0].status, 'rejected');
    assert.equal(outcomes[1].status, 'fulfilled', 'the public query service must retain uncanceled interest through indexing and querying');
    assert.ok(outcomes[1].value.results.some(item => item.path === 'fixture.js'));
    console.log('public semantic query service survives cancellation of initiating caller');
  }
  {
    const workspace = workspaceFor('all-callers');
    const controller = new AbortController();
    const operation = ensureRepositoryIndex(workspace, config, { watch: false, signal: controller.signal });
    controller.abort();
    await assert.rejects(operation, error => error.code === 'INDEX_ABORTED');
    await waitUntilDrained(workspace);
    assert.equal((await ensureRepositoryIndex(workspace, config, { watch: false })).runtimeStatus, 'ready');
    console.log('last-waiter cancellation drains and permits retry');
  }
  {
    const workspace = workspaceFor('explicit-cancel');
    const first = ensureRepositoryIndex(workspace, config, { watch: false });
    const second = ensureRepositoryIndex(workspace, config, { watch: false });
    assert.equal(cancelRepositoryIndex(workspace, config), true);
    const results = await Promise.allSettled([first, second]);
    for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.code, 'INDEX_ABORTED'); }
    await waitUntilDrained(workspace);
    console.log('explicit workspace cancellation still cancels every waiter');
  }
  {
    const workspace = workspaceFor('cache-removal');
    const cache = path.dirname(repositoryIndexPath(config, workspace));
    fs.mkdirSync(cache, { recursive: true });
    const sentinel = path.join(cache, 'sentinel');
    fs.writeFileSync(sentinel, 'owned fixture');
    let injected = false;
    fs.rmSync = function(file, ...args) {
      if (path.resolve(String(file)) === cache) {
        injected = true;
        throw Object.assign(new Error('Fixture cache is locked ' + 'x'.repeat(2000)), { code: 'EACCES' });
      }
      return originalRm.call(fs, file, ...args);
    };
    syncBuiltinESMExports();
    let failed, serviceFailed;
    try {
      failed = await disposeRepositoryIndex(workspace, config, { removeCache: true });
      serviceFailed = await repositoryIntelligence.dispose(workspace, config, { removeCache: true });
    }
    finally { fs.rmSync = originalRm; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(failed.detached, true);
    assert.equal(serviceFailed.ok, true, 'successful detach remains separate from failed cleanup');
    assert.equal(serviceFailed.sources[0].cacheRemoved, false);
    assert.equal(serviceFailed.sources[0].cacheRemovalError.code, 'EACCES');
    assert.equal(failed.cacheRemoved, false);
    assert.equal(failed.cacheRemovalError.code, 'EACCES');
    assert.ok(failed.cacheRemovalError.message.length <= 1200);
    assert.equal(fs.existsSync(sentinel), true);
    const retained = await disposeRepositoryIndex(workspace, config);
    assert.equal(retained.cacheRemoved, false);
    assert.equal(fs.existsSync(sentinel), true);
    const removed = await disposeRepositoryIndex(workspace, config, { removeCache: true });
    assert.equal(removed.cacheRemoved, true);
    assert.equal(fs.existsSync(cache), false);
    assert.equal((await disposeRepositoryIndex(workspace, config, { removeCache: true })).cacheRemoved, true);
    console.log(JSON.stringify({ case: 'cache-removal-controls', failureCode: failed.cacheRemovalError.code, detached: failed.detached, cacheRemovedOnFailure: failed.cacheRemoved, successfulAndAbsent: true }));
  }
} finally {
  fs.rmSync = originalRm; syncBuiltinESMExports();
  await repositoryIntelligence.shutdown();
  await shutdownRepositoryIndexes();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log('Repository indexing caller isolation and truthful cache cleanup passed.');
