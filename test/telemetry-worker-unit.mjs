import assert from 'node:assert/strict';
import { adminHtml, axiomTraceUrl, constantTimeEqual, hashAdminPassword, isAuthorizedAdmin, parseBasicAuthorization, validatePresence } from '../cloud/telemetry-worker/src/index.mjs';

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
const authorization = `Basic ${btoa(`admin:${password}`)}`;
const authorized = new Request('https://telemetry.example/api/v1/admin/summary', {
  headers: { authorization }
});
assert.deepEqual(parseBasicAuthorization(authorized), { username: 'admin', password });
assert.equal(await isAuthorizedAdmin(authorized, env), true);
assert.equal(await isAuthorizedAdmin(authorized, { ...env, ADMIN_USERNAME: 'other' }), false);
assert.equal(await isAuthorizedAdmin(new Request('https://telemetry.example/'), env), false);
assert.equal(constantTimeEqual('same', 'same'), true);
assert.equal(constantTimeEqual('same', 'nope'), false);
assert.equal(axiomTraceUrl({ AXIOM_DOMAIN: 'https://us-east-1.aws.edge.axiom.co/' }), 'https://us-east-1.aws.edge.axiom.co/v1/traces');

const generatedAdminHtml = adminHtml();
const inlineScript = generatedAdminHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, 'admin page must include an inline script');
assert.doesNotThrow(() => new Function(inlineScript), 'generated admin page JavaScript must parse');
assert.match(generatedAdminHtml, /id="btn-login"/);
assert.match(generatedAdminHtml, /id="btn-toggle-pwd"/);

console.log('Telemetry Worker validation tests passed.');
