import { getHeapStatistics } from 'node:v8';

const MEMORY_FIELDS = Object.freeze(['rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']);
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
const DEFAULT_MAX_SAMPLES = 60;

// This observer samples only when diagnostics are read. It creates no timer,
// runs no OS command, and never forces GC or retains application objects.
function createNodeMemorySampler(options = {}) {
  const now = options.now || Date.now;
  const readMemory = options.readMemory || (() => process.memoryUsage());
  const readHeap = options.readHeap || getHeapStatistics;
  const intervalMs = Math.max(DEFAULT_SAMPLE_INTERVAL_MS, finiteNumber(options.intervalMs) ?? DEFAULT_SAMPLE_INTERVAL_MS);
  const maxSamples = Math.min(DEFAULT_MAX_SAMPLES, Math.max(3, Math.floor(finiteNumber(options.maxSamples) ?? DEFAULT_MAX_SAMPLES)));
  const samples = [];
  let lastAttemptAtMs = null;
  let error = null;
  let heapLimitBytes = null;

  function snapshot() {
    const atMs = now();
    if (lastAttemptAtMs != null && atMs < lastAttemptAtMs) {
      // Wall-clock adjustments must not produce negative sample windows.
      samples.length = 0;
      lastAttemptAtMs = null;
    }
    if (lastAttemptAtMs == null || atMs - lastAttemptAtMs >= intervalMs) {
      lastAttemptAtMs = atMs;
      try {
        const memory = readMemory();
        const sample = {
          sampledAtMs: atMs,
          rssBytes: finiteNumber(memory?.rss),
          heapUsedBytes: finiteNumber(memory?.heapUsed),
          heapTotalBytes: finiteNumber(memory?.heapTotal),
          externalBytes: finiteNumber(memory?.external),
          arrayBuffersBytes: finiteNumber(memory?.arrayBuffers)
        };
        if (MEMORY_FIELDS.every(field => sample[field] == null)) throw new Error('Memory metrics unavailable');
        heapLimitBytes = finiteNumber(readHeap()?.heap_size_limit);
        samples.push(sample);
        if (samples.length > maxSamples) samples.splice(0, samples.length - maxSamples);
        error = null;
      } catch {
        error = 'Current Node process memory could not be sampled.';
      }
    }
    const current = samples.at(-1) || null;
    return {
      available: Boolean(current) && !error,
      scope: 'current-node-process',
      pid: process.pid,
      source: 'process.memoryUsage',
      sampledAtMs: current?.sampledAtMs ?? null,
      ageMs: current ? Math.max(0, atMs - current.sampledAtMs) : null,
      stale: Boolean(error) || !current,
      error,
      current: current ? { ...current, heapLimitBytes } : null,
      sampling: { intervalMs, maxSamples, mode: 'on-diagnostic-read', retainedSamples: samples.length },
      samples: samples.map(sample => ({ ...sample })),
      trend: memoryTrend(samples),
      interpretation: 'RSS is resident memory for this Node process. Heap, external memory, and ArrayBuffers overlap; do not add them together. These values do not measure Windows private commit or the complete Rel.AI process family. A short-term change is not evidence of a memory leak.'
    };
  }
  return Object.freeze({ snapshot });
}

function memoryTrend(samples) {
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs = first && last ? last.sampledAtMs - first.sampledAtMs : 0;
  const sufficient = samples.length >= 3 && durationMs >= DEFAULT_SAMPLE_INTERVAL_MS * 2;
  const deltaBytes = {};
  const slopeBytesPerMinute = {};
  for (const field of MEMORY_FIELDS) {
    const delta = sufficient && first[field] != null && last[field] != null ? last[field] - first[field] : null;
    deltaBytes[field] = delta;
    slopeBytesPerMinute[field] = delta == null ? null : delta * 60_000 / durationMs;
  }
  return {
    status: sufficient ? 'observed' : 'insufficient-samples',
    sampleCount: samples.length,
    baselineAtMs: first?.sampledAtMs ?? null,
    latestAtMs: last?.sampledAtMs ?? null,
    durationMs,
    baseline: first ? { ...first } : null,
    deltaBytes,
    slopeBytesPerMinute,
    method: 'first-to-last change over retained samples; not a leak assessment'
  };
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

const nodeMemorySampler = createNodeMemorySampler();

function resourceDiagnosticsSnapshot(host, fileReadCache = {}, managedRoots = null) {
  return {
    host,
    node: nodeMemorySampler.snapshot(),
    caches: { fileReads: fileReadCache },
    managedRoots,
    children: {
      measured: false,
      source: 'not-sampled',
      reason: 'The complete Rel.AI process family and detached descendants are not measured. Identity-verified managed roots are listed separately when requested.'
    }
  };
}

export { createNodeMemorySampler, resourceDiagnosticsSnapshot };
