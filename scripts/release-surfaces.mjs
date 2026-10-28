const WORKSPACE_PACKAGE_FILES = Object.freeze([
  'src/contracts/package.json',
  'src/core/package.json',
  'src/repository/intelligence/package.json',
  'src/ui/package.json'
]);

const VERSION_JSON_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  ...WORKSPACE_PACKAGE_FILES,
  'electron/package.json',
  'electron/package-lock.json'
]);

const RELEASE_CHANGE_FILES = Object.freeze([
  ...VERSION_JSON_FILES,
  'release-manifest.json',
  'CHANGELOG.md',
  'electron/renderer/splash.html'
]);

function isReleaseChangeFile(relativePath) {
  return RELEASE_CHANGE_FILES.includes(String(relativePath || '').replaceAll('\\', '/'));
}

export { RELEASE_CHANGE_FILES, VERSION_JSON_FILES, WORKSPACE_PACKAGE_FILES, isReleaseChangeFile };
