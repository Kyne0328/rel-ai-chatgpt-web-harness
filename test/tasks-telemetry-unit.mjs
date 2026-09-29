import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import {
  completeNativeToolTask,
  createNativeToolTask
} from '../src/mcp/nativeToolTasks.js';
import { getNativeTask, getNativeTaskRecord } from '../src/mcp/nativeTaskService.js';
import { initializeTelemetry, runSpan, sanitizeAttributes, shutdownTelemetry, summarizeCommandForTelemetry, telemetrySampleRatio, telemetryStatus } from '../src/telemetry.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-tool-task-'));
const config = { stateDir: root };
try {
  const created = createNativeToolTask(config, {
    method: 'tools/call',
    name: 'relai_validate',
    workspace: 'app',
    logicalTaskId: 'logical-task',
    principal: 'client-a'
  });
  assert.equal(created.status, 'working');
  assert.match(created.taskId, /^task_/);
  assert.equal(getNativeTaskRecord(config, created.taskId, { principal: 'client-a' }).internal.workspace, 'app');
  assert.throws(
    () => getNativeTask(config, created.taskId, { principal: 'client-b' }),
    /not available/
  );

  const completed = await completeNativeToolTask(config, created.taskId, { ok: true });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(getNativeTask(config, created.taskId, { principal: 'client-a' }).result, { ok: true });
  assert.equal(fs.existsSync(path.join(root, 'operation-tasks')), false);
  assert.equal(fs.existsSync(path.join(root, 'native-tasks')), false, 'native tasks must not create a JSON/lock directory');

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
  assert.equal(attributes['relai.process.command'], 'npm [4 args]');
  assert.equal(attributes['safe.number'], 2);
  assert.equal(summarizeCommandForTelemetry('git status --short'), 'git [2 args]');
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
    const official = telemetryStatus({ telemetry: { diagnosticsEnabled: false, sampleRatio: 1 } });
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
        body: Buffer.concat(chunks)
      });
      response.statusCode = 200;
      response.end();
    });
  });
  const previousUsageEndpoint = process.env.REL_AI_MAINTAINER_USAGE_ENDPOINT;
  const previousDiagnosticsEndpoint = process.env.REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT;
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
    assert.match(firstIdentityState.lastReportedAt, /^\d{4}-\d{2}-\d{2}T/, 'successful usage reporting must persist the last report time');
    assert.equal(firstIdentityState.lastReportedVersion, '1.1.4', 'successful usage reporting must persist the reported app version');

    const usageRequests = requests.filter(request => request.path === '/api/v1/installation/presence');
    assert.equal(usageRequests.length, 1, 'initialization must send one presence event');
    assert.match(usageRequests[0].contentType, /^application\/json/i);
    const presence = JSON.parse(usageRequests[0].body.toString('utf8'));
    assert.deepEqual(Object.keys(presence).sort(), ['arch', 'installationId', 'platform', 'schemaVersion', 'version']);
    assert.equal(presence.schemaVersion, 1);
    assert.equal(presence.installationId, firstIdentityState.installationId);
    assert.equal(presence.version, '1.1.4');
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
      'successful usage reporting must not repeat within 24 hours across restarts'
    );

    fs.writeFileSync(identityPath, JSON.stringify({
      ...secondIdentityState,
      lastReportedVersion: '1.1.3'
    }, null, 2));
    initializeTelemetry(usageOnlyConfig);
    await shutdownTelemetry();
    assert.equal(
      requests.filter(request => request.path === '/api/v1/installation/presence').length,
      2,
      'an app version change must report immediately even when the previous presence was less than 24 hours ago'
    );
    const upgradedIdentityState = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    assert.equal(upgradedIdentityState.lastReportedVersion, '1.1.4');

    const secret = 'SECRET_EXCEPTION_MARKER';
    const privatePath = 'C:\\private\\project\\file.js';
    await assert.rejects(
      () => runSpan({ stateDir: root, telemetry: { diagnosticsEnabled: true, sampleRatio: 1 } }, 'relai.test.privacy', {}, async () => {
        const error = new Error(`${secret} ${privatePath}`);
        error.name = 'SECRET_ERROR_NAME';
        throw error;
      }),
      new RegExp(secret)
    );
    await shutdownTelemetry();

    const diagnosticPayload = Buffer.concat(
      requests
        .filter(request => request.path === '/v1/traces')
        .map(request => request.body)
    );
    assert.ok(diagnosticPayload.length > 0, 'enabled diagnostics must export OTLP spans');
    assert.equal(diagnosticPayload.includes(Buffer.from(secret)), false, 'OTLP payloads must never include raw exception messages');
    assert.equal(diagnosticPayload.includes(Buffer.from(privatePath)), false, 'OTLP payloads must never include raw local paths from exceptions');
  } finally {
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

console.log('Native tool-task ownership and telemetry redaction tests passed.');
