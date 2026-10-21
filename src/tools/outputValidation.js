import { jsonBytes, utf8Head } from './responseBudget.js';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { getOperationDefinitions, resolveToolOperation } from './actionCatalog.js';

const OPERATION_OUTPUT_VALIDATORS = new Map(getOperationDefinitions().map(definition => [
  definition.name,
  fromJsonSchema(definition.outputSchema)['~standard']
]));

async function validateToolOutput(_config, name, args, output) {
  const resolution = resolveToolOperation(name, args || {});
  const schema = resolution?.definition?.outputSchema;
  if (!schema) return;
  const validator = OPERATION_OUTPUT_VALIDATORS.get(resolution.operationName);
  if (!validator) throw new Error(`Output validator is unavailable for ${resolution.operationName}.`);
  const result = await validator.validate(output);
  if (!result.issues) return;

  const details = result.issues.map(issue => {
    const location = Array.isArray(issue.path)
      ? issue.path.map(segment => String(segment?.key ?? segment)).filter(Boolean).join('.')
      : '';
    return `${location || '<root>'}: ${issue.message}`;
  });
  const allowed = new Set(Object.keys(schema.properties || {}));
  const unexpected = output && typeof output === 'object'
    ? Object.keys(output).filter(key => !allowed.has(key))
    : [];
  const unexpectedSuffix = unexpected.length ? ` Unexpected fields: ${unexpected.join(', ')}.` : '';
  throw new Error(`Output validation error for ${name}${resolution?.action ? ` action ${resolution.action}` : ''}: ${details.join('; ')}.${unexpectedSuffix}`);
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

export { validateToolOutput, outputValidationFailure };
