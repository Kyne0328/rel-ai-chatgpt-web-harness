import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';

// The parent owns cleanup after the fixture process exits. Windows can retain
// workspace directory handles until all service workers in that process exit.
const childFixture = process.env.RELAI_RESULT_RECOVERY_CHILD === '1';
const root = childFixture ? process.env.RELAI_RESULT_RECOVERY_ROOT
  : fs.mkdtempSync(path.join(os.tmpdir(), 'relai-result-recovery-'));
if (!childFixture) {
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      env: { ...process.env, RELAI_RESULT_RECOVERY_CHILD: '1', RELAI_RESULT_RECOVERY_ROOT: root },
      encoding: 'utf8', timeout: 30000, maxBuffer: 300000
    });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.equal(child.status, 0, child.error?.message || 'result-recovery fixture process failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  process.exit(0);
}
delete process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_CONFIG = path.join(root, 'config.json');
const config = { stateDir: path.join(root, 'state'), workspaces: { app: { path: root } }, telemetry: { enabled: false, diagnosticsEnabled: false } };
fs.writeFileSync(process.env.REL_AI_MCP_CONFIG, JSON.stringify(config));
fs.writeFileSync(path.join(root, 'fixture.txt'), 'result recovery fixture');
const fallback = await import('../src/mcp/fallbackExecutions.js');
const { handleTransportFallbackRequest } = await import('../src/mcp/transportFallback.ts');
const { createStdioPrincipal, principalFingerprint } = await import('../src/mcp/principal.ts');
const { MCP_PROTOCOL_VERSION } = await import('../src/mcp/protocol.js');
const { toolResult } = await import('../src/mcp/results.js');
const { relaiStatus } = await import('../src/tools/status.js');
const { enrichWithFallbackCompletions, registerReturnedFallbackCompletions } = await import('../src/mcp/toolInvocation.js');
const history = await import('../src/taskHistoryStorage.ts');
const { openStateDatabase } = await import('../src/stateDatabase.ts');
const { getPublicToolSchemas } = await import('../src/tools/schema.js');
const principal = createStdioPrincipal();
const scope = principalFingerprint(principal);
const meta = { [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} };
const make = (id, args, name = 'relai_read') => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const cases = [];
let db;
const options = { principal, transportType: 'streamable-http' };
function result(value = {}) { return toolResult({ ok: true, workspace: 'app', ...value }, false); }
function start(overrides = {}) {
  return fallback.startFallbackExecution({ config, scopeId: 'fixture', noticeScope: scope, workspace: 'app',
    tool: 'relai_read', signature: 'fixture', run: async () => result(), ...overrides });
}
try {

  // The actual task-history worker holds a queued write behind an isolated
  // SQLite lock. Admission must wait without scheduling the handler.
  const { recordTaskActivityEvent, flushTaskHistoryPersistence, withTaskHistoryPersistenceBarrier, clearTaskHistory } = await import('../src/taskHistoryStore.ts');
  const barrierConfig = { ...config, stateDir: path.join(root, 'pending-admission') };
  const barrierId = 'pending-admission-task';
  const barrierDirectory = history.getTaskHistoryDir(barrierConfig);
  history.writeSession(barrierDirectory, { id: barrierId, status: 'planning',
    workspace: 'app', principalFingerprint: scope, events: [] });
  const barrierDb = openStateDatabase(barrierConfig);
  let flush;
  try {
    barrierDb.exec('BEGIN IMMEDIATE');
    recordTaskActivityEvent(barrierConfig, { task: { id: barrierId, taskId: barrierId,
      workspace: 'app', status: 'planning', title: 'queued snapshot', startedAt: new Date().toISOString() } }, { defer: true });
    flush = flushTaskHistoryPersistence();
    await tick();
    let runs = 0;
    let responseReady = false;
    const executeToolResult = async (_config, _name, _args, execution) => { runs++; return result({ work_id: barrierId, operationId: execution.fallbackOperationId, marker: 'durably admitted once' }); };
    const args = { workspace: 'app', work_id: barrierId, command: 'fixture harmless counter' };
    const pending = handleTransportFallbackRequest(barrierConfig, make('worker-admission', args, 'relai_exec'),
      { ...options, synchronousFallbackGraceMs: 0, executeToolResult });
    pending.then(() => { responseReady = true; });
    const duplicate = handleTransportFallbackRequest(barrierConfig, make('worker-admission-retry', args, 'relai_exec'),
      { ...options, synchronousFallbackGraceMs: 0, executeToolResult });
    const abort = new AbortController();
    const cancelled = handleTransportFallbackRequest(barrierConfig,
      make('cancel-worker-admission', { ...args, command: 'fixture cancelled counter' }, 'relai_exec'),
      { ...options, signal: abort.signal, synchronousFallbackGraceMs: 0, executeToolResult });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(responseReady, false, 'a queued worker snapshot must not become failed or accepted before its write settles');
    assert.equal(runs, 0, 'the handler cannot run before durable admission');
    abort.abort(new Error('cancel pending admission'));
    const cancelledResponse = (await cancelled).body.result.structuredContent;
    assert.equal(cancelledResponse.errorCode, 'CANCELLED');
    assert.equal(cancelledResponse.executed, false);
    assert.equal(cancelledResponse.accepted, false);
    assert.equal(runs, 0);
    await assert.rejects(withTaskHistoryPersistenceBarrier(barrierConfig, barrierId, () => { runs++; },
      { deadlineAtMs: Date.now() + 20 }), error => error.code === 'TIMEOUT' && error.executed === false);
    assert.equal(runs, 0, 'an expired admission deadline cannot start the handler');
    const inherited = await handleTransportFallbackRequest(barrierConfig,
      make('inherited-deadline-admission', { ...args, command: 'inherited deadline counter', timeoutMs: 60000 }, 'relai_exec'),
      { ...options, deadlineAtMs: Date.now() + 20, synchronousFallback: false, synchronousFallbackGraceMs: 0, executeToolResult });
    assert.equal(inherited.body.result.structuredContent.errorCode, 'TIMEOUT');
    assert.equal(inherited.body.result.structuredContent.executed, false);
    assert.equal(inherited.body.result.structuredContent.accepted, false);
    assert.equal(runs, 0, 'the inherited deadline must win over a longer explicit tool timeout');
    assert.equal(await withTaskHistoryPersistenceBarrier({ stateDir: path.join(root, 'independent-admission') },
      'independent-task', () => 'independent'), 'independent', 'admission must not flush unrelated histories');
    barrierDb.exec('ROLLBACK');
    const [accepted, replayed] = await Promise.all([pending, duplicate]);
    assert.equal(accepted.body.result.structuredContent.ok, true);
    assert.equal(replayed.body.result.structuredContent.ok, true);
    const operationId = accepted.body.result.structuredContent.operationId;
    assert.equal(replayed.body.result.structuredContent.operationId, operationId);
    await tick();
    assert.equal(runs, 1, 'overlapping admissions must reuse the same accepted execution');
    const operation = fallback.fallbackExecutionStatus(operationId, { config: barrierConfig,
      noticeScope: scope, workspace: 'app', workId: barrierId });
    assert.equal(operation.result.marker, 'durably admitted once');
    const persisted = history.readSession(barrierDirectory, barrierId);
    assert.ok(persisted.backgroundOperations.some(item => item.operationId === operationId));
    cases.push('in-flight history worker admission waits, preserves exact retry, and cancels without execution');
  } finally {
    try { barrierDb.exec('ROLLBACK'); } catch {}
    barrierDb.close();
    await flush;
  }


  const failedAdmissionConfig = { ...config, stateDir: path.join(root, 'failed-admission') };
  const failedId = 'failed-admission-task';
  history.writeSession(history.getTaskHistoryDir(failedAdmissionConfig), { id: failedId,
    status: 'planning', workspace: 'app', principalFingerprint: scope, events: [] });
  const failedAdmissionDb = openStateDatabase(failedAdmissionConfig);
  try {
    failedAdmissionDb.exec("CREATE TRIGGER fixture_admission_failure BEFORE INSERT ON task_history WHEN NEW.id='failed-admission-task' BEGIN SELECT RAISE(ABORT,'fixture worker admission failure'); END");
    recordTaskActivityEvent(failedAdmissionConfig, { task: { id: failedId, taskId: failedId,
      workspace: 'app', status: 'planning', title: 'failed queued snapshot' } }, { defer: true });
    let failedRuns = 0;
    await assert.rejects(withTaskHistoryPersistenceBarrier(failedAdmissionConfig, failedId, () => { failedRuns++; }),
      error => error.code === 'FALLBACK_PERSISTENCE_FAILED' && error.executed === false);
    assert.equal(failedRuns, 0, 'a rejected worker write cannot admit the handler');
    failedAdmissionDb.exec('DROP TRIGGER fixture_admission_failure');
    assert.equal(await withTaskHistoryPersistenceBarrier(failedAdmissionConfig, failedId, () => 'recovered'), 'recovered');
    cases.push('failed worker admission preserves no-handler guarantee and safely resumes after persistence recovery');
  } finally { failedAdmissionDb.close(); }


  const clearFailureConfig = { ...config, stateDir: path.join(root, 'clear-admission-failure') };
  history.writeSession(history.getTaskHistoryDir(clearFailureConfig), { id: 'clear-admission-task',
    status: 'planning', workspace: 'app', events: [] });
  const originalExec = DatabaseSync.prototype.exec;
  let clearRuns = 0;
  DatabaseSync.prototype.exec = function(sql, ...args) {
    if (sql === 'DELETE FROM task_history') throw new Error('fixture rejected history clear');
    return originalExec.call(this, sql, ...args);
  };
  try {
    const clearing = clearTaskHistory(clearFailureConfig);
    const admission = withTaskHistoryPersistenceBarrier(clearFailureConfig, 'clear-admission-task', () => { clearRuns++; });
    await Promise.all([
      assert.rejects(clearing, /fixture rejected history clear/),
      assert.rejects(admission, error => error.code === 'FALLBACK_PERSISTENCE_FAILED' && error.executed === false)
    ]);
    assert.equal(clearRuns, 0, 'a rejected clear cannot admit the handler or obscure not-started metadata');
  } finally { DatabaseSync.prototype.exec = originalExec; }

  const syncFailureConfig = { ...config, stateDir: path.join(root, 'sync-admission-failure') };
  history.writeSession(history.getTaskHistoryDir(syncFailureConfig), { id: 'sync-admission-task',
    status: 'planning', workspace: 'app', events: [] });
  const originalPost = Worker.prototype.postMessage;
  let syncInjected = false;
  let syncRuns = 0;
  Worker.prototype.postMessage = function(message, ...args) {
    const sent = originalPost.call(this, message, ...args);
    if (!syncInjected && message.session?.id === 'sync-admission-task') {
      // Let real completion release handles, but exercise a synchronous enqueue
      // exception before business-operation admission.
      syncInjected = true;
      throw new Error('fixture synchronous history dispatch failure');
    }
    return sent;
  };
  try {
    recordTaskActivityEvent(syncFailureConfig, { task: { id: 'sync-admission-task', workspace: 'app',
      status: 'planning', title: 'synchronous failure' } }, { defer: true });
    await assert.rejects(withTaskHistoryPersistenceBarrier(syncFailureConfig, 'sync-admission-task', () => { syncRuns++; }),
      error => error.code === 'FALLBACK_PERSISTENCE_FAILED' && error.executed === false);
    assert.equal(syncInjected, true);
    assert.equal(syncRuns, 0);
  } finally { Worker.prototype.postMessage = originalPost; }
  await withTaskHistoryPersistenceBarrier(syncFailureConfig, 'sync-admission-task', () => true);
  const afterAdmissionError = new Error('fixture admission callback error');
  await assert.rejects(withTaskHistoryPersistenceBarrier(syncFailureConfig, 'sync-admission-task',
    () => { throw afterAdmissionError; }), error => error === afterAdmissionError && !Object.hasOwn(error, 'executed'));

  const oneShot = `
    import { Worker } from 'node:worker_threads';
    const { recordTaskActivityEvent, withTaskHistoryPersistenceBarrier } = await import(${JSON.stringify(new URL('../src/taskHistoryStore.ts', import.meta.url).href)});
    const { getTaskHistoryDir, writeSession } = await import(${JSON.stringify(new URL('../src/taskHistoryStorage.ts', import.meta.url).href)});
    const config = { stateDir: ${JSON.stringify(path.join(root, 'one-shot-admission'))} };
    writeSession(getTaskHistoryDir(config), { id: 'stalled-worker', status: 'planning', workspace: 'app', events: [] });
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.session?.id === 'stalled-worker') { this.unref(); return; }
      return original.call(this, message, ...args);
    };
    recordTaskActivityEvent(config, { task: { id: 'stalled-worker', status: 'planning', workspace: 'app', title: 'pending' } }, { defer: true });
    let admitted = false;
    try {
      await withTaskHistoryPersistenceBarrier(config, 'stalled-worker', () => { admitted = true; }, { deadlineAtMs: Date.now() + 30 });
      process.exitCode = 1;
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, executed: error.executed, admitted }));
      if (error.code !== 'TIMEOUT' || error.executed !== false || admitted) process.exitCode = 1;
    }
  `;
  // A real file avoids inheriting --input-type into file-backed worker_threads.
  const oneShotFile = path.join(root, 'one-shot-admission.mjs');
  fs.writeFileSync(oneShotFile, oneShot);
  const oneShotResult = spawnSync(process.execPath, [oneShotFile],
    { env: process.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(oneShotResult.status, 0, oneShotResult.stderr || oneShotResult.stdout);
  assert.deepEqual(JSON.parse(oneShotResult.stdout.trim()), { code: 'TIMEOUT', executed: false, admitted: false });
  cases.push('inherited deadline, rejected clear, synchronous dispatch failure and one-shot timeout preserve admission truth');

  // Original public wrapper ordering, plus the opposite receipt ordering.
  for (const late of [true, false]) {
    fallback.resetFallbackExecutions();
    let release; let calls = 0;
    const barrier = new Promise(resolve => { release = resolve; });
    const executeToolResult = async () => { calls++; await barrier; return result({ marker: 'terminal' }); };
    const args = { workspace: 'app', paths: ['fixture.txt'] };
    const first = await handleTransportFallbackRequest(config, make('receipt-' + late, args), { ...options, synchronousFallbackGraceMs: 0, executeToolResult });
    assert.equal(first.body.result.structuredContent.status, 'running');
    if (!late) first.onDelivered();
    release(); await tick();
    if (late) first.onDelivered();
    const replay = await handleTransportFallbackRequest(config, make('retry-' + late, args), { ...options, synchronousFallbackGraceMs: 1000, executeToolResult });
    assert.equal(calls, 1, 'receipt delivery must not acknowledge an unseen terminal body');
    assert.equal(replay.body.result.structuredContent.marker, 'terminal');
    replay.onDelivered();
    const rerun = await handleTransportFallbackRequest(config, make('delivered-' + late, args), { ...options, synchronousFallbackGraceMs: 1000, executeToolResult });
    assert.equal(calls, 2, 'actual terminal delivery releases the documented replay identity');
    rerun.onDelivered();
  }
  cases.push('C2 receipt before/after settlement, lost response, exact terminal delivery');
  fallback.resetFallbackExecutions();
  let noticeCalls = 0;
  const noticeRun = async () => { noticeCalls++; return result({ marker: 'retained body' }); };
  const notice = start({ scopeId: 'notice', signature: 'notice', run: noticeRun });
  fallback.enableFallbackCompletionNotice(config, notice.record);
  await notice.record.promise; await tick();
  const context = { principal, requestId: 'notice-delivery' };
  const enriched = enrichWithFallbackCompletions(config, 'relai_work', { workspace: 'app' }, { ok: true, workspace: 'app' }, context);
  const framed = toolResult(enriched, false);
  registerReturnedFallbackCompletions(config, { workspace: 'app' }, framed, context, enriched);
  assert.equal(fallback.acknowledgeFallbackCompletionDelivery(scope, context.requestId), true);
  const retry = start({ scopeId: 'notice', signature: 'notice', run: noticeRun });
  assert.equal(retry.reused, true);
  assert.equal(noticeCalls, 1);
  cases.push('C3 delivered summary leaves terminal replay protection intact');
  // Overlapping JSON-RPC ids on one principal cannot consume the other payload.
  const first = start({ scopeId: 'correlation-a', signature: 'a' });
  const second = start({ scopeId: 'correlation-b', signature: 'b' });
  fallback.enableFallbackCompletionNotice(config, first.record);
  fallback.enableFallbackCompletionNotice(config, second.record);
  await Promise.all([first.record.promise, second.record.promise]); await tick();
  const ready = fallback.peekFallbackCompletionNotices(config, { noticeScope: scope, workspace: 'app' });
  for (const op of [first, second]) fallback.registerFallbackCompletionDelivery(config, ready.filter(n => n.operationId === op.record.operationId),
    { noticeScope: scope, workspace: 'app', requestId: 7 });
  assert.equal(fallback.acknowledgeFallbackCompletionDelivery(scope, 7), false);
  const preserved = fallback.peekFallbackCompletionNotices(config, { noticeScope: scope, workspace: 'app' });
  assert.ok([first, second].every(op => preserved.some(n => n.operationId === op.record.operationId)));
  cases.push('same-principal overlapping request ids fail closed without consuming notices');

  fallback.resetFallbackExecutions();
  // Actual transport -> invocation -> callTool -> read; equivalent workspace forms.
  let readId;
  for (const workspace of ['app', root, ...(process.platform === 'win32' ? [root.toUpperCase()] : [])]) {
    const response = await handleTransportFallbackRequest(config, make('read-' + workspace, { workspace, paths: ['fixture.txt'] }), { ...options, synchronousFallbackGraceMs: 1000 });
    const body = response.body.result.structuredContent;
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.workspace, 'app');
    assert.ok(body.operationId);
    readId ||= body.operationId;
    assert.equal(body.operationId, readId, 'canonical scope must also canonicalize retry signatures');
    const lookup = await relaiStatus(config, { workspace: 'app', operationId: body.operationId }, { connector: true, principal });
    assert.equal(lookup.errorCode, undefined);
  }
  const begin = await handleTransportFallbackRequest(config, make('begin', { action: 'begin', workspace: 'app',
    title: 'Read recovery fixture', objective: 'Read one harmless fixture', steps: [{ title: 'Read fixture', status: 'in_progress' }] }, 'relai_work'),
    { ...options, synchronousFallbackGraceMs: 1000 });
  const workId = begin.body.result.structuredContent.work_id;
  assert.ok(workId, JSON.stringify(begin.body.result));
  const inferred = await handleTransportFallbackRequest(config, make('work-read', { work_id: workId, paths: ['fixture.txt'] }), { ...options, synchronousFallbackGraceMs: 1000 });
  assert.equal(inferred.body.result.structuredContent.ok, true, JSON.stringify(inferred.body.result));
  assert.equal(inferred.body.result.structuredContent.workspace, 'app');
  const inferredLookup = await relaiStatus(config, { workspace: 'app', operationId: inferred.body.result.structuredContent.operationId }, { connector: true, principal });
  assert.equal(inferredLookup.errorCode, undefined);
  // A pre-upgrade retained raw path is canonicalized only through configured scope.
  const legacy = start({ scopeId: 'legacy-path', workspace: root, signature: 'legacy-path' });
  await legacy.record.promise;
  fallback.resetFallbackExecutions();
  assert.equal(fallback.fallbackExecutionStatus(legacy.record.operationId, { config, noticeScope: scope, workspace: 'app' }).workspace, 'app');
  cases.push('C1 canonical alias, configured path, Windows case, explicit task inference, retained legacy lookup');

  // Fail durable admission before scheduling any work.
  const admissionConfig = { ...config, stateDir: path.join(root, 'admission-failure') };
  fs.mkdirSync(admissionConfig.stateDir, { recursive: true });
  fs.writeFileSync(path.join(admissionConfig.stateDir, 'fallback-executions'), 'fixture blocker');
  let admittedRuns = 0;
  assert.throws(() => start({ config: admissionConfig, scopeId: 'blocked', signature: 'blocked', run: async () => { admittedRuns++; return result(); } }),
    error => error.code === 'FALLBACK_RECOVERY_UNAVAILABLE' && error.executed === false);
  await tick(); assert.equal(admittedRuns, 0);
  // Fail only after execution starts, preserving the completed body and replay key.
  const terminalConfig = { ...config, stateDir: path.join(root, 'terminal-failure') };
  let releaseTerminal; let terminalRuns = 0;
  const terminalBarrier = new Promise(resolve => { releaseTerminal = resolve; });
  const terminal = start({ config: terminalConfig, scopeId: 'terminal-failure', signature: 'terminal-failure',
    run: async () => { terminalRuns++; await terminalBarrier; return result({ marker: 'executed-once' }); } });
  const fallbackDir = path.join(terminalConfig.stateDir, 'fallback-executions');
  await tick();
  fs.rmSync(fallbackDir, { recursive: true, force: true }); fs.writeFileSync(fallbackDir, 'fixture blocker');
  releaseTerminal(); const settled = await terminal.record.promise;
  assert.equal(settled.result.structuredContent.marker, 'executed-once');
  assert.equal(settled.result.structuredContent.operationPersistence.durable, false);
  assert.equal(start({ config: terminalConfig, scopeId: 'terminal-failure', signature: 'terminal-failure' }).reused, true);
  assert.equal(terminalRuns, 1);
  cases.push('durability admission failure never executes; terminal failure retains result and no-rerun guidance');


  const noticeFailureConfig = { ...config, stateDir: path.join(root, 'notice-failure') };
  fs.mkdirSync(noticeFailureConfig.stateDir, { recursive: true });
  fs.writeFileSync(path.join(noticeFailureConfig.stateDir, 'fallback-completions'), 'fixture blocker');
  const noticeFailure = start({ config: noticeFailureConfig, scopeId: 'notice-failure', signature: 'notice-failure' });
  assert.doesNotThrow(() => fallback.enableFallbackCompletionNotice(noticeFailureConfig, noticeFailure.record));
  assert.equal((await noticeFailure.record.promise).result.structuredContent.ok, true);
  await tick();
  assert.ok(fallback.fallbackExecutionStatus(noticeFailure.record.operationId).noticePersistenceError);
  assert.equal(start({ config: noticeFailureConfig, scopeId: 'notice-failure', signature: 'notice-failure' }).reused, true);
  cases.push('notice persistence failure preserves operation result and replay identity');


  // Fail inside the actual retainOutputStreams entry, after the real handler
  // result exists. No replacement callback hides the promise settlement path.
  const retentionConfig = { ...config, stateDir: path.join(root, 'retention-callback') };
  Object.defineProperty(retentionConfig, 'processOutputFinalizationTimeoutMs', {
    get() { throw new Error('fixture retention configuration failure'); }
  });
  let retentionCalls = 0;
  const retentionFailure = start({ config: retentionConfig, scopeId: 'retention-callback', signature: 'retention-callback',
    run: async () => { retentionCalls++; return result({ executed: true, commandSucceeded: true, stdout: 'only terminal copy' }); } });
  const retainedSettlement = await retentionFailure.record.promise;
  assert.equal(retainedSettlement.result.structuredContent.commandSucceeded, true);
  assert.equal(retainedSettlement.result.structuredContent.outputRetentionFailed, true);
  const retainedStatus = fallback.fallbackExecutionStatus(retentionFailure.record.operationId);
  assert.equal(retainedStatus.status, 'completed');
  assert.equal(retainedStatus.result.stdout, 'only terminal copy');
  assert.equal(start({ config: retentionConfig, scopeId: 'retention-callback', signature: 'retention-callback' }).reused, true);
  assert.equal(retentionCalls, 1);
  cases.push('actual post-handler retention throw preserves terminal facts, retrieval and replay');

  // Mixed legacy sources, transient read failure, import failure, and canonical rows.
  const recoveryConfig = { stateDir: path.join(root, 'recovery') };
  const directory = history.getTaskHistoryDir(recoveryConfig);
  fs.mkdirSync(directory, { recursive: true });
  const session = id => ({ version: 3, id, taskId: id, sessionId: id, workspace: 'app', status: 'completed', title: 'marker-' + id, events: [] });
  const legacyFiles = {
    'valid.json': JSON.stringify(session('valid')),
    'unsupported.json': JSON.stringify({ ...session('unsupported'), version: 99 }),
    'malformed.json': '{"version":3,"id":"broken","marker":"keep-broken",',
    'unreadable.json': JSON.stringify(session('unreadable')),
    'blocked.json': JSON.stringify(session('blocked'))
  };
  for (const [name, text] of Object.entries(legacyFiles)) fs.writeFileSync(path.join(directory, name), text);
  db = openStateDatabase(recoveryConfig);
  db.exec("CREATE TRIGGER fixture_import_failure BEFORE INSERT ON task_history WHEN NEW.id='blocked' BEGIN SELECT RAISE(ABORT,'fixture import failure'); END");
  db.close();
  const originalRead = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (String(file) === path.join(directory, 'unreadable.json')) throw Object.assign(new Error('fixture unreadable'), { code: 'EACCES' });
    return originalRead.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try { history.ensureCurrentHistory(recoveryConfig); } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  for (const name of ['unsupported.json', 'malformed.json', 'unreadable.json', 'blocked.json'])
    assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), legacyFiles[name]);
  const recoveryCopies = fs.readdirSync(path.join(recoveryConfig.stateDir, 'rejected-task-history'))
    .map(name => fs.readFileSync(path.join(recoveryConfig.stateDir, 'rejected-task-history', name), 'utf8'));
  for (const name of ['unsupported.json', 'malformed.json', 'blocked.json']) assert.ok(recoveryCopies.includes(legacyFiles[name]),
    'readable rejected source must also survive outside an older client migration directory');
  assert.equal(fs.existsSync(path.join(directory, 'valid.json')), false);
  assert.ok(fs.readdirSync(path.join(recoveryConfig.stateDir, 'imported-task-history')).some(name => fs.readFileSync(path.join(recoveryConfig.stateDir, 'imported-task-history', name), 'utf8') === legacyFiles['valid.json']));
  db = openStateDatabase(recoveryConfig);
  assert.equal(db.prepare("SELECT value FROM state_meta WHERE key='task_history_legacy_migrated_v1'").get().value, 'partial');
  db.exec('DROP TRIGGER fixture_import_failure');
  const rejectedRows = { 'canonical-broken': '{"marker":"keep-canonical",', 'canonical-unsupported': JSON.stringify({ ...session('canonical-unsupported'), version: 99 }) };
  for (const [id, payload] of Object.entries(rejectedRows)) db.prepare('INSERT INTO task_history(id,updated_at_ms,payload) VALUES(?,?,?)').run(id, 1, payload);
  db.close();
  history.resetTaskHistoryCaches(); history.ensureCurrentHistory(recoveryConfig);
  assert.equal(history.readSession(directory, 'unreadable')?.id, 'unreadable');
  assert.equal(history.readSession(directory, 'blocked')?.id, 'blocked');
  for (const id of Object.keys(rejectedRows)) assert.equal(history.readSession(directory, id), null);
  history.listSessions(directory); history.listSessionSummaries(directory);
  history.pruneSessions(directory, { retentionDays: 1, storageBudgetBytes: 0 });
  db = openStateDatabase(recoveryConfig);
  for (const [id, payload] of Object.entries(rejectedRows)) assert.equal(db.prepare('SELECT payload FROM task_history WHERE id=?').get(id)?.payload, payload);
  db.close();
  cases.push('C4 rejected legacy bytes, successful import archive, read/import retry, canonical read/list/retention preservation');

  const pointerConfig = { ...config, stateDir: path.join(root, 'pointer-retention') };
  history.ensureCurrentHistory(pointerConfig);
  const pointerRoot = path.join(pointerConfig.stateDir, 'fallback-executions');
  fs.mkdirSync(pointerRoot, { recursive: true });
  const orphanId = 'fallback_orphan_pointer_123456789012345';
  const orphanFile = path.join(pointerRoot, orphanId + '.json');
  fs.writeFileSync(orphanFile, JSON.stringify({ operationId: orphanId, workId: 'expired-task' }));
  const old = new Date(Date.now() - 20 * 60_000); fs.utimesSync(orphanFile, old, old);
  const retainedId = 'fallback_retained_pointer_123456789012345';
  const retainedFile = path.join(pointerRoot, retainedId + '.json');
  history.writeSession(history.getTaskHistoryDir(pointerConfig), { ...session('retained-task'), status: 'planning',
    backgroundOperations: [{ operationId: retainedId, status: 'completed' }] });
  fs.writeFileSync(retainedFile, JSON.stringify({ operationId: retainedId, workId: 'retained-task' }));
  fs.utimesSync(retainedFile, old, old);
  const trigger = start({ config: pointerConfig, scopeId: 'prune-trigger', signature: 'prune-trigger' });
  await trigger.record.promise;
  const until = Date.now() + 2000;
  while (fs.existsSync(orphanFile) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(orphanFile), false, 'expired task pointers must be retired');
  assert.equal(fs.existsSync(retainedFile), true, 'a retained task operation pointer must survive');
  cases.push('stale orphan pointers retire without hydrating history; retained pointer survives');
  const { toolArgumentError } = await import('../src/tools/validationGuidance.js');
  const { serializeToolError } = await import('../src/tools/errors.js');
  for (const [tool, action, expected] of [['relai_search', 'text', 'read'], ['relai_changes', 'diff', 'review']]) {
    const failure = toolArgumentError({ publicTool: tool, action, issues: [{ field: 'extra', message: 'Unsupported field' }] });
    assert.equal(serializeToolError('', failure).errorDetails.operation, expected);
    assert.equal(serializeToolError(tool, failure).errorDetails.operation, expected);
  }
  cases.push('validation rejection metadata retains public tool and action identity');
  const description = getPublicToolSchemas().find(tool => tool.name === 'relai_publish').description;
  assert.match(description, /git:publish/); assert.doesNotMatch(description, /approval-gated/);
  cases.push('C6 discovery describes capability-only push without changing policy');
  console.log(JSON.stringify({ ok: true, runtime: process.version, platform: process.platform, cases }));
} catch (error) {
  console.error(JSON.stringify({ completedCases: cases, failure: error.stack }));
  throw error;
} finally {
  try { db?.close(); } catch {}
  fallback.resetFallbackExecutions();
  const { flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
  await flushTaskHistoryPersistence();
  const { repositoryIntelligence } = await import('../src/repository/intelligence/service.js');
  await repositoryIntelligence.shutdown();
  await new Promise(resolve => setTimeout(resolve, 100));
  // Parent cleanup runs after this child and its worker handles have exited.
}
