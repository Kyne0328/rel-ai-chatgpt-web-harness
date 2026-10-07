import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getStateDir } from './statePaths.js';
import { fileSha256, resolveSafePath } from './safety.js';
import { readWorkspaceIntegrity, releaseTaskChangedFiles } from './taskIntegrity.ts';
import { workspaceGitStatus } from './repo/gitOps.ts';

const EPHEMERAL_ROOT_NAME = 'rel-ai-mcp-ephemeral';
const EPHEMERAL_ENV_KEY = 'REL_AI_EPHEMERAL_DIR';
const EPHEMERAL_TTL_MS = 24 * 60 * 60 * 1000;
const METADATA_FILE = '.relai-ephemeral.json';

type EphemeralConfig = Record<string, any>;
type EphemeralWorkspace = { alias: string; path: string };
type EphemeralWorkspaceRecord = {
  path: string;
  sha256: string;
  sizeBytes?: number;
  markedAt?: string;
};

function taskEphemeralDirectory(config: EphemeralConfig, taskId: unknown, workspacePath = ''): string {
  const task = String(taskId || '').trim();
  if (!task) throw new Error('Task ephemeral storage requires a work_id.');
  const namespace = crypto.createHash('sha256')
    .update(path.resolve(getStateDir(config)))
    .digest('hex')
    .slice(0, 16);
  const taskKey = crypto.createHash('sha256')
    .update(task)
    .digest('hex')
    .slice(0, 32);
  const root = path.resolve(os.tmpdir(), EPHEMERAL_ROOT_NAME, namespace, taskKey);
  if (workspacePath && isPathInside(path.resolve(workspacePath), root)) {
    throw new Error('Rel.AI could not place task scratch storage outside the configured project.');
  }
  return root;
}

function ensureTaskEphemeralDirectory(
  config: EphemeralConfig,
  taskId: unknown,
  workspace: EphemeralWorkspace | null = null
): string {
  const directory = taskEphemeralDirectory(config, taskId, workspace?.path || '');
  const namespaceRoot = path.dirname(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  pruneStaleEphemeralDirectories(namespaceRoot, directory);
  writeMetadata(directory, {
    version: 2,
    cleanupEligible: false,
    taskId: String(taskId || '').trim(),
    workspace: String(workspace?.alias || ''),
    createdAt: readMetadata(directory)?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return directory;
}

function withTaskEphemeralEnvironment(
  config: EphemeralConfig,
  taskId: unknown,
  workspace: EphemeralWorkspace | null,
  env: Record<string, string> = {}
): Record<string, string> {
  const task = String(taskId || '').trim();
  if (!task) return env;
  const directory = ensureTaskEphemeralDirectory(config, task, workspace);
  return { ...env, [EPHEMERAL_ENV_KEY]: directory };
}

function cleanupTaskEphemeralDirectory(
  config: EphemeralConfig,
  taskId: unknown,
  workspacePath = ''
): { removed: boolean; removedFiles: number; removedBytes: number; error?: string } {
  const directory = taskEphemeralDirectory(config, taskId, workspacePath);
  const usage = directoryUsage(directory);
  try {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 8 : 2,
      retryDelay: 75
    });
    removeEmptyParents(directory);
    return { removed: true, removedFiles: usage.files, removedBytes: usage.bytes };
  } catch (error) {
    // Explicit task cleanup has established that scratch is no longer needed.
    // Only this durable fact makes a later age-based retry safe.
    try { writeMetadata(directory, { ...readMetadata(directory), cleanupEligible: true }); } catch {}
    return {
      removed: false,
      removedFiles: 0,
      removedBytes: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function cleanupTaskWorkspaceEphemeralFiles(
  workspace: EphemeralWorkspace,
  config: EphemeralConfig,
  taskId: unknown,
  records: unknown,
  options: { signal?: AbortSignal } = {}
): Promise<{ removedPaths: string[]; skippedPaths: string[] }> {
  const task = String(taskId || '').trim();
  const candidates = normalizeWorkspaceRecords(records);
  if (!task || !candidates.length) return { removedPaths: [], skippedPaths: [] };

  const status = await workspaceGitStatus(workspace, config, { work_id: task, signal: options.signal });
  const untracked = new Set((status.statusEntries || [])
    .filter((entry: any) => entry?.untracked === true)
    .map((entry: any) => normalizePath(entry.path))
    .filter(Boolean));
  const ownership = readWorkspaceIntegrity(config, workspace.alias);
  const removedPaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const record of candidates) {
    options.signal?.throwIfAborted?.();
    const relativePath = normalizePath(record.path);
    const owners = Array.isArray(ownership?.uncommittedOwners?.[relativePath])
      ? ownership.uncommittedOwners[relativePath]
      : [];
    if (!untracked.has(relativePath) || !owners.includes(task) || owners.some((owner: string) => owner !== task)) {
      skippedPaths.push(relativePath);
      continue;
    }
    let safe;
    try {
      safe = resolveSafePath(workspace.path, relativePath, { operation: 'delete' });
      const stat = fs.statSync(safe.absolutePath);
      if (!stat.isFile() || fileSha256(workspace.path, safe.relativePath) !== record.sha256) {
        skippedPaths.push(relativePath);
        continue;
      }
      fs.rmSync(safe.absolutePath, { force: true });
      removedPaths.push(safe.relativePath);
    } catch {
      skippedPaths.push(relativePath);
    }
  }

  if (removedPaths.length) releaseTaskChangedFiles(config, task, workspace.alias, removedPaths);
  return { removedPaths, skippedPaths: [...new Set(skippedPaths)] };
}

function pruneStaleEphemeralDirectories(namespaceRoot: string, currentDirectory: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(namespaceRoot, { withFileTypes: true }); }
  catch { return; }
  const cutoff = Date.now() - EPHEMERAL_TTL_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(namespaceRoot, entry.name);
    if (path.resolve(directory) === path.resolve(currentDirectory)) continue;
    let timestamp = 0;
    try {
      const metadata = readMetadata(directory);
      // Age is not evidence that a long-running child stopped using scratch.
      // Legacy and active directories remain retained until explicit cleanup.
      if (metadata?.cleanupEligible !== true) continue;
      timestamp = Date.parse(String(metadata?.updatedAt || ''));
      if (!Number.isFinite(timestamp)) timestamp = fs.statSync(directory).mtimeMs;
    } catch {
      continue;
    }
    if (timestamp >= cutoff) continue;
    try {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 4 : 1,
        retryDelay: 50
      });
    } catch {}
  }
}

function normalizeWorkspaceRecords(value: unknown): EphemeralWorkspaceRecord[] {
  if (!Array.isArray(value)) return [];
  const output: EphemeralWorkspaceRecord[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const relativePath = normalizePath(record.path);
    const sha256 = String(record.sha256 || '').trim().toLowerCase();
    if (!relativePath || !/^[a-f0-9]{64}$/.test(sha256) || seen.has(relativePath)) continue;
    seen.add(relativePath);
    output.push({
      path: relativePath,
      sha256,
      ...(Number.isSafeInteger(record.sizeBytes) ? { sizeBytes: Number(record.sizeBytes) } : {}),
      ...(record.markedAt ? { markedAt: String(record.markedAt) } : {})
    });
  }
  return output;
}

function readMetadata(directory: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(directory, METADATA_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function writeMetadata(directory: string, value: Record<string, unknown>): void {
  const target = path.join(directory, METADATA_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function directoryUsage(directory: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) {
        files += 1;
        try { bytes += fs.statSync(target).size; } catch {}
      }
    }
  }
  return { files, bytes };
}

function removeEmptyParents(directory: string): void {
  const namespaceRoot = path.dirname(directory);
  const root = path.dirname(namespaceRoot);
  for (const target of [namespaceRoot, root]) {
    try { fs.rmdirSync(target); } catch {}
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizePath(value: unknown): string {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export {
  cleanupTaskEphemeralDirectory,
  cleanupTaskWorkspaceEphemeralFiles,
  taskEphemeralDirectory,
  withTaskEphemeralEnvironment
};
