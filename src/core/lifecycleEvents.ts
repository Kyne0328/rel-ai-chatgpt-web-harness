import { readConfig } from '../config.js';
import { publishMcpEvent } from '../mcp/events.ts';

const TERMINAL_PROCESS_STATUSES = new Set(['exited', 'failed', 'orphaned']);
const TERMINAL_TASK_PHASES = new Set(['completed', 'cancelled', 'failed']);

function publishProcessLifecycleEvent(event: Record<string, unknown>): void {
  const status = String(event?.status || '');
  if (!TERMINAL_PROCESS_STATUSES.has(status)) return;

  const principalFingerprint = String(event.principalFingerprint || '');
  if (!principalFingerprint) return;
  void publishMcpEvent(readConfig(), {
    principalFingerprint,
    name: `process.${status}`,
    data: {
      workspace: String(event.workspace || ''),
      work_id: String(event.workId || ''),
      process_id: String(event.processId || ''),
      label: String(event.label || ''),
      status,
      exit_code: event.exitCode === undefined ? null : event.exitCode
    }
  }).catch(debugEventDelivery);
}

function publishActivityLifecycleEvent(value: unknown): void {
  const event = asRecord(value);
  const task = asRecord(event.task);
  const activityEvent = asRecord(event.activityEvent);
  const phase = String(event.phase || '');
  const status = String(task.status || activityEvent.status || '');
  const terminal = TERMINAL_TASK_PHASES.has(phase) || ['completed', 'cancelled', 'failed'].includes(status);
  const principalFingerprint = String(task.principalFingerprint || '');
  if (!terminal || !principalFingerprint) return;

  const terminalStatus = status || phase;
  const name = terminalStatus === 'completed'
    ? 'work.completed'
    : terminalStatus === 'cancelled'
      ? 'work.cancelled'
      : 'work.failed';
  void publishMcpEvent(readConfig(), {
    principalFingerprint,
    name,
    data: {
      workspace: String(task.workspace || event.workspace || ''),
      work_id: String(task.taskId || event.taskId || ''),
      status: terminalStatus,
      operation: String(event.operation || activityEvent.title || ''),
      summary: String(activityEvent.summary || event.error || task.summary || '').slice(0, 500)
    }
  }).catch(debugEventDelivery);
}

function debugEventDelivery(error: unknown): void {
  if (process.env.REL_AI_MCP_DEBUG) {
    console.error('[rel-ai-mcp] MCP Events delivery:', error instanceof Error ? error.message : String(error));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export {
  publishActivityLifecycleEvent,
  publishProcessLifecycleEvent
};
