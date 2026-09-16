import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { statePath } from './stateLayout.js';
import { openStateDatabase, setStateMeta, stateMetaValue, withStateDatabase } from './stateDatabase.ts';
import { failureCategoryFromEvent, normalizeFailureCategory } from './analyticsFailureCategory.ts';
import {
  analyticsUseCaseForOperation,
  normalizeAnalyticsTaskIntent,
  normalizeAnalyticsUseCase,
  type AnalyticsTaskIntent,
  type AnalyticsUseCase
} from './analyticsTaxonomy.ts';
import { classifyAnalyticsOutcome, reliabilityCountersForOutcome } from './analyticsOutcome.ts';
import { telemetryStatus } from './telemetry.ts';
import { sanitizePerformancePhases } from './performanceObservability.ts';
import {
  PERFORMANCE_PHASES,
  type AnalyticsFailureCategory,
  type LocalToolOutcomeEvent,
  type PerformancePhaseDurations,
  type ReliabilityCounters,
  type TelemetryConfig
} from './telemetry.types.ts';

const SCHEMA_VERSION = 5;
const PREVIOUS_SCHEMA_VERSION = 4;
const RELIABILITY_SCHEMA_VERSION = 3;
const PRE_RELIABILITY_SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_ANALYTICS_RETENTION_DAYS = 180;
const RETENTION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LEGACY_MIGRATION_KEY = 'local_analytics_legacy_migrated_v1';
const retentionPruneTimes = new Map<string, number>();
const retentionPruneTimers = new Map<string, { timer: NodeJS.Timeout; config: AnalyticsConfig }>();
const analyticsWriteDatabases = new Map<string, StateDatabase>();
const analyticsWriteCloseScheduled = new Set<string>();

interface AnalyticsConfig extends TelemetryConfig {
  stateDir?: string;
  [key: string]: unknown;
}

interface AnalyticsAggregate {
  requests?: number;
  toolCalls: number;
  successes: number;
  failures: number;
  reliabilityCalls: number;
  reliableCalls: number;
  infrastructureFailures: number;
  operationFailures: number;
  recoverableFailures: number;
  cancellations: number;
  executionMs: number;
}

type TransportEventName =
  | 'request_started'
  | 'request_reached_runtime'
  | 'request_cancelled'
  | 'connection_closed'
  | 'upstream_5xx'
  | 'response_delivered';

interface TransportAggregate {
  request_started: number;
  request_reached_runtime: number;
  request_cancelled: number;
  connection_closed: number;
  upstream_5xx: number;
  response_delivered: number;
}

type NamedAggregate<K extends 'tool' | 'workspace'> = AnalyticsAggregate & Record<K, string>;

interface WorkspaceToolAggregate extends AnalyticsAggregate {
  workspace: string;
  tool: string;
}

interface ActivityMatrixAggregate extends AnalyticsAggregate {
  intent: AnalyticsTaskIntent;
  useCase: AnalyticsUseCase;
}

interface WorkspaceActivityMatrixAggregate extends ActivityMatrixAggregate {
  workspace: string;
}

interface TaskIntentAggregate {
  intent: AnalyticsTaskIntent;
  tasks: number;
}

interface WorkspaceTaskIntentAggregate extends TaskIntentAggregate {
  workspace: string;
}

interface FailureCategoryAggregate {
  category: AnalyticsFailureCategory;
  failures: number;
}

interface WorkspaceFailureCategoryAggregate extends FailureCategoryAggregate {
  workspace: string;
}

interface AnalyticsHour extends AnalyticsAggregate {
  hour: string;
  transport: TransportAggregate;
  tools: NamedAggregate<'tool'>[];
  workspaces: NamedAggregate<'workspace'>[];
  workspaceTools: WorkspaceToolAggregate[];
  activityMatrix: ActivityMatrixAggregate[];
  workspaceActivityMatrix: WorkspaceActivityMatrixAggregate[];
  taskIntents: TaskIntentAggregate[];
  workspaceTaskIntents: WorkspaceTaskIntentAggregate[];
  failureCategories: FailureCategoryAggregate[];
  workspaceFailureCategories: WorkspaceFailureCategoryAggregate[];
  performancePhases: PerformancePhaseDurations;
}

interface AnalyticsDocument {
  schemaVersion: number;
  month: string;
  totals: AnalyticsAggregate;
  transport: TransportAggregate;
  tools: NamedAggregate<'tool'>[];
  workspaces: NamedAggregate<'workspace'>[];
  workspaceTools: WorkspaceToolAggregate[];
  activityMatrix: ActivityMatrixAggregate[];
  workspaceActivityMatrix: WorkspaceActivityMatrixAggregate[];
  taskIntents: TaskIntentAggregate[];
  workspaceTaskIntents: WorkspaceTaskIntentAggregate[];
  failureCategories: FailureCategoryAggregate[];
  workspaceFailureCategories: WorkspaceFailureCategoryAggregate[];
  performancePhases: PerformancePhaseDurations;
  hours: AnalyticsHour[];
}

type StateDatabase = DatabaseSync;

interface PruneOptions {
  retentionDays?: unknown;
  now?: Date | string | number | null;
}

function recordLocalToolOutcome(config: AnalyticsConfig = {}, event: LocalToolOutcomeEvent = {}): boolean {
  try {
    const at = boundedDate(event.at);
    const month = monthKey(at);
    const hour = hourKey(at);
    const tool = boundedLabel(event.tool, 160) || 'unknown-tool';
    const workspace = boundedLabel(event.workspace, 160);
    const useCase = analyticsUseCaseForOperation(event.operationName || event.tool);
    const intent = normalizeAnalyticsTaskIntent(event.taskIntent, 'untracked');
    const durationMs = boundedDuration(event.durationMs);
    const success = event.ok === true ? 1 : 0;
    const failure = success ? 0 : 1;
    const category: AnalyticsFailureCategory | '' = failure ? failureCategoryFromEvent(event) : '';
    const outcome = classifyAnalyticsOutcome(event);
    const performancePhases = sanitizePerformancePhases(event.timings?.phaseMs || event.performancePhases);
    const reliability = reliabilityCountersForOutcome(outcome);
    let migratedLegacy = false;
    withAnalyticsWriteDatabase(config, (db: StateDatabase) => {
      migratedLegacy = migrateLegacyLocalAnalyticsInDatabase(db, config);
      const document = readDocumentFromDatabase(db, month);
      incrementTotals(document.totals, success, failure, durationMs, reliability);
      incrementPerformancePhases(document.performancePhases, performancePhases);
      incrementNamed(document.tools, 'tool', tool, success, failure, durationMs, reliability);
      incrementActivityMatrix(document.activityMatrix, intent, useCase, success, failure, durationMs, reliability);
      if (workspace) {
        incrementNamed(document.workspaces, 'workspace', workspace, success, failure, durationMs, reliability);
        incrementWorkspaceTool(document.workspaceTools, workspace, tool, success, failure, durationMs, reliability);
        incrementWorkspaceActivityMatrix(document.workspaceActivityMatrix, workspace, intent, useCase, success, failure, durationMs, reliability);
      }
      if (failure) {
        incrementFailureCategory(document.failureCategories, category);
        if (workspace) incrementWorkspaceFailureCategory(document.workspaceFailureCategories, workspace, category);
      }

      const hourly = findOrCreate(document.hours, row => row.hour === hour, () => emptyHour(hour));
      incrementTotals(hourly, success, failure, durationMs, reliability);
      incrementPerformancePhases(hourly.performancePhases, performancePhases);
      incrementNamed(hourly.tools, 'tool', tool, success, failure, durationMs, reliability);
      incrementActivityMatrix(hourly.activityMatrix, intent, useCase, success, failure, durationMs, reliability);
      if (workspace) {
        incrementNamed(hourly.workspaces, 'workspace', workspace, success, failure, durationMs, reliability);
        incrementWorkspaceTool(hourly.workspaceTools, workspace, tool, success, failure, durationMs, reliability);
        incrementWorkspaceActivityMatrix(hourly.workspaceActivityMatrix, workspace, intent, useCase, success, failure, durationMs, reliability);
      }
      if (failure) {
        incrementFailureCategory(hourly.failureCategories, category);
        if (workspace) incrementWorkspaceFailureCategory(hourly.workspaceFailureCategories, workspace, category);
      }
      upsertDocument(db, document);
    });
    if (migratedLegacy) removeLegacyAnalyticsDirectory(config);
    scheduleRetentionPrune(config);
    return true;
  } catch {
    return false;
  }
}

function recordLocalTransportEvent(
  config: AnalyticsConfig = {},
  event: { event?: unknown; at?: unknown; count?: unknown } = {}
): boolean {
  try {
    const eventName = normalizeTransportEventName(event.event);
    if (!eventName) return false;
    const at = boundedDate(event.at);
    const month = monthKey(at);
    const hour = hourKey(at);
    const count = boundedTransportCount(event.count);
    let migratedLegacy = false;
    withAnalyticsWriteDatabase(config, (db: StateDatabase) => {
      migratedLegacy = migrateLegacyLocalAnalyticsInDatabase(db, config);
      const document = readDocumentFromDatabase(db, month);
      incrementTransport(document.transport, eventName, count);
      const hourly = findOrCreate(document.hours, row => row.hour === hour, () => emptyHour(hour));
      incrementTransport(hourly.transport, eventName, count);
      upsertDocument(db, document);
    });
    if (migratedLegacy) removeLegacyAnalyticsDirectory(config);
    scheduleRetentionPrune(config);
    return true;
  } catch {
    return false;
  }
}

function recordLocalTaskCompletion(config: AnalyticsConfig = {}, event: { workspace?: unknown; taskIntent?: unknown; at?: unknown } = {}): boolean {
  try {
    const at = boundedDate(event.at);
    const month = monthKey(at);
    const hour = hourKey(at);
    const workspace = boundedLabel(event.workspace, 160);
    const intent = normalizeAnalyticsTaskIntent(event.taskIntent, 'auto');
    let migratedLegacy = false;
    withStateDatabase(config, (db: StateDatabase) => {
      migratedLegacy = migrateLegacyLocalAnalyticsInDatabase(db, config);
      const document = readDocumentFromDatabase(db, month);
      incrementTaskIntent(document.taskIntents, intent);
      if (workspace) incrementWorkspaceTaskIntent(document.workspaceTaskIntents, workspace, intent);
      const hourly = findOrCreate(document.hours, row => row.hour === hour, () => emptyHour(hour));
      incrementTaskIntent(hourly.taskIntents, intent);
      if (workspace) incrementWorkspaceTaskIntent(hourly.workspaceTaskIntents, workspace, intent);
      upsertDocument(db, document);
    }, { transaction: true });
    if (migratedLegacy) removeLegacyAnalyticsDirectory(config);
    scheduleRetentionPrune(config);
    return true;
  } catch {
    return false;
  }
}

function readLocalUsageSnapshot(config: AnalyticsConfig = {}, requestedMonth = ''): Record<string, unknown> {
  const month = normalizeMonth(requestedMonth) || monthKey(new Date());
  return projectLocalUsageSnapshot(config, month, readDocument(config, month));
}

async function readLocalUsageSnapshotAsync(config: AnalyticsConfig = {}, requestedMonth = ''): Promise<Record<string, unknown>> {
  const month = normalizeMonth(requestedMonth) || monthKey(new Date());
  return projectLocalUsageSnapshot(config, month, await readDocumentFresh(config, month));
}

function projectLocalUsageSnapshot(config: AnalyticsConfig, month: string, document: AnalyticsDocument): Record<string, unknown> {
  const activeDays = new Set(document.hours.map(row => row.hour.slice(0, 10))).size;
  const totals = {
    ...aggregateDto(document.totals),
    requests: number(document.totals.requests),
    activeDays
  };
  const externalTelemetry = telemetryStatus(config);
  return {
    month,
    privacy: {
      retentionDays: LOCAL_ANALYTICS_RETENTION_DAYS,
      externalTelemetry: {
        enabled: externalTelemetry.enabled === true,
        endpointConfigured: externalTelemetry.endpointConfigured === true,
        sampleRatio: number(externalTelemetry.sampleRatio)
      }
    },
    totals,
    transport: transportDto(document.transport),
    tools: document.tools.map(row => ({ tool: row.tool, ...aggregateDto(row) })),
    workspaces: document.workspaces.map(row => ({ workspace: row.workspace, ...aggregateDto(row) })),
    workspaceTools: document.workspaceTools.map(row => ({
      workspace: row.workspace,
      tool: row.tool,
      ...aggregateDto(row)
    })),
    activityMatrix: document.activityMatrix.map(row => ({
      intent: row.intent,
      useCase: row.useCase,
      ...aggregateDto(row)
    })),
    workspaceActivityMatrix: document.workspaceActivityMatrix.map(row => ({
      workspace: row.workspace,
      intent: row.intent,
      useCase: row.useCase,
      ...aggregateDto(row)
    })),
    taskIntents: document.taskIntents.map(row => ({ intent: row.intent, tasks: number(row.tasks) })),
    workspaceTaskIntents: document.workspaceTaskIntents.map(row => ({
      workspace: row.workspace,
      intent: row.intent,
      tasks: number(row.tasks)
    })),
    series: document.hours.map(row => ({
      hour: row.hour,
      requests: number(row.requests),
      ...aggregateDto(row)
    })),
    transportSeries: document.hours.map(row => ({ hour: row.hour, ...transportDto(row.transport) })),
    toolSeries: document.hours.flatMap(row => row.tools.map(item => ({ hour: row.hour, tool: item.tool, ...aggregateDto(item) }))),
    workspaceSeries: document.hours.flatMap(row => row.workspaces.map(item => ({
      hour: row.hour,
      workspace: item.workspace,
      ...aggregateDto(item)
    }))),
    workspaceToolSeries: document.hours.flatMap(row => row.workspaceTools.map(item => ({
      hour: row.hour,
      workspace: item.workspace,
      tool: item.tool,
      ...aggregateDto(item)
    }))),
    activityMatrixSeries: document.hours.flatMap(row => row.activityMatrix.map(item => ({
      hour: row.hour,
      intent: item.intent,
      useCase: item.useCase,
      ...aggregateDto(item)
    }))),
    workspaceActivityMatrixSeries: document.hours.flatMap(row => row.workspaceActivityMatrix.map(item => ({
      hour: row.hour,
      workspace: item.workspace,
      intent: item.intent,
      useCase: item.useCase,
      ...aggregateDto(item)
    }))),
    taskIntentSeries: document.hours.flatMap(row => row.taskIntents.map(item => ({
      hour: row.hour,
      intent: item.intent,
      tasks: number(item.tasks)
    }))),
    workspaceTaskIntentSeries: document.hours.flatMap(row => row.workspaceTaskIntents.map(item => ({
      hour: row.hour,
      workspace: item.workspace,
      intent: item.intent,
      tasks: number(item.tasks)
    }))),
    performance: { phaseMs: sanitizePerformancePhases(document.performancePhases) },
    failureCategories: document.failureCategories.map(item => ({ category: item.category, failures: number(item.failures) })),
    workspaceFailureCategories: document.workspaceFailureCategories.map(item => ({
      workspace: item.workspace,
      category: item.category,
      failures: number(item.failures)
    })),
    failureCategorySeries: document.hours.flatMap(row => row.failureCategories.map(item => ({ hour: row.hour, category: item.category, failures: number(item.failures) }))),
    workspaceFailureCategorySeries: document.hours.flatMap(row => row.workspaceFailureCategories.map(item => ({
      hour: row.hour,
      workspace: item.workspace,
      category: item.category,
      failures: number(item.failures)
    })))
  };
}

function readDocument(config: AnalyticsConfig, month: string): AnalyticsDocument {
  closeAnalyticsWriteDatabases(config);
  migrateLegacyLocalAnalytics(config);
  return withStateDatabase(config, (db: StateDatabase) => readDocumentFromDatabase(db, month)) as AnalyticsDocument;
}

async function readDocumentFresh(config: AnalyticsConfig, month: string): Promise<AnalyticsDocument> {
  return readDocument(config, month);
}

function readDocumentFromDatabase(db: StateDatabase, month: string): AnalyticsDocument {
  const row = db.prepare('SELECT payload FROM analytics_months WHERE month=?').get(month) as { payload?: unknown } | undefined;
  if (!row) return emptyDocument(month);
  try {
    return parseDocument(String(row.payload || ''), month);
  } catch {
    return emptyDocument(month);
  }
}

function upsertDocument(db: StateDatabase, document: AnalyticsDocument, updatedAtMs: unknown = Date.now()): void {
  db.prepare(`INSERT INTO analytics_months(month,updated_at_ms,payload) VALUES(?,?,?)
    ON CONFLICT(month) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`)
    .run(document.month, Math.max(0, Math.floor(Number(updatedAtMs) || Date.now())), JSON.stringify(document));
}

function parseDocument(text: string, month: string): AnalyticsDocument {
  const parsed = asRecord(JSON.parse(text) as unknown);
  const schemaVersion = Number(parsed.schemaVersion);
  const supportedSchema = [SCHEMA_VERSION, PREVIOUS_SCHEMA_VERSION, RELIABILITY_SCHEMA_VERSION, PRE_RELIABILITY_SCHEMA_VERSION, LEGACY_SCHEMA_VERSION].includes(schemaVersion);
  return supportedSchema && parsed.month === month
    ? sanitizeDocument(parsed, month, { resetReliability: schemaVersion < RELIABILITY_SCHEMA_VERSION })
    : emptyDocument(month);
}

function migrateLegacyLocalAnalytics(config: AnalyticsConfig = {}): void {
  let migrated = false;
  withStateDatabase(config, (db: StateDatabase) => {
    migrated = migrateLegacyLocalAnalyticsInDatabase(db, config);
  }, { transaction: true });
  if (migrated) removeLegacyAnalyticsDirectory(config);
}

function migrateLegacyLocalAnalyticsInDatabase(db: StateDatabase, config: AnalyticsConfig = {}): boolean {
  if (stateMetaValue(db, LEGACY_MIGRATION_KEY, '') === '1') return false;
  const directory = statePath(config, 'analytics', 'local');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d{4}-\d{2}\.json$/.test(entry.name)) continue;
    const month = entry.name.slice(0, 7);
    const file = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      upsertDocument(db, parseDocument(fs.readFileSync(file, 'utf8'), month), stat.mtimeMs);
    } catch {}
  }
  setStateMeta(db, LEGACY_MIGRATION_KEY, '1');
  return true;
}

async function flushLocalAnalytics(config?: AnalyticsConfig): Promise<{ ok: true; failed: 0; pending: 0 }> {
  const pending = [...retentionPruneTimers.values()];
  retentionPruneTimers.clear();
  for (const { timer, config: pendingConfig } of pending) {
    clearTimeout(timer);
    try { await pruneLocalAnalytics(pendingConfig); }
    catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] local analytics retention prune flush:', error); }
  }
  closeAnalyticsWriteDatabases(config);
  return { ok: true, failed: 0, pending: 0 };
}

function withAnalyticsWriteDatabase<TResult>(config: AnalyticsConfig, operation: (db: StateDatabase) => TResult): TResult {
  const key = statePath(config, 'durable-state.sqlite');
  let db = analyticsWriteDatabases.get(key);
  if (!db) {
    const opened = openStateDatabase(config);
    if (!opened) throw new Error('Local analytics database could not be opened.');
    db = opened;
    analyticsWriteDatabases.set(key, db);
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = operation(db);
    db.exec('COMMIT');
    scheduleAnalyticsWriteDatabaseClose(key);
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    analyticsWriteDatabases.delete(key);
    try { db.close(); } catch {}
    throw error;
  }
}

function scheduleAnalyticsWriteDatabaseClose(key: string): void {
  if (analyticsWriteCloseScheduled.has(key)) return;
  analyticsWriteCloseScheduled.add(key);
  queueMicrotask(() => {
    analyticsWriteCloseScheduled.delete(key);
    closeAnalyticsWriteDatabase(key);
  });
}

function closeAnalyticsWriteDatabase(key: string): void {
  const db = analyticsWriteDatabases.get(key);
  if (!db) return;
  analyticsWriteDatabases.delete(key);
  try { db.close(); } catch {}
}

function closeAnalyticsWriteDatabases(config?: AnalyticsConfig): void {
  const onlyKey = config ? statePath(config, 'durable-state.sqlite') : '';
  for (const key of analyticsWriteDatabases.keys()) {
    if (onlyKey && key !== onlyKey) continue;
    closeAnalyticsWriteDatabase(key);
  }
}

function scheduleRetentionPrune(config: AnalyticsConfig = {}): boolean {
  const key = statePath(config, 'durable-state.sqlite');
  const now = Date.now();
  if (now - Number(retentionPruneTimes.get(key) || 0) < RETENTION_PRUNE_INTERVAL_MS) return false;
  retentionPruneTimes.set(key, now);
  const timer = setTimeout(() => {
    retentionPruneTimers.delete(key);
    void pruneLocalAnalytics(config).catch(error => {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] local analytics retention prune:', error);
    });
  }, 0);
  timer.unref?.();
  retentionPruneTimers.set(key, { timer, config: { ...config } });
  return true;
}

async function pruneLocalAnalytics(config: AnalyticsConfig = {}, options: PruneOptions = {}): Promise<{ ok: true; removedFiles: number; removedBytes: number }> {
  migrateLegacyLocalAnalytics(config);
  const retentionDays = Math.max(1, Math.floor(Number(options.retentionDays || LOCAL_ANALYTICS_RETENTION_DAYS)));
  const now = options.now instanceof Date ? options.now : new Date(options.now == null ? Date.now() : options.now);
  const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const result = withStateDatabase(config, (db: StateDatabase) => {
    const rows = db.prepare('SELECT month,payload FROM analytics_months').all() as Array<{ month?: unknown; payload?: unknown }>;
    const remove = db.prepare('DELETE FROM analytics_months WHERE month=?');
    let removedFiles = 0;
    let removedBytes = 0;
    for (const row of rows) {
      if (monthEndMs(row.month) >= cutoffMs) continue;
      removedFiles += 1;
      removedBytes += Buffer.byteLength(String(row.payload || ''), 'utf8');
      remove.run(String(row.month || ''));
    }
    return { ok: true as const, removedFiles, removedBytes };
  }, { transaction: true }) as { ok: true; removedFiles: number; removedBytes: number };
  retentionPruneTimes.set(statePath(config, 'durable-state.sqlite'), nowMs);
  return result;
}

function removeWorkspaceLocalAnalytics(config: AnalyticsConfig = {}, workspaceValue: unknown = ''): { ok: true; updatedMonths: number; removedToolCalls: number } {
  const workspace = boundedLabel(workspaceValue, 160);
  if (!workspace) return { ok: true, updatedMonths: 0, removedToolCalls: 0 };
  migrateLegacyLocalAnalytics(config);
  return withStateDatabase(config, (db: StateDatabase) => {
    const rows = db.prepare('SELECT month,payload FROM analytics_months').all() as Array<{ month?: unknown; payload?: unknown }>;
    let updatedMonths = 0;
    let removedToolCalls = 0;
    for (const row of rows) {
      const month = normalizeMonth(row.month);
      if (!month) continue;
      let document: AnalyticsDocument;
      try { document = parseDocument(String(row.payload || ''), month); }
      catch { continue; }

      const workspaceAggregate = document.workspaces.find(item => item.workspace === workspace);
      const workspaceTools = document.workspaceTools.filter(item => item.workspace === workspace);
      const workspaceMatrix = document.workspaceActivityMatrix.filter(item => item.workspace === workspace);
      const workspaceTaskIntents = document.workspaceTaskIntents.filter(item => item.workspace === workspace);
      const workspaceFailures = document.workspaceFailureCategories.filter(item => item.workspace === workspace);
      const hasHourlyData = document.hours.some(hour =>
        hour.workspaces.some(item => item.workspace === workspace)
        || hour.workspaceTools.some(item => item.workspace === workspace)
        || hour.workspaceActivityMatrix.some(item => item.workspace === workspace)
        || hour.workspaceTaskIntents.some(item => item.workspace === workspace)
        || hour.workspaceFailureCategories.some(item => item.workspace === workspace));
      if (!workspaceAggregate && !workspaceTools.length && !workspaceMatrix.length && !workspaceTaskIntents.length && !workspaceFailures.length && !hasHourlyData) continue;

      const removedCalls = number(workspaceAggregate?.toolCalls)
        || workspaceTools.reduce((sum, item) => sum + number(item.toolCalls), 0);
      removedToolCalls += removedCalls;
      if (workspaceAggregate) subtractAggregate(document.totals, workspaceAggregate, true);
      subtractToolRows(document.tools, workspaceTools);
      subtractActivityRows(document.activityMatrix, workspaceMatrix);
      subtractTaskIntentRows(document.taskIntents, workspaceTaskIntents);
      subtractFailureRows(document.failureCategories, workspaceFailures);
      document.workspaces = document.workspaces.filter(item => item.workspace !== workspace);
      document.workspaceTools = document.workspaceTools.filter(item => item.workspace !== workspace);
      document.workspaceActivityMatrix = document.workspaceActivityMatrix.filter(item => item.workspace !== workspace);
      document.workspaceTaskIntents = document.workspaceTaskIntents.filter(item => item.workspace !== workspace);
      document.workspaceFailureCategories = document.workspaceFailureCategories.filter(item => item.workspace !== workspace);
      document.tools = document.tools.filter(item => number(item.toolCalls) > 0);
      document.activityMatrix = document.activityMatrix.filter(item => number(item.toolCalls) > 0);
      document.taskIntents = document.taskIntents.filter(item => number(item.tasks) > 0);
      document.failureCategories = document.failureCategories.filter(item => number(item.failures) > 0);

      for (const hour of document.hours) {
        const hourlyAggregate = hour.workspaces.find(item => item.workspace === workspace);
        const hourlyTools = hour.workspaceTools.filter(item => item.workspace === workspace);
        const hourlyMatrix = hour.workspaceActivityMatrix.filter(item => item.workspace === workspace);
        const hourlyTaskIntents = hour.workspaceTaskIntents.filter(item => item.workspace === workspace);
        const hourlyFailures = hour.workspaceFailureCategories.filter(item => item.workspace === workspace);
        if (hourlyAggregate) subtractAggregate(hour, hourlyAggregate, true);
        subtractToolRows(hour.tools, hourlyTools);
        subtractActivityRows(hour.activityMatrix, hourlyMatrix);
        subtractTaskIntentRows(hour.taskIntents, hourlyTaskIntents);
        subtractFailureRows(hour.failureCategories, hourlyFailures);
        hour.workspaces = hour.workspaces.filter(item => item.workspace !== workspace);
        hour.workspaceTools = hour.workspaceTools.filter(item => item.workspace !== workspace);
        hour.workspaceActivityMatrix = hour.workspaceActivityMatrix.filter(item => item.workspace !== workspace);
        hour.workspaceTaskIntents = hour.workspaceTaskIntents.filter(item => item.workspace !== workspace);
        hour.workspaceFailureCategories = hour.workspaceFailureCategories.filter(item => item.workspace !== workspace);
        hour.tools = hour.tools.filter(item => number(item.toolCalls) > 0);
        hour.activityMatrix = hour.activityMatrix.filter(item => number(item.toolCalls) > 0);
        hour.taskIntents = hour.taskIntents.filter(item => number(item.tasks) > 0);
        hour.failureCategories = hour.failureCategories.filter(item => number(item.failures) > 0);
      }
      document.hours = document.hours.filter(hour => number(hour.toolCalls) > 0 || transportTotal(hour.transport) > 0);
      upsertDocument(db, document);
      updatedMonths += 1;
    }
    return { ok: true as const, updatedMonths, removedToolCalls };
  }, { transaction: true }) as { ok: true; updatedMonths: number; removedToolCalls: number };
}

async function clearLocalAnalytics(config: AnalyticsConfig = {}): Promise<{ ok: true; removedFiles: number; removedBytes: number }> {
  closeAnalyticsWriteDatabases(config);
  migrateLegacyLocalAnalytics(config);
  const result = withStateDatabase(config, (db: StateDatabase) => {
    const rows = db.prepare('SELECT payload FROM analytics_months').all() as Array<{ payload?: unknown }>;
    const removedBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(String(row.payload || ''), 'utf8'), 0);
    db.exec('DELETE FROM analytics_months');
    return { ok: true as const, removedFiles: rows.length, removedBytes };
  }, { transaction: true }) as { ok: true; removedFiles: number; removedBytes: number };
  retentionPruneTimes.delete(statePath(config, 'durable-state.sqlite'));
  removeLegacyAnalyticsDirectory(config);
  return result;
}

function removeLegacyAnalyticsDirectory(config: AnalyticsConfig = {}): void {
  try { fs.rmSync(statePath(config, 'analytics', 'local'), { recursive: true, force: true }); } catch {}
}

function monthEndMs(month: unknown): number {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!match) return Number.POSITIVE_INFINITY;
  const year = Number(match[1] ?? '');
  const monthIndex = Number(match[2] ?? '') - 1;
  if (monthIndex < 0 || monthIndex > 11) return Number.POSITIVE_INFINITY;
  return Date.UTC(year, monthIndex + 1, 1) - 1;
}

function emptyDocument(month: string): AnalyticsDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    month,
    totals: emptyAggregate(true),
    transport: emptyTransportAggregate(),
    tools: [],
    workspaces: [],
    workspaceTools: [],
    activityMatrix: [],
    workspaceActivityMatrix: [],
    taskIntents: [],
    workspaceTaskIntents: [],
    failureCategories: [],
    workspaceFailureCategories: [],
    performancePhases: {},
    hours: []
  };
}

function sanitizeDocument(value: unknown, month: string, { resetReliability = false }: { resetReliability?: boolean } = {}): AnalyticsDocument {
  const source = asRecord(value);
  const doc = emptyDocument(month);
  doc.totals = sanitizeAggregate(source.totals, true, resetReliability);
  doc.transport = sanitizeTransportAggregate(source.transport);
  doc.tools = sanitizeNamedRows(source.tools, 'tool', resetReliability);
  doc.workspaces = sanitizeNamedRows(source.workspaces, 'workspace', resetReliability);
  doc.workspaceTools = sanitizeWorkspaceTools(source.workspaceTools, resetReliability);
  doc.activityMatrix = sanitizeActivityMatrix(source.activityMatrix, resetReliability);
  doc.workspaceActivityMatrix = sanitizeWorkspaceActivityMatrix(source.workspaceActivityMatrix, resetReliability);
  doc.taskIntents = sanitizeTaskIntents(source.taskIntents);
  doc.workspaceTaskIntents = sanitizeWorkspaceTaskIntents(source.workspaceTaskIntents);
  doc.failureCategories = sanitizeFailureCategories(source.failureCategories);
  doc.performancePhases = sanitizePerformancePhases(source.performancePhases);
  doc.workspaceFailureCategories = sanitizeWorkspaceFailureCategories(source.workspaceFailureCategories);
  const hours = Array.isArray(source.hours) ? source.hours : [];
  doc.hours = hours
    .filter(value => /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(String(asRecord(value).hour || '')))
    .slice(-744)
    .map(value => {
      const row = asRecord(value);
      return {
        hour: String(row.hour),
        ...sanitizeAggregate(row, true, resetReliability),
        transport: sanitizeTransportAggregate(row.transport),
        tools: sanitizeNamedRows(row.tools, 'tool', resetReliability),
        workspaces: sanitizeNamedRows(row.workspaces, 'workspace', resetReliability),
        workspaceTools: sanitizeWorkspaceTools(row.workspaceTools, resetReliability),
        activityMatrix: sanitizeActivityMatrix(row.activityMatrix, resetReliability),
        workspaceActivityMatrix: sanitizeWorkspaceActivityMatrix(row.workspaceActivityMatrix, resetReliability),
        taskIntents: sanitizeTaskIntents(row.taskIntents),
        workspaceTaskIntents: sanitizeWorkspaceTaskIntents(row.workspaceTaskIntents),
        failureCategories: sanitizeFailureCategories(row.failureCategories),
        workspaceFailureCategories: sanitizeWorkspaceFailureCategories(row.workspaceFailureCategories),
        performancePhases: sanitizePerformancePhases(row.performancePhases)
      } as AnalyticsHour;
    });
  return doc;
}

function sanitizeNamedRows<K extends 'tool' | 'workspace'>(rows: unknown, field: K, resetReliability = false): Array<NamedAggregate<K>> {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 512).map(value => {
    const row = asRecord(value);
    return { [field]: boundedLabel(row[field], 160), ...sanitizeAggregate(row, false, resetReliability) } as NamedAggregate<K>;
  }).filter(row => Boolean(row[field]));
}

function sanitizeWorkspaceTools(rows: unknown, resetReliability = false): WorkspaceToolAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 2048).map(value => {
    const row = asRecord(value);
    return { workspace: boundedLabel(row.workspace, 160), tool: boundedLabel(row.tool, 160), ...sanitizeAggregate(row, false, resetReliability) };
  }).filter(row => Boolean(row.workspace && row.tool));
}

function sanitizeActivityMatrix(rows: unknown, resetReliability = false): ActivityMatrixAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 256).map(value => {
    const row = asRecord(value);
    return {
      intent: normalizeAnalyticsTaskIntent(row.intent, 'untracked'),
      useCase: normalizeAnalyticsUseCase(row.useCase),
      ...sanitizeAggregate(row, false, resetReliability)
    };
  }).filter(row => row.toolCalls > 0);
}

function sanitizeWorkspaceActivityMatrix(rows: unknown, resetReliability = false): WorkspaceActivityMatrixAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 4096).map(value => {
    const row = asRecord(value);
    return {
      workspace: boundedLabel(row.workspace, 160),
      intent: normalizeAnalyticsTaskIntent(row.intent, 'untracked'),
      useCase: normalizeAnalyticsUseCase(row.useCase),
      ...sanitizeAggregate(row, false, resetReliability)
    };
  }).filter(row => Boolean(row.workspace) && row.toolCalls > 0);
}

function sanitizeTaskIntents(rows: unknown): TaskIntentAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 32).map(value => {
    const row = asRecord(value);
    return { intent: normalizeAnalyticsTaskIntent(row.intent, 'auto'), tasks: number(row.tasks) };
  }).filter(row => row.tasks > 0);
}

function sanitizeWorkspaceTaskIntents(rows: unknown): WorkspaceTaskIntentAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 1024).map(value => {
    const row = asRecord(value);
    return { workspace: boundedLabel(row.workspace, 160), intent: normalizeAnalyticsTaskIntent(row.intent, 'auto'), tasks: number(row.tasks) };
  }).filter(row => Boolean(row.workspace) && row.tasks > 0);
}

function sanitizeFailureCategories(rows: unknown): FailureCategoryAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 32).map(value => {
    const row = asRecord(value);
    return { category: normalizeFailureCategory(row.category), failures: number(row.failures) };
  }).filter(row => row.failures > 0);
}

function sanitizeWorkspaceFailureCategories(rows: unknown): WorkspaceFailureCategoryAggregate[] {
  const values = Array.isArray(rows) ? rows : [];
  return values.slice(0, 512).map(value => {
    const row = asRecord(value);
    return { workspace: boundedLabel(row.workspace, 160), category: normalizeFailureCategory(row.category), failures: number(row.failures) };
  }).filter(row => Boolean(row.workspace) && row.failures > 0);
}

function sanitizeAggregate(row: unknown, includeRequests = false, resetReliability = false): AnalyticsAggregate {
  const source = asRecord(row);
  const successes = number(source.successes);
  const failures = number(source.failures);
  const reliabilityCalls = resetReliability ? 0 : number(source.reliabilityCalls);
  const reliableCalls = resetReliability ? 0 : number(source.reliableCalls);
  return {
    ...(includeRequests ? { requests: number(source.requests) } : {}),
    toolCalls: number(source.toolCalls),
    successes,
    failures,
    reliabilityCalls,
    reliableCalls,
    infrastructureFailures: resetReliability ? 0 : number(source.infrastructureFailures),
    operationFailures: resetReliability ? 0 : number(source.operationFailures),
    recoverableFailures: resetReliability ? 0 : number(source.recoverableFailures),
    cancellations: resetReliability ? 0 : number(source.cancellations),
    executionMs: number(source.executionMs)
  };
}

function aggregateDto(row: Partial<AnalyticsAggregate> | null | undefined): Omit<AnalyticsAggregate, 'requests'> {
  return {
    toolCalls: number(row?.toolCalls),
    successes: number(row?.successes),
    failures: number(row?.failures),
    reliabilityCalls: number(row?.reliabilityCalls),
    reliableCalls: number(row?.reliableCalls),
    infrastructureFailures: number(row?.infrastructureFailures),
    operationFailures: number(row?.operationFailures),
    recoverableFailures: number(row?.recoverableFailures),
    cancellations: number(row?.cancellations),
    executionMs: number(row?.executionMs)
  };
}

function emptyTransportAggregate(): TransportAggregate {
  return {
    request_started: 0,
    request_reached_runtime: 0,
    request_cancelled: 0,
    connection_closed: 0,
    upstream_5xx: 0,
    response_delivered: 0
  };
}

function sanitizeTransportAggregate(value: unknown): TransportAggregate {
  const source = asRecord(value);
  const result = emptyTransportAggregate();
  for (const key of Object.keys(result) as TransportEventName[]) result[key] = number(source[key]);
  return result;
}

function transportDto(value: TransportAggregate | null | undefined): TransportAggregate {
  const source = value || emptyTransportAggregate();
  return {
    request_started: number(source.request_started),
    request_reached_runtime: number(source.request_reached_runtime),
    request_cancelled: number(source.request_cancelled),
    connection_closed: number(source.connection_closed),
    upstream_5xx: number(source.upstream_5xx),
    response_delivered: number(source.response_delivered)
  };
}

function incrementTransport(row: TransportAggregate, event: TransportEventName, count = 1): void {
  row[event] = number(row[event]) + count;
}

function transportTotal(row: TransportAggregate | null | undefined): number {
  const value = row || emptyTransportAggregate();
  return Object.values(value).reduce((sum, count) => sum + number(count), 0);
}

function normalizeTransportEventName(value: unknown): TransportEventName | '' {
  const event = String(value || '').trim() as TransportEventName;
  return Object.hasOwn(emptyTransportAggregate(), event) ? event : '';
}

function boundedTransportCount(value: unknown): number {
  const count = value === undefined ? 1 : Math.floor(Number(value));
  return Number.isFinite(count) && count > 0 ? Math.min(10_000, count) : 1;
}

function emptyHour(hour: string): AnalyticsHour {
  return {
    hour,
    ...emptyAggregate(true),
    transport: emptyTransportAggregate(),
    tools: [],
    workspaces: [],
    workspaceTools: [],
    activityMatrix: [],
    workspaceActivityMatrix: [],
    taskIntents: [],
    workspaceTaskIntents: [],
    failureCategories: [],
    workspaceFailureCategories: [],
    performancePhases: {}
  };
}

function emptyAggregate(includeRequests = false): AnalyticsAggregate {
  return {
    ...(includeRequests ? { requests: 0 } : {}),
    toolCalls: 0,
    successes: 0,
    failures: 0,
    reliabilityCalls: 0,
    reliableCalls: 0,
    infrastructureFailures: 0,
    operationFailures: 0,
    recoverableFailures: 0,
    cancellations: 0,
    executionMs: 0
  };
}

function incrementTotals(row: AnalyticsAggregate, success: number, failure: number, durationMs: number, reliability: ReliabilityCounters): void {
  row.requests = number(row.requests) + 1;
  incrementAggregate(row, success, failure, durationMs, reliability);
}

function incrementNamed<K extends 'tool' | 'workspace'>(rows: Array<NamedAggregate<K>>, field: K, value: string, success: number, failure: number, durationMs: number, reliability: ReliabilityCounters): void {
  const row = findOrCreate(rows, item => item[field] === value, () => ({ [field]: value, ...emptyAggregate() } as NamedAggregate<K>));
  incrementAggregate(row, success, failure, durationMs, reliability);
}

function incrementWorkspaceTool(rows: WorkspaceToolAggregate[], workspace: string, tool: string, success: number, failure: number, durationMs: number, reliability: ReliabilityCounters): void {
  const row = findOrCreate(rows, item => item.workspace === workspace && item.tool === tool, () => ({ workspace, tool, ...emptyAggregate() }));
  incrementAggregate(row, success, failure, durationMs, reliability);
}

function incrementActivityMatrix(rows: ActivityMatrixAggregate[], intent: AnalyticsTaskIntent, useCase: AnalyticsUseCase, success: number, failure: number, durationMs: number, reliability: ReliabilityCounters): void {
  const row = findOrCreate(rows, item => item.intent === intent && item.useCase === useCase, () => ({ intent, useCase, ...emptyAggregate() }));
  incrementAggregate(row, success, failure, durationMs, reliability);
}

function incrementWorkspaceActivityMatrix(rows: WorkspaceActivityMatrixAggregate[], workspace: string, intent: AnalyticsTaskIntent, useCase: AnalyticsUseCase, success: number, failure: number, durationMs: number, reliability: ReliabilityCounters): void {
  const row = findOrCreate(rows, item => item.workspace === workspace && item.intent === intent && item.useCase === useCase, () => ({ workspace, intent, useCase, ...emptyAggregate() }));
  incrementAggregate(row, success, failure, durationMs, reliability);
}

function incrementTaskIntent(rows: TaskIntentAggregate[], intent: AnalyticsTaskIntent): void {
  const row = findOrCreate(rows, item => item.intent === intent, () => ({ intent, tasks: 0 }));
  row.tasks = number(row.tasks) + 1;
}

function incrementWorkspaceTaskIntent(rows: WorkspaceTaskIntentAggregate[], workspace: string, intent: AnalyticsTaskIntent): void {
  const row = findOrCreate(rows, item => item.workspace === workspace && item.intent === intent, () => ({ workspace, intent, tasks: 0 }));
  row.tasks = number(row.tasks) + 1;
}

function incrementFailureCategory(rows: FailureCategoryAggregate[], category: unknown): void {
  const normalized = normalizeFailureCategory(category);
  const row = findOrCreate(rows, item => item.category === normalized, () => ({ category: normalized, failures: 0 }));
  row.failures = number(row.failures) + 1;
}

function incrementWorkspaceFailureCategory(rows: WorkspaceFailureCategoryAggregate[], workspace: string, category: unknown): void {
  const normalized = normalizeFailureCategory(category);
  const row = findOrCreate(rows, item => item.workspace === workspace && item.category === normalized, () => ({ workspace, category: normalized, failures: 0 }));
  row.failures = number(row.failures) + 1;
}

function incrementPerformancePhases(target: PerformancePhaseDurations, phases: PerformancePhaseDurations): void {
  for (const phase of PERFORMANCE_PHASES) {
    const durationMs = phases[phase];
    if (durationMs != null) target[phase] = number(target[phase]) + number(durationMs);
  }
}

function subtractAggregate(target: AnalyticsAggregate, source: Partial<AnalyticsAggregate>, includeRequests = false): void {
  if (includeRequests) target.requests = Math.max(0, number(target.requests) - number(source.toolCalls));
  target.toolCalls = Math.max(0, number(target.toolCalls) - number(source.toolCalls));
  target.successes = Math.max(0, number(target.successes) - number(source.successes));
  target.failures = Math.max(0, number(target.failures) - number(source.failures));
  target.reliabilityCalls = Math.max(0, number(target.reliabilityCalls) - number(source.reliabilityCalls));
  target.reliableCalls = Math.max(0, number(target.reliableCalls) - number(source.reliableCalls));
  target.infrastructureFailures = Math.max(0, number(target.infrastructureFailures) - number(source.infrastructureFailures));
  target.operationFailures = Math.max(0, number(target.operationFailures) - number(source.operationFailures));
  target.recoverableFailures = Math.max(0, number(target.recoverableFailures) - number(source.recoverableFailures));
  target.cancellations = Math.max(0, number(target.cancellations) - number(source.cancellations));
  target.executionMs = Math.max(0, number(target.executionMs) - number(source.executionMs));
}

function subtractToolRows(targetRows: Array<NamedAggregate<'tool'>>, workspaceRows: WorkspaceToolAggregate[]): void {
  for (const workspaceRow of workspaceRows) {
    const target = targetRows.find(item => item.tool === workspaceRow.tool);
    if (target) subtractAggregate(target, workspaceRow);
  }
}

function subtractActivityRows(targetRows: ActivityMatrixAggregate[], workspaceRows: WorkspaceActivityMatrixAggregate[]): void {
  for (const workspaceRow of workspaceRows) {
    const target = targetRows.find(item => item.intent === workspaceRow.intent && item.useCase === workspaceRow.useCase);
    if (target) subtractAggregate(target, workspaceRow);
  }
}

function subtractTaskIntentRows(targetRows: TaskIntentAggregate[], workspaceRows: WorkspaceTaskIntentAggregate[]): void {
  for (const workspaceRow of workspaceRows) {
    const target = targetRows.find(item => item.intent === workspaceRow.intent);
    if (target) target.tasks = Math.max(0, number(target.tasks) - number(workspaceRow.tasks));
  }
}

function subtractFailureRows(targetRows: FailureCategoryAggregate[], workspaceRows: WorkspaceFailureCategoryAggregate[]): void {
  for (const workspaceRow of workspaceRows) {
    const target = targetRows.find(item => item.category === workspaceRow.category);
    if (target) target.failures = Math.max(0, number(target.failures) - number(workspaceRow.failures));
  }
}

function incrementAggregate(row: AnalyticsAggregate, success: number, failure: number, durationMs: number, reliability: ReliabilityCounters): void {
  row.toolCalls = number(row.toolCalls) + 1;
  row.successes = number(row.successes) + success;
  row.failures = number(row.failures) + failure;
  row.reliabilityCalls = number(row.reliabilityCalls) + number(reliability.reliabilityCalls);
  row.reliableCalls = number(row.reliableCalls) + number(reliability.reliableCalls);
  row.infrastructureFailures = number(row.infrastructureFailures) + number(reliability.infrastructureFailures);
  row.operationFailures = number(row.operationFailures) + number(reliability.operationFailures);
  row.recoverableFailures = number(row.recoverableFailures) + number(reliability.recoverableFailures);
  row.cancellations = number(row.cancellations) + number(reliability.cancellations);
  row.executionMs = number(row.executionMs) + durationMs;
}

function findOrCreate<T>(rows: T[], predicate: (row: T) => boolean, create: () => T): T {
  let row = rows.find(predicate);
  if (!row) {
    row = create();
    rows.push(row);
  }
  return row;
}

function boundedDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date((value == null ? Date.now() : value) as string | number);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function boundedDuration(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(n))) : 0;
}

function boundedLabel(value: unknown, max: number): string {
  return String(value || '').trim().slice(0, max);
}

function number(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function hourKey(date: Date): string {
  return `${monthKey(date)}-${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}`;
}

function normalizeMonth(value: unknown): string {
  const text = String(value || '').trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(text) ? text : '';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export {
  LOCAL_ANALYTICS_RETENTION_DAYS,
  clearLocalAnalytics,
  flushLocalAnalytics,
  pruneLocalAnalytics,
  recordLocalTaskCompletion,
  recordLocalToolOutcome,
  recordLocalTransportEvent,
  removeWorkspaceLocalAnalytics,
  readLocalUsageSnapshot,
  readLocalUsageSnapshotAsync
};
