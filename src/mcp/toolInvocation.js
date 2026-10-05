import { responseByteLimit } from '../tools/responseBudget.js';
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
      return requestBrowserHandoff({
        args,
        context: options.context || {},
        rawContext: options.approvalContext,
        codec: options.requestStateCodec,
        execute: async action => {
          const output = await callTool(name, browserHandoffOperationArgs(args, action), options.context || {});
          if (output?.ok !== false && typeof options.validateOutput === 'function') await options.validateOutput(output);
          return output;
        }
      });
    }
    const output = await callTool(name, args, options.context || {});
    if (output?.ok !== false && typeof options.validateOutput === 'function') {
      await options.validateOutput(output);
    }
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
    return toolResult(serializeToolError(name, error), true, undefined, resultOptions);
  }
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
