// ChatGPT Web protocol adapter. Undocumented endpoints: fail closed on drift or challenges.
// Credentials are read from the process environment; never persist them with goal records.
import { randomUUID } from 'node:crypto';
import { readConversationProjection } from './chatgptConversationReader.js';
import { parseGoalCommand } from './goalCommands.js';

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
  if (!accounts.has(key)) accounts.set(key, { reads: [], cooldownUntil: 0, rateLimits: 0, discovery: new Map() });
  const scope = accounts.get(key);
  scope.cooldownUntil = Math.max(scope.cooldownUntil, Number(deps.cooldownUntil || 0));
  scope.rateLimits = Math.max(scope.rateLimits, Number(deps.rateLimitCount || 0));
  return scope;
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

async function conversationPage(deps = {}, offset = 0) {
  const result = await requestChatgpt(`/backend-api/conversations?offset=${offset}&limit=20&order=updated&is_archived=false`, { signal: deps.signal }, deps);
  if (!Array.isArray(result?.items) || result.items.length > 200) throw new Error('ChatGPT conversation listing has an unsupported response.');
  return { items: result.items, more: result.has_more === true || Number(result.total) > offset + result.items.length };
}

// Project chats have a separate catalogue. The sidebar supplies recent chat
// previews, avoiding a per-project request in the common case.
const PROJECT_ID = /^g-p-[0-9a-f]{32}$/i;
const MAX_SIDEBAR_PAGES = 4;
const MAX_PROJECTS = 80;

async function listGoalProjects(deps = {}, initialCursor = '', maxPages = MAX_SIDEBAR_PAGES) {
  const projects = [];
  const previews = [];
  const seen = new Set(initialCursor ? [initialCursor] : []);
  let cursor = initialCursor;
  for (let page = 0; page < Math.min(maxPages, MAX_SIDEBAR_PAGES); page++) {
    const path = '/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=5'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const result = await requestChatgpt(path, { signal: deps.signal }, deps);
    if (!Array.isArray(result?.items)) throw new Error('ChatGPT Project listing has an unsupported response.');
    for (const item of result.items) {
      const record = item?.gizmo || item;
      const id = String(record?.gizmo?.id || record?.id || '');
      if (!PROJECT_ID.test(id) || projects.some(project => project.id === id)) continue;
      projects.push({ id, name: String(record?.gizmo?.name || record?.gizmo?.display_name
        || record?.name || record?.display_name || record?.title || '').trim() });
      const recentChats = record?.conversations?.items;
      if (Array.isArray(recentChats)) for (const conversation of recentChats) {
        if (UUID.test(String(conversation?.id || ''))) previews.push({
          id: conversation.id, update_time: conversation.update_time, projectId: id
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
  if (!Array.isArray(result?.items) || result.items.length > 200
    || result.cursor != null && (typeof result.cursor !== 'string' || result.cursor.length > 2048)) {
    throw new Error('ChatGPT Project conversations have an unsupported response.');
  }
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
    scope.discovery.set(key, { value, expiresAt: Date.now() + (deps.discoveryCacheMs ?? DISCOVERY_CACHE_MS) });
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

function activeMessages(conversation, maxNodes = 1000) {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return [];
  const nodes = [];
  const seen = new Set();
  let nodeId = conversation.current_node;
  while (nodeId && mapping[nodeId] && !seen.has(nodeId) && seen.size < maxNodes) {
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

// Start with recent chats; durable discovery can page further on later rounds.
const RECENT_GOAL_CHATS = 10;

function recentChats(items, limit = RECENT_GOAL_CHATS) {
  const unique = new Map();
  for (const item of items) {
    if (!UUID.test(String(item?.id || ''))) continue;
    const updated = typeof item.update_time === 'number' ? item.update_time * 1000
      : Date.parse(item.update_time || '') || 0;
    const previous = unique.get(item.id);
    if (!previous || updated > previous.updated) unique.set(item.id, { id: item.id, updated,
      ...(item.projectId ? { projectId: item.projectId } : {}) });
  }
  return [...unique.values()].sort((a, b) => b.updated - a.updated).slice(0, limit);
}

async function recentGoalCandidates(deps) {
  const hint = String(deps.chatgptProjectName || '').trim();
  let projectId = String(deps.chatgptProjectId || '');
  if (hint || projectId) {
    if (!PROJECT_ID.test(projectId)) {
      const { value: catalogue } = await discoveryRead('sidebar-page:',
        shared => listGoalProjects(shared, '', 1), deps);
      const sameName = name => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase()
        === hint.replace(/\s+/g, ' ').toLowerCase();
      const matches = catalogue.projects.filter(item => sameName(item.name));
      // A display name is only a hint. Missing, duplicate and partially listed
      // names cannot establish absence or prevent receipt-based discovery.
      projectId = matches.length === 1 ? matches[0].id : '';
    }
    if (projectId) {
      try {
        const { value: page } = await discoveryRead('project-recent:' + projectId,
          shared => listProjectChats(projectId, '0', shared), deps);
        return { state: 'ready', projectId, items: recentChats(page.items) };
      } catch (error) { if (![403, 404].includes(error?.status)) throw error; }
    }
  }
  // First pass without a usable hint: prioritize the ten newest ordinary chats
  // and Project previews. A missed receipt schedules resumable discovery.
  const ordinary = await discoveryRead('ordinary-page:0',
    conversationPage, deps);
  const sidebar = await discoveryRead('sidebar-page:',
    shared => listGoalProjects(shared, '', 1), deps);
  return { state: 'ready', items: recentChats([...ordinary.value.items, ...sidebar.value.previews]) };
}

// A bounded page of a durable scan. A round reads at most ten conversations and
// three catalogue pages; subsequent rounds resume rather than restarting at the
// sidebar. This uses the same tunnel-scoped transport and account read budget.
async function nextGoalCandidates(deps) {
  if (!deps.discovery?.scan) return recentGoalCandidates(deps);
  const scan = structuredClone(deps.discovery.scan);
  deps.discovery.scan = scan;
  for (let pages = 0; pages < 3; pages++) {
    if (scan.pending?.length) {
      return { state: 'ready', items: scan.pending.slice(0, RECENT_GOAL_CHATS) };
    }
    if (scan.phase === 'done') {
      deps.discovery.scan = null;
      deps.discovery.complete = true;
      return { state: 'ready', items: [] };
    }
    if (scan.phase === 'ordinary') {
      const offset = scan.offset || 0;
      const { value: page } = await discoveryRead('ordinary-page:' + offset,
        shared => conversationPage(shared, offset), deps);
      scan.offset = offset + page.items.length;
      if (!page.more || !page.items.length) scan.phase = 'sidebar';
      scan.pending = recentChats(page.items, 200);
    } else if (scan.phase === 'sidebar') {
      const cursor = scan.sidebarCursor || '';
      const { value: page } = await discoveryRead('sidebar-page:' + cursor,
        shared => listGoalProjects(shared, cursor, 1), deps);
      scan.sidebarCursor = page.cursor;
      scan.sidebarComplete = page.complete;
      scan.projects = page.projects.map(project => project.id);
      scan.projectCursor = '0';
      scan.phase = 'project';
    } else if (scan.phase === 'project') {
      const projectId = scan.projects[0];
      if (!projectId) { scan.phase = scan.sidebarComplete ? 'done' : 'sidebar'; continue; }
      const cursor = scan.projectCursor;
      let page;
      try {
        ({ value: page } = await discoveryRead('project-page:' + projectId + ':' + cursor,
          shared => listProjectChats(projectId, cursor, shared), deps));
      } catch (error) {
        if (![403, 404].includes(error?.status)) throw error;
        page = { items: [], cursor: null };
      }
      if (page.cursor === cursor) throw new Error('ChatGPT Project conversations repeated a pagination cursor.');
      scan.projectCursor = page.cursor || '0';
      if (!page.cursor) scan.projects.shift();
      scan.pending = recentChats(page.items.map(item => ({ ...item, projectId })), 200);
    } else throw new Error('Unsupported ChatGPT discovery scan state.');
  }
  return { state: 'ready', items: scan.pending?.slice(0, RECENT_GOAL_CHATS) || [] };
}

function finishDiscoveryPage(deps, catalogue) {
  // Advance only after the whole batch was read. A cooldown or cancellation
  // halfway through must not discard a receipt already seen in that batch.
  deps.discovery?.scan?.pending?.splice(0, catalogue.items.length);
}

function continueDiscovery(deps, exact) {
  if (deps.discovery && !exact && !deps.discovery.scan && !deps.discovery.complete) {
    deps.discovery.scan = { phase: 'ordinary', offset: 0, pending: [] };
  }
}

async function findRecentGoalCommand(deps = {}) {
  if (deps.linkId) return findLinkedGoalCommand(deps);
  let exact = '';
  try { exact = parseConversationUrl(deps.conversationCorrelation); } catch {}
  if (exact && deps.verifyLegacy) {
    const receipt = goalCommandEvidence(await getConversation(exact, deps)).receipts
      .find(item => item.workId === deps.workId);
    return receipt ? { state: 'matched', conversationId: exact, messageId: receipt.messageId,
      receiptMessageId: receipt.receiptMessageId, command: receipt.command || null } : { state: 'absent' };
  }
  const catalogue = exact ? { state: 'ready', items: [{ id: exact }] } : await nextGoalCandidates(deps);
  if (catalogue.state !== 'ready') return catalogue;
  const matches = [];
  for (const item of catalogue.items) {
    let proof;
    let cached = false;
    try {
      if (exact) proof = goalCommandEvidence(await getConversation(item.id, deps));
      else {
        const result = await discoveryRead('recent-evidence:' + item.id,
          shared => getConversation(item.id, shared).then(goalCommandEvidence), deps);
        proof = result.value;
        cached = result.cached;
      }
    } catch (error) { if ([403, 404].includes(error?.status)) continue; throw error; }
    let receipt = goalEvidenceForWork(proof, deps, exact);
    if (!receipt || !recentGoalEvidence(receipt, Number(deps.startedAt || 0))) continue;
    if (cached) {
      const expectedMessageId = receipt.messageId;
      receipt = goalEvidenceForWork(goalCommandEvidence(await getConversation(item.id, deps)), deps, exact);
      if (!receipt || receipt.messageId !== expectedMessageId
        || !recentGoalEvidence(receipt, Number(deps.startedAt || 0))) continue;
    }
    matches.push({ conversationId: item.id, messageId: receipt.messageId,
      receiptMessageId: receipt.receiptMessageId, command: receipt.command || null,
      ...(item.projectId || catalogue.projectId ? { projectId: item.projectId || catalogue.projectId } : {}) });
    if (matches.length > 1) return { state: 'ambiguous' };
  }
  finishDiscoveryPage(deps, catalogue);
  if (!matches.length) continueDiscovery(deps, exact);
  return matches[0] ? { state: 'matched', ...matches[0] } : { state: 'absent' };
}

async function findLinkedGoalCommand(deps) {
  let exact = '';
  try { exact = parseConversationUrl(deps.conversationCorrelation); } catch {}
  const catalogue = exact ? { state: 'ready', items: [{ id: exact }] } : await nextGoalCandidates(deps);
  if (catalogue.state !== 'ready') return catalogue;
  const findReceipt = proof => proof?.receipts.find(receipt => receipt.workId === deps.workId
    && receipt.linkId === deps.linkId && receipt.messageId && receipt.receiptMessageId);
  const matches = [];
  for (const item of catalogue.items) {
    let evidence;
    try { evidence = goalCommandEvidence(await getConversation(item.id, deps)); }
    catch (error) { if ([403, 404].includes(error?.status)) continue; throw error; }
    const receipt = findReceipt(evidence);
    if (!receipt) continue;
    matches.push({ conversationId: item.id, messageId: receipt.messageId,
      receiptMessageId: receipt.receiptMessageId, command: receipt.command || null,
      ...(item.projectId || catalogue.projectId ? { projectId: item.projectId || catalogue.projectId } : {}) });
    if (matches.length > 1) return { state: 'ambiguous' };
  }
  if (!matches.length) {
    finishDiscoveryPage(deps, catalogue);
    continueDiscovery(deps, exact);
    return { state: 'absent', reason: 'receipt_not_found' };
  }
  // Fresh active-branch read is mandatory even if a catalogue result was cached.
  const found = matches[0];
  const receipt = findReceipt(goalCommandEvidence(await getConversation(found.conversationId, deps)));
  if (!receipt || receipt.messageId !== found.messageId
    || receipt.receiptMessageId !== found.receiptMessageId) return { state: 'absent', reason: 'receipt_not_verified' };
  if (!deps.explicitGoal && receipt.command?.action !== 'start') {
    if (deps.discovery) deps.discovery.notRequested = true;
    return { state: 'absent', reason: 'goal_not_requested' };
  }
  return { state: 'matched', ...found };
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

function hasChatLinkReceipt(conversation, workId, linkId, binding) {
  return goalCommandEvidence(conversation).receipts.some(receipt => receipt.workId === workId
    && receipt.linkId === linkId && receipt.messageId === binding.messageId
    && receipt.receiptMessageId === binding.receiptMessageId);
}

function latestGoalCommand(conversation) {
  const latest = activeMessages(conversation).filter(node => node.message?.author?.role === 'user').at(-1);
  const command = parseGoalCommand(latest?.message);
  return command ? { ...command, messageId: String(latest.message.id || '').trim(),
    timestamp: Number(latest.message.create_time) * 1_000 } : null;
}

function initiatingGoalCommand(conversation, workId, startedAt) {
  const receipt = goalCommandEvidence(conversation).receipts.find(item =>
    item.workId === workId && item.command?.action === 'start' && recentGoalEvidence(item, startedAt));
  return receipt ? { ...receipt.command, messageId: receipt.messageId, timestamp: receipt.timestamp } : null;
}

function goalCommandEvidence(conversation) {
  // Receipt ancestry must outlive the bounded recent-turn context. Projection
  // already enforces the 100,000-node wire bound and discards tool bodies.
  const messages = activeMessages(conversation, 100_000);
  const command = messages.filter(n => n.message?.author?.role === 'user').at(-1);
  const parsed = latestGoalCommand(conversation);
  const receipts = [];
  let user = null;
  for (const node of messages) {
    if (node.message?.author?.role === 'user') user = node.message;
    if (node.message?.author?.role !== 'tool' || !user) continue;
    for (const receipt of node.message?.content?.workReceipts
      || (node.message?.content?.workIds || []).map(workId => ({ workId, linkId: '' }))) {
      // Work may start after a long reasoning/setup phase in the same turn.
      // Date its proof by the tool response; older responses without a timestamp
      // retain the conservative initiating-user fallback.
      receipts.push({ ...receipt, receiptMessageId: String(node.message.id || '').trim(),
        timestamp: Number(node.message.create_time ?? user.create_time) * 1_000,
        messageId: String(user.id || '').trim(), command: parseGoalCommand(user) });
    }
  }
  return {
    requested: parsed?.action === 'start',
    command: parsed,
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

function assertGoalCurrent(deps) {
  try { deps.signal?.throwIfAborted(); deps.assertCurrent?.(); }
  catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('Goal state changed before submission.'),
      { notSent: true });
  }
}

async function stopStalledTurn(id, expectedNodeId, deps = {}) {
  assertConversationId(id);
  if (!expectedNodeId) throw new Error('A confirmed stalled assistant node is required.');
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (!native) throw new Error('Stalled ChatGPT turn requires the signed-in desktop browser to stop it safely.');
  assertGoalCurrent(deps);
  const result = await native({ action: 'stop_stalled', conversationId: id, expectedNodeId,
    ...(deps.workId ? { workId: deps.workId, expectedGoalRevision: deps.expectedGoalRevision } : {}),
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
  const prompt = deps.prompt === undefined ? goalContinuationPrompt(deps.workId, deps.objective) : deps.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8192) {
    throw Object.assign(new Error('Goal continuation prompt must be 1-8192 characters.'), { notSent: true });
  }
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (native) {
    const scope = accountScope(deps);
    if (scope.cooldownUntil > Date.now()) throw Object.assign(rateLimitError(scope.cooldownUntil), { notSent: true });
    let result;
    try {
      assertGoalCurrent(deps);
      result = await native({ action: 'continue', conversationId: id, parentMessageId, expectedNodeId: deps.nodeId, prompt,
        ...(deps.expectedGoalRevision !== undefined ? { workId: deps.workId, expectedGoalRevision: deps.expectedGoalRevision } : {}),
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
    assertGoalCurrent(deps);
    const requirementPrepare = await requestChatgpt('/backend-api/sentinel/chat-requirements/prepare', {
      method: 'POST', body: {}, signal: deps.signal
    }, deps);
    const prepareChallenge = requiredChatgptChallenges(requirementPrepare, 'prepare');
    if (prepareChallenge) throw prepareChallenge;
    if (typeof requirementPrepare?.prepare_token !== 'string' || !requirementPrepare.prepare_token) {
      throw new Error('ChatGPT chat requirements preparation did not return a prepare token.');
    }
    assertGoalCurrent(deps);
    const requirement = await requestChatgpt('/backend-api/sentinel/chat-requirements/finalize', {
      method: 'POST', body: { prepare_token: requirementPrepare.prepare_token }, signal: deps.signal
    }, deps);
    const finalizeChallenge = requiredChatgptChallenges(requirement, 'finalize');
    if (finalizeChallenge) throw finalizeChallenge;
    if (typeof requirement?.token !== 'string' || !requirement.token) {
      throw new Error('ChatGPT requirements finalization returned no token; Goal Mode paused.');
    }
    assertGoalCurrent(deps);
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
    assertGoalCurrent(deps);
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

async function evaluateGoalHelper(packet, deps = {}) {
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (!native) throw Object.assign(new Error('Adaptive Goal/Loop evaluation requires the signed-in desktop helper.'),
    { code: 'GOAL_EVALUATOR_UNAVAILABLE' });
  const scope = accountScope(deps);
  if (scope.cooldownUntil > Date.now()) throw rateLimitError(scope.cooldownUntil);
  assertGoalCurrent(deps);
  const result = await native({ action: 'evaluate', packet,
    workId: packet?.evidence?.workId, expectedGoalRevision: packet?.expectedRevision,
    conversationId: deps.conversationId,
    ...(deps.tunnelId ? { tunnelId: deps.tunnelId } : {}) }, { signal: deps.signal });
  if (result?.status === 429) throw rememberRateLimit(Object.assign(
    protocolFailure('/backend-api/conversation/evaluate', 429, result.retryAfterMs),
    { deferred: true, notSent: result.notSent === true }), deps);
  return result;
}

export { hasChatLinkReceipt, latestGoalCommand, initiatingGoalCommand, evaluateGoalHelper, configureGoalBrowserTransport, hasGoalBrowserTransport, parseConversationUrl, chatgptCredentials, getConversation, activeMessages, turnState, findRecentGoalCommand, findGoalConversation, stopStalledTurn, goalContinuationPrompt, sendContinue };
