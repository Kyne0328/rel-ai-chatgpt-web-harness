let currentModel = { route: '#home' };
let expanded = false;
let morphAnimation = null;
let morphDirection = '';
let morphCompletionTimer = null;

const PULSE_TRANSITION_MS = 180;
const PULSE_EASING = 'cubic-bezier(.16,1,.3,1)';
const WORKING_HEARTBEAT_DURATION_MS = 1600;
const WORKING_HEARTBEAT_GAP_MS = 3600;

const shell = document.getElementById('pulseShell');
const toggle = document.getElementById('pulseToggle');
const island = document.getElementById('pulseIsland');
const openButton = document.getElementById('pulseOpen');
const workspaceRow = document.getElementById('pulseWorkspaceRow');
const tasksBlock = document.getElementById('pulseTasksBlock');
const taskList = document.getElementById('pulseTaskList');
const tasksCount = document.getElementById('pulseTasksCount');
const progress = document.getElementById('pulseProgress');
const compactCopy = document.getElementById('pulseCompactCopy');
const stateEl = document.getElementById('pulseState');
const expandedStateEl = document.getElementById('pulseExpandedState');
const taskCountElement = document.getElementById('pulseTaskCount');
const compactTitleEl = document.getElementById('pulseCompactTitle');
const compactElapsed = document.getElementById('pulseCompactElapsed');
const expandedElapsed = document.getElementById('pulseExpandedElapsed');
const compactProgressFill = document.getElementById('pulseCompactProgressFill');
const titleEl = document.getElementById('pulseTitle');
const activityRow = document.getElementById('pulseActivity');
const activityText = document.getElementById('pulseActivityText');
const activityElapsed = document.getElementById('pulseActivityElapsed');
const summaryEl = document.getElementById('pulseSummary');
const workspaceEl = document.getElementById('pulseWorkspace');
const progressFill = document.getElementById('pulseProgressFill');
const progressLabelEl = document.getElementById('pulseProgressLabel');
const progressValueEl = document.getElementById('pulseProgressValue');
const openLabelEl = document.getElementById('pulseOpenLabel');
const liveRegion = document.getElementById('pulseLive');

let renderScheduled = false;
let lastProgressBucket = -1;
let lastLiveAnnouncement = '';
let workingHeartbeatTimer = null;

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setTextWithTitle(element, value) {
  if (!element) return;
  if (element.textContent !== value) element.textContent = value;
  if (element.title !== value) element.title = value;
}

function announceStatus(message) {
  if (!liveRegion || message === lastLiveAnnouncement) return;
  lastLiveAnnouncement = message;
  liveRegion.textContent = message;
}

function stateLabel(model) {
  if (model.actionRequired) return 'Action required';
  if (model.tone === 'working') return 'Working';
  if (model.tone === 'waiting') return 'Waiting';
  if (model.tone === 'attention') return 'Needs attention';
  return 'Rel.AI';
}

function formatElapsed(startedAt, now = Date.now()) {
  const start = Number(startedAt);
  if (!Number.isFinite(start) || start <= 0) return '';
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function tickElapsed() {
  const label = formatElapsed(currentModel.startedAt);
  for (const element of [compactElapsed, expandedElapsed, activityElapsed]) {
    if (!element) continue;
    if (!label) {
      element.hidden = true;
      if (element.textContent !== '') element.textContent = '';
      continue;
    }
    element.hidden = false;
    if (element.textContent !== label) element.textContent = label;
  }
}

function taskItems(model) {
  if (Array.isArray(model.taskItems) && model.taskItems.length) return model.taskItems.slice(0, 3);
  const names = (Array.isArray(model.taskNames) ? model.taskNames : []).filter(Boolean).slice(0, 3);
  return names.map(title => ({ title: String(title), workspace: '', status: '', statusLabel: '', active: false, id: '' }));
}

function updatePulse(model = {}) {
  if (model?.expanded === false && expanded) resetExpandedFromHost();
  currentModel = {
    ...currentModel,
    contextTitle: '',
    workspace: '',
    workspacesLabel: '',
    activityLine: '',
    startedAt: null,
    otherTaskCount: 0,
    taskNames: [],
    taskItems: [],
    progressPercent: undefined,
    progressLabel: '',
    ...(model || {})
  };
  if (typeof window.requestAnimationFrame === 'function') {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => {
      renderScheduled = false;
      renderPulse();
    });
    return;
  }
  renderPulse();
}

function renderPulse() {
  const themePreference = ['dark', 'light'].includes(currentModel.themePreference) ? currentModel.themePreference : '';
  if (themePreference) document.documentElement.dataset.theme = themePreference;
  else delete document.documentElement.dataset.theme;

  const label = stateLabel(currentModel);
  const title = currentModel.title || 'Rel.AI';
  const contextTitle = String(currentModel.contextTitle || '').trim();
  const detail = String(currentModel.detail || '').trim();
  const activityLine = String(currentModel.activityLine || '').trim();
  const workspace = String(currentModel.workspace || '').trim();
  const workspacesLabel = String(currentModel.workspacesLabel || workspace).trim();
  const taskCount = Math.max(0, Number(currentModel.taskCount || 0));
  const taskNames = (Array.isArray(currentModel.taskNames) ? currentModel.taskNames : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const items = taskItems(currentModel);
  const multiTask = items.length > 1 || taskCount > 1;
  const progressPercent = Number(currentModel.progressPercent);
  const hasProgress = Number.isFinite(progressPercent) && progressPercent >= 0;

  if (shell.dataset.tone !== String(currentModel.tone || 'idle')) shell.dataset.tone = String(currentModel.tone || 'idle');
  setText(stateEl, label);
  setText(expandedStateEl, label);
  taskCountElement.hidden = taskCount < 1;
  taskCountElement.textContent = taskCount === 1 ? '1 task' : `${taskCount} tasks`;
  setTextWithTitle(compactTitleEl, title);
  setTextWithTitle(titleEl, title);

  if (activityRow) {
    activityRow.hidden = !activityLine;
    setTextWithTitle(activityText, activityLine);
  }

  const summary = contextTitle && contextTitle !== title ? contextTitle : (detail || (currentModel.tone === 'idle' ? '' : 'Local activity is in progress.'));
  const hideSummaryForDensity = multiTask && items.length > 0;
  if (summaryEl) {
    summaryEl.hidden = !summary || (hideSummaryForDensity && !hasProgress);
    if (!summaryEl.hidden) setTextWithTitle(summaryEl, summary);
  }

  const showWorkspaceRow = Boolean(workspace) && !multiTask;
  if (workspaceRow) workspaceRow.hidden = !showWorkspaceRow;
  setTextWithTitle(workspaceEl, workspace);

  renderTaskList(items, taskCount, workspacesLabel, taskNames);

  progress.hidden = !hasProgress;
  if (hasProgress) {
    const percent = Math.min(100, Math.max(0, progressPercent));
    const bucket = Math.round(percent);
    if (bucket !== lastProgressBucket) {
      lastProgressBucket = bucket;
      if (progressFill.style.width !== `${percent}%`) progressFill.style.width = `${percent}%`;
      if (compactProgressFill && compactProgressFill.style.width !== `${percent}%`) compactProgressFill.style.width = `${percent}%`;
      setText(progressLabelEl, currentModel.progressLabel || 'Progress');
      setText(progressValueEl, `${Math.round(percent)}%`);
      progress.setAttribute('aria-valuenow', String(Math.round(percent)));
      progress.setAttribute('aria-label', currentModel.progressLabel || 'Task progress');
    }
  } else if (lastProgressBucket !== -1) {
    lastProgressBucket = -1;
    if (progressFill.style.width !== '0%') progressFill.style.width = '0%';
    if (compactProgressFill && compactProgressFill.style.width !== '0%') compactProgressFill.style.width = '0%';
  }

  const openText = currentModel.actionRequired ? 'Review in Rel.AI' : 'Open in Rel.AI';
  setText(openLabelEl, openText);
  const openLabel = `${currentModel.actionRequired ? 'Review' : 'Open'} ${title}`;
  if (openButton.getAttribute('aria-label') !== openLabel) openButton.setAttribute('aria-label', openLabel);
  tickElapsed();
  syncWorkingHeartbeat();
  announceStatus(`${[label, title, summary].filter(Boolean).join('. ')}.`);
}

function shouldRunWorkingHeartbeat() {
  return currentModel.tone === 'working'
    && document.visibilityState !== 'hidden'
    && !prefersReducedMotion();
}

function clearWorkingHeartbeatTimer() {
  if (workingHeartbeatTimer === null) return;
  window.clearTimeout(workingHeartbeatTimer);
  workingHeartbeatTimer = null;
}

function stopWorkingHeartbeat() {
  clearWorkingHeartbeatTimer();
  shell.classList.remove('is-heartbeating');
}

function scheduleWorkingHeartbeat(delay = 0) {
  clearWorkingHeartbeatTimer();
  if (!shouldRunWorkingHeartbeat()) {
    stopWorkingHeartbeat();
    return;
  }
  workingHeartbeatTimer = window.setTimeout(() => {
    workingHeartbeatTimer = null;
    if (!shouldRunWorkingHeartbeat()) {
      stopWorkingHeartbeat();
      return;
    }
    shell.classList.add('is-heartbeating');
    workingHeartbeatTimer = window.setTimeout(() => {
      workingHeartbeatTimer = null;
      shell.classList.remove('is-heartbeating');
      scheduleWorkingHeartbeat(WORKING_HEARTBEAT_GAP_MS);
    }, WORKING_HEARTBEAT_DURATION_MS);
  }, delay);
}

function syncWorkingHeartbeat() {
  if (!shouldRunWorkingHeartbeat()) {
    stopWorkingHeartbeat();
    return;
  }
  if (workingHeartbeatTimer !== null || shell.classList.contains('is-heartbeating')) return;
  scheduleWorkingHeartbeat();
}

function renderTaskList(items, taskCount, workspacesLabel, taskNames) {
  if (!tasksBlock || !taskList) return;
  const visible = items.length > 0;
  tasksBlock.hidden = !visible;
  if (!visible) {
    taskList.textContent = '';
    return;
  }
  const hiddenTaskCount = Math.max(0, taskCount - items.length);
  const countLabel = hiddenTaskCount > 0
    ? `${taskCount} tasks · +${hiddenTaskCount} more`
    : taskCount > 1
      ? `${taskCount} tasks${workspacesLabel ? ` · ${workspacesLabel}` : ''}`
      : (workspacesLabel || '');
  setText(tasksCount, countLabel);

  if (taskList.childElementCount !== items.length) taskList.textContent = '';
  items.forEach((item, index) => {
    const title = String(item.title || '').trim() || 'Untitled task';
    const meta = [item.workspace ? String(item.workspace) : '', item.statusLabel && !item.active ? String(item.statusLabel) : ''].filter(Boolean).join(' · ');
    const pill = item.active ? 'Running' : (item.statusLabel || 'Queued');
    let row = taskList.children[index];
    if (!row) {
      row = document.createElement('li');
      row.className = 'pulse-task-row';
      const dot = document.createElement('span');
      dot.className = 'pulse-task-dot';
      dot.setAttribute('aria-hidden', 'true');
      const main = document.createElement('div');
      main.className = 'pulse-task-main';
      const titleEl = document.createElement('div');
      titleEl.className = 'pulse-task-title';
      const metaEl = document.createElement('div');
      metaEl.className = 'pulse-task-meta';
      const pillEl = document.createElement('span');
      pillEl.className = 'pulse-task-pill';
      main.append(titleEl, metaEl);
      row.append(dot, main, pillEl);
      taskList.append(row);
    }
    row.dataset.active = item.active ? 'true' : 'false';
    if (item.status) row.dataset.status = String(item.status);
    else delete row.dataset.status;
    const titleNode = row.querySelector('.pulse-task-title');
    const metaNode = row.querySelector('.pulse-task-meta');
    const pillNode = row.querySelector('.pulse-task-pill');
    setTextWithTitle(titleNode, title);
    if (meta) {
      metaNode.hidden = false;
      setTextWithTitle(metaNode, meta);
    } else {
      metaNode.hidden = true;
      setText(metaNode, '');
    }
    setText(pillNode, pill);
    const accessibleName = `${title}${meta ? `, ${meta}` : ''}, ${pill}`;
    if (row.getAttribute('aria-label') !== accessibleName) row.setAttribute('aria-label', accessibleName);
  });
  while (taskList.childElementCount > items.length) taskList.lastChild?.remove();
  // Keep the legacy joined-names format for the screen-reader label.
  const joinedNames = taskNames.join(' · ');
  tasksBlock.setAttribute('aria-label', joinedNames ? `Tasks: ${joinedNames}` : `Tasks: ${items.map(item => item.title).join(' · ')}`);
}

function setExpanded(next) {
  const value = next === true;
  if (expanded === value) return;
  expanded = value;
  applyExpandedAccessibility(value);

  if (morphAnimation) {
    shell.dataset.collapsing = String(!value);
    if ((value && morphDirection === 'collapse') || (!value && morphDirection === 'expand')) {
      morphDirection = value ? 'expand' : 'collapse';
      morphAnimation.reverse();
      scheduleMorphCompletion(morphAnimation);
    }
    return;
  }

  if (value) {
    Promise.resolve(window.relaiPulse?.setExpanded?.(true))
      .then(() => {
        if (!expanded) {
          Promise.resolve(window.relaiPulse?.setExpanded?.(false)).catch(() => {});
          return;
        }
        startExpandMorph();
      })
      .catch(() => {
        expanded = false;
        applyExpandedAccessibility(false);
      });
    return;
  }

  startCollapseMorph();
}

function startExpandMorph() {
  applyExpandedLayout(true);
  shell.dataset.collapsing = 'false';
  if (prefersReducedMotion() || !canAnimateMorph()) return;
  startMorph([
    { opacity: 0, transform: 'translateY(-5px) scale(.985)' },
    { opacity: 1, transform: 'translateY(0) scale(1)' }
  ], 'expand');
}

function startCollapseMorph() {
  if (shell.dataset.expanded !== 'true') {
    applyExpandedLayout(false);
    Promise.resolve(window.relaiPulse?.setExpanded?.(false)).catch(() => {});
    return;
  }
  shell.dataset.collapsing = 'true';
  if (prefersReducedMotion() || !canAnimateMorph()) {
    finishCollapsedLayout();
    return;
  }
  startMorph([
    { opacity: 1, transform: 'translateY(0) scale(1)' },
    { opacity: 0, transform: 'translateY(-5px) scale(.985)' }
  ], 'collapse');
}

function startMorph(keyframes, direction) {
  morphAnimation?.cancel();
  morphDirection = direction;
  const animation = shell.animate(keyframes, {
    duration: PULSE_TRANSITION_MS,
    easing: PULSE_EASING,
    fill: 'both'
  });
  morphAnimation = animation;
  scheduleMorphCompletion(animation);
  void animation.finished.then(() => finishMorph(animation), () => {});
  animation.addEventListener('cancel', () => {
    if (morphAnimation === animation) {
      clearMorphCompletionTimer();
      morphAnimation = null;
      morphDirection = '';
    }
  }, { once: true });
}

function scheduleMorphCompletion(animation) {
  clearMorphCompletionTimer();
  morphCompletionTimer = window.setTimeout(() => finishMorph(animation), PULSE_TRANSITION_MS + 24);
}

function clearMorphCompletionTimer() {
  if (morphCompletionTimer === null) return;
  window.clearTimeout(morphCompletionTimer);
  morphCompletionTimer = null;
}

function finishMorph(animation) {
  if (morphAnimation !== animation) return;
  const direction = morphDirection;
  clearMorphCompletionTimer();
  morphAnimation = null;
  morphDirection = '';
  if (direction === 'collapse' && !expanded) {
    applyExpandedLayout(false);
    animation.cancel();
    finishCollapsedLayout();
    return;
  }
  animation.cancel();
  shell.dataset.collapsing = 'false';
  if (!expanded) startCollapseMorph();
}

function finishCollapsedLayout() {
  applyExpandedLayout(false);
  shell.dataset.collapsing = 'false';
  Promise.resolve(window.relaiPulse?.setExpanded?.(false)).catch(() => {});
}

function resetExpandedFromHost() {
  const animation = morphAnimation;
  clearMorphCompletionTimer();
  morphAnimation = null;
  morphDirection = '';
  animation?.cancel();
  expanded = false;
  applyExpandedAccessibility(false);
  applyExpandedLayout(false);
  shell.dataset.collapsing = 'false';
}

function applyExpandedAccessibility(value) {
  toggle.setAttribute('aria-expanded', String(value));
  toggle.setAttribute('aria-label', value ? 'Hide activity details' : 'Show activity details');
  island.setAttribute('aria-hidden', String(!value));
  if (value) island.removeAttribute('inert');
  else island.setAttribute('inert', '');
  openButton.tabIndex = value ? 0 : -1;
  compactCopy?.setAttribute('aria-expanded', String(value));
  compactCopy?.setAttribute('aria-label', value ? 'Hide activity details' : 'Show activity details');
}

function applyExpandedLayout(value) {
  shell.dataset.expanded = String(value);
  if (value === true && document.activeElement === compactCopy) toggle.focus();
  else if (value === false && island.contains(document.activeElement)) toggle.focus();
}

function canAnimateMorph() {
  return typeof shell.animate === 'function';
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

document.querySelector('.pulse-bar')?.addEventListener('click', event => {
  if (!expanded && !event.target.closest('button')) setExpanded(true);
});
document.getElementById('pulseCompactCopy')?.addEventListener('click', event => {
  event.stopPropagation();
  setExpanded(!expanded);
});
toggle.addEventListener('click', event => {
  event.stopPropagation();
  setExpanded(!expanded);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && expanded) {
    setExpanded(false);
    toggle.focus();
  }
});
openButton.addEventListener('click', () => {
  Promise.resolve(window.relaiPulse?.openDashboard?.()).catch(() => {});
});
let elapsedTimer = null;
function startElapsedTimer() {
  if (elapsedTimer != null || document.visibilityState === 'hidden') return;
  tickElapsed();
  elapsedTimer = window.setInterval(tickElapsed, 1000);
}
function stopElapsedTimer() {
  if (elapsedTimer == null) return;
  window.clearInterval(elapsedTimer);
  elapsedTimer = null;
}
function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    stopElapsedTimer();
    stopWorkingHeartbeat();
    return;
  }
  startElapsedTimer();
  syncWorkingHeartbeat();
}
document.addEventListener('visibilitychange', handleVisibilityChange);
startElapsedTimer();
window.relaiPulse?.onState?.(updatePulse);
