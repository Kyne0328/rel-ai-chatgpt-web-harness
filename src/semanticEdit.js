import crypto from 'node:crypto';
import fs from 'node:fs';

import { resolveSafePath } from './safety.js';
import { repositoryIntelligence } from './repository/intelligence/service.js';

const MIN_SEMANTIC_CONFIDENCE = 0.8;
const MAX_SYMBOL_CANDIDATES = 100;
const SYMBOL_ACTIONS = new Set(['replace', 'insert_before', 'insert_after']);

async function resolveSymbolEdit(workspace, config, input = {}, options = {}) {
  const action = String(input.action || '').trim().toLowerCase();
  const symbol = String(input.symbol || '').trim();
  const content = input.content;
  if (!SYMBOL_ACTIONS.has(action)) throw new Error('symbolEdit.action must be replace, insert_before, or insert_after.');
  if (!symbol) throw new Error('symbolEdit.symbol is required.');
  if (typeof content !== 'string') throw new Error('symbolEdit.content must be a string.');

  const requestedPath = normalizePath(input.path);
  const inspection = await repositoryIntelligence.codeInspect(workspace, config, {
    action: 'symbol',
    symbol,
    maxResults: MAX_SYMBOL_CANDIDATES
  });
  const definitions = Array.isArray(inspection?.definitions) ? inspection.definitions : [];
  const exactQualified = definitions.filter(item => String(item.qualifiedName || '') === symbol);
  let candidates = exactQualified.length ? exactQualified : definitions;
  if (requestedPath) {
    const safeRequested = resolveSafePath(workspace.path, requestedPath, { operation: 'read', label: 'Semantic edit path' });
    candidates = candidates.filter(item => normalizePath(item.path) === safeRequested.relativePath);
  }
  if (candidates.length === 0) {
    throw semanticError('SEMANTIC_SYMBOL_NOT_FOUND', `No indexed symbol '${symbol}'${requestedPath ? ` exists in ${requestedPath}` : ' was found'}. Re-run relai_inspect or use an exact file edit.`);
  }
  if (candidates.length > 1) {
    const choices = candidates.slice(0, 8).map(item => `${item.qualifiedName || item.name} (${item.path}:${item.line})`).join(', ');
    throw semanticError('SEMANTIC_SYMBOL_AMBIGUOUS', `Symbol '${symbol}' is ambiguous. Pass symbolEdit.path or a qualified symbol. Candidates: ${choices}`);
  }

  const target = candidates[0];
  if (String(target.provider || '') !== 'tree-sitter' || Number(target.confidence || 0) < MIN_SEMANTIC_CONFIDENCE) {
    throw semanticError('SEMANTIC_SYMBOL_UNSAFE', `Symbol '${symbol}' does not have a reliable structural range. Use an exact file edit instead.`);
  }

  const safe = resolveSafePath(workspace.path, target.path, { operation: 'write', proposedContent: content, label: 'Semantic edit path' });
  const data = fs.readFileSync(safe.absolutePath);
  const currentSha256 = sha256(data);
  if (target.sourceSha256 && currentSha256 !== target.sourceSha256) {
    throw semanticError('SEMANTIC_SYMBOL_STALE', `The indexed source changed before semantic editing could start: ${safe.relativePath}. Re-run the symbol edit so Rel.AI can resolve the current symbol range.`);
  }
  const expectedSha256 = String(options.expectedSha256 || '').trim();
  if (expectedSha256 && expectedSha256 !== currentSha256) {
    throw semanticError('SEMANTIC_SYMBOL_STALE', `The file changed after the caller inspected it: ${safe.relativePath}. Re-read or re-inspect the symbol before editing.`);
  }

  const range = byteRangeForSymbol(data, target);
  const oldText = data.subarray(range.start, range.end).toString('utf8');
  if (!oldText) throw semanticError('SEMANTIC_SYMBOL_EMPTY', `Symbol '${symbol}' resolved to an empty range in ${safe.relativePath}.`);
  const newline = detectNewline(data);
  const newText = semanticReplacement(action, oldText, content, newline);
  const prefix = data.subarray(0, range.start).toString('utf8');
  const occurrence = countOccurrences(prefix, oldText) + 1;

  return {
    path: safe.relativePath,
    oldText,
    newText,
    occurrence,
    sourceSha256: currentSha256,
    target: {
      action,
      symbol,
      name: String(target.name || ''),
      qualifiedName: String(target.qualifiedName || ''),
      kind: String(target.kind || ''),
      path: safe.relativePath,
      line: Number(target.line || 0),
      column: Number(target.column || 0),
      endLine: Number(target.endLine || 0),
      endColumn: Number(target.endColumn || 0),
      provider: String(target.provider || ''),
      confidence: Number(target.confidence || 0)
    }
  };
}

function byteRangeForSymbol(data, target) {
  const starts = [0];
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) starts.push(index + 1);
  const startLine = positiveInteger(target.line, 'symbol start line');
  const endLine = positiveInteger(target.endLine, 'symbol end line');
  const startColumn = positiveInteger(target.column, 'symbol start column');
  const endColumn = positiveInteger(target.endColumn, 'symbol end column');
  if (startLine > starts.length || endLine > starts.length) throw semanticError('SEMANTIC_SYMBOL_RANGE_INVALID', 'The indexed symbol range is outside the current file.');
  const start = byteOffsetForColumn(startLine, startColumn);
  const end = byteOffsetForColumn(endLine, endColumn);
  if (start < 0 || end < start || end > data.length) throw semanticError('SEMANTIC_SYMBOL_RANGE_INVALID', 'The indexed symbol byte range is invalid for the current file.');
  return { start, end };

  function byteOffsetForColumn(line, column) {
    const lineStart = starts[line - 1];
    const lineEnd = line < starts.length ? starts[line] - 1 : data.length;
    const text = data.subarray(lineStart, lineEnd).toString('utf8');
    const offset = column - 1;
    // web-tree-sitter reports UTF-16 columns, while Buffer slices use UTF-8 bytes.
    if (offset > text.length || (offset > 0 && offset < text.length
      && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]))) {
      throw semanticError('SEMANTIC_SYMBOL_RANGE_INVALID', 'The indexed symbol column is invalid for the current line.');
    }
    return lineStart + Buffer.byteLength(text.slice(0, offset), 'utf8');
  }
}

function semanticReplacement(action, oldText, content, newline) {
  if (action === 'replace') return content;
  if (!content) return oldText;
  if (action === 'insert_before') return `${content}${endsWithLineBreak(content) ? '' : newline}${oldText}`;
  return `${oldText}${startsWithLineBreak(content) ? '' : newline}${content}`;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function detectNewline(data) {
  return data.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
}

function startsWithLineBreak(value) {
  return value.startsWith('\n') || value.startsWith('\r');
}

function endsWithLineBreak(value) {
  return value.endsWith('\n') || value.endsWith('\r');
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw semanticError('SEMANTIC_SYMBOL_RANGE_INVALID', `${label} is invalid.`);
  return number;
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function semanticError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export { resolveSymbolEdit };
