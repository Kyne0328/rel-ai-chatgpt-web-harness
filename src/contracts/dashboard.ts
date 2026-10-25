import type { TaskActivityDto, TaskDto } from './tasks.ts';
import type { DashboardRevisions } from './events.ts';
import type { ConnectionStateDto } from './connection.ts';
import type { ManagedProcessDto } from './processes.ts';
import type { WorkspaceStateDto } from './workspaces.ts';

export const DASHBOARD_MODEL_VERSION = 4 as const;

export interface DashboardSnapshotDto {
  streamId: string;
  sequence: number;
  revision: string;
  generatedAt: string;
  modelVersion: typeof DASHBOARD_MODEL_VERSION;
}

export interface DashboardLiveMetadataDto {
  streamId: string;
  revisions: DashboardRevisions;
}

export interface DashboardPayloadDto {
  ok?: boolean;
  taskActivity: TaskActivityDto;
  tasks: TaskDto[];
  workspaceStates: Record<string, WorkspaceStateDto>;
  managedProcesses: ManagedProcessDto[];
  commandOperations?: Record<string, unknown>[];
  connectionState: ConnectionStateDto;
  snapshot: DashboardSnapshotDto;
  live?: DashboardLiveMetadataDto;
  [key: string]: unknown;
}

export function createDashboardSnapshot({ streamId, sequence, revision, generatedAt = new Date().toISOString() }: {
  streamId: string;
  sequence: number;
  revision: string;
  generatedAt?: string;
}): DashboardSnapshotDto {
  return {
    streamId: String(streamId || ''),
    sequence: Math.max(0, Number(sequence || 0)),
    revision: String(revision || ''),
    generatedAt,
    modelVersion: DASHBOARD_MODEL_VERSION
  };
}
