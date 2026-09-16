import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

import { createInstallerTestContext, removeOwnedTestRoot } from './installer-test-safety.mjs';
import { releaseArtifactNames } from './release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));

async function main() {
  assertDisposableReleaseRunner(process.env);
  const currentVersion = packageJson.version;
  const names = releaseArtifactNames(currentVersion, { electronPackage });
  const platform = process.platform;
  if (!['win32', 'linux'].includes(platform)) {
    throw new Error(`Installed release lifecycle validation is not implemented for ${platform}.`);
  }

  const currentArtifactName = platform === 'win32' ? names.installer : names.linuxDeb;
  const currentArtifact = path.join(root, 'dist', currentArtifactName);
  assert.ok(fs.existsSync(currentArtifact), `Current release artifact is missing: ${currentArtifact}`);

  const previous = await findPreviousReleaseAsset({
    repository: process.env.GITHUB_REPOSITORY,
    currentVersion,
    token: process.env.GITHUB_TOKEN,
    assetNameForVersion: version => {
      const releaseNames = releaseArtifactNames(version, { electronPackage });
      return platform === 'win32' ? releaseNames.installer : releaseNames.linuxDeb;
    }
  });

  if (platform === 'win32') {
    await validateWindowsLifecycle({ currentArtifact, currentVersion, previous });
  } else {
    await validateLinuxLifecycle({ currentArtifact, currentVersion, previous });
  }
}

function assertDisposableReleaseRunner(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Installed release validation is restricted to disposable GitHub Actions runners.');
  assert.equal(env.REL_AI_RELEASE_INSTALL_TEST, '1', 'Set REL_AI_RELEASE_INSTALL_TEST=1 to opt in to installed release validation.');
  assert.ok(String(env.RUNNER_TEMP || '').trim(), 'RUNNER_TEMP is required for installed release validation.');
  assert.ok(String(env.GITHUB_REPOSITORY || '').includes('/'), 'GITHUB_REPOSITORY is required for previous-release lookup.');
}

async function validateWindowsLifecycle({ currentArtifact, currentVersion, previous }) {
  const runId = installerRunId(process.env);
  const testRoot = path.join(path.resolve(process.env.RUNNER_TEMP), `relai-release-install-${runId}`);
  const context = createInstallerTestContext(process.env, { runId, testRoot });
  try {
    let previousRoot = null;
    if (previous) {
      const previousInstaller = path.join(context.testRoot, previous.asset.name);
      await downloadReleaseAsset(previous.asset, previousInstaller, process.env.GITHUB_TOKEN);
      installWindowsPackage(previousInstaller);
      previousRoot = findInstalledWindowsRoot(previous.version);
      writeUpgradeSentinel();
      console.log(`Installed previous Windows release v${previous.version} from ${previous.asset.name}.`);
    }

    installWindowsPackage(currentArtifact, { updaterStyle: Boolean(previous) });
    const installedRoot = findInstalledWindowsRoot(currentVersion);
    if (previousRoot) {
      assert.equal(path.resolve(installedRoot), path.resolve(previousRoot), 'Windows upgrade installed side-by-side instead of replacing the existing application.');
      assertUpgradeSentinel();
      console.log(`Upgraded Windows installation in place from v${previous.version} to v${currentVersion}.`);
    } else {
      console.log(`No earlier matching Windows installer was published; validated fresh installation of v${currentVersion}.`);
    }
    verifyInstalledPackage(installedRoot, currentVersion);
    verifyInstalledConnector(installedRoot);
  } finally {
    if (fs.existsSync(context.testRoot)) removeOwnedTestRoot(context.testRoot, context.runId);
  }
}

async function validateLinuxLifecycle({ currentArtifact, currentVersion, previous }) {
  const packageName = String(electronPackage.build?.deb?.packageName || '').trim();
  assert.ok(packageName, 'electron/package.json must define build.deb.packageName.');
  assertLinuxPackageAbsent(packageName);
  const testRoot = path.join(path.resolve(process.env.RUNNER_TEMP), `relai-release-install-${installerRunId(process.env)}`);
  fs.mkdirSync(testRoot, { recursive: true });

  if (previous) {
    const previousDeb = path.join(testRoot, previous.asset.name);
    await downloadReleaseAsset(previous.asset, previousDeb, process.env.GITHUB_TOKEN);
    installLinuxPackage(previousDeb);
    verifyLinuxPackageVersion(packageName, previous.version);
    writeUpgradeSentinel();
    console.log(`Installed previous Linux DEB v${previous.version} from ${previous.asset.name}.`);
  }

  installLinuxPackage(currentArtifact);
  verifyLinuxPackageVersion(packageName, currentVersion);
  const installedRoot = findInstalledLinuxRoot(packageName);
  if (previous) {
    assertUpgradeSentinel();
    console.log(`Upgraded Linux DEB in place from v${previous.version} to v${currentVersion}.`);
  } else {
    console.log(`No earlier matching Linux DEB was published; validated fresh installation of v${currentVersion}.`);
  }
  verifyInstalledPackage(installedRoot, currentVersion);
  verifyLinuxUpdaterPackageType(installedRoot);
  verifyLinuxSandbox(installedRoot);
  verifyInstalledLinuxDesktop(installedRoot, testRoot);
  verifyInstalledConnector(installedRoot);
}

function installWindowsPackage(installer, options = {}) {
  const args = options.updaterStyle === true ? ['--updated', '/S'] : ['/S'];
  runChecked(installer, args, { timeoutMs: 180_000 });
}

function installLinuxPackage(deb) {
  runChecked('sudo', ['apt-get', 'install', '--yes', '--no-install-recommends', path.resolve(deb)], {
    timeoutMs: 240_000,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' }
  });
}

function findInstalledWindowsRoot(expectedVersion) {
  const programsRoot = path.join(String(process.env.LOCALAPPDATA || ''), 'Programs');
  assert.ok(fs.existsSync(programsRoot), `Windows Programs directory is missing after installation: ${programsRoot}`);
  const candidates = [];
  for (const entry of fs.readdirSync(programsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const applicationRoot = path.join(programsRoot, entry.name);
    const metadata = readPackagedMetadata(applicationRoot);
    if (metadata?.name === packageJson.name) candidates.push({ applicationRoot, metadata });
  }
  const match = candidates.find(candidate => candidate.metadata.version === expectedVersion);
  assert.ok(match, `Installed Windows application v${expectedVersion} was not found below ${programsRoot}.`);
  return match.applicationRoot;
}

function findInstalledLinuxRoot(packageName) {
  const result = runChecked('dpkg-query', ['-L', packageName]);
  const metadataPath = result.stdout.split(/\r?\n/).find(value => value.endsWith('/resources/package.json'));
  assert.ok(metadataPath, `Installed Linux package ${packageName} does not contain resources/package.json.`);
  return path.dirname(path.dirname(metadataPath));
}

function readPackagedMetadata(applicationRoot) {
  const metadataPath = path.join(applicationRoot, 'resources', 'package.json');
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {
    return null;
  }
}

function verifyInstalledPackage(applicationRoot, expectedVersion) {
  const metadata = readPackagedMetadata(applicationRoot);
  assert.equal(metadata?.name, packageJson.name, 'Installed application package identity does not match the release source.');
  assert.equal(metadata?.version, expectedVersion, 'Installed application version does not match the release artifact.');
  const executable = process.platform === 'win32'
    ? path.join(applicationRoot, `${electronPackage.build.productName}.exe`)
    : path.join(applicationRoot, electronPackage.build.linux.executableName);
  assert.ok(fs.existsSync(executable), `Installed application executable is missing: ${executable}`);
  const runtimeIcon = path.join(applicationRoot, 'resources', 'app-icon.png');
  assert.ok(fs.existsSync(runtimeIcon), `Installed application runtime icon is missing: ${runtimeIcon}`);
}

function verifyLinuxUpdaterPackageType(applicationRoot) {
  const packageTypePath = path.join(applicationRoot, 'resources', 'package-type');
  assert.ok(fs.existsSync(packageTypePath), `Installed DEB updater marker is missing: ${packageTypePath}`);
  assert.equal(fs.readFileSync(packageTypePath, 'utf8').trim(), 'deb',
    'Installed DEB must identify itself to electron-updater through resources/package-type.');
}

function verifyLinuxSandbox(applicationRoot) {
  const sandbox = path.join(applicationRoot, 'chrome-sandbox');
  assert.ok(fs.existsSync(sandbox), `Installed Chromium sandbox helper is missing: ${sandbox}`);
  const stat = fs.statSync(sandbox);
  assert.equal(
    isSecureLinuxSandboxConfiguration(stat),
    true,
    'Installed Chromium sandbox helper must be root-owned, executable, and not writable by group or other users.'
  );
}

function isSecureLinuxSandboxConfiguration(stat) {
  const mode = Number(stat?.mode || 0);
  return Number(stat?.uid) === 0
    && (mode & 0o111) !== 0
    && (mode & 0o022) === 0;
}

function verifyInstalledLinuxDesktop(applicationRoot, testRoot) {
  const executable = path.join(applicationRoot, electronPackage.build.linux.executableName);
  const stateDirectory = path.join(testRoot, 'installed-linux-smoke-state');
  fs.mkdirSync(stateDirectory, { recursive: true });
  const result = spawnSync('timeout', [
    '--signal=TERM',
    '--kill-after=5s',
    '15s',
    'xvfb-run',
    '--auto-servernum',
    executable,
    '--background'
  ], {
    cwd: applicationRoot,
    env: { ...process.env, REL_AI_MCP_STATE_DIR: stateDirectory },
    encoding: 'utf8',
    shell: false,
    timeout: 25_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw new Error(`Installed Linux desktop smoke test could not start: ${result.error.message}`, { cause: result.error });
  if (result.signal) throw new Error(`Installed Linux desktop smoke test was terminated by ${result.signal}.`);
  assert.ok(
    result.status === 0 || result.status === 124,
    `Installed Linux desktop failed to start with its packaged sandbox configuration (exit ${result.status}).\n${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim()
  );
}

function verifyInstalledConnector(applicationRoot) {
  runChecked(process.execPath, [path.join(root, 'scripts', 'packaged-connector-acceptance.mjs'), '--dir', applicationRoot], { timeoutMs: 120_000 });
}

function assertLinuxPackageAbsent(packageName) {
  const result = spawnSync('dpkg-query', ['-W', '-f=${Status}', packageName], { encoding: 'utf8', shell: false });
  assert.notEqual(result.status, 0, `Package ${packageName} is already installed; refusing lifecycle validation outside a clean runner.`);
}

function verifyLinuxPackageVersion(packageName, expectedVersion) {
  const result = runChecked('dpkg-query', ['-W', '-f=${Version}', packageName]);
  assert.equal(result.stdout.trim(), expectedVersion, `Installed DEB version must be ${expectedVersion}.`);
}

function upgradeSentinelPath() {
  const base = process.platform === 'win32'
    ? String(process.env.APPDATA || '')
    : path.join(String(process.env.HOME || ''), '.config');
  assert.ok(base, 'User configuration directory is unavailable.');
  return path.join(base, electronPackage.build.productName, 'release-upgrade-sentinel.json');
}

function writeUpgradeSentinel() {
  const file = upgradeSentinelPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ preserved: true, createdAt: new Date().toISOString() })}\n`);
}

function assertUpgradeSentinel() {
  const file = upgradeSentinelPath();
  assert.ok(fs.existsSync(file), `Upgrade removed user state: ${file}`);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).preserved, true, 'Upgrade modified the user-state preservation sentinel.');
}

async function findPreviousReleaseAsset({ repository, currentVersion, assetNameForVersion, token, fetchImpl = fetch, apiBase = process.env.GITHUB_API_URL || 'https://api.github.com' }) {
  const current = parseStableVersion(currentVersion);
  assert.ok(current, `Current release version must be stable semver: ${currentVersion}.`);
  const response = await fetchImpl(`${apiBase}/repos/${repository}/releases?per_page=50`, {
    headers: githubHeaders(token)
  });
  if (!response.ok) throw new Error(`GitHub releases lookup failed with HTTP ${response.status}.`);
  const releases = await response.json();
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter(release => !release?.draft && !release?.prerelease)
    .map(release => ({ release, version: parseStableVersion(release?.tag_name) }))
    .filter(item => item.version && compareStableVersions(item.version, current) < 0)
    .sort((a, b) => compareStableVersions(b.version, a.version));

  const previous = candidates[0];
  if (!previous) return null;
  const version = previous.version.join('.');
  const expectedName = assetNameForVersion(version);
  const asset = (previous.release.assets || []).find(item => item?.name === expectedName && item?.browser_download_url);
  assert.ok(asset, `Previous release v${version} is missing required upgrade artifact ${expectedName}; refusing to weaken upgrade coverage.`);
  return { version, asset };
}

async function downloadReleaseAsset(asset, destination, token) {
  const url = String(asset?.browser_download_url || '').trim();
  assert.ok(url, 'Previous release asset is missing a download URL.');
  const response = await fetch(url, { headers: githubHeaders(token), redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download previous release asset: HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyDownloadedAssetBytes(bytes, asset);
  fs.writeFileSync(destination, bytes);
}

function verifyDownloadedAssetBytes(bytes, asset) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0, 'Previous release asset download was empty.');
  const expectedSize = Number(asset?.size);
  if (Number.isSafeInteger(expectedSize) && expectedSize >= 0) {
    assert.equal(bytes.length, expectedSize, `Previous release asset size mismatch for ${asset?.name || 'asset'}.`);
  }
  const digest = String(asset?.digest || '').trim().toLowerCase();
  const match = digest.match(/^sha256:([a-f0-9]{64})$/);
  if (match) {
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, match[1], `Previous release asset SHA-256 mismatch for ${asset?.name || 'asset'}.`);
  }
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'rel-ai-mcp-release-validation',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

function parseStableVersion(value) {
  const version = String(value || '').trim().replace(/^v/, '');
  const parsed = semver.parse(version);
  if (!parsed || parsed.version !== version || parsed.prerelease.length > 0) return null;
  return [parsed.major, parsed.minor, parsed.patch];
}

function compareStableVersions(left, right) {
  return semver.compare(left.join('.'), right.join('.'));
}

function installerRunId(env) {
  const value = `${env.GITHUB_RUN_ID || ''}${env.GITHUB_RUN_ATTEMPT || ''}release`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  return value.length >= 6 ? value : `release${Date.now()}`.slice(0, 20);
}

function runChecked(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: root,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: options.timeoutMs || 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw new Error(`${path.basename(executable)} could not start: ${result.error.message}`, { cause: result.error });
  if (result.signal) throw new Error(`${path.basename(executable)} was terminated by ${result.signal}.`);
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed with exit code ${result.status}.\n${String(result.stdout || '')}\n${String(result.stderr || '')}`.trim());
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  assertDisposableReleaseRunner,
  compareStableVersions,
  findPreviousReleaseAsset,
  isSecureLinuxSandboxConfiguration,
  parseStableVersion,
  verifyDownloadedAssetBytes
};
