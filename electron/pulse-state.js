import { importResourceModule } from './resource-path.js';

const { classifyTaskActivity } = await importResourceModule('src/taskActivityPresentation.js');

function projectPulseStatus(status = {}) {
  const activity = status?.taskActivity && typeof status.taskActivity === 'object' ? status.taskActivity : {};
  const presentation = classifyTaskActivity(activity);
  const {
    activeCalls,
    attentionTask,
    primaryTask: primary,
    taskCount,
    tasks
  } = presentation;
  const route = taskRoute(primary);

  if (presentation.category === 'attention') return attentionModel(attentionTask, taskCount, route, tasks);
  if (presentation.category === 'working') {
    return {
      visible: true,
      tone: 'working',
      badge: activeCalls === 1 ? '1 running' : `${Math.max(1, activeCalls)} running`,
      title: cleanText(primary?.currentStage || primary?.currentActivity || activity.operation || operationLabel(activity.tool || primary?.lastTool), 96),
      detail: taskDetail(primary, taskCount, 'Rel.AI is using this computer now.'),
      activityLine: cleanText(activityLineFor(primary, activity), 140),
      startedAt: startedAtFor(primary, activity),
      workspacesLabel: workspacesLabel(tasks),
      route,
      taskCount,
      ...taskPresentation(primary, taskCount, tasks),
      actionRequired: false
    };
  }
  if (presentation.category === 'waiting') {
    return {
      visible: true,
      tone: 'waiting',
      badge: taskCount === 1 ? '1 open' : `${Math.max(1, taskCount)} open`,
      title: taskCount > 1 ? `${taskCount} tasks are open` : cleanText(primary?.title || 'Waiting for the next local action', 96),
      detail: taskDetail(primary, taskCount, 'ChatGPT may still be working. Rel.AI is ready for the next local action.'),
      activityLine: cleanText(activityLineFor(primary, activity), 140),
      startedAt: startedAtFor(primary, activity),
      workspacesLabel: workspacesLabel(tasks),
      route,
      taskCount,
      ...taskPresentation(primary, taskCount, tasks),
      actionRequired: false
    };
  }

  if (status.error || status.errorCode || normalizeStatus(status.tunnelStatus) === 'failed') {
    return {
      visible: true,
      tone: 'attention',
      badge: 'Needs attention',
      title: 'Rel.AI needs attention',
      detail: 'Open Rel.AI for connection details and recovery options.',
      route: '#diagnostics',
      taskCount: 0,
      actionRequired: false
    };
  }
  return {
    visible: true,
    tone: 'idle',
    badge: 'Idle',
    title: 'Rel.AI is idle',
    detail: 'No local task is active.',
    route: '#home',
    taskCount: 0,
    actionRequired: false
  };
}

function attentionModel(task, taskCount, route, tasks) {
  const status = normalizeStatus(task.status);
  const title = status === 'waiting_for_approval'
    ? 'Approval required'
    : status === 'validation_failed'
      ? 'Checks need attention'
      : 'Resolve the blocker to continue';
  const fallback = status === 'waiting_for_approval'
    ? 'The task is paused until the required approval is handled in the AI host.'
    : status === 'validation_failed'
      ? 'Review the failed checks, fix the issue, then validate again.'
      : 'Open the task to see what is blocking progress.';
  return {
    visible: true,
    tone: 'attention',
    badge: 'Action required',
    title,
    detail: taskDetail(task, taskCount, cleanText(task.currentActivity || task.errorSummary || fallback, 140)),
    activityLine: cleanText(activityLineFor(task, {}), 140),
    startedAt: startedAtFor(task, {}),
    workspacesLabel: workspacesLabel(tasks),
    route,
    taskCount,
    ...taskPresentation(task, taskCount, tasks),
    actionRequired: true
  };
}

function taskPresentation(task, taskCount, tasks = []) {
  const normalized = (Array.isArray(tasks) ? tasks : []).filter(candidate => candidate && typeof candidate === 'object');
  const taskNames = normalized
    .map(candidate => cleanText(candidate?.title || candidate?.objective, 72))
    .filter(Boolean)
    .slice(0, 3);
  const taskItems = normalized.slice(0, 4).map(candidate => {
    const status = normalizeStatus(candidate?.status);
    const percent = Number(candidate?.progress?.percent);
    return {
      id: cleanText(candidate?.taskId || candidate?.id || candidate?.sessionId, 160),
      title: cleanText(candidate?.title || candidate?.objective || operationLabel(candidate?.lastTool || candidate?.tool), 72),
      workspace: cleanText(candidate?.workspace, 40),
      status,
      statusLabel: taskStatusLabel(candidate),
      active: Math.max(0, Number(candidate?.activeCalls || 0)) > 0,
      ...(Number.isFinite(percent) ? { progressPercent: Math.min(100, Math.max(0, percent)) } : {})
    };
  });
  if (!task || typeof task !== 'object') return { otherTaskCount: Math.max(0, taskCount - 1), taskNames, taskItems };
  const progressPercent = Number(task.progress?.percent);
  const presentation = {
    contextTitle: cleanText(task.title || task.objective, 96),
    workspace: cleanText(task.workspace, 80),
    progressLabel: cleanText(task.progress?.label, 80),
    otherTaskCount: Math.max(0, taskCount - 1),
    taskNames,
    taskItems
  };
  if (Number.isFinite(progressPercent)) presentation.progressPercent = Math.min(100, Math.max(0, progressPercent));
  return presentation;
}

function taskDetail(task, taskCount, fallback) {
  const workspace = cleanText(task?.workspace, 60);
  const title = cleanText(task?.title || task?.objective, 80);
  if (taskCount > 1) {
    const scope = workspace ? ` across ${taskCount} tasks · ${workspace}` : ` across ${taskCount} tasks`;
    return cleanText(`${fallback}${scope}`, 180);
  }
  const context = [title, workspace].filter(Boolean).join(' · ');
  return cleanText(context ? `${fallback} ${context}` : fallback, 180);
}

function taskRoute(task) {
  const taskId = cleanText(task?.taskId || task?.id || task?.sessionId, 160);
  const workspace = cleanText(task?.workspace, 80);
  if (!taskId && !workspace) return '#tasks';
  const params = new URLSearchParams();
  if (workspace) params.set('workspace', workspace);
  if (taskId) params.set('task', taskId);
  return `#tasks?${params.toString()}`;
}

function operationLabel(tool) {
  const value = String(tool || '').toLowerCase();
  if (/validate|check/.test(value)) return 'Checking changes';
  if (/edit|write|replace/.test(value)) return 'Applying changes';
  if (/publish|commit|push/.test(value)) return 'Publishing changes';
  if (/browser/.test(value)) return 'Using the local browser';
  if (/computer|desktop/.test(value)) return 'Using this computer';
  if (/exec|process|command|terminal/.test(value)) return 'Running a local command';
  if (/relai_changes/.test(value)) return 'Reviewing changes';
  return 'Working locally';
}

function activityLineFor(task, activity = {}) {
  const stage = cleanText(task?.currentStage, 96);
  const operation = cleanText(task?.currentActivity || task?.operation || task?.lastOperation || activity?.operation, 96);
  const tool = cleanText(task?.lastTool || task?.tool || activity?.tool, 48);
  if (stage && operation && stage !== operation) return `${stage} · ${operation}`;
  if (stage) return stage;
  if (operation) return operation;
  if (tool) return operationLabel(tool);
  return '';
}

function startedAtFor(task, activity = {}) {
  const candidates = [task?.startedAt, task?.lastActivityAt, task?.updatedAt, activity?.startedAt];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
    const parsed = Date.parse(String(candidate));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function workspacesLabel(tasks = []) {
  const names = [...new Set((Array.isArray(tasks) ? tasks : []).map(task => cleanText(task?.workspace, 40)).filter(Boolean))];
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names[0]} +${names.length - 1}`;
}

function taskStatusLabel(task = {}) {
  const status = normalizeStatus(task?.status);
  if (Math.max(0, Number(task?.activeCalls || 0)) > 0) return 'Running';
  if (status === 'waiting_for_approval') return 'Approval';
  if (status === 'blocked') return 'Blocked';
  if (status === 'validation_failed') return 'Checks';
  if (status === 'running') return 'Running';
  if (status === 'planning') return 'Planning';
  if (status === 'settling' || status === 'waiting') return 'Waiting';
  if (status) return status.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase()).slice(0, 18);
  return 'Queued';
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase().replaceAll('-', '_');
}

function cleanText(value, limit = 180) {
  const text = String(value || '').replace(/[\r\n\t\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export { projectPulseStatus, taskRoute };
