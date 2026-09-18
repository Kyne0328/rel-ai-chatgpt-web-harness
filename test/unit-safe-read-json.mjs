import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { safeReadJson } from "../src/safety.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-read-json-'));
const orig = console.warn;
const previousDebug = process.env.REL_AI_MCP_DEBUG;
process.env.REL_AI_MCP_DEBUG = '1';

// valid JSON
const validFile = path.join(tmp, 'valid.json');
fs.writeFileSync(validFile, '{"ok":true,"count":3}');
const result = safeReadJson(validFile);
assert.deepEqual(result, { ok: true, count: 3 }, 'valid JSON parsed correctly');

// malformed JSON
const badFile = path.join(tmp, 'bad.json');
fs.writeFileSync(badFile, '{broken json{{');
const warned = [];
try {
  console.warn = (...args) => warned.push(args.join(' '));
  const badResult = safeReadJson(badFile);
  assert.equal(badResult, null, 'malformed JSON returns null');
  assert.ok(warned.length > 0, 'warning logged on bad JSON');
  assert.ok(warned[0].includes(badFile), 'warning includes file path');
} finally {
  console.warn = orig;
}

// missing file
const missingFile = path.join(tmp, 'missing.json');
const warned2 = [];
try {
  console.warn = (...args) => warned2.push(args.join(' '));
  const missingResult = safeReadJson(missingFile);
  assert.equal(missingResult, null, 'missing file returns null');
  assert.ok(warned2.length > 0, 'warning logged for missing file');
} finally {
  console.warn = orig;
}

// empty file
const emptyFile = path.join(tmp, 'empty.json');
fs.writeFileSync(emptyFile, '');
const warned3 = [];
try {
  console.warn = (...args) => warned3.push(args.join(' '));
  const emptyResult = safeReadJson(emptyFile);
  assert.equal(emptyResult, null, 'empty file returns null');
  assert.ok(warned3.length > 0, 'warning logged for empty file');
} finally {
  console.warn = orig;
}

// custom fallback — missingFile was never created above
const fallbackResult = safeReadJson(missingFile, { default: true });
assert.deepEqual(fallbackResult, { default: true }, 'custom fallback returned on error');

if (previousDebug == null) delete process.env.REL_AI_MCP_DEBUG;
else process.env.REL_AI_MCP_DEBUG = previousDebug;
fs.rmSync(tmp, { recursive: true });
console.log('safeReadJson unit tests passed.');
