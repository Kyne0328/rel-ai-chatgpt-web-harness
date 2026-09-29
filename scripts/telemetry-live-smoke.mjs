import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { diag, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';

try {
  process.loadEnvFile?.('.env');
} catch {
  // Live smoke can run without the optional local admin credential.
}

const base = String(process.env.REL_AI_TELEMETRY_BASE_URL || 'https://relai-telemetry.kynemcp.workers.dev').replace(/\/$/, '');
const testInstallationId = '11111111-1111-4111-8111-111111111111';

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200, `telemetry health failed with HTTP ${health.status}`);
const healthBody = await health.json();
assert.equal(healthBody.ok, true);

const presenceBody = {
  schemaVersion: 1,
  installationId: testInstallationId,
  version: '1.1.4',
  platform: 'win32',
  arch: 'x64'
};

const firstPresence = await fetch(`${base}/api/v1/installation/presence`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(presenceBody)
});
assert.equal(firstPresence.status, 202);
assert.equal((await firstPresence.json()).ok, true);

const secondPresence = await fetch(`${base}/api/v1/installation/presence`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(presenceBody)
});
assert.equal(secondPresence.status, 202);
const secondPresenceBody = await secondPresence.json();
assert.equal(secondPresenceBody.ok, true);
assert.equal(secondPresenceBody.updated, false, 'duplicate presence inside the server interval must not rewrite the installation row');

const otelErrors = [];
diag.setLogger({
  error: (...args) => otelErrors.push(args.map(String).join(' ')),
  warn: () => {},
  info: () => {},
  debug: () => {},
  verbose: () => {}
}, DiagLogLevel.ERROR);

const exporter = new OTLPTraceExporter({ url: `${base}/v1/traces` });
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    'service.name': 'rel-ai-mcp-live-smoke',
    'service.version': '1.1.4',
    'relai.telemetry.mode': 'diagnostics'
  }),
  spanProcessors: [new SimpleSpanProcessor(exporter)]
});
const span = provider.getTracer('relai-telemetry-live-smoke', '1.1.4').startSpan('relai.telemetry.live_smoke');
span.setAttribute('relai.smoke', true);
span.end();
await provider.forceFlush();
await provider.shutdown();
assert.deepEqual(otelErrors, [], `OTLP proxy/export reported errors: ${otelErrors.join(' | ')}`);

let adminChecked = false;
const adminPassword = String(process.env.REL_AI_TELEMETRY_ADMIN_PASSWORD || '');
if (adminPassword) {
  const login = await fetch(`${base}/api/v1/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword, remember: false })
  });
  assert.equal(login.status, 200, `admin login failed with HTTP ${login.status}`);
  assert.equal((await login.json()).ok, true);
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';', 1)[0];
  assert.match(cookie, /^relai_admin_session=/, 'admin login must issue a session cookie');

  const admin = await fetch(`${base}/api/v1/admin/summary`, { headers: { cookie } });
  assert.equal(admin.status, 200, `admin summary failed with HTTP ${admin.status}`);
  const adminBody = await admin.json();
  assert.equal(adminBody.ok, true);
  assert.ok(adminBody.summary && typeof adminBody.summary === 'object');

  const logout = await fetch(`${base}/api/v1/admin/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200, `admin logout failed with HTTP ${logout.status}`);
  adminChecked = true;
}

const cleanupSqlPath = '.relai-live-smoke-cleanup.sql';
fs.writeFileSync(cleanupSqlPath, `DELETE FROM installations WHERE installation_id = '${testInstallationId}';\n`, 'utf8');
let cleanup;
try {
  cleanup = spawnSync('npx', [
    'wrangler',
    'd1',
    'execute',
    'relai-telemetry',
    '--remote',
    '--config',
    'cloud/telemetry-worker/wrangler.jsonc',
    '--file',
    cleanupSqlPath
  ], { encoding: 'utf8', shell: true });
} finally {
  fs.rmSync(cleanupSqlPath, { force: true });
}
assert.equal(cleanup.status, 0, `failed to remove live-smoke installation row: ${cleanup.stderr || cleanup.stdout}`);

console.log(JSON.stringify({
  ok: true,
  endpoint: base,
  health: true,
  presenceDeduplication: true,
  diagnosticsProxy: true,
  adminChecked,
  testInstallationCleaned: true
}));
