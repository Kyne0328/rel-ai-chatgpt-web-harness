/* global document:readonly, window:readonly, getComputedStyle:readonly, innerWidth:readonly */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import axe from 'axe-core';
import { availablePort } from './helpers/available-port.mjs';
import { buildDiagnosticReport } from '../src/diagnostics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-resource-browser-'));
const keepArtifacts = process.env.RELAI_KEEP_RESOURCE_PROBE_ARTIFACTS === '1';
const stateDir = path.join(temp, 'state');
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
const probePath = path.join(temp, 'resource-probe.cjs');
const screenshotDir = path.join(temp, 'screenshots');
const token = 'isolated-resource-browser-test';
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ version: 3, stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl'), workspaces: { fixture: { path: workspace, commands: {} } } }));
fs.writeFileSync(probePath, "const { app, BrowserWindow } = require('electron');\napp.whenReady().then(() => { const window = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } }); window.loadURL('about:blank'); });\napp.on('window-all-closed', () => app.quit());\n");
const server = spawn(process.execPath, [path.join(root, 'bin/rel-ai-mcp-http.js'), '--host', '127.0.0.1', '--port', String(port), '--no-profile-write'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, REL_AI_MCP_CONFIG: configPath, REL_AI_MCP_TOKEN: token, REL_AI_MCP_STATE_DIR: stateDir, REL_AI_MCP_TELEMETRY_DISABLED: '1' }
});
let serverError = '';
server.stderr.on('data', chunk => { serverError = (serverError + chunk.toString()).slice(-8_000); });
server.stdout.on('data', () => {});
const serverClosed = once(server, 'close').catch(() => []);
let application;
const screenshots = [];
const consoleErrors = [];
const results = [];

try {
  await waitForHealth();
  const executablePath = process.env.RELAI_ELECTRON_BINARY || path.join(root, 'electron/node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  assert.equal(fs.existsSync(executablePath), true, `Electron test binary missing: ${executablePath}`);
  const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  application = await electron.launch({
    executablePath, args: ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', `--user-data-dir=${path.join(temp, 'electron-profile')}`, probePath],
    cwd: root, env, timeout: 20_000
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let fixture = resourceFixture('normal');
  let requestCount = 0;
  const routePattern = '**/api/diagnostics*';
  await page.route(routePattern, async route => {
    requestCount += 1;
    const response = fixture;
    await new Promise(resolve => setTimeout(resolve, 120));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto(`${base}/dashboard?token=${encodeURIComponent(token)}#diagnostics`);
  const panel = page.locator('[data-diagnostic-region="resources"]');
  await panel.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-diagnostic-region="resources"]')?.textContent.includes('Normal pressure'));
  assert.match(await panel.innerText(), /Minimum heavy-work reservation/);
  assert.match(await panel.innerText(), /Startup slot released; memory estimate awaits a fresh host sample/);
  assert.match(await metricText(page, 'Available physical memory'), /4.00 GiB/);
  assert.equal(await metricText(page, 'Pages read in / second'), '12.5');
  assert.equal(await metricText(page, 'Page disk reads / second'), '3.0');

  const disclosure = panel.locator('summary', { hasText: 'Current Node process memory' });
  await disclosure.focus();
  await disclosure.press('Enter');
  assert.equal(await disclosure.evaluate(element => element.parentElement.open), true);
  await page.evaluate(() => { window.__resourcePanel = document.querySelector('[data-diagnostic-region="resources"]'); });
  assert.match(await panel.innerText(), /File-read cache budget/);
  assert.match(await panel.innerText(), /not a leak assessment/);
  assert.match(await panel.innerText(), /Full process-family memory: unmeasured/);
  const rootDisclosure = panel.locator('summary', { hasText: 'Managed process roots' });
  await rootDisclosure.focus();
  await rootDisclosure.press('Enter');
  assert.equal(await rootDisclosure.evaluate(element => element.parentElement.open), true);
  assert.deepEqual(await panel.locator('[data-managed-root-id]').evaluateAll(elements => elements.map(element => element.dataset.managedRootId)), ['root-high', 'root-low', 'root-unknown']);
  assert.match(await panel.innerText(), /Detached descendants remain unknown/);
  results.push(await geometry(page, 'desktop-1280'));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await capture(page, 'resources-desktop-dark');

  async function refreshTo(state) {
    fixture = resourceFixture(state);
    const before = requestCount;
    const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/diagnostics');
    // Two synchronous activations exercise duplicate admission while the first is pending.
    await panel.getByRole('button', { name: 'Refresh resources', exact: true }).evaluate(button => { button.click(); button.click(); });
    await reply;
    await page.waitForFunction(() => !document.querySelector('[data-diagnostic-region="resources"] button')?.disabled);
    assert.equal(requestCount, before + 1, 'repeated refresh activation must not duplicate the pending request');
    assert.equal(await page.evaluate(() => window.__resourcePanel === document.querySelector('[data-diagnostic-region="resources"]')), true, 'refresh must preserve the panel');
    assert.equal(await disclosure.evaluate(element => element.parentElement.open), true, 'refresh must preserve the open memory disclosure');
  }

  await refreshTo('stale');
  await page.waitForFunction(() => document.querySelector('.resource-diagnostics-reason')?.textContent.includes('stale fixture'));
  assert.match(await panel.innerText(), /Pressure unknown/);
  assert.doesNotMatch(await panel.innerText(), /Normal pressure/);
  assert.match(await panel.innerText(), /stale or unavailable/);
  assert.match(await panel.innerText(), /Stale sample/);
  assert.equal(await panel.locator('[data-managed-root-id="root-high"]').locator('.resource-diagnostics-metrics > div').filter({ has: page.getByText('Private bytes', { exact: true }) }).locator('dd').innerText(), 'Unknown');
  assert.doesNotMatch(await panel.locator('[data-managed-root-id="root-high"]').innerText(), /128.0 MiB/);

  await refreshTo('unknown');
  await page.waitForFunction(() => document.querySelector('.resource-diagnostics-reason')?.textContent.includes('unknown fixture'));
  assert.equal(await metricText(page, 'Available physical memory'), 'Unknown');
  assert.equal(await metricText(page, 'Commit headroom'), 'Unknown');
  assert.equal(await metricText(page, 'Pages read in / second'), 'Unknown');
  assert.match(await panel.innerText(), /Commit admission unavailable/);
  assert.doesNotMatch(await panel.innerText(), /NaN|undefined/);

  await refreshTo('pressured');
  await page.waitForFunction(() => document.querySelector('.resource-diagnostics-reason')?.textContent.includes('pressure fixture'));
  assert.match(await panel.innerText(), /Memory pressure/);
  assert.match(await panel.innerText(), /Waiting for memory headroom/);
  const quietCount = requestCount;
  await page.waitForTimeout(1_200);
  assert.equal(requestCount, quietCount, 'the resource panel must not start its own polling loop');

  for (const width of [375, 320]) {
    await application.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setContentSize(value, 850), width);
    await page.waitForFunction(value => window.innerWidth <= value, width);
    for (const theme of ['dark', 'light']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await page.waitForTimeout(50);
      const name = `resources-${width}-${theme}`;
      const measured = await geometry(page, name);
      assert.equal(measured.horizontalOverflow, false, JSON.stringify(measured));
      assert.equal(measured.metricsContained, true, JSON.stringify(measured));
      const refresh = panel.getByRole('button', { name: 'Refresh resources', exact: true });
      await refresh.focus();
      assert.equal(await refresh.evaluate(element => {
        const style = getComputedStyle(element);
        return document.activeElement === element && style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      }), true, 'refresh button needs a visible keyboard focus indicator');
      results.push(measured);
      await capture(page, name);
    }
  }

  await page.evaluate(axe.source);
  const accessibility = await page.evaluate(async () => {
    const result = await window.axe.run(document.querySelector('[data-diagnostic-region="resources"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return result.violations.filter(item => ['critical', 'serious'].includes(item.impact)).map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target) }));
  });
  assert.deepEqual(accessibility, [], JSON.stringify(accessibility));

  // Finally use the actual isolated backend, rather than a fixture response.
  await page.unroute(routePattern);
  const realResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/diagnostics');
  await panel.getByRole('button', { name: 'Refresh resources', exact: true }).click();
  const actual = await (await realResponse).json();
  assert.equal(actual.ok, true);
  assert.equal(actual.resourceDiagnostics.node.scope, 'current-node-process');
  assert.ok(actual.resourceDiagnostics.node.current.rssBytes > 0);
  assert.ok(actual.resourceDiagnostics.node.samples.length <= 60);
  assert.equal(actual.resourceDiagnostics.node.sampling.intervalMs >= 5_000, true);
  assert.equal(actual.resourceDiagnostics.children.measured, false);
  assert.equal(actual.resourceDiagnostics.managedRoots.scope, 'managed_roots_only');
  assert.ok(actual.resourceDiagnostics.managedRoots.roots.length <= 20);
  assert.equal((await fetch(`${base}/api/diagnostics`, { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'MCP bearer alone must not expose local diagnostics');
  assert.equal(actual.resourceDiagnostics.caches.fileReads.maxRetainedBytes, 32 * 1024 ** 2);
  assert.deepEqual(consoleErrors, []);
  const output = { ok: true, scenarios: results, requestCount, accessibility, consoleErrors, screenshots };
  fs.writeFileSync(path.join(temp, 'result.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  console.log('Resource diagnostics browser coverage passed: refresh, stale/unknown metrics, narrow reflow, focus, accessibility, and actual endpoint.');
} finally {
  if (application) await application.close().catch(() => {});
  if (server.exitCode == null) server.kill('SIGTERM');
  await serverClosed;
  if (keepArtifacts) console.log(`Resource diagnostics browser artifacts retained at ${temp}`);
  else fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`Isolated server exited: ${serverError}`);
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated HTTP server did not become healthy: ${serverError}`);
}

async function metricText(page, label) {
  return page.locator('.resource-diagnostics-metrics > div').filter({ has: page.getByText(label, { exact: true }) }).first().locator('dd').innerText();
}

async function geometry(page, name) {
  return page.evaluate(label => {
    const panel = document.querySelector('[data-diagnostic-region="resources"]');
    const rect = panel.getBoundingClientRect();
    return {
      name: label, viewportWidth: innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      metricsContained: [...panel.querySelectorAll('dl, dt, dd')].every(element => {
        const box = element.getBoundingClientRect();
        return box.left >= rect.left - 1 && box.right <= rect.right + 1;
      })
    };
  }, name);
}

async function capture(page, name) {
  const target = path.join(screenshotDir, name + '.png');
  await page.evaluate(() => {
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.querySelector('main')?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(50);
  const expectedTheme = name.endsWith('-dark') ? 'dark' : 'light';
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), expectedTheme, 'screenshot label must match the rendered theme');
  await page.screenshot({ path: target, fullPage: true });
  assert.equal(fs.existsSync(target), true);
  screenshots.push(target);
}

function resourceFixture(state) {
  const now = Date.now();
  const unknown = state === 'unknown';
  const pressure = {
    state: state === 'stale' ? 'normal' : state === 'pressured' ? 'pressured' : state,
    reason: state === 'stale' ? 'stale fixture' : state === 'unknown' ? 'unknown fixture' : state === 'pressured' ? 'pressure fixture: Waiting for memory headroom' : 'fresh fixture',
    source: 'isolated-browser-fixture', sampledAtMs: unknown ? null : now - 20, ageMs: state === 'stale' ? 60_000 : 20,
    stale: state === 'stale', commitEnforced: !unknown,
    physicalAvailableBytes: unknown ? null : 4 * 1024 ** 3, physicalTotalBytes: unknown ? null : 16 * 1024 ** 3,
    commitUsedBytes: unknown ? null : 10 * 1024 ** 3, commitLimitBytes: unknown ? null : 24 * 1024 ** 3,
    commitAvailableBytes: unknown ? null : 14 * 1024 ** 3, reservedBytes: 128 * 1024 ** 2, reservationBytes: 128 * 1024 ** 2,
    physicalFloorBytes: 1024 ** 3, commitFloorBytes: 2 * 1024 ** 3, pagesInputPerSecond: unknown ? null : 12.5, pageReadsPerSecond: unknown ? null : 3,
    settlingReservedBytes: 128 * 1024 ** 2, settlingReservationCount: 1, startupSettlingMs: 5_000, oldestSettlingMs: 3_000, settlingReason: 'Startup slot released; memory estimate awaits a fresh host sample.',
    pagingMeaning: 'Sampled page-in and disk-read rates; not evidence of sustained thrashing.',
    recentDecisions: [{ atMs: now, state, reason: 'Fixture pressure decision' }]
  };
  const memory = { sampledAtMs: now, rssBytes: 128 * 1024 ** 2, heapUsedBytes: 32 * 1024 ** 2, heapTotalBytes: 64 * 1024 ** 2, heapLimitBytes: 2 * 1024 ** 3, externalBytes: 16 * 1024 ** 2, arrayBuffersBytes: 8 * 1024 ** 2 };
  return buildDiagnosticReport({
    connection: { token: 'set', tunnelId: 'fixture' },
    connectionState: { publicEndpoint: { status: 'ready' } },
    resourceDiagnostics: {
      host: { pressure, lanes: { heavy: { active: 1, limit: 2, queued: state === 'pressured' ? 3 : 0 } }, queues: { heavy: { oldestWaitMs: 20_000, blockedReason: state === 'pressured' ? 'Waiting for memory headroom' : '', maxQueued: 32, maxQueuedPerOwner: 8 } } },
      node: { available: true, scope: 'current-node-process', pid: 123, current: memory, ageMs: 0, samples: [memory], sampling: { intervalMs: 5_000, maxSamples: 60 }, trend: { status: 'observed', sampleCount: 3, durationMs: 10_000, baselineAtMs: now - 10_000, baseline: memory, slopeBytesPerMinute: { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0 } } },

      managedRoots: {
        scope: 'managed_roots_only', totalRootCount: 3, omittedRootCount: 0, sampledRootCount: unknown ? 0 : 2,
        cacheAgeMs: state === 'stale' ? 60_000 : 0, stale: state === 'stale', sampledAt: new Date(now).toISOString(), descendantAttribution: 'unknown',
        roots: [
          { processId: 'root-low', pid: 321, label: 'Owned watcher', workspace: 'fixture', kind: 'watcher', lifecycle: 'task', status: 'running', workSessionId: 'work-fixture', privateBytes: unknown ? null : 64 * 1024 ** 2, workingSetBytes: unknown ? null : 32 * 1024 ** 2, sampledAt: new Date(now).toISOString(), identityVerified: !unknown, measurementStatus: unknown ? 'unknown' : 'measured' },
          { processId: 'root-unknown', pid: 654, label: 'Unknown root ' + 'x'.repeat(160), workspace: 'fixture', kind: 'service', lifecycle: 'persistent', status: 'running', workSessionId: null, privateBytes: null, workingSetBytes: null, sampledAt: null, identityVerified: false, measurementStatus: 'unknown', reason: 'Identity unavailable' },
          { processId: 'root-high', pid: 987, label: 'Owned service', workspace: 'fixture', kind: 'service', lifecycle: 'persistent', status: 'running', workSessionId: 'work-fixture', privateBytes: unknown ? null : 128 * 1024 ** 2, workingSetBytes: unknown ? null : 64 * 1024 ** 2, sampledAt: new Date(now).toISOString(), identityVerified: !unknown, measurementStatus: unknown ? 'unknown' : 'measured' }
        ]
      },
      caches: { fileReads: { entries: 3, metadataEntries: 5, retainedBytes: 1024, maxRetainedBytes: 32 * 1024 ** 2, evictions: 1 } },
      children: { measured: false, reason: 'The full process family is not measured.' }
    }
  });
}
