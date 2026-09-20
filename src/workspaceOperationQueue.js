// Hierarchical workspace/task reader-writer queue.
//
// Normal tool calls share a workspace-level read barrier and then acquire a
// task-local reader/writer lane. This keeps calls within one logical task ordered
// while allowing independent ChatGPT sessions/tasks to work in the same workspace
// concurrently. Repository-global operations acquire the workspace barrier as a
// writer, so commit, push, reset, restore, tidy, and worktree changes remain
// exclusive across every task.
//
// Both levels are FIFO-fair: a waiting writer blocks later readers, preventing
// workspace-global maintenance and task-local writes from starving. Waiting calls
// are abort-aware so a disconnected MCP request never remains queued until an
// unrelated operation eventually releases its lock.

const locks = new Map();
const mutationBlocks = new Map();
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

function acquire(state, mode, signal, timeoutMs = 0, owner = null, reportedTimeoutMs = timeoutMs) {
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
        reject(workspaceOperationQueueTimeoutError(reportedTimeoutMs, state));
        admitWaiting(state);
      }, boundedTimeoutMs);
    }
    admitWaiting(state);
  });
}

function release(key, state, mode) {
  if (mode === READ) state.activeReaders = Math.max(0, state.activeReaders - 1);
  else {
    state.activeWriter = false;
    state.activeWriterOwner = null;
  }
  admitWaiting(state);
  deleteIdleLock(key, state);
}

function deleteIdleLock(key, state) {
  if (state.activeReaders === 0 && !state.activeWriter && state.queue.length === 0) {
    locks.delete(key);
  }
}

async function withLock(key, mode, operation, signal, timeoutMs = 0, owner = null, reportedTimeoutMs = timeoutMs) {
  const state = lockStateFor(key);
  let waitMs;
  try {
    waitMs = await acquire(state, mode, signal, timeoutMs, owner, reportedTimeoutMs);
  } catch (error) {
    deleteIdleLock(key, state);
    throw error;
  }
  try {
    // The signal can flip after admission resolves but before this continuation
    // resumes. In that race, release the acquired lock without invoking work.
    throwIfAborted(signal);
    return await operation(waitMs, state);
  } finally {
    release(key, state, mode);
  }
}

function workspaceKey(workspace) {
  return `workspace:${workspace}`;
}

function taskKey(workspace, taskId) {
  return `workspace:${workspace}:task:${taskId}`;
}

function mutationKey(workspace) {
  return `workspace:${workspace}:mutation`;
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
  error.retryable = true;
  return error;
}

function workspaceOperationQueueTimeoutError(timeoutMs, state = {}) {
  const blocker = state.activeWriterOwner && typeof state.activeWriterOwner === 'object' ? state.activeWriterOwner : null;
  const blockerLabel = blocker?.operation ? ` Blocked by ${blocker.operation}${blocker.taskId ? ` in task ${blocker.taskId}` : ''}.` : '';
  const error = new Error(`Workspace operation queue wait exceeded ${timeoutMs}ms.${blockerLabel} The waiting operation was not started; retry after the blocker finishes or stop it.`);
  error.code = 'WORKSPACE_OPERATION_QUEUE_TIMEOUT';
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
  const block = mutationBlocks.get(workspace);
  if (block) throw workspaceMutationBlockedError(workspace, block);
}

function mutationBlockControllerFor(workspace) {
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
  const existing = mutationBlocks.get(workspace);
  if (existing) return { ...existing };
  const block = {
    reason: reason instanceof Error ? reason.message : String(reason || 'Previous mutation termination was not confirmed.'),
    blockedAt: new Date().toISOString()
  };
  mutationBlocks.set(workspace, block);
  const controller = mutationBlockControllerFor(workspace);
  if (!controller.signal.aborted) controller.abort(workspaceMutationBlockedError(workspace, block));
  return { ...block };
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
    }, signal, remainingQueueMs(), options.owner, queueTimeoutMs);
  }

  if (scope === MUTATION_SCOPE) {
    throwIfWorkspaceMutationBlocked(workspace);
    const signal = mutationQueueSignal(workspace, options.signal);
    return withLock(outerKey, READ, async (workspaceWaitMs, workspaceState) => {
      const laneKey = taskKey(workspace, taskId);
      return withLock(laneKey, mode, async (taskWaitMs, taskState) => {
        return withLock(mutationKey(workspace), WRITE, async (mutationWaitMs, mutationState) => {
          throwIfWorkspaceMutationBlocked(workspace);
          const waitMs = workspaceWaitMs + taskWaitMs + mutationWaitMs;
          notifyWait(options, waitMs, {
            workspace,
            taskId,
            scope,
            mode,
            queued: workspaceState.queue.length + taskState.queue.length + mutationState.queue.length
          });
          return operation();
        }, signal, remainingQueueMs(), options.owner, queueTimeoutMs);
      }, signal, remainingQueueMs(), options.owner, queueTimeoutMs);
    }, signal, remainingQueueMs(), options.owner, queueTimeoutMs);
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
    }, options.signal, remainingQueueMs(), options.owner, queueTimeoutMs);
  }, options.signal, remainingQueueMs(), options.owner, queueTimeoutMs);
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
  }, signal, queueTimeoutMs, options.owner);
}

function pendingWorkspaceOperations() {
  return locks.size;
}

export { blockWorkspaceMutations, runWorkspaceMutationBoundary, runWorkspaceOperation, pendingWorkspaceOperations };
