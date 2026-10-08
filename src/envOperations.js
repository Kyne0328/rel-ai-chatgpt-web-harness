

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { resolveSafePath } from "./safety.js";
import { captureNativeMutationPaths } from "./taskIntegrity.ts";
import { appendOperation, makeOperationId } from "./journal.js";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function runEnvOperation(workspace, config, args = {}) {
  const action = String(args.envAction || '').trim().toLowerCase();
  if (!['list', 'set', 'remove', 'compare'].includes(action)) {
    throw new Error('relai_edit envAction must be one of: list, set, remove, compare.');
  }
  const relativePath = String(args.path || '.env').trim();
  const operation = `env-${action}`;
  const safe = resolveSafePath(workspace.path, relativePath, { operation });
  if (!fs.existsSync(safe.absolutePath)) {
    if (action !== 'set') throw new Error(`Environment file does not exist: ${safe.relativePath}`);
  }
  const original = fs.existsSync(safe.absolutePath) ? fs.readFileSync(safe.absolutePath, 'utf8') : '';
  const currentSha256 = fs.existsSync(safe.absolutePath) ? sha256Text(original) : null;
  const expectedSha256 = String(args.expectedSha256 || '').trim();
  if (expectedSha256 && currentSha256 !== expectedSha256) {
    throw new Error(`Environment operation refused stale expectedSha256 for ${safe.relativePath}. Re-run envAction list and retry with the current hash.`);
  }
  const parsed = parseEnv(original);

  if (action === 'list') {
    return baseResult(workspace, safe.relativePath, action, parsed, false, Boolean(args.dryRun));
  }
  if (action === 'compare') {
    const templatePath = String(args.templatePath || '.env.example').trim();
    const template = resolveSafePath(workspace.path, templatePath, { operation: 'read' });
    if (!fs.existsSync(template.absolutePath)) throw new Error(`Environment template does not exist: ${template.relativePath}`);
    const templateParsed = parseEnv(fs.readFileSync(template.absolutePath, 'utf8'));
    const currentKeys = new Set(parsed.keys);
    const templateKeys = new Set(templateParsed.keys);
    return {
      ...baseResult(workspace, safe.relativePath, action, parsed, false, Boolean(args.dryRun)),
      templatePath: template.relativePath,
      missingKeys: templateParsed.keys.filter((key) => !currentKeys.has(key)),
      extraKeys: parsed.keys.filter((key) => !templateKeys.has(key)),
      templateMalformedLines: templateParsed.malformedLines
    };
  }

  const key = validateKey(args.key);
  let next;
  let changed;
  if (action === 'set') {
    const value = validateValue(args.value);
    next = setKey(original, parsed, key, value);
    changed = next !== original;
  } else {
    next = removeKey(original, parsed, key);
    changed = next !== original;
  }

  const dryRun = Boolean(args.dryRun);
  if (changed && !dryRun) {
    if (args.work_id) captureNativeMutationPaths(config, String(args.work_id), workspace.alias, [safe.relativePath], { operation });
    try { atomicWrite(safe.absolutePath, next); }
    catch {
      const failure = new Error('Environment write outcome could not be verified. Reconcile the file before retrying.');
      Object.assign(failure, { handlerResult: { ok: false, workspace: workspace.alias, path: safe.relativePath, mutationEffect: 'unknown', changedFiles: [], possibleChangedFiles: [safe.relativePath], valuesReturned: false, error: failure.message } });
      throw failure;
    }
  }
  const result = {
    ...baseResult(workspace, safe.relativePath, action, parseEnv(next), changed, dryRun),
    key,
    presentBefore: parsed.keyLines.has(key),
    presentAfter: action === 'set' ? true : false
  };
  if (!dryRun) {
    try { appendOperation(config, workspace, {
      id: makeOperationId(),
      type: 'env_edit',
      ok: true,
      paths: changed ? [safe.relativePath] : [],
      results: [{ path: safe.relativePath, operation, changed, key }]
    }); } catch {
      throw Object.assign(new Error('Environment operation completed, but its journal could not be saved.'), { handlerResult: { ...result, ok: false, error: 'Environment operation completed, but its journal could not be saved.' } });
    }
  }
  return result;
}

function baseResult(workspace, relativePath, action, parsed, changed, dryRun) {
  return {
    ok: true,
    workspace: workspace.alias,
    path: relativePath,
    operation: `env-${action}`,
    changed,
    dryRun,
    keys: parsed.keys,
    keyCount: parsed.keys.length,
    malformedLines: parsed.malformedLines,
    sha256: parsed.sha256 || undefined,
    valuesReturned: false,
    mutationEffect: changed && !dryRun ? 'applied' : 'none',
    changedFiles: changed && !dryRun ? [relativePath] : []
  };
}

function parseEnv(text) {
  const source = String(text);
  const lines = source.split(/\r?\n/);
  const keys = [];
  const keyLines = new Map();
  const malformedLines = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      malformedLines.push(index + 1);
      continue;
    }
    const key = match[1];
    if (!keyLines.has(key)) keys.push(key);
    const entries = keyLines.get(key) || [];
    entries.push(index);
    keyLines.set(key, entries);
  }
  return { lines, keys, keyLines, malformedLines, sha256: sha256Text(source) };
}

function setKey(original, parsed, key, value) {
  const line = `${key}=${value}`;
  const indexes = parsed.keyLines.get(key) || [];
  if (indexes.length === 0) {
    const separator = original && !original.endsWith('\n') ? '\n' : '';
    return `${original}${separator}${line}\n`;
  }
  const kept = parsed.lines.filter((_, index) => !indexes.includes(index));
  kept.splice(indexes[0], 0, line);
  return normalizeJoinedLines(kept, original);
}

function removeKey(original, parsed, key) {
  const indexes = parsed.keyLines.get(key) || [];
  if (indexes.length === 0) return original;
  const kept = parsed.lines.filter((_, index) => !indexes.includes(index));
  return normalizeJoinedLines(kept, original);
}

function normalizeJoinedLines(lines, original) {
  let text = lines.join('\n');
  if (original.endsWith('\n') && !text.endsWith('\n')) text += '\n';
  return text;
}

function validateKey(value) {
  const key = String(value || '').trim();
  if (!ENV_KEY.test(key)) throw new Error('Environment key must match [A-Za-z_][A-Za-z0-9_]*.');
  return key;
}

function validateValue(value) {
  if (typeof value !== 'string') throw new Error('envAction set requires value as a string.');
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('Environment values must be single-line strings without NUL characters.');
  }
  return value;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function atomicWrite(absolutePath, content) {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const mode = fs.existsSync(absolutePath) ? fs.statSync(absolutePath).mode & 0o7777 : 0o600;
  const temporary = `${absolutePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, absolutePath);
    fs.chmodSync(absolutePath, mode);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

export { runEnvOperation, parseEnv };
