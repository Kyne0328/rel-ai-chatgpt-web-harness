const COMPLEMENT = Object.freeze({
  HTTP_CALLS: 'HANDLES',
  HANDLES: 'HTTP_CALLS',
  EMITS: 'LISTENS_ON',
  LISTENS_ON: 'EMITS'
});

const GENERIC_PLATFORM_EVENT_NAMES = Object.freeze([
  'abort', 'aborted', 'before-input-event', 'beforeunload', 'blur', 'change', 'click', 'close', 'connect',
  'connection', 'data', 'destroyed', 'did-start-loading', 'did-stop-loading', 'domcontentloaded', 'drain',
  'end', 'error', 'exit', 'finish', 'focus', 'hashchange', 'input', 'keydown', 'keypress', 'keyup', 'load',
  'message', 'mousedown', 'mouseenter', 'mouseleave', 'mousemove', 'mouseout', 'mouseover', 'mouseup', 'offline',
  'online', 'open', 'pointerdown', 'pointermove', 'pointerup', 'popstate', 'ready', 'ready-to-show', 'request',
  'resize', 'response', 'scroll', 'storage', 'submit', 'timeout', 'touchend', 'touchmove', 'touchstart',
  'uncaughtexception', 'unload', 'visibilitychange'
]);
const GENERIC_PLATFORM_EVENTS = new Set(GENERIC_PLATFORM_EVENT_NAMES);

function relationshipKey(type, targetName) {
  const value = String(targetName || '').trim();
  if (!value) return '';
  if (type === 'HTTP_CALLS' || type === 'HANDLES') return canonicalHttpKey(value);
  if (type === 'EMITS' || type === 'LISTENS_ON') {
    const eventName = value.replace(/^event:/i, '').trim();
    if (!eventName || GENERIC_PLATFORM_EVENTS.has(eventName.toLowerCase())) return '';
    return `event:${eventName}`;
  }
  return value;
}

function canonicalHttpKey(value) {
  const match = String(value || '').match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
  if (!match) return '';
  let target = match[2].trim();
  try {
    if (/^https?:\/\//i.test(target)) target = new URL(target).pathname;
  } catch { return ''; }
  target = target.split(/[?#]/, 1)[0].replace(/\/{2,}/g, '/');
  if (!target.startsWith('/')) return '';
  if (target.length > 1) target = target.replace(/\/$/, '');
  return `${match[1].toUpperCase()} ${target}`;
}

function isSpecificHttpRelationshipKey(value) {
  const key = canonicalHttpKey(value);
  if (!key) return false;
  const route = key.slice(key.indexOf(' ') + 1);
  const meaningfulSegments = route.split('/').filter(Boolean).filter(segment => {
    if (/^(?:api|v\d+)$/i.test(segment)) return false;
    if (/^(?::[^/]+|\{[^}]+\}|\*+)$/.test(segment)) return false;
    return true;
  });
  return meaningfulSegments.length >= 2;
}

function hasStrongComplementaryRelationshipEvidence(localHints = [], remoteHints = []) {
  const remoteKeys = new Set((remoteHints || []).map(hint => {
    const key = relationshipKey(hint?.type, hint?.targetName);
    return key ? `${hint.type}\u0000${key}` : '';
  }).filter(Boolean));
  const matchedHttpKeys = new Set();
  for (const hint of localHints || []) {
    const complement = COMPLEMENT[hint?.type];
    const key = relationshipKey(hint?.type, hint?.targetName);
    if (!complement || !key || !remoteKeys.has(`${complement}\u0000${key}`)) continue;
    if (key.startsWith('event:') || isSpecificHttpRelationshipKey(key)) return true;
    matchedHttpKeys.add(key);
    if (matchedHttpKeys.size >= 2) return true;
  }
  return false;
}

export {
  COMPLEMENT, GENERIC_PLATFORM_EVENT_NAMES, hasStrongComplementaryRelationshipEvidence, relationshipKey
};
