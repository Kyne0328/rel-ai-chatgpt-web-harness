import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { getStateDir } from './statePaths.js';
import { resolveSafePath } from './safety.js';

const SCHEMA_VERSION = 1;

function beginStructuredPatchTransaction(config, workspace, snapshots, expectedStates = []) {
  const file = transactionPath(config, workspace);
  const expectedByPath = new Map((expectedStates || []).map(state => [String(state.path || ''), state]));
  const entries = (snapshots || []).map(snapshot => {
    const expected = expectedByPath.get(String(snapshot.path || ''));
    const expectedExists = expected?.exists === true;
    const expectedContent = expectedExists ? Buffer.from(String(expected?.text || ''), 'utf8') : null;
    return {
      path: String(snapshot.path || ''),
      exists: snapshot.exists === true,
      content: snapshot.exists ? Buffer.from(snapshot.content || Buffer.alloc(0)).toString('base64') : '',
      mode: snapshot.mode == null ? null : Number(snapshot.mode),
      expectedExists,
      expectedSha256: expectedContent ? sha256(expectedContent) : ''
    };
  });
  writeJsonAtomic(file, {
    schemaVersion: SCHEMA_VERSION,
    workspaceRoot: path.resolve(workspace.path),
    startedAt: new Date().toISOString(),
    entries
  }, { mode: 0o600 });
  return file;
}

function completeStructuredPatchTransaction(config, workspace) {
  try { fs.rmSync(transactionPath(config, workspace), { force: true }); } catch {}
}

function recoverStructuredPatchTransaction(config, workspace) {
  const file = transactionPath(config, workspace);
  const record = readJsonFile(file, {
    validate: value => Boolean(value && typeof value === 'object'
      && value.schemaVersion === SCHEMA_VERSION
      && typeof value.workspaceRoot === 'string'
      && Array.isArray(value.entries))
  });
  if (!record) return { recovered: false, restored: [] };
  if (path.resolve(record.workspaceRoot) !== path.resolve(workspace.path)) {
    throw new Error('Structured patch recovery state belongs to a different workspace root.');
  }
  const recoveryPlan = record.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new Error('Structured patch recovery state contains an invalid path record.');
    }
    const safe = resolveSafePath(workspace.path, entry.path);
    const current = currentFileState(safe.absolutePath);
    const originalContent = entry.exists === true ? Buffer.from(String(entry.content || ''), 'base64') : null;
    const originalMatches = current.exists === (entry.exists === true)
      && (!current.exists || current.sha256 === sha256(originalContent));
    const expectedMatches = current.exists === (entry.expectedExists === true)
      && (!current.exists || current.sha256 === String(entry.expectedSha256 || ''));
    if (!originalMatches && !expectedMatches) {
      throw new Error(`Structured patch recovery stopped because '${safe.relativePath}' changed after the interrupted patch.`);
    }
    return { entry, safe, originalContent, originalMatches };
  });
  const restored = [];
  for (const item of recoveryPlan) {
    const { entry, safe, originalContent, originalMatches } = item;
    if (!originalMatches) {
      if (entry.exists === true) {
        fs.mkdirSync(path.dirname(safe.absolutePath), { recursive: true });
        writeFileAtomicSync(safe.absolutePath, originalContent, { fsync: true, mode: Number(entry.mode) || 0o600 });
        if (entry.mode != null) fs.chmodSync(safe.absolutePath, Number(entry.mode));
      } else {
        fs.rmSync(safe.absolutePath, { force: true });
      }
    }
    restored.push(safe.relativePath);
  }
  fs.rmSync(file, { force: true });
  return { recovered: true, restored };
}

function currentFileState(file) {
  try {
    const content = fs.readFileSync(file);
    return { exists: true, sha256: sha256(content) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, sha256: '' };
    throw error;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value || Buffer.alloc(0)).digest('hex');
}

function transactionPath(config, workspace) {
  const root = path.resolve(workspace.path);
  const key = crypto.createHash('sha256').update(root).digest('hex');
  return path.join(getStateDir(config), 'structured-patch-transactions', `${key}.json`);
}

export {
  beginStructuredPatchTransaction,
  completeStructuredPatchTransaction,
  recoverStructuredPatchTransaction
};
