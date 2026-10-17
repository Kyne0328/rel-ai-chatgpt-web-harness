import assert from 'node:assert/strict';
import { cacheStats, setCachedRead, getCachedRead, invalidateAll, invalidateAlias, invalidatePath } from '../src/sessionCache.js';

// Full stat signatures reject timestamp-preserving replacements for both caches.
const { getCachedReadEntry, getCachedFileMetadata, setCachedFileMetadata } = await import('../src/sessionCache.js');
const originalStat = { mtimeMs: 10, ctimeMs: 20, size: 3, dev: 1, ino: 100 };
const oldMetadata = { sha256: 'old-hash', bytes: 3, totalLines: 1 };
for (const changed of [
  { ...originalStat, size: 35 },
  { ...originalStat, ctimeMs: 21 },
  { ...originalStat, ino: 101 },
  { ...originalStat, dev: 2 }
]) {
  setCachedRead('freshness', '/file', originalStat, 'old', oldMetadata);
  setCachedFileMetadata('freshness', '/file', originalStat, oldMetadata);
  assert.equal(getCachedReadEntry('freshness', '/file', { ...originalStat })?.content, 'old');
  assert.equal(getCachedFileMetadata('freshness', '/file', { ...originalStat })?.sha256, 'old-hash');
  assert.equal(getCachedReadEntry('freshness', '/file', changed), null);
  assert.equal(getCachedFileMetadata('freshness', '/file', changed), null);
}

invalidateAll();
const size = 512 * 1024;
for (let i = 0; i < 80; i += 1) {
  const content = String(i).padStart(8, '0') + 'x'.repeat(size - 8);
  setCachedRead('budget', 'file-' + i, 1, content);
}
const stats = cacheStats();
assert.equal(stats.maxRetainedBytes, 32 * 1024 * 1024);
assert.equal(stats.retainedBytes, stats.maxRetainedBytes);
assert.equal(stats.entries, 64);
assert.ok(stats.evictions >= 16);
assert.equal(getCachedRead('budget', 'file-0', 1), null, 'oldest large reads evict first');
assert.ok(getCachedRead('budget', 'file-79', 1)?.startsWith('00000079'));
setCachedRead('budget', 'file-79', 2, 'small');
assert.equal(cacheStats().retainedBytes, stats.retainedBytes - size + 5);
invalidatePath('budget', 'file-78');
assert.equal(cacheStats().retainedBytes, stats.retainedBytes - size * 2 + 5);
setCachedRead('other', 'small', 1, 'still cached');
invalidateAlias('budget');
assert.equal(cacheStats().retainedBytes, 12);
assert.equal(getCachedRead('other', 'small', 1), 'still cached');
invalidateAll();
assert.equal(cacheStats().retainedBytes, 0);
assert.equal(cacheStats().entries, 0);
console.log(JSON.stringify({ submittedContentBytes: 80 * size, retainedContentBytes: stats.retainedBytes, evictions: stats.evictions, heapClaim: 'not measured' }));
