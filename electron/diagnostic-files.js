import * as fs from 'node:fs';
import * as path from 'node:path';
import { importResourceModule } from './resource-path.js';

const { sanitizeDiagnosticValue } = await importResourceModule('src/diagnostics.js');

function createDiagnosticFiles({ app, shell, now = () => new Date() } = {}) {
  if (!app || typeof app.getPath !== 'function') throw new Error('Electron app path access is required.');
  if (!shell || typeof shell.openPath !== 'function') throw new Error('Electron shell access is required.');

  function directory() {
    return path.join(app.getPath('userData'), 'diagnostics');
  }

  function serviceLogPath() {
    return path.join(directory(), 'service.log');
  }

  function crashDumpsPath() {
    try {
      const configured = String(app.getPath('crashDumps') || '').trim();
      if (configured) return configured;
    } catch {}
    return path.join(directory(), 'crashes');
  }

  function listCrashDumps(limit = 20) {
    let entries;
    try { entries = fs.readdirSync(crashDumpsPath(), { withFileTypes: true }); }
    catch { return []; }
    return entries
      .filter(entry => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith('.dmp'))
      .map(entry => {
        const file = path.join(crashDumpsPath(), entry.name);
        const stat = fs.statSync(file);
        return { name: entry.name, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, Math.max(0, Math.min(100, Number(limit) || 20)));
  }

  async function openFolder() {
    const target = await ensureDirectory();
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { ok: true, directory: target };
  }

  async function exportReport(report) {
    const exportedAt = now();
    const sanitized = sanitizeDiagnosticValue({
      ...(report || {}),
      desktopCrashDumps: listCrashDumps()
    });
    const payload = {
      schemaVersion: 1,
      exportedAt: exportedAt.toISOString(),
      report: sanitized
    };
    const text = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(text, 'utf8') > 2 * 1024 * 1024) throw new Error('Diagnostic export exceeds the 2 MiB safety limit.');
    const targetDirectory = await ensureDirectory();
    const filename = `relai-diagnostic-state-${fileTimestamp(exportedAt)}.json`;
    const target = path.join(targetDirectory, filename);
    await fs.promises.writeFile(target, text, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, path: target, directory: targetDirectory, filename };
  }

  async function ensureDirectory() {
    const target = directory();
    await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
    return target;
  }

  return { directory, serviceLogPath, crashDumpsPath, listCrashDumps, openFolder, exportReport };
}

function fileTimestamp(value) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}

export { createDiagnosticFiles, fileTimestamp };
