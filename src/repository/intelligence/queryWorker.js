import { cachedRepositoryContext, cachedRepositorySummary, cachedSearchGraphContext } from './contextPlanner.js';
import { currentGeneration, indexProducerVersion, openIndexDatabase, repositoryIndexPath } from './database.js';
import { executeCodeInspectQuery, executeSemanticSearchQuery } from './queryService.js';

const SOURCE_CACHE_MAX_FILES = 128;
const SOURCE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export default async function runJob(job = {}) {
  try {
    const options = {
      ...(job.options || {}),
      repositoryStatuses: job.repositoryStatuses || {}
    };
    let result;
    if (job.kind === 'codeInspect') {
      result = await executeIndexedQuery(job, options, queryOptionsValue =>
        executeCodeInspectQuery(job.workspace, job.config, job.args, job.index, queryOptionsValue));
    } else if (job.kind === 'semanticSearch') {
      result = await executeIndexedQuery(job, options, queryOptionsValue =>
        executeSemanticSearchQuery(job.workspace, job.config, job.args, job.index, queryOptionsValue));
    } else if (job.kind === 'cachedContext') {
      result = cachedRepositoryContext(job.workspace, job.config, { ...(job.options || {}), repositoryStatuses: options.repositoryStatuses });
    } else if (job.kind === 'cachedSummary') {
      result = cachedRepositorySummary(job.workspace, job.config, { ...(job.options || {}), repositoryStatuses: options.repositoryStatuses });
    } else if (job.kind === 'searchGraphContext') {
      result = cachedSearchGraphContext(job.workspace, job.config, job.matches || [], { repositoryStatuses: options.repositoryStatuses });
    } else {
      throw Object.assign(new Error(`Unknown Repository Intelligence query job: ${String(job.kind || '')}`), { code: 'QUERY_JOB_UNKNOWN' });
    }
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error: {
        name: String(error?.name || 'Error'),
        code: error?.code == null ? '' : String(error.code),
        message: String(error?.message || error || 'Repository Intelligence query worker failed.'),
        stack: typeof error?.stack === 'string' ? error.stack : ''
      }
    };
  }
}

async function executeIndexedQuery(job, options, execute) {
  const queryOptionsValue = queryOptions(job, options);
  const db = queryOptionsValue.database;
  let transactionOpen = false;
  try {
    db.exec('BEGIN');
    transactionOpen = true;
    const expectedGeneration = Number(job.index?.generation || 0);
    const expectedBuiltAt = String(job.index?.builtAt || '');
    const expectedProducerVersion = String(job.index?.producerVersion || '');
    const actual = currentGeneration(db);
    const actualGeneration = Number(actual?.id || 0);
    const actualBuiltAt = String(actual?.completed_at || actual?.started_at || '');
    const actualProducerVersion = indexProducerVersion(db);
    if (!expectedGeneration
      || actualGeneration !== expectedGeneration
      || (expectedBuiltAt && actualBuiltAt !== expectedBuiltAt)
      || (expectedProducerVersion && actualProducerVersion !== expectedProducerVersion)) {
      const error = new Error(`Repository Intelligence index changed before the query started (expected generation ${expectedGeneration || 'none'}, found ${actualGeneration || 'none'}).`);
      error.code = 'QUERY_INDEX_CHANGED';
      throw error;
    }
    const result = await execute(queryOptionsValue);
    db.exec('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    throw error;
  } finally {
    try { db.close(); } catch {}
  }
}

function queryOptions(job, options) {
  const databaseFile = repositoryIndexPath(job.config, job.workspace);
  return {
    ...options,
    database: openIndexDatabase(databaseFile, { readonly: true }),
    sourceCache: createBoundedSourceCache()
  };
}

function createBoundedSourceCache() {
  const entries = new Map();
  let totalBytes = 0;
  return {
    has(key) { return entries.has(key); },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      const existing = entries.get(key);
      if (existing) {
        totalBytes -= existing.bytes;
        entries.delete(key);
      }
      const bytes = sourceValueBytes(value);
      if (bytes > SOURCE_CACHE_MAX_BYTES) return this;
      entries.set(key, { value, bytes });
      totalBytes += bytes;
      while (entries.size > SOURCE_CACHE_MAX_FILES || totalBytes > SOURCE_CACHE_MAX_BYTES) {
        const oldestKey = entries.keys().next().value;
        const oldest = entries.get(oldestKey);
        entries.delete(oldestKey);
        totalBytes -= oldest?.bytes || 0;
      }
      return this;
    }
  };
}

function sourceValueBytes(value) {
  if (!Array.isArray(value)) return 1;
  return Buffer.byteLength(value.join('\n'), 'utf8');
}
