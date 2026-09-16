import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_NAV_ITEMS, MOBILE_MORE_NAV_ITEMS, MOBILE_NAV_ITEMS, MOBILE_PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEMS } from '../src/ui/navigation-catalog.js';
import { activityFilterTransition, mergeActivityEntries } from '../src/ui/features/activity/model.js';
import { repositorySummary } from '../src/ui/features/workspaces/model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const shell = read('src/http/dashboard.ts');
const reactShell = read('src/ui/react/main.js');
const dashboard = read('public/dashboard.js');
const router = read('src/ui/router.js');
const settingsReact = read('src/ui/features/settings/react.js');
const extensionsReact = read('src/ui/features/extensions/react.js');
const diagnosticsReact = read('src/ui/features/settings/diagnostics-react.js');
const homeReact = read('src/ui/features/home/react.js');
const activityReact = read('src/ui/features/activity/react.js');
const workspacesReact = read('src/ui/features/workspaces/react.js');
const workspaceModalsReact = read('src/ui/features/workspaces/react-modals.js');
const modal = read('src/ui/components/modal.js');
const drawer = read('src/ui/components/drawer.js');

const desktopNavIds = DESKTOP_NAV_ITEMS.map(item => item.id);
const mobileNavIds = MOBILE_NAV_ITEMS.map(item => item.id);
assert.deepEqual(mobileNavIds, desktopNavIds, 'desktop and mobile navigation must keep the same reachable destinations');
assert.deepEqual(MOBILE_PRIMARY_NAV_ITEMS.map(item => item.id), ['home', 'tasks', 'workspaces', 'activity']);
assert.deepEqual(MOBILE_MORE_NAV_ITEMS.map(item => item.id), ['code', 'browser', 'system', 'extensions', 'settings']);
assert.equal(new Set(desktopNavIds).size, desktopNavIds.length, 'primary navigation destinations must be unique');
for (const required of ['home', 'tasks', 'workspaces', 'activity', 'browser', 'extensions', 'system', 'settings']) assert.ok(desktopNavIds.includes(required), `${required} must remain reachable`);
assert.ok(DESKTOP_NAV_ITEMS.every(item => String(item.label || '').trim()), 'every navigation destination must have a label');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'system')?.href, '#processes');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'system')?.label, 'System');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'extensions')?.href, '#extensions');
const settingsNavIds = SETTINGS_NAV_ITEMS.map(item => item.id);
for (const required of ['connection', 'preferences', 'application', 'about']) assert.ok(settingsNavIds.includes(required), `${required} settings must remain reachable`);
assert.equal(SETTINGS_NAV_ITEMS.find(item => item.id === 'connection')?.href, '#settings/connection');
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
assert.match(reactShell, /registerReactSection\('settings'/, 'Settings must remain a canonical React route');
assert.match(reactShell, /registerReactSection\('diagnostics'/, 'Troubleshooting must remain a canonical React route');
assert.match(settingsReact, /h\('h2', null, title\)/, 'Settings pages must continue the shell H1 with an H2');
assert.match(settingsReact, /h\('h4', null, metadata\.name \|\| 'Rel\.AI MCP'\)/, 'About product identity must remain below the panel H3');
assert.match(settingsReact, /typeof desktop\?\.quitApp === 'function'/, 'App settings must expose Quit only inside the installed desktop app');
assert.match(settingsReact, /Quit Rel\.AI MCP/, 'App settings must provide a graceful desktop quit action');
assert.doesNotMatch(settingsReact.match(/function ConnectionPage[\s\S]*?function DesktopConnectionSettings/)?.[0] || '', /clientCapabilityViews|Native MCP Tasks|Execution mode/, 'Connection page must keep protocol capability details out of the normal connection UI');
assert.match(diagnosticsReact, /clientCapabilityViews/);
assert.match(diagnosticsReact, /Tasks extension advertised: \$\{supported\}/, 'Troubleshooting must show the observed MCP Tasks capability without stale internal field names');
assert.match(homeReact, /className: 'buttonlike secondary compact-button', href: routeMetadata\('workspaces'\)\.href/, 'Inline empty-state navigation must have a non-color link affordance');
assert.deepEqual(repositorySummary({ exists: true, isGit: false }), {
  kindLabel: 'Folder',
  label: 'Local folder',
  description: 'File and command actions are available. Git actions are unavailable.',
  tone: 'neutral'
}, 'ordinary authorized folders must not be presented as broken repositories');
assert.equal(repositorySummary({ exists: true, isGit: true, branch: 'main' }).kindLabel, 'Repository');
assert.match(workspacesReact, /repository\.kindLabel/, 'workspace cards must label Folder vs Repository from canonical workspace state');
assert.match(workspaceModalsReact, /primary local working folder/, 'workspace setup must describe generic local folders before Git-specific capabilities');
assert.match(activityReact, /readableSection\('File location', activityFileLocation\(entry\)\)/, 'Activity details must expose successful local file destinations without requiring Technical details');
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

