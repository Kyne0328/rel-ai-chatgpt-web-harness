import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { relaiExec } from '../src/bridge/exec.js';
import { flushLocalAnalytics } from '../src/localAnalytics.ts';
import { runProcess } from '../src/process.js';
import { gitStatusArgs, INTERNAL_STATUS_MAX_BYTES } from '../src/repo/gitStatus.js';
import { callTool as rawCallTool } from '../src/tools.js';
import { resetToolActivity } from '../src/toolActivity.js';

const samples = Math.max(1, Math.min(30, Number.parseInt(process.argv.find(arg => arg.startsWith('--samples='))?.split('=')[1] || '7', 10) || 7));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-exec-phase-benchmark-'));
const workspacePath = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const workspace = { alias: 'bench', path: workspacePath, commands: {}, testCommands: {} };
const config = {
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  maxOutputBytes: 1024 * 1024,
  patch: { backup: false, requireCleanGit: false },
  workspaces: { bench: workspace }
};
const command = 'node -e "void 0"';

try {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.writeFileSync(path.join(workspacePath, 'README.md'), '# benchmark\n');
  execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
  execFileSync('git', ['config', 'user.name', 'RelAI Benchmark'], { cwd: workspacePath });
  execFileSync('git', ['add', '.'], { cwd: workspacePath });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspacePath, stdio: 'ignore' });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  process.env.REL_AI_MCP_CONFIG = configPath;
  resetToolActivity();

  const context = { principal: 'local:trusted', publicHttpOnly: true, transportType: 'benchmark' };
  const beginStart = performance.now();
  const task = await rawCallTool('relai_work', { action: 'begin', workspace: 'bench', bootstrap: 'compact' }, context);
  const beginWallMs = performance.now() - beginStart;
  const beginResponseBytes = Buffer.byteLength(JSON.stringify(task), 'utf8');
  const workId = task.work_id;

  // Warm shell resolution, module caches, task state, and Git process lookup before sampling.
  await relaiExec(workspace, config, { command });
  await rawCallTool('relai_exec', { workspace: 'bench', work_id: workId, command }, context);

  const rows = [];
  for (let index = 0; index < samples; index += 1) {
    const statusStart = performance.now();
    const status = await runProcess('git', gitStatusArgs(), {
      cwd: workspacePath,
      timeout: 30000,
      maxOutputBytes: INTERNAL_STATUS_MAX_BYTES
    }, config);
    const statusMs = performance.now() - statusStart;
    if (status.exitCode !== 0) throw new Error(status.stderr || 'git status benchmark failed');

    const directStart = performance.now();
    const direct = await relaiExec(workspace, config, { command });
    const relaiExecWallMs = performance.now() - directStart;
    if (!direct.ok) throw new Error(direct.stderr || direct.error || 'direct relaiExec benchmark failed');

    const callStart = performance.now();
    const throughTool = await rawCallTool('relai_exec', { workspace: 'bench', work_id: workId, command }, context);
    const callToolWallMs = performance.now() - callStart;
    if (!throughTool.ok) throw new Error(throughTool.stderr || throughTool.error || 'callTool exec benchmark failed');

    let operationStart = performance.now();
    const read = await rawCallTool('relai_read', {
      workspace: 'bench', work_id: workId, paths: ['README.md'], guidanceMode: 'none'
    }, context);
    const readCallMs = performance.now() - operationStart;
    operationStart = performance.now();
    const search = await rawCallTool('relai_search', {
      action: 'text', workspace: 'bench', work_id: workId, pattern: 'benchmark', fixed: true, mode: 'compact', maxResults: 5
    }, context);
    const searchCallMs = performance.now() - operationStart;

    rows.push({
      statusMs,
      commandMs: Number(direct.durationMs || 0),
      relaiExecWallMs,
      callToolWallMs,
      executorOverheadMs: Math.max(0, relaiExecWallMs - Number(direct.durationMs || 0)),
      orchestrationOverheadMs: Math.max(0, callToolWallMs - relaiExecWallMs),
      readCallMs,
      searchCallMs,
      readResponseBytes: Buffer.byteLength(JSON.stringify(read), 'utf8'),
      searchResponseBytes: Buffer.byteLength(JSON.stringify(search), 'utf8')
    });
  }

  const medians = Object.fromEntries(Object.keys(rows[0]).map(key => [key, round(percentile(rows.map(row => row[key]), 0.5)) ]));
  const percentiles = Object.fromEntries(Object.keys(rows[0]).map(key => [key, {
    p50: round(percentile(rows.map(row => row[key]), 0.5)),
    p95: round(percentile(rows.map(row => row[key]), 0.95))
  }]));
  const result = {
    samples,
    environment: { platform: process.platform, node: process.version },
    workBegin: { wallMs: round(beginWallMs), responseBytes: beginResponseBytes },
    medians,
    percentiles,
    ranges: Object.fromEntries(Object.keys(rows[0]).map(key => {
      const values = rows.map(row => row[key]);
      return [key, { min: round(Math.min(...values)), max: round(Math.max(...values)) }];
    }))
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await flushLocalAnalytics();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true });
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}