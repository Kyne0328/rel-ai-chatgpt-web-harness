import { executionOutcome } from '../executionOutcome.js';

function policySentence(policy) {
  if (!policy || typeof policy !== 'object' || policy.sessionActive !== true) return null;
  const parts = [policy.taskHint ? `Session active: ${policy.taskHint}` : 'Session active'];
  if (Array.isArray(policy.baselineDirty) && policy.baselineDirty.length) {
    parts.push(`${policy.baselineDirty.length} pre-existing dirty file(s) are not attributed to this session`);
  }
  return `${parts.join('. ')}.`;
}

function pruneEmpty(obj, preserveEmptyArrays = null) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([key, value]) => {
    if (value === undefined) return false;
    // These nullable execution facts distinguish an unknown/unavailable result
    // from a field the producer did not supply. Their public schemas allow null.
    if (value === null) return key === 'exitCode' || key === 'terminationConfirmed';
    return !Array.isArray(value) || value.length > 0 || preserveEmptyArrays?.has(key) === true;
  }));
}

function compactRepositoryState(value, { includeWorkspace = true } = {}) {
  if (!value || typeof value !== 'object') return value;
  return pruneEmpty({
    ok: value.ok,
    workspace: includeWorkspace ? value.workspace : undefined,
    branch: value.branch,
    aheadBehind: value.aheadBehind,
    unborn: value.unborn,
    status: value.status,
    changedFiles: value.changedFiles,
    untrackedFiles: value.untrackedFiles,
    sessionChangedFiles: value.sessionChangedFiles,
    baselineChangedFiles: value.baselineChangedFiles,
    untrackedSessionFiles: value.untrackedSessionFiles,
    untrackedBaselineFiles: value.untrackedBaselineFiles,
    baselineSource: value.baselineSource,
    stderr: value.stderr
  });
}

function compactCommandResult(result, options = {}) {
  if (!result || typeof result !== 'object') return result;
  const failed = result.commandSucceeded === false || result.ok === false || Number(result.exitCode || 0) !== 0;
  return pruneEmpty({
    command: result.command,
    ok: result.ok,
    ...executionOutcome(result),
    timeline: result.timeline,
    stdout: failed || options.fullOutput === true ? result.stdout : undefined,
    stderr: failed || options.fullOutput === true ? result.stderr : undefined
  });
}

function compactProcessMetadata(value) {
  if (!value || typeof value !== 'object') return value;
  return pruneEmpty({
    ok: value.ok,
    processId: value.processId,
    pid: value.pid,
    workspace: value.workspace,
    label: value.label,
    kind: value.kind,
    purpose: value.purpose,
    lifecycle: value.lifecycle,
    workSessionId: value.workSessionId,
    terminationConfirmed: value.terminationConfirmed,
    rootExitConfirmed: value.rootExitConfirmed,
    terminationError: value.terminationError,
    pty: value.pty === true ? true : undefined,
    columns: value.pty ? value.columns : undefined,
    rows: value.pty ? value.rows : undefined,
    status: value.status,
    metadataRevision: value.metadataRevision,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    exitCode: value.exitCode,
    stdoutBytes: value.stdoutBytes || undefined,
    stderrBytes: value.stderrBytes || undefined,
    error: value.error
  });
}

function boundedStringArray(values, maxBytes) {
  if (!Array.isArray(values)) return { values: undefined, count: undefined, omitted: 0 };
  const kept = [];
  let bytes = 2;
  for (const value of values) {
    const serialized = JSON.stringify(value);
    const next = Buffer.byteLength(serialized, 'utf8') + (kept.length ? 1 : 0);
    if (bytes + next > maxBytes) break;
    kept.push(value);
    bytes += next;
  }
  return { values: kept, count: kept.length, omitted: Math.max(0, values.length - kept.length) };
}

export {
  boundedStringArray,
  compactCommandResult,
  compactProcessMetadata,
  compactRepositoryState,
  policySentence,
  pruneEmpty
};
