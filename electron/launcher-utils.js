import * as fs from 'node:fs';
import * as path from 'node:path';
import { importResourceModule } from './resource-path.js';

const connection = await importResourceModule('src/connectionProfile.js');

function normalizePort(value, fallback = 3333) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Port must be an integer between 1024 and 65535.');
  }
  return port;
}

function normalizeTunnelId(value) {
  const text = String(value || '').trim();
  if (!/^tunnel_[A-Za-z0-9_-]{8,200}$/.test(text)) {
    throw new Error('OpenAI Secure MCP Tunnel ID must start with tunnel_.');
  }
  return text;
}

function hasExistingConfig() {
  const profile = connection.readConnectionProfile();
  const env = connection.readLaunchEnv();
  try {
    normalizePort(env.REL_AI_MCP_PORT || profile.port || 0);
    if (env.REL_AI_MCP_LOCAL_ONLY !== '1') normalizeTunnelId(env.REL_AI_MCP_TUNNEL_ID || profile.tunnelId || '');
    return Boolean(env.REL_AI_MCP_PORT || profile.port);
  } catch {
    return false;
  }
}

function hasPriorConfigEvidence() {
  // Manual full-installer updates can arrive with a partially preserved state
  // dir (elevated installer home, interrupted migration, strict validation on
  // an older profile). Any leftover connection artifact means this machine has
  // seen Rel.AI before, so it must never be treated as a brand-new install.
  try {
    const profile = connection.readConnectionProfile();
    const env = connection.readLaunchEnv();
    if (profile && typeof profile === 'object' && Object.keys(profile).length > 0) return true;
    if (env && typeof env === 'object' && Object.keys(env).length > 0) return true;
  } catch {
    return true;
  }
  try {
    const stateDir = typeof connection.stateDir === 'function' ? String(connection.stateDir() || '') : '';
    if (!stateDir) return false;
    for (const name of ['connection.json', 'connection.json.bak', '.env', '.env.bak']) {
      try {
        if (fs.existsSync(path.join(stateDir, name))) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/** @knipdynamic Imported by the startup-recovery audit across the Electron workspace boundary. */
export function isReturningUserLifecycle(status = {}) {
  if (!status || typeof status !== 'object') return false;
  if (status.updated === true) return true;
  const prev = String(status.previousVersion || '').trim();
  const curr = String(status.currentVersion || '').trim();
  if (prev && curr && prev !== curr) return true;
  if (prev && !curr) return true;
  return false;
}

function isManualUpdateInstall({ lifecycleStatus = {}, hasConfig = false } = {}) {
  if (hasConfig) return false;
  return isReturningUserLifecycle(lifecycleStatus) || (Boolean(lifecycleStatus?.updated) && hasPriorConfigEvidence());
}

function readGuiConfig() {
  const profile = connection.readConnectionProfile();
  const env = connection.readLaunchEnv();
  return {
    port: normalizePort(env.REL_AI_MCP_PORT || profile.port || 3333),
    token: String(env.REL_AI_MCP_TOKEN || '').trim(),
    tunnelId: env.REL_AI_MCP_LOCAL_ONLY === '1' ? '' : normalizeTunnelId(env.REL_AI_MCP_TUNNEL_ID || profile.tunnelId || '')
  };
}

export { normalizePort, normalizeTunnelId, hasExistingConfig, isManualUpdateInstall, readGuiConfig };
