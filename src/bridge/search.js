import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import { resolveGitExecutable } from '../gitExecutable.js';
import { appendLimited, terminateProcessTree } from '../process.js';
import { makeProcessEnvironment } from '../processEnvironment.js';
import { collectOptionsFromWorkspace, isSecretPath } from '../safety.js';
import { clampNumber } from './limits.js';
import { buildContextualSearch } from './searchContext.js';
import { resolveSearchPlan } from './searchPlanner.js';
import { repositoryIntelligence } from '../repository/intelligence/service.js';
import { compactBatchResult, enforceBatchBudgets, resolveBatchLimit, resolveQueryTerms, runQueryBatch, splitBatchLimit, summarizeBatchResults } from './queryBatch.js';
import { qualifyWorkspaceSourcePath, sourceWorkspace, workspaceSourceEntries } from '../workspaceSources.js';
const DEFAULT_MAX_RESULTS = 200;
const MAX_LINE_CHARS = 400;
const SEARCH_TIMEOUT_MS = 25_000;
const MAX_STDERR_BYTES = 64 * 1024;
const FILESYSTEM_SEARCH_MAX_FILE_BYTES = 8 * 1024 * 1024;

// Stream git grep output instead of buffering it through runProcess. Broad searches
// can exceed the generic process-output cap; streaming preserves the earliest
// matches and stops once maxResults + 1 visible matches prove the response is truncated.
async function relaiSearchOne(workspace, config, args = {}, context = {}) {
  const pattern = String(args.pattern || "");
  if (!pattern.trim()) throw new Error("relai_search requires a non-empty pattern.");
  if (pattern.length > 1000) throw new Error("relai_search pattern must be 1000 characters or fewer.");
  const maxResults = clampNumber(args.maxResults, 1, 1000, DEFAULT_MAX_RESULTS);
  const gitArgs = ["grep", "-n", "-I", "--untracked", "--no-color", args.fixed === true ? "-F" : "-E"];
  if (args.ignoreCase === true) gitArgs.push("-i");
  gitArgs.push("-e", pattern);
  const glob = String(args.glob || "").trim();
  if (glob) gitArgs.push("--", glob);

  const result = await runWorkspaceSearch(workspace, gitArgs, args, maxResults, context.signal);

  const baseResult = {
    ok: true,
    workspace: workspace.alias,
    pattern,
    ...(glob ? { glob } : {}),
    matches: result.matches,
    matchCount: result.matchCount,
    truncated: result.truncated === true || result.matchCount > result.matches.length
  };
  const searchPlan = resolveSearchPlan(args, result);
  if (searchPlan.effectiveMode === "compact") {
    return {
      ...baseResult,
      ...(searchPlan.requestedMode === "auto" ? {
        mode: "auto",
        effectiveMode: "compact",
        autoTier: searchPlan.autoTier
      } : {}),
      next: result.timedOut && result.matches.length
        ? "Search reached its time budget and returned partial results. Narrow the pattern or glob if more coverage is needed."
        : result.matches.length
          ? "Read only the relevant ranges with relai_read { paths, startLine, endLine }."
          : "No matches. Try a shorter pattern, ignoreCase:true, or relai_snapshot for the file list."
    };
  }
  const cachedGraph = shouldUseGraphContext(searchPlan, workspace, config)
    ? await repositoryIntelligence.searchGraphContext(workspace, config, result.matches, { signal: context.signal })
    : null;
  const graphPrioritized = cachedGraph?.freshness === 'current' && Boolean(cachedGraph?.rankedPaths?.length);
  const workflowContext = {
    ...(args._workflowContext || {}),
    ...(graphPrioritized ? { graphPathScores: cachedGraph.pathScores } : {})
  };
  const contextual = await buildContextualSearch(workspace, result.matches, searchPlan.contextArgs, {
    requestedMode: searchPlan.requestedMode,
    autoTier: searchPlan.autoTier,
    selectionStrategy: graphPrioritized ? "path-match-density-and-graph" : searchPlan.selectionStrategy,
    prioritizeFiles: searchPlan.requestedMode === "auto",
    workflowContext
  });
  return {
    ...baseResult,
    ...contextual,
    next: result.timedOut && result.matches.length
      ? "Search reached its time budget and returned partial context. Narrow the pattern or glob if more coverage is needed."
      : result.matches.length
        ? searchPlan.requestedMode === "auto"
          ? graphPrioritized
            ? "Adaptive context is graph-prioritized using the cached structural index. Use relai_read only when a wider range or complete file is needed."
            : "Adaptive context is included for prioritized matches. Use relai_read only when a wider range or complete file is needed."
          : "Context is included. Use relai_read only when a wider range or complete file is needed."
        : "No matches. Try a shorter pattern, ignoreCase:true, or relai_snapshot for the file list."
  };
}

async function runWorkspaceSearch(workspace, gitArgs, args, maxResults, signal) {
  const sources = workspaceSourceEntries(workspace);
  const matches = [];
  let matchCount = 0;
  let truncated = false;
  let timedOut = false;
  let stderr = '';

  for (const source of sources) {
    if (signal?.aborted) throw searchAbortError(signal);
    const scoped = sourceWorkspace(workspace, source);
    const remaining = Math.max(0, maxResults - matches.length);
    let result = await runGitGrep(scoped, gitArgs, remaining, signal);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      const failure = String(result.stderr || result.error || '');
      if (/not a git repository/i.test(failure)) {
        result = await runFilesystemSearch(scoped, args, remaining, signal);
      } else {
        throw new Error(`relai_search failed in source folder ${source.number}: ${failure || `git grep exited ${result.exitCode}`}`);
      }
    }

    matchCount += Number(result.matchCount || 0);
    truncated ||= result.truncated === true;
    timedOut ||= result.timedOut === true;
    if (result.stderr) stderr = appendLimited(stderr, `${stderr ? '\n' : ''}${result.stderr}`, MAX_STDERR_BYTES);
    for (const match of result.matches || []) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      matches.push({ ...match, path: qualifyWorkspaceSourcePath(source, match.path) });
    }
    if (matchCount > matches.length) truncated = true;
  }

  return {
    exitCode: matches.length ? 0 : 1,
    matches,
    matchCount,
    truncated,
    timedOut,
    stderr: stderr.trim()
  };
}

async function collectFilesystemSearchTree(root, options, signal, deadline) {
  if (signal?.aborted) throw searchAbortError(signal);
  const remainingMs = Math.max(1, deadline - Date.now());
  const worker = new Worker(new URL('./filesystemSearchCollectorWorker.js', import.meta.url), {
    workerData: { root, options }
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.removeAllListeners();
      void worker.terminate().catch(() => {});
      action(value);
    };
    const onAbort = () => finish(reject, searchAbortError(signal));
    const timer = setTimeout(() => finish(resolve, { files: [], skipped: [], truncated: true, timedOut: true }), remainingMs);
    timer.unref?.();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.once('message', message => {
      if (message?.ok === true) finish(resolve, { ...message.result, timedOut: false });
      else finish(reject, new Error(String(message?.error || 'Filesystem search collection failed.')));
    });
    worker.once('error', error => finish(reject, error));
    worker.once('exit', code => {
      if (!settled && code !== 0) finish(reject, new Error(`Filesystem search collector exited with code ${code}.`));
    });
  });
}

async function runFilesystemSearch(workspace, args, maxResults, signal) {
  if (signal?.aborted) throw searchAbortError(signal);
  const pattern = String(args.pattern || '');
  const flags = args.ignoreCase === true ? 'i' : '';
  let expression = null;
  if (args.fixed !== true) {
    try { expression = new RegExp(pattern, flags); }
    catch (error) { throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  const needle = args.ignoreCase === true ? pattern.toLowerCase() : pattern;
  const glob = String(args.glob || '').trim();
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  const tree = await collectFilesystemSearchTree(
    workspace.path,
    collectOptionsFromWorkspace(workspace, { maxEntries: 50_000 }),
    signal,
    deadline
  );
  const matches = [];
  let matchCount = 0;
  let truncated = tree.truncated === true;
  let timedOut = false;
  let skippedLargeFiles = 0;
  if (tree.timedOut) {
    return { exitCode: 1, matches, matchCount, truncated: true, timedOut: true, stderr: '' };
  }

  outer: for (const relativePath of tree.files) {
    if (signal?.aborted) throw searchAbortError(signal);
    if (Date.now() >= deadline) {
      timedOut = true;
      truncated = true;
      break;
    }
    if (glob && typeof path.matchesGlob === 'function' && !path.matchesGlob(relativePath, glob)) continue;
    const absolutePath = path.join(workspace.path, relativePath);
    let stat;
    try { stat = await fs.promises.stat(absolutePath); }
    catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > FILESYSTEM_SEARCH_MAX_FILE_BYTES) {
      skippedLargeFiles += 1;
      truncated = true;
      continue;
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    const timeoutSignal = AbortSignal.timeout(remainingMs);
    const readSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let text;
    try {
      text = await fs.promises.readFile(absolutePath, { encoding: 'utf8', signal: readSignal });
    } catch {
      if (signal?.aborted) throw searchAbortError(signal);
      if (timeoutSignal.aborted) {
        timedOut = true;
        truncated = true;
        break;
      }
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (signal?.aborted) throw searchAbortError(signal);
      if ((index & 255) === 0 && Date.now() >= deadline) {
        timedOut = true;
        truncated = true;
        break outer;
      }
      const line = lines[index];
      const matched = args.fixed === true
        ? (args.ignoreCase === true ? line.toLowerCase().includes(needle) : line.includes(needle))
        : expression.test(line);
      if (!matched) continue;
      matchCount += 1;
      if (matches.length < maxResults) {
        matches.push({ path: relativePath, line: index + 1, text: line.slice(0, MAX_LINE_CHARS) });
        continue;
      }
      truncated = true;
      break outer;
    }
  }
  return {
    exitCode: matches.length ? 0 : 1,
    matches,
    matchCount,
    truncated,
    timedOut,
    filesystemFallback: true,
    skippedLargeFiles,
    stderr: ''
  };
}

function shouldUseGraphContext(searchPlan, workspace, config) {
  if (workspaceSourceEntries(workspace).length > 1) return false;
  if (searchPlan.requestedMode !== 'auto' || searchPlan.autoTier === 'focused') return false;
  try {
    const status = repositoryIntelligence.status(workspace, config);
    return status.dirty !== true && status.metadata?.freshness === 'current';
  } catch {
    return false;
  }
}

async function relaiSearch(workspace, config, args = {}, context = {}) {
  const { batched, terms } = resolveQueryTerms(args, {
    singleField: 'pattern',
    label: 'relai_search',
    maxLength: 1000,
    maxItems: 4
  });
  if (!batched) return relaiSearchOne(workspace, config, args, context);

  const totalMaxResults = resolveBatchLimit(args.maxResults, { min: 1, max: 1000, fallback: DEFAULT_MAX_RESULTS });
  const totalMaxBytes = resolveBatchLimit(args.maxBytes, { min: 1000, max: 393216, fallback: 393216 });
  const maxResults = splitBatchLimit(totalMaxResults, {
    min: 1,
    max: 1000,
    fallback: DEFAULT_MAX_RESULTS,
    count: terms.length
  });
  const maxBytes = splitBatchLimit(totalMaxBytes, {
    min: 1000,
    max: 393216,
    fallback: 393216,
    count: terms.length
  });
  const batch = await runQueryBatch(terms, pattern => relaiSearchOne(workspace, config, {
    ...args,
    pattern,
    queries: undefined,
    maxResults,
    maxBytes
  }, context), { signal: context.signal, kind: 'search-text' });
  const results = enforceBatchBudgets(batch.results, { maxResults: totalMaxResults, maxBytes: totalMaxBytes });
  return {
    ok: true,
    workspace: workspace.alias,
    queries: terms,
    queryCount: terms.length,
    maxBytes: totalMaxBytes,
    execution: batch.metrics,
    results: results.map(compactBatchResult),
    ...summarizeBatchResults(results),
    next: 'Batched search completed in one call. Read only the most relevant returned ranges or refine the smallest query that still needs more evidence.'
  };
}

function runGitGrep(workspace, gitArgs, maxResults, signal) {
  if (signal?.aborted) return Promise.reject(searchAbortError(signal));
  return new Promise((resolve, reject) => {
    const executable = resolveGitExecutable() || "git";
    const child = spawn(executable, gitArgs, {
      cwd: workspace.path,
      env: makeProcessEnvironment(),
      shell: false,
      detached: process.platform !== "win32"
    });
    const decoder = new StringDecoder("utf8");
    const matches = [];
    let matchCount = 0;
    let pending = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    const onAbort = () => {
      void settleAfterTermination({ error: searchAbortError(signal) });
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    function consumeLine(rawLine) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line) return;
      const match = parseGitGrepLine(line);
      if (!match || isSecretPath(match.path)) return;
      matchCount += 1;
      if (matches.length < maxResults) {
        matches.push(match);
        return;
      }
      void settleAfterTermination({
        payload: {
          exitCode: 0,
          signal: "SIGKILL",
          matches,
          matchCount,
          truncated: true,
          stderr: stderr.trim()
        }
      });
    }

    function consumeChunk(text, flush = false) {
      if (settled || terminating) return;
      pending += text;
      let newlineIndex = pending.indexOf("\n");
      while (!settled && !terminating && newlineIndex >= 0) {
        consumeLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
      if (!settled && flush && pending) {
        consumeLine(pending);
        pending = "";
      }
    }

    let timer = setTimeout(() => {
      const hasPartialResults = matches.length > 0;
      void settleAfterTermination({
        payload: {
          exitCode: hasPartialResults ? 0 : -1,
          signal: "SIGKILL",
          matches,
          matchCount,
          truncated: hasPartialResults,
          timedOut: true,
          stderr: appendLimited(stderr, `\n[rel-ai-mcp timed out after ${SEARCH_TIMEOUT_MS}ms]\n`, MAX_STDERR_BYTES).trim(),
          error: `Timed out after ${SEARCH_TIMEOUT_MS}ms`
        }
      });
    }, SEARCH_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      signal?.removeEventListener?.('abort', onAbort);
    }

    async function settleAfterTermination({ payload, error } = {}) {
      if (settled || terminating) return;
      terminating = true;
      cleanup();
      try {
        await terminateProcessTree(child, { graceMs: 0 });
      } finally {
        if (error) fail(error);
        else finish(payload);
      }
    }

    function finish(payload) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }

    child.stdout.on("data", (chunk) => consumeChunk(decoder.write(chunk)));
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      if (terminating) return;
      finish({ exitCode: -1, matches, matchCount, stderr: stderr.trim(), error: error.message });
    });
    child.on("close", (code, signal) => {
      if (settled || terminating) return;
      consumeChunk(decoder.end(), true);
      finish({
        exitCode: typeof code === "number" ? code : -1,
        signal: signal || undefined,
        matches,
        matchCount,
        stderr: stderr.trim()
      });
    });
  });
}

function searchAbortError(signal) {
  if (signal?.reason instanceof Error) {
    const error = new Error(signal.reason.message);
    error.name = 'AbortError';
    return error;
  }
  const error = new Error('Repository search cancelled.');
  error.name = 'AbortError';
  return error;
}

function parseGitGrepLine(line) {
  const first = line.indexOf(":");
  const second = line.indexOf(":", first + 1);
  if (first <= 0 || second <= first) return null;
  const relativePath = line.slice(0, first);
  const lineNumber = Number(line.slice(first + 1, second));
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null;
  return {
    path: relativePath,
    line: lineNumber,
    text: line.slice(second + 1).slice(0, MAX_LINE_CHARS)
  };
}

export { relaiSearch };
