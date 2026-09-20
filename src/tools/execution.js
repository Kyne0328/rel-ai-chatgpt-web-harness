import * as path from 'node:path';

import { combineAbortSignals } from '../abortSignals.ts';
import { hasAgentCancellationHandle, isClearlyWorkspaceReadOnlyAdb } from '../executionControl.js';
import { resolveWorkspace } from '../config.js';
import { fallbackExecutionStatus } from '../mcp/fallbackExecutions.js';
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

const UNSAFE_READ_ONLY_GIT_OPTIONS = new Set([
  '--ext-diff', '--textconv', '--filters', '--open-files-in-pager'
]);
const BACKGROUND_WORKSPACE_QUEUE_TIMEOUT_MS = 10_000;
const DEFAULT_FOREGROUND_WORKSPACE_QUEUE_TIMEOUT_MS = 30_000;
const WORK_FINISH_QUEUE_TIMEOUT_MS = 2_000;
const DEFAULT_MUTATION_WATCHDOG_MS = 5 * 60_000;
const MUTATION_WATCHDOG_TERMINATION_GRACE_MS = 15_000;

async function executeToolCall({ config, name, executionName = name, effectiveArgs, context, requestTaskContext = null, finishActivity, definition }) {
  let sessionStart = { started: false, alias: '' };
  const value = await runWithToolActivity(finishActivity, () => runSpan(config,
    executionName === OP.WORK_BEGIN ? 'relai.logical_task.start' : 'relai.tool.call',
    spanAttributes(name, effectiveArgs, context),
    async () => {
      const taskId = String(finishActivity?.taskId || effectiveArgs?.work_id || '').trim();
      const backgroundReference = String(effectiveArgs?.operationId || taskId || '').trim();
      const backgroundStatusMode = executionName === OP.WORK_STATUS
        && Boolean(backgroundReference)
        && fallbackExecutionStatus(backgroundReference, { config })?.status === 'running';
      const workspace = effectiveArgs?.workspace ? resolveWorkspace(config, effectiveArgs.workspace) : null;
      const branchChange = isExplicitBranchChange(executionName, effectiveArgs);
      const readOnlyExec = executionName === OP.EXEC && isClearlyReadOnlyExec(effectiveArgs);
      const queueMode = queueModeFor(executionName, definition, readOnlyExec);
      const queueScope = queueScopeFor(executionName, definition, branchChange, readOnlyExec);
      const queueTaskId = taskId || detachedQueueTaskId(context, queueScope);

      const invokeHandler = async (args, signal = context?.signal) => {
        if (typeof definition?.handler !== 'function') throw new Error(`Tool '${name}' has no executable handler.`);
        const handled = await measurePerformancePhase('tool.execution', () => definition.handler(config, args || {}, {
          connector: Boolean(context?.publicHttpOnly),
          taskId,
          requestHeaders: context?.requestHeaders || {},
          mcp: context?.mcp || {},
          conversationId: context?.conversationId,
          transportSessionId: context?.transportSessionId,
          signal,
          principal: context?.principal,
          nativeTaskId: context?.nativeTaskId,
          transportType: context?.transportType,
          executionMode: context?.executionMode || '',
          cancel: context?.cancel || null,
          requestTaskContext,
          backgroundStatusMode,
          mutationTrackingRequired: executionName !== OP.EXEC || !readOnlyExec
        }));
        if (workspace
          && taskId
          && effectiveArgs?.dryRun !== true
          && (executionName === OP.EDIT || executionName === OP.EXEC)
          && Array.isArray(handled?.changedFiles)
          && handled.changedFiles.length) {
          claimTaskChangedFiles(config, taskId, workspace.alias, handled.changedFiles);
        }
        if (handled && typeof handled === 'object' && !Array.isArray(handled) && handled.ok === false && handled.error?.code === 'CANCELLED') {
          context?.cancel?.throwIfCancelled?.();
        }
        return handled;
      };

      if (executionName === OP.WORK_FINISH) finishActivity?.assertCompletionAvailable?.();
      const operationSignal = combineAbortSignals(context?.signal, finishActivity?.signal);
      const result = await runWorkspaceOperation(
        executionName === OP.WORK_BEGIN || executionName === OP.WORK_STOP || executionName === OP.WORK_CANCEL || backgroundStatusMode ? '' : effectiveArgs?.workspace,
        async () => {
          const watchdog = createMutationWatchdog(
            queueScope,
            executionName,
            effectiveArgs,
            combineAbortSignals(context?.signal, getCurrentTaskAbortSignal()),
            workspace?.alias,
            hasAgentCancellationHandle(effectiveArgs, { taskId, nativeTaskId: context?.nativeTaskId })
          );
          try {
            if (workspace && isMutationScope(queueScope)) {
              assertNoRecoveredMutationProcess(config, workspace.alias);
              recoverStructuredPatchTransaction(config, workspace);
            }
            if (taskId && workspace && taskBaselineRequired(executionName, queueScope)) {
              try {
                const integrity = await ensureTaskBaseline(config, taskId, workspace.alias, { signal: watchdog.signal });
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
            const handled = await (workspace && isMutationScope(queueScope)
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
          context?.backgroundFallbackExecution === true
            ? BACKGROUND_WORKSPACE_QUEUE_TIMEOUT_MS
            : executionName === OP.WORK_FINISH
              ? WORK_FINISH_QUEUE_TIMEOUT_MS
              : queueMode === 'write' && isMutationScope(queueScope)
                ? positiveMilliseconds(process.env.REL_AI_MCP_WORKSPACE_QUEUE_TIMEOUT_MS, DEFAULT_FOREGROUND_WORKSPACE_QUEUE_TIMEOUT_MS)
                : 0,
          {
            taskId,
            operationId: String(finishActivity?.operationId || ''),
            operation: String(finishActivity?.operation || executionName),
            startedAt: new Date().toISOString()
          }
        )
      );

      return result;
    }, { carrier: context?.requestHeaders || {} }
  ));
  return { value, sessionStart };
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
    if (!workspaceAlias || quarantineTimer) return;
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

function isClearlyReadOnlyExec(args = {}) {
  if (String(args.command || '').trim()) return false;
  if (String(args.input || '').length > 0) return false;
  if (args.env && typeof args.env === 'object' && Object.keys(args.env).length > 0) return false;
  const executable = path.basename(String(args.executable || '')).toLowerCase();
  const argv = Array.isArray(args.argv) ? args.argv.map(value => String(value || '')) : [];
  if (!argv.length) return false;
  if (isClearlyWorkspaceReadOnlyAdb(args.executable, argv)) return true;
  if (executable === 'node' || executable === 'node.exe') {
    const first = argv[0].toLowerCase();
    if (['--version', '-v', '--help', '-h'].includes(first)) return argv.length === 1;
    return ['--check', '-c'].includes(first) && argv.length === 2 && !argv[1].startsWith('-');
  }
  if (executable !== 'git' && executable !== 'git.exe') return false;
  if (argv[0].startsWith('-')) return false;
  const optionTokens = argv.slice(1).map(value => value.toLowerCase());
  if (optionTokens.some(value => UNSAFE_READ_ONLY_GIT_OPTIONS.has(value)
    || value === '--output'
    || value.startsWith('--output='))) return false;
  const command = argv[0].toLowerCase();
  if (new Set([
    'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree',
    'cat-file', 'grep', 'blame', 'shortlog', 'describe', 'merge-base', 'name-rev'
  ]).has(command)) return true;
  if (command === 'branch') {
    return optionTokens.length === 0 || optionTokens.every(value => ['--show-current', '--list', '-a', '-r'].includes(value));
  }
  if (command === 'worktree') return argv.length === 2 && argv[1]?.toLowerCase() === 'list';
  if (command === 'remote') return argv.length === 1 || optionTokens.every(value => value === '-v' || value === '--verbose');
  if (command === 'config') {
    const mode = String(argv[1] || '').toLowerCase();
    if (!['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(mode)) return false;
    return argv.slice(2).every(value => !String(value).startsWith('-'));
  }
  return false;
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
  const nativeTaskId = String(context?.nativeTaskId || '').trim();
  if (nativeTaskId) return nativeTaskId;
  if (context?.backgroundFallbackExecution !== true && queueScope !== 'mutation') return '';
  return String(context?.requestId || '').trim();
}

function queueOptions(mode, scope, taskId, signal, queueTimeoutMs = 0, owner = null) {
  return {
    mode,
    scope,
    taskId,
    ...(owner ? { owner } : {}),
    ...(signal ? { signal } : {}),
    ...(queueTimeoutMs > 0 ? { queueTimeoutMs } : {}),
    onWait: (waitMs, details) => {
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

function spanAttributes(name, args, context) {
  return {
    'relai.tool.name': name,
    'relai.workspace': String(args?.workspace || ''),
    'relai.transport': String(context?.transportType || ''),
    'relai.client.name': String(context?.clientName || ''),
    'relai.client.version': String(context?.clientVersion || '')
  };
}

function formatWait(waitMs) {
  return waitMs < 1000 ? `${Math.max(0, Math.round(waitMs))} ms` : `${(waitMs / 1000).toFixed(1)} seconds`;
}

export { assertNoRecoveredMutationProcess, executeToolCall, isClearlyReadOnlyExec, isExplicitBranchChange, queueModeFor, taskBaselineRequired };
