import assert from 'node:assert/strict';

import { taskProgressView } from '../src/ui/components/task-progress.js';

const indeterminate = { mode: 'indeterminate', label: 'Running command' };

for (const [status, className, state, fallback] of [
  ['failed', 'static terminal failed', 'Failed', 'Task failed'],
  ['cancelled', 'static terminal cancelled', 'Cancelled', 'Task cancelled'],
  ['expired', 'static terminal cancelled', 'Expired', 'Task expired']
]) {
  const view = taskProgressView(indeterminate, status);
  assert.equal(view.kind, 'static');
  assert.match(view.className, new RegExp(className.replaceAll(' ', '\\s+')));
  assert.equal(view.state, state);
  assert.equal(view.label, fallback);
  assert.equal(view.value, null);
}

const inactive = taskProgressView({ mode: 'indeterminate', label: 'Waiting for the next task step' }, 'inactive');
assert.equal(inactive.kind, 'static');
assert.match(inactive.className, /static paused/);
assert.equal(inactive.state, 'Inactive');
assert.equal(inactive.label, 'Ready to resume');

for (const [status, className] of [
  ['validation_failed', 'static paused failed'],
  ['blocked', 'static paused blocked'],
  ['waiting_for_approval', 'static paused blocked']
]) {
  const view = taskProgressView({ mode: 'indeterminate', label: 'Approval required' }, status, { compact: true });
  assert.equal(view.kind, 'static');
  assert.match(view.className, new RegExp(className.replaceAll(' ', '\\s+')));
  assert.equal(view.state, 'Action required');
  assert.match(view.className, /compact/);
}

const running = taskProgressView(indeterminate, 'running');
assert.equal(running.kind, 'indeterminate');
assert.match(running.className, /task-progress indeterminate/);
assert.equal(running.role, 'status');
assert.equal(running.label, 'Running command');

const determinate = taskProgressView({ mode: 'determinate', label: 'Checking files', percentage: 37 }, 'running');
assert.equal(determinate.kind, 'determinate');
assert.equal(determinate.value, 37);
assert.equal(determinate.state, '37%');
assert.equal(determinate.progressAriaLabel, 'Checking files');

const completed = taskProgressView({ mode: 'complete', label: 'Complete' }, 'completed');
assert.equal(completed.kind, 'complete');
assert.match(completed.className, /task-progress complete/);
assert.equal(completed.value, 100);
assert.equal(completed.role, 'status');

const completedWithoutProgress = taskProgressView({}, 'completed');
assert.equal(completedWithoutProgress.kind, 'complete');
assert.equal(completedWithoutProgress.label, 'Complete');
assert.match(completedWithoutProgress.ariaLabel, /Task completed/);

console.log('Task progress view models terminal, paused, determinate, and indeterminate states without HTML rendering.');
