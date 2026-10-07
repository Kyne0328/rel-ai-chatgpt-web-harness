import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WindowsProcessJob } from '../src/windowsProcessJob.ts';
import { readWindowsProcessJobArtifacts, verifyWindowsProcessJobArtifacts } from '../src/windowsProcessJobArtifacts.js';

// These are inert, fixture-owned bytes. No helper, compiler, or target is run.
// Integrity checks detect corruption/staleness, not malicious same-user package replacement.
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const names = ['windows-process-job.ps1', 'windows-process-job-host.cs',
  'windows-process-job-host.manifest.json', 'windows-process-job-host.exe', 'windows-process-job-host.csproj'];
const limits = [256 * 1024, 256 * 1024, 16 * 1024, 4 * 1024 * 1024, 16 * 1024];
const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const root = fs.mkdtempSync(path.join(process.env.REL_AI_EPHEMERAL_DIR || os.tmpdir(), 'relai-job-artifacts-'));
const fixtureDirectory = path.join(root, 'artifacts');
fs.mkdirSync(fixtureDirectory);
const nativeSource = '// Fixture-owned native source.\nclass FixtureOwner {}';
const embedded = Buffer.from('MZ fixture assembly, never executable');
const executable = Buffer.from('MZ fixture companion, never executable');
const hostSource = '// Fixture-owned controller source.\nclass FixtureHost {}\n';

function helperSource(assembly = embedded) {
  return ["$native = @'", nativeSource, "'@", '# BEGIN VERIFIED NATIVE ASSEMBLY',
    "$nativeSourceSha256 = '" + digest(nativeSource) + "'",
    "$nativeAssemblySha256 = '" + digest(assembly) + "'",
    "$nativeAssemblyBase64 = @'", assembly.toString('base64'), "'@", '# END VERIFIED NATIVE ASSEMBLY', ''].join('\n');
}

function validInput() {
  return {
    helperSource: helperSource(), hostSource, executableBytes: Buffer.from(executable), projectSource: '<Project />',
    manifest: { protocol: 1, runtime: 'clr4-anycpu', nativeSourceSha256: digest(nativeSource),
      hostSourceSha256: digest(hostSource), binarySha256: digest(executable), binaryBytes: executable.length }
  };
}

function writeFixture(input = validInput()) {
  const values = [input.helperSource, input.hostSource, JSON.stringify(input.manifest), input.executableBytes, input.projectSource];
  for (const [index, name] of names.entries()) fs.writeFileSync(path.join(fixtureDirectory, name), values[index]);
}

function rejectsInput(label, mutate, expected) {
  const input = validInput();
  mutate(input);
  assert.throws(() => verifyWindowsProcessJobArtifacts(input), expected, label);
}

// The constructor keeps its real fixed package paths. Redirect only reads of
// the four known artifact names, synchronously, and always restore the method.
// No public path override and no writes to shipped source/artifacts are needed.
function constructWithFixture() {
  const originalOpen = fs.openSync;
  const reads = [];
  const redirects = new Map(names.map(name => [path.resolve(sourceDirectory, name), path.join(fixtureDirectory, name)]));
  fs.openSync = function(file, ...args) {
    const target = typeof file === 'string' ? redirects.get(path.resolve(file)) : undefined;
    if (!target) return originalOpen.call(this, file, ...args);
    assert.equal(args[0], 'r', 'artifact injection is read-only');
    reads.push(path.basename(file));
    return originalOpen.call(this, target, ...args);
  };
  try {
    return { job: new WindowsProcessJob(path.join(root, 'owned-job'), 'a'.repeat(64)), reads };
  } finally { fs.openSync = originalOpen; }
}

function assertCompanion() {
  const { job, reads } = constructWithFixture();
  assert.deepEqual(reads, names, 'the real constructor verifies all four artifacts');
  assert.equal(job.executable, path.join(sourceDirectory, names[3]));
  assert.deepEqual(job.args, ['-RequestPath', path.join(job.directory, 'request.json'),
    '-ReceiptPath', path.join(job.directory, 'receipt.json'), '-ControlPath', path.join(job.directory, 'control.json')]);
}

function assertFallback(label) {
  const { job, reads } = constructWithFixture();
  assert.ok(reads.length > 0, label + ': verification was attempted');
  assert.equal(job.executable, path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), label);
  assert.deepEqual(job.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(sourceDirectory, names[0]), '-RequestPath', path.join(job.directory, 'request.json'),
    '-ReceiptPath', path.join(job.directory, 'receipt.json'), '-ControlPath', path.join(job.directory, 'control.json')], label);
}

try {
  const proof = verifyWindowsProcessJobArtifacts(validInput());
  assert.equal(proof.fallback.sourceSha256, digest(nativeSource));
  assert.equal(proof.fallback.assemblySha256, digest(embedded));
  assert.equal(proof.fallback.assemblyBytes, embedded.length);
  assert.equal(proof.companion.binarySha256, digest(executable));
  assert.equal(proof.companion.binaryBytes, executable.length);
  for (const value of [proof, proof.fallback, proof.companion]) assert.equal(Object.isFrozen(value), true);
  const crlf = validInput();
  crlf.helperSource = crlf.helperSource.replace(/\n/g, '\r\n');
  crlf.hostSource = crlf.hostSource.replace(/\n/g, '\r\n');
  assert.deepEqual(verifyWindowsProcessJobArtifacts(crlf), proof, 'line endings do not invalidate canonical source hashes');

  for (const [key, expected] of [
    ['helperSource', /Missing native PowerShell source/], ['hostSource', /Missing native controller source/],
    ['manifest', /Missing native executable provenance/], ['executableBytes', /Missing native executable bytes/]
  ]) rejectsInput('missing ' + key, input => { delete input[key]; }, expected);
  rejectsInput('array manifest', input => { input.manifest = []; }, /Missing native executable provenance/);
  rejectsInput('non-Buffer executable', input => { input.executableBytes = new Uint8Array(executable); }, /Missing native executable bytes/);
  rejectsInput('missing native source', input => { input.helperSource = input.helperSource.replace('$native =', '$missing ='); }, /Missing native owner source/);
  rejectsInput('missing embedded assembly', input => { input.helperSource = input.helperSource.replace('BEGIN VERIFIED', 'BEGIN MISSING'); }, /Missing embedded native assembly/);
  rejectsInput('stale embedded source', input => { input.helperSource = input.helperSource.replace('class FixtureOwner', 'class ChangedOwner'); }, /Embedded native owner source is stale/);
  rejectsInput('missing assembly bytes', input => { input.helperSource = input.helperSource.replace(embedded.toString('base64'), ''); }, /Missing or oversized embedded assembly/);
  rejectsInput('oversized assembly', input => { input.helperSource = input.helperSource.replace(embedded.toString('base64'), 'A'.repeat(256 * 1024 + 4)); }, /Missing or oversized embedded assembly/);
  rejectsInput('noncanonical Base64', input => { input.helperSource = input.helperSource.replace(embedded.toString('base64'), 'TVo==='); }, /not canonical Base64/);
  rejectsInput('tampered embedded bytes', input => { input.helperSource = input.helperSource.replace(embedded.toString('base64'), Buffer.from('MZ tampered').toString('base64')); }, /Embedded assembly digest mismatch/);
  rejectsInput('non-PE embedded bytes with matching hash', input => { input.helperSource = helperSource(Buffer.from('not a PE')); }, /Embedded assembly is not a PE image/);
  for (const [field, value, expected] of [
    ['protocol', 2, /Unknown native executable provenance protocol/], ['runtime', 'unknown', /Unknown native executable runtime/],
    ['nativeSourceSha256', '0'.repeat(64), /Native executable owner source is stale/],
    ['hostSourceSha256', '0'.repeat(64), /Native executable controller source is stale/],
    ['binarySha256', '0'.repeat(64), /Native executable digest mismatch/]
  ]) rejectsInput('manifest ' + field, input => { input.manifest[field] = value; }, expected);
  rejectsInput('changed controller source', input => { input.hostSource += '// changed\n'; }, /Native executable controller source is stale/);
  for (const size of [0, -1, 0.5, '5', NaN, Number.MAX_SAFE_INTEGER + 1, 4 * 1024 * 1024 + 1]) {
    rejectsInput('invalid binary size ' + size, input => { input.manifest.binaryBytes = size; }, /Invalid native executable size/);
  }
  rejectsInput('truncated executable', input => { input.executableBytes = input.executableBytes.subarray(0, -1); }, /Native executable size mismatch/);
  const aot = validInput();
  aot.manifest.runtime = 'nativeaot-win-x64';
  aot.manifest.projectSourceSha256 = digest(aot.projectSource);
  assert.equal(verifyWindowsProcessJobArtifacts(aot).companion.runtime, 'nativeaot-win-x64');
  assert.throws(() => verifyWindowsProcessJobArtifacts({ ...aot, projectSource: undefined }), /Missing native AOT build configuration/);
  assert.throws(() => verifyWindowsProcessJobArtifacts({ ...aot, projectSource: '<Changed />' }), /build configuration is stale/);
  writeFixture(aot);
  assertCompanion();
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  try {
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    assertFallback('unsupported native companion architecture');
  } finally { Object.defineProperty(process, 'arch', archDescriptor); }
  rejectsInput('same-size executable corruption', input => { input.executableBytes[2] ^= 1; }, /Native executable digest mismatch/);
  rejectsInput('non-PE companion with matching hash', input => {
    input.executableBytes[0] = 0;
    input.manifest.binarySha256 = digest(input.executableBytes);
  }, /Native executable is not a PE image/);

  writeFixture();
  const verified = readWindowsProcessJobArtifacts(fixtureDirectory);
  assert.equal(verified.executable, path.join(fixtureDirectory, names[3]));
  assert.deepEqual(verified.proof, proof);
  assert.equal(Object.isFrozen(verified), true);
  assertCompanion();
  const ignoredPath = validInput();
  ignoredPath.manifest.executable = path.join(root, 'must-not-select.exe');
  writeFixture(ignoredPath);
  assert.equal(readWindowsProcessJobArtifacts(fixtureDirectory).executable, path.join(fixtureDirectory, names[3]));
  assertCompanion();

  for (const [index, name] of names.entries()) {
    writeFixture();
    const file = path.join(fixtureDirectory, name);
    fs.unlinkSync(file);
    assert.throws(() => readWindowsProcessJobArtifacts(fixtureDirectory), { code: 'ENOENT' }, 'missing ' + name);
    assertFallback('missing ' + name);
    writeFixture();
    fs.writeFileSync(file, Buffer.alloc(limits[index] + 1));
    assert.throws(() => readWindowsProcessJobArtifacts(fixtureDirectory), /bounded regular file/, 'oversized ' + name);
    assertFallback('oversized ' + name);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    try {
      // Some platforms refuse to open a directory before fstat can reject it.
      assert.throws(() => readWindowsProcessJobArtifacts(fixtureDirectory), /bounded regular file|EISDIR|EPERM|EACCES/, 'directory ' + name);
      assertFallback('directory ' + name);
    } finally { fs.rmdirSync(file); }
  }

  for (const [label, mutate, expected] of [
    ['stale native source', input => { input.helperSource = input.helperSource.replace('class FixtureOwner', 'class ChangedOwner'); }, /source is stale/],
    ['tampered embedded assembly', input => { input.helperSource = input.helperSource.replace(embedded.toString('base64'), Buffer.from('MZ changed').toString('base64')); }, /Embedded assembly digest mismatch/],
    ['stale controller source', input => { input.hostSource += '// changed'; }, /controller source is stale/],
    ['tampered companion', input => { input.executableBytes[2] ^= 1; }, /digest mismatch/],
    ['stale provenance', input => { input.manifest.hostSourceSha256 = '0'.repeat(64); }, /controller source is stale/],
    ['unknown provenance', input => { input.manifest.protocol = 2; }, /Unknown native executable provenance/]
  ]) {
    const input = validInput();
    mutate(input);
    writeFixture(input);
    assert.throws(() => readWindowsProcessJobArtifacts(fixtureDirectory), expected, label);
    assertFallback(label);
    writeFixture();
    assertCompanion();
  }
  for (const manifest of ['{', 'null', '[]']) {
    writeFixture();
    fs.writeFileSync(path.join(fixtureDirectory, names[2]), manifest);
    assert.throws(() => readWindowsProcessJobArtifacts(fixtureDirectory), undefined, 'malformed manifest ' + manifest);
    assertFallback('malformed manifest ' + manifest);
  }

  // Accept each documented maximum, not only tiny happy-path fixtures.
  const maximum = validInput();
  maximum.helperSource += ' '.repeat(limits[0] - Buffer.byteLength(maximum.helperSource));
  maximum.hostSource += ' '.repeat(limits[1] - Buffer.byteLength(maximum.hostSource));
  maximum.manifest.hostSourceSha256 = digest(maximum.hostSource);
  maximum.executableBytes = Buffer.alloc(limits[3]);
  maximum.executableBytes.write('MZ');
  maximum.manifest.binaryBytes = maximum.executableBytes.length;
  maximum.manifest.binarySha256 = digest(maximum.executableBytes);
  writeFixture(maximum);
  const manifestJson = JSON.stringify(maximum.manifest);
  fs.writeFileSync(path.join(fixtureDirectory, names[2]), manifestJson.padEnd(limits[2], ' '));
  assert.equal(readWindowsProcessJobArtifacts(fixtureDirectory).proof.companion.binaryBytes, limits[3]);
  assertCompanion();

  // Simulate a shrink/growth between fstat and read, confined to our own fd.
  for (const delta of [-1, 1]) {
    writeFixture();
    const originalOpen = fs.openSync;
    const originalStat = fs.fstatSync;
    const originalClose = fs.closeSync;
    let watchedFd;
    let closed = false;
    fs.openSync = function(file, ...args) {
      const fd = originalOpen.call(this, file, ...args);
      if (file === path.join(fixtureDirectory, names[0])) watchedFd = fd;
      return fd;
    };
    fs.fstatSync = function(fd, ...args) {
      const stat = originalStat.call(this, fd, ...args);
      if (fd === watchedFd) stat.size += delta;
      return stat;
    };
    fs.closeSync = function(fd, ...args) {
      if (fd === watchedFd) closed = true;
      return originalClose.call(this, fd, ...args);
    };
    try {
      assert.throws(() => readWindowsProcessJobArtifacts(fixtureDirectory), /changed size during its bounded read/);
      assert.equal(closed, true, 'failed bounded reads close the owned descriptor');
    } finally {
      fs.openSync = originalOpen;
      fs.fstatSync = originalStat;
      fs.closeSync = originalClose;
    }
  }
  writeFixture();
  assertCompanion();
  console.log('Windows artifact integrity, freshness, bounded reads, and real constructor selection/fallback tests passed without executing native code.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
