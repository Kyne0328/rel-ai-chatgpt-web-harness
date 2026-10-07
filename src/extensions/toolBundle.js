import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sevenZip from '7zip-bin';
import { extract as extractTar } from 'tar';
import yauzl from 'yauzl';

const MAX_SEVEN_ZIP_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ZIP_SYMLINK_TARGET_BYTES = 4096;
const SEVEN_ZIP_TIMEOUT_MS = 5 * 60_000;

function prepareBundledSevenZipExecutable() {
  const executable = sevenZip.path7za;
  // 7zip-bin ships POSIX binaries without execute permission. Do not change a
  // system command selected through USE_SYSTEM_7ZA, or Windows permissions.
  if (process.platform !== 'win32' && path.isAbsolute(executable)) {
    try {
      const stat = fs.lstatSync(executable);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Bundled 7-Zip executable must be a regular file.');
      }
      try {
        fs.accessSync(executable, fs.constants.X_OK);
      } catch (error) {
        if (error.code !== 'EACCES') throw error;
        fs.chmodSync(executable, (stat.mode & 0o7777) | 0o100);
        fs.accessSync(executable, fs.constants.X_OK);
      }
    } catch (error) {
      throw new Error(`Could not prepare bundled 7-Zip executable '${executable}': ${error.message}`, { cause: error });
    }
  }
  return executable;
}

async function extractToolBundleZip(archivePath, destination, options = {}) {
  const format = detectToolBundleArchiveFormat(archivePath);
  if (format === 'tar.gz') {
    return await extractToolBundleTarGz(archivePath, destination, options);
  }
  if (format === 'tar.xz') {
    return await extractToolBundleTarXz(archivePath, destination, options);
  }
  if (format === '7z') {
    return await extractToolBundle7z(archivePath, destination, options);
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
      const regularFiles = new Set();
      const pendingLinks = [];

      const fail = error => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch {}
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      zipFile.on('error', error => fail(new Error('Tool bundle ZIP could not be read.', { cause: error })));
      zipFile.on('end', () => {
        if (settled) return;
        try {
          extractedBytes = materializeArchiveFileLinks({
            destination,
            pendingLinks,
            regularFiles,
            extractedBytes,
            maxExtractedBytes,
            maxFileBytes
          });
          settled = true;
          resolve({ entryCount, extractedBytes });
        } catch (error) {
          fail(error);
        }
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
          if (unixType && unixType !== 0o100000 && unixType !== 0o040000 && unixType !== 0o120000) {
            throw new Error(`Tool bundle entry '${normalized}' is not a regular file, directory, or safe file link.`);
          }

          const isDirectory = entry.fileName.endsWith('/') || unixType === 0o040000;
          const target = safeArchiveJoin(destination, normalized);
          if (isDirectory) {
            fs.mkdirSync(target, { recursive: true, mode: 0o700 });
            zipFile.readEntry();
            return;
          }

          if (unixType === 0o120000) {
            if (entry.uncompressedSize > MAX_ZIP_SYMLINK_TARGET_BYTES) {
              throw new Error(`Tool bundle link '${normalized}' has an invalid target.`);
            }
            const input = await openEntryStream(zipFile, entry);
            const chunks = [];
            let bytes = 0;
            for await (const chunk of input) {
              bytes += chunk.length;
              if (bytes > MAX_ZIP_SYMLINK_TARGET_BYTES) {
                throw new Error(`Tool bundle link '${normalized}' has an invalid target.`);
              }
              chunks.push(chunk);
            }
            const linkTarget = Buffer.concat(chunks).toString('utf8');
            if (!linkTarget || linkTarget.includes('\0')) {
              throw new Error(`Tool bundle link '${normalized}' has an invalid target.`);
            }
            pendingLinks.push({ normalized, linkTarget, relativeToLink: true });
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
          regularFiles.add(normalized);
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
  return await extractToolBundleTarArchive(archivePath, destination, options);
}

async function extractToolBundleTarXz(archivePath, destination, options = {}) {
  const maxEntries = positiveLimit(options.maxEntries, 20_000);
  const maxExtractedBytes = positiveLimit(options.maxExtractedBytes, 2 * 1024 * 1024 * 1024);
  const tarPath = `${archivePath}.relai-${process.pid}-${Date.now()}.tar`;
  const maxTarBytes = maxExtractedBytes + Math.max(16 * 1024 * 1024, maxEntries * 1024);
  try {
    await decompressXzToTar(archivePath, tarPath, maxTarBytes);
    return await extractToolBundleTarArchive(tarPath, destination, options);
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}

async function extractToolBundleTarArchive(archivePath, destination, options = {}) {
  const maxEntries = positiveLimit(options.maxEntries, 20_000);
  const maxExtractedBytes = positiveLimit(options.maxExtractedBytes, 2 * 1024 * 1024 * 1024);
  const maxFileBytes = positiveLimit(options.maxFileBytes, 1024 * 1024 * 1024);
  let entryCount = 0;
  let extractedBytes = 0;
  let validationError = null;
  const seen = new Set();
  const regularFiles = new Set();
  const pendingLinks = [];

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
          const isSymbolicLink = type === 'SymbolicLink';
          const isHardLink = type === 'Link';
          if (!isDirectory && !isFile && !isSymbolicLink && !isHardLink) {
            throw new Error(`Tool bundle entry '${normalized}' is not a regular file, directory, or safe file link.`);
          }
          if (isSymbolicLink || isHardLink) {
            const linkTarget = String(entry?.linkpath || '');
            if (!linkTarget || linkTarget.includes('\0')) {
              throw new Error(`Tool bundle link '${normalized}' has an invalid target.`);
            }
            pendingLinks.push({ normalized, linkTarget, relativeToLink: isSymbolicLink });
            return false;
          }
          if (entry?.linkpath) {
            throw new Error(`Tool bundle entry '${normalized}' contains an unexpected link target.`);
          }
          if (isDirectory) return true;

          regularFiles.add(normalized);
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
    extractedBytes = materializeArchiveFileLinks({
      destination,
      pendingLinks,
      regularFiles,
      extractedBytes,
      maxExtractedBytes,
      maxFileBytes
    });
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }

  return { entryCount, extractedBytes };
}

async function extractToolBundle7z(archivePath, destination, options = {}) {
  const limits = archiveLimits(options);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  try {
    const listing = await runSevenZip(['l', '-slt', '-sccUTF-8', archivePath]);
    validateSevenZipListing(listing.stdout, limits);
    await runSevenZip(['x', '-y', '-bd', '-bb0', '-sccUTF-8', `-o${destination}`, archivePath]);
    return validateExtractedTree(destination, limits);
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function validateSevenZipListing(output, limits) {
  const marker = output.indexOf('----------');
  if (marker < 0) throw new Error('Tool bundle 7Z listing is malformed.');
  const body = output.slice(marker + '----------'.length).trim();
  const blocks = body ? body.split(/\r?\n\s*\r?\n/) : [];
  let entryCount = 0;
  let extractedBytes = 0;
  const seen = new Set();

  for (const block of blocks) {
    const fields = new Map();
    for (const line of block.split(/\r?\n/)) {
      const split = line.indexOf(' = ');
      if (split <= 0) continue;
      fields.set(line.slice(0, split), line.slice(split + 3));
    }
    const rawPath = fields.get('Path');
    if (!rawPath) continue;
    if (++entryCount > limits.maxEntries) throw new Error('Tool bundle contains too many 7Z entries.');
    const normalized = normalizeArchivePath(rawPath.replaceAll('\\', '/'));
    if (seen.has(normalized)) throw new Error(`Tool bundle contains duplicate path '${normalized}'.`);
    seen.add(normalized);
    if (fields.get('Encrypted') === '+') throw new Error(`Tool bundle entry '${normalized}' is encrypted.`);
    if (fields.has('Symbolic Link') || fields.has('Hard Link')) {
      throw new Error(`Tool bundle entry '${normalized}' contains a link target.`);
    }

    const attributes = String(fields.get('Attributes') || '');
    const isDirectory = attributes.startsWith('D') || /\bd[r-]/i.test(attributes);
    if (/\bl[rwx-]/i.test(attributes)) {
      throw new Error(`Tool bundle entry '${normalized}' is a symbolic link.`);
    }
    if (isDirectory) continue;

    const size = Number(fields.get('Size'));
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Tool bundle entry '${normalized}' has an invalid size.`);
    if (size > limits.maxFileBytes) throw new Error(`Tool bundle entry '${normalized}' exceeds the per-file extraction limit.`);
    extractedBytes += size;
    if (extractedBytes > limits.maxExtractedBytes) throw new Error('Tool bundle exceeds the allowed extracted size.');
  }

  return { entryCount, extractedBytes };
}

function validateExtractedTree(root, limits) {
  let entryCount = 0;
  let extractedBytes = 0;
  const queue = [path.resolve(root)];

  while (queue.length) {
    const current = queue.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (++entryCount > limits.maxEntries) throw new Error('Tool bundle contains too many extracted entries.');
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`Tool bundle extracted symbolic link '${path.relative(root, target)}'.`);
      if (stat.isDirectory()) {
        queue.push(target);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Tool bundle extracted unsafe entry '${path.relative(root, target)}'.`);
      if (stat.size > limits.maxFileBytes) throw new Error(`Tool bundle entry '${path.relative(root, target)}' exceeds the per-file extraction limit.`);
      extractedBytes += stat.size;
      if (extractedBytes > limits.maxExtractedBytes) throw new Error('Tool bundle exceeds the allowed extracted size.');
    }
  }

  return { entryCount, extractedBytes };
}

async function decompressXzToTar(archivePath, tarPath, maxBytes) {
  fs.mkdirSync(path.dirname(tarPath), { recursive: true, mode: 0o700 });
  const child = spawn(prepareBundledSevenZipExecutable(), ['e', '-so', archivePath], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const output = fs.createWriteStream(tarPath, { flags: 'wx', mode: 0o600 });
  let bytes = 0;
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
    child.stdout.destroy(new Error('Tool bundle TAR.XZ decompression timed out.'));
  }, SEVEN_ZIP_TIMEOUT_MS);
  const childFinished = new Promise((resolve, reject) => {
    child.once('error', error => reject(new Error('Could not start bundled 7-Zip for TAR.XZ extraction.', { cause: error })));
    child.once('close', code => {
      if (timedOut) reject(new Error('Tool bundle TAR.XZ decompression timed out.'));
      else if (code !== 0) reject(new Error(`Tool bundle TAR.XZ decompression failed with exit code ${code}: ${stderr.trim()}`));
      else resolve();
    });
  });
  child.stderr.on('data', chunk => {
    if (stderr.length < MAX_SEVEN_ZIP_OUTPUT_BYTES) stderr += chunk.toString('utf8');
  });
  const writing = pipeline(child.stdout, new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new Error('Tool bundle TAR.XZ expands beyond the allowed intermediate size.'));
      else callback(null, chunk);
    }
  }), output);
  try {
    await Promise.all([writing, childFinished]);
  } catch (error) {
    const stopRequested = child.kill('SIGKILL');
    child.stdout.destroy();
    output.destroy();
    // Node owns the TAR file handle. Wait for its pipeline to close, but never
    // wait indefinitely for a decompressor that did not acknowledge termination.
    await writing.catch(() => {});
    if (!stopRequested && child.exitCode == null && child.signalCode == null) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} Could not confirm termination of the 7-Zip decompressor (PID ${child.pid || 'unavailable'}).`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function runSevenZip(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(prepareBundledSevenZipExecutable(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('Bundled 7-Zip operation timed out.'));
    }, SEVEN_ZIP_TIMEOUT_MS);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (current, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_SEVEN_ZIP_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('Bundled 7-Zip produced too much diagnostic output.'));
        return current;
      }
      return current + chunk.toString('utf8');
    };

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => finish(new Error('Could not start bundled 7-Zip.', { cause: error })));
    child.on('close', code => {
      if (code !== 0) finish(new Error(`Bundled 7-Zip failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`));
      else finish(null, { stdout, stderr });
    });
  });
}

function detectToolBundleArchiveFormat(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const signature = Buffer.alloc(6);
    const bytesRead = fs.readSync(fd, signature, 0, signature.length, 0);
    if (bytesRead >= 6 && signature.equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
    if (bytesRead >= 6 && signature.equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'tar.xz';
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
    throw new Error('Tool bundle is not a supported ZIP, TAR.GZ, TAR.XZ, or 7Z archive.');
  } finally {
    fs.closeSync(fd);
  }
}

function materializeArchiveFileLinks({
  destination,
  pendingLinks,
  regularFiles,
  extractedBytes,
  maxExtractedBytes,
  maxFileBytes
}) {
  if (!pendingLinks.length) return extractedBytes;
  const links = new Map(pendingLinks.map(link => [link.normalized, link]));

  const resolveTarget = (linkPath, stack = new Set()) => {
    if (stack.has(linkPath)) throw new Error(`Tool bundle contains a file-link cycle at '${linkPath}'.`);
    const link = links.get(linkPath);
    const rawTarget = link?.linkTarget;
    if (typeof rawTarget !== 'string') throw new Error(`Tool bundle link '${linkPath}' has no target.`);
    if (
      !rawTarget ||
      rawTarget.includes('\\') ||
      rawTarget.includes('\0') ||
      rawTarget.startsWith('/') ||
      /^[A-Za-z]:\//.test(rawTarget)
    ) {
      throw new Error(`Tool bundle link '${linkPath}' has an unsafe target.`);
    }

    const combined = link.relativeToLink
      ? path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), rawTarget))
      : path.posix.normalize(rawTarget);
    const normalizedTarget = normalizeArchivePath(combined);
    if (regularFiles.has(normalizedTarget)) return normalizedTarget;
    if (!links.has(normalizedTarget)) {
      throw new Error(`Tool bundle link '${linkPath}' targets missing or non-file entry '${normalizedTarget}'.`);
    }

    const nextStack = new Set(stack);
    nextStack.add(linkPath);
    return resolveTarget(normalizedTarget, nextStack);
  };

  let totalBytes = extractedBytes;
  for (const link of pendingLinks) {
    const sourceRelative = resolveTarget(link.normalized);
    const source = safeArchiveJoin(destination, sourceRelative);
    const target = safeArchiveJoin(destination, link.normalized);
    const sourceStat = fs.lstatSync(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Tool bundle link '${link.normalized}' does not resolve to a safe regular file.`);
    }
    if (sourceStat.size > maxFileBytes) {
      throw new Error(`Tool bundle link '${link.normalized}' exceeds the per-file extraction limit.`);
    }
    totalBytes += sourceStat.size;
    if (totalBytes > maxExtractedBytes) {
      throw new Error('Tool bundle exceeds the allowed extracted size.');
    }

    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size !== sourceStat.size) {
      throw new Error(`Tool bundle link '${link.normalized}' did not materialize safely.`);
    }
    if (process.platform !== 'win32') fs.chmodSync(target, sourceStat.mode & 0o777);
  }
  return totalBytes;
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

function archiveLimits(options = {}) {
  return {
    maxEntries: positiveLimit(options.maxEntries, 20_000),
    maxExtractedBytes: positiveLimit(options.maxExtractedBytes, 2 * 1024 * 1024 * 1024),
    maxFileBytes: positiveLimit(options.maxFileBytes, 1024 * 1024 * 1024)
  };
}

function positiveLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export { extractToolBundleZip, prepareBundledSevenZipExecutable };
