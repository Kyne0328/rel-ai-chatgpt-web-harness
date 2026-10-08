import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { collectOptionsFromWorkspace, collectTextFiles, createCollectionContext, createCollectionPathObserver, looksBinary } from '../../safety.js';
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
  relationshipSourceIdsForImportResolutionChanges,
  relationshipSourceIdsForNames,
  refreshRelationshipResolutionCache,
  resolveRelationships,
  setIndexParserVersion,
  setIndexProducerVersion
} from './database.js';
import { enhancedResolverLanguages, isTestPath, languageForPath, lexicalSearchText, PARSER_VERSION, structuralLanguages } from './languages.js';
import { intelligenceRuntimeFingerprint, intelligenceWorkspaceFingerprint } from './producer.js';
import { parseSourceFile } from './treeSitter.js';
import { rebuildZoektIndex } from './zoekt.js';

const DEFAULT_MAX_INDEX_FILES = 100000;
const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
const WRITE_BATCH_SIZE = 20;
const PARSE_CONCURRENCY = 2;
const GENERATED_STRUCTURAL_MIN_BYTES = 64 * 1024;
const GENERATED_STRUCTURAL_SAMPLE_BYTES = 256 * 1024;
const GENERATED_STRUCTURAL_AVG_LINE_BYTES = 1024;
const GENERATED_STRUCTURAL_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'css', 'html']);
const relationshipResolutionCaches = new Map();

async function executeRepositoryIndexJob(job, signal) {
  const kind = normalizeJobKind(job?.kind);
  const databaseFile = String(job?.databaseFile || '');
  if (!databaseFile) throw new Error('Repository Intelligence worker requires databaseFile.');
  throwIfAborted(signal);
  const workspace = normalizeWorkspace(job?.workspace);
  // Verify one canonical policy snapshot before any automatic or explicit recovery
  // can discard derived facts. Reuse it for every observation in this job.
  const collectionContext = createCollectionContext(workspace.path, collectOptionsFromWorkspace(workspace));
  job = { ...job, workspace, collectionContext };
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

  const observe = createCollectionPathObserver(workspace.path, {
    ...collectOptionsFromWorkspace(workspace), collectionContext: job.collectionContext
  });
  const candidates = manifest.map(item => {
    const observation = observe(item.path);
    if (observation.status !== 'eligible' || !observation.stat.isFile()
      || observation.stat.size > MAX_INDEXED_FILE_BYTES) {
      const error = new Error('Repository Intelligence source needs collection reconciliation before Zoekt refresh.');
      error.code = 'INDEX_SOURCE_CHANGED';
      throw error;
    }
    return { path: observation.path, absolutePath: observation.absolutePath };
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
    let manifest = incrementalCandidate && !parserVersionChanged
      ? listManifest(db, requestedPaths)
      : listManifest(db);
    let manifestByPath = new Map(manifest.map(item => [item.path, item]));
    if (!incrementalCandidate || parserVersionChanged) assertIndexIntegrity(db);
    const runtimeProducerVersion = intelligenceRuntimeFingerprint();
    const producerVersionChanged = Boolean(previousGeneration && indexProducerVersion(db) !== runtimeProducerVersion);
    if (producerVersionChanged) {
      const error = new Error('Repository Intelligence producer changed; rebuild the derived index from source.');
      error.code = 'INDEX_PRODUCER_CHANGED';
      throw error;
    }
    const collectionOptions = { ...collectOptionsFromWorkspace(workspace), collectionContext: job.collectionContext };
    const observe = createCollectionPathObserver(workspace.path, collectionOptions);
    let scan = incrementalCandidate && !parserVersionChanged && !producerVersionChanged
      ? scanSelectedPaths(workspace, requestedPaths, job.collectionContext)
      : scanWorkspace(workspace, maxFiles, job.collectionContext);
    if (scan.requiresFullScan || (scan.mode === 'incremental' && hasIndexedDescendants(db, scan))) {
      scan = scanWorkspace(workspace, maxFiles, job.collectionContext);
      // The targeted manifest contains exact paths only, not old directory children.
      // Reload it before all change, addition, deletion and relationship decisions.
      manifest = listManifest(db);
      manifestByPath = new Map(manifest.map(item => [item.path, item]));
      assertIndexIntegrity(db);
    }
    throwIfAborted(signal);

    const changed = job?.kind === 'rebuild' || producerVersionChanged
      ? scan.candidates
      : scan.candidates.filter(candidate => candidateChanged(candidate, manifestByPath.get(candidate.path)));
    const deleted = scan.mode === 'full'
      ? observedRetirements(scan, manifest, observe)
      : [...scan.missingPaths].filter(relativePath => manifestByPath.has(relativePath));
    const deletionDeferred = scan.mode === 'full' && !scan.complete;
    if (!changed.length && !deleted.length && previousGeneration) {
      const metadata = indexMetadata(db, previousGeneration, workspace, scan, checkedAt, true, 0, 0, 0, scan.observationFailureCount, deletionDeferred);
      return attachZoektMetadata(metadata, job, workspace, databaseFile, scan, signal);
    }

    const changedPaths = changed.map(candidate => candidate.path);
    const addedPaths = changed.filter(candidate => !manifestByPath.has(candidate.path)).map(candidate => candidate.path);
    const relationshipPaths = [...new Set([...changedPaths, ...deleted])];
    const canScopeRelationships = scan.mode === 'incremental'
      && relationshipPaths.length > 0
      && relationshipPaths.length <= 100
      && relationshipPaths.every(relativePath => !isRelationshipResolverSensitivePath(relativePath));
    const relationshipImpact = canScopeRelationships
      ? relationshipImpactForPaths(db, relationshipPaths)
      : null;
    const relationshipNames = new Set(relationshipImpact?.relationshipNames || []);
    let relationshipScopeSafe = canScopeRelationships && scan.observationFailureCount === 0;

    let sourceReadFailureCount = scan.observationFailureCount;
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
        return { candidate, result: await parseCandidate(candidate, observe) };
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
          if (parsedResult.skipped === 'too-large') scan.skippedLargeFiles += 1;
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
      const resolutionCache = relationshipResolutionCacheFor(
        databaseFile,
        previousGeneration,
        scan.mode === 'full' || !canScopeRelationships
      );
      if (relationshipImpact && relationshipScopeSafe) {
        if (addedPaths.length || deleted.length) {
          refreshRelationshipResolutionCache(db, workspace.path, resolutionCache, { addedPaths, deletedPaths: deleted });
        }
        const impacted = new Set(relationshipImpact.sourceFileIds);
        for (const sourceId of relationshipSourceIdsForNames(db, [...relationshipNames])) impacted.add(sourceId);
        for (const sourceId of relationshipImpactForPaths(db, relationshipPaths).sourceFileIds) impacted.add(sourceId);
        if (addedPaths.length || deleted.length) {
          for (const sourceId of relationshipSourceIdsForImportResolutionChanges(db, workspace.path, resolutionCache, [...addedPaths, ...deleted])) impacted.add(sourceId);
        }
        if (impacted.size <= 500) relationshipSourceIds = [...impacted];
      }
      if (relationshipSourceIds == null && canScopeRelationships) {
        // A large or unsafe impact set falls back to a full relationship pass.
        resolutionCache.context = null;
      }
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

function scanWorkspace(workspace, maxFiles = DEFAULT_MAX_INDEX_FILES, collectionContext) {
  const options = collectOptionsFromWorkspace(workspace, { maxEntries: maxFiles });
  collectionContext ||= createCollectionContext(workspace.path, options);
  const collectionOptions = { ...options, collectionContext };
  const observe = createCollectionPathObserver(workspace.path, collectionOptions);
  const tree = collectTextFiles(workspace.path, collectionOptions);
  const scan = {
    mode: 'full', candidates: [], currentPaths: new Set(), missingPaths: new Set(),
    discoveredFiles: tree.files.length, collectionSkippedCount: tree.skipped.length, skippedLargeFiles: 0,
    truncated: tree.truncated, complete: tree.complete, incompletePaths: [...tree.incompletePaths],
    observationFailureCount: tree.skipped.filter(item => item.unavailable === true).length,
    requiresFullScan: false
  };
  for (const relativePath of tree.files) addObservedCandidate(scan, observe(relativePath));
  return scan;
}

function scanSelectedPaths(workspace, requestedPaths, collectionContext) {
  const observe = createCollectionPathObserver(workspace.path, {
    ...collectOptionsFromWorkspace(workspace), collectionContext
  });
  const scan = {
    mode: 'incremental', candidates: [], currentPaths: new Set(), missingPaths: new Set(),
    discoveredFiles: 0, collectionSkippedCount: 0, skippedLargeFiles: 0,
    truncated: false, complete: true, incompletePaths: [], observationFailureCount: 0,
    requiresFullScan: false
  };
  for (const requested of requestedPaths) {
    addObservedCandidate(scan, observe(requested));
    if (scan.requiresFullScan) break;
  }
  scan.discoveredFiles = scan.candidates.length;
  return scan;
}

function addObservedCandidate(scan, observation) {
  if (observation.status === 'unavailable') {
    scan.complete = false;
    scan.incompletePaths.push(observation.path);
    scan.observationFailureCount += 1;
    return;
  }
  if (observation.status === 'missing' || observation.status === 'excluded') {
    scan.missingPaths.add(observation.path);
    scan.collectionSkippedCount += 1;
    return;
  }
  if (observation.stat.isDirectory()) {
    if (scan.mode === 'incremental') scan.requiresFullScan = true;
    else scan.missingPaths.add(observation.path); // Verified non-file transition.
    return;
  }
  if (observation.stat.size > MAX_INDEXED_FILE_BYTES) {
    scan.skippedLargeFiles += 1;
    scan.missingPaths.add(observation.path);
    return;
  }
  scan.currentPaths.add(observation.path);
  scan.candidates.push(candidateFromStat(observation.path, observation.absolutePath, observation.stat));
}

function hasIndexedDescendants(db, scan) {
  const query = db.prepare('SELECT 1 FROM files WHERE path >= ? AND path < ? LIMIT 1');
  // '/' followed by any suffix lies strictly below the next ASCII character '0'.
  // This indexed range avoids LIKE wildcard/case ambiguity and a full manifest read.
  return [...scan.currentPaths, ...scan.missingPaths].some(relativePath =>
    Boolean(query.get(relativePath + '/', relativePath + '0')));
}

function observedRetirements(scan, manifest, observe) {
  const retired = [];
  for (const item of manifest) {
    if (scan.currentPaths.has(item.path)) continue;
    if (scan.incompletePaths.some(prefix => prefix === '.' || item.path === prefix || item.path.startsWith(prefix + '/'))) continue;
    const observation = scan.missingPaths.has(item.path) ? null : observe(item.path);
    if (!observation || observation.status === 'missing' || observation.status === 'excluded'
      || (observation.status === 'eligible' && (!observation.stat.isFile() || observation.stat.size > MAX_INDEXED_FILE_BYTES))) {
      retired.push(item.path);
    } else {
      // An omitted but currently eligible file is not proven absent either.
      scan.complete = false;
      scan.incompletePaths.push(item.path);
      if (observation.status === 'unavailable') scan.observationFailureCount += 1;
    }
  }
  return retired;
}

function assertIndexIntegrity(db) {
  const integrity = checkIndexIntegrity(db);
  if (!integrity.ok) {
    const error = new Error(`Repository Intelligence index integrity check failed: ${integrity.message}`);
    error.code = 'INDEX_INTEGRITY_FAILED';
    throw error;
  }
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

async function parseCandidate(candidate, observe) {
  const observation = observe(candidate.path);
  if (observation.status === 'unavailable') {
    return { parsed: null, transientError: observation.reason };
  }
  if (observation.status !== 'eligible' || !observation.stat.isFile()) {
    return { parsed: null, skipped: 'ineligible' };
  }
  if (observation.stat.size > MAX_INDEXED_FILE_BYTES) return { parsed: null, skipped: 'too-large' };
  Object.assign(candidate, candidateFromStat(observation.path, observation.absolutePath, observation.stat));
  let data;
  try {
    // The canonical observation is not a lasting read capability. No atomic
    // no-follow guarantee is claimed across the observation/read boundary.
    data = fs.readFileSync(candidate.absolutePath);
  } catch (error) {
    return { parsed: null, transientError: boundedErrorMessage(error) };
  }
  if (data.length > MAX_INDEXED_FILE_BYTES) return { parsed: null, skipped: 'too-large' };
  if (looksBinary(data)) return { parsed: null, skipped: 'binary' };
  try {
    const source = data.toString('utf8');
    const parsed = shouldSkipStructuralParsing(candidate, data)
      ? generatedLexicalResult(candidate.path, candidate.language, source)
      : await parseSourceFile({ relativePath: candidate.path, source });
    if (parsed.structuralStatus === 'failed' || parsed.structuralStatus === 'unavailable') {
      return { parsed: null, transientError: parsed.structuralError || 'Structural parser is unavailable.' };
    }
    candidate.contentHash ||= crypto.createHash('sha256').update(data).digest('hex');
    return { parsed };
  } catch (error) {
    return { parsed: null, transientError: boundedErrorMessage(error) };
  }
}

function shouldSkipStructuralParsing(candidate, data) {
  if (!GENERATED_STRUCTURAL_LANGUAGES.has(String(candidate?.language || ''))) return false;
  if (!Buffer.isBuffer(data) || data.length < GENERATED_STRUCTURAL_MIN_BYTES) return false;
  const sampleBytes = Math.min(data.length, GENERATED_STRUCTURAL_SAMPLE_BYTES);
  let lineBreaks = 0;
  for (let index = 0; index < sampleBytes; index += 1) {
    if (data[index] === 10) lineBreaks += 1;
  }
  return sampleBytes / Math.max(1, lineBreaks + 1) >= GENERATED_STRUCTURAL_AVG_LINE_BYTES;
}

function generatedLexicalResult(relativePath, language, source) {
  return {
    path: relativePath,
    language,
    parser: 'lexical-generated',
    parseError: false,
    structuralStatus: 'generated',
    structuralError: '',
    symbols: [],
    occurrences: [],
    imports: [],
    relations: [],
    resolver: null,
    searchText: lexicalSearchText(relativePath, source, [])
  };
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
  const needsReconcile = sourceReadFailureCount > 0 || scan.complete === false || scan.truncated;
  const producerVersion = intelligenceRuntimeFingerprint();
  const workspaceProducerVersion = intelligenceWorkspaceFingerprint(workspace.path);
  const runtimeStale = Boolean(workspaceProducerVersion && workspaceProducerVersion !== producerVersion);
  const freshness = runtimeStale ? 'runtime-stale' : sourceReadFailureCount > 0 || (scan.complete === false && !scan.truncated) ? 'stale' : scan.truncated ? 'partial' : 'current';
  return {
    mode: 'persistent-tree-sitter-sqlite', persistent: true, freshness, cacheHit, scanMode: scan.mode, workerIsolated: true,
    fingerprint: `generation:${Number(generation?.id || 0)}`, generation: Number(generation?.id || 0),
    builtAt: generation?.completed_at || generation?.started_at || null, checkedAt,
    newestSourceMtime: stats.newestMtimeMs ? new Date(stats.newestMtimeMs).toISOString() : null,
    sourceFileCount: stats.fileCount, discoveredFileCount: scan.mode === 'full' ? scan.discoveredFiles : stats.fileCount,
    indexedBytes: stats.indexedBytes, skippedLargeFiles: scan.skippedLargeFiles, collectionSkippedCount: scan.collectionSkippedCount,
    structuralFileCount: stats.structuralFileCount,
    structuralSkippedGeneratedFileCount: stats.structuralSkippedGeneratedFileCount,
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
      : 'Persistent derived index with worker-isolated parsing, generated-bundle structural bypass, bounded incremental refresh, producer-version invalidation, and periodic full reconciliation. Source remains authoritative.',
    workspace: workspace.alias
  };
}

function discardRepositoryIndex(databaseFile) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.rmSync(`${databaseFile}${suffix}`, { force: true }); } catch {}
  }
}

function isRecoverableIndexError(error) {
  if (!error || ['INDEX_ABORTED', 'INDEX_SCHEMA_FUTURE', 'COLLECTION_POLICY_UNAVAILABLE', 'INDEX_SOURCE_CHANGED'].includes(error.code)) return false;
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
  // Keep invalid absolute, traversal and whitespace spelling for canonical
  // observation; never turn it into a different, deletion-authorizing path.
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
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
