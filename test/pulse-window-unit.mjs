import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createPulseWindowManager, pulseBounds } from '../electron/pulse-window.js';
import { projectPulseStatus } from '../electron/pulse-state.js';

const waitingApproval = projectPulseStatus({
  serverRunning: true,
  tunnelStatus: 'running',
  taskActivity: {
    state: 'waiting', activeCalls: 0, activeTaskCount: 1,
    tasks: [{ taskId: 'task-1', workspace: 'repo', title: 'Ship release', status: 'waiting_for_approval' }]
  }
});
assert.equal(waitingApproval.actionRequired, true);
assert.equal(waitingApproval.badge, 'Action required');
assert.equal(waitingApproval.title, 'Approval required');
assert.match(waitingApproval.detail, /approval/i);
assert.match(waitingApproval.route, /^#tasks\?/);
assert.match(waitingApproval.route, /workspace=repo/);
assert.match(waitingApproval.route, /task=task-1/);

const blocked = projectPulseStatus({
  taskActivity: {
    state: 'waiting', activeCalls: 0, activeTaskCount: 1,
    tasks: [{ taskId: 'task-2', workspace: 'repo', status: 'blocked', currentActivity: 'Choose a valid deployment target.' }]
  }
});
assert.equal(blocked.actionRequired, true);
assert.equal(blocked.title, 'Resolve the blocker to continue');
assert.match(blocked.detail, /deployment target/i);

const validationFailed = projectPulseStatus({
  taskActivity: {
    state: 'waiting', activeCalls: 0, activeTaskCount: 1,
    tasks: [{ taskId: 'task-3', workspace: 'repo', status: 'validation_failed' }]
  }
});
assert.equal(validationFailed.actionRequired, true);
assert.equal(validationFailed.title, 'Checks need attention');

const staleAttention = projectPulseStatus({
  taskActivity: {
    state: 'idle', activeCalls: 0, activeTaskCount: 0,
    tasks: [{ taskId: 'task-stale', workspace: 'repo', status: 'blocked', currentActivity: 'Old blocker' }]
  }
});
assert.equal(staleAttention.actionRequired, false, 'stale task rows must not pin Pulse in Action required');
assert.equal(staleAttention.visible, true, 'idle Pulse must remain visible without treating stale task rows as live activity');

const connectionAttention = projectPulseStatus({
  serverRunning: true,
  tunnelStatus: 'failed',
  errorCode: 'tunnel_connection_interrupted',
  error: 'Secure MCP Tunnel disconnected.'
});
assert.equal(connectionAttention.tone, 'attention');
assert.equal(connectionAttention.badge, 'Needs attention');
assert.equal(connectionAttention.actionRequired, false, 'connection recovery must not be mislabeled as a task action required state');

const working = projectPulseStatus({
  taskActivity: {
    state: 'working', activeCalls: 1, activeTaskCount: 2, operation: 'Running tests',
    tasks: [
      { taskId: 'task-4', workspace: 'repo', title: 'Fix tests', status: 'running', activeCalls: 1, progress: { percent: 42, label: 'Frontend tests' } },
      { taskId: 'task-4b', workspace: 'docs', title: 'Prepare notes', status: 'planning' }
    ]
  }
});
assert.equal(working.tone, 'working');
assert.equal(working.actionRequired, false);
assert.equal(working.badge, '1 running');
assert.equal(working.contextTitle, 'Fix tests');
assert.equal(working.workspace, 'repo');
assert.equal(working.progressPercent, 42);
assert.equal(working.progressLabel, 'Frontend tests');
assert.equal(working.taskCount, 2);
assert.equal(working.otherTaskCount, 1);
assert.deepEqual(working.taskNames, ['Fix tests', 'Prepare notes']);
assert.equal(working.taskItems.length, 2, 'expanded Pulse must receive per-task rows');
assert.equal(working.taskItems[0].statusLabel, 'Running');
assert.equal(working.workspacesLabel, 'repo +1');
assert.ok(typeof working.activityLine === 'string');

const ordinaryWaiting = projectPulseStatus({
  taskActivity: {
    state: 'waiting', activeCalls: 0, activeTaskCount: 1,
    tasks: [{ taskId: 'task-5', workspace: 'repo', status: 'running', title: 'Continue task' }]
  }
});
assert.equal(ordinaryWaiting.tone, 'waiting');
assert.equal(ordinaryWaiting.actionRequired, false);
assert.doesNotMatch(ordinaryWaiting.detail, /waiting on you/i, 'ordinary remote reasoning gaps must not be mislabeled as user input');

const connectedIdle = projectPulseStatus({ serverRunning: true, tunnelStatus: 'running' });
assert.equal(connectedIdle.visible, true, 'Pulse must remain available while Rel.AI is idle');
assert.equal(connectedIdle.tone, 'idle');
assert.equal(connectedIdle.detail, 'No local task is active.');
assert.equal(projectPulseStatus({ serverRunning: false }).visible, true);

const pulseHtml = readFileSync(new URL('../electron/renderer/pulse.html', import.meta.url), 'utf8');
const pulseCss = readFileSync(new URL('../electron/renderer/pulse.css', import.meta.url), 'utf8');
const pulseRenderer = readFileSync(new URL('../electron/renderer/pulse.js', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
assert.match(pulseHtml, /id="pulseTaskCount"/, 'compact Pulse markup must expose the active task count');
assert.match(pulseHtml, /id="pulseTaskList"/, 'expanded Pulse must expose a task list');
assert.match(pulseHtml, /id="pulseActivity"/, 'expanded Pulse must expose the current activity line');
assert.doesNotMatch(pulseHtml, /id="pulseCopy"/, 'expanded Pulse must not expose a redundant copy-details action');
assert.match(pulseHtml, /id="pulseCompactProgressFill"/, 'compact Pulse must expose a glanceable progress hairline');
assert.match(pulseCss, /\.pulse-bar\s*\{[^}]*-webkit-app-region:\s*drag/s, 'Pulse header must provide one stable native drag surface in compact and expanded states');
assert.match(pulseCss, /\.pulse-compact-copy\s*\{[^}]*-webkit-app-region:\s*no-drag/s, 'compact click-to-expand content must stay interactive inside the native drag surface');
assert.doesNotMatch(pulseCss, /\.pulse-shell\s*\{[^}]*transition:/s, 'Pulse shell styling must not run a second CSS geometry transition alongside the compositor motion');
assert.match(pulseCss, /body\.pulse-page\s*\{[^}]*padding:\s*0/s, 'Pulse surface must fill the native transparent window instead of leaving a rectangular gutter');
assert.match(pulseCss, /\.pulse-shell\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/s, 'compact and expanded Pulse geometry must use the exact native window bounds'); // rigidity-ok: the shell must exactly fill the transparent native window to avoid exposed rectangular gutters.
assert.doesNotMatch(pulseCss, /backdrop-filter|box-shadow:\s*var\(--ui-shadow-(?:window|popover)\)/, 'Pulse must not paint clipped glass or external shadows that reveal the rectangular native window');
assert.doesNotMatch(pulseCss, /pulseActivity|animation:\s*[^;]*infinite/, 'working state must not keep the transparent overlay continuously compositing');
assert.doesNotMatch(pulseCss, /\.pulse-island\s*\{[^}]*(?:transform:|transition:)/s, 'Pulse details must share the shell motion instead of running a second geometry transition');
assert.doesNotMatch(pulseCss, /data-collapsing="true"\][^{]*\{[^}]*(?:opacity|visibility|border-radius):/s, 'collapse state must not visually detach the contents or corners from the final expanded structure');
assert.doesNotMatch(pulseCss, /will-change:\s*transform, opacity/, 'Pulse must not permanently reserve a compositor layer between transitions');
assert.match(pulseCss, /user-select:\s*none/, 'Pulse text must not be selectable during pointer interaction');
const nativeExpandIndex = pulseRenderer.indexOf('setExpanded?.(true)');
const visualExpandIndex = pulseRenderer.indexOf('startExpandMorph()');
assert.ok(nativeExpandIndex >= 0 && visualExpandIndex > nativeExpandIndex, 'native expansion must happen before the compositor morph begins');
const collapseLayoutIndex = pulseRenderer.indexOf('applyExpandedLayout(false)');
const nativeCollapseIndex = pulseRenderer.lastIndexOf('setExpanded?.(false)');
assert.ok(collapseLayoutIndex >= 0 && nativeCollapseIndex > collapseLayoutIndex, 'the visual morph must reach compact layout before the native window contracts');
assert.match(pulseRenderer, /shell\.animate\(/, 'Pulse open and close transitions must stay on opacity and compositor transforms instead of CSS width/height interpolation');
assert.match(pulseRenderer, /translateY\(-5px\) scale\(\.985\)/, 'Pulse transition must preserve the final panel proportions instead of stretching between unrelated aspect ratios');
assert.doesNotMatch(pulseRenderer, /(?:before|target)\.width\s*\/\s*(?:after|from)\.width|(?:before|target)\.height\s*\/\s*(?:after|from)\.height/, 'Pulse must not non-uniformly scale the expanded structure into pill geometry');
assert.match(pulseRenderer, /morphAnimation\.reverse\(\)/, 'rapid open/close changes must reverse the active transition instead of restarting from a jump');
assert.match(pulseRenderer, /animation\.finished\.then\(\(\) => finishMorph\(animation\)/, 'Pulse must use the animation finished promise when Electron delivers it promptly');
assert.match(pulseRenderer, /setTimeout\(\(\) => finishMorph\(animation\), PULSE_TRANSITION_MS \+ 24\)/, 'Pulse must have a bounded completion fallback so native collapse cannot remain expanded after the visual transition ends');
assert.match(pulseRenderer, /model\?\.expanded === false && expanded[^\n]*resetExpandedFromHost\(\)/, 'a hidden native collapse must reset stale renderer expansion before Pulse is shown again');
assert.match(pulseRenderer, /prefers-reduced-motion:\s*reduce/, 'Pulse motion must honor the reduced-motion preference');
assert.match(pulseRenderer, /taskCountElement\.textContent = taskCount === 1 \? '1 task' : `\$\{taskCount\} tasks`;/, 'compact Pulse must render the current task count');
assert.doesNotMatch(pulseRenderer, /pointerenter|pointerleave|scheduleHoverOpen|suppressHoverOpen/, 'Pulse expansion must not depend on hover state that can oscillate while the native window resizes');
assert.match(pulseRenderer, /querySelector\('\.pulse-bar'\)[\s\S]{0,160}!expanded[\s\S]{0,80}setExpanded\(true\)/, 'clicking the compact Pulse must expand it');
assert.match(pulseRenderer, /event\.key === 'Escape' && expanded/, 'Escape must collapse an expanded Pulse');
assert.match(pulseRenderer, /taskNames\.join\(' · '\)/, 'expanded Pulse must render active task names');
assert.match(pulseRenderer, /relaiPulse\?\.openDashboard\?\.\(\)/, 'Pulse must use the same no-route dashboard opener as the tray');
assert.doesNotMatch(pulseRenderer, /openDashboard\?\.\(currentModel\.route/, 'Pulse must not turn a dashboard open into a deep-link navigation requirement');
assert.match(preloadSource, /openDashboard:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('url:open-dashboard'\)/, 'Pulse preload must expose the canonical no-route dashboard open action');

const workArea = { x: 100, y: 50, width: 1400, height: 900 };
const displayListeners = new Map();
const fakeScreen = {
  getPrimaryDisplay: () => ({ workArea }),
  on(name, listener) { displayListeners.set(name, listener); },
  off(name, listener) { if (displayListeners.get(name) === listener) displayListeners.delete(name); }
};
assert.deepEqual(pulseBounds(fakeScreen), { x: 1196, y: 68, width: 286, height: 48 });
assert.deepEqual(pulseBounds(fakeScreen, { expanded: true }), { x: 1118, y: 68, width: 364, height: 384 });
assert.deepEqual(
  pulseBounds(fakeScreen, { expanded: true, anchor: { right: 150, top: 0 } }),
  { x: 100, y: 50, width: 364, height: 384 },
  'expanded Pulse must clamp safely to the active display when the saved anchor is too close to an edge'
);
const tinyWorkArea = { x: 0, y: 0, width: 320, height: 240 };
const tinyScreen = {
  getPrimaryDisplay: () => ({ workArea: tinyWorkArea }),
  getDisplayNearestPoint: () => ({ workArea: tinyWorkArea })
};
assert.deepEqual(
  pulseBounds(tinyScreen, { expanded: true, anchor: { right: 320, top: 0 } }),
  { x: 0, y: 0, width: 364, height: 384 },
  'expanded Pulse must never produce negative coordinates when the work area is smaller than the window'
);

const windows = [];
class FakeWindow {
  constructor(options) {
    this.options = options;
    this.currentBounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.destroyed = false;
    this.visible = false;
    this.events = new Map();
    this.webContentsEvents = new Map();
    this.sent = [];
    this.boundsWrites = [];
    this.sessionEvents = new Map();
    this.session = {
      protocol: {},
      setPermissionRequestHandler: listener => { this.permissionRequest = listener; },
      setPermissionCheckHandler: listener => { this.permissionCheck = listener; },
      on: (name, listener) => this.sessionEvents.set(name, listener)
    };
    this.webContents = {
      session: this.session,
      on: (name, listener) => this.webContentsEvents.set(name, listener),
      setWindowOpenHandler: listener => { this.openHandler = listener; },
      send: (channel, payload) => this.sent.push({ channel, payload })
    };
    windows.push(this);
  }
  loadURL(url) { this.url = url; return Promise.resolve(); }
  on(name, listener) { this.events.set(name, listener); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  showInactive() { this.visible = true; this.showInactiveCount = (this.showInactiveCount || 0) + 1; }
  show() { this.visible = true; this.showCount = (this.showCount || 0) + 1; }
  hide() { this.visible = false; this.hideCount = (this.hideCount || 0) + 1; }
  getBounds() { return { ...this.currentBounds }; }
  setBounds(bounds) { this.currentBounds = { ...bounds }; this.boundsWrites.push({ ...bounds }); }
  setSize(width, height) { this.sizeWrites = [...(this.sizeWrites || []), { width, height }]; }
  destroy() { this.destroyed = true; this.visible = false; this.events.get('closed')?.(); }
}

const securityErrors = [];
let protocolInstallCount = 0;
let appReady = false;
const guardedScreen = new Proxy(fakeScreen, {
  get(target, property) {
    assert.ok(appReady, 'Electron screen must not be accessed before app readiness');
    return Reflect.get(target, property);
  }
});
const manager = createPulseWindowManager({
  BrowserWindow: FakeWindow,
  screen: guardedScreen,
  preloadPath: 'preload.cjs',
  rendererUrl: 'relai-app://renderer/pulse.html',
  installProtocol: () => { protocolInstallCount += 1; },
  platform: 'win32',
  onSecurityError: error => securityErrors.push(error)
});
manager.setEnabled(true);
manager.setThemePreference('system');
manager.update({ serverRunning: true });
assert.equal(manager.stop(), false);
appReady = true;
assert.equal(manager.start(), true);
assert.equal(manager.start(), false, 'Pulse startup must be idempotent');
manager.update({ serverRunning: true, tunnelStatus: 'running' });
const idleWindow = manager.getWindow();
assert.ok(idleWindow, 'Connected idle state must keep a persistent Pulse overlay');
assert.equal(idleWindow.visible, true);
assert.equal(idleWindow.showInactiveCount, 1, 'Pulse must appear without taking focus');
assert.equal(idleWindow.showCount || 0, 0, 'showInactive must not fall through to a focusable show call');
assert.equal(manager.setSuppressed(true), true, 'focused-dashboard suppression must be explicit and transient');
assert.equal(idleWindow.visible, false, 'Pulse must not cover the focused Rel.AI dashboard chrome');
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: { state: 'working', activeCalls: 1, activeTaskCount: 0, tool: 'relai_read', tasks: [] }
});
assert.equal(manager.getWindow(), idleWindow, 'unlinked activity must reuse the persistent Pulse window');
assert.equal(idleWindow.visible, false, 'status updates must not re-show Pulse while dashboard suppression is active');
assert.equal(manager.setSuppressed(false), false, 'dashboard blur must release only the transient suppression');
assert.equal(idleWindow.visible, true, 'Pulse must resume when the Rel.AI dashboard loses focus');
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: { state: 'idle', activeCalls: 0, activeTaskCount: 0, tasks: [] }
});
assert.equal(idleWindow.visible, true, 'Pulse must remain visible when unlinked activity ends');
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: {
    state: 'working', activeCalls: 1, activeTaskCount: 1, operation: 'Running tests',
    tasks: [{ taskId: 'task-active', workspace: 'repo', title: 'Fix tests', status: 'running', activeCalls: 1 }]
  }
});
const window = manager.getWindow();
assert.ok(window);
assert.equal(windows.length, 1);
assert.equal(protocolInstallCount, 1);
assert.equal(window.options.frame, false);
assert.equal(window.options.skipTaskbar, true);
assert.equal(window.options.alwaysOnTop, true);
assert.equal(window.options.transparent, true);
assert.equal(window.options.hasShadow, false, 'Pulse must disable the native rectangular shadow around its transparent window bounds');
assert.equal(window.options.backgroundColor, '#00000000');
assert.equal(window.options.webPreferences.nodeIntegration, false);
assert.equal(window.options.webPreferences.contextIsolation, true);
assert.equal(window.options.webPreferences.sandbox, true);
assert.deepEqual(window.options.webPreferences.additionalArguments, ['--relai-preload-surface=pulse']);
assert.equal(window.permissionCheck(), false);
assert.deepEqual(window.openHandler({ url: 'https://example.com' }), { action: 'deny' });
manager.setThemePreference('dark');
window.webContentsEvents.get('did-finish-load')?.();
assert.equal(window.sent.at(-1).channel, 'pulse:update');
assert.equal(window.sent.at(-1).payload.tone, 'working');
assert.equal(window.sent.at(-1).payload.themePreference, 'dark');
assert.equal(window.sent.at(-1).payload.expanded, false, 'Pulse state sent to the renderer must include authoritative native expansion state');
const idleGeometryWrites = window.boundsWrites.length;
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: {
    state: 'working', activeCalls: 1, activeTaskCount: 1, operation: 'Running tests',
    tasks: [{ taskId: 'task-active', workspace: 'repo', title: 'Fix tests', status: 'running', activeCalls: 1 }]
  }
});
assert.equal(window.boundsWrites.length, idleGeometryWrites, 'status-only Pulse updates must not reapply unchanged native bounds');
assert.equal(manager.setExpanded(true), true);
assert.deepEqual(window.boundsWrites.at(-1), pulseBounds(fakeScreen, { expanded: true }));
assert.equal(manager.setExpanded(false), false);
assert.deepEqual(window.boundsWrites.at(-1), pulseBounds(fakeScreen));

window.currentBounds = { x: 500, y: 200, width: 286, height: 48 };
window.events.get('will-move')?.({}, { x: 500, y: 200, width: 286, height: 48 });
assert.equal(manager.setExpanded(true), true);
assert.deepEqual(window.boundsWrites.at(-1), { x: 422, y: 200, width: 364, height: 384 }, 'expansion must preserve the right edge and top of a user-moved Pulse');
assert.equal(manager.setExpanded(false), false);
assert.deepEqual(window.boundsWrites.at(-1), { x: 500, y: 200, width: 286, height: 48 }, 'collapse must return to the user-moved compact position');
window.events.get('move')?.();
assert.equal(manager.setExpanded(true), true);
assert.deepEqual(window.boundsWrites.at(-1), { x: 422, y: 200, width: 364, height: 384 }, 'programmatic move notifications must not rewrite the manual anchor');
window.events.get('will-move')?.({}, { x: 700, y: 300, width: 364, height: 384 });
assert.equal(manager.setExpanded(false), false);
assert.deepEqual(window.boundsWrites.at(-1), { x: 778, y: 300, width: 286, height: 48 }, 'dragging the expanded Pulse must preserve the same right/top anchor when it collapses');

manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: {
    state: 'waiting', activeCalls: 0, activeTaskCount: 1,
    tasks: [{ taskId: 'task-action', workspace: 'repo', status: 'waiting_for_approval' }]
  }
});
assert.equal(window.sent.at(-1).payload.actionRequired, true);
manager.setEnabled(false);
assert.equal(window.visible, false);
manager.setEnabled(true);
assert.equal(window.visible, true);
displayListeners.get('display-metrics-changed')?.();
assert.deepEqual(window.boundsWrites.at(-1), { x: 778, y: 300, width: 286, height: 48 }, 'display changes must preserve the latest valid user-moved Pulse position');
assert.equal(securityErrors.length, 0);
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: { state: 'idle', activeCalls: 0, activeTaskCount: 0, tasks: [] }
});
assert.equal(window.visible, true, 'Pulse must remain visible when task activity returns to idle');
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: { state: 'working', activeCalls: 1, activeTaskCount: 0, tool: 'relai_exec', tasks: [] }
});
assert.equal(window.visible, true, 'unlinked activity must update the persistent Pulse in place');
manager.update({
  serverRunning: true, tunnelStatus: 'running',
  taskActivity: { state: 'idle', activeCalls: 0, activeTaskCount: 0, tasks: [] }
});
let closePrevented = false;
window.events.get('close')?.({ preventDefault: () => { closePrevented = true; } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(closePrevented, true, 'native close must be intercepted while Rel.AI is still running');
assert.equal(window.visible, true, 'accidentally closing Pulse must restore the persistent overlay');
const crashedWindow = manager.getWindow();
const windowCountBeforeCrash = windows.length;
crashedWindow.webContentsEvents.get('render-process-gone')?.({}, { reason: 'crashed' });
await new Promise(resolve => setImmediate(resolve));
const recoveredWindow = manager.getWindow();
assert.ok(recoveredWindow, 'renderer crashes must recreate the Pulse window');
assert.notEqual(recoveredWindow, crashedWindow, 'renderer crash recovery must replace the dead window');
assert.equal(windows.length, windowCountBeforeCrash + 1, 'renderer crash recovery must create exactly one replacement window');
assert.equal(recoveredWindow.visible, true, 'renderer crash recovery must restore the Pulse without waiting for another status change');
assert.equal(manager.stop(), true);
assert.equal(manager.stop(), false, 'Pulse shutdown must be idempotent');
assert.equal(manager.getWindow(), null);
assert.equal(displayListeners.size, 0);

const waylandWindows = [];
class WaylandWindow extends FakeWindow {
  constructor(options) { super(options); waylandWindows.push(this); }
}
const waylandManager = createPulseWindowManager({
  BrowserWindow: WaylandWindow,
  screen: fakeScreen,
  preloadPath: 'preload.cjs',
  rendererUrl: 'relai-app://renderer/pulse.html',
  platform: 'linux',
  env: { XDG_SESSION_TYPE: 'wayland' }
});
waylandManager.start();
waylandManager.update({
  taskActivity: {
    state: 'working', activeCalls: 1, activeTaskCount: 1,
    tasks: [{ taskId: 'task-wayland', status: 'running', activeCalls: 1 }]
  }
});
assert.equal(waylandWindows[0].options.alwaysOnTop, false, 'Wayland must not claim unsupported always-on-top behavior');
assert.equal(waylandWindows[0].boundsWrites.length, 0, 'Wayland must not issue unsupported global reposition requests');
waylandManager.setExpanded(true);
assert.deepEqual(waylandWindows[0].sizeWrites.at(-1), { width: 364, height: 384 }, 'Wayland may resize locally without claiming global positioning');
waylandManager.stop();

console.log('Rel.AI Pulse state projection, security, focus behavior, positioning, and Wayland fallback tests passed.');
