import { principalFingerprint } from '../mcp/principal.ts';
import { onToolActivity, taskError } from '../toolActivity.js';
import { sanitizeDisplayText } from '../taskObservability.js';

const TERMINAL_TASK_PHASES = new Set(['completed', 'cancelled', 'inactive']);

interface AutomationWorkspace {
  readonly alias: string;
}

interface AutomationArgs {
  readonly work_id?: unknown;
}

interface AutomationContext {
  readonly taskId?: unknown;
  readonly principal?: unknown;
}

interface AutomationAttribution {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly principalFingerprint: string;
}

function taskIdFor(args: AutomationArgs = {}, context: AutomationContext = {}): string {
  return String(context.taskId || args.work_id || '').trim();
}

function createAutomationAttribution(
  workspace: AutomationWorkspace,
  args: AutomationArgs = {},
  context: AutomationContext = {}
): AutomationAttribution {
  return Object.freeze({
    workspaceId: workspace.alias,
    taskId: taskIdFor(args, context),
    principalFingerprint: principalFingerprint(context.principal)
  });
}

function assertAutomationAttribution(
  expected: AutomationAttribution,
  workspace: AutomationWorkspace,
  args: AutomationArgs = {},
  context: AutomationContext = {},
  options: Readonly<{ resource?: 'ui' | 'browser'; ignoreTask?: boolean }> = {}
): void {
  const browser = options.resource === 'browser';
  const codePrefix = browser ? 'BROWSER_SESSION' : 'UI_SESSION';
  const label = browser ? 'Local browser session' : 'UI test session';
  if (expected.workspaceId !== workspace.alias) {
    throw taskError(`${codePrefix}_WORKSPACE_MISMATCH`, `${label} belongs to a different workspace.`);
  }
  if (expected.principalFingerprint !== principalFingerprint(context.principal)) {
    throw taskError(`${codePrefix}_PRINCIPAL_MISMATCH`, `${label} belongs to a different authenticated client.`);
  }
  const taskId = taskIdFor(args, context);
  if (options.ignoreTask !== true && taskId && expected.taskId && taskId !== expected.taskId) {
    throw taskError(`${codePrefix}_TASK_MISMATCH`, `The supplied work_id does not match this ${browser ? 'local browser' : 'UI'} session attribution.`);
  }
}

function registerTerminalTaskCleanup(cleanup: (taskId: string) => Promise<unknown> | unknown): () => void {
  const reportFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error || 'Unknown cleanup failure');
    console.error('[rel-ai-mcp] automatic automation cleanup failed:', sanitizeDisplayText(message, 500));
  };
  return onToolActivity((activity: {
    phase?: unknown;
    taskId?: unknown;
    task?: { taskId?: unknown; id?: unknown };
  }) => {
    if (!TERMINAL_TASK_PHASES.has(String(activity?.phase || ''))) return;
    const taskId = String(activity?.taskId || activity?.task?.taskId || activity?.task?.id || '').trim();
    if (!taskId) return;
    try {
      // Invoke immediately so terminal events revoke public use synchronously.
      void Promise.resolve(cleanup(taskId)).catch(reportFailure);
    } catch (error) {
      reportFailure(error);
    }
  });
}

export { assertAutomationAttribution, createAutomationAttribution, registerTerminalTaskCleanup, taskIdFor };
export type { AutomationAttribution, AutomationContext, AutomationWorkspace };
