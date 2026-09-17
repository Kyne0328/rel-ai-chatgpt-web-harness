import { MAX_CLIPBOARD_TEXT_BYTES, createContractIpcRegistrar, logIpcFailure } from './ipc-security.js';
import { importResourceModule } from './resource-path.js';
import { registerAnalyticsIpc, registerBrowserSurfaceIpc, registerDesktopSettingsIpc, registerDiagnosticsIpc, registerLocalDataIpc, registerUpdaterIpc } from './ipc-handlers-dashboard.js';
import { registerCodeWorkspaceIpc } from './ipc-handlers-code.js';

const { DESKTOP_IPC, DESKTOP_IPC_INPUT_CONTRACT } = await importResourceModule('src/contracts/desktop.ts');

const OPENAI_SETUP_URLS = Object.freeze({
  tunnels: 'https://platform.openai.com/settings/organization/tunnels',
  apiKeys: 'https://platform.openai.com/settings/organization/api-keys'
});

function registerIpcHandlers(deps) {
  const ipc = createContractIpcRegistrar({
    ipcMain: deps.ipcMain,
    BrowserWindow: deps.BrowserWindow,
    contract: DESKTOP_IPC_INPUT_CONTRACT,
    windowGetters: {
      wizard: deps.getWizardWindow,
      fallback: deps.getFallbackWindow,
      dashboard: deps.getDashboardWindow,
      pulse: deps.getPulseWindow
    }
  });

  registerSetupIpc({
    ipc,
    channels: DESKTOP_IPC,
    shell: deps.shell,
    closeWizard: deps.closeWizard,
    getRecoveryConfig: deps.getRecoveryConfig,
    setTunnelApiKey: deps.setTunnelApiKey,
    saveLauncherConfig: deps.saveLauncherConfig,
    launchConfiguredDesktop: deps.launchConfiguredDesktop
  });
  registerRecoveryIpc({
    ipc,
    channels: DESKTOP_IPC,
    openRecoverySetup: deps.openRecoverySetup,
    openDashboardWindow: deps.openDashboardWindow,
    getNotificationsEnabled: deps.getNotificationsEnabled,
    setNotificationsEnabled: deps.setNotificationsEnabled
  });
  registerPulseIpc({ ipc, channels: DESKTOP_IPC, setPulseExpanded: deps.setPulseExpanded });
  registerServiceIpc({
    ipc,
    channels: DESKTOP_IPC,
    startServer: deps.startServer,
    stopServer: deps.stopServer,
    restartConnection: deps.restartConnection,
    relaunchApplication: deps.relaunchApplication,
    logoutApplication: deps.logoutApplication,
    quitApplication: deps.quitApplication
  });
  registerDashboardWindowIpc({
    ipc,
    channels: DESKTOP_IPC,
    getCurrentStatus: deps.getCurrentStatus,
    getDashboardWindowState: deps.getDashboardWindowState,
    minimizeDashboardWindow: deps.minimizeDashboardWindow,
    toggleDashboardMaximize: deps.toggleDashboardMaximize,
    requestDashboardClose: deps.requestDashboardClose,
    openSettingsWindow: deps.openSettingsWindow,
    openDashboardWindow: deps.openDashboardWindow
  });
  registerBrowserSurfaceIpc({
    ipc,
    channels: DESKTOP_IPC,
    getBrowserState: deps.getBrowserState,
    setBrowserSurfaceBounds: deps.setBrowserSurfaceBounds,
    setBrowserControl: deps.setBrowserControl,
    selectBrowserSession: deps.selectBrowserSession,
    selectBrowserTab: deps.selectBrowserTab,
    closeBrowserTab: deps.closeBrowserTab,
    stopActiveBrowserSession: deps.stopActiveBrowserSession
  });
  registerAnalyticsIpc({ ipc, channels: DESKTOP_IPC, getLocalUsage: deps.getLocalUsage });
  registerDesktopSettingsIpc({
    ipc,
    channels: DESKTOP_IPC,
    getDesktopSettings: deps.getDesktopSettings,
    saveDesktopSettings: deps.saveDesktopSettings,
    getLifecycleStatus: deps.getLifecycleStatus,
    acknowledgeConnectorRefresh: deps.acknowledgeConnectorRefresh,
    setLaunchAtLogin: deps.setLaunchAtLogin,
    setKeepAwake: deps.setKeepAwake,
    setAppPreferences: deps.setAppPreferences,
    getNotificationsEnabled: deps.getNotificationsEnabled,
    setNotificationsEnabled: deps.setNotificationsEnabled,
    getNotificationPreferences: deps.getNotificationPreferences,
    updateNotificationPreferences: deps.updateNotificationPreferences
  });
  registerUpdaterIpc({
    ipc,
    channels: DESKTOP_IPC,
    getUpdateStatus: deps.getUpdateStatus,
    checkForUpdates: deps.checkForUpdates,
    downloadUpdate: deps.downloadUpdate,
    installUpdate: deps.installUpdate
  });
  registerDiagnosticsIpc({
    ipc,
    channels: DESKTOP_IPC,
    exportDiagnosticState: deps.exportDiagnosticState,
    openDiagnosticsFolder: deps.openDiagnosticsFolder,
    runTunnelDoctor: deps.runTunnelDoctor
  });
  registerLocalDataIpc({
    ipc,
    channels: DESKTOP_IPC,
    getLocalDataUsage: deps.getLocalDataUsage,
    clearTemporaryLocalData: deps.clearTemporaryLocalData,
    openLocalDataFolder: deps.openLocalDataFolder
  });
  registerCodeWorkspaceIpc({
    ipc,
    channels: DESKTOP_IPC,
    getTaskCodeWorkspace: deps.getTaskCodeWorkspace,
    readTaskCodeDiff: deps.readTaskCodeDiff,
    listCodeEditors: deps.listCodeEditors,
    openTaskCodeIde: deps.openTaskCodeIde
  });
  registerSharedUtilityIpc({
    ipc,
    channels: DESKTOP_IPC,
    BrowserWindow: deps.BrowserWindow,
    clipboard: deps.clipboard,
    guards: ipc.guards,
    getWizardWindow: deps.getWizardWindow,
    fitWindowToContent: deps.fitWindowToContent
  });
}

function registerSetupIpc({ ipc, channels, shell, closeWizard, getRecoveryConfig, setTunnelApiKey, saveLauncherConfig, launchConfiguredDesktop }) {
  ipc.handle(channels.WIZARD_DONE, 'Setup completion', async (_event, config = {}) => {
    const apiKey = String(config.tunnelApiKey || '').trim();
    if (apiKey) setTunnelApiKey(apiKey);
    saveLauncherConfig(config);
    closeWizard({ returnToFallback: false });
    const status = await launchConfiguredDesktop({ restart: config?.restart === true, firstRun: config?.restart !== true });
    return { ok: status?.serverRunning === true, status };
  });
  ipc.handle(channels.WIZARD_CANCEL, 'Setup cancellation', () => {
    closeWizard({ returnToFallback: true });
    return { ok: true };
  });
  ipc.handle(channels.WIZARD_OPEN_OPENAI_SETUP, 'OpenAI setup navigation', async (_event, destination) => {
    const url = OPENAI_SETUP_URLS[String(destination || '')];
    if (!url) throw new Error('Unknown OpenAI setup destination.');
    await shell.openExternal(url);
    return { ok: true };
  });
  ipc.handle(channels.RECOVERY_GET_CONFIG, 'Recovery configuration', () => getRecoveryConfig());
}

function registerRecoveryIpc({ ipc, channels, openRecoverySetup, openDashboardWindow, getNotificationsEnabled, setNotificationsEnabled }) {
  ipc.handle(channels.RECOVERY_OPEN_SETUP, 'Connection recovery', () => openRecoverySetup());
  ipc.handle(channels.URL_OPEN_DASHBOARD, 'Dashboard opening', (_event, routeHash = '') => openDashboardWindow(routeHash));
  ipc.handle(channels.NOTIFICATIONS_GET_ENABLED, 'Notification preferences', () => ({ ok: true, enabled: getNotificationsEnabled() }));
  ipc.handle(channels.NOTIFICATIONS_SET_ENABLED, 'Notification preferences', (_event, enabled) => ({ ok: true, enabled: setNotificationsEnabled(enabled) }));
}

function registerPulseIpc({ ipc, channels, setPulseExpanded }) {
  ipc.handle(channels.PULSE_SET_EXPANDED, 'Pulse sizing', (_event, expanded) => {
    if (typeof expanded !== 'boolean') throw new Error('Pulse expansion state must be a boolean.');
    return { ok: true, expanded: setPulseExpanded(expanded) };
  });
}

function registerServiceIpc({ ipc, channels, startServer, stopServer, restartConnection, relaunchApplication, logoutApplication, quitApplication }) {
  ipc.handle(channels.SERVER_START, 'Service startup', () => startServer());
  ipc.handle(channels.SERVER_STOP, 'Service shutdown', () => stopServer());
  ipc.handle(channels.RECOVERY_RESTART_CONNECTION, 'Connection retry', () => restartConnection());
  ipc.handle(channels.DESKTOP_RESTART_CONNECTION, 'Connection retry', () => restartConnection());
  ipc.handle(channels.RECOVERY_RELAUNCH, 'Application restart', () => relaunchApplication());
  ipc.handle(channels.DESKTOP_RELAUNCH, 'Application restart', () => relaunchApplication());
  ipc.handle(channels.DESKTOP_LOGOUT, 'Application logout', (_event, payload) => logoutApplication(normalizeLogoutPayload(payload)));
  ipc.handle(channels.DESKTOP_QUIT, 'Application quit', () => quitApplication());
  ipc.on(channels.DESKTOP_STOP_SERVICE, 'Service shutdown', () => {
    setImmediate(() => Promise.resolve(stopServer()).catch(logIpcFailure));
  });
}

function registerDashboardWindowIpc({ ipc, channels, getCurrentStatus, getDashboardWindowState, minimizeDashboardWindow, toggleDashboardMaximize, requestDashboardClose, openSettingsWindow, openDashboardWindow }) {
  ipc.handle(channels.DESKTOP_GET_STATUS, 'Dashboard status', () => getCurrentStatus());
  ipc.handle(channels.DESKTOP_WINDOW_GET_STATE, 'Dashboard window state', () => getDashboardWindowState());
  ipc.handle(channels.DESKTOP_WINDOW_MINIMIZE, 'Dashboard window', () => minimizeDashboardWindow());
  ipc.handle(channels.DESKTOP_WINDOW_TOGGLE_MAXIMIZE, 'Dashboard window', () => toggleDashboardMaximize());
  ipc.handle(channels.DESKTOP_WINDOW_CLOSE, 'Dashboard window', () => requestDashboardClose());
  ipc.handle(channels.DESKTOP_OPEN_SETTINGS, 'Desktop settings', () => openSettingsWindow());
  ipc.handle(channels.DESKTOP_RELOAD_DASHBOARD, 'Dashboard reload', (_event, routeHash = '') => openDashboardWindow(routeHash, { forceReload: true }));
}

function normalizeLogoutPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.clearData !== 'boolean') {
    throw new Error('Logout request must specify clearData as a boolean.');
  }
  return { clearData: payload.clearData };
}

function registerSharedUtilityIpc({ ipc, channels, BrowserWindow, clipboard, guards, getWizardWindow, fitWindowToContent }) {
  ipc.handle(channels.URL_COPY, 'Clipboard access', (_event, value) => {
    const text = String(value || '').split('\u0000').join('');
    if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) throw new Error('Clipboard text exceeds the 64 KiB safety limit.');
    clipboard.writeText(text);
    return { ok: true };
  });
  ipc.on(channels.WINDOW_FIT_CONTENT, 'Window sizing', (event, payload = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const isWizard = guards.isSenderWindow(event, getWizardWindow);
    fitWindowToContent(win, { type: isWizard ? 'wizard' : 'status', width: Number(payload.width), height: Number(payload.height) });
  });
}

export { MAX_CLIPBOARD_TEXT_BYTES, registerIpcHandlers };
