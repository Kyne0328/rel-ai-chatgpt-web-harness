import assert from 'node:assert/strict';

import { createDesktopPowerIntegration } from '../electron/desktop-power.js';
import { createTaskActivityRuntime, taskActivityBlockReason } from '../electron/tool-sleep-blocker.js';

let snapshotReads = 0;
let listener = null;
const statusChanges = [];
const notifications = [];
const completedTasks = [];
const blockerState = new Set();
const blockerTypes = [];
let nextBlockerId = 1;
const toolActivity = {
  getToolActivity() {
    snapshotReads += 1;
    return { state: 'idle', activeCalls: 0, activeTaskCount: 0, tasks: [], lastTask: null };
  },
  onToolActivity(callback) {
    listener = callback;
    return () => { listener = null; };
  },
  resetToolActivity() {}
};
const runtime = createTaskActivityRuntime({
  toolActivity,
  powerSaveBlocker: {
    start(type) { blockerTypes.push(type); const id = nextBlockerId++; blockerState.add(id); return id; },
    stop(id) { blockerState.delete(id); return true; },
    isStarted(id) { return blockerState.has(id); }
  },
  notify: (category, content) => notifications.push({ category, content }),
  onTaskCompleted: task => completedTasks.push(task.taskId),
  onStatusChange: status => statusChanges.push(status)
});

assert.equal(snapshotReads, 1, 'runtime initialization may read one authoritative snapshot');
assert.equal(taskActivityBlockReason({ state: 'idle', activeCalls: 0, activeTaskCount: 0, tasks: [] }), '');
assert.match(taskActivityBlockReason({ state: 'waiting', activeCalls: 0, activeTaskCount: 1, tasks: [{ taskId: 'task-a', status: 'waiting' }] }), /active Rel\.AI task/);
const task = {
  id: 'task-a', taskId: 'task-a', workspace: 'repo', status: 'running', state: 'working',
  activeCalls: 1, calls: 1, failures: 0, startedAt: 100, lastTool: 'relai_read', operation: 'Read',
  events: Array.from({ length: 200 }, (_, index) => ({ eventId: `event-${index}` })),
  currentOperations: [{ id: 'operation-a' }]
};
listener({ phase: 'started', revision: 1, activeConnectorCalls: 1, activeCalls: 1, activeTaskCount: 1, taskId: 'task-a', task });
assert.equal(snapshotReads, 1, 'live activity must not rebuild the global task snapshot');
assert.equal(runtime.getStatus().tasks.length, 1);
assert.equal(Object.hasOwn(runtime.getStatus().tasks[0], 'events'), false, 'desktop status must not retain task timelines');
assert.equal(Object.hasOwn(runtime.getStatus().tasks[0], 'currentOperations'), false, 'desktop status must not retain operation payloads');
assert.equal(blockerState.size, 1, 'active connector work keeps the app eligible to continue running');
assert.deepEqual(blockerTypes, ['prevent-app-suspension'], 'background work must not keep the user display awake');
listener({
  phase: 'finished', revision: 2, activeConnectorCalls: 0, activeCalls: 0, activeTaskCount: 1,
  taskId: 'task-a', ok: true, task: { ...task, status: 'waiting', state: 'waiting', activeCalls: 0 }
});
assert.equal(runtime.getStatus().activeTaskCount, 1, 'the logical task remains open between connector calls');
assert.equal(runtime.getStatus().activeConnectorCalls, 0);
assert.equal(blockerState.size, 1, 'reasoning and approval gaps must keep an open logical task awake between connector calls');

runtime.setKeepAwakeEnabled(true);
assert.equal(blockerState.size, 1, 'the persistent keep-awake setting must share the existing blocker');

const completedEvent = {
  phase: 'completed', revision: 2, activeConnectorCalls: 0, activeCalls: 0, activeTaskCount: 0,
  taskId: 'task-a', task: { ...task, status: 'completed', state: 'ended', activeCalls: 0, completionKnown: true, summary: 'Done.' }
};
listener(completedEvent);
listener(completedEvent);
assert.equal(notifications.filter(item => item.category === 'taskCompleted').length, 1, 'duplicate terminal delivery must not repeat the completion notification');
assert.deepEqual(completedTasks, ['task-a'], 'duplicate terminal delivery must not repeat completion side effects');
const failedEvent = {
  phase: 'finished', revision: 3, activeConnectorCalls: 0, activeCalls: 0, activeTaskCount: 0,
  taskId: 'task-a', operation: 'Checking changes', workspace: 'repo', ok: false, error: 'check failed',
  activityEvent: { eventId: 'operation-failed' }
};
listener(failedEvent);
listener(failedEvent);
assert.equal(notifications.filter(item => item.category === 'errors').length, 1, 'duplicate failed-operation delivery must not repeat the native error notification');
const projectedFailedEvent = {
  ...failedEvent,
  revision: 4,
  operationId: 'operation-projected-failed',
  activityEvent: undefined
};
listener(projectedFailedEvent);
listener(projectedFailedEvent);
assert.equal(notifications.filter(item => item.category === 'errors').length, 2, 'duplicate projected IPC failures must dedupe by operation ID');
assert.equal(snapshotReads, 1, 'terminal activity must remain event-driven');
assert.equal(runtime.getStatus().activeTaskCount, 0);
assert.equal(runtime.getStatus().tasks.length, 0);
assert.equal(runtime.getStatus().lastTask?.taskId, 'task-a');
assert.equal(blockerState.size, 1, 'persistent keep-awake remains active after terminal work');
runtime.setKeepAwakeEnabled(false);
assert.equal(blockerState.size, 0, 'disabling persistent keep-awake releases the blocker after terminal work');
assert.ok(statusChanges.length >= 3, 'initial, running, and terminal status changes must be published');

const stoppedActivityListener = listener;
assert.equal(runtime.stop(), true);
assert.equal(runtime.stop(), false, 'activity shutdown must be idempotent');
runtime.setKeepAwakeEnabled(true);
assert.equal(blockerState.size, 0, 'preferences changed while stopped must not restart a blocker');
stoppedActivityListener({ phase: 'started', task: { ...task, taskId: 'stale-task' } });
assert.equal(runtime.getStatus().tasks.length, 0, 'late delivery from a stopped subscription must be ignored');
assert.equal(runtime.start(), true, 'an aborted shutdown must be able to resume activity tracking');
assert.equal(runtime.start(), false, 'activity recovery must not duplicate subscriptions');
assert.equal(snapshotReads, 2, 'recovery must refresh activity missed during shutdown');
assert.equal(blockerState.size, 1, 'recovery must restore the persistent keep-awake preference');
listener(completedEvent);
assert.equal(notifications.filter(item => item.category === 'taskCompleted').length, 1, 'recovery must preserve notification deduplication');
runtime.setKeepAwakeEnabled(false);
listener({ phase: 'started', activeCalls: 1, activeConnectorCalls: 1, task: { ...task, taskId: 'recovered-task' } });
assert.equal(blockerState.size, 1, 'new work after recovery must reacquire the activity blocker');
assert.equal(runtime.getStatus().tasks[0].taskId, 'recovered-task');
runtime.stop();

let resumeListener = null;
let resumeChecks = 0;
let powerUnsubscribed = false;
let powerSubscriptions = 0;
const powerRuntime = createDesktopPowerIntegration({
  powerMonitor: {
    on(name, listener) { assert.equal(name, 'resume'); resumeListener = listener; },
    off(name, listener) { assert.equal(name, 'resume'); assert.equal(listener, resumeListener); resumeListener = null; }
  },
  powerSaveBlocker: {
    start() { return 1; },
    stop() { return true; },
    isStarted() { return false; }
  },
  toolActivity: {
    getToolActivity() { return { state: 'idle', activeCalls: 0, activeTaskCount: 0, tasks: [] }; },
    onToolActivity() { powerSubscriptions += 1; return () => { powerUnsubscribed = true; }; }
  },
  onResume: () => { resumeChecks += 1; }
});
assert.equal(powerRuntime.start(), true);
assert.equal(powerRuntime.start(), false, 'power resume binding must be idempotent');
resumeListener?.();
assert.equal(resumeChecks, 1, 'resume events must reach the owned power callback');
assert.equal(powerRuntime.stop(), true);
assert.equal(resumeListener, null, 'power shutdown must detach the resume listener');
assert.equal(powerUnsubscribed, true, 'power shutdown must stop the task activity subscription');
assert.equal(powerRuntime.stop(), false, 'power shutdown must be idempotent');

assert.equal(powerRuntime.start(), true, 'power integration must restart after an aborted update');
assert.equal(powerRuntime.start(), false, 'repeated recovery must not duplicate resume listeners');
assert.equal(powerSubscriptions, 2, 'recovery must restore exactly one activity subscription');
resumeListener?.();
assert.equal(resumeChecks, 2, 'power resume remains functional after update recovery');
assert.equal(powerRuntime.stop(), true);
assert.equal(resumeListener, null);
assert.equal(powerRuntime.start(), true, 'another failed update may recover the same instance again');
assert.equal(powerSubscriptions, 3);
powerRuntime.stop();

console.log('Electron task activity and power integration stay incremental and lifecycle-owned.');
