import assert from 'node:assert/strict';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { withAbortResource } from '../src/abortablePromise.ts';

const controller = new AbortController();
let resolveSource;
let cleanupCalled = false;
const source = new Promise(resolve => {
  resolveSource = resolve;
});
const unhandled = [];
const onUnhandledRejection = reason => unhandled.push(reason);
process.on('unhandledRejection', onUnhandledRejection);

try {
  const result = withAbortResource(
    source,
    controller.signal,
    () => {
      cleanupCalled = true;
      throw new Error('sync cleanup failure');
    },
    () => new Error('operation aborted')
  );

  controller.abort();
  await assert.rejects(result, /operation aborted/);
  resolveSource('resource');
  await waitForImmediate();

  assert.equal(cleanupCalled, true, 'a resource resolved after cancellation must still be cleaned up');
  assert.deepEqual(unhandled, [], 'synchronous cleanup failures after cancellation must not escape as unhandled rejections');
  for (const cleanupMode of ['success', 'sync-failure', 'async-failure']) {
    const preAborted = new AbortController();
    preAborted.abort();
    let cleanupCount = 0;
    const resource = {};
    const preAbortedResult = withAbortResource(Promise.resolve(resource), preAborted.signal, value => {
      assert.equal(value, resource);
      cleanupCount += 1;
      if (cleanupMode === 'sync-failure') throw new Error('sync late cleanup');
      if (cleanupMode === 'async-failure') return Promise.reject(new Error('async late cleanup'));
    }, () => new Error('already cancelled'));
    await assert.rejects(preAbortedResult, /already cancelled/);
    await waitForImmediate();
    assert.equal(cleanupCount, 1, 'a pre-aborted source must retain resource ownership exactly once');
  }

  const rejectedController = new AbortController();
  rejectedController.abort();
  await assert.rejects(withAbortResource(
    Promise.reject(new Error('source failed after cancellation')),
    rejectedController.signal, undefined, () => new Error('already cancelled')
  ), /already cancelled/);
  await waitForImmediate();

  let successCleanupCount = 0;
  const successController = new AbortController();
  const successResource = {};
  assert.equal(await withAbortResource(Promise.resolve(successResource), successController.signal,
    () => { successCleanupCount += 1; }, () => new Error('unexpected cancellation')), successResource);
  successController.abort();
  await waitForImmediate();
  assert.equal(successCleanupCount, 0, 'successful transfer must not clean a resource owned by the caller');
  assert.deepEqual(unhandled, [], 'source rejection and cleanup failures after pre-abort must be consumed');
} finally {
  process.off('unhandledRejection', onUnhandledRejection);
}

console.log('Abortable resource cleanup regression test passed.');
