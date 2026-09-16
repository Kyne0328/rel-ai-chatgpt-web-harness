import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAppUpdater } from './app-updater.js';
import { createBrowserSurfaceHost } from './browser-surface-host.js';
import { readBuildStatus } from './build-provenance.js';
import { createDashboardWindowManager } from './dashboard-window.js';
import { createDesktopLifecycleManager } from './desktop-lifecycle.js';
import { createDesktopLocalDataManager } from './desktop-local-data.js';
import { createDesktopOsOperations } from './desktop-os-operations.js';
import { createDesktopNotifications } from './desktop-notifications.js';
import { createDesktopPowerIntegration } from './desktop-power.js';
import { createDesktopTray } from './desktop-tray.js';
import { desktopStatusFailure, initialDesktopStatus, normalizeDesktopStatus } from './desktop-status.js';
import { createDiagnosticFiles } from './diagnostic-files.js';
import { registerIpcHandlers } from './ipc-handlers.js';
import { hasExistingConfig, isManualUpdateInstall } from './launcher-utils.js';
import { installLocalProtocol, localRendererUrl, registerLocalScheme } from './local-protocol.js';
import { createRecoveryWindowManager } from './recovery-window.js';
import { createPulseWindowManager } from './pulse-window.js';
import { importResourceModule } from './resource-path.js';
import { createRuntimeLogBuffer } from './runtime-log-buffer.js';
import { createSecureTunnelRuntime } from './secure-tunnel-runtime.js';
import { createDesktopServiceRuntime } from './service-runtime.js';
import { createServiceProcessClient } from './service-process-client.js';
import { createSetupWindowManager } from './setup-window.js';
import { createShutdownCoordinator } from './shutdown-coordinator.js';
import { clearUpdateInstallMarker, createUpdateInstallMarker } from './update-install-marker.js';
import { createTaskCodeIdeLauncher } from './task-code-ide.js';
import { createTaskbarCompletionBadge } from './taskbar-completion-badge.js';
import { taskActivityBlockReason } from './tool-sleep-blocker.js';
import { configureTunnelSafeStorage, createTunnelCredentialStore } from './tunnel-credentials.js';
import { createTunnelRecoverySupervisor } from './tunnel-recovery-supervisor.js';
import { createUpdateSupportPolicy } from './update-support-policy.js';
import { fitWindowToContent, WINDOW_SIZE_LIMITS } from './window-size.js';
import { removeControllerRuntimeMarker, writeControllerRuntimeMarker } from './controller-runtime.js';
import { readDesktopSettings, saveDesktopSettings } from './desktop-settings.js';

const electronRoot = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(electronRoot, 'preload.cjs');
const rendererRoot = path.join(electronRoot, 'renderer');

async function createDesktopHost(options = {}) {
  const {
    app,
    BrowserWindow,
    WebContentsView,
    ipcMain,
    Tray,
    Menu,
    clipboard,
    shell,
    nativeImage,
    powerMonitor,
    powerSaveBlocker,
    Notification,
    dialog,
    screen,
    protocol,
    session,
    safeStorage,
    utilityProcess,
    autoUpdater
  } = options;
  requireDesktopDependencies(options);

  registerLocalScheme(protocol);
  configureApplicationIdentity(app);

  const [connection, configModule, errorContracts, processModule, processEnvironment] = await Promise.all([
    importResourceModule('src/connectionProfile.js'),
    importResourceModule('src/config.js'),
    importResourceModule('src/contracts/errors.ts'),
    importResourceModule('src/process.js'),
    importResourceModule('src/processEnvironment.js')
  ]);
  const { ERROR_CODES } = errorContracts;
  const { terminateProcessTree } = processModule;
  const { makeServiceProcessEnvironment, makeTunnelProcessEnvironment } = processEnvironment;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app-icon.png')
    : path.join(electronRoot, 'build', 'icon.png');
  const useTrayNotificationFallback = process.platform === 'win32' && app.isPackaged !== true;

  let serviceRuntime = null;
  let serviceProcessClient = null;
  let desktopTray = null;
  let tunnelRecoverySupervisor = null;
  let appUpdater = null;
  let updateSupportPolicy = null;
  let isQuitting = false;
  let allowUpdaterQuit = false;
  let updateInstallPrepared = false;
  let lastServiceContextKey = '';
  let startPromise = null;
  let eventsBound = false;
  const buildStatus = readBuildStatus({ app });
  let currentStatus = initialDesktopStatus(app.getVersion(), buildStatus);

  const diagnosticFiles = createDiagnosticFiles({ app, shell });
  const runtimeLogs = createRuntimeLogBuffer({ filePath: () => diagnosticFiles.serviceLogPath() });
  const desktopNotifications = createDesktopNotifications({
    app,
    Notification,
    iconPath,
    isReady: () => app.isReady(),
    useNativeNotifications: !useTrayNotificationFallback,
    showFallbackNotification: content => desktopTray?.showBalloon(content) === true,
    onNotificationClick: focusActiveWindow,
    onLog: (message, logOptions) => runtimeLogs.append(message, logOptions)
  });
  const tunnelCredentials = createTunnelCredentialStore({ safeStorage });
  const taskCodeIde = createTaskCodeIdeLauncher({ shell });
  const recoveryWindowManager = createRecoveryWindowManager({
    BrowserWindow,
    iconPath,
    preloadPath,
    rendererUrl: localRendererUrl('status.html'),
    limits: WINDOW_SIZE_LIMITS.status,
    installProtocol: sessionProtocol => installLocalProtocol(sessionProtocol, rendererRoot),
    isQuitting: () => isQuitting,
    onReady: hydrateRecoveryWindow,
    onSecurityError: error => runtimeLogs.append(error.message, { level: 'warning', source: 'electron-security' })
  });
  const setupWindowManager = createSetupWindowManager({
    BrowserWindow,
    iconPath,
    preloadPath,
    rendererRoot,
    runtimeLogs,
    isQuitting: () => isQuitting,
    recoveryWindowManager
  });
  const pulseWindowManager = createPulseWindowManager({
    BrowserWindow,
    screen,
    iconPath,
    preloadPath,
    rendererUrl: localRendererUrl('pulse.html'),
    installProtocol: sessionProtocol => installLocalProtocol(sessionProtocol, rendererRoot),
    isQuitting: () => isQuitting,
    onSecurityError: error => runtimeLogs.append(error.message, { level: 'warning', source: 'electron-security' })
  });
  const secureTunnelRuntime = createSecureTunnelRuntime({
    stopProcess: terminateProcessTree,
    makeEnvironment: makeTunnelProcessEnvironment,
    onLog: entry => {
      publicConnectionLog('openai-tunnel', entry);
      if (entry?.code === 'tunnel_upstream_5xx') {
        serviceProcessClient?.updateContext({
          transportEvent: { event: 'upstream_5xx', at: entry.ts || new Date().toISOString() }
        });
      }
    },
    onStatus: handleTunnelStatus
  });
  const desktopLifecycle = createDesktopLifecycleManager({
    app,
    onLog: (message, logOptions) => runtimeLogs.append(message, logOptions),
    errorCodes: ERROR_CODES
  });
  const desktopOsOperations = createDesktopOsOperations({ shell, clipboard, platform: process.platform });
  const dashboardWindowManager = createDashboardWindowManager({
    BrowserWindow,
    shell,
    app,
    dialog,
    screen,
    iconPath,
    canHideOnClose: () => desktopTray?.isAvailable() === true && desktopLifecycle.getStatus().keepRunningOnClose !== false,
    canUserClose: () => allowUpdaterQuit || appUpdater?.getStatus()?.state !== 'installing',
    getConnection: buildDashboardConnection,
    isQuitting: () => isQuitting,
    onError: error => setStatus({ error: formatError(error), errorCode: ERROR_CODES.UNKNOWN }),
    onLoadError: error => {
      setStatus({ error: formatError(error), errorCode: ERROR_CODES.DASHBOARD_UNAVAILABLE });
      recoveryWindowManager.show();
    }
  });
  const browserSurfaceHost = createBrowserSurfaceHost({
    WebContentsView,
    session,
    getDashboardWindow: dashboardWindowManager.getWindow,
    openDashboard: route => showDashboardWindow(route),
    onEvent: event => serviceProcessClient?.sendNativeEvent(event),
    onError: error => runtimeLogs.append(formatError(error), { level: 'warning', source: 'embedded-browser' })
  });
  const taskbarCompletionBadge = createTaskbarCompletionBadge({
    app,
    nativeImage,
    platform: process.platform,
    getWindow: () => dashboardWindowManager.getWindow()
      || recoveryWindowManager.getWindow()
      || setupWindowManager.getWindow()
      || null,
    isApplicationOpen: () => BrowserWindow.getAllWindows().some(win => !win.isDestroyed() && win.isVisible() && win.isFocused())
  });
  serviceProcessClient = createServiceProcessClient({
    utilityProcess,
    modulePath: path.join(electronRoot, 'service-process.js'),
    cwd: path.dirname(electronRoot),
    env: makeServiceProcessEnvironment({}, { allow: configuredProcessEnvironmentAllow() }),
    nativeHandlers: {
      pickFolder: () => dashboardWindowManager.pickFolder(),
      openFolder: payload => dashboardWindowManager.openFolder(payload.path),
      clearRuntimeLogs: () => runtimeLogs.clear(),
      desktopOperation: payload => desktopOsOperations.run(payload),
      browserOperation: (payload, operationOptions) => browserSurfaceHost.run(payload, operationOptions)
    },
    onLog: (message, logOptions) => publicConnectionLog(logOptions.source || 'local-service', message, logOptions),
    onExit: ({ code }) => {
      if (isQuitting || !currentStatus.serverRunning) return;
      setStatus(desktopStatusFailure(
        ERROR_CODES.LOCAL_SERVICE_START_FAILED,
        `Local service process exited unexpectedly with code ${code}. Rel.AI is restarting the connection.`,
        { serverRunning: false, tunnelStatus: 'failed' }
      ));
      void launchConfiguredDesktop({ restart: true, background: true });
    }
  });
  runtimeLogs.onChange(change => serviceProcessClient.updateContext({ runtimeLogChange: change }));

  desktopTray = createDesktopTray({
    Tray,
    Menu,
    nativeImage,
    clipboard,
    iconPath,
    getStatus: () => currentStatus,
    openDashboard: openDashboardWindow,
    focusPrimaryWindow: focusActiveWindow,
    openDiagnostics: openDashboardDiagnostics,
    openSettings: openDashboardSettings,
    startServer,
    stopServer,
    getUpdateStatus: combinedUpdateStatus,
    checkForUpdates: checkApplicationUpdates,
    downloadUpdate: downloadApplicationUpdate,
    installUpdate: installApplicationUpdate,
    quit: quitApplication,
    onError: error => setStatus({ error: formatError(error), errorCode: ERROR_CODES.UNKNOWN })
  });
  const desktopPower = createDesktopPowerIntegration({
    powerMonitor,
    powerSaveBlocker,
    toolActivity: serviceProcessClient.activitySource,
    notify: desktopNotifications.show,
    onTaskCompleted: task => taskbarCompletionBadge.markCompleted(task),
    onStatusChange: setTaskActivityStatus,
    onResume: () => appUpdater?.discoverUpdate?.({ force: true }),
    onError: error => runtimeLogs.append(`Power resume handling failed: ${formatError(error)}`, {
      source: 'desktop-power',
      level: 'warning'
    })
  });
  serviceRuntime = createDesktopServiceRuntime({
    app,
    connection,
    configModule,
    serviceProcessClient,
    dashboardWindowManager,
    runtimeLogs,
    secureTunnelRuntime,
    tunnelCredentials,
    buildStatus,
    errorCodes: ERROR_CODES,
    getCurrentStatus: () => currentStatus,
    setStatus,
    replaceCurrentStatus,
    pushStatus
  });
  tunnelRecoverySupervisor = createTunnelRecoverySupervisor({
    restartConnection: () => serviceRuntime.restartConnection(),
    onSchedule: ({ attempt, delayMs, nextRetryAt, lastError }) => {
      runtimeLogs.append('Secure MCP Tunnel reconnect scheduled.', {
        level: 'warning',
        source: 'openai-tunnel',
        code: ERROR_CODES.TUNNEL_CONNECTION_INTERRUPTED,
        details: { retryAttempt: attempt, retryInMs: delayMs, lastError }
      });
      setStatus({
        serverRunning: currentStatus.serverRunning,
        tunnelStatus: 'degraded',
        tunnelRetryAttempt: attempt,
        tunnelNextRetryAt: nextRetryAt,
        error: 'Secure MCP Tunnel is unavailable. Rel.AI is retrying automatically.',
        errorCode: ERROR_CODES.TUNNEL_CONNECTION_INTERRUPTED
      });
    }
  });
  const desktopLocalData = createDesktopLocalDataManager({
    getAdditionalDataRoots: () => [connection.stateDir()],
    getConfig: () => configModule.readConfig(),
    getServiceLogPath: () => diagnosticFiles.serviceLogPath(),
    getTaskActivity: desktopPower.getStatus,
    getUserDataPath: () => app.getPath('userData'),
    openPath: folder => shell.openPath(folder)
  });
  const shutdownCoordinator = createShutdownCoordinator({
    stopService: () => stopServer({ silent: true, terminateUtility: true }),
    stopUpdater: () => {
      appUpdater?.stop();
      updateSupportPolicy?.stop();
    },
    stopActivity: () => desktopPower.stop(),
    async closeWindows() {
      pulseWindowManager.stop();
      await browserSurfaceHost.closeAll();
      await dashboardWindowManager.close();
      recoveryWindowManager.close();
      setupWindowManager.close({ returnToFallback: false });
      desktopTray.destroy();
    },
    removeRuntimeMarker: removeControllerRuntimeMarker,
    markCleanShutdown: () => desktopLifecycle.markCleanShutdown(),
    flushLogs: () => runtimeLogs.flush(),
    onLog: (message, logOptions) => runtimeLogs.append(message, logOptions)
  });
  appUpdater = createAppUpdater({
    app,
    autoUpdater,
    getTaskActivity: desktopPower.getStatus,
    onStatusChange: pushUpdateStatus,
    onLog: (message, logOptions) => runtimeLogs.append(message, logOptions),
    onBeforeInstall: prepareApplicationUpdate,
    onInstallCommit: commitApplicationUpdate,
    onInstallFailed: recoverApplicationUpdate,
    openUpdateFile: file => shell.openPath(file),
    shouldAutoDownload: () => desktopLifecycle.getStatus().autoDownloadUpdates === true,
    errorCodes: ERROR_CODES
  });
  updateSupportPolicy = createUpdateSupportPolicy({
    app,
    onStatusChange: () => pushUpdateStatus(appUpdater?.getStatus()),
    onLog: (message, logOptions) => runtimeLogs.append(message, logOptions)
  });

  registerIpcHandlers({
    ipcMain,
    BrowserWindow,
    clipboard,
    shell,
    saveLauncherConfig: options.saveLauncherConfig,
    getWizardWindow: setupWindowManager.getWindow,
    closeWizard: setupWindowManager.close,
    getFallbackWindow: recoveryWindowManager.getWindow,
    getDashboardWindow: dashboardWindowManager.getWindow,
    getPulseWindow: pulseWindowManager.getWindow,
    setPulseExpanded: pulseWindowManager.setExpanded,
    getDashboardWindowState: dashboardWindowManager.getState,
    minimizeDashboardWindow: dashboardWindowManager.minimize,
    toggleDashboardMaximize: dashboardWindowManager.toggleMaximize,
    requestDashboardClose: dashboardWindowManager.requestClose,
    getBrowserState: browserSurfaceHost.getState,
    setBrowserSurfaceBounds: browserSurfaceHost.setBounds,
    setBrowserControl: browserSurfaceHost.setControl,
    selectBrowserSession: browserSurfaceHost.selectSession,
    selectBrowserTab: browserSurfaceHost.selectTab,
    closeBrowserTab: browserSurfaceHost.closeTab,
    stopActiveBrowserSession: browserSurfaceHost.stopActiveSession,
    getRecoveryConfig,
    setTunnelApiKey: tunnelCredentials.setApiKey,
    openRecoverySetup,
    startServer,
    stopServer,
    launchConfiguredDesktop,
    restartConnection,
    relaunchApplication,
    logoutApplication,
    quitApplication,
    openSettingsWindow: openDashboardSettings,
    openDashboardWindow,
    getDesktopSettings: currentDesktopSettings,
    saveDesktopSettings: updateDesktopSettings,
    getLocalUsage: serviceProcessClient.getLocalUsage,
    getUpdateStatus: combinedUpdateStatus,
    checkForUpdates: checkApplicationUpdates,
    downloadUpdate: downloadApplicationUpdate,
    installUpdate: installApplicationUpdate,
    getLifecycleStatus: desktopLifecycle.getStatus,
    setLaunchAtLogin: desktopLifecycle.setLaunchAtLogin,
    setKeepAwake,
    setAppPreferences,
    getLocalDataUsage: desktopLocalData.getUsage,
    clearTemporaryLocalData: desktopLocalData.clearTemporary,
    openLocalDataFolder: desktopLocalData.openDataFolder,
    getCurrentStatus: currentDashboardStatus,
    getNotificationsEnabled: () => desktopNotifications.getPreferences().enabled,
    setNotificationsEnabled: desktopNotifications.setEnabled,
    getNotificationPreferences: desktopNotifications.getPreferences,
    updateNotificationPreferences: desktopNotifications.updatePreferences,
    exportDiagnosticState: diagnosticFiles.exportReport,
    openDiagnosticsFolder: diagnosticFiles.openFolder,
    runTunnelDoctor: () => serviceRuntime.runTunnelDoctor(),
    getTaskCodeWorkspace: serviceProcessClient.getTaskCodeWorkspace,
    readTaskCodeDiff: serviceProcessClient.readTaskCodeDiff,
    listCodeEditors: () => ({ ok: true, editors: taskCodeIde.listEditors() }),
    openTaskCodeIde: async payload => taskCodeIde.open(
      await serviceProcessClient.getTaskCodeWorkspacePath(payload),
      payload.editorId
    ),
    fitWindowToContent
  });

  function start() {
    if (startPromise) return startPromise;
    startPromise = startDesktop();
    return startPromise;
  }

  async function startDesktop() {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return { ok: false, reason: 'second-instance' };
    }
    bindApplicationEvents();
    await app.whenReady();

    const basicPasswordStoreEnabled = configureTunnelSafeStorage({
      safeStorage,
      platform: process.platform,
      passwordStore: app.commandLine.getSwitchValue('password-store')
    });
    if (basicPasswordStoreEnabled) {
      runtimeLogs.append('The explicitly requested basic Linux password store is not backed by an OS keyring.', {
        level: 'warning',
        source: 'tunnel-credentials'
      });
    }
    installLocalProtocol(protocol, rendererRoot);
    const [, lifecycleStatus] = await Promise.all([
      writeControllerRuntimeMarker(app),
      desktopLifecycle.start()
    ]);
    desktopPower.setKeepAwakeEnabled(lifecycleStatus.keepAwake === true);
    pulseWindowManager.setEnabled(lifecycleStatus.pulseEnabled !== false);
    pulseWindowManager.setThemePreference(lifecycleStatus.themePreference);
    pulseWindowManager.start();
    pulseWindowManager.update(currentStatus);
    serviceProcessClient.updateContext({ reducedBackgroundWork: lifecycleStatus.reducedBackgroundWork === true });
    desktopTray.setup();
    routeInitialWindow(lifecycleStatus);
    desktopPower.start();
    setImmediate(() => {
      appUpdater.start();
      updateSupportPolicy.start();
    });
    return { ok: true };
  }

  function bindApplicationEvents() {
    if (eventsBound) return;
    eventsBound = true;
    app.on('browser-window-created', (_event, win) => taskbarCompletionBadge.apply(win));
    app.on('browser-window-focus', () => {
      taskbarCompletionBadge.clear();
      void appUpdater?.discoverUpdate?.();
    });
    app.on('second-instance', () => {
      const setupWindow = setupWindowManager.getWindow();
      if (setupWindow) {
        setupWindow.show();
        setupWindow.focus();
        return;
      }
      focusActiveWindow();
    });
    app.on('before-quit', event => {
      if (allowUpdaterQuit || shutdownCoordinator.isPrepared()) return;
      event.preventDefault();
      isQuitting = true;
      void quitApplication();
    });
    app.on('window-all-closed', () => {});
    if (process.platform !== 'win32') {
      process.once('SIGTERM', () => { void quitApplication(); });
    }
  }

  function configuredProcessEnvironmentAllow() {
    try {
      return configModule.readConfig({ allowMissing: true }).processEnvironment?.allow || [];
    } catch {
      return [];
    }
  }

  function currentDesktopSettings() {
    return readDesktopSettings({
      tunnelApiKeyConfigured: tunnelCredentials.status().apiKeyConfigured,
      notificationsEnabled: desktopNotifications.getPreferences().enabled,
      tunnelErrorCode: currentStatus.errorCode,
      tunnelError: currentStatus.error
    });
  }

  function updateDesktopSettings(settings) {
    return saveDesktopSettings(settings, {
      setNotificationsEnabled: desktopNotifications.setEnabled,
      getNotificationsEnabled: () => desktopNotifications.getPreferences().enabled,
      setTunnelApiKey: tunnelCredentials.setApiKey,
      getTunnelApiKey: tunnelCredentials.getApiKey,
      clearTunnelApiKey: tunnelCredentials.clear,
      canRestart: action => taskActivityBlockReason(desktopPower.getStatus(), action),
      getCurrentStatus: () => currentStatus,
      restartConnection,
      restartDesktop: () => launchConfiguredDesktop({ restart: true })
    });
  }

  async function setKeepAwake(enabled) {
    const result = await desktopLifecycle.setKeepAwake(enabled);
    desktopPower.setKeepAwakeEnabled(result?.status?.keepAwake === true);
    return result;
  }

  async function setAppPreferences(patch = {}) {
    const result = await desktopLifecycle.setPreferences(patch);
    if (result?.ok === false) return result;
    if (Object.hasOwn(patch, 'reducedBackgroundWork')) {
      serviceProcessClient.updateContext({ reducedBackgroundWork: result.status?.reducedBackgroundWork === true });
    }
    if (Object.hasOwn(patch, 'pulseEnabled')) {
      pulseWindowManager.setEnabled(result.status?.pulseEnabled !== false);
    }
    if (Object.hasOwn(patch, 'themePreference')) {
      pulseWindowManager.setThemePreference(result.status?.themePreference);
    }
    if (patch.autoDownloadUpdates === true && appUpdater?.getStatus()?.state === 'available') {
      void downloadApplicationUpdate();
    }
    return result;
  }

  function getRecoveryConfig() {
    const settings = currentDesktopSettings();
    return {
      ok: true,
      port: settings.port,
      tunnelId: settings.tunnelId,
      tunnelApiKeyConfigured: settings.tunnelApiKeyConfigured
    };
  }

  function openRecoverySetup() {
    recoveryWindowManager.hide();
    setupWindowManager.create({ recovery: true });
    return { ok: true };
  }

  function focusActiveWindow() {
    taskbarCompletionBadge.clear();
    const dashboardWindow = dashboardWindowManager.getWindow();
    if (dashboardWindow) {
      dashboardWindow.show();
      dashboardWindow.focus();
      return;
    }
    const fallbackWindow = recoveryWindowManager.getWindow();
    if (fallbackWindow?.isVisible()) {
      recoveryWindowManager.show();
      return;
    }
    void openDashboardWindow().catch(() => recoveryWindowManager.show());
  }

  function currentDashboardStatus() {
    return normalizeDesktopStatus({ ...currentStatus, buildStatus });
  }

  function pushStatus(statusOptions = {}) {
    recoveryWindowManager.sendStatus(currentStatus);
    const dashboardWindow = dashboardWindowManager.getWindow();
    if (statusOptions.dashboard !== false && dashboardWindow) {
      dashboardWindow.webContents.send('server:status', currentStatus);
    }
    desktopTray.update();
  }

  function hydrateRecoveryWindow() {
    pushStatus();
    for (const entry of runtimeLogs.snapshot({ limit: 100 }).entries) recoveryWindowManager.sendLog(entry);
  }

  function setTaskActivityStatus(taskActivity) {
    currentStatus = normalizeDesktopStatus({ ...currentStatus, taskActivity });
    pulseWindowManager.update(currentStatus);
    recoveryWindowManager.sendStatus(currentStatus);
  }

  function handleTunnelStatus(status) {
    const common = {
      tunnelStatus: status.state,
      tunnelId: status.tunnelId,
      tunnelHealthUrl: status.healthUrl || ''
    };
    if (status.state === 'running') {
      setStatus({ ...common, tunnelRetryAttempt: 0, tunnelNextRetryAt: null, error: '', errorCode: '' });
      tunnelRecoverySupervisor?.observe(status);
      return;
    }
    if (['starting', 'locally_ready', 'authenticating'].includes(status.state)) {
      setStatus({ ...common, error: '', errorCode: '' });
      return;
    }
    if (status.state === 'degraded') {
      setStatus({
        ...common,
        error: status.error,
        errorCode: status.errorCode || ERROR_CODES.TUNNEL_CONNECTION_INTERRUPTED
      });
      tunnelRecoverySupervisor?.observe(status);
      return;
    }
    if (status.state === 'failed') {
      const recovery = tunnelRecoverySupervisor?.observe(status);
      if (!recovery?.scheduled && !recovery?.inFlight) {
        setStatus({
          ...common,
          tunnelRetryAttempt: 0,
          tunnelNextRetryAt: null,
          error: status.error,
          errorCode: status.errorCode || ERROR_CODES.SECURE_TUNNEL_FAILED
        });
      }
      return;
    }
    if (status.state === 'stopped') {
      setStatus({ ...common, error: '', errorCode: '' });
      tunnelRecoverySupervisor?.observe(status);
    }
  }

  function combinedUpdateStatus(baseStatus = appUpdater?.getStatus()) {
    return { ...(baseStatus || {}), supportPolicy: updateSupportPolicy?.getStatus() || null };
  }

  function combineUpdateActionResult(result) {
    if (!result || typeof result !== 'object') return result;
    return { ...result, status: combinedUpdateStatus(result.status) };
  }

  async function checkApplicationUpdates() {
    return combineUpdateActionResult(await appUpdater?.checkForUpdates());
  }

  async function downloadApplicationUpdate() {
    return combineUpdateActionResult(await appUpdater?.downloadUpdate());
  }

  async function installApplicationUpdate() {
    return combineUpdateActionResult(await appUpdater?.installUpdate());
  }

  async function prepareApplicationUpdate() {
    updateInstallPrepared = false;
    const taskBlock = taskActivityBlockReason(desktopPower.getStatus(), 'installing the update');
    if (taskBlock) throw new Error(taskBlock);
    if (process.platform === 'win32') {
      await createUpdateInstallMarker(app, { targetVersion: appUpdater?.getStatus()?.availableVersion });
    }
    const stopped = await stopServer({ silent: true, preserveDashboard: true });
    if (stopped?.cleanup?.clean === false) {
      throw new Error('Rel.AI could not stop its local runtime cleanly for the update.');
    }
    await runtimeLogs.flush();
    updateInstallPrepared = true;
  }

  async function commitApplicationUpdate() {
    if (!updateInstallPrepared) throw new Error('Rel.AI update preparation did not complete.');
    // Close the app first so the installer never fights locked files or visible
    // windows: shut down windows, tray, and background work, record a clean
    // exit, then let electron-updater quit + relaunch into the installer.
    isQuitting = true;
    await shutdownCoordinator.prepare('update');
    allowUpdaterQuit = true;
  }

  async function recoverApplicationUpdate() {
    await clearUpdateInstallMarker(app).catch(() => {});
    allowUpdaterQuit = false;
    isQuitting = false;
    updateInstallPrepared = false;
    shutdownCoordinator.reset();
    desktopTray.setup();
    if (!serviceRuntime.isListening()) await startServer();
    if (dashboardWindowManager.getWindow()) {
      await showDashboardWindow('', { forceReload: true });
    } else {
      await showDashboardWindow('', { forceReload: true }).catch(() => recoveryWindowManager.show());
    }
  }

  function updateRuntimeAccess() {
    if (appUpdater?.getStatus()?.state === 'installing') {
      return {
        blocked: true,
        errorCode: ERROR_CODES.UPDATE_BUSY,
        message: 'Rel.AI is installing an update. New local work is paused until the app restarts.'
      };
    }
    const policy = updateSupportPolicy?.getStatus();
    if (policy?.requiresUpdate !== true) return { blocked: false, errorCode: '', message: '' };
    const minimum = policy.minimumSupportedVersion
      ? ` v${policy.minimumSupportedVersion} or newer`
      : ' a supported version';
    return {
      blocked: true,
      errorCode: ERROR_CODES.UPDATE_REQUIRED,
      message: policy.message || `This Rel.AI MCP version is no longer supported. Update to${minimum} before MCP work can continue.`
    };
  }

  function pushUpdateStatus(status) {
    const merged = combinedUpdateStatus(status);
    desktopNotifications.handleUpdateStatus(merged);
    dashboardWindowManager.getWindow()?.webContents.send('desktop:update-status', merged);
    desktopTray.update();
    syncServiceContext();
  }

  function setStatus(next, statusOptions = {}) {
    const previous = currentStatus;
    currentStatus = normalizeDesktopStatus({ ...currentStatus, ...next });
    pulseWindowManager.update(currentStatus);
    desktopNotifications.handleDesktopStatusChange(previous, currentStatus);
    runtimeLogs.recordStatusTransition(previous, currentStatus);
    syncServiceContext();
    pushStatus(statusOptions);
  }

  function replaceCurrentStatus(next, statusOptions = {}) {
    const previous = currentStatus;
    currentStatus = normalizeDesktopStatus(next);
    pulseWindowManager.update(currentStatus);
    if (!statusOptions.silent) desktopNotifications.handleDesktopStatusChange(previous, currentStatus);
    runtimeLogs.recordStatusTransition(previous, currentStatus);
    syncServiceContext();
    if (!statusOptions.silent) pushStatus();
    else desktopTray.update();
  }

  function publicConnectionLog(source, value, logOptions = {}) {
    const payload = value && typeof value === 'object' ? value : { message: value };
    const entry = runtimeLogs.append(payload.message, {
      ...payload,
      ...logOptions,
      source: payload.source || source
    });
    if (entry) recoveryWindowManager.sendLog(entry);
  }

  function syncServiceContext() {
    const { taskActivity: _taskActivity, ...status } = currentStatus;
    const context = { status, runtimeAccess: updateRuntimeAccess() };
    const key = JSON.stringify(context);
    if (key === lastServiceContextKey) return false;
    lastServiceContextKey = key;
    serviceProcessClient.updateContext(context);
    return true;
  }

  function startServer() {
    syncServiceContext();
    return serviceRuntime.startServer();
  }

  function restartConnection() {
    return tunnelRecoverySupervisor?.retryNow() || serviceRuntime.restartConnection();
  }

  function stopServer(stopOptions = {}) {
    tunnelRecoverySupervisor?.cancel();
    return serviceRuntime.stopServer(stopOptions);
  }

  async function buildDashboardConnection() {
    const connection = await serviceRuntime.buildDashboardConnection();
    const url = new URL(connection.url);
    url.searchParams.set('theme', desktopLifecycle.getStatus().themePreference || 'system');
    return { ...connection, url: url.href };
  }

  async function showDashboardWindow(routeHash = '', windowOptions = {}) {
    await dashboardWindowManager.open(routeHash, windowOptions);
    taskbarCompletionBadge.clear();
    recoveryWindowManager.hide();
  }

  async function openDashboardWindow(routeHash = '', windowOptions = {}) {
    if (!serviceRuntime.isListening()) {
      void startServer();
      await serviceRuntime.waitUntilListening(0);
    }
    if (!serviceRuntime.isListening()) {
      recoveryWindowManager.show();
      throw new Error(currentStatus.error || 'Rel.AI connection is not running.');
    }
    try {
      await showDashboardWindow(routeHash, windowOptions);
      return { ok: true };
    } catch (error) {
      setStatus(desktopStatusFailure(
        ERROR_CODES.DASHBOARD_UNAVAILABLE,
        `Dashboard failed to open: ${formatError(error)}`
      ));
      recoveryWindowManager.show();
      throw error;
    }
  }

  function openDashboardSettings() {
    return openDashboardWindow('#settings');
  }

  function openDashboardDiagnostics() {
    return openDashboardWindow('#diagnostics');
  }

  function routeInitialWindow(lifecycleStatus = {}) {
    const hasConfig = hasExistingConfig();
    if (hasConfig) {
      if (lifecycleStatus.updated === true && lifecycleStatus.previousVersion) {
        runtimeLogs.append(`Rel.AI MCP updated from ${lifecycleStatus.previousVersion} to ${lifecycleStatus.currentVersion}. Existing connection restored.`, { source: 'desktop-lifecycle' });
      }
      void launchConfiguredDesktop({ background: lifecycleStatus.openedAtLogin });
      return { mode: 'configured', hasConfig: true };
    }
    if (isManualUpdateInstall({ lifecycleStatus, hasConfig })) {
      const previousVersion = String(lifecycleStatus.previousVersion || '');
      const currentVersion = String(lifecycleStatus.currentVersion || app.getVersion() || '');
      runtimeLogs.append(`Rel.AI MCP full-installer update detected${previousVersion ? ` from ${previousVersion}` : ''}${currentVersion ? ` to ${currentVersion}` : ''}. Previous connection was not found, showing update reconnect instead of a fresh install.`, {
        level: 'warning',
        source: 'desktop-lifecycle'
      });
      setupWindowManager.create({ update: true, previousVersion, currentVersion });
      return { mode: 'update', hasConfig: false };
    }
    setupWindowManager.create();
    return { mode: 'fresh', hasConfig: false };
  }

  async function launchConfiguredDesktop(launchOptions = {}) {
    if (launchOptions.restart) {
      const restartBlock = taskActivityBlockReason(desktopPower.getStatus(), 'restarting the connection');
      if (restartBlock) throw new Error(restartBlock);
    }
    try {
      if (launchOptions.restart) await stopServer({ silent: true, preserveDashboard: true });
      const pendingStart = startServer();
      const status = launchOptions.firstRun || launchOptions.background
        ? await pendingStart
        : await serviceRuntime.waitUntilListening(0);
      if (!serviceRuntime.isListening()) {
        recoveryWindowManager.show();
        return status;
      }
      if (!launchOptions.background) {
        if (launchOptions.firstRun) await serviceProcessClient.markOnboardingHandoff();
        await showDashboardWindow('');
      } else {
        recoveryWindowManager.hide();
      }
      return currentStatus;
    } catch (error) {
      if (currentStatus.errorCode !== ERROR_CODES.DASHBOARD_UNAVAILABLE) {
        setStatus(desktopStatusFailure(
          ERROR_CODES.LOCAL_SERVICE_START_FAILED,
          error,
          { serverRunning: false, tunnelStatus: 'failed' }
        ));
      }
      recoveryWindowManager.show();
      return currentStatus;
    }
  }

  async function relaunchApplication() {
    const restartBlock = taskActivityBlockReason(desktopPower.getStatus(), 'restarting Rel.AI');
    if (restartBlock) throw new Error(restartBlock);
    isQuitting = true;
    const shutdown = await shutdownCoordinator.prepare('relaunch');
    app.relaunch();
    app.exit(0);
    return { ok: true, clean: shutdown.clean !== false };
  }

  async function logoutApplication({ clearData = false } = {}) {
    const action = clearData ? 'logging out and clearing local data' : 'logging out';
    const block = taskActivityBlockReason(desktopPower.getStatus(), action);
    if (block) throw new Error(block);

    const clearPlan = clearData ? desktopLocalData.prepareClearAll() : null;
    if (clearPlan?.ok === false) throw new Error(clearPlan.error || 'Rel.AI local data cannot be cleared safely.');
    if (clearData && desktopLifecycle.getStatus().launchAtLogin?.enabled === true) {
      const launchResult = desktopLifecycle.setLaunchAtLogin(false);
      if (launchResult?.ok === false) throw new Error(launchResult.error || 'Launch at sign-in could not be disabled before clearing local data.');
    }

    isQuitting = true;
    const shutdown = await shutdownCoordinator.prepare(clearData ? 'logout_clear_data' : 'logout');
    if (clearData) {
      const cleared = await desktopLocalData.clearAll(clearPlan);
      if (!cleared?.ok) throw new Error(cleared?.error || 'Rel.AI local data could not be cleared.');
    } else {
      tunnelCredentials.clear();
      connection.clearConnectionState();
    }
    app.relaunch();
    app.exit(0);
    return { ok: true, clearData, clean: shutdown.clean !== false };
  }

  async function quitApplication() {
    allowUpdaterQuit = false;
    isQuitting = true;
    await shutdownCoordinator.prepare('quit');
    app.exit(0);
  }

  return Object.freeze({ start });
}

function configureApplicationIdentity(app) {
  const devUserDataPath = String(process.env.REL_AI_ELECTRON_DEV_USER_DATA || '').trim();
  if (devUserDataPath) {
    app.setName('Rel.AI MCP Dev');
    app.setPath('userData', path.resolve(devUserDataPath));
  } else {
    app.setName('Rel.AI MCP');
  }
  if (process.platform === 'win32') {
    app.setAppUserModelId(devUserDataPath ? 'com.relai.mcp.dev' : 'com.relai.mcp');
  }
}

function requireDesktopDependencies(options) {
  const required = [
    'app',
    'BrowserWindow',
    'WebContentsView',
    'ipcMain',
    'Tray',
    'Menu',
    'clipboard',
    'shell',
    'nativeImage',
    'powerMonitor',
    'powerSaveBlocker',
    'Notification',
    'dialog',
    'screen',
    'protocol',
    'session',
    'safeStorage',
    'utilityProcess',
    'autoUpdater',
    'saveLauncherConfig'
  ];
  for (const name of required) {
    if (options[name] == null) throw new TypeError(`Desktop host requires ${name}.`);
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export { createDesktopHost };
