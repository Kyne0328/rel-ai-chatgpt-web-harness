import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDesktopStatus } from '../electron/desktop-status.js';
import { projectPulseStatus } from '../electron/pulse-state.js';
import { classifyTaskActivity } from '../src/taskActivityPresentation.js';
import { connectionLayerViews, connectionSummary } from '../src/ui/connection-state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

for (const status of ['waiting_for_approval', 'blocked', 'validation_failed']) {
  const taskActivity = {
    state: 'waiting',
    activeCalls: 0,
    activeTaskCount: 1,
    tasks: [{ id: `task-${status}`, workspace: 'repo', title: 'Current work', status }]
  };
  const semantic = classifyTaskActivity(taskActivity);
  assert.equal(semantic.category, 'attention', `${status} must use the shared attention category`);
  assert.equal(semantic.actionRequired, true);
  assert.equal(semantic.reason, status);
  assert.equal(normalizeDesktopStatus({ serverRunning: true, tunnelStatus: 'running', taskActivity }).taskActivityPresentation.category, 'attention', 'Electron status must serialize the shared category');
  assert.equal(projectPulseStatus({ taskActivity }).actionRequired, true, 'Pulse must consume the shared category');
}

const staleBlocked = classifyTaskActivity({
  state: 'idle',
  activeCalls: 0,
  activeTaskCount: 0,
  tasks: [{ id: 'stale', status: 'blocked' }]
});
assert.equal(staleBlocked.category, 'idle', 'stale task rows must not become a second live-state authority');
assert.equal(staleBlocked.taskCount, 0);

assert.equal(classifyTaskActivity({
  state: 'working', activeCalls: 1, activeTaskCount: 1,
  tasks: [{ id: 'working', status: 'running', activeCalls: 1 }]
}).category, 'working');
assert.equal(classifyTaskActivity({
  state: 'waiting', activeCalls: 0, activeTaskCount: 1,
  tasks: [{ id: 'waiting', status: 'planning' }]
}).category, 'waiting');

const healthyWithUpdateReconnect = {
  localService: { status: 'running' },
  publicEndpoint: { status: 'available' },
  chatgptReadiness: { status: 'ready' },
  mcpClient: { status: 'idle' },
  dashboardUpdates: { status: 'reconnecting' }
};
assert.equal(connectionSummary(healthyWithUpdateReconnect).label, 'Ready', 'dashboard transport recovery must not redefine Secure MCP Tunnel health');
assert.equal(connectionLayerViews(healthyWithUpdateReconnect).find(layer => layer.key === 'dashboardUpdates')?.label, 'Updates reconnecting');
assert.equal(connectionSummary({ ...healthyWithUpdateReconnect, publicEndpoint: { status: 'degraded' } }).label, 'Tunnel reconnecting');

const dashboardSource = read('src/ui/react/main.js');
const homeSource = read('src/ui/features/home/react.js');
const routerSource = read('src/ui/router.js');
const desktopHostSource = read('electron/desktop-host.js');
const shellChromeSource = read('src/http/dashboardShellChrome.ts');
assert.match(dashboardSource, /classifyTaskActivity\(data\?\.taskActivity\)/, 'dashboard top status must use the canonical task classifier');
assert.match(homeSource, /classifyTaskActivity\(activity\)/, 'Home task summary must use the canonical task classifier');
assert.doesNotMatch(routerSource, /relai_dashboard_route/, 'the retired dashboard-route persistence writer must stay removed');
assert.match(desktopHostSource, /searchParams\.set\('theme', desktopLifecycle\.getStatus\(\)\.themePreference \|\| 'system'\)/, 'Electron lifecycle must provide the desktop theme during dashboard bootstrap');
assert.match(shellChromeSource, /desktopSurface \? launchParams\.get\('theme'\) : localStorage\.getItem\('relai_ui_theme'\)/, 'desktop bootstrap must prefer Electron-provided theme while browser mode may use localStorage');

const storageWrites = [];
const desktopPreferenceWrites = [];
globalThis.localStorage = {
  getItem: key => key === 'relai_ui_theme' ? 'light' : null,
  setItem: (key, value) => storageWrites.push([key, value])
};
globalThis.document = { documentElement: { dataset: { surface: 'desktop', themePreference: 'dark' } } };
const media = {
  matches: false,
  addEventListener() {},
  removeEventListener() {}
};
globalThis.window = {
  matchMedia: () => media,
  requestAnimationFrame: callback => { callback(); return 1; },
  relaiDesktop: {
    setAppPreferences: patch => { desktopPreferenceWrites.push(patch); return { ok: true }; }
  }
};
const preferences = await import('../src/ui/preferences.js');
assert.equal(preferences.getUiPreferences().theme, 'dark', 'desktop lifecycle theme must beat stale renderer localStorage');
preferences.initUiPreferences();
assert.equal(desktopPreferenceWrites.length, 0, 'desktop initialization must not push renderer storage back into Electron');
preferences.setThemePreference('light');
assert.deepEqual(desktopPreferenceWrites, [{ themePreference: 'light' }], 'an explicit desktop theme change must persist through Electron');
assert.equal(storageWrites.length, 0, 'desktop must not maintain a second durable theme owner in localStorage');

globalThis.document.documentElement.dataset.surface = 'browser';
globalThis.document.documentElement.dataset.themePreference = 'system';
assert.equal(preferences.getUiPreferences().theme, 'light', 'browser-only dashboard may retain its local theme preference');
preferences.setThemePreference('dark');
assert.deepEqual(storageWrites.at(-1), ['relai_ui_theme', 'dark']);
assert.equal(desktopPreferenceWrites.length, 1, 'browser theme changes must not mutate desktop lifecycle preferences');

console.log('Competing ownership semantics, theme, reconnect labels, and route cutover passed.');
