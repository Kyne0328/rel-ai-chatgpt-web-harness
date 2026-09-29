import { telemetryStatus } from './telemetry.js';
import { detectVerifyChecks } from './bridge/checkDetection.js';
import { getToolNames } from './tools/schema.js';
import { assertSafeWorkspaceRoot } from './workspaceSafety.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeReadJson, realRootOf, clearRealRootCache } from './safety.js';
import { discoverCommands } from './commandDiscovery.js';
import { readProjectInstructions, summarizeProjectInstructions } from './projectInstructions.js';
import { normalizeAllowedKeys } from './processEnvironment.js';
import { writeJsonAtomic } from './durableState.ts';
import { defaultStateDir } from './stateLayout.js';
import { z } from 'zod';
function getConfigPath() {
  return process.env.REL_AI_MCP_CONFIG || path.join(defaultStateDir(), "config.json");
}

function makeDefaultContextConfig() {
  return {
    snapshotMaxFiles: 3000,
    includeRoots: [],
    excludePaths: [
      ".git", "node_modules", "build", "dist", "coverage", ".next", ".nuxt", ".svelte-kit",
      ".dart_tool", ".gradle", "target", "obj", "vendor", ".venv", "venv",
      ".claude/skills", ".superpowers", ".rel-ai-mcp-state"
    ]
  };
}

function makeDefaultConfig() {
  return {
    version: 7,
    stateDir: defaultStateDir(),
    auditLogPath: "",
    trustedBudgetMultiplier: 2,
    productUx: {
      staleHours: 24,
      enableStateExport: true
    },
    knowledge: {
      maxBootstrapBytes: 4096
    },
    computerControl: {
      enabled: false
    },
    projectAccess: {
      directFilesystem: false
    },
    release: {
      minimumReadinessScore: 80,
      requireHttpToken: true
    },
    telemetry: {
      diagnosticsEnabled: true,
      endpoint: "",
      sampleRatio: 1
    },
    processEnvironment: {
      allow: []
    },
    workspaces: {}
  };
}

// Every tool call reads, parses, and normalizes config.json. The file changes rarely,
// so the normalized result is cached against the file's identity — a statSync (~0.02 ms)
// replaces the read+parse+normalize. Reusing one object also lets downstream callers
// memoize per-config work by object identity.
let configCache = null;
const CONFIG_CACHE_RECHECK_MS = 250;
const PUBLIC_CONFIG_SUMMARY_TTL_MS = 1000;
let publicConfigSummaryCache = null;

function readConfig(options = {}) {
  const configPath = getConfigPath();
  const now = Date.now();
  if (configCache
    && configCache.path === configPath
    && now - configCache.checkedAt < CONFIG_CACHE_RECHECK_MS) {
    return configCache.config;
  }
  let stat;
  try {
    // Nanosecond mtime, so two writes inside the same millisecond still invalidate.
    stat = fs.statSync(configPath, { bigint: true });
  } catch {
    configCache = null;
    if (options.allowMissing) return makeDefaultConfig();
    throw new Error(`Rel.AI MCP config not found: ${configPath}. Run: npm run init-config`);
  }
  if (configCache
    && configCache.path === configPath
    && configCache.mtimeNs === stat.mtimeNs
    && configCache.size === stat.size) {
    configCache.checkedAt = now;
    return configCache.config;
  }
  const parsed = safeReadJson(configPath);
  if (!parsed) throw new Error(`Config file is corrupted or empty: ${configPath}. Fix or re-run: npm run init-config`);
  const config = normalizeConfig(parsed);
  if (Number(parsed.version || 0) < config.version) {
    writeJsonAtomic(configPath, config, { mode: 0o600, backup: true });
    stat = fs.statSync(configPath, { bigint: true });
  }
  configCache = { path: configPath, mtimeNs: stat.mtimeNs, size: stat.size, checkedAt: Date.now(), config };
  return config;
}

// Drop every cached view of the config file. Callers that rewrite config.json through
// something other than writeConfig (tests, the dashboard editor) must call this so the
// next readConfig re-parses even if the filesystem timestamp did not move.
function invalidateConfigCache() {
  configCache = null;
  publicConfigSummaryCache = null;
  clearRealRootCache();
}

function writeConfig(config, options = {}) {
  const configPath = getConfigPath();
  if (options.overwrite === false && fs.existsSync(configPath)) {
    throw new Error(`Config already exists: ${configPath}`);
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const normalized = normalizeConfig(config);
  writeJsonAtomic(configPath, normalized, { mode: 0o600, backup: true });
  invalidateConfigCache();
  return normalized;
}

function ensureConfig() {
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      return readConfig();
    } catch (error) {
      if (!String(error?.message || '').startsWith('Config file is corrupted or empty:')) throw error;
      const invalidPath = `${configPath}.invalid-${Date.now()}`;
      try {
        fs.renameSync(configPath, invalidPath);
      } catch {
        throw error;
      }
      return writeConfig(makeDefaultConfig(), { overwrite: false });
    }
  }
  try {
    return writeConfig(makeDefaultConfig(), { overwrite: false });
  } catch (error) {
    // Another startup path may have created the file between the existence check
    // and the guarded write. In that case, use the newly created config.
    if (fs.existsSync(configPath)) return readConfig();
    throw error;
  }
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function normalizeConfig(config) {
  const base = makeDefaultConfig();
  const next = configSchema(base).parse(config);
  next.version = 7;
  next.stateDir = expandHome(next.stateDir || base.stateDir);
  if (!path.isAbsolute(next.stateDir)) next.stateDir = path.resolve(next.stateDir);
  next.auditLogPath = next.auditLogPath ? expandHome(next.auditLogPath) : path.join(next.stateDir, 'audit.jsonl');
  if (!path.isAbsolute(next.auditLogPath)) next.auditLogPath = path.resolve(next.auditLogPath);
  for (const [alias, workspace] of Object.entries(next.workspaces)) {
    next.workspaces[alias] = normalizeWorkspace(workspace);
  }
  return next;
}

function configSchema(base) {
  return objectSchema(z.object({
    version: z.unknown().optional(),
    stateDir: stringSchema(base.stateDir),
    auditLogPath: stringSchema(base.auditLogPath),
    trustedBudgetMultiplier: boundedIntegerFallbackSchema(1, 10, base.trustedBudgetMultiplier),
    productUx: objectSchema(z.object({
      staleHours: boundedIntegerSchema(1, 24 * 365, base.productUx.staleHours),
      enableStateExport: booleanSchema(base.productUx.enableStateExport)
    })),
    knowledge: objectSchema(z.object({
      maxBootstrapBytes: boundedIntegerSchema(1024, 16384, base.knowledge.maxBootstrapBytes)
    })),
    computerControl: objectSchema(z.object({
      enabled: booleanSchema(base.computerControl.enabled)
    })),
    projectAccess: objectSchema(z.object({
      directFilesystem: booleanSchema(base.projectAccess.directFilesystem)
    })),
    release: objectSchema(z.object({
      minimumReadinessScore: boundedIntegerSchema(0, 100, base.release.minimumReadinessScore),
      requireHttpToken: booleanSchema(base.release.requireHttpToken)
    })),
    telemetry: objectSchema(z.object({
      diagnosticsEnabled: booleanSchema(base.telemetry.diagnosticsEnabled),
      endpoint: stringSchema(base.telemetry.endpoint).transform(value => value.trim()),
      sampleRatio: boundedRatioSchema(base.telemetry.sampleRatio)
    })),
    processEnvironment: objectSchema(z.object({
      allow: z.any().optional().transform(value => normalizeAllowedKeys(value))
    })),
    workspaces: objectSchema(z.record(z.string(), workspaceConfigSchema()))
  }));
}

function workspaceConfigSchema() {
  return objectSchema(z.object({
    path: stringSchema(''),
    sourcePaths: stringListSchema([]),
    repoSlug: stringSchema(''),
    context: contextConfigSchema(),
    validationRules: objectSchema(z.record(z.string(), z.unknown()))
  }));
}

function contextConfigSchema() {
  const base = makeDefaultContextConfig();
  return objectSchema(z.object({
    snapshotMaxFiles: boundedIntegerSchema(1, 100000, base.snapshotMaxFiles),
    includeRoots: stringListSchema(base.includeRoots),
    excludePaths: stringListSchema(base.excludePaths)
  }));
}

function objectSchema(schema) {
  return z.preprocess(value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}, schema);
}

function stringSchema(fallback = '') {
  return z.preprocess(value => value == null ? fallback : String(value), z.string());
}

function booleanSchema(fallback) {
  return z.preprocess(value => {
    if (typeof value === 'boolean') return value;
    const text = String(value).toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return fallback;
  }, z.boolean());
}

function boundedIntegerSchema(min, max, fallback) {
  return z.preprocess(value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
  }, z.number().int().min(min).max(max));
}

function boundedIntegerFallbackSchema(min, max, fallback) {
  return z.preprocess(value => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) return fallback;
    return Math.floor(number);
  }, z.number().int().min(min).max(max));
}

function boundedRatioSchema(fallback) {
  return z.preprocess(value => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
  }, z.number().min(0).max(1));
}

function stringListSchema(fallback = []) {
  return z.preprocess(value => {
    if (value == null || value === '') return [...fallback];
    if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
    return String(value).split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  }, z.array(z.string()));
}

function normalizeWorkspace(workspace) {
  const parsed = workspaceConfigSchema().parse(workspace);
  const sourcePaths = normalizeWorkspaceSourcePaths(parsed);
  return {
    path: sourcePaths[0] || parsed.path,
    sourcePaths,
    repoSlug: parsed.repoSlug,
    context: parsed.context,
    validationRules: parsed.validationRules
  };
}

function normalizeWorkspaceSourcePaths(workspace) {
  const values = [workspace?.path, ...(Array.isArray(workspace?.sourcePaths) ? workspace.sourcePaths : stringListSchema([]).parse(workspace?.sourcePaths))]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const seen = new Set();
  return values.filter(value => {
    const key = normalizeWorkspacePathForComparison(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeContextConfig(value) {
  return contextConfigSchema().parse(value);
}

function workspaceResolutionError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.source = 'rel-ai-mcp-workspace';
  error.operation = 'workspace_resolution';
  error.retryable = false;
  error.requiresUserConfirmation = false;
  error.workspaceInput = details.workspaceInput == null ? '' : String(details.workspaceInput);
  error.workspaceInputSource = String(details.workspaceInputSource || 'tool_argument');
  error.workspaceMatchStatus = String(details.workspaceMatchStatus || 'unmatched');
  error.workspaceResolutionFailure = String(details.workspaceResolutionFailure || code.toLowerCase());
  error.configuredWorkspaceAliases = Array.isArray(details.configuredWorkspaceAliases)
    ? details.configuredWorkspaceAliases.map(String).slice(0, 100)
    : [];
  error.allowedAlternatives = error.configuredWorkspaceAliases.length
    ? [`Use one configured workspace alias: ${error.configuredWorkspaceAliases.join(', ')}.`]
    : ['Configure a workspace before starting a task.'];
  return error;
}

function resolveWorkspaceInput(config, input) {
  const aliases = allWorkspaceAliases(config);
  const omitted = input == null || String(input).trim() === '';
  const key = String(input || '').trim();
  if (omitted) return { input: '', alias: '', source: 'omitted', aliases };
  if (workspaceEntryForAlias(config, key)) return { input: key, alias: key, source: 'alias', aliases };
  if (!isAbsoluteWorkspaceInput(key)) return { input: key, alias: '', source: 'unmatched_alias', aliases };

  const inputCanonical = canonicalWorkspacePath(key);
  if (!inputCanonical) return { input: key, alias: '', source: 'path_unavailable', aliases };
  const matches = [];
  for (const alias of aliases) {
    const configuredCanonical = canonicalWorkspacePath(workspaceEntryForAlias(config, alias)?.path);
    if (configuredCanonical && configuredCanonical === inputCanonical) matches.push(alias);
  }
  if (matches.length > 1) {
    throw workspaceResolutionError('WORKSPACE_PATH_AMBIGUOUS', 'The supplied workspace path matches more than one configured workspace.', {
      workspaceInput: key,
      workspaceInputSource: 'configured_path',
      workspaceMatchStatus: 'ambiguous_configured_path_match',
      workspaceResolutionFailure: 'multiple_configured_workspaces_share_canonical_path',
      configuredWorkspaceAliases: matches
    });
  }
  return {
    input: key,
    alias: matches[0] || '',
    source: matches.length === 1 ? 'configured_path' : 'unmatched_path',
    aliases,
    canonicalPath: inputCanonical
  };
}

function isAbsoluteWorkspaceInput(value) {
  const text = String(value || '').trim();
  return path.isAbsolute(text) || path.win32.isAbsolute(text);
}

function canonicalWorkspacePath(value) {
  const text = String(value || '').trim();
  if (!text || !isAbsoluteWorkspaceInput(text)) return '';
  try {
    const resolved = fs.realpathSync.native ? fs.realpathSync.native(text) : fs.realpathSync(text);
    return normalizeWorkspacePathForComparison(resolved);
  } catch {
    return '';
  }
}

function normalizeWorkspacePathForComparison(value, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  let normalized = pathApi.normalize(String(value || ''));
  const rootLength = pathApi.parse(normalized).root.length;
  while (normalized.length > rootLength && /[\\/]$/.test(normalized)) normalized = normalized.slice(0, -1);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveWorkspace(config, alias) {
  const resolution = resolveWorkspaceInput(config, alias);
  const aliases = resolution.aliases;
  const omitted = resolution.source === 'omitted';
  const key = resolution.input;
  if (omitted) {
    throw workspaceResolutionError('WORKSPACE_INPUT_OMITTED', 'A configured workspace alias is required; the workspace argument was omitted.', {
      workspaceInput: '',
      workspaceMatchStatus: 'not_attempted',
      workspaceResolutionFailure: 'workspace_argument_omitted',
      configuredWorkspaceAliases: aliases
    });
  }
  if (key === '.') {
    throw workspaceResolutionError('WORKSPACE_AMBIGUOUS_RELATIVE_INPUT', "Workspace '.' is ambiguous and is not resolved against the server process directory. Pass a configured workspace alias.", {
      workspaceInput: key,
      workspaceMatchStatus: 'rejected_ambiguous_input',
      workspaceResolutionFailure: 'explicit_dot_has_no_authoritative_client_base',
      configuredWorkspaceAliases: aliases
    });
  }
  if (resolution.source === 'path_unavailable') {
    throw workspaceResolutionError('WORKSPACE_PATH_UNAVAILABLE', 'The supplied absolute workspace path does not exist or cannot be resolved.', {
      workspaceInput: key,
      workspaceInputSource: 'configured_path',
      workspaceMatchStatus: 'path_unavailable',
      workspaceResolutionFailure: 'workspace_path_missing_or_unreadable',
      configuredWorkspaceAliases: aliases
    });
  }
  if (resolution.source === 'unmatched_path') {
    throw workspaceResolutionError('WORKSPACE_PATH_NOT_CONFIGURED', 'The supplied path does not exactly match any configured workspace.', {
      workspaceInput: key,
      workspaceInputSource: 'configured_path',
      workspaceMatchStatus: 'no_configured_path_match',
      workspaceResolutionFailure: 'canonical_path_not_configured',
      configuredWorkspaceAliases: aliases
    });
  }
  if (resolution.source === 'unmatched_alias' && !isSafeWorkspaceAlias(key)) {
    throw workspaceResolutionError('WORKSPACE_ALIAS_INVALID', `Invalid workspace alias: ${key}`, {
      workspaceInput: key,
      workspaceMatchStatus: 'invalid_alias',
      workspaceResolutionFailure: 'workspace_alias_syntax_invalid',
      configuredWorkspaceAliases: aliases
    });
  }
  const resolvedAlias = resolution.alias || key;
  const entry = workspaceEntryForAlias(config, resolvedAlias);
  if (!entry) {
    throw workspaceResolutionError('WORKSPACE_NOT_CONFIGURED', `Workspace '${key}' is not configured.`, {
      workspaceInput: key,
      workspaceMatchStatus: 'no_configured_alias_match',
      workspaceResolutionFailure: 'workspace_alias_not_configured',
      configuredWorkspaceAliases: aliases
    });
  }
  assertSafeWorkspaceRoot(entry.path, `Workspace '${resolvedAlias}' path`);
  if (!fs.existsSync(entry.path)) throw new Error(`Workspace '${resolvedAlias}' path does not exist: ${entry.path}`);
  const realRoot = realRootOf(entry.path);
  assertSafeWorkspaceRoot(realRoot, `Workspace '${resolvedAlias}' resolved path`);
  return {
    alias: resolvedAlias,
    path: realRoot,
    sourcePaths: normalizeWorkspaceSourcePaths(entry),
    repoSlug: entry.repoSlug || "",
    context: normalizeContextConfig(entry.context),
    validationRules: entry.validationRules && typeof entry.validationRules === "object" ? entry.validationRules : {}
  };
}

function allWorkspaceAliases(config) {
  return Object.keys(config.workspaces || {}).sort((left, right) => left.localeCompare(right));
}

function workspaceEntryForAlias(config, alias) {
  return Object.hasOwn(config.workspaces || {}, alias) ? config.workspaces[alias] : null;
}

function isSafeWorkspaceAlias(value) {
  if (!value || value.length > 80) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (!isUpper && !isLower && !isDigit && ch !== '.' && ch !== '_' && ch !== '-') return false;
  }
  return true;
}

function publicConfigSummary(config) {
  const now = Date.now();
  if (publicConfigSummaryCache?.config === config && publicConfigSummaryCache.expiresAt > now) {
    return publicConfigSummaryCache.value;
  }
  const value = {
    configPath: getConfigPath(),
    stateDir: config.stateDir,
    auditLogPath: config.auditLogPath,
    localRepoBridge: {
      mode: "trusted",
      visibleTools: getToolNames(config),
      writeAccess: true,
      verificationAccess: true,
      restoreAccess: true
    },
    productUx: config.productUx,
    knowledge: config.knowledge,
    computerControl: config.computerControl,
    projectAccess: config.projectAccess,
    release: config.release,
    telemetry: telemetryStatus(config),
    workspaces: Object.entries(config.workspaces || {}).map(([alias, entry]) => {
      const discovered = safeDiscoverCommands(entry.path);
      const validationCommands = safeDetectValidationChecks(entry.path);
      const projectInstructions = summarizeProjectInstructions(readProjectInstructions({ alias, path: entry.path }));
      return {
        alias,
        path: entry.path,
        sourcePaths: normalizeWorkspaceSourcePaths(entry),
        repoSlug: entry.repoSlug || "",
        context: normalizeContextConfig(entry.context),
        discoveredCommands: discovered,
        validationCommands,
        projectInstructions,
        discoveredTestCommandKeys: Object.keys(discovered).filter((key) => /test|analy[sz]e|lint|check|vet|build/.test(key + " " + discovered[key])).sort((a, b) => a.localeCompare(b))
      };
    }).sort((a, b) => a.alias.localeCompare(b.alias))
  };
  publicConfigSummaryCache = { config, value, expiresAt: now + PUBLIC_CONFIG_SUMMARY_TTL_MS };
  return value;
}

// publicConfigSummary runs on every dashboard poll and calls these per workspace.
// Both discoverCommands and detectVerifyChecks now cache against a stat signature of
// every manifest they understand, so these wrappers only add the missing-path guard
// and keep a discovery failure from breaking the whole summary.
function safeDiscoverCommands(workspacePath) {
  try {
    if (!workspacePath || !fs.existsSync(workspacePath)) return {};
    return discoverCommands(workspacePath);
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] discover commands:', error);
    return {};
  }
}

function safeDetectValidationChecks(workspacePath) {
  try {
    if (!workspacePath || !fs.existsSync(workspacePath)) return [];
    return detectVerifyChecks(workspacePath, 'standard');
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] detect validation checks:', error);
    return [];
  }
}

export { getConfigPath, makeDefaultConfig, makeDefaultContextConfig, readConfig, invalidateConfigCache, ensureConfig, writeConfig, normalizeConfig, resolveWorkspaceInput, normalizeWorkspacePathForComparison, resolveWorkspace, publicConfigSummary, allWorkspaceAliases };

