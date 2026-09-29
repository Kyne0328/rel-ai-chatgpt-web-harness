import assert from 'node:assert/strict';
import telemetryWorker, { adminHtml, axiomTraceUrl, constantTimeEqual, hashAdminPassword, hashAdminSessionToken, isAuthorizedAdmin, readCookie, validatePresence, verifyAdminCredentials } from '../cloud/telemetry-worker/src/index.mjs';

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
const env = {
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD_SALT: salt,
  ADMIN_PASSWORD_HASH: passwordHash
};
assert.equal(await verifyAdminCredentials('admin', password, env), true);
assert.equal(await verifyAdminCredentials('other', password, env), false);
assert.equal(await verifyAdminCredentials('admin', 'wrong-password', env), false);

const issuedSessions = new Map();
const adminDb = {
  prepare(sql) {
    if (sql.startsWith('DELETE FROM admin_sessions WHERE unixepoch')) {
      return { run: async () => ({ success: true }) };
    }
    if (sql.startsWith('INSERT INTO admin_sessions')) {
      return {
        bind(sessionHash, expiresAt) {
          return {
            run: async () => {
              issuedSessions.set(sessionHash, expiresAt);
              return { success: true };
            }
          };
        }
      };
    }
    if (sql.startsWith('DELETE FROM admin_sessions WHERE session_hash')) {
      return {
        bind(sessionHash) {
          return {
            run: async () => {
              issuedSessions.delete(sessionHash);
              return { success: true };
            }
          };
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
    return {
      bind(value) {
        return { first: async () => value === sessionHash ? { session_hash: value } : null };
      }
    };
  }
};
assert.equal(await isAuthorizedAdmin(sessionRequest, { DB: sessionDb }), true);
assert.equal(await isAuthorizedAdmin(new Request('https://telemetry.example/'), { DB: sessionDb }), false);
assert.equal(constantTimeEqual('same', 'same'), true);
assert.equal(constantTimeEqual('same', 'nope'), false);
assert.equal(axiomTraceUrl({ AXIOM_DOMAIN: 'https://us-east-1.aws.edge.axiom.co/' }), 'https://us-east-1.aws.edge.axiom.co/v1/traces');

const generatedAdminHtml = adminHtml();
const inlineScript = generatedAdminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'admin page must include an inline script');
assert.doesNotThrow(() => new Function(inlineScript), 'generated admin page JavaScript must parse');
assert.match(generatedAdminHtml, /id="btn-login"/);
assert.match(generatedAdminHtml, /id="btn-toggle-pwd"/);
assert.match(generatedAdminHtml, /autocomplete="current-password"/);
assert.match(generatedAdminHtml, /\/api\/v1\/admin\/login/);
assert.doesNotMatch(generatedAdminHtml, /sessionStorage/);
assert.doesNotMatch(generatedAdminHtml, /headers:\s*\{\s*authorization:/);

console.log('Telemetry Worker validation tests passed.');
