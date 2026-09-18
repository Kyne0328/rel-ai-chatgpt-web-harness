'use strict';

import * as path from 'node:path';

const SAFE_INHERITED_KEYS = Object.freeze([
  'ALLUSERSPROFILE',
  'APPDATA',
  'CI',
  'COLORTERM',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'ComSpec',
  'DriverData',
  'GIT_EXEC_PATH',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LOCALAPPDATA',
  'LOGONSERVER',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PSModulePath',
  'PUBLIC',
  'SHELL',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TERM_PROGRAM',
  'TMP',
  'TMPDIR',
  'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE',
  'USERNAME',
  'USERPROFILE',
  'windir'
]);

const CREDENTIAL_INHERITED_KEYS = Object.freeze([
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'SSH_AGENT_PID',
  'SSH_AUTH_SOCK'
]);

const SERVICE_INHERITED_KEYS = Object.freeze([
  ...SAFE_INHERITED_KEYS,
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'REL_AI_MCP_CONFIG',
  'REL_AI_MCP_DEBUG',
  'REL_AI_MCP_GIT',
  'REL_AI_MCP_MAX_BODY_BYTES',
  'REL_AI_MCP_MAX_TOOL_RESULT_BYTES',
  'REL_AI_MCP_MAX_TOOL_RESULT_CHARS',
  'REL_AI_MCP_MAX_TOOL_TEXT_BYTES',
  'REL_AI_MCP_PORT',
  'REL_AI_MCP_STATE_DIR',
  'REL_AI_MCP_TASK_IDLE_MS',
  'REL_AI_MCP_WORKSPACE_STATE_TTL_MS',
  'REL_AI_OTEL_EXPORTER_OTLP_ENDPOINT',
  'REL_AI_OTEL_SAMPLE_RATIO',
  'REL_AI_REQUEST_STATE_KEY',
  'REL_AI_UI_CHROMIUM_PATH',
  'REL_AI_ZOEKT_INDEX',
  'REL_AI_ZOEKT_SEARCH',
  'npm_execpath'
]);

const TUNNEL_INHERITED_KEYS = Object.freeze([
  'ALL_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'windir'
]);

const ALWAYS_BLOCKED_KEYS = Object.freeze(new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS'
]));

function makeProcessEnvironment(extra = {}, options = {}) {
  const inheritedKeys = new Set(SAFE_INHERITED_KEYS);
  if (options.inheritCredentials === true) {
    for (const key of CREDENTIAL_INHERITED_KEYS) inheritedKeys.add(key);
  }
  for (const key of normalizeAllowedKeys(options.allow)) inheritedKeys.add(key);
  return buildProcessEnvironment(extra, inheritedKeys, {
    ...options,
    preferRuntimeDirectoryOnPath: true
  });
}

function makeServiceProcessEnvironment(extra = {}, options = {}) {
  const inheritedKeys = new Set(SERVICE_INHERITED_KEYS);
  for (const key of normalizeAllowedKeys(options.allow)) inheritedKeys.add(key);
  return buildProcessEnvironment(extra, inheritedKeys, options);
}

function makeTunnelProcessEnvironment(extra = {}, options = {}) {
  return buildProcessEnvironment(extra, TUNNEL_INHERITED_KEYS, options);
}

function buildProcessEnvironment(extra, inheritedKeys, options) {
  const source = options.source && typeof options.source === 'object' ? options.source : process.env;
  const env = {};
  for (const key of inheritedKeys) {
    if (isAlwaysBlockedKey(key)) continue;
    if (source[key] != null) env[key] = String(source[key]);
  }
  if (options.preferRuntimeDirectoryOnPath === true && process.platform === 'win32' && env.PATH) {
    const runtimeDirectory = path.dirname(process.execPath);
    const runtimeKey = runtimeDirectory.toLowerCase();
    const inheritedPath = String(env.PATH)
      .split(path.delimiter)
      .filter(Boolean)
      .filter(entry => path.resolve(entry).toLowerCase() !== runtimeKey);
    env.PATH = [runtimeDirectory, ...inheritedPath].join(path.delimiter);
  }
  const appendedPath = normalizePathEntries(options.pathAppend);
  if (appendedPath.length) {
    const existingPath = String(env.PATH || '').split(path.delimiter).filter(Boolean);
    const seen = new Set(existingPath.map(pathKey));
    const additions = appendedPath.filter(entry => {
      const key = pathKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    env.PATH = [...existingPath, ...additions].join(path.delimiter);
  }
  env.REL_AI_MCP = '1';

  for (const [key, value] of Object.entries(extra || {})) {
    if (isAlwaysBlockedKey(key) && options.allowDangerous !== true) {
      throw new Error(`${key} cannot be passed to child processes.`);
    }
    env[key] = String(value);
  }
  return env;
}

function isAlwaysBlockedKey(key) {
  const value = String(key || '');
  const canonical = process.platform === 'win32' ? value.toUpperCase() : value;
  return ALWAYS_BLOCKED_KEYS.has(canonical);
}

function normalizePathEntries(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .map(item => path.resolve(item)))];
}

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeAllowedKeys(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return [...new Set(items.map(item => String(item || '').trim()).filter(isValidEnvironmentKey))];
}

function isValidEnvironmentKey(key) {
  return Boolean(key) && !key.includes('=') && !key.includes('\0');
}

export {
  makeProcessEnvironment,
  makeServiceProcessEnvironment,
  makeTunnelProcessEnvironment,
  normalizeAllowedKeys
};
