import { fileURLToPath } from 'node:url';
import Piscina from 'piscina';

import { repositoryIndexPath } from './database.js';
import { repositoryIndexStatus } from './indexer.js';
import { repositoryIndexSnapshot } from './state.js';
import { measurePerformancePhase } from '../../performanceObservability.js';
import { acquireHostResources, hostResourceStats } from '../../hostResourceScheduler.js';

const QUERY_WORKER_IDLE_EVICT_MS = 60_000;
const QUERY_WORKER_GLOBAL_COUNT = 4;
const QUERY_WORKER_TIMEOUT_MS = 30_000;
const QUERY_WORKER_QUEUE_TIMEOUT_MS = 30_000;
const QUERY_WORKER_FILE = fileURLToPath(new URL('./queryWorker.js', import.meta.url));
const activeByRepository = new Map();
const activeControllersByRepository = new Map();
let pool = null;

function runRepositoryQuery(kind, workspace, config = {}, payload = {}, options = {}) {
  const key = repositoryIndexPath(config, workspace);
  const includePeerState = needsPeerRepositoryState(kind, payload);
  const job = {
    kind,
    workspace: serializableWorkspace(workspace),
    config: serializableConfig(config, { includeWorkspaces: includePeerState }),
    ...(includePeerState ? { repositoryStatuses: repositoryStatusSnapshot(workspace, config) } : {}),
    ...payload,
    options: serializableOptions(options)
  };
  return measurePerformancePhase(
    'repo.lookup',
    () => runPiscinaQuery(key, job, options.signal, options.queryTimeoutMs, options.queryQueueTimeoutMs)
  );
}

function needsPeerRepositoryState(kind, payload = {}) {
  if (kind === 'cachedContext' || kind === 'cachedSummary' || kind === 'searchGraphContext') return true;
  const action = String(payload?.args?.action || '').toLowerCase();
  return kind === 'codeInspect' && (action === 'architecture' || action === 'audit');
}

function repositoryQueryPool() {
  if (pool) return pool;
  pool = new Piscina({
    filename: QUERY_WORKER_FILE,
    minThreads: 0,
    maxThreads: QUERY_WORKER_GLOBAL_COUNT,
    idleTimeout: QUERY_WORKER_IDLE_EVICT_MS
  });
  return pool;
}

async function runPiscinaQuery(key, job, signal, timeoutMs = QUERY_WORKER_TIMEOUT_MS, queueTimeoutMs = QUERY_WORKER_QUEUE_TIMEOUT_MS) {
  if (signal?.aborted) throw queryAbortError(signal.reason);
  const effectiveTimeoutMs = positiveTimeout(timeoutMs, QUERY_WORKER_TIMEOUT_MS);
  const effectiveQueueTimeoutMs = positiveTimeout(queueTimeoutMs, QUERY_WORKER_QUEUE_TIMEOUT_MS);
  const detachController = new AbortController();
  const queueSignal = signal
    ? AbortSignal.any([signal, detachController.signal])
    : detachController.signal;
  activeByRepository.set(key, Number(activeByRepository.get(key) || 0) + 1);
  if (!activeControllersByRepository.has(key)) activeControllersByRepository.set(key, new Set());
  activeControllersByRepository.get(key).add(detachController);

  let resourceLease = null;
  let timer = null;
  try {
    try {
      resourceLease = await acquireHostResources(['repositoryQuery', 'heavy'], key, {
        signal: queueSignal,
        timeoutMs: effectiveQueueTimeoutMs,
        reservationBytes: 256 * 1024 ** 2
      });
    } catch (error) {
      if (queueSignal.aborted) throw queryAbortError(queueSignal.reason);
      if (error?.code === 'HOST_RESOURCE_QUEUE_TIMEOUT') {
        const queueError = new Error(`Repository Intelligence query queue wait exceeded ${effectiveQueueTimeoutMs}ms.`);
        queueError.code = 'QUERY_QUEUE_TIMEOUT';
        throw queueError;
      }
      throw error;
    }

    const timeoutController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal, detachController.signal])
      : AbortSignal.any([timeoutController.signal, detachController.signal]);
    const timeoutError = Object.assign(
      new Error(`Repository Intelligence query execution exceeded ${effectiveTimeoutMs}ms.`),
      { code: 'QUERY_TIMEOUT' }
    );
    timer = setTimeout(() => timeoutController.abort(timeoutError), effectiveTimeoutMs);
    timer.unref?.();

    try {
      const message = await repositoryQueryPool().run(job, { signal: combinedSignal });
      if (message?.ok === false) throw workerError(message.error);
      return message?.result;
    } catch (error) {
      if (combinedSignal.aborted) throw queryAbortError(combinedSignal.reason);
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
    resourceLease?.release();
    const remaining = Number(activeByRepository.get(key) || 1) - 1;
    if (remaining > 0) activeByRepository.set(key, remaining);
    else activeByRepository.delete(key);
    const controllers = activeControllersByRepository.get(key);
    controllers?.delete(detachController);
    if (!controllers?.size) activeControllersByRepository.delete(key);
  }
}

function repositoryQueryWorkerStats() {
  const current = pool;
  return {
    globalWorkerLimit: QUERY_WORKER_GLOBAL_COUNT,
    liveWorkerCount: current?.threads?.length || 0,
    hostHeavyLane: hostResourceStats().heavy,
    hostRepositoryQueryLane: hostResourceStats().repositoryQuery,
    pools: [...activeByRepository.entries()].map(([key, active]) => ({
      key,
      workers: current?.threads?.length || 0,
      active,
      queued: current?.queueSize || 0
    }))
  };
}

function repositoryStatusSnapshot(workspace, config) {
  const result = {};
  const entries = [[workspace.alias, workspace], ...Object.entries(config.workspaces || {}).map(([alias, item]) => [alias, { alias, ...(item || {}) }])];
  for (const [alias, candidate] of entries) {
    if (!alias || !candidate?.path || result[alias]) continue;
    try {
      result[alias] = repositoryIndexSnapshot(repositoryIndexStatus(candidate, config));
    } catch {}
  }
  return result;
}

function serializableWorkspace(workspace = {}) {
  return {
    alias: String(workspace.alias || ''),
    path: String(workspace.path || ''),
    context: plainObject(workspace.context)
  };
}

function serializableConfig(config = {}, options = {}) {
  const workspaces = {};
  if (options.includeWorkspaces === true) {
    for (const [alias, workspace] of Object.entries(config.workspaces || {})) workspaces[alias] = serializableWorkspace({ alias, ...workspace });
  }
  return {
    ...(config.stateDir ? { stateDir: String(config.stateDir) } : {}),
    repositoryIntelligence: plainObject(config.repositoryIntelligence),
    ...(options.includeWorkspaces === true ? { workspaces } : {})
  };
}

function serializableOptions(options = {}) {
  return {
    ...(options.graphDiffusion === false ? { graphDiffusion: false } : {}),
    ...(options.maxResults != null ? { maxResults: Number(options.maxResults) } : {}),
    ...(options.maxNodes != null ? { maxNodes: Number(options.maxNodes) } : {}),
    ...(options.maxEdges != null ? { maxEdges: Number(options.maxEdges) } : {})
  };
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item == null || ['string', 'number', 'boolean'].includes(typeof item) || Array.isArray(item) || typeof item === 'object'));
}

function workerError(details = {}) {
  const error = new Error(String(details.message || 'Repository Intelligence query worker failed.'));
  error.name = String(details.name || 'Error');
  if (details.code) error.code = String(details.code);
  if (details.stack) error.stack = String(details.stack);
  return error;
}

function queryAbortError(reason) {
  const error = reason instanceof Error ? new Error(reason.message) : new Error('Repository Intelligence query cancelled.');
  error.name = 'AbortError';
  error.code = reason?.code === 'QUERY_TIMEOUT' ? 'QUERY_TIMEOUT' : 'QUERY_ABORTED';
  return error;
}

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

async function disposeRepositoryQueryWorker(workspace, config = {}) {
  const key = repositoryIndexPath(config, workspace);
  const controllers = activeControllersByRepository.get(key);
  if (!controllers?.size) return false;
  const reason = new Error('Repository Intelligence workspace detached.');
  for (const controller of [...controllers]) controller.abort(reason);
  activeControllersByRepository.delete(key);
  activeByRepository.delete(key);
  return true;
}

async function shutdownRepositoryQueryWorkers() {
  const reason = new Error('Repository Intelligence is shutting down.');
  for (const controllers of activeControllersByRepository.values()) {
    for (const controller of [...controllers]) controller.abort(reason);
  }
  activeControllersByRepository.clear();
  activeByRepository.clear();
  if (!pool) return [];
  const current = pool;
  pool = null;
  return Promise.allSettled([current.destroy()]);
}

export {
  QUERY_WORKER_GLOBAL_COUNT,
  QUERY_WORKER_IDLE_EVICT_MS,
  QUERY_WORKER_TIMEOUT_MS,
  QUERY_WORKER_QUEUE_TIMEOUT_MS,
  disposeRepositoryQueryWorker,
  repositoryQueryWorkerStats,
  runRepositoryQuery,
  shutdownRepositoryQueryWorkers
};
