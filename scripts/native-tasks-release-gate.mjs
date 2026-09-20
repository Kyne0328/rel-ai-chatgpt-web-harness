import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

const RELEASE_GATE_CHECKS = Object.freeze([
  check('capability_policy', 'MCP capability, transport, strict-protocol, and tool-surface contracts', 'test/suite-mcp-tools-unit.mjs'),
  check('task_lifecycle', 'Native task lifecycle, persistence, authorization, expiry, and redaction', 'test/native-task-service-unit.mjs'),
  check('task_protocol', 'Native task protocol and core runtime contracts', 'test/suite-runtime-core-unit.mjs'),
  check('work_session_isolation', 'Principal-bound repository work-session ownership', 'test/work-session-principal-isolation-unit.mjs'),
  check('http_matrix', 'HTTP capability matrix and synchronous task-protocol lifecycle', 'test/native-tasks-http.mjs'),
  check('process_lifecycle', 'Persistent-process independence, ownership, restart, and bounded logs', 'test/process-manager-unit.mjs'),
  check('process_cancellation', 'Finite-process cancellation and process-tree cleanup', 'test/process-cancellation-unit.mjs'),
  check('dashboard_contract', 'Dashboard capability, task, process, rendering, and state contracts', 'test/suite-dashboard-ui-unit.mjs'),
  check('stdio_discovery', 'stdio discovery and public tool surface', 'test/smoke.mjs'),
  check('http_discovery', 'HTTP discovery and native Tasks advertisement', 'test/http-smoke.mjs'),
  check('http_authentication', 'HTTP authentication and stateless ChatGPT initialization', 'test/http-auth-smoke.mjs'),
  check('current_surface_without_tasks', 'Current tool surface remains synchronous without Tasks capability', 'test/chatgpt-local-hard-cutover-smoke.mjs')
]);

const SERIAL_RELEASE_GATE_CHECK_IDS = Object.freeze([
  'http_matrix',
  'process_lifecycle',
  'process_cancellation',
  'stdio_discovery',
  'http_discovery',
  'http_authentication',
  'current_surface_without_tasks'
]);
const SERIAL_CHECK_IDS = new Set(SERIAL_RELEASE_GATE_CHECK_IDS);

const RELEASE_GATE_BLOCKERS = Object.freeze([
  'tasks_returned_without_negotiation',
  'malformed_capability_fallback',
  'chatgpt_initialize_rejected',
  'task_notification_response',
  'missing_server_identity_metadata',
  'public_probe_registered',
  'obsolete_capability_error',
  'unauthorized_task_access',
  'unauthorized_work_session_access',
  'replayed_input_resumed_twice',
  'invalid_terminal_transition',
  'cancellation_without_process_cleanup',
  'unbounded_synchronous_execution',
  'persistent_process_lifecycle_regression'
]);

function check(id, label, file) {
  return Object.freeze({ id, label, file });
}

async function runReleaseGate(options = {}) {
  const jsonOnly = options.jsonOnly === true;
  const startedAt = new Date();
  const concurrency = resolveConcurrency(options.concurrency);
  const results = new Array(RELEASE_GATE_CHECKS.length);
  let nextIndex = 0;

  const parallelIndexes = RELEASE_GATE_CHECKS
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !SERIAL_CHECK_IDS.has(entry.id));
  const serialIndexes = RELEASE_GATE_CHECKS
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => SERIAL_CHECK_IDS.has(entry.id));

  if (!jsonOnly) console.log(`Running ${RELEASE_GATE_CHECKS.length} release checks with ${concurrency} workers; socket/process integration checks run serially.`);
  await Promise.all(Array.from({ length: Math.min(concurrency, parallelIndexes.length) }, async () => {
    while (true) {
      const queueIndex = nextIndex++;
      if (queueIndex >= parallelIndexes.length) return;
      const { entry, index } = parallelIndexes[queueIndex];
      results[index] = await runCheck(entry);
    }
  }));
  for (const { entry, index } of serialIndexes) {
    results[index] = await runCheck(entry);
  }

  if (!jsonOnly) {
    for (const result of results) printResult(result);
  }

  const failed = results.filter(result => result.status !== 'passed');
  const endedAt = new Date();
  const summary = {
    schemaVersion: 1,
    gate: 'native_mcp_tasks_source_release_gate',
    scope: 'source_and_runtime_contracts',
    status: failed.length === 0 ? 'passed' : 'failed',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    concurrency,
    blockerClasses: RELEASE_GATE_BLOCKERS,
    passedCount: results.length - failed.length,
    failedCount: failed.length,
    checks: results
  };
  console.log(JSON.stringify(summary));
  return summary;
}

async function runCheck(entry) {
  const absolute = path.join(root, entry.file);
  if (!fs.existsSync(absolute)) {
    return { ...entry, status: 'failed', durationMs: 0, exitCode: null, timedOut: false, error: 'required_test_missing' };
  }

  const started = Date.now();
  try {
    await execFileAsync(process.execPath, [absolute], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    return { ...entry, status: 'passed', durationMs: Date.now() - started, exitCode: 0, timedOut: false };
  } catch (error) {
    return {
      ...entry,
      status: 'failed',
      durationMs: Date.now() - started,
      exitCode: Number.isInteger(error?.code) ? error.code : null,
      timedOut: error?.killed === true && error?.signal === 'SIGTERM',
      error: error?.message || 'test_failed',
      stdoutTail: tail(error?.stdout),
      stderrTail: tail(error?.stderr)
    };
  }
}

function printResult(result) {
  const prefix = result.status === 'passed' ? 'PASS' : 'FAIL';
  console.log(`${prefix} ${result.id} (${result.durationMs}ms) - ${result.label}`);
  if (result.status === 'failed') {
    if (result.error === 'required_test_missing') console.error(`Required test is missing (${result.file})`);
    if (result.stdoutTail) console.error(result.stdoutTail);
    if (result.stderrTail) console.error(result.stderrTail);
  }
}

function resolveConcurrency(explicit) {
  const configured = Number(explicit ?? process.env.REL_AI_RELEASE_GATE_JOBS);
  if (Number.isSafeInteger(configured) && configured > 0) {
    return Math.min(configured, RELEASE_GATE_CHECKS.length);
  }
  const available = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(4, Math.max(1, available), RELEASE_GATE_CHECKS.length);
}

function tail(value, limit = 4000) {
  const text = String(value || '').trim();
  return text.length <= limit ? text : text.slice(-limit);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const summary = await runReleaseGate({ jsonOnly: process.argv.includes('--json') });
  if (summary.status !== 'passed') process.exitCode = 1;
}

export { RELEASE_GATE_BLOCKERS, RELEASE_GATE_CHECKS, SERIAL_RELEASE_GATE_CHECK_IDS, runReleaseGate };
