import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGitExecutable } from './gitExecutable.js';

const execFileAsync = promisify(execFile);
const PROVENANCE_SCHEMA_VERSION = 1;
const BUILD_ID_LENGTH = 12;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40,64}$/;

async function readRepositoryBuildState(root) {
  const repositoryRoot = path.resolve(root);
  const [revisionOutput, sourceList, status] = await Promise.all([
    gitBuffer(repositoryRoot, ['rev-parse', '--verify', 'HEAD']),
    gitBuffer(repositoryRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    gitBuffer(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=normal'])
  ]);
  const sourceRevision = revisionOutput.toString('utf8').trim().toLowerCase();
  if (!REVISION_PATTERN.test(sourceRevision)) throw new Error(`Git returned an invalid source revision: ${sourceRevision || '(empty)'}.`);

  const sourcePaths = [...new Set(sourceList.toString('utf8').split('\0').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256');
  hash.update('rel-ai-mcp-build-source-v2\0');

  for (const relativePath of sourcePaths) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    assertContained(repositoryRoot, absolutePath, relativePath);
    hash.update(relativePath.replaceAll('\\', '/'));
    hash.update('\0');
    let stat;
    try {
      stat = await fs.promises.lstat(absolutePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hash.update('missing\0');
      continue;
    }
    hash.update(String(stat.mode));
    hash.update('\0');
    if (stat.isSymbolicLink()) hash.update(await fs.promises.readlink(absolutePath, 'utf8'));
    else if (stat.isFile()) hash.update(await fs.promises.readFile(absolutePath));
    else hash.update('directory');
    hash.update('\0');
  }

  return Object.freeze({
    sourceRevision,
    sourceFingerprint: hash.digest('hex'),
    dirty: status.length > 0
  });
}

async function createBuildProvenance(root, options = {}) {
  const state = await readRepositoryBuildState(root);
  const provenance = normalizeBuildProvenance({
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    version: String(options.version || '').trim(),
    builtAt: String(options.builtAt || new Date().toISOString()),
    ...state
  });
  if (!provenance) throw new Error('Could not create valid build provenance metadata.');
  return provenance;
}

function normalizeBuildProvenance(value = {}) {
  const schemaVersion = Number(value.schemaVersion);
  const version = String(value.version || '').trim();
  const builtAt = String(value.builtAt || '').trim();
  const sourceRevision = String(value.sourceRevision || '').trim().toLowerCase();
  const sourceFingerprint = String(value.sourceFingerprint || '').trim().toLowerCase();
  if (schemaVersion !== PROVENANCE_SCHEMA_VERSION) return null;
  if (!version || !Number.isFinite(Date.parse(builtAt))) return null;
  if (!REVISION_PATTERN.test(sourceRevision) || !FINGERPRINT_PATTERN.test(sourceFingerprint)) return null;
  return Object.freeze({
    schemaVersion,
    version,
    builtAt,
    sourceRevision,
    sourceFingerprint,
    dirty: value.dirty === true
  });
}

function buildIdFromFingerprint(value) {
  const fingerprint = String(value || '').trim().toLowerCase();
  return FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint.slice(0, BUILD_ID_LENGTH) : '';
}

async function gitBuffer(root, args) {
  const executable = resolveGitExecutable();
  if (!executable) throw new Error('Git executable is unavailable while reading build provenance.');
  try {
    const { stdout } = await execFileAsync(executable, args, {
      cwd: root,
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
  } catch (error) {
    const detail = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8').trim() : String(error?.stderr || '').trim();
    throw new Error(`Git ${args.join(' ')} failed${detail ? `: ${detail}` : '.'}`, { cause: error });
  }
}

function assertContained(root, candidate, relativePath) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build input escapes the repository: ${relativePath}.`);
  }
}

export {
  buildIdFromFingerprint, createBuildProvenance, normalizeBuildProvenance, readRepositoryBuildState
};
