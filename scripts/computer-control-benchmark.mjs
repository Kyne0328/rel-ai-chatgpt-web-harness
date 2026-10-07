import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import { runComputerAction } from '../src/computerManager.js';
import { createMidsceneComputerAdapter } from '../src/computer/midsceneAdapter.ts';
import { createWindowsUiaAdapter } from '../src/computer/windowsUiaAdapter.ts';
import { selectAppTarget } from '../src/computer/appTarget.ts';

const live = process.argv.includes('--live');
const enforceThresholds = process.argv.includes('--enforce-thresholds');
const uiaApp = process.argv.find(arg => arg.startsWith('--uia-app='))?.slice('--uia-app='.length) || '';
const requestedIterations = Number(process.argv.find(arg => arg.startsWith('--iterations='))?.split('=')[1] || 20);
const iterations = Number.isInteger(requestedIterations) && requestedIterations > 0 ? Math.min(requestedIterations, 200) : 20;

const syntheticPng = await sharp({
  create: {
    width: 1920,
    height: 1080,
    channels: 3,
    background: { r: 24, g: 28, b: 36 }
  }
}).png().toBuffer();

const calls = [];
const app = 'benchmark-app';
// These identifiers describe generated test data, not a real HWND/process.
// Native capture latency and rendering compatibility require the opt-in fixtures.
const syntheticWindow = Object.freeze({
  windowId: '101', processId: 73, processStartedAt: '100000',
  executablePath: 'C:\\relai-synthetic-fixture\\benchmark-app.exe',
  processName: app, productName: 'Rel.AI Synthetic Benchmark',
  title: 'Generated benchmark PNG', displayId: 'main', visible: true
});
let appCaptureCalls = 0;
let displayCaptureCalls = 0;
let targetResolutions = 0;
const syntheticSemanticAdapter = {
  engine: 'benchmark-synthetic-targets',
  supported: () => true,
  warmup: async () => ({ supported: true, available: true, ocrAvailable: false }),
  resolveAppTarget: async (requestedApp, options) => {
    targetResolutions += 1;
    return selectAppTarget(requestedApp, [syntheticWindow], options);
  },
  observe: async () => ({ supported: true, available: false, reason: 'Synthetic fixture provides generated app pixels only.' }),
  shutdown: async () => {}
};
const syntheticAdapter = {
  engine: 'benchmark-synthetic',
  environment: async () => ({ available: true, platform: process.platform, displays: 1 }),
  listDisplays: async () => [{ id: 'main', name: 'Main', primary: true, coordinateSpace: 'display-local-pixels' }],
  size: async () => ({ width: 1920, height: 1080 }),
  screenshot: async () => {
    displayCaptureCalls += 1;
    throw new Error('Synthetic app benchmark must never use a display screenshot.');
  },
  screenshotApp: async (requestedApp, displayId, options = {}) => {
    assert.equal(requestedApp, app);
    assert.ok(!displayId || displayId === syntheticWindow.displayId);
    assert.equal(options.target?.windowId, syntheticWindow.windowId);
    assert.equal(options.target?.processId, syntheticWindow.processId);
    assert.equal(options.target?.executablePath, syntheticWindow.executablePath);
    appCaptureCalls += 1;
    return {
      mimeType: 'image/png', data: syntheticPng.toString('base64'), bytes: syntheticPng.length,
      width: 1920, height: 1080,
      provenance: {
        scope: 'app-window', method: 'win32-print-window', app: requestedApp,
        windowId: syntheticWindow.windowId, processId: syntheticWindow.processId,
        processStartedAt: syntheticWindow.processStartedAt, displayId: syntheticWindow.displayId,
        coordinateSpace: 'window-local-pixels', originX: 0, originY: 0,
        capturedAt: Date.now(), inputMappingReliable: true, targetIdentity: options.target,
        syntheticFixture: true
      }
    };
  },
  move: async (_displayId, point) => calls.push(['move', point]),
  click: async (_displayId, point) => calls.push(['click', point]),
  doubleClick: async (_displayId, point) => calls.push(['doubleClick', point]),
  rightClick: async (_displayId, point) => calls.push(['rightClick', point]),
  drag: async (_displayId, from, to) => calls.push(['drag', from, to]),
  scroll: async (_displayId, value) => calls.push(['scroll', value]),
  typeText: async text => calls.push(['type', text.length]),
  pressKey: async key => calls.push(['key', key])
};

const workspace = { alias: 'benchmark' };
const config = { computerControl: { enabled: true } };
const context = {
  computerAdapter: syntheticAdapter,
  semanticAdapter: syntheticSemanticAdapter,
  conversationId: 'computer-benchmark',
  principal: 'computer-benchmark'
};
// Untimed controls prove this fixture exercises the app-only boundary instead
// of weakening it to get a latency number.
await assert.rejects(() => runComputerAction(workspace, config, { action: 'screenshot', app }, context),
  error => error.code === 'COMPUTER_APP_APPROVAL_REQUIRED');
assert.equal(appCaptureCalls, 0, 'No image may be produced before explicit fixture-app approval');
await runComputerAction(workspace, config, { action: 'approve_app', app }, context);
await assert.rejects(() => runComputerAction(workspace, config, { action: 'screenshot', app }, {
  ...context, computerAdapter: { ...syntheticAdapter, screenshotApp: undefined }
}), error => error.code === 'COMPUTER_APP_CAPTURE_UNAVAILABLE');
await assert.rejects(() => runComputerAction(workspace, config, { action: 'screenshot', app }, {
  ...context, computerAdapter: { ...syntheticAdapter, screenshotApp: async (...args) => {
    const image = await syntheticAdapter.screenshotApp(...args);
    return { ...image, provenance: { ...image.provenance, app: 'other-synthetic-app' } };
  } }
}), error => error.code === 'COMPUTER_APP_CAPTURE_UNAVAILABLE');
assert.equal(displayCaptureCalls, 0, 'Invalid app provenance must never cause display capture');

const measurements = [];
async function measure(label, fn, count = iterations) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    const result = await fn(index);
    samples.push(performance.now() - started);
    assert.equal(result.ok, true, `${label} must complete successfully before its latency counts`);
    if (label.startsWith('batch-')) {
      assert.equal(result.failed, false, `${label} must not measure a rejected batch`);
      assert.equal(result.executed, true);
      assert.equal(result.results.length, Number(label.slice('batch-'.length)));
    }
    if (label === 'click') assert.equal(result.executed, true);
    if (label === 'screenshot-balanced-force') assert.ok(result.image?.data);
    if (label === 'screenshot-unchanged-dedup') assert.equal(result.changed, false);
  }
  samples.sort((a, b) => a - b);
  const percentile = fraction => samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * fraction))];
  measurements.push({
    label,
    iterations: samples.length,
    minMs: round(samples[0]),
    medianMs: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(samples.at(-1))
  });
}

await measure('screenshot-balanced-force', () => runComputerAction(
  workspace,
  config,
  { action: 'screenshot', app, profile: 'balanced', forceImage: true },
  context
), Math.min(iterations, 10));

await runComputerAction(workspace, config, { action: 'screenshot', app, profile: 'balanced' }, context);
await measure('screenshot-unchanged-dedup', () => runComputerAction(
  workspace,
  config,
  { action: 'screenshot', app, profile: 'balanced' },
  context
));

await measure('click', () => runComputerAction(
  workspace,
  config,
  { action: 'click', app, x: 960, y: 540 },
  context
));

for (const count of [5, 10, 20]) {
  const actions = Array.from({ length: count }, (_, index) => ({ action: 'move', x: 100 + index, y: 100 + index }));
  await measure(`batch-${count}`, () => runComputerAction(
    workspace,
    config,
    { action: 'batch', app, actions },
    context
  ));
}
await runComputerAction(workspace, config, { action: 'stop' }, context);
assert.equal(displayCaptureCalls, 0, 'Timed app workloads must never fall back to display pixels');
assert.equal(calls.length, iterations * (1 + 5 + 10 + 20), 'All timed synthetic input actions must reach the mock driver');

const output = {
  platform: process.platform,
  node: process.version,
  iterations,
  synthetic: {
    scope: 'generated app-window PNG; mocked input only; no native capture or OS input',
    contractControls: { explicitAppApproval: true, missingAppCaptureRejected: true, wrongAppProvenanceRejected: true },
    appCaptureCalls,
    targetResolutions,
    displayCaptureCalls,
    screenshotBytes: syntheticPng.length,
    inputCalls: calls.length,
    measurements
  }
};

if (live) output.live = await liveReadOnlyBenchmark();
if (uiaApp) output.semantic = await liveSemanticBenchmark(uiaApp);
if (enforceThresholds) enforceSyntheticThresholds(measurements);
console.log(JSON.stringify(output, null, 2));

async function liveSemanticBenchmark(appName) {
  const adapter = createWindowsUiaAdapter({ timeoutMs: 10_000 });
  try {
    if (!adapter.supported()) return { supported: false };
    const warmupStarted = performance.now();
    const warmup = await adapter.warmup();
    const warmupMs = round(performance.now() - warmupStarted);
    const started = performance.now();
    const first = await adapter.observe(appName, 120);
    const firstMs = round(performance.now() - started);
    const warmSamples = [];
    for (let index = 0; index < 5; index += 1) {
      const warmStarted = performance.now();
      await adapter.observe(appName, 120);
      warmSamples.push(performance.now() - warmStarted);
    }
    warmSamples.sort((a, b) => a - b);
    const hybridStarted = performance.now();
    const hybrid = await adapter.observe(appName, 120, 'hybrid');
    const hybridMs = round(performance.now() - hybridStarted);
    return {
      supported: true,
      warmup,
      warmupMs,
      available: first.available,
      count: first.count || 0,
      firstMs,
      firstAfterWarmupMs: firstMs,
      warmMedianMs: round(warmSamples[Math.floor(warmSamples.length / 2)]),
      warmMinMs: round(warmSamples[0]),
      warmMaxMs: round(warmSamples.at(-1)),
      hybridMs,
      hybridAvailable: hybrid.available,
      hybridCount: hybrid.count || 0,
      ocrAvailable: hybrid.ocrAvailable === true,
      sources: Array.isArray(hybrid.elements)
        ? [...new Set(hybrid.elements.map(element => element.source || 'uia'))].sort()
        : []
    };
  } finally {
    await adapter.shutdown();
  }
}

function enforceSyntheticThresholds(rows) {
  const limits = new Map([
    ['screenshot-balanced-force', 150],
    ['screenshot-unchanged-dedup', 10],
    ['click', 10],
    ['batch-20', 10]
  ]);
  const failures = [];
  for (const [label, maxP95Ms] of limits) {
    const row = rows.find(entry => entry.label === label);
    if (!row) failures.push(`${label}: missing measurement`);
    else if (row.p95Ms > maxP95Ms) failures.push(`${label}: p95 ${row.p95Ms}ms exceeds ${maxP95Ms}ms`);
  }
  if (failures.length) throw new Error(`Computer-control performance budget failed: ${failures.join('; ')}`);
}

async function liveReadOnlyBenchmark() {
  const adapter = createMidsceneComputerAdapter();
  const result = {};
  const environmentStart = performance.now();
  result.environment = await adapter.environment();
  result.environmentMs = round(performance.now() - environmentStart);
  if (result.environment?.available !== true) return result;

  const displaysStart = performance.now();
  const displays = await adapter.listDisplays();
  result.displaysMs = round(performance.now() - displaysStart);
  result.displays = [];
  for (const display of displays) {
    const entry = { id: display.id, name: display.name, primary: display.primary };
    let started = performance.now();
    entry.size = await adapter.size(display.id);
    entry.sizeColdMs = round(performance.now() - started);
    started = performance.now();
    await adapter.size(display.id);
    entry.sizeWarmMs = round(performance.now() - started);
    started = performance.now();
    const cold = await adapter.screenshot(display.id, { fresh: true });
    entry.screenshotFreshMs = round(performance.now() - started);
    entry.screenshotBytes = cold.bytes;
    started = performance.now();
    await adapter.screenshot(display.id);
    entry.screenshotCachedMs = round(performance.now() - started);
    result.displays.push(entry);
  }
  return result;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}
