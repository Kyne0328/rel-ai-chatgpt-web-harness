import * as path from 'node:path';
import { createOperationTimeline } from '../operationTimeline.js';
import { principalFingerprint, principalForContext, principalKind } from '../mcp/principal.ts';
import { PRINCIPAL_KIND } from '../mcp/contracts.ts';

import { combineAbortSignals } from '../abortSignals.ts';
import { hasAgentCancellationHandle } from '../executionControl.js';
import { isClearlyReadOnlyExec } from '../executionClassification.js';
import { resolveWorkspace } from '../config.js';
import { fallbackExecutionsStatus, updateFallbackExecutionPhase } from '../mcp/fallbackExecutions.js';
import { addSpanEvent, runSpan, setSpanAttributes } from '../telemetry.js';
import { claimTaskChangedFiles, ensureTaskBaseline } from '../taskIntegrity.ts';
import { getCurrentTaskAbortSignal, runWithToolActivity, updateCurrentToolActivity } from '../toolActivity.js';
import { blockWorkspaceMutations, runWorkspaceOperation } from '../workspaceOperationQueue.js';
import { isProcessTreeAlive } from '../process.ts';
import { listMutationProcessRecords, removeMutationProcessRecord, runWithMutationProcessOwnership } from '../mutationProcessOwnership.js';
import { recoverStructuredPatchTransaction } from '../structuredPatchTransaction.js';
import {
  measurePerformancePhase,
  performanceTimingAttributes,
  recordPerformancePhase
} from '../performanceObservability.js';
import { maybeStartSession } from './session.js';
import { OPERATION_IDS as OP } from './operationIds.js';

const DEFAULT_FOREGROUND_WORKSPACE_QUEUE_TIMEOUT_MS = 30_000;
const WORK_FINISH_QUEUE_TIMEOUT_MS = 2_000;
const DEFAULT_MUTATION_WATCHDOG_MS = 5 * 60_000;
const MUTATION_WATCHDOG_TERMINATION_GRACE_MS = 15_000;

async function executeToolCall({ config, name, executionName = name, effectiveArgs, context, requestTaskContext = null, finishActivity, definition, started, workspaceOverride = null }) {
  let sessionStart = { started: false, alias: '' };
  let timeline;
  const queuePrincipal = principalForContext(context, context?.publicHttpOnly === true);
  const queuePrincipalFingerprint = principalKind(queuePrincipal) === PRINCIPAL_KIND.CONNECTOR_ANONYMOUS
    ? '' : principalFingerprint(queuePrincipal);
  const spanTaskId = String(finishActivity?.taskId || requestTaskContext?.taskId || effectiveArgs?.work_id || '').trim();
  const value = await runWithToolActivity(finishActivity, () => runSpan(config,
    executionName === OP.WORK_BEGIN ? 'relai.logical_task.start' : 'relai.tool.call',
    spanAttributes(name, effectiveArgs, context, spanTaskId),
    async () => {
      const taskId = String(finishActivity?.taskId || effectiveArgs?.work_id || '').trim();
      const backgroundReference = String(effectiveArgs?.operationId || taskId || '').trim();
      // Compact connector status is control-plane work even when the requested
      // operation is completed, unknown, or not represented by a fallback record.
      const compactStatusMode = [OP.WORK_RESULT, OP.WORK_HISTORY].includes(executionName) || (executionName === OP.WORK_STATUS
        && context?.publicHttpOnly === true
        && effectiveArgs?.detail !== 'full');
      const backgroundStatusMode = compactStatusMode || (executionName === OP.WORK_STATUS
        && Boolean(backgroundReference)
        && fallbackExecutionsStatus(backgroundReference, { config, workId: taskId }).some(record => record.status === 'running'));
      const workspace = workspaceOverride || (effectiveArgs?.workspace ? resolveWorkspace(config, effectiveArgs.workspace) : null);
      const directFilesystem = workspace?.directFilesystem === true;
      const branchChange = isExplicitBranchChange(executionName, effectiveArgs);
      const readOnlyExec = executionName === OP.EXEC && isClearlyReadOnlyExec(effectiveArgs);
      const queueMode = queueModeFor(executionName, definition, readOnlyExec);
      const queueScope = queueScopeFor(executionName, definition, branchChange, readOnlyExec);
      const queueTaskId = taskId || detachedQueueTaskId(context, queueScope);
      const requestedTimeoutMs = Number(effectiveArgs?.timeoutMs);
      const inheritedDeadlineAtMs = Number(context?.deadlineAtMs);
      const deadlineAtMs = Number.isFinite(inheritedDeadlineAtMs) && inheritedDeadlineAtMs > 0
        ? Math.floor(inheritedDeadlineAtMs)
        : Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
          ? Date.now() + Math.floor(requestedTimeoutMs)
          : 0;
      const remainingDeadlineMs = deadlineAtMs - Date.now();
      const deadlineSignal = deadlineAtMs > 0
        ? remainingDeadlineMs <= 0
          ? AbortSignal.abort(new DOMException('Execution deadline expired before admission.', 'TimeoutError'))
          : AbortSignal.timeout(remainingDeadlineMs)
        : undefined;
      // Already-requested cancellation is the first cause even when a deadline
      // expired while synchronous preparation prevented timer delivery.
      const requestSignal = combineAbortSignals(context?.signal, finishActivity?.signal, deadlineSignal);
      timeline = createOperationTimeline({
        acceptedAtMs: started,
        deadlineKind: deadlineAtMs > 0 ? 'operation' : 'admission',
        onUpdate: snapshot => {
          updateCurrentToolActivity({ metadata: { timeline: snapshot } });
          updateFallbackExecutionPhase(context?.fallbackOperationId, snapshot.phase, config, snapshot);
        }
      });
      let taskBaselineStatusOutput;

      const invokeHandler = async (args, signal = requestSignal) => {
        if (typeof definition?.handler !== 'function') throw new Error(`Tool '${name}' has no executable handler.`);
        if (executionName !== OP.EXEC) timeline.transition('running', { executed: true });
        const handled = await measurePerformancePhase('tool.execution', () => definition.handler(config, args || {}, {
          connector: Boolean(context?.publicHttpOnly),
          taskId,
          requestHeaders: context?.requestHeaders || {},
          mcp: context?.mcp || {},
          conversationId: context?.conversationId,
          transportSessionId: context?.transportSessionId,
          signal,
          onOperationPhase: event => timeline.transition(event.phase, event),
          ...(deadlineAtMs > 0 ? { deadlineAtMs } : {}),
          principal: context?.principal,

          transportType: context?.transportType,
          executionMode: context?.executionMode || '',
          cancel: context?.cancel || null,
          requestTaskContext,
          backgroundStatusMode,
          fallbackOperationId: context?.fallbackOperationId || '',
          mutationTrackingRequired: executionName !== OP.EXEC || !readOnlyExec,
          resourceClass: readOnlyExec ? 'light' : 'heavy',
          ...(taskBaselineStatusOutput !== undefined ? { preExecutionGitStatus: taskBaselineStatusOutput } : {}),
          workspaceOverride: workspaceOverride || undefined
        }));
        if (workspace
          && !directFilesystem
          && taskId
          && effectiveArgs?.dryRun !== true
          && (executionName === OP.EDIT || executionName === OP.EXEC)
          && Array.isArray(handled?.changedFiles)
          && handled.changedFiles.length) {
          try {
            timeline.transition('persisting');
            claimTaskChangedFiles(config, taskId, workspace.alias, handled.changedFiles);
          } catch (error) {
            const code = String(error?.code || '');
            if (code !== 'TASK_INTEGRITY_PERSISTENCE_FAILED' && code !== 'ERR_SQLITE_ERROR'
              && !['EACCES', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'].includes(code)) throw error;
            const failure = new Error(`Workspace/task integrity state could not be persisted for '${workspace.alias}'.`, { cause: error });
            failure.code = 'TASK_INTEGRITY_PERSISTENCE_FAILED';
            failure.retryable = false;
            failure.handlerResultKnown = true;
            failure.handlerResult = handled;
            throw failure;
          }
        }
        if (handled && typeof handled === 'object' && !Array.isArray(handled) && handled.ok === false && handled.error?.code === 'CANCELLED') {
          context?.cancel?.throwIfCancelled?.();
        }
        return handled;
      };

      if (executionName === OP.WORK_FINISH) finishActivity?.assertCompletionAvailable?.();
      const operationSignal = combineAbortSignals(requestSignal, finishActivity?.signal);
      timeline.transition('queued');
      const result = await runWorkspaceOperation(
        executionName === OP.WORK_BEGIN || executionName === OP.WORK_STOP || executionName === OP.WORK_CANCEL || executionName === OP.PROCESS_STOP || executionName === OP.PROCESS_READ || executionName === OP.PROCESS_LIST || backgroundStatusMode
          ? ''
          : workspaceOverride?.alias || effectiveArgs?.workspace,
        async () => {
          timeline.transition('admitted');
          timeline.transition('preparing');
          const watchdog = createMutationWatchdog(
            queueScope,
            executionName,
            effectiveArgs,
            combineAbortSignals(requestSignal, getCurrentTaskAbortSignal()),
            workspace?.alias,
            hasAgentCancellationHandle(effectiveArgs, { taskId })
          );
          try {
            if (workspace && !directFilesystem && isMutationScope(queueScope)) {
              assertNoRecoveredMutationProcess(config, workspace.alias);
              recoverStructuredPatchTransaction(config, workspace);
            }
            if (taskId && workspace && !directFilesystem && taskBaselineRequired(executionName, queueScope)) {
              try {
                const integrity = await ensureTaskBaseline(config, taskId, workspace.alias, {
                  signal: watchdog.signal,
                  onStatusOutput: statusOutput => { taskBaselineStatusOutput = statusOutput; }
                });
                if (requestTaskContext && integrity) requestTaskContext.integrity = integrity;
              } catch (error) {
                // A finite exec can be stopped while its first-use ownership baseline
                // is still being captured. Let the exec handler observe the aborted
                // signal so it returns the same structured cancelled result as a
                // command stopped after spawn, rather than leaking the abort reason
                // as an exceptional tool failure.
                if (!(executionName === OP.EXEC && watchdog.signal?.aborted)) throw error;
              }
            }
            sessionStart = await measurePerformancePhase(
              'tool.session',
              () => maybeStartSession(config, executionName, effectiveArgs || {}, { taskId })
            );
            const handled = await (workspace && !directFilesystem && isMutationScope(queueScope)
              ? runWithMutationProcessOwnership(config, workspace.alias, () => invokeHandler(effectiveArgs, watchdog.signal))
              : invokeHandler(effectiveArgs, watchdog.signal));
            if (workspace && isMutationScope(queueScope) && hasUnconfirmedTermination(handled)) {
              blockWorkspaceMutations(workspace.alias, 'A mutating subprocess was cancelled or timed out, but Rel.AI could not confirm that its process tree exited.');
            }
            setSpanAttributes({
              'relai.tool.ok': handled?.ok !== false,
              'relai.tool.long_running': definition?.behavior?.longRunning === true,
              ...performanceTimingAttributes()
            });
            return handled;
          } finally {
            watchdog.dispose();
          }
        },
        queueOptions(
          queueMode,
          queueScope,
          queueTaskId,
          operationSignal,
          deadlineAtMs > 0
            ? Math.max(1, deadlineAtMs - Date.now())
            : context?.backgroundFallbackExecution === true
              ? positiveMilliseconds(process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS, DEFAULT_FOREGROUND_WORKSPACE_QUEUE_TIMEOUT_MS)
              : executionName === OP.WORK_FINISH
                ? WORK_FINISH_QUEUE_TIMEOUT_MS
                : queueMode === 'write' && isMutationScope(queueScope)
                  ? positiveMilliseconds(process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS, DEFAULT_FOREGROUND_WORKSPACE_QUEUE_TIMEOUT_MS)
                  : 0,
          {
            taskId,
            operationId: String(finishActivity?.operationId || ''),
            principalFingerprint: queuePrincipalFingerprint,
            operation: String(finishActivity?.operation || executionName),
            startedAt: new Date().toISOString()
          },
          timeline,
          executionName === OP.EXEC || executionName === OP.EDIT
        )
      );

      return result;
    }, { carrier: context?.requestHeaders || {} }
  )).catch(error => {
    if (timeline && error && typeof error === 'object') {
      error.timeline = timeline.finish({ errorCode: error.code });
      error.executed = error.timeline.executed;
      error.deadlineKind = error.timeline.deadlineKind;
      error.terminationCertainty = error.terminationCertainty || error.timeline.terminationCertainty;
    }
    throw error;
  });
  return { value: value && typeof value === 'object' && !Array.isArray(value) ? { ...value, timeline: timeline?.snapshot() } : value, sessionStart, timeline };
}

function isMutationScope(scope) {
  return scope === 'mutation' || scope === 'workspace';
}

function assertNoRecoveredMutationProcess(config, workspace) {
  for (const record of listMutationProcessRecords(config, workspace)) {
    if (record.invalid === true) {
      const error = new Error(`Workspace '${workspace}' has invalid recovered mutation ownership state. Remove the invalid state only after confirming no stale mutating process is running.`);
      error.code = 'WORKSPACE_MUTATION_RECOVERY_STATE_INVALID';
      error.retryable = false;
      throw error;
    }
    if (record.terminationUncertain === true) {
      const error = new Error(`Workspace '${workspace}' retains unconfirmed process-tree termination for PID ${record.pid}. Restart or root-PID disappearance cannot clear this uncertainty. An operator must verify that relevant descendants have stopped before using the existing recovery-record cleanup procedure.`);
      error.code = 'WORKSPACE_MUTATION_TERMINATION_UNCERTAIN';
      error.retryable = false;
      error.pid = record.pid;
      error.executed = false;
      error.terminationCertainty = 'unconfirmed';
      throw error;
    }
    if (isProcessTreeAlive(record.pid)) {
      const error = new Error(`Workspace '${workspace}' still has a mutating process from a previous or interrupted operation (PID ${record.pid}). Wait for it to exit or stop it before starting another mutation.`);
      error.code = 'WORKSPACE_MUTATION_RECOVERY_PENDING';
      error.retryable = true;
      error.pid = record.pid;
      throw error;
    }
    removeMutationProcessRecord(record);
  }
}

function mutationWatchdogTimeoutMs(executionName, args = {}, scope = '', agentControlled = false) {
  if (!isMutationScope(scope)) return 0;
  const requested = Number(args?.timeoutMs);
  if (Number.isFinite(requested) && requested > 0) {
    const explicitDeadline = Math.floor(requested) + MUTATION_WATCHDOG_TERMINATION_GRACE_MS;
    if (agentControlled) return explicitDeadline;
    const configured = positiveMilliseconds(process.env.REL_AI_MCP_MUTATION_WATCHDOG_MS, DEFAULT_MUTATION_WATCHDOG_MS);
    return Math.max(configured, explicitDeadline);
  }
  if (agentControlled) return 0;
  return positiveMilliseconds(process.env.REL_AI_MCP_MUTATION_WATCHDOG_MS, DEFAULT_MUTATION_WATCHDOG_MS);
}

function createMutationWatchdog(scope, executionName, args, callerSignal, workspaceAlias = '', agentControlled = false) {
  if (!isMutationScope(scope)) return { signal: callerSignal, dispose() {} };
  const timeoutMs = mutationWatchdogTimeoutMs(executionName, args, scope, agentControlled);
  const controller = new AbortController();
  const signal = combineAbortSignals(callerSignal, controller.signal);
  let quarantineTimer = null;
  let timer = null;

  const scheduleQuarantine = () => {
    // relai_exec keeps the mutation lane until process cleanup settles, and its
    // durable process ownership plus terminationConfirmed result decide whether
    // the workspace must be quarantined. Cleanup latency alone is not evidence
    // that an exec subprocess is still mutating the workspace.
    if (executionName === OP.EXEC || !workspaceAlias || quarantineTimer) return;
    const reason = signal?.reason instanceof Error && signal.reason.message
      ? signal.reason.message
      : 'Mutation cancellation was requested.';
    quarantineTimer = setTimeout(() => {
      blockWorkspaceMutations(workspaceAlias, `${reason} The mutating operation did not settle within ${MUTATION_WATCHDOG_TERMINATION_GRACE_MS}ms after cancellation.`);
    }, MUTATION_WATCHDOG_TERMINATION_GRACE_MS);
  };
  const onAbort = () => scheduleQuarantine();
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      const error = new Error(`Workspace mutation execution exceeded ${timeoutMs}ms and was cancelled before the mutation lock could be released.`);
      error.code = 'WORKSPACE_MUTATION_TIMEOUT';
      controller.abort(error);
    }, timeoutMs);
  }
  return {
    signal,
    dispose() {
      if (timer) clearTimeout(timer);
      if (quarantineTimer) clearTimeout(quarantineTimer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  };
}

function hasUnconfirmedTermination(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return false;
  if (value.terminationConfirmed === false && (value.cancelled === true || value.timedOut === true)) return true;
  if (Array.isArray(value)) return value.slice(0, 100).some(item => hasUnconfirmedTermination(item, depth + 1));
  for (const item of Object.values(value)) {
    if (hasUnconfirmedTermination(item, depth + 1)) return true;
  }
  return false;
}

function positiveMilliseconds(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.floor(numeric)) : fallback;
}

function queueModeFor(executionName, definition, readOnlyExec) {
  if (definition?.annotations?.readOnlyHint === true || readOnlyExec) return 'read';
  if (executionName === OP.VALIDATE_CHECKS || executionName === OP.VALIDATE_DIAGNOSTICS) return 'read';
  return 'write';
}

function taskBaselineRequired(executionName, queueScope) {
  return isMutationScope(queueScope) || executionName === OP.VALIDATE_CHECKS;
}

function queueScopeFor(executionName, definition, branchChange, readOnlyExec) {
  if (branchChange) return 'workspace';
  if (executionName === OP.EXEC) return readOnlyExec ? 'task' : 'mutation';
  const scope = String(definition?.behavior?.concurrencyScope || 'task');
  return scope === 'workspace' || scope === 'mutation' ? scope : 'task';
}

function gitSubcommandIndex(argv = []) {
  const tokens = argv.map(value => String(value || ''));
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'].includes(lower)) {
      index += 1;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|super-prefix|config-env)=/i.test(token)) continue;
    if (token.startsWith('-')) continue;
    return index;
  }
  return -1;
}

function isExplicitBranchChange(executionName, args = {}) {
  if (executionName !== OP.EXEC) return false;
  const executable = path.basename(String(args.executable || '')).toLowerCase();
  if (executable === 'git' || executable === 'git.exe') {
    const argv = Array.isArray(args.argv) ? args.argv.map(value => String(value || '')) : [];
    const commandIndex = gitSubcommandIndex(argv);
    const command = commandIndex >= 0 ? argv[commandIndex].toLowerCase() : '';
    if (new Set(['switch', 'reset', 'merge', 'rebase']).has(command)) return true;
    if (command !== 'checkout') return false;
    const tail = argv.slice(commandIndex + 1);
    if (tail.includes('--')) return false;
    if (tail.some(value => ['-b', '-B', '--detach', '--orphan'].includes(value))) return true;
    return tail.filter(value => value && !value.startsWith('-')).length === 1;
  }
  const command = String(args.command || '');
  if (/\bgit(?:\.exe)?\b[^\r\n;&|]*\b(?:switch|reset|merge|rebase)\b/i.test(command)) return true;
  return /\bgit(?:\.exe)?\b[^\r\n;&|]*\bcheckout\b(?![^\r\n;&|]*\s--(?:\s|$))/i.test(command);
}

function detachedQueueTaskId(context = {}, queueScope = '') {


  if (context?.backgroundFallbackExecution !== true && queueScope !== 'mutation') return '';
  return String(context?.requestId || '').trim();
}

function queueOptions(mode, scope, taskId, signal, queueTimeoutMs = 0, owner = null, timeline = null, bypassTaskLane = false) {
  return {
    mode,
    scope,
    taskId,
    ...(bypassTaskLane ? { bypassTaskLane: true } : {}),
    ...(owner ? { owner } : {}),
    ...(signal ? { signal } : {}),
    ...(queueTimeoutMs > 0 ? { queueTimeoutMs } : {}),
    onQueueState: details => timeline?.transition('queued', {
      queuePosition: details.queuePosition,
      blocking: details.blocking
    }),
    onWait: (waitMs, details) => {
      timeline?.transition('admitted', { queueWaitMs: waitMs });
      addSpanEvent('workspace.queue.admitted', {
        'relai.workspace': details.workspace,
        'relai.queue.mode': details.mode,
        'relai.queue.scope': details.scope,
        'relai.queue.wait_ms': waitMs,
        'relai.queue.pending': details.queued
      });
      recordPerformancePhase('tool.queue', waitMs);
      if (waitMs > 0) {
        updateCurrentToolActivity({
          currentStage: 'Workspace queue admitted',
          currentActivity: `Waited ${formatWait(waitMs)} for the workspace execution queue.`,
          metadata: { waitMs, queueMode: details.mode, queueScope: details.scope, queued: details.queued }
        });
      }
    }
  };
}

function spanAttributes(name, args, context, workId = '') {
  return {
    'relai.tool.name': name,
    'relai.workspace': String(args?.workspace || ''),
    'relai.work.id': String(workId || ''),
    'relai.transport': String(context?.transportType || ''),
    'relai.client.name': String(context?.clientName || ''),
    'relai.client.version': String(context?.clientVersion || '')
  };
}

function formatWait(waitMs) {
  return waitMs < 1000 ? `${Math.max(0, Math.round(waitMs))} ms` : `${(waitMs / 1000).toFixed(1)} seconds`;
}

export { assertNoRecoveredMutationProcess, executeToolCall, isClearlyReadOnlyExec, isExplicitBranchChange, queueModeFor, taskBaselineRequired };
