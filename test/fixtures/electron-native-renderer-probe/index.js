// Loads the shipped renderer HTML/CSS/JS with test-only bridges in an isolated Electron app.
// It never imports the production app, preload, IPC, service runtime, or window hosts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, session } from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const renderer = path.join(root, 'electron/renderer');
const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;
const artifactDir = process.env.RELAI_NATIVE_ARTIFACT_DIR || '';
const require = createRequire(import.meta.url);
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
if (!outputPath) throw new Error('RELAI_PROBE_OUTPUT_PATH is required.');

const report = {
  isolation: 'Fresh profile; in-memory session; synthetic preload; no production IPC, network, clipboard, credentials, service or installer.',
  runtime: { platform: process.platform, arch: process.arch, os: os.release(), electron: process.versions.electron, chromium: process.versions.chrome },
  checks: [], axe: [], layouts: [], screenshots: [], contrast: [],
  manual: {
    screenReader: 'not-run: requires an operator and assistive technology',
    osHighContrast: 'not-run: OS settings are not changed by this fixture',
    nativePickerAndWindowManager: 'not-run: production native bridges are intentionally excluded',
    textSpacing: 'not-run: requires separate reading-order and content-loss review',
    visualScreenshotReview: 'not-run: screenshots are evidence, not a reviewed baseline'
  }
};
let win;
let theme = 'dark';

function persistReport() {
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  if (artifactDir) {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'native-renderer-report.json'), JSON.stringify(report, null, 2));
  }
}
function stage(name) { report.stage = name; persistReport(); }
async function bounded(promise, label, timeout = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out during ' + label)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

function check(name, condition, detail) {
  report.checks.push({ name: theme + ': ' + name, status: condition ? 'passed' : 'failed', ...(detail === undefined ? {} : { detail }) });
  assert.ok(condition, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail)));
}
const evaluate = expression => bounded(win.webContents.executeJavaScript(expression), 'renderer evaluation at ' + report.stage);
const cdp = (method, params = {}) => bounded(win.webContents.debugger.sendCommand(method, params), 'CDP ' + method + ' at ' + report.stage, 8000);
const control = (method, ...args) => evaluate('window.nativeFixture.' + method + '(' + args.map(value => JSON.stringify(value)).join(',') + ')');
async function waitFor(expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate('Boolean(' + expression + ')')) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const diagnostic = await evaluate('({ focused: document.activeElement?.id, controls: [...document.querySelectorAll("button")].map(button => ({ id: button.id, text: button.textContent, disabled: button.disabled, pending: button.dataset.pending })), calls: window.nativeFixture.calls().map(call => call.method) })');
  throw new Error('Timed out waiting for ' + expression + '; ' + JSON.stringify(diagnostic));
}
async function frames() {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function focus(selector) {
  await evaluate('document.querySelector(' + JSON.stringify(selector) + ').focus()');
}
async function key(keyName) {
  const virtualKeys = { Tab: 9, Enter: 13, Escape: 27, ' ': 32 };
  const value = virtualKeys[keyName];
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown', key: keyName, code: keyName === ' ' ? 'Space' : keyName,
    windowsVirtualKeyCode: value, ...(keyName === 'Enter' ? { text: '\r' } : {})
  });
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code: keyName === ' ' ? 'Space' : keyName, windowsVirtualKeyCode: value
  });
  await frames();
}
async function activate(selector) { await focus(selector); await key('Enter'); }
async function fill(selector, value) {
  await evaluate('(() => { const field = document.querySelector(' + JSON.stringify(selector) + '); field.value = ' + JSON.stringify(value) + '; field.dispatchEvent(new Event("input", { bubbles: true })); })()');
}
async function setMedia(reducedMotion = false) {
  await cdp('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: theme },
    { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }
  ] });
}
async function load(surface, query = {}) {
  win.webContents.setZoomFactor(1);
  win.setContentSize(surface === 'pulse' ? 364 : 760, surface === 'pulse' ? 384 : 900);
  stage(theme + ': load ' + surface + ' ' + JSON.stringify(query));
  await bounded(win.loadFile(path.join(renderer, surface + '.html'), { query }), 'load ' + surface, 15000);
  // The initial empty Electron target does not reliably answer Accessibility.enable.
  await cdp('Accessibility.enable');
  await setMedia();
  await evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme));
  await frames();
}
const normalizedName = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
async function axNames(expected, label) {
  const tree = await cdp('Accessibility.getFullAXTree');
  const nodes = tree.nodes.filter(node => !node.ignored);
  for (const name of expected) {
    const expectedRole = ['Paste Tunnel ID here', 'Paste runtime API key here'].includes(name) ? 'textbox'
      : name === 'Local connection port' ? 'spinbutton' : name === 'Fixture checks' ? 'progressbar' : 'button';
    check(label + ': computed accessible name and role ' + name,
      nodes.some(node => normalizedName(node.name?.value) === normalizedName(name) && node.role?.value === expectedRole),
      nodes.filter(node => ['button', 'textbox', 'spinbutton', 'progressbar'].includes(node.role?.value)).map(node => ({ role: node.role?.value, name: node.name?.value, description: node.description?.value })));
  }
  return nodes;
}
async function audit(label) {
  stage(theme + ': axe ' + label);
  await evaluate(axeSource);
  const result = await evaluate('axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }).then(result => ({ violations: result.violations, incomplete: result.incomplete, passes: result.passes.map(rule => rule.id) }))');
  report.axe.push({ label: theme + ': ' + label, ...result });
}
async function screenshot(label) {
  if (!artifactDir) return;
  await frames();
  const destination = path.join(artifactDir, theme + '-' + label + '.png');
  fs.writeFileSync(destination, (await win.webContents.capturePage()).toPNG());
  report.screenshots.push(destination);
}
async function layout(label, width, height, zoom = 1, actionSelector) {
  stage(theme + ': layout ' + label);
  win.webContents.setZoomFactor(zoom);
  win.setContentSize(width, height);
  await frames();
  if (actionSelector) {
    await evaluate('document.querySelector(' + JSON.stringify(actionSelector) + ').scrollIntoView({ block: "nearest" })');
    await focus(actionSelector);
    await frames();
  }
  const value = await evaluate('(() => { const el = document.activeElement; const rect = el?.getBoundingClientRect(); return { viewport: { width: innerWidth, height: innerHeight }, overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth), focused: el?.id || "", focusRect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null }; })()');
  report.layouts.push({ label: theme + ': ' + label, zoom, ...value });
  check(label + ': no page horizontal overflow', value.overflow <= 1, value);
  if (actionSelector) {
    check(label + ': focused action remains in viewport', value.focusRect.left >= -1 && value.focusRect.right <= value.viewport.width + 1 && value.focusRect.top >= -1 && value.focusRect.bottom <= value.viewport.height + 1, value);
  }
}


async function wizardStepContrast() {
  const specimens = await evaluate('([...document.querySelectorAll(".wizard-step-number")].map(element => { const style = getComputedStyle(element); return { text: element.textContent.trim(), foreground: style.color, background: style.backgroundColor, opacity: style.opacity, backgroundImage: style.backgroundImage, fontSize: style.fontSize, visible: element.getBoundingClientRect().width > 0 }; }))');
  check('wizard exposes both visible step numerals for contrast measurement', specimens.length === 2 && specimens.every(item => item.visible), specimens);
  const channels = value => {
    const match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!match) throw new Error('Unsupported computed contrast color: ' + value);
    const values = match[1].split(',').map(value => Number(value.trim()));
    if (![3, 4].includes(values.length) || values.some(value => !Number.isFinite(value)) || (values.length === 4 && values[3] !== 1)) {
      throw new Error('Step contrast requires opaque computed sRGB colors: ' + value);
    }
    return values.slice(0, 3);
  };
  const luminance = value => channels(value).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  for (const specimen of specimens) {
    check('wizard step ' + specimen.text + ': contrast has an opaque plain background', specimen.opacity === '1' && specimen.backgroundImage === 'none', specimen);
    const foreground = luminance(specimen.foreground);
    const background = luminance(specimen.background);
    const ratio = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    report.contrast.push({ theme, ...specimen, ratio, requiredRatio: 4.5 });
    check('wizard step ' + specimen.text + ': normal-size numeral contrast is at least 4.5:1', ratio >= 4.5, { ...specimen, ratio });
  }
}

async function wizardChecks() {
  await load('wizard');
  await wizardStepContrast();
  await waitFor('window.nativeFixture.calls("getRecoveryConfig").length === 1');
  await axNames(['Paste Tunnel ID here', 'Paste runtime API key here', 'Connect this computer', 'Cancel'], 'wizard');
  await focus('[data-open-openai="tunnels"]');
  await key('Tab');
  check('wizard Tab reaches tunnel field', await evaluate('document.activeElement.id === "tunnelIdInput"'));
  await fill('#tunnelIdInput', 'bad-id');
  await fill('#tunnelApiKeyInput', 'synthetic-runtime-value');
  await activate('#connectBtn');
  await waitFor('document.getElementById("tunnelIdInput").getAttribute("aria-invalid") === "true"');
  check('wizard invalid ID focuses associated field', await evaluate('document.activeElement.id === "tunnelIdInput"'));
  check('wizard invalid ID exposes alert', await evaluate('!document.getElementById("tunnelIdError").hidden && document.getElementById("tunnelIdError").textContent.length > 0'));
  const nodes = await axNames(['Paste Tunnel ID here'], 'invalid wizard');
  check('wizard error is in computed field description', nodes.some(node => normalizedName(node.name?.value) === normalizedName('Paste Tunnel ID here') && node.role?.value === 'textbox' && node.description?.value?.includes('Paste a valid')));
  check('wizard invalid fields never invoke bridge', (await control('calls', 'wizardDone')).length === 0);
  await audit('wizard-validation-error');
  await fill('#tunnelIdInput', 'tunnel_synthetic_fixture');
  check('wizard edit clears stale field error', await evaluate('document.getElementById("tunnelIdError").hidden && document.getElementById("tunnelIdInput").getAttribute("aria-invalid") === "false"'));
  await fill('#tunnelApiKeyInput', 'bad key');
  await activate('#connectBtn');
  await waitFor('document.getElementById("tunnelApiKeyInput").getAttribute("aria-invalid") === "true"');
  check('wizard invalid key focuses associated field', await evaluate('document.activeElement.id === "tunnelApiKeyInput"'));
  await fill('#tunnelApiKeyInput', 'synthetic-runtime-value');
  await activate('#runtimeKeyToggle');
  check('wizard keyboard reveal updates state and restores field focus', await evaluate('document.getElementById("runtimeKeyToggle").getAttribute("aria-pressed") === "true" && document.getElementById("tunnelApiKeyInput").type === "text" && document.activeElement.id === "tunnelApiKeyInput"'));
  await activate('#runtimeKeyToggle');
  await activate('.wizard-advanced-card > summary');
  check('wizard advanced settings keyboard disclosure opens', await evaluate('document.querySelector(".wizard-advanced-card").open'));
  await axNames(['Local connection port'], 'wizard advanced settings');
  await fill('#portInput', '80');
  check('wizard port enforces native range validation', await evaluate('document.getElementById("portInput").validity.rangeUnderflow'));
  await fill('#portInput', '3333');
  await control('queue', 'wizardDone', [{ pending: true }, { value: { ok: true, status: { serverRunning: true } } }]);
  await activate('#connectBtn');
  await waitFor('document.getElementById("connectBtn").disabled');
  check('wizard pending submission is visible', await evaluate('document.getElementById("connectBtn").textContent.includes("Connecting")'));
  await control('release', 'wizardDone', { reject: 'Synthetic setup failure. Retry the connection.' });
  await waitFor('!document.getElementById("connectBtn").disabled && document.getElementById("setupError").textContent.includes("Synthetic setup failure")');
  await audit('wizard-connection-error');
  await screenshot('wizard-error');
  await layout('wizard 320px', 320, 720, 1, '#connectBtn');
  await layout('wizard 200% zoom', 640, 1280, 2, '#connectBtn');
  await activate('#connectBtn');
  await waitFor('window.nativeFixture.calls("wizardDone").length === 2');
  check('wizard retry submits the validated synthetic data', (await control('calls', 'wizardDone'))[1].payload.tunnelId === 'tunnel_synthetic_fixture');
  await load('wizard', { recovery: '1' });
  await waitFor('document.getElementById("tunnelApiKeyInput").dataset.configured === "1"');
  check('recovery wizard retains stored key without disclosure', await evaluate('document.getElementById("tunnelApiKeyInput").value === "" && !document.getElementById("tunnelApiKeyInput").required'));
  await control('queue', 'wizardDone', [{ value: { ok: true, status: { serverRunning: true } } }]);
  await activate('#connectBtn');
  await waitFor('window.nativeFixture.calls("wizardDone").length === 1');
  check('recovery wizard submits blank retained key and restart intent', (await control('calls', 'wizardDone')).some(call => call.payload.restart === true && call.payload.tunnelApiKey === '' && call.payload.port === 4444));
  await load('wizard', { update: '1', previousVersion: '0.0.1', currentVersion: '0.0.2' });
  await fill('#tunnelIdInput', 'tunnel_synthetic_update');
  await fill('#tunnelApiKeyInput', 'synthetic-runtime-value');
  await control('queue', 'wizardDone', [{ reject: 'Synthetic reconnect failure.' }]);
  await activate('#connectBtn');
  await waitFor('!document.getElementById("connectBtn").disabled');
  check('update retry retains reconnect copy', await evaluate('document.getElementById("connectBtn").textContent === "Reconnect after update" && !document.getElementById("updateBanner").hidden'));
  await activate('#cancelWizardBtn');
  check('wizard keyboard cancel reaches only mock bridge', (await control('calls', 'closeWizard')).length === 1);
}


async function nativeButtonStates() {
  await evaluate('(() => { const group = document.createElement("section"); group.id = "nativeStateSpecimens"; group.innerHTML = \'<button id="fixtureDisabled" disabled>Disabled baseline</button><button id="fixturePrimary" class="primary" data-state="success" disabled>Disabled primary</button><button id="fixtureDanger" class="danger" data-state="error" disabled>Disabled danger</button><button id="fixtureEnabledDanger" class="danger">Synthetic danger specimen</button>\'; document.querySelector("main").append(group); })()');
  const styles = id => evaluate('(() => { const style = getComputedStyle(document.getElementById(' + JSON.stringify(id) + ')); return { color: style.color, background: style.backgroundColor, border: style.borderTopColor, opacity: style.opacity, transform: style.transform, shadow: style.boxShadow }; })()');
  const mouse = async (id, type) => {
    const rect = await evaluate('(() => { const el = document.getElementById(' + JSON.stringify(id) + '); el.scrollIntoView({ block: "center" }); const rect = el.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()');
    await cdp('Input.dispatchMouseEvent', { type, ...rect, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) });
    await evaluate('Promise.all(document.getAnimations().filter(animation => animation.effect?.target?.closest?.("#nativeStateSpecimens")).map(animation => animation.finished.catch(() => {})))');
  };
  const baseline = await styles('fixtureDisabled');
  for (const id of ['fixturePrimary', 'fixtureDanger']) {
    await mouse(id, 'mouseMoved');
    check(id + ': disabled hover keeps availability styling above outcome', JSON.stringify(await styles(id)) === JSON.stringify(baseline));
    await mouse(id, 'mousePressed');
    check(id + ': disabled press has no active transform or shadow', JSON.stringify(await styles(id)) === JSON.stringify(baseline));
    await mouse(id, 'mouseReleased');
  }
  const danger = await styles('fixtureEnabledDanger');
  await mouse('fixtureEnabledDanger', 'mouseMoved');
  const hover = await styles('fixtureEnabledDanger');
  check('enabled danger hover retains danger colors', hover.background === danger.background && hover.color === danger.color && hover.border === danger.color, { danger, hover });
  await mouse('fixtureEnabledDanger', 'mousePressed');
  const active = await styles('fixtureEnabledDanger');
  check('enabled danger press retains danger colors', active.background === danger.background && active.color === danger.color && active.border === danger.color, active);
  await mouse('fixtureEnabledDanger', 'mouseReleased');
  await evaluate('document.getElementById("nativeStateSpecimens").remove()');
}

const readyStatus = { serverRunning: true, tunnelStatus: 'running', tunnelId: 'tunnel_synthetic_recovery', version: '0.0.0-fixture', taskActivity: {} };
async function recoveryChecks() {
  await load('status');
  await nativeButtonStates();
  await control('status', readyStatus);
  await axNames(['Open dashboard', 'Copy tunnel ID', 'Edit connection'], 'Recovery');
  await control('queue', 'copyUrl', [{ pending: true }, { value: { ok: true } }]);
  await activate('#copyBtn');
  await waitFor('document.getElementById("copyBtn").disabled');
  check('Recovery pending copy has not claimed success', await evaluate('!document.getElementById("copyBtn").textContent.includes("copied")'));
  await control('release', 'copyUrl', { reject: 'Synthetic clipboard unavailable. Try again.' });
  await waitFor('!document.getElementById("copyBtn").disabled && !document.getElementById("errorPanel").hidden');
  check('Recovery copy failure is an alert', await evaluate('document.getElementById("errorPanel").getAttribute("role") === "alert" && document.getElementById("errorMessage").textContent.includes("clipboard")'));
  // Observe the 1.3-second success state before keyboard dispatch; hidden-window frame cadence must not race its expiry.
  await evaluate('(() => { window.__nativeCopyOutcome = null; const button = document.getElementById("copyBtn"); const observer = new MutationObserver(() => { if (button.textContent === "Tunnel ID copied") { window.__nativeCopyOutcome = { label: button.textContent, errorHidden: document.getElementById("errorPanel").hidden }; observer.disconnect(); } }); observer.observe(button, { childList: true, subtree: true, characterData: true }); })()');
  await activate('#copyBtn');
  await waitFor('window.__nativeCopyOutcome?.label === "Tunnel ID copied"');
  check('Recovery copy retry reports success and clears stale action error', await evaluate('window.__nativeCopyOutcome.errorHidden') && (await control('calls', 'copyUrl')).length === 2);
  await waitFor('!document.getElementById("copyBtn").disabled && document.getElementById("copyBtn").textContent === "Copy tunnel ID"');
  check('Recovery copy settles to currently available control', await evaluate('!document.getElementById("copyBtn").dataset.pending'));
  await control('queue', 'openRecoverySetup', [{ value: { ok: false, error: 'Synthetic settings unavailable.' } }, { value: { ok: true } }]);
  await activate('#settingsBtn');
  await waitFor('document.getElementById("errorMessage").textContent.includes("settings unavailable")');
  check('Recovery structured error restores retry control', await evaluate('!document.getElementById("settingsBtn").disabled'));
  await audit('Recovery-action-error');
  await activate('#settingsBtn');
  await waitFor('document.getElementById("errorPanel").hidden');
  await control('status', { ...readyStatus, serverRunning: false, tunnelStatus: 'failed', error: 'Synthetic connection failed.' });
  await control('queue', 'restartConnection', [{ pending: true }]);
  await activate('#retryBtn');
  await waitFor('document.getElementById("retryBtn").disabled');
  await control('release', 'restartConnection', { value: readyStatus });
  await waitFor('document.getElementById("statusBadge").textContent === "Ready"');
  check('Recovery retry renders authoritative ready result', await evaluate('document.getElementById("errorPanel").hidden && !document.getElementById("retryBtn").disabled'));
  await control('status', { ...readyStatus, serverRunning: false, tunnelStatus: 'failed', error: 'Synthetic connection failed. ' + 'Diagnostic detail remains readable. '.repeat(8) });
  await audit('Recovery-connection-error');
  await screenshot('Recovery-error');
  await layout('Recovery 320px', 320, 720, 1, '#retryBtn');
  await layout('Recovery 200% zoom', 640, 1280, 2, '#retryBtn');
  check('Recovery never called real service or installer bridge', (await control('calls')).every(call => !['startServer', 'stopServer', 'relaunchApp'].includes(call.method)));
}

async function pulseChecks() {
  await load('pulse');
  win.setContentSize(286, 48);
  await control('pulse', {
    title: 'Synthetic task', detail: 'Checking isolated renderer behavior.',
    tone: 'working', taskCount: 1, workspace: 'fixture-project', themePreference: theme,
    progressPercent: 42, progressLabel: 'Fixture checks'
  });
  await waitFor('document.getElementById("pulseTitle").textContent === "Synthetic task"');
  check('Pulse collapsed content is inert and excluded from tab order', await evaluate('document.getElementById("pulseIsland").inert && document.getElementById("pulseOpen").tabIndex === -1'));
  await axNames(['Show activity details'], 'collapsed Pulse');
  await audit('Pulse-collapsed');
  await focus('#pulseCompactCopy');
  await key('Enter');
  await waitFor('document.getElementById("pulseShell").dataset.expanded === "true"');
  win.setContentSize(364, 384);
  await frames();
  check('Pulse keyboard expand moves focus to persistent toggle', await evaluate('document.activeElement.id === "pulseToggle" && document.getElementById("pulseToggle").getAttribute("aria-expanded") === "true" && !document.getElementById("pulseIsland").inert'));
  await key('Tab');
  check('Pulse expanded action is keyboard reachable', await evaluate('document.activeElement.id === "pulseOpen"'));
  await axNames(['Hide activity details', 'Open in Rel.AI: Synthetic task', 'Fixture checks'], 'expanded Pulse');
  await control('queue', 'openDashboard', [{ pending: true }, { value: { ok: true } }]);
  await key('Enter');
  await waitFor('document.getElementById("pulseOpen").disabled');
  check('Pulse pending action exposes busy state', await evaluate('document.getElementById("pulseOpen").getAttribute("aria-busy") === "true"'));
  await control('release', 'openDashboard', { value: { ok: false, error: 'Synthetic dashboard unavailable. ' + 'Retry from this control. '.repeat(8) } });
  await waitFor('!document.getElementById("pulseOpen").disabled && !document.getElementById("pulseActionError").hidden');
  check('Pulse error is exposed as an alert', await evaluate('document.getElementById("pulseActionError").getAttribute("role") === "alert"'));
  await audit('Pulse-action-error');
  await screenshot('Pulse-error');
  await layout('Pulse error native bounds', 364, 384, 1, '#pulseOpen');
  await layout('Pulse error 320px', 320, 384, 1, '#pulseOpen');
  await layout('Pulse error 200% zoom', 640, 768, 2, '#pulseOpen');
  await activate('#pulseOpen');
  await waitFor('document.getElementById("pulseActionError").hidden');
  check('Pulse successful retry clears error and busy state', await evaluate('!document.getElementById("pulseOpen").disabled && !document.getElementById("pulseOpen").hasAttribute("aria-busy")'));
  await key('Escape');
  await waitFor('document.getElementById("pulseShell").dataset.expanded === "false"');
  check('Pulse Escape restores toggle focus and inert content', await evaluate('document.activeElement.id === "pulseToggle" && document.getElementById("pulseIsland").inert && document.getElementById("pulseToggle").getAttribute("aria-expanded") === "false"'));
  await setMedia(true);
  await activate('#pulseToggle');
  await waitFor('document.getElementById("pulseShell").dataset.expanded === "true"');
  check('Pulse reduced-motion preference is exercised independently', await evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches && !document.getElementById("pulseShell").getAnimations().some(animation => animation.playState === "running")'));
  await control('pulse', { title: 'Synthetic completed task', tone: 'idle', themePreference: theme, expanded: false });
  await waitFor('document.getElementById("pulseShell").dataset.expanded === "false"');
  check('Pulse host collapse restores accessible state', await evaluate('document.getElementById("pulseIsland").inert && document.getElementById("pulseToggle").getAttribute("aria-expanded") === "false"'));
}

// Do not top-level-await app.whenReady(): Electron must finish evaluating this ESM entry before startup completes.
stage('awaiting Electron ready');
const watchdog = setTimeout(() => {
  report.error = 'Native renderer fixture exceeded its 180-second deadline at ' + report.stage;
  persistReport();
  app.exit(1);
}, 180000);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
try {
  stage('creating isolated Electron window');
  if (artifactDir) fs.mkdirSync(artifactDir, { recursive: true });
  const isolated = session.fromPartition('native-renderer-fixture-' + process.pid);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = details.url.startsWith('data:');
    if (details.url.startsWith('file:')) {
      const relative = path.relative(renderer, fileURLToPath(details.url));
      allowed = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    }
    callback({ cancel: !allowed });
  });
  isolated.on('will-download', event => event.preventDefault());
  win = new BrowserWindow({
    show: false, frame: false, useContentSize: true, width: 760, height: 900,
    webPreferences: { session: isolated, preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.debugger.attach('1.3');
  for (theme of ['dark', 'light']) {
    stage(theme + ': wizard');
    await wizardChecks();
    stage(theme + ': Recovery');
    await recoveryChecks();
    stage(theme + ': Pulse');
    await pulseChecks();
  }
  check('fixture window never became visible', !win.isVisible());
  const violations = report.axe.flatMap(scan => scan.violations.map(rule => ({ scan: scan.label, id: rule.id, impact: rule.impact, nodes: rule.nodes.map(node => node.target) })));
  report.axeViolations = violations;
  check('all applicable axe violations are retained and gated without impact filtering', violations.length === 0, violations);
} catch (error) {
  report.error = error?.stack || String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  persistReport();
  win?.destroy();
  app.quit();
}
}).catch(error => {
  clearTimeout(watchdog);
  report.error = error?.stack || String(error);
  persistReport();
  app.exit(1);
});
