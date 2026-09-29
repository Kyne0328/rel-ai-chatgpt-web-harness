import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, type Frame, type Locator, type Page } from 'playwright-core';
import { taskError } from '../toolActivity.js';
import {
  DEFAULT_VIEWPORT,
  MAX_SCREENSHOT_BYTES,
  boundText,
  normalizeWaitState
} from '../computer/webPolicy.ts';

type StructuredFrameTarget = Readonly<{
  by?: unknown;
  value?: unknown;
  exact?: unknown;
  index?: unknown;
}>;

type StructuredTarget = Readonly<{
  by?: unknown;
  value?: unknown;
  name?: unknown;
  exact?: unknown;
  index?: unknown;
  frame?: StructuredFrameTarget;
}>;

type StructuredInteractionArgs = Readonly<{
  interaction?: unknown;
  target?: StructuredTarget;
  input?: unknown;
  key?: unknown;
  selectValue?: unknown;
  state?: unknown;
}>;

type ChromiumRuntime = Readonly<{ executablePath: string; product: string }>;

type ChromiumRuntimeOptions = Readonly<{
  overrideEnvironmentVariables?: readonly string[];
  invalidOverrideMessage?: string;
  unavailableCode?: string;
  unavailableMessage?: string;
}>;

function resolveChromiumRuntime(options: ChromiumRuntimeOptions = {}): ChromiumRuntime {
  for (const environmentVariable of options.overrideEnvironmentVariables || []) {
    const override = String(process.env[environmentVariable] || '').trim();
    if (!override) continue;
    if (!isExecutableFile(override)) {
      throw new Error(options.invalidOverrideMessage || `${environmentVariable} does not point to an available file.`);
    }
    return { executablePath: override, product: 'configured Chromium' };
  }
  for (const candidate of chromiumCandidates()) {
    if (isExecutableFile(candidate.executablePath)) return candidate;
  }
  throw taskError(
    options.unavailableCode || 'BROWSER_RUNTIME_UNAVAILABLE',
    options.unavailableMessage || 'No supported local Chromium runtime was found. Install Chrome, Edge, or Chromium.'
  );
}

async function performStructuredInteraction(
  page: Page,
  args: StructuredInteractionArgs,
  timeoutMs: number,
  label = 'browser'
): Promise<{ interaction: string; target: Record<string, unknown> }> {
  const interaction = String(args.interaction || '').trim();
  const locator = targetLocator(page, args.target);
  switch (interaction) {
    case 'click':
      await locator.click({ timeout: timeoutMs });
      break;
    case 'fill':
      await locator.fill(String(args.input ?? ''), { timeout: timeoutMs });
      break;
    case 'press':
      if (!String(args.key || '').trim()) throw new Error(`${label} interact press requires key.`);
      await locator.press(String(args.key), { timeout: timeoutMs });
      break;
    case 'select':
      if (args.selectValue == null) throw new Error(`${label} interact select requires selectValue.`);
      await locator.selectOption(String(args.selectValue), { timeout: timeoutMs });
      break;
    case 'hover':
      await locator.hover({ timeout: timeoutMs });
      break;
    case 'wait':
      await locator.waitFor({ state: normalizeWaitState(args.state), timeout: timeoutMs });
      break;
    default:
      throw new Error(`Unsupported ${label} interaction '${interaction || '(missing)'}.`);
  }
  return { interaction, target: publicTarget(args.target) };
}

async function screenshotPage(
  page: Page,
  fullPage: boolean,
  label = 'Browser screenshot'
): Promise<Record<string, unknown>> {
  const buffer = await page.screenshot({ type: 'png', fullPage, animations: 'disabled' });
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    throw new Error(`${label} is ${buffer.length} bytes; the limit is ${MAX_SCREENSHOT_BYTES} bytes. Use the current viewport instead of fullPage.`);
  }
  const viewport = page.viewportSize() || DEFAULT_VIEWPORT;
  const imageWidth = buffer.length >= 24 ? buffer.readUInt32BE(16) : viewport.width;
  const imageHeight = buffer.length >= 24 ? buffer.readUInt32BE(20) : viewport.height;
  return {
    viewport,
    image: {
      mimeType: 'image/png',
      data: buffer.toString('base64'),
      bytes: buffer.length,
      width: imageWidth,
      height: imageHeight,
      fullPage
    }
  };
}

function targetLocator(page: Page, target: StructuredTarget | undefined): Locator {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('interact requires target.');
  const root: Page | Frame = targetFrame(page, target.frame);
  const by = String(target.by || '').trim();
  const value = String(target.value || '');
  if (!value) throw new Error('target.value is required.');
  const exact = target.exact === true;
  let locator: Locator;
  switch (by) {
    case 'role': locator = root.getByRole(value as never, target.name ? { name: String(target.name), exact } : {}); break;
    case 'text': locator = root.getByText(value, { exact }); break;
    case 'label': locator = root.getByLabel(value, { exact }); break;
    case 'placeholder': locator = root.getByPlaceholder(value, { exact }); break;
    case 'testid': locator = root.getByTestId(value); break;
    case 'css': locator = root.locator(value); break;
    default: throw new Error(`Unsupported target.by '${by || '(missing)'}.`);
  }
  const index = Number(target.index);
  if (Number.isInteger(index) && index >= 0) locator = locator.nth(index);
  return locator;
}

function targetFrame(page: Page, target: StructuredFrameTarget | undefined): Page | Frame {
  if (!target) return page;
  const by = String(target.by || '').trim();
  const wanted = String(target.value || '').trim();
  if (!wanted) throw new Error('target.frame.value is required.');
  if (by !== 'name' && by !== 'url') throw new Error(`Unsupported target.frame.by '${by || '(missing)'}.`);
  const exact = target.exact === true;
  const normalize = (value: string) => value.trim().toLowerCase();
  const matches = (value: string) => exact ? value.trim() === wanted : normalize(value).includes(normalize(wanted));
  const frames = page.frames().filter(frame => frame !== page.mainFrame()).filter(frame => matches(by === 'name' ? frame.name() : frame.url()));
  const index = Number(target.index);
  const selected = frames[Number.isInteger(index) && index >= 0 ? index : 0];
  if (!selected) throw new Error(`Browser frame target was not found by ${by}.`);
  return selected;
}

function publicTarget(target: StructuredTarget | undefined = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    by: target.by,
    value: target.value,
    name: target.name,
    exact: target.exact === true ? true : undefined,
    index: Number.isInteger(Number(target.index)) ? Number(target.index) : undefined,
    frame: target.frame ? publicFrameTarget(target.frame) : undefined
  }).filter(([, value]) => value !== undefined && value !== ''));
}

function publicFrameTarget(target: StructuredFrameTarget): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    by: target.by,
    value: target.value,
    exact: target.exact === true ? true : undefined,
    index: Number.isInteger(Number(target.index)) ? Number(target.index) : undefined
  }).filter(([, value]) => value !== undefined && value !== ''));
}

async function safeTitle(page: Page): Promise<string> {
  try { return boundText(await page.title(), 1000).text; } catch { return ''; }
}

function chromiumCandidates(): ChromiumRuntime[] {
  const candidates: ChromiumRuntime[] = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((value): value is string => Boolean(value));
    for (const root of roots) {
      candidates.push({ executablePath: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), product: 'Microsoft Edge' });
      candidates.push({ executablePath: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), product: 'Google Chrome' });
      candidates.push({ executablePath: path.join(root, 'Chromium', 'Application', 'chrome.exe'), product: 'Chromium' });
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', product: 'Google Chrome' },
      { executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', product: 'Microsoft Edge' },
      { executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium', product: 'Chromium' }
    );
  } else {
    for (const [name, product] of [
      ['google-chrome', 'Google Chrome'],
      ['google-chrome-stable', 'Google Chrome'],
      ['microsoft-edge', 'Microsoft Edge'],
      ['microsoft-edge-stable', 'Microsoft Edge'],
      ['chromium', 'Chromium'],
      ['chromium-browser', 'Chromium']
    ] as const) {
      const resolved = spawnSync('which', [name], { encoding: 'utf8', windowsHide: true });
      const executablePath = String(resolved.stdout || '').trim().split(/\r?\n/, 1)[0];
      if (executablePath) candidates.push({ executablePath, product });
    }
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled) candidates.push({ executablePath: bundled, product: 'Chromium' });
  } catch {}
  return candidates;
}

function isExecutableFile(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export {
  performStructuredInteraction,
  publicTarget,
  resolveChromiumRuntime,
  safeTitle,
  screenshotPage,
  targetLocator
};
export type { ChromiumRuntime, StructuredInteractionArgs, StructuredTarget };
