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
import { tunnelLocalToken } from '../src/mcp/tunnelIdentity.js';
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

  // Real HTTP requests prove tunnel identity survives the canonical MCP
  // dispatcher and guards task/goal ownership, including forged metadata.
  const scopedConfig = path.join(temp, 'scoped-tunnels.json');
  const scopedWorkspace = path.join(temp, 'scoped-workspace');
  fs.mkdirSync(scopedWorkspace);
  fs.writeFileSync(scopedConfig, JSON.stringify({ version: 3, stateDir: path.join(temp, 'scoped-state'), workspaces: { scoped: { path: scopedWorkspace } } }));
  const previousEnvironment = { config: process.env.REL_AI_MCP_CONFIG, state: process.env.REL_AI_MCP_STATE_DIR,
    bearer: process.env.REL_AI_CHATGPT_WEB_BEARER, cookie: process.env.REL_AI_CHATGPT_WEB_COOKIE };
  process.env.REL_AI_MCP_CONFIG = scopedConfig;
  process.env.REL_AI_MCP_STATE_DIR = path.join(temp, 'scoped-state');
  process.env.REL_AI_CHATGPT_WEB_BEARER = '';
  process.env.REL_AI_CHATGPT_WEB_COOKIE = '';
  const tunnelA = 'tunnel_accountA12345';
  const tunnelB = 'tunnel_accountB12345';
  let configured = [tunnelA, tunnelB];
  const { startHttpServer } = await import('../src/httpServer.ts');
  const scopedServer = startHttpServer({ host: '127.0.0.1', port: 0, token: 'scoped-fixture-master',
    isolated: true, writeProfile: false, getTunnelIds: () => configured });
  try {
    if (!scopedServer.listening) await new Promise(resolve => scopedServer.once('listening', resolve));
    const scopedBase = `http://127.0.0.1:${scopedServer.address().port}`;
    const tokenA = tunnelLocalToken('scoped-fixture-master', tunnelA);
    const tokenB = tunnelLocalToken('scoped-fixture-master', tunnelB);
    assert.notEqual(tokenA, tokenB);
    const admittedGet = await localHttpFetch(scopedBase + '/mcp', { headers: { authorization: 'Bearer ' + tokenA } });
    assert.equal(admittedGet.status, 405, 'authenticated stateless GET must reach the method guard');
    assert.equal(admittedGet.headers.get('allow'), 'POST');
    assert.equal((await admittedGet.json()).error.code, -32600);
    const rejectedGet = await localHttpFetch(scopedBase + '/mcp', { headers: { authorization: 'Bearer invalid-fixture-token' } });
    assert.equal(rejectedGet.status, 401, 'the read-only admission probe must still reject invalid bearer credentials');
    const clientA = await createHttpMcpSession(scopedBase, { token: tokenA });
    const clientB = await createHttpMcpSession(scopedBase, { token: tokenB });
    const created = await clientA.request('tools/call', { name: 'relai_work', arguments: { mode: 'goal',
      action: 'begin', title: 'Account A goal', objective: 'Prove tunnel ownership', goal: true,
      conversationUrl: 'https://chatgpt.com/c/b5b9731a-8496-4a92-9b44-55d080038c7d'
    } });
    const scopedWorkId = created.body.result.structuredContent.work_id;
    assert.ok(scopedWorkId);
    const ownGoal = await clientA.request('tools/call', { name: 'relai_work', arguments: { action: 'goal_status', work_id: scopedWorkId } });
    assert.equal(ownGoal.body.result.structuredContent.tunnelId, tunnelA);
    const otherGoal = await clientB.request('tools/call', { name: 'relai_work', arguments: { action: 'goal_stop', work_id: scopedWorkId },
      _meta: { tunnelId: tunnelA, clientId: 'secure-tunnel:' + tunnelA } }, { extraHeaders: { 'x-relai-tunnel-id': tunnelA } });
    assert.equal(otherGoal.body.result.isError, true, 'a different tunnel cannot adopt a goal by forging its ID');
    assert.equal((await clientA.request('tools/call', { name: 'relai_work', arguments: { action: 'goal_status', work_id: scopedWorkId } }))
      .body.result.structuredContent.goalActive, true);
    const scopedTool = async (client, name, args) => {
      const reply = await client.request('tools/call', { name, arguments: args });
      assert.equal(reply.response.status, 200);
      const value = reply.body.result.structuredContent;
      if (value.status !== 'running' || !value.operationId) return value;
      for (let attempt = 0; attempt < 6; attempt++) {
        const receipt = await client.request('tools/call', { name: 'relai_work', arguments: {
          action: 'result', workspace: args.workspace, work_id: args.work_id, operationId: value.operationId
        } });
        const operation = receipt.body.result.structuredContent.backgroundOperation;
        if (operation?.status === 'running') continue;
        assert.ok(operation?.result, JSON.stringify(receipt.body));
        return operation.result;
      }
      assert.fail('scoped staging operation did not settle');
    };
    const ownerA = await scopedTool(clientA, 'relai_work', { mode: 'normal', action: 'begin', workspace: 'scoped', title: 'Staging owner A' });
    const ownerB = await scopedTool(clientB, 'relai_work', { mode: 'normal', action: 'begin', workspace: 'scoped', title: 'Staging owner B' });
    for (const kind of ['content', 'updateText']) {
      const startArgs = kind === 'content' ? { path: 'scoped.txt', content: 'A\n' }
        : { updateText: '*** Begin Patch\n*** Add File: scoped-patch.txt\n+A\n*** End Patch' };
      const staged = await scopedTool(clientA, 'relai_edit', { workspace: 'scoped', work_id: ownerA.work_id, stage: 'start', ...startArgs });
      assert.equal(staged.ok, true);
      for (const stage of ['append', 'commit', 'abort']) {
        const rejected = await scopedTool(clientB, 'relai_edit', { workspace: 'scoped', work_id: ownerB.work_id,
          stage, writeId: staged.writeId, ...(stage === 'append' ? { [kind]: 'B\n' } : {}) });
        assert.equal(rejected.ok, false, 'another tunnel must not ' + stage + ' a staged ' + kind + ' payload');
      }
      const noFallback = await scopedTool(clientB, 'relai_edit', { workspace: 'scoped', work_id: ownerB.work_id,
        stage: 'append', [kind]: 'B\n' });
      assert.equal(noFallback.ok, false, 'fallback must not disclose or select another tunnel payload');
      assert.ok(!JSON.stringify(noFallback).includes(staged.writeId), 'foreign staged IDs must not enter fallback diagnostics');
      const committed = await scopedTool(clientA, 'relai_edit', { workspace: 'scoped', work_id: ownerA.work_id, stage: 'commit' });
      assert.equal(committed.ok, true, JSON.stringify(committed));
      assert.equal(fs.readFileSync(path.join(scopedWorkspace, kind === 'content' ? 'scoped.txt' : 'scoped-patch.txt'), 'utf8'), 'A\n');
    }
    configured = [tunnelA];
    const removed = await clientB.request('tools/list');
    assert.equal(removed.response.status, 401, 'removed or disabled tunnels immediately lose authentication');
    await clientA.request('tools/call', { name: 'relai_work', arguments: { action: 'goal_stop', work_id: scopedWorkId } });
    console.log('Scoped tunnel authentication keeps Account A goals inaccessible to Account B.');
  } finally {
    scopedServer.closeAllConnections();
    await new Promise(resolve => scopedServer.close(resolve));
    await scopedServer.waitForShutdown();
    for (const [name, value] of Object.entries({ REL_AI_MCP_CONFIG: previousEnvironment.config,
      REL_AI_MCP_STATE_DIR: previousEnvironment.state, REL_AI_CHATGPT_WEB_BEARER: previousEnvironment.bearer,
      REL_AI_CHATGPT_WEB_COOKIE: previousEnvironment.cookie })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }

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
  const task = await tool('relai_work', { mode: 'normal', action: 'begin', workspace: 'fixture', title: 'HTTP result wait', objective: 'Verify result delivery without restarting commands.',
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
  // A connector result read waits at most five seconds; it may legitimately
  // return running while native startup/execution is still settling. Keep
  // retrieving this same operation, without resubmitting its command.
  const settlementDeadline = Date.now() + 30000;
  let survived;
  do {
    survived = await tool('relai_work', { ...taskArgs, action: 'result', operationId: second.operationId });
    assert.equal(survived.backgroundOperation.operationId, second.operationId);
  } while (survived.backgroundOperation.status === 'running' && Date.now() < settlementDeadline);
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
