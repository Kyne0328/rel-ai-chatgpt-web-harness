import * as fs from 'node:fs';
import * as path from 'node:path';
import { packageMetadata, packageRoot } from '../packageMetadata.js';
import { resolveWorkspace, allWorkspaceAliases } from '../config.js';
import { collectTextFiles, collectOptionsFromWorkspace, resolveSafePath } from '../safety.js';
import { commandDiscoveryWarnings, discoverCommands } from '../commandDiscovery.js';
import { summarizeOperations } from '../journal.js';
import { resolvePolicy } from '../policyResolver.js';
import { getVersion } from '../version.js';
import { debugSwallow } from './session.js';
import * as toolSchema from './schema.js';
import { readProjectInstructions, summarizeProjectInstructions } from '../projectInstructions.js';
import { workspaceGitStatus } from '../repo/gitOps.js';
import { runtimeCompatibility } from '../runtimeCompatibility.js';
import { getToolActivity } from '../toolActivity.js';
import { fallbackExecutionStatus } from '../mcp/fallbackExecutions.js';
import { authorizedWorkspaceAliases } from '../mcp/authorizationPolicy.js';
import { readTaskHistorySessionRecord } from '../taskHistoryStore.ts';
import { compactSessionSummary } from '../context/session-compactor.js';
import { compactActiveRelatedWork } from '../context/activeRelatedWork.js';
import { buildTaskContinuity } from '../context/taskContinuity.js';
// Locale-aware sort of an object's keys so ordering remains explicit and stable.
function sortedKeys(obj) {
  return Object.keys(obj || {}).sort((a, b) => a.localeCompare(b));
}

async function relaiStatus(config, args = {}, context = {}) {
  // The server's own scripts and the CI cross-check are local diagnostics: the
  // connector result strips both. Skipping them for connector calls avoids reading
  // package.json plus every .github/workflows file on a path ChatGPT hits constantly.
  const localDiagnostics = context?.connector !== true;
  const scripts = localDiagnostics ? (safeReadPackageJson().scripts || {}) : {};
  const ci = localDiagnostics ? ciScriptStatus(scripts) : null;
  const configuredWorkspaceAliases = allWorkspaceAliases(config);
  const workspaceAliases = context?.connector === true
    ? authorizedWorkspaceAliases(context.principal, configuredWorkspaceAliases)
    : configuredWorkspaceAliases;
  const backgroundReference = String(args.operationId || args.work_id || '').trim();
  const backgroundOperation = backgroundReference ? fallbackExecutionStatus(backgroundReference, { config }) : null;
  const compactConnectorStatus = context?.connector === true && args.detail !== 'full' && args.maxBytes == null;
  let selectedWorkspace = null;
  if (args.workspace) {
    try {
      const workspace = resolveWorkspace(config, args.workspace);
      if (context.backgroundStatusMode === true || compactConnectorStatus) {
        // Control-plane status must stay cheap and must not queue behind repository
        // inspection. Full repository state remains available through detail:'full'.
        selectedWorkspace = { alias: workspace.alias };
      } else {
        const discovered = discoverCommands(workspace.path);
        const discoveryWarnings = commandDiscoveryWarnings(workspace.path);
        selectedWorkspace = {
          alias: workspace.alias,
          root: workspace.path,
          discoveredCommandKeys: sortedKeys(discovered),
          ...(discoveryWarnings.length > 0 ? { discoveryWarnings } : {}),
          policy: resolvePolicy(workspace, config),
          repository: await workspaceGitStatus(workspace, config, { maxBytes: args.maxBytes, work_id: args.work_id })
        };
      }
    } catch (error) {
      selectedWorkspace = { alias: String(args.workspace), error: error instanceof Error ? error.message : String(error) };
    }
  }
  const { getToolNames, getToolGroups, getToolSurfaceManifest } = toolSchema;
  const taskActivity = typeof context.getTaskActivity === 'function' ? context.getTaskActivity() : getToolActivity();
  const taskSession = args.work_id ? readTaskHistorySessionRecord(config, args.work_id, { reconcileInactive: false }) : null;
  const activeRelatedWork = compactActiveRelatedWork(taskActivity, taskSession || {});
  const taskQuery = taskSession ? [taskSession.objective, taskSession.title].filter(Boolean).join(' ') : '';
  const taskContinuity = !compactConnectorStatus && taskSession && taskQuery
    ? buildTaskContinuity(config, {
        workspace: taskSession.workspace,
        query: taskQuery,
        excludeTaskId: args.work_id,
        conversationId: taskSession.correlation?.conversationId
      })
    : {};
  const compatibility = runtimeCompatibility(config, {
    workspace: args.workspace,
    activeTaskCount: taskActivity.activeTaskCount
  });
  return {
    ok: true,
    version: getVersion(),
    runtime: compatibility.runtime,
    ...(compatibility.repository ? { repositoryRuntime: compatibility.repository } : {}),
    runtimeCompatibility: compatibility.compatibility,
    tools: getToolNames(config),
    toolGroups: getToolGroups(config),
    toolSurface: getToolSurfaceManifest(config),
    ...(localDiagnostics ? { scripts: sortedKeys(scripts), ci } : {}),
    workspace: selectedWorkspace,
    ...(args.work_id ? { work_id: String(args.work_id) } : {}),
    ...(args.operationId ? { operationId: String(args.operationId) } : {}),
    ...(args.work_id ? { task: compactSessionSummary(taskSession || {}, { continuity: taskContinuity }) } : {}),
    ...(activeRelatedWork.length ? { activeRelatedWork } : {}),
    ...(backgroundOperation ? { backgroundOperation } : {}),
    workspaceCount: workspaceAliases.length,
    workspaceAliases
  };
}

function ciScriptStatus(scripts) {
  // Resolve workflows relative to THIS server's package root (__dirname/..), not
  // process.cwd(). When launched from the packaged launcher, cwd is the launcher
  // directory, so a cwd-based scan found no workflows and silently reported ok:true.
  // This keeps the CI scan on the same basis as safeReadPackageJson (the scripts it
  // is checked against).
  const projectRoot = packageRoot;
  const workflowDir = path.join(projectRoot, ".github", "workflows");
  const missing = [];
  const files = [];
  if (fs.existsSync(workflowDir)) collectWorkflowFiles(workflowDir, files);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/npm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
      if (!scripts[match[1]]) missing.push({ file: file.replace(projectRoot + path.sep, ""), script: match[1] });
    }
  }
  return { ok: missing.length === 0, files: files.length, missing };
}

function collectWorkflowFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectWorkflowFiles(full, out);
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
}

function safeReadPackageJson() {
  return packageMetadata;
}

function workspaceList(config) {
  const workspaces = allWorkspaceAliases(config).map(alias => {
    const item = resolveWorkspace(config, alias);
    return {
      alias,
      path: item.path,
      repoSlug: item.repoSlug || '',
      context: item.context || {}
    };
  }).sort((left, right) => left.alias.localeCompare(right.alias));
  return { ok: true, count: workspaces.length, workspaces };
}

function workspaceInspect(config, args = {}) {
  const requested = String(args.workspace || "").trim();
  try {
    const profile = workspaceProfile(config, args);
    const tree = workspaceTree(config, { ...args, maxEntries: Math.min(Math.max(Number(args.maxEntries || 800), 1), 5000) });
    return {
      ok: true,
      workspace: profile.workspace,
      root: profile.root,
      profile,
      projectInstructions: readProjectInstructions({ alias: profile.workspace, path: profile.root }),
      tree: {
        fileCount: tree.fileCount,
        files: tree.files,
        skipped: tree.skipped,
        truncated: tree.truncated
      },
      requiredFlow: toolSchema.getToolNames(config),
      operationJournal: summarizeOperations(config, { alias: profile.workspace, path: profile.root }, args.journalLimit || 10)
    };
  } catch (error) {
    return {
      ok: false,
      workspace: requested,
      error: error instanceof Error ? error.message : String(error),
      availableWorkspaces: workspaceList(config).workspaces
    };
  }
}

function workspaceTree(config, args = {}) {
  const workspace = resolveWorkspace(config, args.workspace);
  const result = collectTextFiles(workspace.path, collectOptionsFromWorkspace(workspace, { maxEntries: args.maxEntries }));
  return {
    workspace: workspace.alias,
    root: workspace.path,
    fileCount: result.files.length,
    files: result.files,
    skipped: result.skipped.slice(0, 300),
    truncated: result.truncated
  };
}

function workspaceProfile(config, args = {}) {
  const workspace = resolveWorkspace(config, args.workspace);
  const manifests = [
    "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb",
    "pyproject.toml", "requirements.txt", "poetry.lock", "Pipfile",
    "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "gradlew", "composer.json", "Gemfile", ".csproj", "pubspec.yaml"
  ];
  const present = [];
  for (const manifest of manifests) {
    try {
      const safe = resolveSafePath(workspace.path, manifest);
      if (fs.existsSync(safe.absolutePath)) present.push(manifest);
    } catch (error) {
      // Unsafe/unresolvable manifest path — treat as absent.
      debugSwallow("resolve-manifest", error);
    }
  }
  const hints = [];
  if (present.includes("package.json")) hints.push("Node/JavaScript/TypeScript project");
  if (present.includes("pnpm-lock.yaml")) hints.push("Likely package manager: pnpm");
  else if (present.includes("yarn.lock")) hints.push("Likely package manager: yarn");
  else if (present.includes("package-lock.json")) hints.push("Likely package manager: npm");
  if (present.includes("pyproject.toml") || present.includes("requirements.txt")) hints.push("Python project");
  if (present.includes("Cargo.toml")) hints.push("Rust project");
  if (present.includes("go.mod")) hints.push("Go project");
  if (present.includes("pubspec.yaml")) hints.push("Flutter/Dart project");
  const discovered = discoverCommands(workspace.path);
  const projectInstructions = summarizeProjectInstructions(readProjectInstructions(workspace));
  return {
    workspace: workspace.alias,
    root: workspace.path,
    manifests: present,
    hints,
    discoveredCommands: discovered,
    discoveredCommandCount: Object.keys(discovered).length,
    projectInstructions
  };
}

export { relaiStatus, workspaceList, workspaceInspect, workspaceTree, workspaceProfile };
