import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { workspaceWrite } from '../src/localRepoBridge.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-staged-fallback-'));
const wsRoot = path.join(tmp, 'repo');
fs.mkdirSync(wsRoot, { recursive: true });
const config = { stateDir: path.join(tmp, 'state') };
const workspace = { alias: 'repo', path: wsRoot };

try {
  // --- Single in-flight staged write: fallback is allowed ---
  const start = workspaceWrite(workspace, config, { stage: 'start', path: 'big.txt', content: 'chunk1\n' });
  assert.equal(start.ok, true, 'start should succeed');
  assert.match(start.writeId, /^op_[a-z0-9]+_[a-f0-9]{12}$/, 'start returns a writeId');
  const stagingDir = path.join(config.stateDir, 'write-staging', workspace.alias);
  const metadataPath = path.join(stagingDir, `${start.writeId}.json`);
  const payloadPath = path.join(stagingDir, `${start.writeId}.payload`);
  const startMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(startMetadata.chunkCount, 1, 'metadata tracks chunk count without storing chunk content');
  assert.equal(Object.hasOwn(startMetadata, 'chunks'), false, 'legacy JSON chunks array must not survive the hard cutover');
  assert.equal(fs.readFileSync(payloadPath, 'utf8'), 'chunk1\n', 'staged content is stored in the append-only payload file');

  // append WITHOUT writeId → falls back to the single staged write
  const append = workspaceWrite(workspace, config, { stage: 'append', content: 'chunk2\n' });
  assert.equal(append.ok, true, 'append without writeId should fall back to the single staged write');
  assert.equal(append.chunks, 2, 'append should accumulate to 2 chunks');
  const appendMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  assert.equal(appendMetadata.chunkCount, 2);
  assert.equal(appendMetadata.bytes, Buffer.byteLength('chunk1\nchunk2\n', 'utf8'));
  assert.equal(Object.hasOwn(appendMetadata, 'chunks'), false);
  assert.equal(fs.readFileSync(payloadPath, 'utf8'), 'chunk1\nchunk2\n', 'append extends only the payload file');

  // commit WITH a wrong-but-valid-format writeId → falls back to the single staged write
  const commit = workspaceWrite(workspace, config, { stage: 'commit', writeId: 'op_zzzzzzzz_000000000000' });
  assert.equal(commit.ok, true, 'commit with unknown writeId should fall back to the single staged write');
  assert.equal(fs.readFileSync(path.join(wsRoot, 'big.txt'), 'utf8'), 'chunk1\nchunk2\n', 'committed file has both chunks');
  assert.equal(fs.existsSync(metadataPath), false, 'commit clears staged metadata');
  assert.equal(fs.existsSync(payloadPath), false, 'commit clears staged payload content');

  // staged payload cleared after commit → a commit with no staged write left throws
  assert.throws(
    () => workspaceWrite(workspace, config, { stage: 'commit' }),
    /No staged edit payload found/,
    'commit with no staged writes left should throw a clear error'
  );

  // --- Multiple staged writes pending: fallback must REFUSE, not guess ---
  const a = workspaceWrite(workspace, config, { stage: 'start', path: 'fileA.txt', content: 'A\n' });
  const b = workspaceWrite(workspace, config, { stage: 'start', path: 'fileB.txt', content: 'B\n' });
  assert.ok(a.writeId && b.writeId && a.writeId !== b.writeId, 'two distinct staged writes pending');

  // commit with neither writeId nor path → must refuse (the bug that committed the wrong/stale file)
  assert.throws(
    () => workspaceWrite(workspace, config, { stage: 'commit' }),
    /Multiple staged edit payloads are pending/,
    'commit must refuse to guess among multiple pending staged writes'
  );
  assert.equal(fs.existsSync(path.join(wsRoot, 'fileA.txt')), false, 'no file should be written when commit refuses');
  assert.equal(fs.existsSync(path.join(wsRoot, 'fileB.txt')), false, 'no file should be written when commit refuses');

  // commit with a path → disambiguates to the matching staged write only
  const commitB = workspaceWrite(workspace, config, { stage: 'commit', path: 'fileB.txt' });
  assert.equal(commitB.ok, true, 'commit with path should resolve the matching staged write');
  assert.equal(fs.readFileSync(path.join(wsRoot, 'fileB.txt'), 'utf8'), 'B\n', 'fileB committed via path disambiguation');
  assert.equal(fs.existsSync(path.join(wsRoot, 'fileA.txt')), false, 'fileA must remain untouched');

  // now only fileA is pending → single fallback works again
  const commitA = workspaceWrite(workspace, config, { stage: 'commit' });
  assert.equal(commitA.ok, true, 'commit falls back to the remaining single staged write');
  assert.equal(fs.readFileSync(path.join(wsRoot, 'fileA.txt'), 'utf8'), 'A\n', 'fileA committed');

  const owned = workspaceWrite(workspace, config, { stage: 'start', work_id: 'owner-a', path: 'owned.txt', content: 'A' });
  for (const stage of ['append', 'commit', 'abort']) {
    assert.throws(() => workspaceWrite(workspace, config, {
      stage, work_id: 'owner-b', writeId: owned.writeId, ...(stage === 'append' ? { content: 'B' } : {})
    }), error => error.code === 'STAGED_EDIT_OWNER_MISMATCH', 'another work session cannot ' + stage + ' an exact staged payload');
  }
  assert.throws(() => workspaceWrite(workspace, config, { stage: 'append', work_id: 'owner-b', content: 'B' }),
    /No staged edit payload found/, 'fallback must never select a different task payload');
  workspaceWrite(workspace, config, { stage: 'start', work_id: 'owner-b', path: 'owned-b.txt', content: 'B' });
  workspaceWrite(workspace, config, { stage: 'append', work_id: 'owner-a', content: 'A2' });
  workspaceWrite(workspace, config, { stage: 'commit', work_id: 'owner-a' });
  assert.equal(fs.readFileSync(path.join(wsRoot, 'owned.txt'), 'utf8'), 'AA2');
  workspaceWrite(workspace, config, { stage: 'commit', work_id: 'owner-b' });
  assert.equal(fs.readFileSync(path.join(wsRoot, 'owned-b.txt'), 'utf8'), 'B',
    'each task retains fallback within its own payload set');

  console.log('Staged-write fallback unit test passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
