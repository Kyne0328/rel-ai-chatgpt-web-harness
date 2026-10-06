import * as fs from 'node:fs';
import * as path from 'node:path';
import { runProcess, type RunProcessResult } from '../process.ts';
import { createFairResourceScheduler, acquireHostResource, hostResourceStats } from '../hostResourceScheduler.js';
import { gitStatusArgs, INTERNAL_STATUS_MAX_BYTES } from './gitStatus.ts';
import { runWithoutMutationProcessOwnership } from '../mutationProcessOwnership.js';

interface ObservationOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  paths?: readonly string[];
  branch?: boolean | undefined;
  version?: 1 | 2 | undefined;
  coalesce?: boolean;
  maxOutputBytes?: number;
  optional?: boolean;
}

const repositories = new Map<string, ReturnType<typeof createFairResourceScheduler>>();
const observations = new Map<string, Promise<RunProcessResult>>();
const suspendedRepositories = new Set<string>();

// Scopes are literal files, never directories or Git pathspec expressions.
export function literalObservationPaths(cwd: string, paths: readonly string[]): string[] {
  if (!paths.length || paths.length > 200) throw new Error('Exact Git observation requires 1–200 file paths.');
  const root = path.resolve(cwd);
  return [...new Set(paths.map(file => {
    const normalized = String(file).replaceAll('\\', '/');
    if (!normalized || normalized.includes('\0') || normalized.endsWith('/') || path.isAbsolute(normalized)
      || normalized.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) {
      throw new Error('Exact Git observation requires repository-relative file paths.');
    }
    const absolute = path.resolve(root, normalized);
    try {
      if (fs.lstatSync(absolute).isDirectory()) throw new Error('Exact Git observation refuses directory paths.');
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }
    return normalized;
  }))];
}

export async function readGitObservation(
  cwd: string,
  config: Parameters<typeof runProcess>[3] = {},
  options: ObservationOptions = {}
): Promise<RunProcessResult> {
  let root = path.resolve(cwd);
  try { root = fs.realpathSync.native(root); } catch {}
  if (suspendedRepositories.has(root)) {
    return failedObservation('A previous Git probe has unconfirmed termination; further bookkeeping probes are suspended.');
  }
  const files = options.paths ? literalObservationPaths(root, options.paths) : undefined;
  const args = gitStatusArgs({ ...(options.branch !== undefined ? { branch: options.branch } : {}), ...(options.version ? { version: options.version } : {}),
    ...(files ? { untracked: 'all', paths: files } : {}) });
  const timeoutMs = Math.max(1, Math.min(5000, options.timeoutMs ?? 1500));
  const maxOutputBytes = Math.min(INTERNAL_STATUS_MAX_BYTES, options.maxOutputBytes ?? (files ? INTERNAL_STATUS_MAX_BYTES : 512 * 1024));
  const key = JSON.stringify([root, args, timeoutMs, maxOutputBytes, options.optional]);
  // Caller-controlled signals and post-mutation reads are never shared.
  const share = options.coalesce === true && !options.signal;
  const existing = share ? observations.get(key) : null;
  if (existing) return existing;
  const pending = observe();
  if (share) observations.set(key, pending);
  try { return await pending; }
  finally { if (observations.get(key) === pending) observations.delete(key); }

  async function observe(): Promise<RunProcessResult> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let local = repositories.get(root);
    if (options.optional && local?.stats().probe.active) return failedObservation('Git bookkeeping is busy.');
    if (!local) { local = createFairResourceScheduler({ probe: 1 }); repositories.set(root, local); }
    let localLease: Awaited<ReturnType<typeof local.acquire>> | null = null;
    let globalLease: Awaited<ReturnType<typeof acquireHostResource>> | null = null;
    let retainCapacity = false;
    try {
      localLease = await local.acquire('probe', root, { signal, timeoutMs });
      if (options.optional && hostResourceStats().gitObservation.active >= hostResourceStats().gitObservation.limit) {
        return failedObservation('Git bookkeeping capacity is occupied.');
      }
      globalLease = await acquireHostResource('gitObservation', root, { signal, timeoutMs });
      const result = await runWithoutMutationProcessOwnership(() => runProcess('git', args, {
        cwd: root, signal, timeout: timeoutMs, maxOutputBytes, preserveOutputWhitespace: true
      }, config));
      if (result.executed && (result.timedOut || result.cancelled) && result.terminationConfirmed === false) {
        // Do not create more potentially runaway children while their predecessor
        // remains unconfirmed. Ordinary execution can still proceed without accounting.
        retainCapacity = true;
        suspendedRepositories.add(root);
      }
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      return failedObservation(String((error as Error).message || error), deadline.aborted
        || (error as { code?: string }).code === 'HOST_RESOURCE_QUEUE_TIMEOUT');
    } finally {
      if (!retainCapacity) { globalLease?.release(); localLease?.release(); }
      const state = local.stats().probe;
      if (state.active === 0 && state.queued === 0) { local.dispose(); repositories.delete(root); }
    }
  }
}

export async function readExactGitObservations(
  cwd: string,
  config: Parameters<typeof runProcess>[3],
  paths: readonly string[],
  options: Omit<ObservationOptions, 'paths' | 'coalesce'> = {}
): Promise<RunProcessResult> {
  const chunks: string[] = [];
  let bytes = 0;
  let result: RunProcessResult | null = null;
  for (let offset = 0; offset < paths.length; offset += 100) {
    result = await readGitObservation(cwd, config, { ...options, paths: paths.slice(offset, offset + 100) });
    if (result.exitCode !== 0 || result.stdoutTruncated) return result;
    bytes += Buffer.byteLength(result.stdout);
    if (bytes > INTERNAL_STATUS_MAX_BYTES) return { ...result, stdoutTruncated: true, error: 'Exact Git observation exceeded its output budget.' };
    chunks.push(result.stdout);
  }
  if (!result) throw new Error('Exact Git observation requires file paths.');
  return { ...result, stdout: chunks.join(''), stdoutBytes: bytes };
}

function failedObservation(error: string, timedOut = false): RunProcessResult {
  return { executed: false, exitCode: -1, stdout: '', stderr: '', error,
    timedOut, cancelled: false, queueWaitMs: 0, durationMs: 0,
    stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
}
