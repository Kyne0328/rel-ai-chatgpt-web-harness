// Hierarchical workspace/task reader-writer queue.
//
// Normal task-scoped tool calls share a workspace-level read barrier and then
// acquire a task-local reader/writer lane. This keeps ordinary calls within one
// logical task ordered while allowing independent ChatGPT sessions/tasks to work
// in the same workspace concurrently. Source mutations use a separate workspace
// mutation lane and may opt out of the task lane so long edits/commands remain
// mutually exclusive without preventing safe reads or control-plane work in the
// same task. Repository-global operations acquire the workspace barrier as a
// writer, so commit, push, reset, restore, tidy, and worktree changes remain
// exclusive across every task.
//
// Both levels are FIFO-fair: a waiting writer blocks later readers, preventing
// workspace-global maintenance and task-local writes from starving. Waiting calls
// are abort-aware so a disconnected MCP request never remains queued until an
// unrelated operation eventually releases its lock.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const queueOwnerContext = new AsyncLocalStorage();
const locks = new Map();
const mutationBlocks = new Map();
const workspaceIdentities = new Map();
const mutationBlockListeners = new Set();
const mutationBlockControllers = new Map();

const READ = 'read';
const WRITE = 'write';
const TASK_SCOPE = 'task';
const MUTATION_SCOPE = 'mutation';
const WORKSPACE_SCOPE = 'workspace';

function lockStateFor(key) {
  let state = locks.get(key);
  if (!state) {
    state = { activeReaders: 0, activeWriter: false, activeWriterOwner: null, queue: [] };
    locks.set(key, state);
  }
  return state;
}

function admitWaiting(state) {
  while (state.queue.length > 0) {
    const next = state.queue[0];
    if (next.mode === READ) {
      if (state.activeWriter) return;
      state.queue.shift();
      state.activeReaders += 1;
      next.admit();
      continue;
    }
    if (state.activeWriter || state.activeReaders > 0) return;
    state.queue.shift();
    state.activeWriter = true;
    state.activeWriterOwner = next.owner || null;
    next.admit();
    return;
  }
}

function acquire(state, mode, signal, timeoutMs = 0, owner = null, reportedTimeoutMs = timeoutMs, onQueueState = null) {
  throwIfAborted(signal);
  const queuedAt = Date.now();
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanupWait = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.('abort', onAbort);
    };
    const entry = {
      mode,
      owner: owner && typeof owner === 'object' ? { ...owner } : null,
      settled: false,
      onQueueState,
      lastQueueState: '',
      admit: () => {
        if (entry.settled) return;
        entry.settled = true;
        cleanupWait();
        resolve(Date.now() - queuedAt);
      }
    };
    const removeWaitingEntry = () => {
      const index = state.queue.indexOf(entry);
      if (index < 0) return false;
      state.queue.splice(index, 1);
      return true;
    };
    const onAbort = () => {
      if (entry.settled || !removeWaitingEntry()) return;
      entry.settled = true;
      cleanupWait();
      reject(workspaceOperationAbortError(signal));
      admitWaiting(state);
      notifyQueueStates(state);
    };
    const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.max(1, Math.floor(Number(timeoutMs)))
      : 0;

    state.queue.push(entry);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (boundedTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (entry.settled || !removeWaitingEntry()) return;
        entry.settled = true;
        cleanupWait();
        reject(workspaceOperationQueueTimeoutError(reportedTimeoutMs, state, entry.owner));
        admitWaiting(state);
        notifyQueueStates(state);
      }, boundedTimeoutMs);
    }
    admitWaiting(state);
    notifyQueueStates(state);
  });
}

function notifyQueueStates(state) {
  let precedingWriter = null;
  for (let index = 0; index < state.queue.length; index += 1) {
    const entry = state.queue[index];
    const owner = state.activeWriterOwner || precedingWriter?.owner;
    if (!precedingWriter && entry.mode === WRITE) precedingWriter = entry;
    if (typeof entry.onQueueState !== 'function') continue;
    const details = {
      queuePosition: index + 1,
      blocking: disclosedQueueOwner(owner, entry.owner),
      activeReaderCount: state.activeReaders
    };
    const signature = JSON.stringify(details);
    if (signature === entry.lastQueueState) continue;
    entry.lastQueueState = signature;
    try { entry.onQueueState(details); } catch { /* Diagnostics cannot strand a queue. */ }
  }
}

function release(key, state, mode) {
  if (mode === READ) state.activeReaders = Math.max(0, state.activeReaders - 1);
  else {
    state.activeWriter = false;
    state.activeWriterOwner = null;
  }
  admitWaiting(state);
  notifyQueueStates(state);
  deleteIdleLock(key, state);
}

function deleteIdleLock(key, state) {
  if (state.activeReaders === 0 && !state.activeWriter && state.queue.length === 0) {
    locks.delete(key);
  }
}

async function withLock(key, mode, operation, signal, timeoutMs = 0, owner = null, reportedTimeoutMs = timeoutMs, onQueueState = null) {
  const state = lockStateFor(key);
  let waitMs;
  try {
    waitMs = await acquire(state, mode, signal, timeoutMs, owner, reportedTimeoutMs, onQueueState);
  } catch (error) {
    deleteIdleLock(key, state);
    throw error;
  }
  try {
    // The signal can flip after admission resolves but before this continuation
    // resumes. In that race, release the acquired lock without invoking work.
    throwIfAborted(signal);
    return await queueOwnerContext.run(owner, () => operation(waitMs, state));
  } finally {
    release(key, state, mode);
  }
}

function workspaceIdentity(workspace) {
  return workspaceIdentities.get(String(workspace || '').trim()) || String(workspace || '').trim();
}

function canonicalPath(value) {
  let resolved;
  try { resolved = fs.realpathSync.native(path.resolve(value)); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    resolved = path.resolve(value);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readSmallMetadata(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8192) throw new Error('Git identity metadata is not a bounded regular file.');
  const descriptor = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(8193);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 8192) throw new Error('Git identity metadata exceeded its byte limit.');
    return bytes.subarray(0, count).toString('utf8').trim();
  } finally { fs.closeSync(descriptor); }
}

function canonicalWorkspaceAuthority(directory) {
  const physical = canonicalPath(directory);
  let current = physical;
  for (;;) {
    const marker = path.join(current, '.git');
    let stat;
    try { stat = fs.statSync(marker); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    if (stat) {
      let admin = marker;
      if (stat.isFile()) {
        const match = /^gitdir:\s+(.+)$/u.exec(readSmallMetadata(marker));
        if (!match) throw new Error('Cannot establish Git worktree identity.');
        admin = path.resolve(current, match[1]);
      } else if (!stat.isDirectory()) throw new Error('Cannot establish Git directory identity.');
      let common = admin;
      try { common = path.resolve(admin, readSmallMetadata(path.join(admin, 'commondir'))); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return 'repo:' + canonicalPath(common);
    }
    const parent = path.dirname(current);
    if (parent === current) return 'path:' + physical;
    current = parent;
  }
}

// Bind before admission. Aliases remain the public label, while queue and
// quarantine authority use one physical repository identity (including worktrees).
function bindWorkspaceOperationIdentity(workspaceAlias, directory) {
  const alias = String(workspaceAlias || '').trim();
  if (!alias || !directory) return;
  const identity = canonicalWorkspaceAuthority(directory);
  const previous = workspaceIdentity(alias);
  if (previous === identity) return;
  if ([...locks.keys()].some(key => key === 'workspace:' + previous || key.startsWith('workspace:' + previous + ':'))) {
    throw Object.assign(new Error('Workspace identity changed while operations were active. Retry after they settle.'), { code: 'WORKSPACE_IDENTITY_BUSY', retryable: true });
  }
  const block = mutationBlocks.get(previous);
  workspaceIdentities.set(alias, identity);
  if (previous === alias && block && !mutationBlocks.has(identity)) mutationBlocks.set(identity, block);
  for (const listener of mutationBlockListeners) {
    try { listener({ alias, mutationBlock: workspaceMutationBlockSummary(alias) }); } catch {}
  }
}

function workspaceOperationAliases(workspaceAlias) {
  const alias = String(workspaceAlias || '').trim();
  const identity = workspaceIdentity(alias);
  return [...new Set([alias, ...[...workspaceIdentities].filter(([, value]) => value === identity).map(([key]) => key)])];
}

function workspaceKey(workspace) {
  return `workspace:${workspaceIdentity(workspace)}`;
}

function taskKey(workspace, taskId) {
  return `workspace:${workspaceIdentity(workspace)}:task:${taskId}`;
}

function mutationKey(workspace) {
  return `workspace:${workspaceIdentity(workspace)}:mutation`;
}

function notifyWait(options, waitMs, details) {
  if (typeof options.onWait !== 'function') return;
  try {
    options.onWait(waitMs, details);
  } catch {
    // Observability must never strand an acquired lock or fail the operation.
  }
}

function workspaceOperationAbortError(signal) {
  const reason = signal?.reason;
  if (reason?.code === 'WORKSPACE_MUTATION_BLOCKED') return reason;
  const message = reason instanceof Error && reason.message
    ? reason.message
    : 'Workspace operation was cancelled before execution.';
  const error = new Error(message, reason instanceof Error ? { cause: reason } : undefined);
  error.name = 'AbortError';
  error.code = 'WORKSPACE_OPERATION_ABORTED';
  error.executed = false;
  error.retryable = true;
  return error;
}

// A shared workspace lock does not grant access to another principal's task.
// Unattributed callers receive only generic queue diagnostics.
function disclosedQueueOwner(owner, requester) {
  const principal = String(requester?.principalFingerprint || '');
  if (!principal || principal !== String(owner?.principalFingerprint || '')) return {};
  return {
    owner: owner.operation || '', operationId: owner.operationId || '', taskId: owner.taskId || '',
    ...(owner.startedAt ? { startedAt: owner.startedAt } : {})
  };
}

function workspaceOperationQueueTimeoutError(timeoutMs, state = {}, requester = null) {
  const disclosed = disclosedQueueOwner(state.activeWriterOwner, requester);
  const blocker = { ...disclosed, operation: disclosed.owner };
  const blockerLabel = blocker?.operation ? ` Blocked by ${blocker.operation}${blocker.taskId ? ` in task ${blocker.taskId}` : ''}.` : '';
  const error = new Error(`Workspace operation queue wait exceeded ${timeoutMs}ms.${blockerLabel} The waiting operation was not started; retry after the blocker finishes or stop it.`);
  error.code = 'WORKSPACE_OPERATION_QUEUE_TIMEOUT';
  error.executed = false;
  error.retryable = true;
  error.queueTimeoutMs = timeoutMs;
  if (blocker?.taskId) error.blockingTaskId = String(blocker.taskId);
  if (blocker?.operationId) error.blockingOperationId = String(blocker.operationId);
  if (blocker?.operation) error.blockingOperation = String(blocker.operation);
  if (blocker?.startedAt) error.blockingStartedAt = blocker.startedAt;
  return error;
}

function workspaceMutationBlockedError(workspace, block) {
  const detail = String(block?.reason || 'Rel.AI could not confirm that a previous mutating process stopped.');
  const error = new Error(`Workspace '${workspace}' mutations are blocked for safety: ${detail} Restart the Rel.AI MCP runtime after confirming no stale process is still modifying this workspace.`);
  error.code = 'WORKSPACE_MUTATION_BLOCKED';
  error.retryable = false;
  error.blockedAt = block?.blockedAt || null;
  return error;
}

function throwIfWorkspaceMutationBlocked(workspace) {
  const block = mutationBlocks.get(workspaceIdentity(workspace));
  if (block) throw workspaceMutationBlockedError(workspace, block);
}

function mutationBlockControllerFor(workspace) {
  workspace = workspaceIdentity(workspace);
  let controller = mutationBlockControllers.get(workspace);
  if (!controller) {
    controller = new AbortController();
    mutationBlockControllers.set(workspace, controller);
  }
  return controller;
}

function mutationQueueSignal(workspace, callerSignal) {
  const blockSignal = mutationBlockControllerFor(workspace).signal;
  if (!callerSignal) return blockSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, blockSignal]);
  const controller = new AbortController();
  const forward = signal => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  if (callerSignal.aborted) forward(callerSignal);
  else callerSignal.addEventListener('abort', () => forward(callerSignal), { once: true });
  if (blockSignal.aborted) forward(blockSignal);
  else blockSignal.addEventListener('abort', () => forward(blockSignal), { once: true });
  return controller.signal;
}

function blockWorkspaceMutations(workspaceAlias, reason) {
  const workspace = String(workspaceAlias || '').trim();
  if (!workspace) return null;
  const existing = mutationBlocks.get(workspaceIdentity(workspace));
  if (existing) return { ...existing };
  const block = {
    reason: reason instanceof Error ? reason.message : String(reason || 'Previous mutation termination was not confirmed.'),
    blockedAt: new Date().toISOString()
  };
  mutationBlocks.set(workspaceIdentity(workspace), block);
  for (const alias of workspaceOperationAliases(workspace)) {
    for (const listener of mutationBlockListeners) {
      try { listener({ alias, mutationBlock: workspaceMutationBlockSummary(alias) }); } catch { /* Projection cannot change enforcement. */ }
    }
  }
  const controller = mutationBlockControllerFor(workspace);
  if (!controller.signal.aborted) controller.abort(workspaceMutationBlockedError(workspace, block));
  return { ...block };
}

// Never expose raw termination errors, command lines, or another task's owner.
// The queue remains the sole authority; reading this projection cannot clear it.
function workspaceMutationBlockSummary(workspaceAlias, workspacePath = '') {
  const alias = String(workspaceAlias || '').trim();
  const identity = workspacePath ? canonicalWorkspaceAuthority(workspacePath) : workspaceIdentity(alias);
  const block = mutationBlocks.get(identity)
    || (workspacePath && !workspaceIdentities.has(alias) ? mutationBlocks.get(alias) : null);
  return block ? {
    blocked: true,
    code: 'WORKSPACE_MUTATION_BLOCKED',
    blockedAt: block.blockedAt,
    terminationCertainty: 'unknown',
    message: 'A previous mutating process may still be running. Project changes are blocked until its termination is confirmed and safe recovery is completed.'
  } : null;
}

function onWorkspaceMutationBlockChange(listener) {
  if (typeof listener !== 'function') return () => {};
  mutationBlockListeners.add(listener);
  return () => mutationBlockListeners.delete(listener);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw workspaceOperationAbortError(signal);
}

/**
 * Run `operation` under hierarchical workspace/task locking.
 *
 * Task scope is the default when `taskId` is present. Calls in different tasks may
 * overlap, while calls in the same task retain reader/writer ordering. Workspace
 * scope is reserved for repository-global operations that must exclude every task.
 * Calls without a task identity retain the original workspace-level behavior.
 */
async function runWorkspaceOperation(workspaceAlias, operation, options = {}) {
  const workspace = String(workspaceAlias || '').trim();
  if (!workspace) {
    throwIfAborted(options.signal);
    return operation();
  }

  const queueTimeoutMs = Number.isFinite(Number(options.queueTimeoutMs)) && Number(options.queueTimeoutMs) > 0
    ? Math.floor(Number(options.queueTimeoutMs))
    : 0;
  const queueDeadline = queueTimeoutMs > 0 ? Date.now() + queueTimeoutMs : 0;
  const remainingQueueMs = () => queueDeadline > 0 ? Math.max(1, queueDeadline - Date.now()) : 0;
  const mode = options.mode === READ ? READ : WRITE;
  const taskId = String(options.taskId || '').trim();
  const requestedScope = String(options.scope || '');
  const scope = !taskId
    ? WORKSPACE_SCOPE
    : requestedScope === WORKSPACE_SCOPE
      ? WORKSPACE_SCOPE
      : requestedScope === MUTATION_SCOPE
        ? MUTATION_SCOPE
        : TASK_SCOPE;
  const outerKey = workspaceKey(workspace);

  if (scope === WORKSPACE_SCOPE) {
    if (mode === WRITE) throwIfWorkspaceMutationBlocked(workspace);
    const signal = mode === WRITE ? mutationQueueSignal(workspace, options.signal) : options.signal;
    return withLock(outerKey, mode, async (waitMs, state) => {
      if (mode === WRITE) throwIfWorkspaceMutationBlocked(workspace);
      notifyWait(options, waitMs, {
        workspace,
        taskId,
        scope,
        mode,
        queued: state.queue.length
      });
      return operation();
    }, signal, remainingQueueMs(), options.owner, queueTimeoutMs, options.onQueueState);
  }

  if (scope === MUTATION_SCOPE) {
    throwIfWorkspaceMutationBlocked(workspace);
    const signal = mutationQueueSignal(workspace, options.signal);
    return withLock(outerKey, READ, async (workspaceWaitMs, workspaceState) => {
      const enterMutationLane = (taskWaitMs = 0, taskState = null) => withLock(mutationKey(workspace), WRITE, async (mutationWaitMs, mutationState) => {
        throwIfWorkspaceMutationBlocked(workspace);
        const waitMs = workspaceWaitMs + taskWaitMs + mutationWaitMs;
        notifyWait(options, waitMs, {
          workspace,
          taskId,
          scope,
          mode,
          queued: workspaceState.queue.length + (taskState?.queue.length || 0) + mutationState.queue.length
        });
        return operation();
      }, signal, remainingQueueMs(), options.owner, queueTimeoutMs, options.onQueueState);

      if (options.bypassTaskLane === true) return enterMutationLane();
      const laneKey = taskKey(workspace, taskId);
      return withLock(laneKey, mode, (taskWaitMs, taskState) => enterMutationLane(taskWaitMs, taskState),
        signal, remainingQueueMs(), options.owner, queueTimeoutMs, options.onQueueState);
    }, signal, remainingQueueMs(), options.owner, queueTimeoutMs, options.onQueueState);
  }

  return withLock(outerKey, READ, async (workspaceWaitMs, workspaceState) => {
    const laneKey = taskKey(workspace, taskId);
    return withLock(laneKey, mode, async (taskWaitMs, taskState) => {
      const waitMs = workspaceWaitMs + taskWaitMs;
      notifyWait(options, waitMs, {
        workspace,
        taskId,
        scope,
        mode,
        queued: workspaceState.queue.length + taskState.queue.length
      });
      return operation();
    }, options.signal, remainingQueueMs(), options.owner, queueTimeoutMs, options.onQueueState);
  }, options.signal, remainingQueueMs(), options.owner, queueTimeoutMs, options.onQueueState);
}

function runWorkspaceMutationBoundary(workspaceAlias, operation, options = {}) {
  const workspace = String(workspaceAlias || '').trim();
  if (!workspace) {
    throwIfAborted(options.signal);
    return operation();
  }
  const queueTimeoutMs = Number.isFinite(Number(options.queueTimeoutMs)) && Number(options.queueTimeoutMs) > 0
    ? Math.floor(Number(options.queueTimeoutMs))
    : 0;
  throwIfWorkspaceMutationBlocked(workspace);
  const signal = mutationQueueSignal(workspace, options.signal);
  // Validation may enter this narrower boundary from an already-owned task lane.
  const owner = options.owner || queueOwnerContext.getStore() || null;
  return withLock(mutationKey(workspace), WRITE, async (waitMs, state) => {
    throwIfWorkspaceMutationBlocked(workspace);
    notifyWait(options, waitMs, {
      workspace,
      taskId: String(options.taskId || '').trim(),
      scope: MUTATION_SCOPE,
      mode: WRITE,
      queued: state.queue.length
    });
    return operation();
  }, signal, queueTimeoutMs, owner, queueTimeoutMs, options.onQueueState);
}

function pendingWorkspaceOperations() {
  return locks.size;
}

export { canonicalWorkspaceAuthority, bindWorkspaceOperationIdentity, workspaceOperationAliases, blockWorkspaceMutations, workspaceMutationBlockSummary, onWorkspaceMutationBlockChange, runWorkspaceMutationBoundary, runWorkspaceOperation, pendingWorkspaceOperations };
