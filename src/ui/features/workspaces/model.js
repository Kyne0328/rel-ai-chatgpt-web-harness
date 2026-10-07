import { normalizeWorkspacePath } from '../../workspace-input.js';

export function sourcePathsFromWorkspace(workspace) {
  return normalizeSourcePaths([
    workspace?.path,
    ...(Array.isArray(workspace?.sourcePaths) ? workspace.sourcePaths : [])
  ]);
}

export function parseSourcePaths(value) {
  return String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

export function normalizeSourcePaths(values = []) {
  const seen = new Set();
  return values.map(value => String(value || '').trim()).filter(Boolean).filter(value => {
    const key = normalizeWorkspacePath(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function workspaceConflict(workspaces, { alias = '', paths = [], originalAlias = '' } = {}) {
  const cleanAlias = String(alias || '').trim();
  const cleanOriginalAlias = String(originalAlias || '').trim();
  const normalizedPaths = paths.map(normalizeWorkspacePath).filter(Boolean);
  const aliasConflict = (Array.isArray(workspaces) ? workspaces : [])
    .find(item => item.alias === cleanAlias && item.alias !== cleanOriginalAlias);
  if (aliasConflict) return `Project name '${cleanAlias}' is already in use.`;

  const pathConflict = (Array.isArray(workspaces) ? workspaces : []).find(item => {
    if (item.alias === cleanOriginalAlias) return false;
    return sourcePathsFromWorkspace(item)
      .some(itemPath => normalizedPaths.includes(normalizeWorkspacePath(itemPath)));
  });
  return pathConflict ? `A source folder is already configured as '${pathConflict.alias}'.` : '';
}

export function duplicateWorkspaceForPath(workspaces, candidatePath, excludedAlias = '') {
  const target = normalizeWorkspacePath(candidatePath);
  if (!target) return null;
  return (Array.isArray(workspaces) ? workspaces : []).find(item => (
    item.alias !== excludedAlias
    && sourcePathsFromWorkspace(item).some(sourcePath => normalizeWorkspacePath(sourcePath) === target)
  )) || null;
}

export function orderedWorkspaces(workspaces, workspaceFilter = '') {
  const all = Array.isArray(workspaces) ? workspaces : [];
  if (!workspaceFilter) return all;
  const selected = all.find(workspace => workspace.alias === workspaceFilter);
  return selected ? [selected, ...all.filter(workspace => workspace !== selected)] : all;
}

export function workspaceCardView(workspace = {}, health = null) {
  const operational = workspace.operational || {};
  const mutationBlock = operational.mutationBlock?.blocked ? operational.mutationBlock : null;
  const healthWarning = health?.ok === false ? health.error || 'Project unavailable' : '';
  const available = !healthWarning && operational.exists !== false;
  const active = Boolean(operational.currentActivity || workspace.sessionPolicy?.sessionActive);
  return {
    alias: workspace.alias || 'workspace',
    path: workspace.path || '',
    statusLabel: mutationBlock ? 'Changes blocked' : healthWarning ? 'Needs attention' : active ? 'Active' : 'Ready',
    mutationBlock,
    ready: available && !mutationBlock,
    healthWarning,
    available,
    operational,
    sessionActive: workspace.sessionPolicy?.sessionActive === true,
    taskHint: workspace.sessionPolicy?.taskHint || '',
    cautionCount: Number.isFinite(workspace.caution?.count) ? workspace.caution.count : 0
  };
}

export function branchSummary(operational = {}) {
  if (!operational.branch) return operational.isGit ? 'Branch unavailable' : 'Git not initialized';
  if (!operational.ahead && !operational.behind) return operational.branch;
  return `${operational.branch} · ↑${Number(operational.ahead || 0)} ↓${Number(operational.behind || 0)}`;
}

export function repositorySummary(operational = {}) {
  if (operational.mutationBlock?.blocked) {
    return { kindLabel: 'Safety', label: 'Changes blocked', description: 'Read-only inspection remains available. Changes require confirmed safe recovery.', tone: 'bad' };
  }
  if (operational.exists === false) {
    return { kindLabel: 'Folder', label: 'Folder missing', description: 'Rel.AI cannot find this local folder.', tone: 'bad' };
  }
  if (!operational.isGit) {
    return { kindLabel: 'Folder', label: 'Local folder', description: 'File and command actions are available. Git actions are unavailable.', tone: 'neutral' };
  }
  const changed = Number(operational.changedFileCount || 0);
  return {
    kindLabel: 'Repository',
    label: branchSummary(operational),
    description: operational.dirty ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'No uncommitted changes',
    tone: operational.dirty ? 'warn' : 'good'
  };
}

export function actionableFindings(health = {}) {
  return (Array.isArray(health.findings) ? health.findings : [])
    .filter(finding => finding.severity !== 'info');
}

export function findingSeverityLabel(severity) {
  if (severity === 'error') return 'Blocking';
  if (severity === 'warning') return 'Warning';
  return 'Recommendation';
}

export function humanizeFindingCode(code) {
  const text = String(code || '').trim().replaceAll('_', ' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export function folderDisplayName(value) {
  const normalized = String(value || '').trim().replace(/[\\/]+$/, '');
  if (!normalized) return '';
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || normalized;
}

export function hasDuplicateSourcePaths(paths = []) {
  const normalized = paths.map(normalizeWorkspacePath).filter(Boolean);
  return new Set(normalized).size !== normalized.length;
}
