import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeCrossWorkspace } from '../src/repository/intelligence/crossWorkspace.js';
import { openIndexDatabase, repositoryIndexPath } from '../src/repository/intelligence/database.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-cross-workspace-'));
const stateDir = path.join(root, '.state');
const clientRoot = path.join(root, 'client');
const apiRoot = path.join(root, 'api');
const coldRoot = path.join(root, 'cold');
for (const dir of [clientRoot, apiRoot, coldRoot]) fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

fs.writeFileSync(path.join(clientRoot, 'package.json'), JSON.stringify({
  name: '@acme/client',
  dependencies: { '@acme/api': 'workspace:*' }
}, null, 2));
const genericEvents = ['message', 'exit', 'uncaughtException', 'did-start-loading', 'did-stop-loading', 'before-input-event', 'ready-to-show', 'destroyed'];
const genericEventNoise = Array.from({ length: 60 }, (_, index) => {
  const eventName = genericEvents[index % genericEvents.length];
  return `export function noise${index}() { bus.emit('${eventName}', { index: ${index} }); }`;
}).join('\n');
const genericEventListeners = genericEvents.map((eventName, index) => `export function onGeneric${index}() { return true; }\nbus.on('${eventName}', onGeneric${index});`).join('\n');
fs.writeFileSync(path.join(clientRoot, 'src', 'client.js'), `
export async function loadAccounts() {
  return fetch('https://api.example.test/api/accounts');
}
${genericEventNoise}
export function publishSaved() {
  bus.emit('account:saved', { id: 1 });
}
`);

fs.writeFileSync(path.join(apiRoot, 'package.json'), JSON.stringify({ name: '@acme/api' }, null, 2));
fs.writeFileSync(path.join(apiRoot, 'src', 'routes.js'), `
export function getAccounts() { return ['a']; }
router.get('/api/accounts', getAccounts);
`);
fs.writeFileSync(path.join(apiRoot, 'src', 'events.js'), `
${genericEventListeners}
export function onAccountSaved() { return true; }
bus.on('account:saved', onAccountSaved);
`);

fs.writeFileSync(path.join(coldRoot, 'package.json'), JSON.stringify({ name: '@acme/cold' }, null, 2));
fs.writeFileSync(path.join(coldRoot, 'src', 'unused.js'), 'export const unused = true;\n');

const client = { alias: 'client', path: clientRoot, context: {}, testCommands: {}, commands: {} };
const api = { alias: 'api', path: apiRoot, context: {}, testCommands: {}, commands: {} };
const config = {
  stateDir,
  workspaces: {
    client: { path: clientRoot, context: {} },
    api: { path: apiRoot, context: {} },
    cold: { path: coldRoot, context: {} }
  }
};

try {
  await repositoryIntelligence.ensure(api, config);
  await repositoryIntelligence.ensure(client, config);

  const coldGraph = repositoryIndexPath(config, { alias: 'cold', path: coldRoot });
  assert.equal(fs.existsSync(coldGraph), false);

  const clientDb = openIndexDatabase(repositoryIndexPath(config, client), { readonly: true });
  try {
    const budgeted = analyzeCrossWorkspace(client, config, clientDb, { maxHintsPerWorkspace: 50, maxRelationships: 50 });
    assert.ok(budgeted.relationships.some(item => item.type === 'CROSS_EMITS_TO' && item.key === 'event:account:saved'),
      'generic event noise must be filtered before the cross-workspace hint budget is applied');
  } finally {
    clientDb.close();
  }

  const result = await repositoryIntelligence.architecture(client, config, { maxResults: 50 });
  const cross = result.architecture.crossWorkspace;
  assert.equal(cross.strategy, 'separate-cached-workspace-graphs');
  assert.equal(cross.configuredPeerCount, 2);
  assert.equal(cross.indexedPeerCount, 1);
  assert.ok(cross.skipped.some(item => item.workspace === 'cold'));
  assert.equal(fs.existsSync(coldGraph), false, 'cross-workspace inspection must not index cold peer repositories');
  const genericEventKeys = new Set(genericEvents.map(name => `event:${name}`.toLowerCase()));
  assert.equal(cross.relationships.some(item => genericEventKeys.has(String(item.key || '').toLowerCase())), false,
    'generic Node/Electron/browser lifecycle events must not create cross-workspace relationships');

  const http = cross.relationships.find(item => item.type === 'CROSS_HTTP_CALLS');
  assert.ok(http);
  assert.equal(http.key, 'GET /api/accounts');
  assert.equal(http.from.workspace, 'client');
  assert.equal(http.from.path, 'src/client.js');
  assert.equal(http.to.workspace, 'api');
  assert.equal(http.to.path, 'src/routes.js');
  assert.equal(http.ambiguous, false);
  assert.equal(http.confidence, 0.97);

  const event = cross.relationships.find(item => item.type === 'CROSS_EMITS_TO');
  assert.ok(event);
  assert.equal(event.key, 'event:account:saved');
  assert.equal(event.to.workspace, 'api');
  assert.equal(event.to.path, 'src/events.js');

  const packageLink = cross.relationships.find(item => item.type === 'CROSS_PACKAGE_DEPENDS_ON');
  assert.ok(packageLink);
  assert.equal(packageLink.key, '@acme/api');
  assert.equal(packageLink.to.workspace, 'api');
  assert.equal(packageLink.confidence, 0.99);

  const cached = await repositoryIntelligence.cachedContext(client, config, { maxResults: 10 });
  assert.ok(cached.crossWorkspace.relationships.some(item => item.type === 'CROSS_HTTP_CALLS'));

  const architectureResult = await repositoryIntelligence.architecture(client, config, { maxResults: 50 });
  const architecturePeers = architectureResult.architecture.crossWorkspace.peers.map(item => item.workspace);
  assert.equal(architecturePeers.includes('client'), false, 'query-worker serialization must exclude the current workspace');
  assert.ok(architecturePeers.includes('api'));
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Cross-workspace HTTP, event, package, cache-only peer, and bootstrap context tests passed.');
