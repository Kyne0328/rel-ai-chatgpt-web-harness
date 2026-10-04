import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpTestServer, stopHttpTestServer } from './helpers/http-test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-code-editor-browser-'));
const stateDir = path.join(temp, 'state');
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
const outputPath = path.join(temp, 'probe.json');
const token = 'code-editor-browser-token';
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'code-editor-fixture', version: '1.0.0' }));
fs.writeFileSync(configPath, JSON.stringify({
  version: 7,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}, null, 2));

const { child: server, base } = await startHttpTestServer({ root, configPath, token, stateDir });
let child;
try {
  const electronBinary = process.env.RELAI_ELECTRON_BINARY || path.resolve(root, 'electron', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  assert.equal(fs.existsSync(electronBinary), true, `Electron binary not found at ${electronBinary}`);
  child = spawn(electronBinary, ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'test', 'fixtures', 'electron-code-editor-probe')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      RELAI_PROBE_TARGET_URL: `${base}/dashboard?token=${encodeURIComponent(token)}`,
      RELAI_PROBE_OUTPUT_PATH: outputPath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(() => resolve(['timeout']), 60_000))
  ]);
  if (code === 'timeout') child.kill('SIGKILL');
  const probeOutput = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  assert.equal(code, 0, `Code editor browser probe failed. stdout=${stdout} stderr=${stderr} probe=${probeOutput}`);
  const result = JSON.parse(probeOutput);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.editorPresent, true, 'Monaco editor must render');
  assert.equal(result.inlineDiffEditor, true, 'the Changes surface must render task changes with Monaco diff rendering');
  assert.equal(result.readOnly, true, 'the rendered task diff must be read-only');
  assert.equal(result.saveButtonPresent, false, 'the Changes surface must not expose a Save control');
  assert.deepEqual(result.changedFileRows, ['src/example.js', 'src/new.js'], 'the file explorer must show only changed files and hide untouched files');
  assert.deepEqual(result.taskOptions, ['probe-task'], 'Changes must exclude tasks with no project-file changes and support-only artifacts');
  assert.equal(result.taskReturnHref, '#tasks?workspace=app&task=probe-task', 'Changes must provide a contextual link back to the selected task');
  assert.equal(result.selectedFileHeading, 'src/new.js', 'task file links must be able to deep-link to the exact changed file');
  assert.deepEqual(result.sameTaskFileNavigation, { heading: 'src/example.js', routeFile: 'src/example.js' }, 'same-task file navigation must update the displayed diff');
  assert.equal(result.routeAfterPendingDiff, '#activity?task=outside-task', 'a delayed diff must not overwrite another page after leaving Changes');
  assert.deepEqual(result.invalidFileFallback, { heading: 'src/example.js', routeFile: 'src/example.js' }, 'a missing-file deep link must resolve to a valid changed file');
  assert.deepEqual(result.taskFileHrefs, [
    '#code?task=probe-task&file=src%2Fexample.js',
    '#code?task=probe-task&file=src%2Fnew.js'
  ], 'task project-file items must link to their exact file in Changes');
  assert.deepEqual(result.statusBadges.map(item => item.code), ['M', 'U'], 'changed-file markers must expose real Git states instead of hardcoding M');
  assert.match(result.statusBadges[0]?.title || '', /^Modified:/);
  assert.match(result.statusBadges[1]?.title || '', /^Untracked:/);
  for (const badge of result.statusBadges) {
    assert.ok(badge.fontSize >= 12 && badge.width >= 24 && badge.height >= 20, `changed-file markers must be readable badges: ${JSON.stringify(result.statusBadges)}`);
  }
  assert.equal(result.sameEditorAfterLiveUpdate, true, 'live task updates must not recreate the active editor');
  assert.deepEqual(result.positionAfterLiveUpdate, result.positionBeforeLiveUpdate, 'live task updates must not move the active cursor');
  assert.equal(result.editorCountAfterUnmount, 0, 'leaving the React Changes route must dispose Monaco editors');
  assert.equal(result.modelCountAfterUnmount, 0, 'leaving the React Changes route must dispose Monaco models');
  assert.equal(result.modelLanguage, 'javascript', `JavaScript files must use the JavaScript Monaco language: ${JSON.stringify(result)}`);
  assert.ok(result.tokenColors.length >= 3, `Monaco JavaScript tokenization and syntax colors must be applied by the active theme: ${JSON.stringify(result)}`);
  assert.ok(result.lineHeight > 0 && result.lineTops.length >= 4, `Monaco must expose stable line geometry: ${JSON.stringify(result)}`);
  for (let index = 1; index < result.lineTops.length; index += 1) {
    assert.equal(result.lineTops[index] - result.lineTops[index - 1], result.lineHeight, `code lines must use one stable line height: ${JSON.stringify(result)}`);
  }
  assert.ok(result.geometry?.monaco?.height > 100, `Monaco viewport must have usable height: ${JSON.stringify(result)}`);
  assert.deepEqual(result.cspErrors, [], `Monaco must render without CSP style violations: ${JSON.stringify(result.cspErrors)}`);
  console.log('Rendered read-only Changes diff keeps syntax colors, file states, geometry, and stable live-update state.');
} finally {
  if (child && child.exitCode == null) child.kill('SIGKILL');
  await stopHttpTestServer(server);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
process.exit(0);
