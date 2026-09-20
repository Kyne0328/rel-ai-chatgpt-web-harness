import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSafeControllerOperation } from './active-controller-guard.mjs';
import { electronPlatformSpec, normalizeElectronArch, normalizeElectronPlatform } from './electron-platform.mjs';
import { invalidateDerivedReleaseEvidence, releaseArtifactNames } from './release-artifacts.mjs';
import { writeWindowsUpdaterConfig } from './electron-updater-config.mjs';
import { assertInstalledElectronDependencies } from './electron-package-dependencies.mjs';
import { buildIdFromFingerprint, createBuildProvenance, readRepositoryBuildState } from '../src/buildProvenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRoot = path.join(root, 'electron');
const electronManifest = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package.json'), 'utf8'));
const electronLockfile = JSON.parse(fs.readFileSync(path.join(electronRoot, 'package-lock.json'), 'utf8'));
assertInstalledElectronDependencies({ electronRoot, manifest: electronManifest, lockfile: electronLockfile });
const RELEASE_ARCHIVE_COMPRESSION_LEVEL = '5';
const options = parseArgs(process.argv.slice(2));
const mode = options.mode;
if (!['unpacked', 'release'].includes(mode)) {
  throw new Error('Use --mode unpacked or --mode release.');
}

const platform = normalizeElectronPlatform(options.platform || 'win32');
const targetArch = normalizeElectronArch(process.env.REL_AI_TARGET_ARCH || process.arch);
const platformSpec = electronPlatformSpec(platform, targetArch);
assertSupportedBuildHost(platformSpec, targetArch);
const target = mode === 'release' ? path.join(root, 'dist') : path.join(root, 'dist', 'build-check');
const safetyTargets = mode === 'release' ? releaseOutputSafetyTargets(target, platformSpec) : [target];
assertSafeControllerOperation({ operation: 'package', targetPaths: safetyTargets });
assertSafeBuilderArgs(options.builderArgs);

const generateColorTokens = path.join(root, 'scripts', 'generate-color-tokens.mjs');
const generateUiContracts = path.join(root, 'scripts', 'generate-ui-contracts.mjs');
const writeDashboardGeneratedManifest = path.join(root, 'scripts', 'write-dashboard-generated-manifest.mjs');
const fetchTunnelClient = path.join(root, 'scripts', 'fetch-tunnel-client.mjs');
const verifyTunnelClient = path.join(root, 'scripts', 'verify-tunnel-client.mjs');
const verifyZoekt = path.join(root, 'scripts', 'verify-zoekt-seed.mjs');
const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const electronBuilderCli = packageBin(path.join(electronRoot, 'node_modules', 'electron-builder'), 'electron-builder');
const platformEnvironment = { ...process.env, REL_AI_TARGET_PLATFORM: platform, REL_AI_TARGET_ARCH: targetArch };

if (mode === 'unpacked') {
  runNode('unpacked output cleanup', path.join(root, 'scripts', 'clean.mjs'), ['--electron']);
}
runNode('color-token generation', generateColorTokens);
runNode('UI contract generation', generateUiContracts);
runNode('dashboard Vite build', viteCli, ['build']);
runNode('dashboard generated manifest', writeDashboardGeneratedManifest);
ensureTunnelClient(platform, targetArch);
runNode('OpenAI tunnel-client verification', verifyTunnelClient, [], { env: { ...platformEnvironment, TUNNEL_CLIENT_PLATFORMS: platform, REL_AI_TARGET_ARCH: targetArch } });
ensureZoekt(platform, targetArch);
runNode('Zoekt seed verification', verifyZoekt, [], { env: platformEnvironment });

const buildProvenance = await createBuildProvenance(root, { version: readVersion() });
const serializedBuildProvenance = JSON.stringify(buildProvenance);
platformEnvironment.REL_AI_BUILD_PROVENANCE = serializedBuildProvenance;
process.env.REL_AI_BUILD_PROVENANCE = serializedBuildProvenance;
console.log(`[electron-package] Build v${buildProvenance.version} (${buildIdFromFingerprint(buildProvenance.sourceFingerprint)})${buildProvenance.dirty ? ' with local changes' : ''}.`);

if (mode === 'unpacked') {
  runNode(`Electron ${platform} unpacked packaging`, electronBuilderCli, [
    platformSpec.builderFlag,
    ...architectureArgs(platformSpec),
    '--dir',
    '--config.npmRebuild=false',
    '--config.directories.output=../dist/build-check',
    '--publish', 'never',
    ...options.builderArgs
  ], { cwd: electronRoot, env: platformEnvironment });
  if (platformSpec.platform === 'win32') {
    const unpackedDirectory = path.join(target, platformSpec.unpackedDirectory);
    writeWindowsUpdaterConfig({ appDirectory: unpackedDirectory, manifest: electronManifest });
    assertWindowsUpdaterConfig(unpackedDirectory);
  }
  try {
    await assertBuildSourceUnchanged(buildProvenance);
  } catch (error) {
    removeDirectory(target);
    throw error;
  }
} else {
  await packageRelease(electronBuilderCli, options.builderArgs, platformSpec);
}

console.log(`Electron ${platform} ${mode} package completed without launching or installing the generated application.`);

async function packageRelease(electronBuilder, builderArgs, spec) {
  if (spec.platform === 'win32') {
    await packageWindowsRelease(electronBuilder, builderArgs, spec);
    return;
  }
  if (spec.platform === 'darwin') {
    await packageMacRelease(electronBuilder, builderArgs, spec);
    return;
  }
  await packageLinuxRelease(electronBuilder, builderArgs, spec);
}

async function packageWindowsRelease(electronBuilder, builderArgs, spec) {
  const releaseStartedAt = Date.now();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ai-mcp-windows-release-'));
  const stagingOutputArg = `--config.directories.output=${stagingRoot}`;
  const prepackaged = path.join(stagingRoot, spec.unpackedDirectory);
  const targetRoot = path.join(stagingRoot, '.artifact-targets');
  const portablePrepackaged = path.join(targetRoot, 'portable-win-unpacked');
  const nsisOutput = path.join(targetRoot, 'nsis-output');
  const portableOutput = path.join(targetRoot, 'portable-output');
  let completed = false;
  try {
    const stagingStartedAt = Date.now();
    runNode('Electron Windows release staging', electronBuilder, [
      spec.builderFlag,
      '--dir',
      '--config.npmRebuild=false',
      stagingOutputArg,
      '--publish', 'never',
      ...builderArgs
    ], { cwd: electronRoot, env: { ...process.env, REL_AI_TARGET_PLATFORM: spec.platform } });
    assertPrepackagedApp(prepackaged, spec);
    console.log(`[electron-package] Shared Windows unpacked application prepared in ${formatDuration(Date.now() - stagingStartedAt)}.`);

    const cloneStartedAt = Date.now();
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.cpSync(prepackaged, portablePrepackaged, { recursive: true, force: true, dereference: true });
    assertPrepackagedApp(portablePrepackaged, spec);
    writeWindowsUpdaterConfig({ appDirectory: prepackaged, manifest: electronManifest });
    assertWindowsUpdaterConfig(prepackaged);
    console.log(`[electron-package] Isolated portable working copy prepared in ${formatDuration(Date.now() - cloneStartedAt)}.`);

    const artifactStartedAt = Date.now();
    const artifactEnvironment = {
      ...process.env,
      REL_AI_TARGET_PLATFORM: spec.platform,
      ELECTRON_BUILDER_COMPRESSION_LEVEL: RELEASE_ARCHIVE_COMPRESSION_LEVEL
    };
    await Promise.all([
      runNodeAsync('NSIS artifact packaging', electronBuilder, [
        spec.builderFlag, 'nsis',
        '--prepackaged', prepackaged,
        `--config.directories.output=${nsisOutput}`,
        '--publish', 'never',
        ...builderArgs
      ], { cwd: electronRoot, env: artifactEnvironment }),
      runNodeAsync('portable artifact packaging', electronBuilder, [
        spec.builderFlag, 'portable',
        '--prepackaged', portablePrepackaged,
        `--config.directories.output=${portableOutput}`,
        '--publish', 'never',
        ...builderArgs
      ], { cwd: electronRoot, env: artifactEnvironment })
    ]);
    console.log(`[electron-package] NSIS and portable artifacts completed in parallel in ${formatDuration(Date.now() - artifactStartedAt)}.`);

    const version = readVersion();
    const canonical = releaseArtifactNames(version);
    const requiredArtifacts = [canonical.installer, canonical.portable, canonical.blockmap, canonical.metadata];
    collectArtifactFiles(nsisOutput, stagingRoot, [canonical.installer, canonical.blockmap, canonical.metadata]);
    collectArtifactFiles(portableOutput, stagingRoot, [canonical.portable]);
    removeDirectory(targetRoot);

    const promoted = await promoteReleaseOutput({
      stagingRoot,
      destinationRoot: path.join(root, 'dist'),
      spec,
      requiredArtifacts
    });
    console.log(`Current Windows unpacked application: ${path.relative(root, promoted.unpackedPath)}`);
    console.log(`[electron-package] Windows release packaging completed in ${formatDuration(Date.now() - releaseStartedAt)}.`);
    completed = true;
  } finally {
    finishStaging(stagingRoot, completed);
  }
}

async function packageLinuxRelease(electronBuilder, builderArgs, spec) {
  const releaseStartedAt = Date.now();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ai-mcp-linux-release-'));
  const stagingOutputArg = `--config.directories.output=${stagingRoot}`;
  const prepackaged = path.join(stagingRoot, spec.unpackedDirectory);
  const artifactOutput = path.join(stagingRoot, '.artifact-targets', 'linux-output');
  const environment = {
    ...process.env,
    REL_AI_TARGET_PLATFORM: spec.platform,
    ELECTRON_BUILDER_COMPRESSION_LEVEL: RELEASE_ARCHIVE_COMPRESSION_LEVEL
  };
  let completed = false;
  try {
    const stagingStartedAt = Date.now();
    runNode('Electron Linux release staging', electronBuilder, [
      spec.builderFlag,
      ...architectureArgs(spec),
      '--dir',
      stagingOutputArg,
      '--publish', 'never',
      ...builderArgs
    ], { cwd: electronRoot, env: environment });
    assertPrepackagedApp(prepackaged, spec);
    console.log(`[electron-package] Shared Linux unpacked application prepared in ${formatDuration(Date.now() - stagingStartedAt)}.`);

    const artifactStartedAt = Date.now();
    runNode('AppImage and DEB artifact packaging', electronBuilder, [
      spec.builderFlag, 'AppImage', 'deb',
      ...architectureArgs(spec),
      '--prepackaged', prepackaged,
      `--config.directories.output=${artifactOutput}`,
      '--publish', 'never',
      ...builderArgs
    ], { cwd: electronRoot, env: environment });
    console.log(`[electron-package] AppImage and DEB artifacts completed in ${formatDuration(Date.now() - artifactStartedAt)}.`);

    const version = readVersion();
    const canonical = releaseArtifactNames(version);
    const requiredArtifacts = [canonical.linuxAppImage, canonical.linuxDeb, canonical.linuxMetadata];
    collectArtifactFiles(artifactOutput, stagingRoot, requiredArtifacts);
    removeDirectory(path.join(stagingRoot, '.artifact-targets'));

    const promoted = await promoteReleaseOutput({
      stagingRoot,
      destinationRoot: path.join(root, 'dist'),
      spec,
      requiredArtifacts
    });
    console.log(`Current Linux unpacked application: ${path.relative(root, promoted.unpackedPath)}`);
    console.log(`[electron-package] Linux release packaging completed in ${formatDuration(Date.now() - releaseStartedAt)}.`);
    completed = true;
  } finally {
    finishStaging(stagingRoot, completed);
  }
}

async function packageMacRelease(electronBuilder, builderArgs, spec) {
  const releaseStartedAt = Date.now();
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rel-ai-mcp-macos-${targetArch}-release-`));
  const stagingOutputArg = `--config.directories.output=${stagingRoot}`;
  const prepackaged = path.join(stagingRoot, spec.unpackedDirectory);
  const artifactOutput = path.join(stagingRoot, '.artifact-targets', 'mac-output');
  // macOS releases intentionally avoid Developer ID discovery and notarization credentials.
  // electron/package.json keeps mac.identity=null; this wrapper applies a deterministic ad-hoc
  // signature to the completed .app before DMG creation so bundle integrity can be verified.
  const environment = {
    ...process.env,
    REL_AI_TARGET_PLATFORM: spec.platform,
    REL_AI_TARGET_ARCH: targetArch,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_COMPRESSION_LEVEL: RELEASE_ARCHIVE_COMPRESSION_LEVEL
  };
  let completed = false;
  try {
    const stagingStartedAt = Date.now();
    runNode('Electron macOS release staging', electronBuilder, [
      spec.builderFlag,
      ...architectureArgs(spec),
      '--dir',
      stagingOutputArg,
      '--publish', 'never',
      ...builderArgs
    ], { cwd: electronRoot, env: environment });
    assertPrepackagedApp(prepackaged, spec);
    const appBundle = path.join(prepackaged, spec.executableName.split('/Contents/MacOS/')[0]);
    runExecutable('macOS ad-hoc application signing', '/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle]);
    runExecutable('macOS ad-hoc application verification', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
    console.log(`[electron-package] Shared macOS ${targetArch} unpacked application prepared and ad-hoc signed in ${formatDuration(Date.now() - stagingStartedAt)}.`);

    const artifactStartedAt = Date.now();
    runNode('DMG artifact packaging', electronBuilder, [
      spec.builderFlag, 'dmg',
      ...architectureArgs(spec),
      '--prepackaged', appBundle,
      `--config.directories.output=${artifactOutput}`,
      '--publish', 'never',
      ...builderArgs
    ], { cwd: electronRoot, env: environment });
    console.log(`[electron-package] macOS ${targetArch} DMG completed in ${formatDuration(Date.now() - artifactStartedAt)}.`);

    const version = readVersion();
    const canonical = releaseArtifactNames(version);
    const dmg = targetArch === 'arm64' ? canonical.macDmgArm64 : canonical.macDmgX64;
    const requiredArtifacts = [dmg];
    collectArtifactFiles(artifactOutput, stagingRoot, requiredArtifacts);
    removeDirectory(path.join(stagingRoot, '.artifact-targets'));

    const promoted = await promoteReleaseOutput({
      stagingRoot,
      destinationRoot: path.join(root, 'dist'),
      spec,
      requiredArtifacts
    });
    console.log(`Current macOS ${targetArch} unpacked application: ${path.relative(root, promoted.unpackedPath)}`);
    console.log(`[electron-package] macOS ${targetArch} release packaging completed in ${formatDuration(Date.now() - releaseStartedAt)}.`);
    completed = true;
  } finally {
    finishStaging(stagingRoot, completed);
  }
}

function collectArtifactFiles(sourceDirectory, destinationDirectory, names) {
  for (const name of names) {
    const source = path.join(sourceDirectory, name);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`Artifact build did not produce ${name} in ${sourceDirectory}.`);
    }
    promoteFile(source, path.join(destinationDirectory, name));
  }
}

function releaseOutputSafetyTargets(destinationRoot, spec) {
  const canonical = releaseArtifactNames(readVersion());
  const canonicalNames = spec.platform === 'win32'
    ? [canonical.installer, canonical.portable, canonical.blockmap, canonical.metadata]
    : spec.platform === 'linux'
      ? [canonical.linuxAppImage, canonical.linuxDeb, canonical.linuxMetadata]
      : [targetArch === 'arm64' ? canonical.macDmgArm64 : canonical.macDmgX64];
  const targets = new Set([
    ...canonicalNames,
    canonical.checksums,
    canonical.sbom,
    'release-assets.txt',
    spec.markerName
  ].map(name => path.join(destinationRoot, name)));
  if (fs.existsSync(destinationRoot)) {
    for (const entry of fs.readdirSync(destinationRoot, { withFileTypes: true })) {
      if (entry.isFile() && isPlatformReleaseArtifact(entry.name, spec.platform)) {
        targets.add(path.join(destinationRoot, entry.name));
      }
    }
  }
  return [...targets];
}

async function promoteReleaseOutput({ stagingRoot, destinationRoot, spec, requiredArtifacts }) {
  await assertBuildSourceUnchanged(buildProvenance);
  const prepackaged = path.join(stagingRoot, spec.unpackedDirectory);
  assertPrepackagedApp(prepackaged, spec);
  const stagingFileEntries = fs.readdirSync(stagingRoot, { withFileTypes: true })
    .filter(entry => entry.isFile());
  const ignoredDiagnostics = stagingFileEntries
    .map(entry => entry.name)
    .filter(isBuilderDiagnosticArtifact);
  if (ignoredDiagnostics.length > 0) {
    console.log(`[electron-package] Ignored electron-builder diagnostics: ${ignoredDiagnostics.join(', ')}.`);
  }
  const artifactEntries = stagingFileEntries
    .filter(entry => requiredArtifacts.includes(entry.name));
  const artifactNames = new Set(artifactEntries.map(entry => entry.name));
  for (const required of requiredArtifacts) {
    if (!artifactNames.has(required)) {
      throw new Error(`Release staging is missing the canonical ${spec.platform} artifact ${required}.`);
    }
  }
  const unexpected = stagingFileEntries
    .map(entry => entry.name)
    .filter(name => isPlatformReleaseArtifact(name, spec.platform)
      && !isBuilderDiagnosticArtifact(name)
      && !requiredArtifacts.includes(name));
  if (unexpected.length > 0) {
    throw new Error(`Release staging contains unexpected ${spec.platform} artifacts: ${unexpected.join(', ')}.`);
  }

  const version = readVersion();
  const invalidatedEvidence = invalidateDerivedReleaseEvidence(destinationRoot, version);
  if (invalidatedEvidence.length > 0) {
    console.log(`Invalidated stale release evidence: ${invalidatedEvidence.join(', ')}`);
  }
  fs.mkdirSync(destinationRoot, { recursive: true });
  const incomingNames = new Set(artifactEntries.map(entry => entry.name));
  removeObsoleteReleaseArtifacts(destinationRoot, incomingNames, spec.platform);
  for (const entry of artifactEntries) {
    promoteFile(path.join(stagingRoot, entry.name), path.join(destinationRoot, entry.name));
  }

  const preferredUnpacked = path.join(destinationRoot, spec.unpackedDirectory);
  let unpackedPath = preferredUnpacked;
  try {
    assertSafeControllerOperation({ operation: 'package', targetPaths: [preferredUnpacked] });
    removeDirectory(preferredUnpacked);
  } catch (error) {
    const buildId = `${spec.platform}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    unpackedPath = path.join(destinationRoot, 'unpacked-builds', buildId);
    console.warn(`[electron-package] Existing dist/${spec.unpackedDirectory} is locked and was preserved. Current unpacked output will be written to ${path.relative(root, unpackedPath)}. ${messageOf(error)}`);
  }
  fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
  fs.cpSync(prepackaged, unpackedPath, {
    recursive: true,
    force: true,
    verbatimSymlinks: spec.platform === 'darwin'
  });

  const marker = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    platform: spec.platform,
    relativePath: path.relative(destinationRoot, unpackedPath).replaceAll('\\', '/'),
    preferredPathAvailable: unpackedPath === preferredUnpacked
  };
  writeJsonAtomic(path.join(destinationRoot, spec.markerName), marker);
  removeObsoleteUnpackedBuilds(path.join(destinationRoot, 'unpacked-builds'), unpackedPath, spec.platform);
  return { unpackedPath, artifactNames: [...incomingNames].sort() };
}

function removeObsoleteUnpackedBuilds(directory, currentPath, platform) {
  if (!fs.existsSync(directory)) return;
  const current = path.resolve(currentPath);
  const prefix = `${platform}-`;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const candidate = path.join(directory, entry.name);
    if (path.resolve(candidate) === current) continue;
    try {
      assertSafeControllerOperation({ operation: 'package', targetPaths: [candidate] });
      removeDirectory(candidate);
    } catch (error) {
      console.warn(`[electron-package] Obsolete unpacked output is still locked and was preserved: ${path.relative(root, candidate)}. ${messageOf(error)}`);
    }
  }
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch {}
}

function removeObsoleteReleaseArtifacts(directory, incomingNames, platform) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || incomingNames.has(entry.name)) continue;
    if (!isPlatformReleaseArtifact(entry.name, platform)) continue;
    fs.rmSync(path.join(directory, entry.name), { force: true, maxRetries: 5, retryDelay: 200 });
  }
}

function isBuilderDiagnosticArtifact(name) {
  return /^builder-(?:debug|effective-config)\.ya?ml$/i.test(name);
}

function isPlatformReleaseArtifact(name, platform) {
  if (platform === 'win32') {
    return /(?:\.exe|\.exe\.blockmap|^latest\.ya?ml$)/i.test(name) || isBuilderDiagnosticArtifact(name);
  }
  if (platform === 'darwin') {
    return new RegExp(`-mac-${targetArch}\\.dmg$`, 'i').test(name) || isBuilderDiagnosticArtifact(name);
  }
  return /(?:\.AppImage|\.deb|^latest-linux\.ya?ml$)/i.test(name) || isBuilderDiagnosticArtifact(name);
}

function promoteFile(source, destination) {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary);
  try {
    fs.rmSync(destination, { force: true, maxRetries: 5, retryDelay: 200 });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Could not promote release artifact ${path.basename(destination)}.`, { cause: error });
  }
}

function writeJsonAtomic(destination, value) {
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.rmSync(destination, { force: true, maxRetries: 5, retryDelay: 200 });
  fs.renameSync(temporary, destination);
}

function parseArgs(argv) {
  let mode = '';
  let platform = '';
  const builderArgs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--mode') mode = String(argv[++index] || '');
    else if (value === '--platform') platform = String(argv[++index] || '');
    else if (value === '--') builderArgs.push(...argv.slice(index + 1));
    else builderArgs.push(value);
  }
  return { mode, platform, builderArgs };
}

function assertSafeBuilderArgs(args) {
  const reserved = new Set([
    '--dir', '--prepackaged', '--pd', '--win', '--windows', '-w', '--mac', '--linux',
    '--x64', '--arm64', '--ia32', '--config.directories.output'
  ]);
  const conflict = args.find(value => reserved.has(String(value).split('=')[0]));
  if (conflict) throw new Error(`Builder argument ${conflict} is controlled by the guarded packaging workflow.`);
}

function assertSupportedBuildHost(spec, architecture) {
  if (process.platform !== spec.platform) {
    throw new Error(`${spec.platform} Electron packaging must run on a ${spec.platform} build host. Current host: ${process.platform}.`);
  }
  if (spec.platform !== 'darwin' && (process.arch !== 'x64' || architecture !== 'x64')) {
    throw new Error(`Rel.AI ${spec.platform} packaging currently supports x64 only. Host architecture: ${process.arch}; target: ${architecture}.`);
  }
}

function assertPrepackagedApp(directory, spec) {
  const executable = path.join(directory, spec.executableName);
  const resources = path.join(directory, spec.resourcesDirectory || 'resources');
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error(`Release staging did not produce ${executable}.`);
  }
  if (spec.platform !== 'win32' && (fs.statSync(executable).mode & 0o111) === 0) {
    throw new Error(`Release staging produced a non-executable ${spec.platform} binary: ${executable}.`);
  }
  if (!fs.existsSync(resources) || !fs.statSync(resources).isDirectory()) {
    throw new Error(`Release staging did not produce ${resources}.`);
  }
}

function assertWindowsUpdaterConfig(directory) {
  const updateConfig = path.join(directory, 'resources', 'app-update.yml');
  if (!fs.existsSync(updateConfig) || !fs.statSync(updateConfig).isFile()) {
    throw new Error(`Windows package staging is missing ${updateConfig}.`);
  }
}

function architectureArgs(spec) {
  if (spec.platform === 'linux') return ['--x64'];
  if (spec.platform === 'darwin') return [`--${targetArch}`];
  return [];
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

async function assertBuildSourceUnchanged(expected) {
  const current = await readRepositoryBuildState(root);
  if (current.sourceFingerprint === expected.sourceFingerprint) return;
  throw new Error('Rel.AI source changed while the Electron package was being built. Re-run the build so the package includes the current source.');
}

function ensureTunnelClient(targetPlatform, architecture) {
  const manifestPath = path.join(root, 'vendor', 'tunnel-client', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const platformManifest = manifest.platforms?.[targetPlatform];
  const spec = platformManifest?.architectures?.[architecture] || platformManifest;
  if (!spec?.file) throw new Error(`Unsupported tunnel-client platform/architecture: ${targetPlatform}/${architecture}`);
  const executable = path.join(root, 'vendor', 'tunnel-client', targetPlatform, spec.file);
  const valid = fs.existsSync(executable) && (() => {
    const stat = fs.statSync(executable);
    if (!stat.isFile() || stat.size !== Number(spec.size)) return false;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    return sha256 === String(spec.sha256).toLowerCase();
  })();
  if (valid) return;
  console.log(`[electron-package] OpenAI tunnel-client is missing or stale for ${targetPlatform}; fetching the pinned ${manifest.version} artifact.`);
  runNode('OpenAI tunnel-client fetch', fetchTunnelClient, [], {
    env: { ...platformEnvironment, TUNNEL_CLIENT_PLATFORMS: targetPlatform, REL_AI_TARGET_ARCH: architecture }
  });
}

function ensureZoekt(targetPlatform, architecture) {
  const manifestPath = path.join(root, 'vendor', 'zoekt', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const platformManifest = manifest.platforms?.[targetPlatform];
  const spec = platformManifest?.architectures?.[architecture] || platformManifest;
  if (!spec?.search?.file || !spec?.index?.file) {
    throw new Error(`Unsupported Zoekt platform/architecture: ${targetPlatform}/${architecture}`);
  }

  const valid = ['search', 'index'].every(key => {
    const artifact = spec[key];
    const file = path.join(root, 'vendor', 'zoekt', targetPlatform, artifact.file);
    if (!fs.existsSync(file) || fs.statSync(file).size !== Number(artifact.size)) return false;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return sha256 === String(artifact.sha256).toLowerCase();
  });
  if (valid) return;

  console.log(`[electron-package] Zoekt binaries are missing or stale for ${targetPlatform}/${architecture}; building the pinned ${manifest.upstream.commit} source.`);
  const env = { ...platformEnvironment, ZOEKT_PLATFORMS: targetPlatform, REL_AI_TARGET_ARCH: architecture };
  const command = process.platform === 'win32' ? 'pwsh' : 'bash';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-File', path.join(root, 'scripts', 'fetch-zoekt.ps1')]
    : [path.join(root, 'scripts', 'fetch-zoekt.sh')];
  runExecutable('Zoekt seed build', command, args, { env });
}

function packageBin(packageRoot, binName) {
  const manifestPath = path.join(packageRoot, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Required package is unavailable: ${path.relative(root, manifestPath)}. Run npm install in the appropriate package directory.`, { cause: error });
  }
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (!relativeBin) throw new Error(`${manifest.name || packageRoot} does not declare the ${binName} CLI.`);
  const cliPath = path.resolve(packageRoot, relativeBin);
  if (!fs.existsSync(cliPath)) throw new Error(`Required CLI is missing: ${path.relative(root, cliPath)}.`);
  return cliPath;
}

function removeDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  fs.rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 10 : 2,
    retryDelay: 250
  });
}

function runNode(label, script, args = [], options = {}) {
  runExecutable(label, process.execPath, [script, ...args], options);
}

function runExecutable(label, executable, args = [], options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`, { cause: result.error });
  if (result.signal) throw new Error(`${label} was terminated by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status || 1}.`);
}

function runNodeAsync(label, script, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd || root,
      env: options.env || process.env,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', error => reject(new Error(`${label} could not start: ${error.message}`, { cause: error })));
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${label} was terminated by ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${label} failed with exit code ${code || 1}.`));
        return;
      }
      resolve();
    });
  });
}

function finishStaging(stagingRoot, completed) {
  if (completed) {
    removeDirectory(stagingRoot);
  } else {
    console.error(`[electron-package] Release staging preserved for diagnostics: ${stagingRoot}`);
  }
}

function formatDuration(milliseconds) {
  return `${(Number(milliseconds) / 1000).toFixed(1)}s`;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}
