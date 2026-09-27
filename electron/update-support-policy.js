import * as path from 'node:path';
import { importResourceModule } from './resource-path.js';
import { compareUpdateVersions, compareVersions, isStableVersion, isUpdateVersion } from './update-version.js';

const { readJsonFile, readJsonFileAsync, writeJsonAtomicAsync } = await importResourceModule('src/durableState.ts');

const DEFAULT_SUPPORT_POLICY_URL = 'https://raw.githubusercontent.com/Kyne0328/rel-ai-chatgpt-web-harness/main/.github/relai/support-policy.json';
const SUPPORT_POLICY_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SUPPORT_POLICY_SCHEMA_VERSION = 1;
const CACHE_SCHEMA_VERSION = 1;

function normalizeSupportPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Number(value.schemaVersion) !== SUPPORT_POLICY_SCHEMA_VERSION) return null;
  const minimumSupportedVersion = cleanStableVersion(value.minimumSupportedVersion);
  const minimumRecommendedVersion = cleanStableVersion(value.minimumRecommendedVersion);
  if (!minimumSupportedVersion || !minimumRecommendedVersion) return null;
  if (compareVersions(minimumRecommendedVersion, minimumSupportedVersion) < 0) return null;
  const enforceAfter = normalizeOptionalIso(value.enforceAfter);
  if (value.enforceAfter != null && !enforceAfter) return null;
  const policyExpiresAt = normalizeIso(value.policyExpiresAt);
  if (!policyExpiresAt) return null;
  const emergencyBlockedVersions = normalizeBlockedVersions(value.emergencyBlockedVersions);
  if (!emergencyBlockedVersions) return null;
  return {
    schemaVersion: SUPPORT_POLICY_SCHEMA_VERSION,
    minimumSupportedVersion,
    minimumRecommendedVersion,
    enforceAfter,
    emergencyBlockedVersions,
    message: cleanText(value.message, 300),
    policyExpiresAt
  };
}

function assessSupportPolicy(currentVersion, policy, now = Date.now()) {
  const version = cleanComparableVersion(currentVersion);
  const normalized = normalizeSupportPolicy(policy);
  const nowMs = Number(typeof now === 'function' ? now() : now);
  if (!version || !normalized || !Number.isFinite(nowMs)) return unavailableStatus(version);
  const expiresAt = Date.parse(normalized.policyExpiresAt);
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) return unavailableStatus(version, normalized);

  let state = 'current';
  if (normalized.emergencyBlockedVersions.includes(version)) {
    state = 'emergency_blocked';
  } else if (compareUpdateVersions(version, normalized.minimumSupportedVersion, { allowPrerelease: true }) < 0) {
    const enforceAt = normalized.enforceAfter ? Date.parse(normalized.enforceAfter) : Number.NaN;
    state = Number.isFinite(enforceAt) && nowMs >= enforceAt ? 'required' : 'deprecated';
  } else if (compareUpdateVersions(version, normalized.minimumRecommendedVersion, { allowPrerelease: true }) < 0) {
    state = 'recommended';
  }

  const requiresUpdate = state === 'required' || state === 'emergency_blocked';
  return {
    state,
    currentVersion: version,
    minimumSupportedVersion: normalized.minimumSupportedVersion,
    minimumRecommendedVersion: normalized.minimumRecommendedVersion,
    enforceAfter: normalized.enforceAfter,
    emergencyBlockedVersions: [...normalized.emergencyBlockedVersions],
    message: normalized.message,
    policyExpiresAt: normalized.policyExpiresAt,
    requiresUpdate,
    updateRecommended: ['recommended', 'deprecated', 'required', 'emergency_blocked'].includes(state),
    canContinue: !requiresUpdate
  };
}

function createUpdateSupportPolicy(options = {}) {
  const {
    app,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onStatusChange = () => {},
    onLog = () => {}
  } = options;
  if (!app || typeof app.getVersion !== 'function' || typeof app.getPath !== 'function') throw new TypeError('Electron app is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  const policyUrl = resolveSupportPolicyUrl(app, options.policyUrl);
  const cachePath = path.join(safeUserDataPath(app), 'update-support-policy.json');
  let timer = null;
  let started = false;
  let status = withSource(assessmentFromCache(), 'cache');

  function assessmentFromCache() {
    return assessCachedPolicy(readJsonFile(cachePath, { backup: true, fallback: {} }));
  }

  async function assessmentFromCacheAsync() {
    return assessCachedPolicy(await readJsonFileAsync(cachePath, { backup: true, fallback: {} }));
  }

  function assessCachedPolicy(cached) {
    const policy = normalizeSupportPolicy(cached?.policy);
    if (!policy) return unavailableStatus(app.getVersion());
    const assessment = assessSupportPolicy(app.getVersion(), policy, now);
    if (assessment.state === 'unavailable') return assessment;
    return { ...assessment, policyFetchedAt: cleanText(cached.fetchedAt, 80) };
  }

  function start() {
    if (started) return snapshot();
    started = true;
    emit(status);
    void refresh();
    return snapshot();
  }

  function stop() {
    started = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  async function refresh() {
    let next;
    try {
      const response = await fetchImpl(policyUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response?.ok) throw new Error('Support policy request returned HTTP ' + String(response?.status || 0) + '.');
      const policy = normalizeSupportPolicy(await response.json());
      if (!policy) throw new Error('Support policy response failed validation.');
      const assessment = assessSupportPolicy(app.getVersion(), policy, now);
      if (assessment.state === 'unavailable') throw new Error('Support policy is expired or cannot be evaluated.');
      const fetchedAt = isoNow(now);
      await writeCache(cachePath, policy, fetchedAt);
      next = { ...assessment, source: 'remote', checkedAt: fetchedAt, policyFetchedAt: fetchedAt, policyUrl };
    } catch (error) {
      const cached = await assessmentFromCacheAsync();
      next = cached.state === 'unavailable'
        ? { ...cached, source: 'none', checkedAt: isoNow(now), policyUrl }
        : { ...cached, source: 'cache', checkedAt: isoNow(now), policyUrl };
      onLog('Support policy refresh failed: ' + cleanText(error?.message || error, 500), { source: 'updater', level: 'warning' });
    }
    emit(next);
    schedule();
    return snapshot();
  }

  function schedule() {
    if (!started) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, SUPPORT_POLICY_CHECK_INTERVAL_MS);
    timer?.unref?.();
  }

  function emit(next) {
    status = normalizePolicyStatus(next, app.getVersion());
    onStatusChange(snapshot());
  }

  function snapshot() {
    return {
      ...status,
      emergencyBlockedVersions: [...(status.emergencyBlockedVersions || [])]
    };
  }

  return { start, stop, refresh, getStatus: snapshot };
}

function normalizePolicyStatus(value = {}, currentVersion = '') {
  const state = ['current', 'recommended', 'deprecated', 'required', 'emergency_blocked', 'unavailable'].includes(value.state)
    ? value.state
    : 'unavailable';
  const requiresUpdate = state === 'required' || state === 'emergency_blocked';
  return {
    state,
    currentVersion: cleanComparableVersion(value.currentVersion || currentVersion) || '',
    source: ['remote', 'cache', 'none'].includes(value.source) ? value.source : 'none',
    minimumSupportedVersion: cleanStableVersion(value.minimumSupportedVersion) || '',
    minimumRecommendedVersion: cleanStableVersion(value.minimumRecommendedVersion) || '',
    enforceAfter: normalizeOptionalIso(value.enforceAfter),
    emergencyBlockedVersions: normalizeBlockedVersions(value.emergencyBlockedVersions) || [],
    message: cleanText(value.message, 300),
    policyExpiresAt: normalizeIso(value.policyExpiresAt) || '',
    checkedAt: cleanText(value.checkedAt, 80),
    policyFetchedAt: cleanText(value.policyFetchedAt, 80),
    policyUrl: cleanText(value.policyUrl, 500),
    requiresUpdate,
    updateRecommended: ['recommended', 'deprecated', 'required', 'emergency_blocked'].includes(state),
    canContinue: !requiresUpdate
  };
}

function unavailableStatus(currentVersion = '', policy = null) {
  return {
    state: 'unavailable',
    currentVersion: cleanComparableVersion(currentVersion) || '',
    minimumSupportedVersion: policy?.minimumSupportedVersion || '',
    minimumRecommendedVersion: policy?.minimumRecommendedVersion || '',
    enforceAfter: policy?.enforceAfter || null,
    emergencyBlockedVersions: [...(policy?.emergencyBlockedVersions || [])],
    message: policy?.message || '',
    policyExpiresAt: policy?.policyExpiresAt || '',
    requiresUpdate: false,
    updateRecommended: false,
    canContinue: true
  };
}

function withSource(assessment, source) {
  return { ...assessment, source: assessment.state === 'unavailable' ? 'none' : source };
}

function writeCache(cachePath, policy, fetchedAt) {
  return writeJsonAtomicAsync(cachePath, { schemaVersion: CACHE_SCHEMA_VERSION, fetchedAt, policy }, { mode: 0o600, backup: true });
}

function normalizeBlockedVersions(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const versions = [];
  for (const item of value) {
    const version = cleanStableVersion(item);
    if (!version) return null;
    if (!versions.includes(version)) versions.push(version);
  }
  return versions;
}

function cleanStableVersion(value) {
  const version = String(value || '').trim();
  return isStableVersion(version) ? version : '';
}

function cleanComparableVersion(value) {
  const version = String(value || '').trim();
  return isUpdateVersion(version, { allowPrerelease: true }) ? version : '';
}

function normalizeOptionalIso(value) {
  if (value == null || value === '') return null;
  return normalizeIso(value);
}

function normalizeIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function isoNow(now) {
  const value = Number(typeof now === 'function' ? now() : now);
  return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
}

function resolveSupportPolicyUrl(app, explicitUrl) {
  const explicit = cleanText(explicitUrl, 500);
  if (explicit) return explicit;
  if (app?.isPackaged === true) return DEFAULT_SUPPORT_POLICY_URL;
  return cleanText(process.env.REL_AI_UPDATE_POLICY_URL, 500) || DEFAULT_SUPPORT_POLICY_URL;
}

function safeUserDataPath(app) {
  try { return app.getPath('userData'); } catch { return process.cwd(); }
}

function cleanText(value, limit) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return !limit || text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

export {
  DEFAULT_SUPPORT_POLICY_URL,
  assessSupportPolicy,
  createUpdateSupportPolicy,
  normalizeSupportPolicy,
  resolveSupportPolicyUrl
};
