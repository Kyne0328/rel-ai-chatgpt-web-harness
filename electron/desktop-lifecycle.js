

import * as path from "node:path";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { importResourceModule } from './resource-path.js';

const { readJsonFileAsync, writeJsonAtomicAsync } = await importResourceModule('src/durableState.ts');

function createDesktopLifecycleManager(options = {}) {
  const {
    app,
    platform = process.platform,
    env = process.env,
    argv = process.argv,
    execPath = process.execPath,
    now = () => new Date().toISOString(),
    onLog = () => {},
    errorCodes = {},
    connectorRevision = readConnectorRevision(app)
  } = options;
  if (!app || typeof app.getVersion !== 'function') throw new TypeError('Electron app is required.');
  const statePath = path.join(safeUserDataPath(app), 'desktop-lifecycle.json');
  const loginItemIdentity = { path: execPath, args: ['--background'] };
  const startupSupport = detectStartupSupport({ app, platform, env });
  const currentConnectorRevision = cleanText(connectorRevision, 240);
  const codes = {
    unsupported: errorCodes.STARTUP_SETTING_NOT_SUPPORTED || 'startup_setting_not_supported',
    failed: errorCodes.STARTUP_SETTING_FAILED || 'startup_setting_failed',
    state: errorCodes.LIFECYCLE_STATE_FAILED || 'lifecycle_state_failed'
  };
  let launchId = '';
  let status = baseStatus(app, startupSupport, currentConnectorRevision);

  async function start() {
    const previous = await readState();
    const currentVersion = cleanVersion(app.getVersion());
    const previousConnectorRevision = cleanText(previous.connectorRevision, 240);
    const previousPendingConnectorRevision = cleanText(previous.pendingConnectorRefreshRevision, 240);
    const hasDurableConnectorRefreshState = Object.hasOwn(previous, 'pendingConnectorRefreshRevision');
    const updated = Boolean(previous.version && previous.version !== currentVersion);
    const connectorChanged = Boolean(previous.version && currentConnectorRevision && (
      previousConnectorRevision
        ? previousConnectorRevision !== currentConnectorRevision
        : updated
    ));
    const migrateUntrackedConnectorRefresh = Boolean(previous.version && currentConnectorRevision && !hasDurableConnectorRefreshState);
    const pendingConnectorRefreshRevision = connectorChanged || migrateUntrackedConnectorRefresh
      ? currentConnectorRevision
      : previousPendingConnectorRevision === currentConnectorRevision
        ? currentConnectorRevision
        : '';
    const connectorRefreshRequired = Boolean(pendingConnectorRefreshRevision);
    const launchAtLogin = readLaunchAtLogin();
    launchId = crypto.randomUUID();
    status = {
      ...baseStatus(app, startupSupport, currentConnectorRevision),
      currentVersion,
      previousVersion: previous.version && previous.version !== currentVersion ? cleanVersion(previous.version) : '',
      firstLaunch: !previous.version,
      updated,
      pendingConnectorRefreshRevision,
      connectorRefreshRequired,
      recoveredAfterUncleanShutdown: previous.running === true && !updated,
      launchCount: Math.max(0, Number(previous.launchCount || 0)) + 1,
      launchedAt: now(),
      lastCleanExitAt: cleanText(previous.lastCleanExitAt, 80),
      launchAtLogin,
      keepAwake: previous.keepAwake === true,
      keepRunningOnClose: previous.keepRunningOnClose !== false,
      pulseEnabled: previous.pulseEnabled !== false,
      themePreference: normalizeThemePreference(previous.themePreference),
      autoDownloadUpdates: previous.autoDownloadUpdates === true,
      reducedBackgroundWork: previous.reducedBackgroundWork === true,
      openedAtLogin: argv.includes('--background') || launchAtLogin.openedAtLogin === true
    };
    await writeState(persistedState(true));
    recordLaunch();
    return snapshot();
  }

  async function markCleanShutdown() {
    if (!launchId) return snapshot();
    const cleanExitAt = now();
    await writeState(persistedState(false, cleanExitAt));
    status = { ...status, lastCleanExitAt: cleanExitAt };
    launchId = '';
    onLog('Desktop lifecycle recorded a clean shutdown.', { source: 'desktop-lifecycle' });
    return snapshot();
  }

  function getStatus() {
    status = { ...status, launchAtLogin: readLaunchAtLogin() };
    return snapshot();
  }

  function setLaunchAtLogin(enabled) {
    if (!startupSupport.supported) {
      return { ok: false, errorCode: codes.unsupported, error: startupSupport.reason, status: getStatus() };
    }
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled === true,
        openAsHidden: true,
        ...loginItemIdentity
      });
      status = { ...status, launchAtLogin: readLaunchAtLogin() };
      onLog(`Launch at sign-in ${status.launchAtLogin.enabled ? 'enabled' : 'disabled'}.`, { source: 'desktop-lifecycle' });
      return { ok: true, status: snapshot() };
    } catch (error) {
      const message = cleanText(error?.message || error, 400) || 'Launch at sign-in could not be changed.';
      onLog(message, { source: 'desktop-lifecycle', level: 'error', code: codes.failed });
      return { ok: false, errorCode: codes.failed, error: message, status: snapshot() };
    }
  }

  async function acknowledgeConnectorRefresh() {
    if (!status.connectorRefreshRequired) return { ok: true, status: snapshot() };
    const previousPendingRevision = status.pendingConnectorRefreshRevision;
    status = { ...status, pendingConnectorRefreshRevision: '', connectorRefreshRequired: false };
    if (!await writeState(persistedState(Boolean(launchId)))) {
      status = { ...status, pendingConnectorRefreshRevision: previousPendingRevision, connectorRefreshRequired: true };
      return {
        ok: false,
        errorCode: codes.state,
        error: 'Connector refresh acknowledgement could not be saved. Try again.',
        status: snapshot()
      };
    }
    onLog('ChatGPT connector refresh notice acknowledged.', { source: 'desktop-lifecycle' });
    return { ok: true, status: snapshot() };
  }

  async function setKeepAwake(enabled) {
    const previous = status.keepAwake === true;
    const next = enabled === true;
    if (next === previous) return { ok: true, status: snapshot() };
    status = { ...status, keepAwake: next };
    if (!await writeState(persistedState(Boolean(launchId)))) {
      status = { ...status, keepAwake: previous };
      return {
        ok: false,
        errorCode: codes.state,
        error: 'Keep-awake setting could not be saved. Try again.',
        status: snapshot()
      };
    }
    onLog(`Keep computer awake ${next ? 'enabled' : 'disabled'}.`, { source: 'desktop-lifecycle' });
    return { ok: true, status: snapshot() };
  }

  async function setPreferences(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, errorCode: codes.state, error: 'App preferences are invalid.', status: snapshot() };
    }
    const fields = ['keepRunningOnClose', 'pulseEnabled', 'autoDownloadUpdates', 'reducedBackgroundWork'];
    const previous = {
      ...Object.fromEntries(fields.map(field => [field, status[field] === true])),
      themePreference: normalizeThemePreference(status.themePreference)
    };
    const next = { ...previous };
    let changed = false;
    for (const field of fields) {
      if (!Object.hasOwn(patch, field)) continue;
      if (typeof patch[field] !== 'boolean') {
        return { ok: false, errorCode: codes.state, error: 'App preferences must use on/off values.', status: snapshot() };
      }
      next[field] = patch[field];
      if (next[field] !== previous[field]) changed = true;
    }
    if (Object.hasOwn(patch, 'themePreference')) {
      if (!['system', 'dark', 'light'].includes(patch.themePreference)) {
        return { ok: false, errorCode: codes.state, error: 'Theme preference is invalid.', status: snapshot() };
      }
      next.themePreference = patch.themePreference;
      if (next.themePreference !== previous.themePreference) changed = true;
    }
    if (!changed) return { ok: true, status: snapshot() };
    status = { ...status, ...next };
    if (!await writeState(persistedState(Boolean(launchId)))) {
      status = { ...status, ...previous };
      return { ok: false, errorCode: codes.state, error: 'App preferences could not be saved. Try again.', status: snapshot() };
    }
    onLog('Desktop app preferences updated.', { source: 'desktop-lifecycle' });
    return { ok: true, status: snapshot() };
  }

  function readLaunchAtLogin() {
    if (!startupSupport.supported) {
      return { supported: false, enabled: false, openedAtLogin: false, reason: startupSupport.reason };
    }
    try {
      const settings = app.getLoginItemSettings(loginItemIdentity);
      return {
        supported: true,
        enabled: settings.openAtLogin === true,
        openedAtLogin: settings.wasOpenedAtLogin === true,
        reason: ''
      };
    } catch (error) {
      return {
        supported: false,
        enabled: false,
        openedAtLogin: false,
        reason: cleanText(error?.message || error, 300) || 'Startup settings are unavailable.'
      };
    }
  }

  function readState() {
    return readJsonFileAsync(statePath, { backup: true, fallback: {} });
  }

  async function writeState(value) {
    try {
      await writeJsonAtomicAsync(statePath, value, { mode: 0o600, backup: true });
      return true;
    } catch (error) {
      onLog(`Desktop lifecycle state could not be saved: ${cleanText(error?.message || error, 240)}`, {
        source: 'desktop-lifecycle',
        level: 'warning',
        code: codes.state
      });
      return false;
    }
  }

  function persistedState(running, lastCleanExitAt = status.lastCleanExitAt) {
    return {
      version: status.currentVersion,
      connectorRevision: status.connectorRevision,
      pendingConnectorRefreshRevision: status.pendingConnectorRefreshRevision,
      running,
      launchId,
      launchCount: status.launchCount,
      launchedAt: status.launchedAt,
      lastCleanExitAt,
      keepAwake: status.keepAwake === true,
      keepRunningOnClose: status.keepRunningOnClose !== false,
      pulseEnabled: status.pulseEnabled !== false,
      themePreference: normalizeThemePreference(status.themePreference),
      autoDownloadUpdates: status.autoDownloadUpdates === true,
      reducedBackgroundWork: status.reducedBackgroundWork === true
    };
  }

  function recordLaunch() {
    if (status.updated) {
      onLog(`Rel.AI MCP updated from ${status.previousVersion} to ${status.currentVersion}.`, { source: 'desktop-lifecycle' });
    } else if (status.firstLaunch) {
      onLog(`Rel.AI MCP ${status.currentVersion} started for the first time.`, { source: 'desktop-lifecycle' });
    }
    if (status.recoveredAfterUncleanShutdown) {
      onLog('Rel.AI recovered after the previous desktop process ended without a clean shutdown.', {
        source: 'desktop-lifecycle',
        level: 'warning',
        code: 'unclean_shutdown_detected'
      });
    }
  }

  function snapshot() {
    return { ...status, launchAtLogin: { ...status.launchAtLogin } };
  }

  return { start, markCleanShutdown, getStatus, acknowledgeConnectorRefresh, setLaunchAtLogin, setKeepAwake, setPreferences };
}

function baseStatus(app, support, connectorRevision = '') {
  return {
    currentVersion: cleanVersion(app.getVersion()),
    previousVersion: '',
    firstLaunch: false,
    updated: false,
    connectorRevision: cleanText(connectorRevision, 240),
    pendingConnectorRefreshRevision: '',
    connectorRefreshRequired: false,
    recoveredAfterUncleanShutdown: false,
    launchCount: 0,
    launchedAt: '',
    lastCleanExitAt: '',
    launchAtLogin: { supported: support.supported, enabled: false, openedAtLogin: false, reason: support.reason },
    keepAwake: false,
    keepRunningOnClose: true,
    pulseEnabled: true,
    themePreference: 'system',
    autoDownloadUpdates: false,
    reducedBackgroundWork: false,
    openedAtLogin: false
  };
}

function readConnectorRevision(app) {
  const currentVersion = cleanVersion(app?.getVersion?.());
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const candidates = [];
  if (app?.isPackaged && typeof process.resourcesPath === 'string' && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'release-manifest.json'));
  }
  candidates.push(path.join(moduleRoot, 'release-manifest.json'));
  for (const manifestPath of candidates) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (cleanVersion(manifest.applicationVersion) !== currentVersion) continue;
      const manifestHash = cleanText(manifest.manifestHash, 80);
      if (!manifestHash) continue;
      return [
        cleanText(manifest.protocolVersion, 40),
        Number(manifest.toolSurfaceVersion || 0),
        Number(manifest.toolCount || 0),
        manifestHash,
        Number(manifest.schemaVersion || 0)
      ].join(':');
    } catch {}
  }
  return '';
}

function detectStartupSupport({ app, platform, env }) {
  if (!app.isPackaged) return { supported: false, reason: 'Launch at sign-in is available only in the installed Windows app.' };
  if (platform !== 'win32') return { supported: false, reason: 'Launch at sign-in is currently available only on Windows.' };
  if (env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE) {
    return { supported: false, reason: 'Portable builds do not register themselves to launch at sign-in.' };
  }
  if (typeof app.getLoginItemSettings !== 'function' || typeof app.setLoginItemSettings !== 'function') {
    return { supported: false, reason: 'This build does not expose Windows startup settings.' };
  }
  return { supported: true, reason: '' };
}

function safeUserDataPath(app) {
  try { return app.getPath('userData'); } catch { return process.cwd(); }
}

function cleanVersion(value) {
  return cleanText(value, 80).replace(/^v/i, '');
}

function normalizeThemePreference(value) {
  return ['dark', 'light'].includes(value) ? value : 'system';
}

function cleanText(value, limit) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export { createDesktopLifecycleManager, detectStartupSupport };
