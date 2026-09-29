import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type * as OpenTelemetryApi from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { packageMetadata as pkg } from './packageMetadata.js';
import { getStateDir } from './stateLayout.js';
import type { TelemetryConfig, TelemetryStatus } from './telemetry.types.ts';

const REDACTED_ATTRIBUTE = '[redacted]';
const MAX_ATTRIBUTE_CHARS = 1000;
const TELEMETRY_IDENTITY_SCHEMA_VERSION = 1;
const USAGE_HEARTBEAT_MS = 24 * 60 * 60 * 1000;
const USAGE_RETRY_MS = 5 * 60 * 1000;
const USAGE_REQUEST_TIMEOUT_MS = 5000;
let diagnosticsProvider: NodeTracerProvider | null = null;
let usageHeartbeat: ReturnType<typeof setInterval> | null = null;
let usageRetryTimer: ReturnType<typeof setTimeout> | null = null;
let usageRequestPromise: Promise<boolean> | null = null;
let usageReportingStarted = false;
let runtimeApi: typeof import('@opentelemetry/api') | null = null;
let initializationPromise: Promise<boolean> | null = null;
let runtimeDiagnosticsEnabledOverride: boolean | null = null;
let initializedDiagnosticsEndpoint = '';
let initializedSampleRatio: number | null = null;

type SafeAttributeScalar = string | number | boolean;
type SafeAttributeValue = SafeAttributeScalar | SafeAttributeScalar[];
type SafeAttributes = Record<string, SafeAttributeValue>;

interface RunSpanOptions {
  carrier?: Record<string, unknown>;
  kind?: OpenTelemetryApi.SpanKind;
}

function officialTelemetryEndpointsEnabled(): boolean {
  return process.env.REL_AI_OFFICIAL_BUILD === '1';
}

function configuredMaintainerUsageEndpoint(): string {
  const override = String(process.env.REL_AI_MAINTAINER_USAGE_ENDPOINT || '').trim();
  if (override) return override;
  if (!officialTelemetryEndpointsEnabled()) return '';
  return String((pkg as { relaiTelemetry?: { usageEndpoint?: unknown } }).relaiTelemetry?.usageEndpoint || '').trim();
}

function configuredMaintainerDiagnosticsEndpoint(): string {
  const override = String(process.env.REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT || '').trim();
  if (override) return override;
  if (!officialTelemetryEndpointsEnabled()) return '';
  return String((pkg as { relaiTelemetry?: { diagnosticsEndpoint?: unknown } }).relaiTelemetry?.diagnosticsEndpoint || '').trim();
}

function configuredDiagnosticsEndpoint(config: TelemetryConfig = {}): string {
  return String(
    config.telemetry?.endpoint
    || process.env.REL_AI_OTEL_EXPORTER_OTLP_ENDPOINT
    || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || configuredMaintainerDiagnosticsEndpoint()
    || ''
  ).trim();
}

function telemetryEnabled(config: TelemetryConfig = {}): boolean {
  return runtimeDiagnosticsEnabledOverride ?? config.telemetry?.diagnosticsEnabled !== false;
}

function telemetryEndpoint(config: TelemetryConfig = {}): string {
  return telemetryEnabled(config) ? configuredDiagnosticsEndpoint(config) : '';
}

function telemetrySampleRatio(config: TelemetryConfig = {}): number {
  const value = Number(config.telemetry?.sampleRatio ?? process.env.REL_AI_OTEL_SAMPLE_RATIO ?? 1);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function initializeTelemetry(config: TelemetryConfig = {}): boolean {
  const usageEndpoint = configuredMaintainerUsageEndpoint();
  const diagnosticsEndpoint = configuredDiagnosticsEndpoint(config);
  if (usageEndpoint && !usageReportingStarted) startUsageReporter(config, usageEndpoint);

  const needsDiagnostics = telemetryEnabled(config) && Boolean(diagnosticsEndpoint) && !diagnosticsProvider;
  if (!needsDiagnostics) return usageReportingStarted || Boolean(diagnosticsProvider);
  if (initializationPromise) return true;
  const pending = initializeTelemetryRuntime(config, diagnosticsEndpoint)
    .catch(error => {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] telemetry initialization:', error);
      return false;
    });
  initializationPromise = pending;
  void pending.finally(() => {
    if (initializationPromise === pending) initializationPromise = null;
  });
  return true;
}

function startUsageReporter(config: TelemetryConfig, endpoint: string): void {
  usageReportingStarted = true;
  void reportInstallationPresence(config, endpoint).then(success => {
    if (!success) scheduleUsageRetry(config, endpoint);
  });
  usageHeartbeat = setInterval(() => {
    void reportInstallationPresence(config, endpoint).then(success => {
      if (!success) scheduleUsageRetry(config, endpoint);
    });
  }, USAGE_HEARTBEAT_MS);
  usageHeartbeat.unref?.();
}

function scheduleUsageRetry(config: TelemetryConfig, endpoint: string): void {
  if (usageRetryTimer) return;
  usageRetryTimer = setTimeout(() => {
    usageRetryTimer = null;
    void reportInstallationPresence(config, endpoint).then(success => {
      if (!success) scheduleUsageRetry(config, endpoint);
    });
  }, USAGE_RETRY_MS);
  usageRetryTimer.unref?.();
}

async function reportInstallationPresence(config: TelemetryConfig, endpoint: string): Promise<boolean> {
  if (usageRequestPromise) return usageRequestPromise;
  const pending = reportInstallationPresenceRuntime(config, endpoint)
    .catch(error => {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] usage reporting:', error);
      return false;
    });
  usageRequestPromise = pending;
  void pending.finally(() => {
    if (usageRequestPromise === pending) usageRequestPromise = null;
  });
  return pending;
}

async function reportInstallationPresenceRuntime(config: TelemetryConfig, endpoint: string): Promise<boolean> {
  const identity = usageIdentity(config);
  const now = Date.now();
  const lastReportedAt = Date.parse(String(identity.state.lastReportedAt || ''));
  const lastReportedVersion = String(identity.state.lastReportedVersion || '');
  if (
    lastReportedVersion === pkg.version
    && Number.isFinite(lastReportedAt)
    && now - lastReportedAt < USAGE_HEARTBEAT_MS
  ) return true;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 1,
      installationId: identity.installationId,
      version: pkg.version,
      platform: process.platform,
      arch: process.arch
    }),
    signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) return false;

  const reportedAt = new Date(now).toISOString();
  writeJsonAtomic(identity.file, {
    ...identity.state,
    schemaVersion: TELEMETRY_IDENTITY_SCHEMA_VERSION,
    installationId: identity.installationId,
    createdAt: identity.state.createdAt || reportedAt,
    lastReportedAt: reportedAt,
    lastReportedVersion: pkg.version
  }, { mode: 0o600, backup: true });
  return true;
}

async function initializeTelemetryRuntime(config: TelemetryConfig, diagnosticsEndpoint: string): Promise<boolean> {
  const [api, sdk, exporterModule, resources, conventions] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions')
  ]);
  runtimeApi = api;
  if (telemetryEnabled(config) && diagnosticsEndpoint && !diagnosticsProvider) {
    const sampleRatio = telemetrySampleRatio(config);
    const diagnosticsExporter = new exporterModule.OTLPTraceExporter({ url: diagnosticsEndpoint });
    diagnosticsProvider = new sdk.NodeTracerProvider({
      resource: resources.resourceFromAttributes({
        [conventions.ATTR_SERVICE_VERSION]: pkg.version,
        [conventions.ATTR_SERVICE_NAME]: 'rel-ai-mcp',
        'service.instance.id': String(process.pid),
        'relai.telemetry.mode': 'diagnostics'
      }),
      sampler: new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(sampleRatio) }),
      spanProcessors: [new sdk.BatchSpanProcessor(diagnosticsExporter)]
    });
    diagnosticsProvider.register();
    initializedDiagnosticsEndpoint = diagnosticsEndpoint;
    initializedSampleRatio = sampleRatio;
  }
  return true;
}

function usageIdentity(config: TelemetryConfig = {}): {
  file: string;
  state: Record<string, unknown>;
  installationId: string;
} {
  const file = path.join(getStateDir(config as Record<string, unknown>), 'telemetry-identity.json');
  const stored = readJsonFile<Record<string, unknown>>(file, {
    validate: value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }) || {};
  const existing = String(stored.installationId || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
    return { file, state: stored, installationId: existing };
  }

  const createdAt = new Date().toISOString();
  const installationId = crypto.randomUUID();
  const state = {
    schemaVersion: TELEMETRY_IDENTITY_SCHEMA_VERSION,
    installationId,
    createdAt
  };
  writeJsonAtomic(file, state, { mode: 0o600, backup: true });
  return { file, state, installationId };
}

function installationId(config: TelemetryConfig = {}): string {
  return usageIdentity(config).installationId;
}

async function initializedTelemetryApi(config: TelemetryConfig): Promise<typeof import('@opentelemetry/api') | null> {
  if (!telemetryEndpoint(config)) return null;
  initializeTelemetry(config);
  if (initializationPromise) await initializationPromise;
  return diagnosticsProvider ? runtimeApi : null;
}

async function setTelemetryDiagnosticsEnabled(config: TelemetryConfig, enabled: boolean): Promise<void> {
  runtimeDiagnosticsEnabledOverride = enabled === true;
  if (!runtimeDiagnosticsEnabledOverride) return;
  initializeTelemetry(config);
  if (initializationPromise) await initializationPromise;
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
  if (!api || !diagnosticsProvider) return {};
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
  if (!api || !diagnosticsProvider) return;
  api.trace.getSpan(api.context.active())?.addEvent(String(name || 'event'), sanitizeAttributes(attributes) as OpenTelemetryApi.Attributes);
}

function setSpanAttributes(attributes: Record<string, unknown> = {}): void {
  const api = runtimeApi;
  if (!api || !diagnosticsProvider) return;
  api.trace.getSpan(api.context.active())?.setAttributes(sanitizeAttributes(attributes) as OpenTelemetryApi.Attributes);
}

async function shutdownTelemetry(): Promise<void> {
  if (initializationPromise) await initializationPromise.catch(() => false);
  if (usageRequestPromise) await usageRequestPromise.catch(() => false);
  const currentDiagnostics = diagnosticsProvider;
  diagnosticsProvider = null;
  runtimeApi = null;
  initializationPromise = null;
  usageRequestPromise = null;
  usageReportingStarted = false;
  runtimeDiagnosticsEnabledOverride = null;
  if (usageHeartbeat) clearInterval(usageHeartbeat);
  usageHeartbeat = null;
  if (usageRetryTimer) clearTimeout(usageRetryTimer);
  usageRetryTimer = null;
  initializedDiagnosticsEndpoint = '';
  initializedSampleRatio = null;
  await currentDiagnostics?.shutdown();
}

function telemetryStatus(config: TelemetryConfig = {}): TelemetryStatus {
  const endpointConfigured = Boolean(configuredDiagnosticsEndpoint(config));
  const diagnosticsEnabled = telemetryEnabled(config) && endpointConfigured;
  const usageReportingEnabled = Boolean(configuredMaintainerUsageEndpoint());
  return {
    enabled: diagnosticsEnabled,
    diagnosticsEnabled,
    usageReportingEnabled,
    initialized: diagnosticsEnabled && Boolean(diagnosticsProvider),
    usageInitialized: usageReportingEnabled && usageReportingStarted,
    exporter: diagnosticsEnabled && diagnosticsProvider ? 'otlp-http' : '',
    endpointConfigured,
    endpoint: endpointConfigured && initializedDiagnosticsEndpoint ? '[configured]' : '',
    sampleRatio: initializedSampleRatio ?? telemetrySampleRatio(config)
  };
}

export {
  initializeTelemetry,
  runSpan,
  addSpanEvent,
  setSpanAttributes,
  shutdownTelemetry,
  setTelemetryDiagnosticsEnabled,
  telemetryStatus,
  sanitizeAttributes,
  summarizeCommandForTelemetry,
  telemetrySampleRatio,
  traceContextEnvironment
};
