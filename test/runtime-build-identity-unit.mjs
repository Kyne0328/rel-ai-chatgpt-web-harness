import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeBuildIdentityReader, assessSourceParity } from '../src/runtimeBuildIdentity.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-runtime-identity-'));
const stamp = '2026-10-05T00:02:26.913Z';
const provenance = { schemaVersion: 1, version: '1.1.4', builtAt: stamp,
  sourceRevision: 'a'.repeat(40), sourceFingerprint: 'b'.repeat(64), dirty: true };
try {
  fs.writeFileSync(path.join(root, 'build-provenance.json'), JSON.stringify(provenance));
  let reads = 0;
  const reader = createRuntimeBuildIdentityReader({ packageRoot: root, startedAt: stamp,
    readFile(file) { reads += 1; return fs.readFileSync(file, 'utf8'); } });
  const identity = reader('same-schema-digest');
  assert.equal(identity.buildId, 'b'.repeat(12));
  assert.equal(identity.dirty, true);
  assert.equal(identity.sourceRevision, provenance.sourceRevision);
  assert.equal(identity.startedAt, stamp);
  assert.equal(identity.schemaDigest, 'same-schema-digest');
  assert.equal(identity.state, 'recorded');
  assert.equal(reads, 1);
  fs.writeFileSync(path.join(root, 'build-provenance.json'), JSON.stringify({ ...provenance,
    sourceRevision: 'c'.repeat(40), sourceFingerprint: 'd'.repeat(64), dirty: false }));
  for (let i = 0; i < 100; i += 1) assert.equal(reader('new-on-disk-schema'), identity);
  assert.equal(reads, 1, 'status polling must not re-read provenance or hash the repository');
  assert.equal(identity.sourceFingerprint, provenance.sourceFingerprint, 'a running process retains its launched package identity after an on-disk build changes');
  const restarted = createRuntimeBuildIdentityReader({ packageRoot: root, startedAt: '2026-10-05T01:00:00.000Z' })('same-schema-digest');
  assert.notEqual(restarted.buildId, identity.buildId);
  assert.notEqual(restarted.startedAt, identity.startedAt);
  assert.equal(restarted.sourceRevision, 'c'.repeat(40));
  assert.equal(restarted.dirty, false);
  assert.equal(assessSourceParity(identity).status, 'unknown', 'same release/schema metadata is not proof of current source bytes');
  assert.equal(assessSourceParity(identity, { sourceFingerprint: 'd'.repeat(64) }).status, 'different');
  assert.equal(assessSourceParity(identity, { sourceFingerprint: provenance.sourceFingerprint }).status, 'matches');
  const unavailable = createRuntimeBuildIdentityReader({ packageRoot: path.join(root, 'absent'), startedAt: stamp })('schema');
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.buildId, null);
  assert.equal(unavailable.dirty, null, 'missing provenance must not be reported as a clean build');
  assert.equal(assessSourceParity(unavailable, provenance).status, 'unknown');
  console.log('Runtime build provenance is cached per launched process and source parity is separate from release/schema agreement.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
