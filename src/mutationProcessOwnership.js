import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { getStateDir } from './statePaths.js';
import { canonicalWorkspaceAuthority, workspaceMutationBlockSummary } from './workspaceOperationQueue.js';

const ownershipContext = new AsyncLocalStorage();
const activeMutationRecords = new Set();
const recoveryListeners = new Set();
const RECORD_SCHEMA_VERSION = 3;
const MAX_RECOVERY_RECORDS = 1000;
const runtimeId = `runtime_${process.pid}_${crypto.randomBytes(12).toString('hex')}`;

function runWithMutationProcessOwnership(config, workspace, callback, workspacePath = '') {
  const alias = String(workspace || '').trim();
  if (!alias) return callback();
  const authority = resolveMutationAuthority(config, alias, workspacePath);
  const context = { config, workspace: alias, authority, records: new Set() };
  const settle = () => {
    let changed = false;
    for (const file of context.records) changed = activeMutationRecords.delete(file) || changed;
    context.records.clear();
    if (changed) notifyRecoveryChange();
  };
  return ownershipContext.run(context, () => {
    try {
      const value = callback();
      if (value && typeof value.then === 'function') return Promise.resolve(value).finally(settle);
      settle();
      return value;
    } catch (error) {
      settle();
      throw error;
    }
  });
}

// Internal observations must not inherit the mutating command's ownership.
// This is deliberately a scoped callback, not a public process/tool option.
function runWithoutMutationProcessOwnership(callback) {
  return ownershipContext.run(undefined, callback);
}

function prepareCurrentMutationProcess() {
  const current = ownershipContext.getStore();
  if (!current) return null;
  const file = path.join(mutationWorkspaceRoot(current.config, current.workspace, current.authority),
    `${runtimeId}-intent-${crypto.randomBytes(12).toString('hex')}.json`);
  // Persistence is a spawn admission barrier. A crash between this write and
  // PID attachment stays unknown rather than looking like confirmed completion.
  writeJsonAtomic(file, {
    schemaVersion: RECORD_SCHEMA_VERSION, runtimeId, workspace: current.workspace,
    authority: current.authority, authorityStatus: current.authority ? 'bound' : 'unbound',
    pid: 0, phase: 'preparing', terminationUncertain: true,
    startedAt: new Date().toISOString()
  }, { mode: 0o600 });
  activeMutationRecords.add(file);
  current.records.add(file);
  return file;
}

function recordCurrentMutationProcess(pidValue, preparedFile = null) {
  const current = ownershipContext.getStore();
  const pid = Number(pidValue);
  if (!current || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const file = preparedFile || mutationProcessRecordFile(current.config, current.workspace, runtimeId, pid, current.authority);
  writeJsonAtomic(file, {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runtimeId,
    workspace: current.workspace,
    authority: current.authority,
    authorityStatus: current.authority ? 'bound' : 'unbound',
    pid,
    phase: 'active',
    terminationUncertain: true,
    startedAt: new Date().toISOString()
  }, { mode: 0o600 });
  activeMutationRecords.add(file);
  current.records.add(file);
  return file;
}

function markCurrentMutationProcessUncertain(pidValue, reason = '', preparedFile = null) {
  const current = ownershipContext.getStore();
  const pid = Number(pidValue);
  if (!current || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const file = preparedFile || mutationProcessRecordFile(current.config, current.workspace, runtimeId, pid, current.authority);
  activeMutationRecords.delete(file);
  try {
    const record = readJsonFile(file, {
      validate: value => Boolean(value && typeof value === 'object'
        && value.schemaVersion === RECORD_SCHEMA_VERSION && value.runtimeId === runtimeId
        && value.workspace === current.workspace && value.authority === current.authority
        && (value.pid === pid || value.pid === 0))
    });
    if (!record) throw new Error('The original mutation ownership record is unavailable.');
    writeJsonAtomic(file, {
      ...record,
      pid,
      phase: 'uncertain',
      terminationUncertain: true,
      terminationUncertaintyReason: String(reason || 'Process-tree termination was not confirmed.').slice(0, 1000)
    }, { mode: 0o600 });
    return true;
  } catch (cause) {
    // Keep the original marker. A failed persistence attempt must never be
    // interpreted as confirmed termination or permission to clear ownership.
    const error = new Error('Could not persist uncertain process termination; restart recovery cannot verify this uncertainty. Keep the workspace blocked and verify all descendants stopped before recovery.', { cause });
    error.code = 'MUTATION_TERMINATION_UNCERTAINTY_PERSIST_FAILED';
    error.terminationConfirmed = false;
    error.pid = pid;
    throw error;
  } finally {
    notifyRecoveryChange();
  }
}

function clearCurrentMutationProcess(pidValue, preparedFile = null) {
  const current = ownershipContext.getStore();
  const pid = Number(pidValue);
  if (!current || (!preparedFile && (!Number.isSafeInteger(pid) || pid <= 0))) return false;
  const file = preparedFile || mutationProcessRecordFile(current.config, current.workspace, runtimeId, pid, current.authority);
  const wasActive = activeMutationRecords.delete(file);
  current.records.delete(file);
  try {
    fs.rmSync(file, { force: true });
    if (!wasActive) notifyRecoveryChange();
    return true;
  } catch {
    notifyRecoveryChange();
    return false;
  }
}

function listMutationProcessRecords(config, workspace, workspacePath = '') {
  const alias = String(workspace || '').trim();
  if (!alias) return [];
  const authority = resolveMutationAuthority(config, alias, workspacePath);
  if (!authority) {
    // Compatibility for internal callers without a resolved workspace path.
    // These records are explicitly unbound and never treated as physical proof.
    return readRecordDirectory(mutationWorkspaceRoot(config, alias), { alias, authority: '', legacy: true });
  }
  const physicalAuthority = physicalMutationAuthority(config, alias, workspacePath);
  const current = [...new Set([authority, physicalAuthority])].flatMap(key =>
    readRecordDirectory(mutationWorkspaceRoot(config, alias, key), { alias, authority: key, legacy: false }));
  // Only legacy/unbound layout is inventoried. Canonical workspaces are direct
  // hash lookups and never require scanning other physical workspace records.
  return [...current, ...readUnboundRecords(config, alias)];
}

function resolveMutationAuthority(config, alias, workspacePath = '') {
  const root = workspacePath || config?.workspaces?.[alias]?.path;
  return root ? canonicalWorkspaceAuthority(root) : '';
}

function physicalMutationAuthority(config, alias, workspacePath = '') {
  const root = workspacePath || config?.workspaces?.[alias]?.path;
  if (!root) return '';
  const physical = fs.realpathSync.native(path.resolve(root));
  return 'path:' + (process.platform === 'win32' ? physical.toLowerCase() : physical);
}

function directoryEntries(root, alias) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > MAX_RECOVERY_RECORDS) return { entries: [], invalid: [{ incomplete: true, file: root, workspace: alias }] };
    return { entries, invalid: [] };
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], invalid: [] };
    return { entries: [], invalid: [{ invalid: true, file: root, workspace: alias }] };
  }
}

function readRecordDirectory(root, { alias, authority, legacy }) {
  const { entries, invalid } = directoryEntries(root, alias);
  const records = [...invalid];
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const file = path.join(root, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      records.push({ invalid: true, file, workspace: alias });
      continue;
    }
    const value = readJsonFile(file, {
      validate: candidate => Boolean(candidate && typeof candidate === 'object'
        && (legacy ? [1, 2, RECORD_SCHEMA_VERSION].includes(candidate.schemaVersion) : candidate.schemaVersion === RECORD_SCHEMA_VERSION)
        && (legacy ? Boolean(String(candidate.workspace || '').trim()) && !candidate.authority : candidate.authority === authority)
        && Number.isSafeInteger(Number(candidate.pid))
        && (Number(candidate.pid) > 0 || ([2, RECORD_SCHEMA_VERSION].includes(candidate.schemaVersion) && candidate.phase === 'preparing' && candidate.pid === 0)))
    });
    records.push(value ? { ...value, file } : { invalid: true, file, workspace: alias });
  }
  return records;
}

function readUnboundRecords(config, requestedAlias) {
  const root = path.join(getStateDir(config), 'active-mutations');
  const { entries, invalid } = directoryEntries(root, requestedAlias);
  const records = [...invalid];
  for (const entry of entries) {
    const directory = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(entry.name)) {
      records.push({ invalid: true, file: directory, workspace: requestedAlias });
      continue;
    }
    records.push(...readRecordDirectory(directory, { alias: requestedAlias, authority: '', legacy: true }));
    if (records.length > MAX_RECOVERY_RECORDS) {
      return [{ incomplete: true, legacyAuthorityUnknown: true, file: root, workspace: requestedAlias }];
    }
  }
  // Current configuration cannot prove where an old alias used to point.
  // Preserve these facts as unbound uncertainty; do not migrate or remove them.
  return records.map(record => ({ ...record, legacyAuthorityUnknown: true }));
}

function removeMutationProcessRecord(record) {
  const file = String(record?.file || '');
  if (!file) return false;
  try {
    fs.rmSync(file, { force: true });
    activeMutationRecords.delete(file);
    notifyRecoveryChange();
    return true;
  } catch { return false; }
}

function mutationWorkspaceRoot(config, workspace, authority = '') {
  const key = crypto.createHash('sha256').update(authority || String(workspace)).digest('hex');
  return path.join(getStateDir(config), authority ? 'active-mutations-v3' : 'active-mutations', key);
}

function mutationProcessRecordFile(config, workspace, ownerRuntimeId, pid, authority = '') {
  return path.join(mutationWorkspaceRoot(config, workspace, authority), `${ownerRuntimeId}-${pid}.json`);
}


function mutationProcessRecoverySummary(config, workspace, workspacePath = '') {
  let records;
  try {
    records = listMutationProcessRecords(config, workspace, workspacePath);
  } catch {
    return recoverySummary('WORKSPACE_MUTATION_RECOVERY_UNAVAILABLE', null,
      'Process recovery state cannot be verified. Project changes require review before they can resume.');
  }
  const pending = records.filter(record => !(record.runtimeId === runtimeId
    && ['preparing', 'active'].includes(record.phase) && activeMutationRecords.has(record.file)));
  if (!pending.length) return null;
  const times = pending.map(record => Date.parse(String(record.startedAt || ''))).filter(Number.isFinite);
  const blockedAt = times.length ? new Date(Math.min(...times)).toISOString() : null;
  if (pending.some(record => record.incomplete)) {
    return recoverySummary('WORKSPACE_MUTATION_RECOVERY_INCOMPLETE', blockedAt,
      'Process recovery inventory is incomplete. Project changes are blocked until the outstanding state is reviewed.');
  }
  if (pending.some(record => record.invalid)) {
    return recoverySummary('WORKSPACE_MUTATION_RECOVERY_STATE_INVALID', blockedAt,
      'Process recovery state is invalid or unreadable. Project changes are blocked until that state is reviewed.');
  }
  if (pending.some(record => record.legacyAuthorityUnknown || record.authorityStatus === 'unbound')) {
    return recoverySummary('WORKSPACE_MUTATION_LEGACY_AUTHORITY_UNCERTAIN', blockedAt,
      'Existing recovery records do not identify a verified project folder. Project changes are blocked until that state is reviewed.');
  }
  return recoverySummary('WORKSPACE_MUTATION_TERMINATION_UNCERTAIN', blockedAt,
    'A previous mutating process may still be running. Project changes are blocked until its termination is confirmed and safe recovery is completed.');
}

function workspaceMutationSafetySummary(config, workspace, workspacePath = '') {
  try {
    return workspaceMutationBlockSummary(workspace, workspacePath)
      || mutationProcessRecoverySummary(config, workspace, workspacePath);
  } catch {
    return recoverySummary('WORKSPACE_MUTATION_RECOVERY_UNAVAILABLE', null,
      'Process recovery state cannot be verified. Project changes require review before they can resume.');
  }
}

function recoverySummary(code, blockedAt, message) {
  return { blocked: true, code, blockedAt, terminationCertainty: 'unknown',
    recoveryRequired: true, source: 'persistent_recovery', message };
}

function onMutationProcessRecoveryChange(listener) {
  if (typeof listener !== 'function') return () => {};
  recoveryListeners.add(listener);
  return () => recoveryListeners.delete(listener);
}

function notifyRecoveryChange() {
  for (const listener of recoveryListeners) {
    try { listener(); } catch { /* A projection cannot alter process cleanup. */ }
  }
}

export {
  workspaceMutationSafetySummary,
  onMutationProcessRecoveryChange,
  clearCurrentMutationProcess,
  listMutationProcessRecords,
  markCurrentMutationProcessUncertain,
  prepareCurrentMutationProcess,
  recordCurrentMutationProcess,
  removeMutationProcessRecord,
  runWithoutMutationProcessOwnership,
  runWithMutationProcessOwnership
};
