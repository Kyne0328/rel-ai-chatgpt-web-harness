import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SUPPORT_POLICY_URL,
  assessSupportPolicy,
  createUpdateSupportPolicy,
  normalizeSupportPolicy,
  resolveSupportPolicyUrl
} from '../electron/update-support-policy.js';

const policy = normalizeSupportPolicy({
  schemaVersion: 1,
  minimumSupportedVersion: '0.25.0',
  minimumRecommendedVersion: '0.26.0',
  enforceAfter: '2026-09-01T00:00:00.000Z',
  emergencyBlockedVersions: ['0.25.2'],
  message: 'Please update Rel.AI MCP.',
  policyExpiresAt: '2027-01-01T00:00:00.000Z'
});
assert.ok(policy);
assert.equal(DEFAULT_SUPPORT_POLICY_URL.startsWith('https://raw.githubusercontent.com/'), true);
assert.equal(resolveSupportPolicyUrl({ isPackaged: true }, ''), DEFAULT_SUPPORT_POLICY_URL);
process.env.REL_AI_UPDATE_POLICY_URL = 'https://example.test/unofficial-policy.json';
assert.equal(resolveSupportPolicyUrl({ isPackaged: true }, ''), DEFAULT_SUPPORT_POLICY_URL);
assert.equal(resolveSupportPolicyUrl({ isPackaged: false }, ''), 'https://example.test/unofficial-policy.json');
delete process.env.REL_AI_UPDATE_POLICY_URL;
assert.ok(normalizeSupportPolicy({ ...policy, futureOptionalField: 'ignored by older clients' }), 'unknown policy keys must be ignored for forward compatibility');
assert.equal(normalizeSupportPolicy({ ...policy, minimumRecommendedVersion: '0.24.0' }), null);
assert.equal(normalizeSupportPolicy({ ...policy, minimumSupportedVersion: 'v0.25.0' }), null);

const beforeDeadline = Date.parse('2026-08-20T00:00:00.000Z');
const afterDeadline = Date.parse('2026-09-02T00:00:00.000Z');
assert.equal(assessSupportPolicy('0.26.0', policy, beforeDeadline).state, 'current');
assert.equal(assessSupportPolicy('0.27.0-beta.1', policy, beforeDeadline).state, 'current', 'beta-channel clients must still receive support-policy assessment');
assert.equal(assessSupportPolicy('0.25.5', policy, beforeDeadline).state, 'recommended');
assert.equal(assessSupportPolicy('0.24.9', policy, beforeDeadline).state, 'deprecated');
assert.equal(assessSupportPolicy('0.24.9', policy, afterDeadline).state, 'required');
assert.equal(assessSupportPolicy('0.25.2', policy, beforeDeadline).state, 'emergency_blocked');
assert.equal(assessSupportPolicy('0.24.9', { ...policy, policyExpiresAt: '2026-08-01T00:00:00.000Z' }, beforeDeadline).state, 'unavailable');
assert.equal(assessSupportPolicy('0.24.9', { ...policy, policyExpiresAt: '2026-08-01T00:00:00.000Z' }, beforeDeadline).canContinue, true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-support-policy-'));
const app = { getVersion: () => '0.24.9', getPath: () => root };
const remotePolicy = { ...policy, minimumRecommendedVersion: '0.25.0' };
const remote = createUpdateSupportPolicy({
  app,
  now: () => afterDeadline,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => remotePolicy }),
  setTimer: () => ({ unref() {} }),
  clearTimer: () => {}
});
const remoteStatus = await remote.refresh();
assert.equal(remoteStatus.state, 'required');
assert.equal(remoteStatus.source, 'remote');
assert.equal(remoteStatus.minimumSupportedVersion, '0.25.0');
assert.equal(remoteStatus.requiresUpdate, true);
assert.equal(remoteStatus.canContinue, false);

const cached = createUpdateSupportPolicy({
  app,
  now: () => afterDeadline,
  fetchImpl: async () => { throw new Error('offline'); },
  setTimer: () => ({ unref() {} }),
  clearTimer: () => {}
});
const cachedStatus = await cached.refresh();
assert.equal(cachedStatus.state, 'required');
assert.equal(cachedStatus.source, 'cache');

const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-support-policy-empty-'));
const unavailable = createUpdateSupportPolicy({
  app: { getVersion: () => '0.24.9', getPath: () => emptyRoot },
  now: () => afterDeadline,
  fetchImpl: async () => { throw new Error('offline'); },
  setTimer: () => ({ unref() {} }),
  clearTimer: () => {}
});
const unavailableStatus = await unavailable.refresh();
assert.equal(unavailableStatus.state, 'unavailable');
assert.equal(unavailableStatus.canContinue, true);


function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
{
  const dir = path.join(root, 'clock-fixture');
  fs.mkdirSync(dir);
  const anchor = afterDeadline;
  let clock = anchor;
  const timedPolicy = { ...policy, enforceAfter: new Date(anchor + 100).toISOString(),
    policyExpiresAt: new Date(anchor + 300).toISOString() };
  fs.writeFileSync(path.join(dir, 'update-support-policy.json'), JSON.stringify({ schemaVersion: 1, policy: timedPolicy }));
  const requests = [], statuses = [], writes = [], timers = new Set();
  const replacementPublished = deferred();
  const lifecycle = createUpdateSupportPolicy({
    app: { ...app, getPath: () => dir }, now: () => clock,
    fetchImpl: () => { const request = deferred(); requests.push(request); return request.promise; },
    writeCacheImpl: async (_file, value) => { writes.push(value.message); },
    onStatusChange: value => { statuses.push(value.state); if (value.message === 'replacement') replacementPublished.resolve(); },
    setTimer: (run, delay) => { const timer = { run, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => { timers.delete(timer); }
  });
  const advance = (delta, expectedState) => {
    assert.equal(timers.size, 1, 'one policy timer owns refresh and clock boundaries');
    const timer = [...timers][0];
    assert.equal(timer.delay, delta);
    clock += delta;
    timers.delete(timer);
    timer.run();
    assert.equal(lifecycle.getStatus().state, expectedState);
    assert.equal(statuses.at(-1), expectedState);
  };
  assert.equal(lifecycle.start().state, 'deprecated');
  advance(100, 'required');
  assert.equal(lifecycle.getStatus().canContinue, false);
  advance(200, 'unavailable');
  assert.equal(lifecycle.getStatus().canContinue, true, 'expired advice must stop blocking even while offline');
  const response = value => ({ ok: true, json: async () => value });
  requests[0].resolve(response({ ...timedPolicy, message: 'superseded' }));
  requests.at(-1).resolve(response({ ...policy, message: 'replacement' }));
  await replacementPublished.promise;
  assert.deepEqual(writes, ['replacement']);
  assert.equal(lifecycle.getStatus().state, 'required', 'an unexpired replacement retains canonical enforcement');
  const oldTimer = [...timers][0];
  await lifecycle.stop();
  assert.equal(timers.size, 0);
  lifecycle.start();
  const calls = requests.length;
  oldTimer.run();
  assert.equal(requests.length, calls, 'stale timer must not refresh after stop/restart');
  assert.equal(timers.size, 1);
  await lifecycle.stop();
}
for (const boundary of ['fetch', 'body']) {
  const pending = deferred();
  const bodyStarted = deferred();
  const writes = [];
  const statuses = [];
  let signal;
  const lifecycle = createUpdateSupportPolicy({
    app, now: () => afterDeadline,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      if (boundary === 'fetch') return pending.promise;
      return { ok: true, json: () => { bodyStarted.resolve(); return pending.promise; } };
    },
    writeCacheImpl: async (...args) => { writes.push(args); },
    onStatusChange: value => statuses.push(value)
  });
  const refreshing = lifecycle.refresh();
  if (boundary === 'body') await bodyStarted.promise;
  await lifecycle.stop();
  assert.equal(signal.aborted, true);
  pending.resolve(boundary === 'fetch' ? { ok: true, json: async () => remotePolicy } : remotePolicy);
  await refreshing;
  assert.deepEqual(writes, [], boundary + ': a stopped request cannot persist');
  assert.deepEqual(statuses, [], boundary + ': a stopped request cannot publish');
}
{
  const oldResponse = deferred();
  const currentPublished = deferred();
  const writes = [];
  let requests = 0;
  const lifecycle = createUpdateSupportPolicy({
    app, now: () => afterDeadline,
    fetchImpl: async () => ++requests === 1 ? oldResponse.promise : { ok: true, json: async () => ({ ...remotePolicy, message: 'latest' }) },
    writeCacheImpl: async (_path, value) => writes.push(value.message),
    onStatusChange: status => { if (status.message === 'latest') currentPublished.resolve(); },
    setTimer: () => ({ unref() {} }), clearTimer() {}
  });
  const previous = lifecycle.refresh();
  await lifecycle.stop();
  lifecycle.start();
  await currentPublished.promise;
  oldResponse.resolve({ ok: true, json: async () => ({ ...remotePolicy, message: 'stale' }) });
  await previous;
  assert.deepEqual(writes, ['latest']);
  assert.equal(lifecycle.getStatus().message, 'latest');
  await lifecycle.stop();
}
{
  const writeStarted = deferred();
  const finishWrite = deferred();
  const statuses = [];
  const lifecycle = createUpdateSupportPolicy({
    app, now: () => afterDeadline,
    fetchImpl: async () => ({ ok: true, json: async () => remotePolicy }),
    writeCacheImpl: async () => { writeStarted.resolve(); await finishWrite.promise; },
    onStatusChange: status => statuses.push(status)
  });
  const refreshing = lifecycle.refresh();
  await writeStarted.promise;
  let quiescent = false;
  const stopped = lifecycle.stop().then(() => { quiescent = true; });
  await Promise.resolve();
  assert.equal(quiescent, false, 'deletion barrier must await an already-started cache write');
  finishWrite.resolve();
  await stopped;
  await refreshing;
  assert.equal(quiescent, true);
  assert.deepEqual(statuses, [], 'completed stale writes cannot publish after stop');
}

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(emptyRoot, { recursive: true, force: true });
console.log('Remote update support policy tests passed.');
