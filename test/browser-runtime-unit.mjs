import assert from 'node:assert/strict';
import { createBrowserRuntime, normalizeBrowserUrl } from '../src/browser/browserRuntime.ts';

const workspace = { alias: 'repo' };
const context = { taskId: 'work_browser_unit' };
const fake = createFakeBrowserHarness();
const runtime = createBrowserRuntime({ launch: fake.launch });

const concurrentFake = createFakeBrowserHarness();
let releaseConcurrentLaunch;
concurrentFake.state.launchBarrier = new Promise(resolve => { releaseConcurrentLaunch = resolve; });
const concurrentRuntime = createBrowserRuntime({ launch: concurrentFake.launch });
const concurrentContext = { taskId: 'work_browser_concurrent' };
const concurrentStarts = [
  concurrentRuntime.start(workspace, { url: 'http://127.0.0.1:3000/concurrent-a', work_id: concurrentContext.taskId }, concurrentContext),
  concurrentRuntime.start(workspace, { url: 'http://127.0.0.1:3000/concurrent-b', work_id: concurrentContext.taskId }, concurrentContext)
];
releaseConcurrentLaunch();
const concurrentResults = await Promise.allSettled(concurrentStarts);
assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1, 'concurrent starts for one work session must create exactly one browser session');
assert.equal(concurrentResults.filter(result => result.status === 'rejected' && result.reason?.code === 'BROWSER_SESSION_ALREADY_ACTIVE').length, 1, 'the racing start must be rejected by the one-browser-per-work-session contract');
await concurrentRuntime.shutdown();

assert.equal(runtime.activeSessionCount(), 0);
assert.equal((await runtime.status(workspace, {}, context)).activeSessionCount, 0);
assert.equal(normalizeBrowserUrl('http://127.0.0.1:3000/path'), 'http://127.0.0.1:3000/path');
assert.throws(() => normalizeBrowserUrl('file:///tmp/test'), /http or https/i);
assert.throws(() => normalizeBrowserUrl('/relative'), /absolute http or https/i);

const started = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/start', work_id: context.taskId }, context);
assert.equal(started.ok, true);
assert.match(started.sessionId, /^browser_/);
assert.match(started.tabId, /^tab_/);
assert.equal(runtime.activeSessionCount(), 1);
const sessionId = started.sessionId;
const firstTabId = started.tabId;

const navigated = await runtime.navigate(workspace, {
  sessionId, tabId: firstTabId, url: 'http://192.168.1.20/internal', work_id: context.taskId
}, context);
assert.equal(navigated.url, 'http://192.168.1.20/internal');

const snapshot = await runtime.snapshot(workspace, { sessionId, tabId: firstTabId, work_id: context.taskId }, context);
assert.equal(snapshot.detail, 'semantic');
assert.equal(snapshot.snapshot, 'snapshot:http://192.168.1.20/internal');
const layoutSnapshot = await runtime.snapshot(workspace, { sessionId, tabId: firstTabId, detail: 'layout', work_id: context.taskId }, context);
assert.equal(layoutSnapshot.detail, 'layout');

const interaction = await runtime.interact(workspace, {
  sessionId,
  tabId: firstTabId,
  interaction: 'click',
  target: { by: 'role', value: 'button', name: 'Save' },
  work_id: context.taskId
}, context);
assert.equal(interaction.interaction, 'click');

const screenshot = await runtime.screenshot(workspace, { sessionId, tabId: firstTabId, work_id: context.taskId }, context);
assert.equal(screenshot.image.mimeType, 'image/png');

const second = await runtime.openTab(workspace, {
  sessionId,
  url: 'https://intranet.example.test/second',
  work_id: context.taskId
}, context);
assert.notEqual(second.tabId, firstTabId);
const tabs = await runtime.listTabs(workspace, { sessionId, work_id: context.taskId }, context);
assert.equal(tabs.count, 2);
assert.equal(tabs.tabs.filter(tab => tab.active).length, 1);

await runtime.closeTab(workspace, { sessionId, tabId: second.tabId, work_id: context.taskId }, context);
assert.equal((await runtime.listTabs(workspace, { sessionId, work_id: context.taskId }, context)).count, 1);

const capacityTabs = [];
for (let index = 0; index < 7; index += 1) {
  capacityTabs.push(await runtime.openTab(workspace, {
    sessionId,
    url: `https://intranet.example.test/capacity-${index}`,
    work_id: context.taskId
  }, context));
}
assert.equal((await runtime.listTabs(workspace, { sessionId, work_id: context.taskId }, context)).count, 8);
await assert.rejects(
  () => runtime.openTab(workspace, { sessionId, url: 'https://intranet.example.test/overflow', work_id: context.taskId }, context),
  error => error?.code === 'BROWSER_TAB_LIMIT'
);
await runtime.closeTab(workspace, { sessionId, tabId: capacityTabs[0].tabId, work_id: context.taskId }, context);
const replacementTab = await runtime.openTab(workspace, { sessionId, url: 'https://intranet.example.test/replacement', work_id: context.taskId }, context);
assert.match(replacementTab.tabId, /^tab_/);

await assert.rejects(
  () => runtime.navigate(workspace, { sessionId, url: 'javascript:alert(1)', work_id: context.taskId }, context),
  /http or https/i
);

fake.state.timeoutInteraction = true;
await assert.rejects(
  () => runtime.interact(workspace, {
    sessionId,
    interaction: 'click',
    target: { by: 'text', value: 'Never appears' },
    timeoutMs: 100,
    work_id: context.taskId
  }, context),
  /Timeout/i
);
fake.state.timeoutInteraction = false;

fake.state.pendingSnapshot = true;
const controller = new AbortController();
const cancelledSnapshot = runtime.snapshot(
  workspace,
  { sessionId, work_id: context.taskId },
  context,
  { signal: controller.signal }
);
controller.abort(new Error('cancel unit operation'));
await assert.rejects(cancelledSnapshot, error => error?.code === 'BROWSER_OPERATION_CANCELLED');
fake.state.pendingSnapshot = false;

fake.disconnectLatest();
assert.equal(runtime.activeSessionCount(), 0, 'browser disconnect must invalidate the session');
await assert.rejects(
  () => runtime.snapshot(workspace, { sessionId, work_id: context.taskId }, context),
  error => error?.code === 'BROWSER_SESSION_NOT_FOUND'
);

const recovered = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/recovered', work_id: context.taskId }, context);
assert.equal(recovered.ok, true, 'a new session must be startable after browser failure');
assert.equal(runtime.activeSessionCount(), 1);

const cleaned = await runtime.stopSessionsForTask(context.taskId);
assert.equal(cleaned.stopped, 1, 'task completion/cancellation cleanup must close task-attributed browser sessions');
assert.equal(runtime.activeSessionCount(), 0);
await assert.rejects(
  () => runtime.snapshot(workspace, { sessionId: recovered.sessionId, work_id: context.taskId }, context),
  error => error?.code === 'BROWSER_SESSION_NOT_FOUND'
);

const ownerPrincipal = { clientId: 'browser-runtime-owner', subject: 'owner', authMode: 'test' };
const ownerContext = { taskId: 'work_browser_owned', principal: ownerPrincipal };
const owned = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/owned', work_id: ownerContext.taskId }, ownerContext);
const navigationsBeforeOwnershipChecks = fake.state.navigateCount;
await assert.rejects(
  () => runtime.navigate({ alias: 'other' }, {
    sessionId: owned.sessionId,
    url: 'https://example.test/cross-workspace',
    work_id: ownerContext.taskId
  }, ownerContext),
  error => error?.code === 'BROWSER_SESSION_WORKSPACE_MISMATCH'
);
await assert.rejects(
  () => runtime.navigate(workspace, {
    sessionId: owned.sessionId,
    url: 'https://example.test/cross-principal',
    work_id: ownerContext.taskId
  }, { ...ownerContext, principal: { clientId: 'browser-runtime-other', subject: 'other', authMode: 'test' } }),
  error => error?.code === 'BROWSER_SESSION_PRINCIPAL_MISMATCH'
);
await assert.rejects(
  () => runtime.navigate(workspace, {
    sessionId: owned.sessionId,
    url: 'https://example.test/cross-task',
    work_id: 'work_browser_other'
  }, { taskId: 'work_browser_other', principal: ownerPrincipal }),
  error => error?.code === 'BROWSER_SESSION_TASK_MISMATCH'
);
assert.equal(fake.state.navigateCount, navigationsBeforeOwnershipChecks, 'ownership failures must occur before browser navigation');
await runtime.stop(workspace, { sessionId: owned.sessionId, work_id: ownerContext.taskId }, ownerContext);
await assert.rejects(
  () => runtime.snapshot(workspace, { sessionId: owned.sessionId, work_id: ownerContext.taskId }, ownerContext),
  error => error?.code === 'BROWSER_SESSION_NOT_FOUND'
);

const tasklessA = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/a' }, {});
const _tasklessB = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/b' }, {});
assert.equal(runtime.activeSessionCount(), 2);
const shutdown = await runtime.shutdown();
assert.equal(shutdown.stopped, 2);
assert.equal(runtime.activeSessionCount(), 0);
assert.ok(fake.state.closeCount >= 3);

fake.state.failNextLaunch = true;
await assert.rejects(() => runtime.start(workspace, { url: 'http://127.0.0.1:3000/fail' }, {}), /simulated launch failure/);
const afterFailure = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/after-failure' }, {});
assert.equal(afterFailure.ok, true);
await runtime.stop(workspace, { sessionId: afterFailure.sessionId }, {});

await assert.rejects(
  () => runtime.status({ alias: 'other' }, { sessionId: tasklessA.sessionId }, {}),
  error => error?.code === 'BROWSER_SESSION_NOT_FOUND'
);

console.log('Local browser runtime lifecycle, tabs, cancellation, failure recovery, active ownership boundaries, and cleanup passed.');

function createFakeBrowserHarness() {
  const state = {
    closeCount: 0,
    failNextLaunch: false,
    launchBarrier: null,
    timeoutInteraction: false,
    pendingSnapshot: false,
    navigateCount: 0,
    drivers: []
  };

  async function launch() {
    if (state.launchBarrier) await state.launchBarrier;
    if (state.failNextLaunch) {
      state.failNextLaunch = false;
      throw new Error('simulated launch failure');
    }
    let disconnected = null;
    let pageCounter = 0;
    const pages = [];
    const driver = {
      browserProduct: 'Fake Local Chromium',
      async createPage() {
        pageCounter += 1;
        let url = 'about:blank';
        let closed = null;
        let crashed = null;
        const page = {
          async describe() { return { url, title: `Tab ${pageCounter}` }; },
          async navigate(next) { state.navigateCount += 1; url = next; return { url, title: `Tab ${pageCounter}`, statusCode: 200 }; },
          async snapshot(_timeoutMs, detail = 'semantic') {
            if (state.pendingSnapshot) return new Promise(() => {});
            return { url, title: `Tab ${pageCounter}`, detail, snapshot: `snapshot:${url}`, truncated: false };
          },
          async interact(args) {
            if (state.timeoutInteraction) throw new Error('Timeout 100ms exceeded.');
            return { url, interaction: args.interaction, target: args.target };
          },
          async screenshot() {
            return { url, image: { mimeType: 'image/png', data: 'ZmFrZQ==', bytes: 4, width: 800, height: 600 } };
          },
          async close() { closed?.(); },
          onClosed(listener) { closed = listener; },
          onCrashed(listener) { crashed = listener; },
          crash() { crashed?.(); }
        };
        pages.push(page);
        return page;
      },
      async close() { state.closeCount += 1; },
      onDisconnected(listener) { disconnected = listener; },
      disconnect() { disconnected?.(); }
    };
    state.drivers.push(driver);
    return driver;
  }

  return {
    state,
    launch,
    disconnectLatest() { state.drivers.at(-1)?.disconnect(); }
  };
}
