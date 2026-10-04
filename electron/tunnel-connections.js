import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeTunnelId } from './launcher-utils.js';
import { normalizeApiKey } from './tunnel-credentials.js';

const STATE_VERSION = 1;
const STATE_FILE = 'openai-additional-tunnels.json';
const MAX_CONNECTIONS = 12;

function createTunnelConnectionStore({
  stateDir = process.env.REL_AI_MCP_STATE_DIR || path.join(os.homedir(), '.rel-ai-mcp'),
  safeStorage
} = {}) {
  requireSafeStorage(safeStorage);
  const filePath = path.join(path.resolve(String(stateDir)), STATE_FILE);

  function list() {
    return readState(filePath).connections.map(publicConnection);
  }

  function runtimeConnections() {
    return readState(filePath).connections.map(connection => {
      const metadata = publicConnection(connection);
      if (!metadata.enabled) return metadata;
      try {
        ensureEncryptionAvailable(safeStorage);
        return { ...metadata, apiKey: decryptApiKey(connection.encryptedApiKey) };
      } catch {
        // Keep credential material and platform errors inside the storage boundary.
        return { ...metadata, credentialError: true };
      }
    });
  }

  function upsert(input = {}) {
    const tunnelId = normalizeTunnelId(input.tunnelId);
    const label = normalizeLabel(input.label, tunnelId);
    const enabled = input.enabled !== false;
    const replacementKey = String(input.apiKey || '').trim();
    if (replacementKey) normalizeApiKey(replacementKey);

    const state = readState(filePath);
    const index = state.connections.findIndex(connection => connection.tunnelId === tunnelId);
    const existing = index >= 0 ? state.connections[index] : null;
    if (!existing && !replacementKey) throw new Error('Runtime API key is required for a new tunnel connection.');
    if (!existing && state.connections.length >= MAX_CONNECTIONS) {
      throw new Error(`Rel.AI supports up to ${MAX_CONNECTIONS} additional tunnel connections on one computer.`);
    }

    const next = {
      tunnelId,
      label,
      enabled,
      encryptedApiKey: replacementKey ? encryptApiKey(replacementKey) : existing.encryptedApiKey
    };
    if (index >= 0) state.connections[index] = next;
    else state.connections.push(next);
    writeState(filePath, state);
    return publicConnection(next);
  }

  function remove(tunnelIdValue) {
    const tunnelId = normalizeTunnelId(tunnelIdValue);
    const state = readState(filePath);
    const next = state.connections.filter(connection => connection.tunnelId !== tunnelId);
    if (next.length === state.connections.length) return { removed: false, tunnelId };
    writeState(filePath, { version: STATE_VERSION, connections: next });
    return { removed: true, tunnelId };
  }

  function clear() {
    fs.rmSync(filePath, { force: true });
    return { cleared: true };
  }

  function encryptApiKey(apiKey) {
    ensureEncryptionAvailable(safeStorage);
    const encrypted = safeStorage.encryptString(normalizeApiKey(apiKey));
    if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) throw new Error('Secure storage encryption failed.');
    return Buffer.from(encrypted).toString('base64');
  }

  function decryptApiKey(encryptedApiKey) {
    try {
      return normalizeApiKey(safeStorage.decryptString(Buffer.from(encryptedApiKey, 'base64')));
    } catch (error) {
      throw new Error('An additional tunnel runtime key is corrupted or cannot be decrypted.', { cause: error });
    }
  }

  return Object.freeze({
    list,
    runtimeConnections,
    upsert,
    remove,
    clear,
    statePath: () => filePath
  });
}

function publicConnection(connection) {
  return {
    tunnelId: connection.tunnelId,
    label: connection.label,
    enabled: connection.enabled !== false,
    apiKeyConfigured: Boolean(connection.encryptedApiKey)
  };
}

function normalizeLabel(value, tunnelId) {
  const text = String(value || '').replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return `ChatGPT ${String(tunnelId).slice(-8)}`;
  if (text.length > 80) throw new Error('Tunnel connection name must be 80 characters or fewer.');
  return text;
}

function readState(filePath) {
  if (!fs.existsSync(filePath)) return { version: STATE_VERSION, connections: [] };
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    validateState(state);
    return {
      version: STATE_VERSION,
      connections: state.connections.map(connection => ({
        tunnelId: normalizeTunnelId(connection.tunnelId),
        label: normalizeLabel(connection.label, connection.tunnelId),
        enabled: connection.enabled !== false,
        encryptedApiKey: String(connection.encryptedApiKey || '')
      }))
    };
  } catch (error) {
    throw new Error('Additional Secure MCP Tunnel settings are corrupted.', { cause: error });
  }
}

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Tunnel connection document is invalid.');
  if (state.version !== STATE_VERSION || !Array.isArray(state.connections) || state.connections.length > MAX_CONNECTIONS) {
    throw new Error('Tunnel connection document fields are invalid.');
  }
  const seen = new Set();
  for (const connection of state.connections) {
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new Error('Tunnel connection entry is invalid.');
    const tunnelId = normalizeTunnelId(connection.tunnelId);
    if (seen.has(tunnelId)) throw new Error('Tunnel connection document contains duplicate Tunnel IDs.');
    seen.add(tunnelId);
    if (typeof connection.encryptedApiKey !== 'string' || !connection.encryptedApiKey) throw new Error('Tunnel connection credential is missing.');
  }
}

function writeState(filePath, state) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temporary, 0o600); } catch {}
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function requireSafeStorage(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new TypeError('Electron safeStorage is required.');
  }
}

function ensureEncryptionAvailable(safeStorage) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable for OpenAI tunnel runtime keys.');
}

export { createTunnelConnectionStore };
