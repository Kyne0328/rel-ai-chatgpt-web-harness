export const CANONICAL_TASK_STATUSES = Object.freeze([
  'queued',
  'planning',
  'running',
  'waiting_for_approval',
  'blocked',
  'validating',
  'validation_failed',
  'inactive',
  'completed',
  'failed',
  'cancelled'
] as const);

export const NATIVE_TASK_STATUSES = Object.freeze([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled'
] as const);

export const TASK_ACTIVITY_STATES = Object.freeze(['idle', 'working', 'waiting', 'settling'] as const);

export type TaskStatus = typeof CANONICAL_TASK_STATUSES[number];
export type TaskState = TaskStatus;
export type NativeTaskStatus = typeof NATIVE_TASK_STATUSES[number];
export type TaskActivityState = typeof TASK_ACTIVITY_STATES[number];

export interface TaskTransition {
  readonly from: TaskState;
  readonly to: TaskState;
}

export interface TaskProgressDto {
  current?: number;
  total?: number;
  percent?: number;
  label?: string;
  [key: string]: unknown;
}

export type TaskPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped';

export interface TaskPlanStepDto {
  id: string;
  title: string;
  status: TaskPlanStepStatus;
  detail?: string;
}

export interface TaskPlanDto {
  revision: number;
  steps: TaskPlanStepDto[];
}

export interface TaskDto {
  id: string;
  taskId?: string;
  sessionId?: string;
  scopeId?: string;
  title?: string;
  objective?: string;
  contextSummary?: string;
  intent?: string;
  workspace?: string;
  status: TaskStatus;
  state?: string;
  completionKnown?: boolean;
  progress?: TaskProgressDto;
  plan?: TaskPlanDto;
  activeCalls?: number;
  calls?: number;
  toolCallCount?: number;
  successfulToolCallCount?: number;
  failedToolCallCount?: number;
  failures?: number;
  changedFiles?: string[];
  changedFileCount?: number;
  currentStage?: string;
  currentActivity?: string;
  tool?: string;
  lastTool?: string;
  operation?: string;
  lastOperation?: string;
  lastOutcome?: string;
  errorSummary?: string;
  createdAt?: string;
  startedAt?: number | string | null;
  startedAtIso?: string;
  updatedAt?: string;
  lastActivityAt?: number | string | null;
  endedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  currentOperations?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface TaskActivityDto {
  state: TaskActivityState;
  revision?: number;
  activeConnectorCalls?: number;
  activeCalls: number;
  activeTaskCount: number;
  tasks: TaskDto[];
  taskId: string;
  workspace: string;
  tool: string;
  operation?: string;
  completionKnown?: boolean;
  startedAt: number | string | null;
  lastTask: TaskDto | null;
  [key: string]: unknown;
}

export function createEmptyTaskActivity(): TaskActivityDto {
  return {
    state: 'idle',
    activeCalls: 0,
    activeTaskCount: 0,
    tasks: [],
    taskId: '',
    workspace: '',
    tool: '',
    startedAt: null,
    lastTask: null
  };
}
