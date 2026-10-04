import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

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

  await testWebhookLifecycle(readSubscriptions()[0]);
  await testTaskTerminalPublication(readSubscriptions()[0]);

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

// These cases use an in-memory HTTP lifecycle and manually fired timers. The
// existing loopback tests above still exercise real request bodies and signing.
async function testWebhookLifecycle(liveSubscription) {
  assert.ok(liveSubscription?.sealedSecret, 'lifecycle cases need a genuinely sealed subscription');

  await withWebhookLifecycleMock(liveSubscription, (request, index) => {
    if (index < 2) request.fail(new Error('synthetic connection reset'));
    else request.respond(200).end('{}');
  }, async mock => {
    const delivery = mock.publish();
    await mock.flush();
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(mock.activeDelays(), [250], 'network rejection must schedule the first bounded retry');
    await mock.fire(250);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(mock.activeDelays(), [1000]);
    await mock.fire(1000);
    assert.equal(await delivery, true);
    assert.equal(mock.requests.length, 3);
    const [first] = mock.requests;
    for (const request of mock.requests) {
      assert.equal(request.options.headers['webhook-id'], first.options.headers['webhook-id'], 'retries must keep one event identity');
      assert.equal(request.body, first.body, 'retries must keep the exact signed body');
      assert.equal(JSON.parse(request.body).eventId, request.options.headers['webhook-id']);
      assert.equal(request.options.servername, 'events.example.test');
      assert.equal(request.options.agent, false);
      let pinnedAddress;
      request.options.lookup('ignored.example', {}, (_error, address) => { pinnedAddress = address; });
      assert.equal(pinnedAddress, '8.8.8.8', 'each POST must retain the validated public-address pin');
    }
    mock.assertNoTimers();
  });

  await withWebhookLifecycleMock(liveSubscription, request => {
    request.fail(new Error('synthetic persistent network failure'));
  }, async mock => {
    const delivery = mock.publish();
    await mock.flush();
    for (const delay of [250, 1000, 3000]) await mock.fire(delay);
    assert.equal(await delivery, false);
    assert.equal(mock.requests.length, 4, 'network rejection exhaustion must stop after four POSTs');
    mock.assertNoTimers();
  });

  await withWebhookLifecycleMock(liveSubscription, request => {
    request.respond(200).end('{}');
  }, async mock => {
    // URL validation succeeds, but the independently resolved POST address is
    // now private. This policy error is permanent and must never send a POST.
    mock.resolveAddress = call => call === 1 ? '8.8.8.8' : '127.0.0.1';
    assert.equal(await mock.publish(), false);
    assert.equal(mock.requests.length, 0);
    mock.assertNoTimers();
  });

  for (const failure of ['request-error-after-headers', 'response-error', 'response-aborted', 'socket-timeout']) {
    await withWebhookLifecycleMock(liveSubscription, (request, index) => {
      const response = request.respond(200);
      if (index > 0) return response.end('{}');
      if (failure === 'request-error-after-headers') request.fail(new Error('synthetic request failure'));
      else if (failure === 'response-error') response.fail(new Error('synthetic response failure'));
      else if (failure === 'response-aborted') response.emit('aborted');
      else request.emit('timeout');
    }, async mock => {
      const delivery = mock.publish();
      await mock.flush();
      assert.deepEqual(mock.activeDelays(), [250], `${failure} must clear the HTTP deadline before retrying`);
      const first = mock.requests[0];
      assert.equal(first.response.destroyCalls, 1, `${failure} must release its response once`);
      if (failure !== 'request-error-after-headers') {
        assert.equal(first.destroyCalls, 1, `${failure} must release its request once`);
      }
      await mock.fire(250);
      assert.equal(await delivery, true);
      assert.equal(mock.requests.length, 2, `${failure} must settle the attempt exactly once`);
      mock.assertNoTimers();
    });
  }

  await withWebhookLifecycleMock(liveSubscription, (request, index) => {
    const response = request.respond(200);
    if (index > 0) response.end('{}');
  }, async mock => {
    const delivery = mock.publish();
    await mock.flush();
    const first = mock.requests[0];
    assert.deepEqual(mock.activeDelays(), [10000], 'HTTP deadline must stay armed after response headers');
    const deadline = mock.activeTimers()[0];
    for (let chunk = 0; chunk < 4; chunk += 1) {
      mock.advance(2000);
      first.response.emit('data', Buffer.from('still streaming'));
      await mock.flush();
      assert.equal(mock.activeTimers()[0], deadline, 'response activity must not reset the absolute deadline');
    }
    await mock.fire(10000);
    assert.equal(first.destroyCalls, 1, 'absolute timeout must destroy the request');
    assert.equal(first.response.destroyCalls, 1, 'absolute timeout must destroy the open response');
    assert.deepEqual(mock.activeDelays(), [250]);
    await mock.fire(250);
    assert.equal(await delivery, true);
    mock.assertNoTimers();
  });

  for (const size of [64 * 1024, 64 * 1024 + 1]) {
    await withWebhookLifecycleMock(liveSubscription, request => {
      const response = request.respond(200);
      response.emit('data', Buffer.alloc(size, 'x'));
      if (!response.destroyed) response.end();
    }, async mock => {
      const delivery = mock.publish();
      await mock.flush();
      assert.equal(await delivery, size === 64 * 1024, 'response byte bound must be inclusive at exactly 64 KiB');
      assert.equal(mock.requests.length, 1, 'oversized responses are terminal, not retryable');
      if (size > 64 * 1024) {
        assert.equal(mock.requests[0].destroyCalls, 1);
        assert.equal(mock.requests[0].response.destroyCalls, 1);
      }
      mock.assertNoTimers();
    });
  }

  for (const status of [410, 413]) {
    for (const bodyKind of ['oversized', 'never-ending']) {
      await withWebhookLifecycleMock(liveSubscription, request => {
        const response = request.respond(status);
        if (!response.destroyed && bodyKind === 'oversized') response.emit('data', Buffer.alloc(64 * 1024 + 1));
        // Neither case emits end: terminal headers must suffice by themselves.
      }, async mock => {
        const delivery = mock.publish();
        await mock.flush();
        const request = mock.requests[0];
        assert.equal(request.response.destroyed, true, `${status}/${bodyKind} must not wait for its body`);
        assert.equal(await delivery, false);
        assert.equal(mock.requests.length, 1);
        assert.equal(request.destroyCalls, 1);
        assert.equal(request.response.destroyCalls, 1);
        assert.equal(readSubscriptions().length, status === 410 ? 0 : 1, 'only 410 removes the delivered subscription');
        mock.assertNoTimers();
      });
    }
  }

  await withWebhookLifecycleMock(liveSubscription, request => {
    const refreshed = { ...liveSubscription, updatedAt: new Date(Date.parse(liveSubscription.updatedAt) + 1000).toISOString() };
    writeSubscriptionStore([refreshed]);
    request.respond(410);
  }, async mock => {
    const delivery = mock.publish();
    await mock.flush();
    assert.equal(mock.requests[0].response.destroyed, true);
    assert.equal(await delivery, false);
    assert.equal(readSubscriptions().length, 1, 'a stale 410 must not remove a concurrently refreshed revision');
    assert.notEqual(readSubscriptions()[0].updatedAt, liveSubscription.updatedAt);
    mock.assertNoTimers();
  });

  await withWebhookLifecycleMock(liveSubscription, request => {
    request.respond(200).end('{}');
  }, async mock => {
    mock.synchronousResponse = true;
    assert.equal(await mock.publish(), true);
    assert.equal(mock.timers.length, 0, 'a synchronous response-completion mock must not leave a timer created after settlement');
  });
}

async function withWebhookLifecycleMock(liveSubscription, respond, check) {
  const saved = {
    request: https.request, lookup: dns.lookup,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    now: Date.now, subscriptions: readSubscriptions()
  };
  let clock = saved.now();
  let dnsCalls = 0;
  const mock = {
    requests: [], timers: [], synchronousResponse: false,
    resolveAddress: () => '8.8.8.8',
    advance(ms) { clock += ms; },
    activeTimers() { return this.timers.filter(timer => !timer.cleared && !timer.fired); },
    activeDelays() { return this.activeTimers().map(timer => timer.delay); },
    assertNoTimers() { assert.deepEqual(this.activeDelays(), [], 'every settled delivery must release all owned timers'); },
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
    async fire(delay) {
      const matching = this.activeTimers().filter(timer => timer.delay === delay);
      assert.equal(matching.length, 1, `expected exactly one pending ${delay}ms timer`);
      const [timer] = matching;
      clock = Math.max(clock, timer.at);
      timer.fired = true;
      timer.callback(...timer.args);
      await this.flush();
    },
    publish() {
      return publishMcpEvent(config, {
        principalFingerprint: owner,
        name: 'operation.completed',
        data: { workspace, work_id: 'work-live', operation_id: 'fallback_lifecycle', tool: 'relai_exec', status: 'completed', error: '' }
      });
    }
  };
  try {
    writeSubscriptionStore([{ ...liveSubscription }]);
    Date.now = () => clock;
    globalThis.setTimeout = (callback, delay, ...args) => {
      const timer = { callback, delay: Number(delay), args, at: clock + Number(delay), cleared: false, fired: false, unref() { return this; } };
      mock.timers.push(timer);
      return timer;
    };
    globalThis.clearTimeout = timer => {
      if (mock.timers.includes(timer)) timer.cleared = true;
      else saved.clearTimeout(timer);
    };
    dns.lookup = async (_hostname, options = {}) => {
      const address = { address: mock.resolveAddress(++dnsCalls), family: 4 };
      return options.all ? [address] : address;
    };
    https.request = (url, options, callback) => {
      const request = new EventEmitter();
      const index = mock.requests.length;
      Object.assign(request, {
        url, options, body: undefined, destroyed: false, destroyCalls: 0,
        destroy(error) {
          this.destroyCalls += 1;
          if (this.destroyed) return this;
          this.destroyed = true;
          if (error) queueMicrotask(() => this.emit('error', error));
          return this;
        },
        fail(error) { this.destroyed = true; this.emit('error', error); },
        respond(statusCode) {
          const response = new EventEmitter();
          Object.assign(response, {
            statusCode, destroyed: false, destroyCalls: 0,
            destroy(error) {
              this.destroyCalls += 1;
              if (this.destroyed) return this;
              this.destroyed = true;
              // Emit aborted synchronously to expose reentrant cleanup bugs.
              this.emit('aborted');
              if (error) queueMicrotask(() => this.emit('error', error));
              return this;
            },
            fail(error) { this.destroyed = true; this.emit('error', error); },
            end(body) {
              if (body) this.emit('data', Buffer.from(body));
              this.emit('end');
              return this;
            }
          });
          this.response = response;
          callback(response);
          return response;
        },
        end(body) {
          this.body = body;
          queueMicrotask(() => respond(this, index));
          return this;
        }
      });
      mock.requests.push(request);
      if (mock.synchronousResponse) respond(request, index);
      return request;
    };
    syncBuiltinESMExports();
    await check(mock);
  } finally {
    https.request = saved.request;
    dns.lookup = saved.lookup;
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    Date.now = saved.now;
    syncBuiltinESMExports();
    writeSubscriptionStore(saved.subscriptions);
  }
}

async function testTaskTerminalPublication(liveSubscription) {
  const previousConfig = process.env.REL_AI_MCP_CONFIG;
  const configFile = path.join(stateDir, 'lifecycle-event-fixture.json');
  fs.writeFileSync(configFile, JSON.stringify({ version: 3, stateDir, workspaces: { [workspace]: { path: stateDir } } }));
  process.env.REL_AI_MCP_CONFIG = configFile;
  try {
    const { createToolActivityTracker } = await import('../src/toolActivity.js');
    await withWebhookLifecycleMock(liveSubscription, request => request.respond(200).end('{}'), async mock => {
      writeSubscriptionStore(['work.completed', 'work.cancelled', 'work.failed'].map((name, index) => ({
        ...liveSubscription, id: `sub_terminal_${index}`, name, arguments: { workspace }
      })));
      const tracker = createToolActivityTracker({ setTimer: () => ({ unref() {} }), clearTimer() {} });
      const observed = [];
      tracker.onToolActivity(event => observed.push(event));
      try {
        const started = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin', createTask: true,
          workspace, principalFingerprint: owner, scopeId: 'cancel-terminal-event' });
        started();
        const cancellation = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.cancel',
          workspace, taskId: started.taskId, scopeId: 'cancel-terminal-event' });
        tracker.cancelTask(started.taskId, { reason: 'Fixture cancellation.' });
        cancellation({ ok: true });
        await mock.flush();
        const cancelled = mock.requests.filter(request => JSON.parse(request.body).name === 'work.cancelled');
        assert.equal(cancelled.length, 1, 'one cancellation transition must emit one event, not another when its control call finishes');
        assert.ok(observed.some(event => event.phase === 'cancelled' && event.changedFields.includes('status')));
        assert.ok(observed.some(event => event.phase === 'finished' && event.task?.status === 'cancelled' && !event.changedFields.includes('status')));

        const rejected = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin', createTask: true,
          workspace, principalFingerprint: owner, scopeId: 'rejected-terminal-event' });
        rejected({ ok: false, error: 'Fixture task start failure.' });
        await mock.flush();
        assert.equal(mock.requests.filter(request => JSON.parse(request.body).name === 'work.failed').length, 1,
          'a rejected start still publishes its terminal status transition even though phase is finished');

        const completedStart = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin', createTask: true,
          workspace, principalFingerprint: owner, scopeId: 'completed-terminal-event' });
        completedStart();
        const completed = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.finish',
          workspace, taskId: completedStart.taskId, scopeId: 'completed-terminal-event' });
        completed.requestCompletion({ summary: 'Fixture complete.' });
        completed({ ok: true });
        await mock.flush();
        assert.equal(mock.requests.filter(request => JSON.parse(request.body).name === 'work.completed').length, 1);
        mock.assertNoTimers();
      } finally { tracker.reset(); }
    });
  } finally {
    if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
    else process.env.REL_AI_MCP_CONFIG = previousConfig;
  }
}
