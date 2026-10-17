import assert from 'node:assert/strict';

import {
  repositoryFreshness,
  repositoryIndexChanged,
  repositoryIndexSnapshot
} from '../src/repository/intelligence/state.js';

const current = {
  dirty: false,
  metadata: {
    generation: 7,
    freshness: 'current',
    truncated: false,
    needsReconcile: false,
    ignoredRuntimeField: 'not-forwarded-to-workers'
  }
};

assert.deepEqual(repositoryIndexSnapshot(current), {
  dirty: false,
  metadata: {
    generation: 7,
    freshness: 'current',
    truncated: false,
    needsReconcile: false
  }
});
assert.equal(repositoryFreshness(current, { id: 7 }), 'current');
assert.equal(repositoryIndexChanged(current, 7), false);
assert.equal(repositoryIndexChanged(current, 6), true,
  'a query result must be rejected when the committed graph generation changed');

const dirty = { ...current, dirty: true };
assert.equal(repositoryFreshness(dirty, 7), 'stale');
assert.equal(repositoryIndexChanged(dirty, 7), true,
  'pending source mutations must invalidate a query even before a new generation commits');

const partial = {
  dirty: false,
  metadata: { generation: 7, freshness: 'partial', truncated: true, needsReconcile: true }
};
assert.equal(repositoryFreshness(partial, 7), 'partial',
  'coverage-only reconciliation remains partial when the generation is consistent');
assert.equal(repositoryFreshness({ ...partial, dirty: true }, 7), 'stale',
  'source mutations must outrank the partial coverage label');
assert.equal(repositoryFreshness({ ...partial, metadata: { ...partial.metadata, freshness: 'runtime-stale' } }, 7), 'stale',
  'explicit stale evidence must outrank the partial coverage label');
assert.equal(repositoryFreshness(partial, 6), 'cached-unverified',
  'partial coverage must not hide a mismatched requested generation');
assert.equal(repositoryFreshness({
  dirty: false,
  metadata: { generation: 7, freshness: 'current', truncated: true, needsReconcile: true }
}, 7), 'partial', 'truncated indexes remain partial even when reconciliation is also pending');

assert.equal(repositoryFreshness({
  dirty: false,
  metadata: { generation: 7, freshness: 'current', truncated: false, needsReconcile: true }
}, 7), 'stale');

assert.equal(repositoryFreshness({
  dirty: false,
  metadata: { generation: 7, freshness: 'runtime-stale', truncated: false, needsReconcile: false }
}, 7), 'stale');

assert.equal(repositoryFreshness(current, { id: 6 }), 'cached-unverified',
  'cached context must not claim a different requested generation is current');
assert.deepEqual(repositoryIndexSnapshot({ dirty: true, metadata: null }), { dirty: true, metadata: null });

console.log('Repository Intelligence canonical freshness and generation state tests passed.');
