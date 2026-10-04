import * as crypto from 'node:crypto';
import * as dns from 'node:dns/promises';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../durableState.ts';
import { getStateDir } from '../statePaths.js';
import { requestStateKey } from './context.js';
import { principalFingerprint } from './principal.ts';
import { stableJson } from '../stableJson.js';

type JsonRecord = Record<string, unknown>;

interface McpEventSubscription {
  id: string;
  principalFingerprint: string;
  name: string;
  arguments: JsonRecord;
  callbackUrl: string;
  sealedSecret: string;
  previousSealedSecret?: string;
  previousSecretValidUntil?: string;
  refreshBefore: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string;
}

interface EventStore {
  version: 1;
  subscriptions: McpEventSubscription[];
}

interface PublishedMcpEvent {
  principalFingerprint: string;
  name: string;
  data: JsonRecord;
  timestamp?: string;
}

const STORE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const CALLBACK_TIMEOUT_MS = 10_000;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_WEBHOOK_RESPONSE_BYTES = 64 * 1024;
const VERIFICATION_CACHE_MS = 10 * 60 * 1000;
const SECRET_ROTATION_WINDOW_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([0, 250, 1_000, 3_000]);

const EVENT_DEFINITIONS = Object.freeze([
  workEventDefinition('work.completed', 'A durable Rel.AI work session completed.'),
  workEventDefinition('work.failed', 'A durable Rel.AI work session failed.'),
  workEventDefinition('work.cancelled', 'A durable Rel.AI work session was cancelled.'),
  operationEventDefinition('operation.completed', 'A long-running Rel.AI operation completed.'),
  operationEventDefinition('operation.failed', 'A Rel.AI operation failed.'),
  operationEventDefinition('operation.cancelled', 'A long-running Rel.AI operation was cancelled.'),
  processEventDefinition('process.exited', 'A managed Rel.AI process exited.'),
  processEventDefinition('process.failed', 'A managed Rel.AI process failed.'),
  processEventDefinition('process.orphaned', 'A managed Rel.AI process could not be confirmed stopped.')
]);

const EVENT_NAMES = new Set(EVENT_DEFINITIONS.map(event => event.name));
const verificationCache = new Map<string, number>();

function workEventDefinition(name: string, description: string): JsonRecord {
  return eventDefinition(name, description, {
    workspace: stringFilter('Workspace alias to monitor.'),
    work_id: stringFilter('Exact durable Rel.AI work_id to monitor.')
  }, {
    workspace: { type: 'string' },
    work_id: { type: 'string' },
    status: { type: 'string' },
    operation: { type: 'string' },
    summary: { type: 'string' }
  }, ['workspace', 'work_id', 'status']);
}

function operationEventDefinition(name: string, description: string): JsonRecord {
  return eventDefinition(name, description, {
    workspace: stringFilter('Workspace alias to monitor.'),
    work_id: stringFilter('Exact durable Rel.AI work_id to monitor.')
  }, {
    workspace: { type: 'string' },
    work_id: { type: 'string' },
    operation_id: { type: 'string' },
    tool: { type: 'string' },
    status: { type: 'string' },
    error: { type: 'string' }
  }, ['workspace', 'operation_id', 'tool', 'status']);
}

function processEventDefinition(name: string, description: string): JsonRecord {
  return eventDefinition(name, description, {
    workspace: stringFilter('Workspace alias to monitor.'),
    work_id: stringFilter('Owning durable Rel.AI work_id to monitor.'),
    process_id: stringFilter('Exact managed process ID to monitor.')
  }, {
    workspace: { type: 'string' },
    work_id: { type: 'string' },
    process_id: { type: 'string' },
    label: { type: 'string' },
    status: { type: 'string' },
    exit_code: { type: ['integer', 'null'] }
  }, ['workspace', 'process_id', 'status']);
}

function eventDefinition(
  name: string,
  description: string,
  inputProperties: JsonRecord,
  payloadProperties: JsonRecord,
  payloadRequired: string[]
): JsonRecord {
  return Object.freeze({
    name,
    description,
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: inputProperties,
      additionalProperties: false
    },
    payloadSchema: {
      type: 'object',
      properties: payloadProperties,
      required: payloadRequired,
      additionalProperties: false
    }
  });
}

function stringFilter(description: string): JsonRecord {
  return { type: 'string', minLength: 1, description };
}

async function handleMcpEventRequest(
  config: JsonRecord,
  principal: unknown,
  message: JsonRecord
): Promise<JsonRecord | null> {
  const method = String(message.method || '');
  if (!['events/list', 'events/subscribe', 'events/unsubscribe'].includes(method)) return null;
  const id = message.id as string | number | null | undefined;
  try {
    const params = objectValue(message.params);
    const owner = principalFingerprint(principal);
    if (!owner) throw eventError(-32001, 'Authenticated principal is required for MCP Events.');

    if (method === 'events/list') {
      return jsonRpcResult(id, { events: EVENT_DEFINITIONS });
    }
    if (method === 'events/subscribe') {
      const result = await subscribeToEvent(config, owner, params);
      return jsonRpcResult(id, result);
    }
    await unsubscribeFromEvent(config, owner, params);
    return jsonRpcResult(id, {});
  } catch (error) {
    const typed = eventErrorOf(error);
    return {
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: typed.code,
        message: typed.message,
        ...(typed.data ? { data: typed.data } : {})
      }
    };
  }
}

async function subscribeToEvent(config: JsonRecord, owner: string, params: JsonRecord): Promise<JsonRecord> {
  const name = String(params.name || '');
  const definition = EVENT_DEFINITIONS.find(event => event.name === name);
  if (!definition) throw eventError(-32602, `Unknown MCP event: ${name || 'missing'}.`);

  const args = validateEventArguments(definition, objectValue(params.arguments));
  const delivery = objectValue(params.delivery);
  if (String(delivery.mode || '') !== 'webhook') {
    throw eventError(-32602, 'MCP Events requires delivery.mode "webhook".');
  }
  const callbackUrl = await validateCallbackUrl(delivery.url);
  const secret = validateSigningSecret(delivery.secret);
  const refreshBefore = grantedRefreshBefore(params.ttlMs);
  const identity = subscriptionIdentity(owner, callbackUrl.href, name, args);
  const id = `sub_${crypto.createHash('sha256').update(identity).digest('base64url').slice(0, 40)}`;
  const now = new Date().toISOString();

  if (!verificationCached(owner, callbackUrl.href)) {
    await verifyCallback(id, callbackUrl, secret);
    verificationCache.set(verificationCacheKey(owner, callbackUrl.href), Date.now() + VERIFICATION_CACHE_MS);
  }

  const store = readEventStore(config);
  const existing = store.subscriptions.find(item => item.id === id);
  const rotation = rotatedSecretState(config, existing, secret, Date.now());
  const record: McpEventSubscription = {
    id,
    principalFingerprint: owner,
    name,
    arguments: args,
    callbackUrl: callbackUrl.href,
    sealedSecret: sealSecret(config, secret),
    ...rotation,
    refreshBefore,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    verifiedAt: now
  };
  store.subscriptions = [
    ...store.subscriptions.filter(item => item.id !== id),
    record
  ];
  writeEventStore(config, store);
  return { id, refreshBefore, cursor: null, truncated: false };
}

async function unsubscribeFromEvent(config: JsonRecord, owner: string, params: JsonRecord): Promise<void> {
  const name = String(params.name || '');
  if (!EVENT_NAMES.has(name)) return;
  const definition = EVENT_DEFINITIONS.find(event => event.name === name);
  const args = validateEventArguments(definition as JsonRecord, objectValue(params.arguments));
  const delivery = objectValue(params.delivery);
  const callbackUrl = await validateCallbackUrl(delivery.url);
  const id = `sub_${crypto.createHash('sha256')
    .update(subscriptionIdentity(owner, callbackUrl.href, name, args))
    .digest('base64url')
    .slice(0, 40)}`;
  const store = readEventStore(config);
  const remaining = store.subscriptions.filter(item => item.id !== id || item.principalFingerprint !== owner);
  if (remaining.length === store.subscriptions.length) return;
  store.subscriptions = remaining;
  writeEventStore(config, store);
}

async function publishMcpEvent(config: JsonRecord, event: PublishedMcpEvent): Promise<boolean> {
  if (!config || !event.principalFingerprint || !EVENT_NAMES.has(event.name)) return false;
  const subscriptions = readEventStore(config).subscriptions.filter(item =>
    item.principalFingerprint === event.principalFingerprint
    && item.name === event.name
    && subscriptionMatches(item.arguments, event.data)
  );
  if (!subscriptions.length) return false;

  const eventId = `evt_${crypto.randomUUID()}`;
  const payload = {
    eventId,
    name: event.name,
    timestamp: event.timestamp || new Date().toISOString(),
    data: event.data,
    cursor: null
  };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_EVENT_BYTES) {
    debug('event payload exceeds 256 KiB');
    return false;
  }
  const deliveries = await Promise.allSettled(
    subscriptions.map(subscription => deliverEvent(config, subscription, eventId, body))
  );
  return deliveries.some(result => result.status === 'fulfilled' && result.value === true);
}

async function deliverEvent(
  config: JsonRecord,
  subscription: McpEventSubscription,
  eventId: string,
  body: string
): Promise<boolean> {
  const url = await validateCallbackUrl(subscription.callbackUrl);
  const secrets = deliverySecrets(config, subscription);
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    const delay = RETRY_DELAYS_MS[attempt] || 0;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let response: WebhookResponse;
    try {
      response = await signedWebhookPost(url, subscription.id, eventId, secrets, body);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code === -32602 || code === 'MCP_EVENT_RESPONSE_TOO_LARGE') return false;
      if (attempt === RETRY_DELAYS_MS.length - 1) debug('event delivery failed after bounded retries');
      continue;
    }
    if (response.status >= 200 && response.status < 300) return true;
    if (response.status === 410) {
      removeSubscription(config, subscription);
      return false;
    }
    if (response.status === 413) return false;
  }
  return false;
}

async function verifyCallback(id: string, url: URL, secret: string): Promise<void> {
  const challenge = crypto.randomBytes(24).toString('base64url');
  const webhookId = `msg_verification_${crypto.randomUUID()}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  let response: WebhookResponse;
  try {
    response = await signedWebhookPost(url, id, webhookId, [secret], body);
  } catch (error) {
    throw eventError(-32015, 'MCP Events callback verification failed.', {
      reason: error instanceof Error && /timed out/i.test(error.message) ? 'timeout' : 'connection_failed'
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw eventError(-32015, 'MCP Events callback verification failed.', {
      reason: 'challenge_failed',
      status: response.status
    });
  }
  let echoed = '';
  try { echoed = String(JSON.parse(response.body || '{}').challenge || ''); } catch {}
  if (!constantTimeEqual(challenge, echoed)) {
    throw eventError(-32015, 'MCP Events callback verification failed.', { reason: 'challenge_failed' });
  }
}

interface WebhookResponse {
  status: number;
  body: string;
}

async function signedWebhookPost(
  url: URL,
  subscriptionId: string,
  webhookId: string,
  secrets: string | string[],
  body: string
): Promise<WebhookResponse> {
  const address = await resolvePublicAddress(url.hostname);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = (Array.isArray(secrets) ? secrets : [secrets])
    .map(secret => standardWebhookSignature(secret, webhookId, timestamp, body))
    .join(' ');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let request: ReturnType<typeof https.request> | null = null;
    let activeResponse: IncomingMessage | null = null;
    const finish = (error: unknown, result?: WebhookResponse): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (result) resolve(result);
      else reject(error);
    };
    const abort = (error: Error): void => {
      if (settled) return;
      finish(error);
      activeResponse?.destroy(error);
      request?.destroy(error);
    };
    try {
      request = https.request(url, {
        method: 'POST',
        agent: false,
        servername: url.hostname,
        timeout: CALLBACK_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          'webhook-id': webhookId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
          'X-MCP-Subscription-Id': subscriptionId
        },
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }
      }, response => {
        activeResponse = response;
        response.once('error', abort);
        response.once('aborted', () => abort(new Error('MCP Events callback response was aborted.')));
        const status = Number(response.statusCode || 0);
        if (status === 410 || status === 413) {
          finish(null, { status, body: '' });
          response.destroy();
          request?.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > MAX_WEBHOOK_RESPONSE_BYTES) {
            const error = Object.assign(new Error('MCP Events callback response exceeded 64 KiB.'), { code: 'MCP_EVENT_RESPONSE_TOO_LARGE' });
            abort(error);
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(null, {
          status: Number(response.statusCode || 0),
          body: Buffer.concat(chunks).toString('utf8')
        }));
      });
      if (settled) return;
      // Socket inactivity alone does not bound a peer that keeps streaming.
      // Keep the complete HTTP request and response inside the same deadline.
      timer = setTimeout(() => abort(new Error('MCP Events callback timed out.')), CALLBACK_TIMEOUT_MS);
      request.once('timeout', () => abort(new Error('MCP Events callback timed out.')));
      request.once('error', error => {
        if (settled) return;
        finish(error);
        activeResponse?.destroy();
      });
      request.end(body);
    } catch (error) {
      abort(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function standardWebhookSignature(secret: string, webhookId: string, timestamp: string, body: string): string {
  const key = decodeSigningSecret(secret);
  const message = `${webhookId}.${timestamp}.${body}`;
  const signature = crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64');
  return `v1,${signature}`;
}

async function validateCallbackUrl(value: unknown): Promise<URL> {
  let url: URL;
  try { url = new URL(String(value || '')); }
  catch { throw eventError(-32602, 'MCP Events callback URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw eventError(-32602, 'MCP Events callback URL must use HTTPS without credentials or fragments.');
  }
  await resolvePublicAddress(url.hostname);
  return url;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  const normalized = String(hostname || '').trim().toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw eventError(-32602, 'MCP Events callback must resolve to a public network address.');
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw eventError(-32015, 'MCP Events callback hostname could not be resolved.', { reason: 'dns_failed' });
  }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw eventError(-32602, 'MCP Events callback must resolve only to public network addresses.');
  }
  const first = addresses[0];
  if (!first) throw eventError(-32015, 'MCP Events callback hostname could not be resolved.', { reason: 'dns_failed' });
  return first;
}

function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    const a = octets[0] as number;
    const b = octets[1] as number;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') return false;
    if (value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return false;
    if (value.startsWith('ff')) return false;
    if (value.startsWith('2001:db8:')) return false;
    if (value.startsWith('::ffff:')) return isPublicAddress(value.slice(7));
    return true;
  }
  return false;
}

function validateSigningSecret(value: unknown): string {
  const secret = String(value || '');
  decodeSigningSecret(secret);
  return secret;
}

function decodeSigningSecret(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) {
    throw eventError(-32602, 'MCP Events signing secret must start with whsec_.');
  }
  const encoded = secret.slice('whsec_'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw eventError(-32602, 'MCP Events signing secret is not valid base64.');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64) {
    throw eventError(-32602, 'MCP Events signing secret must decode to 24-64 bytes.');
  }
  return key;
}

function validateEventArguments(definition: JsonRecord, args: JsonRecord): JsonRecord {
  const schema = objectValue(definition.inputSchema);
  const properties = objectValue(schema.properties);
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) throw eventError(-32602, `Unsupported event filter: ${key}.`);
    if (typeof args[key] !== 'string' || !String(args[key]).trim()) {
      throw eventError(-32602, `Event filter ${key} must be a non-empty string.`);
    }
  }
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value).trim()]));
}

function grantedRefreshBefore(ttlValue: unknown): string | null {
  if (ttlValue === null) return null;
  const requested = ttlValue === undefined ? DEFAULT_TTL_MS : Number(ttlValue);
  if (!Number.isFinite(requested) || requested <= 0) {
    throw eventError(-32602, 'ttlMs must be a positive number, null, or omitted.');
  }
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(requested)));
  return new Date(Date.now() + ttl).toISOString();
}

function subscriptionIdentity(owner: string, url: string, name: string, args: JsonRecord): string {
  return stableJson({ owner, url, name, arguments: args });
}

function subscriptionMatches(filters: JsonRecord, data: JsonRecord): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (String(data[key] || '') !== String(value || '')) return false;
  }
  return true;
}

function subscriptionExpired(subscription: McpEventSubscription, now = Date.now()): boolean {
  if (!subscription.refreshBefore) return false;
  const expires = Date.parse(subscription.refreshBefore);
  return !Number.isFinite(expires) || expires <= now;
}

function rotatedSecretState(
  config: JsonRecord,
  existing: McpEventSubscription | undefined,
  nextSecret: string,
  now = Date.now()
): Pick<McpEventSubscription, 'previousSealedSecret' | 'previousSecretValidUntil'> {
  if (!existing) return {};
  let currentSecret = '';
  try { currentSecret = openSecret(config, existing.sealedSecret); } catch {}
  if (currentSecret && !constantTimeEqual(currentSecret, nextSecret)) {
    return {
      previousSealedSecret: existing.sealedSecret,
      previousSecretValidUntil: new Date(now + SECRET_ROTATION_WINDOW_MS).toISOString()
    };
  }
  const previousSecretValidUntil = existing.previousSecretValidUntil;
  const previousUntil = Date.parse(String(previousSecretValidUntil || ''));
  if (existing.previousSealedSecret && previousSecretValidUntil && Number.isFinite(previousUntil) && previousUntil > now) {
    return {
      previousSealedSecret: existing.previousSealedSecret,
      previousSecretValidUntil
    };
  }
  return {};
}

function deliverySecrets(config: JsonRecord, subscription: McpEventSubscription, now = Date.now()): string[] {
  const secrets = [openSecret(config, subscription.sealedSecret)];
  const previousUntil = Date.parse(String(subscription.previousSecretValidUntil || ''));
  if (subscription.previousSealedSecret && Number.isFinite(previousUntil) && previousUntil > now) {
    try { secrets.push(openSecret(config, subscription.previousSealedSecret)); } catch {}
  }
  return secrets;
}

function removeSubscription(config: JsonRecord, delivered: McpEventSubscription): void {
  const store = readEventStore(config);
  const remaining = store.subscriptions.filter(item =>
    item.id !== delivered.id || item.updatedAt !== delivered.updatedAt
  );
  if (remaining.length === store.subscriptions.length) return;
  writeEventStore(config, { version: STORE_VERSION, subscriptions: remaining });
}

function verificationCached(owner: string, url: string): boolean {
  const key = verificationCacheKey(owner, url);
  const until = Number(verificationCache.get(key) || 0);
  if (until > Date.now()) return true;
  verificationCache.delete(key);
  return false;
}

function verificationCacheKey(owner: string, url: string): string {
  return `${owner}\0${url}`;
}

function eventStorePath(config: JsonRecord): string {
  return path.join(getStateDir(config), 'mcp-event-subscriptions.json');
}

function readEventStore(config: JsonRecord): EventStore {
  const file = eventStorePath(config);
  const value = readJsonFile(file, {
    fallback: null,
    mode: 0o600,
    validate: candidate => {
      const record = objectValue(candidate);
      return record.version === STORE_VERSION && Array.isArray(record.subscriptions);
    }
  }) as EventStore | null;
  if (!value) return { version: STORE_VERSION, subscriptions: [] };
  const valid = value.subscriptions.filter(item => validStoredSubscription(item));
  const active = valid.filter(item => !subscriptionExpired(item));
  if (active.length !== value.subscriptions.length) {
    writeEventStore(config, { version: STORE_VERSION, subscriptions: active });
  }
  return { version: STORE_VERSION, subscriptions: active };
}

function writeEventStore(config: JsonRecord, store: EventStore): void {
  writeJsonAtomic(eventStorePath(config), {
    version: STORE_VERSION,
    subscriptions: store.subscriptions
  }, { mode: 0o600, backup: true });
}

function validStoredSubscription(value: unknown): value is McpEventSubscription {
  const item = objectValue(value);
  return typeof item.id === 'string'
    && typeof item.principalFingerprint === 'string'
    && typeof item.name === 'string'
    && EVENT_NAMES.has(item.name)
    && isPlainObject(item.arguments)
    && typeof item.callbackUrl === 'string'
    && typeof item.sealedSecret === 'string'
    && (item.previousSealedSecret === undefined || typeof item.previousSealedSecret === 'string')
    && (item.previousSecretValidUntil === undefined || typeof item.previousSecretValidUntil === 'string')
    && (item.refreshBefore === null || typeof item.refreshBefore === 'string');
}

function sealSecret(config: JsonRecord, secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', eventSecretKey(config), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

function openSecret(config: JsonRecord, value: string): string {
  const encoded = Buffer.from(String(value || ''), 'base64url');
  if (encoded.length < 29) throw new Error('Invalid MCP Events stored secret.');
  const iv = encoded.subarray(0, 12);
  const tag = encoded.subarray(12, 28);
  const ciphertext = encoded.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', eventSecretKey(config), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function eventSecretKey(config: JsonRecord): Buffer {
  return crypto.createHash('sha256')
    .update(requestStateKey(config), 'utf8')
    .update('\0relai-mcp-events-v1', 'utf8')
    .digest();
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jsonRpcResult(id: unknown, result: JsonRecord): JsonRecord {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function eventError(code: number, message: string, data?: JsonRecord): Error & { code: number; data?: JsonRecord } {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) });
}

function eventErrorOf(error: unknown): { code: number; message: string; data?: JsonRecord } {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') {
    return {
      code: error.code,
      message: error instanceof Error ? error.message : String((error as JsonRecord).message || 'MCP Events request failed.'),
      ...(('data' in error && isPlainObject(error.data)) ? { data: error.data as JsonRecord } : {})
    };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : 'MCP Events request failed.'
  };
}

function objectValue(value: unknown): JsonRecord {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function debug(message: string): void {
  if (process.env.REL_AI_MCP_DEBUG) console.error(`[rel-ai-mcp] MCP Events: ${message}`);
}

export {
  EVENT_DEFINITIONS,
  handleMcpEventRequest,
  publishMcpEvent,
  standardWebhookSignature
};
