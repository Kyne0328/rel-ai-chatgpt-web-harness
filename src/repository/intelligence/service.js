import crypto from 'node:crypto';
import fs from 'node:fs';
import { repositoryIndexPath } from './database.js';

import {
  cancelRepositoryIndex,
  disposeRepositoryIndex,
  ensureRepositoryIndex,
  noteRepositoryMutation,
  rebuildRepositoryIndex,
  recoverRepositoryIndex,
  repositoryIndexStatus,
  shutdownRepositoryIndexes
} from './indexer.js';
import { disposeRepositoryQueryWorker, runRepositoryQuery, shutdownRepositoryQueryWorkers } from './queryWorkerClient.js';
import { repositoryIndexChanged } from './state.js';
import {
  disposeLspWorkspace,
  noteLspMutation,
  planSemanticRename,
  providerStatuses,
  shutdownLspSessions
} from '../../codeIntelligence/lspManager.js';
import { inspectRepositoryCode } from './inspection.js';
import {
  parseWorkspaceSourcePath,
  qualifyWorkspaceSourcePath,
  sourceWorkspace,
  workspaceSourceEntries
} from '../../workspaceSources.js';

const MAX_INDEXED_QUERY_ATTEMPTS = 2;
const SOURCE_PATH_PREFIX = /^source:\d+(?:\/|$)/;
const PATH_FIELDS = new Set(['path', 'sourcePath', 'targetPath', 'from', 'to']);
const PATH_ARRAY_FIELDS = new Set([
  'affectedTests', 'definitionPaths', 'recommendedReadOrder', 'reviewedFiles', 'seeds'
]);
const MERGED_ARRAY_FIELDS = new Set([
  'definitions', 'references', 'items', 'calls', 'impactedPaths', 'affectedTests', 'importEdges',
  'definitionPaths', 'directCallers', 'importers', 'indirectImpact', 'relatedSymbols', 'uiSurfaces',
  'registrationSurfaces', 'recommendedReadOrder', 'seeds', 'files'
]);
const SUM_FIELDS = new Set(['matchCount', 'definitionCount', 'referenceCount', 'callCount', 'impactedPathCount']);


const OPTIONAL_CACHED_LOOKUP_BUDGET_MS = 250;
const OPTIONAL_CACHED_LOOKUP_BACKOFF_MS = 5000;
const optionalCachedLookups = new Map();

async function runCachedRepositoryQuery(kind, workspace, config, options = {}) {
  const startedAt = performance.now();
  const unavailable = (reason, deferred = false) => ({
    available: false, source: 'persistent-code-graph', cacheOnly: true,
    status: deferred ? 'deferred' : 'unavailable', deferred, reason,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    policy: 'Optional cached guidance is unavailable; source files and the source snapshot remain authoritative. No index was built by this lookup.'
  });
  if (options.signal?.aborted) throw options.signal.reason || new Error('Cached lookup cancelled.');
  // Do not acquire a heavy lease or start a worker just to discover no cache.
  let databaseFile;
  try { databaseFile = repositoryIndexPath(config, workspace); } catch { return unavailable('cache_unavailable'); }
  if (!fs.existsSync(databaseFile)) return unavailable('cache_missing');
  if (options.optional !== true) return runRepositoryQuery(kind, workspace, config, {}, options);
  const now = Date.now();
  if ((optionalCachedLookups.get(databaseFile)?.untilMs || 0) > now) return unavailable('cached_lookup_backoff', true);
  const attempt = { untilMs: now + OPTIONAL_CACHED_LOOKUP_BACKOFF_MS };
  optionalCachedLookups.delete(databaseFile);
  optionalCachedLookups.set(databaseFile, attempt);
  while (optionalCachedLookups.size > 64) optionalCachedLookups.delete(optionalCachedLookups.keys().next().value);

  const requestedBudget = Number(options.cachedLookupBudgetMs);
  const budgetMs = Number.isFinite(requestedBudget) && requestedBudget > 0
    ? Math.min(OPTIONAL_CACHED_LOOKUP_BUDGET_MS, requestedBudget) : OPTIONAL_CACHED_LOOKUP_BUDGET_MS;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let budgetExpired = false;
  const timer = setTimeout(() => {
    budgetExpired = true;
    controller.abort(Object.assign(new Error('Optional cached lookup budget expired.'), { code: 'CACHED_LOOKUP_DEFERRED' }));
  }, budgetMs);
  timer.unref?.();
  try {
    const result = await runRepositoryQuery(kind, workspace, config, {}, { ...options, signal });
    if (options.signal?.aborted) throw options.signal.reason || new Error('Cached lookup cancelled.');
    if (optionalCachedLookups.get(databaseFile) === attempt) optionalCachedLookups.delete(databaseFile);
    return result || unavailable('cache_unavailable');
  } catch (error) {
    // A real owner cancellation must never become a successful partial context.
    if (options.signal?.aborted) {
      if (optionalCachedLookups.get(databaseFile) === attempt) optionalCachedLookups.delete(databaseFile);
      throw options.signal.reason || error;
    }
    attempt.untilMs = Date.now() + OPTIONAL_CACHED_LOOKUP_BACKOFF_MS;
    return unavailable(budgetExpired ? 'cached_lookup_budget_exhausted' : 'cached_lookup_unavailable', budgetExpired);
  } finally {
    clearTimeout(timer);
  }
}

function createRepositoryIntelligenceService() {
  const singleIndexedQuery = async (kind, workspace, config, args, options = {}) => {
    if (kind === 'codeInspect' && String(args.action || '').toLowerCase() === 'audit' && args.refresh !== true && options.force !== true) {
      const fast = await tryAuditFastQuery(workspace, config, args, options);
      if (fast) return fast;
    }
    for (let attempt = 0; attempt < MAX_INDEXED_QUERY_ATTEMPTS; attempt += 1) {
      const index = await ensureRepositoryIndex(workspace, config, {
        maxFiles: args.maxFiles,
        signal: options.signal,
        watch: options.watch,
        indexTimeoutMs: options.indexTimeoutMs
      });
      let result;
      try {
        result = await runRepositoryQuery(kind, workspace, config, { args, index }, options);
      } catch (error) {
        if (error?.code === 'QUERY_INDEX_CHANGED' && attempt + 1 < MAX_INDEXED_QUERY_ATTEMPTS) continue;
        throw error;
      }

      const status = repositoryIndexStatus(workspace, config);
      if (!repositoryIndexChanged(status, index.generation)) return result;
      if (attempt + 1 < MAX_INDEXED_QUERY_ATTEMPTS) continue;

      const error = new Error('Repository changed while Repository Intelligence was answering the query. Retry against the refreshed index.');
      error.code = 'QUERY_SOURCE_CHANGED';
      throw error;
    }
    throw new Error('Repository Intelligence query retry budget exhausted.');
  };

  const indexedQuery = async (kind, workspace, config, args, options = {}) => {
    const sources = workspaceSourceEntries(workspace);
    if (sources.length <= 1) return singleIndexedQuery(kind, workspace, config, args, options);
    if (kind === 'semanticSearch') return multiSourceSemanticSearch(singleIndexedQuery, workspace, config, args, options, sources);
    if (kind === 'codeInspect' && String(args.action || '').toLowerCase() !== 'diagnostics') {
      return multiSourceCodeInspect(singleIndexedQuery, workspace, config, args, options, sources);
    }
    return singleIndexedQuery(kind, workspace, config, args, options);
  };

  const nativeCodeInspect = (workspace, config = {}, args = {}, options = {}) =>
    indexedQuery('codeInspect', workspace, config, args, options);

  return Object.freeze({
    ensure: (workspace, config = {}, options = {}) => ensureRepositoryIndex(workspace, config, options),
    codeInspect: (workspace, config = {}, args = {}, options = {}) =>
      inspectRepositoryCode(nativeCodeInspect, workspace, config, args, options),
    architecture: (workspace, config = {}, args = {}, options = {}) =>
      nativeCodeInspect(workspace, config, { ...args, action: 'architecture' }, options),
    audit: (workspace, config = {}, args = {}, options = {}) =>
      inspectRepositoryCode(nativeCodeInspect, workspace, config, { ...args, action: 'audit' }, options),
    cachedContext: (workspace, config = {}, options = {}) => runCachedRepositoryQuery('cachedContext', workspace, config, options),
    cachedSummary: (workspace, config = {}, options = {}) => runCachedRepositoryQuery('cachedSummary', workspace, config, options),
    searchGraphContext: (workspace, config = {}, matches = [], options = {}) => runRepositoryQuery('searchGraphContext', workspace, config, { matches }, options),
    semanticSearch: (workspace, config = {}, args = {}, options = {}) => indexedQuery('semanticSearch', workspace, config, args, options),
    semanticRename: (workspace, semantic, options = {}) => planSemanticRename(workspace, semantic, options),
    noteMutation: (workspace, config = {}, paths = []) => {
      noteRepositoryMutation(workspace, config, paths);
      noteLspMutation(workspace, paths);
    },
    status: (workspace, config = {}) => repositoryIndexStatus(workspace, config),
    languageServers: workspace => providerStatuses(workspace),
    rebuild: (workspace, config = {}, options = {}) => rebuildRepositoryIndex(workspace, config, options),
    recover: (workspace, config = {}, options = {}) => recoverRepositoryIndex(workspace, config, options),
    cancel: (workspace, config = {}, reason) => cancelRepositoryIndex(workspace, config, reason),
    dispose: (workspace, config = {}, options = {}) => disposeWorkspaceIntelligence(workspace, config, options),
    shutdown: () => Promise.all([
      shutdownLspSessions(),
      shutdownRepositoryQueryWorkers(),
      shutdownRepositoryIndexes()
    ])
  });
}

async function tryAuditFastQuery(workspace, config, args, options = {}) {
  let status;
  try {
    status = repositoryIndexStatus(workspace, config);
  } catch {
    return null;
  }
  const cached = status?.metadata;
  if (!cached) return null;
  const staleIndex = {
    ...cached,
    stale: status.dirty === true,
    backgroundRefresh: status.dirty === true,
    cacheHit: true
  };
  try {
    const result = await runRepositoryQuery('codeInspect', workspace, config, { args, index: staleIndex }, options);
    if (status.dirty === true) {
      const timer = setTimeout(() => {
        void ensureRepositoryIndex(workspace, config, { maxFiles: args.maxFiles, watch: false }).catch(() => {});
      }, 0);
      timer.unref?.();
    }
    return result;
  } catch (error) {
    const message = String(error?.message || '');
    if (error?.code === 'QUERY_INDEX_CHANGED' || /no such table|not a database|malformed|INDEX_NOT_READY/i.test(message)) return null;
    throw error;
  }
}

async function disposeWorkspaceIntelligence(workspace, config = {}, options = {}) {
  await disposeLspWorkspace(workspace);
  const results = [];
  for (const source of workspaceSourceEntries(workspace)) {
    const scopedWorkspace = sourceWorkspace(workspace, source);
    try {
      await disposeRepositoryQueryWorker(scopedWorkspace, config);
      results.push({ source: source.number, ...(await disposeRepositoryIndex(scopedWorkspace, config, options)) });
    } catch (error) {
      results.push({ source: source.number, detached: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: results.every(item => item.detached !== false), sources: results };
}

async function multiSourceSemanticSearch(singleIndexedQuery, workspace, config, args, options, sources) {
  const selected = selectSourcesForPrefix(workspace, sources, args.pathPrefix);
  const results = await mapWithConcurrency(selected.sources, 4, async source => {
    const scopedArgs = { ...args };
    if (selected.explicitSource) scopedArgs.pathPrefix = selected.relativePath;
    const result = await singleIndexedQuery('semanticSearch', sourceWorkspace(workspace, source), config, scopedArgs, options);
    return { source, result: qualifyResultPaths(result, source) };
  });

  const maxResults = Math.max(1, Math.min(100, Number(args.maxResults || 20)));
  const maxBytes = args.maxBytes == null ? 393216 : Math.max(1000, Math.min(393216, Number(args.maxBytes) || 393216));
  const ranked = results.flatMap(item => item.result.results || [])
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || String(left.path || '').localeCompare(String(right.path || '')));
  const bounded = [];
  let returnedBytes = 0;
  for (const item of ranked) {
    if (bounded.length >= maxResults) break;
    const bytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (returnedBytes + bytes > maxBytes) break;
    bounded.push(item);
    returnedBytes += bytes;
  }
  const resultCount = results.reduce((sum, item) => sum + Number(item.result.resultCount || 0), 0);
  const fingerprints = results.map(item => String(item.result.fingerprint || '')).filter(Boolean);
  return {
    ok: true,
    workspace: workspace.alias,
    query: String(args.query || ''),
    strategy: 'multi-source-local-hybrid',
    retrieval: {
      degraded: results.some(item => item.result.retrieval?.degraded === true),
      sources: results.map(item => ({ source: item.source.number, ...(item.result.retrieval || {}) }))
    },
    neuralEmbeddings: false,
    privacy: 'All parsing, graph indexing, and ranking run locally. No source text is sent to an external service.',
    fingerprint: combinedFingerprint(fingerprints),
    cacheHit: results.length > 0 && results.every(item => item.result.cacheHit === true),
    results: bounded,
    resultCount,
    returnedBytes,
    truncated: results.some(item => item.result.truncated === true) || ranked.length > bounded.length
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function multiSourceCodeInspect(singleIndexedQuery, workspace, config, args, options, sources) {
  const action = String(args.action || '').toLowerCase();
  const selected = selectSourcesForInspect(workspace, sources, args);
  const results = [];
  for (const source of selected) {
    const scopedArgs = argsForSource(workspace, args, source);
    if (action === 'impact' && !scopedArgs.symbol && Array.isArray(args.paths) && !scopedArgs.paths.length) continue;
    const result = await singleIndexedQuery('codeInspect', sourceWorkspace(workspace, source), config, scopedArgs, options);
    results.push({ source, result: qualifyInspectResult(result, source, action === 'audit' ? 'architecture' : action) });
  }
  if (!results.length) {
    const error = new Error('No requested path belongs to an attached source folder.');
    error.code = 'SOURCE_PATH_NOT_FOUND';
    throw error;
  }
  if (action === 'architecture') return mergeArchitecture(workspace, results);
  if (action === 'audit') {
    const merged = mergeArchitecture(workspace, results);
    const readiness = results.find(item => item.result.readiness)?.result.readiness || null;
    return {
      ...merged,
      action: 'audit',
      architecture: { ...merged.architecture, strategy: 'multi-source-audit-fast' },
      ...(readiness ? { readiness } : {}),
      next: 'Audit fast path: review modules/entryPoints/hotspots/cycles, then read recommended entry points and run relai_validate checks.'
    };
  }
  return mergeInspect(workspace, args, results);
}

function selectSourcesForPrefix(workspace, sources, pathPrefix) {
  const raw = String(pathPrefix || '').trim().replaceAll('\\', '/');
  if (!raw) return { sources, explicitSource: false, relativePath: '' };
  if (!SOURCE_PATH_PREFIX.test(raw)) return { sources: [sources[0]], explicitSource: false, relativePath: raw };
  const parsed = parseWorkspaceSourcePath(workspace, raw);
  return { sources: [parsed.source], explicitSource: true, relativePath: parsed.relativePath === '.' ? '' : parsed.relativePath };
}

function selectSourcesForInspect(workspace, sources, args) {
  const symbol = String(args.symbol || '').trim();
  const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];
  if (symbol || !paths.length) return sources;
  const selected = new Map();
  for (const raw of paths) {
    const parsed = parseWorkspaceSourcePath(workspace, raw);
    selected.set(parsed.source.number, parsed.source);
  }
  return [...selected.values()];
}

function argsForSource(workspace, args, source) {
  const next = { ...args };
  if (Array.isArray(args.paths)) {
    next.paths = args.paths.flatMap(raw => {
      const parsed = parseWorkspaceSourcePath(workspace, raw);
      return parsed.source.number === source.number ? [parsed.relativePath] : [];
    });
  }
  if (args.path && SOURCE_PATH_PREFIX.test(String(args.path).replaceAll('\\', '/'))) {
    const parsed = parseWorkspaceSourcePath(workspace, args.path);
    if (parsed.source.number === source.number) next.path = parsed.relativePath;
    else delete next.path;
  }
  return next;
}

function qualifyInspectResult(result, source, action) {
  const qualified = qualifyResultPaths(result, source);
  if ((action !== 'architecture' && action !== 'audit') || source.primary) return qualified;
  return {
    ...qualified,
    modules: (qualified.modules || []).map(item => ({ ...item, name: qualifyModuleName(source, item.name) })),
    layers: (qualified.layers || []).map(item => ({ ...item, modules: (item.modules || []).map(name => qualifyModuleName(source, name)) })),
    cycles: (qualified.cycles || []).map(item => ({ ...item, modules: (item.modules || []).map(name => qualifyModuleName(source, name)) })),
    communities: (qualified.communities || []).map(item => ({ ...item, name: qualifyModuleName(source, item.name) })),
    architecture: qualified.architecture ? { ...qualified.architecture, crossWorkspace: undefined } : qualified.architecture
  };
}

function qualifyResultPaths(value, source, field = '') {
  if (Array.isArray(value)) {
    if (PATH_ARRAY_FIELDS.has(field) || field === 'files') {
      return value.map(item => typeof item === 'string' ? qualifyWorkspaceSourcePath(source, item) : qualifyResultPaths(item, source));
    }
    return value.map(item => qualifyResultPaths(item, source));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && PATH_FIELDS.has(field)) return qualifyWorkspaceSourcePath(source, value);
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, qualifyResultPaths(item, source, key)]));
}

function mergeInspect(workspace, args, sourceResults) {
  const action = String(args.action || '').toLowerCase();
  const maxResults = Math.max(1, Math.min(1000, Number(args.maxResults || 200)));
  const merged = {
    ok: true,
    workspace: workspace.alias,
    action,
    index: { sources: sourceResults.map(item => ({ source: item.source.number, metadata: item.result.index || {} })) },
    ...(args.symbol ? { symbol: String(args.symbol) } : {}),
    ...(args.query ? { query: String(args.query) } : {})
  };
  let truncated = false;

  for (const field of SUM_FIELDS) {
    const value = sourceResults.reduce((sum, item) => sum + Number(item.result[field] || 0), 0);
    if (value || sourceResults.some(item => Object.hasOwn(item.result, field))) merged[field] = value;
  }
  for (const field of MERGED_ARRAY_FIELDS) {
    const values = sourceResults.flatMap(item => Array.isArray(item.result[field]) ? item.result[field] : []);
    if (!values.length && !sourceResults.some(item => Array.isArray(item.result[field]))) continue;
    const deduped = dedupeMergedItems(values);
    if (field === 'files') deduped.sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0) || String(a?.path || a).localeCompare(String(b?.path || b)));
    if (deduped.length > maxResults) truncated = true;
    merged[field] = deduped.slice(0, maxResults);
  }

  const maxDepth = sourceResults.find(item => item.result.maxDepth != null)?.result.maxDepth;
  if (maxDepth != null) merged.maxDepth = maxDepth;
  const strategy = sourceResults.find(item => item.result.strategy)?.result.strategy;
  if (strategy) merged.strategy = `multi-source-${strategy}`;
  if (sourceResults.some(item => item.result.semanticEmbeddings === false)) merged.semanticEmbeddings = false;
  const summaries = sourceResults.map(item => item.result.summary).filter(item => item && typeof item === 'object' && !Array.isArray(item));
  if (summaries.length) merged.summary = mergeNumericObjects(summaries);
  merged.truncated = truncated || sourceResults.some(item => item.result.truncated === true);
  merged.next = sourceResults.find(item => item.result.next)?.result.next || 'Inspect the strongest source-scoped results before widening the query.';
  return merged;
}

function mergeArchitecture(workspace, sourceResults) {
  const relationshipTypes = mergeNumericObjects(sourceResults.map(item => item.result.relationshipTypes || {}));
  const modules = sourceResults.flatMap(item => item.result.modules || []);
  const entryPoints = sourceResults.flatMap(item => item.result.entryPoints || []).sort(scoreThenPath);
  const hotspots = sourceResults.flatMap(item => item.result.hotspots || []).sort(scoreThenPath);
  const layers = sourceResults.flatMap(item => item.result.layers || []);
  const cycles = sourceResults.flatMap(item => item.result.cycles || []);
  const communities = sourceResults.flatMap(item => item.result.communities || []);
  const summary = mergeNumericObjects(sourceResults.map(item => item.result.summary || {}));
  const primaryCrossWorkspace = sourceResults.find(item => item.source.primary)?.result.architecture?.crossWorkspace;
  const architectures = sourceResults.map(item => item.result.architecture || {});
  const truncated = sourceResults.some(item => item.result.truncated === true || item.result.architecture?.truncated === true);
  return {
    ok: true,
    workspace: workspace.alias,
    action: 'architecture',
    index: { sources: sourceResults.map(item => ({ source: item.source.number, metadata: item.result.index || {} })) },
    architecture: {
      strategy: 'multi-source-bounded-file-graph',
      totalFileCount: sumField(architectures, 'totalFileCount'),
      analyzedFileCount: sumField(architectures, 'analyzedFileCount'),
      analyzedEdgeCount: sumField(architectures, 'analyzedEdgeCount'),
      maxNodes: sumField(architectures, 'maxNodes'),
      maxEdges: sumField(architectures, 'maxEdges'),
      truncated,
      sources: sourceResults.map(item => ({ source: item.source.number, root: item.source.root, ...item.result.architecture, crossWorkspace: undefined })),
      ...(primaryCrossWorkspace ? { crossWorkspace: primaryCrossWorkspace } : {})
    },
    relationshipTypes,
    modules,
    entryPoints,
    hotspots,
    layers,
    cycles,
    communities,
    summary,
    truncated,
    next: 'Use source-qualified entry points and hotspots to choose the smallest attached source boundary before reading code.'
  };
}

function qualifyModuleName(source, value) {
  const name = String(value || '');
  if (source.primary) return name;
  if (!name || name === '(root)' || name === '(community)') return source.prefix;
  return `${source.prefix}/${name}`;
}

function dedupeMergedItems(values) {
  const seen = new Set();
  const result = [];
  for (const item of values) {
    const key = typeof item === 'string'
      ? `s:${item}`
      : `o:${item?.path || ''}:${item?.line || 0}:${item?.column || 0}:${item?.from || ''}:${item?.to || ''}:${item?.name || item?.qualifiedName || ''}:${item?.depth ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function mergeNumericObjects(items) {
  const result = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item || {})) {
      if (typeof value === 'number') result[key] = Number(result[key] || 0) + value;
      else if (!Object.hasOwn(result, key)) result[key] = value;
    }
  }
  return result;
}

function sumField(items, field) {
  return items.reduce((sum, item) => sum + Number(item?.[field] || 0), 0);
}

function scoreThenPath(left, right) {
  return Number(right?.score || 0) - Number(left?.score || 0) || String(left?.path || '').localeCompare(String(right?.path || ''));
}

function combinedFingerprint(values) {
  if (!values.length) return '';
  if (values.length === 1) return values[0];
  return crypto.createHash('sha256').update(values.join('\0')).digest('base64url').slice(0, 32);
}

const repositoryIntelligence = createRepositoryIntelligenceService();

export { createRepositoryIntelligenceService, repositoryIntelligence };
