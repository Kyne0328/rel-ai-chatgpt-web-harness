import os from 'node:os';
import PQueue from 'p-queue';

const availableParallelism = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
const DEFAULT_HEAVY_WORK_LIMIT = Math.min(64, Math.max(2, availableParallelism - 1));
const DEFAULT_HEAVY_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_PERSISTENT_PROCESS_LIMIT = Math.min(12, Math.max(4, availableParallelism * 2));

const HOST_HEAVY_WORK_LIMIT = configuredLimit('REL_AI_MCP_HEAVY_WORK_LIMIT', DEFAULT_HEAVY_WORK_LIMIT);
const HOST_HEAVY_QUEUE_TIMEOUT_MS = configuredTimeout('REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS', DEFAULT_HEAVY_QUEUE_TIMEOUT_MS);
const HOST_REPOSITORY_QUERY_LIMIT = 4;
const HOST_PERSISTENT_PROCESS_LIMIT = configuredLimit('REL_AI_MCP_PERSISTENT_PROCESS_LIMIT', DEFAULT_PERSISTENT_PROCESS_LIMIT);

let ticketSequence = 0;

function createFairResourceScheduler(limits = {}) {
  const lanes = new Map(Object.entries(limits).map(([name, limit]) => [name, createLane(limit)]));

  function acquire(resourceClass, owner, options = {}) {
    const laneName = String(resourceClass || '').trim();
    const lane = lanes.get(laneName);
    if (!lane) throw new Error(`Unknown host resource class '${laneName}'.`);
    if (options.signal?.aborted) return Promise.reject(resourceAbortError(options.signal.reason));

    const ownerKey = String(owner || 'global').trim() || 'global';
    const timeoutMs = positiveTimeout(options.timeoutMs, 0);
    const queuedAt = Date.now();
    const controller = new AbortController();
    const ticketId = `${laneName}:${++ticketSequence}`;
    let admitted = false;
    let queueTimer = null;
    let onAbort = null;

    const leasePromise = new Promise((resolve, reject) => {
      const cleanupQueueWait = () => {
        if (queueTimer) clearTimeout(queueTimer);
        queueTimer = null;
        if (onAbort) options.signal?.removeEventListener?.('abort', onAbort);
        onAbort = null;
      };

      onAbort = () => controller.abort(resourceAbortError(options.signal?.reason));
      options.signal?.addEventListener?.('abort', onAbort, { once: true });
      if (timeoutMs > 0) {
        queueTimer = setTimeout(() => controller.abort(resourceQueueTimeoutError(laneName, timeoutMs)), timeoutMs);
      }

      const queuedTask = lane.queue.add(async () => {
        admitted = true;
        lane.active += 1;
        cleanupQueueWait();
        let releaseSlot;
        const released = new Promise(done => { releaseSlot = done; });
        let didRelease = false;
        resolve({
          resourceClass: laneName,
          owner: ownerKey,
          waitMs: Date.now() - queuedAt,
          release() {
            if (didRelease) return;
            didRelease = true;
            lane.active = Math.max(0, lane.active - 1);
            releaseSlot();
          }
        });
        await released;
      }, {
        id: ticketId,
        owner: ownerKey,
        signal: controller.signal
      });

      void queuedTask.catch(error => {
        cleanupQueueWait();
        if (!admitted) reject(normalizeQueueError(error, controller.signal));
      });
    });

    return leasePromise;
  }

  function stats() {
    return Object.fromEntries([...lanes.entries()].map(([name, lane]) => [name, {
      limit: lane.queue.concurrency,
      active: lane.active,
      queued: lane.queue.size,
      queuedOwners: lane.roundRobin.ownerCount
    }]));
  }

  return Object.freeze({ acquire, stats });
}

function createLane(limit) {
  const holder = {};
  const QueueClass = createOwnerRoundRobinQueueClass(holder);
  const queue = new PQueue({
    concurrency: Math.max(1, Math.floor(Number(limit) || 1)),
    queueClass: QueueClass
  });
  return { queue, roundRobin: holder.instance, active: 0 };
}

function createOwnerRoundRobinQueueClass(holder) {
  return class OwnerRoundRobinQueue {
    constructor() {
      this.queues = new Map();
      this.order = [];
      this.byId = new Map();
      this.size = 0;
      holder.instance = this;
    }

    get ownerCount() {
      return this.order.length;
    }

    enqueue(run, options = {}) {
      const owner = String(options.owner || 'global');
      const id = String(options.id || '');
      let queue = this.queues.get(owner);
      if (!queue) {
        queue = [];
        this.queues.set(owner, queue);
        this.order.push(owner);
      }
      const entry = { run, id, owner };
      queue.push(entry);
      if (id) this.byId.set(id, entry);
      this.size += 1;
    }

    dequeue() {
      while (this.order.length > 0) {
        const owner = this.order.shift();
        const queue = this.queues.get(owner);
        if (!queue?.length) {
          this.queues.delete(owner);
          continue;
        }
        const entry = queue.shift();
        if (queue.length > 0) this.order.push(owner);
        else this.queues.delete(owner);
        if (entry.id) this.byId.delete(entry.id);
        this.size = Math.max(0, this.size - 1);
        return entry.run;
      }
      return undefined;
    }

    remove(id) {
      const key = String(id || '');
      const entry = this.byId.get(key);
      if (!entry) return;
      this.byId.delete(key);
      const queue = this.queues.get(entry.owner);
      const index = queue?.indexOf(entry) ?? -1;
      if (index >= 0) {
        queue.splice(index, 1);
        this.size = Math.max(0, this.size - 1);
      }
      if (queue?.length === 0) {
        this.queues.delete(entry.owner);
        this.order = this.order.filter(owner => owner !== entry.owner);
      }
    }

    filter(options = {}) {
      const owner = options.owner == null ? '' : String(options.owner);
      const entries = owner
        ? (this.queues.get(owner) || [])
        : [...this.queues.values()].flat();
      return entries.map(entry => entry.run);
    }

    setPriority() {}
  };
}

function normalizeQueueError(error, signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (error instanceof Error) return error;
  return new Error(String(error || 'Host resource wait failed.'));
}

function resourceQueueTimeoutError(resourceClass, timeoutMs) {
  const error = new Error(`Host resource '${resourceClass}' queue wait exceeded ${timeoutMs}ms.`);
  error.code = 'HOST_RESOURCE_QUEUE_TIMEOUT';
  error.retryable = true;
  return error;
}

function resourceAbortError(reason) {
  const error = reason instanceof Error
    ? new Error(reason.message, { cause: reason })
    : new Error('Host resource wait was cancelled.');
  error.name = 'AbortError';
  error.code = 'HOST_RESOURCE_ABORTED';
  error.retryable = true;
  return error;
}

function configuredLimit(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(64, Math.max(1, Math.floor(value)));
}

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function configuredTimeout(name, fallback) {
  return positiveTimeout(process.env[name], fallback);
}

const hostResourceScheduler = createFairResourceScheduler({
  heavy: HOST_HEAVY_WORK_LIMIT,
  repositoryQuery: HOST_REPOSITORY_QUERY_LIMIT,
  persistent: HOST_PERSISTENT_PROCESS_LIMIT
});

function acquireHostResource(resourceClass, owner, options = {}) {
  const resource = String(resourceClass || '').trim();
  const timeoutMs = options.timeoutMs ?? (resource === 'heavy' ? HOST_HEAVY_QUEUE_TIMEOUT_MS : undefined);
  return hostResourceScheduler.acquire(resource, owner, {
    ...options,
    ...(timeoutMs != null ? { timeoutMs } : {})
  });
}

function hostResourceStats() {
  return hostResourceScheduler.stats();
}

export {
  HOST_HEAVY_QUEUE_TIMEOUT_MS,
  HOST_HEAVY_WORK_LIMIT,
  HOST_PERSISTENT_PROCESS_LIMIT,
  acquireHostResource,
  createFairResourceScheduler,
  hostResourceStats
};
