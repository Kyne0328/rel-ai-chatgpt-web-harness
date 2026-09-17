import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clientCapabilityViews,
  nativeTaskCollection,
  nativeTaskStatusView,
  nativeTaskView,
  processOutputView,
  processStateView,
  workSessionStateView
} from '../src/ui/task-identity.js';
import { taskProgressView } from '../src/ui/components/task-progress.js';
import { activeTaskList } from '../src/ui/features/home/index.js';
import { processListView } from '../src/ui/features/processes/index.js';

const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks';

const supported = clientCapabilityViews({
  mcpConnection: {
    recentEvents: [{
      type: 'mcp_request_received',
      requestId: 'request-supported',
      timestamp: '2026-08-01T05:00:00.000Z',
      clientInfo: { name: 'Compatible host', version: '1.0' },
      clientCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } }
    }]
  }
})[0];
assert.equal(supported.capabilityState, 'supported');
assert.equal(supported.capabilityLabel, 'Native MCP Tasks: Supported');
assert.equal(supported.executionLabel, 'Eligible long work: Native MCP task');

const unsupported = clientCapabilityViews({
  mcpConnection: {
    recentEvents: [{
      type: 'mcp_request_received',
      requestId: 'request-unsupported',
      clientCapabilities: { extensions: {} }
    }]
  }
})[0];
assert.equal(unsupported.capabilityState, 'not_advertised');
assert.equal(unsupported.capabilityLabel, 'Native MCP Tasks: Not advertised by client');
assert.equal(unsupported.executionLabel, 'Eligible long work: Work-session continuation');
assert.match(unsupported.description, /continue in the same work session/i);

const unknown = clientCapabilityViews({ mcpConnection: { recentEvents: [] } })[0];
assert.equal(unknown.capabilityState, 'unknown');
assert.equal(unknown.capabilityLabel, 'Native MCP Tasks: Unknown');
assert.equal(unknown.executionLabel, 'Eligible long work: Capability unknown');
const malformedCapability = clientCapabilityViews({
  mcpConnection: {
    recentEvents: [{ type: 'mcp_request_received', clientCapabilities: { extensions: null } }]
  }
})[0];
assert.equal(malformedCapability.capabilityState, 'unknown');

const working = nativeTaskStatusView('working');
assert.equal(working.active, true);
assert.equal(working.showSpinner, true);
assert.equal(working.terminal, false);

const inputRequired = nativeTaskStatusView('input_required');
assert.equal(inputRequired.waitingForInput, true);
assert.equal(inputRequired.showSpinner, false);
assert.match(inputRequired.description, /waiting for the client/i);

for (const status of ['completed', 'failed', 'cancelled']) {
  const view = nativeTaskStatusView(status, { cancellationConfirmed: status === 'cancelled' });
  assert.equal(view.terminal, true, `${status} must be terminal`);
  assert.equal(view.showSpinner, false, `${status} must not animate`);
}

const cancellationRequested = nativeTaskStatusView('working', { cancelRequested: true });
assert.equal(cancellationRequested.label, 'Cancellation requested');
assert.equal(cancellationRequested.terminal, false);
assert.equal(cancellationRequested.showSpinner, false);
const cancellationConfirmed = nativeTaskStatusView('cancelled', { cancellationConfirmed: true });
assert.equal(cancellationConfirmed.label, 'Cancelled (confirmed)');

const missingCollection = nativeTaskCollection({});
assert.equal(missingCollection.available, false);
assert.equal(missingCollection.requiredField, 'nativeTasks');
assert.deepEqual(missingCollection.tasks, []);

const taskWithoutOptionalFields = nativeTaskView({ taskId: 'task-minimal', status: 'working' });
assert.equal(taskWithoutOptionalFields.taskId, 'task-minimal');
assert.equal(taskWithoutOptionalFields.operation, 'Asynchronous MCP operation');
assert.equal(taskWithoutOptionalFields.canCancel, false);
assert.equal(taskWithoutOptionalFields.logicalTaskId, '');
assert.equal(taskWithoutOptionalFields.processId, '');

const explicitCancellableTask = nativeTaskView({
  taskId: 'task-cancellable',
  status: 'working',
  actions: { cancel: { available: true, url: '/api/native-tasks/task-cancellable/cancel' } }
});
assert.equal(explicitCancellableTask.canCancel, true);
const inputRequiredCancellableTask = nativeTaskView({
  taskId: 'task-input',
  status: 'input_required',
  actions: { cancel: { available: true, url: '/api/native-tasks/task-input/cancel' } }
});
assert.equal(inputRequiredCancellableTask.canCancel, true);
const cancellationAlreadyRequestedTask = nativeTaskView({
  taskId: 'task-cancelling',
  status: 'working',
  cancelRequested: true,
  actions: { cancel: { available: true, url: '/api/native-tasks/task-cancelling/cancel' } }
});
assert.equal(cancellationAlreadyRequestedTask.canCancel, false);
const unknownStatusTask = nativeTaskView({
  taskId: 'task-unknown',
  status: 'future_status',
  actions: { cancel: { available: true, url: '/api/native-tasks/task-unknown/cancel' } }
});
assert.equal(unknownStatusTask.canCancel, false);
const completedTask = nativeTaskView({
  taskId: 'task-startup',
  status: 'completed',
  origin: { name: 'relai_process', logicalTaskId: 'work-session-1' },
  result: { processId: 'proc-persistent' }
});
assert.equal(completedTask.canCancel, false);
assert.equal(completedTask.processId, 'proc-persistent');
assert.equal(completedTask.logicalTaskId, 'work-session-1');

const persistentProcess = processStateView({
  processId: 'proc-persistent',
  status: 'running',
  originatingTaskId: 'task-startup'
}, [{ taskId: 'task-startup', status: 'completed' }]);
assert.equal(persistentProcess.independent, true);
assert.equal(persistentProcess.label, 'Running independently');
assert.equal(persistentProcess.canStop, true);
assert.equal(persistentProcess.terminal, false);

const stoppingProcess = processStateView({ status: 'stopping' });
assert.equal(stoppingProcess.canStop, false);
assert.equal(stoppingProcess.active, true);
const restartedProcess = processStateView({ status: 'orphaned', pid: 123 });
assert.equal(restartedProcess.label, 'Unknown after restart');
assert.equal(restartedProcess.canStop, true);
assert.match(restartedProcess.recovery, /Stop the process explicitly/i);
const processSummary = processListView({
  managedProcesses: [
    { processId: 'orphaned-process', status: 'orphaned', pid: 123 },
    { processId: 'finished-process', status: 'exited', endedAt: '2026-09-07T10:00:00.000Z' }
  ]
});
assert.equal(processSummary.running, 0);
assert.equal(processSummary.finished, 1, 'orphaned processes must not be counted as finished');
const stoppedProcess = processStateView({ status: 'stopped' });
assert.equal(stoppedProcess.terminal, true);
assert.equal(stoppedProcess.canStop, false);
const restartAliasProcess = processStateView({ status: 'unknown_after_restart', pid: 456 });
assert.equal(restartAliasProcess.status, 'orphaned');
assert.equal(restartAliasProcess.label, 'Unknown after restart');
assert.equal(restartAliasProcess.canStop, true);

const unavailableOutput = processOutputView({ stdoutBytes: 8, stderrBytes: 2 });
assert.equal(unavailableOutput.included, false);
assert.equal(unavailableOutput.hasOutput, false);
assert.equal(unavailableOutput.message, 'Recent output is not available in this dashboard snapshot.');
const emptyIncludedOutput = processOutputView({ stdoutTail: '', stderrTail: '' });
assert.equal(emptyIncludedOutput.included, true);
assert.equal(emptyIncludedOutput.hasOutput, false);
assert.match(emptyIncludedOutput.message, /No recent stdout or stderr output was recorded/);
const includedOutput = processOutputView({ stdoutTail: 'ready\n', stderrTail: '' });
assert.equal(includedOutput.hasOutput, true);
assert.equal(includedOutput.stdout, 'ready\n');

for (const status of ['blocked', 'validating', 'validation_failed', 'completed', 'failed', 'cancelled', 'expired']) {
  const view = workSessionStateView({ status });
  assert.notEqual(view.label, 'Unknown', `${status} must have an explicit work-session label`);
}
assert.equal(workSessionStateView({ status: 'expired' }).terminal, true);
assert.equal(workSessionStateView({ status: 'validating' }).active, true);
assert.equal(workSessionStateView({ status: 'blocked' }).terminal, false);
const blockedView = workSessionStateView({ status: 'blocked' });
assert.equal(blockedView.label, 'Blocked');
assert.equal(blockedView.pillClass, 'bad');
assert.equal(blockedView.terminal, false);
const inactiveBlockedView = workSessionStateView({
  status: 'inactive',
  resumeStatus: 'blocked',
  currentStage: 'Inactive',
  currentActivity: 'The previous operation was blocked.'
});
assert.equal(inactiveBlockedView.label, 'Blocked');
const inactiveProgress = taskProgressView({ mode: 'indeterminate', label: 'Waiting for the next task step' }, 'inactive');
assert.equal(inactiveProgress.state, 'Inactive');
assert.match(inactiveProgress.label, /Ready to resume/i);
assert.doesNotMatch(inactiveProgress.label, /expired/i, 'resumable inactive sessions must not be presented as expired');

const observableActiveSessions = activeTaskList({
  activeCalls: 9,
  tasks: [
    { id: 'terminal', status: 'completed', activeCalls: 9 },
    { id: 'open', status: 'planning', activeCalls: 0 }
  ]
});
assert.deepEqual(observableActiveSessions.map(task => task.id), ['open']);
assert.deepEqual(activeTaskList({ tasks: [{ id: 'expired', status: 'expired', activeCalls: 1 }] }), []);

for (const status of ['completed', 'failed', 'cancelled', 'expired']) {
  const view = taskProgressView({}, status);
  assert.notEqual(view.kind, 'indeterminate', `${status} must not retain indeterminate progress`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const taskIdentitySource = fs.readFileSync(path.join(root, 'src/ui/task-identity.js'), 'utf8');
const sessionsSource = fs.readFileSync(path.join(root, 'src/ui/features/sessions/react.js'), 'utf8');
const processesSource = fs.readFileSync(path.join(root, 'src/ui/features/processes/react.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'src/ui/features/settings/react.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src/ui/styles/app.css'), 'utf8');
const sessionCssSource = fs.readFileSync(path.join(root, 'src/ui/features/sessions/styles.css'), 'utf8');

assert.match(sessionsSource, /Recent (?:sessions|tasks)/, 'Tasks surface must use a compact user-facing heading');
assert.match(sessionsSource, /Work session ID/);
assert.match(sessionsSource, /Process ID/);
assert.match(sessionsSource, /'aria-label': `Copy \$\{label\} \$\{value\}`/);
assert.doesNotMatch(sessionsSource, /Client task capability|Native MCP tasks|Native task ID/);
assert.doesNotMatch(sessionsSource, /nativeTasksCard|nativeTaskRow|data-cancel-native-task|bindNativeTaskActions/);
assert.match(processesSource, /data-stop-process/);
assert.match(processesSource, /: 'Stop'/);
assert.doesNotMatch(processesSource, /Startup task completed; process still running|Native task ID|Process ID|Saved output|process-detail-grid|process-relationship/);
assert.doesNotMatch(processesSource, /Cancel task|data-cancel-native-task/);
assert.match(processesSource, /'aria-label': `Recent \$\{stream\} output`/);
assert.doesNotMatch(taskIdentitySource, /Required backend fields|stdoutTail and stderrTail/);
const connectionPageSource = settingsSource.match(/function ConnectionPage[\s\S]*?function DesktopConnectionSettings/)?.[0] || '';
assert.doesNotMatch(connectionPageSource, /Native MCP Tasks|Execution mode|connector-technical-details/);
assert.doesNotMatch(cssSource, /\.native-task-row|\.runtime-activity-spinner|\.runtime-capability-row/);
assert.match(sessionCssSource, /\.task-progress\.static\.terminal\.cancelled[\s\S]*--ui-status-neutral-background/);
assert.match(sessionCssSource, /@media \(prefers-reduced-motion: reduce\)/);

console.log('Dashboard capability, work-session, native-task, process, accessibility, and missing-field observability contracts passed.');
