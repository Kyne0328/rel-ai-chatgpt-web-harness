import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  launchLocalBrowserDriver,
  type BrowserDownloadHandle,
  type BrowserPageDriver,
  type BrowserPageResult,
  type LaunchBrowserDriverOptions,
  type LocalBrowserDriver
} from './playwrightBrowserDriver.ts';
import type { StructuredInteractionArgs } from './playwrightPrimitives.ts';

type NativeBrowserBridge = (
  payload: Record<string, unknown>,
  options?: Readonly<{ signal?: AbortSignal }>
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
type NativeBrowserEvent = Readonly<Record<string, unknown> & {
  resource?: unknown;
  type?: unknown;
  nativeSessionId?: unknown;
  nativePageId?: unknown;
}>;

type NativePageListeners = {
  nativeSessionId: string;
  onClosed: (() => void) | null;
  onCrashed: (() => void) | null;
};

const DOWNLOAD_TEMP_ROOT = path.resolve(os.tmpdir(), 'relai-browser-downloads');
let nativeBrowserBridge: NativeBrowserBridge | null = null;
const sessionDisconnectListeners = new Map<string, () => void>();
const sessionPageCreatedListeners = new Map<string, (page: BrowserPageDriver, active: boolean) => void>();
const pageListeners = new Map<string, NativePageListeners>();

function configureBrowserNativeBridge(bridge: NativeBrowserBridge | null): void {
  if (bridge !== null && typeof bridge !== 'function') throw new TypeError('Browser native bridge must be a function or null.');
  nativeBrowserBridge = bridge;
}

function dispatchBrowserNativeEvent(event: NativeBrowserEvent = {}): void {
  if (String(event.resource || '') !== 'browser') return;
  const type = String(event.type || '');
  const nativeSessionId = String(event.nativeSessionId || '');
  const nativePageId = String(event.nativePageId || '');

  if (type === 'session_disconnected' && nativeSessionId) {
    const listener = sessionDisconnectListeners.get(nativeSessionId);
    sessionDisconnectListeners.delete(nativeSessionId);
    sessionPageCreatedListeners.delete(nativeSessionId);
    for (const [pageId, entry] of pageListeners) {
      if (entry.nativeSessionId === nativeSessionId) pageListeners.delete(pageId);
    }
    listener?.();
    return;
  }

  if (type === 'page_opened' && nativeSessionId && nativePageId) {
    const listener = sessionPageCreatedListeners.get(nativeSessionId);
    if (listener && nativeBrowserBridge) listener(createNativePageProxy(nativeBrowserBridge, nativeSessionId, nativePageId), event.active !== false);
    return;
  }

  if (!nativePageId) return;
  const entry = pageListeners.get(nativePageId);
  if (!entry) return;
  if (type === 'page_crashed') {
    pageListeners.delete(nativePageId);
    entry.onCrashed?.();
  } else if (type === 'page_closed') {
    pageListeners.delete(nativePageId);
    entry.onClosed?.();
  }
}

async function launchBrowserDriver(options: LaunchBrowserDriverOptions): Promise<LocalBrowserDriver> {
  const bridge = nativeBrowserBridge;
  if (!bridge) return launchLocalBrowserDriver(options);

  const started = objectValue(await bridge({
    action: 'start',
    viewport: options.viewport,
    ignoreHTTPSErrors: options.ignoreHTTPSErrors === true,
    ...(options.profileDirectory ? { profileDirectory: options.profileDirectory } : {})
  }, options.signal ? { signal: options.signal } : undefined));
  const nativeSessionId = requiredId(started.nativeSessionId, 'Embedded browser session');
  let onDisconnected: (() => void) | null = null;
  sessionDisconnectListeners.set(nativeSessionId, () => onDisconnected?.());

  return Object.freeze({
    browserProduct: String(started.browserProduct || 'Rel.AI Embedded Chromium'),
    createPage: (signal?: AbortSignal) => createNativePage(bridge, nativeSessionId, signal),
    close: async () => {
      sessionDisconnectListeners.delete(nativeSessionId);
      sessionPageCreatedListeners.delete(nativeSessionId);
      for (const [pageId, entry] of pageListeners) {
        if (entry.nativeSessionId === nativeSessionId) pageListeners.delete(pageId);
      }
      await bridge({ action: 'close_session', nativeSessionId });
    },
    onDisconnected: (listener: () => void) => { onDisconnected = listener; },
    onPageCreated: (listener: (page: BrowserPageDriver, active: boolean) => void) => { sessionPageCreatedListeners.set(nativeSessionId, listener); },
    setControl: async (owner: 'ai' | 'user', reason = '') => {
      await bridge({ action: 'set_control', nativeSessionId, owner, reason });
    }
  });
}

async function createNativePage(bridge: NativeBrowserBridge, nativeSessionId: string, signal?: AbortSignal): Promise<BrowserPageDriver> {
  const opened = objectValue(await bridge({ action: 'open_page', nativeSessionId }, signal ? { signal } : undefined));
  const nativePageId = requiredId(opened.nativePageId, 'Embedded browser page');
  return createNativePageProxy(bridge, nativeSessionId, nativePageId);
}

function createNativePageProxy(bridge: NativeBrowserBridge, nativeSessionId: string, nativePageId: string): BrowserPageDriver {
  const listeners: NativePageListeners = { nativeSessionId, onClosed: null, onCrashed: null };
  pageListeners.set(nativePageId, listeners);

  const request = async (
    action: string,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> =>
    objectValue(await bridge({ action, nativeSessionId, nativePageId, ...extra }, signal ? { signal } : undefined));
  const requestPage = async (
    action: string,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal
  ): Promise<BrowserPageResult> => {
    const result = await request(action, extra, signal);
    const {
      loading: _loading,
      ok: _ok,
      nativeSessionId: _nativeSessionId,
      nativePageId: _nativePageId,
      ...publicResult
    } = result;
    return { ...publicResult, url: String(result.url || '') };
  };

  return Object.freeze({
    describe: (signal?: AbortSignal) => requestPage('describe', {}, signal),
    navigate: (url: string, timeoutMs: number, signal?: AbortSignal) => requestPage('navigate', { url, timeoutMs }, signal),
    snapshot: (timeoutMs: number, detail = 'semantic', signal?: AbortSignal) => requestPage('snapshot', { timeoutMs, detail }, signal),
    interact: (args: StructuredInteractionArgs, timeoutMs: number, signal?: AbortSignal) => requestPage('interact', { ...args, timeoutMs }, signal),
    screenshot: (fullPage: boolean, signal?: AbortSignal) => requestPage('screenshot', { fullPage }, signal),
    upload: (args: StructuredInteractionArgs, filePath: string, timeoutMs: number, signal?: AbortSignal) =>
      requestPage('upload', { target: args.target, filePath, timeoutMs }, signal),
    beginDownload: async (args: StructuredInteractionArgs, timeoutMs: number, signal?: AbortSignal): Promise<BrowserDownloadHandle> => {
      const result = await request('begin_download', { ...args, timeoutMs }, signal);
      const tempPath = requireDownloadTempPath(result.tempPath);
      const suggestedFilename = String(result.suggestedFilename || 'download');
      return Object.freeze({
        suggestedFilename,
        createReadStream: async () => fs.createReadStream(tempPath),
        cancel: async () => {},
        delete: async () => { await fs.promises.rm(tempPath, { force: true }).catch(() => {}); }
      });
    },
    close: async () => {
      pageListeners.delete(nativePageId);
      await bridge({ action: 'close_page', nativeSessionId, nativePageId });
    },
    onClosed: (listener: () => void) => { listeners.onClosed = listener; },
    onCrashed: (listener: () => void) => { listeners.onCrashed = listener; }
  });
}

function requireDownloadTempPath(value: unknown): string {
  const candidate = path.resolve(String(value || ''));
  const relative = path.relative(DOWNLOAD_TEMP_ROOT, candidate);
  if (!candidate || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Embedded browser download did not return an authorized temporary file.');
  }
  return candidate;
}

function requiredId(value: unknown, label: string): string {
  const id = String(value || '').trim();
  if (!id) throw new Error(`${label} identifier is unavailable.`);
  return id;
}

function objectValue(value: Record<string, unknown> | void): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export {
  configureBrowserNativeBridge, dispatchBrowserNativeEvent, launchBrowserDriver
};
export type { BrowserPageDriver, LocalBrowserDriver };
