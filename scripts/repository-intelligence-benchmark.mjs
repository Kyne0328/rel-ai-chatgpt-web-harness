import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const fileCount = integerArg('--files', 100000, 1, 500000);
const mutationCount = Math.min(fileCount, integerArg('--mutations', 100, 1, 10000));
const maxFullMs = optionalPositiveNumberArg('--max-full-ms');
const maxIncrementalMs = optionalPositiveNumberArg('--max-incremental-ms');
const maxRestartReuseMs = optionalPositiveNumberArg('--max-restart-reuse-ms');
const json = process.argv.includes('--json');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-repository-index-benchmark-'));
const workspaceRoot = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const workspace = { alias: 'benchmark', path: workspaceRoot, context: {}, testCommands: {}, commands: {} };
const config = { stateDir, repositoryIntelligence: { maxFiles: fileCount } };

try {
  createFixture(workspaceRoot, fileCount);
  const before = process.memoryUsage().rss;
  const fullStarted = performance.now();
  const full = await repositoryIntelligence.ensure(workspace, config, { force: true, watch: false, maxFiles: fileCount });
  const fullBuildMs = performance.now() - fullStarted;
  const afterFull = process.memoryUsage().rss;

  const changedPaths = mutateFixture(workspaceRoot, mutationCount);
  repositoryIntelligence.noteMutation(workspace, config, changedPaths);
  const incrementalStarted = performance.now();
  const incremental = await repositoryIntelligence.ensure(workspace, config, { watch: false, maxFiles: fileCount });
  const incrementalRefreshMs = performance.now() - incrementalStarted;
  const afterIncremental = process.memoryUsage().rss;

  await repositoryIntelligence.shutdown();
  const restartStarted = performance.now();
  const restarted = await repositoryIntelligence.ensure(workspace, config, { watch: false, maxFiles: fileCount });
  const restartReuseMs = performance.now() - restartStarted;

  if (full.sourceFileCount !== fileCount) {
    throw new Error(`Expected ${fileCount} indexed files, got ${full.sourceFileCount}.`);
  }
  if (incremental.changedPathCount !== mutationCount) {
    throw new Error(`Expected ${mutationCount} incrementally refreshed files, got ${incremental.changedPathCount}.`);
  }
  if (incremental.scanMode !== 'incremental') {
    throw new Error(`Expected the mutation benchmark to remain incremental, got ${incremental.scanMode}.`);
  }
  if (restarted.generation !== incremental.generation || restarted.cacheHit !== true || restarted.changedPathCount !== 0) {
    throw new Error('Expected restart reuse to load the unchanged persisted Repository Intelligence generation without rebuilding.');
  }

  const report = {
    files: fileCount,
    mutations: mutationCount,
    fullBuildMs: rounded(fullBuildMs),
    incrementalRefreshMs: rounded(incrementalRefreshMs),
    restartReuseMs: rounded(restartReuseMs),
    fullFilesPerSecond: rounded(fileCount / Math.max(fullBuildMs / 1000, 0.001)),
    incrementalFilesPerSecond: rounded(mutationCount / Math.max(incrementalRefreshMs / 1000, 0.001)),
    rssBeforeBytes: before,
    rssAfterFullBytes: afterFull,
    rssAfterIncrementalBytes: afterIncremental,
    workerIsolated: full.workerIsolated === true && incremental.workerIsolated === true,
    watcherDisabled: true,
    fullScanMode: full.scanMode,
    incrementalScanMode: incremental.scanMode,
    restartCacheHit: restarted.cacheHit === true,
    incrementalCoalescedPassCount: Number(incremental.coalescedPassCount || 1),
    thresholds: {
      ...(maxFullMs == null ? {} : { maxFullBuildMs: maxFullMs, fullBuildPassed: fullBuildMs <= maxFullMs }),
      ...(maxIncrementalMs == null ? {} : { maxIncrementalRefreshMs: maxIncrementalMs, incrementalRefreshPassed: incrementalRefreshMs <= maxIncrementalMs }),
      ...(maxRestartReuseMs == null ? {} : { maxRestartReuseMs, restartReusePassed: restartReuseMs <= maxRestartReuseMs })
    }
  };
  const thresholdsPassed = (maxFullMs == null || fullBuildMs <= maxFullMs)
    && (maxIncrementalMs == null || incrementalRefreshMs <= maxIncrementalMs)
    && (maxRestartReuseMs == null || restartReuseMs <= maxRestartReuseMs);

  if (json) process.stdout.write(`${JSON.stringify({ ...report, thresholdsPassed })}\n`);
  else {
    console.log(`Repository Intelligence benchmark (${fileCount.toLocaleString()} files)`);
    console.log(`  Full build:          ${report.fullBuildMs} ms (${report.fullFilesPerSecond} files/s)`);
    console.log(`  Incremental refresh: ${report.incrementalRefreshMs} ms for ${mutationCount} files (${report.incrementalFilesPerSecond} files/s)`);
    console.log(`  Restart reuse:       ${report.restartReuseMs} ms (cache hit=${report.restartCacheHit})`);
    console.log(`  Worker isolated:     ${report.workerIsolated}`);
    console.log('  Watcher:             disabled (engine benchmark)');
    if (maxFullMs != null) console.log(`  Full-build budget:   ${maxFullMs} ms (${fullBuildMs <= maxFullMs ? 'pass' : 'fail'})`);
    if (maxIncrementalMs != null) console.log(`  Incremental budget:  ${maxIncrementalMs} ms (${incrementalRefreshMs <= maxIncrementalMs ? 'pass' : 'fail'})`);
    if (maxRestartReuseMs != null) console.log(`  Restart-reuse budget:${maxRestartReuseMs} ms (${restartReuseMs <= maxRestartReuseMs ? 'pass' : 'fail'})`);
  }
  if (!thresholdsPassed) process.exitCode = 1;
} finally {
  await repositoryIntelligence.shutdown();
  if (process.env.REL_AI_MCP_BENCHMARK_KEEP !== '1') fs.rmSync(root, { recursive: true, force: true });
  else console.error(`Benchmark fixture kept at ${root}`);
}

function createFixture(workspaceRoot, count) {
  for (let index = 0; index < count; index += 1) {
    const relativePath = fixturePath(index);
    const file = path.join(workspaceRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fixtureSource(index, 1), 'utf8');
  }
}

function mutateFixture(workspaceRoot, count) {
  const changed = [];
  for (let index = 0; index < count; index += 1) {
    const relativePath = fixturePath(index);
    fs.writeFileSync(path.join(workspaceRoot, ...relativePath.split('/')), fixtureSource(index, 2), 'utf8');
    changed.push(relativePath);
  }
  return changed;
}

function fixturePath(index) {
  return `src/shard-${Math.floor(index / 1000)}/module-${index}.js`;
}

function fixtureSource(index, revision) {
  return `export function symbol${index}() { return ${index + revision}; }\n`;
}

function integerArg(name, fallback, min, max) {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function optionalPositiveNumberArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function rounded(value) {
  return Number(Number(value).toFixed(2));
}
