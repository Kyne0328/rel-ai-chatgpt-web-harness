// ChatGPT Web protocol adapter. Undocumented endpoints: fail closed on drift or challenges.
// Credentials are read from the process environment; never persist them with goal records.
import { randomUUID } from 'node:crypto';
import { readConversationProjection } from './chatgptConversationReader.js';

const ORIGIN = 'https://chatgpt.com';
let goalBrowserTransport = null;

function configureGoalBrowserTransport(transport) {
  if (transport !== null && typeof transport !== 'function') throw new TypeError('Goal browser transport must be a function or null.');
  goalBrowserTransport = transport;
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

function protocolFailure(path, status) {
  const stage = path.startsWith('/backend-api/f/conversation/prepare') ? 'conversation preparation'
    : path.startsWith('/backend-api/sentinel/chat-requirements') ? 'chat requirements'
      : path === '/backend-api/f/conversation' ? 'message submission' : 'conversation read';
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  return Object.assign(new Error(`ChatGPT Web ${stage} failed (HTTP ${httpStatus || 'unknown'}).`), {
    status: httpStatus, stage
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

async function requestChatgpt(path, options = {}, deps = {}) {
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (native) {
    const result = await native({ path, method: options.method || 'GET', body: options.body,
      headers: options.headers, raw: options.raw === true,
      ...(options.projectConversation ? { projectConversation: true } : {}) }, { signal: options.signal });
    if (!result?.ok) throw protocolFailure(path, result?.status);
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
  if (!response.ok) throw protocolFailure(path, response.status);
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

async function getConversation(id, deps = {}) {
  return requestChatgpt('/backend-api/conversation/' + assertConversationId(id),
    { signal: deps.signal, projectConversation: true }, deps);
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
  const candidates = [];
  for (const summary of await listConversations(deps)) {
    const id = String(summary.id || '');
    if (!UUID.test(id)) continue;
    const conversation = await getConversation(id, deps);
    // Only the latest user message may start a new goal. A previous /goal
    // followed by ordinary chat must not opt an unrelated task in later.
    const command = activeMessages(conversation).filter(n => n.message?.author?.role === 'user').at(-1);
    const text = messageText(command?.message).trim();
    if (!/^\/goal(?:\s|$)/i.test(text)
      || /^\/goal\s+(?:stop|cancel|status)(?:\s|$)/i.test(text)) continue;
    const timestamp = Number(command.message?.create_time) * 1000;
    // Only messages near this work's creation qualify. The objective may have
    // been rewritten by ChatGPT, so comparing its wording is not reliable.
    if (!startedAt || !Number.isFinite(timestamp) || timestamp < startedAt - 120_000
      || timestamp > startedAt + 15_000) continue;
    const messageId = String(command.message?.id || '').trim();
    if (!messageId) continue;
    candidates.push({ conversationId: id, messageId });
    if (candidates.length > 1) return { state: 'ambiguous' };
  }
  return candidates.length ? { state: 'matched', ...candidates[0] } : { state: 'absent' };
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
  const result = await native({ action: 'stop_stalled', conversationId: id, expectedNodeId }, { signal: deps.signal });
  if (result?.ok && result.stopped === true) return true;
  if (result?.ok && result.alreadyFinished === true) return false;
  throw new Error('Stalled ChatGPT response could not be stopped and verified; Goal Mode paused without sending.');
}

async function sendContinue(id, parentMessageId, deps = {}) {
  assertConversationId(id);
  if (!parentMessageId) throw new Error('A confirmed parent message is required.');
  if (!deps.workId || !deps.objective) throw new Error('Goal continuation requires the exact work ID and objective.');
  const prompt = 'Continue goal ' + deps.workId + ': ' + deps.objective + '. Inspect this exact Rel.AI work_id, operation receipts and task state first. Do not repeat completed changes or operations. If finished, explicitly close that work session. If blocked or awaiting user input, explain the blocker instead of retrying.';
  const native = deps.nativeTransport || (!deps.fetch && !deps.credentials ? goalBrowserTransport : null);
  if (native) {
    const result = await native({ action: 'continue', conversationId: id, parentMessageId, expectedNodeId: deps.nodeId, prompt }, { signal: deps.signal });
    if (result?.ok && result.accepted === true) return { accepted: true };
    const stage = ['navigation', 'composer', 'preflight', 'draft', 'send_button', 'submit', 'readback']
      .includes(result?.stage) ? ` (${result.stage})` : '';
    if (result?.needsUser) {
      const reason = result.reason === 'text_mismatch' ? 'Composer text could not be verified'
        : result.reason === 'send_unavailable' ? 'Send button was unavailable'
          : result.reason === 'verification' ? 'Browser verification is required'
            : result.reason === 'conversation_unavailable' ? 'The browser did not reach the linked ChatGPT conversation'
              : result.reason === 'composer_unavailable' ? 'The ChatGPT composer did not become ready'
                : result.reason === 'focus_unavailable' ? 'The ChatGPT composer could not receive input'
            : 'ChatGPT needs attention in the opened browser';
      throw new Error(`${reason}${stage}; Goal Mode paused without retrying.`);
    }
    if (result?.stale) throw new Error('ChatGPT conversation changed before sending. Goal Mode paused without retrying.');
    throw new Error(`ChatGPT browser send could not be verified${stage}; Goal Mode paused without retrying.`);
  }
  // Non-desktop development transport retains the fail-closed protocol flow.
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
}

export { configureGoalBrowserTransport, hasGoalBrowserTransport, parseConversationUrl, chatgptCredentials, getConversation, activeMessages, turnState, findRecentGoalCommand, findGoalConversation, stopStalledTurn, sendContinue };
