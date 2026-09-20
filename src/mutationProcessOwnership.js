import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { getStateDir } from './statePaths.js';

const ownershipContext = new AsyncLocalStorage();
const RECORD_SCHEMA_VERSION = 1;
const runtimeId = `runtime_${process.pid}_${crypto.randomBytes(12).toString('hex')}`;

function runWithMutationProcessOwnership(config, workspace, callback) {
  const alias = String(workspace || '').trim();
  if (!alias) return callback();
  return ownershipContext.run({ config, workspace: alias }, callback);
}

function recordCurrentMutationProcess(pidValue) {
  const current = ownershipContext.getStore();
  const pid = Number(pidValue);
  if (!current || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const file = mutationProcessRecordFile(current.config, current.workspace, runtimeId, pid);
  writeJsonAtomic(file, {
    schemaVersion: RECORD_SCHEMA_VERSION,
    runtimeId,
    workspace: current.workspace,
    pid,
    startedAt: new Date().toISOString()
  }, { mode: 0o600 });
  return file;
}

function clearCurrentMutationProcess(pidValue) {
  const current = ownershipContext.getStore();
  const pid = Number(pidValue);
  if (!current || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const file = mutationProcessRecordFile(current.config, current.workspace, runtimeId, pid);
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

function listMutationProcessRecords(config, workspace) {
  const alias = String(workspace || '').trim();
  if (!alias) return [];
  const root = mutationWorkspaceRoot(config, alias);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.json'))
    .map(entry => {
      const file = path.join(root, entry.name);
      const value = readJsonFile(file, {
        validate: candidate => Boolean(
          candidate && typeof candidate === 'object'
          && candidate.schemaVersion === RECORD_SCHEMA_VERSION
          && String(candidate.workspace || '') === alias
          && Number.isSafeInteger(Number(candidate.pid))
          && Number(candidate.pid) > 0
        )
      });
      return value ? { ...value, file } : { invalid: true, file, workspace: alias };
    });
}

function removeMutationProcessRecord(record) {
  const file = String(record?.file || '');
  if (!file) return false;
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

function mutationWorkspaceRoot(config, workspace) {
  const key = crypto.createHash('sha256').update(String(workspace)).digest('hex');
  return path.join(getStateDir(config), 'active-mutations', key);
}

function mutationProcessRecordFile(config, workspace, ownerRuntimeId, pid) {
  return path.join(mutationWorkspaceRoot(config, workspace), `${ownerRuntimeId}-${pid}.json`);
}

export {
  clearCurrentMutationProcess,
  listMutationProcessRecords,
  recordCurrentMutationProcess,
  removeMutationProcessRecord,
  runWithMutationProcessOwnership
};
