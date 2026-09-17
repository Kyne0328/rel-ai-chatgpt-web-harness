import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateDir } from './statePaths.js';
import { principalFingerprint } from './mcp/principal.js';

const OUTPUT_SPILL_DIR = 'output-spills';
const OUTPUT_REF_PATTERN = /^spill_[A-Za-z0-9_-]{20,80}$/;
const MAX_OUTPUT_SPILL_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_SPILL_BYTES = 256 * 1024 * 1024;
const MAX_SPILL_FILES = 100;
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
// A spill is fed from a child-process data callback. Keep the asynchronous
// write queue small enough that a slow disk cannot turn command output into an
// unbounded heap allocation. The producer can pause its stream at this limit.
const MAX_PENDING_SPILL_BYTES = 4 * 1024 * 1024;
const SPILL_LOW_WATER_BYTES = 1024 * 1024;
const spillUsageByRoot = new Map();
const activeSpillsByRoot = new Map();
const activeReservationsByRoot = new Map();

function outputSpillOwner({ taskId = '', workspace = '', principal = '' } = {}) {
  const task = String(taskId || '').trim();
  if (task) return task;
  const workspaceId = String(workspace || '').trim();
  if (!workspaceId) return '';
  return `workspace:${workspaceId}:principal:${principalFingerprint(principal || 'local:trusted')}`;
}

function createOutputSpillWriter(config = {}, ownerId = '') {
  const owner = String(ownerId || '').trim();
  const root = spillRoot(config);
  let fd = null;
  let file = '';
  let outputRef = '';
  let bytes = 0;
  let writtenBytes = 0;
  let spillTruncated = false;
  let finished = false;
  let writePromise = null;
  let writeError = null;
  const pending = [];
  const lowWaterWaiters = new Set();

  function start(initial) {
    if (!owner || fd !== null || finished) return;
    const prunedUsage = pruneOutputSpills(root);
    // `pruneOutputSpills` sees on-disk bytes, which may lag behind accepted
    // asynchronous writes. Add only the active writers' unwritten
    // reservations; stale inactive files remain governed by the on-disk scan.
    const reservations = activeReservations(root);
    const usage = {
      bytes: prunedUsage.bytes + Math.max(0, reservations.bytes - prunedUsage.activeBytes),
      files: prunedUsage.files + Math.max(0, reservations.files - prunedUsage.activeFiles)
    };
    spillUsageByRoot.set(root, usage);
    if (usage.files >= MAX_SPILL_FILES || usage.bytes >= MAX_TOTAL_SPILL_BYTES) {
      spillTruncated = true;
      return;
    }
    const directory = path.join(root, taskDirectoryName(owner));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    outputRef = `spill_${crypto.randomBytes(18).toString('base64url')}`;
    file = path.join(directory, `${outputRef}.log`);
    try {
      fd = fs.openSync(file, 'wx', 0o600);
      activeSpills(root, true).add(file);
      activeReservations(root).files += 1;
      spillUsageByRoot.set(root, { bytes: usage.bytes, files: usage.files + 1 });
      append(initial);
    } catch (error) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }
      activeSpills(root)?.delete(file);
      try { fs.rmSync(file, { force: true }); } catch {}
      outputRef = '';
      file = '';
      throw error;
    }
  }

  function append(value) {
    if (fd === null || finished) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
    if (!chunk.length) return;
    const fileRemaining = Math.max(0, MAX_OUTPUT_SPILL_BYTES - bytes);
    const usage = spillUsageByRoot.get(root) || { bytes: MAX_TOTAL_SPILL_BYTES, files: MAX_SPILL_FILES };
    const totalBytes = usage.bytes;
    const globalRemaining = Math.max(0, MAX_TOTAL_SPILL_BYTES - totalBytes);
    const queueRemaining = Math.max(0, MAX_PENDING_SPILL_BYTES - pendingBytes());
    const remaining = Math.min(fileRemaining, globalRemaining, queueRemaining);
    if (!remaining) {
      spillTruncated = true;
      return;
    }
    const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    // Reserve global capacity before queueing. This keeps concurrent writers
    // within the global cap even though actual writes complete asynchronously.
    bytes += accepted.length;
    activeReservations(root).bytes += accepted.length;
    spillUsageByRoot.set(root, { bytes: totalBytes + accepted.length, files: usage.files });
    pending.push(accepted);
    if (accepted.length < chunk.length) spillTruncated = true;
    pumpWrites();
  }

  function pumpWrites() {
    if (writePromise || fd === null || !pending.length) return;
    writePromise = (async () => {
      while (pending.length && fd !== null) {
        const chunk = pending.shift();
        if (!chunk) continue;
        try {
          await writeChunk(fd, chunk);
          writtenBytes += chunk.length;
          resolveLowWaterWaiters();
        } catch (error) {
          writeError ||= error;
          spillTruncated = true;
          pending.length = 0;
          // The failed tail is intentionally discarded; account for it as
          // settled so a producer waiting for the low watermark can resume.
          writtenBytes = bytes;
          resolveLowWaterWaiters();
          break;
        }
      }
    })().finally(() => {
      writePromise = null;
      if (pending.length && fd !== null) pumpWrites();
      resolveLowWaterWaiters();
    });
  }

  function waitForLowWatermark(limit = SPILL_LOW_WATER_BYTES) {
    if (pendingBytes() <= limit || (fd === null && !pending.length)) return Promise.resolve();
    return new Promise(resolve => {
      lowWaterWaiters.add({ limit, resolve });
    });
  }

  function resolveLowWaterWaiters() {
    for (const waiter of lowWaterWaiters) {
      if (pendingBytes() <= waiter.limit || (fd === null && !pending.length)) {
        lowWaterWaiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  function pendingBytes() {
    return Math.max(0, bytes - writtenBytes);
  }

  async function flush() {
    pumpWrites();
    while (writePromise || pending.length) {
      if (writePromise) await writePromise;
      else pumpWrites();
    }
    if (writeError) {
      // Spill failure should preserve the command result and retained tail.
      // The caller still receives spillTruncated as an explicit diagnostic.
      writeError = null;
    }
  }

  async function finish() {
    if (finished && fd === null) return outputRef ? { outputRef, bytes, spillTruncated } : null;
    finished = true;
    await flush();
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
      fd = null;
    }
    const active = activeSpills(root);
    active?.delete(file);
    if (active?.size === 0) activeSpillsByRoot.delete(root);
    const reservations = activeReservations(root);
    reservations.files = Math.max(0, reservations.files - 1);
    reservations.bytes = Math.max(0, reservations.bytes - bytes);
    if (!reservations.files) activeReservationsByRoot.delete(root);
    if (!outputRef) return null;
    return { outputRef, bytes, spillTruncated };
  }

  return {
    start,
    append,
    flush,
    finish,
    get pendingBytes() { return pendingBytes(); },
    waitForLowWatermark
  };
}

function writeChunk(fd, chunk) {
  return new Promise((resolve, reject) => {
    fs.write(fd, chunk, 0, chunk.length, null, (error, written) => {
      if (error) {
        reject(error);
        return;
      }
      if (written === chunk.length) {
        resolve();
        return;
      }
      if (!Number.isSafeInteger(written) || written <= 0) {
        reject(new Error('Output spill write made no progress.'));
        return;
      }
      writeChunk(fd, chunk.subarray(written)).then(resolve, reject);
    });
  });
}

function readOutputSpill(config = {}, ownerId = '', outputRef = '') {
  const owner = String(ownerId || '').trim();
  const ref = String(outputRef || '').trim();
  if (!owner) throw new Error('relai_read outputRef requires an authorized workspace execution scope.');
  if (!OUTPUT_REF_PATTERN.test(ref)) throw new Error('Invalid Rel.AI outputRef.');
  const file = path.join(spillRoot(config), taskDirectoryName(owner), `${ref}.log`);
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Rel.AI outputRef was not found for this authorized execution scope.', { cause: error });
    throw error;
  }
  if (!stat.isFile()) throw new Error('Rel.AI outputRef does not identify a readable spill.');
  return { outputRef: ref, file, bytes: stat.size };
}

function spillRoot(config) {
  return path.join(getStateDir(config), OUTPUT_SPILL_DIR);
}

function taskDirectoryName(taskId) {
  return crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 32);
}

function activeSpills(root, create = false) {
  let active = activeSpillsByRoot.get(root) || null;
  if (!active && create) {
    active = new Set();
    activeSpillsByRoot.set(root, active);
  }
  return active;
}

function activeReservations(root) {
  let reservations = activeReservationsByRoot.get(root);
  if (!reservations) {
    reservations = { bytes: 0, files: 0 };
    activeReservationsByRoot.set(root, reservations);
  }
  return reservations;
}

function pruneOutputSpills(root) {
  let files = [];
  const directories = [];
  try {
    if (!fs.existsSync(root)) return { bytes: 0, files: 0, activeBytes: 0, activeFiles: 0 };
    for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const base = path.join(root, directory.name);
      directories.push(base);
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
        const file = path.join(base, entry.name);
        try {
          const stat = fs.statSync(file);
          files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  } catch {
    return { bytes: MAX_TOTAL_SPILL_BYTES, files: MAX_SPILL_FILES, activeBytes: 0, activeFiles: 0 };
  }

  const cutoff = Date.now() - SPILL_TTL_MS;
  const active = activeSpills(root) || new Set();
  const retained = [];
  for (const item of files) {
    if (active.has(item.file) || item.mtimeMs >= cutoff) {
      retained.push(item);
      continue;
    }
    try { fs.rmSync(item.file, { force: true }); }
    catch { retained.push(item); }
  }
  files = retained.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((sum, item) => sum + item.size, 0);
  const targetBytes = Math.max(0, MAX_TOTAL_SPILL_BYTES - MAX_OUTPUT_SPILL_BYTES);
  const targetFiles = Math.max(0, MAX_SPILL_FILES - 1);
  while (files.length > targetFiles || total > targetBytes) {
    const removableIndex = files.findIndex(item => !active.has(item.file));
    if (removableIndex < 0) break;
    const [item] = files.splice(removableIndex, 1);
    try {
      fs.rmSync(item.file, { force: true });
      total -= item.size;
    } catch {
      files.splice(removableIndex, 0, item);
      break;
    }
  }
  for (const directory of directories) {
    try { fs.rmdirSync(directory); } catch {}
  }
  const activeItems = files.filter(item => active.has(item.file));
  return {
    bytes: Math.max(0, total),
    files: files.length,
    activeBytes: activeItems.reduce((sum, item) => sum + item.size, 0),
    activeFiles: activeItems.length
  };
}

export { createOutputSpillWriter, outputSpillOwner, readOutputSpill };
