// IPC, settings, updater, window security/chrome, and lifecycle behavior have dedicated runtime tests.
// Keep renderer safety and composition regressions here rather than duplicating their source spelling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const statusHtml = read('electron/renderer/status.html');
const statusJs = read('electron/renderer/status.js');
const preload = read('electron/preload.cjs');

const mainEntry = read('electron/main.js');
const desktopHost = read('electron/desktop-host.js');
const desktopPower = read('electron/desktop-power.js');
const main = `${mainEntry}\n${desktopHost}\n${desktopPower}`;
const coreDesktopOperations = read('src/core/desktop-operations.ts');
const settingsReact = read('src/ui/features/settings/react.js');
const usageReact = read('src/ui/features/usage/react.js');

const updateStatusHelper = read('electron/update-status-helper.js');
const desktopLocalData = read('electron/desktop-local-data.js');
const toolHandlers = read('src/tools/handlers.js');
const dashboardJs = read('public/dashboard.js');
const onboardingUi = read('src/ui/features/onboarding/index.js');
const homeReact = read('src/ui/features/home/react.js');
const workspacesModals = read('src/ui/features/workspaces/react-modals.js');
const dashboardReact = read('src/ui/react/main.js');
const dashboardEvents = read('src/ui/events.js');
const dashboardWindowPolicy = read('electron/dashboard-window.js');

for (const file of ['electron/renderer/status.html', 'electron/renderer/wizard.html']) {
  const html = read(file);
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/color-tokens\.css"\s*\/?\s*>|<link\s+rel="stylesheet"\s+href="color-tokens\.css"\s*\/?\s*>/);
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/app\.css"\s*\/?\s*>|<link\s+rel="stylesheet"\s+href="app\.css"\s*\/?\s*>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /Open in browser/i);
}

assert.match(statusHtml, /Connection recovery/);
assert.match(statusHtml, /Secure MCP Tunnel/);
assert.match(statusHtml, /Copy tunnel ID/);
assert.match(statusHtml, /id="localHealthCard"/);
assert.match(statusHtml, /id="publicHealthCard"/);
assert.match(statusHtml, /id="serverToggleBtn"/);
assert.match(statusHtml, /id="restartAppBtn"/);
assert.doesNotMatch(statusHtml, /notificationToggleBtn|Desktop notifications/);
assert.doesNotMatch(statusHtml, /Connect to ChatGPT|guide-list/, 'Recovery must not duplicate the normal ChatGPT setup guide.');
assert.match(statusHtml, /id="errorTitle"/);
assert.match(statusHtml, /Recent app logs/);
assert.match(statusJs, /currentStatus\.tunnelId/);
assert.match(statusJs, /Tunnel ID copied/);
assert.match(statusJs, /The Secure MCP Tunnel did not become ready/);
assert.match(statusJs, /debugLogsToggle/);
assert.match(statusJs, /tunnelStatus === 'degraded'/);
assert.match(statusJs, /restartConnection\(\)/);
assert.match(statusJs, /relaunchApp\(\)/);
assert.match(statusJs, /Secure tunnel:/);
assert.match(statusJs, /Local MCP:/);
assert.match(statusJs, /safeDiagnosticText/);
assert.match(statusJs, /Task activity:/);
assert.match(statusJs, /setActionError/);
assert.match(statusJs, /function parseTimestampMs\(/, 'Recovery timers must normalize numeric and ISO timestamps through one parser');
assert.match(statusJs, /const startedAt = parseTimestampMs\(activity\.startedAt\)/, 'Recovery elapsed time must parse task start timestamps before subtraction');
assert.match(statusJs, /function relativeTime\(timestamp, now = Date\.now\(\)\)[\s\S]{0,180}parseTimestampMs\(timestamp\)/, 'Recovery relative time must parse ISO timestamps instead of subtracting strings');
assert.doesNotMatch(statusJs, /Date\.now\(\) - timestamp/, 'Recovery relative time must never subtract an unparsed timestamp');
assert.doesNotMatch(statusJs, /notificationToggleBtn|desktop notification setting could not be saved/i);
assert.doesNotMatch(statusJs, /updateUI\(\{\s*error:[\s\S]{0,160}tunnelStatus:\s*'failed'/, 'recovery action failures must not falsify the tunnel connection state');
assert.doesNotMatch(statusJs, /currentStatus\.mcpUrl|approval token|ngrok|gateway/i);

assert.match(preload, /return \(\) => ipcRenderer\.removeListener\(channel, listener\)/);
assert.doesNotMatch(preload, /removeAllListeners/);

// Exercise the current renderer callbacks. Saved credentials are represented by
// metadata; Show/Hide may reveal a replacement being typed, never a saved key.
async function assertTunnelCredentialRendering() {
  const states = [];
  let stateIndex = 0;
  let refIndex = 0;
  const refs = [];
  const saves = [];
  let rejectSave = false;
  let structuredSaveFailure = false;
  let discard = false;
  let confirmations = 0;
  let focusedField = '';
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const context = {
    h, React: { Fragment: 'Fragment' }, SettingsField: 'SettingsField', StatusPill: 'StatusPill',
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(value) { const index = refIndex++; return refs[index] ||= { current: value }; }, useEffect: () => {},
    window: { requestAnimationFrame: callback => callback() },
    document: { getElementById: id => ({ focus: () => { focusedField = id; } }) },
    tunnelRuntimeView: () => ({ label: 'Connected', tone: 'success', status: 'available' }),
    requestDashboardRefresh: () => {}, toast: () => {},
    messageOf: error => error.message,
    confirmAction: async () => { confirmations++; return discard; }
  };
  const definition = (name, next) => {
    const start = settingsReact.indexOf('function ' + name + '(');
    const end = settingsReact.indexOf('\nfunction ' + next + '(', start);
    assert.ok(start >= 0 && end > start, 'Missing renderer function boundary: ' + name);
    return settingsReact.slice(start, end);
  };
  vm.runInNewContext([
    definition('TunnelConnections', 'validateAdditionalTunnel'),
    definition('validateAdditionalTunnel', 'tunnelConnectionStatusSummary'),
    definition('tunnelConnectionStatusSummary', 'connectionSnapshot'),
    definition('connectionSnapshot', 'tunnelCredentialError'),
    'globalThis.renderConnections = TunnelConnections; globalThis.snapshot = connectionSnapshot;'
  ].join('\n'), context);
  const props = {
    connections: [{ label: 'Fixture account', tunnelId: 'tunnel_fixture1234', apiKeyConfigured: true,
      apiKey: 'synthetic-saved-key-must-not-display' },
      { label: 'Second account', tunnelId: 'tunnel_second1234', apiKeyConfigured: true }],
    desktop: { saveTunnel: async args => { saves.push(args); if (rejectSave) throw new Error('Synthetic save failure'); return structuredSaveFailure ? { ok: false, error: 'Synthetic structured save failure' } : { ok: true }; } }
  };
  const render = () => { stateIndex = 0; refIndex = 0; return context.renderConnections(props); };
  const allNodes = value => !value || typeof value !== 'object' ? []
    : [value, ...(value.children || []).flatMap(allNodes)];
  const button = (tree, label) => allNodes(tree).find(node => node.type === 'button' && node.children.includes(label));
  const keyInput = tree => allNodes(tree).find(node => node.props.id === 'additionalTunnelApiKey');
  let tree = render();
  assert.match(JSON.stringify(tree), /All tunnels connect to this computer’s projects/, 'Multi-account copy must explain the shared local projects');
  button(tree, 'Edit').props.onClick();
  tree = render();
  assert.equal(keyInput(tree).props.type, 'password');
  assert.equal(keyInput(tree).props.value, '', 'Editing a configured connection must not hydrate the saved key');
  assert.match(keyInput(tree).props.placeholder, /Saved securely.*replace/i);
  const keyField = allNodes(tree).find(node => node.props.inputId === 'additionalTunnelApiKey');
  assert.match(keyField.props.help, /runtime key.*encrypted on this computer/i);
  button(tree, 'Show').props.onClick();
  tree = render();
  assert.equal(keyInput(tree).props.type, 'text');
  assert.equal(keyInput(tree).props.value, '', 'Reveal must not recover a previously saved key');
  keyInput(tree).props.onChange({ currentTarget: { value: 'synthetic-replacement-key' } });
  tree = render();
  assert.equal(keyInput(tree).props.value, 'synthetic-replacement-key', 'Show can display only the replacement being edited');
  assert.doesNotMatch(JSON.stringify(tree), /synthetic-saved-key-must-not-display/);
  const snapshot = context.snapshot({ port: 3333, tunnelApiKey: 'synthetic-replacement-key', apiKey: 'synthetic-saved-key-must-not-display', tunnelApiKeyConfigured: true });
  assert.equal(snapshot, JSON.stringify({ port: 3333 }), 'Local-setting dirty state must contain only the non-secret port');
  button(tree, 'Hide').props.onClick();
  tree = render();
  assert.equal(keyInput(tree).props.type, 'password');
  assert.equal(button(tree, 'Save changes').props.type, 'submit', 'An edit must use a semantic Save submit action');
  const submit = allNodes(tree).find(node => node.type === 'form').props.onSubmit;
  let prevented = 0;
  submit({ preventDefault: () => { prevented++; } });
  submit({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2, 'Form submission must never navigate with credential values');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves.length, 1, 'Repeated form submission must save only once');
  assert.equal(saves[0].apiKey, 'synthetic-replacement-key');
  assert.equal(saves[0].originalTunnelId, 'tunnel_fixture1234');
  tree = render();
  assert.equal(keyInput(tree), undefined, 'A successful save must close the credential editor');
  assert.doesNotMatch(JSON.stringify([states, refs]), /synthetic-replacement-key|synthetic-saved-key-must-not-display/, 'Saved replacement text must be cleared from renderer state');

  button(tree, 'Edit').props.onClick();
  tree = render();
  assert.equal(tree.props['data-unsaved-changes'], 'false', 'Opening an unchanged draft must not block navigation');
  keyInput(tree).props.onChange({ currentTarget: { value: 'synthetic-unsaved-key' } });
  tree = render();
  assert.equal(tree.props['data-unsaved-changes'], 'true', 'The router and beforeunload guard must see a changed tunnel draft');
  button(tree, 'Edit').props.onClick();
  tree = render();
  assert.equal(keyInput(tree).props.value, 'synthetic-unsaved-key', 'Editing the same tunnel must retain its draft');
  allNodes(tree).filter(node => node.type === 'button' && node.children.includes('Edit'))[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(confirmations, 1);
  assert.equal(keyInput(tree).props.value, 'synthetic-unsaved-key', 'Declining edit-other must retain the secret draft');
  discard = true;
  allNodes(tree).filter(node => node.type === 'button' && node.children.includes('Edit'))[1].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(allNodes(tree).find(node => node.props.id === 'additionalTunnelId').props.value, 'tunnel_second1234');
  assert.equal(keyInput(tree).props.value, '');
  assert.equal(tree.props['data-unsaved-changes'], 'false');
  keyInput(tree).props.onChange({ currentTarget: { value: 'synthetic-failed-save-key' } });
  tree = render();
  rejectSave = true;
  allNodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(keyInput(tree).props.value, 'synthetic-failed-save-key', 'A rejected save must keep the draft for retry');
  assert.equal(tree.props['data-unsaved-changes'], 'true');
  rejectSave = false;
  structuredSaveFailure = true;
  allNodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  tree = render();
  assert.equal(keyInput(tree).props.value, 'synthetic-failed-save-key', 'A structured rejection without saved confirmation must retain the draft');
  button(tree, 'Cancel and discard').props.onClick();
  tree = render();
  assert.equal(keyInput(tree), undefined);
  assert.equal(tree.props['data-unsaved-changes'], 'false');
  assert.doesNotMatch(JSON.stringify([states, refs]), /synthetic-failed-save-key|synthetic-unsaved-key/, 'Explicit discard clears draft secrets from memory');
  button(tree, 'Add tunnel').props.onClick();
  tree = render();
  assert.ok(button(tree, 'Add ChatGPT tunnel'));
  allNodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(focusedField, 'additionalTunnelId', 'Invalid submission must focus the owning field');
}
await assertTunnelCredentialRendering();

// Exercise initial read failure/retry without a desktop window or real credentials.
// The tiny hook runner keeps effect cleanup and callback identity so late reads
// can be checked independently from the browser acceptance suite.
function settingsDefinition(name) {
  const start = settingsReact.indexOf('function ' + name + '(');
  const next = settingsReact.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0, 'Missing settings component: ' + name);
  return settingsReact.slice(start, next < 0 ? settingsReact.length : next);
}
function settingsReadHarness(names, overrides = {}) {
  const hooks = [];
  const effects = [];
  let cursor = 0;
  let pendingEffects = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const context = {
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    React: { Fragment: 'Fragment' }, Card: 'Card', ToggleRow: 'ToggleRow', StatusPill: 'StatusPill',
    SettingsHeader: 'SettingsHeader', StartupSettings: 'StartupSettings', ApplicationUpdates: 'ApplicationUpdates',
    BrowserSiteList: 'BrowserSiteList', DataRow: 'DataRow', DeveloperOptions: 'DeveloperOptions', QuitRow: 'QuitRow',
    DEVELOPER_FEATURE_FLAGS: [], NOTIFICATION_CATEGORIES: [], NOTIFICATION_DEFAULTS: { enabled: true },
    readDeveloperOptionsUnlocked: () => false,
    readDeveloperFeatureEnabled: () => false,
    messageOf: error => error.message || String(error), formatBytes: value => String(value || 0),
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(hooks[index]?.deps, deps)) hooks[index] = { deps, callback };
      return hooks[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!same(effects[index]?.deps, deps)) pendingEffects.push(() => {
        effects[index]?.cleanup?.();
        effects[index] = { deps, cleanup: effect() };
      });
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    subscribeRoute: () => () => {}, getRouteSnapshot: () => ({ search: '' }),
    window: { relaiDesktop: {} }, URL, URLSearchParams, setTimeout, clearTimeout,
    requestDashboardRefresh() {}, toast() {}, confirmAction: async () => false,
    ...overrides
  };
  vm.runInNewContext(names.map(settingsDefinition).join('\n'), context);
  return {
    context,
    render(name, props = {}) {
      cursor = 0; pendingEffects = [];
      const tree = context[name](props);
      const pending = pendingEffects; pendingEffects = [];
      pending.forEach(effect => effect());
      return tree;
    },
    unmount() { effects.forEach(effect => effect?.cleanup?.()); },
    hooks
  };
}
const settingsNodes = value => !value || typeof value !== 'object' ? []
  : [value, ...(value.children || []).flatMap(settingsNodes)];
const settleSettingsReads = () => new Promise(resolve => setImmediate(resolve));

for (const kind of ['notifications', 'lifecycle', 'telemetry', 'browser', 'storage']) {
  let reads = 0;
  const readResult = async () => {
    reads++;
    if (reads === 1) throw new Error('Synthetic ' + kind + ' read failure');
    if (kind === 'notifications') return { preferences: { enabled: true } };
    if (kind === 'lifecycle') return { keepRunningOnClose: true };
    if (kind === 'telemetry') return { ok: true, settings: { diagnosticsEnabled: false } };
    if (kind === 'browser') return { ok: true, sites: [] };
    return { ok: true, totalBytes: 123, activeTaskCount: 0, categories: {} };
  };
  const desktop = {
    getNotificationPreferences: readResult, setNotificationPreferences: async () => ({}),
    getLifecycleStatus: readResult, getLocalDataUsage: readResult,
    browser: { listSavedSites: readResult, getState: async () => ({ sessions: [] }), clearSavedSite() {}, clearSavedData() {} }
  };
  const component = { notifications: 'DesktopNotificationsSettings', lifecycle: 'ApplicationPage', telemetry: 'TelemetrySettings', browser: 'BrowserDataSettings', storage: 'LocalDataSettings' }[kind];
  const extra = kind === 'notifications' ? ['normalizeNotificationPreferences'] : kind === 'browser' ? ['isDevelopmentBrowserSite'] : [];
  const harness = settingsReadHarness([component, 'SettingsReadError', ...extra], { window: { relaiDesktop: desktop }, fetchJson: readResult });
  harness.render(component);
  await settleSettingsReads();
  let tree = harness.render(component);
  const retry = settingsNodes(tree).find(node => node.type === harness.context.SettingsReadError);
  assert.ok(retry, kind + ' must expose an inline retry after an initial failure');
  assert.match(retry.props.message, /Synthetic.*read failure/);
  assert.doesNotMatch(JSON.stringify(tree), /available only inside|available only in the installed/, kind + ' read failure must not masquerade as missing desktop capability');
  retry.props.onRetry();
  harness.render(component);
  await settleSettingsReads();
  tree = harness.render(component);
  assert.equal(reads, 2, kind + ' retry must make one new read');
  assert.equal(settingsNodes(tree).some(node => node.type === harness.context.SettingsReadError), false, kind + ' must recover after retry');
  harness.unmount();
}

// Structured read errors also recover when no account status was loaded.
{
  let calls = 0;
  const browser = {
    goalLoginStart() {},
    async goalLoginStatus() { return ++calls === 1 ? { ok: false, error: 'Synthetic sign-in read failure' } : { connections: [] }; }
  };
  const harness = settingsReadHarness(['GoalModeAccount']);
  harness.render('GoalModeAccount', { browser, connectionsRevision: 0 });
  await settleSettingsReads();
  let tree = harness.render('GoalModeAccount', { browser, connectionsRevision: 0 });
  const retry = settingsNodes(tree).find(node => node.type === 'button' && node.children.includes('Retry sign-in status'));
  assert.ok(retry);
  assert.equal(retry.props.disabled, false, 'Missing initial account status must not disable its recovery action');
  retry.props.onClick();
  await settleSettingsReads();
  tree = harness.render('GoalModeAccount', { browser, connectionsRevision: 0 });
  assert.equal(calls, 2);
  assert.doesNotMatch(JSON.stringify(tree), /Synthetic sign-in read failure/);
  harness.unmount();
}

// A read completing after unmount cannot restore stale settings.
{
  let resolveRead;
  const browser = {
    listSavedSites: () => new Promise(resolve => { resolveRead = resolve; }),
    getState: async () => ({ sessions: [] }), clearSavedSite() {}, clearSavedData() {}
  };
  const harness = settingsReadHarness(['BrowserDataSettings', 'isDevelopmentBrowserSite'], { window: { relaiDesktop: { browser } } });
  harness.render('BrowserDataSettings');
  harness.unmount();
  resolveRead({ sites: [{ origin: 'https://example.test', host: 'late-result' }] });
  await settleSettingsReads();
  assert.doesNotMatch(JSON.stringify(harness.hooks), /late-result/, 'Disposed browser-data reads must not update state');
}


// The spoken source-link name must retain its visible repository identity.
{
  const harness = settingsReadHarness(['AboutPage', 'validatedGitHubUrl', 'repositoryLabel', 'repositoryDocumentUrl', 'buildIdOf', 'runtimeCompatibilityNotice'], { AboutRow: 'AboutRow' });
  for (const repository of ['Kyne0328/rel-ai-chatgpt-web-harness', 'fixture-owner/renamed-repository']) {
    const url = 'https://github.com/' + repository;
    const tree = harness.render('AboutPage', { metadata: { repositoryUrl: url, version: '1.0.0' } });
    const link = settingsNodes(tree).find(node => node.type === 'a' && node.props.href === url);
    assert.ok(link);
    assert.equal(link.children.join(''), repository);
    assert.ok(link.props['aria-label'].includes(repository), 'Accessible source-link name must contain the visible owner/repository text');
    assert.match(link.props['aria-label'], /source code on GitHub/);
  }
  harness.unmount();
}


// Readiness is a named semantic group, not an unnamed generic container.
{
  const source = read('src/ui/features/workspaces/react.js');
  const start = source.indexOf('function WorkspacesView(');
  const end = source.indexOf('\nfunction DirectFilesystemAccess', start);
  const context = {
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    React: { Fragment: 'Fragment' }, useMemo: callback => callback(), useCallback: callback => callback,
    useState: value => [value, () => {}], useEffect() {}, useLayoutEffect() {},
    getWorkspaceFilter: () => '', getRouteParams: () => new URLSearchParams(),
    orderedWorkspaces: workspaces => workspaces, actionableFindings: () => [],
    workspaceCardView: workspace => ({ ...workspace, ready: true }),
    useWorkspaceAnalytics: () => ({ scopes: new Map(), status: 'ready' }),
    DirectFilesystemAccess: 'DirectFilesystemAccess', WorkspaceCard: 'WorkspaceCard'
  };
  vm.runInNewContext(source.slice(start, end), context);
  const tree = context.WorkspacesView({ data: { config: { workspaces: [{ alias: 'fixture' }] } } });
  const summary = settingsNodes(tree).find(node => node.props['aria-label'] === 'Project readiness summary');
  assert.equal(summary?.props.role, 'group', 'Project readiness must use a role that supports its accessible name');
}

// Project navigation always uses the card's current alias, including a rename.
{
  const source = read('src/ui/features/workspaces/react.js');
  const start = source.indexOf('const WorkspaceCard = memo(');
  const end = source.indexOf('\nfunction splitWorkspacePath', start);
  const context = {
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    memo: value => value, useState: value => [value, () => {}],
    repositorySummary: () => ({}), splitWorkspacePath: path => ({ prefix: '', tail: path }),
    WorkspaceReadiness: 'readiness', WorkspaceAnalytics: 'analytics', WorkspaceAnalyticsState: 'analytics-state',
    Icon: 'Icon', StatusPill: 'StatusPill', document: { documentElement: { dataset: { surface: 'web' } } },
    routeHref: (route, params) => '#' + route + '?' + new URLSearchParams(params)
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.renderCard = WorkspaceCard;', context);
  for (const alias of ['fixture-project', 'renamed.project']) {
    const tree = context.renderCard({ view: { alias, path: '/synthetic/project' }, workspace: { alias } });
    const links = settingsNodes(tree).filter(node => node.type === 'a');
    assert.equal(links.find(link => link.children.includes('View tasks'))?.props.href, '#tasks?workspace=' + alias);
    assert.equal(links.find(link => link.children.includes('Activity'))?.props.href, '#activity?workspace=' + alias);
    assert.ok(settingsNodes(tree).some(node => node.type === 'button' && node.children.includes('Edit project')));
  }
}



// Closing a project overlay while a mutation is pending must not hide its result.
{
  const repairStart = workspacesModals.indexOf('function RepairProjectModalContent(');
  const closeStart = workspacesModals.indexOf('  const requestClose = ', repairStart);
  const closeEnd = workspacesModals.indexOf('  const browse = ', closeStart);
  for (const busy of [true, false]) for (const dirty of [true, false]) {
    let closed = 0;
    let prompted = 0;
    const context = { busy, dirty, onClose: () => { closed++; }, setConfirmDiscard: () => { prompted++; } };
    vm.runInNewContext(workspacesModals.slice(closeStart, closeEnd) + '\nglobalThis.dismiss = requestClose;', context);
    context.dismiss();
    assert.equal(closed, !busy && !dirty ? 1 : 0);
    assert.equal(prompted, !busy && dirty ? 1 : 0);
  }
}
{
  const start = workspacesModals.indexOf('export function DeleteProjectModal(');
  const end = workspacesModals.indexOf('\nfunction SourceFolders', start);
  const descriptorStart = workspacesModals.indexOf('function deleteConfirmation(');
  const descriptorEnd = workspacesModals.indexOf('\nasync function deleteProject', descriptorStart);
  for (const busy of [true, false]) {
    let closed = 0;
    let currentBusy = busy;
    let forget = true;
    let stateIndex = 0;
    const deletions = [];
    const context = {
      h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
      ProjectModal: 'ProjectModal',
      useState(_initial) {
        const index = stateIndex++;
        return index === 0 ? [currentBusy, value => { currentBusy = value; }] : [forget, value => { forget = value; }];
      },
      useRef: value => ({ current: value }),
      deleteProject: async (alias, options) => { deletions.push({ alias, forgetLocalData: options.forgetLocalData }); }
    };
    vm.runInNewContext(workspacesModals.slice(start, end).replace(/^export /, '') + '\n' + workspacesModals.slice(descriptorStart, descriptorEnd), context);
    const render = () => { stateIndex = 0; return context.DeleteProjectModal({ alias: 'fixture', onClose: () => { closed++; } }); };
    let tree = render();
    tree.props.onDismiss();
    assert.equal(closed, busy ? 0 : 1, 'Escape/outside dismissal must wait for delete completion');
    const checkbox = settingsNodes(tree).find(node => node.type === 'input');
    assert.equal(checkbox.props.checked, true, 'Standalone deletion must retain the explicit forget-data choice');
    assert.equal(checkbox.props.disabled, busy);
    if (!busy) {
      checkbox.props.onChange({ currentTarget: { checked: false } });
      tree = render();
      settingsNodes(tree).find(node => node.type === 'button' && node.props.className === 'danger').props.onClick();
      assert.deepEqual(deletions, [{ alias: 'fixture', forgetLocalData: false }], 'The confirmed data-retention choice must reach the existing delete action');
    }
  }
}

assert.match(settingsReact, /'aria-invalid': validation\?\.field === 'tunnelId'/);
assert.doesNotMatch(settingsReact, /if \(issue\) return toast\(/, 'connection validation must stay beside the owning field');

assert.match(mainEntry, /void desktop\.start\(\)\.then\(/, 'Electron startup must not await app.whenReady-dependent work during ESM evaluation');
assert.match(main, /openDashboardWindow\('#settings'\)/);
assert.match(main, /openDashboardWindow\('#diagnostics'\)/);
assert.match(main, /serviceRuntime\.waitUntilListening\(0\)/, 'foreground dashboard opening must await the local service readiness promise without a shorter UI-only deadline');
assert.doesNotMatch(main, /options\.firstRun\s*\?\s*'#settings\/connection'/, 'first-run tunnel completion must not bounce users back to Connection');
assert.match(desktopHost, /serviceProcessClient\.markOnboardingHandoff\(\)/, 'first-run tunnel completion must delegate the Overview handoff to the core utility process');
assert.match(coreDesktopOperations, /writeOnboardingState\(\{[\s\S]{0,260}handoffPending:\s*true/, 'the core operation must persist the remaining Overview guide');
assert.match(main, /await showDashboardWindow\(''\)/, 'first-run tunnel completion must open Overview for the next setup step');
assert.match(main, /app\.relaunch\(\)/, 'desktop recovery must provide a full application relaunch escape hatch');
assert.match(main, /taskActivityBlockReason\(desktopPower\.getStatus\(\), 'restarting Rel\.AI'\)/, 'full app restart must remain guarded while Rel.AI work is active');
assert.match(main, /onReady:\s*hydrateRecoveryWindow/, 'recovery reloads must rehydrate from authoritative desktop state');
assert.match(main, /onExit:\s*\(\{ code \}\) => \{[\s\S]*!currentStatus\.serverRunning[\s\S]*launchConfiguredDesktop\(\{ restart: true, background: true \}\)/, 'an unexpected healthy local-service exit must restart the full connection in the background instead of leaving the dashboard reconnecting forever');
assert.match(main, /runtimeLogs\.snapshot\(\{\s*limit:\s*100\s*\}\)\.entries[\s\S]{0,120}recoveryWindowManager\.sendLog\(entry\)/, 'recovery reloads must restore the bounded recent diagnostic log tail');
assert.doesNotMatch(main, /waitForLocalService|setTimeout\(poll,\s*20\)/, 'local service readiness must not use a 20ms polling loop');
assert.match(main, /const status = launchOptions\.background[\s\S]{0,80}\? await pendingStart[\s\S]{0,80}: await serviceRuntime\.waitUntilListening\(0\)/, 'foreground startup, including first run, must follow authoritative local readiness instead of opening Recovery on a shorter UI-only timeout');
assert.doesNotMatch(main, /dashboard:\s*false/, 'tunnel state changes must reach the desktop dashboard without manual refresh');
assert.match(main, /setImmediate\(\(\) => \{[\s\S]*appUpdater\.start\(\)[\s\S]*updateSupportPolicy\.start\(\)/, 'updater policy work should begin after the first useful desktop startup path is scheduled');
assert.match(main, /browser-window-focus[\s\S]{0,260}appUpdater\?\.discoverUpdate\?\.\(\)/, 'focusing the desktop app must request throttled lightweight release discovery');
assert.match(desktopHost, /browser-window-focus[\s\S]{0,240}dashboardWindowManager\.getWindow\(\)[\s\S]{0,120}pulseWindowManager\.setSuppressed\(true\)/, 'focusing the Rel.AI dashboard must suppress the always-on-top Pulse so it cannot cover custom chrome');
assert.match(desktopHost, /browser-window-blur[\s\S]{0,220}dashboardWindowManager\.getWindow\(\)[\s\S]{0,120}pulseWindowManager\.setSuppressed\(false\)/, 'Pulse must resume when the Rel.AI dashboard loses focus');
assert.match(desktopPower, /powerMonitor\.on\('resume', handleResume\)/, 'desktop power integration must own the Electron resume listener');
assert.match(desktopHost, /onResume:\s*\(\)\s*=>\s*appUpdater\?\.discoverUpdate\?\.\(\{ force: true \}\)/, 'resuming from sleep must force a fresh lightweight release discovery check');
assert.match(dashboardEvents, /emitState\(['"]reconnecting['"],\s*\{\s*recoveryProbe:\s*true\s*\}\)/, 'each failed dashboard event-stream attempt must request a bounded authorization recovery probe');
assert.match(dashboardReact, /function retryActiveRoute[\s\S]*reloadDashboard[\s\S]*location\.reload/, 'failed React route rendering must retry with a fresh document instead of reusing broken client state');
assert.match(read('electron/local-protocol.js'), /await fs\.promises\.readFile\(target\)/, 'local renderer assets must not block the Electron main thread on file reads');

assert.match(mainEntry, /launchUpdateStatusHelper/);
assert.match(mainEntry, /completeApplicationUpdate/);
assert.match(desktopHost, /markUpdateInstallPhase\(app, 'installing'\)/);
assert.match(updateStatusHelper, /detached:\s*true/);
assert.match(settingsReact, /direct file and app actions when possible/i, 'Computer Control help must explain the preferred local-control path');
assert.match(settingsReact, /Full pointer or keyboard control is used only when necessary/i, 'Computer Control help must preserve the fallback-control boundary');
assert.match(main, /canHideOnClose:[\s\S]{0,180}keepRunningOnClose/, 'dashboard close behavior must honor the persisted user preference');
assert.match(main, /canUserClose:[\s\S]{0,180}allowUpdaterQuit[\s\S]{0,180}installing/, 'the dashboard must reject user close while the updater owns the application lifecycle');
assert.match(main, /setKeepAwakeEnabled\(lifecycleStatus\.keepAwake === true\)/, 'saved keep-awake preference must activate before normal desktop work starts');
assert.match(main, /reducedBackgroundWork:\s*lifecycleStatus\.reducedBackgroundWork === true/, 'saved reduced-background-work preference must reach the service before normal desktop work starts');
assert.match(settingsReact, /Download verified updates automatically/, 'App settings must expose verified automatic update downloads');
assert.match(toolHandlers, /REL_AI_REDUCED_BACKGROUND_WORK/, 'reduced background work must suppress optional repository pre-warming');
assert.match(desktopLocalData, /output-spills/, 'local-data cleanup must target bounded temporary command output');
assert.match(settingsReact, /api\/diagnostics\/reset/, 'category cleanup must reuse the existing guarded diagnostics resets');
assert.match(settingsReact, /target:\s*'analytics'/, 'analytics clearing must live with App local-data controls');
assert.doesNotMatch(usageReact, /data-usage-clear|Clear local analytics history\?/, 'Analytics page must not expose destructive analytics clearing');
assert.match(settingsReact, /Keep my local Rel\.AI data/, 'logout modal must offer one keep-data checkbox');
assert.match(settingsReact, /useState\(true\)/, 'logout modal must default to keeping local data');
assert.match(settingsReact, /relaiDesktop\.logout\(!keepData\)/, 'logout checkbox must map directly to the existing clear-data backend flag');
assert.doesNotMatch(settingsReact, /Log out & keep data|Clear local data…/, 'logout modal must not present competing keep/clear action buttons');
assert.match(settingsReact, /Project folders and project files are never deleted/);
assert.match(desktopHost, /connection\.clearConnectionState\(\)/, 'logout with kept data must remove only saved connection state');
assert.match(desktopHost, /desktopLocalData\.clearAll\(clearPlan\)/, 'clear-data logout must use the canonical local-data wipe');
assert.match(desktopLocalData, /contains project files/, 'full local-data clearing must refuse roots that contain configured projects');

assert.doesNotMatch(dashboardJs, /localStorage\.getItem\('relai_dashboard_route'\)/, 'hashless launches must default to Overview instead of restoring the previous route');
assert.match(dashboardJs, /initUpdateAvailableModal/);
assert.match(dashboardJs, /if \(hydrated\.onboarding\) syncDesktopSetupState\(hydrated\.onboarding\);\s*initStore\(hydrated\);/, 'dashboard refresh must hydrate onboarding state before the first routed render');
assert.doesNotMatch(dashboardJs, /fetchJson\('\/api\/onboarding\/status'\)/, 'onboarding must not require a second post-render status request');
assert.match(onboardingUi, /if \(!result\?\.ok\) completionPersisted = false;/, 'failed onboarding completion must remain retryable');
assert.match(onboardingUi, /if \(!result\?\.ok\) \{[\s\S]{0,180}announceDesktopSetupState\(true\)/, 'failed guide dismissal must restore the pending state');
assert.match(homeReact, /if \(!result\?\.ok\)[\s\S]{0,180}Could not dismiss the getting started guide/, 'dismissal failure must not report false success');
assert.match(homeReact, /Rel\.AI is connected and ready to use with ChatGPT!/, 'finishing onboarding must provide explicit success feedback');
assert.match(workspacesModals, /!isEdit && configuredWorkspaces\.length === 0\) navigate\('home'\)/, 'creating the first project must return onboarding users to Overview');
assert.match(dashboardWindowPolicy, /fs\.promises\.writeFile\(statePath, text\)/, 'debounced window-bound persistence must not block the Electron main thread');

console.log('Tunnel-only desktop UI smoke test passed.');
