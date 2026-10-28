import assert from 'node:assert/strict';

const originalDocument = globalThis.document;
const originalEventSource = globalThis.EventSource;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
const originalCustomEvent = globalThis.CustomEvent;

const visibilityListeners = new Set();
const documentStub = {
  visibilityState: 'visible',
  addEventListener(name, listener) {
    if (name === 'visibilitychange') visibilityListeners.add(listener);
  },
  removeEventListener(name, listener) {
    if (name === 'visibilitychange') visibilityListeners.delete(listener);
  }
};

const sources = [];
class FakeEventSource {
  static OPEN = 1;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
    sources.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }
}

try {
  globalThis.document = documentStub;
  globalThis.EventSource = FakeEventSource;
  globalThis.window = {
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null }
  };

  const events = await import(`../src/ui/events.js?visibility-test=${Date.now()}`);
  const connectionStates = [];
  events.initEvents(() => {}, state => connectionStates.push(state.state));
  events.startSSE();

  assert.equal(sources.length, 1, 'visible dashboards should open one live event stream');
  assert.equal(sources[0].url, '/events');
  assert.equal(sources[0].options.withCredentials, true);

  documentStub.visibilityState = 'hidden';
  for (const listener of visibilityListeners) listener();
  assert.equal(sources[0].closed, false, 'hiding the dashboard must keep the lightweight live event stream connected');

  events.startSSE();
  assert.equal(sources.length, 1, 'hidden dashboards must not duplicate the existing live event stream');

  documentStub.visibilityState = 'visible';
  for (const listener of visibilityListeners) listener();
  assert.equal(sources[0].closed, true, 'showing the dashboard must retire the possibly suspended live stream');
  assert.equal(sources.length, 2, 'showing the dashboard must re-handshake live revisions so missed list updates can be detected');
  assert.equal(sources[1].closed, false);
  assert.deepEqual(connectionStates, ['connecting'],
    'visibility-driven SSE re-handshakes must stay silent instead of reporting a false reconnect');

  events.stopSSE({ emit: false });
  assert.equal(sources[1].closed, true, 'stopping dashboard events must close the resumed live stream');

  documentStub.visibilityState = 'hidden';
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const api = await import(`../src/ui/api.js?visibility-timeout-test=${Date.now()}`);
  let requestSettled = false;
  const hiddenRequest = api.fetchJson('/slow-dashboard-request', { timeout: 80 }).then(result => {
    requestSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(requestSettled, false,
    'time spent minimized must not consume the dashboard request timeout budget');

  documentStub.visibilityState = 'visible';
  for (const listener of [...visibilityListeners]) listener();
  const timedOut = await hiddenRequest;
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.errorCode, 'dashboard_unavailable');
  assert.match(timedOut.error, /timed out/i,
    'a request that remains stalled after restore must still honor its foreground timeout');

  documentStub.visibilityState = 'hidden';
  let backgroundRequestSettled = false;
  const boundedBackgroundRequest = api.fetchJson('/slow-activity-history', {
    timeout: 80,
    pauseTimeoutWhenHidden: false
  }).then(result => {
    backgroundRequestSettled = true;
    return result;
  });
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(backgroundRequestSettled, true,
    'background-bounded requests must not remain suspended until the dashboard is reopened');
  const backgroundTimeout = await boundedBackgroundRequest;
  assert.equal(backgroundTimeout.ok, false);
  assert.match(backgroundTimeout.error, /timed out/i);

  let serverCompletedChange = false;
  let refreshCalls = 0;
  globalThis.window.dispatchEvent = () => { refreshCalls += 1; };
  globalThis.CustomEvent = class CustomEvent { constructor(type) { this.type = type; } };
  globalThis.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    setTimeout(() => { serverCompletedChange = true; }, 70);
    options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const unconfirmed = await api.postJson('/api/workspaces', { action: 'upsert' }, { timeout: 25, pauseTimeoutWhenHidden: false });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.outcomeUnknown, true, 'lost POST responses must never assert that the server rolled back a mutation');
  assert.equal(unconfirmed.errorCode, 'dashboard_action_unconfirmed');
  assert.match(unconfirmed.error, /may have completed/i);
  assert.equal(refreshCalls, 1, 'an unconfirmed mutation must refresh the authoritative dashboard state');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(serverCompletedChange, true, 'the server can finish after the browser has reported an unconfirmed outcome');
} finally {
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  if (originalEventSource === undefined) delete globalThis.EventSource; else globalThis.EventSource = originalEventSource;
  if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
  if (originalFetch === undefined) delete globalThis.fetch; else globalThis.fetch = originalFetch;
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = originalCustomEvent;
}

console.log('Dashboard event visibility lifecycle tests passed.');
