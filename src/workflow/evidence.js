import * as crypto from 'node:crypto';
import { stableJson } from './contracts.js';
import { OPERATION_IDS as OP } from '../tools/operationIds.js';

function buildWorkflowEvidenceReceipt({ tool = '', args = {}, result = {}, auditEntry = {}, repositoryFingerprint = '', commandId = '' } = {}) {
  const kind = evidenceKind(tool, args, result);
  if (!kind) return null;
  const command = normalizeCommand(args.command || result.commandSummary || result.command || '');
  const cwd = normalizeCwd(args.cwd || result.cwd || '.');
  const outcome = result.ok === false || result.commandSucceeded === false
    ? 'failed'
    : kind === 'check' ? 'passed' : 'observed';
  const target = safeTarget(args, result);
  const receipt = {
    version: 1,
    key: `${kind}:${crypto.createHash('sha256').update(stableJson([tool, commandId, command, cwd, target])).digest('hex')}`,
    kind,
    sourceTool: String(tool || '').slice(0, 100),
    createdAt: safeIso(auditEntry.ts || auditEntry.timestamp),
    outcome,
    repositoryFingerprint: String(repositoryFingerprint || '').slice(0, 256),
    mutationGeneration: nonNegativeInt(auditEntry.taskMutationGeneration),
    workspaceGeneration: nonNegativeInt(auditEntry.taskWorkspaceGeneration),
    paths: safePaths(result.changedFiles || args.paths || (args.path ? [args.path] : [])),
    metadata: compactMetadata(result, tool)
  };
  if (kind === 'check') {
    receipt.commandId = String(commandId || '').slice(0, 240);
    receipt.command = command;
    receipt.cwd = cwd;
    receipt.failureSignature = outcome === 'failed' ? failureSignature({ tool, action: args.action, commandId, command, cwd, result, target }) : '';
  }
  return receipt;
}

function checkEvidenceReusable(receipt, current = {}) {
  return Boolean(receipt && receipt.kind === 'check' && receipt.outcome === 'passed'
    && String(receipt.commandId || '') === String(current.commandId || '')
    && normalizeCommand(receipt.command) === normalizeCommand(current.command)
    && normalizeCwd(receipt.cwd) === normalizeCwd(current.cwd)
    && receipt.repositoryFingerprint
    && String(receipt.repositoryFingerprint) === String(current.repositoryFingerprint || '')
    && generationMatches(receipt.mutationGeneration, current.mutationGeneration)
    && generationMatches(receipt.workspaceGeneration, current.workspaceGeneration));
}

function generationMatches(stored, current) {
  if (current == null || current === '') return true;
  return nonNegativeInt(stored) === nonNegativeInt(current);
}

function repeatFailureCount(receipts = []) {
  const failures = receipts.filter(item => item?.outcome === 'failed' && item.failureSignature).slice(-24);
  if (!failures.length) return 0;
  const latest = failures.at(-1).failureSignature;
  const matching = failures.filter(item => item.failureSignature === latest);
  const generations = new Set(matching.map(item => nonNegativeInt(item.mutationGeneration)));
  return generations.size;
}

function failureSignature({ tool, action, commandId, command, cwd, result, target }) {
  const value = [
    normalizeToken(tool),
    normalizeToken(action || commandId),
    normalizeCommand(command),
    normalizeCwd(cwd),
    String(result?.errorCode || result?.exitCode || '').trim(),
    String(target || '').trim(),
    failureEvidence(result)
  ];
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function failureEvidence(result = {}) {
  const diagnostics = (Array.isArray(result.diagnostics) ? result.diagnostics : []).slice(0, 8).map(item => ({
    path: normalizeCwd(item?.path || '.'),
    line: nonNegativeInt(item?.line),
    column: nonNegativeInt(item?.column),
    severity: normalizeToken(item?.severity),
    code: String(item?.code || '').trim().slice(0, 80),
    message: normalizeFailureText(item?.message).slice(0, 500)
  }));
  const failures = [result.failedChecks, result.failures, result.errors]
    .flatMap(value => Array.isArray(value) ? value : [])
    .slice(0, 8)
    .map(item => normalizeFailureText(typeof item === 'string' ? item : item?.name || item?.message || stableJson(item)).slice(0, 500))
    .filter(Boolean);
  const text = normalizeFailureText(result.stderr || result.error || result.message || result.output || '').slice(0, 2000);
  return { diagnostics, failures, text };
}

function normalizeFailureText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:]+)+/g, '<path>')
    .replace(/:(\d+):(\d+)/g, ':#:#')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds?)\b/gi, '<duration>')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceKind(tool, args, result) {
  if (tool === OP.EXEC && looksLikeCheck(args?.command || result?.commandSummary || result?.command)) return 'check';
  if (tool === OP.VALIDATE_CHECKS) return 'check';
  if (tool === OP.READ) return 'read';
  if (tool === OP.UI || tool === OP.BROWSER) return 'ui';
  if (tool === OP.INSPECT || tool === OP.SEARCH_TEXT || tool === OP.SEARCH_SEMANTIC) return 'inspection';
  if (tool === OP.CHANGES_DIFF || tool === OP.CHANGES_CHECKPOINT || tool === OP.CHANGES_REPLAY) return 'review';
  if (tool === OP.PROCESS_START || tool === OP.PROCESS_READ) return 'process';
  return '';
}
function looksLikeCheck(command) { return /(?:^|\s)(test|lint|check|typecheck|build|pytest|cargo test|go test|flutter test|dart analyze)(?:\s|$|:)/i.test(String(command || '')); }
function normalizeCommand(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function normalizeCwd(value) { const text = String(value || '.').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''); return text || '.'; }
function safeTarget(args, result) { return String(args.path || args.target || args.processId || result.processId || '').slice(0, 500); }
function safePaths(values) { return [...new Set((Array.isArray(values) ? values : []).map(item => String(item || '').trim().replaceAll('\\', '/')).filter(Boolean))].slice(0, 100); }
function safeIso(value) { const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString(); }
function nonNegativeInt(value) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0; }
function compactMetadata(result = {}, tool = '') {
  const output = {};
  if (Number.isFinite(Number(result.exitCode))) output.exitCode = Number(result.exitCode);
  if (Number.isFinite(Number(result.durationMs))) output.durationMs = Math.max(0, Number(result.durationMs));
  if (result.validationStatus) output.validationStatus = String(result.validationStatus).slice(0, 40);
  if (result.processId) output.processId = String(result.processId).slice(0, 200);
  if (result.reviewHash) output.reviewHash = String(result.reviewHash).slice(0, 128);
  if (result.reviewScope) output.reviewScope = String(result.reviewScope).slice(0, 40);
  if (tool === OP.UI || tool === OP.BROWSER) {
    if (result.action) output.uiAction = String(result.action).slice(0, 40);
    if (result.sessionId) output.sessionId = String(result.sessionId).slice(0, 200);
    if (result.route || result.url) output.route = String(result.route || result.url).slice(0, 500);
    if (Number.isFinite(Number(result.consoleErrorCount))) output.consoleErrorCount = Math.max(0, Number(result.consoleErrorCount));
    if (Number.isFinite(Number(result.networkFailureCount))) output.networkFailureCount = Math.max(0, Number(result.networkFailureCount));
    if (result.evidenceId) output.evidenceId = String(result.evidenceId).slice(0, 200);
  }
  if (tool === OP.READ && Array.isArray(result.items)) {
    output.reads = result.items.slice(0, 50).map(item => ({
      path: String(item?.path || '').trim().replaceAll('\\', '/').slice(0, 500),
      sha256: String(item?.sha256 || '').trim().slice(0, 128),
      startLine: nonNegativeInt(item?.lineRange?.startLine || item?.startLine || 1) || 1,
      endLine: nonNegativeInt(item?.lineRange?.endLine || item?.endLine || item?.lineCount || 1) || 1
    })).filter(item => item.path && item.sha256);
  }
  return output;
}
function normalizeToken(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, '_'); }

export { buildWorkflowEvidenceReceipt, checkEvidenceReusable, repeatFailureCount };