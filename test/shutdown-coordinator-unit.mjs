import assert from 'node:assert/strict';

import { closeHttpServer, createShutdownCoordinator } from '../electron/shutdown-coordinator.js';

const calls = [];
const coordinator = createShutdownCoordinator({
  stopUpdater: () => calls.push('updater'),
  stopActivity: () => calls.push('activity'),
  closeWindows: () => calls.push('windows'),
  stopService: async () => {
    calls.push('service');
    return { cleanup: { clean: true } };
  },
  shutdownTelemetry: async () => calls.push('telemetry'),
  removeRuntimeMarker: () => calls.push('marker'),
  markCleanShutdown: () => calls.push('clean'),
  flushLogs: async () => calls.push('logs')
});

const first = coordinator.prepare('quit');
const duplicate = coordinator.prepare('duplicate');
assert.equal(first, duplicate, 'shutdown preparation must be idempotent');
const result = await first;
assert.equal(result.clean, true);
assert.equal(coordinator.isPrepared(), true);
assert.deepEqual(calls, ['updater', 'activity', 'windows', 'service', 'telemetry', 'marker', 'clean', 'logs']);

coordinator.reset();
assert.equal(coordinator.isPrepared(), false, 'a reset coordinator must allow a fresh shutdown preparation after a failed update');
const retried = await coordinator.prepare('update-retry');
assert.equal(retried.clean, true);
assert.equal(coordinator.isPrepared(), true);

const failureCalls = [];
const failed = createShutdownCoordinator({
  stopService: async () => ({ cleanup: { clean: false } }),
  removeRuntimeMarker: () => failureCalls.push('marker'),
  markCleanShutdown: () => failureCalls.push('clean')
});
const failedResult = await failed.prepare('quit');
assert.equal(failedResult.clean, false);
assert.deepEqual(failureCalls, ['marker'], 'uncertain cleanup must preserve the unclean-shutdown marker');

const lifecycleMarkerFailure = createShutdownCoordinator({
  stopService: async () => ({ cleanup: { clean: true } }),
  markCleanShutdown: () => { throw new Error('marker write failed'); }
});
const lifecycleMarkerResult = await lifecycleMarkerFailure.prepare('quit');
assert.equal(lifecycleMarkerResult.ok, false);
assert.equal(lifecycleMarkerResult.clean, false, 'a failed clean-shutdown marker must not be reported as a clean exit');
assert.equal(lifecycleMarkerResult.errors[0]?.step, 'lifecycle marker');

const forcedClose = deferred();
const closing = closeHttpServer({
  close() {},
  closeIdleConnections() {},
  closeAllConnections() { forcedClose.resolve(); },
  waitForShutdown() { throw new Error('network close must not wait on runtime cleanup'); }
}, { timeoutMs: 5 });
await forcedClose.promise;
const forcedResult = await closing;
assert.equal(forcedResult.closed, false, 'a forced network close must report that graceful server close was not confirmed');
assert.equal(forcedResult.forced, true);
assert.match(forcedResult.error, /did not close within/i);

const hungService = deferred();
const boundedShutdown = createShutdownCoordinator({
  stopService: () => hungService.promise,
  serviceTimeoutMs: 10,
  stepTimeoutMs: 10,
  flushTimeoutMs: 10
});
const boundedStartedAt = Date.now();
const boundedResult = await boundedShutdown.prepare('timeout-regression');
assert.ok(Date.now() - boundedStartedAt < 500, 'shutdown preparation must have a terminal deadline even when service cleanup never settles');
assert.equal(boundedResult.clean, false);
assert.equal(boundedResult.errors[0]?.step, 'service');
assert.match(boundedResult.errors[0]?.message || '', /did not finish within/i);

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

console.log('Desktop shutdown coordinator idempotency, clean-exit gating, and forced-close synchronization tests passed.');
