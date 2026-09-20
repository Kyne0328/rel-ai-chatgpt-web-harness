import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverSkills } from '../src/skillDiscovery.js';
import {
  extensionDashboard,
  installExtension,
  listInstalledExtensions,
  parseExtensionManifest,
  removeExtension
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
const sha256 = crypto.createHash('sha256').update(skill).digest('hex');
const cliSkillSha256 = crypto.createHash('sha256').update(cliSkill).digest('hex');
const bundleSkillSha256 = crypto.createHash('sha256').update(bundleSkill).digest('hex');
const cliArtifactSha256 = crypto.createHash('sha256').update(cliArtifact).digest('hex');
const bundleArtifactSha256 = crypto.createHash('sha256').update(bundleArtifact).digest('hex');
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

const catalog = {
  schemaVersion: 1,
  updatedAt: '2026-09-18T00:00:00.000Z',
  extensions: [
    catalogEntry(manifest, manifestUrl, true),
    catalogEntry(cliManifest, cliManifestUrl, true),
    catalogEntry(bundleManifest, bundleManifestUrl, true)
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
assert.throws(
  () => parseExtensionManifest({
    ...cliManifest,
    entrypoints: { skill: 'SKILL.md', command: 'node' },
    requires: { commands: ['node'], platforms: [] }
  }),
  /reserved/i
);
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

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const href = String(url);
  if (href === catalogUrl) return responseJson(catalog);
  if (href === manifestUrl) return responseJson(manifest);
  if (href === skillUrl) return new Response(skill, { status: 200 });
  if (href === cliManifestUrl) return responseJson(cliManifest);
  if (href === cliSkillUrl) return new Response(cliSkill, { status: 200 });
  if (href === cliArtifactUrl) return new Response(cliArtifact, { status: 200 });
  if (href === bundleManifestUrl) return responseJson(bundleManifest);
  if (href === bundleSkillUrl) return new Response(bundleSkill, { status: 200 });
  if (href === bundleArtifactUrl) return new Response(bundleArtifact, { status: 200 });
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
  const bundleMetadata = JSON.parse(fs.readFileSync(managedExtensionCommandMetadataPath(config, bundleCommand), 'utf8'));
  assert.equal(bundleMetadata.installType, 'bundle');
  assert.equal(bundleMetadata.relativePath, bundleCommandPath);
  assert.equal(extensionCommandPathEntries(config).includes(path.dirname(bundleTarget)), true);
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(bundleTarget).mode & 0o111, 0);

  const removedBundle = removeExtension(config, bundleManifest.id);
  assert.equal(removedBundle.removed, true);
  assert.deepEqual(removedBundle.removedCommands, [bundleHelperCommand, bundleCommand].sort());
  assert.equal(fs.existsSync(bundleTarget), false);
  assert.equal(fs.existsSync(managedExtensionCommandMetadataPath(config, bundleCommand)), false);

  const removed = removeExtension(config, manifest.id);
  assert.equal(removed.removed, true);
  assert.equal(listInstalledExtensions(config).length, 0);
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
  for (const [name, data] of files) {
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
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(fileName.length, 28);
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
