import { readConfig } from '../config.js';
import { readManagedProcessLogRange, sampleManagedProcessMemory, stopManagedProcess } from '../processManager.js';
import { commandActivityControl, readCommandActivityOutput } from '../commandActivity.js';
import { controlDashboardTask } from './dashboard-actions.ts';
import { cancelFallbackExecution } from '../mcp/fallbackExecutions.js';

export async function stopCoreCommandOperation(operationId: string): Promise<Record<string, unknown>> {
  const config = readConfig();
  const command = commandActivityControl(config, operationId);
  if (command.workId) return controlDashboardTask('stop', command.workId, command.operationId);
  const stopped = cancelFallbackExecution(command.operationId, { config, expectedWorkId: '', workspace: command.workspace });
  return { ok: stopped.stopping === true || stopped.duplicate === true, stopping: stopped.stopping === true };
}

export function readCoreCommandOutput(operationId: string, options: ProcessOutputRangeOptions): Record<string, unknown> {
  return readCommandActivityOutput(readConfig(), operationId, options);
}

export function readCoreManagedProcessMemory() {
  return sampleManagedProcessMemory(readConfig(), { limit: 20 }, { internal: true });
}

type ProcessOutputStream = 'stdout' | 'stderr';

interface ProcessOutputRangeOptions {
  stream: ProcessOutputStream;
  offset?: number;
  beforeOffset?: number;
  maxBytes?: number;
}

export function stopCoreManagedProcess(processId: string, graceMs = 3000): Promise<Record<string, unknown>> {
  return stopManagedProcess(readConfig(), { processId, graceMs }) as Promise<Record<string, unknown>>;
}

export function readCoreManagedProcessOutput(
  processId: string,
  options: ProcessOutputRangeOptions
): Record<string, unknown> {
  return readManagedProcessLogRange(readConfig(), { processId, ...options }) as Record<string, unknown>;
}
