import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

import { runComputerAction } from '../src/computerManager.js';
import { createMidsceneComputerAdapter } from '../src/computer/midsceneAdapter.ts';
import { createWindowsUiaAdapter } from '../src/computer/windowsUiaAdapter.ts';

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
const syntheticAdapter = {
  engine: 'benchmark-synthetic',
  environment: async () => ({ available: true, platform: process.platform, displays: 1 }),
  listDisplays: async () => [{ id: 'main', name: 'Main', primary: true, coordinateSpace: 'display-local-pixels' }],
  size: async () => ({ width: 1920, height: 1080 }),
  screenshot: async () => ({
    mimeType: 'image/png',
    data: syntheticPng.toString('base64'),
    bytes: syntheticPng.length,
    width: 1920,
    height: 1080
  }),
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
  conversationId: 'computer-benchmark',
  principal: 'computer-benchmark'
};
const app = 'benchmark-app';
await runComputerAction(workspace, config, { action: 'approve_app', app }, context);

const measurements = [];
async function measure(label, fn, count = iterations) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await fn(index);
    samples.push(performance.now() - started);
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

const output = {
  platform: process.platform,
  node: process.version,
  iterations,
  synthetic: {
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
