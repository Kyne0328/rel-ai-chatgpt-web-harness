import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  processOutputView,
  processStateView,
  workSessionStateView
} from '../src/ui/task-identity.js';
import { taskProgressView } from '../src/ui/components/task-progress.js';
import { activeTaskList } from '../src/ui/features/home/index.js';
import { processListView } from '../src/ui/features/processes/index.js';

const persistentProcess = processStateView({
  processId: 'proc-persistent',
  status: 'running'
});
assert.equal(persistentProcess.label, 'Running');
assert.equal(persistentProcess.canStop, true);
assert.equal(persistentProcess.terminal, false);

const stoppingProcess = processStateView({ status: 'stopping' });
assert.equal(stoppingProcess.canStop, false);
assert.equal(stoppingProcess.active, true);
const restartedProcess = processStateView({ status: 'orphaned', pid: 123 });
assert.equal(restartedProcess.label, 'Unknown after restart');
assert.equal(restartedProcess.canStop, true);
assert.match(restartedProcess.recovery, /Stop the process if it is still running/i);
const processSummary = processListView({
  managedProcesses: [
    { processId: 'orphaned-process', status: 'orphaned', pid: 123 },
    { processId: 'finished-process', status: 'exited', endedAt: '2026-09-07T10:00:00.000Z' }
  ]
});
assert.equal(processSummary.running, 0);
assert.equal(processSummary.finished, 1, 'orphaned processes must not be counted as finished');
const finishedTiming = processListView({
  managedProcesses: [{
    processId: 'timed-finished-process',
    status: 'exited',
    startedAt: '2026-09-07T10:00:00.000Z',
    endedAt: '2026-09-07T10:00:30.000Z'
  }]
}, Date.parse('2026-09-07T10:01:30.000Z')).rows[0];
assert.equal(finishedTiming.elapsed, '30s', 'terminal process duration must remain static instead of embedding a stale relative age');
assert.equal(finishedTiming.endedAt, '2026-09-07T10:00:30.000Z');
assert.equal(finishedTiming.endedAgo, '1m ago', 'terminal process age must be exposed separately for the shared clock');
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
const truncatedOutput = processOutputView({
  stdoutTail: 'latest output\n',
  stderrTail: '',
  stdoutBytes: 64 * 1024,
  stdoutRetainedFromOffset: 4096,
  stdoutTailStartOffset: 48 * 1024,
  stdoutDroppedBytes: 512
});
assert.equal(truncatedOutput.stdoutMeta.tailTruncated, true, 'dashboard output must know when it is only showing the live tail');
assert.equal(truncatedOutput.stdoutMeta.retentionTruncated, true, 'dashboard output must distinguish retention loss from tail-only display');
assert.equal(truncatedOutput.stdoutMeta.droppedBytes, 512, 'dashboard output must surface capture drops separately from retention');

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
const dashboardDataSource = fs.readFileSync(path.join(root, 'src/core/dashboard-data.ts'), 'utf8');
const dashboardRuntimeSource = fs.readFileSync(path.join(root, 'src/core/dashboard-runtime.ts'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'src/ui/features/settings/react.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src/ui/styles/app.css'), 'utf8');
const sessionCssSource = fs.readFileSync(path.join(root, 'src/ui/features/sessions/styles.css'), 'utf8');

assert.match(sessionsSource, /sessions-summary-line/, 'Tasks surface must retain a compact user-facing summary in its toolbar');
assert.match(sessionsSource, /View its overview, activity, and technical details here\./, 'Tasks empty inspector must explain what selecting a task reveals');
assert.match(sessionsSource, /Rel\.AI task ID/);
assert.match(sessionsSource, /Process ID/);
assert.match(sessionsSource, /'aria-label': `Copy \$\{label\} \$\{value\}`/);
assert.doesNotMatch(sessionsSource, /Client task capability|Native MCP tasks|Native task ID/);
assert.doesNotMatch(sessionsSource, /nativeTasksCard|nativeTaskRow|data-cancel-native-task|bindNativeTaskActions/);
assert.match(sessionsSource, /data-stop-task-operation/);
assert.match(sessionsSource, /className: 'task-plan-active-dot'/, 'the active plan step must use one simple status dot instead of nesting another circular glyph inside its pulse');
assert.doesNotMatch(sessionsSource, /status === 'in_progress' \? 'circleDot'/, 'the active plan step must not stack a circle-dot icon inside the animated marker');
assert.match(sessionsSource, /data-stop-task-operations/);
assert.match(sessionsSource, /data-cancel-task/);
assert.match(sessionsSource, /Task cancellation requested\./, 'task cancellation UI must distinguish requested cancellation from confirmed terminal cancellation');
assert.match(sessionsSource, /\/api\/tasks\/control/);
assert.match(processesSource, /data-stop-process/);
assert.match(processesSource, /: 'Stop'/);
assert.match(processesSource, /filter\(row => row\.state\.terminal\)\.slice\(0, 5\)/, 'Running Commands must retain a bounded recently-ended view without inventing a time-based persistence policy');
assert.match(processesSource, /className: 'recent-processes'/, 'Recently ended commands must use progressive disclosure');
assert.match(processesSource, /href: '#activity'/, 'Running Commands must link to the full Activity history');
assert.match(processesSource, /Servers, watchers, debuggers, and other long-running commands appear here/, 'Running Commands empty state must explain what appears on the page');
assert.doesNotMatch(processesSource, /Startup task completed; process still running|Native task ID|Process ID|Saved output|process-detail-grid|process-relationship/);
assert.doesNotMatch(processesSource, /Cancel task|data-cancel-native-task/);
assert.match(processesSource, /'aria-label': `Recent \$\{stream\} output`/);
assert.match(processesSource, /active \? 'Live output' : 'Recent output'/, 'running commands must identify output as live');
assert.match(processesSource, /open: active && output\.hasOutput/, 'running command output must be visible as soon as output arrives');
assert.match(dashboardDataSource, /includeTail: true/, 'dashboard process projection must include managed-process output tails');
assert.match(dashboardDataSource, /tailBytes: 16 \* 1024/, 'dashboard process output tails must stay bounded');
assert.match(dashboardDataSource, /includeTailOffsets: true/, 'dashboard process projection must expose exact live-tail offsets');
assert.match(dashboardDataSource, /terminalOnly: true/, 'dashboard process projection must include a bounded recently-ended process tail');
assert.match(dashboardRuntimeSource, /managedProcesses: dashboardManagedProcesses\(config\)/, 'live process updates must reuse the same process projection as dashboard bootstrap');
assert.match(processesSource, /\/api\/processes\/output/, 'Running Commands must be able to retrieve retained output beyond the live tail');
assert.match(processesSource, /Load earlier output/, 'Running Commands must offer access to earlier retained output');
assert.match(processesSource, /no longer retained by Rel\.AI/, 'Running Commands must disclose when older output is permanently unavailable');
assert.match(processesSource, /dropped while Rel\.AI was capturing/, 'Running Commands must disclose capture drops');
assert.doesNotMatch(taskIdentitySource, /Required backend fields|stdoutTail and stderrTail/);
const connectionPageSource = settingsSource.match(/function ConnectionPage[\s\S]*?function DesktopConnectionSettings/)?.[0] || '';
assert.doesNotMatch(connectionPageSource, /Native MCP Tasks|Execution mode|connector-technical-details/);
assert.doesNotMatch(cssSource, /\.native-task-row|\.runtime-activity-spinner|\.runtime-capability-row/);
assert.match(sessionCssSource, /\.task-progress\.static\.terminal\.cancelled[\s\S]*--ui-status-neutral-background/);
assert.match(sessionCssSource, /\.task-plan-step\.is-in_progress\s*\{[^}]*box-shadow:\s*inset 2px 0 0 var\(--ui-action-primary\)/s, 'active plan cards must use a restrained edge accent instead of a bright full-card outline');
assert.match(sessionCssSource, /\.task-plan-step\.is-in_progress \.task-plan-marker::before\s*\{[^}]*opacity:\s*0[^}]*animation:\s*task-plan-heartbeat/s, 'active plan heartbeat must have an invisible resting state');
assert.match(sessionCssSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.task-plan-step\.is-in_progress \.task-plan-marker::before\s*\{\s*display:\s*none;/, 'reduced-motion users must not receive the active plan heartbeat');
assert.match(sessionCssSource, /@media \(prefers-reduced-motion: reduce\)/);

console.log('Dashboard work-session, process, accessibility, and missing-field observability contracts passed.');
