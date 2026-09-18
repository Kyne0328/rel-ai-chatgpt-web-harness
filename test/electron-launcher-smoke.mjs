import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utils = await import(pathToFileURL(path.join(root, 'electron', 'launcher-utils.js')).href);
const launcherConfigModule = await import(pathToFileURL(path.join(root, 'electron', 'launcher-config.js')).href);
const { saveLauncherConfig } = launcherConfigModule.default || launcherConfigModule;
const { hasExistingConfig, normalizePort, normalizeTunnelId, readGuiConfig } = utils.default || utils;

assert.equal(normalizePort(3333), 3333);
assert.equal(normalizePort('4444'), 4444);
assert.throws(() => normalizePort(80), /between 1024 and 65535/);
assert.equal(normalizeTunnelId(' tunnel_12345678 '), 'tunnel_12345678');
assert.throws(() => normalizeTunnelId('not-a-tunnel'), /must start with tunnel_/i);

const electronPkg = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const srcResource = electronPkg.build.extraResources.find(item => item.from === '../src');
assert.ok(srcResource, 'Electron packaging must include the backend source runtime.');
assert.deepEqual(srcResource.filter, ['**/*.js', '**/*.ts', '**/*.ps1']);
assert.equal(fs.existsSync(path.join(root, 'src', 'mcp', 'ui', 'workflow-card.html')), false, 'Electron packaging must not retain the removed ChatGPT iframe task card.');

for (const file of [
  'desktop-host.js',
  'secure-tunnel-runtime.js',
  'tunnel-credentials.js',
  'service-runtime.js',
  'service-process.js',
  'service-process-client.js',
  'runtime-log-snapshot.js',
  'service-activity-projection.js',
  'desktop-settings.js',
  'desktop-status.js',
  'preload.cjs',
  'ipc-handlers.js',
  'ipc-security.js',
  'window-security.js'
]) assert.ok(electronPkg.build.files.includes(file), `Electron packaging must include ${file}`);

const packagedElectronFiles = new Set(electronPkg.build.files.filter(file => typeof file === 'string' && !file.startsWith('!')));
for (const file of packagedElectronFiles) {
  if (file.includes('*') || !/\.(?:cjs|mjs|js)$/.test(file)) continue;
  const source = fs.readFileSync(path.join(root, 'electron', file), 'utf8');
  const localImports = [
    ...source.matchAll(/(?:import|export)\s+(?:.+?\s+from\s+)?['"](\.\/[^'"]+)['"]/g),
    ...source.matchAll(/import\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)
  ];
  for (const match of localImports) {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    assert.ok(packagedElectronFiles.has(dependency), `Electron packaging must include ${dependency}, imported by ${file}`);
  }
}

for (const removed of ['managed-ngrok.js', 'ngrok-token.js', 'public-connection-runtime.js', 'gateway-client.js', 'gateway-actions.js', 'gateway-device-identity.js', 'approval-token.js']) {
  assert.equal(electronPkg.build.files.includes(removed), false, `Electron packaging must not include removed transport module ${removed}`);
}

for (const [platform, filter] of [['win', ['manifest.json', 'win32/**']], ['linux', ['manifest.json', 'linux/**']]]) {
  const resource = electronPkg.build[platform].extraResources.find(item => item.from === '../vendor/tunnel-client');
  assert.ok(resource, `${platform} packaging must include the OpenAI tunnel client.`);
  assert.equal(resource.to, 'bin/tunnel-client');
  assert.deepEqual(resource.filter, filter);
  assert.equal(electronPkg.build[platform].extraResources.some(item => /vendor\/ngrok/i.test(String(item.from || ''))), false);
}
const ptyResources = {
  win: ['package.json', 'lib/**', 'prebuilds/win32-${arch}/**'],
  linux: ['package.json', 'lib/**', 'build/Release/pty.node', 'build/Release/spawn-helper'],
  mac: ['package.json', 'lib/**', 'prebuilds/darwin-${arch}/**']
};
for (const [platform, filter] of Object.entries(ptyResources)) {
  const resource = electronPkg.build[platform].extraResources.find(item => item.from === 'node_modules/node-pty');
  assert.ok(resource, `${platform} packaging must include the node-pty runtime.`);
  assert.equal(resource.to, 'node_modules/node-pty');
  assert.deepEqual(resource.filter, filter);
}
assert.equal(rootPkg.optionalDependencies?.['node-pty'], electronPkg.dependencies?.['node-pty'], 'root and packaged Electron PTY runtimes must use the same native dependency build');
assert.equal(electronPkg.dependencies?.['node-pty'], '1.1.0', 'packaged Electron PTY runtime must pin the native dependency exactly'); // rigidity-ok: node-pty is a native ABI dependency intentionally pinned for deterministic packaging.
assert.match(String(rootPkg.scripts['fetch:tunnel-client'] || ''), /scripts\/fetch-tunnel-client\.mjs/, 'fetch:tunnel-client must route to the tunnel-client fetcher');
assert.match(String(rootPkg.scripts['verify:tunnel-client'] || ''), /scripts\/verify-tunnel-client\.mjs/, 'verify:tunnel-client must route to the tunnel-client verifier');
assert.equal(rootPkg.scripts['fetch:ngrok'], undefined);
assert.equal(rootPkg.scripts['verify:ngrok'], undefined);

for (const renderer of ['status.html', 'wizard.html']) {
  const html = fs.readFileSync(path.join(root, 'electron', 'renderer', renderer), 'utf8');
  assert.ok(html.indexOf('color-tokens.css') < html.indexOf('app.css'), `${renderer} must load color tokens before component CSS.`);
}

const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const desktopHost = fs.readFileSync(path.join(root, 'electron', 'desktop-host.js'), 'utf8');
const serviceProcess = fs.readFileSync(path.join(root, 'electron', 'service-process.js'), 'utf8');
const serviceRuntime = fs.readFileSync(path.join(root, 'electron', 'service-runtime.js'), 'utf8');
assert.match(main, /createDesktopHost/);
assert.doesNotMatch(main, /await desktop\.start\(\)/, 'Awaiting startup at module scope deadlocks Electron readiness');
assert.match(main, /desktop\.start\(\)\.catch\(/, 'Desktop startup failures must be handled');
assert.doesNotMatch(main, /createSecureTunnelRuntime|createTunnelCredentialStore|createServiceProcessClient|registerIpcHandlers/, 'Electron main must remain a composition root rather than a behavioral module');
assert.match(desktopHost, /createSecureTunnelRuntime/);
assert.match(desktopHost, /createTunnelCredentialStore/);
assert.match(desktopHost, /createServiceProcessClient/);
assert.match(desktopHost, /utilityProcess/);
assert.doesNotMatch(desktopHost, /startHttpServer|stopAllManagedProcesses/, 'Electron desktop host must not own the MCP HTTP/runtime process path');
assert.doesNotMatch(desktopHost, /readLocalUsageSnapshot(?:Async)?|onboardingState|taskCodeWorkspace/, 'Rel.AI business operations must stay behind the utility-process boundary');
assert.match(desktopHost, /getLocalUsage:\s*serviceProcessClient\.getLocalUsage/);
assert.match(serviceProcess, /desktop-local-usage/);
assert.match(serviceProcess, /desktop-onboarding-handoff/);
assert.match(serviceProcess, /desktop-task-code-workspace/);
assert.doesNotMatch(main, /createGatewayClient|createPublicConnectionRuntime|createApprovalTokenManager|managedNgrok/);
assert.match(serviceRuntime, /serviceProcessClient\.start\(\{[\s\S]*host:[\s\S]*port:[\s\S]*token:/s);
assert.match(serviceRuntime, /secureTunnelRuntime\.start\(\{[\s\S]*tunnelId:[\s\S]*port:[\s\S]*localToken:[\s\S]*apiKey/s);
assert.match(serviceRuntime, /http:\/\/127\.0\.0\.1:\$\{actualPort\}/);
assert.doesNotMatch(serviceRuntime, /isPortAvailable/, 'desktop startup must bind the real service once and handle EADDRINUSE directly');
assert.doesNotMatch(serviceRuntime, /connectionMode|gateway|ngrok|onOAuthAuthorized/i);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-gui-test-'));
const configPath = path.join(stateDir, 'config.json');
const previousState = process.env.REL_AI_MCP_STATE_DIR;
const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_STATE_DIR = stateDir;
process.env.REL_AI_MCP_CONFIG = configPath;
try {
  assert.equal(hasExistingConfig(), false);
  saveLauncherConfig({ port: 3333, tunnelId: 'tunnel_12345678', token: 'local-token-value' });
  assert.equal(hasExistingConfig(), true);
  assert.deepEqual(readGuiConfig(), { port: 3333, tunnelId: 'tunnel_12345678', token: 'local-token-value' });

  const env = fs.readFileSync(path.join(stateDir, '.env'), 'utf8');
  assert.match(env, /REL_AI_MCP_PORT/);
  assert.match(env, /REL_AI_MCP_TOKEN/);
  assert.match(env, /REL_AI_MCP_TUNNEL_ID/);
  assert.doesNotMatch(env, /NGROK|GATEWAY|CONNECTION_MODE|PUBLIC_URL/);

  const profile = JSON.parse(fs.readFileSync(path.join(stateDir, 'connection.json'), 'utf8'));
  assert.equal(profile.tunnelId, 'tunnel_12345678');
  assert.equal(profile.tunnelProvider, 'openai-secure-mcp');
  assert.equal(Object.hasOwn(profile, 'connector' + 'Name'), false);
  assert.equal(profile.host, '127.0.0.1');
  assert.equal('publicUrl' in profile, false);
  assert.equal('connectionMode' in profile, false);
  assert.equal('gatewayOrigin' in profile, false);

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.workspaces.keep = { path: stateDir };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  saveLauncherConfig({ port: 4444, tunnelId: 'tunnel_abcdefgh', token: 'local-token-value' });
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).workspaces.keep.path, stateDir, 'Saving connection settings must preserve the core workspace config.');
} finally {
  if (previousState === undefined) delete process.env.REL_AI_MCP_STATE_DIR; else process.env.REL_AI_MCP_STATE_DIR = previousState;
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG; else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log('Electron launcher Secure MCP Tunnel contracts passed.');
