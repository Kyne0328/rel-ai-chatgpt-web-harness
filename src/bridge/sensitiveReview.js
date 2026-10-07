

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { resolveSafePath } from "../safety.js";
import { parseEnv } from "../envOperations.js";
import { runReadOnlyProcess } from "../process.js";

async function buildSensitiveReview(workspace, config, paths, ownership, staged) {
  const entries = [];
  for (const relativePath of paths) {
    const statusEntry = ownership.entries.find((item) => item.path === relativePath);
    entries.push(isDotEnvPath(relativePath)
      ? await buildEnvReview(workspace, config, relativePath, statusEntry, staged)
      : {
          path: relativePath,
          classification: 'sensitive',
          status: statusEntry?.code || 'modified',
          valuesReturned: false
        });
  }
  return entries;
}

async function buildEnvReview(workspace, config, relativePath, statusEntry, staged) {
  const before = await readGitVersion(workspace, config, relativePath, 'HEAD:');
  const after = staged
    ? await readGitVersion(workspace, config, relativePath, ':')
    : readWorkingTreeFile(workspace, relativePath);
  const beforeMap = envValueHashes(before);
  const afterMap = envValueHashes(after);
  const beforeKeys = [...beforeMap.keys()];
  const afterKeys = [...afterMap.keys()];
  return {
    path: relativePath,
    classification: 'environment',
    status: statusEntry?.code || 'modified',
    addedKeys: afterKeys.filter((key) => !beforeMap.has(key)),
    removedKeys: beforeKeys.filter((key) => !afterMap.has(key)),
    changedKeys: afterKeys.filter((key) => beforeMap.has(key) && beforeMap.get(key) !== afterMap.get(key)),
    malformedLinesBefore: parseEnv(before).malformedLines,
    malformedLinesAfter: parseEnv(after).malformedLines,
    valuesReturned: false
  };
}

async function readGitVersion(workspace, config, relativePath, prefix) {
  const result = await runReadOnlyProcess('git', ['show', `${prefix}${relativePath}`], { cwd: workspace.path, timeout: 30000 }, config);
  return result.exitCode === 0 ? String(result.stdout || '') : '';
}

function readWorkingTreeFile(workspace, relativePath) {
  try {
    const safe = resolveSafePath(workspace.path, relativePath, { operation: 'review-redacted' });
    return fs.existsSync(safe.absolutePath) ? fs.readFileSync(safe.absolutePath, 'utf8') : '';
  } catch {
    return '';
  }
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
