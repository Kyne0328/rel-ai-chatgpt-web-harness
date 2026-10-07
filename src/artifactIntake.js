import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { combineAbortSignals } from './abortSignals.js';
import { appendOperation, makeOperationId } from './journal.js';
import { resolveSafePath } from './safety.js';

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const REDIRECT_LIMIT = 3;
const OPENAI_FILE_HOSTS = new Set(['files.oaiusercontent.com']);
const OPENAI_REGIONAL_BLOB_HOST = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/u;
const OPENAI_FILE_KEYS = new Set(['download_url', 'file_id', 'mime_type', 'file_name', 'name', 'size']);

async function importNativeArtifact(workspace, config, args = {}, options = {}) {
  options.signal?.throwIfAborted?.();
  const reference = normalizeReference(args.file);
  const safe = resolveSafePath(workspace.path, args.path, { operation: 'write', label: 'Artifact destination' });
  if (fs.existsSync(safe.absolutePath)) throw new Error(`Artifact destination already exists: ${safe.relativePath}`);
  if (args.dryRun === true) {
    return {
      ok: true,
      workspace: workspace.alias,
      dryRun: true,
      operation: 'artifact_import',
      path: safe.relativePath,
      changed: false,
      changedFiles: [],
      fileId: reference.file_id,
      fileName: reference.file_name,
      mimeType: reference.mime_type
    };
  }
  fs.mkdirSync(path.dirname(safe.absolutePath), { recursive: true });
  const verified = resolveSafePath(workspace.path, safe.relativePath, { operation: 'write', label: 'Artifact destination' });
  if (fs.existsSync(verified.absolutePath)) throw new Error(`Artifact destination already exists: ${verified.relativePath}`);

  let response;
  let downloadUrl = validateDownloadUrl(reference.download_url);
  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    const signal = combineAbortSignals(options.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
    try {
      response = await fetch(downloadUrl, { redirect: 'manual', signal });
    } catch (error) {
      options.signal?.throwIfAborted?.();
      throw new Error('ChatGPT artifact could not be downloaded.', { cause: error });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === REDIRECT_LIMIT) throw new Error('ChatGPT artifact download returned an invalid redirect.');
    downloadUrl = validateDownloadUrl(new URL(location, downloadUrl).toString());
  }
  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => undefined);
    throw new Error('ChatGPT artifact download did not return file content.');
  }

  const declaredLength = positiveInteger(response.headers.get('content-length'));
  if (declaredLength > MAX_ARTIFACT_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit.`);
  }
  if (reference.size !== undefined && declaredLength && reference.size !== declaredLength) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('ChatGPT artifact metadata did not match the downloaded content length.');
  }

  const stagingPath = path.join(path.dirname(verified.absolutePath), `.relai-import-${crypto.randomUUID()}.tmp`);
  let stagingOwned = false;
  let cleanupPending = false;
  let handle;
  let reader;
  let bytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    handle = await fs.promises.open(stagingPath, 'wx', 0o600);
    stagingOwned = true;
    reader = response.body.getReader();
    while (true) {
      options.signal?.throwIfAborted?.();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      bytes += value.byteLength;
      if (bytes > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds the ${MAX_ARTIFACT_BYTES} byte limit.`);
      hash.update(value);
      await writeAll(handle, value);
    }
    options.signal?.throwIfAborted?.();
    if (reference.size !== undefined && bytes !== reference.size) throw new Error('ChatGPT artifact metadata did not match the downloaded byte size.');
    if (declaredLength && bytes !== declaredLength) throw new Error('Downloaded artifact length did not match the HTTP response.');
    await handle.sync();
    await handle.close();
    handle = null;
    options.signal?.throwIfAborted?.();
    const destination = resolveSafePath(workspace.path, verified.relativePath, { operation: 'write', label: 'Artifact destination' });
    // An exclusive hard link publishes complete bytes atomically without replacing
    // a destination created by another writer during the download.
    await fs.promises.link(stagingPath, destination.absolutePath);
    try { await fs.promises.rm(stagingPath); stagingOwned = false; } catch { cleanupPending = true; }
  } catch (error) {
    try { await reader?.cancel(error); } catch {}
    try { await handle?.close(); } catch {}
    if (!reader) { try { await response.body.cancel(error); } catch {} }
    if (stagingOwned) { try { await fs.promises.rm(stagingPath, { force: true }); } catch {} }
    throw error;
  }

  const operationId = makeOperationId();
  const sha256 = hash.digest('hex');
  appendOperation(config, workspace, {
    id: operationId,
    type: 'artifact_import',
    ok: true,
    paths: [verified.relativePath],
    results: [{ path: verified.relativePath, bytes, sha256 }]
  });
  return {
    ok: true,
    workspace: workspace.alias,
    dryRun: false,
    operationId,
    operation: 'artifact_import',
    path: verified.relativePath,
    changed: true,
    ...(cleanupPending ? { cleanupPending: true } : {}),
    changedFiles: [verified.relativePath],
    bytes,
    sha256,
    fileId: reference.file_id,
    fileName: reference.file_name,
    mimeType: reference.mime_type || response.headers.get('content-type')?.split(';')[0]?.trim() || undefined
  };
}

function normalizeReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('relai_edit file must be a native ChatGPT file reference.');
  const keys = Object.keys(value);
  if (!keys.includes('download_url') || !keys.includes('file_id') || keys.some(key => !OPENAI_FILE_KEYS.has(key))) {
    throw new Error('ChatGPT file reference is malformed.');
  }
  const downloadUrl = value.download_url;
  const fileId = value.file_id;
  if (typeof downloadUrl !== 'string' || typeof fileId !== 'string' || !fileId || fileId.length > 512 || hasControlCharacters(fileId)) {
    throw new Error('ChatGPT file reference is malformed.');
  }
  const mimeType = optionalString(value.mime_type);
  const suppliedFileName = optionalString(value.file_name);
  const suppliedName = optionalString(value.name);
  if (mimeType === null || suppliedFileName === null || suppliedName === null) throw new Error('ChatGPT file reference is malformed.');
  const fileName = normalizeFileName(suppliedFileName);
  const name = normalizeFileName(suppliedName);
  if (fileName && name && fileName !== name) throw new Error('ChatGPT file reference contained conflicting filenames.');
  let size;
  if (value.size !== undefined && value.size !== null) {
    if (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_ARTIFACT_BYTES) throw new Error('ChatGPT file reference has an invalid size.');
    size = value.size;
  }
  return { download_url: downloadUrl, file_id: fileId, mime_type: mimeType, file_name: fileName || name, size };
}

function validateDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('ChatGPT file download URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !trustedHost(url.hostname)) {
    throw new Error('ChatGPT file download URL is not on a trusted OpenAI file host.');
  }
  return url.toString();
}

function trustedHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return OPENAI_FILE_HOSTS.has(value) || OPENAI_REGIONAL_BLOB_HOST.test(value);
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : null;
}

function normalizeFileName(value) {
  if (!value) return undefined;
  const leaf = path.basename(String(value).replaceAll('\\', '/')).trim();
  return !leaf || leaf === '.' || leaf === '..' ? undefined : leaf;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function hasControlCharacters(value) {
  for (const character of String(value || '')) {
    const code = character.codePointAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

async function writeAll(handle, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const result = await handle.write(value, offset, value.byteLength - offset);
    if (!result.bytesWritten) throw new Error('Artifact write made no progress.');
    offset += result.bytesWritten;
  }
}

export { importNativeArtifact, normalizeReference, validateDownloadUrl };
