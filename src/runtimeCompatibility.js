'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MCP_PROTOCOL_VERSION } from './mcp/protocol.js';
import { packageMetadata as pkg } from './packageMetadata.js';
import { getVersion } from './version.js';
import { getToolSurfaceManifest } from './tools/schema.js';
import { allWorkspaceAliases, resolveWorkspace } from './config.js';
import { buildToolManifest } from './mcp/toolManifest.js';
import semver from 'semver';
import { assessSourceParity, cachedRepositoryBuildState, runtimeBuildIdentity } from './runtimeBuildIdentity.js';

const PROTOCOL_VERSION = MCP_PROTOCOL_VERSION;
const MAX_REPOSITORY_METADATA_CACHE = 64;
let runtimeMetadataCache = null;
const repositoryMetadataCache = new Map();

function runtimeMetadata() {
  const surface = getToolSurfaceManifest();
  const applicationVersion = getVersion();
  const revision = `${applicationVersion}\0${surface.schemaVersion}\0${surface.toolSurfaceVersion}\0${surface.toolCount}`;
  if (runtimeMetadataCache?.revision === revision) return runtimeMetadataCache.value;
  const manifest = buildToolManifest();
  const value = Object.freeze(normalizeMetadata({
    source: 'runtime',
    applicationVersion,
    packageVersion: pkg.version,
    protocolVersion: PROTOCOL_VERSION,
    toolSurfaceVersion: surface.toolSurfaceVersion,
    toolCount: manifest.activeToolCount,
    manifestHash: manifest.version,
    schemaVersion: manifest.schemaVersion,
    buildIdentity: runtimeBuildIdentity(manifest.hash)
  }));
  runtimeMetadataCache = { revision, value };
  return value;
}

function repositoryMetadata(config, preferredWorkspace = '') {
  const candidates = repositoryCandidates(config, preferredWorkspace);
  for (const candidate of candidates) {
    const metadata = readRepositoryMetadata(candidate.path, candidate.alias);
    if (metadata) return metadata;
  }
  return null;
}

function repositoryCandidates(config, preferredWorkspace) {
  const aliases = [];
  if (preferredWorkspace) aliases.push(String(preferredWorkspace));
  aliases.push(...allWorkspaceAliases(config));
  const seen = new Set();
  const values = [];
  for (const alias of aliases) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    try {
      const workspace = resolveWorkspace(config, alias);
      values.push({ alias: workspace.alias, path: workspace.path });
    } catch {}
  }
  return values;
}

function readRepositoryMetadata(root, alias = '') {
  const packagePath = path.join(root, 'package.json');
  const releasePath = path.join(root, 'release-manifest.json');
  const revision = repositoryFilesRevision(packagePath, releasePath);
  const cacheKey = path.resolve(root);
  const cached = repositoryMetadataCache.get(cacheKey);
  if (cached?.revision === revision) return cached.value ? { ...cached.value, workspace: alias } : null;

  let value = null;
  try {
    const packageValue = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (packageValue.name === pkg.name) {
      const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
      value = Object.freeze(normalizeMetadata({
        source: 'repository',
        workspace: '',
        root,
        applicationVersion: release.applicationVersion || packageValue.version,
        packageVersion: packageValue.version,
        protocolVersion: release.protocolVersion,
        toolSurfaceVersion: release.toolSurfaceVersion,
        toolCount: release.toolCount,
        manifestHash: release.manifestHash,
        schemaVersion: release.schemaVersion,
        releaseManifestPath: releasePath
      }));
    }
  } catch {
    return null;
  }

  rememberRepositoryMetadata(cacheKey, revision, value);
  return value ? { ...value, workspace: alias } : null;
}

function repositoryFilesRevision(...files) {
  return files.map(file => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      return `missing:${String(error?.code || '')}`;
    }
  }).join('|');
}

function rememberRepositoryMetadata(key, revision, value) {
  if (repositoryMetadataCache.has(key)) repositoryMetadataCache.delete(key);
  repositoryMetadataCache.set(key, { revision, value });
  while (repositoryMetadataCache.size > MAX_REPOSITORY_METADATA_CACHE) {
    repositoryMetadataCache.delete(repositoryMetadataCache.keys().next().value);
  }
}

function assessRuntimeCompatibility(runtime, repository, options = {}) {
  const activeTaskCount = Math.max(0, Number(options.activeTaskCount || 0));
  const sourceParity = assessSourceParity(runtime.buildIdentity, options.repositoryBuildState ?? cachedRepositoryBuildState(repository?.root));
  if (!repository) {
    return {
      available: false,
      status: 'repository_unavailable',
      compatible: true,
      metadataMatches: null,
      releaseMetadataMatches: null,
      sourceParity,
      restartRequired: false,
      schemaSensitiveOperationsBlocked: false,
      advisoryOnly: true,
      activeTaskCount,
      activeTasksPreventRestart: false,
      message: 'Repository release metadata is unavailable; runtime compatibility could not be compared.'
    };
  }

  const differences = [];
  compareField(differences, 'applicationVersion', runtime.applicationVersion, repository.applicationVersion);
  compareField(differences, 'packageVersion', runtime.packageVersion, repository.packageVersion);
  compareField(differences, 'protocolVersion', runtime.protocolVersion, repository.protocolVersion);
  compareField(differences, 'toolSurfaceVersion', runtime.toolSurfaceVersion, repository.toolSurfaceVersion);
  compareField(differences, 'toolCount', runtime.toolCount, repository.toolCount);
  compareField(differences, 'manifestHash', runtime.manifestHash, repository.manifestHash);
  compareField(differences, 'schemaVersion', runtime.schemaVersion, repository.schemaVersion);

  if (differences.length === 0) {
    return {
      available: true,
      status: 'compatible',
      compatible: true,
      metadataMatches: true,
      releaseMetadataMatches: true,
      sourceParity,
      restartRequired: false,
      schemaSensitiveOperationsBlocked: false,
      advisoryOnly: true,
      activeTaskCount,
      activeTasksPreventRestart: false,
      differences: [],
      message: `The connected runtime matches the repository release metadata. Source/build parity is ${sourceParity.status}.`
    };
  }

  const order = compareVersions(runtime.applicationVersion, repository.applicationVersion);
  const repositoryAhead = order < 0 || Number(runtime.toolSurfaceVersion) < Number(repository.toolSurfaceVersion);
  const runtimeAhead = order > 0 || Number(runtime.toolSurfaceVersion) > Number(repository.toolSurfaceVersion);
  const restartRequired = repositoryAhead;
  const status = repositoryAhead ? 'restart_required' : runtimeAhead ? 'runtime_newer' : 'incompatible';
  return {
    available: true,
    status,
    // `compatible` describes whether callers may safely keep using this runtime.
    // The exact release comparison is reported separately so an advisory version
    // skew cannot be mistaken for a tool-call boundary by connector clients.
    compatible: true,
    metadataMatches: false,
    releaseMetadataMatches: false,
    sourceParity,
    restartRequired,
    schemaSensitiveOperationsBlocked: false,
    advisoryOnly: true,
    activeTaskCount,
    activeTasksPreventRestart: restartRequired && activeTaskCount > 0,
    differences,
    message: restartRequired
      ? activeTaskCount > 0
        ? 'The runtime remains operationally compatible. The repository contains a newer runtime or tool surface; finish active work before restarting when convenient.'
        : 'The runtime remains operationally compatible. The repository contains a newer runtime or tool surface; restart or reconnect when convenient to load the new surface.'
      : runtimeAhead
        ? 'The runtime remains operationally compatible. The connected runtime is newer than the repository metadata; reconnect to a matching repository or runtime when convenient.'
        : 'The runtime remains operationally compatible. The runtime and repository metadata disagree; reconnect to a matching build when convenient.'
  };
}

function runtimeCompatibility(config, options = {}) {
  const runtime = options.runtime || runtimeMetadata(config);
  const repository = options.repository === undefined
    ? repositoryMetadata(config, options.workspace)
    : options.repository;
  return {
    runtime,
    repository,
    compatibility: assessRuntimeCompatibility(runtime, repository, options)
  };
}

function normalizeMetadata(value) {
  return {
    ...value,
    applicationVersion: cleanVersion(value.applicationVersion),
    packageVersion: cleanVersion(value.packageVersion),
    protocolVersion: String(value.protocolVersion || ''),
    toolSurfaceVersion: Number(value.toolSurfaceVersion || 0),
    toolCount: Number(value.toolCount || 0),
    manifestHash: String(value.manifestHash || ''),
    schemaVersion: Number(value.schemaVersion || 0)
  };
}

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareField(output, field, runtimeValue, repositoryValue) {
  if (String(runtimeValue ?? '') === String(repositoryValue ?? '')) return;
  output.push({ field, runtime: runtimeValue, repository: repositoryValue });
}

function compareVersions(left, right) {
  const leftVersion = semver.valid(cleanVersion(left)) || '0.0.0';
  const rightVersion = semver.valid(cleanVersion(right)) || '0.0.0';
  return semver.compare(leftVersion, rightVersion);
}


export { assessRuntimeCompatibility, readRepositoryMetadata, runtimeCompatibility, runtimeMetadata };
