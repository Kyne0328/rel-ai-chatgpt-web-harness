import { listManagedProcesses } from '../processManager.js';
import * as crypto from 'node:crypto';
import { createDashboardSnapshot } from '../contracts/dashboard.ts';
import { createEmptyTaskActivity } from '../contracts/tasks.ts';
import * as connection from '../connectionProfile.js';
import * as productUx from '../productUx.js';
import * as release from '../release.js';
import { deriveConnectionState } from '../desktopUxContracts.js';
import { getApplicationMetadata } from '../appMetadata.js';
import { readRecentTaskHistoryEvents, readTaskHistory } from '../taskHistoryStore.ts';
import { buildSafeActivityProjection, sanitizeActivityEventRecord, sanitizeTaskRecordForProjection } from '../taskObservability.js';
import { buildTaskSemanticProgress } from '../taskSemanticProgress.js';
import { eventIdentityKey, eventTimestampMs, eventTimestampValue } from '../taskEvents.js';
import { buildWorkspaceStates } from '../workspaceState.js';
import { runtimeCompatibility } from '../runtimeCompatibility.js';
import { mcpConnectionManager } from '../mcp/connectionManager.js';
import { readMcpAuthenticationStatus } from '../mcp/authenticationStatus.js';
type JsonRecord = Record<string, unknown>;
interface DashboardTaskActivity extends JsonRecord {
  revision?: number;
  taskId?: string;
  task?: JsonRecord;
  activityEvent?: JsonRecord;
}
interface DashboardDataRuntimeOptions {
  host?: string;
  port?: number;
  token?: string;
  getTaskActivity?: () => JsonRecord;
  getDesktopStatus?: () => JsonRecord;
}

const DASHBOARD_STREAM_ID = crypto.randomUUID();
let dashboardSnapshotSequence = 0;

type CoreConfig = JsonRecord;
type TaskRecord = JsonRecord;

interface TaskActivity extends JsonRecord {
  revision?: number;
  activeConnectorCalls?: number;
  activeCalls?: number;
  activeTaskCount?: number;
  tasks?: TaskRecord[];
  lastTask?: TaskRecord | null;
}

interface DashboardDataOptions extends DashboardDataRuntimeOptions {
  limit?: number;
  live?: unknown;
  snapshotRevision?: string;
}

function buildDashboardPayload(
  config: CoreConfig,
  options: DashboardDataOptions = {},
  requireHttpToken = false
): JsonRecord {
  const taskActivity: TaskActivity = typeof options.getTaskActivity === 'function'
    ? options.getTaskActivity() as TaskActivity
    : createEmptyTaskActivity();
  const connectionProjection = buildDashboardConnectionProjection(config, options);
  const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit || 100))));
  const base = productUx.dashboardData(config, { limit });
  const persistedTasks: TaskRecord[] = readTaskHistory(config, taskActivity, { limit, summary: true, maintain: false });
  const persistedActivityEvents = readRecentTaskHistoryEvents(config, limit * 2);
  const tasks = persistedTasks.map(summarizeDashboardTask);
  const liveActivityTasks = Array.isArray(taskActivity.tasks) ? taskActivity.tasks : [];
  const auditTail = mergeDashboardActivity(
    base.auditTail || { entries: [] },
    [...persistedTasks, { events: persistedActivityEvents }, ...liveActivityTasks],
    limit
  );
  const workspaceStates = buildWorkspaceStates(config, tasks, taskActivity);
  const runtimeState = runtimeCompatibility(config, { activeTaskCount: taskActivity.activeTaskCount });

  if (Array.isArray(base.config?.workspaces)) {
    for (const workspace of base.config.workspaces) workspace.operational = workspaceStates[workspace.alias] || null;
  }
  return {
    ...base,
    application: getApplicationMetadata(),
    runtime: runtimeState.runtime,
    repositoryRuntime: runtimeState.repository,
    runtimeCompatibility: runtimeState.compatibility,
    readiness: release.releaseReadiness(config, { requireHttpToken }),
    ...connectionProjection,
    ...(options.live ? { live: options.live } : {}),
    taskActivity: sanitizeTaskActivity(taskActivity),
    snapshot: createDashboardSnapshot({
      streamId: DASHBOARD_STREAM_ID,
      sequence: ++dashboardSnapshotSequence,
      revision: String(options.snapshotRevision || '')
    }),
    auditTail,
    tasks,
    workspaceStates,
    managedProcesses: listManagedProcesses(config, { limit: 200, activeOnly: true }).processes
  };
}

function buildDashboardTaskDelta(
  _options: DashboardDataOptions = {},
  activities: DashboardTaskActivity | DashboardTaskActivity[] = []
): JsonRecord {
  const batch = Array.isArray(activities) ? activities : [activities];
  const taskUpdates = new Map<string, { revision: number; task: JsonRecord }>();
  const activityEntries = new Map<string, JsonRecord>();
  let latest: DashboardTaskActivity | null = null;
  for (const activity of batch) {
    if (!activity || typeof activity !== 'object') continue;
    if (!latest || Number(activity.revision || 0) >= Number(latest.revision || 0)) latest = activity;
    const task = activity.task;
    const taskId = String(task?.taskId || task?.id || activity.taskId || '').trim();
    if (task && taskId) {
      const existing = taskUpdates.get(taskId);
      if (!existing || Number(activity.revision || 0) >= existing.revision) {
        taskUpdates.set(taskId, { revision: Number(activity.revision || 0), task });
      }
    }
    if (!activity.activityEvent) continue;
    const normalized = normalizeDashboardActivity({
      ...activity.activityEvent,
      workspace: activity.activityEvent.workspace || activity.workspace || task?.workspace || '',
      taskId: activity.activityEvent.taskId || taskId,
      sessionId: activity.activityEvent.sessionId || taskId
    });
    const key = eventIdentityKey(normalized, activityEntries.size, { preferId: true });
    const existing = activityEntries.get(key);
    activityEntries.set(key, existing ? mergeDashboardActivityEntry(existing, normalized) : normalized);
  }
  return {
    taskActivity: liveTaskActivityDelta(latest),
    taskUpdates: [...taskUpdates.values()].map(item => summarizeDashboardTask(item.task)),
    activityEntries: [...activityEntries.values()].sort((left, right) => eventTimestampMs(left) - eventTimestampMs(right))
  };
}

function liveTaskActivityDelta(activity: DashboardTaskActivity | null): TaskActivity {
  if (!activity) return createEmptyTaskActivity();
  const activeCalls = Math.max(0, Number(activity.activeCalls || 0));
  const activeTaskCount = Math.max(0, Number(activity.activeTaskCount || 0));
  return {
    state: activeCalls > 0 ? 'working' : activeTaskCount > 0 ? 'waiting' : 'idle',
    revision: Math.max(0, Number(activity.revision || 0)),
    activeConnectorCalls: Math.max(0, Number(activity.activeConnectorCalls || 0)),
    activeCalls,
    activeTaskCount
  };
}

function buildDashboardConnectionProjection(
  _config: CoreConfig,
  options: DashboardDataOptions = {},
  mcpOverride: JsonRecord | null = null
): JsonRecord {
  const profile = connection.readConnectionProfile();
  const desktopStatus: JsonRecord | null = typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null;
  const connectionSummary = connection.buildConnectionSummary({
    host: profile.host || options.host || '127.0.0.1',
    port: profile.port || options.port || 3333,
    token: '',
    tunnelId: profile.tunnelId || '',
    tunnelProvider: 'openai-secure-mcp'
  });
  const connectionStateInput = desktopStatus || {
    serverRunning: false,
    tunnelStatus: 'stopped'
  };
  const mcpConnection = mcpOverride || mcpConnectionManager.snapshot();
  return {
    connection: connectionSummary,
    connectionState: desktopStatus?.connectionState || deriveConnectionState(connectionStateInput),
    mcpConnection,
    mcpAuthentication: readMcpAuthenticationStatus(mcpConnection, {
      staticBearerConfigured: Boolean(options.token)
    }),
    desktopStatus
  };
}

function mergeDashboardActivity(auditTail: JsonRecord, tasks: TaskRecord[], limit: number): JsonRecord {
  const entries: JsonRecord[] = [];
  const positions = new Map<string, number>();
  const add = (entry: JsonRecord): void => {
    if (!entry || typeof entry !== 'object') return;
    const key = eventIdentityKey(entry, entries.length, { preferId: true });
    const normalized = normalizeDashboardActivity(entry);
    const existingPosition = positions.get(key);
    if (existingPosition !== undefined) entries[existingPosition] = mergeDashboardActivityEntry(entries[existingPosition]!, normalized);
    else {
      positions.set(key, entries.length);
      entries.push(normalized);
    }
  };
  const auditEntries = Array.isArray(auditTail.entries) ? auditTail.entries : [];
  for (const entry of auditEntries) add(asJsonRecord(entry));
  for (const task of tasks || []) {
    const taskEvents = Array.isArray(task.events) ? task.events : [];
    for (const rawEvent of taskEvents) {
      const event = asJsonRecord(rawEvent);
      add({
        ...event,
        workspace: event.workspace || task.workspace,
        taskId: event.taskId || task.id,
        sessionId: event.sessionId || task.id
      });
    }
  }
  entries.sort((left, right) => eventTimestampMs(left) - eventTimestampMs(right));
  return { ...(auditTail || {}), entries: entries.slice(-Math.max(1, Number(limit || 100))) };
}

function mergeDashboardActivityEntry(existing: JsonRecord, incoming: JsonRecord): JsonRecord {
  const merged = { ...existing, ...incoming };
  for (const key of ['summary', 'message', 'currentActivity', 'title', 'operation', 'path']) {
    if (!displayText(incoming?.[key]) && displayText(existing?.[key])) merged[key] = existing[key];
  }
  merged.safeCopy = buildSafeActivityProjection(merged, { alreadySanitized: true });
  return merged;
}

function displayText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeDashboardActivity(entry: JsonRecord): JsonRecord {
  entry = asJsonRecord(sanitizeActivityEventRecord(entry));
  const status = typeof entry.status === 'string' ? entry.status : entry.ok === false ? 'failed' : 'succeeded';
  const safeCopy = buildSafeActivityProjection({ ...entry, status }, { alreadySanitized: true });
  const tool = asJsonRecord(entry.tool);
  const result = asJsonRecord(entry.result);
  const error = asJsonRecord(entry.error);
  const target = asJsonRecord(entry.target);
  const toolName = typeof entry.tool === 'object' && entry.tool !== null ? tool.name : entry.tool;
  return {
    ...entry,
    id: entry.eventId || entry.id || entry.operationId,
    eventId: entry.eventId || entry.id || entry.operationId,
    ts: eventTimestampValue(entry),
    tool: toolName || entry.type || 'activity',
    operation: entry.title || tool.operation || entry.operation,
    message: entry.summary || entry.message || result.outcome || error.message || entry.error,
    error: typeof entry.error === 'object' && entry.error !== null ? error.message : entry.error,
    path: target.workspaceRelativePath || entry.path,
    resourceUri: target.resourceUri,
    status,
    ok: ['succeeded', 'completed'].includes(status) ? true : ['failed', 'blocked', 'cancelled'].includes(status) ? false : entry.ok,
    safeCopy,
    args: undefined,
    output: undefined
  };
}

function summarizeDashboardTask(task: JsonRecord): JsonRecord {
  if (!task || typeof task !== 'object') return task;
  const semanticProgress = buildTaskSemanticProgress(task);
  const { events: _events, ...withoutEvents } = task;
  const projected = sanitizeTaskRecordForProjection({ ...withoutEvents, semanticProgress });
  return projected && typeof projected === 'object' && !Array.isArray(projected) ? { ...projected } : {};
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function sanitizeTaskActivity(activity: TaskActivity = {}): TaskActivity {
  return {
    ...activity,
    tasks: Array.isArray(activity.tasks) ? activity.tasks.map(summarizeDashboardTask) : [],
    lastTask: activity.lastTask ? summarizeDashboardTask(activity.lastTask) : null
  };
}

export {
  buildDashboardConnectionProjection,
  buildDashboardPayload,
  buildDashboardTaskDelta,
  mergeDashboardActivity,
  summarizeDashboardTask
};
