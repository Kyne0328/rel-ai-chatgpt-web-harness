import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PUBLISHER_CATALOG_FILENAME,
  PUBLISHER_CONFIG_FILENAME,
  createPublisherExtension,
  initializePublisherRepository,
  readPublisherConfig,
  syncPublisherRepository,
  validatePublisherRepository
} from '../src/extensions/authoring.js';
import { installLocalExtension, listInstalledExtensions, parseExtensionCatalog, parseExtensionManifest } from '../src/extensions/registry.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-publisher-extensions-'));

try {
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.zip -text\n', 'utf8');
  const initialized = initializePublisherRepository(root, {
    namespace: 'kyne',
    publisherName: 'Kyne',
    publisherUrl: 'https://github.com/Kyne0328',
    repository: 'https://github.com/Kyne0328/kyne-relai-extensions',
    branch: 'main'
  });
  assert.equal(initialized.config.namespace, 'kyne');
  assert.equal(
    initialized.config.rawBaseUrl,
    'https://raw.githubusercontent.com/Kyne0328/kyne-relai-extensions/main'
  );
  assert.equal(fs.existsSync(path.join(root, PUBLISHER_CONFIG_FILENAME)), true);
  assert.equal(
    fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'),
    '*.zip -text\nextensions/** text=auto eol=lf\n',
    'publisher initialization must preserve existing attributes and append the extension-only LF rule'
  );

  const skill = createPublisherExtension(root, 'officecli', {
    name: 'Office CLI',
    description: 'Workflows for Office document automation through Rel.AI.'
  });
  assert.equal(skill.id, 'kyne.officecli');
  const skillManifest = parseExtensionManifest(JSON.parse(
    fs.readFileSync(path.join(root, 'extensions', 'officecli', 'relai-extension.json'), 'utf8')
  ));
  assert.equal(skillManifest.repository, 'https://github.com/Kyne0328/kyne-relai-extensions');
  assert.equal(skillManifest.publisher.name, 'Kyne');

  const cli = createPublisherExtension(root, 'apktool', {
    name: 'APK Tool',
    description: 'Android package inspection workflows for Rel.AI.',
    kind: 'cli',
    command: 'apktool'
  });
  assert.equal(cli.id, 'kyne.apktool');

  const referenceDir = path.join(root, 'extensions', 'officecli', 'references');
  fs.mkdirSync(referenceDir, { recursive: true });
  fs.writeFileSync(path.join(referenceDir, 'workflows.md'), '# Workflows\r\n', 'utf8');
  const synced = syncPublisherRepository(root);
  assert.deepEqual(synced.manifests.map(item => item.id).sort(), ['kyne.apktool', 'kyne.officecli']);

  const updatedSkillManifest = parseExtensionManifest(JSON.parse(
    fs.readFileSync(path.join(root, 'extensions', 'officecli', 'relai-extension.json'), 'utf8')
  ));
  assert.deepEqual(
    updatedSkillManifest.files.map(file => file.path).sort(),
    ['SKILL.md', 'references/workflows.md'].sort()
  );
  assert.equal(
    updatedSkillManifest.files.find(file => file.path === 'references/workflows.md').sha256,
    crypto.createHash('sha256').update('# Workflows\n', 'utf8').digest('hex'),
    'text package hashes must normalize CRLF to the LF bytes served by normal Git raw-content workflows'
  );

  const publisherCatalog = parseExtensionCatalog(JSON.parse(
    fs.readFileSync(path.join(root, PUBLISHER_CATALOG_FILENAME), 'utf8')
  ));
  assert.equal(publisherCatalog.extensions.length, 2);
  assert.deepEqual(
    publisherCatalog.extensions.map(entry => entry.manifestUrl).sort(),
    [
      'https://raw.githubusercontent.com/Kyne0328/kyne-relai-extensions/main/extensions/apktool/relai-extension.json',
      'https://raw.githubusercontent.com/Kyne0328/kyne-relai-extensions/main/extensions/officecli/relai-extension.json'
    ]
  );

  assert.deepEqual(validatePublisherRepository(root), {
    ok: true,
    root: path.resolve(root),
    errors: [],
    extensions: ['kyne.apktool', 'kyne.officecli']
  });

  const localState = path.join(root, '.local-relai-state');
  const localInstalled = await installLocalExtension(
    { stateDir: localState },
    path.join(root, 'extensions', 'officecli')
  );
  assert.equal(localInstalled.id, 'kyne.officecli');
  assert.equal(localInstalled.ready, true);
  assert.equal(listInstalledExtensions({ stateDir: localState }).some(item => item.id === 'kyne.officecli'), true);
  const localMetadata = JSON.parse(fs.readFileSync(path.join(localState, 'extensions', 'kyne.officecli', '.relai-install.json'), 'utf8'));
  assert.equal(localMetadata.localDevelopment, true);
  assert.equal(localMetadata.sourceDirectory, path.resolve(root, 'extensions', 'officecli'));
  assert.equal(fs.readFileSync(path.join(localState, 'extensions', 'kyne.officecli', 'references', 'workflows.md'), 'utf8'), '# Workflows\n');

  fs.appendFileSync(path.join(root, 'extensions', 'officecli', 'SKILL.md'), '\nChanged.\n', 'utf8');
  const stale = validatePublisherRepository(root);
  assert.equal(stale.ok, false);
  assert.ok(stale.errors.some(error => /stale/i.test(error)));

  syncPublisherRepository(root);
  assert.equal(validatePublisherRepository(root).ok, true);
  await installLocalExtension({ stateDir: localState }, path.join(root, 'extensions', 'officecli'));
  assert.match(fs.readFileSync(path.join(localState, 'extensions', 'kyne.officecli', 'SKILL.md'), 'utf8'), /Changed\./);

  const config = readPublisherConfig(root);
  assert.equal(config.publisher.url, 'https://github.com/Kyne0328');

  const oversized = path.join(root, 'extensions', 'officecli', 'oversized.bin');
  fs.writeFileSync(oversized, Buffer.alloc((1024 * 1024) + 1));
  assert.throws(
    () => syncPublisherRepository(root),
    /exceeds the 1048576-byte limit/i
  );
  fs.rmSync(oversized, { force: true });
  syncPublisherRepository(root);

  assert.throws(
    () => createPublisherExtension(root, 'Bad Name'),
    /lowercase letters, numbers, and single hyphens/i
  );
  assert.throws(
    () => createPublisherExtension(root, 'a'.repeat(80)),
    /at most 79/i
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Extension publisher monorepo authoring contracts passed.');
