import { activityEventId } from '../../activity-event.js';
import { eventTimestampMs, eventTimestampValue, terminalTaskTimestampValue, timestampMs } from '../../../taskEvents.js';
import { buildTaskSemanticProgress, classifyTaskChangedFiles } from '../../../taskSemanticProgress.js';
import { workSessionStateView } from '../../task-identity.js';

export function sessionsForDisplay(data = {}, workspace = '') {
  return orderSessionsForDisplay((Array.isArray(data?.tasks) ? data.tasks : [])
    .filter(session => !workspace || session.workspace === workspace));
}

export function sessionSummary(sessions = []) {
  const counts = sessions.reduce((summary, session) => {
    const state = workSessionStateView(session);
    if (state.active) summary.active += 1;
    else if (state.open) summary.open += 1;
    else if (['waiting_for_approval', 'blocked', 'validation_failed'].includes(state.status)) summary.attention += 1;
    else if (state.status === 'inactive') summary.inactive += 1;
    else if (state.status === 'completed') summary.completed += 1;
    else if (state.status === 'cancelled') summary.cancelled += 1;
    else if (state.status === 'failed') summary.failed += 1;
    else summary.other += 1;
    return summary;
  }, { active: 0, open: 0, attention: 0, inactive: 0, completed: 0, cancelled: 0, failed: 0, other: 0 });

  const parts = [`${counts.active} active`, `${counts.open} waiting`];
  if (counts.attention) parts.push(`${counts.attention} need attention`);
  if (counts.inactive) parts.push(`${counts.inactive} inactive`);
  parts.push(`${counts.completed} completed`);
  if (counts.cancelled) parts.push(`${counts.cancelled} cancelled`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  if (counts.other) parts.push(`${counts.other} other`);
  return parts.join(' · ');
}

export function sessionCountLabel(sessions = [], workspace = '') {
  return `${sessions.length} task${sessions.length === 1 ? '' : 's'}${workspace ? ` in ${workspace}` : ''}`;
}

export function sessionIdentifier(session = {}) {
  return String(session.id || session.taskId || session.work_id || '').trim();
}

export function isOngoingSession(session = {}) {
  const state = workSessionStateView(session);
  return state.active === true || state.open === true;
}

export function orderSessionsForDisplay(sessions = []) {
  return [...(Array.isArray(sessions) ? sessions : [])].sort((left, right) => {
    const leftOngoing = isOngoingSession(left);
    const rightOngoing = isOngoingSession(right);
    const ongoingDifference = Number(rightOngoing) - Number(leftOngoing);
    if (ongoingDifference) return ongoingDifference;
    const timestampDifference = leftOngoing && rightOngoing
      ? sessionStartTimestamp(right) - sessionStartTimestamp(left)
      : timestampMs(sessionListTimestampValue(right)) - timestampMs(sessionListTimestampValue(left));
    if (timestampDifference) return timestampDifference;
    return sessionIdentifier(left).localeCompare(sessionIdentifier(right), 'en-US', { numeric: true, sensitivity: 'base' });
  });
}

export function sessionListTimestampValue(session = {}) {
  if (String(session.status || '').toLowerCase() === 'inactive' && session.inactiveAt) return session.inactiveAt;
  return terminalTaskTimestampValue(session);
}

export function sessionDurationMs(session = {}, now = Date.now()) {
  const explicit = Number(session?.durationMs);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const start = Date.parse(String(session?.startedAt || session?.createdAt || ''));
  if (!Number.isFinite(start)) return 0;
  const endValue = terminalTaskTimestampValue(session);
  const parsedEnd = Date.parse(String(endValue || ''));
  const end = Number.isFinite(parsedEnd) ? parsedEnd : now;
  return Math.max(0, end - start);
}

export function semanticProgressFor(session = {}, options = {}) {
  if (Array.isArray(session.events) && session.events.length) return buildTaskSemanticProgress(session, options);
  if (session.semanticProgress && typeof session.semanticProgress === 'object') return session.semanticProgress;
  return buildTaskSemanticProgress(session, options);
}

export function semanticFileCounts(session = {}, semantic = semanticProgressFor(session)) {
  const classified = classifyTaskChangedFiles(session.changedFiles || []);
  const product = Number.isFinite(Number(semantic?.productChangedFileCount))
    ? Math.max(0, Number(semantic.productChangedFileCount))
    : classified.productChangedFileCount;
  const support = Number.isFinite(Number(semantic?.supportArtifactCount))
    ? Math.max(0, Number(semantic.supportArtifactCount))
    : classified.supportArtifactCount;
  return { product, support };
}

function sessionChangedFileCount(session = {}) {
  return Math.max(0, Number(session.changedFileCount || 0), orderChangedFiles(session.changedFiles || []).length);
}

export function sessionDescription(session = {}, live = isOngoingSession(session), operation = '', semantic = semanticProgressFor(session)) {
  if (live) return semantic.currentActivity || semantic.currentStage || operation || 'Task is waiting';
  if (session.summary) return session.summary;
  if (session.status === 'validation_failed') return 'Checks failed';
  if (session.status === 'blocked') return session.endReason || workSessionStateView(session).label;
  if (session.status === 'cancelled') return 'Cancelled before completion';
  return semantic.currentActivity || session.currentActivity || session.currentStage || operation || 'Task ended';
}

export function sessionNeedsAttention(session = {}) {
  if (workSessionStateView(session).status === 'completed') return false;
  return session.validation === 'failed'
    || ['failed', 'validation_failed', 'blocked'].includes(String(session.status || ''));
}

export function mergeSessionDetail(previous = {}, summary = {}, data = {}) {
  const changedFiles = orderChangedFiles([...(previous.changedFiles || []), ...(summary?.changedFiles || [])]);
  const taskId = sessionIdentifier(summary) || sessionIdentifier(previous);
  const liveEvents = (Array.isArray(data?.auditTail?.entries) ? data.auditTail.entries : [])
    .filter(event => String(event?.taskId || event?.sessionId || '').trim() === taskId);
  const events = mergeSessionEvents(previous.events || [], liveEvents);
  return {
    ...previous,
    ...(summary || {}),
    trace: summary?.trace || previous.trace,
    changedFiles,
    changedFileCount: Math.max(sessionChangedFileCount(previous), sessionChangedFileCount(summary), changedFiles.length),
    events
  };
}

export function mergeSessionEvents(existing = [], updates = []) {
  const byId = new Map();
  for (const event of [...existing, ...updates]) {
    const id = sessionEventIdentity(event);
    byId.set(id, { ...(byId.get(id) || {}), ...event });
  }
  return orderSessionEvents([...byId.values()]);
}

function sessionEventIdentity(event = {}) {
  return String(
    event.eventId
    || event.operationId
    || event.tool?.invocationId
    || event.id
    || activityEventId(event)
    || `${eventTimestampValue(event)}:${event.operation || event.tool || ''}`
  );
}

export function orderChangedFiles(files = []) {
  return [...new Set((Array.isArray(files) ? files : []).map(String).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en-US', { numeric: true, sensitivity: 'base' }));
}

export function orderSessionEvents(events = []) {
  return [...events].sort((left, right) => eventTimestampMs(right) - eventTimestampMs(left));
}

export function taskTraceJsonl(session = {}) {
  const entries = Array.isArray(session.trace?.entries) ? session.trace.entries : [];
  return entries.length ? `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n` : '';
}

export function operationForTool(tool) {
  const value = String(tool || '').replace(/^relai_/, '').replaceAll('_', ' ');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : 'Rel.AI activity';
}

function sessionStartTimestamp(session = {}) {
  for (const value of [session.startedAtIso, session.startedAt, session.createdAt, session.lastActivityAt, session.updatedAt]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
