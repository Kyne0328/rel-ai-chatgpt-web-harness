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
  assert.equal(result.inspectorHiddenReadsStable, true, 'a hidden Changes tab must not refetch when the task summary updates');
  assert.equal(result.inspectorDiffRestored, true, 'file, diff layout and editor position survive inactive tabs');
  assert.deepEqual(result.inspectorProcessGroups, [
    { title: 'Task commands', ids: ['proc-task-owned'] },
    { title: 'Persistent commands', ids: ['proc-persistent'] }
  ]);
  assert.equal(result.inspectorProcessState, 'Running');
  assert.equal(result.inspectorProcessBadge, '2', 'only task-owned processes contribute to the task badge');
  assert.equal(result.inspectorOtherProcessesHidden, true, 'unrelated project processes must be absent from task details');
  assert.equal(result.inspectorDetailsLinkWorks, true, 'existing Technical deep links open secondary Details');
  assert.equal(result.inspectorHeaderHasNoIds, true);
  assert.equal(result.mobileTasksParentActive, true, 'full-screen Changes belongs to Tasks on mobile navigation');
  const fullScreenParams = new URLSearchParams(result.inspectorFullScreenHref.split('?')[1]);
  assert.equal(result.inspectorFullScreenHref.split('?')[0], '#code');
  assert.equal(fullScreenParams.get('task'), 'probe-task');
  assert.equal(fullScreenParams.get('file'), 'src/new.js');
  assert.equal(fullScreenParams.get('search'), 'Inspector');
  assert.equal(fullScreenParams.get('taskStatus'), 'open');
  assert.equal(result.inspectorProjectProcessesLink, true, 'project-wide process inspection remains available via Running Commands');
  assert.ok(result.inspectorRecentRows > 0 && result.inspectorRecentRows <= 8, 'Tasks render only the latest eight activity events');
  assert.equal(result.inspectorPreviewRemoved, true, 'Task Activity must have one event action and a full Activity link');
  assert.equal(result.inspectorSingleScroll, true, 'task activity must share the outer task inspector scrollbar');
  assert.equal(result.runtimeDockRemoved, true, 'redundant Runtime dock and shortcut must be absent');
  assert.equal(result.editorPresent, true, 'Monaco editor must render');
  assert.equal(result.inlineDiffEditor, true, 'the Changes surface must render task changes with Monaco diff rendering');
  assert.equal(result.readOnly, true, 'the rendered task diff must be read-only');
  assert.equal(result.saveButtonPresent, false, 'the Changes surface must not expose a Save control');
  assert.equal(result.filteredFolderExpanded, true, 'filtering must reveal matching files inside collapsed folders');
  assert.equal(result.filterPreservedFolderCollapse, true, 'clearing a filter must restore the previous folder collapse state');
  assert.ok(result.fontFaces.length === 2 && result.fontFaces.every(face => face.loaded), 'both UI and monospace fonts must load from bundled assets');
  assert.deepEqual(result.changedFileRows, ['src/example.js', 'src/new.js'], 'the file explorer must show only changed files and hide untouched files');
  assert.deepEqual(result.taskOptions, ['probe-task'], 'Changes must exclude tasks with no project-file changes and support-only artifacts');
  assert.equal(result.taskReturnHref, '#tasks?workspace=app&task=probe-task', 'Changes must provide a contextual link back to the selected task');
  assert.equal(result.selectedFileHeading, 'src/new.js', 'task file links must be able to deep-link to the exact changed file');
  assert.deepEqual(result.sameTaskFileNavigation, { heading: 'src/example.js', routeFile: 'src/example.js' }, 'same-task file navigation must update the displayed diff');
  assert.equal(result.routeAfterPendingDiff, '#activity?task=outside-task', 'a delayed diff must not overwrite another page after leaving Changes');
  assert.deepEqual(result.invalidFileContext, { heading: 'missing.js', routeFile: 'missing.js', recoveryVisible: true, selectedOtherFile: false }, 'a missing-file deep link must keep its identity and explain recovery instead of silently substituting another file');
  assert.deepEqual(result.retainedTaskIdentity, { selected: 'retained-task', routeTask: 'retained-task', heading: 'src/retained.js', requested: 'retained-task', otherTaskAvailable: true }, 'a retained task absent from the aggregate must load its own changes even when another task is available');
  assert.deepEqual(result.unavailableTaskContext, { selected: 'unavailable-task', routeTask: 'unavailable-task', routeFile: 'src/retained.js', errorIdentifiesTask: true, returnTask: 'unavailable-task' }, 'unavailable task changes must retain the requested context and expose recovery');
  assert.equal(result.unavailableTaskRecovered, true, 'Retry must load the same requested task after a transient failure');
  assert.deepEqual(result.retainedTaskWithoutSummaries, ['retained-task'], 'an explicit retained task must be resolvable when the aggregate has no tasks');
  assert.deepEqual(result.historicalDiffUnavailable, {
    recordedFileVisible: true, contextPreserved: true, noRawIpcError: true, currentFileOnly: true
  }, 'older tasks with no verified commit must retain file navigation without attempting an unsafe diff');
  assert.deepEqual(result.taskFileHrefs, ['#code?task=probe-task&from=tasks'], 'Overview must offer one route to Changes instead of a duplicate file list');
  assert.equal(result.scopedTaskFileHref, '#code?workspace=app&task=probe-task&from=tasks&search=Changes+viewer&taskStatus=open', 'Changes navigation must retain project, search and task-status context');
  assert.equal(result.filteredTaskReturnHref, '#tasks?workspace=app&task=probe-task&search=Changes+viewer&taskStatus=open');
  assert.deepEqual(result.restoredTaskContext, { search: 'Changes viewer', status: 'open', workspace: 'app', selected: 'probe-task', scopeExplained: true }, 'returning from Changes must restore filters and task selection with honest loaded-history scope');
  const taskActivityParams = new URLSearchParams(result.scopedTaskActivityHref.split('?')[1]);
  assert.deepEqual(Object.fromEntries(taskActivityParams), { workspace: 'app', task: 'probe-task', time: 'all', from: 'tasks', returnTask: 'probe-task', returnWorkspace: 'app', returnSearch: 'Changes viewer', returnTaskStatus: 'open' }, 'Tasks Activity links must keep their own filter namespace and origin task');
  const taskEventActivityParams = new URLSearchParams(result.taskEventActivityHref.split('?')[1]);
  assert.equal(taskEventActivityParams.get('returnTask'), 'probe-task', 'individual task events must preserve return selection');
  assert.equal(taskEventActivityParams.get('returnSearch'), 'Changes viewer', 'individual task events must preserve task search');
  assert.equal(taskEventActivityParams.get('returnTaskStatus'), 'open', 'individual task events must preserve task status');
  assert.equal(result.activityOwnFiltersInitiallyEmpty, true, 'Tasks search and status must not silently filter Activity');
  assert.equal(result.activityTaskReturnHref, '#tasks?workspace=app&task=probe-task&search=Changes+viewer&taskStatus=open', 'Activity edits must not overwrite Tasks return filters');
  assert.equal(result.activityNestedReturnHref, result.activityTaskReturnHref, 'Task activity navigation must retain the originating Tasks context');
  assert.deepEqual(result.activityRestoredTaskContext, { search: 'Changes viewer', status: 'open', workspace: 'app', selected: 'probe-task' }, 'Tasks Activity Tasks must restore the rendered search, status, project and selection');
  assert.equal(result.activityAllProjectsReturnHref, '#tasks?task=probe-task&search=Changes+viewer&taskStatus=open', 'Activity must preserve explicit all-projects Tasks scope');
  assert.equal(result.activityAllProjectsRestored, true, 'the all-projects scope must remain unscoped after a rendered Activity roundtrip');
  assert.equal(result.activityDifferentTaskReturnHref, '#tasks?workspace=app&task=no-change-task', 'opening a different Activity task must not inherit another task’s return filters');
  assert.deepEqual(result.filteredSelection, { emptyExplainsLoadedScope: true, selectionExplained: true, selectedTaskVisible: true }, 'changing filters must retain and explain an explicit selection outside the loaded results');
  assert.equal(result.allProjectsReturnHref, '#tasks?task=probe-task', 'an all-projects Tasks visit must not become project-scoped on return');
  assert.deepEqual(result.taskDetailFailure, { identifiesTask: true, selectPromptAbsent: true, messageVisible: true }, 'structured detail failures must show task-specific error and retry rather than an unselected state');
  assert.deepEqual(result.taskDetailRetry, { attempts: 2, errorCleared: true, routeTask: 'retry-detail-task' }, 'detail Retry must bypass the failed read and preserve the requested task');
  assert.deepEqual(result.missingTaskDetails, { retryVisible: true, identifiesTask: true }, 'not-found tasks must have a distinct unavailable state with a recovery action');
  assert.equal(result.mismatchedTaskRejected, true, 'task detail responses must match the requested identity');
  assert.equal(result.summarySurvivesDetailFailure, true, 'a detail read failure must retain and label the last available summary');
  assert.deepEqual(result.taskDetailLoading, { loading: true, selectPromptAbsent: true }, 'pending retained tasks must have a distinct loading state');
  assert.equal(result.lateTaskDetailsIgnored, true, 'a late response for an older task must not replace a newer selection');
  assert.deepEqual(result.statusBadges.map(item => item.code), ['M', 'U'], 'changed-file markers must expose real Git states instead of hardcoding M');
  assert.match(result.statusBadges[0]?.title || '', /^Modified:/);
  assert.match(result.statusBadges[1]?.title || '', /^Untracked:/);
  for (const badge of result.statusBadges) {
    assert.ok(badge.fontSize >= 12 && badge.width >= 24 && badge.height >= 20, `changed-file markers must be readable badges: ${JSON.stringify(result.statusBadges)}`);
  }
  assert.equal(result.sameEditorAfterLiveUpdate, true, 'live task updates must not recreate the active editor');
  assert.equal(result.sameModelAfterLiveUpdate, true, 'same-path live updates must preserve Monaco model identity');
  assert.match(result.freshModelAfterLiveUpdate, /const answer = 43;/, 'same-path task revisions must update visible content');
  assert.match(result.modelAfterOutOfOrderRefresh, /const answer = 45;/, 'older in-flight responses must not overwrite a newer revision');
  assert.match(result.modelAfterManualRefresh, /const answer = 46;/, 'manual Refresh must update the selected same-path model');
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
