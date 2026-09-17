'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const surfaceArgument = process.argv.find(argument => argument.startsWith('--relai-preload-surface='));
const surface = surfaceArgument?.slice('--relai-preload-surface='.length) || 'application';

function subscribe(channel, callback, label) {
  if (typeof callback !== 'function') throw new TypeError(`${label} listener must be a function.`);
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

if (surface === 'dashboard') {
  contextBridge.exposeInMainWorld('relaiDesktop', {
    getStatus: () => ipcRenderer.invoke('desktop:get-status'),
    getWindowState: () => ipcRenderer.invoke('desktop:window:get-state'),
    minimizeWindow: () => ipcRenderer.invoke('desktop:window:minimize'),
    toggleMaximizeWindow: () => ipcRenderer.invoke('desktop:window:toggle-maximize'),
    closeWindow: () => ipcRenderer.invoke('desktop:window:close'),
    browser: {
      getState: () => ipcRenderer.invoke('desktop:browser:get-state'),
      setBounds: bounds => ipcRenderer.invoke('desktop:browser:set-bounds', bounds),
      setControl: owner => ipcRenderer.invoke('desktop:browser:set-control', owner),
      selectSession: nativeSessionId => ipcRenderer.invoke('desktop:browser:select-session', nativeSessionId),
      selectTab: nativePageId => ipcRenderer.invoke('desktop:browser:select-tab', nativePageId),
      closeTab: nativePageId => ipcRenderer.invoke('desktop:browser:close-tab', nativePageId),
      stop: () => ipcRenderer.invoke('desktop:browser:stop'),
      onState: callback => subscribe('desktop:browser-state', callback, 'Browser-state')
    },
    copyText: text => ipcRenderer.invoke('url:copy', text),
    openSettings: () => ipcRenderer.invoke('desktop:open-settings'),
    getSettings: () => ipcRenderer.invoke('desktop:settings:get'),
    saveSettings: settings => ipcRenderer.invoke('desktop:settings:save', settings),
    getLocalUsage: month => ipcRenderer.invoke('desktop:analytics:local', month),
    getUpdateStatus: () => ipcRenderer.invoke('desktop:update:get'),
    checkForUpdates: () => ipcRenderer.invoke('desktop:update:check'),
    downloadUpdate: () => ipcRenderer.invoke('desktop:update:download'),
    installUpdate: () => ipcRenderer.invoke('desktop:update:install'),
    getLifecycleStatus: () => ipcRenderer.invoke('desktop:lifecycle:get'),
    acknowledgeConnectorRefresh: () => ipcRenderer.invoke('desktop:lifecycle:acknowledge-connector-refresh'),
    setLaunchAtLogin: enabled => ipcRenderer.invoke('desktop:startup:set', enabled === true),
    setKeepAwake: enabled => ipcRenderer.invoke('desktop:keep-awake:set', enabled === true),
    setAppPreferences: patch => ipcRenderer.invoke('desktop:app-preferences:set', patch),
    getNotificationsEnabled: () => ipcRenderer.invoke('desktop:notifications:get'),
    setNotificationsEnabled: enabled => ipcRenderer.invoke('desktop:notifications:set', enabled === true),
    getNotificationPreferences: () => ipcRenderer.invoke('desktop:notification-preferences:get'),
    setNotificationPreferences: patch => ipcRenderer.invoke('desktop:notification-preferences:set', patch),
    exportDiagnosticState: report => ipcRenderer.invoke('desktop:diagnostics:export', report),
    openDiagnosticsFolder: () => ipcRenderer.invoke('desktop:diagnostics:open-folder'),
    runTunnelDoctor: () => ipcRenderer.invoke('desktop:diagnostics:tunnel-doctor'),
    getLocalDataUsage: () => ipcRenderer.invoke('desktop:local-data:get'),
    clearTemporaryLocalData: () => ipcRenderer.invoke('desktop:local-data:clear-temporary'),
    openLocalDataFolder: () => ipcRenderer.invoke('desktop:local-data:open-folder'),
    codeWorkspace: {
      get: taskId => ipcRenderer.invoke('desktop:code:get', { taskId }),
      diff: (taskId, path) => ipcRenderer.invoke('desktop:code:diff', { taskId, path }),
      editors: () => ipcRenderer.invoke('desktop:code:editors'),
      openIde: (taskId, editorId) => ipcRenderer.invoke('desktop:code:open-ide', { taskId, editorId })
    },
    restartConnection: () => ipcRenderer.invoke('desktop:restart-connection'),
    reloadDashboard: routeHash => ipcRenderer.invoke('desktop:reload-dashboard', routeHash),
    relaunchApp: () => ipcRenderer.invoke('desktop:relaunch'),
    logout: clearData => ipcRenderer.invoke('desktop:logout', { clearData: clearData === true }),
    quitApp: () => ipcRenderer.invoke('desktop:quit'),
    stopService: () => ipcRenderer.send('desktop:stop-service'),
    onStatus: callback => subscribe('server:status', callback, 'Status'),
    onWindowState: callback => subscribe('desktop:window-state', callback, 'Window-state'),
    onUpdateStatus: callback => subscribe('desktop:update-status', callback, 'Update-status')
  });
} else if (surface === 'pulse') {
  contextBridge.exposeInMainWorld('relaiPulse', {
    openDashboard: () => ipcRenderer.invoke('url:open-dashboard'),
    setExpanded: expanded => ipcRenderer.invoke('pulse:set-expanded', expanded === true),
    onState: callback => subscribe('pulse:update', callback, 'Pulse-state')
  });
} else {
  contextBridge.exposeInMainWorld('electronAPI', {
    wizardDone: config => ipcRenderer.invoke('wizard:done', config),
    closeWizard: () => ipcRenderer.invoke('wizard:cancel'),
    getRecoveryConfig: () => ipcRenderer.invoke('recovery:get-config'),
    openOpenAISetup: destination => ipcRenderer.invoke('wizard:open-openai-setup', destination),
    openRecoverySetup: () => ipcRenderer.invoke('recovery:open-setup'),
    startServer: () => ipcRenderer.invoke('server:start'),
    stopServer: () => ipcRenderer.invoke('server:stop'),
    restartConnection: () => ipcRenderer.invoke('recovery:restart-connection'),
    relaunchApp: () => ipcRenderer.invoke('recovery:relaunch'),
    copyUrl: url => ipcRenderer.invoke('url:copy', url),
    openDashboard: () => ipcRenderer.invoke('url:open-dashboard'),
    getNotificationsEnabled: () => ipcRenderer.invoke('notifications:get-enabled'),
    setNotificationsEnabled: enabled => ipcRenderer.invoke('notifications:set-enabled', enabled),
    onServerStatus: callback => subscribe('server:status', callback, 'Server-status'),
    onServerLog: callback => subscribe('server:log', callback, 'Server-log'),
    copyText: text => ipcRenderer.invoke('url:copy', text),
    fitWindowToContent: size => ipcRenderer.send('window:fit-content', size)
  });
}
