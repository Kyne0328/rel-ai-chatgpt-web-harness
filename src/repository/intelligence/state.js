const MAX_DIAGNOSTICS_PER_WORKSPACE = 32;
const diagnosticsByWorkspace = new Map();

function repositoryIndexSnapshot(status = {}) {
  const metadata = status?.metadata;
  return {
    dirty: status?.dirty === true,
    metadata: metadata ? {
      generation: Number(metadata.generation || 0),
      freshness: String(metadata.freshness || ''),
      truncated: metadata.truncated === true,
      needsReconcile: metadata.needsReconcile === true
    } : null
  };
}

function repositoryIndexChanged(status = {}, expectedGeneration = 0) {
  const snapshot = repositoryIndexSnapshot(status);
  const currentGeneration = Number(snapshot.metadata?.generation || 0);
  const expected = Number(expectedGeneration || 0);
  return snapshot.dirty
    || (currentGeneration > 0 && expected > 0 && currentGeneration !== expected);
}

function repositoryFreshness(status = {}, generation = null) {
  const snapshot = repositoryIndexSnapshot(status);
  const metadata = snapshot.metadata || {};
  if (snapshot.dirty || ['stale', 'runtime-stale'].includes(metadata.freshness)) return 'stale';
  const verifiedGeneration = Number(metadata.generation || 0);
  const requestedGeneration = Number(generation?.id || generation || 0);
  if (verifiedGeneration > 0 && requestedGeneration > 0 && verifiedGeneration !== requestedGeneration) return 'cached-unverified';
  if (metadata.freshness === 'partial' || metadata.truncated === true) return 'partial';
  if (metadata.needsReconcile === true) return 'stale';
  if (verifiedGeneration > 0) return 'current';
  return 'cached-unverified';
}

function recordIntelligenceDiagnostic(workspace, code, error) {
  const alias = workspaceAlias(workspace);
  if (!alias) return;
  const entries = diagnosticsByWorkspace.get(alias) || [];
  entries.push({
    code: String(code || 'intelligence_error').slice(0, 80),
    message: String(error instanceof Error ? error.message : error || 'Unknown intelligence error').slice(0, 500),
    at: new Date().toISOString()
  });
  diagnosticsByWorkspace.set(alias, entries.slice(-MAX_DIAGNOSTICS_PER_WORKSPACE));
}

function recentIntelligenceDiagnostics(workspace, limit = 5) {
  const alias = workspaceAlias(workspace);
  if (!alias) return [];
  const bounded = Math.max(1, Math.min(MAX_DIAGNOSTICS_PER_WORKSPACE, Number(limit) || 5));
  return (diagnosticsByWorkspace.get(alias) || []).slice(-bounded).map(item => ({ ...item }));
}

function workspaceAlias(workspace) {
  return String(typeof workspace === 'string' ? workspace : workspace?.alias || '').trim();
}

export {
  recentIntelligenceDiagnostics,
  recordIntelligenceDiagnostic,
  repositoryFreshness,
  repositoryIndexChanged,
  repositoryIndexSnapshot
};
