import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const STATE_VERSION = 1;
const STATE_FILE = 'openai-tunnel-credentials.json';

function createTunnelCredentialStore({
  stateDir = process.env.REL_AI_MCP_STATE_DIR || path.join(os.homedir(), '.rel-ai-mcp'),
  safeStorage
} = {}) {
  requireSafeStorage(safeStorage);
  const filePath = path.join(path.resolve(String(stateDir)), STATE_FILE);

  function status() {
    if (!fs.existsSync(filePath)) return { apiKeyConfigured: false };
    try {
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      validateDiskState(disk);
      return { apiKeyConfigured: true };
    } catch {
      return { apiKeyConfigured: false };
    }
  }

  function getApiKey() {
    if (!fs.existsSync(filePath)) return '';
    ensureEncryptionAvailable(safeStorage);
    try {
      const disk = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      validateDiskState(disk);
      const decrypted = safeStorage.decryptString(Buffer.from(disk.encryptedApiKey, 'base64'));
      return normalizeApiKey(decrypted);
    } catch (error) {
      throw new Error('OpenAI tunnel runtime key is corrupted or cannot be decrypted.', { cause: error });
    }
  }

  function setApiKey(value) {
    const apiKey = normalizeApiKey(value);
    ensureEncryptionAvailable(safeStorage);
    const encrypted = safeStorage.encryptString(apiKey);
    if (!Buffer.isBuffer(encrypted) && !(encrypted instanceof Uint8Array)) throw new Error('Secure storage encryption failed.');
    writeState(filePath, {
      version: STATE_VERSION,
      encryptedApiKey: Buffer.from(encrypted).toString('base64')
    });
    return { apiKeyConfigured: true };
  }

  function clear() {
    fs.rmSync(filePath, { force: true });
    return { apiKeyConfigured: false };
  }

  // Internal rollback evidence stays encrypted, including an unreadable record.
  function capture() {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
  }

  function restore(snapshot) {
    if (snapshot === null) clear();
    else {
      if (!Buffer.isBuffer(snapshot)) throw new TypeError('Encrypted credential snapshot is required.');
      writeStateBytes(filePath, snapshot);
    }
    const actual = capture();
    if (snapshot === null ? actual !== null : !actual?.equals(snapshot)) throw new Error('Previous tunnel credential was not restored.');
  }

  return Object.freeze({ status, getApiKey, setApiKey, clear, capture, restore, statePath: () => filePath });
}

function configureTunnelSafeStorage({ safeStorage, platform = process.platform, passwordStore = '' } = {}) {
  requireSafeStorage(safeStorage);
  if (platform !== 'linux' || String(passwordStore).trim().toLowerCase() !== 'basic') return false;
  if (typeof safeStorage.setUsePlainTextEncryption !== 'function') {
    throw new Error('Electron safeStorage does not support the explicitly requested basic password store.');
  }
  safeStorage.setUsePlainTextEncryption(true);
  return true;
}

function normalizeApiKey(value) {
  const text = String(value || '').trim();
  if (text.length < 12 || text.length > 4096 || /\s/.test(text) || hasControlCharacter(text)) {
    throw new Error('OpenAI tunnel runtime API key is invalid.');
  }
  return text;
}

function hasControlCharacter(value) {
  return [...String(value || '')].some(character => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function validateDiskState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Credential document is invalid.');
  if (value.version !== STATE_VERSION || typeof value.encryptedApiKey !== 'string' || !value.encryptedApiKey) {
    throw new Error('Credential document fields are invalid.');
  }
}

function writeState(filePath, disk) {
  writeStateBytes(filePath, Buffer.from(`${JSON.stringify(disk, null, 2)}\n`, 'utf8'));
}

function writeStateBytes(filePath, bytes) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
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
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is unavailable for the OpenAI tunnel runtime key.');
}

export { configureTunnelSafeStorage, createTunnelCredentialStore, normalizeApiKey };
