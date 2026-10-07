import { STATIC_CONTEXT } from './static-context.js';
import { compactRepositoryContext } from './repository-context.js';

function buildTaskBootstrap(snapshot = {}, mode = 'compact') {
  const bootstrap = mode === 'full' ? fullBootstrap(snapshot) : compactRepositoryContext(snapshot);
  if (!debugContextDiagnosticsEnabled()) return bootstrap;
  return {
    ...bootstrap,
    contextDiagnostics: contextDiagnostics({ staticContext: STATIC_CONTEXT, repository: bootstrap })
  };
}

function fullBootstrap(snapshot) {
  return {
    mode: 'full',
    manifests: snapshot.manifests,
    discoveredCommands: snapshot.discoveredCommands,
    projectInstructions: snapshot.projectInstructions,
    skills: snapshot.skills,
    ...(snapshot.skillDiscovery ? { skillDiscovery: snapshot.skillDiscovery } : {}),
    truncated: snapshot.truncated,
    hints: snapshot.hints,
    git: snapshot.git,
    recommendedFlow: snapshot.recommendedFlow,
    fileCount: snapshot.fileCount,
    files: snapshot.files,
    manifestContents: snapshot.manifestContents,
    skipped: snapshot.skipped,
    writeGuidance: snapshot.writeGuidance,
    operationJournal: snapshot.operationJournal
  };
}

function contextDiagnostics(parts = {}) {
  const diagnostics = {};
  let totalBytes = 0;
  for (const [name, value] of Object.entries(parts)) {
    if (value == null) continue;
    const bytes = serializedBytes(value);
    totalBytes += bytes;
    diagnostics[name] = { bytes, estimatedTokens: Math.ceil(bytes / 4) };
  }
  diagnostics.total = { bytes: totalBytes, estimatedTokens: Math.ceil(totalBytes / 4) };
  return diagnostics;
}

function serializedBytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function debugContextDiagnosticsEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.REL_AI_MCP_DEBUG || '').trim());
}

export { buildTaskBootstrap, contextDiagnostics };
