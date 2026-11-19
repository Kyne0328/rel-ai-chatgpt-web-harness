import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIndexDatabase, repositoryIndexPath } from '../src/repository/intelligence/database.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-repository-collection-'));
const workspaceRoot = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
fs.mkdirSync(path.join(workspaceRoot, '.agents', 'skills', 'vendor-skill'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'src', 'app.js'), 'export const applicationMarker = true;\n');
fs.writeFileSync(path.join(workspaceRoot, '.agents', 'skills', 'vendor-skill', 'tool.py'), 'def irrelevant_vendor_tool():\n    return True\n');

const workspace = { alias: 'collection-policy', path: workspaceRoot, context: {}, testCommands: {}, commands: {} };
const config = { stateDir };

try {
  await repositoryIntelligence.ensure(workspace, config, { force: true, watch: false });
  const db = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const indexedPaths = db.prepare('SELECT path FROM files ORDER BY path').all().map(row => String(row.path));
    assert.ok(indexedPaths.includes('src/app.js'));
    assert.equal(indexedPaths.some(value => value.startsWith('.agents/skills/')), false,
      'installed agent skill implementations must not pollute repository search or relationship graphs');
  } finally {
    db.close();
  }

  // A config-only include/exclude change must not reuse the previous search coverage.
  fs.mkdirSync(path.join(workspaceRoot, 'docs'));
  fs.writeFileSync(path.join(workspaceRoot, 'docs', 'guide.js'), 'export function newlyInScopeMarker() {}\n');
  const narrow = { ...workspace, context: { includeRoots: ['src'] } };
  const wide = { ...workspace, context: { includeRoots: ['docs', 'src'] } };
  const renamed = { ...wide, alias: 'renamed', context: { includePaths: ['./src/', 'docs', 'docs'] } };
  const withoutDocs = { ...wide, context: { ...wide.context, excludePaths: ['docs'] } };
  const inspect = (w, symbol) => repositoryIntelligence.codeInspect(w, config, { action: 'symbol', symbol }, { watch: false });
  const find = async w => (await inspect(w, 'newlyInScopeMarker')).definitions.map(item => item.path);
  assert.deepEqual(await find(narrow), []);
  assert.deepEqual(await find(wide), ['docs/guide.js']);
  assert.deepEqual(await find(withoutDocs), []);
  const oldView = await repositoryIntelligence.ensure(wide, config, { watch: false });
  const sameScope = await repositoryIntelligence.ensure(renamed, config, { watch: false });
  assert.equal(sameScope.cacheHit, true);
  assert.equal(sameScope.builtAt, oldView.builtAt);
  assert.equal(sameScope.workspace, renamed.alias);
  assert.equal(repositoryIntelligence.status(renamed, config).metadata.workspace, renamed.alias);

  fs.writeFileSync(path.join(workspaceRoot, 'src', 'app.js'), 'export function changedInBothScopes() {}\n');
  repositoryIntelligence.noteMutation(narrow, config, ['src/app.js']);
  assert.equal((await inspect(wide, 'changedInBothScopes')).definitions.length, 1,
    'a note through one alias must invalidate other active scopes of the same checkout');
  await repositoryIntelligence.shutdown();
  // Cache-only lookups after restart must reopen their own scope without rebuilding.
  for (const [w, expected] of [[wide, 2], [withoutDocs, 1], [renamed, 2]]) {
    const cached = await repositoryIntelligence.cachedSummary(w, config, { cachedLookupBudgetMs: 5000 });
    assert.equal(cached.sourceFileCount, expected);
  }
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log('Repository Intelligence collection policy excludes installed agent skill implementations.');
