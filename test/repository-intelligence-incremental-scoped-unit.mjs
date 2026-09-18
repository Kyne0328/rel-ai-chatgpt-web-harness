import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIndexDatabase, repositoryIndexPath } from '../src/repository/intelligence/database.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-incremental-scoped-'));
const stateDir = path.join(root, '.state');
const workspaceRoot = path.join(root, 'workspace');
const workspace = { alias: 'incremental-scoped', path: workspaceRoot, context: {}, testCommands: {}, commands: {} };
const config = { stateDir };

function write(relativePath, source) {
  const file = path.join(workspaceRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source, 'utf8');
}

function edgeRows(db, type, sourcePath, targetPath) {
  return db.prepare(`
    SELECT e.target_name, source.path AS source_path, target.path AS target_path
    FROM edges e
    JOIN files source ON source.id=e.source_file_id
    LEFT JOIN files target ON target.id=e.target_file_id
    WHERE e.type=? AND source.path=? AND (? IS NULL OR target.path=?)
    ORDER BY e.target_name
  `).all(type, sourcePath, targetPath, targetPath);
}

write('src/target.js', 'export function target() { return 1; }\n');
write('src/caller.js', "import { target } from './target.js';\nexport function caller() { return target(); }\n");
write('src/routes.js', "export function getThing() { return true; }\nrouter.get('/v1/things', getThing);\n");
write('src/client.js', "export function loadThing() { return fetch('/v1/things'); }\n");
write('src/late-caller.js', "import './late-target.js';\nexport const lateCaller = true;\n");

try {
  await repositoryIntelligence.ensure(workspace, config, { watch: false });
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'target.js'), 'export function target() { return 2; }\n', 'utf8');
  repositoryIntelligence.noteMutation(workspace, config, ['src/target.js']);
  const targetRefresh = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(targetRefresh.scanMode, 'incremental');
  assert.equal(targetRefresh.changedPathCount, 1);

  fs.writeFileSync(path.join(workspaceRoot, 'src', 'routes.js'), "export function getThing() { return false; }\nrouter.get('/v2/things', getThing);\n", 'utf8');
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'client.js'), "export function loadThing() { return fetch('/v2/things'); }\n", 'utf8');
  repositoryIntelligence.noteMutation(workspace, config, ['src/routes.js', 'src/client.js']);
  const routeRefresh = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(routeRefresh.scanMode, 'incremental');
  assert.equal(routeRefresh.changedPathCount, 2);

  const db = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const call = edgeRows(db, 'CALLS', 'src/caller.js', 'src/target.js');
    assert.ok(call.some(row => row.target_name === 'target'), 'scoped refresh must preserve impacted caller edges');
    const oldRoute = edgeRows(db, 'HTTP_CALLS', 'src/client.js', 'src/routes.js');
    assert.equal(oldRoute.some(row => row.target_name === 'GET /v1/things'), false, 'scoped refresh must remove stale route edges');
    assert.ok(oldRoute.some(row => row.target_name === 'GET /v2/things'), 'scoped refresh must rebuild linked HTTP route edges');
  } finally {
    db.close();
  }

  // A newly added target must update an unchanged import source without
  // falling back to a repository-wide relationship rebuild.
  write('src/late-target.js', 'export const lateTarget = true;\n');
  repositoryIntelligence.noteMutation(workspace, config, ['src/late-target.js']);
  const lateAddition = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(lateAddition.scanMode, 'incremental');
  const lateDb = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const imported = edgeRows(lateDb, 'IMPORTS', 'src/late-caller.js', 'src/late-target.js');
    assert.ok(imported.length > 0, 'scoped addition must re-resolve previously unresolved imports');
  } finally {
    lateDb.close();
  }

  // Added callers and targets must also participate in the scoped generation.
  write('src/new-target.js', 'export function newTarget() { return 3; }\n');
  write('src/new-caller.js', "import { newTarget } from './new-target.js';\nexport function newCaller() { return newTarget(); }\n");
  repositoryIntelligence.noteMutation(workspace, config, ['src/new-target.js', 'src/new-caller.js']);
  const additionRefresh = await repositoryIntelligence.ensure(workspace, config, { watch: false });
  assert.equal(additionRefresh.scanMode, 'incremental');
  const addedDb = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const imported = edgeRows(addedDb, 'IMPORTS', 'src/new-caller.js', 'src/new-target.js');
    assert.ok(imported.length > 0, 'scoped relationship refresh must include newly added files');
  } finally {
    addedDb.close();
  }

  fs.rmSync(path.join(workspaceRoot, 'src', 'new-target.js'));
  repositoryIntelligence.noteMutation(workspace, config, ['src/new-target.js']);
  await repositoryIntelligence.ensure(workspace, config, { watch: false });
  const deletedDb = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const stale = edgeRows(deletedDb, 'IMPORTS', 'src/new-caller.js', 'src/new-target.js');
    assert.equal(stale.length, 0, 'scoped relationship refresh must remove edges to deleted files');
  } finally {
    deletedDb.close();
  }
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Scoped incremental Repository Intelligence relationship refresh tests passed.');
