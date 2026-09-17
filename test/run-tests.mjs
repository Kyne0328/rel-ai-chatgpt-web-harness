// Runs the everyday behavior and safety regression suite. Release-only workflow,
// packaging-policy, browser, and implementation-shape checks remain available through
// named npm scripts or direct `node test/<file>` runs instead of blocking every change.
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(testDir, '..');

const files = [
  'repository-staleness-unit.mjs',
  'intelligence-audit-regressions-unit.mjs',
  'tunnel-credentials-unit.mjs',
  'connection-profile-clear-unit.mjs',
  'secure-tunnel-runtime-unit.mjs',
  'tunnel-recovery-supervisor-unit.mjs',
  'service-runtime-lifecycle-unit.mjs',
  'core-runtime-boundary-unit.mjs',
  'desktop-ui-smoke.mjs',
  'competing-ownership-unit.mjs',
  'toast-unit.mjs',
  'secure-tunnel-packaging-contract-unit.mjs',
  'authorization-policy-unit.mjs',
  'workspace-recovery-unit.mjs',
  'approval-broker-unit.mjs',
  'connector-result-contract-unit.mjs',
  'connector-read-result-unit.mjs',
  'repeat-call-guard-unit.mjs',
  'desktop-lifecycle-unit.mjs',
  'desktop-manager-unit.mjs',
  'electron-desktop-os-operations-unit.mjs',
  'desktop-local-data-unit.mjs',
  'desktop-settings-unit.mjs',
  'dashboard-session-unit.mjs',
  'dashboard-window-unit.mjs',
  'dashboard-events-visibility-unit.mjs',
  'dashboard-health-status-unit.mjs',
  'dashboard-live-events-smoke.mjs',
  'dashboard-react-store-unit.mjs',
  'dashboard-clock-unit.mjs',
  'dashboard-event-batcher-unit.mjs',
  'durable-state-unit.mjs',
  'state-backup-unit.mjs',
  'packaged-runtime-dependencies-unit.mjs',
  'durable-state-database-unit.mjs',
  'electron-updater-config-unit.mjs',
  'app-updater-unit.mjs',
  'update-install-marker-unit.mjs',
  'app-identity-unit.mjs',
  'update-support-policy-unit.mjs',
  'update-support-policy-http-unit.mjs',
  'connector-refresh-modal-unit.mjs',
  'electron-dynamic-resource-contract-unit.mjs',
  'electron-product-path-unit.mjs',
  'electron-dev-watch-unit.mjs',
  'test-rigidity-audit-unit.mjs',
  'audit-production-unit.mjs',
  'color-token-staleness-unit.mjs',
  'generated-assets-check-unit.mjs',
  'build-provenance-unit.mjs',
  'http-auth-smoke.mjs',
  'mcp-app-ui-unit.mjs',
  'search-filesystem-fallback-unit.mjs',
  'stdio-shutdown-persistence-unit.mjs',
  'http-smoke.mjs',
  'ipc-security-unit.mjs',
  'package-size-policy-unit.mjs',
  'safety-paths.mjs',
  'smoke.mjs',
  'task-state-unit.mjs',
  'task-semantic-progress-unit.mjs',
  'task-history-storage-unit.mjs',
  'task-history-live-unit.mjs',
  'task-history-store-unit.mjs',
  'task-retrieval-quality-unit.mjs',
  'task-observability-integration.mjs',
  'task-trace-unit.mjs',
  'task-integrity-unit.mjs',
  'multi-chat-task-isolation-unit.mjs',
  'task-code-workspace-unit.mjs',
  'task-code-ide-unit.mjs',
  'task-completion-unit.mjs',
  'task-reconciliation-unit.mjs',
  'atomic-validation-race-unit.mjs',
  'workspace-operation-queue-unit.mjs',
  'host-resource-scheduler-unit.mjs',
  'workspace-multi-source-runtime-unit.mjs',
  'intelligence-runtime-unit.mjs',
  'repository-architecture-unit.mjs',
  'intelligence-lsp-unit.mjs',
  'lsp-client-unit.mjs',
  'branch-concurrency-unit.mjs',
  'task-ownership-concurrency-unit.mjs',
  'process-manager-unit.mjs',
  'workflow-process-reuse-unit.mjs',
  'process-pty-unit.mjs',
  'review-checkpoints-unit.mjs',
  'skill-discovery-unit.mjs',
  'knowledge-continuity-unit.mjs',
  'route-policy-unit.mjs',
  'context/session-compaction-unit.mjs',
  'artifact-intake-unit.mjs',
  'artifact-resource-unit.mjs',
  'baseline-tracking-unit.mjs',
  'workspace-tidy-unit.mjs',
  'unborn-workspace-unit.mjs',
  'validation-task-scope-unit.mjs',
  'edit-run-checks-completion-unit.mjs',
  'edit-recovery-unit.mjs',
  'exec-dirty-mutation-unit.mjs',
  'exec-tool-unit.mjs',
  'budget-multiplier-unit.mjs',
  'deferred-operation-unit.mjs',
  'abortable-promise-unit.mjs',
  'search-tool-unit.mjs',
  'validation-strategy-unit.mjs',
  'output-spill-unit.mjs',
  'tool-failure-accounting-unit.mjs',
  'tool-action-contract-unit.mjs',
  'tool-output-validation-unit.mjs',
  'tool-behavior-evaluator-unit.mjs',
  'context/tool-discovery-budget-unit.mjs',
  'plugin-metadata-unit.mjs',
  'analytics-taxonomy-unit.mjs',
  'local-analytics-unit.mjs',
  'analytics-reliability-unit.mjs',
  'tasks-telemetry-unit.mjs',
  'usage-ui-contract-unit.mjs',
  'repo-health.mjs',
  'computer-manager-unit.mjs',
  'computer-observation-unit.mjs',
  'windows-uia-adapter-unit.mjs',
  'midscene-computer-adapter-unit.mjs',
  'web-automation-contract-unit.mjs',
  'browser-ui-bounds-unit.mjs',
  'window-security-unit.mjs'
];

const serialFiles = new Set([
  'artifact-resource-unit.mjs',
  'http-auth-smoke.mjs',
  'http-smoke.mjs',
  'smoke.mjs',
  'generated-assets-check-unit.mjs',
  'process-manager-unit.mjs',
  'workflow-process-reuse-unit.mjs',
  'process-pty-unit.mjs',
  'stdio-shutdown-persistence-unit.mjs'
]);
const parallelEntries = files
  .map((name, index) => ({ name, index }))
  .filter(({ name }) => !serialFiles.has(name));
const serialEntries = files
  .map((name, index) => ({ name, index }))
  .filter(({ name }) => serialFiles.has(name));
const requestedJobs = Number.parseInt(process.env.REL_AI_TEST_JOBS || '', 10);
const availableJobs = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
const jobCount = Math.min(parallelEntries.length, Number.isFinite(requestedJobs) && requestedJobs > 0 ? requestedJobs : Math.min(4, availableJobs));
const suiteStarted = Date.now();
const results = new Array(files.length);
let nextIndex = 0;

await Promise.all(Array.from({ length: jobCount }, async () => {
  while (true) {
    const queueIndex = nextIndex;
    nextIndex += 1;
    if (queueIndex >= parallelEntries.length) return;
    await runEntry(parallelEntries[queueIndex]);
  }
}));
for (const entry of serialEntries) await runEntry(entry);

async function runEntry({ name, index }) {
  const started = Date.now();
  console.log(`RUN ${name}`);
  const result = await runTest(name);
  const durationMs = Date.now() - started;
  results[index] = { name, durationMs, ...result };
  const seconds = (durationMs / 1000).toFixed(1);
  if (result.exitCode === 0) {
    console.log(`PASS ${name} (${seconds}s)`);
  } else {
    console.error(`FAIL ${name} (${seconds}s)`);
    if (result.error) console.error(result.error.message);
    if (result.stdout) console.error(result.stdout.trim());
    if (result.stderr) console.error(result.stderr.trim());
  }
}

const failures = results.filter(result => result.exitCode !== 0);

function runTest(name) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(testDir, name)], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5 * 60 * 1000
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: '', error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let error = null;
    let settled = false;
    const finish = exitCode => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr, error });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', value => { error = value; });
    child.once('close', finish);
  });
}

const suiteSeconds = ((Date.now() - suiteStarted) / 1000).toFixed(1);
const slowest = [...results]
  .sort((left, right) => right.durationMs - left.durationMs)
  .slice(0, Math.min(5, results.length))
  .map(result => `${result.name} ${(result.durationMs / 1000).toFixed(1)}s`)
  .join(', ');
console.log(`\n${files.length - failures.length}/${files.length} test files passed in ${suiteSeconds}s with ${jobCount} worker${jobCount === 1 ? '' : 's'}.`);
if (slowest) console.log(`Slowest: ${slowest}`);
if (failures.length) {
  console.error(`Failed: ${failures.map(result => result.name).join(', ')}`);
  process.exit(1);
}
