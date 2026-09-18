

import { redactCommandForAudit } from '../commandDisplay.js';
import { OPERATION_IDS as OP } from './operationIds.js';

function describeToolOperation(name, args = {}) {
  const workspace = String(args.workspace || '').trim();
  const path = String(args.path || '').trim();
  const suffix = workspace ? ` in ${workspace}` : '';
  switch (name) {
    case OP.WORK_BEGIN: return workspace ? `Resolving workspace ${workspace} for a new logical task` : 'Resolving workspace for a new logical task';
    case OP.WORK_PLAN: return `Updating task plan${suffix}`;
    case OP.SNAPSHOT: return `Scanning the repository${suffix}`;
    case OP.READ: {
      const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : [];
      if (paths.length === 1) return `Reading ${paths[0]}${suffix}`;
      return `Reading ${paths.length || 'workspace'} paths${suffix}`;
    }
    case OP.SEARCH_TEXT: return `Searching for ${String(args.pattern || '').slice(0, 60) || 'a pattern'}${suffix}`;
    case OP.INSPECT: return `Inspecting code relationships${suffix}`;
    case OP.EXEC: return `Running ${redactCommandForAudit(args.command) || 'a workspace command'}${suffix}`;
    case OP.PROCESS_START: return `Starting managed process ${redactCommandForAudit(args.command) || '(unnamed)'}${suffix}`;
    case OP.PROCESS_READ: return `Reading managed process ${args.processId || ''}`.trim();
    case OP.PROCESS_WRITE: return `Sending input to managed process ${args.processId || ''}`.trim();
    case OP.PROCESS_STOP: return `Stopping managed process ${args.processId || ''}`.trim();
    case OP.PROCESS_LIST: return workspace ? `Listing managed processes in ${workspace}` : 'Listing managed processes';
    case OP.UI: return `Testing local UI (${String(args.action || 'session')})${suffix}`;
    case OP.BROWSER: return `Using local browser (${String(args.action || 'session')})${suffix}`;
    case OP.DESKTOP: return `Running structured desktop action ${String(args.action || 'operation')}${suffix}`;
    case OP.SEARCH_SEMANTIC: return `Semantically searching for ${String(args.query || '').slice(0, 60) || 'a concept'}${suffix}`;
    case OP.VALIDATE_DIAGNOSTICS: return `Running structured diagnostics${suffix}`;
    case OP.EDIT: {
      if (args.symbolEdit?.symbol) return `Editing symbol ${String(args.symbolEdit.symbol).slice(0, 80)}${suffix}`;
      if (path) return `Editing ${path}${suffix}`;
      if (Array.isArray(args.edits)) return `Applying ${args.edits.length} file edits${suffix}`;
      if (args.updateText) return `Applying a workspace patch${suffix}`;
      return `Editing the workspace${suffix}`;
    }
    case OP.CHANGES_TIDY_PLAN: return `Reviewing generated artifacts${suffix}`;
    case OP.CHANGES_TIDY_RUN: return `Removing approved generated artifacts${suffix}`;
    case OP.VALIDATE_CHECKS: return `Running ${String(args.level || 'standard')} validation${suffix}`;
    case OP.VALIDATE_HTTP: return `Probing local route ${args.route || '/'}${suffix}`;
    case OP.CHANGES_DIFF: return `Reviewing repository changes${suffix}`;
    case OP.CHANGES_CHECKPOINT: return `Checkpointing repository changes${suffix}`;
    case OP.CHANGES_REPLAY: return `Replaying a review checkpoint${suffix}`;
    case OP.CHANGES_RESTORE: return `Restoring ${Array.isArray(args.paths) ? args.paths.length : 0} tracked paths${suffix}`;
    case OP.CHANGES_RESET: return args.removeUntracked ? `Resetting and cleaning the workspace${suffix}` : `Resetting tracked workspace changes${suffix}`;
    case OP.PUBLISH_COMMIT: return `Creating a Git commit${suffix}`;
    case OP.PUBLISH_PUSH: return `Publishing the current branch${suffix}`;
    case OP.PUBLISH_DRAFT_PR: return `Preparing local pull request text${suffix}`;
    case OP.WORK_STATUS: return workspace ? `Reading workspace and repository status for ${workspace}` : 'Reading Rel.AI status';
    case OP.WORK_FINISH: return `Finalizing logical task${suffix}`;
    default: return `Running ${String(name || 'Rel.AI operation').replaceAll('.', ' ')}`;
  }
}

export { describeToolOperation };
