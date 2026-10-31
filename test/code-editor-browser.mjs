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
  assert.equal(result.integrated, true, 'the diff viewer must render only inside Tasks');
  assert.equal(result.readOnly, true, 'Monaco diffs remain read-only');
  assert.equal(result.language, 'javascript', 'Monaco must recognize source-file language');
  assert.deepEqual(result.filePaths, ['src/example.js', 'src/new.js'], 'only changed task files are shown');
  assert.equal(result.noStandaloneControls, true, 'the retired standalone Changes surface must have no entry points');
  assert.equal(result.noCodeNavigation, true, 'Changes must not be a separate navigation destination');
  assert.equal(result.noOverviewFilesLink, true, 'Overview must not link to a separate Changes surface');
  assert.equal(result.ideControl, true, 'IDE access must remain in the embedded Changes tab');
  assert.equal(result.liveRefresh.sameModel, true, 'same-path live diff updates must preserve Monaco model identity');
  assert.equal(result.liveRefresh.line, 3, 'same-path live diff updates must preserve the editor position');
  assert.match(result.liveRefresh.content, /const answer = 43;/, 'the active diff must refresh from the authoritative task revision');
  assert.match(result.outOfOrderContent, /const answer = 45;/, 'an older in-flight diff must not overwrite a newer task revision');
  assert.deepEqual(result.activityFirstOpen, { rows: 2, badgeAbsent: true, heading: 'Recent activity' },
    'Task Activity must be hydrated on its first open without a competing event-count badge');
  assert.deepEqual(result.restore, { file: 'src/new.js', unified: true, line: 3 },
    'file, diff layout and editor position must survive a hidden Tasks tab');
  assert.deepEqual(result.narrow, { stacked: true, fits: true, editorUsable: true },
    'embedded Changes must remain usable in a narrow container');
  assert.equal(result.fileRoute, 'src/example.js', 'file selection must update the Tasks deep link');
  assert.deepEqual(result.legacy, {
    workspace: 'app', task: 'probe-task', file: 'src/new.js',
    tab: 'changes', search: 'legacy', taskStatus: 'open'
  }, 'old #code URLs must redirect to the correct Tasks Changes tab without losing context');
  assert.equal(result.legacyDiscardedFrom, true, 'retired standalone-only URL parameters must be removed');
  assert.equal(result.historicalFallback, true, 'older tasks with unavailable original diffs retain an honest read-only fallback');
  assert.equal(result.missingFilePreserved, true, 'missing-file links retain their selected file and show a useful explanation');
  assert.deepEqual(result.processOwnership, { taskOwnedVisible: true, persistentVisible: true, unrelatedHidden: true },
    'Task Processes must show only commands attributed to the selected task');
  assert.deepEqual(result.countPresentation, { toolCallsVisible: true, activityEventsHidden: true, activityBadgeAbsent: true },
    'Tasks must expose Tool calls as the single truthful work-count metric');
  const activityReturnParams = new URLSearchParams(result.activityReturnHref.split('?')[1]);
  assert.deepEqual(Object.fromEntries(['workspace', 'task', 'search', 'taskStatus'].map(key => [key, activityReturnParams.get(key)])), {
    workspace: 'app', task: 'probe-task', search: 'probe', taskStatus: 'completed'
  }, 'Activity must preserve the originating Tasks filter and selection context');
  assert.equal(result.activityReturnRestored, true, 'returning from Activity must restore the originating Tasks context');
  assert.deepEqual(result.taskDetailFailure, { messageVisible: true, identifiesTask: true },
    'task-detail failures must identify the selected task and retain the structured error');
  assert.ok(result.taskDetailRetry.attempts >= 2, 'Retry must issue a fresh detail request for the same task');
  assert.equal(result.taskDetailRetry.recovered, true, 'Task detail Retry must recover without losing selection');
  assert.equal(result.mismatchedTaskRejected, true, 'a task-detail response for another task must be rejected');
  console.log('Task-integrated Changes and task-context browser acceptance passed.');
} finally {
  if (child && child.exitCode == null) child.kill('SIGKILL');
  await stopHttpTestServer(server);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
process.exit(0);
