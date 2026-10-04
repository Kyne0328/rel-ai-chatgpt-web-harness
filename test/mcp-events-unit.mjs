import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';

const originalHttpsRequest = https.request;
const originalDnsLookup = dns.lookup;
const callbackRequests = [];
const eventStatuses = [];
const callbackServer = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  let json = {};
  try { json = JSON.parse(body || '{}'); } catch {}
  callbackRequests.push({ headers: request.headers, body, json });
  if (json.type === 'verification') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ challenge: json.challenge }));
    return;
  }
  const status = eventStatuses.shift() ?? 200;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end('{}');
});
await new Promise((resolve, reject) => {
  callbackServer.once('error', reject);
  callbackServer.listen(0, '127.0.0.1', resolve);
});
const callbackAddress = callbackServer.address();
if (!callbackAddress || typeof callbackAddress === 'string') throw new Error('MCP Events test callback server did not bind.');
const callbackPort = callbackAddress.port;
const callbackUrl = 'https://events.example.test/callback';

https.request = (url, options, callback) => {
  const target = url instanceof URL ? url : new URL(String(url));
  return http.request({
    hostname: '127.0.0.1',
    port: callbackPort,
    path: `${target.pathname}${target.search}`,
    method: options?.method || 'POST',
    headers: options?.headers,
    timeout: options?.timeout
  }, callback);
};
dns.lookup = async (_hostname, options = {}) => options.all
  ? [{ address: '8.8.8.8', family: 4 }]
  : { address: '8.8.8.8', family: 4 };
syncBuiltinESMExports();

const {
  EVENT_DEFINITIONS,
  handleMcpEventRequest,
  publishMcpEvent,
  standardWebhookSignature
} = await import('../src/mcp/events.ts');
const { acknowledgeFallbackCompletionDelivery } = await import('../src/mcp/fallbackExecutions.js');
const { enrichWithFallbackCompletions } = await import('../src/mcp/toolInvocation.js');
const { principalFingerprint } = await import('../src/mcp/principal.ts');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-mcp-events-'));
const config = { stateDir };
const principal = 'events-unit-principal';
const owner = principalFingerprint(principal);
const workspace = 'repo';
const eventStore = path.join(stateDir, 'mcp-event-subscriptions.json');

try {
  const eventNames = EVENT_DEFINITIONS.map(event => event.name);
  assert.deepEqual(eventNames, [
    'work.completed',
    'work.failed',
    'work.cancelled',
    'operation.completed',
    'operation.failed',
    'operation.cancelled',
    'process.exited',
    'process.failed',
    'process.orphaned'
  ]);
  for (const event of EVENT_DEFINITIONS) {
    assert.deepEqual(event.delivery, ['webhook']);
    assert.equal(event.inputSchema?.type, 'object');
    assert.equal(event.payloadSchema?.type, 'object');
  }

  const listed = await handleMcpEventRequest(config, principal, {
    jsonrpc: '2.0',
    id: 1,
    method: 'events/list',
    params: {}
  });
  assert.equal(listed?.error, undefined);
  assert.deepEqual(listed?.result?.events?.map(event => event.name), eventNames);

  const unsafeSubscription = await handleMcpEventRequest(config, principal, {
    jsonrpc: '2.0',
    id: 2,
    method: 'events/subscribe',
    params: {
      name: 'work.completed',
      arguments: { workspace },
      delivery: {
        mode: 'webhook',
        url: 'http://127.0.0.1:9999/callback',
        secret: `whsec_${Buffer.alloc(32, 9).toString('base64')}`
      }
    }
  });
  assert.equal(unsafeSubscription?.error?.code, -32602);
  assert.match(unsafeSubscription?.error?.message || '', /HTTPS/i);

  const signingSecret = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
  const webhookId = 'msg_test_123';
  const timestamp = '1770000000';
  const body = JSON.stringify({ type: 'verification', challenge: 'challenge-test' });
  const expectedSignature = crypto
    .createHmac('sha256', Buffer.alloc(32, 3))
    .update(`${webhookId}.${timestamp}.${body}`, 'utf8')
    .digest('base64');
  assert.equal(
    standardWebhookSignature(signingSecret, webhookId, timestamp, body),
    `v1,${expectedSignature}`
  );

  const liveSecretA = `whsec_${Buffer.alloc(32, 4).toString('base64')}`;
  const liveSecretB = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
  const liveSubscription = await handleMcpEventRequest(config, principal, {
    jsonrpc: '2.0',
    id: 3,
    method: 'events/subscribe',
    params: {
      name: 'operation.completed',
      arguments: { workspace, work_id: 'work-live' },
      delivery: { mode: 'webhook', url: callbackUrl, secret: liveSecretA }
    }
  });
  assert.equal(liveSubscription?.error, undefined, JSON.stringify(liveSubscription));
  assert.ok(liveSubscription?.result?.id);
  assert.equal(readSubscriptions().length, 1);

  const verificationRequest = callbackRequests.find(item => item.json?.type === 'verification');
  assert.ok(verificationRequest, 'subscription must verify the callback before durable storage');
  assert.equal(
    String(verificationRequest.headers['webhook-signature'] || ''),
    standardWebhookSignature(
      liveSecretA,
      String(verificationRequest.headers['webhook-id'] || ''),
      String(verificationRequest.headers['webhook-timestamp'] || ''),
      verificationRequest.body
    ),
    'callback verification must use the supplied signing secret'
  );

  const requestCountBeforeFilterMismatch = callbackRequests.length;
  const liveFilteredOut = await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-other',
      operation_id: 'fallback_other',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  });
  assert.equal(liveFilteredOut, false);
  assert.equal(callbackRequests.length, requestCountBeforeFilterMismatch,
    'a filtered non-match must not contact the webhook');

  eventStatuses.push(500, 200);
  const requestCountBeforeRetry = callbackRequests.length;
  const retriedDelivery = await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-live',
      operation_id: 'fallback_live',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  });
  assert.equal(retriedDelivery, true, 'a transient webhook failure must retry and succeed');
  const retryRequests = callbackRequests.slice(requestCountBeforeRetry)
    .filter(item => item.json?.name === 'operation.completed');
  assert.equal(retryRequests.length, 2, 'one 500 response must cause exactly one retry before success');
  const deliveredRequest = retryRequests.at(-1);
  assert.equal(
    String(deliveredRequest.headers['webhook-signature'] || ''),
    standardWebhookSignature(
      liveSecretA,
      String(deliveredRequest.headers['webhook-id'] || ''),
      String(deliveredRequest.headers['webhook-timestamp'] || ''),
      deliveredRequest.body
    ),
    'terminal event delivery must be signed with the active secret'
  );

  const rotatedSubscription = await handleMcpEventRequest(config, principal, {
    jsonrpc: '2.0',
    id: 4,
    method: 'events/subscribe',
    params: {
      name: 'operation.completed',
      arguments: { workspace, work_id: 'work-live' },
      delivery: { mode: 'webhook', url: callbackUrl, secret: liveSecretB }
    }
  });
  assert.equal(rotatedSubscription?.result?.id, liveSubscription?.result?.id,
    'refreshing the same subscription identity must retain its subscription id');
  assert.ok(readSubscriptions()[0]?.previousSealedSecret,
    'secret rotation must retain the previous secret during the overlap window');

  eventStatuses.push(200);
  const requestCountBeforeRotationDelivery = callbackRequests.length;
  const rotatedDelivery = await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-live',
      operation_id: 'fallback_rotated',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  });
  assert.equal(rotatedDelivery, true);
  const rotatedRequest = callbackRequests.slice(requestCountBeforeRotationDelivery)
    .find(item => item.json?.name === 'operation.completed');
  assert.ok(rotatedRequest);
  const rotatedWebhookId = String(rotatedRequest.headers['webhook-id'] || '');
  const rotatedTimestamp = String(rotatedRequest.headers['webhook-timestamp'] || '');
  assert.equal(
    String(rotatedRequest.headers['webhook-signature'] || ''),
    [
      standardWebhookSignature(liveSecretB, rotatedWebhookId, rotatedTimestamp, rotatedRequest.body),
      standardWebhookSignature(liveSecretA, rotatedWebhookId, rotatedTimestamp, rotatedRequest.body)
    ].join(' '),
    'secret rotation must sign with both the new and previous secret during overlap'
  );

  eventStatuses.push(410);
  const goneDelivery = await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-live',
      operation_id: 'fallback_gone',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  });
  assert.equal(goneDelivery, false);
  assert.equal(readSubscriptions().length, 0, 'HTTP 410 must remove the dead subscription');

  const callbackCountAfterGone = callbackRequests.length;
  assert.equal(await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-live',
      operation_id: 'fallback_after_gone',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  }), false);
  assert.equal(callbackRequests.length, callbackCountAfterGone,
    'a removed 410 subscription must not be contacted again');

  const resubscribed = await handleMcpEventRequest(config, principal, {
    jsonrpc: '2.0',
    id: 5,
    method: 'events/subscribe',
    params: {
      name: 'operation.completed',
      arguments: { workspace, work_id: 'work-live' },
      delivery: { mode: 'webhook', url: callbackUrl, secret: liveSecretB }
    }
  });
  assert.equal(resubscribed?.error, undefined, JSON.stringify(resubscribed));
  const unsubscribed = await handleMcpEventRequest(config, principal, {
    jsonrpc: '2.0',
    id: 6,
    method: 'events/unsubscribe',
    params: {
      name: 'operation.completed',
      arguments: { workspace, work_id: 'work-live' },
      delivery: { mode: 'webhook', url: callbackUrl }
    }
  });
  assert.equal(unsubscribed?.error, undefined, JSON.stringify(unsubscribed));
  assert.equal(readSubscriptions().length, 0, 'events/unsubscribe must remove the exact subscription');

  writeSubscriptionStore([
    subscription('operation.completed', { workspace, work_id: 'work-a' })
  ]);
  const filteredOut = await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-b',
      operation_id: 'fallback_work_b',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  });
  assert.equal(filteredOut, false, 'a work_id-filtered subscription must not match a different work session');
  assert.equal(readSubscriptions().length, 1, 'a filter mismatch must not mutate an active subscription');

  seedCompletionNotice('completed', 'work-b');
  const exactButUndelivered = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace },
    { ok: true, workspace },
    { principal, requestId: 21 }
  );
  assert.equal(
    exactButUndelivered.completedOperations?.[0]?.work_id,
    'work-b',
    'the existence of an Events subscription must never suppress a durable fallback notice'
  );
  assert.equal(acknowledgeFallbackCompletionDelivery(owner, 21), true);

  writeSubscriptionStore([
    subscription('operation.completed', { workspace, work_id: 'work-b' })
  ]);
  seedCompletionNotice('completed', 'work-b');
  const queuedBeforeWebhook = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace },
    { ok: true, workspace },
    { principal, requestId: 22 }
  );
  assert.equal(
    queuedBeforeWebhook.completedOperations?.length,
    1,
    'an already queued completion remains deliverable until a response is confirmed, even when an exact subscription exists'
  );
  assert.equal(acknowledgeFallbackCompletionDelivery(owner, 22), true);

  writeSubscriptionStore([
    subscription('operation.completed', { workspace }, { expired: true })
  ]);
  const expiredDelivery = await publishMcpEvent(config, {
    principalFingerprint: owner,
    name: 'operation.completed',
    data: {
      workspace,
      work_id: 'work-expired',
      operation_id: 'fallback_expired',
      tool: 'relai_exec',
      status: 'completed',
      error: ''
    }
  });
  assert.equal(expiredDelivery, false);
  assert.deepEqual(readSubscriptions(), [], 'expired MCP Events subscriptions must be pruned from durable state');

  writeSubscriptionStore([]);
  seedCompletionNotice('completed', 'work-fallback');
  const fallback = enrichWithFallbackCompletions(
    config,
    'relai_read',
    { workspace },
    { ok: true, workspace },
    { principal, requestId: 23 }
  );
  assert.equal(fallback.completedOperations?.length, 1);
  assert.equal(fallback.completedOperations?.[0]?.status, 'completed');
  assert.equal(acknowledgeFallbackCompletionDelivery(owner, 23), true);

  console.log('MCP Events definitions, callback verification, signing, retry, filter matching, secret rotation, expiry/410 cleanup, unsubscribe, and delivery-backed fallback tests passed.');
} finally {
  https.request = originalHttpsRequest;
  dns.lookup = originalDnsLookup;
  syncBuiltinESMExports();
  await new Promise(resolve => callbackServer.close(() => resolve()));
  fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function subscription(name, args = { workspace }, options = {}) {
  const now = new Date().toISOString();
  return {
    id: `sub_${name.replaceAll('.', '_')}_${crypto.randomBytes(4).toString('hex')}`,
    principalFingerprint: owner,
    name,
    arguments: args,
    callbackUrl: 'https://events.example.com/callback',
    sealedSecret: 'sealed-test-secret',
    refreshBefore: options.expired
      ? new Date(Date.now() - 60_000).toISOString()
      : new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
    verifiedAt: now
  };
}

function writeSubscriptionStore(subscriptions) {
  fs.writeFileSync(eventStore, `${JSON.stringify({ version: 1, subscriptions }, null, 2)}\n`, { mode: 0o600 });
}

function readSubscriptions() {
  if (!fs.existsSync(eventStore)) return [];
  return JSON.parse(fs.readFileSync(eventStore, 'utf8')).subscriptions || [];
}

function seedCompletionNotice(status, workId) {
  const key = crypto.createHash('sha256').update(`${owner}\u0000${workspace}`).digest('base64url');
  const directory = path.join(stateDir, 'fallback-completions');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${key}.json`), `${JSON.stringify({
    version: 1,
    notices: [{
      operationId: `fallback_test_${workId}`,
      work_id: workId,
      tool: 'relai_exec',
      workspace,
      status,
      completedAt: new Date().toISOString(),
      revision: 2,
      summary: 'Test fallback completion.'
    }]
  }, null, 2)}\n`, { mode: 0o600 });
}
