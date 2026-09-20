import * as crypto from 'node:crypto';
import { throwIfAborted, withAbort, withAbortResource } from '../abortablePromise.ts';
import { readConfig } from '../config.js';
import { taskError } from '../toolActivity.js';
import {
  assertAutomationAttribution,
  createAutomationAttribution,
  registerTerminalTaskCleanup,
  taskIdFor,
  type AutomationAttribution,
  type AutomationContext,
  type AutomationWorkspace
} from '../computer/automationAttribution.ts';
import { normalizeViewport, timeoutFor } from '../computer/webPolicy.ts';
import { normalizeBrowserSnapshotDetail } from './layoutSnapshot.js';
import {
  downloadBrowserFile,
  uploadAuthorizedBrowserFile,
  type BrowserLocalIoWorkspace
} from './browserLocalIo.ts';
import { launchBrowserDriver, type BrowserPageDriver, type LocalBrowserDriver } from './browserDriver.ts';
import { normalizeBrowserProfileMode, preparePersistentBrowserProfile, type BrowserProfileMode } from './browserProfile.ts';
import type { StructuredInteractionArgs } from './playwrightPrimitives.ts';

const MAX_ACTIVE_BROWSER_SESSIONS = 8;
const MAX_ACTIVE_BROWSER_TABS_PER_SESSION = 8;
const BROWSER_SESSION_ID = /^browser_[A-Za-z0-9_-]{20,160}$/;
const BROWSER_TAB_ID = /^tab_[A-Za-z0-9_-]{20,160}$/;

type BrowserContext = AutomationContext & Readonly<Record<string, unknown>>;
type BrowserArgs = Readonly<Record<string, unknown> & StructuredInteractionArgs & {
  work_id?: unknown;
  sessionId?: unknown;
  tabId?: unknown;
  url?: unknown;
  width?: unknown;
  height?: unknown;
  ignoreHTTPSErrors?: unknown;
  timeoutMs?: unknown;
  detail?: unknown;
  fullPage?: unknown;
  path?: unknown;
  profile?: unknown;
}>;

type BrowserOperationOptions = Readonly<{ signal?: AbortSignal }>;

type BrowserTabRecord = {
  tabId: string;
  page: BrowserPageDriver;
  createdAt: string;
};

type BrowserSessionRecord = {
  sessionId: string;
  attribution: AutomationAttribution;
  driver: LocalBrowserDriver;
  tabs: Map<string, BrowserTabRecord>;
  activeTabId: string;
  createdAt: string;
  browserProduct: string;
  profileMode: BrowserProfileMode;
  profileKey: string;
};

type BrowserRuntimeDependencies = Readonly<{
  launch?: typeof launchBrowserDriver;
  getProfileConfig?: () => Record<string, unknown>;
}>;

interface BrowserRuntime {
  status(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext): Promise<Record<string, unknown>>;
  start(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  listTabs(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext): Promise<Record<string, unknown>>;
  openTab(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  closeTab(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext): Promise<Record<string, unknown>>;
  navigate(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  snapshot(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  interact(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  screenshot(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  upload(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  download(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext, options?: BrowserOperationOptions): Promise<Record<string, unknown>>;
  stop(workspace: AutomationWorkspace, args?: BrowserArgs, context?: BrowserContext): Promise<Record<string, unknown>>;
  stopSessionsForTask(taskId: string): Promise<{ stopped: number }>;
  shutdown(): Promise<{ stopped: number }>;
  activeSessionCount(): number;
}

function createBrowserRuntime(dependencies: BrowserRuntimeDependencies = {}): BrowserRuntime {
  const launch = dependencies.launch || launchBrowserDriver;
  const getProfileConfig = dependencies.getProfileConfig || (() => readConfig({ allowMissing: true }));
  const sessions = new Map<string, BrowserSessionRecord>();
  const activeProfiles = new Map<string, string>();
  const pendingStarts = new Set<Readonly<{ attribution: AutomationAttribution; profileKey: string }>>();
  const pendingProfiles = new Set<string>();
  const pendingCloses = new Set<Promise<void>>();

  async function status(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {}
  ): Promise<Record<string, unknown>> {
    if (args.sessionId) {
      const record = requireSession(workspace, args, context);
      return sessionResult(record, 'status', { tabs: await tabSummaries(record) });
    }
    const owned = [...sessions.values()].filter(record => attributionMatches(record.attribution, workspace, context));
    return {
      ok: true,
      workspace: workspace.alias,
      action: 'status',
      activeSessionCount: owned.length,
      sessions: owned.map(record => ({
        sessionId: record.sessionId,
        tabCount: record.tabs.size,
        activeTabId: record.activeTabId,
        browserProduct: record.browserProduct,
        profile: record.profileMode,
        createdAt: record.createdAt
      }))
    };
  }

  async function start(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    throwIfAborted(options.signal, browserCancellationError);
    const attribution = createAutomationAttribution(workspace, args, context);
    const taskId = attribution.taskId;
    const existing = taskId ? [...sessions.values()].find(record =>
      record.attribution.taskId === taskId && attributionMatches(record.attribution, workspace, context)
    ) : null;
    const pendingForTask = taskId ? [...pendingStarts].some(pending =>
      pending.attribution.taskId === taskId && attributionMatches(pending.attribution, workspace, context)
    ) : false;
    if (existing || pendingForTask) {
      const detail = existing ? `: ${existing.sessionId}` : '';
      throw taskError('BROWSER_SESSION_ALREADY_ACTIVE', `Work session already has an active or starting local browser session${detail}. Stop it before starting another.`);
    }
    if (sessions.size + pendingStarts.size >= MAX_ACTIVE_BROWSER_SESSIONS) {
      throw taskError('BROWSER_SESSION_LIMIT', `Rel.AI supports at most ${MAX_ACTIVE_BROWSER_SESSIONS} concurrent local browser sessions.`);
    }

    const viewport = normalizeViewport(args.width, args.height);
    const sessionId = `browser_${crypto.randomBytes(24).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    const profileMode = normalizeBrowserProfileMode(args.profile);
    const profileDirectory = profileMode === 'persistent'
      ? preparePersistentBrowserProfile(getProfileConfig(), attribution.principalFingerprint)
      : '';
    const profileKey = normalizeProfileKey(profileDirectory);
    if (profileKey && (activeProfiles.has(profileKey) || pendingProfiles.has(profileKey))) {
      throw taskError('BROWSER_PROFILE_ALREADY_ACTIVE', 'Persistent Rel.AI browser profile is already active in another local browser session.');
    }

    const pendingStart = Object.freeze({ attribution, profileKey });
    pendingStarts.add(pendingStart);
    if (profileKey) pendingProfiles.add(profileKey);
    let driver: LocalBrowserDriver | null = null;
    let record: BrowserSessionRecord | null = null;
    try {
      driver = await withAbortResource(launch({
        viewport,
        ignoreHTTPSErrors: args.ignoreHTTPSErrors === true,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(profileDirectory ? { profileDirectory } : {})
      }), options.signal, launchedDriver => launchedDriver.close(), browserCancellationError);
      record = {
        sessionId,
        attribution,
        driver,
        tabs: new Map(),
        activeTabId: '',
        createdAt,
        browserProduct: driver.browserProduct,
        profileMode,
        profileKey
      };
      sessions.set(sessionId, record);
      if (profileKey) activeProfiles.set(profileKey, sessionId);
      driver.onDisconnected(() => removeSession(record!));
      driver.onPageCreated?.((page, active) => {
        if (record!.tabs.size >= MAX_ACTIVE_BROWSER_TABS_PER_SESSION) {
          void page.close().catch(() => {});
          return;
        }
        registerTab(record!, page, active);
      });

      const tab = await createTab(record, options.signal);
      const initial = args.url
        ? await navigateTab(tab, normalizeBrowserUrl(args.url), timeoutFor(args.timeoutMs), options.signal)
        : await withAbort(tab.page.describe(options.signal), options.signal, browserCancellationError);
      return sessionResult(record, 'start', {
        tabId: tab.tabId,
        viewport,
        browserEngine: 'chromium',
        browserProduct: driver.browserProduct,
        profile: profileMode,
        createdAt,
        ...initial
      });
    } catch (error) {
      if (record) removeSession(record);
      if (driver) await driver.close().catch(() => {});
      throw error;
    } finally {
      pendingStarts.delete(pendingStart);
      if (profileKey) pendingProfiles.delete(profileKey);
    }
  }

  async function listTabs(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {}
  ): Promise<Record<string, unknown>> {
    const record = requireSession(workspace, args, context);
    return sessionResult(record, 'tabs', { tabs: await tabSummaries(record), count: record.tabs.size });
  }

  async function openTab(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    const record = requireSession(workspace, args, context);
    const tab = await createTab(record, options.signal);
    try {
      const result = args.url
        ? await navigateTab(tab, normalizeBrowserUrl(args.url), timeoutFor(args.timeoutMs), options.signal)
        : await withAbort(tab.page.describe(options.signal), options.signal, browserCancellationError);
      return sessionResult(record, 'open_tab', { tabId: tab.tabId, ...result });
    } catch (error) {
      record.tabs.delete(tab.tabId);
      if (record.activeTabId === tab.tabId) record.activeTabId = firstTabId(record);
      await tab.page.close().catch(() => {});
      throw error;
    }
  }

  async function closeTab(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {}
  ): Promise<Record<string, unknown>> {
    const record = requireSession(workspace, args, context);
    const tab = requireTab(record, args.tabId);
    record.tabs.delete(tab.tabId);
    if (record.activeTabId === tab.tabId) record.activeTabId = firstTabId(record);
    await tab.page.close().catch(() => {});
    return sessionResult(record, 'close_tab', { tabId: tab.tabId, status: 'closed', activeTabId: record.activeTabId });
  }

  async function navigate(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    const record = requireSession(workspace, args, context);
    const tab = requireTab(record, args.tabId);
    const result = await navigateTab(tab, normalizeBrowserUrl(args.url), timeoutFor(args.timeoutMs), options.signal);
    record.activeTabId = tab.tabId;
    return sessionResult(record, 'navigate', { tabId: tab.tabId, ...result });
  }

  async function snapshot(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    const detail = normalizeBrowserSnapshotDetail(args.detail);
    return withTab(workspace, args, context, 'snapshot', options, (record, tab) =>
      withAbort(tab.page.snapshot(timeoutFor(args.timeoutMs), detail, options.signal), options.signal, browserCancellationError).then(result => sessionResult(record, 'snapshot', { tabId: tab.tabId, ...result })));
  }

  async function interact(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    return withTab(workspace, args, context, 'interact', options, (record, tab) =>
      withAbort(tab.page.interact(args, timeoutFor(args.timeoutMs), options.signal), options.signal, browserCancellationError).then(result => sessionResult(record, 'interact', { tabId: tab.tabId, ...result })));
  }

  async function screenshot(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    return withTab(workspace, args, context, 'screenshot', options, (record, tab) =>
      withAbort(tab.page.screenshot(args.fullPage === true, options.signal), options.signal, browserCancellationError).then(result => sessionResult(record, 'screenshot', { tabId: tab.tabId, ...result })));
  }

  async function upload(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    return withTab(workspace, args, context, 'upload', options, async (record, tab) => sessionResult(
      record,
      'upload',
      { tabId: tab.tabId, ...(await uploadAuthorizedBrowserFile(requireLocalIoWorkspace(workspace), tab.page, args, timeoutFor(args.timeoutMs), options)) }
    ));
  }

  async function download(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {},
    options: BrowserOperationOptions = {}
  ): Promise<Record<string, unknown>> {
    return withTab(workspace, args, context, 'download', options, async (record, tab) => sessionResult(
      record,
      'download',
      { tabId: tab.tabId, ...(await downloadBrowserFile(requireLocalIoWorkspace(workspace), tab.page, args, timeoutFor(args.timeoutMs), options)) }
    ));
  }

  async function stop(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {}
  ): Promise<Record<string, unknown>> {
    const record = requireSession(workspace, args, context);
    removeSession(record);
    try {
      await trackClose([record]);
      return { ok: true, workspace: workspace.alias, action: 'stop', sessionId: record.sessionId, status: 'stopped' };
    } catch (error) {
      return { ok: false, workspace: workspace.alias, action: 'stop', sessionId: record.sessionId, status: 'stopped', error: errorMessage(error) };
    }
  }

  async function stopSessionsForTask(taskId: string): Promise<{ stopped: number }> {
    const id = String(taskId || '').trim();
    if (!id) return { stopped: 0 };
    const records = [...sessions.values()].filter(record => record.attribution.taskId === id);
    for (const record of records) removeSession(record);
    await trackClose(records);
    return { stopped: records.length };
  }

  async function shutdown(): Promise<{ stopped: number }> {
    const records = [...sessions.values()];
    for (const record of records) removeSession(record);
    const closing = trackClose(records);
    await Promise.allSettled([closing, ...pendingCloses]);
    return { stopped: records.length };
  }

  async function createTab(record: BrowserSessionRecord, signal?: AbortSignal): Promise<BrowserTabRecord> {
    throwIfAborted(signal, browserCancellationError);
    if (record.tabs.size >= MAX_ACTIVE_BROWSER_TABS_PER_SESSION) {
      throw taskError('BROWSER_TAB_LIMIT', `Rel.AI supports at most ${MAX_ACTIVE_BROWSER_TABS_PER_SESSION} tabs in one local browser session.`);
    }
    const page = await withAbortResource(record.driver.createPage(signal), signal, page => page.close(), browserCancellationError);
    return registerTab(record, page, true);
  }

  function registerTab(record: BrowserSessionRecord, page: BrowserPageDriver, active: boolean): BrowserTabRecord {
    const tab: BrowserTabRecord = {
      tabId: `tab_${crypto.randomBytes(24).toString('base64url')}`,
      page,
      createdAt: new Date().toISOString()
    };
    record.tabs.set(tab.tabId, tab);
    if (active || !record.activeTabId) record.activeTabId = tab.tabId;
    const remove = () => {
      record.tabs.delete(tab.tabId);
      if (record.activeTabId === tab.tabId) record.activeTabId = firstTabId(record);
    };
    page.onClosed(remove);
    page.onCrashed(remove);
    return tab;
  }

  function requireSession(
    workspace: AutomationWorkspace,
    args: BrowserArgs = {},
    context: BrowserContext = {}
  ): BrowserSessionRecord {
    const sessionId = assertBrowserSessionId(args.sessionId);
    const record = sessions.get(sessionId);
    if (!record) throw taskError('BROWSER_SESSION_NOT_FOUND', `Unknown or closed local browser session: ${sessionId}.`);
    assertAutomationAttribution(record.attribution, workspace, args, context, { resource: 'browser' });
    return record;
  }

  function requireTab(record: BrowserSessionRecord, value: unknown): BrowserTabRecord {
    const tabId = value == null || String(value).trim() === '' ? record.activeTabId : assertBrowserTabId(value);
    if (!tabId) throw taskError('BROWSER_TAB_NOT_FOUND', 'The local browser session has no active tab.');
    const tab = record.tabs.get(tabId);
    if (!tab) throw taskError('BROWSER_TAB_NOT_FOUND', `Unknown or closed local browser tab: ${tabId}.`);
    return tab;
  }

  async function withTab<T>(
    workspace: AutomationWorkspace,
    args: BrowserArgs,
    context: BrowserContext,
    _action: string,
    options: BrowserOperationOptions,
    callback: (record: BrowserSessionRecord, tab: BrowserTabRecord) => Promise<T>
  ): Promise<T> {
    throwIfAborted(options.signal, browserCancellationError);
    const record = requireSession(workspace, args, context);
    const tab = requireTab(record, args.tabId);
    record.activeTabId = tab.tabId;
    return callback(record, tab);
  }

  async function tabSummaries(record: BrowserSessionRecord): Promise<Record<string, unknown>[]> {
    return Promise.all([...record.tabs.values()].map(async tab => ({
      tabId: tab.tabId,
      active: tab.tabId === record.activeTabId,
      createdAt: tab.createdAt,
      ...(await tab.page.describe())
    })));
  }

  function removeSession(record: BrowserSessionRecord): void {
    sessions.delete(record.sessionId);
    if (record.profileKey && activeProfiles.get(record.profileKey) === record.sessionId) {
      activeProfiles.delete(record.profileKey);
    }
  }

  async function trackClose(records: readonly BrowserSessionRecord[]): Promise<void> {
    if (!records.length) return;
    const closing = Promise.allSettled(records.map(record => record.driver.close())).then(() => undefined);
    pendingCloses.add(closing);
    try {
      await closing;
    } finally {
      pendingCloses.delete(closing);
    }
  }

  return Object.freeze({
    status,
    start,
    listTabs,
    openTab,
    closeTab,
    navigate,
    snapshot,
    interact,
    screenshot,
    upload,
    download,
    stop,
    stopSessionsForTask,
    shutdown,
    activeSessionCount: () => sessions.size
  });
}

async function navigateTab(tab: BrowserTabRecord, url: string, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return withAbort(tab.page.navigate(url, timeoutMs, signal), signal, browserCancellationError);
}

function sessionResult(record: BrowserSessionRecord, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    workspace: record.attribution.workspaceId,
    action,
    sessionId: record.sessionId,
    activeTabId: record.activeTabId,
    ...extra
  };
}

function normalizeBrowserUrl(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Browser navigation requires url.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Browser url must be an absolute http or https URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Browser url must use http or https.');
  return url.href;
}

function assertBrowserSessionId(value: unknown): string {
  const sessionId = String(value || '').trim();
  if (!BROWSER_SESSION_ID.test(sessionId)) throw new Error('Invalid browser sessionId.');
  return sessionId;
}

function assertBrowserTabId(value: unknown): string {
  const tabId = String(value || '').trim();
  if (!BROWSER_TAB_ID.test(tabId)) throw new Error('Invalid browser tabId.');
  return tabId;
}

function firstTabId(record: BrowserSessionRecord): string {
  return record.tabs.keys().next().value || '';
}

function normalizeProfileKey(value: string): string {
  const path = String(value || '').trim();
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

function requireLocalIoWorkspace(workspace: AutomationWorkspace): BrowserLocalIoWorkspace {
  const candidate = workspace as AutomationWorkspace & { path?: unknown; sourcePaths?: unknown };
  const path = String(candidate.path || '').trim();
  if (!path) throw new Error('Browser file transfer requires a resolved local workspace path.');
  return {
    alias: workspace.alias,
    path,
    ...(Array.isArray(candidate.sourcePaths) ? { sourcePaths: candidate.sourcePaths.map(String) } : {})
  };
}

function attributionMatches(attribution: AutomationAttribution, workspace: AutomationWorkspace, context: BrowserContext): boolean {
  try {
    assertAutomationAttribution(attribution, workspace, {}, context, { resource: 'browser', ignoreTask: true });
    return true;
  } catch {
    return false;
  }
}

function browserCancellationError(signal: AbortSignal): Error {
  return taskError('BROWSER_OPERATION_CANCELLED', errorMessage(signal.reason || 'Browser operation cancelled.'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

const browserRuntime = createBrowserRuntime();
registerTerminalTaskCleanup(taskId => browserRuntime.stopSessionsForTask(taskId));

async function stopAllBrowserSessions(): Promise<{ stopped: number }> {
  return browserRuntime.shutdown();
}

export { browserRuntime, createBrowserRuntime, normalizeBrowserUrl, stopAllBrowserSessions };
export type { BrowserArgs, BrowserContext, BrowserOperationOptions, BrowserRuntime };
