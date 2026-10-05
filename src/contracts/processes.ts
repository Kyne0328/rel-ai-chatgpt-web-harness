export type ProcessState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'exited'
  | 'failed'
  | 'orphaned';

export type ManagedProcessStatus = ProcessState | (string & {});

export interface ProcessExit {
  readonly exitCode: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly terminationConfirmed?: boolean;
  readonly forcedTermination?: boolean;
}

export interface ManagedProcessDto {
  ok: boolean;
  processId: string;
  pid: number | null;
  workspace: string;
  workspaceId: string;
  label: string;
  kind: string;
  purpose: string;
  commandSummary: string;
  cwd: string;
  status: ManagedProcessStatus;
  metadataRevision: string;
  lifecycle: 'persistent' | 'task';
  terminationConfirmed?: boolean | null;
  rootExitConfirmed?: boolean;
  terminationError?: string;

  workSessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutRetainedFromOffset: number;
  stderrRetainedFromOffset: number;
  environmentKeys: string[];
  pty?: true;
  columns?: number;
  rows?: number;
  error?: string;
  stdoutTail?: string;
  stderrTail?: string;
  [key: string]: unknown;
}

export interface ManagedProcessListDto {
  ok: true;
  processes: ManagedProcessDto[];
  count: number;
}

export function createManagedProcessList(processes: ManagedProcessDto[]): ManagedProcessListDto {
  const items = Array.isArray(processes) ? processes : [];
  return { ok: true, processes: items, count: items.length };
}
