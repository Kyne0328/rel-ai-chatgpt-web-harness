import assert from 'node:assert/strict';

import {
  canonicalTaskSnapshot,
  lifecycleChangedFields,
  mergeTaskLifecycleSnapshots,
  reduceTaskLifecycleAuditEvent
} from '../src/taskLifecycle.js';

function event(taskId, values = {}) {
  return {
    taskId,
    taskIdentityVersion: 2,
    taskIdExplicit: true,
    taskHistoryEligible: true,
    workspace: 'repo',
    ok: true,
    ...values
  };
}

let task = canonicalTaskSnapshot({ id: 'task-1', taskId: 'task-1', status: 'planning', workspace: 'repo' });
task = reduceTaskLifecycleAuditEvent(task, event('task-1', {
  operationId: 'edit-1', ts: '2026-07-11T06:00:00.000Z', tool: 'edit', operation: 'Editing src/a.js', ms: 1000, changedFiles: ['src/a.js']
}));
assert.equal(task.calls, 1);
assert.deepEqual(task.changedFiles, ['src/a.js']);

let representedEventTask = canonicalTaskSnapshot({
  id: 'represented-event', taskId: 'represented-event', status: 'planning', workspace: 'repo',
  events: [{ eventId: 'read-1', operationId: 'read-1', status: 'running', summary: 'Reading files.' }]
});
representedEventTask = reduceTaskLifecycleAuditEvent(representedEventTask, event('represented-event', {
  operationId: 'read-1', eventId: 'read-1', ts: '2026-07-11T06:00:01.000Z', tool: 'read', status: 'succeeded', summary: 'Read files.'
}));
assert.equal(representedEventTask.events[0].status, 'succeeded', 'newer audit completion fields must replace the earlier running event projection');
assert.equal(representedEventTask.events[0].summary, 'Read files.');

task = reduceTaskLifecycleAuditEvent(task, event('task-1', {
  operationId: 'check-1', ts: '2026-07-11T06:00:02.000Z', tool: 'validate.checks', ok: false, validationStatus: 'failed'
}));
assert.equal(task.status, 'validation_failed', 'failed validation remains recoverable and nonterminal');
assert.equal(task.validation, 'failed');

task = reduceTaskLifecycleAuditEvent(task, event('task-1', {
  operationId: 'check-2', ts: '2026-07-11T06:00:04.000Z', tool: 'validate.checks', validationStatus: 'passed'
}));
assert.equal(task.validation, 'passed', 'later validation replaces the recoverable failed state');
assert.equal(task.status, 'planning');

task = reduceTaskLifecycleAuditEvent(task, event('task-1', {
  operationId: 'commit-1', ts: '2026-07-11T06:00:05.000Z', tool: 'publish.commit', changedFiles: ['src/a.js', 'test/a.test.js'], commitHead: '0123456789abcdef0123456789abcdef01234567'
}));
assert.equal(task.committed, true);
assert.equal(task.commitHead, '0123456789abcdef0123456789abcdef01234567');
assert.deepEqual(task.commitHeads, ['0123456789abcdef0123456789abcdef01234567']);
assert.deepEqual(task.changedFiles, ['src/a.js', 'test/a.test.js']);

task = reduceTaskLifecycleAuditEvent(task, event('task-1', {
  operationId: 'finish-1', ts: '2026-07-11T06:00:06.000Z', tool: 'work.finish', completionKnown: true, taskSummary: 'Implemented and validated.'
}));
assert.equal(task.status, 'completed');
assert.equal(task.completionKnown, true);
assert.equal(task.summary, 'Implemented and validated.');
assert.ok(task.completedAt);
assert.equal(task.cancelledAt, null);

let cancelled = canonicalTaskSnapshot({ id: 'task-2', taskId: 'task-2', status: 'planning', workspace: 'repo' });
cancelled = reduceTaskLifecycleAuditEvent(cancelled, event('task-2', {
  operationId: 'cancel-1', ts: '2026-07-11T07:00:00.000Z', tool: 'work.cancel'
}));
assert.equal(cancelled.status, 'cancelled');
assert.ok(cancelled.cancelledAt);
assert.equal(cancelled.completedAt, null);

const persisted = canonicalTaskSnapshot({
  id: 'merge-task', taskId: 'merge-task', status: 'planning', workspace: 'repo',
  calls: 3, changedFiles: ['src/a.js'], changedFileCount: 1, validation: 'passed', committed: true,
  commitHead: 'fedcba9876543210fedcba9876543210fedcba98', commitHeads: ['fedcba9876543210fedcba9876543210fedcba98'], updatedAt: '2026-07-11T08:00:00.000Z'
});
const live = canonicalTaskSnapshot({
  id: 'merge-task', taskId: 'merge-task', status: 'running', workspace: 'repo', activeCalls: 1,
  calls: 4, operation: 'Reading src/b.js', updatedAt: '2026-07-11T08:01:00.000Z'
});
const merged = mergeTaskLifecycleSnapshots(persisted, live);
assert.equal(merged.calls, 4);
assert.equal(merged.operation, 'Reading src/b.js');
assert.deepEqual(merged.changedFiles, ['src/a.js']);
assert.equal(merged.validation, 'passed');
assert.equal(merged.committed, true);
assert.equal(merged.commitHead, 'fedcba9876543210fedcba9876543210fedcba98');
assert.deepEqual(merged.commitHeads, ['fedcba9876543210fedcba9876543210fedcba98']);

const persistedPlan = canonicalTaskSnapshot({
  id: 'plan-task', taskId: 'plan-task', status: 'planning', workspace: 'repo', updatedAt: '2026-07-11T08:02:00.000Z',
  plan: { revision: 1, steps: [{ id: 'inspect', title: 'Inspect implementation', status: 'in_progress' }] },
  currentStage: 'Following task plan',
  currentActivity: 'Step 1 of 1: Inspect implementation',
  progress: { mode: 'determinate', completedUnits: 0, totalUnits: 1, source: 'task_plan', label: 'Step 1 of 1: Inspect implementation' }
});
const updatedPlan = canonicalTaskSnapshot({
  ...persistedPlan,
  status: 'running',
  updatedAt: '2026-07-11T08:03:00.000Z',
  plan: { revision: 2, steps: [
    { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
    { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
  ] },
  currentStage: 'Following task plan',
  currentActivity: 'Step 2 of 2: Run focused validation',
  progress: { mode: 'determinate', completedUnits: 1, totalUnits: 2, source: 'task_plan', label: 'Step 2 of 2: Run focused validation' }
});
const mergedPlan = mergeTaskLifecycleSnapshots(persistedPlan, updatedPlan);
assert.equal(mergedPlan.plan.revision, 2, 'newer live task plan must replace the previously persisted checklist');
assert.deepEqual(mergedPlan.plan.steps.map(step => step.status), ['completed', 'in_progress']);
assert.equal(mergedPlan.progress.completedUnits, 1);
assert.equal(mergedPlan.progress.totalUnits, 2);

const mergedNewerPersistedPlan = mergeTaskLifecycleSnapshots(updatedPlan, persistedPlan);
assert.equal(mergedNewerPersistedPlan.plan.revision, 2, 'a stale live snapshot must not replace a newer persisted checklist');
assert.equal(mergedNewerPersistedPlan.progress.completedUnits, 1, 'merged task progress must be derived from the selected checklist revision');
assert.equal(mergedNewerPersistedPlan.progress.totalUnits, 2);
assert.equal(mergedNewerPersistedPlan.currentStage, 'Following task plan');
assert.equal(mergedNewerPersistedPlan.currentActivity, 'Step 2 of 2: Run focused validation', 'plan-derived current activity must follow the selected checklist revision');

const liveToolActivity = canonicalTaskSnapshot({
  ...persistedPlan,
  updatedAt: '2026-07-11T08:04:00.000Z',
  currentStage: 'Reading repository',
  currentActivity: 'Reading src/taskLifecycle.js',
  activeCalls: 1
});
const mergedLiveToolActivity = mergeTaskLifecycleSnapshots(updatedPlan, liveToolActivity);
assert.equal(mergedLiveToolActivity.plan.revision, 2);
assert.equal(mergedLiveToolActivity.currentStage, 'Reading repository', 'a real live tool stage must not be overwritten just because its snapshot carries an older plan revision');
assert.equal(mergedLiveToolActivity.currentActivity, 'Reading src/taskLifecycle.js');
assert.equal(mergedLiveToolActivity.progress.totalUnits, 2, 'plan progress must still follow the selected checklist while a real tool activity remains visible');

const changed = lifecycleChangedFields(persisted, merged);
assert.ok(changed.includes('calls'));
assert.ok(changed.includes('operation'));
assert.equal(changed.includes('validation'), false);

console.log('Canonical task lifecycle reducer and projection tests passed.');
