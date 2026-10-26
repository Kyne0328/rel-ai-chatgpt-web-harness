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

async function exerciseDesktopLogFallback(getRuntimeLogs) {
  const context = { window: getRuntimeLogs ? { relaiDesktop: { getRuntimeLogs } } : {} };
  vm.runInNewContext(`${functionSource(diagnostics, 'loadDesktopRuntimeLogs')}\nglobalThis.loadDesktopRuntimeLogs = loadDesktopRuntimeLogs;`, context);
  return context.loadDesktopRuntimeLogs();
}

assert.equal((await exerciseDesktopLogFallback(async () => ({ available: true, entries: [{ level: 'error', message: 'Heap out of memory' }] }))).entries[0].message,
  'Heap out of memory', 'desktop logs remain available when the diagnostics HTTP service is offline');
assert.equal(await exerciseDesktopLogFallback(async () => { throw new Error('IPC is unavailable'); }), null,
  'an unavailable desktop bridge must retain the normal diagnostics error state');
assert.equal(await exerciseDesktopLogFallback(null), null,
  'browser-only dashboards must not require Electron IPC');

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
assert.doesNotMatch(functionSource(sessionsReact, 'PlanSection'), /task-plan-collapsible|h\('details'/, 'task plans must remain visible instead of using a disclosure control');
assert.doesNotMatch(sessionsReact, /modeLabel.*Planned.*Direct/s, 'durable task rows must not expose obsolete Direct versus Planned mode labels');
assert.match(sessionsReact, /label: 'Tool calls'/, 'task inspector must retain tool-call counts after list simplification');
assert.match(sessionsReact, /label: 'Project files'/, 'task inspector must retain the Project files count');
assert.match(sessionsReact, /href: taskChangesHref\(id\)/, 'Overview must link to the dedicated Changes viewer instead of rendering a duplicate file list');
assert.doesNotMatch(sessionsReact, /ChangedFilesSection|ChangedFileGroup|FileList\(/, 'Overview must not duplicate the Changes file browser');
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
assert.match(sessionsReact, /orderSessionEvents\(session\.events \|\| \[\]\)/, 'open task Activity must render canonical task events instead of raw audit trace rows');
assert.doesNotMatch(sessionsReact, /mergeSessionEvents\(traceEvents/, 'raw audit trace rows must not inflate the user-facing task Activity timeline');
assert.match(sessionsReact, /recent = ordered.slice\(0, visibleCount\)/, 'task-level Activity must expand incrementally');
assert.match(sessionsReact, /View all activity/, 'full event history remains accessible through Activity');
assert.match(sessionsReact, /data-load-more-task-activity/, 'Task Activity must offer inline View more activity');
assert.doesNotMatch(sessionsReact, /TaskEventInspector|setSelected\(event\)/, 'Task Activity must not duplicate the full event inspector');
assert.match(sessionsReact, /event: activityEventId\(event\)/, 'task event links must deep-link into the exact Activity event');
assert.match(sessionsReact, /data-session-details/, 'task technical record remains accessible as a secondary disclosure');
assert.doesNotMatch(sessionsReact, /task-other-processes/, 'task Processes must not show unrelated project processes');
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

// Connection editing now uses saveTunnel; exercise its real callback rather than
// requiring the obsolete combined port/credential saveSettings call shape.
{
  const start = settingsReact.indexOf('  const add = async () => {', settingsReact.indexOf('function TunnelConnections'));
  const end = settingsReact.indexOf('  const remove = async connection => {', start);
  assert.ok(start >= 0 && end > start);
  for (const fails of [false, true]) {
    let saves = 0;
    let refreshes = 0;
    const context = {
      disabled: false, busyRef: { current: false }, rows: [], connections: [], statuses: [],
      draft: { label: 'Fixture', tunnelId: 'fixture-tunnel', apiKey: 'fixture-key', enabled: true },
      validateAdditionalTunnel: () => null,
      desktop: { saveTunnel: async () => { saves += 1; if (fails) throw new Error('fixture save rejected'); return { ok: true }; } },
      onChange: async () => {}, requestDashboardRefresh: () => { refreshes += 1; },
      setValidation() {}, setOpen() {}, setBusy() {}, setShowSecret() {}, resetDraft() {}, setDraft() {}, toast() {}, messageOf: String
    };
    vm.runInNewContext(settingsReact.slice(start, end) + '\n globalThis.save = add;', context);
    await context.save();
    assert.equal(saves, 1);
    assert.equal(refreshes, fails ? 0 : 1, 'a saved tunnel must refresh canonical dashboard state');
    assert.equal(context.busyRef.current, false);
  }
}


{
  const { getSnapshot, init, patchComputerControl } = await import('../src/ui/store.js');
  for (const enabled of [true, false]) {
    const workspaces = [{ alias: 'fixture', path: '/fixture' }];
    init({ config: { computerControl: { enabled: !enabled }, workspaces } });
    let refreshes = 0;
    let fails = false;
    const context = {
      h: (type, props, ...children) => ({ type, props: props || {}, children }),
      Card: 'card', ToggleRow: 'toggle',
      useState: value => [value, () => {}], useEffect() {},
      postJson: async () => fails ? { ok: false, error: 'Save rejected' } : { ok: true, settings: { enabled } },
      patchComputerControl,
      requestDashboardRefresh: () => { refreshes += 1; },
      toast() {}, messageOf: String
    };
    vm.runInNewContext(functionSource(settingsReact, 'ComputerControlSettings') + '\nglobalThis.render = ComputerControlSettings;', context);
    context.render({ initial: getSnapshot().config.computerControl }).children[0].props.onChange(enabled);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getSnapshot().config.computerControl.enabled, enabled, 'a saved computer-control setting must update canonical state before route remount');
    assert.equal(getSnapshot().config.workspaces, workspaces, 'settings saves must preserve unrelated canonical configuration');
    assert.equal(context.render({ initial: getSnapshot().config.computerControl }).children[0].props.checked, enabled, 'remount must immediately show the saved setting');
    assert.equal(refreshes, 1, 'successful computer-control saves must request authoritative refresh');

    fails = true;
    context.render({ initial: getSnapshot().config.computerControl }).children[0].props.onChange(!enabled);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(getSnapshot().config.computerControl.enabled, enabled, 'a failed save must not change canonical permission state');
    assert.equal(refreshes, 1, 'failed saves must not request a mutation refresh');
  }
}

{
  const h = dashboardRefreshHarness();
  const first = h.context.refresh();
  const duplicate = h.context.refresh();
  const mutation = h.context.refresh({ source: 'local-change' });
  const secondMutation = h.context.refresh({ source: 'local-change' });
  assert.equal(h.requests.length, 1, 'concurrent refreshes must retain a single in-flight fetch');
  h.requests.shift()({ config: { computerControl: { enabled: false } } });
  await Promise.all([first, duplicate, mutation, secondMutation]);
  assert.equal(h.queued.length, 1, 'mutations during an older fetch must coalesce into one trailing refresh');
  h.queued.shift()();
  const trailing = h.context.refresh();
  h.requests.shift()({ config: { computerControl: { enabled: true } } });
  await trailing;
  assert.equal(h.state().config.computerControl.enabled, true, 'the post-mutation snapshot must become canonical');
  assert.equal(h.queued.length, 0, 'a completed mutation catch-up must not refresh forever');
}
for (const failed of [false, true]) {
  const h = dashboardRefreshHarness();
  const first = h.context.refresh();
  void h.context.refresh({ source: 'local-change' });
  h.requests.shift()({ ok: true });
  await first;
  h.queued.shift()();
  const second = h.context.refresh();
  void h.context.refresh({ source: 'local-change' });
  h.requests.shift()({ ok: true });
  await second;
  assert.equal(h.queued.length, 1, 'a mutation during a trailing fetch must receive its own later snapshot');
  h.queued.shift()();
  const third = h.context.refresh();
  h.requests.shift()(failed ? { ok: false, error: 'offline' } : { ok: true });
  await third;
  assert.equal(h.queued.length, 0, 'a settled trailing fetch must not retry without a new invalidation, including on failure');
}

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
    let _refreshLocalChangePending = false;
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


{
  const source = read('src/ui/features/code/react.js');
  const callbackSource = name => {
    const start = source.indexOf('  const ' + name + ' = useCallback(');
    const ending = /\n {2}}, \[[^\]]*\]\);/.exec(source.slice(start));
    const end = ending ? start + ending.index + ending[0].length : -1;
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
  };
  const requests = [];
  let displayed = null;
  let route = 'code';
  const context = {
    useCallback: fn => fn,
    mode: 'standalone', activeRef: { current: true }, onSelectFileRef: { current: null }, requestedPathRef: { current: '' },
    workspaceRequestRef: { current: 0 }, diffRequestRef: { current: 0 },
    taskIdRef: { current: 'task-a' }, filePathRef: { current: 'src/a.js' }, pendingDiffPathRef: { current: '' },
    bridge: {
      get: async () => ({ work_id: 'task-a', changedFiles: ['src/a.js'] }),
      diff: () => new Promise((resolve, reject) => requests.push({ resolve, reject }))
    },
    currentRoutePath: () => route,
    readRequestedTaskId: () => 'task-a', readRequestedFilePath: () => 'src/a.js',
    changedTextFiles: workspace => workspace.changedFiles,
    taskId: task => task?.work_id || '',
    setWorkspace() {}, setWorkspaceError() {}, setWorkspaceLoading() {}, setFilePath() {},
    setDiffFile: file => { displayed = file; },
    setViewerMessage() {}, setViewerTone() {}, replaceRouteParams() {},
    emptyViewerMessage: () => '', messageFor: String
  };
  vm.runInNewContext(callbackSource('loadDiff') + '\n'
    + callbackSource('showUnavailableFile') + '\n'
    + callbackSource('refreshWorkspace')
    + '\n globalThis.load = loadDiff; globalThis.refresh = refreshWorkspace;', context);
  const refresh = context.refresh('task-a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1, 'same-path refresh must load the selected diff');
  requests.shift().resolve({ work_id: 'task-a', path: 'src/a.js', content: 'revision-two' });
  await refresh;
  assert.equal(displayed.content, 'revision-two');
  const stale = context.load('task-a', 'src/a.js');
  const latest = context.load('task-a', 'src/a.js');
  requests[1].resolve({ work_id: 'task-a', path: 'src/a.js', content: 'latest-revision' });
  await latest;
  requests[0].resolve({ work_id: 'task-a', path: 'src/a.js', content: 'older-revision' });
  await stale;
  requests.length = 0;
  assert.equal(displayed.content, 'latest-revision', 'old in-flight diff must not overwrite a newer response');
  const departed = context.load('task-a', 'src/a.js');
  route = 'activity';
  requests.shift().reject(new Error('late old-route error'));
  await departed;
  assert.equal(displayed.content, 'latest-revision', 'late failures must not alter a different route');
  assert.match(source, /selectedTask\?\.changeRevision/, 'live refresh must track the selected task revision');

  let assignments = 0;
  let restorations = 0;
  const editor = { setModel() { assignments += 1; }, saveViewState: () => ({ selected: 3 }), restoreViewState() { restorations += 1; } };
  const monaco = { editor: { createModel(content, language) { return {
    value: content, language, disposed: false, getValue() { return this.value; }, setValue(value) { this.value = value; },
    getLanguageId() { return this.language; }, dispose() { this.disposed = true; }
  }; } } };
  const modelContext = {};
  vm.runInNewContext(functionSource(source, 'applyDiffModels') + '\n' + functionSource(source, 'clearDiffModels') + '\n globalThis.apply = applyDiffModels;', modelContext);
  const models = { current: [] };
  modelContext.apply(monaco, editor, models, { work_id: 'task-a', path: 'src/a.js', content: 'one', baseContent: 'zero' });
  const originalModels = [...models.current];
  const firstAssignments = assignments;
  modelContext.apply(monaco, editor, models, { work_id: 'task-a', path: 'src/a.js', content: 'two', baseContent: 'zero' });
  assert.equal(models.current[1], originalModels[1]);
  assert.equal(models.current[1].getValue(), 'two');
  assert.equal(assignments, firstAssignments, 'same file content updates must not detach Monaco models');
  assert.equal(restorations, 1, 'same file refresh must restore editor selection and scroll state');
}


{
  const { buildDashboardTaskDelta } = await import('../src/core/dashboard-data.ts');
  const task = { id: 'revision-fixture', title: 'Unchanged summary', workspace: 'fixture', status: 'running', changedFiles: ['src/a.js'], updatedAt: '2026-01-01T00:00:00Z' };
  const first = buildDashboardTaskDelta({}, [{ revision: 41, task }]).taskUpdates[0];
  const second = buildDashboardTaskDelta({}, [{ revision: 42, task }]).taskUpdates[0];
  assert.equal(first.changeRevision, 41);
  assert.equal(second.changeRevision, 42, 'the production task projection must retain its authoritative per-task activity revision');
  const { changeRevision: _first, ...firstSummary } = first;
  const { changeRevision: _second, ...secondSummary } = second;
  assert.deepEqual(firstSummary, secondSummary, 'fixture summaries stay identical while the actual task revision changes');
  const source = read('src/ui/features/code/react.js');
  const context = { classifyTaskChangedFiles: files => ({ productChangedFileCount: files.length }) };
  vm.runInNewContext(functionSource(source, 'codeTasks') + '\n' + functionSource(source, 'taskId') + '\n' + functionSource(source, 'taskLabel') + '\n globalThis.tasks = codeTasks;', context);
  assert.notEqual(context.tasks({ tasks: [first] })[0].changeRevision, context.tasks({ tasks: [second] })[0].changeRevision);
}


{
  const { repositorySummary } = await import('../src/ui/features/workspaces/model.js');
  const summary = repositorySummary({ exists: true, isGit: false, mutationBlock: { blocked: true } });
  assert.equal(summary.label, 'Changes blocked');
  assert.match(summary.description, /Read-only inspection remains available/);
  assert.doesNotMatch(summary.description, /File and command actions are available/);
}


// Pending form work must not consume edits or async folder results after submit.
{
  const model = await import('../src/ui/features/workspaces/model.js');
  const input = await import('../src/ui/workspace-input.js');
  const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(flatten) : [node, ...flatten(node.children)];
  const requests = [];
  const preflights = [];
  let slots = new Map(), cursor = 0, activeSlots, closed = 0, refreshed = 0, invalidated = 0, routeWorkspace = 'fixture';
  const context = {
    ...model, ...input,
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    Icon: 'icon', OverlayFrame: 'overlay', AlertDialog: {}, Dialog: {},
    document: { documentElement: { dataset: {} } }, window: { relaiDesktop: { getPathForFile: file => file.name } },
    useMemo: fn => fn(), useEffect() {}, markUnsaved() {}, toast() {}, navigate() {}, timeAgo: () => '',
    workSessionStateView: () => ({}), routeHref: () => '#tasks',
    getWorkspaceFilter: () => routeWorkspace, setWorkspaceFilter: value => { routeWorkspace = value; },
    invalidateCache: () => { invalidated++; }, requestDashboardRefresh: () => { refreshed++; },
    postJson: (url, body) => new Promise(resolve => requests.push({ url, body, resolve })),
    fetchJson: url => new Promise(resolve => preflights.push({ url, resolve }))
  };
  context.useState = initial => {
    const slot = cursor++, state = activeSlots;
    if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
    return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value; }];
  };
  context.useRef = initial => context.useState(() => ({ current: initial }))[0];
  vm.runInNewContext(workspaceModals.replace(/^import[\s\S]*?;\r?$/gm, '').replace(/^export /gm, '')
    + '\nglobalThis.components = { ProjectFormModal, RepairProjectModalContent, SourceFolders, deleteProject };', context);
  const render = (name, props) => {
    const fn = context.components[name];
    if (!slots.has(fn)) slots.set(fn, []);
    activeSlots = slots.get(fn); cursor = 0;
    return fn(props);
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  for (const mode of ['add', 'edit', 'repair']) {
    slots = new Map(); requests.length = 0; preflights.length = 0;
    const name = mode === 'repair' ? 'RepairProjectModalContent' : 'ProjectFormModal';
    const props = { mode, workspace: { alias: 'fixture', path: '/fixture' }, onClose: () => { closed++; } };
    const tree = () => render(name, props);
    const field = () => flatten(tree()).find(node => node.type === 'input' && node.props.name === (mode === 'repair' ? 'path' : 'alias'));
    const form = () => flatten(tree()).find(node => node.type === 'form');
    const sources = () => flatten(tree()).find(node => node.type === context.components.SourceFolders);
    const browse = mode === 'repair'
      ? null : sources().props.browse;
    const picker = browse?.();
    field().props.onChange({ target: { value: mode === 'repair' ? '/changed' : 'changed' } });
    const before = field().props.value;
    const submit = form().props.onSubmit;
    const saving = submit({ preventDefault() {} });
    await submit({ preventDefault() {} });
    assert.equal(requests.filter(item => item.url === '/api/workspaces').length, 1, mode + ': repeated submit must not issue a second mutation');
    assert.equal(field().props.disabled, true, mode + ': pending save disables the editable input');
    field().props.onChange({ target: { value: 'discarded-later-edit' } });
    assert.equal(field().props.value, before, mode + ': pending save rejects programmatic input as well');
    if (mode !== 'repair') {
      const source = sources();
      source.props.setPathsText('/later');
      source.props.setSourcePaths(['/later']);
      const folders = render('SourceFolders', source.props);
      assert.equal(flatten(folders).find(node => node.type === 'textarea').props.disabled, true);
      assert.equal(sources().props.pathsText, '/fixture');
      const drop = flatten(folders).find(node => node.props.onDrop);
      drop.props.onDrop({ preventDefault() {}, dataTransfer: { files: [{ name: '/dropped' }] } });
      assert.equal(preflights.length, 0, 'drop during save must be ignored before path lookup');
    } else {
      flatten(tree()).find(node => node.props.onDrop).props.onDrop({ preventDefault() {}, dataTransfer: { files: [{ name: '/dropped' }] } });
      assert.equal(preflights.length, 0);
    }
    const closedBefore = closed;
    requests.find(item => item.url === '/api/workspaces').resolve({ ok: false, error: 'fixture rejection' });
    await saving;
    assert.equal(closed, closedBefore, 'failed save keeps the dialog and draft');
    assert.equal(field().props.disabled, false);
    assert.equal(field().props.value, before);
    if (picker) {
      requests.find(item => item.url === '/api/pick-folder').resolve({ ok: true, path: '/late-picker' });
      await picker;
      assert.equal(sources().props.pathsText, '/fixture', 'picker started before save stays retired after a failed save');
    }
    requests.length = 0;
    const retry = form().props.onSubmit({ preventDefault() {} });
    requests[0].resolve({ ok: true });
    await retry;
    assert.equal(closed, closedBefore + 1, 'successful retry closes exactly once');
  }

  // Drop validation begun before a save cannot modify the unlocked draft later.
  for (const mode of ['add', 'repair']) {
    slots = new Map(); requests.length = 0; preflights.length = 0;
    const name = mode === 'repair' ? 'RepairProjectModalContent' : 'ProjectFormModal';
    const props = { workspace: { alias: 'fixture', path: '/fixture' }, onClose() {} };
    const tree = () => render(name, props);
    const folderTree = mode === 'repair' ? tree()
      : render('SourceFolders', flatten(tree()).find(node => node.type === context.components.SourceFolders).props);
    flatten(folderTree).find(node => node.props.onDrop).props.onDrop({ preventDefault() {}, dataTransfer: { files: [{ name: '/late-drop' }] } });
    assert.equal(preflights.length, 1);
    const saving = flatten(tree()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    requests[0].resolve({ ok: false, error: 'fixture rejection' });
    await saving;
    preflights[0].resolve({ ok: true, isDirectory: true, path: '/late-drop' });
    await flush();
    const pathValue = mode === 'repair'
      ? flatten(tree()).find(node => node.type === 'input' && node.props.name === 'path').props.value
      : flatten(tree()).find(node => node.type === context.components.SourceFolders).props.pathsText;
    assert.equal(pathValue, '/fixture', 'drop completion must not enter a different draft generation');
  }

  for (const selected of [false, true]) for (const forgetLocalData of [false, true]) for (const ok of [false, true]) {
    requests.length = 0; refreshed = 0; invalidated = 0;
    routeWorkspace = selected ? 'fixture' : 'other';
    const deletion = context.components.deleteProject('fixture', { forgetLocalData, setBusy() {}, onSuccess() {} });
    assert.equal(requests[0].body.forgetLocalData, forgetLocalData);
    requests[0].resolve({ ok, error: 'fixture rejection' });
    assert.equal(await deletion, ok);
    assert.equal(refreshed, ok ? 1 : 0, 'every successful deletion refreshes canonical configuration');
    assert.equal(invalidated, ok ? 1 : 0);
    assert.equal(routeWorkspace, ok && selected ? '' : selected ? 'fixture' : 'other');
  }
  requests.length = 0; routeWorkspace = 'fixture'; refreshed = 0;
  const deletion = context.components.deleteProject('fixture', { setBusy() {} });
  routeWorkspace = 'new-selection';
  requests[0].resolve({ ok: true });
  await deletion;
  assert.equal(routeWorkspace, 'new-selection', 'delete completion must preserve a newer project selection');
  assert.equal(refreshed, 1);
}

// Exercise real Activity callbacks with deterministic pending debounce work.
{
  const { activityFilterTransition, filterActivityEntries } = await import('../src/ui/features/activity/model.js');
  let filters = { search: 'needle', timeRange: '1h', workspace: '', tool: '', status: '', task: '' };
  let draft = filters.search, route = { ...filters }, timerId = 0;
  const timers = new Map();
  const context = {
    useCallback: fn => fn, activityFilterTransition,
    searchDraftRef: { current: draft }, searchTimerRef: { current: 0 }, tableWrapRef: { current: null },
    EMPTY_FILTERS: { search: '', timeRange: '1h', workspace: '', tool: '', status: '', task: '' },
    window: { clearTimeout: id => timers.delete(id), setTimeout: fn => { timers.set(++timerId, fn); return timerId; } },
    setSearchDraft: value => { draft = value; }, setFilterState: fn => { filters = fn(filters); },
    setRequestedEventId() {}, setUnseenLiveCount() {},
    activityRouteParams: value => value,
    replaceRouteParams: value => { route = value; }, navigate: (_section, value) => { route = value; }
  };
  const start = activity.indexOf('  const syncRoute = useCallback(');
  const end = activity.indexOf('  const openFilters = useCallback(', start);
  vm.runInNewContext(activity.slice(start, end) + '\nglobalThis.actions = { onSearch, clearFilters, removeFilter, applyFilters };', context);
  const runTimers = () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn()); };
  context.actions.clearFilters();
  assert.equal(draft, ''); assert.equal(route.search, '');
  context.actions.onSearch('late');
  context.actions.clearFilters();
  runTimers();
  assert.equal(draft, ''); assert.equal(filters.search, ''); assert.equal(route.search, '');
  context.actions.onSearch('late-chip');
  context.actions.removeFilter('search');
  runTimers();
  assert.equal(draft, ''); assert.equal(filters.search, '');
  context.actions.onSearch('preserved');
  context.actions.applyFilters({ status: 'failed', timeRange: '24h', workspace: '', tool: '', task: '' });
  runTimers();
  assert.equal(draft, 'preserved'); assert.equal(filters.search, 'preserved'); assert.equal(route.status, 'failed');
  context.actions.onSearch('newest');
  context.actions.removeFilter('status');
  runTimers();
  assert.equal(filters.search, 'newest'); assert.equal(filters.status, '');

  const hashStart = activity.indexOf('    const onHashChange = () => {');
  const hashEnd = activity.indexOf('    const onVisibilityChange', hashStart);
  context.readRouteState = () => ({ filters: { ...filters, search: 'history' }, eventId: '' });
  context.setSelectedEventId = () => {};
  context.setFilterState = value => { filters = typeof value === 'function' ? value(filters) : value; };
  vm.runInNewContext(activity.slice(hashStart, hashEnd) + '\nglobalThis.hashChange = onHashChange;', context);
  context.actions.onSearch('obsolete');
  context.hashChange();
  runTimers();
  assert.equal(draft, 'history'); assert.equal(filters.search, 'history');
  const entries = [{ title: 'history event', timestamp: new Date().toISOString() }, { title: 'unrelated', timestamp: new Date().toISOString() }];
  assert.equal(filterActivityEntries(entries, filters, Date.now()).length, 1, 'restored draft and effective list filter must agree');
  const uiContext = { h: (type, props, ...children) => ({ type, props, children }), Icon: 'icon', FilterChoice: 'filter-choice', TIME_OPTIONS: [] };
  vm.runInNewContext(functionSource(activity, 'hasActiveFilters') + '\n' + functionSource(activity, 'ActivityFilterBar') + '\nglobalThis.render = ActivityFilterBar;', uiContext);
  const tree = uiContext.render({ filterState: filters, searchDraft: draft, filters: [], summary: '', paused: false });
  const nodes = node => typeof node !== 'object' || !node ? [] : [node, ...(node.children || []).flatMap(nodes)];
  assert.equal(nodes(tree).find(node => node.type === 'input').props.value, 'history', 'input uses the controlled draft after route restoration');
}


{
  const rangeModel = await import('../src/ui/features/usage/range-model.js');
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.children)];
  let slots = [], cursor = 0, effects = [], routeWorkspace = 'historical-project';
  let models = [rangeModel.normalizeUsageSnapshot({ month: '2026-10', totals: { requests: 9, toolCalls: 9, successes: 9, failures: 0, executionMs: 9, activeDays: 1 },
    workspaces: [{ workspace: 'other', toolCalls: 9, successes: 9, failures: 0, executionMs: 9 }],
    series: [{ hour: '2026-10-17T03', toolCalls: 9 }],
    workspaceSeries: [{ hour: '2026-10-17T03', workspace: 'other', toolCalls: 9 }] })];
  const requested = [];
  const context = {
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    Icon: 'icon', AnalyticsToolbar: 'toolbar', UsageContent: 'content', USAGE_STORE_KEYS: [],
    window: { addEventListener() {}, removeEventListener() {} },
    getRouteParams: () => new URLSearchParams(), getWorkspaceFilter: () => routeWorkspace,
    replaceRouteParams: patch => { if ('workspace' in patch) routeWorkspace = patch.workspace || ''; },
    customDateDefaults: () => ({ start: '2026-10-01', end: '2026-10-17' }),
    ...rangeModel, analyticsBounds: range => rangeModel.analyticsBounds(range, { now: '2026-10-17T04:00:00Z' }),
    useMemo: fn => fn(), useEffect: fn => effects.push(fn), messageOf: String,
    loadAnalyticsData: async ({ bounds, workspace }) => {
      requested.push(workspace);
      return { models, bounds, current: rangeModel.analyticsRangeScope(models, bounds, { workspace }), previous: rangeModel.analyticsRangeScope([], bounds, { workspace }) };
    }
  };
  context.useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  vm.runInNewContext(functionSource(usageReact, 'createUsageRoute') + '\nglobalThis.route = createUsageRoute(() => {});', context);
  const render = () => { cursor = 0; effects = []; return context.route(); };
  const load = async () => { render(); effects[0](); await new Promise(resolve => setImmediate(resolve)); return render(); };
  let tree = await load();
  let toolbar = nodes(tree).find(node => node.type === 'toolbar').props;
  const content = nodes(tree).find(node => node.type === 'content').props;
  assert.equal(requested.at(-1), 'historical-project');
  assert.equal(toolbar.selectedWorkspace, routeWorkspace);
  assert.match(toolbar.options.find(option => option.workspace === routeWorkspace).label, /no data in this period/);
  assert.equal(content.current.toolCalls, 0);
  assert.equal(content.current.kind, 'workspace');
  assert.equal(content.current.label, routeWorkspace);
  assert.equal(rangeModel.analyticsRangeScope(models, content.bounds).toolCalls, 9, 'fixture must have aggregate activity outside the requested scope');
  toolbar.onWorkspaceChange('other');
  tree = await load();
  toolbar = nodes(tree).find(node => node.type === 'toolbar').props;
  assert.equal(nodes(tree).find(node => node.type === 'content').props.current.toolCalls, 9);
  models = [rangeModel.normalizeUsageSnapshot({ month: '2026-09', totals: { requests: 0, toolCalls: 0, successes: 0, failures: 0, executionMs: 0, activeDays: 0 }, workspaces: [], series: [] })];
  toolbar.onRangeChange('7d');
  tree = await load();
  toolbar = nodes(tree).find(node => node.type === 'toolbar').props;
  assert.equal(toolbar.selectedWorkspace, 'other', 'period changes must not disguise a project filter as All projects');
  assert.equal(routeWorkspace, 'other');
  assert.match(toolbar.options.find(option => option.workspace === 'other').label, /no data in this period/);
  assert.equal(nodes(tree).find(node => node.type === 'content').props.current.toolCalls, 0);
  context.rangeButtonLabel = (_key, label) => label;
  vm.runInNewContext(functionSource(usageReact, 'AnalyticsToolbar') + '\nglobalThis.toolbar = AnalyticsToolbar;', context);
  const selector = nodes(context.toolbar({ ...toolbar, end: '', start: '' })).find(node => node.type === 'select' && node.props['data-usage-workspace']);
  assert.equal(selector.props.value, 'other');
  assert.match(nodes(selector).find(node => node.type === 'option' && node.props.value === 'other').children.join(''), /other.*no data in this period/);
  toolbar.onWorkspaceChange('');
  await load();
  assert.equal(routeWorkspace, ''); assert.equal(requested.at(-1), '');
}

console.log('Dashboard live rendering contracts passed.');
