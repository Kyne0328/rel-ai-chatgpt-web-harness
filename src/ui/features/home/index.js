import { connectionStateFor, connectionSummary, hasObservedMcpConnection, hasObservedMcpToolCall } from '../../connection-state.js';
import { getWorkspaceFilter } from '../../router.js';
import { workSessionStateView } from '../../task-identity.js';

export function overviewState(data = {}, workspaceFilter = getWorkspaceFilter()) {
  const config = data.config || {};
  const health = data.health || {};
  const connection = data.connection || {};
  const allWorkspaces = orderOverviewWorkspaces(Array.isArray(config.workspaces) ? config.workspaces : []);
  const workspaces = workspaceFilter ? allWorkspaces.filter(workspace => workspace.alias === workspaceFilter) : allWorkspaces;
  const tasks = orderOverviewTasks((Array.isArray(data.tasks) ? data.tasks : []).filter(task => !workspaceFilter || task.workspace === workspaceFilter));
  const findings = actionableFindings(health);
  const endpoint = String(connection.chatgptMcpUrl || '');
  const state = connectionStateFor(data);
  const effectiveEndpoint = state.publicEndpoint?.status === 'available' ? endpoint : '';
  return {
    workspaces,
    tasks,
    findings,
    effectiveEndpoint,
    bridgeState: resolveBridgeState({ endpoint: effectiveEndpoint, workspaces, findings, connectionState: state })
  };
}

export function resolveBridgeState({ findings = [], connectionState }) {
  const connection = connectionSummary(connectionState);
  if (connection.tone !== 'ok') {
    return {
      tone: connection.tone === 'bad' ? 'bad' : 'warn',
      kicker: 'Connection status',
      title: connection.title,
      description: connection.message
    };
  }
  if (findings.some(item => item?.severity === 'error')) {
    return {
      tone: 'bad',
      kicker: 'Needs attention',
      title: 'Rel.AI is connected, but a problem needs attention.',
      description: 'Resolve the problem before Rel.AI makes project changes.'
    };
  }
  if (findings.some(item => item?.severity === 'warning')) {
    return {
      tone: 'warn',
      kicker: 'Connected with warning',
      title: 'Rel.AI is connected and ready.',
      description: 'Review the warning before you start another task.'
    };
  }
  return {
    tone: 'good',
    kicker: '',
    title: 'ChatGPT can work on your projects.',
    description: ''
  };
}

export function activeTaskList(activity = {}) {
  const tasks = Array.isArray(activity.tasks)
    ? activity.tasks
    : activity.taskId && activity.state !== 'idle'
      ? [activity]
      : [];
  return tasks.filter(task => !workSessionStateView(task).terminal);
}

export function overviewWorkspaceStatus(workspace = {}, findings = []) {
  const alias = String(workspace.alias || '');
  if (alias && findings.some(finding => finding?.workspace === alias && finding?.severity === 'error')) return 'needs attention';
  if (workspace.operational?.exists === false) return 'unavailable';
  if (workspace.operational?.currentActivity || workspace.sessionPolicy?.sessionActive) return 'active';
  return 'ready';
}

export function orderOverviewTasks(tasks = []) {
  return [...(Array.isArray(tasks) ? tasks : [])].sort((left, right) => {
    const timestampDifference = overviewTimestamp(right) - overviewTimestamp(left);
    if (timestampDifference) return timestampDifference;
    return String(left?.id || '').localeCompare(String(right?.id || ''), 'en-US', { numeric: true, sensitivity: 'base' });
  });
}

export function orderOverviewWorkspaces(workspaces = []) {
  return [...(Array.isArray(workspaces) ? workspaces : [])].sort((left, right) =>
    String(left?.alias || '').localeCompare(String(right?.alias || ''), 'en-US', { numeric: true, sensitivity: 'base' })
  );
}

export function desktopSetupState(data = {}) {
  const workspaces = Array.isArray(data.config?.workspaces) ? data.config.workspaces : [];
  const state = connectionStateFor(data);
  const mcpConnection = data.mcpConnection || state.mcpClient || {};
  return {
    hasWorkspace: workspaces.length > 0,
    endpointReady: state.localService?.status === 'running' && state.publicEndpoint?.status === 'available',
    chatgptReady: hasObservedMcpConnection(mcpConnection),
    firstRequestObserved: hasObservedMcpToolCall(mcpConnection),
    connectionMode: 'secure_tunnel',
    workspaceAlias: workspaces[0]?.alias || 'myapp',
    tunnelId: String(data.desktopStatus?.tunnelId || data.connection?.tunnelId || '')
  };
}

export function homeAnalyticsView(scope = {}) {
  const completed = Number(scope.completed || 0);
  const actions = Number(scope.toolCalls || 0);
  const internalErrors = Number(scope.infrastructureFailures || 0);
  const workspaceScoped = scope.kind === 'workspace';
  const activeProjects = (Array.isArray(scope.workspaces) ? scope.workspaces : []).filter(item => Number(item.toolCalls || 0) > 0).length;
  return {
    heading: workspaceScoped ? `${scope.label} activity` : 'Activity',
    workspaceScoped,
    workspace: String(scope.workspace || ''),
    metrics: [
      { label: 'Actions', value: formatInteger(actions), detail: '' },
      {
        label: 'Successful actions',
        value: completed ? formatPercent(scope.operationSuccessRate) : '—',
        detail: completed ? `${formatInteger(completed)} completed` : 'No completed actions'
      },
      {
        label: 'Average time',
        value: completed ? formatAnalyticsDuration(scope.averageDuration) : '—',
        detail: completed ? 'Per completed action' : ''
      },
      workspaceScoped
        ? { label: 'Total execution time', value: completed ? formatAnalyticsDuration(scope.executionMs) : '—', detail: '' }
        : { label: 'Active projects', value: formatInteger(activeProjects), detail: '' }
    ],
    contextSummary: analyticsContextSummary(scope, actions),
    errorSummary: internalErrors
      ? `${formatInteger(internalErrors)} Rel.AI internal ${pluralLabel(internalErrors, 'error')}`
      : '',
    pulse: homeAnalyticsPulseView(scope.points)
  };
}

function homeAnalyticsPulseView(points = []) {
  const source = Array.isArray(points) ? points : [];
  const values = source
    .map(point => Number(point?.toolCalls || 0))
    .map(value => Number.isFinite(value) && value >= 0 ? value : 0);
  const labels = source.map((point, index) => formatHomeAnalyticsPointTime(point?.at, { index, count: source.length }));
  const detailedLabels = source.map((point, index) => formatHomeAnalyticsPointTime(point?.at, { detailed: true, index, count: source.length }));
  if (!values.length || values.every(value => value === 0)) return { empty: true, values, labels, detailedLabels, latestIndex: Math.max(0, values.length - 1) };
  const total = values.reduce((sum, value) => sum + value, 0);
  const latestIndex = Math.max(0, values.length - 1);
  const latest = values[latestIndex] || 0;
  const peak = Math.max(...values);
  const peakIndex = values.indexOf(peak);
  const hoursAgo = Math.max(0, latestIndex - peakIndex);
  const trend = latest > values[0] ? 'increasing' : latest < values[0] ? 'decreasing' : 'steady';
  return {
    empty: false,
    values,
    labels,
    detailedLabels,
    latestIndex,
    peak,
    peakIndex,
    summary: `Action activity across the latest 24 UTC-hour buckets. ${formatInteger(total)} total actions. Peak ${formatInteger(peak)} ${pluralLabel(peak, 'action')} ${hoursAgo ? `${hoursAgo} ${pluralLabel(hoursAgo, 'hour')} ago` : 'in the current hour'}. Current hour ${formatInteger(latest)} ${pluralLabel(latest, 'action')}. Overall trend ${trend}.`
  };
}

function formatHomeAnalyticsPointTime(value, { detailed = false, index = 0, count = 0 } = {}) {
  const time = Number(value);
  if (!Number.isFinite(time)) {
    const hoursAgo = Math.max(0, Number(count || 0) - 1 - Number(index || 0));
    return hoursAgo ? `${hoursAgo}h ago` : 'Current hour';
  }
  const options = detailed
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }
    : { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false };
  const label = new Intl.DateTimeFormat(undefined, options).format(new Date(time));
  return detailed ? `${label} UTC` : label;
}

function actionableFindings(health = {}) {
  return Array.isArray(health.findings) ? health.findings.filter(item => item.severity !== 'info') : [];
}

function overviewTimestamp(task) {
  const timestamp = Date.parse(task?.endedAt || task?.completedAt || task?.lastActivityAt || task?.startedAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function analyticsContextSummary(scope = {}, actions = 0) {
  const topProject = Array.isArray(scope.workspaces) ? scope.workspaces[0] : null;
  if (!actions) return 'No activity';
  if (scope.kind !== 'workspace' && topProject?.workspace) return `Most active project: ${topProject.workspace}`;
  return `${formatInteger(actions)} ${pluralLabel(actions, 'action')} in the latest 24 UTC-hour buckets`;
}

function formatInteger(value) {
  return Math.floor(Number(value) || 0).toLocaleString();
}

function formatPercent(value) {
  const number = Number(value) || 0;
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

function formatAnalyticsDuration(value) {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (milliseconds < 1000) return `${Math.floor(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  const minutes = seconds / 60;
  return `${minutes.toFixed(minutes >= 10 ? 1 : 2)} min`;
}

function pluralLabel(count, singular) {
  return Number(count) === 1 ? singular : `${singular}s`;
}
