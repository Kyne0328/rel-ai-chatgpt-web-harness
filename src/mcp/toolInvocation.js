import { jsonBytes, responseByteLimit, utf8Head } from '../tools/responseBudget.js';
import { requireApprovalIfNeeded } from './approval.ts';
import { toolResult } from './results.js';
import { outputSpillOwner, retainOutputStreams } from '../outputSpill.js';
import { callTool } from '../tools.js';
import { serializeToolError } from '../tools/errors.js';
import {
  peekFallbackCompletionNotices,
  registerFallbackCompletionDelivery
} from './fallbackExecutions.js';
import { principalFingerprint } from './principal.ts';
import { browserHandoffOperationArgs, requestBrowserHandoff } from './browserHandoff.ts';

async function invokeRelaiTool(options = {}) {
  const name = String(options.name || '');
  const args = options.args || {};
  const resultOptions = name === 'relai_work' && ['status', 'result', 'history'].includes(args.action)
    ? { maxResponseBytes: responseByteLimit(args.maxResponseBytes) } : {};
  let validationFailure;
  const validateReturnedOutput = async output => {
    if (output?.ok !== false && typeof options.validateOutput === 'function') {
      try { await options.validateOutput(output); }
      catch (error) {
        validationFailure = outputValidationFailure(output, error, options.context || {});
        throw error;
      }
    }
  };
  try {
    if (options.approvalContext && options.requestStateCodec) {
      const approval = await requireApprovalIfNeeded(
        name,
        args,
        options.context || {},
        options.approvalContext,
        options.requestStateCodec
      );
      if (approval) return approval;
    }
    if (name === 'relai_browser' && args.action === 'handoff' && options.approvalContext && options.requestStateCodec) {
      return await requestBrowserHandoff({
        args,
        context: options.context || {},
        rawContext: options.approvalContext,
        codec: options.requestStateCodec,
        execute: async action => {
          const output = await callTool(name, browserHandoffOperationArgs(args, action), options.context || {});
          await validateReturnedOutput(output);
          return output;
        }
      });
    }
    const output = await callTool(name, args, options.context || {});
    await validateReturnedOutput(output);
    const identified = options.context?.fallbackOperationId && output && typeof output === 'object'
      ? { ...output, operationId: options.context.fallbackOperationId } : output;
    const enriched = enrichWithFallbackCompletions(options.config, name, args, identified, options.context || {});
    let result = toolResult(enriched, enriched?.ok === false, undefined, resultOptions);
    if (result.structuredContent?.truncated === true && result.structuredContent?.originalBytes > 0) {
      const owner = outputSpillOwner({
        taskId: args.work_id || enriched.work_id,
        workspace: completionWorkspace(args, enriched),
        principal: options.context?.principal
      });
      await retainOutputStreams(options.config, owner, enriched, { signal: options.context?.signal });
      result = toolResult(enriched, enriched?.ok === false, undefined, resultOptions);
    }
    return registerReturnedFallbackCompletions(options.config, args, result, options.context || {}, enriched);
  } catch (error) {
    return toolResult(validationFailure || serializeToolError(name, error), true, undefined, resultOptions);
  }
}

function outputValidationFailure(output, error, context) {
  const message = typeof error === 'string' ? error : ownDataValue(error, 'message');
  const receipt = {
    ok: false,
    errorCode: 'TOOL_OUTPUT_VALIDATION_FAILED',
    error: 'Output validation failed after the operation returned a result.',
    handlerCompleted: true,
    retryable: false,
    resultDetailsCompacted: true,
    nextAction: 'Inspect the existing result or output references read-only. Do not rerun the mutation.'
  };
  // Stay below the smallest control response's inner payload budget, including
  // metadata headroom. Exact identities are omitted, never truncated, if too large.
  const retain = (key, value) => {
    if (jsonBytes({ ...receipt, [key]: value }) > 900) return false;
    receipt[key] = value;
    return true;
  };
  const operationOk = ownDataValue(output, 'ok');
  if (typeof operationOk === 'boolean') retain('operationOk', operationOk);
  for (const key of ['executed', 'commandSucceeded', 'rootExitConfirmed', 'mutationUnknown', 'cleanupPending', 'committed', 'changed', 'timedOut', 'cancelled', 'forcedTermination', 'completionKnown', 'outputFinalizationTimedOut', 'stdoutTruncated', 'stderrTruncated', 'stdoutSpillTruncated', 'stderrSpillTruncated']) {
    const value = ownDataValue(output, key);
    if (typeof value === 'boolean') retain(key, value);
  }
  const terminationConfirmed = ownDataValue(output, 'terminationConfirmed');
  if (terminationConfirmed === null || typeof terminationConfirmed === 'boolean') retain('terminationConfirmed', terminationConfirmed);
  const exitCode = ownDataValue(output, 'exitCode');
  if (exitCode === null || Number.isSafeInteger(exitCode)) retain('exitCode', exitCode);
  const mutationEffect = ownDataValue(output, 'mutationEffect');
  if (['none', 'applied', 'unknown'].includes(mutationEffect)) retain('mutationEffect', mutationEffect);

  const fallbackOperationId = ownDataValue(context, 'fallbackOperationId');
  for (const key of ['operationId', 'work_id']) {
    const value = key === 'operationId' && fallbackOperationId != null && fallbackOperationId !== ''
      ? fallbackOperationId : ownDataValue(output, key);
    if (typeof value === 'string' && value.length <= 512 && value.trim()) retain(key, value);
  }
  for (const key of ['durationMs', 'queueWaitMs', 'stdoutBytes', 'stderrBytes', 'stdoutDroppedBytes', 'stderrDroppedBytes']) {
    const value = ownDataValue(output, key);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) retain(key, value);
  }

  for (const key of ['processId', 'workspace', 'stdoutOutputRef', 'stderrOutputRef', 'sessionId', 'tabId', 'head', 'status', 'lifecycle', 'validationStatus']) {
    let value = ownDataValue(output, key);
    if (key === 'workspace' && value && typeof value === 'object') value = ownDataValue(value, 'alias');
    if (typeof value === 'string' && value.length <= 512 && value.trim()) retain(key, value);
  }
  // JSON escaping can expand even short UTF-8 details. Fit the optional
  // diagnostic only after facts/identities; the fixed base is always bounded.
  if (typeof message === 'string') {
    for (const bytes of [128, 64, 32, 16, 8]) {
      if (retain('error', `Output validation failed: ${utf8Head(message.slice(0, 512), bytes)}`)) break;
    }
  }
  return receipt;
}

function ownDataValue(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  // An invalid DTO can contain accessors or a proxy. Do not invoke/coerce them
  // while salvaging other independently typed facts from a completed return.
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
}

function enrichWithFallbackCompletions(config, name, args, output, context) {
  if (!config || context?.backgroundFallbackExecution === true || !output || typeof output !== 'object' || Array.isArray(output)) return output;
  const workspace = completionWorkspace(args, output);
  if (!workspace) return output;
  const noticeScope = principalFingerprint(context?.principal);
  const completedOperations = peekFallbackCompletionNotices(config, { noticeScope, workspace });
  return completedOperations.length ? { ...output, completedOperations } : output;
}

// Register only IDs in the final bounded structured response. Enrichment is a
// peek, not proof of delivery; omitted notices must remain pending for later calls.
function registerReturnedFallbackCompletions(config, args, result, context = {}, originalOutput = null) {
  const output = result?.structuredContent;
  const notices = output?.completedOperations;
  if (!config || context.backgroundFallbackExecution === true || !Array.isArray(notices) || !notices.length) return result;
  registerFallbackCompletionDelivery(config, notices, {
    noticeScope: principalFingerprint(context.principal),
    workspace: completionWorkspace(args, originalOutput || output),
    requestId: context.requestId
  });
  return result;
}

function completionWorkspace(args, output) {
  const direct = typeof output?.workspace === 'string'
    ? output.workspace
    : output?.workspace?.alias;
  return String(direct || output?.backgroundOperation?.workspace || output?.backgroundOperations?.[0]?.workspace || args?.workspace || '').trim();
}

export { enrichWithFallbackCompletions, registerReturnedFallbackCompletions, invokeRelaiTool };
