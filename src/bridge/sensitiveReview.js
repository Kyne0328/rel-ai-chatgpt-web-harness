

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveSafePath, isPathInside } from "../safety.js";
import { parseEnv } from "../envOperations.js";
import { runReadOnlyProcess } from "../process.js";

async function buildSensitiveReview(workspace, config, paths, ownership, staged, context = {}) {
  const entries = [];
  for (const relativePath of paths) {
    const statusEntry = ownership.entries.find((item) => item.path === relativePath);
    entries.push(isDotEnvPath(relativePath)
      ? await buildEnvReview(workspace, config, relativePath, statusEntry, staged, ownership.unborn, context)
      : {
          path: relativePath,
          classification: 'sensitive',
          status: statusEntry?.code || 'modified',
          valuesReturned: false
        });
  }
  return entries;
}

async function buildEnvReview(workspace, config, relativePath, statusEntry, staged, unborn, context) {
  const before = unborn || statusEntry?.untracked || statusEntry?.code?.[0] === 'A'
    ? { availability: 'absent', text: '' }
    : await readGitVersion(workspace, config, relativePath, 'HEAD:', context);
  const after = staged
    ? statusEntry?.code?.[0] === 'D' ? { availability: 'absent', text: '' }
      : await readGitVersion(workspace, config, relativePath, ':', context)
    : readWorkingTreeFile(workspace, relativePath);
  if (before.availability === 'unavailable' || after.availability === 'unavailable') {
    return {
      path: relativePath, classification: 'environment', status: statusEntry?.code || 'modified',
      availability: 'unavailable', beforeAvailability: before.availability, afterAvailability: after.availability,
      valuesReturned: false
    };
  }
  const beforeMap = envValueHashes(before.text);
  const afterMap = envValueHashes(after.text);
  const beforeKeys = [...beforeMap.keys()];
  const afterKeys = [...afterMap.keys()];
  return {
    path: relativePath,
    classification: 'environment',
    status: statusEntry?.code || 'modified',
    availability: 'available',
    beforeAvailability: before.availability,
    afterAvailability: after.availability,
    addedKeys: afterKeys.filter((key) => !beforeMap.has(key)),
    removedKeys: beforeKeys.filter((key) => !afterMap.has(key)),
    changedKeys: afterKeys.filter((key) => beforeMap.has(key) && beforeMap.get(key) !== afterMap.get(key)),
    malformedLinesBefore: parseEnv(before.text).malformedLines,
    malformedLinesAfter: parseEnv(after.text).malformedLines,
    valuesReturned: false
  };
}

async function readGitVersion(workspace, config, relativePath, prefix, context) {
  try {
    const result = await runReadOnlyProcess('git', ['show', `${prefix}${relativePath}`], { cwd: workspace.path, timeout: 30000, signal: context.signal }, config);
    context.signal?.throwIfAborted?.();
    return result.executed === true && result.exitCode === 0 && !result.cancelled && !result.timedOut
      && !result.stdoutTruncated && !result.stdoutSpillTruncated && !result.outputFinalizationTimedOut && result.terminationConfirmed !== false
      ? { availability: 'available', text: String(result.stdout || '') }
      : { availability: 'unavailable' };
  } catch {
    context.signal?.throwIfAborted?.();
    return { availability: 'unavailable' };
  }
}

function readWorkingTreeFile(workspace, relativePath) {
  let safe;
  try { safe = resolveSafePath(workspace.path, relativePath, { operation: 'review-redacted' }); }
  catch { return { availability: 'unavailable' }; }
  try { fs.lstatSync(safe.absolutePath); }
  catch (error) {
    if (error?.code !== 'ENOENT') return { availability: 'unavailable' };
    try {
      const parent = fs.realpathSync(path.dirname(safe.absolutePath));
      const root = fs.realpathSync(workspace.path);
      if (isPathInside(parent, root) && fs.statSync(parent).isDirectory()) {
        return { availability: 'absent', text: '' };
      }
    } catch {}
    return { availability: 'unavailable' };
  }
  try { return { availability: 'available', text: fs.readFileSync(safe.absolutePath, 'utf8') }; }
  catch { return { availability: 'unavailable' }; }
}

function envValueHashes(text) {
  const parsed = parseEnv(text);
  const map = new Map();
  for (const [key, indexes] of parsed.keyLines.entries()) {
    const values = indexes.map((index) => {
      const line = parsed.lines[index] || '';
      return line.slice(line.indexOf('=') + 1);
    });
    map.set(key, crypto.createHash('sha256').update(values.join('\u0000'), 'utf8').digest('hex'));
  }
  return map;
}

function isDotEnvPath(relativePath) {
  const leaf = String(relativePath || '').replaceAll('\\', '/').toLowerCase().split('/').at(-1) || '';
  return leaf === '.env' || leaf.startsWith('.env.') || leaf.startsWith('.env-');
}

export { buildSensitiveReview };
