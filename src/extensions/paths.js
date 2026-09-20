import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateDir } from '../statePaths.js';
import { recoverInterruptedExtensionInstalls } from './installTransaction.js';

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/;

function extensionBinRoot(config = {}) {
  return path.join(getStateDir(config), 'extensions', '.bin');
}

function extensionManagedToolRoot(config = {}, extensionId = '') {
  const id = String(extensionId || '').trim().toLowerCase();
  if (!EXTENSION_ID_PATTERN.test(id)) throw new Error('Managed extension id is invalid.');
  return path.join(getStateDir(config), 'extensions', id, '.tool');
}

function managedExtensionCommandFilename(command, platform = process.platform) {
  const name = String(command || '').trim();
  if (!name) throw new Error('Managed extension command name is required.');
  return platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}

function managedExtensionCommandPath(config, command, platform = process.platform) {
  return path.join(extensionBinRoot(config), managedExtensionCommandFilename(command, platform));
}

function managedExtensionCommandMetadataPath(config, command, platform = process.platform) {
  return `${managedExtensionCommandPath(config, command, platform)}.relai-owner.json`;
}

function managedExtensionBundleCommandPath(config, extensionId, relativePath) {
  const root = path.resolve(extensionManagedToolRoot(config, extensionId));
  const relative = normalizeManagedRelativePath(relativePath);
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Managed extension bundle command path is unsafe.');
  }
  return resolved;
}

function extensionCommandPathEntries(config = {}) {
  const recovery = recoverInterruptedExtensionInstalls(config);
  if (!recovery.ok) return [];
  const binRoot = path.resolve(extensionBinRoot(config));
  const paths = [binRoot];
  let entries;
  try {
    entries = fs.readdirSync(binRoot, { withFileTypes: true });
  } catch {
    return paths;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.relai-owner.json')) continue;
    const metadataPath = path.join(binRoot, entry.name);
    let metadata;
    try {
      const stat = fs.lstatSync(metadataPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) continue;
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      continue;
    }
    if (metadata?.schemaVersion !== 1 || metadata?.installType !== 'bundle') continue;
    try {
      const target = managedExtensionBundleCommandPath(config, metadata.extensionId, metadata.relativePath);
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      paths.push(path.dirname(target));
    } catch {}
  }
  const seen = new Set();
  return paths.filter(item => {
    const resolved = path.resolve(item);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeManagedRelativePath(value) {
  const text = String(value || '').replaceAll('\\', '/');
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text) || text.includes('\0')) {
    throw new Error('Managed extension relative path is invalid.');
  }
  const segments = text.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    throw new Error('Managed extension relative path is invalid.');
  }
  return segments.join(path.sep);
}

export {
  extensionBinRoot,
  extensionCommandPathEntries,
  extensionManagedToolRoot,
  managedExtensionBundleCommandPath,
  managedExtensionCommandFilename,
  managedExtensionCommandMetadataPath,
  managedExtensionCommandPath
};
