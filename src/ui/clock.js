import { formatDuration, timeAgo } from './utils.js';

const CLOCK_SELECTOR = '[data-clock-elapsed-start], [data-clock-relative]';
const CLOCK_ATTRIBUTE_FILTER = Object.freeze(['data-clock-elapsed-start', 'data-clock-elapsed-end', 'data-clock-relative']);
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function parseClockTime(value) {
  if (value == null || value === '') return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
  return Date.parse(String(value));
}

export function elapsedAt(start, end, now = Date.now()) {
  const started = parseClockTime(start);
  if (!Number.isFinite(started)) return '';
  const completed = parseClockTime(end);
  const boundary = Number.isFinite(completed) ? completed : now;
  return formatDuration(Math.max(0, boundary - started), { live: !Number.isFinite(completed) });
}

function relativeRefreshAt(value, currentTime) {
  const timestamp = parseClockTime(value);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  const age = Math.max(0, currentTime - timestamp);
  if (age < HOUR_MS) return timestamp + (Math.floor(age / MINUTE_MS) + 1) * MINUTE_MS;
  if (age < DAY_MS) return timestamp + (Math.floor(age / HOUR_MS) + 1) * HOUR_MS;
  return timestamp + (Math.floor(age / DAY_MS) + 1) * DAY_MS;
}

export function createDashboardClock(options = {}) {
  const documentRef = options.documentRef || document;
  const windowRef = options.windowRef || window;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const intervalMs = Math.max(250, Number(options.intervalMs || 1000));
  const setIntervalFn = options.setIntervalFn || windowRef.setInterval.bind(windowRef);
  const clearIntervalFn = options.clearIntervalFn || windowRef.clearInterval.bind(windowRef);
  const MutationObserverRef = options.MutationObserverRef || windowRef.MutationObserver || globalThis.MutationObserver;
  const onTick = typeof options.onTick === 'function' ? options.onTick : null;
  const liveElapsedNodes = new Set();
  const relativeNodes = new Set();
  let observer = null;
  let timer = null;
  let stopped = true;
  let nextRelativeRefreshAt = Number.POSITIVE_INFINITY;

  function updateElapsedNode(node, currentTime) {
    const text = elapsedAt(
      node.getAttribute('data-clock-elapsed-start'),
      node.getAttribute('data-clock-elapsed-end'),
      currentTime
    );
    if (text && node.textContent !== text) node.textContent = text;
  }

  function updateRelativeNode(node, currentTime) {
    const text = timeAgo(node.getAttribute('data-clock-relative'), currentTime);
    if (text && node.textContent !== text) node.textContent = text;
  }

  function registerNode(node, currentTime) {
    if (!node?.hasAttribute) return;
    const hasElapsed = node.hasAttribute('data-clock-elapsed-start');
    const hasCompletedElapsed = hasElapsed && node.hasAttribute('data-clock-elapsed-end');
    if (hasElapsed) updateElapsedNode(node, currentTime);
    if (hasElapsed && !hasCompletedElapsed) liveElapsedNodes.add(node);
    else liveElapsedNodes.delete(node);

    if (node.hasAttribute('data-clock-relative')) {
      relativeNodes.add(node);
      updateRelativeNode(node, currentTime);
      nextRelativeRefreshAt = Math.min(
        nextRelativeRefreshAt,
        relativeRefreshAt(node.getAttribute('data-clock-relative'), currentTime)
      );
    } else {
      relativeNodes.delete(node);
    }
  }

  function observe(root = documentRef) {
    if (!root) return api;
    const currentTime = now();
    if (root.matches?.(CLOCK_SELECTOR)) registerNode(root, currentTime);
    for (const node of root.querySelectorAll?.(CLOCK_SELECTOR) || []) registerNode(node, currentTime);
    return api;
  }

  function updateRegistered(nodes, updater, currentTime, valid) {
    for (const node of nodes) {
      if (node?.isConnected === false || !valid(node)) {
        nodes.delete(node);
        continue;
      }
      updater(node, currentTime);
    }
  }

  function refreshRelativeSchedule(currentTime) {
    let next = Number.POSITIVE_INFINITY;
    for (const node of relativeNodes) {
      if (node?.isConnected === false || !node?.hasAttribute?.('data-clock-relative')) {
        relativeNodes.delete(node);
        continue;
      }
      next = Math.min(next, relativeRefreshAt(node.getAttribute('data-clock-relative'), currentTime));
    }
    if (!Number.isFinite(next) && typeof MutationObserverRef !== 'function') next = currentTime + MINUTE_MS;
    nextRelativeRefreshAt = next;
  }

  function tick(forceRelative = false) {
    const currentTime = now();
    updateRegistered(
      liveElapsedNodes,
      updateElapsedNode,
      currentTime,
      node => node.hasAttribute('data-clock-elapsed-start') && !node.hasAttribute('data-clock-elapsed-end')
    );
    if (forceRelative || currentTime >= nextRelativeRefreshAt) {
      updateRegistered(relativeNodes, updateRelativeNode, currentTime, node => node.hasAttribute('data-clock-relative'));
      refreshRelativeSchedule(currentTime);
    }
    onTick?.(currentTime);
  }

  function startObserver() {
    if (observer || typeof MutationObserverRef !== 'function') return;
    const target = documentRef.body || documentRef.documentElement;
    if (!target) return;
    observer = new MutationObserverRef(records => {
      const currentTime = now();
      for (const record of records) {
        if (record.type === 'attributes') registerNode(record.target, currentTime);
        for (const node of record.addedNodes || []) {
          if (node?.matches?.(CLOCK_SELECTOR)) registerNode(node, currentTime);
          for (const child of node?.querySelectorAll?.(CLOCK_SELECTOR) || []) registerNode(child, currentTime);
        }
      }
      refreshRelativeSchedule(currentTime);
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: CLOCK_ATTRIBUTE_FILTER
    });
  }

  function stopObserver() {
    observer?.disconnect?.();
    observer = null;
  }

  function startTimer() {
    if (timer != null || stopped || documentRef.visibilityState === 'hidden') return;
    timer = setIntervalFn(tick, intervalMs);
    timer?.unref?.();
  }

  function stopTimer() {
    if (timer == null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function handleVisibility() {
    if (documentRef.visibilityState === 'hidden') {
      stopTimer();
      return;
    }
    tick(true);
    startTimer();
  }

  function start() {
    if (!stopped) return api;
    stopped = false;
    documentRef.addEventListener?.('visibilitychange', handleVisibility);
    nextRelativeRefreshAt = Number.POSITIVE_INFINITY;
    const currentTime = now();
    observe(documentRef);
    refreshRelativeSchedule(currentTime);
    onTick?.(currentTime);
    startObserver();
    startTimer();
    return api;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    stopTimer();
    stopObserver();
    liveElapsedNodes.clear();
    relativeNodes.clear();
    documentRef.removeEventListener?.('visibilitychange', handleVisibility);
  }

  const api = { start, stop, tick, observe, isRunning: () => !stopped && timer != null };
  return api;
}
