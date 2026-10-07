import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { normalizeConfig } from '../src/config.js';

import { initializeTelemetry, runSpan, sanitizeAttributes, setTelemetryDiagnosticsEnabled, shutdownTelemetry, summarizeCommandForTelemetry, telemetrySampleRatio, telemetryStatus } from '../src/telemetry.js';

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-tool-task-'));
try {
  const legacyDisabled = { stateDir: root, telemetry: { enabled: false, endpoint: 'http://127.0.0.1:4318/v1/traces', sampleRatio: 0.25 } };
  const migratedDisabled = normalizeConfig(legacyDisabled);
  assert.equal(migratedDisabled.telemetry.diagnosticsEnabled, false, 'upgrades must preserve a retained legacy telemetry opt-out');
  assert.equal(migratedDisabled.telemetry.endpoint, legacyDisabled.telemetry.endpoint);
  assert.equal(migratedDisabled.telemetry.sampleRatio, 0.25);
  assert.equal(Object.hasOwn(migratedDisabled.telemetry, 'enabled'), false, 'normalization must produce only the canonical telemetry setting');
  assert.equal(Object.hasOwn(legacyDisabled.telemetry, 'diagnosticsEnabled'), false, 'normalization must not mutate the input configuration');
  assert.equal(normalizeConfig({ stateDir: root }).telemetry.diagnosticsEnabled, true, 'new installations retain the documented default');
  assert.equal(normalizeConfig({ stateDir: root, telemetry: { enabled: true } }).telemetry.diagnosticsEnabled, true);
  assert.equal(normalizeConfig({ stateDir: root, telemetry: { enabled: false, diagnosticsEnabled: true } }).telemetry.diagnosticsEnabled, true, 'an explicit canonical enable setting must take precedence');
  assert.equal(normalizeConfig({ stateDir: root, telemetry: { enabled: true, diagnosticsEnabled: false } }).telemetry.diagnosticsEnabled, false, 'an explicit canonical opt-out must take precedence');
  const attributes = sanitizeAttributes({
    'relai.workspace': 'app',
    authorization: 'Bearer secret',
    approval_token: 'secret',
    'command.env.PASSWORD': 'secret',
    'relai.process.command': 'npm run test -- --watch',
    'safe.number': 2
  });
  assert.equal(attributes.authorization, '[redacted]');
  assert.equal(attributes.approval_token, '[redacted]');
  assert.equal(attributes['command.env.PASSWORD'], '[redacted]');
  assert.equal(attributes['relai.process.command'], 'npm run test -- --watch');
  assert.equal(attributes['safe.number'], 2);
  assert.equal(summarizeCommandForTelemetry('git status --short'), 'git status --short');
  assert.equal(
    summarizeCommandForTelemetry('npm run deploy -- --token super-secret --password=also-secret --region apac'),
    'npm run deploy -- --token [REDACTED] --password [REDACTED] --region apac'
  );
  const longCommand = `node script.js ${'x'.repeat(25_000)}`;
  assert.equal(summarizeCommandForTelemetry(longCommand), longCommand, 'telemetry must not truncate complete command text');
  assert.equal(telemetrySampleRatio({ telemetry: { sampleRatio: 0.25 } }), 0.25);
  assert.equal(telemetrySampleRatio({ telemetry: { sampleRatio: 2 } }), 1);
  assert.equal(telemetrySampleRatio({ telemetry: { sampleRatio: -1 } }), 0);

  const disabled = telemetryStatus({ telemetry: { diagnosticsEnabled: false, endpoint: 'http://127.0.0.1:4318/v1/traces', sampleRatio: 1 } });
  assert.equal(disabled.diagnosticsEnabled, false, 'diagnosticsEnabled=false must remain authoritative even when a diagnostic endpoint is configured');
  assert.equal(disabled.endpointConfigured, true, 'status may disclose that a diagnostic endpoint is configured without enabling diagnostic export');
  assert.equal(disabled.usageReportingEnabled, false, 'custom diagnostic endpoints must not enable maintainer usage reporting');

  const previousOfficialBuild = process.env.REL_AI_OFFICIAL_BUILD;
  process.env.REL_AI_OFFICIAL_BUILD = '1';
  try {
    const official = telemetryStatus({ stateDir: root, telemetry: { diagnosticsEnabled: false, sampleRatio: 1 } });
    assert.equal(official.usageReportingEnabled, true, 'official packaged builds must use the built-in maintainer usage endpoint');
    assert.equal(official.endpointConfigured, true, 'official packaged builds must expose the built-in diagnostic endpoint even when diagnostics are disabled');
  } finally {
    if (previousOfficialBuild == null) delete process.env.REL_AI_OFFICIAL_BUILD;
    else process.env.REL_AI_OFFICIAL_BUILD = previousOfficialBuild;
  }

  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        path: request.url,
        contentType: request.headers['content-type'] || '',
        authorization: request.headers.authorization || '',
        installationId: request.headers['x-relai-installation-id'] || '',
        body: Buffer.concat(chunks)
      });
      response.statusCode = 200;
      response.end();
    });
  });
  const previousUsageEndpoint = process.env.REL_AI_MAINTAINER_USAGE_ENDPOINT;
  const previousDiagnosticsEndpoint = process.env.REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT;
  const originalRegister = NodeTracerProvider.prototype.register;
  let diagnosticProvider;
  NodeTracerProvider.prototype.register = function (...args) {
    diagnosticProvider = this;
    return Reflect.apply(originalRegister, this, args);
  };
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.REL_AI_MAINTAINER_USAGE_ENDPOINT = `${base}/api/v1/installation/presence`;
    process.env.REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT = `${base}/v1/traces`;
    const usageOnlyConfig = { stateDir: root, telemetry: { diagnosticsEnabled: false, sampleRatio: 1 } };

    assert.equal(initializeTelemetry(usageOnlyConfig), true, 'maintainer usage reporting must initialize even when diagnostics are disabled');
    await shutdownTelemetry();

    const identityPath = path.join(root, 'telemetry-identity.json');
    const firstIdentityState = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    assert.match(firstIdentityState.installationId, /^[0-9a-f-]{36}$/i, 'usage reporting must persist a pseudonymous installation ID');
    assert.match(firstIdentityState.ingestToken, /^[A-Za-z0-9_-]{40,128}$/, 'usage reporting must persist a random installation-scoped ingest credential');
    assert.match(firstIdentityState.lastReportedAt, /^\d{4}-\d{2}-\d{2}T/, 'successful usage reporting must persist the last report time');
    assert.equal(firstIdentityState.lastReportedVersion, packageVersion, 'successful usage reporting must persist the reported app version');

    const usageRequests = requests.filter(request => request.path === '/api/v1/installation/presence');
    assert.equal(usageRequests.length, 1, 'initialization must send one presence event');
    assert.match(usageRequests[0].contentType, /^application\/json/i);
    assert.equal(usageRequests[0].authorization, `Bearer ${firstIdentityState.ingestToken}`);
    const presence = JSON.parse(usageRequests[0].body.toString('utf8'));
    assert.deepEqual(Object.keys(presence).sort(), ['arch', 'installationId', 'platform', 'schemaVersion', 'version']);
    assert.equal(presence.schemaVersion, 1);
    assert.equal(presence.installationId, firstIdentityState.installationId);
    assert.equal(presence.version, packageVersion);
    assert.equal(presence.platform, process.platform);
    assert.equal(presence.arch, process.arch);

    const requestCountAfterUsage = requests.length;
    await runSpan(usageOnlyConfig, 'relai.test.disabled', {}, async () => true);
    await shutdownTelemetry();
    assert.equal(requests.length, requestCountAfterUsage, 'disabling diagnostics must suppress diagnostic spans');

    initializeTelemetry(usageOnlyConfig);
    await shutdownTelemetry();
    const secondIdentityState = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    assert.equal(secondIdentityState.installationId, firstIdentityState.installationId, 'normal restarts and reinstalls that retain Rel.AI state must reuse the installation ID');
    assert.equal(
      requests.filter(request => request.path === '/api/v1/installation/presence').length,
      1,
      'successful usage reporting must not repeat before the 12-hour refresh interval across restarts'
    );

    fs.writeFileSync(identityPath, JSON.stringify({
      ...secondIdentityState,
      lastReportedAt: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString()
    }, null, 2));
    initializeTelemetry(usageOnlyConfig);
    await shutdownTelemetry();
    assert.equal(
      requests.filter(request => request.path === '/api/v1/installation/presence').length,
      2,
      'presence must refresh when the persisted success is older than 12 hours even after a restart'
    );

    const refreshedIdentityState = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    fs.writeFileSync(identityPath, JSON.stringify({
      ...refreshedIdentityState,
      lastReportedVersion: `${packageVersion}-fixture-previous`
    }, null, 2));
    initializeTelemetry(usageOnlyConfig);
    await shutdownTelemetry();
    assert.equal(
      requests.filter(request => request.path === '/api/v1/installation/presence').length,
      3,
      'an app version change must report immediately even when the previous presence is recent'
    );
    const upgradedIdentityState = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    assert.equal(upgradedIdentityState.lastReportedVersion, packageVersion);

    const secret = 'SECRET_EXCEPTION_MARKER';
    const privatePath = 'C:\\private\\project\\file.js';
    const diagnosticCommand = 'npm test -- --runInBand --coverage --reporter spec';
    await assert.rejects(
      () => runSpan({ stateDir: root, telemetry: { diagnosticsEnabled: true, sampleRatio: 1 } }, 'relai.test.privacy', {
        'relai.process.command': diagnosticCommand
      }, async () => {
        const error = new Error(`${secret} ${privatePath}`);
        error.name = 'SECRET_ERROR_NAME';
        throw error;
      }),
      new RegExp(secret)
    );
    assert.ok(diagnosticProvider, 'the actual SDK provider must initialize for diagnostic tests');
    await diagnosticProvider.forceFlush();

    const diagnosticPayload = Buffer.concat(
      requests
        .filter(request => request.path === '/v1/traces')
        .map(request => request.body)
    );
    assert.ok(diagnosticPayload.length > 0, 'enabled diagnostics must export OTLP spans');
    assert.equal(diagnosticPayload.includes(Buffer.from(diagnosticCommand)), true, 'OTLP payloads must retain the complete diagnostic command');
    const diagnosticRequest = requests.find(request => request.path === '/v1/traces');
    assert.equal(diagnosticRequest?.authorization, `Bearer ${upgradedIdentityState.ingestToken}`, 'maintainer diagnostics must authenticate with the installation-scoped credential');
    assert.equal(diagnosticRequest?.installationId, upgradedIdentityState.installationId, 'maintainer diagnostics must identify the installation without adding it to the trace payload');
    assert.equal(diagnosticPayload.includes(Buffer.from(secret)), false, 'OTLP payloads must never include raw exception messages');
    assert.equal(diagnosticPayload.includes(Buffer.from(privatePath)), false, 'OTLP payloads must never include raw local paths from exceptions');

    const diagnosticsConfig = { stateDir: root, telemetry: { diagnosticsEnabled: true, sampleRatio: 1 } };
    await runSpan(diagnosticsConfig, 'relai.test.queued_before_opt_out', {}, async () => true);
    let releaseActive;
    let markActiveStarted;
    const activeGate = new Promise(resolve => { releaseActive = resolve; });
    const activeStarted = new Promise(resolve => { markActiveStarted = resolve; });
    const activeSpan = runSpan(diagnosticsConfig, 'relai.test.active_across_opt_out', {}, async () => {
      markActiveStarted();
      await activeGate;
      return 'operation completed';
    });
    await activeStarted;
    const racingSpan = runSpan(diagnosticsConfig, 'relai.test.pending_at_opt_out', {}, async () => 'race operation completed');
    await setTelemetryDiagnosticsEnabled(diagnosticsConfig, false);
    const directDisabledSpan = diagnosticProvider.getTracer('relai-opt-out-test').startSpan('relai.test.direct_sdk_disabled');
    directDisabledSpan.end();
    assert.equal(await racingSpan, 'race operation completed', 'a pending telemetry setup must not change the primary operation');
    assert.equal(await runSpan(diagnosticsConfig, 'relai.test.disabled', {}, async () => 'unchanged'), 'unchanged');
    await assert.rejects(() => runSpan(diagnosticsConfig, 'relai.test.disabled_error', {}, async () => {
      throw new Error('SYNTHETIC_OPERATION_ERROR');
    }), /SYNTHETIC_OPERATION_ERROR/, 'opt-out must preserve the primary operation error');
    await setTelemetryDiagnosticsEnabled(diagnosticsConfig, true);
    releaseActive();
    assert.equal(await activeSpan, 'operation completed');
    await runSpan(diagnosticsConfig, 'relai.test.after_reenable', {}, async () => true);
    await diagnosticProvider.forceFlush();
    const afterTogglePayload = Buffer.concat(requests.filter(request => request.path === '/v1/traces').map(request => request.body));
    for (const excluded of ['queued_before_opt_out', 'active_across_opt_out', 'pending_at_opt_out', 'relai.test.disabled', 'direct_sdk_disabled']) {
      assert.equal(afterTogglePayload.includes(Buffer.from(excluded)), false, `opt-out must permanently discard ${excluded}`);
    }
    assert.equal(afterTogglePayload.includes(Buffer.from('after_reenable')), true, 'new spans after re-enable must export normally');

    await runSpan(diagnosticsConfig, 'relai.test.queued_at_shutdown', {}, async () => true);
    await setTelemetryDiagnosticsEnabled(diagnosticsConfig, false);
    const requestsBeforeDisabledShutdown = requests.length;
    await shutdownTelemetry();
    assert.equal(requests.length, requestsBeforeDisabledShutdown, 'disabled shutdown must discard queued spans without export');
  } finally {
    NodeTracerProvider.prototype.register = originalRegister;
    if (previousUsageEndpoint == null) delete process.env.REL_AI_MAINTAINER_USAGE_ENDPOINT;
    else process.env.REL_AI_MAINTAINER_USAGE_ENDPOINT = previousUsageEndpoint;
    if (previousDiagnosticsEndpoint == null) delete process.env.REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT;
    else process.env.REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT = previousDiagnosticsEndpoint;
    await shutdownTelemetry();
    server.close();
    await once(server, 'close');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Telemetry privacy, reporting, and redaction tests passed.');
