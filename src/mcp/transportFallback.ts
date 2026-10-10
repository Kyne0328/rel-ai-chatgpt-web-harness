import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  fromJsonSchema
} from '@modelcontextprotocol/server';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { combineAbortSignals } from '../abortSignals.js';
import { withTaskHistoryPersistenceBarrier } from '../taskHistoryStore.ts';
import {
  DEFAULT_FALLBACK_GRACE_MS,
  acknowledgeFallbackCompletionDelivery,
  acknowledgeFallbackCompletionNotice,
  acknowledgeFallbackDelivery,
  enableFallbackCompletionNotice,
  fallbackExecutionStatus,
  fallbackSignature,
  startFallbackExecution
} from './fallbackExecutions.js';
import {
  MCP_PROTOCOL_VERSION,
  validateJsonRpcRequestEnvelope,
  validJsonRpcId
} from './protocol.js';
import { createRelaiRequestStateCodec, openAiConversationId } from './context.js';
import { serializeToolError } from '../tools/errors.js';
import { toolArgumentError } from '../tools/validationGuidance.js';
import { toolResult } from './results.js';
import { catalogApprovalRequirement, getToolActionCatalog, resolveToolOperation, normalizePublicToolArguments, getCatalogAction } from '../tools/actionCatalog.js';
import { getToolSchemas } from '../tools/schema.js';
import { validateToolOutput } from '../tools/outputValidation.js';
import { principalFingerprint, principalIdentity } from './principal.ts';
import { MCP_SERVER_INFO } from '../mcpServer.js';
import { TRANSPORT_OPERATION } from './contracts.ts';

const TRANSPORT_CLEANUP_GRACE_MS = 5000;
const DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS = Object.freeze({ maxDurationMs: 30_000 });
const SYNCHRONOUS_EXECUTION_LIMIT_CODE = -32024;
const EXECUTION_ABORTED_CODE = -32800;
const TRANSPORT_TOOL_VALIDATORS = new Map(getToolSchemas().map((tool: any) => [
  tool.name,
  fromJsonSchema(tool.inputSchema)['~standard']
]));
const TRANSPORT_INTERCEPTABLE_TOOL_NAMES = new Set(getToolActionCatalog()
  .filter((entry: any) => entry.behavior?.executionClass === 'background_fallback_eligible' && entry.behavior?.longRunning === true)
  .map((entry: any) => entry.publicTool));
const TRANSPORT_RESILIENT_OPERATION_NAMES = new Set([
  'work.begin',
  'work.status',
  'snapshot',
  'read',
  'search.text',
  'process.start',
  'process.list'
]);
const HTTP_SHORT_OPERATION_GRACE_MS = 5_000;
const HTTP_SHORT_OPERATION_NAMES = new Set(['snapshot', 'read', 'search.text']);

async function handleTransportFallbackRequest(config: any, message: any, options: any = {}) {
  if (!isTransportFallbackRequestCandidate(config, message, options)) return null;
  const envelope = validateJsonRpcRequestEnvelope(message);
  if (!envelope.ok) return errorResponse(null, envelope.code, envelope.error, envelope.data);
  const method = String(message.method || '');
  if (method !== TRANSPORT_OPERATION.TOOL_CALL || message.id == null) return null;

  const name = String(message.params?.name || '');
  const validated = await validateToolArguments(config, name, message.params?.arguments);
  if (!validated.ok) return toolArgumentErrorResponse(message.id, validated.error);

  const definition = transportToolDefinition(name, validated.value);
  // Result retrieval is a direct read of an existing receipt, never a new
  // fallback execution. Its delivery wait may end without cancelling that work.
  if (options.transportType === 'streamable-http' && definition?.operationName === 'work.result') {
    const execute = typeof options.executeToolResult === 'function' ? options.executeToolResult : executeToolResult;
    return successResponse(message.id, await execute(config, name, validated.value, {
      ...options,
      resultWaitSignal: options.deliverySignal || options.signal,
      capabilities: clientCapabilities(message),
      requestId: options.requestId ?? message.id,
      message
    }));
  }
  const resilientFallback = options.transportType === 'streamable-http'
    && shouldUseResilientFallback(definition, validated.value);
  if (!resilientFallback && !shouldInterceptTool(definition, validated.value)) return null;

  const bounds = normalizeSynchronousExecutionBounds(options.synchronousBounds);
  const execute = typeof options.executeToolResult === 'function'
    ? options.executeToolResult
    : executeToolResult;
  const capabilities = clientCapabilities(message);

  if (resilientFallback) {
    return runFallbackToolExecution(config, message, validated.value, {
      ...options,
      capabilities,
      execute,
      bounds,
      scopeOnly: true,
      deliveryAware: true,
      persistFallback: false,
      synchronousFallbackGraceMs: options.synchronousFallbackGraceMs
        ?? ((validated.value as Record<string, unknown>).independent !== true && HTTP_SHORT_OPERATION_NAMES.has(String(definition?.operationName || ''))
          ? Math.min(HTTP_SHORT_OPERATION_GRACE_MS, bounds.maxDurationMs) : DEFAULT_FALLBACK_GRACE_MS),
      requireTerminalResult: definition?.operationName === 'work.begin'
    });
  }

  const estimate = synchronousEstimate(validated.value, bounds, options);
  if (!estimate.safe) {
    return runFallbackToolExecution(config, message, validated.value, {
      ...options,
      capabilities,
      execute,
      bounds,
      deliveryAware: options.transportType === 'streamable-http'
    });
  }

  const synchronousBounds = estimate.durationMs
    ? { maxDurationMs: Math.min(bounds.maxDurationMs, estimate.durationMs) }
    : bounds;
  const bounded = await runBoundedExecution(
    (signal: any) => execute(config, name, validated.value, {
      ...options,
      capabilities,
      signal,
      requestId: options.requestId ?? message.id,
      message
    }),
    { bounds: synchronousBounds, signal: options.signal }
  );
  if (!bounded.ok) return toolExecutionErrorResponse(message.id, bounded.error, bounded.cleanup);
  return successResponse(message.id, bounded.value);
}

function shouldInterceptTool(definition: any, args: any = {}) {
  return definition?.behavior?.executionClass === 'background_fallback_eligible'
    && definition?.behavior?.longRunning === true
    && !catalogApprovalRequirement(definition.name, args || {});
}

function shouldUseResilientFallback(definition: any, args: any = {}) {
  // Status is the control path used to retrieve fallback results. Never turn a
  // compact status request into another background operation to be polled.
  if (definition?.operationName === 'work.status' && args?.detail !== 'full') return false;
  if (definition?.operationName === 'read' && args?.asResource === true) return false;
  return TRANSPORT_RESILIENT_OPERATION_NAMES.has(String(definition?.operationName || ''))
    && !catalogApprovalRequirement(definition.name, args || {});
}

function transportToolDefinition(name: any, args: any = {}) {
  const resolution = resolveToolOperation(name, args);
  if (!resolution) return null;
  return {
    name: String(name || ''),
    operationName: String(resolution.operationName || ''),
    behavior: resolution.catalogEntry?.behavior || resolution.definition?.behavior || null
  };
}

function isTransportFallbackRequestCandidate(_config: any, message: any, options: any = {}) {
  if (!isModernRequest(message)) return false;
  if (String(message?.method || '') !== TRANSPORT_OPERATION.TOOL_CALL) return false;
  const name = String(message?.params?.name || '');
  try {
    const definition = transportToolDefinition(name, message?.params?.arguments || {});
    return (options.transportType === 'streamable-http'
      && (definition?.operationName === 'work.result' || shouldUseResilientFallback(definition, message?.params?.arguments)))
      || shouldInterceptTool(definition, message?.params?.arguments);
  } catch {
    return TRANSPORT_INTERCEPTABLE_TOOL_NAMES.has(name);
  }
}

function synchronousEstimate(args: any, bounds: any, options: any = {}) {
  const timeoutMs = Number(args?.timeoutMs);
  const explicitBound = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const directDurationLimit = Math.max(1_000, bounds.maxDurationMs - TRANSPORT_CLEANUP_GRACE_MS);
  const commandCount = Array.isArray(args?.checks)
    ? args.checks.length
    : Array.isArray(args?.commands)
      ? args.commands.length
      : args?.check || args?.command || args?.executable
        ? 1
        : Number.POSITIVE_INFINITY;
  return {
    safe: options.synchronousFallback !== false
      && explicitBound
      && timeoutMs <= directDurationLimit
      && commandCount <= 1,
    durationMs: explicitBound ? timeoutMs : undefined
  };
}

async function runFallbackToolExecution(config: any, message: any, args: any, options: any = {}) {
  const name = String(message.params?.name || '');
  const workId = options.scopeOnly === true ? '' : String(args.work_id || '').trim();
  if (options.signal?.aborted) {
    const timedOut = options.signal.reason?.name === 'TimeoutError';
    const transportInterrupted = options.signal.reason?.code === 'HTTP_MCP_REQUEST_INTERRUPTED';
    return successResponse(message.id, toolResult({
      ok: false,
      ...(workId ? { work_id: workId } : {}),
      executed: false,
      commandSucceeded: false,
      timedOut,
      ...(transportInterrupted ? { requestInterrupted: true, status: 'interrupted', retryable: false,
        recovery: { action: 'none', retryOriginalOperation: false, respectUserStop: true } } : { cancelled: !timedOut }),
      terminationConfirmed: true,
      mutationUnknown: false,
      error: options.signal.reason instanceof Error
        ? options.signal.reason.message
        : String(options.signal.reason || (timedOut ? 'Request timed out before execution.' : 'Request cancelled before execution.')),
      errorCode: timedOut ? 'TIMEOUT' : transportInterrupted ? 'TRANSPORT_INTERRUPTED' : 'CANCELLED'
    }, true));
  }
  const explicitTimeoutMs = Number(args?.timeoutMs);
  const explicitDeadlineAtMs = Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
    ? Date.now() + Math.floor(explicitTimeoutMs) : 0;
  const inheritedDeadlineAtMs = Number(options.deadlineAtMs);
  const deadlineAtMs = Number.isFinite(inheritedDeadlineAtMs) && inheritedDeadlineAtMs > 0
    ? (explicitDeadlineAtMs > 0 ? Math.min(explicitDeadlineAtMs, inheritedDeadlineAtMs) : inheritedDeadlineAtMs)
    : explicitDeadlineAtMs;
  // Injected executors own their synthetic scope. Production execution resolves
  // and authorizes the same canonical identity used by callTool before indexing.
  if (options.execute === executeToolResult) {
    try {
      const { resolveFallbackExecutionScope } = await import('../tools/callTool.js');
      args = await resolveFallbackExecutionScope(config, name, args, transportToolContext({ ...options, deadlineAtMs }));
    } catch (error) {
      return successResponse(message.id, toolResult(serializeToolError(name, error), true));
    }
  }
  const signature = fallbackSignature(name, args);
  const scopeId = workId || `workspace:${principalIdentity(options.principal)}:${String(args.workspace || '')}:${signature}`;
  const graceMs = Math.max(0, Number(options.synchronousFallbackGraceMs ?? DEFAULT_FALLBACK_GRACE_MS));
  let started;
  try {
    // Retry transient WAL writer contention before execution, keeping the
    // identity stable if the first attempt persisted a partial receipt.
    const operationId = workId && options.persistFallback !== false ? `fallback_${randomUUID()}` : '';
    const admit = () => startFallbackExecution({
      config,
      workId,
      scopeId,
      ...(operationId ? { operationId } : {}),
      noticeScope: principalFingerprint(options.principal),
      tool: name,
      workspace: String(args.workspace || ''),
      signature,
      deadlineAtMs,
      persist: options.persistFallback !== false,
      run: (signal: any, operationId: string) => options.execute(config, name, args, {
        ...options,
        backgroundFallbackExecution: true,
        signal,
        ...(deadlineAtMs > 0 ? { deadlineAtMs } : {}),
        requestId: operationId,
        fallbackOperationId: operationId,
        message
      })
    });
    const retryUntil = performance.now() + 500;
    for (;;) {
      try {
        started = workId && options.persistFallback !== false
          ? await withTaskHistoryPersistenceBarrier(config, workId, admit, { signal: options.signal, deadlineAtMs })
          : admit();
        break;
      } catch (error: any) {
        const cause = error?.cause;
        const busy = (Number(cause?.errcode) & 0xff) === 5 || cause?.code === 'SQLITE_BUSY';
        if (error?.code !== 'FALLBACK_PERSISTENCE_FAILED' || error?.executed !== false || !busy
          || performance.now() >= retryUntil || (deadlineAtMs > 0 && Date.now() >= deadlineAtMs)) throw error;
        options.signal?.throwIfAborted();
        await delay(Math.min(25, Math.max(1, retryUntil - performance.now())), undefined,
          options.signal ? { signal: options.signal } : {});
      }
    }
  } catch (error: any) {
    return successResponse(message.id, toolResult({
      ok: false,
      ...(workId ? { work_id: workId } : {}),
      error: error instanceof Error ? error.message : String(error),
      errorCode: String(error?.code || 'TASK_OPERATION_IN_PROGRESS'),
      ...(error?.executed === false ? { executed: false, accepted: false } : {}),
      nextAction: error?.code === 'FALLBACK_PERSISTENCE_FAILED'
        ? 'No handler was started. Restore durable state availability before submitting the operation again.'
        : error?.code === 'FALLBACK_RECOVERY_UNAVAILABLE'
          ? 'Retained replay state is unavailable. Restore state access and retrieve the known operationId before retrying; do not repeat work to recover its result.'
        : workId
        ? `Call relai_work with action "status" and work_id "${workId}" before starting another long operation.`
        : 'Check the returned operationId with relai_work action "status" before retrying the same long operation.'
    }, false));
  }

  if (started.reused && started.record.status !== 'running') {
    acknowledgeFallbackCompletionNotice(config, started.record.operationId, {
      noticeScope: principalFingerprint(options.principal),
      workspace: String(args.workspace || '')
    });
    return replayFallbackResult(message.id, workId, started.record, deliveryCallback(config, started.record, options));
  }

  let deliveryInterrupted = false;
  if (!started.reused && graceMs > 0) {
    const settled = await waitForFallbackGrace(started.record.promise, graceMs, options.deliverySignal || options.signal);
    deliveryInterrupted = settled.kind === 'interrupted';
    if (settled.kind === 'settled') {
      if (settled.value.ok || (settled.value.cancelled && settled.value.result)) return successResponse(message.id, settled.value.result, deliveryCallback(config, started.record, options));
      return successResponse(message.id, toolResult({
        ok: false,
        ...(workId ? { work_id: workId } : {}),
        error: settled.value.error instanceof Error ? settled.value.error.message : String(settled.value.error || 'Long-running operation failed.'),
        errorCode: 'TOOL_EXECUTION_FAILED'
      }, true), deliveryCallback(config, started.record, options));
    }
  }

  if (options.requireTerminalResult === true) {
    const settled = await started.record.promise;
    if (settled.ok || (settled.cancelled && settled.result)) return successResponse(message.id, settled.result, deliveryCallback(config, started.record, options));
    return successResponse(message.id, toolResult({
      ok: false,
      error: settled.error instanceof Error ? settled.error.message : String(settled.error || 'Task start failed.'),
      errorCode: 'TOOL_EXECUTION_FAILED'
    }, true), deliveryCallback(config, started.record, options));
  }

  enableFallbackCompletionNotice(config, started.record);
  const operation = fallbackExecutionStatus(started.record.operationId, { config }) || {};
  if (operation.status && operation.status !== 'running') {
    acknowledgeFallbackCompletionNotice(config, started.record.operationId, {
      noticeScope: principalFingerprint(options.principal),
      workspace: String(args.workspace || '')
    });
    return replayFallbackResult(message.id, workId, started.record, deliveryCallback(config, started.record, options));
  }
  return successResponse(message.id, toolResult({
    ok: true,
    workspace: String(args.workspace || ''),
    ...(workId ? { work_id: workId } : {}),
    status: 'running',
    operationId: operation.operationId,
    updatedAt: operation.updatedAt,
    revision: operation.revision,
    ...(operation.phase ? { phase: operation.phase } : {}),
    ...(operation.elapsedMs != null ? { elapsedMs: operation.elapsedMs } : {}),
    ...(operation.deadlineAt ? { deadlineAt: operation.deadlineAt } : {}),
    ...(operation.remainingMs != null ? { remainingMs: operation.remainingMs } : {}),
    ...(deliveryInterrupted ? {
      requestInterrupted: true,
      recovery: { action: 'result', operationId: operation.operationId, retryOriginalOperation: false, respectUserStop: true }
    } : {}),
    message: fallbackPhaseMessage(name, operation),
    nextAction: deliveryInterrupted
      ? 'The response wait was interrupted; this does not establish cancellation of the operation or user intent. Respect any explicit user stop. If still authorized, retrieve this operationId with relai_work action "result"; do not rerun the original operation.'
      : 'Continue independent work. A later Rel.AI call in this workspace can surface completion under completedOperations. Retrieve this operation explicitly only when its result is required to proceed.'
  }, false), deliveryCallback(config, started.record, options));
}

function fallbackPhaseMessage(name: string, operation: any = {}) {
  const phase = String(operation.phase || 'starting');
  const elapsedMs = Math.max(0, Number(operation.elapsedMs || 0));
  const remainingMs = Number(operation.remainingMs);
  const timing = Number.isFinite(remainingMs)
    ? ` (${Math.ceil(elapsedMs / 1000)}s elapsed, ${Math.ceil(Math.max(0, remainingMs) / 1000)}s remaining)`
    : elapsedMs > 0 ? ` (${Math.ceil(elapsedMs / 1000)}s elapsed)` : '';
  if (phase === 'queued') return `${name} is waiting in the workspace queue${timing}; execution has not started.`;
  if (phase === 'preparing') return `${name} left the queue and is preparing to execute${timing}.`;
  if (phase === 'running') return `${name} is executing${timing}.`;
  if (phase === 'stopping') return `${name} is stopping after cancellation or timeout${timing}.`;
  return `${name} is starting${timing}.`;
}

function deliveryCallback(config: any, record: any, options: any) {
  if (options.deliveryAware !== true || !record?.operationId) return undefined;
  // Capture what this response contains now, never inspect a later mutable
  // status when the send completes. A receipt cannot acknowledge a future result.
  const delivery = Object.freeze({
    operationId: record.operationId,
    status: record.status,
    revision: record.revision,
    kind: record.status === 'running' ? 'receipt' : 'result'
  });
  return () => { acknowledgeFallbackDelivery(config, delivery.operationId, delivery); };
}

function replayFallbackResult(requestId: any, workId: any, record: any, onDelivered: any = undefined) {
  if (record.result) return successResponse(requestId, record.result, onDelivered);
  if (record.persistedResult && typeof record.persistedResult === 'object') {
    return successResponse(requestId, toolResult({ ...record.persistedResult, ...(workId ? { work_id: workId } : {}) }, record.isError === true), onDelivered);
  }
  return successResponse(requestId, toolResult({
    ok: false,
    ...(workId ? { work_id: workId } : {}),
    status: record.status,
    error: record.error || `Previous background operation ${record.status}.`,
    errorCode: record.status === 'cancelled' ? 'CANCELLED' : 'TOOL_EXECUTION_FAILED'
  }, true), onDelivered);
}

async function waitForFallbackGrace(execution: any, graceMs: any, signal?: AbortSignal) {
  let timer;
  let onAbort: (() => void) | undefined;
  try {
    if (signal?.aborted) return { kind: 'interrupted' };
    return await Promise.race([
      execution.then((value: any) => ({ kind: 'settled', value })),
      new Promise((resolve: any) => {
        timer = setTimeout(() => resolve({ kind: 'pending' }), graceMs);
        timer.unref?.();
      }),
      ...(signal ? [new Promise((resolve) => {
        onAbort = () => resolve({ kind: 'interrupted' });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      })] : [])
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function executeToolResult(config: any, name: any, args: any, options: any = {}) {
  const { invokeRelaiTool } = await import('./toolInvocation.js');
  return invokeRelaiTool({
    config,
    name,
    args,
    context: transportToolContext(options),
    approvalContext: options.approvalContext,
    requestStateCodec: options.requestStateCodec || createRelaiRequestStateCodec(config, options.principal),
    validateOutput: (output: any) => validateToolOutput(config, name, args || {}, output)
  });
}

async function validateToolArguments(_config: any, name: any, value: any) {
  let args = value == null ? {} : value;
  if (!isPlainObject(args)) return { ok: false, error: `Invalid arguments for tool ${name}: arguments must be an object.` };
  try { args = normalizePublicToolArguments(name, args); } catch (error) { return { ok: false, error }; }
  const validator = TRANSPORT_TOOL_VALIDATORS.get(name);
  if (!validator) return { ok: false, error: `Tool ${name} not found.` };
  const result = await validator.validate(args);
  if (result.issues) {
    return {
      ok: false,
      error: toolArgumentError({ publicTool: name, action: String(args.action || ''), fields: getCatalogAction(name, args)?.fields || [], required: getCatalogAction(name, args)?.required || [], schema: getCatalogAction(name, args)?.inputSchema || {}, issues: result.issues })
    };
  }
  return { ok: true, value: result.value };
}

async function runBoundedExecution(executor: any, options: any = {}) {
  const bounds = normalizeSynchronousExecutionBounds(options.bounds);
  const timeoutController = new AbortController();
  const signal = combineAbortSignals(options.signal, timeoutController.signal);
  let timedOut = false;
  const execution = Promise.resolve().then(() => executor(signal)).then(
    (value: any) => ({ kind: 'value', value }),
    (error: any) => ({ kind: 'error', error })
  );
  let timer;
  const timeout = new Promise((resolve: any) => {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(new DOMException('Bounded synchronous execution timed out.', 'TimeoutError'));
      resolve({ kind: 'timeout' });
    }, bounds.maxDurationMs);
  });
  const aborted = signal ? new Promise((resolve: any) => {
    if (signal.aborted) return resolve({ kind: 'aborted' });
    signal.addEventListener('abort', () => resolve({ kind: timedOut ? 'timeout' : 'aborted' }), { once: true });
  }) : new Promise(() => {});
  const settled = await Promise.race([execution, timeout, aborted]) as
    | { kind: 'value'; value: any }
    | { kind: 'error'; error: any }
    | { kind: 'timeout' }
    | { kind: 'aborted' };
  clearTimeout(timer);

  if (settled.kind === 'timeout' || timedOut) {
    const cleanup = await awaitCleanup(execution);
    const terminalTimeout = settledTimeoutResult(cleanup);
    if (terminalTimeout) return { ok: true, value: terminalTimeout };
    return { ok: false, error: executionLimitError('synchronous_timeout', 'Bounded synchronous execution exceeded its maximum duration.', bounds), cleanup };
  }
  if (settled.kind === 'aborted') {
    timeoutController.abort(options.signal?.reason);
    const cleanup = await awaitCleanup(execution);
    const transportInterrupted = options.signal?.reason?.code === 'HTTP_MCP_REQUEST_INTERRUPTED';
    // A known handler result is stronger evidence than a lost response race.
    // Explicit MCP cancellation and operation-stop handling remain unchanged.
    if (transportInterrupted && cleanup?.kind === 'value') return { ok: true, value: cleanup.value };
    return { ok: false, error: abortedExecutionError(transportInterrupted), cleanup };
  }
  if (settled.kind === 'error') throw settled.error;
  return { ok: true, value: settled.value };
}

async function awaitCleanup(execution: any) {
  let timer;
  try {
    return await Promise.race([
      execution,
      new Promise((resolve: any) => {
        timer = setTimeout(() => resolve({ kind: 'pending' }), TRANSPORT_CLEANUP_GRACE_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function settledTimeoutResult(cleanup: any) {
  if (cleanup?.kind !== 'value') return null;
  const value = cleanup.value;
  const structured = objectValue(value?.structuredContent || value?.result);
  return structured.timedOut === true ? value : null;
}

function transportToolContext(options: any) {
  const meta = objectValue(options.envelope);
  const client = objectValue(meta[CLIENT_INFO_META_KEY]);
  return {
    publicHttpOnly: options.publicHttpOnly === true || options.transportType === 'streamable-http',
    requestId: options.requestId,
    transportType: String(options.transportType || 'stdio'),
    protocolVersion: String(options.protocolVersion || MCP_PROTOCOL_VERSION),
    clientName: String(client.name || ''),
    clientVersion: String(client.version || ''),
    clientCapabilities: options.capabilities || {},
    conversationId: openAiConversationId(meta),
    requestHeaders: options.requestHeaders || {},
    principal: options.principal || principalIdentity(options.principal),
    signal: options.signal,
    resultWaitSignal: options.resultWaitSignal,
    ...(Number(options.deadlineAtMs) > 0 ? { deadlineAtMs: Math.floor(Number(options.deadlineAtMs)) } : {}),
    backgroundFallbackExecution: options.backgroundFallbackExecution === true,
    fallbackOperationId: String(options.fallbackOperationId || ''),
    mcp: {
      envelope: meta,
      method: TRANSPORT_OPERATION.TOOL_CALL,
      authInfo: options.authInfo || null,
      inputResponses: options.inputResponses ?? null
    }
  };
}

function clientCapabilities(message: any) {
  return objectValue(message?.params?._meta)[CLIENT_CAPABILITIES_META_KEY];
}

function isModernRequest(message: any) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  return String(objectValue(message.params?._meta)[PROTOCOL_VERSION_META_KEY] || '') === MCP_PROTOCOL_VERSION;
}

function normalizeSynchronousExecutionBounds(value: any = DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('synchronousBounds must be an object.');
  }
  const maxDurationMs = Number(value.maxDurationMs);
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new TypeError('maxDurationMs must be a positive finite number.');
  }
  return Object.freeze({ maxDurationMs });
}

function executionLimitError(reason: any, message: any, bounds: any) {
  const error = new Error(message) as Error & {
    code: number;
    reason: string;
    retryable: boolean;
    data: Record<string, unknown>;
  };
  error.code = SYNCHRONOUS_EXECUTION_LIMIT_CODE;
  error.reason = reason;
  error.retryable = reason === 'synchronous_timeout';
  error.data = { reason, limits: bounds };
  return error;
}

function abortedExecutionError(transportInterrupted = false) {
  const error = new Error(transportInterrupted
    ? 'The HTTP request was interrupted. The operation outcome is not established by the transport interruption.'
    : 'Bounded synchronous execution was interrupted by its cancellation signal.') as Error & {
    code: number;
    reason: string;
    retryable: boolean;
    data: Record<string, unknown>;
  };
  error.code = EXECUTION_ABORTED_CODE;
  error.reason = transportInterrupted ? 'transport_interrupted' : 'execution_aborted';
  error.retryable = false;
  error.data = { reason: error.reason, retryOriginalOperation: false, respectUserStop: true };
  return error;
}

function toolExecutionErrorResponse(id: any, error: any, cleanup: any = null) {
  const message = String(error?.message || 'Tool execution failed.');
  const errorCode = executionErrorCode(error);
  const diagnostics = cleanup?.kind === 'value'
    ? objectValue(cleanup.value?.structuredContent || cleanup.value?.result)
    : {};
  const cleanupUnknown = cleanup?.kind !== 'value';
  const executionNotStarted = diagnostics.executed === false;
  const terminationUnconfirmed = !executionNotStarted
    && (cleanupUnknown || diagnostics.terminationConfirmed === false);
  const structured = {
    ...diagnostics,
    ...(diagnostics.error ? { handlerError: diagnostics.error } : {}),
    ...(diagnostics.errorCode ? { handlerErrorCode: diagnostics.errorCode } : {}),
    ...(cleanup?.kind === 'error' ? { handlerError: String(cleanup.error?.message || cleanup.error) } : {}),
    ok: false,
    ...(error?.reason !== 'transport_interrupted' ? { commandSucceeded: false } : {}),
    status: error?.reason === 'execution_aborted' ? 'cancelled'
      : error?.reason === 'transport_interrupted' ? 'interrupted' : 'failed',
    ...(error?.reason === 'transport_interrupted' ? {
      requestInterrupted: true,
      retryable: false,
      recovery: { action: 'inspect_status', retryOriginalOperation: false, respectUserStop: true },
      nextAction: 'Respect any explicit user stop. If still authorized, inspect the existing operation or work status before deciding what to do; do not automatically rerun the original operation.'
    } : {}),
    ...(error?.reason !== 'transport_interrupted'
      ? { timedOut: error?.reason === 'synchronous_timeout' || diagnostics.timedOut === true } : {}),
    ...(error?.reason !== 'transport_interrupted' || typeof diagnostics.cancelled === 'boolean'
      ? { cancelled: error?.reason === 'execution_aborted' || diagnostics.cancelled === true } : {}),
    // Absence of termination fields on a settled handler result is not evidence
    // of a live process. Preserve explicit facts, and flag uncertainty when no
    // result arrived before the cleanup boundary (or cleanup itself rejected).
    ...(cleanupUnknown ? { terminationConfirmed: false, mutationUnknown: true } : {}),
    cleanupPending: cleanup?.kind === 'pending',
    error: message,
    errorCode
  };
  return successResponse(id, {
    content: [{ type: 'text', text: message + (executionNotStarted
      ? ' Execution did not start.'
      : terminationUnconfirmed ? ' Process termination was not confirmed; mutations may still be in progress.' : '') }],
    isError: true,
    structuredContent: structured
  });
}

function toolArgumentErrorResponse(id: any, error: any) {
  const message = error instanceof Error ? error.message : String(error || 'Invalid tool arguments.');
  return successResponse(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
    structuredContent: { ...serializeToolError('', error), ok: false, error: message, errorCode: 'INVALID_TOOL_ARGUMENTS' }
  });
}

function executionErrorCode(error: any) {
  switch (String(error?.reason || '')) {
    case 'synchronous_timeout': return 'SYNCHRONOUS_EXECUTION_TIMEOUT';
    case 'execution_aborted': return 'EXECUTION_ABORTED';
    case 'transport_interrupted': return 'TRANSPORT_INTERRUPTED';
    default: return String(error?.code || 'TOOL_EXECUTION_FAILED');
  }
}

function successResponse(id: any, result: any, onDelivered: any = undefined) {
  if (id == null) return notificationHandled();
  if (!validJsonRpcId(id)) return errorResponse(null, -32600, 'JSON-RPC id must be a string or finite number when present.');
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id,
      result: stampServerInfo(result)
    },
    ...(typeof onDelivered === 'function' ? { onDelivered } : {})
  };
}

function stampServerInfo(result: any) {
  if (!isPlainObject(result)) return result;
  const meta = result._meta;
  if (meta === undefined) return { ...result, _meta: { [SERVER_INFO_META_KEY]: MCP_SERVER_INFO } };
  if (!isPlainObject(meta) || meta[SERVER_INFO_META_KEY] !== undefined) return result;
  return { ...result, _meta: { ...meta, [SERVER_INFO_META_KEY]: MCP_SERVER_INFO } };
}

function notificationHandled() {
  return { status: 204, body: null, notification: true };
}

function errorResponse(id: any, code: any, message: any, data: any = undefined) {
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message, ...(data === undefined ? {} : { data }) }
    }
  };
}

function objectValue(value: any) {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createFallbackAwareStdioTransport(options: any = {}) {
  const transport = options.transport || new StdioServerTransport();
  const sessionController = new AbortController();
  const pending = new Map();
  const wrapper: any = {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    async start() {
      transport.onmessage = (message: any) => { void intercept(message); };
      transport.onerror = (error: any) => wrapper.onerror?.(error);
      transport.onclose = () => {
        sessionController.abort(new Error('Stdio connection closed.'));
        for (const controller of pending.values()) controller.abort(new Error('Stdio connection closed.'));
        pending.clear();
        wrapper.onclose?.();
      };
      await transport.start();
    },
    async close() {
      sessionController.abort(new Error('Stdio connection closed.'));
      for (const controller of pending.values()) controller.abort(new Error('Stdio connection closed.'));
      pending.clear();
      await transport.close();
    },
    async send(message: any, sendOptions: any) {
      const delivered = await transport.send(message, sendOptions);
      acknowledgeFallbackCompletionDelivery(principalFingerprint(options.principal), message?.id);
      return delivered;
    },
    setProtocolVersion(version: any) {
      transport.setProtocolVersion?.(version);
    }
  };

  async function intercept(message: any) {
    if (message?.method === 'notifications/cancelled') {
      const controller = pending.get(message.params?.requestId);
      if (controller) {
        controller.abort(new Error('MCP request cancelled by the client.'));
        return;
      }
      wrapper.onmessage?.(message);
      return;
    }
    if (!isTransportFallbackRequestCandidate(options.config, message, { transportType: 'stdio' })) {
      wrapper.onmessage?.(message);
      return;
    }
    const controller = message?.id == null ? null : new AbortController();
    if (controller) pending.set(message.id, controller);
    try {
      const response = await handleTransportFallbackRequest(options.config, message, {
        principal: options.principal,
        transportType: 'stdio',
        envelope: objectValue(message?.params?._meta),
        signal: combineAbortSignals(sessionController.signal, controller?.signal),
        synchronousBounds: options.synchronousBounds,
        synchronousFallback: options.synchronousFallback
      });
      if (response) {
        if (response.body != null) {
          await transport.send(response.body);
          acknowledgeFallbackCompletionDelivery(principalFingerprint(options.principal), response.body?.id);
        }
        if ('onDelivered' in response && typeof response.onDelivered === 'function') response.onDelivered();
        return;
      }
      wrapper.onmessage?.(message);
    } catch (error: any) {
      if (message?.id != null) {
        await transport.send(errorResponse(message.id, -32603, 'Internal server error.').body).catch(() => {});
      }
      wrapper.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (controller) pending.delete(message.id);
    }
  }

  return wrapper;
}

export {
  createFallbackAwareStdioTransport,
  handleTransportFallbackRequest
};
