import os from 'node:os';
import { createHostMemoryMonitor, createMemoryAdmissionController } from './hostMemoryPressure.js';

const availableParallelism = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
const DEFAULT_PERSISTENT_PROCESS_LIMIT = Math.min(12, Math.max(4, availableParallelism * 2));
const DEFAULT_HEAVY_LIMIT = Math.min(4, Math.max(1, Math.floor(availableParallelism / 2)), Math.max(1, Math.floor(os.totalmem() / (2 * 1024 ** 3))));
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
// Queries have their own pool: they must not queue behind builds or command startup.
const HOST_REPOSITORY_QUERY_LIMIT = configuredLimit('REL_AI_MCP_REPOSITORY_QUERY_LIMIT',
  Math.min(8, Math.max(2, availableParallelism), Math.max(2, Math.floor(os.totalmem() / (1024 ** 3)))));
const HOST_PERSISTENT_PROCESS_LIMIT = configuredLimit('REL_AI_MCP_PERSISTENT_PROCESS_LIMIT', DEFAULT_PERSISTENT_PROCESS_LIMIT);
const HOST_HEAVY_LIMIT = configuredLimit('REL_AI_MCP_HEAVY_PROCESS_LIMIT', DEFAULT_HEAVY_LIMIT);
const configuredReservationMb = Number(process.env.REL_AI_MCP_HEAVY_RESERVATION_MB);
const HOST_HEAVY_RESERVATION_BYTES = (Number.isFinite(configuredReservationMb) && configuredReservationMb > 0
  ? Math.max(128, Math.min(32768, configuredReservationMb)) : 128) * 1024 ** 2;
const HOST_PERSISTENT_QUEUE_TIMEOUT_MS = configuredTimeout('REL_AI_MCP_PERSISTENT_QUEUE_TIMEOUT_MS', DEFAULT_QUEUE_TIMEOUT_MS);
const HOST_HEAVY_QUEUE_TIMEOUT_MS = configuredTimeout('REL_AI_MCP_HEAVY_QUEUE_TIMEOUT_MS', DEFAULT_QUEUE_TIMEOUT_MS);

let ticketSequence = 0;

/**
 * Owner-fair admission with atomic multi-lane acquisition. No ticket holds one
 * lane while waiting for another. The memory gate affects only the heavy lane;
 * repository/control work can still make progress while heavy work is paused.
 * Leases bound finite operations/startup, not descendant CPU or OS job trees.
 */
function createFairResourceScheduler(limits = {}, {
  admission = null,
  onWorkChange = () => {},
  now = Date.now,
  defaultTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS,
  maxQueued = 256,
  maxQueuedPerOwner = 64
} = {}) {
  const lanes = new Map(Object.entries(limits).map(([name, limit]) => [name, {
    limit: Math.max(1, Math.floor(Number(limit) || 1)),
    active: 0, queued: new Set(), owners: new Map(), order: []
  }]));
  let pumping = false;
  let disposed = false;

  function notifyWork() {
    try { onWorkChange(stats()); } catch {}
  }

  function remove(ticket) {
    if (!ticket.queued) return;
    ticket.queued = false;
    for (const resource of ticket.resources) lanes.get(resource).queued.delete(ticket);
    const lane = lanes.get(ticket.primary);
    const queue = lane.owners.get(ticket.owner);
    const index = queue?.indexOf(ticket) ?? -1;
    if (index >= 0) queue.splice(index, 1);
    if (queue?.length === 0) {
      lane.owners.delete(ticket.owner);
      lane.order = lane.order.filter(owner => owner !== ticket.owner);
    }
    if (ticket.timer) clearTimeout(ticket.timer);
    ticket.timer = null;
    ticket.signal?.removeEventListener?.('abort', ticket.onAbort);
  }

  function rejectTicket(ticket, error) {
    if (!ticket.queued) return;
    error.blockedResource = String(ticket.blockedResource || ticket.primary);
    error.resourceReason = String(ticket.blockedReason || 'Host resource admission did not complete.').slice(0, 500);
    remove(ticket);
    ticket.reject(error);
  }

  function rejectionFor(ticket) {
    if (ticket.signal?.aborted) return resourceAbortError(ticket.signal.reason);
    if (now() >= ticket.deadlineAtMs) return resourceQueueTimeoutError(ticket.resources.join('+'), ticket.timeoutMs);
    return null;
  }

  function allowed(ticket) {
    const error = rejectionFor(ticket);
    if (error) { rejectTicket(ticket, error); return false; }
    for (const resource of ticket.resources) {
      const lane = lanes.get(resource);
      if (lane.active >= lane.limit) {
        ticket.blockedResource = resource;
        ticket.blockedReason = "Host resource '" + resource + "' is at capacity.";
        return false;
      }
    }
    const decision = admission?.canAdmit(ticket.resources, ticket.options) || { allowed: true };
    ticket.blockedResource = decision.allowed ? null : ticket.resources.includes('heavy') ? 'heavy' : ticket.primary;
    ticket.blockedReason = decision.allowed ? null : decision.reason;
    return decision.allowed;
  }

  function admit(ticket) {
    // Everything through resolve is synchronous: cancellation or a second
    // request cannot consume the same capacity between checking and reserving.
    remove(ticket);
    const resources = new Set(ticket.resources);
    for (const resource of resources) lanes.get(resource).active += 1;
    const releaseReservation = admission?.reserve(ticket.resources, ticket.options) || (() => {});
    let reservationReleased = false;
    let releasingAll = false;
    function releaseResource(resource) {
      if (!resources.delete(resource)) return;
      lanes.get(resource).active = Math.max(0, lanes.get(resource).active - 1);
      if (resource === 'heavy' && !reservationReleased) {
        reservationReleased = true;
        releaseReservation({ settleUntilFreshSample: !releasingAll && resources.has('persistent') });
      }
      pump();
    }
    ticket.resolve({
      resourceClass: ticket.resources.length === 1 ? ticket.resources[0] : ticket.primary,
      resourceClasses: [...ticket.resources],
      owner: ticket.owner,
      waitMs: Math.max(0, now() - ticket.queuedAt),
      releaseResource,
      release(options = {}) {
        releasingAll = true;
        for (const resource of [...resources]) releaseResource(resource);
        if (options?.confirmedStopped === true) {
          releaseReservation({ confirmedStopped: true });
          pump();
        }
      }
    });
  }

  function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      let progress;
      do {
        progress = false;
        // Inspect one FIFO head per owner per turn. A blocked heavy ticket
        // never prevents an unrelated light lane or another owner progressing.
        for (const lane of lanes.values()) {
          const owners = [...lane.order];
          for (const owner of owners) {
            const ticket = lane.owners.get(owner)?.[0];
            if (!ticket) continue;
            if (!allowed(ticket)) continue;
            // Move this owner to the end even if their FIFO empties on admit.
            lane.order = lane.order.filter(value => value !== owner);
            lane.order.push(owner);
            admit(ticket);
            progress = true;
            break;
          }
        }
      } while (progress);
    } finally {
      pumping = false;
      notifyWork();
    }
  }

  function acquireMany(resourceClasses, owner, options = {}) {
    if (disposed) return Promise.reject(resourceAbortError('Host resource scheduler is closed.'));
    const resources = [...new Set(resourceClasses.map(value => String(value || '').trim()))];
    if (resources.length === 0) throw new Error('At least one host resource class is required.');
    for (const resource of resources) {
      if (!lanes.has(resource)) throw new Error("Unknown host resource class '" + resource + "'.");
    }
    if (options.signal?.aborted) return Promise.reject(resourceAbortError(options.signal.reason));
    const ownerKey = String(owner || 'global').trim() || 'global';
    const queuedAt = now();
    const timeoutMs = positiveTimeout(options.timeoutMs, defaultTimeoutMs);
    const requestedDeadline = Number(options.deadlineAtMs);
    const deadlineAtMs = Math.min(queuedAt + timeoutMs,
      Number.isFinite(requestedDeadline) && requestedDeadline > 0 ? requestedDeadline : Infinity);
    if (deadlineAtMs <= queuedAt) return Promise.reject(resourceQueueTimeoutError(resources.join('+'), 0));
    for (const resource of resources) {
      const lane = lanes.get(resource);
      const ownerQueued = [...lane.queued].filter(ticket => ticket.owner === ownerKey).length;
      if (lane.queued.size >= maxQueued || ownerQueued >= maxQueuedPerOwner) {
        return Promise.reject(Object.assign(new Error("Host resource '" + resource + "' admission queue is full."), {
          code: 'HOST_RESOURCE_QUEUE_FULL', retryable: true
        }));
      }
    }
    return new Promise((resolve, reject) => {
      const primary = resources.includes('heavy') ? 'heavy' : resources[0];
      const lane = lanes.get(primary);
      const ticket = {
        id: ++ticketSequence, primary, resources, owner: ownerKey, options,
        signal: options.signal, resolve, reject, queuedAt, deadlineAtMs, timeoutMs,
        queued: true, timer: null, onAbort: null, blockedReason: null
      };
      for (const resource of resources) lanes.get(resource).queued.add(ticket);
      let queue = lane.owners.get(ownerKey);
      if (!queue) { queue = []; lane.owners.set(ownerKey, queue); lane.order.push(ownerKey); }
      queue.push(ticket);
      ticket.onAbort = () => { rejectTicket(ticket, resourceAbortError(ticket.signal?.reason)); pump(); };
      ticket.signal?.addEventListener?.('abort', ticket.onAbort, { once: true });
      ticket.timer = setTimeout(() => {
        rejectTicket(ticket, resourceQueueTimeoutError(resources.join('+'), timeoutMs));
        pump();
      }, Math.max(1, Math.min(2 ** 31 - 1, deadlineAtMs - now())));
      // Cover cancellation between the initial check and listener registration.
      if (ticket.signal?.aborted) ticket.onAbort();
      else pump();
    });
  }

  function acquire(resourceClass, owner, options = {}) {
    return acquireMany([resourceClass], owner, options);
  }

  function stats() {
    return Object.fromEntries([...lanes.entries()].map(([name, lane]) => [name, {
      limit: lane.limit, active: lane.active, queued: lane.queued.size,
      queuedOwners: new Set([...lane.queued].map(ticket => ticket.owner)).size
    }]));
  }

  function diagnostics() {
    return Object.fromEntries([...lanes.entries()].map(([name, lane]) => {
      const tickets = [...lane.queued];
      return [name, {
        oldestWaitMs: tickets.length ? Math.max(...tickets.map(ticket => Math.max(0, now() - ticket.queuedAt))) : 0,
        blockedReason: tickets.find(ticket => ticket.blockedReason)?.blockedReason ?? null,
        maxQueued, maxQueuedPerOwner
      }];
    }));
  }

  function dispose() {
    disposed = true;
    for (const lane of lanes.values()) {
      for (const ticket of [...lane.queued]) rejectTicket(ticket, resourceAbortError('Host resource scheduler is closed.'));
    }
    notifyWork();
  }

  return Object.freeze({ acquire, acquireMany, stats, diagnostics, pump, dispose });
}

function resourceQueueTimeoutError(resourceClass, timeoutMs) {
  return Object.assign(new Error("Host resource '" + resourceClass + "' queue wait exceeded " + timeoutMs + 'ms.'), {
    code: 'HOST_RESOURCE_QUEUE_TIMEOUT', retryable: true
  });
}

function resourceAbortError(reason) {
  const error = reason instanceof Error ? new Error(reason.message, { cause: reason })
    : new Error(typeof reason === 'string' ? reason : 'Host resource wait was cancelled.');
  return Object.assign(error, { name: 'AbortError', code: 'HOST_RESOURCE_ABORTED', retryable: true });
}

function configuredLimit(name, fallback) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(64, Math.max(1, Math.floor(value)));
}

function positiveTimeout(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, 2 ** 31 - 1) : fallback;
}

function configuredTimeout(name, fallback) {
  return positiveTimeout(process.env[name], fallback);
}

let hostResourceScheduler;
const hostMemoryMonitor = createHostMemoryMonitor({ onSample: () => {
  hostMemoryAdmission.diagnostics();
  hostResourceScheduler?.pump();
} });
const hostMemoryAdmission = createMemoryAdmissionController({
  monitor: hostMemoryMonitor, reservationBytes: HOST_HEAVY_RESERVATION_BYTES
});
hostResourceScheduler = createFairResourceScheduler({
  repositoryQuery: HOST_REPOSITORY_QUERY_LIMIT,
  persistent: HOST_PERSISTENT_PROCESS_LIMIT,
  heavy: HOST_HEAVY_LIMIT
}, {
  admission: hostMemoryAdmission,
  onWorkChange: stats => hostMemoryMonitor.setEnabled(
    stats.heavy.active + stats.heavy.queued > 0 || hostMemoryAdmission.hasPendingSettlements())
});

function acquireHostResources(resourceClasses, owner, options = {}) {
  const resources = [...new Set(resourceClasses.map(value => String(value || '').trim()))];
  const timeoutMs = options.timeoutMs ?? Math.min(...resources.map(resource =>
    resource === 'persistent' ? HOST_PERSISTENT_QUEUE_TIMEOUT_MS
      : resource === 'heavy' ? HOST_HEAVY_QUEUE_TIMEOUT_MS : DEFAULT_QUEUE_TIMEOUT_MS));
  return hostResourceScheduler.acquireMany(resources, owner, { ...options, timeoutMs });
}

function acquireHostResource(resourceClass, owner, options = {}) {
  return acquireHostResources([resourceClass], owner, options);
}

function hostResourceStats() {
  return hostResourceScheduler.stats();
}

// Pure, bounded snapshot. Reading diagnostics does not spawn a probe or retain a
// new background timer. All memory values are bytes; absent metrics remain null.
function hostResourceDiagnosticSnapshot() {
  return {
    lanes: hostResourceScheduler.stats(),
    pressure: hostMemoryAdmission.diagnostics(),
    queues: hostResourceScheduler.diagnostics()
  };
}

// Explicit local diagnostics may request a sample even while the scheduler is idle.
// The monitor coalesces concurrent requests and enforces its sampling interval.
async function refreshHostResourceDiagnostics() {
  await hostMemoryMonitor.refresh();
  return hostResourceDiagnosticSnapshot();
}

export {
  HOST_PERSISTENT_PROCESS_LIMIT, HOST_REPOSITORY_QUERY_LIMIT, acquireHostResource, acquireHostResources,
  createFairResourceScheduler, hostResourceStats, hostResourceDiagnosticSnapshot, refreshHostResourceDiagnostics
};
