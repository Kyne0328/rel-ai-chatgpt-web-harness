import { readGitObservation, readExactGitObservations } from '../repo/gitObservation.js';
import * as crypto from "node:crypto";
import { runReadOnlyProcess } from "../process.js";
import { resolveSafePath, isSecretPath } from "../safety.js";
import { classifyStatusOwnership } from "../repo/gitOps.js";
import { formatGitStatus } from "../repo/gitStatus.js";
import { clampNumber } from "./limits.js";
import { buildSensitiveReview } from "./sensitiveReview.js";
import { buildUntrackedDiff, normalizePaths, truncateDiff } from './reviewDiff.js';

const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;

async function relaiDiff(workspace, config, args = {}, context = {}) {
  const staged = Boolean(args.staged);
  const maxBytes = clampNumber(args.maxBytes, 1000, 5 * 1024 * 1024, DEFAULT_MAX_DIFF_BYTES);
  const redactSensitive = args.redactSensitive === true;
  const filterPath = resolveReviewFilter(workspace, args.path, redactSensitive);
  const taskOwnedPaths = Array.isArray(args._taskOwnedPaths)
    ? normalizePaths(args._taskOwnedPaths)
    : null;
  const reviewedScope = taskOwnedPaths && args.scope !== 'workspace' ? 'task' : 'workspace';
  const scopeLabel = reviewedScope === 'task' && args._operationScoped === true ? 'operation' : reviewedScope;
  if (reviewedScope === 'task' && filterPath && !taskOwnedPaths.includes(filterPath)) {
    throw new Error(`Path '${filterPath}' is outside the task-owned review scope. Pass scope:'workspace' to explicitly widen this review.`);
  }

  // Status must complete before any diff is read. Its canonical NUL-delimited paths
  // define the allowlist and prevent a speculative unscoped diff from ever loading
  // sensitive-file content into process memory.
  const exactPaths = filterPath ? [filterPath] : reviewedScope === 'task' ? taskOwnedPaths : null;
  const stat = exactPaths?.length
    ? await readExactGitObservations(workspace.path, config, exactPaths, { signal: context.signal })
    : await readGitObservation(workspace.path, config, { signal: context.signal });
  if (stat.exitCode !== 0 || stat.stdoutTruncated) {
    throw new Error(`Git review observation failed: ${stat.error || stat.stderr || 'output budget exhausted'}`);
  }
  const ownership = classifyStatusOwnership(workspace, config, stat.stdout || '');
  // Exact task observations intentionally omit unrelated paths. Obtain a bounded
  // metadata-only inventory for the excluded-files receipt, without widening the
  // diff allowlist or recursively enumerating unrelated untracked directories.
  let inventory = stat;
  if (reviewedScope === 'task' && exactPaths?.length) {
    try { inventory = await readGitObservation(workspace.path, config, { signal: context.signal }); }
    catch { inventory = null; }
    context.signal?.throwIfAborted?.();
  }
  const excludedWorkspaceFilesComplete = Boolean(inventory && inventory.exitCode === 0 && !inventory.stdoutTruncated
    && !inventory.cancelled && !inventory.timedOut && inventory.terminationConfirmed !== false);
  const inventoryOwnership = inventory === stat ? ownership
    : classifyStatusOwnership(workspace, config, excludedWorkspaceFilesComplete ? inventory.stdout || '' : '');
  const inventoryPaths = normalizePaths(inventoryOwnership.entries.filter(entry => !entry.opaqueDirectory).map(entry => entry.path));
  const workspaceChangedPaths = normalizePaths(ownership.entries.filter(entry => !entry.opaqueDirectory).map(entry => entry.path));
  const scopedPaths = reviewedScope === 'task'
    ? workspaceChangedPaths.filter(file => taskOwnedPaths.includes(file))
    : workspaceChangedPaths;
  const changedPaths = filterPath ? scopedPaths.filter(file => file === filterPath) : scopedPaths;
  const excludedWorkspaceFiles = reviewedScope === 'task'
    ? inventoryPaths.filter(file => !taskOwnedPaths.includes(file))
    : ownership.entries.filter(entry => entry.opaqueDirectory).map(entry => entry.path);
  const sensitivePaths = [...new Set(changedPaths.filter(item => isSecretPath(item)))];
  if (filterPath && sensitivePaths.length > 0 && !redactSensitive) {
    throw new Error(`Sensitive path review requires redactSensitive:true: ${filterPath}`);
  }

  const ordinaryPaths = sensitivePaths.length
    ? changedPaths.filter(item => !isSecretPath(item))
    : changedPaths;
  const pathScoped = reviewedScope === 'task' || filterPath != null || sensitivePaths.length > 0;
  const diff = await runOrdinaryDiff(workspace, config, staged, ordinaryPaths, pathScoped, context.signal, maxBytes);
  let diffText = diff.stdout || '';
  if (!staged) {
    const untracked = new Set(ownership.entries.filter(entry => entry.untracked && !isSecretPath(entry.path)).map(entry => entry.path));
    diffText += buildUntrackedDiff(workspace, changedPaths.filter(file => untracked.has(file)), Math.max(0, maxBytes - Buffer.byteLength(diffText)));
  }
  const sensitiveReview = redactSensitive
    ? await buildSensitiveReview(workspace, config, sensitivePaths, ownership, staged, context)
    : [];
  const reviewedFiles = normalizePaths(changedPaths);
  const mixedOwnershipPaths = normalizePaths(args._mixedOwnershipPaths || []).filter(file => reviewedFiles.includes(file));
  const scopedOwnership = scopeOwnership(ownership, new Set(reviewedFiles));
  const reviewHash = crypto.createHash("sha256").update(diffText).update(JSON.stringify(sensitiveReview)).digest("hex");
  return {
    ok: stat.exitCode === 0 && diff.exitCode === 0 && sensitiveReview.every(entry => entry.availability !== 'unavailable'),
    workspace: workspace.alias,
    staged,
    redactSensitive,
    reviewScope: scopeLabel,
    reviewedScope: scopeLabel,
    ...(reviewedScope === 'task' ? {
      scopeGranularity: 'path',
      mixedOwnershipPaths,
      ...(mixedOwnershipPaths.length ? { mixedOwnershipWarning: 'Paths with mixed ownership include all their hunks. Path filtering cannot separate task changes from unrelated changes within one file.' } : {}),
      ...(args._scopeUncertain === true ? { scopeUncertain: true,
        scopeWarning: 'Validation or edit mutation evidence is incomplete; other changes may exist. Do not assume this scoped review proves no other files changed.' } : {}),
      ...(args._validationObservation ? { validationMutationEvidence: args._validationObservation } : {})
    } : {}),
    reviewHash,
    reviewedFiles,
    excludedWorkspaceFilesComplete,
    ...(excludedWorkspaceFilesComplete ? { excludedWorkspaceFiles } : {}),
    ...(filterPath ? { path: filterPath } : {}),
    status: formatGitStatus(scopedOwnership),
    branch: ownership.branch,
    aheadBehind: ownership.aheadBehind,
    statusEntries: scopedOwnership.entries,
    sessionChangedFiles: scopedOwnership.sessionChanged,
    baselineChangedFiles: scopedOwnership.baselineChanged,
    untrackedSessionFiles: scopedOwnership.untrackedSession,
    untrackedBaselineFiles: scopedOwnership.untrackedBaseline,
    ...(ownership.baselineSource ? { baselineSource: ownership.baselineSource } : {}),
    diff: truncateDiff(diffText, maxBytes),
    sensitiveReview,
    ...(sensitiveReview.some(entry => entry.availability === 'unavailable') ? { error: 'Sensitive review evidence is unavailable or incomplete; no key changes were inferred for unavailable versions.', errorCode: 'SENSITIVE_REVIEW_UNAVAILABLE' } : {}),
    sensitiveValuesReturned: false,
    exitCode: diff.exitCode,
    ...(diff.stderr ? { stderr: diff.stderr } : {})
  };
}

function scopeOwnership(ownership, reviewed) {
  const keep = values => (Array.isArray(values) ? values : []).filter(file => reviewed.has(file));
  return {
    ...ownership,
    entries: (ownership.entries || []).filter(entry => reviewed.has(entry.path)),
    sessionChanged: keep(ownership.sessionChanged),
    baselineChanged: keep(ownership.baselineChanged),
    untrackedSession: keep(ownership.untrackedSession),
    untrackedBaseline: keep(ownership.untrackedBaseline)
  };
}

function resolveReviewFilter(workspace, rawPath, redactSensitive) {
  if (!rawPath) return null;
  return resolveSafePath(workspace.path, rawPath, {
    operation: redactSensitive ? 'review-redacted' : 'review'
  }).relativePath;
}

async function runOrdinaryDiff(workspace, config, staged, paths, pathScoped, signal, maxBytes) {
  if (pathScoped && paths.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
  const args = ['diff', ...(staged ? ['--staged'] : [])];
  if (paths.length > 0) args.push('--', ...paths.map(file => `:(literal)${file}`));
  return runReadOnlyProcess('git', args, { cwd: workspace.path, timeout: 60000, signal, maxOutputBytes: maxBytes }, config);
}

export { relaiDiff };