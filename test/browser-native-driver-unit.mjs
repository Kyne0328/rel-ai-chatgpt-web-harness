import assert from 'node:assert/strict';

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


console.log('Embedded browser native driver bridge and lifecycle events passed.');
