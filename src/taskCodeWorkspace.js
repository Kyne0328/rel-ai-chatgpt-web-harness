import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveWorkspace } from './config.js';
import { runProcess } from './process.js';
import { gitStatusArgs, parseGitStatus } from './repo/gitStatus.js';
import { collectOptionsFromWorkspace, createCollectionPathFilter, isSecretPath, looksBinary, resolveSafePath } from './safety.js';
import { readTaskHistorySessionRecord } from './taskHistoryStore.ts';
import { readTaskIntegrity, taskOwnedChangedFiles } from './taskIntegrity.ts';

const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_FILES = 500;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const HISTORICAL_LOG_LIMIT = 200;

async function describeTaskCodeWorkspace(config, payload = {}) {
  const context = resolveTaskCodeContext(config, payload.taskId);
  const live = await listLiveTaskChanges(config, context);
  const historical = live.changedFiles.length
    ? null
    : await listHistoricalTaskChanges(config, context);
  const changes = historical || live;
  return {
    ok: true,
    work_id: context.taskId,
    workspace: context.baseWorkspace.alias,
    workspaceMode: 'visible',
    integrationStatus: 'not_applicable',
    status: String(context.session.status || ''),
    readOnly: true,
    writable: false,
    files: changes.changedFiles,
    changedFiles: changes.changedFiles,
    changedFileStatuses: changes.changedFileStatuses,
    changedFileCount: changes.changedFiles.length,
    fileCount: changes.changedFiles.length,
    historyMode: changes.historyMode,
    historyAvailable: changes.historyAvailable,
    commitHead: changes.commitHeads.at(-1) || '',
    commitHeads: changes.commitHeads,
    commitSource: changes.commitSource,
    truncated: changes.truncated
  };
}

async function readTaskCodeDiff(config, payload = {}) {
  const context = resolveTaskCodeContext(config, payload.taskId);
  const requestedPath = normalizeTaskPath(context, payload.path);
  const live = await listLiveTaskChanges(config, context);
  if (live.changedFiles.includes(requestedPath)) {
    return readLiveTaskDiff(config, context, requestedPath);
  }

  const historical = await historicalCommitContext(config, context);
  if (historical.commitHeads.length) {
    return readHistoricalTaskDiff(config, context, requestedPath, historical);
  }

  const recorded = historicalTaskFiles(context);
  if (recorded.includes(requestedPath)) {
    const error = new Error('This older task records the changed file, but Rel.AI cannot safely identify the Git commit that contains its final diff.');
    error.code = 'TASK_DIFF_HISTORY_UNAVAILABLE';
    throw error;
  }

  throw new Error(`The selected file is not recorded as a change for this task: ${requestedPath}`);
}

function resolveTaskCodeContext(config, taskIdValue) {
  const taskId = String(taskIdValue || '').trim();
  if (!taskId) throw new Error('A task ID is required for the changes viewer.');
  const session = readTaskHistorySessionRecord(config, taskId, { reconcileInactive: false });
  if (!session) {
    const error = new Error('The selected Rel.AI task no longer exists.');
    error.code = 'TASK_NOT_FOUND';
    throw error;
  }
  const taskWorkspaceAlias = String(session.workspace || '').trim();
  let baseWorkspace;
  try {
    baseWorkspace = resolveWorkspace(config, taskWorkspaceAlias);
  } catch (error) {
    if (error?.code !== 'WORKSPACE_NOT_CONFIGURED') throw error;
    const workspacePath = String(readTaskIntegrity(config, taskId)?.workspacePath || '').trim();
    if (!workspacePath) throw error;
    baseWorkspace = resolveWorkspace(config, workspacePath);
  }
  return {
    taskId,
    session,
    taskWorkspaceAlias,
    baseWorkspace,
    executionPath: baseWorkspace.path
  };
}

async function listLiveTaskChanges(config, context) {
  const repositoryChanges = await repositoryChangedEntries(config, context.executionPath);
  const ownedChanges = new Set(
    taskOwnedChangedFiles(config, context.taskId, context.taskWorkspaceAlias)
      .map(normalizePath)
      .filter(Boolean)
  );
  const changedEntries = repositoryChanges
    .filter(entry => ownedChanges.has(entry.path))
    .filter(entry => isSelectableChangeEntry(context.executionPath, entry))
    .slice(0, MAX_CHANGED_FILES);
  const changedFiles = changedEntries.map(entry => entry.path);
  const lineStats = await gitLineStats(config, context.executionPath, ['diff', '--no-ext-diff', '--numstat', 'HEAD'], changedFiles);
  return {
    changedFiles,
    changedFileStatuses: Object.fromEntries(changedEntries.map(entry => [entry.path, { ...changeStatus(entry), ...lineStats[entry.path] }])),
    historyMode: 'live',
    historyAvailable: true,
    commitHeads: [],
    commitSource: '',
    truncated: changedEntries.length < repositoryChanges.filter(entry => ownedChanges.has(entry.path)).length
  };
}

async function listHistoricalTaskChanges(config, context) {
  const taskFiles = historicalTaskFiles(context);
  if (!taskFiles.length) return null;
  const historical = await historicalCommitContext(config, context, taskFiles);
  if (!historical.commitHeads.length) {
    return {
      changedFiles: taskFiles,
      changedFileStatuses: Object.fromEntries(taskFiles.map(file => [file, {
        code: '?', label: 'Historical change', tone: 'neutral'
      }])),
      historyMode: 'unavailable',
      historyAvailable: false,
      commitHeads: [],
      commitSource: '',
      truncated: false
    };
  }

  const entries = await historicalChangedEntries(config, context, historical.commitHeads, taskFiles);
  const entryByPath = new Map(entries.map(entry => [entry.path, entry]));
  const changedFiles = taskFiles.filter(file => entryByPath.has(file));
  if (!changedFiles.length) return null;
  const lineStats = await historicalLineStats(config, context, historical.commitHeads, changedFiles);
  return {
    changedFiles,
    changedFileStatuses: Object.fromEntries(changedFiles.map(file => [file, { ...changeStatus(entryByPath.get(file)), ...lineStats[file] }])),
    historyMode: 'committed',
    historyAvailable: true,
    commitHeads: historical.commitHeads,
    commitSource: historical.source,
    truncated: false
  };
}

function historicalTaskFiles(context) {
  const acceptsPath = createCollectionPathFilter(
    context.executionPath,
    collectOptionsFromWorkspace(context.baseWorkspace)
  );
  return unique((Array.isArray(context.session.changedFiles) ? context.session.changedFiles : [])
    .map(normalizePath)
    .filter(file => file && !isSecretPath(file) && acceptsPath(file)))
    .slice(0, MAX_CHANGED_FILES);
}

async function historicalCommitContext(config, context, taskFiles = historicalTaskFiles(context)) {
  if (!taskFiles.length) return { commitHeads: [], source: '' };
  const recorded = unique([
    ...(Array.isArray(context.session.commitHeads) ? context.session.commitHeads : []),
    context.session.commitHead
  ].map(normalizeCommit).filter(Boolean));
  const verified = [];
  for (const head of recorded) {
    if (await commitExists(config, context, head)) verified.push(head);
  }
  if (verified.length) return { commitHeads: verified, source: 'recorded' };

  const inferred = await inferHistoricalCommit(config, context, taskFiles);
  return inferred ? { commitHeads: [inferred], source: 'inferred' } : { commitHeads: [], source: '' };
}

async function inferHistoricalCommit(config, context, taskFiles) {
  if (!taskFiles.length) return '';
  const args = [
    '-c', 'core.quotepath=false',
    'log',
    `--max-count=${HISTORICAL_LOG_LIMIT}`,
    '--format=__RELAI_COMMIT__%H%x09%cI',
    '--name-only',
    '--no-renames'
  ];
  const upperBound = historicalUpperBound(context.session);
  if (upperBound) args.push(`--before=${upperBound}`);
  args.push('--', ...taskFiles);
  const result = await runProcess('git', args, {
    cwd: context.executionPath,
    timeout: GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    preserveOutputWhitespace: true
  }, config).catch(() => null);
  if (!result || result.exitCode !== 0 || result.stdoutTruncated) return '';

  const candidates = parseHistoricalLog(result.stdout || '');
  for (const candidate of candidates) {
    if (taskFiles.every(file => candidate.files.has(file))) return candidate.head;
  }
  return '';
}

function historicalUpperBound(session = {}) {
  const raw = session.completedAt || session.endedAt || session.updatedAt || '';
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp + (5 * 60 * 1000)).toISOString();
}

function parseHistoricalLog(output) {
  const commits = [];
  let current = null;
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (rawLine.startsWith('__RELAI_COMMIT__')) {
      if (current) commits.push(current);
      const [head = '', date = ''] = rawLine.slice('__RELAI_COMMIT__'.length).split('\t');
      current = { head: normalizeCommit(head), date, files: new Set() };
      continue;
    }
    const file = normalizePath(rawLine);
    if (current && file) current.files.add(file);
  }
  if (current) commits.push(current);
  return commits.filter(commit => commit.head);
}

async function historicalChangedEntries(config, context, commitHeads, taskFiles) {
  const wanted = new Set(taskFiles);
  const byPath = new Map();
  for (const head of commitHeads) {
    const result = await runProcess('git', [
      '-c', 'core.quotepath=false',
      'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', head, '--', ...taskFiles
    ], {
      cwd: context.executionPath,
      timeout: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
      preserveOutputWhitespace: true
    }, config).catch(() => null);
    if (!result || result.exitCode !== 0 || result.stdoutTruncated) continue;
    for (const entry of parseNameStatus(result.stdout || '')) {
      const pathValue = wanted.has(entry.path)
        ? entry.path
        : entry.originalPath && wanted.has(entry.originalPath) ? entry.originalPath : '';
      if (!pathValue) continue;
      byPath.set(pathValue, { ...entry, path: pathValue, commitHead: head });
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function parseNameStatus(output) {
  const entries = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = String(parts[0] || '').trim();
    const code = status.charAt(0).toUpperCase();
    if (['R', 'C'].includes(code) && parts.length >= 3) {
      const originalPath = normalizePath(parts[1]);
      const nextPath = normalizePath(parts[2]);
      if (nextPath) entries.push({ path: nextPath, originalPath, historyStatus: code });
      continue;
    }
    const file = normalizePath(parts[1]);
    if (file) entries.push({ path: file, historyStatus: code || 'M' });
  }
  return entries;
}

async function readLiveTaskDiff(config, context, requestedPath) {
  const current = await readOptionalTextFile(context.executionPath, requestedPath);
  const original = await readBaseFile(config, context, current.path);
  if (!current.exists && !original.exists) throw new Error(`The changed file is not available in the task or its Git baseline: ${current.path}`);
  return {
    ok: true,
    work_id: context.taskId,
    workspace: context.baseWorkspace.alias,
    path: current.path,
    content: current.content,
    sha256: current.sha256,
    exists: current.exists,
    baseContent: original.available === false ? current.content : original.content,
    baseExists: original.exists,
    baseAvailable: original.available !== false,
    language: viewerLanguage(current.path),
    writable: false,
    readOnly: true,
    historyMode: 'live',
    commitHead: ''
  };
}

async function readHistoricalTaskDiff(config, context, requestedPath, historical) {
  const taskFiles = historicalTaskFiles(context);
  if (!taskFiles.includes(requestedPath)) {
    throw new Error(`The selected file is not recorded as a change for this task: ${requestedPath}`);
  }

  const touching = [];
  let firstEntry = null;
  for (const head of historical.commitHeads) {
    const entries = await historicalChangedEntries(config, context, [head], [requestedPath]);
    const entry = entries.find(item => item.path === requestedPath);
    if (!entry) continue;
    touching.push(head);
    if (!firstEntry) firstEntry = entry;
  }
  if (!touching.length) {
    const error = new Error('Rel.AI found the task commit history, but this file is not part of those commits.');
    error.code = 'TASK_DIFF_HISTORY_UNAVAILABLE';
    throw error;
  }

  const firstHead = touching[0];
  const lastHead = touching.at(-1);
  const basePath = firstEntry?.originalPath || requestedPath;
  const original = await readGitTextFile(config, context, `${firstHead}^`, basePath);
  const current = await readGitTextFile(config, context, lastHead, requestedPath);
  if (!current.exists && !original.exists) {
    throw new Error(`The historical file is not available in the recorded task commits: ${requestedPath}`);
  }
  return {
    ok: true,
    work_id: context.taskId,
    workspace: context.baseWorkspace.alias,
    path: requestedPath,
    content: current.content,
    sha256: current.sha256,
    exists: current.exists,
    baseContent: original.content,
    baseExists: original.exists,
    baseAvailable: true,
    language: viewerLanguage(requestedPath),
    writable: false,
    readOnly: true,
    historyMode: 'committed',
    commitHead: lastHead,
    commitHeads: touching,
    commitSource: historical.source
  };
}

async function repositoryChangedEntries(config, cwd) {
  const status = await runProcess('git', gitStatusArgs(), {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    preserveOutputWhitespace: true
  }, config).catch(() => null);
  if (!status || status.exitCode !== 0 || status.stdoutTruncated) return [];
  const parsed = parseGitStatus(status.stdout || '');
  return (parsed.entries || []).map(entry => ({
    path: normalizePath(entry.path),
    indexStatus: String(entry.indexStatus || ' '),
    worktreeStatus: String(entry.worktreeStatus || ' '),
    untracked: entry.untracked === true,
    ...(entry.originalPath ? { originalPath: normalizePath(entry.originalPath) } : {})
  })).filter(entry => entry.path).sort((left, right) => left.path.localeCompare(right.path));
}

function isSelectableChangeEntry(root, entry = {}) {
  const relativePath = normalizePath(entry.path);
  if (!relativePath || isSecretPath(relativePath)) return false;
  const absolutePath = path.join(root, relativePath);
  try {
    const stat = fs.lstatSync(absolutePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return false;
    return entry.indexStatus === 'D' || entry.worktreeStatus === 'D';
  }
}

async function historicalLineStats(config, context, commitHeads, files) {
  const totals = {};
  for (const head of commitHeads) {
    const stats = await gitLineStats(config, context.executionPath, [
      'diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-M', head
    ], files);
    for (const [file, stat] of Object.entries(stats)) {
      const current = totals[file] || { additions: 0, deletions: 0 };
      totals[file] = {
        additions: current.additions + stat.additions,
        deletions: current.deletions + stat.deletions
      };
    }
  }
  return totals;
}

async function gitLineStats(config, cwd, args, files) {
  const wanted = new Set(files.map(normalizePath).filter(Boolean));
  if (!wanted.size) return {};
  const result = await runProcess('git', [...args, '--', ...wanted], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
    preserveOutputWhitespace: true
  }, config).catch(() => null);
  if (!result || result.exitCode !== 0 || result.stdoutTruncated) return {};
  const stats = {};
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [addedRaw = '', deletedRaw = '', ...pathParts] = line.split('\t');
    if (!/^\d+$/.test(addedRaw) || !/^\d+$/.test(deletedRaw)) continue;
    const file = matchNumstatPath(pathParts.join('\t'), wanted);
    if (!file) continue;
    const current = stats[file] || { additions: 0, deletions: 0 };
    stats[file] = {
      additions: current.additions + Number(addedRaw),
      deletions: current.deletions + Number(deletedRaw)
    };
  }
  return stats;
}

function matchNumstatPath(value, wanted) {
  const direct = normalizePath(value);
  if (wanted.has(direct)) return direct;
  let renamed = String(value || '');
  renamed = renamed.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2');
  if (renamed.includes(' => ')) renamed = renamed.slice(renamed.lastIndexOf(' => ') + 4);
  const normalized = normalizePath(renamed);
  return wanted.has(normalized) ? normalized : '';
}

function changeStatus(entry = {}) {
  if (entry.historyStatus) return statusFromCode(entry.historyStatus);
  const indexStatus = String(entry.indexStatus || ' ');
  const worktreeStatus = String(entry.worktreeStatus || ' ');
  const pair = `${indexStatus}${worktreeStatus}`;
  if (entry.untracked === true || pair === '??') return { code: 'U', label: 'Untracked', tone: 'info', indexStatus, worktreeStatus };
  if (new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(pair) || indexStatus === 'U' || worktreeStatus === 'U') {
    return { code: '!', label: 'Conflict', tone: 'danger', indexStatus, worktreeStatus };
  }
  for (const code of ['R', 'C', 'A', 'D', 'M', 'T']) {
    if (indexStatus === code || worktreeStatus === code) return { ...statusFromCode(code), indexStatus, worktreeStatus };
  }
  return { code: 'M', label: 'Modified', tone: 'warning', indexStatus, worktreeStatus };
}

function statusFromCode(codeValue) {
  const code = String(codeValue || 'M').charAt(0).toUpperCase();
  const states = {
    R: { code: 'R', label: 'Renamed', tone: 'info' },
    C: { code: 'C', label: 'Copied', tone: 'info' },
    A: { code: 'A', label: 'Added', tone: 'success' },
    D: { code: 'D', label: 'Deleted', tone: 'danger' },
    M: { code: 'M', label: 'Modified', tone: 'warning' },
    T: { code: 'T', label: 'Type changed', tone: 'warning' }
  };
  return states[code] || { code: 'M', label: 'Modified', tone: 'warning' };
}

function normalizeTaskPath(context, requestedPath) {
  const safe = resolveSafePath(context.executionPath, requestedPath, { operation: 'read', label: 'Changes viewer path' });
  if (isSecretPath(safe.relativePath)) throw new Error(`Changes viewer refuses sensitive paths: ${safe.relativePath}`);
  return normalizePath(safe.relativePath);
}

async function readOptionalTextFile(root, requestedPath) {
  const safe = resolveSafePath(root, requestedPath, { operation: 'read', label: 'Changes viewer path' });
  let stat;
  try {
    stat = await fs.promises.stat(safe.absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { path: safe.relativePath, content: '', sha256: '', bytes: 0, exists: false };
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Changes viewer path is not a file: ${safe.relativePath}`);
  if (stat.size > MAX_DIFF_FILE_BYTES) throw new Error(`Changed file exceeds ${MAX_DIFF_FILE_BYTES} bytes: ${safe.relativePath}`);
  const data = await fs.promises.readFile(safe.absolutePath);
  if (looksBinary(data)) throw new Error(`Changes viewer refuses binary-looking files: ${safe.relativePath}`);
  return {
    path: safe.relativePath,
    content: data.toString('utf8'),
    sha256: sha256(data),
    bytes: data.length,
    exists: true
  };
}

async function readBaseFile(config, context, relativePath) {
  const head = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: context.executionPath,
    timeout: GIT_TIMEOUT_MS,
    maxOutputBytes: 4096
  }, config).catch(() => null);
  const baseCommit = head?.exitCode === 0 && !head.stdoutTruncated ? normalizeCommit(head.stdout) : '';
  if (!baseCommit) return { available: false, exists: false, content: '' };
  const result = await readGitTextFile(config, context, baseCommit, relativePath);
  return { available: true, exists: result.exists, content: result.content };
}

async function readGitTextFile(config, context, revision, requestedPath) {
  const safe = resolveSafePath(context.executionPath, requestedPath, { operation: 'read', label: 'Changes viewer path' });
  const result = await runProcess('git', ['show', '--no-textconv', `${revision}:${safe.relativePath}`], {
    cwd: context.executionPath,
    timeout: GIT_TIMEOUT_MS,
    maxOutputBytes: MAX_DIFF_FILE_BYTES,
    preserveOutputWhitespace: true
  }, config).catch(() => null);
  if (!result || result.stdoutTruncated) throw new Error(`Historical diff is too large to display: ${safe.relativePath}`);
  if (result.exitCode !== 0) return { path: safe.relativePath, content: '', sha256: '', bytes: 0, exists: false };
  const content = String(result.stdout || '');
  const data = Buffer.from(content, 'utf8');
  if (looksBinary(data)) throw new Error(`Changes viewer refuses binary-looking files: ${safe.relativePath}`);
  return {
    path: safe.relativePath,
    content,
    sha256: sha256(data),
    bytes: data.length,
    exists: true
  };
}

async function commitExists(config, context, head) {
  const result = await runProcess('git', ['cat-file', '-e', `${head}^{commit}`], {
    cwd: context.executionPath,
    timeout: GIT_TIMEOUT_MS,
    maxOutputBytes: 4096
  }, config).catch(() => null);
  return Boolean(result && result.exitCode === 0);
}

function viewerLanguage(filePath) {
  const name = path.basename(String(filePath || '')).toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  const extension = path.extname(name).toLowerCase();
  return ({
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript', '.json': 'json', '.css': 'css', '.scss': 'scss',
    '.html': 'html', '.md': 'markdown', '.py': 'python', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c', '.h': 'cpp',
    '.sh': 'shell', '.ps1': 'powershell', '.sql': 'sql', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml'
  })[extension] || 'plaintext';
}

function normalizeCommit(value) {
  const text = String(value || '').trim();
  return /^[a-f0-9]{40,64}$/i.test(text) ? text : '';
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function unique(values) {
  return [...new Set(values)];
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function resolveTaskCodeWorkspacePath(config, taskIdValue) {
  return resolveTaskCodeContext(config, taskIdValue).executionPath;
}

export {
  describeTaskCodeWorkspace,
  readTaskCodeDiff,
  resolveTaskCodeWorkspacePath
};
