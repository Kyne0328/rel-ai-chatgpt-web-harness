import { captureNativeMutationPaths } from './taskIntegrity.ts';
import { readGitObservation } from './repo/gitObservation.js';
import fs from 'node:fs';
import * as path from "node:path";
import * as crypto from "node:crypto";
import { collectTextFiles, collectOptionsFromWorkspace, writeTextFileSafe, resolveSafePath, fileSha256, looksBinary } from "./safety.js";
import { collectWorkspaceTextFiles, resolveWorkspaceSourcePath } from './workspaceSources.js';
import { discoverCommands } from "./commandDiscovery.js";
import { getStateDir } from './statePaths.js';
import { appendOperation, makeOperationId, summarizeOperations } from "./journal.js";
import { resolvePolicy } from "./policyResolver.js";
import { resolveBudget } from "./budgetResolver.ts";
import * as sessionCache from "./sessionCache.js";
import { relaiGitCommit, relaiGitPush, relaiGitDraftPr, classifyStatusOwnership } from "./repo/gitOps.js";
import { runProcess } from "./process.js";
import { INTERNAL_STATUS_MAX_BYTES } from "./repo/gitStatus.js";
import { clampNumber } from "./bridge/limits.js";
import { relaiVerify } from "./bridge/validation.js";
import { relaiHttpProbe } from "./bridge/httpProbe.js";
import { relaiDiff } from "./bridge/review.js";
import { relaiResetWorkspace, relaiRestorePaths } from "./bridge/restore.js";
import { workspaceTidyPlan, workspaceTidyRun as relaiWorkspaceTidyRun } from "./bridge/tidy.js";
import { relaiApplyPatch, normalizeOpenAIPatchFormat } from "./bridge/patch.js";
import { readProjectInstructions } from "./projectInstructions.js";
import { discoverSkills, readDiscoveredSkill } from './skillDiscovery.js';
import { discoverRepositoryTopology } from "./workflow/topology.js";
import { STAGED_WRITE_BYTE_THRESHOLD, STAGED_WRITE_LINE_THRESHOLD, workspaceWriteGuidance, analyzeFileShape, fileWriteGuidance } from "./bridge/writeGuidance.js";
import { outputSpillOwner, readOutputSpill } from './outputSpill.js';
import { createArtifactResourceLink } from './artifactResources.js';

type BridgeRecord = Record<string, any>;
type BridgeConfig = BridgeRecord;
type BridgeArgs = BridgeRecord;
type BridgeContext = BridgeRecord;
type BridgeValue = any;
type BridgeError = Error & BridgeRecord;

interface BridgeWorkspace extends BridgeRecord {
  alias: string;
  path: string;
  context?: BridgeRecord;
}

interface BridgeReadRequest extends BridgeRecord {
  paths: BridgeValue[];
  sessionActive: boolean;
  maxBytes: number;
}

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_CONNECTOR_READ_BYTES = 128 * 1024;
const DEFAULT_MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024;
const DEFAULT_CONNECTOR_TOTAL_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_FILES = 3000;
const LARGE_RANGE_STREAM_THRESHOLD = 512 * 1024;
const RANGE_READ_CHUNK_BYTES = 64 * 1024;
const EXACT_REPLACE_TEXT_BYTE_LIMIT = 50000;
const EXACT_REPLACE_MAX_OPERATIONS = 50;
const READ_IO_CONCURRENCY = 12;

async function repoSnapshot(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs = {}) {
  const policy = resolvePolicy(workspace, config || {});
  const configuredDefault = clampNumber(workspace.context?.snapshotMaxFiles, 1, 20000, DEFAULT_MAX_SNAPSHOT_FILES);
  const effectiveDefault = resolveBudget(configuredDefault, policy, config || {});
  const maxEntries = clampNumber(args.maxEntries, 1, 20000, effectiveDefault);
  const includeFiles = args.includeFiles === true;
  // The git summary is a child process; start it before the synchronous tree walk and
  // manifest reads so the spawn overlaps them instead of adding to them.
  const gitSummary = snapshotGitSummary(workspace, config);
  const tree = collectWorkspaceTextFiles(workspace, { maxEntries });
  const manifests = readManifests(workspace.path);
  const topology = discoverRepositoryTopology(workspace.path);
  const discoveredCommands = discoverCommands(workspace.path, { topology });
  const projectInstructions = readProjectInstructions(workspace, { targetPath: args.instructionPath });
  const skills = discoverSkills(workspace, { config });
  const git = await gitSummary;
  return {
    ok: true,
    workspace: workspace.alias,
    root: workspace.path,
    manifests: Object.keys(manifests),
    manifestContents: manifests,
    discoveredCommands,
    projectInstructions,
    skills,
    fileCount: tree.files.length,
    effectiveMaxEntries: maxEntries,
    budgetMultiplied: effectiveDefault !== configuredDefault,
    ...(includeFiles ? { files: tree.files } : {}),
    skipped: tree.skipped.slice(0, 200),
    truncated: tree.truncated,
    hints: projectHints(Object.keys(manifests)),
    ...(git ? { git } : {}),
    recommendedFlow: ["Use the minimum tool calls needed", "relai_search when the code location is unknown; adaptive context is included by default", "relai_read only when a wider range or complete file is needed before editing", "relai_edit for coherent repository changes; validation is explicit evidence chosen by the agent", "Use work_id only when durable task attribution, recovery, or task-scoped ownership is useful"],
    writeGuidance: workspaceWriteGuidance(),
    operationJournal: summarizeOperations(config, workspace, args.journalLimit || 10)
  };
}

// One bounded git status keeps snapshot+status a single round trip. Failure
// (non-git workspace, git missing) is silent: the snapshot stays useful without it.
async function snapshotGitSummary(workspace: BridgeWorkspace, config: BridgeConfig) {
  try {
    const stat = await readGitObservation(workspace.path, config, { coalesce: true });
    if (stat.exitCode !== 0 || stat.stdoutTruncated) return null;
    const ownership = classifyStatusOwnership(workspace, config, stat.stdout || "");
    return {
      branch: ownership.branch,
      aheadBehind: ownership.aheadBehind,
      unborn: ownership.unborn,
      dirtyFiles: ownership.entries.length,
      ...(ownership.entries.length ? { changedFiles: ownership.entries.slice(0, 20).map((entry) => entry.path) } : {})
    };
  } catch {
    return null;
  }
}

async function relaiReadAsync(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs = {}, context: BridgeContext = {}) {
  if (args.byteOffset !== undefined && (!args.outputRef || args.asResource === true)) {
    throw new Error('relai_read byteOffset requires outputRef and cannot be combined with asResource.');
  }
  if (args.asResource === true) return readArtifactLink(workspace, config, args, context);
  if (args.outputRef) return readSpilledOutput(workspace, config, args, context);
  if (args.skill) {
    if ((Array.isArray(args.paths) && args.paths.length) || (Array.isArray(args.ranges) && args.ranges.length)) {
      throw new Error('relai_read skill cannot be combined with paths or ranges.');
    }
    const item = readDiscoveredSkill(workspace, args.skill, { maxBytes: args.maxBytes, config });
    return {
      ok: true,
      workspace: workspace.alias,
      items: [item],
      skipped: [],
      requestedCount: 1,
      returnedCount: 1,
      ...(item.truncated ? { truncated: true } : {})
    };
  }
  const request = prepareReadRequest(workspace, config, args, context);
  const results = await mapWithConcurrency(request.paths, READ_IO_CONCURRENCY, (requested, index) => readSingleItemAsync(
    workspace,
    config,
    requested,
    request.sessionActive,
    request.maxBytes,
    args,
    readOptions(request, requested, index)
  ));
  return collectReadResults(workspace, results);
}

async function readArtifactLink(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs, context: BridgeContext) {
  if (args.skill || args.outputRef || (Array.isArray(args.ranges) && args.ranges.length) || args.startLine != null || args.endLine != null) {
    throw new Error('relai_read asResource cannot be combined with skill, outputRef, ranges, startLine, or endLine.');
  }
  if (!Array.isArray(args.paths) || args.paths.length !== 1) {
    throw new Error('relai_read asResource requires exactly one file in paths.');
  }
  const artifact = await createArtifactResourceLink(workspace, config, args.paths[0], {
    principal: context.principal
  });
  return {
    ok: true,
    workspace: workspace.alias,
    items: [{
      type: 'artifact',
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
      name: artifact.name,
      expiresAt: artifact.expiresAt,
      resourceUri: artifact.resourceLink.uri
    }],
    resourceLink: artifact.resourceLink,
    skipped: [],
    requestedCount: 1,
    returnedCount: 1
  };
}

async function readSpilledOutput(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs, context: BridgeContext) {
  if (args.skill || (Array.isArray(args.paths) && args.paths.length) || (Array.isArray(args.ranges) && args.ranges.length)) {
    throw new Error('relai_read outputRef cannot be combined with paths, ranges, or skill.');
  }
  const spillOwner = outputSpillOwner({
    taskId: context.taskId || args.work_id,
    workspace: workspace.alias,
    principal: context.principal
  });
  const spill = readOutputSpill(config, spillOwner, args.outputRef);
  const defaultMaxBytes = context.connector ? DEFAULT_CONNECTOR_READ_BYTES : DEFAULT_MAX_READ_BYTES;
  const maxBytes = clampNumber(args.maxBytes, 1000, 10 * 1024 * 1024, defaultMaxBytes);
  if (args.byteOffset !== undefined) {
    if (typeof args.byteOffset !== 'number' || !Number.isSafeInteger(args.byteOffset) || args.byteOffset < 0) {
      throw new Error('relai_read byteOffset must be a non-negative safe integer.');
    }
    if (args.startLine !== undefined || args.endLine !== undefined) {
      throw new Error('relai_read byteOffset cannot be combined with startLine or endLine.');
    }
    const byteOffset = Math.min(args.byteOffset, spill.bytes);
    // A byte chunk remains below the MCP cap even with six-byte JSON escapes.
    const length = Math.min(Math.floor(maxBytes), 64 * 1024, spill.bytes - byteOffset);
    const buffer = Buffer.alloc(length);
    const file = await fs.promises.open(spill.file, 'r');
    let returnedBytes = 0;
    try {
      if (length) ({ bytesRead: returnedBytes } = await file.read(buffer, 0, length, byteOffset));
    } finally { await file.close(); }
    if (length > 0 && returnedBytes === 0) throw new Error('Output spill changed during this read; retry the read cursor.');
    const data = buffer.subarray(0, returnedBytes);
    let content: string;
    let invalidUtf8 = false;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
    catch { content = data.toString('utf8'); invalidUtf8 = true; }
    const nextOffset = byteOffset + returnedBytes;
    const truncated = nextOffset < spill.bytes;
    return {
      ok: true,
      workspace: workspace.alias,
      items: [{
        type: 'output', outputRef: spill.outputRef, bytes: spill.bytes,
        byteOffset, nextOffset, returnedBytes, truncated, content, encoding: 'utf8',
        ...(invalidUtf8 ? { invalidUtf8: true, base64: data.toString('base64') } : {}),
        ...(truncated ? { hint: 'Continue relai_read with the same outputRef and byteOffset set to nextOffset. Decode base64 when invalidUtf8 is true for exact byte reconstruction.' } : {})
      }],
      skipped: [], requestedCount: 1, returnedCount: 1,
      ...(truncated ? { truncated: true } : {})
    };
  }
  const data = await fs.promises.readFile(spill.file);
  const text = data.toString('utf8');
  const selection = selectReadContent(text, normalizeReadLineRange(args), maxBytes);
  return {
    ok: true,
    workspace: workspace.alias,
    items: [{
      type: 'output',
      outputRef: spill.outputRef,
      bytes: spill.bytes,
      returnedBytes: selection.returnedBytes,
      lineCount: selection.totalLines,
      truncated: selection.truncated,
      ...(selection.truncated ? { hint: `Output spill truncated for this read. Re-call relai_read with outputRef plus startLine/endLine (spill has ${selection.totalLines} lines), or byteOffset: 0 for bounded byte chunks.` } : {}),
      ...(selection.lineRange ? { lineRange: selection.lineRange } : {}),
      content: selection.content
    }],
    skipped: [],
    requestedCount: 1,
    returnedCount: 1,
    ...(selection.truncated ? { truncated: true } : {})
  };
}

function prepareReadRequest(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs, context: BridgeContext): BridgeReadRequest {
  const normalizedRanges = normalizeReadRanges(args.ranges);
  const explicitPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const paths = explicitPaths ? args.paths : normalizedRanges.entries.map((entry: BridgeRecord) => entry.path);
  if (paths.length === 0) throw new Error("relai_read requires paths or ranges.");
  const policy = resolvePolicy(workspace, config || {});
  const sessionActive = policy?.sessionActive === true;
  const baseReadBytes = context.connector ? DEFAULT_CONNECTOR_READ_BYTES : DEFAULT_MAX_READ_BYTES;
  const defaultMaxBytes = resolveBudget(baseReadBytes, policy, config || {});
  const requestedMaxBytes = clampNumber(args.maxBytes, 1000, 10 * 1024 * 1024, defaultMaxBytes);
  const totalBudget = context.connector ? DEFAULT_CONNECTOR_TOTAL_READ_BYTES : DEFAULT_MAX_TOTAL_READ_BYTES;
  return {
    paths,
    sessionActive,
    maxBytes: Math.min(requestedMaxBytes, Math.max(1000, Math.floor(totalBudget / paths.length))),
    lineRange: normalizeReadLineRange(args),
    rangesByPath: normalizedRanges.byPath,
    orderedRanges: explicitPaths ? null : normalizedRanges.entries.map((entry: BridgeRecord) => entry.range),
    guidanceMode: normalizeReadGuidanceMode(args.guidanceMode, context.connector ? "compact" : "full")
  };
}

function readOptions(request: BridgeReadRequest, requested: BridgeValue, index: number): BridgeRecord {
  return {
    lineRange: request.orderedRanges?.[index] || request.rangesByPath.get(readRangeKey(requested)) || request.lineRange,
    guidanceMode: request.guidanceMode
  };
}

function collectReadResults(workspace: BridgeWorkspace, results: BridgeRecord[]) {
  const items = [];
  const skipped = [];
  for (const result of results) {
    if (result.item) items.push(result.item);
    if (result.skipped) skipped.push(result.skipped);
  }
  const ok = items.length > 0;
  const requestedCount = results.length;
  const returnedCount = items.length;
  return {
    ok,
    workspace: workspace.alias,
    items,
    skipped,
    requestedCount,
    returnedCount,
    ...(ok && skipped.length > 0 ? { partial: true } : {}),
    ...(items.some(item => item?.truncated === true) ? { truncated: true } : {}),
    ...(!ok ? { error: `None of the requested paths could be read. ${skipped.length} path(s) were skipped.` } : {})
  };
}

async function mapWithConcurrency(items: BridgeValue[], limit: number, mapper: (item: BridgeValue, index: number) => Promise<BridgeRecord> | BridgeRecord): Promise<BridgeRecord[]> {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// startLine/endLine apply to the whole batch, which forced one call per file whenever
// two files needed different windows. `ranges` overrides the batch window for the paths
// it names, so a multi-file targeted read is a single round trip.
function normalizeReadRanges(ranges: unknown): BridgeRecord {
  const byPath = new Map<string, BridgeRecord>();
  const entries: BridgeRecord[] = [];
  if (ranges == null) return { byPath, entries };
  if (!Array.isArray(ranges)) throw new Error("relai_read ranges must be an array of { path, startLine, endLine } objects.");
  for (const entry of ranges) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("relai_read ranges entries must be objects shaped { path, startLine, endLine }.");
    }
    const key = readRangeKey(entry.path);
    if (!key) throw new Error("relai_read ranges entries require a non-empty path.");
    const range = normalizeReadLineRange(entry);
    if (!range) throw new Error(`relai_read ranges entry for ${entry.path} requires startLine or endLine.`);
    byPath.set(key, range);
    entries.push({ path: entry.path, range });
  }
  return { byPath, entries };
}

// Match on the caller's own spelling of the path so a range lines up with the entry in
// `paths` without depending on how the path later resolves.
function readRangeKey(value: unknown): string {
  return String(value ?? "").trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

async function readSingleItemAsync(workspace: BridgeWorkspace, config: BridgeConfig, requested: BridgeValue, sessionActive: boolean, maxBytes: number, args: BridgeArgs, options: BridgeRecord): Promise<BridgeRecord> {
  try {
    const safe = resolveWorkspaceSourcePath(workspace, requested, { operation: "read" });
    const stat = await fs.promises.stat(safe.absolutePath);
    if (!stat.isFile()) {
      return stat.isDirectory()
        ? { item: readDirectory(workspace, safe, args) }
        : { skipped: { path: String(requested), reason: "not a file or directory" } };
    }
    const content = await readTextContentAsync(workspace, safe, stat, sessionActive, options, maxBytes);
    return readFileResult(workspace, safe, stat, sessionActive, maxBytes, options, content);
  } catch (error) {
    return { skipped: { path: String(requested), reason: error instanceof Error ? error.message : String(error) } };
  }
}

function readFileResult(workspace: BridgeWorkspace, safe: BridgeRecord, stat: fs.Stats, sessionActive: boolean, maxBytes: number, options: BridgeRecord, content: BridgeRecord): BridgeRecord {
  const { data, text, cacheHit, sha256 } = content;
  if (data === null && !cacheHit) {
    return { skipped: { path: safe.relativePath, reason: "binary-looking file" } };
  }
  const selection = content.selection || selectReadContent(text, options.lineRange, maxBytes);
  return {
    item: {
      type: "file",
      path: safe.relativePath,
      sha256,
      bytes: stat.size,
      returnedBytes: selection.returnedBytes,
      lineCount: selection.totalLines,
      truncated: selection.truncated,
      ...(selection.truncated ? { hint: `Content truncated. Re-call relai_read with startLine/endLine (file has ${selection.totalLines} lines).` } : {}),
      ...(selection.lineRange ? { lineRange: selection.lineRange } : {}),
      ...(safe.primarySource
        ? readGuidanceFields(options.guidanceMode, safe.relativePath, text)
        : options.guidanceMode === 'none' ? {} : { writeHint: 'Secondary source folders are read-only context. Edit files in the primary repository only.' }),
      content: selection.content,
      ...(sessionActive ? { cacheHit } : {})
    }
  };
}

function cachedReadContent(workspace: BridgeWorkspace, safe: BridgeRecord, stat: fs.Stats, sessionActive: boolean): BridgeRecord | null {
  if (!sessionActive) return null;
  const cached = sessionCache.getCachedReadEntry(workspace.alias, safe.absolutePath, stat.mtimeMs);
  if (cached === null) return null;
  return {
    data: null,
    text: cached.content,
    cacheHit: true,
    sha256: cached.sha256 || sha256Text(cached.content)
  };
}

function finalizeReadContent(workspace: BridgeWorkspace, safe: BridgeRecord, stat: fs.Stats, sessionActive: boolean, data: Buffer): BridgeRecord {
  if (looksBinary(data)) return { data: null, text: "", cacheHit: false, sha256: null };
  const text = data.toString("utf8");
  const sha256 = sha256Buffer(data);
  if (sessionActive) {
    sessionCache.setCachedRead(workspace.alias, safe.absolutePath, stat.mtimeMs, text, { sha256, bytes: data.length });
  }
  return { data, text, cacheHit: false, sha256 };
}

async function readTextContentAsync(workspace: BridgeWorkspace, safe: BridgeRecord, stat: fs.Stats, sessionActive: boolean, options: BridgeRecord = {}, maxBytes = DEFAULT_MAX_READ_BYTES): Promise<BridgeRecord> {
  const cached = cachedReadContent(workspace, safe, stat, sessionActive);
  if (cached) return cached;
  if (options.guidanceMode !== 'full' && stat.size >= LARGE_RANGE_STREAM_THRESHOLD) {
    const cachedMetadata = sessionCache.getCachedFileMetadata(workspace.alias, safe.absolutePath, stat.mtimeMs, stat.size);
    const ranged = await readLargeTextRangeAsync(safe.absolutePath, stat, options.lineRange || { startLine: 1 }, maxBytes, cachedMetadata);
    if (ranged.metadata) {
      sessionCache.setCachedFileMetadata(workspace.alias, safe.absolutePath, stat.mtimeMs, ranged.metadata);
    }
    if (!options.lineRange && ranged.selection) ranged.selection.lineRange = null;
    return ranged;
  }
  const data = await fs.promises.readFile(safe.absolutePath);
  return finalizeReadContent(workspace, safe, stat, sessionActive, data);
}

async function readLargeTextRangeAsync(file: string, stat: fs.Stats, requestedRange: BridgeRecord, maxBytes: number, cachedMetadata: BridgeRecord | null = null): Promise<BridgeRecord> {
  const handle = await fs.promises.open(file, 'r');
  const requestedEndLine = requestedRange.endLine || Number.POSITIVE_INFINITY;
  const fullScan = !cachedMetadata || !Number.isFinite(requestedEndLine);
  const hash = fullScan ? crypto.createHash('sha256') : null;
  const selected: Buffer[] = [];
  const startLine = requestedRange.startLine || 1;
  let currentLine = stat.size === 0 ? 0 : 1;
  let selectedBytes = 0;
  let truncated = false;
  let position = 0;
  try {
    while (position < stat.size) {
      const buffer = Buffer.allocUnsafe(Math.min(RANGE_READ_CHUNK_BYTES, stat.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (position === 0 && looksBinary(chunk)) return { data: null, text: '', cacheHit: false, sha256: null };
      hash?.update(chunk);
      let segmentStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 10) continue;
        appendRangeSegment(chunk.subarray(segmentStart, index + 1), currentLine);
        currentLine += 1;
        segmentStart = index + 1;
      }
      if (segmentStart < chunk.length) appendRangeSegment(chunk.subarray(segmentStart), currentLine);
      position += bytesRead;
      if (!fullScan && currentLine > requestedEndLine) break;
    }
  } finally {
    await handle.close();
  }
  const totalLines = fullScan ? (stat.size === 0 ? 0 : currentLine) : cachedMetadata.totalLines;
  const sha256 = fullScan ? hash!.digest('hex') : cachedMetadata.sha256;
  const endLine = Math.min(requestedEndLine, totalLines);
  const content = Buffer.concat(selected).toString('utf8').replace(/\uFFFD+$/u, '');
  const returnedBytes = Buffer.byteLength(content, 'utf8');
  return {
    data: Buffer.alloc(0),
    text: content,
    cacheHit: Boolean(cachedMetadata),
    sha256,
    ...(fullScan ? { metadata: { sha256, totalLines, bytes: stat.size } } : {}),
    selection: {
      content,
      returnedBytes,
      totalLines,
      truncated,
      lineRange: {
        startLine,
        endLine: startLine <= endLine ? endLine : startLine - 1,
        totalLines
      }
    }
  };

  function appendRangeSegment(segment: Buffer, lineNumber: number): void {
    if (!segment.length || lineNumber < startLine || lineNumber > requestedEndLine) return;
    const remaining = Math.max(0, maxBytes - selectedBytes);
    if (remaining === 0) {
      truncated = true;
      return;
    }
    if (segment.length <= remaining) {
      selected.push(segment);
      selectedBytes += segment.length;
      return;
    }
    selected.push(segment.subarray(0, remaining));
    selectedBytes += remaining;
    truncated = true;
  }
}

function normalizeReadLineRange(args: BridgeArgs = {}): BridgeRecord | null {
  const startLine = optionalPositiveInteger(args.startLine, "startLine");
  const endLine = optionalPositiveInteger(args.endLine, "endLine");
  if (startLine != null && endLine != null && endLine < startLine) {
    throw new Error("relai_read endLine must be greater than or equal to startLine.");
  }
  return startLine == null && endLine == null ? null : { startLine: startLine || 1, endLine };
}

function optionalPositiveInteger(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10000000) {
    throw new Error(`relai_read ${label} must be a positive integer no greater than 10000000.`);
  }
  return number;
}

function normalizeReadGuidanceMode(value: unknown, fallback: string): string {
  const mode = String(value || fallback || "full").trim().toLowerCase();
  if (!["full", "compact", "none"].includes(mode)) {
    throw new Error("relai_read guidanceMode must be one of: full, compact, none.");
  }
  return mode;
}

function selectReadContent(text: string, requestedRange: BridgeRecord | null, maxBytes: number): BridgeRecord {
  let totalLines;
  let selected = text;
  let lineRange = null;
  if (requestedRange) {
    const starts = lineStartOffsets(text);
    totalLines = text === "" ? 0 : starts.length;
    const startLine = requestedRange.startLine || 1;
    const requestedEndLine = requestedRange.endLine || totalLines;
    const endLine = Math.min(requestedEndLine, totalLines);
    selected = sliceLines(text, starts, startLine, endLine, totalLines);
    lineRange = {
      startLine,
      endLine: startLine <= endLine ? endLine : startLine - 1,
      totalLines
    };
  } else {
    totalLines = countLines(text);
  }
  const selectedBytes = Buffer.byteLength(selected, "utf8");
  const truncated = selectedBytes > maxBytes;
  const content = truncated ? truncateUtf8(selected, maxBytes) : selected;
  return {
    content,
    returnedBytes: truncated ? Buffer.byteLength(content, "utf8") : selectedBytes,
    totalLines,
    truncated,
    lineRange
  };
}

function lineStartOffsets(text: string): number[] {
  if (!text) return [];
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function sliceLines(text: string, starts: number[], startLine: number, endLine: number, totalLines: number): string {
  if (!text || totalLines === 0 || startLine > totalLines || endLine < startLine) return "";
  const startOffset = starts[startLine - 1];
  const endOffset = endLine < totalLines ? starts[endLine] : text.length;
  return text.slice(startOffset, endOffset);
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function readGuidanceFields(mode: string, relativePath: string, text: string): BridgeRecord {
  if (mode === "none") return {};
  if (mode === "full") return { writeGuidance: fileWriteGuidance(relativePath, text) };
  const shape = analyzeFileShape(relativePath, text);
  return shape.reasons.length
    ? { writeHint: "Large or interpolation-heavy file — prefer relai_edit with oldText/newText over a full rewrite." }
    : {};
}

const WRITE_STAGE_HANDLERS: Record<string, (workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs) => BridgeValue> = {
  direct: handleWriteDirect,
  "": handleWriteDirect,
  start: handleWriteStart,
  append: handleWriteAppend,
  commit: handleWriteCommit,
  abort: handleWriteAbort
};

function workspaceWrite(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs = {}) {
  const stage = String(args.stage || "direct").trim().toLowerCase();
  const handler = WRITE_STAGE_HANDLERS[stage];
  if (!handler) throw new Error("relai_edit staged write must use one of: direct, start, append, commit, abort.");
  return handler(workspace, config, args);
}

function handleWriteDirect(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs) {
  const relativePath = String(args.path || "").trim();
  if (!relativePath) throw new Error("Full-file edit requires path and content. Expected: { work_id, path, content }.");
  if (typeof args.content !== "string") throw new Error("Full-file edit requires content as a string containing the entire target file.");
  assertDirectWriteAllowed(relativePath, args.content);
  return performFullFileWrite(workspace, config, relativePath, args.content, {
    work_id: args.work_id,
    dryRun: Boolean(args.dryRun),
    suppressJournal: args.suppressJournal === true,
    expectedSha256: String(args.expectedSha256 || "").trim()
  });
}

function handleWriteStart(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs) {
  if (args.dryRun === true) throw new Error("Staged content start does not persist dry-run payloads. Use a direct dryRun edit to preview the full file.");
  const relativePath = String(args.path || "").trim();
  if (!relativePath) throw new Error("Staged content start requires path and content.");
  if (typeof args.content !== "string") throw new Error("Staged content start requires a content chunk string.");
  const safe = resolveSafePath(workspace.path, relativePath, { operation: "write" });
  const writeId = makeOperationId();
  createStagedPayload(config, workspace, writeId, {
    id: writeId, workspace: workspace.alias, root: workspace.path,
    path: safe.relativePath,
    expectedSha256: String(args.expectedSha256 || "").trim(),
    bytes: Buffer.byteLength(args.content, "utf8"),
    chunkCount: 1,
    createdAt: new Date().toISOString()
  }, args.content);
  return {
    ok: true, workspace: workspace.alias, path: safe.relativePath,
    operation: "stagedFullFileWrite:start", writeId, chunks: 1,
    bytes: Buffer.byteLength(args.content, "utf8"),
    next: "Call relai_edit with { work_id, stage: 'append', writeId, content } for more chunks, then { work_id, stage: 'commit', writeId } to write the complete file."
  };
}

function handleWriteAppend(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs) {
  if (args.dryRun === true) throw new Error("Staged content append does not persist dry-run payloads.");
  if (typeof args.content !== "string") throw new Error("Staged content append requires writeId and a content chunk string.");
  const writeId = resolveStagedWriteId(config, workspace, args.writeId, args.path);
  const payload = readStagedPayload(config, workspace, writeId);
  appendStagedPayload(config, workspace, writeId, args.content);
  payload.bytes += Buffer.byteLength(args.content, "utf8");
  payload.chunkCount += 1;
  payload.updatedAt = new Date().toISOString();
  writeStagedMetadata(config, workspace, writeId, payload);
  return {
    ok: true, workspace: workspace.alias, path: payload.path,
    operation: "stagedFullFileWrite:append", writeId,
    chunks: payload.chunkCount, bytes: payload.bytes,
    next: "Append more chunks or call relai_edit with { work_id, stage: 'commit', writeId }."
  };
}

function handleWriteCommit(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs) {
  const writeId = resolveStagedWriteId(config, workspace, args.writeId, args.path);
  const payload = readStagedPayload(config, workspace, writeId);
  const content = readStagedContent(config, workspace, writeId);
  if (Buffer.byteLength(content, "utf8") !== payload.bytes) {
    throw new Error(`Staged edit payload size mismatch for writeId ${writeId}. Abort it and start again.`);
  }
  const result = performFullFileWrite(workspace, config, payload.path, content, {
    work_id: args.work_id,
    dryRun: Boolean(args.dryRun),
    staged: true,
    writeId,
    suppressJournal: args.suppressJournal === true,
    expectedSha256: payload.expectedSha256 || ""
  });
  if (!args.dryRun) clearStagedPayload(config, workspace, writeId);
  return { ...result, operation: "stagedFullFileWrite:commit", writeId, staged: true, chunks: payload.chunkCount, bytes: payload.bytes };
}

function handleWriteAbort(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs) {
  const writeId = validateWriteId(args.writeId);
  const existed = clearStagedPayload(config, workspace, writeId);
  return { ok: true, workspace: workspace.alias, operation: "stagedFullFileWrite:abort", writeId, cleared: existed };
}

function applyReplacements(replacements: BridgeRecord[], oldContent: string, relativePath: string): BridgeRecord {
  let nextContent = oldContent;
  const results = [];
  for (let index = 0; index < replacements.length; index += 1) {
    const item = replacements[index]!;
    const before = nextContent;
    const totalMatches = countStringOccurrences(before, item.oldText);
    const recovery = replacementRecoveryDetails(before, item.oldText, totalMatches);
    if (totalMatches === 0) {
      throw exactReplacementError(
        `Exact replacement operation ${index + 1} found 0 matches in ${relativePath}.${formatRecoveryHint(recovery)}`,
        relativePath,
        recovery
      );
    }
    const hasExplicitOccurrence = item.occurrence != null;
    if (!hasExplicitOccurrence && totalMatches !== 1) {
      throw exactReplacementError(
        `Exact replacement operation ${index + 1} found ${totalMatches} matches in ${relativePath}.${formatRecoveryHint(recovery)} Pass occurrence to replace exactly one match, or use a larger unique oldText block.`,
        relativePath,
        recovery
      );
    }
    const occurrence = hasExplicitOccurrence ? item.occurrence : 1;
    if (occurrence > totalMatches) {
      throw exactReplacementError(
        `Exact replacement operation ${index + 1} requested occurrence ${occurrence}, but only ${totalMatches} matches exist in ${relativePath}.${formatRecoveryHint(recovery)}`,
        relativePath,
        recovery
      );
    }
    nextContent = replaceNth(before, item.oldText, item.newText, occurrence);
    results.push({ index: index + 1, matchesBefore: totalMatches, occurrence, oldBytes: Buffer.byteLength(item.oldText, "utf8"), newBytes: Buffer.byteLength(item.newText, "utf8"), changed: nextContent !== before });
  }
  return { nextContent, results };
}

function exactReplacementError(message: string, relativePath: string, recovery: BridgeRecord): BridgeError {
  const error = new Error(message) as BridgeError;
  error.code = 'EDIT_CONTEXT_MISMATCH';
  error.source = 'rel-ai-mcp';
  error.operation = 'write';
  error.path = relativePath;
  error.retryable = true;
  error.candidateCount = recovery.matchCount;
  error.matchLines = recovery.matchLines;
  error.candidateContexts = recovery.candidateContexts;
  error.currentSha256 = recovery.currentSha256;
  error.allowedAlternatives = [
    'Retry with occurrence when one of the returned exact match lines is intended.',
    'Retry with a larger unique oldText block using the returned current context.',
    'Call relai_read only when the returned context is insufficient.'
  ];
  return error;
}

function replacementRecoveryDetails(content: string, oldText: string, matchCount: number): BridgeRecord {
  const matchLines = exactMatchLines(content, oldText, 8);
  const candidateContexts = matchCount > 0
    ? matchLines.map(line => lineContext(content, line))
    : nearbyAnchorContexts(content, oldText, 5);
  return {
    matchCount,
    matchLines,
    candidateContexts,
    currentSha256: sha256Text(content)
  };
}

function exactMatchLines(content: string, needle: string, limit: number): number[] {
  const lines = [];
  let cursor = 0;
  while (lines.length < limit) {
    const found = content.indexOf(needle, cursor);
    if (found === -1) break;
    lines.push(1 + countStringOccurrences(content.slice(0, found), '\n'));
    cursor = found + needle.length;
  }
  return lines;
}

function nearbyAnchorContexts(content: string, oldText: string, limit: number): string[] {
  const anchors = String(oldText || '')
    .split(/\r?\n/)
    .map(line => line.trim().slice(0, 120))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (anchors.length === 0) return [];
  const lines = String(content || '').split(/\r?\n/);
  const candidates: string[] = [];
  for (let index = 0; index < lines.length && candidates.length < limit; index += 1) {
    const comparable = String(lines[index] || '').trim().slice(0, 240);
    if (!comparable) continue;
    if (anchors.some(anchor => comparable.includes(anchor) || anchor.includes(comparable))) {
      candidates.push(lineContext(content, index + 1));
    }
  }
  return candidates;
}

function lineContext(content: string, lineNumber: number): string {
  const lines = String(content || '').split(/\r?\n/);
  const index = Math.max(0, Number(lineNumber || 1) - 1);
  const start = Math.max(0, index - 1);
  const end = Math.min(lines.length, index + 2);
  return lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line.slice(0, 240)}`).join('\n');
}

function formatRecoveryHint(recovery: BridgeRecord): string {
  if (recovery.matchLines.length > 0) return ` Exact matches begin at lines ${recovery.matchLines.join(', ')}.`;
  if (recovery.candidateContexts.length > 0) return ` Nearby current context: ${recovery.candidateContexts[0]}`;
  return '';
}

function workspaceReplace(workspace: BridgeWorkspace, config: BridgeConfig, args: BridgeArgs = {}) {
  const safe = resolveSafePath(workspace.path, String(args.path || "").trim(), { operation: "replace" });
  if (!safe.relativePath) throw new Error("Exact replacement requires path.");
  const dryRun = Boolean(args.dryRun);
  if (!fs.existsSync(safe.absolutePath)) throw new Error(`Exact replacement target does not exist: ${safe.relativePath}`);
  const stat = fs.statSync(safe.absolutePath);
  if (!stat.isFile()) throw new Error(`Exact replacement target is not a file: ${safe.relativePath}`);
  const data = fs.readFileSync(safe.absolutePath);
  if (looksBinary(data)) throw new Error(`Exact replacement refuses binary-looking files: ${safe.relativePath}`);

  const oldSha256 = fileSha256(workspace.path, safe.relativePath);
  const expectedSha256 = String(args.expectedSha256 || "").trim();
  if (expectedSha256 && oldSha256 !== expectedSha256) {
    throw new Error(`Exact replacement refused stale expectedSha256 for ${safe.relativePath}. Expected ${expectedSha256}, current ${oldSha256 || "missing"}. Re-read the file and retry with current content.`);
  }
  const shaMismatch = false;

  const replacements = normalizeExactReplacements(args);
  const oldContent = data.toString("utf8");
  const { nextContent, results } = applyReplacements(replacements, oldContent, safe.relativePath);

  const changed = nextContent !== oldContent;
  const newSha256 = changed ? sha256Text(nextContent) : oldSha256;
  const operationId = makeOperationId();
  const result: BridgeRecord = {
    ok: true,
    dryRun,
    workspace: workspace.alias,
    operationId,
    operation: "exactReplace",
    path: safe.relativePath,
    changed,
    changedFiles: changed && !dryRun ? [safe.relativePath] : [],
    oldSha256,
    newSha256,
    ...(shaMismatch ? { shaMismatch: { expectedSha256, currentSha256: oldSha256 } } : {}),
    replacements: results
  };

  if (changed && !dryRun) {
    if (args.work_id) captureNativeMutationPaths(config, String(args.work_id), workspace.alias, [safe.relativePath]);
    const write = writeTextFileSafe(workspace.path, safe.relativePath, nextContent);
    const verifiedSha256 = fileSha256(workspace.path, safe.relativePath);
    if (verifiedSha256 !== write.sha256 || verifiedSha256 !== newSha256) {
      throw new Error(`Fresh read verification failed for ${safe.relativePath}. Expected ${newSha256}, got ${verifiedSha256 || "missing"}.`);
    }
    result.verified = true;
    result.bytes = write.bytes;
  }

  if (!dryRun && args.suppressJournal !== true) {
    appendOperation(config, workspace, {
      id: operationId,
      type: "replace",
      ok: true,
      paths: result.changedFiles,
      results: [{ path: safe.relativePath, operation: "exactReplace", changed, oldSha256, newSha256, verified: !changed || result.verified === true }]
    });
  }

  return result;
}

function assertDirectWriteAllowed(relativePath: string, content: string): void {
  const normalized = String(relativePath || "").replaceAll("\\", "/");
  if (/(^|\/)(dist|build|coverage|node_modules)\//.test(normalized) || /\.min\.[^.]+$/i.test(normalized)) return;
  const ext = path.extname(normalized).toLowerCase();
  const collapseGuardExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.dart', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.cs', '.cpp', '.c', '.h', '.hpp', '.rb', '.php', '.css', '.scss', '.html', '.xml', '.yaml', '.yml']);
  if (!collapseGuardExtensions.has(ext)) return;
  const text = String(content || "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < 4000) return;
  const newlines = countMatches(text, /\n/g);
  const averageLineBytes = bytes / Math.max(1, newlines + 1);
  if (newlines <= 2 && averageLineBytes > 2000) {
    throw new Error(`Full-file edit refused collapsed source-looking content for ${relativePath}. Use relai_edit with oldText/newText, updateText, or staged content with the original line breaks intact.`);
  }
}

function performFullFileWrite(workspace: BridgeWorkspace, config: BridgeConfig, relativePath: string, content: string, options: BridgeRecord = {}) {
  const dryRun = Boolean(options.dryRun);
  const operationId = options.writeId || makeOperationId();
  const safe = resolveSafePath(workspace.path, relativePath, { operation: "write", proposedContent: content });
  const exists = fs.existsSync(safe.absolutePath);
  const oldContent = exists ? fs.readFileSync(safe.absolutePath, "utf8") : "";
  const oldSha256 = exists ? fileSha256(workspace.path, safe.relativePath) : null;
  const expectedSha256 = String(options.expectedSha256 || "").trim();
  if (expectedSha256 && oldSha256 !== expectedSha256) {
    throw new Error(`Full-file edit refused stale expectedSha256 for ${safe.relativePath}. Expected ${expectedSha256}, current ${oldSha256 || "missing"}. Re-read the file and retry with current content.`);
  }
  const newContent = content;
  const changed = newContent !== oldContent;
  const newSha256 = sha256Text(newContent);

  const result: BridgeRecord = {
    ok: true,
    path: safe.relativePath,
    operation: options.staged ? "stagedFullFileWrite" : "fullFileWrite",
    changed,
    oldSha256,
    newSha256: changed ? newSha256 : oldSha256,
    ...(dryRun ? { dryRun: true } : {})
  };

  if (changed && !dryRun) {
    if (options.work_id) captureNativeMutationPaths(config, String(options.work_id), workspace.alias, [safe.relativePath]);
    const write = writeTextFileSafe(workspace.path, safe.relativePath, newContent);
    const verifiedSha256 = fileSha256(workspace.path, safe.relativePath);
    if (verifiedSha256 !== write.sha256) {
      throw new Error(`Fresh read verification failed for ${safe.relativePath}. Expected ${write.sha256}, got ${verifiedSha256 || "missing"}.`);
    }
    result.newSha256 = write.sha256;
    result.verified = write.verified === true;
    result.bytes = write.bytes;
  }

  const summary = {
    ok: true,
    dryRun,
    workspace: workspace.alias,
    operationId,
    changedFiles: changed && !dryRun ? [safe.relativePath] : [],
    result
  };

  if (!dryRun && options.suppressJournal !== true) {
    appendOperation(config, workspace, {
      id: operationId,
      type: "write",
      ok: true,
      paths: summary.changedFiles,
      results: [{
        path: safe.relativePath,
        operation: result.operation,
        changed,
        oldSha256,
        newSha256: result.newSha256,
        verified: result.verified === true || !changed
      }]
    });
  }

  return summary;
}

function stagedDir(config: BridgeConfig, workspace: BridgeWorkspace): string {
  const safeAlias = String(workspace.alias || "workspace").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(getStateDir(config), "write-staging", safeAlias);
}

function stagedMetadataPath(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string): string {
  return path.join(stagedDir(config, workspace), `${validateWriteId(writeId)}.json`);
}

function stagedPayloadPath(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string): string {
  return path.join(stagedDir(config, workspace), `${validateWriteId(writeId)}.payload`);
}

function validateWriteId(writeId: unknown): string {
  const text = String(writeId || "").trim();
  if (!/^op_[a-z0-9]+_[a-f0-9]{12}$/.test(text)) throw new Error("Invalid or missing staged edit writeId.");
  return text;
}

// Fallback only applies to staged writes touched within this window. Prevents an
// abandoned staged payload from a much earlier session being resurrected and
// committed (which could overwrite an unrelated tracked file).
const STAGED_FALLBACK_TTL_MS = 6 * 60 * 60 * 1000;
// Staged payloads older than this are pruned on any staged-write access.
const STAGED_PRUNE_TTL_MS = 24 * 60 * 60 * 1000;

// Resolve the writeId for a staged append/commit. ChatGPT must otherwise echo a
// long opaque writeId across three separate tool calls; a single dropped or
// mistyped id breaks the operation with "No staged payload found".
//
// Resolution order — each step is safe and NEVER guesses among ambiguous
// candidates (guessing the most-recent payload previously committed the wrong,
// stale file and could clobber an unrelated tracked file):
//   1. Exact writeId match against an existing staged file (no TTL).
//   2. If a path is supplied, the unique fresh staged write for that path.
//   3. Exactly one fresh staged write total (the normal single in-flight case).
//   4. Otherwise refuse and list the candidates so the caller passes id/path.
function resolveStagedWriteId(config: BridgeConfig, workspace: BridgeWorkspace, rawWriteId: unknown, targetPath: unknown): string {
  const text = String(rawWriteId || "").trim();
  if (text && /^op_[a-z0-9]+_[a-f0-9]{12}$/.test(text) && fs.existsSync(stagedMetadataPath(config, workspace, text))) {
    return text;
  }
  const fresh = listStagedPayloads(config, workspace)
    .filter((item) => item.ageMs == null || item.ageMs <= STAGED_FALLBACK_TTL_MS);

  const wantPath = stagedRelativePath(workspace, targetPath);
  if (wantPath) {
    const byPath = fresh.filter((item) => item.path === wantPath);
    if (byPath.length === 1) return byPath[0]!.id;
    if (byPath.length > 1) throw stagedAmbiguityError(byPath, text);
  }

  if (fresh.length === 1) return fresh[0]!.id;
  throw stagedAmbiguityError(fresh, text);
}

function stagedRelativePath(workspace: BridgeWorkspace, targetPath: unknown): string | null {
  const raw = String(targetPath || "").trim();
  if (!raw) return null;
  try {
    return resolveSafePath(workspace.path, raw).relativePath;
  } catch {
    return null;
  }
}

function stagedAmbiguityError(candidates: BridgeRecord[], suppliedId: unknown): Error {
  if (!candidates.length) {
    const idSuffix = suppliedId ? ` for writeId ${suppliedId}` : "";
    return new Error(`No staged edit payload found${idSuffix}. Start relai_edit with stage='start' and content/updateText first, or use a direct relai_edit call.`);
  }
  const list = candidates.map((item) => `${item.id} → ${item.path || "(unknown path)"}`).join("; ");
  return new Error(`Multiple staged edit payloads are pending; refusing to guess which to use. Pass the exact writeId, or the target path, for the one you mean. Pending: ${list}.`);
}

function listStagedPayloads(config: BridgeConfig, workspace: BridgeWorkspace): BridgeRecord[] {
  const dir = stagedDir(config, workspace);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const name of names) {
    const item = readStagedFile(dir, name, now);
    if (item) out.push(item);
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function readStagedFile(dir: string, name: string, now: number): BridgeRecord | null {
  if (!name.endsWith(".json")) return null;
  const id = name.slice(0, -5);
  if (!/^op_[a-z0-9]+_[a-f0-9]{12}$/.test(id)) return null;
  const file = path.join(dir, name);
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (mtime && (now - mtime) > STAGED_PRUNE_TTL_MS) {
    try { fs.rmSync(file, { force: true }); } catch {}
    try { fs.rmSync(path.join(dir, `${id}.payload`), { force: true }); } catch {}
    return null;
  }
  let payload;
  try { payload = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  return { id, path: payload.path || null, mtime, ageMs: mtime ? now - mtime : null };
}

function createStagedPayload(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string, metadata: BridgeRecord, content: string): void {
  const metadataFile = stagedMetadataPath(config, workspace, writeId);
  const payloadFile = stagedPayloadPath(config, workspace, writeId);
  fs.mkdirSync(path.dirname(metadataFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(payloadFile, content, { mode: 0o600, flag: "wx" });
  try {
    writeStagedMetadata(config, workspace, writeId, metadata);
  } catch (error) {
    fs.rmSync(payloadFile, { force: true });
    throw error;
  }
}

function writeStagedMetadata(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string, payload: BridgeRecord): void {
  const file = stagedMetadataPath(config, workspace, writeId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
}

function appendStagedPayload(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string, content: string): void {
  const file = stagedPayloadPath(config, workspace, writeId);
  if (!fs.existsSync(file)) throw new Error(`No staged edit payload found for writeId ${writeId}. Start again with relai_edit stage='start'.`);
  fs.appendFileSync(file, content, { encoding: "utf8" });
}

function readStagedPayload(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string): BridgeRecord {
  const metadataFile = stagedMetadataPath(config, workspace, writeId);
  const payloadFile = stagedPayloadPath(config, workspace, writeId);
  if (!fs.existsSync(metadataFile) || !fs.existsSync(payloadFile)) throw new Error(`No staged edit payload found for writeId ${writeId}. Start again with relai_edit stage='start'.`);
  const payload = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  if (payload.workspace !== workspace.alias || payload.root !== workspace.path) throw new Error("Staged edit payload belongs to a different workspace.");
  if (!Number.isInteger(payload.chunkCount) || payload.chunkCount < 1 || !Number.isInteger(payload.bytes) || payload.bytes < 0) {
    throw new Error(`Staged edit payload metadata is invalid for writeId ${writeId}. Abort it and start again.`);
  }
  return payload;
}

function readStagedContent(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string): string {
  return fs.readFileSync(stagedPayloadPath(config, workspace, writeId), "utf8");
}

function clearStagedPayload(config: BridgeConfig, workspace: BridgeWorkspace, writeId: string): boolean {
  const metadataFile = stagedMetadataPath(config, workspace, writeId);
  const payloadFile = stagedPayloadPath(config, workspace, writeId);
  const existed = fs.existsSync(metadataFile) || fs.existsSync(payloadFile);
  fs.rmSync(metadataFile, { force: true });
  fs.rmSync(payloadFile, { force: true });
  return existed;
}

function readDirectory(workspace: BridgeWorkspace, safe: BridgeRecord, args: BridgeArgs): BridgeRecord {
  const maxEntries = clampNumber(args.maxEntries, 1, 20000, 1000);
  const sourcePrefix = safe.sourceRelativePath === "." ? "" : safe.sourceRelativePath;
  const displayPrefix = safe.relativePath === "." ? "" : safe.relativePath;
  const result = collectTextFiles(path.join(safe.sourceRoot, sourcePrefix), collectOptionsFromWorkspace(workspace, { maxEntries, includeRoots: [] }));
  return {
    type: "directory",
    path: safe.relativePath,
    fileCount: result.files.length,
    files: result.files.map((item: string) => displayPrefix ? `${displayPrefix}/${item}` : item),
    skipped: result.skipped.map((item: BridgeRecord) => ({ ...item, path: displayPrefix ? `${displayPrefix}/${item.path}` : item.path })),
    truncated: result.truncated
  };
}

function readManifests(root: string): Record<string, string> {
  const names = ["package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "pubspec.yaml", "Makefile"];
  const out: Record<string, string> = {};
  for (const name of names) {
    const abs = path.join(root, name);
    if (!fs.existsSync(abs)) continue;
    try {
      const text = fs.readFileSync(abs, "utf8");
      out[name] = text.slice(0, 20000);
    } catch {}
  }
  return out;
}

function projectHints(manifests: string[]): string[] {
  const hints: string[] = [];
  if (manifests.includes("package.json")) hints.push("Node/JavaScript/TypeScript project");
  if (manifests.includes("pyproject.toml") || manifests.includes("requirements.txt")) hints.push("Python project");
  if (manifests.includes("Cargo.toml")) hints.push("Rust project");
  if (manifests.includes("go.mod")) hints.push("Go project");
  if (manifests.includes("pubspec.yaml")) hints.push("Flutter/Dart project");
  return hints;
}

function normalizeExactReplacements(args: BridgeArgs): BridgeRecord[] {
  let replacements;
  if (Array.isArray(args.replacements)) {
    replacements = args.replacements;
  } else if (Object.hasOwn(args, "oldText") || Object.hasOwn(args, "newText")) {
    replacements = [{ oldText: args.oldText, newText: args.newText, occurrence: args.occurrence }];
  } else {
    throw new Error("Exact replacement requires either { oldText, newText } or replacements: [{ oldText, newText, occurrence? }].");
  }
  if (!Array.isArray(replacements) || replacements.length === 0) throw new Error("replacements must contain at least one exact replacement operation.");
  if (replacements.length > EXACT_REPLACE_MAX_OPERATIONS) throw new Error(`Exact replacement accepts at most ${EXACT_REPLACE_MAX_OPERATIONS} operations.`);
  return replacements.map((item, index) => {
    const oldText = typeof item.oldText === "string" ? item.oldText : null;
    const newText = typeof item.newText === "string" ? item.newText : null;
    if (!oldText) throw new Error(`Exact replacement operation ${index + 1} requires non-empty oldText.`);
    if (newText == null) throw new Error(`Exact replacement operation ${index + 1} requires newText as a string. Use an empty string to clear text.`);
    if (Buffer.byteLength(oldText, "utf8") > EXACT_REPLACE_TEXT_BYTE_LIMIT) throw new Error(`Exact replacement operation ${index + 1} oldText exceeds ${EXACT_REPLACE_TEXT_BYTE_LIMIT} bytes. Use a smaller exact block.`);
    if (Buffer.byteLength(newText, "utf8") > EXACT_REPLACE_TEXT_BYTE_LIMIT) throw new Error(`Exact replacement operation ${index + 1} newText exceeds ${EXACT_REPLACE_TEXT_BYTE_LIMIT} bytes. Use smaller replacements or relai_edit content for unavoidable whole-file replacement.`);
    const occurrence = item.occurrence == null ? null : Number(item.occurrence);
    if (occurrence != null && (!Number.isInteger(occurrence) || occurrence < 1)) throw new Error(`Exact replacement operation ${index + 1} occurrence must be a positive integer.`);
    return { oldText, newText, occurrence };
  });
}

function countStringOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

function replaceNth(text: string, oldText: string, newText: string, occurrence: number): string {
  let cursor = 0;
  for (let seen = 1; seen <= occurrence; seen += 1) {
    const found = text.indexOf(oldText, cursor);
    if (found === -1) return text;
    if (seen === occurrence) {
      return text.slice(0, found) + newText + text.slice(found + oldText.length);
    }
    cursor = found + oldText.length;
  }
  return text;
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = String(text || "").match(pattern);
  return matches ? matches.length : 0;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256Text(text: string): string {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export { repoSnapshot, relaiReadAsync, workspaceWrite, workspaceReplace, relaiApplyPatch, relaiVerify, relaiHttpProbe, relaiDiff, relaiRestorePaths, relaiResetWorkspace, relaiGitCommit, relaiGitPush, relaiGitDraftPr, normalizeOpenAIPatchFormat, classifyStatusOwnership, STAGED_WRITE_BYTE_THRESHOLD, STAGED_WRITE_LINE_THRESHOLD, createStagedPayload, appendStagedPayload, writeStagedMetadata, readStagedPayload, readStagedContent, clearStagedPayload, resolveStagedWriteId, workspaceTidyPlan, relaiWorkspaceTidyRun as workspaceTidyRun };
