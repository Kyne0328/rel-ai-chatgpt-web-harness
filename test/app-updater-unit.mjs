import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
} from "../electron/app-updater.js";

class FakeUpdater extends EventEmitter {
  constructor({ checkFailures = [], downloadFailures = [] } = {}) {
    super();
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = [];
    this.checkFailures = [...checkFailures];
    this.downloadFailures = [...downloadFailures];
  }
  async checkForUpdates() {
    this.checkCalls += 1;
    const error = this.checkFailures.shift();
    if (error) { this.emit('error', error); throw error; }
  }
  async downloadUpdate() {
    this.downloadCalls += 1;
    const error = this.downloadFailures.shift();
    if (error) { this.emit('error', error); throw error; }
  }
  quitAndInstall(silent, forceRunAfter) { this.installCalls.push({ silent, forceRunAfter }); }
}

const roots = [];

async function waitFor(condition, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function createHarness({ currentVersion = '0.20.7', packaged = true, env = {}, platform = 'win32', manualMacUpdater = null, activeCalls = 0, activeTaskCount = 0, taskState = 'idle', tasks = [], checkFailures = [], downloadFailures = [], currentCompatibility = null, lastCheckAt = 0, fetchImpl = globalThis.fetch, now = () => Date.parse('2026-07-25T00:00:00.000Z'), autoDownloadUpdates = false, updateChannel = 'stable', beforeInstallError = null, commitCallback = null } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-updater-'));
  roots.push(temp);
  if (lastCheckAt > 0) fs.writeFileSync(path.join(temp, 'update-state.json'), `${JSON.stringify({ lastCheckAt })}\n`);
  const fake = new FakeUpdater({ checkFailures, downloadFailures });
  const statuses = [];
  const logs = [];
  const timers = [];
  const activity = { activeCalls, activeTaskCount, state: taskState, tasks };
  let beforeInstall = 0;
  let installCommit = 0;
  let installerLaunch = 0;
  let installRecovery = 0;
  const updater = createAppUpdater({
    app: {
      isPackaged: packaged,
      getVersion: () => currentVersion,
      getPath: () => temp
    },
    autoUpdater: fake,
    platform,
    manualMacUpdater,
    env,
    now,
    fetchImpl,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    getTaskActivity: () => ({ ...activity, tasks: [...activity.tasks] }),
    onStatusChange: status => statuses.push(status),
    onBeforeInstall: () => {
      beforeInstall += 1;
      if (beforeInstallError) throw beforeInstallError;
    },
    onInstallCommit: async () => { installCommit += 1; if (commitCallback) await commitCallback(); },
    onInstallerLaunch: () => { installerLaunch += 1; },
    onInstallFailed: () => { installRecovery += 1; },
    shouldAutoDownload: () => autoDownloadUpdates,
    getUpdateChannel: () => updateChannel,
    retryDelay: async () => {},
    onLog: (message, options) => logs.push({ message, options }),
    currentCompatibility: currentCompatibility || {
      applicationVersion: currentVersion,
      schemaVersion: 3,
      manifestHash: 'hash-current',
      deviceProtocolVersion: 1,
      minimumCompatibleDeviceProtocol: 1
    },
    errorCodes: {
      UPDATE_FAILED: 'update_failed',
      UPDATE_NOT_SUPPORTED: 'update_not_supported',
      UPDATE_BUSY: 'update_busy',
      UPDATE_INSTALL_BLOCKED: 'update_install_blocked'
    }
  });
  return {
    updater, fake, statuses, logs, timers, activity,
    beforeInstall: () => beforeInstall,
    installCommit: () => installCommit,
    installerLaunch: () => installerLaunch,
    installRecovery: () => installRecovery
  };
}

const supportApp = {
  isPackaged: true,
  getVersion: () => '0.20.7',
  getPath: () => os.tmpdir()
};
assert.deepEqual(detectUpdateSupport({ app: { ...supportApp, isPackaged: false }, platform: 'win32', env: {} }), {
  supported: false,
  reason: 'Updates are available only in an installed Rel.AI MCP build.'
});
assert.match(detectUpdateSupport({ app: supportApp, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\Portable' } }).reason, /Portable builds/);
assert.equal(detectUpdateSupport({ app: supportApp, platform: 'win32', env: {} }).supported, true);
assert.equal(detectUpdateSupport({ app: supportApp, platform: 'linux', env: { APPIMAGE: '/opt/Rel.AI-MCP.AppImage' } }).supported, true);
const debResources = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-updater-deb-'));
roots.push(debResources);
fs.writeFileSync(path.join(debResources, 'package-type'), 'deb\n');
assert.equal(detectUpdateSupport({ app: supportApp, platform: 'linux', env: {}, resourcesPath: debResources }).supported, true,
  'installed DEB builds must use electron-updater instead of sending users to App Center');
assert.match(detectUpdateSupport({ app: supportApp, platform: 'linux', env: {}, resourcesPath: os.tmpdir() }).reason, /installed Linux AppImage and DEB builds/);
assert.deepEqual(detectUpdateSupport({ app: supportApp, platform: 'darwin', env: {} }), { supported: true, reason: '' });
assert.deepEqual(progressPayload({ percent: 44.44, transferred: -2, total: 100.8, bytesPerSecond: 20.2 }), {
  percent: 44.4,
  transferred: 0,
  total: 101,
  bytesPerSecond: 20
});
assert.deepEqual(parseStableVersion('1.2.3'), [1, 2, 3]);
for (const value of ['1.2', 'v1.2.3', '1.2.3-beta.1', '']) assert.equal(parseStableVersion(value), null, value);
assert.equal(isStableVersion('10.20.30'), true);
assert.equal(isStableVersion('10.20.30-rc.1'), false);
assert.equal(compareVersions('1.2.3', '1.2.2'), 1);
assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
assert.equal(compareVersions('1.2.3', '2.0.0'), -1);
assert.equal(Number.isNaN(compareVersions('bad', '1.0.0')), true);
assert.ok(Number.isSafeInteger(AUTO_CHECK_DELAY_MS) && AUTO_CHECK_DELAY_MS >= 0, 'automatic update delay must remain bounded');
assert.ok(Number.isSafeInteger(AUTO_CHECK_INTERVAL_MS) && AUTO_CHECK_INTERVAL_MS > AUTO_CHECK_DELAY_MS, 'automatic update interval must remain longer than the initial delay');
assert.ok(RELEASE_DISCOVERY_INTERVAL_MS >= RELEASE_DISCOVERY_MIN_INTERVAL_MS, 'release discovery interval must respect its focus-event throttle');
assert.ok(RELEASE_DISCOVERY_INTERVAL_MS <= 15 * 60 * 1000, 'new releases must be discovered within the intended short background interval');
assert.ok(RELEASE_DISCOVERY_MIN_INTERVAL_MS >= 60 * 1000, 'focus-driven discovery must not create request bursts');
assert.equal(releaseVersionFromLocation('https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.5/latest.yml'), '0.27.5');
assert.equal(releaseVersionFromLocation('https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/v0.27.5/latest.yml'), '0.27.5');
assert.equal(releaseVersionFromLocation('https://example.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.5/latest.yml'), '');
assert.equal(releaseVersionFromLocation('https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.5/other.yml'), '');
let discoveryRequest = null;
assert.equal(await fetchLatestReleaseVersion(async (url, options) => {
  discoveryRequest = { url, options };
  return { status: 302, headers: { get: name => name.toLowerCase() === 'location' ? 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.5/latest.yml' : null } };
}), '0.27.5');
assert.equal(discoveryRequest.url, RELEASE_DISCOVERY_URL);
assert.equal(discoveryRequest.options.method, 'HEAD');
assert.equal(discoveryRequest.options.redirect, 'manual');
assert.equal(normalizeStatus({ supported: true, state: 'downloaded', integrityVerified: false }).canInstall, false);
assert.equal(normalizeStatus({ supported: true, state: 'downloaded', integrityVerified: true }).canInstall, true);
assert.equal(normalizeStatus({ supported: true, installMode: 'open_dmg' }).installMode, 'open_dmg');
assert.equal(normalizeStatus({ supported: true, installMode: 'unexpected' }).installMode, 'restart');

const valid = createHarness();
assert.equal(valid.updater.start().state, 'idle');
assert.equal(valid.fake.autoDownload, false);
assert.equal(valid.fake.autoInstallOnAppQuit, false);
assert.equal(valid.fake.disableDifferentialDownload, false);
assert.equal(valid.fake.allowPrerelease, false);
await waitFor(
  () => valid.timers.some(timer => timer.delay === AUTO_CHECK_DELAY_MS),
  'starting without a prior full check must schedule the fallback update check'
);
await waitFor(
  () => valid.timers.some(timer => timer.delay === RELEASE_DISCOVERY_INTERVAL_MS),
  'an immediately due full check must avoid duplicating it with a simultaneous lightweight discovery request'
);

const macCalls = { checks: 0, downloads: 0, opens: 0 };
const macManualUpdater = {
  async checkForUpdates() {
    macCalls.checks += 1;
    return {
      version: '0.21.0',
      releaseDate: '2026-07-26T00:00:00.000Z',
      releaseNotes: 'macOS updater release notes'
    };
  },
  async downloadUpdate({ version, onProgress }) {
    macCalls.downloads += 1;
    assert.equal(version, '0.21.0');
    onProgress({ percent: 50, transferred: 500, total: 1000, bytesPerSecond: 100 });
    onProgress({ percent: 100, transferred: 1000, total: 1000, bytesPerSecond: 0 });
    return {
      version: '0.21.0',
      releaseDate: '2026-07-26T00:00:00.000Z',
      releaseNotes: 'macOS updater release notes'
    };
  },
  async openDownloaded(version) {
    macCalls.opens += 1;
    assert.equal(version, '0.21.0');
    return { ok: true };
  }
};
const mac = createHarness({ platform: 'darwin', manualMacUpdater: macManualUpdater });
assert.equal(mac.updater.start().state, 'idle');
assert.equal(mac.updater.getStatus().installMode, 'open_dmg');
assert.equal((await mac.updater.checkForUpdates()).ok, true);
assert.equal(mac.updater.getStatus().state, 'available');
assert.equal(mac.updater.getStatus().availableVersion, '0.21.0');
assert.equal((await mac.updater.downloadUpdate()).ok, true);
assert.equal(mac.updater.getStatus().state, 'downloaded');
assert.equal(mac.updater.getStatus().integrityVerified, true);
assert.equal(mac.updater.getStatus().progress.percent, 100);
const macOpen = await mac.updater.installUpdate();
assert.equal(macOpen.ok, true);
assert.equal(macOpen.opened, true);
assert.deepEqual(macCalls, { checks: 1, downloads: 1, opens: 1 });
assert.equal(mac.fake.checkCalls, 0, 'macOS must not call electron-updater without latest-mac.yml metadata');
assert.equal(mac.fake.downloadCalls, 0, 'macOS downloads the architecture-specific DMG through the manual updater');

const recentLaunch = createHarness({ lastCheckAt: Date.parse('2026-07-24T23:59:00.000Z') });
recentLaunch.updater.start();
await waitFor(
  () => recentLaunch.timers.some(timer => timer.delay === AUTO_CHECK_INTERVAL_MS - 60 * 1000),
  'a recent full update check must defer the next full verification until the 24-hour fallback is due'
);
await waitFor(
  () => recentLaunch.timers.some(timer => timer.delay === AUTO_CHECK_DELAY_MS),
  'a recent full update check must still schedule lightweight release discovery shortly after launch'
);

let sameVersionFetches = 0;
const sameVersionDiscovery = createHarness({
  currentVersion: '0.27.4',
  fetchImpl: async () => {
    sameVersionFetches += 1;
    return { status: 302, headers: { get: name => name.toLowerCase() === 'location' ? 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.4/latest.yml' : null } };
  }
});
sameVersionDiscovery.updater.start();
const sameVersionResult = await sameVersionDiscovery.updater.discoverUpdate({ force: true });
assert.equal(sameVersionResult.ok, true);
assert.equal(sameVersionResult.newer, false);
assert.equal(sameVersionDiscovery.fake.checkCalls, 0, 'unchanged release discovery must not run the full updater');
const throttledDiscovery = await sameVersionDiscovery.updater.discoverUpdate();
assert.equal(throttledDiscovery.skipped, true, 'rapid focus events must reuse the discovery throttle');
assert.equal(sameVersionFetches, 1);

const newerVersionDiscovery = createHarness({
  currentVersion: '0.27.4',
  fetchImpl: async () => ({ status: 302, headers: { get: name => name.toLowerCase() === 'location' ? 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.5/latest.yml' : null } })
});
newerVersionDiscovery.updater.start();
assert.equal((await newerVersionDiscovery.updater.discoverUpdate({ force: true })).ok, true);
assert.equal(newerVersionDiscovery.fake.checkCalls, 1, 'a newer published release must trigger the full updater verification exactly once');
assert.ok(newerVersionDiscovery.logs.some(entry => /Newly published release 0\.27\.5 detected/.test(entry.message)));

let resolveStoppedDiscovery;
const stoppedDiscovery = createHarness({
  currentVersion: '0.27.4',
  fetchImpl: () => new Promise(resolve => { resolveStoppedDiscovery = resolve; })
});
stoppedDiscovery.updater.start();
const stoppedDiscoveryPromise = stoppedDiscovery.updater.discoverUpdate({ force: true });
await waitFor(() => typeof resolveStoppedDiscovery === 'function', 'release discovery must enter the fetch before shutdown');
stoppedDiscovery.updater.stop();
resolveStoppedDiscovery({
  status: 302,
  headers: { get: name => name.toLowerCase() === 'location' ? 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/0.27.5/latest.yml' : null }
});
const stoppedDiscoveryResult = await stoppedDiscoveryPromise;
assert.equal(stoppedDiscoveryResult.skipped, true, 'an in-flight release discovery must become inert after updater shutdown');
assert.equal(stoppedDiscovery.fake.checkCalls, 0, 'shutdown discovery must not restart the full updater check');
assert.equal(stoppedDiscovery.updater.getStatus().state, 'idle', 'shutdown discovery must not move updater state back to checking');

const failedDiscovery = createHarness({
  currentVersion: '0.27.4',
  fetchImpl: async () => ({ status: 503, headers: { get: () => null } })
});
failedDiscovery.updater.start();
assert.equal((await failedDiscovery.updater.discoverUpdate({ force: true })).ok, false);
assert.equal(failedDiscovery.updater.getStatus().state, 'idle', 'lightweight discovery failure must not turn a healthy updater into an error state');
assert.ok(failedDiscovery.logs.some(entry => entry.options.code === 'update_discovery_failed'));

const checkPromise = valid.updater.checkForUpdates();
assert.equal(valid.updater.getStatus().state, 'checking');
assert.equal(valid.updater.getStatus().integrityVerified, false);
await checkPromise;
assert.equal(valid.fake.checkCalls, 1);
await waitFor(
  () => valid.timers.some(timer => timer.delay === AUTO_CHECK_INTERVAL_MS),
  'a completed update check must eventually schedule the next automatic check'
);

const transientNetworkError = () => Object.assign(new Error('net::ERR_HTTP2_SERVER_REFUSED_STREAM'), { code: 'ERR_HTTP2_SERVER_REFUSED_STREAM' });
const transientCheck = createHarness({ checkFailures: [transientNetworkError()] });
transientCheck.updater.start();
const transientCheckResult = await transientCheck.updater.checkForUpdates();
assert.equal(transientCheckResult.ok, true, 'transient HTTP/2 stream refusals should recover inside one update action');
assert.ok(transientCheck.fake.checkCalls > 1, 'transient updater failures should retry at least once');
assert.equal(transientCheck.logs.some(entry => entry.options.code === 'update_failed'), false, 'retrying a transient updater failure must not emit update_failed');
assert.ok(transientCheck.logs.some(entry => entry.options.code === 'update_retry'), 'transient updater retries should remain diagnosable');

const exhaustedFailures = Array.from({ length: 20 }, () => transientNetworkError());
const exhaustedCheck = createHarness({ checkFailures: exhaustedFailures });
exhaustedCheck.updater.start();
const exhaustedCheckResult = await exhaustedCheck.updater.checkForUpdates();
assert.equal(exhaustedCheckResult.ok, false);
assert.ok(exhaustedCheck.fake.checkCalls > 1, 'transient updater failures should retry before giving up');
assert.ok(exhaustedCheck.fake.checkCalls < exhaustedFailures.length, 'transient updater retries must remain bounded');
assert.equal(exhaustedCheck.logs.filter(entry => entry.options.code === 'update_failed').length, 1, 'exhausted retries should emit one terminal update failure');
assert.equal(exhaustedCheck.updater.getStatus().state, 'error');
assert.match(exhaustedCheck.updater.getStatus().error, /could not reach the update service/i, 'network internals must be converted to recovery guidance');

const nonTransientCheck = createHarness({ checkFailures: [Object.assign(new Error('certificate rejected'), { code: 'ERR_CERT_AUTHORITY_INVALID' })] });
nonTransientCheck.updater.start();
const nonTransientResult = await nonTransientCheck.updater.checkForUpdates();
assert.equal(nonTransientResult.ok, false);
assert.equal(nonTransientCheck.fake.checkCalls, 1, 'non-transient updater failures must fail without retrying');
assert.equal(nonTransientCheck.logs.filter(entry => entry.options.code === 'update_failed').length, 1, 'an emitted and rejected updater error must have one owner');
assert.ok(nonTransientCheck.logs.some(entry => entry.message === 'certificate rejected'), 'technical updater detail must remain in diagnostics');
assert.doesNotMatch(nonTransientResult.error, /certificate rejected/i, 'ordinary UI must not expose raw updater internals');
assert.match(nonTransientResult.error, /Troubleshooting/i);

valid.fake.emit('update-available', {
  version: '0.21.0',
  releaseDate: '2026-07-26T00:00:00.000Z',
  releaseNotes: '### Improvements\n- Faster updater\n- Clearer release notes',
  relai: { schemaVersion: 3, manifestHash: 'hash-current', deviceProtocolVersion: 1, minimumCompatibleDeviceProtocol: 1 }
});
assert.equal(valid.updater.getStatus().state, 'available');
assert.equal(valid.updater.getStatus().availableVersion, '0.21.0');
assert.equal(valid.updater.getStatus().canDownload, true);
assert.deepEqual(valid.updater.getStatus().updateSynchronization, { status: 'current', toolRefreshRequired: false, deviceUpdateRequired: false });
assert.equal(valid.updater.getStatus().availableCompatibility.schemaVersion, 3);
assert.deepEqual(valid.updater.getStatus().releaseNotes, [{
  version: '0.21.0',
  note: '### Improvements\n- Faster updater\n- Clearer release notes'
}]);

const automaticDownload = createHarness({ autoDownloadUpdates: true });
automaticDownload.updater.start();
automaticDownload.fake.emit('update-available', { version: '0.21.0' });
await waitFor(() => automaticDownload.fake.downloadCalls === 1, 'opted-in update downloads must start automatically after an update becomes available');
assert.equal(automaticDownload.updater.getStatus().state, 'downloading');
assert.equal(automaticDownload.fake.autoDownload, false, 'Rel.AI must keep electron-updater autoDownload disabled so its own verified policy remains authoritative');

const beta = createHarness({ updateChannel: 'beta' });
beta.updater.start();
beta.fake.emit('update-available', { version: '0.21.0-beta.1' });
assert.equal(beta.updater.getStatus().state, 'available', 'beta channel must accept prerelease updater metadata');
assert.equal(beta.fake.allowPrerelease, true, 'electron-updater prerelease discovery must follow the selected beta channel');

const downloadPromise = valid.updater.downloadUpdate();
assert.equal(valid.updater.getStatus().state, 'downloading');
await downloadPromise;
assert.equal(valid.fake.downloadCalls, 1);
valid.fake.emit('download-progress', { percent: 52.5, transferred: 525, total: 1000, bytesPerSecond: 100 });
assert.equal(valid.updater.getStatus().progress.percent, 52.5);
valid.fake.emit('update-downloaded', { version: '0.21.0' });
assert.equal(valid.updater.getStatus().state, 'downloaded');

const transientDownload = createHarness({ downloadFailures: [transientNetworkError()] });
transientDownload.updater.start();
transientDownload.fake.emit('update-available', { version: '0.21.0' });
const transientDownloadResult = await transientDownload.updater.downloadUpdate();
assert.equal(transientDownloadResult.ok, true, 'transient download transport failures should retry without user intervention');
assert.equal(transientDownload.fake.downloadCalls, 2);
assert.equal(transientDownload.logs.some(entry => entry.options.code === 'update_failed'), false);
assert.equal(valid.updater.getStatus().integrityVerified, true);
assert.equal(valid.updater.getStatus().canInstall, true);

valid.activity.activeCalls = 2;
valid.activity.activeTaskCount = 2;
valid.activity.state = 'working';
const blocked = await valid.updater.installUpdate();
assert.equal(blocked.ok, false);
assert.equal(blocked.errorCode, 'update_install_blocked');
assert.match(blocked.error, /2 active Rel\.AI tasks/);
assert.equal(valid.updater.getStatus().state, 'downloaded');

valid.activity.activeCalls = 0;
valid.activity.activeTaskCount = 1;
valid.activity.state = 'waiting';
valid.activity.tasks = [{ taskId: 'waiting-task', status: 'waiting', activeCalls: 0 }];
const waitingBlocked = await valid.updater.installUpdate();
assert.equal(waitingBlocked.ok, false, 'an open task must block install even between connector calls');
assert.match(waitingBlocked.error, /active Rel\.AI task/);
assert.equal(valid.updater.getStatus().state, 'downloaded');

const deferred = await valid.updater.installUpdate({ deferIfBusy: true });
assert.equal(deferred.ok, true);
assert.equal(deferred.deferred, true);
assert.equal(valid.updater.getStatus().installDeferred, true);

valid.activity.activeTaskCount = 0;
valid.activity.state = 'idle';
valid.activity.tasks = [];
const install = await valid.updater.resumeDeferredInstall();
assert.equal(install.ok, true);
assert.equal(valid.updater.getStatus().installDeferred, false);
assert.equal(valid.updater.getStatus().state, 'installing');
assert.equal(valid.beforeInstall(), 1);
assert.equal(valid.installCommit(), 1);
assert.equal(valid.installerLaunch(), 1);
assert.equal(valid.installRecovery(), 0);
assert.deepEqual(valid.fake.installCalls, [{ silent: true, forceRunAfter: true }]);
assert.ok(valid.logs.some(entry => entry.options.source === 'updater'));
assert.ok(valid.statuses.some(status => status.state === 'downloaded' && status.integrityVerified === true));

const preparationFailure = createHarness({ beforeInstallError: new Error('service cleanup failed') });
preparationFailure.updater.start();
preparationFailure.fake.emit('update-available', { version: '0.21.0' });
await preparationFailure.updater.downloadUpdate();
preparationFailure.fake.emit('update-downloaded', { version: '0.21.0' });
const failedInstall = await preparationFailure.updater.installUpdate();
assert.equal(failedInstall.ok, false);
assert.equal(preparationFailure.updater.getStatus().state, 'downloaded', 'failed preparation must keep the verified update retryable');
assert.equal(preparationFailure.updater.getStatus().integrityVerified, true);
assert.match(preparationFailure.updater.getStatus().error, /current version was not replaced/i);
assert.equal(preparationFailure.installCommit(), 0);
assert.equal(preparationFailure.installerLaunch(), 0);
assert.equal(preparationFailure.installRecovery(), 1);
assert.deepEqual(preparationFailure.fake.installCalls, [], 'NSIS must not launch after failed in-app preparation');


const desktopSource = fs.readFileSync(new URL('../electron/desktop-host.js', import.meta.url), 'utf8');
const commitSource = desktopSource.slice(desktopSource.indexOf('  async function commitApplicationUpdate()'), desktopSource.indexOf('  async function recoverApplicationUpdate()'));
const { runInNewContext } = await import('node:vm');
for (const shutdown of [{ ok: false, clean: false, errors: [{ step: 'marker', message: 'fixture failure' }] }, undefined, { ok: true, clean: true }]) {
  const context = {
    process: { platform: 'win32' }, app: {}, updateInstallPrepared: true,
    markUpdateInstallPhase: async () => {}, isQuitting: false, allowUpdaterQuit: false,
    shutdownCoordinator: { prepare: async () => shutdown }
  };
  runInNewContext(commitSource + '\n globalThis.commit = commitApplicationUpdate;', context);
  const composed = createHarness({ commitCallback: context.commit });
  composed.updater.start();
  composed.fake.emit('update-available', { version: '0.21.0' });
  await composed.updater.downloadUpdate();
  composed.fake.emit('update-downloaded', { version: '0.21.0' });
  const result = await composed.updater.installUpdate();
  const clean = shutdown?.clean === true;
  assert.equal(context.allowUpdaterQuit, clean, 'desktop commit requires an explicit clean shutdown result');
  assert.equal(result.ok, clean);
  assert.equal(composed.installerLaunch(), clean ? 1 : 0);
  assert.equal(composed.fake.installCalls.length, clean ? 1 : 0);
  assert.equal(composed.installRecovery(), clean ? 0 : 1);
  if (!clean) {
    assert.equal(composed.updater.getStatus().state, 'downloaded');
    assert.match(composed.updater.getStatus().error, /current version was not replaced/i);
    assert.ok(composed.logs.some(entry => /clean final shutdown/.test(entry.message)), 'shutdown failure details must remain in update diagnostics');
  }
}

for (const candidate of ['bad-version', 'v0.21.0', '0.21.0-beta.1', '0.20.7', '0.19.9']) {
  const harness = createHarness();
  harness.updater.start();
  harness.fake.emit('update-available', { version: candidate });
  assert.equal(harness.updater.getStatus().state, 'error', candidate);
  assert.equal(harness.updater.getStatus().canDownload, false, candidate);
  assert.equal(harness.updater.getStatus().integrityVerified, false, candidate);
}

const schemaChange = createHarness();
schemaChange.updater.start();
schemaChange.fake.emit('update-available', {
  version: '0.21.0',
  relai: { schemaVersion: 4, manifestHash: 'hash-next', deviceProtocolVersion: 1, minimumCompatibleDeviceProtocol: 1 }
});
assert.deepEqual(schemaChange.updater.getStatus().updateSynchronization, { status: 'tool_refresh_required', toolRefreshRequired: true, deviceUpdateRequired: false });

const deviceChange = createHarness();
deviceChange.updater.start();
deviceChange.fake.emit('update-available', {
  version: '0.21.0',
  relai: { schemaVersion: 3, manifestHash: 'hash-current', deviceProtocolVersion: 2, minimumCompatibleDeviceProtocol: 2 }
});
assert.deepEqual(deviceChange.updater.getStatus().updateSynchronization, { status: 'device_update_required', toolRefreshRequired: false, deviceUpdateRequired: true });

const metadataUnknown = createHarness();
metadataUnknown.updater.start();
metadataUnknown.fake.emit('update-available', { version: '0.21.0' });
assert.equal(metadataUnknown.updater.getStatus().updateSynchronization, null, 'missing compatibility metadata must not invent a refresh warning');
assert.equal(metadataUnknown.updater.getStatus().availableCompatibility, null);

const multiReleaseNotes = normalizeStatus({
  supported: true,
  state: 'available',
  availableVersion: '0.21.0',
  releaseNotes: [
    { version: '0.21.0', note: 'Latest notes' },
    { version: '0.20.9', note: 'Previous notes' }
  ]
});
assert.deepEqual(multiReleaseNotes.releaseNotes, [
  { version: '0.21.0', note: 'Latest notes' },
  { version: '0.20.9', note: 'Previous notes' }
]);

const invalidInstalled = createHarness({ currentVersion: 'development' });
invalidInstalled.updater.start();
invalidInstalled.fake.emit('update-available', { version: '1.0.0' });
assert.equal(invalidInstalled.updater.getStatus().state, 'error');
assert.match(invalidInstalled.updater.getStatus().error, /could not verify this update/i);
assert.ok(invalidInstalled.logs.some(entry => /installed application version is invalid/i.test(entry.message)), 'invalid-version detail must remain in diagnostics');

const mismatch = createHarness();
mismatch.updater.start();
mismatch.fake.emit('update-available', { version: '0.21.0' });
mismatch.fake.emit('update-downloaded', { version: '0.21.1' });
assert.equal(mismatch.updater.getStatus().state, 'error');
assert.equal(mismatch.updater.getStatus().integrityVerified, false);
assert.equal(mismatch.updater.getStatus().canInstall, false);
assert.match(mismatch.updater.getStatus().error, /could not verify this update/i);
assert.ok(mismatch.logs.some(entry => /does not match expected version/i.test(entry.message)), 'download mismatch detail must remain in diagnostics');
const mismatchInstall = await mismatch.updater.installUpdate();
assert.equal(mismatchInstall.ok, false);
assert.match(mismatchInstall.error, /Download and verify/);

const unsupported = createHarness({ packaged: false });
assert.equal(unsupported.updater.start().state, 'unsupported');
assert.equal((await unsupported.updater.checkForUpdates()).errorCode, 'update_not_supported');

for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
console.log('App updater unit tests passed.');
