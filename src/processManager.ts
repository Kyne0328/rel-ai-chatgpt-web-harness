import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { combineAbortSignals, isTimeoutAbort } from './abortSignals.ts';
import { createManagedProcessList, type ManagedProcessDto, type ProcessState } from './contracts/processes.ts';
import { readJsonFile, writeJsonAtomic, writeJsonAtomicAsync } from './durableState.ts';
import { normalizeExecutionInvocation, resolveCommandCwd, normalizeCommandEnv } from './executionInvocation.ts';
import { redactCommandForAudit } from './commandDisplay.ts';
import { isProcessTreeAlive, readProcessCreationIdentity, terminateProcessTree, type ProcessTreeTerminationResult } from './process.ts';
import { prepareWindowsProcessJob, restoreWindowsProcessJob, type WindowsProcessJob } from './windowsProcessJob.ts';
import { makeProcessEnvironment } from './processEnvironment.js';
import { extensionCommandPathEntries } from './extensions/paths.js';
import { createHttpPrincipal, principalFingerprint } from './mcp/principal.ts';
import { getStateDir } from './statePaths.js';
import { readTaskHistorySession } from './taskHistoryStore.ts';
import { runSpan, addSpanEvent, traceContextEnvironment } from './telemetry.ts';
import { measurePerformancePhase, measurePerformancePhaseSync } from './performanceObservability.ts';
import type { TelemetryConfig } from './telemetry.types.ts';
import { getCurrentTaskAbortSignal, taskError } from './toolActivity.js';
import { isActiveProcessStatus, isTerminalProcessStatus, normalizeProcessLifecycleStatus } from './runtimeLifecycle.js';
import { HOST_PERSISTENT_PROCESS_LIMIT, acquireHostResource, acquireHostResources, hostResourceStats, hostResourceDiagnosticSnapshot } from './hostResourceScheduler.js';
import { publishProcessLifecycleEvent } from './core/lifecycleEvents.ts';
import { sanitizeDisplayText } from './taskObservability.js';

type LogStream = 'stdout' | 'stderr';
type ProcessLifetime = 'persistent' | 'task';
type StartupWaitResult = 'ready' | 'closed' | 'aborted';
type InitialProcessState =
  | { readonly type: 'spawned' }
  | { readonly type: 'aborted' }
  | { readonly type: 'error'; readonly error: Error }
  | { readonly type: 'closed'; readonly code: number | null; readonly signal: string };

type GenericRecord = Record<string, unknown>;

interface ManagedWorkspace {
  readonly alias: string;
  readonly path: string;
}

interface ManagedProcessConfig extends GenericRecord, TelemetryConfig {
  readonly processEnvironment?: { readonly allow?: unknown };
}

interface ManagedProcessArgs extends GenericRecord {
  readonly kind?: unknown;
  readonly purpose?: unknown;
  readonly lifecycle?: unknown;
  readonly pty?: unknown;
  readonly columns?: unknown;
  readonly rows?: unknown;
  readonly cwd?: unknown;
  readonly env?: unknown;
  readonly work_id?: unknown;

  readonly reuseExisting?: unknown;
  readonly label?: unknown;
  readonly maxLogBytes?: unknown;
  readonly startupWaitMs?: unknown;
  readonly processId?: unknown;
  readonly maxBytes?: unknown;
  readonly includeMetadata?: unknown;
  readonly metadataRevision?: unknown;
  readonly stdoutOffset?: unknown;
  readonly stderrOffset?: unknown;
  readonly input?: unknown;
  readonly graceMs?: unknown;
  readonly workspace?: unknown;
  readonly status?: unknown;
  readonly includeTerminal?: unknown;
  readonly terminalOnly?: unknown;
  readonly activeOnly?: unknown;
  readonly includeTail?: unknown;
  readonly includeTailOffsets?: unknown;
  readonly tailBytes?: unknown;
  readonly limit?: unknown;
  readonly taskId?: unknown;
}

interface ManagedProcessContext extends GenericRecord {
  readonly taskId?: unknown;

  readonly signal?: AbortSignal;
  readonly principal?: unknown;
  readonly workspace?: unknown;
  readonly connector?: boolean;
  readonly internal?: boolean;
  readonly mcp?: { readonly authInfo?: unknown };
  readonly authInfo?: unknown;
  readonly authMode?: unknown;
  readonly coordinationTimeoutMs?: unknown;
}

interface PtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number | string;
}

interface PtyWorker {
  _destroySocket?(): Promise<void> | void;
  dispose?(): void;
}

interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: PtyExitEvent) => void): unknown;
  write(value: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  readonly _agent?: { readonly _conoutSocketWorker?: PtyWorker };
}

interface LogSource {
  pause?(): unknown;
  resume?(): unknown;
  readonly destroyed?: boolean;
}

interface NodePtyApi {
  spawn(executable: string, argv: readonly string[], options: GenericRecord): PtyProcess;
}

interface HostResourceLease {
  readonly waitMs: number;
  release(): void;
  releaseResource?(resourceClass: string): void;
}

interface ManagedProcessRecord extends GenericRecord {
  schemaVersion: number;
  runtimeId: string;
  processId: string;
  workspaceId: string;
  workspacePath: string;

  workSessionId: string;
  principalKey: string;
  reuseFingerprint: string;
  lifecycle: ProcessLifetime;
  terminationConfirmed: boolean | null;
  rootExitConfirmed: boolean;
  terminationError: string;
  stopPromise: Promise<ManagedProcessDto & GenericRecord> | null;
  terminationInProgress: boolean;
  kind: string;
  purpose: string;
  command?: string;
  commandSummary: string;
  label: string;
  diagnosticLabel: string;
  cwd: string;
  status: ProcessState;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  signal: string;
  error?: string;
  pid?: number | null;
  processCreationIdentity: string;
  restartIdentityVerified: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  stdoutStartOffset: number;
  stderrStartOffset: number;
  stdoutPath: string;
  stderrPath: string;
  environmentKeys: string[];
  child: ChildProcess | null;
  windowsJob?: WindowsProcessJob | null;
  windowsJobDirectory?: string;
  windowsJobOwned?: boolean;
  windowsRootPid?: number;
  windowsRootCreationIdentity?: string;
  ptyProcess: PtyProcess | null;
  pty: boolean;
  columns: number;
  rows: number;
  ptyExitPromise: Promise<PtyExitEvent> | null;
  resolvePtyExit: ((event: PtyExitEvent) => void) | null;
  maxLogBytes: number;
  persistTimer: NodeJS.Timeout | null;
  logBuffers: Record<LogStream, Buffer[]>;
  logBufferBytes: Record<LogStream, number>;
  logPendingBytes: Record<LogStream, number>;
  logPaused: Record<LogStream, boolean>;
  logSources: Record<LogStream, LogSource | null>;
  logFlushTimers: Record<LogStream, NodeJS.Timeout | null>;
  logWritePromises: Record<LogStream, Promise<void>>;
  persistenceFailureHandled: boolean;
  discarded: boolean;
  hostResourceRelease: (() => void) | null;
  queueWaitMs: number;
  lastPtyInputAtMs: number;
  lastPtyOutputAtMs: number;
  lastPtyResizeAtMs: number;
  readonly ptyLaunchCwd: string;
  readonly ptyLaunchColumns: number;
  ptyWrappedStartupEligible: boolean;
  ptyStartupSettled: boolean;
  ptyActivitySeq: number;
  ptyLastInputSeq: number;
  ptyLastOutputSeq: number;
  idleRetireTimer: NodeJS.Timeout | null;
}

interface ProcessSnapshotOptions {
  readonly includeTail?: boolean;
  readonly includeTailOffsets?: boolean;
  readonly tailBytes?: number;
}

interface ManagedProcessLogRangeArgs extends GenericRecord {
  readonly processId?: unknown;
  readonly stream?: unknown;
  readonly offset?: unknown;
  readonly beforeOffset?: unknown;
  readonly maxBytes?: unknown;
}

interface ProcessAccessOptions {
  readonly requireSession?: boolean;
}

interface InteractivePtyRetirementGuard {
  readonly activitySeq: number;
  readonly idleMs: number;
}

interface StopRecordOptions {
  readonly graceMs?: unknown;
  readonly forceWaitMs?: unknown;
  readonly automaticPtyRetirement?: InteractivePtyRetirementGuard;
}

interface ManagedProcessEvent {
  readonly revision: number;
  readonly processId: string;
  readonly status: string;
}

type ManagedProcessListener = (event: ManagedProcessEvent) => void;

interface ReuseFingerprintInput {
  readonly workspaceId?: unknown;
  readonly workSessionId?: unknown;
  readonly principalKey?: unknown;
  readonly executionMode?: unknown;
  readonly command?: unknown;
  readonly input?: unknown;
  readonly cwd?: unknown;
  readonly kind?: unknown;
  readonly purpose?: unknown;
  readonly lifecycle?: ProcessLifetime;
  readonly pty?: boolean;
  readonly columns?: unknown;
  readonly rows?: unknown;
  readonly environment?: readonly (readonly [unknown, unknown])[];
}

interface LogRange {
  readonly requestedOffset: number;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalBytes: number;
  readonly retainedFromOffset: number;
  readonly truncatedBefore: boolean;
  readonly truncated: boolean;
  readonly text: string;
  readonly encoding: 'utf8';
  readonly invalidUtf8?: true;
  readonly base64?: string;
}

const PROCESS_SCHEMA_VERSION = 4;
const RUNTIME_ID = crypto.randomUUID();
const RECENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_STARTUP_WAIT_MS = 750;
const DEFAULT_PROCESS_COORDINATION_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 3000;
const DEFAULT_FORCE_WAIT_MS = 2000;
const TASK_CLEANUP_BUDGET_MS = 10_000;
const TASK_CLEANUP_CONCURRENCY = 2;
const METADATA_FLUSH_DELAY_MS = 50;
const METADATA_RESCAN_INTERVAL_MS = 30_000;
const METADATA_PRUNE_INTERVAL_MS = 60_000;
const LOG_FLUSH_DELAY_MS = 10;
const LOG_FLUSH_MAX_BYTES = 64 * 1024;
const LOG_PENDING_HIGH_WATER_BYTES = 1024 * 1024;
const LOG_PENDING_LOW_WATER_BYTES = 256 * 1024;
const DEFAULT_INTERACTIVE_PTY_IDLE_RETIRE_MS = 60_000;
const CAPACITY_PRESSURE_PTY_IDLE_MS = 15_000;
const MAX_WRAPPED_STARTUP_PROMPT_BYTES = 4096;
const ACTIVE_STATUSES = Object.freeze({ has: isActiveProcessStatus });
const TERMINAL_STATUSES = Object.freeze({ has: isTerminalProcessStatus });
const processes = new Map<string, ManagedProcessRecord>();
const metadataScanAt = new Map<string, number>();
const metadataPruneAt = new Map<string, number>();
const metadataWriteQueues = new Map<string, Promise<boolean>>();
const processStateListeners = new Set<ManagedProcessListener>();
const processReuseReservations = new Map<string, Promise<void>>();
let processStateVersion = 0;
let nodePtyPromise: Promise<NodePtyApi> | null = null;
let restoredCapacityReservation: Promise<void> = Promise.resolve();

function processRoot(config: ManagedProcessConfig): string {
  return path.join(getStateDir(config), 'processes');
}

function processDirectory(config: ManagedProcessConfig, processId: unknown): string {
  return path.join(processRoot(config), validateProcessId(processId));
}

function validateProcessId(processId: unknown): string {
  const value = String(processId || '').trim();
  if (!/^proc_[A-Za-z0-9_-]{20,160}$/.test(value)) throw new Error('Invalid processId.');
  return value;
}

async function startManagedProcess(workspace: ManagedWorkspace, config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}) {
  const invocation = normalizeExecutionInvocation(args, 'relai_process start');
  const kind = String(args.kind || '').trim().toLowerCase();
  if (!['service', 'watcher', 'interactive'].includes(kind)) {
    throw new Error('relai_process action "start" requires kind: service, watcher, or interactive. Use relai_exec or relai_validate with action "checks" for one-shot commands.');
  }
  const purpose = String(args.purpose || '').trim();
  if (!purpose) throw new Error('relai_process action "start" requires a persistent-process purpose.');
  if (purpose.length > 300) throw new Error('relai_process action "start" purpose must be 300 characters or fewer.');
  const pty = args.pty === true;
  if (pty && kind !== 'interactive') throw new Error('PTY mode is only available for kind: interactive.');
  if (!pty && (args.columns !== undefined || args.rows !== undefined)) throw new Error('columns and rows require pty:true.');
  const columns = clampNumber(args.columns, 1, 1000, 80);
  const rows = clampNumber(args.rows, 1, 1000, 24);
  const cwd = resolveCommandCwd(workspace, args.cwd, 'relai_process start');
  const env = normalizeCommandEnv(args.env, 'relai_process start');
  const workSessionId = String(context.taskId || args.work_id || '').trim();
  const lifecycle = String(args.lifecycle ?? 'persistent').trim().toLowerCase();
  if (lifecycle !== 'persistent' && lifecycle !== 'task') {
    throw new Error('relai_process start lifecycle must be persistent or task.');
  }
  if (lifecycle === 'task' && (!workSessionId
    || (context.connector === true && String(context.taskId || '').trim() !== workSessionId))) {
    throw taskError('PROCESS_TASK_LIFETIME_REQUIRES_WORK_ID', 'Task-lifetime processes require an active owning work_id.');
  }
  if (args.work_id && context.taskId && String(args.work_id).trim() !== String(context.taskId).trim()) {
    throw taskError('PROCESS_SESSION_MISMATCH', 'The supplied work_id does not match the active process owner.');
  }

  if (lifecycle === 'task') {
    const requestedTask = asRecord(context.requestTaskContext);
    const requestedSession = asRecord(requestedTask.session);
    const boundWorkspace = String(requestedTask.taskId || '') === workSessionId
      ? String(requestedSession.workspace || '').trim()
      : workSessionWorkspace(config, workSessionId);
    if (!boundWorkspace || !sameWorkspaceReference(boundWorkspace, workspace.alias)) {
      throw taskError('PROCESS_TASK_WORKSPACE_REQUIRED', 'Task-lifetime processes require a durable work_id already bound to this workspace. Begin a work session with this workspace, or use the default persistent lifecycle.');
    }
  }

  const principalKey = principalKeyForContext(context);
  const environmentKeys = Object.keys(env).sort();
  const reuseFingerprint = managedProcessReuseFingerprint({
    workspaceId: workspace.alias,
    workSessionId,
    principalKey,
    executionMode: invocation.command ? 'shell' : 'direct',
    command: invocation.displayCommand,
    input: invocation.input || '',
    cwd: cwd.relativePath,
    kind,
    purpose,
    lifecycle,
    pty,
    columns,
    rows,
    environment: Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
  });
  const admissionSignal = combineAbortSignals(context.signal, getCurrentTaskAbortSignal());
  const coordinationTimeoutMs = clampNumber(
    context.coordinationTimeoutMs,
    10,
    60_000,
    DEFAULT_PROCESS_COORDINATION_TIMEOUT_MS
  );
  const coordinationController = new AbortController();
  const coordinationTimer = setTimeout(() => {
    coordinationController.abort(processCoordinationTimeoutError(coordinationTimeoutMs));
  }, coordinationTimeoutMs);
  coordinationTimer.unref?.();
  const coordinationSignal = combineAbortSignals(admissionSignal, coordinationController.signal);
  let releaseReuseReservation: (() => void) | null = null;
  const startupReservation: { release: (() => void) | null } = { release: null };
  try {
    releaseReuseReservation = args.reuseExisting === false
      ? null
      : await acquireManagedProcessReuseReservation(reuseFingerprint, coordinationSignal);
    admissionSignal?.throwIfAborted?.();
    hydrateProcessMetadata(config);
    const reusable = args.reuseExisting === false ? null : findReusableManagedProcess(reuseFingerprint);
    if (reusable) {
      return {
        ...processSnapshot(reusable, { includeTail: true, tailBytes: 8192 }),
        reused: true,
        readiness: {
          verified: reusable.status === 'running',
          observedAt: new Date().toISOString(),
          waitedMs: 0,
          status: reusable.status,
          stdoutBytes: reusable.stdoutBytes,
          stderrBytes: reusable.stderrBytes
        }
      };
    }
    await reserveRestoredManagedProcessCapacity(config, coordinationSignal);
  const processId = `proc_${crypto.randomBytes(24).toString('base64url')}`;
  const directory = processDirectory(config, processId);
  const stdoutPath = path.join(directory, 'stdout.log');
  const stderrPath = path.join(directory, 'stderr.log');
  const record: ManagedProcessRecord = {
    schemaVersion: PROCESS_SCHEMA_VERSION,
    runtimeId: RUNTIME_ID,
    processId,
    workspaceId: workspace.alias,
    workspacePath: workspace.path,

    workSessionId,
    principalKey,
    reuseFingerprint,
    lifecycle,
    terminationConfirmed: null,
    rootExitConfirmed: false,
    terminationError: '',
    stopPromise: null,
    terminationInProgress: false,
    kind,
    purpose,
    command: invocation.displayCommand,
    commandSummary: redactCommandForAudit(invocation.displayCommand),
    label: String(args.label || '').trim().slice(0, 120) || redactCommandForAudit(invocation.displayCommand),
    diagnosticLabel: sanitizeDisplayText(String(args.label || '').trim(), 120),
    cwd: cwd.relativePath,
    status: 'starting',
    startedAt: new Date().toISOString(),
    endedAt: '',
    exitCode: null,
    signal: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    stdoutStartOffset: 0,
    stderrStartOffset: 0,
    stdoutPath,
    stderrPath,
    environmentKeys,
    pid: null,
    processCreationIdentity: '',
    restartIdentityVerified: true,
    child: null,
    ptyProcess: null,
    pty,
    columns,
    rows,
    ptyExitPromise: null,
    resolvePtyExit: null,
    maxLogBytes: clampNumber(args.maxLogBytes, 65536, 256 * 1024 * 1024, DEFAULT_MAX_LOG_BYTES),
    persistTimer: null,
    logBuffers: { stdout: [], stderr: [] },
    logBufferBytes: { stdout: 0, stderr: 0 },
    logPendingBytes: { stdout: 0, stderr: 0 },
    logPaused: { stdout: false, stderr: false },
    logSources: { stdout: null, stderr: null },
    logFlushTimers: { stdout: null, stderr: null },
    logWritePromises: { stdout: Promise.resolve(), stderr: Promise.resolve() },
    persistenceFailureHandled: false,
    discarded: false,
    hostResourceRelease: null,
    queueWaitMs: 0,
    lastPtyInputAtMs: Date.now(),
    lastPtyOutputAtMs: Date.now(),
    lastPtyResizeAtMs: 0,
    ptyLaunchCwd: cwd.absolutePath,
    ptyLaunchColumns: columns,
    ptyWrappedStartupEligible: false,
    ptyStartupSettled: false,
    ptyActivitySeq: 0,
    ptyLastInputSeq: 0,
    ptyLastOutputSeq: 0,
    idleRetireTimer: null
  };

  try {
    measurePerformancePhaseSync('process.persistence', () => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(stdoutPath, '', { mode: 0o600 });
      fs.writeFileSync(stderrPath, '', { mode: 0o600 });
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`Could not initialize managed process storage: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  return await runSpan(config, 'relai.process.start', {
    'relai.workspace': workspace.alias,
    'relai.process.command': record.command,
    'relai.process.pty': pty
  }, async () => {
    const { childEnvironment, startupSignal } = measurePerformancePhaseSync('process.setup', () => {
      const childEnvironment = makeProcessEnvironment(env, {
        allow: config.processEnvironment?.allow,
        pathAppend: extensionCommandPathEntries(config)
      });
      Object.assign(childEnvironment, traceContextEnvironment());
      record.ptyWrappedStartupEligible = record.pty && !invocation.command
        && permitsWrappedCmdStartup(invocation.processExecutable, invocation.processArgv, childEnvironment);
      const startupSignal = admissionSignal;
      return { childEnvironment, startupSignal };
    });
    let child: ChildProcess | undefined;
    let initialState: Promise<InitialProcessState>;
    try {
      let resourceLease: HostResourceLease;
      try {
        await retireIdleInteractivePtysForCapacity(config);
        resourceLease = await acquireHostResources(['persistent', 'heavy'], workspace.alias, {
          signal: coordinationSignal
        });
        startupReservation.release = () => resourceLease.releaseResource?.('heavy');
        clearTimeout(coordinationTimer);
      } catch (error) {
        if (errorCode(error) === 'HOST_RESOURCE_ABORTED') {
          if (!admissionSignal?.aborted && coordinationController.signal.aborted) {
            throw coordinationController.signal.reason;
          }
          throw cancellationError('Managed process startup was cancelled while waiting for host capacity.');
        }
        if (errorCode(error) === 'HOST_RESOURCE_QUEUE_TIMEOUT') {
          const blocker = managedStartupBlocker();
          const stats = blocker.stats;
          throw Object.assign(
            new Error(`Managed process startup for '${workspace.alias}' remained queued. ${blocker.message}`),
            {
              code: 'HOST_PROCESS_CAPACITY_EXHAUSTED',
              retryable: true,
              blockedResource: blocker.resource,
              active: Number(stats?.active || 0),
              limit: Number(stats?.limit || HOST_PERSISTENT_PROCESS_LIMIT),
              queued: Number(stats?.queued || 0)
            }
          );
        }
        throw error;
      }
      record.hostResourceRelease = resourceLease.release;
      record.queueWaitMs = resourceLease.waitMs;
      if (process.platform === 'win32') {
        record.windowsJob = await prepareWindowsProcessJob(config, {
          executable: invocation.processExecutable, args: invocation.processArgv,
          cwd: cwd.absolutePath, env: childEnvironment
        }, directory);
        record.windowsJobDirectory = path.basename(record.windowsJob.directory);
        record.windowsJobOwned = true;
      }
      if (startupSignal?.aborted) throw cancellationError('Managed process startup was cancelled before native launch.');
      const processExecutable = record.windowsJob?.executable || invocation.processExecutable;
      const processArgv = record.windowsJob?.args || invocation.processArgv;
      if (record.pty) {
        const ptyProcess = await measurePerformancePhase('process.spawn', async () => {
          const nodePty = await loadNodePty();
          if (startupSignal?.aborted) throw cancellationError('Managed process startup was cancelled before PTY launch.');
          return nodePty.spawn(processExecutable, processArgv, {
            name: String(process.env.TERM || 'xterm-256color'),
            cwd: cwd.absolutePath,
            env: record.windowsJob?.environment || childEnvironment,
            cols: record.columns,
            rows: record.rows,
            ...(process.platform === 'win32' ? { useConpty: false } : {})
          });
        });
        record.ptyProcess = ptyProcess;
        record.pid = ptyProcess.pid || null;
        record.windowsJob?.bind(record.pid);
        record.status = record.windowsJob ? 'starting' : 'running';
        record.ptyExitPromise = new Promise<PtyExitEvent>(resolve => { record.resolvePtyExit = resolve; });
        ptyProcess.onData(data => {
          record.ptyLastOutputSeq = ++record.ptyActivitySeq;
          record.lastPtyOutputAtMs = Date.now();
          appendLog(config, record, 'stdout', data);
          scheduleInteractivePtyRetirement(config, record);
        });
        ptyProcess.onExit(event => {
          record.resolvePtyExit?.(event);
          finishRecord(config, record, {
            status: record.status === 'stopping' ? 'stopped' : (event.exitCode === 0 ? 'exited' : 'failed'),
            exitCode: Number.isInteger(event.exitCode) ? event.exitCode : -1,
            signal: event.signal ? String(event.signal) : ''
          });
        });
        initialState = record.windowsJob ? observeWindowsJobStartup(record.windowsJob, startupSignal) : Promise.resolve({ type: 'spawned' });
        addSpanEvent('process.spawned', { 'process.pid': record.pid || 0, 'process.pty': true });
      } else {
        child = measurePerformancePhaseSync('process.spawn', () => spawn(processExecutable, processArgv, {
          cwd: cwd.absolutePath,
          env: record.windowsJob?.environment || childEnvironment,
          detached: process.platform !== 'win32',
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        }));
        record.child = child;
        record.logSources.stdout = child.stdout || null;
        record.logSources.stderr = child.stderr || null;
        record.pid = child.pid || null;
        record.windowsJob?.bind(record.pid);
        initialState = record.windowsJob ? observeWindowsJobStartup(record.windowsJob, startupSignal) : observeInitialProcessState(child, startupSignal);
        child.stdout?.on('data', chunk => appendLog(config, record, 'stdout', chunk));
        child.stderr?.on('data', chunk => appendLog(config, record, 'stderr', chunk));
        child.once('spawn', () => {
          if (record.status !== 'starting' || record.windowsJob) return;
          record.status = 'running';
          safePersistMetadata(config, record);
          notifyProcessState(record);
          addSpanEvent('process.spawned', { 'process.pid': record.pid || 0 });
        });
        child.once('error', error => finishRecord(config, record, {
          status: 'failed',
          exitCode: -1,
          error: error.message
        }));
        child.once('close', (code, signal) => finishRecord(config, record, {
          status: record.status === 'stopping' ? 'stopped' : (code === 0 ? 'exited' : 'failed'),
          exitCode: typeof code === 'number' ? code : -1,
          signal: signal || ''
        }));
      }
    } catch (error) {
      releaseManagedProcessResource(record);
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }

    processes.set(processId, record);
    notifyProcessState(record);

    try {
      measurePerformancePhaseSync('process.persistence', () => persistMetadata(config, record));
    } catch (error) {
      record.persistenceFailureHandled = true;
      clearScheduledPersist(record);
      record.terminationInProgress = true;
      const outcome = await terminateManagedRecord(record, { graceMs: 0, forceWaitMs: DEFAULT_FORCE_WAIT_MS })
        .catch(() => ({ exited: false, forced: false }));
      record.terminationInProgress = false;
      record.terminationConfirmed = outcome.exited;
      if (outcome.exited) {
        record.discarded = true;
        releaseManagedProcessResource(record);
        record.child = null;
        record.ptyProcess = null;
        processes.delete(processId);
        fs.rmSync(directory, { recursive: true, force: true });
      } else {
        record.status = 'orphaned';
        record.endedAt = '';
        record.terminationError = 'Startup persistence failed and descendant termination could not be confirmed.';
        record.error = record.terminationError;
        // Keep the in-memory identity and any recoverable on-disk evidence.
        try { persistMetadata(config, record); } catch {}
        notifyProcessState(record);
      }
      throw Object.assign(new Error(`Could not persist managed process record: ${error instanceof Error ? error.message : String(error)}`, { cause: error }), {
        processId, terminationConfirmed: outcome.exited
      });
    }

    const initial = await measurePerformancePhase('process.readiness', () => initialState);
    if (initial.type === 'aborted') {
      await stopRecordInternal(config, record, { graceMs: DEFAULT_STOP_GRACE_MS }).catch(() => null);
      throw Object.assign(taskError(isTimeoutAbort(startupSignal) ? 'TIMEOUT' : 'TASK_CANCELLED',
        'Managed process startup was interrupted. Inspect the process before starting it again.'), {
        processId, cancelled: !isTimeoutAbort(startupSignal), timedOut: isTimeoutAbort(startupSignal),
        terminationConfirmed: record.terminationConfirmed === true,
        cleanupPending: record.terminationConfirmed !== true, retryable: false
      });
    }
    if (initial.type === 'error') {
      await cleanupFailedStartup(config, record);
      throw new Error(`Could not start managed process: ${initial.error?.message || 'spawn failed'}`);
    }
    if (initial.type === 'closed') {
      await cleanupFailedStartup(config, record);
      throw new Error(`Managed process exited during startup with code ${initial.code ?? -1}.`);
    }
    if (record.windowsJob && record.status === 'starting') {
      record.status = 'running';
      safePersistMetadata(config, record);
      notifyProcessState(record);
    }
    const nativeRoot = record.windowsJob?.receipt();
    if (Number.isSafeInteger(nativeRoot?.rootPid) && Number(nativeRoot?.rootPid) > 0) record.windowsRootPid = Number(nativeRoot?.rootPid);
    if (/^win32:\d{1,20}$/.test(String(nativeRoot?.rootCreationIdentity || ''))) record.windowsRootCreationIdentity = String(nativeRoot?.rootCreationIdentity);
    if (record.pid) {
      record.processCreationIdentity = await readProcessCreationIdentity(record.pid);
      if (record.processCreationIdentity) {
        try {
          persistMetadata(config, record);
        } catch (error) {
          await cleanupFailedStartup(config, record);
          throw new Error(`Could not persist managed process creation identity: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
      }
    }

    if (invocation.input !== undefined) {
      try {
        notePtyInputAttempt(record);
        await writeInitialProcessInput(record, invocation.input, startupSignal);
      } catch (error) {
        const cleanup = await cleanupFailedStartup(config, record)
          .catch(() => ({ exited: record.terminationConfirmed === true }));
        throw Object.assign(error instanceof Error ? error : new Error('Could not send initial managed process input.', { cause: error }), {
          processId, terminationConfirmed: cleanup.exited, cleanupPending: !cleanup.exited, retryable: false
        });
      }
    }

    const startupWaitMs = clampNumber(args.startupWaitMs, 0, 30000, DEFAULT_STARTUP_WAIT_MS);
    const startupResult = await measurePerformancePhase(
      'process.readiness',
      () => waitDuringStartup(record, startupWaitMs, startupSignal)
    );
    if (startupResult === 'aborted') {
      await stopRecordInternal(config, record, { graceMs: DEFAULT_STOP_GRACE_MS }).catch(() => null);
      throw Object.assign(taskError(isTimeoutAbort(startupSignal) ? 'TIMEOUT' : 'TASK_CANCELLED',
        'Managed process startup was interrupted. Inspect the process before starting it again.'), {
        processId, cancelled: !isTimeoutAbort(startupSignal), timedOut: isTimeoutAbort(startupSignal),
        terminationConfirmed: record.terminationConfirmed === true,
        cleanupPending: record.terminationConfirmed !== true, retryable: false
      });
    }
    if (startupResult === 'closed') {
      await cleanupFailedStartup(config, record);
      throw new Error(`Managed process exited during startup with code ${record.exitCode ?? -1}.`);
    }

    record.ptyStartupSettled = true;
    scheduleInteractivePtyRetirement(config, record);
    return {
      ...processSnapshot(record, { includeTail: true, tailBytes: 8192 }),
      reused: false,
      queueWaitMs: record.queueWaitMs || 0,
      readiness: {
        verified: record.status === 'running',
        observedAt: new Date().toISOString(),
        waitedMs: startupWaitMs,
        status: record.status,
        stdoutBytes: record.stdoutBytes,
        stderrBytes: record.stderrBytes
      }
    };
  });
  } finally {
    clearTimeout(coordinationTimer);
    startupReservation.release?.();
    releaseReuseReservation?.();
  }
}

async function observeWindowsJobStartup(job: WindowsProcessJob, signal?: AbortSignal): Promise<InitialProcessState> {
  try {
    const receipt = await job.waitStarted(signal);
    return receipt.commandStarted === true
      ? { type: 'spawned' }
      : { type: 'error', error: new Error(receipt.error || 'Native job setup refused the managed target before execution.') };
  } catch (error) {
    return signal?.aborted ? { type: 'aborted' } : { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function observeInitialProcessState(child: ChildProcess, signal?: AbortSignal): Promise<InitialProcessState> {
  return new Promise(resolve => {
    let settled = false;
    const onSpawn = () => finish({ type: 'spawned' });
    const onError = (error: Error) => finish({ type: 'error', error });
    const onClose = (code: number | null, childSignal: NodeJS.Signals | null) => finish({ type: 'closed', code, signal: childSignal || '' });
    const onAbort = () => finish({ type: 'aborted' });

    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('close', onClose);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });

    function finish(result: InitialProcessState): void {
      if (settled) return;
      settled = true;
      child.off?.('spawn', onSpawn);
      child.off?.('error', onError);
      child.off?.('close', onClose);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    }
  });
}

function waitDuringStartup(record: ManagedProcessRecord, waitMs: number, signal?: AbortSignal): Promise<StartupWaitResult> {
  if (signal?.aborted) return Promise.resolve('aborted');
  if (!ACTIVE_STATUSES.has(record.status)) return Promise.resolve('closed');
  if (waitMs <= 0) return Promise.resolve('ready');
  if (record.pty) return waitDuringPtyStartup(record, waitMs, signal);
  return new Promise(resolve => {
    let settled = false;
    const onClose = () => finish('closed');
    const onAbort = () => finish('aborted');
    const timer = setTimeout(() => finish('ready'), waitMs);
    record.child?.once?.('close', onClose);
    signal?.addEventListener?.('abort', onAbort, { once: true });

    function finish(result: StartupWaitResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record.child?.off?.('close', onClose);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    }
  });
}

function waitDuringPtyStartup(record: ManagedProcessRecord, waitMs: number, signal?: AbortSignal): Promise<StartupWaitResult> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish('ready'), waitMs);
    const onAbort = () => finish('aborted');
    signal?.addEventListener?.('abort', onAbort, { once: true });
    record.ptyExitPromise?.then(() => finish('closed'));
    function finish(result: StartupWaitResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve(result);
    }
  });
}

function managedProcessInputError(record: ManagedProcessRecord, signal: AbortSignal | undefined, invoked: boolean, queuedBytes?: number, cause?: unknown): Error {
  const timedOut = isTimeoutAbort(signal);
  const cancelled = signal?.aborted === true && !timedOut;
  const detail = invoked
    ? 'Input delivery is unknown. Inspect the process before sending more input; do not automatically resend.'
    : 'No input was submitted.';
  return Object.assign(taskError(timedOut ? 'TIMEOUT' : cancelled ? 'TASK_CANCELLED' : 'PROCESS_INPUT_FAILED',
    `Managed process input ${timedOut ? 'timed out' : cancelled ? 'was cancelled' : 'failed'}. ${detail}`), {
    processId: record.processId,
    ...(invoked ? {} : { acceptedBytes: 0 }),
    ...(queuedBytes !== undefined ? { inputQueuedBytes: queuedBytes } : {}),
    inputDeliveryUnknown: invoked,
    ...(cancelled ? { cancelled: true } : {}),
    ...(timedOut ? { timedOut: true } : {}),
    terminationConfirmed: record.terminationConfirmed,
    retryable: false,
    ...(cause !== undefined ? { cause } : {})
  });
}

function writeInitialProcessInput(record: ManagedProcessRecord, input: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw managedProcessInputError(record, signal, false);
  if (record.pty) {
    if (!record.ptyProcess || !['starting', 'running'].includes(record.status)) {
      throw managedProcessInputError(record, signal, false);
    }
    try {
      record.ptyProcess.write(input);
    } catch (cause) {
      // The PTY API may have accepted input before throwing.
      throw managedProcessInputError(record, signal, true, undefined, cause);
    }
    return Promise.resolve();
  }
  const stream = record.child?.stdin;
  if (!stream || stream.destroyed || !['starting', 'running'].includes(record.status)) {
    throw managedProcessInputError(record, signal, false);
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let invoked = false;
    let queuedBytes: number | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(managedProcessInputError(record, signal, invoked, queuedBytes));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      invoked = true;
      stream.write(input, error => {
        if (settled) return;
        finish(error ? managedProcessInputError(record, signal, true, queuedBytes, error) : undefined);
      });
      // A false write return still means queued, not consumed by the target.
      queuedBytes = Buffer.byteLength(input, 'utf8');
    } catch (cause) {
      finish(managedProcessInputError(record, signal, invoked, queuedBytes, cause));
    }
    // Cancellation settles only this waiter. The shared process and stream
    // remain owned by their existing lifecycle; a late callback is harmless.
  });
}

function appendLog(config: ManagedProcessConfig, record: ManagedProcessRecord, stream: LogStream, chunk: Buffer | string): void {
  if (record.discarded || record.persistenceFailureHandled) return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  // node-pty does not expose a pause/resume API. Bound its persistence queue
  // explicitly and report omitted bytes while retaining the ordered prefix and
  // tail already accepted by the log writer.
  const source = record.logSources[stream];
  if (record.pty && (!source || typeof source.pause !== 'function')
    && record.logPendingBytes[stream] >= LOG_PENDING_HIGH_WATER_BYTES) {
    const droppedKey = stream === 'stdout' ? 'stdoutDroppedBytes' : 'stderrDroppedBytes';
    record[droppedKey] = Number(record[droppedKey] || 0) + buffer.length;
    scheduleMetadataPersist(config, record);
    return;
  }
  record.logBuffers[stream].push(buffer);
  record.logBufferBytes[stream] += buffer.length;
  record.logPendingBytes[stream] += buffer.length;
  if (record.logBufferBytes[stream] >= LOG_FLUSH_MAX_BYTES) {
    flushLogBuffer(config, record, stream);
  }
  else scheduleLogFlush(config, record, stream);
  pauseLogSourceIfNeeded(record, stream);
}

function pauseLogSourceIfNeeded(record: ManagedProcessRecord, stream: LogStream): void {
  if (record.logPaused[stream] || record.logPendingBytes[stream] < LOG_PENDING_HIGH_WATER_BYTES) return;
  const source = record.logSources[stream];
  if (!source || typeof source.pause !== 'function') return;
  record.logPaused[stream] = true;
  source.pause();
}

function resumeLogSourceIfReady(record: ManagedProcessRecord, stream: LogStream): void {
  if (!record.logPaused[stream] || record.logPendingBytes[stream] > LOG_PENDING_LOW_WATER_BYTES) return;
  const source = record.logSources[stream];
  record.logPaused[stream] = false;
  if (source && !source.destroyed && typeof source.resume === 'function') source.resume();
}

function resumeLogSources(record: ManagedProcessRecord): void {
  for (const stream of ['stdout', 'stderr'] as const) {
    if (!record.logPaused[stream]) continue;
    const source = record.logSources[stream];
    record.logPaused[stream] = false;
    if (source && !source.destroyed && typeof source.resume === 'function') source.resume();
  }
}

function scheduleLogFlush(config: ManagedProcessConfig, record: ManagedProcessRecord, stream: LogStream): void {
  if (record.logFlushTimers[stream] || record.discarded || record.persistenceFailureHandled) return;
  record.logFlushTimers[stream] = setTimeout(() => {
    record.logFlushTimers[stream] = null;
    flushLogBuffer(config, record, stream);
  }, LOG_FLUSH_DELAY_MS);
  record.logFlushTimers[stream].unref?.();
}

function flushLogBuffer(config: ManagedProcessConfig, record: ManagedProcessRecord, stream: LogStream): Promise<void> {
  clearScheduledLogFlush(record, stream);
  const chunks = record.logBuffers[stream];
  if (!chunks.length) return record.logWritePromises[stream];
  const buffer = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, record.logBufferBytes[stream]);
  record.logBuffers[stream] = [];
  record.logBufferBytes[stream] = 0;
  const file = stream === 'stdout' ? record.stdoutPath : record.stderrPath;
  const totalKey = `${stream}Bytes`;
  const startKey = `${stream}StartOffset`;
  record.logWritePromises[stream] = record.logWritePromises[stream]
    .then(async () => {
      if (record.discarded) return;
      const nextTotalBytes = Number(record[totalKey] || 0) + buffer.length;
      await fs.promises.appendFile(file, buffer);
      const nextStartOffset = await trimLog(record, stream, nextTotalBytes);
      record[totalKey] = nextTotalBytes;
      if (nextStartOffset != null) record[startKey] = nextStartOffset;
      scheduleMetadataPersist(config, record);
    })
    .catch(error => {
      handlePersistenceFailure(config, record, error);
    })
    .finally(() => {
      const pendingBefore = record.logPendingBytes[stream];
      record.logPendingBytes[stream] = Math.max(0, pendingBefore - buffer.length);
      resumeLogSourceIfReady(record, stream);
      if (stream === 'stdout' && pendingBefore > 0 && record.logPendingBytes.stdout === 0
        && record.logBufferBytes.stdout === 0 && record.logBuffers.stdout.length === 0) {
        scheduleInteractivePtyRetirement(config, record);
      }
    });
  return record.logWritePromises[stream];
}

async function trimLog(record: ManagedProcessRecord, stream: LogStream, totalBytes: number): Promise<number | null> {
  const file = stream === 'stdout' ? record.stdoutPath : record.stderrPath;
  const stat = await fs.promises.stat(file);
  if (stat.size <= record.maxLogBytes) return null;
  const keep = Math.max(1, Math.floor(record.maxLogBytes * 0.75));
  const buffer = Buffer.allocUnsafe(keep);
  const handle = await fs.promises.open(file, 'r');
  try {
    await handle.read(buffer, 0, keep, stat.size - keep);
  } finally {
    await handle.close();
  }
  await fs.promises.writeFile(file, buffer, { mode: 0o600 });
  return Math.max(0, Number(totalBytes || 0) - keep);
}

function clearScheduledLogFlush(record: ManagedProcessRecord, stream: LogStream): void {
  const timer = record.logFlushTimers?.[stream];
  if (!timer) return;
  clearTimeout(timer);
  record.logFlushTimers[stream] = null;
}

function clearScheduledLogFlushes(record: ManagedProcessRecord): void {
  clearScheduledLogFlush(record, 'stdout');
  clearScheduledLogFlush(record, 'stderr');
}

async function drainLogWrites(config: ManagedProcessConfig, record: ManagedProcessRecord): Promise<void> {
  flushLogBuffer(config, record, 'stdout');
  flushLogBuffer(config, record, 'stderr');
  await Promise.all([record.logWritePromises.stdout, record.logWritePromises.stderr]);
}

async function flushManagedProcessPersistence(config: ManagedProcessConfig, record: ManagedProcessRecord): Promise<void> {
  clearScheduledPersist(record);
  await drainLogWrites(config, record);
  if (record.discarded || record.persistenceFailureHandled) return;
  await queueMetadataPersist(config, record);
}

function readManagedProcess(config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}) {
  const record = requireProcess(config, args.processId);
  assertProcessAccess(config, record, args, context, { requireSession: false });
  const maxBytes = clampNumber(args.maxBytes, 1000, 1024 * 1024, 65536);
  const revision = processMetadataRevision(record);
  const includeMetadata = args.includeMetadata !== false
    && String(args.metadataRevision || '') !== revision;
  const output = {
    stdout: readLogRange(record, 'stdout', args.stdoutOffset, maxBytes),
    stderr: readLogRange(record, 'stderr', args.stderrOffset, maxBytes)
  };
  if (!includeMetadata) {
    return {
      ok: !['failed', 'orphaned'].includes(record.status),
      processId: record.processId,
      status: record.status,
      metadataRevision: revision,
      ...output
    };
  }
  return { ...processSnapshot(record), ...output };
}

function readManagedProcessLogRange(
  config: ManagedProcessConfig,
  args: ManagedProcessLogRangeArgs = {},
  context: ManagedProcessContext = {}
) {
  const record = requireProcess(config, args.processId);
  assertProcessAccess(config, record, args, context, { requireSession: false });
  const stream = String(args.stream || '').trim();
  if (stream !== 'stdout' && stream !== 'stderr') throw new Error('Process output stream must be stdout or stderr.');
  const maxBytes = clampNumber(args.maxBytes, 1000, 1024 * 1024, 256 * 1024);
  let range: LogRange;
  if (args.beforeOffset !== undefined) {
    const totalBytes = Number(record[`${stream}Bytes`] || 0);
    const retainedFromOffset = Number(record[`${stream}StartOffset`] || 0);
    const requestedBefore = Number(args.beforeOffset);
    const beforeOffset = Number.isFinite(requestedBefore)
      ? Math.min(totalBytes, Math.max(retainedFromOffset, Math.floor(requestedBefore)))
      : totalBytes;
    const startOffset = Math.max(retainedFromOffset, beforeOffset - maxBytes);
    range = readLogRange(record, stream, startOffset, Math.max(0, beforeOffset - startOffset));
  } else {
    range = readLogRange(record, stream, args.offset, maxBytes);
  }
  return {
    ok: !['failed', 'orphaned'].includes(record.status),
    processId: record.processId,
    status: record.status,
    stream,
    range
  };
}

async function writeManagedProcess(config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}) {
  const record = requireProcess(config, args.processId);
  assertProcessAccess(config, record, args, context);
  if (!['starting', 'running'].includes(record.status)) throw new Error(`Process ${record.processId} is not accepting input.`);
  const hasInput = args.input !== undefined;
  const hasResize = args.columns !== undefined || args.rows !== undefined;
  if (!hasInput && !hasResize) throw new Error('relai_process action "write" requires input or PTY columns+rows.');
  const input = hasInput ? String(args.input ?? '') : '';
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > 1024 * 1024) throw new Error('Process input exceeds 1 MiB.');
  if (hasInput && record.pty) {
    notePtyInputAttempt(record);
    scheduleInteractivePtyRetirement(config, record);
  }
  const inputSignal = combineAbortSignals(context.signal, getCurrentTaskAbortSignal());
  if (inputSignal?.aborted) throw managedProcessInputError(record, inputSignal, false);
  if (hasResize) {
    if (!record.pty || !record.ptyProcess) throw new Error('PTY resize requires a running pty:true process.');
    if (args.columns === undefined || args.rows === undefined) throw new Error('PTY resize requires both columns and rows.');
    const columns = clampNumber(args.columns, 1, 1000, record.columns || 80);
    const rows = clampNumber(args.rows, 1, 1000, record.rows || 24);
    record.ptyWrappedStartupEligible = false;
    record.ptyActivitySeq += 1;
    record.lastPtyResizeAtMs = Date.now();
    scheduleInteractivePtyRetirement(config, record);
    record.ptyProcess.resize(columns, rows);
    record.columns = columns;
    record.rows = rows;
    await queueMetadataPersist(config, record);
    notifyProcessState(record);
  }
  if (hasInput) {
    try {
      await writeInitialProcessInput(record, input, inputSignal);
    } catch (error) {
      if (hasResize && error instanceof Error) error.message += ' The PTY resize was already applied.';
      throw error;
    }
  }
  return {
    ok: true,
    processId: record.processId,
    acceptedBytes: bytes,
    status: record.status,
    ...(hasResize ? { resized: true, columns: record.columns, rows: record.rows } : {})
  };
}

async function stopManagedProcess(config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}) {
  const record = requireProcess(config, args.processId);
  assertProcessAccess(config, record, args, context, { requireSession: false });
  const duplicate = TERMINAL_STATUSES.has(record.status)
    && ((record.lifecycle !== 'task' && !record.windowsJobOwned) || record.terminationConfirmed === true);
  if (!duplicate && (record.runtimeId !== RUNTIME_ID || record.rootExitConfirmed || (!record.child && !record.ptyProcess))) {
    const identity = await verifyRestoredProcessIdentity(config, record);
    if (identity === 'mismatch' || identity === 'unverified') throw restoredProcessIdentityError(record, identity);
  }
  if (!duplicate) {
    await stopRecordInternal(config, record, {
      graceMs: clampNumber(args.graceMs, 0, 30000, DEFAULT_STOP_GRACE_MS)
    });
  }
  return {
    ...processSnapshot(record, { includeTail: true, tailBytes: 8192 }),
    duplicate
  };
}

function stopRecordInternal(config: ManagedProcessConfig, record: ManagedProcessRecord, options: StopRecordOptions = {}): Promise<ManagedProcessDto & GenericRecord> {
  if (record.stopPromise) return record.stopPromise;
  if (options.automaticPtyRetirement) {
    if (!canAutomaticallyRetirePty(record, options.automaticPtyRetirement)) {
      return Promise.resolve(processSnapshot(record));
    }
    // Commit admission without yielding or callbacks before reserving the owner.
    // An explicit stop must never coalesce with a rejected automatic no-op.
    record.status = 'stopping';
  }
  const pending = Promise.resolve().then(() => stopRecordWithEvidence(config, record, options));
  record.stopPromise = pending;
  void pending.finally(() => {
    if (record.stopPromise === pending) record.stopPromise = null;
  }).catch(() => {});
  return pending;
}

async function stopRecordWithEvidence(config: ManagedProcessConfig, record: ManagedProcessRecord, options: StopRecordOptions) {
  record.status = 'stopping';
  safePersistMetadata(config, record);
  notifyProcessState(record);
  const outcome = await terminateManagedRecord(record, {
    graceMs: clampNumber(options.graceMs, 0, 30000, DEFAULT_STOP_GRACE_MS),
    forceWaitMs: clampNumber(options.forceWaitMs, 0, 30000, DEFAULT_FORCE_WAIT_MS)
  }).catch(error => ({
    exited: false, forced: false, error: error instanceof Error ? error.message : String(error)
  }));
  record.terminationConfirmed = outcome.exited;
  record.terminationError = outcome.exited ? '' : outcome.error || 'Managed process descendant termination could not be confirmed.';

  if (!outcome.exited) {
    // Retain identity, capacity ownership, and evidence for explicit recovery.
    // Root exit or pipe closure is never sufficient tree-exit evidence.
    record.status = 'orphaned';
    record.endedAt = '';
    record.error = record.terminationError;
    safePersistMetadata(config, record);
    notifyProcessState(record);
  } else {
    if (!record.persistenceFailureHandled) record.error = '';
    finishRecord(config, record, {
      status: 'stopped',
      exitCode: typeof record.exitCode === 'number' ? record.exitCode : -1,
      signal: record.signal || (outcome.forced ? 'SIGKILL' : 'SIGTERM')
    });
  }
  await flushManagedProcessPersistence(config, record);
  return processSnapshot(record);
}

function listManagedProcesses(config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}) {
  hydrateProcessMetadata(config);
  pruneManagedProcesses(config);
  const requestedWorkspace = resolveCallerWorkspace(config, args, context);
  assertRequestedWorkspaceBoundary(config, args, context, requestedWorkspace);
  const status = String(args.status || '').trim();
  const explicitTerminalStatus = TERMINAL_STATUSES.has(status);
  const terminalOnly = args.terminalOnly === true;
  const includeTerminal = args.includeTerminal === true || terminalOnly || explicitTerminalStatus;
  const activeOnly = !terminalOnly && args.activeOnly !== false && !includeTerminal;
  const items = [...processes.values()]
    .filter(item => canAccessProcess(config, item, args, context, { requireSession: false }))
    .filter(item => !requestedWorkspace || workspaceMatches(item, requestedWorkspace))
    .filter(item => !status || item.status === status)
    .filter(item => !activeOnly || ACTIVE_STATUSES.has(item.status) || item.status === 'orphaned')
    .filter(item => !terminalOnly || TERMINAL_STATUSES.has(item.status))
    .filter(item => includeTerminal || !TERMINAL_STATUSES.has(item.status))
    .sort((left, right) => terminalOnly
      ? Date.parse(String(right.endedAt || right.startedAt || '')) - Date.parse(String(left.endedAt || left.startedAt || ''))
      : Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, clampNumber(args.limit, 1, 500, 100))
    .map(item => processSnapshot(item, args.includeTail === true
      ? {
          includeTail: true,
          includeTailOffsets: args.includeTailOffsets === true,
          tailBytes: clampNumber(args.tailBytes, 1024, 64 * 1024, 8192)
        }
      : {}));
  return createManagedProcessList(items);
}

interface ManagedRootMemoryTarget {
  readonly processId: string;
  readonly pid: number | null;
  readonly identity: string;
}

interface ManagedRootMemoryObservation {
  readonly privateBytes: number | null;
  readonly workingSetBytes: number | null;
  readonly sampledAt: string | null;
  readonly identityVerified: boolean;
  readonly reason: string | null;
}

interface ManagedRootMemoryCacheEntry {
  readonly atMs: number;
  readonly observations: ReadonlyMap<string, ManagedRootMemoryObservation>;
}

const ROOT_MEMORY_MAX_ROOTS = 20;
const ROOT_MEMORY_CACHE_MS = 5000;
const ROOT_MEMORY_MAX_CACHE_ENTRIES = 8;
const managedRootMemoryCache = new Map<string, ManagedRootMemoryCacheEntry>();
let managedRootMemoryFlight: { key: string; promise: Promise<ManagedRootMemoryCacheEntry> } | null = null;
let managedRootMemoryProbeAt = -Infinity;

function unknownRootMemory(reason: string): ManagedRootMemoryObservation {
  return { privateBytes: null, workingSetBytes: null, sampledAt: null, identityVerified: false, reason };
}

async function sampleManagedProcessMemory(
  config: ManagedProcessConfig,
  args: ManagedProcessArgs = {},
  context: ManagedProcessContext = {}
) {
  const requestedWorkspace = resolveCallerWorkspace(config, args, context);
  if (context.internal !== true && (!principalKeyForContext(context) || !requestedWorkspace)) {
    throw taskError('PROCESS_ACCESS_DENIED', 'Managed-root diagnostics require an authorized principal and workspace, or explicit trusted local authority.');
  }
  assertRequestedWorkspaceBoundary(config, args, context, requestedWorkspace);
  hydrateProcessMetadata(config);
  // Filter authority before selecting PIDs, building cache keys, or probing.
  const authorized = [...processes.values()].filter(record =>
    sameWorkspaceReference(path.dirname(path.dirname(record.stdoutPath)), processRoot(config))
    && !TERMINAL_STATUSES.has(record.status)
    && (!requestedWorkspace || workspaceMatches(record, requestedWorkspace))
    && canAccessProcess(config, record, args, context, { requireSession: false }))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const selected = authorized.slice(0, clampNumber(args.limit, 1, ROOT_MEMORY_MAX_ROOTS, ROOT_MEMORY_MAX_ROOTS));
  const targets = selected.map(record => ({
    processId: record.processId,
    pid: record.windowsJobOwned ? (record.windowsRootPid || null)
      : Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : null,
    identity: String(record.windowsJobOwned ? (record.windowsRootCreationIdentity || '') : (record.processCreationIdentity || ''))
  }));
  const authorityKey = context.internal === true ? 'trusted-local-dashboard' : principalKeyForContext(context);
  const key = crypto.createHash('sha256').update(JSON.stringify([
    normalizeWorkspaceReference(processRoot(config)), authorityKey,
    normalizeWorkspaceReference(requestedWorkspace), targets
  ])).digest('base64url');
  let entry = managedRootMemoryCache.get(key);
  let fallbackReason = process.platform === 'win32' ? 'sampling_rate_limited' : 'unsupported_platform';
  const cached = Boolean(entry && Date.now() - entry.atMs < ROOT_MEMORY_CACHE_MS);
  if (process.platform === 'win32' && targets.length && !cached) {
    if (managedRootMemoryFlight) {
      // Join the one bounded probe, without creating a queue of OS samplers.
      await managedRootMemoryFlight.promise;
      entry = managedRootMemoryCache.get(key);
    }
    if ((!entry || Date.now() - entry.atMs >= ROOT_MEMORY_CACHE_MS)
      && Date.now() - managedRootMemoryProbeAt >= ROOT_MEMORY_CACHE_MS) {
      managedRootMemoryProbeAt = Date.now();
      const promise = probeManagedRootMemory(targets).then(observations => {
        const value = { atMs: Date.now(), observations };
        managedRootMemoryCache.delete(key);
        managedRootMemoryCache.set(key, value);
        while (managedRootMemoryCache.size > ROOT_MEMORY_MAX_CACHE_ENTRIES) {
          const oldest = managedRootMemoryCache.keys().next().value;
          if (oldest === undefined) break;
          managedRootMemoryCache.delete(oldest);
        }
        return value;
      });
      const flight = { key, promise };
      managedRootMemoryFlight = flight;
      try { entry = await promise; }
      finally { if (managedRootMemoryFlight === flight) managedRootMemoryFlight = null; }
    }
  }
  if (!targets.length) fallbackReason = 'no_authorized_active_roots';
  const roots = targets.flatMap(target => {
    const record = processes.get(target.processId);
    if (!record || !canAccessProcess(config, record, args, context, { requireSession: false })) return [];
    let observation = entry?.observations.get(target.processId) || unknownRootMemory(fallbackReason);
    const currentRootPid = record.windowsJobOwned ? (record.windowsRootPid || null) : record.pid;
    const currentRootIdentity = record.windowsJobOwned ? (record.windowsRootCreationIdentity || '') : record.processCreationIdentity;
    if (currentRootPid !== target.pid || currentRootIdentity !== target.identity || TERMINAL_STATUSES.has(record.status)) {
      observation = unknownRootMemory('record_changed_during_sample');
    }
    return [{
      processId: record.processId, pid: target.pid,
      workspace: record.workspaceId, workSessionId: record.workSessionId || null,
      ...(record.diagnosticLabel ? { label: record.diagnosticLabel } : {}),
      kind: record.kind, lifecycle: record.lifecycle, status: record.status,
      ...observation,
      measurementStatus: observation.identityVerified ? 'measured' : 'unknown'
    }];
  });
  return {
    scope: 'managed_roots_only', platform: process.platform,
    sampledAt: entry ? new Date(entry.atMs).toISOString() : null,
    cacheAgeMs: entry ? Math.max(0, Date.now() - entry.atMs) : null,
    cached, stale: Boolean(entry && Date.now() - entry.atMs >= ROOT_MEMORY_CACHE_MS),
    totalRootCount: authorized.length,
    omittedRootCount: Math.max(0, authorized.length - selected.length),
    sampledRootCount: roots.filter(root => root.identityVerified).length,
    roots, descendantAttribution: 'unknown'
  };
}

async function probeManagedRootMemory(targets: readonly ManagedRootMemoryTarget[]): Promise<ReadonlyMap<string, ManagedRootMemoryObservation>> {
  const observations = new Map<string, ManagedRootMemoryObservation>();
  const eligible = targets.filter(target => target.pid && /^win32:\d+$/.test(target.identity));
  for (const target of targets) observations.set(target.processId, unknownRootMemory('identity_unavailable'));
  if (!eligible.length) return observations;
  let rows: GenericRecord[];
  try {
    rows = await readWindowsManagedRootMemory(eligible);
  } catch {
    for (const target of eligible) observations.set(target.processId, unknownRootMemory('probe_failed_or_timed_out'));
    return observations;
  }
  for (const target of eligible) {
    const row = rows.find(candidate => candidate.pid === target.pid);
    if (!row || row.unavailable === true) {
      observations.set(target.processId, unknownRootMemory('root_unavailable'));
      continue;
    }
    // DateTime.Ticks exceed JavaScript's integer precision. Require exact
    // string identities in the same win32:<ticks> format used at launch.
    if (typeof row.beforeIdentity !== 'string' || typeof row.afterIdentity !== 'string'
      || row.beforeIdentity !== target.identity || row.afterIdentity !== target.identity) {
      observations.set(target.processId, unknownRootMemory('identity_mismatch'));
      continue;
    }
    const privateBytes = memoryCounter(row.privateBytes);
    const workingSetBytes = memoryCounter(row.workingSetBytes);
    const sampledAtMs = typeof row.sampledAt === 'string' ? Date.parse(row.sampledAt) : NaN;
    if (privateBytes === null || workingSetBytes === null || !Number.isFinite(sampledAtMs)) {
      observations.set(target.processId, unknownRootMemory('invalid_measurement'));
      continue;
    }
    observations.set(target.processId, {
      privateBytes, workingSetBytes, sampledAt: new Date(sampledAtMs).toISOString(),
      identityVerified: true, reason: null
    });
  }
  return observations;
}

function memoryCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readWindowsManagedRootMemory(targets: readonly ManagedRootMemoryTarget[]): Promise<GenericRecord[]> {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const identitiesByPid = new Map<number, string[]>();
  for (const target of targets.slice(0, ROOT_MEMORY_MAX_ROOTS)) {
    if (!Number.isSafeInteger(target.pid) || Number(target.pid) <= 0 || !/^win32:\d+$/.test(target.identity)) continue;
    const pid = Number(target.pid);
    const identities = identitiesByPid.get(pid) || [];
    if (!identities.includes(target.identity)) identities.push(target.identity);
    identitiesByPid.set(pid, identities);
  }
  const safePids = [...identitiesByPid.keys()];
  const expectedAssignments = [...identitiesByPid].map(([pid, identities]) =>
    '$expectedIdentities[' + pid + '] = @(' + identities.map(identity => '"' + identity + '"').join(',') + ')');
  // Only exact, already-authorized root PIDs are inspected. No process-name,
  // command-line, global enumeration, descendant lookup, or signalling occurs.
  const script = [
    '# RelAiManagedRootMemoryV1',
    '$ErrorActionPreference = "Stop"',
    '$targets = @(' + safePids.join(',') + ')',
    '$expectedIdentities = @{}',
    ...expectedAssignments,
    '$results = @(foreach ($targetPid in $targets) {',
    '  $before = $null; $after = $null',
    '  try {',
    '    $before = Get-Process -Id $targetPid -ErrorAction Stop',
    '    $beforeIdentity = "win32:" + [string]$before.StartTime.ToUniversalTime().Ticks',
    '    if ($expectedIdentities[$targetPid] -notcontains $beforeIdentity) { [pscustomobject]@{ pid = $targetPid; beforeIdentity = $beforeIdentity; afterIdentity = $beforeIdentity }; continue }',
    '    $privateBytes = $before.PrivateMemorySize64; $workingSetBytes = $before.WorkingSet64',
    '    $after = Get-Process -Id $targetPid -ErrorAction Stop',
    '    $afterIdentity = "win32:" + [string]$after.StartTime.ToUniversalTime().Ticks',
    '    [pscustomobject]@{ pid = $targetPid; beforeIdentity = $beforeIdentity; afterIdentity = $afterIdentity; privateBytes = $privateBytes; workingSetBytes = $workingSetBytes; sampledAt = [DateTime]::UtcNow.ToString("o") }',
    '  } catch { [pscustomobject]@{ pid = $targetPid; unavailable = $true } }',
    '  finally { if ($before) { $before.Dispose() }; if ($after) { $after.Dispose() } }',
    '})',
    '[Console]::Out.Write((ConvertTo-Json -InputObject @($results) -Compress))'
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true, timeout: 2000, maxBuffer: 32768, encoding: 'utf8',
        env: makeProcessEnvironment({ PSModulePath: path.join(path.dirname(executable), 'Modules') }, { allow: [] })
      },
      (error, stdout) => {
        if (error) { reject(error); return; }
        try {
          const parsed: unknown = JSON.parse(String(stdout).replace(/^\uFEFF/, ''));
          if (!Array.isArray(parsed)) throw new Error('Invalid managed-root memory response.');
          resolve(parsed.slice(0, ROOT_MEMORY_MAX_ROOTS).map(asRecord));
        } catch (parseError) { reject(parseError); }
      });
  });
}

function assertProcessAccess(config: ManagedProcessConfig, record: ManagedProcessRecord, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}, options: ProcessAccessOptions = {}): void {
  if (trustedLocalContext(args, context)) return;
  const actualPrincipalKey = principalKeyForContext(context);
  if ((!record.principalKey && context.connector === true)
    || (record.principalKey && actualPrincipalKey !== record.principalKey)) {
    throw taskError('PROCESS_ACCESS_DENIED', 'Managed process is not available to this caller.');
  }

  const callerWorkspace = resolveCallerWorkspace(config, args, context);
  if (callerWorkspace && !workspaceMatches(record, callerWorkspace)) {
    throw taskError('PROCESS_WORKSPACE_MISMATCH', 'Managed process belongs to a different workspace.');
  }
  if (!callerWorkspace && context.connector === true) {
    throw taskError('PROCESS_WORKSPACE_CONTEXT_REQUIRED', 'Managed process access requires an authorized workspace.');
  }

  if (options.requireSession !== false) {
    const suppliedWorkId = String(context.taskId || args.work_id || '').trim();
    const owningWorkId = String(record.workSessionId || '').trim();
    if (suppliedWorkId && owningWorkId && suppliedWorkId !== owningWorkId) {
      throw taskError('PROCESS_SESSION_MISMATCH', 'The supplied work_id does not match this managed process attribution.');
    }
  }
}

function canAccessProcess(config: ManagedProcessConfig, record: ManagedProcessRecord, args: ManagedProcessArgs, context: ManagedProcessContext, options: ProcessAccessOptions = {}): boolean {
  try {
    assertProcessAccess(config, record, args, context, options);
    return true;
  } catch {
    return false;
  }
}

function assertRequestedWorkspaceBoundary(config: ManagedProcessConfig, args: ManagedProcessArgs, context: ManagedProcessContext, requestedWorkspace: string): void {
  const explicit = String(args.workspace || '').trim();
  const sessionWorkspace = String(
    context.workspace || workSessionWorkspace(config, context.taskId || args.work_id) || ''
  ).trim();
  if (explicit && sessionWorkspace && !sameWorkspaceReference(explicit, sessionWorkspace)) {
    throw taskError('PROCESS_WORKSPACE_MISMATCH', 'Requested process workspace differs from the logical task workspace.');
  }
  if (context.connector === true && !requestedWorkspace) {
    throw taskError('PROCESS_WORKSPACE_CONTEXT_REQUIRED', 'Managed process listing requires an authorized workspace.');
  }
}

function resolveCallerWorkspace(config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}): string {
  return String(
    args.workspace
    || context.workspace
    || workSessionWorkspace(config, context.taskId || args.work_id)
    || ''
  ).trim();
}

function workSessionWorkspace(config: ManagedProcessConfig, taskId: unknown): string {
  const id = String(taskId || '').trim();
  if (!id) return '';
  return String(readTaskHistorySession(config, id)?.workspace || '').trim();
}

function managedProcessReuseFingerprint({ workspaceId = '', workSessionId = '', principalKey = '', executionMode = '', command = '', input = '', cwd = '.', kind = '', purpose = '', lifecycle = 'persistent', pty = false, columns = 80, rows = 24, environment = [] }: ReuseFingerprintInput = {}): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    normalizeWorkspaceReference(workspaceId),
    String(workSessionId || '').trim(),
    String(principalKey || '').trim(),
    String(executionMode || '').trim(),
    String(command || '').trim(),
    String(input || ''),
    String(cwd || '.').trim().replaceAll('\\', '/'),
    String(kind || '').trim().toLowerCase(),
    String(purpose || '').trim(),
    lifecycle,
    pty === true,
    Number(columns) || 80,
    Number(rows) || 24,
    (environment || []).map(([key, value]) => [String(key || ''), String(value || '')])
  ])).digest('base64url');
}

function findReusableManagedProcess(reuseFingerprint: string): ManagedProcessRecord | null {
  if (!reuseFingerprint) return null;
  return [...processes.values()].find(record =>
    record.reuseFingerprint === reuseFingerprint
    && ['starting', 'running'].includes(record.status)
    && (record.lifecycle === 'persistent' || record.lifecycle === 'task')
    && !record.discarded
  ) || null;
}

async function acquireManagedProcessReuseReservation(
  reuseFingerprint: string,
  signal?: AbortSignal
): Promise<() => void> {
  const previous = processReuseReservations.get(reuseFingerprint) || Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>(resolve => { releaseCurrent = resolve; });
  const tail = previous.then(() => current);
  processReuseReservations.set(reuseFingerprint, tail);
  try {
    await waitForManagedProcessCoordination(previous, signal, 'Managed process startup was cancelled while waiting to reuse an existing process.');
  } catch (error) {
    // Settle only this wait node. Keep its predecessor in the shared chain
    // until that startup finishes, so later callers cannot bypass it.
    releaseCurrent();
    void tail.then(() => {
      if (processReuseReservations.get(reuseFingerprint) === tail) processReuseReservations.delete(reuseFingerprint);
    });
    throw error;
  }
  if (signal?.aborted) {
    releaseCurrent();
    if (processReuseReservations.get(reuseFingerprint) === tail) processReuseReservations.delete(reuseFingerprint);
    throw managedProcessCoordinationAbortError(signal, 'Managed process startup was cancelled while waiting to reuse an existing process.');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (processReuseReservations.get(reuseFingerprint) === tail) processReuseReservations.delete(reuseFingerprint);
  };
}

function waitForManagedProcessCoordination<T>(promise: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(managedProcessCoordinationAbortError(signal, message));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onAbort = () => finish(() => reject(managedProcessCoordinationAbortError(signal, message)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) return onAbort();
    Promise.resolve(promise).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error))
    );
  });
}

function managedProcessCoordinationAbortError(signal: AbortSignal, message: string): Error {
  const reason = signal.reason;
  if (reason instanceof Error && errorCode(reason) === 'PROCESS_START_COORDINATION_TIMEOUT') return reason;
  return cancellationError(message);
}

function managedStartupBlocker() {
  const diagnostic = asRecord(hostResourceDiagnosticSnapshot());
  const lanes = asRecord(diagnostic.lanes);
  const persistent = asRecord(lanes.persistent);
  const heavy = asRecord(lanes.heavy);
  const queues = asRecord(diagnostic.queues);
  if (Number(persistent.active) >= Number(persistent.limit) && Number(persistent.limit) > 0) {
    return { resource: 'persistent', stats: persistent, message: 'Persistent process capacity remained full. Stop an owned persistent process or wait for one to exit before retrying.' };
  }
  if (Number(heavy.active) >= Number(heavy.limit) && Number(heavy.limit) > 0) {
    return { resource: 'heavy', stats: heavy, message: 'Heavy-work capacity is full. Wait for an active build, test, or startup to settle before retrying.' };
  }
  const queuedReason = String(asRecord(queues.heavy).blockedReason || '');
  if (queuedReason) return { resource: 'heavy', stats: heavy, message: queuedReason };

  return { resource: 'coordination', stats: heavy, message: 'Another process startup or resource coordination step is still settling. Retry after it finishes.' };
}

function processCoordinationTimeoutError(timeoutMs: number): Error {
  const blocker = managedStartupBlocker();
  return Object.assign(
    new Error(`Managed process startup coordination exceeded ${timeoutMs}ms. ${blocker.message}`),
    { code: 'PROCESS_START_COORDINATION_TIMEOUT', retryable: true, blockedResource: blocker.resource }
  );
}

function principalKeyForContext(context: ManagedProcessContext = {}): string {
  if (context.principal) return principalFingerprint(context.principal);

  const authInfo = asRecord(context.mcp?.authInfo || context.authInfo);
  const authExtra = asRecord(authInfo.extra);
  const clientId = String(
    authInfo.clientId
    || authInfo.client_id
    || authExtra.clientId
    || authExtra.client_id
    || ''
  ).trim();
  if (clientId) {
    return principalFingerprint(createHttpPrincipal({ ...authInfo, clientId }, String(authInfo.authMode || context.authMode || '')));
  }

  const fallback = context.connector === true ? 'connector:anonymous' : context.taskId ? 'local:stdio' : '';
  return fallback ? principalFingerprint(fallback) : '';
}

function trustedLocalContext(args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}): boolean {
  return context.internal === true
    || (Object.keys(context).length === 0 && !args.work_id && !args.taskId && !args.workspace);
}

function workspaceMatches(record: ManagedProcessRecord, workspace: unknown): boolean {
  const expected = normalizeWorkspaceReference(workspace);
  return expected === normalizeWorkspaceReference(record.workspaceId)
    || expected === normalizeWorkspaceReference(record.workspacePath);
}

function sameWorkspaceReference(left: unknown, right: unknown): boolean {
  return normalizeWorkspaceReference(left) === normalizeWorkspaceReference(right);
}

function normalizeWorkspaceReference(value: unknown): string {
  const text = String(value || '').trim();
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

function processSnapshot(record: ManagedProcessRecord, options: ProcessSnapshotOptions = {}): ManagedProcessDto & GenericRecord {
  const nativeReceipt = record.windowsJob?.receipt();
  if (nativeReceipt) {
    if (Number.isSafeInteger(nativeReceipt.rootPid) && Number(nativeReceipt.rootPid) > 0) record.windowsRootPid = Number(nativeReceipt.rootPid);
    if (/^win32:\d{1,20}$/.test(String(nativeReceipt.rootCreationIdentity || ''))) record.windowsRootCreationIdentity = String(nativeReceipt.rootCreationIdentity);
    record.rootExitConfirmed ||= nativeReceipt.rootExited === true;
    if (nativeReceipt.rootExited === true && typeof nativeReceipt.rootExitCode === 'number') record.exitCode = nativeReceipt.rootExitCode;
  }
  const result: ManagedProcessDto & GenericRecord = {
    ok: !['failed', 'orphaned'].includes(record.status),
    processId: record.processId,
    pid: record.windowsRootPid || record.pid || null,
    workspace: record.workspaceId,
    workspaceId: record.workspaceId,
    label: record.label,
    kind: record.kind || 'service',
    purpose: record.purpose || '',
    commandSummary: record.commandSummary,
    cwd: record.cwd,
    status: record.status,
    metadataRevision: processMetadataRevision(record),
    lifecycle: record.lifecycle || 'persistent',
    terminationConfirmed: record.terminationConfirmed,
    rootExitConfirmed: record.rootExitConfirmed,
    ...(record.terminationError ? { terminationError: record.terminationError } : {}),

    workSessionId: record.workSessionId || null,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
    exitCode: record.exitCode,
    signal: record.signal || null,
    stdoutBytes: Number(record.stdoutBytes || 0),
    stderrBytes: Number(record.stderrBytes || 0),
    ...(Number(record.stdoutDroppedBytes || 0) > 0 ? { stdoutDroppedBytes: Number(record.stdoutDroppedBytes) } : {}),
    ...(Number(record.stderrDroppedBytes || 0) > 0 ? { stderrDroppedBytes: Number(record.stderrDroppedBytes) } : {}),
    stdoutRetainedFromOffset: Number(record.stdoutStartOffset || 0),
    stderrRetainedFromOffset: Number(record.stderrStartOffset || 0),
    environmentKeys: record.environmentKeys || []
  };
  if (record.pty) {
    result.pty = true;
    result.columns = Number(record.columns || 80);
    result.rows = Number(record.rows || 24);
  }
  if (record.error) result.error = record.error;
  if (options.includeTail) {
    const stdoutTail = readLogTailRange(record, 'stdout', options.tailBytes || 8192);
    const stderrTail = readLogTailRange(record, 'stderr', options.tailBytes || 8192);
    result.stdoutTail = stdoutTail.text;
    result.stderrTail = stderrTail.text;
    if (options.includeTailOffsets) {
      result.stdoutTailStartOffset = stdoutTail.offset;
      result.stderrTailStartOffset = stderrTail.offset;
    }
  }
  return result;
}

function processMetadataRevision(record: ManagedProcessRecord): string {
  return crypto.createHash('sha256').update(JSON.stringify([
    record.status,
    record.pid || null,
    record.endedAt || '',
    record.exitCode,
    record.signal || '',
    record.error || '',
    record.lifecycle,
    record.terminationConfirmed,
    record.rootExitConfirmed,
    record.terminationError,
    Number(record.stdoutDroppedBytes || 0),
    Number(record.stderrDroppedBytes || 0),
    record.pty === true,
    Number(record.columns || 0),
    Number(record.rows || 0)
  ])).digest('base64url').slice(0, 16);
}

function finishRecord(config: ManagedProcessConfig, record: ManagedProcessRecord, fields: Partial<ManagedProcessRecord>): void {
  if (TERMINAL_STATUSES.has(record.status) && record.endedAt) return;
  if (record.windowsJobOwned) {
    const receipt = record.windowsJob?.receipt();
    if (Number.isSafeInteger(receipt?.rootPid) && Number(receipt?.rootPid) > 0) record.windowsRootPid = Number(receipt?.rootPid);
    const confirmed = record.terminationConfirmed === true || record.windowsJob?.outcome().exited === true;
    record.terminationConfirmed = confirmed;
    record.rootExitConfirmed = receipt?.rootExited === true || record.rootExitConfirmed;
    if (typeof receipt?.rootExitCode === 'number') fields = { ...fields, exitCode: receipt.rootExitCode };
    if (!confirmed) record.terminationError = 'Native Windows job completion was not confirmed; managed ownership is retained.';
  } else record.rootExitConfirmed = true;
  if ((record.stopPromise || record.terminationInProgress) && record.terminationConfirmed !== true) {
    // The close event can race the tree terminator. Save root evidence, but
    // let the terminator decide whether descendants and capacity are gone.
    if (fields.exitCode !== undefined) record.exitCode = fields.exitCode;
    if (fields.signal !== undefined) record.signal = fields.signal;
    return;
  }
  if ((record.lifecycle === 'task' || record.windowsJobOwned) && record.terminationConfirmed !== true && record.pid) {
    clearInteractivePtyRetirement(record);
    clearScheduledPersist(record);
    resumeLogSources(record);
    Object.assign(record, fields, {
      status: 'orphaned',
      endedAt: '',
      terminationConfirmed: false,
      terminationError: 'The managed root exited; descendant cleanup has not been confirmed.'
    });
    record.error = record.terminationError;
    record.child = null;
    if (record.ptyProcess) void disposeNodePtyResources(record.ptyProcess);
    record.ptyProcess = null;
    notifyProcessState(record);
    if (!record.discarded) void drainLogWrites(config, record).then(() => queueMetadataPersist(config, record));
    return;
  }
  clearInteractivePtyRetirement(record);
  clearScheduledPersist(record);
  resumeLogSources(record);
  releaseManagedProcessResource(record);
  record.windowsJob?.cleanup();
  Object.assign(record, fields, { endedAt: new Date().toISOString() });
  record.child = null;
  if (record.ptyProcess) void disposeNodePtyResources(record.ptyProcess);
  record.ptyProcess = null;
  notifyProcessState(record);
  if (!record.discarded) {
    void drainLogWrites(config, record).then(() => queueMetadataPersist(config, record));
  }
}

function releaseManagedProcessResource(record: ManagedProcessRecord): void {
  const release = record?.hostResourceRelease;
  record.hostResourceRelease = null;
  try { release?.(); } catch {}
}

function interactivePtyIdleRetireMs(): number {
  const configured = Number(process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS);
  if (Number.isFinite(configured) && configured >= 1000) return Math.floor(configured);
  return DEFAULT_INTERACTIVE_PTY_IDLE_RETIRE_MS;
}

function permitsWrappedCmdStartup(executable: string, argv: readonly string[], environment: Record<string, string>): boolean {
  if (process.platform !== 'win32' || !path.win32.isAbsolute(executable)) return false;
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '');
  if (!path.win32.isAbsolute(systemRoot)) return false;
  const systemCmd = path.win32.join(systemRoot, 'System32', 'cmd.exe');
  if (path.win32.normalize(executable).toLowerCase() !== path.win32.normalize(systemCmd).toLowerCase()) return false;
  const flags = argv.map(value => value.toUpperCase());
  return flags.length >= 1 && flags.length <= 2 && new Set(flags).size === flags.length
    && flags.includes('/D') && flags.every(value => value === '/D' || value === '/Q')
    && !Object.keys(environment).some(key => key.toUpperCase() === 'PROMPT');
}

function notePtyInputAttempt(record: ManagedProcessRecord): void {
  if (!record.pty) return;
  record.ptyWrappedStartupEligible = false;
  record.ptyLastInputSeq = ++record.ptyActivitySeq;
  record.lastPtyInputAtMs = Date.now();
}

function interactivePtyLastActivityAtMs(record: ManagedProcessRecord): number {
  return Math.max(record.lastPtyInputAtMs, record.lastPtyOutputAtMs, record.lastPtyResizeAtMs);
}

function clearInteractivePtyRetirement(record: ManagedProcessRecord): void {
  if (!record.idleRetireTimer) return;
  clearTimeout(record.idleRetireTimer);
  record.idleRetireTimer = null;
}

function scheduleInteractivePtyRetirement(config: ManagedProcessConfig, record: ManagedProcessRecord): void {
  clearInteractivePtyRetirement(record);
  if (!isRetirableInteractivePty(record)) return;
  const timeoutMs = interactivePtyIdleRetireMs();
  record.idleRetireTimer = setTimeout(() => {
    record.idleRetireTimer = null;
    if (!isRetirableInteractivePty(record)) return;
    const remainingMs = timeoutMs - Math.max(0, Date.now() - interactivePtyLastActivityAtMs(record));
    if (remainingMs > 0) {
      scheduleInteractivePtyRetirement(config, record);
      return;
    }
    void stopRecordInternal(config, record, {
      graceMs: DEFAULT_STOP_GRACE_MS,
      automaticPtyRetirement: { activitySeq: record.ptyActivitySeq, idleMs: timeoutMs }
    }).catch(() => {});
  }, timeoutMs);
  record.idleRetireTimer.unref?.();
}

function isRetirableInteractivePty(record: ManagedProcessRecord): boolean {
  return record.runtimeId === RUNTIME_ID
    && record.lifecycle === 'task'
    && record.kind === 'interactive'
    && record.pty === true
    && record.ptyStartupSettled
    && !record.discarded && !record.persistenceFailureHandled
    && record.status === 'running'
    && Boolean(record.ptyProcess);
}

function canAutomaticallyRetirePty(record: ManagedProcessRecord, guard: InteractivePtyRetirementGuard): boolean {
  if (processes.get(record.processId) !== record || !isRetirableInteractivePty(record)
    || record.ptyActivitySeq !== guard.activitySeq || record.ptyLastOutputSeq <= record.ptyLastInputSeq
    || Date.now() - interactivePtyLastActivityAtMs(record) < guard.idleMs
    || record.stdoutDroppedBytes !== 0 || record.logPendingBytes.stdout !== 0
    || record.logBufferBytes.stdout !== 0 || record.logBuffers.stdout.length !== 0) return false;
  const atPrompt = interactiveShellIsAtPrompt(record);
  return atPrompt && record.ptyActivitySeq === guard.activitySeq
    && processes.get(record.processId) === record && isRetirableInteractivePty(record);
}

function interactiveShellIsAtPrompt(record: ManagedProcessRecord): boolean {
  // Only the exact, owned CMD startup transcript is proof of an idle prompt.
  // A later command can print "C:\\path>" or "PS path>" without returning to
  // the shell; prompt-shaped stdout must never authorize process termination.
  if (!record.ptyWrappedStartupEligible) return false;
  const range = readLogTailRange(record, 'stdout', MAX_WRAPPED_STARTUP_PROMPT_BYTES);
  if (range.invalidUtf8 || range.truncated || range.nextOffset !== record.stdoutBytes
    || range.totalBytes !== record.stdoutBytes) return false;
  return wrappedCmdStartupIsAtPrompt(record, range);
}

export function wrappedCmdStartupIsAtPrompt(record: ManagedProcessRecord, range: LogRange): boolean {
  if (!record.ptyWrappedStartupEligible || record.ptyLastInputSeq !== 0
    || record.columns !== record.ptyLaunchColumns || range.offset !== 0
    || range.retainedFromOffset !== 0 || range.truncatedBefore
    || range.totalBytes > MAX_WRAPPED_STARTUP_PROMPT_BYTES) return false;
  const expected = record.ptyLaunchCwd + '>';
  const columns = record.ptyLaunchColumns;
  if (!Number.isInteger(columns) || columns < 1 || columns > 1000
    || expected.length > MAX_WRAPPED_STARTUP_PROMPT_BYTES
    || !/^(?:[A-Za-z]:\\|\\\\)/.test(expected) || !/^[\x20-\x7E]+$/.test(expected)) return false;
  // Only a controlled /D CMD startup, before any input, can establish this
  // exact prompt. Support both single-row and wrapped launch paths without
  // treating later arbitrary command output as a shell-completion signal.
  // Elevated CMD can emit an OSC 0 window title before the startup banner.
  // Only strip it at the beginning of this controlled startup transcript.
  const withoutControls = range.text
    .replace(/^\x1B\]0;[\x20-\x7E]{0,256}\x07/, '')
    .replace(/\x1B\[(?:0m|0K|\?25[hl])/g, '');
  if (/[\r\n]/.test(withoutControls.replace(/\r\n/g, ''))) return false;
  const visible = withoutControls.replace(/\r\n/g, '\n');
  if (!/^[\x20-\x7E\n]*$/.test(visible)) return false;
  const rows = visible.split('\n');
  const count = Math.ceil(expected.length / columns);
  const first = rows.length - count;
  if (first < 1) return false;
  return rows.slice(first).every((row, index) => row === expected.slice(index * columns, (index + 1) * columns));
}

async function retireIdleInteractivePtysForCapacity(config: ManagedProcessConfig): Promise<number> {
  const stats = hostResourceStats().persistent;
  if (Number(stats?.active || 0) < Number(stats?.limit || HOST_PERSISTENT_PROCESS_LIMIT)) return 0;
  const candidates = [...processes.values()]
    .map(record => ({ record, guard: { activitySeq: record.ptyActivitySeq, idleMs: CAPACITY_PRESSURE_PTY_IDLE_MS } }))
    .filter(({ record, guard }) => canAutomaticallyRetirePty(record, guard))
    .sort((left, right) => interactivePtyLastActivityAtMs(left.record) - interactivePtyLastActivityAtMs(right.record));
  let retired = 0;
  for (const { record, guard } of candidates) {
    await stopRecordInternal(config, record, {
      graceMs: DEFAULT_STOP_GRACE_MS, automaticPtyRetirement: guard
    }).catch(() => null);
    if (TERMINAL_STATUSES.has(record.status)) retired += 1;
    const current = hostResourceStats().persistent;
    if (Number(current?.active || 0) < Number(current?.limit || HOST_PERSISTENT_PROCESS_LIMIT)) break;
  }
  return retired;
}

function requireProcess(config: ManagedProcessConfig, processId: unknown): ManagedProcessRecord {
  const id = validateProcessId(processId);
  let record = processes.get(id);
  if (!record) {
    const restored = readMetadata(config, id);
    if (!restored) throw new Error(`Unknown managed process: ${id}`);
    record = reconcileRestoredRecord(config, restored);
    processes.set(id, record);
  }
  return record;
}

function persistMetadata(config: ManagedProcessConfig, record: ManagedProcessRecord): void {
  const directory = processDirectory(config, record.processId);
  const target = path.join(directory, 'metadata.json');
  writeJsonAtomic(target, metadataRecord(record), { mode: 0o600, backup: true });
}

function persistMetadataAsync(config: ManagedProcessConfig, record: ManagedProcessRecord): Promise<unknown> {
  const directory = processDirectory(config, record.processId);
  const target = path.join(directory, 'metadata.json');
  return writeJsonAtomicAsync(target, metadataRecord(record), { mode: 0o600, backup: true, durable: false });
}

function queueMetadataPersist(config: ManagedProcessConfig, record: ManagedProcessRecord): Promise<boolean> {
  if (record.discarded || record.persistenceFailureHandled) return Promise.resolve(false);
  const previous = metadataWriteQueues.get(record.processId) || Promise.resolve();
  const next = previous
    .then(() => persistMetadataAsync(config, record))
    .then(() => true)
    .catch(error => {
      handlePersistenceFailure(config, record, error);
      return false;
    })
    .finally(() => {
      if (metadataWriteQueues.get(record.processId) === next) metadataWriteQueues.delete(record.processId);
    });
  metadataWriteQueues.set(record.processId, next);
  return next;
}

function metadataRecord(record: ManagedProcessRecord): GenericRecord {
  return {
    schemaVersion: PROCESS_SCHEMA_VERSION,
    runtimeId: record.runtimeId || RUNTIME_ID,
    processId: record.processId,
    workspaceId: record.workspaceId,
    workspacePath: record.workspacePath,

    workSessionId: record.workSessionId || '',
    principalKey: record.principalKey || '',
    reuseFingerprint: record.reuseFingerprint || '',
    lifecycle: record.lifecycle || 'persistent',
    terminationConfirmed: record.terminationConfirmed,
    rootExitConfirmed: record.rootExitConfirmed,
    terminationError: record.terminationError,
    kind: record.kind || 'service',
    purpose: record.purpose || '',
    commandSummary: record.commandSummary,
    label: record.label,
    diagnosticLabel: record.diagnosticLabel,
    cwd: record.cwd,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt || '',
    exitCode: record.exitCode,
    signal: record.signal || '',
    error: record.error || '',
    pid: record.pid || null,
    processCreationIdentity: record.processCreationIdentity || '',
    windowsJobDirectory: record.windowsJobDirectory || '',
    windowsJobOwned: record.windowsJobOwned === true,
    windowsRootPid: record.windowsRootPid || null,
    windowsRootCreationIdentity: record.windowsRootCreationIdentity || '',
    stdoutBytes: Number(record.stdoutBytes || 0),
    stderrBytes: Number(record.stderrBytes || 0),
    stdoutDroppedBytes: Number(record.stdoutDroppedBytes || 0),
    stderrDroppedBytes: Number(record.stderrDroppedBytes || 0),
    stdoutStartOffset: Number(record.stdoutStartOffset || 0),
    stderrStartOffset: Number(record.stderrStartOffset || 0),
    environmentKeys: record.environmentKeys || [],
    pty: record.pty === true,
    columns: Number(record.columns || 80),
    rows: Number(record.rows || 24),
    maxLogBytes: record.maxLogBytes
  };
}

function safePersistMetadata(config: ManagedProcessConfig, record: ManagedProcessRecord): boolean {
  if (record.discarded) return false;
  try {
    persistMetadata(config, record);
    return true;
  } catch (error) {
    handlePersistenceFailure(config, record, error);
    return false;
  }
}

function scheduleMetadataPersist(config: ManagedProcessConfig, record: ManagedProcessRecord): void {
  if (record.persistTimer || record.persistenceFailureHandled) return;
  record.persistTimer = setTimeout(() => {
    record.persistTimer = null;
    void queueMetadataPersist(config, record).then(persisted => {
      if (persisted && !record.discarded) notifyProcessState(record);
    });
  }, METADATA_FLUSH_DELAY_MS);
  record.persistTimer.unref?.();
}

function clearScheduledPersist(record: ManagedProcessRecord): void {
  if (!record.persistTimer) return;
  clearTimeout(record.persistTimer);
  record.persistTimer = null;
}

function handlePersistenceFailure(config: ManagedProcessConfig, record: ManagedProcessRecord, error: unknown): void {
  if (record.persistenceFailureHandled) return;
  record.persistenceFailureHandled = true;
  clearScheduledPersist(record);
  clearScheduledLogFlushes(record);
  resumeLogSources(record);
  record.error = `Managed process persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  if (record.stopPromise || record.terminationInProgress) return;
  record.terminationInProgress = true;
  void terminateManagedRecord(record, { graceMs: 0, forceWaitMs: DEFAULT_FORCE_WAIT_MS })
    .then(outcome => {
      record.terminationInProgress = false;
      record.terminationConfirmed = outcome.exited;
      record.status = outcome.exited ? 'failed' : 'orphaned';
      record.terminationError = outcome.exited ? '' : outcome.error || 'Persistence failed and descendant termination could not be confirmed.';
      record.endedAt = outcome.exited ? new Date().toISOString() : '';
      if (outcome.exited) {
        releaseManagedProcessResource(record);
        record.child = null;
        record.ptyProcess = null;
      }
      try { persistMetadata(config, record); } catch {}
      notifyProcessState(record);
    })
    .catch(error => {
      record.terminationInProgress = false;
      record.status = 'orphaned';
      record.endedAt = '';
      record.terminationConfirmed = false;
      record.terminationError = error instanceof Error ? error.message : String(error);
      try { persistMetadata(config, record); } catch {}
      notifyProcessState(record);
    });
}

function readMetadata(config: ManagedProcessConfig, processId: string): ManagedProcessRecord | null {
  try {
    const directory = processDirectory(config, processId);
    const metadata = readJsonFile<GenericRecord>(path.join(directory, 'metadata.json'), { backup: true });
    if (!metadata || metadata.processId !== processId) return null;
    const stdoutPath = path.join(directory, 'stdout.log');
    const stderrPath = path.join(directory, 'stderr.log');
    const stdoutSize = fileSize(stdoutPath);
    const stderrSize = fileSize(stderrPath);
    const stdoutBytes = Math.max(Number(metadata.stdoutBytes || 0), Number(metadata.stdoutStartOffset || 0) + stdoutSize);
    const stderrBytes = Math.max(Number(metadata.stderrBytes || 0), Number(metadata.stderrStartOffset || 0) + stderrSize);
    return {
      schemaVersion: PROCESS_SCHEMA_VERSION,
      runtimeId: String(metadata.runtimeId || ''),
      processId,
      workspaceId: String(metadata.workspaceId || metadata.workspace || ''),
      workspacePath: String(metadata.workspacePath || ''),

      workSessionId: String(metadata.workSessionId || metadata.logicalTaskId || ''),
      principalKey: String(metadata.principalKey || ''),
      reuseFingerprint: String(metadata.reuseFingerprint || ''),
      lifecycle: metadata.lifecycle === 'task' ? 'task' : 'persistent',
      terminationConfirmed: typeof metadata.terminationConfirmed === 'boolean' ? metadata.terminationConfirmed : null,
      rootExitConfirmed: metadata.rootExitConfirmed === true,
      terminationError: String(metadata.terminationError || ''),
      stopPromise: null,
      terminationInProgress: false,
      kind: ['service', 'watcher', 'interactive'].includes(String(metadata.kind || '')) ? String(metadata.kind) : 'service',
      purpose: String(metadata.purpose || ''),
      commandSummary: String(metadata.commandSummary || ''),
      label: String(metadata.label || metadata.commandSummary || processId),
      diagnosticLabel: sanitizeDisplayText(String(metadata.diagnosticLabel || ''), 120),
      cwd: String(metadata.cwd || '.'),
      status: normalizeProcessLifecycleStatus(metadata.status) || 'orphaned',
      startedAt: String(metadata.startedAt || ''),
      endedAt: String(metadata.endedAt || ''),
      exitCode: typeof metadata.exitCode === 'number' ? metadata.exitCode : null,
      signal: String(metadata.signal || ''),
      error: String(metadata.error || ''),
      pid: Number.isSafeInteger(Number(metadata.pid)) ? Number(metadata.pid) : null,
      processCreationIdentity: String(metadata.processCreationIdentity || ''),
      windowsRootCreationIdentity: /^win32:\d{1,20}$/.test(String(metadata.windowsRootCreationIdentity || '')) ? String(metadata.windowsRootCreationIdentity) : '',
      windowsRootPid: Number.isSafeInteger(metadata.windowsRootPid) && Number(metadata.windowsRootPid) > 0 ? Number(metadata.windowsRootPid) : 0,
      windowsJobOwned: metadata.windowsJobOwned === true || Boolean(metadata.windowsJobDirectory),
      windowsJobDirectory: /^job-[a-zA-Z0-9]+$/.test(String(metadata.windowsJobDirectory || '')) ? String(metadata.windowsJobDirectory) : '',
      windowsJob: /^job-[a-zA-Z0-9]+$/.test(String(metadata.windowsJobDirectory || ''))
        ? restoreWindowsProcessJob(path.join(directory, String(metadata.windowsJobDirectory)), Number(metadata.pid) || null) : null,
      restartIdentityVerified: String(metadata.runtimeId || '') === RUNTIME_ID,
      stdoutBytes,
      stderrBytes,
      stdoutDroppedBytes: Number(metadata.stdoutDroppedBytes || 0),
      stderrDroppedBytes: Number(metadata.stderrDroppedBytes || 0),
      stdoutStartOffset: Number.isFinite(Number(metadata.stdoutStartOffset))
        ? Number(metadata.stdoutStartOffset)
        : Math.max(0, stdoutBytes - stdoutSize),
      stderrStartOffset: Number.isFinite(Number(metadata.stderrStartOffset))
        ? Number(metadata.stderrStartOffset)
        : Math.max(0, stderrBytes - stderrSize),
      stdoutPath,
      stderrPath,
      environmentKeys: Array.isArray(metadata.environmentKeys) ? metadata.environmentKeys : [],
      child: null,
      ptyProcess: null,
      pty: metadata.pty === true,
      columns: clampNumber(metadata.columns, 1, 1000, 80),
      rows: clampNumber(metadata.rows, 1, 1000, 24),
      ptyExitPromise: null,
      resolvePtyExit: null,
      maxLogBytes: clampNumber(metadata.maxLogBytes, 65536, 256 * 1024 * 1024, DEFAULT_MAX_LOG_BYTES),
      persistTimer: null,
      logBuffers: { stdout: [], stderr: [] },
      logBufferBytes: { stdout: 0, stderr: 0 },
      logPendingBytes: { stdout: 0, stderr: 0 },
      logPaused: { stdout: false, stderr: false },
      logSources: { stdout: null, stderr: null },
      logFlushTimers: { stdout: null, stderr: null },
      logWritePromises: { stdout: Promise.resolve(), stderr: Promise.resolve() },
      persistenceFailureHandled: false,
      discarded: false,
      hostResourceRelease: null,
      queueWaitMs: 0,
      lastPtyInputAtMs: 0,
      lastPtyOutputAtMs: 0,
      lastPtyResizeAtMs: 0,
      ptyLaunchCwd: '',
      ptyLaunchColumns: 0,
      ptyWrappedStartupEligible: false,
      ptyStartupSettled: false,
      ptyActivitySeq: 0,
      ptyLastInputSeq: 0,
      ptyLastOutputSeq: 0,
      idleRetireTimer: null
    };
  } catch {
    return null;
  }
}

function reserveRestoredManagedProcessCapacity(config: ManagedProcessConfig, signal?: AbortSignal): Promise<void> {
  const previous = restoredCapacityReservation;
  const message = 'Managed process startup was cancelled while restoring persistent-process capacity.';
  // The queue tracks actual restoration, not the caller's cancellable wait.
  const next = previous.then(() => {
    if (signal?.aborted) throw managedProcessCoordinationAbortError(signal, message);
    return reserveRestoredManagedProcessCapacityInternal(config, signal);
  });
  restoredCapacityReservation = next.catch(() => undefined);
  return waitForManagedProcessCoordination(next, signal, message);
}

async function reserveRestoredManagedProcessCapacityInternal(config: ManagedProcessConfig, signal?: AbortSignal): Promise<void> {
  const restored = [...processes.values()].filter(record => record.status === 'orphaned' && record.runtimeId !== RUNTIME_ID);
  const live = [];
  for (const record of restored) {
    const identity = await verifyRestoredProcessIdentity(config, record);
    if (identity === 'verified' || (record.windowsJobOwned && record.terminationConfirmed !== true)) {
      live.push(record);
      continue;
    }
  }

  let available = Math.max(0, HOST_PERSISTENT_PROCESS_LIMIT - Number(hostResourceStats().persistent?.active || 0));
  for (const record of live) {
    if (record.hostResourceRelease || available <= 0) continue;
    const lease = await acquireHostResource('persistent', record.workspaceId || 'restored', {
      signal,
      timeoutMs: 1000
    });
    record.hostResourceRelease = lease.release;
    record.queueWaitMs = 0;
    available -= 1;
  }

  if (live.length >= HOST_PERSISTENT_PROCESS_LIMIT) {
    throw Object.assign(
      new Error(`Persistent process capacity is occupied by ${live.length} process(es) that survived a Rel.AI restart. Stop orphaned processes before starting another persistent process.`),
      {
        code: 'HOST_PROCESS_CAPACITY_EXHAUSTED',
        retryable: true,
        active: live.length,
        limit: HOST_PERSISTENT_PROCESS_LIMIT
      }
    );
  }
}

function reconcileRestoredRecord(config: ManagedProcessConfig, record: ManagedProcessRecord): ManagedProcessRecord {
  if (record.runtimeId === RUNTIME_ID && processes.has(record.processId)) return record;
  if (!isActiveProcessStatus(record.status) && record.status !== 'orphaned') return record;
  if (record.windowsJobOwned) {
    record.terminationConfirmed = record.windowsJob?.outcome().exited === true;
    record.rootExitConfirmed ||= record.windowsJob?.receipt()?.rootExited === true;
    record.status = record.terminationConfirmed ? 'stopped' : 'orphaned';
    record.endedAt = record.terminationConfirmed ? (record.endedAt || new Date().toISOString()) : '';
    if (!record.terminationConfirmed) {
      record.terminationError = 'Recovered Windows job completion remains unconfirmed.';
      record.error = record.terminationError;
    }
    try { persistMetadata(config, record); } catch {}
    return record;
  }
  if (record.pid && isProcessTreeAlive(record.pid)) {
    record.status = 'orphaned';
    if (!record.restartIdentityVerified) {
      record.error = 'Process PID is live after a Rel.AI restart; creation identity must be verified before recovery or termination.';
    }
  } else {
    record.rootExitConfirmed = true;
    record.status = (record.lifecycle === 'task' || record.windowsJobOwned) && record.terminationConfirmed !== true ? 'orphaned' : 'stopped';
    record.endedAt = record.status === 'orphaned' ? '' : record.endedAt || new Date().toISOString();
    record.signal = record.signal || 'unobserved_restart';
    if (record.status === 'orphaned') {
      record.terminationConfirmed = false;
      record.terminationError = 'The managed root exited before recovery; descendant cleanup has not been confirmed.';
      record.error = record.terminationError;
    }
  }
  try { persistMetadata(config, record); } catch {}
  return record;
}

async function verifyRestoredProcessIdentity(
  config: ManagedProcessConfig,
  record: ManagedProcessRecord
): Promise<'verified' | 'dead' | 'unverified' | 'mismatch'> {
  if (record.runtimeId === RUNTIME_ID && !record.rootExitConfirmed && (record.child || record.ptyProcess)) {
    record.restartIdentityVerified = true;
    return 'verified';
  }
  if (!record.pid || !isProcessTreeAlive(record.pid)) {
    if (process.platform !== 'win32' || record.terminationConfirmed === true) releaseManagedProcessResource(record);
    record.restartIdentityVerified = false;
    record.rootExitConfirmed = true;
    record.status = (record.lifecycle === 'task' || record.windowsJobOwned) && record.terminationConfirmed !== true ? 'orphaned' : 'stopped';
    record.endedAt = record.status === 'orphaned' ? '' : record.endedAt || new Date().toISOString();
    record.signal = record.signal || 'unobserved_restart';
    try { persistMetadata(config, record); } catch {}
    return 'dead';
  }
  const expected = String(record.processCreationIdentity || '').trim();
  if (!expected) {
    record.restartIdentityVerified = false;
    record.error = 'Restarted process identity is unavailable; refusing to act on a PID that cannot be proven to belong to Rel.AI.';
    try { persistMetadata(config, record); } catch {}
    return 'unverified';
  }
  const observed = await readProcessCreationIdentity(record.pid);
  if (!observed) {
    record.restartIdentityVerified = false;
    record.error = 'Restarted process creation identity could not be verified; refusing to signal the PID.';
    try { persistMetadata(config, record); } catch {}
    return 'unverified';
  }
  if (observed !== expected) {
    releaseManagedProcessResource(record);
    record.restartIdentityVerified = false;
    record.error = 'Restarted process PID now belongs to a different OS process; Rel.AI will not signal it.';
    try { persistMetadata(config, record); } catch {}
    return 'mismatch';
  }
  record.restartIdentityVerified = true;
  record.error = 'Process survived a Rel.AI restart; OS creation identity was verified, but live pipes and stdin cannot be reattached.';
  try { persistMetadata(config, record); } catch {}
  return 'verified';
}

function restoredProcessIdentityError(record: ManagedProcessRecord, state: 'unverified' | 'mismatch'): Error {
  return Object.assign(
    new Error(state === 'mismatch'
      ? `Managed process ${record.processId} no longer matches its recorded OS process identity; refusing to terminate PID ${record.pid || 0}.`
      : `Managed process ${record.processId} cannot prove that PID ${record.pid || 0} is the process Rel.AI started; refusing to terminate it.`),
    {
      code: state === 'mismatch' ? 'PROCESS_IDENTITY_MISMATCH' : 'PROCESS_IDENTITY_UNVERIFIED',
      retryable: state === 'unverified',
      processId: record.processId
    }
  );
}

function hydrateProcessMetadata(config: ManagedProcessConfig): void {
  const root = processRoot(config);
  const now = Date.now();
  if (now - Number(metadataScanAt.get(root) || 0) < METADATA_RESCAN_INTERVAL_MS) return;
  metadataScanAt.set(root, now);
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || processes.has(entry.name)) continue;
    const record = readMetadata(config, entry.name);
    if (!record) continue;
    reconcileRestoredRecord(config, record);
    processes.set(entry.name, record);
  }
}

function readLogRange(record: ManagedProcessRecord, stream: LogStream, offsetValue: unknown, maxBytes: number): LogRange {
  const file = stream === 'stdout' ? record.stdoutPath : record.stderrPath;
  const totalBytes = Number(record[`${stream}Bytes`] || 0);
  const retainedFromOffset = Number(record[`${stream}StartOffset`] || 0);
  const requestedOffset = Math.max(0, Number(offsetValue) || 0);
  const offset = Math.min(totalBytes, Math.max(retainedFromOffset, requestedOffset));
  try {
    const stat = fs.statSync(file);
    const fileOffset = Math.min(stat.size, Math.max(0, offset - retainedFromOffset));
    const length = Math.min(maxBytes, stat.size - fileOffset, totalBytes - offset);
    const buffer = Buffer.alloc(Math.max(0, length));
    if (length > 0) {
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buffer, 0, length, fileOffset); } finally { fs.closeSync(fd); }
    }
    const decoded = decodeLogBuffer(buffer);
    return {
      requestedOffset,
      offset,
      nextOffset: offset + length,
      totalBytes,
      retainedFromOffset,
      truncatedBefore: requestedOffset < retainedFromOffset,
      truncated: offset + length < totalBytes,
      text: decoded.text,
      encoding: 'utf8',
      ...(decoded.invalidUtf8 ? { invalidUtf8: true, base64: buffer.toString('base64') } : {})
    };
  } catch {
    return {
      requestedOffset,
      offset: retainedFromOffset,
      nextOffset: retainedFromOffset,
      totalBytes,
      retainedFromOffset,
      truncatedBefore: requestedOffset < retainedFromOffset,
      truncated: retainedFromOffset < totalBytes,
      text: '',
      encoding: 'utf8'
    };
  }
}

function decodeLogBuffer(buffer: Buffer): { text: string; invalidUtf8: boolean } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), invalidUtf8: false };
  } catch {
    return { text: buffer.toString('utf8'), invalidUtf8: true };
  }
}

function readLogTail(record: ManagedProcessRecord, stream: LogStream, maxBytes: number): string {
  return readLogTailRange(record, stream, maxBytes).text;
}

function readLogTailRange(record: ManagedProcessRecord, stream: LogStream, maxBytes: number): LogRange {
  const totalBytes = Number(record[`${stream}Bytes`] || 0);
  const start = Math.max(Number(record[`${stream}StartOffset`] || 0), totalBytes - maxBytes);
  return readLogRange(record, stream, start, maxBytes);
}

function fileSize(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function activeProcessesForWorkSession(config: ManagedProcessConfig, workspaceAlias: unknown, workSessionId: unknown): ManagedProcessRecord[] {
  const sessionId = String(workSessionId || '').trim();
  if (!sessionId) return [];
  hydrateProcessMetadata(config);
  return [...processes.values()].filter(item => workspaceMatches(item, workspaceAlias)
    && String(item.workSessionId || '').trim() === sessionId
    && processNeedsTermination(item));
}

interface TaskProcessCleanupResult {
  attempted: number;
  stopped: number;
  preservedPersistent: number;
  complete: boolean;
  admissionBudgetMs: number;
  stopGraceMs: number;
  forceWaitMs: number;
  leftovers: { processId: string; status: string; reason: string }[];
}

async function cleanupTaskManagedProcesses(
  config: ManagedProcessConfig,
  workspaceAlias: string,
  taskId: string,
  context: ManagedProcessContext = {}
): Promise<TaskProcessCleanupResult> {
  const owner = String(taskId || '').trim();
  const workspace = String(workspaceAlias || '').trim();
  if (!owner || !workspace || String(context.taskId || '').trim() !== owner) {
    throw taskError('PROCESS_SESSION_MISMATCH', 'Automatic process cleanup requires the exact owning work_id and workspace.');
  }
  hydrateProcessMetadata(config);
  const records = [...processes.values()].filter(record =>
    path.dirname(path.dirname(record.stdoutPath)) === processRoot(config)
    && workspaceMatches(record, workspace)
    && record.workSessionId === owner);
  const accessArgs = { work_id: owner, workspace };
  const accessContext = { ...context, taskId: owner, workspace };
  const result: TaskProcessCleanupResult = {
    attempted: 0, stopped: 0, preservedPersistent: 0, complete: true,
    admissionBudgetMs: TASK_CLEANUP_BUDGET_MS,
    stopGraceMs: 500, forceWaitMs: DEFAULT_FORCE_WAIT_MS, leftovers: []
  };
  const candidates: ManagedProcessRecord[] = [];
  for (const record of records) {
    if (record.lifecycle !== 'task') {
      if (canAccessProcess(config, record, accessArgs, accessContext)
        && (ACTIVE_STATUSES.has(record.status) || record.status === 'orphaned')) result.preservedPersistent += 1;
      continue;
    }
    if (TERMINAL_STATUSES.has(record.status) && record.terminationConfirmed === true) continue;
    if (!canAccessProcess(config, record, accessArgs, accessContext)) {
      result.leftovers.push({ processId: record.processId, status: record.status, reason: 'Process ownership could not be verified; preserved without signalling.' });
      continue;
    }
    candidates.push(record);
  }
  const deadlineAtMs = Date.now() + TASK_CLEANUP_BUDGET_MS;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(TASK_CLEANUP_CONCURRENCY, candidates.length) }, async () => {
    while (next < candidates.length) {
      const record = candidates[next++]!;
      if (Date.now() >= deadlineAtMs) {
        result.leftovers.push({ processId: record.processId, status: record.status, reason: 'The bounded cleanup budget expired before this process was attempted. Stop this exact processId through the authorized process recovery action.' });
        continue;
      }
      result.attempted += 1;
      try {
        const stopped = await stopManagedProcess(config, { ...accessArgs, processId: record.processId, graceMs: 500 }, accessContext);
        if (stopped.terminationConfirmed === true && TERMINAL_STATUSES.has(stopped.status)) result.stopped += 1;
        else result.leftovers.push({
          processId: record.processId, status: record.status,
          reason: record.terminationError || record.error || 'Descendant termination could not be confirmed; identity and cleanup evidence were retained.'
        });
      } catch (error) {
        result.leftovers.push({
          processId: record.processId, status: record.status,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }));
  result.leftovers.sort((left, right) => left.processId.localeCompare(right.processId));
  result.complete = result.leftovers.length === 0;
  return result;
}

async function stopAllManagedProcesses(config: ManagedProcessConfig): Promise<{ stopped: number; attempted: number; orphaned: number }> {
  hydrateProcessMetadata(config);
  await Promise.all([...processes.values()]
    .filter(record => record.status === 'orphaned' && record.runtimeId !== RUNTIME_ID)
    .map(record => verifyRestoredProcessIdentity(config, record).catch(() => 'unverified')));
  const active = [...processes.values()].filter(processNeedsTermination);
  const results = await Promise.all(active.map(item => stopManagedProcess(config, {
    processId: item.processId,
    graceMs: 1000
  }, { internal: true }).catch(() => null)));
  await Promise.all([...processes.values()].map(item => flushManagedProcessPersistence(config, item)));
  return {
    stopped: results.filter(item => item && TERMINAL_STATUSES.has(item.status)).length,
    attempted: active.length,
    orphaned: results.filter(item => item?.status === 'orphaned').length
  };
}

function pruneManagedProcesses(config: unknown): { removed: number } {
  const processConfig = asManagedProcessConfig(config);
  const root = processRoot(processConfig);
  const now = Date.now();
  if (now - Number(metadataPruneAt.get(root) || 0) < METADATA_PRUNE_INTERVAL_MS) return { removed: 0 };
  metadataPruneAt.set(root, now);
  if (!fs.existsSync(root)) return { removed: 0 };
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = processes.get(entry.name) || readMetadata(processConfig, entry.name);
    if (!record) continue;
    reconcileRestoredRecord(processConfig, record);
    const timestamp = Date.parse(String(record.endedAt || record.startedAt || 0));
    if (TERMINAL_STATUSES.has(record.status) && Date.now() - timestamp > RECENT_RETENTION_MS) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      processes.delete(entry.name);
      notifyProcessState({ processId: entry.name, status: 'removed' });
      removed += 1;
    }
  }
  return { removed };
}

async function cleanupFailedStartup(config: ManagedProcessConfig, record: ManagedProcessRecord): Promise<ProcessTreeTerminationResult> {
  // A concurrent cancellation may already own this stop. Never erase its
  // confirmed tree-exit evidence by re-probing a root that it just terminated.
  if (record.stopPromise) await record.stopPromise;
  if (record.terminationConfirmed === true) return { exited: true, forced: false };
  if (!record.child && !record.ptyProcess && !record.pid) {
    await drainLogWrites(config, record);
    return { exited: true, forced: false };
  }
  const result = await stopRecordInternal(config, record, { graceMs: 0, forceWaitMs: DEFAULT_FORCE_WAIT_MS });
  return {
    exited: result.terminationConfirmed === true,
    forced: result.signal === 'SIGKILL',
    ...(record.terminationError ? { error: record.terminationError } : {})
  };
}

function processNeedsTermination(record: ManagedProcessRecord): boolean {
  if (ACTIVE_STATUSES.has(record.status)) return true;
  if (record.status === 'orphaned') {
    if (record.windowsJobOwned && record.terminationConfirmed !== true) return true;
    if (record.runtimeId !== RUNTIME_ID && !record.restartIdentityVerified) return false;
    return isProcessTreeAlive(record.pid);
  }
  return false;
}

async function terminateManagedRecord(record: ManagedProcessRecord, options: StopRecordOptions = {}): Promise<ProcessTreeTerminationResult> {
  if (record.windowsJobOwned) {
    if (!record.windowsJob) return { exited: false, forced: false, error: 'Native Windows job control identity is unavailable.' };
    const outcome = await record.windowsJob.stop('stop', Number(options.forceWaitMs) || DEFAULT_FORCE_WAIT_MS);
    if (outcome.exited && record.ptyProcess) {
      await waitForPtyExit(record.ptyExitPromise, 1000);
      await disposeNodePtyResources(record.ptyProcess);
    }
    return outcome;
  }
  if (record.ptyProcess) {
    const ptyProcess = record.ptyProcess;
    const exitPromise = record.ptyExitPromise;
    // Terminate the tree while its root still exists. PTY onExit proves only
    // root exit and must not be promoted to descendant cleanup confirmation.
    const outcome = await terminateProcessTree(record.pid, options);
    if (outcome.exited) {
      try { ptyProcess.kill(); } catch {}
      await waitForPtyExit(exitPromise, 250);
      await disposeNodePtyResources(ptyProcess);
    }
    return outcome;
  }
  const child = record.child;
  if (!child) return terminateProcessTree(record.pid, options);
  const closeWaiter = observeChildClose(child);
  const outcome = await terminateProcessTree(child, options);
  if (outcome.exited) {
    const closedNaturally = await waitForChildClose(closeWaiter.promise, 500);
    if (!closedNaturally) {
      disposeChildProcessStreams(child);
      const closedAfterStreamDisposal = await waitForChildClose(closeWaiter.promise, 1000);
      if (!closedAfterStreamDisposal) child.unref?.();
    }
  }
  closeWaiter.dispose();
  return outcome;
}

function observeChildClose(child: ChildProcess): { promise: Promise<void>; dispose(): void } {
  let settled = false;
  let resolveClose: (() => void) | null = null;
  const promise = new Promise<void>(resolve => { resolveClose = resolve; });
  const onClose = () => {
    if (settled) return;
    settled = true;
    resolveClose?.();
  };
  child.once('close', onClose);
  return {
    promise,
    dispose() {
      child.off?.('close', onClose);
      if (!settled) {
        settled = true;
        resolveClose?.();
      }
    }
  };
}

function waitForChildClose(closePromise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    closePromise.then(() => true),
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      timer.unref?.();
    })
  ]);
}

function disposeChildProcessStreams(child: ChildProcess): void {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    if (!stream || stream.destroyed || typeof stream.destroy !== 'function') continue;
    try { stream.destroy(); } catch {}
  }
}

async function disposeNodePtyResources(ptyProcess: PtyProcess): Promise<void> {
  if (process.platform !== 'win32') return;
  // node-pty 1.1.0 leaves its WinPTY conout worker alive after kill(). Rel.AI
  // pins that version, so close the worker deterministically instead of keeping
  // the MCP service event loop alive after an interactive process ends.
  const worker = ptyProcess?._agent?._conoutSocketWorker;
  if (!worker) return;
  try {
    if (typeof worker._destroySocket === 'function') await worker._destroySocket();
    else if (typeof worker.dispose === 'function') worker.dispose();
  } catch {}
}

function waitForPtyExit(exitPromise: Promise<PtyExitEvent> | null, timeoutMs: number): Promise<boolean> {
  if (!exitPromise || typeof exitPromise.then !== 'function') return Promise.resolve(false);
  return Promise.race([
    exitPromise.then(() => true),
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      timer.unref?.();
    })
  ]);
}

function onManagedProcessChange(listener: ManagedProcessListener): () => boolean | void {
  if (typeof listener !== 'function') return () => {};
  processStateListeners.add(listener);
  return () => processStateListeners.delete(listener);
}

function managedProcessStateRevision(): number {
  return processStateVersion;
}

function notifyProcessState(record: Omit<Partial<ManagedProcessRecord>, 'status'> & { processId: string; status: string }): void {
  processStateVersion += 1;
  const event = {
    revision: processStateVersion,
    processId: String(record?.processId || ''),
    status: String(record?.status || ''),
    workspace: String(record?.workspaceId || ''),
    workId: String(record?.workSessionId || ''),
    principalFingerprint: String(record?.principalKey || ''),
    label: String(record?.label || record?.purpose || ''),
    exitCode: record?.exitCode ?? null
  };
  publishProcessLifecycleEvent(event);
  for (const listener of processStateListeners) {
    try { listener(event); }
    catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] process state listener:', error); }
  }
}

function cancellationError(message: string): Error & { cancelled: boolean } {
  const error = taskError('TASK_CANCELLED', message);
  error.cancelled = true;
  return error;
}

function loadNodePty(): Promise<NodePtyApi> {
  if (!nodePtyPromise) nodePtyPromise = importNodePty().catch(error => {
    nodePtyPromise = null;
    throw error;
  });
  return nodePtyPromise;
}

async function importNodePty(): Promise<NodePtyApi> {
  let firstError;
  try {
    return normalizeNodePty(await import('node-pty'));
  } catch (error) {
    firstError = error;
  }
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'node_modules', 'node-pty', 'lib', 'index.js') : '',
    path.resolve(moduleDirectory, '..', 'electron', 'node_modules', 'node-pty', 'lib', 'index.js')
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try { return normalizeNodePty(await import(pathToFileURL(candidate).href)); }
    catch {}
  }
  throw new Error('PTY support requires the packaged node-pty runtime. Reinstall Rel.AI or run the Electron dependency install before using pty:true.', { cause: firstError || undefined });
}

function normalizeNodePty(module: unknown): NodePtyApi {
  const candidate = asRecord(module);
  const api = typeof candidate.spawn === 'function' ? candidate : asRecord(candidate.default);
  if (typeof api.spawn !== 'function') throw new Error('node-pty did not expose a spawn function.');
  return api as unknown as NodePtyApi;
}

function asRecord(value: unknown): GenericRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as GenericRecord : {};
}

function asManagedProcessConfig(value: unknown): ManagedProcessConfig {
  return asRecord(value) as ManagedProcessConfig;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

export {
  activeProcessesForWorkSession,
  cleanupTaskManagedProcesses,
  listManagedProcesses,
  managedProcessStateRevision,
  onManagedProcessChange,
  pruneManagedProcesses,
  readManagedProcess,
  readManagedProcessLogRange,
  sampleManagedProcessMemory,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
  writeManagedProcess
};
