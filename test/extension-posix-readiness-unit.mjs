import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installLocalExtension, listInstalledExtensions } from '../src/extensions/registry.js';
import { managedExtensionBundleCommandPath, managedExtensionCommandMetadataPath, managedExtensionCommandPath } from '../src/extensions/paths.js';

if (process.platform === 'win32') {
  console.log('POSIX extension command readiness checks skipped on Windows.');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-posix-readiness-'));
  const config = { stateDir: path.join(root, 'state') };
  const originalPath = process.env.PATH;
  const bin = path.join(root, 'bin');
  const laterBin = path.join(root, 'later-bin');
  const targets = path.join(root, 'targets');
  for (const directory of [bin, laterBin, targets]) fs.mkdirSync(directory, { recursive: true });
  process.env.PATH = [bin, laterBin].join(path.delimiter);
  const executableTarget = path.join(targets, 'executable');
  const nonExecutableTarget = path.join(targets, 'non-executable');
  const directoryTarget = path.join(targets, 'directory');
  writeCommand(executableTarget, 0o755);
  writeCommand(nonExecutableTarget, 0o644);
  fs.mkdirSync(directoryTarget);
  try {
    writeCommand(path.join(bin, 'posix-executable'), 0o755);
    writeCommand(path.join(bin, 'posix-non-executable'), 0o644);
    fs.symlinkSync(executableTarget, path.join(bin, 'posix-executable-link'));
    fs.symlinkSync(nonExecutableTarget, path.join(bin, 'posix-non-executable-link'));
    fs.symlinkSync(path.join(targets, 'missing'), path.join(bin, 'posix-broken-link'));
    fs.mkdirSync(path.join(bin, 'posix-directory'));
    fs.symlinkSync(directoryTarget, path.join(bin, 'posix-directory-link'));
    writeCommand(path.join(bin, 'posix-later-executable'), 0o644);
    writeCommand(path.join(laterBin, 'posix-later-executable'), 0o755);
    for (const [command, ready] of [
      ['posix-executable', true], ['posix-non-executable', false],
      ['posix-executable-link', true], ['posix-non-executable-link', false],
      ['posix-broken-link', false], ['posix-directory', false],
      ['posix-directory-link', false], ['posix-later-executable', true]
    ]) {
      assertReadiness(await installFixture(command, command), command, ready);
      assertReadiness(readInstalled(command), command, ready);
    }
    for (const installType of ['binary', 'bundle']) {
      const id = `managed-${installType}`;
      const command = `relai-managed-${installType}-fixture`;
      assertReadiness(await installFixture(id, command), command, false);
      const relativePath = `bin/${command}`;
      const target = installType === 'bundle'
        ? managedExtensionBundleCommandPath(config, id, relativePath)
        : managedExtensionCommandPath(config, command);
      const metadataTarget = managedExtensionCommandMetadataPath(config, command);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.mkdirSync(path.dirname(metadataTarget), { recursive: true });
      writeCommand(target, 0o755);
      fs.writeFileSync(metadataTarget, JSON.stringify({
        schemaVersion: 1, extensionId: id, command, installType,
        ...(installType === 'bundle' ? { relativePath } : {})
      }));
      assertReadiness(readInstalled(id), command, true);
      fs.chmodSync(target, 0o644);
      assertReadiness(readInstalled(id), command, false);
      fs.chmodSync(target, 0o755);
      assertReadiness(readInstalled(id), command, true);
      fs.rmSync(target);
      fs.symlinkSync(executableTarget, target);
      assertReadiness(readInstalled(id), command, false);
    }
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
  async function installFixture(id, command) {
    const source = path.join(root, 'sources', id);
    const skill = '# POSIX readiness fixture\n';
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), skill);
    fs.writeFileSync(path.join(source, 'relai-extension.json'), JSON.stringify({
      schemaVersion: 1, id, name: id, version: '1.0.0',
      description: 'POSIX command readiness regression fixture.',
      kind: 'cli', compatibility: { relai: '*' }, publisher: { name: 'Rel.AI test' },
      repository: 'https://fixture.test/repository',
      permissions: ['workspace.read', 'command.execute'],
      requires: { commands: [command], platforms: [] },
      entrypoints: { skill: 'SKILL.md', command },
      files: [{ path: 'SKILL.md', sha256: crypto.createHash('sha256').update(skill).digest('hex') }]
    }));
    return installLocalExtension(config, source);
  }
  function readInstalled(id) {
    const installed = listInstalledExtensions(config).find(extension => extension.id === id);
    assert.ok(installed, `expected installed extension ${id}`);
    return installed;
  }
  console.log('POSIX system and managed extension readiness follows executable permissions.');
}
function writeCommand(target, mode) {
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(target, mode);
}
function assertReadiness(installed, command, ready) {
  assert.equal(installed.ready, ready, command);
  assert.equal(installed.status, ready ? 'ready' : 'needs_setup', command);
  assert.deepEqual(installed.missingCommands, ready ? [] : [command], command);
}
