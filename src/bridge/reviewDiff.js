import * as fs from 'node:fs';
import { looksBinary, resolveSafePath } from '../safety.js';

function truncateDiff(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '')
    + `\n[rel-ai-mcp diff truncated at ${maxBytes} bytes]`;
}

function buildUntrackedDiff(workspace, paths, maxBytes = 1024 * 1024) {
  const budget = Math.max(0, Math.min(5 * 1024 * 1024, Math.floor(Number(maxBytes) || 0)));
  const sections = [];
  let remaining = budget;
  for (const relativePath of paths) {
    if (remaining < 256) { sections.push('\n[rel-ai-mcp untracked diff truncated: output budget exhausted]\n'); break; }
    let descriptor;
    try {
      const safe = resolveSafePath(workspace.path, relativePath, { operation: 'review' });
      descriptor = fs.openSync(safe.absolutePath, 'r');
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) throw new Error('Not a regular file.');
      // Reserve space for path/header and worst-case newline prefix expansion.
      const header = `\ndiff --git a/${safe.relativePath} b/${safe.relativePath}\nnew file mode 100644\n`;
      const allowance = Math.max(0, Math.floor((remaining - Buffer.byteLength(header) - 256) / 2));
      const data = Buffer.alloc(Math.min(stat.size, allowance));
      let count = 0;
      while (count < data.length) {
        const read = fs.readSync(descriptor, data, count, data.length - count, count);
        if (!read) break;
        count += read;
      }
      const bytes = data.subarray(0, count);
      let section;
      if (looksBinary(bytes)) {
        section = header + `Binary files /dev/null and b/${safe.relativePath} differ\n`;
      } else {
        const text = bytes.toString('utf8').replace(/\uFFFD+$/u, '').replaceAll('\r\n', '\n');
        const lines = text ? (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n') : [];
        section = header + ['--- /dev/null', `+++ b/${safe.relativePath}`,
          `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => '+' + line), ''].join('\n');
      }
      if (count < stat.size) section += '[rel-ai-mcp untracked diff truncated: bounded file prefix only]\n';
      const bounded = truncateDiff(section, remaining);
      sections.push(bounded);
      remaining -= Buffer.byteLength(bounded);
    } catch (error) {
      const message = truncateDiff(`\n[rel-ai-mcp could not read untracked file ${relativePath}: ${error instanceof Error ? error.message : String(error)}]\n`, remaining);
      sections.push(message);
      remaining -= Buffer.byteLength(message);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return sections.join('');
}

function normalizePaths(values) {
  return [...new Set((values || []).map(value => String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '')).filter(Boolean))].sort();
}

export { buildUntrackedDiff, normalizePaths, truncateDiff };
