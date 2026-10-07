import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTaskHistoryDir, writeSession } from '../src/taskHistoryStorage.ts';
import { getStateDir } from '../src/statePaths.js';
import { runWithMutationProcessOwnership, recordCurrentMutationProcess } from '../src/mutationProcessOwnership.js';
import { startHttpTestServer, stopHttpTestServer } from './helpers/http-test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-filter-browser-'));
const stateDir = path.join(temp, 'state');
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
const outputPath = path.join(temp, 'probe.json');
const token = 'filter-browser-token';
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'filter-fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }));
const config = {
  version: 4,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspace, commands: {}, testCommands: { test: 'npm test' } } }
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
seedSessions(getTaskHistoryDir(config));
assert.equal(path.resolve(getStateDir(config)), path.resolve(stateDir), 'Recovery fixture must use its own isolated state directory.');
const recoveryMarker = runWithMutationProcessOwnership(config, 'app', () => recordCurrentMutationProcess(process.pid), workspace);
const seededRecovery = JSON.parse(fs.readFileSync(recoveryMarker, 'utf8'));
seededRecovery.startedAt = '2000-01-01T00:00:00.000Z';
fs.writeFileSync(recoveryMarker, JSON.stringify(seededRecovery));
const recoveryBytes = fs.readFileSync(recoveryMarker, 'utf8');
const { child: server, port } = await startHttpTestServer({ root, configPath, token, stateDir });
let child;
try {
  const electronBinary = process.env.RELAI_ELECTRON_BINARY || path.resolve(root, 'electron', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  assert.equal(fs.existsSync(electronBinary), true, `Electron binary not found at ${electronBinary}`);
  child = spawn(electronBinary, ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', `--user-data-dir=${path.join(temp, 'profile')}`, path.join(root, 'test', 'fixtures', 'electron-filter-probe')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RELAI_PROBE_TARGET_URL: `http://127.0.0.1:${port}/dashboard?token=${encodeURIComponent(token)}#activity`, RELAI_PROBE_OUTPUT_PATH: outputPath, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const [code] = await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(() => resolve(['timeout']), 60_000))]);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.equal(code, 0, `Filter browser probe failed. stdout=${stdout} stderr=${stderr}`);
  const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(result.error, undefined, result.error ? `${result.error}\n${(result.failures || []).join('\n')}` : undefined);
  assert.deepEqual(result.persistedRecovery.before, { projectBlocked: true, readyAbsent: true, overviewAttention: true });
  assert.deepEqual(result.persistedRecovery.after, result.persistedRecovery.before, 'Current recovery status must survive a historical Activity filter change.');
  assert.match(result.persistedRecovery.activityRoute, /time=24h/);
  assert.equal(fs.readFileSync(recoveryMarker, 'utf8'), recoveryBytes, 'Dashboard reads and filtering must preserve the seeded recovery record.');
  assert.deepEqual(result.shared, {
    searchVisible: true,
    searchLabel: 'Search activity',
    filterButtonLabel: 'Open filters',
    summaryRole: 'status',
    dialogLabel: true,
    focusedInside: true,
    cancelPreserved: true,
    fixedChoicesVisible: true
  });
  assert.deepEqual(result.activityApplied.chipText.sort(), ['Status: failed', 'Time: 24h']);
  assert.deepEqual(result.activityApplied.chipLabels.sort(), ['Remove Status filter: failed', 'Remove Time filter: 24h']);
  assert.equal(result.activityApplied.badge, 'Filters (2)');
  assert.match(result.activityApplied.route, /time=24h/);
  assert.match(result.activityApplied.route, /status=failed/);
  assert.match(result.activityApplied.summary, /events shown/);
  assert.equal(result.activityApplied.freezeExcluded, true);
  assert.equal(result.activityApplied.freezeLabel, 'Freeze live activity');
  assert.equal(result.activityApplied.freezeIconOnly, true);
  assert.match(result.taskChip, /Remove Task filter/);
  assert.deepEqual(result.escapeFocus, { closed: true, focusReturned: true });
  assert.equal(result.mobileDrawer.viewport <= 420, true);
  assert.equal(result.mobileDrawer.horizontalOverflow, false);
  assert.equal(result.mobileDrawer.bottomSheet, true);
  assert.equal(result.mobileDrawer.scrollable, true);
  assert.equal(result.mobileDrawer.actionsReachable, true);
  assert.equal(result.diagnostics.cancelPreserved, true);
  assert.equal(result.diagnostics.fixedChoicesVisible, true);
  assert.equal(result.diagnostics.sourceDisabledForFindings, true);
  assert.equal(result.diagnostics.initialLiveTailLabel, 'Start live updates');
  assert.equal(result.diagnostics.liveTailActiveLabel, 'Pause live updates');
  assert.equal(result.diagnostics.liveTailStarted, true);
  assert.equal(result.diagnostics.liveTailStopped, true);
  assert.equal(result.diagnostics.searchEmpty, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.pendingSearchCleared, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.pendingFilterRemovalPreserved, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.pendingDrawerSearchPreserved, true, JSON.stringify(result.diagnostics));
  assert.equal(result.diagnostics.technicalFindingCodesGated, true);
  assert.equal(result.diagnostics.findingSeveritiesReadable, true);
  assert.deepEqual(result.diagnostics.applied.chips.sort(), ['Scope: Failed activity', 'Severity: Blocking']);
  assert.equal(result.diagnostics.applied.badge, 'Filters (2)');
  assert.match(result.diagnostics.applied.summary, /findings.*log entries shown/);
  assert.equal(result.diagnostics.applied.liveTailPressed, 'false');
  assert.deepEqual(result.diagnostics.applied.reportActions, ['Copy report', 'Export support information']);
  assert.match(result.tools.applied.chip, /Validate/);
  assert.equal(result.tools.applied.badge, 'Filters (1)');
  assert.match(result.tools.applied.summary, /tools shown/);
  assert.ok(result.tools.applied.visibleCards > 0);
  assert.equal(result.tools.capabilityRemoved, true);
  assert.equal(result.tools.searchCleared, true);
  assert.equal(result.tools.emptyState, true);
  assert.deepEqual(result.settings.themes.map(item => item.preference), ['dark', 'light', 'system']);
  assert.deepEqual(result.settings.themeSwitchLabels, ['Follow system appearance', 'Dark theme', 'Light theme']);
  assert.equal(result.settings.themeSwitchIconsUseSvg, true);
  assert.equal(result.settings.themeSwitchCheckedCount, 1);
  assert.equal(result.settings.themeSwitchRole, 'radiogroup');
  assert.deepEqual(result.settings.themeOptionRoles, ['radio', 'radio', 'radio']);
  assert.equal(result.settings.themeKeyboardSelected, 'dark');
  assert.equal(result.settings.themeKeyboardFocused, 'dark');
  assert.equal(result.settings.densityControlRemoved, true);
  assert.equal(result.settings.appearancePreviewRemoved, true);
  assert.equal(result.settings.legacyDensityIgnored, true);
  assert.equal(result.settings.secondaryNavigationRemoved, true);
  assert.equal(result.settings.labelsAssociated, true);
  assert.deepEqual(result.workspaces, {
    validationPreferenceRemoved: true,
    validationMetricRemoved: true,
    editDetailsConsolidated: true,
    inlineAliasValidation: true,
    aliasValidationToastAbsent: true,
    aliasValidationCleared: true,
    redundantProjectActionsRemoved: true,
    focusChipLabel: 'Clear selected project filter: app',
    scopeName: 'Project filter',
    projectFilterPresent: true,
    projectOptionsOrdered: true,
    projectFilterKeyboardFocused: true,
    projectFilterUpdatesRoute: true
  });
  assert.equal(result.connection.primaryCount, 1);
  assert.ok(result.connection.primaryLabel.length > 0);
  assert.equal(result.connection.detailsDisclosure, true);
  assert.equal(result.connection.technicalDetailsRemoved, true);
  assert.equal(result.connection.secondaryNavigationRemoved, true);
  assert.ok(['A', 'BUTTON'].includes(result.connection.primaryTag));
  assert.ok(result.connection.navigationLabels.includes('Work navigation'));
  assert.equal(result.usage.overviewVisible, true);
  assert.equal(result.usage.privacyCopyRemoved, true);
  assert.equal(result.usage.modalVisible, false);
  assert.equal(result.usage.inlineUnavailable, false);
  assert.deepEqual(result.usage.rangeLabels, ['1h', '24h', '7d', '30d', 'Month', 'Custom']);
  assert.equal(result.usage.rangePressedCount, 1);
  assert.equal(result.usage.rangeSelectHidden, true);
  assert.equal(result.usage.rangeRouteUpdated, true);
  assert.equal(result.usage.sameRouteRangeSynced, true, 'Usage controls must follow same-route hash changes and browser history.');
  assert.deepEqual(result.browserTabs.before, {
    count: 2,
    activeCount: 1,
    labels: ['First tab', 'Second tab'],
    closeLabels: ['Close First tab', 'Close Second tab'],
    listLabel: 'Open browser tabs'
  });
  assert.equal(result.browserTabs.tabScrollBehavior, 'auto', 'Browser tab scrolling must avoid smooth motion when reduced motion is requested.');
  assert.deepEqual(result.browserTabs.copyFeedback, {
    copiedValue: 'https://first.example.test/',
    label: 'Page URL copied',
    liveText: 'Page URL copied.'
  });
  assert.equal(result.browserTabs.selectedSecond, true, 'Selecting a browser tab must update the visible active-tab state.');
  assert.deepEqual(result.browserTabs.afterClose, { count: 1, activeCount: 1, title: 'First tab' });
  assert.equal(result.browserTabs.calls.length, 2);
  assert.equal(result.browserTabs.calls[0][0], 'select');
  assert.equal(result.browserTabs.calls[1][0], 'close');
  assert.deepEqual(result.responsive.map(item => item.requestedWidth), [980, 760, 520, 420]);
  for (const viewport of result.responsive) {
    assert.ok(Math.abs(viewport.width - viewport.requestedWidth) <= 2, `requested ${viewport.requestedWidth}px but rendered ${viewport.width}px`);
    assert.equal(viewport.breakpointActive, true, `${viewport.requestedWidth}px breakpoint did not activate`);
    assert.equal(viewport.horizontalOverflow, false, `${viewport.requestedWidth}px has page overflow`);
    assert.equal(viewport.controlsInViewport, true, `${viewport.requestedWidth}px clips a filter control: ${JSON.stringify(viewport.clippedControls)}`);
    assert.equal(viewport.searchVisible, true, `${viewport.requestedWidth}px hides search`);
    assert.equal(viewport.touchTargets, true, `${viewport.requestedWidth}px has an undersized filter control`);
  }
  assert.ok(Math.abs(result.zoom200At420.width - 420) <= 2, JSON.stringify(result.zoom200At420));
  assert.equal(result.zoom200At420.zoomFactor, 2);
  assert.equal(result.zoom200At420.horizontalOverflow, false);
  assert.equal(result.zoom200At420.controlsInViewport, true);
  assert.equal(result.zoom200At420.searchVisible, true);
  assert.equal(result.forcedColors.active, true);
  assert.equal(result.forcedColors.supported, true);
  assert.equal(result.forcedColors.visibleBoundary, true);
  assert.deepEqual(result.failures, []);
  console.log('Rendered filter, settings, workspace, connection, and responsive experience passed.');
} finally {
  if (child && child.exitCode == null) child.kill('SIGKILL');
  await stopHttpTestServer(server);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(0);

function seedSessions(directory) {
  const now = Date.now();
  for (const [status, index] of [['completed', 0], ['failed', 1], ['running', 2]]) {
    const id = `acceptance-${status}`;
    writeSession(directory, {
      id, taskId: id, work_id: id, version: 3, title: `${status} task`, objective: 'Filter acceptance.', workspace: 'app',
      status, state: status === 'running' ? 'active' : 'ended', completionKnown: status === 'completed', summary: status === 'completed' ? 'Completed.' : '',
      startedAt: now - (index + 1) * 60000, startedAtIso: new Date(now - (index + 1) * 60000).toISOString(), updatedAt: new Date(now - index * 1000).toISOString(), lastActivityAt: now - index * 1000,
      endedAt: status === 'running' ? null : new Date(now - index * 1000).toISOString(), calls: 1, toolCallCount: 1, failures: status === 'failed' ? 1 : 0,
      events: [{ eventId: `${id}-event`, taskId: id, timestamp: new Date(now - index * 1000).toISOString(), category: 'validation', action: 'check', status: status === 'failed' ? 'failed' : status === 'running' ? 'running' : 'succeeded', title: 'Acceptance check', summary: status === 'failed' ? 'Acceptance validation failure' : 'Acceptance validation result', tool: 'relai_validate', workspace: 'app' }]
    });
  }
}
