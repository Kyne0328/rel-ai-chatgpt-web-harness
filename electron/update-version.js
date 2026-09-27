import semver from 'semver';

function parseUpdateVersion(value, options = {}) {
  const version = String(value || '').trim();
  const parsed = semver.parse(version);
  if (!parsed || parsed.version !== version) return null;
  if (options.allowPrerelease !== true && parsed.prerelease.length > 0) return null;
  return parsed;
}

function isUpdateVersion(value, options = {}) {
  return Boolean(parseUpdateVersion(value, options));
}

function compareUpdateVersions(left, right, options = {}) {
  const leftVersion = parseUpdateVersion(left, options);
  const rightVersion = parseUpdateVersion(right, options);
  if (!leftVersion || !rightVersion) return Number.NaN;
  return semver.compare(leftVersion, rightVersion);
}

function parseStableVersion(value) {
  const parsed = parseUpdateVersion(value);
  if (!parsed) return null;
  return [parsed.major, parsed.minor, parsed.patch];
}

function isStableVersion(value) {
  return Boolean(parseStableVersion(value));
}

function compareVersions(left, right) {
  return compareUpdateVersions(left, right);
}

export {
  compareUpdateVersions,
  compareVersions,
  isStableVersion,
  isUpdateVersion,
  parseStableVersion,
  parseUpdateVersion
};
