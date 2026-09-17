import { spawnSync } from 'node:child_process';
import path from 'node:path';

const sizes = parseSizes(process.argv);
const mutations = integerArg('--mutations', 1, 1, 10000);
const maxScalingRatio = numberArg('--max-scaling-ratio', 8);
const benchmark = path.join('scripts', 'repository-intelligence-benchmark.mjs');
const reports = [];

for (const files of sizes) {
  const result = spawnSync(process.execPath, [benchmark, '--files', String(files), '--mutations', String(Math.min(files, mutations)), '--json'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Repository Intelligence benchmark failed for ${files} files:\n${result.stdout}\n${result.stderr}`);
  const report = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parseJsonLine).find(Boolean);
  if (!report) throw new Error(`Repository Intelligence benchmark returned no JSON report for ${files} files.`);
  if (report.incrementalScanMode !== 'incremental' || report.incrementalRefreshMs == null) {
    throw new Error(`Expected an incremental report for ${files} files.`);
  }
  reports.push(report);
}

const smallest = reports[0];
const largest = reports.at(-1);
const scalingRatio = Number(largest.incrementalRefreshMs) / Math.max(Number(smallest.incrementalRefreshMs), 0.001);
const output = { sizes, mutations, reports, scalingRatio: round(scalingRatio), maxScalingRatio, thresholdsPassed: scalingRatio <= maxScalingRatio };
console.log(JSON.stringify(output));
if (!output.thresholdsPassed) process.exitCode = 1;

function parseSizes(argv) {
  const index = argv.indexOf('--sizes');
  const raw = index >= 0 ? argv[index + 1] : '1000,10000';
  const values = String(raw || '').split(',').map(Number).filter(Number.isInteger);
  if (values.length < 2 || values.some(value => value < 1 || value > 500000)) {
    throw new Error('--sizes must contain at least two comma-separated integers from 1 to 500000.');
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function integerArg(name, fallback, min, max) {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function parseJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function round(value) { return Number(Number(value).toFixed(2)); }
