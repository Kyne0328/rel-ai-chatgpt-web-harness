// Canonical dashboard client state. Aggregate refreshes replace the whole state;
// typed domain deltas update only their owned projection and are ordered by revision.
import { createStore } from 'zustand/vanilla';
import { DASHBOARD_LIVE_EVENTS, createEmptyDashboardRevisions } from './generated/events-contract.js';

const dashboardStore = createStore(() => ({}));
let _state = dashboardStore.getState();
let _streamId = '';
let _revisions = emptyRevisions();

export function getSnapshot() { return dashboardStore.getState(); }

export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  return dashboardStore.subscribe(listener);
}

export function init(initial) {
  const next = initial || {};
  const incomingLive = next.live || null;
  if (incomingLive) {
    _streamId = String(incomingLive.streamId || '');
    _revisions = { ...emptyRevisions(), ...(incomingLive.revisions || {}) };
  }
  _state = { ...next };
  commit();
  return _state;
}

export function patchLocalConnection(patch = {}) {
  const hasDesktopStatus = Object.hasOwn(patch, 'desktopStatus');
  const hasConnectionState = Object.hasOwn(patch, 'connectionState');
  const changed = (hasDesktopStatus && _state.desktopStatus !== patch.desktopStatus)
    || (hasConnectionState && _state.connectionState !== patch.connectionState);
  if (!changed) return _state;
  _state = { ..._state };
  if (hasDesktopStatus) _state.desktopStatus = patch.desktopStatus;
  if (hasConnectionState) _state.connectionState = patch.connectionState;
  commit();
  return _state;
}

export function patchComputerControl(settings = {}) {
  _state = {
    ..._state,
    config: { ...(_state.config || {}), computerControl: { ...(_state.config?.computerControl || {}), ...settings } }
  };
  commit();
  return _state;
}

export function applyLiveEvent(type, payload = {}) {
  const domain = domainForEvent(type);
  if (!domain) return { accepted: false, state: _state, domain: '' };
  const streamId = String(payload.streamId || '');
  if (_streamId && streamId && streamId !== _streamId) return { accepted: false, state: _state, domain };

  const revision = Math.max(0, Number(payload.revision || 0));
  if (revision <= Number(_revisions[domain] || 0)) return { accepted: false, state: _state, domain };

  if (!_streamId && streamId) _streamId = streamId;
  _revisions = { ..._revisions, [domain]: revision };
  _state = { ..._state };

  if (type === 'task.updated') applyTaskDelta(payload);
  else if (type === 'connection.updated') applyConnectionDelta(payload);
  else if (type === 'workspace.updated') applyWorkspaceDelta(payload);
  else if (type === 'process.updated') _state.managedProcesses = Array.isArray(payload.managedProcesses) ? payload.managedProcesses : [];

  commit();
  return { accepted: true, state: _state, domain };
}

function applyTaskDelta(payload) {
  if (payload.taskActivity) _state.taskActivity = { ...(_state.taskActivity || {}), ...payload.taskActivity };
  if (Array.isArray(payload.tasks)) _state.tasks = payload.tasks;
  if (Array.isArray(payload.taskUpdates)) {
    mergeTaskUpdates(payload.taskUpdates);
    mergeActiveTaskUpdates(payload.taskUpdates);
  }
  if (payload.auditTail) _state.auditTail = payload.auditTail;
  if (Array.isArray(payload.activityEntries)) mergeActivityEntries(payload.activityEntries);
  if (payload.workspaceStates) {
    _state.workspaceStates = payload.workspaceStates;
    syncWorkspaceOperationalStates(payload.workspaceStates);
  } else if (payload.taskActivity || Array.isArray(payload.taskUpdates)) {
    syncTaskWorkspaceStates(_state.taskActivity || {}, payload.taskUpdates || []);
  }
}

function mergeTaskUpdates(updates) {
  const byId = new Map();
  for (const task of Array.isArray(_state.tasks) ? _state.tasks : []) {
    const id = taskIdentity(task);
    if (id) byId.set(id, task);
  }
  for (const task of updates) {
    const id = taskIdentity(task);
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...task });
  }
  _state.tasks = [...byId.values()].sort((left, right) => taskTime(right) - taskTime(left)).slice(0, 500);
}

function mergeActiveTaskUpdates(updates) {
  const activity = { ...(_state.taskActivity || {}) };
  const byId = new Map();
  for (const task of Array.isArray(activity.tasks) ? activity.tasks : []) {
    const id = taskIdentity(task);
    if (id) byId.set(id, task);
  }
  for (const task of updates) {
    const id = taskIdentity(task);
    if (!id) continue;
    if (shouldRemoveFromActiveTasks(task)) {
      byId.delete(id);
      activity.lastTask = task;
    } else {
      byId.set(id, { ...(byId.get(id) || {}), ...task });
    }
  }
  if (Number(activity.activeTaskCount || 0) === 0) byId.clear();
  activity.tasks = [...byId.values()].sort((left, right) => taskTime(left) - taskTime(right));
  activity.activeTaskCount = activity.tasks.length;
  activity.state = Number(activity.activeCalls || 0) > 0 ? 'working' : activity.tasks.length ? 'waiting' : 'idle';
  const primary = activity.tasks.find(task => Number(task.activeCalls || 0) > 0) || activity.tasks[0] || null;
  activity.taskId = taskIdentity(primary) || taskIdentity(activity.lastTask);
  activity.workspace = activity.tasks.length === 1 ? String(primary?.workspace || '') : '';
  activity.tool = String(primary?.lastTool || primary?.tool || '');
  activity.operation = String(primary?.operation || primary?.lastOperation || '');
  activity.startedAt = primary?.startedAt || null;
  _state.taskActivity = activity;
}

function shouldRemoveFromActiveTasks(task) {
  return ['completed', 'cancelled', 'failed', 'inactive'].includes(String(task?.status || '').toLowerCase());
}

function mergeActivityEntries(updates) {
  const current = Array.isArray(_state.auditTail?.entries) ? _state.auditTail.entries : [];
  const byId = new Map();
  for (const entry of [...current, ...updates]) {
    const id = String(entry?.eventId || entry?.id || entry?.operationId || '');
    if (!id) continue;
    const existing = byId.get(id) || {};
    const merged = { ...existing, ...entry };
    for (const key of ['summary', 'message', 'currentActivity', 'title', 'operation', 'path']) {
      if (!displayText(entry?.[key]) && displayText(existing?.[key])) merged[key] = existing[key];
    }
    byId.set(id, merged);
  }
  const limit = Math.max(1, Math.min(200, Number(_state.auditTail?.entries?.length || 200)));
  _state.auditTail = {
    ...(_state.auditTail || {}),
    entries: [...byId.values()].sort((left, right) => activityTime(left) - activityTime(right)).slice(-limit)
  };
}

function syncTaskWorkspaceStates(activity, updates) {
  const states = { ...(_state.workspaceStates || {}) };
  for (const workspace of Array.isArray(_state.config?.workspaces) ? _state.config.workspaces : []) {
    const alias = String(workspace?.alias || '');
    if (alias && !states[alias]) states[alias] = { ...(workspace.operational || {}) };
  }
  const activeTasks = Array.isArray(activity?.tasks) ? activity.tasks : [];
  const activeByWorkspace = new Map(activeTasks.map(task => [String(task.workspace || ''), task]).filter(([alias]) => alias));
  for (const [alias, state] of Object.entries(states)) {
    const task = activeByWorkspace.get(alias);
    if (!task && !state?.currentActivity) continue;
    states[alias] = {
      ...state,
      currentActivity: task ? {
        state: task.state,
        tool: task.lastTool || task.tool,
        startedAt: task.startedAt,
        activeCalls: Number(task.activeCalls || 0),
        taskId: taskIdentity(task)
      } : null
    };
  }
  for (const task of updates) {
    const alias = String(task?.workspace || '');
    if (!alias || !states[alias]) continue;
    const state = states[alias];
    const lastTask = !state.lastTask || taskTime(task) >= taskTime(state.lastTask) ? task : state.lastTask;
    const validation = String(task?.validation || task?.validationStatus || '');
    states[alias] = {
      ...state,
      lastTask,
      ...(validation && validation !== 'not_run' ? { lastValidation: { status: validation, completedAt: task.completedAt || task.updatedAt || null } } : {})
    };
  }
  _state.workspaceStates = states;
  syncWorkspaceOperationalStates(states);
}

function taskIdentity(task) {
  return String(task?.id || task?.taskId || task?.sessionId || '');
}

function taskTime(task) {
  return timestamp(task?.updatedAt || task?.completedAt || task?.endedAt || task?.startedAt);
}

function activityTime(entry) {
  return timestamp(entry?.ts || entry?.timestamp || entry?.completedAt || entry?.startedAt);
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function applyConnectionDelta(payload) {
  for (const key of ['connection', 'connectionState', 'mcpConnection', 'mcpAuthentication', 'desktopStatus']) {
    if (payload[key] !== undefined) _state[key] = payload[key];
  }
}

function applyWorkspaceDelta(payload) {
  const alias = String(payload.alias || '');
  if (!alias || !payload.state) return;
  const current = _state.workspaceStates?.[alias] || {};
  const merged = { ...current, ...payload.state };
  _state.workspaceStates = { ...(_state.workspaceStates || {}), [alias]: merged };
  syncWorkspaceOperationalStates({ [alias]: merged });
}

function syncWorkspaceOperationalStates(states) {
  if (!Array.isArray(_state.config?.workspaces)) return;
  _state.config = {
    ..._state.config,
    workspaces: _state.config.workspaces.map(workspace => (
      states[workspace.alias]
        ? { ...workspace, operational: states[workspace.alias] }
        : workspace
    ))
  };
}

function commit() {
  syncLiveMetadata();
  dashboardStore.setState(_state, true);
}

function syncLiveMetadata() {
  _state.live = {
    ...(_state.live || {}),
    streamId: _streamId,
    revisions: { ..._revisions }
  };
}

function domainForEvent(type) {
  if (type === DASHBOARD_LIVE_EVENTS.TASK_UPDATED) return 'task';
  if (type === DASHBOARD_LIVE_EVENTS.CONNECTION_UPDATED) return 'connection';
  if (type === DASHBOARD_LIVE_EVENTS.WORKSPACE_UPDATED) return 'workspace';
  if (type === DASHBOARD_LIVE_EVENTS.PROCESS_UPDATED) return 'process';
  if (type === DASHBOARD_LIVE_EVENTS.DIAGNOSTICS_UPDATED) return 'diagnostics';
  return '';
}

function emptyRevisions() {
  return { ...createEmptyDashboardRevisions(), config: 0, analytics: 0 };
}
