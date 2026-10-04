import { eventTimestampMs, eventTimestampValue } from '../../../taskEvents.js';

const RANGE_MS = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000
};
const DISPLAY_TEXT_KEYS = ['summary', 'message', 'currentActivity', 'title', 'operation', 'path'];

export function sortActivityEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])]
    .filter(entry => entry && typeof entry === 'object')
    .sort((left, right) => eventTimestampMs(right) - eventTimestampMs(left));
}

export function replaceActivityHistory(entries) {
  return sortActivityEntries(entries);
}

export function mergeActivityEntries(current, incoming) {
  const currentEntries = Array.isArray(current) ? current : [];
  const incomingEntries = Array.isArray(incoming) ? incoming : [];
  if (incomingEntries.length === 0) return { entries: currentEntries, changed: false };

  const next = [...currentEntries];
  const indexByKey = new Map();
  for (let index = 0; index < next.length; index += 1) {
    const entry = next[index];
    if (entry && typeof entry === 'object') indexByKey.set(activityEntryKey(entry), index);
  }
  let changed = false;
  let orderChanged = false;
  for (const incomingEntry of incomingEntries) {
    if (!incomingEntry || typeof incomingEntry !== 'object') continue;
    const key = activityEntryKey(incomingEntry);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push(incomingEntry);
      changed = true;
      orderChanged = true;
      continue;
    }
    const existing = next[index];
    const merged = mergeActivityEntry(existing, incomingEntry);
    if (JSON.stringify(merged) === JSON.stringify(existing)) continue;
    next[index] = merged;
    changed = true;
    if (eventTimestampValue(merged) !== eventTimestampValue(existing)) orderChanged = true;
  }
  if (!changed) return { entries: currentEntries, changed: false };
  const ordered = orderChanged ? sortActivityEntries(next) : next;
  return { entries: ordered, changed: true };
}

export function activityMessage(entry) {
  for (const value of [
    entry?.summary,
    entry?.message,
    entry?.currentActivity,
    entry?.result?.outcome,
    entry?.error?.message,
    entry?.error,
    entry?.path,
    entry?.title,
    entry?.operation
  ]) {
    const text = displayText(value);
    if (text) return text;
  }
  return 'No additional details recorded.';
}

export function activitySessionView(entry, sessionIndex = new Map()) {
  const taskId = String(entry?.taskId || '').trim();
  const sessionId = String(entry?.sessionId || '').trim();
  const id = taskId || sessionId;
  const session = (taskId && sessionIndex?.get?.(taskId)) || (sessionId && sessionIndex?.get?.(sessionId)) || null;
  const shortId = id.slice(0, 8);
  return {
    id,
    title: session?.title || (shortId ? `Task ${shortId}` : 'Direct activity'),
    workspace: session?.workspace || entry?.workspace || '',
    shortId,
    linked: Boolean(session)
  };
}

export function activityStatusGroup(entry) {
  const status = String(entry?.status || '').trim().toLowerCase().replaceAll('-', '_');
  if (['succeeded', 'success', 'completed', 'complete', 'ok', 'ready'].includes(status)) return 'succeeded';
  if (['failed', 'failure', 'error', 'validation_failed'].includes(status)) return 'failed';
  if (status === 'blocked') return 'blocked';
  if (['cancelled', 'canceled', 'abandoned'].includes(status)) return 'cancelled';
  if (['queued', 'planning', 'running', 'working', 'validating', 'waiting', 'waiting_for_approval', 'settling', 'open', 'in_progress'].includes(status)) return 'active';
  if (entry?.ok === true) return 'succeeded';
  if (entry?.ok === false) return 'failed';
  return 'other';
}

export function activityFilterTransition(current = {}, draft = {}) {
  const filterState = {
    search: String(current.search || ''),
    timeRange: draft.timeRange || '1h',
    workspace: draft.workspace || '',
    tool: draft.tool || '',
    status: draft.status || '',
    task: String(current.task || '')
  };
  return {
    filterState,
    workspaceChanged: filterState.workspace !== String(current.workspace || '')
  };
}

export function filterActivityEntries(entries, filterState = {}, now = Date.now(), options = {}) {
  const rangeMs = RANGE_MS[filterState.timeRange];
  const requestedStatus = normalizeStatusFilter(filterState.status);
  const search = String(filterState.search || '').trim().toLowerCase();
  const source = options.sorted === true ? (Array.isArray(entries) ? entries : []) : sortActivityEntries(entries);
  return source.filter(entry => {
    if (rangeMs) {
      const timestamp = eventTimestampMs(entry);
      if (!timestamp || now - timestamp >= rangeMs) return false;
    }
    if (search) {
      const haystack = [
        entry.tool?.name || entry.tool,
        entry.type,
        entry.title,
        entry.operation,
        activityMessage(entry),
        entry.path,
        activityFileLocation(entry),
        entry.resourceUri,
        entry.workspace,
        entry.category,
        entry.status,
        typeof options.sessionTitle === 'function' ? options.sessionTitle(entry) : ''
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (filterState.workspace && entry.workspace !== filterState.workspace) return false;
    if (filterState.tool && (entry.tool?.name || entry.tool || entry.type) !== filterState.tool) return false;
    if (requestedStatus && activityStatusGroup(entry) !== requestedStatus) return false;
    if (filterState.task && entry.taskId !== filterState.task && entry.sessionId !== filterState.task) return false;
    return true;
  });
}

export function nextActivityExpiry(entries, filterState = {}, now = Date.now()) {
  const rangeMs = RANGE_MS[filterState.timeRange];
  if (!rangeMs) return Number.POSITIVE_INFINITY;
  let next = Number.POSITIVE_INFINITY;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const timestamp = eventTimestampMs(entry);
    const expiry = timestamp ? timestamp + rangeMs : 0;
    if (expiry > now && expiry < next) next = expiry;
  }
  return next;
}

export function parseActivityHistoryResponse(data) {
  if (data?.ok === false) {
    return {
      ok: false,
      entries: [],
      error: displayText(data.error?.message || data.error) || 'Activity history could not be loaded.',
      nextCursor: null,
      hasMore: false
    };
  }
  if (Array.isArray(data)) return { ok: true, entries: data, error: '', nextCursor: null, hasMore: false };
  if (data && Array.isArray(data.entries)) {
    return {
      ok: true,
      entries: data.entries,
      error: '',
      nextCursor: data.page?.nextCursor && typeof data.page.nextCursor === 'object' ? data.page.nextCursor : null,
      hasMore: data.page?.hasMore === true
    };
  }
  return { ok: false, entries: [], error: 'Activity history could not be loaded.', nextCursor: null, hasMore: false };
}

export function activityAbsoluteTime(entry) {
  const timestamp = eventTimestampMs(entry);
  return timestamp ? new Date(timestamp).toLocaleString() : 'Time unavailable';
}

export function activityDisplayAction(entry) {
  return displayText(entry?.title)
    || displayText(entry?.operation)
    || displayText(entry?.tool?.operation)
    || displayText(entry?.tool?.title)
    || activityToolLabel(entry?.tool?.name || entry?.tool || entry?.type);
}

export function activityToolLabel(tool) {
  const raw = displayText(typeof tool === 'object' ? tool?.name : tool);
  const label = raw.replace(/^relai_/, '').replaceAll('_', ' ').replaceAll('-', ' ').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Activity';
}

export function activityActionLabel(entry) {
  const action = activityDisplayAction(entry);
  const message = activityMessage(entry).replace(/\s+/g, ' ').slice(0, 120);
  return `Open ${action} details: ${message}`;
}

export function activityFileLocation(entry) {
  return displayText(entry?.result?.path);
}

function mergeActivityEntry(existing, incoming) {
  const patch = { ...incoming };
  for (const key of DISPLAY_TEXT_KEYS) {
    if (key in patch && !displayText(patch[key])) delete patch[key];
  }
  if ('error' in patch && !displayText(patch.error?.message || patch.error)) {
    delete patch.error;
  }
  return { ...existing, ...patch };
}

export function normalizeStatusFilter(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'ok') return 'succeeded';
  if (status === 'error') return 'failed';
  return ['succeeded', 'active', 'failed', 'blocked', 'cancelled', 'other'].includes(status) ? status : '';
}

function activityEntryKey(entry) {
  return entry?.eventId
    || entry?.id
    || entry?.operationId
    || [
      eventTimestampValue(entry),
      entry?.tool?.name || entry?.tool || entry?.type || '',
      entry?.workspace || '',
      entry?.taskId || '',
      entry?.sessionId || '',
      entry?.sequence ?? '',
      entry?.path || entry?.filePath || '',
      entry?.operation || entry?.title || ''
    ].join('|');
}

function displayText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}
