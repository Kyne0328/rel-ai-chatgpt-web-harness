import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { mock } from 'node:test';
import { configureBrowserNativeBridge } from '../src/browser/browserDriver.ts';
import { createBrowserRuntime } from '../src/browser/browserRuntime.ts';
import * as browserProfiles from '../src/browser/browserProfile.ts';

import { createBrowserSurfaceHost } from '../electron/browser-surface-host.js';
import { goalMessageExists } from '../electron/chatgpt-goal-composer.js';
import { registerBrowserSurfaceIpc } from '../electron/ipc-handlers-dashboard.js';

const branch = {
  current_node: 'latest', mapping: {
    a: { parent: null, message: null },
    old: { parent: 'a', message: { author: { role: 'user' }, content: { parts: ['same prompt'] } } },
    latest: { parent: 'old', message: { author: { role: 'assistant' } } }
  }
};
assert.equal(goalMessageExists(branch, 'same prompt', 'latest'), false,
  'an older identical prompt must not count as a newly accepted message');
assert.equal(goalMessageExists(branch, 'same prompt', 'a'), true,
  'a message on the descendant branch is eligible for readback');
assert.equal(goalMessageExists(branch, 'same prompt', 'unknown'), false,
  'readback must reject branches without the exact claimed parent');

let nextWebContentsId = 100;

class FakeSession extends EventEmitter {
  constructor() {
    super();
    this.storageCleared = 0;
    this.storageClearOptions = [];
    this.cacheCleared = 0;
    this.cookieValues = [];
    this.cookies = { get: async () => this.cookieValues };
    this.authenticated = false;
    this.requests = [];
    this.fetch = async (url, options = {}) => {
      this.requests.push({ url, options });
      if (String(url).includes('/backend-api/f/conversation') && !String(url).includes('/prepare')) {
        return new Response('event: message\ndata: {"ok":true}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const data = String(url).endsWith('/api/auth/session')
        ? this.authenticated ? { user: { id: 'test-account' }, accessToken: 'fixture-only' } : { user: null }
        : { items: [] };
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    this.certificateVerifier = undefined;
  }
  setPermissionRequestHandler(handler) { this.permissionRequestHandler = handler; }
  setPermissionCheckHandler(handler) { this.permissionCheckHandler = handler; }
  setCertificateVerifyProc(handler) { this.certificateVerifier = handler; }
  async clearStorageData(options) { this.storageCleared += 1; this.storageClearOptions.push(options); this.cookieValues = []; this.authenticated = false; }
  async clearCache() { this.cacheCleared += 1; }
  async clearAuthCache() { this.authCacheCleared = (this.authCacheCleared || 0) + 1; }
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
    this.goalBrowserScript = null;
    this.insertedText = '';
    this.goalClickCount = 0;
    this.capturePageHandler = null;
    this.inputEvents = [];
    this.debuggerCommands = [];
    this.debuggerAttached = false;
    this.mainFrame = {
      name: '',
      url: this.url,
      framesInSubtree: [],
      isDestroyed: () => this.destroyed,
      executeJavaScript: (script, userGesture) => this.executeJavaScript(script, userGesture)
    };
    this.mainFrame.framesInSubtree = [this.mainFrame];
    this.debugger = {
      isAttached: () => this.debuggerAttached,
      attach: () => { this.debuggerAttached = true; },
      sendCommand: async (method, params = {}) => {
        this.debuggerCommands.push([method, params]);
        if (method === 'Input.insertText') this.insertedText = params.text;
        if ((method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'Enter')
          || (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased')) {
          this.goalClickCount++;
          this.onGoalClick?.();
        }
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
    this.mainFrame.url = url;
    this.title = 'Loaded';
    this.emit('did-navigate');
    this.emit('did-stop-loading');
  }
  stop() {}
  async executeJavaScript(script) {
    this.onExecuteJavaScript?.();
    if (this.executeJavaScriptError) throw this.executeJavaScriptError;
    if ((String(script).includes('relai-goal-composer') || String(script).includes('relai-goal-stop'))
      && this.goalBrowserScript) return this.goalBrowserScript(script);
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

function createHarness({
  failOpen = false,
  onOpen = async () => {},
  clearPersistentData = async () => ({ cleared: true }),
  listPersistentProfiles = async () => [],
  readPersistentSites = async () => [],
  recordPersistentSite = async () => {},
  flushPersistentSites = async () => {},
  forgetPersistentSite = async () => {},
  goalLoginProfileDirectory = '',
  getGoalConnections = null,
  goalComposerState = 'ready',
  goalRedirectUrl = ''
} = {}) {
  const sessions = [];
  const goalWindows = [];
  class FakeGoalWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.shown = false;
      this.webContents = new FakeWebContents();
      this.webContents.goalBrowserScript = script => {
        if (script.includes('relai-goal-stop')) return { state: this.webContents.goalStopState || 'stop_ready' };
        if (script.includes('if ("probe" ===')) return goalComposerState === 'ready'
          ? { state: 'ready', occupied: false }
          : goalComposerState === 'occupied'
            ? { state: 'ready', occupied: true } : { state: goalComposerState };
        if (script.includes('if ("focus" ===')) return { state: 'focused' };
        if (script.includes('if ("send" ===')) return this.webContents.insertedText
          ? { state: 'send_ready', x: 40, y: 60 } : { state: 'text_mismatch' };
        return { state: 'loading' };
      };
      goalWindows.push(this);
    }
    async loadURL(url) { return this.webContents.loadURL(goalRedirectUrl || url); }
    show() { this.shown = true; }
    close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); this.webContents.close(); }
    isDestroyed() { return this.destroyed; }
  }
  const views = [];
  const webContents = [];
  const HarnessWebContentsView = class extends FakeWebContentsView {
    constructor(options) {
      super(options);
      views.push(this);
      webContents.push(this.webContents);
    }
  };
  const pathSessions = new Map();
  const sessionApi = {
    fromPartition() { const value = new FakeSession(); sessions.push(value); return value; },
    fromPath(profilePath) {
      const key = String(profilePath || '');
      if (!pathSessions.has(key)) { const value = new FakeSession(); pathSessions.set(key, value); sessions.push(value); }
      return pathSessions.get(key);
    }
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
    BrowserWindow: FakeGoalWindow,
    WebContentsView: HarnessWebContentsView,
    session: sessionApi,
    getDashboardWindow: () => dashboard,
    openDashboard: async route => {
      routes.push(route);
      if (failOpen) throw new Error('dashboard unavailable');
      await onOpen(route);
    },
    clearPersistentData,
    listPersistentProfiles,
    readPersistentSites,
    recordPersistentSite,
    flushPersistentSites,
    forgetPersistentSite,
    goalLoginProfileDirectory,
    getGoalConnections,
    onEvent: event => events.push(event)
  });
  return { host, sessions, pathSessions, views, webContents, childViews, routes, sent, events, dashboardInputEvents, goalWindows };
}

{
  const connections = [
    { tunnelId: 'tunnel_accountA12345', label: 'Account A', enabled: true },
    { tunnelId: 'tunnel_accountB12345', label: 'Account B', enabled: true }
  ];
  const { host, pathSessions, goalWindows, events } = createHarness({
    goalLoginProfileDirectory: path.join(os.tmpdir(), 'relai-goal-multiple-account-fixture', 'legacy-profile'),
    getGoalConnections: () => connections
  });
  const initial = await host.getGoalLoginStatus();
  assert.deepEqual(initial.connections.map(item => item.state), ['sign_in_required', 'sign_in_required']);
  const [[directoryA, sessionA], [directoryB, sessionB]] = [...pathSessions];
  assert.notEqual(directoryA, directoryB, 'different tunnels must never share cookies or storage');
  sessionA.authenticated = true;
  const originalFetchA = sessionA.fetch;
  sessionA.fetch = async (url, options) => String(url).endsWith('/api/auth/session')
    ? new Response(JSON.stringify(sessionA.authenticated
      ? { user: { name: 'Fixture A', email: 'a@example.invalid' }, accessToken: 'secret-account-a' } : { user: null }))
    : originalFetchA(url, options);
  assert.equal((await host.getGoalLoginStatus({ tunnelId: connections[0].tunnelId })).account.email, 'a@example.invalid');
  assert.equal((await host.getGoalLoginStatus({ tunnelId: connections[1].tunnelId })).state, 'sign_in_required');
  assert.equal((await host.goalProtocolRequest({ tunnelId: connections[1].tunnelId, path: '/backend-api/conversations' })).status, 401,
    'an unsigned account cannot borrow authentication from another tunnel');
  await assert.rejects(() => host.goalProtocolRequest({ path: '/backend-api/conversations' }), error => error.code === 'GOAL_ACCOUNT_UNAVAILABLE');
  await assert.rejects(() => host.startGoalLogin({ tunnelId: 'tunnel_unknown12345' }), /configured tunnel/);
  await host.startGoalLogin({ tunnelId: connections[0].tunnelId });
  await host.startGoalLogin({ tunnelId: connections[1].tunnelId });
  assert.equal(host.getState().activeSessionCount, 2);
  assert.equal(host.getState().goalTunnelId, connections[1].tunnelId, 'the browser must identify its displayed login account');
  sessionB.authenticated = true;
  assert.equal((await host.getGoalLoginStatus({ tunnelId: connections[1].tunnelId })).state, 'signed_in');
  await host.getGoalLoginStatus({ tunnelId: connections[1].tunnelId });
  assert.deepEqual(events.filter(event => event.resource === 'goal'), [
    { resource: 'goal', type: 'account_signed_in', tunnelId: connections[1].tunnelId }
  ], 'a verified login window must notify Core once, without exposing account identity or tokens');
  let node = 'a';
  let readsB = 0;
  sessionB.fetch = async url => {
    if (String(url).endsWith('/api/auth/session')) return new Response(JSON.stringify({ user: { id: 'fixture-b' }, accessToken: 'secret-account-b' }));
    readsB++;
    return new Response(JSON.stringify({ current_node: node, mapping: {
      a: { parent: null, message: { id: 'assistant-b', author: { role: 'assistant' }, end_turn: true } },
      sent: { parent: 'a', message: { id: 'user-b', author: { role: 'user' }, content: { parts: ['Continue goal account B'] } } }
    } }));
  };
  const readsA = sessionA.requests.length;
  const sendingB = host.goalProtocolRequest({ action: 'continue', tunnelId: connections[1].tunnelId,
    conversationId: 'ca32ef5a-77b0-49f0-983d-b39c12c45ff2', expectedNodeId: 'a', parentMessageId: 'assistant-b', prompt: 'Continue goal account B' });
  goalWindows[0].webContents.onGoalClick = () => { node = 'sent'; };
  assert.equal((await sendingB).accepted, true);
  assert.equal(goalWindows[0].options.webPreferences.session, sessionB);
  assert.equal(sessionA.requests.length, readsA, 'Account B continuation must never read Account A');
  assert.ok(readsB >= 3);
  await host.signOutGoalLogin({ tunnelId: connections[0].tunnelId });
  assert.equal(sessionA.authenticated, false);
  assert.equal((await host.getGoalLoginStatus({ tunnelId: connections[0].tunnelId })).state, 'sign_in_required');
  assert.equal(sessionB.authenticated, true, 'signing out Account A must preserve Account B');
  assert.equal(host.getState().activeSessionCount, 1);
  assert.equal(goalWindows[0].isDestroyed(), false, 'signing out Account A must preserve Account B generation');
  assert.doesNotMatch(JSON.stringify(initial), /secret-account/);
  connections[1].enabled = false;
  await assert.rejects(() => host.goalProtocolRequest({ tunnelId: connections[1].tunnelId, path: '/backend-api/conversations' }), /configured tunnel/);
  assert.equal((await host.getGoalLoginStatus()).connections[1].state, 'disabled');
  await host.closeAll();
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-auth-coordination-fixture');
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { host, pathSessions } = createHarness({ goalLoginProfileDirectory: directory });
  await host.startGoalLogin();
  const goalSession = pathSessions.get(path.resolve(directory));
  goalSession.authenticated = true;
  const pendingStatus = host.getGoalLoginStatus();
  const reads = await Promise.all(Array.from({ length: 4 }, () => host.goalProtocolRequest({
    path: '/backend-api/conversations?offset=0&limit=1' })));
  assert.ok(reads.every(result => result.ok));
  assert.equal((await pendingStatus).state, 'signed_in');
  assert.equal(goalSession.requests.filter(r => r.url.endsWith('/api/auth/session')).length, 1,
    'concurrent goal reads must share authentication without transferring its bearer');
  assert.ok(!JSON.stringify(reads).includes('fixture-only'));
  const originalFetch = goalSession.fetch;
  goalSession.fetch = async url => String(url).includes('/backend-api/')
    ? new Response('private upstream body', { status: 429, headers: { 'retry-after': '180' } })
    : originalFetch(url);
  assert.deepEqual(await host.goalProtocolRequest({ path: '/backend-api/conversations' }),
    { ok: false, status: 429, retryAfterMs: 180_000 });
  assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).deferred, true,
    'the browser bridge must also stop retained-page reads during the account cooldown');
  const requestsBeforeStatus = goalSession.requests.length;
  assert.equal((await host.getGoalLoginStatus()).state, 'unverified');
  assert.equal(goalSession.requests.length, requestsBeforeStatus,
    'automatic sign-in checks must respect the account cooldown');
  await host.signOutGoalLogin();
  mock.timers.tick(180_000);
  assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).status, 401,
    'sign-out must invalidate authentication cached for goal reads');
  await host.closeAll();
  mock.timers.reset();
}

{
  const tunnelId = 'tunnel_refresh12345';
  const { host, pathSessions, events } = createHarness({
    goalLoginProfileDirectory: path.join(os.tmpdir(), 'relai-goal-refresh-fixture'),
    getGoalConnections: () => [{ tunnelId, label: 'Refresh', enabled: true }]
  });
  await host.getGoalLoginStatus({ tunnelId });
  const goalSession = [...pathSessions.values()][0];
  goalSession.authenticated = true;
  assert.equal((await host.getGoalLoginStatus({ tunnelId, refresh: true })).state, 'signed_in');
  assert.deepEqual(events.filter(event => event.resource === 'goal'), [
    { resource: 'goal', type: 'account_signed_in', tunnelId }
  ], 'an explicit verified refresh must resume authentication waits without a login window');
  await host.getGoalLoginStatus({ tunnelId });
  assert.equal(events.filter(event => event.resource === 'goal').length, 1,
    'ordinary cached status inspection must not repeatedly resume goals');
  await host.closeAll();
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-clear-auth-fixture');
  const { host, pathSessions } = createHarness({ goalLoginProfileDirectory: directory });
  await host.getGoalLoginStatus();
  const goalSession = pathSessions.get(path.resolve(directory));
  for (const clear of [() => host.clearSavedData(), () => host.clearSavedSite('https://chatgpt.com')]) {
    goalSession.authenticated = true;
    assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).ok, true);
    await clear();
    assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).status, 401,
      'cleared browser data must not leave a reusable bearer');
  }
  // A request racing Sign out must neither read nor repopulate authentication.
  goalSession.authenticated = true;
  const clearStorage = goalSession.clearStorageData.bind(goalSession);
  let releaseClear;
  let enteredClear;
  const clearing = new Promise(resolve => { enteredClear = resolve; });
  goalSession.clearStorageData = async options => {
    enteredClear();
    await new Promise(resolve => { releaseClear = resolve; });
    return clearStorage(options);
  };
  const signingOut = host.signOutGoalLogin();
  await clearing;
  try {
    assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).status, 401);
  } finally { releaseClear(); await signingOut; }
  assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).status, 401);
  const originalFetch = goalSession.fetch;
  let releaseAuth;
  let enteredAuth;
  const authenticating = new Promise(resolve => { enteredAuth = resolve; });
  goalSession.fetch = async (url, options) => {
    if (!url.endsWith('/api/auth/session')) return originalFetch(url, options);
    enteredAuth();
    await new Promise(resolve => { releaseAuth = resolve; });
    return new Response(JSON.stringify({ user: { id: 'before-clear' }, accessToken: 'obsolete-fixture-token' }));
  };
  const pendingRead = host.goalProtocolRequest({ path: '/backend-api/conversations' });
  await authenticating;
  // Restore normal clearing: the preceding sign-out test held its storage call.
  goalSession.clearStorageData = clearStorage;
  await host.clearSavedData();
  releaseAuth();
  assert.equal((await pendingRead).status, 401, 'a late authentication response must not repopulate a cleared profile');
  goalSession.fetch = originalFetch;
  assert.equal((await host.goalProtocolRequest({ path: '/backend-api/conversations' })).status, 401);
  await host.closeAll();
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-login-fixture');
  const { host, pathSessions } = createHarness({ goalLoginProfileDirectory: directory });
  const other = await host.run({ action: 'start' });
  const first = await host.startGoalLogin();
  assert.equal(first.ok, true);
  assert.equal(first.browserOpen, true);
  assert.equal(host.getState().url, 'https://chatgpt.com/');
  assert.equal(host.getState().control, 'user', 'login must hand control to the user');
  assert.equal(host.getState().activeSessionCount, 2, 'Goal Mode must not reuse a regular browser profile');
  assert.equal((await host.getGoalLoginStatus()).state, 'sign_in_required');
  const goalSession = pathSessions.get(path.resolve(directory));
  assert.ok(goalSession, 'sign-in must use its dedicated persistent profile');
  goalSession.authenticated = true;
  assert.equal((await host.getGoalLoginStatus()).state, 'signed_in');
  const fetched = await host.goalProtocolRequest({ method: 'GET', path: '/backend-api/conversations?offset=0&limit=1' });
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.data.items, []);
  const originalFetch = goalSession.fetch;
  const longPayload = 'x'.repeat(34 * 1024 * 1024);
  goalSession.fetch = async (url, options) => String(url).includes('/backend-api/conversation/')
    ? new Response(JSON.stringify({ current_node: 'a', mapping: {
      a: { parent: null, message: { id: 'a1', author: { role: 'assistant' },
        end_turn: true, status: 'finished_successfully' } } }, private_blob: longPayload }), { status: 200 })
    : originalFetch(url, options);
  const large = await host.goalProtocolRequest({ method: 'GET', projectConversation: true,
    path: '/backend-api/conversation/b5b9731a-8496-4a92-9b44-55d080038c7d' });
  assert.equal(large.data.mapping.a.message.id, 'a1');
  assert.ok(JSON.stringify(large).length < 500, 'native IPC never transfers full conversation history');
  assert.equal(large.data.private_blob, undefined);
  goalSession.fetch = originalFetch;
  assert.equal((await host.goalProtocolRequest({ method: 'POST',
    path: '/backend-api/sentinel/chat-requirements/prepare', body: {} })).ok, true);
  assert.equal((await host.goalProtocolRequest({ method: 'POST',
    path: '/backend-api/sentinel/chat-requirements/finalize', body: { prepare_token: 'fixture-prepare' } })).ok, true);
  await assert.rejects(() => host.goalProtocolRequest({ method: 'POST',
    path: '/backend-api/sentinel/chat-requirements', body: { p: null } }), /Unsupported Goal Mode protocol endpoint/);
  const posted = await host.goalProtocolRequest({ method: 'POST', path: '/backend-api/f/conversation', raw: true,
    body: { conversation_id: 'fixture-id' }, headers: { 'x-conduit-token': 'fixture-conduit' } });
  assert.equal(posted.streamObserved, true, 'accepted streams must be drained without returning chat content or credentials');
  const requested = goalSession.requests.at(-1);
  assert.equal(requested.options.headers.authorization, 'Bearer fixture-only');
  const outside = new AbortController();
  await host.goalProtocolRequest({ method: 'GET', path: '/backend-api/conversations?offset=0&limit=1' },
    { signal: outside.signal });
  const combined = goalSession.requests.at(-1).options.signal;
  assert.notEqual(combined, outside.signal, 'caller cancellation must not replace the request timeout');
  assert.equal(combined.aborted, false);
  outside.abort();
  assert.equal(combined.aborted, true, 'explicit cancellation must still propagate');
  assert.ok(!JSON.stringify(fetched).includes('fixture-only'), 'session credential cannot be returned to the service process');
  await assert.rejects(() => host.goalProtocolRequest({ method: 'GET', path: 'https://unrelated.test/backend-api/conversations' }), /Unsupported Goal Mode protocol endpoint/);
  await assert.rejects(() => host.goalProtocolRequest({ method: 'POST', path: '/backend-api/conversations' }), /Unsupported Goal Mode protocol endpoint/);
  await host.startGoalLogin();
  assert.equal(host.getState().activeSessionCount, 2, 'reopening login must reuse its existing session');
  const signedOut = await host.signOutGoalLogin();
  assert.equal(signedOut.state, 'sign_in_required');
  assert.equal(goalSession.storageCleared, 1, 'sign-out must clear the dedicated account profile');
  assert.equal(host.getState().activeSessionCount, 1, 'sign-out must leave unrelated browser sessions untouched');
  assert.equal((await host.getGoalLoginStatus()).state, 'sign_in_required');
  goalSession.authenticated = true;
  goalSession.cookieValues = [{ name: 'session', value: 'fixture-only', domain: '.chatgpt.com' }];
  assert.ok((await host.listSavedSites()).sites.some(site => site.host === 'chatgpt.com'),
    'dedicated Goal Mode data must appear in saved-site management');
  await host.clearSavedData();
  assert.equal(goalSession.authenticated, false, 'clear all saved browser data must clear Goal Mode login too');
  await host.run({ action: 'close_session', nativeSessionId: other.nativeSessionId });
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-stalled-stop-fixture');
  const { host, pathSessions, goalWindows } = createHarness({ goalLoginProfileDirectory: directory,
    goalRedirectUrl: 'https://chatgpt.com/g/g-p-rel-ai-mcp/c/b5b9731a-8496-4a92-9b44-55d080038c7d' });
  await host.getGoalLoginStatus();
  const goalSession = pathSessions.get(path.resolve(directory));
  const target = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
  let status = 'in_progress';
  let currentNode = 'a';
  let assistantId = 'assistant-stalled';
  let assistantRole = 'assistant';
  goalSession.authenticated = true;
  goalSession.fetch = async url => {
    if (String(url).endsWith('/api/auth/session')) return new Response(JSON.stringify({ user: { id: 'test' }, accessToken: 'fixture-secret' }));
    return new Response(JSON.stringify({ current_node: currentNode,
      mapping: { a: { parent: null, message: { id: assistantId, author: { role: assistantRole },
        end_turn: status === 'interrupted', status } },
      other: { parent: null, message: { id: 'assistant-other', author: { role: 'assistant' },
        end_turn: true, status: 'finished_successfully' } } } }));
  };
  const stopping = host.goalProtocolRequest({ action: 'stop_stalled',
    conversationId: target, expectedNodeId: 'a' });
  goalWindows[0].webContents.onGoalClick = () => {
    status = 'interrupted';
    goalWindows[0].webContents.goalStopState = 'not_running';
  };
  const result = await stopping;
  assert.deepEqual(result, { ok: true, stopped: true });
  assert.equal(goalWindows[0].webContents.goalClickCount, 1, 'Stop was pressed exactly once');
  assert.equal(goalWindows[0].isDestroyed(), true, 'verified stop closes the recovery window');
  const alreadyStopped = await host.goalProtocolRequest({ action: 'stop_stalled',
    conversationId: target, expectedNodeId: 'a' });
  assert.deepEqual(alreadyStopped, { ok: true, alreadyFinished: true });
  assert.equal(goalWindows[1].webContents.goalClickCount, 0, 'an interrupted reply must not require another Stop click');
  assert.equal(goalWindows[1].shown, false);
  currentNode = 'other';
  const stale = await host.goalProtocolRequest({ action: 'stop_stalled',
    conversationId: target, expectedNodeId: 'a' });
  assert.equal(stale.stale, true, 'different branch must not be stopped');
  assert.equal(goalWindows[2].webContents.goalClickCount, 0);
  currentNode = 'a';
  status = 'in_progress';
  const missingStop = host.goalProtocolRequest({ action: 'stop_stalled',
    conversationId: target, expectedNodeId: 'a' });
  goalWindows[3].webContents.goalStopState = 'not_running';
  const failed = await missingStop;
  assert.deepEqual(failed, { ok: false, notSent: true, stage: 'stop_button' });
  assert.equal(goalWindows[3].webContents.goalClickCount, 0, 'a missing Stop button cannot trigger a guessed action');
  assert.equal(goalWindows[3].shown, false, 'failed recovery must stay hidden for automatic retry');
  for (const change of ['branch', 'message', 'role', 'settled']) {
    currentNode = 'a';
    status = 'in_progress';
    assistantId = 'assistant-stalled';
    assistantRole = 'assistant';
    const index = goalWindows.length;
    const attempt = host.goalProtocolRequest({ action: 'stop_stalled',
      conversationId: target, expectedNodeId: 'a' });
    const contents = goalWindows[index].webContents;
    contents.goalBrowserScript = () => {
      if (change === 'branch') currentNode = 'other';
      if (change === 'message') assistantId = 'assistant-replaced';
      if (change === 'role') assistantRole = 'user';
      if (change === 'settled') status = 'interrupted';
      return { state: 'stop_ready' };
    };
    const result = await attempt;
    assert.deepEqual(result, change === 'settled'
      ? { ok: true, alreadyFinished: true } : { ok: false, stale: true },
    'recovery must revalidate ' + change + ' changes while waiting for the Stop control');
    assert.equal(contents.goalClickCount, 0, 'changed identity must not reach native activation');
  }
  await host.closeAll();
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-background-send-fixture');
  const { host, pathSessions, goalWindows, routes } = createHarness({
    goalLoginProfileDirectory: directory, goalComposerState: 'occupied',
    goalRedirectUrl: 'https://chatgpt.com/g/g-p-rel-ai-mcp/c/b5b9731a-8496-4a92-9b44-55d080038c7d'
  });
  await host.getGoalLoginStatus();
  const goalSession = pathSessions.get(path.resolve(directory));
  let currentNode = 'a';
  goalSession.authenticated = true;
  goalSession.fetch = async url => {
    if (String(url).endsWith('/api/auth/session')) {
      return new Response(JSON.stringify({ user: { id: 'test' }, accessToken: 'secret-not-returned' }));
    }
    if (String(url).includes('/backend-api/conversation/')) {
      return new Response(JSON.stringify({
        current_node: currentNode,
        mapping: {
          a: { parent: null, message: { id: 'assistant-1', author: { role: 'assistant' },
            end_turn: true, status: 'finished_successfully' } },
          other: { parent: null, message: { id: 'another', author: { role: 'assistant' },
            end_turn: true, status: 'finished_successfully' } },
          sent: { parent: 'a', message: { author: { role: 'user' },
            content: { parts: [goalWindows.at(-1)?.webContents.insertedText || ''] } } },
          done: { parent: 'sent', message: { author: { role: 'assistant' },
            end_turn: true, status: 'finished_successfully' } }
        }
      }));
    }
    throw new Error('Unexpected Goal Mode network request: ' + new URL(url).pathname);
  };
  const target = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
  // A changed branch fails before any click.
  currentNode = 'other';
  const stale = await host.goalProtocolRequest({ action: 'continue', conversationId: target,
    expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal test' });
  assert.equal(stale.stale, true, JSON.stringify(stale));
  assert.equal(goalWindows[0].webContents.goalClickCount, 0);
  assert.equal(goalWindows[0].webContents.debuggerCommands.filter(([method]) => method === 'Input.insertText').length, 0,
    'stale conversation must not replace saved drafts');
  assert.equal(goalWindows[0].isDestroyed(), true);
  // The accepted message comes from a single native composer click.
  currentNode = 'a';
  const nextWindow = goalWindows.length;
  const sending = host.goalProtocolRequest({ action: 'continue', conversationId: target,
    expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal test' });
  // The hidden window is created synchronously; the test fixture owns the branch.
  goalWindows[nextWindow].webContents.onGoalClick = () => { currentNode = 'sent'; };
  const result = await sending;
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(goalWindows[nextWindow].webContents.goalClickCount, 1);
  assert.deepEqual(goalWindows[nextWindow].webContents.debuggerCommands
    .filter(([method]) => method === 'Input.dispatchKeyEvent').map(([, params]) => [params.type, params.code]),
  [['rawKeyDown', 'KeyA'], ['keyUp', 'KeyA'], ['keyDown', 'Enter'], ['keyUp', 'Enter']],
    'existing composer selection must precede exactly one keyboard Send');
  assert.equal(goalWindows[nextWindow].webContents.insertedText, 'Continue goal test');
  assert.equal(goalWindows[nextWindow].shown, false, 'ordinary continuation must not open a visible browser');
  assert.equal(routes.length, 0, 'background continuation must not open the dashboard');
  assert.equal(host.getState().activeSessionCount, 0, 'temporary page must not appear as a user browser tab');
  assert.equal(goalWindows[nextWindow].options.webPreferences.session, goalSession, 'session must reuse the signed-in Goal Mode profile');
  assert.ok(!JSON.stringify(result).includes('secret-not-returned'));
  const closed = new Promise(resolve => goalWindows[nextWindow].once('closed', resolve));
  currentNode = 'done';
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error(
    'Background ChatGPT page should close after the assistant completes.')), 6500))]);
  assert.equal(goalWindows[nextWindow].isDestroyed(), true);
  await host.closeAll();
}

{
  const target = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
  for (const redirected of ['https://unrelated.test/c/' + target,
    'https://chatgpt.com/g/g-p-other/c/ca32ef5a-77b0-49f0-983d-b39c12c45ff2',
    'https://chatgpt.com/auth/login']) {
    const { host, goalWindows } = createHarness({
      goalLoginProfileDirectory: path.join(os.tmpdir(), 'relai-goal-invalid-redirect-fixture'),
      goalRedirectUrl: redirected
    });
    const result = await host.goalProtocolRequest({ action: 'continue', conversationId: target,
      expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal test' });
    assert.deepEqual(result, { ok: false, notSent: true, stage: 'navigation', reason: 'conversation_unavailable' });
    assert.equal(goalWindows[0].webContents.insertedText, '', 'an unrelated page must not receive a draft');
    assert.equal(goalWindows[0].webContents.goalClickCount, 0);
    assert.equal(goalWindows[0].shown, false);
    assert.equal(goalWindows[0].isDestroyed(), true, 'known unsent navigation failure releases the hidden window');
    await host.closeAll();
  }
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-uncertain-send-fixture');
  const { host, pathSessions, goalWindows } = createHarness({ goalLoginProfileDirectory: directory });
  await host.getGoalLoginStatus();
  const goalSession = pathSessions.get(path.resolve(directory));
  let clicked = false;
  goalSession.fetch = async url => {
    if (String(url).endsWith('/api/auth/session')) {
      return new Response(JSON.stringify({ user: { id: 'test' }, accessToken: 'private' }));
    }
    if (clicked) throw new Error('The network went down after a possible send.');
    return new Response(JSON.stringify({ current_node: 'a', mapping: {
      a: { parent: null, message: { id: 'assistant-1', author: { role: 'assistant' },
        end_turn: true, status: 'finished_successfully' } } } }));
  };
  const target = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
  const sending = host.goalProtocolRequest({ action: 'continue', conversationId: target,
    expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal test' });
  goalWindows[0].webContents.onGoalClick = () => { clicked = true; };
  const result = await sending;
  assert.equal(result.uncertain, true, 'post-click network failure must not become a successful send');
  assert.equal(goalWindows[0].webContents.goalClickCount, 1, 'do not retry a possibly accepted click');
  assert.equal(goalWindows[0].shown, false, 'uncertain send must stay hidden during receipt reconciliation');
  await host.closeAll();
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-quiet-verification-fixture');
  const { host, goalWindows } = createHarness({
    goalLoginProfileDirectory: directory, goalComposerState: 'verification'
  });
  const target = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
  const result = await host.goalProtocolRequest({ action: 'continue', conversationId: target,
    expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal test' });
  assert.equal(result.notSent, true);
  assert.equal(result.stage, 'composer');
  assert.equal(result.reason, 'verification');
  assert.equal(goalWindows[0].shown, false, 'verification must not automatically open a browser');
  assert.equal(goalWindows[0].webContents.goalClickCount, 0, 'verification cannot trigger a send');
  assert.equal(goalWindows[0].isDestroyed(), true, 'known unsent attempts must release their window');
  await host.closeAll();
  assert.equal(goalWindows[0].isDestroyed(), true);
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-preflight-cancel-fixture');
  const { host, pathSessions, goalWindows } = createHarness({ goalLoginProfileDirectory: directory });
  await host.getGoalLoginStatus();
  const controller = new AbortController();
  const goalSession = pathSessions.get(path.resolve(directory));
  let reads = 0;
  goalSession.fetch = async url => {
    if (String(url).endsWith('/api/auth/session')) return new Response(JSON.stringify({ user: { id: 'test' }, accessToken: 'fake' }));
    if (++reads === 2) controller.abort();
    return new Response(JSON.stringify({ current_node: 'a', mapping: {
      a: { parent: null, message: { id: 'assistant-1', author: { role: 'assistant' }, end_turn: true } }
    } }));
  };
  const payload = { action: 'continue', conversationId: 'b5b9731a-8496-4a92-9b44-55d080038c7d',
    expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal cancellation fixture' };
  try {
    const sending = host.goalProtocolRequest(payload, { signal: controller.signal });
    const rejected = assert.rejects(sending, error => error.code === 'BROWSER_OPERATION_CANCELLED');
    assert.deepEqual(await host.goalProtocolRequest(payload), { ok: false, busy: true, notSent: true },
      'concurrent goals must receive a deferrable pre-Send outcome');
    await rejected;
    assert.equal(goalWindows[0].webContents.goalClickCount, 0, 'cancellation during final preflight must veto Send');
    assert.equal(goalWindows[0].shown, false);
    assert.equal(goalWindows[0].isDestroyed(), true);
  } finally { await host.closeAll(); }
}

{
  const directory = path.join(os.tmpdir(), 'relai-goal-large-cleanup-fixture');
  const { host, pathSessions, goalWindows } = createHarness({ goalLoginProfileDirectory: directory });
  await host.getGoalLoginStatus();
  const goalSession = pathSessions.get(path.resolve(directory));
  let currentNode = 'a';
  let large = false;
  goalSession.fetch = async url => {
    if (String(url).endsWith('/api/auth/session')) return new Response(JSON.stringify({ user: { id: 'test' }, accessToken: 'fake' }));
    return new Response(JSON.stringify({ current_node: currentNode, mapping: {
      a: { parent: null, message: { id: 'assistant-1', author: { role: 'assistant' }, end_turn: true } },
      sent: { parent: 'a', message: { id: 'user-2', author: { role: 'user' }, content: { parts: ['Continue goal cleanup fixture'] } } },
      done: { parent: 'sent', message: { id: 'assistant-2', author: { role: 'assistant' }, end_turn: true,
        content: { parts: [large ? 'x'.repeat(33 * 1024 * 1024) : 'Done'] } } }
    } }));
  };
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
  try {
    const sending = host.goalProtocolRequest({ action: 'continue', conversationId: 'b5b9731a-8496-4a92-9b44-55d080038c7d',
      expectedNodeId: 'a', parentMessageId: 'assistant-1', prompt: 'Continue goal cleanup fixture' });
    goalWindows[0].webContents.onGoalClick = () => { currentNode = 'sent'; };
    assert.equal((await sending).accepted, true);
    currentNode = 'done'; large = true;
    mock.timers.tick(5_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(goalWindows[0].isDestroyed(), true, 'completed chats above 32 MiB must close through streaming projection');
    assert.equal(goalWindows[0].shown, false);
  } finally { mock.timers.reset(); await host.closeAll(); }
}

{
  const handlers = new Map();
  const ipc = { handle: (channel, _label, handler) => handlers.set(channel, handler) };
  const channels = {
    DESKTOP_BROWSER_GET_STATE: 'get-state',
    DESKTOP_BROWSER_SET_BOUNDS: 'set-bounds',
    DESKTOP_BROWSER_SET_CONTROL: 'set-control',
    DESKTOP_BROWSER_PERMISSION: 'permission',
    DESKTOP_BROWSER_LIST_SAVED_SITES: 'list-saved-sites',
    DESKTOP_BROWSER_CLEAR_SAVED_SITE: 'clear-saved-site',
    DESKTOP_BROWSER_CLEAR_SAVED_DATA: 'clear-saved-data',
    DESKTOP_BROWSER_SELECT_SESSION: 'select-session',
    DESKTOP_BROWSER_SELECT_TAB: 'select-tab',
    DESKTOP_BROWSER_CLOSE_TAB: 'close-tab',
    DESKTOP_BROWSER_STOP: 'stop',
    DESKTOP_GOAL_LOGIN_START: 'goal-login-start',
    DESKTOP_GOAL_LOGIN_STATUS: 'goal-login-status',
    DESKTOP_GOAL_LOGIN_SIGN_OUT: 'goal-login-sign-out'
  };
  let receivedBounds = null;
  let receivedGoalAccount = null;
  registerBrowserSurfaceIpc({
    ipc,
    channels,
    getBrowserState: () => ({}),
    setBrowserSurfaceBounds: bounds => { receivedBounds = bounds; return bounds; },
    setBrowserControl: () => ({}),
    respondBrowserPermission: () => ({}),
    listSavedBrowserSites: () => ({ sites: [] }),
    clearSavedBrowserSite: origin => ({ origin }),
    clearSavedBrowserData: () => ({}),
    selectBrowserSession: () => ({}),
    selectBrowserTab: () => ({}),
    closeBrowserTab: () => ({}),
    stopActiveBrowserSession: () => ({}),
    startGoalLogin: account => { receivedGoalAccount = account; return { ok: true }; },
    getGoalLoginStatus: account => { receivedGoalAccount = account; return { ok: true }; },
    signOutGoalLogin: () => ({ ok: true })
  });
  handlers.get('set-bounds')({}, { visible: true, x: 12.4, y: 34.6, width: 900.2, height: 600.8 });
  assert.deepEqual(receivedBounds, { visible: true, x: 12, y: 35, width: 900, height: 601 }, 'visible browser bounds must stay visible across the dashboard IPC boundary');
  assert.throws(() => handlers.get('permission')({}, 'bad-id', true), /identifier is invalid/i);
  assert.throws(() => handlers.get('permission')({}, 'browser_permission_abcdefghijklmnop', 'yes'), /must be a boolean/i);
  assert.equal(handlers.get('clear-saved-site')({}, 'https://Example.test/path').origin, 'https://example.test');
  assert.throws(() => handlers.get('clear-saved-site')({}, 'file:///tmp/browser'), /absolute HTTP or HTTPS origin/i);
  handlers.get('goal-login-start')({}, { tunnelId: 'tunnel_accountA12345' });
  assert.deepEqual(receivedGoalAccount, { tunnelId: 'tunnel_accountA12345' });
  handlers.get('goal-login-status')({}, { tunnelId: 'tunnel_accountA12345', refresh: true });
  assert.deepEqual(receivedGoalAccount, { tunnelId: 'tunnel_accountA12345', refresh: true });
  assert.throws(() => handlers.get('goal-login-start')({}, { tunnelId: 'tunnel_accountA12345', refresh: true }), /configured ChatGPT tunnel/);
  assert.throws(() => handlers.get('goal-login-start')({}, { tunnelId: '../other-profile' }), /configured ChatGPT tunnel/);
  assert.throws(() => handlers.get('goal-login-status')({}, { tunnelId: 'tunnel_accountA12345', profileDirectory: '/private' }), /configured ChatGPT tunnel/);
}

{
  const { host } = createHarness({ failOpen: true });
  await assert.rejects(() => host.run({ action: 'start' }), /dashboard unavailable/);
  assert.equal(host.getState().active, false, 'a failed dashboard handoff must not leave a hidden native browser session active');
}

{
  const { host, sessions, webContents, routes } = createHarness();
  const started = await host.run({ action: 'start' });
  await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  let decision = null;
  sessions[0].permissionRequestHandler(
    webContents[0],
    'geolocation',
    allowed => { decision = allowed; },
    { requestingUrl: 'https://example.test/login' }
  );
  const request = host.getState().permissionRequests[0];
  assert.equal(decision, null, 'site permission requests must wait for an explicit user decision');
  assert.equal(request.permission, 'geolocation');
  assert.equal(request.origin, 'https://example.test');
  assert.equal(routes.at(-1), '#browser', 'permission requests must bring the Browser surface forward for the user');
  await host.respondPermission(request.requestId, true);
  assert.equal(decision, true, 'allowing a site permission must release the pending Chromium permission request');
  assert.equal(sessions[0].permissionCheckHandler(webContents[0], 'geolocation', 'https://example.test'), true, 'an approved permission must remain granted for the current browser session');
  assert.equal(sessions[0].permissionCheckHandler(null, 'geolocation', 'https://example.test'), true, 'permission checks without a webContents must still honor the session-scoped origin grant');
  assert.equal(sessions[0].permissionCheckHandler({ id: 999 }, 'geolocation', 'https://example.test'), true, 'the grant must apply to another tab in the same browser session');
  assert.equal(sessions[0].permissionCheckHandler({ id: 999 }, 'notifications', 'https://example.test'), false, 'a session grant must not authorize a different permission');
  assert.equal(sessions[0].permissionCheckHandler({ id: 999 }, 'geolocation', 'https://other.test'), false, 'a session grant must not authorize a different origin');
  assert.deepEqual(host.getState().permissionRequests, []);
  await host.closeAll();
}

{
  const { host, sessions, webContents } = createHarness();
  try {
    const foreground = await host.run({ action: 'start' });
    await host.run({ action: 'open_page', nativeSessionId: foreground.nativeSessionId });
    await host.setControl('user');
    const background = await host.run({ action: 'start' });
    await host.run({ action: 'open_page', nativeSessionId: background.nativeSessionId });
    const decisions = [];
    sessions[1].permissionRequestHandler(webContents[1], 'geolocation', allowed => decisions.push(['location', allowed]), { requestingUrl: 'https://same.fixture.invalid/' });
    sessions[1].permissionRequestHandler(webContents[1], 'notifications', allowed => decisions.push(['notifications', allowed]), { requestingUrl: 'https://same.fixture.invalid/' });
    const state = host.getState();
    assert.equal(state.nativeSessionId, foreground.nativeSessionId, 'background permission must not steal the pinned view');
    assert.equal(state.control, 'user');
    assert.equal(state.permissionRequests.length, 2, 'all pending background permissions must be actionable');
    assert.ok(state.permissionRequests.every(request => request.nativeSessionId === background.nativeSessionId), 'permission prompts must retain unambiguous session identity');
    const location = state.permissionRequests.find(request => request.permission === 'geolocation');
    const notifications = state.permissionRequests.find(request => request.permission === 'notifications');
    host.respondPermission(location.requestId, false);
    assert.deepEqual(decisions, [['location', false]]);
    assert.equal(host.getState().permissionRequests.length, 1, 'denial must remove only its own pending request');
    host.respondPermission(notifications.requestId, true);
    assert.deepEqual(decisions, [['location', false], ['notifications', true]]);
    assert.equal(sessions[1].permissionCheckHandler(webContents[1], 'notifications', 'https://same.fixture.invalid'), true);
    assert.equal(sessions[0].permissionCheckHandler(webContents[0], 'notifications', 'https://same.fixture.invalid'), false, 'permission response must not grant another session');
    assert.equal(host.getState().nativeSessionId, foreground.nativeSessionId);
    assert.equal(host.getState().control, 'user');
  } finally { await host.closeAll(); }
}

{
  let clearCalls = 0;
  const { host } = createHarness({ clearPersistentData: async () => { clearCalls += 1; return { cleared: true }; } });
  assert.equal((await host.clearSavedData()).cleared, true);
  assert.equal(clearCalls, 1, 'saved browser data clearing must delegate to the persistent profile owner');
  const persistent = await host.run({ action: 'start', profileDirectory: 'C:/relai-test-profile' });
  await assert.rejects(() => host.clearSavedData(), /Stop persistent browser sessions/i);
  assert.equal(clearCalls, 1, 'saved data must not be deleted while its persistent session is active');
  await host.run({ action: 'close_session', nativeSessionId: persistent.nativeSessionId });
}

{
  const profileDirectory = 'C:/relai-saved-profile/default';
  const forgotten = [];
  const recorded = [];
  const { host, pathSessions, webContents } = createHarness({
    listPersistentProfiles: async () => [profileDirectory],
    readPersistentSites: async () => ['https://example.test', 'https://storage.test'],
    recordPersistentSite: async (directory, url) => recorded.push([directory, url]),
    forgetPersistentSite: async (directory, origin) => forgotten.push([directory, origin])
  });
  const initial = await host.listSavedSites();
  assert.deepEqual(initial.sites.map(site => site.origin), ['https://example.test', 'https://storage.test']);
  const savedSession = [...pathSessions.values()][0];
  savedSession.cookieValues = [
    { domain: '.example.test', secure: false },
    { domain: '.cookie-only.test', secure: true }
  ];
  const withCookies = await host.listSavedSites();
  assert.ok(withCookies.sites.some(site => site.origin === 'https://cookie-only.test'), 'cookie-only legacy profiles must remain discoverable before the site registry has seen them');
  assert.equal(withCookies.sites.filter(site => site.host === 'example.test').length, 1, 'registered HTTPS origins must not be duplicated by non-secure cookies for the same host');
  const cleared = await host.clearSavedSite('https://example.test');
  assert.equal(cleared.origin, 'https://example.test');
  assert.deepEqual(savedSession.storageClearOptions.at(-1), { origin: 'https://example.test' }, 'per-site deletion must clear complete Chromium origin storage');
  assert.deepEqual(forgotten.at(-1), [path.resolve(profileDirectory), 'https://example.test']);

  const persistent = await host.run({ action: 'start', profileDirectory });
  const page = await host.run({ action: 'open_page', nativeSessionId: persistent.nativeSessionId });
  await webContents.at(-1).loadURL('https://remembered.test/login');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(recorded.some(([, url]) => url === 'https://remembered.test/login'), 'persistent navigation must register the site for later per-site management');
  await assert.rejects(() => host.clearSavedSite('https://storage.test'), /Stop persistent browser sessions/i);
  await host.run({ action: 'close_session', nativeSessionId: persistent.nativeSessionId });
  assert.ok(page.nativePageId);
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
  const { host, webContents } = createHarness();
  const started = await host.run({ action: 'start' });
  const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
  let frameInteraction = '';
  const childFrame = {
    name: 'signin-frame',
    url: 'https://example.test/frame',
    isDestroyed: () => false,
    executeJavaScript: async script => {
      const source = String(script);
      if (source.includes('return { attached:')) return { attached: true, visible: true };
      frameInteraction = source;
      return true;
    }
  };
  webContents[0].mainFrame.framesInSubtree.push(childFrame);
  const described = await host.run({ action: 'describe', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId });
  assert.deepEqual(described.frames, [{ index: 0, name: 'signin-frame', url: 'https://example.test/frame' }]);
  await host.run({
    action: 'interact',
    nativeSessionId: started.nativeSessionId,
    nativePageId: opened.nativePageId,
    interaction: 'fill',
    target: { by: 'label', value: 'Account', frame: { by: 'name', value: 'signin-frame', exact: true } },
    input: 'user@example.test'
  });
  assert.match(frameInteraction, /user@example\.test/, 'embedded structured interaction must execute in the selected child frame');
  await host.closeAll();
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
  webContents[0].emit('blur');
  assert.equal(host.getState().control, 'ai', 'clicking away or Alt+Tab from the active user-controlled browser page must immediately return control to AI');
  await host.setControl('user');
  await host.setControl('ai');
  assert.equal(webContents[0].debuggerCommands.findLast(([method]) => method === 'Input.setIgnoreInputEvents')?.[1]?.ignore, true, 'returning control must lock native page input again');

  for (const reason of ['sign_in', 'mfa', 'captcha', 'user_input']) {
    await host.run({ action: 'set_control', nativeSessionId: started.nativeSessionId, owner: 'user', reason });
    webContents[0].emit('blur');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.getState().control, 'user', `${reason} handoff must survive Alt+Tab or clicking away`);
    assert.equal(host.getState().handoffReason, reason, 'handoff reason must remain visible until explicit completion');
    assert.equal(webContents[0].debuggerCommands.findLast(([method]) => method === 'Input.setIgnoreInputEvents')?.[1]?.ignore, false, 'pending handoff must leave native page input enabled');
    await assert.rejects(
      () => host.run({ action: 'navigate', nativeSessionId: started.nativeSessionId, nativePageId: opened.nativePageId, url: 'https://example.test/' }),
      error => error?.code === 'BROWSER_USER_CONTROL_ACTIVE'
    );
    await host.run({ action: 'set_control', nativeSessionId: started.nativeSessionId, owner: 'ai' });
    assert.equal(host.getState().control, 'ai', 'explicit completion or cancellation must resume agent control');
    assert.equal(host.getState().handoffReason, '');
  }

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

{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-profile-clear-'));
  const previousStateDir = process.env.REL_AI_MCP_STATE_DIR;
  process.env.REL_AI_MCP_STATE_DIR = temporary;
  const pendingSiteWrites = [];
  const { host, pathSessions, webContents } = createHarness({
    recordPersistentSite: (directory, url) => {
      const pending = browserProfiles.recordPersistentBrowserSite(directory, url);
      pendingSiteWrites.push(pending);
      return pending;
    },
    flushPersistentSites: directory => browserProfiles.waitPersistentBrowserSiteWrites
      ? browserProfiles.waitPersistentBrowserSiteWrites(directory)
      : Promise.all(pendingSiteWrites)
  });
  const runtime = createBrowserRuntime({ getProfileConfig: () => ({ stateDir: temporary }) });
  const workspace = { alias: 'fixture' };
  const context = { principal: { clientId: 'native-profile-fixture', subject: 'fixture', authMode: 'test' } };
  configureBrowserNativeBridge(payload => host.run(payload));
  let releaseClear = () => {};
  let releaseWrite = () => {};
  let beginWrite = () => {};
  let holdWrite = false;
  let writes = 0;
  const writeStarted = new Promise(resolve => { beginWrite = resolve; });
  const writeBarrier = new Promise(resolve => { releaseWrite = resolve; });
  const originalWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async (file, ...args) => {
    if (String(file).startsWith(temporary) && String(file).includes('.relai-sites.json.tmp-')) {
      writes += 1;
      if (holdWrite) { beginWrite(); await writeBarrier; }
    }
    return originalWriteFile(file, ...args);
  };
  try {
    const first = await runtime.start(workspace, { url: 'https://initial.fixture.invalid/' }, context);
    await Promise.all(pendingSiteWrites);
    assert.equal(writes, 1, 'native navigation must have one registry writer, not both host and utility');
    await Promise.all([
      webContents[0].loadURL('https://one.fixture.invalid/'),
      webContents[0].loadURL('https://two.fixture.invalid/')
    ]);
    await Promise.all(pendingSiteWrites);
    const recordedSites = await browserProfiles.readPersistentBrowserSites([...pathSessions.keys()][0]);
    assert.ok(recordedSites.includes('https://one.fixture.invalid'));
    assert.ok(recordedSites.includes('https://two.fixture.invalid'), 'concurrent native origins must both survive canonical serialization');
    const cachedSession = [...pathSessions.values()][0];
    cachedSession.cookieValues = [{ name: 'fixture', value: 'synthetic', domain: 'fixture.invalid' }];
    holdWrite = true;
    await webContents[0].loadURL('https://pending.fixture.invalid/');
    await writeStarted;
    await runtime.stop(workspace, { sessionId: first.sessionId }, context);
    assert.equal(cachedSession.storageCleared, 0, 'ordinary persistent close must retain saved site data');
    let clearStarted = false;
    let beginClear = () => {};
    const clearStartedPromise = new Promise(resolve => { beginClear = resolve; });
    const clearBarrier = new Promise(resolve => { releaseClear = resolve; });
    const clearStorage = cachedSession.clearStorageData.bind(cachedSession);
    cachedSession.clearStorageData = async () => { clearStarted = true; beginClear(); await clearBarrier; await clearStorage(); };
    const clearing = runtime.clearProfile(workspace, {}, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clearStarted, false, 'native clear must wait for the host-owned pending registry write');
    await assert.rejects(() => runtime.start(workspace, {}, context), error => error?.code === 'BROWSER_PROFILE_ALREADY_ACTIVE', 'profile clear must reserve ownership against concurrent start');
    holdWrite = false;
    releaseWrite();
    await clearStartedPromise;
    assert.equal(clearStarted, true, 'clear_profile must cross the native bridge and clear the cached Electron Session');
    releaseClear();
    assert.equal((await clearing).cleared, true);
    assert.equal(fs.existsSync([...pathSessions.keys()][0]), false, 'late host registry work must not recreate cleared metadata');
    assert.deepEqual(cachedSession.cookieValues, []);
    assert.equal(cachedSession.cacheCleared, 1);
    assert.equal(cachedSession.authCacheCleared, 1);
    const reopened = await runtime.start(workspace, {}, context);
    assert.equal([...pathSessions.values()][0], cachedSession, 'the test must actually reuse the same native Session');
    await runtime.stop(workspace, { sessionId: reopened.sessionId }, context);
    cachedSession.clearStorageData = async () => { throw new Error('fixture storage clear failed'); };
    await assert.rejects(() => runtime.clearProfile(workspace, {}, context), /fixture storage clear failed/);
    assert.equal(fs.existsSync([...pathSessions.keys()][0]), true, 'native clear failure must prevent filesystem deletion');
    const afterFailure = await runtime.start(workspace, {}, context);
    assert.ok(afterFailure.sessionId, 'failed profile clear must release its reservation');
    await runtime.stop(workspace, { sessionId: afterFailure.sessionId }, context);
    const profileDirectory = [...pathSessions.keys()][0];
    const backupDirectory = `${profileDirectory}-fixture-backup`;
    const unrelatedDirectory = path.join(temporary, 'unrelated-fixture-profile');
    fs.mkdirSync(unrelatedDirectory, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDirectory, 'sentinel.txt'), 'fixture data');
    fs.renameSync(profileDirectory, backupDirectory);
    let nativeClearCalls = 0;
    cachedSession.clearStorageData = async () => { nativeClearCalls += 1; };
    try {
      fs.symlinkSync(unrelatedDirectory, profileDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => runtime.clearProfile(workspace, {}, context), /symbolic-link browser profile/);
      assert.equal(nativeClearCalls, 0, 'unsafe profile paths must be rejected before any native data clear');
      assert.equal(fs.readFileSync(path.join(unrelatedDirectory, 'sentinel.txt'), 'utf8'), 'fixture data');
    } finally {
      fs.rmSync(profileDirectory, { recursive: true, force: true });
      fs.renameSync(backupDirectory, profileDirectory);
    }
  } finally {
    releaseWrite();
    releaseClear();
    fs.promises.writeFile = originalWriteFile;
    await runtime.shutdown();
    configureBrowserNativeBridge(null);
    await host.closeAll();
    if (previousStateDir === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
    else process.env.REL_AI_MCP_STATE_DIR = previousStateDir;
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}


{
  const profileDirectory = path.resolve(os.tmpdir(), `relai-native-clear-custody-${process.pid}`);
  const { host, pathSessions } = createHarness();
  let releaseClear = () => {};
  let clearing;
  try {
    const original = await host.run({ action: 'start', profileDirectory });
    await host.run({ action: 'close_session', nativeSessionId: original.nativeSessionId });
    const cached = [...pathSessions.values()][0];
    let beginClear;
    const clearStarted = new Promise(resolve => { beginClear = resolve; });
    const clearBarrier = new Promise(resolve => { releaseClear = resolve; });
    cached.clearStorageData = async () => { beginClear(); await clearBarrier; };
    const caller = new AbortController();
    clearing = host.run({ action: 'clear_profile', profileDirectory }, { signal: caller.signal });
    await clearStarted;
    caller.abort(new Error('fixture caller timed out'));
    const equivalentPath = process.platform === 'win32' ? profileDirectory.toUpperCase() : profileDirectory;
    await assert.rejects(() => host.run({ action: 'start', profileDirectory: equivalentPath }), error => error?.code === 'BROWSER_PROFILE_ALREADY_ACTIVE', 'lost IPC caller must not release the host-owned noncancellable clear');
    releaseClear();
    await clearing;
    const recovered = await host.run({ action: 'start', profileDirectory });
    await host.run({ action: 'close_session', nativeSessionId: recovered.nativeSessionId });
    cached.clearStorageData = async () => { throw new Error('fixture native clear failed'); };
    await assert.rejects(() => host.run({ action: 'clear_profile', profileDirectory }), /fixture native clear failed/);
    const afterFailure = await host.run({ action: 'start', profileDirectory });
    assert.ok(afterFailure.nativeSessionId, 'failed native clear must release its own reservation');
  } finally {
    releaseClear();
    await clearing?.catch(() => {});
    await host.closeAll();
  }
}

for (const scope of ['all', 'site']) {
  const profileDirectory = path.resolve(os.tmpdir(), `relai-saved-data-custody-${process.pid}-${scope}`);
  let diskClears = 0;
  let forgotten = 0;
  const { host, pathSessions } = createHarness({
    listPersistentProfiles: async () => [profileDirectory],
    clearPersistentData: async () => { diskClears += 1; return { cleared: true }; },
    forgetPersistentSite: async () => { forgotten += 1; }
  });
  let releaseClear = () => {};
  let clearing;
  try {
    await host.listSavedSites();
    const cached = [...pathSessions.values()][0];
    let beginClear;
    const started = new Promise(resolve => { beginClear = resolve; });
    const barrier = new Promise(resolve => { releaseClear = resolve; });
    cached.clearStorageData = async () => { beginClear(); await barrier; };
    const clear = () => scope === 'all' ? host.clearSavedData() : host.clearSavedSite('https://saved.fixture.invalid');
    clearing = clear();
    await started;
    await assert.rejects(() => host.run({ action: 'start', profileDirectory: `${profileDirectory}-new` }), error => error?.code === 'BROWSER_PROFILE_ALREADY_ACTIVE', 'whole-store clear must guard new persistent profiles too');
    await assert.rejects(() => host.run({ action: 'clear_profile', profileDirectory }), error => error?.code === 'BROWSER_PROFILE_ALREADY_ACTIVE');
    releaseClear();
    await clearing;
    const previousDiskClears = diskClears;
    const previousForgotten = forgotten;
    cached.clearStorageData = async () => { throw new Error('fixture native clearing failed'); };
    await assert.rejects(clear, /Some site data may already have been cleared.*fixture native clearing failed/);
    assert.equal(diskClears, previousDiskClears, 'native failure must prevent deletion of saved profile files');
    assert.equal(forgotten, previousForgotten, 'native failure must not forget the affected site registry');
    const recovered = await host.run({ action: 'start', profileDirectory });
    assert.ok(recovered.nativeSessionId, 'a failed whole-store clear must release its guard');
  } finally {
    releaseClear();
    await clearing?.catch(() => {});
    await host.closeAll();
  }
}


{
  let beginOpen;
  let releaseOpen;
  const opening = new Promise(resolve => { beginOpen = resolve; });
  const barrier = new Promise(resolve => { releaseOpen = resolve; });
  const { host } = createHarness({ onOpen: async () => { beginOpen(); await barrier; } });
  const started = host.run({ action: 'start' });
  const rejected = assert.rejects(started, error => error?.code === 'BROWSER_OPERATION_CANCELLED');
  await opening;
  await host.closeAll();
  releaseOpen();
  await rejected;
  assert.equal(host.getState().activeSessionCount, 0, 'startup must not publish a session removed during dashboard opening');
}

{
  const { host, sessions } = createHarness();
  await host.run({ action: 'start' });
  let beginClear;
  let releaseClear;
  const clearing = new Promise(resolve => { beginClear = resolve; });
  const barrier = new Promise(resolve => { releaseClear = resolve; });
  sessions[0].clearStorageData = async () => { beginClear(); await barrier; };
  const closing = host.closeAll();
  await clearing;
  assert.equal(host.closeAll(), closing, 'concurrent shutdown calls must share one cleanup owner');
  await assert.rejects(() => host.run({ action: 'start' }), error => error?.code === 'BROWSER_OPERATION_CANCELLED');
  releaseClear();
  await closing;
  assert.ok((await host.run({ action: 'start' })).nativeSessionId, 'startup must recover after cleanup settles');
  await host.closeAll();
}

for (const transition of ['user-control', 'close']) {
  const { host, webContents } = createHarness();
  const session = await host.run({ action: 'start' });
  const page = await host.run({ action: 'open_page', nativeSessionId: session.nativeSessionId });
  let beginWait;
  let releaseWait;
  const waiting = new Promise(resolve => { beginWait = resolve; });
  const barrier = new Promise(resolve => { releaseWait = resolve; });
  let mutations = 0;
  webContents[0].executeJavaScript = async script => {
    if (String(script).includes('return { attached:')) {
      beginWait();
      await barrier;
      return { attached: true, visible: true };
    }
    mutations += 1;
    return true;
  };
  const operation = host.run({
    action: 'interact', interaction: 'click', target: { by: 'testid', value: 'synthetic-control' },
    nativeSessionId: session.nativeSessionId, nativePageId: page.nativePageId
  });
  const rejected = assert.rejects(operation, error => ['BROWSER_USER_CONTROL_ACTIVE', 'BROWSER_OPERATION_CANCELLED'].includes(error?.code));
  await waiting;
  if (transition === 'user-control') await host.setControl('user');
  else await host.closeAll();
  releaseWait();
  await rejected;
  assert.equal(mutations, 0, 'retired or user-owned fake pages must not receive queued mutations');
  await host.closeAll();
}



for (const scope of ['page', 'session']) {
  const { host, webContents } = createHarness();
  const session = await host.run({ action: 'start' });
  const page = await host.run({ action: 'open_page', nativeSessionId: session.nativeSessionId });
  const wc = webContents[0];
  const close = wc.close.bind(wc);
  let failed = false;
  wc.close = () => {
    if (!failed) { failed = true; throw new Error('fixture native close failed'); }
    close();
  };
  const request = scope === 'page'
    ? { action: 'close_page', nativeSessionId: session.nativeSessionId, nativePageId: page.nativePageId }
    : { action: 'close_session', nativeSessionId: session.nativeSessionId };
  await assert.rejects(() => host.run(request), /fixture native close failed/);
  assert.equal(host.getState().activeSessionCount, 1, 'a failed native close must retain session ownership');
  assert.equal(host.getState().pageCount, 1, 'a failed native close must retain the page for retry');
  assert.equal(wc.isDestroyed(), false);
  await host.run(request);
  assert.equal(wc.isDestroyed(), true, 'retry must perform actual teardown rather than report an absent handle');
  assert.equal(host.getState().pageCount, 0);
  await host.closeAll();
}

{
  const { host, webContents } = createHarness();
  const session = await host.run({ action: 'start' });
  const page = await host.run({ action: 'open_page', nativeSessionId: session.nativeSessionId });
  const wc = webContents[0];
  const destroy = wc.destroy.bind(wc);
  const close = wc.close.bind(wc);
  wc.close = () => {};
  wc.destroy = () => { throw new Error('fixture native destroy failed'); };
  await assert.rejects(() => host.run({ action: 'close_page', nativeSessionId: session.nativeSessionId, nativePageId: page.nativePageId }), /fixture native destroy failed/);
  assert.equal(host.getState().pageCount, 1);
  wc.close = close;
  wc.destroy = destroy;
  await host.closeAll();
  assert.equal(wc.isDestroyed(), true);
}

{
  const { mock } = await import('node:test');
  const { host, webContents } = createHarness();
  const session = await host.run({ action: 'start' });
  await host.run({ action: 'open_page', nativeSessionId: session.nativeSessionId });
  const wc = webContents[0];
  const close = wc.close.bind(wc);
  wc.close = () => {};
  wc.destroy = () => {};
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const result = host.run({ action: 'close_session', nativeSessionId: session.nativeSessionId });
    const rejected = assert.rejects(result, /termination could not be confirmed/);
    await new Promise(resolve => setImmediate(resolve));
    mock.timers.tick(5000);
    await rejected;
    assert.equal(host.getState().activeSessionCount, 1, 'a teardown timeout must preserve retryable ownership');
    assert.equal(host.getState().pageCount, 1);
    wc.close = close;
    await host.closeAll();
    assert.equal(wc.isDestroyed(), true);
  } finally {
    mock.timers.reset();
  }
}

{
  const { host, webContents } = createHarness();
  const session = await host.run({ action: 'start' });
  await host.run({ action: 'open_page', nativeSessionId: session.nativeSessionId });
  const wc = webContents[0];
  let closeCalls = 0;
  wc.close = () => { closeCalls += 1; };
  wc.destroy = () => {};
  const request = { action: 'close_session', nativeSessionId: session.nativeSessionId };
  const first = host.run(request);
  const second = host.run(request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeCalls, 1, 'concurrent closes must share the same native teardown attempt');
  assert.equal(host.getState().activeSessionCount, 1, 'ownership persists until the destroyed event');
  await assert.rejects(() => host.run({ action: 'open_page', nativeSessionId: session.nativeSessionId }), error => error?.code === 'BROWSER_OPERATION_CANCELLED');
  assert.equal(wc.windowOpenHandler({ url: 'https://synthetic.fixture.invalid/' }).action, 'deny', 'closing sessions cannot register late popup pages');
  wc.destroyed = true;
  wc.emit('destroyed');
  await Promise.all([first, second]);
  assert.equal(host.getState().activeSessionCount, 0);
}

{
  const { host, webContents } = createHarness();
  const first = await host.run({ action: 'start' });
  await host.run({ action: 'open_page', nativeSessionId: first.nativeSessionId });
  await host.run({ action: 'open_page', nativeSessionId: first.nativeSessionId });
  const other = await host.run({ action: 'start' });
  await host.run({ action: 'open_page', nativeSessionId: other.nativeSessionId });
  const failedPage = webContents[1];
  const close = failedPage.close.bind(failedPage);
  failedPage.close = () => { throw new Error('fixture partial page close failed'); };
  await assert.rejects(() => host.closeAll(), /Some embedded browser sessions could not be closed/);
  assert.equal(webContents[0].isDestroyed(), true);
  assert.equal(webContents[2].isDestroyed(), true, 'one failed session must not prevent cleanup of other sessions');
  assert.equal(failedPage.isDestroyed(), false);
  assert.equal(host.getState().activeSessionCount, 1);
  assert.equal(host.getState().pageCount, 1, 'partial teardown must keep only the resource still needing cleanup');
  failedPage.close = close;
  await host.closeAll();
  assert.equal(failedPage.isDestroyed(), true);
  assert.equal(host.getState().activeSessionCount, 0);
}


console.log('Embedded browser surface lifecycle, attachment, takeover, downloads, and cleanup passed.');
