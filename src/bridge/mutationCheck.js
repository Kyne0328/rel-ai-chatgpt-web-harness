import { isClearlyReadOnlyExec } from '../executionClassification.js';
import { runWithMutationProcessOwnership, workspaceMutationSafetySummary } from '../mutationProcessOwnership.js';
import { runWorkspaceMutationBoundary } from '../workspaceOperationQueue.js';

// Validation deliberately permits edits while checks run, then revalidates the
// relevant workspace fingerprint. Track potentially mutating subprocesses
// durably without taking the exclusive edit lane for the whole check duration.
// Interrupted checks still retain ownership until their termination is proven.
function runValidationCommandWithMutationOwnership(workspace, config, command, operation, { exclusive = false, signal } = {}) {
  if (isClearlyReadOnlyExec({ command })) return operation();
  const run = () => {
    const recovery = workspaceMutationSafetySummary(config, workspace.alias, workspace.path);
    if (recovery?.blocked) {
      const error = new Error(recovery.message);
      error.code = recovery.code;
      error.retryable = false;
      error.executed = false;
      throw error;
    }
    return runWithMutationProcessOwnership(config, workspace.alias, operation, workspace.path,
      { concurrentValidation: !exclusive });
  };
  return exclusive
    ? runWorkspaceMutationBoundary(workspace.alias, run, { signal })
    : run();
}

export { runValidationCommandWithMutationOwnership };
