import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { runTestProcess } from './helpers/run-test-process.mjs';

// Independent process/global isolation keeps lock/retry timing separate from
// the existing result-recovery fixture's deadline and preserves owned cleanup.
const mode = process.argv[2];
if (mode !== '--fixture' && mode !== '--fresh') {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-terminal-journal-'));
  let child;
  try {
    child = await runTestProcess(process.execPath, ['--max-old-space-size=256', import.meta.filename, '--fixture', fixtureRoot],
      { cwd: process.cwd(), timeoutMs: 45000, maxOutputBytes: 300000 });
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.equal(child.terminationUncertain, false, JSON.stringify(child));
    assert.equal(child.timedOut, false, JSON.stringify(child));
    assert.equal(child.exitCode, 0, child.error?.message || 'terminal-journal fixture failed');
  } finally {
    if (child && !child.terminationUncertain) fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  process.exit(0);
}

if (mode === '--fresh') {
  const fixture = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  delete process.env.REL_AI_MCP_STATE_DIR;
  const fallback = await import('../src/mcp/fallbackExecutions.js');
  try {
    const value = fallback.fallbackExecutionStatus(fixture.operationId, { config: fixture.config,
      noticeScope: fixture.scope, workspace: 'app', workId: fixture.workId });
    fs.writeFileSync(fixture.readyFile + '.tmp', JSON.stringify(value));
    fs.renameSync(fixture.readyFile + '.tmp', fixture.readyFile);
    const deadline = Date.now() + 16000;
    while (JSON.parse(fs.readFileSync(fixture.journalFile, 'utf8')).journalPending === true && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(JSON.parse(fs.readFileSync(fixture.journalFile, 'utf8')).journalPending, undefined,
      'one recovery lookup must start retries that converge after SQLite unlocks');
    console.log(JSON.stringify({ converged: true, maxRssKiB: process.resourceUsage().maxRSS }));
  } finally {
    fallback.resetFallbackExecutions();
    const { flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
    await flushTaskHistoryPersistence();
  }
  process.exit(0);
}

const root = process.argv[3];
delete process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_CONFIG = path.join(root, 'config.json');
const config = { stateDir: path.join(root, 'state'), workspaces: { app: { path: root } }, telemetry: { enabled: false, diagnosticsEnabled: false } };
fs.writeFileSync(process.env.REL_AI_MCP_CONFIG, JSON.stringify(config));
const fallback = await import('../src/mcp/fallbackExecutions.js');
const history = await import('../src/taskHistoryStorage.ts');
const { openStateDatabase } = await import('../src/stateDatabase.ts');
const { toolResult } = await import('../src/mcp/results.js');
const { createStdioPrincipal, principalFingerprint } = await import('../src/mcp/principal.ts');
const scope = principalFingerprint(createStdioPrincipal());
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitForPointer(file) {
  const deadline = Date.now() + 2000;
  while (JSON.parse(fs.readFileSync(file, 'utf8')).journalPending === true && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).journalPending, undefined, 'a physically committed canonical winner must retire its stale journal');
}
const cases = [];
function result(value = {}) { return toolResult({ ok: true, workspace: 'app', ...value }, false); }
function start(overrides = {}) {
  return fallback.startFallbackExecution({ config, scopeId: 'fixture', noticeScope: scope, workspace: 'app',
    tool: 'relai_read', signature: 'fixture', run: async () => result(), ...overrides });
}
try {
// A real SQLite write lock acquired after admission must not lose completion.
{
  fallback.resetFallbackExecutions();
  const journalConfig = { ...config, stateDir: path.join(root, 'terminal-journal') };
  const journalId = 'terminal-journal-task';
  const journalDirectory = history.getTaskHistoryDir(journalConfig);
  history.writeSession(journalDirectory, { id: journalId, status: 'planning',
    workspace: 'app', principalFingerprint: scope, events: [] });
  const lock = openStateDatabase(journalConfig);
  const signature = 'terminal-journal-once';
  let release;
  let runs = 0;
  const completed = new Promise(resolve => { release = resolve; });
  const run = async () => { runs++; await completed; return result({
    marker: 'journal-completed-once', executed: true, commandSucceeded: true, exitCode: 0, terminationConfirmed: true,
    stdout: 'terminal-journal-private-output'
  }); };
  const started = start({ config: journalConfig, workId: journalId,
    scopeId: journalId, signature, run });
  const operationId = started.record.operationId;
  const journalFile = path.join(journalConfig.stateDir, 'fallback-executions', operationId + '.json');
  const operation = () => fallback.fallbackExecutionStatus(operationId,
    { config: journalConfig, noticeScope: scope, workspace: 'app', workId: journalId });
  const writeJournal = value => fs.writeFileSync(journalFile, JSON.stringify(value));
  let locked = false;
  try {
    lock.exec('BEGIN IMMEDIATE'); locked = true;
    const persistenceStartedAt = performance.now();
    const serviceTick = new Promise(resolve => setImmediate(() => resolve(performance.now() - persistenceStartedAt)));
    release();
    await started.record.promise;
    assert.ok(await serviceTick < 1000, 'terminal persistence must yield without a SQLite busy wait');
    const terminal = operation();
    assert.equal(terminal.status, 'completed');
    assert.equal(terminal.durability, 'journaled');
    assert.equal(terminal.result.operationPersistence.durable, true);
    assert.equal(terminal.result.operationPersistence.canonicalPending, true);
    const journalSource = fs.readFileSync(journalFile, 'utf8');
    const journal = JSON.parse(journalSource);
    assert.equal(journal.journalPending, true);
    assert.equal(journal.result.commandSucceeded, true);
    assert.equal(journal.result.exitCode, 0);
    assert.doesNotMatch(JSON.stringify(journal), /terminal-journal-private-output/);
    assert.match(journal.result.stdoutOutputRef, /^spill_/);
    assert.equal(history.readSession(journalDirectory, journalId).backgroundOperation.status, 'running');
    // Inject one exact journal-read failure. Existing evidence must never be
    // treated as absence or overwritten by a synthesized interrupted receipt.
    fallback.resetFallbackExecutions();
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(journalFile)) {
        throw Object.assign(new Error('fixture unreadable journal'), { code: 'EACCES' });
      }
      return read.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    try {
      assert.throws(operation, error => error.code === 'FALLBACK_RECOVERY_UNAVAILABLE');
    } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
    assert.equal(fs.readFileSync(journalFile, 'utf8'), journalSource,
      'failed recovery must not overwrite the terminal journal');
    const recovered = operation();
    assert.equal(recovered.status, 'completed');
    assert.equal(start({ config: journalConfig, workId: journalId, scopeId: journalId,
      signature, run }).reused, true);
    assert.equal(runs, 1, 'receipt recovery cannot rerun the original handler');

    // A terminal journal remains authoritative beyond the ordinary memory TTL.
    fallback.resetFallbackExecutions();
    assert.equal(operation().status, 'completed');
    const pastTtl = fallback.fallbackExecutionStatus(journalId, { config: journalConfig,
      noticeScope: scope, workspace: 'app', now: () => Date.now() + 16 * 60000 });
    assert.equal(pastTtl.status, 'completed');
    assert.equal(pastTtl.result.commandSucceeded, true);
    assert.equal(pastTtl.result.exitCode, 0);
    const beforeAck = operation();
    assert.equal(fallback.acknowledgeFallbackDelivery(journalConfig, operationId, {
      kind: 'result', operationId, status: beforeAck.status, revision: beforeAck.revision
    }), true);
    assert.equal(JSON.parse(fs.readFileSync(journalFile, 'utf8')).deliveryAcknowledged, true);

    // Recover once in a genuinely new process, then do not touch its live record.
    // The child polls only the journal file to observe automatic reconciliation.
    fallback.resetFallbackExecutions();
    const freshConfigFile = path.join(root, 'fresh-journal-config.json');
    const freshReadyFile = path.join(root, 'fresh-journal-ready.json');
    fs.writeFileSync(freshConfigFile, JSON.stringify({ config: journalConfig, scope,
      operationId, workId: journalId, journalFile, readyFile: freshReadyFile }));
    const freshPending = runTestProcess(process.execPath, ['--max-old-space-size=256', import.meta.filename,
      '--fresh', freshConfigFile], { cwd: process.cwd(), timeoutMs: 20000, maxOutputBytes: 200000 });
    let fresh;
    try {
      const readyDeadline = Date.now() + 5000;
      while (!fs.existsSync(freshReadyFile) && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(freshReadyFile), true, 'fresh recovery must finish one exact lookup while SQLite is locked');
      const freshResult = JSON.parse(fs.readFileSync(freshReadyFile, 'utf8'));
      assert.equal(freshResult.status, 'completed');
      assert.equal(freshResult.result.commandSucceeded, true);
      assert.equal(freshResult.result.exitCode, 0);
      assert.equal(freshResult.result.stdoutOutputRef, journal.result.stdoutOutputRef);
      await new Promise(resolve => setTimeout(resolve, 8000));
      lock.exec('ROLLBACK'); locked = false;
      fresh = await freshPending;
    } finally {
      if (locked) { lock.exec('ROLLBACK'); locked = false; }
      fresh ||= await freshPending;
    }
    assert.equal(fresh.terminationUncertain, false, JSON.stringify(fresh));
    assert.equal(fresh.timedOut, false, JSON.stringify(fresh));
    assert.equal(fresh.exitCode, 0, fresh.stderr || fresh.stdout || fresh.error?.message);
    assert.equal(JSON.parse(fresh.stdout.trim()).converged, true);
    const canonical = history.readSession(journalDirectory, journalId).backgroundOperations
      .find(item => item.operationId === operationId);
    assert.equal(canonical.status, 'completed');
    assert.equal(canonical.deliveryAcknowledged, true, 'late retries cannot undo delivery acknowledgement');
    assert.equal(canonical.result.operationPersistence, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(journalFile, 'utf8')),
      { operationId, workId: journalId }, 'canonical convergence replaces the journal with its pointer');

    // Ownership disagreement and equal-revision terminal disagreement fail closed.
    for (const corrupt of [
      { ...canonical, journalPending: true, noticeScope: 'different-principal' },
      { ...canonical, journalPending: true, signature: 'different-signature' },
      { ...canonical, journalPending: true, result: { ...canonical.result, exitCode: 17 } }
    ]) {
      fallback.resetFallbackExecutions(); writeJournal(corrupt);
      assert.throws(operation, error => error.code === 'FALLBACK_RECOVERY_UNAVAILABLE');
    }

    // Equal-revision acknowledgement=true dominates in either storage source.
    for (const [databaseAcknowledged, journalAcknowledged] of [[true, false], [false, true]]) {
      fallback.resetFallbackExecutions();
      const session = history.readSession(journalDirectory, journalId);
      const dbRecord = { ...canonical, deliveryAcknowledged: databaseAcknowledged };
      history.writeSession(journalDirectory, { ...session, backgroundOperation: dbRecord,
        backgroundOperations: session.backgroundOperations.map(item => item.operationId === operationId ? dbRecord : item) });
      writeJournal({ ...canonical, journalPending: true, deliveryAcknowledged: journalAcknowledged });
      assert.equal(operation().status, 'completed');
      await waitForPointer(journalFile);
      const admitted = start({ config: journalConfig, workId: journalId, scopeId: journalId,
        signature, run: async () => result({ commandSucceeded: true, exitCode: 0 }) });
      assert.equal(admitted.reused, false, 'either acknowledged source must release the old replay identity');
      assert.notEqual(admitted.record.operationId, operationId);
      await admitted.record.promise;
      assert.equal(fallback.acknowledgeFallbackDelivery(journalConfig, admitted.record.operationId, {
        kind: 'result', operationId: admitted.record.operationId,
        status: admitted.record.status, revision: admitted.record.revision
      }), true, 'finish the harmless fixture operation before testing the opposite acknowledgement direction');
    }
    cases.push('terminal SQLite lock journals, survives fresh recovery, preserves identity/acknowledgement, and converges without blocking');
  } finally {
    fallback.resetFallbackExecutions();
    if (locked) { try { lock.exec('ROLLBACK'); } catch {} }
    lock.close();
  }
}

{
  const fixtureConfig = suffix => ({ ...config, stateDir: path.join(root, `journal-extra-${suffix}`) });
  const normalizedPath = value => path.resolve(String(value));
  const recordFile = (cfg, operationId) => path.join(cfg.stateDir, 'fallback-executions', `${operationId}.json`);
  const lookup = (cfg, workId, operationId, extra = {}) => fallback.fallbackExecutionStatus(operationId,
    { config: cfg, noticeScope: scope, workspace: 'app', ...(workId ? { workId } : {}), ...extra });
  function seedTask(cfg, workId, operation = null) {
    const directory = history.getTaskHistoryDir(cfg);
    history.writeSession(directory, { id: workId, status: 'planning', workspace: 'app',
      principalFingerprint: scope, events: [], ...(operation ? {
        backgroundOperation: operation, backgroundOperations: [operation]
      } : {}) });
    return directory;
  }
  function canonicalOperation(directory, workId, operationId) {
    const session = history.readSession(directory, workId);
    return (session?.backgroundOperations || (session?.backgroundOperation ? [session.backgroundOperation] : []))
      .find(value => value.operationId === operationId);
  }
  async function waitUntil(predicate, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(predicate(), true, label);
  }

  // Real admission precedes failure injection. All128 terminal writes then fail
  // at the exact receipt directory while their accepted records remain intact.
  {
    fallback.resetFallbackExecutions();
    const cfg = fixtureConfig('memory-capacity');
    const sentinelTask = 'journal-memory-durable-sentinel-task';
    const sentinelDirectory = seedTask(cfg, sentinelTask);
    const sentinel = start({ config: cfg, workId: sentinelTask, signature: 'durable-sentinel',
      run: async () => result({ commandSucceeded: true, exitCode: 0 }) });
    await sentinel.record.promise;
    const sentinelId = sentinel.record.operationId;
    assert.equal(canonicalOperation(sentinelDirectory, sentinelTask, sentinelId).status, 'completed');
    const records = [];
    const base = Date.now();
    let release;
    let runs = 0;
    let rejectedRuns = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const receiptDirectory = path.join(cfg.stateDir, 'fallback-executions');
    const originalMkdir = fs.mkdirSync;
    let injected = false;
    try {
      for (let index = 0; index < 128; index++) {
        // One execution scope with distinct request signatures avoids quadratic
        // legacy directory scans while still admitting128 separate operations.
        records.push(start({ config: cfg, scopeId: 'protected-memory',
          signature: `protected-memory-${index}`, now: () => base,
          run: async () => { runs++; await gate; return result({ marker: `protected-result-${index}` }); }
        }));
      }
      await tick();
      assert.equal(runs, 128, 'all admitted handlers must reach the explicit completion gate');
      fs.mkdirSync = function(directory, ...args) {
        if (normalizedPath(directory) === normalizedPath(receiptDirectory)) {
          throw Object.assign(new Error('fixture terminal receipt directory unavailable'), { code: 'EACCES' });
        }
        return originalMkdir.call(this, directory, ...args);
      };
      injected = true;
      syncBuiltinESMExports();
      release();
      await Promise.all(records.map(value => value.record.promise));
      assert.equal(records.every(value => value.record.status === 'completed'
        && value.record.durability === 'memory_only'), true);

      // Recovering this durable sentinel temporarily makes129 cached records.
      // The next pruning pass must discard the durable sentinel, never an
      // unpersisted terminal. No simulated clock is involved in this count case.
      assert.equal(lookup(cfg, sentinelTask, sentinelId).result.commandSucceeded, true);
      assert.equal(canonicalOperation(sentinelDirectory, sentinelTask, sentinelId).result.exitCode, 0);
      assert.equal(lookup(cfg, '', records[0].record.operationId).result.marker, 'protected-result-0');
      assert.equal(fallback.fallbackExecutionStatus(sentinelId), null,
        'count pruning must actually evict the recoverable durable sentinel');
      for (const [index, value] of records.entries()) {
        const retained = fallback.fallbackExecutionStatus(value.record.operationId);
        assert.equal(retained?.status, 'completed');
        assert.equal(retained?.result.marker, `protected-result-${index}`);
        assert.equal(retained?.durability, 'memory_only');
      }

      // Exercise TTL with the live cache populated, not after an empty reset.
      const farFuture = () => base + 16 * 60_000;
      const first = lookup(cfg, '', records[0].record.operationId, { now: farFuture });
      assert.equal(first.result.marker, 'protected-result-0');
      assert.equal(first.durability, 'memory_only');
      const replay = start({ config: cfg, scopeId: 'protected-memory', signature: 'protected-memory-0',
        now: farFuture, run: async () => { rejectedRuns++; return result(); } });
      assert.equal(replay.reused, true, 'full receipt capacity must still permit exact replay');
      assert.equal(replay.record.operationId, records[0].record.operationId);
      assert.throws(() => start({ config: cfg, scopeId: 'protected-memory', signature: 'protected-memory-new',
        now: farFuture, run: async () => { rejectedRuns++; return result(); } }),
      error => error.code === 'FALLBACK_RECOVERY_CAPACITY' && error.executed === false && error.retryable === true);
      await tick();
      assert.equal(rejectedRuns, 0, 'neither replay nor rejected admission may schedule a new handler');
      assert.equal(runs, 128);

      // Restore only this fixture's writer and durably acknowledge one result.
      // A released protected slot must permit a genuinely new admission.
      fs.mkdirSync = originalMkdir;
      injected = false;
      syncBuiltinESMExports();
      assert.equal(fallback.acknowledgeFallbackDelivery(cfg, records[0].record.operationId, {
        kind: 'result', operationId: records[0].record.operationId,
        status: records[0].record.status, revision: records[0].record.revision
      }), true);
      assert.equal(records[0].record.durability, 'persisted');
      const admitted = start({ config: cfg, scopeId: 'protected-memory', signature: 'protected-memory-new',
        run: async () => { rejectedRuns++; return result({ marker: 'capacity-reopened' }); } });
      await admitted.record.promise;
      assert.equal(admitted.reused, false);
      assert.equal(rejectedRuns, 1);
      cases.push('memory-only receipts survive actual count/TTL pruning;128 protected receipts block only new execution');
    } finally {
      if (injected) { fs.mkdirSync = originalMkdir; syncBuiltinESMExports(); }
      release();
      await Promise.allSettled(records.map(value => value.record.promise));
      fallback.resetFallbackExecutions();
    }
  }

  // Seed all files before this state directory's first fallback start so the
  // thirty-second pruning throttle cannot turn the test into a no-op.
  {
    fallback.resetFallbackExecutions();
    const cfg = fixtureConfig('disk-pruning');
    const workId = 'journal-prune-protected-task';
    const operationId = 'fallback_journal_prune_protected_000000000001';
    const old = new Date(Date.now() - 20 * 60_000);
    const running = { operationId, executionKey: workId, workId, tool: 'relai_read', workspace: 'app',
      noticeScope: scope, signature: 'journal-prune-protected', status: 'running', revision: 1,
      startedAt: old.toISOString(), updatedAt: old.toISOString() };
    seedTask(cfg, workId, running);
    const journal = { ...running, journalPending: true, status: 'completed', revision: 2,
      completedAt: old.toISOString(), result: { ok: true, commandSucceeded: true, exitCode: 0 } };
    const journalFile = recordFile(cfg, operationId);
    const directory = path.dirname(journalFile);
    fs.mkdirSync(directory, { recursive: true });
    const journalSource = JSON.stringify(journal);
    fs.writeFileSync(journalFile, journalSource);
    fs.utimesSync(journalFile, old, old);
    const expiredId = 'fallback_journal_prune_expired_control_0000001';
    const expiredFile = recordFile(cfg, expiredId);
    fs.writeFileSync(expiredFile, JSON.stringify({ operationId: expiredId, status: 'completed' }));
    fs.utimesSync(expiredFile, old, old);
    const freshControls = [];
    for (let index = 0; index < 129; index++) {
      const id = `fallback_journal_prune_fresh_control_${String(index).padStart(12, '0')}`;
      const file = recordFile(cfg, id);
      fs.writeFileSync(file, JSON.stringify({ operationId: id, status: 'completed' }));
      freshControls.push(file);
    }
    try {
      const trigger = start({ config: cfg, scopeId: 'disk-prune-trigger', signature: 'disk-prune-trigger',
        run: async () => result({ marker: 'prune-trigger' }) });
      await trigger.record.promise;
      await waitUntil(() => !fs.existsSync(expiredFile)
        && freshControls.some(file => !fs.existsSync(file)), 2500,
      'both age and count controls must be deleted to prove the disk-prune pass ran');
      assert.equal(fs.readFileSync(journalFile, 'utf8'), journalSource,
        'unreconciled terminal journal must survive both disk retention controls unchanged');
      cases.push('disk pruning removes expired/count controls while preserving the only pending terminal journal');
    } finally { fallback.resetFallbackExecutions(); }
  }

  // Reset must revoke retry ownership before SQLite becomes writable again.
  {
    fallback.resetFallbackExecutions();
    const cfg = fixtureConfig('reset-retry');
    const workId = 'journal-reset-retry-task';
    const directory = seedTask(cfg, workId);
    const lock = new DatabaseSync(path.join(cfg.stateDir, 'durable-state.sqlite'));
    let locked = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const started = start({ config: cfg, workId, signature: 'journal-reset-retry',
      run: async () => { await gate; return result({ marker: 'reset-retry-result' }); } });
    const file = recordFile(cfg, started.record.operationId);
    try {
      lock.exec('BEGIN IMMEDIATE'); locked = true;
      release();
      await started.record.promise;
      assert.equal(started.record.durability, 'journaled');
      assert.match(started.record.persistenceError, /database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/i);
      const source = fs.readFileSync(file, 'utf8');
      fallback.resetFallbackExecutions();
      lock.exec('ROLLBACK'); locked = false;
      // The initial retry is25ms. No long-running handler or output retention
      // precedes this reset, and reset occurs in the settlement microtask.
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(fs.readFileSync(file, 'utf8'), source,
        'a retry owned by the reset cache must not replace or rewrite the journal');
      assert.equal(canonicalOperation(directory, workId, started.record.operationId).status, 'running',
        'reset must prevent the queued retry from committing to canonical history');
      assert.equal(fallback.fallbackExecutionStatus(started.record.operationId), null,
        'reset must leave no live receipt in the cache');
      cases.push('reset revokes a queued terminal retry before its lock clears');
    } finally {
      release();
      await Promise.allSettled([started.record.promise]);
      fallback.resetFallbackExecutions();
      if (locked) { try { lock.exec('ROLLBACK'); } catch {} }
      lock.close();
    }
  }

  // A terminal journal survives a failed pointer refresh after a later
  // canonical acknowledgement, then retires through pointer-only recovery.
  {
    fallback.resetFallbackExecutions();
    const cfg = fixtureConfig('pointer-failure');
    const workId = 'journal-pointer-failure-task';
    const directory = seedTask(cfg, workId);
    const lock = openStateDatabase(cfg);
    let locked = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const started = start({ config: cfg, workId, signature: 'journal-pointer-failure',
      run: async () => { await gate; return result({ commandSucceeded: true, exitCode: 0, marker: 'live-only-pointer-fixture' }); } });
    const file = recordFile(cfg, started.record.operationId);
    const receiptDirectory = path.dirname(file);
    const originalMkdir = fs.mkdirSync;
    try {
      lock.exec('BEGIN IMMEDIATE'); locked = true;
      release(); await started.record.promise;
      assert.equal(started.record.durability, 'journaled');
      const terminalJournal = fs.readFileSync(file, 'utf8');
      lock.exec('ROLLBACK'); locked = false;
      fs.mkdirSync = function(target, ...args) {
        if (normalizedPath(target) === normalizedPath(receiptDirectory)) {
          throw Object.assign(new Error('fixture pointer refresh unavailable'), { code: 'EACCES' });
        }
        return originalMkdir.call(this, target, ...args);
      };
      syncBuiltinESMExports();
      assert.equal(fallback.acknowledgeFallbackDelivery(cfg, started.record.operationId, {
        kind: 'result', operationId: started.record.operationId,
        status: started.record.status, revision: started.record.revision
      }), true);
      assert.equal(started.record.status, 'completed');
      assert.equal(started.record.durability, 'persisted');
      assert.equal(started.record.pointerRepairPending, true);
      assert.match(started.record.persistenceError, /pointer refresh unavailable/);
      assert.equal(started.record.result.structuredContent.operationPersistence, undefined);
      const canonical = canonicalOperation(directory, workId, started.record.operationId);
      assert.equal(canonical.status, 'completed');
      assert.equal(canonical.deliveryAcknowledged, true);
      assert.equal(canonical.result.commandSucceeded, true);
      assert.equal(canonical.result.exitCode, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), terminalJournal,
        'a failed pointer refresh must retain the complete older journal');
      fs.mkdirSync = originalMkdir; syncBuiltinESMExports();
      const live = lookup(cfg, workId, started.record.operationId);
      assert.equal(live.result.marker, 'live-only-pointer-fixture', 'pointer repair must preserve richer live result fields');
      await waitForPointer(file);
      assert.equal(started.record.pointerRepairPending, false);
      assert.equal(started.record.persistenceError, '');
      // Restore the same old journal to independently exercise restart recovery.
      fs.writeFileSync(file, terminalJournal);
      fallback.resetFallbackExecutions();
      const recovered = lookup(cfg, workId, started.record.operationId);
      assert.equal(recovered.status, 'completed');
      assert.equal(recovered.durability, 'persisted');
      assert.equal(recovered.result.commandSucceeded, true);
      assert.equal(recovered.result.exitCode, 0);
      await waitForPointer(file);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { operationId: started.record.operationId, workId });
      assert.equal(canonicalOperation(directory, workId, started.record.operationId).revision, canonical.revision,
        'pointer-only recovery must not rewrite canonical operation state');
      cases.push('canonical terminal commit stays durable after pointer failure and recovery retires its older journal');
    } finally {
      fs.mkdirSync = originalMkdir; syncBuiltinESMExports();
      release(); await Promise.allSettled([started.record.promise]);
      fallback.resetFallbackExecutions();
      if (locked) { try { lock.exec('ROLLBACK'); } catch {} }
      lock.close();
    }
  }

  // A newer working-session snapshot is not a physical commit. Pointer-only
  // repair must preserve the full journal until the actual worker write lands.
  {
    fallback.resetFallbackExecutions();
    const cfg = fixtureConfig('pending-canonical-pointer');
    const workId = 'journal-pending-canonical-task';
    const operationId = 'fallback_pending_canonical_pointer_000000001';
    const at = new Date().toISOString();
    const owner = { operationId, executionKey: workId, workId, tool: 'relai_read', workspace: 'app',
      noticeScope: scope, signature: 'pending-canonical-pointer', startedAt: at, updatedAt: at };
    const directory = seedTask(cfg, workId, { ...owner, status: 'running', revision: 5 });
    const journal = { ...owner, status: 'completed', revision: 6, completedAt: at, journalPending: true,
      result: { ok: true, commandSucceeded: true, exitCode: 0 } };
    const file = recordFile(cfg, operationId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const source = JSON.stringify(journal); fs.writeFileSync(file, source);
    const { recordTaskBackgroundOperation, flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
    const lock = openStateDatabase(cfg);
    let locked = false;
    try {
      lock.exec('BEGIN IMMEDIATE'); locked = true;
      const next = { ...journal }; delete next.journalPending;
      recordTaskBackgroundOperation(cfg, workId, { ...next, revision: 7, deliveryAcknowledged: true }, { defer: true });
      const selected = lookup(cfg, workId, operationId);
      assert.equal(selected.revision, 7, 'the lookup sees the newer pending working projection');
      assert.equal(selected.durability, 'memory_only', 'an uncommitted working revision cannot be reported as persisted');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(fs.readFileSync(file, 'utf8'), source, 'pending worker state cannot authorize deletion of the durable journal');
      assert.equal(canonicalOperation(directory, workId, operationId).status, 'running');
      lock.exec('ROLLBACK'); locked = false;
      await flushTaskHistoryPersistence();
      await waitForPointer(file);
      assert.equal(lookup(cfg, workId, operationId).durability, 'persisted');
      assert.equal(canonicalOperation(directory, workId, operationId).deliveryAcknowledged, true);
      cases.push('pointer repair waits for physical canonical commitment instead of trusting pending worker state');
    } finally {
      if (locked) { try { lock.exec('ROLLBACK'); } catch {} }
      fallback.resetFallbackExecutions();
      await flushTaskHistoryPersistence();
      lock.close();
    }
  }

  // Revision selection must not depend on file order, stale delivery metadata,
  // or converting malformed retained evidence into a new interrupted result.
  {
    fallback.resetFallbackExecutions();
    const cfg = fixtureConfig('revision-malformed');
    const workId = 'journal-revision-selection-task';
    const operationId = 'fallback_journal_revision_selection_000000001';
    const at = new Date().toISOString();
    const owner = { operationId, executionKey: workId, workId, tool: 'relai_read', workspace: 'app',
      noticeScope: scope, signature: 'journal-revision-selection', startedAt: at, updatedAt: at };
    const running = { ...owner, status: 'running', revision: 5 };
    const journal = { ...owner, status: 'failed', revision: 6, completedAt: at, isError: true,
      journalPending: true, result: { ok: false, commandSucceeded: false, exitCode: 6,
        errorCode: 'NEWER_JOURNAL_FIXTURE' } };
    const newerCanonical = { ...owner, status: 'failed', revision: 7, completedAt: at, isError: true,
      result: { ok: false, commandSucceeded: false, exitCode: 7, errorCode: 'NEWER_CANONICAL_FIXTURE' } };
    const file = recordFile(cfg, operationId);
    const directory = seedTask(cfg, workId, newerCanonical);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, JSON.stringify(journal));
      const canonicalSelected = lookup(cfg, workId, operationId);
      assert.equal(canonicalSelected.revision, 7);
      assert.equal(canonicalSelected.result.exitCode, 7);
      assert.equal(canonicalSelected.result.errorCode, 'NEWER_CANONICAL_FIXTURE');
      assert.equal(canonicalSelected.durability, 'persisted');
      await waitForPointer(file);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { operationId, workId });

      fallback.resetFallbackExecutions();
      seedTask(cfg, workId, running);
      fs.writeFileSync(file, JSON.stringify(journal));
      const journalSelected = lookup(cfg, workId, operationId);
      assert.equal(journalSelected.status, 'failed');
      assert.equal(journalSelected.revision, 6);
      assert.equal(journalSelected.result.exitCode, 6);
      assert.equal(journalSelected.result.errorCode, 'NEWER_JOURNAL_FIXTURE');
      assert.equal(journalSelected.durability, 'journaled');
      fallback.resetFallbackExecutions();

      for (const malformed of ['{"operationId":', JSON.stringify({ ...journal, operationId: 'wrong-operation-id' })]) {
        fs.writeFileSync(file, malformed);
        assert.throws(() => lookup(cfg, workId, operationId), error => error.code === 'FALLBACK_RECOVERY_UNAVAILABLE');
        assert.equal(fs.readFileSync(file, 'utf8'), malformed,
          'malformed retained bytes must survive a failed read');
        const retainedCanonical = canonicalOperation(directory, workId, operationId);
        assert.equal(retainedCanonical.status, 'running');
        assert.equal(retainedCanonical.revision, 5,
          'failed journal recovery must not synthesize or persist an interrupted transition');
      }
      fs.writeFileSync(file, JSON.stringify(journal));
      const repaired = lookup(cfg, workId, operationId);
      assert.equal(repaired.status, 'failed');
      assert.equal(repaired.result.exitCode, 6);
      assert.equal(repaired.result.errorCode, 'NEWER_JOURNAL_FIXTURE');
      cases.push('both revision directions select the newer receipt; malformed journals preserve bytes and fail closed');
    } finally { fallback.resetFallbackExecutions(); }
  }
}
  console.log(JSON.stringify({ ok: true, runtime: process.version, platform: process.platform, maxRssKiB: process.resourceUsage().maxRSS, cases }));
} catch (error) {
  console.error(JSON.stringify({ completedCases: cases, failure: error.stack }));
  throw error;
} finally {
  fallback.resetFallbackExecutions();
  const { flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
  await flushTaskHistoryPersistence();
}
