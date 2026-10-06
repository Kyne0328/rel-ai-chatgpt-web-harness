import { taskOwnedChangedFiles } from '../taskIntegrity.ts';
import { readGitObservation } from '../repo/gitObservation.js';
import { randomBytes } from 'node:crypto';
import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "../durableState.ts";
import { resolveSafePath, fileSha256 } from "../safety.js";
import { getStateDir } from '../statePaths.js';
import { appendOperation, makeOperationId } from "../journal.js";
import { classifyStatusOwnership } from "../repo/gitOps.js";
import { clampNumber } from "./limits.js";

const TIDY_PLAN_TTL_MS = 15 * 60 * 1000;
const TIDY_PLAN_ID_PATTERN = /^tidy_[a-z0-9]+_[a-f0-9]{12}$/;
const TIDY_MODES = new Set(["session_untracked"]);

function clearTidyFiles(workspace, config, paths) {
  const operationId = makeOperationId();
  const cleared = [];
  for (const rawPath of paths) {
    const safe = resolveSafePath(workspace.path, rawPath, { operation: "delete" });
    if (!fs.existsSync(safe.absolutePath)) throw new Error(`Tidy target does not exist: ${safe.relativePath}`);
    if (!fs.statSync(safe.absolutePath).isFile()) throw new Error(`Tidy refuses non-file path: ${safe.relativePath}`);
    fs.rmSync(safe.absolutePath, { force: true });
    cleared.push(safe.relativePath);
  }
  appendOperation(config, workspace, {
    id: operationId,
    type: "workspace_tidy_clear",
    ok: true,
    paths: cleared,
    results: []
  });
  return { ok: true, changedFiles: cleared };
}

function tidyPlanDir(config, workspace) {
  const safeAlias = String(workspace.alias || "workspace").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(getStateDir(config), "workspace-tidy", safeAlias);
}

function validateTidyPlanId(planId) {
  const text = String(planId || "").trim();
  if (!TIDY_PLAN_ID_PATTERN.test(text)) throw new Error("Invalid or missing workspace tidy planId.");
  return text;
}

function tidyPlanPath(config, workspace, planId) {
  return path.join(tidyPlanDir(config, workspace), `${validateTidyPlanId(planId)}.json`);
}

function makeTidyPlanId() {
  return `tidy_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;
}

function normalizeTidyMode(raw) {
  const mode = String(raw || "session_untracked").trim().toLowerCase();
  if (!TIDY_MODES.has(mode)) throw new Error(`Unsupported tidy mode '${mode}'. Supported modes: ${[...TIDY_MODES].join(", ")}.`);
  return mode;
}

function scanUntrackedSessionFiles(workspace, ownership, maxCandidates) {
  const candidates = [];
  const skipped = [];
  for (const file of ownership.untrackedSession.slice(0, maxCandidates)) {
    try {
      const safe = resolveSafePath(workspace.path, file);
      if (!fs.existsSync(safe.absolutePath)) { skipped.push({ path: safe.relativePath, reason: "missing" }); continue; }
      const stat = fs.statSync(safe.absolutePath);
      if (!stat.isFile()) { skipped.push({ path: safe.relativePath, reason: "not a file" }); continue; }
      candidates.push({
        path: safe.relativePath, action: "tidy_untracked_file",
        status: "untracked", owner: "session",
        reason: "untracked file owned by the current workspace session",
        sha256: fileSha256(workspace.path, safe.relativePath),
        sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString()
      });
    } catch (error) {
      skipped.push({ path: String(file), reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { candidates, skipped };
}

async function readTidyOwnership(workspace, config, taskId = '') {
  const status = await readGitObservation(workspace.path, config);
  if (status.exitCode !== 0 || status.stdoutTruncated) {
    throw new Error(`git status failed for ${workspace.alias}: ${status.stderr || (status.stdoutTruncated ? "output exceeded internal limit" : status.exitCode)}`);
  }
  const known = taskId ? taskOwnedChangedFiles(config, taskId, workspace.alias) : [];
  let output = status.stdout || '';
  for (let offset = 0; offset < known.length; offset += 100) {
    const exact = await readGitObservation(workspace.path, config, { paths: known.slice(offset, offset + 100) });
    if (exact.exitCode !== 0 || exact.stdoutTruncated) throw new Error('Could not verify exact tidy file ownership.');
    output += exact.stdout;
  }
  return classifyStatusOwnership(workspace, config, output, taskId);
}

async function workspaceTidyPlan(workspace, config, args = {}) {
  const mode = normalizeTidyMode(args.mode);
  const maxCandidates = clampNumber(args.maxCandidates, 1, 100, 50);
  const taskId = String(args.work_id || '').trim();
  const ownership = await readTidyOwnership(workspace, config, taskId);
  // Without a captured session baseline we cannot distinguish this agent's
  // untracked artifacts from pre-existing user files. Refuse rather than risk
  // planning a delete of files the user created before any session started.
  if (mode === "session_untracked" && !ownership.hasSession) {
    return {
      ok: false,
      workspace: workspace.alias,
      operation: "workspaceTidyPlan",
      mode,
      candidateCount: 0,
      candidates: [],
      skipped: [],
      reason: "no_session_baseline",
      message: "No active session baseline for this workspace, so untracked files cannot be attributed to this session. Make an edit first so Rel.AI can capture a session baseline before tidying session-owned untracked files."
    };
  }
  const { candidates, skipped } = scanUntrackedSessionFiles(workspace, ownership, maxCandidates);
  const now = Date.now();
  const planId = makeTidyPlanId();
  const plan = {
    id: planId,
    workspace: workspace.alias,
    root: workspace.path,
    taskId,
    mode,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TIDY_PLAN_TTL_MS).toISOString(),
    candidates,
    skipped
  };
  writeJsonAtomic(tidyPlanPath(config, workspace, planId), plan, { mode: 0o600, spacing: 2 });
  appendOperation(config, workspace, {
    id: planId,
    type: "workspace_tidy_plan",
    ok: true,
    paths: [],
    results: [{ operation: "workspaceTidyPlan", mode, candidateCount: candidates.length }]
  });
  return {
    ok: true,
    workspace: workspace.alias,
    operation: "workspaceTidyPlan",
    mode,
    planId,
    expiresAt: plan.expiresAt,
    ttlSeconds: Math.floor(TIDY_PLAN_TTL_MS / 1000),
    candidateCount: candidates.length,
    skippedCount: skipped.length,
    candidates,
    skipped,
    next: candidates.length ? 'Call relai_changes with action "tidy_run" and this planId to apply this bounded tidy plan.' : 'No session-owned untracked files were found.'
  };
}

function readTidyPlan(config, workspace, planId) {
  const id = validateTidyPlanId(planId);
  const file = tidyPlanPath(config, workspace, id);
  if (!fs.existsSync(file)) throw new Error(`Workspace tidy plan not found or already used: ${id}`);
  const plan = JSON.parse(fs.readFileSync(file, "utf8"));
  if (plan?.id !== id) throw new Error(`Workspace tidy plan file is invalid: ${id}`);
  if (plan.workspace !== workspace.alias || plan.root !== workspace.path) throw new Error(`Workspace tidy plan ${id} belongs to a different workspace.`);
  const expires = Date.parse(plan.expiresAt || "");
  if (!Number.isFinite(expires) || Date.now() > expires) throw new Error(`Workspace tidy plan ${id} expired. Create a new plan first.`);
  return { file, plan };
}

async function relaiWorkspaceTidyRun(workspace, config, args = {}) {
  const planId = validateTidyPlanId(args.planId);
  const taskId = String(args.work_id || '').trim();
  const { file, plan } = readTidyPlan(config, workspace, planId);
  if (!taskId || taskId !== String(plan.taskId || '').trim()) {
    throw new Error(`Workspace tidy plan ${planId} belongs to a different work session.`);
  }
  const ownership = await readTidyOwnership(workspace, config, taskId);
  const currentUntracked = new Set(ownership.untrackedSession || []);
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  const { preflight, refused } = preflightTidyCandidates(candidates, workspace, currentUntracked);
  if (refused.length > 0) {
    return {
      ok: false,
      workspace: workspace.alias,
      operation: "workspaceTidyApply:preflight",
      planId,
      changed: false,
      changedFiles: [],
      applied: [],
      refused,
      message: "Workspace tidy plan was not applied because one or more candidates changed since planning. Create a fresh plan."
    };
  }
  const clearResult = preflight.length > 0
    ? clearTidyFiles(workspace, config, preflight.map((item) => item.path))
    : { ok: true, changedFiles: [] };
  try { fs.rmSync(file, { force: true }); } catch { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] tidy plan cleanup'); }
  const applied = preflight.map((item) => ({ path: item.path, action: "tidied_untracked_file", sha256: item.sha256, sizeBytes: item.sizeBytes }));
  appendOperation(config, workspace, {
    id: planId,
    type: "workspace_tidy_apply",
    ok: clearResult.ok === true,
    paths: clearResult.changedFiles || [],
    results: [{ operation: "workspaceTidyApply", appliedCount: applied.length }]
  });
  return {
    ok: clearResult.ok === true,
    workspace: workspace.alias,
    operation: "workspaceTidyApply",
    planId,
    changed: applied.length > 0,
    changedFiles: clearResult.changedFiles || [],
    appliedCount: applied.length,
    applied,
    message: applied.length ? `Applied workspace tidy plan to ${applied.length} file(s).` : "Workspace tidy plan had no candidates."
  };
}

function preflightTidyCandidates(candidates, workspace, currentUntracked) {
  const preflight = [];
  const refused = [];
  for (const candidate of candidates) {
    const safe = resolveSafePath(workspace.path, candidate.path);
    if (!currentUntracked.has(safe.relativePath)) { refused.push({ path: safe.relativePath, reason: "path is no longer session-owned and untracked" }); continue; }
    if (!fs.existsSync(safe.absolutePath)) { refused.push({ path: safe.relativePath, reason: "path is missing" }); continue; }
    const stat = fs.statSync(safe.absolutePath);
    if (!stat.isFile()) { refused.push({ path: safe.relativePath, reason: "path is not a file" }); continue; }
    const currentSha256 = fileSha256(workspace.path, safe.relativePath);
    if (currentSha256 !== candidate.sha256) { refused.push({ path: safe.relativePath, reason: "sha256 mismatch", expectedSha256: candidate.sha256, currentSha256 }); continue; }
    preflight.push({ path: safe.relativePath, sha256: currentSha256, sizeBytes: stat.size });
  }
  return { preflight, refused };
}

export { workspaceTidyPlan, relaiWorkspaceTidyRun as workspaceTidyRun };
