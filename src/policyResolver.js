import { getCurrentToolActivityContext } from './toolActivity.js';
import * as fs from "node:fs";
import * as path from "node:path";
import { runProcess } from './process.js';
import { gitStatusArgs, parseGitStatus } from "./repo/gitStatus.js";
import { getStateDir } from './statePaths.js';
import {
  setStateMeta,
  stateDatabasePath,
  stateMetaValue,
  withStateDatabase,
} from './stateDatabase.ts';
import { DEFAULT_TASK_STALE_MS } from './taskTiming.js';

const SESSION_IDLE_TTL_MS = DEFAULT_TASK_STALE_MS;
const SESSION_TOUCH_PERSIST_INTERVAL_MS = 60 * 1000;
const LEGACY_SESSION_POLICY_MIGRATION_KEY = 'session_policies_legacy_migrated_v1';
const migratedSessionDatabases = new Set();

function sessionsDir(config) {
  return path.join(getStateDir(config), 'sessions');
}

function currentTaskId() {
  try {
    return String(getCurrentToolActivityContext()?.taskId || '').trim();
  } catch {
    return '';
  }
}

function resolvedTaskId(taskId) {
  return String(taskId || currentTaskId() || '').trim();
}

function sessionLastActivity(parsed) {
  const stamp = parsed && (parsed.updatedAt || parsed.createdAt);
  const ms = Date.parse(stamp || '');
  return Number.isFinite(ms) ? ms : null;
}

function validPolicy(parsed, alias, expectedTaskId = '') {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (parsed.workspace !== alias) return false;
  return !expectedTaskId || String(parsed.taskId || '') === expectedTaskId;
}

function isExpiredPolicy(parsed, now = Date.now()) {
  const last = sessionLastActivity(parsed);
  return last !== null && now - last > SESSION_IDLE_TTL_MS;
}

function migrateLegacySessionPolicies(config = {}) {
  const databaseKey = stateDatabasePath(config);
  if (migratedSessionDatabases.has(databaseKey)) return;
  const directory = sessionsDir(config);
  withStateDatabase(config, db => {
    if (stateMetaValue(db, LEGACY_SESSION_POLICY_MIGRATION_KEY, '') === '1') return;
    let names = [];
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    for (const name of names) {
      if (!name.endsWith('-policy.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        const workspace = String(parsed?.workspace || '').trim();
        const taskId = String(parsed?.taskId || '').trim();
        if (!workspace || !taskId || !validPolicy(parsed, workspace, taskId)) continue;
        const updatedAtMs = sessionLastActivity(parsed) || Date.now();
        db.prepare(`INSERT INTO session_policies(workspace,task_id,updated_at_ms,payload) VALUES(?,?,?,?)
          ON CONFLICT(workspace,task_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`)
          .run(workspace, taskId, updatedAtMs, JSON.stringify(parsed));
      } catch (error) {
        if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] legacy session policy migration:', error);
      }
    }
    setStateMeta(db, LEGACY_SESSION_POLICY_MIGRATION_KEY, '1');
  }, { transaction: true });
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('-policy.json')) fs.rmSync(path.join(directory, name), { force: true });
    }
    try { fs.rmdirSync(directory); } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
  }
  migratedSessionDatabases.add(databaseKey);
}

function parseStoredPolicy(payload, alias, taskId = '') {
  try {
    const parsed = JSON.parse(String(payload || ''));
    return validPolicy(parsed, alias, taskId) ? parsed : null;
  } catch {
    return null;
  }
}

function readSessionPolicies(config, alias) {
  migrateLegacySessionPolicies(config);
  try {
    return withStateDatabase(config, db => {
      const rows = db.prepare('SELECT task_id,payload FROM session_policies WHERE workspace=? ORDER BY updated_at_ms DESC').all(alias);
      const policies = [];
      for (const row of rows) {
        const taskId = String(row.task_id || '');
        const parsed = parseStoredPolicy(row.payload, alias, taskId);
        if (!parsed || isExpiredPolicy(parsed)) {
          db.prepare('DELETE FROM session_policies WHERE workspace=? AND task_id=?').run(alias, taskId);
          continue;
        }
        policies.push(parsed);
      }
      return policies;
    }, { transaction: true });
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] session policy list:', error);
    return [];
  }
}

function readSessionPolicy(config, alias, taskId = '') {
  const resolved = resolvedTaskId(taskId);
  if (!resolved) {
    const policies = readSessionPolicies(config, alias);
    return policies.length === 1 ? policies[0] : null;
  }
  migrateLegacySessionPolicies(config);
  try {
    return withStateDatabase(config, db => {
      const row = db.prepare('SELECT payload FROM session_policies WHERE workspace=? AND task_id=?').get(alias, resolved);
      if (!row) return null;
      const parsed = parseStoredPolicy(row.payload, alias, resolved);
      if (!parsed || isExpiredPolicy(parsed)) {
        db.prepare('DELETE FROM session_policies WHERE workspace=? AND task_id=?').run(alias, resolved);
        return null;
      }
      return parsed;
    }, { transaction: true });
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] session policy read:', error);
    return null;
  }
}

async function captureBaselineState(workspaceRoot) {
  if (!workspaceRoot) return { ok: false, files: [], error: 'workspace root is missing' };
  try {
    // Keep the branch record first so process-output normalization cannot strip
    // the leading status column from records such as " M file.js".
    const result = await runProcess('git', gitStatusArgs(), {
      cwd: workspaceRoot,
      timeout: 15000,
      maxOutputBytes: 8 * 1024 * 1024
    });
    if (result.exitCode !== 0 || result.stdoutTruncated) {
      return { ok: false, files: [], error: String(result.error || result.stderr || result.stdout || `git status exited ${result.exitCode}`).trim() };
    }
    const files = parseGitStatus(result.stdout || '').entries.map((entry) => entry.path);
    return { ok: true, files, error: '' };
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] baseline dirty capture:', error);
    return { ok: false, files: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function captureBaselineDirty(workspaceRoot) {
  return (await captureBaselineState(workspaceRoot)).files;
}

async function writeSessionPolicy(config, alias, { taskHint, workspaceRoot, taskId } = {}) {
  const resolved = String(taskId || currentTaskId() || '').trim();
  if (!resolved) throw new Error('Session policy requires a taskId.');
  const baseline = await captureBaselineState(workspaceRoot);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const data = {
    workspace: alias,
    createdAt: now,
    updatedAt: now,
    baselineCaptured: baseline.ok,
    baselineDirty: baseline.files,
    ...(baseline.error ? { baselineCaptureError: baseline.error } : {}),
    taskId: resolved,
    ...(taskHint ? { taskHint } : {}),
  };
  migrateLegacySessionPolicies(config);
  withStateDatabase(config, db => {
    db.prepare(`INSERT INTO session_policies(workspace,task_id,updated_at_ms,payload) VALUES(?,?,?,?)
      ON CONFLICT(workspace,task_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`)
      .run(alias, resolved, nowMs, JSON.stringify(data));
  }, { transaction: true });
}

function touchSessionPolicy(config, alias, taskId = '') {
  const resolved = resolvedTaskId(taskId);
  if (!resolved) return false;
  migrateLegacySessionPolicies(config);
  try {
    return withStateDatabase(config, db => {
      const row = db.prepare('SELECT updated_at_ms,payload FROM session_policies WHERE workspace=? AND task_id=?').get(alias, resolved);
      if (!row) return false;
      const parsed = parseStoredPolicy(row.payload, alias, resolved);
      if (!parsed || isExpiredPolicy(parsed)) {
        db.prepare('DELETE FROM session_policies WHERE workspace=? AND task_id=?').run(alias, resolved);
        return false;
      }
      const now = Date.now();
      if (now - Number(row.updated_at_ms || 0) < SESSION_TOUCH_PERSIST_INTERVAL_MS) return true;
      parsed.updatedAt = new Date(now).toISOString();
      db.prepare('UPDATE session_policies SET updated_at_ms=?,payload=? WHERE workspace=? AND task_id=?')
        .run(now, JSON.stringify(parsed), alias, resolved);
      return true;
    }, { transaction: true });
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] session policy touch:', error);
    return false;
  }
}

async function ensureSessionStarted(config, alias, workspaceRoot, options = {}) {
  if (!alias) return false;
  const taskId = String(options.taskId || currentTaskId() || '').trim();
  if (!taskId) throw new Error('Session start requires a taskId.');
  const existing = readSessionPolicy(config, alias, taskId);
  if (existing) {
    touchSessionPolicy(config, alias, taskId);
    return false;
  }
  await writeSessionPolicy(config, alias, { workspaceRoot, taskId, taskHint: options.taskHint });
  return true;
}

function clearSessionPolicy(config, alias, taskId = '') {
  const resolved = resolvedTaskId(taskId);
  if (!resolved) return { cleared: false };
  migrateLegacySessionPolicies(config);
  try {
    const cleared = withStateDatabase(config, db => {
      const result = db.prepare('DELETE FROM session_policies WHERE workspace=? AND task_id=?').run(alias, resolved);
      return Number(result.changes || 0) > 0;
    }, { transaction: true });
    return { cleared };
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] session policy clear:', error);
    return { cleared: false };
  }
}

function resolvePolicy(workspace, config) {
  const alias = workspace?.alias ?? String(workspace || '');
  const taskId = currentTaskId();
  const session = readSessionPolicy(config, alias, taskId);
  if (session) {
    return {
      trusted: session.baselineCaptured === true,
      sessionActive: true,
      sessionCreatedAt: session.createdAt || null,
      taskId: session.taskId || null,
      taskHint: session.taskHint || null,
      baselineDirty: Array.isArray(session.baselineDirty) ? session.baselineDirty : [],
      baselineCaptured: session.baselineCaptured === true,
      baselineCaptureError: session.baselineCaptureError || null,
      source: 'task_session_store'
    };
  }
  const activePolicies = taskId ? [] : readSessionPolicies(config, alias);
  return {
    trusted: activePolicies.length <= 1,
    sessionActive: false,
    sessionCreatedAt: null,
    taskId: taskId || null,
    taskHint: null,
    baselineDirty: [],
    baselineCaptured: false,
    baselineCaptureError: null,
    ambiguous: activePolicies.length > 1,
    activeTaskCount: activePolicies.length,
    source: activePolicies.length > 1 ? 'multiple_task_sessions' : 'default'
  };
}

export { resolvePolicy, writeSessionPolicy, touchSessionPolicy, ensureSessionStarted, clearSessionPolicy, readSessionPolicy, captureBaselineDirty, SESSION_IDLE_TTL_MS, SESSION_TOUCH_PERSIST_INTERVAL_MS };
