import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow } from 'electron';
import { dashboardWindowChrome } from '../../../electron/window-chrome.js';

const targetUrl = process.env.RELAI_PROBE_TARGET_URL;
const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;
const expectedToolCount = Number(process.env.RELAI_EXPECTED_TOOL_COUNT || 0);
const chromePlatform = String(process.env.RELAI_PROBE_CHROME_PLATFORM || 'win32');
const visualScreenshotPath = String(process.env.RELAI_PROBE_VISUAL_SCREENSHOT_PATH || '').trim();
const fixedVisualWindow = process.env.RELAI_PROBE_FIXED_VISUAL_WINDOW === '1';
if (!targetUrl || !outputPath || !Number.isInteger(expectedToolCount) || expectedToolCount < 1) throw new Error('Custom chrome probe environment is incomplete.');
if (!['win32', 'darwin'].includes(chromePlatform)) throw new Error(`Unsupported custom chrome probe platform: ${chromePlatform}`);

app.whenReady().then(async () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const consoleErrors = [];
  const chrome = dashboardWindowChrome(chromePlatform);
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    ...chrome.windowOptions,
    webPreferences: {
      preload: path.join(root, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  try {
    if (!fixedVisualWindow) win.maximize();
    await win.loadURL(targetUrl);
    await win.webContents.executeJavaScript(`localStorage.setItem('relai_ui_density', 'compact')`);
    await win.loadURL(targetUrl);
    await waitFor(win, `!document.documentElement.dataset.density && document.querySelector('#routeRoot')?.children.length > 0`);
    if (visualScreenshotPath) await captureVisualRegressionScreenshot(win, visualScreenshotPath);
    const measurements = [];
    for (const route of ['usage', 'tools', 'tasks']) {
      await win.webContents.executeJavaScript(`location.hash = '#${route}'`);
      await waitFor(win, `location.hash === '#${route}' && document.querySelector('#routeRoot')?.children.length > 0`);
      if (route === 'tools') await waitFor(win, `document.querySelectorAll('.tool-card').length === ${expectedToolCount}`);
      if (route === 'usage') {
        await waitFor(win, `document.querySelector('.usage-overview') || document.querySelector('[data-usage-unavailable]')`);
        await waitFor(win, `document.querySelector('[data-usage-matrix] .analytics-categorical-matrix') || document.querySelector('[data-usage-unavailable]')`);
      }
      measurements.push(await win.webContents.executeJavaScript(`(() => {
        const titlebar = document.getElementById('windowTitlebar').getBoundingClientRect();
        const shell = document.querySelector('.app-shell').getBoundingClientRect();
        const main = document.getElementById('main').getBoundingClientRect();
        const topbar = document.querySelector('.topbar').getBoundingClientRect();
        const title = document.getElementById('pageTitle').getBoundingClientRect();
        const usageMetricOverflow = location.hash === '#usage'
          ? Math.max(0, ...[...document.querySelectorAll('.usage-metric canvas')].map(canvas => {
              const metric = canvas.closest('.usage-metric');
              if (!metric) return 0;
              const canvasRect = canvas.getBoundingClientRect();
              const metricRect = metric.getBoundingClientRect();
              return Math.max(0, canvasRect.right - metricRect.right, metricRect.left - canvasRect.left);
            }))
          : 0;
        return {
          route: location.hash,
          chrome: document.documentElement.dataset.windowChrome,
          density: document.documentElement.dataset.density || '',
          titlebarBottom: titlebar.bottom,
          shellTop: shell.top,
          mainTop: main.top,
          topbarTop: topbar.top,
          titleTop: title.top,
          titleBottom: title.bottom,
          titleOverflow: getComputedStyle(document.getElementById('pageTitle')).overflow,
          localAnalyticsLoaded: location.hash !== '#usage' || Boolean(document.querySelector('.usage-overview')),
          inlineUsageError: Boolean(document.querySelector('[data-usage-unavailable]')),
          usageMetricOverflow,
          usageMatrixLoaded: location.hash !== '#usage' || Boolean(document.querySelector('[data-usage-matrix] .analytics-categorical-matrix')),
          usageMatrixText: location.hash === '#usage' ? document.querySelector('[data-usage-matrix]')?.textContent || '' : '',
          documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
          toolCategories: location.hash === '#tools' ? Object.fromEntries([...document.querySelectorAll('.tool-card')].map(card => [card.querySelector('code')?.textContent || '', card.querySelector('.tool-capability')?.textContent || ''])) : {},
          titleVisible: title.top >= titlebar.bottom - 0.5,
          shellClear: shell.top >= titlebar.bottom - 0.5,
          mainClear: main.top >= titlebar.bottom - 0.5,
          topbarClear: topbar.top >= titlebar.bottom - 0.5
        };
      })()`));
    }
    fs.writeFileSync(outputPath, JSON.stringify({ chromePlatform, controls: chrome.controls, measurements, visualScreenshot: visualScreenshotPath }, null, 2));
  } catch (error) {
    let diagnostic = {};
    try {
      diagnostic = await win.webContents.executeJavaScript(`(() => ({ href: location.href, chrome: document.documentElement.dataset.windowChrome || '', bridge: typeof window.relaiDesktop, pageTitle: document.querySelector('#pageTitle')?.textContent || '', contentText: document.querySelector('#routeRoot')?.textContent?.slice(0, 500) || '', bodyText: document.body?.innerText?.slice(0, 800) || '' }))()`);
    } catch {}
    fs.writeFileSync(outputPath, JSON.stringify({ error: error?.stack || String(error), diagnostic, consoleErrors }, null, 2));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});

async function captureVisualRegressionScreenshot(win, targetPath) {
  if (win.isMaximized()) win.unmaximize();
  win.setContentSize(1280, 820);
  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.dataset.themePreference = 'dark';
    document.documentElement.dataset.theme = 'dark';
  })()`);
  await win.webContents.executeJavaScript(`location.hash = '#tasks'`);
  await waitForStableRoute(win, '#tasks', 'Tasks');
  // Recovery notices intentionally disappear after reconnect. Never baseline that transient state.
  await waitFor(win, `!document.getElementById('dashboardRecoveryNotice')`, 5000);
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('__relai-visual-regression-mask')?.remove();
    const style = document.createElement('style');
    style.id = '__relai-visual-regression-mask';
    style.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; text-shadow: none !important; } * { color: transparent !important; } img, svg, canvas { visibility: hidden !important; } input, textarea { color: transparent !important; }';
    document.head.append(style);
    window.scrollTo(0, 0);
  })()`);
  await waitForStableRoute(win, '#tasks', 'Tasks');
  const png = await captureStablePage(win);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, png);
}

async function captureStablePage(win, attempts = 10) {
  let previous = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const png = (await win.webContents.capturePage()).toPNG();
    if (previous?.equals(png)) return png;
    previous = png;
  }
  throw new Error(`Dashboard compositor did not stabilize after ${attempts} captures.`);
}

async function waitForStableRoute(win, hash, title, stableChecks = 6) {
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    const state = await win.webContents.executeJavaScript(`(() => ({
      hash: location.hash,
      title: document.getElementById('pageTitle')?.textContent || '',
      sessions: Boolean(document.querySelector('[data-sessions-react]')),
      summary: Boolean(document.querySelector('[data-session-summary]')),
      tasksEmpty: document.querySelector('.sessions-history-card .empty')?.textContent?.trim() === 'No tasks yet.',
      inspectorEmpty: Boolean(document.querySelector('.session-inspector .inspector-empty')),
      dashboardState: Boolean(document.querySelector('#routeRoot .dashboard-state')),
      recovery: Boolean(document.getElementById('dashboardRecoveryNotice'))
    }))()`);
    const ready = state.hash === hash
      && state.title === title
      && state.sessions
      && state.summary
      && state.tasksEmpty
      && state.inspectorEmpty
      && !state.dashboardState
      && !state.recovery;
    if (ready) {
      stable += 1;
      if (stable >= stableChecks) return;
    } else {
      stable = 0;
      if (state.hash !== hash) await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for stable ${hash} route.`);
}

async function waitFor(win, expression, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
