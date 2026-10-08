import { readGitObservation } from './gitObservation.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { beginGitIndexTransaction } from './gitIndexTransaction.ts';
import { readSessionPolicy } from "../policyResolver.js";
import { taskOwnedChangedFiles, taskCommitOwnership, readTaskIntegrity } from "../taskIntegrity.ts";
import { runProcess, runReadOnlyProcess, summarizeCommand } from "../process.js";
import { resolveSafePath, isSecretPath } from "../safety.js";
import { INTERNAL_STATUS_MAX_BYTES, parseGitStatus, formatGitStatus, gitStatusEntryPaths } from "./gitStatus.js";
import type { GitStatusEntry, GitStatusOwner, ParsedGitStatus } from "./gitStatus.ts";
import { checkGitRepository, readGitStatus } from './gitClient.ts';

type RepoConfig = Record<string, any>;
type RepoArgs = Record<string, any>;

interface RepoWorkspace extends Record<string, any> {
  alias: string;
  path: string;
}

interface OwnedGitStatusEntry extends GitStatusEntry {
  readonly owner: GitStatusOwner;
}

interface StatusGroups {
  entries: OwnedGitStatusEntry[];
  sessionChanged: string[];
  baselineChanged: string[];
  untrackedSession: string[];
  untrackedBaseline: string[];
  unknownChanged: string[];
  untrackedUnknown: string[];
}

interface BaselineOwnership {
  baselineDirty: string[];
  baselineSource: 'session' | null;
  taskId: string;
}

interface SensitiveAuthorization {
  authorizedPaths: Set<string>;
  metadata: Record<string, any> | null;
}

type RelaiPolicyError = Error & Record<string, any>;

const DEFAULT_MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATCH_UPDATE_BYTES = 50 * 1024 * 1024;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function truncateUtf8(text: unknown, maxBytes: number, label: string): string {
  const value = String(text || "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '') + `\n[rel-ai-mcp ${label} truncated at ${maxBytes} bytes]`;
}

// ---- Patch bounds -----------------------------------------------------------

function assertPatchUpdateSafe(workspace: RepoWorkspace, _config: RepoConfig, _args: RepoArgs, patch: string): void {
  if (!patch?.trim()) throw new Error("relai_edit requires non-empty updateText for patch-shaped edits.");
  const bytes = Buffer.byteLength(patch, "utf8");
  if (bytes > MAX_PATCH_UPDATE_BYTES) throw new Error(`relai_edit refused ${bytes} byte patch; max is ${MAX_PATCH_UPDATE_BYTES}.`);
  if (!workspace?.path) throw new Error("relai_edit requires a valid workspace.");
}

// ---- Git status classification -----------------------------------------------

function readBaselineOwnership(workspace: RepoWorkspace, config: RepoConfig, taskId = ''): BaselineOwnership {
  try {
    const session = readSessionPolicy(config, workspace.alias, taskId);
    if (!session || session.baselineCaptured !== true) return { baselineDirty: [], baselineSource: null, taskId: '' };
    const integrity = readTaskIntegrity(config, String(taskId || session.taskId || ''), workspace.alias);
    return {
      baselineDirty: [...(Array.isArray(session.baselineDirty) ? session.baselineDirty : []), ...(integrity?.baseline.changedFiles || []), ...(integrity?.baseline.opaqueDirectories || [])],
      baselineSource: 'session', taskId: String(session.taskId || '').trim()
    };
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task baseline read:', error);
    return { baselineDirty: [], baselineSource: null, taskId: '' };
  }
}

function safeTaskOwnedChangedFiles(config: RepoConfig, taskId: string, workspaceAlias: string): string[] {
  try {
    return taskOwnedChangedFiles(config, taskId, workspaceAlias);
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task ownership read:', error);
    return [];
  }
}

function isParsedGitStatus(value: unknown): value is ParsedGitStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ParsedGitStatus>;
  return Array.isArray(candidate.entries)
    && typeof candidate.branchRaw === 'string'
    && typeof candidate.unborn === 'boolean';
}

function statusGroups(): StatusGroups {
  return {
    entries: [],
    sessionChanged: [],
    baselineChanged: [],
    untrackedSession: [],
    untrackedBaseline: [],
    unknownChanged: [],
    untrackedUnknown: []
  };
}

function statusOwnerForFile(file: string, hasSession: boolean, baselineSet: ReadonlySet<string>): GitStatusOwner {
  if (!hasSession) return "unknown";
  return baselineSet.has(file) || [...baselineSet].some(root => root.endsWith("/") && file.startsWith(root)) ? "baseline" : "session";
}

function recordStatusEntry(groups: StatusGroups, entry: OwnedGitStatusEntry): void {
  groups.entries.push(entry);
  if (!entry.opaqueDirectory) recordStatusPath(groups, entry.path, entry.owner, entry.untracked);
}

function recordStatusPath(groups: StatusGroups, file: string, owner: GitStatusOwner, untracked: boolean): void {
  if (owner === 'session') {
    groups.sessionChanged.push(file);
    if (untracked) groups.untrackedSession.push(file);
    return;
  }
  if (owner === 'baseline') {
    groups.baselineChanged.push(file);
    if (untracked) groups.untrackedBaseline.push(file);
    return;
  }
  groups.unknownChanged.push(file);
  if (untracked) groups.untrackedUnknown.push(file);
}

function classifyStatusOwnership(workspace: RepoWorkspace, config: RepoConfig, statusOutput: unknown, requestedTaskId = '') {
  const { baselineDirty, baselineSource, taskId } = readBaselineOwnership(workspace, config, requestedTaskId);
  const hasSession = baselineSource !== null;
  const baselineSet = new Set(baselineDirty);
  const groups = statusGroups();
  const parsed = isParsedGitStatus(statusOutput) ? statusOutput : parseGitStatus(statusOutput);

  const claimProjection = requestedTaskId || taskId ? taskCommitOwnership(config, String(requestedTaskId || taskId), workspace.alias) : { ownedFiles: [], conflictingFiles: [] };
  const explicitClaims = new Set(claimProjection.ownedFiles.filter(file => !claimProjection.conflictingFiles.includes(file)));
  const conflictingClaims = new Set(claimProjection.conflictingFiles);
  for (const parsedEntry of parsed.entries) {
    recordStatusEntry(groups, {
      ...parsedEntry,
      owner: parsedEntry.opaqueDirectory ? "unknown" : baselineSet.has(parsedEntry.path) ? "baseline" : conflictingClaims.has(parsedEntry.path) ? "unknown" : explicitClaims.has(parsedEntry.path) ? "session" : statusOwnerForFile(parsedEntry.path, hasSession, baselineSet)
    });
    // Display ownership groups follow Git's destination entry. Rename sources
    // are retained separately in the exact dirty/task paths below.
  }

  const dirtySet = new Set(groups.entries.flatMap(gitStatusEntryPaths));
  const requestedId = String(requestedTaskId || '').trim();
  const ownershipTaskId = requestedId || taskId;
  const taskTouched = ownershipTaskId
    ? safeTaskOwnedChangedFiles(config, ownershipTaskId, workspace.alias).filter(file => dirtySet.has(file))
    : [];
  const sessionTouched = requestedId
    ? taskTouched
    : hasSession && taskId
      ? taskTouched
      : groups.sessionChanged;

  return {
    branchRaw: parsed.branchRaw,
    branch: parsed.branch,
    aheadBehind: parsed.aheadBehind,
    unborn: parsed.unborn,
    hasSession,
    baselineSource,
    sessionTouched,
    ...groups
  };
}

// ---- Git operation private helpers -------------------------------------------

function gitOperationOptions(context: RepoArgs = {}, timeout = 60000) {
  context.signal?.throwIfAborted?.();
  const deadline = Number(context.deadlineAtMs);
  const remaining = Number.isFinite(deadline) && deadline > 0 ? deadline - Date.now() : timeout;
  if (remaining <= 0) throw new DOMException('Operation deadline expired before the next phase.', 'TimeoutError');
  // Some internal clients floor numeric timeouts. A binding absolute deadline
  // also needs a signal so that their floor cannot extend the operation.
  const deadlineSignal = Number.isFinite(deadline) && deadline > 0
    ? AbortSignal.timeout(Math.min(2147483647, Math.max(0, Math.floor(remaining)))) : null;
  const signal = deadlineSignal && context.signal ? AbortSignal.any([context.signal, deadlineSignal]) : deadlineSignal || context.signal;
  return { signal, timeout: Math.max(1, Math.min(timeout, remaining)) };
}

async function ensureGitRepo(workspace: RepoWorkspace, _config: RepoConfig, context: RepoArgs = {}): Promise<void> {
  const options = gitOperationOptions(context, 30000);
  const isRepository = await checkGitRepository(workspace.path, { timeoutMs: options.timeout, signal: options.signal });
  if (!isRepository) throw new Error(`Workspace '${workspace.alias}' is not a git work tree.`);
}

async function inspectPatchPaths(workspace: RepoWorkspace, config: RepoConfig, patch: string, timeoutMs = 120000, context: RepoArgs = {}) {
  const check = await runReadOnlyProcess("git", ["apply", "--check", "--numstat", "-z", "--summary", "--recount", "-"], {
    cwd: workspace.path,
    input: patch,
    ...gitOperationOptions(context, timeoutMs),
    maxOutputBytes: INTERNAL_STATUS_MAX_BYTES
  }, config);
  if (check.exitCode !== 0) return { check, touchedPaths: [] };
  if (check.stdoutTruncated) {
    throw new Error("git apply path inspection exceeded the internal output limit.");
  }

  const candidates = [
    ...parseApplyInspectionPaths(check.stdout || ""),
    ...extractPatchMetadataPaths(patch)
  ];
  const touchedPaths: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || candidate === "/dev/null") continue;
    // Resolve containment first, then apply the unified-diff-specific sensitive-path
    // policy below. The temporary commit allowance prevents the generic path guard
    // from obscuring the canonical patch error and does not authorize any mutation.
    const safe = resolveSafePath(workspace.path, candidate, { operation: "commit", allowSensitive: true });
    if (isSecretPath(safe.relativePath)) throw sensitiveUnifiedDiffError(safe.relativePath);
    if (!seen.has(safe.relativePath)) {
      seen.add(safe.relativePath);
      touchedPaths.push(safe.relativePath);
    }
  }
  if (touchedPaths.length === 0) {
    throw new Error("Git accepted the patch but did not report any workspace file paths.");
  }
  return { check, touchedPaths };
}

function parseApplyInspectionPaths(output: unknown): string[] {
  const text = String(output || "");
  const lastNul = text.lastIndexOf("\0");
  const numstat = lastNul >= 0 ? text.slice(0, lastNul + 1) : "";
  const summary = lastNul >= 0 ? text.slice(lastNul + 1) : text;
  const paths: string[] = [];
  for (const record of numstat.split("\0")) {
    if (!record) continue;
    const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(record);
    if (match?.[1]) paths.push(match[1]);
  }
  for (const line of summary.split(/\r?\n/)) {
    const match = /^\s*(?:create|delete) mode \d+ (.+)$/.exec(line)
      || /^\s*mode change \d+ => \d+ (.+)$/.exec(line);
    if (match?.[1]) paths.push(decodeGitQuotedPath(match[1]));
  }
  return paths;
}

function extractPatchMetadataPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of String(patch || "").split(/\r?\n/)) {
    for (const prefix of ["rename from ", "rename to ", "copy from ", "copy to "]) {
      if (line.startsWith(prefix)) paths.push(decodeGitQuotedPath(line.slice(prefix.length)));
    }
  }
  return paths;
}

function decodeGitQuotedPath(value: unknown): string {
  const text = String(value || "").trim();
  if (!text.startsWith('"')) return text;
  const bytes: number[] = [];
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (!character || character === '"') break;
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const escaped = text[++index];
    if (escaped == null) break;
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(text[index + 1] || "")) octal += text[++index];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    const escapes: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
    bytes.push(Object.hasOwn(escapes, escaped) ? (escapes[escaped] ?? escaped.charCodeAt(0)) : escaped.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

function sensitiveUnifiedDiffError(relativePath: string): RelaiPolicyError {
  const error = new Error(
    `Unified diff edits cannot target sensitive-classified path '${relativePath}' because the proposed final content cannot be inspected safely. Use a structured OpenAI patch or exact relai_edit replacement so final content is validated.`
  ) as RelaiPolicyError;
  error.code = "SENSITIVE_PATCH_REQUIRES_CONTENT_VALIDATION";
  error.source = "rel-ai-mcp-policy";
  error.path = relativePath;
  error.operation = "write";
  error.retryable = false;
  return error as RelaiPolicyError;
}

function safeRemoteName(value: unknown): string {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.startsWith("-") || name.includes("..")) {
    throw new Error(`Git remote name is not safe to use: ${name || "(empty)"}.`);
  }
  return name;
}

function configuredRemoteNames(output: unknown): string[] {
  return String(output || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function hasControlCharacters(value: unknown): boolean {
  return Array.from(String(value || "")).some(character => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function assertSafeRemoteUrl(remote: string, url: unknown): void {
  const value = String(url || "").trim();
  if (!value || value.startsWith("-") || hasControlCharacters(value)) {
    throw new Error(`Git remote '${remote}' has an invalid push URL.`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(value)) {
    throw new Error(`Git remote '${remote}' uses an unsafe Git remote-helper transport. Configure a standard Git URL before publishing.`);
  }
}

async function resolvePublishRemote(workspace: RepoWorkspace, config: RepoConfig, requestedRemote: unknown, context: RepoArgs = {}): Promise<string> {
  const remote = safeRemoteName(requestedRemote || "origin");
  const listed = await runReadOnlyProcess("git", ["remote"], { cwd: workspace.path, ...gitOperationOptions(context, 30000) }, config);
  if (!completeGitCommand(listed) || listed.stdoutTruncated || listed.stdoutSpillTruncated) throw new Error(`Could not read configured Git remotes: ${listed.stderr || listed.stdout || listed.exitCode}`);
  const configured = configuredRemoteNames(listed.stdout);
  if (!configured.includes(remote)) {
    throw new Error(`Git remote '${remote}' is not configured in this repository. Available remotes: ${configured.join(", ") || "none"}.`);
  }
  const urls = await runReadOnlyProcess("git", ["remote", "get-url", "--push", "--all", remote], { cwd: workspace.path, ...gitOperationOptions(context, 30000) }, config);
  if (!completeGitCommand(urls) || urls.stdoutTruncated || urls.stdoutSpillTruncated) throw new Error(`Could not read push URL for Git remote '${remote}': ${urls.stderr || urls.stdout || urls.exitCode}`);
  const pushUrls = configuredRemoteNames(urls.stdout);
  if (!pushUrls.length) throw new Error(`Git remote '${remote}' has no push URL configured.`);
  for (const url of pushUrls) assertSafeRemoteUrl(remote, url);
  return remote;
}

async function gitRefExists(workspace: RepoWorkspace, config: RepoConfig, ref: string): Promise<boolean> {
  const result = await runReadOnlyProcess("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: workspace.path, timeout: 30000 }, config);
  return result.exitCode === 0;
}

async function detectDefaultBaseBranch(workspace: RepoWorkspace, config: RepoConfig): Promise<string> {
  const remotes = await runReadOnlyProcess("git", ["remote"], { cwd: workspace.path, timeout: 30000 }, config);
  if (remotes.exitCode === 0) {
    const names = configuredRemoteNames(remotes.stdout).filter((name) => /^[A-Za-z0-9._/-]{1,200}$/.test(name) && !name.startsWith("-") && !name.includes(".."));
    names.sort((left, right) => Number(right === "origin") - Number(left === "origin") || left.localeCompare(right));
    for (const remote of names) {
      const symbolic = await runReadOnlyProcess("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { cwd: workspace.path, timeout: 30000 }, config);
      const value = String(symbolic.stdout || "").trim();
      const prefix = `${remote}/`;
      if (symbolic.exitCode === 0 && value.startsWith(prefix) && value.length > prefix.length) return value.slice(prefix.length);
    }
  }
  for (const candidate of ["main", "master"]) {
    if (await gitRefExists(workspace, config, `refs/heads/${candidate}`)) return candidate;
  }
  return currentGitBranch(workspace, config);
}

async function currentGitBranch(workspace: RepoWorkspace, config: RepoConfig, context: RepoArgs = {}): Promise<string> {
  const branch = await runReadOnlyProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace.path, ...gitOperationOptions(context, 30000) }, config);
  if (!completeGitCommand(branch) || branch.stdoutTruncated || branch.stdoutSpillTruncated) return "";
  return String(branch.stdout || "").trim();
}

function buildPrBodyFromDiff(diffText: unknown): string {
  const changedFiles: string[] = [];
  for (const line of String(diffText || "").split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) changedFiles.push(line.slice(6));
  }
  const unique = [...new Set(changedFiles)];
  return [
    "## Summary",
    "",
    `- Changes prepared from \`${unique.length}\` file(s)`,
    "",
    "## Files",
    "",
    ...unique.slice(0, 50).map((item) => `- \`${item}\``)
  ].join("\n");
}

// ---- Git operations ----------------------------------------------------------

async function workspaceGitStatus(workspace: RepoWorkspace, config: RepoConfig, args: RepoArgs = {}) {
  const maxBytes = clampNumber(args.maxBytes, 1000, 5 * 1024 * 1024, DEFAULT_MAX_GIT_OUTPUT_BYTES);
  let parsed: ParsedGitStatus;
  let statusError = '';
  try {
    const budget = gitOperationOptions(args, 30000);
    parsed = await readGitStatus(workspace.path, { timeoutMs: budget.timeout, signal: budget.signal }, config);
  } catch (error) {
    if (args.signal?.aborted) {
      if (args.signal.reason instanceof Error) throw args.signal.reason;
      throw error;
    }
    parsed = parseGitStatus('');
    statusError = error instanceof Error ? error.message : String(error);
  }
  const knownPaths = Array.isArray(args._taskOwnedPaths) ? args._taskOwnedPaths.map(String)
    : args.work_id ? safeTaskOwnedChangedFiles(config, String(args.work_id), workspace.alias) : [];
  const visiblePaths = new Set(parsed.entries.flatMap(gitStatusEntryPaths));
  const opaqueRoots = parsed.entries.filter(entry => entry.opaqueDirectory).map(entry => entry.path);
  const missingPaths = knownPaths.filter(file => statusError || (!visiblePaths.has(file) && opaqueRoots.some(root => file.startsWith(root))));
  if (missingPaths.length) {
    const entries = new Map(parsed.entries.map(entry => [entry.path, entry]));
    for (let offset = 0; offset < missingPaths.length; offset += 100) {
      const budget = gitOperationOptions(args, 1500);
      const exact = await readGitObservation(workspace.path, config, { paths: missingPaths.slice(offset, offset + 100), signal: budget.signal, timeoutMs: budget.timeout });
      if (exact.exitCode !== 0 || exact.stdoutTruncated) { statusError = exact.error || exact.stderr || 'Exact Git observation failed.'; break; }
      for (const entry of parseGitStatus(exact.stdout).entries) entries.set(entry.path, entry);
    }
    parsed = { ...parsed, entries: [...entries.values()] };
  }
  const ownership = classifyStatusOwnership(workspace, config, parsed, args.work_id);
  const taskScoped = Boolean(String(args.work_id || '').trim());
  const sessionChangedFiles = taskScoped ? ownership.sessionTouched : ownership.sessionChanged;
  const scopedSessionSet = new Set(sessionChangedFiles);
  const untrackedSessionFiles = taskScoped
    ? ownership.untrackedSession.filter(file => scopedSessionSet.has(file))
    : ownership.untrackedSession;
  return {
    ok: !statusError,
    workspace: workspace.alias,
    branch: ownership.branch,
    aheadBehind: ownership.aheadBehind,
    unborn: ownership.unborn,
    ...(parsed.repositoryHead !== undefined ? { repositoryHead: parsed.repositoryHead } : {}),
    status: truncateUtf8(formatGitStatus(ownership), maxBytes, "git status"),
    statusEntries: ownership.entries,
    changedFiles: [...new Set(ownership.entries.flatMap(gitStatusEntryPaths))],
    untrackedFiles: ownership.entries.filter((entry) => entry.untracked).map((entry) => entry.path),
    sessionChangedFiles,
    baselineChangedFiles: ownership.baselineChanged,
    untrackedSessionFiles,
    untrackedBaselineFiles: ownership.untrackedBaseline,
    ...(ownership.baselineSource ? { baselineSource: ownership.baselineSource } : {}),
    ...(statusError ? { stderr: truncateUtf8(statusError, maxBytes, "git status stderr") } : {})
  };
}

async function relaiGitCommit(workspace: RepoWorkspace, config: RepoConfig, args: RepoArgs = {}, context: RepoArgs = {}) {
  context = { ...args, ...context };
  args = { ...args, signal: context.signal, deadlineAtMs: context.deadlineAtMs };
  // The work-tree probe and the status read are independent child processes, so start
  // the probe here and let it overlap argument validation and the status spawn instead
  // of paying for both spawns back to back. The no-op catch only marks the rejection as
  // handled in case validation below throws first; awaiting it still surfaces the error.
  const repoProbe = ensureGitRepo(workspace, config, context);
  repoProbe.catch(() => {});
  const message = String(args.message || "").trim();
  if (!message) throw new Error('relai_publish action "commit" requires a non-empty commit message.');
  const dryRun = Boolean(args.dryRun);
  const authorization = normalizeSensitiveAuthorization(workspace, args);
  const hasTaskOwnedScope = Array.isArray(args._taskOwnedPaths);
  const workspaceAddAll = args.addAll === true;
  const explicitPaths = Array.isArray(args.paths) && args.paths.length > 0;
  const taskOwnedPaths: string[] = hasTaskOwnedScope
    ? [...new Set<string>((args._taskOwnedPaths as unknown[]).map((item: unknown) => normalizeGitPath(item)).filter(Boolean))]
    : [];
  const requestedPaths: readonly unknown[] = explicitPaths ? args.paths as unknown[] : hasTaskOwnedScope && !workspaceAddAll ? taskOwnedPaths : [];
  let paths: string[] = [...new Set<string>(requestedPaths.map((item: unknown) => resolveSafePath(workspace.path, item, {
    operation: "commit",
    allowSensitive: authorization.authorizedPaths.has(normalizeGitPath(item))
  }).relativePath))];
  const addAll = workspaceAddAll;
  const statusRead = workspaceGitStatus(workspace, config, { maxBytes: args.maxBytes, _taskOwnedPaths: paths, signal: context.signal, deadlineAtMs: context.deadlineAtMs });
  statusRead.catch(() => {});
  await repoProbe;
  const statusBefore = await statusRead;

  if (!statusBefore.ok) {
    return { ok: false, workspace: workspace.alias, message, addAll, paths: [], statusBefore,
      error: 'Git observation did not establish the selected file state. No files were staged or committed.' };
  }

  if (addAll && statusBefore.statusEntries.some(entry => entry.opaqueDirectory)) {
    return { ok: false, workspace: workspace.alias, message, addAll, paths: [], statusBefore,
      error: 'Untracked directories have incomplete file ownership. Select explicit file paths to commit.' };
  }
  if (addAll && explicitPaths) {
    return {
      ok: false,
      workspace: workspace.alias,
      message,
      addAll,
      paths: [],
      statusBefore,
      error: 'relai_publish commit cannot combine addAll:true with explicit paths. Use addAll:true for the whole visible workspace or omit addAll for a scoped commit.'
    };
  }
  if (hasTaskOwnedScope && !addAll) {
    const dirtySet = new Set<string>(statusBefore.changedFiles || []);
    paths = paths.filter(file => dirtySet.has(file));
    if (!explicitPaths) {
      const conflictSet = new Set<string>((Array.isArray(args._taskConflictingPaths) ? args._taskConflictingPaths as unknown[] : [])
        .map((item: unknown) => normalizeGitPath(item))
        .filter(Boolean));
      const conflictPaths = paths.filter(file => conflictSet.has(file));
      if (conflictPaths.length) {
        return {
          ok: false,
          workspace: workspace.alias,
          message,
          addAll: false,
          paths,
          conflictPaths,
          statusBefore,
          error: `Task-owned commit is ambiguous because these paths also contain ambient or other-task work: ${conflictPaths.join(', ')}. Rel.AI preserved the working tree and refused to combine ownership implicitly.`
        };
      }
    }
  }
  const resultPaths: string[] = addAll
    ? [...new Set<string>((statusBefore.changedFiles || []).map((item: string) => normalizeGitPath(item)).filter(Boolean))]
    : paths;
  if (!addAll && paths.length === 0) {
    return {
      ok: false,
      workspace: workspace.alias,
      message,
      addAll,
      paths,
      statusBefore,
      error: explicitPaths
        ? 'None of the explicitly selected paths have changes to commit.'
        : hasTaskOwnedScope
          ? 'No task-owned changed paths are available to commit. Rel.AI will not fall back to committing unrelated workspace changes.'
          : 'No commit paths were selected. Pass explicit paths or addAll:true.'
    };
  }
  if (addAll) await assertWorkspaceRepositoryRoot(workspace, config, context);
  if (dryRun) {
    return {
      mutationEffect: 'none',
      ok: true,
      workspace: workspace.alias,
      dryRun: true,
      message,
      addAll,
      paths: resultPaths,
      ...(authorization.metadata ? { sensitiveAuthorization: authorization.metadata } : {}),
      statusBefore
    };
  }
  const transaction = await beginGitIndexTransaction(workspace.path, config, gitOperationOptions(context, 30000));
  let retainTransaction = false;
  let committedResult: Record<string, any> | null = null;
  let indexReconciled = false;
  let verifiedHead = '';
  let commitAttempted = false;
  const runIndexMutation = async (argv: string[], timeout = 60000) => {
    const options = gitOperationOptions(context, timeout);
    if (argv[0] === 'commit') commitAttempted = true;
    const result = await runProcess('git', argv,
      { cwd: workspace.path, ...options, env: transaction.env }, config);
    if (result.terminationConfirmed === false) retainTransaction = true;
    return result;
  };
  const refuse = (error: string, extra: Record<string, any> = {}) => ({
    ok: false, workspace: workspace.alias, message, addAll, paths: resultPaths,
    statusBefore, indexRestored: transaction.unchanged(), indexPreserved: transaction.unchanged(),
    error, ...extra
  });
  try {
    const add = await runIndexMutation(paths.length
      ? ['add', '--', ...paths.map(file => `:(literal)${file}`)]
      : ['add', '-A']);
    if (!completeGitCommand(add)) {
      return refuse('Git staging failed. The visible index was not replaced.', { add: summarizeCommand(add) });
    }

    // This is mandatory publication evidence. Preserve exact NUL paths, and
    // refuse every failed, cancelled, timed-out or truncated observation.
    const staged = await runReadOnlyProcess('git',
      ['diff', '--cached', '--name-only', '-z', ...(paths.length ? ['--', ...paths.map(file => `:(literal)${file}`)] : [])],
      { cwd: workspace.path, ...gitOperationOptions(context), env: transaction.env,
        preserveOutputWhitespace: true, maxOutputBytes: INTERNAL_STATUS_MAX_BYTES }, config);
    if (staged.terminationConfirmed === false) retainTransaction = true;
    let stagedPaths: string[];
    try { stagedPaths = completeStagedPaths(staged); }
    catch (error) {
      return refuse(error instanceof Error ? error.message : String(error), { stagedObservation: summarizeCommand(staged) });
    }
    const secretStaged = stagedPaths.filter(file => isSecretPath(file));
    const unauthorizedSecretPaths = secretStaged.filter(file => !authorization.authorizedPaths.has(file));
    if (unauthorizedSecretPaths.length) {
      return refuse(`Refusing to commit sensitive paths without matching commit authorization: ${unauthorizedSecretPaths.join(', ')}. The visible index was preserved.`,
        { secretStagedFiles: secretStaged, unauthorizedSecretPaths });
    }
    if (!transaction.unchanged()) return refuse('The visible Git index changed outside this transaction; refusing to commit.');
    const commit = await runIndexMutation(
      ['commit', ...(paths.length ? ['--only'] : []), '-m', message,
        ...(paths.length ? ['--', ...paths.map(file => `:(literal)${file}`)] : [])],
      clampNumber(args.timeoutMs, 1000, 86400000, 120000));
    if (!completeGitCommand(commit)) {
      return refuse('Git commit did not complete successfully. The visible index was not replaced.', { mutationEffect: commit.executed === false ? 'none' : 'unknown', commit: summarizeCommand(commit) });
    }
    committedResult = summarizeCommand(commit);
    const head = await resolveCommitHead(workspace, config, context);
    verifiedHead = head;
    let indexError = '';
    try {
      if (paths.length) {
        const normalizeIndex = await runIndexMutation(['reset', '--quiet', 'HEAD', '--', ...paths.map(file => `:(literal)${file}`)]);
        if (!completeGitCommand(normalizeIndex)) throw new Error('the private index could not be reconciled for committed paths.');
        const selected = await runReadOnlyProcess('git',
          ['diff', '--cached', '--name-only', '-z', '--', ...paths.map(file => `:(literal)${file}`)],
          { cwd: workspace.path, ...gitOperationOptions(context), env: transaction.env, preserveOutputWhitespace: true, maxOutputBytes: INTERNAL_STATUS_MAX_BYTES }, config);
        if (selected.terminationConfirmed === false) retainTransaction = true;
        if (completeStagedPaths(selected).length) throw new Error('committed paths still differ in the private index.');
      }
      context.signal?.throwIfAborted?.();
      transaction.publish();
      indexReconciled = true;
    }
    catch (error) {
      if ((error as { terminationConfirmed?: boolean }).terminationConfirmed === false) retainTransaction = true;
      indexError = error instanceof Error ? error.message : String(error);
    }
    const statusAfter = await workspaceGitStatus(workspace, config, { maxBytes: args.maxBytes, signal: context.signal, deadlineAtMs: context.deadlineAtMs });
    return {
      ok: !indexError && Boolean(head), workspace: workspace.alias, message, addAll, paths: resultPaths,
      ...(authorization.metadata ? { sensitiveAuthorization: authorization.metadata } : {}),
      commit: committedResult, committed: true, mutationEffect: 'applied', ...(head ? { head } : {}),
      statusBefore, statusAfter,
      indexReconciled,
      ...(indexError ? { error: 'Commit succeeded, but ' + indexError } : {}),
      ...(!head ? { error: 'Commit succeeded, but the resulting HEAD could not be verified.' } : {})
    };
  } catch (error) {
    if ((error as { terminationConfirmed?: boolean }).terminationConfirmed === false) retainTransaction = true;
    if (committedResult) {
      return {
        ok: false, workspace: workspace.alias, message, addAll, paths: resultPaths,
        committed: true, mutationEffect: 'applied', commit: committedResult,
        ...(verifiedHead ? { head: verifiedHead } : {}), statusBefore, indexReconciled,
        error: 'Commit succeeded, but later bookkeeping did not complete: ' + (error instanceof Error ? error.message : String(error))
      };
    }
    if (commitAttempted) {
      retainTransaction = true;
      return { ok: false, workspace: workspace.alias, message, addAll, paths: resultPaths, statusBefore, mutationEffect: 'unknown', error: 'Commit outcome could not be verified. Do not retry without reconciling HEAD and the retained index.' };
    }
    throw error;
  } finally {
    // An unconfirmed child may still be using its index. Retain both files and
    // the normal Git lock rather than deleting state underneath that process.
    if (!retainTransaction) {
      try { transaction.dispose(); }
      catch (error) {
        if (committedResult) Object.assign(error as object, { handlerResult: { ok: false, workspace: workspace.alias, committed: true, mutationEffect: 'applied', commit: committedResult, paths: resultPaths, indexReconciled, ...(verifiedHead ? { head: verifiedHead } : {}), error: 'Commit succeeded, but transaction cleanup failed.' } });
        throw error;
      }
    }
  }
}

function completeGitCommand(result: Record<string, any>): boolean {
  return result.executed === true && result.exitCode === 0 && !result.timedOut
    && !result.cancelled && !result.spawnError && result.terminationConfirmed !== false
    && !result.outputFinalizationTimedOut;
}

function completeStagedPaths(result: Record<string, any>): string[] {
  const output = String(result.stdout || '');
  if (!completeGitCommand(result) || result.stdoutTruncated || result.stdoutSpillTruncated
    || (output && !output.endsWith('\0')) || output.includes('\uFFFD')) {
    throw new Error('Mandatory staged-file observation failed or was incomplete. No commit was attempted; the visible index was preserved.');
  }
  return output ? output.slice(0, -1).split('\0') : [];
}

async function resolveCommitHead(workspace: RepoWorkspace, config: RepoConfig, context: RepoArgs = {}): Promise<string> {
  const result = await runReadOnlyProcess('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: workspace.path,
    ...gitOperationOptions(context),
    maxOutputBytes: 4096
  }, config).catch(() => null);
  if (!result || !completeGitCommand(result) || result.stdoutTruncated || result.stdoutSpillTruncated) return '';
  const head = String(result.stdout || '').trim();
  return /^[a-f0-9]{40,64}$/i.test(head) ? head : '';
}

async function workspaceDirtyPaths(
  workspace: RepoWorkspace,
  config: RepoConfig,
  paths: readonly unknown[] = [],
  options: { signal?: AbortSignal } = {}
): Promise<string[]> {
  options.signal?.throwIfAborted?.();
  const normalized = [...new Set((Array.isArray(paths) ? paths : [])
    .map(item => normalizeGitPath(item))
    .filter(Boolean))];
  if (!normalized.length) return [];
  const workTree = await runReadOnlyProcess("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: workspace.path,
    timeout: 30000,
    maxOutputBytes: DEFAULT_MAX_GIT_OUTPUT_BYTES,
    ...(options.signal ? { signal: options.signal } : {})
  }, config);
  options.signal?.throwIfAborted?.();
  if (workTree.exitCode !== 0 || !String(workTree.stdout || "").trim().startsWith("true")) {
    return normalized;
  }
  const dirty = new Set<string>();
  for (let index = 0; index < normalized.length; index += 100) {
    options.signal?.throwIfAborted?.();
    const chunk = normalized.slice(index, index + 100);
    const status = await readGitObservation(workspace.path, config, { paths: chunk, branch: false, signal: options.signal });
    options.signal?.throwIfAborted?.();
    if (status.exitCode !== 0 || status.stdoutTruncated) {
      throw new Error(`Could not inspect task-owned residual workspace state: ${status.stderr || status.stdout || status.exitCode}`);
    }
    for (const entry of parseGitStatus(status.stdout || "").entries) dirty.add(entry.path);
  }
  return [...dirty].sort();
}

function normalizeSensitiveAuthorization(workspace: RepoWorkspace, args: RepoArgs = {}): SensitiveAuthorization {
  const raw = args.sensitiveAuthorization;
  if (raw == null) return { authorizedPaths: new Set<string>(), metadata: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sensitiveAuthorization must be an object with operation, paths, and reason.");
  }
  if (String(raw.operation || "").trim() !== "commit") {
    throw new Error("sensitiveAuthorization.operation must be 'commit'.");
  }
  const reason = String(raw.reason || "").trim();
  if (!reason || reason.length > 500) {
    throw new Error("sensitiveAuthorization.reason must contain 1 to 500 characters.");
  }
  if (!Array.isArray(raw.paths) || raw.paths.length === 0 || raw.paths.length > 200) {
    throw new Error("sensitiveAuthorization.paths must contain 1 to 200 paths.");
  }
  const paths = [...new Set<string>((raw.paths as unknown[]).map((item: unknown) => normalizeGitPath(item)).filter(Boolean))];
  for (const item of paths) {
    resolveSafePath(workspace.path, item, { operation: "commit", allowSensitive: true });
    if (!isSecretPath(item)) throw new Error(`sensitiveAuthorization path is not classified as sensitive: ${item}`);
  }
  return {
    authorizedPaths: new Set<string>(paths),
    metadata: {
      operation: "commit",
      paths,
      reason,
      reasonProvided: true,
      source: "explicit"
    }
  };
}

function normalizeGitPath(value: unknown): string {
  return String(value || "").replaceAll("\\", "/").trim().replace(/^\.\//, "");
}

// A branch name, not a refspec. Rejects deletes (":main"), force pushes
// ("+HEAD:main"), option-looking values, and git's own invalid-ref forms.
function assertPlainBranchName(branch: string): void {
  if (branch.includes(":")) {
    throw new Error(`relai_publish action "push" expects a branch name, not a refspec: ${branch}`);
  }
  if (branch.startsWith("+") || branch.startsWith("-")) {
    throw new Error(`relai_publish action "push" branch must not start with '+' or '-': ${branch}`);
  }
  if (/[\s~^?*[\\]/.test(branch) || branch.includes("..") || branch.includes("@{") || branch.endsWith(".lock") || branch.endsWith("/")) {
    throw new Error(`relai_publish action "push" branch name is not a valid ref: ${branch}`);
  }
}

async function resolveGitPushTarget(workspace: RepoWorkspace, config: RepoConfig, args: RepoArgs = {}, context: RepoArgs = {}) {
  await ensureGitRepo(workspace, config, context);
  const remote = await resolvePublishRemote(workspace, config, args.remote || "origin", context);
  const branch = String(args.branch || await currentGitBranch(workspace, config, context)).trim();
  if (!branch) throw new Error('relai_publish action "push" could not determine the branch to push.');
  // git push treats this argument as a refspec: ":main" deletes the remote branch and
  // "+HEAD:main" force-pushes over it. Accept a plain branch name only.
  assertPlainBranchName(branch);
  const head = await resolveCommitHead(workspace, config, context);
  if (!head) throw new Error('relai_publish action "push" could not resolve the current HEAD commit.');
  return {
    workspace: workspace.alias,
    remote,
    branch,
    head,
    setUpstream: Boolean(args.setUpstream)
  };
}

async function relaiGitPush(workspace: RepoWorkspace, config: RepoConfig, args: RepoArgs = {}, context: RepoArgs = {}) {
  const target = await resolveGitPushTarget(workspace, config, args, context);
  const { remote, branch, setUpstream } = target;
  const dryRun = Boolean(args.dryRun);
  const pushArgs = ["push", ...(dryRun ? ["--dry-run"] : []), ...(setUpstream ? ["--set-upstream"] : []), remote, branch];
  const push = await runProcess("git", pushArgs, {
    cwd: workspace.path,
    ...gitOperationOptions(context, clampNumber(args.timeoutMs, 1000, 240000, 120000)),
    inheritCredentials: true
  }, config);
  return { ok: completeGitCommand(push), workspace: workspace.alias, remote, branch, dryRun, setUpstream, push: summarizeCommand(push) };
}

async function relaiGitDraftPr(workspace: RepoWorkspace, config: RepoConfig, args: RepoArgs = {}) {
  await ensureGitRepo(workspace, config);
  const head = String(args.head || await currentGitBranch(workspace, config)).trim();
  const base = String(args.base || await detectDefaultBaseBranch(workspace, config)).trim();
  const title = String(args.title || "").trim();
  const body = String(args.body || "").trim();
  const diff = await runReadOnlyProcess("git", ["diff", `${base}...${head}`], { cwd: workspace.path, timeout: 60000, maxOutputBytes: 2 * 1024 * 1024 }, config);
  const diffText = diff.stdout || "";
  const changedFiles = [...new Set(String(diffText).split(/\r?\n/).filter((line) => line.startsWith("+++ b/")).map((line) => line.slice(6)))];
  const emptyDiff = diff.exitCode === 0 && changedFiles.length === 0 && !diffText.trim();
  return {
    ok: diff.exitCode === 0 && !emptyDiff,
    workspace: workspace.alias,
    base,
    head,
    title: title || `Merge ${head} into ${base}`,
    body: body || buildPrBodyFromDiff(diffText),
    changedFiles,
    changedFileCount: changedFiles.length,
    emptyDiff,
    draftOnly: true,
    remoteChanged: false,
    ...(emptyDiff ? { warning: `No diff between ${base} and ${head}; refusing to draft an empty pull request.` } : {}),
    diff: summarizeCommand(diff)
  };
}

async function assertWorkspaceRepositoryRoot(workspace: RepoWorkspace, config: RepoConfig, context: RepoArgs = {}) {
  const result = await runReadOnlyProcess('git', ['rev-parse', '--show-toplevel'], {
    cwd: workspace.path, ...gitOperationOptions(context, 30000), maxOutputBytes: 16384, preserveOutputWhitespace: true
  }, config);
  if (!completeGitCommand(result) || result.stdoutTruncated || result.stdoutSpillTruncated) throw new Error('Could not verify the full repository scope. No repository-wide mutation was started.');
  const root = fs.realpathSync(String(result.stdout).replace(/\r?\n$/, ''));
  const selected = fs.realpathSync(workspace.path);
  if (path.relative(root, selected) !== '') {
    throw new Error('Repository-wide mutation requires a workspace rooted at the Git worktree root. The selected nested workspace was preserved.');
  }
}

export {
  gitOperationOptions, assertWorkspaceRepositoryRoot, completeStagedPaths, workspaceGitStatus, workspaceDirtyPaths, relaiGitCommit, relaiGitPush, relaiGitDraftPr, classifyStatusOwnership, assertPatchUpdateSafe, ensureGitRepo, inspectPatchPaths };
