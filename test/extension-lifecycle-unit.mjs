import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { installLocalExtension, removeExtension } from '../src/extensions/registry.js';
import { managedExtensionCommandPath, managedExtensionCommandMetadataPath } from '../src/extensions/paths.js';
import { discoverSkills } from '../src/skillDiscovery.js';
import { recoverInterruptedExtensionInstalls } from '../src/extensions/installTransaction.js';

const observe = process.argv.includes('--observe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extension-lifecycle-'));
const previous = { fetch: globalThis.fetch, path: process.env.PATH, rm: fs.rmSync, rename: fs.renameSync };
const artifact = Buffer.from('Benign fixture bytes; never executed.\n');
const command = 'relai-lifecycle-fixture';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = fn => { if (!observe) fn(); };
function sourceAt(name, id, version = '1.0.0', cli = true) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const skill = '# Lifecycle fixture\n';
  fs.writeFileSync(path.join(directory, 'SKILL.md'), skill);
  const manifest = {
    schemaVersion: 1, id, name: id, version, description: 'Own temporary lifecycle fixture.',
    kind: cli ? 'cli' : 'skill', compatibility: { relai: '*' }, publisher: { name: 'Fixture' },
    repository: 'https://fixture.test/repository', permissions: cli ? ['command.execute'] : [],
    requires: { commands: cli ? [command] : [], platforms: [] },
    entrypoints: { skill: 'SKILL.md', ...(cli ? { command } : {}) },
    ...(cli ? { install: { type: 'binary', artifacts: [{ platform: process.platform, arch: process.arch, url: 'https://fixture.test/artifact', sha256: digest(artifact) }] } } : {}),
    files: [{ path: 'SKILL.md', sha256: digest(skill) }]
  };
  fs.writeFileSync(path.join(directory, 'relai-extension.json'), JSON.stringify(manifest));
  return directory;
}
try {
  process.env.PATH = '';
  globalThis.fetch = async url => { assert.equal(String(url), 'https://fixture.test/artifact'); return new Response(artifact); };
  {
    const config = { stateDir: path.join(root, 'concurrent-state') };
    const outcomes = await Promise.allSettled([
      installLocalExtension(config, sourceAt('first', 'first-extension')),
      installLocalExtension(config, sourceAt('second', 'second-extension'))
    ]);
    const fulfilled = outcomes.filter(item => item.status === 'fulfilled').length;
    const owner = JSON.parse(fs.readFileSync(managedExtensionCommandMetadataPath(config, command), 'utf8')).extensionId;
    console.log(JSON.stringify({ case: 'concurrent-command-owner', fulfilled, owner, errors: outcomes.filter(item => item.status === 'rejected').map(item => item.reason.message) }));
    check(() => assert.equal(fulfilled, 1, 'two simultaneous installs must not both claim the same managed command'));
    check(() => assert.equal(outcomes.find(item => item.status === 'fulfilled').value.id, owner));
  }
  {
    const config = { stateDir: path.join(root, 'remove-race-state') };
    const source = sourceAt('remove-race', 'remove-race');
    await installLocalExtension(config, source);
    sourceAt('remove-race', 'remove-race', '2.0.0');
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    globalThis.fetch = async () => { entered.resolve(); await release.promise; return new Response(artifact); };
    const install = installLocalExtension(config, source);
    await entered.promise;
    let removal, removalError;
    try { removal = removeExtension(config, 'remove-race'); } catch (error) { removalError = error; }
    release.resolve();
    const updated = await install;
    console.log(JSON.stringify({ case: 'remove-during-install', removal, removalError: removalError?.code || removalError?.message, version: updated.version }));
    check(() => assert.equal(removalError?.code, 'EXTENSION_OPERATION_BUSY', 'removal must not claim success while an in-flight install can restore the package'));
    check(() => assert.equal(updated.version, '2.0.0'));
    check(() => assert.equal(removeExtension(config, 'remove-race').removed, true, 'retry after install must succeed'));
    globalThis.fetch = async () => new Response(artifact);
  }
  {
    const config = { stateDir: path.join(root, 'partial-state') };
    const id = 'partial-remove';
    await installLocalExtension(config, sourceAt('partial-source', id));
    const target = path.join(config.stateDir, 'extensions', id);
    let injected = false;
    // Any attempt to remove the original package is made to fail. Transactional
    // removal may rename it first, in which case reject that first rename instead.
    fs.rmSync = function(file, ...args) {
      if (path.resolve(String(file)) === target) {
        injected = true; throw Object.assign(new Error('Own fixture package is locked'), { code: 'EACCES' });
      }
      return previous.rm.call(fs, file, ...args);
    };
    fs.renameSync = function(from, to) {
      if (path.resolve(String(from)) === target) {
        injected = true; throw Object.assign(new Error('Own fixture package is locked'), { code: 'EACCES' });
      }
      return previous.rename.call(fs, from, to);
    };
    syncBuiltinESMExports();
    let error;
    try { removeExtension(config, id); } catch (caught) { error = caught; }
    finally { fs.rmSync = previous.rm; fs.renameSync = previous.rename; syncBuiltinESMExports(); }
    const retained = { package: fs.existsSync(target), command: fs.existsSync(managedExtensionCommandPath(config, command)), metadata: fs.existsSync(managedExtensionCommandMetadataPath(config, command)) };
    console.log(JSON.stringify({ case: 'partial-uninstall', injected, error: error?.code, retained }));
    check(() => assert.equal(injected, true));
    check(() => assert.equal(error?.code, 'EACCES'));
    check(() => assert.deepEqual(retained, { package: true, command: true, metadata: true }));
  }
  {
    const config = { stateDir: path.join(root, 'recovery-state') };
    const id = 'active-recovery';
    const source = sourceAt('recovery-source', id, '1.0.0', false);
    await installLocalExtension(config, source);
    sourceAt('recovery-source', id, '2.0.0', false);
    const target = path.join(config.stateDir, 'extensions', id);
    const recoveryUrl = new URL('../src/extensions/installTransaction.js', import.meta.url).href;
    let childResult;
    fs.renameSync = function(from, to) {
      const result = previous.rename.call(fs, from, to);
      if (!childResult && path.resolve(String(to)) === target && path.basename(String(from)).startsWith('.install-')) {
        const script = 'import { recoverInterruptedExtensionInstalls } from ' + JSON.stringify(recoveryUrl) + '; console.log(JSON.stringify(recoverInterruptedExtensionInstalls(' + JSON.stringify(config) + ')));';
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
        childResult = JSON.parse(child.stdout.trim());
      }
      return result;
    };
    syncBuiltinESMExports();
    let installed, installError;
    try { installed = await installLocalExtension(config, source); } catch (error) { installError = error; }
    finally { fs.renameSync = previous.rename; syncBuiltinESMExports(); }
    const packagePresent = fs.existsSync(path.join(target, 'relai-extension.json'));
    console.log(JSON.stringify({ case: 'active-cross-process-recovery', childResult, installed: installed?.version, error: installError?.message, packagePresent }));
    check(() => assert.equal(childResult.recovered, 0, 'another process must not recover a live install'));
    check(() => assert.equal(installed?.version, '2.0.0'));
    check(() => assert.equal(packagePresent, true));
  }
  if (!observe) {
    // Fail after package and command moves, then verify rollback as a unit.
    const config = { stateDir: path.join(root, 'command-rollback-state') };
    const id = 'command-rollback';
    await installLocalExtension(config, sourceAt('command-rollback-source', id));
    const target = path.join(config.stateDir, 'extensions', id);
    const commandPath = managedExtensionCommandPath(config, command);
    const metadataPath = managedExtensionCommandMetadataPath(config, command);
    const originalMetadata = fs.readFileSync(metadataPath);
    const failure = Object.assign(new Error('Own fixture metadata is locked'), { code: 'EACCES' });
    let injected = false;
    fs.renameSync = function(from, to) {
      if (!injected && path.resolve(String(from)) === metadataPath) { injected = true; throw failure; }
      return previous.rename.call(fs, from, to);
    };
    syncBuiltinESMExports();
    try { assert.throws(() => removeExtension(config, id), error => error === failure); }
    finally { fs.renameSync = previous.rename; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path.join(target, 'relai-extension.json')), true);
    assert.deepEqual(fs.readFileSync(commandPath), artifact);
    assert.deepEqual(fs.readFileSync(metadataPath), originalMetadata);
    assert.equal(fs.readdirSync(path.dirname(target)).some(name => name.startsWith('.install-transaction-')), false);
    console.log('partial command removal restores package, command and ownership metadata');
  }
  if (!observe) {
    const config = { stateDir: path.join(root, 'remove-cleanup-state') };
    const id = 'remove-cleanup';
    await installLocalExtension(config, sourceAt('remove-cleanup-source', id));
    const target = path.join(config.stateDir, 'extensions', id);
    let injected = false;
    fs.rmSync = function(file, ...args) {
      if (String(file).startsWith(path.dirname(target)) && path.basename(String(file)).startsWith('.removed-' + id + '-')) {
        injected = true;
        throw Object.assign(new Error('Own fixture removed-package cleanup is locked'), { code: 'EACCES' });
      }
      return previous.rm.call(fs, file, ...args);
    };
    syncBuiltinESMExports();
    let removal;
    try { removal = removeExtension(config, id); }
    finally { fs.rmSync = previous.rm; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    assert.equal(removal.removed, true);
    assert.equal(removal.cleanupPending, true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(managedExtensionCommandPath(config, command)), false);
    const recovery = recoverInterruptedExtensionInstalls(config);
    assert.equal(recovery.ok, true);
    assert.equal(recovery.recovered, 1);
    assert.equal(fs.existsSync(target), false, 'committed removal must not be rolled back');
    console.log('committed uninstall reports deferred cleanup and recovery completes it');
  }
  if (!observe) {
    const lockUrl = new URL('../src/extensions/operationLock.js', import.meta.url).href;
    const recoveryUrl = new URL('../src/extensions/installTransaction.js', import.meta.url).href;
    for (const phase of ['prepared', 'committed']) {
      const config = { stateDir: path.join(root, 'exited-owner-' + phase) };
      const directory = path.join(config.stateDir, 'extensions');
      const target = path.join(directory, 'exited-owner');
      const staging = path.join(directory, '.install-exited-owner');
      const backup = path.join(directory, '.backup-exited-owner');
      const setup = 'import fs from "node:fs"; import path from "node:path";'
        + 'import { acquireExtensionOperation } from ' + JSON.stringify(lockUrl) + ';'
        + 'import { beginExtensionInstallTransaction, markExtensionInstallCommitted } from ' + JSON.stringify(recoveryUrl) + ';'
        + 'const config = ' + JSON.stringify(config) + '; acquireExtensionOperation(config);'
        + 'const [target, staging, backup] = ' + JSON.stringify([target, staging, backup]) + ';'
        + 'fs.mkdirSync(target); fs.writeFileSync(path.join(target, "version"), "old");'
        + 'fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, "version"), "new");'
        + 'beginExtensionInstallTransaction(config, { id: "exited-owner", target, staging, backup, targetExisted: true, entries: [] });'
        + 'fs.renameSync(target, backup); fs.renameSync(staging, target);'
        + (phase === 'committed' ? 'markExtensionInstallCommitted(config, "exited-owner");' : '')
        + 'console.log(process.pid);';
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', setup], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(child.status, 0, child.stderr);
      assert.ok(fs.readdirSync(directory).some(name => name.startsWith('.operation-')), 'child intentionally exits without releasing its fixture lease');
      const result = recoverInterruptedExtensionInstalls(config);
      assert.equal(result.ok, true);
      assert.equal(result.recovered, 1);
      assert.equal(fs.readFileSync(path.join(target, 'version'), 'utf8'), phase === 'prepared' ? 'old' : 'new');
      assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.operation-')), false);
      assert.equal(recoverInterruptedExtensionInstalls(config).recovered, 0, 'recovery is repeatable');
      console.log(JSON.stringify({ case: 'exited-owner-' + phase, recovered: result.recovered, childPid: Number(child.stdout.trim()) }));
    }
  }
  {
    const repo = path.join(root, 'many-skills');
    for (let index = 0; index < 500; index += 1) {
      const name = 'skill-' + String(index).padStart(4, '0');
      const directory = path.join(repo, '.agents', 'skills', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: ' + name + '\ndescription: Tiny scan fixture\n---\n');
    }
    const metrics = {};
    const started = performance.now();
    const skills = discoverSkills({ path: repo }, { userRoot: path.join(root, 'absent-user-skills'), metrics });
    console.log(JSON.stringify({ case: '500-skill-work-budget', returned: skills.length, metrics, durationMs: performance.now() - started }));
    check(() => assert.equal(skills.length, 100));
    check(() => assert.ok(metrics.skillMetadataReads <= 100, 'a full high-priority result set must stop unnecessary metadata reads'));
  }
} finally {
  fs.rmSync = previous.rm; fs.renameSync = previous.rename; syncBuiltinESMExports();
  globalThis.fetch = previous.fetch;
  if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log(observe ? 'Lifecycle baseline observations recorded.' : 'Extension concurrency, uninstall, recovery and skill scan regressions passed.');
