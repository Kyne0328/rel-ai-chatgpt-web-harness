import { localWindowWebPreferences, secureLocalWindow } from './window-security.js';
import { STARTUP_BACKGROUND_COLOR } from './startup-background.js';

function createStartupSplashManager({
  BrowserWindow, iconPath = '', preloadPath, rendererUrl,
  installProtocol = () => {}, isQuitting = () => false, onError = () => {}
} = {}) {
  let window = null;
  let loaded = false;
  let status = 'Starting Rel.AI…';

  function show() {
    if (isQuitting()) return null;
    if (window && !window.isDestroyed()) return window;
    const created = new BrowserWindow({
      width: 420, height: 310, center: true, frame: false,
      resizable: false, maximizable: false, fullscreenable: false,
      show: false, autoHideMenuBar: true, backgroundColor: STARTUP_BACKGROUND_COLOR,
      title: 'Starting Rel.AI MCP', icon: iconPath || undefined,
      webPreferences: localWindowWebPreferences(preloadPath, 'relai-startup-splash', 'splash')
    });
    window = created;
    loaded = false;
    installProtocol(created.webContents.session.protocol);
    secureLocalWindow(created, { allowedUrl: rendererUrl, onError });
    created.once('ready-to-show', () => {
      if (window === created && !created.isDestroyed() && !isQuitting()) created.show();
    });
    created.webContents.on('did-finish-load', () => {
      if (window !== created || created.isDestroyed()) return;
      loaded = true;
      created.webContents.send('startup:status', status);
    });
    created.on('closed', () => {
      if (window === created) { window = null; loaded = false; }
    });
    void Promise.resolve(created.loadURL(rendererUrl)).catch(error => {
      if (window !== created || created.isDestroyed()) return;
      onError(new Error('Startup splash could not load: ' + (error instanceof Error ? error.message : String(error))));
      hide();
    });
    return created;
  }

  function update(nextStatus) {
    status = String(nextStatus);
    if (loaded && window && !window.isDestroyed()) window.webContents.send('startup:status', status);
  }

  function hide() {
    const existing = window;
    window = null;
    loaded = false;
    if (existing && !existing.isDestroyed()) existing.destroy();
  }

  return { show, update, hide, getWindow: () => window && !window.isDestroyed() ? window : null };
}

export { createStartupSplashManager };
