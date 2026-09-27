

import { commandDisplayForInvocation, redactCommandForAudit } from '../commandDisplay.js';
import { OPERATION_IDS as OP } from './operationIds.js';

function cleanText(value, maxLength = 80) {
  const str = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!str) return '';
  return str.length <= maxLength ? str : `${str.slice(0, maxLength - 1).trimEnd()}…`;
}

function describeToolOperation(name, args = {}) {
  const workspace = String(args.workspace || '').trim();
  const path = String(args.path || '').trim();
  const suffix = workspace ? ` in ${workspace}` : '';
  switch (name) {
    case OP.WORK_BEGIN: {
      const title = cleanText(args.title, 60);
      if (title) return `Starting task "${title}"${suffix}`;
      return `Starting logical task${suffix}`;
    }
    case OP.WORK_PLAN: return `Updating task plan${suffix}`;
    case OP.WORK_CONTEXT: return `Loading task context${suffix}`;
    case OP.SNAPSHOT: return `Inspecting repository overview${suffix}`;
    case OP.READ: {
      if (args.skill) return `Reading skill "${cleanText(args.skill, 60)}"${suffix}`;
      if (args.outputRef) return `Reading output ${cleanText(args.outputRef, 60)}${suffix}`;
      if (Array.isArray(args.ranges) && args.ranges.length) {
        return `Reading ${args.ranges.length} range${args.ranges.length === 1 ? '' : 's'}${suffix}`;
      }
      const paths = Array.isArray(args.paths) ? args.paths.filter(Boolean) : path ? [path] : [];
      if (paths.length === 1) return `Reading ${paths[0]}${suffix}`;
      if (paths.length > 1) return `Reading ${paths.length} files${suffix}`;
      return `Reading repository files${suffix}`;
    }
    case OP.SEARCH_TEXT: {
      const pattern = cleanText(args.pattern, 60);
      if (pattern) return `Searching for "${pattern}"${suffix}`;
      const queries = Array.isArray(args.queries) ? args.queries.map(q => cleanText(q, 40)).filter(Boolean) : [];
      if (queries.length === 1) return `Searching for "${queries[0]}"${suffix}`;
      if (queries.length > 1) {
        const preview = queries.slice(0, 2).map(q => `"${q}"`).join(', ');
        const extra = queries.length > 2 ? ` (+${queries.length - 2} more)` : '';
        return `Searching for ${queries.length} queries: ${preview}${extra}${suffix}`;
      }
      return `Searching repository text${suffix}`;
    }
    case OP.SEARCH_SEMANTIC: {
      const query = cleanText(args.query, 60);
      if (query) return `Searching code for "${query}"${suffix}`;
      const queries = Array.isArray(args.queries) ? args.queries.map(q => cleanText(q, 40)).filter(Boolean) : [];
      if (queries.length === 1) return `Searching code for "${queries[0]}"${suffix}`;
      if (queries.length > 1) return `Searching code for ${queries.length} queries${suffix}`;
      return `Searching code semantically${suffix}`;
    }
    case OP.INSPECT: {
      const action = cleanText(args.action, 40);
      const symbol = cleanText(args.symbol || args.query, 60);
      if (action === 'definition') return symbol ? `Finding definition of ${symbol}${suffix}` : `Finding definition${suffix}`;
      if (action === 'references') return symbol ? `Finding references to ${symbol}${suffix}` : `Finding references${suffix}`;
      if (action === 'symbol') return symbol ? `Inspecting symbol ${symbol}${suffix}` : `Inspecting symbol${suffix}`;
      if (action === 'diagnostics') return `Inspecting code diagnostics${suffix}`;
      if (action === 'architecture') return `Analyzing code architecture${suffix}`;
      if (action === 'impact') return symbol ? `Analyzing impact of ${symbol}${suffix}` : `Analyzing code impact${suffix}`;
      if (action === 'trace') return symbol ? `Tracing dependencies for ${symbol}${suffix}` : `Tracing dependencies${suffix}`;
      if (action === 'audit') return `Auditing code quality${suffix}`;
      return `Inspecting code relationships${suffix}`;
    }
    case OP.EXEC: {
      const display = commandDisplayForInvocation(args);
      return `Running ${display ? redactCommandForAudit(display) : 'workspace command'}${suffix}`;
    }
    case OP.PROCESS_START: {
      const label = cleanText(args.label, 60);
      if (label) return `Starting managed process "${label}"${suffix}`;
      const display = commandDisplayForInvocation(args);
      return `Starting managed process ${display ? redactCommandForAudit(display) : ''}${suffix}`.trim();
    }
    case OP.PROCESS_READ: return `Reading managed process ${args.processId || ''}`.trim();
    case OP.PROCESS_WRITE: return `Sending input to managed process ${args.processId || ''}`.trim();
    case OP.PROCESS_STOP: return `Stopping managed process ${args.processId || ''}`.trim();
    case OP.PROCESS_LIST: return workspace ? `Listing managed processes in ${workspace}` : 'Listing managed processes';
    case OP.UI: return `Testing local UI (${String(args.action || 'session')})${suffix}`;
    case OP.BROWSER: return `Using local browser (${String(args.action || 'session')})${suffix}`;
    case OP.DESKTOP: return `Running structured desktop action ${String(args.action || 'operation')}${suffix}`;
    case OP.COMPUTER: return `Controlling computer (${String(args.action || 'action')})${suffix}`;
    case OP.VALIDATE_DIAGNOSTICS: return `Running structured diagnostics${suffix}`;
    case OP.EDIT: {
      if (args.symbolEdit?.symbol) return `Editing symbol ${String(args.symbolEdit.symbol).slice(0, 80)}${suffix}`;
      if (path) return `Editing ${path}${suffix}`;
      if (Array.isArray(args.edits) && args.edits.length) return `Applying edits to ${args.edits.length} files${suffix}`;
      if (args.updateText) return `Applying workspace patch${suffix}`;
      return `Editing workspace files${suffix}`;
    }
    case OP.CHANGES_TIDY_PLAN: return `Planning workspace cleanup${suffix}`;
    case OP.CHANGES_TIDY_RUN: return `Applying workspace cleanup${suffix}`;
    case OP.VALIDATE_CHECKS: {
      if (args.check) return `Running check: ${cleanText(args.check, 60)}${suffix}`;
      if (Array.isArray(args.checks) && args.checks.length === 1) return `Running check: ${cleanText(args.checks[0], 60)}${suffix}`;
      if (Array.isArray(args.checks) && args.checks.length > 1) return `Running ${args.checks.length} validation checks${suffix}`;
      return `Running ${String(args.level || 'standard')} validation${suffix}`;
    }
    case OP.VALIDATE_HTTP: return `Probing local route ${args.route || '/'}${suffix}`;
    case OP.CHANGES_DIFF: return `Reviewing repository changes${suffix}`;
    case OP.CHANGES_CHECKPOINT: return `Checkpointing repository review${suffix}`;
    case OP.CHANGES_REPLAY: return `Replaying review checkpoint${suffix}`;
    case OP.CHANGES_RESTORE: {
      const count = Array.isArray(args.paths) ? args.paths.length : 0;
      return `Restoring ${count} tracked path${count === 1 ? '' : 's'}${suffix}`;
    }
    case OP.CHANGES_RESET: return args.removeUntracked ? `Resetting and cleaning workspace${suffix}` : `Resetting tracked changes${suffix}`;
    case OP.PUBLISH_COMMIT: return `Creating Git commit${suffix}`;
    case OP.PUBLISH_PUSH: return `Publishing Git branch${suffix}`;
    case OP.PUBLISH_DRAFT_PR: return `Preparing draft pull request${suffix}`;
    case OP.WORK_STATUS: {
      if (args.work_id) return `Checking task status for ${cleanText(args.work_id, 30)}${suffix}`;
      return workspace ? `Checking repository status for ${workspace}` : 'Checking workspace status';
    }
    case OP.WORK_STOP: return `Stopping running task operations${suffix}`;
    case OP.WORK_CANCEL: return `Cancelling task session${suffix}`;
    case OP.WORK_FINISH: return `Completing task session${suffix}`;
    default: return `Running ${String(name || 'Rel.AI operation').replaceAll('.', ' ')}`;
  }
}

export { describeToolOperation };
