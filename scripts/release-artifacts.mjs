import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeElectronArch, normalizeElectronPlatform } from './electron-platform.mjs';

const root = process.env.REL_AI_RELEASE_ROOT
  ? path.resolve(process.env.REL_AI_RELEASE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
let cachedElectronPackage = null;

function releaseArtifactNames(version, options = {}) {
  const normalizedVersion = normalizeVersion(version);
  const electronPackage = options.electronPackage || readElectronPackage();
  const build = electronPackage?.build || {};
  const installer = renderBuilderArtifactName(requiredArtifactTemplate(build.nsis, 'NSIS'), {
    version: normalizedVersion,
    arch: 'x64',
    ext: 'exe'
  });
  return {
    installer,
    portable: renderBuilderArtifactName(requiredArtifactTemplate(build.portable, 'portable'), {
      version: normalizedVersion,
      arch: 'x64',
      ext: 'exe'
    }),
    blockmap: `${installer}.blockmap`,
    metadata: 'latest.yml',
    linuxAppImage: renderBuilderArtifactName(requiredArtifactTemplate(build.appImage, 'AppImage'), {
      version: normalizedVersion,
      arch: 'x64',
      ext: 'AppImage'
    }),
    linuxDeb: renderBuilderArtifactName(requiredArtifactTemplate(build.deb, 'DEB'), {
      version: normalizedVersion,
      arch: 'x64',
      ext: 'deb'
    }),
    linuxMetadata: 'latest-linux.yml',
    macMetadata: 'latest-mac.yml',
    macDmgX64: renderBuilderArtifactName(requiredArtifactTemplate(build.dmg, 'DMG'), {
      version: normalizedVersion,
      arch: 'x64',
      ext: 'dmg'
    }),
    macDmgArm64: renderBuilderArtifactName(requiredArtifactTemplate(build.dmg, 'DMG'), {
      version: normalizedVersion,
      arch: 'arm64',
      ext: 'dmg'
    }),
    checksums: 'SHA256SUMS.txt',
    sbom: 'sbom.cdx.json'
  };
}

function platformReleaseArtifactNames(version, platform, architecture = 'x64', options = {}) {
  const normalizedPlatform = normalizeElectronPlatform(platform);
  const normalizedArch = normalizeElectronArch(architecture);
  const names = releaseArtifactNames(version, options);
  if (normalizedPlatform === 'win32') {
    return [names.installer, names.portable, names.blockmap, names.metadata, names.sbom];
  }
  if (normalizedPlatform === 'linux') {
    if (normalizedArch !== 'x64') throw new Error(`Linux release artifacts are not configured for ${normalizedArch}.`);
    return [names.linuxAppImage, names.linuxDeb, names.linuxMetadata];
  }
  return [normalizedArch === 'arm64' ? names.macDmgArm64 : names.macDmgX64];
}

function renderBuilderArtifactName(template, values) {
  const rendered = String(template || '').replace(/\$\{(version|arch|ext)\}/g, (_match, key) => String(values[key] || ''));
  if (!rendered || /\$\{[^}]+\}/.test(rendered)) {
    throw new Error(`Unsupported Electron artifact template: ${template || '(empty)'}.`);
  }
  return exactBasename(rendered);
}

function requiredArtifactTemplate(config, label) {
  const template = String(config?.artifactName || '').trim();
  if (!template) throw new Error(`electron/package.json is missing build.${String(label).toLowerCase()}.artifactName.`);
  return template;
}

function readElectronPackage() {
  if (!cachedElectronPackage) {
    cachedElectronPackage = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
  }
  return cachedElectronPackage;
}

function normalizeVersion(version) {
  const normalizedVersion = String(version || '').trim();
  if (!VERSION_PATTERN.test(normalizedVersion)) {
    throw new Error(`Invalid release version: ${normalizedVersion || '(empty)'}.`);
  }
  return normalizedVersion;
}

function invalidateDerivedReleaseEvidence(directory, version) {
  const names = releaseArtifactNames(version);
  const removed = [];
  for (const name of [names.checksums, names.sbom, 'release-assets.txt']) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 200 });
    removed.push(name);
  }
  return removed;
}

function parseLatestMetadata(source) {
  const lines = String(source || '').split(/\r?\n/);
  const files = [];
  let inFiles = false;
  let current = null;
  let topLevelPath = '';
  let topLevelSha512 = '';

  for (const rawLine of lines) {
    if (/^files:\s*$/.test(rawLine)) {
      inFiles = true;
      current = null;
      continue;
    }
    const fileMatch = rawLine.match(/^\s*-\s+(?:url|path):\s*(.+?)\s*$/);
    if (inFiles && fileMatch) {
      current = { basename: artifactBasename(parseYamlScalar(fileMatch[1])), sha512: '' };
      files.push(current);
      continue;
    }
    const indentedSha = rawLine.match(/^\s+sha512:\s*(.+?)\s*$/);
    if (inFiles && current && indentedSha) {
      current.sha512 = parseYamlScalar(indentedSha[1]);
      continue;
    }
    if (/^\S/.test(rawLine) && !/^files:\s*$/.test(rawLine)) {
      inFiles = false;
      current = null;
    }
    const pathMatch = rawLine.match(/^path:\s*(.+?)\s*$/);
    if (pathMatch) topLevelPath = artifactBasename(parseYamlScalar(pathMatch[1]));
    const shaMatch = rawLine.match(/^sha512:\s*(.+?)\s*$/);
    if (shaMatch) topLevelSha512 = parseYamlScalar(shaMatch[1]);
  }

  if (topLevelPath) {
    const existing = files.find(file => file.basename === topLevelPath);
    if (existing) {
      if (!existing.sha512) existing.sha512 = topLevelSha512;
    } else {
      files.push({ basename: topLevelPath, sha512: topLevelSha512 });
    }
  }
  if (files.length === 0) throw new Error('latest.yml does not reference an update artifact.');
  for (const file of files) {
    if (!file.basename) throw new Error('latest.yml contains an empty update artifact name.');
    if (!file.sha512) throw new Error(`latest.yml does not contain SHA-512 for ${file.basename}.`);
  }
  return files;
}

function parseChecksumManifest(source) {
  const checksums = new Map();
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-fA-F0-9]{64})\s+[* ]?(.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS.txt line: ${rawLine}`);
    const basename = exactBasename(match[2].trim());
    if (checksums.has(basename)) throw new Error(`Duplicate SHA-256 entry: ${basename}.`);
    checksums.set(basename, match[1].toLowerCase());
  }
  return checksums;
}

function parseAssetList(source) {
  const names = String(source || '')
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)
    .map(exactBasename);
  const unique = new Set(names);
  if (unique.size !== names.length) throw new Error('Release asset list contains duplicate basenames.');
  return unique;
}

function parseYamlScalar(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function artifactBasename(value) {
  const normalized = String(value || '').replaceAll('\\', '/');
  let pathname = normalized;
  try {
    pathname = new URL(normalized, 'https://release.invalid/').pathname;
  } catch {}
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {}
  return exactBasename(path.posix.basename(decoded));
}

function exactBasename(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Release asset must be an exact basename: ${name || '(empty)'}.`);
  }
  return name;
}

function main(argv = process.argv.slice(2)) {
  const platform = valueAfter(argv, '--platform');
  const artifact = valueAfter(argv, '--artifact');
  if (!platform && !artifact) return;
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const version = valueAfter(argv, '--version', packageVersion);
  const arch = valueAfter(argv, '--arch', process.env.REL_AI_TARGET_ARCH || 'x64');
  const releaseNames = releaseArtifactNames(version);
  const selected = artifact
    ? [releaseArtifactByRole(releaseNames, artifact, arch)]
    : platformReleaseArtifactNames(version, platform, arch);
  const names = selected.map(name => `dist/${name}`);
  const outputKey = valueAfter(argv, '--github-output');
  if (outputKey) {
    const outputFile = String(process.env.GITHUB_OUTPUT || '').trim();
    if (!outputFile) throw new Error('--github-output requires GITHUB_OUTPUT.');
    const delimiter = `REL_AI_RELEASE_ARTIFACTS_${process.pid}_${Date.now()}`;
    fs.appendFileSync(outputFile, `${outputKey}<<${delimiter}\n${names.join('\n')}\n${delimiter}\n`);
    return;
  }
  process.stdout.write(`${names.join('\n')}\n`);
}

function releaseArtifactByRole(names, role, architecture = 'x64') {
  const normalizedRole = String(role || '').trim();
  if (normalizedRole === 'macDmg') {
    return normalizeElectronArch(architecture) === 'arm64' ? names.macDmgArm64 : names.macDmgX64;
  }
  const allowed = new Set(['installer', 'portable', 'blockmap', 'metadata', 'linuxAppImage', 'linuxDeb', 'linuxMetadata', 'checksums', 'sbom']);
  if (!allowed.has(normalizedRole)) throw new Error(`Unknown release artifact role: ${normalizedRole || '(empty)'}.`);
  return names[normalizedRole];
}

function valueAfter(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  exactBasename,
  invalidateDerivedReleaseEvidence,
  parseAssetList,
  parseChecksumManifest,
  parseLatestMetadata,
  platformReleaseArtifactNames,
  releaseArtifactByRole,
  releaseArtifactNames,
  renderBuilderArtifactName
};
