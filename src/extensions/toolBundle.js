import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

async function extractToolBundleZip(archivePath, destination, options = {}) {
  const maxEntries = positiveLimit(options.maxEntries, 20_000);
  const maxExtractedBytes = positiveLimit(options.maxExtractedBytes, 2 * 1024 * 1024 * 1024);
  const maxFileBytes = positiveLimit(options.maxFileBytes, 1024 * 1024 * 1024);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });

  return await new Promise((resolve, reject) => {
    yauzl.open(archivePath, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (openError, zipFile) => {
      if (openError) {
        reject(new Error('Tool bundle is not a valid ZIP archive.', { cause: openError }));
        return;
      }
      let settled = false;
      let entryCount = 0;
      let extractedBytes = 0;
      const seen = new Set();

      const fail = error => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch {}
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipFile.on('error', error => fail(new Error('Tool bundle ZIP could not be read.', { cause: error })));
      zipFile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ entryCount, extractedBytes });
      });
      zipFile.on('entry', entry => {
        Promise.resolve().then(async () => {
          if (++entryCount > maxEntries) throw new Error('Tool bundle contains too many ZIP entries.');
          if (typeof entry.isEncrypted === 'function' && entry.isEncrypted()) {
            throw new Error(`Tool bundle entry '${entry.fileName}' is encrypted.`);
          }

          const normalized = normalizeArchivePath(entry.fileName);
          if (seen.has(normalized)) throw new Error(`Tool bundle contains duplicate path '${normalized}'.`);
          seen.add(normalized);

          const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const unixType = unixMode & 0o170000;
          if (unixType === 0o120000) throw new Error(`Tool bundle entry '${normalized}' is a symbolic link.`);
          if (unixType && unixType !== 0o100000 && unixType !== 0o040000) {
            throw new Error(`Tool bundle entry '${normalized}' is not a regular file or directory.`);
          }

          const isDirectory = entry.fileName.endsWith('/') || unixType === 0o040000;
          const target = safeArchiveJoin(destination, normalized);
          if (isDirectory) {
            fs.mkdirSync(target, { recursive: true, mode: 0o700 });
            zipFile.readEntry();
            return;
          }

          if (entry.uncompressedSize > maxFileBytes) {
            throw new Error(`Tool bundle entry '${normalized}' exceeds the per-file extraction limit.`);
          }
          extractedBytes += entry.uncompressedSize;
          if (extractedBytes > maxExtractedBytes) {
            throw new Error('Tool bundle exceeds the allowed extracted size.');
          }

          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          const input = await openEntryStream(zipFile, entry);
          await pipeline(input, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          const stat = fs.lstatSync(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.uncompressedSize) {
            throw new Error(`Tool bundle entry '${normalized}' did not extract safely.`);
          }
          if (process.platform !== 'win32' && unixMode) {
            fs.chmodSync(target, unixMode & 0o777);
          }
          zipFile.readEntry();
        }).catch(fail);
      });
      zipFile.readEntry();
    });
  });
}

function openEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new Error(`Could not extract tool bundle entry '${entry.fileName}'.`, { cause: error || undefined }));
        return;
      }
      resolve(stream);
    });
  });
}

function normalizeArchivePath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`Unsafe tool bundle path '${raw || '(empty)'}'.`);
  }
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const segments = trimmed.split('/');
  if (!trimmed || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes(':'))) {
    throw new Error(`Unsafe tool bundle path '${raw}'.`);
  }
  return segments.join('/');
}

function safeArchiveJoin(root, relative) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Unsafe tool bundle path '${relative}'.`);
  }
  return resolved;
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export { extractToolBundleZip };
