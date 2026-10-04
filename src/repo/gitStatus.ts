const INTERNAL_STATUS_MAX_BYTES = 8 * 1024 * 1024;

type GitStatusOwner = 'session' | 'baseline' | 'unknown';

interface GitStatusEntry {
  readonly path: string;
  readonly originalPath?: string;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly untracked: boolean;
  readonly raw: string;
  readonly owner?: GitStatusOwner;
}

/** Ahead/behind counts are part of the exported Git status contract. */
export interface GitAheadBehind {
  readonly ahead: number;
  readonly behind: number;
}

interface ParsedGitStatus {
  readonly branchRaw: string;
  readonly branch: string | null;
  readonly aheadBehind: GitAheadBehind | null;
  readonly unborn: boolean;
  readonly entries: GitStatusEntry[];
}

interface GitStatusArgsOptions {
  readonly branch?: boolean;
}

function gitStatusArgs(options: GitStatusArgsOptions = {}): string[] {
  return [
    'status',
    '--porcelain=v1',
    '-z',
    ...(options.branch === false ? [] : ['--branch']),
    '--untracked-files=all'
  ];
}

function parseGitStatus(output: unknown): ParsedGitStatus {
  return parsePorcelainV1Z(String(output || ''));
}

function parsePorcelainV1Z(text: string): ParsedGitStatus {
  const records = text.split('\0');
  const entries: GitStatusEntry[] = [];
  let branchRaw = '';
  let branch: string | null = null;
  let aheadBehind: GitAheadBehind | null = null;
  let unborn = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('## ')) {
      branchRaw = record;
      const parsed = parseStatusBranchLine(record);
      branch = parsed.branch;
      aheadBehind = parsed.aheadBehind;
      unborn = parsed.unborn;
      continue;
    }
    if (record.length < 3) continue;
    const indexStatus = record.charAt(0);
    const worktreeStatus = record.charAt(1);
    const path = record.slice(3);
    if (!path) continue;
    const renamedOrCopied = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C';
    const originalPath = renamedOrCopied ? String(records[index + 1] || '') : '';
    if (renamedOrCopied) index += 1;
    entries.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      indexStatus,
      worktreeStatus,
      untracked: indexStatus === '?' && worktreeStatus === '?',
      raw: originalPath
        ? `${indexStatus}${worktreeStatus} ${originalPath} -> ${path}`
        : `${indexStatus}${worktreeStatus} ${path}`
    });
  }

  return { branchRaw, branch, aheadBehind, unborn, entries };
}

function parseStatusBranchLine(line: string): Pick<ParsedGitStatus, 'branch' | 'aheadBehind' | 'unborn'> {
  const text = line.replace(/^##\s+/, '').trim();
  const unbornMatch = /^(?:No commits yet on|Initial commit on)\s+(.+)$/.exec(text);
  if (unbornMatch) {
    const branchPart = String(unbornMatch[1] || '').split('...')[0]?.trim() || '';
    return {
      branch: branchPart || null,
      aheadBehind: null,
      unborn: true
    };
  }
  const aheadMatch = /ahead (\d+)/.exec(text);
  const behindMatch = /behind (\d+)/.exec(text);
  const branchPart = text.split('...')[0]?.trim() || '';
  return {
    branch: branchPart || null,
    aheadBehind: aheadMatch || behindMatch ? {
      ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
      behind: behindMatch ? Number(behindMatch[1]) : 0
    } : null,
    unborn: false
  };
}

function formatGitStatus(parsed: Pick<ParsedGitStatus, 'branchRaw' | 'entries'> | null | undefined): string {
  const lines: string[] = [];
  if (parsed?.branchRaw) lines.push(parsed.branchRaw);
  for (const entry of parsed?.entries || []) lines.push(entry.raw || `${entry.indexStatus}${entry.worktreeStatus} ${entry.path}`);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function statusMapFromOutput(output: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseGitStatus(output).entries) {
    map.set(entry.path, `${entry.indexStatus}${entry.worktreeStatus}`);
  }
  return map;
}

export { INTERNAL_STATUS_MAX_BYTES, gitStatusArgs, parseGitStatus, formatGitStatus, statusMapFromOutput };
export type { GitStatusEntry, GitStatusOwner, ParsedGitStatus };
