import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { registerIpcHandlers } from '../electron/ipc-handlers.js';
import { DESKTOP_IPC, DESKTOP_IPC_CHANNELS, DESKTOP_IPC_INPUT_CONTRACT } from '../src/contracts/desktop.ts';

const inventory = DESKTOP_IPC_INPUT_CONTRACT;

const windows = { wizard: { id: 'wizard' }, fallback: { id: 'fallback' }, dashboard: { id: 'dashboard' }, pulse: { id: 'pulse' }, other: { id: 'other' } };
const handles = new Map();
const listeners = new Map();
const calls = [];
const ipcMain = {
  handle(channel, handler) { assert.equal(handles.has(channel) || listeners.has(channel), false, `duplicate IPC registration: ${channel}`); handles.set(channel, handler); },
  on(channel, handler) { assert.equal(handles.has(channel) || listeners.has(channel), false, `duplicate IPC registration: ${channel}`); listeners.set(channel, handler); }
};

registerIpcHandlers({
  ipcMain,
  BrowserWindow: { fromWebContents: sender => sender?.window || null },
  clipboard: { writeText: value => calls.push(['clipboard', value]) },
  shell: { openExternal: async value => { calls.push(['openExternal', value]); } },
  getWizardWindow: () => windows.wizard,
  closeWizard: value => calls.push(['closeWizard', value]),
  getFallbackWindow: () => windows.fallback,
  getDashboardWindow: () => windows.dashboard,
  getPulseWindow: () => windows.pulse,
  setPulseExpanded: value => { calls.push(['pulseExpanded', value]); return value; },
  getRecoveryConfig: () => ({ ok: true, tunnelId: 'tunnel_12345678', tunnelApiKeyConfigured: true, port: 3333 }),
  setTunnelApiKey: value => calls.push(['tunnelKey', value]),
  saveLauncherConfig: value => calls.push(['save', value]),
  launchConfiguredDesktop: async value => { calls.push(['launch', value]); return { serverRunning: true, tunnelStatus: 'running' }; },
  restartConnection: async () => { calls.push(['restartConnection']); return { serverRunning: true, tunnelStatus: 'running' }; },
  relaunchApplication: async () => { calls.push(['relaunch']); return { ok: true }; },
  logoutApplication: async value => { calls.push(['logout', value]); return { ok: true, ...value }; },
  quitApplication: async () => { calls.push(['quit']); return { ok: true }; },
  openRecoverySetup: () => ({ ok: true }),
  openDashboardWindow: () => ({ ok: true }),
  getNotificationsEnabled: () => true,
  setNotificationsEnabled: value => value,
  startServer: () => ({ serverRunning: true }),
  stopServer: () => { calls.push(['stop']); return { serverRunning: false }; },
  getCurrentStatus: () => ({ serverRunning: true }),
  getDashboardWindowState: () => ({ maximized: false }),
  minimizeDashboardWindow: () => ({ minimized: true }),
  toggleDashboardMaximize: () => ({ maximized: true }),
  requestDashboardClose: () => ({ ok: true }),
  openSettingsWindow: () => ({ ok: true }),
  getBrowserState: () => ({ sessionId: '', pages: [] }),
  setBrowserSurfaceBounds: value => ({ ok: true, value }),
  setBrowserControl: value => ({ ok: true, value }),
  selectBrowserSession: value => ({ ok: true, value }),
  selectBrowserTab: value => ({ ok: true, value }),
  closeBrowserTab: value => ({ ok: true, value }),
  stopActiveBrowserSession: () => ({ ok: true }),
  getLocalUsage: month => ({ ok: true, month, source: 'local' }),
  getDesktopSettings: () => ({ ok: true }),
  saveDesktopSettings: value => ({ ok: true, value }),
  getLifecycleStatus: () => ({ ok: true }),
  acknowledgeConnectorRefresh: () => ({ ok: true }),
  setLaunchAtLogin: value => value,
  setKeepAwake: value => value,
  setAppPreferences: value => ({ ok: true, status: value }),
  getLocalDataUsage: () => ({ ok: true, totalBytes: 0 }),
  clearTemporaryLocalData: () => ({ ok: true }),
  openLocalDataFolder: () => ({ ok: true }),
  getNotificationPreferences: () => ({ enabled: true }),
  updateNotificationPreferences: value => ({ ok: true, preferences: value }),
  getUpdateStatus: () => ({ state: 'idle' }),
  checkForUpdates: () => ({ ok: true }),
  downloadUpdate: () => ({ ok: true }),
  installUpdate: () => ({ ok: true }),
  exportDiagnosticState: value => ({ ok: true, value }),
  openDiagnosticsFolder: () => ({ ok: true }),
  runTunnelDoctor: () => ({ ok: true, result: 'pass' }),
  getTaskCodeWorkspace: value => ({ ok: true, value }),
  readTaskCodeDiff: value => ({ ok: true, value }),
  listCodeEditors: () => ({ ok: true, editors: [{ id: 'system', label: 'File Explorer' }] }),
  openTaskCodeIde: value => ({ ok: true, value }),
  fitWindowToContent: (window, value) => calls.push(['fit', window.id, value])
});

assert.deepEqual([...handles.keys()].sort(), Object.keys(inventory).filter(channel => inventory[channel].mode === 'handle').sort());
assert.deepEqual([...listeners.keys()].sort(), Object.keys(inventory).filter(channel => inventory[channel].mode === 'on').sort());

for (const [channel, expected] of Object.entries(inventory)) {
  const handler = expected.mode === 'handle' ? handles.get(channel) : listeners.get(channel);
  assert.equal(typeof handler, 'function', channel);
  if (expected.failure === 'reject') assert.throws(() => handler(eventFor(windows.other), ...argsFor(channel)), /not available to this renderer/, channel);
  else assert.doesNotThrow(() => handler(eventFor(windows.other), ...argsFor(channel)), channel);
  for (const windowName of expected.windows) {
    const result = handler(eventFor(windows[windowName]), ...argsFor(channel));
    if (result && typeof result.then === 'function') await result;
  }
}

assert.throws(() => handles.get('url:copy')(eventFor(windows.wizard), 'x'.repeat(64 * 1024 + 1)), /64 KiB/);
assert.throws(() => handles.get('desktop:logout')(eventFor(windows.dashboard), { clearData: 'yes' }), /clearData as a boolean/);
const logout = await handles.get('desktop:logout')(eventFor(windows.dashboard), { clearData: true });
assert.equal(logout.clearData, true);
assert.ok(calls.some(call => call[0] === 'logout' && call[1].clearData === true));
const done = await handles.get('wizard:done')(eventFor(windows.wizard), { tunnelId: 'tunnel_12345678', tunnelApiKey: 'runtime-api-key-value', port: 3333, restart: false });
assert.equal(done.ok, true);
assert.ok(calls.some(call => call[0] === 'tunnelKey' && call[1] === 'runtime-api-key-value'));
assert.ok(calls.some(call => call[0] === 'save' && call[1].tunnelId === 'tunnel_12345678'));
assert.equal([...handles.keys()].some(channel => /gateway|approval|cloud|open-link/i.test(channel)), false);
assert.ok(calls.some(call => call[0] === 'fit' && call[1] === 'wizard'));
assert.ok(calls.some(call => call[0] === 'fit' && call[1] === 'fallback'));

const preloadSource = fs.readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const preloadChannels = new Set([
  ...[...preloadSource.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]),
  ...[...preloadSource.matchAll(/subscribe\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
]);
for (const channel of preloadChannels) {
  assert.ok(DESKTOP_IPC_CHANNELS.includes(channel), `preload channel must exist in canonical desktop contract: ${channel}`);
}
for (const channel of Object.keys(DESKTOP_IPC_INPUT_CONTRACT)) {
  assert.ok(preloadChannels.has(channel), `canonical renderer-to-main IPC channel must be exposed by preload: ${channel}`);
}
assert.equal(DESKTOP_IPC.DESKTOP_GET_STATUS, 'desktop:get-status');

console.log(`${Object.keys(inventory).length} tunnel-only IPC channel contracts passed.`);
function eventFor(window) { return { sender: { window } }; }
function argsFor(channel) {
  switch (channel) {
    case 'wizard:done': return [{ tunnelId: 'tunnel_12345678', tunnelApiKey: 'runtime-api-key-value', port: 3333, restart: false }];
    case 'wizard:open-openai-setup': return ['tunnels'];
    case 'url:copy': return ['safe text'];
    case 'desktop:analytics:local': return ['2026-08'];
    case 'desktop:settings:save': return [{ port: 3333, tunnelId: 'tunnel_12345678' }];
    case 'desktop:reload-dashboard': return ['#tasks'];
    case 'desktop:browser:set-bounds': return [{ visible: false }];
    case 'desktop:browser:set-control': return ['user'];
    case 'desktop:browser:select-session': return ['embedded_browser_1234567890abcdef'];
    case 'desktop:browser:select-tab':
    case 'desktop:browser:close-tab': return ['embedded_page_1234567890abcdef'];
    case 'desktop:logout': return [{ clearData: false }];
    case 'desktop:app-preferences:set': return [{ keepRunningOnClose: true }];
    case 'desktop:startup:set':
    case 'desktop:keep-awake:set':
    case 'desktop:notifications:set':
    case 'desktop:notification-preferences:set':
    case 'notifications:set-enabled': return [true];
    case 'desktop:diagnostics:export': return [{ status: 'ready' }];
    case 'desktop:code:get': return [{ taskId: 'task-1' }];
    case 'desktop:code:diff': return [{ taskId: 'task-1', path: 'src/index.js' }];
    case 'desktop:code:open-ide': return [{ taskId: 'task-1', editorId: 'system' }];
    case 'window:fit-content': return [{ width: 500, height: 600 }];
    case 'pulse:set-expanded': return [true];
    default: return [];
  }
}
