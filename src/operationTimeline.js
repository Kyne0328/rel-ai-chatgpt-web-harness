// One bounded timeline per invocation. Observability never changes execution policy.
const PHASES = new Set(['accepted', 'queued', 'admitted', 'preparing', 'running', 'host-queued', 'spawned', 'exited', 'draining-output', 'drained', 'reconciling', 'persisting', 'result-ready', 'delivered']);
const MAX_PHASES = 24;

function createOperationTimeline(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const started = finiteTime(options.acceptedAtMs, now());
  const state = {
    phase: 'accepted', phaseStartedAt: iso(started), lastProgressAt: iso(started),
    phases: [{ phase: 'accepted', startedAt: iso(started), durationMs: 0 }],
    deadlineKind: options.deadlineKind || 'admission', executed: false,
    terminationCertainty: 'not-started'
  };
  let settled = false;

  function snapshot() {
    const phases = state.phases.map(item => ({ ...item }));
    const current = phases.at(-1);
    if (current && !current.endedAt) current.durationMs = Math.max(0, now() - Date.parse(current.startedAt));
    return { ...state, phases, ...(state.blocking ? { blocking: { ...state.blocking } } : {}) };
  }

  function notify() {
    try { options.onUpdate?.(snapshot()); } catch { /* Diagnostics cannot fail work. */ }
  }

  function transition(phase, details = {}) {
    if (settled || !PHASES.has(phase)) return snapshot();
    const at = finiteTime(details.atMs, now());
    if (state.phase !== phase) {
      const previous = state.phases.at(-1);
      if (previous) {
        previous.endedAt = iso(at);
        previous.durationMs = Math.max(0, at - Date.parse(previous.startedAt));
      }
      state.phase = phase;
      state.phaseStartedAt = iso(at);
      if (state.phases.length < MAX_PHASES) state.phases.push({ phase, startedAt: iso(at), durationMs: 0 });
      else state.phasesTruncated = true;
    }
    state.lastProgressAt = iso(at);
    if (details.executed === true) {
      state.executed = true;
      if (state.terminationCertainty === 'not-started') state.terminationCertainty = 'unknown';
    }
    if (typeof details.terminationConfirmed === 'boolean') state.terminationCertainty = details.terminationConfirmed ? 'confirmed' : 'unconfirmed';
    if (phase === 'exited') state.childExitedAt = iso(at);
    if (details.deadlineKind) state.deadlineKind = String(details.deadlineKind);
    if (details.outputFinalizationTimedOut === true) state.outputFinalizationTimedOut = true;
    if (details.blocking && typeof details.blocking === 'object') {
      state.blocking = Object.fromEntries(['owner', 'operationId', 'taskId'].filter(key => details.blocking[key]).map(key => [key, String(details.blocking[key]).slice(0, 200)]));
    } else if (phase !== 'queued' && phase !== 'host-queued') delete state.blocking;
    if (Number.isFinite(details.queuePosition)) state.queuePosition = Math.max(0, Math.floor(details.queuePosition));
    else if (phase !== 'queued' && phase !== 'host-queued') delete state.queuePosition;
    if (Number.isFinite(details.queueWaitMs)) state.queueWaitMs = Math.max(0, details.queueWaitMs);
    notify();
    return snapshot();
  }

  function finish(details = {}) {
    if (!settled) {
      const at = now();
      const current = state.phases.at(-1);
      if (current) { current.endedAt = iso(at); current.durationMs = Math.max(0, at - Date.parse(current.startedAt)); }
      state.lastProgressAt = iso(at);
      if (details.errorCode) state.errorCode = String(details.errorCode).slice(0, 100);
      settled = true;
      notify();
    }
    return snapshot();
  }
  return { transition, snapshot, finish };
}

function finiteTime(value, fallback) { return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback; }
function iso(value) { return new Date(value).toISOString(); }

export { createOperationTimeline };
