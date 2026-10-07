import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readConfig } from '../config.js';
import { scheduleLocalTransportEvent } from '../localAnalytics.ts';
import { createRelaiCoreRuntime } from './runtime.ts';
import { createLocalAdminPolicy } from '../mcp/authorizationPolicy.ts';
import { MCP_AUTH_MODE, type McpAuthMode } from '../contracts/mcp.ts';
import { mcpConnectionManager } from '../mcp/connectionManager.js';
import {
  LEGACY_LIFECYCLE_METHODS,
  MCP_PROTOCOL_VERSION,
  validateJsonRpcRequestEnvelope
} from '../mcp/protocol.js';
import { createHttpPrincipal, createStdioPrincipal, principalFingerprint } from '../mcp/principal.ts';
import { handleMcpEventRequest } from '../mcp/events.ts';
import { buildToolManifest } from '../mcp/toolManifest.js';
import { acknowledgeFallbackCompletionDelivery } from '../mcp/fallbackExecutions.js';
import { createFallbackAwareStdioTransport, handleTransportFallbackRequest } from '../mcp/transportFallback.ts';
import { createRelaiMcpServer, SERVER_INSTANCE_ID } from '../mcpServer.ts';
import {
  measurePerformancePhase,
  measurePerformancePhaseSync,
  performanceTimingAttributes,
  withPerformanceBreakdownIfAbsent
} from '../performanceObservability.ts';
import { runSpan, setSpanAttributes } from '../telemetry.ts';

export { LEGACY_LIFECYCLE_METHODS, MCP_PROTOCOL_VERSION, SERVER_INSTANCE_ID };
export { recordTransportTiming } from '../transportTiming.ts';

export interface McpAuthorization {
  authMode: McpAuthMode;
  authInfo: {
    clientId: string;
    scopes: string[];
    authorizationPolicy: unknown;
  };
}

export interface CoreMcpRequestContext {
  readonly config: Record<string, unknown>;
  readonly principal: unknown;
}

export interface McpEnvelopeValidation extends Record<string, unknown> {
  readonly ok: boolean;
  readonly code?: number;
  readonly error?: string;
  readonly data?: unknown;
}

export interface McpTransportResponse {
  readonly status?: number;
  readonly body?: Record<string, unknown> | null;
  readonly onDelivered?: () => void;
}

export function createLocalMcpAuthorization(authMode: McpAuthMode, clientId: string): McpAuthorization {
  return {
    authMode,
    authInfo: { clientId, scopes: ['mcp'], authorizationPolicy: createLocalAdminPolicy() }
  };
}

export function createMcpServerForRequest(
  authInfo: Record<string, unknown>,
  era: string
): ReturnType<typeof createRelaiMcpServer> {
  const authMode = String(authInfo.authMode || MCP_AUTH_MODE.STATIC_BEARER);
  return createRelaiMcpServer({
    config: readConfig(),
    publicHttpOnly: true,
    transportType: 'streamable-http',
    legacyCompatibility: era === 'legacy',
    principal: createHttpPrincipal(authInfo, authMode),
    requestId: String(authInfo.relaiRequestId || '')
  });
}

export function createMcpRequestContext(authInfo: Record<string, unknown>, authMode: string): CoreMcpRequestContext {
  return Object.freeze({
    config: readConfig(),
    principal: createHttpPrincipal(authInfo, authMode)
  });
}

export function validateMcpRequestEnvelope(message: unknown): McpEnvelopeValidation {
  return validateJsonRpcRequestEnvelope(message) as McpEnvelopeValidation;
}

export function noteMcpAuthenticationFailure(reason: string): void {
  mcpConnectionManager.noteAuthenticationFailure(reason);
}

export function beginMcpRequest(details: Record<string, unknown>): string {
  return mcpConnectionManager.beginRequest(details);
}

export function finishMcpRequest(requestId: string, details: Record<string, unknown>): void {
  mcpConnectionManager.finishRequest(requestId, details);
}

export function recordMcpTransportEvent(event: string, details: Record<string, unknown> = {}): void {
  try {
    scheduleLocalTransportEvent(readConfig(), { event });
  } catch {}
  try {
    mcpConnectionManager.record(`mcp_transport_${event}`, details);
  } catch {}
}

export function observeMcpRequestManifest(context: CoreMcpRequestContext, method: string): Promise<void> {
  return mcpConnectionManager.observeManifest(buildToolManifest(context.config), method);
}

export function handleMcpFallbackRequest(
  context: CoreMcpRequestContext,
  message: unknown,
  options: Record<string, unknown>
): Promise<McpTransportResponse | null | undefined> {
  return handleTransportFallbackRequest(context.config, message, {
    ...options,
    principal: context.principal,
    transportType: 'streamable-http'
  }) as Promise<McpTransportResponse | null | undefined>;
}

export function acknowledgeMcpFallbackCompletionDelivery(
  context: CoreMcpRequestContext,
  requestId: unknown
): boolean {
  return acknowledgeFallbackCompletionDelivery(principalFingerprint(context.principal), requestId);
}

export function handleMcpEventsRequest(
  context: CoreMcpRequestContext,
  message: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  return handleMcpEventRequest(context.config, context.principal, message);
}

export function withMcpPerformanceBreakdown<T>(operation: () => T): T {
  return withPerformanceBreakdownIfAbsent(operation);
}

export function measureMcpPhase<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
  return Promise.resolve(measurePerformancePhase(name, operation));
}

export function measureMcpPhaseSync<T>(name: string, operation: () => T): T {
  return measurePerformancePhaseSync(name, operation);
}

export function finishMcpSpanTimings(): void {
  setSpanAttributes(performanceTimingAttributes());
}

export function runMcpRequestSpan<T>(
  context: CoreMcpRequestContext,
  details: { protocolVersion?: unknown; method?: unknown; principalId?: unknown; carrier?: Record<string, unknown> },
  callback: () => Promise<T>
): Promise<T> {
  return runSpan(context.config, 'relai.mcp.request', {
    'mcp.protocol.version': String(details.protocolVersion || ''),
    'mcp.method': String(details.method || ''),
    'mcp.authenticated': Boolean(details.principalId)
  }, callback, { carrier: details.carrier || {} });
}

export async function startMcpStdio(): Promise<unknown> {
  const coreRuntime = createRelaiCoreRuntime();
  coreRuntime.start();
  const config = coreRuntime.config;
  const principal = createStdioPrincipal();
  const transport: ReturnType<typeof createFallbackAwareStdioTransport> = createFallbackAwareStdioTransport({ config, principal });
  const cleanup = (): Promise<unknown> => coreRuntime.shutdown();

  process.once('SIGINT', () => { void cleanup().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(0)); });
  process.once('beforeExit', () => { void cleanup(); });

  const handle = serveStdio(
    () => createRelaiMcpServer({
      config,
      transportType: 'stdio',
      principal
    }),
    {
      legacy: 'reject',
      transport,
      onerror(error: unknown) {
        console.error(`[rel-ai-mcp] MCP stdio error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    void cleanup();
  };
  return handle;
}
