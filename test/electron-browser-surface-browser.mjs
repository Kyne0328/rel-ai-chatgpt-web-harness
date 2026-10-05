import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-embedded-browser-'));
const outputPath = path.join(temp, 'probe.json');
const electronBinary = process.env.RELAI_ELECTRON_BINARY || path.resolve(
  root,
  'electron',
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
assert.equal(fs.existsSync(electronBinary), true, `Electron binary not found at ${electronBinary}`);

const result = spawnSync(electronBinary, [
  '--no-sandbox',
  '--disable-gpu',
  `--user-data-dir=${path.join(temp, 'profile')}`,
  path.join(root, 'test', 'fixtures', 'electron-browser-surface-probe')
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 60_000,
  env: { ...process.env, RELAI_PROBE_OUTPUT_PATH: outputPath, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
});
const stdout = result.stdout || '';
const stderr = result.stderr || '';

try {
  const probeOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '(probe output missing)';
  if (result.error?.code === 'ETIMEDOUT') {
    assert.fail(`Embedded browser Electron probe timed out. probe=${probeOutput} stdout=${stdout} stderr=${stderr}`);
  }
  assert.equal(result.status, 0, `Embedded browser Electron probe failed. probe=${probeOutput} stdout=${stdout} stderr=${stderr}`);
  const probe = JSON.parse(probeOutput);
  assert.equal(probe.error, undefined, probe.error);
  assert.equal(probe.started.browserProduct, 'Rel.AI Embedded Chromium');
  assert.equal(probe.positioned.active, true);
  assert.equal(probe.positioned.visible, true, 'A real WebContentsView must attach inside the dashboard BrowserWindow.');
  assert.deepEqual(probe.positioned.viewport, { width: 1200, height: 750 });
  assert.deepEqual(probe.resizedState.viewport, { width: 1200, height: 750 }, 'dashboard resizing must not change the canonical AI viewport');
  assert.equal(probe.positioned.tabs.length, 2, 'Real Electron browser state must expose both open tabs.');
  assert.equal(probe.tabState.nativePageId, probe.tabState.tabs[0].nativePageId, 'Selecting a tab must switch the attached WebContentsView.');
  assert.equal(probe.tabState.tabs[0].active, true);
  assert.equal(probe.afterTabClose.tabs.length, 1, 'Closing a desktop tab must remove the native page from state.');
  assert.equal(probe.navigated.url.startsWith('http://127.0.0.1:'), true);
  assert.equal(probe.navigated.title, 'Embedded fixture');
  assert.match(probe.snapshot, /Embedded browser fixture/);
  assert.match(probe.afterFill, /Rel\.AI embedded/);
  assert.equal(probe.requiredFieldValue, 'v1.2.3', 'exact semantic targets must ignore aria-hidden required markers just like the accessibility snapshot');
  assert.deepEqual(probe.initialViewport, { width: 1200, height: 750, breakpoint: '"wide"' });
  assert.deepEqual(probe.resizedViewport, probe.initialViewport, 'responsive layout must remain stable after the Rel.AI browser panel is resized');
  assert.deepEqual(probe.aiViewport, probe.initialViewport, 'returning control to AI must preserve the canonical viewport');
  assert.ok(probe.screenshotBytes > 0, 'Embedded page screenshot must contain image data.');
  assert.equal(probe.screenshotWidth, 1200);
  assert.equal(probe.screenshotHeight, 750);
  assert.deepEqual(probe.screenshotViewport, { width: 1200, height: 750 }, 'AI screenshots must report the canonical viewport, not dashboard presentation bounds');
  assert.deepEqual(probe.screenshotActualSize, { width: 1200, height: 750 }, 'AI screenshot pixels must stay at the canonical viewport even when the dashboard fits the live presentation');
  assert.equal(probe.aiClickCount, 0, 'AI-owned browser surfaces must ignore human-style pointer input');
  assert.equal(probe.userState.control, 'user');
  assert.equal(probe.userClickCount, 1, 'user takeover must enable pointer input through the fitted presentation');
  assert.equal(probe.userEdgeClickCount, 1, 'the fitted presentation must expose and interact with the canonical viewport bottom-right instead of cropping it');
  assert.equal(probe.userScrollY, 400, 'user takeover must preserve an independently scrollable page state');
  assert.equal(probe.takeoverError?.code, 'BROWSER_USER_CONTROL_ACTIVE');
  assert.equal(probe.aiState.control, 'ai');
  assert.equal(probe.aiScrollY, probe.userScrollY, 'returning control to AI must block further wheel scrolling');
  assert.equal(Object.hasOwn(probe.legacyHeadless, 'headless'), false, 'embedded browser start must not expose the removed headless mode');
  assert.equal(Object.hasOwn(probe.legacyHeadlessState, 'headless'), false, 'desktop browser state must not expose the removed headless mode');
  assert.equal(probe.legacyHeadlessState.visible, true, 'legacy headless input must still produce a visible live browser surface');
  assert.deepEqual(probe.legacyHeadlessState.viewport, { width: 800, height: 600 });
  assert.equal(probe.legacyHeadlessUserState.control, 'user', 'every embedded browser session must support user takeover');
  assert.equal(probe.finalState.active, true);
  assert.equal(probe.finalState.visible, true);
  assert.equal(probe.windowVisible, true, 'The Electron probe window must be render-active for WebContentsView painting.');
  const expectedOpacity = process.platform === 'linux' && process.env.CI === 'true' ? 1 : 0;
  assert.equal(probe.windowOpacity, expectedOpacity, 'The probe must stay transparent on developer desktops while Linux CI renders inside Xvfb for screenshot coverage.');
  assert.equal(probe.windowFocused, false, 'The invisible browser probe must never steal user focus.');
  assert.ok(probe.stateCount >= 4, 'Embedded surface must publish lifecycle and navigation state.');
  assert.equal(probe.events.length, 1);
  assert.equal(probe.events[0].type, 'page_closed');
  console.log('Real Electron WebContentsView browser surface renders, automates, screenshots, and hands control to the user.');
} finally {
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
