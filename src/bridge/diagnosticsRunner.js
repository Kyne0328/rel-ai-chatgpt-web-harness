
import * as path from 'node:path';
import { runProcess, summarizeCommand } from '../process.js';
import { detectVerifyChecks } from './checkDetection.js';
import { clampNumber } from './limits.js';
import { runSpan } from '../telemetry.js';
import { nativeToolTaskSignal } from '../mcp/nativeToolTasks.js';
import { combineAbortSignals } from '../abortSignals.js';
import { resolveOneShotTimeoutMs } from '../executionControl.js';
import { getCurrentTaskAbortSignal, updateCurrentToolActivity } from '../toolActivity.js';
import { sanitizeDisplayText } from '../taskObservability.js';
import { parallel, runPlan, sequence, step } from '../executionPlan.js';
import { recordExecutionPlanMetrics } from '../executionObservability.js';
import { buildCheckExecutionStages } from '../workflow/checkExecution.js';
import { buildCheckCatalog } from '../workflow/checkCatalog.js';
import { discoverRepositoryTopology } from '../workflow/topology.js';
async function relaiDiagnosticsRun(workspace, config, args = {}, context = {}) {
  const commands = selectDiagnosticCommands(workspace, args);
  if (!commands.length) {
    return { ok: false, workspace: workspace.alias, commands: [], diagnostics: [], message: 'No diagnostic command was detected. Pass command or configure lint/typecheck/analyze/vet/clippy checks.' };
  }
  const timeout = resolveOneShotTimeoutMs(args, context, { minMs: 1000, maxMs: 24 * 60 * 60 * 1000, fallbackMs: 180000 });
  const indexedResults = new Array(commands.length);
  const diagnosticsByIndex = new Array(commands.length);
  const signal = combineAbortSignals(
    getCurrentTaskAbortSignal(),
    args._operationTaskId ? nativeToolTaskSignal(args._operationTaskId) : undefined,
    context.signal
  );
  const stopOnFailure = args.stopOnFailure !== false;
  const catalog = buildCheckCatalog(discoverRepositoryTopology(workspace.path));
  const units = commands.map(command => catalog.find(item => item.command === command) || { command, scopeKey: 'repository' });
  const executionStages = buildCheckExecutionStages(units);
  const visibleResults = () => indexedResults.filter(Boolean);
  const activeDiagnostics = new Map();
  const activeDiagnosticNames = () => [...activeDiagnostics.values()];

  publishDiagnosticsProgress(commands, [], '', 0, 'pending', false, []);
  const planStages = executionStages.map(stage => {
    const nodes = stage.items.map(({ unit, index, policy }) => step(
      `diagnostic ${index + 1}`,
      async () => {
        const command = unit.command;
        const displayCommand = sanitizeDisplayText(command, 120) || `Diagnostic ${index + 1}`;
        activeDiagnostics.set(index, displayCommand);
        publishDiagnosticsProgress(commands, visibleResults(), command, index + 1, 'running', false, activeDiagnosticNames());
        let result;
        try {
          result = await runSpan(config, 'relai.validation.diagnostics', {
          'relai.workspace': workspace.alias,
          'relai.diagnostics.command': command.slice(0, 300),
          'relai.diagnostics.parallel_safe': policy.parallelSafe === true,
          'relai.diagnostics.kind': policy.kind
        }, () => runProcess(command, [], {
          cwd: path.resolve(workspace.path, unit.cwd || '.'),
          shell: true,
          commandString: command,
          timeout,
          maxOutputBytes: Math.min(Number(args._transportMaxOutputBytes) || 8 * 1024 * 1024, 8 * 1024 * 1024),
          signal,
          resourceClass: 'heavy',
          resourceOwner: workspace.alias
        }, config));
        } finally {
          activeDiagnostics.delete(index);
        }
        const summary = summarizeCommand(result);
        const parsed = parseDiagnostics(`${result.stdout || ''}\n${result.stderr || ''}`, command, workspace.path);
        const item = { command, ...summary, diagnostics: parsed.length };
        indexedResults[index] = item;
        diagnosticsByIndex[index] = parsed;
        publishDiagnosticsProgress(commands, visibleResults(), command, index + 1, result.cancelled ? 'cancelled' : result.ok ? 'passed' : (result.timedOut || result.queueTimedOut) ? 'timed_out' : 'failed', false, activeDiagnosticNames());
        return item;
      },
      {
        isSuccess: value => value?.ok === true,
        metadata: {
          index,
          kind: policy.kind,
          parallelSafe: policy.parallelSafe,
          resourceKey: policy.resourceKey,
          displayName: sanitizeDisplayText(unit.command, 120)
        }
      }
    ));
    return stage.parallel
      ? parallel(nodes, { maxConcurrency: 3, stopOnFailure })
      : sequence(nodes, { stopOnFailure });
  });
  const execution = await runPlan(sequence(planStages, { stopOnFailure }), { signal });
  recordExecutionPlanMetrics('diagnostics', execution.metrics);
  const results = visibleResults();
  const diagnostics = diagnosticsByIndex.filter(Boolean).flat();
  const unique = deduplicateDiagnostics(diagnostics).slice(0, clampNumber(args.maxResults, 1, 5000, 500));
  const cancelled = signal?.aborted === true || results.some(item => item.cancelled === true);
  const ok = !cancelled && results.length === commands.length && results.every(item => item.ok);
  publishDiagnosticsProgress(commands, results, results.at(-1)?.command || '', Math.min(results.length, commands.length), cancelled ? 'cancelled' : ok ? 'passed' : 'failed', true, []);
  return {
    ok,
    workspace: workspace.alias,
    commands,
    results,
    diagnostics: unique,
    diagnosticCount: diagnostics.length,
    completedUnits: results.filter(item => item.cancelled !== true).length,
    totalUnits: commands.length,
    execution: execution.metrics,
    cancelled,
    truncated: diagnostics.length > unique.length
  };
}

function publishDiagnosticsProgress(commands, results, currentCommand, currentIndex, resultStatus, final = false, activeCommands = []) {
  const total = commands.length;
  const completed = results.filter(item => item.cancelled !== true).length;
  const current = sanitizeDisplayText(currentCommand, 300);
  const failed = results.filter(item => !item.ok && !item.cancelled).length;
  const running = [...new Set(activeCommands.map(value => sanitizeDisplayText(value, 120)).filter(Boolean))].slice(0, 3);
  const active = running.length;
  const pending = Math.max(0, total - completed - active);
  const stage = resultStatus === 'cancelled'
    ? 'Diagnostics cancelled'
    : resultStatus === 'failed' || resultStatus === 'timed_out'
      ? 'Diagnostics failed'
      : final && resultStatus === 'passed'
        ? 'Diagnostics completed'
        : active > 1
          ? `${active} diagnostics running in parallel`
          : active === 1
            ? 'Running diagnostic'
            : currentIndex > 0
              ? `Running diagnostic ${currentIndex} of ${total}`
              : 'Preparing diagnostics';
  const activity = active > 1
    ? `${active} diagnostics running: ${running.join(', ')}`
    : active === 1
      ? `Running ${running[0]}`
      : current || `${completed} of ${total} diagnostics completed`;
  updateCurrentToolActivity({
    status: 'validating',
    operation: currentIndex > 0 ? `Running diagnostic ${currentIndex}/${total}: ${current || 'check'}` : `Preparing ${total} diagnostic commands`,
    currentStage: stage,
    currentActivity: activity,
    progress: {
      mode: 'determinate',
      completedUnits: completed,
      totalUnits: total,
      percentage: final && resultStatus !== 'passed' && completed === total ? 99 : Math.round((completed / total) * 100),
      source: 'diagnostics',
      label: `${completed} of ${total} diagnostics`
    },
    activity: {
      category: 'validation',
      status: 'running',
      title: 'Run normalized diagnostics',
      summary: activity,
      metadata: {
        checkCount: total,
        passedCount: results.filter(item => item.ok).length,
        failedCount: failed,
        currentCheck: current,
        currentIndex,
        resultStatus,
        cancelled: resultStatus === 'cancelled',
        parallelActiveCount: active,
        completedCount: completed,
        pendingCount: pending,
        running
      }
    }
  });
}

function selectDiagnosticCommands(workspace, args) {
  const explicit = [];
  if (typeof args.command === 'string' && args.command.trim()) explicit.push(args.command.trim());
  if (Array.isArray(args.commands)) explicit.push(...args.commands.map(String).map(item => item.trim()).filter(Boolean));
  if (explicit.length) return [...new Set(explicit)];
  const candidates = detectVerifyChecks(workspace.path, String(args.level || 'quick'));
  const diagnostic = candidates.filter(command => /(?:typecheck|tsc|eslint|lint|analy[sz]e|mypy|pyright|ruff|vet|clippy|doctor|check)/i.test(command));
  return diagnostic.length ? diagnostic : candidates.slice(0, 2);
}

function parseDiagnostics(output, command, workspaceRoot) {
  const source = diagnosticSource(command);
  const diagnostics = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseDiagnosticLine(line);
    if (!parsed) continue;
    diagnostics.push({
      path: normalizeDiagnosticPath(parsed.path, workspaceRoot),
      line: parsed.line,
      column: parsed.column,
      severity: parsed.severity,
      code: parsed.code,
      message: parsed.message.slice(0, 2000),
      source
    });
  }
  return diagnostics;
}

function parseDiagnosticLine(line) {
  let match = /^(.*?)[(:](\d+)[,:](\d+)\)?\s*[-:]\s*(error|warning|warn|info)?\s*([A-Za-z]+\d+)?\s*[:-]?\s*(.+)$/i.exec(line);
  if (match) return { path: match[1], line: Number(match[2]), column: Number(match[3]), severity: normalizeSeverity(match[4]), code: match[5] || '', message: match[6] };
  match = /^(.*?):(\d+):(\d+):\s*(error|warning|note|info):\s*(.+?)(?:\s+\[([^\]]+)\])?$/i.exec(line);
  if (match) return { path: match[1], line: Number(match[2]), column: Number(match[3]), severity: normalizeSeverity(match[4]), code: match[6] || '', message: match[5] };
  match = /^(.+?):(\d+):(\d+)\s+([A-Z]\d+)\s+(.+)$/.exec(line);
  if (match) return { path: match[1], line: Number(match[2]), column: Number(match[3]), severity: 'error', code: match[4], message: match[5] };
  return null;
}

function normalizeDiagnosticPath(value, root) {
  const text = String(value || '').trim().replace(/^['"]|['"]$/g, '');
  if (!text) return '';
  if (path.isAbsolute(text)) return path.relative(root, text).replaceAll(path.sep, '/');
  return text.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeSeverity(value) {
  const text = String(value || 'error').toLowerCase();
  if (text === 'warn') return 'warning';
  if (text === 'note') return 'info';
  return ['error', 'warning', 'info'].includes(text) ? text : 'error';
}

function diagnosticSource(command) {
  const text = String(command).toLowerCase();
  for (const source of ['typescript', 'eslint', 'mypy', 'pyright', 'ruff', 'dart', 'flutter', 'clippy', 'cargo', 'go', 'javac', 'gradle']) {
    if (text.includes(source)) return source;
  }
  if (text.includes('tsc')) return 'typescript';
  if (text.includes('analyze')) return 'analyzer';
  return 'command';
}

function deduplicateDiagnostics(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.path}:${item.line}:${item.column}:${item.code}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { relaiDiagnosticsRun,    };