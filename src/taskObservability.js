
import * as crypto from 'node:crypto';
import { commandDisplayForInvocation, redactCommandForDisplay } from './commandDisplay.js';
import { normalizeHistoricalTaskStatus } from './taskState.js';
import { OPERATION_IDS as OP } from './tools/operationIds.js';
const TASK_MODEL_VERSION = 3;
const MAX_TITLE_LENGTH = 100;
const MAX_OBJECTIVE_LENGTH = 500;
const MAX_SUMMARY_LENGTH = 500;
const MAX_METADATA_STRING = 500;
const MAX_METADATA_ITEMS = 100;
const ALLOWED_METADATA_KEYS = new Set([
  'waitMs', 'queueMode', 'queued', 'pathCount', 'matchCount', 'returnedFileCount', 'returnedRangeCount',
  'returnedBytes', 'changedFileCount', 'changedFiles', 'validationStatus', 'validationLevel', 'validationLevelReason',
  'checkCount', 'passedCount', 'failedCount', 'skippedCount', 'exitCode', 'durationMs', 'stdoutBytes', 'stderrBytes',
  'stdoutTruncated', 'stderrTruncated', 'timedOut', 'commit', 'commitHead', 'branch', 'remote', 'processId', 'pid', 'status',
  'affectedItemCount', 'warningCount', 'retryable', 'errorCode', 'cacheHit', 'operationTaskId', 'progress',
  'currentCheck', 'currentIndex', 'resultStatus', 'failedCheck', 'cancelled', 'internalOperation', 'publicAction'
]);

function deriveTaskTitle(details = {}) {
  const explicit = sanitizeDisplayText(details.title, MAX_TITLE_LENGTH);
  if (explicit && !isGenericTitle(explicit)) return explicit;
  const objective = sanitizeDisplayText(details.objective, MAX_OBJECTIVE_LENGTH);
  if (objective) return sentenceTitle(objective, MAX_TITLE_LENGTH);
  const operation = sanitizeDisplayText(details.operation, MAX_TITLE_LENGTH);
  if (operation && !isGenericTitle(operation)) return sentenceTitle(operation, MAX_TITLE_LENGTH);
  const toolTitle = titleForTool(details.tool, details);
  if (toolTitle) return toolTitle;
  const workspace = cleanText(details.workspace, 60);
  return workspace ? `Work in ${workspace}` : 'Rel.AI workspace task';
}

function titleForTool(tool, details = {}) {
  const path = firstPath(details);
  const workspace = cleanText(details.workspace, 60);
  const suffix = path ? ` ${displayPath(path)}` : workspace ? ` ${workspace}` : '';
  const titles = {
    [OP.WORK_BEGIN]: workspace ? `Work in ${workspace}` : 'Start workspace task',
    [OP.SNAPSHOT]: `Inspect repository${suffix}`,
    [OP.READ]: path ? `Read ${displayPath(path)}` : 'Read repository files',
    [OP.SEARCH_TEXT]: 'Search repository',
    [OP.INSPECT]: 'Inspect code relationships',
    [OP.SEARCH_SEMANTIC]: 'Search code semantically',
    [OP.EDIT]: path ? `Update ${displayPath(path)}` : 'Apply repository changes',
    [OP.EXEC]: 'Run repository command',
    [OP.PROCESS_START]: 'Start managed process',
    [OP.PROCESS_READ]: 'Inspect managed process',
    [OP.PROCESS_WRITE]: 'Send managed process input',
    [OP.PROCESS_STOP]: 'Stop managed process',
    [OP.PROCESS_LIST]: 'List managed processes',
    [OP.VALIDATE_CHECKS]: 'Run repository validation',
    [OP.VALIDATE_DIAGNOSTICS]: 'Run code diagnostics',
    [OP.PUBLISH_COMMIT]: 'Create Git commit',
    [OP.PUBLISH_PUSH]: 'Publish Git branch',
    [OP.PUBLISH_DRAFT_PR]: 'Draft pull request',
    [OP.CHANGES_DIFF]: 'Review repository changes',
    [OP.CHANGES_CHECKPOINT]: 'Checkpoint repository review',
    [OP.CHANGES_REPLAY]: 'Replay repository review',
    [OP.WORK_STATUS]: 'Inspect repository status',
    [OP.WORK_CANCEL]: 'Cancel work session',
    [OP.WORK_FINISH]: 'Finish work session'
  };
  return titles[String(tool || '')] || '';
}

function buildToolActivityDetails(name, args = {}, value = null, error = null, options = {}) {
  const toolOk = error == null && value?.ok !== false;
  const operationOk = toolOk && !(name === OP.EXEC && value?.commandSucceeded === false);
  const category = categoryForTool(name, options);
  const operation = cleanText(options.operation, 160) || titleForTool(name, { ...args, tool: name });
  const target = targetForTool(args, value);
  const normalizedError = error ? normalizeActivityError(error) : value?.ok === false
    ? normalizeActivityError({ message: value.error || value.message || `${name} failed`, code: value.errorCode })
    : undefined;
  const result = resultForTool(name, args, value, operationOk);
  const summary = summaryForTool(name, args, value, normalizedError, operation, result);
  const progress = progressForTool(name, args, value, operationOk, options.phase);
  const command = name === OP.EXEC ? commandDisplayForInvocation(args) : '';
  const status = normalizedError ? errorStatus(normalizedError) : options.phase === 'running' ? 'running' : operationOk ? 'succeeded' : 'failed';
  return {
    category,
    action: actionForTool(name),
    status,
    title: operation || titleForTool(name, args) || 'Rel.AI tool operation',
    summary,
    currentStage: stageForTool(name, status),
    currentActivity: summary,
    target,
    result,
    error: normalizedError,
    progress,
    ...(command ? { command } : {}),
    metadata: sanitizeActivityMetadata({
      ...(options.metadata || {}),
      pathCount: pathCount(args),
      matchCount: value?.matchCount,
      returnedFileCount: value?.returnedFileCount,
      returnedRangeCount: value?.returnedRangeCount,
      returnedBytes: value?.returnedBytes,
      changedFileCount: changedFiles(value).length,
      changedFiles: changedFiles(value),
      validationStatus: value?.validationStatus,
      validationLevel: value?.validationLevel,
      validationLevelReason: value?.validationLevelReason,
      exitCode: value?.exitCode,
      durationMs: value?.durationMs,
      stdoutBytes: value?.stdoutBytes,
      stderrBytes: value?.stderrBytes,
      stdoutTruncated: value?.stdoutTruncated,
      stderrTruncated: value?.stderrTruncated,
      timedOut: value?.timedOut,
      processId: value?.processId || args?.processId,
      pid: value?.pid,
      operationTaskId: value?.operationTaskId,
      retryable: normalizedError?.retryable,
      errorCode: normalizedError?.code
    })
  };
}

function progressForTool(name, args = {}, value = null, ok = true, phase = 'complete') {
  const totalPaths = pathCount(args);
  if (totalPaths > 0) {
    const completed = phase === 'running' ? 0 : ok ? totalPaths : Math.min(totalPaths, resultItemCount(value));
    return determinateProgress(completed, totalPaths, 'batch', `${completed} of ${totalPaths} paths`);
  }
  const checks = Array.isArray(value?.checks) ? value.checks : [];
  const results = Array.isArray(value?.results) ? value.results : [];
  const requestedChecks = Array.isArray(args?.checks) ? args.checks.length : 0;
  const totalChecks = Math.max(Number(value?.totalUnits || 0), requestedChecks, checks.length, results.length);
  if (/checks|diagnostics/.test(String(name || '')) && totalChecks > 0) {
    const completed = phase === 'running'
      ? 0
      : Math.min(totalChecks, Number.isFinite(Number(value?.completedUnits)) ? Number(value.completedUnits) : results.length || (ok ? totalChecks : 0));
    const progress = determinateProgress(completed, totalChecks, 'workflow', `${completed} of ${totalChecks} checks`);
    if (!ok && progress.percentage >= 100) progress.percentage = 99;
    return progress;
  }
  if (phase === 'complete' && ok && name === OP.WORK_FINISH) return completeProgress('Task completed');
  return { mode: 'indeterminate', label: stageForTool(name, phase === 'running' ? 'running' : ok ? 'succeeded' : 'failed') };
}

function determinateProgress(completedUnits, totalUnits, source = 'tool', label = '') {
  const total = Math.max(1, Math.floor(Number(totalUnits) || 1));
  const completed = Math.min(total, Math.max(0, Math.floor(Number(completedUnits) || 0)));
  return {
    mode: 'determinate',
    completedUnits: completed,
    totalUnits: total,
    percentage: Math.round((completed / total) * 100),
    source,
    ...(label ? { label: cleanText(label, 120) } : {})
  };
}

function completeProgress(label = 'Complete') {
  return { mode: 'complete', percentage: 100, label: cleanText(label, 120) || 'Complete' };
}

function incompleteProgress(progress, status, label = '') {
  const normalized = normalizeTaskProgress(progress, status);
  if (normalized.mode !== 'determinate') {
    return label ? { ...normalized, label: cleanText(label, 120) } : normalized;
  }
  return {
    ...normalized,
    percentage: Math.min(99, Number(normalized.percentage || 0)),
    ...(label ? { label: cleanText(label, 120) } : {})
  };
}

function normalizeTaskProgress(progress, status) {
  if (status === 'completed') return completeProgress(progress?.label || 'Complete');
  if (progress?.mode === 'determinate') {
    const normalized = determinateProgress(progress.completedUnits, progress.totalUnits, progress.source, progress.label);
    if (Number.isFinite(Number(progress.percentage))) {
      normalized.percentage = Math.min(normalized.percentage, Math.max(0, Math.round(Number(progress.percentage))));
    }
    if (normalized.percentage >= 100) normalized.percentage = 99;
    return normalized;
  }
  if (progress?.mode === 'complete') {
    return { mode: 'indeterminate', ...(progress?.label ? { label: cleanText(progress.label, 120) } : {}) };
  }
  return { mode: 'indeterminate', ...(progress?.label ? { label: cleanText(progress.label, 120) } : {}) };
}

function sanitizeActivityMetadata(value, depth = 0) {
  if (depth > 4 || value == null) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_METADATA_ITEMS).map(item => sanitizeMetadataValue(item, depth + 1)).filter(item => item !== undefined);
  }
  if (typeof value !== 'object') return sanitizeMetadataValue(value, depth + 1);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    const sanitized = sanitizeMetadataValue(item, depth + 1);
    if (sanitized !== undefined && sanitized !== '' && !(Array.isArray(sanitized) && sanitized.length === 0)) output[key] = sanitized;
  }
  return output;
}

function sanitizeMetadataValue(value, depth) {
  if (value == null) return undefined;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeMetadataString(value);
  if (Array.isArray(value)) return value.slice(0, MAX_METADATA_ITEMS).map(item => sanitizeMetadataValue(item, depth + 1)).filter(item => item !== undefined);
  if (typeof value === 'object' && depth <= 4) return sanitizeActivityMetadata(value, depth + 1);
  return undefined;
}

function sanitizeMetadataString(value) {
  const text = sanitizeDisplayText(value, MAX_METADATA_STRING);
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return sanitizeUrl(text);
  return text;
}

function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = '';
      url.password = '';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, '[redacted]');
    }
    if (url.hash && /token|secret|password|credential|code/i.test(url.hash)) url.hash = '#[redacted]';
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

function normalizeActivityError(error) {
  const message = sanitizeDisplayText(error?.message || error?.error || error, MAX_SUMMARY_LENGTH) || 'Operation failed.';
  return {
    message,
    ...(error?.code ? { code: cleanText(error.code, 100) } : {}),
    retryable: error?.retryable === true
  };
}

function createActivityEvent(details = {}) {
  const startedAt = isoTime(details.startedAt || Date.now());
  const completedAt = details.completedAt ? isoTime(details.completedAt) : undefined;
  const eventId = cleanText(details.eventId || details.operationId, 200) || crypto.randomUUID();
  return {
    schemaVersion: TASK_MODEL_VERSION,
    eventId,
    taskId: cleanText(details.taskId, 200),
    sessionId: cleanText(details.sessionId || details.taskId, 200),
    ...(details.parentEventId ? { parentEventId: cleanText(details.parentEventId, 200) } : {}),
    sequence: Math.max(1, Number(details.sequence || 1)),
    timestamp: isoTime(details.timestamp || startedAt),
    category: details.category || 'tool',
    action: cleanText(details.action, 100) || 'execute',
    status: details.status || 'running',
    title: sanitizeDisplayText(details.title, 160) || 'Rel.AI activity',
    summary: sanitizeDisplayText(details.summary, MAX_SUMMARY_LENGTH) || 'Operation in progress.',
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(Number.isFinite(details.durationMs) ? { durationMs: Math.max(0, Number(details.durationMs)) } : {}),
    tool: {
      name: cleanText(details.tool?.name || details.tool, 200),
      ...(details.tool?.operation || details.operation ? { operation: cleanText(details.tool?.operation || details.operation, 200) } : {}),
      invocationId: cleanText(details.tool?.invocationId || details.operationId || eventId, 200)
    },
    ...(details.target && Object.values(details.target).some(Boolean) ? { target: compactObject(details.target) } : {}),
    ...(details.result && Object.values(details.result).some(value => value !== undefined && value !== '') ? { result: compactObject(details.result) } : {}),
    ...(details.error ? { error: normalizeActivityError(details.error) } : {}),
    ...(details.command ? { command: redactCommandForDisplay(details.command) } : {}),
    metadata: sanitizeActivityMetadata(details.metadata || {}) || {}
  };
}

function categoryForTool(name, options = {}) {
  if (options.category) return options.category;
  if (/run_checks|diagnostics|validation/.test(name)) return 'validation';
  if (/git_/.test(name)) return 'git';
  if (/process_/.test(name)) return 'process';
  if (/complete_task|cancel_task|start_task|operation_task/.test(name)) return 'task';
  if (/resource/.test(name)) return 'resource';
  return 'tool';
}

function actionForTool(name) {
  return String(name || '').replace(/^relai_/, '').replaceAll('_', '.').slice(0, 100) || 'execute';
}

function stageForTool(name, status) {
  if (status === 'blocked') return 'Blocked';
  if (status === 'failed') return 'Resolving failure';
  if (/run_checks|diagnostics|validation/.test(name)) return 'Validating';
  if (/git_commit|git_push/.test(name)) return 'Publishing changes';
  if (/edit|restore|reset|tidy_run/.test(name)) return 'Updating repository';
  if (/read|search|snapshot|inspect|status|diff/.test(name)) return 'Inspecting repository';
  if (/process/.test(name)) return 'Managing process';
  if (/cancel_task/.test(name)) return 'Cancelling task';
  if (/complete_task/.test(name)) return 'Finalizing task';
  return status === 'running' ? 'Running tool' : 'Reviewing result';
}

function targetForTool(args = {}, value = {}) {
  args = args || {};
  value = value || {};
  const path = firstPath(args) || firstPath(value);
  const resourceUri = cleanText(args.resourceUri || value.resourceUri, 500);
  const displayName = cleanText(value.displayName || args.label || args.processId || path, 200);
  return compactObject({
    type: resourceUri ? 'resource' : args.processId ? 'process' : path ? 'file' : args.workspace ? 'workspace' : undefined,
    displayName,
    workspaceRelativePath: path ? normalizeRelativePath(path) : undefined,
    resourceUri: resourceUri ? sanitizeUrl(resourceUri) : undefined
  });
}

function searchMatchCountText(value) {
  const count = Number(value?.matchCount);
  if (!Number.isFinite(count)) return '';
  const qualifier = value?.truncated === true ? 'at least ' : '';
  return `${qualifier}${count} match${count === 1 ? '' : 'es'}`;
}

function resultForTool(name, args, value, ok) {
  const changed = changedFiles(value);
  const affectedItemCount = affectedCount(value, args, changed);
  const warningCount = Number(value?.warningCount || value?.warnings?.length || 0);
  let outcome = ok ? 'Completed successfully' : 'Failed';
  if (name === OP.READ && affectedItemCount) outcome = `Read ${affectedItemCount} item${affectedItemCount === 1 ? '' : 's'}`;
  else if ([OP.SEARCH_TEXT, OP.SEARCH_SEMANTIC].includes(name) && Number.isFinite(value?.matchCount)) outcome = `Found ${searchMatchCountText(value)}`;
  else if (changed.length) outcome = `Updated ${changed.length} file${changed.length === 1 ? '' : 's'}`;
  else if (/checks|diagnostics/.test(name) && value?.validationStatus) outcome = `Validation ${value.validationStatus}`;
  else if (name === OP.PUBLISH_COMMIT && value?.commit) outcome = `Created commit ${cleanText(value.commit, 20)}`;
  return compactObject({ outcome, affectedItemCount, warningCount });
}

function summaryForTool(name, args, value, error, operation, result) {
  if (error) return `${operation || titleForTool(name, args) || 'Tool execution'} failed: ${error.message}`;
  if (name === OP.WORK_BEGIN) return args?.title
    ? `Started logical task “${sanitizeDisplayText(args.title, 120)}”.`
    : 'Started a logical workspace task.';
  if (name === OP.READ) return result.affectedItemCount
    ? `Read ${result.affectedItemCount} repository item${result.affectedItemCount === 1 ? '' : 's'}.`
    : 'Read repository content.';
  if ([OP.SEARCH_TEXT, OP.SEARCH_SEMANTIC].includes(name)) return Number.isFinite(value?.matchCount)
    ? `Searched the repository and found ${searchMatchCountText(value)}.`
    : 'Searched repository content.';
  if (name === OP.EDIT) {
    const count = changedFiles(value).length || pathCount(args);
    return count ? `Updated ${count} file${count === 1 ? '' : 's'}.` : 'Applied repository changes.';
  }
  if (/run_checks|diagnostics/.test(name)) {
    const status = cleanText(value?.validationStatus, 40);
    return status ? `Validation ${status}.` : 'Ran repository validation.';
  }
  if (name === OP.EXEC) {
    const command = cleanText(value?.commandSummary, 180);
    const exit = Number.isFinite(value?.exitCode) ? ` Exit code ${value.exitCode}.` : '';
    return `${command ? `Ran ${command}.` : 'Ran a repository command.'}${exit}`.trim();
  }
  if (name === OP.PUBLISH_COMMIT) return value?.commit ? `Created Git commit ${cleanText(value.commit, 20)}.` : 'Created a Git commit.';
  if (name === OP.PUBLISH_PUSH) return 'Published the Git branch.';
  if (name === OP.WORK_CANCEL) return sanitizeDisplayText(value?.terminalReason || args?.reason, MAX_SUMMARY_LENGTH) || 'Task cancellation was reported.';
  if (name === OP.WORK_FINISH) return sanitizeDisplayText(value?.summary || args?.summary, MAX_SUMMARY_LENGTH) || 'Task completion was reported.';
  return cleanText(result?.outcome, MAX_SUMMARY_LENGTH) || `${operation || titleForTool(name, args) || 'Tool operation'} completed.`;
}

function errorStatus(error) {
  const code = String(error?.code || '');
  if (/TASK_PERSISTENCE_CONFLICT|APPROVAL|AUTHORIZATION/.test(code)) return 'blocked';
  if (/CANCEL/.test(code)) return 'cancelled';
  return 'failed';
}

function pathCount(args = {}) {
  if (Array.isArray(args.paths)) return args.paths.length;
  if (Array.isArray(args.ranges)) return args.ranges.length;
  if (Array.isArray(args.edits)) return args.edits.length;
  return args.path ? 1 : 0;
}

function resultItemCount(value) {
  if (Array.isArray(value?.items)) return value.items.length;
  if (Array.isArray(value?.files)) return value.files.length;
  return 0;
}

function affectedCount(value, args, changed) {
  if (changed.length) return changed.length;
  for (const candidate of [value?.affectedItemCount, value?.returnedFileCount, value?.matchCount, resultItemCount(value), pathCount(args)]) {
    if (Number.isFinite(candidate) && Number(candidate) > 0) return Number(candidate);
  }
  return undefined;
}

function changedFiles(value = {}) {
  const values = Array.isArray(value?.changedFiles) ? value.changedFiles : [];
  return [...new Set(values.map(item => normalizeRelativePath(item)).filter(Boolean))].slice(0, 200);
}

function firstPath(value = {}) {
  value = value || {};
  if (value.path) return value.path;
  if (Array.isArray(value.paths) && value.paths.length) return value.paths[0];
  if (Array.isArray(value.ranges) && value.ranges.length) return value.ranges[0]?.path;
  if (Array.isArray(value.edits) && value.edits.length) return value.edits[0]?.path;
  if (Array.isArray(value.changedFiles) && value.changedFiles.length) return value.changedFiles[0];
  return '';
}

function displayPath(value) {
  const path = normalizeRelativePath(value);
  if (!path) return 'repository files';
  return path.length <= 60 ? path : `…/${path.split('/').slice(-2).join('/')}`;
}

function normalizeRelativePath(value) {
  const text = cleanText(value, 500).replaceAll('\\', '/');
  if (!text) return '';
  if (/^[a-z]:\//i.test(text) || text.startsWith('/')) return text.split('/').filter(Boolean).slice(-3).join('/');
  return text.replace(/^\.\//, '');
}

function sanitizeDisplayText(value, maxLength = 200) {
  const bounded = String(value == null ? '' : value).slice(0, 100000);
  const text = bounded
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{0,50000}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, '[redacted-private-key]')
    .replace(/\b(Authorization)\s*:\s*(Bearer|Basic)\s+[^\s,;]+/gi, '$1: $2 [redacted]')
    .replace(/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]{6,}/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|token|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|authorization[_-]?code|approval[_-]?code|cookie|set-cookie|secret)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH_CODE|CLIENT_SECRET)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=[redacted]')
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, match => sanitizeUrl(match));
  return cleanText(text, maxLength);
}

function sanitizeCompletionSummary(value, maxLength = 2000) {
  if (value == null || value === '') throw new Error('summary is required to report task completion.');
  if (typeof value !== 'string') throw new TypeError('summary must be a string.');
  const summary = sanitizeDisplayText(value, maxLength);
  if (!summary) throw new Error('summary is required to report task completion.');
  return summary;
}

function sanitizeActivityEventRecord(event) {
  if (!event || typeof event !== 'object') return event;
  const value = { ...event };
  for (const key of ['title', 'summary', 'message', 'currentStage', 'currentActivity']) {
    if (value[key] != null) value[key] = sanitizeDisplayText(value[key], key === 'title' ? 160 : MAX_SUMMARY_LENGTH);
  }
  if (value.error != null) value.error = typeof value.error === 'object'
    ? normalizeActivityError(value.error)
    : sanitizeDisplayText(value.error, MAX_SUMMARY_LENGTH);
  if (value.command != null) value.command = redactCommandForDisplay(value.command);
  if (value.tool && typeof value.tool === 'object') value.tool = sanitizeStructuredValue(value.tool, 0);
  if (value.target && typeof value.target === 'object') value.target = sanitizeStructuredValue(value.target, 0);
  if (value.result && typeof value.result === 'object') value.result = sanitizeStructuredValue(value.result, 0);
  value.metadata = sanitizeActivityMetadata(value.metadata || {}) || {};
  delete value.args;
  delete value.output;
  return value;
}

function buildSafeActivityProjection(record, options = {}) {
  const event = options.alreadySanitized ? record : sanitizeActivityEventRecord(record);
  if (!event || typeof event !== 'object') return {};
  return {
    eventId: event.eventId || event.id,
    taskId: event.taskId,
    sessionId: event.sessionId,
    sequence: event.sequence,
    timestamp: event.timestamp || event.ts,
    category: event.category,
    action: event.action,
    status: event.status,
    title: event.title || event.operation,
    summary: event.summary || event.message,
    durationMs: event.durationMs || event.ms,
    tool: event.tool,
    workspace: event.workspace,
    target: event.target || (event.path ? { workspaceRelativePath: sanitizeDisplayText(event.path, MAX_METADATA_STRING) } : undefined),
    result: event.result,
    error: event.error,
    command: event.command,
    metadata: event.metadata
  };
}

function sanitizeTaskRecord(record, options = {}) {
  if (!record || typeof record !== 'object') return record;
  const value = { ...record };
  value.status = normalizeHistoricalTaskStatus(value.status, value);
  for (const [key, limit] of Object.entries({
    title: MAX_TITLE_LENGTH,
    objective: MAX_OBJECTIVE_LENGTH,
    contextSummary: 3000,
    currentStage: MAX_SUMMARY_LENGTH,
    currentActivity: MAX_SUMMARY_LENGTH,
    summary: 2000,
    resultSummary: 2000,
    errorSummary: MAX_SUMMARY_LENGTH,
    terminalReason: MAX_SUMMARY_LENGTH,
    cancellationInitiator: 80,
    endReason: 120,
    resumeStatus: 80
  })) {
    if (value[key] != null) value[key] = sanitizeDisplayText(value[key], limit);
  }
  if (!options.eventsAlreadySanitized && Array.isArray(value.events)) {
    value.events = value.events.map(sanitizeActivityEventRecord).filter(Boolean);
  }
  if (Array.isArray(value.currentOperations)) value.currentOperations = value.currentOperations.map(item => sanitizeStructuredValue(item, 0)).filter(Boolean);
  if (value.semanticProgress && typeof value.semanticProgress === 'object') value.semanticProgress = sanitizeStructuredValue(value.semanticProgress, 0);
  if (value.correlation && typeof value.correlation === 'object') value.correlation = sanitizeStructuredValue(value.correlation, 0);
  if (value.backgroundOperation && typeof value.backgroundOperation === 'object') value.backgroundOperation = sanitizeStructuredValue(value.backgroundOperation, 0);
  delete value.workflow;
  return value;
}

function sanitizeTaskRecordForProjection(record, options = {}) {
  const value = sanitizeTaskRecord(record, options);
  if (!value || typeof value !== 'object') return value;
  const projected = { ...value };
  delete projected.workflowEvidence;
  delete projected.workflow;
  if (projected.backgroundOperation && typeof projected.backgroundOperation === 'object') {
    const { signature: _signature, ...backgroundOperation } = projected.backgroundOperation;
    projected.backgroundOperation = backgroundOperation;
  }
  return projected;
}
function sanitizeStructuredValue(value, depth = 0) {
  if (depth > 5 || value == null) return undefined;
  if (typeof value === 'string') return sanitizeDisplayText(value, MAX_METADATA_STRING);
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, MAX_METADATA_ITEMS).map(item => sanitizeStructuredValue(item, depth + 1)).filter(item => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    const sanitized = sanitizeStructuredValue(item, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

function cleanText(value, maxLength = 200) {
  const sanitized = Array.from(String(value == null ? '' : value), character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
  const text = sanitized
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function sentenceTitle(value, maxLength) {
  const text = cleanText(value, maxLength);
  if (!text) return '';
  const firstSentence = text.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
  const title = cleanText(firstSentence, maxLength);
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : '';
}

function isGenericTitle(value) {
  return /^(task|request|tool call|mcp operation|rel\.ai task|workspace task)$/i.test(cleanText(value, MAX_TITLE_LENGTH));
}

function isSensitiveKey(key) {
  return /token|secret|password|authorization|cookie|credential|private.?key|environment|command.?env|approval|content|stdout|stderr|output|prompt|header/i.test(String(key || ''));
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

function isoTime(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const timestamp = Number(value);
  return new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).toISOString();
}

export {


  buildSafeActivityProjection,
  buildToolActivityDetails,
  completeProgress,
  createActivityEvent,
  deriveTaskTitle,
  determinateProgress,
  incompleteProgress,

  normalizeTaskProgress,
  sanitizeActivityMetadata,
  sanitizeActivityEventRecord,
  sanitizeCompletionSummary,
  sanitizeDisplayText,
  sanitizeTaskRecord,
  sanitizeTaskRecordForProjection,


};
