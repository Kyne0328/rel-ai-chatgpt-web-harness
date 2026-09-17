import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createToolActivityTracker } from '../src/toolActivity.js';
import { flushTaskHistoryPersistence, recordTaskActivityEvent, readTaskHistory } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches, resetTaskHistoryStorageMetrics, taskHistoryStorageMetricsSnapshot } from '../src/taskHistoryStorage.ts';
import { stateDatabasePath } from '../src/stateDatabase.ts';
import { createFairResourceScheduler } from '../src/hostResourceScheduler.js';
import { buildDashboardPayload, buildDashboardTaskDelta } from '../src/core/dashboard-data.ts';
import { DASHBOARD_TASK_EVENT_COALESCE_MS, createDashboardTaskEventBatcher } from '../src/core/dashboard-event-batcher.ts';
import { flushLocalAnalytics, readLocalUsageSnapshot, recordLocalToolOutcome } from '../src/localAnalytics.js';
import { sanitizeDisplayText } from '../src/taskObservability.js';
import { createDashboardClock } from '../src/ui/clock.js';

const outputArg = process.argv.find(arg => arg.startsWith('--output='));
const enforceThresholds = process.argv.includes('--enforce-thresholds');
const outputPath = path.resolve(outputArg ? outputArg.slice('--output='.length) : 'dist/observability-benchmark.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-observability-benchmark-'));
const workspacePath = path.join(temp, 'workspace');
const config = {
  version: 3,
  stateDir: path.join(temp, 'state'),
  auditLogPath: path.join(temp, 'state', 'audit.jsonl'),
  workspaces: { app: { path: workspacePath, commands: {}, testCommands: {} } }
};
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ name: 'benchmark-fixture', version: '1.0.0' }));
fs.mkdirSync(config.stateDir, { recursive: true });
fs.writeFileSync(config.auditLogPath, '');

const metrics = [];
const tracker = createToolActivityTracker({ idleMs: 60_000 });
let activityEvents = 0;
let snapshotPublications = 0;
let taskDeltaProjectionMs = 0;
const taskEventBatcher = createDashboardTaskEventBatcher({
  onFlush: batch => {
    const started = performance.now();
    buildDashboardTaskDelta({}, batch.activities);
    taskDeltaProjectionMs += performance.now() - started;
    snapshotPublications += 1;
  }
});
const unsubscribe = tracker.onToolActivity(event => {
  activityEvents += 1;
  recordTaskActivityEvent(config, event, { defer: true });
  taskEventBatcher.push(event);
});

try {
  const start = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin', workspace: 'app', createTask: true, title: 'Benchmark task' });
  const taskId = start.taskId;
  start({ ok: true });
  await flushTaskHistoryPersistence();
  resetTaskHistoryStorageMetrics();
  const stateDbFile = stateDatabasePath(config);
  const beforeStorage = sqliteFileSetBytes(stateDbFile);
  const eventBaseline = activityEvents;
  const publicationBaseline = snapshotPublications;
  const taskDeltaBaseline = taskDeltaProjectionMs;
  for (let index = 0; index < 100; index += 1) {
    const finish = tracker.beginConnectorToolCall({
      tool: 'relai_read',
      workspace: 'app',
      taskId,
      operation: `Read benchmark file ${index}`
    });
    finish.update({ currentStage: 'Reading benchmark data', currentActivity: `Read ${index + 1} of 100` });
    finish({ ok: true, activity: { summary: `Read benchmark file ${index}` } });
  }
  await delay(DASHBOARD_TASK_EVENT_COALESCE_MS + 20);
  await flushTaskHistoryPersistence();
  const afterStorage = sqliteFileSetBytes(stateDbFile);
  const storageMetrics = taskHistoryStorageMetricsSnapshot();
  const queueWaitEvents = await measureUncontendedQueueWaitEvents(100);
  addMetric('activity_events_per_100_tool_calls', '100 serial task-scoped tool calls with one progress update each', null, activityEvents - eventBaseline, 0, 305, '<=');
  addMetric('persistence_writes_per_100_tool_calls', 'same workload; completed SQLite task-history upsert transactions', null, storageMetrics.writes, 0, 10, '<=');
  addMetric('snapshot_publications_per_100_tool_calls', `${DASHBOARD_TASK_EVENT_COALESCE_MS} ms production dashboard task-event batcher under serial burst`, null, snapshotPublications - publicationBaseline, 0, 5, '<=');
  addMetric('task_delta_projection_100_tool_calls_ms', 'production incremental task projection work for the coalesced 100-call burst', null, round(taskDeltaProjectionMs - taskDeltaBaseline), 0, 50, '<=');
  addMetric('queue_wait_events_per_100_tool_calls', '100 serial acquisitions through the production fair scheduler; observed queued admissions', null, queueWaitEvents, 0, 0, '<=');
  addMetric('task_history_storage_growth_bytes', '100 task-scoped calls; durable-state.sqlite plus WAL/SHM files', null, afterStorage - beforeStorage, 0, 2 * 1024 * 1024, '<=');
  addMetric('task_history_payload_bytes_written', 'same workload; serialized payload bytes accepted by SQLite upserts', null, storageMetrics.bytes, 0, 2 * 1024 * 1024, '<=');
  addMetric('task_history_write_duration_ms', 'same workload; cumulative storage-worker SQLite transaction duration', null, round(storageMetrics.durationMs), 0, 2_000, '<=');

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let index = 0; index < 1000; index += 1) {
    const finish = tracker.beginConnectorToolCall({ tool: 'relai_read', workspace: 'app', taskId, operation: `Event ${index}` });
    finish({ ok: true });
  }
  await delay(DASHBOARD_TASK_EVENT_COALESCE_MS + 20);
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  addMetric('memory_after_1000_events_bytes', 'heap used after an additional 1,000 tool calls in one bounded task timeline', null, heapAfter, 0, 256 * 1024 * 1024, '<=');
  addMetric('memory_delta_1000_events_bytes', 'signed heap delta after an additional 1,000 tool calls and garbage collection', null, heapAfter - heapBefore, 0, 32 * 1024 * 1024, '<=');

  const snapshot = tracker.getToolActivity();
  const serializationStart = performance.now();
  const serialized = JSON.stringify(snapshot);
  const serializationMs = performance.now() - serializationStart;
  addMetric('snapshot_serialization_size_bytes', 'current canonical task snapshot', null, Buffer.byteLength(serialized), 0, 512 * 1024, '<=');
  addMetric('snapshot_serialization_latency_ms', 'JSON serialization of current snapshot', null, round(serializationMs), 0, 25, '<=');

  const sanitizerSamples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const sanitizerStart = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      sanitizeDisplayText(`Completed ${index}. Authorization: Bearer synthetic-${index} password=synthetic-${index} tokenizer safe.`, 500);
    }
    sanitizerSamples.push(performance.now() - sanitizerStart);
  }
  addMetric(
    'sanitization_10000_summaries_ms',
    '10,000 credential-like completion strings; median of 5',
    null,
    round(median(sanitizerSamples)),
    round(range(sanitizerSamples)),
    250,
    '<='
  );

  const analyticsStart = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    recordLocalToolOutcome(config, { tool: 'relai_read', workspace: 'app', ok: true, durationMs: 4 + (index % 5) });
  }
  const analyticsHotPathMs = performance.now() - analyticsStart;
  const analyticsSnapshot = readLocalUsageSnapshot(config);
  addMetric(
    'local_analytics_hot_path_1000_calls_ms',
    '1,000 synchronous SQLite analytics updates, each durable before recordLocalToolOutcome returns',
    null,
    round(analyticsHotPathMs),
    0,
    10_000,
    '<=',
    undefined,
    'The current durable-state contract budgets up to 10 ms per synchronous analytics update.'
  );
  addMetric(
    'local_analytics_durable_tool_calls_after_1000_calls',
    'same workload; the SQLite-backed analytics snapshot must expose all writes immediately without a deferred flush',
    null,
    Number(analyticsSnapshot?.totals?.toolCalls || 0),
    0,
    1000,
    '>='
  );

  const activitySnapshot = tracker.getToolActivity();
  const tasks = readTaskHistory(config, activitySnapshot, { limit: 500 });
  buildDashboardPayload(config, { taskActivity: activitySnapshot, limit: 500 }, false);
  const reconnectSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const reconnectStart = performance.now();
    buildDashboardPayload(config, { taskActivity: activitySnapshot, limit: 500 }, false);
    reconnectSamples.push(performance.now() - reconnectStart);
  }
  const reconnectMs = median(reconnectSamples);
  addMetric('reconnect_snapshot_latency_ms', `warm canonical dashboard snapshot with ${tasks.length} task session(s); median of 5`, null, round(reconnectMs), round(range(reconnectSamples)), 150, '<=');

  const clockBenchmark = runDashboardClockBenchmark();
  addMetric('clock_document_queries_during_60_ticks', 'production dashboard clock with 2 live durations and 50 historical relative timestamps', null, clockBenchmark.documentQueriesDuringTicks, 0, 0, '<=');
  addMetric('clock_live_node_updates_60s', 'production dashboard clock updating only 2 live session durations for 60 ticks', null, clockBenchmark.liveNodeUpdates, 0, 120, '<=');
  const renderer = runRendererBenchmark();
  if (renderer.ok) {
    addMetric('quiet_full_dashboard_renders_60s', 'executed hidden Electron renderer workload with 52 session rows and 60 live clock ticks', null, renderer.result.quietFullRenders, 0, 0, '<=');
    addMetric('quiet_clock_node_updates_60s', '2 open sessions receive 60 second-level updates while 50 completed sessions stay static', null, renderer.result.quietClockNodeUpdates, 0, 120, '<=');
    addMetric('full_renders_during_100_progress_updates', 'executed 100 progress updates on one session row', null, renderer.result.progressFullRenders, round(renderer.result.progressLatencyMs), 0, '<=');
    addMetric('session_row_replacements_during_100_progress_updates', '100 progress updates preserve the keyed session row node', null, renderer.result.sessionRowReplacementsDuringProgress, 0, 0, '<=');
    addMetric('timeline_200_event_render_ms', 'executed creation and attachment of a 200-event timeline in Electron', null, round(renderer.result.timelineRenderMs), 0, 200, '<=');
    addMetric('logical_task_switch_memory_delta_bytes', 'executed 40 logical-task panel switches in Electron with precise memory information', null, renderer.result.logicalTaskSwitchMemoryDeltaBytes, 0, 16 * 1024 * 1024, '<=');
    addMetric('hidden_tab_timer_elapsed_ms', 'executed a 100 ms timer in a hidden Electron BrowserWindow', null, round(renderer.result.hiddenTimerElapsedMs), 0, 1500, '<=');
    addMetric('renderer_reconnect_to_current_state_ms', 'executed replacement with a 500-record current-state snapshot in Electron', null, round(renderer.result.reconnectMs), 0, 500, '<=');
  } else {
    for (const [metric, threshold] of [
      ['quiet_full_dashboard_renders_60s', 0],
      ['quiet_clock_node_updates_60s', 120],
      ['full_renders_during_100_progress_updates', 0],
      ['session_row_replacements_during_100_progress_updates', 0],
      ['timeline_200_event_render_ms', 200],
      ['logical_task_switch_memory_delta_bytes', 16 * 1024 * 1024],
      ['hidden_tab_timer_elapsed_ms', 1500],
      ['renderer_reconnect_to_current_state_ms', 500]
    ]) addMetric(metric, 'required Electron renderer workload', null, null, null, threshold, '<=', 'incomplete', renderer.diagnostic);
  }

  tracker.cancelTask(taskId, { reason: 'Benchmark completed.', initiator: 'benchmark' });
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    commit: gitCommit(),
    baselineAvailable: false,
    baselineNote: 'Thresholds are regression indicators by default. Use --enforce-thresholds only when deliberately validating an explicit performance SLO.',
    thresholdPolicy: enforceThresholds ? 'blocking' : 'advisory',
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem()
    },
    metrics,
    complete: metrics.every(item => item.status !== 'incomplete'),
    summary: {
      passed: metrics.filter(item => item.status === 'pass').length,
      failed: metrics.filter(item => item.status === 'fail').length,
      incomplete: metrics.filter(item => item.status === 'incomplete').length
    }
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete || (enforceThresholds && report.summary.failed > 0)) process.exitCode = 1;
} finally {
  taskEventBatcher.close();
  unsubscribe();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics(config);
  resetTaskHistoryCaches();
  fs.rmSync(temp, { recursive: true, force: true });
}

function addMetric(metric, workload, baseline, result, variance, threshold, comparator, forcedStatus, note = '') {
  const status = forcedStatus || (result == null ? 'incomplete' : comparator === '<=' ? (result <= threshold ? 'pass' : 'fail') : (result >= threshold ? 'pass' : 'fail'));
  metrics.push({ metric, workload, baseline, result, variance, threshold, comparator, status, note });
}

function runDashboardClockBenchmark() {
  class ClockNode {
    constructor(attributes = {}) {
      this.attributes = new Map(Object.entries(attributes));
      this._textContent = '';
      this.isConnected = true;
      this.updates = 0;
    }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    get textContent() { return this._textContent; }
    set textContent(value) {
      const next = String(value);
      if (next === this._textContent) return;
      this._textContent = next;
      this.updates += 1;
    }
  }

  const startedAt = Date.parse('2026-08-08T12:00:00.000Z');
  let currentTime = startedAt;
  const liveNodes = [
    new ClockNode({ 'data-clock-elapsed-start': String(startedAt) }),
    new ClockNode({ 'data-clock-elapsed-start': String(startedAt - 30_000) })
  ];
  const relativeNodes = Array.from({ length: 50 }, (_, index) => new ClockNode({
    'data-clock-relative': new Date(startedAt - (index + 1) * 60_000).toISOString()
  }));
  const nodes = [...liveNodes, ...relativeNodes];
  let documentQueries = 0;
  const documentRef = {
    visibilityState: 'visible',
    querySelectorAll() { documentQueries += 1; return nodes; },
    addEventListener() {},
    removeEventListener() {}
  };
  const clock = createDashboardClock({
    documentRef,
    windowRef: {},
    now: () => currentTime,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {}
  });
  clock.start();
  const queriesAfterStart = documentQueries;
  const updatesAfterStart = liveNodes.reduce((sum, node) => sum + node.updates, 0);
  for (let index = 0; index < 60; index += 1) {
    currentTime += 1000;
    clock.tick();
  }
  const liveNodeUpdates = liveNodes.reduce((sum, node) => sum + node.updates, 0) - updatesAfterStart;
  const documentQueriesDuringTicks = documentQueries - queriesAfterStart;
  clock.stop();
  return { liveNodeUpdates, documentQueriesDuringTicks };
}

function runRendererBenchmark() {
  try {
    const electronRoot = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'electron', 'node_modules', 'electron');
    const executableName = fs.readFileSync(path.join(electronRoot, 'path.txt'), 'utf8').trim();
    const executable = path.join(electronRoot, 'dist', executableName);
    const fixture = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test', 'fixtures', 'electron-observability-benchmark');
    if (!fs.existsSync(executable)) throw new Error(`Electron executable is missing: ${executable}`);
    const electronArgs = [
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      '--disable-gpu',
      '--disable-software-rasterizer',
      `--user-data-dir=${path.join(temp, 'electron-profile')}`,
      fixture
    ];
    const child = spawnSync(executable, electronArgs, {
      cwd: fixture,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false
    });
    if (child.error) throw child.error;
    const output = `${child.stdout || ''}\n${child.stderr || ''}`;
    if (child.signal) {
      const detail = output.trim().slice(-4000);
      throw new Error(`Electron renderer workload was terminated by ${child.signal}.${detail ? ` ${detail}` : ''}`);
    }
    const marker = output.match(/REL_AI_RENDERER_BENCHMARK_RESULT=([A-Za-z0-9+/=]+)/);
    if (child.status !== 0 || !marker) {
      const encodedError = output.match(/REL_AI_RENDERER_BENCHMARK_ERROR=([A-Za-z0-9+/=]+)/)?.[1];
      const detail = encodedError ? Buffer.from(encodedError, 'base64').toString('utf8') : output.trim();
      throw new Error(`Electron renderer workload failed with exit ${child.status}: ${detail}`);
    }
    const result = JSON.parse(Buffer.from(marker[1], 'base64').toString('utf8'));
    const required = ['quietFullRenders', 'quietClockNodeUpdates', 'progressFullRenders', 'sessionRowReplacementsDuringProgress', 'progressLatencyMs', 'timelineRenderMs', 'logicalTaskSwitchMemoryDeltaBytes', 'hiddenTimerElapsedMs', 'reconnectMs'];
    for (const name of required) {
      if (!Number.isFinite(result[name])) throw new Error(`Electron renderer metric ${name} is missing or non-numeric.`);
    }
    return { ok: true, result };
  } catch (error) {
    return { ok: false, diagnostic: error instanceof Error ? error.message : String(error) };
  }
}

function sqliteFileSetBytes(file) {
  return [file, `${file}-wal`, `${file}-shm`].reduce((total, target) => {
    try { return total + fs.statSync(target).size; } catch { return total; }
  }, 0);
}

async function measureUncontendedQueueWaitEvents(count) {
  const scheduler = createFairResourceScheduler({ heavy: 1 });
  let queuedAdmissions = 0;
  for (let index = 0; index < count; index += 1) {
    const before = scheduler.stats().heavy;
    if (before.active >= before.limit || before.queued > 0) queuedAdmissions += 1;
    const lease = await scheduler.acquire('heavy', `serial-${index}`);
    lease.release();
  }
  return queuedAdmissions;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function range(values) {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
