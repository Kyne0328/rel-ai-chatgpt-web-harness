import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPlaywrightBrowserDriver } from '../src/browser/playwrightBrowserDriver.ts';

import {
  configureBrowserNativeBridge,
  dispatchBrowserNativeEvent,
  launchBrowserDriver
} from '../src/browser/browserDriver.ts';

const calls = [];
const bridge = async payload => {
  calls.push(payload);
  switch (payload.action) {
    case 'start':
      return { nativeSessionId: 'embedded_browser_abcdefghijklmnop', browserProduct: 'Embedded Test Chromium' };
    case 'open_page':
      return { nativePageId: 'embedded_page_abcdefghijklmnop' };
    case 'describe':
      return { ok: true, nativeSessionId: 'embedded_browser_abcdefghijklmnop', nativePageId: 'embedded_page_abcdefghijklmnop', url: 'https://example.test/', title: 'Example', loading: false };
    case 'navigate':
      return { ok: true, nativeSessionId: 'embedded_browser_abcdefghijklmnop', nativePageId: 'embedded_page_abcdefghijklmnop', url: payload.url, title: 'Navigated', loading: true };
    case 'close_page':
    case 'close_session':
      return { ok: true };
    default:
      return { url: 'https://example.test/' };
  }
};

configureBrowserNativeBridge(bridge);
try {
  const controller = new AbortController();
  const driver = await launchBrowserDriver({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    profileDirectory: 'C:/profiles/test',
    signal: controller.signal
  });
  assert.equal(driver.browserProduct, 'Embedded Test Chromium');
  assert.deepEqual(calls[0], {
    action: 'start',
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    profileDirectory: 'C:/profiles/test'
  });

  const page = await driver.createPage(controller.signal);
  const described = await page.describe(controller.signal);
  assert.equal(described.url, 'https://example.test/');
  assert.equal(Object.hasOwn(described, 'loading'), false, 'native loading state must not leak into the public browser result');
  assert.equal(Object.hasOwn(described, 'nativeSessionId'), false, 'native session identifiers must not leak into the public browser result');
  const navigated = await page.navigate('https://example.test/next', 5000, controller.signal);
  assert.equal(navigated.url, 'https://example.test/next');
  assert.equal(Object.hasOwn(navigated, 'loading'), false);

  let websitePage = null;
  let websitePageActive = null;
  driver.onPageCreated?.((created, active) => {
    websitePage = created;
    websitePageActive = active;
  });
  dispatchBrowserNativeEvent({
    resource: 'browser',
    type: 'page_opened',
    nativeSessionId: 'embedded_browser_abcdefghijklmnop',
    nativePageId: 'embedded_page_websitecreated1234',
    active: false
  });
  assert.ok(websitePage, 'website-created native pages must become service-side browser page proxies');
  assert.equal(websitePageActive, false);
  await websitePage.describe(controller.signal);
  assert.ok(calls.some(call => call.action === 'describe' && call.nativePageId === 'embedded_page_websitecreated1234'), 'website-created page proxies must target the originating native page');

  let crashed = 0;
  page.onCrashed(() => { crashed += 1; });
  dispatchBrowserNativeEvent({
    resource: 'browser',
    type: 'page_crashed',
    nativeSessionId: 'embedded_browser_abcdefghijklmnop',
    nativePageId: 'embedded_page_abcdefghijklmnop'
  });
  assert.equal(crashed, 1, 'native page crashes must invalidate the service-side page proxy');

  let disconnected = 0;
  driver.onDisconnected(() => { disconnected += 1; });
  dispatchBrowserNativeEvent({
    resource: 'browser',
    type: 'session_disconnected',
    nativeSessionId: 'embedded_browser_abcdefghijklmnop'
  });
  assert.equal(disconnected, 1, 'native session disconnects must invalidate the service-side browser proxy');

  await driver.close();
  assert.ok(calls.some(call => call.action === 'close_session'), 'closing the proxy must close the native session');
} finally {
  configureBrowserNativeBridge(null);
}


for (const failure of ['reject', 'negative-result']) {
  let failingAction = 'close_page';
  const fail = () => {
    if (failure === 'reject') throw new Error('fixture native close refused');
    return { ok: false, error: 'fixture native close refused' };
  };
  configureBrowserNativeBridge(async payload => payload.action === failingAction ? fail() : bridge(payload));
  try {
    const driver = await launchBrowserDriver({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: false });
    let page = await driver.createPage();
    let pageClosed = 0;
    let disconnected = 0;
    let created = 0;
    page.onClosed(() => { pageClosed += 1; });
    driver.onDisconnected(() => { disconnected += 1; });
    driver.onPageCreated(() => { created += 1; });

    await assert.rejects(() => page.close(), /fixture native close refused/);
    dispatchBrowserNativeEvent({ resource: 'browser', type: 'page_closed', nativePageId: 'embedded_page_abcdefghijklmnop' });
    assert.equal(pageClosed, 1, 'a failed page close must preserve its native event listener');
    failingAction = '';
    page = await driver.createPage();
    page.onClosed(() => { pageClosed += 1; });
    await page.close();
    dispatchBrowserNativeEvent({ resource: 'browser', type: 'page_closed', nativePageId: 'embedded_page_abcdefghijklmnop' });
    assert.equal(pageClosed, 1, 'successful page close must release its listener');

    failingAction = 'close_session';
    await assert.rejects(() => driver.close(), /fixture native close refused/);
    dispatchBrowserNativeEvent({ resource: 'browser', type: 'page_opened', nativeSessionId: 'embedded_browser_abcdefghijklmnop', nativePageId: 'embedded_page_retryevent123456' });
    assert.equal(created, 1, 'failed session close must retain page-registration events');
    dispatchBrowserNativeEvent({ resource: 'browser', type: 'session_disconnected', nativeSessionId: 'embedded_browser_abcdefghijklmnop' });
    assert.equal(disconnected, 1, 'failed session close must retain disconnect notification');

    failingAction = '';
    await driver.close();
    const replacement = await launchBrowserDriver({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: false });
    replacement.onDisconnected(() => { disconnected += 1; });
    replacement.onPageCreated(() => { created += 1; });
    await replacement.close();
    dispatchBrowserNativeEvent({ resource: 'browser', type: 'session_disconnected', nativeSessionId: 'embedded_browser_abcdefghijklmnop' });
    dispatchBrowserNativeEvent({ resource: 'browser', type: 'page_opened', nativeSessionId: 'embedded_browser_abcdefghijklmnop', nativePageId: 'embedded_page_retryevent123456' });
    assert.equal(disconnected, 1, 'successful session close must release disconnect notification');
    assert.equal(created, 1, 'successful session close must release page-registration events');
  } finally {
    configureBrowserNativeBridge(null);
  }
}



for (const eventOrder of ['before-result', 'after-result']) {
  const fixture = createPlaywrightFixture(eventOrder);
  const driver = createPlaywrightBrowserDriver(fixture.context, fixture.browser, { persistent: false, browserProduct: 'Fixture Chromium' });
  const observed = [];
  driver.onPageCreated((page, active) => observed.push({ page, active }));
  const explicit = await driver.createPage();
  if (eventOrder === 'after-result') fixture.context.emit('page', fixture.lastPage);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].page, explicit, 'explicit createPage and context events must share exact wrapper identity');
  fixture.context.emit('page', fixture.lastPage);
  assert.equal(observed.length, 1, 'duplicate context events must not re-register a page');

  const popup = fixture.makePage('https://example.test/popup');
  fixture.context.emit('page', popup);
  assert.equal(observed.length, 2, 'Playwright popup events must reach the runtime registration callback');
  assert.equal(observed[1].active, true);
  assert.equal((await observed[1].page.describe()).url, 'https://example.test/popup');
  let closed = 0;
  observed[1].page.onClosed(() => { closed += 1; });
  await popup.close();
  assert.equal(closed, 1, 'popup close events must reach the same registered wrapper');

  fixture.failClose = true;
  await assert.rejects(() => driver.close(), /fixture context close failed/);
  assert.equal(fixture.context.listenerCount('page'), 1, 'failed close must retain registration until cleanup succeeds');
  fixture.context.emit('page', fixture.makePage('https://example.test/retained'));
  assert.equal(observed.length, 3);
  fixture.failClose = false;
  await driver.close();
  assert.equal(fixture.context.listenerCount('page'), 0);
  assert.equal(fixture.context.listenerCount('close'), 0);
  assert.equal(fixture.browser.listenerCount('disconnected'), 0);
  fixture.context.emit('page', fixture.makePage());
  assert.equal(observed.length, 3, 'closed fallback drivers must release popup callbacks');
}

{
  const fixture = createPlaywrightFixture('before-result');
  const driver = createPlaywrightBrowserDriver(fixture.context, undefined, { persistent: true, browserProduct: 'Persistent Fixture' });
  const early = fixture.makePage('https://example.test/early');
  const alreadyClosed = fixture.makePage('https://example.test/closed');
  fixture.context.emit('page', early);
  fixture.context.emit('page', alreadyClosed);
  await alreadyClosed.close();
  const observed = [];
  driver.onPageCreated(page => observed.push(page));
  assert.equal(observed.length, 1, 'pages opened before callback registration must be delivered unless already closed');
  assert.equal((await observed[0].describe()).url, 'https://example.test/early');
  let disconnected = 0;
  driver.onDisconnected(() => { disconnected += 1; });
  fixture.context.emit('close');
  assert.equal(disconnected, 1, 'persistent contexts must report disconnect even without a Browser object');
  assert.equal(fixture.context.listenerCount('page'), 0);
  driver.onPageCreated(page => observed.push(page));
  fixture.context.emit('page', fixture.makePage());
  assert.equal(observed.length, 1, 'disconnected fallback drivers must not restore registration listeners');
}

function createPlaywrightFixture(eventOrder) {
  const context = new EventEmitter();
  const browser = new EventEmitter();
  const fixture = {
    context,
    browser,
    failClose: false,
    lastPage: null,
    makePage(url = 'about:blank') {
      const page = new EventEmitter();
      let closed = false;
      Object.assign(page, {
        url: () => url,
        title: async () => 'Fixture page',
        frames: () => [],
        mainFrame: () => null,
        isClosed: () => closed,
        close: async () => { closed = true; page.emit('close'); }
      });
      return page;
    }
  };
  context.newPage = async () => {
    fixture.lastPage = fixture.makePage();
    if (eventOrder === 'before-result') context.emit('page', fixture.lastPage);
    return fixture.lastPage;
  };
  context.close = async () => {
    if (fixture.failClose) throw new Error('fixture context close failed');
    context.emit('close');
  };
  browser.close = async () => {};
  return fixture;
}

console.log('Embedded and Playwright browser driver lifecycle events passed.');
