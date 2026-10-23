import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { layoutSnapshotExpression, normalizeBrowserSnapshotDetail } from '../src/browser/layoutSnapshot.js';
import { goalComposerExpression, goalStopExpression, goalMessageExists, goalAssistantSettled } from './chatgpt-goal-composer.js';
import { readConversationProjection } from '../src/chatgptConversationReader.js';
import { parseConversationUrl } from '../src/chatgptGoalProtocol.js';
import { buildGoalEvaluatorPrompt } from '../src/chatgptGoalEvaluator.js';
import { runGoalHelperBrowser } from './chatgpt-goal-helper.js';

const MAX_SNAPSHOT_CHARS = 64 * 1024;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const PERMISSION_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_CLOSE_TIMEOUT_MS = 5_000;
const DOWNLOAD_TEMP_ROOT = path.resolve(os.tmpdir(), 'relai-browser-downloads');
const CONTROL_OWNERS = new Set(['ai', 'user']);
const READ_ONLY_ACTIONS = new Set(['describe', 'snapshot', 'screenshot']);
const SESSION_ID = /^embedded_browser_[A-Za-z0-9_-]{16,160}$/;
const PAGE_ID = /^embedded_page_[A-Za-z0-9_-]{16,160}$/;

function goalConversationMatches(webContents, conversationId) {
  try {
    return parseConversationUrl(webContents.getURL()).toLowerCase() === conversationId.toLowerCase();
  } catch {
    return false;
  }
}

function createBrowserSurfaceHost(options = {}) {
  const {
    BrowserWindow,
    WebContentsView,
    session,
    getDashboardWindow,
    openDashboard = async () => {},
    clearPersistentData = async () => ({ cleared: false }),
    listPersistentProfiles = async () => [],
    readPersistentSites = async () => [],
    recordPersistentSite = async () => {},
    flushPersistentSites = async () => {},
    forgetPersistentSite = async () => {},
    onEvent = () => {},
    onStateChange = () => {},
    onError = () => {},
    goalLoginProfileDirectory = '',
    getGoalConnections = null,
    assertGoalCurrent = null
  } = options;
  if (typeof WebContentsView !== 'function') throw new TypeError('Embedded browser requires Electron WebContentsView.');
  if (!session || typeof session.fromPartition !== 'function' || typeof session.fromPath !== 'function') {
    throw new TypeError('Embedded browser requires the Electron session API.');
  }
  if (typeof getDashboardWindow !== 'function') throw new TypeError('Embedded browser requires a dashboard-window getter.');

  const sessions = new Map();
  const clearingProfiles = new Set();
  let clearingSavedData = false;
  let activeSessionId = '';
  let pinnedSessionId = '';
  let surfaceBounds = { visible: false, x: 0, y: 0, width: 1, height: 1 };
  let attached = null;
  let closingAll = null;
  const goalProfileDirectory = goalLoginProfileDirectory ? path.resolve(goalLoginProfileDirectory) : '';
  const goalLoginSessionIds = new Map();
  const goalLoginOpenings = new Map();
  const goalProtocolAuth = new Map();
  const goalProtocolLimits = new Map();
  const confirmedGoalLogins = new Set();
  const goalWindowAccounts = new Map();
  const goalAccountsDirectory = goalProfileDirectory ? path.join(path.dirname(goalProfileDirectory), 'goal-chatgpt-accounts') : '';
  const goalContinuationWindows = new Set();
  let goalContinuationInFlight = false;

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
      case 'set_control': return setControlForSession(payload.nativeSessionId, payload.owner, payload.reason);
      case 'clear_profile': return clearProfileSession(payload.profileDirectory);
      case 'close_page': return closePage(payload);
      case 'close_session': return closeSessionFromTool(payload.nativeSessionId);
      default: throw new Error(`Unsupported embedded browser action '${action || '(missing)'}.`);
    }
  }

  async function startSession(payload = {}, options = {}) {
    throwIfAborted(options.signal);
    if (closingAll) throw cancelledError('Embedded browser sessions are closing.');
    const nativeSessionId = `embedded_browser_${crypto.randomBytes(18).toString('base64url')}`;
    const profileDirectory = String(payload.profileDirectory || '').trim();
    const persistent = Boolean(profileDirectory);
    if (persistent && (clearingSavedData || clearingProfiles.has(profileDirectoryKey(profileDirectory)))) {
      throw browserError('BROWSER_PROFILE_ALREADY_ACTIVE', 'The persistent browser profile is still being cleared. Try again after it finishes.');
    }
    const viewport = normalizeViewport(payload.viewport);
    const browserSession = persistent
      ? session.fromPath(path.resolve(profileDirectory))
      : session.fromPartition(`relai-browser:${nativeSessionId}`);
    const record = {
      nativeSessionId,
      electronSession: browserSession,
      persistent,
      profileDirectory: persistent ? path.resolve(profileDirectory) : '',
      viewport,
      pages: new Map(),
      activePageId: '',
      control: 'ai',
      handoffReason: '',
      createdAt: new Date().toISOString(),
      pendingDownloads: new Map(),
      pendingPermissions: new Map(),
      permissionGrants: new Set(),
      downloadListener: null
    };
    secureBrowserSession(record, payload.ignoreHTTPSErrors === true);
    record.downloadListener = (event, item, webContents) => handleWillDownload(record, event, item, webContents);
    browserSession.on('will-download', record.downloadListener);
    sessions.set(nativeSessionId, record);
    activeSessionId = nativeSessionId;
    publishState();
    try {
      await withAbort(openDashboard('#browser'), options.signal);
      if (sessions.get(nativeSessionId) !== record || record.closePromise) throw cancelledError('Browser session closed during startup.');
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
    assertPageMutation(record, page, 'open_page');
    return { ok: true, nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId, ...describePage(record, page) };
  }

  function createPage(record, options = {}) {
    if (sessions.get(record.nativeSessionId) !== record || record.closePromise) throw cancelledError('Browser session is closing.');
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
    if (page.recovering || page.crashed) {
      if (action === 'describe') return { ...describePage(record, page), recovering: page.recovering === true };
      throw browserError('BROWSER_TAB_RECOVERING', 'The embedded browser tab is recovering. Wait for recovery before retrying.');
    }
    if (!READ_ONLY_ACTIONS.has(action)) assertAiControl(record, action);
    if (action !== 'describe') activate(record, page);
    await syncPageRuntime(record, page);
    if (!READ_ONLY_ACTIONS.has(action)) assertPageMutation(record, page, action);
    const result = await operation(record, page, payload, options);
    if (action === 'navigate') await syncPageRuntime(record, page);
    return result;
  }

  function describePage(_record, page) {
    return {
      url: publicPageUrl(page.webContents.getURL()),
      title: String(page.webContents.getTitle?.() || ''),
      loading: page.loading === true,
      ...(browserFrameSummaries(page.webContents).length ? { frames: browserFrameSummaries(page.webContents) } : {})
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
      assertPageMutation(record, page, 'interact');
      await focusTarget(page.webContents, payload.target);
      const assertInputAllowed = () => {
        throwIfAborted(options.signal);
        assertPageMutation(record, page, 'interact');
      };
      await withAiInput(record, page, async () => sendKey(page.webContents, key), assertInputAllowed);
    } else {
      if (interaction === 'select' && payload.selectValue == null) throw new Error('browser interact select requires selectValue.');
      await waitForTarget(page.webContents, payload.target, 'visible', timeoutMs, options.signal);
      throwIfAborted(options.signal);
      assertPageMutation(record, page, 'interact');
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
    if (payload.target?.frame) throw new Error('Browser uploads inside frames are not supported. Take control to complete this upload manually.');
    const filePath = path.resolve(String(payload.filePath || ''));
    let file;
    try { file = fs.statSync(filePath); } catch { file = null; }
    if (!file?.isFile()) throw new Error('Browser upload file is unavailable.');
    const marker = `relai-upload-${crypto.randomBytes(10).toString('hex')}`;
    await waitForTarget(page.webContents, payload.target, 'attached', timeoutFor(payload.timeoutMs), options.signal);
    throwIfAborted(options.signal);
    assertPageMutation(record, page, 'upload');
    await markTarget(page.webContents, payload.target, marker);
    const debuggerApi = await attachedDebugger(page.webContents);
    try {
      const document = await debuggerApi.sendCommand('DOM.getDocument', { depth: 1, pierce: true });
      const query = await debuggerApi.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: `[data-relai-upload-marker="${marker}"]`
      });
      if (!query?.nodeId) throw new Error('Browser upload target is not a file input.');
      throwIfAborted(options.signal);
      assertPageMutation(record, page, 'upload');
      await debuggerApi.sendCommand('DOM.setFileInputFiles', { nodeId: query.nodeId, files: [filePath] });
      throwIfAborted(options.signal);
      assertPageMutation(record, page, 'upload');
      await page.webContents.executeJavaScript(`(() => { const el = document.querySelector('[data-relai-upload-marker="${marker}"]'); if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
    } finally {
      await clearMarker(page.webContents, marker).catch(() => {});
    }
    return { ...describePage(record, page), interaction: 'upload', target: publicTarget(payload.target) };
  }

  async function beginDownload(record, page, payload, options = {}) {
    assertAiControl(record, 'download');
    await fs.promises.mkdir(DOWNLOAD_TEMP_ROOT, { recursive: true, mode: 0o700 });
    throwIfAborted(options.signal);
    assertPageMutation(record, page, 'download');
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

  function closeSession(value, options = {}) {
    const nativeSessionId = assertSessionId(value);
    const record = sessions.get(nativeSessionId);
    if (!record) return Promise.resolve({ ok: true, nativeSessionId, status: 'closed' });
    if (record.closePromise) return record.closePromise;
    record.closePromise = Promise.resolve().then(async () => {
      for (const page of [...record.pages.values()]) await destroyPage(record, page, { emit: false });
      if (record.downloadListener) record.electronSession.removeListener?.('will-download', record.downloadListener);
      for (const entries of record.pendingDownloads.values()) {
        for (const pending of entries) pending.cancel(browserError('BROWSER_OPERATION_CANCELLED', 'Browser session closed before download completed.'));
      }
      record.pendingDownloads.clear();
      for (const pending of record.pendingPermissions.values()) settlePermissionRequest(record, pending, false);
      record.pendingPermissions.clear();
      record.permissionGrants.clear();
      if (record.persistent) record.electronSession.setCertificateVerifyProc?.(null);
      if (!record.persistent) {
        await Promise.allSettled([
          Promise.resolve(record.electronSession.clearStorageData?.()),
          Promise.resolve(record.electronSession.clearCache?.())
        ]);
      }
      sessions.delete(nativeSessionId);
      for (const [account, id] of goalLoginSessionIds) if (id === nativeSessionId) goalLoginSessionIds.delete(account);
      confirmedGoalLogins.delete(nativeSessionId);
      if (pinnedSessionId === nativeSessionId) pinnedSessionId = '';
      if (activeSessionId === nativeSessionId) activeSessionId = sessions.keys().next().value || '';
      if (options.emit === true && !closingAll) {
        onEvent({ resource: 'browser', type: 'session_disconnected', nativeSessionId });
      }
      return { ok: true, nativeSessionId, status: 'closed' };
    }).finally(() => {
      record.closePromise = null;
      attachActiveView();
      publishState();
    });
    return record.closePromise;
  }

  async function clearProfileSession(value) {
    const profileDirectory = String(value || '').trim();
    if (!path.isAbsolute(profileDirectory)) throw new Error('Persistent browser profile must be an absolute path.');
    const directory = path.resolve(profileDirectory);
    const profileKey = profileDirectoryKey(directory);
    if (clearingSavedData || clearingProfiles.has(profileKey) || [...sessions.values()].some(record => record.persistent && profileDirectoryKey(record.profileDirectory) === profileKey)) {
      throw browserError('BROWSER_PROFILE_ALREADY_ACTIVE', 'Stop the persistent browser session and wait for any current clear to finish before clearing its saved site data.');
    }
    clearingProfiles.add(profileKey);
    try {
      await clearNativeProfileData(directory);
      return { ok: true, cleared: true };
    } finally {
      clearingProfiles.delete(profileKey);
    }
  }

  async function savedProfileDirectories() {
    const configured = await Promise.resolve(listPersistentProfiles());
    const accountProfiles = goalAccountsDirectory
      ? (await fs.promises.readdir(goalAccountsDirectory, { withFileTypes: true }).catch(() => []))
        .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).map(entry => path.join(goalAccountsDirectory, entry.name)) : [];
    return [...new Set([...(Array.isArray(configured) ? configured : []), ...accountProfiles,
      ...(goalProfileDirectory ? [goalProfileDirectory] : [])])];
  }

  async function listSavedSites() {
    const profiles = await savedProfileDirectories();
    const sites = new Map();
    for (const profileDirectory of Array.isArray(profiles) ? profiles : []) {
      const directory = path.resolve(String(profileDirectory || ''));
      if (!directory) continue;
      const electronSession = session.fromPath(directory);
      const [registered, cookies] = await Promise.all([
        Promise.resolve(readPersistentSites(directory)).catch(() => []),
        Promise.resolve(electronSession.cookies?.get?.({})).catch(() => [])
      ]);
      const origins = new Set((Array.isArray(registered) ? registered : []).map(normalizeSavedSiteOrigin).filter(Boolean));
      for (const cookie of Array.isArray(cookies) ? cookies : []) {
        const origin = cookieSiteOrigin(cookie);
        const hostname = safeOriginHostname(origin);
        if (origin && ![...origins].some(candidate => safeOriginHostname(candidate) === hostname)) origins.add(origin);
      }
      for (const origin of origins) {
        const current = sites.get(origin) || { origin, host: safeOriginHost(origin), profileCount: 0 };
        current.profileCount += 1;
        sites.set(origin, current);
      }
    }
    return { ok: true, sites: [...sites.values()].sort((left, right) => left.host.localeCompare(right.host) || left.origin.localeCompare(right.origin)) };
  }

  async function clearSavedSite(value) {
    const origin = normalizeSavedSiteOrigin(value);
    if (!origin) throw new Error('Saved browser site must be an absolute HTTP or HTTPS origin.');
    return withSavedDataClear(async () => {
      const profiles = await savedProfileDirectories();
      let cleared = false;
      for (const profileDirectory of Array.isArray(profiles) ? profiles : []) {
        const directory = path.resolve(String(profileDirectory || ''));
        if (!directory) continue;
        await clearNativeProfileData(directory, origin);
        cleared = true;
        await Promise.resolve(forgetPersistentSite(directory, origin));
      }
      return { ok: true, origin, cleared };
    });
  }

  async function clearSavedData() {
    return withSavedDataClear(async () => {
      const profiles = await savedProfileDirectories();
      for (const profileDirectory of Array.isArray(profiles) ? profiles : []) {
        const directory = path.resolve(String(profileDirectory || ''));
        if (!directory) continue;
        await clearNativeProfileData(directory);
      }
      const result = await clearPersistentData();
      return { ok: true, cleared: result?.cleared === true };
    });
  }

  async function withSavedDataClear(action) {
    if (clearingSavedData || clearingProfiles.size || goalContinuationWindows.size || [...sessions.values()].some(record => record.persistent)) {
      throw browserError('BROWSER_PROFILE_ALREADY_ACTIVE', 'Stop persistent browser sessions and wait for any current clear to finish before clearing saved browser data.');
    }
    clearingSavedData = true;
    try {
      const result = await action();
      publishState();
      return result;
    } catch (error) {
      throw browserError('BROWSER_SAVED_DATA_CLEAR_FAILED', `Browser data clearing did not finish. Some site data may already have been cleared. ${String(error?.message || error)}`);
    } finally {
      clearingSavedData = false;
    }
  }

  async function clearNativeProfileData(directory, origin = '') {
    goalProtocolAuth.delete(directory);
    try {
      await flushPersistentSites(directory);
      const browserSession = session.fromPath(directory);
      await browserSession.clearStorageData(origin ? { origin } : undefined);
      if (!origin) {
        await browserSession.clearCache();
        await browserSession.clearAuthCache?.();
      }
    } finally { goalProtocolAuth.delete(directory); }
  }

  function goalAccount(tunnelId = '') {
    if (!goalProfileDirectory) throw Object.assign(new Error('Goal Mode sign-in is unavailable.'), { code: 'GOAL_ACCOUNT_UNAVAILABLE' });
    if (!getGoalConnections) return { tunnelId: '', directory: goalProfileDirectory };
    const connection = getGoalConnections().find(item => item.tunnelId === tunnelId && item.enabled !== false);
    if (!connection || !/^tunnel_[A-Za-z0-9_-]{8,200}$/.test(tunnelId)) {
      throw Object.assign(new Error('Select the configured tunnel for this ChatGPT Goal Mode account.'), { code: 'GOAL_ACCOUNT_UNAVAILABLE' });
    }
    return { tunnelId, label: connection.label, enabled: connection.enabled !== false,
      directory: path.join(goalAccountsDirectory, crypto.createHash('sha256').update(tunnelId).digest('hex')) };
  }

  async function startGoalLogin(input = {}) {
    const account = goalAccount(String(input.tunnelId || ''));
    const conversationId = input.conversationId ? parseConversationUrl(input.conversationId) : '';
    if (goalLoginOpenings.has(account.tunnelId)) {
      const pending = goalLoginOpenings.get(account.tunnelId);
      return conversationId ? pending.then(() => openGoalLogin(account, conversationId)) : pending;
    }
    const opening = openGoalLogin(account, conversationId);
    goalLoginOpenings.set(account.tunnelId, opening);
    try { return await opening; } finally {
      if (goalLoginOpenings.get(account.tunnelId) === opening) goalLoginOpenings.delete(account.tunnelId);
    }
  }

  async function openGoalLogin(account, conversationId = '') {
    const url = conversationId ? 'https://chatgpt.com/c/' + conversationId : 'https://chatgpt.com/';
    const existing = sessions.get(goalLoginSessionIds.get(account.tunnelId));
    if (existing && !existing.closePromise) {
      if (conversationId) {
        // This is an explicit dashboard navigation in a new tab. Keep the
        // user's existing tab/control intact; AI tools still use openPage gates.
        const page = createPage(existing, { active: true });
        try {
          await withTimeout(page.webContents.loadURL(url), 18_000, 'ChatGPT navigation timed out.');
          await syncPageRuntime(existing, page);
        } catch (error) {
          page.webContents.stop?.();
          await destroyPage(existing, page, { emit: true });
          throw error;
        }
      }
      confirmedGoalLogins.delete(existing.nativeSessionId);
      await setControlForSession(existing.nativeSessionId, 'user', 'goal_login');
      return { ok: true, browserOpen: true, ...(account.tunnelId ? { tunnelId: account.tunnelId } : {}) };
    }
    const started = await startSession({ profileDirectory: account.directory });
    goalLoginSessionIds.set(account.tunnelId, started.nativeSessionId);
    try {
      const opened = await openPage({ nativeSessionId: started.nativeSessionId });
      const record = requireSession(started.nativeSessionId);
      const page = requirePage(record, opened.nativePageId);
      await navigatePage(record, page, { url });
      await setControlForSession(started.nativeSessionId, 'user', 'goal_login');
      return { ok: true, browserOpen: true, ...(account.tunnelId ? { tunnelId: account.tunnelId } : {}) };
    } catch (error) {
      await closeSession(started.nativeSessionId, { emit: false }).catch(() => {});
      throw error;
    }
  }

  async function getGoalLoginStatus(input = {}) {
    if (!goalProfileDirectory) return { ok: true, available: false, state: 'unavailable' };
    if (getGoalConnections && !input.tunnelId) {
      const connections = await Promise.all(getGoalConnections().map(connection => connection.enabled === false
        ? { ...connection, available: false, state: 'disabled', browserOpen: false }
        : getGoalLoginStatus({ tunnelId: connection.tunnelId })));
      return { ok: true, available: true, connections };
    }
    const disabled = getGoalConnections?.().find(item => item.tunnelId === input.tunnelId && item.enabled === false);
    if (disabled) return { ...disabled, ok: true, available: false, state: 'disabled', browserOpen: false };
    const account = goalAccount(String(input.tunnelId || ''));
    const loginId = goalLoginSessionIds.get(account.tunnelId);
    const browserOpen = sessions.has(loginId);
    const browserSession = session.fromPath(account.directory);
    const metadata = { ok: true, available: true, browserOpen,
      ...(account.tunnelId ? { tunnelId: account.tunnelId, label: account.label, enabled: account.enabled } : {}) };
    try {
      const rateLimit = goalReadAdmission(account, true);
      if (rateLimit) return { ...metadata, state: 'unverified', retryAfterMs: rateLimit.retryAfterMs };
      const auth = await readGoalProtocolAuth(account, browserSession, input.refresh === true);
      if (!auth.ok) {
        rememberGoalReadLimit(account, auth);
        if (auth.status === 401) confirmedGoalLogins.delete(loginId);
        return { ...metadata, state: auth.status === 401 ? 'sign_in_required' : 'unverified',
          ...(auth.retryAfterMs ? { retryAfterMs: auth.retryAfterMs } : {}) };
      }
      if (account.tunnelId && (input.refresh === true || (browserOpen && loginId && !confirmedGoalLogins.has(loginId)))) {
        if (loginId) confirmedGoalLogins.add(loginId);
        onEvent({ resource: 'goal', type: 'account_signed_in', tunnelId: account.tunnelId });
      }
      return { ...metadata, state: 'signed_in', account: auth.account };
    } catch {
      return { ...metadata, state: 'unverified' };
    }
  }

  // Only the trusted local service can request these fixed ChatGPT endpoints.
  // Account credentials never cross the native IPC boundary or enter task logs.
  // One signed-in ChatGPT page per continuation. Hidden during normal operation;
  // Failed attempts stay hidden. The service owns retries and receipt reconciliation.
  function assertGoalMutation(payload) {
    // Production injects a synchronous read of the authoritative durable state.
    // Recheck at the final native key event, not only across service IPC.
    if (!assertGoalCurrent && payload.expectedGoalRevision === undefined) return;
    if (typeof assertGoalCurrent !== 'function' || !payload.workId
      || !Number.isSafeInteger(payload.expectedGoalRevision) || payload.expectedGoalRevision < 0
      || !payload.conversationId
      || payload.action === 'evaluate' && (payload.packet?.expectedRevision !== payload.expectedGoalRevision
        || payload.packet?.evidence?.workId !== payload.workId)) {
      throw Object.assign(new Error('Goal browser submission requires a current revision fence.'), {
        code: 'GOAL_REVISION_STALE', stale: true, notSent: true
      });
    }
    assertGoalCurrent({ workId: payload.workId, expectedGoalRevision: payload.expectedGoalRevision,
      conversationId: payload.conversationId, tunnelId: payload.tunnelId || '' });
  }

  async function goalBrowserContinue(payload = {}, options = {}) {
    assertGoalMutation(payload);
    const account = goalAccount(String(payload.tunnelId || ''));
    const rateLimit = goalReadAdmission(account);
    if (rateLimit) return rateLimit;
    const id = String(payload.conversationId || '');
    const expectedNode = String(payload.expectedNodeId || '');
    const parentMessageId = String(payload.parentMessageId || '');
    const prompt = String(payload.prompt || '');
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      || !expectedNode || !parentMessageId || !prompt || prompt.length > 8192) {
      throw new Error('Goal Mode continuation requires a valid conversation and exact parent.');
    }
    if (!goalProfileDirectory || typeof BrowserWindow !== 'function') {
      throw new Error('Goal Mode background browser is not available.');
    }
    if (goalContinuationInFlight) return { ok: false, busy: true, notSent: true };
    const browserSession = session.fromPath(account.directory);
    const win = new BrowserWindow({
      width: 1100, height: 800, show: false,
      webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, backgroundThrottling: false }
    });
    goalContinuationInFlight = true;
    goalContinuationWindows.add(win);
    goalWindowAccounts.set(win, account.tunnelId);
    win.once('closed', () => { goalContinuationWindows.delete(win); goalWindowAccounts.delete(win); });
    let keepPage = false;
    let clicked = false;
    let stage = 'navigation';
    const signal = options.signal;
    const chatPath = '/backend-api/conversation/' + id;
    const chatUrl = 'https://chatgpt.com/c/' + id;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const fetchChat = async () => {
      const response = await goalProtocolRequest({ method: 'GET', path: chatPath, projectConversation: true,
        tunnelId: account.tunnelId }, { signal });
      if (!response.ok) throw Object.assign(new Error('ChatGPT conversation is not available to the signed-in account.'),
        { status: response.status, retryAfterMs: response.retryAfterMs, deferred: response.deferred });
      return response.data;
    };
    const retainPage = () => {
      if (keepPage) return;
      keepPage = true;
      let checking = false;
      const startedAt = Date.now();
      const timer = setInterval(async () => {
        if (checking) return;
        if (win.isDestroyed?.()) { clearInterval(timer); return; }
        if (Date.now() - startedAt > 60 * 60_000) { clearInterval(timer); win.close(); return; }
        checking = true;
        try {
          const current = await goalProtocolRequest({ method: 'GET', path: chatPath, projectConversation: true,
            tunnelId: account.tunnelId });
          if (current.ok && goalMessageExists(current.data, prompt, expectedNode) && goalAssistantSettled(current.data)) {
            clearInterval(timer);
            win.close();
          }
        } catch {} finally { checking = false; }
      }, 5_000);
      timer.unref?.();
      win.once('closed', () => clearInterval(timer));
    };
    const stillOnChat = () => goalConversationMatches(win.webContents, id);
    try {
      throwIfAborted(signal);
      await withTimeout(withAbort(win.loadURL(chatUrl), signal, () => win.webContents.stop?.()),
        18_000, 'ChatGPT browser navigation timed out.');
      stage = 'composer';
      let probe;
      const readyUntil = Date.now() + 14_000;
      do {
        throwIfAborted(signal);
        if (!stillOnChat()) return { ok: false, notSent: true, stage: 'navigation', reason: 'conversation_unavailable' };
        probe = await win.webContents.executeJavaScript(goalComposerExpression('probe'), true);
        if (probe?.state === 'verification') return { ok: false, notSent: true, stage, reason: 'verification' };
        if (probe?.state === 'ready') break;
        await delay(450);
      } while (Date.now() < readyUntil);
      if (probe?.state !== 'ready') {
        return { ok: false, notSent: true, stage, reason: 'composer_unavailable' };
      }
      stage = 'preflight';
      if ((await fetchChat())?.current_node !== expectedNode) return { ok: false, stale: true, notSent: true };
      stage = 'draft';
      const focused = await win.webContents.executeJavaScript(goalComposerExpression('focus'), true);
      if (focused?.state !== 'focused') return { ok: false, notSent: true, stage, reason: 'focus_unavailable' };
      const debuggerApi = await attachedDebugger(win.webContents);
      // ChatGPT may restore an old unsent Goal Mode draft from this profile.
      // The exact conversation branch was checked above. Replace the focused
      // composer text in one edit; never append to a restored draft.
      const modifiers = process.platform === 'darwin' ? 4 : 2;
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers
      });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers
      });
      await debuggerApi.sendCommand('Input.insertText', { text: prompt });
      stage = 'send_button';
      let send;
      const sendUntil = Date.now() + 6_000;
      do {
        throwIfAborted(signal);
        send = await win.webContents.executeJavaScript(goalComposerExpression('send', prompt), true);
        if (send?.state === 'send_ready' || send?.state === 'text_mismatch' || send?.state === 'verification') break;
        await delay(250);
      } while (Date.now() < sendUntil);
      if (send?.state !== 'send_ready' || !stillOnChat()) {
        return { ok: false, notSent: true, stage,
          reason: stillOnChat() && ['text_mismatch', 'send_unavailable', 'verification'].includes(send?.state)
            ? send.state : 'composer_unavailable' };
      }
      // User activity in another tab could have advanced the branch while loading.
      if ((await fetchChat())?.current_node !== expectedNode) return { ok: false, stale: true, notSent: true };
      if (!stillOnChat()) return { ok: false, notSent: true, stage: 'navigation', reason: 'conversation_unavailable' };
      throwIfAborted(signal);
      assertGoalMutation(payload);
      stage = 'submit';
      clicked = true; // Every outcome after this point is potentially committed.
      // Like codex-chatgpt-web, activate the focused form button by keyboard.
      // This works without a visible window or coordinate-based hit testing.
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'
      });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
      });
      stage = 'readback';
      const verifyUntil = Date.now() + 12_000;
      do {
        throwIfAborted(signal);
        const current = await fetchChat();
        if (current.current_node !== expectedNode && goalMessageExists(current, prompt, expectedNode)) {
          retainPage();
          // The page stays alive until its response completes; the protocol monitor
          // continues to enforce branch and task-activity checks independently.
          return { ok: true, accepted: true };
        }
        await delay(600);
      } while (Date.now() < verifyUntil);
      retainPage();
      return { ok: false, uncertain: true, stage };
    } catch (error) {
      const rateLimit = error?.status === 429 ? { status: 429, retryAfterMs: error.retryAfterMs, deferred: error.deferred } : {};
      if (clicked) {
        retainPage();
        return { ok: false, uncertain: true, stage, ...rateLimit };
      }
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      // The site may change its composer or require account interaction.
      // Report a confirmed pre-Send failure; never open a manual continuation window.
      return { ok: false, notSent: true, stage, ...rateLimit };
    } finally {
      goalContinuationInFlight = false;
      if (!keepPage && !win.isDestroyed?.()) win.close();
    }
  }

  async function goalBrowserStopStalled(payload = {}, options = {}) {
    const account = goalAccount(String(payload.tunnelId || ''));
    const rateLimit = goalReadAdmission(account);
    if (rateLimit) return rateLimit;
    const id = String(payload.conversationId || '');
    const expectedNode = String(payload.expectedNodeId || '');
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !expectedNode
      || !goalProfileDirectory || typeof BrowserWindow !== 'function') {
      throw new Error('Goal Mode recovery requires an exact signed-in conversation.');
    }
    if (goalContinuationInFlight) return { ok: false, busy: true, notSent: true };
    const chatUrl = 'https://chatgpt.com/c/' + id;
    const chatPath = '/backend-api/conversation/' + id;
    const existing = [...goalContinuationWindows].find(window => !window.isDestroyed?.()
      && goalWindowAccounts.get(window) === account.tunnelId && goalConversationMatches(window.webContents, id));
    const win = existing || new BrowserWindow({ width: 1100, height: 800, show: false,
      webPreferences: { session: session.fromPath(account.directory), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    goalContinuationInFlight = true;
    if (!existing) {
      goalContinuationWindows.add(win);
      goalWindowAccounts.set(win, account.tunnelId);
      win.once('closed', () => { goalContinuationWindows.delete(win); goalWindowAccounts.delete(win); });
    }
    let keepPage = false;
    let stage = 'navigation';
    const signal = options.signal;
    const read = async () => {
      const response = await goalProtocolRequest({ method: 'GET', path: chatPath, projectConversation: true,
        tunnelId: account.tunnelId }, { signal });
      if (!response.ok) throw Object.assign(new Error('ChatGPT conversation read failed.'),
        { status: response.status, retryAfterMs: response.retryAfterMs, deferred: response.deferred });
      return response.data;
    };
    try {
      throwIfAborted(signal);
      if (!existing) await withTimeout(withAbort(win.loadURL(chatUrl), signal,
        () => win.webContents.stop?.()), 18_000, 'Goal Mode stalled browser navigation timed out.');
      if (!goalConversationMatches(win.webContents, id)) throw new Error('Wrong ChatGPT conversation.');
      stage = 'preflight';
      const before = await read();
      const expectedMessage = before.mapping?.[expectedNode]?.message;
      if (before.current_node !== expectedNode || expectedMessage?.author?.role !== 'assistant'
        || !expectedMessage.id) return { ok: false, stale: true };
      if (goalAssistantSettled(before)) {
        return { ok: true, alreadyFinished: true };
      }
      stage = 'stop_button';
      let probe;
      const readyUntil = Date.now() + 6_000;
      do {
        throwIfAborted(signal);
        probe = await win.webContents.executeJavaScript(goalStopExpression(), true);
        if (probe?.state !== 'loading') break;
        await new Promise(resolve => setTimeout(resolve, 300));
      } while (Date.now() < readyUntil);
      if (probe?.state !== 'stop_ready') throw new Error('ChatGPT Stop control is not available.');
      // Exactly one native activation. Any ambiguous outcome is surfaced; the
      // controller has already claimed this node and must never retry it.
      stage = 'stop_click';
      const debuggerApi = await attachedDebugger(win.webContents);
      // Recheck and focus the exact control after debugger attachment.
      if ((await win.webContents.executeJavaScript(goalStopExpression(), true))?.state !== 'stop_ready') {
        throw new Error('ChatGPT Stop control changed before activation.');
      }
      // Readiness and debugger attachment can yield for several seconds. Make
      // the exact turn read the last awaited preflight before native activation;
      // an unchanged URL alone does not identify the running assistant turn.
      const current = await read();
      const currentMessage = current.mapping?.[current.current_node]?.message;
      if (current.current_node !== expectedNode || currentMessage?.id !== expectedMessage.id
        || currentMessage?.author?.role !== 'assistant') return { ok: false, stale: true };
      if (goalAssistantSettled(current)) return { ok: true, alreadyFinished: true };
      throwIfAborted(signal);
      if (!goalConversationMatches(win.webContents, id)) throw new Error('Wrong ChatGPT conversation.');
      assertGoalMutation(payload);
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'
      });
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
      });
      stage = 'stop_readback';
      const until = Date.now() + 12_000;
      do {
        throwIfAborted(signal);
        const stopped = await win.webContents.executeJavaScript(goalStopExpression(), true);
        if (stopped?.state === 'not_running') {
          const after = await read();
          const final = after.mapping?.[after.current_node]?.message;
          if (after.current_node === expectedNode && final?.id === expectedMessage.id && final?.author?.role === 'assistant'
            && (final?.end_turn === true || ['interrupted', 'cancelled', 'finished_successfully'].includes(final?.status))) {
            return { ok: true, stopped: true };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      } while (Date.now() < until);
      throw new Error('ChatGPT Stop did not confirm a settled assistant turn.');
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      keepPage = Boolean(existing);
      return { ok: false, notSent: true, stage,
        ...(error?.status === 429 ? { status: 429, retryAfterMs: error.retryAfterMs, deferred: error.deferred } : {}) };
    } finally {
      goalContinuationInFlight = false;
      if (!keepPage && !win.isDestroyed?.()) win.close();
    }
  }

  async function goalBrowserEvaluate(payload = {}, options = {}) {
    throwIfAborted(options.signal);
    assertGoalMutation(payload);
    const account = goalAccount(String(payload.tunnelId || ''));
    const admission = goalReadAdmission(account);
    if (admission) return admission;
    if (goalContinuationInFlight) return { ok: false, busy: true, notSent: true };
    if (typeof BrowserWindow !== 'function') return { ok: false, unavailable: true, notSent: true };
    const prompt = buildGoalEvaluatorPrompt(payload.packet);
    const browserSession = session.fromPath(account.directory);
    // Reuse existing account verification and profile. No credentials cross IPC.
    const auth = await readGoalProtocolAuth(account, browserSession);
    if (!auth.ok) { rememberGoalReadLimit(account, auth); return auth; }
    throwIfAborted(options.signal);
    goalAccount(account.tunnelId); // The account may have been disabled while verifying.
    if (goalContinuationInFlight) return { ok: false, busy: true, notSent: true };
    const afterAuth = goalReadAdmission(account);
    if (afterAuth) return afterAuth;
    const win = new BrowserWindow({ width: 1100, height: 800, show: false,
      webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, backgroundThrottling: false } });
    goalContinuationInFlight = true;
    goalContinuationWindows.add(win);
    goalWindowAccounts.set(win, account.tunnelId);
    win.once('closed', () => { goalContinuationWindows.delete(win); goalWindowAccounts.delete(win); });
    try {
      const result = await runGoalHelperBrowser(win, prompt, {
        signal: options.signal, attachedDebugger,
        assertAvailable: () => { goalAccount(account.tunnelId); assertGoalMutation(payload); }
      });
      if (result.status === 429) rememberGoalReadLimit(account, result);
      return result;
    } finally {
      goalContinuationInFlight = false;
      if (!win.isDestroyed?.()) win.close();
    }
  }

  async function goalProtocolRequest(payload = {}, options = {}) {
    if (payload.action === 'evaluate') return goalBrowserEvaluate(payload, options);
    if (payload.action === 'stop_stalled') return goalBrowserStopStalled(payload, options);
    if (payload.action === 'continue') return goalBrowserContinue(payload, options);
    const account = goalAccount(String(payload.tunnelId || ''));
    const method = String(payload.method || 'GET').toUpperCase();
    const requestedPath = String(payload.path || '');
    const target = new URL(requestedPath, 'https://chatgpt.com');
    const readPath = /^\/backend-api\/(?:conversations|conversation\/[0-9a-f-]{36}|gizmos\/snorlax\/sidebar|gizmos\/g-p-[0-9a-f]{32}\/conversations)$/i;
    const writePath = /^\/backend-api\/(?:f\/conversation(?:\/prepare)?|sentinel\/chat-requirements\/(?:prepare|finalize))$/;
    if (target.origin !== 'https://chatgpt.com' || target.hash ||
      !((method === 'GET' && readPath.test(target.pathname)) ||
        (method === 'POST' && writePath.test(target.pathname)))) {
      throw new Error('Unsupported Goal Mode protocol endpoint.');
    }
    const browserSession = session.fromPath(account.directory);
    const rateLimit = goalReadAdmission(account, method === 'GET');
    if (rateLimit) return rateLimit;
    const auth = await readGoalProtocolAuth(account, browserSession);
    if (!auth.ok) { rememberGoalReadLimit(account, auth); return auth; }
    throwIfAborted(options.signal);
    const admission = goalReadAdmission(account);
    if (admission) return admission;
    const bearer = auth.bearer;
    const requestHeaders = {
      accept: payload.raw === true ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${bearer}`,
      origin: 'https://chatgpt.com',
      referer: 'https://chatgpt.com/'
    };
    if (method === 'POST') requestHeaders['content-type'] = 'application/json';
    for (const name of ['x-conduit-token', 'openai-sentinel-chat-requirements-token']) {
      if (typeof payload.headers?.[name] === 'string') requestHeaders[name] = payload.headers[name];
    }
    const deadline = AbortSignal.timeout(payload.raw ? 120_000 : 15_000);
    const requestSignal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const response = await browserSession.fetch(target.href, {
      method, headers: requestHeaders, credentials: 'include', redirect: 'error',
      ...(method === 'POST' ? { body: JSON.stringify(payload.body || {}) } : {}),
      signal: requestSignal
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      if (response.status === 401) goalProtocolAuth.delete(account.directory);
      const failure = goalReadFailure(response);
      rememberGoalReadLimit(account, failure);
      return failure;
    }
    if (payload.raw === true) {
      const reader = response.body?.getReader?.();
      if (!reader) return { ok: false, status: 502 };
      let head = '';
      let firstDone = false;
      while (head.length < 64 * 1024) {
        const chunk = await reader.read();
        if (chunk.done) { firstDone = true; break; }
        head += new TextDecoder().decode(chunk.value);
        if ((head.includes('data:') || head.includes('event:')) && head.includes('\n')) break;
      }
      if (firstDone || (!head.includes('data:') && !head.includes('event:')) || /event:\s*error/i.test(head)) {
        await reader.cancel().catch(() => {});
        return { ok: false, status: 502 };
      }
      // Drain the stream off the IPC path without retaining the generated text.
      void (async () => {
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > 64 * 1024 * 1024) { await reader.cancel(); break; }
          }
        } catch {} finally { reader.releaseLock(); }
      })();
      return { ok: true, status: response.status, streamObserved: true };
    }
    // Project the active conversation before IPC. Never transfer or retain
    // the full conversation JSON when Goal Mode needs only branch metadata.
    if (payload.projectConversation === true && method === 'GET'
      && /^\/backend-api\/conversation\/[0-9a-f-]{36}$/i.test(target.pathname)) {
      return { ok: true, status: response.status, data: await readConversationProjection(response) };
    }
    const advertised = Number(response.headers?.get?.('content-length') || 0);
    const maxConversationBytes = 32 * 1024 * 1024;
    if (advertised > maxConversationBytes) throw new Error('Goal Mode response exceeded its size limit.');
    const result = await readGoalJson(response, maxConversationBytes);
    return { ok: true, status: response.status, data: result };
  }

  function goalReadFailure(response) {
    const retryAfter = response.headers?.get?.('retry-after');
    const seconds = retryAfter == null || retryAfter === '' ? NaN : Number(retryAfter);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter || '') - Date.now();
    return { ok: false, status: response.status,
      ...(response.status === 429 && Number.isFinite(delay)
        ? { retryAfterMs: Math.max(0, Math.min(delay, 86_400_000)) } : {}) };
  }

  function goalReadAdmission(account, consume = false) {
    if (clearingSavedData || clearingProfiles.has(profileDirectoryKey(account.directory))) {
      return { ok: false, status: 401, notSent: true };
    }
    const now = Date.now();
    let limit = goalProtocolLimits.get(account.directory);
    if (!limit) { limit = { reads: [], until: 0, count: 0 }; goalProtocolLimits.set(account.directory, limit); }
    if (limit.until > now) return { ok: false, status: 429, retryAfterMs: limit.until - now,
      deferred: true, notSent: true, rateLimitReason: 'upstream' };
    if (!consume) return null;
    limit.reads = limit.reads.filter(time => time > now - 60_000);
    if (limit.reads.length >= 30) return { ok: false, status: 429,
      retryAfterMs: limit.reads[0] + 60_000 - now, deferred: true, notSent: true, rateLimitReason: 'read_budget' };
    limit.reads.push(now);
    return null;
  }

  function rememberGoalReadLimit(account, result) {
    if (result.status !== 429 || result.deferred) return;
    const limit = goalProtocolLimits.get(account.directory);
    if (limit.until <= Date.now()) limit.count = Math.min(limit.count + 1, 4);
    const delay = result.retryAfterMs > 0 ? Math.max(60_000, result.retryAfterMs) : 300_000 * 2 ** (limit.count - 1);
    limit.until = Math.max(limit.until, Date.now() + delay);
    result.retryAfterMs = limit.until - Date.now();
  }

  async function readGoalProtocolAuth(account, browserSession, refresh = false) {
    const existing = goalProtocolAuth.get(account.directory);
    if (existing?.promise) return existing.promise;
    if (existing && !refresh && Date.now() < existing.expiresAt) return existing.result;
    const record = { promise: null };
    record.promise = (async () => {
      try {
        const response = await browserSession.fetch('https://chatgpt.com/api/auth/session', {
          credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) {
          await response.body?.cancel?.().catch(() => {});
          return goalReadFailure(response);
        }
        const data = await readGoalJson(response, 64 * 1024);
        if (goalProtocolAuth.get(account.directory) !== record || clearingSavedData
          || clearingProfiles.has(profileDirectoryKey(account.directory)) || !data?.user
          || typeof data.accessToken !== 'string' || !data.accessToken) {
          return { ok: false, status: 401 };
        }
        const result = { ok: true, bearer: data.accessToken,
          account: { name: String(data.user.name || '').slice(0, 100), email: String(data.user.email || '').slice(0, 200) } };
        const expires = Date.parse(data.expires || '');
        goalProtocolAuth.set(account.directory, { result,
          expiresAt: Math.min(Date.now() + 60_000, Number.isFinite(expires) ? expires : Infinity) });
        return result;
      } finally {
        if (goalProtocolAuth.get(account.directory) === record) goalProtocolAuth.delete(account.directory);
      }
    })();
    goalProtocolAuth.set(account.directory, record);
    return record.promise;
  }

  async function readGoalJson(response, maxBytes) {
    const advertised = Number(response.headers?.get?.('content-length') || 0);
    if (advertised > maxBytes) throw new Error('Goal Mode response exceeded its size limit.');
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Goal Mode response exceeded its size limit.');
      return JSON.parse(text);
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('Goal Mode response exceeded its size limit.'); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }

  async function signOutGoalLogin(input = {}) {
    const account = goalAccount(String(input.tunnelId || ''));
    const profileKey = profileDirectoryKey(account.directory);
    if (clearingSavedData || clearingProfiles.has(profileKey)) {
      throw browserError('BROWSER_PROFILE_ALREADY_ACTIVE', 'This browser profile is already being cleared.');
    }
    clearingProfiles.add(profileKey);
    goalProtocolAuth.delete(account.directory);
    try {
      // Wait for this account's pending login before clearing it, so it cannot
      // reopen a signed-in session after a concurrent Sign out.
      await goalLoginOpenings.get(account.tunnelId)?.catch(() => {});
      for (const win of goalContinuationWindows) {
        if (goalWindowAccounts.get(win) === account.tunnelId && !win.isDestroyed?.()) win.close();
      }
      const record = sessions.get(goalLoginSessionIds.get(account.tunnelId));
      if (record) await closeSession(record.nativeSessionId, { emit: true });
      const browserSession = session.fromPath(account.directory);
      await browserSession.clearStorageData();
      await browserSession.clearCache();
      await browserSession.clearAuthCache?.();
      goalLoginSessionIds.delete(account.tunnelId);
      return { ok: true, available: true, browserOpen: false, state: 'sign_in_required',
        ...(account.tunnelId ? { tunnelId: account.tunnelId, label: account.label, enabled: account.enabled } : {}) };
    } finally {
      goalProtocolAuth.delete(account.directory);
      clearingProfiles.delete(profileKey);
    }
  }

  async function stopActiveSession() {
    const record = visibleRecord();
    if (!record) return { ok: true, status: 'idle' };
    return closeSession(record.nativeSessionId, { emit: true });
  }

  function closeAll() {
    for (const win of goalContinuationWindows) if (!win.isDestroyed?.()) win.close();
    if (closingAll) return closingAll;
    closingAll = Promise.resolve().then(async () => {
      const failures = [];
      for (const nativeSessionId of [...sessions.keys()]) {
        try { await closeSession(nativeSessionId, { emit: false }); }
        catch (error) { failures.push(error); }
      }
      detachAttached();
      surfaceBounds = { visible: false, x: 0, y: 0, width: 1, height: 1 };
      publishState();
      if (failures.length) throw new AggregateError(failures, 'Some embedded browser sessions could not be closed. Retry cleanup.');
    }).finally(() => { closingAll = null; });
    return closingAll;
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
    const value = normalizeControlOwner(owner);
    const record = value === 'ai' && pinnedSessionId
      ? sessions.get(pinnedSessionId) || activeRecord()
      : visibleRecord();
    if (!record) throw new Error('No embedded browser session is active.');
    return applyControl(record, value, '');
  }

  async function setControlForSession(value, owner, reason = '') {
    const record = requireSession(value);
    const control = normalizeControlOwner(owner);
    activeSessionId = record.nativeSessionId;
    if (control === 'user') await openDashboard('#browser');
    if (sessions.get(record.nativeSessionId) !== record || record.closePromise) throw cancelledError('Browser session closed before control changed.');
    return applyControl(record, control, reason);
  }

  async function applyControl(record, value, reason = '') {
    if (sessions.get(record.nativeSessionId) !== record || record.closePromise) throw cancelledError('Browser session is closing.');
    record.control = value;
    record.handoffReason = value === 'user' ? String(reason || record.handoffReason || '').trim().slice(0, 80) : '';
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
        profile: candidate.persistent ? 'persistent' : 'ephemeral',
        handoffReason: candidate.handoffReason || '',
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
      profile: record ? (record.persistent ? 'persistent' : 'ephemeral') : '',
      handoffReason: record?.handoffReason || '',
      goalTunnelId: [...goalLoginSessionIds].find(([, id]) => id === record?.nativeSessionId)?.[0] || '',
      permissionRequests: [...sessions.values()].flatMap(candidate => [...candidate.pendingPermissions.values()].map(publicPermissionRequest)),
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

  function rememberPersistentSite(record, value) {
    if (!record?.persistent || !record.profileDirectory) return;
    void Promise.resolve(recordPersistentSite(record.profileDirectory, value)).catch(onError);
  }

  function configurePage(record, page) {
    const wc = page.webContents;
    wc.setWindowOpenHandler?.(details => {
      if (record.closePromise || sessions.get(record.nativeSessionId) !== record) return { action: 'deny' };
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
              void destroyPage(record, child, { emit: true }).catch(onError);
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
    wc.on('did-navigate', (_event, url) => {
      page.loadFailed = false;
      rememberPersistentSite(record, url || wc.getURL());
      publishState();
    });
    wc.on('did-navigate-in-page', (_event, url) => {
      rememberPersistentSite(record, url || wc.getURL());
      publishState();
    });
    wc.on('page-title-updated', () => publishState());
    wc.on('blur', () => {
      if (page.closing || record.control !== 'user' || record.handoffReason || record.activePageId !== page.nativePageId) return;
      void applyControl(record, 'ai').catch(onError);
    });
    wc.on('before-input-event', event => {
      if (record.control === 'ai' && page.aiInputDepth === 0) event.preventDefault();
    });
    wc.on('before-mouse-event', (event, mouse) => {
      if (record.control !== 'ai' || page.aiInputDepth !== 0) return;
      event.preventDefault();
      if (mouse?.type === 'mouseWheel') forwardWheelToDashboard(page, mouse);
    });
    wc.on('render-process-gone', (_event, details) => {
      if (page.closing || record.closePromise) return;
      page.crashed = true;
      const recoverUrl = publicPageUrl(wc.getURL?.() || '');
      const now = Date.now();
      if (!page.crashWindowStartedAt || now - page.crashWindowStartedAt > 60_000) {
        page.crashWindowStartedAt = now;
        page.crashRecoveryAttempts = 0;
      }
      const terminal = page.recovering || !recoverUrl || recoverUrl === 'about:blank' || ++page.crashRecoveryAttempts > 2;
      if (terminal) {
        onError(browserError('BROWSER_TAB_CRASHED', 'The embedded browser tab could not recover from its renderer crash.'));
        void destroyPage(record, page, { emit: true, type: 'page_crashed' }).catch(onError);
        return;
      }
      // Recovery retains the native page and tool-side tab identity. A crash is
      // terminal only after the native page has actually been removed.
      page.recovering = true;
      const controller = new AbortController();
      page.recoveryController = controller;
      onEvent({ resource: 'browser', type: 'page_recovering',
        nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId,
        reason: String(details?.reason || 'crashed') });
      publishState();
      void (async () => {
        try {
          await withTimeout(withAbort(wc.loadURL(recoverUrl), controller.signal, () => wc.stop?.()),
            15_000, 'Embedded browser crash recovery timed out.');
          if (page.closing || record.closePromise || record.pages.get(page.nativePageId) !== page || controller.signal.aborted) return;
          await withTimeout(withAbort(syncPageRuntime(record, page), controller.signal),
            15_000, 'Embedded browser crash recovery synchronization timed out.');
          if (page.closing || record.closePromise || record.pages.get(page.nativePageId) !== page || controller.signal.aborted) return;
          page.recovering = false;
          page.crashed = false;
          page.loadFailed = false;
          onEvent({ resource: 'browser', type: 'page_recovered',
            nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId });
          publishState();
        } catch (error) {
          if (page.closing || controller.signal.aborted || record.pages.get(page.nativePageId) !== page) return;
          onError(browserError('BROWSER_TAB_CRASHED', `Embedded browser crash recovery failed: ${error?.message || error}`));
          await destroyPage(record, page, { emit: true, type: 'page_crashed' }).catch(onError);
        } finally {
          if (page.recoveryController === controller) page.recoveryController = null;
        }
      })();
    });
    wc.once('destroyed', () => {
      page.recoveryController?.abort();
      if (page.closing) return;
      record.pages.delete(page.nativePageId);
      if (record.activePageId === page.nativePageId) record.activePageId = record.pages.keys().next().value || '';
      onEvent({ resource: 'browser', type: 'page_closed', nativeSessionId: record.nativeSessionId, nativePageId: page.nativePageId });
      attachActiveView();
      publishState();
    });
  }

  function secureBrowserSession(record, ignoreHTTPSErrors) {
    const browserSession = record.electronSession;
    browserSession.setPermissionRequestHandler?.((contents, permission, callback, details = {}) => {
      const key = permissionGrantKey(contents, permission, details.requestingUrl || contents?.getURL?.());
      if (record.permissionGrants.has(key)) {
        callback(true);
        return;
      }
      const requestId = `browser_permission_${crypto.randomBytes(12).toString('base64url')}`;
      const pending = {
        requestId,
        nativeSessionId: record.nativeSessionId,
        permission: String(permission || 'unknown'),
        origin: permissionOrigin(details.requestingUrl || contents?.getURL?.()),
        webContentsId: Number(contents?.id || 0),
        key,
        callback,
        settled: false,
        timer: null
      };
      pending.timer = setTimeout(() => settlePermissionRequest(record, pending, false), PERMISSION_REQUEST_TIMEOUT_MS);
      pending.timer.unref?.();
      record.pendingPermissions.set(requestId, pending);
      publishState();
      void openDashboard('#browser').catch(onError);
    });
    browserSession.setPermissionCheckHandler?.((contents, permission, requestingOrigin) =>
      record.permissionGrants.has(permissionGrantKey(contents, permission, requestingOrigin)));
    if (typeof browserSession.setCertificateVerifyProc === 'function') {
      browserSession.setCertificateVerifyProc(ignoreHTTPSErrors ? ((_request, callback) => callback(0)) : null);
    }
  }

  function respondPermission(requestId, allowed) {
    const id = String(requestId || '').trim();
    for (const record of sessions.values()) {
      const pending = record.pendingPermissions.get(id);
      if (!pending) continue;
      settlePermissionRequest(record, pending, allowed === true);
      publishState();
      return getState();
    }
    throw new Error('Browser permission request is no longer active.');
  }

  function settlePermissionRequest(record, pending, allowed) {
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    record.pendingPermissions.delete(pending.requestId);
    if (allowed) record.permissionGrants.add(pending.key);
    try { pending.callback(allowed === true); } catch {}
  }

  function publicPermissionRequest(pending) {
    return {
      requestId: pending.requestId,
      nativeSessionId: pending.nativeSessionId,
      permission: pending.permission,
      origin: pending.origin
    };
  }

  function permissionGrantKey(_contents, permission, origin) {
    return `${String(permission || '')}\u0000${permissionOrigin(origin)}`;
  }

  function permissionOrigin(value) {
    try { return new URL(String(value || '')).origin; } catch { return ''; }
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

  function destroyPage(record, page, options = {}) {
    if (page.closePromise) return page.closePromise;
    page.closing = true;
    page.recoveryController?.abort();
    page.closePromise = Promise.resolve().then(async () => {
      if (attached?.page === page) detachAttached();
      const pending = record.pendingDownloads.get(page.webContents.id) || [];
      for (const entry of [...pending]) entry.cancel(browserError('BROWSER_OPERATION_CANCELLED', 'Browser page closed before download completed.'));
      await closeWebContents(page.webContents);
      record.pages.delete(page.nativePageId);
      if (record.activePageId === page.nativePageId) record.activePageId = record.pages.keys().next().value || '';
      if (options.emit === true) {
        onEvent({
          resource: 'browser',
          type: options.type || 'page_closed',
          nativeSessionId: record.nativeSessionId,
          nativePageId: page.nativePageId
        });
      }
    }).catch(error => {
      page.closing = false;
      throw error;
    }).finally(() => {
      page.closePromise = null;
      attachActiveView();
      publishState();
    });
    return page.closePromise;
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
    if (!surfaceBounds.visible || !page || page.closing || record.closePromise || !win || win.isDestroyed?.()) {
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
    if (record.closePromise) throw cancelledError('Browser session is closing.');
    return record;
  }

  function requirePage(record, value) {
    const id = assertPageId(value);
    const page = record.pages.get(id);
    if (!page) throw browserError('BROWSER_TAB_NOT_FOUND', `Unknown or closed embedded browser page: ${id}.`);
    return page;
  }

  function assertPageMutation(record, page, action) {
    if (sessions.get(record.nativeSessionId) !== record || record.closePromise || record.pages.get(page.nativePageId) !== page || page.closing || page.webContents.isDestroyed?.()) {
      throw cancelledError('Browser session or tab closed before the operation could finish.');
    }
    assertAiControl(record, action);
  }

  function assertAiControl(record, action) {
    if (record.control !== 'user') return;
    throw browserError('BROWSER_USER_CONTROL_ACTIVE', `The user currently controls this browser session. Return control to AI before ${action.replaceAll('_', ' ')}.`);
  }

  return Object.freeze({ run, getState, setBounds, setControl, respondPermission, listSavedSites, clearSavedSite, clearSavedData, selectSession, selectTab, closeTab, stopActiveSession, closeAll, startGoalLogin, getGoalLoginStatus, signOutGoalLogin, goalProtocolRequest });
}

function closeWebContents(contents) {
  if (contents.isDestroyed?.()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.off('destroyed', onDestroyed);
      if (error) reject(error);
      else resolve();
    };
    const onDestroyed = () => finish();
    const timer = setTimeout(() => finish(new Error('Browser page termination could not be confirmed. Retry cleanup.')), PAGE_CLOSE_TIMEOUT_MS);
    timer.unref?.();
    contents.once('destroyed', onDestroyed);
    void Promise.resolve().then(async () => {
      await contents.close?.({ waitForBeforeUnload: false });
      if (!contents.isDestroyed?.()) await contents.destroy?.();
      if (contents.isDestroyed?.()) finish();
    }).catch(finish);
  });
}

function profileDirectoryKey(value) {
  const directory = path.resolve(String(value));
  return process.platform === 'win32' ? directory.toLowerCase() : directory;
}

function normalizeSavedSiteOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch { return ''; }
}

function safeOriginHost(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

function safeOriginHostname(origin) {
  try { return new URL(origin).hostname; } catch { return ''; }
}

function cookieSiteOrigin(cookie = {}) {
  const domain = String(cookie.domain || '').trim().replace(/^\./, '');
  if (!domain) return '';
  try { return new URL(`${cookie.secure === true ? 'https' : 'http'}://${domain}`).origin; } catch { return ''; }
}

function normalizeControlOwner(owner) {
  const value = String(owner || '').trim();
  if (!CONTROL_OWNERS.has(value)) throw new Error('Browser control owner must be ai or user.');
  return value;
}

function runDomInteraction(webContents, interaction, payload) {
  const frame = targetExecutionFrame(webContents, payload.target);
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
  return frame.executeJavaScript(script, true);
}

async function focusTarget(webContents, target) {
  const frame = targetExecutionFrame(webContents, target);
  const encoded = JSON.stringify(normalizeTarget(target));
  return frame.executeJavaScript(`(() => { const el = (${targetResolverSource()})(${encoded}); if (!el) throw new Error('Browser interaction target was not found.'); el.focus(); return true; })()`, true);
}

async function waitForTarget(webContents, target, stateValue, timeoutMs, signal) {
  const state = ['visible', 'hidden', 'attached', 'detached'].includes(String(stateValue || '')) ? String(stateValue) : 'visible';
  const encoded = JSON.stringify(normalizeTarget(target));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    throwIfAborted(signal);
    const frame = targetExecutionFrame(webContents, target);
    const result = await withAbort(frame.executeJavaScript(`(() => {
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
  const frame = targetExecutionFrame(webContents, target);
  const encoded = JSON.stringify(normalizeTarget(target));
  const safeMarker = JSON.stringify(marker);
  const result = await frame.executeJavaScript(`(() => { const el = (${targetResolverSource()})(${encoded}); if (!(el instanceof HTMLInputElement) || el.type !== 'file') return false; el.setAttribute('data-relai-upload-marker', ${safeMarker}); return true; })()`, true);
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
    const accessibleText = node => {
      if (!node) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1 || node.getAttribute?.('aria-hidden') === 'true') return '';
      return [...node.childNodes].map(accessibleText).join(' ');
    };
    const referencedText = ids => normalize(String(ids || '').split(/\\s+/).map(id => accessibleText(document.getElementById(id))).join(' '));
    const labelText = el => normalize(el.labels ? [...el.labels].map(accessibleText).join(' ') : '');
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

async function withAiInput(record, page, action, assertInputAllowed) {
  return enqueuePageRuntime(page, async () => {
    assertInputAllowed();
    const debuggerApi = await attachedDebugger(page.webContents);
    assertInputAllowed();
    await debuggerApi.sendCommand('Input.setIgnoreInputEvents', { ignore: false });
    page.aiInputDepth += 1;
    try {
      assertInputAllowed();
      return await action();
    } finally {
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

function browserFrameSummaries(webContents) {
  const frames = webContents?.mainFrame?.framesInSubtree || [];
  return frames.filter(frame => frame !== webContents.mainFrame && !frame.isDestroyed?.()).map((frame, index) => ({
    index,
    name: String(frame.name || ''),
    url: publicPageUrl(frame.url)
  }));
}

function targetExecutionFrame(webContents, target) {
  const frameTarget = target?.frame;
  if (!frameTarget) return webContents.mainFrame || webContents;
  const normalized = normalizeFrameTarget(frameTarget);
  const frames = (webContents?.mainFrame?.framesInSubtree || []).filter(frame => frame !== webContents.mainFrame && !frame.isDestroyed?.());
  const wanted = normalized.value;
  const match = value => normalized.exact === true
    ? String(value || '').trim() === wanted
    : String(value || '').trim().toLowerCase().includes(wanted.toLowerCase());
  const candidates = frames.filter(frame => match(normalized.by === 'name' ? frame.name : frame.url));
  const selected = candidates[normalized.index || 0];
  if (!selected) throw new Error(`Browser frame target was not found by ${normalized.by}.`);
  return selected;
}

function normalizeFrameTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('target.frame must be an object.');
  const by = String(value.by || '').trim();
  const targetValue = String(value.value || '').trim();
  if (!['name', 'url'].includes(by)) throw new Error(`Unsupported target.frame.by '${by || '(missing)'}.`);
  if (!targetValue) throw new Error('target.frame.value is required.');
  const index = Number(value.index);
  return {
    by,
    value: targetValue,
    ...(value.exact === true ? { exact: true } : {}),
    ...(Number.isInteger(index) && index >= 0 ? { index } : {})
  };
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
    ...(Number.isInteger(index) && index >= 0 ? { index } : {}),
    ...(value.frame ? { frame: normalizeFrameTarget(value.frame) } : {})
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

export { createBrowserSurfaceHost };
