import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { collectOptionsFromWorkspace, collectTextFiles, isPathInside, looksBinary, realRootOf } from '../../safety.js';
import {
  beginGeneration,
  checkIndexIntegrity,
  currentGeneration,
  deleteIndexedPath,
  ensureIndexSchema,
  finishGeneration,
  indexParserVersion,
  indexProducerVersion,
  indexStats,
  listManifest,
  openIndexDatabase,
  replaceFileFacts,
  relationshipImpactForPaths,
  relationshipSourceIdsForNames,
  resolveRelationships,
  setIndexParserVersion,
  setIndexProducerVersion
} from './database.js';
import { enhancedResolverLanguages, isTestPath, languageForPath, PARSER_VERSION, structuralLanguages } from './languages.js';
import { intelligenceRuntimeFingerprint, intelligenceWorkspaceFingerprint } from './producer.js';
import { parseSourceFile } from './treeSitter.js';
import { rebuildZoektIndex } from './zoekt.js';

const DEFAULT_MAX_INDEX_FILES = 100000;
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const WRITE_BATCH_SIZE = 100;
const PARSE_CONCURRENCY = 8;
const relationshipResolutionCaches = new Map();

async function executeRepositoryIndexJob(job, signal) {
  const kind = normalizeJobKind(job?.kind);
  const databaseFile = String(job?.databaseFile || '');
  if (!databaseFile) throw new Error('Repository Intelligence worker requires databaseFile.');
  if (kind === 'zoekt') return refreshZoektFromManifest(job, signal);
  if (kind === 'recover') {
    discardRepositoryIndex(databaseFile);
    const result = await refreshRepositoryIndex({ ...job, kind, paths: null }, signal);
    return { ...result, rebuilt: true, recovered: true };
  }
  try {
    const result = await refreshRepositoryIndex(job, signal);
    return kind === 'rebuild' ? { ...result, rebuilt: true, recovered: false } : result;
  } catch (error) {
    if (!isRecoverableIndexError(error)) throw error;
    const recoveryReason = boundedErrorMessage(error);
    discardRepositoryIndex(databaseFile);
    const result = await refreshRepositoryIndex({ ...job, kind: 'recover', paths: null }, signal);
    return { ...result, rebuilt: true, recovered: true, recoveryReason };
  }
}

async function refreshZoektFromManifest(job, signal) {
  throwIfAborted(signal);
  const workspace = normalizeWorkspace(job?.workspace);
  const databaseFile = String(job?.databaseFile || '');
  let db = null;
  let generation;
  let manifest;
  try {
    db = openIndexDatabase(databaseFile, { readonly: true });
    generation = currentGeneration(db);
    if (!generation) {
      const error = new Error('Repository Intelligence cannot refresh Zoekt before a committed graph generation exists.');
      error.code = 'INDEX_NOT_READY';
      throw error;
    }
    manifest = listManifest(db);
  } finally {
    try { db?.close(); } catch {}
  }

  const root = realRootOf(workspace.path);
  const candidates = manifest.map(item => {
    const absolutePath = path.resolve(root, item.path);
    if (!isPathInside(absolutePath, root)) {
      const error = new Error(`Repository Intelligence manifest path escaped the workspace: ${item.path}`);
      error.code = 'INDEX_MANIFEST_PATH_INVALID';
      throw error;
    }
    return { path: item.path, absolutePath };
  });
  const graphIndex = {
    generation: Number(generation.id || 0),
    fingerprint: `generation:${Number(generation.id || 0)}`
  };
  const zoekt = await rebuildZoektIndex(
    workspace,
    databaseFile,
    job?.zoektSettings || {},
    graphIndex,
    candidates,
    { signal }
  );
  return { ...graphIndex, sourceFileCount: candidates.length, zoekt };
}

async function refreshRepositoryIndex(job, signal) {
  throwIfAborted(signal);
  const workspace = normalizeWorkspace(job?.workspace);
  const databaseFile = String(job?.databaseFile || '');
  const checkedAt = new Date().toISOString();
  const maxFiles = boundedMaxFiles(job?.maxFiles);
  let db = null;
  let generationId = null;
  let generationTransactionOpen = false;
  let processedFiles = 0;
  let skippedChangedFiles = 0;
  try {
    db = openIndexDatabase(databaseFile);
    ensureIndexSchema(db);
    const previousGeneration = currentGeneration(db);
    const requestedPaths = normalizeRequestedPaths(job?.paths);
    const incrementalCandidate = Boolean(previousGeneration && requestedPaths.length && normalizeJobKind(job?.kind) === 'refresh');
    const parserVersionChanged = parserVersionChangedForIndex(db);
    const manifest = incrementalCandidate && !parserVersionChanged
      ? listManifest(db, requestedPaths)
      : listManifest(db);
    const manifestByPath = new Map(manifest.map(item => [item.path, item]));
    if (!incrementalCandidate || parserVersionChanged) {
      const integrity = checkIndexIntegrity(db);
      if (!integrity.ok) {
        const error = new Error(`Repository Intelligence index integrity check failed: ${integrity.message}`);
        error.code = 'INDEX_INTEGRITY_FAILED';
        throw error;
      }
    }
    const runtimeProducerVersion = intelligenceRuntimeFingerprint();
    const producerVersionChanged = Boolean(previousGeneration && indexProducerVersion(db) !== runtimeProducerVersion);
    if (producerVersionChanged) {
      const error = new Error('Repository Intelligence producer changed; rebuild the derived index from source.');
      error.code = 'INDEX_PRODUCER_CHANGED';
      throw error;
    }
    let scan = previousGeneration && requestedPaths.length && !parserVersionChanged && !producerVersionChanged
      ? scanSelectedPaths(workspace, requestedPaths)
      : scanWorkspace(workspace, maxFiles);
    if (scan.requiresFullScan) scan = scanWorkspace(workspace, maxFiles);
    throwIfAborted(signal);

    const changed = job?.kind === 'rebuild' || producerVersionChanged
      ? scan.candidates
      : scan.candidates.filter(candidate => candidateChanged(candidate, manifestByPath.get(candidate.path)));
    const deletionDeferred = scan.mode === 'full' && scan.truncated;
    const deleted = scan.mode === 'full'
      ? deletionDeferred ? [] : manifest.filter(item => !scan.currentPaths.has(item.path)).map(item => item.path)
      : [...scan.missingPaths].filter(relativePath => manifestByPath.has(relativePath));
    if (!changed.length && !deleted.length && previousGeneration) {
      const metadata = indexMetadata(db, previousGeneration, workspace, scan, checkedAt, true, 0, 0, 0, 0, deletionDeferred);
      return attachZoektMetadata(metadata, job, workspace, databaseFile, scan, signal);
    }

    const changedPaths = changed.map(candidate => candidate.path);
    const canScopeRelationships = scan.mode === 'incremental'
      && deleted.length === 0
      && changed.length > 0
      && changed.length <= 100
      && changed.every(candidate => manifestByPath.has(candidate.path))
      && changed.every(candidate => !isRelationshipResolverSensitivePath(candidate.path));
    const relationshipImpact = canScopeRelationships
      ? relationshipImpactForPaths(db, changedPaths)
      : null;
    const relationshipNames = new Set(relationshipImpact?.relationshipNames || []);
    let relationshipScopeSafe = canScopeRelationships;

    let sourceReadFailureCount = 0;
    const generationKind = previousGeneration ? normalizeGenerationKind(job?.kind) : 'build';
    generationId = beginGeneration(db, generationKind);
    db.exec('BEGIN IMMEDIATE');
    generationTransactionOpen = true;
    for (let offset = 0; offset < changed.length; offset += WRITE_BATCH_SIZE) {
      throwIfAborted(signal);
      const batch = changed.slice(offset, offset + WRITE_BATCH_SIZE);
      const parsedBatch = [];
      const failedPaths = [];
      const parsedResults = await mapWithConcurrency(batch, PARSE_CONCURRENCY, async candidate => {
        throwIfAborted(signal);
        return { candidate, result: await parseCandidate(candidate) };
      });
      for (const { candidate, result: parsedResult } of parsedResults) {
        if (parsedResult.parsed) {
          const parsed = parsedResult.parsed;
          parsedBatch.push({ candidate, parsed });
          if (relationshipImpact) {
            for (const symbol of parsed.symbols || []) {
              if (symbol.name) relationshipNames.add(String(symbol.name));
              if (symbol.qualifiedName) relationshipNames.add(String(symbol.qualifiedName));
            }
            for (const relation of parsed.relations || []) {
              if (relation.targetName) relationshipNames.add(String(relation.targetName));
              if (relation.targetQualifiedName) relationshipNames.add(String(relation.targetQualifiedName));
            }
          }
        } else if (parsedResult.transientError) {
          sourceReadFailureCount += 1;
          relationshipScopeSafe = false;
          if (!manifestByPath.has(candidate.path)) failedPaths.push(candidate.path);
        } else {
          failedPaths.push(candidate.path);
          relationshipScopeSafe = false;
        }
      }
      throwIfAborted(signal);
      for (const item of parsedBatch) replaceFileFacts(db, generationId, item.candidate, item.parsed, PARSER_VERSION);
      for (const relativePath of failedPaths) deleteIndexedPath(db, relativePath);
      processedFiles += parsedBatch.length;
      skippedChangedFiles += failedPaths.length;
    }
    if (deleted.length) {
      throwIfAborted(signal);
      for (const relativePath of deleted) deleteIndexedPath(db, relativePath);
    }
    throwIfAborted(signal);
    try {
      let relationshipSourceIds = null;
      if (relationshipImpact && relationshipScopeSafe) {
        const impacted = new Set(relationshipImpact.sourceFileIds);
        for (const sourceId of relationshipSourceIdsForNames(db, [...relationshipNames])) impacted.add(sourceId);
        for (const sourceId of relationshipImpactForPaths(db, changedPaths).sourceFileIds) impacted.add(sourceId);
        if (impacted.size <= 500) relationshipSourceIds = [...impacted];
      }
      // A full relationship pass must rebuild its path/symbol context after
      // additions, deletions, or any scope-safety fallback; otherwise a
      // generation cache could omit newly indexed files.
      const resolutionCache = relationshipResolutionCacheFor(
        databaseFile,
        previousGeneration,
        scan.mode === 'full' || relationshipSourceIds == null
      );
      resolveRelationships(db, { workspaceRoot: workspace.path, sourceFileIds: relationshipSourceIds, resolutionCache });
      setIndexProducerVersion(db, runtimeProducerVersion);
      setIndexParserVersion(db, PARSER_VERSION);
      finishGeneration(db, generationId, 'committed', processedFiles + skippedChangedFiles + deleted.length);
      db.exec('COMMIT');
      generationTransactionOpen = false;
      if (resolutionCache) resolutionCache.generationId = Number(generationId);
    } catch (error) {
      if (generationTransactionOpen) {
        try { db.exec('ROLLBACK'); } catch {}
        generationTransactionOpen = false;
      }
      throw error;
    }
    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
    const metadata = indexMetadata(
      db,
      currentGeneration(db),
      workspace,
      scan,
      checkedAt,
      false,
      changed.length,
      deleted.length,
      skippedChangedFiles,
      sourceReadFailureCount,
      deletionDeferred
    );
    return attachZoektMetadata(metadata, job, workspace, databaseFile, scan, signal);
  } catch (error) {
    if (db && generationTransactionOpen) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    if (db && generationId != null) {
      try { finishGeneration(db, generationId, 'failed', processedFiles, boundedErrorMessage(error)); } catch {}
    }
    throw error;
  } finally {
    try { db?.close(); } catch {}
  }
}

async function attachZoektMetadata(metadata, job, workspace, databaseFile, scan, signal) {
  if (scan.mode !== 'full') return metadata;
  if (scan.truncated || metadata.needsReconcile) {
    return {
      ...metadata,
      zoekt: {
        available: false,
        current: false,
        reason: scan.truncated
          ? 'Zoekt rebuild skipped because the repository scan was truncated.'
          : 'Zoekt rebuild skipped because source reads were incomplete.'
      }
    };
  }
  if (job?.kind === 'refresh') {
    return {
      ...metadata,
      zoekt: {
        available: true,
        current: false,
        reason: 'Zoekt refresh is deferred until after the graph index is ready.'
      }
    };
  }
  try {
    const zoekt = await rebuildZoektIndex(
      workspace,
      databaseFile,
      job?.zoektSettings || {},
      metadata,
      scan.candidates,
      { signal }
    );
    return { ...metadata, zoekt };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ...metadata,
      zoekt: {
        available: false,
        current: false,
        reason: boundedErrorMessage(error)
      }
    };
  }
}

function scanWorkspace(workspace, maxFiles = DEFAULT_MAX_INDEX_FILES) {
  const realRoot = realRootOf(workspace.path);
  const tree = collectTextFiles(workspace.path, collectOptionsFromWorkspace(workspace, { maxEntries: maxFiles }));
  const candidates = [];
  let skippedLargeFiles = 0;
  for (const relativePath of tree.files) {
    const candidate = candidateForPath(realRoot, relativePath);
    if (!candidate) continue;
    if (candidate.tooLarge) { skippedLargeFiles += 1; continue; }
    candidates.push(candidate);
  }
  return {
    mode: 'full', candidates, currentPaths: new Set(candidates.map(item => item.path)), missingPaths: new Set(),
    discoveredFiles: tree.files.length, collectionSkippedCount: tree.skipped.length, skippedLargeFiles,
    truncated: tree.truncated, requiresFullScan: false
  };
}

function scanSelectedPaths(workspace, requestedPaths) {
  const realRoot = realRootOf(workspace.path);
  const candidates = [];
  const currentPaths = new Set();
  const missingPaths = new Set();
  let skippedLargeFiles = 0;
  for (const requested of requestedPaths) {
    const normalized = normalizeRelativePath(requested);
    if (!normalized) continue;
    const absolutePath = path.resolve(realRoot, normalized);
    if (!isPathInside(absolutePath, realRoot)) continue;
    let stat;
    try { stat = fs.statSync(absolutePath); } catch { missingPaths.add(normalized); continue; }
    if (stat.isDirectory()) {
      return { mode: 'incremental', candidates: [], currentPaths: new Set(), missingPaths: new Set(), discoveredFiles: 0, collectionSkippedCount: 0, skippedLargeFiles: 0, truncated: false, requiresFullScan: true };
    }
    if (!stat.isFile()) continue;
    currentPaths.add(normalized);
    if (stat.size > MAX_INDEXED_FILE_BYTES) { skippedLargeFiles += 1; missingPaths.add(normalized); continue; }
    candidates.push(candidateFromStat(normalized, absolutePath, stat));
  }
  return { mode: 'incremental', candidates, currentPaths, missingPaths, discoveredFiles: candidates.length, collectionSkippedCount: 0, skippedLargeFiles, truncated: false, requiresFullScan: false };
}

function candidateForPath(realRoot, relativePath) {
  try {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return null;
    const absolutePath = path.resolve(realRoot, normalized);
    if (!isPathInside(absolutePath, realRoot)) return null;
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_INDEXED_FILE_BYTES) return { tooLarge: true };
    return candidateFromStat(normalized, absolutePath, stat);
  } catch { return null; }
}

function candidateFromStat(relativePath, absolutePath, stat) {
  return {
    path: relativePath,
    absolutePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    language: languageForPath(relativePath),
    test: isTestPath(relativePath)
  };
}

function candidateChanged(candidate, previous) {
  if (!previous) return true;
  return previous.sizeBytes !== candidate.size
    || previous.mtimeMs !== candidate.mtimeMs
    || previous.ctimeMs !== candidate.ctimeMs
    || previous.parserVersion !== PARSER_VERSION;
}

async function parseCandidate(candidate) {
  let data;
  try {
    data = fs.readFileSync(candidate.absolutePath);
  } catch (error) {
    return { parsed: null, transientError: boundedErrorMessage(error) };
  }
  if (looksBinary(data)) return { parsed: null, skipped: 'binary' };
  try {
    const parsed = await parseSourceFile({ relativePath: candidate.path, source: data.toString('utf8') });
    candidate.contentHash ||= crypto.createHash('sha256').update(data).digest('hex');
    return { parsed };
  } catch (error) {
    return { parsed: null, transientError: boundedErrorMessage(error) };
  }
}

function indexMetadata(
  db,
  generation,
  workspace,
  scan,
  checkedAt,
  cacheHit,
  changedPathCount,
  deletedPathCount,
  skippedChangedFiles,
  sourceReadFailureCount = 0,
  deletionDeferred = false
) {
  const stats = indexStats(db);
  const needsReconcile = sourceReadFailureCount > 0 || scan.truncated;
  const producerVersion = intelligenceRuntimeFingerprint();
  const workspaceProducerVersion = intelligenceWorkspaceFingerprint(workspace.path);
  const runtimeStale = Boolean(workspaceProducerVersion && workspaceProducerVersion !== producerVersion);
  const freshness = runtimeStale ? 'runtime-stale' : sourceReadFailureCount > 0 ? 'stale' : scan.truncated ? 'partial' : 'current';
  return {
    mode: 'persistent-tree-sitter-sqlite', persistent: true, freshness, cacheHit, scanMode: scan.mode, workerIsolated: true,
    fingerprint: `generation:${Number(generation?.id || 0)}`, generation: Number(generation?.id || 0),
    builtAt: generation?.completed_at || generation?.started_at || null, checkedAt,
    newestSourceMtime: stats.newestMtimeMs ? new Date(stats.newestMtimeMs).toISOString() : null,
    sourceFileCount: stats.fileCount, discoveredFileCount: scan.mode === 'full' ? scan.discoveredFiles : stats.fileCount,
    indexedBytes: stats.indexedBytes, skippedLargeFiles: scan.skippedLargeFiles, collectionSkippedCount: scan.collectionSkippedCount,
    structuralFileCount: stats.structuralFileCount,
    structuralDegradedFileCount: stats.structuralDegradedFileCount,
    symbolCount: stats.symbolCount,
    occurrenceCount: stats.occurrenceCount,
    changedPathCount,
    deletedPathCount,
    skippedChangedFiles,
    sourceReadFailureCount,
    deletionDeferred,
    needsReconcile,
    producerVersion,
    ...(workspaceProducerVersion ? { workspaceProducerVersion } : {}),
    runtimeStale,
    truncated: scan.truncated,
    providers: { structural: 'tree-sitter-wasm', graph: 'sqlite', lexical: 'sqlite-fts5', neural: false },
    languageIntelligence: { structuralLanguages: structuralLanguages().length, enhancedLanguages: enhancedResolverLanguages() },
    policy: runtimeStale
      ? 'The self-hosted repository intelligence source differs from the connected runtime. Derived graph data is stale until the runtime is restarted; source remains authoritative.'
      : 'Persistent derived index with worker-isolated parsing, bounded incremental refresh, producer-version invalidation, and periodic full reconciliation. Source remains authoritative.',
    workspace: workspace.alias
  };
}

function discardRepositoryIndex(databaseFile) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(`${databaseFile}${suffix}`, { force: true }); } catch {}
  }
}

function isRecoverableIndexError(error) {
  if (!error || error.code === 'INDEX_ABORTED' || error.code === 'INDEX_SCHEMA_FUTURE') return false;
  if (error.code === 'INDEX_PRODUCER_CHANGED') return true;
  if (error.code === 'INDEX_INTEGRITY_FAILED') return true;
  return /(?:database disk image is malformed|database is malformed|file is not a database|database corrupt|sqlite_corrupt|sqlite_notadb)/.test(boundedErrorMessage(error).toLowerCase());
}

function normalizeWorkspace(workspace) {
  const value = workspace && typeof workspace === 'object' ? workspace : {};
  const context = value.context && typeof value.context === 'object' ? value.context : {};
  return { alias: String(value.alias || ''), path: String(value.path || ''), context: { includeRoots: Array.isArray(context.includeRoots) ? [...context.includeRoots] : Array.isArray(context.includePaths) ? [...context.includePaths] : [], excludePaths: Array.isArray(context.excludePaths) ? [...context.excludePaths] : [] } };
}

function isRelationshipResolverSensitivePath(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/').toLowerCase();
  const base = path.posix.basename(normalized);
  return new Set([
    'package.json', 'tsconfig.json', 'jsconfig.json', 'go.mod', 'composer.json',
    'cargo.toml', 'pyproject.toml', 'compile_commands.json'
  ]).has(base) || base.endsWith('.csproj');
}

function normalizeRequestedPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map(normalizeRelativePath).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  return path.posix.normalize(normalized);
}

function normalizeJobKind(value) {
  const kind = String(value || 'refresh').toLowerCase();
  return ['build', 'refresh', 'rebuild', 'recover', 'zoekt'].includes(kind) ? kind : 'refresh';
}

function normalizeGenerationKind(value) {
  const kind = normalizeJobKind(value);
  return kind === 'build' ? 'refresh' : kind;
}

function boundedMaxFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_INDEX_FILES;
  return Math.max(1, Math.min(500000, Math.floor(parsed)));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'Repository Intelligence indexing was cancelled.');
  error.name = 'AbortError';
  error.code = 'INDEX_ABORTED';
  throw error;
}

function boundedErrorMessage(error) {
  return String(error instanceof Error ? error.message : error || 'Unknown error').slice(0, 2000);
}

function parserVersionChangedForIndex(db) {
  const stored = Number(indexParserVersion(db));
  if (Number.isFinite(stored) && stored > 0) return stored !== PARSER_VERSION;
  // Indexes created before the parser-version metadata was introduced need a
  // one-time compatibility check. Every subsequent refresh uses the O(1) meta
  // value written at generation commit.
  const versions = db.prepare('SELECT DISTINCT parser_version FROM files').all();
  return versions.some(row => Number(row.parser_version) !== PARSER_VERSION);
}

function relationshipResolutionCacheFor(databaseFile, previousGeneration, fullScan) {
  if (fullScan) {
    const cache = { generationId: 0, context: null };
    relationshipResolutionCaches.set(databaseFile, cache);
    return cache;
  }
  const cache = relationshipResolutionCaches.get(databaseFile);
  if (cache && Number(cache.generationId) === Number(previousGeneration?.id)) return cache;
  // A worker may have been evicted since the last full generation. Recreate a
  // cache shell so the scoped resolver can repopulate its path metadata once;
  // this preserves ecosystem/alias import behavior after worker restart.
  const replacement = { generationId: Number(previousGeneration?.id || 0), context: null };
  relationshipResolutionCaches.set(databaseFile, replacement);
  return replacement;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export { DEFAULT_MAX_INDEX_FILES, MAX_INDEXED_FILE_BYTES, discardRepositoryIndex, executeRepositoryIndexJob, isRecoverableIndexError, scanWorkspace };
