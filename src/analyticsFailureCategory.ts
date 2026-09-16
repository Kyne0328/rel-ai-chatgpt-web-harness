import {
  ANALYTICS_FAILURE_CATEGORIES,
  type AnalyticsFailureCategory,
  type ObservabilityResultInput
} from './telemetry.types.ts';

const ANALYTICS_FAILURE_CATEGORY_SET = new Set<string>(ANALYTICS_FAILURE_CATEGORIES);

function failureCategoryFromCode(value: unknown, operationName: unknown = ''): AnalyticsFailureCategory {
  return failureCategoryFromEvent({ errorCode: value, operationName });
}

function failureCategoryFromEvent(event: ObservabilityResultInput = {}): AnalyticsFailureCategory {
  const code = String(event.errorCode || '').trim().toUpperCase().slice(0, 160);
  const message = String(event.errorMessage || '').trim().toUpperCase().slice(0, 800);
  const operation = String(event.operationName || event.tool || '').trim().toUpperCase().slice(0, 160);
  const signal = `${code} ${message}`;

  if (/\b(CANCELLED|CANCELED|CANCEL|ABORTED|ABORT)\b/.test(signal)) return 'cancelled';
  if (/TIMEOUT|TIMED_OUT|DEADLINE|EXPIRED/.test(signal)) return 'timeout';

  if (/^(TASK_|INVALID_TASK_STATE|WORK_ID_)/.test(code) || /\bTASK (?:ID|STATE|SESSION|OPERATION)\b/.test(message)) return 'task';
  if (/EDIT_CONTEXT_MISMATCH|STALE_EXPECTED|STALE_STATE|NO_LONGER_APPLIES|CONCURRENT(?:_CHANGE)?|ALREADY_(?:ACTIVE|COMPLETED|CANCELLED)/.test(signal)) return 'stale';
  if (/^(INDEX_|QUERY_|LSP_)/.test(code) || /REPOSITORY_INTELLIGENCE|SEARCH_INDEX|TREE_SITTER|ZOEKT/.test(signal)) return 'search';

  if (/^(SQLITE_|STATE_|SETTINGS_|UPDATE_|STARTUP_|LIFECYCLE_|DASHBOARD_|LOCAL_SERVICE_|LOCAL_PORT_|CONFIGURATION_|DIAGNOSTICS_)/.test(code)) return 'app';
  if (/^(BROWSER_|COMPUTER_|DESKTOP_|APPLICATION_|UI_)/.test(code) || /BROWSER AUTOMATION|COMPUTER CONTROL|DESKTOP CONTROL/.test(message)) return 'desktop';

  if (/^(APPROVAL_|SENSITIVE_|PROTECTED_)/.test(code) || /\b(?:POLICY|APPROVAL|CAUTION|RESTRICTED)\b/.test(signal)) return 'policy';
  if (/^TUNNEL_(?:AUTHENTICATION_FAILED|ACCESS_DENIED)$/.test(code) || /AUTH|OAUTH|TOKEN|UNAUTHORIZED|FORBIDDEN|PRINCIPAL|GRANT|PAIRING/.test(signal)) return 'authorization';
  if (/RATE_LIMIT|CONCURRENCY|CAPACITY/.test(signal) || /\bBUSY\b/.test(signal)) return 'capacity';
  if (/^(TUNNEL_|SECURE_TUNNEL_|PUBLIC_ENDPOINT_)/.test(code) || /DEVICE_OFFLINE|TRANSPORT|CONNECTION|SOCKET|AMBIGUOUS_RESULT|RESULT_UNAVAILABLE|GATEWAY/.test(signal)) return 'transport';

  if (/SENSITIVE_PATCH_REQUIRES_CONTENT_VALIDATION/.test(code)) return 'policy';
  if (/WORKSPACE|SOURCE_PATH|PATH|FILE|DIRECTORY|SYMLINK/.test(signal)) return 'workspace';
  if (/GIT|MERGE|CONFLICT|BRANCH|COMMIT|REMOTE/.test(signal)) return 'git';
  if (/VALIDATION|SCHEMA|INVALID|PROTOCOL|PARSE|INPUT|ARGUMENT/.test(signal)) return 'validation';
  if (/PROCESS|EXEC|COMMAND|SPAWN|TOOL_EXECUTION_FAILED/.test(signal) || /\bREL_AI_EXEC\b/.test(operation)) return 'process';

  if (/\b(INTERNAL(?:_ERROR)?|UNHANDLED|EXCEPTIONGROUP|INVARIANT|ASSERTION(?:ERROR)?|PANIC|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND)\b/.test(signal)) return 'internal';

  if (/\b(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM)\b/.test(signal)) {
    if (/EXEC|PROCESS/.test(operation)) return 'process';
    if (/BROWSER|COMPUTER|DESKTOP/.test(operation)) return 'desktop';
    return 'workspace';
  }

  if (/VALIDATE|DIAGNOSTIC|CHECK/.test(operation)) return 'validation';
  if (/SEARCH|INSPECT/.test(operation)) return 'search';
  if (/BROWSER|COMPUTER|DESKTOP/.test(operation)) return 'desktop';
  if (/EXEC|PROCESS/.test(operation)) return 'process';
  return 'unclassified';
}

function normalizeFailureCategory(value: unknown): AnalyticsFailureCategory {
  const category = String(value || '').trim().toLowerCase();
  if (ANALYTICS_FAILURE_CATEGORY_SET.has(category)) return category as AnalyticsFailureCategory;
  if (category === 'runtime' || !category) return 'unclassified';
  return failureCategoryFromCode(value);
}

export { failureCategoryFromCode, failureCategoryFromEvent, normalizeFailureCategory };
