// Public execution facts shared by command summaries and connector projections.
// Keep explicit false/zero and contractful null values; absence is not evidence.
// Text output and tool-level success are presentation/caller concerns.
const EXECUTION_OUTCOME_FIELDS = Object.freeze([
  'executed', 'commandSucceeded', 'exitCode', 'durationMs',
  'admissionBlocked', 'queueWaitMs', 'queueTimedOut', 'errorCode',
  'blockedResource', 'resourceReason', 'retryable', 'resourcePressure',
  'timedOut', 'cancelled', 'rootExitConfirmed', 'terminationConfirmed',
  'forcedTermination', 'signal', 'error', 'mutationUnknown',
  'outputFinalizationTimedOut', 'outputFinalizationError', 'mutationOwnershipPersistenceError',
  'stdoutBytes', 'stderrBytes', 'stdoutTruncated', 'stderrTruncated',
  'stdoutOutputRef', 'stderrOutputRef', 'stdoutSpillTruncated', 'stderrSpillTruncated'
]);

function executionOutcome(result) {
  return Object.fromEntries(EXECUTION_OUTCOME_FIELDS
    .filter(key => result?.[key] !== undefined
      && (result[key] !== null || key === 'exitCode' || key === 'terminationConfirmed'))
    .map(key => [key, result[key]]));
}

export { executionOutcome };
