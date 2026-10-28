import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { normalizeTargetArch } from './platform-architecture.mjs';
import { VERSION_JSON_FILES, WORKSPACE_PACKAGE_FILES } from './release-surfaces.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.REL_AI_RELEASE_ROOT || path.join(__dirname, '..'));
const failures = [];
const ESCAPED_DOT = String.raw`\.`;

function rel(...parts) {
  return path.join(root, ...parts);
}

function read(relativePath) {
  return fs.readFileSync(rel(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function fail(message) {
  failures.push(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`);
}

function firstChangelogEntry(changelog) {
  const match = changelog.match(/^##\s+\[([^\]]+)\]\s+[—-]\s+(\d{4}-\d{2}-\d{2})\s*$/m);
  if (!match) return null;
  const start = match.index;
  const rest = changelog.slice(start + match[0].length);
  const next = rest.search(/\n##\s+\[/);
  const body = next === -1 ? rest : rest.slice(0, next);
  return { version: match[1], date: match[2], body };
}

function assertJsonVersion(relativePath, version) {
  const json = readJson(relativePath);
  expectEqual(json.version, version, `${relativePath} version`);
  if (json.packages?.['']) {
    expectEqual(json.packages[''].version, version, `${relativePath} packages[""].version`);
  }
  if (relativePath === 'package-lock.json') {
    for (const workspaceFile of WORKSPACE_PACKAGE_FILES) {
      const workspacePath = workspaceFile.slice(0, -'/package.json'.length);
      expectEqual(json.packages?.[workspacePath]?.version, version, `${relativePath} packages["${workspacePath}"].version`);
    }
  }
}

function assertTunnelClient() {
  // Source/release consistency is platform-neutral. The Electron packaging wrapper
  // fetches and verifies the pinned build-time binary for the explicit target.
  const platform = String(process.env.REL_AI_TARGET_PLATFORM || '').trim();
  if (!platform) return;
  const targetArch = normalizeTargetArch(process.env.REL_AI_TARGET_ARCH || process.arch, { allowUnknown: true });
  const manifestPath = rel('vendor', 'tunnel-client', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`OpenAI tunnel-client provenance manifest is missing: ${path.relative(root, manifestPath)}`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const platformSpec = manifest.platforms?.[platform];
  const spec = platformSpec?.architectures?.[targetArch] || platformSpec;
  if (!spec) {
    fail(`OpenAI tunnel-client provenance manifest has no entry for ${platform}/${targetArch}`);
    return;
  }
  const binaryPath = rel('vendor', 'tunnel-client', platform, spec.file);
  if (!fs.existsSync(binaryPath)) {
    fail(`bundled OpenAI tunnel-client is missing for ${platform}/${targetArch}: ${path.relative(root, binaryPath)}`);
    return;
  }
  const bytes = fs.readFileSync(binaryPath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  expectEqual(bytes.length, Number(spec.size), `bundled OpenAI tunnel-client size for ${platform}/${targetArch}`);
  expectEqual(sha256, String(spec.sha256).toLowerCase(), `bundled OpenAI tunnel-client SHA-256 for ${platform}/${targetArch}`);
}

const packageJson = readJson('package.json');
const version = packageJson.version;
expect(semver.valid(version) === version, `package.json version must be semver-like x.y.z, got ${version}`);

for (const relativePath of VERSION_JSON_FILES) assertJsonVersion(relativePath, version);
assertTunnelClient();

const changelog = read('CHANGELOG.md');
const entry = firstChangelogEntry(changelog);
expect(entry, 'CHANGELOG.md must start with a ## [version] — YYYY-MM-DD entry after the title');
if (entry) {
  expectEqual(entry.version, version, 'top CHANGELOG.md entry version');
  expect(/^\d{4}-\d{2}-\d{2}$/.test(entry.date), 'top CHANGELOG.md entry date must be YYYY-MM-DD');
  expect(/###\s+/.test(entry.body), 'top CHANGELOG.md entry must include a section heading');
  expect(/^-\s+\*\*/m.test(entry.body), 'top CHANGELOG.md entry must include detailed bold bullet entries');
  expect(new RegExp(String.raw`Bump .*${version.replaceAll('.', ESCAPED_DOT)}\.`, 'i').test(entry.body), `top CHANGELOG.md entry must include a bump line for ${version}`);
  expect(!/\b(TODO|TBD|WIP|placeholder|fill this in|summarize the user-visible change|list validation coverage)\b/i.test(entry.body), 'top CHANGELOG.md entry must not contain placeholder release-note text');
}

const versionModulePath = rel('src', 'version.js');
if (fs.existsSync(versionModulePath)) {
  const { getVersion } = await import(pathToFileURL(versionModulePath).href);
  expectEqual(getVersion(), version, 'src/version.js getVersion()');
}

const releaseManifestPath = rel('release-manifest.json');
if (!fs.existsSync(releaseManifestPath)) {
  fail('release-manifest.json is missing');
} else {
  const releaseManifest = readJson('release-manifest.json');
  expectEqual(releaseManifest.applicationVersion, version, 'release-manifest.json applicationVersion');
  expect(/^\d{4}-\d{2}-\d{2}$/.test(String(releaseManifest.protocolVersion || '')), 'release-manifest.json protocolVersion must use the supported date-version format');
  expect(Number.isInteger(releaseManifest.toolCount) && releaseManifest.toolCount > 0, 'release-manifest.json toolCount must be a positive integer');
  expect(/^[A-Za-z0-9_-]{24}$/.test(String(releaseManifest.manifestHash || '')), 'release-manifest.json manifestHash must be a 24-character base64url digest');

  const runtimeMetadataPath = rel('src', 'runtimeCompatibility.js');
  if (fs.existsSync(runtimeMetadataPath)) {
    const { runtimeMetadata } = await import(`${pathToFileURL(runtimeMetadataPath).href}?releaseCheck=${Date.now()}`);
    const runtime = runtimeMetadata();
    for (const field of ['applicationVersion', 'protocolVersion', 'toolSurfaceVersion', 'toolCount', 'manifestHash', 'schemaVersion']) {
      expectEqual(releaseManifest[field], runtime[field], `release-manifest.json ${field}`);
    }
  }
}

if (failures.length) {
  console.error('Release consistency check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Release consistency check passed for ${version}.`);
