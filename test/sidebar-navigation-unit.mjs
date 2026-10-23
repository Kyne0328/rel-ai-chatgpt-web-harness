import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_NAV_ITEMS, EXTENSIONS_NAV_ITEM, SETTINGS_NAV_ITEMS, SYSTEM_NAV_ITEMS } from '../src/ui/navigation-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

for (const item of [EXTENSIONS_NAV_ITEM, ...SYSTEM_NAV_ITEMS, ...SETTINGS_NAV_ITEMS]) {
  assert.ok(item.icon, `${item.label} must keep an icon for the collapsed sidebar`);
}

const shell = read('src/http/dashboardShell.ts');
const bootstrap = read('src/http/dashboardShellChrome.ts');
const reactShell = read('src/ui/react/main.js');
const router = read('src/ui/router.js');
const appCss = read('src/ui/styles/app.css');
const settingsCss = read('src/ui/features/settings/styles.css');

assert.match(shell, /id="dashboardRoot"/);
assert.doesNotMatch(shell, /id="sidebarToggle"/, 'server shell must not duplicate the React sidebar');
assert.match(bootstrap, /relai_sidebar_collapsed/);
assert.match(reactShell, /APPLICATION_NAV_ITEMS\[0\]/);
assert.match(reactShell, /APPLICATION_NAV_ITEMS\[1\]/);
assert.ok(!DESKTOP_NAV_ITEMS.some(item => item.id === EXTENSIONS_NAV_ITEM.id), 'Extensions must stay out of the default sidebar catalog');
assert.match(reactShell, /extensionsEnabled \? h\(NavLink, \{ item: EXTENSIONS_NAV_ITEM/, 'The Extensions feature flag must add Extensions to the application navigation');
assert.match(reactShell, /SYSTEM_NAV_ITEMS/);
assert.match(reactShell, /SETTINGS_NAV_ITEMS/);
assert.match(reactShell, /id: 'sidebarToggle'/);
assert.match(reactShell, /'aria-controls': 'desktopSidebar'/);
assert.match(reactShell, /localStorage\.setItem\('relai_sidebar_collapsed'/);
assert.match(reactShell, /'aria-expanded': collapsed \? 'false' : 'true'/);
assert.match(reactShell, /setOpenAccordion/);
assert.doesNotMatch(router, /document\.getElementById\('pageTitle'\)|createRoot|innerHTML/, 'router must not mutate React-owned navigation chrome');
assert.match(reactShell, /document\.getElementById\('pageTitle'\)\?\.focus/, 'React shell must focus the route heading after navigation');
assert.match(appCss, /:root\[data-sidebar="collapsed"\]\s*\{[^}]*--sidebar-width:\s*[^;]+;/s, 'collapsed sidebar must define its own width without freezing one pixel value');
assert.match(appCss, /:root\[data-sidebar="collapsed"\][\s\S]*\.nav-icon\s*\{[^}]*size-5/s);
assert.match(appCss, /\.sidebar-accordion > summary/);
assert.match(appCss, /\.sidebar-subnav/);
assert.doesNotMatch(settingsCss, /\.settings-rail\b/, 'Settings must not reintroduce a redundant in-page navigation rail');

// Topbar breadcrumb navigation hierarchy
assert.match(reactShell, /className:\s*'topbar-breadcrumbs'/, 'Topbar must include accessible breadcrumb container');
assert.match(reactShell, /'aria-label':\s*'Breadcrumb'/, 'Breadcrumbs must declare aria-label="Breadcrumb"');
assert.match(reactShell, /className:\s*'breadcrumb-list'/, 'Breadcrumbs must render breadcrumb-list');
assert.match(reactShell, /className:\s*'breadcrumb-separator'/, 'Breadcrumbs must render breadcrumb-separator');
assert.match(reactShell, /className:\s*'breadcrumb-current'/, 'Breadcrumbs must render breadcrumb-current');
assert.match(reactShell, /'aria-current':\s*'page'/, 'Active breadcrumb page must set aria-current="page"');
assert.match(reactShell, /h\('h1',\s*\{\s*className:\s*'page-title',\s*id:\s*'pageTitle'/, 'h1.page-title#pageTitle must remain intact');
assert.match(appCss, /\.topbar-breadcrumbs\b/, 'app.css must style .topbar-breadcrumbs');
assert.match(appCss, /\.breadcrumb-list\b/, 'app.css must style .breadcrumb-list');
assert.match(appCss, /\.breadcrumb-separator\b/, 'app.css must style .breadcrumb-separator');
assert.match(appCss, /\.breadcrumb-current\b/, 'app.css must style .breadcrumb-current');

// Command Palette multi-category search indexing & token matching
const { buildCommands, commandMatchesQuery, normalizeSearch } = await import('../src/ui/react/main.js');
assert.equal(typeof normalizeSearch, 'function', 'normalizeSearch helper must be exported');
const testData = {
  config: { workspaces: [{ alias: 'core', path: '/dev/core' }] },
  tasks: [
    { id: 'task-42', title: 'Implement OAuth authentication', status: 'running', workspace: 'core' },
    { id: 'task-99', title: 'Refactor database models', status: 'completed' }
  ]
};
const commands = buildCommands(testData, null, false, null, () => {});
const taskCmd = commands.find(c => c.id === 'task-42');
assert.ok(taskCmd, 'Active task must be indexed in command palette');
assert.equal(taskCmd.group, 'Task', 'Task command must have group: "Task"');
assert.equal(taskCmd.href, '#tasks?task=task-42', 'Task command must link to #tasks?task=${id}');
assert.ok(commandMatchesQuery(taskCmd, 'task oauth'), 'Multi-word token search must match across group and title');
assert.ok(commandMatchesQuery(taskCmd, 'auth core'), 'Multi-word token search must match across title and workspace');
assert.ok(commandMatchesQuery(taskCmd, 'implment'), 'Fuzzy matching should handle approximate typing');
assert.equal(commandMatchesQuery(taskCmd, 'nonexistentxyz'), false, 'Non-matching query must return false');

console.log('Sidebar accordion, collapsed navigation, topbar breadcrumbs, and command palette contracts passed.');
