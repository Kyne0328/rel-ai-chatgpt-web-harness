import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import telemetryWorker, {
  adminHtml,
  axiomTraceUrl,
  constantTimeEqual,
  hashAdminPassword,
  hashAdminSessionToken,
  hashIngestToken,
  isAuthorizedAdmin,
  pruneRetainedTelemetry,
  readCookie,
  validatePresence,
  verifyAdminCredentials
} from '../cloud/telemetry-worker/src/index.mjs';

const valid = {
  schemaVersion: 1,
  installationId: '550e8400-e29b-41d4-a716-446655440000',
  version: '1.1.4',
  platform: 'win32',
  arch: 'x64'
};

assert.deepEqual(validatePresence(valid), {
  ok: true,
  value: {
    installationId: valid.installationId,
    version: '1.1.4',
    platform: 'win32',
    arch: 'x64'
  }
});
assert.equal(validatePresence({ ...valid, machineName: 'private-host' }).ok, false, 'presence schema must reject unexpected fields');
assert.equal(validatePresence({ ...valid, installationId: 'not-a-uuid' }).ok, false);
assert.equal(validatePresence({ ...valid, version: '../../private' }).ok, false);
assert.equal(validatePresence({ ...valid, platform: 'unknown' }).ok, false);
assert.equal(validatePresence({ ...valid, arch: 'mips' }).ok, false);

const password = 'test-password';
const salt = 'test-salt';
const passwordHash = await hashAdminPassword(password, salt);
assert.match(passwordHash, /^pbkdf2-sha256\$210000\$[A-Za-z0-9_-]+$/, 'new admin passwords must use PBKDF2-SHA256');
const env = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_SALT: salt,
  ADMIN_PASSWORD_HASH: passwordHash
};
assert.equal(await verifyAdminCredentials('admin', password, env), true);
assert.equal(await verifyAdminCredentials('other', password, env), false);
assert.equal(await verifyAdminCredentials('admin', 'wrong-password', env), false);
const legacyHash = createHash('sha256').update(`${salt}\0${password}`).digest('base64url');
assert.equal(await verifyAdminCredentials('admin', password, { ...env, ADMIN_PASSWORD_HASH: legacyHash }), true, 'legacy hashes must remain valid only for migration');

const issuedSessions = new Map();
const adminDb = {
  prepare(sql) {
    if (sql.startsWith('DELETE FROM admin_sessions WHERE unixepoch')) return { run: async () => ({ success: true }) };
    if (sql.startsWith('INSERT INTO admin_sessions')) {
      return {
        bind(sessionHash, expiresAt) {
          return { run: async () => { issuedSessions.set(sessionHash, expiresAt); return { success: true }; } };
        }
      };
    }
    if (sql.startsWith('DELETE FROM admin_sessions WHERE session_hash')) {
      return {
        bind(sessionHash) {
          return { run: async () => { issuedSessions.delete(sessionHash); return { success: true }; } };
        }
      };
    }
    throw new Error(`Unexpected admin DB statement: ${sql}`);
  }
};
const adminEnv = { ...env, DB: adminDb };
const loginResponse = await telemetryWorker.fetch(new Request('https://telemetry.example/api/v1/admin/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password, remember: true })
}), adminEnv);
assert.equal(loginResponse.status, 200);
assert.equal((await loginResponse.json()).ok, true);
const setCookie = loginResponse.headers.get('set-cookie') || '';
assert.match(setCookie, /^relai_admin_session=[A-Za-z0-9_-]+;/);
assert.match(setCookie, /HttpOnly/);
assert.match(setCookie, /Secure/);
assert.match(setCookie, /SameSite=Strict/);
assert.match(setCookie, /Max-Age=604800/);
const issuedCookie = setCookie.split(';', 1)[0];
const issuedToken = issuedCookie.slice(issuedCookie.indexOf('=') + 1);
assert.equal(issuedSessions.has(await hashAdminSessionToken(issuedToken)), true);

const logoutResponse = await telemetryWorker.fetch(new Request('https://telemetry.example/api/v1/admin/logout', {
  method: 'POST',
  headers: { cookie: issuedCookie }
}), adminEnv);
assert.equal(logoutResponse.status, 200);
assert.equal(issuedSessions.size, 0);
assert.match(logoutResponse.headers.get('set-cookie') || '', /Max-Age=0/);

const sessionToken = 'test-session-token';
const sessionHash = await hashAdminSessionToken(sessionToken);
const sessionRequest = new Request('https://telemetry.example/api/v1/admin/summary', {
  headers: { cookie: `other=value; relai_admin_session=${sessionToken}` }
});
assert.equal(readCookie(sessionRequest, 'relai_admin_session'), sessionToken);
const sessionDb = {
  prepare(sql) {
    assert.match(sql, /admin_sessions/);
    return { bind(value) { return { first: async () => value === sessionHash ? { session_hash: value } : null }; } };
  }
};
assert.equal(await isAuthorizedAdmin(sessionRequest, { DB: sessionDb }), true);
assert.equal(await isAuthorizedAdmin(new Request('https://telemetry.example/'), { DB: sessionDb }), false);
assert.equal(constantTimeEqual('same', 'same'), true);
assert.equal(constantTimeEqual('same', 'nope'), false);
assert.equal(axiomTraceUrl({ AXIOM_DOMAIN: 'https://us-east-1.aws.edge.axiom.co/' }), 'https://us-east-1.aws.edge.axiom.co/v1/traces');

const ingestToken = 'unit-test-ingest-token-abcdefghijklmnopqrstuvwxyz012345';
const installations = new Map();
const permissiveRate = { limit: async () => ({ success: true }) };
const telemetryDb = {
  prepare(sql) {
    if (sql.startsWith('SELECT last_seen_at')) {
      return { bind(id) { return { first: async () => installations.get(id) || null }; } };
    }
    if (sql.startsWith('SELECT ingest_token_hash')) {
      return { bind(id) { return { first: async () => installations.get(id) || null }; } };
    }
    if (sql.startsWith('UPDATE installations SET ingest_token_hash')) {
      return { bind(hash, id) { return { run: async () => { const current = installations.get(id) || {}; installations.set(id, { ...current, ingest_token_hash: hash }); return { success: true }; } }; } };
    }
    if (sql.includes('UPDATE installations\n       SET last_seen_at')) {
      return {
        bind(lastSeen, currentVersion, platform, architecture, ingestTokenHash, id) {
          return { run: async () => { const current = installations.get(id) || {}; installations.set(id, { ...current, last_seen_at: lastSeen, current_version: currentVersion, platform, architecture, ingest_token_hash: ingestTokenHash }); return { success: true }; } };
        }
      };
    }
    if (sql.includes('INSERT INTO installations')) {
      return {
        bind(id, firstSeen, lastSeen, firstVersion, currentVersion, platform, architecture, ingestTokenHash) {
          return { run: async () => { installations.set(id, { last_seen_at: lastSeen, current_version: currentVersion, platform, architecture, ingest_token_hash: ingestTokenHash, first_seen_at: firstSeen, first_version: firstVersion }); return { success: true }; } };
        }
      };
    }
    throw new Error(`Unexpected telemetry DB statement: ${sql}`);
  }
};
const telemetryEnv = {
  DB: telemetryDb,
  USAGE_IP_RATE_LIMITER: permissiveRate,
  ENROLL_RATE_LIMITER: permissiveRate,
  USAGE_RATE_LIMITER: permissiveRate,
  TRACE_IP_RATE_LIMITER: permissiveRate,
  TRACE_RATE_LIMITER: permissiveRate,
  AXIOM_TOKEN: 'test-axiom-token',
  AXIOM_DATASET: 'test-dataset',
  AXIOM_DOMAIN: 'axiom.example'
};
const presenceUrl = 'https://telemetry.example/api/v1/installation/presence';
assert.equal((await telemetryWorker.fetch(new Request(presenceUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid)
}), telemetryEnv)).status, 401, 'presence must reject missing installation credentials');
const presenceAuth = { 'content-type': 'application/json', authorization: `Bearer ${ingestToken}` };
let oversizedPulls = 0;
let oversizedCancelled = false;
const oversizedBody = new ReadableStream({
  pull(controller) {
    oversizedPulls += 1;
    controller.enqueue(new Uint8Array(1024).fill(32));
    if (oversizedPulls === 16) controller.close();
  },
  cancel() { oversizedCancelled = true; }
}, { highWaterMark: 0 });
const oversizedResponse = await telemetryWorker.fetch(new Request(presenceUrl, {
  method: 'POST', headers: presenceAuth, body: oversizedBody, duplex: 'half'
}), telemetryEnv);
assert.equal(oversizedResponse.status, 413);
assert.equal(oversizedCancelled, true, 'oversized streaming bodies must be cancelled as soon as the byte limit is exceeded');
assert.ok(oversizedPulls <= 5, 'the 4 KiB presence limit must prevent reading the complete oversized body');
const enrolled = await telemetryWorker.fetch(new Request(presenceUrl, { method: 'POST', headers: presenceAuth, body: JSON.stringify(valid) }), telemetryEnv);
assert.equal(enrolled.status, 202);
assert.equal(installations.get(valid.installationId).ingest_token_hash, await hashIngestToken(ingestToken));
const presenceBytes = new TextEncoder().encode(JSON.stringify(valid));
let presenceOffset = 0;
const fragmentedPresence = new ReadableStream({
  pull(controller) {
    if (presenceOffset >= presenceBytes.length) return controller.close();
    controller.enqueue(presenceBytes.slice(presenceOffset, presenceOffset + 7));
    presenceOffset += 7;
  }
});
assert.equal((await telemetryWorker.fetch(new Request(presenceUrl, {
  method: 'POST', headers: presenceAuth, body: fragmentedPresence, duplex: 'half'
}), telemetryEnv)).status, 202, 'bounded streaming reads must retain fragmented valid request bodies');
const rejectedPresence = await telemetryWorker.fetch(new Request(presenceUrl, {
  method: 'POST', headers: { ...presenceAuth, authorization: 'Bearer wrong-credential-that-is-long-enough-1234567890' }, body: JSON.stringify(valid)
}), telemetryEnv);
assert.equal(rejectedPresence.status, 401, 'an enrolled installation must reject a different credential');

const traceUrl = 'https://telemetry.example/v1/traces';
assert.equal((await telemetryWorker.fetch(new Request(traceUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
}), telemetryEnv)).status, 401, 'diagnostic ingestion must reject missing installation credentials');
const originalFetch = globalThis.fetch;
let forwarded = null;
globalThis.fetch = async (url, init) => {
  forwarded = { url: String(url), headers: new Headers(init?.headers), body: init?.body };
  return new Response('', { status: 200, headers: { 'content-type': 'application/json' } });
};
try {
  const traceResponse = await telemetryWorker.fetch(new Request(traceUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ingestToken}`,
      'x-relai-installation-id': valid.installationId
    },
    body: '{}'
  }), telemetryEnv);
  assert.equal(traceResponse.status, 200);
  assert.equal(forwarded?.url, 'https://axiom.example/v1/traces');
  assert.equal(forwarded?.headers.get('authorization'), 'Bearer test-axiom-token', 'the Worker must replace the client credential with the Axiom credential');
  assert.equal(forwarded?.headers.get('x-relai-installation-id'), null, 'installation identity must not be forwarded to Axiom');
} finally {
  globalThis.fetch = originalFetch;
}

const originalConsoleError = console.error;
console.error = () => {};
try {
  const failingDb = {
    prepare() {
      return { bind() { return { first: async () => { throw new Error('SYNTHETIC_DATABASE_FAILURE'); } }; } };
    }
  };
  const failedSummary = await telemetryWorker.fetch(new Request('https://telemetry.example/api/v1/admin/summary', {
    headers: { cookie: 'relai_admin_session=synthetic-session' }
  }), { DB: failingDb });
  assert.equal(failedSummary.status, 500, 'asynchronous route failures must reach the Worker error boundary');
  assert.deepEqual(await failedSummary.json(), { ok: false, error: 'Internal telemetry service error.' });
  globalThis.fetch = async () => { throw new Error('SYNTHETIC_UPSTREAM_FAILURE'); };
  const failedTrace = await telemetryWorker.fetch(new Request(traceUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ingestToken}`, 'x-relai-installation-id': valid.installationId },
    body: '{}'
  }), telemetryEnv);
  assert.equal(failedTrace.status, 500, 'asynchronous upstream failures must reach the Worker error boundary');
  assert.deepEqual(await failedTrace.json(), { ok: false, error: 'Internal telemetry service error.' });
} finally {
  console.error = originalConsoleError;
  globalThis.fetch = originalFetch;
}

const retentionStatements = [];
await pruneRetainedTelemetry({
  batch: async statements => { retentionStatements.push(...statements); return []; },
  prepare(sql) { return { sql }; }
});
assert.equal(retentionStatements.length, 3);
assert.match(retentionStatements[0].sql, /-400 days/);
assert.match(retentionStatements[1].sql, /-730 days/);
assert.match(retentionStatements[2].sql, /admin_sessions/);

const generatedAdminHtml = adminHtml();
const inlineScript = generatedAdminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'admin page must include an inline script');
assert.doesNotThrow(() => new Function(inlineScript), 'generated admin page JavaScript must parse');
assert.match(generatedAdminHtml, /id="btn-login"/);
assert.match(generatedAdminHtml, /id="btn-toggle-pwd"/);
assert.match(generatedAdminHtml, /autocomplete="current-password"/);
assert.match(generatedAdminHtml, /\/api\/v1\/admin\/login/);
assert.match(generatedAdminHtml, /New Installs · Last 24h/);
assert.match(generatedAdminHtml, /Presence Recency Ratio/);
assert.doesNotMatch(generatedAdminHtml, /DAU \/ MAU/);
assert.doesNotMatch(generatedAdminHtml, /sessionStorage/);
assert.doesNotMatch(generatedAdminHtml, /headers:\s*\{\s*authorization:/);

console.log('Telemetry Worker validation tests passed.');
