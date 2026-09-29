import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_NAV_ITEMS, MOBILE_MORE_NAV_ITEMS, MOBILE_NAV_ITEMS, MOBILE_PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEMS, navigationCommands, routeMetadata } from '../src/ui/navigation-catalog.js';
import { normalizeRouteKey } from '../src/ui/route-policy.js';
import { activityFilterTransition, mergeActivityEntries } from '../src/ui/features/activity/model.js';
import { repositorySummary } from '../src/ui/features/workspaces/model.js';
import { DEVELOPER_FEATURES } from '../src/ui/developer-mode.js';
import { advanceDeveloperUnlockClicks, runtimeCompatibilityNotice } from '../src/ui/features/settings/react.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const shell = read('src/http/dashboardShell.ts');
const reactShell = read('src/ui/react/main.js');
const dashboard = read('public/dashboard.js');
const router = read('src/ui/router.js');
const settingsReact = read('src/ui/features/settings/react.js');
assert.match(shell, /rel="preload" as="image" href="\/public\/assets\/relai-logo\.png" fetchpriority="high"/, 'Dashboard shell must prioritize the shared Rel.AI logo used by persistent chrome');
assert.match(reactShell, /className: 'dashboard-state dashboard-state-loading'[\s\S]*dashboard-loading-skeleton/, 'Loading state must use an in-page skeleton instead of a branded blocking splash');
assert.doesNotMatch(reactShell, /dashboard-loading-logo/, 'Loading state must not reintroduce the branded splash shown during routine bootstrap');
assert.match(settingsReact, /runtimeCompatibilityNotice/, 'About must surface repository/runtime skew only when compatibility metadata reports a mismatch');
assert.match(settingsReact, /about-runtime-mismatch/, 'Runtime/source skew needs a bounded developer-facing notice instead of staying invisible');
assert.match(settingsReact, /Beta \/ pre-release \(developers & testers\)/, 'the beta release option must identify its developer/tester audience before selection');
assert.match(settingsReact, /updateChannel === 'beta' \? h\('div', \{[\s\S]*className: 'application-update-beta-warning'[\s\S]*role: 'alert'/, 'selecting beta must show a prominent accessible warning');
assert.match(settingsReact, /serious bugs or incomplete changes/i, 'the beta warning must state the risk of severe breakage plainly');
assert.match(settingsReact, /reinstall if a beta build fails/i, 'the beta warning must preserve the recovery consequence');
assert.match(settingsReact, /Use Stable for normal work/, 'the beta warning must clearly recommend Stable for normal use');
assert.equal(runtimeCompatibilityNotice(
  { applicationVersion: '1.1.3' },
  { applicationVersion: '1.1.3' },
  { available: true, metadataMatches: true }
), null, 'matching runtime/source metadata must stay silent');
assert.equal(runtimeCompatibilityNotice(
  { applicationVersion: '1.1.4' },
  { applicationVersion: '1.1.4' },
  { available: true, metadataMatches: false, compatible: true, restartRequired: false }
), null, 'same-version compatible metadata drift must not produce a false runtime/source warning');
const restartNotice = runtimeCompatibilityNotice(
  { applicationVersion: '1.1.2' },
  { applicationVersion: '1.1.3' },
  { available: true, metadataMatches: false, restartRequired: true, activeTasksPreventRestart: false }
);
assert.match(restartNotice?.message || '', /Restart Rel\.AI.*current source/i, 'restart-required skew must tell developers how to load the current source');
const blockedRestartNotice = runtimeCompatibilityNotice(
  { applicationVersion: '1.1.2' },
  { applicationVersion: '1.1.3' },
  { available: true, metadataMatches: false, restartRequired: true, activeTasksPreventRestart: true }
);
assert.match(blockedRestartNotice?.message || '', /Finish active tasks before restarting/i, 'active work must suppress misleading immediate-restart guidance');
const extensionsReact = read('src/ui/features/extensions/react.js');
const diagnosticsReact = read('src/ui/features/settings/diagnostics-react.js');
const homeReact = read('src/ui/features/home/react.js');
const activityReact = read('src/ui/features/activity/react.js');
const workspacesReact = read('src/ui/features/workspaces/react.js');
const browserReact = read('src/ui/features/browser/react.js');
const workspaceModalsReact = read('src/ui/features/workspaces/react-modals.js');
const modal = read('src/ui/components/modal.js');
const drawer = read('src/ui/components/drawer.js');

assert.match(browserReact, /Sign-ins are remembered unless ChatGPT explicitly starts a private session/, 'Browser empty state must explain persistent login behavior');
assert.match(browserReact, /Sign-ins remembered/, 'Active persistent browser sessions must visibly identify remembered sign-ins');
assert.match(browserReact, /Private session/, 'Ephemeral browser sessions must visibly identify private mode');
assert.match(browserReact, /Enter passwords and verification codes here, not in ChatGPT/, 'Browser handoff must direct sensitive sign-in input to the local browser');
assert.match(browserReact, /Allow for this session/, 'Site permission requests must require an explicit session-scoped user decision');
assert.doesNotMatch(browserReact, /Clear all saved browser data|Clear all browser data/, 'The Browser empty state must stay focused on live browsing instead of destructive saved-data management');
assert.match(settingsReact, /function PrivacyDataPage/);
assert.match(settingsReact, /function BrowserDataSettings/);
assert.match(settingsReact, /listSavedSites/);
assert.match(settingsReact, /Remember site sign-ins/, 'Privacy & data must explain the default remembered-sign-in behavior');
assert.match(settingsReact, /dedicated browser profile/, 'Privacy & data must distinguish Rel.AI browser state from the user\'s normal browser profile');
assert.match(settingsReact, /personal Chrome profile/, 'Privacy & data must make clear that Rel.AI does not automatically attach the user\'s Chrome profile');
assert.match(settingsReact, /Manage saved sites/, 'Saved browser data must stay behind progressive disclosure instead of filling the settings page');
assert.match(settingsReact, /Development sites/, 'Loopback browser state must be separated from normal account sites');
assert.match(settingsReact, /Remove saved data for \$\{site\.host\}/, 'Privacy & data must support removing one saved site without clearing unrelated browser data');
assert.match(settingsReact, /Clear all browser data/, 'Privacy & data must retain an explicit all-sites reset');

const desktopNavIds = DESKTOP_NAV_ITEMS.map(item => item.id);
const mobileNavIds = MOBILE_NAV_ITEMS.map(item => item.id);
assert.deepEqual(mobileNavIds, desktopNavIds, 'desktop and mobile navigation must keep the same reachable destinations');
assert.deepEqual(MOBILE_PRIMARY_NAV_ITEMS.map(item => item.id), ['home', 'tasks', 'workspaces', 'activity']);
assert.deepEqual(MOBILE_MORE_NAV_ITEMS.map(item => item.id), ['code', 'browser', 'system', 'settings']);
assert.equal(new Set(desktopNavIds).size, desktopNavIds.length, 'primary navigation destinations must be unique');
for (const required of ['home', 'tasks', 'workspaces', 'activity', 'browser', 'system', 'settings']) assert.ok(desktopNavIds.includes(required), `${required} must remain reachable`);
assert.ok(!desktopNavIds.includes('extensions'), 'Extensions must stay out of normal navigation while the feature is experimental');
assert.ok(DESKTOP_NAV_ITEMS.every(item => String(item.label || '').trim()), 'every navigation destination must have a label');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'system')?.href, '#processes');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'system')?.label, 'System');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'extensions'), undefined);
assert.equal(routeMetadata('extensions').id, 'extensions', 'Extensions must remain a valid hidden route');
assert.ok(!navigationCommands().some(item => item.id === 'extensions'), 'Extensions must stay out of quick navigation by default');
assert.ok(navigationCommands({ includeExtensions: true }).some(item => item.id === 'extensions'), 'The Extensions feature flag must add Extensions to quick navigation');
const settingsNavIds = SETTINGS_NAV_ITEMS.map(item => item.id);
assert.deepEqual(settingsNavIds, ['connection', 'preferences', 'privacy', 'application', 'about'], 'Settings must follow connection, preferences, privacy/data, app lifecycle, then about');
assert.equal(SETTINGS_NAV_ITEMS.find(item => item.id === 'connection')?.href, '#settings/connection');
assert.equal(normalizeRouteKey('settings/privacy'), 'settings/privacy', 'Privacy & data must be a canonical settings route instead of falling back to Overview');
assert.match(shell, /id="dashboardRoot"/);
assert.doesNotMatch(shell, /id="desktopSidebar"|id="pageTitle"|class="mobile-nav"/, 'persistent dashboard chrome must be React-owned instead of duplicated by the server');
assert.match(reactShell, /WORK_NAV_ITEMS/);
assert.match(reactShell, /MOBILE_PRIMARY_NAV_ITEMS/);
assert.match(reactShell, /MOBILE_MORE_NAV_ITEMS/);
assert.match(reactShell, /More navigation/);
assert.match(reactShell, /'aria-current': active \? 'page' : undefined/);
assert.doesNotMatch(shell, /const PRIMARY_NAV_ITEMS|const SECONDARY_NAV_ITEMS/);
assert.doesNotMatch(router, /document\.getElementById\('pageTitle'\)|innerHTML|replaceChildren|createRoot/, 'router must own navigation policy only');
assert.match(reactShell, /document\.getElementById\('pageTitle'\)\?\.focus\(\{ preventScroll: true \}\)/, 'React shell must own route heading focus');
assert.doesNotMatch(dashboard, /features\/(?:system\/index|settings\/(?:index|connector|diagnostics))\.js|mountSettings|mountSystemPage/, 'dashboard bootstrap must not retain legacy Settings or Troubleshooting route ownership');
assert.match(reactShell, /registerReactSection\('extensions'/, 'Extensions must be a canonical React route');
assert.match(extensionsReact, /https:\/\/github\.com\/Kyne0328\/rel-ai-extensions/, 'Extensions must link to the canonical extension repository');
assert.match(extensionsReact, /\/api\/extensions/, 'Extensions must load the local extension registry API');
assert.match(extensionsReact, /Installed/);
assert.match(extensionsReact, /Discover/);
assert.match(extensionsReact, /Developer/);
assert.match(extensionsReact, /confirmPermissions: true/, 'Extension installation must require permission review confirmation');
assert.match(extensionsReact, /manifest includes a managed artifact for this computer/, 'Managed extension copy must explain platform-specific artifact fallback');
assert.match(extensionsReact, /setup is still needed/, 'Extension installation must surface successful installs that still need a required command');
assert.match(reactShell, /registerReactSection\('settings'/, 'Settings must remain a canonical React route');
assert.match(reactShell, /registerReactSection\('diagnostics'/, 'Troubleshooting must remain a canonical React route');
assert.match(settingsReact, /h\('h2', null, title\)/, 'Settings pages must continue the shell H1 with an H2');
assert.match(settingsReact, /developerOptionsUnlocked \? h\(DeveloperOptions, \{/, 'Developer options must stay hidden until they are unlocked');
assert.equal(DEVELOPER_FEATURES.extensions.label, 'Enable Extensions', 'Unlocked developer options must expose an individual Extensions flag');
assert.match(settingsReact, /writeDeveloperFeatureEnabled\(feature, enabled\)/, 'Developer feature changes must persist independently');
assert.doesNotMatch(settingsReact, /label: 'Developer mode'/, 'Developer options must not use a global Developer mode toggle');
assert.match(reactShell, /extensionsEnabled \? h\(NavLink, \{ item: EXTENSIONS_NAV_ITEM/, 'The Extensions flag must expose Extensions in desktop navigation');
assert.match(reactShell, /extensionsEnabled \? \[\.\.\.MOBILE_MORE_NAV_ITEMS, EXTENSIONS_NAV_ITEM\]/, 'The Extensions flag must expose Extensions in mobile navigation');
assert.match(settingsReact, /DEVELOPER_UNLOCK_CLICK_COUNT = 5/, 'Developer options must require five build clicks');
assert.match(settingsReact, /DEVELOPER_UNLOCK_WINDOW_MS = 2500/, 'Developer option clicks must occur in a short time window');
let unlockState = {};
for (const now of [1000, 1400, 1800, 2200]) {
  unlockState = advanceDeveloperUnlockClicks(unlockState, now);
  assert.equal(unlockState.unlocked, false);
}
unlockState = advanceDeveloperUnlockClicks(unlockState, 2600);
assert.equal(unlockState.unlocked, true, 'The fifth fast build click must unlock developer options');
let expiredUnlockState = advanceDeveloperUnlockClicks({}, 1000);
expiredUnlockState = advanceDeveloperUnlockClicks(expiredUnlockState, 4000);
assert.equal(expiredUnlockState.count, 1, 'Slow build clicks must restart the unlock sequence');
assert.equal(expiredUnlockState.unlocked, false);
assert.match(settingsReact, /h\('h4', null, metadata\.name \|\| 'Rel\.AI MCP'\)/, 'About product identity must remain below the panel H3');
assert.match(settingsReact, /buildId \? h\('p', null, 'Build: ', h\('code', null, buildId\)\)/, 'About must expose the package build identifier without an unnecessary copy control');
assert.doesNotMatch(settingsReact, /Build ID copied|Could not copy the build ID/, 'About must not add clipboard behavior for the build identifier');
assert.match(settingsReact, /label: 'Developer'/, 'About must retain developer provenance when package metadata provides it');
assert.match(settingsReact, /Theme applies|Applies to the dashboard and Rel\.AI Pulse/, 'Preferences must explain the scope of the theme setting');
assert.match(settingsReact, /Notify you when a Rel\.AI task finishes/, 'Notification categories must explain what each toggle controls');
assert.match(settingsReact.match(/function PreferencesPage[\s\S]*?function ThemeSwitch/)?.[0] || '', /PulsePreference/, 'Rel.AI Pulse belongs with user preferences');
assert.doesNotMatch(settingsReact.match(/function StartupSettings[\s\S]*?function LifecycleNotice/)?.[0] || '', /Show Rel\.AI Pulse/, 'App lifecycle settings must not duplicate the Pulse preference');
assert.match(settingsReact.match(/function PrivacyDataPage[\s\S]*?function BrowserDataSettings/)?.[0] || '', /ComputerControlSettings/, 'Privacy & data must own computer-control permission');
assert.doesNotMatch(settingsReact, /Rel\.AI recovered after closing unexpectedly|recoveredAfterUncleanShutdown\s*\?\s*h\(LifecycleNotice/, 'A successful recovery after an unclean shutdown must stay in diagnostics instead of becoming a persistent App-settings warning');
assert.match(diagnosticsReact, /Copy report/, 'Troubleshooting must retain a quick copy workflow for support reports');
assert.match(diagnosticsReact, /diagnostic-more-actions[\s\S]*Support folder/, 'Low-frequency support-folder access must stay available through progressive disclosure');
assert.match(settingsReact, /typeof desktop\?\.quitApp === 'function'/, 'App settings must expose Quit only inside the installed desktop app');
assert.match(settingsReact, /Quit Rel\.AI MCP/, 'App settings must provide a graceful desktop quit action');
assert.match(settingsReact.match(/function ConnectionPage[\s\S]*?function connectionPrimaryAction/)?.[0] || '', /LogoutRow/, 'Log out must live with the saved OpenAI connection');
assert.doesNotMatch(settingsReact.match(/function ApplicationPage[\s\S]*?function DeveloperOptions/)?.[0] || '', /LogoutRow|ComputerControlSettings|TelemetrySettings|LocalDataSettings/, 'App settings must stay focused on lifecycle, updates, developer options, and quit');
assert.doesNotMatch(settingsReact.match(/function ConnectionPage[\s\S]*?function DesktopConnectionSettings/)?.[0] || '', /clientCapabilityViews|Native MCP Tasks|Execution mode/, 'Connection page must keep protocol capability details out of the normal connection UI');
assert.match(diagnosticsReact, /clientCapabilityViews/);
assert.match(diagnosticsReact, /Tasks extension advertised: \$\{supported\}/, 'Troubleshooting must show the observed MCP Tasks capability without stale internal field names');
assert.match(homeReact, /className: 'buttonlike secondary compact-button', href: routeMetadata\('workspaces'\)\.href/, 'Inline empty-state navigation must have a non-color link affordance');
assert.match(homeReact, /function ActiveTasksSummary/);
assert.match(homeReact, /tasks\.slice\(0, 3\)/, 'Overview must cap the active-task summary instead of becoming a second Tasks page');
assert.match(homeReact, /task-overview-multiple-head/);
assert.match(homeReact, /h\(StatusPill, \{ state, label:/, 'Each active task must keep its status attached to its own row instead of using detached card-level metadata');
assert.match(homeReact, /View all tasks/);
assert.match(homeReact, /state\.tasks\.filter\(task => workSessionStateView\(task\)\.terminal === true\)/, 'Latest tasks must avoid duplicating active tasks already summarized above');
assert.deepEqual(repositorySummary({ exists: true, isGit: false }), {
  kindLabel: 'Folder',
  label: 'Local folder',
  description: 'File and command actions are available. Git actions are unavailable.',
  tone: 'neutral'
}, 'ordinary authorized folders must not be presented as broken repositories');
assert.equal(repositorySummary({ exists: true, isGit: true, branch: 'main' }).kindLabel, 'Repository');
assert.match(workspacesReact, /repository\.kindLabel/, 'workspace cards must label Folder vs Repository from canonical workspace state');
assert.match(workspacesReact, /const directAccess = h\(DirectFilesystemAccess/, 'Projects must keep the outside-project access boundary available without promoting it to a primary project card');
assert.doesNotMatch(workspacesReact, /className: 'workspace-direct-access card'/, 'Outside-project access must stay visually secondary instead of using a full card treatment');
assert.match(workspaceModalsReact, /primary project folder/, 'workspace setup must describe the primary project folder before Git-specific capabilities');
assert.match(activityReact, /const fileLocation = activityFileLocation\(entry\)/, 'Activity details must derive the successful local file destination');
assert.match(activityReact, /readableSection\('File location', fileLocationText\)/, 'Activity details must expose successful local file destinations without requiring Technical details');
assert.match(modal, /openModalOverlay\(\{/, 'shared modals must render through the React overlay store');
assert.match(drawer, /openDrawerOverlay\(\{/, 'shared drawers must render through the React overlay store');
assert.doesNotMatch(modal, /innerHTML|insertAdjacentHTML/, 'shared modals must not render content through imperative HTML injection');
assert.doesNotMatch(drawer, /innerHTML|insertAdjacentHTML/, 'shared drawers must not render content through imperative HTML injection');
assert.doesNotMatch(settingsReact, /settings-rail|settings-nav-button/, 'Settings pages must rely on the primary sidebar instead of a secondary in-page navigation rail');
assert.doesNotMatch(diagnosticsReact, /settings-rail|settings-nav-button/, 'Troubleshooting must rely on the primary sidebar instead of a secondary in-page navigation rail');
assert.equal(fs.existsSync(path.join(root, 'src/ui/features/settings/tools-validation.js')), false);
assert.equal(fs.existsSync(path.join(root, 'src/ui/sidebar.js')), false, 'obsolete imperative sidebar renderer must be removed');
assert.equal(fs.existsSync(path.join(root, 'src/ui/command-palette.js')), false, 'obsolete imperative command palette renderer must be removed');
assert.equal(typeof mergeActivityEntries, 'function');
assert.equal(typeof activityFilterTransition, 'function');

console.log('Dashboard UI ownership contracts passed.');

