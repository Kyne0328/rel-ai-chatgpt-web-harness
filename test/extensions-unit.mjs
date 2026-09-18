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
  managedExtensionCommandMetadataPath,
  managedExtensionCommandPath
} from '../src/extensions/paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extensions-'));
const config = { stateDir: root };
const catalogUrl = 'https://catalog.test/catalog.json';
const manifestUrl = 'https://catalog.test/sample/relai-extension.json';
const skillUrl = 'https://catalog.test/sample/SKILL.md';
const cliManifestUrl = 'https://catalog.test/auto-cli/relai-extension.json';
const cliSkillUrl = 'https://catalog.test/auto-cli/SKILL.md';
const cliArtifactUrl = 'https://downloads.test/auto-cli';
const skill = `---\nname: sample-extension\ndescription: Sample Rel.AI extension used by the extension registry tests.\n---\n\n# Sample extension\n\nUse existing Rel.AI tools and authorization.\n`;
const cliSkill = `---\nname: auto-cli-extension\ndescription: Exercises verified automatic CLI installation through the Rel.AI extension registry.\n---\n\n# Auto CLI extension\n\nUse the managed fixture command.\n`;
const cliArtifact = Buffer.from('rel-ai managed CLI fixture\n', 'utf8');
const sha256 = crypto.createHash('sha256').update(skill).digest('hex');
const cliSkillSha256 = crypto.createHash('sha256').update(cliSkill).digest('hex');
const cliArtifactSha256 = crypto.createHash('sha256').update(cliArtifact).digest('hex');
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
const catalog = {
  schemaVersion: 1,
  updatedAt: '2026-09-18T00:00:00.000Z',
  extensions: [
    catalogEntry(manifest, manifestUrl, true),
    catalogEntry(cliManifest, cliManifestUrl, true)
  ]
};

assert.equal(parseExtensionManifest(manifest).id, 'sample-extension');
assert.equal(parseExtensionManifest(cliManifest).install.type, 'binary');
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

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const href = String(url);
  if (href === catalogUrl) return responseJson(catalog);
  if (href === manifestUrl) return responseJson(manifest);
  if (href === skillUrl) return new Response(skill, { status: 200 });
  if (href === cliManifestUrl) return responseJson(cliManifest);
  if (href === cliSkillUrl) return new Response(cliSkill, { status: 200 });
  if (href === cliArtifactUrl) return new Response(cliArtifact, { status: 200 });
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

function responseJson(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
