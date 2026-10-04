import { isTerminalDashboardTaskStatus, normalizeHistoricalTaskStatus } from './taskState.js';

const ATTENTION_STATUSES = Object.freeze(new Set(['waiting_for_approval', 'blocked', 'validation_failed']));
const LIVE_ACTIVITY_STATES = Object.freeze(new Set(['working', 'waiting', 'settling']));

function classifyTaskActivity(activity = {}) {
  const source = activity && typeof activity === 'object' ? activity : {};
  const activityState = normalizeToken(source.state);
  const activeCalls = Math.max(0, Number(source.activeCalls || 0));
  const declaredTaskCount = Math.max(0, Number(source.activeTaskCount || 0));
  const candidates = (Array.isArray(source.tasks) ? source.tasks : [])
    .filter(task => task && typeof task === 'object' && isLiveTask(task));
  const hasLiveSignal = activeCalls > 0
    || declaredTaskCount > 0
    || LIVE_ACTIVITY_STATES.has(activityState)
    || candidates.some(task => Math.max(0, Number(task.activeCalls || 0)) > 0);
  const tasks = hasLiveSignal ? candidates : [];
  const attentionTask = tasks.find(taskNeedsAction) || null;
  const primaryTask = attentionTask
    || tasks.find(task => Math.max(0, Number(task.activeCalls || 0)) > 0)
    || tasks[0]
    || null;
  const taskCount = hasLiveSignal ? Math.max(tasks.length, declaredTaskCount, activeCalls > 0 ? 1 : 0) : 0;
  const reason = attentionTask ? taskStatus(attentionTask) : '';
  const category = attentionTask
    ? 'attention'
    : activeCalls > 0 || activityState === 'working'
      ? 'working'
      : taskCount > 0 || activityState === 'waiting' || activityState === 'settling'
        ? 'waiting'
        : 'idle';

  return {
    category,
    activityState,
    activeCalls,
    taskCount,
    tasks,
    primaryTask,
    attentionTask,
    actionRequired: category === 'attention',
    reason
  };
}

function taskNeedsAction(task = {}) {
  return ATTENTION_STATUSES.has(taskStatus(task));
}

function taskStatus(task = {}) {
  return normalizeHistoricalTaskStatus(task?.status, task);
}

function isLiveTask(task = {}) {
  const status = taskStatus(task);
  return status !== 'inactive' && !isTerminalDashboardTaskStatus(status, task);
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export { classifyTaskActivity };
