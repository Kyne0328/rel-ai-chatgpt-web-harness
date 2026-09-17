import { isNativeTaskStatus, isTerminalDashboardTaskStatus } from '../taskState.js';

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

export function taskEntityView(value = {}) {
  return {
    logicalTaskId: text(value.work_id || value.logicalTaskId || value.workSessionId || value.id),
    nativeTaskId: text(value.nativeTaskId || value.originatingTaskId || value.nativeTask?.taskId),
    processId: text(value.processId || value.process?.processId || value.process?.id)
  };
}

export function clientCapabilityViews(data = {}) {
  const candidates = capabilityCandidates(data);
  if (!candidates.length) return [clientCapabilityView({})];
  const seen = new Set();
  const views = [];
  for (const candidate of candidates) {
    const view = clientCapabilityView(candidate);
    const key = view.connectionId || `${view.clientLabel}:${view.observedAt}:${view.capabilityState}`;
    if (seen.has(key)) continue;
    seen.add(key);
    views.push(view);
  }
  return views.slice(0, 8);
}

function clientCapabilityView(value = {}) {
  const support = observedTasksSupport(value);
  const mode = support === 'supported'
    ? 'native_tasks'
    : support === 'not_advertised'
      ? 'bounded_synchronous'
      : 'unknown';
  const clientInfo = value.clientInfo && typeof value.clientInfo === 'object' ? value.clientInfo : {};
  const clientName = text(value.clientName || clientInfo.name);
  const clientVersion = text(value.clientVersion || clientInfo.version);
  const clientLabel = clientName
    ? `${clientName}${clientVersion ? ` ${clientVersion}` : ''}`
    : 'Observed MCP client';
  const connectionId = text(value.connectionId || value.requestId || value.id || value.principal);
  const observedAt = text(value.observedAt || value.startedAt || value.timestamp || value.lastRequestAt || value.generatedAt);

  if (support === 'supported') {
    return {
      connectionId,
      clientLabel,
      observedAt,
      capabilityState: support,
      capabilityLabel: 'Native MCP Tasks: Supported',
      executionMode: mode,
      executionLabel: 'Eligible long work: Native MCP task',
      description: 'The client supports the MCP Tasks extension. Short operations still complete directly.',
      pill: 'supported',
      pillClass: 'ok'
    };
  }
  if (support === 'not_advertised') {
    return {
      connectionId,
      clientLabel,
      observedAt,
      capabilityState: support,
      capabilityLabel: 'Native MCP Tasks: Not advertised by client',
      executionMode: mode,
      executionLabel: 'Eligible long work: Work-session continuation',
      description: 'Short operations complete directly. Longer eligible operations continue in the same work session. Keep doing independent work; later Rel.AI calls can surface completion automatically, or check by work_id when the result is needed.',
      pill: 'not advertised',
      pillClass: 'warn'
    };
  }
  return {
    connectionId,
    clientLabel,
    observedAt,
    capabilityState: 'unknown',
    capabilityLabel: 'Native MCP Tasks: Unknown',
    executionMode: mode,
    executionLabel: 'Eligible long work: Capability unknown',
    description: 'No MCP Tasks capability data is available.',
    pill: 'unknown',
    pillClass: ''
  };
}

export function nativeTaskCollection(data = {}) {
  const candidates = [
    ['nativeTasks', data.nativeTasks],
    ['nativeTasks.tasks', data.nativeTasks?.tasks],
    ['mcpNativeTasks', data.mcpNativeTasks],
    ['taskActivity.nativeTasks', data.taskActivity?.nativeTasks],
    ['mcpConnection.nativeTasks', data.mcpConnection?.nativeTasks],
    ['runtimeObservability.nativeTasks', data.runtimeObservability?.nativeTasks]
  ];
  const source = candidates.find(([, value]) => Array.isArray(value));
  if (!source) {
    return {
      available: false,
      sourceField: '',
      requiredField: 'nativeTasks',
      tasks: []
    };
  }
  const seen = new Set();
  const tasks = [];
  for (const item of source[1]) {
    const taskId = text(item?.taskId || item?.id);
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    tasks.push(item);
  }
  return { available: true, sourceField: source[0], requiredField: '', tasks };
}

export function nativeTaskView(task = {}, processes = []) {
  const taskId = text(task.taskId || task.id);
  const rawStatus = normalize(task.status);
  const status = isNativeTaskStatus(rawStatus) ? rawStatus : 'unknown';
  const cancelRequested = task.cancelRequested === true || Boolean(task.cancellationRequestedAt);
  const cancellationConfirmed = status === 'cancelled' && Boolean(task.cancellationAcknowledgedAt);
  const statusView = nativeTaskStatusView(status, { cancelRequested, cancellationConfirmed });
  const origin = task.origin && typeof task.origin === 'object' ? task.origin : {};
  const internal = task.internal && typeof task.internal === 'object' ? task.internal : {};
  const logicalTaskId = text(task.logicalTaskId || task.workSessionId || origin.logicalTaskId || internal.logicalTaskId || internal.workSessionId);
  const associatedProcess = (Array.isArray(processes) ? processes : []).find(process =>
    text(process?.originatingTaskId) === taskId
  );
  const processId = text(
    task.processId
    || task.result?.processId
    || internal.processId
    || associatedProcess?.processId
  );
  const cancelAction = task.actions?.cancel || task.cancelAction || {};
  const cancelUrl = dashboardActionUrl(cancelAction.url || cancelAction.href);
  const canCancel = ['working', 'input_required'].includes(status)
    && !cancelRequested
    && cancelAction.available === true
    && Boolean(cancelUrl);
  const operation = text(task.operation || task.tool || origin.name || origin.method) || 'Asynchronous MCP operation';
  const resultSummary = firstText(
    task.resultSummary,
    task.result?.summary,
    task.result?.message,
    status === 'completed' ? task.statusMessage : ''
  );
  const errorSummary = firstText(
    task.errorSummary,
    task.error?.message,
    status === 'failed' || status === 'cancelled' ? task.statusMessage : ''
  );
  return {
    taskId,
    status,
    rawStatus,
    operation,
    logicalTaskId,
    processId,
    workspace: text(task.workspace || internal.workspace || internal.workspaceId),
    startedAt: text(task.createdAt || task.startedAt),
    updatedAt: text(task.lastUpdatedAt || task.updatedAt),
    statusMessage: text(task.statusMessage),
    resultSummary,
    errorSummary,
    cancelRequested,
    cancellationConfirmed,
    cancelUrl,
    canCancel,
    ...statusView
  };
}

export function nativeTaskStatusView(statusValue, options = {}) {
  const status = normalize(statusValue);
  if (status === 'cancelled') {
    return {
      label: options.cancellationConfirmed ? 'Cancelled (confirmed)' : 'Cancelled',
      description: options.cancellationConfirmed
        ? 'Cancellation was acknowledged after the MCP task stopped.'
        : 'The MCP task ended without completing.',
      terminal: true,
      active: false,
      showSpinner: false,
      waitingForInput: false,
      pillClass: ''
    };
  }
  if (options.cancelRequested) {
    return {
      label: 'Cancellation requested',
      description: 'Rel.AI is waiting for the MCP task to stop before it confirms cancellation.',
      terminal: false,
      active: true,
      showSpinner: false,
      waitingForInput: false,
      pillClass: 'warn'
    };
  }
  const states = {
    working: ['Working', 'The MCP task is running.', false, true, true, false, 'working'],
    input_required: ['Input required', 'Rel.AI is waiting for the client to provide input.', false, false, false, true, 'warn'],
    completed: ['Completed', 'The MCP task completed successfully.', true, false, false, false, 'ok'],
    failed: ['Failed', 'The MCP task ended with an error.', true, false, false, false, 'bad'],
    unknown: ['Unknown', 'The MCP task status is unavailable or unknown.', false, false, false, false, '']
  };
  const [label, description, terminal, active, showSpinner, waitingForInput, pillClass] = states[status] || states.unknown;
  return { label, description, terminal, active, showSpinner, waitingForInput, pillClass };
}

export function workSessionStateView(value = {}) {
  const status = normalize(typeof value === 'string' ? value : value.status);
  const states = {
    queued: ['Queued', false, true, 'working'],
    planning: ['Planning', false, true, 'working'],
    running: ['Running', false, true, 'working'],
    working: ['Working', false, true, 'working'],
    validating: ['Validating', false, true, 'working'],
    waiting: ['Open', false, false, 'working'],
    settling: ['Settling', false, true, 'working'],
    waiting_for_approval: ['Blocked', false, false, 'warn'],
    blocked: ['Blocked', false, false, 'bad'],
    validation_failed: ['Validation failed', false, false, 'bad'],
    completed: ['Completed', true, false, 'ok'],
    failed: ['Failed', true, false, 'bad'],
    cancelled: ['Cancelled', true, false, ''],
    expired: ['Expired', true, false, ''],
    inactive: ['Inactive', false, false, '']
  };
  const inactiveContext = status === 'inactive' && typeof value === 'object'
    ? normalize(value.resumeStatus || (value.validation === 'failed' ? 'validation_failed' : ''))
    : '';
  const contextualInactive = ['validation_failed', 'blocked', 'waiting_for_approval'].includes(inactiveContext)
    ? states[inactiveContext]
    : null;
  const [label, terminal, statusActive, pillClass] = contextualInactive || states[status] || ['Unknown', isTerminalDashboardTaskStatus(status, value), false, ''];
  const activityKnown = typeof value === 'object' && value !== null
    && (Object.hasOwn(value, 'activeCalls') || Object.hasOwn(value, 'state'));
  const runtimeActive = activityKnown
    ? Number(value.activeCalls || 0) > 0 || normalize(value.state) === 'working'
    : statusActive;
  const active = status === 'inactive' ? false : statusActive && runtimeActive;
  const open = !terminal && status !== 'inactive' && !active
    && ['queued', 'planning', 'running', 'working', 'validating', 'waiting', 'settling'].includes(status);
  return { status: status || 'unknown', label, terminal: status === 'inactive' ? false : terminal, active, open, pillClass }; 
}

export function processStateView(process = {}, nativeTasks = []) {
  const observedStatus = normalize(process.status);
  const rawStatus = observedStatus === 'unknown_after_restart' ? 'orphaned' : observedStatus;
  const taskId = text(process.originatingTaskId || process.nativeTaskId);
  const associatedTask = (Array.isArray(nativeTasks) ? nativeTasks : []).find(task =>
    text(task?.taskId || task?.id) === taskId
  );
  const taskStatus = normalize(associatedTask?.status);
  const independent = rawStatus === 'running' && taskStatus === 'completed';
  const states = {
    starting: ['Starting', false, true, true, 'working', 'Wait for readiness or stop the process if startup does not complete.'],
    running: [independent ? 'Running independently' : 'Running', false, true, true, 'working', 'Use Stop process when this operating-system process is no longer needed.'],
    stopping: ['Stopping', false, true, false, 'working', 'Rel.AI is waiting for confirmed process-tree exit.'],
    exited: ['Exited', true, false, false, 'ok', 'Review the exit code and recent output before restarting if needed.'],
    stopped: ['Stopped', true, false, false, '', 'Start a new process when the command is needed again.'],
    failed: ['Failed', true, false, false, 'bad', 'Review recent stderr, correct the command or environment, and start it again.'],
    orphaned: ['Unknown after restart', false, false, true, 'warn', 'Live pipes cannot be reattached. Stop the process explicitly if it is still running, then start it again.'],
    unknown: ['Unknown', false, false, false, '', 'Refresh the dashboard. If the state remains unknown, inspect Diagnostics.']
  };
  const [label, terminal, active, canStop, pillClass, recovery] = states[rawStatus] || states.unknown;
  return {
    status: rawStatus || 'unknown',
    label,
    terminal,
    active,
    canStop,
    pillClass,
    recovery,
    independent,
    taskStatus: taskStatus || 'unknown'
  };
}

export function processOutputView(process = {}) {
  const stdoutIncluded = Object.hasOwn(process, 'stdoutTail');
  const stderrIncluded = Object.hasOwn(process, 'stderrTail');
  const stdout = String(process.stdoutTail ?? '');
  const stderr = String(process.stderrTail ?? '');
  const included = stdoutIncluded || stderrIncluded;
  const hasOutput = Boolean(stdout.trim() || stderr.trim());
  return {
    included,
    hasOutput,
    stdout,
    stderr,
    message: included
      ? 'No recent stdout or stderr output was recorded.'
      : 'Recent output is not available in this dashboard snapshot.'
  };
}

function capabilityCandidates(data) {
  const connection = data.mcpConnection && typeof data.mcpConnection === 'object' ? data.mcpConnection : data;
  return (Array.isArray(connection.recentEvents) ? connection.recentEvents : [])
    .filter(event => event?.type === 'mcp_request_received')
    .sort((left, right) => timestamp(right) - timestamp(left));
}

function observedTasksSupport(value) {
  if (!Object.hasOwn(value || {}, 'clientCapabilities')) return 'unknown';
  const capabilities = value.clientCapabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return 'unknown';
  if (!Object.hasOwn(capabilities, 'extensions')) return 'not_advertised';
  const extensions = capabilities.extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return 'unknown';
  return Object.hasOwn(extensions, TASKS_EXTENSION_ID) ? 'supported' : 'not_advertised';
}

function dashboardActionUrl(value) {
  const url = text(value);
  return url.startsWith('/api/') ? url : '';
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function timestamp(value) {
  const parsed = Date.parse(value?.observedAt || value?.startedAt || value?.timestamp || value?.lastRequestAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(value) {
  return text(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function text(value) {
  return String(value ?? '').trim();
}

;
