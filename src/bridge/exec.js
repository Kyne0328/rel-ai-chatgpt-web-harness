// @ts-check

import * as fs from 'node:fs';
import * as path from 'node:path';
import { runProcess } from '../process.js';
import { nativeToolTaskSignal } from '../mcp/nativeToolTasks.js';
import { getCurrentTaskAbortSignal } from '../toolActivity.js';
import { combineAbortSignals } from '../abortSignals.js';
import { outputSpillOwner } from '../outputSpill.js';
import { runSpan } from '../telemetry.js';
import { isReusableDependencyPath } from '../reusableDependencies.js';
import { createCollectionPathFilter, isPathInside } from '../safety.js';
import { normalizeCommandEnv, normalizeExecutionInvocation, resolveCommandCwd } from '../executionInvocation.js';
import { INTERNAL_STATUS_MAX_BYTES, gitStatusArgs, statusMapFromOutput } from '../repo/gitStatus.js';
import { redactCommandForAudit } from '../commandDisplay.js';
import { clampNumber } from './limits.js';
const MAX_CHANGED_FILES = 200;
const MAX_FILESYSTEM_MUTATION_FILES = 50_000;

function processExecutionError(code, message, retryable = false) {
  const error = /** @type {Error & { code: string, source: string, operation: string, retryable: boolean }} */ (new Error(message));
  error.code = code;
  error.source = 'rel-ai-mcp-process';
  error.operation = 'execute';
  error.retryable = retryable;
  return error;
}

async function readGitStatusMap(workspace, config) {
  // Mutation tracking only needs status records, not branch/ahead metadata. Preserve
  // Git's leading status column explicitly so branch output is no longer needed as a
  // whitespace sentinel for records such as " M file.js".
  const result = await runProcess('git', gitStatusArgs({ branch: false }), {
    cwd: workspace.path,
    timeout: 30000,
    maxOutputBytes: INTERNAL_STATUS_MAX_BYTES,
    preserveOutputWhitespace: true
  }, config);
  if (result.exitCode !== 0 || result.stdoutTruncated) return null;
  return statusMutationSnapshot(workspace, result.stdout);
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
    return `missing:${String(code || '')}`;
  }
}

async function readFilesystemStatusMap(workspace) {
  const root = path.resolve(workspace.path);
  // Mutation accounting is an integrity boundary, not a read-context boundary.
  // Cover the whole workspace even when normal repository context is narrowed.
  const shouldCollect = createCollectionPathFilter(root);
  const snapshot = new Map();
  const pending = [{ absolutePath: root, relativePath: '' }];
  let complete = true;
  let fileCount = 0;

  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = await fs.promises.readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      if (!shouldCollect(relativePath)) continue;
      if (entry.isSymbolicLink()) {
        complete = false;
        continue;
      }
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (entry.isDirectory()) {
        pending.push({ absolutePath, relativePath });
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (fileCount > MAX_FILESYSTEM_MUTATION_FILES) {
        return { snapshot, complete: false };
      }
      snapshot.set(relativePath, await pathMetadataFingerprintAsync(root, relativePath));
      // A non-Git execution may need to inspect tens of thousands of files.
      // Yield periodically so mutation accounting cannot monopolize the
      // service event loop while retaining its whole-workspace coverage.
      if (fileCount % 128 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  }
  return { snapshot, complete };
}

async function pathMetadataFingerprintAsync(root, relativePath) {
  const absolute = path.resolve(root, relativePath);
  if (!isPathInside(absolute, root)) return 'outside';
  try {
    const stat = await fs.promises.lstat(absolute, { bigint: true });
    return [stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join(':');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return `missing:${String(code || '')}`;
  }
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
  const cwd = resolveCommandCwd(workspace, args.cwd);
  const env = normalizeCommandEnv(args.env);
  const timeoutMs = clampNumber(args.timeoutMs, 1000, 86400000, 120000);
  const maxOutputBytes = clampNumber(args.maxOutputBytes, 1000, 16 * 1024 * 1024, 2 * 1024 * 1024);
  const trackMutation = context.mutationTrackingRequired !== false;
  const statusBefore = trackMutation ? await readGitStatusMap(workspace, config) : null;
  const filesystemBefore = trackMutation && !statusBefore ? await readFilesystemStatusMap(workspace) : null;
  const signal = combineAbortSignals(
    getCurrentTaskAbortSignal(),
    args._operationTaskId ? nativeToolTaskSignal(args._operationTaskId) : undefined,
    context.signal
  );
  const commandSummary = redactCommandForAudit(displayCommand);
  const result = await runSpan(config, 'relai.process.exec', {
    'relai.workspace': workspace.alias,
    'relai.process.command': commandSummary,
    'relai.process.execution_mode': command ? 'shell' : 'direct',
    'relai.operation_task.id': String(args._operationTaskId || '')
  }, () => runProcess(
    processExecutable,
    processArgv,
    {
      cwd: cwd.absolutePath,
      env,
      timeout: timeoutMs,
      maxOutputBytes,
      signal,
      resourceClass: 'heavy',
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
  let mutationTracking = 'unavailable';
  let mutationUnknown = false;
  let changed;
  if (!trackMutation) {
    changed = { files: [], truncated: false };
    mutationTracking = 'declared-read-only';
  } else {
    const statusAfter = await readGitStatusMap(workspace, config);
    if (statusBefore && statusAfter) {
      changed = changedStatusFiles(statusBefore, statusAfter);
      mutationTracking = 'git';
    } else if (!statusBefore && filesystemBefore) {
      const filesystemAfter = await readFilesystemStatusMap(workspace);
      changed = changedStatusFiles(filesystemBefore.snapshot, filesystemAfter.snapshot);
      mutationTracking = 'filesystem';
      mutationUnknown = filesystemBefore.complete !== true || filesystemAfter.complete !== true;
    } else {
      changed = { files: [], truncated: false };
      mutationUnknown = true;
    }
  }
  const commandSucceeded = result.exitCode === 0 && result.timedOut !== true && result.cancelled !== true;
  return {
    ok: true,
    executed: true,
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
    ...(result.stdoutOutputRef ? { stdoutOutputRef: result.stdoutOutputRef, stdoutSpillTruncated: result.stdoutSpillTruncated === true } : {}),
    ...(result.stderrOutputRef ? { stderrOutputRef: result.stderrOutputRef, stderrSpillTruncated: result.stderrSpillTruncated === true } : {}),
    timedOut: result.timedOut === true,
    queueTimedOut: result.queueTimedOut === true,
    cancelled: result.cancelled === true,
    ...(result.terminationConfirmed != null ? { terminationConfirmed: result.terminationConfirmed === true } : {}),
    ...(result.forcedTermination != null ? { forcedTermination: result.forcedTermination === true } : {}),
    ...(result.signal ? { signal: result.signal } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(Object.keys(env).length ? { environmentKeys: Object.keys(env).sort((left, right) => left.localeCompare(right)) } : {}),
    changedFiles: changed.files,
    changedFilesTruncated: changed.truncated,
    mutationTracking,
    ...(mutationUnknown ? { mutationUnknown: true } : {})
  };
}

export { relaiExec };
