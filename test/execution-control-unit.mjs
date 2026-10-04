import assert from 'node:assert/strict';

import {
  hasAgentCancellationHandle,
  isClearlyWorkspaceReadOnlyAdb,
  isPersistentAdbInvocation,
  resolveOneShotTimeoutMs
} from '../src/executionControl.js';

assert.equal(hasAgentCancellationHandle({ work_id: 'work-1' }), true);
assert.equal(hasAgentCancellationHandle({}, { taskId: 'work-2' }), true);
assert.equal(hasAgentCancellationHandle({}, {}), false);

assert.equal(
  resolveOneShotTimeoutMs({ work_id: 'work-1' }, {}, { fallbackMs: 120000 }),
  0,
  'durable work must be agent-controlled when no explicit timeout is requested'
);
assert.equal(
  resolveOneShotTimeoutMs({}, {}, { fallbackMs: 120000 }),
  120000,
  'taskless one-shot work must retain a bounded fallback timeout because it has no durable cancellation handle'
);
assert.equal(
  resolveOneShotTimeoutMs({ work_id: 'work-1', timeoutMs: 30000 }, {}, { fallbackMs: 120000 }),
  30000,
  'an explicit timeout must still win for agent-controlled work'
);
assert.equal(resolveOneShotTimeoutMs({ timeoutMs: 10 }, {}, { minMs: 1000, fallbackMs: 120000 }), 1000);
assert.equal(resolveOneShotTimeoutMs({ timeoutMs: 999999999 }, {}, { maxMs: 86400000, fallbackMs: 120000 }), 86400000);
const deadlineBoundedTimeout = resolveOneShotTimeoutMs(
  { timeoutMs: 30000 },
  { deadlineAtMs: Date.now() + 5000 },
  { fallbackMs: 120000 }
);
assert.ok(deadlineBoundedTimeout > 0 && deadlineBoundedTimeout <= 5000, 'an inherited operation deadline must reduce the remaining process timeout');
assert.equal(
  resolveOneShotTimeoutMs({ timeoutMs: 30000 }, { deadlineAtMs: Date.now() - 1 }, { fallbackMs: 120000 }),
  1,
  'an already-expired deadline must not restart the original timeout budget'
);

assert.equal(isClearlyWorkspaceReadOnlyAdb('adb', ['devices']), true);
assert.equal(isClearlyWorkspaceReadOnlyAdb('adb.exe', ['-s', 'device-1', 'shell', 'getprop']), true);
assert.equal(isClearlyWorkspaceReadOnlyAdb('adb', ['pull', '/sdcard/file', 'local.bin']), false, 'adb pull can create a local workspace file');
assert.equal(isClearlyWorkspaceReadOnlyAdb('adb', ['keygen', 'adbkey']), false, 'adb keygen writes a local key file');
assert.equal(isPersistentAdbInvocation('adb', ['logcat']), true);
assert.equal(isPersistentAdbInvocation('adb', ['logcat', '-d']), false);
assert.equal(isPersistentAdbInvocation('adb', ['track-devices']), true);
assert.equal(isPersistentAdbInvocation('adb', ['shell']), true);
assert.equal(isPersistentAdbInvocation('adb', ['shell', 'getprop']), false);

console.log('Agent-controlled one-shot timeout policy tests passed.');
