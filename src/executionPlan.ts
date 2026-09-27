import { performance } from 'node:perf_hooks';

const DEFAULT_MAX_CONCURRENCY = 4;

type ExecutionStepValue = unknown;
type ExecutionStepRunner = (context: { readonly signal: AbortSignal | undefined }) => ExecutionStepValue | Promise<ExecutionStepValue>;
type ExecutionSuccessPredicate = (value: ExecutionStepValue) => boolean;
type ExecutionPlanEvent = Readonly<Record<string, unknown>>;

interface StepOptions {
  readonly isSuccess?: ExecutionSuccessPredicate;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface GroupOptions {
  readonly maxConcurrency?: unknown;
  readonly stopOnFailure?: boolean;
}

interface StepNode {
  readonly type: 'step';
  readonly name: string;
  readonly run: ExecutionStepRunner;
  readonly isSuccess: ExecutionSuccessPredicate | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface ParallelNode {
  readonly type: 'parallel';
  readonly children: readonly ExecutionPlanNode[];
  readonly maxConcurrency: number;
  readonly stopOnFailure: boolean;
}

interface SequenceNode {
  readonly type: 'sequence';
  readonly children: readonly ExecutionPlanNode[];
  readonly maxConcurrency: 1;
  readonly stopOnFailure: boolean;
}

type ExecutionPlanNode = StepNode | ParallelNode | SequenceNode;

interface StepResult {
  readonly type: 'step';
  readonly name: string;
  readonly ok: boolean;
  readonly value?: ExecutionStepValue;
  readonly error?: unknown;
  readonly cancelled?: true;
  readonly durationMs: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface SequenceResult {
  readonly type: 'sequence';
  readonly ok: boolean;
  readonly results: readonly ExecutionNodeResult[];
}

interface ParallelResult {
  readonly type: 'parallel';
  readonly ok: boolean;
  readonly results: readonly ExecutionNodeResult[];
  readonly scheduledCount: number;
  readonly totalCount: number;
}

type ExecutionNodeResult = StepResult | SequenceResult | ParallelResult;

interface ExecutionPlanMetrics {
  readonly wallTimeMs: number;
  readonly accumulatedStepTimeMs: number;
  readonly overlapTimeMs: number;
  readonly maxConcurrentSteps: number;
  readonly stepCount: number;
  readonly parallelGroupCount: number;
  readonly completedStepCount: number;
  readonly failedStepCount: number;
}

type ExecutionPlanResult = ExecutionNodeResult & { readonly metrics: ExecutionPlanMetrics };

interface RunPlanOptions {
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ExecutionPlanEvent) => void;
}

interface ExecutionState {
  readonly signal: AbortSignal | undefined;
  readonly onEvent: ((event: ExecutionPlanEvent) => void) | null;
  active: number;
  maxActive: number;
  completed: number;
  readonly total: number;
  stepDurationMs: number;
  failedSteps: number;
}

function step(name: unknown, run: ExecutionStepRunner, options: StepOptions = {}): StepNode {
  if (typeof run !== 'function') throw new TypeError('execution plan step requires a run function');
  return Object.freeze({
    type: 'step',
    name: String(name || 'step'),
    run,
    isSuccess: typeof options.isSuccess === 'function' ? options.isSuccess : null,
    metadata: options.metadata && typeof options.metadata === 'object' ? { ...options.metadata } : {}
  });
}

function parallel(children: readonly ExecutionPlanNode[], options: GroupOptions = {}): ParallelNode {
  return group('parallel', children, {
    maxConcurrency: clampConcurrency(options.maxConcurrency),
    stopOnFailure: options.stopOnFailure === true
  });
}

function sequence(children: readonly ExecutionPlanNode[], options: GroupOptions = {}): SequenceNode {
  return group('sequence', children, {
    maxConcurrency: 1,
    stopOnFailure: options.stopOnFailure !== false
  });
}

function group(type: 'parallel', children: readonly ExecutionPlanNode[], options: { readonly maxConcurrency: number; readonly stopOnFailure: boolean }): ParallelNode;
function group(type: 'sequence', children: readonly ExecutionPlanNode[], options: { readonly maxConcurrency: 1; readonly stopOnFailure: boolean }): SequenceNode;
function group(type: 'parallel' | 'sequence', children: readonly ExecutionPlanNode[], options: { readonly maxConcurrency: number; readonly stopOnFailure: boolean }): ParallelNode | SequenceNode {
  if (!Array.isArray(children) || children.length === 0) throw new TypeError(`execution plan ${type} group requires at least one child`);
  if (type === 'parallel') return Object.freeze({ type, children: [...children], ...options });
  return Object.freeze({ type, children: [...children], maxConcurrency: 1, stopOnFailure: options.stopOnFailure });
}

async function runPlan(plan: ExecutionPlanNode, options: RunPlanOptions = {}): Promise<ExecutionPlanResult> {
  const state: ExecutionState = {
    signal: options.signal,
    onEvent: typeof options.onEvent === 'function' ? options.onEvent : null,
    active: 0,
    maxActive: 0,
    completed: 0,
    total: countSteps(plan),
    stepDurationMs: 0,
    failedSteps: 0
  };
  const started = performance.now();
  const outcome = await executeNode(plan, state);
  const wallTimeMs = performance.now() - started;
  return {
    ...outcome,
    metrics: {
      wallTimeMs: round(wallTimeMs),
      accumulatedStepTimeMs: round(state.stepDurationMs),
      overlapTimeMs: round(Math.max(0, state.stepDurationMs - wallTimeMs)),
      maxConcurrentSteps: state.maxActive,
      stepCount: state.total,
      parallelGroupCount: countGroups(plan, 'parallel'),
      completedStepCount: state.completed,
      failedStepCount: state.failedSteps
    }
  };
}

async function executeNode(node: ExecutionPlanNode, state: ExecutionState): Promise<ExecutionNodeResult> {
  if (!node || typeof node !== 'object') throw new TypeError('execution plan node is required');
  if (node.type === 'step') return executeStep(node, state);
  if (node.type === 'parallel') return executeParallel(node, state);
  if (node.type === 'sequence') return executeSequence(node, state);
  throw new TypeError(`unsupported execution plan node type '${String((node as unknown as { type?: unknown }).type)}'`);
}

async function executeStep(node: StepNode, state: ExecutionState): Promise<StepResult> {
  if (state.signal?.aborted) return cancelledStep(node, state);
  const started = performance.now();
  state.active += 1;
  state.maxActive = Math.max(state.maxActive, state.active);
  emit(state, { type: 'step_started', name: node.name, metadata: node.metadata });
  try {
    const value = await node.run({ signal: state.signal });
    const ok = node.isSuccess ? node.isSuccess(value) !== false : true;
    const durationMs = performance.now() - started;
    state.stepDurationMs += durationMs;
    state.completed += 1;
    if (!ok) state.failedSteps += 1;
    const result: StepResult = { type: 'step', name: node.name, ok, value, durationMs: round(durationMs), metadata: node.metadata };
    state.active = Math.max(0, state.active - 1);
    emit(state, Object.assign({ type: 'step_completed' }, result) as unknown as ExecutionPlanEvent);
    return result;
  } catch (error) {
    const durationMs = performance.now() - started;
    state.stepDurationMs += durationMs;
    state.completed += 1;
    state.failedSteps += 1;
    const result: StepResult = { type: 'step', name: node.name, ok: false, error, durationMs: round(durationMs), metadata: node.metadata };
    state.active = Math.max(0, state.active - 1);
    emit(state, Object.assign({ type: 'step_completed' }, result) as unknown as ExecutionPlanEvent);
    return result;
  }
}

function cancelledStep(node: StepNode, state: ExecutionState): StepResult {
  state.completed += 1;
  state.failedSteps += 1;
  const result: StepResult = {
    type: 'step',
    name: node.name,
    ok: false,
    cancelled: true,
    error: abortError(state.signal),
    durationMs: 0,
    metadata: node.metadata
  };
  emit(state, Object.assign({ type: 'step_completed' }, result) as unknown as ExecutionPlanEvent);
  return result;
}

async function executeSequence(node: SequenceNode, state: ExecutionState): Promise<SequenceResult> {
  const results: ExecutionNodeResult[] = [];
  for (const child of node.children) {
    if (state.signal?.aborted) break;
    const result = await executeNode(child, state);
    results.push(result);
    if (node.stopOnFailure && result.ok === false) break;
  }
  return { type: 'sequence', ok: results.length === node.children.length && results.every(item => item.ok !== false), results };
}

async function executeParallel(node: ParallelNode, state: ExecutionState): Promise<ParallelResult> {
  const results: Array<ExecutionNodeResult | undefined> = new Array(node.children.length);
  let nextIndex = 0;
  let stopScheduling = false;

  async function worker(): Promise<void> {
    while (!stopScheduling && !state.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= node.children.length) return;
      const child = node.children[index];
      if (!child) return;
      const result = await executeNode(child, state);
      results[index] = result;
      if (node.stopOnFailure && result.ok === false) stopScheduling = true;
    }
  }

  const workerCount = Math.min(node.maxConcurrency, node.children.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  const scheduled = results.filter((item): item is ExecutionNodeResult => item !== undefined);
  return {
    type: 'parallel',
    ok: scheduled.length === node.children.length && scheduled.every(item => item.ok !== false),
    results: scheduled,
    scheduledCount: scheduled.length,
    totalCount: node.children.length
  };
}

function emit(state: ExecutionState, event: ExecutionPlanEvent): void {
  if (!state.onEvent) return;
  try {
    state.onEvent({
      ...event,
      active: state.active,
      completed: state.completed,
      total: state.total
    });
  } catch {
    // Observability must never break execution.
  }
}

function countSteps(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const candidate = node as { type?: unknown; children?: unknown };
  if (candidate.type === 'step') return 1;
  if (Array.isArray(candidate.children)) return candidate.children.reduce((sum, child) => sum + countSteps(child), 0);
  return 0;
}

function countGroups(node: unknown, type: 'parallel' | 'sequence'): number {
  if (!node || typeof node !== 'object') return 0;
  const candidate = node as { type?: unknown; children?: unknown };
  const own = candidate.type === type ? 1 : 0;
  if (!Array.isArray(candidate.children)) return own;
  return own + candidate.children.reduce((sum, child) => sum + countGroups(child, type), 0);
}

function clampConcurrency(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(numeric));
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Execution plan cancelled.');
  error.name = 'AbortError';
  return error;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export { parallel, runPlan, sequence, step };
