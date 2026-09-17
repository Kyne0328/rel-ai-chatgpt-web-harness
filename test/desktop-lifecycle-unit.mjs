import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDesktopLifecycleManager, detectStartupSupport } from "../electron/desktop-lifecycle.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-lifecycle-'));
let loginEnabled = false;
let loginSettings = null;
let loginReadSettings = null;
let clock = 0;
const logs = [];
const app = {
  isPackaged: true,
  getVersion: () => '0.21.0',
  getPath: () => stateDir,
  getLoginItemSettings: settings => {
    loginReadSettings = settings ? { ...settings, args: [...(settings.args || [])] } : settings;
    return { openAtLogin: loginEnabled };
  },
  setLoginItemSettings: settings => {
    loginSettings = { ...settings };
    loginEnabled = settings.openAtLogin === true;
  }
};
const now = () => new Date(Date.parse('2026-07-25T06:00:00.000Z') + (clock++ * 1000)).toISOString();

assert.equal(detectStartupSupport({ app, platform: 'win32', env: {} }).supported, true);
assert.match(detectStartupSupport({ app: { ...app, isPackaged: false }, platform: 'win32', env: {} }).reason, /installed Windows app/);
assert.match(detectStartupSupport({ app, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\RelAI' } }).reason, /Portable builds/);

const first = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-a', onLog: (message, options) => logs.push({ message, options }) });
const firstStatus = await first.start();
assert.equal(firstStatus.firstLaunch, true);
assert.equal(firstStatus.updated, false);
assert.equal(firstStatus.connectorRefreshRequired, false);
assert.equal(firstStatus.connectorRevision, 'surface-a');
assert.equal(firstStatus.recoveredAfterUncleanShutdown, false);
assert.equal(firstStatus.launchCount, 1);
assert.equal(firstStatus.launchAtLogin.supported, true);
assert.equal(firstStatus.launchAtLogin.enabled, false);
assert.equal(firstStatus.keepAwake, false);
assert.equal(firstStatus.keepRunningOnClose, true, 'closing the dashboard must keep tray mode by default');
assert.equal(firstStatus.pulseEnabled, true, 'ambient Pulse status must be enabled by default');
assert.equal(firstStatus.themePreference, 'system', 'Pulse follows system appearance until the dashboard theme is explicitly selected');
assert.equal(firstStatus.autoDownloadUpdates, false, 'updates must keep manual download as the safe default');
assert.equal(firstStatus.reducedBackgroundWork, false, 'normal background preparation must remain the default');
assert.equal(first.setLaunchAtLogin(true).ok, true);
assert.equal(first.getStatus().launchAtLogin.enabled, true);
assert.deepEqual(loginReadSettings, { path: process.execPath, args: ['--background'] }, 'login-item readback must identify the same executable and background args used during registration');
assert.deepEqual(loginSettings, {
  openAtLogin: true,
  openAsHidden: true,
  path: process.execPath,
  args: ['--background']
});
assert.equal((await first.setKeepAwake(true)).status.keepAwake, true);
const preferenceUpdate = await first.setPreferences({
  keepRunningOnClose: false,
  pulseEnabled: false,
  themePreference: 'dark',
  autoDownloadUpdates: true,
  reducedBackgroundWork: true
});
assert.equal(preferenceUpdate.ok, true);
assert.equal(preferenceUpdate.status.keepRunningOnClose, false);
assert.equal(preferenceUpdate.status.pulseEnabled, false);
assert.equal(preferenceUpdate.status.themePreference, 'dark');
assert.equal(preferenceUpdate.status.autoDownloadUpdates, true);
assert.equal(preferenceUpdate.status.reducedBackgroundWork, true);
assert.equal((await first.setPreferences({ autoDownloadUpdates: 'yes' })).ok, false, 'app preferences must reject non-boolean values');
assert.equal((await first.setPreferences({ themePreference: 'sepia' })).ok, false, 'app preferences must reject unknown themes');
const cleanStatus = await first.markCleanShutdown();
assert.equal((await first.markCleanShutdown()).lastCleanExitAt, cleanStatus.lastCleanExitAt);

const second = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-a', onLog: (message, options) => logs.push({ message, options }) });
const secondStatus = await second.start();
assert.equal(secondStatus.firstLaunch, false);
assert.equal(secondStatus.updated, false);
assert.equal(secondStatus.connectorRefreshRequired, false);
assert.equal(secondStatus.recoveredAfterUncleanShutdown, false);
assert.equal(secondStatus.launchCount, 2);
assert.equal(secondStatus.keepAwake, true, 'keep-awake preference must persist across desktop restarts');
assert.equal(secondStatus.keepRunningOnClose, false, 'close behavior must persist across desktop restarts');
assert.equal(secondStatus.pulseEnabled, false, 'Pulse preference must persist across desktop restarts');
assert.equal(secondStatus.themePreference, 'dark', 'Pulse theme preference must persist across desktop restarts');
assert.equal(secondStatus.autoDownloadUpdates, true, 'automatic download preference must persist across desktop restarts');
assert.equal(secondStatus.reducedBackgroundWork, true, 'reduced background work must persist across desktop restarts');
assert.equal((await second.setKeepAwake(false)).status.keepAwake, false);
await second.markCleanShutdown();

const statePath = path.join(stateDir, 'desktop-lifecycle.json');
const preDurableState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
delete preDurableState.pendingConnectorRefreshRevision;
fs.writeFileSync(statePath, `${JSON.stringify(preDurableState, null, 2)}\n`);
const migrated = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-a', onLog: (message, options) => logs.push({ message, options }) });
assert.equal((await migrated.start()).connectorRefreshRequired, true, 'existing lifecycle state from before durable refresh tracking must recover a potentially missed notice');
assert.equal((await migrated.acknowledgeConnectorRefresh()).ok, true);
await migrated.markCleanShutdown();

const previousState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const { connectorRevision: _legacyConnectorRevision, ...legacyState } = previousState;
fs.writeFileSync(statePath, `${JSON.stringify({ ...legacyState, version: '0.20.7', running: true }, null, 2)}\n`);
const updated = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-b', onLog: (message, options) => logs.push({ message, options }) });
const updatedStatus = await updated.start();
assert.equal(updatedStatus.updated, true);
assert.equal(updatedStatus.previousVersion, '0.20.7');
assert.equal(updatedStatus.connectorRefreshRequired, true, 'the first upgrade from lifecycle state without a connector revision must request a refresh');
assert.equal(updatedStatus.recoveredAfterUncleanShutdown, false, 'a version-changing updater restart must not be reported as an unexpected crash');
await updated.markCleanShutdown();

const changedSurface = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-c', onLog: (message, options) => logs.push({ message, options }) });
const changedSurfaceStatus = await changedSurface.start();
assert.equal(changedSurfaceStatus.updated, false);
assert.equal(changedSurfaceStatus.connectorRefreshRequired, true, 'a changed connector revision must request refresh even without an app-version change');
assert.equal(changedSurfaceStatus.pendingConnectorRefreshRevision, 'surface-c');
await changedSurface.markCleanShutdown();

const interruptedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.writeFileSync(statePath, `${JSON.stringify({ ...interruptedState, running: true }, null, 2)}\n`);
const recovered = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-c', onLog: (message, options) => logs.push({ message, options }) });
assert.equal((await recovered.start()).recoveredAfterUncleanShutdown, true);
assert.equal(recovered.getStatus().connectorRefreshRequired, true, 'an unacknowledged connector refresh must survive a restart');
assert.equal((await recovered.acknowledgeConnectorRefresh()).ok, true);
assert.equal(recovered.getStatus().connectorRefreshRequired, false, 'acknowledging the notice must clear the durable refresh requirement');
assert.ok(logs.some(entry => entry.options.code === 'unclean_shutdown_detected'));
await recovered.markCleanShutdown();

const acknowledgedRestart = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-c', onLog: (message, options) => logs.push({ message, options }) });
assert.equal((await acknowledgedRestart.start()).connectorRefreshRequired, false, 'an acknowledged connector revision must stay cleared on the next launch');
await acknowledgedRestart.markCleanShutdown();

const background = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, argv: ['RelAI.exe', '--background'], now, connectorRevision: 'surface-d' });
const backgroundStatus = await background.start();
assert.equal(backgroundStatus.openedAtLogin, true);
assert.equal(backgroundStatus.connectorRefreshRequired, true, 'a connector change detected during a background launch must remain pending');
await background.markCleanShutdown();

const afterBackground = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-d' });
assert.equal((await afterBackground.start()).connectorRefreshRequired, true, 'background startup must not consume the connector refresh notice');
assert.equal((await afterBackground.acknowledgeConnectorRefresh()).ok, true);
await afterBackground.markCleanShutdown();

const portable = createDesktopLifecycleManager({ app, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'RelAI.exe' }, now, connectorRevision: 'surface-b' });
assert.equal((await portable.start()).launchAtLogin.supported, false);
assert.equal(portable.setLaunchAtLogin(true).errorCode, 'startup_setting_not_supported');

fs.rmSync(stateDir, { recursive: true, force: true });
console.log('Desktop lifecycle unit tests passed.');
