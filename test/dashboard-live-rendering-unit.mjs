// Browser acceptance owns route mounting, DOM identity, selection, and layout.
// Keep timing/race regressions and feature contracts that browser probes do not cover here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('public/dashboard.js');

const settingsReact = read('src/ui/features/settings/react.js');

const homeReact = read('src/ui/features/home/react.js');
const reactMain = read('src/ui/react/main.js');
const diagnostics = read('src/ui/features/settings/diagnostics-react.js');
const processesReact = read('src/ui/features/processes/react.js');
const toolsReact = read('src/ui/features/tools/react.js');
const usageReact = read('src/ui/features/usage/react.js');
const workspacesReact = read('src/ui/features/workspaces/react.js');
const workspaceModals = read('src/ui/features/workspaces/react-modals.js');

function functionSource(source, name) {
  const asyncStart = source.indexOf(`async function ${name}`);
  const syncStart = source.indexOf(`function ${name}`);
  const start = asyncStart >= 0 ? asyncStart : syncStart;
  assert.notEqual(start, -1, `missing function ${name}`);
  const signatureEnd = source.indexOf(')', start);
  const openingBrace = source.indexOf('{', signatureEnd);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function exerciseRuntimeLogDelta(runtime, change) {
  const context = {};
  vm.runInNewContext(`
    ${functionSource(diagnostics, 'finiteRevision')}
    ${functionSource(diagnostics, 'applyRuntimeLogDelta')}
    globalThis.applyRuntimeLogDelta = applyRuntimeLogDelta;
  `, context);
  return context.applyRuntimeLogDelta(runtime, change);
}

function exerciseTunnelDoctorPresentation(result) {
  const context = {};
  vm.runInNewContext(`
    ${functionSource(diagnostics, 'tunnelDoctorPresentation')}
    globalThis.tunnelDoctorPresentation = tunnelDoctorPresentation;
  `, context);
  return context.tunnelDoctorPresentation(result);
}

function exerciseTunnelDoctorCheckPresentation(check) {
  const context = {};
  vm.runInNewContext(`
    ${functionSource(diagnostics, 'tunnelDoctorCheckPresentation')}
    globalThis.tunnelDoctorCheckPresentation = tunnelDoctorCheckPresentation;
  `, context);
  return context.tunnelDoctorCheckPresentation(check);
}

assert.doesNotMatch(reactMain, /preloadRemainingReactRoutes/, 'the dashboard must not eagerly preload every inactive route in the background');
assert.match(reactMain, /reactRouteWarmups[\s\S]*\['usage'[\s\S]*components\/charts\.js/, 'Usage navigation intent must warm the chart chunk before the route needs it');
assert.match(reactMain, /function NavLink[\s\S]*onPointerEnter:\s*preload[\s\S]*onPointerDown:\s*preload[\s\S]*onFocus:\s*preload/, 'navigation links must warm lazy route code from pointer and keyboard intent');
assert.match(reactMain, /function preloadReactNavigationTarget[\s\S]*preloadReactRoute\(section\)/, 'navigation intent must resolve the target section and invoke the existing route preloader');
assert.match(read('src/ui/features/activity/react.js'), /cacheTtlMs:\s*15_000/, 'Activity history must reuse a short-lived read cache across route remounts');
assert.match(read('src/ui/features/tools/react.js'), /TOOL_CATALOG_CACHE_TTL_MS = 60 \* 1000[\s\S]*cacheTtlMs:\s*TOOL_CATALOG_CACHE_TTL_MS/, 'the read-only tool catalog must reuse its cached result across route remounts');
assert.match(read('src/ui/api.js'), /res\.ok && data\?\.ok !== false/, 'application-level error payloads must never be retained in the GET cache');
assert.doesNotMatch(homeReact, /dangerouslySetInnerHTML|pillHtml|taskProgressHtml/, 'Overview React must render status and progress as React elements instead of legacy HTML strings');
const clockBootSource = functionSource(dashboard, 'boot');
assert.match(clockBootSource, /pagehide[\s\S]*_dashboardClock\?\.stop\(\)/, 'pagehide must suspend the shared dashboard clock');
assert.match(clockBootSource, /pageshow[\s\S]*_dashboardClock\?\.start\(\)/, 'pageshow must restart the shared dashboard clock after page restoration');
assert.doesNotMatch(clockBootSource, /pagehide[\s\S]{0,120}once:\s*true/, 'page lifecycle handling must remain repeatable across multiple hide/show cycles');
const sessionsReact = read('src/ui/features/sessions/react.js');

const activity = read('src/ui/features/activity/react.js');

assert.doesNotMatch(activity, /dangerouslySetInnerHTML|pillHtml/, 'Activity React must render status pills as React elements instead of legacy HTML strings');
assert.match(activity, /activitySessionView\(entry, sessionIndex\)/, 'Activity rows must resolve task titles from the current session index');
assert.match(sessionsReact, /fetchJson\(`\$\{TASK_SESSION_URL\}\?task=/, 'task history must hydrate from the canonical task-session endpoint after immediate summary selection');
assert.doesNotMatch(sessionsReact, /Request ID|Trace ID/, 'session diagnostics must not present per-call protocol identifiers as stable task identifiers');
assert.doesNotMatch(sessionsReact, /task-plan-collapsible|h\('details'.*data-task-plan/s, 'task plans must remain visible instead of using a disclosure control');
assert.doesNotMatch(sessionsReact, /modeLabel.*Planned.*Direct/s, 'durable task rows must not expose obsolete Direct versus Planned mode labels');
assert.match(sessionsReact, /label: 'Tool calls'/, 'task inspector must retain tool-call counts after list simplification');
assert.match(sessionsReact, /label: 'Project files'/, 'task inspector must retain the Project files count');
assert.match(sessionsReact, /title: 'Project files'/, 'task inspector must retain the primary Project files section');
assert.match(sessionsReact, /const visible = expanded \? ordered : ordered\.slice\(0, DETAIL_FILE_PREVIEW\)/, 'Show more must append the remaining files into the same Project files list');
assert.match(sessionsReact, /h\(FileList, \{ files: visible, session, moreControl \}\)/, 'the Show more control and expanded files must share one file-list render');
assert.match(sessionsReact, /className: 'task-file-more-row'/, 'Show more must render as the final row of the same file list');
assert.doesNotMatch(sessionsReact, /task-detail-overflow-content|More \$\{title\.toLowerCase\(\)\}/, 'expanded files must not render in a disconnected secondary block');
assert.doesNotMatch(sessionsReact, /taskProgressHtml|Key activity|workflowTechnicalHtml/, 'Tasks must not reintroduce misleading per-tool whole-task progress or obsolete workflow guidance');
assert.match(sessionsReact, /h\(PlanSection, \{ plan: session\.plan \}\)/, 'task Overview must render the durable plan directly');
assert.doesNotMatch(sessionsReact, /label: 'Mode'.*Planned.*Direct/s, 'task inspector must not expose obsolete durable execution-mode labels');
assert.match(sessionsReact, /data-task-plan-missing/, 'a legacy task missing its checklist must show the missing-plan state instead of hiding the Plan section');
assert.match(sessionsReact, /Waiting for a plan before project work continues\./, 'missing-plan copy must explain why Planned work has not advanced');
assert.match(sessionsReact, /data-plan-step-status/, 'durable plan steps must expose their explicit status for styling and regression coverage');
assert.match(sessionsReact, /'aria-label': statusLabel/, 'each durable plan step must expose its state to assistive technology instead of relying on a visual glyph');
assert.match(sessionsReact, /key: `\$\{String\(step\?\.id \|\| 'step'\)\}:\$\{index\}`/, 'plan rows must keep React keys unique even when optional external step IDs collide');
assert.match(sessionsReact, /\['completed', 'skipped'\]/, 'plan resolved counts must come from explicit durable step states rather than tool-call history');
assert.match(sessionsReact, /steps resolved/, 'skipped steps must be described as resolved rather than incorrectly reported as completed');
assert.match(sessionsReact, /const ordered = orderSessionEvents\(session\.events \|\| \[\]\)/, 'open task Activity must render canonical task events instead of raw audit trace rows');
assert.doesNotMatch(sessionsReact, /mergeSessionEvents\(traceEvents/, 'raw audit trace rows must not inflate the user-facing task Activity timeline');
assert.match(sessionsReact, /data-show-older-events/, 'older task events must expand in the existing trace');
assert.match(sessionsReact, /data-load-older-task-activity/, 'long-running tasks must offer paged access to activity older than the bounded task snapshot');
assert.match(sessionsReact, /events: mergeSessionEvents\(previous\.session\?\.events \|\| \[\], response\.activity\.entries\)/, 'loading older task activity must merge retained events instead of replacing the visible timeline');
assert.match(sessionsReact, /event\.command/, 'recorded commands must remain attached to their activity event for traceability');
assert.match(sessionsReact, /task-event-command/, 'recorded commands must be visible in the activity trace');
assert.match(sessionsReact, /olderExpanded/, 'live task refreshes must preserve expanded older-event state');
assert.match(processesReact, /key: row\.processId/, 'Process rows must reconcile by canonical process identity');
assert.match(processesReact, /postJson\('\/api\/processes\/stop'/, 'Process stop must retain the existing backend lifecycle endpoint');
assert.match(processesReact, /data-stop-process/, 'Process stop controls must remain discoverable');
assert.match(processesReact, /stopError/, 'Process stop failures must retain their actionable error text instead of collapsing to a generic retry state');
assert.match(processesReact, /role: 'alert'/, 'Process stop failures must be announced accessibly');
assert.match(toolsReact, /result\?\.ok === false \|\| payload == null/, 'Tool API failures must remain distinct from an empty catalog');
assert.doesNotMatch(usageReact, /taskRevision/, 'Analytics must not re-read monthly history on every live task revision');
assert.doesNotMatch(homeReact, /HomeAnalytics, \{ taskRevision:/, 'Overview analytics must not re-read monthly history on every live task revision');
assert.doesNotMatch(workspacesReact, /useWorkspaceAnalytics\(analyticsAliases, Number\(data\.live/, 'Project analytics must not re-read monthly history on every live task revision');
assert.match(diagnostics, /visibilitychange/, 'Live Troubleshooting must reconcile feature-local report state after returning from a hidden window');
assert.match(diagnostics, /load\(\{ silent: true \}\)/, 'Visibility catch-up must reuse the bounded silent diagnostics refresh path');
assert.match(workspacesReact, /useWorkspaceAnalytics/, 'Projects must retain per-project analytics in React ownership');
assert.match(workspaceModals, /sourcePaths:\s*paths/, 'Project create and edit must preserve multi-source project folders');
assert.match(workspaceModals, /Forget stored activity for this project/, 'Project deletion must expose an explicit stored-activity cleanup choice');
assert.match(workspaceModals, /forgetLocalData/, 'Project deletion must pass the cleanup choice to the workspace API');
assert.match(diagnostics, /runTunnelDoctor/, 'Troubleshooting must expose the bundled Secure MCP Tunnel doctor through the desktop bridge');
assert.match(diagnostics, /data-diagnostic-region': 'tunnel-doctor'/, 'Troubleshooting must render structured tunnel doctor results');
{
  const skippedOnly = exerciseTunnelDoctorPresentation({
    ok: false,
    result: 'skip',
    exitCode: 0,
    failedChecks: [],
    checks: [{ id: 'codex_plugin', status: 'SKIP' }]
  });
  assert.equal(skippedOnly.needsAttention, false, 'optional-only doctor skips must not look like a tunnel problem');
  assert.equal(skippedOnly.label, 'Healthy');
  assert.equal(skippedOnly.toastVariant, 'success');
  const codexPlugin = exerciseTunnelDoctorCheckPresentation({
    id: 'codex_plugin',
    status: 'SKIP',
    summary: 'Codex detected; Tunnel MCP plugin not installed',
    next: ['tunnel-client codex plugin install']
  });
  assert.equal(codexPlugin.statusLabel, 'Optional');
  assert.equal(codexPlugin.tone, 'optional');
  assert.equal(codexPlugin.optionalSetup, true);
  assert.match(codexPlugin.why, /work normally without this plugin/i);
  const failedDoctor = exerciseTunnelDoctorPresentation({
    ok: false,
    result: 'fail',
    exitCode: 2,
    failedChecks: ['mcp_server_reachable'],
    checks: [{ id: 'mcp_server_reachable', status: 'FAIL' }]
  });
  assert.equal(failedDoctor.needsAttention, true, 'real tunnel failures must remain visually actionable');
  assert.equal(failedDoctor.label, 'Needs attention');
}
assert.match(diagnostics, /role: 'log'/, 'Diagnostic log regions must retain explicit log semantics without making the whole stream aria-live');
assert.doesNotMatch(diagnostics, /aria-live[^\n]*diagnostic-log-list|window\.prompt/, 'Diagnostics must not turn the full live log into an aria-live region or regress to a native prompt');
{
  const runtime = { revision: 4, count: 1, entries: [{ message: 'existing' }] };
  const duplicate = exerciseRuntimeLogDelta(runtime, { type: 'append', revision: 4, count: 1, entry: { message: 'duplicate', level: 'info' } });
  assert.equal(duplicate.kind, 'duplicate');
  assert.deepEqual(Array.from(duplicate.runtime.entries, entry => entry.message), ['existing'], 'duplicate diagnostic revisions must not duplicate log rows');

  const gap = exerciseRuntimeLogDelta(runtime, { type: 'append', revision: 6, count: 2, entry: { message: 'gap', level: 'warning' } });
  assert.equal(gap.kind, 'refresh', 'revision gaps must request an authoritative diagnostic refresh');
  assert.deepEqual(Array.from(gap.runtime.entries, entry => entry.message), ['existing']);

  const next = exerciseRuntimeLogDelta(runtime, { type: 'append', revision: 5, count: 2, entry: { message: 'next', level: 'warning' } });
  assert.equal(next.kind, 'applied');
  assert.equal(next.runtime.revision, 5);
  assert.deepEqual(Array.from(next.runtime.entries, entry => entry.message), ['existing', 'next']);
}
assert.match(settingsReact, /const state = connectionStateFor\(data\)/, 'Connection must derive status directly from the canonical dashboard snapshot');
assert.match(settingsReact, /data\.desktopStatus\?\.tunnelId \|\| data\.connection\?\.tunnelId/, 'Connection guidance must derive the Tunnel ID from canonical dashboard state');

const bootSource = functionSource(dashboard, 'boot');
assert.match(bootSource, /relai:dashboard-refresh', \(\) => doRefresh/, 'dashboard refresh events must refresh canonical state only');
const liveStateSource = functionSource(dashboard, 'liveStateChange');
assert.match(liveStateSource, /detail\.state === 'reconnecting'[\s\S]*_liveState !== 'reconnecting'/, 'a desktop SSE reconnect episode must be detected once instead of looping recovery on every backoff attempt');
assert.match(liveStateSource, /sse-reconnect-probe[\s\S]*quietFailure:\s*true/, 'desktop SSE reconnect must quietly probe dashboard authorization');
assert.match(reactMain, /class RouteErrorBoundary extends React\.Component/, 'React must own route failure containment');
assert.match(reactMain, /primaryLabel: 'Retry page'/, 'route failures must retain a visible retry action');

const refreshSource = functionSource(dashboard, 'performRefresh');
assert.match(refreshSource, /initStore\(hydrated\)[\s\S]*replayLiveEventsDuringRefresh\(\)[\s\S]*const refreshed = getStore\(\)/, 'aggregate refreshes must replay typed live events that arrived while the snapshot was in flight');
assert.match(refreshSource, /clearShellDashboardState\(\)/, 'a successful aggregate refresh must clear boot failure/loading state before showing the React route');
assert.match(refreshSource, /clearRecoveryNotice\(\{ announce: options\.announceRecovery === true \}\)/, 'routine catch-up refreshes must not announce a false connection restoration');
assert.match(functionSource(dashboard, 'recoverDashboard'), /announceRecovery:\s*true/, 'actual dashboard recovery must still announce restoration after a successful retry');
assert.match(functionSource(dashboard, 'liveOnEvent'), /bufferLiveEventDuringRefresh\(event\)/, 'live events must be retained while an aggregate refresh is in flight');
const refreshCoordinatorSource = functionSource(dashboard, 'doRefresh');
assert.match(refreshCoordinatorSource, /_refreshLiveEvents = \[\]/, 'each aggregate refresh must start a fresh bounded live-event buffer');
assert.match(refreshCoordinatorSource, /needsCatchUp[\s\S]*live-refresh-overflow/, 'buffer overflow must schedule an authoritative catch-up refresh instead of silently dropping state');
assert.match(functionSource(dashboard, 'bufferLiveEventDuringRefresh'), /MAX_REFRESH_LIVE_EVENTS[\s\S]*_refreshLiveEventOverflow = true/, 'refresh buffering must stay bounded and record overflow');

assert.match(settingsReact, /saveSettings\(\{ port: form\.port, tunnelId: form\.tunnelId, tunnelApiKey: form\.tunnelApiKey \}\)[\s\S]*requestDashboardRefresh\(\)/, 'Secure tunnel configuration changes must refresh canonical dashboard state');

function dashboardRefreshHarness() {
  let state = { live: { streamId: 'a', revisions: { tasks: 1 } } };
  const requests = [];
  const queued = [];
  const context = {
    fetchJson: () => new Promise(resolve => requests.push(resolve)),
    invalidateCache() {}, DASHBOARD_DATA_URL: '/data',
    getStore: () => state,
    initStore: value => { state = value; },
    withConnectionState: value => value,
    patchLocalConnection() {}, updateShell() {}, clearShellDashboardState() {},
    setShellLastEventAt() {}, clearRecoveryNotice() {}, syncDesktopSetupState() {},
    activateRouter() {}, replayLiveEventsDuringRefresh() {},
    renderRefreshFailure: value => value,
    dashboardHidden: () => false,
    queueMicrotask: callback => queued.push(callback),
    surface: 'browser'
  };
  vm.runInNewContext(`
    let _refreshPromise = null, _refreshLiveEvents = null, _refreshLiveEventOverflow = false;
    let _liveReadyTarget = null, _liveReadyVersion = 0;
    let _liveState = 'live', _lastEventAt = null, _routerReady = true;
    let _hiddenViewDirty = false, _hiddenCatchUpRequired = false;
    ${functionSource(dashboard, 'liveCatchUpRequired')}
    ${functionSource(dashboard, 'performRefresh')}
    ${functionSource(dashboard, 'doRefresh')}
    ${functionSource(dashboard, 'liveStateChange')}
    globalThis.refresh = doRefresh;
    globalThis.ready = liveStateChange;
  `, context);
  return { context, requests, queued, state: () => state };
}

for (const streamId of ['a', 'b']) {
  const h = dashboardRefreshHarness();
  const first = h.context.refresh();
  h.context.ready({ state: 'live', streamId, revisions: { tasks: 4 } });
  h.context.ready({ state: 'live' }); // Ordinary events must retain the ready target.
  h.requests.shift()({ live: { streamId: 'a', revisions: { tasks: 1 } } });
  await first;
  assert.equal(h.queued.length, 1, 'a newer ready target must survive an older in-flight fetch');
  h.queued.shift()();
  const trailing = h.context.refresh();
  h.requests.shift()({ live: { streamId, revisions: { tasks: 4 } } });
  await trailing;
  assert.equal(h.state().live.streamId, streamId);
  assert.equal(h.state().live.revisions.tasks, 4);
  assert.equal(h.queued.length, 0, 'a caught-up snapshot must not start a refresh loop');
}
{
  const h = dashboardRefreshHarness();
  const first = h.context.refresh();
  h.context.ready({ state: 'live', streamId: 'a', revisions: { tasks: 4 } });
  h.requests.shift()({ live: { streamId: 'a', revisions: { tasks: 4 } } });
  await first;
  assert.equal(h.queued.length, 0, 'a snapshot already meeting the target needs no trailing fetch');
}
{
  const h = dashboardRefreshHarness();
  const first = h.context.refresh();
  h.context.ready({ state: 'live', streamId: 'b', revisions: { tasks: 4 } });
  h.requests.shift()({ live: { streamId: 'a', revisions: { tasks: 1 } } });
  await first;
  h.queued.shift()();
  const trailing = h.context.refresh();
  h.requests.shift()({ ok: false, error: 'offline' });
  await trailing;
  assert.equal(h.queued.length, 0, 'failed catch-up must not create an unbounded microtask retry loop');
}
{
  const h = dashboardRefreshHarness();
  const first = h.context.refresh();
  h.context.ready({ state: 'live', streamId: 'b', revisions: { tasks: 4 } });
  h.requests.shift()({ live: { streamId: 'a', revisions: { tasks: 1 } } });
  await first;
  h.queued.shift()();
  const second = h.context.refresh();
  h.context.ready({ state: 'live', streamId: 'c', revisions: { tasks: 8 } });
  h.requests.shift()({ live: { streamId: 'b', revisions: { tasks: 4 } } });
  await second;
  assert.equal(h.queued.length, 1, 'a new target during catch-up must receive its own trailing fetch');
  h.queued.shift()();
  const third = h.context.refresh();
  h.requests.shift()({ live: { streamId: 'c', revisions: { tasks: 8 } } });
  await third;
  assert.equal(h.queued.length, 0);
}

console.log('Dashboard live rendering contracts passed.');
