import { fitWindowToContent, WINDOW_SIZE_LIMITS } from './window-size.js';
import { installLocalProtocol, localRendererUrl } from './local-protocol.js';
import { localWindowWebPreferences, secureLocalWindow } from './window-security.js';
import { STARTUP_BACKGROUND_COLOR } from './startup-background.js';

function createSetupWindowManager(deps) {
  const { BrowserWindow, iconPath = '', preloadPath, rendererRoot, runtimeLogs, isQuitting, startupSplash } = deps;
  let window = null;
  let recoveryMode = false;
  let updateMode = false;
  let updateVersions = { previousVersion: '', currentVersion: '' };
  let returnToFallback = false;

  function create(options = {}) {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
      return window;
    }
    recoveryMode = options.recovery === true;
    updateMode = recoveryMode ? false : options.update === true;
    updateVersions = {
      previousVersion: sanitizeVersion(options.previousVersion),
      currentVersion: sanitizeVersion(options.currentVersion)
    };
    returnToFallback = recoveryMode;
    const query = recoveryMode
      ? { recovery: '1' }
      : updateMode
        ? { update: '1', previousVersion: updateVersions.previousVersion, currentVersion: updateVersions.currentVersion }
        : {};
    const rendererUrl = localRendererUrl('wizard.html', query);
    window = new BrowserWindow({
      width: WINDOW_SIZE_LIMITS.wizard.minWidth,
      height: 620,
      minWidth: WINDOW_SIZE_LIMITS.wizard.minWidth,
      minHeight: WINDOW_SIZE_LIMITS.wizard.minHeight,
      resizable: true,
      maximizable: true,
      useContentSize: true,
      webPreferences: localWindowWebPreferences(preloadPath, 'relai-setup', 'application'),
      backgroundColor: STARTUP_BACKGROUND_COLOR,
      title: recoveryMode ? 'Rel.AI MCP - Connection Recovery' : updateMode ? 'Rel.AI MCP - Update' : 'Rel.AI MCP - Setup',
      icon: iconPath || undefined,
      autoHideMenuBar: true
    });
    installLocalProtocol(window.webContents.session.protocol, rendererRoot);
    secureLocalWindow(window, {
      allowedUrl: rendererUrl,
      onError: error => runtimeLogs.append(error.message, { level: 'warning', source: 'electron-security' })
    });
    void window.loadURL(rendererUrl).catch(error => {
      runtimeLogs.append(`Setup renderer failed to load: ${formatError(error)}`, { level: 'error', source: 'electron-renderer' });
    });
    window.webContents.on('did-finish-load', () => fitWindowToContent(window, { type: 'wizard' }));
    window.on('closed', () => reset());
    return window;
  }

  function close(options = {}) {
    returnToFallback = options.returnToFallback === true && recoveryMode;
    if (window && !window.isDestroyed()) window.destroy();
    else reset();
  }

  function reset() {
    const shouldReturn = returnToFallback;
    window = null;
    recoveryMode = false;
    updateMode = false;
    updateVersions = { previousVersion: '', currentVersion: '' };
    returnToFallback = false;
    if (shouldReturn && !isQuitting()) {
      startupSplash.show();
      startupSplash.update('Connection setup was closed.', { blocked: true });
    }
  }

  function getWindow() {
    return window && !window.isDestroyed() ? window : null;
  }

  function isUpdateMode() {
    return updateMode === true && getWindow() !== null;
  }

  return { create, close, getWindow, isUpdateMode };
}

function sanitizeVersion(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export { createSetupWindowManager };
