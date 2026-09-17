import type * as OpenTelemetryApi from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { packageMetadata as pkg } from './packageMetadata.js';
import type { TelemetryConfig, TelemetryStatus } from './telemetry.types.ts';

const REDACTED_ATTRIBUTE = '[redacted]';
const MAX_ATTRIBUTE_CHARS = 1000;
let provider: NodeTracerProvider | null = null;
let runtimeApi: typeof import('@opentelemetry/api') | null = null;
let initializationPromise: Promise<boolean> | null = null;
let initializedEndpoint = '';
let initializedSampleRatio: number | null = null;

type SafeAttributeScalar = string | number | boolean;
type SafeAttributeValue = SafeAttributeScalar | SafeAttributeScalar[];
type SafeAttributes = Record<string, SafeAttributeValue>;

interface RunSpanOptions {
  carrier?: Record<string, unknown>;
  kind?: OpenTelemetryApi.SpanKind;
}

function configuredTelemetryEndpoint(config: TelemetryConfig = {}): string {
  return String(config.telemetry?.endpoint || process.env.REL_AI_OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '').trim();
}

function telemetryEnabled(config: TelemetryConfig = {}): boolean {
  return config.telemetry?.enabled === true;
}

function telemetryEndpoint(config: TelemetryConfig = {}): string {
  return telemetryEnabled(config) ? configuredTelemetryEndpoint(config) : '';
}

function telemetrySampleRatio(config: TelemetryConfig = {}): number {
  const value = Number(config.telemetry?.sampleRatio ?? process.env.REL_AI_OTEL_SAMPLE_RATIO ?? 1);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function initializeTelemetry(config: TelemetryConfig = {}): boolean {
  const endpoint = telemetryEndpoint(config);
  if (!endpoint) return false;
  if (provider || initializationPromise) return true;
  initializationPromise = initializeTelemetryRuntime(config, endpoint)
    .catch(error => {
      initializationPromise = null;
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] telemetry initialization:', error);
      return false;
    });
  return true;
}

async function initializeTelemetryRuntime(config: TelemetryConfig, endpoint: string): Promise<boolean> {
  const [api, sdk, exporterModule, resources, conventions] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions')
  ]);
  if (provider) return true;
  const sampleRatio = telemetrySampleRatio(config);
  const exporter = new exporterModule.OTLPTraceExporter({ url: endpoint });
  provider = new sdk.NodeTracerProvider({
    resource: resources.resourceFromAttributes({
      [conventions.ATTR_SERVICE_NAME]: 'rel-ai-mcp',
      [conventions.ATTR_SERVICE_VERSION]: pkg.version,
      'service.instance.id': String(process.pid),
      'relai.telemetry.mode': 'optional'
    }),
    sampler: new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(sampleRatio) }),
    spanProcessors: [new sdk.BatchSpanProcessor(exporter)]
  });
  provider.register();
  runtimeApi = api;
  initializedEndpoint = endpoint;
  initializedSampleRatio = sampleRatio;
  return true;
}

async function initializedTelemetryApi(config: TelemetryConfig): Promise<typeof import('@opentelemetry/api') | null> {
  if (!telemetryEndpoint(config)) return null;
  initializeTelemetry(config);
  const initialized = await initializationPromise;
  return initialized && provider ? runtimeApi : null;
}

function sanitizeAttributes(attributes: Record<string, unknown> = {}): SafeAttributes {
  const safe: SafeAttributes = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value == null) continue;
    if (/token|secret|password|authorization|api[_-]?key|file\.content|command\.env|approval/i.test(key)) {
      safe[key] = REDACTED_ATTRIBUTE;
      continue;
    }
    if (/(?:^|\.)(?:command|command_line)$/i.test(key)) {
      safe[key] = summarizeCommandForTelemetry(value);
      continue;
    }
    if (Array.isArray(value)) {
      safe[key] = value.slice(0, 100).map(item => sanitizeScalar(item));
      continue;
    }
    safe[key] = sanitizeScalar(value);
  }
  return safe;
}

function summarizeCommandForTelemetry(value: unknown): string {
  const parts = String(value || '').replace(/[\r\n\t]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  const executable = summarizeExecutable(parts[0]);
  return parts.length === 1 ? executable : `${executable} [${parts.length - 1} args]`;
}

function summarizeExecutable(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.replaceAll('\\\\', '/').replaceAll('\\', '/');
  return normalized.split('/').filter(Boolean).at(-1) || '[executable]';
}

function sanitizeScalar(value: unknown): SafeAttributeScalar {
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  const text = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > MAX_ATTRIBUTE_CHARS ? `${text.slice(0, MAX_ATTRIBUTE_CHARS - 1)}…` : text;
}

function traceContextEnvironment(): Record<string, string> {
  const api = runtimeApi;
  if (!api || !provider) return {};
  const carrier: Record<string, string> = {};
  const setter: OpenTelemetryApi.TextMapSetter<Record<string, string>> = {
    set: (target, key, value) => { target[String(key).toLowerCase()] = String(value); }
  };
  api.propagation.inject(api.context.active(), carrier, setter);
  return {
    ...(carrier.traceparent ? { TRACEPARENT: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { TRACESTATE: carrier.tracestate } : {})
  };
}

function extractTraceContext(api: typeof import('@opentelemetry/api'), carrier: Record<string, unknown> = {}): OpenTelemetryApi.Context {
  const getter: OpenTelemetryApi.TextMapGetter<Record<string, unknown>> = {
    keys: source => Object.keys(source || {}),
    get: (source, key) => (source?.[String(key).toLowerCase()] ?? source?.[key]) as string | string[] | undefined
  };
  return api.propagation.extract(api.context.active(), carrier || {}, getter);
}

async function runSpan<T>(
  config: TelemetryConfig,
  name: unknown,
  attributes: Record<string, unknown>,
  operation: () => T | Promise<T>,
  options: RunSpanOptions = {}
): Promise<T> {
  const api = await initializedTelemetryApi(config);
  if (!api) return operation();
  const parentContext = options.carrier ? extractTraceContext(api, options.carrier) : api.context.active();
  const span = api.trace.getTracer('rel-ai-mcp', pkg.version).startSpan(String(name || 'relai.operation'), {
    attributes: sanitizeAttributes(attributes) as OpenTelemetryApi.Attributes,
    kind: options.kind || api.SpanKind.INTERNAL
  }, parentContext);
  try {
    return await api.context.with(api.trace.setSpan(parentContext, span), operation);
  } catch (error) {
    span.setAttribute('relai.error.type', safeExceptionType(error));
    span.setStatus({ code: api.SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

function safeExceptionType(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'AggregateError']).has(name)
    ? name
    : error instanceof Error ? 'Error' : 'NonErrorThrow';
}

function addSpanEvent(name: unknown, attributes: Record<string, unknown> = {}): void {
  const api = runtimeApi;
  if (!api || !provider) return;
  api.trace.getSpan(api.context.active())?.addEvent(String(name || 'event'), sanitizeAttributes(attributes) as OpenTelemetryApi.Attributes);
}

function setSpanAttributes(attributes: Record<string, unknown> = {}): void {
  const api = runtimeApi;
  if (!api || !provider) return;
  api.trace.getSpan(api.context.active())?.setAttributes(sanitizeAttributes(attributes) as OpenTelemetryApi.Attributes);
}

async function shutdownTelemetry(): Promise<void> {
  if (initializationPromise) await initializationPromise.catch(() => false);
  const current = provider;
  provider = null;
  runtimeApi = null;
  initializationPromise = null;
  initializedEndpoint = '';
  initializedSampleRatio = null;
  if (current) await current.shutdown();
}

function telemetryStatus(config: TelemetryConfig = {}): TelemetryStatus {
  const endpointConfigured = Boolean(configuredTelemetryEndpoint(config));
  const enabled = telemetryEnabled(config) && endpointConfigured;
  return {
    enabled,
    initialized: enabled && Boolean(provider),
    exporter: enabled && provider ? 'otlp-http' : '',
    endpointConfigured,
    endpoint: enabled && initializedEndpoint ? '[configured]' : '',
    sampleRatio: initializedSampleRatio ?? telemetrySampleRatio(config)
  };
}

export {
  initializeTelemetry,
  runSpan,
  addSpanEvent,
  setSpanAttributes,
  shutdownTelemetry,
  telemetryStatus,
  sanitizeAttributes,
  summarizeCommandForTelemetry,
  telemetrySampleRatio,
  traceContextEnvironment
};
