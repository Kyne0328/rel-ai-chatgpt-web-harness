import { OPERATION_IDS as OP } from './operationIds.js';
import { FAILURE_OPERATION } from './contracts.ts';

function enhanceToolError(toolName, error) {
  const raw = error instanceof Error ? error.message : String(error);
  const append = (extra) => {
    const next = Object.assign(new Error(`${raw}\n\n${extra}`), error && typeof error === 'object' ? error : {});
    if (error?.stack) next.stack = error.stack;
    return next;
  };
  return editErrorHint(toolName, raw, append)
    ?? patchErrorHint(toolName, raw, append, error)
    ?? (error instanceof Error ? error : new Error(raw));
}

function editErrorHint(toolName, raw, append) {
  if (toolName !== OP.EDIT && toolName !== 'relai_edit') return null;
  if (/Invalid IPv6 URL|Invalid URL|ERR_INVALID_URL/i.test(raw)) {
    return append('Edit payload was rejected by a URL parser, likely on the client transport. Use relai_edit with content, updateText, or smaller oldText/newText blocks.');
  }
  if (/found 0 matches/.test(raw)) {
    return append('Call relai_read on the file, then retry with exact current text. Use relai_edit with content only for a complete rewrite.');
  }
  if (/found \d+ matches/.test(raw)) {
    return append('Pass occurrence: N to target one match, or extend oldText with surrounding lines until it is unique.');
  }
  if (/exceeds .* bytes/i.test(raw)) {
    return append('For one complete file, use relai_edit content. For a repository-wide change, keep it together as updateText when it fits the request limit. Otherwise split the change at a coherent file or feature boundary. Use smaller exact replacements only for genuinely local edits.');
  }
  return null;
}

function patchErrorHint(toolName, raw, append, error) {
  if (toolName !== OP.EDIT && toolName !== 'relai_edit') return null;
  if (/corrupt patch|patch .* invalid|did not contain any valid|patch failed/i.test(raw)) {
    return append("Accepted updateText formats are Git unified diff and structured OpenAI patch format. Re-read the current files before regenerating the patch.");
  }
  if (/context mismatch|delete mismatch|unsupported line/i.test(raw)) {
    return append('The patch did not match current file contents. Re-read the file and regenerate the patch with sufficient unchanged context.');
  }
  if (/Delete File.*not supported/i.test(raw)) {
    return error instanceof Error ? error : new Error(raw);
  }
  return null;
}

function operationForTool(toolName) {
  if ([OP.READ, OP.SEARCH_TEXT, OP.SEARCH_SEMANTIC, OP.SNAPSHOT, OP.INSPECT, 'relai_read', 'relai_search', 'relai_snapshot', 'relai_inspect'].includes(toolName)) return FAILURE_OPERATION.READ;
  if ([OP.CHANGES_RESTORE, OP.CHANGES_RESET, 'relai_changes'].includes(toolName)) return FAILURE_OPERATION.RESTORE;
  if ([OP.PUBLISH_COMMIT, 'relai_publish'].includes(toolName)) return FAILURE_OPERATION.COMMIT;
  if ([OP.CHANGES_DIFF, OP.PUBLISH_DRAFT_PR].includes(toolName)) return FAILURE_OPERATION.REVIEW;
  return FAILURE_OPERATION.WRITE;
}

function serializeToolError(toolName, error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = { ok: false, error: message };
  if (!error || typeof error !== 'object' || !error.code) return payload;
  return {
    ...payload,
    errorCode: String(error.code),
    errorDetails: {
      code: String(error.code),
      source: String(error.source || 'rel-ai-mcp'),
      operation: String(error.operation || operationForTool(toolName)),
      ...(error.path ? { path: String(error.path) } : {}),
      ...(error.fileClass ? { fileClass: String(error.fileClass) } : {}),
      ...(error.taskId ? { taskId: String(error.taskId) } : {}),
      ...(Number.isFinite(error.candidateCount) ? { candidateCount: Number(error.candidateCount) } : {}),
      ...(Array.isArray(error.matchLines) ? { matchLines: error.matchLines.map(Number).filter(Number.isFinite).slice(0, 20) } : {}),
      ...(Array.isArray(error.candidateContexts) ? { candidateContexts: error.candidateContexts.map(String).slice(0, 10) } : {}),
      ...(error.currentSha256 ? { currentSha256: String(error.currentSha256) } : {}),
      ...(error.workspaceInput != null ? { workspaceInput: String(error.workspaceInput) } : {}),
      ...(error.workspaceInputSource ? { workspaceInputSource: String(error.workspaceInputSource) } : {}),
      ...(error.workspaceMatchStatus ? { workspaceMatchStatus: String(error.workspaceMatchStatus) } : {}),
      ...(error.workspaceResolutionFailure ? { workspaceResolutionFailure: String(error.workspaceResolutionFailure) } : {}),
      ...(Array.isArray(error.configuredWorkspaceAliases) ? { configuredWorkspaceAliases: error.configuredWorkspaceAliases.map(String).slice(0, 100) } : {}),
      ...(Array.isArray(error.workspaceAliases) ? { workspaceAliases: error.workspaceAliases.map(String).slice(0, 100) } : {}),
      ...(Number.isFinite(error.workspaceCount) ? { workspaceCount: Number(error.workspaceCount) } : {}),
      ...(error.blockingTaskId ? { blockingTaskId: String(error.blockingTaskId) } : {}),
      ...(error.blockingOperationId ? { blockingOperationId: String(error.blockingOperationId) } : {}),
      ...(error.blockingOperation ? { blockingOperation: String(error.blockingOperation) } : {}),
      ...(error.blockingStartedAt ? { blockingStartedAt: String(error.blockingStartedAt) } : {}),
      ...(Number.isFinite(error.queueTimeoutMs) ? { queueTimeoutMs: Number(error.queueTimeoutMs) } : {}),
      retryable: error.retryable === true,
      requiresUserConfirmation: error.requiresUserConfirmation === true,
      allowedAlternatives: Array.isArray(error.allowedAlternatives)
        ? error.allowedAlternatives.map((item) => String(item))
        : []
    }
  };
}

export { enhanceToolError, serializeToolError };
