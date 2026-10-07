import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { collectOptionsFromWorkspace, createCollectionPathFilter, isPathInside, realRootOf } from '../../safety.js';
import { getStateDir } from '../../stateLayout.js';
import { watchPathFor } from '../../watchPath.js';
import { ensureIndexSchema, failBuildingGenerations, openIndexDatabase, repositoryIndexPath } from './database.js';
import { DEFAULT_MAX_INDEX_FILES } from './indexBuild.js';
import { recentIntelligenceDiagnostics, recordIntelligenceDiagnostic } from './state.js';
import { measurePerformancePhase } from '../../performanceObservability.js';
import { acquireHostResource } from '../../hostResourceScheduler.js';

const FALLBACK_RECONCILE_INTERVAL_MS = 5 * 60_000;
const ZOEKT_RECONCILE_DELAY_MS = 1500;
const MAX_INCREMENTAL_PATHS = 1000;
const MAX_COALESCED_PASSES = 3;
// Index workers can own runProcess() children such as zoekt-index. Give the
// child's bounded cancellation path (1s graceful + 2s forced wait) time to
// finish its finally cleanup before the worker thread itself is terminated.
const WORKER_CANCEL_GRACE_MS = 5000;
const WORKER_IDLE_EVICT_MS = 60_000;
const INDEX_INCREMENTAL_TIMEOUT_MS = 60_000;
const INDEX_FULL_TIMEOUT_MS = 300_000;
const activeBuilds = new Map();
const runtimeStates = new Map();
const workerClients = new Map();

async function ensureRepositoryIndex(workspace, config = {}, options = {}) {
  throwIfAborted(options.signal);
  const databaseFile = repositoryIndexPath(config, workspace);
  const state = runtimeState(databaseFile);
  if (options.watch !== false) ensureWorkspaceWatcher(workspace, config, state);
  const now = Date.now();
  const fallbackReconcileDue = !state.watcher && now - state.lastFullScanAt >= FALLBACK_RECONCILE_INTERVAL_MS;
  const zoektOnly = normalizeMode(options.mode) === 'zoekt';
  if (state.metadata && !state.dirty && !fallbackReconcileDue && options.force !== true && !zoektOnly) {
    return decorateMetadata(state, { ...state.metadata, cacheHit: true, checkedAt: new Date().toISOString() });
  }

  const existing = activeBuilds.get(databaseFile);
  if (existing) return waitForBuild(existing, options.signal);

  const buildAbortController = new AbortController();
  // The build belongs to all waiters. A caller's signal only detaches that
  // caller; waitForBuild cancels shared work when its final waiter leaves.
  const buildSignal = buildAbortController.signal;
  const record = {
    promise: null,
    waiters: 0,
    settled: false,
    cancel(reason) {
      if (!buildAbortController.signal.aborted) buildAbortController.abort(abortError(reason));
      state.currentCancel?.(reason);
    }
  };
  record.promise = runCoalescedIndexing(workspace, config, databaseFile, state, { ...options, signal: buildSignal })
    .finally(() => {
      record.settled = true;
      if (activeBuilds.get(databaseFile) === record) activeBuilds.delete(databaseFile);
    });
  activeBuilds.set(databaseFile, record);
  return waitForBuild(record, options.signal);
}

async function rebuildRepositoryIndex(workspace, config = {}, options = {}) {
  const databaseFile = repositoryIndexPath(config, workspace);
  await cancelAndDrain(databaseFile, 'Repository Intelligence rebuild requested.');
  const state = runtimeState(databaseFile);
  state.dirty = true;
  state.fullScanRequired = true;
  return ensureRepositoryIndex(workspace, config, { ...options, force: true, mode: 'rebuild' });
}

async function recoverRepositoryIndex(workspace, config = {}, options = {}) {
  const databaseFile = repositoryIndexPath(config, workspace);
  await cancelAndDrain(databaseFile, 'Repository Intelligence recovery requested.');
  const state = runtimeState(databaseFile);
  state.dirty = true;
  state.fullScanRequired = true;
  return ensureRepositoryIndex(workspace, config, { ...options, force: true, mode: 'recover' });
}

function noteRepositoryMutation(workspace, config = {}, paths = []) {
  const state = runtimeState(repositoryIndexPath(config, workspace));
  clearZoektReconcile(state);
  state.changeRevision += 1;
  state.dirty = true;
  const normalized = normalizePaths(paths);
  if (!normalized.length) {
    state.fullScanRequired = true;
    return;
  }
  for (const relativePath of normalized) state.pendingPaths.add(relativePath);
  if (pendingRefreshPathCount(state) > MAX_INCREMENTAL_PATHS) {
    clearPendingRefreshPaths(state);
    state.fullScanRequired = true;
  }
}

function repositoryIndexStatus(workspace, config = {}) {
  const databaseFile = repositoryIndexPath(config, workspace);
  const state = runtimeStates.get(databaseFile);
  if (!state) {
    return { status: 'idle', dirty: true, active: false, watching: false, zoektRefreshScheduled: false, pendingPathCount: 0, lastError: null, lastFullScanAt: null, lastReconciledAt: null, metadata: null, diagnostics: recentIntelligenceDiagnostics(workspace) };
  }
  return {
    status: state.status,
    dirty: state.dirty,
    active: activeBuilds.has(databaseFile),
    watching: Boolean(state.watcher),
    zoektRefreshScheduled: Boolean(state.zoektReconcileTimer),
    pendingPathCount: pendingRefreshPathCount(state),
    lastError: state.lastError,
    lastFullScanAt: isoTime(state.lastFullScanAt),
    lastReconciledAt: isoTime(state.lastReconciledAt),
    metadata: state.metadata ? decorateMetadata(state, state.metadata) : null,
    diagnostics: recentIntelligenceDiagnostics(workspace)
  };
}

function cancelRepositoryIndex(workspace, config = {}, reason = 'Repository Intelligence indexing cancelled.') {
  const databaseFile = repositoryIndexPath(config, workspace);
  const record = activeBuilds.get(databaseFile);
  if (!record || record.settled) return false;
  record.cancel(reason);
  return true;
}

function evictIdleRepositoryWorkers(reason = 'Repository Intelligence idle worker evicted.') {
  const evictionError = reason instanceof Error ? reason : new Error(String(reason));
  let evicted = 0;
  for (const client of [...workerClients.values()]) {
    if (!client.closed && client.isIdle()) {
      client.terminate(evictionError);
      evicted += 1;
    }
  }
  return evicted;
}

async function disposeRepositoryIndex(workspace, config = {}, options = {}) {
  const databaseFile = repositoryIndexPath(config, workspace);
  await cancelAndDrain(databaseFile, 'Repository Intelligence workspace detached.');
  const state = runtimeStates.get(databaseFile);
  if (state) {
    clearZoektReconcile(state);
    await closeRepositoryWatcher(state);
    runtimeStates.delete(databaseFile);
  }
  const client = workerClients.get(databaseFile);
  if (client) await client.terminate(abortError('Repository Intelligence workspace detached.'));
  workerClients.delete(databaseFile);
  activeBuilds.delete(databaseFile);
  let cacheRemoved = false;
  let cacheRemovalError;
  if (options.removeCache === true) {
    try {
      fs.rmSync(path.dirname(databaseFile), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      cacheRemoved = true;
    } catch (error) {
      cacheRemovalError = { code: String(error?.code || 'CACHE_REMOVAL_FAILED').slice(0, 80), message: boundedErrorMessage(error).slice(0, 1000) };
    }
  }
  return { detached: true, cacheRemoved, ...(cacheRemovalError ? { cacheRemovalError } : {}) };
}

function closeRepositoryWatcher(state) {
  const watcher = state?.watcher;
  state.watcher = null;
  if (!watcher) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.off('close', finish);
      resolve();
    };
    watcher.once('close', finish);
    try { watcher.close(); } catch { finish(); }
  });
}

async function shutdownRepositoryIndexes() {
  const shutdownError = abortError('Repository Intelligence is shutting down.');
  const builds = [...activeBuilds.values()];
  const watcherClosures = [];
  for (const state of runtimeStates.values()) {
    clearZoektReconcile(state);
    watcherClosures.push(closeRepositoryWatcher(state));
  }
  for (const record of builds) record.cancel(shutdownError.message);
  await Promise.allSettled([
    ...builds.map(record => record.promise),
    ...watcherClosures
  ]);
  const terminations = [...workerClients.values()].map(client => client.terminate(shutdownError));
  await Promise.allSettled(terminations);
  runtimeStates.clear();
  activeBuilds.clear();
  workerClients.clear();
}

async function runCoalescedIndexing(workspace, config, databaseFile, state, options) {
  let metadata = state.metadata;
  let mode = normalizeMode(options.mode);
  let coalescedPassCount = 0;
  let totalChangedPathCount = 0;
  let totalDeletedPathCount = 0;
  try {
    for (let pass = 0; pass < MAX_COALESCED_PASSES; pass += 1) {
      throwIfAborted(options.signal);
      const revisionAtStart = state.changeRevision;
      const zoektOnly = mode === 'zoekt';
      state.status = statusForMode(mode, metadata);
      state.lastError = null;
      const resourceLease = await acquireHostResource('heavy', workspace.alias, {
        signal: options.signal, timeoutMs: options.indexQueueTimeoutMs,
        deadlineAtMs: options.deadlineAtMs
      });
      let execution = null;
      try {
        // Detach/cancel can arrive after admission but before this continuation.
        // Do not consume dirty paths or spawn a worker until it is checked.
        throwIfAborted(options.signal);
        const selection = zoektOnly ? { paths: [] } : consumeRefreshSelection(state, mode, options.force === true);
        execution = runIndexWorker({
          kind: mode,
          workspace: serializableWorkspace(workspace),
          databaseFile,
          maxFiles: boundedMaxFiles(options.maxFiles || config?.repositoryIntelligence?.maxFiles),
          paths: selection.paths,
          zoektSettings: serializableZoektSettings(config)
        });
        state.currentCancel = execution.cancel;
        const defaultTimeoutMs = zoektOnly
          ? INDEX_FULL_TIMEOUT_MS
          : selection.paths === null ? INDEX_FULL_TIMEOUT_MS : INDEX_INCREMENTAL_TIMEOUT_MS;
        const previousZoekt = metadata?.zoekt;
        const passMetadata = await measurePerformancePhase(
          'repo.index_refresh',
          () => withIndexTimeout(execution, positiveTimeout(options.indexTimeoutMs, defaultTimeoutMs))
        );
        if (zoektOnly) {
          if (!metadata || Number(passMetadata?.generation || 0) !== Number(metadata.generation || 0)) {
            const error = new Error('Repository Intelligence generation changed during the Zoekt refresh.');
            error.code = 'INDEX_GENERATION_CHANGED';
            throw error;
          }
          coalescedPassCount += 1;
          metadata = {
            ...metadata,
            checkedAt: new Date().toISOString(),
            zoekt: passMetadata.zoekt
          };
        } else {
          const changedThisPass = Number(passMetadata?.changedPathCount || 0);
          const deletedThisPass = Number(passMetadata?.deletedPathCount || 0);
          coalescedPassCount += 1;
          totalChangedPathCount += changedThisPass;
          totalDeletedPathCount += deletedThisPass;
          let zoekt = passMetadata?.zoekt;
          if (passMetadata?.scanMode === 'incremental' && previousZoekt) {
            zoekt = changedThisPass > 0 || deletedThisPass > 0
              ? { ...previousZoekt, current: false, reason: 'Zoekt refresh scheduled after incremental Repository Intelligence changes.' }
              : previousZoekt;
          }
          metadata = {
            ...passMetadata,
            ...(zoekt ? { zoekt } : {}),
            changedPathCount: totalChangedPathCount,
            deletedPathCount: totalDeletedPathCount,
            cacheHit: totalChangedPathCount === 0 && totalDeletedPathCount === 0 && passMetadata?.cacheHit === true,
            ...(coalescedPassCount > 1 ? { coalescedPassCount } : {})
          };
        }
      } finally {
        if (execution && state.currentCancel === execution.cancel) state.currentCancel = null;
        resourceLease.release();
      }
      state.metadata = metadata;
      if (!zoektOnly) {
        state.lastReconciledAt = Date.now();
        if (metadata.scanMode === 'full') state.lastFullScanAt = state.lastReconciledAt;
      }
      const changedDuringBuild = state.changeRevision !== revisionAtStart;
      const needsReconcile = metadata?.needsReconcile === true;
      state.dirty = changedDuringBuild || needsReconcile;
      if (!changedDuringBuild) break;
      mode = 'refresh';
    }
    state.status = 'ready';
    if (state.dirty && metadata && metadata.freshness !== 'partial') metadata = { ...metadata, freshness: 'stale' };
    state.metadata = metadata;
    if (!state.dirty && metadata?.zoekt?.current === false && metadata.zoekt.available !== false) {
      scheduleZoektReconcile(workspace, config, state);
    }
    return decorateMetadata(state, metadata);
  } catch (error) {
    recoverAbandonedIndexGenerations(databaseFile, error);
    state.dirty = true;
    if (error?.code === 'INDEX_ABORTED' || error?.name === 'AbortError') {
      state.status = state.metadata ? 'ready' : 'idle';
    } else {
      state.status = 'degraded';
      state.lastError = boundedErrorMessage(error);
      recordIntelligenceDiagnostic(workspace, 'index_refresh_failed', error);
    }
    throw error;
  }
}

async function withIndexTimeout(execution, timeoutMs) {
  let timer;
  let timedOut = false;
  timer = setTimeout(() => {
    timedOut = true;
    execution.cancel(`Repository Intelligence indexing exceeded ${timeoutMs}ms.`);
  }, timeoutMs);
  timer.unref?.();
  try {
    let result;
    try {
      result = await execution.promise;
    } catch (error) {
      if (!timedOut) throw error;
    }
    if (timedOut) {
      const timeoutError = new Error(`Repository Intelligence indexing exceeded ${timeoutMs}ms.`);
      timeoutError.code = 'INDEX_TIMEOUT';
      throw timeoutError;
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function consumeRefreshSelection(state, mode, force) {
  const fallbackReconcileDue = !state.watcher
    && (!state.lastFullScanAt || Date.now() - state.lastFullScanAt >= FALLBACK_RECONCILE_INTERVAL_MS);
  const full = force || mode === 'rebuild' || mode === 'recover' || state.fullScanRequired || fallbackReconcileDue;
  const paths = full ? null : incrementalRefreshPaths(state);
  clearPendingRefreshPaths(state);
  state.fullScanRequired = false;
  return { paths };
}

function runIndexWorker(job) {
  return repositoryWorkerClient(job.databaseFile).run(job);
}

function repositoryWorkerClient(databaseFile) {
  const existing = workerClients.get(databaseFile);
  if (existing && !existing.closed) return existing;

  const worker = new Worker(new URL('./indexWorker.js', import.meta.url));
  worker.unref();
  const pending = new Map();
  let nextJobId = 1;
  let idleTimer = null;
  const clearIdleTermination = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const scheduleIdleTermination = () => {
    clearIdleTermination();
    if (client.closed || pending.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!client.closed && pending.size === 0) client.terminate(new Error('Repository Intelligence worker idle timeout reached.'));
    }, WORKER_IDLE_EVICT_MS);
    idleTimer.unref?.();
  };
  const client = {
    closed: false,
    isIdle() { return pending.size === 0; },
    run(job) {
      if (client.closed) return failedExecution(new Error('Repository Intelligence worker is closed.'));
      clearIdleTermination();
      const jobId = `index-${nextJobId++}`;
      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
      const entry = { resolve: resolvePromise, reject: rejectPromise, cancelTimer: null, cancelled: false };
      pending.set(jobId, entry);
      worker.ref();
      try {
        worker.postMessage({ type: 'run', jobId, job });
      } catch (error) {
        pending.delete(jobId);
        if (pending.size === 0) { worker.unref(); scheduleIdleTermination(); }
        rejectPromise(error);
      }
      return {
        promise,
        cancel(reason = 'Repository Intelligence worker cancelled.') {
          const current = pending.get(jobId);
          if (!current || current.cancelled) return;
          current.cancelled = true;
          try { worker.postMessage({ type: 'abort', jobId, reason: String(reason) }); } catch {}
          current.cancelTimer = setTimeout(() => {
            if (pending.has(jobId)) client.terminate(abortError(String(reason)));
          }, WORKER_CANCEL_GRACE_MS);
          current.cancelTimer.unref?.();
        }
      };
    },
    terminate(reason = new Error('Repository Intelligence worker terminated.')) {
      if (client.closed) return Promise.resolve();
      client.closed = true;
      clearIdleTermination();
      if (workerClients.get(databaseFile) === client) workerClients.delete(databaseFile);
      const entries = [...pending.values()];
      for (const entry of entries) {
        if (entry.cancelTimer) clearTimeout(entry.cancelTimer);
      }
      pending.clear();
      worker.unref();
      worker.removeAllListeners();
      return worker.terminate().catch(() => {}).finally(() => {
        for (const entry of entries) entry.reject(reason);
      });
    }
  };

  worker.on('message', message => {
    if (message?.type !== 'result') return;
    const entry = pending.get(message.jobId);
    if (!entry) return;
    pending.delete(message.jobId);
    if (entry.cancelTimer) clearTimeout(entry.cancelTimer);
    if (pending.size === 0) { worker.unref(); scheduleIdleTermination(); }
    if (message.ok) entry.resolve(message.result);
    else entry.reject(workerError(message.error));
  });
  worker.on('error', error => client.terminate(error));
  worker.on('exit', code => {
    if (!client.closed) client.terminate(new Error(`Repository Intelligence worker exited with code ${code}.`));
  });
  workerClients.set(databaseFile, client);
  return client;
}

function failedExecution(error) {
  return { promise: Promise.reject(error), cancel() {} };
}

function recoverAbandonedIndexGenerations(databaseFile, error) {
  let db = null;
  try {
    db = openIndexDatabase(databaseFile);
    ensureIndexSchema(db);
    failBuildingGenerations(db, boundedErrorMessage(error));
  } catch {
    // Preserve the original indexing failure. A later refresh can retry recovery.
  } finally {
    try { db?.close(); } catch {}
  }
}

function waitForBuild(record, signal) {
  throwIfAborted(signal);
  record.waiters += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    record.waiters = Math.max(0, record.waiters - 1);
    if (record.waiters === 0 && !record.settled) record.cancel('All Repository Intelligence callers cancelled.');
  };
  if (!signal) return record.promise.finally(release);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener?.('abort', onAbort);
      release();
      reject(abortError(signal.reason instanceof Error ? signal.reason.message : 'Repository Intelligence request cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    record.promise.then(
      value => { signal.removeEventListener?.('abort', onAbort); release(); resolve(value); },
      error => { signal.removeEventListener?.('abort', onAbort); release(); reject(error); }
    );
  });
}

async function cancelAndDrain(databaseFile, reason) {
  const existing = activeBuilds.get(databaseFile);
  if (!existing || existing.settled) return;
  existing.cancel(reason);
  try { await existing.promise; } catch {}
}

function ensureWorkspaceWatcher(workspace, config, state) {
  if (state.watcher) return;
  try {
    const root = watchPathFor(realRootOf(workspace.path));
    const stateRoot = watchedStateRoot(workspace.path, root, getStateDir(config));
    let shouldCollect = createCollectionPathFilter(root, collectOptionsFromWorkspace(workspace));
    state.watcher = fs.watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      clearZoektReconcile(state);
      const normalized = normalizeWatchPath(filename);
      if (normalized === '.relaiignore') {
        shouldCollect = createCollectionPathFilter(root, collectOptionsFromWorkspace(workspace));
      } else if (normalized && shouldIgnoreWatchPath(root, stateRoot, normalized, shouldCollect)) {
        return;
      }
      state.changeRevision += 1;
      state.dirty = true;
      if (!normalized || eventType === 'rename' || normalized === '.relaiignore') {
        clearPendingRefreshPaths(state);
        state.fullScanRequired = true;
        return;
      }
      if (watchPathIsDirectory(root, normalized)) state.pendingDirectories.add(normalized);
      else state.pendingPaths.add(normalized);
      if (pendingRefreshPathCount(state) > MAX_INCREMENTAL_PATHS) {
        clearPendingRefreshPaths(state);
        state.fullScanRequired = true;
      }
    });
    state.watcher.on('error', error => {
      state.dirty = true;
      state.fullScanRequired = true;
      state.lastError = boundedErrorMessage(error);
      recordIntelligenceDiagnostic(workspace, 'index_watcher_failed', error);
      try { state.watcher?.close(); } catch {}
      state.watcher = null;
    });
  } catch (error) {
    state.watcher = null;
    state.lastError = boundedErrorMessage(error);
    recordIntelligenceDiagnostic(workspace, 'index_watcher_unavailable', error);
  }
}

function watchedStateRoot(configuredWorkspaceRoot, watchedRoot, configuredStateRoot) {
  const relative = path.relative(path.resolve(configuredWorkspaceRoot), path.resolve(configuredStateRoot));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return path.resolve(watchedRoot, relative);
  }
  return path.resolve(configuredStateRoot);
}

function shouldIgnoreWatchPath(root, stateRoot, filename, shouldCollect) {
  const normalized = normalizeWatchPath(filename);
  if (!normalized) return false;
  if (isPathInside(path.resolve(root, normalized), stateRoot)) return true;
  if (typeof shouldCollect === 'function' && !shouldCollect(normalized)) return true;
  return false;
}

function runtimeState(databaseFile) {
  let state = runtimeStates.get(databaseFile);
  if (!state) {
    state = { metadata: null, dirty: true, changeRevision: 0, lastReconciledAt: 0, lastFullScanAt: 0, watcher: null, zoektReconcileTimer: null, pendingPaths: new Set(), pendingDirectories: new Set(), fullScanRequired: true, status: 'idle', lastError: null, currentCancel: null };
    runtimeStates.set(databaseFile, state);
  }
  return state;
}

function scheduleZoektReconcile(workspace, config, state) {
  clearZoektReconcile(state);
  state.zoektReconcileTimer = setTimeout(() => {
    state.zoektReconcileTimer = null;
    if (state.dirty) return;
    void ensureRepositoryIndex(workspace, config, { mode: 'zoekt', watch: false })
      .catch(error => recordIntelligenceDiagnostic(workspace, 'zoekt_background_refresh_failed', error));
  }, ZOEKT_RECONCILE_DELAY_MS);
  state.zoektReconcileTimer.unref?.();
}

function clearZoektReconcile(state) {
  if (!state?.zoektReconcileTimer) return;
  clearTimeout(state.zoektReconcileTimer);
  state.zoektReconcileTimer = null;
}

function decorateMetadata(state, metadata) {
  if (!metadata) return metadata;
  return { ...metadata, runtimeStatus: state.status, pendingRefresh: state.dirty, lastError: state.lastError };
}

function serializableZoektSettings(config = {}) {
  const settings = config?.repositoryIntelligence || {};
  return {
    zoektSearchExecutable: String(settings.zoektSearchExecutable || ''),
    zoektIndexExecutable: String(settings.zoektIndexExecutable || '')
  };
}

function serializableWorkspace(workspace) {
  const context = workspace?.context && typeof workspace.context === 'object' ? workspace.context : {};
  return {
    alias: String(workspace?.alias || ''),
    path: String(workspace?.path || ''),
    context: {
      includeRoots: Array.isArray(context.includeRoots) ? context.includeRoots : Array.isArray(context.includePaths) ? context.includePaths : [],
      excludePaths: Array.isArray(context.excludePaths) ? context.excludePaths : []
    }
  };
}

function incrementalRefreshPaths(state) {
  const exactPaths = [...state.pendingPaths];
  const directories = [...state.pendingDirectories].filter(directory =>
    !exactPaths.some(relativePath => relativePath.startsWith(`${directory}/`)));
  return [...exactPaths, ...directories].slice(0, MAX_INCREMENTAL_PATHS);
}

function pendingRefreshPathCount(state) {
  return state.pendingPaths.size + state.pendingDirectories.size;
}

function clearPendingRefreshPaths(state) {
  state.pendingPaths.clear();
  state.pendingDirectories.clear();
}

function watchPathIsDirectory(root, relativePath) {
  try { return fs.statSync(path.resolve(root, relativePath)).isDirectory(); } catch { return false; }
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map(normalizeWatchPath).filter(Boolean))];
}

function normalizeWatchPath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

function normalizeMode(value) {
  const mode = String(value || 'refresh').toLowerCase();
  return ['refresh', 'rebuild', 'recover', 'zoekt'].includes(mode) ? mode : 'refresh';
}

function statusForMode(mode, metadata) {
  if (mode === 'recover') return 'recovering';
  if (mode === 'rebuild') return 'rebuilding';
  return metadata ? 'refreshing' : 'building';
}

function boundedMaxFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_INDEX_FILES;
  return Math.max(1, Math.min(500000, Math.floor(parsed)));
}

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function workerError(details = {}) {
  const error = new Error(String(details.message || 'Repository Intelligence worker failed.'));
  error.name = String(details.name || 'Error');
  if (details.code) error.code = String(details.code);
  if (details.stack) error.stack = String(details.stack);
  return error;
}

function abortError(message) {
  const error = new Error(String(message || 'Repository Intelligence indexing was cancelled.'));
  error.name = 'AbortError';
  error.code = 'INDEX_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason instanceof Error ? signal.reason.message : 'Repository Intelligence request cancelled.');
}

function boundedErrorMessage(error) {
  return String(error instanceof Error ? error.message : error || 'Unknown error').slice(0, 2000);
}

function isoTime(value) {
  return Number(value) > 0 ? new Date(Number(value)).toISOString() : null;
}

export {
  INDEX_FULL_TIMEOUT_MS,
  INDEX_INCREMENTAL_TIMEOUT_MS,
  cancelRepositoryIndex,
  disposeRepositoryIndex,
  evictIdleRepositoryWorkers,
  ensureRepositoryIndex,
  noteRepositoryMutation,
  rebuildRepositoryIndex,
  recoverRepositoryIndex,
  repositoryIndexStatus,
  shutdownRepositoryIndexes
};
