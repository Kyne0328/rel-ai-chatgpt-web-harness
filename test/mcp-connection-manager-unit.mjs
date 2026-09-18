import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpConnectionManager } from '../src/mcp/connectionManager.js';
import { buildToolManifest } from '../src/mcp/toolManifest.js';
import { resolveConnectionGenerations } from '../src/mcp/connectionGenerations.js';
import { runtimeMetadata } from '../src/runtimeCompatibility.js';

const neutralManifest = buildToolManifest({});
assert.equal(neutralManifest.schemaVersion, runtimeMetadata().schemaVersion, 'public MCP manifest and runtime compatibility metadata must use the same schema revision');
assert.ok(String(neutralManifest.instructions || '').trim(), 'public MCP instructions must not be empty');
for (const invariant of [/approval/i, /task-ownership|ownership/i, /authoritative evidence/i, /validation/i]) {
  assert.match(neutralManifest.instructions, invariant, `public MCP instructions must retain the ${invariant} safety invariant`);
}
assert.ok(neutralManifest.tools.every(tool => tool.outputSchema), 'every canonical tool must include its output schema');
assert.equal(neutralManifest.version, neutralManifest.hash.slice(0, 24), 'short manifest version must derive from the full digest');
assert.equal(neutralManifest.version, buildToolManifest({}).version, 'neutral manifest must be deterministic');
assert.equal(
  neutralManifest.version,
  buildToolManifest({ workspaces: { repo: { path: process.cwd() } } }).version,
  'workspace aliases must not churn the stable tool manifest'
);
assert.equal(runtimeMetadata().manifestHash, neutralManifest.version, 'release compatibility must use the configuration-neutral manifest');

const generationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-connection-generations-'));
const generationFile = path.join(generationRoot, 'generations.json');
try {
  const first = resolveConnectionGenerations({}, {
    file: generationFile,
    key: Buffer.from('unit-test-key'),
    token: 'token-a',
    host: '127.0.0.1',
    port: 3333
  });
  const stable = resolveConnectionGenerations({}, {
    file: generationFile,
    key: Buffer.from('unit-test-key'),
    token: 'token-a',
    host: '127.0.0.1',
    port: 3333
  });
  const rotated = resolveConnectionGenerations({}, {
    file: generationFile,
    key: Buffer.from('unit-test-key'),
    token: 'token-b',
    host: '127.0.0.1',
    port: 3333
  });
  const reconfigured = resolveConnectionGenerations({}, {
    file: generationFile,
    key: Buffer.from('unit-test-key'),
    token: 'token-b',
    host: '127.0.0.1',
    port: 4444
  });
  assert.deepEqual(stable, first);
  assert.equal(rotated.credentialGeneration, first.credentialGeneration + 1);
  assert.equal(rotated.configurationGeneration, first.configurationGeneration);
  assert.equal(reconfigured.configurationGeneration, rotated.configurationGeneration + 1);
  assert.doesNotMatch(fs.readFileSync(generationFile, 'utf8'), /token-a|token-b/);
} finally {
  fs.rmSync(generationRoot, { recursive: true, force: true });
}

let now = 1_000;
const quietManager = new McpConnectionManager({ clock: () => now, recentActivityMs: 60_000 });
quietManager.configure({ serverInstanceId: 'quiet', credentialGeneration: 1, configurationGeneration: 1, manifest: neutralManifest });
let quietSnapshots = 0;
const quietSnapshot = quietManager.snapshot.bind(quietManager);
quietManager.snapshot = () => { quietSnapshots += 1; return quietSnapshot(); };
quietManager.markReady();
assert.equal(quietSnapshots, 0, 'connection events must not build dashboard snapshots when no change listener is attached');
await quietManager.shutdown('unit_shutdown');

const manager = new McpConnectionManager({ clock: () => now, recentActivityMs: 60_000 });
let changes = 0;
const unsubscribe = manager.onChange(() => { changes += 1; });
manager.configure({
  serverInstanceId: 'server-a',
  credentialGeneration: 1,
  configurationGeneration: 1,
  manifest: neutralManifest
});
assert.equal(manager.snapshot().status, 'starting');
manager.markReady();
assert.equal(manager.snapshot().status, 'ready');
assert.equal(manager.snapshot().activityStatus, 'no_requests');
assert.equal(manager.snapshot().requestModel, 'stateless');
assert.equal(Object.hasOwn(manager.snapshot(), 'connectedClientCount'), false);
assert.equal(Object.hasOwn(manager.snapshot(), 'activeSessions'), false);

now += 100;
const requestId = manager.beginRequest({
  principal: 'sensitive-principal',
  method: 'server/discover',
  authMode: 'static_bearer',
  clientInfo: { name: 'test-client', version: '1.0.0' },
  clientCapabilities: {
    extensions: {
      'io.modelcontextprotocol/tasks': { secret: 'must-not-be-retained' }
    }
  }
});
assert.equal(manager.snapshot().activityStatus, 'active');
assert.equal(manager.snapshot().activeRequestCount, 1);
assert.equal(manager.snapshot().lastAuthMode, 'static_bearer');
manager.finishRequest(requestId, { method: 'server/discover', ok: true });
const afterRequest = manager.snapshot();
assert.equal(afterRequest.activityStatus, 'recent');
assert.equal(afterRequest.activeRequestCount, 0);
assert.equal(afterRequest.metrics.requestsReceived, 1);
assert.equal(afterRequest.metrics.requestsSucceeded, 1);
assert.equal(afterRequest.metrics.discoveryRequests, 1);
assert.ok(afterRequest.lastAuthenticatedAt);
assert.ok(afterRequest.lastSuccessfulRequestAt);
assert.notEqual(afterRequest.lastPrincipal, 'sensitive-principal');
assert.equal(JSON.stringify(afterRequest).includes('must-not-be-retained'), false);
assert.equal(JSON.stringify(afterRequest).includes('sensitive-principal'), false);

manager.finishRequest(requestId, { method: 'server/discover', ok: true });
assert.equal(manager.snapshot().metrics.requestsSucceeded, 1, 'duplicate completion must not double-count a request');

now += 60_001;
assert.equal(manager.snapshot().activityStatus, 'idle');

const failedId = manager.beginRequest({ principal: 'local-bearer-client', method: 'tools/call', authMode: 'static_bearer' });
assert.equal(manager.snapshot().activityStatus, 'active');
manager.finishRequest(failedId, { ok: false });
assert.equal(manager.snapshot().activityStatus, 'request_failed');
assert.equal(manager.snapshot().metrics.requestsFailed, 1);
assert.equal(manager.snapshot().lastAuthMode, 'static_bearer');

now += 100;
const recoveredId = manager.beginRequest({ principal: 'local-bearer-client', method: 'tools/list', authMode: 'static_bearer' });
manager.finishRequest(recoveredId, { ok: true });
const recoveredSnapshot = manager.snapshot();
assert.equal(recoveredSnapshot.status, 'ready', 'one failed request must not mark the stateless MCP server failed');
assert.equal(recoveredSnapshot.activityStatus, 'recent');
assert.equal(recoveredSnapshot.metrics.requestRecoveries, 1);
assert.ok(recoveredSnapshot.lastRecoveredRequestAt);
assert.equal(recoveredSnapshot.recentEvents.at(-1)?.type, 'mcp_request_recovered');

const changedManifest = { ...neutralManifest, version: 'changed-manifest', hash: 'changed-manifest-hash' };
assert.equal(await manager.observeManifest(changedManifest, 'tools/call'), true);
assert.equal(manager.snapshot().status, 'ready');
assert.equal(manager.snapshot().toolManifestVersion, changedManifest.version, 'The local MCP runtime must continue sourcing schema state from its observed manifest.');
assert.equal(manager.snapshot().metrics.toolManifestChanges, 1);
assert.equal(await manager.observeManifest(changedManifest, 'tools/list'), false);

await manager.invalidateCredentials(2);
assert.equal(manager.snapshot().credentialGeneration, 2);
assert.equal(manager.snapshot().status, 'ready', 'credential rotation must not create or close nonexistent sessions');
assert.equal(manager.snapshot().activityStatus, 'no_requests');
assert.equal(manager.snapshot().lastAuthMode, '');
assert.equal(Object.hasOwn(manager.snapshot(), 'manualRecoveryRequired'), false);

manager.noteAuthenticationFailure('invalid_token');
assert.ok(manager.snapshot().lastAuthenticationFailureAt);
assert.equal(manager.snapshot().recentEvents.at(-1)?.type, 'authentication_failed');
assert.equal(typeof manager.retryConnection, 'undefined');
assert.equal(Object.hasOwn(manager.snapshot().metrics, 'manualRecoveryRequests'), false);

manager.markFailed(new Error('listen failed'));
assert.equal(manager.snapshot().status, 'failed');
assert.equal(manager.snapshot().activityStatus, 'failed');
await manager.shutdown('unit_shutdown');
assert.equal(manager.snapshot().status, 'stopped');
assert.equal(manager.snapshot().activityStatus, 'stopped');
assert.equal(manager.snapshot().lastDisconnectReason, 'unit_shutdown');
assert.ok(changes > 0);
unsubscribe();

console.log('MCP stateless authentication and request-activity observability tests passed.');
