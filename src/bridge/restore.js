import { runProcess, runReadOnlyProcess, summarizeCommand } from "../process.js";
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
  // A literal Git pathspec can still select descendants. A deleted directory
  // is invisible to lstat, so verify the whole selection against the index
  // before restoring anything. Keep the descendant exclusions on the mutation
  // as well: a concurrent index change must never broaden the selected scope.
  const pathspecs = paths.flatMap(file => [`:(literal)${file}`, `:(exclude,literal)${file}/`]);
  const index = await runReadOnlyProcess("git", ["ls-files", "--stage", "-z", "--", ...pathspecs], {
    cwd: workspace.path, ...gitOperationOptions(context), preserveOutputWhitespace: true
  }, config);
  const exactFiles = new Set();
  const indexVerified = completeProcess(index) && !index.stdoutTruncated && !index.stdoutSpillTruncated;
  if (indexVerified) {
    for (const entry of index.stdout.split("\0")) {
      // Only ordinary, executable or symbolic-link files at index stage zero.
      const match = /^(?:100644|100755|120000) [0-9a-f]+ 0\t([\s\S]+)$/u.exec(entry);
      if (match) exactFiles.add(match[1]);
    }
  }
  if (!paths.every(file => exactFiles.has(file))) {
    return { workspace: workspace.alias, mode: "paths", paths, ok: false, executed: false,
      mutationEffect: "none", changedFiles: [],
      error: indexVerified ? "Restore requires exact tracked file paths in the index. No files were restored."
        : "Could not verify the Git index. No files were restored. Check repository status before retrying." };
  }
  const restore = await runProcess("git", ["restore", "--", ...pathspecs], {
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
    ok: completeProcess(restore),
    mutationEffect: restore.executed === false ? "none" : "unknown",
    ...(restore.executed !== false ? { possibleChangedFiles: paths } : {})
  };
}

function completeProcess(result) {
  return result.executed === true && result.exitCode === 0 && !result.cancelled && !result.timedOut
    && result.terminationConfirmed !== false && !result.outputFinalizationTimedOut;
}

export { relaiRestorePaths };
