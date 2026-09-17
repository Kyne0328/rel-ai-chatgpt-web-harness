import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { combineAbortSignals } from './abortSignals.ts';
import { createManagedProcessList, type ManagedProcessDto, type ProcessState } from './contracts/processes.ts';
import { readJsonFile, writeJsonAtomic, writeJsonAtomicAsync } from './durableState.ts';
import { normalizeExecutionInvocation, resolveCommandCwd, normalizeCommandEnv } from './executionInvocation.ts';
import { redactCommandForAudit } from './commandDisplay.ts';
import { isProcessTreeAlive, terminateProcessTree, type ProcessTreeTerminationResult } from './process.ts';
import { makeProcessEnvironment } from './processEnvironment.js';
import { createHttpTaskPrincipal, principalFingerprint } from './mcp/principal.ts';
import { getStateDir } from './statePaths.js';
import { readTaskHistorySession } from './taskHistoryStore.ts';
import { runSpan, addSpanEvent, traceContextEnvironment } from './telemetry.ts';
import { measurePerformancePhase, measurePerformancePhaseSync } from './performanceObservability.ts';
import type { TelemetryConfig } from './telemetry.types.ts';
import { getCurrentTaskAbortSignal, taskError } from './toolActivity.js';
import { isActiveProcessStatus, isTerminalProcessStatus, normalizeProcessLifecycleStatus } from './runtimeLifecycle.js';
import { HOST_PERSISTENT_PROCESS_LIMIT, acquireHostResource, hostResourceStats } from './hostResourceScheduler.js';

type LogStream = 'stdout' | 'stderr';
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
  readonly pty?: unknown;
  readonly columns?: unknown;
  readonly rows?: unknown;
  readonly cwd?: unknown;
  readonly env?: unknown;
  readonly work_id?: unknown;
  readonly _operationTaskId?: unknown;
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
  readonly activeOnly?: unknown;
  readonly limit?: unknown;
  readonly taskId?: unknown;
}

interface ManagedProcessContext extends GenericRecord {
  readonly taskId?: unknown;
  readonly nativeTaskId?: unknown;
  readonly signal?: AbortSignal;
  readonly principal?: unknown;
  readonly workspace?: unknown;
  readonly connector?: boolean;
  readonly internal?: boolean;
  readonly mcp?: { readonly authInfo?: unknown };
  readonly authInfo?: unknown;
  readonly authMode?: unknown;
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
}

interface ManagedProcessRecord extends GenericRecord {
  schemaVersion: number;
  runtimeId: string;
  processId: string;
  workspaceId: string;
  workspacePath: string;
  originatingTaskId: string;
  workSessionId: string;
  principalKey: string;
  reuseFingerprint: string;
  lifecycle: string;
  kind: string;
  purpose: string;
  command?: string;
  commandSummary: string;
  label: string;
  cwd: string;
  status: ProcessState;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  signal: string;
  error?: string;
  pid?: number | null;
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
}

interface ProcessSnapshotOptions {
  readonly includeTail?: boolean;
  readonly tailBytes?: number;
}

interface ProcessAccessOptions {
  readonly requireSession?: boolean;
}

interface StopRecordOptions {
  readonly graceMs?: unknown;
  readonly forceWaitMs?: unknown;
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

const PROCESS_SCHEMA_VERSION = 3;
const RUNTIME_ID = crypto.randomUUID();
const RECENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_STARTUP_WAIT_MS = 750;
const DEFAULT_STOP_GRACE_MS = 3000;
const DEFAULT_FORCE_WAIT_MS = 2000;
const METADATA_FLUSH_DELAY_MS = 50;
const METADATA_RESCAN_INTERVAL_MS = 30_000;
const METADATA_PRUNE_INTERVAL_MS = 60_000;
const LOG_FLUSH_DELAY_MS = 10;
const LOG_FLUSH_MAX_BYTES = 64 * 1024;
const LOG_PENDING_HIGH_WATER_BYTES = 1024 * 1024;
const LOG_PENDING_LOW_WATER_BYTES = 256 * 1024;
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
  const originatingTaskId = String(context.nativeTaskId || args._operationTaskId || '').trim();
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
    pty,
    columns,
    rows,
    environment: Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
  });
  const admissionSignal = combineAbortSignals(context.signal, getCurrentTaskAbortSignal());
  const releaseReuseReservation = args.reuseExisting === false
    ? null
    : await acquireManagedProcessReuseReservation(reuseFingerprint, admissionSignal);
  try {
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
    await reserveRestoredManagedProcessCapacity(config, admissionSignal);
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
    originatingTaskId,
    workSessionId,
    principalKey,
    reuseFingerprint,
    lifecycle: 'persistent',
    kind,
    purpose,
    command: invocation.displayCommand,
    commandSummary: redactCommandForAudit(invocation.displayCommand),
    label: String(args.label || '').trim().slice(0, 120) || redactCommandForAudit(invocation.displayCommand),
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
    queueWaitMs: 0
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
    'relai.process.command': record.commandSummary,
    'relai.process.pty': pty
  }, async () => {
    const { childEnvironment, startupSignal } = measurePerformancePhaseSync('process.setup', () => {
      const childEnvironment = makeProcessEnvironment(env, { allow: config.processEnvironment?.allow });
      Object.assign(childEnvironment, traceContextEnvironment());
      const startupSignal = admissionSignal;
      return { childEnvironment, startupSignal };
    });
    let child: ChildProcess | undefined;
    let initialState: Promise<InitialProcessState>;
    try {
      let resourceLease: HostResourceLease;
      try {
        resourceLease = await acquireHostResource('persistent', workspace.alias, { signal: startupSignal });
      } catch (error) {
        if (errorCode(error) === 'HOST_RESOURCE_ABORTED') {
          throw cancellationError('Managed process startup was cancelled while waiting for host capacity.');
        }
        throw error;
      }
      record.hostResourceRelease = resourceLease.release;
      record.queueWaitMs = resourceLease.waitMs;
      if (record.pty) {
        const ptyProcess = await measurePerformancePhase('process.spawn', async () => {
          const nodePty = await loadNodePty();
          return nodePty.spawn(invocation.processExecutable, invocation.processArgv, {
            name: String(process.env.TERM || 'xterm-256color'),
            cwd: cwd.absolutePath,
            env: childEnvironment,
            cols: record.columns,
            rows: record.rows,
            ...(process.platform === 'win32' ? { useConpty: false } : {})
          });
        });
        record.ptyProcess = ptyProcess;
        record.pid = ptyProcess.pid || null;
        record.status = 'running';
        record.ptyExitPromise = new Promise<PtyExitEvent>(resolve => { record.resolvePtyExit = resolve; });
        ptyProcess.onData(data => appendLog(config, record, 'stdout', data));
        ptyProcess.onExit(event => {
          record.resolvePtyExit?.(event);
          finishRecord(config, record, {
            status: record.status === 'stopping' ? 'stopped' : (event.exitCode === 0 ? 'exited' : 'failed'),
            exitCode: Number.isInteger(event.exitCode) ? event.exitCode : -1,
            signal: event.signal ? String(event.signal) : ''
          });
        });
        initialState = Promise.resolve({ type: 'spawned' });
        addSpanEvent('process.spawned', { 'process.pid': record.pid || 0, 'process.pty': true });
      } else {
        child = measurePerformancePhaseSync('process.spawn', () => spawn(invocation.processExecutable, invocation.processArgv, {
          cwd: cwd.absolutePath,
          env: childEnvironment,
          detached: process.platform !== 'win32',
          windowsHide: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe']
        }));
        record.child = child;
        record.logSources.stdout = child.stdout || null;
        record.logSources.stderr = child.stderr || null;
        record.pid = child.pid || null;
        initialState = observeInitialProcessState(child, startupSignal);
        child.stdout?.on('data', chunk => appendLog(config, record, 'stdout', chunk));
        child.stderr?.on('data', chunk => appendLog(config, record, 'stderr', chunk));
        child.once('spawn', () => {
          if (record.status !== 'starting') return;
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
      record.discarded = true;
      record.persistenceFailureHandled = true;
      clearScheduledPersist(record);
      await terminateManagedRecord(record, { graceMs: 0, forceWaitMs: DEFAULT_FORCE_WAIT_MS }).catch(() => null);
      releaseManagedProcessResource(record);
      record.child = null;
      record.ptyProcess = null;
      processes.delete(processId);
      fs.rmSync(directory, { recursive: true, force: true });
      throw new Error(`Could not persist managed process record: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    const initial = await measurePerformancePhase('process.readiness', () => initialState);
    if (initial.type === 'aborted') {
      await stopRecordInternal(config, record, { graceMs: DEFAULT_STOP_GRACE_MS });
      throw cancellationError('Managed process startup was cancelled before readiness was established.');
    }
    if (initial.type === 'error') {
      await cleanupFailedStartup(config, record);
      throw new Error(`Could not start managed process: ${initial.error?.message || 'spawn failed'}`);
    }
    if (initial.type === 'closed') {
      await cleanupFailedStartup(config, record);
      throw new Error(`Managed process exited during startup with code ${initial.code ?? -1}.`);
    }

    if (invocation.input !== undefined) {
      try {
        await writeInitialProcessInput(record, invocation.input);
      } catch (error) {
        await cleanupFailedStartup(config, record);
        throw new Error(`Could not send initial managed process input: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    const startupWaitMs = clampNumber(args.startupWaitMs, 0, 30000, DEFAULT_STARTUP_WAIT_MS);
    const startupResult = await measurePerformancePhase(
      'process.readiness',
      () => waitDuringStartup(record, startupWaitMs, startupSignal)
    );
    if (startupResult === 'aborted') {
      await stopRecordInternal(config, record, { graceMs: DEFAULT_STOP_GRACE_MS });
      throw cancellationError('Managed process startup was cancelled.');
    }
    if (startupResult === 'closed') {
      await cleanupFailedStartup(config, record);
      throw new Error(`Managed process exited during startup with code ${record.exitCode ?? -1}.`);
    }

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
    releaseReuseReservation?.();
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

function writeInitialProcessInput(record: ManagedProcessRecord, input: unknown): Promise<void> {
  if (record.pty) {
    if (!record.ptyProcess || !['starting', 'running'].includes(record.status)) {
      throw new Error(`Process ${record.processId} does not have writable PTY input.`);
    }
    record.ptyProcess.write(String(input));
    return Promise.resolve();
  }
  const stream = record.child?.stdin;
  if (!stream || stream.destroyed || !['starting', 'running'].includes(record.status)) {
    throw new Error(`Process ${record.processId} does not have writable stdin.`);
  }
  return new Promise<void>((resolve, reject) => {
    stream.write(input, error => {
      if (error) reject(error);
      else resolve();
    });
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
      record.logPendingBytes[stream] = Math.max(0, record.logPendingBytes[stream] - buffer.length);
      resumeLogSourceIfReady(record, stream);
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

async function writeManagedProcess(config: ManagedProcessConfig, args: ManagedProcessArgs = {}, context: ManagedProcessContext = {}) {
  const record = requireProcess(config, args.processId);
  assertProcessAccess(config, record, args, context);
  if (!['starting', 'running'].includes(record.status)) throw new Error(`Process ${record.processId} is not accepting input.`);
  const hasInput = args.input !== undefined;
  const hasResize = args.columns !== undefined || args.rows !== undefined;
  if (!hasInput && !hasResize) throw new Error('relai_process action "write" requires input or PTY columns+rows.');
  if (hasResize) {
    if (!record.pty || !record.ptyProcess) throw new Error('PTY resize requires a running pty:true process.');
    if (args.columns === undefined || args.rows === undefined) throw new Error('PTY resize requires both columns and rows.');
    const columns = clampNumber(args.columns, 1, 1000, record.columns || 80);
    const rows = clampNumber(args.rows, 1, 1000, record.rows || 24);
    record.ptyProcess.resize(columns, rows);
    record.columns = columns;
    record.rows = rows;
    await queueMetadataPersist(config, record);
    notifyProcessState(record);
  }
  let bytes = 0;
  if (hasInput) {
    const input = String(args.input ?? '');
    bytes = Buffer.byteLength(input, 'utf8');
    if (bytes > 1024 * 1024) throw new Error('Process input exceeds 1 MiB.');
    if (record.pty) {
      if (!record.ptyProcess) throw new Error(`Process ${record.processId} does not have writable PTY input.`);
      record.ptyProcess.write(input);
    } else {
      const stream = record.child?.stdin;
      if (!stream || stream.destroyed) throw new Error(`Process ${record.processId} does not have writable stdin.`);
      await new Promise<void>((resolve, reject) => {
        stream.write(input, error => {
          if (error) reject(error);
          else resolve();
        });
      });
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
  const duplicate = TERMINAL_STATUSES.has(record.status);
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

async function stopRecordInternal(config: ManagedProcessConfig, record: ManagedProcessRecord, options: StopRecordOptions = {}) {
  const target = record.child || record.pid;
  if (!target || !isProcessTreeAlive(target)) {
    if (!TERMINAL_STATUSES.has(record.status)) {
      finishRecord(config, record, {
        status: 'stopped',
        exitCode: record.exitCode,
        signal: record.signal || 'unobserved'
      });
    }
    await flushManagedProcessPersistence(config, record);
    return processSnapshot(record);
  }

  record.status = 'stopping';
  safePersistMetadata(config, record);
  notifyProcessState(record);
  const outcome = await terminateManagedRecord(record, {
    graceMs: clampNumber(options.graceMs, 0, 30000, DEFAULT_STOP_GRACE_MS),
    forceWaitMs: DEFAULT_FORCE_WAIT_MS
  });

  if (!outcome.exited) {
    record.status = 'orphaned';
    record.error = 'Managed process termination could not be confirmed.';
    safePersistMetadata(config, record);
    notifyProcessState(record);
  } else if (record.status === 'stopping') {
    finishRecord(config, record, {
      status: 'stopped',
      exitCode: typeof record.exitCode === 'number' ? record.exitCode : -1,
      signal: outcome.forced ? 'SIGKILL' : 'SIGTERM'
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
  const includeTerminal = args.includeTerminal === true || explicitTerminalStatus;
  const activeOnly = args.activeOnly !== false && !includeTerminal;
  const items = [...processes.values()]
    .filter(item => canAccessProcess(config, item, args, context, { requireSession: false }))
    .filter(item => !requestedWorkspace || workspaceMatches(item, requestedWorkspace))
    .filter(item => !status || item.status === status)
    .filter(item => !activeOnly || ACTIVE_STATUSES.has(item.status) || item.status === 'orphaned')
    .filter(item => includeTerminal || !TERMINAL_STATUSES.has(item.status))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .slice(0, clampNumber(args.limit, 1, 500, 100))
    .map(item => processSnapshot(item));
  return createManagedProcessList(items);
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

function managedProcessReuseFingerprint({ workspaceId = '', workSessionId = '', principalKey = '', executionMode = '', command = '', input = '', cwd = '.', kind = '', purpose = '', pty = false, columns = 80, rows = 24, environment = [] }: ReuseFingerprintInput = {}): string {
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
    && record.lifecycle === 'persistent'
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
  await previous;
  if (signal?.aborted) {
    releaseCurrent();
    if (processReuseReservations.get(reuseFingerprint) === tail) processReuseReservations.delete(reuseFingerprint);
    throw cancellationError('Managed process startup was cancelled while waiting to reuse an existing process.');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (processReuseReservations.get(reuseFingerprint) === tail) processReuseReservations.delete(reuseFingerprint);
  };
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
    return principalFingerprint(createHttpTaskPrincipal({ ...authInfo, clientId }, String(authInfo.authMode || context.authMode || '')));
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
  const result: ManagedProcessDto & GenericRecord = {
    ok: !['failed', 'orphaned'].includes(record.status),
    processId: record.processId,
    pid: record.pid || null,
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
    originatingTaskId: record.originatingTaskId || null,
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
    result.stdoutTail = readLogTail(record, 'stdout', options.tailBytes || 8192);
    result.stderrTail = readLogTail(record, 'stderr', options.tailBytes || 8192);
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
    Number(record.stdoutDroppedBytes || 0),
    Number(record.stderrDroppedBytes || 0),
    record.pty === true,
    Number(record.columns || 0),
    Number(record.rows || 0)
  ])).digest('base64url').slice(0, 16);
}

function finishRecord(config: ManagedProcessConfig, record: ManagedProcessRecord, fields: Partial<ManagedProcessRecord>): void {
  if (TERMINAL_STATUSES.has(record.status) && record.endedAt) return;
  clearScheduledPersist(record);
  resumeLogSources(record);
  releaseManagedProcessResource(record);
  Object.assign(record, fields, { endedAt: new Date().toISOString() });
  record.child = null;
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
    originatingTaskId: record.originatingTaskId || '',
    workSessionId: record.workSessionId || '',
    principalKey: record.principalKey || '',
    reuseFingerprint: record.reuseFingerprint || '',
    lifecycle: record.lifecycle || 'persistent',
    kind: record.kind || 'service',
    purpose: record.purpose || '',
    commandSummary: record.commandSummary,
    label: record.label,
    cwd: record.cwd,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt || '',
    exitCode: record.exitCode,
    signal: record.signal || '',
    error: record.error || '',
    pid: record.pid || null,
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
    void queueMetadataPersist(config, record);
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
  void terminateManagedRecord(record, { graceMs: 0, forceWaitMs: DEFAULT_FORCE_WAIT_MS })
    .then(outcome => {
      record.status = outcome.exited ? 'failed' : 'orphaned';
      if (outcome.exited) record.endedAt = new Date().toISOString();
      record.child = null;
      record.ptyProcess = null;
      try { persistMetadata(config, record); } catch {}
    })
    .catch(() => {
      record.status = 'orphaned';
      record.child = null;
      record.ptyProcess = null;
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
      originatingTaskId: String(metadata.originatingTaskId || ''),
      workSessionId: String(metadata.workSessionId || metadata.logicalTaskId || ''),
      principalKey: String(metadata.principalKey || ''),
      reuseFingerprint: String(metadata.reuseFingerprint || ''),
      lifecycle: String(metadata.lifecycle || 'persistent'),
      kind: ['service', 'watcher', 'interactive'].includes(String(metadata.kind || '')) ? String(metadata.kind) : 'service',
      purpose: String(metadata.purpose || ''),
      commandSummary: String(metadata.commandSummary || ''),
      label: String(metadata.label || metadata.commandSummary || processId),
      cwd: String(metadata.cwd || '.'),
      status: normalizeProcessLifecycleStatus(metadata.status) || 'orphaned',
      startedAt: String(metadata.startedAt || ''),
      endedAt: String(metadata.endedAt || ''),
      exitCode: typeof metadata.exitCode === 'number' ? metadata.exitCode : null,
      signal: String(metadata.signal || ''),
      error: String(metadata.error || ''),
      pid: Number.isSafeInteger(Number(metadata.pid)) ? Number(metadata.pid) : null,
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
      queueWaitMs: 0
    };
  } catch {
    return null;
  }
}

function reserveRestoredManagedProcessCapacity(config: ManagedProcessConfig, signal?: AbortSignal): Promise<void> {
  const previous = restoredCapacityReservation;
  const next = previous.then(() => reserveRestoredManagedProcessCapacityInternal(config, signal));
  restoredCapacityReservation = next.catch(() => undefined);
  return next;
}

async function reserveRestoredManagedProcessCapacityInternal(config: ManagedProcessConfig, signal?: AbortSignal): Promise<void> {
  const restored = [...processes.values()].filter(record => record.status === 'orphaned' && record.runtimeId !== RUNTIME_ID);
  const live = [];
  for (const record of restored) {
    if (record.pid && isProcessTreeAlive(record.pid)) {
      live.push(record);
      continue;
    }
    releaseManagedProcessResource(record);
    record.status = 'stopped';
    record.endedAt = record.endedAt || new Date().toISOString();
    record.signal = record.signal || 'unobserved_restart';
    try { persistMetadata(config, record); } catch {}
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
      { code: 'HOST_PROCESS_CAPACITY_EXHAUSTED', retryable: true }
    );
  }
}

function reconcileRestoredRecord(config: ManagedProcessConfig, record: ManagedProcessRecord): ManagedProcessRecord {
  if (record.runtimeId === RUNTIME_ID && processes.has(record.processId)) return record;
  if (!isActiveProcessStatus(record.status) && record.status !== 'orphaned') return record;
  if (record.pid && isProcessTreeAlive(record.pid)) {
    record.status = 'orphaned';
    record.error = record.error || 'Process survived a Rel.AI restart; live pipes and stdin cannot be reattached.';
  } else {
    record.status = 'stopped';
    record.endedAt = record.endedAt || new Date().toISOString();
    record.signal = record.signal || 'unobserved_restart';
  }
  try { persistMetadata(config, record); } catch {}
  return record;
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
  const totalBytes = Number(record[`${stream}Bytes`] || 0);
  const start = Math.max(Number(record[`${stream}StartOffset`] || 0), totalBytes - maxBytes);
  return readLogRange(record, stream, start, maxBytes).text;
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

async function stopAllManagedProcesses(config: ManagedProcessConfig): Promise<{ stopped: number; attempted: number; orphaned: number }> {
  hydrateProcessMetadata(config);
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
  const target = record.child || record.pid;
  if (!target) {
    await drainLogWrites(config, record);
    return { exited: true, forced: false };
  }
  const outcome = await terminateManagedRecord(record, {
    graceMs: 0,
    forceWaitMs: DEFAULT_FORCE_WAIT_MS
  });
  if (!outcome.exited) {
    record.status = 'orphaned';
    record.error = 'Managed process startup failed and descendant termination could not be confirmed.';
    safePersistMetadata(config, record);
  }
  await drainLogWrites(config, record);
  return outcome;
}

function processNeedsTermination(record: ManagedProcessRecord): boolean {
  if (ACTIVE_STATUSES.has(record.status)) return true;
  if (record.status === 'orphaned') return isProcessTreeAlive(record.pid);
  return false;
}

async function terminateManagedRecord(record: ManagedProcessRecord, options: StopRecordOptions = {}): Promise<ProcessTreeTerminationResult> {
  if (record.ptyProcess) {
    const ptyProcess = record.ptyProcess;
    const exitPromise = record.ptyExitPromise;
    try { ptyProcess.kill(); } catch {}
    const graceMs = clampNumber(options.graceMs, 0, 30000, DEFAULT_STOP_GRACE_MS);
    const exited = await waitForPtyExit(exitPromise, Math.max(250, graceMs));
    await disposeNodePtyResources(ptyProcess);
    if (exited) {
      return { exited: true, forced: false };
    }
    const fallback = await terminateProcessTree(record.pid, {
      graceMs: 0,
      forceWaitMs: clampNumber(options.forceWaitMs, 0, 30000, DEFAULT_FORCE_WAIT_MS)
    });
    await waitForPtyExit(exitPromise, 250);
    return fallback;
  }
  return terminateProcessTree(record.child || record.pid, options);
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

function notifyProcessState(record: Pick<ManagedProcessRecord, 'processId' | 'status'> | { processId: string; status: string }): void {
  processStateVersion += 1;
  const event = {
    revision: processStateVersion,
    processId: String(record?.processId || ''),
    status: String(record?.status || '')
  };
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
  listManagedProcesses,
  managedProcessStateRevision,
  onManagedProcessChange,
  pruneManagedProcesses,
  readManagedProcess,
  startManagedProcess,
  stopAllManagedProcesses,
  stopManagedProcess,
  writeManagedProcess
};
