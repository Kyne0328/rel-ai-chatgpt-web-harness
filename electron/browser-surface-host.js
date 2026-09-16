import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { layoutSnapshotExpression, normalizeBrowserSnapshotDetail } from '../src/browser/layoutSnapshot.js';

const MAX_SNAPSHOT_CHARS = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const DOWNLOAD_TEMP_ROOT = path.resolve(os.tmpdir(), 'relai-browser-downloads');
const CONTROL_OWNERS = new Set(['ai', 'user']);
const READ_ONLY_ACTIONS = new Set(['describe', 'snapshot', 'screenshot']);
const SESSION_ID = /^embedded_browser_[A-Za-z0-9_-]{16,160}$/;
const PAGE_ID = /^embedded_page_[A-Za-z0-9_-]{16,160}$/;

function createBrowserSurfaceHost(options = {}) {
  const {
    WebContentsView,
    session,
    getDashboardWindow,
    openDashboard = async () => {},
    onEvent = () => {},
    onStateChange = () => {},
    onError = () => {}
  } = options;
  if (typeof WebContentsView !== 'function') throw new TypeError('Embedded browser requires Electron WebContentsView.');
  if (!session || typeof session.fromPartition !== 'function' || typeof session.fromPath !== 'function') {
    throw new TypeError('Embedded browser requires the Electron session API.');
  }
  if (typeof getDashboardWindow !== 'function') throw new TypeError('Embedded browser requires a dashboard-window getter.');

  const sessions = new Map();
  let activeSessionId = '';
  let pinnedSessionId = '';
  let surfaceBounds = { visible: false, x: 0, y: 0, width: 1, height: 1 };
  let attached = null;
  let closingAll = false;

  async function run(payload = {}, options = {}) {
    throwIfAborted(options.signal);
    const action = String(payload.action || '').trim();
    switch (action) {
      case 'start': return startSession(payload, options);
      case 'open_page': return openPage(payload, options);
      case 'describe': return withPage(payload, action, describePage, options);
      case 'navigate': return withPage(payload, action, navigatePage, options);
      case 'snapshot': return withPage(payload, action, snapshotPage, options);
      case 'interact': return withPage(payload, action, interactPage, options);
      case 'screenshot': return withPage(payload, action, screenshotPage, options);
      case 'upload': return withPage(payload, action, uploadFile, options);
      case 'begin_download': return withPage(payload, action, beginDownload, options);
      case 'close_page': return closePage(payload);
      case 'close_session': return closeSessionFromTool(payload.nativeSessionId);
      default: throw new Error(`Unsupported embedded browser action '${action || '(missing)'}.`);
    }
  }

  async function startSession(payload = {}, options = {}) {
    throwIfAborted(options.signal);
    const nativeSessionId = `embedded_browser_${crypto.randomBytes(18).toString('base64url')}`;
    const profileDirectory = String(payload.profileDirectory || '').trim();
    const persistent = Boolean(profileDirectory);
    const viewport = normalizeViewport(payload.viewport);
    const browserSession = persistent
      ? session.fromPath(path.resolve(profileDirectory))
      : session.fromPartition(`relai-browser:${nativeSessionId}`);
    secureBrowserSession(browserSession, payload.ignoreHTTPSErrors === true);
    const record = {
      nativeSessionId,
      electronSession: browserSession,
      persistent,
      viewport,
      pages: new Map(),
      activePageId: '',
      control: 'ai',
      createdAt: new Date().toISOString(),
      pendingDownloads: new Map(),
      downloadListener: null
    };
    record.downloadListener = (event, item, webContents) => handleWillDownload(record, event, item, webContents);
    browserSession.on('will-download', record.downloadListener);
    sessions.set(nativeSessionId, record);
    activeSessionId = nativeSessionId;
    publishState();
    try {
      await withAbort(openDashboard('#browser'), options.signal);
      return {
        ok: true,
        nativeSessionId,
        browserProduct: 'Rel.AI Embedded Chromium',
        profile: persistent ? 'persistent' : 'ephemeral',
        viewport
      };
    } catch (error) {
      await closeSession(nativeSessionId, { emit: false });
      throw error;
    }
  }

  async function openPage(payload = {}, options = {}) {
    throwIfAborted(options.signal);
    const record = requireSession(payload.nativeSessionId);
    assertAiControl(record, 'open_page');
    const page = createPage(record, { active: true });
    await syncPageRuntime(record, page);
    return { ok: true, nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId, ...describePage(record, page) };
  }

  function createPage(record, options = {}) {
    const nativePageId = `embedded_page_${crypto.randomBytes(18).toString('base64url')}`;
    const view = options.webContents
      ? new WebContentsView({ webContents: options.webContents })
      : new WebContentsView({ webPreferences: browserWebPreferences(record, options.webPreferences) });
    const initialBounds = { x: 0, y: 0, width: record.viewport.width, height: record.viewport.height };
    view.setBounds(initialBounds);
    const page = {
      nativePageId,
      view,
      webContents: view.webContents,
      bounds: initialBounds,
      presentationScale: 1,
      closing: false,
      loading: false,
      aiInputDepth: 0,
      runtimePromise: Promise.resolve(),
      createdAt: new Date().toISOString()
    };
    record.pages.set(nativePageId, page);
    if (options.active !== false) {
      record.activePageId = nativePageId;
      activeSessionId = record.nativeSessionId;
    }
    configurePage(record, page);
    attachActiveView();
    publishState();
    return page;
  }

  function browserWebPreferences(record, requested = {}) {
    return {
      ...(requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {}),
      session: record.electronSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      navigateOnDragDrop: false
    };
  }

  async function withPage(payload, action, operation, options = {}) {
    throwIfAborted(options.signal);
    const record = requireSession(payload.nativeSessionId);
    const page = requirePage(record, payload.nativePageId);
    if (!READ_ONLY_ACTIONS.has(action)) assertAiControl(record, action);
    if (action !== 'describe') activate(record, page);
    await syncPageRuntime(record, page);
    const result = await operation(record, page, payload, options);
    if (action === 'navigate') await syncPageRuntime(record, page);
    return result;
  }

  function describePage(_record, page) {
    return {
      url: publicPageUrl(page.webContents.getURL()),
      title: String(page.webContents.getTitle?.() || ''),
      loading: page.loading === true
    };
  }

  async function navigatePage(record, page, payload, options = {}) {
    assertAiControl(record, 'navigate');
    const url = normalizeBrowserUrl(payload.url);
    try {
      await withTimeout(
        withAbort(page.webContents.loadURL(url), options.signal, () => page.webContents.stop?.()),
        timeoutFor(payload.timeoutMs),
        'Browser navigation timed out.'
      );
    } catch (error) {
      page.webContents.stop?.();
      throw error;
    }
    publishState();
    return { ...describePage(record, page), statusCode: null };
  }

  async function snapshotPage(_record, page, payload, options = {}) {
    const detail = normalizeBrowserSnapshotDetail(payload.detail);
    let text;
    if (detail === 'layout') {
      text = String(await withTimeout(
        withAbort(page.webContents.executeJavaScript(layoutSnapshotExpression(), true), options.signal),
        timeoutFor(payload.timeoutMs),
        'Browser layout snapshot timed out.'
      ));
    } else {
      const debuggerApi = await attachedDebugger(page.webContents);
      const response = await withTimeout(
        withAbort(debuggerApi.sendCommand('Accessibility.getFullAXTree'), options.signal),
        timeoutFor(payload.timeoutMs),
        'Browser accessibility snapshot timed out.'
      );
      text = serializeAccessibilityTree(response?.nodes || []);
    }
    const bounded = boundText(text, MAX_SNAPSHOT_CHARS);
    return { ...describePage(null, page), detail, snapshot: bounded.text, truncated: bounded.truncated };
  }

  async function interactPage(record, page, payload, options = {}) {
    assertAiControl(record, 'interact');
    const interaction = String(payload.interaction || '').trim();
    const timeoutMs = timeoutFor(payload.timeoutMs);
    if (interaction === 'wait') {
      await waitForTarget(page.webContents, payload.target, payload.state, timeoutMs, options.signal);
    } else if (interaction === 'press') {
      const key = String(payload.key || '').trim();
      if (!key) throw new Error('browser interact press requires key.');
      await waitForTarget(page.webContents, payload.target, 'visible', timeoutMs, options.signal);
      await focusTarget(page.webContents, payload.target);
      throwIfAborted(options.signal);
      await withAiInput(record, page, async () => sendKey(page.webContents, key));
    } else {
      if (interaction === 'select' && payload.selectValue == null) throw new Error('browser interact select requires selectValue.');
      await waitForTarget(page.webContents, payload.target, 'visible', timeoutMs, options.signal);
      throwIfAborted(options.signal);
      await runDomInteraction(page.webContents, interaction, payload);
    }
    publishState();
    return {
      ...describePage(record, page),
      interaction,
      target: publicTarget(payload.target)
    };
  }

  async function screenshotPage(record, page, payload, options = {}) {
    throwIfAborted(options.signal);
    const timeoutMs = timeoutFor(payload.timeoutMs);
    let data;
    let width;
    let height;
    const debuggerApi = await attachedDebugger(page.webContents);
    if (payload.fullPage === true) {
      const metrics = await withTimeout(
        withAbort(debuggerApi.sendCommand('Page.getLayoutMetrics'), options.signal),
        timeoutMs,
        'Browser screenshot metrics timed out.'
      );
      const size = metrics?.cssContentSize || metrics?.contentSize || {};
      const shot = await withTimeout(
        withAbort(debuggerApi.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: true
        }), options.signal),
        timeoutMs,
        'Browser screenshot timed out.'
      );
      data = String(shot?.data || '');
      width = Math.max(1, Math.ceil(Number(size.width || page.bounds.width || 1)));
      height = Math.max(1, Math.ceil(Number(size.height || page.bounds.height || 1)));
    } else {
      const shot = await withTimeout(
        withAbort(debuggerApi.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        }), options.signal),
        timeoutMs,
        'Browser screenshot timed out.'
      );
      data = String(shot?.data || '');
      width = record.viewport.width;
      height = record.viewport.height;
    }
    const bytes = Buffer.byteLength(data, 'base64');
    if (bytes > MAX_SCREENSHOT_BYTES) {
      throw new Error(`Browser screenshot is ${bytes} bytes; the limit is ${MAX_SCREENSHOT_BYTES} bytes. Use the current viewport instead of fullPage.`);
    }
    return {
      ...describePage(null, page),
      viewport: { ...record.viewport },
      image: { mimeType: 'image/png', data, bytes, width, height, fullPage: payload.fullPage === true }
    };
  }

  async function uploadFile(record, page, payload, options = {}) {
    assertAiControl(record, 'upload');
    const filePath = path.resolve(String(payload.filePath || ''));
    let file;
    try { file = fs.statSync(filePath); } catch { file = null; }
    if (!file?.isFile()) throw new Error('Browser upload file is unavailable.');
    const marker = `relai-upload-${crypto.randomBytes(10).toString('hex')}`;
    await waitForTarget(page.webContents, payload.target, 'attached', timeoutFor(payload.timeoutMs), options.signal);
    await markTarget(page.webContents, payload.target, marker);
    const debuggerApi = await attachedDebugger(page.webContents);
    try {
      const document = await debuggerApi.sendCommand('DOM.getDocument', { depth: 1, pierce: true });
      const query = await debuggerApi.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: `[data-relai-upload-marker="${marker}"]`
      });
      if (!query?.nodeId) throw new Error('Browser upload target is not a file input.');
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId: query.nodeId, files: [filePath] });
      await page.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-relai-upload-marker="${marker}"]'); if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
    } finally {
      await clearMarker(page.webContents, marker).catch(() => {});
    }
    return { ...describePage(record, page), interaction: 'upload', target: publicTarget(payload.target) };
  }

  async function beginDownload(record, page, payload, options = {}) {
    assertAiControl(record, 'download');
    await fs.promises.mkdir(DOWNLOAD_TEMP_ROOT, { recursive: true, mode: 0o700 });
    const pending = createPendingDownload(record, page, timeoutFor(payload.timeoutMs));
    void pending.promise.catch(() => {});
    try {
      await interactPage(record, page, payload, options);
      return await withAbort(pending.promise, options.signal, () => pending.cancel(cancelledError()));
    } catch (error) {
      pending.cancel(error);
      await pending.promise.catch(() => {});
      throw error;
    }
  }

  async function closePage(payload = {}) {
    const record = requireSession(payload.nativeSessionId);
    assertAiControl(record, 'close_page');
    const page = requirePage(record, payload.nativePageId);
    await destroyPage(record, page, { emit: false });
    publishState();
    return { ok: true, nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId, status: 'closed' };
  }

  async function closeSessionFromTool(value) {
    const nativeSessionId = assertSessionId(value);
    const record = sessions.get(nativeSessionId);
    if (record) assertAiControl(record, 'close_session');
    return closeSession(nativeSessionId, { emit: false });
  }

  async function closeSession(value, options = {}) {
    const nativeSessionId = assertSessionId(value);
    const record = sessions.get(nativeSessionId);
    if (!record) return { ok: true, nativeSessionId, status: 'closed' };
    sessions.delete(nativeSessionId);
    if (pinnedSessionId === nativeSessionId) pinnedSessionId = '';
    if (activeSessionId === nativeSessionId) activeSessionId = sessions.keys().next().value || '';
    for (const page of [...record.pages.values()]) await destroyPage(record, page, { emit: false });
    if (record.downloadListener) record.electronSession.removeListener?.('will-download', record.downloadListener);
    for (const entries of record.pendingDownloads.values()) {
      for (const pending of entries) pending.cancel(browserError('BROWSER_OPERATION_CANCELLED', 'Browser session closed before download completed.'));
    }
    record.pendingDownloads.clear();
    if (record.persistent) record.electronSession.setCertificateVerifyProc?.(null);
    if (!record.persistent) {
      await Promise.allSettled([
        Promise.resolve(record.electronSession.clearStorageData?.()),
        Promise.resolve(record.electronSession.clearCache?.())
      ]);
    }
    if (options.emit === true && !closingAll) {
      onEvent({ resource: 'browser', type: 'session_disconnected', nativeSessionId });
    }
    attachActiveView();
    publishState();
    return { ok: true, nativeSessionId, status: 'closed' };
  }

  async function stopActiveSession() {
    const record = visibleRecord();
    if (!record) return { ok: true, status: 'idle' };
    return closeSession(record.nativeSessionId, { emit: true });
  }

  async function closeAll() {
    closingAll = true;
    try {
      for (const nativeSessionId of [...sessions.keys()]) await closeSession(nativeSessionId, { emit: false });
      detachAttached();
      surfaceBounds = { visible: false, x: 0, y: 0, width: 1, height: 1 };
      publishState();
    } finally {
      closingAll = false;
    }
  }

  async function setBounds(payload = {}) {
    const visible = payload.visible === true;
    surfaceBounds = visible
      ? {
          visible: true,
          x: boundedInteger(payload.x, 0, 16_384, 0),
          y: boundedInteger(payload.y, 0, 16_384, 0),
          width: boundedInteger(payload.width, 1, 16_384, 1),
          height: boundedInteger(payload.height, 1, 16_384, 1)
        }
      : { ...surfaceBounds, visible: false };
    attachActiveView();
    const record = visibleRecord();
    const page = record ? activePage(record) : null;
    if (record && page) await syncPageRuntime(record, page);
    return getState();
  }

  async function setControl(owner) {
    const value = String(owner || '').trim();
    if (!CONTROL_OWNERS.has(value)) throw new Error('Browser control owner must be ai or user.');
    const record = value === 'ai' && pinnedSessionId
      ? sessions.get(pinnedSessionId) || activeRecord()
      : visibleRecord();
    if (!record) throw new Error('No embedded browser session is active.');
    record.control = value;
    if (value === 'user') {
      pinnedSessionId = record.nativeSessionId;
      const page = activePage(record);
      if (page) await syncPageRuntime(record, page);
      page?.webContents.focus?.();
    } else if (pinnedSessionId === record.nativeSessionId) {
      const page = activePage(record);
      if (page) await syncPageRuntime(record, page);
      pinnedSessionId = '';
      attachActiveView();
      const visible = visibleRecord();
      const visiblePage = visible ? activePage(visible) : null;
      if (visible && visiblePage) await syncPageRuntime(visible, visiblePage);
    } else {
      const page = activePage(record);
      if (page) await syncPageRuntime(record, page);
    }
    publishState();
    return getState();
  }

  function getState() {
    const record = visibleRecord();
    const page = record ? activePage(record) : null;
    const sessionSummaries = [...sessions.values()].map(candidate => {
      const candidatePage = activePage(candidate);
      return {
        nativeSessionId: candidate.nativeSessionId,
        active: candidate.nativeSessionId === record?.nativeSessionId,
        control: candidate.control,
        viewport: { ...candidate.viewport },
        pageCount: candidate.pages.size,
        url: candidatePage ? publicPageUrl(candidatePage.webContents.getURL()) : '',
        title: candidatePage ? String(candidatePage.webContents.getTitle?.() || '') : '',
        createdAt: candidate.createdAt
      };
    });
    const tabs = record ? [...record.pages.values()].map(candidate => ({
      nativePageId: candidate.nativePageId,
      active: candidate.nativePageId === record.activePageId,
      url: publicPageUrl(candidate.webContents.getURL()),
      title: String(candidate.webContents.getTitle?.() || ''),
      loading: candidate.loading === true,
      loadFailed: candidate.loadFailed === true,
      crashed: candidate.crashed === true,
      unresponsive: candidate.unresponsive === true,
      createdAt: candidate.createdAt
    })) : [];
    return {
      ok: true,
      available: true,
      active: Boolean(record),
      activeSessionCount: sessions.size,
      sessions: sessionSummaries,
      control: record?.control || 'ai',
      viewport: record ? { ...record.viewport } : null,
      nativeSessionId: record?.nativeSessionId || '',
      nativePageId: page?.nativePageId || '',
      pageCount: tabs.length,
      tabs,
      url: page ? publicPageUrl(page.webContents.getURL()) : '',
      title: page ? String(page.webContents.getTitle?.() || '') : '',
      loading: page?.loading === true,
      loadFailed: page?.loadFailed === true,
      crashed: page?.crashed === true,
      unresponsive: page?.unresponsive === true,
      lastLoadError: page?.lastLoadError || null,
      visible: surfaceBounds.visible === true && Boolean(attached)
    };
  }

  async function selectSession(value) {
    if (pinnedSessionId && pinnedSessionId !== String(value || '')) {
      throw browserError('BROWSER_USER_CONTROL_ACTIVE', 'Return control to AI before switching browser sessions.');
    }
    const record = requireSession(value);
    activeSessionId = record.nativeSessionId;
    attachActiveView();
    const page = activePage(record);
    if (page) await syncPageRuntime(record, page);
    publishState();
    return getState();
  }

  async function selectTab(value) {
    const record = visibleRecord();
    if (!record) throw new Error('No embedded browser session is active.');
    const page = requirePage(record, value);
    record.activePageId = page.nativePageId;
    attachActiveView();
    await syncPageRuntime(record, page);
    if (record.control === 'user') page.webContents.focus?.();
    publishState();
    return getState();
  }

  async function closeTab(value) {
    const record = visibleRecord();
    if (!record) throw new Error('No embedded browser session is active.');
    const page = requirePage(record, value);
    await destroyPage(record, page, { emit: true });
    return getState();
  }

  function configurePage(record, page) {
    const wc = page.webContents;
    wc.setWindowOpenHandler?.(details => {
      const target = String(details?.url || '');
      if (!supportedPageUrl(target, true)) return { action: 'deny' };
      const background = details?.disposition === 'background-tab';
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences: browserWebPreferences(record) },
        createWindow: options => {
          const child = createPage(record, {
            active: !background,
            webContents: options?.webContents,
            webPreferences: options?.webPreferences
          });
          onEvent({
            resource: 'browser',
            type: 'page_opened',
            nativeSessionId: record.nativeSessionId,
            nativePageId: child.nativePageId,
            active: !background
          });
          if (!options?.webContents && target !== 'about:blank') {
            void child.webContents.loadURL(target).catch(error => {
              onError(error);
              void destroyPage(record, child, { emit: true });
            });
          }
          return child.webContents;
        }
      };
    });
    const guardNavigation = (event, target) => {
      if (supportedPageUrl(target, true)) return;
      event.preventDefault();
      onError(new Error(`Blocked embedded browser navigation outside HTTP/HTTPS: ${String(target || '')}`));
    };
    wc.on('will-navigate', guardNavigation);
    wc.on('will-redirect', guardNavigation);
    wc.on('did-start-loading', () => { page.loading = true; page.loadFailed = false; publishState(); });
    wc.on('did-stop-loading', () => { page.loading = false; publishState(); });
    wc.on('did-finish-load', () => {
      page.loading = false;
      page.loadFailed = false;
      void syncPageRuntime(record, page).catch(onError);
      publishState();
    });
    wc.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      page.loading = false;
      page.loadFailed = true;
      page.lastLoadError = { code, description: String(description || ''), url: String(validatedUrl || '') };
      publishState();
      onError(new Error(`Embedded browser failed to load ${String(validatedUrl || page.webContents.getURL() || '')} (${code}): ${String(description || 'load failed')}`));
    });
    wc.on('unresponsive', () => { page.unresponsive = true; publishState(); });
    wc.on('responsive', () => { page.unresponsive = false; publishState(); });
    wc.on('did-navigate', () => { page.loadFailed = false; publishState(); });
    wc.on('did-navigate-in-page', () => publishState());
    wc.on('page-title-updated', () => publishState());
    wc.on('before-input-event', event => {
      if (record.control === 'ai' && page.aiInputDepth === 0) event.preventDefault();
    });
    wc.on('before-mouse-event', (event, mouse) => {
      if (record.control !== 'ai' || page.aiInputDepth !== 0) return;
      event.preventDefault();
      if (mouse?.type === 'mouseWheel') forwardWheelToDashboard(page, mouse);
    });
    wc.on('render-process-gone', (_event, details) => {
      if (page.closing) return;
      page.crashed = true;
      onEvent({
        resource: 'browser',
        type: 'page_crashed',
        nativeSessionId: record.nativeSessionId,
        nativePageId: page.nativePageId,
        reason: String(details?.reason || 'crashed')
      });
      publishState();
      const recoverUrl = publicPageUrl(page.webContents.getURL?.() || '');
      if (!recoverUrl || recoverUrl === 'about:blank') {
        void destroyPage(record, page, { emit: true, type: 'page_crashed' }).catch(onError);
        return;
      }
      try {
        page.crashed = false;
        page.closing = false;
        void page.webContents.reload?.();
      } catch (error) {
        void destroyPage(record, page, { emit: true, type: 'page_crashed' }).catch(() => {});
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    wc.once('destroyed', () => {
      if (page.closing) return;
      record.pages.delete(page.nativePageId);
      if (record.activePageId === page.nativePageId) record.activePageId = record.pages.keys().next().value || '';
      onEvent({ resource: 'browser', type: 'page_closed', nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId });
      attachActiveView();
      publishState();
    });
  }

  function secureBrowserSession(browserSession, ignoreHTTPSErrors) {
    browserSession.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler?.(() => false);
    if (typeof browserSession.setCertificateVerifyProc === 'function') {
      browserSession.setCertificateVerifyProc(ignoreHTTPSErrors ? ((_request, callback) => callback(0)) : null);
    }
  }

  function handleWillDownload(record, event, item, webContents) {
    const queue = record.pendingDownloads.get(webContents?.id);
    const pending = queue?.find(entry => entry.started !== true);
    if (!pending) {
      event.preventDefault();
      return;
    }
    pending.started = true;
    const suggestedFilename = String(item.getFilename?.() || 'download');
    const tempPath = path.join(DOWNLOAD_TEMP_ROOT, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.download`);
    item.setSavePath(tempPath);
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) {
        void fs.promises.rm(tempPath, { force: true }).catch(() => {});
        pending.reject(error);
      } else pending.resolve(result);
    };
    item.once('done', (_doneEvent, state) => {
      if (state !== 'completed') {
        settle(browserError('BROWSER_DOWNLOAD_FAILED', `Embedded browser download ended with state ${state}.`));
        return;
      }
      settle(null, { ok: true, tempPath, suggestedFilename });
    });
    pending.bindCancel(() => {
      try { item.cancel?.(); } catch {}
      settle(browserError('BROWSER_OPERATION_CANCELLED', 'Browser download was cancelled.'));
    });
  }

  function createPendingDownload(record, page, timeoutMs) {
    let entry;
    const promise = new Promise((resolve, reject) => {
      entry = {
        resolve,
        reject,
        bindCancel: fn => { entry.cancelItem = fn; },
        cancelItem: () => {},
        timer: null,
        started: false,
        cancel: error => {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(entry.timer);
          removePending(record, page, entry);
          entry.cancelItem();
          reject(error);
        },
        settled: false
      };
      entry.resolve = value => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        removePending(record, page, entry);
        resolve(value);
      };
      entry.reject = error => {
        if (entry.settled) return;
        entry.settled = true;
        clearTimeout(entry.timer);
        removePending(record, page, entry);
        reject(error);
      };
      entry.timer = setTimeout(() => entry.cancel(browserError('BROWSER_DOWNLOAD_TIMEOUT', 'Browser download did not complete before the timeout.')), timeoutMs);
      entry.timer.unref?.();
      const queue = record.pendingDownloads.get(page.webContents.id) || [];
      queue.push(entry);
      record.pendingDownloads.set(page.webContents.id, queue);
    });
    return { promise, cancel: error => entry?.cancel(error) };
  }

  function removePending(record, page, pending) {
    const queue = record.pendingDownloads.get(page.webContents.id);
    if (!queue) return;
    const index = queue.indexOf(pending);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) record.pendingDownloads.delete(page.webContents.id);
  }

  async function destroyPage(record, page, options = {}) {
    if (page.closing) return;
    page.closing = true;
    if (attached?.page === page) detachAttached();
    record.pages.delete(page.nativePageId);
    if (record.activePageId === page.nativePageId) record.activePageId = record.pages.keys().next().value || '';
    const pending = record.pendingDownloads.get(page.webContents.id) || [];
    for (const entry of [...pending]) entry.cancel(browserError('BROWSER_OPERATION_CANCELLED', 'Browser page closed before download completed.'));
    if (!page.webContents.isDestroyed?.()) page.webContents.close?.({ waitForBeforeUnload: false });
    if (!page.webContents.isDestroyed?.()) page.webContents.destroy?.();
    if (options.emit === true) {
      onEvent({
        resource: 'browser',
        type: options.type || 'page_closed',
        nativeSessionId: record.nativeSessionId,
        nativePageId: page.nativePageId
      });
    }
    attachActiveView();
    publishState();
  }

  function activate(record, page) {
    record.activePageId = page.nativePageId;
    if (record.control === 'ai') activeSessionId = record.nativeSessionId;
    attachActiveView();
  }

  function attachActiveView() {
    const record = visibleRecord();
    const page = record ? activePage(record) : null;
    const win = getDashboardWindow();
    if (!surfaceBounds.visible || !page || !win || win.isDestroyed?.()) {
      detachAttached();
      return;
    }
    const presentation = browserPresentation(record.viewport, surfaceBounds);
    if (attached?.page === page && attached.window === win) {
      page.bounds = presentation.bounds;
      page.presentationScale = presentation.scale;
      page.view.setBounds(page.bounds);
      return;
    }
    detachAttached();
    page.bounds = presentation.bounds;
    page.presentationScale = presentation.scale;
    page.view.setBounds(page.bounds);
    win.contentView.addChildView(page.view);
    attached = { page, window: win };
    if (record.control === 'user') page.webContents.focus?.();
  }

  function forwardWheelToDashboard(page, mouse) {
    const win = getDashboardWindow();
    if (attached?.page !== page || attached?.window !== win || win?.isDestroyed?.()) return;
    const x = Math.round(page.bounds.x + (Number(mouse?.x) || 0));
    const y = Math.round(page.bounds.y + (Number(mouse?.y) || 0));
    win.webContents?.sendInputEvent?.({
      type: 'mouseWheel',
      x,
      y,
      deltaX: Number(mouse?.deltaX) || 0,
      deltaY: Number(mouse?.deltaY) || 0,
      ...(Number.isFinite(Number(mouse?.wheelTicksX)) ? { wheelTicksX: Number(mouse.wheelTicksX) } : {}),
      ...(Number.isFinite(Number(mouse?.wheelTicksY)) ? { wheelTicksY: Number(mouse.wheelTicksY) } : {}),
      ...(mouse?.hasPreciseScrollingDeltas === true ? { hasPreciseScrollingDeltas: true } : {}),
      canScroll: mouse?.canScroll !== false,
      ...(Array.isArray(mouse?.modifiers) && mouse.modifiers.length ? { modifiers: mouse.modifiers } : {})
    });
  }

  function syncPageRuntime(record, page) {
    return enqueuePageRuntime(page, async () => {
      if (page.closing || page.webContents.isDestroyed?.()) return;
      if (attached?.page !== page || !surfaceBounds.visible) return;
      const url = publicPageUrl(page.webContents.getURL?.() || '');
      if (!url || url === 'about:blank') return;
      await nextTurn();
      if (page.closing || page.webContents.isDestroyed?.() || attached?.page !== page || !surfaceBounds.visible) return;
      const debuggerApi = await attachedDebugger(page.webContents);
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: record.viewport.width,
        height: record.viewport.height,
        deviceScaleFactor: 0,
        mobile: false,
        scale: page.presentationScale || 1
      });
      await debuggerApi.sendCommand('Input.setIgnoreInputEvents', { ignore: record.control !== 'user' });
    });
  }

  function detachAttached() {
    if (!attached) return;
    try {
      attached.page.presentationScale = 1;
      if (!attached.window.isDestroyed?.()) attached.window.contentView.removeChildView(attached.page.view);
    } catch {}
    attached = null;
  }

  function publishState() {
    const state = getState();
    onStateChange(state);
    const win = getDashboardWindow();
    if (win && !win.isDestroyed?.() && typeof win.webContents?.send === 'function') {
      win.webContents.send('desktop:browser-state', state);
    }
  }

  function activeRecord() {
    return activeSessionId ? sessions.get(activeSessionId) || null : null;
  }

  function visibleRecord() {
    if (pinnedSessionId) return sessions.get(pinnedSessionId) || activeRecord();
    return activeRecord();
  }

  function activePage(record) {
    return record?.activePageId ? record.pages.get(record.activePageId) || null : null;
  }

  function requireSession(value) {
    const id = assertSessionId(value);
    const record = sessions.get(id);
    if (!record) throw browserError('BROWSER_SESSION_NOT_FOUND', `Unknown or closed embedded browser session: ${id}.`);
    return record;
  }

  function requirePage(record, value) {
    const id = assertPageId(value);
    const page = record.pages.get(id);
    if (!page) throw browserError('BROWSER_TAB_NOT_FOUND', `Unknown or closed embedded browser page: ${id}.`);
    return page;
  }

  function assertAiControl(record, action) {
    if (record.control !== 'user') return;
    throw browserError('BROWSER_USER_CONTROL_ACTIVE', `The user currently controls this browser session. Return control to AI before ${action.replaceAll('_', ' ')}.`);
  }

  return Object.freeze({ run, getState, setBounds, setControl, selectSession, selectTab, closeTab, stopActiveSession, closeAll });
}

async function runDomInteraction(webContents, interaction, payload) {
  const target = JSON.stringify(normalizeTarget(payload.target));
  const input = JSON.stringify(String(payload.input ?? ''));
  const selectValue = JSON.stringify(String(payload.selectValue ?? ''));
  const script = `(() => {
    const target = ${target};
    const el = (${targetResolverSource()})(target);
    if (!el) throw new Error('Browser interaction target was not found.');
    const fire = name => el.dispatchEvent(new Event(name, { bubbles: true }));
    switch (${JSON.stringify(interaction)}) {
      case 'click': el.click(); break;
      case 'fill': {
        const value = ${input};
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value); else el.value = value;
        fire('input'); fire('change'); break;
      }
      case 'select': el.value = ${selectValue}; fire('input'); fire('change'); break;
      case 'hover': el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); break;
      default: throw new Error('Unsupported browser interaction: ' + ${JSON.stringify(interaction)});
    }
    return true;
  })()`;
  return webContents.executeJavaScript(script, true);
}

async function focusTarget(webContents, target) {
  const encoded = JSON.stringify(normalizeTarget(target));
  return webContents.executeJavaScript(`(() => { const el = (${targetResolverSource()})(${encoded}); if (!el) throw new Error('Browser interaction target was not found.'); el.focus(); return true; })()`, true);
}

async function waitForTarget(webContents, target, stateValue, timeoutMs, signal) {
  const state = ['visible', 'hidden', 'attached', 'detached'].includes(String(stateValue || '')) ? String(stateValue) : 'visible';
  const encoded = JSON.stringify(normalizeTarget(target));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    throwIfAborted(signal);
    const result = await withAbort(webContents.executeJavaScript(`(() => {
      const el = (${targetResolverSource()})(${encoded});
      if (!el) return { attached: false, visible: false };
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
      return { attached: el.isConnected, visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0 };
    })()`, true), signal);
    if (
      (state === 'visible' && result.visible) ||
      (state === 'hidden' && !result.visible) ||
      (state === 'attached' && result.attached) ||
      (state === 'detached' && !result.attached)
    ) return;
    if (Date.now() >= deadline) throw new Error(`Browser wait timed out waiting for target to become ${state}.`);
    await delay(50, signal);
  }
}

async function markTarget(webContents, target, marker) {
  const encoded = JSON.stringify(normalizeTarget(target));
  const safeMarker = JSON.stringify(marker);
  const result = await webContents.executeJavaScript(`(() => { const el = (${targetResolverSource()})(${encoded}); if (!(el instanceof HTMLInputElement) || el.type !== 'file') return false; el.setAttribute('data-relai-upload-marker', ${safeMarker}); return true; })()`, true);
  if (!result) throw new Error('Browser upload target is not a file input.');
}

async function clearMarker(webContents, marker) {
  const safeMarker = JSON.stringify(marker);
  return webContents.executeJavaScript(`(() => { const marker = ${safeMarker}; const el = document.querySelector('[data-relai-upload-marker="' + CSS.escape(marker) + '"]'); el?.removeAttribute('data-relai-upload-marker'); })()`, true);
}

function targetResolverSource() {
  return `(target) => {
    const normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const exact = target.exact === true;
    const wanted = normalize(target.value);
    const matches = actual => exact ? normalize(actual) === wanted : normalize(actual).toLowerCase().includes(wanted.toLowerCase());
    const referencedText = ids => normalize(String(ids || '').split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
    const labelText = el => normalize(el.labels ? [...el.labels].map(label => label.textContent || '').join(' ') : '');
    const nameOf = el => normalize(
      referencedText(el.getAttribute('aria-labelledby')) ||
      el.getAttribute('aria-label') ||
      labelText(el) ||
      el.alt ||
      el.title ||
      el.textContent ||
      el.value ||
      ''
    );
    const roleOf = el => {
      const explicit = normalize(el.getAttribute('role')).toLowerCase(); if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'button') return 'button';
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'img') return 'img';
      if (tag === 'option') return 'option';
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        return 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return '';
    };
    let nodes = [];
    if (target.by === 'css') nodes = [...document.querySelectorAll(target.value)];
    else if (target.by === 'testid') nodes = [...document.querySelectorAll('[data-testid]')].filter(el => el.getAttribute('data-testid') === target.value);
    else if (target.by === 'placeholder') nodes = [...document.querySelectorAll('[placeholder]')].filter(el => matches(el.getAttribute('placeholder')));
    else if (target.by === 'label') nodes = [...document.querySelectorAll('input,textarea,select,button,meter,output,progress')].filter(el => matches(nameOf(el)));
    else if (target.by === 'role') {
      const role = normalize(target.value).toLowerCase();
      const name = target.name == null ? '' : normalize(target.name);
      nodes = [...document.querySelectorAll('*')].filter(el => roleOf(el) === role && (!name || (exact ? nameOf(el) === name : nameOf(el).toLowerCase().includes(name.toLowerCase()))));
    }
    else if (target.by === 'text') nodes = [...document.querySelectorAll('body *')].filter(el => matches(el.textContent) && ![...el.children].some(child => matches(child.textContent)));
    else throw new Error('Unsupported target.by: ' + target.by);
    return nodes[Math.max(0, Number.isInteger(Number(target.index)) ? Number(target.index) : 0)] || null;
  }`;
}

async function attachedDebugger(webContents) {
  const debuggerApi = webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
  return debuggerApi;
}

async function sendKey(webContents, key) {
  const parts = String(key || '').split('+').map(part => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Browser key is required.');
  const rawKey = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === 'control' || normalized === 'ctrl') modifiers.push('control');
    else if (normalized === 'alt') modifiers.push('alt');
    else if (normalized === 'shift') modifiers.push('shift');
    else if (normalized === 'meta' || normalized === 'command' || normalized === 'cmd') modifiers.push('meta');
    else if (normalized === 'controlormeta') modifiers.push(process.platform === 'darwin' ? 'meta' : 'control');
    else throw new Error(`Unsupported browser key modifier: ${part}.`);
  }
  const base = { keyCode: rawKey, ...(modifiers.length ? { modifiers } : {}) };
  webContents.sendInputEvent({ type: 'keyDown', ...base });
  if (rawKey.length === 1 && modifiers.length === 0) webContents.sendInputEvent({ type: 'char', ...base });
  webContents.sendInputEvent({ type: 'keyUp', ...base });
}

async function withAiInput(record, page, action) {
  return enqueuePageRuntime(page, async () => {
    const debuggerApi = await attachedDebugger(page.webContents);
    await debuggerApi.sendCommand('Input.setIgnoreInputEvents', { ignore: false });
    page.aiInputDepth += 1;
    try { return await action(); }
    finally {
      page.aiInputDepth = Math.max(0, page.aiInputDepth - 1);
      await debuggerApi.sendCommand('Input.setIgnoreInputEvents', { ignore: record.control !== 'user' });
    }
  });
}

function enqueuePageRuntime(page, action) {
  const previous = page.runtimePromise || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  page.runtimePromise = current;
  return current;
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function serializeAccessibilityTree(nodes) {
  const lines = [];
  for (const node of nodes) {
    if (node?.ignored === true) continue;
    const role = axValue(node?.role);
    const name = axValue(node?.name);
    const value = axValue(node?.value);
    if (!role && !name && !value) continue;
    const parts = [role || 'node'];
    if (name) parts.push(JSON.stringify(name));
    if (value && value !== name) parts.push(`value=${JSON.stringify(value)}`);
    lines.push(`- ${parts.join(' ')}`);
  }
  return lines.join('\n');
}

function axValue(entry) {
  const value = entry && typeof entry === 'object' ? entry.value : entry;
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function normalizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('interact requires target.');
  const by = String(value.by || '').trim();
  const targetValue = String(value.value || '');
  if (!['role', 'text', 'label', 'placeholder', 'testid', 'css'].includes(by)) throw new Error(`Unsupported target.by '${by || '(missing)'}.`);
  if (!targetValue) throw new Error('target.value is required.');
  const index = Number(value.index);
  return {
    by,
    value: targetValue,
    ...(value.name ? { name: String(value.name) } : {}),
    ...(value.exact === true ? { exact: true } : {}),
    ...(Number.isInteger(index) && index >= 0 ? { index } : {})
  };
}

function publicTarget(value) {
  return normalizeTarget(value);
}

function supportedPageUrl(value, allowBlank = false) {
  const raw = String(value || '');
  if (allowBlank && raw === 'about:blank') return true;
  try { return ['http:', 'https:'].includes(new URL(raw).protocol); }
  catch { return false; }
}

function normalizeBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!supportedPageUrl(raw)) throw new Error('Browser url must be an absolute http or https URL.');
  return new URL(raw).href;
}

function publicPageUrl(value) {
  const raw = String(value || '');
  return supportedPageUrl(raw, true) ? raw : '';
}

function assertSessionId(value) {
  const id = String(value || '').trim();
  if (!SESSION_ID.test(id)) throw new Error('Invalid embedded browser session identifier.');
  return id;
}

function assertPageId(value) {
  const id = String(value || '').trim();
  if (!PAGE_ID.test(id)) throw new Error('Invalid embedded browser page identifier.');
  return id;
}

function timeoutFor(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(100, Math.min(30_000, Math.floor(parsed))) : 10_000;
}

function normalizeViewport(value) {
  const viewport = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    width: boundedInteger(viewport.width, 320, 3840, 1440),
    height: boundedInteger(viewport.height, 240, 2160, 900)
  };
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function browserPresentation(viewport, bounds) {
  const scale = Math.max(0.01, Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height));
  const width = Math.max(1, Math.round(viewport.width * scale));
  const height = Math.max(1, Math.round(viewport.height * scale));
  return {
    scale,
    bounds: {
      x: bounds.x + Math.max(0, Math.floor((bounds.width - width) / 2)),
      y: bounds.y + Math.max(0, Math.floor((bounds.height - height) / 2)),
      width,
      height
    }
  };
}

function boundText(value, limit) {
  const text = String(value || '');
  return text.length <= limit ? { text, truncated: false } : { text: `${text.slice(0, Math.max(0, limit - 1))}…`, truncated: true };
}

function browserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function withAbort(promise, signal, onAbort = () => {}) {
  if (!signal) return Promise.resolve(promise);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try { onAbort(); } catch {}
      reject(cancelledError(signal.reason));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError(signal.reason);
}

function cancelledError(reason) {
  return browserError('BROWSER_OPERATION_CANCELLED', reason instanceof Error ? reason.message : String(reason || 'Browser operation cancelled.'));
}

function delay(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return withAbort(new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }), signal);
}

export { DOWNLOAD_TEMP_ROOT, createBrowserSurfaceHost };
