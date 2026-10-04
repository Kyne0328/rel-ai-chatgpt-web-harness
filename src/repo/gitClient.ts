import * as path from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import { resolveGitExecutable } from '../gitExecutable.js';
import type { GitStatusEntry, ParsedGitStatus } from './gitStatus.ts';

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
  const git = createGitClient(baseDir, options);
  const status = await git.status(['--untracked-files=all']);
  const unborn = await hasNoHead(git);
  return statusResult(status, unborn);
}

function statusResult(status: StatusResult, unborn: boolean): ParsedGitStatus {
  const branch = status.current || null;
  const ahead = Math.max(0, Number(status.ahead || 0));
  const behind = Math.max(0, Number(status.behind || 0));
  const aheadBehind = ahead || behind ? { ahead, behind } : null;
  const entries: GitStatusEntry[] = status.files.map(file => ({
    path: file.path,
    ...(file.from ? { originalPath: file.from } : {}),
    indexStatus: file.index,
    worktreeStatus: file.working_dir,
    untracked: file.index === '?' && file.working_dir === '?',
    raw: file.from
      ? `${file.index}${file.working_dir} ${file.from} -> ${file.path}`
      : `${file.index}${file.working_dir} ${file.path}`
  }));
  return {
    branchRaw: formatBranchRaw(branch, status.tracking, aheadBehind, unborn),
    branch,
    aheadBehind,
    unborn,
    entries
  };
}

async function hasNoHead(git: SimpleGit): Promise<boolean> {
  try {
    await git.revparse(['--verify', 'HEAD']);
    return false;
  } catch {
    return true;
  }
}

function formatBranchRaw(
  branch: string | null,
  tracking: string | null,
  aheadBehind: ParsedGitStatus['aheadBehind'],
  unborn: boolean
): string {
  if (!branch) return '';
  if (unborn) return `## No commits yet on ${branch}`;
  const base = tracking ? `## ${branch}...${tracking}` : `## ${branch}`;
  if (!aheadBehind) return base;
  const parts = [
    ...(aheadBehind.ahead ? [`ahead ${aheadBehind.ahead}`] : []),
    ...(aheadBehind.behind ? [`behind ${aheadBehind.behind}`] : [])
  ];
  return parts.length ? `${base} [${parts.join(', ')}]` : base;
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
