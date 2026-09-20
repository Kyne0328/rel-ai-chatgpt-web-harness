import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { execa, type Options as ExecaOptions } from 'execa';
import { resolveGitExecutable } from './gitExecutable.js';
import { makeProcessEnvironment } from './processEnvironment.js';
import { extensionCommandPathEntries } from './extensions/paths.js';
import { getStateDir } from './statePaths.js';
import { traceContextEnvironment } from './telemetry.js';
import { createOutputSpillWriter } from './outputSpill.js';
import { acquireHostResource } from './hostResourceScheduler.js';
import { clearCurrentMutationProcess, recordCurrentMutationProcess } from './mutationProcessOwnership.js';

const TASKKILL_EXE = String.raw`C:\Windows\System32\taskkill.exe`;
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const DEFAULT_FORCE_WAIT_MS = 2000;
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
}

interface RunProcessOptions {
  readonly resourceClass?: unknown;
  readonly resourceOwner?: unknown;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
  readonly queueTimeoutMs?: unknown;
  readonly maxOutputBytes?: unknown;
  readonly outputSpillTaskId?: unknown;
  readonly timeout?: unknown;
  readonly terminationGraceMs?: unknown;
  readonly forceWaitMs?: unknown;
  readonly shell?: boolean;
  readonly commandString?: string;
  readonly env?: Record<string, unknown>;
  readonly inheritCredentials?: boolean;
  readonly input?: unknown;
  readonly preserveOutputWhitespace?: boolean;
}

interface RunProcessResult {
  readonly exitCode: number;
  readonly signal?: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly cancelled?: boolean;
  readonly timedOut: boolean;
  readonly queueTimedOut?: boolean;
  readonly spawnError?: boolean;
  readonly terminationConfirmed?: boolean;
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
}

interface OutputSpillWriter {
  start(buffer: Buffer): void;
  append(buffer: Buffer): void;
  flush(): Promise<void>;
  finish(): Promise<OutputSpillResult | null>;
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
    if (gracefulExit) {
      return { exited: true, forced: false, gracefulSignalSent, forceSignalSent: false };
    }
  }

  const forceSignalSent = process.platform === 'win32'
    ? await forceWindowsProcessTree(trackedTargets)
    : signalProcessTree(target, { force: true, signal: 'SIGKILL' });
  const exited = process.platform === 'win32'
    ? await waitForWindowsTargetsExit(trackedTargets, forceWaitMs)
    : await waitForProcessGroupExit(rootPid, forceWaitMs);
  return { exited, forced: true, gracefulSignalSent, forceSignalSent };
}

async function signalWindowsProcessTree(target: ProcessTarget, force = false): Promise<boolean> {
  const pid = processPid(target);
  if (!pid || !isProcessAlive(target)) return false;
  return new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const killer = spawn(TASKKILL_EXE, [...(force ? ['/f'] : []), '/t', '/pid', String(pid)], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', error => {
        debugKill(`[rel-ai-mcp] ${force ? 'force ' : ''}Windows process tree:`, error);
        finish(!isProcessAlive(target));
      });
      killer.once('close', code => finish(code === 0 || !isProcessAlive(target)));
    } catch (error) {
      debugKill(`[rel-ai-mcp] ${force ? 'force ' : ''}Windows process tree:`, error);
      finish(!isProcessAlive(target));
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
  const resourceClass = String(options.resourceClass || '').trim();
  const queueStartedAt = Date.now();
  let resourceLease: ResourceLease | null = null;
  if (resourceClass) {
    try {
      resourceLease = await acquireHostResource(
        resourceClass,
        String(options.resourceOwner || options.cwd || 'global'),
        { signal: options.signal, timeoutMs: options.queueTimeoutMs }
      ) as ResourceLease;
    } catch (error) {
      const queueWaitMs = Date.now() - queueStartedAt;
      if (errorCode(error) === 'HOST_RESOURCE_ABORTED') {
        return terminalQueueResult({
          error: 'Operation cancelled while waiting for host resources.',
          cancelled: true,
          queueWaitMs
        });
      }
      if (errorCode(error) === 'HOST_RESOURCE_QUEUE_TIMEOUT') {
        return terminalQueueResult({
          error: errorMessage(error),
          queueTimedOut: true,
          queueWaitMs
        });
      }
      throw error;
    }
  }

  try {
    const queueWaitMs = resourceLease?.waitMs || 0;
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

    const subprocess = execa(file, shell ? [] : processArgs, execaOptions);
    const subprocessClose = observeSubprocessClose(subprocess.nodeChildProcess);
    const windowsTermination = {
      kind: '' as 'timeout' | 'cancel' | '',
      promise: null as Promise<ProcessTreeTerminationResult> | null
    };
    let windowsTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let windowsAbortListener: (() => void) | null = null;
    const requestWindowsTermination = (kind: 'timeout' | 'cancel'): void => {
      if (!ownsWindowsTermination || windowsTermination.promise) return;
      windowsTermination.kind = kind;
      windowsTermination.promise = terminateProcessTree(subprocess, { graceMs: 0, forceWaitMs });
    };
    if (ownsWindowsTermination) {
      if (options.signal) {
        windowsAbortListener = () => requestWindowsTermination('cancel');
        if (options.signal.aborted) windowsAbortListener();
        else options.signal.addEventListener('abort', windowsAbortListener, { once: true });
      }
      if (timeoutMs > 0) windowsTimeoutTimer = setTimeout(() => requestWindowsTermination('timeout'), timeoutMs);
    }
    const mutationProcessRecorded = Boolean(recordCurrentMutationProcess(subprocess.pid));
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

    const disposePostExitPipeDrain = armPostExitPipeDrain(subprocess, forceWaitMs, () => {
      // Once the launched process exits, its own output is complete. A
      // background descendant can still inherit these handles and keep Execa
      // waiting for EOF forever. Resume any paused output first, give buffered
      // data a short drain window, then detach only our read ends.
      stdoutBackpressure.release();
      stderrBackpressure.release();
    });
    let result;
    try {
      result = await subprocess;
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
    const windowsTerminationOutcome = windowsTermination.promise ? await windowsTermination.promise : null;
    const timedOut = windowsTermination.kind === 'timeout' || result.timedOut === true;
    const cancelled = windowsTermination.kind === 'cancel' || result.isCanceled === true;
    const terminationOutcome = windowsTerminationOutcome || ((timedOut || cancelled)
      ? await terminateProcessTree(subprocess, { graceMs: 0, forceWaitMs })
      : null);
    if (terminationOutcome?.exited === true) {
      await settleTerminatedSubprocess(subprocess, subprocessClose, forceWaitMs);
    }
    if (mutationProcessRecorded && (!timedOut && !cancelled || terminationOutcome?.exited === true)) {
      clearCurrentMutationProcess(subprocess.pid);
    }
    if (timedOut) {
      stderrBuffer.append(`\n[rel-ai-mcp timed out after ${timeoutMs}ms]\n`);
    } else if (cancelled) {
      stderrBuffer.append('\n[rel-ai-mcp operation cancelled]\n');
    }

    await Promise.all([stdoutSpill.flush(), stderrSpill.flush()]);
    const [stdoutSpillResult, stderrSpillResult] = await Promise.all([
      stdoutSpill.finish(),
      stderrSpill.finish()
    ]);
    const spawnError = result.failed
      && !result.signal
      && !timedOut
      && !cancelled
      && (result.exitCode == null || (process.platform === 'win32' && !shell && !windowsExecutableExists(executable, options.cwd, childEnvironment)));
    const error = timedOut
      ? `Timed out after ${timeoutMs}ms`
      : cancelled
        ? errorMessage(options.signal?.reason || 'Operation cancelled.')
        : spawnError
          ? String(result.originalMessage || result.shortMessage || result.message || 'Process failed to start.')
          : undefined;

    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: processOutputText(stdoutBuffer, options.preserveOutputWhitespace),
      stderr: processOutputText(stderrBuffer, options.preserveOutputWhitespace),
      ...(error ? { error } : {}),
      ...(cancelled ? { cancelled: true } : {}),
      timedOut,
      ...(spawnError ? { spawnError: true } : {}),
      ...((timedOut || cancelled) ? {
        terminationConfirmed: terminationOutcome?.exited === true,
        forcedTermination: result.isForcefullyTerminated === true || terminationOutcome?.forced === true
      } : {}),
      queueWaitMs,
      durationMs: Number(result.durationMs || 0),
      stdoutBytes,
      stderrBytes,
      stdoutTruncated: stdoutBuffer.truncated,
      stderrTruncated: stderrBuffer.truncated,
      ...(stdoutSpillResult ? { stdoutOutputRef: stdoutSpillResult.outputRef, stdoutSpillTruncated: stdoutSpillResult.spillTruncated } : {}),
      ...(stderrSpillResult ? { stderrOutputRef: stderrSpillResult.outputRef, stderrSpillTruncated: stderrSpillResult.spillTruncated } : {})
    };
  } finally {
    resourceLease?.release();
  }
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
  onExit: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const processHandle = subprocess.nodeChildProcess;
  const closeLingeringPipe = (stream: { readonly destroyed?: boolean; destroy?(): unknown } | null | undefined): void => {
    if (!stream || stream.destroyed || typeof stream.destroy !== 'function') return;
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

function terminalQueueResult(options: { readonly error: string; readonly cancelled?: boolean; readonly queueTimedOut?: boolean; readonly queueWaitMs: number }): RunProcessResult {
  return {
    exitCode: -1,
    stdout: '',
    stderr: '',
    error: options.error,
    cancelled: options.cancelled === true,
    ...(options.cancelled === true ? { terminationConfirmed: true, forcedTermination: false } : {}),
    timedOut: false,
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

const OUTPUT_SPILL_HIGH_WATER_BYTES = 4 * 1024 * 1024;
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
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.durationMs != null ? { durationMs: result.durationMs } : {}),
    ...(result.queueWaitMs != null ? { queueWaitMs: result.queueWaitMs } : {}),
    ...(result.stdoutBytes != null ? { stdoutBytes: result.stdoutBytes } : {}),
    ...(result.stderrBytes != null ? { stderrBytes: result.stderrBytes } : {}),
    ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(result.stderrTruncated ? { stderrTruncated: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.queueTimedOut ? { queueTimedOut: true } : {}),
    ...(result.cancelled ? { cancelled: true } : {}),
    ...(result.terminationConfirmed != null ? { terminationConfirmed: result.terminationConfirmed } : {}),
    ...(result.forcedTermination ? { forcedTermination: true } : {}),
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {})
  };
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
  appendLimited,
  isProcessTreeAlive,
  killProcessTree,
  runProcess,
  summarizeCommand,
  terminateProcessTree
};
export type {
  ProcessTreeTerminationResult,
  RunProcessOptions,
  RunProcessResult
};
