import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { getStateDir } from './statePaths.js';
import { resolveSafePath } from './safety.js';

const SCHEMA_VERSION = 2;

function beginStructuredPatchTransaction(config, workspace, snapshots, expectedStates = []) {
  // Never discard an unresolved recovery record, including callers outside the wrapper.
  recoverStructuredPatchTransaction(config, workspace);
  const file = transactionPath(config, workspace);
  const expectedByPath = new Map((expectedStates || []).map(state => [String(state.path || ''), state]));
  const entries = (snapshots || []).map(snapshot => {
    const expected = expectedByPath.get(String(snapshot.path || ''));
    const expectedExists = expected?.exists === true;
    const expectedContent = expectedExists ? (typeof expected?.text === 'string' ? Buffer.from(expected.text, 'utf8') : Buffer.from(expected?.content || Buffer.alloc(0))) : null;
    return {
      path: String(snapshot.path || ''),
      exists: snapshot.exists === true,
      content: snapshot.exists ? Buffer.from(snapshot.content || Buffer.alloc(0)).toString('base64') : '',
      mode: snapshot.mode == null ? null : Number(snapshot.mode),
      expectedExists,
      expectedSha256: expectedContent ? sha256(expectedContent) : '',
      previousStates: []
    };
  });
  writeJsonAtomic(file, {
    schemaVersion: SCHEMA_VERSION,
    status: 'active',
    workspaceRoot: path.resolve(workspace.path),
    startedAt: new Date().toISOString(),
    entries
  }, { mode: 0o600 });
  return file;
}

function prepareStructuredPatchEntry(config, workspace, relativePath, expectedSha256) {
  const record = readTransaction(config, workspace);
  if (!record || record.status !== 'active') throw new Error('No active edit transaction.');
  const safe = resolveSafePath(workspace.path, relativePath);
  const entry = record.entries.find(item => item.path === safe.relativePath);
  if (!entry) throw new Error('Edit path is missing from its recovery transaction.');
  const current = currentFileState(safe.absolutePath);
  if (!matchesState(current, entry.expectedExists, entry.expectedSha256)) {
    throw new Error(`Edit transaction stopped because '${safe.relativePath}' changed before the next edit.`);
  }
  entry.previousStates ||= [];
  entry.previousStates.push({ exists: entry.expectedExists, sha256: entry.expectedSha256 });
  entry.expectedExists = true;
  entry.expectedSha256 = expectedSha256;
  writeJsonAtomic(transactionPath(config, workspace), record, { mode: 0o600 });
}

function completeStructuredPatchTransaction(config, workspace) {
  const record = readTransaction(config, workspace);
  if (!record) return { committed: true, cleanupPending: false };
  // Commit is the durable decision. Unlink is only garbage collection.
  writeJsonAtomic(transactionPath(config, workspace), {
    ...record, schemaVersion: SCHEMA_VERSION, status: 'committed', completedAt: new Date().toISOString()
  }, { mode: 0o600 });
  return { committed: true, ...cleanupTransaction(config, workspace) };
}

function inspectStructuredPatchTransaction(config, workspace) {
  const record = readTransaction(config, workspace);
  const status = record ? (record.status || 'active') : 'absent';
  return { pending: Boolean(record && !['committed', 'rolled_back'].includes(status)), status };
}

function recoverStructuredPatchTransaction(config, workspace) {
  const record = readTransaction(config, workspace);
  if (!record) return { recovered: false, restored: [] };
  if (record.status === 'committed' || record.status === 'rolled_back') {
    return { recovered: false, committed: record.status === 'committed', restored: [], ...cleanupTransaction(config, workspace) };
  }
  const recoveryPlan = record.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new Error('Structured patch recovery state contains an invalid path record.');
    }
    const safe = resolveSafePath(workspace.path, entry.path);
    const originalContent = entry.exists === true ? Buffer.from(String(entry.content || ''), 'base64') : null;
    const item = { entry, safe, originalContent };
    assertRecoverableState(item);
    return item;
  });
  const restored = [];
  for (const item of recoveryPlan) {
    const { entry, safe, originalContent } = item;
    // Recheck every target immediately before restoring it. Earlier restores can
    // yield to filesystem hooks or race with an editor outside the Rel.AI queue.
    if (!assertRecoverableState(item)) {
      if (entry.exists === true) {
        fs.mkdirSync(path.dirname(safe.absolutePath), { recursive: true });
        const temporary = path.join(path.dirname(safe.absolutePath), `.relai-rollback-${crypto.randomUUID()}.tmp`);
        try {
          writeFileAtomicSync(temporary, originalContent, { fsync: true, mode: Number(entry.mode) || 0o600 });
          assertRecoverableState(item);
          fs.renameSync(temporary, safe.absolutePath);
        } finally {
          try { fs.rmSync(temporary, { force: true }); } catch {}
        }
      } else {
        fs.rmSync(safe.absolutePath, { force: true });
      }
    }
    restored.push(safe.relativePath);
  }
  // Successful rollback also needs a terminal decision before best-effort cleanup.
  writeJsonAtomic(transactionPath(config, workspace), {
    ...record, schemaVersion: SCHEMA_VERSION, status: 'rolled_back', completedAt: new Date().toISOString()
  }, { mode: 0o600 });
  return { recovered: true, restored, ...cleanupTransaction(config, workspace) };
}

function assertRecoverableState({ entry, safe, originalContent }) {
  const current = currentFileState(safe.absolutePath);
  const originalMatches = matchesState(current, entry.exists === true, sha256(originalContent));
  const expectedMatches = matchesState(current, entry.expectedExists === true, entry.expectedSha256)
    || (entry.previousStates || []).some(state => matchesState(current, state.exists, state.sha256));
  if (!originalMatches && !expectedMatches) {
    throw new Error(`Structured patch recovery stopped because '${safe.relativePath}' changed after the interrupted patch.`);
  }
  return originalMatches;
}

function matchesState(current, exists, hash) {
  return current.exists === exists && (!current.exists || current.sha256 === hash);
}

function readTransaction(config, workspace) {
  const record = readJsonFile(transactionPath(config, workspace), {
    validate: value => Boolean(value && typeof value === 'object'
      && (value.schemaVersion === 1 || value.schemaVersion === SCHEMA_VERSION)
      && (value.status == null || ['active', 'committed', 'rolled_back'].includes(value.status))
      && typeof value.workspaceRoot === 'string' && Array.isArray(value.entries))
  });
  if (record && path.resolve(record.workspaceRoot) !== path.resolve(workspace.path)) {
    throw new Error('Structured patch recovery state belongs to a different workspace root.');
  }
  return record;
}

function cleanupTransaction(config, workspace) {
  try {
    fs.rmSync(transactionPath(config, workspace), { force: true });
    return { cleanupPending: false };
  } catch (error) {
    return { cleanupPending: true, cleanupError: error instanceof Error ? error.message : String(error) };
  }
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
  prepareStructuredPatchEntry,
  completeStructuredPatchTransaction,
  recoverStructuredPatchTransaction,
  inspectStructuredPatchTransaction
};
