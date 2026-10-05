import fs from 'node:fs';
import http from 'node:http';
import { app, BrowserWindow, WebContentsView, nativeImage, session } from 'electron';
import { createBrowserSurfaceHost } from '../../../electron/browser-surface-host.js';

const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;
if (!outputPath) throw new Error('Embedded browser probe output path is required.');

app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Embedded fixture</title><style>
      body { margin: 0; }
      #breakpoint::after { content: 'narrow'; }
      @media (min-width: 1000px) { #breakpoint::after { content: 'wide'; } }
      .spacer { height: 3000px; }
      #edge { position: fixed; right: 8px; bottom: 8px; }
    </style></head><body><main><h1>Embedded browser fixture</h1><div id="breakpoint"></div><label for="name">Name</label><input id="name" placeholder="Your name"><label for="release-title">Release title <span aria-hidden="true">*</span></label><input id="release-title" required><button id="save" type="button" onclick="window.probeClicks=(window.probeClicks||0)+1">Save</button><button id="edge" type="button" onclick="window.probeEdgeClicks=(window.probeEdgeClicks||0)+1">Edge</button><div class="spacer"></div></main></body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const targetUrl = `http://127.0.0.1:${address.port}/fixture`;
  const useRenderedCiSurface = process.platform === 'linux' && process.env.CI === 'true';
  const win = new BrowserWindow({
    show: false,
    opacity: useRenderedCiSurface ? 1 : 0,
    focusable: false,
    skipTaskbar: true,
    width: 900,
    height: 700,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await win.loadURL('data:text/html,<html><body><div>Rel.AI dashboard probe</div></body></html>');

  const events = [];
  const states = [];
  const host = createBrowserSurfaceHost({
    WebContentsView,
    session,
    getDashboardWindow: () => win,
    openDashboard: async route => {
      if (route !== '#browser') throw new Error(`Unexpected dashboard route ${route}.`);
      win.showInactive();
    },
    onEvent: event => events.push(event),
    onStateChange: state => states.push(state)
  });

  try {
    const started = await host.run({ action: 'start', viewport: { width: 1200, height: 750 } });
    const opened = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
    const secondTab = await host.run({ action: 'open_page', nativeSessionId: started.nativeSessionId });
    const positioned = await host.setBounds({ visible: true, x: 24, y: 80, width: 720, height: 480 });
    const tabState = await host.selectTab(opened.nativePageId);
    const navigated = await host.run({
      action: 'navigate',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      url: targetUrl,
      timeoutMs: 10_000
    });
    const pageContents = win.contentView.children[0].webContents;
    const initialViewport = await pageContents.executeJavaScript(`({ width: innerWidth, height: innerHeight, breakpoint: getComputedStyle(document.querySelector('#breakpoint'), '::after').content })`);
    const resizedState = await host.setBounds({ visible: true, x: 24, y: 80, width: 500, height: 500 });
    const resizedViewport = await pageContents.executeJavaScript(`({ width: innerWidth, height: innerHeight, breakpoint: getComputedStyle(document.querySelector('#breakpoint'), '::after').content })`);
    const presentationScale = 500 / 1200;
    const snapshot = await host.run({
      action: 'snapshot',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      timeoutMs: 10_000
    });
    await host.run({
      action: 'interact',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      interaction: 'fill',
      target: { by: 'label', value: 'Name', exact: true },
      input: 'Rel.AI embedded'
    });
    await host.run({
      action: 'interact',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      interaction: 'wait',
      target: { by: 'role', value: 'textbox', name: 'Release title', exact: true },
      state: 'visible',
      timeoutMs: 1_000
    });
    await host.run({
      action: 'interact',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      interaction: 'fill',
      target: { by: 'label', value: 'Release title', exact: true },
      input: 'v1.2.3'
    });
    const requiredFieldValue = await pageContents.executeJavaScript(`document.querySelector('#release-title').value`);
    const afterFill = await host.run({
      action: 'snapshot',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      timeoutMs: 10_000
    });
    const screenshot = await host.run({
      action: 'screenshot',
      nativeSessionId: started.nativeSessionId,
      nativePageId: opened.nativePageId,
      fullPage: false
    });
    const screenshotActualSize = nativeImage.createFromBuffer(Buffer.from(screenshot.image.data, 'base64')).getSize();
    const afterTabClose = await host.closeTab(secondTab.nativePageId);
    const button = await pageContents.executeJavaScript(`(() => { const r = document.querySelector('#save').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    pageContents.sendInputEvent({ type: 'mouseDown', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    pageContents.sendInputEvent({ type: 'mouseUp', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const aiClickCount = await pageContents.executeJavaScript('window.probeClicks || 0');
    const userState = await host.setControl('user');
    pageContents.sendInputEvent({ type: 'mouseDown', x: button.x * presentationScale, y: button.y * presentationScale, button: 'left', clickCount: 1 });
    pageContents.sendInputEvent({ type: 'mouseUp', x: button.x * presentationScale, y: button.y * presentationScale, button: 'left', clickCount: 1 });
    const edgeButton = await pageContents.executeJavaScript(`(() => { const r = document.querySelector('#edge').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    pageContents.sendInputEvent({ type: 'mouseDown', x: edgeButton.x * presentationScale, y: edgeButton.y * presentationScale, button: 'left', clickCount: 1 });
    pageContents.sendInputEvent({ type: 'mouseUp', x: edgeButton.x * presentationScale, y: edgeButton.y * presentationScale, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const userClickCount = await pageContents.executeJavaScript('window.probeClicks || 0');
    const userEdgeClickCount = await pageContents.executeJavaScript('window.probeEdgeClicks || 0');
    const userScrollY = await pageContents.executeJavaScript('scrollTo(0, 400); scrollY');
    let takeoverError = null;
    try {
      await host.run({
        action: 'navigate',
        nativeSessionId: started.nativeSessionId,
        nativePageId: opened.nativePageId,
        url: targetUrl
      });
    } catch (error) {
      takeoverError = { code: error?.code || '', message: error?.message || String(error) };
    }
    const aiState = await host.setControl('ai');
    const aiViewport = await pageContents.executeJavaScript(`({ width: innerWidth, height: innerHeight, breakpoint: getComputedStyle(document.querySelector('#breakpoint'), '::after').content })`);
    pageContents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 500, canScroll: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    const aiScrollY = await pageContents.executeJavaScript('scrollY');
    const legacyHeadless = await host.run({ action: 'start', headless: true, viewport: { width: 800, height: 600 } });
    await host.run({ action: 'open_page', nativeSessionId: legacyHeadless.nativeSessionId });
    const legacyHeadlessState = await host.setBounds({ visible: true, x: 24, y: 80, width: 500, height: 500 });
    const legacyHeadlessUserState = await host.setControl('user');
    await host.setControl('ai');
    await host.run({ action: 'close_session', nativeSessionId: legacyHeadless.nativeSessionId });
    const finalState = host.getState();
    fs.writeFileSync(outputPath, JSON.stringify({
      started,
      positioned,
      resizedState,
      tabState,
      afterTabClose,
      navigated,
      snapshot: snapshot.snapshot,
      afterFill: afterFill.snapshot,
      requiredFieldValue,
      screenshotBytes: screenshot.image.bytes,
      screenshotWidth: screenshot.image.width,
      screenshotHeight: screenshot.image.height,
      screenshotViewport: screenshot.viewport,
      screenshotActualSize,
      initialViewport,
      resizedViewport,
      presentationScale,
      aiViewport,
      aiClickCount,
      userClickCount,
      userEdgeClickCount,
      userScrollY,
      aiScrollY,
      userState,
      takeoverError,
      aiState,
      legacyHeadless,
      legacyHeadlessState,
      legacyHeadlessUserState,
      finalState,
      windowVisible: win.isVisible(),
      windowOpacity: win.getOpacity(),
      windowFocused: win.isFocused(),
      stateCount: states.length,
      events
    }, null, 2));
  } catch (error) {
    fs.writeFileSync(outputPath, JSON.stringify({ error: error?.stack || String(error), states, events }, null, 2));
    process.exitCode = 1;
  } finally {
    await host.closeAll().catch(() => {});
    if (!win.isDestroyed()) win.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }

}).catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: error?.stack || String(error) }, null, 2));
  app.exit(1);
});
