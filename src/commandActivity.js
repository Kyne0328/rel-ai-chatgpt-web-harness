import { getStateDir } from './statePaths.js';
import { commandDisplayForInvocation } from './commandDisplay.ts';

// Display-only projection of existing exec operation receipts. Cancellation and
// process ownership remain with toolActivity/fallbackExecutions and runProcess.
const records = new Map();
const listeners = new Set();
const OUTPUT_BYTES = 64 * 1024;
let revision = 0;
let notification;

function changed() {
  revision += 1;
  if (notification) return;
  notification = setTimeout(() => {
    notification = null;
    for (const listener of listeners) { try { listener(); } catch {} }
  }, 100);
  notification.unref?.();
}

export function beginCommandActivity(config, { operationId, workId = '', taskTitle = '', workspace = '', args = {}, cancellable = false, startedAtMs = Date.now() }) {
  const record = { operationId, workId, taskTitle, workspace, commandSummary: commandDisplayForInvocation(args),
    startedAt: new Date(startedAtMs).toISOString(), endedAt: '', phase: 'queued', status: 'queued',
    executed: false, terminationConfirmed: null,
    canStop: cancellable, exitCode: null, error: '', stateRoot: getStateDir(config),
    stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutBytes: 0, stderrBytes: 0,
    lastOutputAt: '', lastOutputBytes: 0 };
  records.set(operationId, record);
  changed();
  return {
    phase(snapshot) {
      if (record.endedAt) return;
      record.phase = snapshot.phase;
      if (snapshot.executed === true) record.executed = true;
      if (snapshot.terminationCertainty === 'confirmed') record.terminationConfirmed = true;
      if (snapshot.terminationCertainty === 'unconfirmed') record.terminationConfirmed = false;
      record.status = snapshot.phase === 'stopping' ? 'stopping' : snapshot.executed ? 'running' : 'queued';
      changed();
    },
    output(stream, chunk) {
      if (record.endedAt || !['stdout', 'stderr'].includes(stream)) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!bytes.length) return;
      record[stream + 'Bytes'] += bytes.length;
      record.lastOutputBytes = record.stdoutBytes + record.stderrBytes;
      record.lastOutputAt = new Date().toISOString();
      record[stream] = Buffer.concat([record[stream], bytes.subarray(-OUTPUT_BYTES)]).subarray(-OUTPUT_BYTES);
      changed();
    },
    finish(result = {}, error = null) {
      record.endedAt = new Date().toISOString();
      record.canStop = false;
      record.exitCode = result.exitCode ?? null;
      const termination = result.terminationConfirmed ?? record.terminationConfirmed;
      record.terminationConfirmed = termination;
      record.status = termination === false || (record.executed && termination !== true) ? 'unknown'
        : result.cancelled ? 'cancelled' : error || result.commandSucceeded === false || result.ok === false ? 'failed' : 'completed';
      record.error = String(error?.message || result.error || '');
      const ended = [...records.values()].filter(item => ['completed', 'cancelled', 'failed'].includes(item.status)).sort((a, b) => b.endedAt.localeCompare(a.endedAt));
      for (const item of ended.slice(5)) records.delete(item.operationId);
      changed();
    }
  };
}

function requireCommand(config, operationId) {
  const record = records.get(String(operationId || ''));
  if (!record || record.stateRoot !== getStateDir(config)) throw new Error('Unknown command operation.');
  return record;
}

// Lightweight lookup for MCP status; no output buffers or disk writes on
// every chunk. Missing state after restart remains unknown.
export function commandOutputActivity(operationId, stateRoot) {
  const record = records.get(String(operationId || ''));
  if (!record || record.stateRoot !== stateRoot) return null;
  return { lastOutputAt: record.lastOutputAt, lastOutputBytes: record.lastOutputBytes };
}

export function commandActivityControl(config, operationId) {
  const record = requireCommand(config, operationId);
  if (!record.canStop || record.endedAt) throw new Error('This command operation cannot be stopped.');
  return { operationId: record.operationId, workId: record.workId, workspace: record.workspace };
}

export function commandActivities(config) {
  return [...records.values()].filter(record => record.stateRoot === getStateDir(config)).map(record => {
    const { stdout, stderr, stateRoot: _stateRoot, ...value } = record;
    return { ...value, stdoutTail: stdout.subarray(-8192).toString('utf8'), stderrTail: stderr.subarray(-8192).toString('utf8'),
      stdoutRetainedFromOffset: record.stdoutBytes - stdout.length, stderrRetainedFromOffset: record.stderrBytes - stderr.length,
      stdoutTailStartOffset: record.stdoutBytes - Math.min(stdout.length, 8192), stderrTailStartOffset: record.stderrBytes - Math.min(stderr.length, 8192) };
  });
}

export function readCommandActivityOutput(config, operationId, { stream, offset, beforeOffset, maxBytes = OUTPUT_BYTES }) {
  if (!['stdout', 'stderr'].includes(stream)) throw new Error('Invalid output stream.');
  const record = requireCommand(config, operationId);
  const totalBytes = record[stream + 'Bytes'];
  const retainedFromOffset = totalBytes - record[stream].length;
  const end = Math.max(retainedFromOffset, Math.min(totalBytes, beforeOffset ?? totalBytes));
  const start = Math.min(end, Math.max(retainedFromOffset, offset ?? end - maxBytes));
  const bytes = record[stream].subarray(start - retainedFromOffset, Math.min(end, start + maxBytes) - retainedFromOffset);
  return { ok: true, range: { offset: start, nextOffset: start + bytes.length, totalBytes, retainedFromOffset,
    text: bytes.toString('utf8'), truncatedBefore: (offset ?? start) < retainedFromOffset } };
}

export function commandActivityRevision() { return revision; }
export function onCommandActivityChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
