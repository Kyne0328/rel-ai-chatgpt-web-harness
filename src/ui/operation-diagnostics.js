// Presentation only: missing instrumentation is unknown, never a lifecycle decision.
const PHASE_LABELS = Object.freeze({
  accepted: 'Accepted', queued: 'Waiting for admission', admitted: 'Admitted',
  preparing: 'Preparing', running: 'Executing action', 'host-queued': 'Waiting for host capacity', spawned: 'Command running', exited: 'Command exited',
  'draining-output': 'Collecting output', drained: 'Output collected', reconciling: 'Reconciling changes',
  persisting: 'Saving result', 'result-ready': 'Result ready', delivered: 'Result acknowledged'
});
const TERMINAL_STATUSES = new Set(['completed', 'complete', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled']);

export function operationDiagnostics(operation = {}, now = Date.now()) {
  operation = operation || {};
  const timeline = operation.metadata?.timeline || operation.activity?.metadata?.timeline || operation.timeline || operation.result?.timeline || {};
  const phase = text(timeline.phase);
  const status = text(operation.status).toLowerCase();
  const terminal = TERMINAL_STATUSES.has(status) || ['result-ready', 'delivered'].includes(phase);
  const blocking = timeline.blocking || {};
  const owner = text(blocking.owner) || text(blocking.owner?.label) || text(blocking.owner?.id);
  const blockingOperationId = text(blocking.operationId);
  const blockingTaskId = text(blocking.taskId);
  const hasOwner = Boolean(owner || blockingOperationId || blockingTaskId);
  const childExitedAt = timestamp(timeline.childExitedAt);
  const phaseStartedAt = timestamp(timeline.phaseStartedAt);
  const lastProgressAt = timestamp(timeline.lastProgressAt);
  const executed = typeof timeline.executed === 'boolean' ? timeline.executed : null;
  const terminationCertainty = ['not-started', 'unknown', 'confirmed', 'unconfirmed'].includes(timeline.terminationCertainty)
    ? timeline.terminationCertainty : 'unknown';
  let title = 'Operation phase unknown';
  let detail = 'This record does not include phase diagnostics.';
  if (phase === 'result-ready' || phase === 'delivered') {
    title = operation.resultAvailable === false ? 'Result unavailable' : 'Result ready';
    detail = operation.resultAvailable === false
      ? 'The retained result is unavailable. Reconcile existing artifacts; absence does not prove the action never ran.'
      : phase === 'delivered' ? 'Receipt acknowledged.' : 'Retrieve the existing operation result; do not run the action again.';
  } else if (terminal) {
    title = executed === false ? 'Stopped before execution' : 'Operation ended';
    detail = 'Inspect the recorded outcome and retained result for this operation.';
  } else if (phase === 'queued' || phase === 'host-queued') {
    title = hasOwner ? 'Waiting for this owner' : phase === 'host-queued' ? 'Waiting for host capacity' : 'Waiting for admission';
    detail = hasOwner ? 'Another operation owns the required resource.' : 'The blocking owner was not recorded.';
  } else if (['exited', 'draining-output', 'drained'].includes(phase) || (childExitedAt !== null && ['reconciling', 'persisting'].includes(phase))) {
    title = 'Command exited, collecting result';
    detail = 'Output collection, change reconciliation, or result storage is still in progress.';
  } else if (['reconciling', 'persisting'].includes(phase)) {
    title = 'Collecting result';
    detail = 'The current stage is recorded; child exit timing is unknown.';
  } else if (phase === 'running') {
    title = 'Executing action';
    detail = 'The handler has started; a child process may not be required.';
  } else if (phase === 'spawned') {
    title = 'Command running';
    detail = 'Execution has started; no command exit has been recorded.';
  } else if (['accepted', 'admitted', 'preparing'].includes(phase)) {
    title = PHASE_LABELS[phase];
    detail = executed === false ? 'Execution has not started.' : 'The operation is preparing its next stage.';
  }
  // An uncertain process tree remains unsafe even after a command/result settles.
  const warning = [
    terminationCertainty === 'unconfirmed'
      ? 'Process termination is unconfirmed. Keep ownership protections in place; do not resubmit a mutation.' : '',
    timeline.outputFinalizationTimedOut === true
      ? 'Output collection reached its deadline. The retained result may contain incomplete output.' : ''
  ].filter(Boolean).join(' ');
  const phases = (Array.isArray(timeline.phases) ? timeline.phases : [])
    .filter(item => item && Object.hasOwn(PHASE_LABELS, item.phase))
    .slice(-24)
    .map(item => {
      const startedAt = timestamp(item.startedAt);
      const endedAt = timestamp(item.endedAt);
      const durationMs = measuredDuration(item.durationMs)
        ?? (startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null);
      return { phase: item.phase, label: PHASE_LABELS[item.phase], startedAt, endedAt, durationMs };
    });
  const currentElapsedMs = !terminal && phaseStartedAt !== null && Number.isFinite(now) && now >= phaseStartedAt
    ? now - phaseStartedAt : null;
  return {
    phase, phaseLabel: PHASE_LABELS[phase] || 'Unknown', title, detail, warning, terminal,
    operationId: text(operation.operationId || operation.id || operation.invocationId),
    owner, blockingOperationId, blockingTaskId,
    queuePosition: Number.isInteger(timeline.queuePosition) && timeline.queuePosition >= 0 ? timeline.queuePosition : null,
    deadlineKind: ['operation', 'admission'].includes(timeline.deadlineKind) ? timeline.deadlineKind : 'unknown',
    executed, terminationCertainty, childExitedAt, phaseStartedAt, lastProgressAt, currentElapsedMs, phases, phasesTruncated: timeline.phasesTruncated === true
  };
}

export function runtimeBuildDiagnostics(runtime = {}, compatibility = {}) {
  const identity = runtime?.buildIdentity || {};
  const parity = compatibility?.sourceParity || {};
  // A parity claim must carry explicit verification, independent of release metadata.
  const sourceParity = parity.status === 'different' ? 'Different'
    : parity.status === 'matches' && parity.verified === true
      ? (parity.cached === true ? 'Matches last measured snapshot' : 'Verified match') : 'Unknown';
  const metadataMatches = compatibility?.releaseMetadataMatches ?? compatibility?.metadataMatches;
  return {
    buildId: text(identity.buildId) || 'Unknown',
    facts: [
      ['Source revision', text(identity.sourceRevision) || 'Unknown'],
      ['Dirty source', typeof identity.dirty === 'boolean' ? (identity.dirty ? 'Yes' : 'No') : 'Unknown'],
      ['Source fingerprint', text(identity.sourceFingerprint) || 'Unknown'],
      ['Built at', diagnosticTime(identity.builtAt)],
      ['Runtime started', diagnosticTime(identity.startedAt)],
      ['Schema digest', text(identity.schemaDigest) || 'Unknown'],
      ['Release metadata', typeof metadataMatches === 'boolean' ? (metadataMatches ? 'Matches' : 'Different') : 'Unknown'],
      ['Source/build parity', sourceParity],
      ['Parity checked', diagnosticTime(parity.checkedAt)]
    ],
    parityReason: text(parity.reason) || 'Release compatibility alone does not prove which implementation is running.'
  };
}

export function diagnosticDuration(value) {
  const duration = measuredDuration(value);
  if (duration === null) return 'Unknown';
  if (duration < 1000) return `${Math.round(duration)} ms`;
  if (duration < 60_000) return `${(duration / 1000).toFixed(2)} s`;
  return `${Math.floor(duration / 60_000)}m ${((duration % 60_000) / 1000).toFixed(1)}s`;
}

export function diagnosticTime(value) {
  const time = timestamp(value);
  return time === null ? 'Unknown' : new Date(time).toISOString();
}

function measuredDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const time = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : Date.parse(String(value));
  return Number.isFinite(time) && time >= 0 && time <= 8.64e15 ? time : null;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
