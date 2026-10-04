import * as fs from 'node:fs';
import * as path from 'node:path';

const UPDATE_INSTALL_MARKER = 'update-installing.json';
const STALE_UPDATE_MARKER_MS = 5 * 60 * 1000;
const INSTALLING_STALE_UPDATE_MARKER_MS = 60 * 60 * 1000;
const UPDATE_INSTALL_PHASES = new Set([
  'preparing',
  'stopping',
  'closing',
  'installing',
  'starting',
  'complete',
  'failed'
]);
const TERMINAL_UPDATE_INSTALL_PHASES = new Set(['complete', 'failed']);

function updateInstallMarkerPath(app) {
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Electron app path access is required.');
  return path.join(app.getPath('userData'), UPDATE_INSTALL_MARKER);
}

async function createUpdateInstallMarker(app, options = {}) {
  const target = updateInstallMarkerPath(app);
  const timestamp = isoTimestamp(options.now);
  const payload = {
    schemaVersion: 2,
    targetVersion: cleanVersion(options.targetVersion),
    phase: 'preparing',
    startedAt: timestamp,
    updatedAt: timestamp,
    sourcePid: process.pid,
    message: '',
    events: { preparing: timestamp }
  };
  await persistMarker(target, payload);
  return { ...payload, path: target };
}

async function markUpdateInstallPhase(app, phase, options = {}) {
  const target = updateInstallMarkerPath(app);
  const marker = readUpdateInstallMarker(app);
  if (!marker) return null;
  const next = nextMarker(marker, phase, options);
  await persistMarker(target, next);
  return { ...next, path: target };
}

function markUpdateInstallPhaseSync(app, phase, options = {}) {
  const target = updateInstallMarkerPath(app);
  const marker = readUpdateInstallMarker(app);
  if (!marker) return null;
  const next = nextMarker(marker, phase, options);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ...next, path: target };
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
    const startedAt = cleanTimestamp(parsed.startedAt);
    const updatedAt = cleanTimestamp(parsed.updatedAt) || startedAt;
    const phase = UPDATE_INSTALL_PHASES.has(parsed.phase) ? parsed.phase : 'preparing';
    const events = normalizeEvents(parsed.events, startedAt, phase);
    return {
      schemaVersion: Math.max(1, Number(parsed.schemaVersion || 1)),
      targetVersion: cleanVersion(parsed.targetVersion),
      phase,
      startedAt,
      updatedAt,
      sourcePid: Math.max(0, Number(parsed.sourcePid || 0)),
      message: cleanMessage(parsed.message),
      events,
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

  if (TERMINAL_UPDATE_INSTALL_PHASES.has(marker.phase)) {
    clearUpdateInstallMarkerSync(app);
    return { blocked: false, marker, reason: `terminal_${marker.phase}` };
  }

  const argv = Array.isArray(options.argv) ? options.argv : [];
  if (argv.includes('--updated')) {
    const starting = markUpdateInstallPhaseSync(app, 'starting') || marker;
    return { blocked: false, marker: starting, reason: 'updated_launch' };
  }

  const startedAt = Date.parse(marker.startedAt);
  const now = Number(options.nowMs ?? Date.now());
  const installerOwnsHandoff = marker.phase === 'installing' || marker.phase === 'starting';
  const staleAfterMs = installerOwnsHandoff ? INSTALLING_STALE_UPDATE_MARKER_MS : STALE_UPDATE_MARKER_MS;
  if (!Number.isFinite(startedAt) || now - startedAt > staleAfterMs) {
    clearUpdateInstallMarkerSync(app);
    return { blocked: false, marker, reason: 'stale_marker' };
  }

  const processAlive = typeof options.isProcessAlive === 'function' ? options.isProcessAlive : isProcessAlive;
  if (!installerOwnsHandoff && marker.sourcePid > 0 && !processAlive(marker.sourcePid)) {
    clearUpdateInstallMarkerSync(app);
    return { blocked: false, marker, reason: 'source_process_exited' };
  }

  return { blocked: true, marker, reason: 'update_in_progress' };
}

function isProcessAlive(pid) {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function updateInstallTiming(marker, nowMs = Date.now()) {
  const source = marker && typeof marker === 'object' ? marker : {};
  const events = normalizeEvents(source.events, source.startedAt, source.phase);
  const ordered = ['preparing', 'stopping', 'closing', 'installing', 'starting', 'complete'];
  const timestamps = ordered
    .map(phase => ({ phase, ms: Date.parse(events[phase] || '') }))
    .filter(entry => Number.isFinite(entry.ms));
  const durations = {};
  for (let index = 0; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const next = timestamps[index + 1];
    const end = next?.ms ?? (source.phase === 'complete' ? current.ms : Number(nowMs));
    if (Number.isFinite(end) && end >= current.ms) durations[`${current.phase}Ms`] = end - current.ms;
  }
  const started = Date.parse(source.startedAt || events.preparing || '');
  const completed = Date.parse(events.complete || '');
  const end = Number.isFinite(completed) ? completed : Number(nowMs);
  return {
    totalMs: Number.isFinite(started) && Number.isFinite(end) && end >= started ? end - started : 0,
    ...durations
  };
}

function nextMarker(marker, phase, options = {}) {
  if (!UPDATE_INSTALL_PHASES.has(phase)) throw new TypeError(`Unsupported update install phase: ${phase}`);
  const timestamp = isoTimestamp(options.now);
  const events = { ...(marker.events || {}) };
  if (!events[phase]) events[phase] = timestamp;
  return {
    schemaVersion: 2,
    targetVersion: cleanVersion(marker.targetVersion),
    phase,
    startedAt: cleanTimestamp(marker.startedAt) || timestamp,
    updatedAt: timestamp,
    sourcePid: Math.max(0, Number(marker.sourcePid || 0)),
    message: cleanMessage(options.message),
    events
  };
}

async function persistMarker(target, payload) {
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizeEvents(value, startedAt, phase) {
  const source = value && typeof value === 'object' ? value : {};
  const events = {};
  for (const candidate of UPDATE_INSTALL_PHASES) {
    const timestamp = cleanTimestamp(source[candidate]);
    if (timestamp) events[candidate] = timestamp;
  }
  if (!events.preparing && startedAt) events.preparing = startedAt;
  if (!events[phase] && startedAt) events[phase] = startedAt;
  return events;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : value != null ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function cleanTimestamp(value) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
}

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').slice(0, 80);
}

function cleanMessage(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
}

export {
  INSTALLING_STALE_UPDATE_MARKER_MS, STALE_UPDATE_MARKER_MS, clearUpdateInstallMarker, clearUpdateInstallMarkerSync, createUpdateInstallMarker, markUpdateInstallPhase, readUpdateInstallMarker, updateInstallLaunchGuard, updateInstallMarkerPath, updateInstallTiming
};
