import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeJsonAtomic } from '../durableState.ts';
import { runProcess } from '../process.js';
import { getStateDir } from '../statePaths.js';
import { workspaceGitStatus } from '../repo/gitOps.js';
import { relaiCodeInspect } from './codeIntelligence.js';
import { detectVerifyCheckUnits, detectVerifyChecks } from './checkDetection.js';
import { buildCheckCatalog } from '../workflow/checkCatalog.js';
import { classifyWorkflowRisk } from '../workflow/risk.js';
import { discoverRepositoryTopology, packageForPath } from '../workflow/topology.js';

const PLAN_TTL_MS = 30 * 60 * 1000;
const FINGERPRINT_VERSION = 3;
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
  const requestedScope = normalizePaths([...changedFiles, ...affectedTests, ...impactedPaths]).slice(0, 1000);
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
  const status = options.status || await workspaceGitStatus(workspace, config, { maxBytes: 256 * 1024, signal });
  const repositoryWide = options.repositoryWide === true;
  const changedFiles = explicitPaths
    ? normalizePaths(options.paths)
    : normalizePaths(status?.changedFiles || []);
  const repositoryChangedFiles = normalizePaths(status?.changedFiles || []);
  const scopePaths = normalizePaths([
    ...changedFiles,
    ...validationConfigPaths(workspace.path, changedFiles)
  ]).slice(0, 1000);
  const fingerprintCache = new Map();
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
  const repositoryHead = await readRepositoryHead(workspace, config, signal);
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

async function readRepositoryHead(workspace, config, signal) {
  signal?.throwIfAborted?.();
  const result = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], {
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

async function fingerprintPath(root, relativePath, signal) {
  signal?.throwIfAborted?.();
  const normalized = normalizePath(relativePath);
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { path: normalized, type: 'outside' };
  let stat;
  try {
    stat = await fs.promises.lstat(absolute);
  } catch (error) {
    signal?.throwIfAborted?.();
    return { path: normalized, type: error?.code === 'ENOENT' ? 'missing' : 'unreadable', code: String(error?.code || '') };
  }
  signal?.throwIfAborted?.();
  if (stat.isSymbolicLink()) {
    return { path: normalized, type: 'symlink', target: await fs.promises.readlink(absolute) };
  }
  if (stat.isDirectory()) return { path: normalized, type: 'directory' };
  if (!stat.isFile()) return { path: normalized, type: 'other', size: stat.size };
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(absolute, signal ? { signal } : undefined);
  for await (const chunk of stream) {
    signal?.throwIfAborted?.();
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export { createValidationFingerprint, createValidationPlan, readValidationPlan,  };
