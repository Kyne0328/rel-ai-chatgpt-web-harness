import { safeLogAudit } from '../audit.js';
import { createValidationFingerprint } from '../bridge/validationPlan.js';
import { readConfig, resolveWorkspace, resolveWorkspaceInput } from '../config.js';
import { principalFingerprint, principalForContext } from '../mcp/principal.js';
import { assertAuthorizedToolCall, authorizedWorkspaceAliases } from '../mcp/authorizationPolicy.js';
import { clearSessionPolicy } from '../policyResolver.js';
import { readTaskIntegrity } from '../taskIntegrity.ts';
import { bindTaskHistoryActivityPersistence, recordWorkflowEvidence } from '../taskHistoryStore.ts';
import { buildToolActivityDetails } from '../taskObservability.js';
import { beginConnectorToolCall, normalizeTaskId, onToolActivity, taskError } from '../toolActivity.js';
import { serializeConnectorResult } from './connector.js';
import { enhanceToolError } from './errors.js';
import { executeToolCall } from './execution.js';
import { repositoryIntelligence } from '../repository/intelligence/service.js';
import { describeToolOperation } from './operation.js';
import { resolveExecutableToolCall, validateExecutableOperationInput } from './runtimeRegistry.js';
import { getToolNames, isToolCallable } from './schema.js';
import { applyCautionAudit, buildExtraAudit, invalidateSessionCacheForCall } from './session.js';
import { assertKnownTask, assertTaskWorkspaceOwnership, findReusableTask, taskAttributionHint, isTerminalTaskReference, taskAuditContext, withTaskIdentity } from './task.js';
import { deterministicActionId } from '../workflow/contracts.js';
import { classifyTaskIntent } from '../workflow/intent.js';
import { recordLocalTaskCompletion, recordLocalToolOutcome } from '../localAnalytics.js';
import { buildWorkflowEvidenceReceipt } from '../workflow/evidence.js';
import { invalidateRepositoryTopology } from '../workflow/topology.js';
import { OPERATION_IDS as OP } from './operationIds.js';
import { observeRepeatCall } from './repeatCallGuard.js';
import {
  measurePerformancePhaseSync,
  performanceBreakdownSnapshot,
  withPerformanceBreakdownIfAbsent
} from '../performanceObservability.js';

bindTaskHistoryActivityPersistence(onToolActivity, readConfig);

async function callTool(name, args = {}, context = {}) {
  return withPerformanceBreakdownIfAbsent(() => callToolObserved(name, args, context));
}

async function callToolObserved(name, args = {}, context = {}) {
  const config = readConfig();
  const started = Date.now();
  const connector = Boolean(context?.publicHttpOnly);
  const publicArgs = args || {};
  let requestedTaskId = '';
  let effectiveArgs = publicArgs;
  let operationName = String(name || '');
  let workspaceResolution, knownTask = null;
  let requestTaskContext = null;
  let finishActivity = null;
  let activityResult = { ok: true };
  let analyticsFailureCode = '';
  let sessionStart;
  let resolvedAction = '';
  let effectivePrincipal = null;
  let completedTaskAnalytics = null;
  try {
    if (!isToolCallable(name, config)) {
      throw new Error(`Unknown tool '${name}'. Available tools: ${getToolNames(config).join(', ')}. Removed direct operation names are not callable; restart or reconnect if discovery is stale.`);
    }
    const resolved = resolveExecutableToolCall(name, publicArgs, config);
    if (!resolved) throw new Error(`Unknown tool '${name}'.`);
    const definition = resolved.executionDefinition;
    operationName = resolved.operationName;
    resolvedAction = resolved.action || '';
    effectiveArgs = resolved.operationArgs;
    const taskScope = definition?.behavior?.taskScope || 'required';
    const taskScoped = taskScope === 'required';
    const taskAware = taskScoped || taskScope === 'optional';
    effectivePrincipal = principalForContext(context, connector);
    requestedTaskId = normalizeTaskId(effectiveArgs?.work_id);
    if (requestedTaskId && effectiveArgs?.independent === true) {
      throw taskError('TASK_SCOPE_CONFLICT', 'Choose work_id for task work or independent:true for separate workspace work, not both.');
    }
    if (taskScoped && !requestedTaskId) {
      throw taskError('TASK_ID_REQUIRED', `${name} requires the work_id returned by relai_work action begin.`);
    }
    if (requestedTaskId && operationName !== OP.WORK_BEGIN) {
      knownTask = assertKnownTask(config, requestedTaskId, '', operationName, effectivePrincipal, effectiveArgs);
      if (knownTask && taskAware && !String(effectiveArgs?.workspace || '').trim()) effectiveArgs = { ...effectiveArgs, workspace: knownTask.workspace };
    }
    assertAuthorizedToolCall({
      principal: effectivePrincipal,
      operationName,
      workspace: ''
    });
    const workspaceRequired = Array.isArray(definition?.inputSchema?.required)
      && definition.inputSchema.required.includes('workspace');
    workspaceResolution = resolveConfiguredWorkspaceArgument(config, effectiveArgs?.workspace, { required: workspaceRequired });
    if (workspaceResolution?.alias) effectiveArgs = { ...effectiveArgs, workspace: workspaceResolution.alias };
    const authorizedWorkspace = workspaceResolution?.alias || effectiveArgs?.workspace || knownTask?.workspace || '';
    if (authorizedWorkspace) {
      assertAuthorizedToolCall({
        principal: effectivePrincipal,
        operationName,
        workspace: authorizedWorkspace
      });
    }
    await validateExecutableOperationInput(operationName, effectiveArgs, {
      publicLabel: resolved.action ? `${name} action '${resolved.action}'` : name
    });
    if (operationName === OP.WORK_BEGIN) {
      const reusableTask = findReusableTask(
        config,
        effectiveArgs?.workspace,
        effectiveArgs,
        effectivePrincipal,
        context?.conversationId
      );
      if (reusableTask) {
        requestedTaskId = normalizeTaskId(reusableTask.id || reusableTask.taskId);
        knownTask = reusableTask;
      }
    }
    if (knownTask) {
      // The task record/principal/state was already validated above. Workspace
      // resolution cannot change that record, so validate ownership against the
      // resolved alias without re-reading task history a second time.
      assertTaskWorkspaceOwnership(knownTask, effectiveArgs?.workspace);
      const integrity = readTaskIntegrity(config, requestedTaskId, effectiveArgs?.workspace);
      const lifecycleWithoutIntegrity = operationName === OP.WORK_FINISH || operationName === OP.WORK_CANCEL;
      if (!integrity && !lifecycleWithoutIntegrity && (taskScoped || taskAttributionRequiresIntegrity(operationName))) {
        throw taskError(
          'TASK_INTEGRITY_STATE_MISSING',
          'Durable task attribution state is missing for this work_id. Omit work_id to run at workspace scope, or start a new durable work session.',
          { retryable: false }
        );
      }
      requestTaskContext = {
        taskId: requestedTaskId,
        session: knownTask,
        integrity: integrity || null,
        workflowContextEvidence: null,
        topology: null
      };
    }
    const attributionHint = taskScope === 'optional' && !requestedTaskId && effectiveArgs?.independent !== true
      ? taskAttributionHint(config, authorizedWorkspace, effectivePrincipal, context?.conversationId)
      : '';
    if (attributionHint && definition.annotations?.readOnlyHint !== true) {
      throw taskError('TASK_ATTRIBUTION_REQUIRED', attributionHint, { retryable: true, allowedAlternatives: [attributionHint] });
    }
    const repeatCall = observeRepeatCall({
      connector,
      taskId: requestedTaskId,
      operationName,
      args: effectiveArgs,
      mutationGeneration: requestTaskContext?.integrity?.mutationGeneration
    });
    const duplicateTerminalCancellation = operationName === OP.WORK_CANCEL && knownTask?.status === 'cancelled';
    const terminalTaskReference = isTerminalTaskReference(knownTask, operationName, effectiveArgs);
    const resumedStatusRead = operationName === OP.WORK_STATUS
      && knownTask?.status === 'inactive'
      && Boolean(context?.conversationId)
      && String(knownTask?.correlation?.conversationId || '') === String(context.conversationId);
    finishActivity = beginConnectorToolCall({
      tool: name,
      internalOperation: operationName,
      workspace: effectiveArgs?.workspace,
      scopeId: requestedTaskId ? `task:${requestedTaskId}` : (connector ? 'mcp:request' : 'local:default'),
      taskId: requestedTaskId,
      createTask: operationName === OP.WORK_BEGIN && !knownTask,
      trackTask: context?.trackTaskActivity !== false
        && (operationName !== OP.WORK_STATUS || resumedStatusRead)
        && !duplicateTerminalCancellation
        && (!terminalTaskReference || resumedStatusRead)
        && (operationName === OP.WORK_BEGIN || Boolean(requestedTaskId)),
      connector,
      operation: describeToolOperation(operationName, effectiveArgs || {}),
      title: effectiveArgs?.title,
      objective: effectiveArgs?.objective,
      contextSummary: effectiveArgs?.contextSummary,
      resumeTask: knownTask,
      correlation: {
        requestId: context?.requestId,
        traceId: context?.traceId,
        workspaceId: effectiveArgs?.workspace,
        conversationId: context?.conversationId
      },
      input: publicArgs,
      principalFingerprint: principalFingerprint(effectivePrincipal)
    });
    const execution = await executeToolCall({
      config, name, executionName: operationName, effectiveArgs, context, requestTaskContext, finishActivity, definition, started
    });
    const value = execution.value;
    sessionStart = execution.sessionStart;
    const valueOk = value?.ok !== false;
    if (!valueOk) analyticsFailureCode = analyticsErrorCodeFromValue(value);
    activityResult = { ok: valueOk, ...(valueOk ? {} : { error: String(value?.error || value?.message || `${name} returned ok:false`) }) };
    if (sessionStart.started && !hasWorkspaceChanges(value)) clearSessionPolicy(config, sessionStart.alias, finishActivity?.taskId);
    const extraAudit = {
      ...buildExtraAudit(operationName, value, effectiveArgs || {}),
      ...(repeatCall ? { repeatCallCount: repeatCall.count, repeatCallWarning: true } : {})
    };
    activityResult.activity = buildToolActivityDetails(operationName, effectiveArgs || {}, value, valueOk ? null : activityResult.error, {
      operation: finishActivity?.operation,
      phase: 'complete',
      metadata: { ...extraAudit, internalOperation: operationName, publicAction: resolved.action || undefined }
    });
    applyCautionAudit(extraAudit, operationName, effectiveArgs || {}, value, config);
    invalidateSessionCacheForCall(config, operationName, effectiveArgs || {});
    signalRepositoryIntelligenceMutation(config, operationName, effectiveArgs || {}, value);
    const workId = finishActivity?.taskId || requestedTaskId;
    const evidenceDraft = workId ? buildWorkflowEvidenceReceipt({
      tool: operationName,
      args: { ...(effectiveArgs || {}), action: resolved.action || effectiveArgs?.action },
      result: value || {},
      auditEntry: {},
      repositoryFingerprint: String(value?.validationFingerprint || ''),
      commandId: workflowCommandId(operationName, resolved.action, effectiveArgs)
    }) : null;
    const auditEntry = await safeLogAudit(config, {
      ...activityResult.activity,
      ...taskAuditContext(context, finishActivity, requestedTaskId, operationName, valueOk, value),
      tool: operationName,
      publicTool: name,
      ...(operationName === OP.WORK_BEGIN ? { deferBaseline: true } : {}),
      internalOperation: operationName === name ? undefined : operationName,
      action: resolved.action || undefined,
      operation: finishActivity?.operation,
      ok: valueOk,
      workspace: effectiveArgs?.workspace,
      ...(workspaceResolution?.source === 'configured_path' ? {
        workspaceInput: workspaceResolution.input,
        workspaceInputSource: 'configured_path',
        workspaceMatchStatus: 'matched_configured_path',
        workspaceResolvedAlias: workspaceResolution.alias
      } : {}),
      ms: Date.now() - started,
      ...extraAudit,
      ...(valueOk ? {} : { error: activityResult.error })
    }, { strictIntegrity: true });
    refreshRequestTaskIntegrity(requestTaskContext, auditEntry);
    if (workId && evidenceDraft && auditEntry) {
      await persistWorkflowEvidence(
        config,
        effectiveArgs,
        operationName,
        resolved.action,
        value || {},
        auditEntry,
        workId,
        evidenceDraft,
        { persist: true }
      );
    }
    if (
      valueOk
      && value?.completionKnown === true
      && value?.duplicate !== true
      && (operationName === OP.WORK_FINISH || operationName === OP.VALIDATE_CHECKS)
    ) {
      completedTaskAnalytics = {
        workspace: workspaceResolution?.alias || effectiveArgs?.workspace || knownTask?.workspace || '',
        taskIntent: knownTask?.intent || requestTaskContext?.session?.intent || 'auto'
      };
    }
    const responseValue = connector && resolved.compact
      ? measurePerformancePhaseSync('serialization', () => serializeConnectorResult({
        publicName: name,
        action: resolved.action,
        operationName,
        value,
        args: effectiveArgs || {},
        workId
      }))
      : withTaskIdentity(value, workId);
    const warning = [repeatCall?.warning, attributionHint].filter(Boolean).join(' ');
    const responseWithRepeatWarning = warning && responseValue && typeof responseValue === 'object'
      ? { ...responseValue, warning: [responseValue.warning, warning].filter(Boolean).join(' ') }
      : responseValue;
    return ok(responseWithRepeatWarning);
  } catch (error) {
    const enhanced = restrictWorkspaceRecoveryErrorAliases(
      enhanceToolError(operationName, error),
      effectivePrincipal,
      connector
    );
    analyticsFailureCode = String(enhanced.code || '');
    activityResult = {
      ok: false,
      error: enhanced.message,
      activity: buildToolActivityDetails(operationName, effectiveArgs || {}, null, enhanced, {
        operation: finishActivity?.operation,
        phase: 'complete',
        metadata: { errorCode: enhanced.code, retryable: enhanced.retryable === true, publicTool: name }
      })
    };
    const failedWorkId = finishActivity?.taskId || requestedTaskId;
    if (failedWorkId) enhanced.taskId = failedWorkId;
    const failedValue = { ok: false, errorCode: enhanced.code || '', commandSummary: effectiveArgs?.command || '' };
    const failedDraft = failedWorkId ? buildWorkflowEvidenceReceipt({
      tool: operationName,
      args: { ...(effectiveArgs || {}), action: resolvedAction || effectiveArgs?.action },
      result: failedValue,
      auditEntry: {},
      repositoryFingerprint: '',
      commandId: workflowCommandId(operationName, resolvedAction, effectiveArgs)
    }) : null;
    if (!/^TASK_INTEGRITY_/.test(String(enhanced.code || ''))) {
      const failedAuditEntry = await safeLogAudit(config, {
        ...activityResult.activity,
        ...taskAuditContext(context, finishActivity, requestedTaskId, operationName, false),
        tool: operationName,
        publicTool: name,
        internalOperation: operationName === name ? undefined : operationName,
        action: resolvedAction || undefined,
        operation: finishActivity?.operation,
        ok: false,
        workspace: effectiveArgs?.workspace,
        workspaceInput: publicArgs?.workspace == null ? '' : String(publicArgs.workspace),
        workspaceInputSource: 'tool_argument',
        workspaceMatchStatus: enhanced.workspaceMatchStatus || undefined,
        workspaceResolutionFailure: enhanced.workspaceResolutionFailure || undefined,
        configuredWorkspaceAliases: enhanced.configuredWorkspaceAliases || undefined,
        protocolVersion: context?.protocolVersion || undefined,
        clientName: context?.clientName || undefined,
        clientVersion: context?.clientVersion || undefined,
        ms: Date.now() - started,
        error: enhanced.message,
        errorCode: enhanced.code || undefined
      });
      if (failedWorkId && failedDraft && failedAuditEntry) {
        await persistWorkflowEvidence(config, effectiveArgs, operationName, resolvedAction, failedValue, failedAuditEntry, failedWorkId, failedDraft, { persist: true });
      }
    }
    throw enhanced;
  } finally {
    recordLocalToolOutcome(config, {
      tool: name,
      operationName,
      workspace: workspaceResolution?.alias || knownTask?.workspace || '',
      taskIntent: knownTask?.intent || (operationName === OP.WORK_BEGIN ? classifyTaskIntent(effectiveArgs?.objective) : 'untracked'),
      ok: activityResult.ok === true,
      durationMs: Date.now() - started,
      timings: performanceBreakdownSnapshot(),
      errorCode: analyticsFailureCode,
      errorMessage: activityResult.error || ''
    });
    finishActivity?.(activityResult);
    if (activityResult.ok === true && completedTaskAnalytics) {
      recordLocalTaskCompletion(config, completedTaskAnalytics);
    }
  }
}

function taskAttributionRequiresIntegrity(operationName) {
  return operationName === OP.EDIT || operationName === OP.EXEC;
}

function analyticsErrorCodeFromValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (typeof value.errorCode === 'string') return value.errorCode;
  if (typeof value.code === 'string') return value.code;
  if (value.error && typeof value.error === 'object' && typeof value.error.code === 'string') return value.error.code;
  return '';
}

async function persistWorkflowEvidence(config, args, operationName, action, value, auditEntry, workId, draft, options = {}) {
  try {
    const workspace = resolveWorkspace(config, args?.workspace);
    let repositoryFingerprint = String(value?.validationFingerprint || draft?.repositoryFingerprint || '');
    if (draft?.kind === 'check' && !repositoryFingerprint) {
      repositoryFingerprint = String((await createValidationFingerprint(workspace, config))?.fingerprint || '');
    }
    const receipt = buildWorkflowEvidenceReceipt({
      tool: operationName,
      args: { ...(args || {}), action: action || args?.action },
      result: value || {},
      auditEntry,
      repositoryFingerprint,
      commandId: workflowCommandId(operationName, action, args)
    });
    if (receipt && options.persist === true) recordWorkflowEvidence(config, workId, receipt, { defer: true });
    return receipt;
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] workflow evidence:', error);
    return null;
  }
}

function refreshRequestTaskIntegrity(requestState, auditEntry) {
  if (!requestState?.integrity || !auditEntry) return;
  const currentMutation = Number(requestState.integrity.mutationGeneration || 0);
  const currentValidated = Number(requestState.integrity.latestValidatedMutationGeneration || 0);
  const nextMutation = Number(auditEntry.taskMutationGeneration ?? currentMutation);
  const nextValidated = Number(auditEntry.taskValidatedMutationGeneration ?? currentValidated);
  if (nextMutation !== currentMutation || nextValidated !== currentValidated) requestState.integrity = null;
}

function workflowCommandId(operationName, action, args = {}) {
  return deterministicActionId({
    tool: operationName,
    action: action || args?.action || operationName,
    args: {
      command: args?.command || (args?.executable ? [args.executable, ...(Array.isArray(args?.argv) ? args.argv : [])].join(' ') : ''),
      check: args?.check || '',
      checks: Array.isArray(args?.checks) ? args.checks.slice(0, 10) : [],
      cwd: args?.cwd || '.'
    }
  });
}
function resolveConfiguredWorkspaceArgument(config, input, options = {}) {
  if (input == null || String(input).trim() === '') {
    if (options.required === true) resolveWorkspace(config, input);
    return null;
  }
  const resolution = resolveWorkspaceInput(config, input);
  if (resolution.source === 'configured_path') return resolution;
  if (resolution.source === 'path_unavailable' || resolution.source === 'unmatched_path') resolveWorkspace(config, input);
  if (options.required === true && resolution.source === 'unmatched_alias') resolveWorkspace(config, input);
  return resolution;
}

function restrictWorkspaceRecoveryErrorAliases(error, principal, connector) {
  if (!error || typeof error !== 'object' || !Array.isArray(error.configuredWorkspaceAliases)) return error;
  const aliases = connector
    ? authorizedWorkspaceAliases(principal, error.configuredWorkspaceAliases)
    : [...error.configuredWorkspaceAliases];
  error.configuredWorkspaceAliases = aliases;
  error.workspaceAliases = aliases;
  error.workspaceCount = aliases.length;
  error.allowedAlternatives = aliases.length
    ? [`Use one authorized workspace alias: ${aliases.join(', ')}.`]
    : ['No authorized workspace alias is available for this client.'];
  return error;
}

function signalRepositoryIntelligenceMutation(config, operationName, args, value) {
  const alias = String(args?.workspace || value?.workspace || '').trim();
  if (!alias || args?.dryRun === true) return;
  const changedFiles = Array.isArray(value?.changedFiles)
    ? [...new Set(value.changedFiles.map(item => String(item || '').trim().replaceAll('\\', '/')).filter(Boolean))]
    : [];
  const broadMutation = operationName === OP.CHANGES_RESET && value?.ok !== false;
  const targetedMutation = changedFiles.length > 0
    && [OP.EDIT, OP.EXEC, OP.CHANGES_TIDY_RUN].includes(operationName);
  const restoreMutation = operationName === OP.CHANGES_RESTORE && value?.ok !== false
    ? [...new Set((Array.isArray(args?.paths) ? args.paths : []).map(item => String(item || '').trim().replaceAll('\\', '/')).filter(Boolean))]
    : [];
  if (!broadMutation && !targetedMutation && !restoreMutation.length) return;
  try {
    const workspace = resolveWorkspace(config, alias);
    const mutationPaths = broadMutation ? [] : (changedFiles.length ? changedFiles : restoreMutation);
    repositoryIntelligence.noteMutation(workspace, config, mutationPaths);
    invalidateRepositoryTopology(workspace.path, mutationPaths);
  } catch {}
}

function hasWorkspaceChanges(value) {
  return Boolean(value && typeof value === 'object' && (value.changed === true
    || (Array.isArray(value.changedFiles) && value.changedFiles.length > 0)
    || (Array.isArray(value.statusAfter?.sessionChangedFiles) && value.statusAfter.sessionChangedFiles.length > 0)));
}

function ok(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'ok') ? value : { ok: true, ...value };
}

export { callTool };
