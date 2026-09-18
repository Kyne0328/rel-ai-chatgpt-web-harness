import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-onboarding-config-'));
const configPath = path.join(stateDir, 'config.json');
const token = 'onboarding-config-token';
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_STATE_DIR = stateDir;
process.env.REL_AI_MCP_TOKEN = token;

import { invalidateConfigCache, makeDefaultConfig } from "../src/config.js";
import { createDashboardBootstrap } from "../src/http/dashboardSessions.ts";
import { startHttpServer } from "../src/httpServer.ts";
import { resetTaskHistoryCaches } from "../src/taskHistoryStorage.ts";
const server = startHttpServer({ host: '127.0.0.1', port: 0, token, exitOnError: false });
await once(server, 'listening');
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const bootstrap = createDashboardBootstrap(token);
const dashboardLaunch = await fetch(`${base}/dashboard?bootstrap=${encodeURIComponent(bootstrap)}`, {
  headers: { connection: 'close' }
});
assert.equal(dashboardLaunch.status, 200, `dashboard bootstrap should succeed, got ${dashboardLaunch.status}`);
const dashboardCookie = String(dashboardLaunch.headers.get('set-cookie') || '').split(';')[0];
assert.match(dashboardCookie, /^relai_dashboard_session=/);
await dashboardLaunch.arrayBuffer();

try {
  assert.equal(fs.existsSync(configPath), true, 'Hard-cutover server startup should materialize the canonical config immediately');
  const startupConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(startupConfig.version, makeDefaultConfig().version);
  assert.deepEqual(startupConfig.workspaces, {});

  const skip = await fetch(`${base}/api/onboarding/complete`, {
    method: 'POST',
    headers: {
      cookie: dashboardCookie,
      connection: 'close',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ completed: false, skipped: true })
  });
  assert.equal(skip.status, 200, `onboarding skip should succeed, got ${skip.status}`);
  assert.equal(fs.existsSync(configPath), true, 'skipping onboarding must create config.json');

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(config.workspaces, {}, 'skipped onboarding must create an empty valid workspace map');

  const dashboard = await fetch(`${base}/api/dashboard/v10?requireHttpToken=0`, {
    headers: { cookie: dashboardCookie, connection: 'close' }
  });
  assert.equal(dashboard.status, 200, `dashboard should load after onboarding skip, got ${dashboard.status}`);
  const dashboardBody = await dashboard.json();
  assert.equal(dashboardBody.ok, true);
  assert.deepEqual(dashboardBody.config.workspaces, []);

  const onboarding = JSON.parse(fs.readFileSync(path.join(stateDir, 'onboarding.json'), 'utf8'));
  assert.equal(onboarding.skipped, true);
  assert.equal(onboarding.completed, false);

  const skippedStatus = await fetch(`${base}/api/onboarding/status`, {
    headers: { cookie: dashboardCookie, connection: 'close' }
  }).then(response => response.json());
  assert.equal(skippedStatus.skipped, true);
  assert.equal(skippedStatus.needsOnboarding, false, 'skipped onboarding must stay dismissed after restart');

  fs.rmSync(path.join(stateDir, 'onboarding.json'));
  config.workspaces.existing = { path: stateDir };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  invalidateConfigCache();
  const migratedStatus = await fetch(`${base}/api/onboarding/status`, {
    headers: { cookie: dashboardCookie, connection: 'close' }
  }).then(response => response.json());
  assert.equal(migratedStatus.completed, true);
  assert.equal(migratedStatus.migrated, true);
  assert.equal(migratedStatus.needsOnboarding, false, 'existing configured workspaces must suppress first-run onboarding');
  const migratedOnboarding = JSON.parse(fs.readFileSync(path.join(stateDir, 'onboarding.json'), 'utf8'));
  assert.equal(migratedOnboarding.workspaceCount, 1);
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  resetTaskHistoryCaches();
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log('Onboarding config smoke passed');
