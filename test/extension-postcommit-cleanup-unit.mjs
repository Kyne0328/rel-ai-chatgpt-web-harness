import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { installLocalExtension, listInstalledExtensions } from '../src/extensions/registry.js';
import { recoverInterruptedExtensionInstalls } from '../src/extensions/installTransaction.js';
import { managedExtensionCommandMetadataPath, managedExtensionCommandPath } from '../src/extensions/paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extension-cleanup-'));
const originalFetch = globalThis.fetch;
const originalPath = process.env.PATH;
const originalRmSync = fs.rmSync;
const artifactUrl = 'https://fixture.test/cleanup-cli';
const id = 'cleanup-cli-extension';
const command = 'relai-cleanup-cli-fixture';
const skill = '# Cleanup regression fixture\n';
let artifact = Buffer.from('old binary\n');
globalThis.fetch = async url => {
  assert.equal(String(url), artifactUrl);
  return new Response(artifact, { status: 200 });
};
process.env.PATH = '';
try {
  for (const failurePoint of ['package-backup', 'command-backup', 'metadata-backup']) {
    const config = { stateDir: path.join(root, failurePoint, 'state') };
    const source = path.join(root, failurePoint, 'source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), skill);
    const writeManifest = version => {
      fs.writeFileSync(path.join(source, 'relai-extension.json'), JSON.stringify({
        schemaVersion: 1, id, name: 'Cleanup fixture', version,
        description: 'Post-commit cleanup failure regression fixture.', kind: 'cli',
        compatibility: { relai: '*' }, publisher: { name: 'Rel.AI test' },
        repository: 'https://fixture.test/repository',
        permissions: ['workspace.read', 'command.execute'],
        requires: { commands: [command], platforms: [] },
        entrypoints: { skill: 'SKILL.md', command },
        install: { type: 'binary', artifacts: [{ platform: process.platform, arch: process.arch, url: artifactUrl, sha256: digest(artifact) }] },
        files: [{ path: 'SKILL.md', sha256: digest(skill) }]
      }));
    };
    artifact = Buffer.from('old binary\n');
    writeManifest('1.0.0');
    assert.equal((await installLocalExtension(config, source)).ready, true);
    artifact = Buffer.from('new binary\n');
    writeManifest('2.0.0');
    const extensionRoot = path.join(config.stateDir, 'extensions');
    const markerPath = path.join(extensionRoot, `.install-transaction-${id}.json`);
    let injected = false;
    let committedTransaction;
    fs.rmSync = function(file, options) {
      if (!injected && fs.existsSync(markerPath)) {
        const transaction = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        const expected = failurePoint === 'package-backup' ? transaction.backup
          : failurePoint === 'command-backup' ? transaction.entries[0].backupTarget
            : transaction.entries[0].backupMetadata;
        if (transaction.phase === 'committed' && path.resolve(String(file)) === path.resolve(expected)) {
          injected = true;
          committedTransaction = transaction;
          throw Object.assign(new Error(`Injected ${failurePoint} cleanup failure`), { code: 'EACCES' });
        }
      }
      return originalRmSync.call(fs, file, options);
    };
    syncBuiltinESMExports();
    let installed;
    try { installed = await installLocalExtension(config, source); }
    finally { fs.rmSync = originalRmSync; syncBuiltinESMExports(); }
    assert.equal(injected, true, `must exercise ${failurePoint}`);
    assert.equal(installed.version, '2.0.0');
    assert.equal(installed.ready, true);
    assert.equal(JSON.parse(fs.readFileSync(markerPath, 'utf8')).phase, 'committed');
    const manifestPath = path.join(extensionRoot, id, 'relai-extension.json');
    const commandPath = managedExtensionCommandPath(config, command);
    const metadataPath = managedExtensionCommandMetadataPath(config, command);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version, '2.0.0');
    assert.deepEqual(fs.readFileSync(commandPath), artifact);
    assert.equal(JSON.parse(fs.readFileSync(metadataPath, 'utf8')).sha256, digest(artifact));
    const recovery = recoverInterruptedExtensionInstalls(config);
    assert.equal(recovery.ok, true);
    assert.equal(recovery.recovered, 1);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(committedTransaction.backup), false);
    assert.equal(fs.existsSync(committedTransaction.entries[0].backupTarget), false);
    assert.equal(fs.existsSync(committedTransaction.entries[0].backupMetadata), false);
    assert.deepEqual(fs.readFileSync(commandPath), artifact);
    const listed = listInstalledExtensions(config).find(extension => extension.id === id);
    assert.equal(listed?.version, '2.0.0');
    assert.equal(listed?.ready, true);
  }
} finally {
  fs.rmSync = originalRmSync;
  syncBuiltinESMExports();
  globalThis.fetch = originalFetch;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  fs.rmSync(root, { recursive: true, force: true });
}
function digest(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
console.log('Committed extension upgrades survive cleanup failures and recover coherently.');
