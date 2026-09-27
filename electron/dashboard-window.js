

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, URL } from 'node:url';
import { normalizeRouteHash, planDashboardNavigation, safeOrigin, safeUrl, validateConnection } from './dashboard-window-navigation.js';
import { DASHBOARD_WINDOW_LIMITS, dashboardWindowState, restoreDashboardBounds } from './dashboard-window-bounds.js';
import { localWindowWebPreferences } from './window-security.js';
import { STARTUP_BACKGROUND_COLOR } from './startup-background.js';

const dashboardPreloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));
import { dashboardTitleBarOverlay, dashboardWindowChrome, dashboardWindowChromeState } from "./window-chrome.js";

function createDashboardWindowManager(deps) {
  const {
    BrowserWindow, shell, app, dialog, screen, getConnection,
    nativeTheme,
    platform = process.platform,
    iconPath = '',
    canHideOnClose = () => true,
    canUserClose = () => true,
    isQuitting = () => false,
    onError = () => {},
    onLoadError = onError,
    onRendererGone = () => {}
  } = deps;
  const userDataPath = typeof app.getPath === 'function' ? app.getPath('userData') : process.cwd();
  const statePath = path.join(userDataPath, 'dashboard-window-state.json');
  let dashboardWindow = null;
  let windowCreationPromise = null;
  let dashboardOrigin = '';
  let dashboardAuthGeneration = '';
  let persistTimer = null;
  let persistPromise = null;
  let persistRevision = 0;
  let themePreference = 'system';
  let rendererRecoveryTimer = null;
  let lastRendererCrashAt = 0;

  nativeTheme?.on?.('updated', () => {
    if (themePreference === 'system') applyTitleBarOverlay();
  });

  async function open(routeHash = '', options = {}) {
    if (isQuitting()) throw new Error('Dashboard window is unavailable while Rel.AI is quitting.');
    const connection = await getConnection();
    const target = validateConnection(connection);
    const authGeneration = String(connection?.authGeneration ?? '');
    const requestedHash = routeHash ? normalizeRouteHash(routeHash) : '';
    if (requestedHash) target.hash = requestedHash;
    dashboardOrigin = target.origin;
    const win = await getOrCreateWindow();
    const current = safeUrl(win.webContents.getURL());
    const forceReload = options.forceReload === true;
    if (forceReload && !requestedHash && current?.hash) target.hash = current.hash;
    const { sameDashboard, authRefreshRequired } = planDashboardNavigation(current, target, { requestedHash, currentAuthGeneration: dashboardAuthGeneration, nextAuthGeneration: authGeneration });
    if (!sameDashboard || authRefreshRequired || forceReload) {
      try {
        await win.loadURL(target.href);
        if (authGeneration) dashboardAuthGeneration = authGeneration;
      } catch (error) {
        if (!isAbortedNavigationError(error)) throw error;
      }
    } else if (requestedHash && current.hash !== requestedHash) {
      await navigateDashboardHash(win, requestedHash);
    }
    if (!dashboardAuthGeneration && authGeneration) dashboardAuthGeneration = authGeneration;
    win.show();
    win.focus();
    return win;
  }

  async function navigateDashboardHash(win, hash) {
    if (typeof win.webContents.executeJavaScript === 'function') {
      await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
      return;
    }
    const current = safeUrl(win.webContents.getURL());
    if (!current) return;
    current.hash = hash;
    await win.loadURL(current.href);
  }

  async function getOrCreateWindow() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
    if (windowCreationPromise) return windowCreationPromise;
    const pending = createWindow();
    windowCreationPromise = pending;
    try {
      return await pending;
    } finally {
      if (windowCreationPromise === pending) windowCreationPromise = null;
    }
  }

  async function createWindow() {
    const bounds = await readBounds();
    if (isQuitting()) throw new Error('Dashboard window is unavailable while Rel.AI is quitting.');
    if (dashboardWindow && !dashboardWindow.isDestroyed()) return dashboardWindow;
    const chrome = dashboardWindowChrome(platform, resolvedTheme());
    dashboardWindow = new BrowserWindow({
      ...bounds,
      ...chrome.windowOptions,
      minWidth: Math.min(DASHBOARD_WINDOW_LIMITS.minWidth, bounds.width),
      minHeight: Math.min(DASHBOARD_WINDOW_LIMITS.minHeight, bounds.height),
      show: false,
      autoHideMenuBar: true,
      title: 'Rel.AI MCP Dashboard',
      icon: iconPath || undefined,
      backgroundColor: STARTUP_BACKGROUND_COLOR,
      webPreferences: {
        ...localWindowWebPreferences(dashboardPreloadPath, 'persist:relai-dashboard', 'dashboard')
      }
    });
    secureSession(dashboardWindow.webContents.session);
    configureNavigation(dashboardWindow);
    dashboardWindow.on('resize', schedulePersist);
    dashboardWindow.on('move', schedulePersist);
    bindWindowState(dashboardWindow);
    dashboardWindow.on('close', event => {
      void persistBounds();
      if (isQuitting()) return;
      event.preventDefault();
      if (!canUserClose()) {
        dashboardWindow.show();
        dashboardWindow.focus();
        return;
      }
      if (!canHideOnClose()) {
        app.quit();
        return;
      }
      dashboardWindow.hide();
    });
    dashboardWindow.on('closed', () => { dashboardWindow = null; });
    return dashboardWindow;
  }

  function secureSession(session) {
    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
  }

  function configureNavigation(win) {
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('will-navigate', (event, target) => {
      if (safeOrigin(target) === dashboardOrigin) return;
      event.preventDefault();
      openExternal(target);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) onLoadError(new Error(`Dashboard failed to load ${url}: ${description}`));
    });
    win.webContents.on('render-process-gone', (_event, details) => handleRendererGone(win, details));
    win.webContents.on('before-input-event', (event, input) => {
      const reload = input.key === 'F5' || ((input.control || input.meta) && input.key.toLowerCase() === 'r');
      if (!reload) return;
      event.preventDefault();
      win.webContents.reload();
    });
  }

  function handleRendererGone(win, details = {}) {
    if (isQuitting() || win !== dashboardWindow) return;
    const reason = String(details.reason || 'unknown');
    const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : null;
    const current = safeUrl(win.webContents.getURL());
    const routeHash = current?.hash || '';
    onRendererGone(new Error(`Dashboard renderer exited (${reason}${exitCode == null ? '' : `, code ${exitCode}`}).`), {
      reason,
      exitCode
    });
    if (!win.isDestroyed()) win.destroy();
    const now = Date.now();
    if (now - lastRendererCrashAt < 5_000) {
      onLoadError(new Error('Dashboard renderer failed repeatedly. Open Troubleshooting and review the local crash diagnostics.'));
      return;
    }
    lastRendererCrashAt = now;
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null;
      void open(routeHash, { forceReload: true }).catch(onLoadError);
    }, 100);
    rendererRecoveryTimer.unref?.();
  }

  function isAbortedNavigationError(error) {
    const message = String(error?.message || error || '');
    return error?.code === 'ERR_ABORTED'
      || Number(error?.code) === -3
      || Number(error?.errno) === -3
      || /\bERR_ABORTED\b/i.test(message);
  }

  function openExternal(target) {
    try {
      const url = new URL(target);
      if (url.protocol === 'https:') Promise.resolve(shell.openExternal(url.href)).catch(onError);
    } catch { /* Invalid and non-HTTPS targets stay blocked. */ }
  }

  async function pickFolder() {
    const parent = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : createPickerAnchor();
    try {
      if (parent !== dashboardWindow) {
        parent.showInactive();
        parent.moveTop();
        app.focus({ steal: true });
        parent.focus();
      }
      const result = await dialog.showOpenDialog(parent, {
        title: 'Select workspace folder',
        properties: ['openDirectory']
      });
      return result && !result.canceled && result.filePaths?.[0] ? result.filePaths[0] : null;
    } finally {
      if (parent !== dashboardWindow && !parent.isDestroyed()) parent.destroy();
    }
  }

  async function openFolder(folderPath) {
    const target = path.resolve(String(folderPath || ''));
    try { await fs.promises.access(target); }
    catch { throw new Error(`Workspace folder does not exist: ${target}`); }
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return target;
  }

  function createPickerAnchor() {
    return new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true
    });
  }

  function schedulePersist() {
    if (persistTimer) clearTimeout(persistTimer);
    const revision = ++persistRevision;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const pending = persistBoundsAsync(revision);
      persistPromise = pending;
      const clearPending = () => {
        if (persistPromise === pending) persistPromise = null;
      };
      void pending.then(clearPending, clearPending);
    }, 250);
    persistTimer.unref?.();
  }

  async function persistBoundsAsync(revision) {
    const win = getWindow();
    if (!win || typeof win.getBounds !== 'function') return;
    const text = JSON.stringify(dashboardWindowState(win, screen), null, 2);
    try {
      await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
      if (revision !== persistRevision) return;
      await fs.promises.writeFile(statePath, text);
    } catch (error) {
      if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] dashboard bounds:', error);
    }
  }

  async function persistBounds() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
    const revision = ++persistRevision;
    if (persistPromise) await persistPromise;
    await persistBoundsAsync(revision);
  }

  async function readBounds() {
    try { return restoreDashboardBounds(JSON.parse(await fs.promises.readFile(statePath, 'utf8')), screen); }
    catch { return restoreDashboardBounds(null, screen); }
  }

  function getState() {
    return dashboardWindowChromeState(getWindow(), platform);
  }

  function setThemePreference(value) {
    themePreference = ['dark', 'light'].includes(value) ? value : 'system';
    applyTitleBarOverlay();
    return themePreference;
  }

  function resolvedTheme() {
    if (themePreference !== 'system') return themePreference;
    return nativeTheme?.shouldUseDarkColors === false ? 'light' : 'dark';
  }

  function applyTitleBarOverlay() {
    const win = getWindow();
    if (platform !== 'win32' || !win || typeof win.setTitleBarOverlay !== 'function') return;
    win.setTitleBarOverlay(dashboardTitleBarOverlay(resolvedTheme()));
  }

  function requireWindow() {
    const win = getWindow();
    if (!win) throw new Error('Dashboard window is not available.');
    return win;
  }

  function sendWindowState() {
    const win = getWindow();
    if (win && typeof win.webContents?.send === 'function') {
      win.webContents.send('desktop:window-state', getState());
    }
  }

  function bindWindowState(win) {
    for (const name of ['show', 'minimize', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      win.on(name, sendWindowState);
    }
  }

  function minimize() {
    requireWindow().minimize();
    return getState();
  }

  function toggleMaximize() {
    const win = requireWindow();
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return getState();
  }

  function requestClose() {
    requireWindow().close();
    return { ok: true };
  }

  async function close() {
    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = null;
    if (windowCreationPromise) {
      try { await windowCreationPromise; } catch {}
    }
    await persistBounds();
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
    dashboardWindow = null;
  }

  function getWindow() {
    return dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : null;
  }

  return { open, close, getWindow, pickFolder, openFolder, getState, setThemePreference, minimize, toggleMaximize, requestClose };
}

export { createDashboardWindowManager, validateConnection, normalizeRouteHash };
