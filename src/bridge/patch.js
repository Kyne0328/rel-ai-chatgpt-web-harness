import * as fs from "node:fs";
import * as path from "node:path";
import { runProcess, summarizeCommand } from "../process.js";
import { resolveSafePath, writeTextFileSafe, fileSha256 } from "../safety.js";
import { appendOperation, makeOperationId } from "../journal.js";
import { assertPatchUpdateSafe, ensureGitRepo, inspectPatchPaths } from "../repo/gitOps.js";
import { clampNumber } from "./limits.js";
import { relaiVerify, hasRequestedChecks } from "./validation.js";
import { relaiDiff } from "./review.js";
import { beginStructuredPatchTransaction, completeStructuredPatchTransaction } from '../structuredPatchTransaction.js';

const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;

async function relaiApplyPatch(workspace, config, args = {}, context = {}) {
  const rawPatch = String(args.patch || args.diff || args.updateText || "");
  assertPatchUpdateSafe(workspace, config, args, rawPatch);
  if (/^\*\*\* Begin Patch\b/m.test(rawPatch)) {
    return applyStructuredOpenAIPatch(workspace, config, args, rawPatch, context);
  }
  const patch = normalizeUnifiedDiffText(rawPatch);
  const patchBytes = Buffer.byteLength(patch, "utf8");
  await ensureGitRepo(workspace, config);
  const timeoutMs = clampNumber(args.timeoutMs, 1000, 86400000, 120000);
  const inspection = await inspectPatchPaths(workspace, config, patch, timeoutMs);
  const touchedPaths = inspection.touchedPaths;
  const check = inspection.check;
  const operationId = makeOperationId();
  if (check.exitCode !== 0) {
    return {
      ok: false,
      workspace: workspace.alias,
      operationId,
      operation: "applyPatch:check",
      touchedPaths,
      check: summarizeCommand(check),
      diagnostics: diagnosePatchFailure(check.stderr || check.stdout || "", patch, touchedPaths)
    };
  }
  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      workspace: workspace.alias,
      operationId,
      operation: "applyPatch:dryRun",
      changedFiles: [],
      touchedPaths,
      patchBytes,
      check: summarizeCommand(check),
      sourceFormat: "unified-diff"
    };
  }
  // Capture content hashes before apply so changedFiles reflects ACTUAL changes,
  // not every path the patch touches — a semantic no-op patch applies cleanly but
  // must report changedFiles:[].
  const hashOf = (rel) => (fs.existsSync(path.join(workspace.path, rel)) ? fileSha256(workspace.path, rel) : null);
  const beforeHashes = new Map(touchedPaths.map((rel) => [rel, hashOf(rel)]));
  const apply = await runProcess("git", ["apply", "-"], { cwd: workspace.path, input: patch, timeout: timeoutMs, signal: context.signal }, config);
  const changedFiles = apply.exitCode === 0
    ? touchedPaths.filter((rel) => hashOf(rel) !== beforeHashes.get(rel))
    : [];
  const verify = hasRequestedChecks(args) ? await relaiVerify(workspace, config, args, context) : null;
  const diff = args.returnDiff === false ? null : await relaiDiff(workspace, config, { maxBytes: args.maxDiffBytes || DEFAULT_MAX_DIFF_BYTES }, context);
  const ok = apply.exitCode === 0 && (!verify || verify.ok);
  appendOperation(config, workspace, { id: operationId, type: "apply_patch", ok, paths: changedFiles, results: [{ operation: "applyPatch", bytes: patchBytes, touchedPaths, changedFiles, verified: verify ? verify.ok : null }] });
  return { ok, workspace: workspace.alias, operationId, operation: "applyPatch", changedFiles, touchedPaths, patchBytes, apply: summarizeCommand(apply), sourceFormat: "unified-diff", ...(verify ? { verify } : {}), ...(diff ? { diff } : {}) };
}

function normalizeOpenAIPatchFormat(input) {
  const text = String(input || "");
  if (!/^\*\*\* Begin Patch\b/m.test(text)) {
    return { patch: text, converted: false, sourceFormat: "unified-diff" };
  }
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length && !/^\*\*\* Begin Patch\b/.test(lines[i])) i += 1;
  i += 1;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\*\*\* End Patch\b/.test(line)) break;
    i = handleOpenAIPatchSection(lines, i, out);
  }
  return { patch: `${out.join("\n")}\n`, converted: true, sourceFormat: "openai-patch" };
}

function handleOpenAIPatchSection(lines, i, out) {
  const line = lines[i];
  const updateMatch = /^\*\*\* Update File:\s*([^\n]+)/.exec(line);
  const addMatch = /^\*\*\* Add File:\s*([^\n]+)/.exec(line);
  const delMatch = /^\*\*\* Delete File:\s*([^\n]+)/.exec(line);
  if (updateMatch) {
    const filePath = updateMatch[1].trim();
    out.push(`--- a/${filePath}`, `+++ b/${filePath}`);
    i += 1;
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        out.push(lines[i]);
      i += 1;
    }
    return i;
  }
  if (addMatch) {
    const filePath = addMatch[1].trim();
    const body = [];
    i += 1;
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        body.push(lines[i]);
      i += 1;
    }
    const contentLines = body.map((l) => (l.startsWith("+") ? l.slice(1) : l));
    out.push(`--- /dev/null`, `+++ b/${filePath}`, `@@ -0,0 +1,${contentLines.length} @@`);
    for (const cl of contentLines) out.push(`+${cl}`);
    return i;
  }
  if (delMatch) {
    throw new Error(`Delete File cannot be converted to a unified diff for ${delMatch[1].trim()}. Pass the structured OpenAI patch directly to relai_edit updateText.`);
  }
  return i + 1;
}

async function applyStructuredOpenAIPatch(workspace, config, args, rawPatch, context = {}) {
  const document = parseOpenAIPatchDocument(rawPatch);
  const plan = planStructuredPatch(workspace, document);
  const touchedPaths = plan.touchedPaths;
  const operationId = makeOperationId();
  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      workspace: workspace.alias,
      operationId,
      operation: "applyPatch:dryRun",
      sourceFormat: "openai-patch",
      converted: false,
      patchBytes: Buffer.byteLength(rawPatch, "utf8"),
      changedFiles: plan.changedFiles,
      touchedPaths
    };
  }
  const changedSnapshots = plan.snapshots.filter(snapshot => plan.changedFiles.includes(snapshot.path));
  const changedStates = plan.states.filter(state => plan.changedFiles.includes(state.path));
  beginStructuredPatchTransaction(config, workspace, changedSnapshots, changedStates);
  const applied = applyStructuredPlan(workspace, plan);
  if (!applied.ok) {
    if (applied.rollback?.ok === true) completeStructuredPatchTransaction(config, workspace);
    appendOperation(config, workspace, { id: operationId, type: "apply_patch", ok: false, paths: [], results: [{ operation: "applyPatch", rollback: applied.rollback, error: applied.error }] });
    return {
      ok: false,
      workspace: workspace.alias,
      operationId,
      operation: "applyPatch",
      sourceFormat: "openai-patch",
      changedFiles: [],
      touchedPaths,
      rollback: applied.rollback,
      error: applied.error
    };
  }
  completeStructuredPatchTransaction(config, workspace);
  const changedFiles = plan.changedFiles;
  const verify = hasRequestedChecks(args) ? await relaiVerify(workspace, config, args, context) : null;
  const diff = args.returnDiff === false ? null : await relaiDiff(workspace, config, { maxBytes: args.maxDiffBytes || DEFAULT_MAX_DIFF_BYTES }, context);
  const ok = !verify || verify.ok;
  appendOperation(config, workspace, { id: operationId, type: "apply_patch", ok, paths: changedFiles, results: [{ operation: "applyPatch", bytes: Buffer.byteLength(rawPatch, "utf8"), touchedPaths: changedFiles, verified: verify ? verify.ok : null }] });
  return {
    ok,
    workspace: workspace.alias,
    operationId,
    operation: "applyPatch",
    sourceFormat: "openai-patch",
    converted: false,
    patchBytes: Buffer.byteLength(rawPatch, "utf8"),
    changedFiles,
    touchedPaths,
    ...(verify ? { verify } : {}),
    ...(diff ? { diff } : {})
  };
}

function planStructuredPatch(workspace, document) {
  const states = new Map();
  const snapshots = new Map();
  const touchedPaths = [];
  for (const operation of document.operations) {
    const safe = resolveSafePath(workspace.path, operation.path);
    if (!states.has(safe.relativePath)) {
      const exists = fs.existsSync(safe.absolutePath);
      const snapshot = {
        path: safe.relativePath,
        absolutePath: safe.absolutePath,
        exists,
        content: exists ? fs.readFileSync(safe.absolutePath) : null,
        mode: exists ? fs.statSync(safe.absolutePath).mode : null
      };
      snapshots.set(safe.relativePath, snapshot);
      states.set(safe.relativePath, {
        ...snapshot,
        text: exists ? snapshot.content.toString('utf8').replaceAll("\r\n", "\n") : ''
      });
      touchedPaths.push(safe.relativePath);
    }
    const state = states.get(safe.relativePath);
    if (operation.type === 'update') {
      if (!state.exists) throw new Error(`OpenAI patch Update File target does not exist: ${safe.relativePath}`);
      state.text = applyOpenAIPatchUpdate(state.text, operation, safe.relativePath);
      continue;
    }
    if (operation.type === 'add') {
      if (state.exists) throw new Error(`OpenAI patch Add File target already exists: ${safe.relativePath}`);
      for (const line of operation.lines) {
        if (line && !line.startsWith('+')) throw new Error(`OpenAI patch Add File for ${safe.relativePath} contains a non-addition line.`);
      }
      state.exists = true;
      state.text = joinPatchLines(operation.lines.map(line => line.startsWith('+') ? line.slice(1) : line), true);
      continue;
    }
    if (!state.exists) throw new Error(`OpenAI patch Delete File target does not exist: ${safe.relativePath}`);
    state.exists = false;
    state.text = '';
  }
  const changedFiles = [...states.values()]
    .filter(state => state.exists !== snapshots.get(state.path).exists || (state.exists && state.text !== snapshots.get(state.path).content.toString('utf8').replaceAll("\r\n", "\n")))
    .map(state => state.path);
  return { states: [...states.values()], snapshots: [...snapshots.values()], touchedPaths, changedFiles };
}

function applyStructuredPlan(workspace, plan) {
  try {
    for (const state of plan.states) {
      if (!plan.changedFiles.includes(state.path)) continue;
      if (!state.exists) fs.rmSync(state.absolutePath, { force: true });
      else writeTextFileSafe(workspace.path, state.path, state.text);
    }
    return { ok: true };
  } catch (error) {
    const rollback = rollbackStructuredPlan(plan.snapshots);
    return { ok: false, error: error instanceof Error ? error.message : String(error), rollback };
  }
}

function rollbackStructuredPlan(snapshots) {
  const errors = [];
  for (const snapshot of snapshots) {
    try {
      if (!snapshot.exists) fs.rmSync(snapshot.absolutePath, { force: true });
      else {
        fs.mkdirSync(path.dirname(snapshot.absolutePath), { recursive: true });
        fs.writeFileSync(snapshot.absolutePath, snapshot.content);
        if (snapshot.mode != null) fs.chmodSync(snapshot.absolutePath, snapshot.mode);
      }
    } catch (error) {
      errors.push({ path: snapshot.path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: errors.length === 0, restored: snapshots.map(item => item.path), errors };
}

function parseOpenAIPatchDocument(input) {
  const lines = String(input || "").replaceAll("\r\n", "\n").split("\n");
  const operations = [];
  let index = lines.findIndex((line) => /^\*\*\* Begin Patch\b/.test(line));
  if (index === -1) throw new Error("OpenAI patch is missing '*** Begin Patch'.");
  index += 1;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\*\*\* End Patch\b/.test(line)) break;
    const updateMatch = /^\*\*\* Update File:\s*([^\n]+)/.exec(line);
    const addMatch = /^\*\*\* Add File:\s*([^\n]+)/.exec(line);
    const deleteMatch = /^\*\*\* Delete File:\s*([^\n]+)/.exec(line);
    if (!updateMatch && !addMatch && !deleteMatch) {
      index += 1;
      continue;
    }
    let type;
    if (updateMatch) type = "update";
    else if (addMatch) type = "add";
    else type = "delete";
    const pathText = (updateMatch || addMatch || deleteMatch)[1].trim();
    const body = [];
    index += 1;
    while (index < lines.length && !/^\*\*\* (?:Update File|Add File|Delete File|End Patch)\b/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }
    operations.push({ type, path: pathText, lines: body });
  }
  if (operations.length === 0) {
    throw new Error("OpenAI patch did not contain any file operations.");
  }
  return { operations };
}

function applyOpenAIPatchUpdate(oldText, operation, relativePath) {
  const oldEndsWithNewline = oldText.endsWith("\n");
  const oldLines = splitPatchText(oldText);
  const hunks = parsePatchHunks(operation.lines, relativePath);
  return joinPatchLines(applyHunksToLines(oldLines, hunks, relativePath), oldEndsWithNewline);
}

function parsePatchHunks(lines, relativePath) {
  const hunks = [];
  let current = [];
  for (const line of lines) {
    if (line === "*** End of File") continue;
    if (line.startsWith("@@")) {
      if (current.length > 0) {
        hunks.push(current);
        current = [];
      }
      continue;
    }
    if (/^[ +-]/.test(line)) {
      current.push(line);
      continue;
    }
    if (line.trim() === "") {
      current.push(" ");
      continue;
    }
    throw new Error(`OpenAI patch update for ${relativePath} contains an unsupported line: ${line}`);
  }
  if (current.length > 0) hunks.push(current);
  if (hunks.length === 0) throw new Error(`OpenAI patch update for ${relativePath} did not contain any hunks.`);
  return hunks;
}

function applyHunksToLines(oldLines, hunks, relativePath) {
  let cursor = 0;
  const output = [];
  for (const hunk of hunks) {
    cursor = applyHunkToLines(oldLines, hunk, relativePath, cursor, output);
  }
  output.push(...oldLines.slice(cursor));
  return output;
}

function applyHunkToLines(oldLines, hunk, relativePath, cursor, output) {
  const matchLines = hunk.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
  const start = findHunkStart(oldLines, matchLines, cursor);
  if (start === -1) {
    throw new Error(`OpenAI patch context mismatch for ${relativePath}. Re-read the file and regenerate the patch with current text.`);
  }
  output.push(...oldLines.slice(cursor, start));
  let lineIndex = start;
  for (const line of hunk) {
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      if (oldLines[lineIndex] !== content) throw new Error(`OpenAI patch context mismatch for ${relativePath} at '${content}'.`);
      output.push(content);
      lineIndex += 1;
    } else if (prefix === "-") {
      if (oldLines[lineIndex] !== content) throw new Error(`OpenAI patch delete mismatch for ${relativePath} at '${content}'.`);
      lineIndex += 1;
    } else if (prefix === "+") {
      output.push(content);
    }
  }
  return lineIndex;
}

function splitPatchText(text) {
  const normalized = String(text || "").replaceAll("\r\n", "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) lines.pop();
  return lines;
}

function joinPatchLines(lines, endsWithNewline) {
  const body = lines.join("\n");
  return endsWithNewline ? `${body}\n` : body;
}

function findHunkStart(lines, matchLines, fromIndex) {
  if (matchLines.length === 0) return fromIndex;
  for (let index = fromIndex; index <= lines.length - matchLines.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < matchLines.length; offset += 1) {
      if (lines[index + offset] !== matchLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function normalizeUnifiedDiffText(input) {
  return String(input || "").replaceAll("\r\n", "\n");
}

function diagnosePatchFailure(stderrText, patch, touchedPaths) {
  const text = String(stderrText || "");
  const diagnostics = [];
  if (/corrupt patch/i.test(text)) diagnostics.push("Patch hunks are malformed or incomplete.");
  if (/patch does not apply/i.test(text)) diagnostics.push("Patch context does not match the current file contents.");
  if (/No such file or directory/i.test(text)) diagnostics.push("One or more patch paths do not exist in the workspace.");
  if (/unrecognized input/i.test(text)) diagnostics.push("Patch format was not recognized by git apply.");
  if (/\r/.test(patch)) diagnostics.push("Patch contained CRLF line endings; convert to LF before applying.");
  if (!/^--- a\//m.test(patch) || !/^\+\+\+ b\//m.test(patch)) diagnostics.push("Unified diff headers must include --- a/path and +++ b/path lines.");
  if (diagnostics.length === 0) diagnostics.push("Re-read the target files and regenerate the patch with current context.");
  return { touchedPaths, diagnostics, raw: text.trim() };
}

export { relaiApplyPatch, normalizeOpenAIPatchFormat };
