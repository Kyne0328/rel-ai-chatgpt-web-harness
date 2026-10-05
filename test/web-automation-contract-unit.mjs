import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { getToolActionCatalog } from '../src/tools/actionCatalog.js';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { validateToolOutput } from '../src/tools/outputValidation.js';
import { toolResult } from '../src/mcp/results.js';
import {
  isAllowedResourceUrl,
  normalizeUiRoute,
  resolveUiRoute,
  sanitizeUiUrl
} from '../src/webAutomationManager.js';

assert.equal(normalizeUiRoute('/dashboard#settings'), '/dashboard#settings');
assert.throws(() => normalizeUiRoute('https://example.com'), /local path/);
assert.throws(() => normalizeUiRoute('//example.com/path'), /Protocol-relative/);
assert.throws(() => normalizeUiRoute('/safe\\..\\escape'), /Backslashes/);
assert.equal(resolveUiRoute('http://127.0.0.1:3333', '/dashboard#usage'), 'http://127.0.0.1:3333/dashboard#usage');

const ports = new Set([3000, 3333]);
assert.equal(isAllowedResourceUrl('http://127.0.0.1:3000/app.js', ports), true);
assert.equal(isAllowedResourceUrl('https://localhost:3333/api', ports), true);
assert.equal(isAllowedResourceUrl('http://127.0.0.1:4444/api', ports), false);
assert.equal(isAllowedResourceUrl('https://example.com/', ports), false);
assert.equal(isAllowedResourceUrl('file:///etc/passwd', ports), false);
assert.equal(isAllowedResourceUrl('data:text/plain,ok', ports), true);

const redacted = sanitizeUiUrl('http://user:secret@localhost:3333/path?token=super-secret#section');
assert.equal(redacted.includes('super-secret'), false);
assert.equal(redacted.includes('user'), false);
assert.equal(redacted.includes('secret@'), false);
assert.match(redacted, /^http:\/\/localhost:3333\/path\?/);
assert.match(redacted, /#section$/);

const png = Buffer.from('not-a-real-png-for-contract-only').toString('base64');
const screenshotArgs = {
  workspace: 'repo',
  action: 'screenshot',
  work_id: 'work_contract',
  sessionId: 'ui_contract_contract_contract'
};
const connectorScreenshot = serializeConnectorResult({
  publicName: 'relai_ui',
  action: 'screenshot',
  operationName: 'relai_ui',
  value: {
    ok: true,
    workspace: 'repo',
    action: 'screenshot',
    sessionId: screenshotArgs.sessionId,
    image: { mimeType: 'image/png', data: png, bytes: 32, width: 800, height: 600 }
  },
  args: screenshotArgs,
  workId: 'work_contract'
});
await validateToolOutput({}, 'relai_ui', screenshotArgs, connectorScreenshot);
assert.equal(connectorScreenshot.image.data, png);
const result = toolResult(connectorScreenshot, false);
assert.equal(result.content.length, 2);
assert.deepEqual(result.content[1], { type: 'image', data: png, mimeType: 'image/png' });
assert.equal(result.structuredContent.image.data, undefined);
assert.equal(result.structuredContent.image.mimeType, 'image/png');
assert.equal(result.structuredContent.image.bytes, 32);
assert.equal(result.structuredContent.work_id, undefined, 'routine screenshot success must not echo caller-owned task identity');
assert.equal(result.structuredContent.workspace, 'repo', 'routine screenshot success must retain required workspace identity');
assert.equal(result.structuredContent.action, 'screenshot', 'routine success must retain action identity');
assert.equal(result.structuredContent.sessionId, screenshotArgs.sessionId, 'routine success must retain resource identity');

const nestedPng = Buffer.from('nested-image-contract').toString('base64');
const batchResult = toolResult({
  ok: true,
  action: 'batch',
  results: [
    { ok: true, action: 'click', executed: true },
    { ok: true, action: 'screenshot', image: { mimeType: 'image/png', data: png, bytes: 32, width: 800, height: 600 } },
    { ok: true, action: 'screenshot', image: { mimeType: 'image/png', data: nestedPng, bytes: 21, width: 400, height: 300 } }
  ]
}, false);
assert.equal(batchResult.content.length, 3, 'nested batch screenshots must become independent MCP image content items');
assert.deepEqual(batchResult.content[1], { type: 'image', data: png, mimeType: 'image/png' });
assert.deepEqual(batchResult.content[2], { type: 'image', data: nestedPng, mimeType: 'image/png' });
assert.equal(batchResult.structuredContent.results[1].image.data, undefined, 'nested screenshot base64 must not remain in structured content');
assert.equal(batchResult.structuredContent.results[2].image.data, undefined, 'every nested screenshot must be sanitized');

const uiActions = getToolActionCatalog().filter(entry => entry.publicTool === 'relai_ui');
assert.deepEqual(uiActions.map(entry => entry.action), [
  'start', 'navigate', 'snapshot', 'interact', 'screenshot',
  'console', 'network', 'viewport', 'reload', 'stop'
]);
assert.ok(uiActions.every(entry => entry.operationName === 'ui'));
const uiByAction = new Map(uiActions.map(entry => [entry.action, entry]));
for (const action of ['start', 'navigate', 'snapshot', 'interact', 'screenshot', 'console', 'network', 'viewport', 'reload', 'stop']) {
  assert.equal(uiByAction.get(action)?.behavior.taskScope, 'optional', `${action} must use principal/workspace/session authority without requiring a synthetic task`);
}

// Load the real registry in an isolated module instance with only its browser
// adapter replaced. No Chromium process or network connection is created.
{
  const state = { launchBarrier: null, closeBarrier: null, failClose: false, closeCount: 0 };
  globalThis.__relaiUiLifecycleFixture = {
    async launch() {
      if (state.launchBarrier) await state.launchBarrier.promise;
      return {
        browserProduct: 'Lifecycle fixture',
        navigate: async url => ({ url, title: 'Fixture' }),
        onDisconnected() {},
        async close() {
          state.closeCount += 1;
          if (state.closeBarrier) await state.closeBarrier.promise;
          if (state.failClose) throw new Error('fixture UI close failure');
        }
      };
    }
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/webSessionRegistry.ts?lifecycle-fixture') && specifier === './webBrowserAdapter.ts') {
        return { url: new URL('./webBrowserAdapter.ts?lifecycle-fixture', context.parentURL).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.endsWith('/webBrowserAdapter.ts?lifecycle-fixture')) {
        return { format: 'module', shortCircuit: true, source: 'export async function launchWebBrowserSession() { return globalThis.__relaiUiLifecycleFixture.launch(); }' };
      }
      return nextLoad(url, context);
    }
  });
  const registry = await import('../src/computer/webSessionRegistry.ts?lifecycle-fixture');
  hooks.deregister();
  const workspace = { alias: 'fixture' };
  const owner = { taskId: 'work_ui_lifecycle' };
  try {
    for (const cleanup of ['shutdown', 'task']) {
      state.launchBarrier = Promise.withResolvers();
      const starting = assert.rejects(() => registry.startUiSession(workspace, { port: 3000 }, owner), error => error?.code === 'UI_OPERATION_CANCELLED');
      let finished = false;
      const cleaning = (cleanup === 'shutdown' ? registry.stopAllUiSessions() : registry.stopUiSessionsForTask(owner.taskId))
        .then(() => { finished = true; });
      await Promise.resolve();
      assert.equal(finished, false, 'UI cleanup must wait for its pending launch');
      await assert.rejects(() => registry.startUiSession(workspace, { port: 3000 }, owner),
        error => error?.code === (cleanup === 'shutdown' ? 'UI_RUNTIME_SHUTTING_DOWN' : 'UI_SESSION_CLOSING'));
      state.launchBarrier.resolve();
      await starting;
      await cleaning;
    }
    state.launchBarrier = null;
    for (const cleanup of ['task', 'shutdown']) {
      const cancelledSession = await registry.startUiSession(workspace, { port: 3000 }, owner);
      state.closeBarrier = Promise.withResolvers();
      const cleaning = cleanup === 'task' ? registry.stopUiSessionsForTask(owner.taskId) : registry.stopAllUiSessions();
      let callbackInvoked = false;
      assert.throws(() => registry.withUiSession(workspace, { sessionId: cancelledSession.sessionId }, owner, () => {
        callbackInvoked = true;
        return true;
      }), error => error?.code === 'UI_SESSION_NOT_FOUND', 'logical session removal must precede the first asynchronous cleanup continuation');
      assert.equal(callbackInvoked, false, 'post-cancellation actions must never reach the browser adapter');
      state.closeBarrier.resolve();
      await cleaning;
      state.closeBarrier = null;
    }
    let session = await registry.startUiSession(workspace, { port: 3000 }, owner);
    const closeCount = state.closeCount;
    state.closeBarrier = Promise.withResolvers();
    const stopping = registry.stopUiSession(workspace, { sessionId: session.sessionId }, owner);
    const duplicateStop = registry.stopUiSession(workspace, { sessionId: session.sessionId }, owner);
    assert.throws(() => registry.withUiSession(workspace, { sessionId: session.sessionId }, owner, () => true), error => error?.code === 'UI_SESSION_CLOSING');
    state.closeBarrier.resolve();
    assert.equal((await stopping).ok, true);
    assert.equal((await duplicateStop).ok, true);
    assert.equal(state.closeCount - closeCount, 1, 'UI stops must coalesce driver cleanup');
    state.closeBarrier = null;

    session = await registry.startUiSession(workspace, { port: 3000 }, owner);
    state.failClose = true;
    assert.equal((await registry.stopUiSession(workspace, { sessionId: session.sessionId }, owner)).ok, false);
    assert.equal(registry.withUiSession(workspace, { sessionId: session.sessionId }, owner, () => true), true, 'failed close must preserve the retryable UI owner');
    await assert.rejects(() => registry.stopAllUiSessions(), /UI browser cleanup failed/);
    state.failClose = false;
    await registry.stopAllUiSessions();
    assert.throws(() => registry.withUiSession(workspace, { sessionId: session.sessionId }, owner, () => true), error => error?.code === 'UI_SESSION_NOT_FOUND');

    state.launchBarrier = Promise.withResolvers();
    state.failClose = true;
    const controller = new AbortController();
    const cancelled = assert.rejects(() => registry.startUiSession(workspace, { port: 3000 }, { ...owner, signal: controller.signal }), error => error?.code === 'UI_OPERATION_CANCELLED');
    controller.abort(new Error('fixture caller cancellation'));
    await cancelled;
    state.launchBarrier.resolve();
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => registry.startUiSession(workspace, { port: 3000 }, owner), error => error?.code === 'UI_SESSION_ALREADY_ACTIVE');
    await assert.rejects(() => registry.stopAllUiSessions(), /UI browser cleanup failed/, 'failed late-driver cleanup must remain observable');
    state.failClose = false;
    await registry.stopAllUiSessions();
    state.launchBarrier = null;
    await registry.startUiSession(workspace, { port: 3000 }, owner);
    await registry.stopAllUiSessions();
  } finally {
    state.failClose = false;
    state.launchBarrier?.resolve();
    state.closeBarrier?.resolve();
    await registry.stopAllUiSessions().catch(() => {});
    delete globalThis.__relaiUiLifecycleFixture;
  }
}

// Automatic terminal cleanup starts synchronously, but reports asynchronous
// teardown failure through bounded diagnostics rather than an unhandled promise.
{
  const fixture = { listener: null };
  globalThis.__relaiTerminalCleanupFixture = fixture;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith('/automationAttribution.ts?cleanup-rejection-fixture') && specifier === '../toolActivity.js') {
        return { url: new URL('../toolActivity.js?cleanup-rejection-fixture', context.parentURL).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.endsWith('/toolActivity.js?cleanup-rejection-fixture')) {
        return {
          format: 'module', shortCircuit: true,
          source: 'export function onToolActivity(listener) { globalThis.__relaiTerminalCleanupFixture.listener = listener; return () => { globalThis.__relaiTerminalCleanupFixture.listener = null; }; } export function taskError(code, message) { return Object.assign(new Error(message), { code }); }'
        };
      }
      return nextLoad(url, context);
    }
  });
  let attribution;
  try { attribution = await import('../src/computer/automationAttribution.ts?cleanup-rejection-fixture'); }
  finally { hooks.deregister(); }
  const diagnostics = [];
  const unhandled = [];
  const originalError = console.error;
  const onUnhandled = error => unhandled.push(error);
  console.error = (...args) => diagnostics.push(args);
  process.on('unhandledRejection', onUnhandled);
  let started = false;
  let synchronous = false;
  const unsubscribe = attribution.registerTerminalTaskCleanup(() => {
    started = true;
    const error = new Error('Authorization: Bearer fixture-secret\n' + 'x'.repeat(2000));
    if (synchronous) throw error;
    return Promise.reject(error);
  });
  try {
    fixture.listener({ phase: 'cancelled', taskId: 'work_cleanup_fixture' });
    assert.equal(started, true, 'terminal cleanup must revoke sessions in the notifying call stack');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled.length, 0, 'automatic cleanup rejection must be handled');
    assert.equal(diagnostics.length, 1, 'cleanup failure must remain observable');
    assert.match(String(diagnostics[0][0]), /automatic automation cleanup failed/);
    assert.equal(String(diagnostics[0][1]).includes('fixture-secret'), false, 'cleanup diagnostics must redact credentials');
    assert.ok(String(diagnostics[0][1]).length <= 500, 'cleanup diagnostics must be bounded');
    synchronous = true;
    fixture.listener({ phase: 'completed', taskId: 'work_cleanup_fixture' });
    assert.equal(diagnostics.length, 2, 'synchronous cleanup failure must use the same diagnostic path');
  } finally {
    unsubscribe();
    console.error = originalError;
    process.off('unhandledRejection', onUnhandled);
    delete globalThis.__relaiTerminalCleanupFixture;
  }
}

console.log('Web automation contracts are bounded, local-only, and image-capable.');
