import { runProcess, summarizeCommand } from "../process.js";
import { resolveSafePath } from "../safety.js";
import { literalObservationPaths } from '../repo/gitObservation.js';
import { gitOperationOptions, assertWorkspaceRepositoryRoot } from '../repo/gitOps.js';

// resolveSafePath validates these as filesystem paths, but git reads them as
// pathspecs: "*" or "." after `--` matches the whole worktree, so a single-file
// restore request could discard every uncommitted change without the RESET
// confirmation that relai_changes action "reset" demands.
const PATHSPEC_MAGIC = /[*?[\]]/;

function normalizePaths(workspace, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('relai_changes action "restore" requires at least one path.');
  }
  const selected = paths.map((item) => {
    const relativePath = resolveSafePath(workspace.path, item, { operation: "restore" }).relativePath;
    if (PATHSPEC_MAGIC.test(relativePath) || relativePath === ".") {
      throw new Error(`relai_changes action "restore" requires literal file paths, not patterns: ${relativePath}. Use relai_changes action "reset" to discard the entire workspace after approval.`);
    }
    return relativePath;
  });
  return literalObservationPaths(workspace.path, selected);
}

async function relaiRestorePaths(workspace, config, args = {}, context = {}) {
  const paths = normalizePaths(workspace, args.paths);
  // ":(literal)" stops git re-interpreting a legitimate filename that happens to
  // contain pathspec syntax.
  const restore = await runProcess("git", ["restore", "--", ...paths.map((item) => `:(literal)${item}`)], {
    cwd: workspace.path,
    ...gitOperationOptions(context)
  }, config).catch(error => {
    Object.assign(error, { handlerResult: { ok: false, workspace: workspace.alias, paths, mutationEffect: error?.executed === false ? 'none' : 'unknown', changedFiles: [], ...(error?.executed === false ? {} : { possibleChangedFiles: paths }), error: 'Restore outcome could not be verified. Reconcile the selected files before retrying.' } });
    throw error;
  });
  return {
    workspace: workspace.alias,
    mode: "paths",
    paths,
    ...summarizeCommand(restore),
    ok: completeMutation(restore),
    mutationEffect: restore.executed === false ? "none" : "unknown",
    ...(restore.executed !== false ? { possibleChangedFiles: paths } : {})
  };
}

async function relaiResetWorkspace(workspace, config, args = {}, context = {}) {
  await assertWorkspaceRepositoryRoot(workspace, config, context);
  const removeUntracked = args.removeUntracked === true;
  let reset = null;
  let clean = null;
  let mutationStarted = false;
  try {
    const resetOptions = gitOperationOptions(context);
    mutationStarted = true;
    reset = await runProcess("git", ["reset", "--hard", "HEAD"], { cwd: workspace.path, ...resetOptions }, config);
    if (completeMutation(reset) && removeUntracked) {
      const cleanOptions = gitOperationOptions(context);
      clean = await runProcess("git", ["clean", "-fd"], { cwd: workspace.path, ...cleanOptions }, config);
    }
    return {
      ok: completeMutation(reset) && (!clean || completeMutation(clean)),
      mutationEffect: reset.executed === false ? 'none' : 'unknown',
      workspace: workspace.alias, mode: "workspace-reset", removeUntracked,
      reset: summarizeCommand(reset), ...(clean ? { clean: summarizeCommand(clean) } : {})
    };
  } catch (error) {
    const resetNeverExecuted = !mutationStarted || reset?.executed === false
      || (reset === null && error?.executed === false);
    return {
      ok: false, workspace: workspace.alias, mode: "workspace-reset", removeUntracked,
      mutationEffect: resetNeverExecuted ? 'none' : 'unknown',
      ...(reset ? { reset: summarizeCommand(reset) } : {}),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function completeMutation(result) {
  return result.executed === true && result.exitCode === 0 && !result.cancelled && !result.timedOut
    && result.terminationConfirmed !== false && !result.outputFinalizationTimedOut;
}

export { relaiResetWorkspace, relaiRestorePaths };
