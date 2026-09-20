import { updateCurrentToolActivity } from '../toolActivity.js';
import { createValidationFingerprint } from './validationPlan.js';

async function noChecksValidationResult(workspace, config, details) {
  const {
    level, skippedChecks, aliasNormalizations, validationLevel,
    validationLevelReason, changedFiles, policy, validationScope = [], signal
  } = details;
  const fingerprint = await createValidationFingerprint(workspace, config, { paths: validationScope, signal });
  const validationFingerprint = fingerprint.fingerprint;
  updateCurrentToolActivity({
    status: 'validating',
    operation: `No ${level} validation commands were detected`,
    currentStage: 'Validation not run',
    currentActivity: 'No validation checks were detected.',
    progress: { mode: 'indeterminate', label: 'No validation checks detected' },
    activity: {
      category: 'validation',
      status: 'running',
      summary: 'No validation checks were detected.',
      metadata: { checkCount: 0, skippedCount: skippedChecks.length }
    }
  });
  return {
    ok: false,
    workspace: workspace.alias,
    level,
    checks: [],
    commands: [],
    results: [],
    skippedChecks,
    aliasNormalizations,
    validationLevel,
    validationLevelReason,
    changedFiles,
    policy,
    validated: false,
    validationStatus: 'not_run',
    validationFingerprint,
    validationScope: fingerprint.scopePaths,
    message: 'Validation status: NOT RUN. No validation checks were detected or executed. This is not a passed validation. Define a check/test/build script or pass an explicit check.'
  };
}

export { noChecksValidationResult };
