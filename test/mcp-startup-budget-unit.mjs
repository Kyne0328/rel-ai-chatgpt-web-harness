import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { startMcpClient } from './helpers/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-startup-budget-'));
const configPath = path.join(temp, 'config.json');
// Cold discovery includes OS process creation. Windows process startup has materially
// higher variance than POSIX hosts, so keep a platform-specific ceiling while the
// warm in-process tools/list budget remains strict and platform-independent.
const defaultColdBudgetMs = process.platform === 'win32' ? 3500 : 1500;
const coldBudgetMs = Number(process.env.REL_AI_MCP_COLD_START_BUDGET_MS || defaultColdBudgetMs);
const firstListBudgetMs = Number(process.env.REL_AI_MCP_FIRST_LIST_BUDGET_MS || (process.platform === 'win32' ? 1000 : 500));
const warmListBudgetMs = Number(process.env.REL_AI_MCP_WARM_LIST_BUDGET_MS || 20);
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir: path.join(temp, 'state'),
  workspaces: { repo: { path: root } }
}, null, 2));

const cold = [];
const firstList = [];
const warm = [];
try {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const client = startMcpClient({ root, configPath, timeoutMs: 15_000 });
    try {
      let started = performance.now();
      client.initialize(1);
      await client.waitFor(1);
      cold.push(performance.now() - started);

      started = performance.now();
      client.send(2, 'tools/list');
      await client.waitFor(2);
      firstList.push(performance.now() - started);

      for (let sample = 0; sample < 3; sample += 1) {
        started = performance.now();
        client.send(10 + sample, 'tools/list');
        await client.waitFor(10 + sample);
        warm.push(performance.now() - started);
      }
    } finally {
      await client.close();
    }
  }

  const coldMedian = median(cold);
  const firstListMedian = median(firstList);
  const warmMedian = median(warm);
  const report = {
    coldDiscoverMs: summarize(cold),
    firstToolsListMs: summarize(firstList),
    warmToolsListMs: summarize(warm),
    budgets: { coldBudgetMs, firstListBudgetMs, warmListBudgetMs }
  };
  console.log(JSON.stringify(report));
  assert.ok(coldMedian <= coldBudgetMs, `cold discovery median ${coldMedian.toFixed(2)}ms exceeds ${coldBudgetMs}ms`);
  assert.ok(firstListMedian <= firstListBudgetMs, `first tools/list median ${firstListMedian.toFixed(2)}ms exceeds ${firstListBudgetMs}ms`);
  assert.ok(warmMedian <= warmListBudgetMs, `warm tools/list median ${warmMedian.toFixed(2)}ms exceeds ${warmListBudgetMs}ms`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(values) {
  return {
    samples: values.length,
    min: round(Math.min(...values)),
    median: round(median(values)),
    max: round(Math.max(...values)),
    mean: round(values.reduce((total, value) => total + value, 0) / values.length)
  };
}

function round(value) { return Number(value.toFixed(2)); }
