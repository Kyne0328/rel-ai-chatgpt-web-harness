import {
  GOAL_CONTINUATION_DELAY_MS,
  GOAL_MODE_RESOURCE_MIME_TYPE,
  GOAL_MODE_RESOURCE_URI,
  GOAL_UI_PROTOCOL_VERSION
} from './goalModeContract.js';

function goalModeAppHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rel.AI Goal mode</title>
<style>
  :root { color-scheme: light dark; font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 10px; background: transparent; color: CanvasText; }
  main { max-width: 520px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 12px; padding: 12px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  strong { font-size: 14px; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, CanvasText 9%, transparent); }
  #objective { margin: 8px 0 4px; overflow-wrap: anywhere; }
  #status { margin: 0; opacity: .72; }
  button { margin-top: 10px; font: inherit; font-weight: 600; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 8px; padding: 6px 10px; background: Canvas; color: CanvasText; cursor: pointer; }
  button:disabled { cursor: default; opacity: .5; }
</style>
</head>
<body hidden>
<main>
  <header><strong>Rel.AI Goal mode</strong><span class="badge" id="badge">Active</span></header>
  <p id="objective">Goal in progress</p>
  <p id="status">Automatic continuation is armed.</p>
  <button id="continue" type="button">Continue now</button>
</main>
<script>
(() => {
  'use strict';

  const PROTOCOL_VERSION = ${JSON.stringify(GOAL_UI_PROTOCOL_VERSION)};
  const CONTINUATION_DELAY_MS = ${GOAL_CONTINUATION_DELAY_MS};
  const REQUEST_TIMEOUT_MS = 15000;
  const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
  const pending = new Map();
  let nextId = 1;
  let initialized = false;
  let hostCapabilities = {};
  let toolInput = {};
  let goalMode = false;
  let goalCompleted = false;
  let workId = '';
  let objective = '';
  let taskStatus = '';
  let continuationTimer = null;
  let continuationInFlight = false;

  const statusNode = document.getElementById('status');
  const objectiveNode = document.getElementById('objective');
  const badgeNode = document.getElementById('badge');
  const continueButton = document.getElementById('continue');

  function post(message) {
    window.parent.postMessage(message, '*');
  }

  function notify(method, params) {
    post({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      post({ jsonrpc: '2.0', id, method, params });
    });
  }

  function settleResponse(message) {
    if (message.id === undefined || !pending.has(message.id)) return false;
    const entry = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.error) entry.reject(new Error(String(message.error.message || 'Host rejected request')));
    else entry.resolve(message.result);
    return true;
  }

  function structuredContentOf(value) {
    if (!value || typeof value !== 'object') return {};
    if (value.structuredContent && typeof value.structuredContent === 'object') return value.structuredContent;
    return value;
  }

  function goalStateOf(value) {
    const payload = structuredContentOf(value);
    const task = payload.task && typeof payload.task === 'object' ? payload.task : {};
    const isGoal = payload.mode === 'goal'
      || payload.goalMode === true
      || task.mode === 'goal'
      || task.goalMode === true
      || Object.prototype.hasOwnProperty.call(payload, 'goal_completed')
      || Object.prototype.hasOwnProperty.call(task, 'goal_completed');
    return {
      isGoal,
      workId: String(payload.work_id || task.work_id || workId || '').trim(),
      completed: payload.goal_completed === true || task.goal_completed === true,
      status: String(payload.status || task.status || '').trim(),
      objective: String(payload.objective || task.goal || objective || '').trim()
    };
  }

  function ingest(value) {
    const state = goalStateOf(value);
    if (!state.isGoal && toolInput.mode !== 'goal') return;
    goalMode = true;
    if (state.workId) workId = state.workId;
    if (state.objective) objective = state.objective;
    if (state.status) taskStatus = state.status;
    goalCompleted = state.completed;
    render();
    scheduleContinuation();
  }

  function storageKey() {
    return workId ? 'relai.goal.continuation.' + workId : '';
  }

  function lastContinuationAt() {
    try {
      const value = Number(localStorage.getItem(storageKey()) || 0);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function claimContinuation() {
    const key = storageKey();
    if (!key) return 0;
    const claimedAt = Date.now();
    try {
      const previous = Number(localStorage.getItem(key) || 0);
      if (Number.isFinite(previous) && previous > 0 && claimedAt - previous < CONTINUATION_DELAY_MS - 1000) return 0;
      localStorage.setItem(key, String(claimedAt));
      return Number(localStorage.getItem(key) || 0) === claimedAt ? claimedAt : 0;
    } catch {
      return claimedAt;
    }
  }

  function releaseContinuationClaim(claimedAt) {
    const key = storageKey();
    if (!key || !claimedAt) return;
    try {
      if (Number(localStorage.getItem(key) || 0) === claimedAt) localStorage.removeItem(key);
    } catch {}
  }

  function isTerminal() {
    return goalCompleted || TERMINAL.has(taskStatus);
  }

  function canSendTextMessage() {
    return Boolean(hostCapabilities.message && hostCapabilities.message.text);
  }

  function canSafelyContinue() {
    return canSendTextMessage() && Boolean(hostCapabilities.serverTools);
  }

  function render(message) {
    if (!goalMode) {
      document.body.hidden = true;
      return;
    }
    document.body.hidden = false;
    objectiveNode.textContent = objective || 'Goal in progress';
    if (goalCompleted || taskStatus === 'completed') {
      badgeNode.textContent = 'Complete';
      statusNode.textContent = 'goal_completed is true. Automatic continuation stopped.';
      continueButton.disabled = true;
      return;
    }
    if (taskStatus === 'cancelled' || taskStatus === 'failed') {
      badgeNode.textContent = taskStatus === 'cancelled' ? 'Cancelled' : 'Failed';
      statusNode.textContent = 'This Goal session is terminal. Automatic continuation stopped.';
      continueButton.disabled = true;
      return;
    }
    badgeNode.textContent = 'Active';
    continueButton.disabled = continuationInFlight;
    if (message) statusNode.textContent = message;
    else if (!initialized) statusNode.textContent = 'Connecting Goal continuation…';
    else if (!canSafelyContinue()) statusNode.textContent = 'This ChatGPT host does not advertise the messaging and server-tool capabilities required for safe automatic continuation.';
    else statusNode.textContent = 'Automatic continuation is armed before the ChatGPT turn limit.';
  }

  function scheduleContinuation() {
    if (continuationTimer) clearTimeout(continuationTimer);
    continuationTimer = null;
    if (!goalMode || !workId || isTerminal()) return;
    const last = lastContinuationAt();
    const dueAt = last ? last + CONTINUATION_DELAY_MS : Date.now() + CONTINUATION_DELAY_MS;
    const delay = Math.max(1000, dueAt - Date.now());
    continuationTimer = setTimeout(() => {
      continuationTimer = null;
      void continueGoal(false);
    }, delay);
  }

  async function refreshGoalState() {
    if (!hostCapabilities.serverTools || !workId) throw new Error('Safe Goal continuation requires serverTools');
    const result = await request('tools/call', {
      name: 'relai_work',
      arguments: { action: 'status', work_id: workId }
    });
    ingest(result);
  }

  async function continueGoal(manual) {
    if (!goalMode || !workId || isTerminal() || continuationInFlight) return;
    if (!manual) {
      const last = lastContinuationAt();
      if (last && Date.now() - last < CONTINUATION_DELAY_MS - 1000) {
        scheduleContinuation();
        return;
      }
    }
    if (!initialized || !canSafelyContinue()) {
      render('Automatic continuation is unavailable in this ChatGPT host.');
      return;
    }

    const claimedAt = claimContinuation();
    if (!claimedAt) {
      scheduleContinuation();
      return;
    }

    continuationInFlight = true;
    render('Checking Goal state before continuation…');
    try {
      await refreshGoalState();
      if (isTerminal()) {
        render();
        return;
      }
      const result = await request('ui/message', {
        role: 'user',
        content: [{
          type: 'text',
          text: 'Continue Rel.AI Goal work ' + workId + '. Call relai_work status first, keep using this same work_id, and continue working until goal_completed is true. Do not start a new work session.'
        }]
      });
      if (result && result.isError === true) throw new Error('ChatGPT rejected the continuation message');
      render('Continuation requested. Rel.AI will re-check this Goal before the next handoff.');
    } catch (error) {
      releaseContinuationClaim(claimedAt);
      render('Automatic continuation failed: ' + String(error && error.message ? error.message : error));
    } finally {
      continuationInFlight = false;
      continueButton.disabled = false;
      scheduleContinuation();
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (settleResponse(message)) return;
    if (message.method === 'ui/notifications/tool-input') {
      toolInput = message.params && message.params.arguments && typeof message.params.arguments === 'object'
        ? message.params.arguments
        : {};
      if (toolInput.mode === 'goal') {
        goalMode = true;
        if (toolInput.work_id) workId = String(toolInput.work_id);
        if (toolInput.objective) objective = String(toolInput.objective);
        render();
      }
      return;
    }
    if (message.method === 'ui/notifications/tool-result') ingest(message.params || {});
  });

  continueButton.addEventListener('click', () => void continueGoal(true));

  render();
  request('ui/initialize', {
    appInfo: { name: 'Rel.AI Goal Continuation', version: '1.0.0' },
    appCapabilities: {},
    protocolVersion: PROTOCOL_VERSION
  }).then(result => {
    hostCapabilities = result && result.hostCapabilities && typeof result.hostCapabilities === 'object'
      ? result.hostCapabilities
      : {};
    initialized = true;
    notify('ui/notifications/initialized', {});
    render();
    scheduleContinuation();
  }).catch(error => {
    render('Goal continuation could not initialize: ' + String(error && error.message ? error.message : error));
  });
})();
</script>
</body>
</html>`;
}

function readGoalModeResource(uri = GOAL_MODE_RESOURCE_URI) {
  if (String(uri) !== GOAL_MODE_RESOURCE_URI) throw new Error('Unknown Goal mode UI resource.');
  return {
    contents: [{
      uri: GOAL_MODE_RESOURCE_URI,
      mimeType: GOAL_MODE_RESOURCE_MIME_TYPE,
      text: goalModeAppHtml()
    }]
  };
}

export { goalModeAppHtml, readGoalModeResource };
