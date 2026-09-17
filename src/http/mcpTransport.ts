import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  createMcpHandler,
  isLegacyRequest
} from '@modelcontextprotocol/server';
import { toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import {
  LEGACY_LIFECYCLE_METHODS,
  MCP_PROTOCOL_VERSION,
  TASK_METHODS,
  beginMcpRequest,
  createMcpRequestContext,
  createMcpServerForRequest,
  finishMcpRequest,
  finishMcpSpanTimings,
  handleMcpTaskRequest,
  measureMcpPhase,
  measureMcpPhaseSync,
  noteMcpAuthenticationFailure,
  observeMcpRequestManifest,
  recordMcpTransportEvent,
  runMcpRequestSpan,
  validateMcpRequestEnvelope,
  withMcpPerformanceBreakdown,
  type CoreMcpRequestContext,
  type McpTransportResponse
} from '../core/mcp-runtime.ts';
import { mcpAuthorization, unauthorizedMcp } from './mcpAuth.ts';
import { readRawBody, sendJson } from './io.ts';
import { sendMcpProtocolError, sendMcpTransportError } from './mcpResponses.ts';
import type { HttpRouteContext, JsonRecord } from './types.ts';

type JsonRpcId = string | number | null;

interface JsonRpcRequest extends JsonRecord {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: JsonRecord;
}

interface HeaderValidationSuccess {
  ok: true;
}

interface HeaderValidationFailure {
  ok: false;
  status: number;
  code: number;
  error: string;
  data?: unknown;
}

type HeaderValidation = HeaderValidationSuccess | HeaderValidationFailure;

interface HttpAbortScope {
  signal: AbortSignal;
  dispose: () => void;
}

interface HttpTransportDetails {
  requestId?: string;
  method?: string;
  name?: string;
  startedAt: number;
}

type CoreHandler = ReturnType<typeof createMcpHandler>;
type CoreNodeHandler = ReturnType<typeof toNodeHandler>;

let coreHandler: CoreHandler | null = null;
let coreNodeHandler: CoreNodeHandler | null = null;

function getCoreNodeHandler(): CoreNodeHandler {
  if (coreNodeHandler) return coreNodeHandler;
  coreHandler = createMcpHandler(
    (context) => {
      const authInfo: JsonRecord = { ...(context.authInfo || {}) };
      return createMcpServerForRequest(authInfo, context.era);
    },
    {
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: (error: unknown) => debug('MCP handler', error)
    }
  );
  coreNodeHandler = toNodeHandler(coreHandler, {
    onerror: (error: unknown) => debug('MCP Node adapter', error)
  });
  return coreNodeHandler;
}

async function handleMcpGetDiagnostic(ctx: HttpRouteContext): Promise<void> {
  await handleUnsupportedHttpMethod(ctx);
}

async function handleMcpDelete(ctx: HttpRouteContext): Promise<void> {
  await handleUnsupportedHttpMethod(ctx);
}

async function handleMcpStreamable(ctx: HttpRouteContext): Promise<void> {
  return withMcpPerformanceBreakdown(() => handleMcpStreamableObserved(ctx));
}

async function handleMcpStreamableObserved(ctx: HttpRouteContext): Promise<void> {
  const authorizationResult = measureMcpPhaseSync(
    'mcp.authorization',
    () => mcpAuthorization(ctx.req, ctx.options)
  );
  if (!authorizationResult) {
    noteMcpAuthenticationFailure('invalid_or_missing_bearer');
    unauthorizedMcp(ctx.res);
    return;
  }
  if (!validateTransportOrigin(ctx)) return;
  if (!isJsonContentType(ctx.req.headers['content-type'])) {
    sendMcpProtocolError(ctx.res, 415, -32600, 'Content-Type must be application/json.');
    return;
  }

  const transportDetails: HttpTransportDetails = {
    method: headerValue(ctx.req.headers, 'mcp-method'),
    name: headerValue(ctx.req.headers, 'mcp-name'),
    startedAt: Date.now()
  };
  createHttpTransportLifecycle(ctx.req, ctx.res, transportDetails);
  recordMcpTransportEvent('request_started', transportEventDetails(transportDetails));

  let message: JsonRpcRequest | null;
  try {
    message = await measureMcpPhase('mcp.receive', async () => {
      const raw = await readRawBody(ctx.req, ctx.options.maxBodyBytes);
      return raw.trim() ? JSON.parse(raw) as JsonRpcRequest : null;
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendMcpProtocolError(ctx.res, 400, -32700, 'Parse error.');
      return;
    }
    throw error;
  }

  const authMode = authorizationResult.authMode;
  const authInfo: JsonRecord = { ...authorizationResult.authInfo, authMode };
  const principalId = String(authInfo.clientId || '');
  ctx.req.auth = authInfo;
  if (Array.isArray(message)) {
    sendMcpProtocolError(ctx.res, 400, -32600, 'One JSON-RPC request object is required; batches are not supported.');
    return;
  }
  if (headerValue(ctx.req.headers, 'mcp-session-id')) {
    sendMcpProtocolError(ctx.res, 400, -32600, 'Mcp-Session-Id is not supported by this stateless endpoint.', message?.id);
    return;
  }
  const legacy = await measureMcpPhase('mcp.protocol', () => isLegacyHttpRequest(ctx.req, message));
  const params = objectValue(message?.params);
  const meta = legacy ? {} : objectValue(params._meta);
  const requestId = beginMcpRequest({
    principal: principalId,
    method: message?.method,
    authMode,
    clientInfo: legacy ? params.clientInfo : meta[CLIENT_INFO_META_KEY],
    clientCapabilities: legacy ? params.capabilities : meta[CLIENT_CAPABILITIES_META_KEY]
  });
  transportDetails.requestId = requestId;
  transportDetails.method = String(message?.method || transportDetails.method || '');
  const transportName = expectedMcpName(transportDetails.method, params) || transportDetails.name;
  if (transportName) transportDetails.name = transportName;
  let requestFinished = false;
  const finishRequest = (ok: boolean): void => {
    if (requestFinished) return;
    requestFinished = true;
    finishMcpRequest(requestId, { method: message?.method, ok });
  };

  try {
    const requestContext = measureMcpPhaseSync('mcp.protocol', () => createMcpRequestContext(authInfo, authMode));
    if (legacy) {
      const method = String(message?.method || '');
      if (!LEGACY_LIFECYCLE_METHODS.includes(method)) {
        finishRequest(false);
        sendMcpProtocolError(
          ctx.res,
          400,
          -32022,
          `MCP 2025-11-25 compatibility is limited to initialize lifecycle requests. Use MCP ${MCP_PROTOCOL_VERSION} for ${method || 'this request'}.`,
          message?.id,
          {
            supported: [MCP_PROTOCOL_VERSION],
            requested: String(params.protocolVersion || headerValue(ctx.req.headers, 'mcp-protocol-version') || '2025-11-25')
          }
        );
        return;
      }
      await handleLegacyMcpRequest(ctx, message, { context: requestContext, params, principalId, finishRequest });
      return;
    }

    const validation = measureMcpPhaseSync(
      'mcp.protocol',
      () => validateMcpRequestHeaders(ctx.req.headers, message as JsonRpcRequest)
    );
    if (!validation.ok) {
      finishRequest(false);
      sendMcpProtocolError(
        ctx.res,
        validation.status,
        validation.code,
        validation.error,
        message?.id,
        validation.data
      );
      return;
    }

    await measureMcpPhase(
      'mcp.manifest',
      () => observeMcpRequestManifest(requestContext, String(message?.method || ''))
    );

    recordMcpTransportEvent('request_reached_runtime', transportEventDetails(transportDetails));
    await runMcpRequestSpan(requestContext, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      method: String(message?.method || ''),
      principalId,
      carrier: ctx.req.headers as JsonRecord
    }, async () => {
      const requestAbort = createHttpRequestAbortScope(ctx.req, ctx.res);
      try {
        const transportResponse = await handleMcpTaskRequest(requestContext, message, {
          envelope: meta,
          authInfo,
          requestHeaders: ctx.req.headers,
          signal: requestAbort.signal
        });
        if (transportResponse) {
          finishRequest(!transportResponse.body?.error);
          sendTransportResponse(ctx, transportResponse);
          return;
        }
        await getCoreNodeHandler()(ctx.req as unknown as Parameters<CoreNodeHandler>[0], ctx.res, message);
        finishRequest(ctx.res.statusCode < 400);
      } finally {
        finishMcpSpanTimings();
        requestAbort.dispose();
      }
    });
  } catch (error) {
    finishRequest(false);
    debug('MCP request failed', error);
    if (!sendMcpTransportError(ctx.res, { status: 500, id: message?.id })) {
      if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
    }
  }
}

async function handleLegacyMcpRequest(
  ctx: HttpRouteContext,
  message: JsonRpcRequest | null,
  details: {
    context: CoreMcpRequestContext;
    params: JsonRecord;
    principalId: string;
    finishRequest: (ok: boolean) => void;
  }
): Promise<void> {
  await measureMcpPhase(
    'mcp.manifest',
    () => observeMcpRequestManifest(details.context, String(message?.method || ''))
  );
  await runMcpRequestSpan(details.context, {
    protocolVersion: String(details.params.protocolVersion || headerValue(ctx.req.headers, 'mcp-protocol-version') || 'legacy'),
    method: String(message?.method || ''),
    principalId: details.principalId,
    carrier: ctx.req.headers as JsonRecord
  }, async () => {
    try {
      await getCoreNodeHandler()(ctx.req as unknown as Parameters<CoreNodeHandler>[0], ctx.res, message);
      details.finishRequest(ctx.res.statusCode < 400);
    } finally {
      finishMcpSpanTimings();
    }
  });
}

async function handleUnsupportedHttpMethod(ctx: HttpRouteContext): Promise<void> {
  if (!mcpAuthorization(ctx.req, ctx.options)) {
    unauthorizedMcp(ctx.res);
    return;
  }
  ctx.res.setHeader('allow', 'POST');
  sendMcpProtocolError(ctx.res, 405, -32600, 'Method not allowed. MCP 2026-07-28 uses stateless POST requests only.');
}

function validateMcpRequestHeaders(headers: IncomingHttpHeaders, message: JsonRpcRequest): HeaderValidation {
  const envelope = validateMcpRequestEnvelope(message);
  if (!envelope.ok) return rejection(400, envelope.code ?? -32600, envelope.error || 'Invalid request.', envelope.data);
  if (headerValue(headers, 'mcp-session-id')) {
    return rejection(400, -32600, 'Mcp-Session-Id is not supported by MCP 2026-07-28.');
  }
  if (LEGACY_LIFECYCLE_METHODS.includes(message.method)) {
    return rejection(400, -32601, `Initialize lifecycle methods are not valid inside a modern MCP request envelope: ${message.method}.`);
  }
  const protocolHeader = headerValue(headers, 'mcp-protocol-version');
  if (protocolHeader !== MCP_PROTOCOL_VERSION) {
    return rejection(400, -32022, `Unsupported protocol version: ${protocolHeader || 'missing'}.`, {
      supported: [MCP_PROTOCOL_VERSION],
      requested: protocolHeader || 'missing'
    });
  }
  const methodHeader = headerValue(headers, 'mcp-method');
  if (!methodHeader || methodHeader !== message.method) {
    return rejection(400, -32020, 'Mcp-Method header does not match the JSON-RPC method.');
  }
  const params = objectValue(message.params);
  const meta = objectValue(params._meta);
  if (params !== message.params || meta !== params._meta) {
    return rejection(400, -32602, 'Modern MCP requests require params._meta.');
  }
  const protocolMeta = String(meta[PROTOCOL_VERSION_META_KEY] || '');
  if (protocolMeta !== MCP_PROTOCOL_VERSION || protocolMeta !== protocolHeader) {
    return rejection(400, -32020, 'Request protocol metadata does not match MCP-Protocol-Version.');
  }
  if (Object.hasOwn(meta, CLIENT_INFO_META_KEY) && !validImplementation(meta[CLIENT_INFO_META_KEY])) {
    return rejection(400, -32602, `When present, ${CLIENT_INFO_META_KEY} must include name and version.`);
  }
  if (!isPlainObject(meta[CLIENT_CAPABILITIES_META_KEY])) {
    return rejection(400, -32602, `Request metadata must include ${CLIENT_CAPABILITIES_META_KEY}.`);
  }
  const expectedName = expectedMcpName(String(message.method || ''), params);
  const nameHeader = headerValue(headers, 'mcp-name');
  if (expectedName && nameHeader !== expectedName) {
    return rejection(400, -32020, 'Mcp-Name header does not match the named request target.');
  }
  if (!expectedName && nameHeader) {
    return rejection(400, -32020, 'Mcp-Name is only valid for a named MCP request.');
  }
  if (hasMcpParamHeader(headers)) {
    return rejection(400, -32020, 'Mcp-Param-* headers are not declared by this server.');
  }
  return { ok: true };
}

async function isLegacyHttpRequest(req: IncomingMessage, message: JsonRpcRequest | null): Promise<boolean> {
  const request = await toWebRequest(req as Parameters<typeof toWebRequest>[0], message);
  return isLegacyRequest(request, message);
}

function sendTransportResponse(ctx: HttpRouteContext, response: McpTransportResponse): void {
  measureMcpPhaseSync('transport.write', () => {
    if (ctx.res.destroyed) return;
    if (typeof response.onDelivered === 'function') ctx.res.once('finish', response.onDelivered);
    if (response.body == null) {
      ctx.res.statusCode = response.status || 204;
      ctx.res.end();
      return;
    }
    sendJson(ctx.res, response.status || 200, response.body);
  });
}

function expectedMcpName(method: string, params: JsonRecord = {}): string {
  if (method === 'tools/call' || method === 'prompts/get') return String(params.name || '');
  if (['resources/read', 'resources/subscribe', 'resources/unsubscribe'].includes(method)) {
    return String(params.uri || '');
  }
  if (TASK_METHODS.includes(method)) return String(params.taskId || '');
  return '';
}

function createHttpRequestAbortScope(
  req: IncomingMessage,
  _res: ServerResponse<IncomingMessage>
): HttpAbortScope {
  const controller = new AbortController();
  const onRequestAborted = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('HTTP MCP request was aborted by the client.'));
  };
  req.once('aborted', onRequestAborted);
  if (req.aborted) onRequestAborted();
  return {
    signal: controller.signal,
    dispose(): void {
      req.off('aborted', onRequestAborted);
    }
  };
}

function createHttpTransportLifecycle(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  details: HttpTransportDetails
): void {
  let cancelled = false;
  let closed = false;
  const onRequestAborted = (): void => {
    if (cancelled) return;
    cancelled = true;
    recordMcpTransportEvent('request_cancelled', {
      ...transportEventDetails(details),
      reasonCode: 'request_aborted'
    });
  };
  const onResponseClosed = (): void => {
    if (res.writableFinished || closed) return;
    closed = true;
    recordMcpTransportEvent('connection_closed', {
      ...transportEventDetails(details),
      reasonCode: 'response_closed_before_delivery'
    });
  };
  const onResponseFinished = (): void => {
    recordMcpTransportEvent('response_delivered', transportEventDetails(details));
  };
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClosed);
  res.once('finish', onResponseFinished);
  if (req.aborted) onRequestAborted();
  if (res.destroyed && !res.writableFinished) onResponseClosed();
}

function transportEventDetails(details: HttpTransportDetails): Record<string, unknown> {
  return {
    ...(details.requestId ? { requestId: details.requestId } : {}),
    ...(details.method ? { method: details.method } : {}),
    ...(details.name ? { name: details.name } : {}),
    elapsedMs: Math.max(0, Date.now() - details.startedAt)
  };
}

function validateTransportOrigin(ctx: HttpRouteContext): boolean {
  const allowed = transportSecurityOptions(ctx);
  const incomingHost = String(ctx.req.headers.host || '');
  let hostName = '';
  try { hostName = new URL(`http://${incomingHost}`).hostname; } catch {}
  if (!hostName || !allowed.allowedHostnames.includes(hostName)) {
    sendMcpProtocolError(ctx.res, 403, -32600, 'Forbidden Host header.');
    return false;
  }
  const origin = String(ctx.req.headers.origin || '');
  if (!origin) return true;
  let originName = '';
  try { originName = new URL(origin).hostname; } catch {}
  if (!originName || !allowed.allowedOriginHostnames.includes(originName)) {
    sendMcpProtocolError(ctx.res, 403, -32600, 'Forbidden Origin header.');
    return false;
  }
  return true;
}

function transportSecurityOptions(ctx: HttpRouteContext): {
  allowedHostnames: string[];
  allowedOriginHostnames: string[];
} {
  const allowedHostnames = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const allowedOriginHostnames = new Set(allowedHostnames);
  try {
    const localUrl = new URL(`http://${ctx.options.host || '127.0.0.1'}:${ctx.options.port || 3333}`);
    allowedHostnames.add(localUrl.hostname);
    allowedOriginHostnames.add(localUrl.hostname);
  } catch {}
  return {
    allowedHostnames: [...allowedHostnames],
    allowedOriginHostnames: [...allowedOriginHostnames]
  };
}

function rejection(status: number, code: number, error: string, data?: unknown): HeaderValidationFailure {
  return { ok: false, status, code, error, ...(data === undefined ? {} : { data }) };
}

function headerValue(headers: IncomingHttpHeaders | JsonRecord, name: string): string {
  const target = String(name).toLowerCase();
  const value = headers[target] ?? headers[name];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function hasMcpParamHeader(headers: IncomingHttpHeaders | JsonRecord = {}): boolean {
  return Object.keys(headers).some(name => String(name).toLowerCase().startsWith('mcp-param-'));
}

function isJsonContentType(value: unknown): boolean {
  return String(value || '').split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function validImplementation(value: unknown): boolean {
  return isPlainObject(value)
    && typeof value.name === 'string'
    && value.name.length > 0
    && typeof value.version === 'string'
    && value.version.length > 0;
}

function objectValue(value: unknown): JsonRecord {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function debug(context: string, error: unknown): void {
  if (process.env.REL_AI_MCP_DEBUG) {
    console.error(`[rel-ai-mcp] ${context}:`, error instanceof Error ? error.message : String(error));
  }
}

async function shutdownMcpTransport(): Promise<void> {
  const handler = coreHandler;
  coreHandler = null;
  coreNodeHandler = null;
  if (handler) await handler.close();
}

export {
  MCP_PROTOCOL_VERSION,
  createHttpRequestAbortScope,
  expectedMcpName,
  handleMcpDelete,
  handleMcpGetDiagnostic,
  handleMcpStreamable,
  sendMcpTransportError,
  shutdownMcpTransport,
  transportSecurityOptions,
  validateMcpRequestHeaders
};
