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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extensions-'));
const config = { stateDir: root };
const catalogUrl = 'https://catalog.test/catalog.json';
const manifestUrl = 'https://catalog.test/sample/relai-extension.json';
const skillUrl = 'https://catalog.test/sample/SKILL.md';
const skill = `---\nname: sample-extension\ndescription: Sample Rel.AI extension used by the extension registry tests.\n---\n\n# Sample extension\n\nUse existing Rel.AI tools and authorization.\n`;
const sha256 = crypto.createHash('sha256').update(skill).digest('hex');
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
const catalog = {
  schemaVersion: 1,
  updatedAt: '2026-09-16T00:00:00.000Z',
  extensions: [{
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    kind: manifest.kind,
    manifestUrl,
    repository: manifest.repository,
    publisher: manifest.publisher.name,
    permissions: manifest.permissions,
    featured: true
  }]
};

assert.equal(parseExtensionManifest(manifest).id, 'sample-extension');
assert.throws(() => parseExtensionManifest({ ...manifest, entrypoints: { skill: '../SKILL.md' } }), /entrypoints\.skill/i);
assert.throws(() => parseExtensionManifest({ ...manifest, kind: 'cli', entrypoints: { skill: 'SKILL.md', command: 'sample-cli' } }), /requires\.commands/i);

const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  const href = String(url);
  if (href === catalogUrl) return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } });
  if (href === manifestUrl) return new Response(JSON.stringify(manifest), { status: 200, headers: { 'content-type': 'application/json' } });
  if (href === skillUrl) return new Response(skill, { status: 200, headers: { 'content-type': 'text/markdown' } });
  return new Response('not found', { status: 404 });
};

try {
  const installed = await installExtension(config, manifest.id, { catalogUrl });
  assert.equal(installed.ready, true);
  assert.equal(listInstalledExtensions(config)[0]?.version, '1.0.0');

  const skills = discoverSkills({ path: root }, { config, userRoot: path.join(root, 'user-skills') });
  const extensionSkill = skills.find(item => item.name === 'sample-extension');
  assert.equal(extensionSkill?.source, 'extension');
  assert.equal(extensionSkill?.path, 'extension:sample-extension');

  const dashboard = await extensionDashboard(config, { catalogUrl });
  assert.equal(dashboard.catalog[0]?.installed, true);
  assert.equal(dashboard.catalog[0]?.updateAvailable, false);

  const removed = removeExtension(config, manifest.id);
  assert.equal(removed.removed, true);
  assert.equal(listInstalledExtensions(config).length, 0);
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Extension registry contracts passed.');
