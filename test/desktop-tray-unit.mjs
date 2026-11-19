import assert from 'node:assert/strict';

import { createDesktopTray } from '../electron/desktop-tray.js';

let status = { serverRunning: true, tunnelStatus: 'running', localMcpUrl: 'http://127.0.0.1:3333/mcp' };
let updateStatus = { state: 'downloading', availableVersion: '0.27.0', progress: { percent: 12.1 } };
let buildCount = 0;
let currentMenu = null;
let clipboardText = '';
let trayConstructionCount = 0;
let trayEvents = [];
let trayListeners = new Map();
let balloonOptions = null;
let primaryFocusCount = 0;
let dashboardOpenCount = 0;

class FakeTray {
  constructor(image) { this.image = image; this.menu = null; this.destroyed = false; trayConstructionCount += 1; }
  setToolTip() {}
  on(name, listener) { trayEvents.push(name); trayListeners.set(name, listener); }
  setContextMenu(menu) { this.menu = menu; currentMenu = menu; }
  displayBalloon(options) { balloonOptions = options; }
  destroy() { this.destroyed = true; }
}

const dependencies = {
  Tray: FakeTray,
  Menu: {
    buildFromTemplate(template) {
      buildCount += 1;
      return template;
    }
  },
  nativeImage: {
    createFromPath() {
      return {
        isEmpty: () => false,
        resize(options) {
          assert.deepEqual(options, { width: 32, height: 32 });
          return this;
        }
      };
    }
  },
  platform: 'win32',
  clipboard: { writeText(value) { clipboardText = value; } },
  iconPath: 'icon.png',
  getStatus: () => status,
  getUpdateStatus: () => updateStatus,
  openDashboard: async () => { dashboardOpenCount += 1; },
  focusPrimaryWindow() { primaryFocusCount += 1; },
  openDiagnostics: async () => {},
  openSettings: async () => {},
  startServer: async () => {},
  stopServer: async () => {},
  checkForUpdates: async () => ({ ok: true }),
  downloadUpdate: async () => ({ ok: true }),
  installUpdate: async () => ({ ok: true }),
  quit() {}
};

const tray = createDesktopTray(dependencies);
tray.setup();
assert.equal(buildCount, 1, 'tray setup builds the initial menu once');
assert.equal(tray.isAvailable(), true, 'successful tray construction must be observable by window close behavior');
assert.ok(trayEvents.includes('double-click'));
assert.ok(trayEvents.includes('balloon-click'), 'Windows notification balloons must focus the existing Rel.AI process instead of launching another Electron instance');
assert.equal(tray.showBalloon({ category: 'taskCompleted', title: 'Task completed', body: 'Done.' }), true);
assert.deepEqual(balloonOptions, {
  title: 'Task completed',
  content: 'Done.',
  iconType: 'info',
  noSound: false,
  respectQuietTime: true
});
trayListeners.get('balloon-click')?.();
assert.equal(primaryFocusCount, 1, 'clicking a Windows notification balloon must use the existing primary-window focus path');
trayListeners.get('double-click')();
currentMenu.find(item => item.label === 'Open Dashboard').click();
assert.equal(primaryFocusCount, 2, 'Windows tray double-click must activate the resident primary window');
assert.equal(dashboardOpenCount, 1, 'Open Dashboard must take the managed dashboard-open path');
assert.equal(tray.showBalloon({ category: 'errors', title: 'Rel.AI needs attention', body: 'Check settings.' }), true);
assert.equal(balloonOptions.iconType, 'error');
updateStatus = { ...updateStatus, progress: { percent: 12.4 } };
assert.equal(tray.update(), true, 'tray updates must rebuild the native context menu like the v0.25.1 implementation');
assert.equal(buildCount, 2);

updateStatus = { ...updateStatus, progress: { percent: 12.6 } };
assert.equal(tray.update(), true, 'a visible updater percentage change must refresh the native menu');
assert.equal(buildCount, 3);
assert.ok(currentMenu.some(item => item.label === 'Downloading update… 13%'));

updateStatus = { state: 'downloaded', availableVersion: '0.28.0', installMode: 'restart', integrityVerified: true };
assert.equal(tray.update(), true);
assert.ok(currentMenu.some(item => item.label === 'Install update v0.28.0'), 'Windows updates should describe the in-app install flow instead of a pre-emptive restart');
updateStatus = { state: 'downloaded', availableVersion: '0.28.0', installMode: 'open_dmg', integrityVerified: true };
assert.equal(tray.update(), true);
assert.ok(currentMenu.some(item => item.label === 'Open update DMG v0.28.0'), 'macOS manual installs must not be labeled as automatic restarts');

updateStatus = { state: 'installing', availableVersion: '0.28.0' };
assert.equal(tray.update(), true);
for (const label of ['Copy local MCP address', 'Stop Rel.AI', 'Troubleshooting', 'Settings', 'Quit Rel.AI MCP']) {
  assert.equal(currentMenu.find(item => item.label === label)?.enabled, false, `${label} must be disabled while the update owns the application lifecycle`);
}
assert.equal(currentMenu.find(item => item.label === 'Installing update…')?.enabled, false);
assert.notEqual(currentMenu.find(item => item.label === 'Open Dashboard')?.enabled, false, 'the dashboard must remain reachable so the user can see update progress');

updateStatus = { state: 'downloaded', availableVersion: '0.28.0', installMode: 'restart', integrityVerified: true };
status = { ...status, localMcpUrl: 'http://127.0.0.1:4444/mcp' };
assert.equal(tray.update(), true, 'menu actions must refresh when their captured desktop state changes');
const copyItem = currentMenu.find(item => item.label === 'Copy local MCP address');
copyItem.click();
assert.equal(clipboardText, status.localMcpUrl);

let trayIconError = null;
const constructionsBeforeMissingIcon = trayConstructionCount;
const missingIconTray = createDesktopTray({
  ...dependencies,
  nativeImage: { createFromPath() { return { isEmpty: () => true }; } },
  onError(error) { trayIconError = error; }
});
assert.equal(missingIconTray.setup(), null, 'an unreadable tray icon must not create an invisible tray item');
assert.equal(trayConstructionCount, constructionsBeforeMissingIcon, 'an unreadable tray icon must not construct a native tray');
assert.match(trayIconError?.message || '', /Tray icon could not be loaded/);
assert.equal(missingIconTray.isAvailable(), false);

trayEvents = [];
trayListeners = new Map();
let linuxFocusCount = 0;
const linuxTray = createDesktopTray({
  ...dependencies,
  platform: 'linux',
  focusPrimaryWindow() { linuxFocusCount += 1; }
});
linuxTray.setup();
assert.equal(linuxTray.showBalloon({ title: 'Task completed', body: 'Done.' }), false, 'non-Windows trays must not pretend to support Windows notification balloons');
assert.ok(trayEvents.includes('click'), 'Linux tray activation must use Electron\'s supported click event');
assert.equal(trayEvents.includes('double-click'), false, 'Linux must not wait for the Windows/macOS double-click event');
trayListeners.get('click')?.();
assert.equal(linuxFocusCount, 1, 'Linux tray activation must reach the primary-window focus path that acknowledges unread work');
assert.equal(linuxTray.destroy(), true, 'desktop shutdown must be able to release the native tray explicitly');
assert.equal(linuxTray.isAvailable(), false);
assert.equal(linuxTray.destroy(), false, 'tray teardown must be idempotent');

console.log('Desktop tray preserves v0.25.1 activation/menu behavior with current icon safety.');
