

import * as fs from "node:fs";
import * as path from "node:path";

import { workspaceReplace, workspaceWrite, relaiApplyPatch, relaiVerify, relaiDiff, createStagedPayload, appendStagedPayload, writeStagedMetadata, readStagedPayload, readStagedContent, clearStagedPayload, resolveStagedWriteId, STAGED_WRITE_BYTE_THRESHOLD, STAGED_WRITE_LINE_THRESHOLD } from "./localRepoBridge.js";
import { makeOperationId, appendOperation } from "./journal.js";
import { resolveSafePath } from "./safety.js";
import { runEnvOperation } from "./envOperations.js";
import { MAX_BATCH_EDITS, MAX_BATCH_REPLACEMENTS, MAX_BATCH_INPUT_BYTES, MAX_BATCH_SNAPSHOT_BYTES, BATCH_RESULT_COMPACT_THRESHOLD } from "./editLimits.js";
import { classifyWorkflowRisk } from "./workflow/risk.js";
import { repositoryIntelligence } from './repository/intelligence/service.js';
import { resolveSymbolEdit } from './semanticEdit.js';
import { discoverRepositoryTopology, packageForPath } from "./workflow/topology.js";
import { importNativeArtifact } from './artifactIntake.js';

type PlannerRecord = Record<string, any>;
type PlannerConfig = PlannerRecord;
type PlannerArgs = PlannerRecord;
type PlannerResult = PlannerRecord;
type PlannerEdit = PlannerRecord & { path: string };

interface PlannerWorkspace extends PlannerRecord {
  alias: string;
  path: string;
}

interface PlannerContext extends PlannerRecord {
  signal?: AbortSignal;
}

interface ApplyEditOptions {
  suppressJournal?: boolean;
}

interface BatchFailureOptions {
  phase: string;
  unchanged: boolean;
}

interface EditSnapshot extends PlannerRecord {
  path: string;
  absolutePath: string;
  exists: boolean;
  content: Buffer | null;
  mode: number | null;
}

const STAGED_CHUNK_BYTES = 12000;

async function runStagedWrite(workspace: PlannerWorkspace, config: PlannerConfig, path: string, content: string, dryRun: boolean, suppressJournal = false, expectedSha256 = ''): Promise<PlannerResult> {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    chunks.push(content.slice(offset, offset + STAGED_CHUNK_BYTES));
    offset += STAGED_CHUNK_BYTES;
  }
  const startResult = workspaceWrite(workspace, config, { stage: 'start', path, content: chunks[0], dryRun, suppressJournal, expectedSha256 });
  const { writeId } = startResult;
  for (let i = 1; i < chunks.length; i++) {
    workspaceWrite(workspace, config, { stage: 'append', writeId, content: chunks[i], suppressJournal });
  }
  return workspaceWrite(workspace, config, { stage: 'commit', writeId, dryRun, suppressJournal });
}

// Apply one logical edit: exact replacement when oldText is given, otherwise a
// full-file write (large content auto-routes to the staged chunked write).
async function applyOneEdit(workspace: PlannerWorkspace, config: PlannerConfig, edit: PlannerEdit, dryRun: boolean, options: ApplyEditOptions = {}): Promise<PlannerResult> {
  const path = edit.path;
  const hasOldText = typeof edit.oldText === 'string' && edit.oldText.length > 0;
  const hasReplacements = Array.isArray(edit.replacements) && edit.replacements.length > 0;
  const hasReplacement = hasOldText || hasReplacements;
  const hasContent = typeof edit.content === 'string';

  if (hasOldText && hasReplacements) {
    throw new TypeError(`edit for ${path}: provide oldText+newText OR replacements:[...], not both`);
  }
  if (hasReplacement && hasContent) {
    throw new TypeError(`edit for ${path}: provide exact replacement input OR content, not both`);
  }
  if (!hasReplacement && !hasContent) {
    throw new TypeError(`edit for ${path}: must provide oldText+newText, replacements:[...], or content`);
  }

  if (hasReplacement) {
    if (hasOldText && typeof edit.newText !== 'string') {
      throw new TypeError(`edit for ${path}: newText is required (and must be a string) alongside oldText`);
    }
    const result = workspaceReplace(workspace, config, {
      path,
      oldText: edit.oldText,
      newText: edit.newText,
      occurrence: edit.occurrence,
      replacements: edit.replacements,
      expectedSha256: edit.expectedSha256,
      dryRun,
      suppressJournal: options.suppressJournal === true
    });
    return { ...result, path, plannerPath: 'replace' };
  }

  const contentBytes = Buffer.byteLength(edit.content, 'utf8');
  const lineCount = edit.content.split(/\r?\n/).length;
  if (contentBytes > STAGED_WRITE_BYTE_THRESHOLD || lineCount > STAGED_WRITE_LINE_THRESHOLD) {
    if (dryRun) {
      const result = workspaceWrite(workspace, config, { path, content: edit.content, expectedSha256: edit.expectedSha256, dryRun: true, suppressJournal: true });
      return { ...result, path, plannerPath: 'write:staged' };
    }
    const result = await runStagedWrite(workspace, config, path, edit.content, false, options.suppressJournal === true, edit.expectedSha256);
    return { ...result, path, plannerPath: 'write:staged' };
  }
  const result = workspaceWrite(workspace, config, { path, content: edit.content, expectedSha256: edit.expectedSha256, dryRun, suppressJournal: options.suppressJournal === true });
  return { ...result, path, plannerPath: 'write' };
}

function validateBatchEdits(workspace: PlannerWorkspace, edits: PlannerEdit[]): PlannerRecord {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new TypeError('relai_edit edits must contain at least one structured edit.');
  }
  if (edits.length > MAX_BATCH_EDITS) {
    throw new Error(`relai_edit accepts at most ${MAX_BATCH_EDITS} structured batch edits. Keep a larger repository-wide change together as one updateText patch when it fits the request limit; otherwise split it at a coherent file or feature boundary.`);
  }

  let serialized;
  try {
    serialized = JSON.stringify(edits);
  } catch (error) {
    throw new TypeError(
      `relai_edit could not serialize the structured batch: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const inputBytes = Buffer.byteLength(serialized, 'utf8');
  if (inputBytes > MAX_BATCH_INPUT_BYTES) {
    throw new Error(`relai_edit structured batch input is ${inputBytes} bytes; max is ${MAX_BATCH_INPUT_BYTES}. Keep a repository-wide change together as updateText when it fits the request limit; otherwise split it at a coherent file or feature boundary.`);
  }

  let replacementCount = 0;
  for (const edit of edits) {
    if (Array.isArray(edit?.replacements)) replacementCount += edit.replacements.length;
    else if (edit && (Object.hasOwn(edit, 'oldText') || Object.hasOwn(edit, 'newText'))) replacementCount += 1;
    if (replacementCount > MAX_BATCH_REPLACEMENTS) {
      throw new Error(`relai_edit structured batches accept at most ${MAX_BATCH_REPLACEMENTS} total replacement operations.`);
    }
  }

  const snapshotBytes = estimateBatchSnapshotBytes(workspace, edits);
  return { inputBytes, replacementCount, snapshotBytes };
}

function estimateBatchSnapshotBytes(workspace: PlannerWorkspace, edits: PlannerEdit[]): number {
  const seen = new Set();
  let bytes = 0;
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || !edit.path) continue;
    let safe;
    try {
      safe = resolveSafePath(workspace.path, edit.path);
    } catch {
      continue;
    }
    if (seen.has(safe.relativePath)) continue;
    seen.add(safe.relativePath);
    let stat;
    try {
      stat = fs.statSync(safe.absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    bytes += stat.size;
    if (bytes > MAX_BATCH_SNAPSHOT_BYTES) {
      throw new Error(`relai_edit rollback snapshots would require ${bytes} bytes; max is ${MAX_BATCH_SNAPSHOT_BYTES}. Split the batch or use updateText.`);
    }
  }
  return bytes;
}

async function preflightBatchEdits(workspace: PlannerWorkspace, config: PlannerConfig, edits: PlannerEdit[], dryRun: boolean): Promise<PlannerRecord> {
  const results: PlannerResult[] = [];
  let allOk = true;

  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || !edit.path) {
      results.push({ ok: false, error: 'each edit requires a path', preflight: true });
      allOk = false;
      continue;
    }
    try {
      const result = await applyOneEdit(workspace, config, edit, true, { suppressJournal: true });
      results.push({ ...result, preflight: true });
      if (result.ok === false) allOk = false;
    } catch (error) {
      results.push({ ok: false, path: edit.path, error: error instanceof Error ? error.message : String(error), preflight: true });
      allOk = false;
    }
  }

  return { ok: allOk, results, dryRun };
}

function postActionRecommendation(workspace: PlannerWorkspace, changedFiles: readonly unknown[] = []): PlannerRecord {
  const files = [...new Set((changedFiles || []).map(value => String(value || '').trim().replaceAll('\\', '/')).filter(Boolean))];
  if (!files.length) return { runChecks: false, returnDiff: false, reason: 'No changed files were reported.' };
  let packageIds: unknown[] = [];
  try {
    const topology = discoverRepositoryTopology(workspace.path);
    packageIds = [...new Set(files.map(file => packageForPath(topology, file)?.id).filter(Boolean))];
  } catch {}
  const { boundary, risk } = classifyWorkflowRisk({ changedFiles: files, packageIds });
  const runChecks = risk.level !== 'low';
  return {
    runChecks,
    returnDiff: true,
    reason: runChecks
      ? `${boundary.level} boundary with ${risk.level} risk; validate at a meaningful implementation boundary.`
      : `${boundary.level} boundary with ${risk.level} risk; review the diff without routine validation unless repository policy requires it.`
  };
}
// Optional post-actions: validate and/or return a diff in the SAME call, so a
// change-verify-review loop costs one approval instead of three. When both are
// requested, validation always finishes before diff capture so the returned diff
// describes the final workspace even if a check creates or rewrites files.
async function runPostActions(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, changedFiles: readonly unknown[] = [], signal?: AbortSignal): Promise<PlannerRecord> {
  const post: PlannerRecord = {};
  const wantsChecks = args.runChecks === true && !args.dryRun;
  const wantsDiff = args.returnDiff === true && !args.dryRun;
  const validationArgs = {
    level: args.level,
    complete: false,
    ...(args.work_id ? { work_id: args.work_id } : {}),
    ...(args._operationTaskId ? { _operationTaskId: args._operationTaskId } : {}),
    ...(Array.isArray(changedFiles) && changedFiles.length ? { changedFiles } : {})
  };
  const runChecks = async (extra: PlannerRecord = {}): Promise<PlannerResult> => {
    try {
      return await relaiVerify(workspace, config, { ...validationArgs, ...extra }, { signal });
    } catch (error) {
      if (signal?.aborted) {
        return {
          ok: false,
          cancelled: true,
          validationStatus: 'cancelled',
          executedUnits: 0,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const runDiff = async (): Promise<PlannerResult> => {
    try {
      return await relaiDiff(workspace, config, { maxBytes: args.maxBytes }, { signal });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  if (wantsChecks && wantsDiff) {
    post.checks = await runChecks();
    post.diff = await runDiff();
    post.execution = {
      mode: 'serial',
      maxConcurrentSteps: 1,
      stepCount: 2,
      reason: 'Diff capture waits for validation so it always reflects validation side effects and the final workspace state.'
    };
    return post;
  }

  if (wantsChecks) post.checks = await runChecks();
  if (wantsDiff) post.diff = await runDiff();
  return post;
}


function attachPost(result: PlannerResult, post: PlannerRecord): PlannerResult {
  if (post.checks) result.checks = post.checks;
  if (post.diff) result.diff = post.diff;
  if (post.execution) result.execution = post.execution;
  // A failed post-check makes the whole call not-ok so callers do not treat a
  // broken build as a clean edit.
  if (post.checks?.ok === false) result.ok = false;
  return result;
}

// ---- Staged edit payloads ----------------------------------------------------
// Stream either a large patch (updateText) or a full-file replacement (content)
// through the same bounded payload store without exposing separate write tools.

async function handleStagedEdit(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, signal?: AbortSignal): Promise<PlannerResult> {
  const stage = String(args.stage || '').trim().toLowerCase();
  const hasPatchChunk = typeof args.updateText === 'string';
  const hasContentChunk = typeof args.content === 'string';

  if (stage === 'start') {
    if (hasPatchChunk === hasContentChunk) {
      throw new Error("relai_edit stage='start' requires exactly one of updateText or content.");
    }
    if (hasContentChunk) {
      const result = workspaceWrite(workspace, config, args);
      return { ...result, plannerPath: 'write:staged', plannerReason: 'content chunk provided — starting a staged full-file write' };
    }
    const writeId = makeOperationId();
    createStagedPayload(config, workspace, writeId, {
      id: writeId, kind: 'patch', workspace: workspace.alias, root: workspace.path,
      bytes: Buffer.byteLength(args.updateText, 'utf8'), chunkCount: 1, createdAt: new Date().toISOString()
    }, args.updateText);
    return { ok: true, workspace: workspace.alias, operation: 'stagedPatch:start', writeId, chunks: 1,
      next: "Call relai_edit { work_id, stage:'append', writeId, updateText } for more chunks, then { work_id, stage:'commit', writeId }." };
  }

  if (stage === 'append') {
    if (hasPatchChunk === hasContentChunk) {
      throw new Error("relai_edit stage='append' requires exactly one of updateText or content.");
    }
    const writeId = resolveStagedWriteId(config, workspace, args.writeId, args.path);
    const payload = readStagedPayload(config, workspace, writeId);
    if (hasContentChunk) {
      if (payload.kind === 'patch') throw new Error('Staged payload is a patch, not a full-file write. Append updateText instead.');
      const result = workspaceWrite(workspace, config, { ...args, writeId });
      return { ...result, plannerPath: 'write:staged', plannerReason: 'content chunk provided — appending to a staged full-file write' };
    }
    if (payload.kind !== 'patch') throw new Error('Staged payload is a full-file write, not a patch. Append content instead.');
    appendStagedPayload(config, workspace, writeId, args.updateText);
    payload.bytes += Buffer.byteLength(args.updateText, 'utf8');
    payload.chunkCount += 1;
    payload.updatedAt = new Date().toISOString();
    writeStagedMetadata(config, workspace, writeId, payload);
    return { ok: true, workspace: workspace.alias, operation: 'stagedPatch:append', writeId, chunks: payload.chunkCount };
  }

  if (stage === 'commit' || stage === 'abort') {
    const writeId = resolveStagedWriteId(config, workspace, args.writeId, args.path);
    const payload = readStagedPayload(config, workspace, writeId);
    if (payload.kind !== 'patch') {
      const result = workspaceWrite(workspace, config, { ...args, writeId });
      const out = { ...result, plannerPath: 'write:staged', plannerReason: `staged full-file write ${stage}` };
      return stage === 'commit' ? attachPost(out, await runPostActions(workspace, config, args, out.changedFiles, signal)) : out;
    }
    if (stage === 'abort') {
      const existed = clearStagedPayload(config, workspace, writeId);
      return { ok: true, workspace: workspace.alias, operation: 'stagedPatch:abort', writeId, cleared: existed };
    }
    const patch = readStagedContent(config, workspace, writeId);
    if (Buffer.byteLength(patch, 'utf8') !== payload.bytes) {
      throw new Error(`Staged patch payload size mismatch for writeId ${writeId}. Abort it and start again.`);
    }
    const result = await relaiApplyPatch(workspace, config, { ...args, patch, returnDiff: false }, { signal });
    if (!args.dryRun) clearStagedPayload(config, workspace, writeId);
    const out = { ...result, operation: 'stagedPatch:commit', writeId, plannerPath: 'apply-update:staged' };
    return attachPost(out, await runPostActions(workspace, config, args, out.changedFiles, signal));
  }

  throw new Error("relai_edit stage must be one of: start, append, commit, abort.");
}

async function _handleBatchEdits(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, signal?: AbortSignal): Promise<PlannerResult> {
  const metrics = validateBatchEdits(workspace, args.edits);
  const compactResults = args.edits.length > BATCH_RESULT_COMPACT_THRESHOLD;
  const preflight = await preflightBatchEdits(workspace, config, args.edits, Boolean(args.dryRun));
  if (!preflight.ok || args.dryRun) {
    const failure = preflight.ok ? null : batchFailureDetails(preflight.results, {
      phase: 'preflight',
      unchanged: true
    });
    const out: PlannerResult = {
      ok: preflight.ok,
      workspace: workspace.alias,
      plannerPath: 'batch',
      plannerReason: preflightPlannerReason(preflight),
      editCount: preflight.results.length,
      appliedCount: 0,
      preflightAtomic: true,
      rollbackAtomic: true,
      batchInputBytes: metrics.inputBytes,
      replacementCount: metrics.replacementCount,
      snapshotBytes: metrics.snapshotBytes,
      ...(compactResults ? { resultDetailsCompacted: true } : {}),
      ...(failure || {}),
      results: formatBatchResults(preflight.results, compactResults)
    };
    return attachPost(out, await runPostActions(workspace, config, args, out.changedFiles, signal));
  }

  const snapshotCapture = captureEditSnapshots(workspace, args.edits);
  const snapshots = snapshotCapture.snapshots;
  const results: PlannerResult[] = [];
  let allOk = true;
  for (const edit of args.edits) {
    signal?.throwIfAborted?.();
    try {
      const r = await applyOneEdit(workspace, config, edit, false, { suppressJournal: true });
      results.push(r);
      if (r.ok === false) allOk = false;
    } catch (error) {
      results.push({ ok: false, path: edit.path, error: error instanceof Error ? error.message : String(error) });
      allOk = false;
      break;
    }
  }
  let rollback: PlannerRecord | null = null;
  if (!allOk) rollback = restoreEditSnapshots(snapshots);
  const changedFiles = allOk
    ? [...new Set(results.flatMap(item => Array.isArray(item.changedFiles) ? item.changedFiles : []))]
    : [];
  appendOperation(config, workspace, {
    id: makeOperationId(),
    type: 'batch_edit',
    ok: allOk,
    paths: changedFiles,
    results: results.map(item => ({ path: item.path, ok: item.ok !== false, changedFiles: item.changedFiles || [] })),
    ...(rollback ? { rollback } : {})
  });
  const out: PlannerResult = {
    ok: allOk,
    workspace: workspace.alias,
    plannerPath: 'batch',
    plannerReason: `preflight passed; applied ${results.filter((item) => item.ok !== false).length} edit(s)`,
    editCount: args.edits.length,
    appliedCount: allOk ? results.filter((item) => item.ok !== false).length : 0,
    preflightAtomic: true,
    rollbackAtomic: rollback ? rollback.ok : true,
    batchInputBytes: metrics.inputBytes,
    replacementCount: metrics.replacementCount,
    snapshotBytes: snapshotCapture.bytes,
    changedFiles,
    ...(compactResults ? { resultDetailsCompacted: true } : {}),
    ...(rollback ? { rollback } : {}),
    ...(!allOk ? batchFailureDetails(results, {
      phase: 'application',
      unchanged: rollback?.ok === true
    }) : {}),
    preflight: formatBatchResults(preflight.results, compactResults),
    results: formatBatchResults(results, compactResults)
  };
  return attachPost(out, await runPostActions(workspace, config, args, out.changedFiles, signal));
}

function batchFailureDetails(results: PlannerResult[], { phase, unchanged }: BatchFailureOptions): PlannerRecord {
  const failed = results.find(item => item?.ok === false) || {};
  const failedPath = String(failed.path || '').trim();
  const reason = String(failed.error || failed.message || 'one or more edits were rejected').trim();
  const location = failedPath ? ` for ${failedPath}` : '';
  const mutationState = unchanged
    ? 'No files were changed by this atomic batch.'
    : 'Rollback was incomplete; inspect the rollback details before retrying.';
  return {
    error: `Atomic batch ${phase} failed${location}: ${reason} ${mutationState} The Rel.AI connector remains available.`,
    next: failedPath
      ? `Re-read ${failedPath}, rebuild the failed edit from its current contents, and retry. Do not treat this edit failure as a connector disconnect.`
      : 'Correct the failed edit input and retry. Do not treat this edit failure as a connector disconnect.'
  };
}

function captureEditSnapshots(workspace: PlannerWorkspace, edits: PlannerEdit[]): { snapshots: EditSnapshot[]; bytes: number } {
  const snapshots = new Map<string, EditSnapshot>();
  let bytes = 0;
  for (const edit of edits) {
    const safe = resolveSafePath(workspace.path, edit.path);
    if (snapshots.has(safe.relativePath)) continue;
    const exists = fs.existsSync(safe.absolutePath);
    const stat = exists ? fs.statSync(safe.absolutePath) : null;
    if (stat?.isFile() && bytes + stat.size > MAX_BATCH_SNAPSHOT_BYTES) {
      throw new Error(`relai_edit rollback snapshots would exceed ${MAX_BATCH_SNAPSHOT_BYTES} bytes. Split the batch or use updateText.`);
    }
    const content = exists ? fs.readFileSync(safe.absolutePath) : null;
    bytes += content?.length || 0;
    if (bytes > MAX_BATCH_SNAPSHOT_BYTES) {
      throw new Error(`relai_edit rollback snapshots exceeded ${MAX_BATCH_SNAPSHOT_BYTES} bytes while files were changing. Retry with a smaller batch.`);
    }
    snapshots.set(safe.relativePath, {
      path: safe.relativePath,
      absolutePath: safe.absolutePath,
      exists,
      content,
      mode: stat?.mode ?? null
    });
  }
  return { snapshots: [...snapshots.values()], bytes };
}

function restoreEditSnapshots(snapshots: EditSnapshot[]): PlannerRecord {
  const errors: Array<{ path: string; error: string }> = [];
  for (const snapshot of snapshots) {
    try {
      if (!snapshot.exists) {
        fs.rmSync(snapshot.absolutePath, { force: true });
        continue;
      }
      if (snapshot.content === null) throw new Error(`Missing rollback snapshot content for ${snapshot.path}.`);
      fs.mkdirSync(path.dirname(snapshot.absolutePath), { recursive: true });
      fs.writeFileSync(snapshot.absolutePath, snapshot.content);
      if (snapshot.mode != null) fs.chmodSync(snapshot.absolutePath, snapshot.mode);
    } catch (error) {
      errors.push({ path: snapshot.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: errors.length === 0, restored: snapshots.map(item => item.path), errors };
}

function formatBatchResults(results: PlannerResult[], compact: boolean): PlannerResult[] {
  if (!compact) return results;
  return results.map((item) => {
    const summary = {
      ok: item?.ok !== false,
      path: item?.path,
      operation: item?.operation,
      plannerPath: item?.plannerPath,
      changed: item?.changed,
      changedFiles: item?.changedFiles,
      error: item?.error,
      preflight: item?.preflight === true ? true : undefined
    };
    return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
  });
}

function preflightPlannerReason(preflight: PlannerRecord): string {
  if (preflight.ok) return `preflight passed for ${preflight.results.length} edit(s); dryRun requested so 0 edits were applied`;
  return `preflight failed; applied 0 of ${preflight.results.length} edit(s)`;
}

function singlePlannerReason(hasReplacement: boolean, plannerPath: unknown): string {
  if (hasReplacement) return 'exact replacement input provided without content — routing to deterministic text replacement';
  if (plannerPath === 'write:staged') return 'content provided — routing to staged chunked write';
  return 'content provided — routing to direct full-file write';
}

async function _handleUpdateTextEdit(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, signal?: AbortSignal): Promise<PlannerResult> {
  const result = await relaiApplyPatch(workspace, config, { ...args, patch: args.updateText, returnDiff: false }, { signal });
  const out = { ...result, plannerPath: 'apply-update', plannerReason: 'updateText provided — routing to patch-shaped apply-update' };
  return attachPost(out, await runPostActions(workspace, config, args, out.changedFiles, signal));
}

async function _handleSymbolEdit(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, signal?: AbortSignal): Promise<PlannerResult> {
  const semantic = await resolveSymbolEdit(workspace, config, args.symbolEdit, { expectedSha256: args.expectedSha256 });
  const result = workspaceReplace(workspace, config, {
    path: semantic.path,
    oldText: semantic.oldText,
    newText: semantic.newText,
    occurrence: semantic.occurrence,
    expectedSha256: semantic.sourceSha256,
    dryRun: args.dryRun
  });
  const out = {
    ...result,
    path: semantic.path,
    plannerPath: 'symbol',
    plannerReason: `${semantic.target.action} resolved structurally to ${semantic.target.qualifiedName || semantic.target.name} in ${semantic.path}`,
    semanticTarget: semantic.target
  };
  return attachPost(out, await runPostActions(workspace, config, args, result.changedFiles, signal));
}

async function _handleSingleEdit(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, signal?: AbortSignal): Promise<PlannerResult> {
  const hasOldText = typeof args.oldText === 'string' && args.oldText.length > 0;
  const hasReplacements = Array.isArray(args.replacements) && args.replacements.length > 0;
  const hasReplacement = hasOldText || hasReplacements;
  const hasContent = typeof args.content === 'string';
  if (hasOldText && hasReplacements) {
    throw new Error('relai_edit: ambiguous — provide oldText+newText OR replacements:[...], not both');
  }
  if (hasReplacement && hasContent) {
    throw new Error('relai_edit: ambiguous — provide exact replacement input OR content for full-file write, not both');
  }
  if (!hasReplacement && !hasContent) {
    throw new Error('relai_edit: must provide one of: (1) oldText+newText or replacements:[...] for exact replacement, (2) content for full-file write, (3) updateText for patch-shaped update, (4) edits:[...] for a batch');
  }
  const single = await applyOneEdit(workspace, config, {
    path: args.path,
    oldText: args.oldText,
    newText: args.newText,
    occurrence: args.occurrence,
    replacements: args.replacements,
    content: args.content,
    expectedSha256: args.expectedSha256
  }, args.dryRun);
  single.plannerReason = singlePlannerReason(hasReplacement, single.plannerPath);
  return attachPost(single, await runPostActions(workspace, config, args, single.changedFiles, signal));
}

async function planEdit(workspace: PlannerWorkspace, config: PlannerConfig, args: PlannerArgs, context: PlannerContext = {}): Promise<PlannerResult> {
  assertSupportedEditForm(args);
  if (args.file && typeof args.file === 'object' && !Array.isArray(args.file)) {
    const result = await importNativeArtifact(workspace, config, args, { signal: context.signal });
    return attachPost(result, await runPostActions(workspace, config, args, result.changedFiles, context.signal));
  }
  if (args.semantic && typeof args.semantic === 'object') {
    const proposal = await repositoryIntelligence.semanticRename(workspace, args.semantic, { signal: context.signal });
    const result = await _handleBatchEdits(workspace, config, { ...args, semantic: undefined, edits: proposal.edits }, context.signal);
    return {
      ...result,
      plannerPath: 'semantic:rename',
      plannerReason: `${proposal.provider} produced a semantic WorkspaceEdit; Rel.AI validated and applied it through the atomic batch editor`,
      semantic: {
        operation: proposal.operation,
        provider: proposal.provider,
        authority: proposal.authority,
        path: proposal.path,
        line: proposal.line,
        column: proposal.column,
        newName: proposal.newName,
        fileCount: proposal.edits.length
      }
    };
  }
  if (typeof args.envAction === 'string' && args.envAction.trim()) {
    const result = runEnvOperation(workspace, config, args);
    return attachPost(result, await runPostActions(workspace, config, { ...args, returnDiff: false }, result.changedFiles, context.signal));
  }
  if (typeof args.stage === 'string' && args.stage.trim()) return handleStagedEdit(workspace, config, args, context.signal);
  if (Array.isArray(args.edits) && args.edits.length > 0) return _handleBatchEdits(workspace, config, args, context.signal);
  if (args.symbolEdit && typeof args.symbolEdit === 'object') return _handleSymbolEdit(workspace, config, args, context.signal);
  if (typeof args.updateText === 'string' && args.updateText.length > 0) return _handleUpdateTextEdit(workspace, config, args, context.signal);
  return _handleSingleEdit(workspace, config, args, context.signal);
}

const EDIT_FORM_GUIDANCE = 'Use exactly one public edit form: { semantic:{ action:"rename", path, line, column, newName } } for language-server rename, { symbolEdit:{ action, symbol, content, path? } } for an indexed structural symbol edit, { path, content } for a complete text file, { path, file } for a native ChatGPT file, { path, oldText, newText } or { path, replacements } for exact replacement, { updateText } for a patch, { edits } for an atomic batch, or { envAction, ... } for secret-safe environment work.';

function assertSupportedEditForm(args: PlannerArgs = {}): void {
  const has = (field: string): boolean => Object.hasOwn(args, field);
  const hasEnv = typeof args.envAction === 'string' && args.envAction.trim().length > 0;
  const hasStage = typeof args.stage === 'string' && args.stage.trim().length > 0;
  const hasSemantic = has('semantic');
  const hasSymbol = has('symbolEdit');
  const hasBatch = has('edits');
  const hasPatch = has('updateText');
  const hasContent = has('content');
  const hasFile = has('file');
  const hasExact = ['oldText', 'newText', 'replacements', 'occurrence'].some(has);

  if (hasEnv) {
    if (hasStage || hasSemantic || hasSymbol || hasBatch || hasPatch || hasContent || hasFile || hasExact || has('writeId')) {
      throw new Error(`relai_edit envAction cannot be combined with another edit form. ${EDIT_FORM_GUIDANCE}`);
    }
    return;
  }

  if (hasStage) {
    if (hasSemantic || hasSymbol || hasBatch || hasFile || hasExact || has('envAction')) {
      throw new Error(`relai_edit staged operations cannot be combined with exact, batch, or environment fields. ${EDIT_FORM_GUIDANCE}`);
    }
    const stage = String(args.stage).trim().toLowerCase();
    const chunkCount = Number(hasPatch) + Number(hasContent);
    if ((stage === 'start' || stage === 'append') && chunkCount !== 1) {
      throw new Error(`relai_edit stage='${stage}' requires exactly one of content or updateText.`);
    }
    if ((stage === 'commit' || stage === 'abort') && chunkCount !== 0) {
      throw new Error(`relai_edit stage='${stage}' does not accept content or updateText; pass only writeId or path to identify the staged edit.`);
    }
    if (stage === 'start' && hasContent && !String(args.path || '').trim()) {
      throw new Error("relai_edit stage='start' requires path when staging complete-file content.");
    }
    return;
  }

  if (has('envAction')) {
    throw new Error(`relai_edit envAction must be a non-empty supported action. ${EDIT_FORM_GUIDANCE}`);
  }
  if (hasSemantic) {
    if (hasSymbol || hasBatch || hasPatch || hasContent || hasFile || hasExact || has('writeId')) {
      throw new Error(`relai_edit semantic rename cannot be combined with another edit form. ${EDIT_FORM_GUIDANCE}`);
    }
    if (!args.semantic || typeof args.semantic !== 'object' || Array.isArray(args.semantic) || args.semantic.action !== 'rename') {
      throw new Error('relai_edit semantic currently supports only { action:"rename", path, line, column, newName }.');
    }
    return;
  }
  if (hasSymbol) {
    if (hasBatch || hasPatch || hasContent || hasFile || hasExact || has('writeId')) {
      throw new Error(`relai_edit symbolEdit cannot be combined with another edit form. ${EDIT_FORM_GUIDANCE}`);
    }
    if (!args.symbolEdit || typeof args.symbolEdit !== 'object' || Array.isArray(args.symbolEdit)) {
      throw new Error('relai_edit symbolEdit must be an object.');
    }
    return;
  }
  if (has('writeId')) {
    throw new Error(`relai_edit writeId is valid only with stage. ${EDIT_FORM_GUIDANCE}`);
  }

  const selected = [hasBatch, hasPatch, hasContent, hasFile, hasExact].filter(Boolean).length;
  if (selected > 1) {
    throw new Error(`relai_edit received ambiguous, conflicting primary edit forms. ${EDIT_FORM_GUIDANCE}`);
  }
  if (selected === 0) {
    throw new Error(`relai_edit received no primary edit forms and must provide one of them. ${EDIT_FORM_GUIDANCE}`);
  }
  if (hasBatch || hasPatch) return;
  if (!String(args.path || '').trim()) {
    throw new Error(`relai_edit path is required for complete content and exact replacement forms. ${EDIT_FORM_GUIDANCE}`);
  }
  if (hasContent || hasFile) return;

  const hasOldText = has('oldText');
  const hasNewText = has('newText');
  const hasReplacements = has('replacements');
  if (hasReplacements && (hasOldText || hasNewText || has('occurrence'))) {
    throw new Error('relai_edit exact replacement accepts oldText+newText+occurrence OR replacements:[...], not both.');
  }
  if (!hasReplacements && (!hasOldText || !hasNewText)) {
    throw new Error('relai_edit exact replacement requires both oldText and newText.');
  }
  if (hasOldText && (typeof args.oldText !== 'string' || args.oldText.length === 0)) {
    throw new Error('relai_edit oldText must be a non-empty string. Use content for a complete file replacement.');
  }
}

export { planEdit, postActionRecommendation };
