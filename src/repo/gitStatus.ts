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
  readonly opaqueDirectory?: boolean;
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
  readonly repositoryHead?: string;
  readonly entries: GitStatusEntry[];
}

interface GitStatusArgsOptions {
  readonly branch?: boolean;
  readonly version?: 1 | 2;
  readonly untracked?: 'normal' | 'all';
  readonly paths?: readonly string[];
}

function gitStatusArgs(options: GitStatusArgsOptions = {}): string[] {
  if (options.untracked === 'all' && (!options.paths?.length || options.paths.length > 200
    || options.paths.some(file => !file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.endsWith('/') || file.includes('\0') || file.split('/').some(part => part === '.' || part === '..' || part === '.git')))) {
    throw new Error('Untracked-file enumeration requires a bounded file scope.');
  }
  return [
    '--no-optional-locks',
    'status',
    options.version === 2 ? '--porcelain=v2' : '--porcelain=v1',
    '-z',
    ...(options.branch === false ? [] : ['--branch']),
    `--untracked-files=${options.untracked || 'normal'}`,
    ...(options.paths?.length ? ['--', ...options.paths.map(file => `:(literal)${file}`)] : [])
  ];
}

function parseGitStatus(output: unknown): ParsedGitStatus {
  const text = String(output || '');
  return /^(?:# |[12u?!] )/.test(text) ? parsePorcelainV2Z(text) : parsePorcelainV1Z(text);
}

function parsePorcelainV2Z(text: string): ParsedGitStatus {
  const records = text.split('\0');
  const entries: string[] = [];
  let head: string | undefined;
  let branch = '';
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] || '';
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice(13);
      if (value !== '(initial)' && !/^[a-f0-9]{40,64}$/i.test(value)) throw new Error('Invalid Git status HEAD.');
      head = value === '(initial)' ? '' : value;
    } else if (record.startsWith('# branch.head ')) {
      const value = record.slice(14);
      branch = value === '(detached)' ? 'HEAD (no branch)' : value;
    } else if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice(18);
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
      if (!match) throw new Error('Invalid Git status ahead/behind counts.');
      ahead = Number(match[1]);
      behind = Number(match[2]);
    } else if (record.startsWith('# ')) {
      continue;
    } else if (record.startsWith('? ') || record.startsWith('! ')) {
      entries.push(`${record[0]}${record[0]} ${record.slice(2)}`);
    } else {
      const match = /^1 (\S{2}) (?:\S+ ){6}([\s\S]+)$/.exec(record)
        || /^2 (\S{2}) (?:\S+ ){7}([\s\S]+)$/.exec(record)
        || /^u (\S{2}) (?:\S+ ){8}([\s\S]+)$/.exec(record);
      if (!match) throw new Error('Invalid Git status entry.');
      entries.push(`${match[1]!.replaceAll('.', ' ')} ${match[2]}`);
      if (record.startsWith('2 ')) {
        const originalPath = records[++index];
        if (!originalPath) throw new Error('Git rename/copy status is missing its source path.');
        entries.push(originalPath);
      }
    }
  }
  const counts = [ahead ? `ahead ${ahead}` : '', behind ? `behind ${behind}` : ''].filter(Boolean);
  const branchRaw = !branch ? '' : head === ''
    ? `## No commits yet on ${branch}`
    : `## ${branch}${upstream ? `...${upstream}` : ''}${counts.length ? ` [${counts.join(', ')}]` : ''}`;
  const parsed = parsePorcelainV1Z([...(branchRaw ? [branchRaw] : []), ...entries, ''].join('\0'));
  return { ...parsed, ...(head !== undefined ? { repositoryHead: head } : {}) };
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
      ...(indexStatus === '?' && worktreeStatus === '?' && path.endsWith('/') ? { opaqueDirectory: true } : {}),
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

function gitStatusEntryPaths(entry: Pick<GitStatusEntry, 'path' | 'originalPath' | 'indexStatus' | 'worktreeStatus'>): string[] {
  if (entry.path.endsWith('/')) return [];
  return entry.originalPath && (entry.indexStatus === 'R' || entry.worktreeStatus === 'R')
    ? [...new Set([entry.path, entry.originalPath])] : [entry.path];
}

function statusMapFromOutput(output: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of parseGitStatus(output).entries) {
    if (entry.opaqueDirectory) continue;
    const status = `${entry.indexStatus}${entry.worktreeStatus}`;
    map.set(entry.path, status);
    // Both ends of a rename are mutations. Copies retain their source, so do
    // not claim it merely because Git included the similarity record.
    if (entry.originalPath && (entry.indexStatus === 'R' || entry.worktreeStatus === 'R')) {
      // Destination content changes must not re-claim the already removed source.
      map.set(entry.originalPath, `${entry.indexStatus === 'R' ? 'D' : ' '}${entry.worktreeStatus === 'R' ? 'D' : ' '}`);
    }
  }
  return map;
}

export { INTERNAL_STATUS_MAX_BYTES, gitStatusArgs, parseGitStatus, formatGitStatus, statusMapFromOutput, gitStatusEntryPaths };
export type { GitStatusEntry, GitStatusOwner, ParsedGitStatus };
