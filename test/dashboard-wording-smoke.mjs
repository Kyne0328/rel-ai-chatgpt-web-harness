import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { availablePort } from './helpers/available-port.mjs';
import { activeToolCount } from './helpers/tool-surface.mjs';
import { overviewWorkspaceStatus, resolveBridgeState } from '../src/ui/features/home/index.js';
import { workspaceCardView } from '../src/ui/features/workspaces/model.js';

const readyConnectionState = {
  localService: { status: 'running' },
  publicEndpoint: { status: 'available' },
  chatgptReadiness: { status: 'ready' },
  mcpClient: { status: 'idle' },
  dashboardUpdates: { status: 'live' }
};
const activeReadyState = resolveBridgeState({ connectionState: { ...readyConnectionState, mcpClient: { status: 'active' } } });
assert.equal(activeReadyState.tone, 'good', 'routine ChatGPT activity must not expand the connection warning banner');
const activeFailedState = resolveBridgeState({ connectionState: { ...readyConnectionState, publicEndpoint: { status: 'unavailable' }, mcpClient: { status: 'active' } } });
assert.equal(activeFailedState.tone, 'bad', 'an active request must not conceal a failed tunnel');
const warningState = resolveBridgeState({
  findings: [{ severity: 'warning', code: 'audit_stale', message: 'Audit activity is stale.' }],
  connectionState: readyConnectionState
});
assert.equal(warningState.tone, 'warn', 'warning-only health findings must stay non-blocking');
assert.equal(warningState.kicker, 'Connected with warning');
assert.doesNotMatch(warningState.description, /before automated changes/i);
const errorState = resolveBridgeState({
  findings: [{ severity: 'error', code: 'workspace_unavailable', message: 'Workspace is unavailable.' }],
  connectionState: readyConnectionState
});
assert.equal(errorState.tone, 'bad', 'error health findings must still block readiness');
assert.equal(errorState.kicker, 'System needs attention');
assert.equal(errorState.actionHref, '#diagnostics');
const matchingBlock = { blocked: true, message: 'Process cleanup remains unverified.' };
const projectCard = workspaceCardView({ alias: 'app', operational: { exists: true } }, { ok: true },
  { severity: 'error', code: 'workspace_mutation_blocked', workspace: 'app', mutationBlock: matchingBlock });
assert.equal(projectCard.ready, false, 'Projects must not show Ready while Overview reports a mutation block');
assert.equal(projectCard.mutationBlock, matchingBlock);
const mutationBlockedState = resolveBridgeState({
  findings: [{ severity: 'error', code: 'workspace_mutation_blocked', workspace: 'one-ui-peridot' }],
  connectionState: readyConnectionState
});
assert.equal(mutationBlockedState.actionLabel, 'Verify project recovery');
assert.equal(mutationBlockedState.actionHref, '#workspaces?workspace=one-ui-peridot');
assert.match(mutationBlockedState.description, /connection is working/i);
const missingProjectState = resolveBridgeState({
  workspaces: [{ alias: 'deleted-project', path: 'C:/projects/deleted-project' }],
  findings: [{ severity: 'error', code: 'workspace_unavailable', workspace: 'deleted-project', message: "Workspace 'deleted-project' path does not exist: C:/projects/deleted-project" }],
  connectionState: readyConnectionState
});
assert.equal(missingProjectState.tone, 'bad');
assert.match(missingProjectState.title, /deleted-project.*folder is missing/);
assert.match(missingProjectState.description, /C:\/projects\/deleted-project/);
assert.match(missingProjectState.description, /connection is still available/i);
assert.equal(missingProjectState.actionLabel, 'Fix project');
assert.equal(missingProjectState.actionHref, '#workspaces?workspace=deleted-project&focus=1');
const activeConnectionProjectState = resolveBridgeState({
  workspaces: [{ alias: 'deleted-project', path: 'C:/projects/deleted-project' }],
  findings: [{ severity: 'error', code: 'workspace_unavailable', workspace: 'deleted-project', message: 'path does not exist' }],
  connectionState: { ...readyConnectionState, mcpClient: { status: 'active' } }
});
assert.equal(activeConnectionProjectState.actionLabel, 'Fix project', 'active requests must not hide project folder failures');
const unreachableConnectionState = resolveBridgeState({
  findings: [{ severity: 'error', code: 'workspace_unavailable', workspace: 'deleted-project', message: 'path does not exist' }],
  connectionState: { ...readyConnectionState, publicEndpoint: { status: 'unavailable' } }
});
assert.match(unreachableConnectionState.title, /connection unavailable/i, 'connection failure must not be hidden by a missing project');
assert.equal(overviewWorkspaceStatus({ alias: 'app' }, [{ workspace: 'app', severity: 'warning' }]), 'ready');
assert.equal(overviewWorkspaceStatus({ alias: 'app' }, [{ workspace: 'app', severity: 'error' }]), 'needs attention');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const port = await availablePort();
const token = process.env.TEST_TOKEN ?? 'dashboard-wording-smoke-token';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-dashboard-wording-'));

const child = spawn(process.execPath, [path.join(root, 'bin', 'rel-ai-mcp-http.js'), '--host', '127.0.0.1', '--port', String(port), '--no-profile-write'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    REL_AI_MCP_CONFIG: path.join(root, 'examples', 'config.example.json'),
    REL_AI_MCP_TOKEN: token,
    REL_AI_MCP_STATE_DIR: stateDir,
  }
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

async function waitForHealth() {
  const url = `http://127.0.0.1:${port}/health`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP server did not become healthy within 8s. stderr:\n${stderr}`);
}

const health = await waitForHealth();
if (!health.ok) {
  child.kill('SIGKILL');
  throw new Error('Health endpoint returned not-ok');
}

// --- 1. Fetch dashboard JSON and check for forbidden terms ---
const dashboardLogin = await fetch(`http://127.0.0.1:${port}/dashboard?token=${encodeURIComponent(token)}`);
if (!dashboardLogin.ok) {
  child.kill('SIGKILL');
  throw new Error(`Dashboard login returned ${dashboardLogin.status}`);
}
const dashboardCookie = String(dashboardLogin.headers.get('set-cookie') || '').split(';')[0];
await dashboardLogin.arrayBuffer();
const recoveryUrl = `http://127.0.0.1:${port}/api/workspace/mutation-recovery`;
const recoveryBody = JSON.stringify({ workspace: 'unconfigured-test-project' });
const unauthenticatedRecovery = await fetch(recoveryUrl, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: recoveryBody
});
assert.equal(unauthenticatedRecovery.status, 401, 'project mutation recovery must require dashboard authorization');
const forcedRecovery = await fetch(recoveryUrl, {
  method: 'POST', headers: { cookie: dashboardCookie, 'content-type': 'application/json' },
  body: JSON.stringify({ workspace: 'unconfigured-test-project', force: true })
});
assert.equal(forcedRecovery.status, 400, 'project mutation recovery must not permit a forced unlock');
const unknownRecovery = await fetch(recoveryUrl, {
  method: 'POST', headers: { cookie: dashboardCookie, 'content-type': 'application/json' }, body: recoveryBody
});
assert.equal(unknownRecovery.status, 404, 'recovery must not accept unconfigured project identities');
const dashboardUrl = `http://127.0.0.1:${port}/api/dashboard/v10`;
const dashboardResponse = await fetch(dashboardUrl, { headers: { cookie: dashboardCookie } });
if (!dashboardResponse.ok) {
  child.kill('SIGKILL');
  throw new Error(`Dashboard API returned ${dashboardResponse.status}`);
}
const dashboardData = await dashboardResponse.json();
const dashboardJson = JSON.stringify(dashboardData);

const forbiddenInDashboard = [
  { label: 'aggressive', pattern: /\baggressive\b/i },
  { label: 'fast mode', pattern: /\bfast mode\b/i },
  { label: 'fast path', pattern: /\bfast path\b/i },
];

const dashboardFindings = [];
for (const item of forbiddenInDashboard) {
  if (item.pattern.test(dashboardJson)) {
    dashboardFindings.push('Dashboard JSON contains a forbidden workflow term.');
  }
}

if (dashboardFindings.length) {
  child.kill('SIGKILL');
  console.error('Dashboard wording smoke test FAILED — forbidden terms in dashboard response:');
  for (const msg of dashboardFindings) console.error(`  ${msg}`);
  process.exit(1);
}

// --- 2. Check required terms are present in dashboard JSON ---
if (!Array.isArray(dashboardData?.tools) || dashboardData.tools.length !== activeToolCount) {
  child.kill('SIGKILL');
  console.error(`Dashboard wording smoke test FAILED — dashboard JSON must expose ${activeToolCount} active tools`);
  process.exit(1);
}
if (!Array.isArray(dashboardData?.taskActivity?.tasks) || typeof dashboardData?.taskActivity?.activeTaskCount !== 'number') {
  child.kill('SIGKILL');
  console.error('Dashboard wording smoke test FAILED — task activity must expose concurrent task records');
  process.exit(1);
}
if (!dashboardData?.connectionState?.localService || !dashboardData?.connectionState?.publicEndpoint || !dashboardData?.connectionState?.chatgptReadiness || !dashboardData?.connectionState?.dashboardUpdates) {
  child.kill('SIGKILL');
  console.error('Dashboard wording smoke test FAILED — normalized connection layers are missing');
  process.exit(1);
}
if (!dashboardData?.mcpAuthentication || typeof dashboardData?.mcpAuthentication?.status !== 'string') {
  child.kill('SIGKILL');
  console.error('Dashboard wording smoke test FAILED — authoritative MCP authentication status is missing');
  process.exit(1);
}
if (!dashboardData?.mcpConnection || dashboardData?.mcpConnection?.activityStatus !== 'no_requests') {
  child.kill('SIGKILL');
  console.error('Dashboard wording smoke test FAILED — stateless MCP request activity is missing or incorrect');
  process.exit(1);
}
if (dashboardJson.includes('prepared') || dashboardJson.includes('apply_bundle')) {
  child.kill('SIGKILL');
  console.error('Dashboard wording smoke test FAILED — obsolete prepared/bundle workflow wording remains');
  process.exit(1);
}

child.kill('SIGKILL');
await once(child, 'close');
fs.rmSync(stateDir, { recursive: true, force: true });
console.log('Dashboard wording smoke test passed.');
