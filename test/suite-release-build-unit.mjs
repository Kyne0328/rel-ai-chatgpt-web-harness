// Consolidated release build coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly app-metadata-unit.mjs
async function case_app_metadata_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const __m4 = await import("../src/appMetadata.js");
    const { getApplicationMetadata } = __m4;
  
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  
  assert.deepEqual(getApplicationMetadata(), {
    name: 'Rel.AI MCP',
    version: rootPackage.version,
    developer: {
      name: 'Kyne',
      username: 'Kyne0328',
      profileUrl: 'https://github.com/Kyne0328'
    },
    repositoryUrl: 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness',
    license: rootPackage.license
  });
  assert.deepEqual(rootPackage.author, { name: 'Kyne', url: 'https://github.com/Kyne0328' });
  assert.deepEqual(electronPackage.author, {
    name: 'Kyne',
    email: 'Kyne0328@users.noreply.github.com',
    url: 'https://github.com/Kyne0328'
  });
  assert.equal(electronPackage.homepage, 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness');
  assert.equal(rootPackage.productName, 'Rel.AI MCP');
  assert.match(readme, /Created and maintained by <a href="https:\/\/github\.com\/Kyne0328"><strong>Kyne<\/strong><\/a>\./);
  assert.doesNotMatch(JSON.stringify(electronPackage), /Kyne Anthony/);
  
  console.log('Application metadata unit tests passed.');
}
await case_app_metadata_unit();

// Formerly build-provenance-unit.mjs
async function case_build_provenance_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("../src/buildProvenance.js");
    const { buildIdFromFingerprint, createBuildProvenance, normalizeBuildProvenance, readRepositoryBuildState } = __m5;
  
    const __m6 = await import("../electron/build-provenance.js");
    const { readBuildStatus } = __m6;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-build-provenance-'));
  const detachedResources = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-build-provenance-detached-'));
  
  try {
    git(['init', '--quiet']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'user.name', 'Rel.AI Test']);
    git(['config', 'core.autocrlf', 'false']);
    fs.writeFileSync(path.join(root, '.gitignore'), '/dist\n', 'utf8');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"rel-ai-mcp","version":"1.2.3"}\n', 'utf8');
    fs.writeFileSync(path.join(root, 'app.txt'), 'baseline\n', 'utf8');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'baseline']);
  
    const baseline = await readRepositoryBuildState(root);
    assert.equal(baseline.dirty, false);
    assert.match(baseline.sourceRevision, /^[a-f0-9]{40,64}$/);
    assert.match(baseline.sourceFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readRepositoryBuildState(root), baseline, 'unchanged source must keep the same fingerprint');
  
    const provenance = await createBuildProvenance(root, { version: '1.2.3', builtAt: '2026-09-15T12:00:00.000Z' });
    assert.equal(provenance.sourceFingerprint, baseline.sourceFingerprint);
    assert.equal(buildIdFromFingerprint(provenance.sourceFingerprint), baseline.sourceFingerprint.slice(0, 12));
    assert.equal(provenance.dirty, false);
    assert.deepEqual(normalizeBuildProvenance(provenance), provenance);
    assert.equal(normalizeBuildProvenance({ ...provenance, sourceFingerprint: 'bad' }), null);
  
    fs.writeFileSync(path.join(root, 'app.txt'), 'changed\n', 'utf8');
    const changed = await readRepositoryBuildState(root);
    assert.equal(changed.dirty, true);
    assert.notEqual(changed.sourceFingerprint, baseline.sourceFingerprint, 'tracked edits must invalidate a build');
  
    git(['add', 'app.txt']);
    const staged = await readRepositoryBuildState(root);
    assert.equal(staged.dirty, true);
    assert.notEqual(staged.sourceFingerprint, baseline.sourceFingerprint, 'staged edits must invalidate a build');
    assert.equal(staged.sourceFingerprint, changed.sourceFingerprint, 'staging the same file contents must not change build identity');
  
    git(['commit', '--quiet', '-m', 'same changed source']);
    const committed = await readRepositoryBuildState(root);
    assert.equal(committed.dirty, false);
    assert.equal(committed.sourceFingerprint, changed.sourceFingerprint, 'committing unchanged file contents must not change build identity');
    git(['reset', '--hard', '--quiet', 'HEAD^']);
    fs.writeFileSync(path.join(root, 'new-feature.txt'), 'untracked feature\n', 'utf8');
    const untracked = await readRepositoryBuildState(root);
    assert.equal(untracked.dirty, true);
    assert.notEqual(untracked.sourceFingerprint, baseline.sourceFingerprint, 'untracked source files must invalidate a build');
    fs.rmSync(path.join(root, 'new-feature.txt'));
    assert.equal((await readRepositoryBuildState(root)).sourceFingerprint, baseline.sourceFingerprint, 'restoring source must restore the fingerprint');
  
    const resources = path.join(root, 'dist', 'build-check', 'win-unpacked', 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, 'build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    const app = { isPackaged: true, getVersion: () => '1.2.3' };
    const buildStatus = readBuildStatus({ app, resourcesPath: resources });
    assert.equal(buildStatus.state, 'recorded');
    assert.equal(buildStatus.buildId, provenance.sourceFingerprint.slice(0, 12), 'packaged builds must expose a stable source-derived build ID');
  
    fs.writeFileSync(path.join(root, 'app.txt'), 'changed after build\n', 'utf8');
    assert.equal(readBuildStatus({ app, resourcesPath: resources }).buildId, buildStatus.buildId, 'a package keeps the identity of the source snapshot it was built from');
    git(['reset', '--hard', '--quiet', 'HEAD']);
  
    fs.writeFileSync(path.join(detachedResources, 'build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
    assert.equal(readBuildStatus({ app, resourcesPath: detachedResources }).buildId, buildStatus.buildId, 'installed builds must expose the same build ID without needing a source checkout');
    assert.equal(readBuildStatus({ app: { isPackaged: false } }).state, 'development');
  
    console.log('Build provenance and package identity tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(detachedResources, { recursive: true, force: true });
  }
  
  function git(args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  }
}
await case_build_provenance_unit();

// Formerly core-runtime-boundary-unit.mjs
async function case_core_runtime_boundary_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/core/runtime.ts");
    const { createRelaiCoreRuntime } = __m4;
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-core-runtime-'));
  const stateDir = path.join(temp, 'state');
  const workspacePath = path.join(temp, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const config = {
    version: 3,
    stateDir,
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    workspaces: {
      repo: { path: workspacePath, commands: {}, testCommands: {} }
    }
  };
  
  try {
    const runtime = createRelaiCoreRuntime({ config });
    const firstStart = runtime.start();
    assert.equal(firstStart.config, config);
    assert.equal(firstStart.isolated, false);
    assert.equal(firstStart.state.ok, true);
    assert.equal(runtime.start(), firstStart, 'core runtime startup must be idempotent');
  
    const firstShutdown = runtime.shutdown();
    assert.equal(runtime.shutdown(), firstShutdown, 'core runtime shutdown must be idempotent');
    const cleanup = await firstShutdown;
    assert.equal(cleanup.clean, true, JSON.stringify(cleanup));
    assert.equal(cleanup.managedProcesses.orphaned, 0, JSON.stringify(cleanup));
    assert.equal(cleanup.repositoryIntelligence.closed, true, JSON.stringify(cleanup));
    assert.deepEqual(cleanup.errors, []);
  
    const isolatedRuntime = createRelaiCoreRuntime({ config, isolated: true });
    assert.equal(isolatedRuntime.start().isolated, true);
    const isolatedCleanup = await isolatedRuntime.shutdown();
    assert.equal(isolatedCleanup.clean, true);
    assert.equal(isolatedCleanup.managedProcesses.skipped, true);
    assert.equal(isolatedCleanup.repositoryIntelligence.skipped, true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('Rel.AI core runtime starts and shuts down without Electron dependencies.');
}
await case_core_runtime_boundary_unit();

// Formerly generated-assets-check-unit.mjs
async function case_generated_assets_check_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("node:url");
    const { fileURLToPath } = __m5;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const checker = path.join(root, 'scripts', 'check-generated.mjs');
  const sourcePublic = path.join(root, 'public');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-generated-assets-check-'));
  const testPublic = path.join(tempRoot, 'public');
  const dashboardCss = path.join(testPublic, 'dashboard.css');
  const dashboardReact = path.join(testPublic, 'dashboard-react.js');
  const dashboardManifest = path.join(testPublic, 'dashboard-generated-manifest.json');
  const dashboardChunks = path.join(testPublic, 'dashboard-chunks');
  const staleChunkProbe = path.join(dashboardChunks, 'intentional-stale-generated-probe.js');
  
  copyGeneratedAssets(sourcePublic, testPublic);
  const originalCss = fs.readFileSync(dashboardCss);
  const originalReact = fs.readFileSync(dashboardReact);
  const originalManifest = fs.readFileSync(dashboardManifest);
  
  function runCheck(publicRoot = '') {
    return spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: publicRoot
        ? { ...process.env, REL_AI_GENERATED_PUBLIC_ROOT: publicRoot }
        : process.env
    });
  }
  
  function copyGeneratedAssets(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of ['dashboard-app.js', 'dashboard-react.js', 'dashboard.css', 'dashboard-generated-manifest.json']) {
      fs.copyFileSync(path.join(from, name), path.join(to, name));
    }
    for (const name of ['dashboard-chunks', 'dashboard-assets']) {
      const source = path.join(from, name);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(to, name), { recursive: true });
    }
  }
  
  try {
    const fresh = runCheck();
    assert.equal(fresh.status, 0, fresh.stderr || fresh.stdout);
  
    const isolatedFresh = runCheck(testPublic);
    assert.equal(isolatedFresh.status, 0, isolatedFresh.stderr || isolatedFresh.stdout);
    assert.deepEqual(fs.readFileSync(dashboardCss), originalCss, 'verification must not rewrite fresh generated CSS');
    assert.deepEqual(fs.readFileSync(dashboardReact), originalReact, 'verification must not rewrite the fresh React bundle');
  
    const staleManifest = JSON.parse(originalManifest.toString('utf8'));
    staleManifest.sourceHash = '0'.repeat(64);
    fs.writeFileSync(dashboardManifest, `${JSON.stringify(staleManifest, null, 2)}\n`);
    const staleSourceCheck = runCheck(testPublic);
    assert.notEqual(staleSourceCheck.status, 0, 'a source fingerprint mismatch must fail generated-asset verification');
    assert.match(`${staleSourceCheck.stdout}\n${staleSourceCheck.stderr}`, /Generated dashboard assets are stale/i);
    fs.writeFileSync(dashboardManifest, originalManifest);
  
    const staleCss = Buffer.concat([originalCss, Buffer.from('\n/* intentional stale dashboard probe */\n')]);
    fs.writeFileSync(dashboardCss, staleCss);
    const staleCssCheck = runCheck(testPublic);
    assert.notEqual(staleCssCheck.status, 0, 'stale dashboard CSS must fail generated-asset verification');
    assert.match(`${staleCssCheck.stdout}\n${staleCssCheck.stderr}`, /Generated dashboard assets are stale/i);
    assert.deepEqual(fs.readFileSync(dashboardCss), staleCss, 'verification must report stale CSS without repairing it');
    fs.writeFileSync(dashboardCss, originalCss);
  
    const staleReact = Buffer.concat([originalReact, Buffer.from('\n// intentional stale React bundle probe\n')]);
    fs.writeFileSync(dashboardReact, staleReact);
    const staleReactCheck = runCheck(testPublic);
    assert.notEqual(staleReactCheck.status, 0, 'stale dashboard React JS must fail generated-asset verification');
    assert.match(`${staleReactCheck.stdout}\n${staleReactCheck.stderr}`, /Generated dashboard assets are stale/i);
    assert.deepEqual(fs.readFileSync(dashboardReact), staleReact, 'verification must report stale React JS without repairing it');
    fs.writeFileSync(dashboardReact, originalReact);
  
    fs.mkdirSync(dashboardChunks, { recursive: true });
    fs.writeFileSync(staleChunkProbe, 'export const stale = true;\n');
    const staleChunkCheck = runCheck(testPublic);
    assert.notEqual(staleChunkCheck.status, 0, 'unexpected dashboard chunks must fail generated-asset verification');
    assert.match(`${staleChunkCheck.stdout}\n${staleChunkCheck.stderr}`, /Generated dashboard assets are stale/i);
    assert.equal(fs.existsSync(staleChunkProbe), true, 'verification must report stale chunks without repairing them');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  
  console.log('Generated dashboard verification is deterministic and non-destructive.');
}
await case_generated_assets_check_unit();

// Formerly installer-test-safety-unit.mjs
async function case_installer_test_safety_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../scripts/installer-test-safety.mjs");
    const { PRODUCTION_APP_ID,
    TEST_APP_ID_PREFIX,
    assertOwnedTestRoot,
    assertPathInside,
    assertSafeTestRoot,
    createInstallerTestContext,
    detectProductionInstallation,
    removeOwnedTestRoot } = __m4;
  
  assert.throws(() => createInstallerTestContext({}, { runId: 'abcdef' }), /REL_AI_INSTALLER_TEST_ISOLATED/);
  assert.throws(() => assertSafeTestRoot(''), /empty/);
  assert.throws(() => assertSafeTestRoot(path.parse(process.cwd()).root), /Filesystem roots/);
  assert.throws(() => assertSafeTestRoot(os.homedir()), /home directory/);
  assert.throws(() => assertPathInside(process.cwd(), process.cwd()), /must be a child/);
  assert.throws(() => assertPathInside(path.dirname(process.cwd()), process.cwd()), /must be a child/);
  
  const fakeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-production-detection-'));
  const fakeLocalAppData = path.join(fakeProfile, 'LocalAppData');
  const fakeProductionInstall = path.join(fakeLocalAppData, 'Programs', 'rel-ai-mcp');
  fs.mkdirSync(fakeProductionInstall, { recursive: true });
  const productionDetection = detectProductionInstallation({ LOCALAPPDATA: fakeLocalAppData });
  assert.equal(productionDetection.installed, true);
  assert.ok(productionDetection.existingPaths.includes(path.resolve(fakeProductionInstall)));
  assert.throws(() => createInstallerTestContext({
    REL_AI_INSTALLER_TEST_ISOLATED: '1',
    LOCALAPPDATA: fakeLocalAppData
  }, { runId: 'prod5678', testRoot: path.join(fakeProfile, 'test-root') }), /Production Rel\.AI MCP installation detected/);
  fs.rmSync(fakeProfile, { recursive: true, force: true });
  
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-installer-safety-unit-'));
  const rootA = path.join(parent, 'run-a');
  const rootB = path.join(parent, 'run-b');
  const contextA = createInstallerTestContext({ REL_AI_INSTALLER_TEST_ISOLATED: '1' }, { runId: 'runa1234', testRoot: rootA });
  const contextB = createInstallerTestContext({ REL_AI_INSTALLER_TEST_ISOLATED: '1' }, { runId: 'runb1234', testRoot: rootB });
  
  assert.notEqual(contextA.appId, PRODUCTION_APP_ID);
  assert.ok(contextA.appId.startsWith(TEST_APP_ID_PREFIX));
  assert.notEqual(contextA.appId, contextB.appId);
  assertOwnedTestRoot(rootA, contextA.runId);
  assert.throws(() => assertOwnedTestRoot(rootA, contextB.runId), /another run/);
  assert.throws(() => createInstallerTestContext({
    REL_AI_INSTALLER_TEST_ISOLATED: '1',
    REL_AI_ALLOW_PRODUCTION_INSTALLER_TEST: '1'
  }, { runId: 'prod1234', testRoot: path.join(parent, 'prod') }), /GitHub Actions/);
  
  removeOwnedTestRoot(rootA, contextA.runId);
  assert.equal(fs.existsSync(rootA), false);
  assert.equal(fs.existsSync(rootB), true, 'cleanup from one run must not remove another run');
  removeOwnedTestRoot(rootB, contextB.runId);
  fs.rmSync(parent, { recursive: true, force: true });
  
  console.log('Installer test safety unit tests passed.');
}
await case_installer_test_safety_unit();

// Formerly knip-production-model-unit.mjs
async function case_knip_production_model_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("node:url");
    const { fileURLToPath } = __m5;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'knip.production.json'), 'utf8'));
  const dependencyModel = fs.readFileSync(path.join(root, 'scripts', 'knip-production-runtime.mjs'), 'utf8');
  const rootEntries = config.workspaces['.'].entry;
  const electronEntries = config.workspaces.electron.entry;
  assert.ok(rootEntries.includes('scripts/knip-production-runtime.mjs!'), 'packaged runtime dependency model must be a production entry');
  assert.ok(rootEntries.includes('bin/**/*.js!'), 'CLI and stdio entry points must be modeled');
  assert.ok(rootEntries.includes('src/httpServer.ts!'), 'Electron dynamic backend imports must be modeled explicitly');
  assert.ok(rootEntries.includes('src/config.js!'), 'Electron dynamic config imports must be modeled explicitly');
  assert.ok(rootEntries.includes('public/dashboard.js!'), 'packaged dashboard runtime must start from its real entry point');
  assert.equal(rootEntries.includes('src/**/*.js!'), false, 'production analysis must not mark every backend module as an entry');
  assert.equal(rootEntries.includes('public/**/*.js!'), false, 'production analysis must not mark every dashboard module as an entry');
  assert.deepEqual(electronEntries, [
    'main.js!',
    'preload.cjs!',
    'service-process.js!',
    'renderer/status.js!',
    'renderer/wizard.js!',
    'build/after-pack.js!',
    'scripts/verify-fuses.js!'
  ], 'Electron production analysis must model concrete runtime and packaging entry points');
  for (const dependency of [
    '@modelcontextprotocol/node',
    '@modelcontextprotocol/server',
    '@opentelemetry/api',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/semantic-conventions'
  ]) assert.ok(dependencyModel.includes(`'${dependency}'`), `dependency model must include ${dependency}`);
  
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-knip-production-'));
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'unused-production-dependency-fixture',
      private: true,
      type: 'module',
      dependencies: { 'unused-production-fixture': '1.0.0' }
    }, null, 2));
    fs.writeFileSync(path.join(fixture, 'index.js'), 'console.log("fixture");\n');
    fs.writeFileSync(path.join(fixture, 'knip.json'), JSON.stringify({
      entry: ['index.js!'],
      project: ['index.js!']
    }, null, 2));
    const cli = path.join(root, 'node_modules', 'knip', 'bin', 'knip.js');
    const result = spawnSync(process.execPath, [cli, '--directory', fixture, '--production', '--dependencies'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true
    });
    assert.notEqual(result.status, 0, 'an intentionally unused production dependency fixture must fail');
    assert.match(`${result.stdout}\n${result.stderr}`, /unused-production-fixture/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  
  console.log('Production Knip models shipped runtimes and rejects an unused production dependency fixture.');
}
await case_knip_production_model_unit();

// Formerly package-size-policy-unit.mjs
async function case_package_size_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../scripts/electron-package-size.mjs");
    const { compareMetrics, parseArguments } = __m1;
  
  assert.deepEqual(parseArguments(['--dir', 'dist', '--platform', 'linux']), {
    distDir: 'dist',
    platform: 'linux',
    baselinePath: '',
    jsonPath: ''
  });
  assert.throws(() => parseArguments(['--strict']), /ordinary package-size drift is advisory/);
  
  const baseline = {
    policy: 'advisory',
    tolerancePercent: 3,
    blockingGrowthPercent: 25,
    blockingMetrics: ['installerBytes'],
    metrics: { installerBytes: 100 }
  };
  const withinTolerance = compareMetrics({ installerBytes: 102 }, baseline)[0];
  assert.equal(withinTolerance.exceedsTolerance, false);
  assert.equal(withinTolerance.exceedsBlockingGrowth, false);
  
  const ordinaryGrowth = compareMetrics({ installerBytes: 110 }, baseline)[0];
  assert.equal(ordinaryGrowth.exceedsTolerance, true, 'normal package growth should be reported');
  assert.equal(ordinaryGrowth.exceedsBlockingGrowth, false, 'normal package growth must not block a release');
  
  const exceptionalGrowth = compareMetrics({ installerBytes: 130 }, baseline)[0];
  assert.equal(exceptionalGrowth.exceedsTolerance, true);
  assert.equal(exceptionalGrowth.exceedsBlockingGrowth, true, 'an exceptional jump remains a sanity guard for accidental payload growth');
  
  const mixedBaseline = {
    policy: 'advisory',
    tolerancePercent: 5,
    blockingGrowthPercent: 25,
    blockingMetrics: ['appImageBytes', 'unpackedBytes', 'resourcesBytes'],
    metrics: {
      appImageBytes: 1000,
      unpackedBytes: 3000,
      resourcesBytes: 1500,
      appAsarBytes: 100,
      packagedDependencyBytes: 10
    }
  };
  const componentDrift = compareMetrics({
    appImageBytes: 1006,
    unpackedBytes: 3018,
    resourcesBytes: 1519,
    appAsarBytes: 128,
    packagedDependencyBytes: 34
  }, mixedBaseline);
  assert.equal(componentDrift.find(item => item.metric === 'appAsarBytes').deltaPercent.toFixed(2), '28.00');
  assert.equal(componentDrift.find(item => item.metric === 'appAsarBytes').exceedsBlockingGrowth, false,
    'a small ASAR bucket crossing 25% must remain diagnostic when the release footprint is stable');
  assert.equal(componentDrift.find(item => item.metric === 'packagedDependencyBytes').deltaPercent, 240);
  assert.equal(componentDrift.find(item => item.metric === 'packagedDependencyBytes').exceedsBlockingGrowth, false,
    'a small dependency bucket can have a large relative percentage without becoming a release blocker');
  assert.equal(componentDrift.some(item => item.exceedsBlockingGrowth), false,
    'component-only percentage drift must not fail a release whose aggregate footprint is stable');
  
  const aggregateExplosion = compareMetrics({ ...mixedBaseline.metrics, appImageBytes: 1300 }, mixedBaseline)
    .find(item => item.metric === 'appImageBytes');
  assert.equal(aggregateExplosion.blocksRelease, true);
  assert.equal(aggregateExplosion.exceedsBlockingGrowth, true,
    'a 30% jump in an aggregate release artifact must still block release for investigation');
  
  console.log('Package-size policy reports ordinary growth and blocks only exceptional growth or structural packaging errors.');
}
await case_package_size_policy_unit();

// Formerly packaged-runtime-dependencies-unit.mjs
async function case_packaged_runtime_dependencies_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath, pathToFileURL } = __m3;
  
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-packaged-dependencies-'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'electron/package.json'), 'utf8'));
  const filters = manifest.build.extraResources.find(resource => resource.to === 'node_modules').filter;
  const copied = new Set();
  
  function copyDependency(name) {
    if (copied.has(name)) return;
    copied.add(name);
    const source = path.join(repo, 'node_modules', name);
    const metadata = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    fs.cpSync(source, path.join(staging, 'node_modules', name), {
      recursive: true,
      filter: candidate => {
        if (fs.statSync(candidate).isDirectory()) return true;
        const relative = path.relative(path.join(repo, 'node_modules'), candidate).replaceAll('\\', '/');
        return filters.some(pattern => !pattern.startsWith('!') && path.matchesGlob(relative, pattern))
          && !filters.some(pattern => pattern.startsWith('!') && path.matchesGlob(relative, pattern.slice(1)));
      }
    });
    for (const dependency of Object.keys(metadata.dependencies || {})) copyDependency(dependency);
  }
  
  try {
    for (const name of ['ajv', 'piscina', 'vscode-jsonrpc']) copyDependency(name);
    const probe = path.join(staging, 'probe.mjs');
    const worker = path.join(staging, 'worker.mjs');
    fs.writeFileSync(worker, 'export default value => value + 1;');
    fs.writeFileSync(probe, `
    const __m4 = await import("node:assert/strict");
    const assert = __m4.default;
  
    const __m5 = await import("ajv/dist/ajv.js");
    const Ajv = __m5.default;
  
    const __m6 = await import("piscina");
    const Piscina = __m6.default;
  
    const __m7 = await import("vscode-jsonrpc/node");
    const { createMessageConnection } = __m7;
  
    const __m8 = await import("node:url");
    const { fileURLToPath } = __m8;
  
  const validate = new Ajv().compile({ type: 'integer' });
  assert.equal(validate(1), true);
  assert.equal(validate('1'), false);
  assert.equal(typeof createMessageConnection, 'function');
  const pool = new Piscina({ filename: fileURLToPath(new URL('./worker.mjs', import.meta.url)), minThreads: 1, maxThreads: 1 });
  try {
    assert.equal(await pool.run(41), 42);
  } finally {
    await pool.destroy();
  }
  `);
    await import(`${pathToFileURL(probe).href}?packagedDependencyProbe=${Date.now()}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  
  console.log('Packaged validation, repository worker, and JSON-RPC dependencies passed.');
}
await case_packaged_runtime_dependencies_unit();

// Formerly packaging-audit-policy-unit.mjs
async function case_packaging_audit_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../scripts/audit-packaging.mjs");
    const { evaluatePackagingAudit, isTransientPackagingAuditFailure } = __m1;
  
  const cleanReport = {
    metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
    vulnerabilities: {}
  };
  assert.deepEqual(evaluatePackagingAudit({ report: cleanReport }), {
    accepted: true,
    vulnerabilityCount: 0,
    packages: []
  });
  
  const moderateOnly = {
    metadata: { vulnerabilities: { low: 0, moderate: 1, high: 0, critical: 0, total: 1 } },
    vulnerabilities: {
      example: { severity: 'moderate' }
    }
  };
  assert.doesNotThrow(() => evaluatePackagingAudit({ report: moderateOnly }), 'the release gate is explicitly high-severity and above');
  
  const highReport = {
    metadata: { vulnerabilities: { low: 0, moderate: 0, high: 1, critical: 0, total: 1 } },
    vulnerabilities: {
      'build-tool': { severity: 'high' }
    }
  };
  assert.throws(() => evaluatePackagingAudit({ report: highReport }), /1 high.*build-tool/i);
  
  const criticalReport = {
    metadata: { vulnerabilities: { low: 0, moderate: 0, high: 0, critical: 1, total: 1 } },
    vulnerabilities: {
      'critical-build-tool': { severity: 'critical' }
    }
  };
  assert.throws(() => evaluatePackagingAudit({ report: criticalReport }), /1 critical.*critical-build-tool/i);
  assert.equal(isTransientPackagingAuditFailure({ stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk' }), true);
  assert.equal(isTransientPackagingAuditFailure({ stdout: JSON.stringify(highReport) }), false, 'real audit findings must not be classified as registry outages');
  
  console.log('Packaging audit blocks confirmed high/critical findings and distinguishes advisory-service outages.');
}
await case_packaging_audit_policy_unit();

// Formerly release-distribution-unit.mjs
async function case_release_distribution_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("node:url");
    const { fileURLToPath } = __m5;
  
    const __m6 = await import("../scripts/electron-package-dependencies.mjs");
    const { assertInstalledElectronDependencies } = __m6;
  
    const __m7 = await import("../scripts/release-artifacts.mjs");
    const { platformReleaseArtifactNames, releaseArtifactNames } = __m7;
  
    const __m8 = await import("../scripts/generate-sbom.mjs");
    const { nativeReleaseComponents } = __m8;
  
    const __m9 = await import("../scripts/validate-installed-release.mjs");
    const { assertDisposableReleaseRunner, findPreviousReleaseAsset, parseStableVersion, verifyDownloadedAssetBytes } = __m9;
  
    const __m10 = await import("../scripts/release-surfaces.mjs");
    const { RELEASE_CHANGE_FILES } = __m10;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
  
  verifyDependencyGuard();
  verifyNodePtyNativeGuard();
  verifyReleaseSurfaces();
  verifyReleaseMetadataSynchronization();
  verifyReleaseWorkflowPreflight();
  verifyArtifactResolution();
  verifyNativeSbomCoverage();
  await verifyInstalledReleaseSafety();
  
  console.log('Release and distribution regression tests passed.');
  
  function verifyDependencyGuard() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-electron-deps-'));
    try {
      const manifest = {
        dependencies: { 'runtime-package': '^1.0.0' },
        devDependencies: { '@scope/build-package': '~2.0.0' }
      };
      const lockfile = {
        packages: {
          '': {
            dependencies: { 'runtime-package': '^1.0.0' },
            devDependencies: { '@scope/build-package': '~2.0.0' }
          },
          'node_modules/runtime-package': { version: '1.4.2' },
          'node_modules/@scope/build-package': { version: '2.0.5' }
        }
      };
  
      writeInstalledPackage(temp, 'runtime-package', '1.4.2');
      writeInstalledPackage(temp, '@scope/build-package', '2.0.5');
      assert.deepEqual(assertInstalledElectronDependencies({ electronRoot: temp, manifest, lockfile }), { checked: 2 });
  
      writeInstalledPackage(temp, 'runtime-package', '1.4.1');
      assert.throws(
        () => assertInstalledElectronDependencies({ electronRoot: temp, manifest, lockfile }),
        /runtime-package: installed 1\.4\.1, lockfile resolves 1\.4\.2/
      );
  
      writeInstalledPackage(temp, 'runtime-package', '1.4.2');
      lockfile.packages[''].dependencies['runtime-package'] = '^9.0.0';
      assert.throws(
        () => assertInstalledElectronDependencies({ electronRoot: temp, manifest, lockfile }),
        /runtime-package: electron\/package\.json requests \^1\.0\.0, but electron\/package-lock\.json records \^9\.0\.0/
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  
  function verifyNodePtyNativeGuard() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-electron-node-pty-'));
    try {
      const manifest = { dependencies: { 'node-pty': '1.1.0' } };
      const lockfile = {
        packages: {
          '': { dependencies: { 'node-pty': '1.1.0' } },
          'node_modules/node-pty': { version: '1.1.0' }
        }
      };
      writeInstalledPackage(temp, 'node-pty', '1.1.0');
      assert.throws(
        () => assertInstalledElectronDependencies({ electronRoot: temp, manifest, lockfile }),
        /node-pty's native runtime is unavailable/i,
        'packaging must reject a node-pty package whose native addon was never built'
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  
  function verifyReleaseSurfaces() {
    assert.ok(RELEASE_CHANGE_FILES.includes('release-manifest.json'), 'release finalization must accept generated release metadata');
    assert.ok(RELEASE_CHANGE_FILES.includes('CHANGELOG.md'), 'release finalization must accept changelog updates');
  }
  
  function verifyReleaseMetadataSynchronization() {
    const bump = read('scripts/release-bump.mjs');
    const check = read('scripts/release-check.mjs');
    const finalize = read('scripts/release-finalize.mjs');
    assert.match(bump, /runtimeMetadata\(\)/, 'release bump must derive compatibility metadata from the current runtime contract');
    assert.match(bump, /manifestHash/, 'release bump must synchronize the public tool-manifest hash');
    assert.match(check, /VERSION_JSON_FILES/, 'release consistency must use the canonical version surface list');
    assert.match(finalize, /isReleaseChangeFile/, 'release finalization must use the canonical release surface list');
  }
  
  function verifyReleaseWorkflowPreflight() {
    const workflow = read('.github/workflows/release.yml');
    const consistencyIndex = workflow.indexOf('npm run release:check');
    const firstPackageIndex = Math.min(
      ...['npm run electron:dist:windows', 'npm run electron:dist:linux', 'npm run electron:dist:mac']
        .map(command => workflow.indexOf(command))
        .filter(index => index >= 0)
    );
    assert.ok(consistencyIndex >= 0 && consistencyIndex < firstPackageIndex,
      'release consistency must fail before platform packaging starts');
    assert.match(workflow, /Recovering unpublished release from existing tag/,
      'an interrupted publish must be recoverable when the existing tag points to the same commit');
    assert.match(workflow, /git rev-list -n 1/);
    assert.match(workflow, /Existing tag \$VERSION points to \$tag_commit, not current release commit \$GITHUB_SHA/,
      'tag recovery must fail closed when the tag points at another commit');
  }
  
  function verifyArtifactResolution() {
    const electronPackage = JSON.parse(read('electron/package.json'));
    const customPackage = structuredClone(electronPackage);
    customPackage.build.nsis.artifactName = 'Setup-${version}.${ext}';
    customPackage.build.portable.artifactName = 'Portable-${version}.${ext}';
    customPackage.build.appImage.artifactName = 'Linux-${version}.${ext}';
    customPackage.build.deb.artifactName = 'Debian-${version}.${ext}';
    customPackage.build.dmg.artifactName = 'Mac-${version}-${arch}.${ext}';
  
    const names = releaseArtifactNames('9.8.7', { electronPackage: customPackage });
    assert.equal(names.installer, 'Setup-9.8.7.exe');
    assert.equal(names.portable, 'Portable-9.8.7.exe');
    assert.equal(names.linuxAppImage, 'Linux-9.8.7.AppImage');
    assert.equal(names.linuxDeb, 'Debian-9.8.7.deb');
    assert.equal(names.macDmgArm64, 'Mac-9.8.7-arm64.dmg');
    assert.deepEqual(platformReleaseArtifactNames('9.8.7', 'win32', 'x64', { electronPackage: customPackage }), [
      names.installer, names.portable, names.blockmap, names.metadata, names.sbom
    ]);
    assert.deepEqual(platformReleaseArtifactNames('9.8.7', 'linux', 'x64', { electronPackage: customPackage }), [
      names.linuxAppImage, names.linuxDeb, names.linuxMetadata
    ]);
  }
  
  function verifyNativeSbomCoverage() {
    const tunnelManifest = JSON.parse(read('vendor/tunnel-client/manifest.json'));
    const zoektManifest = JSON.parse(read('vendor/zoekt/manifest.json'));
    const components = nativeReleaseComponents(tunnelManifest, zoektManifest);
    assert.equal(components.length, 12, 'SBOM must include every shipped tunnel-client and Zoekt platform artifact');
    assert.equal(new Set(components.map(component => component['bom-ref'])).size, components.length, 'native SBOM references must be unique');
    assert.equal(components.filter(component => component.name === 'OpenAI tunnel-client').length, 4);
    assert.equal(components.filter(component => component.name === 'Zoekt search').length, 4);
    assert.equal(components.filter(component => component.name === 'Zoekt index').length, 4);
    assert.ok(components.every(component => component.hashes?.[0]?.alg === 'SHA-256' && /^[a-f0-9]{64}$/.test(component.hashes[0].content)),
      'every pinned native release component must carry its manifest SHA-256');
  }
  
  async function verifyInstalledReleaseSafety() {
    assert.deepEqual(parseStableVersion('v1.2.3'), [1, 2, 3]);
    assert.equal(parseStableVersion('1.2.3-beta.1'), null);
    assert.throws(() => assertDisposableReleaseRunner({}), /disposable GitHub Actions runners/);
  
    await assert.rejects(() => findPreviousReleaseAsset({
      repository: 'owner/repo',
      currentVersion: '2.0.0',
      assetNameForVersion: version => `Setup-${version}.exe`,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { tag_name: '2.0.0', draft: false, prerelease: false, assets: [{ name: 'Setup-2.0.0.exe', browser_download_url: 'current' }] },
          { tag_name: '1.9.0', draft: false, prerelease: false, assets: [{ name: 'wrong.exe', browser_download_url: 'wrong' }] },
          { tag_name: '1.8.0', draft: false, prerelease: false, assets: [{ name: 'Setup-1.8.0.exe', browser_download_url: 'older' }] }
        ]
      })
    }), /Previous release v1\.9\.0 is missing required upgrade artifact Setup-1\.9\.0\.exe/);
  
    const previous = await findPreviousReleaseAsset({
      repository: 'owner/repo',
      currentVersion: '2.0.0',
      assetNameForVersion: version => `Setup-${version}.exe`,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { tag_name: '1.9.0', draft: false, prerelease: false, assets: [{ name: 'Setup-1.9.0.exe', browser_download_url: 'previous' }] }
        ]
      })
    });
    assert.equal(previous?.version, '1.9.0');
    assert.equal(previous?.asset?.browser_download_url, 'previous');
  
    const bytes = Buffer.from('release-asset');
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    verifyDownloadedAssetBytes(bytes, { name: 'artifact.exe', size: bytes.length, digest });
    assert.throws(() => verifyDownloadedAssetBytes(bytes, { name: 'artifact.exe', size: bytes.length + 1, digest }), /size mismatch/);
    assert.throws(() => verifyDownloadedAssetBytes(bytes, { name: 'artifact.exe', size: bytes.length, digest: `sha256:${'0'.repeat(64)}` }), /SHA-256 mismatch/);
  }
  
  function writeInstalledPackage(electronRoot, name, version) {
    const directory = path.join(electronRoot, 'node_modules', ...name.split('/'));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  }
}
await case_release_distribution_unit();

// Formerly update-available-modal-unit.mjs
async function case_update_available_modal_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
    const __m4 = await import("../src/ui/update-available-modal.js");
    const { availableUpdateModalView, installingUpdateModalView, supportPolicyModalView } = __m4;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'src', 'ui', 'update-available-modal.js'), 'utf8');
  
  const recommendedPolicy = { state: 'recommended', currentVersion: '0.25.0', minimumRecommendedVersion: '0.26.0', minimumSupportedVersion: '0.25.0', canContinue: true };
  const deprecatedPolicy = { state: 'deprecated', currentVersion: '0.24.9', minimumRecommendedVersion: '0.25.0', minimumSupportedVersion: '0.25.0', enforceAfter: '2026-09-01T00:00:00.000Z', canContinue: true };
  const requiredPolicy = { ...deprecatedPolicy, state: 'required', canContinue: false, requiresUpdate: true };
  const emergencyPolicy = { ...requiredPolicy, state: 'emergency_blocked' };
  
  assert.equal(supportPolicyModalView({ state: 'current' }), null);
  assert.equal(supportPolicyModalView({ state: 'unavailable' }), null);
  assert.equal(supportPolicyModalView(recommendedPolicy), null, 'recommended updates should stay passive instead of opening a modal');
  assert.equal(supportPolicyModalView(deprecatedPolicy).allowLater, true);
  assert.match(supportPolicyModalView(deprecatedPolicy).description, /September|2026|before/i);
  assert.equal(supportPolicyModalView(requiredPolicy).blocking, true);
  assert.equal(supportPolicyModalView(requiredPolicy).allowLater, false);
  assert.match(supportPolicyModalView(emergencyPolicy).title, /critical/i);
  
  assert.equal(availableUpdateModalView({ state: 'idle', availableVersion: '0.27.5' }), null);
  assert.equal(availableUpdateModalView({ state: 'available' }), null);
  const available = availableUpdateModalView({ state: 'available', availableVersion: '0.27.5' });
  assert.equal(available.title, 'Update available');
  assert.equal(available.allowLater, true);
  assert.equal(available.blocking, false);
  assert.match(available.description, /v0\.27\.5/);
  assert.match(available.detail, /later launch/i);
  const installing = installingUpdateModalView({ state: 'installing', availableVersion: '0.27.5' });
  assert.equal(installing.blocking, true);
  assert.equal(installing.allowLater, false);
  assert.match(installing.title, /Updating Rel\.AI/i);
  assert.match(installing.detail, /temporarily paused/i);
  
  assert.doesNotMatch(source, /Ignore this version/, 'routine updates must not add permanent per-version ignore state');
  assert.doesNotMatch(source, /getNotificationPreferences|setNotificationPreferences/, 'update modals must not depend on notification preferences');
  assert.match(source, /supportPolicyModalView/, 'required and support-policy update notices must remain available');
  assert.match(source, /shownUpdateKeys\.has\(updateView\.key\)/, 'routine update notices must deduplicate the offered version for the current launch');
  assert.match(source, /shownPolicyKeys[\s\S]*availableUpdateModalView/, 'support-policy notices must retain priority over routine optional update notices');
  const actionsStart = source.indexOf("h('div', { className: 'modal-actions' }");
  const laterAction = source.indexOf("'Later'", actionsStart);
  const primaryAction = source.indexOf('\n      primary', actionsStart);
  assert.ok(actionsStart >= 0 && laterAction > actionsStart && primaryAction > laterAction, 'Later must remain before the primary update action');
  assert.match(source, /keepModalOpen = method === 'installUpdate'/, 'installing must keep the blocking update modal visible while preparation runs');
  assert.match(source, /role: 'status'[\s\S]*'aria-live': 'polite'[\s\S]*'aria-busy': 'true'/, 'install progress must be announced accessibly');
  assert.match(source, /install-failed:/, 'failed update preparation must keep a retryable in-app recovery modal');
  
  console.log('Update available and support-policy modal interaction tests passed.');
}
await case_update_available_modal_unit();

// Formerly update-install-marker-unit.mjs
async function case_update_install_marker_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/update-install-marker.js");
    const { STALE_UPDATE_MARKER_MS,
    clearUpdateInstallMarker,
    createUpdateInstallMarker,
    readUpdateInstallMarker,
    updateInstallLaunchGuard,
    updateInstallMarkerPath } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-update-marker-'));
  const app = { getPath: name => {
    assert.equal(name, 'userData');
    return root;
  } };
  
  try {
    assert.equal(readUpdateInstallMarker(app), null);
    assert.equal(updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: [] }).blocked, false);
  
    const created = await createUpdateInstallMarker(app, { targetVersion: 'v1.1.0' });
    assert.equal(created.targetVersion, '1.1.0');
    assert.equal(fs.existsSync(updateInstallMarkerPath(app)), true);
  
    const blocked = updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: [] });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'update_in_progress');
    assert.equal(blocked.marker.targetVersion, '1.1.0');
  
    const nonWindows = updateInstallLaunchGuard(app, { platform: 'linux', packaged: true, argv: [] });
    assert.equal(nonWindows.blocked, false);
    assert.equal(fs.existsSync(updateInstallMarkerPath(app)), true, 'non-Windows startup must not consume a Windows update marker');
  
    const updatedLaunch = updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: ['--updated'] });
    assert.equal(updatedLaunch.blocked, false);
    assert.equal(updatedLaunch.reason, 'updated_launch');
    assert.equal(fs.existsSync(updateInstallMarkerPath(app)), false, 'the installer-launched replacement app must clear the marker');
  
    await createUpdateInstallMarker(app, { targetVersion: '1.1.1' });
    const marker = readUpdateInstallMarker(app);
    const staleNow = Date.parse(marker.startedAt) + STALE_UPDATE_MARKER_MS + 1;
    const stale = updateInstallLaunchGuard(app, { platform: 'win32', packaged: true, argv: [], nowMs: staleNow });
    assert.equal(stale.blocked, false);
    assert.equal(stale.reason, 'stale_marker');
    assert.equal(fs.existsSync(updateInstallMarkerPath(app)), false, 'a stale marker must not permanently lock users out of Rel.AI');
  
    fs.writeFileSync(updateInstallMarkerPath(app), '{not-json', 'utf8');
    assert.equal(readUpdateInstallMarker(app), null);
    assert.equal(fs.existsSync(updateInstallMarkerPath(app)), false, 'corrupt update state must fail open after being discarded');
  
    await createUpdateInstallMarker(app, { targetVersion: '1.1.2' });
    assert.equal(await clearUpdateInstallMarker(app), true);
    assert.equal(await clearUpdateInstallMarker(app), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Windows update-install marker guard tests passed.');
}
await case_update_install_marker_unit();

// Formerly updater-artifact-contract-unit.mjs
async function case_updater_artifact_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("../scripts/release-artifacts.mjs");
    const { invalidateDerivedReleaseEvidence, releaseArtifactNames } = __m5;
  
    const __m6 = await import("../scripts/verify-updater-artifacts.mjs");
    const { verifyPlatformUpdaterArtifacts, verifyUpdaterArtifacts } = __m6;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-updater-contract-'));
  const installer = 'Rel.AI-MCP-Setup-9.8.7.exe';
  const metadata = 'latest.yml';
  const checksums = 'SHA256SUMS.txt';
  const list = path.join(root, 'release-assets.txt');
  const bytes = Buffer.from('canonical installer bytes');
  
  function writeFixture({ listedInstaller = installer, metadataInstaller = installer, sha512Bytes = bytes, includeBlockmap = true, includeChecksum = true } = {}) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, listedInstaller), bytes);
    if (includeBlockmap) fs.writeFileSync(path.join(root, `${listedInstaller}.blockmap`), 'blockmap');
    const sha512 = crypto.createHash('sha512').update(sha512Bytes).digest('base64');
    fs.writeFileSync(path.join(root, metadata), `version: 9.8.7\nfiles:\n  - url: ${metadataInstaller}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${metadataInstaller}\nsha512: ${sha512}\n`);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(root, checksums), includeChecksum ? `${sha256}  ${listedInstaller}\n` : '');
    fs.writeFileSync(list, [listedInstaller, `${listedInstaller}.blockmap`, metadata, checksums].join('\n'));
  }
  
  const options = { directory: root, assetList: list, metadata, checksums };
  try {
    writeFixture();
    const report = verifyUpdaterArtifacts(options);
    assert.deepEqual(report.referencedArtifacts, [installer]);
  
    writeFixture({ listedInstaller: 'renamed-installer.exe' });
    assert.throws(() => verifyUpdaterArtifacts(options), /exact basename/,
      'same bytes under a different filename must fail');
  
    writeFixture({ sha512Bytes: Buffer.from('different bytes') });
    assert.throws(() => verifyUpdaterArtifacts(options), /SHA-512 mismatch/);
  
    writeFixture({ includeBlockmap: false });
    assert.throws(() => verifyUpdaterArtifacts(options), /blockmap is missing/i);
    assert.deepEqual(verifyUpdaterArtifacts({ ...options, requireBlockmaps: false }).referencedArtifacts, [installer]);
  
    writeFixture({ includeChecksum: false });
    assert.throws(() => verifyUpdaterArtifacts(options), /does not include/);
  
    const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const canonicalNames = releaseArtifactNames(packageJson.version);
    const canonicalBytes = Buffer.from('platform-local canonical updater bytes');
    const canonicalSha512 = crypto.createHash('sha512').update(canonicalBytes).digest('base64');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, canonicalNames.installer), canonicalBytes);
    fs.writeFileSync(path.join(root, canonicalNames.blockmap), 'blockmap');
    fs.writeFileSync(path.join(root, canonicalNames.metadata), `version: ${packageJson.version}\nfiles:\n  - url: ${canonicalNames.installer}\n    sha512: ${canonicalSha512}\n    size: ${canonicalBytes.length}\npath: ${canonicalNames.installer}\nsha512: ${canonicalSha512}\n`);
    assert.deepEqual(verifyPlatformUpdaterArtifacts({ directory: root, platform: 'win32' }).referencedArtifacts, [canonicalNames.installer],
      'platform-local Windows verification must validate updater metadata directly without a combined release asset list');
    fs.rmSync(path.join(root, canonicalNames.blockmap));
    assert.throws(() => verifyPlatformUpdaterArtifacts({ directory: root, platform: 'win32' }), /blockmap is missing/i);
  
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, canonicalNames.linuxAppImage), canonicalBytes);
    fs.writeFileSync(path.join(root, canonicalNames.linuxMetadata), `version: ${packageJson.version}\nfiles:\n  - url: ${canonicalNames.linuxAppImage}\n    sha512: ${canonicalSha512}\n    size: ${canonicalBytes.length}\npath: ${canonicalNames.linuxAppImage}\nsha512: ${canonicalSha512}\n`);
    assert.deepEqual(verifyPlatformUpdaterArtifacts({ directory: root, platform: 'linux' }).referencedArtifacts, [canonicalNames.linuxAppImage],
      'platform-local Linux verification must validate updater metadata directly without unrelated platform bundles');
  
    writeFixture();
    fs.writeFileSync(path.join(root, 'sbom.cdx.json'), '{}\n');
    const invalidated = invalidateDerivedReleaseEvidence(root, '9.8.7').sort();
    assert.deepEqual(invalidated, [
      'SHA256SUMS.txt',
      'release-assets.txt',
      'sbom.cdx.json'
    ]);
    assert.equal(fs.existsSync(path.join(root, installer)), true);
    assert.equal(fs.existsSync(path.join(root, metadata)), true);
    assert.equal(fs.existsSync(path.join(root, checksums)), false);
    assert.equal(fs.existsSync(list), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Updater artifact exact-name and checksum contract tests passed.');
}
await case_updater_artifact_contract_unit();

// Formerly verify-fuses-arguments-unit.mjs
async function case_verify_fuses_arguments_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'scripts', 'verify-fuses.mjs'), 'utf8');
  
  assert.match(source, /process\.argv\.slice\(2\)/, 'fuse wrapper must preserve explicit release-workflow arguments');
  assert.match(source, /args\[0\]/, 'fuse wrapper must preserve an explicit executable path after platform parsing');
  assert.match(source, /allowBuildCheck: true, platform/, 'local fuse verification must resolve the platform-specific current unpacked or build-check package');
  assert.match(source, /electron[\\', ]+scripts[\\', ]+verify-fuses\.js/, 'wrapper must delegate policy verification to the exact-binary verifier');
  
  console.log('Electron fuse verification wrapper argument and current-build resolution contracts passed.');
}
await case_verify_fuses_arguments_unit();

// Formerly verify-packaged-arguments-unit.mjs
async function case_verify_packaged_arguments_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:path");
    const path = __m1.default;
  
    const __m2 = await import("../scripts/packaged-directory.mjs");
    const { parsePackagedDirectoryArgument, resolvePackagedDirectory } = __m2;
  
  const cases = [
    'C:\\Users\\Kyne\\Rel.AI MCP',
    'C:\\Users\\Kyne\\Rel.AI MCP Ω',
    'D:\\RelAI',
    'C:\\Program Files\\Rel.AI MCP',
    'C:\\RelAI'
  ];
  for (const directory of cases) {
    assert.equal(parsePackagedDirectoryArgument(['--dir', directory]), directory);
    assert.equal(resolvePackagedDirectory('C:\\repo', ['--dir', directory], {
      platform: 'win32',
      cwd: 'C:\\repo'
    }), path.win32.normalize(directory));
  }
  assert.equal(parsePackagedDirectoryArgument([]), '');
  assert.throws(() => parsePackagedDirectoryArgument(['--dir']), /requires/);
  assert.throws(() => parsePackagedDirectoryArgument(['--dir', 'one', '--dir', 'two']), /only once/);
  
  console.log('Packaged verification preserves Windows paths with spaces and Unicode.');
}
await case_verify_packaged_arguments_unit();
