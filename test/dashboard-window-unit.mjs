import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDashboardWindowManager, validateConnection, normalizeRouteHash } from "../electron/dashboard-window.js";
import { DASHBOARD_WINDOW_STATE_VERSION, defaultDashboardBounds, restoreDashboardBounds } from "../electron/dashboard-window-bounds.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-dashboard-window-'));
const folderToOpen = path.join(sandbox, 'repo');
fs.mkdirSync(folderToOpen);
const external = [];
const openedPaths = [];
const windows = [];
let permissionHandler = null;
let permissionCheck = null;
let openHandler = null;
let dashboardLoadError = null;
const webContentsEvents = new Map();
const originalWriteFile = fs.promises.writeFile;
let dashboardAuthGeneration = 1;
let dashboardBootstrap = 'one-time-code';
let appQuitCount = 0;
const workArea = { x: 0, y: 0, width: 1366, height: 728 };
const fakeScreen = {
  getPrimaryDisplay: () => ({ workArea }),
  getDisplayMatching: () => ({ workArea })
};

const fakeSession = {
  setPermissionRequestHandler(listener) { permissionHandler = listener; },
  setPermissionCheckHandler(listener) { permissionCheck = listener; }
};

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.maximized = false;
    this.minimized = false;
    this.fullScreen = false;
    this.events = new Map();
    this.loadCount = 0;
    this.executedScripts = [];
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.normalBounds = { ...this.bounds };
    this.webContents = {
      session: fakeSession,
      url: '',
      on(name, listener) { webContentsEvents.set(name, listener); },
      setWindowOpenHandler(listener) { openHandler = listener; },
      sent: [],
      getURL: () => this.webContents.url,
      reload: () => { this.reloaded = true; },
      executeJavaScript: async source => {
        this.executedScripts.push(source);
        const match = /location\.hash = (.+)$/.exec(source);
        if (match && this.webContents.url) {
          const target = new URL(this.webContents.url);
          target.hash = JSON.parse(match[1]);
          this.webContents.url = target.href;
        }
      },
      send: (channel, payload) => this.webContents.sent.push({ channel, payload })
    };
    windows.push(this);
  }
  async loadURL(url) {
    this.loadCount += 1;
    this.webContents.url = url;
    if (this.nextLoadError) {
      const error = this.nextLoadError;
      this.nextLoadError = null;
      throw error;
    }
  }
  once(name, listener) { this.events.set(name, listener); }
  on(name, listener) { this.events.set(name, listener); }
  show() { this.shown = true; this.hidden = false; }
  hide() { this.hidden = true; }
  showInactive() { this.shownInactive = true; }
  moveTop() { this.movedTop = true; }
  focus() { this.focused = true; }
  emit(name, ...args) { this.events.get(name)?.(...args); }
  getBounds() { return this.bounds; }
  getNormalBounds() { return this.normalBounds; }
  isMaximized() { return this.maximized; }
  isMinimized() { return this.minimized; }
  isFullScreen() { return this.fullScreen; }
  minimize() { this.minimized = true; this.emit('minimize'); }
  maximize() { this.maximized = true; this.minimized = false; this.emit('maximize'); }
  unmaximize() { this.maximized = false; this.emit('unmaximize'); }
  setTitleBarOverlay(options) { this.titleBarOverlay = options; }
  close() {
    let prevented = false;
    this.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) this.destroy();
  }
  destroy() { this.destroyed = true; this.events.get('closed')?.(); }
  isDestroyed() { return this.destroyed; }
}

const dependencies = {
  BrowserWindow: FakeWindow,
  iconPath: 'app-icon.png',
  shell: {
    openExternal: url => external.push(url),
    async openPath(target) { openedPaths.push(target); return ''; }
  },
  app: {
    getPath(name) { assert.equal(name, 'userData'); return sandbox; },
    focus() {},
    quit() { appQuitCount += 1; }
  },
  dialog: { async showOpenDialog() { return { canceled: false, filePaths: [folderToOpen] }; } },
  screen: fakeScreen,
  platform: 'win32',
  isQuitting: () => false,
  onLoadError: error => { dashboardLoadError = error; },
  getConnection: async () => ({
    url: `http://127.0.0.1:3333/dashboard?surface=desktop&bootstrap=${dashboardBootstrap}`,
    authGeneration: dashboardAuthGeneration
  })
};

try {
  let releaseDashboardLoad;
  let markDashboardLoadStarted;
  const dashboardLoadStarted = new Promise(resolve => { markDashboardLoadStarted = resolve; });
  const dashboardLoadGate = new Promise(resolve => { releaseDashboardLoad = resolve; });
  class DelayedDashboardWindow extends FakeWindow {
    async loadURL(url) {
      this.loadCount += 1;
      this.webContents.url = url;
      markDashboardLoadStarted();
      await dashboardLoadGate;
    }
  }
  const delayedManager = createDashboardWindowManager({ ...dependencies, BrowserWindow: DelayedDashboardWindow });
  const delayedOpen = delayedManager.open();
  await dashboardLoadStarted;
  const delayedWindow = delayedManager.getWindow();
  assert.ok(delayedWindow, 'dashboard window must exist while its authenticated navigation is loading');
  delayedWindow.emit('ready-to-show');
  assert.notEqual(delayedWindow.shown, true, 'ready-to-show must not expose the dark bootstrap canvas before dashboard navigation completes');
  releaseDashboardLoad();
  await delayedOpen;
  assert.equal(delayedWindow.shown, true, 'dashboard must become visible after its authenticated navigation finishes');
  await delayedManager.close();
  windows.length = 0;

  const manager = createDashboardWindowManager(dependencies);
  const [win, concurrentWin] = await Promise.all([manager.open(), manager.open()]);
  assert.equal(concurrentWin, win, 'concurrent dashboard opens must share one BrowserWindow');
  assert.equal(windows.length, 1, 'concurrent dashboard opens must not create duplicate BrowserWindows');
  assert.deepEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    defaultDashboardBounds(fakeScreen)
  );
  assert.ok(win.options.width < workArea.width * 0.9, 'default dashboard width must be visibly windowed');
  assert.ok(win.options.height < workArea.height * 0.9, 'default dashboard height must be visibly windowed');
  assert.equal(win.options.minWidth, Math.min(900, win.options.width));
  assert.equal(win.options.minHeight, Math.min(600, win.options.height));
  assert.equal(win.options.frame, false);
  assert.equal(win.options.thickFrame, true);
  assert.equal(win.options.titleBarStyle, 'hidden');
  assert.deepEqual(win.options.titleBarOverlay, { color: '#111613', symbolColor: '#f2f6f2', height: 40 }, 'Windows dashboard must use a dark native Window Controls Overlay so Snap Layouts do not create a bright system-colored caption strip.');
  manager.setThemePreference('light');
  assert.deepEqual(win.titleBarOverlay, { color: '#ffffff', symbolColor: '#172033', height: 40 }, 'native caption controls must follow the dashboard light theme');
  manager.setThemePreference('dark');
  assert.deepEqual(win.titleBarOverlay, { color: '#111613', symbolColor: '#f2f6f2', height: 40 }, 'native caption controls must return to the dashboard dark theme');
  assert.equal(win.options.icon, 'app-icon.png', 'desktop windows must carry the application icon on Linux and Windows');
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.ok(win.options.webPreferences.preload.endsWith('preload.cjs'));
  assert.deepEqual(win.options.webPreferences.additionalArguments, ['--relai-preload-surface=dashboard']);
  assert.match(win.options.backgroundColor, /^#[0-9a-f]{6}$/i, 'dashboard window must provide an opaque fallback background while the UI loads');
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.notEqual(win.options.webPreferences.backgroundThrottling, false, 'hidden dashboards should use Electron background throttling');
  assert.equal(win.options.webPreferences.partition, 'persist:relai-dashboard', 'dashboard storage must survive app restarts so theme preferences persist');
  assert.equal(win.webContents.url, 'http://127.0.0.1:3333/dashboard?surface=desktop&bootstrap=one-time-code');
  assert.equal(win.webContents.url.includes('secret-token'), false);
  assert.equal(typeof permissionHandler, 'function');
  assert.equal(permissionCheck(), false);
  let permissionAllowed = true;
  permissionHandler(null, 'camera', value => { permissionAllowed = value; });
  assert.equal(permissionAllowed, false);

  const navigation = webContentsEvents.get('will-navigate');
  let prevented = false;
  navigation({ preventDefault() { prevented = true; } }, 'https://example.com/docs');
  assert.equal(prevented, true);
  assert.deepEqual(external, ['https://example.com/docs']);
  assert.deepEqual(openHandler({ url: 'https://example.com/help' }), { action: 'deny' });
  assert.deepEqual(openHandler({ url: 'https://github.com/Kyne0328' }), { action: 'deny' });
  assert.deepEqual(external, ['https://example.com/docs', 'https://example.com/help', 'https://github.com/Kyne0328']);
  webContentsEvents.get('did-fail-load')({}, -105, 'Connection refused', 'http://127.0.0.1:3333/dashboard', true);
  assert.match(dashboardLoadError?.message || '', /Dashboard failed to load/);

  assert.equal(await manager.pickFolder(), folderToOpen);
  assert.equal(await manager.openFolder(folderToOpen), path.resolve(folderToOpen));
  assert.deepEqual(openedPaths, [path.resolve(folderToOpen)]);
  const initialLoadCount = win.loadCount;
  win.webContents.url = 'http://127.0.0.1:3333/dashboard?surface=desktop#activity';
  const reopenedVisibleRoute = await manager.open();
  assert.equal(reopenedVisibleRoute, win);
  assert.equal(win.loadCount, initialLoadCount, 'reopening an existing dashboard must not reload its active route');
  assert.equal(win.webContents.url.endsWith('#activity'), true, 'reopening without a route must preserve the current route');
  const reused = await manager.open('#settings/connection');
  assert.equal(reused, win);
  assert.equal(windows.length, 1);
  assert.equal(win.loadCount, initialLoadCount, 'same-document route changes must not reload the dashboard');
  assert.equal(win.webContents.url.endsWith('#settings/connection'), true);
  assert.match(win.executedScripts.at(-1) || '', /location\.hash/);

  dashboardAuthGeneration += 1;
  dashboardBootstrap = 'post-restart-code';
  const beforeAuthRefresh = win.loadCount;
  const refreshedAfterRestart = await manager.open();
  assert.equal(refreshedAfterRestart, win);
  assert.equal(win.loadCount, beforeAuthRefresh + 1, 'a new local-service auth generation must reload the one-time dashboard bootstrap');
  assert.equal(new URL(win.webContents.url).searchParams.get('bootstrap'), 'post-restart-code');
  assert.equal(win.webContents.url.endsWith('#settings/connection'), true, 'authenticated reload must preserve the active dashboard route');
  const afterAuthRefresh = win.loadCount;
  await manager.open();
  assert.equal(win.loadCount, afterAuthRefresh, 'reopening within the same auth generation must not reload the dashboard');

  dashboardBootstrap = 'session-refresh-code';
  const beforeSessionRefresh = win.loadCount;
  await manager.open('', { forceReload: true });
  assert.equal(win.loadCount, beforeSessionRefresh + 1, 'session reauthentication must consume a fresh bootstrap even within the same service generation');
  assert.equal(new URL(win.webContents.url).searchParams.get('bootstrap'), 'session-refresh-code');
  assert.equal(win.webContents.url.endsWith('#settings/connection'), true, 'session reauthentication must preserve the active dashboard route');

  assert.deepEqual(manager.getState(), {
    platform: 'win32', customTitleBar: true, controls: 'native',
    maximized: false, minimized: false, fullScreen: false
  });
  assert.equal(manager.minimize().minimized, true);
  assert.equal(manager.toggleMaximize().maximized, true);
  assert.equal(manager.toggleMaximize().maximized, false);
  win.maximized = true;
  win.emit('maximize');
  assert.equal(win.webContents.sent.at(-1).channel, 'desktop:window-state');
  assert.equal(win.webContents.sent.at(-1).payload.maximized, true, 'native state changes must synchronize to the renderer');
  win.maximized = false;
  win.emit('unmaximize');
  assert.equal(win.webContents.sent.at(-1).payload.maximized, false);
  assert.deepEqual(manager.requestClose(), { ok: true });
  assert.equal(win.hidden, true, 'Windows close must hide the dashboard to the tray');
  assert.equal(appQuitCount, 0, 'Windows close-to-tray must not quit the app');

  win.bounds = { x: 0, y: 0, width: workArea.width, height: workArea.height };
  win.normalBounds = { x: 90, y: 54, width: 1080, height: 640 };
  await manager.close();
  assert.equal(manager.getWindow(), null);
  const saved = JSON.parse(fs.readFileSync(path.join(sandbox, 'dashboard-window-state.json'), 'utf8'));
  assert.deepEqual(saved, {
    version: DASHBOARD_WINDOW_STATE_VERSION,
    x: 90,
    y: 54,
    width: 1080,
    height: 640
  });

  const reopened = await manager.open();
  assert.equal(windows.length, 2);
  assert.equal(reopened.options.x, 90);
  assert.equal(reopened.options.y, 54);
  assert.equal(reopened.options.width, 1080);
  assert.equal(reopened.options.height, 640);

  let releaseFirstBoundsWrite;
  let firstBoundsWriteStarted;
  const firstBoundsWrite = new Promise(resolve => { firstBoundsWriteStarted = resolve; });
  const releaseFirstBounds = new Promise(resolve => { releaseFirstBoundsWrite = resolve; });
  let stateWriteCount = 0;
  fs.promises.writeFile = async (target, ...args) => {
    if (target === path.join(sandbox, 'dashboard-window-state.json') && stateWriteCount++ === 0) {
      firstBoundsWriteStarted();
      await releaseFirstBounds;
    }
    return originalWriteFile.call(fs.promises, target, ...args);
  };
  reopened.normalBounds = { x: 100, y: 60, width: 1040, height: 620 };
  reopened.emit('move');
  const debounceKeepAlive = setTimeout(() => {}, 1000);
  await firstBoundsWrite;
  clearTimeout(debounceKeepAlive);
  reopened.normalBounds = { x: 120, y: 70, width: 1020, height: 610 };
  const closePromise = manager.close();
  await new Promise(resolve => setImmediate(resolve));
  releaseFirstBoundsWrite();
  await closePromise;
  fs.promises.writeFile = originalWriteFile;
  const raceSafeSaved = JSON.parse(fs.readFileSync(path.join(sandbox, 'dashboard-window-state.json'), 'utf8'));
  assert.deepEqual(raceSafeSaved, {
    version: DASHBOARD_WINDOW_STATE_VERSION,
    x: 120,
    y: 70,
    width: 1020,
    height: 610
  }, 'a stale debounced bounds write must not overwrite the final close-time window state');

  let rendererGone = null;
  let rendererRecoveryError = null;
  const crashRecoveryManager = createDashboardWindowManager({
    ...dependencies,
    onRendererGone: (error, details) => { rendererGone = { error, details }; },
    onLoadError: error => { rendererRecoveryError = error; }
  });
  const crashedWindow = await crashRecoveryManager.open('#tasks');
  const renderProcessGone = webContentsEvents.get('render-process-gone');
  assert.equal(typeof renderProcessGone, 'function', 'dashboard must observe renderer exits');
  renderProcessGone({}, { reason: 'crashed', exitCode: 11 });
  assert.equal(crashedWindow.destroyed, true, 'a crashed dashboard renderer must be discarded before recovery');
  assert.match(rendererGone?.error?.message || '', /Dashboard renderer exited \(crashed, code 11\)/);
  assert.deepEqual(rendererGone?.details, { reason: 'crashed', exitCode: 11 });
  await new Promise(resolve => setTimeout(resolve, 160));
  const recoveredWindow = crashRecoveryManager.getWindow();
  assert.ok(recoveredWindow && recoveredWindow !== crashedWindow, 'dashboard renderer crash must recreate the dashboard window');
  assert.equal(recoveredWindow.webContents.url.endsWith('#tasks'), true, 'renderer recovery must preserve the active dashboard route');
  assert.equal(rendererRecoveryError, null, 'one renderer crash must recover without escalating to the recovery window');
  await crashRecoveryManager.close();

  let updateCloseAllowed = false;
  const updateLockedManager = createDashboardWindowManager({
    ...dependencies,
    canUserClose: () => updateCloseAllowed
  });
  const updateLockedWindow = await updateLockedManager.open();
  updateLockedWindow.focused = false;
  assert.deepEqual(updateLockedManager.requestClose(), { ok: true });
  assert.equal(updateLockedWindow.hidden, false, 'update preparation must keep the dashboard visible when the user tries to close it');
  assert.equal(updateLockedWindow.focused, true, 'a blocked update-time close must return focus to the update UI');
  assert.equal(updateLockedWindow.destroyed, false, 'user close must not terminate the dashboard during update preparation');
  updateCloseAllowed = true;
  assert.deepEqual(updateLockedManager.requestClose(), { ok: true });
  assert.equal(updateLockedWindow.hidden, true, 'the updater-controlled final handoff may close the normal dashboard path');
  await updateLockedManager.close();

  const linuxManager = createDashboardWindowManager({ ...dependencies, platform: 'linux', canHideOnClose: () => true });
  const linuxWindow = await linuxManager.open();
  assert.deepEqual(linuxManager.requestClose(), { ok: true });
  assert.equal(appQuitCount, 0, 'Linux close must keep the app alive when its tray is available');
  assert.equal(linuxWindow.hidden, true, 'Linux close must hide the dashboard to the tray when the tray is available');
  await linuxManager.close();

  const linuxNoTrayManager = createDashboardWindowManager({ ...dependencies, platform: 'linux', canHideOnClose: () => false });
  const linuxNoTrayWindow = await linuxNoTrayManager.open();
  assert.deepEqual(linuxNoTrayManager.requestClose(), { ok: true });
  assert.equal(appQuitCount, 1, 'Linux close must still quit safely when no tray is available');
  assert.notEqual(linuxNoTrayWindow.hidden, true, 'Linux must not hide the only reachable window when tray creation failed');
  await linuxNoTrayManager.close();

  const quitOnCloseManager = createDashboardWindowManager({ ...dependencies, platform: 'win32', canHideOnClose: () => false });
  const quitOnCloseWindow = await quitOnCloseManager.open();
  assert.deepEqual(quitOnCloseManager.requestClose(), { ok: true });
  assert.equal(appQuitCount, 2, 'the user close preference must be able to quit Rel.AI on Windows');
  assert.notEqual(quitOnCloseWindow.hidden, true, 'quit-on-close must not hide the dashboard first');
  await quitOnCloseManager.close();

  assert.deepEqual(
    restoreDashboardBounds({ x: 0, y: 0, width: 1240, height: 820 }, fakeScreen),
    defaultDashboardBounds(fakeScreen),
    'legacy unversioned near-fullscreen bounds must migrate to the smaller default'
  );

  const shortWorkArea = { x: 0, y: 0, width: 1280, height: 560 };
  const shortScreen = {
    getPrimaryDisplay: () => ({ workArea: shortWorkArea }),
    getDisplayMatching: () => ({ workArea: shortWorkArea })
  };
  const shortSandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-dashboard-window-short-'));
  const shortManager = createDashboardWindowManager({
    ...dependencies,
    app: { ...dependencies.app, getPath(name) { assert.equal(name, 'userData'); return shortSandbox; } },
    screen: shortScreen
  });
  const shortWindow = await shortManager.open();
  assert.ok(shortWindow.options.height <= shortWorkArea.height - 32, 'short displays must keep the dashboard inside the usable work area');
  assert.ok(shortWindow.options.y >= shortWorkArea.y + 16, 'short displays must keep the dashboard below the top work-area inset');
  assert.ok(shortWindow.options.y + shortWindow.options.height <= shortWorkArea.y + shortWorkArea.height - 16, 'short displays must keep the dashboard above the taskbar work-area edge');
  assert.equal(shortWindow.options.minHeight, shortWindow.options.height, 'Electron minHeight must not exceed the constrained window height');
  await shortManager.close();
  fs.rmSync(shortSandbox, { recursive: true, force: true });

  assert.equal(validateConnection({ url: 'http://localhost:3333/dashboard' }).pathname, '/dashboard');
  assert.equal(normalizeRouteHash('settings/connection'), '#settings/connection');
  assert.equal(normalizeRouteHash('#tasks?workspace=repo&task=task-1'), '#tasks?workspace=repo&task=task-1');
  assert.throws(() => normalizeRouteHash('settings/connection?token=secret'), /Invalid dashboard route/);
  assert.throws(() => validateConnection({ url: 'https://example.com/dashboard' }), /local loopback/);
  assert.throws(() => validateConnection({ url: 'http://127.0.0.1:3333/health' }), /local loopback/);
} finally {
  fs.promises.writeFile = originalWriteFile;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('Dashboard window security and persistence tests passed.');
