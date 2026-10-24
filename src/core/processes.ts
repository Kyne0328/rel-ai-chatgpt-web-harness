import { readConfig } from '../config.js';
import { readManagedProcessLogRange, sampleManagedProcessMemory, stopManagedProcess } from '../processManager.js';

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
