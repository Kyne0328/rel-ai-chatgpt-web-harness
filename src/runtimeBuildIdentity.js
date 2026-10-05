import fs from 'node:fs';
import path from 'node:path';
import { buildIdFromFingerprint, normalizeBuildProvenance, readRepositoryBuildState } from './buildProvenance.js';
import { packageMetadata, packageRoot } from './packageMetadata.js';

const repositoryComparisons = new Map();
const pendingRepositoryComparisons = new Map();
const MAX_SOURCE_COMPARISONS = 64;

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

// Capture the package's provenance at module startup. Never replace the identity
// of a running process because somebody rebuilds the package on disk.
function createRuntimeBuildIdentityReader(options = {}) {
  const roots = [...new Set([options.resourcesPath, options.packageRoot].filter(Boolean))];
  const readFile = options.readFile || (file => fs.readFileSync(file, 'utf8'));
  let provenance = null;
  for (const root of roots) {
    try {
      provenance = normalizeBuildProvenance(JSON.parse(readFile(path.join(root, 'build-provenance.json'))));
      if (provenance && options.expectedVersion && provenance.version !== options.expectedVersion) provenance = null;
      if (provenance) break;
    } catch {}
  }
  const startedAt = String(options.startedAt || PROCESS_STARTED_AT);
  let identity;
  return function readRuntimeBuildIdentity(schemaDigest = '') {
    if (!identity) identity = Object.freeze({
      state: provenance ? 'recorded' : 'unavailable',
      buildId: provenance ? buildIdFromFingerprint(provenance.sourceFingerprint) : null,
      sourceRevision: provenance?.sourceRevision || null,
      dirty: provenance ? provenance.dirty : null,
      sourceFingerprint: provenance?.sourceFingerprint || null,
      builtAt: provenance?.builtAt || null,
      startedAt,
      schemaDigest: String(schemaDigest || ''),
      provenanceSchemaVersion: provenance?.schemaVersion || null
    });
    return identity;
  };
}

const runtimeBuildIdentity = createRuntimeBuildIdentityReader({ resourcesPath: process.resourcesPath, packageRoot, expectedVersion: packageMetadata.version });

function assessSourceParity(identity = {}, repositoryState) {
  // Release manifests and another package's build-provenance file do not
  // attest to current checkout bytes. Only an explicitly measured source state
  // may be supplied by the caller. This helper never hashes a repository.
  if (!identity.sourceFingerprint || !repositoryState?.sourceFingerprint) {
    return {
      status: 'unknown', verified: false,
      reason: 'Release metadata does not establish source/build parity; an explicit source fingerprint comparison is required.'
    };
  }
  const matches = identity.sourceFingerprint === repositoryState.sourceFingerprint;
  return {
    status: matches ? 'matches' : 'different',
    verified: true,
    ...(repositoryState.checkedAt ? { checkedAt: repositoryState.checkedAt, cached: true } : {}),
    reason: matches
      ? 'The measured repository source fingerprint matches the running package build snapshot; this is not an attestation of all loaded modules.'
      : 'The measured repository source fingerprint differs from the running package build snapshot.'
  };
}

// Explicit, potentially expensive operation. Normal status polling only reads
// the result via cachedRepositoryBuildState. A match is timestamped evidence
// about that measured snapshot, never a continuously current source attestation.
async function compareRuntimeBuildToRepository(identity, root, options = {}) {
  const key = path.resolve(root);
  let state = repositoryComparisons.get(key);
  if (!state || options.refresh === true) {
    let pending = pendingRepositoryComparisons.get(key);
    if (!pending) {
      pending = (async () => {
        const measured = Object.freeze({ ...await readRepositoryBuildState(key), checkedAt: new Date().toISOString() });
        repositoryComparisons.delete(key);
        repositoryComparisons.set(key, measured);
        while (repositoryComparisons.size > MAX_SOURCE_COMPARISONS) repositoryComparisons.delete(repositoryComparisons.keys().next().value);
        return measured;
      })();
      pendingRepositoryComparisons.set(key, pending);
    }
    try { state = await pending; }
    finally { if (pendingRepositoryComparisons.get(key) === pending) pendingRepositoryComparisons.delete(key); }
  }
  return { ...assessSourceParity(identity, state), repositoryBuildState: state };
}

function cachedRepositoryBuildState(root) {
  return root ? repositoryComparisons.get(path.resolve(root)) : undefined;
}

export { assessSourceParity, cachedRepositoryBuildState, compareRuntimeBuildToRepository, createRuntimeBuildIdentityReader, runtimeBuildIdentity };
