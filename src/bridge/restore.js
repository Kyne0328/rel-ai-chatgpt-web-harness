import { runProcess, summarizeCommand } from "../process.js";
import { resolveSafePath } from "../safety.js";
import { literalObservationPaths } from '../repo/gitObservation.js';
import { gitOperationOptions } from '../repo/gitOps.js';

// resolveSafePath validates these as filesystem paths, but git reads them as
// pathspecs: "*" or "." after `--` match the whole worktree. Keep
// scoped restores strictly literal to avoid discarding unrelated changes.
const PATHSPEC_MAGIC = /[*?[\]]/;

function normalizePaths(workspace, paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('relai_changes action "restore" requires at least one path.');
  }
  const selected = paths.map((item) => {
    const relativePath = resolveSafePath(workspace.path, item, { operation: "restore" }).relativePath;
    if (PATHSPEC_MAGIC.test(relativePath) || relativePath === ".") {
      throw new Error(`relai_changes action "restore" requires literal file paths, not patterns: ${relativePath}.`);
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

function completeMutation(result) {
  return result.executed === true && result.exitCode === 0 && !result.cancelled && !result.timedOut
    && result.terminationConfirmed !== false && !result.outputFinalizationTimedOut;
}

export { relaiRestorePaths };
