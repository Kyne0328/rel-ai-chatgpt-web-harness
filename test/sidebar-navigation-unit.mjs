import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
assert.doesNotMatch(reactShell, /SidebarAccordion|setOpenAccordion/, 'desktop navigation must not hide routes behind accordions');
assert.ok(!DESKTOP_NAV_ITEMS.some(item => item.id === EXTENSIONS_NAV_ITEM.id), 'Extensions must stay out of the default sidebar catalog');
assert.match(reactShell, /extensionsEnabled \? h\(NavLink, \{ item: EXTENSIONS_NAV_ITEM/, 'The Extensions feature flag must add Extensions to the application navigation');
assert.match(reactShell, /SYSTEM_NAV_ITEMS/);
assert.match(reactShell, /SETTINGS_NAV_ITEMS/);
assert.match(reactShell, /id: 'sidebarToggle'/);
assert.match(reactShell, /'aria-controls': 'desktopSidebar'/);
assert.match(reactShell, /localStorage\.setItem\('relai_sidebar_collapsed'/);
assert.match(reactShell, /'aria-expanded': collapsed \? 'false' : 'true'/);
assert.doesNotMatch(router, /document\.getElementById\('pageTitle'\)|createRoot|innerHTML/, 'router must not mutate React-owned navigation chrome');
assert.match(reactShell, /document\.getElementById\('pageTitle'\)\?\.focus/, 'React shell must focus the route heading after navigation');
assert.match(appCss, /:root\[data-sidebar="collapsed"\]\s*\{[^}]*--sidebar-width:\s*[^;]+;/s, 'collapsed sidebar must define its own width without freezing one pixel value');
assert.match(appCss, /:root\[data-sidebar="collapsed"\][\s\S]*\.nav-icon\s*\{[^}]*size-5/s);
assert.match(appCss, /\.sidebar-navigation/);
assert.match(appCss, /\.sidebar-utilities/);
assert.doesNotMatch(settingsCss, /\.settings-rail\b/, 'Settings must not reintroduce a redundant in-page navigation rail');

// The sidebar identifies the route; only the main heading repeats it for page context.
assert.doesNotMatch(reactShell, /topbar-breadcrumbs|breadcrumb-current|windowContext/, 'Do not duplicate the current page in the breadcrumb or window chrome');
assert.match(reactShell, /h\('h1',\s*\{\s*className:\s*'page-title',\s*id:\s*'pageTitle'/, 'h1.page-title#pageTitle must remain intact');
assert.doesNotMatch(appCss, /\.topbar-breadcrumbs\b|\.breadcrumb-current\b/, 'Do not keep unused breadcrumb styles');

// Command Palette multi-category search indexing & token matching
const { buildCommands, commandMatchesQuery, normalizeSearch, rankCommands, DesktopSidebar } = await import('../src/ui/react/main.js');
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

// Exact task titles must survive the display limit even when many route
// descriptions match the same fuzzy subsequence.
const rankedCommands = buildCommands({
  config: testData.config,
  tasks: [{ id: 'task-core', title: 'Core', workspace: 'core', status: 'running' }]
}, null, false, null, () => {});
assert.equal(rankCommands(rankedCommands, 'core')[0].id, 'task-core');
assert.ok(rankCommands(rankedCommands, 'core').slice(0, 14).some(command => command.id === 'task-core'));
assert.deepEqual(rankCommands(commands, ''), commands, 'empty search must preserve the normal command order');
assert.equal(rankCommands(commands, 'nonexistentxyz').length, 0);

const previousDocument = globalThis.document;
globalThis.document = { documentElement: { dataset: {} } };
try {
  for (const collapsed of [true, false]) {
    const markup = renderToStaticMarkup(React.createElement(DesktopSidebar, {
      collapsed, extensionsEnabled: false, route: { path: 'processes', owner: 'system' }, toggleSidebar() {}
    }));
    assert.doesNotMatch(markup, /sidebar-more/, 'desktop Utilities should show its few destinations directly');
    assert.doesNotMatch(markup, /project access|live status|class="dot"/);
    const ids = [...markup.matchAll(/data-nav-id="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(ids, DESKTOP_NAV_ITEMS.map(item => item.id));
    assert.match(markup, /aria-label="System navigation"/);
    assert.match(markup, /aria-label="Utilities navigation"/);
    assert.match(markup, /data-nav-id="processes"[^>]*aria-current="page"/);
  }
  for (const [route, enabled, current] of [
    [{ path: 'tools', owner: 'system' }, false, 'tools'],
    [{ path: 'extensions', owner: 'extensions' }, true, 'extensions'],
    [{ path: 'settings/connection', owner: 'settings' }, false, 'settings'],
    [{ path: 'tasks', owner: 'tasks' }, false, 'tasks']
  ]) {
    const markup = renderToStaticMarkup(React.createElement(DesktopSidebar, {
      collapsed: false, extensionsEnabled: enabled, route, toggleSidebar() {}
    }));
    assert.match(markup, new RegExp(`data-nav-id="${current}"[^>]*aria-current="page"`));
    assert.doesNotMatch(markup, /data-nav-id="(?:connection|code)"/);
    if (['tools', 'extensions'].includes(current)) assert.match(markup, /aria-label="Utilities navigation"/);
    assert.equal(markup.includes('data-nav-id="extensions"'), enabled);
  }

} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
console.log('Flat desktop navigation, collapsed accessibility, breadcrumbs, and ranked command palette contracts passed.');
