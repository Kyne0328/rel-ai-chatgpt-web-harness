// ChatGPT Web protocol adapter. Undocumented endpoints: fail closed on drift or challenges.
// Credentials are read from the process environment; never persist them with goal records.
import { randomUUID } from 'node:crypto';
import { readConversationProjection } from './chatgptConversationReader.js';

const ORIGIN = 'https://chatgpt.com';
let goalBrowserTransport = null;
let accountScopes = new WeakMap();
const DISCOVERY_CACHE_MS = 120_000;
const RATE_LIMIT_DEFAULT_MS = 300_000;
const READ_WINDOW_MS = 60_000;
const MAX_ACCOUNT_READS = 30;

function configureGoalBrowserTransport(transport) {
  if (transport !== null && typeof transport !== 'function') throw new TypeError('Goal browser transport must be a function or null.');
  goalBrowserTransport = transport;
  accountScopes = new WeakMap();
}

function hasGoalBrowserTransport() { return typeof goalBrowserTransport === 'function'; }
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 2 * 60 * 60_000;
// Long tool-driven conversations regularly exceed the original 8 MiB bound.
// Keep a finite ceiling; never buffer unlimited chat transcripts in the MCP process.
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function chatgptCredentials(env = process.env) {
  const bearer = String(env.REL_AI_CHATGPT_WEB_BEARER || '').trim();
  const cookie = String(env.REL_AI_CHATGPT_WEB_COOKIE || '').trim();
  if (!bearer || !cookie || /[\r\n]/.test(bearer + cookie)) return null;
  return { bearer, cookie };
}

function assertConversationId(value) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw new Error('ChatGPT conversation ID must be a UUID from a chatgpt.com/c/ URL.');
  return id;
}

function parseConversationUrl(value) {
  const input = String(value || '').trim();
  if (UUID.test(input)) return input;
  let url;
  try { url = new URL(input); } catch { throw new Error('Provide a ChatGPT conversation URL or ID.'); }
  const route = /^\/(?:g\/g-[A-Za-z0-9_-]+\/)?c\/([^/]+)\/?$/.exec(url.pathname);
  if (url.origin !== ORIGIN || url.username || url.password || !route) {
    throw new Error('Only ChatGPT conversation URLs on chatgpt.com are supported.');
  }
  return assertConversationId(route[1]);
}

function protocolFailure(path, status, retryAfterMs = 0) {
  const stage = path.startsWith('/backend-api/f/conversation/prepare') ? 'conversation preparation'
    : path.startsWith('/backend-api/sentinel/chat-requirements') ? 'chat requirements'
      : path === '/backend-api/f/conversation' ? 'message submission' : 'conversation read';
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  return Object.assign(new Error(`ChatGPT Web ${stage} failed (HTTP ${httpStatus || 'unknown'}).`), {
    status: httpStatus, stage, retryAfterMs
  });
}

// Retain only boolean challenge types. Never persist or display challenge tokens,
// seeds, difficulty values, encrypted browser signals or raw response bodies.
function requiredChatgptChallenges(result, phase) {
  const types = [
    ['proofofwork', 'proof-of-work'], ['turnstile', 'Turnstile'],
    ['so', 'so'], ['arkose', 'Arkose']
  ].filter(([key]) => result?.[key]?.required === true).map(([, label]) => label);
  if (!types.length) return null;
  const challenge = { phase, types };
  const error = new Error(`ChatGPT requires ${types.join(', ')}; Goal Mode paused.`);
  error.challenge = challenge;
  return error;
}

function headers(credentials) {
  return {
    authorization: 'Bearer ' + credentials.bearer,
    cookie: credentials.cookie,
    accept: 'application/json',
    origin: ORIGIN,
    referer: ORIGIN + '/',
    'content-type': 'application/json'
  };
}

function accountScope(deps) {
  const transport = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null)
    || deps.fetch || globalThis.fetch;
  let accounts = accountScopes.get(transport);
  if (!accounts) { accounts = new Map(); accountScopes.set(transport, accounts); }
  const key = deps.tunnelId || deps.credentials || 'local';
  if (!accounts.has(key)) accounts.set(key, { reads: [], cooldownUntil: 0, rateLimits: 0, discovery: new Map(), goalScans: new Map() });
  const scope = accounts.get(key);
  scope.cooldownUntil = Math.max(scope.cooldownUntil, Number(deps.cooldownUntil || 0));
  scope.rateLimits = Math.max(scope.rateLimits, Number(deps.rateLimitCount || 0));
  return scope;
}

function clearGoalDiscovery(workId, deps = {}) {
  accountScope(deps).goalScans.delete(String(workId || ''));
}

function retryAfterMilliseconds(value) {
  if (value == null || value === '') return 0;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.min(milliseconds, 86_400_000)) : 0;
}

function rateLimitError(until, deferred = true) {
  return Object.assign(new Error('ChatGPT reads are rate limited; waiting for the account cooldown.'),
    { status: 429, retryAt: until, deferred });
}

function rememberRateLimit(error, deps) {
  const scope = accountScope(deps);
  if (!error.deferred && scope.cooldownUntil <= Date.now()) scope.rateLimits = Math.min(scope.rateLimits + 1, 4);
  const suppliedDelay = Number(error.retryAfterMs) || 0;
  const delay = suppliedDelay > 0 ? Math.max(error.deferred ? 1_000 : 60_000, Math.min(suppliedDelay, 86_400_000))
    : RATE_LIMIT_DEFAULT_MS * 2 ** Math.max(0, scope.rateLimits - 1);
  scope.cooldownUntil = Math.max(scope.cooldownUntil, Date.now() + delay);
  try { deps.onRateLimit?.({ until: scope.cooldownUntil, count: scope.rateLimits }); } catch {}
  return Object.assign(error, { retryAt: scope.cooldownUntil });
}

async function requestChatgpt(path, options = {}, deps = {}) {
  options.signal?.throwIfAborted();
  const scope = accountScope(deps);
  const now = Date.now();
  if (scope.cooldownUntil > now) throw rateLimitError(scope.cooldownUntil);
  if (!options.method || options.method === 'GET') {
    scope.reads = scope.reads.filter(time => time > now - READ_WINDOW_MS);
    if (scope.reads.length >= MAX_ACCOUNT_READS) throw Object.assign(
      new Error('ChatGPT account read budget reached; deferring this read.'),
      { deferred: true, retryAt: scope.reads[0] + READ_WINDOW_MS });
    scope.reads.push(now);
  }
  try {
    return await requestChatgptUncoordinated(path, options, deps);
  } catch (error) {
    if (error?.status === 429) throw rememberRateLimit(error, deps);
    throw error;
  }
}

async function requestChatgptUncoordinated(path, options = {}, deps = {}) {
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (native) {
    const result = await native({ path, method: options.method || 'GET', body: options.body,
      ...(deps.tunnelId ? { tunnelId: deps.tunnelId } : {}),
      headers: options.headers, raw: options.raw === true,
      ...(options.projectConversation ? { projectConversation: true } : {}) }, { signal: options.signal });
    if (!result?.ok) throw Object.assign(protocolFailure(path, result?.status, result?.retryAfterMs),
      { deferred: result?.deferred === true });
    return options.raw ? { text: async () => result.streamObserved ? 'event: accepted\n\n' : '' } : result.data;
  }
  const credentials = deps.credentials || chatgptCredentials();
  if (!credentials) throw new Error('ChatGPT Web authentication is not configured. Set REL_AI_CHATGPT_WEB_BEARER and REL_AI_CHATGPT_WEB_COOKIE on the local Rel.AI process.');
  const fetcher = deps.fetch || globalThis.fetch;
  const response = await fetcher(ORIGIN + path, {
    method: options.method || 'GET',
    headers: { ...headers(credentials), ...(options.headers || {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.raw ? STREAM_TIMEOUT_MS : REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(options.raw ? STREAM_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
    redirect: 'error'
  });
  if (!response.ok) {
    const retryAfterMs = retryAfterMilliseconds(response.headers?.get?.('retry-after'));
    await response.body?.cancel?.().catch(() => {});
    throw protocolFailure(path, response.status, retryAfterMs);
  }
  if (options.raw) return response;
  if (options.projectConversation) return readConversationProjection(response);
  const advertised = Number(response.headers?.get?.('content-length') || 0);
  if (advertised > MAX_JSON_BYTES) throw new Error('ChatGPT conversation response exceeded the safe size limit.');
  if (!response.body?.getReader) return response.json(); // Test transport with a bounded fixture.
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('ChatGPT conversation response exceeded the safe size limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function listConversations(deps = {}) {
  const result = await requestChatgpt('/backend-api/conversations?offset=0&limit=20&order=updated&is_archived=false', { signal: deps.signal }, deps);
  return Array.isArray(result.items) ? result.items : [];
}

// Project chats have a separate catalogue. The sidebar supplies recent chat
// previews, avoiding a per-project request in the common case.
const PROJECT_ID = /^g-p-[0-9a-f]{32}$/i;
const MAX_SIDEBAR_PAGES = 4;
const MAX_PROJECTS = 80;
const MAX_PROJECT_CHAT_PAGES = 2;

async function listGoalProjects(deps = {}, initialCursor = '') {
  const projects = [];
  const previews = [];
  const seen = new Set(initialCursor ? [initialCursor] : []);
  let cursor = initialCursor;
  for (let page = 0; page < MAX_SIDEBAR_PAGES; page++) {
    const path = '/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const result = await requestChatgpt(path, { signal: deps.signal }, deps);
    if (!Array.isArray(result?.items)) throw new Error('ChatGPT Project listing has an unsupported response.');
    for (const item of result.items) {
      const record = item?.gizmo || item;
      const id = String(record?.gizmo?.id || record?.id || '');
      if (!PROJECT_ID.test(id) || projects.includes(id)) continue;
      projects.push(id);
      const recentChats = record?.conversations?.items;
      if (Array.isArray(recentChats)) for (const conversation of recentChats) {
        if (UUID.test(String(conversation?.id || ''))) previews.push({
          id: conversation.id, update_time: conversation.update_time
        });
      }
    }
    const next = result.cursor;
    if (!next) return { projects, previews, complete: true, cursor: '' };
    if (typeof next !== 'string' || next.length > 2048 || seen.has(next)) {
      throw new Error('ChatGPT Project listing has an invalid pagination cursor.');
    }
    seen.add(next);
    cursor = next;
    if (projects.length >= MAX_PROJECTS) break;
  }
  return { projects, previews, complete: false, cursor };
}

async function listProjectChats(projectId, cursor, deps = {}) {
  if (!PROJECT_ID.test(projectId) || (cursor !== '0' && (typeof cursor !== 'string' || cursor.length > 2048))) {
    throw new Error('Invalid ChatGPT Project conversation lookup.');
  }
  const result = await requestChatgpt('/backend-api/gizmos/' + projectId
    + '/conversations?cursor=' + encodeURIComponent(cursor), { signal: deps.signal }, deps);
  if (!Array.isArray(result?.items)) throw new Error('ChatGPT Project conversations have an unsupported response.');
  return { items: result.items, cursor: result.cursor || null };
}

async function getConversation(id, deps = {}) {
  return requestChatgpt('/backend-api/conversation/' + assertConversationId(id),
    { signal: deps.signal, projectConversation: true }, deps);
}

function waitForDiscovery(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function discoveryRead(key, load, deps) {
  deps.signal?.throwIfAborted();
  const scope = accountScope(deps);
  if (scope.cooldownUntil > Date.now()) throw rateLimitError(scope.cooldownUntil);
  const existing = scope.discovery.get(key);
  if (existing?.promise) return { value: await waitForDiscovery(existing.promise, deps.signal), cached: false };
  if (existing && Date.now() < existing.expiresAt) return { value: existing.value, cached: true };
  // Shared requests own their deadline. Cancelling one task must not cancel
  // another task's discovery or retain an unbounded request.
  const record = { promise: null };
  record.promise = Promise.resolve().then(() => load({ ...deps,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).then(value => {
    scope.discovery.set(key, { value, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
    while (scope.discovery.size > 32) {
      const oldest = [...scope.discovery].find(([key, entry]) => key !== 'catalog' && !entry.promise)?.[0];
      if (oldest === undefined) break;
      scope.discovery.delete(oldest);
    }
    return value;
  }, error => {
    if (scope.discovery.get(key) === record) scope.discovery.delete(key);
    throw error;
  });
  scope.discovery.set(key, record);
  return { value: await waitForDiscovery(record.promise, deps.signal), cached: false };
}

function activeMessages(conversation) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return [];
  const nodes = [];
  const seen = new Set();
  let nodeId = conversation.current_node;
  while (nodeId && mapping[nodeId] && !seen.has(nodeId) && nodes.length < 1000) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (node.message) nodes.push({ id: nodeId, message: node.message });
    nodeId = node.parent;
  }
  return nodes.reverse();
}

function messageText(message) {
  const parts = message?.content?.parts;
  return Array.isArray(parts) ? parts.filter(p => typeof p === 'string').join('\n') : '';
}

function turnState(conversation) {
  const messages = activeMessages(conversation);
  const last = messages.at(-1);
  const message = last?.message;
  const role = message?.author?.role;
  const complete = role === 'assistant' && message?.end_turn === true && message?.status === 'finished_successfully';
  return {
    nodeId: String(conversation?.current_node || ''),
    lastMessageId: String(message?.id || ''),
    role,
    text: messageText(message),
    startedAt: Number(message?.create_time || 0) * 1000,
    complete,
    settled: role === 'assistant' && (message?.end_turn === true
      || ['interrupted', 'cancelled'].includes(message?.status)),
    userMessage: [...messages].reverse().find(n => n.message?.author?.role === 'user')?.message || null,
    messages
  };
}

async function findRecentGoalCommand(deps = {}) {
  const startedAt = Number(deps.startedAt || 0);
  let correlatedId = '';
  try { correlatedId = parseConversationUrl(deps.conversationCorrelation); } catch {}

  // The authenticated account has a finite per-minute read budget. Preserve
  // a work-specific cursor across deferred polls instead of rescanning the
  // first Projects every minute. Never share scans across accounts or work IDs.
  const scope = !correlatedId && deps.workId ? accountScope(deps) : null;
  const scanKey = scope ? String(deps.workId) : '';
  let scan = scope?.goalScans.get(scanKey);
  if (scope && (!scan || scan.startedAt !== startedAt || scan.explicitGoal !== Boolean(deps.explicitGoal))) {
    scan = { startedAt, explicitGoal: Boolean(deps.explicitGoal), ordinary: null, ordinaryAt: 0, catalogue: null, previewAt: 0,
      sidebarCursor: '', projectAt: 0, cursor: '0', pages: 0, page: null, pageAt: 0, candidates: [] };
    scope.goalScans.set(scanKey, scan);
    while (scope.goalScans.size > 16) scope.goalScans.delete(scope.goalScans.keys().next().value);
  }
  const candidates = scan ? [...scan.candidates] : [];
  const resumedCandidate = candidates.length > 0;
  const inspected = new Set();

  const inspect = async (summaries, from = 0, advance = () => {}) => {
    for (let i = from; i < summaries.length; i++) {
      const summary = summaries[i];
      const id = String(summary?.id || '');
      const updated = typeof summary?.update_time === 'number'
        ? summary.update_time * 1_000 : Date.parse(summary?.update_time || '');
      if (!UUID.test(id) || inspected.has(id) ||
        (!correlatedId && Number.isFinite(updated) && updated < startedAt - 120_000)) {
        advance(i + 1);
        continue;
      }
      inspected.add(id);
      let evidence;
      let cached = false;
      if (correlatedId) evidence = goalCommandEvidence(await getConversation(id, deps));
      else {
        const result = await discoveryRead(id, async shared => goalCommandEvidence(await getConversation(id, shared)), deps);
        evidence = result.value;
        cached = result.cached;
      }
      const match = goalEvidenceForWork(evidence, deps, correlatedId);
      if (match && recentGoalEvidence(match, startedAt)) {
        const messageId = match.messageId;
        if (cached) {
          // A cached match never authorizes linking without a fresh receipt read.
          const fresh = goalEvidenceForWork(goalCommandEvidence(await getConversation(id, deps)), deps, correlatedId);
          if (fresh && fresh.messageId === messageId && recentGoalEvidence(fresh, startedAt)
            && !candidates.some(candidate => candidate.conversationId === id)) {
            candidates.push({ conversationId: id, messageId });
          }
        } else if (!candidates.some(candidate => candidate.conversationId === id)) {
          candidates.push({ conversationId: id, messageId });
        }
      }
      if (scan) scan.candidates = [...candidates];
      advance(i + 1);
      if (candidates.length > 1) {
        if (scope) scope.goalScans.delete(scanKey);
        return { state: 'ambiguous' };
      }
    }
    return null;
  };
  const matched = async () => {
    if (!candidates.length) return null;
    if (candidates.length > 1) {
      if (scope) scope.goalScans.delete(scanKey);
      return { state: 'ambiguous' };
    }
    if (resumedCandidate) {
      // A remembered match must be checked again against the active branch.
      const candidate = candidates[0];
      const fresh = goalEvidenceForWork(goalCommandEvidence(await getConversation(candidate.conversationId, deps)), deps, correlatedId);
      if (!fresh || fresh.messageId !== candidate.messageId || !recentGoalEvidence(fresh, startedAt)) {
        candidates.length = 0;
        if (scan) scan.candidates = [];
        return null;
      }
    }
    if (scope) scope.goalScans.delete(scanKey);
    return { state: 'matched', ...candidates[0] };
  };
  const ordinary = correlatedId ? [{ id: correlatedId }]
    : scan?.ordinary || (await discoveryRead('catalog', listConversations, deps)).value;
  if (scan && !scan.ordinary) scan.ordinary = ordinary.map(item => ({ id: item.id, update_time: item.update_time }));
  const normalResult = await inspect(ordinary, scan?.ordinaryAt || 0, at => { if (scan) scan.ordinaryAt = at; });
  if (normalResult) return normalResult;
  if (correlatedId) return (await matched()) || { state: 'absent' };
  const ordinaryMatch = await matched();
  if (ordinaryMatch) return ordinaryMatch;

  const sidebarCursor = scan?.sidebarCursor || '';
  const catalogue = scan?.catalogue || (await discoveryRead('project-catalog:' + sidebarCursor,
    shared => listGoalProjects(shared, sidebarCursor), deps)).value;
  if (scan && !scan.catalogue) scan.catalogue = catalogue;
  const previewResult = await inspect(catalogue.previews, scan?.previewAt || 0, at => { if (scan) scan.previewAt = at; });
  if (previewResult) return previewResult;
  const previewMatch = await matched();
  if (previewMatch) return previewMatch;
  // Automatic /goal detection only inspects the sidebar, not full histories.
  if (!deps.explicitGoal) {
    if (catalogue.complete) {
      if (scope) scope.goalScans.delete(scanKey);
      return { state: 'absent' };
    }
    if (!scan || !catalogue.cursor) throw new Error('ChatGPT Project listing cannot advance its pagination.');
    scan.sidebarCursor = catalogue.cursor;
    scan.catalogue = null;
    scan.previewAt = 0;
    throw Object.assign(new Error('ChatGPT Project discovery is incomplete; continuing the sidebar scan.'),
      { deferred: true, retryAt: Date.now() + DISCOVERY_CACHE_MS });
  }

  let complete = catalogue.complete;
  for (let projectAt = scan?.projectAt || 0; projectAt < catalogue.projects.length; projectAt++) {
    const projectId = catalogue.projects[projectAt];
    let cursor = scan?.cursor || '0';
    let pageIndex = scan?.pages || 0;
    const seenCursors = new Set();
    for (; pageIndex < MAX_PROJECT_CHAT_PAGES; pageIndex++) {
      const key = 'project:' + projectId + ':' + cursor;
      const listing = scan?.page || (await discoveryRead(key, shared => listProjectChats(projectId, cursor, shared), deps)).value;
      if (scan && !scan.page) scan.page = {
        items: listing.items.map(item => ({ id: item.id, update_time: item.update_time })),
        cursor: listing.cursor
      };
      const found = await inspect(listing.items, scan?.pageAt || 0, at => { if (scan) scan.pageAt = at; });
      if (found) return found;
      const projectMatch = await matched();
      if (projectMatch) return projectMatch;
      if (scan) { scan.page = null; scan.pageAt = 0; }
      if (!listing.cursor) { cursor = ''; break; }
      if (typeof listing.cursor !== 'string' || listing.cursor.length > 2048 || seenCursors.has(listing.cursor)) {
        throw new Error('ChatGPT Project conversation cursor is invalid.');
      }
      seenCursors.add(listing.cursor);
      cursor = listing.cursor;
      if (scan) { scan.cursor = cursor; scan.pages = pageIndex + 1; }
    }
    if (cursor) {
      // Resume this Project's next page on the following poll instead of
      // retrying its first two pages forever.
      if (scan) { scan.projectAt = projectAt; scan.cursor = cursor; scan.pages = 0; }
      throw Object.assign(new Error('ChatGPT Project conversation discovery is continuing.'),
        { deferred: true, retryAt: Date.now() + 20_000 });
    }
    if (scan) { scan.projectAt = projectAt + 1; scan.cursor = '0'; scan.pages = 0; scan.page = null; scan.pageAt = 0; }
  }
  if (!complete) {
    // The sidebar is also paginated. Preserve the next cursor and advance to
    // the next bounded batch rather than refetching the first four pages.
    if (!scan || !catalogue.cursor) throw new Error('ChatGPT Project listing cannot advance its pagination.');
    scan.sidebarCursor = catalogue.cursor;
    scan.catalogue = null;
    scan.previewAt = 0;
    scan.projectAt = 0;
    throw Object.assign(new Error('ChatGPT Project conversation discovery is continuing.'),
      { deferred: true, retryAt: Date.now() + 20_000 });
  }
  if (scope) scope.goalScans.delete(scanKey);
  return { state: 'absent' };
}

function recentGoalEvidence(evidence, startedAt) {
  return startedAt && evidence.messageId && Number.isFinite(evidence.timestamp)
    && evidence.timestamp >= startedAt - 120_000 && evidence.timestamp <= startedAt + 15_000;
}

function goalEvidenceForWork(evidence, deps, correlatedId) {
  if (deps.explicitGoal) {
    // Explicit activation is authorized by an exact tool receipt, not by the
    // user's wording. Never let a known conversation ID bypass this proof.
    return evidence.receipts.find(receipt => receipt.workId === deps.workId) || null;
  }
  if (!evidence.requested || (deps.requireWorkReceipt && !correlatedId && !evidence.workIds.includes(deps.workId))) return null;
  return evidence;
}

function goalCommandEvidence(conversation) {
  const messages = activeMessages(conversation);
  const command = messages.filter(n => n.message?.author?.role === 'user').at(-1);
  const text = messageText(command?.message).trim();
  const receipts = [];
  let user = null;
  for (const node of messages) {
    if (node.message?.author?.role === 'user') user = node.message;
    if (node.message?.author?.role !== 'tool' || !user) continue;
    for (const workId of node.message?.content?.workIds || []) {
      // Work may start after a long reasoning/setup phase in the same turn.
      // Date its proof by the tool response; older responses without a timestamp
      // retain the conservative initiating-user fallback.
      receipts.push({ workId, timestamp: Number(node.message.create_time ?? user.create_time) * 1_000,
        messageId: String(user.id || '').trim() });
    }
  }
  return {
    requested: /^\/goal(?:\s|$)/i.test(text) && !/^\/goal\s+(?:stop|cancel|status)(?:\s|$)/i.test(text),
    timestamp: Number(command?.message?.create_time) * 1_000,
    messageId: String(command?.message?.id || '').trim(),
    workIds: [...new Set(messages.slice(messages.indexOf(command) + 1)
      .filter(node => node.message?.author?.role === 'tool')
      .flatMap(node => node.message?.content?.workIds || []))],
    receipts
  };
}

async function findGoalConversation(objective, deps = {}) {
  if (!String(objective || '').trim()) return null;
  const match = await findRecentGoalCommand(deps);
  return match.state === 'matched' ? match.conversationId : null;
}

async function stopStalledTurn(id, expectedNodeId, deps = {}) {
  assertConversationId(id);
  if (!expectedNodeId) throw new Error('A confirmed stalled assistant node is required.');
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (!native) throw new Error('Stalled ChatGPT turn requires the signed-in desktop browser to stop it safely.');
  const result = await native({ action: 'stop_stalled', conversationId: id, expectedNodeId,
    ...(deps.tunnelId ? { tunnelId: deps.tunnelId } : {}) }, { signal: deps.signal });
  if (result?.status === 429) throw rememberRateLimit(Object.assign(
    protocolFailure('/backend-api/conversation/' + id, 429, result.retryAfterMs),
    { notSent: true, deferred: result.deferred === true }), deps);
  if (result?.ok && result.stopped === true) return true;
  if (result?.ok && result.alreadyFinished === true) return false;
  throw Object.assign(new Error('Stalled ChatGPT response could not be stopped and verified.'), {
    notSent: true, deferred: result?.busy === true
  });
}

function goalContinuationPrompt(workId, objective) {
  return 'Continue goal ' + workId + ': ' + objective + '. Inspect this exact Rel.AI work_id, operation receipts and task state first. Do not repeat completed changes or operations. If finished, explicitly close that work session. If blocked or awaiting user input, explain the blocker instead of retrying.';
}

async function sendContinue(id, parentMessageId, deps = {}) {
  assertConversationId(id);
  if (!parentMessageId) throw new Error('A confirmed parent message is required.');
  if (!deps.workId || !deps.objective) throw new Error('Goal continuation requires the exact work ID and objective.');
  const prompt = goalContinuationPrompt(deps.workId, deps.objective);
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (native) {
    const scope = accountScope(deps);
    if (scope.cooldownUntil > Date.now()) throw Object.assign(rateLimitError(scope.cooldownUntil), { notSent: true });
    let result;
    try {
      result = await native({ action: 'continue', conversationId: id, parentMessageId, expectedNodeId: deps.nodeId, prompt,
        ...(deps.tunnelId ? { tunnelId: deps.tunnelId } : {}) }, { signal: deps.signal });
    } catch (error) {
      if (error?.code === 'GOAL_ACCOUNT_UNAVAILABLE') error.notSent = true;
      if (error?.status === 429) throw rememberRateLimit(error, deps);
      throw error;
    }
    if (result?.status === 429) throw rememberRateLimit(Object.assign(
      protocolFailure('/backend-api/conversation/' + id, 429, result.retryAfterMs),
      { notSent: result.notSent === true, deferred: result.deferred === true }), deps);
    if (result?.ok && result.accepted === true) return { accepted: true };
    const failure = message => Object.assign(new Error(message), {
      notSent: result?.notSent === true, deferred: result?.busy === true
    });
    const stage = ['navigation', 'composer', 'preflight', 'draft', 'send_button', 'submit', 'readback']
      .includes(result?.stage) ? ` (${result.stage})` : '';
    if (result?.busy) throw failure('Goal browser sender is busy; continuation deferred.');
    if (result?.stale) throw failure('ChatGPT conversation changed before sending.');
    if (result?.needsUser || result?.notSent) {
      const reason = result.reason === 'text_mismatch' ? 'Composer text could not be verified'
        : result.reason === 'send_unavailable' ? 'Send button was unavailable'
          : result.reason === 'verification' ? 'Browser verification is required'
            : result.reason === 'conversation_unavailable' ? 'The browser did not reach the linked ChatGPT conversation'
              : result.reason === 'composer_unavailable' ? 'The ChatGPT composer did not become ready'
                : result.reason === 'focus_unavailable' ? 'The ChatGPT composer could not receive input'
            : 'ChatGPT needs attention';
      throw failure(`${reason}${stage}; continuation was not sent.`);
    }
    throw failure(`ChatGPT browser send could not be verified${stage}; checking the receipt without resending.`);
  }
  // Non-desktop development transport retains the fail-closed protocol flow.
  let submitted = false;
  try {
    const messageId = randomUUID();
    // The chat-requirements token must be available before conversation preparation.
    // Never attempt to solve proof-of-work, Turnstile, or other interactive challenges.
    const requirementPrepare = await requestChatgpt('/backend-api/sentinel/chat-requirements/prepare', {
      method: 'POST', body: {}, signal: deps.signal
    }, deps);
    const prepareChallenge = requiredChatgptChallenges(requirementPrepare, 'prepare');
    if (prepareChallenge) throw prepareChallenge;
    if (typeof requirementPrepare?.prepare_token !== 'string' || !requirementPrepare.prepare_token) {
      throw new Error('ChatGPT chat requirements preparation did not return a prepare token.');
    }
    const requirement = await requestChatgpt('/backend-api/sentinel/chat-requirements/finalize', {
      method: 'POST', body: { prepare_token: requirementPrepare.prepare_token }, signal: deps.signal
    }, deps);
    const finalizeChallenge = requiredChatgptChallenges(requirement, 'finalize');
    if (finalizeChallenge) throw finalizeChallenge;
    if (typeof requirement?.token !== 'string' || !requirement.token) {
      throw new Error('ChatGPT requirements finalization returned no token; Goal Mode paused.');
    }
    const prep = await requestChatgpt('/backend-api/f/conversation/prepare', {
      method: 'POST',
      headers: { 'openai-sentinel-chat-requirements-token': requirement.token },
      body: {
        conversation_id: id, model: 'auto', message_id: messageId,
        timezone_offset_min: new Date().getTimezoneOffset(), supports_buffering: true,
        client_prepare_state: 'none', conversation_mode: { kind: 'primary_assistant' }
      }, signal: deps.signal
    }, deps);
    const conduit = prep?.conduit_token || prep?.token;
    if (!conduit || typeof conduit !== 'string') throw new Error('ChatGPT preparation did not provide a conduit token.');
    submitted = true;
    const response = await requestChatgpt('/backend-api/f/conversation', {
      method: 'POST', raw: true, signal: deps.signal,
      headers: { accept: 'text/event-stream', 'x-conduit-token': conduit,
        'openai-sentinel-chat-requirements-token': requirement.token },
      body: {
        action: 'next', conversation_id: id, parent_message_id: parentMessageId,
        client_prepare_state: 'success', model: 'auto', supports_buffering: true,
        messages: [{ id: messageId, author: { role: 'user' },
          content: { content_type: 'text', parts: [prompt] } }]
      }
    }, deps);
    // Consume rather than cancel the response stream. Some web turns outlive the
    // initial SSE handoff; buffering full model output would exhaust app memory.
    // An interrupted stream is uncertain and is never automatically resent.
    let observedEvent = false;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let last = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = last + decoder.decode(value, { stream: true });
        if (chunk.includes('data:') || chunk.includes('event:')) observedEvent = true;
        last = chunk.slice(-8);
      }
    } else {
      const stream = await response.text(); // Fixture adapter only.
      observedEvent = stream.includes('data:') || stream.includes('event:');
    }
    if (!observedEvent) throw new Error('ChatGPT did not return the expected conversation event stream.');
    return { accepted: true };
  } catch (error) {
    if (!submitted && error instanceof Error) error.notSent = true;
    throw error;
  }
}

export { clearGoalDiscovery, configureGoalBrowserTransport, hasGoalBrowserTransport, parseConversationUrl, chatgptCredentials, getConversation, activeMessages, turnState, findRecentGoalCommand, findGoalConversation, stopStalledTurn, goalContinuationPrompt, sendContinue };
