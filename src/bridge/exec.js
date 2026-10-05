// @ts-check

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runProcess } from '../process.js';

import { getCurrentTaskAbortSignal } from '../toolActivity.js';
import { combineAbortSignals, isTimeoutAbort } from '../abortSignals.js';
import { isPersistentProcessInvocation, resolveOneShotTimeoutMs } from '../executionControl.js';
import { outputSpillOwner } from '../outputSpill.js';
import { runSpan } from '../telemetry.js';
import { isReusableDependencyPath } from '../reusableDependencies.js';
import { createCollectionPathFilter, isPathInside, resolveSafePath } from '../safety.js';
import { normalizeCommandEnv, normalizeExecutionInvocation, resolveCommandCwd } from '../executionInvocation.js';
import { INTERNAL_STATUS_MAX_BYTES, gitStatusArgs, statusMapFromOutput } from '../repo/gitStatus.js';
import { redactCommandForAudit } from '../commandDisplay.js';
import { withTaskEphemeralEnvironment } from '../taskEphemeral.ts';
import { clampNumber } from './limits.js';
const MAX_CHANGED_FILES = 200;
const MAX_FILESYSTEM_MUTATION_FILES = 50_000;
const MAX_FILESYSTEM_MUTATION_ENTRIES = 100_000;
const MAX_FILESYSTEM_MUTATION_MS = 5_000;

function processExecutionError(code, message, retryable = false) {
  const error = /** @type {Error & { code: string, source: string, operation: string, retryable: boolean }} */ (new Error(message));
  error.code = code;
  error.source = 'rel-ai-mcp-process';
  error.operation = 'execute';
  error.retryable = retryable;
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(String(signal.reason || 'Operation cancelled.'));
  error.name = 'AbortError';
  throw error;
}

function executionDeadlineExpired(context = {}, signal) {
  if (signal?.aborted) return isTimeoutAbort(signal);
  const deadlineAtMs = Number(context?.deadlineAtMs);
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0) return false;
  return Date.now() >= deadlineAtMs || signal?.reason?.name === 'TimeoutError';
}

async function readGitStatusMap(workspace, config, signal) {
  // Mutation tracking only needs status records, not branch/ahead metadata. Preserve
  // Git's leading status column explicitly so branch output is no longer needed as a
  // whitespace sentinel for records such as " M file.js".
  throwIfAborted(signal);
  const result = await runProcess('git', gitStatusArgs({ branch: false }), {
    cwd: workspace.path,
    timeout: 30000,
    maxOutputBytes: INTERNAL_STATUS_MAX_BYTES,
    preserveOutputWhitespace: true,
    signal
  }, config);
  throwIfAborted(signal);
  const state = result.spawnError ? 'unavailable'
    : result.stdoutTruncated ? 'output-limit'
      : result.timedOut ? 'timed-out'
        : result.cancelled ? 'cancelled'
          : result.exitCode === 0 ? 'ok'
            : /not a git repository/i.test(String(result.stderr || '')) ? 'not-repository' : 'failed';
  return state === 'ok' ? mutationSnapshotResult(workspace, result.stdout) : { snapshot: null, state };
}

function mutationSnapshotResult(workspace, statusOutput) {
  const snapshot = statusMutationSnapshot(workspace, statusOutput);
  const complete = ![...snapshot.values()].some(value => /\0(?:unreadable:|outside)/.test(value));
  return { snapshot, state: complete ? 'ok' : 'metadata-unreadable' };
}

function statusMutationSnapshot(workspace, statusOutput) {
  const root = path.resolve(workspace.path);
  const statuses = statusMapFromOutput(statusOutput);
  return new Map([...statuses.entries()].map(([file, status]) => [
    file,
    `${status}\0${pathMetadataFingerprint(root, file)}`
  ]));
}

function pathMetadataFingerprint(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!isPathInside(absolute, root)) return 'outside';
  try {
    const stat = fs.lstatSync(absolute, { bigint: true });
    return [stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return `${code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable'}:${String(code || '')}`;
  }
}

async function readFilesystemStatusMap(workspace, signal, limits = {}) {
  throwIfAborted(signal);
  const root = path.resolve(workspace.path);
  // cwd and context includeRoots are not mutation boundaries. Enumerate the
  // workspace, but disclose excluded inputs instead of asserting full coverage.
  const shouldCollect = createCollectionPathFilter(root);
  const maxEntries = clampNumber(limits.maxEntries, 1, MAX_FILESYSTEM_MUTATION_ENTRIES, MAX_FILESYSTEM_MUTATION_ENTRIES);
  const maxFiles = clampNumber(limits.maxFiles, 1, MAX_FILESYSTEM_MUTATION_FILES, MAX_FILESYSTEM_MUTATION_FILES);
  const maxMs = clampNumber(limits.maxMs, 1, MAX_FILESYSTEM_MUTATION_MS, MAX_FILESYSTEM_MUTATION_MS);
  const startedAt = performance.now();
  const snapshot = new Map();
  const observedPaths = new Set();
  const scannedDirectories = new Set();
  const reasons = new Set();
  const pending = [{ absolutePath: root, relativePath: '' }];
  let entryCount = 0;
  let fileCount = 0;
  const exhausted = () => {
    if (performance.now() - startedAt >= maxMs) {
      reasons.add('time-limit');
      return true;
    }
    return false;
  };
  const result = () => ({
    snapshot, observedPaths, scannedDirectories,
    complete: reasons.size === 0,
    reasons: [...reasons].sort(),
    entryCount, fileCount,
    elapsedMs: Math.round(performance.now() - startedAt)
  });

  while (pending.length) {
    throwIfAborted(signal);
    if (exhausted()) break;
    const current = pending.pop();
    if (!current) break;
    try {
      // Unlike readdir, opendir does not materialize a huge flat directory
      // before the entry/time budgets can be checked. Its iterator closes on
      // early return, failure and cancellation.
      const directory = await fs.promises.opendir(current.absolutePath, { bufferSize: 32 });
      for await (const entry of directory) {
        throwIfAborted(signal);
        if (exhausted()) return result();
        if (entryCount >= maxEntries) {
          reasons.add('entry-limit');
          return result();
        }
        entryCount += 1;
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}` : entry.name;
        observedPaths.add(relativePath);
        if (!shouldCollect(relativePath)) {
          if (!isReusableDependencyPath(relativePath)) reasons.add('excluded-path');
          continue;
        }
        const absolutePath = path.join(current.absolutePath, entry.name);
        if (entry.isDirectory()) {
          pending.push({ absolutePath, relativePath });
          continue;
        }
        if (entry.isSymbolicLink()) reasons.add('symbolic-link');
        else if (!entry.isFile()) {
          reasons.add('unsupported-entry');
          continue;
        }
        if (fileCount >= maxFiles) {
          reasons.add('file-limit');
          return result();
        }
        fileCount += 1;
        try {
          const stat = await fs.promises.lstat(absolutePath, { bigint: true });
          snapshot.set(relativePath, [stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':'));
        } catch (error) {
          throwIfAborted(signal);
          reasons.add(error?.code === 'ENOENT' ? 'entry-disappeared' : 'metadata-unreadable');
        }
        if (entryCount % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      scannedDirectories.add(current.relativePath);
    } catch (error) {
      throwIfAborted(signal);
      reasons.add(error?.code === 'ENOENT' ? 'directory-disappeared' : 'directory-unreadable');
    }
  }
  return result();
}

function filesystemPathKnown(snapshot, file) {
  if (snapshot.snapshot.has(file)) return true;
  let current = file;
  while (current) {
    const parent = path.posix.dirname(current);
    const directory = parent === '.' ? '' : parent;
    if (snapshot.scannedDirectories.has(directory) && !snapshot.observedPaths.has(current)) return true;
    if (snapshot.observedPaths.has(current)) return false;
    current = directory;
  }
  return false;
}

function changedFilesystemFiles(before, after) {
  // Unvisited paths are unknown, not additions/deletions. Compare only paths
  // whose presence or absence was actually established in both snapshots.
  const files = [...new Set([...before.snapshot.keys(), ...after.snapshot.keys()])]
    .filter(file => filesystemPathKnown(before, file) && filesystemPathKnown(after, file))
    .filter(file => before.snapshot.get(file) !== after.snapshot.get(file));
  return boundedChangedFiles(files);
}

function filesystemCoverage(value) {
  const { complete, reasons, entryCount, fileCount, elapsedMs } = value;
  return { complete, reasons, entryCount, fileCount, elapsedMs };
}

function changedStatusFiles(before, after) {
  if (!before || !after) return { files: [], truncated: false };
  const all = new Set([...before.keys(), ...after.keys()]);
  const files = [...all]
    .filter(file => before.get(file) !== after.get(file))
    .sort((left, right) => left.localeCompare(right));
  return boundedChangedFiles(files);
}

function boundedChangedFiles(files) {
  const uniqueFiles = [...new Set(files.map(file => String(file || '').replaceAll('\\', '/')).filter(Boolean))]
    .filter(file => !isReusableDependencyPath(file))
    .sort((left, right) => left.localeCompare(right));
  return { files: uniqueFiles.slice(0, MAX_CHANGED_FILES), truncated: uniqueFiles.length > MAX_CHANGED_FILES };
}

function resolveRequestedEphemeralPaths(workspace, values, workSessionId) {
  if (!Array.isArray(values) || values.length === 0) return [];
  if (!workSessionId) {
    throw processExecutionError('EPHEMERAL_PATHS_REQUIRE_WORK_ID', 'ephemeralPaths requires a durable work_id so Rel.AI can own and clean the declared scratch files.');
  }
  const resolved = [];
  for (const value of values) {
    const safe = resolveSafePath(workspace.path, value, { operation: 'write', label: 'Ephemeral workspace path' });
    if (fs.existsSync(safe.absolutePath)) {
      throw processExecutionError('EPHEMERAL_PATH_ALREADY_EXISTS', `Ephemeral workspace path already exists: ${safe.relativePath}. Only new disposable files can be declared ephemeral.`);
    }
    resolved.push(safe.relativePath);
  }
  return [...new Set(resolved)].sort((left, right) => left.localeCompare(right));
}

async function relaiExec(workspace, config, args = {}, context = {}) {
  const {
    command,
    executable,
    input,
    displayCommand,
    processExecutable,
    processArgv,
    executionLabel
  } = normalizeExecutionInvocation(args, 'relai_exec');
  if (!command && isPersistentProcessInvocation(processExecutable, processArgv)) {
    const error = processExecutionError(
      'PERSISTENT_PROCESS_REQUIRED',
      'This command is a persistent application, stream or interactive session. Start it with relai_process action "start" so it has a stable processId and can be stopped independently of the task.'
    );
    error.allowedAlternatives = ['Use relai_process action "start" for emulators, persistent log streams, tracking commands, or interactive sessions.'];
    throw error;
  }
  const cwd = resolveCommandCwd(workspace, args.cwd);
  const workSessionId = String(context.taskId || args.work_id || '').trim();
  const ephemeralPaths = resolveRequestedEphemeralPaths(workspace, args.ephemeralPaths, workSessionId);
  const requestedEnv = normalizeCommandEnv(args.env);
  const env = withTaskEphemeralEnvironment(config, workSessionId, workspace, requestedEnv);
  const timeoutMs = resolveOneShotTimeoutMs(args, context, { minMs: 1000, maxMs: 86400000, fallbackMs: 120000 });
  const maxOutputBytes = clampNumber(args.maxOutputBytes, 1000, 16 * 1024 * 1024, 2 * 1024 * 1024);
  const signal = combineAbortSignals(
    getCurrentTaskAbortSignal(),

    context.signal
  );
  const trackMutation = context.mutationTrackingRequired !== false;
  const commandSummary = redactCommandForAudit(displayCommand);
  let statusBefore = null;
  let filesystemBefore = null;
  const mutationTrackingDetails = {};
  if (trackMutation) {
    try {
      const before = typeof context.preExecutionGitStatus === 'string'
        ? mutationSnapshotResult(workspace, context.preExecutionGitStatus)
        : await readGitStatusMap(workspace, config, signal);
      statusBefore = before.snapshot;
      mutationTrackingDetails.gitBefore = before.state;
      filesystemBefore = !statusBefore ? await readFilesystemStatusMap(workspace, signal) : null;
      if (filesystemBefore) mutationTrackingDetails.filesystemBefore = filesystemCoverage(filesystemBefore);
    } catch (error) {
      if (!signal?.aborted) throw error;
      const timedOut = executionDeadlineExpired(context, signal);
      return {
        ok: true,
        executed: false,
        commandSucceeded: false,
        workspace: workspace.alias,
        command: commandSummary,
        commandSummary,
        cwd: cwd.relativePath,
        shell: executionLabel,
        exitCode: -1,
        durationMs: 0,
        queueWaitMs: 0,
        stdout: '',
        stderr: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut,
        cancelled: !timedOut,
        terminationConfirmed: true,
        error: timedOut
          ? `Timed out after ${Number(args.timeoutMs)}ms`
          : signal.reason instanceof Error ? signal.reason.message : String(signal.reason || 'Operation cancelled.'),
        changedFiles: [],
        changedFilesTruncated: false,
        mutationTracking: 'cancelled-before-execution',
        mutationUnknown: false
      };
    }
  }
  context.onOperationPhase?.({ phase: 'running', executed: false });
  const result = await runSpan(config, 'relai.process.exec', {
    'relai.workspace': workspace.alias,
    'relai.process.command': displayCommand,
    'relai.process.execution_mode': command ? 'shell' : 'direct',

  }, () => runProcess(
    processExecutable,
    processArgv,
    {
      cwd: cwd.absolutePath,
      env,
      timeout: timeoutMs,
      deadlineAtMs: context.deadlineAtMs,
      preserveOutputWhitespace: true,
      maxOutputBytes,
      signal,
      resourceClass: context.resourceClass === 'light' ? undefined : 'heavy',
      onPhase: event => context.onOperationPhase?.(event),
      resourceOwner: workspace.alias,
      outputSpillTaskId: outputSpillOwner({
        taskId: context.taskId || args.work_id,
        workspace: workspace.alias,
        principal: context.principal
      }),
      ...(input !== undefined ? { input } : {})
    },
    config
  ));
  if (result.spawnError) {
    const host = command ? executionLabel : executable;
    throw processExecutionError('PROCESS_SPAWN_FAILED', `Could not start ${host}: ${result.error || 'unknown spawn error'}`);
  }
  context.onOperationPhase?.({ phase: 'reconciling', executed: result.executed === true, terminationConfirmed: result.terminationConfirmed });
  let mutationTracking = 'unavailable';
  let mutationUnknown = false;
  let changed;
  if (result.executed === false) {
    changed = { files: [], truncated: false };
    mutationTracking = 'not-executed';
  } else if (!trackMutation) {
    changed = { files: [], truncated: false };
    mutationTracking = 'declared-read-only';
  } else {
    try {
      const after = await readGitStatusMap(workspace, config, signal);
      const statusAfter = after.snapshot;
      mutationTrackingDetails.gitAfter = after.state;
      if (statusBefore && statusAfter) {
        changed = changedStatusFiles(statusBefore, statusAfter);
        mutationTracking = 'git';
        mutationUnknown = mutationTrackingDetails.gitBefore !== 'ok' || after.state !== 'ok';
      } else if (!statusBefore && filesystemBefore) {
        const filesystemAfter = await readFilesystemStatusMap(workspace, signal);
        changed = changedFilesystemFiles(filesystemBefore, filesystemAfter);
        mutationTrackingDetails.filesystemAfter = filesystemCoverage(filesystemAfter);
        mutationTracking = 'filesystem';
        mutationUnknown = filesystemBefore.complete !== true || filesystemAfter.complete !== true
          || mutationTrackingDetails.gitBefore !== 'not-repository' || after.state !== 'not-repository';
      } else {
        changed = { files: [], truncated: false };
        mutationUnknown = true;
      }
    } catch {
      // The command already ran. A bookkeeping failure must preserve that
      // outcome rather than invite an unsafe retry of the physical command.
      mutationTrackingDetails.gitAfter = signal?.aborted ? 'cancelled' : 'failed';
      changed = { files: [], truncated: false };
      mutationUnknown = true;
    }
  }
  if (changed.truncated) mutationUnknown = true;
  const deadlineTimedOut = executionDeadlineExpired(context, signal);
  const timedOut = result.timedOut === true || deadlineTimedOut;
  const cancelled = result.cancelled === true && !deadlineTimedOut;
  const commandSucceeded = result.exitCode === 0 && !timedOut && !cancelled;
  const changedSet = new Set(changed.files);
  const ephemeralChangedFiles = ephemeralPaths.filter(file => changedSet.has(file));
  return {
    ok: true,
    executed: result.executed === true,
    commandSucceeded,
    workspace: workspace.alias,
    command: commandSummary,
    commandSummary,
    cwd: cwd.relativePath,
    shell: executionLabel,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    queueWaitMs: result.queueWaitMs || 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    stdoutBytes: result.stdoutBytes || 0,
    stderrBytes: result.stderrBytes || 0,
    stdoutTruncated: result.stdoutTruncated === true,
    stderrTruncated: result.stderrTruncated === true,
    ...(result.stdoutOutputRef ? { stdoutOutputRef: result.stdoutOutputRef } : {}),
    ...(result.stdoutSpillTruncated != null ? { stdoutSpillTruncated: result.stdoutSpillTruncated === true } : {}),
    ...(result.stderrOutputRef ? { stderrOutputRef: result.stderrOutputRef } : {}),
    ...(result.stderrSpillTruncated != null ? { stderrSpillTruncated: result.stderrSpillTruncated === true } : {}),
    timedOut,
    queueTimedOut: result.queueTimedOut === true,
    ...(typeof result.rootExitConfirmed === 'boolean' ? { rootExitConfirmed: result.rootExitConfirmed } : {}),
    ...(result.outputFinalizationTimedOut ? { outputFinalizationTimedOut: true } : {}),
    ...(result.outputFinalizationError ? { outputFinalizationError: result.outputFinalizationError } : {}),
    ...(result.mutationOwnershipPersistenceError ? { mutationOwnershipPersistenceError: result.mutationOwnershipPersistenceError } : {}),
    cancelled,
    ...(result.terminationConfirmed != null ? { terminationConfirmed: result.terminationConfirmed === true } : {}),
    ...(result.forcedTermination != null ? { forcedTermination: result.forcedTermination === true } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(deadlineTimedOut
      ? { error: `Timed out after ${Number(args.timeoutMs)}ms` }
      : result.error ? { error: result.error } : {}),
    ...(Object.keys(requestedEnv).length ? { environmentKeys: Object.keys(requestedEnv).sort((left, right) => left.localeCompare(right)) } : {}),
    changedFiles: changed.files,
    ...(ephemeralChangedFiles.length ? { ephemeralChangedFiles } : {}),
    changedFilesTruncated: changed.truncated,
    mutationTracking,
    ...(trackMutation ? { mutationTrackingDetails } : {}),
    ...(mutationUnknown ? { mutationUnknown: true } : {})
  };
}

export { relaiExec, readFilesystemStatusMap, changedFilesystemFiles };
