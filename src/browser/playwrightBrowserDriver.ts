import type { Readable } from 'node:stream';
import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright-core';
import { taskError } from '../toolActivity.js';
import { MAX_SNAPSHOT_CHARS, boundText, sanitizeUiUrl } from '../computer/webPolicy.ts';
import { layoutSnapshotExpression, normalizeBrowserSnapshotDetail } from './layoutSnapshot.js';
import {
  performStructuredInteraction,
  resolveChromiumRuntime,
  safeTitle,
  screenshotPage,
  targetLocator,
  type StructuredInteractionArgs
} from './playwrightPrimitives.ts';

type Viewport = Readonly<{ width: number; height: number }>;

type BrowserPageResult = Record<string, unknown> & Readonly<{ url: string }>;
type BrowserSnapshotDetail = 'semantic' | 'layout';

type LaunchBrowserDriverOptions = Readonly<{
  viewport: Viewport;
  ignoreHTTPSErrors?: boolean;
  profileDirectory?: string;
  signal?: AbortSignal;
}>;

interface BrowserDownloadHandle {
  readonly suggestedFilename: string;
  createReadStream(): Promise<Readable>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
}

interface BrowserPageDriver {
  describe(signal?: AbortSignal): Promise<BrowserPageResult>;
  navigate(url: string, timeoutMs: number, signal?: AbortSignal): Promise<BrowserPageResult>;
  snapshot(timeoutMs: number, detail?: BrowserSnapshotDetail, signal?: AbortSignal): Promise<BrowserPageResult>;
  interact(args: StructuredInteractionArgs, timeoutMs: number, signal?: AbortSignal): Promise<BrowserPageResult>;
  screenshot(fullPage: boolean, signal?: AbortSignal): Promise<BrowserPageResult>;
  upload(args: StructuredInteractionArgs, filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<BrowserPageResult>;
  beginDownload(args: StructuredInteractionArgs, timeoutMs: number, signal?: AbortSignal): Promise<BrowserDownloadHandle>;
  close(): Promise<void>;
  onClosed(listener: () => void): void;
  onCrashed(listener: () => void): void;
}

interface LocalBrowserDriver {
  readonly recordsPersistentSites?: boolean;
  readonly browserProduct: string;
  createPage(signal?: AbortSignal): Promise<BrowserPageDriver>;
  close(): Promise<void>;
  onDisconnected(listener: () => void): void;
  onPageCreated?(listener: (page: BrowserPageDriver, active: boolean) => void): void;
  setControl?(owner: 'ai' | 'user', reason?: string): Promise<void>;
}

async function launchLocalBrowserDriver(options: LaunchBrowserDriverOptions): Promise<LocalBrowserDriver> {
  const runtime = resolveChromiumRuntime({
    overrideEnvironmentVariables: ['REL_AI_BROWSER_CHROMIUM_PATH', 'REL_AI_UI_CHROMIUM_PATH'],
    invalidOverrideMessage: 'Configured Chromium path does not point to an available file.',
    unavailableCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    unavailableMessage: 'No supported local Chromium runtime was found. Install Chrome, Edge, or Chromium, or configure a Chromium path.'
  });
  const persistent = Boolean(options.profileDirectory);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    if (persistent) {
      context = await chromium.launchPersistentContext(String(options.profileDirectory), {
        headless: false,
        executablePath: runtime.executablePath,
        viewport: options.viewport,
        ignoreHTTPSErrors: options.ignoreHTTPSErrors === true
      });
      browser = context.browser() || undefined;
    } else {
      browser = await chromium.launch({ headless: false, executablePath: runtime.executablePath });
      context = await browser.newContext({
        viewport: options.viewport,
        ignoreHTTPSErrors: options.ignoreHTTPSErrors === true
      });
    }
    const currentBrowser = browser;
    const currentContext = context;
    return Object.freeze({
      browserProduct: runtime.product,
      createPage: async () => wrapPage(await currentContext.newPage()),
      close: async () => {
        const failures: unknown[] = [];
        await currentContext.close().catch(error => failures.push(error));
        if (!persistent) await currentBrowser?.close().catch(error => failures.push(error));
        if (failures.length) throw new Error(failures.map(errorMessage).join('; '));
      },
      onDisconnected: (listener: () => void) => currentBrowser?.once('disconnected', listener),
      setControl: async () => {}
    });
  } catch (error) {
    await context?.close().catch(() => {});
    if (!persistent) await browser?.close().catch(() => {});
    if (persistent) {
      const wrapped = taskError(
        'BROWSER_PROFILE_UNAVAILABLE',
        'The persistent Rel.AI browser profile could not be opened. Close other sessions using it or clear the invalid browser profile before retrying.'
      ) as Error & { cause?: unknown };
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }
}

function wrapPage(page: Page): BrowserPageDriver {
  return Object.freeze({
    describe: async (_signal?: AbortSignal) => {
      assertSupportedPageUrl(page, true);
      return pageResult(page, { title: await safeTitle(page) });
    },
    navigate: async (url: string, timeoutMs: number, _signal?: AbortSignal) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      assertSupportedPageUrl(page);
      return pageResult(page, { statusCode: response?.status() ?? null, title: await safeTitle(page) });
    },
    snapshot: async (timeoutMs: number, detail: BrowserSnapshotDetail = 'semantic', _signal?: AbortSignal) => {
      assertSupportedPageUrl(page);
      const normalizedDetail = normalizeBrowserSnapshotDetail(detail) as BrowserSnapshotDetail;
      const raw = normalizedDetail === 'layout'
        ? String(await page.evaluate(layoutSnapshotExpression()))
        : await semanticSnapshotWithFrames(page, timeoutMs);
      const bounded = boundText(raw, MAX_SNAPSHOT_CHARS);
      return pageResult(page, { title: await safeTitle(page), detail: normalizedDetail, snapshot: bounded.text, truncated: bounded.truncated });
    },
    interact: async (args: StructuredInteractionArgs, timeoutMs: number, _signal?: AbortSignal) => {
      assertSupportedPageUrl(page);
      const interaction = await performStructuredInteraction(page, args, timeoutMs, 'browser');
      assertSupportedPageUrl(page);
      return pageResult(page, { ...interaction, title: await safeTitle(page) });
    },
    screenshot: async (fullPage: boolean, _signal?: AbortSignal) => {
      assertSupportedPageUrl(page);
      return pageResult(page, {
        title: await safeTitle(page),
        ...(await screenshotPage(page, fullPage, 'Browser screenshot'))
      });
    },
    upload: async (args: StructuredInteractionArgs, filePath: string, timeoutMs: number, _signal?: AbortSignal) => {
      assertSupportedPageUrl(page);
      await targetLocator(page, args.target).setInputFiles(filePath, { timeout: timeoutMs });
      assertSupportedPageUrl(page);
      return pageResult(page, { interaction: 'upload', title: await safeTitle(page) });
    },
    beginDownload: async (args: StructuredInteractionArgs, timeoutMs: number, _signal?: AbortSignal) => {
      assertSupportedPageUrl(page);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: timeoutMs }),
        performStructuredInteraction(page, args, timeoutMs, 'browser download')
      ]);
      assertSupportedPageUrl(page);
      return wrapDownload(download);
    },
    close: () => page.close(),
    onClosed: (listener: () => void) => page.once('close', listener),
    onCrashed: (listener: () => void) => page.once('crash', listener)
  });
}

function wrapDownload(download: Download): BrowserDownloadHandle {
  return Object.freeze({
    suggestedFilename: download.suggestedFilename(),
    createReadStream: async () => {
      const stream = await download.createReadStream();
      if (!stream) throw new Error('Browser download content is unavailable.');
      return stream;
    },
    cancel: () => download.cancel(),
    delete: () => download.delete()
  });
}

async function semanticSnapshotWithFrames(page: Page, timeoutMs: number): Promise<string> {
  const sections: string[] = [await page.locator('body').ariaSnapshot({ timeout: timeoutMs })];
  const frames = page.frames().filter(frame => frame !== page.mainFrame());
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (!frame) continue;
    try {
      const snapshot = await frame.locator('body').ariaSnapshot({ timeout: timeoutMs });
      sections.push(`[Frame ${index}: ${frame.name() || 'unnamed'} ${sanitizeUiUrl(frame.url())}]\n${snapshot}`);
    } catch {}
  }
  return sections.join('\n\n');
}

function pageResult(page: Page, extra: Record<string, unknown> = {}): BrowserPageResult {
  const frames = page.frames().filter(frame => frame !== page.mainFrame()).map((frame, index) => ({
    index,
    name: frame.name(),
    url: sanitizeUiUrl(frame.url())
  }));
  return { url: sanitizeUiUrl(page.url()), ...(frames.length ? { frames } : {}), ...extra };
}

function assertSupportedPageUrl(page: Page, allowBlank = false): void {
  const value = page.url();
  if (allowBlank && value === 'about:blank') return;
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return;
  } catch {}
  throw taskError('BROWSER_NAVIGATION_BLOCKED', 'The page navigated outside the supported http/https browser boundary.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

export { launchLocalBrowserDriver };
export type {
  BrowserDownloadHandle,
  BrowserPageDriver,
  BrowserPageResult,
  LaunchBrowserDriverOptions,
  LocalBrowserDriver
};
