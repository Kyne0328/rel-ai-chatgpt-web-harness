import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

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

// A first-ever launch must surface the UI even if the process was invoked by a background/login path.
const routeSource = desktopHostSource.slice(
  desktopHostSource.indexOf('  function routeInitialWindow(lifecycleStatus = {}) {'),
  desktopHostSource.indexOf('  async function launchConfiguredDesktop(launchOptions = {}) {')
);
const configuredLaunches = [];
const routeInitialWindow = runInNewContext(`${routeSource}\nrouteInitialWindow`, {
  hasConfiguredDesktop: () => true,
  runtimeLogs: { append() {} },
  launchConfiguredDesktop: options => { configuredLaunches.push(options); },
  isManualUpdateInstall: () => false,
  setupWindowManager: { create() { throw new Error('configured launch must not open setup'); } },
  app: { getVersion: () => '1.1.4' }
});
routeInitialWindow({ firstLaunch: true, openedAtLogin: true });
routeInitialWindow({ firstLaunch: false, openedAtLogin: true });
assert.equal(configuredLaunches[0]?.background, false, 'the first-ever configured launch must open the dashboard instead of staying hidden');
assert.equal(configuredLaunches[1]?.background, true, 'later launch-at-login starts must continue running in the background');

// A foreground startup shows progress, while login/background starts stay silent.
const launchSource = desktopHostSource.slice(
  desktopHostSource.indexOf('  async function launchConfiguredDesktop(launchOptions = {}) {'),
  desktopHostSource.indexOf('  async function relaunchApplication() {')
);
async function exerciseLaunch(options, listening, errorCode = '') {
  const events = [];
  const context = {
    startupSplash: {
      show() { events.push('splash'); },
      update(value) { events.push(value); },
      hide() { events.push('dismiss'); }
    },
    startServer: async () => { events.push('start-service'); return { serverRunning: listening }; },
    serviceRuntime: { isListening: () => listening, waitUntilListening: async () => ({ serverRunning: listening }) },
    showDashboardWindow: async () => { events.push('dashboard'); },
    setupWindowManager: { getWindow: () => null },
    cancelStartupRetry: () => {},
    showStartupProblem: message => events.push('problem: ' + message),
    scheduleStartupRetry: () => events.push('retry'),
    startupRetryAttempt: 0,
    serviceProcessClient: { markOnboardingHandoff: async () => {
      if (options.simulateHandoffTimeout) throw new Error('Rel.AI service request timed out: desktop-onboarding-handoff');
    } },
    appUpdater: { getStatus: () => ({}) },
    pendingLogout: null,
    desktopPower: { getStatus: () => ({}) },
    taskActivityBlockReason: () => '',
    currentStatus: { serverRunning: listening, errorCode },
    runtimeLogs: { append(message) { events.push('log: ' + message); } },
    ERROR_CODES: { DASHBOARD_UNAVAILABLE: 'dashboard', LOCAL_SERVICE_START_FAILED: 'service', CONFIGURATION_INVALID: 'config' },
    stopServer: async () => {},
    desktopStatusFailure: () => ({}),
    setStatus: () => {},
    formatError: error => String(error)
  };
  const launch = runInNewContext(launchSource + '\nlaunchConfiguredDesktop', context);
  await launch(options);
  return events;
}
const visibleLaunch = await exerciseLaunch({}, true);
assert.deepEqual(visibleLaunch.slice(0, 3), ['splash', 'Starting local service…', 'start-service']);
assert.deepEqual(visibleLaunch.slice(-2), ['Opening dashboard…', 'dashboard']);
const quietLaunch = await exerciseLaunch({ background: true }, true);
assert.ok(!quietLaunch.includes('splash'), 'launch-at-login must not open a splash');
assert.ok(!quietLaunch.includes('dashboard'), 'launch-at-login must remain background-only');
const failedLaunch = await exerciseLaunch({}, false);
assert.deepEqual(failedLaunch.slice(-2), ['problem: Local service unavailable. Retrying automatically…', 'retry'],
  'startup failure must schedule a safe retry without showing a recovery page');
const invalidConfigLaunch = await exerciseLaunch({}, false, 'config');
assert.ok(invalidConfigLaunch.includes('problem: Connection settings need attention.'), 'a configuration blocker must explain why setup is needed');
assert.ok(!invalidConfigLaunch.includes('retry'), 'a permanent configuration problem must not enter a restart loop');
const lateHandoff = await exerciseLaunch({ firstRun: true, simulateHandoffTimeout: true }, true);
assert.ok(lateHandoff.includes('dashboard'), 'a late onboarding handoff must not prevent opening a healthy dashboard');
assert.ok(!lateHandoff.includes('retry'), 'a late handoff must not trigger a service restart');
assert.ok(lateHandoff.some(entry => entry.startsWith('log: Onboarding handoff could not be confirmed:')),
  'lost onboarding acknowledgment must be recorded as a warning, not a service failure');

// Dashboard bootstrap may be delayed even when the utility remains listening.
const bootstrapSource = serviceRuntimeSource.slice(
  serviceRuntimeSource.indexOf('  async function buildDashboardConnection() {'),
  serviceRuntimeSource.indexOf('  return { startServer, restartConnection,', serviceRuntimeSource.indexOf('  async function buildDashboardConnection() {'))
);
let bootstrapCalls = 0;
const bootstrapConnection = runInNewContext(`${bootstrapSource}\nbuildDashboardConnection`, {
  isListening: () => true,
  serviceProcessClient: { async dashboardBootstrap() {
    bootstrapCalls += 1;
    if (bootstrapCalls === 1) throw Object.assign(new Error('late response'), { code: 'REL_AI_SERVICE_REQUEST_TIMEOUT' });
    return { port: 3333, bootstrap: 'new-token' };
  } },
  dashboardWindowManager: { getState: () => ({ customTitleBar: false, platform: 'win32' }) },
  lifecycleToken: 5
});
const bootstrapped = await bootstrapConnection();
assert.equal(bootstrapCalls, 2, 'a late bootstrap acknowledgment must be retried without restarting the service');
assert.ok(bootstrapped.url.includes('bootstrap=new-token'));
assert.equal(bootstrapped.authGeneration, 5);


// Reopening a stopped service must recover regardless of the retained window.
const focusSource = desktopHostSource.slice(
  desktopHostSource.indexOf('  function focusActiveWindow() {'),
  desktopHostSource.indexOf('  function currentDashboardStatus() {')
);
for (const surface of ['dashboard', 'splash']) {
  let dashboardOpenCalls = 0;
  let staleWindowShowCalls = 0;
  const focus = runInNewContext(`${focusSource}\nfocusActiveWindow`, {
    taskbarCompletionBadge: { clear() {} },
    dashboardWindowManager: { getWindow: () => surface === 'dashboard' ? {
      show() { staleWindowShowCalls += 1; }, focus() {}
    } : null },
    startupSplash: { getWindow: () => surface === 'splash' ? { isVisible: () => true } : null },
    setupWindowManager: { getWindow: () => null, create() {} },
    hasConfiguredDesktop: () => true,
    serviceRuntime: { isListening: () => false },
    openDashboardWindow: async () => { dashboardOpenCalls += 1; }
  });
  focus();
  assert.equal(dashboardOpenCalls, 1, `reopening a stopped ${surface} must use the service startup path`);
  assert.equal(staleWindowShowCalls, 0, `reopening a stopped ${surface} must not only reveal the stale window`);
}

// Desktop configuration gates must recognize the persisted local-only mode.
const configuredSource = desktopHostSource.slice(
  desktopHostSource.indexOf('  function hasConfiguredDesktop() {'),
  desktopHostSource.indexOf('  function focusActiveWindow() {')
);
const openSource = desktopHostSource.slice(
  desktopHostSource.indexOf("  async function openDashboardWindow(routeHash = '', windowOptions = {}) {"),
  desktopHostSource.indexOf('  function openDashboardSettings() {')
);
const localOnlyState = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-only-routing-'));
const previousLocalOnlyState = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_STATE_DIR = localOnlyState;
const connectionProfile = await import(pathToFileURL(path.join(root, 'src', 'connectionProfile.js')).href);
try {
  for (const fixture of [
    { localOnly: true, key: false, configured: true },
    { localOnly: false, key: false, configured: true },
    { localOnly: false, key: true, configured: true }
  ]) {
    connectionProfile.writeLaunchEnv({ REL_AI_MCP_PORT: '3333',
      REL_AI_MCP_LOCAL_ONLY: fixture.localOnly ? '1' : '0',
      REL_AI_MCP_TUNNEL_ID: fixture.localOnly ? '' : 'tunnel_12345678' }, { replace: true });
    connectionProfile.writeConnectionProfile({ port: 3333,
      tunnelId: fixture.localOnly ? '' : 'tunnel_12345678' }, { replace: true });
    let setupCalls = 0;
    let dashboardCalls = 0;
    let launches = 0;
    let focusOpens = 0;
    const context = {
      hasExistingConfig: launcherUtils.hasExistingConfig, readGuiConfig: launcherUtils.readGuiConfig,
      tunnelCredentials: { status: () => ({ apiKeyConfigured: fixture.key }) },
      runtimeLogs: { append() {} }, taskbarCompletionBadge: { clear() {} },
      launchConfiguredDesktop: () => { launches += 1; },
      isManualUpdateInstall: () => false, app: { getVersion: () => '1.1.4' },
      setupWindowManager: { getWindow: () => null, create() { setupCalls += 1; } },
      dashboardWindowManager: { getWindow: () => null },
      serviceRuntime: { isListening: () => true },
      showDashboardWindow: async () => { dashboardCalls += 1; },
      openDashboardWindow: async () => { focusOpens += 1; }
    };
    const route = runInNewContext(configuredSource + routeSource + '\nrouteInitialWindow', context);
    route({});
    assert.equal(launches, fixture.configured ? 1 : 0, 'startup must honor local-only configuration');
    const open = runInNewContext(configuredSource + openSource + '\nopenDashboardWindow', context);
    assert.equal((await open()).ok, fixture.configured, 'opening the dashboard must honor local-only configuration');
    assert.equal(dashboardCalls, fixture.configured ? 1 : 0);
    // Use a separate context because openSource declares openDashboardWindow.
    const focus = runInNewContext(configuredSource + focusSource + '\nfocusActiveWindow', {
      ...context, openDashboardWindow: async () => { focusOpens += 1; }
    });
    focus();
    assert.equal(focusOpens, fixture.configured ? 1 : 0, 'focusing a stopped/closed dashboard must honor local-only configuration');
    assert.equal(setupCalls, fixture.configured ? 0 : 3, 'persisted configuration must open the dashboard so a missing key can be repaired');
  }
  connectionProfile.clearConnectionState();
  assert.equal(runInNewContext(configuredSource + '\nhasConfiguredDesktop()', {
    hasExistingConfig: launcherUtils.hasExistingConfig, readGuiConfig: launcherUtils.readGuiConfig,
    tunnelCredentials: { status: () => ({ apiKeyConfigured: true }) }
  }), false, 'missing configuration cannot be replaced by a stored API key');
} finally {
  if (previousLocalOnlyState === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousLocalOnlyState;
  fs.rmSync(localOnlyState, { recursive: true, force: true });
}

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

// A malformed optional connection document must not block primary/local recovery.
{
  const { createTunnelConnectionStore } = await import('../electron/tunnel-connections.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-corrupt-connections-'));
  try {
    const store = createTunnelConnectionStore({ stateDir: directory, safeStorage: {
      isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString()
    } });
    const original = Buffer.from('{broken');
    fs.writeFileSync(store.statePath(), original);
    const publication = [];
    const source = desktopHostSource.slice(desktopHostSource.indexOf('  function syncServiceContext()'), desktopHostSource.indexOf('  function assertInstallerSettled()'));
    const settings = desktopHostSource.slice(desktopHostSource.indexOf('  function currentDesktopSettings()'), desktopHostSource.indexOf('  function updateDesktopSettings('));
    const api = runInNewContext(source + settings + '\n({ syncServiceContext, configuredGoalConnections, currentDesktopSettings })', {
      pendingLogout: null, currentStatus: {}, lastServiceContextKey: '',
      readGuiConfig: () => ({ tunnelId: 'tunnel_primaryfixture123' }),
      readDesktopSettings: () => ({ tunnelId: 'tunnel_primaryfixture123' }),
      tunnelConnections: store, updateRuntimeAccess: () => ({ blocked: false }),
      tunnelCredentials: { status: () => ({ apiKeyConfigured: true }) },
      desktopNotifications: { getPreferences: () => ({ enabled: true }) },
      additionalTunnelRuntime: { snapshot: () => ({ connections: [] }) },
      serviceProcessClient: { updateContext: value => publication.push(value) }
    });
    api.syncServiceContext();
    assert.equal(publication.length, 1, 'service context must still publish while optional tunnel settings are corrupt');
    assert.equal(publication[0].tunnelConnections.length, 1);
    assert.equal(publication[0].tunnelConnections[0].tunnelId, 'tunnel_primaryfixture123');
    const view = api.currentDesktopSettings();
    assert.equal(view.additionalTunnels.length, 0, 'unreadable peer identities must not be authorized');
    assert.match(view.additionalTunnelError, /preserved/);
    assert.deepEqual(fs.readFileSync(store.statePath()), original);
    assert.throws(() => store.upsert({ tunnelId: 'tunnel_newfixture123', apiKey: 'fixture-api-key' }), /settings are corrupted/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
