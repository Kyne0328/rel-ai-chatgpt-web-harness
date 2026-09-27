let currentStatus = {};
let previousAnnouncementKey = '';
let actionError = '';
let clockTimer = null;
let windowFitFrame = 0;
let lastWindowFit = { width: 0, height: 0 };
const serviceLogs = [];

function requestWindowFit() {
  if (windowFitFrame) return;
  windowFitFrame = window.requestAnimationFrame(() => {
    windowFitFrame = 0;
    const shell = document.querySelector('.status-shell');
    if (!shell || typeof window.electronAPI?.fitWindowToContent !== 'function') return;
    const next = {
      width: Math.ceil(shell.getBoundingClientRect().width),
      height: Math.ceil(document.documentElement.scrollHeight)
    };
    if (next.width === lastWindowFit.width && next.height === lastWindowFit.height) return;
    lastWindowFit = next;
    window.electronAPI.fitWindowToContent(next);
  });
}

function connectionView(status) {
  if (status.serverRunning && status.tunnelStatus === 'running') {
    return {
      key: 'ready', badge: 'Ready', eyebrow: 'Connection ready',
      title: 'Secure MCP Tunnel is ready.',
      description: 'Rel.AI is running and the tunnel is connected. Keep Rel.AI running while ChatGPT uses this computer.'
    };
  }
  if (status.serverRunning && ['starting', 'locally_ready', 'authenticating', 'connecting'].includes(status.tunnelStatus)) {
    const authenticating = status.tunnelStatus === 'authenticating';
    return {
      key: 'connecting', badge: authenticating ? 'Authenticating' : 'Connecting', eyebrow: 'Secure MCP Tunnel',
      title: authenticating ? 'Checking the Secure MCP Tunnel…' : 'Starting Secure MCP Tunnel…',
      description: authenticating ? 'Rel.AI is checking the tunnel connection with OpenAI.' : 'Rel.AI is connecting this computer to OpenAI.'
    };
  }
  if (status.serverRunning && status.tunnelStatus === 'degraded') {
    return {
      key: 'degraded', badge: 'Tunnel reconnecting', eyebrow: 'Secure MCP Tunnel interrupted',
      title: 'The tunnel connection was interrupted.',
      description: 'The local Rel.AI service is still running. Rel.AI is retrying the tunnel automatically.'
    };
  }
  if (status.error || status.tunnelStatus === 'failed') {
    return {
      key: 'failed', badge: 'Needs attention', eyebrow: 'Connection failed',
      title: 'Rel.AI could not finish connecting.',
      description: 'Use the recovery actions below.'
    };
  }
  return {
    key: 'stopped', badge: 'Stopped', eyebrow: 'Rel.AI stopped',
    title: 'Rel.AI is not running.',
    description: 'Start Rel.AI to make your projects available to ChatGPT.'
  };
}

function taskPresentation(status) {
  const projected = status?.taskActivityPresentation;
  if (projected && ['attention', 'working', 'waiting', 'idle'].includes(projected.category)) return projected;
  const activity = status?.taskActivity || {};
  const activityState = String(activity.state || '').trim().toLowerCase();
  const activeCalls = Math.max(0, Number(activity.activeCalls || 0));
  const taskCount = Math.max(0, Number(activity.activeTaskCount || activity.tasks?.length || 0), activeCalls > 0 ? 1 : 0);
  return {
    category: activeCalls > 0 || activityState === 'working'
      ? 'working'
      : taskCount > 0 || ['waiting', 'settling'].includes(activityState)
        ? 'waiting'
        : 'idle',
    activeCalls,
    taskCount,
    actionRequired: false,
    reason: ''
  };
}

function heroView(status) {
  const activity = status.taskActivity || {};
  const presentation = taskPresentation(status);
  const taskCount = Math.max(1, Number(presentation.taskCount || 0));
  if (presentation.category === 'attention') return attentionHero(activity, taskCount, presentation.reason);
  if (presentation.category === 'working') return workingHero(activity, taskCount);
  if (presentation.category === 'waiting') return waitingHero(activity, taskCount);
  return connectionView(status);
}

function attentionHero(activity, taskCount, reason = '') {
  const task = (Array.isArray(activity.tasks) ? activity.tasks : []).find(item => String(item?.status || '').trim().toLowerCase().replaceAll('-', '_') === reason)
    || activity.tasks?.[0]
    || null;
  const title = reason === 'waiting_for_approval'
    ? 'Approval required.'
    : reason === 'validation_failed'
      ? 'Checks need attention.'
      : 'The current task is blocked.';
  const description = reason === 'waiting_for_approval'
    ? 'The task is paused and waits for your approval in ChatGPT.'
    : reason === 'validation_failed'
      ? 'Review the failed checks. Fix the issue. Validate again.'
      : 'Resolve the problem before the task can continue.';
  return {
    key: 'attention',
    badge: 'Action required',
    eyebrow: 'Current task',
    title: task?.title || title,
    description: task?.currentActivity || task?.errorSummary || description
  };
}

function workingHero(activity, taskCount) {
  const title = taskCount > 1
    ? `${activity.activeCalls || taskCount} Rel.AI actions are running.`
    : activity.operation || toolLabel(activity.tool);
  return {
    key: 'working',
    badge: `${activity.activeCalls || taskCount} running`,
    eyebrow: 'Current task',
    title,
    description: activityDescription(activity, false)
  };
}

function waitingHero(activity, taskCount) {
  return {
    key: 'waiting',
    badge: `${taskCount} waiting`,
    eyebrow: 'Current task',
    title: 'Rel.AI is waiting.',
    description: activityDescription(activity, true)
  };
}

function activityDescription(activity, waiting) {
  const tasks = Array.isArray(activity.tasks) ? activity.tasks : [];
  const taskCount = Number(activity.activeTaskCount || tasks.length || 1);
  const activeCalls = Number(activity.activeCalls || 0);
  const location = activityLocation(activity, tasks);
  if (waiting) return 'ChatGPT may still be working or already finished. Rel.AI only knows when ChatGPT asks it to take an action.';
  if (taskCount > 1) return `${activeCalls} ${pluralize(activeCalls, 'active action')} across ${location}. The computer stays awake while actions are running.`;
  return `${activity.operation || toolLabel(activity.tool)} in ${location}. The computer stays awake until the action finishes.`;
}

function activityLocation(activity, tasks) {
  const workspaces = [...new Set(tasks.map(task => task.workspace).filter(Boolean))];
  if (workspaces.length === 1) return workspaces[0];
  if (workspaces.length > 1) return `${workspaces.length} projects`;
  return activity.workspace || 'your projects';
}

function pluralize(count, singular) {
  return Number(count) === 1 ? singular : `${singular}s`;
}

function toolLabel(tool) {
  if (tool === 'relai_exec') return 'Running a project command';
  if (tool === 'relai_validate') return 'Checking changes';
  if (tool === 'relai_changes') return 'Reviewing or applying changes';
  if (tool === 'relai_publish') return 'Publishing changes';
  if (tool === 'relai_edit') return 'Applying changes';
  return 'Looking through the project';
}

function updateUI(status) {
  currentStatus = { ...currentStatus, ...(status || {}) };
  currentStatus.taskActivity = { ...currentStatus.taskActivity, ...(status?.taskActivity || {}) };
  const view = heroView(currentStatus);

  const badge = document.getElementById('statusBadge');
  badge.className = `status-badge ${view.key}`;
  badge.textContent = view.badge;
  document.getElementById('statusHero').dataset.state = view.key;
  document.getElementById('statusEyebrow').textContent = view.eyebrow;
  document.getElementById('statusTitle').textContent = view.title;
  document.getElementById('statusDescription').textContent = view.description;
  announceStatus(view);

  renderTaskMeta();
  renderEndpoint(view);
  renderConnectionHealth();
  renderLastTask();
  renderError(view);
  renderControls();
  ensureClock();
  requestWindowFit();
}

function announceStatus(view) {
  const key = `${view.key}|${view.title}|${view.description}`;
  if (key === previousAnnouncementKey) return;
  previousAnnouncementKey = key;
  const announcer = document.getElementById('statusAnnouncer');
  if (announcer) announcer.textContent = `${view.title} ${view.description}`;
}

function renderTaskMeta() {
  const activity = currentStatus.taskActivity || {};
  const presentation = taskPresentation(currentStatus);
  const element = document.getElementById('taskMeta');
  const active = presentation.category !== 'idle';
  element.hidden = !active;
  if (!active) return;
  const tasks = Array.isArray(activity.tasks) ? activity.tasks : [];
  const taskCount = Math.max(1, Number(presentation.taskCount || 0));
  const activeCalls = Math.max(0, Number(presentation.activeCalls || 0));
  const calls = presentation.category === 'working'
    ? `${activeCalls} ${pluralize(activeCalls, 'active action')}`
    : presentation.category === 'attention'
      ? 'action required'
      : 'no active action';
  const workspace = activityLocation(activity, tasks);
  const taskLabel = `${taskCount} ${pluralize(taskCount, 'task')}`;
  element.innerHTML = `<span class="activity-pulse" aria-hidden="true"></span><strong>${escapeText(taskLabel)}</strong><span>${escapeText(workspace)}</span><span>${escapeText(calls)}</span><time id="taskElapsed"></time>`;
  renderTemporalText();
}

function renderEndpoint(view) {
  const endpoint = document.getElementById('mcpUrl');
  const copyButton = document.getElementById('copyBtn');
  const wrap = document.getElementById('endpointWrap');
  wrap.classList.toggle('compact', ['attention', 'working', 'waiting', 'settling'].includes(view.key));
  if (currentStatus.tunnelId) {
    endpoint.textContent = currentStatus.tunnelId;
    endpoint.className = 'endpoint-box';
    copyButton.disabled = false;
  } else {
    endpoint.textContent = 'Waiting for connection setup…';
    if (view.key === 'stopped') endpoint.textContent = 'Set up the ChatGPT connection, then start Rel.AI.';
    endpoint.className = 'endpoint-box empty';
    copyButton.disabled = true;
  }
}

function renderConnectionHealth() {
  setHealthCard('localHealthCard', currentStatus.serverRunning ? 'ready' : 'offline');
  document.getElementById('localHealthState').textContent = currentStatus.serverRunning ? 'Running' : 'Stopped';
  document.getElementById('localService').textContent = currentStatus.localUrl || (currentStatus.serverRunning ? 'Running locally' : 'Not running');

  const publicState = publicHealthState(currentStatus.tunnelStatus);
  setHealthCard('publicHealthCard', publicState);
  document.getElementById('publicHealthState').textContent = tunnelLabel(currentStatus.tunnelStatus);
  document.getElementById('tunnelDetail').textContent = tunnelDetail(publicState, currentStatus.tunnelId);
}

function publicHealthState(tunnelStatus) {
  if (tunnelStatus === 'running') return 'ready';
  if (tunnelStatus === 'failed') return 'failed';
  if (tunnelStatus === 'degraded') return 'degraded';
  if (['starting', 'locally_ready', 'authenticating', 'connecting'].includes(tunnelStatus)) return 'connecting';
  return 'offline';
}

function tunnelDetail(publicState, tunnelId) {
  if (publicState === 'ready' && tunnelId) return tunnelId;
  if (publicState === 'connecting') return 'Checking Secure MCP Tunnel';
  if (publicState === 'degraded') return 'Retrying automatically';
  return tunnelId || 'Not configured';
}

function setHealthCard(id, state) {
  const card = document.getElementById(id);
  card.className = `app-card status-health-card ${state}`;
}

function renderLastTask() {
  const task = currentStatus.taskActivity?.lastTask;
  const card = document.getElementById('lastTaskCard');
  card.hidden = !task;
  if (!task) return;
  const failed = task.status === 'failed';
  const completed = task.status === 'completed' && task.completionKnown === true;
  card.className = `app-card last-task-card ${failed ? 'attention' : 'completed'}`;
  let icon = '•';
  let title = 'Last task is inactive';
  if (failed) {
    icon = '!';
    title = 'Last task had a failed action';
  } else if (completed) {
    icon = '✓';
    title = 'Task completed';
  }
  document.getElementById('lastTaskIcon').textContent = icon;
  document.getElementById('lastTaskTitle').textContent = title;
  const workspace = task.workspace || 'project';
  const calls = `${task.calls} action${task.calls === 1 ? '' : 's'}`;
  const failures = failed ? ` · ${task.failures} failed` : '';
  const completion = completed
    ? ` · ${task.summary || 'final checks passed'}`
    : ' · ChatGPT did not report a final result';
  document.getElementById('lastTaskDetail').textContent = `${workspace} · ${calls}${failures}${completion} · ${formatDuration(task.durationMs)}`;
  renderTemporalText();
}

function renderError(view) {
  const connectionFailed = view.key === 'failed';
  const failed = connectionFailed || Boolean(actionError);
  document.getElementById('errorPanel').hidden = !failed;
  document.getElementById('errorTitle').textContent = connectionFailed ? 'Connection needs attention' : 'Action needs attention';
  document.getElementById('errorMessage').textContent = connectionFailed
    ? currentStatus.error || 'The Secure MCP Tunnel did not become ready.'
    : actionError;
  for (const id of ['retryBtn', 'restartAppBtn', 'errorSettingsBtn']) {
    document.getElementById(id).hidden = !connectionFailed;
  }
}

function setActionError(value) {
  actionError = String(value || '').replace(/\s+/g, ' ').trim();
  renderError(heroView(currentStatus));
  requestWindowFit();
}

function renderControls() {
  const toggle = document.getElementById('serverToggleBtn');
  toggle.textContent = currentStatus.serverRunning ? 'Stop Rel.AI' : 'Start Rel.AI';
  toggle.className = currentStatus.serverRunning ? 'danger compact-control' : 'primary compact-control';
  document.getElementById('dashboardBtn').disabled = !currentStatus.serverRunning;
  document.getElementById('appVersion').textContent = currentStatus.version ? `v${currentStatus.version}` : '—';
}

function ensureClock() {
  if (clockTimer) window.clearTimeout(clockTimer);
  clockTimer = null;
  if (document.visibilityState === 'hidden') return;
  const activity = currentStatus.taskActivity || {};
  const active = taskPresentation(currentStatus).category !== 'idle';
  const lastTask = activity.lastTask;
  if (!active && !lastTask) return;
  renderTemporalText();
  const delay = active ? 1000 : nextRelativeClockDelay(lastTask?.endedAt || lastTask?.completedAt);
  clockTimer = window.setTimeout(() => {
    clockTimer = null;
    ensureClock();
  }, delay);
}

function parseTimestampMs(value) {
  if (value == null || value === '') return Number.NaN;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
  return Date.parse(String(value));
}

function nextRelativeClockDelay(timestamp, now = Date.now()) {
  const parsed = parseTimestampMs(timestamp);
  const age = Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
  if (age < 60_000) return Math.max(250, 1000 - (age % 1000));
  return Math.max(1000, 60_000 - (age % 60_000));
}

function renderTemporalText() {
  const activity = currentStatus.taskActivity || {};
  const elapsed = document.getElementById('taskElapsed');
  const startedAt = parseTimestampMs(activity.startedAt);
  if (elapsed) elapsed.textContent = Number.isFinite(startedAt) ? formatDuration(Date.now() - startedAt) : '';
  const task = activity.lastTask;
  const lastTime = document.getElementById('lastTaskTime');
  const endedAt = task?.endedAt || task?.completedAt;
  const endedAtMs = parseTimestampMs(endedAt);
  if (lastTime && Number.isFinite(endedAtMs)) {
    lastTime.dateTime = new Date(endedAtMs).toISOString();
    lastTime.textContent = relativeTime(endedAtMs);
  }
}

function relativeTime(timestamp, now = Date.now()) {
  const parsed = parseTimestampMs(timestamp);
  if (!Number.isFinite(parsed)) return '';
  const seconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function diagnosticSummary() {
  const activity = currentStatus.taskActivity || {};
  const versionLabel = currentStatus.version ? `v${currentStatus.version}` : '';
  const serviceState = currentStatus.serverRunning ? 'running' : 'stopped';
  const taskCount = activity.activeTaskCount || activity.tasks?.length || 0;
  const lines = [
    `Rel.AI MCP ${versionLabel}`.trim(),
    `Local service: ${currentStatus.localUrl || serviceState}`,
    `Secure tunnel: ${tunnelLabel(currentStatus.tunnelStatus)}`,
    `Tunnel ID: ${currentStatus.tunnelId || 'not configured'}`,
    `Local MCP: ${currentStatus.localMcpUrl || 'unavailable'}`,
    `Task activity: ${activity.state || 'idle'} · ${taskCount} open task(s) · ${activity.activeCalls || 0} active call(s)`
  ];
  if (currentStatus.errorCode) lines.push(`Error code: ${currentStatus.errorCode}`);
  if (currentStatus.error) lines.push(`Error: ${safeDiagnosticText(currentStatus.error)}`);
  if (actionError) lines.push(`Last action error: ${safeDiagnosticText(actionError)}`);
  if (serviceLogs.length) lines.push('', 'Recent service logs:', ...serviceLogs.slice(-20).map(formatServiceLog));
  return safeDiagnosticText(lines.join('\n'));
}

function receiveServerLog(value) {
  const entry = normalizeServiceLog(value);
  if (!entry.message) return;
  const previous = serviceLogs.at(-1);
  if (entry.repeatCount > 1 && previous && sameServiceLog(previous, entry)) serviceLogs[serviceLogs.length - 1] = entry;
  else serviceLogs.push(entry);
  if (serviceLogs.length > 100) serviceLogs.splice(0, serviceLogs.length - 100);
  renderServiceLogs();
}

function normalizeServiceLog(value) {
  if (value && typeof value === 'object') {
    return {
      ts: value.ts || new Date().toISOString(),
      lastTs: value.lastTs || '',
      level: ['error', 'warning', 'info', 'debug'].includes(value.level) ? value.level : 'info',
      source: safeDiagnosticText(value.source || 'desktop'),
      component: safeDiagnosticText(value.component || ''),
      code: safeDiagnosticText(value.code || ''),
      message: safeDiagnosticText(value.message || ''),
      repeatCount: Math.max(1, Number(value.repeatCount || 1)),
      details: safeLogDetails(value.details)
    };
  }
  return { ts: new Date().toISOString(), lastTs: '', level: 'info', source: 'desktop', component: '', code: '', message: safeDiagnosticText(value), repeatCount: 1, details: {} };
}

function sameServiceLog(left, right) {
  return left.level === right.level && left.source === right.source && left.component === right.component && left.code === right.code && left.message === right.message;
}

function renderServiceLogs() {
  const element = document.getElementById('serviceLog');
  if (!element) return;
  const showDebug = document.getElementById('debugLogsToggle')?.checked === true;
  const visible = serviceLogs.filter(entry => showDebug || entry.level !== 'debug');
  element.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'fallback-log-empty';
    empty.textContent = serviceLogs.length ? 'Only debug logs are currently hidden.' : 'No app logs recorded yet.';
    element.appendChild(empty);
    requestWindowFit();
    return;
  }
  for (const entry of visible) element.appendChild(serviceLogElement(entry));
  requestWindowFit();
}

function serviceLogElement(entry) {
  const details = document.createElement('details');
  details.className = `fallback-log-entry ${entry.level}`;
  const summary = document.createElement('summary');
  summary.className = 'fallback-log-summary';

  const time = document.createElement('time');
  time.dateTime = entry.lastTs || entry.ts;
  time.textContent = localLogTimestamp(entry.lastTs || entry.ts);
  const level = document.createElement('span');
  level.className = `fallback-log-level ${entry.level}`;
  level.textContent = String(entry.level || 'info').toUpperCase();
  const source = document.createElement('code');
  source.textContent = entry.component ? `${entry.source}/${entry.component}` : entry.source;
  const message = document.createElement('span');
  message.className = 'fallback-log-message';
  message.textContent = entry.message;
  summary.append(time, level, source, message);
  if (entry.repeatCount > 1) {
    const repeat = document.createElement('span');
    repeat.className = 'fallback-log-repeat';
    repeat.textContent = `×${entry.repeatCount}`;
    summary.appendChild(repeat);
  }
  details.appendChild(summary);

  const technical = { ...(entry.code ? { code: entry.code } : {}), ...entry.details };
  if (Object.keys(technical).length) {
    const body = document.createElement('div');
    body.className = 'fallback-log-details';
    const label = document.createElement('strong');
    label.textContent = 'Technical details';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(technical, null, 2);
    body.append(label, pre);
    details.appendChild(body);
  }
  return details;
}

function formatServiceLog(entry) {
  const source = entry.component ? `${entry.source}/${entry.component}` : entry.source || 'desktop';
  const code = entry.code ? ` ${entry.code}` : '';
  const repeat = entry.repeatCount > 1 ? ` ×${entry.repeatCount}` : '';
  const details = Object.keys(entry.details || {}).length ? ` ${JSON.stringify(entry.details)}` : '';
  return `${entry.lastTs || entry.ts || ''} ${String(entry.level || 'info').toUpperCase()} ${source}${code}${repeat}: ${entry.message}${details}`.trim();
}

function localLogTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(undefined, { hour12: false }) : 'Unknown time';
}

function safeLogDetails(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return {};
  const output = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 24)) {
    const key = safeDiagnosticText(rawKey).slice(0, 80);
    if (!key || /token|secret|password|authorization|api.?key|credential/i.test(key)) continue;
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const nested = safeLogDetails(rawValue, depth + 1);
      if (Object.keys(nested).length) output[key] = nested;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) output[key] = rawValue;
    else if (typeof rawValue === 'boolean') output[key] = rawValue;
    else {
      const text = safeDiagnosticText(rawValue).slice(0, 1000);
      if (text) output[key] = text;
    }
  }
  return output;
}

function safeDiagnosticText(value) {
  return String(value == null ? '' : value)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|bootstrap|code|client_secret)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:token|secret|password|authorization|api[_-]?key|authtoken|client[_-]?secret)["']?\s*:\s*)["'][^"']*["']/gi, '$1"[redacted]"')
    .replace(/\b(token|secret|password|authorization|api[_-]?key|authtoken|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

async function copyWithFeedback(button, text, successText = 'Copied') {
  await window.electronAPI.copyUrl(text);
  const original = button.textContent;
  button.dataset.state = 'success';
  button.textContent = successText;
  window.setTimeout(() => {
    delete button.dataset.state;
    button.textContent = original;
  }, 1300);
}

function initDisclosures() {
  for (const details of document.querySelectorAll('[data-disclosure]')) {
    const key = `relai_activity_disclosure_${details.dataset.disclosure}`;
    const saved = localStorage.getItem(key);
    if (saved) details.open = saved === 'open';
    details.addEventListener('toggle', () => {
      localStorage.setItem(key, details.open ? 'open' : 'closed');
      requestWindowFit();
    });
  }
}

function tunnelLabel(status) {
  if (status === 'running') return 'Connected';
  if (status === 'degraded') return 'Reconnecting';
  if (status === 'authenticating') return 'Authenticating';
  if (['starting', 'locally_ready', 'connecting'].includes(status)) return 'Connecting';
  if (status === 'failed') return 'Failed';
  return 'Offline';
}

async function withBusy(button, label, action) {
  const original = button.textContent;
  button.disabled = true;
  button.dataset.state = 'loading';
  button.textContent = label;
  try {
    const result = await action();
    setActionError('');
    if (result) updateUI(result);
  } catch (error) {
    setActionError(error instanceof Error ? error.message : 'The action could not be completed.');
  } finally {
    button.disabled = false;
    delete button.dataset.state;
    if (button.textContent === label) button.textContent = original;
  }
}

function bindEvents() {
  document.getElementById('copyBtn').addEventListener('click', () => {
    if (currentStatus.tunnelId) runAsync(copyWithFeedback(document.getElementById('copyBtn'), currentStatus.tunnelId, 'Tunnel ID copied'));
  });
  document.getElementById('serverToggleBtn').addEventListener('click', () => {
    const button = document.getElementById('serverToggleBtn');
    const stopping = currentStatus.serverRunning;
    runAsync(withBusy(button, stopping ? 'Stopping…' : 'Starting…', () => stopping
      ? window.electronAPI.stopServer()
      : window.electronAPI.startServer()));
  });
  document.getElementById('retryBtn').addEventListener('click', () => {
    runAsync(withBusy(document.getElementById('retryBtn'), 'Retrying connection…', () => window.electronAPI.restartConnection()));
  });
  document.getElementById('restartAppBtn').addEventListener('click', () => {
    runAsync(withBusy(document.getElementById('restartAppBtn'), 'Restarting Rel.AI…', () => window.electronAPI.relaunchApp()));
  });
  document.getElementById('debugLogsToggle')?.addEventListener('change', renderServiceLogs);
  document.getElementById('copyDiagnosticsBtn').addEventListener('click', () => {
    runAsync(copyWithFeedback(document.getElementById('copyDiagnosticsBtn'), diagnosticSummary(), 'Details copied'));
  });
  document.getElementById('dashboardBtn').addEventListener('click', () => {
    runAsync(withBusy(document.getElementById('dashboardBtn'), 'Opening…', async () => {
      await window.electronAPI.openDashboard();
      return null;
    }));
  });
  for (const id of ['settingsBtn', 'errorSettingsBtn']) {
    document.getElementById(id).addEventListener('click', () => runAsync(window.electronAPI.openRecoverySetup()));
  }
}

function runAsync(promise) {
  Promise.resolve(promise).catch(error => {
    if (localStorage.getItem('relai_debug') === '1') console.error(error);
  });
}

function escapeText(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

window.electronAPI.onServerStatus(updateUI);
window.electronAPI.onServerLog(receiveServerLog);
document.addEventListener('visibilitychange', ensureClock);
initDisclosures();
bindEvents();
updateUI(currentStatus);
