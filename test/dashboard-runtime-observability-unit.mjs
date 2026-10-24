import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
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
const missingController = processStateView({
  status: 'orphaned', canStop: false, recovery: 'Restart Windows, then reopen Rel.AI to verify cleanup.'
});
assert.equal(missingController.canStop, false, 'recovery must not offer Stop when the controller cannot receive it');
assert.match(missingController.recovery, /Restart Windows/);
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
const sampleTime = Date.parse('2026-10-24T00:00:00Z');
const measuredProcess = { processId: 'memory-root', pid: 321, status: 'running' };
const memoryRoot = {
  processId: 'memory-root', pid: 321, sampledAt: new Date(sampleTime).toISOString(),
  identityVerified: true, measurementStatus: 'measured', workingSetBytes: 12 * 1024 ** 2
};
const memoryRow = (root = memoryRoot, overrides = {}, now = sampleTime) => processListView({
  managedProcesses: [{ ...measuredProcess, ...overrides }], processMemory: { roots: root ? [root] : [] }
}, now).rows[0];
assert.equal(memoryRow().memory.workingSetBytes, memoryRoot.workingSetBytes);
assert.equal(memoryRow({ ...memoryRoot, workingSetBytes: 0 }).memory.workingSetBytes, 0);
assert.equal(memoryRow({ ...memoryRoot, identityVerified: false }).memory, null);
assert.equal(memoryRow({ ...memoryRoot, measurementStatus: 'unknown', reason: 'probe_failed_or_timed_out' }).memory, null);
assert.equal(memoryRow({ ...memoryRoot, pid: 999 }).memory, null);
assert.equal(memoryRow({ ...memoryRoot, workingSetBytes: null }).memory, null);
assert.equal(memoryRow(memoryRoot, {}, sampleTime + 5000).memory, null, 'expired samples must not be presented as current RAM');
assert.equal(memoryRow(memoryRoot, { status: 'exited' }).memory, null);
assert.equal(memoryRow(null, { memoryBytes: 1234 }).memory, null, 'unverified ad hoc memory fields must not become measured gauges');
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
// Exercise the actual route partition and row render, not just model flags or source text.
const processStopRequests = [];
let processRefreshes = 0;
const processRenderContext = {
  React: {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type({ ...props, children }) : { type, props: props || {}, children };
    }
  },
  memo: component => component,
  useMemo: compute => compute(),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: initial => ({ current: initial }),
  useEffect: () => {},
  Icon: () => null,
  StatusPill: ({ label }) => label,
  processListView,
  confirmAction: async () => true,
  postJson: async (...args) => { processStopRequests.push(args); return { ok: true }; },
  requestDashboardRefresh: () => { processRefreshes += 1; }
};
vm.runInNewContext(processesSource.replace(/^import .*;\n/gm, '').replace('export function createProcessesRoute', 'function createProcessesRoute')
  + '\nglobalThis.renderProcesses = createProcessesRoute; globalThis.renderProcessRow = ProcessRow;', processRenderContext);
const restartedProcessTree = processRenderContext.renderProcesses(() => ({
  managedProcesses: [{ processId: 'restart-survivor', status: 'unknown_after_restart', pid: 456, label: 'Restart survivor' }]
}))();
const processNodes = [];
function visitProcessNode(node) {
  if (node == null) return;
  if (Array.isArray(node)) return node.forEach(visitProcessNode);
  processNodes.push(node);
  if (typeof node === 'object') (node.children || []).forEach(visitProcessNode);
}
visitProcessNode(restartedProcessTree);
assert.ok(processNodes.some(node => node?.props?.['data-process-id'] === 'restart-survivor'), 'a process whose state is unknown after restart must remain visible');
assert.ok(processNodes.some(node => node?.props?.['data-stop-process'] === true && node.props.disabled === false), 'a restart-unknown process must retain its enabled Stop action');
assert.ok(processNodes.includes('Unknown after restart'), 'the renderer must disclose uncertain restart state');
assert.ok(processNodes.some(node => typeof node === 'string' && /Stop the process if it is still running/.test(node)), 'the renderer must retain restart recovery guidance');
assert.ok(processNodes.includes('0 running · 1 needs attention'), 'uncertain processes must not be counted as running or finished');

const noControllerTree = processRenderContext.renderProcesses(() => ({
  managedProcesses: [{ processId: 'missing-controller', status: 'orphaned', canStop: false, recovery: missingController.recovery }]
}))();
const previousNodes = processNodes.splice(0);
visitProcessNode(noControllerTree);
assert.equal(processNodes.some(node => node?.props?.['data-stop-process'] === true), false);
assert.ok(processNodes.includes(missingController.recovery), 'the row must show the backend recovery action');
processNodes.splice(0, processNodes.length, ...previousNodes);

const defaultUseState = processRenderContext.useState;
let rowStateIndex = 0;
processRenderContext.useState = initial => {
  const index = rowStateIndex++;
  return [index === 0 ? 'error' : index === 1 ? 'Old stop failure' : initial, () => {}];
};
const resolvedProcessTree = processRenderContext.renderProcessRow({ row: processListView({
  managedProcesses: [{ processId: 'resolved-controller', status: 'exited', terminationConfirmed: true }]
}).rows[0] });
processRenderContext.useState = defaultUseState;
const restartedNodes = processNodes.splice(0);
visitProcessNode(resolvedProcessTree);
assert.equal(processNodes.some(node => node?.props?.className?.includes('process-stop-error')), false, 'a terminal refresh must clear an obsolete Stop error');
processNodes.splice(0, processNodes.length, ...restartedNodes);

processNodes.find(node => node?.props?.['data-stop-process'] === true).props.onClick();
await new Promise(resolve => setImmediate(resolve));
assert.equal(processStopRequests[0]?.[0], '/api/processes/stop');
assert.equal(processStopRequests[0]?.[1]?.processId, 'restart-survivor', 'Stop must target the displayed process through the existing backend endpoint');
assert.equal(processRefreshes, 1);

// The visible Commands route samples through the authenticated endpoint,
// expires observations, ignores hidden/unmounted responses, and has no idle poll.
async function exerciseProcessMemoryLifecycle() {
  const slots = [];
  const effects = [];
  const requests = [];
  const timers = new Map();
  const listeners = new Map();
  let cursor = 0;
  let timerId = 0;
  let writes = 0;
  let now = sampleTime;
  const document = {
    visibilityState: 'visible',
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name)
  };
  const context = {
    React: { createElement() {} }, memo: component => component,
    document,
    window: {
      setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
      clearTimeout: id => timers.delete(id)
    },
    Date: class extends Date { static now() { return now; } },
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { writes++; slots[index].value = value; }];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      effects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: effect() };
      });
    },
    fetchJson(url, options) { return new Promise(resolve => requests.push({ url, options, resolve })); }
  };
  vm.runInNewContext(processesSource.replace(/^import .*;\n/gm, '').replace('export function createProcessesRoute', 'function createProcessesRoute')
    + '\nglobalThis.readMemory = useProcessMemory;', context);
  const render = (key = '[["memory-root",321]]') => {
    cursor = 0;
    const value = context.readMemory(key);
    while (effects.length) effects.shift()();
    return value;
  };
  const drain = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  const response = { ok: true, cacheAgeMs: 0, roots: [memoryRoot] };
  render();
  assert.equal(requests[0].url, '/api/processes/memory');
  assert.equal(requests[0].options.cache, 'no-store');
  render();
  assert.equal(requests.length, 1, 'ordinary output refreshes must not launch more probes');
  document.visibilityState = 'hidden'; listeners.get('visibilitychange')();
  requests[0].resolve(response); await drain();
  assert.equal(render(), null, 'a response arriving after hiding must not populate a gauge');
  assert.equal(timers.size, 0, 'hidden pages must not poll memory');
  document.visibilityState = 'visible'; listeners.get('visibilitychange')();
  requests[1].resolve(response); await drain();
  assert.equal(render().roots[0].workingSetBytes, memoryRoot.workingSetBytes);
  assert.ok([...timers.values()].some(timer => timer.at === now + 5000), 'samples need an expiration deadline');
  now += 5000;
  for (const [id, timer] of [...timers]) {
    if (timer.at <= now) { timers.delete(id); timer.callback(); }
  }
  assert.equal(render(), null, 'expired memory must disappear while a replacement is pending');
  assert.equal(requests.length, 3);
  slots.forEach(slot => slot?.cleanup?.());
  const writesAfterUnmount = writes;
  requests[2].resolve(response); await drain();
  assert.equal(writes, writesAfterUnmount, 'unmounted routes must ignore pending observations');
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);

  // Empty routes mount no sampler at all.
  slots.length = 0;
  render('[]');
  assert.equal(requests.length, 3);
  assert.equal(timers.size, 0);
  slots.forEach(slot => slot?.cleanup?.());
}
await exerciseProcessMemoryLifecycle();

processNodes.length = 0;
visitProcessNode(processRenderContext.renderProcessRow({ row: memoryRow() }));
assert.ok(processNodes.includes('RAM 12 MiB'));
assert.ok(processNodes.some(node => node?.props?.title?.includes('Descendants are not included')));
processNodes.length = 0;
visitProcessNode(processRenderContext.renderProcessRow({ row: memoryRow({ ...memoryRoot, identityVerified: false }) }));
assert.ok(processNodes.includes('RAM unavailable'));

// Foreground changes must replace the previous color, including colors whose
// visual representation falls back to the terminal's default foreground.
for (const nextColor of [30, 35, 37, 90, 95, 97, 39]) {
  processNodes.length = 0;
  visitProcessNode(processRenderContext.renderProcesses(() => ({
    managedProcesses: [{
      processId: 'ansi-transition', status: 'running',
      stdoutTail: `\u001b[31merror\u001b[${nextColor}mnormal`, stderrTail: ''
    }]
  }))());
  const output = processNodes.find(node => node?.type === 'pre' && node.props['aria-label'] === 'Recent stdout output');
  const chunks = output.children.flat();
  assert.equal(chunks[0].props.className, 'ansi-red');
  assert.equal(chunks[0].children.join(''), 'error');
  assert.equal(chunks[1], 'normal', `SGR ${nextColor} must not retain the preceding error color`);
}

// Drive the real OutputBlock effects with controlled request completion order.
async function exerciseProcessOutputFollow(newestFirst) {
  const slots = [];
  const pendingEffects = [];
  const requests = [];
  let cursor = 0;
  let writes = 0;
  let props;
  let tree;
  const context = {
    React: { createElement: (type, nodeProps, ...children) => ({ type, props: nodeProps || {}, children }) },
    memo: component => component,
    useState(initial) {
      const index = cursor++;
      slots[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, next => {
        writes += 1;
        slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ||= { value: { current: initial } };
      return slots[index].value;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      pendingEffects.push(() => {
        previous?.cleanup?.();
        slots[index] = { dependencies, cleanup: effect() };
      });
    },
    fetchJson(url) {
      return new Promise(resolve => requests.push({ url, resolve }));
    },
    URLSearchParams
  };
  vm.runInNewContext(processesSource.replace(/^import .*;\n/gm, '').replace('export function createProcessesRoute', 'function createProcessesRoute')
    + '\nglobalThis.renderOutput = OutputBlock;', context);
  const render = totalBytes => {
    props = {
      processId: 'follow-process', stream: 'stdout', value: 'B'.repeat(10), active: true,
      meta: { tailStartOffset: 10, totalBytes, retainedFromOffset: 0, droppedBytes: 0, tailTruncated: true, retentionTruncated: false }
    };
    cursor = 0;
    tree = context.renderOutput(props);
    while (pendingEffects.length) pendingEffects.shift()();
    return tree;
  };
  const flatten = node => node == null ? [] : Array.isArray(node) ? node.flatMap(flatten)
    : [node, ...(typeof node === 'object' ? (node.children || []).flatMap(flatten) : [])];
  const drain = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
  render(20);
  flatten(tree).find(node => node?.props?.['aria-label'] === 'Load earlier stdout output').props.onClick();
  requests[0].resolve({ ok: true, range: { offset: 0, nextOffset: 10, text: 'A'.repeat(10) } });
  await drain();
  render(20);
  render(30);
  assert.equal(requests.length, 2);
  render(40); // New live bytes arrive while the prior range request is unresolved.
  assert.equal(requests.length, 3, 'new output must retain a pending follower when the previous effect is invalidated');
  const older = () => requests[1].resolve({ ok: true, range: { offset: 20, nextOffset: 30, text: 'C'.repeat(10) } });
  const newer = () => requests[2].resolve({ ok: true, range: { offset: 20, nextOffset: 40, text: 'C'.repeat(10) + 'D'.repeat(10) } });
  if (newestFirst) { newer(); await drain(); older(); } else { older(); await drain(); newer(); }
  await drain();
  render(40);
  const output = flatten(tree).find(node => node?.type === 'pre');
  assert.equal(output.children.join(''), 'A'.repeat(10) + 'B'.repeat(10) + 'C'.repeat(10) + 'D'.repeat(10), 'latest range must append once, without losing or duplicating bytes after an overlap');
  render(50);
  assert.equal(requests.length, 4, 'following must continue after the overlap');
  slots.forEach(slot => slot?.cleanup?.());
  const writesBeforeUnmountResponse = writes;
  requests[3].resolve({ ok: true, range: { offset: 40, nextOffset: 50, text: 'E'.repeat(10) } });
  await drain();
  assert.equal(writes, writesBeforeUnmountResponse, 'a disposed output follower must ignore its pending response');
}
await exerciseProcessOutputFollow(false);
await exerciseProcessOutputFollow(true);

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
