import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MAX_SCANNED_ENTRIES = 200_000;

function createDesktopLocalDataManager(options = {}) {
  const {
    getAdditionalDataRoots = () => [],
    getConfig,
    getServiceLogPath = () => '',
    getTaskActivity = () => ({}),
    getUserDataPath = () => '',
    openPath = async () => ''
  } = options;
  if (typeof getConfig !== 'function') throw new TypeError('getConfig is required.');

  async function getUsage() {
    const config = getConfig();
    const configuredStateDir = String(config?.stateDir || '').trim();
    if (!configuredStateDir) throw new Error('Rel.AI local data folder is unavailable.');
    const stateDir = path.resolve(configuredStateDir);
    const auditPath = path.resolve(String(config?.auditLogPath || path.join(stateDir, 'audit.jsonl')));
    const serviceLogPath = String(getServiceLogPath() || '').trim();
    const additional = getAdditionalDataRoots();
    const ownedRoots = minimizeRoots([
      stateDir,
      auditPath,
      `${auditPath}.1`,
      String(getUserDataPath() || '').trim(),
      ...(Array.isArray(additional) ? additional : []),
      serviceLogPath
    ].filter(Boolean).map(root => path.resolve(String(root))));
    const paths = {
      history: [path.join(stateDir, 'sessions'), auditPath, `${auditPath}.1`],
      logs: serviceLogPath ? [serviceLogPath] : [],
      temporary: [path.join(stateDir, 'output-spills')],
      indexes: [path.join(stateDir, 'repository-intelligence')]
    };
    const [history, logs, temporary, indexes, total] = await Promise.all([
      ...Object.values(paths).map(targets => measurePaths(targets)),
      measurePaths(ownedRoots)
    ]);
    const categorizedBytes = history.bytes + logs.bytes + temporary.bytes + indexes.bytes;
    const other = {
      bytes: Math.max(0, total.bytes - categorizedBytes),
      entries: 0,
      truncated: total.truncated
    };
    const categories = { history, logs, temporary, indexes, other };
    return {
      ok: true,
      totalBytes: total.bytes,
      categories,
      activeTaskCount: activeTaskCount(getTaskActivity()),
      approximate: total.truncated || Object.values(categories).some(item => item.truncated)
    };
  }

  async function clearTemporary() {
    const active = activeTaskCount(getTaskActivity());
    if (active > 0) {
      return {
        ok: false,
        error: `Cannot clear temporary command output while ${active} Rel.AI ${active === 1 ? 'task is' : 'tasks are'} still active.`
      };
    }
    const config = getConfig();
    const configuredStateDir = String(config?.stateDir || '').trim();
    if (!configuredStateDir) return { ok: false, error: 'Rel.AI local data folder is unavailable.' };
    const stateDir = path.resolve(configuredStateDir);
    await fs.promises.rm(path.join(stateDir, 'output-spills'), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    return getUsage();
  }

  async function openDataFolder() {
    const config = getConfig();
    const configuredStateDir = String(config?.stateDir || '').trim();
    if (!configuredStateDir) return { ok: false, error: 'Rel.AI local data folder is unavailable.' };
    const stateDir = path.resolve(configuredStateDir);
    await fs.promises.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const error = await openPath(stateDir);
    return error ? { ok: false, error: String(error) } : { ok: true };
  }

  function prepareClearAll() {
    const active = activeTaskCount(getTaskActivity());
    if (active > 0) {
      return {
        ok: false,
        error: `Cannot clear all local data while ${active} Rel.AI ${active === 1 ? 'task is' : 'tasks are'} still active.`
      };
    }
    const config = getConfig();
    const stateDir = resolveOwnedRoot(config?.stateDir, 'Rel.AI state directory');
    const userDataDir = resolveOwnedRoot(getUserDataPath(), 'Electron user-data directory');
    const auditPath = resolveOwnedRoot(config?.auditLogPath || path.join(stateDir, 'audit.jsonl'), 'Rel.AI audit log');
    const serviceLogPath = String(getServiceLogPath() || '').trim();
    const additional = getAdditionalDataRoots();
    const additionalRoots = Array.isArray(additional)
      ? additional.map((root, index) => resolveOwnedRoot(root, `Additional Rel.AI data root ${index + 1}`))
      : [];
    const roots = [
      stateDir,
      userDataDir,
      auditPath,
      `${auditPath}.1`,
      ...(serviceLogPath ? [resolveOwnedRoot(serviceLogPath, 'Rel.AI service log')] : []),
      ...additionalRoots
    ];
    const protectedRoots = projectRoots(config);
    for (const root of roots) assertSafeClearRoot(root, protectedRoots);
    return { ok: true, roots: Object.freeze(minimizeRoots(roots)) };
  }

  async function clearAll(plan) {
    if (!plan?.ok || !Array.isArray(plan.roots) || plan.roots.length === 0) {
      return { ok: false, error: 'Rel.AI local-data clear plan is unavailable.' };
    }
    let clearedRoots = 0;
    for (const root of plan.roots) {
      try {
        await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 75 });
        clearedRoots += 1;
      } catch (error) {
        return { ok: false, clearedRoots, remainingRoots: plan.roots.length - clearedRoots,
          error: `Local data clearing stopped after ${clearedRoots} of ${plan.roots.length} locations. Some files may already be removed. ${error?.message || error}` };
      }
    }
    return { ok: true, clearedRoots };
  }

  return { getUsage, clearTemporary, openDataFolder, prepareClearAll, clearAll };
}

async function measurePaths(targets) {
  let bytes = 0;
  let entries = 0;
  let truncated = false;
  const queue = [...new Set(targets.filter(Boolean))];
  while (queue.length) {
    const target = queue.pop();
    let stat;
    try { stat = await fs.promises.lstat(target); } catch { continue; }
    entries += 1;
    if (entries > MAX_SCANNED_ENTRIES) {
      truncated = true;
      break;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      bytes += Math.max(0, Number(stat.size || 0));
      continue;
    }
    if (!stat.isDirectory()) continue;
    let children;
    try { children = await fs.promises.readdir(target); } catch { continue; }
    for (const child of children) queue.push(path.join(target, child));
  }
  return { bytes, entries, truncated };
}

function activeTaskCount(activity = {}) {
  const count = Number(activity?.activeTaskCount || 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

function resolveOwnedRoot(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is unavailable.`);
  return path.resolve(text);
}

function projectRoots(config = {}) {
  const roots = [];
  for (const workspace of Object.values(config?.workspaces || {})) {
    const candidates = [workspace?.path, ...(Array.isArray(workspace?.paths) ? workspace.paths : [])];
    for (const candidate of candidates) {
      const text = String(candidate || '').trim();
      if (text) roots.push(path.resolve(text));
    }
  }
  return [...new Set(roots)];
}

function assertSafeClearRoot(root, protectedRoots = []) {
  const resolved = path.resolve(root);
  const filesystemRoot = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  if (resolved === filesystemRoot || containsPath(resolved, home)) {
    throw new Error(`Refusing to clear unsafe Rel.AI data root: ${resolved}`);
  }
  const protectedPath = protectedRoots.find(candidate => containsPath(resolved, candidate));
  if (protectedPath) {
    throw new Error(`Refusing to clear Rel.AI data because it contains project files: ${protectedPath}`);
  }
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function minimizeRoots(roots) {
  const unique = [...new Set(roots.map(root => path.resolve(root)))];
  return unique.filter(root => !unique.some(other => other !== root && containsPath(other, root)));
}

export { createDesktopLocalDataManager };
