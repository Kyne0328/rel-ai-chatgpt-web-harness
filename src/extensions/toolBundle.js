import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar } from 'tar';
import yauzl from 'yauzl';

async function extractToolBundleZip(archivePath, destination, options = {}) {
  const format = detectToolBundleArchiveFormat(archivePath);
  if (format === 'tar.gz') {
    return await extractToolBundleTarGz(archivePath, destination, options);
  }
  return await extractToolBundleZipArchive(archivePath, destination, options);
}

async function extractToolBundleZipArchive(archivePath, destination, options = {}) {
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

async function extractToolBundleTarGz(archivePath, destination, options = {}) {
  const maxEntries = positiveLimit(options.maxEntries, 20_000);
  const maxExtractedBytes = positiveLimit(options.maxExtractedBytes, 2 * 1024 * 1024 * 1024);
  const maxFileBytes = positiveLimit(options.maxFileBytes, 1024 * 1024 * 1024);
  let entryCount = 0;
  let extractedBytes = 0;
  let validationError = null;
  const seen = new Set();

  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    await extractTar({
      file: archivePath,
      cwd: destination,
      strict: true,
      preservePaths: false,
      preserveOwner: false,
      noMtime: true,
      unlink: true,
      filter: (entryPath, entry) => {
        if (validationError) return false;
        try {
          if (++entryCount > maxEntries) throw new Error('Tool bundle contains too many TAR entries.');

          const normalized = normalizeArchivePath(entryPath);
          if (seen.has(normalized)) throw new Error(`Tool bundle contains duplicate path '${normalized}'.`);
          seen.add(normalized);

          const type = String(entry?.type || '');
          const isDirectory = type === 'Directory';
          const isFile = type === 'File' || type === 'OldFile' || type === 'ContiguousFile';
          if (!isDirectory && !isFile) {
            throw new Error(`Tool bundle entry '${normalized}' is not a regular file or directory.`);
          }
          if (entry?.linkpath) {
            throw new Error(`Tool bundle entry '${normalized}' contains a link target.`);
          }
          if (isDirectory) return true;

          const size = Number(entry?.size);
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error(`Tool bundle entry '${normalized}' has an invalid size.`);
          }
          if (size > maxFileBytes) {
            throw new Error(`Tool bundle entry '${normalized}' exceeds the per-file extraction limit.`);
          }
          extractedBytes += size;
          if (extractedBytes > maxExtractedBytes) {
            throw new Error('Tool bundle exceeds the allowed extracted size.');
          }
          return true;
        } catch (error) {
          validationError = error instanceof Error ? error : new Error(String(error));
          return false;
        }
      }
    });
    if (validationError) throw validationError;
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }

  return { entryCount, extractedBytes };
}

function detectToolBundleArchiveFormat(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const signature = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, signature, 0, signature.length, 0);
    if (bytesRead >= 2 && signature[0] === 0x1f && signature[1] === 0x8b) return 'tar.gz';
    if (
      bytesRead >= 4 &&
      signature[0] === 0x50 &&
      signature[1] === 0x4b &&
      ((signature[2] === 0x03 && signature[3] === 0x04) ||
       (signature[2] === 0x05 && signature[3] === 0x06) ||
       (signature[2] === 0x07 && signature[3] === 0x08))
    ) {
      return 'zip';
    }
    throw new Error('Tool bundle is not a supported ZIP or TAR.GZ archive.');
  } finally {
    fs.closeSync(fd);
  }
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

export { extractToolBundleTarGz, extractToolBundleZip };
