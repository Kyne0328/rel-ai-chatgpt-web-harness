import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { looksBinary } from "../safety.js";
import { resolveWorkspaceSourcePath } from '../workspaceSources.js';
import { clampNumber } from "./limits.js";
import { rankMatchGroups } from "./searchPlanner.js";
import * as sessionCache from "../sessionCache.js";

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_RANGES_PER_FILE = 20;
const DEFAULT_MAX_RANGE_LINES = 200;
const DEFAULT_MAX_CONTEXT_BYTES = 128 * 1024;

async function buildContextualSearch(workspace, matches, args = {}, metadata = {}) {
  const options = normalizeContextOptions(args);
  const groupedMatches = groupMatchesByFile(matches);
  const groups = metadata.prioritizeFiles
    ? rankMatchGroups(groupedMatches, args.pattern, metadata.workflowContext)
    : groupedMatches;
  const selectedGroups = groups.slice(0, options.maxFiles);
  const files = [];
  const skipped = [];
  let remainingBytes = options.maxBytes;
  let returnedBytes = 0;
  let returnedRangeCount = 0;
  let contextMatchCount = 0;
  let omittedFiles = Math.max(0, groups.length - selectedGroups.length);
  let omittedRanges = 0;
  let contentTruncated = false;

  for (let groupIndex = 0; groupIndex < selectedGroups.length; groupIndex += 1) {
    if (remainingBytes <= 0) {
      omittedFiles += selectedGroups.length - groupIndex;
      break;
    }
    const group = selectedGroups[groupIndex];
    const fileResult = await readContextFile(workspace, group, options, remainingBytes, metadata.workflowContext);
    if (fileResult.skipped) {
      skipped.push(fileResult.skipped);
      continue;
    }
    const file = fileResult.file;
    remainingBytes -= fileResult.returnedBytes;
    returnedBytes += fileResult.returnedBytes;
    returnedRangeCount += file.ranges.length;
    contextMatchCount += file.returnedMatchCount;
    omittedRanges += fileResult.omittedRanges;
    contentTruncated ||= fileResult.contentTruncated;
    if (file.ranges.length) files.push(file);
  }

  const result = {
    mode: metadata.requestedMode || "context",
    ...(metadata.requestedMode === "auto" ? {
      effectiveMode: "context",
      autoTier: metadata.autoTier,
      selectionStrategy: metadata.selectionStrategy
    } : {}),
    contextBefore: options.contextBefore,
    contextAfter: options.contextAfter,
    groupByFile: options.groupByFile,
    mergeOverlaps: options.mergeOverlaps,
    maxFiles: options.maxFiles,
    maxRangesPerFile: options.maxRangesPerFile,
    maxRangeLines: options.maxRangeLines,
    returnedFileCount: files.length,
    returnedRangeCount,
    contextMatchCount,
    returnedBytes,
    maxBytes: options.maxBytes,
    omittedFiles,
    omittedRanges,
    contextTruncated: omittedFiles > 0 || omittedRanges > 0 || skipped.length > 0 || contentTruncated,
    ...(skipped.length ? { contextSkipped: skipped } : {})
  };

  if (options.groupByFile) return { ...result, files };
  return { ...result, contexts: flattenContextFiles(files) };
}

function normalizeContextOptions(args) {
  return {
    contextBefore: integerOption(args.contextBefore, 0, 100, DEFAULT_CONTEXT_LINES),
    contextAfter: integerOption(args.contextAfter, 0, 100, DEFAULT_CONTEXT_LINES),
    groupByFile: args.groupByFile !== false,
    mergeOverlaps: args.mergeOverlaps !== false,
    maxFiles: integerOption(args.maxFiles, 1, 200, DEFAULT_MAX_FILES),
    maxRangesPerFile: integerOption(args.maxRangesPerFile, 1, 100, DEFAULT_MAX_RANGES_PER_FILE),
    maxRangeLines: integerOption(args.maxRangeLines, 1, 1000, DEFAULT_MAX_RANGE_LINES),
    maxBytes: integerOption(args.maxBytes, 1000, 384 * 1024, DEFAULT_MAX_CONTEXT_BYTES)
  };
}

function integerOption(value, min, max, fallback) {
  const clamped = clampNumber(value, min, max, fallback);
  return Math.floor(clamped);
}

function groupMatchesByFile(matches) {
  const groups = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match?.path || !Number.isInteger(match.line)) continue;
    if (!groups.has(match.path)) groups.set(match.path, []);
    groups.get(match.path).push(match);
  }
  return [...groups.entries()].map(([path, fileMatches]) => ({ path, matches: fileMatches }));
}

async function readContextFile(workspace, group, options, byteBudget, workflowContext = {}) {
  try {
    const safe = resolveWorkspaceSourcePath(workspace, group.path, { operation: "read" });
    let stat;
    let cached;
    let data;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      stat = await fs.promises.stat(safe.absolutePath);
      if (!stat.isFile()) return { skipped: { path: group.path, reason: "not a file" } };
      cached = sessionCache.getCachedReadEntry(workspace.alias, safe.absolutePath, stat);
      data = cached ? null : await fs.promises.readFile(safe.absolutePath);
      if (sessionCache.sameFileStat(stat, await fs.promises.stat(safe.absolutePath))) break;
      sessionCache.invalidatePath(workspace.alias, safe.absolutePath);
      if (attempt === 1) throw new Error("File changed while reading search context; retry for a consistent snapshot.");
    }
    if (data && looksBinary(data)) return { skipped: { path: group.path, reason: "binary-looking file" } };
    const text = cached ? cached.content : data.toString("utf8");
    const lines = splitLines(text);
    const matchLines = uniqueSortedLines(group.matches, lines.length);
    const sha256 = cached?.sha256 || crypto.createHash("sha256").update(data || text).digest("hex");
    if (!cached) sessionCache.setCachedRead(workspace.alias, safe.absolutePath, stat, text, { sha256, bytes: data.length });
    const allRanges = buildRanges(matchLines, lines.length, options).filter(range => !rangeAlreadyRead(group.path, sha256, range, workflowContext));
    const selectedRanges = allRanges.slice(0, options.maxRangesPerFile);
    const ranges = [];
    let remainingBytes = byteBudget;
    let returnedBytes = 0;
    let contentTruncated = false;
    let omittedRanges = Math.max(0, allRanges.length - selectedRanges.length);

    for (let index = 0; index < selectedRanges.length; index += 1) {
      if (remainingBytes <= 0) {
        omittedRanges += selectedRanges.length - index;
        break;
      }
      const fitted = fitRangeToBudget(lines, selectedRanges[index], remainingBytes);
      if (!fitted) {
        omittedRanges += selectedRanges.length - index;
        break;
      }
      ranges.push(fitted);
      remainingBytes -= fitted.returnedBytes;
      returnedBytes += fitted.returnedBytes;
      contentTruncated ||= fitted.contentTruncated === true;
    }

    const returnedMatchCount = new Set(ranges.flatMap((range) => range.matchLines)).size;
    return {
      file: {
        path: safe.relativePath,
        sha256,
        bytes: stat.size,
        lineCount: lines.length,
        matchCount: matchLines.length,
        returnedMatchCount,
        ranges
      },
      returnedBytes,
      omittedRanges,
      contentTruncated
    };
  } catch (error) {
    return {
      skipped: {
        path: group.path,
        reason: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function rangeAlreadyRead(filePath, sha256, range, context = {}) {
  const target = String(filePath || '').replaceAll('\\', '/');
  return (context.readEvidence || []).some(item => {
    if (String(item?.path || '').replaceAll('\\', '/') !== target || String(item?.sha256 || '') !== sha256) return false;
    const startLine = Number(item.startLine || 1);
    const endLine = Number(item.endLine || Number.MAX_SAFE_INTEGER);
    return startLine <= range.startLine && endLine >= range.endLine;
  });
}
function splitLines(text) {
  if (text === "") return [];
  return String(text).split(/\r\n|\n|\r/);
}

function uniqueSortedLines(matches, lineCount) {
  const unique = new Set();
  for (const match of matches) {
    if (Number.isInteger(match.line) && match.line >= 1 && match.line <= lineCount) unique.add(match.line);
  }
  return [...unique].sort((left, right) => left - right);
}

function buildRanges(matchLines, lineCount, options) {
  const windows = matchLines.map((line) => rangeAroundMatch(line, lineCount, options));
  if (!options.mergeOverlaps) return windows;
  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    const mergedEnd = previous ? Math.max(previous.endLine, window.endLine) : window.endLine;
    const canMerge = previous
      && window.startLine <= previous.endLine + 1
      && mergedEnd - previous.startLine + 1 <= options.maxRangeLines;
    if (!canMerge) {
      merged.push({ ...window, matchLines: [...window.matchLines] });
      continue;
    }
    previous.endLine = mergedEnd;
    previous.matchLines = [...new Set([...previous.matchLines, ...window.matchLines])].sort((a, b) => a - b);
  }
  return merged;
}

function rangeAroundMatch(line, lineCount, options) {
  let startLine = Math.max(1, line - options.contextBefore);
  let endLine = Math.min(lineCount, line + options.contextAfter);
  if (endLine - startLine + 1 > options.maxRangeLines) {
    const before = Math.min(line - startLine, Math.floor((options.maxRangeLines - 1) / 2));
    startLine = Math.max(1, line - before);
    endLine = Math.min(lineCount, startLine + options.maxRangeLines - 1);
    startLine = Math.max(1, Math.min(startLine, endLine - options.maxRangeLines + 1));
  }
  return { startLine, endLine, matchLines: [line] };
}

function fitRangeToBudget(lines, range, byteBudget) {
  const requestedStartLine = range.startLine;
  const requestedEndLine = range.endLine;
  let startLine = requestedStartLine;
  let endLine = requestedEndLine;
  const firstMatchLine = range.matchLines[0];
  const lastMatchLine = range.matchLines.at(-1);
  let content = joinLines(lines, startLine, endLine);
  let returnedBytes = Buffer.byteLength(content, "utf8");

  while (returnedBytes > byteBudget && (startLine < firstMatchLine || endLine > lastMatchLine)) {
    const beforeDistance = firstMatchLine - startLine;
    const afterDistance = endLine - lastMatchLine;
    if (afterDistance >= beforeDistance && endLine > lastMatchLine) endLine -= 1;
    else if (startLine < firstMatchLine) startLine += 1;
    content = joinLines(lines, startLine, endLine);
    returnedBytes = Buffer.byteLength(content, "utf8");
  }

  if (returnedBytes > byteBudget) {
    startLine = firstMatchLine;
    endLine = firstMatchLine;
    content = truncateUtf8(String(lines[firstMatchLine - 1] || ""), byteBudget);
    returnedBytes = Buffer.byteLength(content, "utf8");
  }
  if (returnedBytes > byteBudget) return null;

  const actualMatchLines = range.matchLines.filter((line) => line >= startLine && line <= endLine);
  const contentTruncated = startLine !== requestedStartLine
    || endLine !== requestedEndLine
    || returnedBytes < Buffer.byteLength(joinLines(lines, startLine, endLine), "utf8");
  return {
    startLine,
    endLine,
    matchLines: actualMatchLines.length ? actualMatchLines : [firstMatchLine],
    content,
    returnedBytes,
    ...(contentTruncated ? {
      contentTruncated: true,
      requestedStartLine,
      requestedEndLine
    } : {})
  };
}

function joinLines(lines, startLine, endLine) {
  if (!lines.length || endLine < startLine) return "";
  return lines.slice(startLine - 1, endLine).join("\n");
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(String(text), "utf8");
  if (buffer.length <= maxBytes) return String(text);
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

function flattenContextFiles(files) {
  return files.flatMap((file) => file.ranges.map((range) => ({
    path: file.path,
    sha256: file.sha256,
    bytes: file.bytes,
    lineCount: file.lineCount,
    ...range
  })));
}

export { buildContextualSearch };
