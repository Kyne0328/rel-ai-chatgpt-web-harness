import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { execa, type Options as ExecaOptions } from 'execa';
import { prepareWindowsProcessJob, type WindowsProcessJob } from './windowsProcessJob.ts';
import { resolveGitExecutable } from './gitExecutable.js';
import { isTimeoutAbort } from './abortSignals.js';
import { executionOutcome } from './executionOutcome.js';
import { makeProcessEnvironment } from './processEnvironment.js';
import { extensionCommandPathEntries } from './extensions/paths.js';
import { getStateDir } from './statePaths.js';
import { traceContextEnvironment } from './telemetry.js';
import { createOutputSpillWriter } from './outputSpill.js';
import { acquireHostResource } from './hostResourceScheduler.js';
import { clearCurrentMutationProcess, markCurrentMutationProcessUncertain, prepareCurrentMutationProcess, recordCurrentMutationProcess, runWithoutMutationProcessOwnership } from './mutationProcessOwnership.js';

const internalObservationOutcomes = new WeakSet<object>();
const ownedReadOnlyProcessOptions = new WeakSet<object>();
const unsettledReadOnlyProcessJobs = new WeakMap<object, { job: WindowsProcessJob; controllerClosed: () => boolean }>();

function internalReadOnlyProcessOutcome<T extends object>(value: T): T {
  internalObservationOutcomes.add(value);
  return value;
}

function isInternalReadOnlyProcessOutcome(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && internalObservationOutcomes.has(value));
}

const TASKKILL_EXE = String.raw`C:\Windows\System32\taskkill.exe`;
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const DEFAULT_FORCE_WAIT_MS = 2000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 2000;
const DEFAULT_OUTPUT_FINALIZATION_TIMEOUT_MS = 2000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DISABLED_GIT_HOOKS_PATH = `.disabled-git-hooks-${process.pid}-${crypto.randomBytes(12).toString('hex')}`;

interface ProcessTargetLike {
  readonly pid?: number | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signalCode?: NodeJS.Signals | string | null | undefined;
  kill?(signal?: NodeJS.Signals | number): boolean;
}

type ProcessTarget = number | ProcessTargetLike | null | undefined;

interface ProcessTreeTerminationOptions {
  readonly graceMs?: unknown;
  readonly forceWaitMs?: unknown;
  readonly signal?: NodeJS.Signals | string;
  readonly force?: boolean;
}

interface ProcessTreeTerminationResult {
  readonly exited: boolean;
  readonly forced: boolean;
  readonly gracefulSignalSent?: boolean;
  readonly forceSignalSent?: boolean;
  readonly error?: string;
}

interface ProcessEnvironmentConfig {
  readonly allow?: unknown;
}

interface ProcessRuntimeConfig extends Record<string, unknown> {
  readonly processEnvironment?: ProcessEnvironmentConfig;
  readonly processTerminationGraceMs?: unknown;
  readonly processForceWaitMs?: unknown;
  readonly processOutputFinalizationTimeoutMs?: unknown;
}

interface ProcessPhaseEvent {
  readonly phase: 'host-queued' | 'spawned' | 'exited' | 'draining-output' | 'drained';
  readonly atMs: number;
  readonly executed: boolean;
  readonly rootExitConfirmed?: boolean;
  readonly terminationConfirmed?: boolean;
  readonly outputFinalizationTimedOut?: boolean;
}

interface RunProcessOptions {
  // Internal native subprocesses whose ownership must predate execution even
  // outside an ambient mutation context (for example extension installers).
  readonly nativeOwnership?: boolean;
  readonly resourceClass?: unknown;
  readonly resourceOwner?: unknown;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly queueTimeoutMs?: unknown;
  readonly maxOutputBytes?: unknown;
  readonly outputSpillTaskId?: unknown;
  readonly timeout?: unknown;
  readonly deadlineAtMs?: unknown;
  readonly terminationGraceMs?: unknown;
  readonly forceWaitMs?: unknown;
  readonly shell?: boolean;
  readonly commandString?: string;
  readonly env?: Record<string, unknown>;
  readonly inheritCredentials?: boolean;
  readonly input?: unknown;
  readonly preserveOutputWhitespace?: boolean;
  readonly outputFinalizationTimeoutMs?: unknown;
  readonly onPhase?: (event: ProcessPhaseEvent) => void;
}

/** Process outcomes are part of the exported process API contract. */
export interface RunProcessResult {
  readonly executed: boolean;
  readonly exitCode: number;
  readonly observedExitCode?: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly cancelled?: boolean;
  readonly timedOut: boolean;
  readonly queueTimedOut?: boolean;
  readonly admissionBlocked?: boolean;
  readonly errorCode?: string;
  readonly blockedResource?: string;
  readonly resourceReason?: string;
  readonly retryable?: boolean;
  readonly resourcePressure?: Readonly<Record<string, unknown>>;
  readonly spawnError?: boolean;
  readonly terminationConfirmed?: boolean;
  readonly rootExitConfirmed?: boolean;
  readonly outputFinalizationTimedOut?: boolean;
  readonly outputFinalizationError?: string;
  readonly mutationOwnershipPersistenceError?: string;
  readonly forcedTermination?: boolean;
  readonly queueWaitMs: number;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutOutputRef?: string;
  readonly stderrOutputRef?: string;
  readonly stdoutSpillTruncated?: boolean;
  readonly stderrSpillTruncated?: boolean;
}

interface TerminationRequest {
  readonly marker: string;
  readonly error: string;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

interface ResourceLease {
  readonly waitMs?: number;
  release(): void;
}

interface OutputSpillResult {
  readonly outputRef: string;
  readonly spillTruncated?: boolean;
  readonly finalizationTimedOut?: boolean;
}

interface OutputSpillWriter {
  start(buffer: Buffer): void;
  append(buffer: Buffer): void;
  flush(): Promise<void>;
  finish(options?: { readonly timeoutMs?: number }): Promise<OutputSpillResult | null>;
  readonly pendingBytes: number;
  waitForLowWatermark(limit?: number): Promise<void>;
}

function processPid(target: ProcessTarget): number {
  const value = typeof target === 'number' ? target : target?.pid;
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function isProcessAlive(target: ProcessTarget): boolean {
  const pid = processPid(target);
  if (!pid) return false;
  if (process.platform !== 'win32' && typeof target === 'object' && target) {
    if (typeof target.exitCode === 'number' || target.signalCode) return false;
  }
  return isPidAlive(pid);
}

function isPidAlive(pidValue: unknown): boolean {
  const pid = Number(pidValue);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function isProcessGroupAlive(pidValue: unknown): boolean {
  const pid = Number(pidValue);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function isProcessTreeAlive(target: ProcessTarget): boolean {
  const rootPid = processPid(target);
  if (!rootPid) return false;
  if (process.platform === 'win32') return isProcessAlive(target);
  return isProcessGroupAlive(rootPid);
}

async function readProcessCreationIdentity(pidValue: unknown): Promise<string> {
  const pid = Number(pidValue);
  if (!Number.isSafeInteger(pid) || pid <= 0) return '';
  try {
    if (process.platform === 'linux') {
      const stat = await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return '';
      const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
      const startTicks = String(fields[19] || '');
      return /^\d+$/.test(startTicks) ? `linux:${startTicks}` : '';
    }
    if (process.platform === 'win32') {
      const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
      const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const ticks = await readBoundedCommandOutput(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`
      ]);
      return /^\d+$/.test(ticks) ? `win32:${ticks}` : '';
    }
    const started = await readBoundedCommandOutput('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
    const normalized = started.replace(/\s+/g, ' ').trim();
    return normalized ? `${process.platform}:${normalized}` : '';
  } catch {
    return '';
  }
}

function readBoundedCommandOutput(executable: string, args: readonly string[], timeoutMs = 2000): Promise<string> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish('');
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      child.stdout?.on('data', chunk => {
        if (output.length >= 4096) return;
        output += String(chunk).slice(0, 4096 - output.length);
      });
      child.once('error', () => finish(''));
      child.once('close', code => finish(code === 0 ? output.trim() : ''));
    } catch {
      finish('');
    }
  });
}

function signalProcessTree(target: ProcessTarget, options: ProcessTreeTerminationOptions = {}): boolean {
  const pid = processPid(target);
  if (!pid) return false;
  const force = options.force === true;
  const signal = force ? 'SIGKILL' : String(options.signal || 'SIGTERM');

  if (process.platform === 'win32') {
    if (!isProcessAlive(target)) return false;
    try {
      const args = [...(force ? ['/f'] : []), '/t', '/pid', String(pid)];
      const killer = spawn(TASKKILL_EXE, args, { stdio: 'ignore', windowsHide: true });
      killer.once('error', error => debugKill('[rel-ai-mcp] taskkill:', error));
      killer.unref?.();
      return true;
    } catch (error) {
      debugKill('[rel-ai-mcp] taskkill:', error);
    }
  } else {
    try {
      process.kill(-pid, signal as NodeJS.Signals);
      return true;
    } catch (error) {
      debugKill('[rel-ai-mcp] kill process group:', error);
    }
  }

  try {
    if (typeof target === 'object' && target && typeof target.kill === 'function') target.kill(signal as NodeJS.Signals);
    else process.kill(pid, signal as NodeJS.Signals);
    return true;
  } catch (error) {
    debugKill(`[rel-ai-mcp] kill ${signal}:`, error);
    return !isProcessAlive(target);
  }
}

function killProcessTree(target: ProcessTarget): boolean {
  return signalProcessTree(target, { force: true, signal: 'SIGKILL' });
}

async function terminateProcessTree(target: ProcessTarget, options: ProcessTreeTerminationOptions = {}): Promise<ProcessTreeTerminationResult> {
  const graceMs = clampMilliseconds(options.graceMs, 0, 30000, DEFAULT_TERMINATION_GRACE_MS);
  const forceWaitMs = clampMilliseconds(options.forceWaitMs, 0, 30000, DEFAULT_FORCE_WAIT_MS);
  const rootPid = processPid(target);
  const trackedTargets = process.platform === 'win32' ? [target] : [];
  const treeAlive = process.platform === 'win32'
    ? isProcessAlive(target)
    : isProcessGroupAlive(rootPid);
  if (!treeAlive) {
    // Windows can no longer discover a surviving descendant through taskkill
    // once its root PID is gone. Root absence alone is not tree-exit proof.
    if (process.platform === 'win32' && rootPid > 0) {
      return {
        exited: false, forced: false, gracefulSignalSent: false, forceSignalSent: false,
        error: 'The Windows root process already exited; descendant termination could not be confirmed.'
      };
    }
    return { exited: true, forced: false, gracefulSignalSent: false, forceSignalSent: false };
  }

  let gracefulSignalSent = false;
  if (graceMs > 0) {
    gracefulSignalSent = process.platform === 'win32'
      ? await signalWindowsProcessTree(target)
      : signalProcessTree(target, { signal: options.signal || 'SIGTERM' });
    const gracefulExit = process.platform === 'win32'
      ? await waitForWindowsTargetsExit(trackedTargets, graceMs)
      : await waitForProcessGroupExit(rootPid, graceMs);
    if (gracefulExit && (process.platform !== 'win32' || gracefulSignalSent)) {
      return { exited: true, forced: false, gracefulSignalSent, forceSignalSent: false };
    }
  }

  const forceSignalSent = process.platform === 'win32'
    ? await forceWindowsProcessTree(trackedTargets)
    : signalProcessTree(target, { force: true, signal: 'SIGKILL' });
  const exited = process.platform === 'win32'
    ? await waitForWindowsTargetsExit(trackedTargets, forceWaitMs)
    : await waitForProcessGroupExit(rootPid, forceWaitMs);
  return {
    exited: exited && (process.platform !== 'win32' || forceSignalSent),
    forced: true, gracefulSignalSent, forceSignalSent
  };
}

async function signalWindowsProcessTree(target: ProcessTarget, force = false): Promise<boolean> {
  const pid = processPid(target);
  if (!pid || !isProcessAlive(target)) return false;
  return new Promise<boolean>(resolve => {
    let settled = false;
    let killer: ReturnType<typeof spawn> | null = null;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // taskkill itself can hang. Its lifetime must not defeat the process
    // termination deadline or leave a workspace mutation awaiting it forever.
    const timer = setTimeout(() => {
      try { killer?.kill(); } catch {}
      killer?.unref?.();
      finish(false);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    try {
      killer = spawn(TASKKILL_EXE, [...(force ? ['/f'] : []), '/t', '/pid', String(pid)], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', error => {
        debugKill(`[rel-ai-mcp] ${force ? 'force ' : ''}Windows process tree:`, error);
        finish(false);
      });
      killer.once('close', code => finish(code === 0));
    } catch (error) {
      debugKill(`[rel-ai-mcp] ${force ? 'force ' : ''}Windows process tree:`, error);
      finish(false);
    }
  });
}

async function forceWindowsProcessTree(targets: readonly ProcessTarget[]): Promise<boolean> {
  let signalSent = false;
  const uniqueTargets = [...new Map(targets.map(target => [processPid(target), target])).values()];
  for (const target of uniqueTargets.reverse()) {
    if (!isProcessAlive(target)) continue;
    signalSent = await signalWindowsProcessTree(target, true) || signalSent;
  }
  return signalSent;
}

function waitForWindowsTargetsExit(targets: readonly ProcessTarget[], timeoutMs: number): Promise<boolean> {
  const uniqueTargets = [...new Map(targets.map(target => [processPid(target), target])).values()];
  const exited = (): boolean => uniqueTargets.every(target => !isProcessAlive(target));
  if (exited()) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(exited());
  return new Promise<boolean>(resolve => {
    const interval = setInterval(() => {
      if (exited()) finish(true);
    }, 25);
    const timer = setTimeout(() => finish(exited()), timeoutMs);
    function finish(value: boolean): void {
      clearInterval(interval);
      clearTimeout(timer);
      resolve(value);
    }
  });
}

function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  if (!isProcessGroupAlive(pid)) return Promise.resolve(true);
  if (timeoutMs <= 0) return Promise.resolve(!isProcessGroupAlive(pid));
  return new Promise<boolean>(resolve => {
    let settled = false;
    const interval = setInterval(() => {
      if (!isProcessGroupAlive(pid)) finish(true);
    }, 25);
    const timer = setTimeout(() => finish(!isProcessGroupAlive(pid)), timeoutMs);
    function finish(exited: boolean): void {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timer);
      resolve(exited);
    }
  });
}

async function runProcess(command: string, args: readonly string[] = [], options: RunProcessOptions = {}, config: ProcessRuntimeConfig = {}): Promise<RunProcessResult> {
  let executed = false;
  let rootExitConfirmed = false;
  let mutationOwnershipPersistenceError = '';
  const retireMutationProcess = (pid: number, file: string): void => {
    mutationOwnershipPersistenceError = clearCurrentMutationProcess(pid, file) ? ''
      : 'Process ownership cleanup is pending because its recovery marker could not be removed. Known command and termination facts are unchanged. Inspect recovery state before another mutation; do not rerun the command to clear this marker.';
  };
  const reportPhase = (phase: ProcessPhaseEvent['phase'], details: Partial<ProcessPhaseEvent> = {}): void => {
    // Observability must never prevent process cleanup or change execution.
    try { options.onPhase?.({ phase, atMs: Date.now(), executed, rootExitConfirmed, ...details }); } catch {}
  };
  if (options.signal?.aborted) {
    return terminalQueueResult({
      error: errorMessage(options.signal.reason || 'Operation cancelled before process start.'),
      timedOut: isTimeoutAbort(options.signal),
      cancelled: !isTimeoutAbort(options.signal),
      queueWaitMs: 0
    });
  }
  const resourceClass = String(options.resourceClass || '').trim();
  const queueStartedAt = Date.now();
  let resourceLease: ResourceLease | null = null;
  let retainResourceLease = false;
  let failureCleanup: (() => Promise<boolean>) | null = null;
  let windowsJob: WindowsProcessJob | null = null;
  let ownedControllerClosed = false;
  if (resourceClass) {
    reportPhase('host-queued');
    try {
      resourceLease = await acquireHostResource(
        resourceClass,
        String(options.resourceOwner || options.cwd || 'global'),
        { signal: options.signal, timeoutMs: options.queueTimeoutMs,
          deadlineAtMs: options.deadlineAtMs }
      ) as ResourceLease;
    } catch (error) {
      const queueWaitMs = Date.now() - queueStartedAt;
      if (errorCode(error) === 'HOST_RESOURCE_ABORTED') {
        return terminalQueueResult({
          error: errorMessage(options.signal?.reason || 'Operation cancelled while waiting for host resources.'),
          timedOut: isTimeoutAbort(options.signal),
          cancelled: !isTimeoutAbort(options.signal),
          queueTimedOut: isTimeoutAbort(options.signal),
          admissionDetails: processAdmissionFailure(error, resourceClass),
          queueWaitMs
        });
      }
      if (errorCode(error) === 'HOST_RESOURCE_QUEUE_TIMEOUT') {
        const deadlineAtMs = Number(options.deadlineAtMs);
        return terminalQueueResult({
          error: errorMessage(error),
          timedOut: Number.isFinite(deadlineAtMs) && deadlineAtMs > 0 && Date.now() >= deadlineAtMs,
          queueTimedOut: true,
          admissionDetails: processAdmissionFailure(error, resourceClass),
          queueWaitMs
        });
      }
      if (errorCode(error) === 'HOST_RESOURCE_QUEUE_FULL') {
        return terminalQueueResult({ error: errorMessage(error),
          admissionDetails: processAdmissionFailure(error, resourceClass), queueWaitMs });
      }
      throw error;
    }
  }

  try {
    const queueWaitMs = resourceLease?.waitMs || 0;
    if (options.signal?.aborted) {
      return terminalQueueResult({
        error: errorMessage(options.signal.reason || 'Operation cancelled before process start.'),
        timedOut: isTimeoutAbort(options.signal),
        cancelled: !isTimeoutAbort(options.signal),
        queueWaitMs
      });
    }
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const configuredMaxOutputBytes = Number(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    const maxOutputBytes = Number.isFinite(configuredMaxOutputBytes) && configuredMaxOutputBytes > 0
      ? configuredMaxOutputBytes
      : DEFAULT_MAX_OUTPUT_BYTES;
    const stdoutSpill = createOutputSpillWriter(config, options.outputSpillTaskId) as OutputSpillWriter;
    const stderrSpill = createOutputSpillWriter(config, options.outputSpillTaskId) as OutputSpillWriter;
    const stdoutBuffer = new BoundedOutputBuffer(maxOutputBytes, stdoutSpill);
    const stderrBuffer = new BoundedOutputBuffer(maxOutputBytes, stderrSpill);
    const timeoutMs = Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
      ? Number(options.timeout)
      : 0;
    const terminationGraceMs = clampMilliseconds(
      options.terminationGraceMs ?? config.processTerminationGraceMs,
      0,
      30000,
      DEFAULT_TERMINATION_GRACE_MS
    );
    const forceWaitMs = clampMilliseconds(
      options.forceWaitMs ?? config.processForceWaitMs,
      0,
      30000,
      DEFAULT_FORCE_WAIT_MS
    );
    const outputFinalizationTimeoutMs = clampMilliseconds(
      options.outputFinalizationTimeoutMs ?? config.processOutputFinalizationTimeoutMs,
      1,
      30000,
      DEFAULT_OUTPUT_FINALIZATION_TIMEOUT_MS
    );
    const isGit = command === 'git';
    if (isGit && options.shell) throw new Error('Rel.AI-owned Git commands must run without shell parsing.');
    const executable = isGit ? (resolveGitExecutable() || command) : command;
    const childEnvironment = makeProcessEnvironment(options.env, {
      allow: config.processEnvironment?.allow,
      inheritCredentials: options.inheritCredentials === true,
      pathAppend: extensionCommandPathEntries(config)
    });
    Object.assign(childEnvironment, traceContextEnvironment());
    const processArgs = isGit ? hardenedGitArgs(config, args) : [...args];
    const shell = options.shell === true;
    const file = shell ? (options.commandString || executable) : executable;
    const ownsWindowsTermination = process.platform === 'win32' && (timeoutMs > 0 || Boolean(options.signal));
    const execaOptions: ExecaOptions = {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: childEnvironment,
      extendEnv: false,
      shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
      reject: false,
      buffer: false,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      stripFinalNewline: false,
      timeout: ownsWindowsTermination ? 0 : timeoutMs,
      ...(!ownsWindowsTermination && options.signal ? { cancelSignal: options.signal } : {}),
      killDescendants: !ownsWindowsTermination,
      forceKillAfterDelay: Math.max(1, terminationGraceMs),
      ...(options.input != null ? { input: String(options.input) } : {})
    };

    const deadlineAtMs = Number(options.deadlineAtMs);
    const abortedBeforeSpawn = options.signal?.aborted === true;
    if (abortedBeforeSpawn || (Number.isFinite(deadlineAtMs) && deadlineAtMs > 0 && Date.now() >= deadlineAtMs)) {
      const reason = abortedBeforeSpawn
        ? options.signal?.reason
        : new DOMException('Execution deadline expired before process start.', 'TimeoutError');
      const timedOut = abortedBeforeSpawn ? isTimeoutAbort(options.signal) : true;
      return terminalQueueResult({
        error: errorMessage(reason || 'Operation cancelled before process start.'),
        timedOut,
        cancelled: !timedOut,
        queueWaitMs
      });
    }
    const processStartedAt = Date.now();
    const mutationProcessFile = prepareCurrentMutationProcess();
    let subprocess;
    try {
      if (process.platform === 'win32' && (mutationProcessFile || ownedReadOnlyProcessOptions.has(options)
        || options.nativeOwnership === true)) {
        windowsJob = await prepareWindowsProcessJob(config, {
          executable: shell ? (process.env.ComSpec || String.raw`C:\Windows\System32\cmd.exe`) : executable,
          args: shell ? [] : processArgs, env: childEnvironment,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(shell ? { shellCommand: file } : {})
        });
      }
      if (options.signal?.aborted || (Number.isFinite(deadlineAtMs) && deadlineAtMs > 0 && Date.now() >= deadlineAtMs)) {
        if (mutationProcessFile) retireMutationProcess(0, mutationProcessFile);
        if (windowsJob) fs.rmSync(windowsJob.directory, { recursive: true, force: true });
        windowsJob = null;
        const expired = !options.signal?.aborted || isTimeoutAbort(options.signal);
        return {
          ...terminalQueueResult({ error: errorMessage(options.signal?.reason || 'Execution deadline expired before process start.'),
            timedOut: expired, cancelled: !expired, queueWaitMs }),
          ...(mutationOwnershipPersistenceError ? { mutationOwnershipPersistenceError } : {})
        };
      }
      subprocess = execa(windowsJob?.executable || file, windowsJob?.args || (shell ? [] : processArgs),
        windowsJob ? { ...execaOptions, shell: false, env: windowsJob.environment } : execaOptions);
      windowsJob?.bind(subprocess.pid);
    } catch (error) {
      if (mutationProcessFile) retireMutationProcess(0, mutationProcessFile);
      if (windowsJob) fs.rmSync(windowsJob.directory, { recursive: true, force: true });
      throw error;
    }
    const subprocessClose = observeSubprocessClose(subprocess.nodeChildProcess);
    void subprocessClose.then(() => { ownedControllerClosed = true; });
    executed = processPid(subprocess) > 0;
    if (executed) reportPhase('spawned');
    const windowsTermination = {
      kind: '' as 'timeout' | 'cancel' | '',
      promise: null as Promise<ProcessTreeTerminationResult> | null
    };
    let notifyWindowsTermination: (outcome: ProcessTreeTerminationResult) => void = () => {};
    const windowsTerminationSettled = new Promise<ProcessTreeTerminationResult>(resolve => {
      notifyWindowsTermination = resolve;
    });
    let windowsTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let windowsAbortListener: (() => void) | null = null;
    const requestWindowsTermination = (kind: 'timeout' | 'cancel'): void => {
      if (!ownsWindowsTermination || windowsTermination.promise) return;
      windowsTermination.kind = kind;
      windowsTermination.promise = (windowsJob ? windowsJob.stop(kind, forceWaitMs)
        : terminateProcessTree(subprocess, { graceMs: 0, forceWaitMs }))
        .catch(error => ({ exited: false, forced: true, error: errorMessage(error) }));
      void windowsTermination.promise.then(notifyWindowsTermination);
    };
    failureCleanup = async () => {
      if (windowsTimeoutTimer) clearTimeout(windowsTimeoutTimer);
      if (windowsAbortListener) options.signal?.removeEventListener('abort', windowsAbortListener);
      const outcome = !executed
        ? { exited: true, forced: false }
        : await (windowsJob ? windowsJob.stop('stop', forceWaitMs)
          : terminateProcessTree(subprocess, { graceMs: 0, forceWaitMs }))
          .catch(error => ({ exited: false, forced: true, error: errorMessage(error) }));
      await settleTerminatedSubprocess(subprocess, subprocessClose, forceWaitMs);
      if (mutationProcessFile) {
        if (outcome.exited) retireMutationProcess(subprocess.pid || 0, mutationProcessFile);
        else {
          try { markCurrentMutationProcessUncertain(subprocess.pid, 'Post-spawn setup failed and process-tree termination remains unknown.', mutationProcessFile); }
          catch { /* The pre-spawn intent is already durable and remains blocked. */ }
        }
      }
      return outcome.exited;
    };
    if (ownsWindowsTermination) {
      if (options.signal) {
        windowsAbortListener = () => requestWindowsTermination(isTimeoutAbort(options.signal) ? 'timeout' : 'cancel');
        if (options.signal.aborted) windowsAbortListener();
        else options.signal.addEventListener('abort', windowsAbortListener, { once: true });
      }
      if (timeoutMs > 0) windowsTimeoutTimer = setTimeout(() => requestWindowsTermination('timeout'), timeoutMs);
    }
    const mutationProcessRecorded = Boolean(recordCurrentMutationProcess(subprocess.pid, mutationProcessFile));
    const stdoutBackpressure = createOutputBackpressure(subprocess.stdout, stdoutSpill);
    const stderrBackpressure = createOutputBackpressure(subprocess.stderr, stderrSpill);
    subprocess.stdout?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      stdoutBuffer.append(buffer);
      stdoutBackpressure.observe();
    });
    subprocess.stderr?.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrBytes += buffer.length;
      stderrBuffer.append(buffer);
      stderrBackpressure.observe();
    });

    let inheritedPipeDrain = false;
    const disposePostExitPipeDrain = armPostExitPipeDrain(subprocess, forceWaitMs, () => {
      rootExitConfirmed = true;
      reportPhase('exited');
      reportPhase('draining-output');
      // A process can exit while its stdout pipe still holds unread bytes.
      // Keep backpressure active until those bytes drain; the bounded pipe
      // grace period below still handles inherited open descriptors.
    }, () => { inheritedPipeDrain = true; });
    let result;
    let windowsTerminationOutcome: ProcessTreeTerminationResult | null = null;
    try {
      const settled = ownsWindowsTermination
        ? await Promise.race([
            subprocess.then(value => ({ kind: 'process' as const, value })),
            windowsTerminationSettled.then(value => ({ kind: 'termination' as const, value }))
          ])
        : { kind: 'process' as const, value: await subprocess };
      if (settled.kind === 'process') {
        result = settled.value;
      } else {
        // Execa cancellation is disabled on Windows because we own tree
        // termination. A failed kill must still settle this caller, preserve
        // mutation ownership, and report uncertainty for workspace quarantine.
        windowsTerminationOutcome = settled.value;
        result = {
          exitCode: subprocess.nodeChildProcess?.exitCode ?? -1,
          signal: undefined,
          timedOut: windowsTermination.kind === 'timeout',
          isCanceled: windowsTermination.kind === 'cancel',
          isForcefullyTerminated: settled.value.forced,
          failed: true,
          durationMs: Date.now() - processStartedAt,
          originalMessage: '',
          shortMessage: '',
          message: ''
        };
      }
    } finally {
      if (windowsTimeoutTimer) clearTimeout(windowsTimeoutTimer);
      if (windowsAbortListener) options.signal?.removeEventListener('abort', windowsAbortListener);
      disposePostExitPipeDrain();
      // Cancellation and process errors must release a paused pipe so execa can
      // finish its own stream cleanup. The spill writer remains ordered and is
      // drained below before its file descriptor is closed.
      stdoutBackpressure.release();
      stderrBackpressure.release();
    }
    windowsTerminationOutcome ||= windowsTermination.promise ? await windowsTermination.promise : null;
    const signalTimedOut = isTimeoutAbort(options.signal)
      && (windowsTermination.kind === 'timeout' || result.isCanceled === true);
    const timedOut = windowsTermination.kind === 'timeout' || result.timedOut === true || signalTimedOut;
    const cancelled = !timedOut && (windowsTermination.kind === 'cancel' || result.isCanceled === true);
    const nativeReceipt = windowsJob?.receipt();
    const terminationOutcome = windowsTerminationOutcome || (windowsJob ? (executed ? windowsJob.outcome() : { exited: true, forced: false }) : null) || ((timedOut || cancelled)
      ? await terminateProcessTree(subprocess, { graceMs: 0, forceWaitMs })
      : inheritedPipeDrain
        ? { exited: false, forced: false, error: 'The root exited but inherited output handles remained open; descendant termination is unconfirmed.' }
        : process.platform !== 'win32' && isProcessTreeAlive(subprocess)
          ? await terminateProcessTree(subprocess, { graceMs: 0, forceWaitMs })
          : null);
    retainResourceLease = terminationOutcome?.exited === false;
    if (terminationOutcome) {
      // Release only our stdio/child handles. This does not assert that the
      // process tree stopped; unconfirmed mutations retain their durable owner.
      await settleTerminatedSubprocess(subprocess, subprocessClose, forceWaitMs);
    }
    rootExitConfirmed = windowsJob ? nativeReceipt?.rootExited === true : rootExitConfirmed || (executed && !isProcessAlive(subprocess));
    if (mutationProcessRecorded && terminationOutcome?.exited === false) {
      try {
        markCurrentMutationProcessUncertain(subprocess.pid,
          terminationOutcome.error || 'Process-tree termination was not confirmed after cancellation or timeout.', mutationProcessFile);
      } catch (error) {
        // Return the unconfirmed termination result so the caller still takes
        // its normal quarantine path; do not throw past that safety decision.
        mutationOwnershipPersistenceError = errorMessage(error);
        stderrBuffer.append(`\n[rel-ai-mcp ${mutationOwnershipPersistenceError}]\n`);
      }
    }
    if (timedOut) {
      stderrBuffer.append(signalTimedOut
        ? '\n[rel-ai-mcp execution deadline timed out]\n'
        : `\n[rel-ai-mcp timed out after ${timeoutMs}ms]\n`);
    } else if (cancelled) {
      stderrBuffer.append('\n[rel-ai-mcp operation cancelled]\n');
    }

    reportPhase('draining-output', terminationOutcome ? { terminationConfirmed: terminationOutcome.exited } : {});
    const [stdoutSpillResult, stderrSpillResult] = await Promise.all([
      stdoutSpill.finish({ timeoutMs: outputFinalizationTimeoutMs }),
      stderrSpill.finish({ timeoutMs: outputFinalizationTimeoutMs })
    ]);
    const outputFinalizationTimedOut = stdoutSpillResult?.finalizationTimedOut === true
      || stderrSpillResult?.finalizationTimedOut === true;
    const outputFinalizationError = outputFinalizationTimedOut
      ? `Output retention timed out after ${outputFinalizationTimeoutMs}ms; retained output may be incomplete.`
      : '';
    if (outputFinalizationTimedOut) stderrBuffer.append(`\n[rel-ai-mcp ${outputFinalizationError}]\n`);
    reportPhase('drained', {
      ...(terminationOutcome ? { terminationConfirmed: terminationOutcome.exited } : {}),
      ...(outputFinalizationTimedOut ? { outputFinalizationTimedOut: true } : {})
    });
    const callerNeverStarted = nativeReceipt?.final === true
      && nativeReceipt.commandStarted === false && nativeReceipt.startupFailedBeforeCommand === true
      && terminationOutcome?.exited === true;
    const spawnError = !timedOut && !cancelled && (nativeReceipt?.startupFailedBeforeCommand === true || result.failed
      && !result.signal
      && (result.exitCode == null || (process.platform === 'win32' && !shell && !windowsExecutableExists(executable, options.cwd, childEnvironment))));
    const error = timedOut
      ? (signalTimedOut ? errorMessage(options.signal?.reason) : `Timed out after ${timeoutMs}ms`)
      : cancelled
        ? errorMessage(options.signal?.reason || 'Operation cancelled.')
        : spawnError
          ? String(nativeReceipt?.error || result.originalMessage || result.shortMessage || result.message || 'Process failed to start.')
          : nativeReceipt?.error;

    if (mutationProcessFile && (!executed || terminationOutcome?.exited !== false)) {
      retireMutationProcess(subprocess.pid || 0, mutationProcessFile);
      if (mutationOwnershipPersistenceError) stderrBuffer.append(`\n[rel-ai-mcp ${mutationOwnershipPersistenceError}]\n`);
    }
    failureCleanup = null;
    const outcome: RunProcessResult = {
      executed: !spawnError && !callerNeverStarted && processPid(subprocess) > 0,
      rootExitConfirmed,
      ...(mutationOwnershipPersistenceError ? { mutationOwnershipPersistenceError } : {}),
      ...(outputFinalizationTimedOut ? { outputFinalizationTimedOut: true, outputFinalizationError } : {}),
      exitCode: typeof nativeReceipt?.rootExitCode === 'number' ? nativeReceipt.rootExitCode : typeof result.exitCode === 'number' ? result.exitCode : -1,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: processOutputText(stdoutBuffer, options.preserveOutputWhitespace),
      stderr: processOutputText(stderrBuffer, options.preserveOutputWhitespace),
      ...(error ? { error } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      timedOut,
      ...(spawnError ? { spawnError: true } : {}),
      ...(terminationOutcome ? {
        terminationConfirmed: terminationOutcome?.exited === true,
        forcedTermination: result.isForcefullyTerminated === true || terminationOutcome?.forced === true
      } : {}),
      queueWaitMs,
      durationMs: Number(result.durationMs || 0),
      stdoutBytes,
      stderrBytes,
      stdoutTruncated: stdoutBuffer.truncated,
      stderrTruncated: stderrBuffer.truncated,
      ...(stdoutSpillResult ? {
        ...(stdoutSpillResult.outputRef ? { stdoutOutputRef: stdoutSpillResult.outputRef } : {}),
        stdoutSpillTruncated: stdoutSpillResult.spillTruncated === true
      } : {}),
      ...(stderrSpillResult ? {
        ...(stderrSpillResult.outputRef ? { stderrOutputRef: stderrSpillResult.outputRef } : {}),
        stderrSpillTruncated: stderrSpillResult.spillTruncated === true
      } : {})
    };
    if (ownedReadOnlyProcessOptions.has(options) && windowsJob && terminationOutcome?.exited === false) {
      unsettledReadOnlyProcessJobs.set(outcome, { job: windowsJob, controllerClosed: () => ownedControllerClosed });
    }
    return outcome;
  } catch (cause) {
    if (failureCleanup) {
      const terminationConfirmed = await failureCleanup().catch(() => false);
      retainResourceLease = !terminationConfirmed;
      const error = new Error(`Process setup or finalization failed; process-tree cleanup was attempted.${mutationOwnershipPersistenceError ? ` ${mutationOwnershipPersistenceError}` : ''}`, { cause });
      Object.assign(error, {
        code: 'PROCESS_SETUP_FAILED', executed, terminationConfirmed,
        terminationCertainty: terminationConfirmed ? 'confirmed' : 'unconfirmed',
        ...(mutationOwnershipPersistenceError ? { mutationOwnershipPersistenceError, cleanupPending: true, retryable: false } : {})
      });
      if (ownedReadOnlyProcessOptions.has(options) && windowsJob && !terminationConfirmed) {
        unsettledReadOnlyProcessJobs.set(error, { job: windowsJob, controllerClosed: () => ownedControllerClosed });
      }
      throw error;
    }
    if (mutationOwnershipPersistenceError) {
      throw Object.assign(new Error(`${errorMessage(cause)} ${mutationOwnershipPersistenceError}`, { cause }), {
        code: errorCode(cause) || 'PROCESS_SETUP_FAILED',
        mutationOwnershipPersistenceError, cleanupPending: true, retryable: false
      });
    }
    throw cause;
  } finally {
    if (!retainResourceLease) {
      resourceLease?.release();
      if (windowsJob && !executed) fs.rmSync(windowsJob.directory, { recursive: true, force: true });
      else windowsJob?.cleanup();
    }
  }
}

// Internal, statically classified observations only. Never use this entry point
// for a caller-supplied executable/command or expose an ownership opt-out flag.
// Internal native ownership is independent of mutation authority. The private
// options identity cannot be requested through serialized public tool arguments.
function runOwnedReadOnlyProcess(command: string, args: readonly string[] = [], options: RunProcessOptions = {}, config: ProcessRuntimeConfig = {}): Promise<RunProcessResult> {
  if (options.resourceClass !== undefined) {
    return Promise.reject(new TypeError('Owned read-only probes require caller-managed resource admission.'));
  }
  const ownedOptions = { ...options };
  ownedReadOnlyProcessOptions.add(ownedOptions);
  return runWithoutMutationProcessOwnership(() => runProcess(command, args, ownedOptions, config))
    .then((result: RunProcessResult) => internalReadOnlyProcessOutcome(result))
    .catch((error: unknown) => {
      if (error && typeof error === 'object') internalReadOnlyProcessOutcome(error);
      throw error;
    })
    .finally(() => ownedReadOnlyProcessOptions.delete(ownedOptions));
}

function reconcileReadOnlyProcessTermination(value: object): boolean {
  if (!isInternalReadOnlyProcessOutcome(value)) return false;
  const pending = unsettledReadOnlyProcessJobs.get(value);
  if (!pending?.controllerClosed() || !pending.job.outcome().exited) return false;
  pending.job.cleanup();
  unsettledReadOnlyProcessJobs.delete(value);
  return true;
}

function runReadOnlyProcess(command: string, args: readonly string[] = [], options: RunProcessOptions = {}, config: ProcessRuntimeConfig = {}): Promise<RunProcessResult> {
  return runWithoutMutationProcessOwnership(() => runProcess(command, args, options, config)).then((result: RunProcessResult) => {
    internalObservationOutcomes.add(result);
    return result;
  }, (error: unknown) => {
    if (error && typeof error === 'object') internalObservationOutcomes.add(error);
    throw error;
  });
}

function observeSubprocessClose(
  child: {
    once?(event: string, listener: (...args: unknown[]) => void): unknown;
    removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  } | null | undefined
): Promise<void> {
  if (!child?.once) return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      child.removeListener?.('close', onClose);
      resolve();
    };
    child.once?.('close', onClose);
  });
}

async function settleTerminatedSubprocess(
  subprocess: {
    readonly nodeChildProcess?: { unref?(): unknown } | null;
    readonly stdin?: { readonly destroyed?: boolean; destroy?(): unknown } | null;
    readonly stdout?: { readonly destroyed?: boolean; destroy?(): unknown } | null;
    readonly stderr?: { readonly destroyed?: boolean; destroy?(): unknown } | null;
  },
  closePromise: Promise<void>,
  waitMs: number
): Promise<void> {
  const child = subprocess.nodeChildProcess;
  if (!child) return;
  for (const stream of [subprocess.stdin, subprocess.stdout, subprocess.stderr]) {
    if (!stream || stream.destroyed || typeof stream.destroy !== 'function') continue;
    try { stream.destroy(); } catch {}
  }
  const closed = await Promise.race([
    closePromise.then(() => true),
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), Math.max(0, waitMs));
      timer.unref?.();
    })
  ]);
  if (!closed) child.unref?.();
}

function armPostExitPipeDrain(
  subprocess: {
    readonly nodeChildProcess?: {
      readonly exitCode?: number | null;
      readonly signalCode?: NodeJS.Signals | string | null;
      once?(event: string, listener: (...args: unknown[]) => void): unknown;
      removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    readonly stdout?: { readonly destroyed?: boolean; destroy?(): unknown } | null;
    readonly stderr?: { readonly destroyed?: boolean; destroy?(): unknown } | null;
  },
  drainGraceMs: number,
  onExit: () => void,
  onUnsettledPipes: () => void = () => {}
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const processHandle = subprocess.nodeChildProcess;
  const closeLingeringPipe = (stream: { readonly destroyed?: boolean; destroy?(): unknown } | null | undefined): void => {
    if (!stream || stream.destroyed || (stream as { readableEnded?: boolean }).readableEnded || typeof stream.destroy !== 'function') return;
    onUnsettledPipes();
    try { stream.destroy(); } catch {}
  };
  const handleExit = (): void => {
    if (disposed || timer) return;
    onExit();
    timer = setTimeout(() => {
      if (disposed) return;
      closeLingeringPipe(subprocess.stdout);
      closeLingeringPipe(subprocess.stderr);
    }, Math.max(0, drainGraceMs));
    timer.unref?.();
  };

  if (processHandle?.exitCode != null || processHandle?.signalCode) queueMicrotask(handleExit);
  else processHandle?.once?.('exit', handleExit);

  return () => {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    processHandle?.removeListener?.('exit', handleExit);
  };
}

interface ProcessAdmissionFailure {
  readonly admissionBlocked: true;
  readonly errorCode: string;
  readonly blockedResource: string;
  readonly resourceReason: string;
  readonly retryable: true;
}

function processAdmissionFailure(error: unknown, resourceClass: string): ProcessAdmissionFailure {
  const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  return {
    admissionBlocked: true,
    errorCode: errorCode(error),
    blockedResource: String(detail.blockedResource || resourceClass),
    resourceReason: String(detail.resourceReason || 'Host concurrency admission did not complete.').slice(0, 500),
    retryable: true
  };
}

function terminalQueueResult(options: { readonly error: string; readonly cancelled?: boolean; readonly timedOut?: boolean; readonly queueTimedOut?: boolean; readonly queueWaitMs: number; readonly admissionDetails?: ProcessAdmissionFailure }): RunProcessResult {
  return {
    executed: false,
    exitCode: -1,
    stdout: '',
    stderr: '',
    error: options.error,
    ...options.admissionDetails,
    cancelled: options.cancelled === true,
    ...((options.cancelled === true || options.timedOut === true) ? { terminationConfirmed: true, forcedTermination: false } : {}),
    timedOut: options.timedOut === true,
    queueTimedOut: options.queueTimedOut === true,
    queueWaitMs: options.queueWaitMs,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function hardenedGitArgs(config: ProcessRuntimeConfig, args: readonly string[]): string[] {
  const hooksPath = path.join(getStateDir(config), DISABLED_GIT_HOOKS_PATH);
  return [
    '-c', `core.hooksPath=${hooksPath}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', 'push.gpgSign=false',
    ...args
  ];
}

function processOutputText(buffer: BoundedOutputBuffer, preserveWhitespace = false): string {
  const text = buffer.text();
  return preserveWhitespace ? text : text.trim();
}

// Leave room below the writer's 4 MiB hard queue limit for a readable chunk
// already in flight before pause() can take effect.
const OUTPUT_SPILL_HIGH_WATER_BYTES = 2 * 1024 * 1024;
const OUTPUT_SPILL_LOW_WATER_BYTES = 1024 * 1024;

interface OutputBackpressureSource {
  pause?(): unknown;
  resume?(): unknown;
  readonly destroyed?: boolean;
}

function createOutputBackpressure(
  source: OutputBackpressureSource | null | undefined,
  spill: OutputSpillWriter
): { observe(): void; release(): void } {
  let paused = false;
  let released = false;

  const observe = (): void => {
    if (released || paused || !source || typeof source.pause !== 'function') return;
    if (spill.pendingBytes < OUTPUT_SPILL_HIGH_WATER_BYTES) return;
    paused = true;
    source.pause();
    void spill.waitForLowWatermark(OUTPUT_SPILL_LOW_WATER_BYTES).then(() => {
      if (released || !paused) return;
      paused = false;
      if (!source.destroyed && typeof source.resume === 'function') source.resume();
    });
  };

  const release = (): void => {
    released = true;
    if (!paused) return;
    paused = false;
    if (!source?.destroyed && typeof source?.resume === 'function') source.resume();
  };

  return { observe, release };
}

const TRUNCATED_OUTPUT_MARKER = '\n[rel-ai-mcp truncated output]\n';
const TRUNCATED_OUTPUT_MARKER_BYTES = Buffer.byteLength(TRUNCATED_OUTPUT_MARKER, 'utf8');

class BoundedOutputBuffer {
  readonly maxBytes: number;
  readonly chunks: Buffer[] = [];
  retainedBytes = 0;
  truncated = false;
  readonly spill: OutputSpillWriter | null;

  constructor(maxBytes: number, spill: OutputSpillWriter | null = null) {
    this.maxBytes = Math.max(0, Number(maxBytes) || 0);
    this.spill = spill;
  }

  append(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
    if (!chunk.length) return;
    const wasTruncated = this.truncated;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    if (!wasTruncated && this.retainedBytes <= this.maxBytes) return;
    if (!wasTruncated) {
      this.truncated = true;
      this.spill?.start(Buffer.concat(this.chunks, this.retainedBytes));
    } else {
      this.spill?.append(chunk);
    }
    this.trimTo(Math.max(0, this.maxBytes - TRUNCATED_OUTPUT_MARKER_BYTES));
  }

  trimTo(limit: number): void {
    while (this.retainedBytes > limit && this.chunks.length) {
      const excess = this.retainedBytes - limit;
      const first = this.chunks[0];
      if (!first) break;
      if (first.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= first.length;
        continue;
      }
      this.chunks[0] = first.subarray(excess);
      this.retainedBytes -= excess;
    }
  }

  text(): string {
    const tail = Buffer.concat(this.chunks, this.retainedBytes).toString('utf8');
    if (!this.truncated) return tail;
    return TRUNCATED_OUTPUT_MARKER + tail.replace(/^\uFFFD+/u, '');
  }
}

function appendLimited(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  const marker = '\n[rel-ai-mcp truncated output]\n';
  const allowed = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const buffer = Buffer.from(combined, 'utf8');
  const tail = buffer.subarray(Math.max(0, buffer.length - allowed)).toString('utf8').replace(/^\uFFFD+/u, '');
  return marker + tail;
}

function summarizeCommand(result: Partial<RunProcessResult> & Pick<RunProcessResult, 'exitCode'>): Record<string, unknown> {
  const summary = {
    ok: result.exitCode === 0 && result.timedOut !== true && result.cancelled !== true,
    ...executionOutcome(result),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {})
  };
  if (isInternalReadOnlyProcessOutcome(result)) internalObservationOutcomes.add(summary);
  return summary;
}

function windowsExecutableExists(executable: string, cwd: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const value = String(executable || '').trim();
  if (!value) return false;
  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    const candidate = path.isAbsolute(value) ? value : path.resolve(cwd || process.cwd(), value);
    if (fs.existsSync(candidate)) return true;
  }
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
  const whereExe = path.join(systemRoot, 'System32', 'where.exe');
  try {
    const lookup = spawnSync(whereExe, [value], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: 'ignore'
    });
    return lookup.status === 0;
  } catch {
    return false;
  }
}

function clampMilliseconds(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function debugKill(label: string, error: unknown): void {
  if (process.env.REL_AI_MCP_DEBUG) console.error(label, error);
}

export {
  appendLimited, internalReadOnlyProcessOutcome, isInternalReadOnlyProcessOutcome, isProcessTreeAlive, readProcessCreationIdentity, runProcess, runReadOnlyProcess, runOwnedReadOnlyProcess, reconcileReadOnlyProcessTermination, summarizeCommand, terminateProcessTree
};
export type {
  ProcessTreeTerminationResult
};
