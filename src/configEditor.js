import * as path from "node:path";
import { getConfigPath, makeDefaultContextConfig, publicConfigSummary, writeConfig } from './config.js';
import { assertSafeWorkspaceRoot } from './workspaceSafety.js';

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function _handleDeleteWorkspace(alias, payload, next) {
  if (!payload.confirmDelete && !payload.confirmClear) throw new Error("Workspace removal requires confirmDelete=true (or confirmClear=true).");
  if (!next.workspaces[alias]) throw new Error(`Workspace '${alias}' is not configured.`);
  delete next.workspaces[alias];
  const normalized = writeConfig(next);
  return { ok: true, changed: [`workspaces.${alias}`], message: `Removed workspace '${alias}'.`, configPath: getConfigPath(), config: publicConfigSummary(normalized) };
}

function _handleUpsertWorkspace(alias, payload, next) {
  const source = payload.workspaceConfig && typeof payload.workspaceConfig === "object" ? payload.workspaceConfig : payload;
  const mode = String(source.mode || payload.mode || "").trim().toLowerCase();
  const originalAlias = String(source.originalAlias || payload.originalAlias || alias).trim();
  validateAlias(originalAlias);
  if (mode === "create" && next.workspaces[alias]) throw new Error(`Workspace '${alias}' already exists.`);
  if (mode === "update" && !next.workspaces[originalAlias]) throw new Error(`Workspace '${originalAlias}' is not configured.`);
  if (originalAlias !== alias && next.workspaces[alias]) throw new Error(`Workspace '${alias}' already exists.`);

  const currentWorkspace = objectOrEmpty(next.workspaces[originalAlias]);
  const sourcePaths = workspaceSourcePaths(source, currentWorkspace);
  if (!sourcePaths.length) throw new Error("At least one workspace path is required.");
  for (const workspacePath of sourcePaths) {
    if (!path.isAbsolute(workspacePath)) throw new Error("Workspace paths must be absolute.");
    assertSafeWorkspaceRoot(workspacePath);
  }

  if (source.enforceUniquePath === true || payload.enforceUniquePath === true || mode === "create" || mode === "update") {
    for (const workspacePath of sourcePaths) {
      const duplicateAlias = workspaceAliasForPath(next.workspaces, workspacePath, originalAlias);
      if (duplicateAlias) throw new Error(`Project folder is already configured as workspace '${duplicateAlias}'.`);
    }
  }

  const workspacePath = sourcePaths[0];

  if (originalAlias !== alias) delete next.workspaces[originalAlias];
  next.workspaces[alias] = {
    ...currentWorkspace,
    path: workspacePath,
    sourcePaths,
    repoSlug: String(source.repoSlug || currentWorkspace.repoSlug || ""),
    context: parseContext(source.context, currentWorkspace.context)
  };
  const normalized = writeConfig(next);
  return {
    ok: true,
    changed: originalAlias === alias ? [`workspaces.${alias}`] : [`workspaces.${originalAlias}`, `workspaces.${alias}`],
    renamedFrom: originalAlias === alias ? "" : originalAlias,
    message: originalAlias === alias ? `Saved workspace '${alias}'.` : `Renamed workspace '${originalAlias}' to '${alias}'.`,
    configPath: getConfigPath(),
    config: publicConfigSummary(normalized)
  };
}

function workspaceAliasForPath(workspaces, workspacePath, excludedAlias = "") {
  const target = normalizedWorkspacePath(workspacePath);
  for (const [candidateAlias, candidate] of Object.entries(objectOrEmpty(workspaces))) {
    if (candidateAlias === excludedAlias) continue;
    if (workspaceSourcePaths({}, candidate).some(candidatePath => normalizedWorkspacePath(candidatePath) === target)) return candidateAlias;
  }
  return "";
}

function workspaceSourcePaths(source, currentWorkspace = {}) {
  const current = parseList(currentWorkspace.sourcePaths?.length ? currentWorkspace.sourcePaths : currentWorkspace.path ? [currentWorkspace.path] : []);
  const hasExplicitList = source.sourcePaths != null || source.paths != null;
  let values = hasExplicitList ? parseList(source.sourcePaths ?? source.paths) : [...current];
  if (!hasExplicitList && source.path != null && source.path !== "") {
    values = [String(source.path).trim(), ...current.slice(1)];
  } else if (hasExplicitList && source.path != null && source.path !== "") {
    values = [String(source.path).trim(), ...values];
  }
  const seen = new Set();
  return values.filter(value => {
    const key = normalizedWorkspacePath(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedWorkspacePath(value) {
  const resolved = path.resolve(String(value || "").trim()).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

const WORKSPACE_ACTION_HANDLERS = {
  upsert: _handleUpsertWorkspace,
  delete: _handleDeleteWorkspace,
  clear: _handleDeleteWorkspace
};

function updateWorkspace(current, payload = {}) {
  const action = String(payload.action || "upsert").toLowerCase();
  const alias = String(payload.alias || payload.workspace || "").trim();
  validateAlias(alias);
  const next = clone(current);
  if (!next.workspaces || typeof next.workspaces !== "object") next.workspaces = {};

  const handler = WORKSPACE_ACTION_HANDLERS[action];
  if (!handler) {
    throw new Error(`Unknown workspace action: ${action}. Allowed: ${Object.keys(WORKSPACE_ACTION_HANDLERS).join(", ")}.`);
  }
  return handler(alias, payload, next);
}

function updateProjectAccess(current, payload = {}) {
  const next = clone(current);
  next.projectAccess = {
    directFilesystem: payload.directFilesystem === true
  };
  const normalized = writeConfig(next);
  return {
    ok: true,
    changed: ['projectAccess.directFilesystem'],
    message: normalized.projectAccess.directFilesystem
      ? 'Direct filesystem access enabled.'
      : 'Direct filesystem access disabled.',
    configPath: getConfigPath(),
    config: publicConfigSummary(normalized)
  };
}

function clone(value) {
  return structuredClone(objectOrEmpty(value));
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number.`);
  return number;
}

function parseList(value, fallback = []) {
  if (value == null || value === "") return Array.isArray(fallback) ? fallback.map(String) : [];
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value).split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function parseContext(value, fallback = {}) {
  const source = objectOrEmpty(value);
  const defaults = makeDefaultContextConfig();
  const current = { ...defaults, ...objectOrEmpty(fallback) };
  const snapshotMaxFiles = source.snapshotMaxFiles == null
    ? current.snapshotMaxFiles
    : finiteNumber(source.snapshotMaxFiles, "context.snapshotMaxFiles");
  return {
    ...current,
    snapshotMaxFiles: snapshotMaxFiles || defaults.snapshotMaxFiles,
    includeRoots: parseList(source.includeRoots, current.includeRoots || []),
    excludePaths: parseList(source.excludePaths, current.excludePaths || [])
  };
}

function validateAlias(alias) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(alias)) throw new Error("Workspace alias must be 1-80 characters using letters, numbers, dot, underscore, or dash.");
}

export { updateProjectAccess, updateWorkspace };
