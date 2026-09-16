import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-release-workflow-'));

try {
  copyFixture();
  verifyReleaseBump();
  verifyPackageContracts();
  verifyWorkflowContracts();
  verifyTunnelClientTamperDetection();
  console.log('Cross-platform release workflow smoke test passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function copyFixture() {
  for (const relativePath of [
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'release-manifest.json',
    'electron/package.json',
    'electron/package-lock.json',
    'electron/build/installer-icon.ico',
    'electron/renderer/status.html',
    'electron/scripts/verify-fuses.js',
    'src/contracts/package.json',
    'src/core/package.json',
    'src/repository/intelligence/package.json',
    'src/ui/package.json',
    'src/packageMetadata.js',
    'src/version.js',
    'scripts/release-check.mjs',
    'scripts/platform-architecture.mjs',
    'scripts/release-bump.mjs',
    'scripts/release-surfaces.mjs',
    'scripts/check-generated.mjs',
    'scripts/electron-package.mjs',
    'scripts/electron-platform.mjs',
    'scripts/release-artifacts.mjs',
    'scripts/prepare-release-assets.mjs',
    'scripts/verify-updater-artifacts.mjs',
    'scripts/verify-fuses.mjs',
    'scripts/verify-macos-release.mjs',
    'scripts/current-unpacked.mjs',
    'scripts/active-controller-guard.mjs',
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml'
  ]) {
    const source = path.join(root, relativePath);
    const destination = path.join(tmp, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }

  const semverSource = path.join(root, 'node_modules', 'semver');
  const semverDestination = path.join(tmp, 'node_modules', 'semver');
  fs.mkdirSync(path.dirname(semverDestination), { recursive: true });
  fs.cpSync(semverSource, semverDestination, { recursive: true });

  const seedPath = path.join(tmp, 'vendor', 'tunnel-client', 'win32', 'tunnel-client.exe');
  const seedBytes = Buffer.alloc(5 * 1024 * 1024);
  fs.mkdirSync(path.dirname(seedPath), { recursive: true });
  fs.writeFileSync(seedPath, seedBytes);
  fs.writeFileSync(path.join(tmp, 'vendor', 'tunnel-client', 'manifest.json'), `${JSON.stringify({
    version: 'test',
    license: 'Apache-2.0',
    source: 'https://github.com/openai/tunnel-client',
    platforms: {
      win32: {
        file: 'tunnel-client.exe',
        size: seedBytes.length,
        sha256: crypto.createHash('sha256').update(seedBytes).digest('hex')
      }
    }
  }, null, 2)}\n`);
}

function verifyReleaseBump() {
  run('release-check.mjs');
  const changelogPath = path.join(tmp, 'CHANGELOG.md');
  fs.writeFileSync(changelogPath, fs.readFileSync(changelogPath, 'utf8').replace(/\r?\n/g, '\r\n'));
  const [major, minor, patch] = readJson('package.json').version.split('.').map(Number);
  const deferredVersion = `${major}.${minor}.${patch + 1}`;
  const changelogVersion = `${major}.${minor}.${patch + 2}`;

  run('release-bump.mjs', [deferredVersion, '--date', '2099-01-01', '--no-changelog']);
  assert.equal(readJson('release-manifest.json').applicationVersion, deferredVersion,
    'release manifest must follow the requested bump even when changelog insertion is intentionally deferred');
  assert.equal(fs.readFileSync(changelogPath, 'utf8').includes(`## [${deferredVersion}]`), false);

  run('release-bump.mjs', [
    changelogVersion,
    '--date', '2099-01-02',
    '--headline', 'Release workflow automation',
    '--note', 'Version files update together',
    '--note', 'Release consistency checks pass after the bump'
  ]);
  run('release-check.mjs');

  assert.equal(readJson('package.json').version, changelogVersion);
  const rootLock = readJson('package-lock.json');
  assert.equal(rootLock.packages[''].version, changelogVersion);
  for (const workspacePath of ['src/contracts', 'src/core', 'src/repository/intelligence', 'src/ui']) {
    assert.equal(readJson(`${workspacePath}/package.json`).version, changelogVersion);
    assert.equal(rootLock.packages[workspacePath].version, changelogVersion);
  }
  assert.equal(readJson('electron/package.json').version, changelogVersion);
  assert.equal(readJson('electron/package-lock.json').packages[''].version, changelogVersion);
  assert.equal(readJson('release-manifest.json').applicationVersion, changelogVersion);
  assert.ok(fs.readFileSync(changelogPath, 'utf8').includes(`## [${changelogVersion}] — 2099-01-02`));
}

function verifyPackageContracts() {
  const rootPackage = readJson('package.json');
  const electronPackage = readJson('electron/package.json');
  const electronLockRoot = readJson('electron/package-lock.json').packages?.[''] || {};
  assert.equal(rootPackage.productName, 'Rel.AI MCP');
  assert.deepEqual(rootPackage.author, { name: 'Kyne', url: 'https://github.com/Kyne0328' });
  assert.deepEqual(electronPackage.author, {
    name: 'Kyne',
    email: 'Kyne0328@users.noreply.github.com',
    url: 'https://github.com/Kyne0328'
  });
  assert.equal(electronPackage.homepage, 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness');
  assert.deepEqual(electronLockRoot.dependencies || {}, electronPackage.dependencies || {}, 'Electron runtime dependencies must stay synchronized with the lockfile');
  assert.deepEqual(electronLockRoot.devDependencies || {}, electronPackage.devDependencies || {}, 'Electron development dependencies must stay synchronized with the lockfile');
  assert.equal(rootPackage.allowScripts?.['node-pty@1.1.0'], true, 'root installs must explicitly approve the pinned node-pty native build under npm 12');
  assert.equal(electronPackage.allowScripts?.['node-pty@1.1.0'], true, 'Electron installs must explicitly approve the pinned node-pty native build under npm 12');
  assert.match(String(rootPackage.scripts.check || ''), /verify:node-pty[\s\S]*verify:generated/, 'the static parent gate must verify the native PTY runtime before generated assets');
  assert.match(String(rootPackage.scripts['test:all'] || ''), /npm run check[\s\S]*npm run test:security[\s\S]*npm run test:electron[\s\S]*npm run test:integration[\s\S]*npm run test:unit/, 'the aggregate source gate must preserve static, security, Electron, integration, and everyday regression parents');
  assert.match(String(rootPackage.scripts['test:integration'] || ''), /test:native-tasks-release-gate[\s\S]*run-repository-intelligence-tests\.mjs/, 'the integration parent must preserve native Tasks and Repository Intelligence coverage');
  assert.match(String(rootPackage.scripts['test:release'] || ''), /test:all[\s\S]*release-workflow-smoke\.mjs[\s\S]*knip:production[\s\S]*audit:production[\s\S]*audit:packaging/, 'the release source parent must preserve source, workflow, production reachability, and dependency audit gates');
  assert.doesNotMatch(String(rootPackage.scripts['test:release'] || ''), /release:check/, 'finalized release metadata belongs to the dedicated preflight gate and must not be rerun by the source release parent');
  assert.deepEqual(
    electronPackage.build.extraResources.find(resource => resource.to === 'src')?.filter,
    ['**/*.js', '**/*.ts', '**/*.ps1'],
    'Electron packaging must include JavaScript, TypeScript, and the Windows UI Automation PowerShell helper'
  );
  const packagedNodeModules = electronPackage.build.extraResources.find(resource => resource.to === 'node_modules')?.filter || [];
  assert.ok(packagedNodeModules.includes('yallist/**'), 'Electron packaging must include yallist because the bundled semver dependency resolves it through lru-cache at runtime');

  for (const name of ['electron:build', 'electron:build:linux', 'electron:build:mac', 'electron:dist', 'electron:dist:linux', 'electron:dist:mac']) {
    assert.match(String(rootPackage.scripts[name] || ''), /scripts\/electron-package\.mjs/, `${name} must use the shared cross-platform packager`);
  }
  for (const name of ['electron:size', 'electron:size:windows', 'electron:size:linux']) {
    const command = String(rootPackage.scripts[name] || '');
    assert.match(command, /scripts\/electron-package-size\.mjs/, `${name} must keep package-size reporting available`);
    assert.doesNotMatch(command, /--strict\b/, `${name} must not turn ordinary measured growth into a release blocker`);
  }
  assert.equal(rootPackage.scripts['test:installed'], undefined);
  assert.match(String(rootPackage.scripts['release:check'] || ''), /verify:generated[\s\S]*release-check\.mjs/, 'release preflight must reject stale generated assets before packaging starts');
  assert.match(String(rootPackage.scripts['build:frontend'] || ''), /vite build[\s\S]*write-dashboard-generated-manifest\.mjs/, 'normal frontend builds must use Vite and record generated-asset integrity');
  assert.match(String(rootPackage.scripts['dev:frontend'] || ''), /\bvite\b/, 'frontend development must expose Vite HMR');
  assert.equal(rootPackage.scripts['build:css'], undefined, 'the obsolete standalone CSS generator must be removed');
  assert.equal(rootPackage.scripts['build:js'], undefined, 'the obsolete standalone JavaScript generator must be removed');

  const generatedCheck = fs.readFileSync(path.join(tmp, 'scripts', 'check-generated.mjs'), 'utf8');
  assert.match(generatedCheck, /verifyDashboardGeneratedState/, 'generated-asset verification must use the platform-independent source and output integrity manifest');
  assert.doesNotMatch(generatedCheck, /mergeConfig|viteConfig|git\s+diff|runNpm/, 'generated-asset verification must not rebuild or repair tracked files before reporting staleness');

  assert.equal(electronPackage.build.electronUpdaterCompatibility, '>=2.16');
  assert.deepEqual(electronPackage.build.electronLanguages, ['en-US']);
  assert.deepEqual(electronPackage.build.win.target, ['nsis', 'portable']);
  assert.equal(electronPackage.build.win.icon, 'build/icon.png');
  assert.equal(electronPackage.build.nsis.installerIcon, 'build/installer-icon.ico');
  const installerIcon = fs.readFileSync(path.join(tmp, 'electron', electronPackage.build.nsis.installerIcon));
  assert.deepEqual([...installerIcon.subarray(0, 4)], [0, 0, 1, 0], 'the dedicated Windows installer icon must remain a valid ICO asset');
  assert.deepEqual(electronPackage.build.linux.target, ['AppImage', 'deb']);
  assert.deepEqual(electronPackage.build.mac.target, ['dmg']);
  assert.equal(electronPackage.build.mac.identity, null);
  assert.match(electronPackage.build.dmg.artifactName, /\$\{version\}[\s\S]*\$\{arch\}[\s\S]*\$\{ext\}/);
  assert.equal(electronPackage.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(electronPackage.build.linux.maintainer, 'Kyne <Kyne0328@users.noreply.github.com>');
  assert.equal(electronPackage.build.linux.executableName, 'rel-ai-mcp');
  assert.match(electronPackage.build.appImage.artifactName, /\$\{version\}[\s\S]*\$\{ext\}/);
  assert.match(electronPackage.build.deb.artifactName, /\$\{version\}[\s\S]*\$\{ext\}/);
  assert.deepEqual(
    electronPackage.build.win.extraResources.find(resource => resource.to === 'bin/tunnel-client')?.filter,
    ['manifest.json', 'win32/**']
  );
  assert.deepEqual(
    electronPackage.build.linux.extraResources.find(resource => resource.to === 'bin/tunnel-client')?.filter,
    ['manifest.json', 'linux/**']
  );

  const wrapper = fs.readFileSync(path.join(tmp, 'scripts', 'electron-package.mjs'), 'utf8');
  assert.doesNotMatch(wrapper, /npmCommand|npxCommand|npm\.cmd|npx\.cmd|shell:\s*true/i, 'packaging must remain shell-free');
  assert.doesNotMatch(wrapper, /quitAndInstall|Setup.*\.exe|uninstall/i, 'build orchestration must not execute installer lifecycle behavior');
  assert.match(wrapper, /ensureTunnelClient\(platform, targetArch\)/, 'packaging must provision its pinned tunnel-client dependency');
  assert.match(wrapper, /ensureZoekt\(platform, targetArch\)/, 'packaging must provision its pinned Zoekt dependency');
  const windowsPrebuildReuse = wrapper.match(/--config\.npmRebuild=false/g) || [];
  assert.equal(windowsPrebuildReuse.length, 2, 'Windows unpacked and release staging must reuse the pinned node-pty prebuild instead of requiring a local native rebuild');
  assert.match(wrapper, /codesign'[\s\S]*'--force'[\s\S]*'--deep'[\s\S]*'--sign'[\s\S]*'-'/,
    'macOS release packaging must apply an explicit ad-hoc signature before DMG creation');
  assert.match(wrapper, /codesign'[\s\S]*'--verify'[\s\S]*'--deep'[\s\S]*'--strict'[\s\S]*'--verbose=2'/,
    'macOS release packaging must structurally verify the ad-hoc signed app');
  assert.match(wrapper, /'--prepackaged',\s*appBundle/,
    'macOS DMG packaging must pass electron-builder the .app bundle itself, not its parent output directory');
}

function verifyWorkflowContracts() {
  const ciWorkflow = fs.readFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), 'utf8');
  const workflow = fs.readFileSync(path.join(tmp, '.github', 'workflows', 'release.yml'), 'utf8');
  const windowsCiStart = ciWorkflow.indexOf('packaged-windows:');
  const windowsCiEnd = ciWorkflow.indexOf('\n  packaged-linux:', windowsCiStart);
  const windowsCi = ciWorkflow.slice(windowsCiStart, windowsCiEnd);
  const linuxCiStart = ciWorkflow.indexOf('packaged-linux:');
  const linuxCi = ciWorkflow.slice(linuxCiStart);
  const windowsSourceGateIndex = windowsCi.indexOf('npm run test:all');
  const windowsPackageIndex = windowsCi.indexOf('npm run electron:build:windows');
  const linuxPackageIndex = linuxCi.indexOf('npm run electron:dist:linux');
  const linuxSizeIndex = linuxCi.indexOf('npm run electron:size:linux');
  const releaseSourceGateIndex = workflow.indexOf('npm run test:release');
  const windowsBuildIndex = workflow.indexOf('npm run electron:dist:windows');

  assert.ok(windowsCiStart >= 0 && windowsCiEnd > windowsCiStart, 'normal CI must keep a dedicated Windows packaging job');
  assert.ok(windowsSourceGateIndex >= 0, 'normal Windows CI must run the complete source gate before release/CD');
  assert.ok(windowsSourceGateIndex < windowsPackageIndex, 'normal Windows CI must fail source regressions before spending time packaging');
  assert.ok(linuxCiStart >= 0, 'normal CI must keep a dedicated Linux packaging job');
  assert.ok(linuxPackageIndex >= 0, 'normal Linux CI must build the release artifacts used by the package-size gate');
  assert.ok(linuxSizeIndex > linuxPackageIndex, 'normal Linux CI must enforce the release package-size guard after packaging');
  assert.ok(releaseSourceGateIndex >= 0);
  assert.ok(releaseSourceGateIndex < windowsBuildIndex);
  assert.doesNotMatch(workflow, /Install gateway test dependencies|gateway\/package\.json/i, 'public release workflow must not depend on the private gateway workspace');
  assert.doesNotMatch(workflow, /scripts\/fetch-(?:tunnel-client|zoekt)/, 'platform workflows must let the shared packager provision pinned runtime binaries');
  assert.match(workflow, /preflight:[\s\S]*Verify release consistency[\s\S]*npm run release:check/, 'release preflight must run generated-asset and version consistency checks before platform packaging jobs');

  for (const pattern of [
    /workflow_dispatch:/,
    /preflight:/,
    /windows:/,
    /linux:/,
    /mac:/,
    /publish:/,
    /needs:\s+preflight/,
    /needs:[\s\S]*- windows[\s\S]*- linux/,
    /publish=true/,
    /publish=false/,
    /recover_draft/,
    /release-response\.json[^\n]*\.draft|\.draft === true/,
    /Existing release \$VERSION targets \$release_target, not current release commit \$GITHUB_SHA/,
    /GitHub API returned HTTP \$http_status/,
    /curl --silent --show-error/,
    /npm run electron:dist:windows/,
    /npm run electron:dist:linux/,
    /runs-on: \$\{\{ matrix\.runner \}\}/,
    /arch: x64/,
    /arch: arm64/,
    /npm run electron:dist:mac/,
    /REL_AI_TARGET_ARCH: \$\{\{ matrix\.arch \}\}/,
    /npm run verify:packaged -- --platform win32/,
    /npm run verify:packaged -- --platform linux/,
    /verify-packaged-computer-runtime\.mjs --platform win32/,
    /verify-packaged-computer-runtime\.mjs --platform linux/,
    /verify-packaged-computer-runtime\.mjs --platform darwin/,
    /computer_runtime_args: --allow-headless/,
    /matrix\.computer_runtime_args/,
    /npm run verify:fuses -- --platform win32/,
    /npm run verify:fuses -- --platform linux/,
    /scripts\/smoke-linux-desktop\.sh/,
    /Smoke-test Linux desktop startup and shutdown under Xvfb/,
    /release-artifacts\.mjs --platform win32 --github-output paths/,
    /release-artifacts\.mjs --platform linux --github-output paths/,
    /release-artifacts\.mjs --platform darwin --arch '[^']+' --github-output paths/,
    /release-artifacts\.mjs --artifact linuxDeb --github-output deb/,
    /path: \$\{\{ steps\.release-artifacts\.outputs\.paths \}\}/,
    /windows-install-upgrade:/,
    /linux-install-upgrade:/,
    /validate-installed-release\.mjs/,
    /REL_AI_RELEASE_INSTALL_TEST:\s*'1'/,
    /REL_AI_INSTALLER_TEST_ISOLATED:\s*'1'/,
    /REL_AI_ALLOW_PRODUCTION_INSTALLER_TEST:\s*'1'/,
    /latest-linux\.yml/,
    /npm run electron:size:windows/,
    /npm run electron:size:linux/,
    /actions\/download-artifact@/,
    /merge-multiple: true/,
    /npm run prepare:release-assets/,
    /release-assets\.txt/,
    /SHA256SUMS\.txt/,
    /gh release upload "\$VERSION" "\$\{assets\[@\]\}" --repo "\$GITHUB_REPOSITORY" --clobber/,
    /release edit "\$VERSION"[\s\S]*--draft=false[\s\S]*--prerelease/,
    /actions\/attest-build-provenance@/,
    /actions\/attest-sbom@/,
    /dist\/\*\.AppImage/,
    /dist\/\*\.deb/,
    /dist\/\*\.dmg/,
    /CSC_IDENTITY_AUTO_DISCOVERY:\s*'false'/,
    /verify-macos-release\.mjs --unpacked/,
    /System Settings → Privacy & Security → Open Anyway/,
    /npm run test:frontend/,
    /npm run test:release/
  ]) assert.match(workflow, pattern);

  assert.doesNotMatch(workflow, /test:installed|REL_AI_SMOKE_INSTALLER|release-evidence-check|uninstall/i);
  assert.doesNotMatch(workflow, /electron-size-report(?:-linux)?\.json/, 'package-size budgets must be checked without generating disposable release report files');
  assert.doesNotMatch(workflow, /run:\s*npm run verify:color-tokens/, 'platform packaging jobs must rely on the shared packager color-token check instead of pre-running it');
  assert.doesNotMatch(workflow, /run:\s*node scripts\/verify-tunnel-client\.mjs/, 'platform release orchestration must rely on the shared packager provenance verification instead of rerunning it directly');
  assert.doesNotMatch(workflow, /status[^\n]*-ne 124|timeout --signal=TERM[^\n]*xvfb-run/, 'Linux smoke validation must not treat forced timeout as a successful shutdown.');
  const macVerifier = fs.readFileSync(path.join(tmp, 'scripts', 'verify-macos-release.mjs'), 'utf8');
  for (const pattern of [
    /hdiutil'[\s\S]*'verify'/,
    /hdiutil'[\s\S]*'attach'/,
    /codesign'[\s\S]*'--verify'[\s\S]*'--deep'[\s\S]*'--strict'[\s\S]*'--verbose=2'/,
    /Signature=adhoc/,
    /compareFrameworkSymlinks/,
    /packaged-connector-acceptance\.mjs/,
    /verify-packaged-wrapper\.mjs/,
    /verify-fuses\.mjs/
  ]) assert.match(macVerifier, pattern);
  assert.match(workflow, /publish:[\s\S]*needs:[\s\S]*- windows-install-upgrade[\s\S]*- linux-install-upgrade/,
    'publishing must wait for installed release lifecycle validation');
  assert.match(workflow, /release_draft[\s\S]*recover_draft=true[\s\S]*Recovering interrupted draft release/,
    'an interrupted draft release must remain recoverable instead of being mistaken for a completed publication');
  assert.match(workflow, /RECOVER_DRAFT:[\s\S]*gh release upload[\s\S]*--clobber[\s\S]*release edit[\s\S]*--draft=false[\s\S]*--prerelease/,
    'draft recovery must replace partial assets and publish the recovered release as a pre-release');
  assert.match(workflow, /release create "\$VERSION"[\s\S]*--prerelease/,
    'new automated releases must be published as pre-releases until manually promoted');
  assert.match(
    workflow,
    /linux-install-upgrade:[\s\S]*apt-get install --yes --no-install-recommends xvfb xauth[\s\S]*Validate fresh install and in-place upgrade/,
    'Linux installed-release validation must explicitly provision Xvfb and xauth on its fresh runner'
  );
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|upload-artifact|download-artifact|attest-build-provenance|attest-sbom)@v\d+/);

  const fuseWrapper = fs.readFileSync(path.join(tmp, 'scripts', 'verify-fuses.mjs'), 'utf8');
  assert.match(fuseWrapper, /process\.argv\.slice\(2\)/);
  assert.match(fuseWrapper, /allowBuildCheck: true, platform/);
}

function verifyTunnelClientTamperDetection() {
  const seedPath = path.join(tmp, 'vendor', 'tunnel-client', 'win32', 'tunnel-client.exe');
  const original = fs.readFileSync(seedPath);
  const tamperedBytes = Buffer.from(original);
  tamperedBytes[0] = 1;
  fs.writeFileSync(seedPath, tamperedBytes);
  const tampered = runWithEnv('release-check.mjs', { REL_AI_TARGET_PLATFORM: 'win32' });
  assert.notEqual(tampered.status, 0);
  assert.match(`${tampered.stdout}\n${tampered.stderr}`, /bundled OpenAI tunnel-client SHA-256 for win32/i);

  fs.writeFileSync(seedPath, original);
  fs.rmSync(seedPath, { force: true });
  const missing = runWithEnv('release-check.mjs', { REL_AI_TARGET_PLATFORM: 'win32' });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}\n${missing.stderr}`, /bundled OpenAI tunnel-client is missing for win32/i);

  // A normal source consistency check must not require ignored build-time binaries.
  // Packaging supplies REL_AI_TARGET_PLATFORM and performs the strict artifact check.
  run('release-check.mjs');
}

function run(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(tmp, 'scripts', script), ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, REL_AI_RELEASE_ROOT: tmp }
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
  }
  assert.equal(result.status, 0, `${script} ${args.join(' ')} should pass`);
  return result;
}

function runWithEnv(script, env = {}) {
  return spawnSync(process.execPath, [path.join(tmp, 'scripts', script)], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, REL_AI_RELEASE_ROOT: tmp, ...env }
  });
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(tmp, relativePath), 'utf8'));
}
