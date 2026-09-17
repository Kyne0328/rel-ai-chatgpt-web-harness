import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import { readAudit } from '../audit.js';
import * as configEditor from '../configEditor.js';
import { ensureConfig, getConfigPath, readConfig } from '../config.js';
import * as connection from '../connectionProfile.js';
import { DASHBOARD_LIVE_EVENTS, createEmptyDashboardRevisions } from '../contracts/events.ts';
import { createWorkspaceUpdatePayload, type WorkspaceStateDto } from '../contracts/workspaces.ts';
import { clearWorkspaceValidationAffinity } from '../knowledgeStore.js';
import { removeWorkspaceLocalAnalytics } from '../localAnalytics.js';
import { readMcpAuthenticationStatus } from '../mcp/authenticationStatus.js';
import { mcpConnectionManager } from '../mcp/connectionManager.js';
import { buildToolManifest } from '../mcp/toolManifest.js';
import { getOnboardingStatus, writeOnboardingState } from '../onboardingState.js';
import { resolvePolicy } from '../policyResolver.js';
import * as productUx from '../productUx.js';
import * as release from '../release.js';
import { getReleaseNotes } from '../releaseNotes.js';
import { repositoryIntelligence } from '../repository/intelligence/service.js';
import { withStateDatabase } from '../stateDatabase.ts';
import { clearWorkspaceTaskHistory, readTaskHistory, readTaskHistorySession } from '../taskHistoryStore.ts';
import { getToolActivity, onToolActivity } from '../toolActivity.js';
import { getToolMetadata } from '../tools.js';
import { listManagedProcesses, managedProcessStateRevision, onManagedProcessChange } from '../processManager.js';
import { onWorkspaceStateChange, workspaceStateRevision } from '../workspaceState.js';
import { buildDashboardConnectionProjection, buildDashboardPayload, buildDashboardTaskDelta, mergeDashboardActivity } from './dashboard-data.ts';
import { createDashboardTaskEventBatcher, type DashboardTaskBatch } from './dashboard-event-batcher.ts';
import { workspacePathPreflight } from './dashboard-actions.ts';

type JsonRecord = Record<string, unknown>;
type Unsubscribe = () => void;

export interface DashboardRuntimeOptions {
  host?: string;
  port?: number;
  token?: string;
  getTaskActivity?: () => JsonRecord;
  getDesktopStatus?: () => JsonRecord;
  onDesktopStatusChange?: (listener: (status: JsonRecord) => void) => Unsubscribe;
  getRuntimeLogs?: (options?: { limit?: number }) => JsonRecord;
  onRuntimeLogChange?: (listener: (change: JsonRecord) => void) => Unsubscribe;
}

export interface DashboardEventSink {
  onReady: (payload: JsonRecord) => void;
  onEvent: (eventName: string, payload: JsonRecord) => void;
  onError: (error: unknown) => void;
}

const DASHBOARD_EVENT_STREAM_ID = crypto.randomUUID();
let dashboardEventSequence = 0;
let dashboardConnectionRevision = 0;
let dashboardConnectionMcpRevision = -1;
let dashboardConnectionDesktopRevision = '';
const configCache: { path: string; mtimeMs: number; value: JsonRecord | null } = { path: '', mtimeMs: -1, value: null };

export function dashboardTools(): JsonRecord {
  return getToolMetadata();
}

export function dashboardOnboardingStatus(): JsonRecord {
  return { ok: true, ...getOnboardingStatus() };
}

export function dashboardConnection(options: DashboardRuntimeOptions = {}): JsonRecord {
  const latestProfile = connection.readConnectionProfile();
  const mcpConnection = mcpConnectionManager.snapshot();
  return {
    ...connection.buildConnectionSummary({
      host: latestProfile.host || options.host,
      port: latestProfile.port || options.port,
      token: options.token,
      tunnelId: latestProfile.tunnelId || '',
      tunnelProvider: 'openai-secure-mcp',
      showToken: false,
      includeTokenInUrls: false
    }),
    mcpConnection,
    mcpAuthentication: readMcpAuthenticationStatus(mcpConnection, {
      staticBearerConfigured: Boolean(options.token)
    })
  };
}

export function dashboardRequiresHttpToken(raw: string | null | undefined): boolean {
  if (raw != null) return raw !== '0';
  return readConfig()?.release?.requireHttpToken !== false;
}

export function dashboardSnapshot(
  options: DashboardRuntimeOptions,
  details: { limit?: number; requireHttpToken?: boolean } = {}
): JsonRecord {
  const config = readConfig();
  const live = dashboardLiveMetadata(options);
  return buildDashboardPayload(config, {
    ...options,
    limit: Number(details.limit || 100),
    snapshotRevision: dashboardSourceRevision(options, config),
    live
  }, details.requireHttpToken === true);
}

export async function dashboardWorkspacePreflight(details: {
  path?: string;
  workspace?: string;
  requireClean?: boolean;
}): Promise<JsonRecord> {
  if (details.path) return { ...workspacePathPreflight(details.path) };
  return await release.workspacePreflight(readConfig(), {
    workspace: details.workspace || '',
    requireClean: details.requireClean !== false
  });
}

export function completeDashboardOnboarding(payload: JsonRecord): JsonRecord {
  ensureConfig();
  writeOnboardingState({
    completed: Boolean(payload.completed),
    skipped: Boolean(payload.skipped),
    source: String(payload.source || ''),
    handoffPending: payload.handoffPending === true,
    updatedAt: new Date().toISOString()
  });
  return { ok: true };
}

export async function updateDashboardWorkspace(payload: JsonRecord): Promise<JsonRecord> {
  const current = readConfig();
  const action = String(payload.action || 'upsert').toLowerCase();
  const workspaceConfig = asJsonRecord(payload.workspaceConfig);
  const originalAlias = String(payload.originalAlias || workspaceConfig.originalAlias || payload.alias || payload.workspace || '').trim();
  const previousWorkspace = current.workspaces?.[originalAlias]
    ? { alias: originalAlias, ...current.workspaces[originalAlias] }
    : null;
  const deleting = previousWorkspace && ['delete', 'clear'].includes(action);
  if (deleting) {
    if (payload.confirmDelete !== true && payload.confirmClear !== true) {
      throw new Error('Workspace removal requires confirmDelete=true (or confirmClear=true).');
    }
    const policyActive = Math.max(0, Number(resolvePolicy(previousWorkspace, current).activeTaskCount || 0));
    const liveActive = getToolActivity().tasks.filter((task: JsonRecord) => String(task.workspace || '').trim() === originalAlias).length;
    const active = Math.max(policyActive, liveActive);
    if (active > 0) {
      throw new Error(`Cannot delete project '${originalAlias}' while ${active} Rel.AI ${active === 1 ? 'task is' : 'tasks are'} still active in it.`);
    }
    if (payload.forgetLocalData !== false) await clearDashboardWorkspaceLocalData(current, originalAlias);
  }
  const result = configEditor.updateWorkspace(current, payload);
  if (previousWorkspace && ['upsert', 'delete', 'clear'].includes(action)) {
    await Promise.allSettled([
      repositoryIntelligence.dispose(previousWorkspace, current, { removeCache: action === 'delete' || action === 'clear' })
    ]);
  }
  await refreshMcpManifest('workspaces_changed');
  return result;
}

async function clearDashboardWorkspaceLocalData(config: JsonRecord, workspace: string): Promise<void> {
  const history = await clearWorkspaceTaskHistory(config, workspace);
  withStateDatabase(config, db => {
    db.prepare('DELETE FROM session_policies WHERE workspace=?').run(workspace);

    const taskIds = new Set(history.taskIds);
    const taskRows = db.prepare('SELECT task_id,payload FROM task_integrity_tasks').all() as Array<{ task_id?: unknown; payload?: unknown }>;
    for (const row of taskRows) {
      try {
        const payload = JSON.parse(String(row.payload || '')) as JsonRecord;
        if (String(payload.workspace || '').trim() === workspace) taskIds.add(String(row.task_id || ''));
      } catch {}
    }
    const removeTaskIntegrity = db.prepare('DELETE FROM task_integrity_tasks WHERE task_id=?');
    for (const taskId of taskIds) if (taskId) removeTaskIntegrity.run(taskId);

    const workspaceRows = db.prepare('SELECT workspace,payload FROM workspace_integrity').all() as Array<{ workspace?: unknown; payload?: unknown }>;
    const removeWorkspaceIntegrity = db.prepare('DELETE FROM workspace_integrity WHERE workspace=?');
    for (const row of workspaceRows) {
      let matches = String(row.workspace || '').trim() === workspace;
      if (!matches) {
        try {
          const payload = JSON.parse(String(row.payload || '')) as JsonRecord;
          matches = String(payload.workspace || '').trim() === workspace;
        } catch {}
      }
      if (matches) removeWorkspaceIntegrity.run(String(row.workspace || ''));
    }
  }, { transaction: true });
  removeWorkspaceLocalAnalytics(config, workspace);
  clearWorkspaceValidationAffinity(config, workspace);
}

export function dashboardTaskSession(taskId: string): JsonRecord | null {
  const config = readConfig();
  const session = readTaskHistorySession(config, taskId);
  if (!session) return null;
  const audit = readAudit(config, { taskId, limit: 10000 });
  return {
    ok: true,
    session,
    trace: {
      source: 'local_audit',
      diagnosticOnly: true,
      entries: audit.entries,
      count: audit.entries.length,
      limited: audit.entries.length >= 10000,
      persistence: audit.persistence
    }
  };
}

export function dashboardLogs(options: DashboardRuntimeOptions = {}, limit = 100): JsonRecord {
  const config = readConfig();
  const taskActivity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : {};
  const requestedLimit = Math.min(500, Math.max(1, Math.floor(Number(limit || 100))));
  const tasks = readTaskHistory(config, taskActivity, { limit: requestedLimit, summary: true, maintain: false });
  return mergeDashboardActivity(productUx.liveLogTail(config, { limit: requestedLimit }), tasks, requestedLimit);
}

export function dashboardReleaseNotes(): JsonRecord {
  return getReleaseNotes();
}

export function createDashboardEventSubscription(
  options: DashboardRuntimeOptions,
  sink: DashboardEventSink
): { close: () => void } {
  const sendDomain = (eventName: string, domain: string, revision: number, payload: JsonRecord): void => {
    const sequence = ++dashboardEventSequence;
    sink.onEvent(eventName, {
      ok: true,
      streamId: DASHBOARD_EVENT_STREAM_ID,
      sequence,
      domain,
      revision: Number(revision || 0),
      generatedAt: new Date().toISOString(),
      ...payload
    });
  };

  const sendConnection = (snapshot: JsonRecord | null = null): void => {
    try {
      const config = readConfigCached();
      const mcp = snapshot || mcpConnectionManager.snapshot();
      const desktopStatus = typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null;
      sendDomain(
        DASHBOARD_LIVE_EVENTS.CONNECTION_UPDATED,
        'connection',
        connectionLiveRevision(mcp, desktopStatus),
        buildDashboardConnectionProjection(config, options, mcp)
      );
    } catch (error) {
      sink.onError(error);
    }
  };

  let lastDesktopRevision = desktopStatusRevision(typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null);
  const sendDesktopConnectionIfChanged = (): void => {
    const current = desktopStatusRevision(typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null);
    if (current === lastDesktopRevision) return;
    lastDesktopRevision = current;
    sendConnection();
  };

  try {
    const taskActivity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : null;
    const connectionSnapshot = mcpConnectionManager.snapshot();
    sink.onReady({
      ok: true,
      generatedAt: new Date().toISOString(),
      ...dashboardLiveMetadata(options, { ...(taskActivity ? { taskActivity } : {}), connectionSnapshot })
    });
  } catch (error) {
    sink.onError(error);
  }

  const taskEvents = createDashboardTaskEventBatcher({
    onFlush: (batch: DashboardTaskBatch) => {
      try {
        sendDomain(DASHBOARD_LIVE_EVENTS.TASK_UPDATED, 'task', batch.revision, buildDashboardTaskDelta(options, batch.activities));
        sendDesktopConnectionIfChanged();
      } catch (error) {
        sink.onError(error);
      }
    }
  });
  const unsubscribe = onToolActivity((activity: JsonRecord) => taskEvents.push(activity));
  const unsubscribeConnection = mcpConnectionManager.onChange((snapshot: JsonRecord) => sendConnection(snapshot));
  const unsubscribeDesktopStatus = typeof options.onDesktopStatusChange === 'function'
    ? options.onDesktopStatusChange(() => sendDesktopConnectionIfChanged())
    : () => {};
  const unsubscribeWorkspace = onWorkspaceStateChange((event: { version: number; alias: string; state: WorkspaceStateDto }) => {
    sendDomain(DASHBOARD_LIVE_EVENTS.WORKSPACE_UPDATED, 'workspace', event.version, createWorkspaceUpdatePayload(event.alias, event.state));
  });
  const unsubscribeProcess = onManagedProcessChange((event) => {
    try {
      const config = readConfigCached();
      sendDomain(DASHBOARD_LIVE_EVENTS.PROCESS_UPDATED, 'process', event.revision, {
        managedProcesses: listManagedProcesses(config, { limit: 200, activeOnly: true }).processes
      });
    } catch (error) {
      sink.onError(error);
    }
  });
  const unsubscribeDiagnostics = typeof options.onRuntimeLogChange === 'function'
    ? options.onRuntimeLogChange((change: JsonRecord) => sendDomain(DASHBOARD_LIVE_EVENTS.DIAGNOSTICS_UPDATED, 'diagnostics', Number(change.revision || 0), { change }))
    : () => {};

  return {
    close(): void {
      unsubscribe();
      unsubscribeConnection();
      unsubscribeDesktopStatus();
      unsubscribeWorkspace();
      unsubscribeProcess();
      unsubscribeDiagnostics();
      taskEvents.close();
    }
  };
}

async function refreshMcpManifest(trigger: string): Promise<void> {
  await mcpConnectionManager.observeManifest(buildToolManifest(readConfig()), trigger);
}

function readConfigCached(): JsonRecord {
  const configPath = getConfigPath();
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(configPath).mtimeMs; } catch {}
  if (mtimeMs != null && configCache.value && configCache.path === configPath && configCache.mtimeMs === mtimeMs) {
    return configCache.value;
  }
  const value = readConfig();
  if (mtimeMs != null) {
    configCache.path = configPath;
    configCache.mtimeMs = mtimeMs;
    configCache.value = value;
  }
  return value;
}

function statSignature(file: string | null | undefined): string {
  try {
    if (!file) return '0:0';
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '0:0';
  }
}

function dashboardSourceRevision(options: DashboardRuntimeOptions = {}, configOverride: JsonRecord | null = null): string {
  let config = configOverride;
  try { config ||= readConfigCached(); } catch { config = null; }
  const taskActivity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : null;
  const desktopStatus = typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null;
  const signature = [
    statSignature(getConfigPath()),
    statSignature(typeof config?.auditLogPath === 'string' ? config.auditLogPath : null),
    taskActivityRevision(taskActivity),
    desktopStatusRevision(desktopStatus),
    String(mcpConnectionManager.snapshot().revision),
    String(workspaceStateRevision())
  ].join('|');
  return crypto.createHash('sha256').update(signature).digest('base64url');
}

function taskActivityRevision(activity: JsonRecord | null = null): string {
  if (!activity) return '0';
  const explicit = Number(activity.revision);
  if (Number.isFinite(explicit)) return String(explicit);
  const lastTask = asJsonRecord(activity.lastTask);
  return JSON.stringify([
    activity.state || '',
    Number(activity.activeCalls || 0),
    Number(activity.activeTaskCount || 0),
    activity.taskId || '',
    lastTask.updatedAt || lastTask.completedAt || ''
  ]);
}

function desktopStatusRevision(status: JsonRecord | null = null): string {
  if (!status) return '0';
  const connectionState = asJsonRecord(status.connectionState);
  return JSON.stringify([
    status.serverRunning === true,
    status.starting === true,
    status.tunnelStatus || '',
    status.tunnelId || '',
    status.tunnelHealthUrl || '',
    status.localMcpUrl || '',
    status.localUrl || '',
    status.mcpUrl || '',
    status.errorCode || '',
    status.error || '',
    connectionState.overall || connectionState.status || ''
  ]);
}

function dashboardLiveMetadata(
  options: DashboardRuntimeOptions = {},
  overrides: { taskActivity?: JsonRecord; connectionSnapshot?: JsonRecord; desktopStatus?: JsonRecord } = {}
): { streamId: string; revisions: ReturnType<typeof createEmptyDashboardRevisions> } {
  const taskActivity = overrides.taskActivity
    ?? (typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : null);
  const connectionSnapshot = overrides.connectionSnapshot ?? mcpConnectionManager.snapshot();
  const desktopStatus = overrides.desktopStatus
    ?? (typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null);
  const runtimeLogs = typeof options.getRuntimeLogs === 'function' ? options.getRuntimeLogs({ limit: 1 }) : null;
  const revisions = createEmptyDashboardRevisions();
  revisions.task = Number(taskActivity?.revision || 0);
  revisions.connection = connectionLiveRevision(connectionSnapshot, desktopStatus);
  revisions.workspace = Number(workspaceStateRevision() || 0);
  revisions.process = Number(managedProcessStateRevision() || 0);
  revisions.diagnostics = Number(runtimeLogs?.revision || 0);
  return { streamId: DASHBOARD_EVENT_STREAM_ID, revisions };
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function connectionLiveRevision(connectionSnapshot: JsonRecord | null = null, desktopStatus: JsonRecord | null = null): number {
  const mcpRevision = Number(connectionSnapshot?.revision || 0);
  const desktopRevision = desktopStatusRevision(desktopStatus);
  if (mcpRevision !== dashboardConnectionMcpRevision || desktopRevision !== dashboardConnectionDesktopRevision) {
    dashboardConnectionMcpRevision = mcpRevision;
    dashboardConnectionDesktopRevision = desktopRevision;
    dashboardConnectionRevision += 1;
  }
  return dashboardConnectionRevision;
}
