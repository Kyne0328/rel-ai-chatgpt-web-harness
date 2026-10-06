import { runProcess, summarizeCommand } from "../process.js";
import { resolveSafePath } from "../safety.js";
import { literalObservationPaths } from '../repo/gitObservation.js';

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

async function relaiRestorePaths(workspace, config, args = {}) {
  const paths = normalizePaths(workspace, args.paths);
  // ":(literal)" stops git re-interpreting a legitimate filename that happens to
  // contain pathspec syntax.
  const restore = await runProcess("git", ["restore", "--", ...paths.map((item) => `:(literal)${item}`)], {
    cwd: workspace.path,
    timeout: 60000
  }, config);
  return {
    workspace: workspace.alias,
    mode: "paths",
    paths,
    ...summarizeCommand(restore),
    ok: restore.exitCode === 0
  };
}

async function relaiResetWorkspace(workspace, config, args = {}) {
  const removeUntracked = args.removeUntracked === true;

  const reset = await runProcess("git", ["reset", "--hard", "HEAD"], {
    cwd: workspace.path,
    timeout: 60000
  }, config);
  let clean = null;
  if (reset.exitCode === 0 && removeUntracked) {
    clean = await runProcess("git", ["clean", "-fd"], {
      cwd: workspace.path,
      timeout: 60000
    }, config);
  }
  return {
    ok: reset.exitCode === 0 && (!clean || clean.exitCode === 0),
    workspace: workspace.alias,
    mode: "workspace-reset",
    removeUntracked,
    reset: summarizeCommand(reset),
    ...(clean ? { clean: summarizeCommand(clean) } : {})
  };
}

export { relaiResetWorkspace, relaiRestorePaths };
