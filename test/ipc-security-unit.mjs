import assert from 'node:assert/strict';
import { MAX_CLIPBOARD_TEXT_BYTES, registerIpcHandlers } from '../electron/ipc-handlers.js';
import { createContractIpcRegistrar, createWindowGuards } from '../electron/ipc-security.js';

const handles = new Map();
const listeners = new Map();
const wizard = { id: 'wizard' };
const fallback = { id: 'fallback' };
const dashboard = { id: 'dashboard' };
const pulse = { id: 'pulse' };
const other = { id: 'other' };
const calls = [];
let clipboardText = '';
let stopCalls = 0;
let restartCalls = 0;
let relaunchCalls = 0;
let quitCalls = 0;

const deps = {
  ipcMain: { handle: (channel, handler) => handles.set(channel, handler), on: (channel, handler) => listeners.set(channel, handler) },
  BrowserWindow: { fromWebContents: sender => sender?.window || null },
  clipboard: { writeText: value => { clipboardText = value; } },
  getWizardWindow: () => wizard,
  closeWizard: options => calls.push(['closeWizard', options]),
  getFallbackWindow: () => fallback,
  getDashboardWindow: () => dashboard,
  getPulseWindow: () => pulse,
  setPulseExpanded: expanded => { calls.push(['pulseExpanded', expanded]); return expanded; },
  getRecoveryConfig: () => ({ ok: true }),
  openRecoverySetup: () => ({ ok: true }),
  startServer: () => ({ ok: true, started: true }),
  stopServer: () => { stopCalls += 1; return { ok: true }; },
  launchConfiguredDesktop: async options => { calls.push(['launch', options]); return { serverRunning: true }; },
  restartConnection: async () => { restartCalls += 1; return { serverRunning: true, tunnelStatus: 'running' }; },
  relaunchApplication: async () => { relaunchCalls += 1; return { ok: true }; },
  quitApplication: async () => { quitCalls += 1; return { ok: true }; },
  openSettingsWindow: () => ({ ok: true }),
  openDashboardWindow: routeHash => { calls.push(['openDashboard', routeHash || '']); return { ok: true }; },
  getDesktopSettings: () => ({ ok: true }),
  saveDesktopSettings: settings => ({ ok: true, settings }),
  getLocalUsage: month => ({ ok: true, month }),
  getUpdateStatus: () => ({ state: 'idle' }), checkForUpdates: () => ({ ok: true }), downloadUpdate: () => ({ ok: true }), installUpdate: () => ({ ok: true }),
  getLifecycleStatus: () => ({ ok: true }), acknowledgeConnectorRefresh: () => ({ ok: true }), setLaunchAtLogin: enabled => enabled,
  getCurrentStatus: () => ({ serverRunning: true }),
  getDashboardWindowState: () => ({ platform: 'win32', customTitleBar: true }),
  minimizeDashboardWindow: () => ({ minimized: true }), toggleDashboardMaximize: () => ({ maximized: true }), requestDashboardClose: () => ({ ok: true }),
  getNotificationsEnabled: () => true, setNotificationsEnabled: enabled => enabled,
  getNotificationPreferences: () => ({}), updateNotificationPreferences: patch => patch,
  exportDiagnosticState: report => ({ ok: true, report }), openDiagnosticsFolder: () => ({ ok: true }),
  getTaskCodeWorkspace: payload => ({ ok: true, payload }),
  readTaskCodeDiff: payload => ({ ok: true, payload }),
  listCodeEditors: () => ({ ok: true, editors: [] }),
  openTaskCodeIde: payload => ({ ok: true, payload }),
  fitWindowToContent: (window, options) => calls.push(['fit', window.id, options]),
  saveLauncherConfig: config => calls.push(['save', config]),
  setTunnelApiKey: key => calls.push(['tunnelKey', key])
};
registerIpcHandlers(deps);
const eventFor = window => ({ sender: { window } });

assert.ok(Number.isSafeInteger(MAX_CLIPBOARD_TEXT_BYTES) && MAX_CLIPBOARD_TEXT_BYTES > 0, 'clipboard input must remain bounded');
const guards = createWindowGuards(deps.BrowserWindow);
assert.equal(guards.windowOnly(eventFor(dashboard), () => dashboard, 'Dashboard', () => 'allowed'), 'allowed');
assert.throws(() => guards.windowOnly(eventFor(other), () => dashboard, 'Dashboard', () => 'denied'), /not available/);
const registrar = createContractIpcRegistrar({
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: deps.BrowserWindow,
  contract: {
    'test:handle': { mode: 'handle', windows: ['dashboard'], failure: 'reject' },
    'test:on': { mode: 'on', windows: ['dashboard'], failure: 'ignore' }
  },
  windowGetters: { dashboard: () => dashboard }
});
assert.throws(() => registrar.on('test:handle', 'Test', () => {}), /must register with ipcMain\.handle/);
assert.throws(() => registrar.handle('missing:channel', 'Test', () => {}), /missing from the input contract/);
assert.equal([...handles.keys()].some(channel => channel.startsWith('desktop:cloud:')), false);
assert.equal([...handles.keys()].some(channel => /ngrok|gateway|approval/i.test(channel)), false);
assert.throws(() => handles.get('desktop:settings:get')(eventFor(other)), /not available/);
assert.throws(() => handles.get('url:open-dashboard')(eventFor(other), '#tasks'), /not available/);
assert.deepEqual(handles.get('url:open-dashboard')(eventFor(pulse), '#tasks?workspace=repo&task=task-1'), { ok: true });
assert.ok(calls.some(entry => entry[0] === 'openDashboard' && entry[1] === '#tasks?workspace=repo&task=task-1'), 'Pulse may deep-link only through the existing dashboard opener');
assert.deepEqual(handles.get('pulse:set-expanded')(eventFor(pulse), true), { ok: true, expanded: true });
assert.ok(calls.some(entry => entry[0] === 'pulseExpanded' && entry[1] === true), 'Pulse may request only its own display geometry');
assert.throws(() => handles.get('pulse:set-expanded')(eventFor(dashboard), true), /not available/);
assert.throws(() => handles.get('pulse:set-expanded')(eventFor(pulse), 'yes'), /must be a boolean/);
assert.throws(() => handles.get('desktop:code:get')(eventFor(other), { taskId: 'task-1' }), /not available/);
assert.deepEqual(handles.get('desktop:code:get')(eventFor(dashboard), { taskId: 'task-1' }), { ok: true, payload: { taskId: 'task-1' } });
assert.equal(handles.has('desktop:code:write'), false, 'the Changes surface must not expose a renderer file-write channel');
assert.equal(handles.has('desktop:code:read'), false, 'the Changes surface must use diff-only file access');
assert.throws(() => handles.get('desktop:code:open-ide')(eventFor(dashboard), { taskId: 'task-1', editorId: 'x'.repeat(41) }), /editorId is too long/);
assert.throws(() => handles.get('url:copy')(eventFor(dashboard), 'x'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)));
assert.deepEqual(handles.get('url:copy')(eventFor(wizard), 'safe\u0000text'), { ok: true });
assert.equal(clipboardText, 'safetext');
await handles.get('wizard:done')(eventFor(wizard), { port: 3333, tunnelId: 'tunnel_example123456', tunnelApiKey: 'sk-runtime-example-123456', restart: false });
assert.ok(calls.some(entry => entry[0] === 'tunnelKey'));
assert.ok(calls.some(entry => entry[0] === 'save'));
assert.ok(calls.some(entry => entry[0] === 'launch' && entry[1].firstRun === true));
assert.throws(() => handles.get('desktop:restart-connection')(eventFor(other)), /not available/);
assert.throws(() => handles.get('recovery:restart-connection')(eventFor(other)), /not available/);
assert.throws(() => handles.get('desktop:relaunch')(eventFor(other)), /not available/);
assert.throws(() => handles.get('desktop:quit')(eventFor(other)), /not available/);
assert.equal(restartCalls, 0, 'wizard startup must stay separate from the tunnel-only retry operation');
assert.equal(relaunchCalls, 0);
assert.equal(quitCalls, 0);
await handles.get('desktop:restart-connection')(eventFor(dashboard));
await handles.get('recovery:restart-connection')(eventFor(fallback));
await handles.get('desktop:relaunch')(eventFor(dashboard));
await handles.get('desktop:quit')(eventFor(dashboard));
assert.equal(restartCalls, 2);
assert.equal(relaunchCalls, 1);
assert.equal(quitCalls, 1);
listeners.get('desktop:stop-service')(eventFor(other));
await new Promise(resolve => setImmediate(resolve));
assert.equal(stopCalls, 0);
listeners.get('desktop:stop-service')(eventFor(dashboard));
await new Promise(resolve => setImmediate(resolve));
assert.equal(stopCalls, 1);
console.log('IPC secure tunnel boundary tests passed.');
