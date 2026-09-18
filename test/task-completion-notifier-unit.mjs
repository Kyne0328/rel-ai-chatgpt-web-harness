import assert from 'node:assert/strict';

import { createToolActivityTracker } from "../src/toolActivity.js";
import { createTaskActivityRuntime } from "../electron/tool-sleep-blocker.js";

let nowValue = 1000;
let timerId = 0;
const timers = new Map();
const notifications = [];
const statuses = [];
const completedIndicators = [];
const startedBlockers = new Set();
let nextBlocker = 1;


const tracker = createToolActivityTracker({
  idleMs: 60_000,
  now: () => nowValue,
  setTimer(callback, delay) {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  },
  clearTimer(id) { timers.delete(id); }
});
const runtime = createTaskActivityRuntime({
  toolActivity: tracker,
  powerSaveBlocker: {
    start(type) {
      assert.equal(type, 'prevent-app-suspension');
      const id = nextBlocker++;
      startedBlockers.add(id);
      return id;
    },
    isStarted(id) { return startedBlockers.has(id); },
    stop(id) { return startedBlockers.delete(id); }
  },
  notify: (category, content) => {
    notifications.push({ category, options: content });
    return true;
  },
  onTaskCompleted: task => completedIndicators.push(structuredClone(task)),
  onStatusChange: status => statuses.push(structuredClone(status))
});

function startTask(workspace, scopeId) {
  const finish = tracker.beginConnectorToolCall({
    tool: 'relai_work', internalOperation: 'work.begin',
    operation: 'Starting task',
    workspace,
    scopeId,
    createTask: true
  });
  const taskId = finish.taskId;
  finish({ ok: true });
  return taskId;
}

const taskA = startTask('repo', 'conversation-a');
const taskB = startTask('other', 'conversation-b');
const finishRead = tracker.beginConnectorToolCall({
  tool: 'relai_read',
  operation: 'Reading src/app.js',
  workspace: 'repo',
  scopeId: 'conversation-a',
  taskId: taskA
});
const finishOther = tracker.beginConnectorToolCall({
  tool: 'relai_read',
  operation: 'Reading README.md',
  workspace: 'other',
  scopeId: 'conversation-b',
  taskId: taskB
});
assert.equal(runtime.getStatus().state, 'working');
assert.equal(runtime.getStatus().activeTaskCount, 2);
assert.equal(runtime.getStatus().activeCalls, 2);
assert.equal(startedBlockers.size, 1);
finishRead();
finishOther();
assert.equal(runtime.getStatus().state, 'waiting');
assert.equal(runtime.getStatus().activeTaskCount, 2);
assert.equal(startedBlockers.size, 1, 'open logical work must keep the app eligible to continue across reasoning and approval gaps');
assert.equal(notifications.length, 0, 'successful tool calls must not be presented as completed ChatGPT tasks');

nowValue = 91_000;
for (const [id, timer] of [...timers]) {
  timers.delete(id);
  timer.callback();
}
const inactive = runtime.getStatus();
assert.equal(inactive.state, 'idle');
assert.equal(inactive.activeTaskCount, 0);
assert.equal(startedBlockers.size, 0, 'the sleep blocker must stop when no work session remains active');
assert.equal(inactive.lastTask.status, 'inactive');
assert.equal(inactive.lastTask.endReason || '', '');
assert.ok(inactive.lastTask.inactiveAt);
assert.equal(notifications.length, 0, 'inactivity must not generate a false task-completed notification');

const failedTask = startTask('repo', 'conversation-c');
const finishFailed = tracker.beginConnectorToolCall({
  tool: 'relai_validate', internalOperation: 'validate.checks',
  operation: 'Running validation 1/2: npm run check',
  workspace: 'repo',
  scopeId: 'conversation-c',
  taskId: failedTask
});
finishFailed({ ok: false, error: 'internal diagnostic detail' });
assert.equal(notifications.length, 1);
assert.equal(notifications[0].options.title, 'Project action failed');
assert.match(notifications[0].options.body, /Running validation 1\/2: npm run check failed in repo/);
assert.match(notifications[0].options.body, /Open Rel\.AI for details and recovery options\./);
assert.doesNotMatch(notifications[0].options.body, /internal diagnostic detail/, 'native notifications should keep technical error detail in Activity and Diagnostics');
assert.equal(notifications[0].category, 'errors');

nowValue = 152_000;
for (const [id, timer] of [...timers]) {
  timers.delete(id);
  timer.callback();
}
assert.equal(runtime.getStatus().lastTask.status, 'inactive', 'a failed validation remains recoverable after the inactivity window');
assert.equal(runtime.getStatus().lastTask.failures, 1);

const completedTask = startTask('repo', 'conversation-completed');
const finishCompleted = tracker.beginConnectorToolCall({
  tool: 'relai_work', internalOperation: 'work.finish',
  operation: 'Reporting task completion',
  workspace: 'repo',
  scopeId: 'conversation-completed',
  taskId: completedTask
});
finishCompleted.requestCompletion({
  summary: 'Implemented and validated the requested changes.',
  validationStatus: 'passed',
  validationLevel: 'standard',
  validationAt: '2026-07-11T09:30:00.000Z',
  changedFiles: ['src/app.js']
});
finishCompleted();
assert.equal(runtime.getStatus().state, 'idle');
assert.equal(runtime.getStatus().lastTask.status, 'completed');
assert.equal(runtime.getStatus().lastTask.completionKnown, true);
assert.equal(runtime.getStatus().lastTask.endReason, 'explicit_completion');
assert.equal(notifications.length, 2);
assert.equal(notifications[1].options.title, 'Task completed');
assert.match(notifications[1].options.body, /Implemented and validated the requested changes\./);
assert.match(notifications[1].options.body, /Project: repo\./);
assert.match(notifications[1].options.body, /Final standard checks passed\./);
assert.doesNotMatch(notifications[1].options.body, /completion reported|ChatGPT explicitly/i);
assert.equal(notifications[1].category, 'taskCompleted');
assert.equal(completedIndicators.length, 1);
assert.equal(completedIndicators[0].taskId, completedTask);

assert.ok(statuses.some(status => status.activeTaskCount === 2 && status.activeCalls === 2));
assert.ok(statuses.some(status => status.state === 'waiting'));
assert.ok(statuses.some(status => status.lastTask?.status === 'inactive'));
assert.ok(statuses.some(status => status.lastTask?.status === 'completed' && status.lastTask?.completionKnown === true));
runtime.stop();

console.log('Exact tool activity, failure, and explicit completion notification tests passed.');
