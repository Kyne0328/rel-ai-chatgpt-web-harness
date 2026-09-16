import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSIONS_NAV_ITEM, SETTINGS_NAV_ITEMS, SYSTEM_NAV_ITEMS } from '../src/ui/navigation-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

for (const item of [EXTENSIONS_NAV_ITEM, ...SYSTEM_NAV_ITEMS, ...SETTINGS_NAV_ITEMS]) {
  assert.ok(item.icon, `${item.label} must keep an icon for the collapsed sidebar`);
}

const shell = read('src/http/dashboard.ts');
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
assert.match(reactShell, /EXTENSIONS_NAV_ITEM/);
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

console.log('Sidebar accordion and collapsed navigation contracts passed.');
