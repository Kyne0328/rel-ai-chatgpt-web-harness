import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';

import {
  DEFAULT_FALLBACK_GRACE_MS,
  acknowledgeFallbackCompletionDelivery,
  acknowledgeFallbackCompletionNotice,
  cancelFallbackExecution,
  assertFallbackCompletionAvailable,
  peekFallbackCompletionNotices,
  enableFallbackCompletionNotice,
  fallbackExecutionStatus,
  fallbackExecutionsStatus,
  resetFallbackExecutions,
  startFallbackExecution,
  updateFallbackExecutionPhase
} from '../src/mcp/fallbackExecutions.js';
import { relaiExec } from '../src/bridge/exec.js';
import { readOutputSpill } from '../src/outputSpill.js';
import { MCP_PROTOCOL_VERSION } from '../src/mcp/protocol.js';
import { toolResult } from '../src/mcp/results.js';
import { enrichWithFallbackCompletions } from '../src/mcp/toolInvocation.js';
import { executeToolCall } from '../src/tools/execution.js';
import { validateToolOutput } from '../src/tools/outputValidation.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { runWorkspaceOperation } from '../src/workspaceOperationQueue.js';
import { createHttpPrincipal, createStdioPrincipal, principalFingerprint } from '../src/mcp/principal.ts';
import { toolContext } from '../src/mcp/context.js';
import { acknowledgeMcpFallbackCompletionDelivery, beginMcpRequest, finishMcpRequest } from '../src/core/mcp-runtime.ts';
import { createFallbackAwareStdioTransport, handleTransportFallbackRequest } from '../src/mcp/transportFallback.ts';
import {
  readTaskHistorySessionRecord,
  recordTaskBackgroundOperation,
  recordTaskHistoryEvent
} from '../src/taskHistoryStore.ts';

function message(id, workId, command = 'node test.js', timeoutMs = 60_000) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'relai_exec',
      arguments: {
        workspace: 'app',
        ...(workId ? { work_id: workId } : {}),
        command,
        timeoutMs
      },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  };
}

function readMessage(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'relai_read',
      arguments: { workspace: 'app', paths: ['README.md'] },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  };
}

function processStartMessage(id) {
  const request = readMessage(id);
  request.params.name = 'relai_process';
  request.params.arguments = {
    action: 'start',
    workspace: 'app',
    command: 'node server.js',
    kind: 'service',
    purpose: 'Exercise resilient persistent-process startup.'
  };
  return request;
}

function workStatusMessage(id, args = {}) {
  const request = readMessage(id);
  request.params.name = 'relai_work';
  request.params.arguments = { action: 'status', workspace: 'app', ...args };
  return request;
}

function workBeginMessage(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: 'relai_work',
      arguments: {
        action: 'begin',
        workspace: 'app',
        title: 'Replay-safe start',
        objective: 'Prove a lost work.begin response does not create a duplicate task.'
      },
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  };
}

function completedResult(workId, stdout = 'done') {
  return toolResult({
    ok: true,
    executed: true,
    commandSucceeded: true,
    workspace: 'app',
    work_id: workId,
    durationMs: 25,
    exitCode: 0,
    stdout
  }, false);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function seedTask(config, taskId) {
  recordTaskHistoryEvent(config, {
    taskId,
    taskIdentityVersion: 2,
    taskIdExplicit: true,
    taskHistoryEligible: true,
    eventType: 'task.started',
    tool: 'work.begin',
    workspace: 'app',
    ok: true,
    ts: new Date().toISOString()
  });
}

const transientSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-fallback-transient-'));
const transientConfig = { stateDir: transientSandbox, auditLogPath: path.join(transientSandbox, 'audit.jsonl') };

assert.equal(DEFAULT_FALLBACK_GRACE_MS, 1_000, 'background fallback should detach quickly instead of holding the connector open');
resetFallbackExecutions();
await testTerminalElapsedClocks();
await testCompletionReceiptIsolation();

const phaseStartedAt = Date.now();
const phaseExecution = startFallbackExecution({
  config: transientConfig,
  scopeId: 'phase-status-test',
  tool: 'relai_exec',
  workspace: 'app',
  signature: 'phase-status-signature',
  deadlineAtMs: phaseStartedAt + 10_000,
  persist: false,
  now: () => phaseStartedAt,
  run: async () => {
    await delay(50);
    return completedResult('', 'phase-complete');
  }
});
const startingPhase = fallbackExecutionStatus(phaseExecution.record.operationId, { now: () => phaseStartedAt + 100 });
assert.equal(startingPhase.phase, 'starting');
assert.equal(startingPhase.elapsedMs, 100);
assert.equal(startingPhase.remainingMs, 9_900);
updateFallbackExecutionPhase(phaseExecution.record.operationId, 'queued', transientConfig);
assert.equal(fallbackExecutionStatus(phaseExecution.record.operationId).phase, 'queued');
updateFallbackExecutionPhase(phaseExecution.record.operationId, 'preparing', transientConfig);
assert.equal(fallbackExecutionStatus(phaseExecution.record.operationId).phase, 'preparing');
await phaseExecution.record.promise;

// Compact status is the control plane for existing background work. It must
// remain on the normal request path, including when callers bound result bytes.
for (const [index, args] of [
  {},
  { detail: 'compact' },
  { detail: 'compact', maxBytes: 10000 },
  { operationId: 'fallback_unknown_status_fixture_12345', maxBytes: 10000 }
].entries()) {
  let executions = 0;
  const result = await handleTransportFallbackRequest(transientConfig, workStatusMessage(800 + index, args), {
    principal: 'principal-status',
    transportType: 'streamable-http',
    synchronousFallbackGraceMs: 50,
    executeToolResult: async () => {
      executions += 1;
      return toolResult({ ok: true, workspace: { alias: 'app' } }, false);
    }
  });
  assert.equal(result, null, 'compact status must not create a fallback operation');
  assert.equal(executions, 0, 'ineligible compact status belongs to the normal transport handler');
}
let fullStatusExecutions = 0;
const fullStatus = await handleTransportFallbackRequest(transientConfig, workStatusMessage(810, { detail: 'full', maxBytes: 10000 }), {
  principal: 'principal-status',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: async () => {
    fullStatusExecutions += 1;
    return toolResult({ ok: true, workspace: { alias: 'app' } }, false);
  }
});
assert.equal(fullStatus.body.result.structuredContent.ok, true);
assert.equal(fullStatusExecutions, 1, 'explicit full status retains resilient transport behavior');
fullStatus.onDelivered?.();

const fastWorkId = 'work_fast_fallback_test';
const fast = await handleTransportFallbackRequest(transientConfig, message(1, fastWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 50,
  executeToolResult: async () => completedResult(fastWorkId, 'fast')
});
assert.equal(fast.body.result.isError, false);
assert.equal(fast.body.result.structuredContent.exitCode, 0);
assert.equal(fast.body.result.structuredContent.stdout, 'fast');

const boundedExecWorkId = 'work_bounded_exec_test';
let boundedExecRuns = 0;
const boundedExec = await handleTransportFallbackRequest(transientConfig, message(2, boundedExecWorkId, 'node --version', 15_000), {
  principal: 'principal-bounded-exec',
  transportType: 'test',
  synchronousBounds: { maxDurationMs: 30_000 },
  executeToolResult: async () => {
    boundedExecRuns += 1;
    return completedResult(boundedExecWorkId, 'bounded-direct');
  }
});
assert.equal(boundedExecRuns, 1);
assert.equal(boundedExec.body.result.structuredContent.stdout, 'bounded-direct');
assert.notEqual(boundedExec.body.result.structuredContent.status, 'running', 'a single 15-second bounded exec must stay synchronous inside a 30-second transport budget');

const explicitDeadlineStarted = Date.now();
const explicitDeadline = await handleTransportFallbackRequest(transientConfig, message(4, '', 'node deadline.js', 1000), {
  principal: 'principal-explicit-deadline',
  transportType: 'test',
  synchronousBounds: { maxDurationMs: 7000 },
  executeToolResult: async (_config, _name, _args, options) => {
    if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    return toolResult({
      ok: true,
      executed: false,
      commandSucceeded: false,
      terminationConfirmed: true,
      mutationTracking: 'cancelled-before-execution',
      mutationUnknown: false,
      timedOut: true,
      error: 'Timed out after 1000ms'
    }, false);
  }
});
assert.ok(Date.now() - explicitDeadlineStarted < 2500, 'an explicit command timeout must not receive an extra cleanup grace before transport cancellation');
assert.equal(explicitDeadline.body.result.isError, false, 'a settled handler timeout result must not be replaced by a generic transport error');
assert.equal(explicitDeadline.body.result.structuredContent.executed, false);
assert.equal(explicitDeadline.body.result.structuredContent.timedOut, true);
assert.equal(explicitDeadline.body.result.structuredContent.terminationConfirmed, true);
assert.equal(explicitDeadline.body.result.structuredContent.mutationUnknown, false);
assert.equal(Object.hasOwn(explicitDeadline.body.result.structuredContent, 'errorCode'), false);

const preExecutionAbort = new AbortController();
preExecutionAbort.abort(new DOMException('Execution deadline expired.', 'TimeoutError'));
const preExecutionResult = await relaiExec(
  { alias: 'app', path: transientSandbox, commands: {}, testCommands: {} },
  transientConfig,
  { executable: process.execPath, argv: ['--version'], timeoutMs: 1000 },
  {
    signal: preExecutionAbort.signal,
    deadlineAtMs: Date.now() - 1,
    mutationTrackingRequired: true
  }
);
assert.equal(preExecutionResult.executed, false);
assert.equal(preExecutionResult.timedOut, true);
assert.equal(preExecutionResult.terminationConfirmed, true);
assert.equal(preExecutionResult.mutationTracking, 'cancelled-before-execution');
assert.equal(preExecutionResult.mutationUnknown, false, 'a command that never started cannot leave unknown workspace mutations');

// Exec cleanup can outlive request cancellation without implying that a mutating
// subprocess survived. The process-specific ownership/result checks decide
// quarantine for exec; the generic in-process mutation watchdog must not poison
// the workspace merely because cleanup takes longer than its grace period.
const originalSetTimeout = globalThis.setTimeout;
const watchdogController = new AbortController();
let watchdogHandlerStartedResolve;
const watchdogHandlerStarted = new Promise(resolve => { watchdogHandlerStartedResolve = resolve; });
try {
  globalThis.setTimeout = (callback, ms, ...args) => originalSetTimeout(callback, Number(ms) === 15_000 ? 5 : ms, ...args);
  const watchdogExecution = executeToolCall({
    config: transientConfig,
    name: 'relai_exec',
    executionName: OP.EXEC,
    effectiveArgs: { workspace: 'watchdog-exec', command: 'node mutation.js', timeoutMs: 60_000 },
    context: { signal: watchdogController.signal, requestId: 'watchdog_exec_cleanup_test' },
    finishActivity: null,
    definition: {
      annotations: { readOnlyHint: false },
      behavior: { concurrencyScope: 'mutation', longRunning: true },
      handler: async (_config, _args, handlerContext) => {
        watchdogHandlerStartedResolve();
        if (!handlerContext.signal.aborted) {
          await new Promise(resolve => handlerContext.signal.addEventListener('abort', resolve, { once: true }));
        }
        await new Promise(resolve => originalSetTimeout(resolve, 25));
        return { ok: true };
      }
    },
    workspaceOverride: { alias: 'watchdog-exec', path: transientSandbox, directFilesystem: true }
  });
  await watchdogHandlerStarted;
  watchdogController.abort(new DOMException('Execution deadline expired.', 'TimeoutError'));
  await watchdogExecution;
} finally {
  globalThis.setTimeout = originalSetTimeout;
}
const postCleanupMutation = await runWorkspaceOperation('watchdog-exec', async () => 'released', {
  mode: 'write', scope: 'mutation', taskId: 'after-watchdog'
});
assert.equal(postCleanupMutation, 'released', 'slow exec cleanup with no surviving process must not quarantine later mutations');

const inheritedValidationDeadlineStarted = Date.now();
let inheritedValidationDeadlineObserved = false;
await executeToolCall({
  config: transientConfig,
  name: 'relai_validate',
  executionName: OP.VALIDATE_CHECKS,
  effectiveArgs: { workspace: 'app', timeoutMs: 60_000 },
  context: {
    backgroundFallbackExecution: true,
    deadlineAtMs: inheritedValidationDeadlineStarted + 1000,
    requestId: 'fallback_validation_deadline_test'
  },
  finishActivity: null,
  definition: {
    annotations: { readOnlyHint: true },
    behavior: { concurrencyScope: 'task', longRunning: true },
    handler: async (_config, _args, handlerContext) => {
      if (!handlerContext.signal.aborted) {
        await Promise.race([
          new Promise(resolve => handlerContext.signal.addEventListener('abort', resolve, { once: true })),
          delay(2000)
        ]);
      }
      inheritedValidationDeadlineObserved = handlerContext.signal.aborted;
      return { ok: true };
    }
  },
  workspaceOverride: { alias: 'app', path: transientSandbox, directFilesystem: true }
});
assert.equal(inheritedValidationDeadlineObserved, true, 'background validation must inherit and enforce the fallback operation deadline');
assert.ok(Date.now() - inheritedValidationDeadlineStarted < 2500, 'background validation must not continue after its inherited deadline');

// Bounded transport cleanup must not erase process safety diagnostics.
for (const [index, mode] of ['uncertain', 'confirmed', 'late_success', 'external_abort'].entries()) {
  const externalAbort = mode === 'external_abort';
  const confirmed = mode === 'confirmed';
  const controller = new AbortController();
  let handlerReturned = false;
  const response = await handleTransportFallbackRequest(transientConfig, message(920 + index, '', 'node diagnostic.js', 1000), {
    principal: 'principal-bounded-diagnostics',
    transportType: 'test',
    synchronousBounds: { maxDurationMs: 50 },
    signal: controller.signal,
    executeToolResult: async (_config, _name, _args, options) => {
      if (externalAbort) setTimeout(() => controller.abort(new Error('caller cancelled')), 5);
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      assert.equal(options.signal.reason.name, externalAbort ? 'Error' : 'TimeoutError');
      handlerReturned = true;
      return toolResult({
        ok: mode === 'late_success', status: 'completed', commandSucceeded: mode === 'late_success',
        terminationConfirmed: confirmed, mutationUnknown: !confirmed,
        error: 'original diagnostic', errorCode: 'HANDLER_DIAGNOSTIC',
        stdout: 'partial stdout', stderr: 'partial stderr', stdoutOutputRef: 'spill_diagnostic_fixture'
      }, mode !== 'late_success');
    }
  });
  const diagnostics = response.body.result.structuredContent;
  assert.equal(handlerReturned, true);
  assert.equal(response.body.result.isError, true);
  assert.equal(diagnostics.ok, false, 'late successful cleanup cannot reverse a transport timeout');
  assert.equal(diagnostics.commandSucceeded, false);
  assert.equal(diagnostics.errorCode, externalAbort ? 'EXECUTION_ABORTED' : 'SYNCHRONOUS_EXECUTION_TIMEOUT');
  assert.equal(diagnostics.terminationConfirmed, confirmed, 'bounded cleanup must preserve termination evidence');
  assert.equal(diagnostics.mutationUnknown, !confirmed);
  assert.equal(diagnostics.stdout, 'partial stdout');
  assert.equal(diagnostics.stderr, 'partial stderr');
  assert.equal(diagnostics.stdoutOutputRef, 'spill_diagnostic_fixture');
  assert.equal(diagnostics.handlerError, 'original diagnostic');
  assert.equal(diagnostics.handlerErrorCode, 'HANDLER_DIAGNOSTIC');
  assert.equal(diagnostics.timedOut, !externalAbort);
  assert.equal(diagnostics.cancelled, externalAbort);
  assert.notEqual(diagnostics.status, 'completed');
  assert.equal(diagnostics.cleanupPending, false);
}
// A settled result may omit process termination fields without implying a live
// subprocess. Preserve explicit mutation/cancellation facts and before-spawn state.
for (const [index, mode] of ['no_termination_fields', 'pre_aborted', 'handler_cancelled'].entries()) {
  const controller = new AbortController();
  const beforeExecution = mode === 'pre_aborted';
  if (beforeExecution) controller.abort(new Error('cancelled before execution'));
  const response = await handleTransportFallbackRequest(transientConfig, message(930 + index, '', 'node diagnostic.js', 1000), {
    principal: 'principal-bounded-diagnostics', transportType: 'test',
    synchronousBounds: { maxDurationMs: 50 }, signal: controller.signal,
    executeToolResult: async (_config, _name, _args, options) => {
      if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return toolResult({
        ok: !beforeExecution, commandSucceeded: !beforeExecution,
        executed: !beforeExecution, mutationUnknown: false,
        ...(mode === 'handler_cancelled' || beforeExecution ? { cancelled: true } : {})
      }, beforeExecution);
    }
  });
  const diagnostics = response.body.result.structuredContent;
  assert.equal(response.body.result.isError, true);
  assert.equal(diagnostics.commandSucceeded, false);
  assert.equal(diagnostics.mutationUnknown, false, 'explicit handler mutation facts must survive');
  assert.equal(Object.hasOwn(diagnostics, 'terminationConfirmed'), false, 'missing termination evidence must not be invented for a settled result');
  assert.equal(diagnostics.cancelled, mode === 'handler_cancelled' || beforeExecution);
  assert.equal(diagnostics.timedOut, !beforeExecution);
  assert.doesNotMatch(response.body.result.content[0].text, /may still be in progress/);
  if (beforeExecution) {
    assert.equal(diagnostics.executed, false);
    assert.match(response.body.result.content[0].text, /did not start/);
  }
}

for (const [index, mode] of ['unsafe_exec_cancelled', 'unsafe_exec_timeout', 'resilient_read_cancelled'].entries()) {
  let calls = 0;
  const timedOut = mode === 'unsafe_exec_timeout';
  const reason = new DOMException('Request ended before admission.', timedOut ? 'TimeoutError' : 'AbortError');
  const request = mode === 'resilient_read_cancelled'
    ? readMessage(950 + index)
    : message(950 + index, '', 'node never-admitted.js', 60000);
  const fallbackDirectory = path.join(transientConfig.stateDir, 'fallback-executions');
  const persistedFallbackFiles = () => fs.existsSync(fallbackDirectory) ? fs.readdirSync(fallbackDirectory).sort() : [];
  const before = persistedFallbackFiles();
  const response = await handleTransportFallbackRequest(transientConfig, request, {
    principal: 'principal-pre-admission', transportType: 'streamable-http',
    synchronousFallbackGraceMs: 0, signal: AbortSignal.abort(reason),
    executeToolResult: async () => { calls += 1; return toolResult({ ok: true, executed: true }, false); }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0, 'already cancelled detached admission must not invoke even a deferred handler');
  const result = response.body.result.structuredContent;
  assert.equal(response.body.result.isError, true);
  assert.equal(result.executed, false);
  assert.equal(result.cancelled, !timedOut);
  assert.equal(result.timedOut, timedOut);
  assert.equal(result.terminationConfirmed, true);
  assert.equal(result.mutationUnknown, false);
  assert.equal(result.operationId, undefined);
  assert.deepEqual(persistedFallbackFiles(), before, 'rejected admission must not add a persisted background record');
  // Resilient persist:false admission is covered by the handler call count, not disk state.
}

const cleanupWaitStarted = Date.now();
const cleanupExpired = await handleTransportFallbackRequest(transientConfig, message(924, '', 'node uncooperative.js', 1000), {
  principal: 'principal-bounded-diagnostics',
  transportType: 'test',
  synchronousBounds: { maxDurationMs: 25 },
  executeToolResult: async () => new Promise(() => {})
});
assert.ok(Date.now() - cleanupWaitStarted < 8000, 'cleanup must remain bounded by the existing five-second grace');
const unknownCleanup = cleanupExpired.body.result.structuredContent;
assert.equal(unknownCleanup.errorCode, 'SYNCHRONOUS_EXECUTION_TIMEOUT');
assert.equal(unknownCleanup.terminationConfirmed, false);
assert.equal(unknownCleanup.mutationUnknown, true);
assert.equal(unknownCleanup.cleanupPending, true);
assert.equal(unknownCleanup.commandSucceeded, false);
assert.match(cleanupExpired.body.result.content[0].text, /not confirmed/i);

const longBoundedWorkId = 'work_long_bounded_fallback_test';
const longBounded = await handleTransportFallbackRequest(transientConfig, message(3, longBoundedWorkId, 'node slow.js', 26_000), {
  principal: 'principal-long-bounded',
  transportType: 'test',
  synchronousBounds: { maxDurationMs: 30_000 },
  synchronousFallbackGraceMs: 5,
  executeToolResult: async () => {
    await delay(50);
    return completedResult(longBoundedWorkId, 'long-fallback');
  }
});
assert.equal(longBounded.body.result.structuredContent.status, 'running', 'a command whose timeout cannot fit with transport cleanup must use fallback');
assert.equal(longBounded.body.result.structuredContent.phase, 'starting');
assert.equal(Object.hasOwn(longBounded.body.result.structuredContent, 'pollAfterMs'), false, 'fallback acknowledgement must not prompt the agent to poll');
assert.ok(longBounded.body.result.structuredContent.deadlineAt, 'fallback status must expose the original command deadline');
assert.ok(longBounded.body.result.structuredContent.remainingMs > 0 && longBounded.body.result.structuredContent.remainingMs <= 26_000);
await delay(60);

const deliveredWorkId = 'work_delivered_fallback_test';
let deliveredWorkExecutions = 0;
const deliveredWorkExecute = async () => {
  deliveredWorkExecutions += 1;
  return completedResult(deliveredWorkId, `delivered-${deliveredWorkExecutions}`);
};
const deliveredWork = await handleTransportFallbackRequest(transientConfig, message(900, deliveredWorkId), {
  principal: 'principal-delivered-work',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredWorkExecute
});
assert.equal(deliveredWorkExecutions, 1);
assert.equal(typeof deliveredWork.onDelivered, 'function');
deliveredWork.onDelivered();
const freshDeliveredWork = await handleTransportFallbackRequest(transientConfig, message(901, deliveredWorkId), {
  principal: 'principal-delivered-work',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredWorkExecute
});
assert.equal(deliveredWorkExecutions, 2, 'a confirmed work-bound result must not be replayed as a fresh rerun');
assert.equal(freshDeliveredWork.body.result.structuredContent.stdout, 'delivered-2');
freshDeliveredWork.onDelivered();

const deliveredFailureWorkId = 'work_delivered_failure_fallback_test';
let deliveredFailureExecutions = 0;
const deliveredFailureExecute = async () => {
  deliveredFailureExecutions += 1;
  return toolResult({
    ok: false,
    executed: true,
    commandSucceeded: false,
    workspace: 'app',
    work_id: deliveredFailureWorkId,
    durationMs: 5,
    exitCode: 1,
    stderr: `failure-${deliveredFailureExecutions}`
  }, true);
};
const deliveredFailure = await handleTransportFallbackRequest(transientConfig, message(902, deliveredFailureWorkId), {
  principal: 'principal-delivered-failure',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredFailureExecute
});
assert.equal(deliveredFailureExecutions, 1);
deliveredFailure.onDelivered();
const freshDeliveredFailure = await handleTransportFallbackRequest(transientConfig, message(903, deliveredFailureWorkId), {
  principal: 'principal-delivered-failure',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: deliveredFailureExecute
});
assert.equal(deliveredFailureExecutions, 2, 'a confirmed failed work-bound result must execute again on an explicit rerun');
freshDeliveredFailure.onDelivered();

let resilientReadExecutions = 0;
const resilientReadExecute = async () => {
  resilientReadExecutions += 1;
  return toolResult({ ok: true, workspace: 'app', content: `read-${resilientReadExecutions}` }, false);
};
const resilientRead = await handleTransportFallbackRequest(transientConfig, readMessage(1001), {
  principal: 'principal-resilient',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: resilientReadExecute
});
assert.equal(resilientReadExecutions, 1);
assert.equal(typeof resilientRead.onDelivered, 'function', 'delivery-aware fallback must retain a one-shot acknowledgement until HTTP delivery completes');
const lostResponseRetry = await handleTransportFallbackRequest(transientConfig, readMessage(1002), {
  principal: 'principal-resilient',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: resilientReadExecute
});
assert.equal(resilientReadExecutions, 1, 'retry after a lost response must replay the accepted operation instead of executing it twice');
assert.equal(lostResponseRetry.body.result.structuredContent.content, 'read-1');
resilientRead.onDelivered();
const freshRead = await handleTransportFallbackRequest(transientConfig, readMessage(1003), {
  principal: 'principal-resilient',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: resilientReadExecute
});
assert.equal(resilientReadExecutions, 2, 'after confirmed delivery, the same read must execute fresh instead of replaying stale data');
freshRead.onDelivered();

let resilientProcessStarts = 0;
const resilientProcessStartExecute = async () => {
  resilientProcessStarts += 1;
  await delay(30);
  return toolResult({ ok: true, workspace: 'app', processId: 'proc_resilient_start', status: 'running' }, false);
};
const acceptedProcessStart = await handleTransportFallbackRequest(transientConfig, processStartMessage(1010), {
  principal: 'principal-resilient-process',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: resilientProcessStartExecute
});
assert.equal(acceptedProcessStart.body.result.structuredContent.status, 'running');
assert.ok(acceptedProcessStart.body.result.structuredContent.operationId, 'slow managed-process startup must return a fallback operation identity');
await assert.doesNotReject(() => validateToolOutput({}, 'relai_process', processStartMessage(1010).params.arguments,
  acceptedProcessStart.body.result.structuredContent),
'slow managed-process startup must satisfy the public output contract while background startup is still running');
const retriedProcessStart = await handleTransportFallbackRequest(transientConfig, processStartMessage(1011), {
  principal: 'principal-resilient-process',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: resilientProcessStartExecute
});
assert.equal(resilientProcessStarts, 1, 'retry after a lost process-start response must reuse the active startup instead of creating another process');
assert.equal(retriedProcessStart.body.result.structuredContent.operationId, acceptedProcessStart.body.result.structuredContent.operationId);
await delay(40);
const completedProcessStart = await handleTransportFallbackRequest(transientConfig, processStartMessage(1012), {
  principal: 'principal-resilient-process',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: resilientProcessStartExecute
});
assert.equal(resilientProcessStarts, 1, 'completed but unacknowledged process startup must replay its result without a duplicate start');
assert.equal(completedProcessStart.body.result.structuredContent.processId, 'proc_resilient_start');
completedProcessStart.onDelivered?.();

let workBeginExecutions = 0;
const workBeginExecute = async () => {
  workBeginExecutions += 1;
  await delay(30);
  return toolResult({
    ok: true,
    workspace: 'app',
    work_id: 'work_replay_safe_begin',
    status: 'planning',
    title: 'Replay-safe start',
    objective: 'Prove a lost work.begin response does not create a duplicate task.'
  }, false);
};
const acceptedWorkBegin = await handleTransportFallbackRequest(transientConfig, workBeginMessage(1004), {
  principal: 'principal-work-begin-replay',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: workBeginExecute
});
assert.equal(workBeginExecutions, 1);
assert.equal(acceptedWorkBegin.body.result.structuredContent.work_id, 'work_replay_safe_begin', 'work.begin must not detach before returning its durable work_id');
assert.equal(typeof acceptedWorkBegin.onDelivered, 'function');
const retriedWorkBegin = await handleTransportFallbackRequest(transientConfig, workBeginMessage(1005), {
  principal: 'principal-work-begin-replay',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: workBeginExecute
});
assert.equal(workBeginExecutions, 1, 'retrying work.begin after losing its response must replay the accepted task instead of creating a second task');
assert.equal(retriedWorkBegin.body.result.structuredContent.work_id, 'work_replay_safe_begin');
acceptedWorkBegin.onDelivered();

let detachedReadExecutions = 0;
const detachedReadExecute = async () => {
  detachedReadExecutions += 1;
  await delay(30);
  return toolResult({ ok: true, workspace: 'app', content: `detached-${detachedReadExecutions}` }, false);
};
const detachedRead = await handleTransportFallbackRequest(transientConfig, readMessage(1010), {
  principal: 'principal-resilient-detached',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 5,
  executeToolResult: detachedReadExecute
});
assert.equal(detachedRead.body.result.structuredContent.status, 'running');
assert.equal(typeof detachedRead.onDelivered, 'function');
const detachedOperationId = detachedRead.body.result.structuredContent.operationId;
detachedRead.onDelivered();
await delay(45);
assert.equal(fallbackExecutionStatus(detachedOperationId).status, 'completed', 'delivered detached work must remain queryable by operationId');
const expiredDetachedAt = Date.now() + (16 * 60_000);
assert.equal(fallbackExecutionStatus(detachedOperationId, { now: () => expiredDetachedAt }), null, 'delivered taskless operation records must expire from operationId lookup after the fallback TTL');
const freshAfterDetachedDelivery = await handleTransportFallbackRequest(transientConfig, readMessage(1011), {
  principal: 'principal-resilient-detached',
  transportType: 'streamable-http',
  synchronousFallbackGraceMs: 50,
  executeToolResult: detachedReadExecute
});
assert.equal(detachedReadExecutions, 2, 'delivering a detached acknowledgement must release its request-signature replay key after completion');
freshAfterDetachedDelivery.onDelivered();

const slowWorkId = 'work_slow_fallback_test';
let executionCount = 0;
const requestAbort = new AbortController();
const slowExecute = async () => {
  executionCount += 1;
  await delay(40);
  return completedResult(slowWorkId, 'slow complete');
};
const slow = await handleTransportFallbackRequest(transientConfig, message(2, slowWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  signal: requestAbort.signal,
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(slow.body.result.isError, false);
assert.equal(slow.body.result.structuredContent.status, 'running');
if (Object.hasOwn(slow.body.result.structuredContent, 'pollAfterMs')) {
  assert.ok(Number.isFinite(slow.body.result.structuredContent.pollAfterMs) && slow.body.result.structuredContent.pollAfterMs > 0, 'an optional fallback poll delay must be finite and positive');
}
assert.equal(slow.body.result.structuredContent.revision, 1);
assert.ok(slow.body.result.structuredContent.operationId);
assert.ok(slow.body.result.structuredContent.updatedAt);
assert.match(slow.body.result.structuredContent.nextAction, /Continue independent work/i);
assert.match(slow.body.result.structuredContent.nextAction, /completedOperations/i);
assert.match(slow.body.result.structuredContent.nextAction, /Retrieve this operation explicitly only when its result is required to proceed/i);
assert.equal(executionCount, 1);

requestAbort.abort(new Error('simulated connector disconnect'));
const duplicate = await handleTransportFallbackRequest(transientConfig, message(3, slowWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(duplicate.body.result.structuredContent.status, 'running');
assert.equal(executionCount, 1, 'a retry while the same fallback is running must not duplicate execution');

const busy = await handleTransportFallbackRequest(transientConfig, message(4, slowWorkId, 'node other-test.js'), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 5,
  executeToolResult: async () => completedResult(slowWorkId, 'independent complete')
});
assert.equal(busy.body.result.isError, false);
assert.equal(busy.body.result.structuredContent.ok, true, 'a different operation must be accepted under the same work session');
assert.equal(busy.body.result.structuredContent.stdout, 'independent complete');
assert.equal(fallbackExecutionsStatus(slowWorkId).length, 2, 'same-task operations must retain separate identities and results');
assert.equal(executionCount, 1, 'accepting a different operation must not restart the first command');

await delay(60);
const completed = fallbackExecutionStatus(slow.body.result.structuredContent.operationId);
assert.equal(completed.status, 'completed');
assert.equal(completed.revision, 2);
assert.equal(completed.result.exitCode, 0);
assert.equal(completed.result.stdout, 'slow complete');
assert.equal(executionCount, 1, 'request cancellation must not abort or restart detached fallback work');

const completedRetry = await handleTransportFallbackRequest(transientConfig, message(5, slowWorkId), {
  principal: 'principal-a',
  transportType: 'test',
  synchronousFallbackGraceMs: 5,
  executeToolResult: slowExecute
});
assert.equal(completedRetry.body.result.structuredContent.stdout, 'slow complete');
assert.equal(executionCount, 1, 'a completed retry with the same signature must replay instead of executing again');

const cancelledWorkId = 'work_cancelled_fallback_test';
let fallbackAbortObserved = false;
const cancellable = startFallbackExecution({
  workId: cancelledWorkId,
  tool: 'relai_validate',
  workspace: 'app',
  signature: 'cancel-signature',
  run: signal => new Promise(resolve => {
    const finish = () => {
      fallbackAbortObserved = true;
      resolve(toolResult({ ok: false, work_id: cancelledWorkId, cancelled: true }, true));
    };
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  })
});
const wrongOwnerCancellation = cancelFallbackExecution(cancellable.record.operationId, {
  reason: 'Must not cross task ownership.',
  expectedWorkId: 'work_other_fallback_test'
});
assert.equal(wrongOwnerCancellation.cancelled, false);
assert.equal(wrongOwnerCancellation.mismatch, true);
assert.equal(fallbackAbortObserved, false, 'a fallback operation ID must not cancel work owned by another logical task');
assert.equal(fallbackExecutionStatus(cancelledWorkId).status, 'running');
const cancellation = cancelFallbackExecution(cancellable.record.operationId, {
  reason: 'Explicit fallback cancellation test.',
  expectedWorkId: cancelledWorkId
});
assert.equal(cancellation.cancelled, false);
assert.equal(cancellation.stopping, true);
assert.equal(cancellation.record.status, 'running', 'fallback cancellation request must remain nonterminal until execution settles');
assert.equal(fallbackExecutionStatus(cancelledWorkId).status, 'running');
assert.equal(fallbackExecutionStatus(cancelledWorkId).stopping, true);
await cancellable.record.promise;
assert.equal(fallbackAbortObserved, true, 'explicit work-session cancellation must reach the detached operation signal');
assert.equal(fallbackExecutionStatus(cancelledWorkId).status, 'cancelled');

// A cancellation result may describe a still-live process. Keep that evidence,
// and never let a late successful handler result turn cancellation into success.
for (const mode of ['uncertain', 'confirmed', 'late_success']) {
  const lateSuccess = mode === 'late_success';
  const confirmed = mode === 'confirmed';
  const workId = `work_cancelled_result_${mode}`;
  seedTask(transientConfig, workId);
  let finish;
  const operation = startFallbackExecution({
    config: transientConfig, workId, tool: 'relai_exec', workspace: 'app',
    signature: workId,
    run: () => new Promise(resolve => { finish = resolve; })
  });
  await delay(0);
  cancelFallbackExecution(operation.record.operationId, { config: transientConfig, expectedWorkId: workId });
  assert.equal(fallbackExecutionStatus(operation.record.operationId).status, 'running');
  finish(toolResult({
    ok: lateSuccess, commandSucceeded: lateSuccess, cancelled: !lateSuccess,
    terminationConfirmed: confirmed, mutationUnknown: !confirmed,
    error: 'original handler failure', errorCode: 'HANDLER_CANCELLED',
    stdout: 'partial cancellation output', stderr: 'termination was not confirmed'
  }, !lateSuccess));
  const settled = await operation.record.promise;
  const terminal = fallbackExecutionStatus(operation.record.operationId);
  assert.equal(terminal.status, 'cancelled');
  assert.equal(terminal.result?.terminationConfirmed, confirmed, 'cancelled status must retain unconfirmed termination');
  assert.equal(terminal.result?.mutationUnknown, !confirmed, 'cancelled status must retain mutation uncertainty');
  assert.equal(terminal.result?.stdout, 'partial cancellation output');
  assert.equal(terminal.result?.stderr, 'termination was not confirmed');
  assert.equal(terminal.result?.ok, false, 'late success must not override cancellation');
  assert.equal(terminal.result?.cancelled, true);
  assert.equal(terminal.result?.commandSucceeded, false);
  assert.equal(terminal.isError, true);
  assert.equal(terminal.result.error, 'original handler failure');
  assert.equal(terminal.result.errorCode, 'HANDLER_CANCELLED');
  assert.equal(settled.result?.structuredContent?.terminationConfirmed, confirmed, 'grace-period delivery must retain cancellation evidence');
  assert.equal(settled.result?.isError, true);
  const persisted = readTaskHistorySessionRecord(transientConfig, workId).backgroundOperation;
  assert.equal(persisted.status, 'cancelled');
  assert.equal(persisted.result.terminationConfirmed, confirmed);
  assert.equal(persisted.result.mutationUnknown, !confirmed);
  assert.equal(persisted.result.stdout, undefined, 'durable history must keep raw output out');
  assert.match(persisted.result.stdoutOutputRef, /^spill_/);
  const output = readOutputSpill(transientConfig, workId, persisted.result.stdoutOutputRef);
  assert.equal(fs.readFileSync(output.file, 'utf8'), 'partial cancellation output');
}

for (const requireTerminalResult of [false, true]) {
  const graceCancelledWorkId = `work_cancelled_transport_${requireTerminalResult ? 'terminal' : 'grace'}`;
  seedTask(transientConfig, graceCancelledWorkId);
  const graceCancelled = await handleTransportFallbackRequest(transientConfig, message(820 + Number(requireTerminalResult), graceCancelledWorkId), {
    principal: 'principal-cancel-grace', transportType: 'streamable-http',
    synchronousFallbackGraceMs: requireTerminalResult ? 0 : 1000,
    requireTerminalResult,
    executeToolResult: async () => {
      const current = fallbackExecutionsStatus(graceCancelledWorkId).at(-1);
      cancelFallbackExecution(current.operationId, { config: transientConfig, expectedWorkId: graceCancelledWorkId });
      return toolResult({ ok: false, cancelled: true, terminationConfirmed: false, mutationUnknown: true, stderr: 'transport cancellation evidence' }, true);
    }
  });
  assert.equal(graceCancelled.body.result.isError, true);
  assert.equal(graceCancelled.body.result.structuredContent.terminationConfirmed, false);
  assert.equal(graceCancelled.body.result.structuredContent.mutationUnknown, true);
  assert.equal(graceCancelled.body.result.structuredContent.stderr, 'transport cancellation evidence');
  graceCancelled.onDelivered?.();
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-fallback-durable-'));
const config = { stateDir: sandbox, auditLogPath: path.join(sandbox, 'audit.jsonl') };
try {
  resetFallbackExecutions();

  const multiWorkId = 'work_parallel_durable_test';
  seedTask(config, multiWorkId);
  const multiScope = principalFingerprint('parallel-owner');
  let finishSecond;
  let abortedFirst = false;
  const firstOperation = startFallbackExecution({
    config, workId: multiWorkId, workspace: 'app', noticeScope: multiScope,
    tool: 'relai_exec', signature: 'first-parallel-command',
    run: signal => new Promise(resolve => signal.addEventListener('abort', () => {
      abortedFirst = true;
      resolve(toolResult({ ok: false, cancelled: true }, true));
    }, { once: true }))
  });
  const secondOperation = startFallbackExecution({
    config, workId: multiWorkId, workspace: 'app', noticeScope: multiScope,
    tool: 'relai_exec', signature: 'second-parallel-command',
    run: () => new Promise(resolve => { finishSecond = resolve; })
  });
  await delay(0);
  assert.notEqual(firstOperation.record.operationId, secondOperation.record.operationId);
  assert.equal(fallbackExecutionsStatus(multiWorkId).filter(operation => operation.status === 'running').length, 2);
  assert.throws(() => assertFallbackCompletionAvailable(multiWorkId, { config }), { code: 'TASK_COMPLETION_IN_PROGRESS' });
  const retriedFirst = startFallbackExecution({
    config, workId: multiWorkId, workspace: 'app', noticeScope: multiScope,
    tool: 'relai_exec', signature: 'first-parallel-command', run: () => { throw new Error('Duplicate command launched'); }
  });
  assert.equal(retriedFirst.record.operationId, firstOperation.record.operationId, 'retry must recover the first operation even when a newer operation exists');
  cancelFallbackExecution(firstOperation.record.operationId, { config, expectedWorkId: multiWorkId });
  await firstOperation.record.promise;
  assert.equal(abortedFirst, true);
  assert.equal(fallbackExecutionStatus(secondOperation.record.operationId).status, 'running', 'stopping one operation must leave its sibling running');
  finishSecond(toolResult({ ok: true, commandSucceeded: false, exitCode: 1, stderr: 'specific test failure diagnostic' }, false));
  await secondOperation.record.promise;
  const secondResult = fallbackExecutionStatus(secondOperation.record.operationId).result;
  assert.equal(secondResult.exitCode, 1);
  assert.match(secondResult.stderrOutputRef, /^spill_/);
  assertFallbackCompletionAvailable(multiWorkId, { config });
  resetFallbackExecutions();
  const recoveredOperations = fallbackExecutionsStatus(multiWorkId, { config });
  assert.equal(recoveredOperations.length, 2, 'restart recovery must retain every same-task operation');
  const recoveredFailure = fallbackExecutionStatus(secondOperation.record.operationId, { config });
  assert.equal(recoveredFailure.result.exitCode, 1, 'exact operation lookup must work after restart');
  assert.equal(recoveredFailure.result.stderr, undefined, 'raw diagnostics must stay outside task history');
  const diagnostic = readOutputSpill(config, multiWorkId, recoveredFailure.result.stderrOutputRef);
  assert.equal(fs.readFileSync(diagnostic.file, 'utf8'), 'specific test failure diagnostic');
  const compactedStatus = toolResult({
    ok: true, work_id: multiWorkId, backgroundOperations: recoveredOperations,
    stdout: 'large unrelated output'.repeat(30_000)
  }, false).structuredContent;
  assert.equal(compactedStatus.truncated, true);
  assert.deepEqual(
    compactedStatus.backgroundOperations.map(operation => operation.operationId).sort(),
    recoveredOperations.map(operation => operation.operationId).sort(),
    'result compaction may prioritize failures or unsafe operations, but must retain every operation identity'
  );
  assert.equal(compactedStatus.backgroundOperations.find(operation => operation.operationId === secondOperation.record.operationId).result.stderrOutputRef, recoveredFailure.result.stderrOutputRef,
    'result compaction must preserve operation identity and recoverable diagnostics');
  assert.match(toolResult({ ok: true, backgroundOperations: recoveredOperations }, false).content[0].text, /failed; exit code 1/,
    'status text must distinguish a completed command from a passing command');
  assert.equal(fallbackExecutionsStatus(multiWorkId, { config, noticeScope: principalFingerprint('other-owner') }).length, 0);
  assert.equal(readTaskHistorySessionRecord(config, multiWorkId).backgroundOperations.length, 2);

  const cancelAllWorkId = 'work_cancel_all_parallel_test';
  seedTask(config, cancelAllWorkId);
  let cancelAllObserved = 0;
  const cancelAllOperations = ['one', 'two'].map(signature => startFallbackExecution({
    config, workId: cancelAllWorkId, workspace: 'app', tool: 'relai_exec', signature,
    run: signal => new Promise(resolve => signal.addEventListener('abort', () => {
      cancelAllObserved += 1;
      resolve(toolResult({ ok: false, cancelled: true }, true));
    }, { once: true }))
  }));
  await delay(0);
  const stoppedAll = cancelFallbackExecution(cancelAllWorkId, { config, expectedWorkId: cancelAllWorkId });
  assert.equal(stoppedAll.records.length, 2);
  await stoppedAll.settlement;
  assert.equal(cancelAllObserved, 2, 'task-wide cancellation must reach every operation');
  assert.equal(cancelAllOperations.every(operation => fallbackExecutionStatus(operation.record.operationId).status === 'cancelled'), true);

  const restartParallelWorkId = 'work_restart_parallel_test';
  seedTask(config, restartParallelWorkId);
  const interruptedOperations = ['restart-first', 'restart-second'].map(signature => startFallbackExecution({
    config, workId: restartParallelWorkId, workspace: 'app', tool: 'relai_exec', signature,
    run: () => new Promise(() => {})
  }));
  resetFallbackExecutions();
  const recoveredInterrupted = fallbackExecutionsStatus(restartParallelWorkId, { config });
  assert.equal(recoveredInterrupted.length, 2);
  assert.equal(recoveredInterrupted.every(operation => operation.status === 'interrupted'), true, 'restart must reconcile every unfinished operation rather than silently rerunning commands');
  for (const operation of interruptedOperations) {
    assert.equal(fallbackExecutionStatus(operation.record.operationId, { config }).status, 'interrupted');
  }

  let tasklessExecutionCount = 0;
  const tasklessStarted = await handleTransportFallbackRequest(config, message(9, ''), {
    principal: 'principal-taskless',
    transportType: 'test',
    synchronousFallbackGraceMs: 5,
    executeToolResult: async () => {
      tasklessExecutionCount += 1;
      await delay(30);
      return toolResult({ ok: true, executed: true, commandSucceeded: true, workspace: 'app', durationMs: 30, exitCode: 0, stdout: 'taskless complete' }, false);
    }
  });
  assert.equal(tasklessStarted.body.result.structuredContent.status, 'running');
  assert.equal(Object.hasOwn(tasklessStarted.body.result.structuredContent, 'work_id'), false, 'taskless fallback must not invent a work_id');
  const tasklessOperationId = tasklessStarted.body.result.structuredContent.operationId;
  assert.ok(tasklessOperationId);
  assert.match(tasklessStarted.body.result.structuredContent.nextAction, /completedOperations/i, 'taskless fallback completion should surface passively on a later Rel.AI call');
  assert.match(tasklessStarted.body.result.structuredContent.nextAction, /Retrieve this operation explicitly only when its result is required to proceed/i, 'fallback guidance must retrieve an exact result only when required to proceed');
  await delay(50);
  assert.equal(fallbackExecutionStatus(tasklessOperationId, { config }).status, 'completed');
  resetFallbackExecutions();
  const recoveredTaskless = fallbackExecutionStatus(tasklessOperationId, { config });
  assert.equal(recoveredTaskless.status, 'completed', 'taskless fallback must recover by operationId after in-memory state is lost');
  assert.equal(recoveredTaskless.result.exitCode, 0);
  assert.equal(recoveredTaskless.result.stdout, undefined, 'persisted taskless fallback state must not retain command output');
  assert.equal(tasklessExecutionCount, 1);

  const durableWorkId = 'work_durable_fallback_test';
  seedTask(config, durableWorkId);
  let durableExecutionCount = 0;
  const durableExecute = async () => {
    durableExecutionCount += 1;
    await delay(30);
    return completedResult(durableWorkId, 'must-not-persist-raw-stdout');
  };
  const durableStarted = await handleTransportFallbackRequest(config, message(10, durableWorkId), {
    principal: 'principal-a',
    transportType: 'test',
    synchronousFallbackGraceMs: 5,
    executeToolResult: durableExecute
  });
  assert.equal(durableStarted.body.result.structuredContent.status, 'running');
  await delay(50);

  const durableSession = readTaskHistorySessionRecord(config, durableWorkId);
  assert.equal(durableSession.backgroundOperation.status, 'completed');
  assert.equal(durableSession.backgroundOperation.revision, 2);
  assert.equal(durableSession.backgroundOperation.result.exitCode, 0);
  assert.equal(Object.hasOwn(durableSession.backgroundOperation.result, 'stdout'), false, 'durable task history must redact raw command output');
  assert.ok(durableSession.backgroundOperation.signature, 'private signature must persist for restart-safe deduplication');

  resetFallbackExecutions();
  const recovered = fallbackExecutionStatus(durableWorkId, { config });
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.exitCode, 0);
  assert.equal(Object.hasOwn(recovered, 'signature'), false, 'public fallback status must not expose the replay signature');
  assert.equal(Object.hasOwn(recovered.result, 'stdout'), false);

  const durableReplay = await handleTransportFallbackRequest(config, message(11, durableWorkId), {
    principal: 'principal-a',
    transportType: 'test',
    synchronousFallbackGraceMs: 5,
    executeToolResult: durableExecute
  });
  assert.equal(durableReplay.body.result.structuredContent.exitCode, 0);
  assert.equal(Object.hasOwn(durableReplay.body.result.structuredContent, 'stdout'), false, 'post-restart replay should use the sanitized durable result');
  assert.equal(durableExecutionCount, 1, 'completed work must remain idempotent after the in-memory fallback cache is lost');
  assert.deepEqual(
    peekFallbackCompletionNotices(config, {
      noticeScope: principalFingerprint('principal-a'),
      workspace: 'app'
    }),
    [],
    'terminal fallback replay must acknowledge the queued completion notice'
  );

  const deliveredDurableWorkId = 'work_delivered_durable_fallback_test';
  seedTask(config, deliveredDurableWorkId);
  let deliveredDurableExecutions = 0;
  const deliveredDurableExecute = async () => {
    deliveredDurableExecutions += 1;
    return completedResult(deliveredDurableWorkId, `durable-delivered-${deliveredDurableExecutions}`);
  };
  const deliveredDurable = await handleTransportFallbackRequest(config, message(12, deliveredDurableWorkId), {
    principal: 'principal-delivered-durable',
    transportType: 'streamable-http',
    synchronousFallbackGraceMs: 50,
    executeToolResult: deliveredDurableExecute
  });
  assert.equal(deliveredDurableExecutions, 1);
  deliveredDurable.onDelivered();
  assert.equal(readTaskHistorySessionRecord(config, deliveredDurableWorkId).backgroundOperation.deliveryAcknowledged, true);
  resetFallbackExecutions();
  const freshDurable = await handleTransportFallbackRequest(config, message(13, deliveredDurableWorkId), {
    principal: 'principal-delivered-durable',
    transportType: 'streamable-http',
    synchronousFallbackGraceMs: 50,
    executeToolResult: deliveredDurableExecute
  });
  assert.equal(deliveredDurableExecutions, 2, 'confirmed delivery must survive restart so a later work-bound rerun executes fresh');
  assert.equal(freshDurable.body.result.structuredContent.stdout, 'durable-delivered-2');
  freshDurable.onDelivered();

  const noticeWorkId = 'work_completion_notice_test';
  seedTask(config, noticeWorkId);
  const noticePrincipal = 'principal-notice';
  const noticeScope = principalFingerprint(noticePrincipal);
  const noticeStarted = startFallbackExecution({
    config,
    workId: noticeWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'notice-signature',
    run: async () => completedResult(noticeWorkId, 'raw-output-must-not-enter-notice')
  });
  enableFallbackCompletionNotice(config, noticeStarted.record);
  await noticeStarted.record.promise;
  assert.deepEqual(peekFallbackCompletionNotices(config, { noticeScope: 'other-principal', workspace: 'app' }), [], 'completion notices must remain principal scoped');
  assert.deepEqual(peekFallbackCompletionNotices(config, { noticeScope, workspace: 'other-workspace' }), [], 'completion notices must remain workspace scoped');
  const notices = peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].work_id, noticeWorkId);
  assert.equal(notices[0].exitCode, 0);
  assert.equal(notices[0].commandSucceeded, true);
  assert.match(notices[0].summary, /exit code 0/i);
  assert.equal(JSON.stringify(notices).includes('raw-output-must-not-enter-notice'), false, 'completion notices must not carry raw stdout');
  assert.equal(peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }).length, 1, 'reading a completion notice must not acknowledge it before response delivery');
  assert.equal(acknowledgeFallbackCompletionNotice(config, noticeWorkId, { noticeScope, workspace: 'app' }), true, 'the notice must remain explicitly acknowledgeable after a peek');

  const acknowledgedWorkId = 'work_acknowledged_notice_test';
  seedTask(config, acknowledgedWorkId);
  const acknowledgedStarted = startFallbackExecution({
    config,
    workId: acknowledgedWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'acknowledged-notice-signature',
    run: async () => completedResult(acknowledgedWorkId, 'acknowledged')
  });
  enableFallbackCompletionNotice(config, acknowledgedStarted.record);
  await acknowledgedStarted.record.promise;
  assert.equal(acknowledgeFallbackCompletionNotice(config, acknowledgedWorkId, { noticeScope, workspace: 'app' }), true);
  assert.deepEqual(peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }), [], 'explicit status acknowledgement must prevent duplicate piggyback delivery');

  const piggybackWorkId = 'work_piggyback_notice_test';
  seedTask(config, piggybackWorkId);
  const piggybackStarted = startFallbackExecution({
    config,
    workId: piggybackWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'piggyback-notice-signature',
    run: async () => completedResult(piggybackWorkId, 'piggyback')
  });
  enableFallbackCompletionNotice(config, piggybackStarted.record);
  await piggybackStarted.record.promise;
  const unrelated = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace: 'app' },
    { ok: true, workspace: 'app', items: [] },
    { principal: noticePrincipal, requestId: 700 }
  );
  assert.equal(unrelated.completedOperations.length, 1, 'the next unrelated same-workspace Rel.AI result must carry the background completion');
  assert.equal(unrelated.completedOperations[0].work_id, piggybackWorkId);
  assert.match(toolResult(unrelated, false).content[0].text, /Background completion: .*exit code 0/i, 'the MCP text summary must make the piggybacked completion visible to the model');
  const lostPiggybackRetry = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace: 'app' },
    { ok: true, workspace: 'app', items: [] },
    { principal: noticePrincipal, requestId: 701 }
  );
  assert.equal(lostPiggybackRetry.completedOperations?.[0]?.work_id, piggybackWorkId, 'a dropped response must leave the completion notice available for retry');
  assert.equal(acknowledgeFallbackCompletionDelivery(noticeScope, 701), true, 'response delivery must acknowledge the retried completion notice');
  const afterPiggyback = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace: 'app' },
    { ok: true, workspace: 'app', items: [] },
    { principal: noticePrincipal, requestId: 702 }
  );
  assert.equal(Object.hasOwn(afterPiggyback, 'completedOperations'), false, 'a confirmed piggyback delivery must be consumed exactly once');

  const directWorkId = 'work_direct_no_notice_test';
  seedTask(config, directWorkId);
  const directStarted = startFallbackExecution({
    config,
    workId: directWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'direct-no-notice-signature',
    run: async () => completedResult(directWorkId, 'direct')
  });
  await directStarted.record.promise;
  assert.deepEqual(peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }), [], 'an operation delivered directly must not create a later duplicate completion notice');

  const nullExitWorkId = 'work_null_exit_notice_test';
  seedTask(config, nullExitWorkId);
  const nullExitStarted = startFallbackExecution({
    config,
    workId: nullExitWorkId,
    noticeScope,
    tool: 'relai_validate',
    workspace: 'app',
    signature: 'null-exit-notice-signature',
    run: async () => toolResult({ ok: true, work_id: nullExitWorkId, exitCode: null, validationStatus: 'passed' }, false)
  });
  enableFallbackCompletionNotice(config, nullExitStarted.record);
  await nullExitStarted.record.promise;
  const nullExitNotices = peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' });
  assert.equal(Object.hasOwn(nullExitNotices[0], 'exitCode'), false, 'a null exit code must not be normalized to zero');
  assert.equal(acknowledgeFallbackCompletionNotice(config, nullExitWorkId, { noticeScope, workspace: 'app' }), true);

  const restartNoticeWorkId = 'work_restart_notice_test';
  seedTask(config, restartNoticeWorkId);
  const restartNoticeStarted = startFallbackExecution({
    config,
    workId: restartNoticeWorkId,
    noticeScope,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'restart-notice-signature',
    run: async () => new Promise(() => {})
  });
  enableFallbackCompletionNotice(config, restartNoticeStarted.record);
  assert.deepEqual(peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' }), [],
    'a live background operation must persist delivery intent without surfacing a false completion');
  assert.deepEqual(peekFallbackCompletionNotices(config, {
    noticeScope,
    workspace: 'app',
    now: () => Date.now() + (16 * 60_000)
  }), [], 'a long-running live operation must keep its pending delivery intent beyond the terminal-record TTL');
  resetFallbackExecutions();
  const restartNotices = peekFallbackCompletionNotices(config, { noticeScope, workspace: 'app' });
  assert.equal(restartNotices.length, 1, 'a later same-workspace call must recover interrupted fallback delivery after restart');
  assert.equal(restartNotices[0].work_id, restartNoticeWorkId);
  assert.equal(restartNotices[0].status, 'interrupted');
  assert.match(restartNotices[0].summary, /interrupted/i);

  const interruptedWorkId = 'work_interrupted_fallback_test';
  seedTask(config, interruptedWorkId);
  recordTaskBackgroundOperation(config, interruptedWorkId, {
    operationId: 'fallback_interrupted_fixture',
    workId: interruptedWorkId,
    tool: 'relai_exec',
    workspace: 'app',
    signature: 'interrupted-signature',
    status: 'running',
    startedAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
    revision: 1,
    result: { exitCode: 0, stdout: 'must-not-persist' }
  });
  resetFallbackExecutions();
  const interrupted = fallbackExecutionStatus(interruptedWorkId, { config, now: () => Date.parse('2026-08-27T00:01:00.000Z') });
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.revision, 2);
  assert.match(interrupted.error, /runtime restarted/i);
  const interruptedSession = readTaskHistorySessionRecord(config, interruptedWorkId);
  assert.equal(interruptedSession.backgroundOperation.status, 'interrupted');
  assert.equal(Object.hasOwn(interruptedSession.backgroundOperation.result, 'stdout'), false);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(transientSandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  resetFallbackExecutions();
}

console.log('Background operations share durable tasks, preserve exact retries and diagnostics, recover every operation after restart, and support individual and task-wide cancellation.');

// Drive execution and observation clocks explicitly; no wall-clock sleep is
// needed to distinguish live elapsed time from terminal elapsed time.
async function testTerminalElapsedClocks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-fallback-elapsed-'));
  const elapsedConfig = { stateDir: directory, auditLogPath: path.join(directory, 'audit.jsonl') };
  const base = Date.now();
  try {
    for (const [index, mode] of ['completed', 'failed', 'rejected', 'cancelled'].entries()) {
      resetFallbackExecutions();
      const started = base + index * 10_000;
      let clock = started;
      const workId = `work_elapsed_${mode}`;
      seedTask(elapsedConfig, workId);
      let resolveRun;
      let rejectRun;
      const pending = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
      const execution = startFallbackExecution({
        config: elapsedConfig, workId, tool: 'relai_exec', workspace: 'app',
        signature: workId, now: () => clock,
        run: () => pending
      });
      // Let startFallbackExecution install its handler before resolving or
      // rejecting the deferred run; this is a microtask, not a timer delay.
      await Promise.resolve();
      for (const elapsed of [125, 275]) {
        const running = fallbackExecutionStatus(execution.record.operationId, { now: () => started + elapsed });
        assert.equal(running.status, 'running');
        assert.equal(running.elapsedMs, elapsed, 'running elapsed time must follow the observation clock');
      }
      if (mode === 'cancelled') {
        clock = started + 300;
        cancelFallbackExecution(execution.record.operationId, {
          config: elapsedConfig, expectedWorkId: workId, now: () => clock,
          reason: 'Deterministic elapsed clock cancellation.'
        });
        const stopping = fallbackExecutionStatus(execution.record.operationId, { now: () => started + 350 });
        assert.equal(stopping.status, 'running', 'cancellation request is not yet completion');
        assert.equal(stopping.elapsedMs, 350, 'elapsed time must keep advancing while cancellation cleanup is pending');
      }
      clock = started + 400;
      if (mode === 'rejected') rejectRun(new Error('Deterministic elapsed clock rejection.'));
      else resolveRun(toolResult({ ok: mode === 'completed', workspace: 'app', work_id: workId }, mode !== 'completed'));
      await execution.record.promise;
      const expectedStatus = mode === 'rejected' ? 'failed' : mode;
      for (const observed of [started + 1400, started + 8400]) {
        const terminal = fallbackExecutionStatus(execution.record.operationId, { now: () => observed });
        assert.equal(terminal.status, expectedStatus);
        assert.equal(terminal.elapsedMs, 400, `${mode} elapsed time must freeze at completion`);
        assert.equal(terminal.completedAt, new Date(started + 400).toISOString());
      }

      const completedAt = execution.record.completedAt;
      execution.record.completedAtMs = 0;
      assert.equal(fallbackExecutionStatus(execution.record.operationId, { now: () => started + 1500 }).elapsedMs, 400,
        'a missing numeric completion clock must use the valid completedAt timestamp');
      execution.record.completedAtMs = Number.NaN;
      assert.equal(fallbackExecutionStatus(execution.record.operationId, { now: () => started + 1500 }).elapsedMs, 400,
        'a malformed numeric completion clock must fall back to the valid timestamp');
      for (const invalid of ['', 'not-a-date']) {
        execution.record.completedAtMs = 0;
        execution.record.completedAt = invalid;
        const terminal = fallbackExecutionStatus(execution.record.operationId, { now: () => started + 1500 });
        assert.equal(Number.isFinite(terminal.elapsedMs), true, 'missing/malformed completion dates must not produce NaN');
        assert.equal(terminal.elapsedMs, 1500, 'unknown completion must use the safe observation-time fallback');
      }
      execution.record.completedAt = completedAt;
      execution.record.completedAtMs = started + 400;

      const persisted = readTaskHistorySessionRecord(elapsedConfig, workId).backgroundOperation;
      assert.equal(persisted.completedAt, completedAt);
      assert.equal(Object.hasOwn(persisted, 'completedAtMs'), false, 'recovery fixture must rely on the persisted ISO timestamp');
      resetFallbackExecutions();
      for (const observed of [started + 2400, started + 7400]) {
        const recovered = fallbackExecutionStatus(execution.record.operationId, { config: elapsedConfig, now: () => observed });
        assert.equal(recovered.status, expectedStatus);
        assert.equal(recovered.elapsedMs, 400, `${mode} elapsed time must stay frozen after persistence recovery`);
        assert.equal(recovered.completedAt, completedAt);
      }
    }

    resetFallbackExecutions();
    const workId = 'work_elapsed_interrupted';
    const started = base + 50_000;
    seedTask(elapsedConfig, workId);
    recordTaskBackgroundOperation(elapsedConfig, workId, {
      operationId: 'fallback_elapsed_interrupted_fixture', workId,
      tool: 'relai_exec', workspace: 'app', signature: 'elapsed-interrupted',
      status: 'running', startedAt: new Date(started).toISOString(),
      updatedAt: new Date(started).toISOString(), revision: 1
    });
    const interrupted = fallbackExecutionStatus(workId, { config: elapsedConfig, now: () => started + 500 });
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.elapsedMs, 500);
    assert.equal(fallbackExecutionStatus(workId, { config: elapsedConfig, now: () => started + 5000 }).elapsedMs, 500,
      'restart interruption becomes terminal at recovery, rather than advancing on later polls');
    resetFallbackExecutions();
    assert.equal(fallbackExecutionStatus(workId, { config: elapsedConfig, now: () => started + 6000 }).elapsedMs, 500,
      'the recovery-generated completion timestamp must survive another restart');
  } finally {
    resetFallbackExecutions();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Receipt identity is internal. Two HTTP requests may reuse a JSON-RPC id;
// neither may acknowledge the other's workspace completion before delivery.
async function testCompletionReceiptIsolation() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-receipt-isolation-'));
  const receiptConfig = { stateDir: directory, auditLogPath: path.join(directory, 'audit.jsonl') };
  const wireId = 'same-protocol-id';
  const principal = createHttpPrincipal({ clientId: 'receipt-client', scopes: ['mcp'] }, 'static_bearer');
  const noticeScope = principalFingerprint(principal);
  const context = { config: receiptConfig, principal };
  const metricRequestIds = [];
  async function seedNotice(workspace, suffix, noticePrincipal = principal) {
    const operation = startFallbackExecution({
      config: receiptConfig, scopeId: `receipt-${suffix}`, workspace,
      noticeScope: principalFingerprint(noticePrincipal), tool: 'relai_exec', signature: suffix,
      run: async () => toolResult({ ok: true, workspace, commandSucceeded: true }, false)
    });
    enableFallbackCompletionNotice(receiptConfig, operation.record);
    await operation.record.promise;
    const notices = peekFallbackCompletionNotices(receiptConfig, { noticeScope: principalFingerprint(noticePrincipal), workspace });
    assert.equal(notices.length, 1, 'receipt fixture must have one real pending completion');
    return operation.record.operationId;
  }
  const noticesFor = (workspace, scope = noticeScope) => peekFallbackCompletionNotices(receiptConfig, { noticeScope: scope, workspace });
  try {
    for (const outcomeB of ['finish', 'disconnect']) {
      resetFallbackExecutions();
      const workspaceA = `receipt-a-${outcomeB}`;
      const workspaceB = `receipt-b-${outcomeB}`;
      const operationA = await seedNotice(workspaceA, `a-${outcomeB}`);
      const operationB = await seedNotice(workspaceB, `b-${outcomeB}`);
      const internalA = beginMcpRequest({ principal: 'receipt-client', method: 'tools/call', authMode: 'static_bearer' });
      const internalB = beginMcpRequest({ principal: 'receipt-client', method: 'tools/call', authMode: 'static_bearer' });
      metricRequestIds.push(internalA, internalB);
      assert.notEqual(internalA, internalB);
      const sdkRequest = { mcpReq: { id: wireId, params: { _meta: { relaiRequestId: 'client-forgery' } } } };
      assert.equal(toolContext(sdkRequest, { principal, requestId: internalA }).requestId, internalA,
        'normal SDK execution must prefer the server-owned receipt UUID over protocol/client metadata');
      assert.equal(toolContext(sdkRequest, { principal, requestId: internalB }).requestId, internalB);
      assert.equal(principalFingerprint(createHttpPrincipal({ clientId: 'receipt-client', scopes: ['mcp'], relaiRequestId: internalA }, 'static_bearer')), noticeScope,
        'receipt UUIDs must not alter authenticated principal identity');

      let releaseA;
      let releaseB;
      const holdA = new Promise(resolve => { releaseA = resolve; });
      const holdB = new Promise(resolve => { releaseB = resolve; });
      const registered = [];
      const request = workspace => {
        const value = message(wireId, '', 'node receipt-fixture.js', 25_000);
        value.params.arguments.workspace = workspace;
        return value;
      };
      const execute = hold => async (_config, _name, args, options) => {
        const result = toolResult(enrichWithFallbackCompletions(receiptConfig, 'relai_exec', args,
          { ok: true, workspace: args.workspace }, { principal, requestId: options.requestId }), false);
        registered.push({ workspace: args.workspace, requestId: options.requestId });
        await hold;
        return result;
      };
      const responseA = handleTransportFallbackRequest(receiptConfig, request(workspaceA), {
        principal, transportType: 'test', requestId: internalA, executeToolResult: execute(holdA)
      });
      let responseB;
      try {
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(registered, [{ workspace: workspaceA, requestId: internalA }]);
        responseB = handleTransportFallbackRequest(receiptConfig, request(workspaceB), {
          principal, transportType: 'test', requestId: internalB, executeToolResult: execute(holdB)
        });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(registered, [
          { workspace: workspaceA, requestId: internalA },
          { workspace: workspaceB, requestId: internalB }
        ], 'bounded transport must preserve the supplied server receipt identities');
        releaseA();
        const deliveredA = await responseA;
        assert.equal(deliveredA.body.id, wireId, 'internal receipt correlation must not change the JSON-RPC response id');
        assert.equal(deliveredA.body.result.structuredContent.completedOperations[0].operationId, operationA);
        assert.equal(acknowledgeMcpFallbackCompletionDelivery(context, internalA), true);
        assert.deepEqual(noticesFor(workspaceA), []);
        assert.equal(noticesFor(workspaceB)[0].operationId, operationB, 'finishing A must not consume pending B');
        assert.equal(acknowledgeMcpFallbackCompletionDelivery(context, wireId), false, 'wire ids are not HTTP receipt acknowledgements');
        releaseB();
        const deliveredB = await responseB;
        assert.equal(deliveredB.body.id, wireId);
        if (outcomeB === 'finish') {
          assert.equal(acknowledgeMcpFallbackCompletionDelivery(context, internalB), true);
          assert.deepEqual(noticesFor(workspaceB), []);
        } else {
          // Execution settled, but the response connection never emitted finish.
          assert.equal(noticesFor(workspaceB)[0].operationId, operationB,
            'a dropped B response must leave its completion available for a later request');
        }
      } finally {
        releaseA();
        releaseB();
        await Promise.allSettled([responseA, responseB]);
        finishMcpRequest(internalA, { method: 'tools/call', ok: false });
        finishMcpRequest(internalB, { method: 'tools/call', ok: false });
      }
    }

    resetFallbackExecutions();
    const stdioA = createStdioPrincipal();
    const stdioB = createStdioPrincipal();
    assert.notEqual(principalFingerprint(stdioA), principalFingerprint(stdioB), 'normal stdio startup gives each connection its own principal');
    const stdioWorkspace = 'receipt-stdio';
    const operationA = await seedNotice(stdioWorkspace, 'stdio-a', stdioA);
    const operationB = await seedNotice(stdioWorkspace, 'stdio-b', stdioB);
    const result = stdioPrincipal => toolResult(enrichWithFallbackCompletions(receiptConfig, 'relai_read', { workspace: stdioWorkspace },
      { ok: true, workspace: stdioWorkspace }, toolContext({ mcpReq: { id: wireId } }, { principal: stdioPrincipal, transportType: 'stdio' })), false);
    const resultA = result(stdioA);
    const resultB = result(stdioB);
    assert.equal(resultA.structuredContent.completedOperations[0].operationId, operationA);
    assert.equal(resultB.structuredContent.completedOperations[0].operationId, operationB);
    const transport = () => ({
      fail: false, sent: [],
      async send(value) { if (this.fail) throw new Error('synthetic undelivered stdio response'); this.sent.push(value); },
      async start() {}, async close() {}
    });
    const transportA = transport();
    const transportB = transport();
    const wrapperA = createFallbackAwareStdioTransport({ config: receiptConfig, principal: stdioA, transport: transportA });
    const wrapperB = createFallbackAwareStdioTransport({ config: receiptConfig, principal: stdioB, transport: transportB });
    try {
      await wrapperA.send({ jsonrpc: '2.0', id: wireId, result: resultA });
      assert.deepEqual(noticesFor(stdioWorkspace, principalFingerprint(stdioA)), []);
      assert.equal(noticesFor(stdioWorkspace, principalFingerprint(stdioB))[0].operationId, operationB);
      transportB.fail = true;
      await assert.rejects(() => wrapperB.send({ jsonrpc: '2.0', id: wireId, result: resultB }), /undelivered stdio/);
      assert.equal(noticesFor(stdioWorkspace, principalFingerprint(stdioB))[0].operationId, operationB, 'failed stdio writes must not acknowledge delivery');
      transportB.fail = false;
      await wrapperB.send({ jsonrpc: '2.0', id: wireId, result: resultB });
      assert.deepEqual(noticesFor(stdioWorkspace, principalFingerprint(stdioB)), []);
      assert.equal(transportA.sent[0].id, wireId);
      assert.equal(transportB.sent[0].id, wireId);
    } finally {
      await Promise.all([wrapperA.close(), wrapperB.close()]);
    }
  } finally {
    for (const id of metricRequestIds) finishMcpRequest(id, { method: 'tools/call', ok: false });
    resetFallbackExecutions();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
