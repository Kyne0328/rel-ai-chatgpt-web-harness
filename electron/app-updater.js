

import { AUTO_CHECK_INTERVAL_MS, AUTO_CHECK_DELAY_MS, createLogger, createUpdateStateStore, detectUpdateSupport } from './app-updater-state.js';
import { cleanText, isoNow, normalizeStatus, progressPayload } from './app-updater-status.js';
import { importResourceModule } from './resource-path.js';

const { runtimeMetadata } = await importResourceModule('src/runtimeCompatibility.js');
import { bindUpdaterEvents } from "./app-updater-events.js";
import { taskActivityBlockReason } from './tool-sleep-blocker.js';
import { createMacManualUpdater } from './macos-manual-updater.js';
import { compareUpdateVersions, compareVersions, isStableVersion, isUpdateVersion, parseStableVersion } from "./update-version.js";

const RELEASE_DISCOVERY_URL = 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/latest/download/latest.yml';
const RELEASE_DOWNLOAD_PREFIX = '/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/';
const RELEASE_DISCOVERY_INTERVAL_MS = 10 * 60 * 1000;
const RELEASE_DISCOVERY_MIN_INTERVAL_MS = 60 * 1000;
const UPDATE_RETRY_DELAYS_MS = Object.freeze([500, 1500]);
const TRANSIENT_UPDATE_ERROR_CODES = Object.freeze([
  'ERR_HTTP2_SERVER_REFUSED_STREAM',
  'ERR_CONNECTION_RESET',
  'ECONNRESET',
  'EPIPE',
  'ERR_TIMED_OUT',
  'ETIMEDOUT',
  'ERR_NETWORK_CHANGED'
]);

function createAppUpdater(options = {}) {
  const {
    app,
    autoUpdater,
    platform = process.platform,
    env = process.env,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    getTaskActivity = () => ({}),
    onStatusChange = () => {},
    onBeforeInstall = async () => {},
    onInstallCommit = async () => {},
    onInstallerLaunch = async () => {},
    onInstallFailed = async () => {},
    retryDelay = delay => new Promise(resolve => setTimer(resolve, delay)),
    onLog = () => {},
    errorCodes = {},
    currentCompatibility = null,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    openUpdateFile = null,
    manualMacUpdater = null,
    shouldAutoDownload = () => false,
    getUpdateChannel = () => 'stable',
    onMacInstallerOpened = async () => {}
  } = options;
  if (!app || typeof app.getVersion !== 'function') throw new TypeError('Electron app is required.');
  if (!autoUpdater || typeof autoUpdater.on !== 'function') throw new TypeError('electron-updater autoUpdater is required.');

  const codes = {
    failed: errorCodes.UPDATE_FAILED || 'update_failed',
    unsupported: errorCodes.UPDATE_NOT_SUPPORTED || 'update_not_supported',
    busy: errorCodes.UPDATE_BUSY || 'update_busy',
    blocked: errorCodes.UPDATE_INSTALL_BLOCKED || 'update_install_blocked'
  };
  const support = detectUpdateSupport({ app, platform, env });
  const installedCompatibility = currentCompatibility || runtimeMetadata();
  const store = createUpdateStateStore({ app, onLog });
  const macUpdater = platform === 'darwin' && support.supported
    ? manualMacUpdater || createMacManualUpdater({ app, arch, fetchImpl, openPath: openUpdateFile, now, onLog: message => log(message) })
    : null;
  const handlers = [];
  let autoCheckTimer = null;
  let releaseDiscoveryTimer = null;
  let releaseDiscoveryPromise = null;
  let lastReleaseDiscoveryAt = 0;
  let retryingOperation = '';
  let installDeferred = false;
  let started = false;
  let lifecycleGeneration = 0;
  let status = normalizeStatus({
    state: support.supported ? 'idle' : 'unsupported',
    supported: support.supported,
    supportReason: support.reason,
    currentVersion: app.getVersion(),
    installMode: platform === 'darwin' ? 'open_dmg' : 'restart'
  });

  function start() {
    if (started) return snapshot();
    started = true;
    lifecycleGeneration += 1;
    if (!support.supported) {
      emit({ state: 'unsupported' });
      return snapshot();
    }
    if (platform !== 'darwin') {
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.disableDifferentialDownload = false;
      configureUpdateChannel();
      autoUpdater.logger = createLogger(onLog);
      bindUpdaterEvents({
        autoUpdater,
        handlers,
        status: snapshot,
        emit,
        handleError,
        handleEventError: handleUpdaterEventError,
        store,
        now,
        log,
        currentCompatibility: installedCompatibility,
        allowPrerelease
      });
    }
    void scheduleAutomaticCheck().then(fullCheckDelay => {
      const discoveryDelay = fullCheckDelay <= AUTO_CHECK_DELAY_MS
        ? RELEASE_DISCOVERY_INTERVAL_MS
        : AUTO_CHECK_DELAY_MS;
      scheduleReleaseDiscovery(discoveryDelay);
    });
    emit({ state: 'idle' });
    return snapshot();
  }

  function stop() {
    if (autoCheckTimer) clearTimer(autoCheckTimer);
    if (releaseDiscoveryTimer) clearTimer(releaseDiscoveryTimer);
    autoCheckTimer = null;
    releaseDiscoveryTimer = null;
    for (const [eventName, handler] of handlers.splice(0)) autoUpdater.removeListener?.(eventName, handler);
    started = false;
    lifecycleGeneration += 1;
  }

  async function checkForUpdates() {
    if (!support.supported) return failure(codes.unsupported, support.reason, false);
    if (isBusy()) return failure(codes.busy, 'An update action is already in progress.', false);
    emit({ state: 'checking', error: '', errorCode: '', integrityVerified: false, availableCompatibility: null, updateSynchronization: null });
    log('Checking for application updates.');
    let result;
    try {
      configureUpdateChannel();
      if (platform === 'darwin') {
        const info = await runWithRetries('Update check', () => macUpdater.checkForUpdates({ channel: updateChannel() }));
        applyMacCheckResult(info);
      } else {
        await runWithRetries('Update check', () => autoUpdater.checkForUpdates());
      }
      result = { ok: true, status: snapshot() };
    } catch (error) {
      result = handleError(error);
    }
    const checkedAt = now();
    await store.writeLastCheck(checkedAt);
    lastReleaseDiscoveryAt = checkedAt;
    void scheduleAutomaticCheck();
    return result;
  }

  async function downloadUpdate() {
    if (!support.supported) return failure(codes.unsupported, support.reason, false);
    if (status.state === 'downloaded') return { ok: true, status: snapshot() };
    if (status.state !== 'available') return failure(codes.busy, 'No downloadable update is currently available.', false);
    emit({ state: 'downloading', progress: progressPayload({ percent: 0 }), error: '', errorCode: '', integrityVerified: false });
    log(`Downloading Rel.AI MCP ${status.availableVersion || 'update'}.`);
    try {
      if (platform === 'darwin') {
        const info = await runWithRetries('Update download', () => macUpdater.downloadUpdate({
          version: status.availableVersion,
          onProgress: progress => emit({ state: 'downloading', progress: progressPayload(progress) })
        }));
        applyMacDownloadResult(info);
      } else {
        await runWithRetries('Update download', () => autoUpdater.downloadUpdate());
      }
      return { ok: true, status: snapshot() };
    } catch (error) {
      return handleError(error);
    }
  }

  async function installUpdate(options = {}) {
    if (!support.supported) return failure(codes.unsupported, support.reason, false);
    if (status.state !== 'downloaded' || status.integrityVerified !== true) {
      const guidance = platform === 'darwin'
        ? 'Download and verify the update before opening the macOS installer.'
        : 'Download and verify the update before installing it.';
      return failure(codes.busy, guidance, false);
    }
    const taskBlock = taskActivityBlockReason(getTaskActivity(), 'installing the update');
    if (taskBlock) {
      if (options.deferIfBusy === true) return deferInstallUntilIdle();
      return failure(codes.blocked, taskBlock, true);
    }
    installDeferred = false;
    if (platform === 'darwin') return openMacUpdate();
    emit({ state: 'installing', error: '', errorCode: '' });
    log(`Closing Rel.AI MCP to install ${status.availableVersion || 'update'}. The app will reopen automatically when the update is done.`);
    try {
      await onBeforeInstall();
      await onInstallCommit();
      await onInstallerLaunch();
      autoUpdater.quitAndInstall(true, true);
      return { ok: true, installing: true, status: snapshot() };
    } catch (error) {
      try {
        await onInstallFailed(error);
      } catch (recoveryError) {
        log(`Update recovery failed: ${cleanText(recoveryError?.message || recoveryError, 400)}`, {
          level: 'warning',
          code: codes.failed
        });
      }
      return handleInstallPreparationError(error);
    }
  }

  async function openMacUpdate() {
    try {
      await macUpdater.openDownloaded(status.availableVersion);
      log(`Opened verified macOS update ${status.availableVersion || ''} for manual installation.`);
      await onMacInstallerOpened();
      return { ok: true, opened: true, status: snapshot() };
    } catch (error) {
      return handleError(error);
    }
  }

  function applyMacCheckResult(info = {}) {
    const availableVersion = String(info.version || '').trim();
    if (!isUpdateVersion(availableVersion, { allowPrerelease: allowPrerelease() })) throw new Error('Update metadata contains an invalid version for the selected release channel.');
    if (!isUpdateVersion(status.currentVersion, { allowPrerelease: true })) {
      throw new Error('The installed application version is invalid, so the update cannot be trusted.');
    }
    if (compareUpdateVersions(availableVersion, status.currentVersion, { allowPrerelease: true }) <= 0) {
      log('Rel.AI MCP is up to date.');
      emit({
        state: 'up_to_date', availableVersion: '', releaseDate: '', releaseNotes: [],
        availableCompatibility: null, updateSynchronization: null,
        checkedAt: isoNow(now), downloadedAt: '', progress: null,
        integrityVerified: false, error: '', errorCode: ''
      });
      return;
    }
    log(`Application update ${availableVersion} was found.`);
    emit({
      state: 'available', availableVersion,
      availableCompatibility: null, updateSynchronization: null,
      releaseDate: cleanText(info.releaseDate, 80), releaseNotes: info.releaseNotes,
      checkedAt: isoNow(now), downloadedAt: '', progress: null,
      integrityVerified: false, error: '', errorCode: ''
    });
  }

  function applyMacDownloadResult(info = {}) {
    const downloadedVersion = String(info.version || '').trim();
    if (!isUpdateVersion(downloadedVersion, { allowPrerelease: allowPrerelease() }) || downloadedVersion !== status.availableVersion) {
      throw new Error(`Downloaded update version ${downloadedVersion || 'unknown'} does not match expected version ${status.availableVersion || 'unknown'}.`);
    }
    log(`Application update ${downloadedVersion} passed SHA-256 release verification and is ready to open.`);
    emit({
      state: 'downloaded', availableVersion: downloadedVersion,
      releaseDate: cleanText(info.releaseDate, 80) || status.releaseDate,
      releaseNotes: info.releaseNotes || status.releaseNotes,
      downloadedAt: isoNow(now),
      progress: progressPayload({ percent: 100, total: status.progress?.total, transferred: status.progress?.total }),
      integrityVerified: true, error: '', errorCode: ''
    });
  }

  async function discoverUpdate({ force = false } = {}) {
    if (!support.supported || !started) return { ok: true, skipped: true, status: snapshot() };
    if (['available', 'downloading', 'downloaded', 'installing'].includes(status.state)) {
      return { ok: true, skipped: true, status: snapshot() };
    }
    const discoveryAt = now();
    if (!force && lastReleaseDiscoveryAt > 0 && discoveryAt - lastReleaseDiscoveryAt < RELEASE_DISCOVERY_MIN_INTERVAL_MS) {
      return { ok: true, skipped: true, status: snapshot() };
    }
    if (releaseDiscoveryPromise) return releaseDiscoveryPromise;
    lastReleaseDiscoveryAt = discoveryAt;
    const discoveryGeneration = lifecycleGeneration;
    releaseDiscoveryPromise = (async () => {
      try {
        if (allowPrerelease()) return await checkForUpdates();
        const latestVersion = await fetchLatestReleaseVersion(fetchImpl);
        if (!started || lifecycleGeneration !== discoveryGeneration) {
          return { ok: true, skipped: true, status: snapshot() };
        }
        if (!isStableVersion(status.currentVersion)) {
          throw new Error('The installed application version is invalid, so release discovery cannot compare versions.');
        }
        if (compareVersions(latestVersion, status.currentVersion) <= 0) {
          return { ok: true, newer: false, latestVersion, status: snapshot() };
        }
        log(`Newly published release ${latestVersion} detected. Verifying update metadata.`);
        return await checkForUpdates();
      } catch (error) {
        log(`Could not check for a newly published release: ${cleanText(error?.message || error, 400)}`, {
          level: 'warning',
          code: 'update_discovery_failed'
        });
        return { ok: false, retryable: true, status: snapshot() };
      } finally {
        releaseDiscoveryPromise = null;
      }
    })();
    return releaseDiscoveryPromise;
  }

  function scheduleReleaseDiscovery(delay = RELEASE_DISCOVERY_INTERVAL_MS) {
    if (!support.supported || !started) return;
    if (releaseDiscoveryTimer) clearTimer(releaseDiscoveryTimer);
    releaseDiscoveryTimer = setTimer(() => {
      releaseDiscoveryTimer = null;
      void discoverUpdate().finally(() => scheduleReleaseDiscovery(RELEASE_DISCOVERY_INTERVAL_MS));
    }, Math.max(AUTO_CHECK_DELAY_MS, delay));
    releaseDiscoveryTimer?.unref?.();
  }

  async function scheduleAutomaticCheck() {
    if (!support.supported || !started) return 0;
    if (autoCheckTimer) clearTimer(autoCheckTimer);
    const lastCheck = await store.readLastCheck();
    if (!support.supported || !started) return 0;
    const elapsed = lastCheck > 0 ? Math.max(0, now() - lastCheck) : 0;
    const delay = lastCheck > 0 && elapsed < AUTO_CHECK_INTERVAL_MS
      ? AUTO_CHECK_INTERVAL_MS - elapsed
      : AUTO_CHECK_DELAY_MS;
    autoCheckTimer = setTimer(() => {
      autoCheckTimer = null;
      void checkForUpdates();
    }, delay);
    autoCheckTimer?.unref?.();
    return delay;
  }

  async function runWithRetries(label, action) {
    retryingOperation = label;
    try {
      for (let attempt = 0; attempt <= UPDATE_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          return await action();
        } catch (error) {
          if (!isTransientUpdateError(error) || attempt >= UPDATE_RETRY_DELAYS_MS.length) throw error;
          const delay = UPDATE_RETRY_DELAYS_MS[attempt];
          log(`${label} hit a transient network error. Retrying in ${delay} ms (${attempt + 2}/${UPDATE_RETRY_DELAYS_MS.length + 1}).`, { level: 'warning', code: 'update_retry' });
          await retryDelay(delay);
        }
      }
    } finally {
      retryingOperation = '';
    }
  }

  function handleUpdaterEventError(error) {
    // The awaited check/download owns failures while it is running. electron-updater can
    // emit the same error before rejecting, so handling both paths would duplicate status
    // changes, logs, and user notifications.
    if (retryingOperation) return;
    return handleError(error);
  }

  function handleError(error) {
    const technicalMessage = cleanText(error instanceof Error ? error.message : error, 600) || 'The application update failed.';
    const message = updateRecoveryMessage(error);
    log(technicalMessage, { level: 'error', code: codes.failed });
    emit({ state: 'error', errorCode: codes.failed, error: message, progress: null, integrityVerified: false });
    return failure(codes.failed, message, true);
  }

  function handleInstallPreparationError(error) {
    const technicalMessage = cleanText(error instanceof Error ? error.message : error, 600) || 'The application update could not be prepared.';
    const message = 'Rel.AI could not prepare the update safely. The current version was not replaced. Try again.';
    log(technicalMessage, { level: 'error', code: codes.failed });
    emit({ state: 'downloaded', errorCode: codes.failed, error: message, integrityVerified: true });
    return failure(codes.failed, message, true);
  }

  function isBusy() {
    return ['checking', 'downloading', 'installing'].includes(status.state);
  }

  function failure(errorCode, error, retryable) {
    return { ok: false, errorCode, error, retryable, status: snapshot() };
  }

  function emit(patch) {
    const previousState = status.state;
    const previousVersion = status.availableVersion;
    status = normalizeStatus({ ...status, ...patch });
    if (status.state !== 'downloaded') installDeferred = false;
    onStatusChange(snapshot());
    const newlyAvailable = status.state === 'available'
      && (previousState !== 'available' || previousVersion !== status.availableVersion);
    if (newlyAvailable && shouldAutoDownload() === true) {
      queueMicrotask(() => {
        if (status.state === 'available') void downloadUpdate();
      });
    }
  }

  function snapshot() {
    const installBlockedReason = status.canInstall
      ? taskActivityBlockReason(getTaskActivity(), 'installing the update')
      : '';
    return {
      ...status,
      progress: status.progress ? { ...status.progress } : null,
      updateChannel: updateChannel(),
      installDeferred,
      installBlockedReason,
      canDeferInstall: Boolean(installBlockedReason) && !installDeferred
    };
  }

  function updateChannel() {
    return getUpdateChannel() === 'beta' ? 'beta' : 'stable';
  }

  function allowPrerelease() {
    return updateChannel() === 'beta';
  }

  function configureUpdateChannel() {
    if (platform !== 'darwin' && support.supported) autoUpdater.allowPrerelease = allowPrerelease();
  }

  async function deferInstallUntilIdle() {
    if (!support.supported) return failure(codes.unsupported, support.reason, false);
    if (status.state !== 'downloaded' || status.integrityVerified !== true) {
      return failure(codes.busy, 'Download and verify the update before scheduling installation.', false);
    }
    const taskBlock = taskActivityBlockReason(getTaskActivity(), 'installing the update');
    if (!taskBlock) return installUpdate();
    installDeferred = true;
    log(`Update ${status.availableVersion || ''} will install automatically when active Rel.AI work finishes.`);
    onStatusChange(snapshot());
    return { ok: true, deferred: true, status: snapshot() };
  }

  async function resumeDeferredInstall() {
    if (!installDeferred || status.state !== 'downloaded' || status.integrityVerified !== true) {
      return { ok: true, skipped: true, status: snapshot() };
    }
    if (taskActivityBlockReason(getTaskActivity(), 'installing the update')) {
      return { ok: true, deferred: true, status: snapshot() };
    }
    installDeferred = false;
    return installUpdate();
  }

  function log(message, options = {}) {
    onLog(cleanText(message, 1000), { source: 'updater', ...options });
  }

  return { start, stop, getStatus: snapshot, discoverUpdate, checkForUpdates, downloadUpdate, installUpdate, deferInstallUntilIdle, resumeDeferredInstall };
}

async function fetchLatestReleaseVersion(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for release discovery.');
  const response = await fetchImpl(RELEASE_DISCOVERY_URL, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'Rel.AI-MCP-Updater' }
  });
  const statusCode = Number(response?.status || 0);
  if (![301, 302, 303, 307, 308].includes(statusCode)) {
    throw new Error(`Release discovery request failed with HTTP ${statusCode || 'unknown'}.`);
  }
  const version = releaseVersionFromLocation(response?.headers?.get?.('location'));
  if (!version) throw new Error('Release discovery returned an invalid GitHub release redirect.');
  return version;
}

function releaseVersionFromLocation(value) {
  try {
    const url = new URL(String(value || ''), RELEASE_DISCOVERY_URL);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    if (!url.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX) || !url.pathname.endsWith('/latest.yml')) return '';
    const encodedVersion = url.pathname.slice(RELEASE_DOWNLOAD_PREFIX.length, -'/latest.yml'.length);
    if (!encodedVersion || encodedVersion.includes('/')) return '';
    const version = decodeURIComponent(encodedVersion).replace(/^v/i, '');
    return isStableVersion(version) ? version : '';
  } catch {
    return '';
  }
}

function isTransientUpdateError(error) {
  const code = cleanText(error?.code, 120).toUpperCase();
  const message = cleanText(error instanceof Error ? error.message : error, 600).toUpperCase();
  return TRANSIENT_UPDATE_ERROR_CODES.some(candidate => code.includes(candidate) || message.includes(candidate));
}

function updateRecoveryMessage(error) {
  const technicalMessage = cleanText(error instanceof Error ? error.message : error, 600);
  if (isTransientUpdateError(error)) {
    return 'Rel.AI could not reach the update service. Check your internet connection and try again.';
  }
  if (/invalid stable version|cannot be trusted|does not match expected version|metadata version|SHA-256|checksum|untrusted update URL|untrusted download URL/i.test(technicalMessage)) {
    return 'Rel.AI could not verify this update. Check for updates again. If the problem continues, install the latest release from GitHub Releases.';
  }
  return 'Rel.AI could not complete the update. Try again. If the problem continues, open Troubleshooting for technical details.';
}

export {
  AUTO_CHECK_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  RELEASE_DISCOVERY_INTERVAL_MS,
  RELEASE_DISCOVERY_MIN_INTERVAL_MS,
  RELEASE_DISCOVERY_URL,
  compareVersions,
  createAppUpdater,
  detectUpdateSupport,
  fetchLatestReleaseVersion,
  isStableVersion,
  normalizeStatus,
  parseStableVersion,
  progressPayload,
  releaseVersionFromLocation
};
