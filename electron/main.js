import {
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
  utilityProcess
} from 'electron';
import { updateInstallLaunchGuard } from './update-install-marker.js';
import { normalizeWizardConfig, saveLauncherConfig } from './launcher-config.js';

const updateLaunchGuard = updateInstallLaunchGuard(app, {
  platform: process.platform,
  packaged: app.isPackaged,
  argv: process.argv
});

if (updateLaunchGuard.blocked) {
  await app.whenReady();
  const targetVersion = updateLaunchGuard.marker?.targetVersion;
  await dialog.showMessageBox({
    type: 'info',
    title: 'Rel.AI MCP is updating',
    message: 'Rel.AI MCP is still updating.',
    detail: `${targetVersion ? `Version ${targetVersion} is` : 'The update is'} being installed. Keep the update window open; Rel.AI will restart automatically when it finishes.`,
    buttons: ['OK'],
    defaultId: 0,
    noLink: true
  });
  app.exit(0);
} else {
  const [{ default: electronUpdater }, { createDesktopHost }] = await Promise.all([
    import('electron-updater'),
    import('./desktop-host.js')
  ]);
  const { autoUpdater } = electronUpdater;
  const desktop = await createDesktopHost({
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
  autoUpdater,
  saveLauncherConfig
});

// Electron waits for ESM evaluation before emitting ready. Do not await a
// startup promise that itself waits for app.whenReady() at module scope.
  void desktop.start().catch(error => {
    console.error('[rel-ai-mcp] Desktop startup failed:', error);
    app.exit(1);
  });
}

export { normalizeWizardConfig, saveLauncherConfig };
