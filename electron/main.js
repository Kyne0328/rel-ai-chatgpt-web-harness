import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  app,
  BrowserWindow,
  crashReporter,
  WebContentsView,
  ipcMain,
  Tray,
  Menu,
  clipboard,
  shell,
  nativeImage,
  nativeTheme,
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
import { configureApplicationIdentity } from './app-identity.js';
import { recordDesktopSmokeReadiness } from './desktop-smoke-readiness.js';
import { clearUpdateInstallMarkerSync, markUpdateInstallPhase, updateInstallLaunchGuard } from './update-install-marker.js';
import { launchUpdateStatusHelper } from './update-status-helper.js';
import { normalizeWizardConfig, saveLauncherConfig } from './launcher-config.js';
import { registerLocalScheme } from './local-protocol.js';

// Application identity must be set before any app.getPath('userData') call.
// Otherwise the update guard resolves the default package-derived profile
// (rel-ai-mcp-launcher) instead of the canonical profile (Rel.AI MCP), and
// Electron safeStorage then decrypts with the wrong profile key.
configureApplicationIdentity(app);
const crashDumpsPath = path.join(app.getPath('userData'), 'diagnostics', 'crashes');
fs.mkdirSync(crashDumpsPath, { recursive: true, mode: 0o700 });
app.setPath('crashDumps', crashDumpsPath);
crashReporter.start({ uploadToServer: false, compress: false });
registerLocalScheme(protocol);

const updateLaunchGuard = updateInstallLaunchGuard(app, {
  platform: process.platform,
  packaged: app.isPackaged,
  argv: process.argv
});

async function launchDesktop() {
  let shouldStartDesktop = !updateLaunchGuard.blocked;
  if (updateLaunchGuard.blocked) {
    await app.whenReady();
    const targetVersion = updateLaunchGuard.marker?.targetVersion;
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Rel.AI MCP is updating',
      message: 'Rel.AI MCP is still updating.',
      detail: `${targetVersion ? `Version ${targetVersion} is` : 'The update is'} being installed. Show the update status window, or discard the lock only if the installer has stopped or failed.`,
      buttons: ['Show update status', 'Discard update lock and start'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (response === 1) {
      clearUpdateInstallMarkerSync(app);
      shouldStartDesktop = true;
    } else {
      const helper = await launchUpdateStatusHelper(app, { markerPath: updateLaunchGuard.marker?.path });
      if (!helper.ok) {
        await dialog.showMessageBox({
          type: 'warning',
          title: 'Update status unavailable',
          message: 'Rel.AI MCP is still updating.',
          detail: 'The update status window could not be opened. The update will continue in the background.',
          buttons: ['OK'],
          defaultId: 0,
          noLink: true
        });
      }
      app.exit(0);
    }
  }

  if (shouldStartDesktop) {
    const hasSingleInstanceLock = app.requestSingleInstanceLock();
    if (!hasSingleInstanceLock) {
      app.quit();
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
        nativeTheme,
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
      void desktop.start().then(async result => {
        if (result?.ok) await recordDesktopSmokeReadiness({ app, BrowserWindow });
        if (result?.ok && updateLaunchGuard.reason === 'updated_launch') {
          void desktop.completeApplicationUpdate(updateLaunchGuard.marker).catch(error => {
            console.error('[rel-ai-mcp] Update completion recording failed:', error);
          });
        }
      }).catch(handleDesktopStartupError);
    }
  }
}

// Let Electron finish evaluating this entry point before waiting for ready.
void launchDesktop().catch(handleDesktopStartupError);

async function handleDesktopStartupError(error) {
  if (updateLaunchGuard.reason === 'updated_launch') {
    await markUpdateInstallPhase(app, 'failed', {
      message: 'The updated files were installed, but Rel.AI could not start. Try opening Rel.AI again.'
    }).catch(() => {});
  }
  console.error('[rel-ai-mcp] Desktop startup failed:', error);
  app.exit(1);
}

export { normalizeWizardConfig, saveLauncherConfig };
