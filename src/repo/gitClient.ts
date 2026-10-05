import * as path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { resolveGitExecutable } from '../gitExecutable.js';
import { runProcess } from '../process.js';
import { INTERNAL_STATUS_MAX_BYTES, gitStatusArgs, parseGitStatus, type ParsedGitStatus } from './gitStatus.ts';

type GitClientOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

function createGitClient(baseDir: string, options: GitClientOptions = {}): SimpleGit {
  const timeoutMs = boundedTimeout(options.timeoutMs, 30_000);
  const resolvedBinary = resolveGitExecutable();
  const pathLookup = !resolvedBinary || gitExecutableIsOnPath(resolvedBinary);
  return simpleGit({
    baseDir,
    binary: pathLookup ? 'git' : resolvedBinary,
    maxConcurrentProcesses: 1,
    trimmed: false,
    ...(options.signal ? { abort: options.signal } : {}),
    ...(!pathLookup ? { unsafe: { allowUnsafeCustomBinary: true } } : {}),
    timeout: { block: timeoutMs, stdOut: false, stdErr: false }
  });
}

async function checkGitRepository(baseDir: string, options: GitClientOptions = {}): Promise<boolean> {
  return createGitClient(baseDir, options).checkIsRepo();
}

async function readGitStatus(baseDir: string, options: GitClientOptions = {}): Promise<ParsedGitStatus> {
  options.signal?.throwIfAborted();
  // Porcelain's branch header already distinguishes unborn HEAD. A second
  // rev-parse both duplicates work and mistakes permission/timeout failures for
  // an unborn repository. Keep this read bounded and use one coherent snapshot.
  const result = await runProcess('git', gitStatusArgs({ version: 2 }), {
    cwd: baseDir,
    timeout: boundedTimeout(options.timeoutMs, 30_000),
    maxOutputBytes: INTERNAL_STATUS_MAX_BYTES,
    preserveOutputWhitespace: true,
    ...(options.signal ? { signal: options.signal } : {})
  });
  options.signal?.throwIfAborted();
  if (result.exitCode !== 0 || result.stdoutTruncated) {
    const error = new Error(result.stdoutTruncated
      ? 'Git status exceeded the internal output limit.'
      : String(result.error || result.stderr || 'Git status failed.'));
    Object.assign(error, { code: result.stdoutTruncated ? 'GIT_STATUS_TRUNCATED' : 'GIT_STATUS_FAILED' });
    throw error;
  }
  return parseGitStatus(result.stdout);
}

function gitExecutableIsOnPath(executable: string): boolean {
  const resolved = path.resolve(executable);
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(directory => path.resolve(directory, path.basename(executable)) === resolved);
}

function boundedTimeout(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(86_400_000, Math.max(1000, Math.floor(number)));
}

export { checkGitRepository, readGitStatus };
