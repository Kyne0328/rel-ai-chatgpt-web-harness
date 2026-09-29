import { formatDuration, timeAgo } from './utils.js';

const CLOCK_SELECTOR = '[data-clock-elapsed-start], [data-clock-relative]';
const CLOCK_ATTRIBUTE_FILTER = Object.freeze(['data-clock-elapsed-start', 'data-clock-elapsed-end', 'data-clock-relative']);

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

  function tick() {
    const currentTime = now();
    updateRegistered(
      liveElapsedNodes,
      updateElapsedNode,
      currentTime,
      node => node.hasAttribute('data-clock-elapsed-start') && !node.hasAttribute('data-clock-elapsed-end')
    );
    updateRegistered(relativeNodes, updateRelativeNode, currentTime, node => node.hasAttribute('data-clock-relative'));
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
    tick();
    startTimer();
  }

  function start() {
    if (!stopped) return api;
    stopped = false;
    documentRef.addEventListener?.('visibilitychange', handleVisibility);
    const currentTime = now();
    observe(documentRef);
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
