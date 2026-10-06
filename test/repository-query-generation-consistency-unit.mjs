import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  openIndexDatabase,
  repositoryIndexPath,
  setIndexProducerVersion
} from '../src/repository/intelligence/database.js';
import {
  QUERY_WORKER_GLOBAL_COUNT,
  QUERY_WORKER_TIMEOUT_MS,
  repositoryQueryWorkerStats,
  runRepositoryQuery
} from '../src/repository/intelligence/queryWorkerClient.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-query-generation-'));
const workspaceRoot = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'src', 'alpha.js'), 'export function alpha() { return 1; }\n');

const workspace = { alias: 'query-generation', path: workspaceRoot, context: {}, testCommands: {}, commands: {} };
const config = { stateDir };

assert.equal(QUERY_WORKER_GLOBAL_COUNT, (await import('../src/hostResourceScheduler.js')).HOST_REPOSITORY_QUERY_LIMIT, 'query pool and admission must use the same host limit');
assert.equal(QUERY_WORKER_TIMEOUT_MS, 30_000, 'indexed queries must have a bounded default deadline');

try {
  const initial = await repositoryIntelligence.ensure(workspace, config, { force: true, watch: false });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'alpha.js'), 'export function alpha() { return 2; }\n');
  const rebuilt = await repositoryIntelligence.rebuild(workspace, config, { watch: false });
  assert.ok(rebuilt.generation > initial.generation);

  await assert.rejects(
    runRepositoryQuery('semanticSearch', workspace, config, {
      args: { query: 'alpha', maxResults: 5 },
      index: initial
    }, { watch: false }),
    error => error?.code === 'QUERY_INDEX_CHANGED',
    'query workers must reject metadata from an older generation instead of mixing it with newer SQLite facts'
  );

  await repositoryIntelligence.shutdown();
  const producerDb = openIndexDatabase(repositoryIndexPath(config, workspace));
  try {
    setIndexProducerVersion(producerDb, 'stale-query-generation-producer');
  } finally {
    producerDb.close();
  }
  const recovered = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.generation, 1, 'clean producer recovery may restart generation numbering');
  await assert.rejects(
    runRepositoryQuery('semanticSearch', workspace, config, {
      args: { query: 'alpha', maxResults: 5 },
      index: initial
    }, { watch: false }),
    error => error?.code === 'QUERY_INDEX_CHANGED',
    'a clean index rebuild must reject stale metadata even when the generation number is reused'
  );

  const current = await repositoryIntelligence.semanticSearch(workspace, config, { query: 'alpha', maxResults: 5 }, { watch: false });
  assert.equal(current.fingerprint, recovered.fingerprint);
  assert.ok(current.results.some(item => item.path === 'src/alpha.js'));
  assert.equal(repositoryQueryWorkerStats().liveWorkerCount, 1,
    'one semantic query must create only one query worker instead of eagerly warming the full pool');

  await Promise.all(['alpha one', 'alpha two', 'alpha three', 'alpha four'].map(query =>
    repositoryIntelligence.semanticSearch(workspace, config, { query, maxResults: 5 }, { watch: false })));
  assert.ok(repositoryQueryWorkerStats().liveWorkerCount <= QUERY_WORKER_GLOBAL_COUNT,
    'concurrent semantic queries must stay inside the global query worker budget');
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log('Repository Intelligence query generation snapshot consistency test passed.');
