import { parallel, runPlan, step } from '../executionPlan.js';
import { createExecutionPlanObserver, recordExecutionPlanMetrics } from '../executionObservability.js';

function resolveQueryTerms(args = {}, options = {}) {
  const singleField = String(options.singleField || 'query');
  const label = String(options.label || singleField);
  const maxLength = Number(options.maxLength) || 1000;
  const maxItems = Number(options.maxItems) || 4;
  const single = typeof args[singleField] === 'string' ? args[singleField] : '';
  const batch = Array.isArray(args.queries) ? args.queries : null;

  if (batch && single.trim()) throw new Error(`Provide ${singleField} or queries, not both.`);
  if (!batch) return { batched: false, terms: [single] };
  if (batch.length < 1 || batch.length > maxItems) {
    throw new Error(`${label} queries must contain between 1 and ${maxItems} items. Received ${batch.length}.`);
  }

  const terms = [];
  const seen = new Set();
  for (const value of batch) {
    const term = String(value || '');
    if (!term.trim()) throw new Error(`${label} queries must not contain empty values.`);
    if (term.length > maxLength) throw new Error(`${label} queries must be ${maxLength} characters or fewer.`);
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return { batched: true, terms };
}

function resolveBatchLimit(value, { min, max, fallback }) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.min(max, Math.max(min, Math.floor(numeric)))
    : fallback;
}

function splitBatchLimit(value, { min, max, fallback, count }) {
  const total = resolveBatchLimit(value, { min, max, fallback });
  return Math.max(min, Math.ceil(total / Math.max(1, count)));
}

function compactBatchResult(value) {
  if (!value || typeof value !== 'object') return value;
  const { ok: _ok, workspace: _workspace, next: _next, ...rest } = value;
  return rest;
}

async function runQueryBatch(terms, execute, options = {}) {
  if (options.signal?.aborted) throw queryBatchAbortError(options.signal);
  const plan = parallel(
    terms.map((term, index) => step(`query ${index + 1}`, () => execute(term, index), {
      metadata: { index, term, displayName: term }
    })),
    { maxConcurrency: options.maxConcurrency || 4, stopOnFailure: true }
  );
  const observer = options.onEvent || createExecutionPlanObserver({
    source: 'search',
    title: 'Searching repository',
    noun: 'searches',
    category: 'search'
  });
  const outcome = await runPlan(plan, { signal: options.signal, onEvent: observer });
  recordExecutionPlanMetrics(options.kind || 'search', outcome.metrics);

  if (options.signal?.aborted) throw queryBatchAbortError(options.signal);
  const failed = outcome.results.find(result => result.ok === false);
  if (failed) throw failed.error || new Error(`Query batch failed at ${failed.name}.`);
  if (outcome.ok === false || outcome.results.length !== terms.length) {
    throw new Error(`Query batch completed only ${outcome.results.length} of ${terms.length} searches.`);
  }
  return { results: outcome.results.map(result => result.value), metrics: outcome.metrics };
}

function enforceBatchBudgets(results = [], options = {}) {
  let remainingResults = Math.max(0, Number(options.maxResults) || 0);
  let remainingBytes = Math.max(0, Number(options.maxBytes) || 0);
  return results.map(result => {
    if (!result || typeof result !== 'object') return result;
    if (Array.isArray(result.matches)) {
      const allowed = Math.min(remainingResults, result.matches.length);
      remainingResults -= allowed;
      const trimmedMatches = result.matches.slice(0, allowed);
      const matchesTrimmed = trimmedMatches.length < result.matches.length;
      let next = { ...result, matches: trimmedMatches, truncated: result.truncated === true || matchesTrimmed };
      if (matchesTrimmed || (Number(next.returnedBytes) || 0) > remainingBytes) next = stripContext(next);
      const usedBytes = Math.min(remainingBytes, Number(next.returnedBytes) || 0);
      remainingBytes -= usedBytes;
      return next;
    }
    if (Array.isArray(result.results)) {
      const kept = [];
      let usedBytes = 0;
      for (const item of result.results) {
        if (remainingResults <= 0) break;
        const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + (kept.length ? 1 : 0);
        if (itemBytes > remainingBytes) break;
        kept.push(item);
        usedBytes += itemBytes;
        remainingResults -= 1;
        remainingBytes -= itemBytes;
      }
      return {
        ...result,
        results: kept,
        returnedBytes: usedBytes,
        truncated: result.truncated === true || kept.length < result.results.length
      };
    }
    return result;
  });
}

function stripContext(result) {
  const next = { ...result };
  if (Object.hasOwn(next, 'files')) next.files = [];
  if (Object.hasOwn(next, 'contexts')) next.contexts = [];
  next.returnedBytes = 0;
  next.returnedFileCount = 0;
  next.returnedRangeCount = 0;
  next.contextMatchCount = 0;
  next.contextTruncated = true;
  return next;
}

function summarizeBatchResults(results = []) {
  const files = new Set();
  let matchCount = 0;
  let resultCount = 0;
  let returnedBytes = 0;
  let truncated = false;
  for (const result of results) {
    const matches = Array.isArray(result?.matches) ? result.matches : [];
    const ranked = Array.isArray(result?.results) ? result.results : [];
    matchCount += Number(result?.matchCount) || Number(result?.resultCount) || matches.length || ranked.length;
    resultCount += matches.length || ranked.length;
    returnedBytes += Number(result?.returnedBytes) || 0;
    truncated ||= result?.truncated === true || result?.contextTruncated === true;
    for (const match of matches) if (match?.path) files.add(String(match.path));
    for (const item of ranked) if (item?.path) files.add(String(item.path));
    for (const file of result?.files || []) {
      const path = typeof file === 'string' ? file : file?.path;
      if (path) files.add(String(path));
    }
  }
  return { matchCount, resultCount, returnedBytes, uniqueFileCount: files.size, truncated };
}

function queryBatchAbortError(signal) {
  if (signal?.reason instanceof Error) {
    const error = new Error(signal.reason.message);
    error.name = 'AbortError';
    return error;
  }
  const error = new Error('Query batch cancelled.');
  error.name = 'AbortError';
  return error;
}

export {
  compactBatchResult,
  enforceBatchBudgets,
  resolveBatchLimit,
  resolveQueryTerms,
  runQueryBatch,
  splitBatchLimit,
  summarizeBatchResults
};
