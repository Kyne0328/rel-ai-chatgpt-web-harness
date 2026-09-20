import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('public/dashboard.js');
const api = read('src/ui/api.js');
const settingsReact = read('src/ui/features/settings/react.js');
const home = read('src/ui/features/home/index.js');
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

assert.doesNotMatch(dashboard, /syncLiveView|updateLiveView|renderViewIfChanged|viewRevisionKey|scheduleLiveViewSync|ensureRouteRoot/, 'dashboard bootstrap must not retain a second route rendering coordinator');
assert.doesNotMatch(dashboard, /from ['"]\.\/ui\/store\.js['"]/, 'the production dashboard bootstrap must not load the Zustand-backed store outside the Vite bundle');
assert.match(reactMain, /from ['"]\.\.\/store\.js['"]/, 'the Vite-built dashboard entry must own the canonical store dependency');
assert.match(reactMain, /function RouteOutlet\(/, 'the React shell must own the active route outlet');
assert.match(reactMain, /reactRouteComponents\.get\(route\.section\)/, 'the active React feature must be selected directly from the canonical route registry');
assert.doesNotMatch(reactMain, /preloadRemainingReactRoutes/, 'the dashboard must not eagerly preload every inactive route in the background');
const routerActivationSource = functionSource(dashboard, 'activateRouter');
assert.match(routerActivationSource, /void preloadReactRoutes\(initialSection\)/, 'the dashboard must warm the initial lazy route after the router becomes usable');
assert.match(routerActivationSource, /relai:route-change[\s\S]*preloadReactRoute\(section\)/, 'route changes must warm only the requested route');
assert.doesNotMatch(routerActivationSource, /preloadRemainingReactRoutes/, 'router activation must not schedule every remaining route for background loading');
assert.doesNotMatch(reactMain, /bridgeRouteSections|getReactSections|routeRoots|createReactSection|unmountReactSection|LegacyRouteOutlet/, 'React must not retain the migration bridge or per-route React roots');
assert.doesNotMatch(dashboard, /features\/settings\/(?:index|connector|diagnostics)\.js|updateConnectorLiveState|updateSystemLiveState/, 'dashboard bootstrap must not load legacy Settings or Troubleshooting renderers');
assert.match(settingsReact, /export function createSettingsRoute/, 'Settings must expose one React route factory');
assert.match(reactMain, /registerReactSection\('settings'/, 'Settings must be registered as a canonical React route');
assert.match(reactMain, /registerReactSection\('diagnostics'/, 'Troubleshooting must be registered as a canonical React route');
assert.doesNotMatch(home, /mountHome|updateHomeLiveState|syncHomeRegion|innerHTML/, 'Overview model must not retain the legacy DOM renderer or patch machinery');
assert.match(homeReact, /export function createHomeRoute/, 'Overview must expose one React route renderer');
assert.match(homeReact, /data-home-react/, 'Overview React route must own the rendered feature root');
assert.doesNotMatch(homeReact, /dangerouslySetInnerHTML|pillHtml|taskProgressHtml/, 'Overview React must render status and progress as React elements instead of legacy HTML strings');
assert.match(homeReact, /loadAnalyticsData/, 'Overview React route must retain the analytics preview');
assert.doesNotMatch(homeReact, /relai:clock-tick/, 'Overview must not duplicate the shared dashboard clock with per-second React state updates');
assert.match(homeReact, /data-clock-elapsed-start/, 'Overview active elapsed time must remain owned by the shared dashboard clock');
assert.match(homeReact, /data-clock-relative/, 'Overview relative time must remain owned by the shared dashboard clock');
assert.match(reactMain, /registerReactSection\('home'/, 'Overview must be registered as a canonical React route');
const sessions = read('src/ui/features/sessions/index.js');
const sessionsModel = read('src/ui/features/sessions/model.js');
const sessionsReact = read('src/ui/features/sessions/react.js');
const processes = read('src/ui/features/processes/index.js');
const activity = read('src/ui/features/activity/react.js');

assert.doesNotMatch(functionSource(dashboard, 'liveOnEvent'), /rerender|innerHTML|replaceChildren/, 'SSE events must update canonical state without remounting or patching route DOM');
assert.match(functionSource(dashboard, 'liveOnEvent'), /applyLiveEvent\(event\.type, event\.data\)/, 'SSE events must enter through the canonical dashboard store');
assert.doesNotMatch(dashboard, /mountHome|updateHomeLiveState|features\/sessions\/index\.js|updateTaskSessions|mountTasks/, 'dashboard bootstrap must not load legacy feature renderers');

const desktopStatusSource = functionSource(dashboard, 'applyDesktopStatus');
assert.match(desktopStatusSource, /patchLocalConnection/, 'desktop status pushes must update only their owned store slice');
assert.doesNotMatch(desktopStatusSource, /initStore/, 'desktop status pushes must not replace the whole dashboard store');
assert.doesNotMatch(desktopStatusSource, /syncLiveView|renderViewIfChanged|rerender/, 'desktop status pushes must rely on canonical store subscription instead of a second render path');
assert.doesNotMatch(home, /updateHomeLiveState/, 'Overview must not expose a legacy live DOM updater after React ownership');
assert.doesNotMatch(sessions, /mountTasks|updateTaskSessions|innerHTML|replaceChildren/, 'Sessions compatibility entrypoint must contain no legacy DOM renderer');
assert.match(sessionsReact, /export function createSessionsRoute/, 'Tasks must expose one React route factory');
assert.match(reactMain, /registerReactSection\('tasks'/, 'Tasks must be registered as a canonical React route');
assert.match(sessionsReact, /data-sessions-react/, 'Tasks React route must own the rendered feature root');
assert.match(activity, /export function createActivityRoute/, 'Activity must expose a React route factory');
assert.doesNotMatch(activity, /dangerouslySetInnerHTML|pillHtml/, 'Activity React must render status pills as React elements instead of legacy HTML strings');
assert.match(activity, /ACTIVITY_STORE_KEYS = Object\.freeze\(\['auditTail', 'tasks'\]\)/, 'Activity must subscribe only to the store slices it renders');
assert.match(reactMain, /registerReactSection\('activity'/, 'Activity must be registered as a canonical React route');
assert.match(activity, /h\('th', \{ scope: 'col', className: 'activity-message-column' \}, 'Activity'\)/, 'Activity must use one consolidated primary activity column');
assert.doesNotMatch(activity, /activity-tool-column|activity-task-column|activity-status-column|activity-action-column/, 'Activity must not split scan context across redundant desktop columns');
assert.match(activity, /activitySessionView\(entry, sessionIndex\)/, 'Activity rows must resolve task titles from the current session index');
assert.match(activity, /className: 'activity-row-task'[\s\S]*className: 'activity-row-project'/, 'Activity rows must retain task and project context as supporting metadata');
assert.match(activity, /className: 'activity-row-trigger'/, 'Activity rows must retain one native keyboard-focusable detail trigger');
assert.match(activity, /routeHref\('tasks'/, 'Activity details must deep-link back to Tasks');
assert.match(sessionsReact, /key: sessionIdentifier\(session\)/, 'task rows must reconcile by canonical work-session identity');
assert.match(sessionsReact, /const TaskRow = memo\(/, 'unchanged task rows must retain their React instance and DOM identity');
assert.match(sessionsReact, /data-clock-relative/, 'ended and inactive task rows must show relative age without second-level timers');
assert.match(sessionsReact, /data-clock-elapsed-start/, 'active task rows and running operations must retain the shared live elapsed clock');
assert.match(sessionsReact, /mergeSessionDetail\(hydrated\?\.id === selectedId[\s\S]*selectedSummary, data\)/, 'live snapshots must merge into the open inspector without clearing hydrated history');
assert.match(sessionsReact, /const \[activeTab, setActiveTab\] = useState\('overview'\)/, 'inspector tab selection must be React-owned state');
assert.match(sessionsReact, /if \(selectedIdRef\.current !== id\) \{[\s\S]*setActiveTab\('overview'\)/, 'inspector tab reset must be limited to selecting a different task, not passive live updates');
assert.match(sessionsReact, /flushSync\(\(\) => onSelect\(id\)\)/, 'task selection must commit the immediate summary before asynchronous history hydration');
assert.match(sessionsReact, /fetchJson\(`\$\{TASK_SESSION_URL\}\?task=/, 'task history must hydrate from the canonical task-session endpoint after immediate summary selection');
assert.match(sessionsReact, /data-session-inspector/, 'task detail rendering must target the persistent task inspector');
assert.match(sessionsReact, /h\('h3', null, 'Identifiers'\)/, 'session diagnostics must group task identifiers separately from runtime state');
assert.match(sessionsReact, /h\('h3', null, 'Runtime'\)/, 'session diagnostics must group runtime state separately from identifiers');
assert.doesNotMatch(sessionsReact, /Request ID|Trace ID/, 'session diagnostics must not present per-call protocol identifiers as stable task identifiers');
assert.match(sessionsReact, /toolCallCount/, 'session rows must keep the tool-call count visible in the scan-first list');
assert.match(sessionsReact, /project file/, 'session rows must keep the project-file count visible in the scan-first list');
assert.match(sessionsReact, /label: 'Tool calls'/, 'task inspector must retain tool-call counts after list simplification');
assert.match(sessionsReact, /label: 'Project files'/, 'task inspector must retain the Project files count');
assert.match(sessionsReact, /title: 'Project files'/, 'task inspector must retain the primary Project files section');
assert.match(sessionsReact, /const visible = expanded \? ordered : ordered\.slice\(0, DETAIL_FILE_PREVIEW\)/, 'Show more must append the remaining files into the same Project files list');
assert.match(sessionsReact, /h\(FileList, \{ files: visible, session, moreControl \}\)/, 'the Show more control and expanded files must share one file-list render');
assert.match(sessionsReact, /className: 'task-file-more-row'/, 'Show more must render as the final row of the same file list');
assert.doesNotMatch(sessionsReact, /task-detail-overflow-content|More \$\{title\.toLowerCase\(\)\}/, 'expanded files must not render in a disconnected secondary block');
assert.doesNotMatch(sessionsReact, /task-detail-current\$\{sessionNeedsAttention\(session\)/, 'task progress card must stay neutral when a separate attention callout is present');
assert.doesNotMatch(sessionsReact, /taskProgressHtml|Key activity|workflowTechnicalHtml/, 'Tasks must not reintroduce misleading per-tool whole-task progress or obsolete workflow guidance');
assert.match(sessionsReact, /h\(PlanSection, \{ plan: session\.plan \}\)/, 'task Overview must render the durable plan independently from activity history');
assert.match(sessionsReact, /data-plan-step-status/, 'durable plan steps must expose their explicit status for styling and regression coverage');
assert.match(sessionsReact, /'aria-label': statusLabel/, 'each durable plan step must expose its state to assistive technology instead of relying on a visual glyph');
assert.match(sessionsReact, /key: `\$\{String\(step\?\.id \|\| 'step'\)\}:\$\{index\}`/, 'plan rows must keep React keys unique even when optional external step IDs collide');
assert.match(sessionsReact, /\['completed', 'skipped'\]/, 'plan resolved counts must come from explicit durable step states rather than tool-call history');
assert.match(sessionsReact, /steps resolved/, 'skipped steps must be described as resolved rather than incorrectly reported as completed');
assert.match(sessionsReact, /const ordered = orderSessionEvents\(session\.events \|\| \[\]\)/, 'open task Activity must render canonical task events instead of raw audit trace rows');
assert.doesNotMatch(sessionsReact, /mergeSessionEvents\(traceEvents/, 'raw audit trace rows must not inflate the user-facing task Activity timeline');
assert.match(sessionsReact, /data-show-older-events/, 'older task events must expand in the existing trace');
assert.match(sessionsReact, /event\.command/, 'recorded commands must remain attached to their activity event for traceability');
assert.match(sessionsReact, /task-event-command/, 'recorded commands must be visible in the activity trace');
assert.match(sessionsReact, /olderExpanded/, 'live task refreshes must preserve expanded older-event state');
assert.match(sessionsModel, /workSessionStateView\(session\)/, 'status bucketing and open/terminal state must remain delegated to the canonical task-state model');
assert.doesNotMatch(processes, /mountProcesses|updateProcessesLiveState|innerHTML|replaceWith/, 'Processes model must not retain the legacy DOM renderer or live patch machinery');
assert.match(processesReact, /export function createProcessesRoute/, 'Processes must expose one React route factory');
assert.match(processesReact, /key: row\.processId/, 'Process rows must reconcile by canonical process identity');
assert.match(processesReact, /postJson\('\/api\/processes\/stop'/, 'Process stop must retain the existing backend lifecycle endpoint');
assert.match(processesReact, /data-stop-process/, 'Process stop controls must remain discoverable');
assert.match(processesReact, /stopError/, 'Process stop failures must retain their actionable error text instead of collapsing to a generic retry state');
assert.match(processesReact, /role: 'alert'/, 'Process stop failures must be announced accessibly');
assert.match(reactMain, /registerReactSection\('processes'/, 'Processes must be registered as a canonical React route');
assert.match(reactMain, /registerReactSection\('usage'/, 'Analytics must be registered as a canonical React route');
assert.match(toolsReact, /export function createToolsRoute/, 'Tools must expose one React route factory');
assert.match(toolsReact, /result\?\.ok === false \|\| payload == null/, 'Tool API failures must remain distinct from an empty catalog');
assert.match(reactMain, /registerReactSection\('tools'/, 'Tools must be registered as a React route');
assert.match(usageReact, /export function createUsageRoute/, 'Analytics must expose one React route factory');
assert.match(usageReact, /loadAnalyticsData/, 'Analytics must retain the canonical local analytics loader');
assert.match(usageReact, /taskRevision/, 'Analytics must refresh from canonical live task revisions');
assert.match(reactMain, /registerReactSection\('usage'/, 'Analytics must remain registered as a canonical React route');
assert.match(diagnostics, /export function createDiagnosticsRoute/, 'Troubleshooting must expose one React route factory');
assert.match(diagnostics, /visibilitychange/, 'Live Troubleshooting must reconcile feature-local report state after returning from a hidden window');
assert.match(diagnostics, /load\(\{ silent: true \}\)/, 'Visibility catch-up must reuse the bounded silent diagnostics refresh path');
assert.match(workspacesReact, /export function createWorkspacesRoute/, 'Projects must expose one React route factory');
assert.match(reactMain, /registerReactSection\('workspaces'/, 'Projects must be registered as a canonical React route');
assert.match(workspacesReact, /data-workspaces-react/, 'Projects React route must own the rendered feature root');
assert.match(workspacesReact, /useWorkspaceAnalytics/, 'Projects must retain per-project analytics in React ownership');
assert.match(workspaceModals, /sourcePaths:\s*paths/, 'Project create and edit must preserve multi-source project folders');
assert.match(workspaceModals, /markUnsaved\(formRef\.current, dirty\)/, 'Project forms must mark unsaved local React state for navigation protection');
assert.match(workspaceModals, /Forget stored activity for this project/, 'Project deletion must expose an explicit stored-activity cleanup choice');
assert.match(workspaceModals, /forgetLocalData/, 'Project deletion must pass the cleanup choice to the workspace API');
assert.doesNotMatch(diagnostics, /DiagnosticMaintenance|data-diagnostic-region': 'maintenance'/, 'Troubleshooting must not duplicate local-data cleanup controls owned by App settings');
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
assert.match(diagnostics, /Optional setup/, 'Optional Codex installation guidance must stay collapsed behind calm optional copy');
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
assert.match(sessionsReact, /const visibleSessions = sessions\.slice\(0, visibleCount\)/, 'Show more must derive rows from the latest canonical React snapshot');
assert.doesNotMatch(sessionsReact, /data-session-fingerprint|reconcileSessionRows|replaceWith/, 'Tasks must not retain legacy fingerprint or imperative row reconciliation');
assert.match(settingsReact, /const state = connectionStateFor\(data\)/, 'Connection must derive status directly from the canonical dashboard snapshot');
assert.doesNotMatch(settingsReact, /fetchJson\('\/api\/connection'|payload\?\.mcpConnection/, 'Connection must not maintain a competing connection snapshot');
assert.match(settingsReact, /data\.desktopStatus\?\.tunnelId \|\| data\.connection\?\.tunnelId/, 'Connection guidance must derive the Tunnel ID from canonical dashboard state');
const connectionSource = settingsReact.match(/function ConnectionPage[\s\S]*?function DesktopConnectionSettings/)?.[0] || '';
assert.doesNotMatch(connectionSource, /connector-technical-details|Execution mode|Native MCP Tasks/, 'Connection must not expose protocol execution internals in the normal UI.');
assert.match(settingsReact, /guideMode \? h\(ConnectionGuide/, 'Connection setup guidance must remain mounted from current React state rather than an imperative live-region replacement');
assert.doesNotMatch(sessionsReact, /replaceWith|replaceChildren|innerHTML/, 'React must own task history updates without imperative card replacement');

const bootSource = functionSource(dashboard, 'boot');
assert.match(bootSource, /mountReactFoundation\(ensureDashboardRoot\(\)/, 'the dashboard must mount one canonical React root');
assert.match(bootSource, /relai:dashboard-refresh', \(\) => doRefresh/, 'dashboard refresh events must refresh canonical state only');
assert.doesNotMatch(bootSource, /visibilitychange[\s\S]*doRefresh/, 'visibility changes must rely on SSE revision catch-up instead of rebuilding the dashboard');
assert.match(functionSource(dashboard, 'liveCatchUpRequired'), /remoteRevisions/, 'SSE reconnects must compare typed server revisions before refreshing');
const liveStateSource = functionSource(dashboard, 'liveStateChange');
assert.match(liveStateSource, /detail\.state === 'reconnecting'[\s\S]*_liveState !== 'reconnecting'/, 'a desktop SSE reconnect episode must be detected once instead of looping recovery on every backoff attempt');
assert.match(liveStateSource, /sse-reconnect-probe[\s\S]*quietFailure:\s*true/, 'desktop SSE reconnect must quietly probe dashboard authorization');
assert.doesNotMatch(dashboard, /lazySection|routeSection|data-route-retry|bridgeRouteSections|getReactSections/, 'the bootstrap must not retain route migration adapters or imperative route failure UI');
assert.equal(fs.existsSync(path.join(root, 'src/ui/components/table.js')), false, 'the unused imperative table virtualizer must be removed after the React cutover');
assert.match(reactMain, /class RouteErrorBoundary extends React\.Component/, 'React must own route failure containment');
assert.match(reactMain, /primaryLabel: 'Retry page'/, 'route failures must retain a visible retry action');

const refreshSource = functionSource(dashboard, 'performRefresh');
assert.match(refreshSource, /initStore\(hydrated\)[\s\S]*replayLiveEventsDuringRefresh\(\)[\s\S]*const refreshed = getStore\(\)/, 'aggregate refreshes must replay typed live events that arrived while the snapshot was in flight');
assert.match(refreshSource, /clearShellDashboardState\(\)/, 'a successful aggregate refresh must clear boot failure/loading state before showing the React route');
assert.match(refreshSource, /clearRecoveryNotice\(\{ announce: options\.announceRecovery === true \}\)/, 'routine catch-up refreshes must not announce a false connection restoration');
assert.match(functionSource(dashboard, 'recoverDashboard'), /announceRecovery:\s*true/, 'actual dashboard recovery must still announce restoration after a successful retry');
assert.doesNotMatch(refreshSource, /rerender|syncLiveView|renderViewIfChanged/, 'aggregate refreshes must not invoke a duplicate rendering path');
assert.match(functionSource(dashboard, 'liveOnEvent'), /bufferLiveEventDuringRefresh\(event\)/, 'live events must be retained while an aggregate refresh is in flight');
const refreshCoordinatorSource = functionSource(dashboard, 'doRefresh');
assert.match(refreshCoordinatorSource, /_refreshLiveEvents = \[\]/, 'each aggregate refresh must start a fresh bounded live-event buffer');
assert.match(refreshCoordinatorSource, /needsCatchUp[\s\S]*live-refresh-overflow/, 'buffer overflow must schedule an authoritative catch-up refresh instead of silently dropping state');
assert.match(functionSource(dashboard, 'bufferLiveEventDuringRefresh'), /MAX_REFRESH_LIVE_EVENTS[\s\S]*_refreshLiveEventOverflow = true/, 'refresh buffering must stay bounded and record overflow');

assert.match(api, /export function requestDashboardRefresh\(\)/, 'dashboard refresh helper must expose one canonical refresh signal');
assert.doesNotMatch(api, /structural/, 'dashboard refresh must not carry obsolete structural-render intent');
assert.match(settingsReact, /saveSettings\(\{ port: form\.port, tunnelId: form\.tunnelId, tunnelApiKey: form\.tunnelApiKey \}\)[\s\S]*requestDashboardRefresh\(\)/, 'Secure tunnel configuration changes must refresh canonical dashboard state');

console.log('Dashboard live rendering contracts passed.');
