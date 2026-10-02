import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import sevenZip from '7zip-bin';
import { discoverSkills } from '../src/skillDiscovery.js';
import { makeDefaultConfig, invalidateConfigCache, writeConfig } from '../src/config.js';
import {
  addDashboardExtensionSource,
  getExtensionsDashboard,
  removeDashboardExtensionSource
} from '../src/core/extensions.ts';
import {
  extensionDashboard,
  installExtension,
  listInstalledExtensions,
  parseExtensionManifest,
  removeExtension,
  validateExtensionSource
} from '../src/extensions/registry.js';
import {
  extensionCommandPathEntries,
  managedExtensionBundleCommandPath,
  managedExtensionCommandMetadataPath,
  managedExtensionCommandPath
} from '../src/extensions/paths.js';
import { extractToolBundleZip } from '../src/extensions/toolBundle.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extensions-'));
const config = { stateDir: root };
const catalogUrl = 'https://catalog.test/catalog.json';
const manifestUrl = 'https://catalog.test/sample/relai-extension.json';
const skillUrl = 'https://catalog.test/sample/SKILL.md';
const cliManifestUrl = 'https://catalog.test/auto-cli/relai-extension.json';
const cliSkillUrl = 'https://catalog.test/auto-cli/SKILL.md';
const cliArtifactUrl = 'https://downloads.test/auto-cli';
const bundleManifestUrl = 'https://catalog.test/tool-bundle/relai-extension.json';
const bundleSkillUrl = 'https://catalog.test/tool-bundle/SKILL.md';
const bundleArtifactUrl = 'https://downloads.test/tool-bundle.zip';
const skill = `---\nname: sample-extension\ndescription: Sample Rel.AI extension used by the extension registry tests.\n---\n\n# Sample extension\n\nUse existing Rel.AI tools and authorization.\n`;
const cliSkill = `---\nname: auto-cli-extension\ndescription: Exercises verified automatic CLI installation through the Rel.AI extension registry.\n---\n\n# Auto CLI extension\n\nUse the managed fixture command.\n`;
const bundleSkill = `---\nname: tool-bundle-extension\ndescription: Exercises verified multi-file tool bundle installation through the Rel.AI extension registry.\n---\n\n# Tool bundle extension\n\nUse the managed bundle commands.\n`;
const cliArtifact = Buffer.from('rel-ai managed CLI fixture\n', 'utf8');
const bundleCommand = 'relai-bundle-fixture';
const bundleHelperCommand = 'relai-bundle-helper';
const bundleCommandPath = `bin/${bundleCommand}${process.platform === 'win32' ? '.cmd' : ''}`;
const bundleHelperPath = `bin/${bundleHelperCommand}${process.platform === 'win32' ? '.cmd' : ''}`;
const bundleArtifact = makeStoredZip([
  [bundleCommandPath, Buffer.from('fixture tool\n', 'utf8')],
  [bundleHelperPath, Buffer.from('fixture helper\n', 'utf8')],
  ['lib/data.txt', Buffer.from('support data\n', 'utf8')]
]);
const tarBundleManifestUrl = 'https://catalog.test/tar-tool-bundle/relai-extension.json';
const tarBundleSkillUrl = 'https://catalog.test/tar-tool-bundle/SKILL.md';
const tarBundleArtifactUrl = 'https://downloads.test/tool-bundle.tar.gz';
const tarBundleCommand = 'relai-tar-bundle-fixture';
const tarBundleCommandPath = `bin/${tarBundleCommand}${process.platform === 'win32' ? '.cmd' : ''}`;
const tarBundleArtifact = makeTarGz([
  { name: tarBundleCommandPath, data: Buffer.from('tar fixture tool\n', 'utf8'), mode: 0o755 },
  { name: 'lib/data.txt', data: Buffer.from('tar support data\n', 'utf8') }
]);
const sha256 = crypto.createHash('sha256').update(skill).digest('hex');
const cliSkillSha256 = crypto.createHash('sha256').update(cliSkill).digest('hex');
const bundleSkillSha256 = crypto.createHash('sha256').update(bundleSkill).digest('hex');
const cliArtifactSha256 = crypto.createHash('sha256').update(cliArtifact).digest('hex');
const bundleArtifactSha256 = crypto.createHash('sha256').update(bundleArtifact).digest('hex');
const tarBundleArtifactSha256 = crypto.createHash('sha256').update(tarBundleArtifact).digest('hex');
const manifest = {
  schemaVersion: 1,
  id: 'sample-extension',
  name: 'Sample extension',
  version: '1.0.0',
  description: 'Sample extension for registry tests.',
  kind: 'skill',
  compatibility: { relai: '>=1.0.0 <2.0.0' },
  publisher: { name: 'Rel.AI test' },
  repository: 'https://github.com/Kyne0328/rel-ai-extensions',
  permissions: ['workspace.read'],
  requires: { commands: [], platforms: [] },
  entrypoints: { skill: 'SKILL.md' },
  files: [{ path: 'SKILL.md', sha256 }]
};
const cliManifest = {
  schemaVersion: 1,
  id: 'auto-cli-extension',
  name: 'Auto CLI extension',
  version: '1.0.0',
  description: 'CLI extension with a verified managed binary.',
  kind: 'cli',
  compatibility: { relai: '>=1.0.0 <2.0.0' },
  publisher: { name: 'Rel.AI test' },
  repository: 'https://github.com/Kyne0328/rel-ai-extensions',
  permissions: ['workspace.read', 'workspace.write', 'command.execute'],
  requires: { commands: ['relai-auto-cli-fixture'], platforms: [] },
  entrypoints: { skill: 'SKILL.md', command: 'relai-auto-cli-fixture' },
  install: {
    type: 'binary',
    artifacts: [{
      platform: process.platform,
      arch: process.arch,
      url: cliArtifactUrl,
      sha256: cliArtifactSha256
    }]
  },
  files: [{ path: 'SKILL.md', sha256: cliSkillSha256 }]
};
const unsupportedPlatform = process.platform === 'win32' ? 'linux' : 'win32';
const systemCommand = 'relai-system-cli-fixture';
const missingCommand = 'relai-missing-cli-fixture';
const systemManifestUrl = 'https://catalog.test/system-cli/relai-extension.json';
const systemSkillUrl = 'https://catalog.test/system-cli/SKILL.md';
const missingManifestUrl = 'https://catalog.test/missing-cli/relai-extension.json';
const missingSkillUrl = 'https://catalog.test/missing-cli/SKILL.md';
const systemManifest = {
  ...cliManifest,
  id: 'system-cli-extension',
  name: 'System CLI extension',
  description: 'CLI extension that uses an already available system command when no managed artifact matches this platform.',
  requires: { commands: [systemCommand], platforms: [] },
  entrypoints: { skill: 'SKILL.md', command: systemCommand },
  install: {
    type: 'binary',
    artifacts: [{ platform: unsupportedPlatform, arch: 'x64', url: cliArtifactUrl, sha256: cliArtifactSha256 }]
  }
};
const missingManifest = {
  ...cliManifest,
  id: 'missing-cli-extension',
  name: 'Missing CLI extension',
  description: 'CLI extension that remains installed but needs setup when no managed artifact matches this platform.',
  requires: { commands: [missingCommand], platforms: [] },
  entrypoints: { skill: 'SKILL.md', command: missingCommand },
  install: {
    type: 'binary',
    artifacts: [{ platform: unsupportedPlatform, arch: 'x64', url: cliArtifactUrl, sha256: cliArtifactSha256 }]
  }
};
const bundleManifest = {
  schemaVersion: 1,
  id: 'tool-bundle-extension',
  name: 'Tool bundle extension',
  version: '1.0.0',
  description: 'CLI extension with a verified private multi-file tool bundle.',
  kind: 'cli',
  compatibility: { relai: '>=1.0.0 <2.0.0' },
  publisher: { name: 'Rel.AI test' },
  repository: 'https://github.com/Kyne0328/rel-ai-extensions',
  permissions: ['workspace.read', 'command.execute'],
  requires: { commands: [bundleCommand, bundleHelperCommand], platforms: [] },
  entrypoints: { skill: 'SKILL.md', command: bundleCommand },
  install: {
    type: 'bundle',
    artifacts: [{
      platform: process.platform,
      arch: process.arch,
      url: bundleArtifactUrl,
      sha256: bundleArtifactSha256,
      commands: [
        { command: bundleCommand, path: bundleCommandPath },
        { command: bundleHelperCommand, path: bundleHelperPath }
      ]
    }]
  },
  files: [{ path: 'SKILL.md', sha256: bundleSkillSha256 }]
};
const tarBundleManifest = {
  ...bundleManifest,
  id: 'tar-tool-bundle-extension',
  name: 'TAR.GZ tool bundle extension',
  description: 'CLI extension with a verified TAR.GZ tool bundle.',
  requires: { commands: [tarBundleCommand], platforms: [] },
  entrypoints: { skill: 'SKILL.md', command: tarBundleCommand },
  install: {
    type: 'bundle',
    artifacts: [{
      platform: process.platform,
      arch: process.arch,
      url: tarBundleArtifactUrl,
      sha256: tarBundleArtifactSha256,
      commands: [{ command: tarBundleCommand, path: tarBundleCommandPath }]
    }]
  }
};

const catalog = {
  schemaVersion: 1,
  updatedAt: '2026-09-18T00:00:00.000Z',
  extensions: [
    catalogEntry(manifest, manifestUrl, true),
    catalogEntry(cliManifest, cliManifestUrl, true),
    catalogEntry(systemManifest, systemManifestUrl),
    catalogEntry(missingManifest, missingManifestUrl),
    catalogEntry(bundleManifest, bundleManifestUrl, true),
    catalogEntry(tarBundleManifest, tarBundleManifestUrl, true)
  ]
};

assert.equal(parseExtensionManifest(manifest).id, 'sample-extension');
assert.equal(parseExtensionManifest(cliManifest).install.type, 'binary');
assert.equal(parseExtensionManifest(bundleManifest).install.type, 'bundle');
assert.throws(() => parseExtensionManifest({ ...manifest, entrypoints: { skill: '../SKILL.md' } }), /entrypoints\.skill/i);
assert.throws(
  () => parseExtensionManifest({
    ...cliManifest,
    permissions: ['workspace.read'],
    entrypoints: { skill: 'SKILL.md', command: 'sample-cli' },
    requires: { commands: ['sample-cli'], platforms: [] }
  }),
  /command\.execute/i
);
for (const reservedCommand of ['node', 'relai-extension']) {
  assert.throws(
    () => parseExtensionManifest({
      ...cliManifest,
      entrypoints: { skill: 'SKILL.md', command: reservedCommand },
      requires: { commands: [reservedCommand], platforms: [] }
    }),
    /reserved/i
  );
}
assert.throws(
  () => parseExtensionManifest({
    ...bundleManifest,
    install: {
      ...bundleManifest.install,
      artifacts: bundleManifest.install.artifacts.map(artifact => ({
        ...artifact,
        commands: [{ command: bundleCommand, path: '../escape' }]
      }))
    }
  }),
  /safe relative paths/i
);

const condaCommand = 'relai-conda-fixture';
const condaCommandPath = process.platform === 'win32' ? `bin/${condaCommand}.cmd` : `bin/${condaCommand}`;
const currentCondaSubdir = process.platform === 'win32'
  ? 'win-64'
  : process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'osx-arm64' : 'osx-64')
    : (process.arch === 'arm64' ? 'linux-aarch64' : 'linux-64');
const condaManifest = {
  ...bundleManifest,
  id: 'conda-extension',
  name: 'Conda extension',
  requires: { commands: [condaCommand], platforms: [] },
  entrypoints: { skill: 'SKILL.md', command: condaCommand },
  install: {
    type: 'conda',
    artifacts: [{
      platform: process.platform,
      arch: process.arch,
      subdir: currentCondaSubdir,
      lockUrl: 'https://downloads.test/conda-lock.json',
      lockSha256: '1'.repeat(64),
      commands: [{ command: condaCommand, path: condaCommandPath }]
    }]
  }
};
assert.equal(parseExtensionManifest(condaManifest).install.type, 'conda');
assert.throws(
  () => parseExtensionManifest({
    ...condaManifest,
    install: {
      ...condaManifest.install,
      artifacts: condaManifest.install.artifacts.map(artifact => ({
        ...artifact,
        subdir: artifact.subdir === 'linux-64' ? 'osx-64' : 'linux-64'
      }))
    }
  }),
  /conda subdir/i
);

const unsafeArchive = path.join(root, 'unsafe-tool-bundle.zip');
const unsafeDestination = path.join(root, 'unsafe-tool-bundle');
fs.writeFileSync(unsafeArchive, makeStoredZip([['../escape.txt', Buffer.from('escape', 'utf8')]]));
await assert.rejects(
  extractToolBundleZip(unsafeArchive, unsafeDestination),
  /tool bundle|relative path|unsafe/i
);
assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
fs.rmSync(unsafeArchive, { force: true });
fs.rmSync(unsafeDestination, { recursive: true, force: true });

const linkedZipArchive = path.join(root, 'linked-tool-bundle.zip');
const linkedZipDestination = path.join(root, 'linked-tool-bundle');
fs.writeFileSync(linkedZipArchive, makeStoredZip([
  ['lib/libqpdf.30.0.2.dylib', Buffer.from('qpdf dylib\n'), 0o100644],
  ['lib/libqpdf.30.dylib', Buffer.from('libqpdf.30.0.2.dylib'), 0o120777]
]));
await extractToolBundleZip(linkedZipArchive, linkedZipDestination);
const linkedZipTarget = path.join(linkedZipDestination, 'lib', 'libqpdf.30.dylib');
assert.equal(fs.readFileSync(linkedZipTarget, 'utf8'), 'qpdf dylib\n');
assert.equal(fs.lstatSync(linkedZipTarget).isSymbolicLink(), false);

const escapingZipArchive = path.join(root, 'escaping-link-tool-bundle.zip');
const escapingZipDestination = path.join(root, 'escaping-link-tool-bundle');
fs.writeFileSync(escapingZipArchive, makeStoredZip([
  ['lib/source.txt', Buffer.from('safe\n'), 0o100644],
  ['lib/escape', Buffer.from('../../outside-zip-link.txt'), 0o120777]
]));
await assert.rejects(
  extractToolBundleZip(escapingZipArchive, escapingZipDestination),
  /link|unsafe|target/i
);
assert.equal(fs.existsSync(path.join(root, 'outside-zip-link.txt')), false);

const unsafeTarArchive = path.join(root, 'unsafe-tool-bundle.tar.gz');
const unsafeTarDestination = path.join(root, 'unsafe-tool-bundle-tar');
fs.writeFileSync(unsafeTarArchive, makeTarGz([{ name: '../escape-tar.txt', data: Buffer.from('escape', 'utf8') }]));
await assert.rejects(
  extractToolBundleZip(unsafeTarArchive, unsafeTarDestination),
  /tool bundle|path|tar/i
);
assert.equal(fs.existsSync(path.join(root, 'escape-tar.txt')), false);
assert.equal(fs.existsSync(unsafeTarDestination), false);

const linkedTarArchive = path.join(root, 'linked-tool-bundle.tar.gz');
const linkedTarDestination = path.join(root, 'linked-tool-bundle-tar');
fs.writeFileSync(linkedTarArchive, makeTarGz([
  { name: 'pandoc/bin/pandoc', data: Buffer.from('pandoc binary\n'), mode: 0o755 },
  { name: 'pandoc/bin/pandoc-server', type: '2', linkname: 'pandoc' },
  { name: 'pandoc/bin/pandoc-hard', type: '1', linkname: 'pandoc/bin/pandoc' }
]));
await extractToolBundleZip(linkedTarArchive, linkedTarDestination);
for (const name of ['pandoc-server', 'pandoc-hard']) {
  const target = path.join(linkedTarDestination, 'pandoc', 'bin', name);
  assert.equal(fs.readFileSync(target, 'utf8'), 'pandoc binary\n');
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
}

for (const [type, label] of [['2', 'symbolic'], ['1', 'hard']]) {
  fs.writeFileSync(unsafeTarArchive, makeTarGz([{ name: `unsafe-${label}-link`, type, linkname: '../outside' }]));
  await assert.rejects(
    extractToolBundleZip(unsafeTarArchive, unsafeTarDestination),
    /link|unsafe/i
  );
  assert.equal(fs.existsSync(unsafeTarDestination), false);
}

fs.writeFileSync(unsafeTarArchive, makeTarGz([{ name: 'large.bin', data: Buffer.alloc(16, 1) }]));
await assert.rejects(
  extractToolBundleZip(unsafeTarArchive, unsafeTarDestination, { maxFileBytes: 8 }),
  /per-file extraction limit/i
);
assert.equal(fs.existsSync(unsafeTarDestination), false);
fs.rmSync(unsafeTarArchive, { force: true });

const extraFormatSource = path.join(root, 'extra-format-source');
fs.mkdirSync(path.join(extraFormatSource, 'bin'), { recursive: true });
fs.writeFileSync(path.join(extraFormatSource, 'bin', 'tool'), 'extra format fixture\n');
const sevenZipArchive = path.join(root, 'tool-bundle.7z');
const sevenZipCreate = spawnSync(sevenZip.path7za, ['a', '-t7z', sevenZipArchive, '.'], {
  cwd: extraFormatSource,
  encoding: 'utf8'
});
assert.equal(sevenZipCreate.status, 0, sevenZipCreate.stderr || sevenZipCreate.stdout);
const sevenZipDestination = path.join(root, 'tool-bundle-7z');
await extractToolBundleZip(sevenZipArchive, sevenZipDestination);
assert.equal(fs.readFileSync(path.join(sevenZipDestination, 'bin', 'tool'), 'utf8'), 'extra format fixture\n');

const plainTarArchive = path.join(root, 'tool-bundle.tar');
fs.writeFileSync(plainTarArchive, makeTar([{ name: 'bin/tool', data: Buffer.from('tar xz fixture\n'), mode: 0o755 }]));
const tarXzArchive = path.join(root, 'tool-bundle.tar.xz');
const xzCreate = spawnSync(sevenZip.path7za, ['a', '-txz', tarXzArchive, plainTarArchive], { encoding: 'utf8' });
assert.equal(xzCreate.status, 0, xzCreate.stderr || xzCreate.stdout);
const tarXzDestination = path.join(root, 'tool-bundle-tar-xz');
await extractToolBundleZip(tarXzArchive, tarXzDestination);
assert.equal(fs.readFileSync(path.join(tarXzDestination, 'bin', 'tool'), 'utf8'), 'tar xz fixture\n');

const originalFetch = globalThis.fetch;
const extraResponses = new Map();
globalThis.fetch = async url => {
  const href = String(url);
  if (href === catalogUrl) return responseJson(catalog);
  if (href === manifestUrl) return responseJson(manifest);
  if (href === skillUrl) return new Response(skill, { status: 200 });
  if (href === cliManifestUrl) return responseJson(cliManifest);
  if (href === cliSkillUrl) return new Response(cliSkill, { status: 200 });
  if (href === cliArtifactUrl) return new Response(cliArtifact, { status: 200 });
  if (href === systemManifestUrl) return responseJson(systemManifest);
  if (href === systemSkillUrl) return new Response(cliSkill, { status: 200 });
  if (href === missingManifestUrl) return responseJson(missingManifest);
  if (href === missingSkillUrl) return new Response(cliSkill, { status: 200 });
  if (href === bundleManifestUrl) return responseJson(bundleManifest);
  if (href === bundleSkillUrl) return new Response(bundleSkill, { status: 200 });
  if (href === bundleArtifactUrl) return new Response(bundleArtifact, { status: 200 });
  if (href === tarBundleManifestUrl) return responseJson(tarBundleManifest);
  if (href === tarBundleSkillUrl) return new Response(bundleSkill, { status: 200 });
  if (href === tarBundleArtifactUrl) return new Response(tarBundleArtifact, { status: 200 });
  if (extraResponses.has(href)) return extraResponses.get(href)();
  return new Response('not found', { status: 404 });
};

try {
  const installed = await installExtension(config, manifest.id, { catalogUrl });
  assert.equal(installed.ready, true);
  assert.equal(listInstalledExtensions(config).find(item => item.id === manifest.id)?.version, '1.0.0');

  const skills = discoverSkills({ path: root }, { config, userRoot: path.join(root, 'user-skills') });
  const extensionSkill = skills.find(item => item.name === 'sample-extension');
  assert.equal(extensionSkill?.source, 'extension');
  assert.equal(extensionSkill?.path, 'extension:sample-extension');

  const dashboard = await extensionDashboard(config, { catalogUrl });
  assert.equal(dashboard.catalog.find(item => item.id === manifest.id)?.installed, true);
  assert.equal(dashboard.catalog.find(item => item.id === manifest.id)?.updateAvailable, false);

  const badCliManifest = {
    ...cliManifest,
    id: 'bad-auto-cli-extension',
    name: 'Bad auto CLI extension',
    entrypoints: { skill: 'SKILL.md', command: 'relai-bad-auto-cli-fixture' },
    requires: { commands: ['relai-bad-auto-cli-fixture'], platforms: [] },
    install: {
      type: 'binary',
      artifacts: [{
        platform: process.platform,
        arch: process.arch,
        url: cliArtifactUrl,
        sha256: '0'.repeat(64)
      }]
    }
  };
  catalog.extensions.push(catalogEntry(badCliManifest, 'https://catalog.test/bad-auto-cli/relai-extension.json'));
  const originalFetchWithBadFixture = globalThis.fetch;
  globalThis.fetch = async url => {
    const href = String(url);
    if (href === 'https://catalog.test/bad-auto-cli/relai-extension.json') return responseJson(badCliManifest);
    return originalFetchWithBadFixture(url);
  };
  await assert.rejects(
    installExtension(config, badCliManifest.id, { catalogUrl }),
    /checksum mismatch/i
  );
  assert.equal(listInstalledExtensions(config).some(item => item.id === badCliManifest.id), false);
  assert.equal(fs.existsSync(managedExtensionCommandPath(config, badCliManifest.entrypoints.command)), false);
  globalThis.fetch = originalFetchWithBadFixture;

  const systemBin = path.join(root, 'system-bin');
  fs.mkdirSync(systemBin, { recursive: true });
  const systemExecutable = path.join(systemBin, process.platform === 'win32' ? `${systemCommand}.cmd` : systemCommand);
  fs.writeFileSync(systemExecutable, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${systemBin}${path.delimiter}${originalPath || ''}`;
  const systemInstalled = await installExtension(config, systemManifest.id, { catalogUrl });
  assert.equal(systemInstalled.ready, true);
  assert.deepEqual(systemInstalled.missingCommands, []);
  assert.equal(fs.existsSync(managedExtensionCommandPath(config, systemCommand)), false);
  assert.equal(discoverSkills({ path: root }, { config, userRoot: path.join(root, 'user-skills') }).some(item => item.name === systemManifest.id), true);
  process.env.PATH = originalPath;

  const missingInstalled = await installExtension(config, missingManifest.id, { catalogUrl });
  assert.equal(missingInstalled.status, 'needs_setup');
  assert.equal(missingInstalled.ready, false);
  assert.deepEqual(missingInstalled.missingCommands, [missingCommand]);
  assert.match(missingInstalled.error, /missing required command/i);
  assert.equal(fs.existsSync(managedExtensionCommandPath(config, missingCommand)), false);
  assert.equal(discoverSkills({ path: root }, { config, userRoot: path.join(root, 'user-skills') }).some(item => item.name === missingManifest.id), false);

  const removedSystem = removeExtension(config, systemManifest.id);
  assert.equal(removedSystem.removed, true);
  assert.deepEqual(removedSystem.removedCommands, []);
  const removedMissing = removeExtension(config, missingManifest.id);
  assert.equal(removedMissing.removed, true);
  assert.deepEqual(removedMissing.removedCommands, []);

  const cliCatalogEntry = catalog.extensions.find(item => item.id === cliManifest.id);
  cliCatalogEntry.autoInstall = false;
  await assert.rejects(
    installExtension(config, cliManifest.id, { catalogUrl }),
    /catalog auto-install metadata does not match/i
  );
  cliCatalogEntry.autoInstall = true;

  const cliInstalled = await installExtension(config, cliManifest.id, { catalogUrl });
  assert.equal(cliInstalled.ready, true);
  assert.equal(cliInstalled.autoInstall, true);
  assert.deepEqual(cliInstalled.missingCommands, []);
  const managedCommand = managedExtensionCommandPath(config, cliManifest.entrypoints.command);
  const managedMetadata = managedExtensionCommandMetadataPath(config, cliManifest.entrypoints.command);
  assert.equal(fs.readFileSync(managedCommand, 'utf8'), cliArtifact.toString('utf8'));
  assert.equal(JSON.parse(fs.readFileSync(managedMetadata, 'utf8')).extensionId, cliManifest.id);
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(managedCommand).mode & 0o111, 0);

  const cliSkills = discoverSkills({ path: root }, { config, userRoot: path.join(root, 'user-skills') });
  assert.equal(cliSkills.find(item => item.name === cliManifest.id)?.source, 'extension');

  const removedCli = removeExtension(config, cliManifest.id);
  assert.equal(removedCli.removed, true);
  assert.deepEqual(removedCli.removedCommands, [cliManifest.entrypoints.command]);
  assert.equal(fs.existsSync(managedCommand), false);
  assert.equal(fs.existsSync(managedMetadata), false);

  const bundleInstalled = await installExtension(config, bundleManifest.id, { catalogUrl });
  assert.equal(bundleInstalled.ready, true);
  assert.deepEqual(bundleInstalled.missingCommands, []);
  const bundleTarget = managedExtensionBundleCommandPath(config, bundleManifest.id, bundleCommandPath);
  const bundleHelperTarget = managedExtensionBundleCommandPath(config, bundleManifest.id, bundleHelperPath);
  assert.equal(fs.readFileSync(bundleTarget, 'utf8'), 'fixture tool\n');
  assert.equal(fs.readFileSync(bundleHelperTarget, 'utf8'), 'fixture helper\n');
  assert.equal(fs.readFileSync(path.join(path.dirname(path.dirname(bundleTarget)), 'lib', 'data.txt'), 'utf8'), 'support data\n');
  assert.equal(fs.existsSync(managedExtensionCommandPath(config, bundleCommand)), false);
  const bundleMetadataPath = managedExtensionCommandMetadataPath(config, bundleCommand);
  const bundleMetadata = JSON.parse(fs.readFileSync(bundleMetadataPath, 'utf8'));
  assert.equal(bundleMetadata.installType, 'bundle');
  assert.equal(bundleMetadata.relativePath, bundleCommandPath);
  assert.equal(extensionCommandPathEntries(config).includes(path.dirname(bundleTarget)), true);
  if (process.platform === 'win32') {
    const condaRuntime = path.join(path.dirname(path.dirname(bundleTarget)), 'Library', 'bin');
    fs.mkdirSync(condaRuntime, { recursive: true });
    fs.writeFileSync(bundleMetadataPath, `${JSON.stringify({ ...bundleMetadata, sourceType: 'conda' }, null, 2)}\n`);
    assert.equal(extensionCommandPathEntries(config).includes(condaRuntime), true);
  }
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(bundleTarget).mode & 0o111, 0);

  const removedBundle = removeExtension(config, bundleManifest.id);
  assert.equal(removedBundle.removed, true);
  assert.deepEqual(removedBundle.removedCommands, [bundleHelperCommand, bundleCommand].sort());
  assert.equal(fs.existsSync(bundleTarget), false);
  assert.equal(fs.existsSync(managedExtensionCommandMetadataPath(config, bundleCommand)), false);

  const tarBundleInstalled = await installExtension(config, tarBundleManifest.id, { catalogUrl });
  assert.equal(tarBundleInstalled.ready, true);
  assert.deepEqual(tarBundleInstalled.missingCommands, []);
  const tarBundleTarget = managedExtensionBundleCommandPath(config, tarBundleManifest.id, tarBundleCommandPath);
  assert.equal(fs.readFileSync(tarBundleTarget, 'utf8'), 'tar fixture tool\n');
  assert.equal(fs.readFileSync(path.join(path.dirname(path.dirname(tarBundleTarget)), 'lib', 'data.txt'), 'utf8'), 'tar support data\n');
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(tarBundleTarget).mode & 0o111, 0);
  const removedTarBundle = removeExtension(config, tarBundleManifest.id);
  assert.equal(removedTarBundle.removed, true);
  assert.deepEqual(removedTarBundle.removedCommands, [tarBundleCommand]);

  const removed = removeExtension(config, manifest.id);
  assert.equal(removed.removed, true);
  assert.equal(listInstalledExtensions(config).length, 0);

  const customRepositoryUrl = 'https://github.com/acme/relai-extensions';
  const customCatalogUrl = 'https://raw.githubusercontent.com/acme/relai-extensions/main/publisher-catalog.json';
  const customManifestUrl = 'https://raw.githubusercontent.com/acme/relai-extensions/main/extensions/tool/relai-extension.json';
  const customSkillUrl = 'https://raw.githubusercontent.com/acme/relai-extensions/main/extensions/tool/SKILL.md';
  const customSkill = `---\nname: tool\ndescription: Third-party source fixture.\n---\n\n# Tool\n`;
  const customManifest = {
    ...manifest,
    id: 'acme.tool',
    name: 'Acme Tool',
    description: 'Third-party extension source fixture.',
    publisher: { name: 'Acme' },
    repository: customRepositoryUrl,
    files: [{ path: 'SKILL.md', sha256: crypto.createHash('sha256').update(customSkill).digest('hex') }]
  };
  const customCatalog = {
    schemaVersion: 1,
    updatedAt: '2026-09-29T00:00:00.000Z',
    extensions: [catalogEntry(customManifest, customManifestUrl)]
  };
  extraResponses.set(customCatalogUrl, () => responseJson(customCatalog));
  extraResponses.set(customManifestUrl, () => responseJson(customManifest));
  extraResponses.set(customSkillUrl, () => new Response(customSkill, { status: 200 }));

  const previousCatalogOverride = process.env.REL_AI_EXTENSIONS_CATALOG_URL;
  process.env.REL_AI_EXTENSIONS_CATALOG_URL = catalogUrl;
  try {
    await assert.rejects(
      validateExtensionSource(config, `${customRepositoryUrl}/tree/main`),
      /repository URL itself/i,
      'GitHub source input must be the repository URL rather than a branch or subfolder URL'
    );
    const source = await validateExtensionSource(config, customRepositoryUrl);
    assert.equal(source.repositoryUrl, customRepositoryUrl);
    assert.equal(source.catalogUrl, customCatalogUrl);
    assert.equal(source.extensionCount, 1);

    const sourceConfig = {
      ...config,
      extensions: { sources: [{ repositoryUrl: customRepositoryUrl, catalogUrl: customCatalogUrl }] }
    };
    const sourceDashboard = await extensionDashboard(sourceConfig, { refresh: true });
    const sourceEntry = sourceDashboard.catalog.find(item => item.id === customManifest.id);
    assert.equal(sourceEntry?.sourceRepositoryUrl, customRepositoryUrl);
    assert.equal(sourceDashboard.sources.find(item => item.id === sourceEntry?.sourceId)?.status, 'ready');

    const customInstalled = await installExtension(sourceConfig, customManifest.id, { sourceId: sourceEntry.sourceId });
    assert.equal(customInstalled.ready, true);
    assert.equal(customInstalled.sourceId, sourceEntry.sourceId);
    assert.equal(customInstalled.sourceCatalogUrl, customCatalogUrl);

    const sourceRemovedDashboard = await extensionDashboard(config, { refresh: true });
    const retained = sourceRemovedDashboard.installed.find(item => item.id === customManifest.id);
    assert.equal(retained?.sourceAvailable, false, 'removing a source must keep the installed package but disable update discovery');

    const takeoverCatalogUrl = 'https://takeover.test/publisher-catalog.json';
    const takeoverManifestUrl = 'https://takeover.test/acme-tool/relai-extension.json';
    const takeoverManifest = { ...customManifest, version: '1.1.0', repository: 'https://takeover.test/repository' };
    const takeoverCatalog = {
      schemaVersion: 1,
      updatedAt: '2026-09-29T00:01:00.000Z',
      extensions: [catalogEntry(takeoverManifest, takeoverManifestUrl)]
    };
    extraResponses.set(takeoverCatalogUrl, () => responseJson(takeoverCatalog));
    extraResponses.set(takeoverManifestUrl, () => responseJson(takeoverManifest));
    await assert.rejects(
      installExtension(sourceConfig, customManifest.id, { catalogUrl: takeoverCatalogUrl }),
      /different source/i,
      'an extension id already installed from one source must not be replaced from another source'
    );
    await assert.rejects(
      validateExtensionSource(sourceConfig, takeoverCatalogUrl),
      /conflicts with active extension id/i,
      'adding a source with a duplicate active extension id must be rejected'
    );

    const removedCustom = removeExtension(sourceConfig, customManifest.id);
    assert.equal(removedCustom.removed, true);
  } finally {
    if (previousCatalogOverride == null) delete process.env.REL_AI_EXTENSIONS_CATALOG_URL;
    else process.env.REL_AI_EXTENSIONS_CATALOG_URL = previousCatalogOverride;
  }
  assert.equal(listInstalledExtensions(config).length, 0);

  const previousConfigPath = process.env.REL_AI_MCP_CONFIG;
  const previousCoreCatalogOverride = process.env.REL_AI_EXTENSIONS_CATALOG_URL;
  const coreConfigPath = path.join(root, 'source-core-config.json');
  process.env.REL_AI_MCP_CONFIG = coreConfigPath;
  process.env.REL_AI_EXTENSIONS_CATALOG_URL = catalogUrl;
  try {
    writeConfig({ ...makeDefaultConfig(), stateDir: path.join(root, 'source-core-state') });
    const addedSource = await addDashboardExtensionSource(customRepositoryUrl);
    assert.equal(addedSource.ok, true);
    const persistedAfterAdd = JSON.parse(fs.readFileSync(coreConfigPath, 'utf8'));
    assert.deepEqual(persistedAfterAdd.extensions.sources, [{ repositoryUrl: customRepositoryUrl, catalogUrl: customCatalogUrl }]);
    const coreDashboard = await getExtensionsDashboard(true);
    assert.equal(coreDashboard.catalog.some(item => item.id === customManifest.id), true);
    const removedSource = removeDashboardExtensionSource(addedSource.source.id);
    assert.equal(removedSource.removed, true);
    const persistedAfterRemove = JSON.parse(fs.readFileSync(coreConfigPath, 'utf8'));
    assert.deepEqual(persistedAfterRemove.extensions.sources, []);
  } finally {
    if (previousConfigPath == null) delete process.env.REL_AI_MCP_CONFIG;
    else process.env.REL_AI_MCP_CONFIG = previousConfigPath;
    if (previousCoreCatalogOverride == null) delete process.env.REL_AI_EXTENSIONS_CATALOG_URL;
    else process.env.REL_AI_EXTENSIONS_CATALOG_URL = previousCoreCatalogOverride;
    invalidateConfigCache();
  }
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Extension registry contracts passed.');

function catalogEntry(extension, url, featured = false) {
  return {
    id: extension.id,
    name: extension.name,
    version: extension.version,
    description: extension.description,
    kind: extension.kind,
    manifestUrl: url,
    repository: extension.repository,
    publisher: extension.publisher.name,
    permissions: extension.permissions,
    autoInstall: Boolean(extension.install),
    featured
  };
}

function makeStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, data, mode] of files) {
    const fileName = Buffer.from(name, 'utf8');
    const payload = Buffer.from(data);
    const crc = crc32(payload);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    localParts.push(local, fileName, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(mode == null ? 20 : ((3 << 8) | 20), 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    if (mode != null) central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, fileName);

    offset += local.length + fileName.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const type = entry.type || '0';
    const isRegular = type === '0';
    const data = isRegular ? Buffer.from(entry.data || Buffer.alloc(0)) : Buffer.alloc(0);
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, entry.mode ?? (type === '5' ? 0o755 : 0o644));
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, data.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, 'ascii');
    if (entry.linkname) writeTarString(header, 157, 100, entry.linkname);
    writeTarString(header, 257, 6, 'ustar\0');
    writeTarString(header, 263, 2, '00');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumText = checksum.toString(8).padStart(6, '0');
    header.write(checksumText, 148, 6, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    parts.push(header);
    if (data.length) {
      parts.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) parts.push(Buffer.alloc(padding));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function makeTarGz(entries) {
  return gzipSync(makeTar(entries));
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(String(value || ''), 'utf8');
  if (bytes.length > length) throw new Error(`TAR fixture field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Number(value).toString(8).padStart(length - 1, '0');
  buffer.write(text, offset, length - 1, 'ascii');
  buffer[offset + length - 1] = 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function responseJson(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
