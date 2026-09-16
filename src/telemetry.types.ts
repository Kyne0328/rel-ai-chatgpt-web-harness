export const PERFORMANCE_PHASES = Object.freeze([
  'mcp.authorization',
  'mcp.receive',
  'mcp.protocol',
  'mcp.manifest',
  'mcp.dispatch',
  'serialization',
  'transport.write',
  'tool.queue',
  'tool.session',
  'tool.execution',
  'repo.index_refresh',
  'repo.lookup',
  'process.setup',
  'process.spawn',
  'process.persistence',
  'process.readiness',
  'desktop.configuration',
  'desktop.local_service',
  'desktop.readiness',
  'desktop.tunnel'
] as const);

export type PerformancePhase = typeof PERFORMANCE_PHASES[number];
export type PerformancePhaseDurations = Partial<Record<PerformancePhase, number>>;
export type PerformancePhaseCounts = Partial<Record<PerformancePhase, number>>;

export interface PerformanceBreakdownSnapshot {
  totalMs: number;
  phaseMs: PerformancePhaseDurations;
  counts: PerformancePhaseCounts;
}

export interface PerformanceSnapshotInput {
  totalMs?: unknown;
  phaseMs?: unknown;
  counts?: unknown;
}

export interface PerformanceBreakdownRecorder {
  add(name: unknown, durationMs: unknown): boolean;
  measure<T>(name: unknown, operation: () => T | Promise<T>): Promise<T>;
  measureSync<T>(name: unknown, operation: () => T): T;
  snapshot(): PerformanceBreakdownSnapshot;
}

export interface PerformanceBreakdownOptions {
  now?: () => number;
}

export const ANALYTICS_OUTCOME_CLASSES = Object.freeze({
  SUCCESS: 'success',
  OPERATION_FAILURE: 'operation_failure',
  RECOVERABLE_FAILURE: 'recoverable_failure',
  UNCLASSIFIED_FAILURE: 'unclassified_failure',
  INFRASTRUCTURE_FAILURE: 'infrastructure_failure',
  CANCELLED: 'cancelled'
} as const);

export type AnalyticsOutcome = typeof ANALYTICS_OUTCOME_CLASSES[keyof typeof ANALYTICS_OUTCOME_CLASSES];

export const ANALYTICS_FAILURE_CATEGORIES = Object.freeze([
  'cancelled',
  'timeout',
  'authorization',
  'capacity',
  'transport',
  'policy',
  'workspace',
  'git',
  'process',
  'validation',
  'task',
  'stale',
  'search',
  'desktop',
  'app',
  'internal',
  'unclassified'
] as const);

export type AnalyticsFailureCategory = typeof ANALYTICS_FAILURE_CATEGORIES[number];

export interface ObservabilityResultInput {
  ok?: unknown;
  operationName?: unknown;
  tool?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}

export interface ReliabilityCounters {
  reliabilityCalls: number;
  reliableCalls: number;
  infrastructureFailures: number;
  operationFailures: number;
  recoverableFailures: number;
  cancellations: number;
}

export interface LocalToolOutcomeEvent extends ObservabilityResultInput {
  workspace?: unknown;
  taskIntent?: unknown;
  durationMs?: unknown;
  at?: unknown;
  timings?: { phaseMs?: unknown } | null;
  performancePhases?: unknown;
  [key: string]: unknown;
}

export interface ExecutionPlanMetrics {
  wallTimeMs?: unknown;
  accumulatedStepTimeMs?: unknown;
  overlapTimeMs?: unknown;
  maxConcurrentSteps?: unknown;
  stepCount?: unknown;
  parallelGroupCount?: unknown;
  completedStepCount?: unknown;
  failedStepCount?: unknown;
}

export interface TelemetryConfig {
  telemetry?: {
    enabled?: boolean;
    endpoint?: unknown;
    sampleRatio?: unknown;
  };
}

export interface TelemetryStatus {
  enabled: boolean;
  initialized: boolean;
  exporter: '' | 'otlp-http';
  endpointConfigured: boolean;
  endpoint: '' | '[configured]';
  sampleRatio: number;
}
