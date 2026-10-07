import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openStateDatabase, stateDatabasePath } from '../src/stateDatabase.ts';
import { relaiVerify } from '../src/bridge/validation.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.ts';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-progress-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
  name: 'validation-progress-fixture',
  scripts: {
    lint: 'node -e "process.exit(0)"',
    test: 'node -e "process.exit(0)"'
  }
}, null, 2));
spawnSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
spawnSync('git', ['config', 'user.email', 'test@example.test'], { cwd: workspace, stdio: 'ignore' });
spawnSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspace, stdio: 'ignore' });
spawnSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore' });
spawnSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

const pass = 'node -e "process.exit(0)"';
const fail = 'node -e "process.exit(1)"';
const slow = 'node -e "setTimeout(() => process.exit(0), 5000)"';

try {
  await verifyPolicyContention();
  const { callTool: rawCallTool } = await import('../src/tools.js');
  const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });
  const { getToolActivity, onToolActivity, resetToolActivity } = await import('../src/toolActivity.js');
  const { readTaskHistorySession } = await import('../src/taskHistoryStore.ts');
  const config = { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') };
  const events = [];
  const stopListening = onToolActivity(event => events.push(event));
  const context = { publicHttpOnly: true, transportType: 'test' };

  async function startTask(label) {
    resetToolActivity();
    events.length = 0;
    return callTool('relai_work', { action: 'begin', workspace: 'app', title: label }, context);
  }

  function sequence(taskId) {
    const values = events
      .filter(event => event.phase === 'progress' && event.taskId === taskId)
      .map(event => event.activityEvent?.metadata || {})
      .filter(metadata => Number.isInteger(metadata.passedCount) && Number.isInteger(metadata.failedCount) && Number.isInteger(metadata.checkCount))
      .map(metadata => `${metadata.passedCount + metadata.failedCount}/${metadata.checkCount}`);
    return values.filter((value, index) => index === 0 || value !== values[index - 1]);
  }

  async function cancel(taskId, reason = 'Test cleanup') {
    return callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: taskId, reason }, context);
  }

  const successTask = await startTask('Two successful checks');
  events.length = 0;
  const success = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: successTask.work_id, checks: [pass, 'node -e "console.log(\'second\')"'], complete: false
  }, context);
  assert.equal(success.ok, true);
  assert.deepEqual(sequence(successTask.work_id), ['0/2', '1/2', '2/2']);
  assert.equal(success.completedUnits, 2);
  assert.equal(success.totalUnits, 2);
  await cancel(successTask.work_id);

  const stopTask = await startTask('Stop on first failure');
  events.length = 0;
  const stopped = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: stopTask.work_id, checks: [fail, pass], stopOnFailure: true
  }, context);
  assert.equal(stopped.validationStatus, 'failed');
  assert.equal(stopped.completedUnits, 1);
  assert.equal(stopped.totalUnits, 2);
  assert.equal(stopped.failedCheck, fail);
  assert.deepEqual(sequence(stopTask.work_id), ['0/2', '1/2']);
  await cancel(stopTask.work_id);

  const continueTask = await startTask('Continue after failure');
  events.length = 0;
  const continued = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: continueTask.work_id, checks: [fail, pass], stopOnFailure: false
  }, context);
  assert.equal(continued.validationStatus, 'failed');
  assert.equal(continued.completedUnits, 2);
  assert.equal(continued.totalUnits, 2);
  assert.deepEqual(sequence(continueTask.work_id), ['0/2', '1/2', '2/2']);
  const continuedTask = getToolActivity().tasks.find(task => task.taskId === continueTask.work_id);
  assert.notEqual(continuedTask.progress.percentage, 100, 'failed validation must not present as successful 100% completion');
  await cancel(continueTask.work_id);

  const lastFailureTask = await startTask('Failure on last check');
  events.length = 0;
  const lastFailure = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: lastFailureTask.work_id, checks: [pass, fail]
  }, context);
  assert.equal(lastFailure.validationStatus, 'failed');
  assert.equal(lastFailure.completedUnits, 2);
  assert.equal(lastFailure.failedCheck, fail);
  assert.deepEqual(sequence(lastFailureTask.work_id), ['0/2', '1/2', '2/2']);
  await cancel(lastFailureTask.work_id);

  const duplicateTask = await startTask('Duplicate checks');
  events.length = 0;
  const deduplicated = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: duplicateTask.work_id, checks: [pass, pass], complete: false
  }, context);
  assert.equal(deduplicated.totalUnits, 1);
  assert.equal(deduplicated.skippedChecks.length, 1);
  assert.equal(deduplicated.skippedChecks[0].reason, 'duplicate');
  assert.deepEqual(sequence(duplicateTask.work_id), ['0/1', '1/1']);
  await cancel(duplicateTask.work_id);

  const planTask = await startTask('Dynamic validation plan');
  events.length = 0;
  const planned = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: planTask.work_id, level: 'standard', complete: false
  }, context);
  assert.ok(planned.totalUnits > 0);
  assert.equal(sequence(planTask.work_id).at(0), `0/${planned.totalUnits}`);
  assert.equal(sequence(planTask.work_id).at(-1), `${planned.completedUnits}/${planned.totalUnits}`);
  await cancel(planTask.work_id);

  const timeoutTask = await startTask('Timed-out check');
  events.length = 0;
  const timedOut = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: timeoutTask.work_id, checks: [slow], timeoutMs: 1000
  }, context);
  assert.equal(timedOut.validationStatus, 'failed');
  assert.equal(timedOut.results[0].timedOut, true);
  assert.equal(timedOut.cancelled, false);
  assert.equal(timedOut.timedOut, true);
  assert.notEqual(getToolActivity().tasks.find(task => task.taskId === timeoutTask.work_id).progress.percentage, 100, 'timed-out validation must not present as successful 100% completion');
  await cancel(timeoutTask.work_id);


  const lateDeadlineTask = await startTask('Deadline after successful check');
  const lateDeadlineController = new AbortController();
  const stopDeadlineListener = onToolActivity(event => {
    if (event.taskId === lateDeadlineTask.work_id && event.phase === 'progress'
        && event.activityEvent?.metadata?.passedCount === 1) {
      lateDeadlineController.abort(new DOMException('Deadline before final verification.', 'TimeoutError'));
    }
  });
  let lateDeadline;
  try {
    lateDeadline = await callTool('relai_validate', { action: 'checks',
      workspace: 'app', work_id: lateDeadlineTask.work_id, checks: [pass]
    }, { ...context, signal: lateDeadlineController.signal });
  } finally {
    stopDeadlineListener();
  }
  assert.equal(lateDeadlineController.signal.aborted, true, 'fixture must interrupt after the successful check');
  assert.equal(lateDeadline.results[0].ok, true, 'completed child evidence stays truthful');
  assert.equal(lateDeadline.ok, false, 'an aborted aggregate must not claim successful final verification');
  assert.equal(lateDeadline.validationStatus, 'failed');
  assert.equal(lateDeadline.timedOut, true);
  assert.equal(lateDeadline.cancelled, false);
  await cancel(lateDeadlineTask.work_id);


  const inheritedTask = await startTask('Inherited validation deadline');
  const inheritedTimeout = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: inheritedTask.work_id, checks: [slow], timeoutMs: 10000
  }, { ...context, deadlineAtMs: Date.now() + 1000 });
  assert.equal(inheritedTimeout.validationStatus, 'failed');
  assert.equal(inheritedTimeout.timedOut, true);
  assert.equal(inheritedTimeout.cancelled, false);
  assert.equal(inheritedTimeout.results[0].timedOut, true);
  assert.notEqual(inheritedTimeout.results[0].cancelled, true);
  assert.equal(inheritedTimeout.results[0].terminationConfirmed, true);
  await cancel(inheritedTask.work_id);

  const cancelledTask = await startTask('Cancelled validation');
  events.length = 0;
  const runningCancellation = callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: cancelledTask.work_id, checks: [slow], timeoutMs: 10000
  }, context);
  // Observe a fast cancellation rejection immediately so Node does not treat the
  // expected concurrent promise as unhandled before the assertion below awaits it.
  void runningCancellation.catch(() => {});
  // Queue admission also publishes the task's one-step plan progress. Wait for
  // the validation check itself so this case exercises active cancellation.
  await waitFor(() => events.some(event => event.phase === 'progress'
    && event.taskId === cancelledTask.work_id
    && event.activityEvent?.metadata?.resultStatus === 'running'
    && event.activityEvent?.metadata?.currentCheck === slow
    && event.activityEvent?.metadata?.checkCount === 1));
  const cancellation = await cancel(cancelledTask.work_id, 'Cancel active validation');
  assert.equal(cancellation.status, 'cancelling', 'active validation must settle before task cancellation becomes terminal');
  assert.equal(cancellation.endedAt, undefined, 'nonterminal cancellation must not publish a terminal timestamp');
  const cancelledValidation = await runningCancellation;
  assert.equal(cancelledValidation.validationStatus, 'cancelled');
  assert.notEqual(cancelledValidation.timedOut, true);
  assert.equal(cancelledValidation.completedUnits, 0);
  assert.equal(cancelledValidation.totalUnits, 1);
  const terminalCancellation = await cancel(cancelledTask.work_id, 'Confirm cancelled validation');
  assert.equal(terminalCancellation.status, 'cancelled');
  assert.ok(terminalCancellation.endedAt);
  const cancelledHistory = readTaskHistorySession(config, cancelledTask.work_id);
  assert.equal(cancelledHistory.status, 'cancelled');
  assert.notEqual(cancelledHistory.progress.percentage, 100);

  const parallelReadTask = await startTask('Validation does not block same-task reads');
  events.length = 0;
  let parallelValidationSettled = false;
  const parallelValidation = callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: parallelReadTask.work_id,
    checks: ['node -e "setTimeout(() => process.exit(0), 1000)"'], complete: false
  }, context).finally(() => { parallelValidationSettled = true; });
  await waitFor(() => events.some(event => event.phase === 'progress' && event.taskId === parallelReadTask.work_id));
  const parallelRead = await callTool('relai_read', {
    workspace: 'app', work_id: parallelReadTask.work_id, paths: ['package.json'], guidanceMode: 'none'
  }, context);
  assert.equal(parallelRead.ok, true);
  assert.equal(parallelValidationSettled, false, 'same-task observation must not wait behind a running validation');
  assert.equal((await parallelValidation).validationStatus, 'passed');
  await cancel(parallelReadTask.work_id);

  const atomicTask = await startTask('Atomic validation completion');
  events.length = 0;
  const atomic = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: atomicTask.work_id, checks: [pass, pass], complete: true,
    summary: 'Validated and completed without credential data.'
  }, context);
  assert.equal(atomic.completionKnown, true);
  assert.equal(getToolActivity().lastTask.status, 'completed');
  assert.equal(getToolActivity().lastTask.progress.percentage, 100);

  const reconnectTask = await startTask('Recover validation state after reconnect');
  events.length = 0;
  const reconnectValidation = await callTool('relai_validate', { action: 'checks',
    workspace: 'app', work_id: reconnectTask.work_id,
    checks: [pass, pass], complete: false
  }, context);
  assert.equal(reconnectValidation.validationStatus, 'passed');
  resetToolActivity();
  const recoveredStatus = await callTool('relai_work', {
    action: 'status', work_id: reconnectTask.work_id
  }, context);
  assert.equal(recoveredStatus.task.status, 'planning');
  assert.equal(recoveredStatus.task.validation, 'passed');
  assert.match(recoveredStatus.task.current?.activity || '', /Step 1 of 1: Recover validation state after reconnect/i,
    'recovered planned tasks must keep their plan as the current activity after validation completes');
  assert.equal(recoveredStatus.task.recentEvidence?.some(item => item.tool === 'relai_validate' && item.outcome === 'succeeded'), true);
  await cancel(reconnectTask.work_id, 'End reconnect test');

  stopListening();
  resetToolActivity();
  console.log('Validation progress reports honest live, failure, timeout, cancellation, plan, persistence, and completion sequences.');
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await repositoryIntelligence.shutdown();
  await flushLocalAnalytics();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
}


async function verifyPolicyContention() {
  const corruptConfig = { stateDir: path.join(temp, 'policy-contention-corrupt') };
  fs.mkdirSync(corruptConfig.stateDir);
  fs.writeFileSync(stateDatabasePath(corruptConfig), 'not a sqlite database');
  const corruptMarker = path.join(temp, 'policy-check-corrupt');
  const corruptCommand = 'node -e ' + JSON.stringify('require("node:fs").writeFileSync(' + JSON.stringify(corruptMarker) + ',"ran")');
  const corruptStarted = Date.now();
  await assert.rejects(
    relaiVerify({ alias: 'app', path: workspace }, corruptConfig, { checks: [corruptCommand] }),
    error => error.errcode === 26,
    'non-busy SQLite errors must propagate without retry or replacement'
  );
  assert.ok(Date.now() - corruptStarted < 250, 'non-busy errors must not consume the busy retry budget');
  assert.equal(fs.existsSync(corruptMarker), false, 'a non-busy policy error must not launch a check');

  for (const mode of ['reader-release', 'transient', 'deadline', 'abort', 'held', 'expired']) {
    const config = { stateDir: path.join(temp, 'policy-contention-' + mode) };
    const database = openStateDatabase(config);
    database.exec('PRAGMA journal_mode=DELETE');
    database.close();
    const writer = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      parentPort.once('message', delay => {
        // This transaction only holds a lock. COMMIT would need an exclusive
        // lock in DELETE mode and can fail while policy initialization reads.
        setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, delay);
      });
    `, { eval: true, execArgv: [], workerData: stateDatabasePath(config) });
    const workerDeadline = AbortSignal.timeout(5000);
    const exited = once(writer, 'exit', { signal: workerDeadline });
    // Observe failures immediately; the awaited promise below still reports them.
    void exited.catch(() => {});
    try {
      assert.deepEqual(await once(writer, 'message', { signal: workerDeadline }), ['locked']);
      if (mode === 'reader-release') {
        const reader = new DatabaseSync(stateDatabasePath(config));
        try {
          reader.exec('BEGIN');
          const query = reader.prepare('SELECT key, value FROM state_meta ORDER BY key');
          const before = query.all();
          assert.ok(before.length > 0, 'the regression must hold a real shared read lock');
          writer.postMessage(0);
          assert.deepEqual(await exited, [0], 'the lock-only writer must release while a reader is active');
          assert.deepEqual(query.all(), before, 'releasing the lock must preserve the reader snapshot');
          reader.exec('COMMIT');
        } finally {
          reader.close();
        }
        continue;
      }
      const marker = path.join(temp, 'policy-check-' + mode);
      const command = 'node -e ' + JSON.stringify('require("node:fs").writeFileSync(' + JSON.stringify(marker) + ',"ran")');
      const controller = new AbortController();
      const abortReason = new Error('Stop policy contention');
      const context = { signal: controller.signal };
      if (mode === 'deadline') context.deadlineAtMs = Date.now() + 60;
      if (mode === 'expired') context.deadlineAtMs = Date.now() - 1;
      let timerFired = false;
      const serviceTimer = setTimeout(() => { timerFired = true; }, 10);
      const abortTimer = mode === 'abort' ? setTimeout(() => controller.abort(abortReason), 30) : null;
      if (mode === 'transient') writer.postMessage(150);
      const started = Date.now();
      try {
        const result = relaiVerify({ alias: 'app', path: workspace }, config, { checks: [command] }, context);
        if (mode === 'transient') {
          assert.equal((await result).ok, true, 'validation must recover after transient policy initialization contention');
          assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
          assert.ok(timerFired, 'SQLite policy waiting must yield to service timers');
        } else {
          await assert.rejects(result, error => mode === 'abort'
            ? error === abortReason
            : mode === 'held'
              ? error.errcode === 5 || error.code === 'SQLITE_BUSY'
              : error.name === 'TimeoutError');
          assert.equal(fs.existsSync(marker), false, 'policy failure must not launch a check');
          assert.ok(Date.now() - started < (mode === 'held' ? 1500 : 250), 'contention must honor its deadline and cancellation bound');
          if (mode === 'held') assert.ok(Date.now() - started >= 900, 'persistent contention must exhaust only the bounded asynchronous budget');
        }
      } finally {
        clearTimeout(serviceTimer);
        if (abortTimer) clearTimeout(abortTimer);
      }
      if (mode !== 'transient') writer.postMessage(0);
      assert.deepEqual(await exited, [0], 'the policy contention fixture must exit cleanly');
    } finally {
      await writer.terminate();
    }
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for validation progress.');
}
