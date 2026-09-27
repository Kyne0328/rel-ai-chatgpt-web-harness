

const NOTIFICATION_BODY_LIMIT = 260;
const NOTIFICATION_SUMMARY_LIMIT = 150;
const NOTIFICATION_DEDUPE_LIMIT = 512;

function cleanNotificationText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateNotificationText(value, limit) {
  const text = cleanNotificationText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function buildFailureNotification(event = {}) {
  const operation = truncateNotificationText(event.operation || event.tool || 'Project action', 80);
  const workspace = truncateNotificationText(event.workspace, 64);
  const location = workspace ? ` in ${workspace}` : '';
  const failureLabel = /\b(?:failed|blocked|cancelled)$/i.test(operation) ? operation : `${operation} failed`;
  return {
    title: 'Project action failed',
    body: truncateNotificationText(`${failureLabel}${location}. Open Rel.AI for details and recovery options.`, NOTIFICATION_BODY_LIMIT)
  };
}

function buildCompletionNotification(task = {}) {
  const summary = truncateNotificationText(task.summary, NOTIFICATION_SUMMARY_LIMIT);
  const workspace = truncateNotificationText(task.workspace, 64);
  const validationLevel = truncateNotificationText(task.validationLevel, 24).toLowerCase();
  const parts = [summary || 'The coding task completed successfully.'];
  if (workspace) parts.push(`Project: ${workspace}.`);
  parts.push(validationLevel ? `Final ${validationLevel} checks passed.` : 'Final checks passed.');
  return {
    title: 'Task completed',
    body: truncateNotificationText(parts.join(' '), NOTIFICATION_BODY_LIMIT)
  };
}

function createToolSleepBlocker(powerSaveBlocker) {
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== 'function') {
    throw new TypeError('A valid Electron powerSaveBlocker is required.');
  }

  let blockerId = null;

  function update(activeWorkCount) {
    if (Number(activeWorkCount) > 0) start();
    else stop();
  }

  function start() {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return blockerId;
    blockerId = powerSaveBlocker.start('prevent-app-suspension');
    return blockerId;
  }

  function stop() {
    if (blockerId === null) return false;
    const id = blockerId;
    blockerId = null;
    if (!powerSaveBlocker.isStarted(id)) return false;
    return powerSaveBlocker.stop(id);
  }

  function isActive() {
    return blockerId !== null && powerSaveBlocker.isStarted(blockerId);
  }

  return { update, stop, isActive };
}

function createTaskActivityRuntime(options) {
  const {
    toolActivity,
    powerSaveBlocker,
    notify = () => false,
    onTaskCompleted = () => {},
    onStatusChange = () => {}
  } = options;
  const blocker = createToolSleepBlocker(powerSaveBlocker);
  const notifiedEvents = new Set();
  let status = normalizeActivityStatus(toolActivity.getToolActivity?.() || {});
  let keepAwakeEnabled = false;

  const unsubscribe = toolActivity.onToolActivity(handleActivity);
  syncBlocker(status);
  emitStatus();

  function handleActivity(event = {}) {
    if (event.phase === 'snapshot' && event.snapshot) {
      status = normalizeActivityStatus(event.snapshot);
      syncBlocker(status, event);
      emitStatus();
      return;
    }
    status = reduceActivityStatus(status, event);
    syncBlocker(status, event);
    if (event.phase === 'finished' && event.ok === false && rememberNotificationEvent(failureNotificationKey(event))) {
      notify('errors', buildFailureNotification(event));
    }
    if (event.phase === 'completed' && event.task?.completionKnown === true && rememberNotificationEvent(completionNotificationKey(event))) {
      notify('taskCompleted', buildCompletionNotification(event.task));
      onTaskCompleted(event.task);
    }
    emitStatus();
  }

  function rememberNotificationEvent(key) {
    if (!key) return true;
    if (notifiedEvents.has(key)) return false;
    notifiedEvents.add(key);
    while (notifiedEvents.size > NOTIFICATION_DEDUPE_LIMIT) notifiedEvents.delete(notifiedEvents.values().next().value);
    return true;
  }

  function syncBlocker(activity = status, event = {}) {
    const connectorCalls = Number(Object.hasOwn(event, 'activeConnectorCalls')
      ? event.activeConnectorCalls
      : activity.activeConnectorCalls || 0);
    const activeTaskCount = Math.max(
      Math.max(0, Number(Object.hasOwn(event, 'activeTaskCount') ? event.activeTaskCount : activity.activeTaskCount || 0)),
      Array.isArray(activity.tasks) ? activity.tasks.length : 0
    );
    blocker.update(keepAwakeEnabled || activeTaskCount > 0 || Math.max(0, connectorCalls) > 0 ? 1 : 0);
  }

  function setKeepAwakeEnabled(enabled) {
    keepAwakeEnabled = enabled === true;
    syncBlocker(status);
    return keepAwakeEnabled;
  }

  function currentStatus() {
    return {
      ...status,
      tasks: status.tasks.map(task => ({ ...task })),
      lastTask: status.lastTask ? { ...status.lastTask } : null
    };
  }

  function emitStatus() {
    onStatusChange(currentStatus());
  }

  function resetHistory() {
    if (Number(status.activeCalls || 0) > 0) {
      return { ok: false, error: 'Cannot clear session history while a Rel.AI tool call is running.' };
    }
    toolActivity.resetToolActivity?.();
    status = normalizeActivityStatus(toolActivity.getToolActivity?.() || {});
    syncBlocker(status);
    emitStatus();
    return { ok: true };
  }

  function stop() {
    unsubscribe();
    blocker.stop();
  }

  return {
    getStatus: currentStatus,
    resetHistory,
    setKeepAwakeEnabled,
    stop
  };
}

function normalizeActivityStatus(activity = {}) {
  const tasks = (Array.isArray(activity.tasks) ? activity.tasks : []).map(lightweightTask);
  const primary = tasks.find(task => Number(task.activeCalls || 0) > 0) || tasks[0] || null;
  return {
    state: activity.state || (Number(activity.activeCalls || 0) > 0 ? 'working' : tasks.length ? 'waiting' : 'idle'),
    activeConnectorCalls: Math.max(0, Number(activity.activeConnectorCalls || 0)),
    activeCalls: Math.max(0, Number(activity.activeCalls || 0)),
    activeTaskCount: Math.max(0, Number(activity.activeTaskCount ?? tasks.length)),
    completionKnown: activity.completionKnown === true,
    tasks,
    taskId: activity.taskId || taskId(primary) || taskId(activity.lastTask),
    calls: Number(activity.calls ?? primary?.calls ?? 0),
    failures: Number(activity.failures ?? primary?.failures ?? 0),
    workspace: activity.workspace || (tasks.length === 1 ? primary?.workspace || '' : ''),
    tool: activity.tool || primary?.lastTool || primary?.tool || '',
    operation: activity.operation || primary?.operation || primary?.lastOperation || '',
    startedAt: activity.startedAt || primary?.startedAt || null,
    lastTask: activity.lastTask ? lightweightTask(activity.lastTask) : null
  };
}

function reduceActivityStatus(current, event) {
  const tasks = new Map(current.tasks.map(task => [taskId(task), task]).filter(([id]) => id));
  const changedTask = event.task ? lightweightTask(event.task) : null;
  const id = taskId(changedTask) || String(event.taskId || '').trim();
  if (changedTask && id) {
    if (isTerminalTask(changedTask, event.phase)) tasks.delete(id);
    else tasks.set(id, { ...(tasks.get(id) || {}), ...changedTask });
  }
  const activeConnectorCalls = Math.max(0, Number(event.activeConnectorCalls ?? current.activeConnectorCalls ?? 0));
  const activeCalls = Math.max(0, Number(event.activeCalls ?? current.activeCalls ?? 0));
  const taskList = [...tasks.values()].sort((left, right) => Number(left.startedAt || 0) - Number(right.startedAt || 0));
  const activeTaskCount = taskList.length;
  const primary = taskList.find(task => Number(task.activeCalls || 0) > 0) || taskList[0] || null;
  const lastTask = changedTask && isTerminalTask(changedTask, event.phase) ? changedTask : current.lastTask;
  return {
    state: activeCalls > 0 ? 'working' : activeTaskCount > 0 ? 'waiting' : 'idle',
    activeConnectorCalls,
    activeCalls,
    activeTaskCount,
    completionKnown: false,
    tasks: taskList,
    taskId: taskId(primary) || taskId(lastTask),
    calls: Number(primary?.calls || 0),
    failures: Number(primary?.failures || 0),
    workspace: taskList.length === 1 ? primary?.workspace || '' : '',
    tool: primary?.lastTool || primary?.tool || '',
    operation: primary?.operation || primary?.lastOperation || '',
    startedAt: primary?.startedAt || null,
    lastTask
  };
}

function lightweightTask(task = {}) {
  if (!task || typeof task !== 'object') return {};
  const { events: _events, currentOperations: _currentOperations, principalFingerprint: _principalFingerprint, ...summary } = task;
  return { ...summary };
}

function taskId(task) {
  return String(task?.taskId || task?.id || task?.sessionId || '').trim();
}

function failureNotificationKey(event = {}) {
  const eventId = String(event.activityEvent?.eventId || event.activityEvent?.operationId || event.operationId || '').trim();
  return eventId ? `failure:${eventId}` : '';
}

function completionNotificationKey(event = {}) {
  const id = taskId(event.task) || String(event.taskId || '').trim();
  return id ? `completion:${id}` : '';
}

function isTerminalTask(task, phase = '') {
  return ['completed', 'cancelled', 'failed', 'inactive'].includes(String(task?.status || phase || '').toLowerCase());
}

function taskActivityBlockReason(activity = {}, action = 'restarting Rel.AI') {
  const tasks = Array.isArray(activity.tasks) ? activity.tasks.filter(task => !isTerminalTask(task)) : [];
  const declaredTaskCount = Math.max(0, Number(activity.activeTaskCount || 0));
  const activeCalls = Math.max(0, Number(activity.activeCalls || 0));
  const activeState = ['working', 'waiting', 'settling'].includes(String(activity.state || '').toLowerCase());
  const activeTaskCount = Math.max(declaredTaskCount, tasks.length, activeCalls > 0 || activeState ? 1 : 0);
  if (!activeTaskCount) return '';
  const subject = activeTaskCount === 1 ? 'the active Rel.AI task' : `${activeTaskCount} active Rel.AI tasks`;
  return `Finish or cancel ${subject} before ${action}.`;
}

export { buildCompletionNotification, buildFailureNotification, cleanNotificationText, createToolSleepBlocker, createTaskActivityRuntime, taskActivityBlockReason, truncateNotificationText };
