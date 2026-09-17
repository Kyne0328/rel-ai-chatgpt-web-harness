import type { TaskActivityDto, TaskDto } from './contracts/tasks.ts';
import { DEFAULT_TASK_IDLE_MS } from './toolActivity.js';
import {
  completeProgress,
  normalizeTaskProgress,
  sanitizeActivityEventRecord,
  sanitizeDisplayText,
  sanitizeTaskRecord,
  sanitizeTaskRecordForProjection
} from './taskObservability.js';
import { isTerminalTaskStatus } from './taskState.js';
import { canonicalTaskSnapshot, mergeTaskLifecycleSnapshots, reduceTaskLifecycleAuditEvent } from './taskLifecycle.js';
import { DEFAULT_TASK_STALE_MS } from './taskTiming.js';
import { clamp, cleanTaskId, eventIdentityKey, eventTime, eventTimestampMs, isCurrentTaskEvent, timestampMs } from './taskEvents.js';
import {
  MAX_SESSIONS,
  clearTaskHistory as clearStoredTaskHistory,
  ensureCurrentHistory,
  findSessionsContaining,
  getTaskHistoryDir,
  listRecentSessionEvents,
  listSessionSummaries,
  listSessions,
  pruneSessions,
  readSession,
  removeSession,
  removeWorkspaceSessions,
  writeSession,
  writeSessionAsync,
  type StoredTaskSession,
  type TaskHistoryConfig
} from './taskHistoryStorage.ts';
import { OPERATION_IDS as OP } from './tools/operationIds.js';
import { queryTaskSignature, taskEpisodeMatch } from './context/taskEpisodeRelevance.js';

const STORE_VERSION = 3;
const MAX_SESSION_EVENTS = 200;
const TASK_HISTORY_FLUSH_MS = 75;
const TASK_HISTORY_PRUNE_DELAY_MS = 1500;
const TASK_HISTORY_RETRY_BASE_MS = 1000;
const TASK_HISTORY_RETRY_MAX_MS = 15_000;

type TaskRecord = TaskDto & Record<string, any>;
type TaskActivitySnapshot = Omit<Partial<TaskActivityDto>, 'tasks'> & {
  tasks?: Array<TaskDto | Record<string, any>>;
} & Record<string, any>;
type HistoryEvent = Record<string, any>;
type WorkflowReceipt = Record<string, any>;

interface PersistenceOptions {
  defer?: boolean;
}

interface ReadSessionOptions {
  activeTaskIds?: Set<string> | string[];
  reconcileInactive?: boolean;
}

interface ReadHistoryOptions {
  limit?: number;
  summary?: boolean;
  maintain?: boolean;
}

interface EpisodeOptions {
  excludeTaskId?: unknown;
  limit?: number;
}

interface ContinuityOptions {
  excludeTaskId?: unknown;
  limit?: number;
}

interface PendingSession {
  directory: string;
  session: TaskRecord;
  writing: boolean;
  version: number;
  persistedVersion: number;
  retryCount: number;
  promise: Promise<boolean>;
}

interface PersistenceState {
  lastError: string;
  lastFailureAt: string | null;
  retryCount: number;
}

interface PersistenceSnapshot {
  healthy: boolean;
  pending: number;
  scheduledFlushes: number;
  retryCount: number;
  lastFailureAt: string | null;
  lastError: string;
}

const pendingSessions = new Map<string, PendingSession>();
const pendingFlushTimers = new Map<string, NodeJS.Timeout>();
const pendingPrunes = new Map<string, NodeJS.Timeout>();
let activityPersistenceBound = false;
let taskHistoryPersistenceState: PersistenceState = { lastError: '', lastFailureAt: null, retryCount: 0 };

function recordTaskHistoryEvent(config: TaskHistoryConfig, event: HistoryEvent): TaskRecord | null {
  if (!isCurrentTaskEvent(event)) return null;
  ensureCurrentHistory(config);
  const directory = getTaskHistoryDir(config);
  const taskId = cleanTaskId(event.taskId);
  const session = reduceTaskLifecycleAuditEvent(readWorkingSession(directory, taskId) || emptySession(taskId), event) as TaskRecord;
  persistSession(directory, session);
  return publicSession(session);
}

function bindTaskHistoryActivityPersistence(
  onActivity: ((listener: (activity: TaskActivitySnapshot) => void) => unknown) | null | undefined,
  getConfig: (() => TaskHistoryConfig) | null | undefined
): void {
  if (activityPersistenceBound || typeof onActivity !== 'function' || typeof getConfig !== 'function') return;
  activityPersistenceBound = true;
  onActivity((activity: TaskActivitySnapshot) => {
    if (activity?.phase === 'progress') return;
    try {
      recordTaskActivityEvent(getConfig(), activity, { defer: true });
    } catch (error) {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] live task history stage:', error);
    }
  });
}

function recordTaskActivityEvent(config: TaskHistoryConfig, activity: TaskActivitySnapshot = {}, options: PersistenceOptions = {}): TaskRecord | null {
  const task = activity.task && typeof activity.task === 'object' ? activity.task as TaskRecord : null;
  const taskId = cleanTaskId(task?.taskId || task?.id || activity.taskId);
  if (!taskId) return null;
  ensureCurrentHistory(config);
  const directory = getTaskHistoryDir(config);
  const existing = readWorkingSession(directory, taskId) || emptySession(taskId);
  const event = activity.activityEvent && typeof activity.activityEvent === 'object' ? activity.activityEvent as HistoryEvent : null;
  const live = canonicalTaskSnapshot({
    ...task,
    id: taskId,
    taskId,
    sessionId: task?.sessionId || taskId,
    workspace: task?.workspace || activity.workspace || existing.workspace || '',
    lastTool: task?.lastTool || task?.tool || activity.tool || existing.lastTool || '',
    operation: task?.operation || task?.lastOperation || activity.operation || existing.operation || '',
    currentActivity: task?.currentActivity || event?.summary || existing.currentActivity || '',
    events: upsertActivityEvent(existing.events || [], event)
  }) as TaskRecord;
  const session = mergeTaskLifecycleSnapshots(existing, live) as TaskRecord;
  persistSession(directory, session, options);
  return publicSession(session);
}

function recordWorkflowEvidence(config: TaskHistoryConfig, taskId: unknown, receipt: WorkflowReceipt, options: PersistenceOptions = {}): WorkflowReceipt | null {
  const recorded = recordWorkflowEvidenceBatch(config, taskId, [receipt], options);
  return recorded.length ? receipt : null;
}

function recordWorkflowEvidenceBatch(
  config: TaskHistoryConfig,
  taskId: unknown,
  receipts: WorkflowReceipt[],
  options: PersistenceOptions = {}
): WorkflowReceipt[] {
  const id = cleanTaskId(taskId);
  const validReceipts = (Array.isArray(receipts) ? receipts : [])
    .filter((receipt: WorkflowReceipt) => receipt && typeof receipt === 'object');
  if (!id || !validReceipts.length) return [];
  ensureCurrentHistory(config);
  const directory = getTaskHistoryDir(config);
  const session = readWorkingSession(directory, id);
  if (!session) return [];
  const evidence = [...(Array.isArray(session.workflowEvidence) ? session.workflowEvidence : []), ...validReceipts].slice(-100);
  const next = { ...session, workflowEvidence: evidence } as TaskRecord;
  persistSession(directory, next, options);
  return validReceipts;
}

function recordTaskBackgroundOperation(config: TaskHistoryConfig, taskId: unknown, operation: unknown, options: PersistenceOptions = {}): Record<string, any> | null {
  const id = cleanTaskId(taskId);
  if (!id) return null;
  ensureCurrentHistory(config);
  const directory = getTaskHistoryDir(config);
  const session = readWorkingSession(directory, id);
  if (!session) return null;
  const next = { ...session } as TaskRecord;
  if (operation && typeof operation === 'object') next.backgroundOperation = operation;
  else delete next.backgroundOperation;
  persistSession(directory, next, options);
  return (sanitizeTaskRecord({ status: 'planning', backgroundOperation: next.backgroundOperation }) as TaskRecord | null)?.backgroundOperation || null;
}

function readTaskBackgroundOperation(config: TaskHistoryConfig, taskId: unknown): Record<string, any> | null {
  const id = cleanTaskId(taskId);
  if (!id) return null;
  try {
    ensureCurrentHistory(config);
    const operation = readWorkingSession(getTaskHistoryDir(config), id)?.backgroundOperation;
    return (sanitizeTaskRecord({ status: 'planning', backgroundOperation: operation }) as TaskRecord | null)?.backgroundOperation || null;
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task background operation read:', error);
    return null;
  }
}

function readRecentWorkflowEvidence(config: TaskHistoryConfig, taskId: unknown, limit = 50): WorkflowReceipt[] {
  const id = cleanTaskId(taskId);
  if (!id) return [];
  try {
    ensureCurrentHistory(config);
    const session = readWorkingSession(getTaskHistoryDir(config), id);
    const durableEvidence = Array.isArray(session?.workflowEvidence) ? session.workflowEvidence : [];
    return durableEvidence
      .slice(-clamp(limit, 1, 100))
      .map((item: WorkflowReceipt) => ({ ...item }));
  } catch {
    return [];
  }
}

function readTaskHistorySession(config: TaskHistoryConfig, taskId: unknown): TaskRecord | null {
  const session = readTaskHistorySessionRecord(config, taskId);
  return session ? publicSession(session) : null;
}

function readTaskHistorySessionRecord(config: TaskHistoryConfig, taskId: unknown, options: ReadSessionOptions = {}): TaskRecord | null {
  const id = cleanTaskId(taskId);
  if (!id) return null;
  try {
    ensureCurrentHistory(config);
    const directory = getTaskHistoryDir(config);
    const session = readWorkingSession(directory, id);
    if (!session) return null;
    const activeIds = options.activeTaskIds instanceof Set
      ? options.activeTaskIds
      : new Set(Array.isArray(options.activeTaskIds) ? options.activeTaskIds.map(String) : []);
    const reconciled = options.reconcileInactive === true
      ? reconcileInactiveStoredSession(session, activeIds)
      : session;
    if (reconciled !== session) persistSession(directory, reconciled, { defer: true });
    return sanitizeTaskRecord(reconciled) as TaskRecord;
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task history session read:', error);
    return null;
  }
}

function readTaskHistory(config: TaskHistoryConfig, activity: TaskActivitySnapshot = {}, options: ReadHistoryOptions = {}): TaskRecord[] {
  const limit = clamp(options.limit || 100, 1, MAX_SESSIONS);
  const active = (Array.isArray(activity?.tasks) ? activity.tasks : [])
    .map((task: TaskDto | Record<string, any>) => canonicalTaskSnapshot(task) as TaskRecord)
    .slice(0, MAX_SESSIONS);
  const activeIds = new Set(active.filter((session: TaskRecord) => session.status !== 'inactive').map((session: TaskRecord) => session.id).filter(Boolean));
  const maintain = options.maintain !== false;
  const storedLimit = Math.min(MAX_SESSIONS, Math.max(limit, active.length));
  const directory = getTaskHistoryDir(config);
  let persisted: TaskRecord[] = [];
  try {
    ensureCurrentHistory(config);
    const storedSessions = options.summary === true
      ? listSessionSummaries(directory, storedLimit)
      : listSessions(directory, storedLimit);
    persisted = storedSessions.map((session: StoredTaskSession) => {
      const pending = readPendingSession(directory, session.id);
      const needsFullRecord = options.summary === true
        && !pending
        && session.status !== 'inactive'
        && !isTerminalTaskStatus(session.status);
      const current = pending || (needsFullRecord ? readSession(directory, session.id) : null) || session as TaskRecord;
      if (isStoredSessionNoise(current, activeIds)) {
        if (maintain) discardStoredSession(directory, current.id);
        return null;
      }
      const reconciled = reconcileInactiveStoredSession(current, activeIds);
      if (maintain && reconciled !== current) persistSession(directory, reconciled, { defer: true });
      return reconciled;
    }).filter((session: TaskRecord | null): session is TaskRecord => Boolean(session));
    const persistedIds = new Set(persisted.map((session: TaskRecord) => session.id));
    for (const session of pendingSessionsForDirectory(directory)) {
      if (!persistedIds.has(session.id)) persisted.push(session);
    }
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] session history read:', error);
  }
  const byId = new Map<string, TaskRecord>(persisted.map((session: TaskRecord) => [session.id, session]));
  for (const task of active) {
    const existing = byId.get(task.id);
    if (existing && task.status === 'inactive') continue;
    byId.set(task.id, existing ? mergeTaskLifecycleSnapshots(existing, task) as TaskRecord : task);
  }
  return [...byId.values()]
    .sort((left, right) => eventTime(right) - eventTime(left))
    .slice(0, limit)
    .map(publicSession);
}

function readRecentTaskHistoryEvents(config: TaskHistoryConfig, limit = 200): HistoryEvent[] {
  try {
    const directory = getTaskHistoryDir(config);
    return listRecentSessionEvents(directory, clamp(limit || 200, 1, 1000))
      .map((event: HistoryEvent) => sanitizeActivityEventRecord(event) as HistoryEvent)
      .filter((event: HistoryEvent | null): event is HistoryEvent => Boolean(event));
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] recent task history event read:', error);
    return [];
  }
}

function readRelevantTaskEpisodes(config: TaskHistoryConfig, workspace: unknown, query: unknown, options: EpisodeOptions = {}): Record<string, any>[] {
  const workspaceAlias = String((workspace as Record<string, any>)?.alias || workspace || '').trim();
  if (!workspaceAlias || !String(query || '').trim()) return [];
  const excludeTaskId = cleanTaskId(options.excludeTaskId);
  const limit = clamp(options.limit || 3, 1, 5);
  return retrievalCandidateSessions(config, workspaceAlias, query)
    .filter((session: TaskRecord) => String(session.workspace || '') === workspaceAlias)
    .filter((session: TaskRecord) => !excludeTaskId || cleanTaskId(session.id) !== excludeTaskId)
    .filter((session: TaskRecord) => session.status === 'completed' && session.completionKnown === true)
    .map((session: TaskRecord, index: number) => ({ session, index, match: taskEpisodeMatch(session, query) }))
    .filter((item): item is { session: TaskRecord; index: number; match: NonNullable<ReturnType<typeof taskEpisodeMatch>> } => Boolean(item.match))
    .sort((left, right) => right.match.score - left.match.score || left.index - right.index)
    .slice(0, limit)
    .map(item => compactTaskEpisode(item.session, item.match));
}

function readCrossWorkspaceTaskEpisodes(config: TaskHistoryConfig, workspace: unknown, query: unknown, options: EpisodeOptions = {}): Record<string, any>[] {
  const workspaceAlias = String((workspace as Record<string, any>)?.alias || workspace || '').trim();
  if (!String(query || '').trim()) return [];
  const excludeTaskId = cleanTaskId(options.excludeTaskId);
  const limit = clamp(options.limit || 2, 1, 4);
  return retrievalCandidateSessions(config, workspaceAlias, query, { portable: true })
    .filter((session: TaskRecord) => !workspaceAlias || String(session.workspace || '') !== workspaceAlias)
    .filter((session: TaskRecord) => !excludeTaskId || cleanTaskId(session.id) !== excludeTaskId)
    .filter((session: TaskRecord) => session.status === 'completed' && session.completionKnown === true)
    .map((session: TaskRecord, index: number) => ({ session, index, match: taskEpisodeMatch(session, query, { portable: true }) }))
    .filter((item): item is { session: TaskRecord; index: number; match: NonNullable<ReturnType<typeof taskEpisodeMatch>> } => Boolean(item.match))
    .sort((left, right) => right.match.score - left.match.score || left.index - right.index)
    .slice(0, limit)
    .map(item => compactPortableTaskEpisode(item.session, item.match));
}

function findTaskReuseCandidates(config: TaskHistoryConfig, workspaceAlias: unknown, conversationId: unknown, limit = 24): TaskRecord[] {
  const workspace = String(workspaceAlias || '').trim();
  const conversation = String(conversationId || '').trim();
  if (!workspace || !conversation) return [];
  try {
    const directory = getTaskHistoryDir(config);
    const sessions = findSessionsContaining(directory, [conversation], {
      workspace,
      limit: clamp(limit || 24, 1, 50)
    });
    return (Array.isArray(sessions) ? sessions : [])
      .filter(session => Boolean(session?.id))
      .map(session => readWorkingSession(directory, String(session.id)) || session) as TaskRecord[];
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task reuse candidate search:', error);
    return [];
  }
}

function retrievalCandidateSessions(config: TaskHistoryConfig, workspaceAlias: string, query: unknown, options: { portable?: boolean } = {}): TaskRecord[] {
  const signature = queryTaskSignature(query);
  const exactNeedles = uniqueStrings([...signature.identifiers, ...signature.paths, ...signature.pathScopes])
    .filter(value => value.length >= 4)
    .slice(0, 12);
  if (!exactNeedles.length) return readTaskHistory(config, {}, { limit: MAX_SESSIONS, summary: true });
  const exactLimit = Math.min(MAX_SESSIONS, Math.max(24, exactNeedles.length * 8));
  let exact: StoredTaskSession[] = [];
  try {
    exact = findSessionsContaining(getTaskHistoryDir(config), exactNeedles, {
      limit: exactLimit,
      ...(options.portable === true
        ? (workspaceAlias ? { excludeWorkspace: workspaceAlias } : {})
        : { workspace: workspaceAlias })
    });
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task episode candidate search:', error);
    exact = [];
  }
  const recent = readTaskHistory(config, {}, { limit: 100, summary: true });
  const byId = new Map(recent.map(session => [session.id, session]));
  for (const session of exact) {
    const record = session as TaskRecord;
    if (record?.id) byId.set(record.id, publicSession(record));
  }
  return [...byId.values()];
}

function readConversationContinuity(config: TaskHistoryConfig, conversationId: unknown, options: ContinuityOptions = {}): Record<string, any>[] {
  const id = String(conversationId || '').trim();
  if (!id) return [];
  const excludeTaskId = cleanTaskId(options.excludeTaskId);
  const limit = clamp(options.limit || 3, 1, 5);
  let candidates: TaskRecord[] | null = null;
  if (id.length >= 4) {
    try {
      const exact = findSessionsContaining(getTaskHistoryDir(config), [id], { limit: 20 });
      candidates = (Array.isArray(exact) ? exact : [])
        .map(session => publicSession(session as TaskRecord))
        .filter(session => Boolean(session?.id));
    } catch (error) {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] conversation continuity search:', error);
      candidates = null;
    }
  }
  if (!candidates) {
    try {
      candidates = readTaskHistory(config, {}, { limit: 100, summary: true });
    } catch {
      return [];
    }
  }
  return candidates
    .filter((session: TaskRecord) => String(session?.correlation?.conversationId || '') === id)
    .filter((session: TaskRecord) => !excludeTaskId || cleanTaskId(session.id) !== excludeTaskId)
    .filter((session: TaskRecord) => session.status === 'completed' && session.completionKnown === true)
    .slice(0, limit)
    .map((session: TaskRecord) => compactPortableTaskEpisode(session));
}

function compactTaskEpisode(session: TaskRecord, match: { confidence: number; strength: string; reasons: string[] } | null = null): Record<string, any> {
  const changes = uniqueStrings(session.changedFiles).slice(0, 6).map(file => compactText(file, 160));
  const goal = compactText(session.objective || session.title, 300);
  const outcome = compactText(session.resultSummary || session.summary, 600);
  return {
    ...(goal ? { goal } : {}),
    ...(outcome ? { outcome } : {}),
    ...(changes.length ? { changes } : {}),
    ...(String(session.validation || '').trim() ? { validation: String(session.validation).trim() } : {}),
    ...(match ? { confidence: match.confidence, matchStrength: match.strength, matchReasons: match.reasons } : {})
  };
}

function compactPortableTaskEpisode(session: TaskRecord, match: { confidence: number; strength: string; reasons: string[] } | null = null): Record<string, any> {
  const goal = compactText(session.objective || session.title, 260);
  const outcome = compactText(session.resultSummary || session.summary, 520);
  const validation = String(session.validation || '').trim();
  return {
    ...(goal ? { goal } : {}),
    ...(outcome ? { outcome } : {}),
    ...(validation ? { validation } : {}),
    ...(match ? { confidence: match.confidence, matchStrength: match.strength, matchReasons: match.reasons } : {})
  };
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim()).filter(Boolean))];
}

function compactText(value: unknown, limit: number): string {
  const text = String(value || '').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…` : text;
}

function hasExplicitCompletionEvidence(session: TaskRecord = emptySession('')): boolean {
  if (session.completionKnown === true || String(session.endReason || '') === 'explicit_completion') return true;
  return (Array.isArray(session.events) ? session.events : []).some((event: HistoryEvent) => {
    if (event?.completionKnown === true || String(event?.endReason || '') === 'explicit_completion') return true;
    return event?.tool === OP.WORK_FINISH && event?.ok !== false && !['failed', 'cancelled'].includes(String(event?.status || '').toLowerCase());
  });
}

function recoverCompletedSession(session: TaskRecord, options: { endReason?: string; completionSource?: string } = {}): TaskRecord {
  const completedMs = storedSessionActivityMs(session) || timestampMs(session?.updatedAt) || Date.now();
  const completedAt = new Date(completedMs).toISOString();
  return {
    ...session,
    state: 'ended',
    status: 'completed',
    completionKnown: true,
    endReason: String(session.endReason || '') || options.endReason || 'explicit_completion',
    completionSource: String(session.completionSource || '') || options.completionSource || '',
    progress: completeProgress(session.progress?.label || 'Complete'),
    currentStage: 'Completed',
    activeCalls: 0,
    currentOperations: [],
    inactiveAt: null,
    endedAt: session.endedAt || completedAt,
    completedAt: session.completedAt || completedAt,
    updatedAt: session.updatedAt || completedAt
  } as TaskRecord;
}

function isStoredSessionNoise(session: TaskRecord, activeIds: Set<string>, timestamp = Date.now()): boolean {
  if (!session?.id || activeIds.has(session.id) || isTerminalTaskStatus(session.status)) return false;
  if (session.completionKnown === true || Number(session.changedFileCount || 0) > 0 || Number(session.activeCalls || 0) > 0) return false;
  const events = Array.isArray(session.events) ? session.events : [];
  if (events.length !== 1 || String(events[0]?.tool || '') !== OP.WORK_BEGIN) return false;
  const lastActivityMs = storedSessionActivityMs(session);
  return Boolean(lastActivityMs && timestamp - lastActivityMs >= DEFAULT_TASK_STALE_MS);
}

function discardStoredSession(directory: string, id: string): void {
  const key = pendingSessionKey(directory, id);
  pendingSessions.delete(key);
  if (!pendingSessionEntriesForDirectory(directory).length) clearPendingDirectoryFlush(directory);
  removeSession(directory, id);
}

function reconcileInactiveStoredSession(session: TaskRecord, activeIds: Set<string>, timestamp = Date.now()): TaskRecord {
  if (!session?.id || activeIds.has(session.id)) return session;
  if (!isTerminalTaskStatus(session.status) && hasExplicitCompletionEvidence(session)) {
    return recoverCompletedSession(session, { endReason: 'explicit_completion', completionSource: session.completionSource || 'relai_work:finish' });
  }
  if (isTerminalTaskStatus(session.status) || session.status === 'inactive') return session;
  const lastActivityMs = storedSessionActivityMs(session);
  if (!lastActivityMs || timestamp - lastActivityMs < DEFAULT_TASK_IDLE_MS) return session;
  const inactiveMs = lastActivityMs + DEFAULT_TASK_IDLE_MS;
  const inactiveAt = new Date(inactiveMs).toISOString();
  return {
    ...session,
    state: 'inactive',
    status: 'inactive',
    resumeStatus: session.resumeStatus || session.status,
    progress: normalizeTaskProgress(session.progress || { mode: 'indeterminate', label: 'Ready to resume' }, 'inactive'),
    currentStage: 'Inactive',
    completionKnown: false,
    endReason: '',
    terminalReason: '',
    activeCalls: 0,
    currentOperations: [],
    updatedAt: inactiveAt,
    inactiveAt,
    lastActivityAt: lastActivityMs,
    endedAt: null,
    completedAt: null,
    cancelledAt: null
  } as TaskRecord;
}

function storedSessionActivityMs(session: TaskRecord): number {
  const eventTimes = Array.isArray(session?.events)
    ? session.events.flatMap((event: HistoryEvent) => [
        timestampMs(event?.completedAt),
        timestampMs(event?.timestamp),
        timestampMs(event?.ts),
        timestampMs(event?.startedAt)
      ])
    : [];
  return Math.max(
    0,
    timestampMs(session?.lastActivityAt),
    timestampMs(session?.updatedAt),
    timestampMs(session?.endedAt),
    timestampMs(session?.completedAt),
    ...eventTimes
  );
}

function upsertActivityEvent(events: HistoryEvent[], event: HistoryEvent | null): HistoryEvent[] {
  if (!event?.eventId) return [...events].slice(-MAX_SESSION_EVENTS);
  const next = [...events];
  const eventId = eventIdentityKey(event);
  const index = next.findIndex((item: HistoryEvent) => eventIdentityKey(item) === eventId);
  const sanitized = sanitizeActivityEventRecord(event) as HistoryEvent;
  if (index >= 0) next[index] = { ...next[index], ...sanitized };
  else next.push(sanitized);
  return next.sort((left: HistoryEvent, right: HistoryEvent) => Number(left?.sequence || 0) - Number(right?.sequence || 0) || eventTimestampMs(left) - eventTimestampMs(right)).slice(-MAX_SESSION_EVENTS);
}

function historicalTitle(session: TaskRecord): string {
  const operation = String(session?.operation || '').trim();
  if (operation && !/^(task|request|tool call|mcp operation)$/i.test(operation)) return operation;
  const workspace = String(session?.workspace || '').trim();
  return workspace ? `Historical task in ${workspace}` : 'Historical Rel.AI task';
}

function publicSession(session: TaskRecord): TaskRecord {
  if (!session || typeof session !== 'object') return session;
  // Stored and live sessions have already crossed the canonical sanitizer
  // boundary. Reusing their bounded event array avoids rescanning up to 200
  // events for every public projection while retaining the projection's
  // durable-field redaction.
  const { version: _version, principalFingerprint: _principalFingerprint, ...value } = sanitizeTaskRecordForProjection(session, { eventsAlreadySanitized: true }) as TaskRecord;
  const terminal = isTerminalTaskStatus(value.status);
  const publicStatus = value.status;
  return {
    ...value,
    status: publicStatus,
    taskId: value.taskId || value.id,
    sessionId: value.sessionId || value.id,
    title: value.title || historicalTitle(value),
    progress: value.progress || (value.status === 'completed' ? completeProgress() : { mode: 'indeterminate', label: 'Progress unavailable' }),
    toolCallCount: Number(value.toolCallCount ?? value.calls ?? 0),
    successfulToolCallCount: Number(value.successfulToolCallCount ?? Math.max(0, Number(value.calls || 0) - Number(value.failures || 0))),
    failedToolCallCount: Number(value.failedToolCallCount ?? value.failures ?? 0),
    activeCalls: terminal || publicStatus === 'inactive' || publicStatus === 'blocked' ? 0 : Number(value.activeCalls || 0),
    currentOperations: terminal || publicStatus === 'inactive' || publicStatus === 'blocked' ? [] : Array.isArray(value.currentOperations) ? value.currentOperations : [],
    currentStage: value.currentStage || '',
    currentActivity: value.currentActivity || value.operation || ''
  } as TaskRecord;
}

function pendingSessionKey(directory: string, id: string): string {
  return `${directory}\u0000${id}`;
}

function readPendingSession(directory: string, id: string): TaskRecord | null {
  return pendingSessions.get(pendingSessionKey(directory, id))?.session || null;
}

function readWorkingSession(directory: string, id: string): TaskRecord | null {
  return readPendingSession(directory, id) || readSession(directory, id) as TaskRecord | null;
}

function pendingSessionEntriesForDirectory(directory: string): Array<[string, PendingSession]> {
  const prefix = `${directory}\u0000`;
  return [...pendingSessions.entries()].filter(([key]) => key.startsWith(prefix));
}

function pendingSessionsForDirectory(directory: string): TaskRecord[] {
  return pendingSessionEntriesForDirectory(directory)
    .map(([, entry]) => entry.session)
    .filter(Boolean);
}

function persistSession(directory: string, session: TaskRecord, options: PersistenceOptions = {}): void {
  if (!session?.id) return;
  const key = pendingSessionKey(directory, session.id);
  if (options.defer !== true) {
    const pending = pendingSessions.get(key);
    if (pending?.writing) {
      pending.session = session;
      pending.version += 1;
      schedulePendingDirectoryFlush(directory, 0);
      return;
    }
    pendingSessions.delete(key);
    if (!pendingSessionEntriesForDirectory(directory).length) clearPendingDirectoryFlush(directory);
    try {
      writeSession(directory, session);
      recordTaskHistoryPersistenceSuccess();
    } catch (error) {
      recordTaskHistoryPersistenceFailure(error, 1);
      throw error;
    }
    scheduleTaskHistoryPrune(directory);
    return;
  }

  let pending = pendingSessions.get(key);
  if (!pending) {
    pending = { directory, session, writing: false, version: 0, persistedVersion: 0, retryCount: 0, promise: Promise.resolve(true) };
    pendingSessions.set(key, pending);
  }
  pending.session = session;
  pending.version += 1;
  schedulePendingDirectoryFlush(directory);
}

function schedulePendingDirectoryFlush(directory: string, delay = TASK_HISTORY_FLUSH_MS): void {
  if (pendingFlushTimers.has(directory)) return;
  const timer = setTimeout(() => {
    pendingFlushTimers.delete(directory);
    void flushPendingDirectory(directory);
  }, delay);
  timer.unref?.();
  pendingFlushTimers.set(directory, timer);
}

function clearPendingDirectoryFlush(directory: string): void {
  const timer = pendingFlushTimers.get(directory);
  if (!timer) return;
  clearTimeout(timer);
  pendingFlushTimers.delete(directory);
}

async function flushPendingDirectory(directory: string): Promise<boolean> {
  for (const [key, pending] of pendingSessionEntriesForDirectory(directory)) {
    const succeeded = await flushPendingSession(key, pending);
    if (!succeeded) {
      const retryDelay = Math.min(TASK_HISTORY_RETRY_MAX_MS, TASK_HISTORY_RETRY_BASE_MS * (2 ** Math.min(pending.retryCount - 1, 4)));
      schedulePendingDirectoryFlush(directory, retryDelay);
      return false;
    }
  }
  if (pendingSessionEntriesForDirectory(directory).length) schedulePendingDirectoryFlush(directory, 0);
  return true;
}

async function flushPendingSession(key: string, pending: PendingSession): Promise<boolean> {
  if (pending.writing) return pending.promise;
  pending.writing = true;
  const version = pending.version;
  const snapshot = pending.session;
  let succeeded = false;
  let failure: unknown = null;
  pending.promise = writeSessionAsync(pending.directory, snapshot)
    .then(() => {
      succeeded = true;
      return true;
    })
    .catch((error: unknown) => {
      failure = error;
      return false;
    })
    .finally(() => {
      pending.writing = false;
      if (!succeeded) {
        pending.retryCount += 1;
        recordTaskHistoryPersistenceFailure(failure, pending.retryCount);
        if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] deferred task history write:', failure);
        return;
      }
      pending.retryCount = 0;
      pending.persistedVersion = version;
      scheduleTaskHistoryPrune(pending.directory);
      if (pending.version <= version) pendingSessions.delete(key);
      recordTaskHistoryPersistenceSuccess();
    });
  return pending.promise;
}

function scheduleTaskHistoryPrune(directory: string): void {
  if (pendingPrunes.has(directory)) return;
  const timer = setTimeout(() => {
    pendingPrunes.delete(directory);
    try { pruneSessions(directory, MAX_SESSIONS); }
    catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task history prune:', error); }
  }, TASK_HISTORY_PRUNE_DELAY_MS);
  timer.unref?.();
  pendingPrunes.set(directory, timer);
}

async function flushTaskHistoryPersistence(): Promise<{ ok: boolean; failed: number; pending: number }> {
  for (const directory of [...pendingFlushTimers.keys()]) clearPendingDirectoryFlush(directory);
  const failed = new Set<string>();
  const failedDirectories = new Set<string>();
  while (pendingSessions.size > 0) {
    const entries = [...pendingSessions.entries()]
      .filter(([key, pending]) => !failed.has(key) && !failedDirectories.has(pending.directory));
    if (!entries.length) break;
    for (const [key, pending] of entries) {
      if (failedDirectories.has(pending.directory)) continue;
      const succeeded = await flushPendingSession(key, pending);
      if (!succeeded) {
        failed.add(key);
        failedDirectories.add(pending.directory);
      }
    }
  }
  for (const directory of failedDirectories) {
    const retryCount = Math.max(1, ...pendingSessionEntriesForDirectory(directory).map(([, pending]) => Number(pending.retryCount || 0)));
    const retryDelay = Math.min(TASK_HISTORY_RETRY_MAX_MS, TASK_HISTORY_RETRY_BASE_MS * (2 ** Math.min(retryCount - 1, 4)));
    schedulePendingDirectoryFlush(directory, retryDelay);
  }
  for (const [directory, timer] of [...pendingPrunes.entries()]) {
    clearTimeout(timer);
    pendingPrunes.delete(directory);
    try { pruneSessions(directory, MAX_SESSIONS); }
    catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task history prune flush:', error); }
  }
  return { ok: failed.size === 0, failed: failed.size, pending: pendingSessions.size };
}

function taskHistoryPersistenceSnapshot(): PersistenceSnapshot {
  return {
    healthy: !taskHistoryPersistenceState.lastError,
    pending: pendingSessions.size,
    scheduledFlushes: pendingFlushTimers.size,
    retryCount: taskHistoryPersistenceState.retryCount,
    lastFailureAt: taskHistoryPersistenceState.lastFailureAt,
    lastError: taskHistoryPersistenceState.lastError
  };
}

function recordTaskHistoryPersistenceFailure(error: unknown, retryCount: number): void {
  taskHistoryPersistenceState = {
    lastError: sanitizeDisplayText(error instanceof Error ? error.message : String(error || 'Task history persistence failed.'), 500),
    lastFailureAt: new Date().toISOString(),
    retryCount: Math.max(1, Number(retryCount || 1))
  };
}

function recordTaskHistoryPersistenceSuccess(): void {
  if ([...pendingSessions.values()].some(pending => Number(pending.retryCount || 0) > 0)) return;
  taskHistoryPersistenceState = { lastError: '', lastFailureAt: null, retryCount: 0 };
}

async function clearWorkspaceTaskHistory(config: TaskHistoryConfig, workspaceValue: unknown): Promise<{ removed: number; taskIds: string[] }> {
  const workspace = String(workspaceValue || '').trim();
  if (!workspace) return { removed: 0, taskIds: [] };
  const flushed = await flushTaskHistoryPersistence();
  if (!flushed.ok) throw new Error('Task history could not be flushed before project data cleanup.');
  const directory = getTaskHistoryDir(config);
  for (const [key, pending] of [...pendingSessions.entries()]) {
    if (pending.directory === directory && String(pending.session?.workspace || '').trim() === workspace) pendingSessions.delete(key);
  }
  if (!pendingSessionEntriesForDirectory(directory).length) clearPendingDirectoryFlush(directory);
  const taskIds = removeWorkspaceSessions(config, workspace);
  recordTaskHistoryPersistenceSuccess();
  return { removed: taskIds.length, taskIds };
}

function clearTaskHistory(config: TaskHistoryConfig): void {
  const directory = getTaskHistoryDir(config);
  const prefix = `${directory}\u0000`;
  for (const [key] of [...pendingSessions.entries()]) {
    if (!key.startsWith(prefix)) continue;
    pendingSessions.delete(key);
  }
  clearPendingDirectoryFlush(directory);
  const pruneTimer = pendingPrunes.get(directory);
  if (pruneTimer) clearTimeout(pruneTimer);
  pendingPrunes.delete(directory);
  clearStoredTaskHistory(config);
  recordTaskHistoryPersistenceSuccess();
}

function emptySession(id: string): TaskRecord {
  return {
    version: STORE_VERSION,
    id,
    taskId: id,
    sessionId: id,
    title: 'Historical Rel.AI task',
    objective: '',
    status: 'planning',
    progress: { mode: 'indeterminate', label: 'Progress unavailable' },
    currentStage: '',
    currentActivity: '',
    completionKnown: false,
    endReason: '',
    summary: '',
    workspace: '',
    startedAt: null,
    endedAt: null,
    completedAt: null,
    durationMs: 0,
    calls: 0,
    toolCallCount: 0,
    successfulToolCallCount: 0,
    failedToolCallCount: 0,
    activeCalls: 0,
    failures: 0,
    changedFiles: [],
    changedFileCount: 0,
    validation: 'not_run',
    committed: false,
    commitHead: '',
    commitHeads: [],
    pushed: false,
    prDrafted: false,
    lastTool: '',
    operation: '',
    lastOutcome: '',
    currentOperations: [],
    events: []
  } as TaskRecord;
}

export {
  bindTaskHistoryActivityPersistence,
  clearTaskHistory,
  clearWorkspaceTaskHistory,
  findTaskReuseCandidates,
  flushTaskHistoryPersistence,
  getTaskHistoryDir,
  readConversationContinuity,
  readCrossWorkspaceTaskEpisodes,
  readRecentTaskHistoryEvents,
  readRecentWorkflowEvidence,
  readRelevantTaskEpisodes,
  readTaskBackgroundOperation,
  readTaskHistory,
  readTaskHistorySession,
  readTaskHistorySessionRecord,
  recordTaskActivityEvent,
  recordTaskBackgroundOperation,
  recordTaskHistoryEvent,
  recordWorkflowEvidence,
  recordWorkflowEvidenceBatch,
  taskHistoryPersistenceSnapshot
};

export type { TaskActivitySnapshot, TaskRecord };
