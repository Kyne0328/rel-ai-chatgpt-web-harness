import { workspaceMutationSafetySummary } from './mutationProcessOwnership.js';
import { getToolSchemas } from './tools.js';
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { publicConfigSummary, resolveWorkspace, getConfigPath, makeDefaultConfig } from "./config.js";
import { resolvePolicy } from "./policyResolver.js";
import { readAudit } from './audit.js';
import { getStateDir } from './statePaths.js';
import { runProcess, summarizeCommand } from "./process.js";
import { safeReadJson, validateRelativePath } from "./safety.js";

function dashboardData(config, args = {}) {
  const limit = clampNumber(args.limit || 100, 1, 500);
  const auditLimit = Math.min(limit, 200);
  const auditSource = readAudit(config, { limit: Math.max(auditLimit, 500) });
  const auditTail = { ...auditSource, entries: auditSource.entries.slice(-auditLimit) };
  const health = healthMonitor(config, { limit: 25 });
  const configSummary = publicConfigSummary(config);
  const cs = cautionSummary(config, { windowHours: 24, limit: 500, entries: auditSource.entries });
  const cautionByAlias = new Map(cs.workspaces.map((w) => [w.alias, w]));
  if (Array.isArray(configSummary.workspaces)) {
    for (const ws of configSummary.workspaces) {
      ws.sessionPolicy = resolvePolicy({ alias: ws.alias }, config);
      const c = cautionByAlias.get(ws.alias);
      ws.caution = { count: c ? c.count : 0, recent: c ? c.recent : [] };
    }
  }
  // Read the active connector registry so the dashboard never hardcodes tool names.
  let tools = Array.isArray(configSummary.localRepoBridge?.visibleTools) ? configSummary.localRepoBridge.visibleTools : [];
  try { tools = getToolSchemas().map((tool) => tool.name); } catch (error) { if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] tool schema discovery:', error); }
  const toolCount = tools.length;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: configSummary,
    toolCount,
    counts: {
      auditEntries: auditTail.entries?.length || 0,
      workspaces: configSummary.workspaces?.length || 0
    },
    tools,
    health,
    auditTail
  };
}

function liveLogTail(config, args = {}) {
  const limit = clampNumber(args.limit || 100, 1, 1000);
  const audit = readAudit(config, { limit });
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: config.auditLogPath,
    entries: audit.entries || [],
    count: audit.entries?.length || 0
  };
}

function healthMonitor(config, _args = {}) {
  const findings = [];
  const stateDir = getStateDir(config);
  checkDir(findings, "stateDir", stateDir, true);
  checkFile(findings, "config", getConfigPath(), false);

  const staleHours = Number(config.productUx?.staleHours || 24);
  checkStaleFile(findings, "audit", config.auditLogPath, staleHours);
  const aliases = Object.keys(config.workspaces || {}).sort(compareText);
  const workspaces = aliases.map((alias) => {
    const mutationBlock = workspaceMutationSafetySummary(config, alias, config.workspaces?.[alias]?.path || '');
    if (mutationBlock) findings.push({ severity: 'error', code: 'workspace_mutation_blocked', workspace: alias, message: mutationBlock.message, mutationBlock });
    try {
      const workspace = resolveWorkspace(config, alias);
      return { alias, ok: true, path: workspace.path, context: workspace.context || {}, mutationBlock };
    } catch (error) {
      findings.push({ severity: "error", code: "workspace_unavailable", workspace: alias, message: error instanceof Error ? error.message : String(error) });
      return { alias, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const orderedFindings = [...findings].sort(compareHealthFindings);

  return {
    ok: !orderedFindings.some((item) => item.severity === "error"),
    generatedAt: new Date().toISOString(),
    staleHours,
    stateDir,
    workspaces,
    counts: {
      workspaces: workspaces.length,
      findings: orderedFindings.length
    },
    findings: orderedFindings
  };
}

function checkStaleFile(findings, name, file, staleHours) {
  if (!file || !fs.existsSync(file)) return;
  try {
    const stat = fs.statSync(file);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
    if (ageHours > staleHours) {
      findings.push({
        severity: "warning",
        code: `${name}_stale`,
        message: `${name} has not changed for ${Math.floor(ageHours)} hours.`,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  } catch (error) {
    findings.push({ severity: "warning", code: `${name}_stat_failed`, message: error instanceof Error ? error.message : String(error) });
  }
}




async function doctorFix(config, args = {}) {
  const fixes = [];
  const workspacePath = args.workspacePath ? existingDirectoryPath(args.workspacePath, "workspacePath") : "";
  if (workspacePath) {
    if (!fs.existsSync(workspacePath)) throw new Error(`workspacePath does not exist: ${workspacePath}`);
    const attrs = path.join(workspacePath, ".gitattributes");
    const editor = path.join(workspacePath, ".editorconfig");
    if (!fs.existsSync(attrs) || args.overwrite === true) {
      fs.writeFileSync(attrs, "* text=auto eol=lf\n*.bat text eol=crlf\n*.cmd text eol=crlf\n", "utf8");
      fixes.push({ path: attrs, action: "wrote .gitattributes" });
    }
    if (!fs.existsSync(editor) || args.overwrite === true) {
      fs.writeFileSync(editor, "root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\nindent_style = space\nindent_size = 2\n\n[*.{bat,cmd}]\nend_of_line = crlf\n", "utf8");
      fixes.push({ path: editor, action: "wrote .editorconfig" });
    }
    if (args.renormalize === true) {
      const result = await runProcess("git", ["add", "--renormalize", "."], { cwd: workspacePath, local: false }, config);
      fixes.push({ action: "git add --renormalize .", result: summarizeCommand(result) });
    }
  }
  fs.mkdirSync(getStateDir(config), { recursive: true, mode: 0o700 });
  fixes.push({ path: getStateDir(config), action: "ensured stateDir" });
  return { ok: true, fixes, message: fixes.length ? "Doctor fixes completed." : "Nothing to fix." };
}

function setupWizard(args = {}) {
  const workspacePath = args.workspacePath ? path.resolve(String(args.workspacePath)) : "";
  const alias = String(args.alias || "myapp").trim();
  const token = args.generateToken === false ? "" : crypto.randomBytes(24).toString("hex");
  const config = makeDefaultConfig();
  if (workspacePath) config.workspaces[alias] = { path: workspacePath };
  const startCmd = setupStartCommand(token);
  return {
    ok: true,
    configPath: getConfigPath(),
    suggestedToken: token,
    config,
    nextCommands: [
      "npm run init-config",
      workspacePath ? `npm run workspace:add -- ${alias} ${workspacePath}` : "npm run workspace:add -- myapp /absolute/path/to/project",
      startCmd
    ]
  };
}

function setupStartCommand(token) {
  if (!token) return "npm run start:http -- --host 127.0.0.1 --port 3333";
  if (process.platform === "win32") {
    return `$env:REL_AI_MCP_TOKEN='${token}'; npm run start:http -- --host 127.0.0.1 --port 3333`;
  }
  return `REL_AI_MCP_TOKEN=${token} npm run start:http -- --host 127.0.0.1 --port 3333`;
}

function assertJsonFileExtension(filePath, label) {
  if (path.extname(filePath).toLowerCase() !== ".json") {
    throw new Error(`${label} must point to a .json file: ${filePath}`);
  }
}

function canonicalBaseDir(baseDir) {
  const realBase = fs.realpathSync(baseDir);
  return realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
}

function existingDirectoryPath(rawPath, label, baseDir = process.cwd()) {
  const base = canonicalBaseDir(baseDir);
  const relativePath = validateRelativePath(String(rawPath || ""));
  const candidate = path.join(base, relativePath);
  const realPath = fs.realpathSync(candidate);
  if (!realPath.startsWith(base)) throw new Error(`${label} escapes allowed directory: ${rawPath}`);
  if (!fs.statSync(realPath).isDirectory()) throw new Error(`${label} is not a directory: ${realPath}`);
  return realPath;
}

function relativeJsonPath(rawPath, label) {
  const relativePath = validateRelativePath(String(rawPath || ""));
  assertJsonFileExtension(relativePath, label);
  return relativePath;
}

function existingReadableJsonPath(rawPath, label, baseDir = process.cwd()) {
  const base = canonicalBaseDir(baseDir);
  const candidate = path.join(base, relativeJsonPath(rawPath, label));
  const realPath = fs.realpathSync(candidate);
  if (!realPath.startsWith(base)) throw new Error(`${label} escapes allowed directory: ${rawPath}`);
  if (!fs.statSync(realPath).isFile()) throw new Error(`${label} is not a file: ${realPath}`);
  return realPath;
}

function writableJsonPath(rawPath, label, baseDir = process.cwd()) {
  const base = canonicalBaseDir(baseDir);
  const relativePath = relativeJsonPath(rawPath, label);
  const target = path.join(base, relativePath);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = fs.realpathSync(parent);
  if (!realParent.startsWith(base)) throw new Error(`${label} escapes allowed directory: ${rawPath}`);
  return path.join(realParent, path.basename(relativePath));
}

const STATE_EXPORT_VERSION = 2;

function stateExport(config, args = {}) {
  if (config.productUx?.enableStateExport === false) {
    throw new Error("State export is disabled (productUx.enableStateExport=false).");
  }
  const stateDir = getStateDir(config);
  const maxFiles = clampNumber(args.maxFiles || 2000, 1, 20000);
  const maxFileBytes = args.maxFileBytes == null
    ? Number.POSITIVE_INFINITY
    : clampNumber(args.maxFileBytes, 1000, 10 * 1024 * 1024);
  const files = [];
  walkState(stateDir, stateDir, files, maxFiles, maxFileBytes);
  const payload = { version: STATE_EXPORT_VERSION, exportedAt: new Date().toISOString(), stateDir, files };
  if (args.outputPath) {
    const out = writableJsonPath(args.outputPath, "outputPath");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    return { ok: true, outputPath: out, fileCount: files.length };
  }
  return { ok: true, fileCount: files.length, export: payload };
}

function stateImport(config, args = {}) {
  if (args.confirm !== true) throw new Error("stateImport requires confirm=true.");
  let payload = args.payload;
  if (args.inputPath) {
    const inputPath = existingReadableJsonPath(args.inputPath, "inputPath");
    payload = safeReadJson(inputPath);
    if (!payload) throw new Error(`State import file is corrupted or empty: ${inputPath}`);
  }
  if (payload?.version !== STATE_EXPORT_VERSION) {
    throw new Error(`Unsupported state import version: ${payload?.version ?? "missing"}. Expected ${STATE_EXPORT_VERSION}.`);
  }
  if (!Array.isArray(payload.files)) throw new Error("State import payload must contain a files array.");

  const entries = payload.files.map((item, index) => {
    if (!item?.path || typeof item.content !== "string") {
      throw new Error(`State import file entry ${index + 1} is invalid.`);
    }
    return {
      relative: validateRelativePath(String(item.path)),
      content: decodeStateFile(item)
    };
  });

  const stateDir = getStateDir(config);
  const stateParent = path.dirname(stateDir);
  const stateName = path.basename(stateDir);
  fs.mkdirSync(stateParent, { recursive: true, mode: 0o700 });
  const stagingDir = fs.mkdtempSync(path.join(stateParent, `.${stateName}.import-`));
  const backupDir = path.join(stateParent, `.${stateName}.backup-${process.pid}-${Date.now()}`);
  let existingMoved = false;
  let promoted = false;

  try {
    if (fs.existsSync(stateDir)) fs.cpSync(stateDir, stagingDir, { recursive: true, force: true });
    for (const entry of entries) {
      const target = path.resolve(stagingDir, entry.relative);
      const parent = path.dirname(target);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const realParent = fs.realpathSync(parent);
      if (!isPathContained(stagingDir, realParent)) throw new Error(`Unsafe state path: ${entry.relative}`);
      fs.writeFileSync(path.join(realParent, path.basename(entry.relative)), entry.content, { mode: 0o600 });
    }

    if (fs.existsSync(stateDir)) {
      fs.renameSync(stateDir, backupDir);
      existingMoved = true;
    }
    try {
      fs.renameSync(stagingDir, stateDir);
      promoted = true;
    } catch (error) {
      if (existingMoved && !fs.existsSync(stateDir)) fs.renameSync(backupDir, stateDir);
      throw error;
    }
    if (existingMoved) fs.rmSync(backupDir, { recursive: true, force: true });
  } finally {
    if (!promoted) fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  const written = entries.map(entry => entry.relative);
  return { ok: true, stateDir, writtenCount: written.length, written: written.slice(0, 200) };
}

function isPathContained(baseDir, candidate) {
  const relative = path.relative(fs.realpathSync(baseDir), candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function checkDir(findings, name, dir, createSuggested) {
  if (!dir) return findings.push({ severity: "error", code: `${name}_missing`, message: `${name} is not configured.` });
  if (!fs.existsSync(dir)) return findings.push({ severity: createSuggested ? "warning" : "error", code: `${name}_not_found`, message: `${name} does not exist: ${dir}` });
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) findings.push({ severity: "error", code: `${name}_not_directory`, message: `${name} is not a directory: ${dir}` });
  } catch (error) {
    findings.push({ severity: "error", code: `${name}_stat_failed`, message: error instanceof Error ? error.message : String(error) });
  }
}

function checkFile(findings, name, file, optional) {
  if (!fs.existsSync(file) && !optional) findings.push({ severity: "error", code: `${name}_missing`, message: `${name} file does not exist: ${file}` });
}


// Recursively find directories whose name matches `namePattern` and whose mtime is
// older than the cutoff (e.g. abandoned staged-edit payload dirs).

function walkState(root, current, files, maxFiles, maxFileBytes) {
  if (!fs.existsSync(current)) return;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    const relative = path.relative(root, full).replaceAll(path.win32.sep, "/");
    if (entry.isSymbolicLink()) throw new Error(`State export does not support symbolic links: ${relative}`);
    if (entry.isDirectory()) {
      walkState(root, full, files, maxFiles, maxFileBytes);
      continue;
    }
    if (files.length >= maxFiles) throw new Error(`State export exceeds the maximum file count of ${maxFiles}.`);
    const stat = fs.statSync(full);
    if (stat.size > maxFileBytes) {
      throw new Error(`State export file exceeds the maximum size of ${maxFileBytes} bytes: ${relative}`);
    }
    const bytes = fs.readFileSync(full);
    const text = bytes.toString("utf8");
    const utf8 = Buffer.from(text, "utf8").equals(bytes);
    files.push(utf8
      ? { path: relative, modifiedAt: stat.mtime.toISOString(), content: text }
      : { path: relative, modifiedAt: stat.mtime.toISOString(), encoding: "base64", content: bytes.toString("base64") });
  }
}

function decodeStateFile(item) {
  const encoding = String(item?.encoding || "utf8").trim().toLowerCase();
  if (encoding === "utf8") return String(item.content || "");
  if (encoding !== "base64") throw new Error(`Unsupported state file encoding: ${encoding}`);
  const content = String(item.content || "");
  const decoded = Buffer.from(content, "base64");
  if (decoded.toString("base64") !== content) throw new Error(`Invalid base64 state content for ${item.path || "unknown file"}.`);
  return decoded;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function compareText(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'en-US', { numeric: true, sensitivity: 'base' });
}

function compareHealthFindings(left, right) {
  return healthSeverityRank(left?.severity) - healthSeverityRank(right?.severity)
    || compareText(left?.workspace, right?.workspace)
    || compareText(left?.code, right?.code);
}

function healthSeverityRank(value) {
  if (value === 'error') return 0;
  if (value === 'warning') return 1;
  return 2;
}

function auditTimestamp(entry) {
  const timestamp = Date.parse(entry?.ts || entry?.at || entry?.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function cautionSummary(config, options = {}) {
  const windowHours = clampNumber(options.windowHours || 24, 1, 720);
  const limit = clampNumber(options.limit || 200, 1, 2000);
  const cutoffMs = Date.now() - windowHours * 3600000;
  const sourceEntries = Array.isArray(options.entries)
    ? options.entries.slice(-limit)
    : readAudit(config, { limit }).entries;
  const entries = [...(sourceEntries || [])].sort((left, right) => auditTimestamp(right) - auditTimestamp(left));
  const byAlias = {};
  for (const e of entries || []) {
    if (e?.cautionLevel !== "caution") continue;
    const ts = Date.parse(e.ts || "");
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const alias = e.workspace || "__unknown__";
    if (!byAlias[alias]) byAlias[alias] = { alias, count: 0, recent: [] };
    byAlias[alias].count += 1;
    if (byAlias[alias].recent.length < 5) {
      byAlias[alias].recent.push({
        tool: e.tool,
        ts: e.ts || null,
        reason: e.cautionReason || null,
        taskId: e.taskId || null,
        path: e.filePath || e.path || null
      });
    }
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowHours,
    workspaces: Object.values(byAlias).sort((left, right) => compareText(left.alias, right.alias))
  };
}

export { dashboardData, liveLogTail, healthMonitor, cautionSummary, doctorFix, setupWizard, stateExport, stateImport };
