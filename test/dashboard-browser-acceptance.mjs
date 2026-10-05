import assert from 'node:assert/strict';
import axe from 'axe-core';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTaskHistoryDir, writeSession } from '../src/taskHistoryStorage.ts';
import { availablePort } from './helpers/available-port.mjs';
import { createHttpMcpSession } from './helpers/http-mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-browser-acceptance-'));
const stateDir = path.join(temp, 'state');
const workspace = path.join(temp, 'workspace');
const projectCreateWorkspace = path.join(temp, 'workspace-created');
const configPath = path.join(temp, 'config.json');
const outputPath = path.join(temp, 'probe.json');
const screenshotDir = path.join(temp, 'screenshots');
// Audit/debug opt-in: retain only this test's isolated fixtures and screenshots.
const keepArtifacts = process.env.RELAI_KEEP_DASHBOARD_PROBE_ARTIFACTS === '1';
const axePath = path.join(temp, 'axe-core.js');
fs.writeFileSync(axePath, axe.source, 'utf8');
const token = 'browser-acceptance-token';
const port = await availablePort();
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(projectCreateWorkspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'browser-fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }));
fs.writeFileSync(path.join(projectCreateWorkspace, 'package.json'), JSON.stringify({ name: 'browser-created-fixture', version: '1.0.0' }));
const config = {
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspace, commands: {}, testCommands: { test: 'npm test' } } }
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
seedSessions(getTaskHistoryDir(config));

const server = spawn(process.execPath, [path.join(root, 'bin', 'rel-ai-mcp-http.js'), '--host', '127.0.0.1', '--port', String(port), '--no-profile-write'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, REL_AI_MCP_CONFIG: configPath, REL_AI_MCP_TOKEN: token, REL_AI_MCP_STATE_DIR: stateDir }
});
let serverError = '';
server.stderr.on('data', chunk => { serverError += chunk.toString('utf8'); });
let child = null;
let mcpSession = null;
let closePromise = Promise.resolve([]);

try {
  await waitForHealth(`http://127.0.0.1:${port}/health`);
  const electronBinary = process.env.RELAI_ELECTRON_BINARY || path.resolve(root, 'electron', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  assert.equal(fs.existsSync(electronBinary), true, `Electron binary not found at ${electronBinary}`);
  assert.equal(fs.existsSync(axePath), true, `axe-core probe source not found at ${axePath}`);
  const probe = path.join(root, 'test', 'fixtures', 'electron-dashboard-probe');
  const target = `http://127.0.0.1:${port}/dashboard?token=${encodeURIComponent(token)}#home`;
  child = spawn(electronBinary, [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    `--user-data-dir=${path.join(temp, 'electron-profile')}`,
    probe
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: electronEnvironment({
      RELAI_PROBE_TARGET_URL: target,
      RELAI_PROBE_OUTPUT_PATH: outputPath,
      RELAI_PROBE_SCREENSHOT_DIR: screenshotDir,
      RELAI_PROBE_CREATE_WORKSPACE_PATH: projectCreateWorkspace,
      RELAI_PROBE_DASHBOARD_DELAY_MS: '900',
      RELAI_PROBE_AXE_PATH: axePath
    })
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  closePromise = once(child, 'close').catch(() => []);
  await waitForProbeStage(outputPath, 'dashboard_ready', 15_000);
  mcpSession = await createHttpMcpSession(`http://127.0.0.1:${port}`, { token, clientName: 'dashboard-live-rendering-acceptance' });
  const listed = await mcpSession.request('tools/list');
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  const result = await waitForProbeResult(outputPath, 45_000).catch(async error => {
    if (child?.exitCode == null) child.kill('SIGKILL');
    const [code] = await Promise.race([
      closePromise,
      new Promise(resolve => setTimeout(() => resolve(['timeout']), 2_000))
    ]);
    throw new Error(`Electron probe did not complete (launcher code ${code ?? 'unknown'}). stdout=${stdout} stderr=${stderr}\n${error.message}`);
  });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.initialHydration.delayedDashboardRequest, true, JSON.stringify(result.initialHydration));
  assert.equal(result.initialHydration.before.falseEmpty, false, JSON.stringify(result.initialHydration));
  assert.equal(result.initialHydration.during.falseEmpty, false, JSON.stringify(result.initialHydration));
  assert.equal(result.initialHydration.during.loading, true, JSON.stringify(result.initialHydration));
  assert.match(result.initialHydration.during.loadingText, /Loading page/i, JSON.stringify(result.initialHydration));
  assert.doesNotMatch(result.initialHydration.during.loadingText, /Loading Rel\.AI|Checking your connection/i, JSON.stringify(result.initialHydration));
  assert.ok(result.initialHydration.after.workspaceCount >= 1, JSON.stringify(result.initialHydration));
  assert.equal(result.initialHydration.after.falseEmpty, false, JSON.stringify(result.initialHydration));
  assert.ok(result.initial.rowCount >= 9);
  for (const label of ['queued', 'planning', 'running', 'blocked', 'validating', 'completed', 'failed', 'cancelled']) {
    assert.ok(result.initial.rowText.some(text => text.toLowerCase().includes(label)), `Missing rendered state: ${label}`);
  }
  assert.equal(result.initial.determinateValid, true);
  assert.equal(result.initial.indeterminateValid, true);
  assert.equal(result.initial.terminalRowCount, 3, JSON.stringify(result.initial));
  assert.equal(result.initial.terminalLiveClockCount, 0, 'terminal sessions must not register second-level live clocks');
  assert.equal(result.initial.terminalDurationVisible, true, 'terminal sessions must retain a compact static duration');
  assert.equal(result.initial.terminalNoProgress, true, 'terminal rows must not spend space on completed progress widgets');
  assert.equal(result.initial.unknownStatusCount, 0);
  assert.equal(result.initial.longTitleAccessible, true);
  assert.equal(result.initial.reducedMotion, true);
  assert.equal(result.initial.reactFoundationReady, true, 'the production dashboard must mount the React migration root');
  assert.ok(result.initial.reactRevisionKey.length > 0, 'the React migration root must subscribe to the canonical dashboard store');
  assert.equal(result.liveToolUpdate.received, true, JSON.stringify(result.liveToolUpdate));
  assert.notEqual(result.liveToolUpdate.reactRevisionKey, result.initial.reactRevisionKey, 'accepted SSE revisions must reach React through the canonical store subscription');
  assert.equal(result.liveToolUpdate.sameRouteNode, true, 'an MCP tool request must not remount the active dashboard route');
  assert.deepEqual(result.navigationInteractions.map(item => item.hash), [
    '#home', '#tasks', '#code', '#workspaces', '#activity',
    '#processes', '#diagnostics', '#tools', '#usage',
    '#settings/connection', '#settings', '#settings/application', '#settings/about'
  ]);
  for (const interaction of result.navigationInteractions) {
    assert.equal(interaction.hitTarget.ownsControl, true, `${interaction.selector} is covered by another element`);
    assert.equal(interaction.opened, true, `${interaction.selector} did not open ${interaction.hash}`);
  }
  assert.equal(result.skipLinkInteractions.length, 4, 'skip link must cover keyboard and pointer activation on clean and dirty pages');
  for (const { activation, dirty, before, after } of result.skipLinkInteractions) {
    const context = JSON.stringify({ activation, dirty, before, after });
    assert.equal(after.focused, 'main', context);
    assert.equal(after.hash, before.hash, context);
    assert.equal(after.historyLength, before.historyLength, context);
    assert.equal(after.title, before.title, context);
    assert.equal(after.sameRouteNode, true, context);
    assert.equal(after.dialog, false, context);
    assert.equal(after.dirty, String(dirty), context);
    assert.equal(after.draft, 'unsaved draft', context);
  }
  assert.equal(result.modalInteractions.editDeleteCancelPreserved, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.dirtyClosePrompted, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.dirtyCancelPreserved, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.discardClosed, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.editDetailsConsolidated, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.routeChangeCancelPreserved, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.routeChangeConfirmNavigated, true, JSON.stringify(result.modalInteractions));
  assert.equal(result.modalInteractions.sharedCloseVisible, true, JSON.stringify(result.modalInteractions));
  assert.ok(result.modalInteractions.modalGeometry, JSON.stringify(result.modalInteractions));
  assert.ok(result.modalInteractions.modalGeometry.left >= 0 && result.modalInteractions.modalGeometry.top >= 0, `Modal must stay fully inside the viewport: ${JSON.stringify(result.modalInteractions.modalGeometry)}`);
  assert.ok(result.modalInteractions.modalGeometry.right <= result.modalInteractions.modalGeometry.viewportWidth + 1 && result.modalInteractions.modalGeometry.bottom <= result.modalInteractions.modalGeometry.viewportHeight + 1, `Modal must stay fully inside the viewport: ${JSON.stringify(result.modalInteractions.modalGeometry)}`);
  assert.ok(result.modalInteractions.modalGeometry.centerErrorX <= 2 && result.modalInteractions.modalGeometry.centerErrorY <= 2, `Modal must stay centered in the visual viewport: ${JSON.stringify(result.modalInteractions.modalGeometry)}`);
  assert.deepEqual(result.projectPersistence, {
    created: true,
    edited: true,
    oldAliasRemoved: true,
    finalAlias: 'acceptance-created-edited',
    recentProjectsAbsent: true
  });
  assert.deepEqual(result.passiveRouteStability.map(item => item.route), ['settings', 'diagnostics', 'workspaces', 'tools']);
  for (const route of result.passiveRouteStability) {
    assert.equal(route.sameRouteNode, true, `MCP activity remounted #${route.route}: ${JSON.stringify(route)}`);
    assert.equal(route.loadingSeen, false, `MCP activity exposed a loading placeholder on #${route.route}: ${JSON.stringify(route)}`);
    assert.deepEqual(route.mainFrameNavigationDelta, { didStartNavigation: 0, didNavigate: 0, didFinishLoad: 0 }, `MCP activity navigated the main frame on #${route.route}`);
  }
  assert.equal(result.taskInteraction.immediate, true, 'Task summary detail must render synchronously on selection before history hydration');
  assert.equal(result.taskInteraction.inspector, true);
  assert.equal(result.taskInteraction.selectedRow, true);
  assert.equal(result.taskInteraction.tabs, 3);
  assert.ok(result.taskInteraction.detailText.length > 100);
  assert.equal(result.taskInteraction.workSessionId, true);
  assert.ok(result.taskInteraction.eventLinks > 0, JSON.stringify(result.taskInteraction));
  assert.equal(result.taskSelectionStability.immediate, 'acceptance-running');
  assert.equal(result.taskSelectionStability.afterRefresh.selected, 'acceptance-running', 'live task refresh must preserve the clicked task instead of restoring the old completed deep link');
  assert.equal(result.taskSelectionStability.afterRefresh.routeTask, 'acceptance-running', 'mouse selection must update the task deep link');
  assert.equal(result.taskSelectionStability.afterRefresh.activeTab, 'activity', 'live task refresh must preserve the inspector tab');
  assert.equal(result.taskSelectionStability.keyboard.routeTask, result.taskSelectionStability.nextId, 'keyboard selection must update the task deep link');
  assert.equal(result.taskSelectionStability.keyboard.focused, result.taskSelectionStability.nextId, 'changing task parameters must preserve keyboard focus in the task list');
  assert.equal(result.clock.changed, true, `the live task clock did not advance without interaction: ${JSON.stringify(result.clock)}`);
  assert.notEqual(result.keyboard.afterFocus.tag, 'BODY');
  assert.equal(result.activityInteraction.expanded, true);
  assert.equal(result.activityInteraction.selectedRow, true);
  assert.equal(result.activitySelectionStability.selected, result.activitySelectionStability.expected, 'refreshing activity must preserve the newly selected event instead of restoring the original deep link');
  assert.equal(result.activitySelectionStability.routeEvent, result.activitySelectionStability.expected, 'activity selection must update the event deep link');
  assert.equal(result.activityInteraction.copyButton, true);
  assert.equal(result.activityInteraction.errorWrapped, true);
  assert.deepEqual(result.activityDesktopGeometry.visibleHeaders, ['Time', 'Activity'], JSON.stringify(result.activityDesktopGeometry));
  assert.equal(result.activityDesktopGeometry.headerVisible, true, JSON.stringify(result.activityDesktopGeometry));
  assert.equal(result.activityDesktopGeometry.cellVisible, true, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.headerWidth >= 240, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.cellWidth >= 240, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.messageText.length > 0, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.measuredMessageRows >= 2, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.maxMessageLeftAlignmentError <= 1, `Activity messages must share the same left edge: ${JSON.stringify(result.activityDesktopGeometry)}`);
  assert.ok(result.activityDesktopGeometry.measuredStatusRows >= 2, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.maxStatusLeftAlignmentError <= 1, `Activity status chips must share the same left edge: ${JSON.stringify(result.activityDesktopGeometry)}`);
  assert.ok(Math.abs(result.activityDesktopGeometry.tableWidth - result.activityDesktopGeometry.wrapWidth) <= 1, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(Math.abs(result.activityDesktopGeometry.visibleHeaderWidth - result.activityDesktopGeometry.wrapWidth) <= 1, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityDesktopGeometry.trailingWidthGap <= 1, JSON.stringify(result.activityDesktopGeometry));
  assert.ok(result.activityLiveStability.beforeText.length > 0, JSON.stringify(result.activityLiveStability));
  assert.equal(result.activityLiveStability.afterText, result.activityLiveStability.beforeText, JSON.stringify(result.activityLiveStability));
  assert.equal(result.activityLiveStability.sameMessageNode, true, 'clock and refresh updates must preserve the visible Activity message row');
  assert.equal(result.activityLiveStability.childListMutations, 0, JSON.stringify(result.activityLiveStability));
  assert.ok(result.activityLiveStability.messageCount > 0, JSON.stringify(result.activityLiveStability));
  assert.equal(result.activityLiveStability.frozen, true, JSON.stringify(result.activityLiveStability));
  assert.equal(result.activityLiveStability.resumed, true, JSON.stringify(result.activityLiveStability));
  assert.ok(result.activityLiveStability.messageAfterResume.length > 0, JSON.stringify(result.activityLiveStability));
  const operationDiagnostics = result.operationDiagnostics;
  assert.deepEqual(operationDiagnostics.legacy, { unknownTiming: true, unknownTermination: true, liveClocks: 0 });
  assert.equal(operationDiagnostics.keyboardExpanded, true, 'native timing disclosure must open from the keyboard');
  assert.deepEqual(operationDiagnostics.repeated, {
    samePanel: true, sameDisclosure: true, expanded: true, focusPreserved: true,
    statusMutations: 0, measuredDuration: true, clockOutsideAnnouncement: true
  }, 'repeated aggregate polls must preserve disclosure, focus, measured durations and quiet live status');
  assert.deepEqual(operationDiagnostics.collecting, { samePanel: true, expanded: true, sameLiveRegion: true });
  assert.deepEqual(operationDiagnostics.ready, {
    samePanel: true, sameLiveRegion: true, noLiveClock: true, uncertaintyVisible: true, cachedBuild: true, parityUnknown: true
  }, 'result readiness must preserve the live region, stop clocks, and retain uncertainty/build provenance');
  assert.ok(operationDiagnostics.narrow.viewportWidth >= 300 && operationDiagnostics.narrow.viewportWidth <= 375);
  assert.equal(operationDiagnostics.narrow.horizontalOverflow, false, 'expanded operation diagnostics must reflow on a narrow viewport');
  assert.equal(operationDiagnostics.narrow.factsContained, true, 'long blocker identifiers must stay inside the inspector');
  assert.equal(operationDiagnostics.narrow.summaryReachable, true);
  assert.equal(operationDiagnostics.narrow.expanded, true);
  assert.equal(fs.existsSync(operationDiagnostics.narrow.screenshot), true);
  assert.deepEqual(result.responsive.map(item => item.name), [
    'window-1024x768',
    'window-640x720',
    'css-320-zoom-200',
    'css-375-zoom-200',
    'zoom-400',
    'css-320-zoom-400'
  ]);
  for (const scenario of result.responsive) {
    assert.equal(scenario.horizontalOverflow, false, `${scenario.name} has horizontal overflow`);
    assert.equal(scenario.mobileNavScrollable, false, `${scenario.name} hides primary navigation behind horizontal scrolling`);
    if (scenario.viewportWidth <= 760) assert.equal(scenario.mobileMoreVisible, true, `${scenario.name} does not expose the mobile More navigation control`);
    assert.equal(scenario.topbarIntersects, true, `${scenario.name} topbar is outside the visual viewport`);
    assert.equal(scenario.taskRowIntersects, true, `${scenario.name} has no visible task row`);
    assert.equal(scenario.primaryControlIntersects, true, `${scenario.name} has no reachable primary control`);
    assert.equal(scenario.focusVisible, true, `${scenario.name} does not show keyboard focus: ${JSON.stringify(scenario)}`);
    assert.equal(scenario.keyboardAdvanced, true, `${scenario.name} traps keyboard focus`);
    assert.ok(scenario.statusText.length > 0, `${scenario.name} conveys status only by color`);
    assert.equal(scenario.longContentContained, true, `${scenario.name} allows long content to widen a task row`);
    assert.equal(scenario.activityHorizontalOverflow, false, `${scenario.name} requires horizontal Activity scrolling`);
    assert.equal(scenario.activityMessageVisible, true, `${scenario.name} hides the Activity message at scroll position zero`);
    assert.ok(scenario.activityMessageText.length > 0, `${scenario.name} renders an empty Activity message`);
    assert.equal(scenario.activityScrollLeft, 0, `${scenario.name} moved Activity away from its initial position`);
    assert.equal(scenario.reducedMotion, true);
    assert.equal(scenario.forcedColorsSupported, true, `${scenario.name} Chromium build lacks forced-color-adjust support`);
    assert.ok(Number.isFinite(scenario.devicePixelRatio) && scenario.devicePixelRatio >= 1);
    assert.equal(fs.existsSync(scenario.screenshot), true, `${scenario.name} screenshot is missing`);
    assert.equal(scenario.captureState.hash, '#tasks', `${scenario.name} screenshot must match the committed route`);
    assert.equal(scenario.captureState.title, 'Tasks', `${scenario.name} screenshot must have the committed title`);
    assert.ok(scenario.captureState.activeNavigation.every(id => id === 'tasks'), `${scenario.name} screenshot must have matching navigation`);
    // Keep the original 156-CSS-pixel stress case and report its measured limits.
    // Standard reflow scenarios must show content between persistent controls.
    if (scenario.captureState.viewportWidth >= 300) {
      assert.ok(scenario.captureState.visibleTaskRows > 0, `${scenario.name} screenshot has no task row in the content viewport`);
      assert.equal(scenario.captureState.navigationLabelsOverlap, false, `${scenario.name} navigation labels overlap`);
    }
  }
  const responsive1024 = result.responsive.find(item => item.name === 'window-1024x768');
  assert.equal(responsive1024.activityStacked, true, JSON.stringify(responsive1024));
  assert.equal(responsive1024.activityDetailVisible, true, JSON.stringify(responsive1024));
  assert.equal(responsive1024.activityDetailFocused, true, JSON.stringify(responsive1024));
  const responsive640 = result.responsive.find(item => item.name === 'window-640x720');
  assert.equal(responsive640.taskDetailVisible, true, JSON.stringify(responsive640));
  assert.equal(responsive640.taskDetailFocused, true, JSON.stringify(responsive640));
  assert.equal(responsive640.activityDetailVisible, true, JSON.stringify(responsive640));
  assert.equal(responsive640.activityDetailFocused, true, JSON.stringify(responsive640));
  assert.ok(result.responsive.find(item => item.name === 'css-320-zoom-200').viewportWidth <= 320);
  assert.ok(result.responsive.find(item => item.name === 'css-375-zoom-200').viewportWidth <= 375);
  assert.equal(result.responsive.find(item => item.name === 'zoom-400').zoomFactor, 4);
  const standard400 = result.responsive.find(item => item.name === 'css-320-zoom-400');
  assert.equal(standard400.zoomFactor, 4);
  assert.ok(standard400.viewportWidth >= 300 && standard400.viewportWidth <= 320, JSON.stringify(standard400));
  assert.equal(result.accessibility.length, 3, JSON.stringify(result.accessibility));
  const seriousAccessibilityViolations = result.accessibility.flatMap(audit => audit.violations
    .filter(violation => ['critical', 'serious'].includes(violation.impact))
    .map(violation => ({ route: audit.route, ...violation })));
  assert.deepEqual(seriousAccessibilityViolations, [], `Critical/serious axe violations: ${JSON.stringify(seriousAccessibilityViolations)}`);
  assert.equal(result.failures.length, 0, JSON.stringify(result.failures));
  await closePromise;
  console.log(`Real Electron Chromium dashboard acceptance passed across ${result.responsive.length} viewport scenarios; fixture screenshots were generated and their existence checked.`);
} finally {
  await mcpSession?.close().catch(() => {});
  if (child && child.exitCode == null) child.kill('SIGKILL');
  await closePromise.catch(() => {});
  server.kill('SIGKILL');
  await once(server, 'close').catch(() => {});
  if (keepArtifacts) console.log(`Dashboard probe artifacts retained at ${temp}`);
  else fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function electronEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

function seedSessions(directory) {
  const now = Date.now();
  const states = [
    ['queued', { mode: 'indeterminate', label: 'Queued' }],
    ['planning', { mode: 'indeterminate', label: 'Planning' }],
    ['running', { mode: 'indeterminate', label: 'Running' }],
    ['waiting_for_approval', { mode: 'indeterminate', label: 'Approval required' }],
    ['blocked', { mode: 'indeterminate', label: 'Blocked' }],
    ['validating', { mode: 'determinate', completedUnits: 1, totalUnits: 2, percentage: 50, label: '1 of 2 checks' }],
    ['completed', { mode: 'determinate', completedUnits: 2, totalUnits: 2, percentage: 100, label: 'Complete' }],
    ['failed', { mode: 'indeterminate', label: 'Running failed command' }],
    ['cancelled', { mode: 'indeterminate', label: 'Running abandoned command' }]
  ];
  states.forEach(([status, progress], index) => {
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    const id = `acceptance-${status}`;
    writeSession(directory, {
      id,
      taskId: id,
      work_id: id,
      version: 3,
      title: status === 'running' ? `Extremely long task title ${'x'.repeat(120)} accessible in full` : `${status.replaceAll('_', ' ')} task`,
      objective: 'Renderer acceptance state.',
      workspace: 'app',
      status,
      state: terminal ? 'ended' : 'active',
      completionKnown: status === 'completed',
      summary: status === 'completed' ? 'Completed with retained warning metadata.' : '',
      startedAt: now - (index + 1) * 60_000,
      startedAtIso: new Date(now - (index + 1) * 60_000).toISOString(),
      updatedAt: new Date(now - index * 1000).toISOString(),
      lastActivityAt: now - index * 1000,
      endedAt: terminal ? new Date(now - index * 1000).toISOString() : null,
      completedAt: status === 'completed' ? new Date(now - index * 1000).toISOString() : null,
      durationMs: terminal ? 60_000 : 0,
      calls: 2,
      toolCallCount: 2,
      failures: status === 'failed' || status === 'completed' ? 1 : 0,
      failedToolCallCount: status === 'failed' || status === 'completed' ? 1 : 0,
      currentStage: status.replaceAll('_', ' '),
      currentActivity: `Current ${status.replaceAll('_', ' ')} activity`,
      progress,
      events: [
        {
          eventId: `${id}-event-1`,
          taskId: id,
          timestamp: new Date(now - index * 1000).toISOString(),
          category: 'validation',
          action: 'check',
          status: status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'succeeded',
          title: 'Acceptance check',
          summary: status === 'failed' ? `Wrapped error ${'failure '.repeat(30)}` : 'Safe renderer activity.',
          metadata: { currentIndex: 1, checkCount: 2 }
        }
      ]
    });
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`HTTP server did not become healthy within 15s. ${serverError}`);
}

async function waitForProbeStage(file, expectedStage, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      try {
        const result = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (result?.stage === expectedStage) return result;
        if (result?.error) throw new Error(result.error);
      } catch (error) {
        if (error instanceof SyntaxError) {
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for probe stage ${expectedStage} at ${file}`);
}

async function waitForProbeResult(file, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      try {
        const result = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (result?.initial || result?.error) return result;
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for completed probe result at ${file}`);
}
