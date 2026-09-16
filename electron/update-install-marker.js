import * as fs from 'node:fs';
import * as path from 'node:path';

const UPDATE_INSTALL_MARKER = 'update-installing.json';
const STALE_UPDATE_MARKER_MS = 60 * 60 * 1000;

function updateInstallMarkerPath(app) {
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Electron app path access is required.');
  return path.join(app.getPath('userData'), UPDATE_INSTALL_MARKER);
}

async function createUpdateInstallMarker(app, options = {}) {
  const target = updateInstallMarkerPath(app);
  const payload = {
    schemaVersion: 1,
    targetVersion: cleanVersion(options.targetVersion),
    startedAt: new Date().toISOString(),
    sourcePid: process.pid
  };
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ...payload, path: target };
}

async function clearUpdateInstallMarker(app) {
  const target = updateInstallMarkerPath(app);
  try {
    await fs.promises.unlink(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function clearUpdateInstallMarkerSync(app) {
  const target = updateInstallMarkerPath(app);
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function readUpdateInstallMarker(app) {
  const target = updateInstallMarkerPath(app);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      schemaVersion: Number(parsed.schemaVersion || 0),
      targetVersion: cleanVersion(parsed.targetVersion),
      startedAt: String(parsed.startedAt || ''),
      sourcePid: Math.max(0, Number(parsed.sourcePid || 0)),
      path: target
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { fs.unlinkSync(target); } catch {}
    }
    return null;
  }
}

function updateInstallLaunchGuard(app, options = {}) {
  if (options.platform !== 'win32' || options.packaged !== true) return { blocked: false, marker: null, reason: '' };
  const marker = readUpdateInstallMarker(app);
  if (!marker) return { blocked: false, marker: null, reason: '' };

  const argv = Array.isArray(options.argv) ? options.argv : [];
  if (argv.includes('--updated')) {
    clearUpdateInstallMarkerSync(app);
    return { blocked: false, marker, reason: 'updated_launch' };
  }

  const startedAt = Date.parse(marker.startedAt);
  const now = Number(options.nowMs ?? Date.now());
  if (!Number.isFinite(startedAt) || now - startedAt > STALE_UPDATE_MARKER_MS) {
    clearUpdateInstallMarkerSync(app);
    return { blocked: false, marker, reason: 'stale_marker' };
  }

  return { blocked: true, marker, reason: 'update_in_progress' };
}

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').slice(0, 80);
}

export {
  STALE_UPDATE_MARKER_MS,
  clearUpdateInstallMarker,
  clearUpdateInstallMarkerSync,
  createUpdateInstallMarker,
  readUpdateInstallMarker,
  updateInstallLaunchGuard,
  updateInstallMarkerPath
};
