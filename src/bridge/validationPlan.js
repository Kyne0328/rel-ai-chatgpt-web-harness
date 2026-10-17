import * as crypto from 'node:crypto';
import { stableJson } from '../stableJson.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomic } from '../durableState.ts';
import { runReadOnlyProcess } from '../process.js';
import { getStateDir } from '../statePaths.js';
import { workspaceGitStatus } from '../repo/gitOps.js';
import { relaiCodeInspect } from './codeIntelligence.js';
import { detectVerifyCheckUnits, detectVerifyChecks } from './checkDetection.js';
import { buildCheckCatalog } from '../workflow/checkCatalog.js';
import { classifyWorkflowRisk } from '../workflow/risk.js';
import { discoverRepositoryTopology, packageForPath } from '../workflow/topology.js';

const PLAN_TTL_MS = 30 * 60 * 1000;
const FINGERPRINT_VERSION = 4;
const VALIDATION_CONFIG_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc',
  '.eslintrc.json',
  'knip.json',
  'knip.jsonc',
  'vitest.config.js',
  'vitest.config.mjs',
  'jest.config.js',
  'jest.config.mjs'
]);

async function createValidationPlan(workspace, config, args = {}) {
  const signal = args.signal;
  signal?.throwIfAborted?.();
  const status = await workspaceGitStatus(workspace, config, { maxBytes: 256 * 1024, signal });
  const changedFiles = Array.isArray(args.changedFiles)
    ? normalizePaths(args.changedFiles)
    : normalizePaths(status.changedFiles || []);
  let impact = { affectedTests: [], impactedPaths: [] };
  if (changedFiles.length) {
    try {
      impact = await relaiCodeInspect(
        workspace,
        config,
        { action: 'impact', paths: changedFiles, maxResults: 200, maxDepth: 3 },
        { watch: false, signal }
      );
    } catch (error) {
      if (signal?.aborted) {
        if (signal.reason instanceof Error) throw signal.reason;
        throw error;
      }
    }
  }
  const topology = discoverRepositoryTopology(workspace.path);
  const packageIds = [...new Set(changedFiles.map(file => packageForPath(topology, file)?.id).filter(Boolean))];
  const quickUnits = detectVerifyCheckUnits(workspace.path, 'quick');
  const standardUnits = detectVerifyCheckUnits(workspace.path, 'standard');
  const releaseUnits = detectVerifyCheckUnits(workspace.path, 'release');
  const packageScoped = units => packageIds.length ? units.filter(unit => packageIds.includes(unit.packageId) || !unit.packageId) : units;
  const quick = packageScoped(quickUnits).map(checkReference);
  const standard = packageScoped(standardUnits).map(checkReference);
  const release = releaseUnits.map(checkReference);
  const focused = deriveFocusedChecks(buildCheckCatalog(topology), quickUnits, packageIds, impact.affectedTests || []);
  const affectedTests = normalizePaths(impact.affectedTests || []);
  const impactedPaths = normalizePaths(impact.impactedPaths || []).slice(0, 200);
  const classification = classifyWorkflowRisk({ changedFiles, packageIds, affectedTests, impactedPaths });
  const requestedScope = normalizePaths([...changedFiles, ...affectedTests, ...impactedPaths]);
  const fingerprint = await createValidationFingerprint(workspace, config, { status, paths: requestedScope, signal });
  const payload = {
    version: 2,
    workspace: workspace.alias,
    workspacePath: workspace.path,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    changedFiles,
    validationScope: fingerprint.scopePaths,
    workspaceFingerprint: fingerprint.fingerprint,
    fingerprintVersion: FINGERPRINT_VERSION,
    affectedTests,
    impactedPaths,
    checks: { focused, quick, standard, release },
    recommended: args.release === true ? 'release' : recommendedPlanLevel(classification)
  };
  const planId = `vplan_${crypto.randomBytes(18).toString('base64url')}`;
  const signature = signPlan(config, planId, payload);
  writePlan(config, planId, { ...payload, planId, signature });
  return { ok: true, ...payload, planId, signature, use: 'Pass planId to relai_validate with action "checks" to execute the content-bound selected plan.' };
}

async function createValidationFingerprint(workspace, config, options = {}) {
  const signal = options.signal;
  signal?.throwIfAborted?.();
  const explicitPaths = Array.isArray(options.paths);
  let status = options.status || await workspaceGitStatus(workspace, config, { maxBytes: 256 * 1024, signal });
  // Only a confirmed non-repository gets the complete filesystem fallback.
  // Timeouts, denied Git reads, and truncated observations must fail closed.
  let filesystem = null;
  if (status?.ok !== true) {
    if (!await isNonGitWorkspace(workspace, config, signal)) {
      throw new Error('Validation fingerprint is incomplete because repository status is unavailable. Retry after a complete repository observation.');
    }
    filesystem = await nonGitWorkspaceSnapshot(workspace, config, signal);
    status = { ok: true, nonGit: true, repositoryHead: '', branch: '', changedFiles: filesystem.paths, statusEntries: [] };
  }
  // Mutation ownership selects checks and review paths, but does not establish
  // their input boundary. Until a check has a proven complete dependency scope,
  // include repository HEAD and every dirty input at every freshness boundary.
  const repositoryWide = filesystem !== null || options.repositoryWide !== false;
  const repositoryChangedFiles = repositoryWide ? await repositoryDirtyPaths(workspace, config, status, signal) : [];
  const changedFiles = explicitPaths
    ? normalizePaths(options.paths)
    : repositoryWide ? repositoryChangedFiles : normalizePaths(status?.changedFiles || []);
  const scopePaths = normalizePaths([
    ...changedFiles,
    ...validationConfigPaths(workspace.path, changedFiles)
  ]);
  const fingerprintCache = new Map(filesystem?.entries || []);
  const fingerprint = async file => {
    signal?.throwIfAborted?.();
    if (!fingerprintCache.has(file)) {
      fingerprintCache.set(file, await fingerprintPath(workspace.path, file, signal));
    }
    return fingerprintCache.get(file);
  };
  const relevantFiles = [];
  for (const file of scopePaths) relevantFiles.push(await fingerprint(file));
  const repositoryDirtyFiles = [];
  if (repositoryWide) {
    for (const file of repositoryChangedFiles) repositoryDirtyFiles.push(await fingerprint(file));
  }
  // Reuse only this operation's status snapshot. Porcelain v2 includes HEAD,
  // so no second process is needed; independently invoked fingerprints still
  // collect fresh status before and after a validation command.
  const repositoryHead = typeof status?.repositoryHead === 'string'
    ? status.repositoryHead
    : status?.unborn === true ? '' : await readRepositoryHead(workspace, config, signal);
  const checks = {
    quick: detectVerifyChecks(workspace.path, 'quick'),
    standard: detectVerifyChecks(workspace.path, 'standard'),
    release: detectVerifyChecks(workspace.path, 'release')
  };
  const descriptor = {
    version: FINGERPRINT_VERSION,
    workspace: workspace.alias,
    scopePaths,
    relevantFiles,
    repository: {
      kind: filesystem ? 'filesystem' : 'git',
      excludedRuntimePaths: validationRuntimePaths(workspace.path, config).map(entry => ({ path: path.relative(workspace.path, entry.path).replaceAll('\\', '/'), subtree: entry.subtree })),
      head: repositoryHead,
      branch: String(status?.branch || ''),
      unborn: status?.unborn === true,
      repositoryWide,
      dirtyFiles: repositoryDirtyFiles
    },
    checks
  };
  return {
    fingerprint: crypto.createHash('sha256').update(stableJson(descriptor)).digest('base64url'),
    version: FINGERPRINT_VERSION,
    changedFiles,
    scopePaths
  };
}

async function isNonGitWorkspace(workspace, config, signal) {
  const result = await runReadOnlyProcess('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: workspace.path, timeout: 5000, maxOutputBytes: 4096,
    env: { LC_ALL: 'C', LANG: 'C' }, signal
  }, config);
  signal?.throwIfAborted?.();
  return result.exitCode === 128 && !result.timedOut && !result.cancelled
    && result.terminationConfirmed !== false && !result.stdoutTruncated && !result.stderrTruncated
    && !result.stdoutSpillTruncated && !result.stderrSpillTruncated && !result.outputFinalizationTimedOut
    && /not a git repository/i.test(String(result.stderr || ''));
}

function validationRuntimePaths(workspaceRoot, config) {
  const root = path.resolve(workspaceRoot);
  const state = path.resolve(getStateDir(config));
  const fromState = path.relative(state, root);
  if (!fromState || (fromState !== '..' && !fromState.startsWith('..' + path.sep) && !path.isAbsolute(fromState))) {
    throw new Error('Validation fingerprint is incomplete: runtime state cannot occupy the workspace or an ancestor.');
  }
  const runtimePaths = [{ path: state, subtree: true }, ...(config.auditLogPath ? [{ path: path.resolve(config.auditLogPath), subtree: false }] : [])];
  return runtimePaths.filter(entry => {
    const relative = path.relative(root, entry.path);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
}

function isRuntimeInputPath(absolute, excluded, directory = false) {
  return excluded.some(entry => {
    const relative = path.relative(entry.path, absolute);
    if (!relative) return entry.subtree || !directory;
    return entry.subtree && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  });
}

async function nonGitWorkspaceSnapshot(workspace, config, signal) {
  const root = path.resolve(workspace.path);
  const excluded = validationRuntimePaths(root, config);
  const snapshotSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const entries = new Map();
  const pending = [''];
  let entryCount = 0;
  const budget = { remainingBytes: 128 * 1024 * 1024 };
  while (pending.length) {
    snapshotSignal.throwIfAborted();
    const directory = pending.pop();
    const children = await fs.promises.readdir(path.join(root, directory), { withFileTypes: true });
    for (const child of children) {
      snapshotSignal.throwIfAborted();
      const relative = directory ? path.posix.join(directory, child.name) : child.name;
      if (normalizePath(relative) !== relative) throw new Error('Validation fingerprint is incomplete: non-Git workspace contains an unsupported non-canonical input path.');
      const absolute = path.resolve(root, relative);
      if (isRuntimeInputPath(absolute, excluded, child.isDirectory())) continue;
      if (++entryCount > 10000) throw new Error('Validation fingerprint is incomplete: non-Git workspace exceeds the 10000-entry snapshot budget.');
      if (child.isDirectory()) {
        const runtimeAncestor = excluded.some(entry => {
          const childPath = path.relative(absolute, entry.path);
          return childPath && childPath !== '..' && !childPath.startsWith('..' + path.sep) && !path.isAbsolute(childPath);
        });
        if (!runtimeAncestor) entries.set(relative, { path: relative, type: 'directory' });
        pending.push(relative);
        continue;
      }
      if (!child.isFile()) throw new Error('Validation fingerprint is incomplete: non-Git workspace contains a symbolic link or unsupported file type.');
      const entry = await fingerprintPath(root, relative, snapshotSignal, budget);
      if (entry.type !== 'file') throw new Error('Validation fingerprint is incomplete: a non-Git input changed during the snapshot.');
      entries.set(relative, entry);
    }
  }
  return { paths: [...entries.keys()].sort(), entries };
}

async function repositoryDirtyPaths(workspace, config, status, signal) {
  let rawPaths = status.changedFiles || [];
  if (rawPaths.some(file => typeof file !== 'string' || normalizePath(file) !== file)) {
    throw new Error('Validation fingerprint is incomplete: repository status contains an unsupported non-canonical input path.');
  }
  const excluded = validationRuntimePaths(workspace.path, config);
  const isRuntimePath = file => isRuntimeInputPath(path.resolve(workspace.path, file), excluded, file.endsWith('/'));
  // Configuration cannot hide tracked dependencies. Only known untracked
  // runtime artifacts are omitted from the Git-observable input inventory.
  const untrackedPaths = new Set((status.statusEntries || []).filter(entry => entry.untracked).map(entry => entry.path));
  rawPaths = rawPaths.filter(file => !untrackedPaths.has(file) || !isRuntimePath(file));
  const opaqueRoots = (status.statusEntries || []).filter(entry => entry.opaqueDirectory).map(entry => entry.path).filter(file => !isRuntimePath(file));
  if (!opaqueRoots.length) return normalizePaths(rawPaths);
  // Normal porcelain collapses new directories. Resolve their complete ignored-
  // aware file inventory before hashing; a stable directory name is not content.
  const listed = await runReadOnlyProcess('git', ['ls-files', '--others', '--exclude-standard', '-z', '--',
    ...opaqueRoots.map(root => `:(literal)${root}`)], {
    cwd: workspace.path, timeout: 30_000, maxOutputBytes: 16 * 1024 * 1024,
    preserveOutputWhitespace: true, signal
  }, config);
  signal?.throwIfAborted?.();
  const output = String(listed.stdout || '');
  if (listed.exitCode !== 0 || listed.timedOut || listed.cancelled || listed.terminationConfirmed === false
    || listed.stdoutTruncated || listed.stdoutSpillTruncated || listed.outputFinalizationTimedOut
    || (output && !output.endsWith('\0')) || output.includes('\uFFFD')) {
    throw new Error('Validation fingerprint is incomplete because the untracked file inventory did not settle completely.');
  }
  const inventory = output.split('\0').filter(Boolean);
  if (inventory.some(file => normalizePath(file) !== file)) {
    throw new Error('Validation fingerprint is incomplete: untracked inventory contains an unsupported non-canonical input path.');
  }
  const roots = new Set(opaqueRoots);
  return normalizePaths([...rawPaths.filter(file => !roots.has(file)), ...inventory.filter(file => !isRuntimePath(file))]);
}

async function readRepositoryHead(workspace, config, signal) {
  signal?.throwIfAborted?.();
  const result = await runReadOnlyProcess('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: workspace.path,
    timeout: 30_000,
    maxOutputBytes: 1024 * 1024,
    signal
  }, config);
  signal?.throwIfAborted?.();
  return result.exitCode === 0 && !result.stdoutTruncated
    ? String(result.stdout || '').trim()
    : '';
}

function validationConfigPaths(root, scopePaths = []) {
  const directories = new Set(['']);
  for (const file of scopePaths) {
    let directory = path.posix.dirname(normalizePath(file));
    while (directory && directory !== '.') {
      directories.add(directory);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const candidates = [];
  for (const directory of directories) {
    for (const file of VALIDATION_CONFIG_PATHS) {
      const relative = directory ? path.posix.join(directory, file) : file;
      if (fs.existsSync(path.join(root, relative))) candidates.push(relative);
    }
  }
  return normalizePaths(candidates);
}

async function fingerprintPath(root, relativePath, signal, budget = null) {
  signal?.throwIfAborted?.();
  const normalized = normalizePath(relativePath);
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Validation fingerprint input is outside the workspace.');
  let stat;
  try {
    stat = await fs.promises.lstat(absolute);
  } catch (error) {
    signal?.throwIfAborted?.();
    if (error?.code === 'ENOENT') return { path: normalized, type: 'missing' };
    throw new Error(`Validation fingerprint could not read input metadata: ${normalized}`, { cause: error });
  }
  signal?.throwIfAborted?.();
  if (stat.isSymbolicLink()) {
    return { path: normalized, type: 'symlink', target: await fs.promises.readlink(absolute) };
  }
  if (stat.isDirectory()) throw new Error(`Validation fingerprint is incomplete for directory input: ${normalized}`);
  if (!stat.isFile()) return { path: normalized, type: 'other', size: stat.size };
  if (budget && stat.size > budget.remainingBytes) throw new Error('Validation fingerprint is incomplete: non-Git workspace exceeds the 128 MiB snapshot budget.');
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(absolute, signal ? { signal } : undefined);
  for await (const chunk of stream) {
    signal?.throwIfAborted?.();
    if (budget) {
      budget.remainingBytes -= chunk.length;
      if (budget.remainingBytes < 0) throw new Error('Validation fingerprint is incomplete: non-Git workspace exceeds the 128 MiB snapshot budget.');
    }
    hash.update(chunk);
  }
  signal?.throwIfAborted?.();
  return {
    path: normalized,
    type: 'file',
    size: stat.size,
    sha256: hash.digest('hex')
  };
}

function deriveFocusedChecks(catalog, quickUnits, packageIds, affectedTests) {
  const direct = [];
  for (const testPath of affectedTests.slice(0, 20)) {
    if (/\.(?:mjs|cjs|js)$/i.test(testPath)) direct.push(`node ${quotePath(testPath)}`);
  }
  if (direct.length) return [...new Set(direct)];
  const scoped = [...catalog, ...(quickUnits || [])]
    .filter(unit => !packageIds.length || !unit.packageId || packageIds.includes(unit.packageId))
    .filter(unit => unit.kind !== 'migration')
    .filter((unit, index, values) => values.findIndex(item => item.id === unit.id && item.cwd === unit.cwd && item.command === unit.command) === index)
    .sort((a, b) => checkCost(a) - checkCost(b));
  const preferred = scoped.find(unit => unit.kind === 'test')
    || scoped.find(unit => ['typecheck', 'lint'].includes(unit.kind))
    || scoped[0];
  return preferred ? [checkReference(preferred)] : [];
}

function checkReference(unit) {
  return unit?.source === 'detected' ? unit.command : (unit?.id || unit?.command || '');
}
function checkCost(unit) {
  const cost = { small: 1, medium: 2, large: 3 };
  return cost[unit?.estimatedCost] || 2;
}

function recommendedPlanLevel({ boundary, risk }) {
  if (boundary.level === 'release') return 'release';
  if (boundary.level === 'repository' || boundary.level === 'cross_package') return 'standard';
  if (risk.level === 'high' && !boundary.affectedTests?.length) return 'standard';
  return 'focused';
}

function quotePath(value) {
  const text = String(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function planDirectory(config) {
  return path.join(getStateDir(config), 'validation-plans');
}

function planPath(config, planId) {
  const value = String(planId || '').trim();
  if (!/^vplan_[A-Za-z0-9_-]{20,100}$/.test(value)) throw new Error('Invalid validation planId.');
  return path.join(planDirectory(config), `${value}.json`);
}

function writePlan(config, planId, payload) {
  writeJsonAtomic(planPath(config, planId), payload, { mode: 0o600, spacing: 2 });
}

function readValidationPlan(config, planId, workspace) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(planPath(config, planId), 'utf8')); }
  catch { throw new Error(`Validation plan '${planId}' was not found.`); }
  if (Date.parse(plan.expiresAt || 0) <= Date.now()) throw new Error(`Validation plan '${planId}' expired.`);
  if (workspace && (plan.workspace !== workspace.alias || plan.workspacePath !== workspace.path)) throw new Error('Validation plan belongs to another workspace.');
  if (plan.signature !== signPlan(config, planId, planWithoutSignature(plan))) throw new Error('Validation plan signature is invalid.');
  return plan;
}

function signPlan(config, planId, payload) {
  return crypto.createHmac('sha256', planKey(config)).update(planId).update('\0').update(stableJson(payload)).digest('base64url');
}

function planKey(config) {
  const explicit = String(process.env.REL_AI_REQUEST_STATE_KEY || '').trim();
  if (explicit.length >= 32) return explicit;
  const seed = `${config.stateDir}|${config.auditLogPath}|rel-ai-validation-plan`;
  return crypto.createHash('sha256').update(seed).digest();
}

function planWithoutSignature(plan) {
  const copy = { ...plan };
  delete copy.signature;
  delete copy.planId;
  return copy;
}

function normalizePaths(values) {
  return [...new Set(values.map(normalizePath).filter(Boolean))].sort();
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

export { createValidationFingerprint, createValidationPlan, readValidationPlan,  };
