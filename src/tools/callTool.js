import * as fs from 'node:fs';
import * as path from 'node:path';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { toolArgumentError } from './validationGuidance.js';
import { recordTransportTiming } from '../transportTiming.ts';

import { safeLogAudit } from '../audit.js';
import { createValidationFingerprint } from '../bridge/validationPlan.js';
import { readConfig, resolveWorkspace, resolveWorkspaceInput } from '../config.js';
import { principalFingerprint, principalForContext, principalKind } from '../mcp/principal.ts';
import { PRINCIPAL_KIND } from '../mcp/contracts.ts';
import { assertAuthorizedToolCall, authorizedWorkspaceAliases } from '../mcp/authorizationPolicy.ts';
import { clearSessionPolicy } from '../policyResolver.js';
import { readTaskIntegrity, recordTaskIntegrityEvent } from '../taskIntegrity.ts';
import { bindTaskHistoryActivityPersistence, recordWorkflowEvidence } from '../taskHistoryStore.ts';
import { buildToolActivityDetails } from '../taskObservability.js';
import { beginConnectorToolCall, getToolActivity, normalizeTaskId, onToolActivity, taskError } from '../toolActivity.js';
import { serializeConnectorResult } from './connector.js';
import { enhanceToolError } from './errors.js';
import { executeToolCall } from './execution.js';
import { repositoryIntelligence } from '../repository/intelligence/service.js';
import { describeToolOperation } from './operation.js';
import { resolveExecutableToolCall, validateExecutableOperationInput } from './runtimeRegistry.js';
import { getToolNames, getToolSchemas, isToolCallable } from './schema.js';
import { applyCautionAudit, buildExtraAudit, invalidateSessionCacheForCall } from './session.js';
import { assertKnownTask, assertTaskWorkspaceOwnership, findReusableTask, taskAttributionHint, isTerminalTaskReference, taskAuditContext, withTaskIdentity } from './task.js';
import { deterministicActionId } from '../workflow/contracts.js';
import { classifyTaskIntent } from '../workflow/intent.js';
import { scheduleLocalTaskCompletion, scheduleLocalToolOutcome } from '../localAnalytics.js';
import { buildWorkflowEvidenceReceipt } from '../workflow/evidence.js';
import { invalidateRepositoryTopology } from '../workflow/topology.js';
import { OPERATION_IDS as OP } from './operationIds.js';
import { observeRepeatCall } from './repeatCallGuard.js';
import { applyTaskProgressPatch } from './taskProgress.js';
import { classifySensitivePath, resolveSafePath } from '../safety.js';
import {
  measurePerformancePhaseSync,
  performanceBreakdownSnapshot,
  withPerformanceBreakdownIfAbsent
} from '../performanceObservability.js';

bindTaskHistoryActivityPersistence(onToolActivity, readConfig);

// Validate the complete executable public grammar after safe scope recovery.
// Discovery remains an ergonomic projection, never an execution validator.
const PUBLIC_INPUT_VALIDATORS = new Map(getToolSchemas().map(definition => [
  definition.name, { schema: definition.inputSchema, validator: fromJsonSchema(definition.inputSchema)['~standard'] }
]));

async function callTool(name, args = {}, context = {}) {
  recordTransportTiming('call_tool_entry');
  try {
    const result = await withPerformanceBreakdownIfAbsent(() => callToolObserved(name, args, context));
    recordTransportTiming('call_tool_return');
    return result;
  } catch (error) {
    recordTransportTiming('call_tool_error');
    throw error;
  }
}

async function callToolObserved(name, args = {}, context = {}) {
  const config = readConfig();
  const started = Date.now();
  const inheritedDeadlineAtMs = Number(context?.deadlineAtMs);
  const requestedTimeoutMs = Number(args?.timeoutMs);
  const explicitDeadlineAtMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? started + Math.floor(requestedTimeoutMs) : 0;
  const requestDeadlineAtMs = Number.isFinite(inheritedDeadlineAtMs) && inheritedDeadlineAtMs > 0
    ? (explicitDeadlineAtMs > 0 ? Math.min(explicitDeadlineAtMs, inheritedDeadlineAtMs) : inheritedDeadlineAtMs)
    : explicitDeadlineAtMs;
  if (requestDeadlineAtMs > 0) context = { ...context, deadlineAtMs: requestDeadlineAtMs };
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
  let taskProgressPatch = null;
  let workspaceOverride = null;
  let handlerResultKnown = false;
  let handlerResult;
  let operationTimeline;
  let compactResponse = false;
  let taskOwnerVerified = false;
  let verifiedTaskSession = null;
  let workspaceScopeVerified = false;
  try {
    if (!isToolCallable(name, config)) {
      throw new Error(`Unknown tool '${name}'. Available tools: ${getToolNames(config).join(', ')}. Removed direct operation names are not callable; restart or reconnect if discovery is stale.`);
    }
    const resolved = resolveExecutableToolCall(name, publicArgs, config);
    if (!resolved) throw new Error(`Unknown tool '${name}'.`);
    const definition = resolved.executionDefinition;
    compactResponse = connector && resolved.compact;
    operationName = resolved.operationName;
    resolvedAction = resolved.action || '';
    effectiveArgs = resolved.operationArgs;
    const optionalIntegrity = taskBookkeepingOptionalFor(operationName, effectiveArgs, definition);
    if (effectiveArgs?.taskProgress !== undefined) {
      taskProgressPatch = effectiveArgs.taskProgress;
      effectiveArgs = { ...effectiveArgs };
      delete effectiveArgs.taskProgress;
    }
    const taskScope = definition?.behavior?.taskScope || 'required';
    const taskScoped = taskScope === 'required';
    const taskAware = taskScoped || taskScope === 'optional';
    effectivePrincipal = principalForContext(context, connector);
    const trustedLocalTaskControl = context?.trustedLocalTaskControl === true
      && !connector
      && principalKind(effectivePrincipal) === PRINCIPAL_KIND.LOCAL_TRUSTED
      && (operationName === OP.WORK_CANCEL || operationName === OP.WORK_STOP);
    requestedTaskId = normalizeTaskId(effectiveArgs?.work_id);
    if (requestedTaskId && effectiveArgs?.independent === true) {
      throw taskError(
        'TASK_SCOPE_CONFLICT',
        `Conflicting scope parameters: both work_id "${requestedTaskId}" (task scope) and independent: true (separate workspace scope) were provided. Choose one: to attach this call to task "${requestedTaskId}", omit "independent". To run separate workspace work outside the task, omit "work_id".`,
        {
          retryable: true,
          allowedAlternatives: [
            `Remove independent: true to continue work within task "${requestedTaskId}"`,
            'Remove work_id to run independently at workspace scope'
          ]
        }
      );
    }
    if (taskProgressPatch && !requestedTaskId) {
      throw taskError('TASK_ID_REQUIRED', 'taskProgress requires the exact work_id of the durable task whose checklist should be updated.');
    }
    if (taskScoped && !requestedTaskId) {
      throw taskError('TASK_ID_REQUIRED', `${name} requires the work_id returned by relai_work action begin.`);
    }
    if (requestedTaskId && operationName !== OP.WORK_BEGIN) {
      knownTask = await assertKnownTask(config, requestedTaskId, '', operationName, effectivePrincipal, effectiveArgs, {
        trustedLocalTaskControl, signal: context.signal, deadlineAtMs: context.deadlineAtMs,
        onOwnerVerified: session => { taskOwnerVerified = true; verifiedTaskSession = session; }
      }).catch(error => { throw taskAdmissionReadError(error, context); });
      taskOwnerVerified = Boolean(knownTask);
      if (knownTask && taskAware && !String(effectiveArgs?.workspace || '').trim()) effectiveArgs = { ...effectiveArgs, workspace: knownTask.workspace };
    }
    assertAuthorizedToolCall({
      principal: effectivePrincipal,
      operationName,
      workspace: ''
    });
    const directFilesystem = resolveDirectFilesystemCall(config, effectiveArgs, operationName);
    if (directFilesystem) {
      effectiveArgs = directFilesystem.args;
      workspaceOverride = directFilesystem.workspace;
    }
    const workspaceRequired = Array.isArray(definition?.inputSchema?.required)
      && definition.inputSchema.required.includes('workspace');
    workspaceResolution = workspaceOverride
      ? null
      : resolveConfiguredWorkspaceArgument(config, effectiveArgs?.workspace, { required: workspaceRequired });
    if (workspaceResolution?.alias) effectiveArgs = { ...effectiveArgs, workspace: workspaceResolution.alias };
    const authorizedWorkspace = workspaceOverride
      ? ''
      : workspaceResolution?.alias || effectiveArgs?.workspace || knownTask?.workspace || '';
    if (authorizedWorkspace) {
      assertAuthorizedToolCall({
        principal: effectivePrincipal,
        operationName,
        workspace: authorizedWorkspace
      });
    }
    await validateExecutableOperationInput(operationName, workspaceOverride
      ? { ...effectiveArgs, workspace: workspaceOverride.alias }
      : effectiveArgs, {
      publicLabel: resolved.action ? `${name} action '${resolved.action}'` : name
    });
    await validateCompletePublicInput(name, {
      ...effectiveArgs,
      ...(workspaceOverride ? { workspace: workspaceOverride.alias } : {}),
      ...(resolved.action ? { action: resolved.action } : {}),
      ...(publicArgs?.taskProgress !== undefined ? { taskProgress: publicArgs.taskProgress } : {})
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
        taskOwnerVerified = true;
      }
    }
    if (knownTask) {
      // The task record/principal/state was already validated above. Workspace
      // resolution cannot change that record, so validate ownership against the
      // resolved alias without re-reading task history a second time.
      assertTaskWorkspaceOwnership(knownTask, effectiveArgs?.workspace);
      workspaceScopeVerified = true;
      let integrity = readOptionalTaskIntegrity(config, requestedTaskId, effectiveArgs?.workspace, optionalIntegrity);
      const requestedWorkspace = String(effectiveArgs?.workspace || '').trim();
      const projectlessTask = !String(knownTask?.workspace || '').trim();
      if (!integrity && projectlessTask && requestedWorkspace && taskOperationBindsProject(operationName)) {
        try {
          await recordTaskIntegrityEvent(config, {
            taskId: requestedTaskId,
            taskIdentityVersion: 2,
            taskIdExplicit: true,
            taskHistoryEligible: false,
            tool: OP.WORK_BEGIN,
            workspace: requestedWorkspace,
            deferBaseline: true
          });
          integrity = readOptionalTaskIntegrity(config, requestedTaskId, requestedWorkspace, optionalIntegrity);
        } catch (error) {
          if (!optionalIntegrity || !/^TASK_INTEGRITY_/.test(String(error?.code || ''))) throw error;
        }
      }
      const lifecycleWithoutIntegrity = optionalIntegrity || taskLifecycleCanRunWithoutIntegrity(operationName) || Boolean(workspaceOverride);
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
      if (projectlessTask && taskLifecycleIgnoresWorkspaceArgument(operationName) && requestedWorkspace) {
        effectiveArgs = { ...effectiveArgs };
        delete effectiveArgs.workspace;
        workspaceResolution = null;
      }
    }
    // Capability and compatible task/workspace scope have now been verified.
    if (!knownTask) workspaceScopeVerified = true;
    assertTaskPlanReady({
      taskId: requestedTaskId,
      knownTask,
      operationName,
      optionalBookkeeping: optionalIntegrity
    });
    const attributionHint = taskScope === 'optional' && !requestedTaskId && effectiveArgs?.independent !== true
      ? taskAttributionHint(config, authorizedWorkspace, effectivePrincipal, context?.conversationId)
      : '';
    if (attributionHint && !optionalIntegrity) {
      throw taskError('TASK_ATTRIBUTION_REQUIRED', attributionHint, { retryable: true, allowedAlternatives: [attributionHint] });
    }
    let repeatCall = observeRepeatCall({
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
      executionOperationId: context?.fallbackOperationId,
      createTask: operationName === OP.WORK_BEGIN && !knownTask,
      trackTask: context?.trackTaskActivity !== false
        && (![OP.WORK_STATUS, OP.WORK_RESULT, OP.WORK_HISTORY].includes(operationName) || resumedStatusRead)
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
      principalFingerprint: trustedLocalTaskControl
        ? knownTask?.principalFingerprint
        : principalFingerprint(effectivePrincipal)
    });
    if (taskProgressPatch) applyTaskProgressPatch(requestedTaskId, taskProgressPatch, finishActivity?.update);
    const execution = await executeToolCall({
      config, name, executionName: operationName, effectiveArgs, context, requestTaskContext, finishActivity, definition, started, workspaceOverride
    });
    const value = execution.value;
    if (operationName === OP.SNAPSHOT && (value?.skillDiscovery?.resumable || value?.skillDiscovery?.resumed))
      repeatCall = observeRepeatCall({ connector, taskId: requestedTaskId, operationName, progress: true });
    operationTimeline = execution.timeline;
    operationTimeline?.transition('persisting');
    if (value && typeof value === 'object') value.timeline = operationTimeline?.snapshot();
    handlerResult = value;
    handlerResultKnown = true;
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
    const auditPromise = safeLogAudit(config, {
      ...activityResult.activity,
      ...taskAuditContext(context, finishActivity, requestedTaskId, operationName, valueOk, value),
      taskIntegrityEligible: workspaceScopeVerified,
      taskResultFactsEligible: true,
      tool: operationName,
      publicTool: name,
      ...(operationName === OP.WORK_BEGIN ? { deferBaseline: true } : {}),
      internalOperation: operationName === name ? undefined : operationName,
      action: resolved.action || undefined,
      operation: activityResult.activity?.title || finishActivity?.operation,
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
    }, { strictIntegrity: Boolean(workId) && (!optionalIntegrity || operationName === OP.WORK_BEGIN), optionalIntegrity });
    const auditEntry = workId ? await auditPromise : null;
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
    operationTimeline?.transition('result-ready');
    if (value && typeof value === 'object') value.timeline = operationTimeline?.finish();
    if (activityResult.activity && value?.timeline) activityResult.activity.metadata.timeline = value.timeline;
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
    if (operationTimeline) enhanced.timeline = operationTimeline.finish({ errorCode: enhanced.code });
    const knownResult = handlerResultKnown ? handlerResult : error?.handlerResult;
    const postHandlerIntegrityFailure = enhanced.code === 'TASK_INTEGRITY_PERSISTENCE_FAILED' && (handlerResultKnown || error?.handlerResultKnown === true);
    if (postHandlerIntegrityFailure) enhanced.retryable = false;
    analyticsFailureCode = String(enhanced.code || '');
    activityResult = {
      ok: false,
      error: enhanced.message,
      activity: buildToolActivityDetails(operationName, effectiveArgs || {}, postHandlerIntegrityFailure ? knownResult : null, enhanced, {
        operation: finishActivity?.operation,
        phase: 'complete',
        metadata: { errorCode: enhanced.code, retryable: enhanced.retryable === true, publicTool: name, ...(enhanced.timeline ? { timeline: enhanced.timeline } : {}) }
      })
    };
    const failedWorkId = finishActivity?.taskId || requestedTaskId;
    if (failedWorkId) enhanced.taskId = failedWorkId;
    // A failed post-handler write must not erase physical execution evidence
    // or invite the caller to repeat an already-admitted mutation.
    if (postHandlerIntegrityFailure) {
      const response = compactResponse
        ? serializeConnectorResult({ publicName: name, action: resolvedAction, operationName, value: knownResult, args: effectiveArgs || {}, workId: failedWorkId })
        : withTaskIdentity(knownResult, failedWorkId);
      return ok({
        ...response,
        ok: false,
        operationOk: knownResult?.ok !== false,
        handlerCompleted: true,
        retryable: false,
        ...(knownResult?.completionKnown === true ? { completionKnown: false } : {}),
        ...(knownResult?.error ? { operationError: knownResult.error } : {}),
        error: enhanced.message,
        errorCode: enhanced.code,
        errorDetails: { code: enhanced.code, source: 'rel-ai-mcp', operation: 'write', taskId: failedWorkId, retryable: false },
        nextAction: 'The handler returned this result before task bookkeeping failed. Do not repeat the original operation to repair persistence. Reconcile the same work_id and operationId; a running operation may still be active.'
      });
    }
    const verifiedTaskFailure = Boolean(taskOwnerVerified || (finishActivity?.taskId && operationName === OP.WORK_BEGIN));
    const verifiedWorkspaceFailure = workspaceScopeVerified && (!requestedTaskId || verifiedTaskFailure);
    const partialResult = knownResult && typeof knownResult === 'object' && !Array.isArray(knownResult)
      ? knownResult
      : ['applied', 'unknown'].includes(error?.mutationEffect)
        ? { mutationEffect: error.mutationEffect, changedFiles: error.changedFiles, possibleChangedFiles: error.possibleChangedFiles }
        : null;
    const failedValue = { ...(partialResult || {}), ok: false, errorCode: enhanced.code || '', commandSummary: effectiveArgs?.command || '' };
    const physicalEffectKnown = Boolean(partialResult && (partialResult.mutationEffect === 'applied'
      || partialResult.mutationEffect === 'unknown' || partialResult.committed === true));
    if (physicalEffectKnown) enhanced.retryable = false;
    if (verifiedWorkspaceFailure && physicalEffectKnown) signalRepositoryIntelligenceMutation(config, operationName, effectiveArgs || {}, failedValue);
    const resultFactsEligible = Boolean(handlerResultKnown || error?.handlerResultKnown === true || physicalEffectKnown);
    const failedDraft = failedWorkId && verifiedWorkspaceFailure && resultFactsEligible ? buildWorkflowEvidenceReceipt({
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
        ...(verifiedWorkspaceFailure ? buildExtraAudit(operationName, failedValue, effectiveArgs || {}) : {}),
        ...taskAuditContext(context, finishActivity, requestedTaskId, operationName, false),
        // Owner-verified failure activity is distinct from authority to observe
        // or reconcile the caller-supplied workspace.
        ...(!verifiedTaskFailure ? { taskIdentityVersion: 0, taskIdExplicit: false, taskHistoryEligible: false } : {}),
        taskIntegrityEligible: verifiedWorkspaceFailure,
        taskResultFactsEligible: resultFactsEligible,
        tool: operationName,
        publicTool: name,
        internalOperation: operationName === name ? undefined : operationName,
        action: resolvedAction || undefined,
        operation: activityResult.activity?.title || finishActivity?.operation,
        ok: false,
        workspace: verifiedWorkspaceFailure ? effectiveArgs?.workspace : verifiedTaskSession?.workspace || knownTask?.workspace || '',
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
    if (verifiedWorkspaceFailure && physicalEffectKnown) {
      const response = compactResponse
        ? serializeConnectorResult({ publicName: name, action: resolvedAction, operationName, value: failedValue, args: effectiveArgs || {}, workId: failedWorkId })
        : withTaskIdentity(failedValue, failedWorkId);
      return ok({
        ...response, ok: false, retryable: false,
        handlerCompleted: handlerResultKnown || error?.handlerResultKnown === true,
        error: enhanced.message, errorCode: enhanced.code,
        nextAction: 'A source mutation or commit may already have taken effect. Preserve the same operation identity and recovery evidence; do not repeat the mutation to repair bookkeeping.'
      });
    }
    throw enhanced;
  } finally {
    scheduleLocalToolOutcome(config, {
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
      scheduleLocalTaskCompletion(config, completedTaskAnalytics);
    }
  }
}

async function validateCompletePublicInput(name, input) {
  const contract = PUBLIC_INPUT_VALIDATORS.get(name);
  if (!contract) throw new Error(`Unknown public tool '${name}'.`);
  const result = await contract.validator.validate(input);
  if (!result.issues) return;
  throw toolArgumentError({
    publicTool: name, action: String(input.action || ''), schema: contract.schema,
    issues: result.issues, message: `Input validation error for ${name}: ${result.issues.map(issue => issue.message).join('; ')}.`
  });
}

function taskBookkeepingOptionalFor(operationName, args = {}, definition = {}) {
  if (taskLifecycleCanRunWithoutIntegrity(operationName) || definition.annotations?.readOnlyHint === true) return true;
  if ([OP.PROCESS_READ, OP.PROCESS_LIST, OP.PROCESS_STOP].includes(operationName)) return true;
  if (args.dryRun === true) return true;
  if (operationName === OP.EDIT && ['list', 'compare'].includes(String(args.envAction || ''))) return true;
  const action = String(args.action || '').trim().toLowerCase();
  if (operationName === OP.BROWSER) return ['status', 'tabs', 'snapshot', 'screenshot', 'stop'].includes(action);
  if (operationName === OP.UI) return ['snapshot', 'screenshot', 'console', 'network', 'stop'].includes(action);
  if (operationName === OP.COMPUTER) return ['status', 'displays', 'observe', 'screenshot', 'wait_for_change', 'wait_for_stable', 'stop'].includes(action);
  return operationName === OP.DESKTOP && action === 'clipboard_read';
}

function readOptionalTaskIntegrity(config, taskId, workspace, optional) {
  try { return readTaskIntegrity(config, taskId, workspace); }
  catch (error) {
    if (!optional || !/^TASK_INTEGRITY_/.test(String(error?.code || ''))) throw error;
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] optional task integrity:', error);
    return null;
  }
}

function taskPlanHasSteps(plan) {
  return Array.isArray(plan?.steps) && plan.steps.length > 0;
}

function assertTaskPlanReady({ taskId, knownTask, operationName, optionalBookkeeping = false }) {
  if (!taskId || !knownTask || optionalBookkeeping || taskPlanGateExemptOperations.has(operationName)) return;
  const liveTask = getToolActivity().tasks.find(task => String(task.id || task.taskId || '') === taskId);
  const task = liveTask || knownTask;
  if (taskPlanHasSteps(task.plan)) return;
  throw taskError(
    'TASK_PLAN_REQUIRED',
    'Every durable Rel.AI task requires a non-empty plan before normal task-scoped work can continue. Start new tasks with steps on relai_work action "begin", or repair an older planless task with relai_work action "plan".',
    {
      retryable: true,
      allowedAlternatives: [
        `Call relai_work action "plan" with work_id "${taskId}" and ordered steps`,
        'For a projectless one-shot utility or control request, run the supported operation taskless instead of creating a durable task'
      ]
    }
  );
}

const taskPlanGateExemptOperations = new Set([
  OP.WORK_BEGIN, OP.WORK_CONTEXT, OP.WORK_PLAN, OP.WORK_STATUS, OP.WORK_RESULT, OP.WORK_HISTORY, OP.WORK_STOP, OP.WORK_CANCEL, OP.WORK_FINISH,
  OP.PROCESS_READ, OP.PROCESS_LIST, OP.PROCESS_STOP
]);

function taskOperationBindsProject(operationName) {
  return ![
    OP.WORK_BEGIN, OP.WORK_PLAN, OP.WORK_STATUS, OP.WORK_RESULT, OP.WORK_HISTORY, OP.WORK_STOP, OP.WORK_CANCEL, OP.WORK_FINISH
  ].includes(operationName);
}

function taskLifecycleCanRunWithoutIntegrity(operationName) {
  return [
    OP.WORK_CONTEXT, OP.WORK_PLAN, OP.WORK_STATUS, OP.WORK_RESULT, OP.WORK_HISTORY, OP.WORK_STOP, OP.WORK_CANCEL, OP.WORK_FINISH
  ].includes(operationName);
}

function taskLifecycleIgnoresWorkspaceArgument(operationName) {
  return [
    OP.WORK_PLAN, OP.WORK_STATUS, OP.WORK_RESULT, OP.WORK_HISTORY, OP.WORK_STOP, OP.WORK_CANCEL, OP.WORK_FINISH
  ].includes(operationName);
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

function resolveDirectFilesystemCall(config, args = {}, operationName) {
  const workspace = String(args?.workspace || '').trim();
  const rootInput = String(args?.root || '').trim();
  if (workspace) {
    if (rootInput) throw directFilesystemError('DIRECT_FILESYSTEM_SCOPE_CONFLICT', 'root can be used only when workspace is omitted.');
    return null;
  }
  if (config?.projectAccess?.directFilesystem !== true) return null;
  if (![OP.READ, OP.SEARCH_TEXT, OP.EDIT].includes(operationName)) return null;
  if (operationName === OP.READ && args?.asResource === true) {
    throw directFilesystemError('DIRECT_FILESYSTEM_RESOURCE_UNSUPPORTED', 'Direct filesystem reads do not support asResource. Read the file as text or use a configured project for resource transfer.');
  }
  if (operationName === OP.EDIT) assertDirectFilesystemEditForm(args);

  const targets = directFilesystemTargets(operationName, args);
  const root = resolveDirectFilesystemRoot(rootInput, targets, operationName);
  const normalizedArgs = normalizeDirectFilesystemArgs(args, operationName, root);
  return {
    args: normalizedArgs,
    workspace: {
      alias: '@filesystem',
      path: root,
      sourcePaths: [root],
      directFilesystem: true
    }
  };
}

function resolveDirectFilesystemRoot(rootInput, targets, operationName) {
  let root = rootInput;
  if (root) {
    if (!path.isAbsolute(root)) throw directFilesystemError('DIRECT_FILESYSTEM_ROOT_ABSOLUTE_REQUIRED', `Direct filesystem root must be absolute: ${root}`);
    root = path.resolve(root);
  } else {
    if (!targets.length) {
      const noun = operationName === OP.SEARCH_TEXT ? 'search' : 'operation';
      throw directFilesystemError('DIRECT_FILESYSTEM_ROOT_REQUIRED', `Direct filesystem ${noun} requires an absolute root, or absolute target paths that identify one filesystem root.`);
    }
    const absoluteTargets = targets.map(value => String(value || '').trim());
    if (absoluteTargets.some(value => !path.isAbsolute(value))) {
      throw directFilesystemError('DIRECT_FILESYSTEM_ROOT_REQUIRED', 'Relative paths outside configured projects require an absolute root.');
    }
    const roots = [...new Set(absoluteTargets.map(value => directFilesystemRootKey(path.parse(path.resolve(value)).root)))];
    if (roots.length !== 1) throw directFilesystemError('DIRECT_FILESYSTEM_MULTIPLE_ROOTS', 'One direct filesystem call cannot span multiple filesystem roots or Windows drives. Split the request.');
    root = path.parse(path.resolve(absoluteTargets[0])).root;
  }
  let stat;
  try { stat = fs.statSync(root); } catch {
    throw directFilesystemError('DIRECT_FILESYSTEM_ROOT_UNAVAILABLE', `Direct filesystem root does not exist or is unavailable: ${root}`);
  }
  if (!stat.isDirectory()) throw directFilesystemError('DIRECT_FILESYSTEM_ROOT_NOT_DIRECTORY', `Direct filesystem root must be a directory: ${root}`);
  const sensitive = [root, fs.realpathSync(root)].some(candidate => classifySensitivePath(candidate).sensitive);
  if (sensitive) {
    throw directFilesystemError('SENSITIVE_PATH_RESTRICTED', `Direct filesystem root is blocked by the sensitive-path policy: ${root}`);
  }
  return root;
}

function directFilesystemTargets(operationName, args = {}) {
  const values = operationName === OP.READ
    ? [
        ...(Array.isArray(args.paths) ? args.paths : []),
        ...(Array.isArray(args.ranges) ? args.ranges.map(entry => entry?.path) : [])
      ]
    : operationName === OP.EDIT
      ? [
          args.path,
          ...(Array.isArray(args.edits) ? args.edits.map(entry => entry?.path) : [])
        ]
      : [];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeDirectFilesystemArgs(args, operationName, root) {
  if (operationName === OP.READ) {
    return {
      ...args,
      ...(Array.isArray(args.paths) ? { paths: args.paths.map(value => normalizeDirectFilesystemPath(root, value, 'read')) } : {}),
      ...(Array.isArray(args.ranges) ? { ranges: args.ranges.map(entry => ({ ...entry, path: normalizeDirectFilesystemPath(root, entry?.path, 'read') })) } : {})
    };
  }
  if (operationName === OP.EDIT) {
    const editOperation = args.envAction ? `env-${String(args.envAction).trim().toLowerCase()}` : 'write';
    const envOperation = Boolean(args.envAction);
    return {
      ...args,
      ...(args.path ? { path: normalizeDirectFilesystemPath(root, args.path, editOperation, { allowSensitiveRealPath: envOperation }) } : {}),
      ...(args.templatePath ? { templatePath: normalizeDirectFilesystemPath(root, args.templatePath, 'read') } : {}),
      ...(Array.isArray(args.edits) ? { edits: args.edits.map(entry => ({ ...entry, path: normalizeDirectFilesystemPath(root, entry?.path, 'write') })) } : {})
    };
  }
  return args;
}

function normalizeDirectFilesystemPath(root, value, operation, options = {}) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const relative = path.isAbsolute(raw)
    ? path.relative(root, path.resolve(raw))
    : raw;
  const outsideRoot = relative === '..'
    || relative.startsWith('../')
    || relative.startsWith('..\\')
    || path.isAbsolute(relative);
  if (outsideRoot) {
    throw directFilesystemError('DIRECT_FILESYSTEM_PATH_OUTSIDE_ROOT', `Path is outside the selected direct filesystem root: ${raw}`);
  }
  const normalized = (relative || '.').replaceAll('\\', '/');
  if (classifySensitivePath(normalized).sensitive) return normalized;
  const safe = resolveSafePath(root, normalized, { operation, label: 'Direct filesystem path' });
  if (options.allowSensitiveRealPath !== true) {
    const realRoot = fs.realpathSync(root);
    const realRelative = path.relative(realRoot, safe.realPath).replaceAll('\\', '/');
    const sensitive = classifySensitivePath(realRelative);
    if (sensitive.sensitive) {
      throw directFilesystemError('SENSITIVE_PATH_RESTRICTED', `Direct filesystem target resolves to a sensitive path: ${raw}`);
    }
  }
  return safe.relativePath;
}

function assertDirectFilesystemEditForm(args = {}) {
  if (args.semantic || args.symbolEdit || args.updateText || args.stage || args.writeId) {
    throw directFilesystemError('DIRECT_FILESYSTEM_REPOSITORY_FEATURE_REQUIRED', 'Direct filesystem edits support exact/full-file, batch, native-file, and environment forms. Semantic, symbol, patch, and staged repository edit forms still require a configured project.');
  }
  if (args.runChecks === true || args.returnDiff === true) {
    throw directFilesystemError('DIRECT_FILESYSTEM_REPOSITORY_FEATURE_REQUIRED', 'Direct filesystem edits cannot run repository checks or return repository diffs. Use a configured project for those options.');
  }
}

function directFilesystemRootKey(value) {
  const normalized = String(value || '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function directFilesystemError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = true;
  return error;
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
  if (!alias || args?.dryRun === true || value?.mutationEffect === 'none') return;
  const changedFiles = Array.isArray(value?.changedFiles)
    ? [...new Set(value.changedFiles.map(item => String(item || '').trim().replaceAll('\\', '/')).filter(Boolean))]
    : [];
  const uncertainMutation = value?.mutationEffect === 'unknown' || value?.mutationUnknown === true;
  const possibleChangedFiles = Array.isArray(value?.possibleChangedFiles)
    ? [...new Set(value.possibleChangedFiles.map(item => String(item || '').trim().replaceAll('\\', '/')).filter(Boolean))]
    : [];
  const broadMutation = operationName === OP.CHANGES_RESET && (value?.ok !== false || uncertainMutation);
  const targetedMutation = changedFiles.length > 0
    && [OP.EDIT, OP.EXEC, OP.CHANGES_TIDY_RUN].includes(operationName);
  const restoreMutation = operationName === OP.CHANGES_RESTORE && value?.ok !== false
    ? [...new Set((Array.isArray(args?.paths) ? args.paths : []).map(item => String(item || '').trim().replaceAll('\\', '/')).filter(Boolean))]
    : [];
  if (!broadMutation && !targetedMutation && !restoreMutation.length && !uncertainMutation) return;
  try {
    const workspace = resolveWorkspace(config, alias);
    const mutationPaths = broadMutation || (uncertainMutation && !possibleChangedFiles.length && !changedFiles.length)
      ? [] : [...new Set([...changedFiles, ...possibleChangedFiles, ...restoreMutation])];
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


function taskAdmissionReadError(error, context) {
  const reason = context.signal?.aborted ? context.signal.reason : error;
  const timedOut = reason?.name === 'TimeoutError';
  if (!context.signal?.aborted && !timedOut) return error;
  const transportInterrupted = reason?.code === 'HTTP_MCP_REQUEST_INTERRUPTED';
  const failure = taskError(timedOut ? 'TIMEOUT' : transportInterrupted ? 'TRANSPORT_INTERRUPTED' : 'CANCELLED',
    reason instanceof Error ? reason.message : String(reason || 'Task lookup cancelled before admission.'), {
      retryable: false, allowedAlternatives: []
    });
  failure.executed = false;
  failure.terminationCertainty = 'not-started';
  if (timedOut) failure.deadlineKind = 'operation';
  failure.cause = reason;
  return failure;
}

// Resolve the execution identity before the transport registers replay/result
// state. The actual call still performs its complete admission and ownership
// checks; this preflight cannot grant authority or select an implicit task.
async function resolveFallbackExecutionScope(config, name, args = {}, context = {}) {
  const resolved = resolveExecutableToolCall(name, args, config);
  if (!resolved) throw new Error(`Unknown tool '${name}'.`);
  const operationName = resolved.operationName;
  const principal = principalForContext(context, Boolean(context.publicHttpOnly));
  assertAuthorizedToolCall({ principal, operationName, workspace: '' });
  let workspace = String(args.workspace || '').trim();
  const taskId = normalizeTaskId(args.work_id);
  if (taskId && args.independent === true) throw taskError('TASK_SCOPE_CONFLICT', 'work_id and independent cannot be combined.');
  let knownTask = null;
  if (taskId && operationName !== OP.WORK_BEGIN) {
    knownTask = await assertKnownTask(config, taskId, '', operationName, principal, args, {
      signal: context.signal, deadlineAtMs: context.deadlineAtMs
    }).catch(error => { throw taskAdmissionReadError(error, context); });
    if (!workspace) workspace = String(knownTask?.workspace || '');
  }
  const resolution = resolveConfiguredWorkspaceArgument(config, workspace);
  workspace = resolution?.alias || workspace;
  if (workspace) assertAuthorizedToolCall({ principal, operationName, workspace });
  if (knownTask) assertTaskWorkspaceOwnership(knownTask, workspace);
  return { ...args, ...(workspace ? { workspace } : {}) };
}

export { callTool, resolveFallbackExecutionScope };
