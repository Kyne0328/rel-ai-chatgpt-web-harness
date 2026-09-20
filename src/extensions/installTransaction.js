import * as fs from 'node:fs';
import * as path from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../durableState.ts';
import { getStateDir } from '../statePaths.js';

const SCHEMA_VERSION = 1;
const MARKER_PATTERN = /^\.install-transaction-([a-z0-9][a-z0-9.-]{0,79})\.json$/;

function beginExtensionInstallTransaction(config, transaction) {
  const marker = markerPath(config, transaction.id);
  writeJsonAtomic(marker, { schemaVersion: SCHEMA_VERSION, phase: 'prepared', ...transaction }, { mode: 0o600 });
  return marker;
}

function markExtensionInstallCommitted(config, id) {
  const marker = markerPath(config, id);
  const transaction = readTransaction(marker);
  if (!transaction) throw new Error(`Extension install transaction for '${id}' is missing.`);
  writeJsonAtomic(marker, { ...transaction, phase: 'committed' }, { mode: 0o600 });
}

function completeExtensionInstallTransaction(config, id) {
  try { fs.rmSync(markerPath(config, id), { force: true }); } catch {}
}

function recoverInterruptedExtensionInstalls(config) {
  const root = extensionRoot(config);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { ok: true, recovered: 0, errors: [] }; }
  const errors = [];
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !MARKER_PATTERN.test(entry.name)) continue;
    const marker = path.join(root, entry.name);
    try {
      const transaction = readTransaction(marker);
      if (!transaction) throw new Error('Install transaction marker is invalid.');
      validateTransactionPaths(root, transaction);
      if (transaction.phase === 'committed') finalizeCommitted(transaction);
      else rollbackPrepared(transaction);
      fs.rmSync(marker, { force: true });
      recovered += 1;
    } catch (error) {
      errors.push({ marker: entry.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: errors.length === 0, recovered, errors };
}

function rollbackPrepared(transaction) {
  for (const entry of [...(transaction.entries || [])].reverse()) {
    if (entry.stagingTarget) fs.rmSync(entry.stagingTarget, { force: true });
    fs.rmSync(entry.stagingMetadata, { force: true });
    restorePath(entry.target, entry.backupTarget, entry.targetExisted === true, false);
    restorePath(entry.metadataTarget, entry.backupMetadata, entry.metadataExisted === true, false);
  }
  fs.rmSync(transaction.staging, { recursive: true, force: true });
  restorePath(transaction.target, transaction.backup, transaction.targetExisted === true, true);
}

function finalizeCommitted(transaction) {
  fs.rmSync(transaction.staging, { recursive: true, force: true });
  fs.rmSync(transaction.backup, { recursive: true, force: true });
  for (const entry of transaction.entries || []) {
    if (entry.stagingTarget) fs.rmSync(entry.stagingTarget, { force: true });
    fs.rmSync(entry.stagingMetadata, { force: true });
    fs.rmSync(entry.backupTarget, { recursive: true, force: true });
    fs.rmSync(entry.backupMetadata, { force: true });
  }
}

function restorePath(target, backup, existed, recursive) {
  if (backup && fs.existsSync(backup)) {
    fs.rmSync(target, { recursive, force: true });
    fs.renameSync(backup, target);
    return;
  }
  if (!existed) fs.rmSync(target, { recursive, force: true });
}

function readTransaction(marker) {
  return readJsonFile(marker, {
    validate: value => Boolean(value && typeof value === 'object'
      && value.schemaVersion === SCHEMA_VERSION
      && ['prepared', 'committed'].includes(String(value.phase || ''))
      && MARKER_PATTERN.test(`.install-transaction-${String(value.id || '')}.json`)
      && typeof value.target === 'string'
      && typeof value.staging === 'string'
      && typeof value.backup === 'string'
      && Array.isArray(value.entries))
  });
}

function validateTransactionPaths(root, transaction) {
  const paths = [transaction.target, transaction.staging, transaction.backup];
  for (const entry of transaction.entries || []) {
    paths.push(entry.target, entry.metadataTarget, entry.stagingMetadata, entry.backupTarget, entry.backupMetadata);
    if (entry.stagingTarget) paths.push(entry.stagingTarget);
  }
  for (const candidate of paths) {
    const resolved = path.resolve(String(candidate || ''));
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Extension install transaction contains an unsafe path.');
    }
  }
}

function extensionRoot(config) {
  return path.join(getStateDir(config), 'extensions');
}

function markerPath(config, id) {
  const extensionId = String(id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(extensionId)) throw new Error('Extension install transaction id is invalid.');
  return path.join(extensionRoot(config), `.install-transaction-${extensionId}.json`);
}

export {
  beginExtensionInstallTransaction,
  completeExtensionInstallTransaction,
  markExtensionInstallCommitted,
  recoverInterruptedExtensionInstalls
};
