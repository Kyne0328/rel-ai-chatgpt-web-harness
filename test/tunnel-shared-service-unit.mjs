// Isolated HTTP clients and filesystem/SQLite instrumentation need their own process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFallbackExecution, resetFallbackExecutions } from '../src/mcp/fallbackExecutions.js';
import { normalizeTunnelLogRecord } from '../electron/tunnel-log-parser.js';
import { createTunnelRuntimePool } from '../electron/tunnel-runtime-pool.js';
import { startHttpTestServer, stopHttpTestServer, localHttpFetch } from './helpers/http-test-server.mjs';
import { createHttpMcpSession } from './helpers/http-mcp.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-shared-tunnel-'));
let child;
try {
  const cleanupState = path.join(temp, 'cleanup');
  const fallbackRoot = path.join(cleanupState, 'fallback-executions');
  fs.mkdirSync(fallbackRoot, { recursive: true });
  const old = new Date(Date.now() - 20 * 60_000);
  function seed(id, data, stamp = old) {
    const operationId = `fallback_${id.padStart(24, '0')}`;
    const file = path.join(fallbackRoot, `${operationId}.json`);
    fs.writeFileSync(file, JSON.stringify({ operationId, ...data }));
    fs.utimesSync(file, stamp, stamp);
    return file;
  }
  const pointers = Array.from({ length: 1000 }, (_, i) => seed(`pointer${i}`, { workId: 'retained-owner' }));
  const expired = seed('expired', { status: 'completed' });
  const running = seed('running', { status: 'running' });
  const newest = seed('newest', { status: 'completed' }, new Date());
  for (let i = 0; i < 150; i++) seed(`terminal${i}`, { status: 'completed' }, new Date(Date.now() - 1000 - i));
  const prepare = DatabaseSync.prototype.prepare;
  const readdirSync = fs.readdirSync;
  const readdir = fs.promises.readdir;
  let historyQueries = 0;
  let synchronousScans = 0;
  let cleanupScans = 0;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (/SELECT payload FROM task_history WHERE id=/.test(sql)) historyQueries++;
    return prepare.call(this, sql, ...args);
  };
  fs.readdirSync = function(root, ...args) {
    if (root === fallbackRoot) synchronousScans++;
    return readdirSync.call(this, root, ...args);
  };
  fs.promises.readdir = async function(root, ...args) {
    if (root === fallbackRoot) cleanupScans++;
    return readdir.call(this, root, ...args);
  };
  try {
    const start = performance.now();
    const executions = ['a', 'b'].map(scope => startFallbackExecution({
      config: { stateDir: cleanupState }, scopeId: `workspace:${scope}`, tool: 'relai_exec',
      signature: scope, run: async () => ({ content: [], structuredContent: { ok: true } })
    }));
    let yielded = false;
    await new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
    assert.ok(yielded, 'cleanup must yield to the service event loop');
    await Promise.all(executions.map(item => item.record.promise));
    const deadline = Date.now() + 15_000;
    while (fs.existsSync(expired) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(expired), false, 'expired taskless results must still be pruned');
    assert.ok(pointers.every(file => fs.existsSync(file)), 'work-bound operation lookup pointers must survive cleanup');
    assert.ok(fs.existsSync(running), 'running operations must survive cleanup');
    assert.ok(fs.existsSync(newest), 'newest terminal operation must survive cleanup');
    assert.equal(synchronousScans, 0, 'request persistence must not synchronously scan cleanup files');
    assert.ok(historyQueries <= 2, 'cleanup must not hydrate any pointer task history');
    assert.equal(cleanupScans, 1, 'overlapping clients and completion writes must coalesce cleanup');
    console.log(`Fallback cleanup with 1,000 lookup pointers passed (${Math.round(performance.now() - start)} ms).`);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    fs.readdirSync = readdirSync;
    fs.promises.readdir = readdir;
    resetFallbackExecutions();
  }

  const event = {
    component: 'dispatcher', msg: 'dispatcher received MCP upstream error; posted error response to control plane',
    status_code: 502, rpc_method: 'tools/call', failure_source: 'protocol', transport_error_kind: 'malformed_json',
    upstream_response_received: false, tunnel_client_version: '0.0.15'
  };
  const parsed = normalizeTunnelLogRecord(JSON.stringify(event));
  assert.equal(parsed.details.method, 'tools/call');
  assert.equal(parsed.details.upstreamResponseReceived, false);
  assert.equal(parsed.details.transportErrorKind, 'malformed_json');
  assert.match(parsed.message, /could not complete.*protocol: malformed_json/);
  assert.equal(normalizeTunnelLogRecord(JSON.stringify({ ...event, status_code: 401 })).code, 'tunnel_mcp_request_failed',
    'a local MCP 401 must not stop the tunnel as an OpenAI API-key failure');
  assert.equal(normalizeTunnelLogRecord(JSON.stringify({ component: 'controlplane', msg: 'poll timed out; backing off' })).code,
    'tunnel_connection_interrupted');
  assert.match(normalizeTunnelLogRecord(JSON.stringify({ ...event, failure_source: 'target_http', upstream_response_received: true })).message,
    /local MCP server returned HTTP 502/);

  const starts = [];
  const pool = createTunnelRuntimePool({ createRuntime: options => {
    let state = { state: 'stopped' };
    return {
      async start(config) { starts.push(config); state = { state: 'running', tunnelId: config.tunnelId }; options.onStatus(state); return state; },
      async stop() { return { stopped: true, exited: true }; }, snapshot() { return state; }
    };
  } });
  await pool.sync({ connections: [
    { tunnelId: 'tunnel_duplicate123', apiKey: 'first', label: 'First' },
    { tunnelId: 'tunnel_duplicate123', apiKey: 'last', label: 'Last' }
  ], port: 3333, localToken: 'test' });
  assert.equal(starts.length, 1, 'duplicate tunnel entries must not spawn competing clients');
  assert.equal(starts[0].apiKey, 'last');
  await pool.stop();

  const workspace = path.join(temp, 'workspace');
  fs.mkdirSync(workspace);
  for (const label of ['a', 'b']) {
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(workspace, `${label}-${i}.txt`), `client-${label}-${i}\n`);
  }
  const stateDir = path.join(temp, 'http-state');
  const configPath = path.join(temp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl'),
    workspaces: { fixture: { path: workspace, commands: {}, testCommands: {} } } }));
  const token = 'shared-service-test-token';
  const server = await startHttpTestServer({ root: path.resolve(import.meta.dirname, '..'), configPath, stateDir, token });
  child = server.child;
  const clients = await Promise.all(['a', 'b'].map(clientName => createHttpMcpSession(server.base, { token, clientName })));
  await clients[0].request('tools/call', { name: 'relai_read', arguments: {
    workspace: 'fixture', paths: ['a-0.txt'], guidanceMode: 'none'
  } });
  const responses = await Promise.all(clients.flatMap((client, index) => Array.from({ length: 20 }, async (_, requestIndex) => {
    const label = index === 0 ? 'a' : 'b';
    const result = await client.request('tools/call', { name: 'relai_read', arguments: {
      workspace: 'fixture', paths: [`${label}-${requestIndex}.txt`], guidanceMode: 'none'
    } }, { id: 0 });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.id, 0);
    assert.equal(result.body.result.isError, false);
    assert.ok(Array.isArray(result.body.result.structuredContent.items), JSON.stringify(result.body.result.structuredContent));
    assert.equal(result.body.result.structuredContent.items[0].content, `client-${label}-${requestIndex}\n`);
    return result;
  })));
  assert.equal(responses.length, 40);
  const health = await localHttpFetch(`${server.base}/health`);
  assert.equal(health.status, 200);
  console.log('Two clients sharing one MCP service passed 40 concurrent reads with overlapping JSON-RPC IDs.');
} finally {
  await stopHttpTestServer(child);
  // Cleanup uses async filesystem operations; allow in-flight reads to finish before removing the fixture.
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.rmSync(temp, { recursive: true, force: true });
}
