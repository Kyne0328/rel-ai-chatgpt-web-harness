import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FORBIDDEN_PUBLIC_NAMES = [
  'relai_begin_work', 'relai_repo_snapshot', 'relai_code_inspect',
  'relai_process_start', 'relai_process_read', 'relai_process_write', 'relai_process_stop', 'relai_process_list',
  'relai_semantic_search', 'relai_diagnostics_run', 'relai_run_checks', 'relai_http_probe',
  'relai_diff', 'relai_restore_paths', 'relai_reset_workspace', 'relai_status',
  'relai_git_commit', 'relai_git_push', 'relai_git_draft_pr',
  'relai_tidy_plan', 'relai_tidy_run', 'relai_cancel_work', 'relai_finish_work',
  'relai_worktree_create', 'relai_worktree_list', 'relai_worktree_remove'
];

const PUBLIC_GUIDANCE_FILES = [
  /^README\.md$/,
  /^RELEASE\.md$/,
  /^docs\/.*\.md$/,
  /^examples\/.*\.(?:json|md)$/,
  /^skills\/.*\.md$/,
  /^\.agents\/.*\.md$/
];

const IMMUTABLE_HISTORY = new Set(['CHANGELOG.md']);

const TARGETED_RUNTIME_GUIDANCE = new Set([
  'src/bridge/codeIntelligence.js', 'src/bridge/search.js', 'src/bridge/validation.js',
  'src/bridge/validationPlan.js', 'src/bridge/writeGuidance.js', 'src/localRepoBridge.js',
  'src/processManager.js', 'src/release.js', 'src/toolActivity.js', 'src/tools/actionDefinitions.js',
  'src/tools/completion.js', 'src/tools/task.js', 'src/ui/features/onboarding/index.js'
]);

const SOURCE_INVARIANTS = Object.freeze([
  ['src/tools/callTool.js', /assertRuntimeCompatibility/, 'no-op-runtime-compatibility-hot-path'],
  ['src/runtimeCompatibility.js', /function\s+assertRuntimeCompatibility\b/, 'no-op-runtime-compatibility-wrapper'],
  ['src/tools/connectorHelpers.js', /\b(?:deprecatedTool|replacementTool)\b|migration:\s*value\.migration/, 'removed-connector-compatibility-payload'],
  ['src/ui/features/tools/index.js', /CURRENT_TOOL_CAPABILITY|lifecycleRank|category\s*===\s*['"]Compatibility['"]/, 'removed-tool-ui-compatibility-fallback'],
  ['src/repo/gitStatus.js', /parseLegacyStatus/, 'removed-line-oriented-git-status-parser'],
  ['src/bridge/checkDetection.js', /legacy:root|source:\s*['"]legacy['"]/, 'removed-validation-legacy-label'],
  ['src/policyResolver.js', /legacySessionFilePath|legacy_session_file/, 'removed-unscoped-session-policy'],
  ['src/ui/features/system/styles.css', /cloud-(?:gateway|pairing|device|recovery)|direct-connection-controls|approval-token-value/, 'removed-connection-ui-style'],
  ['src/ui/features/settings/styles.css', /approval-token|connection-auth-recovery/, 'removed-approval-ui-style'],
  ['src/ui/styles/app.css', /approval-token-replacement|connection-auth-recovery/, 'removed-approval-ui-style'],
  ['types/boundaries.d.ts', /ToolLifecycleMetadata|lifecycle\?:\s*ToolLifecycleMetadata/, 'removed-tool-lifecycle-type'],
  ['scripts/electron-size-baseline.json', /"electronVersion"\s*:/, 'decorative-package-baseline-version'],
  ['scripts/electron-size-baseline-linux.json', /"electronVersion"\s*:/, 'decorative-package-baseline-version'],
  ['test/suite-mcp-tools-unit.mjs', /chatgpt-local-compat-smoke\.mjs|Modern protocol:\\s\*/, 'stale-protocol-test-wording'],
  ['src/release.js', /Authentication:\s*OAuth/i, 'obsolete-oauth-setup-guidance'],
  ['src/config.js', /\b(?:toolMode|trustedLocalAgent|cleanupOlderThanHours)\b/, 'removed-hard-cutover-config'],
  ['src/httpServer.ts', /\/api\/(?:settings|history\/reset|mcp\/(?:recovery|connection)|health-monitor|caution-summary|readiness)\b/, 'removed-dashboard-http-surface'],
  ['src/mcp/connectionManager.js', /\b(?:retryConnection|connectedClientCount|connectedPrincipalCount|activeSessions|recentSessions|reconnectAttemptCount|lastRecoveryResult|manualRecoveryRequired|capabilityMismatches|reconnectStarted|reconnectSucceeded|reconnectFailed)\b/, 'removed-stateful-mcp-residue'],
  ['src/mcp/principal.js', /authMode\s*=\s*['"]oauth['"]|authMode[^\n]*\|\|\s*['"]oauth['"]/, 'removed-oauth-principal-fallback'],
  ['src/processManager.js', /authMode[^\n]*\|\|\s*['"]oauth['"]/, 'removed-oauth-principal-fallback'],
  ['src/ui/task-identity.js', /\b(?:oauthRecovery|connectorRecovery|clientTasksCapability|nativeTasksSupported|clientAdvertisedTasks|taskExecutionMode)\b|issuer_disagreement|corrupt_oauth_state|connector_reregistration_required/, 'removed-dashboard-recovery-compatibility'],
  ['src/ui/preferences.js', /relai:appearance-change/, 'unconsumed-ui-event'],
  ['src/ui/features/workspaces/recents.js', /relai:workspace-recents-change/, 'unconsumed-ui-event']
]);

const REMOVED_FILES = Object.freeze([
  ['scripts/packaging-audit-policy.json', 'obsolete-packaging-audit-exception'],
  ['examples/chatgpt-mcp-config.example.json', 'obsolete-chatgpt-stdio-example'],
  ['src/ui/components/select.js', 'orphaned-select-component'],
  ['src/http/dashboardHistory.js', 'superseded-history-reset-handler']
]);

function trackedFiles(root) {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean);
}

function auditRepositoryStaleness({ root = process.cwd() } = {}) {
  const findings = [];
  let scannedFiles = 0;
  for (const relative of trackedFiles(root)) {
    if (IMMUTABLE_HISTORY.has(relative)) continue;
    const publicGuidance = PUBLIC_GUIDANCE_FILES.some(rule => rule.test(relative));
    const runtimeGuidance = TARGETED_RUNTIME_GUIDANCE.has(relative);
    if (!publicGuidance && !runtimeGuidance) continue;
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    if (text.includes('\0')) continue;
    scannedFiles += 1;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (publicGuidance && /0\.23\.[0-9]+/.test(line)) findings.push(finding(relative, index, 'stale-version', line));
      if (publicGuidance && /\b\d+[- ]tool(?:\/\d+-action)?(?:\s+(?:public|capability|semantic))?\s+surface\b|exposes \d+ callable tools|executes every test file|Windows x64 only/i.test(line)) findings.push(finding(relative, index, 'stale-claim', line));
      if (publicGuidance) {
        for (const name of FORBIDDEN_PUBLIC_NAMES) {
          if (line.includes(name)) findings.push(finding(relative, index, 'removed-public-tool', line, name));
        }
      }
    }
  }

  for (const [relative, pattern, rule] of SOURCE_INVARIANTS) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    const match = pattern.exec(text);
    if (!match) continue;
    const index = text.slice(0, match.index).split(/\r?\n/).length - 1;
    const line = text.split(/\r?\n/)[index] || match[0];
    findings.push(finding(relative, index, rule, line, match[0]));
  }

  for (const [relative, rule] of REMOVED_FILES) {
    if (fs.existsSync(path.join(root, relative))) findings.push(finding(relative, 0, rule, relative));
  }

  return { findings, scannedFiles, invariantCount: SOURCE_INVARIANTS.length + REMOVED_FILES.length };
}

function finding(file, index, rule, text, match = '') {
  return { file, line: index + 1, rule, match, text: String(text || '').trim() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const result = auditRepositoryStaleness();
  if (result.findings.length) {
    for (const item of result.findings) console.error(`${item.file}:${item.line} [${item.rule}] ${item.text}`);
    process.exitCode = 1;
  } else {
    console.log(`Repository staleness audit passed across ${result.scannedFiles} tracked guidance files and ${result.invariantCount} source invariants.`);
  }
}

export { auditRepositoryStaleness, FORBIDDEN_PUBLIC_NAMES };
