// Focus on setup fields, accessible validation, and user-facing recovery boundaries.
// Dynamic IPC authorization and credential handling live in suite-runtime-core-unit.mjs and desktop-settings-unit.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('electron/renderer/wizard.html');
const js = read('electron/renderer/wizard.js');

const ipc = read('electron/ipc-handlers.js');

assert.match(html, /id="tunnelIdInput"/);
assert.match(html, /id="tunnelApiKeyInput"/);
assert.match(html, /id="portInput"/);
assert.match(html, /id="connectBtn"/);
assert.match(html, /id="cancelWizardBtn"/);
assert.match(html, /encrypted by your operating system/i);
assert.match(html, /data-open-openai="tunnels"/);
assert.match(html, /data-open-openai="apiKeys"/);
assert.match(html, /Create the tunnel in the OpenAI organization and ChatGPT workspace where you use Rel\.AI/i);
assert.match(html, /Name, Description, Organizations, and ChatGPT workspaces/i);
assert.match(html, /same OpenAI organization as your tunnel/i);
assert.match(html, /restricted API key/i);
assert.match(html, /Stored securely on this computer/i);
assert.match(html, /OpenAI Secure MCP Tunnel/i);
assert.ok(html.indexOf('data-open-openai="tunnels"') < html.indexOf('id="tunnelIdInput"'), 'Tunnel source action must immediately precede its destination field.');
assert.ok(html.indexOf('data-open-openai="apiKeys"') < html.indexOf('id="tunnelApiKeyInput"'), 'API-key source action must immediately precede its destination field.');
for (const id of ['tunnelIdInput', 'tunnelApiKeyInput', 'portInput']) assert.match(html, new RegExp(`label for="${id}"`));
for (const id of ['tunnelIdError', 'runtimeKeyError', 'portError']) assert.match(html, new RegExp(`id="${id}"[^>]*role="alert"`));
assert.match(html, /<form[^>]*id="connectionForm"/);
assert.match(html, /id="connectBtn"[^>]*type="submit"/);
assert.doesNotMatch(html, /Support project on GitHub|supportProject/);
assert.doesNotMatch(html, /Cloudflare|Rel\.AI Cloud|ngrok|Direct connection|pairing code|approval token|Rel\.AI account/i);

assert.match(js, /validTunnelId/);
assert.match(js, /\^tunnel_/);
assert.match(js, /validRuntimeKey/);
assert.match(js, /validPort/);
assert.match(js, /setFieldError/);
assert.match(js, /aria-invalid/);
assert.match(js, /\.focus\(\)/);
assert.match(js, /\$\('connectionForm'\)\.addEventListener\('submit'/);
assert.match(js, /event\.preventDefault\(\)/);
assert.match(js, /openOpenAISetup\(destination\)/);
assert.match(js, /wizardDone\(\{ tunnelId, tunnelApiKey, port, restart: recoveryMode \}\)/);
assert.doesNotMatch(js, /tunnelStatus !== 'running'/);
assert.match(js, /!result\?\.ok \|\| !result\?\.status\?\.serverRunning/);
assert.match(js, /getRecoveryConfig/);
assert.match(js, /Stored securely\. Leave blank to keep it\./);
assert.doesNotMatch(js, /copySetupValue|copyText\(value\)/);
assert.doesNotMatch(js, /cloud|ngrok|pairing|approvalToken|connectionMode/i);

assert.match(ipc, /OPENAI_SETUP_URLS/);
assert.match(ipc, /https:\/\/platform\.openai\.com\/settings\/organization\/tunnels/);
assert.match(ipc, /https:\/\/platform\.openai\.com\/settings\/organization\/api-keys/);
assert.doesNotMatch(ipc, /supportProject/);
assert.match(ipc, /shell\.openExternal\(url\)/);
assert.match(ipc, /Unknown OpenAI setup destination/);
assert.match(ipc, /if \(status\?\.serverRunning === true\) \{[\s\S]*?closeWizard\(\{ returnToFallback: false \}\);[\s\S]*?\}/);
assert.match(ipc, /return \{ ok: status\?\.serverRunning === true, status \};/);
assert.doesNotMatch(ipc, /serverRunning === true && status\?\.tunnelStatus === 'running'/);

console.log('Secure MCP Tunnel wizard source contracts passed.');

// The source contracts above are retained; this stage renders the actual native surfaces.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-renderer-'));
const outputPath = path.join(temp, 'probe.json');
const electronBinary = process.env.RELAI_ELECTRON_BINARY || path.join(
  root, 'electron', 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
);
try {
  assert.equal(fs.existsSync(electronBinary), true, 'Installed Electron runtime is required: ' + electronBinary);
  const child = spawnSync(electronBinary, [
    '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--no-first-run',
    '--user-data-dir=' + path.join(temp, 'profile'),
    path.join(root, 'test', 'fixtures', 'electron-native-renderer-probe')
  ], {
    cwd: root, encoding: 'utf8', timeout: 200_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, RELAI_PROBE_OUTPUT_PATH: outputPath, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });
  const probe = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, 'utf8')) : null;
  const diagnostic = JSON.stringify({
    error: probe?.error, stage: probe?.stage, runtime: probe?.runtime,
    failedChecks: probe?.checks?.filter(check => check.status !== 'passed'),
    axe: probe?.axe?.flatMap(scan => scan.violations.map(rule => ({ scan: scan.label, id: rule.id, impact: rule.impact, targets: rule.nodes.map(node => node.target) }))),
    childError: child.error?.message, stdout: child.stdout, stderr: child.stderr
  });
  assert.equal(child.status, 0, 'Isolated native renderer probe failed: ' + diagnostic);
  assert.ok(probe, 'Native renderer probe must produce a report.');
  assert.equal(probe.error, undefined, diagnostic);
  assert.equal(probe.axe.length, 12, 'Both themes must cover wizard validation/connection, Recovery action/connection, and Pulse collapsed/error states.');
  assert.equal(probe.layouts.length, 14, 'Both themes must cover native narrow and 200% zoom layouts.');
  assert.equal(probe.contrast.length, 4, 'Both wizard step numerals must receive measured contrast checks in both themes.');
  assert.ok(probe.checks.length >= 70, 'Expected rendered keyboard, focus, names, error/retry, and native state checks.');
  assert.ok(probe.checks.every(check => check.status === 'passed'), diagnostic);
  assert.ok(probe.axe.every(scan => scan.violations.length === 0), diagnostic);
  console.log('Rendered Wizard, Recovery, and Pulse checks passed in both themes with synthetic bridges, keyboard/focus, 320px, and 200% zoom.');
  console.log('Manual screen-reader, OS high-contrast, native picker/window-manager, text-spacing, and visual screenshot review remain not-run; this suite is not an accessibility-conformance claim.');
  if (process.env.RELAI_NATIVE_ARTIFACT_DIR) console.log('Native renderer report/screenshots: ' + process.env.RELAI_NATIVE_ARTIFACT_DIR);
} finally {
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
