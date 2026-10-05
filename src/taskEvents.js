

const TASK_RUNTIME_EVENT_PHASES = Object.freeze([
  'started',
  'progress',
  'completion_requested',
  'finished',
  'cancelled',
  'inactive',
  'completed'
]);
const TASK_RUNTIME_TERMINAL_PHASES = Object.freeze(['completed', 'cancelled', 'inactive']);

function cleanTaskId(value) {
  return String(value || '').trim();
}

function isCurrentTaskEvent(event) {
  return Boolean(
    event
    && typeof event === 'object'
    && cleanTaskId(event.taskId)
    && Number(event.taskIdentityVersion || 0) >= 2
    && event.taskIdExplicit === true
    && event.taskHistoryEligible !== false
    && event.eventType !== 'task.start.rejected'
  );
}

function operationForTool(tool, fallback = 'Rel.AI activity') {
  const value = String(tool || '').replace(/^relai_/, '').replaceAll('_', ' ');
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : fallback;
}

function unique(values) {
  return [...new Set(values)];
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  const timestamp = timestampMs(value);
  return timestamp ? new Date(timestamp).toISOString() : '';
}

function eventTimestampValue(value = {}) {
  return value.timestamp || value.ts || value.at || value.createdAt || value.startedAt || '';
}

function eventTimestampMs(value = {}) {
  return timestampMs(eventTimestampValue(value));
}

function terminalTaskTimestampValue(value = {}) {
  return value.endedAt || value.completedAt || value.cancelledAt || value.inactiveAt || value.lastActivityAt || value.updatedAt || value.startedAt || value.createdAt || '';
}

function terminalTaskTimestamp(value = {}) {
  return timestampMs(terminalTaskTimestampValue(value));
}

function eventIdentityFields(event = {}, options = {}) {
  if (options.preferId === true && event.id != null && String(event.id)) {
    return ['persisted', String(event.id)];
  }
  return [
    event.ts || event.at || event.createdAt || '',
    event.tool || event.type || '',
    event.workspace || '',
    event.taskId || '',
    event.operationId || '',
    event.sessionId || '',
    event.path || event.filePath || '',
    event.operation || event.message || event.error || '',
    event.ms ?? '',
    event.ok === false ? 'error' : 'ok'
  ];
}

function eventIdentityAliases(event = {}) {
  return [...new Set([event.eventId, event.operationId, event.id, event.auditId]
    .filter(value => value != null && String(value) !== '').map(String))];
}

function eventIdentityKey(event = {}, index = 0, options = {}) {
  if (event.eventId) return String(event.eventId);
  if (options.preferId === true && event.id != null && String(event.id)) return String(event.id);
  if (event.operationId) return String(event.operationId);
  if (event.id != null && String(event.id)) return String(event.id);
  if (event.auditId) return String(event.auditId);
  return [
    eventTimestampValue(event),
    event.tool?.name || event.tool || event.type || '',
    event.workspace || '',
    event.taskId || '',
    event.sessionId || '',
    event.path || event.filePath || '',
    event.operation || event.title || event.message || event.error?.message || event.error || '',
    event.durationMs ?? event.ms ?? '',
    event.ok === false ? 'error' : 'ok',
    index
  ].join('|');
}

function eventTime(value) {
  return timestampMs(value?.endedAt || value?.completedAt || value?.ts || value?.startedAt || '');
}

export {
  TASK_RUNTIME_EVENT_PHASES,
  TASK_RUNTIME_TERMINAL_PHASES,
  clamp,
  cleanTaskId,
  eventIdentityAliases,
  eventIdentityFields,
  eventIdentityKey,
  eventTime,
  eventTimestampMs,
  eventTimestampValue,
  isCurrentTaskEvent,
  isoTimestamp,
  operationForTool,
  terminalTaskTimestamp,
  terminalTaskTimestampValue,
  timestampMs,
  unique
};
