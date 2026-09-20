import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
  fromJsonSchema
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { combineAbortSignals } from '../abortSignals.js';
import {
  DEFAULT_FALLBACK_GRACE_MS,
  acknowledgeFallbackCompletionNotice,
  acknowledgeFallbackDelivery,
  enableFallbackCompletionNotice,
  fallbackExecutionStatus,
  fallbackSignature,
  startFallbackExecution
} from './fallbackExecutions.js';
import {
  acknowledgeNativeTaskCancellation,
  cancelNativeTask,
  getNativeTask,
  retryNativeTaskOperation,
  updateNativeTaskInputs
} from './nativeTaskService.js';
import {
  DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS,
  EXECUTION_ABORTED_CODE,
  SYNCHRONOUS_EXECUTION_LIMIT_CODE,
  TASK_ELIGIBILITY,
  selectExecutionMode
} from './executionMode.js';
import {
  MCP_PROTOCOL_VERSION,
  TASK_EXECUTION_MODE,
  TASK_METHODS,
  createInvalidTasksCapabilityError,
  createMissingTasksCapabilityError,
  negotiateTasksCapability,
  validateJsonRpcRequestEnvelope,
  validJsonRpcId
} from './protocol.js';
import {
  completeNativeToolTask,
  createNativeToolTask,
  failNativeToolTask,
  nativeToolTaskSignal
} from './nativeToolTasks.js';
import { createRelaiRequestStateCodec, openAiConversationId } from './context.js';
import { toolResult } from './results.js';
import { catalogApprovalRequirement, getToolActionCatalog, resolveToolOperation } from '../tools/actionCatalog.js';
import { getToolSchemas } from '../tools/schema.js';
import { validateToolOutput } from '../tools/outputValidation.js';
import { principalFingerprint, principalIdentity } from './principal.js';
import { MCP_SERVER_INFO } from '../mcpServer.js';
import { MCP_RESULT_TYPE, TRANSPORT_OPERATION } from './contracts.ts';

const TRANSPORT_CLEANUP_GRACE_MS = 5000;
const TRANSPORT_TOOL_VALIDATORS = new Map(getToolSchemas().map((tool: any) => [
  tool.name,
  fromJsonSchema(tool.inputSchema)['~standard']
]));
const TRANSPORT_INTERCEPTABLE_TOOL_NAMES = new Set(getToolActionCatalog()
  .filter((entry: any) => entry.behavior?.executionClass === 'native_task_eligible' && entry.behavior?.longRunning === true)
  .map((entry: any) => entry.publicTool));
const TRANSPORT_RESILIENT_OPERATION_NAMES = new Set([
  'work.begin',
  'work.status',
  'snapshot',
  'read',
  'search.text',
  'process.list'
]);

async function handleTransportTaskRequest(config: any, message: any, options: any = {}) {
  if (!isTransportTaskRequestCandidate(config, message, options)) return null;
  const envelope = validateJsonRpcRequestEnvelope(message);
  if (!envelope.ok) return errorResponse(null, envelope.code, envelope.error, envelope.data);
  const method = String(message.method || '');
  const capabilities = clientCapabilities(message);

  if (TASK_METHODS.includes(method)) {
    if (message.id == null) return notificationHandled();
    return handleTaskProtocolRequest(config, message, options.principal, capabilities);
  }
  if (method !== TRANSPORT_OPERATION.TOOL_CALL || message.id == null) return null;

  const name = String(message.params?.name || '');
  const validated = await validateToolArguments(config, name, message.params?.arguments);
  if (!validated.ok) return toolArgumentErrorResponse(message.id, validated.error);

  const definition = transportToolDefinition(name, validated.value);
  const resilientFallback = options.transportType === 'streamable-http'
    && shouldUseResilientFallback(definition, validated.value);
  if (!resilientFallback && !shouldInterceptTool(definition, validated.value)) return null;

  const bounds = options.synchronousBounds || DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS;
  const execute = typeof options.executeToolResult === 'function'
    ? options.executeToolResult
    : executeToolResult;
  if (resilientFallback) {
    return runFallbackToolExecution(config, message, validated.value, {
      ...options,
      capabilities,
      execute,
      bounds,
      scopeOnly: true,
      deliveryAware: true,
      persistFallback: false,
      requireTerminalResult: definition?.operationName === 'work.begin'
    });
  }
  const estimate = synchronousEstimate(name, validated.value, bounds, options);
  const selection = selectExecutionMode({
    clientCapabilities: capabilities,
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: estimate.safe,
    estimatedDurationMs: estimate.durationMs,
    synchronousBounds: bounds,
    abortSignals: options.signal ? [options.signal] : []
  });
  if (!selection.ok) {
    if (selection.capability.valid
      && !selection.capability.supported
      && selection.error?.reason === 'native_tasks_required') {
      return runFallbackToolExecution(config, message, validated.value, {
        ...options,
        capabilities,
        execute,
        bounds,
        deliveryAware: options.transportType === 'streamable-http'
      });
    }
    return errorFromPolicy(message.id, selection.error);
  }

  if (selection.mode === TASK_EXECUTION_MODE.NATIVE_TASKS) {
    return startNativeToolExecution(config, message, validated.value, {
      ...options,
      capabilities,
      bounds: selection.bounds,
      message
    });
  }

  const bounded = await runBoundedExecution(
    (signal: any) => execute(config, name, validated.value, {
      ...options,
      capabilities,
      signal,
      requestId: message.id,
      message
    }),
    { bounds: selection.bounds, signal: selection.signal }
  );
  if (!bounded.ok) return toolExecutionErrorResponse(message.id, bounded.error);
  return successResponse(message.id, bounded.value);
}

function shouldInterceptTool(definition: any, args: any = {}) {
  // Eligibility is intentionally broader than current client support. Interception
  // keeps short bounded calls synchronous and detaches only calls that do not fit
  // the safe response window when the client has not advertised Native Tasks.
  return definition?.behavior?.executionClass === 'native_task_eligible'
    && definition?.behavior?.longRunning === true
    && !catalogApprovalRequirement(definition.name, args || {});
}

function shouldUseResilientFallback(definition: any, args: any = {}) {
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

function isTransportTaskRequestCandidate(config: any, message: any, options: any = {}) {
  if (!isModernRequest(message)) return false;
  const method = String(message?.method || '');
  if (TASK_METHODS.includes(method)) return true;
  if (method !== TRANSPORT_OPERATION.TOOL_CALL) return false;
  const name = String(message?.params?.name || '');
  try {
    const definition = transportToolDefinition(name, message?.params?.arguments || {});
    return (options.transportType === 'streamable-http'
      && shouldUseResilientFallback(definition, message?.params?.arguments))
      || shouldInterceptTool(definition, message?.params?.arguments);
  } catch {
    // Keep malformed long-running tool calls inside Rel.AI's tools/call result
    // boundary. Falling back to SDK argument validation would emit JSON-RPC
    // -32602 before the tool callback runs, and some clients surface that as a
    // transport-level failure instead of a normal tool error.
    return TRANSPORT_INTERCEPTABLE_TOOL_NAMES.has(name);
  }
}

function synchronousEstimate(_name: any, args: any, bounds: any, options: any = {}) {
  const timeoutMs = Number(args?.timeoutMs);
  const explicitBound = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const directDurationLimit = Math.min(bounds.maxDurationMs, 10_000);
  const commandCount = Array.isArray(args?.checks)
    ? args.checks.length
    : Array.isArray(args?.commands)
      ? args.commands.length
      : args?.check || args?.command || args?.executable
        ? 1
        : Number.POSITIVE_INFINITY;
  const safe = options.synchronousFallback !== false
    && explicitBound
    && timeoutMs <= directDurationLimit
    && commandCount <= 1;
  return {
    safe,
    durationMs: explicitBound ? timeoutMs : undefined
  };
}

async function runFallbackToolExecution(config: any, message: any, args: any, options: any = {}) {
  const name = String(message.params?.name || '');
  const workId = options.scopeOnly === true ? '' : String(args.work_id || '').trim();
  const signature = fallbackSignature(name, args);
  const scopeId = workId || `workspace:${principalIdentity(options.principal)}:${String(args.workspace || '')}:${signature}`;
  const graceMs = Math.max(0, Number(options.synchronousFallbackGraceMs ?? DEFAULT_FALLBACK_GRACE_MS));
  let started;
  try {
    started = startFallbackExecution({
      config,
      workId,
      scopeId,
      noticeScope: principalFingerprint(options.principal),
      tool: name,
      workspace: String(args.workspace || ''),
      signature,
      persist: options.persistFallback !== false,
      run: (signal: any) => options.execute(config, name, args, {
        ...options,
        backgroundFallbackExecution: true,
        signal,
        requestId: `fallback:${workId || scopeId}`,
        message
      })
    });
  } catch (error: any) {
    return successResponse(message.id, toolResult({
      ok: false,
      ...(workId ? { work_id: workId } : {}),
      error: error instanceof Error ? error.message : String(error),
      errorCode: String(error?.code || 'TASK_OPERATION_IN_PROGRESS'),
      nextAction: workId
        ? `Call relai_work with action "status" and work_id "${workId}" before starting another long operation.`
        : 'Check the returned operationId with relai_work action "status" before retrying the same long operation.'
    }, false));
  }

  if (started.reused && started.record.status !== 'running') {
    acknowledgeFallbackCompletionNotice(config, workId || started.record.operationId, {
      noticeScope: principalFingerprint(options.principal),
      workspace: String(args.workspace || '')
    });
    return replayFallbackResult(message.id, workId, started.record, deliveryCallback(config, started.record, options));
  }

  if (!started.reused && graceMs > 0) {
    const settled = await waitForFallbackGrace(started.record.promise, graceMs);
    if (settled.kind === 'settled') {
      if (settled.value.ok) return successResponse(message.id, settled.value.result, deliveryCallback(config, started.record, options));
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
    if (settled.ok) return successResponse(message.id, settled.result, deliveryCallback(config, started.record, options));
    return successResponse(message.id, toolResult({
      ok: false,
      error: settled.error instanceof Error ? settled.error.message : String(settled.error || 'Task start failed.'),
      errorCode: 'TOOL_EXECUTION_FAILED'
    }, true), deliveryCallback(config, started.record, options));
  }

  enableFallbackCompletionNotice(config, started.record);
  const operation = fallbackExecutionStatus(workId || started.record.operationId, { config }) || {};
  if (operation.status && operation.status !== 'running') {
    acknowledgeFallbackCompletionNotice(config, workId || started.record.operationId, {
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
    message: `${name} is still running safely in the background after this request returns. Continue independent work instead of polling.`,
    nextAction: workId
      ? `Continue independent work. A later Rel.AI call in this workspace can surface completion once under completedOperations. Use relai_work status only when you explicitly need this result before another useful call.`
      : `Continue independent work. A later Rel.AI call in this workspace can surface completion once under completedOperations. Use relai_work status only when you explicitly need this operation before another useful call.`
  }, false), deliveryCallback(config, started.record, options));
}

function deliveryCallback(config: any, record: any, options: any) {
  if (options.deliveryAware !== true || !record?.operationId) return undefined;
  return () => { acknowledgeFallbackDelivery(config, record.operationId); };
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

async function waitForFallbackGrace(execution: any, graceMs: any) {
  let timer;
  try {
    return await Promise.race([
      execution.then((value: any) => ({ kind: 'settled', value })),
      new Promise((resolve: any) => {
        timer = setTimeout(() => resolve({ kind: 'pending' }), graceMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleTaskProtocolRequest(config: any, message: any, principal: any, capabilities: any) {
  const capability = negotiateTasksCapability(capabilities);
  if (!capability.valid) {
    const error = createInvalidTasksCapabilityError(capability);
    return errorResponse(message.id, error.code, error.message, error.data);
  }
  if (!capability.supported) {
    const error = createMissingTasksCapabilityError();
    return errorResponse(message.id, error.code, error.message, error.data);
  }
  try {
    const taskId = String(message.params?.taskId || '');
    if (message.method === TRANSPORT_OPERATION.TASK_GET) {
      const task = await retryNativeTaskOperation(() => getNativeTask(config, taskId, { principal }));
      return successResponse(message.id, { resultType: MCP_RESULT_TYPE.COMPLETE, ...task });
    }
    if (message.method === TRANSPORT_OPERATION.TASK_UPDATE) {
      await retryNativeTaskOperation(() => updateNativeTaskInputs(config, taskId, message.params?.inputResponses, { principal }));
      return successResponse(message.id, { resultType: MCP_RESULT_TYPE.COMPLETE });
    }
    await retryNativeTaskOperation(() => cancelNativeTask(config, taskId, {
      principal,
      statusMessage: 'Native MCP task cancellation requested by the client.'
    }));
    return successResponse(message.id, { resultType: MCP_RESULT_TYPE.COMPLETE });
  } catch (error: any) {
    return nativeTaskErrorResponse(message.id, error);
  }
}

async function startNativeToolExecution(config: any, message: any, args: any, options: any) {
  const name = String(message.params?.name || '');
  // MCP taskId is the protocol identity. work_id stays in the tool arguments as
  // Rel.AI durable attribution and is never copied into the native task identity.
  const operation = await retryNativeTaskOperation(() => createNativeToolTask(config, {
    principal: options.principal,
    method: 'tools/call',
    name,
    workspace: String(args.workspace || ''),
    message: `${name} is running as a native MCP task.`
  }));
  const taskId = operation.taskId;
  const signal = nativeToolTaskSignal(taskId);
  queueMicrotask(() => {
    void executeToolResult(config, name, {
      ...args,
      _operationTaskId: taskId
    }, {
      ...options,
      signal,
      requestId: message.id,
      nativeTaskId: taskId
    }).then(async (result: any) => {
      if (signal?.aborted) {
        await retryNativeTaskOperation(() => acknowledgeNativeTaskCancellation(config, taskId, {
          principal: options.principal,
          executionStopped: true,
          statusMessage: 'Native MCP task cancelled.'
        }));
        return;
      }
      await completeNativeToolTask(config, taskId, result);
    }).catch(async (error: any) => {
      try {
        if (signal?.aborted) {
          await retryNativeTaskOperation(() => acknowledgeNativeTaskCancellation(config, taskId, {
            principal: options.principal,
            executionStopped: true,
            statusMessage: 'Native MCP task cancelled.'
          }));
          return;
        }
        await failNativeToolTask(config, taskId, error);
      } catch (settlementError: any) {
        if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] native task settlement failure:', settlementError);
      }
    });
  });
  const task = await retryNativeTaskOperation(() => getNativeTask(config, taskId, { principal: options.principal }));
  return successResponse(message.id, {
    resultType: MCP_RESULT_TYPE.TASK,
    ...task
  });
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

async function validateToolArguments(config: any, name: any, value: any) {
  const args = value == null ? {} : value;
  if (!isPlainObject(args)) return { ok: false, error: `Invalid arguments for tool ${name}: arguments must be an object.` };
  const validator = TRANSPORT_TOOL_VALIDATORS.get(name);
  if (!validator) return { ok: false, error: `Tool ${name} not found.` };
  const result = await validator.validate(args);
  if (result.issues) {
    return {
      ok: false,
      error: `Invalid arguments for tool ${name}: ${result.issues.map((issue: any) => issue.message).join('; ')}`
    };
  }
  return { ok: true, value: result.value };
}

async function runBoundedExecution(executor: any, options: any = {}) {
  const bounds = options.bounds || DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS;
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
      timeoutController.abort(new Error('Bounded synchronous execution timed out.'));
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
    await awaitCleanup(execution);
    return { ok: false, error: executionLimitError('synchronous_timeout', 'Bounded synchronous execution exceeded its maximum duration.', bounds) };
  }
  if (settled.kind === 'aborted') {
    timeoutController.abort(options.signal?.reason);
    await awaitCleanup(execution);
    return { ok: false, error: abortedExecutionError() };
  }
  if (settled.kind === 'error') throw settled.error;
  return { ok: true, value: settled.value };
}

async function awaitCleanup(execution: any) {
  let timer;
  try {
    await Promise.race([
      execution,
      new Promise((resolve: any) => {
        timer = setTimeout(resolve, TRANSPORT_CLEANUP_GRACE_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
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
    nativeTaskId: options.nativeTaskId,
    backgroundFallbackExecution: options.backgroundFallbackExecution === true,
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

function nativeTaskErrorResponse(id: any, error: any) {
  if (error?.code === 'NATIVE_TASK_UNAVAILABLE') {
    return errorResponse(id, -32602, 'Invalid task ID or task is not available to this client.');
  }
  if (error?.code === 'NATIVE_TASK_INVALID_REQUEST') {
    return errorResponse(id, -32602, error.message, { reason: error.reason || 'invalid_task_request' });
  }
  if (error?.code === 'NATIVE_TASK_STORE_ERROR') {
    const corrupt = error.reason === 'record_corrupt';
    return errorResponse(id, -32603, corrupt ? 'Native task record is corrupt.' : 'Native task storage is unavailable.', {
      reason: corrupt ? 'task_record_corrupt' : (error.reason || 'task_store_unavailable'),
      retryable: corrupt ? false : error.retryable !== false
    });
  }
  return errorResponse(id, -32603, 'Native task request failed.', { reason: 'internal_error', retryable: true });
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

function abortedExecutionError() {
  const error = new Error('Bounded synchronous execution was cancelled because the request or connection closed.') as Error & {
    code: number;
    reason: string;
    retryable: boolean;
    data: Record<string, unknown>;
  };
  error.code = EXECUTION_ABORTED_CODE;
  error.reason = 'execution_aborted';
  error.retryable = true;
  error.data = { reason: 'execution_aborted' };
  return error;
}

function toolExecutionErrorResponse(id: any, error: any) {
  const message = String(error?.message || 'Tool execution failed.');
  const errorCode = executionErrorCode(error);
  return successResponse(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
    structuredContent: { ok: false, error: message, errorCode }
  });
}

function toolArgumentErrorResponse(id: any, error: any) {
  const message = String(error || 'Invalid tool arguments.');
  return successResponse(id, {
    content: [{ type: 'text', text: message }],
    isError: true,
    structuredContent: { ok: false, error: message, errorCode: 'INVALID_TOOL_ARGUMENTS' }
  });
}

function executionErrorCode(error: any) {
  switch (String(error?.reason || '')) {
    case 'synchronous_timeout': return 'SYNCHRONOUS_EXECUTION_TIMEOUT';
    case 'execution_aborted': return 'EXECUTION_ABORTED';
    default: return String(error?.code || 'TOOL_EXECUTION_FAILED');
  }
}

function errorFromPolicy(id: any, error: any) {
  return errorResponse(id, Number(error?.code) || -32603, error?.message || 'Execution mode is unsupported.', error?.data);
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

function createTaskAwareStdioTransport(options: any = {}) {
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
    send(message: any, sendOptions: any) {
      return transport.send(message, sendOptions);
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
    if (!isTransportTaskRequestCandidate(options.config, message, { transportType: 'stdio' })) {
      wrapper.onmessage?.(message);
      return;
    }
    const controller = message?.id == null ? null : new AbortController();
    if (controller) pending.set(message.id, controller);
    try {
      const response = await handleTransportTaskRequest(options.config, message, {
        principal: options.principal,
        transportType: 'stdio',
        envelope: objectValue(message?.params?._meta),
        signal: combineAbortSignals(sessionController.signal, controller?.signal),
        synchronousBounds: options.synchronousBounds,
        synchronousFallback: options.synchronousFallback
      });
      if (response) {
        if (response.body != null) await transport.send(response.body);
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
  createTaskAwareStdioTransport,
  handleTransportTaskRequest,
  isTransportTaskRequestCandidate,
  runBoundedExecution
};
