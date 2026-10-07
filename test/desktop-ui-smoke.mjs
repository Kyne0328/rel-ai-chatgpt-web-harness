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
  const saves = [];
  const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) });
  const context = {
    h, React: { Fragment: 'Fragment' }, SettingsField: 'SettingsField', StatusPill: 'StatusPill',
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: value => ({ current: value }), useEffect: () => {},
    tunnelRuntimeView: () => ({ label: 'Connected', tone: 'success', status: 'available' }),
    requestDashboardRefresh: () => {}, toast: () => {},
    messageOf: error => error.message,
    confirmAction: async () => false
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
      apiKey: 'synthetic-saved-key-must-not-display' }],
    desktop: { saveTunnel: async args => { saves.push(args); return { ok: true }; } }
  };
  const render = () => { stateIndex = 0; return context.renderConnections(props); };
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
  button(tree, 'Add ChatGPT tunnel').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves.length, 1);
  assert.equal(saves[0].apiKey, 'synthetic-replacement-key');
  assert.equal(saves[0].originalTunnelId, 'tunnel_fixture1234');
  tree = render();
  assert.equal(keyInput(tree), undefined, 'A successful save must close the credential editor');
  assert.doesNotMatch(JSON.stringify(states), /synthetic-replacement-key|synthetic-saved-key-must-not-display/, 'Saved replacement text must be cleared from renderer state');
}
await assertTunnelCredentialRendering();

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
