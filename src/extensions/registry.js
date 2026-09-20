import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { getApplicationMetadata } from '../appMetadata.js';
import {
  extensionBinRoot,
  managedExtensionBundleCommandPath,
  managedExtensionCommandMetadataPath,
  managedExtensionCommandPath
} from './paths.js';
import { extractToolBundleZip } from './toolBundle.js';
import { beginExtensionInstallTransaction, completeExtensionInstallTransaction, markExtensionInstallCommitted, recoverInterruptedExtensionInstalls } from './installTransaction.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/Kyne0328/rel-ai-extensions/main/catalog.json';
const MANIFEST_FILENAME = 'relai-extension.json';
const INSTALL_METADATA_FILENAME = '.relai-install.json';
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_EXTENSION_FILE_BYTES = 1024 * 1024;
const MAX_EXTENSION_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_INSTALL_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_BUNDLE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_TOOL_BUNDLE_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOOL_BUNDLE_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TOOL_BUNDLE_ENTRIES = 20_000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INSTALL_ARCHITECTURES = Object.freeze(['x64', 'arm64']);
const RESERVED_MANAGED_COMMANDS = new Set([
  'bash', 'cmd', 'git', 'node', 'npm', 'npx', 'powershell', 'pwsh', 'python', 'python3',
  'rel-ai-mcp', 'rel-ai-mcp-http', 'sh', 'zsh'
]);
const PERMISSIONS = Object.freeze([
  'workspace.read',
  'workspace.write',
  'command.execute',
  'git',
  'network',
  'browser',
  'computer'
]);
let catalogCache = null;

const extensionFileSchema = z.object({
  path: z.string().min(1).max(240),
  sha256: z.string().regex(SHA256_PATTERN)
}).strict();

const binaryArtifactSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(INSTALL_ARCHITECTURES),
  url: z.string().url(),
  sha256: z.string().regex(SHA256_PATTERN)
}).strict().superRefine((artifact, ctx) => {
  if (!isHttpsUrl(artifact.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Binary artifact URLs must use HTTPS.' });
});

const binaryInstallSchema = z.object({
  type: z.literal('binary'),
  artifacts: z.array(binaryArtifactSchema).min(1).max(12)
}).strict();

const bundleCommandSchema = z.object({
  command: z.string().regex(/^[A-Za-z0-9._+-]{1,100}$/),
  path: z.string().min(1).max(240)
}).strict();

const bundleArtifactSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(INSTALL_ARCHITECTURES),
  url: z.string().url(),
  sha256: z.string().regex(SHA256_PATTERN),
  commands: z.array(bundleCommandSchema).min(1).max(20)
}).strict().superRefine((artifact, ctx) => {
  if (!isHttpsUrl(artifact.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Tool bundle URLs must use HTTPS.' });
});

const bundleInstallSchema = z.object({
  type: z.literal('bundle'),
  artifacts: z.array(bundleArtifactSchema).min(1).max(12)
}).strict();

const extensionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(EXTENSION_ID_PATTERN),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  kind: z.enum(['skill', 'cli']),
  compatibility: z.object({
    relai: z.string().min(1).max(100)
  }).strict(),
  publisher: z.object({
    name: z.string().min(1).max(100),
    url: z.string().url().optional()
  }).strict(),
  repository: z.string().url(),
  homepage: z.string().url().optional(),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  requires: z.object({
    commands: z.array(z.string().regex(/^[A-Za-z0-9._+-]{1,100}$/)).max(20),
    platforms: z.array(z.enum(['win32', 'darwin', 'linux'])).max(3)
  }).strict(),
  entrypoints: z.object({
    skill: z.string().min(1).max(240),
    command: z.string().regex(/^[A-Za-z0-9._+-]{1,100}$/).optional()
  }).strict(),
  install: z.union([binaryInstallSchema, bundleInstallSchema]).optional(),
  files: z.array(extensionFileSchema).min(1).max(64)
}).strict().superRefine((manifest, ctx) => {
  if (!semver.valid(manifest.version)) {
    ctx.addIssue({ code: 'custom', path: ['version'], message: 'version must be valid semantic versioning.' });
  }
  if (!semver.validRange(manifest.compatibility.relai)) {
    ctx.addIssue({ code: 'custom', path: ['compatibility', 'relai'], message: 'compatibility.relai must be a valid semantic version range.' });
  }
  const filePaths = new Set();
  for (const [index, file] of manifest.files.entries()) {
    if (!isSafeRelativePath(file.path)) {
      ctx.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'Extension files must use safe relative paths.' });
    }
    if (filePaths.has(file.path)) {
      ctx.addIssue({ code: 'custom', path: ['files', index, 'path'], message: 'Extension file paths must be unique.' });
    }
    filePaths.add(file.path);
  }
  if (!isSafeRelativePath(manifest.entrypoints.skill) || !filePaths.has(manifest.entrypoints.skill)) {
    ctx.addIssue({ code: 'custom', path: ['entrypoints', 'skill'], message: 'entrypoints.skill must reference a declared extension file.' });
  }
  if (manifest.kind === 'cli' && !manifest.entrypoints.command) {
    ctx.addIssue({ code: 'custom', path: ['entrypoints', 'command'], message: 'CLI extensions require entrypoints.command.' });
  } else if (manifest.kind === 'cli' && !manifest.requires.commands.includes(manifest.entrypoints.command)) {
    ctx.addIssue({ code: 'custom', path: ['requires', 'commands'], message: 'CLI extensions must list entrypoints.command in requires.commands.' });
  }
  if (manifest.kind === 'cli' && !manifest.permissions.includes('command.execute')) {
    ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'CLI extensions must declare command.execute.' });
  }
  if (manifest.install && manifest.kind !== 'cli') {
    ctx.addIssue({ code: 'custom', path: ['install'], message: 'Only CLI extensions may declare install artifacts.' });
  }
  if (manifest.install?.type === 'binary' && manifest.entrypoints.command && RESERVED_MANAGED_COMMANDS.has(normalizeCommandName(manifest.entrypoints.command))) {
    ctx.addIssue({ code: 'custom', path: ['entrypoints', 'command'], message: 'This command name is reserved and cannot be auto-installed by an extension.' });
  }
  if (manifest.install) {
    const targets = new Set();
    let bundleCommandSet = null;
    for (const [index, artifact] of manifest.install.artifacts.entries()) {
      const target = `${artifact.platform}/${artifact.arch}`;
      if (targets.has(target)) ctx.addIssue({ code: 'custom', path: ['install', 'artifacts', index], message: `Duplicate install artifact target '${target}'.` });
      targets.add(target);
      if (manifest.install.type !== 'bundle') continue;
      const commands = new Set();
      for (const [commandIndex, entry] of artifact.commands.entries()) {
        const issuePath = ['install', 'artifacts', index, 'commands', commandIndex];
        if (!isSafeRelativePath(entry.path)) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'path'], message: 'Tool bundle command paths must be safe relative paths.' });
        }
        const normalizedCommand = normalizeCommandName(entry.command);
        if (isSafeRelativePath(entry.path) && normalizeCommandName(path.basename(entry.path)) !== normalizedCommand) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'path'], message: `Tool bundle command path must have the same executable name as '${entry.command}'.` });
        }
        if (RESERVED_MANAGED_COMMANDS.has(normalizedCommand)) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'command'], message: `Managed command '${entry.command}' is reserved.` });
        }
        if (commands.has(normalizedCommand)) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'command'], message: `Duplicate managed command '${entry.command}'.` });
        }
        commands.add(normalizedCommand);
        if (!manifest.requires.commands.includes(entry.command)) {
          ctx.addIssue({ code: 'custom', path: ['requires', 'commands'], message: `Tool bundle command '${entry.command}' must be listed in requires.commands.` });
        }
      }
      if (manifest.entrypoints.command && !artifact.commands.some(entry => entry.command === manifest.entrypoints.command)) {
        ctx.addIssue({ code: 'custom', path: ['entrypoints', 'command'], message: 'entrypoints.command must be provided by every tool bundle artifact.' });
      }
      const currentSet = [...commands].sort().join('\n');
      if (bundleCommandSet == null) bundleCommandSet = currentSet;
      else if (bundleCommandSet !== currentSet) {
        ctx.addIssue({ code: 'custom', path: ['install', 'artifacts', index, 'commands'], message: 'Tool bundle artifacts must expose the same command names on every platform/architecture.' });
      }
    }
  }
});

const catalogEntrySchema = z.object({
  id: z.string().regex(EXTENSION_ID_PATTERN),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  kind: z.enum(['skill', 'cli']),
  manifestUrl: z.string().url(),
  repository: z.string().url(),
  publisher: z.string().min(1).max(100),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  autoInstall: z.boolean().optional(),
  featured: z.boolean().optional()
}).strict().superRefine((entry, ctx) => {
  if (!semver.valid(entry.version)) ctx.addIssue({ code: 'custom', path: ['version'], message: 'version must be valid semantic versioning.' });
  if (!isHttpsUrl(entry.manifestUrl)) ctx.addIssue({ code: 'custom', path: ['manifestUrl'], message: 'manifestUrl must use HTTPS.' });
});

const extensionCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.string().min(1).max(80),
  extensions: z.array(catalogEntrySchema).max(500)
}).strict().superRefine((catalog, ctx) => {
  const ids = new Set();
  for (const [index, entry] of catalog.extensions.entries()) {
    if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', path: ['extensions', index, 'id'], message: 'Catalog extension ids must be unique.' });
    ids.add(entry.id);
  }
});

function parseExtensionManifest(value) {
  return extensionManifestSchema.parse(value);
}

function parseExtensionCatalog(value) {
  return extensionCatalogSchema.parse(value);
}

function extensionsRoot(config = {}) {
  const stateDir = String(config?.stateDir || '').trim();
  if (!stateDir) throw new Error('Rel.AI state directory is unavailable.');
  return path.join(path.resolve(stateDir), 'extensions');
}

function listInstalledExtensions(config = {}) {
  const recovery = recoverInterruptedExtensionInstalls(config);
  if (!recovery.ok) throw new Error(`Could not recover an interrupted extension installation: ${recovery.errors[0]?.error || 'unknown recovery error'}`);
  const root = extensionsRoot(config);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map(entry => readInstalledExtension(path.join(root, entry.name), entry.name, config))
    .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));
}

function readInstalledExtension(directory, directoryName = path.basename(directory), config = {}) {
  try {
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('Extension manifest is missing or unsafe.');
    }
    const manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (manifest.id !== directoryName) throw new Error(`Manifest id '${manifest.id}' does not match extension directory '${directoryName}'.`);
    verifyInstalledFiles(directory, manifest);
    const readiness = extensionReadiness(manifest, config);
    return { ...publicManifest(manifest), ...readiness };
  } catch (error) {
    return {
      id: directoryName,
      name: directoryName,
      version: '',
      kind: 'unknown',
      status: 'invalid',
      ready: false,
      error: errorMessage(error),
      permissions: [],
      missingCommands: []
    };
  }
}

function extensionReadiness(manifest, config = {}) {
  const appVersion = String(getApplicationMetadata()?.version || '0.0.0');
  const reasons = [];
  if (!semver.satisfies(appVersion, manifest.compatibility.relai, { includePrerelease: true })) {
    reasons.push(`Requires Rel.AI ${manifest.compatibility.relai}; installed version is ${appVersion}.`);
  }
  if (manifest.requires.platforms.length && !manifest.requires.platforms.includes(process.platform)) {
    reasons.push(`Supports ${manifest.requires.platforms.join(', ')}; this computer is ${process.platform}.`);
  }
  const missingCommands = manifest.requires.commands.filter(command => !commandAvailable(command, config));
  if (missingCommands.length) reasons.push(`Missing required command${missingCommands.length === 1 ? '' : 's'}: ${missingCommands.join(', ')}.`);
  const ready = reasons.length === 0;
  return {
    status: ready ? 'ready' : 'needs_setup',
    ready,
    error: reasons.join(' '),
    missingCommands
  };
}

function extensionSkillRecords(config = {}) {
  const root = extensionsRoot(config);
  return listInstalledExtensions(config).flatMap(extension => {
    if (!extension.ready || !extension.entrypoints?.skill) return [];
    const file = path.join(root, extension.id, extension.entrypoints.skill);
    return [{
      name: extension.id,
      description: extension.description,
      source: 'extension',
      file,
      displayPath: `extension:${extension.id}`
    }];
  });
}

async function extensionDashboard(config = {}, options = {}) {
  const installed = listInstalledExtensions(config);
  let catalog = null;
  let catalogError = '';
  try {
    catalog = await fetchExtensionCatalog(options);
  } catch (error) {
    catalogError = errorMessage(error);
  }
  const installedById = new Map(installed.map(item => [item.id, item]));
  const available = (catalog?.extensions || []).map(entry => {
    const current = installedById.get(entry.id);
    return {
      ...entry,
      installedVersion: current?.version || '',
      installed: Boolean(current?.version),
      updateAvailable: Boolean(current?.version && semver.gt(entry.version, current.version))
    };
  });
  return {
    ok: true,
    catalogUrl: resolveCatalogUrl(options),
    installRoot: extensionsRoot(config),
    installed,
    catalog: available,
    catalogUpdatedAt: catalog?.updatedAt || '',
    catalogError
  };
}

async function fetchExtensionCatalog(options = {}) {
  const url = resolveCatalogUrl(options);
  const now = Date.now();
  if (!options.refresh && catalogCache?.url === url && catalogCache.expiresAt > now) return catalogCache.value;
  const raw = await fetchJsonDocument(url, MAX_CATALOG_BYTES, 'extension catalog');
  const catalog = parseExtensionCatalog(raw);
  catalogCache = { url, value: catalog, expiresAt: now + CATALOG_TTL_MS };
  return catalog;
}

async function prepareManagedCommandInstall(config, manifest, extensionStaging) {
  if (manifest.kind !== 'cli' || !manifest.install) return null;
  const artifact = manifest.install.artifacts.find(item => item.platform === process.platform && item.arch === process.arch);
  if (!artifact) {
    throw new Error(`No auto-install artifact is available for ${process.platform}/${process.arch}.`);
  }
  if (manifest.install.type === 'bundle') {
    return await prepareManagedBundleInstall(config, manifest, artifact, extensionStaging);
  }

  const command = String(manifest.entrypoints.command || '').trim();
  if (!command) return null;
  const disposition = managedCommandDisposition(config, manifest.id, command);
  if (!disposition) return null;
  const content = await fetchFile(artifact.url, MAX_INSTALL_ARTIFACT_BYTES, `CLI artifact for ${manifest.id}`, { timeoutMs: 120_000 });
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (digest !== artifact.sha256) throw new Error(`Checksum mismatch for CLI artifact '${command}'.`);

  const binRoot = extensionBinRoot(config);
  fs.mkdirSync(binRoot, { recursive: true, mode: 0o700 });
  const entry = createManagedCommandTransactionEntry(config, manifest, command, {
    installType: 'binary',
    url: artifact.url,
    sha256: artifact.sha256
  });
  fs.writeFileSync(entry.stagingTarget, content, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(entry.stagingTarget, 0o755);
  return { entries: [entry], committed: false };
}

async function prepareManagedBundleInstall(config, manifest, artifact, extensionStaging) {
  const managed = artifact.commands
    .map(item => ({ item, disposition: managedCommandDisposition(config, manifest.id, item.command) }))
    .filter(item => item.disposition);
  if (!managed.length) return null;

  const archivePath = path.join(extensionStaging, '.tool-bundle-download.zip');
  const toolRoot = path.join(extensionStaging, '.tool');
  await downloadVerifiedFile(
    artifact.url,
    MAX_TOOL_BUNDLE_ARCHIVE_BYTES,
    `tool bundle for ${manifest.id}`,
    archivePath,
    artifact.sha256,
    { timeoutMs: 15 * 60_000 }
  );
  try {
    await extractToolBundleZip(archivePath, toolRoot, {
      maxEntries: MAX_TOOL_BUNDLE_ENTRIES,
      maxExtractedBytes: MAX_TOOL_BUNDLE_EXTRACTED_BYTES,
      maxFileBytes: MAX_TOOL_BUNDLE_FILE_BYTES
    });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }

  for (const item of artifact.commands) {
    const commandPath = safeJoin(toolRoot, item.path);
    let stat;
    try { stat = fs.lstatSync(commandPath); } catch {
      throw new Error(`Tool bundle command '${item.command}' is missing declared path '${item.path}'.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Tool bundle command '${item.command}' is not a safe regular file.`);
    }
    if (process.platform !== 'win32') fs.chmodSync(commandPath, stat.mode | 0o111);
  }

  const entries = managed.map(({ item }) => createManagedCommandTransactionEntry(config, manifest, item.command, {
    installType: 'bundle',
    relativePath: item.path,
    url: artifact.url,
    sha256: artifact.sha256
  }));
  return { entries, committed: false };
}

function managedCommandDisposition(config, extensionId, command) {
  const systemAvailable = systemCommandAvailable(command, config);
  const owner = readManagedCommandOwner(config, command);
  const target = managedExtensionCommandPath(config, command);
  const metadataTarget = managedExtensionCommandMetadataPath(config, command);
  if (owner && owner !== extensionId && !systemAvailable) {
    throw new Error(`Cannot auto-install '${command}' because it is managed by extension '${owner}'.`);
  }
  if (systemAvailable && owner !== extensionId) return null;
  if (fs.existsSync(target) && !owner) {
    throw new Error(`Refusing to replace unowned managed command '${command}'.`);
  }
  if (fs.existsSync(metadataTarget) && !owner) {
    throw new Error(`Refusing to replace unowned managed command metadata for '${command}'.`);
  }
  return { command, target, metadataTarget };
}

function createManagedCommandTransactionEntry(config, manifest, command, metadata) {
  const { target, metadataTarget } = managedCommandDisposition(config, manifest.id, command);
  const binRoot = extensionBinRoot(config);
  fs.mkdirSync(binRoot, { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  const stagingTarget = metadata.installType === 'binary'
    ? path.join(binRoot, `.install-${manifest.id}-${normalizeCommandName(command)}-${nonce}`)
    : '';
  const stagingMetadata = path.join(binRoot, `.install-${manifest.id}-${normalizeCommandName(command)}-${nonce}.json`);
  const backupTarget = `${target}.backup-${nonce}`;
  const backupMetadata = `${metadataTarget}.backup-${nonce}`;
  fs.writeFileSync(stagingMetadata, `${JSON.stringify({
    schemaVersion: 1,
    extensionId: manifest.id,
    command,
    platform: process.platform,
    arch: process.arch,
    ...metadata,
    installedAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    command,
    target,
    metadataTarget,
    stagingTarget,
    stagingMetadata,
    backupTarget,
    backupMetadata,
    targetExisted: fs.existsSync(target),
    metadataExisted: fs.existsSync(metadataTarget),
    targetPromoted: false,
    metadataPromoted: false
  };
}

function commitManagedCommandInstall(install) {
  if (!install) return;
  try {
    for (const entry of install.entries) {
      if (fs.existsSync(entry.target)) fs.renameSync(entry.target, entry.backupTarget);
      if (fs.existsSync(entry.metadataTarget)) fs.renameSync(entry.metadataTarget, entry.backupMetadata);
    }
    for (const entry of install.entries) {
      if (entry.stagingTarget) {
        fs.renameSync(entry.stagingTarget, entry.target);
        entry.targetPromoted = true;
        if (process.platform !== 'win32') fs.chmodSync(entry.target, 0o755);
      }
      fs.renameSync(entry.stagingMetadata, entry.metadataTarget);
      entry.metadataPromoted = true;
    }
    install.committed = true;
  } catch (error) {
    rollbackManagedCommandInstall(install);
    throw error;
  }
}

function rollbackManagedCommandInstall(install) {
  if (!install) return;
  for (const entry of [...install.entries].reverse()) {
    if (entry.stagingTarget) fs.rmSync(entry.stagingTarget, { force: true });
    fs.rmSync(entry.stagingMetadata, { force: true });
    if (entry.targetPromoted) fs.rmSync(entry.target, { force: true });
    if (entry.metadataPromoted) fs.rmSync(entry.metadataTarget, { force: true });
    if (!fs.existsSync(entry.target) && fs.existsSync(entry.backupTarget)) fs.renameSync(entry.backupTarget, entry.target);
    if (!fs.existsSync(entry.metadataTarget) && fs.existsSync(entry.backupMetadata)) fs.renameSync(entry.backupMetadata, entry.metadataTarget);
    entry.targetPromoted = false;
    entry.metadataPromoted = false;
  }
  install.committed = false;
}

function finalizeManagedCommandInstall(install) {
  if (!install) return;
  for (const entry of install.entries) {
    if (entry.stagingTarget) fs.rmSync(entry.stagingTarget, { force: true });
    fs.rmSync(entry.stagingMetadata, { force: true });
    fs.rmSync(entry.backupTarget, { force: true });
    fs.rmSync(entry.backupMetadata, { force: true });
  }
}

async function installExtension(config, id, options = {}) {
  const extensionId = normalizeExtensionId(id);
  const recovery = recoverInterruptedExtensionInstalls(config);
  if (!recovery.ok) throw new Error(`Could not recover an interrupted extension installation: ${recovery.errors[0]?.error || 'unknown recovery error'}`);
  const catalog = await fetchExtensionCatalog({ ...options, refresh: true });
  const entry = catalog.extensions.find(item => item.id === extensionId);
  if (!entry) throw new Error(`Extension '${extensionId}' is not in the Rel.AI extension catalog.`);
  const rawManifest = await fetchJsonDocument(entry.manifestUrl, MAX_MANIFEST_BYTES, 'extension manifest');
  const manifest = parseExtensionManifest(rawManifest);
  if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.kind !== entry.kind) {
    throw new Error('Catalog metadata does not match the extension manifest.');
  }
  if (JSON.stringify([...manifest.permissions].sort()) !== JSON.stringify([...entry.permissions].sort())) {
    throw new Error('Catalog permissions do not match the extension manifest. Refresh the catalog before installing.');
  }
  if (Boolean(manifest.install) !== Boolean(entry.autoInstall)) {
    throw new Error('Catalog auto-install metadata does not match the extension manifest. Refresh the catalog before installing.');
  }
  const readiness = extensionReadiness(manifest, config);
  if (!semver.satisfies(String(getApplicationMetadata()?.version || '0.0.0'), manifest.compatibility.relai, { includePrerelease: true })) {
    throw new Error(readiness.error || 'This extension is not compatible with the installed Rel.AI version.');
  }
  if (manifest.requires.platforms.length && !manifest.requires.platforms.includes(process.platform)) {
    throw new Error(readiness.error || 'This extension does not support this platform.');
  }
  const root = extensionsRoot(config);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, manifest.id);
  const staging = path.join(root, `.install-${manifest.id}-${crypto.randomUUID()}`);
  const backup = path.join(root, `.backup-${manifest.id}-${crypto.randomUUID()}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  let managedInstall = null;
  let totalBytes = 0;
  let packageCommitted = false;
  try {
    managedInstall = await prepareManagedCommandInstall(config, manifest, staging);
    for (const file of manifest.files) {
      const fileUrl = new URL(file.path.replaceAll('\\', '/'), entry.manifestUrl).href;
      const content = await fetchFile(fileUrl, MAX_EXTENSION_FILE_BYTES, `extension file ${file.path}`);
      totalBytes += content.length;
      if (totalBytes > MAX_EXTENSION_TOTAL_BYTES) throw new Error('Extension package exceeds the allowed total size.');
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (digest !== file.sha256) throw new Error(`Checksum mismatch for extension file '${file.path}'.`);
      const destination = safeJoin(staging, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(staging, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, INSTALL_METADATA_FILENAME), `${JSON.stringify({
      schemaVersion: 1,
      manifestUrl: entry.manifestUrl,
      catalogUrl: resolveCatalogUrl(options),
      installedAt: new Date().toISOString(),
      managedCommands: managedInstall?.entries.map(entry => entry.command) || []
    }, null, 2)}\n`, { mode: 0o600 });
    beginExtensionInstallTransaction(config, {
      id: manifest.id,
      target,
      staging,
      backup,
      targetExisted: fs.existsSync(target),
      entries: managedInstall?.entries || []
    });
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(staging, target);
    packageCommitted = true;
    commitManagedCommandInstall(managedInstall);
    markExtensionInstallCommitted(config, manifest.id);
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    finalizeManagedCommandInstall(managedInstall);
    completeExtensionInstallTransaction(config, manifest.id);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rollbackManagedCommandInstall(managedInstall);
    if (packageCommitted) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    completeExtensionInstallTransaction(config, manifest.id);
    throw error;
  }
  return readInstalledExtension(target, manifest.id, config);
}

function removeExtension(config, id) {
  const extensionId = normalizeExtensionId(id);
  const recovery = recoverInterruptedExtensionInstalls(config);
  if (!recovery.ok) throw new Error(`Could not recover an interrupted extension installation: ${recovery.errors[0]?.error || 'unknown recovery error'}`);
  const root = extensionsRoot(config);
  const target = path.join(root, extensionId);
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { ok: true, id: extensionId, removed: false }; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to remove an unsafe extension path.');
  const removedCommands = removeManagedCommandsOwnedBy(config, extensionId);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { ok: true, id: extensionId, removed: true, removedCommands };
}

function verifyInstalledFiles(directory, manifest) {
  for (const file of manifest.files) {
    const target = safeJoin(directory, file.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXTENSION_FILE_BYTES) {
      throw new Error(`Extension file '${file.path}' is missing or unsafe.`);
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    if (digest !== file.sha256) throw new Error(`Installed extension file '${file.path}' failed checksum verification.`);
  }
}

function publicManifest(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    kind: manifest.kind,
    compatibility: manifest.compatibility,
    publisher: manifest.publisher,
    repository: manifest.repository,
    homepage: manifest.homepage || '',
    permissions: manifest.permissions,
    requires: manifest.requires,
    entrypoints: manifest.entrypoints,
    autoInstall: Boolean(manifest.install)
  };
}

function normalizeExtensionId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!EXTENSION_ID_PATTERN.test(id)) throw new Error('Invalid extension id.');
  return id;
}

function isSafeRelativePath(value) {
  const text = String(value || '').replaceAll('\\', '/');
  if (!text || text.startsWith('/') || /^[A-Za-z]:\//.test(text)) return false;
  const segments = text.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function safeJoin(root, relative) {
  if (!isSafeRelativePath(relative)) throw new Error(`Unsafe extension path '${relative}'.`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Unsafe extension path '${relative}'.`);
  return resolved;
}

function resolveCatalogUrl(options = {}) {
  const url = String(options.catalogUrl || process.env.REL_AI_EXTENSIONS_CATALOG_URL || CATALOG_URL).trim();
  if (!isHttpsUrl(url)) throw new Error('The Rel.AI extension catalog URL must use HTTPS.');
  return url;
}

function isHttpsUrl(value) {
  try { return new URL(String(value || '')).protocol === 'https:'; } catch { return false; }
}

async function fetchJsonDocument(url, maxBytes, label) {
  const content = await fetchFile(url, maxBytes, label);
  try { return JSON.parse(content.toString('utf8')); } catch (error) { throw new Error(`The ${label} did not contain valid JSON.`, { cause: error }); }
}

async function fetchFile(url, maxBytes, label, options = {}) {
  if (!isHttpsUrl(url)) throw new Error(`The ${label} URL must use HTTPS.`);
  const controller = new AbortController();
  const timeoutMs = Math.min(120_000, Math.max(1_000, Number(options.timeoutMs) || 8_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Rel.AI-MCP-Extensions/1' } });
    if (!response.ok) throw new Error(`Could not download ${label}: HTTP ${response.status}.`);
    if (!isHttpsUrl(response.url || url)) throw new Error(`The ${label} redirected to a non-HTTPS URL.`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) throw new Error(`The ${label} exceeds the allowed size.`);
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > maxBytes) throw new Error(`The ${label} exceeds the allowed size.`);
    return content;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Timed out downloading ${label}.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}


async function downloadVerifiedFile(url, maxBytes, label, destination, expectedSha256, options = {}) {
  if (!isHttpsUrl(url)) throw new Error(`The ${label} URL must use HTTPS.`);
  const controller = new AbortController();
  const timeoutMs = Math.min(30 * 60_000, Math.max(1_000, Number(options.timeoutMs) || 120_000));
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let fd = null;
  let completed = false;
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': 'Rel.AI-MCP-Extensions/1' } });
    if (!response.ok) throw new Error(`Could not download ${label}: HTTP ${response.status}.`);
    if (!isHttpsUrl(response.url || url)) throw new Error(`The ${label} redirected to a non-HTTPS URL.`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxBytes) throw new Error(`The ${label} exceeds the allowed size.`);
    if (!response.body) throw new Error(`The ${label} response did not contain a body.`);

    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fd = fs.openSync(destination, 'wx', 0o600);
    const digest = crypto.createHash('sha256');
    const reader = response.body.getReader();
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          controller.abort();
          throw new Error(`The ${label} exceeds the allowed size.`);
        }
        digest.update(chunk);
        fs.writeSync(fd, chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const actualSha256 = digest.digest('hex');
    if (actualSha256 !== expectedSha256) throw new Error(`Checksum mismatch for ${label}.`);
    completed = true;
    return { bytes: totalBytes, sha256: actualSha256 };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Timed out downloading ${label}.`, { cause: error });
    throw error;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    if (!completed) fs.rmSync(destination, { force: true });
    clearTimeout(timeout);
  }
}

function normalizeCommandName(value) {
  return path.basename(String(value || '').trim()).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/i, '');
}

function systemCommandAvailable(command, config = {}) {
  const name = String(command || '').trim();
  if (!name) return false;
  const managedRoot = path.resolve(extensionBinRoot(config));
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .filter(directory => path.resolve(directory) !== managedRoot);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' && path.extname(name) ? name : `${name}${extension}`);
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) return true;
      } catch {}
    }
  }
  return false;
}

function readManagedCommandMetadata(config, command) {
  const metadataPath = managedExtensionCommandMetadataPath(config, command);
  try {
    const stat = fs.lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return null;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (metadata?.schemaVersion !== 1) return null;
    if (String(metadata?.command || '') !== String(command || '')) return null;
    const extensionId = String(metadata?.extensionId || '');
    if (!EXTENSION_ID_PATTERN.test(extensionId)) return null;
    return metadata;
  } catch {
    return null;
  }
}

function readManagedCommandOwner(config, command) {
  return String(readManagedCommandMetadata(config, command)?.extensionId || '');
}

function commandAvailable(command, config = {}) {
  if (systemCommandAvailable(command, config)) return true;
  const metadata = readManagedCommandMetadata(config, command);
  if (!metadata) return false;
  try {
    const target = metadata.installType === 'bundle'
      ? managedExtensionBundleCommandPath(config, metadata.extensionId, metadata.relativePath)
      : managedExtensionCommandPath(config, command);
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function removeManagedCommandsOwnedBy(config, extensionId) {
  const root = path.resolve(extensionBinRoot(config));
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.relai-owner.json')) continue;
    const metadataPath = path.join(root, entry.name);
    let metadata;
    try {
      const stat = fs.lstatSync(metadataPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) continue;
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      continue;
    }
    if (String(metadata?.extensionId || '') !== extensionId) continue;
    const commandPath = metadataPath.slice(0, -'.relai-owner.json'.length);
    const relativeCommand = path.relative(root, path.resolve(commandPath));
    if (!relativeCommand || relativeCommand.startsWith('..') || path.isAbsolute(relativeCommand) || relativeCommand.includes(path.sep)) continue;
    fs.rmSync(commandPath, { force: true });
    fs.rmSync(metadataPath, { force: true });
    removed.push(String(metadata?.command || path.basename(commandPath)));
  }
  return [...new Set(removed)].sort((left, right) => left.localeCompare(right));
}

function errorMessage(error) {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join(' ');
  return error instanceof Error ? error.message : String(error || 'Unknown extension error');
}

export {
  CATALOG_URL,
  MANIFEST_FILENAME,
  PERMISSIONS,
  extensionCatalogSchema,
  extensionDashboard,
  extensionManifestSchema,
  extensionSkillRecords,
  extensionsRoot,
  fetchExtensionCatalog,
  installExtension,
  listInstalledExtensions,
  parseExtensionCatalog,
  parseExtensionManifest,
  removeExtension
};
