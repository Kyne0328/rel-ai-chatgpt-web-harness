import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveWorkspace } from './config.js';
import { requestStateKey } from './mcp/context.js';
import { principalFingerprint } from './mcp/principal.ts';
import { assertAuthorizedToolCall } from './mcp/authorizationPolicy.ts';
import { OPERATION_IDS as OP } from './tools/operationIds.js';
import { resolveWorkspaceSourcePath } from './workspaceSources.js';

const ARTIFACT_RESOURCE_TEMPLATE = 'relai://artifact/{token}';
const ARTIFACT_RESOURCE_PREFIX = 'relai://artifact/';
const ARTIFACT_TOKEN_VERSION = 1;
const ARTIFACT_TOKEN_TTL_MS = 10 * 60 * 1000;
const ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;

async function createArtifactResourceLink(workspace, config, requestedPath, options = {}) {
  const safe = resolveWorkspaceSourcePath(workspace, requestedPath, { operation: 'read' });
  const before = await fs.promises.stat(safe.absolutePath);
  if (!before.isFile()) throw new Error(`Artifact target is not a file: ${safe.relativePath}`);
  if (before.size > ARTIFACT_MAX_BYTES) {
    throw new Error(`Artifact is ${before.size} bytes; the current MCP resource limit is ${ARTIFACT_MAX_BYTES} bytes.`);
  }
  const sha256 = await sha256File(safe.absolutePath);
  const after = await fs.promises.stat(safe.absolutePath);
  if (!after.isFile() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`Artifact changed while it was being prepared: ${safe.relativePath}. Retry relai_read asResource.`);
  }
  const mimeType = artifactMimeType(safe.relativePath);
  const name = path.basename(safe.relativePath) || 'artifact';
  const expiresAt = Date.now() + ARTIFACT_TOKEN_TTL_MS;
  const token = sealArtifactClaims(config, {
    v: ARTIFACT_TOKEN_VERSION,
    w: workspace.alias,
    p: safe.relativePath,
    h: sha256,
    s: before.size,
    e: expiresAt,
    f: principalFingerprint(options.principal)
  });
  return {
    path: safe.relativePath,
    sha256,
    bytes: before.size,
    mimeType,
    name,
    expiresAt: new Date(expiresAt).toISOString(),
    resourceLink: {
      type: 'resource_link',
      uri: `${ARTIFACT_RESOURCE_PREFIX}${token}`,
      name,
      mimeType,
      size: before.size,
      description: `Rel.AI workspace artifact from ${workspace.alias}`
    }
  };
}

async function readArtifactResource(config, uri, options = {}) {
  const claims = openArtifactClaims(config, artifactTokenFromUri(uri));
  if (claims.v !== ARTIFACT_TOKEN_VERSION || !claims.w || !claims.p || !claims.h || !claims.f) {
    throw new Error('Invalid Rel.AI artifact resource.');
  }
  if (!Number.isSafeInteger(claims.s) || claims.s < 0 || claims.s > ARTIFACT_MAX_BYTES) {
    throw new Error('Invalid Rel.AI artifact resource size.');
  }
  if (!Number.isFinite(claims.e) || claims.e <= Date.now()) throw new Error('Rel.AI artifact resource has expired.');
  const actualPrincipal = principalFingerprint(options.principal);
  if (!safeEqual(claims.f, actualPrincipal)) throw new Error('Rel.AI artifact resource is unavailable.');
  assertAuthorizedToolCall({ principal: options.principal, operationName: OP.READ, workspace: claims.w });

  const workspace = resolveWorkspace(config, claims.w);
  const safe = resolveWorkspaceSourcePath(workspace, claims.p, { operation: 'read' });
  const stat = await fs.promises.stat(safe.absolutePath);
  if (!stat.isFile() || stat.size !== claims.s) throw staleArtifactError(safe.relativePath);
  const data = await fs.promises.readFile(safe.absolutePath);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (!safeEqual(sha256, claims.h)) throw staleArtifactError(safe.relativePath);
  return {
    contents: [{
      uri: String(uri),
      mimeType: artifactMimeType(safe.relativePath),
      blob: data.toString('base64')
    }],
    ttlMs: 0,
    cacheScope: 'private'
  };
}

function isArtifactResourceUri(uri) {
  return String(uri || '').startsWith(ARTIFACT_RESOURCE_PREFIX);
}

function artifactTokenFromUri(uri) {
  const text = String(uri || '');
  if (!isArtifactResourceUri(text)) throw new Error(`Unsupported artifact resource URI: ${text}`);
  const token = text.slice(ARTIFACT_RESOURCE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{40,4096}$/.test(token)) throw new Error('Invalid Rel.AI artifact resource token.');
  return token;
}

function sealArtifactClaims(config, claims) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', artifactKey(config), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function openArtifactClaims(config, token) {
  try {
    const encoded = Buffer.from(token, 'base64url');
    if (encoded.length < 29) throw new Error('short token');
    if (encoded.toString('base64url') !== token) throw new Error('non-canonical token');
    const iv = encoded.subarray(0, 12);
    const tag = encoded.subarray(12, 28);
    const encrypted = encoded.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', artifactKey(config), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
  } catch {
    throw new Error('Invalid Rel.AI artifact resource token.');
  }
}

function artifactKey(config) {
  return crypto.createHash('sha256')
    .update(requestStateKey(config), 'utf8')
    .update('\0relai-artifact-resource-v1', 'utf8')
    .digest();
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function artifactMimeType(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.json': 'application/json', '.csv': 'text/csv',
    '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.wasm': 'application/wasm',
    '.apk': 'application/vnd.android.package-archive', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  })[ext] || 'application/octet-stream';
}

function staleArtifactError(relativePath) {
  return new Error(`Rel.AI artifact changed after the resource link was created: ${relativePath}. Request a fresh relai_read asResource link.`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export {
  ARTIFACT_RESOURCE_TEMPLATE,
  createArtifactResourceLink,
  isArtifactResourceUri,
  readArtifactResource
};
