import type { TaskActivityDto, TaskDto } from './tasks.ts';
import type { ConnectionStateDto } from './connection.ts';
import type { ManagedProcessDto } from './processes.ts';
import type { WorkspaceStateDto } from './workspaces.ts';

export const DASHBOARD_LIVE_EVENTS = Object.freeze({
  TASK_UPDATED: 'task.updated',
  CONNECTION_UPDATED: 'connection.updated',
  WORKSPACE_UPDATED: 'workspace.updated',
  PROCESS_UPDATED: 'process.updated',
  DIAGNOSTICS_UPDATED: 'diagnostics.updated',
  DASHBOARD_ERROR: 'dashboard.error'
} as const);

export const DASHBOARD_LIVE_EVENT_TYPES = Object.freeze(Object.values(DASHBOARD_LIVE_EVENTS));
export const DASHBOARD_STREAM_DOMAINS = Object.freeze(['task', 'connection', 'workspace', 'process', 'diagnostics'] as const);

export type DashboardStreamDomain = typeof DASHBOARD_STREAM_DOMAINS[number];
export type DashboardLiveEventType = typeof DASHBOARD_LIVE_EVENTS[keyof typeof DASHBOARD_LIVE_EVENTS];

export interface DashboardRevisions {
  task: number;
  connection: number;
  workspace: number;
  process: number;
  diagnostics: number;
}

export interface DashboardLiveEnvelope {
  ok: true;
  streamId: string;
  sequence: number;
  domain: DashboardStreamDomain;
  revision: number;
  generatedAt: string;
}

export interface TaskUpdatedEvent extends DashboardLiveEnvelope {
  domain: 'task';
  taskActivity: Partial<TaskActivityDto>;
  taskUpdates: TaskDto[];
  activityEntries: Record<string, unknown>[];
}

export interface ConnectionUpdatedEvent extends DashboardLiveEnvelope {
  domain: 'connection';
  connection?: Record<string, unknown>;
  connectionState?: ConnectionStateDto;
  mcpConnection?: Record<string, unknown>;
  mcpAuthentication?: Record<string, unknown>;
  desktopStatus?: Record<string, unknown> | null;
}

export interface WorkspaceUpdatedEvent extends DashboardLiveEnvelope {
  domain: 'workspace';
  alias: string;
  state: WorkspaceStateDto;
}

export interface ProcessUpdatedEvent extends DashboardLiveEnvelope {
  domain: 'process';
  managedProcesses: ManagedProcessDto[];
  commandOperations?: Record<string, unknown>[];
}

export interface DiagnosticsUpdatedEvent extends DashboardLiveEnvelope {
  domain: 'diagnostics';
  change: Record<string, unknown>;
}

export type DashboardDomainEvent = TaskUpdatedEvent | ConnectionUpdatedEvent | WorkspaceUpdatedEvent | ProcessUpdatedEvent | DiagnosticsUpdatedEvent;

export function createEmptyDashboardRevisions(): DashboardRevisions {
  return { task: 0, connection: 0, workspace: 0, process: 0, diagnostics: 0 };
}
