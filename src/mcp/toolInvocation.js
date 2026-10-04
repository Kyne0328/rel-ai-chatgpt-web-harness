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
    const enriched = enrichWithFallbackCompletions(options.config, name, args, output, options.context || {});
    const result = toolResult(enriched, enriched?.ok === false);
    if (result.structuredContent?.truncated === true && result.structuredContent?.originalBytes > 0) {
      const owner = outputSpillOwner({
        taskId: args.work_id || enriched.work_id,
        workspace: completionWorkspace(args, enriched),
        principal: options.context?.principal
      });
      await retainOutputStreams(options.config, owner, enriched, { signal: options.context?.signal });
      return toolResult(enriched, enriched?.ok === false);
    }
    return result;
  } catch (error) {
    return toolResult(serializeToolError(name, error), true);
  }
}

function enrichWithFallbackCompletions(config, name, args, output, context) {
  if (!config || context?.backgroundFallbackExecution === true || !output || typeof output !== 'object' || Array.isArray(output)) return output;
  const workspace = completionWorkspace(args, output);
  if (!workspace) return output;
  const noticeScope = principalFingerprint(context?.principal);
  const completedOperations = peekFallbackCompletionNotices(config, { noticeScope, workspace });
  if (completedOperations.length) {
    registerFallbackCompletionDelivery(config, completedOperations, {
      noticeScope,
      workspace,
      requestId: context?.requestId
    });
  }
  return completedOperations.length ? { ...output, completedOperations } : output;
}

function completionWorkspace(args, output) {
  const direct = typeof output?.workspace === 'string'
    ? output.workspace
    : output?.workspace?.alias;
  return String(direct || output?.backgroundOperation?.workspace || output?.backgroundOperations?.[0]?.workspace || args?.workspace || '').trim();
}

export { enrichWithFallbackCompletions, invokeRelaiTool };
