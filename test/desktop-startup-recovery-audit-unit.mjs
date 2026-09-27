import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1. Test launcher-utils isManualUpdateInstall & isReturningUserLifecycle
const launcherUtils = await import(pathToFileURL(path.join(root, 'electron', 'launcher-utils.js')).href);
const { isManualUpdateInstall, isReturningUserLifecycle } = launcherUtils.default || launcherUtils;

// Case 1A: Logged out user on same version (launchCount > 1, firstLaunch false, same version, updated false)
const loggedOutLifecycle = {
  firstLaunch: false,
  launchCount: 4,
  previousVersion: '0.9.5',
  currentVersion: '0.9.5',
  updated: false,
  versionDowngrade: false
};
assert.equal(
  isReturningUserLifecycle(loggedOutLifecycle),
  false,
  'isReturningUserLifecycle must return false for logged-out user on the same app version'
);
assert.equal(
  isManualUpdateInstall({ lifecycleStatus: loggedOutLifecycle, hasConfig: false }),
  false,
  'isManualUpdateInstall must return false for a logged out user launching without config on the same version'
);

// Case 1B: Actual version upgrade without config (e.g. installer overwrite that wiped config)
const updateLifecycle = {
  firstLaunch: false,
  launchCount: 2,
  previousVersion: '0.9.4',
  currentVersion: '0.9.5',
  updated: true
};
assert.equal(
  isReturningUserLifecycle(updateLifecycle),
  true,
  'isReturningUserLifecycle must return true when version changed'
);
assert.equal(
  isManualUpdateInstall({ lifecycleStatus: updateLifecycle, hasConfig: false }),
  true,
  'isManualUpdateInstall must return true when an actual version update occurred'
);

// Case 1C: Brand-new fresh install
const freshLifecycle = {
  firstLaunch: true,
  launchCount: 1,
  currentVersion: '0.9.5',
  updated: false
};
assert.equal(
  isReturningUserLifecycle(freshLifecycle),
  false,
  'isReturningUserLifecycle must return false for fresh install'
);
assert.equal(
  isManualUpdateInstall({ lifecycleStatus: freshLifecycle, hasConfig: false }),
  false,
  'isManualUpdateInstall must return false for brand new install'
);

// 2. Test desktop-settings saveDesktopSettings safety with unconfigured / empty state
const desktopSettingsModule = await import(pathToFileURL(path.join(root, 'electron', 'desktop-settings.js')).href);
const { readDesktopSettings, saveDesktopSettings } = desktopSettingsModule.default || desktopSettingsModule;

const tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-settings-audit-'));
const prevEnvState = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_STATE_DIR = tempStateDir;

try {
  // Read settings when unconfigured (empty state directory)
  const readResult = readDesktopSettings({});
  assert.equal(readResult.ok, true, 'readDesktopSettings must return ok: true even when unconfigured');
  assert.equal(readResult.port, 3333);
  assert.equal(readResult.tunnelId, '');

  // Save settings when completely unconfigured (readGuiConfig throws / fails before our fix)
  const saveResult = await saveDesktopSettings(
    { port: 3333, tunnelId: 'tunnel_12345678' },
    {
      restartDesktop: async () => ({ serverRunning: true }),
      restartConnection: async () => ({ serverRunning: true }),
      setTunnelApiKey: () => true,
      canRestart: () => ''
    }
  );
  assert.equal(saveResult.ok, true, 'saveDesktopSettings must succeed even when unconfigured without crashing');
} finally {
  if (prevEnvState === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = prevEnvState;
  fs.rmSync(tempStateDir, { recursive: true, force: true });
}

// 3. Static contract checks on desktop-host.js, service-runtime.js, ipc-handlers.js
const desktopHostSource = fs.readFileSync(path.join(root, 'electron', 'desktop-host.js'), 'utf8');
const serviceRuntimeSource = fs.readFileSync(path.join(root, 'electron', 'service-runtime.js'), 'utf8');
const ipcHandlersSource = fs.readFileSync(path.join(root, 'electron', 'ipc-handlers.js'), 'utf8');

// 3A. service-runtime ready timeout is resilient (>= 20 seconds, was 5 seconds)
assert.match(
  serviceRuntimeSource,
  /LOCAL_READY_TIMEOUT_MS\s*=\s*(?:2[0-9]|3[0-9])_?000/,
  'LOCAL_READY_TIMEOUT_MS must be at least 20,000ms to prevent false startup timeouts into recovery'
);

// 3B. service-runtime retryable local startup error includes EADDRINUSE
assert.match(
  serviceRuntimeSource,
  /code === 'EADDRINUSE'/,
  'isRetryableLocalStartupError must include EADDRINUSE'
);

// 3C. desktop-host openDashboardWindow does not launch server or route to recovery when unconfigured
assert.match(
  desktopHostSource,
  /async function openDashboardWindow[\s\S]*?const isConfigured = hasExistingConfig\(\) && tunnelCredentials\.status\(\)\.apiKeyConfigured;[\s\S]*?if \(!isConfigured\) \{[\s\S]*?setupWindowManager\.create\(\);[\s\S]*?return \{ ok: false, reason: 'unconfigured' \};/,
  'openDashboardWindow must check isConfigured and open setupWindow rather than dumping to recovery'
);

// 3D. desktop-host routeInitialWindow requires both config and credentials
assert.match(
  desktopHostSource,
  /function routeInitialWindow[\s\S]*?const hasConfig = hasExistingConfig\(\) && tunnelCredentials\.status\(\)\.apiKeyConfigured;/,
  'routeInitialWindow must check hasExistingConfig and apiKeyConfigured to avoid launching unconfigured desktop'
);

// 3E. desktop-host focusActiveWindow routes unconfigured requests to setup window
assert.match(
  desktopHostSource,
  /function focusActiveWindow[\s\S]*?const isConfigured = hasExistingConfig\(\) && tunnelCredentials\.status\(\)\.apiKeyConfigured;[\s\S]*?if \(!isConfigured\) \{[\s\S]*?setupWindowManager\.create\(\);/,
  'focusActiveWindow must check isConfigured and create setup window rather than dumping to recovery'
);

// 3F. desktop-host logout strips background and hidden flags on relaunch
assert.match(
  desktopHostSource,
  /const cleanArgs = process\.argv\.slice\(1\)\.filter\(arg => arg !== '--background' && arg !== '--hidden'\);[\s\S]*?app\.relaunch\(\{ args: cleanArgs \}\);/,
  'logoutApplication must strip background flags to avoid restarting headlessly'
);

// 3G. ipc-handlers WIZARD_DONE checks serverRunning before closing wizard
assert.match(
  ipcHandlersSource,
  /if \(status\?\.serverRunning === true\) \{[\s\S]*?closeWizard\(\{ returnToFallback: false \}\);[\s\S]*?\}/,
  'WIZARD_DONE must not close wizard prematurely when connection fails to start'
);

// 4. Test connectionProfile.clearConnectionState() retry and truncate fallback
const connectionProfileModule = await import(pathToFileURL(path.join(root, 'src', 'connectionProfile.js')).href);
const { clearConnectionState, readConnectionProfile, writeConnectionProfile } = connectionProfileModule;

const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-conn-audit-'));
const prevConnState = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_STATE_DIR = testStateDir;

try {
  writeConnectionProfile({ port: 3456, tunnelId: 'tunnel_test1234' });
  assert.equal(readConnectionProfile().port, 3456);

  // Clear state
  clearConnectionState();
  const profileAfterClear = readConnectionProfile();
  assert.equal(profileAfterClear.port, undefined, 'clearConnectionState must remove port from connection profile');
  assert.equal(profileAfterClear.tunnelId, undefined, 'clearConnectionState must remove tunnelId from connection profile');
} finally {
  if (prevConnState === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = prevConnState;
  fs.rmSync(testStateDir, { recursive: true, force: true });
}

console.log('Desktop startup & recovery audit regression unit tests passed.');
