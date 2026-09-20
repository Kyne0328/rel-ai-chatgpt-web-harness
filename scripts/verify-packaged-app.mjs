import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listPackage } from '@electron/asar';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { electronPlatformSpec, normalizeElectronArch, normalizeElectronPlatform } from './electron-platform.mjs';
import { resolvePackagedDirectory } from './packaged-directory.mjs';
import { buildIdFromFingerprint, normalizeBuildProvenance } from '../src/buildProvenance.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const platform = normalizeElectronPlatform(valueAfter(argv, '--platform', process.platform));
const targetArch = normalizeElectronArch(process.env.REL_AI_TARGET_ARCH || process.arch);
const spec = electronPlatformSpec(platform, targetArch);
const packageDirectory = resolvePackagedDirectory(root, argv, { platform });
const resourcesDirectory = String(spec.resourcesDirectory || 'resources').replaceAll('\\', '/');
const resourcePath = (...parts) => path.posix.join(resourcesDirectory, ...parts);
const resourcesRoot = path.join(packageDirectory, spec.resourcesDirectory || 'resources');
const libnutPlatformPackage = `libnut-${platform}`;

assert.ok(fs.existsSync(packageDirectory), `Packaged application directory does not exist: ${packageDirectory}`);
assert.ok(fs.statSync(packageDirectory).isDirectory(), `Packaged application path is not a directory: ${packageDirectory}`);

const fusesEntry = path.join(root, 'electron', 'node_modules', '@electron', 'fuses', 'dist', 'index.js');
assert.ok(fs.existsSync(fusesEntry), `Electron fuse inspector is missing: ${fusesEntry}`);
const { getCurrentFuseWire, FuseV1Options } = await import(pathToFileURL(fusesEntry).href);
const executablePath = path.join(packageDirectory, spec.executableName);
assert.ok(fs.existsSync(executablePath), `Packaged application executable does not exist: ${executablePath}`);
assertExecutable(executablePath, platform);
const fuseWire = await getCurrentFuseWire(executablePath);
const browserSpecificSnapshotEnabled = Number(fuseWire[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]) === 49;
if (browserSpecificSnapshotEnabled) {
  const browserSnapshot = path.join(packageDirectory, 'browser_v8_context_snapshot.bin');
  assert.ok(fs.existsSync(browserSnapshot), 'LoadBrowserProcessSpecificV8Snapshot is enabled, but browser_v8_context_snapshot.bin is missing.');
  assert.ok(fs.statSync(browserSnapshot).isFile() && fs.statSync(browserSnapshot).size > 0, 'browser_v8_context_snapshot.bin must be a non-empty file when its fuse is enabled.');
}

const tunnelClientRelativePath = resourcePath('bin', 'tunnel-client', spec.tunnelClientDirectory, spec.tunnelClientFile);
const sourceTunnelManifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'tunnel-client', 'manifest.json'), 'utf8'));
const sourceZoektManifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'zoekt', 'manifest.json'), 'utf8'));
const sourceTreeSitterManifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'tree-sitter', 'manifest.json'), 'utf8'));
const sourceZoektPlatformSpec = sourceZoektManifest.platforms?.[platform];
const sourceZoektSpec = sourceZoektPlatformSpec?.architectures?.[targetArch] || sourceZoektPlatformSpec;
assert.ok(sourceZoektSpec, `Zoekt provenance manifest does not support ${platform}/${targetArch}.`);
const zoektSearchRelativePath = resourcePath('bin', 'zoekt', platform, sourceZoektSpec.search.file);
const zoektIndexRelativePath = resourcePath('bin', 'zoekt', platform, sourceZoektSpec.index.file);
const requiredFiles = [
  spec.executableName,
  resourcePath('app.asar'),
  resourcePath('src', 'httpServer.ts'),
  resourcePath('src', 'computerManager.js'),
  resourcePath('src', 'computer', 'midsceneAdapter.js'),
  resourcePath('src', 'tools', 'actionCatalog.js'),
  resourcePath('src', 'config.js'),
  resourcePath('src', 'mcpServer.js'),
  resourcePath('node_modules', '@modelcontextprotocol', 'server', 'package.json'),
  resourcePath('node_modules', '@modelcontextprotocol', 'node', 'package.json'),
  resourcePath('node_modules', '@modelcontextprotocol', 'core', 'package.json'),
  resourcePath('node_modules', '@midscene', 'computer', 'package.json'),
  resourcePath('node_modules', '@midscene', 'core', 'package.json'),
  resourcePath('node_modules', '@midscene', 'shared', 'package.json'),
  resourcePath('node_modules', '@computer-use', 'libnut', 'package.json'),
  resourcePath('node_modules', '@computer-use', libnutPlatformPackage, 'package.json'),
  resourcePath('node_modules', '@computer-use', libnutPlatformPackage, 'build', 'Release', 'libnut.node'),
  resourcePath('node_modules', 'screenshot-desktop', 'package.json'),
  resourcePath('node_modules', '@opentelemetry', 'api', 'package.json'),
  resourcePath('node_modules', '@opentelemetry', 'exporter-trace-otlp-http', 'package.json'),
  resourcePath('node_modules', '@opentelemetry', 'resources', 'package.json'),
  resourcePath('node_modules', '@opentelemetry', 'sdk-trace-node', 'package.json'),
  resourcePath('node_modules', '@opentelemetry', 'semantic-conventions', 'package.json'),
  resourcePath('node_modules', '@hono', 'node-server', 'package.json'),
  resourcePath('node_modules', 'hono', 'package.json'),
  resourcePath('node_modules', 'zod', 'package.json'),
  resourcePath('node_modules', 'yauzl', 'package.json'),
  resourcePath('node_modules', 'pend', 'package.json'),
  resourcePath('node_modules', 'web-tree-sitter', 'package.json'),
  resourcePath('node_modules', 'web-tree-sitter', 'web-tree-sitter.js'),
  resourcePath('node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
  resourcePath('vendor', 'tree-sitter', 'manifest.json'),
  resourcePath('bin', 'rel-ai-mcp-http.js'),
  resourcePath('public', 'dashboard.js'),
  resourcePath('public', 'dashboard-app.js'),
  resourcePath('public', 'dashboard-react.js'),
  resourcePath('public', 'dashboard.css'),
  resourcePath('package.json'),
  resourcePath('build-provenance.json'),
  resourcePath('CHANGELOG.md'),
  resourcePath('LICENSE'),
  resourcePath('NOTICE'),
  resourcePath('bin', 'tunnel-client', 'manifest.json'),
  tunnelClientRelativePath,
  resourcePath('bin', 'zoekt', 'manifest.json'),
  resourcePath('bin', 'zoekt', 'LICENSE'),
  zoektSearchRelativePath,
  zoektIndexRelativePath
];

for (const relativePath of requiredFiles) {
  const file = path.join(packageDirectory, relativePath);
  assert.ok(fs.existsSync(file), `Packaged application is missing: ${relativePath}`);
  assert.ok(fs.statSync(file).isFile(), `Packaged application entry is not a file: ${relativePath}`);
  assert.ok(fs.statSync(file).size > 0, `Packaged application file is empty: ${relativePath}`);
}
assertExecutable(path.join(packageDirectory, tunnelClientRelativePath), platform);
assertExecutable(path.join(packageDirectory, zoektSearchRelativePath), platform);
assertExecutable(path.join(packageDirectory, zoektIndexRelativePath), platform);

const asarPath = path.join(resourcesRoot, 'app.asar');
const asarEntries = new Set(listPackage(asarPath).map(entry => entry.replaceAll('\\', '/').replace(/^\//, '')));
for (const relativePath of ['preload.cjs', 'startup-background.js', 'secure-tunnel-runtime.js', 'tunnel-credentials.js', 'service-process.js', 'service-process-client.js', 'runtime-log-snapshot.js', 'service-activity-projection.js', 'renderer/app.css', 'renderer/color-tokens.css', 'renderer/status.html', 'renderer/wizard.html']) {
  assert.ok(asarEntries.has(relativePath), `Packaged ASAR is missing: ${relativePath}`);
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packagedPackage = JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'package.json'), 'utf8')); 
assert.equal(packagedPackage.name, rootPackage.name, 'Packaged package metadata has the wrong product name.');
assert.equal(packagedPackage.version, rootPackage.version, 'Packaged package metadata has the wrong version.');
const packagedBuildProvenance = normalizeBuildProvenance(JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'build-provenance.json'), 'utf8')));
assert.ok(packagedBuildProvenance, 'Packaged build provenance must be valid.');
assert.equal(packagedBuildProvenance.version, rootPackage.version, 'Packaged build provenance has the wrong application version.');
assert.match(buildIdFromFingerprint(packagedBuildProvenance.sourceFingerprint), /^[a-f0-9]{12}$/, 'Packaged build provenance must provide a valid build ID.');
const rootOpenTelemetryDirectory = path.join(root, 'node_modules', '@opentelemetry');
const packagedOpenTelemetryDirectory = path.join(resourcesRoot, 'node_modules', '@opentelemetry');
const rootOpenTelemetryPackages = fs.readdirSync(rootOpenTelemetryDirectory, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const packagedOpenTelemetryPackages = fs.readdirSync(packagedOpenTelemetryDirectory, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
assert.deepEqual(packagedOpenTelemetryPackages, rootOpenTelemetryPackages, 'Packaged application must include the complete OpenTelemetry runtime dependency scope.');
const packagedTreeSitterManifest = JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'vendor', 'tree-sitter', 'manifest.json'), 'utf8')); 
assert.deepEqual(packagedTreeSitterManifest, sourceTreeSitterManifest, 'Packaged vendored Tree-sitter manifest must match the reviewed source manifest.');
for (const grammar of Object.values(sourceTreeSitterManifest.grammars || {})) {
  const sourceFile = path.join(root, 'vendor', 'tree-sitter', grammar.file);
  const packagedFile = path.join(resourcesRoot, 'vendor', 'tree-sitter', grammar.file);
  assert.ok(fs.existsSync(sourceFile), `Vendored Tree-sitter source grammar is missing: ${grammar.file}`);
  assert.ok(fs.existsSync(packagedFile), `Packaged vendored Tree-sitter grammar is missing: ${grammar.file}`);
  const sourceBytes = fs.readFileSync(sourceFile);
  const packagedBytes = fs.readFileSync(packagedFile);
  assert.equal(sourceBytes.length, Number(grammar.bytes), `Vendored Tree-sitter grammar size mismatch: ${grammar.file}`);
  assert.equal(packagedBytes.length, Number(grammar.bytes), `Packaged vendored Tree-sitter grammar size mismatch: ${grammar.file}`);
  assert.equal(crypto.createHash('sha256').update(sourceBytes).digest('hex'), grammar.sha256, `Vendored Tree-sitter grammar checksum mismatch: ${grammar.file}`);
  assert.equal(crypto.createHash('sha256').update(packagedBytes).digest('hex'), grammar.sha256, `Packaged vendored Tree-sitter grammar checksum mismatch: ${grammar.file}`);
}
const tunnelManifest = JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'bin', 'tunnel-client', 'manifest.json'), 'utf8'));
assert.deepEqual(tunnelManifest, sourceTunnelManifest, 'Packaged OpenAI tunnel-client manifest must match the reviewed source manifest.');
assert.equal(tunnelManifest.releaseTag, `v${tunnelManifest.version}`, 'Packaged OpenAI tunnel-client release tag must match its version.');
assert.equal(tunnelManifest.distribution, 'full', 'Packaged OpenAI tunnel-client must use the reviewed full distribution.');
const tunnelPlatformSpec = tunnelManifest.platforms[platform];
const tunnelSpec = tunnelPlatformSpec?.architectures?.[targetArch] || tunnelPlatformSpec;
assert.ok(tunnelSpec, `Packaged OpenAI tunnel-client manifest does not support ${platform}/${targetArch}.`);
const packagedTunnelClientPath = path.join(packageDirectory, tunnelClientRelativePath);
const packagedTunnelClient = fs.readFileSync(packagedTunnelClientPath);
assert.equal(packagedTunnelClient.length, tunnelSpec.size, 'Packaged OpenAI tunnel-client size does not match the provenance manifest.');
assert.equal(crypto.createHash('sha256').update(packagedTunnelClient).digest('hex'), tunnelSpec.sha256, 'Packaged OpenAI tunnel-client SHA-256 does not match the provenance manifest.');
if (platform === process.platform && targetArch === normalizeElectronArch(process.arch)) {
  const versionCheck = spawnSync(packagedTunnelClientPath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  assert.equal(versionCheck.status, 0, `Packaged OpenAI tunnel-client --version must succeed: ${versionCheck.stderr || versionCheck.error?.message || ''}`);
  assert.match(`${versionCheck.stdout || ''}${versionCheck.stderr || ''}`, new RegExp(`(?:^|\\D)${tunnelManifest.version.replaceAll('.', '\\.')}\\b`), 'Packaged OpenAI tunnel-client must report the reviewed version.');
}
const packagedZoektManifest = JSON.parse(fs.readFileSync(path.join(resourcesRoot, 'bin', 'zoekt', 'manifest.json'), 'utf8')); 
assert.deepEqual(packagedZoektManifest, sourceZoektManifest, 'Packaged Zoekt provenance manifest must match the reviewed source manifest.');
for (const [key, relativePath] of [['search', zoektSearchRelativePath], ['index', zoektIndexRelativePath]]) {
  const artifact = sourceZoektSpec[key];
  const binaryPath = path.join(packageDirectory, relativePath);
  const bytes = fs.readFileSync(binaryPath);
  assert.equal(bytes.length, Number(artifact.size), `Packaged Zoekt ${key} size does not match provenance.`);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), artifact.sha256, `Packaged Zoekt ${key} SHA-256 does not match provenance.`);
  if (platform === process.platform && targetArch === normalizeElectronArch(process.arch)) {
    const help = spawnSync(binaryPath, ['-h'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.equal(help.status, 0, `Packaged Zoekt ${key} binary must execute successfully.`);
  }
}
const packagedTypeScript = collectFiles(path.join(resourcesRoot, 'node_modules')).filter(file => {
  if (!/\.(?:ts|cts|mts)$/i.test(file)) return false;
  return !/(?:^|\/)node_modules\/typescript-lsp-runtime\/lib\/lib(?:\.[^/]+)?\.d\.ts$/i.test(file);
});
assert.deepEqual(packagedTypeScript, [], 'Packaged runtime dependencies must exclude TypeScript sources and non-runtime declarations.');

const forbiddenPackagedPaths = [
  resourcePath('bin', 'ngrok'),
  resourcePath('bin', 'tunnel-client', spec.tunnelClientDirectory, 'cloudflared'),
  resourcePath('bin', 'tunnel-client', spec.tunnelClientDirectory, 'cloudflared.exe'),
  resourcePath('gateway'),
  resourcePath('node_modules', 'wrangler'),
  resourcePath('node_modules', '@cloudflare'),
  resourcePath('node_modules', 'miniflare'),
  resourcePath('node_modules', '@computer-use', 'nut-js'),
  resourcePath('node_modules', '@computer-use', 'shared'),
  resourcePath('node_modules', '@jimp'),
  resourcePath('node_modules', 'jimp'),
  resourcePath('node_modules', 'file-type')
];
for (const relativePath of forbiddenPackagedPaths) {
  assert.equal(fs.existsSync(path.join(packageDirectory, relativePath)), false, `Packaged desktop must exclude obsolete or peer-only runtime path: ${relativePath}`);
}
const packagedFiles = collectFiles(packageDirectory);
for (const sensitiveName of ['privateJwk', 'recoverySecret']) {
  assert.equal(packagedFiles.some(file => file.toLowerCase().includes(sensitiveName.toLowerCase())), false, `Packaged desktop must not contain secret-state file names matching ${sensitiveName}.`);
}
assert.equal(fs.existsSync(path.join(resourcesRoot, '.env')), false, 'Runtime credentials must not be materialized in the packaged application.');

function collectFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(target));
    else if (entry.isFile()) files.push(path.relative(packageDirectory, target).replaceAll('\\', '/'));
  }
  return files;
}

function valueAfter(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function assertExecutable(file, targetPlatform) {
  if (targetPlatform === 'win32') return;
  assert.notEqual(fs.statSync(file).mode & 0o111, 0, `${targetPlatform} packaged executable lacks execute permissions: ${file}`);
}

console.log(`Packaged ${platform} application layout verified for v${packagedPackage.version}: ${requiredFiles.length} required files are present.`);
