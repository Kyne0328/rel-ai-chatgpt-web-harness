import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runReadOnlyProcess } from '../process.ts';

const MAX_INDEX_BYTES = 128 * 1024 * 1024;

function readIndex(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEX_BYTES) {
      throw new Error('Git index must be a regular file within the 128 MiB transaction limit.');
    }
    const descriptor = fs.openSync(file, 'r');
    try {
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_INDEX_BYTES) {
        throw new Error('Git index changed while opening the staging transaction.');
      }
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error('Git index became incomplete while reading.');
        offset += count;
      }
      return bytes;
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function digest(bytes: Buffer | null): string {
  return bytes === null ? 'absent' : crypto.createHash('sha256').update(bytes).digest('hex');
}

// Stage in an alternate index while holding Git's ordinary index lock. Refusal
// and failed staging never restore a snapshot over a concurrent writer.
export async function beginGitIndexTransaction(cwd: string, config: Record<string, any>, options: { signal?: AbortSignal; timeout?: number } = {}) {
  options.signal?.throwIfAborted?.();
  const location = await runReadOnlyProcess('git', ['rev-parse', '--git-path', 'index'],
    { cwd, timeout: options.timeout || 30000, ...(options.signal ? { signal: options.signal } : {}), maxOutputBytes: 16384, preserveOutputWhitespace: true }, config);
  if (!location.executed || location.exitCode !== 0 || location.timedOut || location.cancelled
    || location.stdoutTruncated || location.terminationConfirmed === false || location.outputFinalizationTimedOut) {
    throw new Error('Could not determine the complete Git index path.');
  }
  options.signal?.throwIfAborted?.();
  const indexPath = path.resolve(cwd, location.stdout.replace(/\r?\n$/, ''));
  const lockPath = indexPath + '.lock';
  const temporaryPath = indexPath + '.relai-' + crypto.randomBytes(16).toString('hex');
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  const lockIdentity = fs.fstatSync(lock);
  let closed = false;
  let promoted = false;
  const ownsLock = () => {
    try {
      const current = fs.lstatSync(lockPath);
      return current.isFile() && !current.isSymbolicLink()
        && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino;
    } catch { return false; }
  };
  const close = () => {
    if (!closed) { fs.closeSync(lock); closed = true; }
  };
  const dispose = () => {
    close();
    if (!promoted && ownsLock()) fs.rmSync(lockPath);
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    // Git owns this private index's lock. Retain it if cleanup is uncertain.
  };
  try {
    const originalTime = fs.existsSync(indexPath) ? fs.lstatSync(indexPath) : null;
    const original = readIndex(indexPath);
    const originalDigest = digest(original);
    if (original !== null) {
      fs.writeFileSync(temporaryPath, original, { flag: 'wx', mode: 0o600 });
      // A new timestamp would make unchanged cache entries appear older than
      // their index, disabling Git's racy-stat check for same-size edits. Round
      // down to seconds so precision conversion can only force extra checking.
      if (!originalTime) throw new Error('Git index timestamp changed while cloning.');
      fs.utimesSync(temporaryPath, originalTime.atimeMs / 1000, Math.floor(originalTime.mtimeMs / 1000));
    }
    const unchanged = () => ownsLock() && digest(readIndex(indexPath)) === originalDigest;
    return {
      env: { GIT_INDEX_FILE: temporaryPath },
      unchanged,
      publish() {
        if (!unchanged()) throw new Error('The visible Git index changed outside the staging transaction; it was preserved.');
        const staged = readIndex(temporaryPath);
        if (staged === null) throw new Error('The private Git index is unavailable after commit.');
        fs.ftruncateSync(lock, 0);
        fs.writeFileSync(lock, staged);
        fs.fsyncSync(lock);
        if (!unchanged()) throw new Error('The visible Git index changed before publication; it was preserved.');
        close();
        fs.renameSync(lockPath, indexPath);
        promoted = true;
      },
      dispose
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
