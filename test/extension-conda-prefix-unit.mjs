import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { makeProcessEnvironment } from '../src/processEnvironment.js';

// Retain the real native process implementation in production. This existing
// installer-stage fixture substitutes only its external process result; native
// process ownership has separate bounded real-process probes.
const processFacade = new URL('../src/process.js', import.meta.url).href;
const processImplementation = new URL('../src/process.ts', import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== processFacade) return nextLoad(url, context);
    return {
      format: 'module', shortCircuit: true,
      source: `export * from ${JSON.stringify(processImplementation)}; export const runProcess = (...args) => globalThis.__relaiCondaFixtureRun(...args);`
    };
  }
});
const { installLocalExtension, listInstalledExtensions } = await import('../src/extensions/registry.js');

// Network and the external manager are fixtures. The registry's package hashing,
// on-disk staging, promotion, rollback, metadata, and readiness are real.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-conda-prefix-'));
const config = { stateDir: path.join(root, 'state') };
const source = path.join(root, 'source');
const id = 'conda-prefix-fixture';
const command = 'relai-conda-prefix-fixture';
const commandPath = process.platform === 'win32' ? `Scripts/${command}.exe` : `bin/${command}`;
const expectedPrefix = path.join(config.stateDir, 'extensions', id, '.tool');
const managerBytes = Buffer.from('mocked micromamba runtime; never executed');
const packageBytes = Buffer.from('mocked conda package; never executed');
const registrySource = fs.readFileSync(new URL('../src/extensions/registry.js', import.meta.url), 'utf8');
const managerPin = registrySource.match(new RegExp(`'${process.platform}/${process.arch}': \\{ url: '[^']+', sha256: '([a-f0-9]{64})'`))?.[1];
assert.ok(managerPin, 'fixture host must have a pinned manager target');
const original = { fetch: globalThis.fetch, createHash: crypto.createHash };
const savedEnvironment = Object.fromEntries(['PATH', 'REL_AI_MCP_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'REL_AI_REQUEST_STATE_KEY', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
const lockUrl = 'https://fixture.test/conda/lock.json';
const packageUrl = 'https://fixture.test/conda/tool-1.0-0.conda';
const skill = '# Conda prefix fixture\n';
const subdir = process.platform === 'win32' ? 'win-64'
  : process.platform === 'darwin' ? (process.arch === 'arm64' ? 'osx-arm64' : 'osx-64')
    : process.arch === 'arm64' ? 'linux-aarch64' : 'linux-64';
const digest = content => original.createHash('sha256').update(content).digest('hex');
const lockBytes = Buffer.from(JSON.stringify({
  schemaVersion: 1, subdir,
  packages: [{ url: packageUrl, sha256: digest(packageBytes), size: packageBytes.length }]
}));
let failManager = false;
let managerCalls = 0;
const prefixOnly = process.argv[2] === 'prefix';
process.env.PATH = path.join(root, 'safe-bin');
process.env.REL_AI_MCP_TOKEN = 'synthetic-installer-token';
process.env.AWS_SECRET_ACCESS_KEY = 'synthetic-installer-key';
process.env.REL_AI_REQUEST_STATE_KEY = 'synthetic-request-state-key';
process.env.TEMP = root;
process.env.TMP = root;
globalThis.fetch = async url => {
  const href = String(url);
  if (href === lockUrl) return new Response(lockBytes);
  if (href === packageUrl) return new Response(packageBytes);
  assert.match(href, /^https:\/\/github\.com\/mamba-org\/micromamba-releases\//);
  return new Response(managerBytes);
};
// Only the external manager fixture's digest is substituted for the reviewed
// pin. Lock, package, and extension-file digests still use real SHA-256.
crypto.createHash = function(...args) {
  const hash = original.createHash(...args);
  const update = hash.update.bind(hash);
  const finish = hash.digest.bind(hash);
  const chunks = [];
  hash.update = function(value, encoding) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value, encoding));
    update(value, encoding);
    return hash;
  };
  hash.digest = function(encoding) {
    if (args[0] === 'sha256' && Buffer.concat(chunks).equals(managerBytes)) {
      return encoding ? Buffer.from(managerPin, 'hex').toString(encoding) : Buffer.from(managerPin, 'hex');
    }
    return finish(encoding);
  };
  return hash;
};
globalThis.__relaiCondaFixtureRun = async function(executable, args, options) {
  managerCalls += 1;
  assert.match(executable, /micromamba(?:\.exe)?$/);
  assert.equal(options.nativeOwnership, true, 'Conda execution must keep native ownership.');
  assert.ok(options.timeout > 0, 'Conda execution must remain bounded.');
  const filteredEnv = makeProcessEnvironment(options.env);
  if (!prefixOnly) {
    assert.equal(filteredEnv.REL_AI_MCP_TOKEN, undefined);
    assert.equal(filteredEnv.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(filteredEnv.REL_AI_REQUEST_STATE_KEY, undefined);
    assert.equal(filteredEnv.TEMP, root);
    assert.equal(filteredEnv.TMP, root);
    assert.ok(filteredEnv.PATH.split(path.delimiter).includes(path.join(root, 'safe-bin')));
    for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'HOME', 'USERPROFILE']) {
      if (process.env[key] != null) assert.equal(filteredEnv[key], process.env[key]);
    }
  }
  assert.equal(options.env.MAMBA_NO_BANNER, '1');
  assert.ok(args.includes('--offline'));
  assert.ok(args.includes('--no-rc'));
  const prefix = args[args.indexOf('--prefix') + 1];
  const relocation = args.includes('--relocate-prefix') ? args[args.indexOf('--relocate-prefix') + 1] : prefix;
  assert.notEqual(prefix, expectedPrefix, 'installation must remain isolated in staging');
  const target = path.join(prefix, commandPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ embeddedPrefix: relocation }));
  fs.writeFileSync(path.join(prefix, 'runtime-data.txt'), 'prefix data');
  return {
    executed: true, rootExitConfirmed: true, terminationConfirmed: true,
    timedOut: false, cancelled: false, exitCode: failManager ? 1 : 0,
    stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0,
    stdoutTruncated: false, stderrTruncated: false
  };
};
syncBuiltinESMExports();
try {
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), skill);
  const writeManifest = version => fs.writeFileSync(path.join(source, 'relai-extension.json'), JSON.stringify({
    schemaVersion: 1, id, name: 'Conda prefix fixture', version,
    description: 'Managed Conda prefix and environment regression fixture.', kind: 'cli',
    compatibility: { relai: '*' }, publisher: { name: 'Rel.AI tests' },
    repository: 'https://fixture.test/repository', permissions: ['workspace.read', 'command.execute'],
    requires: { commands: [command], platforms: [] }, entrypoints: { skill: 'SKILL.md', command },
    install: { type: 'conda', artifacts: [{ platform: process.platform, arch: process.arch, subdir,
      lockUrl, lockSha256: digest(lockBytes), commands: [{ command, path: commandPath }] }] },
    files: [{ path: 'SKILL.md', sha256: digest(skill) }]
  }));
  for (const version of ['1.0.0', '2.0.0']) {
    writeManifest(version);
    const installed = await installLocalExtension(config, source);
    assert.equal(installed.ready, true);
    assert.equal(installed.version, version);
    const executable = JSON.parse(fs.readFileSync(path.join(expectedPrefix, commandPath), 'utf8'));
    assert.equal(executable.embeddedPrefix, expectedPrefix, 'prefix-bound files must reference their permanent installed location');
    assert.equal(fs.readFileSync(path.join(executable.embeddedPrefix, 'runtime-data.txt'), 'utf8'), 'prefix data');
  }
  failManager = true;
  writeManifest('3.0.0');
  await assert.rejects(installLocalExtension(config, source), /installation failed/i);
  assert.equal(listInstalledExtensions(config).find(item => item.id === id)?.version, '2.0.0');
  assert.equal(fs.readdirSync(path.join(config.stateDir, 'extensions')).some(name => name.startsWith('.install-')), false);
  assert.equal(managerCalls, 3);
  console.log('Conda staging preserves final prefixes, filtered installer environment, and failed-upgrade rollback.');
} finally {
  globalThis.fetch = original.fetch;
  delete globalThis.__relaiCondaFixtureRun;
  crypto.createHash = original.createHash;
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
}
