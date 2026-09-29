import React, { useEffect, useMemo, useState } from 'react';
import { copyText } from '../../clipboard.js';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { taskProgressView } from '../../components/task-progress.js';
import { toast } from '../../components/toast.js';
import { routeMetadata } from '../../navigation-catalog.js';
import { getWorkspaceFilter, routeHref } from '../../router.js';
import { workSessionStateView } from '../../task-identity.js';
import { classifyTaskActivity } from '../../../taskActivityPresentation.js';
import { formatDuration, timeAgo } from '../../utils.js';
import { buildTaskSemanticProgress } from '../../../taskSemanticProgress.js';
import { completeDesktopSetup, desktopSetupSteps, dismissDesktopSetup, isDesktopSetupDismissed } from '../onboarding/index.js';
import { CHATGPT_CONNECTOR_CREATE_URL, chatGptFirstPrompt, chatGptGuideSteps } from '../settings/connection-guidance.js';
import { desktopSetupState, overviewState, overviewWorkspaceStatus } from './index.js';

const h = React.createElement;
const HOME_STORE_KEYS = Object.freeze(['config', 'health', 'connection', 'connectionState', 'desktopStatus', 'mcpConnection', 'tasks', 'taskActivity', 'live']);
const HOME_TASK_SUMMARY_MAX = 180;

export function createHomeRoute(useDashboardSlices) {
  return function HomeRoute() {
    return h(HomeView, { data: useDashboardSlices(HOME_STORE_KEYS) });
  };
}

function HomeView({ data = {} }) {
  const workspace = getWorkspaceFilter();
  const state = useMemo(() => overviewState(data, workspace), [data, workspace]);
  const setup = useMemo(() => desktopSetupState(data), [data]);
  const activeCard = taskActivityModel(data.taskActivity, state.tasks[0]);
  return h('div', { className: 'section', 'data-home-react': '' },
    activeCard ? h(TaskActivityCard, { model: activeCard }) : null,
    h(DesktopSetupChecklist, { setup }),
    h(ConnectionHero, { state: state.bridgeState }),
    h('div', { className: 'layout-grid' },
      h(WorkspaceSummaryCard, { workspaces: state.workspaces, findings: state.findings }),
      h(RecentTasksCard, { tasks: state.tasks })
    )
  );
}

function ConnectionHero({ state }) {
  return h('section', { className: `overview-hero overview-hero-compact ${state.tone}`, 'data-home-live-connection': '' },
    h('div', { className: 'overview-copy' },
      state.kicker ? h('div', { className: 'overview-kicker' }, state.kicker) : null,
      h('h2', { className: 'overview-title' }, state.title),
      state.description ? h('p', { className: 'overview-description' }, state.description) : null
    ),
    h('a', { className: 'buttonlike secondary compact-button', href: routeMetadata('settings/connection').href }, 'View connection')
  );
}

function TaskActivityCard({ model }) {
  const task = model.task;
  if (model.active) {
    const startedAt = task.startedAtIso || task.createdAt || task.startedAt || '';
    const startedAtMs = Date.parse(startedAt) || Number(task.startedAt || Date.now());
    const stateClass = model.attention ? 'attention' : model.waiting ? 'waiting' : 'active';
    return h('section', { className: `card task-overview ${stateClass}`, 'data-home-live-activity': '' },
      h('div', { className: 'task-overview-mark', 'aria-hidden': 'true' }, model.attention ? h(Icon, { name: 'warning', size: 18 }) : model.waiting ? h(Icon, { name: 'timer', size: 18 }) : h('span', { className: 'task-overview-spinner' })),
      h('div', { className: 'task-overview-copy' },
        h('div', { className: 'overview-kicker' }, 'Current task'),
        h('h3', null, model.title),
        h('p', null, model.description),
        h(TaskProgress, { progress: task.progress, status: task.status, compact: true })
      ),
      h('div', { className: 'task-overview-meta' },
        h('span', null, model.activityLabel),
        h('strong', { 'data-clock-elapsed-start': startedAt }, formatDuration(Date.now() - startedAtMs, { live: true }))
      )
    );
  }
  return h('section', { className: `card task-overview ${model.tone}`, 'data-home-live-activity': '' },
    h('div', { className: 'task-overview-mark', 'aria-hidden': 'true' }, h(Icon, { name: model.icon, size: 18 })),
    h('div', { className: 'task-overview-copy' },
      h('div', { className: 'overview-kicker' }, 'Previous task'),
      h('h3', null, task.title || model.title),
      h('p', { className: 'task-overview-summary' }, model.description),
      h(TaskProgress, { progress: task.progress, status: task.status, compact: true })
    ),
    h('div', { className: 'task-overview-meta' },
      h('span', { 'data-clock-relative': task.endedAt || task.completedAt || '' }, timeAgo(task.endedAt || task.completedAt)),
      h('strong', null, formatDuration(task.durationMs)),
      model.detailsHref ? h('a', { className: 'task-overview-link', href: model.detailsHref }, 'View task') : null
    )
  );
}

function taskActivityModel(activity = {}, persistedTask = null) {
  const presentation = classifyTaskActivity(activity);
  const activeTasks = presentation.tasks;
  const active = presentation.category !== 'idle';
  const completedWithWarnings = persistedTask?.status === 'completed' && Number(persistedTask?.failedToolCallCount ?? persistedTask?.failures ?? 0) > 0;
  if (!active && !['failed', 'blocked', 'validation_failed'].includes(persistedTask?.status) && !completedWithWarnings) return null;
  const task = active ? presentation.primaryTask || primaryActiveTask(activeTasks) : persistedTask || activity.lastTask;
  if (!task) return null;
  if (active) {
    const activeCalls = presentation.activeCalls;
    const attention = presentation.category === 'attention';
    const waiting = presentation.category === 'waiting';
    const semantic = semanticProgressFor(task);
    const operation = semantic.currentActivity || task.currentActivity || task.operation || taskAction(task.lastTool || task.tool);
    const stage = String(semantic.currentStage || 'Task progress').trim();
    const activityText = String(semantic.currentActivity || '').trim();
    const location = task.workspace || activeTaskLocation(activeTasks);
    let title = task.title || operation || 'Current task';
    let description = activityText && activityText !== stage ? `${stage} · ${activityText}` : stage || activityText || 'Task is open';
    description = location ? `${description} in ${location}.` : `${description}.`;
    if (!task.title && !attention && !waiting && activeTasks.length > 1) title = `${activeCalls} Rel.AI actions are running.`;
    if (!attention && !waiting && activeTasks.length > 1) description = `${activeCalls} ${pluralLabel(activeCalls, 'active action')} across ${activeTaskLocation(activeTasks)}.`;
    return {
      active: true,
      attention,
      waiting,
      task,
      title,
      description,
      stage,
      activity: activityText,
      location,
      activityLabel: attention
        ? `Action required · ${statusLabel(task.status)}`
        : waiting
          ? `${statusLabel(task.status)} · latest progress`
          : `${activeCalls} ${pluralLabel(activeCalls, 'active call')}`
    };
  }
  const attention = ['failed', 'blocked', 'validation_failed'].includes(task.status);
  const completed = task.status === 'completed' && task.completionKnown === true;
  const failed = Number(task.failures || 0);
  const callCount = Number(task.calls || 0);
  let icon = 'pause';
  let title = 'Last task is inactive';
  if (attention) {
    icon = 'warning';
    title = task.status === 'blocked' ? 'Last task was blocked' : task.status === 'validation_failed' ? 'Last task needs attention' : 'Last task failed';
  } else if (completed) {
    icon = 'success';
    title = 'Task completed';
  }
  const failureText = failed ? completed ? ` · ${failed} warning${failed === 1 ? '' : 's'}` : ` · ${failed} failed` : '';
  const completionSummary = completed ? compactTaskSummary(task.summary) || 'Final checks passed.' : 'ChatGPT did not report a final result.';
  const taskId = String(task.id || task.taskId || task.work_id || '').trim();
  const detailsHref = taskId ? routeHref('tasks', { workspace: task.workspace || '', task: taskId }) : '';
  return {
    active: false,
    task,
    icon,
    title,
    tone: attention ? 'attention' : completed ? 'completed' : 'waiting',
    detailsHref,
    description: `${task.workspace || 'No project'} · ${callCount} ${pluralLabel(callCount, 'action')}${failureText} · ${completionSummary}`
  };
}

function WorkspaceSummaryCard({ workspaces, findings }) {
  return h('section', { className: 'card', 'data-home-live-workspaces': '' },
    h('div', { className: 'card-head' }, h('h3', null, 'Projects'), h('a', { className: 'section-action', href: routeMetadata('workspaces').href }, 'Manage')),
    h('div', { className: 'card-body compact-workspace-list' },
      workspaces.length ? workspaces.slice(0, 6).map(workspace => h('div', { className: 'compact-workspace', key: workspace.alias || workspace.path },
        h('div', null, h('strong', null, workspace.alias || 'project'), h('div', { className: 'compact-workspace-path' }, workspace.path || '')),
        h(StatusPill, { value: overviewWorkspaceStatus(workspace, findings) })
      )) : h('div', { className: 'empty' }, 'No projects added yet. ', h('a', { className: 'buttonlike secondary compact-button', href: routeMetadata('workspaces').href }, 'Add your first project'))
    )
  );
}

function RecentTasksCard({ tasks }) {
  return h('section', { className: 'card', 'data-home-live-sessions': '' },
    h('div', { className: 'card-head' }, h('h3', null, 'Latest tasks'), h('a', { className: 'section-action', href: routeHref('tasks') }, 'See all tasks')),
    h('div', { className: 'card-body' },
      tasks.length ? tasks.slice(0, 5).map(task => {
        const endedAt = task.endedAt || task.completedAt;
        const warnings = task.status === 'completed' ? Number(task.failedToolCallCount ?? task.failures ?? 0) : 0;
        const warningText = warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
        const taskId = String(task.id || task.taskId || task.work_id || '').trim();
        return h('a', { className: 'activity-row', href: routeHref('tasks', { workspace: task.workspace || '', task: taskId }), key: taskId || `${task.workspace}-${endedAt || task.startedAt || ''}` },
          h('span', { className: 'activity-time', 'data-clock-relative': endedAt || undefined }, endedAt ? timeAgo(endedAt) : 'now'),
          h('span', { className: 'activity-name truncate' }, h('strong', null, task.title || task.operation || taskAction(task.lastTool)), ` · ${task.workspace || 'No project'} · ${task.toolCallCount ?? task.calls ?? 0} actions${warningText}`),
          h(StatusPill, recentTaskStatusProps(task))
        );
      }) : h('div', { className: 'empty' }, 'Tasks will appear here after ChatGPT starts a Rel.AI goal.')
    )
  );
}

function DesktopSetupChecklist({ setup }) {
  const [dismissed, setDismissed] = useState(() => isDesktopSetupDismissed());
  const [copyState, setCopyState] = useState('idle');
  const steps = desktopSetupSteps(setup);
  const remaining = steps.filter(item => !item.complete);
  const current = steps.find(item => !item.complete && !item.locked) || remaining[0];
  const completedCount = steps.length - remaining.length;
  useEffect(() => {
    const onState = event => setDismissed(event?.detail?.pending !== true);
    window.addEventListener('relai:onboarding-state', onState);
    return () => window.removeEventListener('relai:onboarding-state', onState);
  }, []);
  useEffect(() => {
    if (remaining.length) return;
    void completeDesktopSetup().then(result => {
      if (result?.ok) toast('Rel.AI is connected and ready to use with ChatGPT!', { variant: 'success' });
    });
  }, [remaining.length]);
  if (!remaining.length || dismissed) return null;
  const dismiss = async () => {
    setDismissed(true);
    const result = await dismissDesktopSetup();
    if (!result?.ok) {
      setDismissed(false);
      toast('Could not dismiss the getting started guide. Try again.', { variant: 'error' });
      return;
    }
    toast('Getting started guide dismissed.', { variant: 'info' });
  };
  const copyPrompt = async () => {
    try {
      await copyText(chatGptFirstPrompt(setup.workspaceAlias));
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1400);
    } catch { toast('Clipboard access failed.', { variant: 'error' }); }
  };
  return h('section', { className: 'card desktop-setup-checklist', 'data-desktop-setup-checklist': '' },
    h('div', { className: 'card-head desktop-setup-head' },
      h('div', null, h('span', { className: 'desktop-setup-eyebrow' }, 'Getting started'), h('h3', null, 'Get Rel.AI working with ChatGPT'), h('p', null, `${completedCount} of ${steps.length} steps complete.`)),
      h('button', { className: 'secondary compact-button', type: 'button', onClick: dismiss }, 'Dismiss guide')
    ),
    h('div', { className: 'card-body desktop-setup-items' }, steps.map((item, index) => h(DesktopSetupStep, { key: item.id, item, index, current: item.id === current?.id, setup, copyState, onCopy: copyPrompt })))
  );
}

function DesktopSetupStep({ item, index, current, setup, copyState, onCopy }) {
  const state = item.complete ? 'Done' : item.locked ? 'Not ready' : current ? 'Next' : 'Ready';
  const className = `desktop-setup-item${item.complete ? ' done' : ''}${current ? ' current' : ''}${item.locked ? ' locked' : ''}`;
  return h('div', { className },
    h('span', { className: 'desktop-setup-index', 'aria-hidden': 'true' }, item.complete ? h(Icon, { name: 'check', size: 12 }) : index + 1),
    h('div', { className: 'desktop-setup-copy' },
      h('div', { className: 'desktop-setup-title-row' }, h('strong', null, item.title), h('span', { className: 'desktop-setup-state' }, state)),
      h('p', null, item.description),
      item.id === 'first-request' && current ? h('div', { className: 'desktop-first-request' }, h('span', null, 'Paste this into ChatGPT'), h('code', null, chatGptFirstPrompt(setup.workspaceAlias))) : null,
      item.id === 'chatgpt' && current ? h(ChatGptSetupGuide, { tunnelId: setup.tunnelId }) : null
    ),
    setupAction(item, current, copyState, onCopy)
  );
}

function setupAction(item, current, copyState, onCopy) {
  if (item.complete || item.locked || item.actionType === 'guide') return null;
  if (item.actionType === 'copy') return h('button', { className: `${current ? 'primary' : 'secondary'} compact-button`, type: 'button', onClick: onCopy }, copyState === 'copied' ? 'Copied' : item.action);
  return h('a', { className: `buttonlike ${current ? 'primary' : 'secondary'} compact-button`, href: item.href }, item.action);
}

function ChatGptSetupGuide({ tunnelId }) {
  const steps = chatGptGuideSteps({ mode: 'create', tunnelId });
  return h('div', { className: 'chatgpt-setup-guide compact desktop-chatgpt-guide' },
    h('div', { className: 'chatgpt-guide-heading' }, h('span', null, 'Use Tunnel + No authentication.')),
    h('section', { className: 'chatgpt-connector-handoff', 'aria-label': 'ChatGPT connector setup' },
      h('dl', { className: 'chatgpt-connector-values' }, h('dt', null, 'Name'), h('dd', null, 'Rel.AI MCP'), h('dt', null, 'Connection'), h('dd', null, 'Tunnel'), h('dt', null, 'Tunnel'), h('dd', { className: 'mono' }, tunnelId || 'Select this computer’s tunnel'), h('dt', null, 'Authentication'), h('dd', null, 'No authentication')),
      h('div', { className: 'chatgpt-connector-actions', role: 'group', 'aria-label': 'ChatGPT connector setup actions' },
        h('button', { className: 'primary', type: 'button', onClick: () => window.open(CHATGPT_CONNECTOR_CREATE_URL, '_blank', 'noopener,noreferrer') }, 'ChatGPT setup')
      )
    ),
    h('ol', null, steps.map(step => h('li', { key: step }, step)))
  );
}

function primaryActiveTask(tasks) { return tasks.find(item => Number(item.activeCalls || 0) > 0) || tasks[0]; }
function semanticProgressFor(task = {}) { return task.semanticProgress && typeof task.semanticProgress === 'object' ? task.semanticProgress : buildTaskSemanticProgress(task); }
function activeTaskLocation(tasks) {
  const workspaces = [...new Set(tasks.map(item => item.workspace).filter(Boolean))];
  if (workspaces.length === 1) return workspaces[0];
  if (workspaces.length > 1) return `${workspaces.length} projects`;
  return 'your projects';
}
function taskAction(tool) {
  const value = String(tool || '');
  if (/run_checks|browser/.test(value)) return 'Checking changes';
  if (/diff|git_status/.test(value)) return 'Reviewing changes';
  if (/git_draft_pr|git_create_pr/.test(value)) return 'Preparing pull request text';
  if (/git_commit|git_push/.test(value)) return 'Publishing changes';
  if (/edit|write|replace|tidy_run|restore|reset_workspace/.test(value)) return 'Applying changes';
  return 'Looking through the project';
}

function TaskProgress({ progress, status, compact = false }) {
  const view = taskProgressView(progress, status, { compact });
  const attributes = {
    className: view.className,
    role: view.role || undefined,
    'aria-label': view.ariaLabel || undefined
  };
  const label = h('div', { className: 'task-progress-label' },
    h('span', null, view.label),
    view.state ? h('strong', null, view.state) : null
  );
  if (view.kind === 'static') return h('div', attributes, label);
  if (view.kind === 'indeterminate') {
    return h('div', attributes,
      label,
      h('div', { className: 'task-progress-track', 'aria-hidden': 'true' })
    );
  }
  return h('div', attributes,
    label,
    h('progress', {
      className: 'task-progress-track',
      'aria-label': view.progressAriaLabel,
      value: view.value,
      max: 100
    })
  );
}

function recentTaskStatusProps(task) {
  const status = String(task?.status || '');
  if (status === 'failed') return { value: 'failed' };
  if (status === 'blocked') { const state = workSessionStateView(task); return { value: state.label.toLowerCase(), classOverride: state.pillClass }; }
  if (status === 'completed') return { value: 'completed' };
  if (status === 'running' || status === 'working') return { value: 'running' };
  if (status === 'validating') return { value: 'validating' };
  if (status === 'validation_failed') return { value: 'validation failed' };
  if (status === 'expired') return { value: 'expired' };
  if (status === 'inactive') return { value: 'inactive' };
  if (status === 'cancelled') return { value: 'cancelled' };
  if (['queued', 'planning', 'waiting_for_approval', 'waiting', 'settling'].includes(status)) return { value: 'open' };
  return { value: 'unknown' };
}
function statusLabel(status) { return String(status || 'open').replaceAll('_', ' '); }
function compactTaskSummary(value, maxLength = HOME_TASK_SUMMARY_MAX) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  const boundary = text.lastIndexOf(' ', maxLength - 1);
  const end = boundary >= Math.floor(maxLength * 0.65) ? boundary : maxLength - 1;
  return `${text.slice(0, end).trimEnd()}…`;
}
function pluralLabel(count, singular) { return Number(count) === 1 ? singular : `${singular}s`; }
