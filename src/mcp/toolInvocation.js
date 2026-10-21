import { outputValidationFailure } from '../tools/outputValidation.js';
import { responseByteLimit } from '../tools/responseBudget.js';
import { toolResult } from './results.js';
import { outputSpillOwner, retainOutputStreams } from '../outputSpill.js';
import { callTool } from '../tools.js';
import { serializeToolError } from '../tools/errors.js';
import {
  peekFallbackCompletionNotices,
  registerFallbackCompletionDelivery
} from './fallbackExecutions.js';
import { principalFingerprint } from './principal.ts';

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
    const output = await callTool(name, args, options.context || {});
    await validateReturnedOutput(output);
    const browserOutput = name === 'relai_browser' && args.action === 'handoff' && output?.ok !== false
      ? { ...output, userInputRequired: true, nextAction: 'Finish the sign-in or verification in the local Rel.AI Browser, then call relai_browser with action "resume" for this session.' }
      : output;
    const identified = options.context?.fallbackOperationId && browserOutput && typeof browserOutput === 'object'
      ? { ...browserOutput, operationId: options.context.fallbackOperationId } : browserOutput;
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
