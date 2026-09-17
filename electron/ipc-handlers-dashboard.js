function registerBrowserSurfaceIpc({ ipc, channels, getBrowserState, setBrowserSurfaceBounds, setBrowserControl, selectBrowserSession, selectBrowserTab, closeBrowserTab, stopActiveBrowserSession }) {
  ipc.handle(channels.DESKTOP_BROWSER_GET_STATE, 'Embedded browser state', () => getBrowserState());
  ipc.handle(channels.DESKTOP_BROWSER_SET_BOUNDS, 'Embedded browser surface', (_event, bounds) => setBrowserSurfaceBounds(normalizeBrowserBounds(bounds)));
  ipc.handle(channels.DESKTOP_BROWSER_SET_CONTROL, 'Embedded browser control', (_event, owner) => setBrowserControl(normalizeBrowserControl(owner)));
  ipc.handle(channels.DESKTOP_BROWSER_SELECT_SESSION, 'Embedded browser session selection', (_event, nativeSessionId) => selectBrowserSession(normalizeBrowserSessionId(nativeSessionId)));
  ipc.handle(channels.DESKTOP_BROWSER_SELECT_TAB, 'Embedded browser tab selection', (_event, nativePageId) => selectBrowserTab(normalizeBrowserPageId(nativePageId)));
  ipc.handle(channels.DESKTOP_BROWSER_CLOSE_TAB, 'Embedded browser tab close', (_event, nativePageId) => closeBrowserTab(normalizeBrowserPageId(nativePageId)));
  ipc.handle(channels.DESKTOP_BROWSER_STOP, 'Embedded browser stop', () => stopActiveBrowserSession());
}

function registerAnalyticsIpc({ ipc, channels, getLocalUsage }) {
  ipc.handle(channels.DESKTOP_ANALYTICS_LOCAL, 'Local analytics', (_event, month) => getLocalUsage(normalizeAnalyticsMonth(month)));
}

function registerDesktopSettingsIpc({
  ipc,
  channels,
  getDesktopSettings,
  saveDesktopSettings,
  getLifecycleStatus,
  acknowledgeConnectorRefresh,
  setLaunchAtLogin,
  setKeepAwake,
  setAppPreferences,
  getNotificationsEnabled,
  setNotificationsEnabled,
  getNotificationPreferences,
  updateNotificationPreferences
}) {
  ipc.handle(channels.DESKTOP_SETTINGS_GET, 'Desktop settings', () => getDesktopSettings());
  ipc.handle(channels.DESKTOP_SETTINGS_SAVE, 'Desktop settings', (_event, settings) => saveDesktopSettings(settings));
  ipc.handle(channels.DESKTOP_LIFECYCLE_GET, 'Desktop lifecycle', () => getLifecycleStatus());
  ipc.handle(channels.DESKTOP_LIFECYCLE_ACK_CONNECTOR_REFRESH, 'Connector refresh acknowledgement', () => acknowledgeConnectorRefresh());
  ipc.handle(channels.DESKTOP_STARTUP_SET, 'Launch at login', (_event, enabled) => setLaunchAtLogin(enabled));
  ipc.handle(channels.DESKTOP_KEEP_AWAKE_SET, 'Keep awake', (_event, enabled) => setKeepAwake(enabled));
  ipc.handle(channels.DESKTOP_APP_PREFERENCES_SET, 'App preferences', (_event, patch) => setAppPreferences(patch));
  ipc.handle(channels.DESKTOP_NOTIFICATIONS_GET, 'Desktop notifications', () => ({ ok: true, enabled: getNotificationsEnabled() }));
  ipc.handle(channels.DESKTOP_NOTIFICATIONS_SET, 'Desktop notifications', (_event, enabled) => ({ ok: true, enabled: setNotificationsEnabled(enabled) }));
  ipc.handle(channels.DESKTOP_NOTIFICATION_PREFERENCES_GET, 'Notification preferences', () => ({ ok: true, preferences: getNotificationPreferences() }));
  ipc.handle(channels.DESKTOP_NOTIFICATION_PREFERENCES_SET, 'Notification preferences', (_event, patch) => updateNotificationPreferences(patch));
}

function registerUpdaterIpc({ ipc, channels, getUpdateStatus, checkForUpdates, downloadUpdate, installUpdate }) {
  ipc.handle(channels.DESKTOP_UPDATE_GET, 'Update status', () => getUpdateStatus());
  ipc.handle(channels.DESKTOP_UPDATE_CHECK, 'Update check', () => checkForUpdates());
  ipc.handle(channels.DESKTOP_UPDATE_DOWNLOAD, 'Update download', () => downloadUpdate());
  ipc.handle(channels.DESKTOP_UPDATE_INSTALL, 'Update install', () => installUpdate());
}

function registerDiagnosticsIpc({ ipc, channels, exportDiagnosticState, openDiagnosticsFolder, runTunnelDoctor }) {
  ipc.handle(channels.DESKTOP_DIAGNOSTICS_EXPORT, 'Diagnostic export', (_event, report) => exportDiagnosticState(report));
  ipc.handle(channels.DESKTOP_DIAGNOSTICS_OPEN_FOLDER, 'Diagnostics folder', () => openDiagnosticsFolder());
  ipc.handle(channels.DESKTOP_DIAGNOSTICS_TUNNEL_DOCTOR, 'Secure MCP Tunnel diagnostics', () => runTunnelDoctor());
}

function registerLocalDataIpc({ ipc, channels, getLocalDataUsage, clearTemporaryLocalData, openLocalDataFolder }) {
  ipc.handle(channels.DESKTOP_LOCAL_DATA_GET, 'Local data', () => getLocalDataUsage());
  ipc.handle(channels.DESKTOP_LOCAL_DATA_CLEAR_TEMPORARY, 'Local data cleanup', () => clearTemporaryLocalData());
  ipc.handle(channels.DESKTOP_LOCAL_DATA_OPEN_FOLDER, 'Local data folder', () => openLocalDataFolder());
}

function normalizeBrowserBounds(bounds) {
  if (!bounds || typeof bounds !== 'object' || Array.isArray(bounds) || typeof bounds.visible !== 'boolean') throw new Error('Embedded browser bounds must specify visible as a boolean.');
  if (!bounds.visible) return { visible: false };
  const values = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(bounds[key])]));
  if (!Object.values(values).every(Number.isFinite)) throw new Error('Embedded browser bounds require finite x, y, width, and height values.');
  if (values.width < 1 || values.height < 1 || values.width > 16384 || values.height > 16384 || values.x < 0 || values.y < 0 || values.x > 16384 || values.y > 16384) throw new Error('Embedded browser bounds are outside the supported desktop range.');
  return { visible: true, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value)])) };
}

function normalizeBrowserControl(owner) {
  const value = String(owner || '').trim();
  if (value !== 'ai' && value !== 'user') throw new Error('Embedded browser control owner must be ai or user.');
  return value;
}

function normalizeBrowserSessionId(value) {
  const nativeSessionId = String(value || '').trim();
  if (!/^embedded_browser_[A-Za-z0-9_-]{16,160}$/.test(nativeSessionId)) throw new Error('Embedded browser session identifier is invalid.');
  return nativeSessionId;
}

function normalizeBrowserPageId(value) {
  const nativePageId = String(value || '').trim();
  if (!/^embedded_page_[A-Za-z0-9_-]{16,160}$/.test(nativePageId)) throw new Error('Embedded browser tab identifier is invalid.');
  return nativePageId;
}

function normalizeAnalyticsMonth(month) {
  const value = String(month || '').trim();
  if (value && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('Analytics month must use YYYY-MM.');
  return value;
}

export { registerAnalyticsIpc, registerBrowserSurfaceIpc, registerDesktopSettingsIpc, registerDiagnosticsIpc, registerLocalDataIpc, registerUpdaterIpc };
