import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createBrowserSurfaceHost } from '../electron/browser-surface-host.js';
import { registerBrowserSurfaceIpc } from '../electron/ipc-handlers-dashboard.js';

let nextWebContentsId = 100;

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.storageCleared = 0;
    this.cacheCleared = 0;
    this.certificateVerifier = undefined;
  }
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
  setCertificateVerifyProc(handler) { this.certificateVerifier = handler; }
  async clearStorageData() { this.storageCleared += 1; }
  async clearCache() { this.cacheCleared += 1; }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextWebContentsId++;
    this.url = 'about:blank';
    this.title = '';
    this.destroyed = false;
    this.focusCount = 0;
    this.executeJavaScriptError = null;
    this.onExecuteJavaScript = null;
    this.capturePageHandler = null;
    this.inputEvents = [];
    this.debuggerCommands = [];
    this.debuggerAttached = false;
    this.debugger = {
      isAttached: () => this.debuggerAttached,
      attach: () => { this.debuggerAttached = true; },
      sendCommand: async (method, params = {}) => {
        this.debuggerCommands.push([method, params]);
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 1440, height: 900 } };
        if (method === 'Page.captureScreenshot') return { data: Buffer.from('fake-png').toString('base64') };
        return {};
      }
    };
  }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  async loadURL(url) {
    this.emit('did-start-loading');
    this.url = url;
    this.title = 'Loaded';
    this.emit('did-navigate');
    this.emit('did-stop-loading');
  }
  stop() {}
  async executeJavaScript(script) {
    this.onExecuteJavaScript?.();
    if (this.executeJavaScriptError) throw this.executeJavaScriptError;
    if (String(script).includes('return { attached:')) return { attached: true, visible: true };
    return true;
  }
  async capturePage() {
    if (this.capturePageHandler) return this.capturePageHandler();
    return {
      toPNG: () => Buffer.from('fake-png'),
      getSize: () => ({ width: 320, height: 240 })
    };
  }
  sendInputEvent(event) { this.inputEvents.push(event); }
  focus() { this.focusCount += 1; }
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
  destroy() { this.close(); }
}

class FakeWebContentsView {
  constructor(options = {}) {
    this.options = options;
    this.webContents = options.webContents || new FakeWebContents();
    this.bounds = null;
  }
  setBounds(bounds) { this.bounds = bounds; }
}

function createHarness({ failOpen = false } = {}) {
  const sessions = [];
  const views = [];
  const webContents = [];
  const HarnessWebContentsView = class extends FakeWebContentsView {
    constructor(options) {
      super(options);
      views.push(this);
      webContents.push(this.webContents);
    }
  };
  const sessionApi = {
    fromPartition() { const value = new FakeSession(); sessions.push(value); return value; },
    fromPath() { const value = new FakeSession(); sessions.push(value); return value; }
  };
  const childViews = new Set();
  const sent = [];
  const dashboardInputEvents = [];
  const dashboard = {
    isDestroyed: () => false,
    contentView: {
      addChildView(view) { childViews.add(view); },
      removeChildView(view) { childViews.delete(view); }
    },
    webContents: {
      send: (...args) => sent.push(args),
      sendInputEvent: event => dashboardInputEvents.push(event)
    }
  };
  const routes = [];
  const events = [];
  const host = createBrowserSurfaceHost({
    WebContentsView: HarnessWebContentsView,
    session: sessionApi,
    getDashboardWindow: () => dashboard,
    openDashboard: async route => {
      routes.push(route);
      if (failOpen) throw new Error('dashboard unavailable');
    },
    onEvent: event => events.push(event)
  });
  return { host, sessions, views, webContents, childViews, routes, sent, events, dashboardInputEvents };
}

{
  const handlers = new Map();
  const ipc = { handle: (channel, _label, handler) => handlers.set(channel, handler) };
  const channels = {
    DESKTOP_BROWSER_GET_STATE: 'get-state',
    DESKTOP_BROWSER_SET_BOUNDS: 'set-bounds',
    DESKTOP_BROWSER_SET_CONTROL: 'set-control',
    DESKTOP_BROWSER_SELECT_SESSION: 'select-session',
    DESKTOP_BROWSER_SELECT_TAB: 'select-tab',
    DESKTOP_BROWSER_CLOSE_TAB: 'close-tab',
    DESKTOP_BROWSER_STOP: 'stop'
  };
  let receivedBounds = null;
  registerBrowserSurfaceIpc({
    ipc,
    channels,
    getBrowserState: () => ({}),
    setBrowserSurfaceBounds: bounds => { receivedBounds = bounds; return bounds; },
    setBrowserControl: () => ({}),
    selectBrowserSession: () => ({}),
    selectBrowserTab: () => ({}),
    closeBrowserTab: () => ({}),
    stopActiveBrowserSession: () => ({})
  });
  handlers.get('set-bounds')({}, { visible: true, x: 12.4, y: 34.6, width: 900.2, height: 600.8 });
  assert.deepEqual(receivedBounds, { visible: true, x: 12, y: 35, width: 900, height: 601 }, 'visible browser bounds must stay visible across the dashboard IPC boundary');
}

{
  const { host } = createHarness({ failOpen: true });
  await assert.rejects(() => host.run({ action: 'start' }), /dashboard unavailable/);
  assert.equal(host.getState().active, false, 'a failed dashboard handoff must not leave a hidden native browser session active');
}

{
  const { host, webContents, dashboardInputEvents } = createHarness();
  const started = await host.run({ action: 'start' });
  await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  await host.setBounds({ visible: true, x: 10, y: 20, width: 1440, height: 900 });

  let prevented = false;
  webContents[0].emit('before-mouse-event', { preventDefault: () => { prevented = true; } }, {
    type: 'mouseWheel',
    x: 100,
    y: 120,
    deltaX: 4,
    deltaY: -160,
    wheelTicksX: 1,
    wheelTicksY: -3,
    hasPreciseScrollingDeltas: true,
    canScroll: true,
    modifiers: ['shift']
  });
  assert.equal(prevented, true, 'AI ownership must still block wheel input from reaching the webpage');
  assert.deepEqual(dashboardInputEvents, [{
    type: 'mouseWheel',
    x: 110,
    y: 140,
    deltaX: 4,
    deltaY: -160,
    wheelTicksX: 1,
    wheelTicksY: -3,
    hasPreciseScrollingDeltas: true,
    canScroll: true,
    modifiers: ['shift']
  }], 'wheel input over an AI-owned browser view must be forwarded to the dashboard at the matching screen position');

  prevented = false;
  webContents[0].emit('before-mouse-event', { preventDefault: () => { prevented = true; } }, {
    type: 'mouseDown', x: 100, y: 120, button: 'left'
  });
  assert.equal(prevented, true, 'AI ownership must continue blocking non-wheel pointer input');
  assert.equal(dashboardInputEvents.length, 1, 'non-wheel pointer input must not leak into the dashboard');

  await host.setControl('user');
  prevented = false;
  webContents[0].emit('before-mouse-event', { preventDefault: () => { prevented = true; } }, {
    type: 'mouseWheel', x: 100, y: 120, deltaY: -160
  });
  assert.equal(prevented, false, 'user takeover must leave wheel input on the webpage');
  assert.equal(dashboardInputEvents.length, 1, 'user-owned webpage scrolling must not be redirected to the dashboard');
  await host.closeAll();
}

{
  const { host } = createHarness();
  const started = await host.run({ action: 'start' });
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  const layout = await host.run({
    action: 'snapshot',
    nativeSessionId: started.nativeSessionId,
    nativePageId: opened.nativePageId,
    detail: 'layout'
  });
  assert.equal(layout.detail, 'layout', 'embedded browser snapshots must expose the requested layout detail mode');
  assert.equal(layout.snapshot, 'true', 'embedded layout snapshots must execute through the page DOM rather than requiring the accessibility debugger');
  await host.run({ action: 'close_session', nativeSessionId: started.nativeSessionId });
}

{
  const { host } = createHarness();
  const started = await host.run({ action: 'start' });
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  const screenshot = await host.run({
    action: 'screenshot',
    nativeSessionId: started.nativeSessionId,
    nativePageId: opened.nativePageId,
    timeoutMs: 100
  });
  assert.ok(screenshot.image.bytes > 0, 'viewport screenshots must use Electron capturePage and return image bytes');
  assert.deepEqual(screenshot.viewport, { width: 1440, height: 900 });
  assert.deepEqual(
    { width: screenshot.image.width, height: screenshot.image.height },
    { width: 1440, height: 900 }
  );
  await host.closeAll();
}

{
  const { host, sessions, views, webContents, childViews, routes, events } = createHarness();
  const started = await host.run({ action: 'start' });
  assert.deepEqual(routes, ['#browser']);
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  assert.equal(
    views[0].options.webPreferences.backgroundThrottling,
    undefined,
    'embedded browser views must not disable background throttling while the dashboard can still be hidden'
  );
  const secondTab = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  await host.setBounds({ visible: true, x: 12, y: 34, width: 900, height: 600 });
  assert.equal(host.getState().visible, true);
  assert.deepEqual(host.getState().viewport, { width: 1440, height: 900 }, 'dashboard surface size must not replace the canonical AI viewport');
  assert.deepEqual(views[1].bounds, { x: 12, y: 52, width: 900, height: 563 }, 'the browser surface should letterbox the canonical viewport inside the dashboard slot');
  assert.equal(childViews.size, 1, 'the active page must be attached to the dashboard native content view');
  assert.equal(host.getState().tabs.length, 2, 'browser state must expose every open tab in the visible session');
  assert.equal(host.getState().nativePageId, secondTab.nativePageId, 'the newest tab should be active after opening');
  await host.selectTab(opened.nativePageId);
  assert.equal(host.getState().nativePageId, opened.nativePageId, 'selecting a tab should swap the attached native view');
  assert.equal(host.getState().tabs.find(tab => tab.nativePageId === opened.nativePageId)?.active, true);
  await host.closeTab(secondTab.nativePageId);
  assert.equal(host.getState().tabs.length, 1, 'closing a tab from the desktop UI should remove it from browser state');
  assert.equal(events.at(-1)?.type, 'page_closed', 'desktop tab close must emit the canonical native page lifecycle event');
  assert.equal(events.at(-1)?.nativePageId, secondTab.nativePageId);

  await host.setControl('user');
  assert.equal(host.getState().control, 'user');
  await assert.rejects(
    () => host.run({ action: 'navigate', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId, url: 'https://example.test/' }),
    error => error?.code === 'BROWSER_USER_CONTROL_ACTIVE'
  );
  await assert.rejects(
    () => host.run({ action: 'close_page', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId }),
    error => error?.code === 'BROWSER_USER_CONTROL_ACTIVE',
    'AI tool calls must not close a page while the user owns the browser session'
  );
  await assert.rejects(
    () => host.run({ action: 'close_session', nativeSessionId: started.nativeSessionId }),
    error => error?.code === 'BROWSER_USER_CONTROL_ACTIVE',
    'AI tool calls must not close a session while the user owns the browser session'
  );
  assert.equal((await host.run({ action: 'describe', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId })).url, 'about:blank');

  const concurrent = await host.run({ action: 'start', viewport: { width: 640, height: 480 } });
  const concurrentPage = await host.run({ action: 'open_page', nativeSessionId: concurrent.nativeSessionId });
  assert.equal(host.getState().sessions.length, 2, 'desktop browser state must expose all concurrent sessions for inspection');
  assert.equal(host.getState().sessions.filter(session => session.active).length, 1);
  await host.run({ action: 'navigate', nativeSessionId: concurrent.nativeSessionId, nativePageId: concurrentPage.nativePageId, url: 'https://background.example.test/' });
  assert.equal(host.getState().nativeSessionId, started.nativeSessionId, 'user takeover must pin the visible browser surface while other AI sessions continue');
  assert.equal(host.getState().control, 'user');
  assert.equal(childViews.size, 1, 'only the user-controlled browser view should remain attached during takeover');

  await host.setControl('ai');
  assert.equal(host.getState().nativeSessionId, concurrent.nativeSessionId, 'returning control should reveal the most recently active AI session');
  await host.selectSession(started.nativeSessionId);
  assert.equal(host.getState().nativeSessionId, started.nativeSessionId, 'the user must be able to choose which concurrent browser session to inspect');
  await host.selectSession(concurrent.nativeSessionId);
  const navigated = await host.run({ action: 'navigate', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId, url: 'https://example.test/' });
  assert.equal(navigated.url, 'https://example.test/');
  assert.deepEqual(
    webContents[0].debuggerCommands.findLast(([method]) => method === 'Emulation.setDeviceMetricsOverride')?.[1],
    { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false, scale: 0.625 },
    'Chromium must keep the requested viewport while scaling only presentation'
  );
  assert.equal(webContents[0].debuggerCommands.findLast(([method]) => method === 'Input.setIgnoreInputEvents')?.[1]?.ignore, true, 'AI ownership must lock native page input after navigation');
  await host.setControl('user');
  assert.equal(webContents[0].debuggerCommands.findLast(([method]) => method === 'Input.setIgnoreInputEvents')?.[1]?.ignore, false, 'user takeover must enable native page input');
  await host.setControl('ai');
  assert.equal(webContents[0].debuggerCommands.findLast(([method]) => method === 'Input.setIgnoreInputEvents')?.[1]?.ignore, true, 'returning control must lock native page input again');

  await host.closeAll();
  assert.equal(host.getState().active, false);
  assert.deepEqual(host.getState().sessions, []);
  assert.equal(childViews.size, 0);
  assert.equal(sessions[0].storageCleared, 1, 'ephemeral browser storage must be cleared on session close');
  assert.equal(sessions[0].cacheCleared, 1, 'ephemeral browser cache must be cleared on session close');
  assert.equal(sessions[1].storageCleared, 1, 'concurrent ephemeral browser storage must also be cleared');
  assert.equal(sessions[1].cacheCleared, 1, 'concurrent ephemeral browser cache must also be cleared');
}

{
  const { host, childViews, routes } = createHarness();
  const started = await host.run({ action: 'start', headless: true, viewport: { width: 800, height: 600 } });
  await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  const state = await host.setBounds({ visible: true, x: 10, y: 20, width: 700, height: 500 });
  assert.deepEqual(routes, ['#browser'], 'all embedded browser sessions must open the visible Browser dashboard');
  assert.equal(Object.hasOwn(started, 'headless'), false, 'the removed headless mode must not remain in the embedded browser contract');
  assert.equal(Object.hasOwn(state, 'headless'), false, 'browser state must not expose a dead headless mode');
  assert.equal(state.visible, true, 'legacy headless input must not suppress the live WebContentsView');
  assert.deepEqual(state.viewport, { width: 800, height: 600 });
  assert.equal(childViews.size, 1);
  const userState = await host.setControl('user');
  assert.equal(userState.control, 'user', 'every embedded browser session must support user takeover');
  await host.setControl('ai');
  await host.closeAll();
}

{
  const { host, views, webContents, events } = createHarness();
  const started = await host.run({ action: 'start' });
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  const handler = webContents[0].windowOpenHandler;
  assert.equal(typeof handler, 'function');
  assert.deepEqual(handler({ url: 'mailto:test@example.com', disposition: 'foreground-tab' }), { action: 'deny' }, 'website-created tabs must reject unsupported URL schemes');

  const foreground = handler({ url: 'https://foreground.example.test/', disposition: 'foreground-tab' });
  assert.equal(foreground.action, 'allow');
  assert.equal(foreground.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
  assert.equal(foreground.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
  assert.equal(foreground.overrideBrowserWindowOptions.webPreferences.sandbox, true);
  const childContents = new FakeWebContents();
  const returnedContents = foreground.createWindow({ webContents: childContents, webPreferences: { nodeIntegration: true, sandbox: false } });
  assert.equal(returnedContents, childContents, 'foreground website tabs must retain Electron child/opener semantics');
  assert.equal(host.getState().tabs.length, 2);
  assert.equal(host.getState().nativePageId, events.at(-1).nativePageId, 'foreground website tabs must become the visible active tab');
  assert.equal(events.at(-1).type, 'page_opened');
  assert.equal(events.at(-1).active, true);

  await host.selectTab(opened.nativePageId);
  const background = handler({ url: 'https://background-tab.example.test/', disposition: 'background-tab' });
  const backgroundContents = background.createWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.getState().tabs.length, 3);
  assert.equal(host.getState().nativePageId, opened.nativePageId, 'background website tabs must not steal the active tab');
  assert.equal(backgroundContents.getURL(), 'https://background-tab.example.test/');
  assert.equal(views.at(-1).options.webPreferences.nodeIntegration, false, 'website-created tabs must enforce the embedded browser security policy');
  assert.equal(views.at(-1).options.webPreferences.contextIsolation, true);
  assert.equal(views.at(-1).options.webPreferences.sandbox, true);
  assert.equal(events.at(-1).type, 'page_opened');
  assert.equal(events.at(-1).active, false);
  await host.closeAll();
}

{
  const { host, webContents } = createHarness();
  const started = await host.run({ action: 'start' });
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  webContents[0].executeJavaScriptError = new Error('download click failed');
  const unhandled = [];
  const onUnhandledRejection = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(
      () => host.run({
        action: 'begin_download',
        nativeSessionId: started.nativeSessionId,
        nativePageId: opened.nativePageId,
        interaction: 'click',
        target: { by: 'text', value: 'Download', exact: true },
        timeoutMs: 1_000
      }),
      /download click failed/
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'a failed download click must not emit a second unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await host.closeAll();
  }
}

{
  const { host, sessions, webContents } = createHarness();
  const started = await host.run({ action: 'start' });
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  let signalInteractionStarted;
  const interactionStarted = new Promise(resolve => { signalInteractionStarted = resolve; });
  webContents[0].onExecuteJavaScript = signalInteractionStarted;
  const downloadPromise = host.run({
    action: 'begin_download',
    nativeSessionId: started.nativeSessionId,
    nativePageId: opened.nativePageId,
    interaction: 'click',
    target: { by: 'text', value: 'Download', exact: true },
    timeoutMs: 1_000
  });
  const cancelledDownload = assert.rejects(
    downloadPromise,
    error => error?.code === 'BROWSER_OPERATION_CANCELLED'
  );
  await interactionStarted;

  const item = new EventEmitter();
  let cancelCount = 0;
  let prevented = false;
  item.getFilename = () => 'report.txt';
  item.setSavePath = value => { item.savePath = value; };
  item.cancel = () => { cancelCount += 1; };
  sessions[0].emit('will-download', { preventDefault: () => { prevented = true; } }, item, webContents[0]);
  assert.equal(prevented, false, 'a tracked download should be accepted');
  assert.ok(item.savePath, 'a tracked download should receive a temporary save path');

  await host.run({ action: 'close_page', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId });
  assert.equal(cancelCount, 1, 'closing a page must cancel a download that already started');
  await cancelledDownload;
  await host.closeAll();
}

console.log('Embedded browser surface lifecycle, attachment, takeover, downloads, and cleanup passed.');
