import { normalizeWizardConfig, saveLauncherConfig } from './launcher-config.js';
import { readGuiConfig } from './launcher-utils.js';
import { normalizeApiKey } from './tunnel-credentials.js';

const TUNNEL_SETTING_ERROR_CODES = new Set([
  'tunnel_authentication_failed',
  'tunnel_access_denied',
  'tunnel_not_found',
  'tunnel_connection_interrupted',
  'tunnel_runtime_unavailable',
  'secure_tunnel_failed'
]);

function readDesktopSettings(runtimeState = {}) {
  let config;
  try {
    config = readGuiConfig();
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] read gui config:', error);
    config = { port: 3333, token: '', tunnelId: '' };
  }
  const tunnelErrorCode = TUNNEL_SETTING_ERROR_CODES.has(String(runtimeState.tunnelErrorCode || ''))
    ? String(runtimeState.tunnelErrorCode)
    : '';
  return {
    ok: true,
    port: Number(config.port || 3333),
    tunnelId: String(config.tunnelId || ''),
    tunnelApiKey: '',
    tunnelApiKeyConfigured: runtimeState.tunnelApiKeyConfigured === true,
    notificationsEnabled: runtimeState.notificationsEnabled !== false,
    tunnelErrorCode,
    tunnelError: tunnelErrorCode ? boundedMessage(runtimeState.tunnelError) : ''
  };
}

async function saveDesktopSettings(settings = {}, runtimeActions = {}) {
  const {
    setNotificationsEnabled = () => true,
    getNotificationsEnabled = () => true,
    setTunnelApiKey,
    getTunnelApiKey = () => '',
    clearTunnelApiKey = () => {},
    canRestart = () => '',
    getCurrentStatus = () => ({}),
    restartConnection,
    restartDesktop
  } = runtimeActions;
  if (typeof restartDesktop !== 'function') throw new TypeError('restartDesktop is required.');
  if (typeof setTunnelApiKey !== 'function') throw new TypeError('setTunnelApiKey is required.');

  let current;
  try {
    current = readGuiConfig();
  } catch {
    current = { port: 3333, token: '', tunnelId: '' };
  }
  const next = normalizeWizardConfig({
    port: settings.port ?? current.port,
    tunnelId: settings.tunnelId ?? current.tunnelId,
    token: current.token
  }, { allowLocalOnly: current.tunnelId === '' });
  const replacementApiKey = String(settings.tunnelApiKey || '').trim();
  if (replacementApiKey) normalizeApiKey(replacementApiKey);

  const portChanged = Number(next.port) !== Number(current.port);
  const tunnelIdChanged = String(next.tunnelId || '') !== String(current.tunnelId || '');
  const connectionChanged = portChanged || tunnelIdChanged || Boolean(replacementApiKey);
  const notificationChange = typeof settings.notificationsEnabled === 'boolean';
  const previousStatus = getCurrentStatus() || {};
  if (portChanged || (connectionChanged && previousStatus.serverRunning !== true)) {
    const restartBlock = String(canRestart('saving connection settings') || '');
    if (restartBlock) throw new Error(restartBlock);
  }

  const previousApiKey = replacementApiKey ? String(getTunnelApiKey() || '') : '';
  const previousNotifications = getNotificationsEnabled() !== false;
  const canReconnectWithoutLocalRestart = connectionChanged
    && !portChanged
    && previousStatus.serverRunning === true
    && typeof restartConnection === 'function';

  try {
    saveLauncherConfig(next);
    if (replacementApiKey) setTunnelApiKey(replacementApiKey);
    if (notificationChange) setNotificationsEnabled(settings.notificationsEnabled);

    if (!connectionChanged) return { ok: true, status: previousStatus };

    const status = canReconnectWithoutLocalRestart
      ? await restartConnection()
      : await restartDesktop();
    if (!status?.serverRunning) {
      throw new Error(status?.error || 'Desktop settings were saved, but the local service did not restart.');
    }
    if (status.tunnelStatus === 'failed') {
      return {
        ok: false,
        saved: true,
        status,
        errorCode: String(status.errorCode || 'secure_tunnel_failed'),
        error: boundedMessage(status.error || 'Connection settings were saved, but the Secure MCP Tunnel could not connect.')
      };
    }
    return { ok: true, status };
  } catch (error) {
    const rollbackErrors = [];
    try {
      if (current?.tunnelId && current?.port) saveLauncherConfig(current);
    } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (replacementApiKey) {
      try {
        if (previousApiKey) setTunnelApiKey(previousApiKey);
        else clearTunnelApiKey();
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (notificationChange) {
      try { setNotificationsEnabled(previousNotifications); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (connectionChanged) {
      try {
        if (canReconnectWithoutLocalRestart) await restartConnection();
        else await restartDesktop();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    const message = error instanceof Error ? error.message : String(error || 'Desktop settings could not be saved.');
    if (!rollbackErrors.length) throw new Error(`${message} Previous connection settings were restored.`, { cause: error });
    throw new Error(`${message} Rel.AI also could not fully restore the previous connection settings.`, { cause: error });
  }
}

function boundedMessage(value) {
  return String(value || '').replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
}

export { readDesktopSettings, saveDesktopSettings };
