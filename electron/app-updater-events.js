

import { assessUpdateSynchronization, cleanText, isoNow, progressPayload, updateCompatibilityMetadata } from './app-updater-status.js';
import { compareUpdateVersions, isUpdateVersion } from "./update-version.js";

function bindUpdaterEvents({ autoUpdater, handlers, status, emit, handleError, handleEventError = handleError, store, now, log, currentCompatibility = {}, allowPrerelease = () => false, isCurrent = () => true }) {
  const bind = (eventName, handler) => {
    const currentHandler = (...args) => { if (isCurrent()) return handler(...args); };
    autoUpdater.on(eventName, currentHandler);
    handlers.push([eventName, currentHandler]);
  };

  bind('checking-for-update', () => emit({ state: 'checking', error: '', errorCode: '', integrityVerified: false }));
  bind('update-available', info => {
    const availableVersion = String(info?.version || '').trim();
    void store.writeLastCheck(now());
    const versionOptions = { allowPrerelease: allowPrerelease() === true };
    if (!isUpdateVersion(availableVersion, versionOptions)) return handleError(new Error('Update metadata contains an invalid version for the selected release channel.'));
    if (!isUpdateVersion(status().currentVersion, { allowPrerelease: true })) {
      return handleError(new Error('The installed application version is invalid, so the update cannot be trusted.'));
    }
    if (compareUpdateVersions(availableVersion, status().currentVersion, { allowPrerelease: true }) <= 0) {
      return handleError(new Error(`Update metadata version ${availableVersion} is not newer than installed version ${status().currentVersion}.`));
    }
    const availableCompatibility = updateCompatibilityMetadata(info, availableVersion);
    const updateSynchronization = availableCompatibility
      ? assessUpdateSynchronization(currentCompatibility, availableCompatibility)
      : null;
    log(`Application update ${availableVersion} was found.`);
    emit({
      state: 'available', availableVersion,
      availableCompatibility, updateSynchronization,
      releaseDate: cleanText(info?.releaseDate, 80),
      releaseNotes: info?.releaseNotes,
      checkedAt: isoNow(now), downloadedAt: '', progress: null,
      integrityVerified: false, error: '', errorCode: ''
    });
  });
  bind('update-not-available', () => {
    void store.writeLastCheck(now());
    log('Rel.AI MCP is up to date.');
    emit({
      state: 'up_to_date', availableVersion: '', releaseDate: '', releaseNotes: [],
      availableCompatibility: null, updateSynchronization: null,
      checkedAt: isoNow(now), downloadedAt: '', progress: null,
      integrityVerified: false, error: '', errorCode: ''
    });
  });
  bind('download-progress', progress => emit({ state: 'downloading', progress: progressPayload(progress) }));
  bind('update-downloaded', info => {
    const downloadedVersion = String(info?.version || '').trim();
    if (!isUpdateVersion(downloadedVersion, { allowPrerelease: allowPrerelease() === true }) || downloadedVersion !== status().availableVersion) {
      return handleError(new Error(`Downloaded update version ${downloadedVersion || 'unknown'} does not match expected version ${status().availableVersion || 'unknown'}.`));
    }
    log(`Application update ${downloadedVersion} passed release-metadata integrity verification and is ready to install.`);
    emit({
      state: 'downloaded', availableVersion: downloadedVersion,
      releaseDate: cleanText(info?.releaseDate, 80) || status().releaseDate,
      releaseNotes: info?.releaseNotes || status().releaseNotes,
      downloadedAt: isoNow(now),
      progress: progressPayload({ percent: 100, total: status().progress?.total, transferred: status().progress?.total }),
      integrityVerified: true, error: '', errorCode: ''
    });
  });
  bind('update-cancelled', () => emit({
    state: status().availableVersion ? 'available' : 'idle',
    progress: null,
    integrityVerified: false
  }));
  bind('error', handleEventError);
}

export { bindUpdaterEvents };
