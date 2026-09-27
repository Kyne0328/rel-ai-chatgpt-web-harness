import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { updateInstallMarkerPath } from './update-install-marker.js';

const electronRoot = path.dirname(fileURLToPath(import.meta.url));
const UPDATE_STATUS_HELPER = 'update-status-helper.ps1';

function updateStatusHelperSourcePath() {
  return path.join(electronRoot, 'build', UPDATE_STATUS_HELPER);
}

function updateStatusHelperPath(app) {
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Electron app path access is required.');
  return path.join(app.getPath('userData'), 'updater', UPDATE_STATUS_HELPER);
}

async function launchUpdateStatusHelper(app, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { ok: true, skipped: true };

  const source = options.sourcePath || updateStatusHelperSourcePath();
  const target = options.targetPath || updateStatusHelperPath(app);
  const markerPath = options.markerPath || updateInstallMarkerPath(app);
  const spawn = options.spawn || nodeSpawn;
  const env = options.env || process.env;

  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.promises.copyFile(source, target);
  } catch (error) {
    return { ok: false, error: `Update status helper could not be prepared: ${cleanError(error)}` };
  }

  const executable = options.executable || windowsPowerShellPath(env);
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', target,
    '-MarkerPath', markerPath
  ];

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(executable, argv, {
        shell: false,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (error) {
      resolve({ ok: false, error: `Update status helper could not start: ${cleanError(error)}` });
      return;
    }

    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once('error', error => finish({ ok: false, error: `Update status helper could not start: ${cleanError(error)}` }));
    child.once('spawn', () => {
      child.unref();
      finish({ ok: true, pid: child.pid || 0, markerPath, helperPath: target });
    });
  });
}

function windowsPowerShellPath(env = process.env) {
  const systemRoot = String(env.SystemRoot || env.WINDIR || '').trim();
  return systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function cleanError(error) {
  return String(error?.message || error || 'unknown error').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
}

export {
  launchUpdateStatusHelper,
  updateStatusHelperPath,
  updateStatusHelperSourcePath,
  windowsPowerShellPath
};
