// ChatGPT Web protocol adapter. Undocumented endpoints: fail closed on drift or challenges.
// Credentials are read from the process environment; never persist them with goal records.
import { randomUUID } from 'node:crypto';

const ORIGIN = 'https://chatgpt.com';
let goalBrowserTransport = null;

function configureGoalBrowserTransport(transport) {
  if (transport !== null && typeof transport !== 'function') throw new TypeError('Goal browser transport must be a function or null.');
  goalBrowserTransport = transport;
}

function hasGoalBrowserTransport() { return typeof goalBrowserTransport === 'function'; }
const REQUEST_TIMEOUT_MS = 15_000;
const STREAM_TIMEOUT_MS = 2 * 60 * 60_000;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
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
  if (url.origin !== ORIGIN || !url.pathname.startsWith('/c/')) throw new Error('Only chatgpt.com/c/ conversation URLs are supported.');
  return assertConversationId(url.pathname.slice(3));
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

async function requestChatgpt(path, options = {}, deps = {}) {
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (native) {
    const result = await native({ path, method: options.method || 'GET', body: options.body,
      headers: options.headers, raw: options.raw === true }, { signal: options.signal });
    if (!result?.ok) throw Object.assign(new Error('ChatGPT Web request failed (' + (result?.status || 'unknown') + ').'), { status: result?.status || 0 });
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
  if (!response.ok) throw Object.assign(new Error('ChatGPT Web request failed (' + response.status + ').'), { status: response.status });
  if (options.raw) return response;
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

async function getConversation(id, deps = {}) {
  return requestChatgpt('/backend-api/conversation/' + assertConversationId(id), { signal: deps.signal }, deps);
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
    complete,
    userMessage: [...messages].reverse().find(n => n.message?.author?.role === 'user')?.message || null,
    messages
  };
}

async function findGoalConversation(objective, deps = {}) {
  const expected = String(objective || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const startedAt = Number(deps.startedAt || 0);
  if (!expected) return null;
  const candidates = [];
  for (const summary of await listConversations(deps)) {
    const id = String(summary.id || '');
    if (!UUID.test(id)) continue;
    const conversation = await getConversation(id, deps);
    const command = activeMessages(conversation).filter(n => n.message?.author?.role === 'user')
      .reverse().find(n => /^\/goal(?:\s|$)/i.test(messageText(n.message).trim()));
    if (!command) continue;
    const commandTimestamp = Number(command.message?.create_time);
    // A stale matching command from an old conversation must not bind a new goal.
    // ChatGPT message timestamps are in Unix seconds, not milliseconds.
    if (startedAt && (!Number.isFinite(commandTimestamp) || commandTimestamp <= 0
      || commandTimestamp * 1000 < startedAt - 120_000)) continue;
    const commandGoal = messageText(command.message).trim().replace(/^\/goal\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    // Bare /goal opts the current conversation in using the objective provided by
    // the ChatGPT workflow. Control commands never count as a new goal.
    if (commandGoal === expected || commandGoal === '') candidates.push(id);
    if (candidates.length > 1) return null; // Never guess which tab is owned.
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function sendContinue(id, parentMessageId, deps = {}) {
  assertConversationId(id);
  if (!parentMessageId) throw new Error('A confirmed parent message is required.');
  if (!deps.workId || !deps.objective) throw new Error('Goal continuation requires the exact work ID and objective.');
  // Do not attempt to circumvent sentinel proof-of-work or browser challenges.
  const prep = await requestChatgpt('/backend-api/f/conversation/prepare', {
    method: 'POST',
    body: { conversation_id: id, model: 'auto' }, signal: deps.signal
  }, deps);
  const conduit = prep?.conduit_token || prep?.token;
  if (!conduit || typeof conduit !== 'string') throw new Error('ChatGPT preparation did not provide a conduit token.');
  const requirement = await requestChatgpt('/backend-api/sentinel/chat-requirements', {
    method: 'POST', body: { p: null }, signal: deps.signal
  }, deps);
  if (!requirement?.token || requirement?.proofofwork?.required || requirement?.turnstile?.required) {
    throw new Error('ChatGPT requires interactive verification; Goal Mode was paused.');
  }
  const response = await requestChatgpt('/backend-api/f/conversation', {
    method: 'POST', raw: true, signal: deps.signal,
    headers: { accept: 'text/event-stream', 'x-conduit-token': conduit,
      'openai-sentinel-chat-requirements-token': requirement.token },
    body: {
      action: 'next', conversation_id: id, parent_message_id: parentMessageId,
      client_prepare_state: 'success', model: 'auto',
      messages: [{ id: randomUUID(), author: { role: 'user' },
        content: { content_type: 'text', parts: ['Continue goal ' + deps.workId + ': ' + deps.objective + '. Inspect this exact Rel.AI work_id, operation receipts and task state first. Do not repeat completed changes or operations. If finished, explicitly close that work session. If blocked or awaiting user input, explain the blocker instead of retrying.'] } }]
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
}

export { configureGoalBrowserTransport, hasGoalBrowserTransport, assertConversationId, parseConversationUrl, chatgptCredentials, getConversation, listConversations, activeMessages, messageText, turnState, findGoalConversation, sendContinue };
