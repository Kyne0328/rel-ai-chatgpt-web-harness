

import * as fs from "node:fs";
import * as path from "node:path";
import { classifyStatusOwnership } from "./repo/gitOps.js";
import { gitStatusArgs } from "./repo/gitStatus.js";
import { resolveGitExecutable } from "./gitExecutable.js";
import { runProcess } from "./process.js";

const configuredWorkspaceStateTtlMs = Number(process.env.REL_AI_MCP_WORKSPACE_STATE_TTL_MS || 5000);
const WORKSPACE_GIT_STATE_TTL_MS = Number.isFinite(configuredWorkspaceStateTtlMs) ? Math.max(0, configuredWorkspaceStateTtlMs) : 5000;
const gitStateCache = new Map();
const workspaceStateListeners = new Set();
let workspaceStateVersion = 0;
let refreshQueue = Promise.resolve();

function buildWorkspaceStates(config, tasks = [], activity = {}) {
  pruneWorkspaceGitStateCache(config, activity);
  const states = {};
  for (const [alias, workspace] of Object.entries(config.workspaces || {})) {
    states[alias] = workspaceState(alias, workspace, config, tasks, activity);
  }
  return states;
}

function workspaceState(alias, workspace, config, tasks, activity) {
  const recentTasks = tasks.filter(task => task.workspace === alias);
  const lastTask = recentTasks[0] || null;
  const lastValidation = recentTasks.find(task => task.validation !== 'not_run') || null;
  const activeTasks = resolveActiveTasks(activity);
  const currentTask = activeTasks.find(task => task.workspace === alias) || null;
  return {
    ...workspaceGitState(alias, workspace, config, currentTask?.id || currentTask?.taskId || ''),
    currentActivity: currentTask ? {
      state: currentTask.state,
      tool: currentTask.lastTool || currentTask.tool,
      startedAt: currentTask.startedAt,
      activeCalls: currentTask.activeCalls || 0,
      taskId: currentTask.id || currentTask.taskId || ''
    } : null,
    lastTask,
    lastValidation: lastValidation ? { status: lastValidation.validation, completedAt: lastValidation.completedAt } : null
  };
}

function workspaceGitState(alias, workspace, config, taskId = '') {
  const workspacePath = String(workspace?.path || '');
  const cacheKey = workspaceStateCacheKey(alias, workspacePath, taskId);
  let cached = gitStateCache.get(cacheKey);
  if (!cached) {
    cached = {
      createdAt: Date.now(),
      refreshing: false,
      refreshPromise: null,
      value: baseWorkspaceGitState(workspacePath)
    };
    gitStateCache.set(cacheKey, cached);
    if (cached.value.isGit) scheduleWorkspaceGitStateRefresh(cacheKey, cached, alias, workspace, config, taskId);
    return cached.value;
  }
  if (cached.value.isGit && Date.now() - cached.createdAt >= WORKSPACE_GIT_STATE_TTL_MS) {
    scheduleWorkspaceGitStateRefresh(cacheKey, cached, alias, workspace, config, taskId);
  }
  return cached.value;
}

function workspaceStateCacheKey(alias, workspacePath, taskId = '') {
  return [alias, workspacePath, taskId].join('\u0000');
}

function pruneWorkspaceGitStateCache(config, activity = {}) {
  const configuredPaths = new Map(Object.entries(config.workspaces || {}).map(([alias, workspace]) => [alias, String(workspace?.path || '')]));
  const activeTaskIds = new Map();
  for (const task of resolveActiveTasks(activity)) {
    const alias = String(task?.workspace || '').trim();
    const taskId = String(task?.id || task?.taskId || '').trim();
    if (!alias || !taskId) continue;
    let ids = activeTaskIds.get(alias);
    if (!ids) {
      ids = new Set();
      activeTaskIds.set(alias, ids);
    }
    ids.add(taskId);
  }
  for (const cacheKey of gitStateCache.keys()) {
    const [alias = '', workspacePath = '', taskId = ''] = String(cacheKey).split('\u0000');
    if (configuredPaths.get(alias) !== workspacePath || (taskId && !activeTaskIds.get(alias)?.has(taskId))) {
      gitStateCache.delete(cacheKey);
    }
  }
}

function workspaceStateCacheSize() {
  return gitStateCache.size;
}

function baseWorkspaceGitState(workspacePath) {
  const exists = Boolean(workspacePath && fs.existsSync(workspacePath));
  const isGit = exists && fs.existsSync(path.join(workspacePath, '.git'));
  return {
    exists,
    isGit,
    branch: null,
    unborn: false,
    ahead: 0,
    behind: 0,
    dirty: false,
    changedFileCount: 0,
    sessionChangedFileCount: 0,
    remotes: [],
    remoteAvailable: false
  };
}

function scheduleWorkspaceGitStateRefresh(cacheKey, cached, alias, workspace, config, taskId = '') {
  if (cached.refreshing) return cached.refreshPromise;
  cached.refreshing = true;
  const run = () => refreshWorkspaceGitState(cacheKey, cached, alias, workspace, config, taskId);
  const refreshPromise = refreshQueue.then(run, run);
  refreshQueue = refreshPromise.catch(() => {});
  cached.refreshPromise = refreshPromise;
  return refreshPromise;
}

async function refreshWorkspaceGitState(cacheKey, cached, alias, workspace, config, taskId = '') {
  const workspacePath = String(workspace?.path || '');
  try {
    const base = baseWorkspaceGitState(workspacePath);
    if (!base.isGit) {
      commitWorkspaceGitState(cacheKey, cached, alias, base);
      return base;
    }
    const [status, remotes] = await Promise.all([
      runProcess('git', gitStatusArgs(), { cwd: workspacePath, timeout: 5000, maxOutputBytes: 512 * 1024 }, config),
      runProcess('git', ['remote'], { cwd: workspacePath, timeout: 5000, maxOutputBytes: 128 * 1024 }, config)
    ]);
    const next = { ...base };
    if (status.exitCode === 0 && !status.stdoutTruncated) {
      const ownership = classifyStatusOwnership({ alias, path: workspacePath }, config, status.stdout || '', taskId);
      next.branch = ownership.branch;
      next.unborn = ownership.unborn;
      next.ahead = ownership.aheadBehind?.ahead || 0;
      next.behind = ownership.aheadBehind?.behind || 0;
      next.changedFileCount = ownership.entries.length;
      next.sessionChangedFileCount = ownership.sessionTouched.length;
      next.dirty = ownership.entries.length > 0;
    }
    if (remotes.exitCode === 0 && !remotes.stdoutTruncated) {
      next.remotes = String(remotes.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    }
    next.remoteAvailable = next.remotes.length > 0;
    commitWorkspaceGitState(cacheKey, cached, alias, next);
    return next;
  } catch (error) {
    cached.createdAt = Date.now();
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] workspace state refresh (' + alias + '):', error);
    return cached.value;
  } finally {
    cached.refreshing = false;
    cached.refreshPromise = null;
  }
}

function commitWorkspaceGitState(cacheKey, cached, alias, next) {
  if (gitStateCache.get(cacheKey) !== cached) return;
  const changed = JSON.stringify(cached.value) !== JSON.stringify(next);
  cached.value = next;
  cached.createdAt = Date.now();
  gitStateCache.set(cacheKey, cached);
  if (!changed) return;
  workspaceStateVersion += 1;
  for (const listener of workspaceStateListeners) {
    try { listener({ alias, state: next, version: workspaceStateVersion }); }
    catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] workspace state listener:', error); }
  }
}

function onWorkspaceStateChange(listener) {
  if (typeof listener !== 'function') return () => {};
  workspaceStateListeners.add(listener);
  return () => workspaceStateListeners.delete(listener);
}

function workspaceStateRevision() {
  return workspaceStateVersion;
}

function resolveActiveTasks(activity) {
  if (Array.isArray(activity?.tasks)) return activity.tasks;
  if (activity?.state && activity.state !== 'idle') return [activity];
  return [];
}


export { buildWorkspaceStates, onWorkspaceStateChange, workspaceStateRevision, workspaceStateCacheSize, resolveGitExecutable };
