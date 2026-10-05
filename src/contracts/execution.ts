import type { ProcessExit } from './processes.ts';

export interface ExecutionRequestBase {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly work_id?: string;
}

export interface ShellExecutionRequest extends ExecutionRequestBase {
  readonly command: string;
  readonly executable?: never;
  readonly argv?: never;
  readonly input?: never;
}

export interface DirectExecutionRequest extends ExecutionRequestBase {
  readonly command?: never;
  readonly executable: string;
  readonly argv?: readonly string[];
  readonly input?: string;
}

export type ExecutionRequest = ShellExecutionRequest | DirectExecutionRequest;

export type MutationTrackingMode = 'git' | 'filesystem' | 'declared-read-only' | 'unavailable';

export interface ExecutionResult extends ProcessExit {
  readonly ok: true;
  readonly executed: true;
  readonly commandSucceeded: boolean;
  readonly workspace: string;
  readonly command: string;
  readonly commandSummary: string;
  readonly cwd: string;
  readonly shell: string;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutOutputRef?: string;
  readonly stdoutSpillTruncated?: boolean;
  readonly stderrOutputRef?: string;
  readonly stderrSpillTruncated?: boolean;
  readonly error?: string;
  readonly environmentKeys?: readonly string[];
  readonly changedFiles: readonly string[];
  readonly ephemeralChangedFiles?: readonly string[];
  readonly changedFilesTruncated: boolean;
  readonly mutationTracking: MutationTrackingMode;
  readonly mutationUnknown?: true;
}
