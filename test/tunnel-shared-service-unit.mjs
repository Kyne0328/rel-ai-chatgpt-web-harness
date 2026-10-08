// Isolated HTTP clients and filesystem/SQLite instrumentation need their own process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { startFallbackExecution, resetFallbackExecutions, fallbackExecutionStatus } from '../src/mcp/fallbackExecutions.js';
import { getTaskHistoryDir, writeSession } from '../src/taskHistoryStorage.ts';
import { createStdioPrincipal, principalFingerprint } from '../src/mcp/principal.ts';
import { normalizeTunnelLogRecord } from '../electron/tunnel-log-parser.js';
import { createTunnelRuntimePool } from '../electron/tunnel-runtime-pool.js';
import { startHttpTestServer, stopHttpTestServer, localHttpFetch } from './helpers/http-test-server.mjs';
import { createHttpMcpSession, mcpBody, mcpHeaders } from './helpers/http-mcp.mjs';

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
  const cleanupConfig = { stateDir: cleanupState };
  const noticeScope = principalFingerprint(createStdioPrincipal());
  const retainedOperations = [];
  const pointers = [];
  // A lookup pointer is retained only while its authoritative task still
  // retains that exact operation. Keep each task within the 100-result limit.
  for (let owner = 0; owner < 10; owner++) {
    const workId = `retained-owner-${owner}`;
    const operations = [];
    for (let index = 0; index < 100; index++) {
      const file = seed(`pointer${owner * 100 + index}`, { workId });
      const operationId = path.basename(file, '.json');
      const operation = { operationId, executionKey: workId, workId, noticeScope,
        workspace: 'fixture', tool: 'relai_read', signature: operationId,
        status: 'completed', revision: 1, startedAt: old.toISOString(),
        updatedAt: old.toISOString(), completedAt: old.toISOString(),
        result: { ok: true, marker: operationId } };
      operations.push(operation);
      retainedOperations.push(operation);
      pointers.push(file);
    }
    writeSession(getTaskHistoryDir(cleanupConfig), { id: workId, workspace: 'fixture',
      principalFingerprint: noticeScope, status: 'completed', events: [],
      backgroundOperations: operations, backgroundOperation: operations.at(-1) });
  }
  const orphaned = [
    seed('expired-task-pointer', { workId: 'expired-owner' }),
    seed('expired-operation-pointer', { workId: 'retained-owner-0' })
  ];
  const recentPointer = seed('recent-pointer', { workId: 'pending-owner' }, new Date());
  const expired = seed('expired', { status: 'completed' });
  const running = seed('running', { status: 'running' });
  const newest = seed('newest', { status: 'completed' }, new Date());
  for (let i = 0; i < 150; i++) seed(`terminal${i}`, { status: 'completed' }, new Date(Date.now() - 1000 - i));
  const prepare = DatabaseSync.prototype.prepare;
  const readdirSync = fs.readdirSync;
  const opendirSync = fs.opendirSync;
  const readdir = fs.promises.readdir;
  let historyQueries = 0;
  let synchronousScans = 0;
  let cleanupScans = 0;
  let legacyRecoveryScans = 0;
  DatabaseSync.prototype.prepare = function(sql, ...args) {
    if (/SELECT payload FROM task_history WHERE id=/.test(sql)) historyQueries++;
    return prepare.call(this, sql, ...args);
  };
  fs.readdirSync = function(root, ...args) {
    if (root === fallbackRoot) synchronousScans++;
    return readdirSync.call(this, root, ...args);
  };
  fs.opendirSync = function(root, ...args) {
    if (root === fallbackRoot) legacyRecoveryScans++;
    return opendirSync.call(this, root, ...args);
  };
  fs.promises.readdir = async function(root, ...args) {
    if (root === fallbackRoot) cleanupScans++;
    return readdir.call(this, root, ...args);
  };
  syncBuiltinESMExports();
  try {
    const start = performance.now();
    const startWithRecovery = async scope => {
      const deadline = Date.now() + 15000;
      for (;;) {
        try {
          return startFallbackExecution({
            config: cleanupConfig, scopeId: `workspace:${scope}`, tool: 'relai_exec',
            signature: scope, run: async () => ({ content: [], structuredContent: { ok: true } })
          });
        } catch (error) {
          if (error?.code !== 'FALLBACK_RECOVERY_UNAVAILABLE' || Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    };
    const executions = await Promise.all(['a', 'b'].map(startWithRecovery));
    let yielded = false;
    await new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
    assert.ok(yielded, 'cleanup must yield to the service event loop');
    await Promise.all(executions.map(item => item.record.promise));
    const deadline = Date.now() + 15_000;
    while ((fs.existsSync(expired) || orphaned.some(file => fs.existsSync(file))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(expired), false, 'expired taskless results must still be pruned');
    assert.ok(pointers.every(file => fs.existsSync(file)), 'pointers to retained canonical operations must survive cleanup');
    assert.ok(orphaned.every(file => !fs.existsSync(file)), 'expired task and expired operation pointers must be retired');
    assert.ok(fs.existsSync(recentPointer), 'new pointers retain their recovery grace period');
    assert.ok(fs.existsSync(running), 'running operations must survive cleanup');
    assert.ok(fs.existsSync(newest), 'newest terminal operation must survive cleanup');
    assert.equal(synchronousScans, 0, 'request persistence must not synchronously scan cleanup files');
    assert.ok(historyQueries <= 2, 'cleanup must not hydrate any pointer task history');
    assert.equal(cleanupScans, 1, 'overlapping clients and completion writes must coalesce cleanup');
    assert.ok(legacyRecoveryScans <= executions.length, 'legacy signature recovery is separate from cleanup and scans at most once per initial scope');
    // Check retrieval after the cleanup instrumentation assertion: this
    // deliberate read is allowed to hydrate its exact authoritative task.
    for (const operation of [retainedOperations[0], retainedOperations[499], retainedOperations.at(-1)]) {
      const recovered = fallbackExecutionStatus(operation.operationId, { config: cleanupConfig,
        noticeScope, workspace: 'fixture', workId: operation.workId });
      assert.equal(recovered?.operationId, operation.operationId);
      assert.equal(recovered?.result?.marker, operation.operationId);
    }
    console.log(`Fallback cleanup with 1,000 lookup pointers passed (${Math.round(performance.now() - start)} ms).`);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    fs.readdirSync = readdirSync;
    fs.opendirSync = opendirSync;
    fs.promises.readdir = readdir;
    syncBuiltinESMExports();
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
  const tool = async (name, args) => {
    const reply = await clients[0].request('tools/call', { name, arguments: args });
    assert.equal(reply.response.status, 200);
    assert.equal(reply.body.result.isError, false, JSON.stringify(reply.body));
    return reply.body.result.structuredContent;
  };
  const task = await tool('relai_work', { action: 'begin', workspace: 'fixture', title: 'HTTP result wait', objective: 'Verify result delivery without restarting commands.',
    steps: [{ id: 'verify', title: 'Verify HTTP result retrieval', status: 'in_progress' }] });
  const taskArgs = { workspace: 'fixture', work_id: task.work_id };
  const receipt = await tool('relai_exec', { ...taskArgs, executable: process.execPath,
    argv: ['-e', 'setTimeout(() => process.stdout.write("original-command-result\\n"), 2000)'], maxOutputBytes: 1024 });
  assert.equal(receipt.status, 'running');
  const resultArgs = { ...taskArgs, operationId: receipt.operationId };
  const immediate = await tool('relai_work', { ...resultArgs, action: 'result', waitMs: 0 });
  assert.equal(immediate.backgroundOperation.status, 'running');
  const completed = await tool('relai_work', { ...resultArgs, action: 'result' });
  assert.equal(completed.backgroundOperation.status, 'completed', 'default HTTP result lookup waits for the original execution');
  assert.equal(completed.backgroundOperation.result.exitCode, 0);
  assert.equal(completed.backgroundOperation.result.stdout, 'original-command-result\n');
  assert.equal(completed.backgroundOperation.operationId, receipt.operationId);
  const replay = await tool('relai_work', { ...resultArgs, action: 'result', waitMs: 0 });
  assert.equal(replay.backgroundOperation.result.stdout, completed.backgroundOperation.result.stdout);

  const second = await tool('relai_exec', { ...taskArgs, executable: process.execPath,
    argv: ['-e', 'setTimeout(() => process.stdout.write("survived-disconnect\\n"), 2000)'], maxOutputBytes: 1024 });
  assert.equal(second.status, 'running');
  const abort = new AbortController();
  const disconnected = fetch(`${server.base}/mcp`, {
    method: 'POST', signal: abort.signal, headers: mcpHeaders('tools/call', { token, name: 'relai_work' }),
    body: mcpBody('disconnect-result', 'tools/call', { name: 'relai_work', arguments: { ...taskArgs, action: 'result', operationId: second.operationId } })
  });
  const abortTimer = setTimeout(() => abort.abort(), 50);
  try { await assert.rejects(disconnected, error => error.name === 'AbortError'); } finally { clearTimeout(abortTimer); }
  const survived = await tool('relai_work', { ...taskArgs, action: 'result', operationId: second.operationId });
  assert.equal(survived.backgroundOperation.status, 'completed', 'HTTP retrieval disconnect must leave the existing execution running');
  assert.equal(survived.backgroundOperation.result.stdout, 'survived-disconnect\n');
  await tool('relai_work', { ...taskArgs, action: 'plan', steps: [{ id: 'verify', title: 'Verify HTTP result retrieval', status: 'completed' }] });
  await tool('relai_work', { ...taskArgs, action: 'finish', summary: 'HTTP result waits, immediate lookup, replay and disconnected retrieval passed.' });
  console.log('HTTP result waits returned terminal results and preserved background work across retrieval disconnects.');
} finally {
  await stopHttpTestServer(child);
  // Cleanup uses async filesystem operations; allow in-flight reads to finish before removing the fixture.
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.rmSync(temp, { recursive: true, force: true });
}
