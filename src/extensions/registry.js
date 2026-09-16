import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { getApplicationMetadata } from '../appMetadata.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/Kyne0328/rel-ai-extensions/main/catalog.json';
const MANIFEST_FILENAME = 'relai-extension.json';
const INSTALL_METADATA_FILENAME = '.relai-install.json';
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_EXTENSION_FILE_BYTES = 1024 * 1024;
const MAX_EXTENSION_TOTAL_BYTES = 8 * 1024 * 1024;
const CATALOG_TTL_MS = 5 * 60 * 1000;
const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,79}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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
  const root = extensionsRoot(config);
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map(entry => readInstalledExtension(path.join(root, entry.name), entry.name))
    .sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id)));
}

function readInstalledExtension(directory, directoryName = path.basename(directory)) {
  try {
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error('Extension manifest is missing or unsafe.');
    }
    const manifest = parseExtensionManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (manifest.id !== directoryName) throw new Error(`Manifest id '${manifest.id}' does not match extension directory '${directoryName}'.`);
    verifyInstalledFiles(directory, manifest);
    const readiness = extensionReadiness(manifest);
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

function extensionReadiness(manifest) {
  const appVersion = String(getApplicationMetadata()?.version || '0.0.0');
  const reasons = [];
  if (!semver.satisfies(appVersion, manifest.compatibility.relai, { includePrerelease: true })) {
    reasons.push(`Requires Rel.AI ${manifest.compatibility.relai}; installed version is ${appVersion}.`);
  }
  if (manifest.requires.platforms.length && !manifest.requires.platforms.includes(process.platform)) {
    reasons.push(`Supports ${manifest.requires.platforms.join(', ')}; this computer is ${process.platform}.`);
  }
  const missingCommands = manifest.requires.commands.filter(command => !commandAvailable(command));
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

async function installExtension(config, id, options = {}) {
  const extensionId = normalizeExtensionId(id);
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
  const readiness = extensionReadiness(manifest);
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
  let totalBytes = 0;
  try {
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
      installedAt: new Date().toISOString()
    }, null, 2)}\n`, { mode: 0o600 });
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(staging, target);
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
  return readInstalledExtension(target, manifest.id);
}

function removeExtension(config, id) {
  const extensionId = normalizeExtensionId(id);
  const root = extensionsRoot(config);
  const target = path.join(root, extensionId);
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { ok: true, id: extensionId, removed: false }; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Refusing to remove an unsafe extension path.');
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { ok: true, id: extensionId, removed: true };
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
    entrypoints: manifest.entrypoints
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

async function fetchFile(url, maxBytes, label) {
  if (!isHttpsUrl(url)) throw new Error(`The ${label} URL must use HTTPS.`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
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

function commandAvailable(command) {
  const name = String(command || '').trim();
  if (!name) return false;
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' && path.extname(name) ? name : `${name}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile()) return true;
      } catch {}
    }
  }
  return false;
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
