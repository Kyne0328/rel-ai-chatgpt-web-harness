import { isUtf8 } from 'node:buffer';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  MAX_EXTENSION_FILE_BYTES,
  MAX_EXTENSION_TOTAL_BYTES,
  extensionCatalogSchema,
  parseExtensionManifest
} from './registry.js';

const PUBLISHER_CONFIG_FILENAME = 'relai-publisher.json';
const PUBLISHER_CATALOG_FILENAME = 'publisher-catalog.json';
const EXTENSIONS_DIRECTORY = 'extensions';
const MANIFEST_FILENAME = 'relai-extension.json';
const EXTENSION_GITATTRIBUTES_RULE = 'extensions/** text=auto eol=lf';
const NAMESPACE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXTENSION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const publisherConfigSchema = z.object({
  schemaVersion: z.literal(1),
  namespace: z.string().min(1).max(40).regex(NAMESPACE_PATTERN),
  publisher: z.object({
    name: z.string().min(1).max(100),
    url: z.string().url().optional()
  }).strict(),
  repository: z.string().url(),
  rawBaseUrl: z.string().url()
}).strict().superRefine((config, ctx) => {
  if (!isHttpsUrl(config.repository)) {
    ctx.addIssue({ code: 'custom', path: ['repository'], message: 'repository must use HTTPS.' });
  }
  if (!isHttpsUrl(config.rawBaseUrl)) {
    ctx.addIssue({ code: 'custom', path: ['rawBaseUrl'], message: 'rawBaseUrl must use HTTPS.' });
  }
});

function initializePublisherRepository(repositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot || '.');
  fs.mkdirSync(root, { recursive: true });
  const configPath = path.join(root, PUBLISHER_CONFIG_FILENAME);
  if (fs.existsSync(configPath) && options.force !== true) {
    throw new Error(`${PUBLISHER_CONFIG_FILENAME} already exists. Use --force to replace publisher metadata.`);
  }

  const repository = normalizeHttpsUrl(options.repository, 'repository');
  const rawBaseUrl = normalizeHttpsUrl(
    options.rawBaseUrl || deriveGithubRawBaseUrl(repository, options.branch || 'main'),
    'rawBaseUrl'
  );
  const publisher = {
    name: String(options.publisherName || '').trim(),
    ...(String(options.publisherUrl || '').trim() ? { url: normalizeUrl(options.publisherUrl, 'publisherUrl') } : {})
  };
  const config = publisherConfigSchema.parse({
    schemaVersion: 1,
    namespace: String(options.namespace || '').trim().toLowerCase(),
    publisher,
    repository,
    rawBaseUrl
  });

  writeJson(configPath, config);
  ensurePublisherGitAttributes(root);
  fs.mkdirSync(path.join(root, EXTENSIONS_DIRECTORY), { recursive: true });
  const synced = syncPublisherRepository(root);
  return { root, config, catalog: synced.catalog };
}

function createPublisherExtension(repositoryRoot, slug, options = {}) {
  const root = path.resolve(repositoryRoot || '.');
  const config = readPublisherConfig(root);
  const normalizedSlug = normalizeExtensionSlug(slug);
  const directory = path.join(root, EXTENSIONS_DIRECTORY, normalizedSlug);
  if (fs.existsSync(directory)) throw new Error(`Extension '${normalizedSlug}' already exists.`);

  const kind = String(options.kind || 'skill').trim().toLowerCase();
  if (!['skill', 'cli'].includes(kind)) throw new Error("Extension kind must be 'skill' or 'cli'.");
  const command = String(options.command || '').trim();
  if (kind === 'cli' && !command) throw new Error('CLI extensions require --command <name>.');

  const id = `${config.namespace}.${normalizedSlug}`;
  if (id.length > 80) throw new Error('Namespaced extension ids must be 80 characters or fewer.');
  const name = String(options.name || titleFromSlug(normalizedSlug)).trim();
  const description = String(
    options.description || `${name} workflows and local tooling for Rel.AI extension users.`
  ).trim();
  fs.mkdirSync(directory, { recursive: false });

  const skill = `---
name: ${normalizedSlug}
description: ${description.replaceAll('\n', ' ')}
---

# ${name}

Use this extension when its declared Rel.AI workflow or local tool capability is relevant.
`;
  fs.writeFileSync(path.join(directory, 'SKILL.md'), skill, 'utf8');

  const manifest = {
    schemaVersion: 1,
    id,
    name,
    version: '1.0.0',
    description,
    kind,
    compatibility: { relai: '>=1.0.0 <2.0.0' },
    publisher: config.publisher,
    repository: config.repository,
    permissions: kind === 'cli' ? ['workspace.read', 'command.execute'] : ['workspace.read'],
    requires: {
      commands: kind === 'cli' ? [command] : [],
      platforms: []
    },
    entrypoints: {
      skill: 'SKILL.md',
      ...(kind === 'cli' ? { command } : {})
    },
    files: [{ path: 'SKILL.md', sha256: packageFileSha256(path.join(directory, 'SKILL.md')) }]
  };
  parseExtensionManifest(manifest);
  writeJson(path.join(directory, MANIFEST_FILENAME), manifest);

  const synced = syncPublisherRepository(root);
  return {
    root,
    directory,
    id,
    manifest: synced.manifests.find(item => item.id === id),
    catalog: synced.catalog
  };
}

function syncPublisherRepository(repositoryRoot) {
  const root = path.resolve(repositoryRoot || '.');
  const config = readPublisherConfig(root);
  const manifests = [];
  const entries = [];

  for (const directoryName of listExtensionDirectories(root)) {
    const directory = path.join(root, EXTENSIONS_DIRECTORY, directoryName);
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Extension directory '${directoryName}' is missing ${MANIFEST_FILENAME}.`);
    }
    const current = readJson(manifestPath, MANIFEST_FILENAME);
    const expectedId = `${config.namespace}.${directoryName}`;
    if (String(current.id || '') !== expectedId) {
      throw new Error(`Extension directory '${directoryName}' must use id '${expectedId}'.`);
    }

    const files = collectPackageFiles(directory).map(file => ({
      path: file.relative,
      sha256: packageFileSha256(file.absolute)
    }));
    if (!files.length) throw new Error(`Extension '${current.id}' has no package files.`);

    const candidate = {
      ...current,
      publisher: config.publisher,
      repository: config.repository,
      files
    };
    const manifest = parseExtensionManifest(candidate);
    writeJson(manifestPath, manifest);
    manifests.push(manifest);
    entries.push(catalogEntryForManifest(config, directoryName, manifest));
  }

  const catalog = extensionCatalogSchema.parse({
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    extensions: entries.sort((left, right) => compareText(left.id, right.id))
  });
  writeJson(path.join(root, PUBLISHER_CATALOG_FILENAME), catalog);
  return { root, config, manifests, catalog };
}

function validatePublisherRepository(repositoryRoot) {
  const root = path.resolve(repositoryRoot || '.');
  const errors = [];
  let config;
  try {
    config = readPublisherConfig(root);
  } catch (error) {
    return { ok: false, root, errors: [errorMessage(error)], extensions: [] };
  }

  const extensions = [];
  const expectedEntries = [];
  for (const directoryName of listExtensionDirectories(root)) {
    const directory = path.join(root, EXTENSIONS_DIRECTORY, directoryName);
    const manifestPath = path.join(directory, MANIFEST_FILENAME);
    try {
      if (!fs.existsSync(manifestPath)) throw new Error(`Missing ${MANIFEST_FILENAME}.`);
      const manifest = parseExtensionManifest(readJson(manifestPath, MANIFEST_FILENAME));
      const expectedId = `${config.namespace}.${directoryName}`;
      if (manifest.id !== expectedId) {
        throw new Error(`Manifest id must be '${expectedId}', got '${manifest.id}'.`);
      }
      if (JSON.stringify(manifest.publisher) !== JSON.stringify(config.publisher)) {
        throw new Error(`Publisher metadata differs from ${PUBLISHER_CONFIG_FILENAME}; run relai-extension sync.`);
      }
      if (manifest.repository !== config.repository) {
        throw new Error(`Repository URL differs from ${PUBLISHER_CONFIG_FILENAME}; run relai-extension sync.`);
      }

      const discovered = collectPackageFiles(directory);
      const declared = [...manifest.files].sort((left, right) => compareText(left.path, right.path));
      if (discovered.length !== declared.length) {
        throw new Error('Package file list is stale; run relai-extension sync.');
      }
      for (let index = 0; index < discovered.length; index += 1) {
        const file = discovered[index];
        const declaration = declared[index];
        if (file.relative !== declaration.path || packageFileSha256(file.absolute) !== declaration.sha256) {
          throw new Error(`Package hash/list is stale for '${file.relative}'; run relai-extension sync.`);
        }
      }

      extensions.push(manifest.id);
      expectedEntries.push(catalogEntryForManifest(config, directoryName, manifest));
    } catch (error) {
      errors.push(`${directoryName}: ${errorMessage(error)}`);
    }
  }

  try {
    const catalogPath = path.join(root, PUBLISHER_CATALOG_FILENAME);
    if (!fs.existsSync(catalogPath)) {
      throw new Error(`Missing ${PUBLISHER_CATALOG_FILENAME}; run relai-extension sync.`);
    }
    const catalog = extensionCatalogSchema.parse(readJson(catalogPath, PUBLISHER_CATALOG_FILENAME));
    const actual = [...catalog.extensions].sort((left, right) => compareText(left.id, right.id));
    const expected = expectedEntries.sort((left, right) => compareText(left.id, right.id));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${PUBLISHER_CATALOG_FILENAME} is stale; run relai-extension sync.`);
    }
  } catch (error) {
    errors.push(errorMessage(error));
  }

  return { ok: errors.length === 0, root, errors, extensions: extensions.sort(compareText) };
}

function readPublisherConfig(repositoryRoot) {
  const root = path.resolve(repositoryRoot || '.');
  const configPath = path.join(root, PUBLISHER_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing ${PUBLISHER_CONFIG_FILENAME}. Run relai-extension init first.`);
  }
  return publisherConfigSchema.parse(readJson(configPath, PUBLISHER_CONFIG_FILENAME));
}

function listExtensionDirectories(repositoryRoot) {
  const extensionsRoot = path.join(repositoryRoot, EXTENSIONS_DIRECTORY);
  let entries;
  try {
    entries = fs.readdirSync(extensionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
    .map(entry => normalizeExtensionSlug(entry.name))
    .sort(compareText);
}

function collectPackageFiles(extensionRoot) {
  const files = [];
  let totalBytes = 0;
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in extension packages: ${path.relative(extensionRoot, absolute)}`);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(extensionRoot, absolute).replaceAll('\\', '/');
      if (relative === MANIFEST_FILENAME) continue;
      const size = fs.statSync(absolute).size;
      if (size > MAX_EXTENSION_FILE_BYTES) {
        throw new Error(`Extension package file '${relative}' exceeds the ${MAX_EXTENSION_FILE_BYTES}-byte limit.`);
      }
      totalBytes += size;
      if (totalBytes > MAX_EXTENSION_TOTAL_BYTES) {
        throw new Error(`Extension package exceeds the ${MAX_EXTENSION_TOTAL_BYTES}-byte total size limit.`);
      }
      files.push({ absolute, relative });
    }
  };
  visit(extensionRoot);
  return files.sort((left, right) => compareText(left.relative, right.relative));
}

function catalogEntryForManifest(config, directoryName, manifest) {
  const base = ensureTrailingSlash(config.rawBaseUrl);
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    kind: manifest.kind,
    manifestUrl: new URL(
      `${EXTENSIONS_DIRECTORY}/${directoryName}/${MANIFEST_FILENAME}`,
      base
    ).href,
    repository: manifest.repository,
    publisher: manifest.publisher.name,
    permissions: manifest.permissions,
    autoInstall: Boolean(manifest.install),
    featured: false
  };
}

function deriveGithubRawBaseUrl(repository, branch = 'main') {
  const parsed = new URL(repository);
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    throw new Error('Non-GitHub publisher repositories must provide --raw-base-url.');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub repository URL must include owner and repository.');
  const owner = parts[0];
  const repositoryName = parts[1].replace(/\.git$/i, '');
  const branchPath = String(branch || 'main').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${owner}/${repositoryName}/${branchPath}`;
}

function normalizeExtensionSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!EXTENSION_SLUG_PATTERN.test(slug) || slug.length > 79) {
    throw new Error('Extension names must use at most 79 lowercase letters, numbers, and single hyphens.');
  }
  return slug;
}

function titleFromSlug(slug) {
  return slug.split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function ensurePublisherGitAttributes(repositoryRoot) {
  const attributesPath = path.join(repositoryRoot, '.gitattributes');
  let current = '';
  try { current = fs.readFileSync(attributesPath, 'utf8'); } catch {}
  const lines = current.split(/\r?\n/).map(line => line.trim());
  if (lines.includes(EXTENSION_GITATTRIBUTES_RULE)) return;
  const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
  fs.writeFileSync(attributesPath, `${prefix}${EXTENSION_GITATTRIBUTES_RULE}\n`, 'utf8');
}

function packageFileSha256(file) {
  const bytes = fs.readFileSync(file);
  const packageBytes = !bytes.includes(0) && isUtf8(bytes)
    ? Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8')
    : bytes;
  return crypto.createHash('sha256').update(packageBytes).digest('hex');
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeHttpsUrl(value, label) {
  const url = normalizeUrl(value, label);
  if (!isHttpsUrl(url)) throw new Error(`${label} must use HTTPS.`);
  return url.replace(/\/$/, '');
}

function normalizeUrl(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required.`);
  try {
    return new URL(text).href.replace(/\/$/, '');
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}

function errorMessage(error) {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join(' ');
  }
  return error instanceof Error ? error.message : String(error || 'Unknown extension authoring error');
}

export {
  EXTENSIONS_DIRECTORY,
  PUBLISHER_CATALOG_FILENAME,
  PUBLISHER_CONFIG_FILENAME,
  createPublisherExtension,
  initializePublisherRepository,
  normalizeExtensionSlug,
  publisherConfigSchema,
  readPublisherConfig,
  syncPublisherRepository,
  validatePublisherRepository
};
