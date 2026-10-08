import { getOperationDefinition } from './actionCatalog.js';
import { OPERATION_IDS as OP } from './operationIds.js';
// @ts-check

/** @typedef {import('../../types/boundaries.d.ts').ToolArgs} ToolArgs */
/** @typedef {import('../../types/boundaries.d.ts').ToolResult} ToolResult */
/** @typedef {(extra: Record<string, unknown>, value: ToolResult, args: ToolArgs) => void} AuditEnricher */

import * as sessionCache from "../sessionCache.js";
import { classifyCaution } from "../cautionZone.js";
import { resolveWorkspace } from "../config.js";
import { resolveSafePath } from "../safety.js";
import { ensureSessionStarted } from "../policyResolver.js";
function debugSwallow(context, error) {
  if (process.env.REL_AI_MCP_DEBUG) {
    console.error(`[rel-ai-mcp] best-effort '${context}' failed: ${error?.message || error}`);
  }
}

/** @type {Readonly<Record<string, AuditEnricher>>} */
const CODE_MUTATING_TOOLS = new Set([OP.EDIT, OP.CHANGES_TIDY_RUN, OP.CHANGES_RESTORE, OP.CHANGES_RESET]);

const AUDIT_ENRICHERS = Object.freeze({
  edit: enrichEditAudit,
  exec: enrichExecAudit,
  checks: enrichChecksAudit,
  completion: enrichCompletionAudit,
  path: enrichPathAudit,
  read: enrichReadAudit,
  snapshot: enrichSnapshotAudit
});
/** @param {string} name @param {ToolResult} value @param {ToolArgs} args @returns {Record<string, unknown>} */
function buildExtraAudit(name, value, args) {
  /** @type {Record<string, unknown>} */
  const extra = {};
  const auditKind = getOperationDefinition(name)?.behavior?.audit || "";
  AUDIT_ENRICHERS[auditKind]?.(extra, value, args);
  enrichCommonAudit(extra, name, value, args);
  return extra;
}

function enrichCommonAudit(extra, name, value, args) {
  const dryRun = args?.dryRun === true;
  const mutationCapable = CODE_MUTATING_TOOLS.has(name) || name === OP.EXEC;
  const bookkeepingOnly = name === OP.EDIT && (['start', 'append', 'abort'].includes(String(args?.stage || '').toLowerCase())
    || ['list', 'compare'].includes(String(args?.envAction || '')));
  const effect = dryRun || bookkeepingOnly ? 'none' : ['none', 'applied', 'unknown'].includes(value?.mutationEffect) ? value.mutationEffect : '';
  if (effect && !dryRun) extra.mutationEffect = effect;
  if (effect === 'unknown') extra.mutationUnknown = true;
  const changedFiles = !dryRun && effect !== 'none' && mutationCapable && Array.isArray(value?.changedFiles) ? value.changedFiles : [];
  if (changedFiles.length) extra.changedFiles = changedFiles.slice(0, 200);
  if (!dryRun && effect === 'unknown' && Array.isArray(value?.possibleChangedFiles)) extra.possibleChangedFiles = value.possibleChangedFiles.slice(0, 200);
  assignTruthy(extra, "validationStatus", value?.validationStatus);
  if (!dryRun && name === OP.PUBLISH_COMMIT && value?.committed === true) {
    extra.commitCreated = true;
    assignTruthy(extra, 'commitHead', value?.head);
    if (Array.isArray(value?.paths) && value.paths.length) extra.committedFiles = value.paths.slice(0, 200);
  }
  if (!dryRun && name === OP.PUBLISH_PUSH && value?.ok !== false) extra.pushPublished = true;
  if (name === OP.PUBLISH_DRAFT_PR && value?.ok !== false) extra.prDrafted = true;
}

function enrichEditAudit(extra, value, args) {
  assignTruthy(extra, "plannerPath", value?.plannerPath);
  assignTruthy(extra, "plannerReason", value?.plannerReason);
  const checks = value?.checks && typeof value.checks === 'object' && !Array.isArray(value.checks)
    ? value.checks
    : null;
  if (checks) {
    assignTruthy(extra, "validationStatus", checks.validationStatus);
    assignTruthy(extra, "validationLevel", checks.validationLevel);
    assignTruthy(extra, "validationLevelReason", checks.validationLevelReason);
    assignTruthy(extra, "validationFingerprint", checks.validationFingerprint);
    if (Array.isArray(checks.validationScope)) extra.validationScope = checks.validationScope.slice(0, 1000);
  }
  addAuditPath(extra, args?.path);
}

function enrichExecAudit(extra, value) {
  assignTruthy(extra, 'commandSummary', value?.commandSummary);
  assignTruthy(extra, 'cwd', value?.cwd);
  assignDefined(extra, 'exitCode', value?.exitCode);
  assignDefined(extra, 'durationMs', value?.durationMs);
  assignDefined(extra, 'stdoutBytes', value?.stdoutBytes);
  assignDefined(extra, 'stderrBytes', value?.stderrBytes);
  assignDefined(extra, 'stdoutTruncated', value?.stdoutTruncated === true);
  assignDefined(extra, 'stderrTruncated', value?.stderrTruncated === true);
  assignDefined(extra, 'timedOut', value?.timedOut === true);
  assignTruthy(extra, 'mutationTracking', value?.mutationTracking);
  assignTruthy(extra, 'mutationTrackingDetails', value?.mutationTrackingDetails);
  assignDefined(extra, 'mutationUnknown', value?.mutationUnknown === true);
  if (Array.isArray(value?.ephemeralChangedFiles) && value.ephemeralChangedFiles.length) {
    extra.ephemeralChangedFiles = value.ephemeralChangedFiles.slice(0, 100);
  }
  if (Array.isArray(value?.environmentKeys) && value.environmentKeys.length) {
    extra.environmentKeys = value.environmentKeys.slice(0, 100);
  }
}

function enrichChecksAudit(extra, value) {
  assignTruthy(extra, "validationLevel", value?.validationLevel);
  assignTruthy(extra, "validationLevelReason", value?.validationLevelReason);
  assignTruthy(extra, "validationFingerprint", value?.validationFingerprint);
  if (Array.isArray(value?.validationScope)) extra.validationScope = value.validationScope.slice(0, 1000);
  assignDefined(extra, "aliasNormalizations", value?.aliasNormalizations);
  if (value?.policy) extra.policySessionActive = value.policy.sessionActive;
  if (value?.completionKnown === true) enrichCompletionAudit(extra, value);
}

function enrichCompletionAudit(extra, value) {
  assignDefined(extra, "completionKnown", value?.completionKnown === true);
  assignTruthy(extra, "endReason", value?.endReason);
  assignTruthy(extra, "taskSummary", value?.summary);
  assignTruthy(extra, "validationAt", value?.validationAt);
  assignTruthy(extra, "completionSource", value?.completionSource);
  assignDefined(extra, "duplicateRequest", value?.duplicate === true);
}

function enrichPathAudit(extra, _value, args) {
  addAuditPath(extra, args?.path);
}

function enrichReadAudit(extra, value) {
  if (Array.isArray(value?.items)) extra.cacheHit = value.items.some((item) => item?.cacheHit === true);
}

function enrichSnapshotAudit(extra, value) {
  assignDefined(extra, "effectiveSnapshotMaxFiles", value?.effectiveMaxEntries);
  assignDefined(extra, "budgetMultiplied", value?.budgetMultiplied);
}

function assignTruthy(target, key, value) {
  if (value) target[key] = value;
}
function assignDefined(target, key, value) {
  if (value != null) target[key] = value;
}
function addAuditPath(extra, filePath) {
  if (filePath) extra.filePath = filePath;
}

function applyCautionAudit(extra, name, args) {
  try {
    const caution = classifyCaution(name, args);
    if (caution?.level === "caution") {
      extra.cautionLevel = caution.level;
      extra.cautionReason = caution.reason;
    }
  } catch (error) {
    debugSwallow("classify-caution", error);
  }
}

function invalidateSessionCacheForCall(config, name, args) {
  try {
    const alias = args?.workspace;
    if (!alias) return;
    const cacheMode = getOperationDefinition(name)?.behavior?.cache || "";
    if (!cacheMode) return;
    const workspace = resolveWorkspace(config, alias);
    const wsRoot = workspace?.path;
    if (!wsRoot) return;
    if (cacheMode === "workspace") {
      sessionCache.invalidateAlias(alias);
      return;
    }
    if (cacheMode === "edit" && (args.updateText != null || args.stage != null)) {
      sessionCache.invalidateAlias(alias);
      return;
    }
    if (cacheMode === "paths" || cacheMode === "edit") {
      invalidatePaths(alias, wsRoot, collectTouchedPaths(args, cacheMode === "edit"));
      return;
    }
  } catch (error) {
    debugSwallow("cache-invalidate", error);
  }
}

function collectTouchedPaths(args, includeEdits) {
  const touched = [];
  if (args?.path) touched.push(args.path);
  if (includeEdits && Array.isArray(args?.edits)) {
    for (const edit of args.edits) if (edit?.path) touched.push(edit.path);
  }
  return touched;
}

function invalidatePaths(alias, wsRoot, paths) {
  for (const filePath of paths) {
    try {
      const safe = resolveSafePath(wsRoot, filePath);
      sessionCache.invalidatePath(alias, safe.absolutePath);
    } catch (error) {
      debugSwallow("resolve-safe-path", error);
    }
  }
}

async function maybeStartSession(config, toolName, args, details = {}) {
  const behavior = getOperationDefinition(toolName)?.behavior;
  if (behavior?.startsSession !== true || args?.dryRun === true) return { started: false, alias: '' };
  if (behavior.deferStagedSession === true && typeof args.stage === "string") {
    const stage = args.stage.trim().toLowerCase();
    if (stage === "start" || stage === "append" || stage === "abort") return { started: false, alias: '' };
  }
  const alias = args?.workspace;
  if (!alias) return { started: false, alias: '' };
  try {
    const workspace = resolveWorkspace(config, alias);
    const started = workspace?.path
      ? await ensureSessionStarted(config, workspace.alias, workspace.path, { taskId: details.taskId })
      : false;
    return { started, alias: workspace.alias };
  } catch (error) {
    debugSwallow("start-session", error);
    return { started: false, alias: String(alias || '') };
  }
}

export { debugSwallow, buildExtraAudit, applyCautionAudit, invalidateSessionCacheForCall, maybeStartSession };
