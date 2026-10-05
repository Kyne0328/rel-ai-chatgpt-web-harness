import { createHash, randomUUID } from 'node:crypto';
import { eventIdentityKey } from './taskEvents.js';
import { stableJson } from './stableJson.js';

// Only used until an ingestion caller persists/forwards the returned event.
// Equal-looking fresh invocations must never share an ID by content alone.
const ingestionIdentities = new WeakMap();

function hasEventIdentity(event = {}) {
  return [event.eventId, event.operationId, event.id, event.auditId].some(value => value != null && String(value) !== '');
}

function ensureActivityEventIdentity(event = {}, options = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  if (hasEventIdentity(event)) {
    if (event.eventId != null && String(event.eventId) !== '') return event;
    return { ...event, eventId: eventIdentityKey(event) };
  }
  const source = String(options.source || event.eventIdentitySource || '');
  const occurrence = options.occurrence ?? event.eventIdentityOccurrence;
  if (source && occurrence !== undefined && occurrence !== null) {
    const eventId = `import_${digest([source, String(occurrence)])}`;
    return { ...event, eventId, eventIdentitySource: source, eventIdentityOccurrence: String(occurrence) };
  }
  let eventId = ingestionIdentities.get(event);
  if (!eventId) {
    eventId = `event_${randomUUID()}`;
    ingestionIdentities.set(event, eventId);
  }
  return { ...event, eventId };
}

function canonicalizeActivityEvents(events = [], options = {}) {
  const source = String(options.source || 'legacy-snapshot');
  return events.filter(event => event && typeof event === 'object' && !Array.isArray(event)).map((event, index) => hasEventIdentity(event) ? ensureActivityEventIdentity(event) : ensureActivityEventIdentity(event, {
    source,
    // Include the source position AND signature. This preserves repeated rows
    // and never merges independently observed identical invocations by hash.
    occurrence: `${index}:${digest(event)}`
  }));
}

// Read-only diagnostic. Similar content is evidence to review, never authority
// to remove events or revise historical counters.
function previewActivityReconciliation(events = [], options = {}) {
  const maxGroups = Math.min(100, Math.max(1, Number(options.maxGroups) || 20));
  const maxSamples = Math.min(100, Math.max(1, Number(options.maxSamples) || 10));
  const identities = new Map();
  const signatures = new Map();
  const observe = (groups, key, sample) => {
    let group = groups.get(key);
    if (!group) { group = { count: 0, samples: [] }; groups.set(key, group); }
    group.count += 1;
    if (group.samples.length < maxSamples) group.samples.push(sample);
  };
  let unkeyed = 0;
  for (const [index, event] of events.entries()) {
    const keyed = hasEventIdentity(event);
    if (!keyed) unkeyed += 1;
    const identity = keyed ? eventIdentityKey(event) : '';
    if (identity) observe(identities, identity, index);
    const { eventId: _eventId, operationId: _operationId, id: _id, auditId: _auditId,
      eventIdentitySource: _source, eventIdentityOccurrence: _occurrence, ...content } = event;
    observe(signatures, digest(content), { index, eventId: identity,
      source: event.eventIdentitySource || null, occurrence: event.eventIdentityOccurrence ?? null });
  }
  const repeatedIdentities = [...identities].filter(([, group]) => group.count > 1);
  const similarContent = [...signatures].filter(([, group]) => group.count > 1);
  return {
    readOnly: true, inputCount: events.length, unkeyedCount: unkeyed,
    repeatedIdentityGroupCount: repeatedIdentities.length,
    similarContentGroupCount: similarContent.length,
    repeatedIdentities: repeatedIdentities.slice(0, maxGroups).map(([eventId, group]) => ({ eventId, count: group.count,
      indexes: group.samples, samplesTruncated: group.count > group.samples.length })),
    similarContent: similarContent.slice(0, maxGroups).map(([signature, group]) => ({ signature, count: group.count,
      rows: group.samples, samplesTruncated: group.count > group.samples.length })),
    truncated: repeatedIdentities.length > maxGroups || similarContent.length > maxGroups
      || [...repeatedIdentities, ...similarContent].some(([, group]) => group.count > group.samples.length),
    recommendation: 'Preserve history. Confirm source and invocation identity before any reconciliation; matching content alone does not establish duplicate calls.'
  };
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export { canonicalizeActivityEvents, ensureActivityEventIdentity, previewActivityReconciliation };
