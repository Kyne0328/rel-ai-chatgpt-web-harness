import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type * as OpenTelemetryApi from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { packageMetadata as pkg } from './packageMetadata.js';
import { getStateDir } from './stateLayout.js';
import { redactCommandSecrets } from './commandDisplay.js';
import { failureCategoryFromCode } from './analyticsFailureCategory.ts';
import { acknowledgeDiagnosticFailures, clearQueuedDiagnosticFailures, queuedDiagnosticFailures, retainFailedDiagnosticBatch } from './diagnosticRetrySpool.ts';
import type { TelemetryConfig, TelemetryStatus } from './telemetry.types.ts';

const REDACTED_ATTRIBUTE = '[redacted]';
const MAX_ATTRIBUTE_CHARS = 1000;
const TELEMETRY_IDENTITY_SCHEMA_VERSION = 2;
const USAGE_REPORT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const USAGE_RETRY_MS = 5 * 60 * 1000;
const USAGE_REQUEST_TIMEOUT_MS = 5000;
let diagnosticsProvider: NodeTracerProvider | null = null;
let usageHeartbeat: ReturnType<typeof setTimeout> | null = null;
let usageRetryTimer: ReturnType<typeof setTimeout> | null = null;
let usageRequestPromise: Promise<boolean> | null = null;
let usageReportingStarted = false;
let runtimeApi: typeof import('@opentelemetry/api') | null = null;
let initializationPromise: Promise<boolean> | null = null;
let runtimeDiagnosticsEnabledOverride: boolean | null = null;
let diagnosticsConsentGeneration = 0;
let initializedDiagnosticsEndpoint = '';
let initializedSampleRatio: number | null = null;
let usageLastAttemptAt = '';
let usageLastSuccessAt = '';
let usageLastFailureAt = '';
let diagnosticsLastAttemptAt = '';
let diagnosticsLastSuccessAt = '';
let diagnosticsLastFailureAt = '';
let diagnosticReplayTimer: ReturnType<typeof setTimeout> | null = null;
const diagnosticReplayInFlight = new Set<string>();
let diagnosticFailureStorageDrops = 0;
let diagnosticsBatchesAttempted = 0;
let diagnosticsBatchesDelivered = 0;
let diagnosticsBatchesFailed = 0;
let diagnosticsReplayedFailureReports = 0;

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

  if (!telemetryEnabled(config)) {
    try { clearQueuedDiagnosticFailures(config); } catch { diagnosticFailureStorageDrops += 1; }
  }
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
    if (success) scheduleNextUsageReport(config, endpoint);
    else scheduleUsageRetry(config, endpoint);
  });
}

function scheduleNextUsageReport(config: TelemetryConfig, endpoint: string): void {
  if (usageHeartbeat) clearTimeout(usageHeartbeat);
  const identity = usageIdentity(config);
  const lastReportedAt = Date.parse(String(identity.state.lastReportedAt || ''));
  const lastReportedVersion = String(identity.state.lastReportedVersion || '');
  const elapsed = lastReportedVersion === pkg.version && Number.isFinite(lastReportedAt)
    ? Math.max(0, Date.now() - lastReportedAt)
    : USAGE_REPORT_INTERVAL_MS;
  const delay = Math.max(1000, USAGE_REPORT_INTERVAL_MS - elapsed);
  usageHeartbeat = setTimeout(() => {
    usageHeartbeat = null;
    void reportInstallationPresence(config, endpoint).then(success => {
      if (success) scheduleNextUsageReport(config, endpoint);
      else scheduleUsageRetry(config, endpoint);
    });
  }, delay);
  usageHeartbeat.unref?.();
}

function scheduleUsageRetry(config: TelemetryConfig, endpoint: string): void {
  if (usageRetryTimer) return;
  usageRetryTimer = setTimeout(() => {
    usageRetryTimer = null;
    void reportInstallationPresence(config, endpoint).then(success => {
      if (success) scheduleNextUsageReport(config, endpoint);
      else scheduleUsageRetry(config, endpoint);
    });
  }, USAGE_RETRY_MS);
  usageRetryTimer.unref?.();
}

async function reportInstallationPresence(config: TelemetryConfig, endpoint: string): Promise<boolean> {
  if (usageRequestPromise) return usageRequestPromise;
  const pending = reportInstallationPresenceRuntime(config, endpoint)
    .catch(error => {
      usageLastFailureAt = new Date().toISOString();
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
    && now - lastReportedAt < USAGE_REPORT_INTERVAL_MS
  ) return true;

  usageLastAttemptAt = new Date(now).toISOString();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${identity.ingestToken}`
    },
    body: JSON.stringify({
      schemaVersion: 1,
      installationId: identity.installationId,
      version: pkg.version,
      platform: process.platform,
      arch: process.arch
    }),
    signal: AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) {
    usageLastFailureAt = new Date().toISOString();
    return false;
  }

  const reportedAt = new Date(now).toISOString();
  usageLastSuccessAt = reportedAt;
  writeJsonAtomic(identity.file, {
    ...identity.state,
    schemaVersion: TELEMETRY_IDENTITY_SCHEMA_VERSION,
    installationId: identity.installationId,
    ingestToken: identity.ingestToken,
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
    const maintainerDiagnosticsEndpoint = configuredMaintainerDiagnosticsEndpoint();
    const maintainerIdentity = diagnosticsEndpoint === maintainerDiagnosticsEndpoint ? usageIdentity(config) : null;
    const baseExporter = new exporterModule.OTLPTraceExporter({
      url: diagnosticsEndpoint,
      ...(maintainerIdentity ? {
        headers: {
          authorization: `Bearer ${maintainerIdentity.ingestToken}`,
          'x-relai-installation-id': maintainerIdentity.installationId
        }
      } : {})
    });
    const spanConsentGenerations = new WeakMap<object, number>();
    const diagnosticsExporter = {
      export(spans: Parameters<typeof baseExporter.export>[0], resultCallback: Parameters<typeof baseExporter.export>[1]) {
        const allowedSpans = telemetryEnabled(config)
          ? spans.filter(span => spanConsentGenerations.get(span) === diagnosticsConsentGeneration)
          : [];
        if (!allowedSpans.length) {
          resultCallback({ code: 0 });
          return;
        }
        diagnosticsLastAttemptAt = new Date().toISOString();
        diagnosticsBatchesAttempted += 1;
        const exportConsentGeneration = diagnosticsConsentGeneration;
        const replayIds = allowedSpans.map(span => span.attributes?.['relai.telemetry.replay_id'])
          .filter((id): id is string => typeof id === 'string');
        baseExporter.export(allowedSpans, result => {
          const success = result?.code === 0;
          if (success) {
            diagnosticsLastSuccessAt = new Date().toISOString();
            diagnosticsBatchesDelivered += 1;
            diagnosticsReplayedFailureReports += replayIds.length;
          } else {
            diagnosticsLastFailureAt = new Date().toISOString();
            diagnosticsBatchesFailed += 1;
          }
          if (telemetryEnabled(config) && exportConsentGeneration === diagnosticsConsentGeneration) {
            try {
              if (success) acknowledgeDiagnosticFailures(config, replayIds);
              else retainFailedDiagnosticBatch(config, allowedSpans.map(span => ({
                name: span.name, attributes: span.attributes, status: span.status
              })));
              if (!success && queuedDiagnosticFailures(config).length) scheduleDiagnosticReplay(config, 60_000);
            } catch { diagnosticFailureStorageDrops += 1; }
          }
          for (const id of replayIds) diagnosticReplayInFlight.delete(id);
          resultCallback(result);
        });
      },
      shutdown: () => baseExporter.shutdown()
    };
    const batchProcessor = new sdk.BatchSpanProcessor(diagnosticsExporter);
    diagnosticsProvider = new sdk.NodeTracerProvider({
      resource: resources.resourceFromAttributes({
        [conventions.ATTR_SERVICE_VERSION]: pkg.version,
        [conventions.ATTR_SERVICE_NAME]: 'rel-ai-mcp',
        'service.instance.id': String(process.pid),
        'os.type': process.platform,
        'host.arch': process.arch,
        ...(maintainerIdentity ? {
          'relai.diagnostic.installation': crypto.createHash('sha256')
            .update('relai-diagnostic-cohort-v1:').update(maintainerIdentity.ingestToken).digest('hex').slice(0, 24)
        } : {}),
        'relai.telemetry.mode': 'diagnostics'
      }),
      sampler: new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(sampleRatio) }),
      spanProcessors: [{
        onStart(span, parentContext) {
          if (telemetryEnabled(config)) spanConsentGenerations.set(span, diagnosticsConsentGeneration);
          batchProcessor.onStart(span, parentContext);
        },
        onEnd: span => batchProcessor.onEnd(span),
        forceFlush: () => batchProcessor.forceFlush(),
        shutdown: () => batchProcessor.shutdown()
      }]
    });
    diagnosticsProvider.register();
    initializedDiagnosticsEndpoint = diagnosticsEndpoint;
    initializedSampleRatio = sampleRatio;
    scheduleDiagnosticReplay(config, 1_000);
  }
  return true;
}

function scheduleDiagnosticReplay(config: TelemetryConfig, delayMs: number): void {
  if (diagnosticReplayTimer || !telemetryEnabled(config)) return;
  diagnosticReplayTimer = setTimeout(() => {
    diagnosticReplayTimer = null;
    replayQueuedDiagnostics(config);
  }, delayMs);
  diagnosticReplayTimer.unref?.();
}

function replayQueuedDiagnostics(config: TelemetryConfig): number {
  if (!telemetryEnabled(config) || !runtimeApi || !diagnosticsProvider || telemetrySampleRatio(config) <= 0) return 0;
  let started = 0;
  try {
    const tracer = runtimeApi.trace.getTracer('rel-ai-mcp', pkg.version);
    // Previously sampled failures must remain reportable after a temporary outage
    // even when the ordinary trace sampling ratio is below 100%.
    const sampledParent = runtimeApi.trace.setSpanContext(runtimeApi.context.active(), {
      traceId: crypto.randomBytes(16).toString('hex'),
      spanId: crypto.randomBytes(8).toString('hex'),
      traceFlags: runtimeApi.TraceFlags.SAMPLED
    });
    for (const record of queuedDiagnosticFailures(config)) {
      if (diagnosticReplayInFlight.has(record.id)) continue;
      diagnosticReplayInFlight.add(record.id);
      const span = tracer.startSpan('relai.telemetry.failure_replay', {
        attributes: sanitizeAttributes({
          'relai.telemetry.replay_id': record.id,
          'relai.failure.observed_at': record.observedAt,
          'relai.tool.name': record.tool,
          'relai.tool.outcome': record.outcome,
          'relai.error.code': record.code,
          'relai.error.category': record.category
        }) as OpenTelemetryApi.Attributes
      }, sampledParent);
      span.end();
      if (span.isRecording()) started += 1;
      else diagnosticReplayInFlight.delete(record.id);
    }
  } catch { diagnosticFailureStorageDrops += 1; }
  return started;
}

function usageIdentity(config: TelemetryConfig = {}): {
  file: string;
  state: Record<string, unknown>;
  installationId: string;
  ingestToken: string;
} {
  const file = path.join(getStateDir(config as Record<string, unknown>), 'telemetry-identity.json');
  const stored = readJsonFile<Record<string, unknown>>(file, {
    validate: value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  }) || {};
  const existing = String(stored.installationId || '').trim();
  const existingToken = String(stored.ingestToken || '').trim();
  const installationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)
    ? existing
    : crypto.randomUUID();
  const ingestToken = /^[A-Za-z0-9_-]{40,128}$/.test(existingToken)
    ? existingToken
    : crypto.randomBytes(32).toString('base64url');
  const createdAt = String(stored.createdAt || '').trim() || new Date().toISOString();
  const needsWrite = installationId !== existing || ingestToken !== existingToken || stored.schemaVersion !== TELEMETRY_IDENTITY_SCHEMA_VERSION;
  const state = {
    ...stored,
    schemaVersion: TELEMETRY_IDENTITY_SCHEMA_VERSION,
    installationId,
    ingestToken,
    createdAt
  };
  if (needsWrite) writeJsonAtomic(file, state, { mode: 0o600, backup: true });
  return { file, state, installationId, ingestToken };
}

function installationId(config: TelemetryConfig = {}): string {
  return usageIdentity(config).installationId;
}

async function initializedTelemetryApi(config: TelemetryConfig): Promise<typeof import('@opentelemetry/api') | null> {
  if (!telemetryEndpoint(config)) return null;
  initializeTelemetry(config);
  if (initializationPromise) await initializationPromise;
  return telemetryEnabled(config) && diagnosticsProvider ? runtimeApi : null;
}

async function setTelemetryDiagnosticsEnabled(config: TelemetryConfig, enabled: boolean): Promise<void> {
  runtimeDiagnosticsEnabledOverride = enabled === true;
  if (!runtimeDiagnosticsEnabledOverride) {
    diagnosticsConsentGeneration += 1;
    if (diagnosticReplayTimer) clearTimeout(diagnosticReplayTimer);
    diagnosticReplayTimer = null;
    diagnosticReplayInFlight.clear();
    clearQueuedDiagnosticFailures(config);
    return;
  }
  initializeTelemetry(config);
  if (initializationPromise) await initializationPromise;
}

function sanitizeAttributes(attributes: Record<string, unknown> = {}): SafeAttributes {
  const safe: SafeAttributes = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value == null) continue;
    if (!(key.startsWith('relai.timing.') && typeof value === 'number') && /token|secret|password|authorization|api[_-]?key|file\.content|command\.env|approval/i.test(key)) {
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
  return redactCommandSecrets(String(value == null ? '' : value).trim());
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
  const consentGeneration = diagnosticsConsentGeneration;
  const api = await initializedTelemetryApi(config);
  if (!api || !telemetryEnabled(config) || consentGeneration !== diagnosticsConsentGeneration) return operation();
  const parentContext = options.carrier ? extractTraceContext(api, options.carrier) : api.context.active();
  const span = api.trace.getTracer('rel-ai-mcp', pkg.version).startSpan(String(name || 'relai.operation'), {
    attributes: sanitizeAttributes(attributes) as OpenTelemetryApi.Attributes,
    kind: options.kind || api.SpanKind.INTERNAL
  }, parentContext);
  try {
    return await api.context.with(api.trace.setSpan(parentContext, span), operation);
  } catch (error) {
    const code = safeTelemetryErrorCode(error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined);
    span.setAttribute('relai.error.type', safeExceptionType(error));
    span.setAttribute('relai.error.code', code);
    span.setAttribute('relai.error.category', failureCategoryFromCode(code, name));
    span.setAttribute('relai.tool.outcome', 'exception');
    span.setStatus({ code: api.SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

function safeTelemetryErrorCode(value: unknown): string {
  const code = typeof value === 'string' ? value.trim() : '';
  return /^[A-Z][A-Z0-9_]{1,79}$/.test(code) ? code : 'UNCLASSIFIED_ERROR';
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
  if (diagnosticReplayTimer) clearTimeout(diagnosticReplayTimer);
  diagnosticReplayTimer = null;
  diagnosticReplayInFlight.clear();
  diagnosticsProvider = null;
  runtimeApi = null;
  initializationPromise = null;
  usageRequestPromise = null;
  usageReportingStarted = false;
  if (usageHeartbeat) clearTimeout(usageHeartbeat);
  usageHeartbeat = null;
  if (usageRetryTimer) clearTimeout(usageRetryTimer);
  usageRetryTimer = null;
  initializedDiagnosticsEndpoint = '';
  initializedSampleRatio = null;
  try {
    await currentDiagnostics?.shutdown();
  } finally {
    runtimeDiagnosticsEnabledOverride = null;
  }
}

function telemetryStatus(config: TelemetryConfig = {}): TelemetryStatus {
  const endpointConfigured = Boolean(configuredDiagnosticsEndpoint(config));
  const diagnosticsEnabled = telemetryEnabled(config) && endpointConfigured;
  const usageReportingEnabled = Boolean(configuredMaintainerUsageEndpoint());
  const persistedUsageSuccessAt = usageReportingEnabled
    ? String(usageIdentity(config).state.lastReportedAt || '')
    : '';
  return {
    enabled: diagnosticsEnabled,
    diagnosticsEnabled,
    usageReportingEnabled,
    initialized: diagnosticsEnabled && Boolean(diagnosticsProvider),
    usageInitialized: usageReportingEnabled && usageReportingStarted,
    exporter: diagnosticsEnabled && diagnosticsProvider ? 'otlp-http' : '',
    endpointConfigured,
    endpoint: endpointConfigured && initializedDiagnosticsEndpoint ? '[configured]' : '',
    sampleRatio: initializedSampleRatio ?? telemetrySampleRatio(config),
    usageLastAttemptAt,
    usageLastSuccessAt: usageLastSuccessAt || persistedUsageSuccessAt,
    usageLastFailureAt,
    diagnosticsLastAttemptAt,
    diagnosticsLastSuccessAt,
    diagnosticsLastFailureAt,
    diagnosticsPendingFailureReports: diagnosticsEnabled ? queuedDiagnosticFailures(config).length : 0,
    diagnosticsFailureStorageDrops: diagnosticFailureStorageDrops,
    diagnosticsBatchesAttempted,
    diagnosticsBatchesDelivered,
    diagnosticsBatchesFailed,
    diagnosticsReplayedFailureReports
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
  safeTelemetryErrorCode,
  replayQueuedDiagnostics,
  telemetrySampleRatio,
  traceContextEnvironment
};
