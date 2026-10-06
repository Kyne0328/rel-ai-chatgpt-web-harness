// Bounded, isolated benchmark: never scans or changes the developer's worktree.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runProcess } from '../src/process.js';
import { readGitStatus } from '../src/repo/gitClient.ts';
import { gitStatusArgs } from '../src/repo/gitStatus.ts';
import { readFilesystemStatusMap, changedFilesystemFiles } from '../src/bridge/exec.js';
import { createValidationFingerprint } from '../src/bridge/validationPlan.js';
import { buildGitBenchmarkLatencyBudgets } from '../test/helpers/git-benchmark-latency.mjs';
import { withGitProcessCounts } from '../test/helpers/git-process-counter.mjs';
import { callTool } from '../src/tools.js';
import { flushAuditWrites } from '../src/audit.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { GIT_EXECUTABLE } from '../test/helpers/git-executable.mjs';

const args = process.argv.slice(2);
const numberArg = (flag, fallback, min, max) => {
  const index = args.indexOf(flag);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(flag + ' must be between ' + min + ' and ' + max);
  return Math.floor(value);
};
const files = numberArg('--files', 1000, 100, 2000);
const repeats = numberArg('--repeats', 5, 3, 9);
const enforce = args.includes('--enforce');
const wrapperOverheadMs = numberArg('--wrapper-overhead-ms', 150, 0, 1000);
const workerIndex = args.indexOf('--worker-root');
if (workerIndex < 0) {
  // Windows may retain SQLite handles until process exit. Keep the fixture owned
  // by a supervising process so cleanup happens after every measured handle closes.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-git-accounting-benchmark-'));
  let code;
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args, '--worker-root', fixture], {
      stdio: 'inherit', windowsHide: true, timeout: 120000
    });
    if (child.error) throw child.error;
    code = child.status ?? 1;
  } finally {
    await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
  process.exit(code);
}
const root = path.resolve(args[workerIndex + 1] || '');
assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
assert.match(path.basename(root), /^relai-git-accounting-benchmark-/);
assert.deepEqual(fs.readdirSync(root), [], 'benchmark worker requires an empty parent-owned temporary fixture');
const repo = path.join(root, 'repo');
const plain = path.join(root, 'plain');
const stateDir = path.join(root, 'state');
const workspace = { alias: 'benchmark', path: repo };
const config = { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') };
fs.mkdirSync(repo);
fs.mkdirSync(plain);
const git = (...values) => execFileSync(GIT_EXECUTABLE, values, { cwd: repo, encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
const rawStatus = async () => {
  const value = await runProcess('git', gitStatusArgs(), { cwd: repo, timeout: 15000, maxOutputBytes: 8 * 1024 * 1024, preserveOutputWhitespace: true });
  assert.equal(value.exitCode, 0);
  assert.equal(value.stdoutTruncated, false);
  return value;
};
const samples = async (label, run) => {
  const times = [];
  for (let index = 0; index < repeats; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return { label, medianMs: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, p95Ms: Math.round(times.at(-1) * 10) / 10 };
};
const results = [];
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const configPath = path.join(root, 'config.json');
const context = { principal: 'local:trusted', publicHttpOnly: true };
let taskId = '';
let execCounts;
fs.writeFileSync(configPath, JSON.stringify({
  version: 2, ...config,
  workspaces: { benchmark: { path: repo, commands: {}, testCommands: {} } }
}));
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  git('init', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored/\n');
  for (let index = 0; index < files; index += 1) {
    fs.writeFileSync(path.join(repo, 'src', 'file-' + index + '.txt'), 'tracked ' + index + '\n');
    fs.writeFileSync(path.join(plain, 'plain-' + index + '.txt'), 'plain ' + index + '\n');
  }
  git('add', '.');
  git('-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.test', 'commit', '-m', 'fixture');
  await rawStatus();
  results.push(await samples('clean raw porcelain v1', rawStatus));
  results.push(await samples('clean v2 entries + HEAD', () => readGitStatus(repo)));

  fs.mkdirSync(path.join(repo, 'ignored'));
  for (let index = 0; index < files; index += 1) {
    const dir = path.join(repo, 'untracked', 'group-' + (index % 20));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file-' + index + '.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repo, 'ignored', 'file-' + index + '.txt'), 'ignored input\n');
    if (index % 10 === 0) fs.appendFileSync(path.join(repo, 'src', 'file-' + index + '.txt'), 'dirty\n');
  }
  git('mv', 'src/file-1.txt', 'src/renamed café.txt');
  results.push(await samples('dirty raw porcelain v1', rawStatus));
  const expectedEntries = Math.ceil(files / 10) + 2;
  results.push(await samples('dirty v2 entries + HEAD', async () => {
    const value = await readGitStatus(repo);
    assert.equal(value.entries.length, expectedEntries);
    assert.ok(value.entries.some(entry => entry.path === 'untracked/' && entry.opaqueDirectory), 'normal summaries collapse the untracked tree');
    assert.ok(value.entries.some(entry => entry.originalPath === 'src/file-1.txt'));
    assert.equal(value.entries.some(entry => entry.path.startsWith('ignored/')), false);
  }));

  const { counts: fingerprintCounts } = await withGitProcessCounts(() =>
    createValidationFingerprint(workspace, config, { paths: ['src/file-0.txt'] }));
  const statusCalls = fingerprintCounts.status;
  const headCalls = fingerprintCounts.head;
  assert.equal(statusCalls, 1, 'one operation-local status snapshot supplies HEAD');
  assert.equal(headCalls, 0, 'no redundant HEAD subprocess');

  results.push(await samples('nonGit full filesystem snapshot', async () => {
    const value = await readFilesystemStatusMap({ path: plain });
    assert.equal(value.fileCount, files);
    assert.equal(value.complete, true);
  }));
  const full = await readFilesystemStatusMap({ path: plain });
  const bounded = await readFilesystemStatusMap({ path: plain }, undefined, { maxEntries: 128 });
  assert.equal(bounded.entryCount, 128);
  assert.ok(bounded.reasons.includes('entry-limit'));
  assert.equal(bounded.complete, false);
  assert.deepEqual(changedFilesystemFiles(full, bounded).files, []);
  const directories = path.join(root, 'empty-directories');
  fs.mkdirSync(directories);
  for (let index = 0; index < 300; index += 1) fs.mkdirSync(path.join(directories, 'dir-' + index));
  const directoryBound = await readFilesystemStatusMap({ path: directories }, undefined, { maxEntries: 128 });
  assert.equal(directoryBound.entryCount, 128);
  assert.equal(directoryBound.fileCount, 0);
  assert.ok(directoryBound.reasons.includes('entry-limit'));

  const task = await callTool('relai_work', {
    action: 'begin', workspace: 'benchmark', title: 'Measure isolated Git overhead',
    steps: [{ title: 'Measure fixture commands', status: 'in_progress' }], bootstrap: 'none'
  }, context);
  taskId = task.work_id;
  const rawSpawn = () => runProcess(process.execPath, ['--version'], { cwd: repo, timeout: 15000 });
  const rawSpawnTiming = await samples('raw node version spawn', rawSpawn);
  results.push(rawSpawnTiming);
  const readOnlyCounted = await withGitProcessCounts(async () => {
    results.push(await samples('full wrapper read-only exec', async () => {
      const value = await callTool('relai_exec', {
        work_id: taskId, executable: process.execPath, argv: ['--version'], timeoutMs: 15000
      }, context);
      assert.equal(value.commandSucceeded, true);
    }));
  });
  assert.equal(readOnlyCounted.counts.status, 0, 'proven read-only exec performs zero Git scans');
  assert.equal(readOnlyCounted.counts.head, 0);
  const tinyMutation = () => callTool('relai_exec', {
    work_id: taskId, executable: process.execPath,
    argv: ['-e', "require('node:fs').appendFileSync('src/file-0.txt', 'mutation\\n')"], timeoutMs: 15000
  }, context);
  const firstMutation = await withGitProcessCounts(tinyMutation);
  assert.equal(firstMutation.result.commandSucceeded, true);
  assert.deepEqual(firstMutation.result.changedFiles, ['src/file-0.txt']);
  assert.ok(firstMutation.counts.status <= 3, 'first exec reuses its baseline snapshot');
  const warmMutations = await withGitProcessCounts(async () => {
    results.push(await samples('full wrapper warm mutating exec', async () => {
      const value = await tinyMutation();
      assert.equal(value.commandSucceeded, true);
      assert.deepEqual(value.changedFiles, ['src/file-0.txt']);
    }));
  });
  assert.equal(warmMutations.counts.status, repeats * 2, 'warm mutating exec uses fresh pre/post status only');
  execCounts = {
    readOnly: readOnlyCounted.counts, firstMutation: firstMutation.counts, warmMutations: warmMutations.counts,
    firstMutationPhases: (firstMutation.result.timeline?.phases || []).map(({ phase, durationMs }) => ({ phase, durationMs }))
  };
  const readOnlyTiming = results.find(item => item.label === 'full wrapper read-only exec');
  const mutationTiming = results.find(item => item.label === 'full wrapper warm mutating exec');
  const latencyBudgets = buildGitBenchmarkLatencyBudgets({
    cleanRawMs: results[0].medianMs, cleanV2Ms: results[1].medianMs,
    dirtyRawMs: results[2].medianMs, dirtyV2Ms: results[3].medianMs,
    rawSpawnMs: rawSpawnTiming.medianMs, readOnlyMs: readOnlyTiming.medianMs,
    mutatingMs: mutationTiming.medianMs
  }, wrapperOverheadMs);

  console.log(JSON.stringify({
    fixture: { trackedFiles: files, untrackedFiles: files, ignoredFiles: files, nonGitFiles: files, emptyDirectories: 300 },
    repeats, enforce, wrapperOverheadMs, latencyBudgets,
    calibration: {
      basis: 'Two initial Windows runs informed these component-relative limits; broader CI calibration is not established.',
      crossPlatformCalibrated: false
    },
    execCounts, statusCallsPerFingerprint: statusCalls, headCallsPerFingerprint: headCalls,
    boundedFilesystem: { entryCount: bounded.entryCount, reasons: bounded.reasons },
    boundedDirectories: { entryCount: directoryBound.entryCount, reasons: directoryBound.reasons },
    rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024), results
  }, null, 2));
  if (enforce) {
    const failures = latencyBudgets.filter(item => !item.passed);
    assert.equal(failures.length, 0, 'Component latency budgets failed: ' + JSON.stringify(failures));
  }
} finally {
  if (taskId) await callTool('relai_work', {
    action: 'cancel', work_id: taskId, reason: 'Isolated benchmark completed.'
  }, context).catch(() => {});
  await flushAuditWrites();
  await repositoryIntelligence.shutdown();
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
}
