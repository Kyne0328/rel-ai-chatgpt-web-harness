import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
const OFFICIAL_EXTENSION_REPOSITORY_URL = 'https://github.com/Kyne0328/rel-ai-extensions';
const PUBLISHER_CATALOG_FILENAME = 'publisher-catalog.json';
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
const MAX_CONDA_LOCK_BYTES = 512 * 1024;
const MAX_CONDA_PACKAGES = 300;
const MAX_CONDA_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_CONDA_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const CONDA_INSTALL_TIMEOUT_MS = 20 * 60_000;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INSTALL_ARCHITECTURES = Object.freeze(['x64', 'arm64']);
const CONDA_SUBDIRS = Object.freeze(['win-64', 'osx-64', 'osx-arm64', 'linux-64', 'linux-aarch64']);
const MICROMAMBA_ARTIFACTS = Object.freeze({
  'win32/x64': { url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-win-64.exe', sha256: 'a6d804394b2418991c4e29562853eaace2f2ce9d9da661a98e74e02e8dbb44b0' },
  'win32/arm64': { url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-win-arm64.exe', sha256: 'f0da836d2398c00ac0b43e01f7581ba3430224a04405075c39eb3dd78bf0339a' },
  'darwin/x64': { url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-osx-64', sha256: '1e71054bb3ac9a076e21f7ec48acfef536f9b3f1408f371a942784bf5ef83d8a' },
  'darwin/arm64': { url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-osx-arm64', sha256: 'ec2a072f028e1a7cf20f3e2e74d5a8127cf5a5f27636375b5359811565f4e5be' },
  'linux/x64': { url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-linux-64', sha256: '366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3' },
  'linux/arm64': { url: 'https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-linux-aarch64', sha256: '9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7' }
});
const RESERVED_MANAGED_COMMANDS = new Set([
  'bash', 'cmd', 'git', 'node', 'npm', 'npx', 'powershell', 'pwsh', 'python', 'python3',
  'rel-ai-mcp', 'rel-ai-mcp-http', 'relai-extension', 'relai-mcp-config', 'sh', 'zsh'
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
const catalogCache = new Map();
const installedExtensionVerificationCache = new Map();

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

const condaArtifactSchema = z.object({
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(INSTALL_ARCHITECTURES),
  subdir: z.enum(CONDA_SUBDIRS),
  lockUrl: z.string().url(),
  lockSha256: z.string().regex(SHA256_PATTERN),
  commands: z.array(bundleCommandSchema).min(1).max(20)
}).strict().superRefine((artifact, ctx) => {
  if (!isHttpsUrl(artifact.lockUrl)) ctx.addIssue({ code: 'custom', path: ['lockUrl'], message: 'Conda lock URLs must use HTTPS.' });
  const expectedSubdir = condaSubdirForTarget(artifact.platform, artifact.arch);
  if (artifact.subdir !== expectedSubdir) {
    ctx.addIssue({ code: 'custom', path: ['subdir'], message: `Conda subdir for ${artifact.platform}/${artifact.arch} must be '${expectedSubdir}'.` });
  }
});

const condaInstallSchema = z.object({
  type: z.literal('conda'),
  artifacts: z.array(condaArtifactSchema).min(1).max(12)
}).strict();

const condaLockPackageSchema = z.object({
  url: z.string().url(),
  sha256: z.string().regex(SHA256_PATTERN),
  size: z.number().int().positive().max(MAX_CONDA_PACKAGE_BYTES)
}).strict().superRefine((pkg, ctx) => {
  if (!isHttpsUrl(pkg.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Conda package URLs must use HTTPS.' });
});
const condaLockSchema = z.object({
  schemaVersion: z.literal(1),
  subdir: z.enum(CONDA_SUBDIRS),
  packages: z.array(condaLockPackageSchema).min(1).max(MAX_CONDA_PACKAGES)
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
  install: z.union([binaryInstallSchema, bundleInstallSchema, condaInstallSchema]).optional(),
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
    let managedCommandSet = null;
    for (const [index, artifact] of manifest.install.artifacts.entries()) {
      const target = `${artifact.platform}/${artifact.arch}`;
      if (targets.has(target)) ctx.addIssue({ code: 'custom', path: ['install', 'artifacts', index], message: `Duplicate install artifact target '${target}'.` });
      targets.add(target);
      if (manifest.install.type !== 'bundle' && manifest.install.type !== 'conda') continue;
      const commands = new Set();
      for (const [commandIndex, entry] of artifact.commands.entries()) {
        const issuePath = ['install', 'artifacts', index, 'commands', commandIndex];
        if (!isSafeRelativePath(entry.path)) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'path'], message: 'Managed command paths must be safe relative paths.' });
        }
        const normalizedCommand = normalizeCommandName(entry.command);
        if (isSafeRelativePath(entry.path) && normalizeCommandName(path.basename(entry.path)) !== normalizedCommand) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'path'], message: `Managed command path must have the same executable name as '${entry.command}'.` });
        }
        if (RESERVED_MANAGED_COMMANDS.has(normalizedCommand)) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'command'], message: `Managed command '${entry.command}' is reserved.` });
        }
        if (commands.has(normalizedCommand)) {
          ctx.addIssue({ code: 'custom', path: [...issuePath, 'command'], message: `Duplicate managed command '${entry.command}'.` });
        }
        commands.add(normalizedCommand);
        if (!manifest.requires.commands.includes(entry.command)) {
          ctx.addIssue({ code: 'custom', path: ['requires', 'commands'], message: `Managed command '${entry.command}' must be listed in requires.commands.` });
        }
      }
      if (manifest.entrypoints.command && !artifact.commands.some(entry => entry.command === manifest.entrypoints.command)) {
        ctx.addIssue({ code: 'custom', path: ['entrypoints', 'command'], message: 'entrypoints.command must be provided by every managed artifact.' });
      }
      const currentSet = [...commands].sort().join('\n');
      if (managedCommandSet == null) managedCommandSet = currentSet;
      else if (managedCommandSet !== currentSet) {
        ctx.addIssue({ code: 'custom', path: ['install', 'artifacts', index, 'commands'], message: 'Managed artifacts must expose the same command names on every platform/architecture.' });
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

function condaSubdirForTarget(platform, arch) {
  if (platform === 'win32') return 'win-64';
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-64';
  return arch === 'arm64' ? 'linux-aarch64' : 'linux-64';
}

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

function listInstalledExtensions(config = {}, options = {}) {
  const recovery = recoverInterruptedExtensionInstalls(config);
  if (!recovery.ok) throw new Error(`Could not recover an interrupted extension installation: ${recovery.errors[0]?.error || 'unknown recovery error'}`);
  const root = extensionsRoot(config);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map(entry => readInstalledExtension(path.join(root, entry.name), entry.name, config, options))
    .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));
}

function readExtensionInstallMetadata(directory) {
  const metadataPath = path.join(directory, INSTALL_METADATA_FILENAME);
  try {
    const stat = fs.lstatSync(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return null;
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return metadata?.schemaVersion === 1 ? metadata : null;
  } catch {
    return null;
  }
}

function readInstalledExtension(directory, directoryName = path.basename(directory), config = {}, options = {}) {
  try {
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('Extension manifest is missing or unsafe.');
    }
    const manifestSignature = installedFileSignature(manifestStat);
    const cached = installedExtensionVerificationCache.get(directory);
    let manifest;
    if (cached?.manifestSignature === manifestSignature) {
      manifest = cached.manifest;
      incrementExtensionMetric(options.metrics, 'extensionManifestCacheHits');
    } else {
      manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
      incrementExtensionMetric(options.metrics, 'extensionManifestReads');
    }
    if (manifest.id !== directoryName) throw new Error(`Manifest id '${manifest.id}' does not match extension directory '${directoryName}'.`);
    const files = verifyInstalledFiles(directory, manifest, cached?.files, options.metrics);
    installedExtensionVerificationCache.set(directory, { manifestSignature, manifest, files });
    const readiness = extensionReadiness(manifest, config);
    const metadata = readExtensionInstallMetadata(directory) || {};
    const sourceCatalogUrl = String(metadata.catalogUrl || '');
    const localDevelopment = metadata.localDevelopment === true;
    const sourceId = String(metadata.sourceId || '') || (sourceCatalogUrl ? extensionSourceId(sourceCatalogUrl) : localDevelopment ? 'local-development' : '');
    return {
      ...publicManifest(manifest),
      ...readiness,
      sourceId,
      sourceCatalogUrl,
      sourceRepositoryUrl: String(metadata.repositoryUrl || ''),
      localDevelopment
    };
  } catch (error) {
    installedExtensionVerificationCache.delete(directory);
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

function extensionSkillRecords(config = {}, options = {}) {
  const root = extensionsRoot(config);
  return listInstalledExtensions(config, options).flatMap(extension => {
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
  const installed = listInstalledExtensions(config, options);
  const loaded = await loadExtensionCatalogSources(config, options);
  const sourceById = new Map(loaded.sources.map(source => [source.id, source]));
  const installedWithSource = installed.map(extension => {
    const source = sourceById.get(extension.sourceId);
    return {
      ...extension,
      sourceAvailable: extension.localDevelopment || Boolean(source && source.status === 'ready'),
      sourceName: source?.name || (extension.localDevelopment ? 'Local development' : ''),
      sourceRepositoryUrl: extension.sourceRepositoryUrl || source?.repositoryUrl || ''
    };
  });
  const installedById = new Map(installedWithSource.map(item => [item.id, item]));
  const available = loaded.entries.map(entry => {
    const current = installedById.get(entry.id);
    const sourceMatches = !current || (
      current.sourceCatalogUrl
        ? current.sourceCatalogUrl === entry.sourceCatalogUrl
        : !current.localDevelopment && entry.sourceOfficial === true
    );
    return {
      ...entry,
      installedVersion: current?.version || '',
      installed: Boolean(current?.version),
      sourceMismatch: Boolean(current?.version && !sourceMatches),
      updateAvailable: Boolean(current?.version && sourceMatches && semver.gt(entry.version, current.version))
    };
  });
  const sources = loaded.sources.map(source => ({
    ...source,
    installedCount: installedWithSource.filter(extension => extension.sourceId === source.id || (
      !extension.sourceId && extension.sourceCatalogUrl && extension.sourceCatalogUrl === source.catalogUrl
    )).length
  }));
  const official = sources.find(source => source.official) || officialExtensionSource(options);
  return {
    ok: true,
    catalogUrl: official.catalogUrl,
    installRoot: extensionsRoot(config),
    installed: installedWithSource,
    catalog: available,
    sources,
    catalogUpdatedAt: official.catalogUpdatedAt || '',
    catalogError: sources.filter(source => source.error).map(source => `${source.name}: ${source.error}`).join(' ')
  };
}

async function loadExtensionCatalogSources(config = {}, options = {}) {
  const descriptors = options.catalogUrl
    ? [{
        id: String(options.sourceId || '') || extensionSourceId(resolveCatalogUrl(options)),
        name: String(options.sourceName || '') || new URL(resolveCatalogUrl(options)).hostname,
        official: options.sourceId === 'official',
        repositoryUrl: String(options.repositoryUrl || ''),
        catalogUrl: resolveCatalogUrl(options)
      }]
    : [officialExtensionSource(options), ...configuredExtensionSources(config)];
  const claimed = new Map();
  const sources = [];
  const entries = [];

  for (const descriptor of descriptors) {
    let catalog;
    try {
      catalog = await fetchExtensionCatalog({ catalogUrl: descriptor.catalogUrl, refresh: options.refresh });
    } catch (error) {
      sources.push({ ...descriptor, status: 'error', error: errorMessage(error), extensionCount: 0, catalogUpdatedAt: '' });
      continue;
    }
    const conflicts = catalog.extensions.map(entry => entry.id).filter(id => claimed.has(id));
    if (conflicts.length) {
      sources.push({
        ...descriptor,
        status: 'conflict',
        error: `Duplicate extension id${conflicts.length === 1 ? '' : 's'} already provided by another active source: ${conflicts.join(', ')}.`,
        extensionCount: catalog.extensions.length,
        catalogUpdatedAt: catalog.updatedAt
      });
      continue;
    }
    for (const entry of catalog.extensions) claimed.set(entry.id, descriptor.id);
    const sourceEntries = catalog.extensions.map(entry => ({
      ...entry,
      sourceId: descriptor.id,
      sourceName: descriptor.name,
      sourceOfficial: descriptor.official === true,
      sourceRepositoryUrl: descriptor.repositoryUrl,
      sourceCatalogUrl: descriptor.catalogUrl
    }));
    entries.push(...sourceEntries);
    sources.push({
      ...descriptor,
      status: 'ready',
      error: '',
      extensionCount: sourceEntries.length,
      catalogUpdatedAt: catalog.updatedAt
    });
  }
  return { sources, entries };
}

async function validateExtensionSource(config = {}, input, options = {}) {
  const source = extensionSourceFromInput(input);
  const official = officialExtensionSource();
  if (source.catalogUrl === official.catalogUrl || source.repositoryUrl === official.repositoryUrl) {
    throw new Error('The official Rel.AI extension source is already built in.');
  }
  const configured = configuredExtensionSources(config);
  if (configured.some(item => item.catalogUrl === source.catalogUrl)) {
    throw new Error('This extension source is already added.');
  }
  const catalog = await fetchExtensionCatalog({ catalogUrl: source.catalogUrl, refresh: true });
  const loaded = await loadExtensionCatalogSources(config, { refresh: options.refresh === true });
  const existingIds = new Set(loaded.entries.map(entry => entry.id));
  const conflicts = catalog.extensions.map(entry => entry.id).filter(id => existingIds.has(id));
  if (conflicts.length) {
    throw new Error(`This source conflicts with active extension id${conflicts.length === 1 ? '' : 's'}: ${conflicts.join(', ')}.`);
  }
  return { ...source, status: 'ready', error: '', extensionCount: catalog.extensions.length, catalogUpdatedAt: catalog.updatedAt };
}

async function fetchExtensionCatalog(options = {}) {
  const url = resolveCatalogUrl(options);
  const now = Date.now();
  const cached = catalogCache.get(url);
  if (!options.refresh && cached?.expiresAt > now) return cached.value;
  const raw = await fetchJsonDocument(url, MAX_CATALOG_BYTES, 'extension catalog');
  const catalog = parseExtensionCatalog(raw);
  catalogCache.set(url, { value: catalog, expiresAt: now + CATALOG_TTL_MS });
  return catalog;
}

async function prepareManagedCommandInstall(config, manifest, extensionStaging) {
  if (manifest.kind !== 'cli' || !manifest.install) return null;
  const artifact = manifest.install.artifacts.find(item => item.platform === process.platform && item.arch === process.arch);
  if (!artifact) return null;
  if (manifest.install.type === 'bundle') {
    return await prepareManagedBundleInstall(config, manifest, artifact, extensionStaging);
  }
  if (manifest.install.type === 'conda') {
    return await prepareManagedCondaInstall(config, manifest, artifact, extensionStaging);
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

async function prepareManagedCondaInstall(config, manifest, artifact, extensionStaging) {
  const managed = artifact.commands
    .map(item => ({ item, disposition: managedCommandDisposition(config, manifest.id, item.command) }))
    .filter(item => item.disposition);
  if (!managed.length) return null;

  const manager = MICROMAMBA_ARTIFACTS[`${process.platform}/${process.arch}`];
  if (!manager) throw new Error(`Managed Conda installation is unavailable on ${process.platform}/${process.arch}.`);

  const lockContent = await fetchFile(artifact.lockUrl, MAX_CONDA_LOCK_BYTES, `Conda lock for ${manifest.id}`, { timeoutMs: 120_000 });
  const lockDigest = crypto.createHash('sha256').update(lockContent).digest('hex');
  if (lockDigest !== artifact.lockSha256) throw new Error(`Checksum mismatch for Conda lock for '${manifest.id}'.`);

  let lockRaw;
  try {
    lockRaw = JSON.parse(lockContent.toString('utf8'));
  } catch (error) {
    throw new Error(`Conda lock for '${manifest.id}' is not valid JSON.`, { cause: error });
  }
  const lock = condaLockSchema.parse(lockRaw);
  if (lock.subdir !== artifact.subdir) {
    throw new Error(`Conda lock subdir '${lock.subdir}' does not match manifest subdir '${artifact.subdir}'.`);
  }
  const totalBytes = lock.packages.reduce((sum, pkg) => sum + pkg.size, 0);
  if (totalBytes > MAX_CONDA_TOTAL_BYTES) throw new Error(`Conda lock for '${manifest.id}' exceeds the allowed total package size.`);

  const toolRoot = path.join(extensionStaging, '.tool');
  const downloadRoot = path.join(extensionStaging, '.conda-packages');
  const managerRoot = path.join(extensionStaging, '.conda-manager');
  const managerPath = path.join(managerRoot, process.platform === 'win32' ? 'micromamba.exe' : 'micromamba');
  const explicitPath = path.join(extensionStaging, '.conda-explicit.txt');
  fs.mkdirSync(downloadRoot, { recursive: true, mode: 0o700 });

  await downloadVerifiedFile(
    manager.url,
    32 * 1024 * 1024,
    'micromamba runtime',
    managerPath,
    manager.sha256,
    { timeoutMs: 180_000 }
  );
  if (process.platform !== 'win32') fs.chmodSync(managerPath, 0o700);

  const localPackages = [];
  for (const [index, pkg] of lock.packages.entries()) {
    const filename = path.basename(new URL(pkg.url).pathname);
    if (!filename) throw new Error(`Conda package ${index + 1} for '${manifest.id}' has no filename.`);
    const packagePath = path.join(downloadRoot, `${String(index).padStart(3, '0')}-${filename}`);
    await downloadVerifiedFile(
      pkg.url,
      Math.min(MAX_CONDA_PACKAGE_BYTES, Math.max(pkg.size, 1)),
      `Conda package ${index + 1} for ${manifest.id}`,
      packagePath,
      pkg.sha256,
      { timeoutMs: 15 * 60_000 }
    );
    const stat = fs.statSync(packagePath);
    if (stat.size !== pkg.size) throw new Error(`Conda package ${index + 1} for '${manifest.id}' has an unexpected size.`);
    localPackages.push(packagePath);
  }

  const explicit = ['@EXPLICIT', ...localPackages.map(packagePath => pathToFileURL(packagePath).href), ''].join('\n');
  fs.writeFileSync(explicitPath, explicit, { mode: 0o600 });
  await runMicromamba(managerPath, [
    'create',
    '--yes',
    '--offline',
    '--no-rc',
    '--root-prefix', path.join(extensionStaging, '.conda-root'),
    '--prefix', toolRoot,
    '--file', explicitPath
  ], { cwd: extensionStaging });

  for (const item of artifact.commands) {
    const commandPath = safeJoin(toolRoot, item.path);
    let stat;
    try { stat = fs.lstatSync(commandPath); } catch {
      throw new Error(`Conda command '${item.command}' is missing declared path '${item.path}'.`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Conda command '${item.command}' is not a safe regular file.`);
    }
    if (process.platform !== 'win32') fs.chmodSync(commandPath, stat.mode | 0o111);
  }

  fs.rmSync(downloadRoot, { recursive: true, force: true });
  fs.rmSync(managerRoot, { recursive: true, force: true });
  fs.rmSync(path.join(extensionStaging, '.conda-root'), { recursive: true, force: true });
  fs.rmSync(explicitPath, { force: true });

  const entries = managed.map(({ item }) => createManagedCommandTransactionEntry(config, manifest, item.command, {
    installType: 'bundle',
    sourceType: 'conda',
    relativePath: item.path,
    lockUrl: artifact.lockUrl,
    lockSha256: artifact.lockSha256,
    subdir: artifact.subdir
  }));
  return { entries, committed: false };
}

function runMicromamba(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MAMBA_NO_BANNER: '1',
        MAMBA_ROOT_PREFIX: path.join(options.cwd || process.cwd(), '.conda-root')
      }
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const maxOutputBytes = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Managed Conda installation timed out.'));
    }, CONDA_INSTALL_TIMEOUT_MS);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish(new Error('Managed Conda installation produced too much output.'));
        return current;
      }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => finish(new Error('Could not start the managed micromamba runtime.', { cause: error })));
    child.on('close', code => {
      if (code !== 0) {
        finish(new Error(`Managed Conda installation failed with exit code ${code}: ${(stderr || stdout).trim()}`));
        return;
      }
      finish();
    });
  });
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
  const { source, entry } = await resolveExtensionInstallSource(config, extensionId, options);
  const target = path.join(extensionsRoot(config), extensionId);
  if (fs.existsSync(target)) {
    const installedMetadata = readExtensionInstallMetadata(target);
    if (installedMetadata?.localDevelopment === true) {
      throw new Error(`Extension '${extensionId}' is installed from local development sources. Remove it before installing from a repository source.`);
    }
    const installedCatalogUrl = String(installedMetadata?.catalogUrl || '');
    if (!installedCatalogUrl) {
      throw new Error(`Extension '${extensionId}' has no recorded source. Remove it before installing from a repository source.`);
    }
    if (installedCatalogUrl !== source.catalogUrl) {
      throw new Error(`Extension '${extensionId}' is installed from a different source. Remove it before switching sources.`);
    }
  }
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
  assertInstallCompatibility(manifest, config);
  return await commitExtensionPackage(config, manifest, {
    metadata: {
      sourceId: source.id,
      repositoryUrl: source.repositoryUrl,
      manifestUrl: entry.manifestUrl,
      catalogUrl: source.catalogUrl
    },
    readFile: file => {
      const fileUrl = new URL(file.path.replaceAll('\\', '/'), entry.manifestUrl).href;
      return fetchFile(fileUrl, MAX_EXTENSION_FILE_BYTES, `extension file ${file.path}`);
    }
  });
}

async function resolveExtensionInstallSource(config, extensionId, options = {}) {
  if (options.catalogUrl) {
    const catalogUrl = resolveCatalogUrl(options);
    const source = {
      id: String(options.sourceId || '') || extensionSourceId(catalogUrl),
      name: String(options.sourceName || '') || new URL(catalogUrl).hostname,
      official: options.sourceId === 'official',
      repositoryUrl: String(options.repositoryUrl || ''),
      catalogUrl
    };
    const catalog = await fetchExtensionCatalog({ catalogUrl, refresh: true });
    const entry = catalog.extensions.find(item => item.id === extensionId);
    if (!entry) throw new Error(`Extension '${extensionId}' is not in the selected Rel.AI extension source.`);
    return { source, entry };
  }

  const descriptors = [officialExtensionSource(), ...configuredExtensionSources(config)];
  if (options.sourceId) {
    const source = descriptors.find(item => item.id === options.sourceId);
    if (!source) throw new Error('The selected extension source is no longer configured.');
    const catalog = await fetchExtensionCatalog({ catalogUrl: source.catalogUrl, refresh: true });
    const entry = catalog.extensions.find(item => item.id === extensionId);
    if (!entry) throw new Error(`Extension '${extensionId}' is not available from the selected source.`);
    return { source, entry };
  }

  const loaded = await loadExtensionCatalogSources(config, { refresh: true });
  const entry = loaded.entries.find(item => item.id === extensionId);
  if (!entry) throw new Error(`Extension '${extensionId}' is not available from any active Rel.AI extension source.`);
  const source = loaded.sources.find(item => item.id === entry.sourceId);
  if (!source || source.status !== 'ready') throw new Error(`The source for extension '${extensionId}' is unavailable.`);
  return { source, entry };
}

async function installLocalExtension(config, extensionDirectory) {
  const source = path.resolve(String(extensionDirectory || ''));
  let sourceStat;
  try { sourceStat = fs.lstatSync(source); }
  catch { throw new Error(`Local extension directory does not exist: ${source}`); }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('Local extension source must be a normal directory, not a symlink.');
  }
  const sourceRoot = fs.realpathSync(source);
  const managedRoot = path.resolve(extensionsRoot(config));
  const managedRelative = path.relative(managedRoot, sourceRoot);
  if (!managedRelative || (!managedRelative.startsWith('..') && !path.isAbsolute(managedRelative))) {
    throw new Error('Local development source must be outside Rel.AI managed extension storage.');
  }
  const manifestPath = path.join(sourceRoot, MANIFEST_FILENAME);
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('Local extension manifest is missing or unsafe.');
  }
  const manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  assertInstallCompatibility(manifest, config);
  return await commitExtensionPackage(config, manifest, {
    metadata: {
      localDevelopment: true,
      sourceDirectory: sourceRoot
    },
    readFile: file => readLocalPackageFile(sourceRoot, file)
  });
}

function assertInstallCompatibility(manifest, config) {
  const readiness = extensionReadiness(manifest, config);
  if (!semver.satisfies(String(getApplicationMetadata()?.version || '0.0.0'), manifest.compatibility.relai, { includePrerelease: true })) {
    throw new Error(readiness.error || 'This extension is not compatible with the installed Rel.AI version.');
  }
  if (manifest.requires.platforms.length && !manifest.requires.platforms.includes(process.platform)) {
    throw new Error(readiness.error || 'This extension does not support this platform.');
  }
}

async function commitExtensionPackage(config, manifest, options) {
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
      const content = Buffer.from(await options.readFile(file));
      totalBytes += content.length;
      if (content.length > MAX_EXTENSION_FILE_BYTES || totalBytes > MAX_EXTENSION_TOTAL_BYTES) {
        throw new Error('Extension package exceeds the allowed size.');
      }
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (digest !== file.sha256) throw new Error(`Checksum mismatch for extension file '${file.path}'.`);
      const destination = safeJoin(staging, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, content, { mode: 0o600 });
    }
    fs.writeFileSync(path.join(staging, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(staging, INSTALL_METADATA_FILENAME), `${JSON.stringify({
      schemaVersion: 1,
      ...(options.metadata || {}),
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
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rollbackManagedCommandInstall(managedInstall);
    if (packageCommitted) fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    completeExtensionInstallTransaction(config, manifest.id);
    throw error;
  }
  try {
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    finalizeManagedCommandInstall(managedInstall);
    completeExtensionInstallTransaction(config, manifest.id);
  } catch {
    // The committed package must survive cleanup failures. Keep the committed
    // transaction marker so recovery can retry removing obsolete files.
  }
  installedExtensionVerificationCache.delete(target);
  return readInstalledExtension(target, manifest.id, config);
}

function readLocalPackageFile(sourceRoot, file) {
  const target = safeJoin(sourceRoot, file.path);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXTENSION_FILE_BYTES) {
    throw new Error(`Local extension file '${file.path}' is missing or unsafe.`);
  }
  const realTarget = fs.realpathSync(target);
  const relative = path.relative(sourceRoot, realTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Local extension file '${file.path}' escapes the extension directory.`);
  }
  const bytes = fs.readFileSync(realTarget);
  if (bytes.includes(0)) return bytes;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return bytes;
  return Buffer.from(text.replaceAll('\r\n', '\n'), 'utf8');
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
  installedExtensionVerificationCache.delete(target);
  return { ok: true, id: extensionId, removed: true, removedCommands };
}

function verifyInstalledFiles(directory, manifest, cachedFiles = new Map(), metrics) {
  const nextFiles = new Map();
  for (const file of manifest.files) {
    const target = safeJoin(directory, file.path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EXTENSION_FILE_BYTES) {
      throw new Error(`Extension file '${file.path}' is missing or unsafe.`);
    }
    const signature = installedFileSignature(stat);
    const cached = cachedFiles instanceof Map ? cachedFiles.get(file.path) : null;
    if (cached?.signature === signature && cached?.sha256 === file.sha256) {
      incrementExtensionMetric(metrics, 'extensionFileVerificationCacheHits');
      nextFiles.set(file.path, cached);
      continue;
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    incrementExtensionMetric(metrics, 'extensionFileHashReads');
    if (digest !== file.sha256) throw new Error(`Installed extension file '${file.path}' failed checksum verification.`);
    nextFiles.set(file.path, { signature, sha256: file.sha256 });
  }
  return nextFiles;
}

function installedFileSignature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function incrementExtensionMetric(metrics, key) {
  if (!metrics || typeof metrics !== 'object') return;
  metrics[key] = Number(metrics[key] || 0) + 1;
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
    autoInstall: Boolean(manifest.install),
    installType: manifest.install?.type || null,
    files: Array.isArray(manifest.files) ? manifest.files.map(file => ({ path: file.path, sha256: file.sha256 })) : []
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

function officialExtensionSource(options = {}) {
  return {
    id: 'official',
    name: 'Rel.AI Extensions',
    official: true,
    repositoryUrl: OFFICIAL_EXTENSION_REPOSITORY_URL,
    catalogUrl: resolveCatalogUrl(options)
  };
}

function configuredExtensionSources(config = {}) {
  const sources = Array.isArray(config?.extensions?.sources) ? config.extensions.sources : [];
  const seen = new Set();
  const normalized = [];
  for (const item of sources) {
    try {
      const source = normalizeExtensionSourceRecord(item);
      if (!source.catalogUrl || source.catalogUrl === CATALOG_URL || seen.has(source.catalogUrl)) continue;
      seen.add(source.catalogUrl);
      normalized.push(source);
    } catch {}
  }
  return normalized;
}

function extensionSourceFromInput(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Repository URL is required.');
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error('Enter a valid HTTPS repository or catalog URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Extension sources must use HTTPS and cannot contain embedded credentials.');
  }
  parsed.hash = '';
  if (parsed.hostname.toLowerCase() === 'github.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) throw new Error('Enter the GitHub repository URL itself, without a branch, file, or subfolder path.');
    const owner = parts[0];
    const repositoryName = parts[1].replace(/\.git$/i, '');
    const repositoryUrl = `https://github.com/${owner}/${repositoryName}`;
    const catalogUrl = `https://raw.githubusercontent.com/${owner}/${repositoryName}/main/${PUBLISHER_CATALOG_FILENAME}`;
    return {
      id: extensionSourceId(catalogUrl),
      name: `${owner}/${repositoryName}`,
      official: false,
      repositoryUrl,
      catalogUrl
    };
  }
  if (!parsed.pathname.toLowerCase().endsWith('.json')) {
    throw new Error(`Non-GitHub sources must point directly to an HTTPS ${PUBLISHER_CATALOG_FILENAME} file.`);
  }
  const catalogUrl = parsed.href;
  return {
    id: extensionSourceId(catalogUrl),
    name: parsed.hostname,
    official: false,
    repositoryUrl: '',
    catalogUrl
  };
}

function normalizeExtensionSourceRecord(record = {}) {
  const catalogUrl = normalizeHttpsSourceUrl(record.catalogUrl, 'catalog URL');
  const repositoryUrl = String(record.repositoryUrl || '').trim()
    ? normalizeHttpsSourceUrl(record.repositoryUrl, 'repository URL')
    : '';
  return {
    id: extensionSourceId(catalogUrl),
    name: repositoryUrl ? sourceDisplayName(repositoryUrl) : new URL(catalogUrl).hostname,
    official: false,
    repositoryUrl,
    catalogUrl
  };
}

function extensionSourceId(catalogUrl) {
  const normalized = String(catalogUrl || '').trim();
  if (normalized === CATALOG_URL) return 'official';
  return `source_${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function sourceDisplayName(repositoryUrl) {
  try {
    const parsed = new URL(repositoryUrl);
    if (parsed.hostname.toLowerCase() === 'github.com') {
      return parsed.pathname.split('/').filter(Boolean).slice(0, 2).join('/') || parsed.hostname;
    }
    return parsed.hostname;
  } catch {
    return repositoryUrl;
  }
}

function normalizeHttpsSourceUrl(value, label) {
  const text = String(value || '').trim();
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`Extension source ${label} is invalid.`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`Extension source ${label} must use HTTPS without embedded credentials.`);
  }
  parsed.hash = '';
  return parsed.href;
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
        const stat = process.platform === 'win32' ? fs.lstatSync(candidate) : fs.statSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
        return true;
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
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (process.platform !== 'win32') fs.accessSync(target, fs.constants.X_OK);
    return true;
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
  MAX_EXTENSION_FILE_BYTES,
  MAX_EXTENSION_TOTAL_BYTES,
  PERMISSIONS,
  configuredExtensionSources,
  extensionCatalogSchema,
  extensionDashboard,
  extensionManifestSchema,
  extensionSkillRecords,
  extensionSourceId,
  extensionsRoot,
  fetchExtensionCatalog,
  installExtension,
  installLocalExtension,
  listInstalledExtensions,
  parseExtensionCatalog,
  parseExtensionManifest,
  removeExtension,
  validateExtensionSource
};
