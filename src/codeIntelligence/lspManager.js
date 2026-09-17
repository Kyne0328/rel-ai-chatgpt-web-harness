import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeProcessEnvironment } from '../processEnvironment.js';
import { resolveSafePath } from '../safety.js';
import { parseWorkspaceSourcePath, qualifyWorkspaceSourcePath, sourceWorkspace, workspaceSourceEntries } from '../workspaceSources.js';
import { isTestPath } from '../repository/intelligence/languages.js';
import { LspClient } from './lspClient.js';

const IDLE_EVICT_MS = 2 * 60 * 1000;
const DIAGNOSTIC_WAIT_MS = 3_000;
const MAX_LSP_DIAGNOSTICS = 200;
const MAX_SEMANTIC_EDIT_FILES = 100;
// Keep a busy session bounded even when it continuously visits new files.
const MAX_OPEN_DOCUMENTS = 64;
const MAX_OPEN_DOCUMENT_BYTES = 8 * 1024 * 1024;
const sessions = new Map();

const BUNDLED_ROOT = fileURLToPath(new URL('../../node_modules/', import.meta.url));
const PROVIDERS = Object.freeze([
  provider('typescript-language-server', {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
    '.ts': 'typescript', '.tsx': 'typescriptreact'
  }, {
    manifests: ['package.json', 'tsconfig.json', 'jsconfig.json'],
    executable: process.execPath,
    argv: [path.join(BUNDLED_ROOT, 'typescript-language-server', 'lib', 'cli.mjs'), '--stdio'],
    initializationOptions: { tsserver: { fallbackPath: path.join(BUNDLED_ROOT, 'typescript-lsp-runtime', 'lib', 'tsserver.js') } }
  }),
  provider('pyright', { '.py': 'python', '.pyi': 'python' }, {
    manifests: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'],
    executable: process.execPath,
    argv: [path.join(BUNDLED_ROOT, 'pyright', 'langserver.index.js'), '--stdio']
  }),
  provider('rust-analyzer', { '.rs': 'rust' }, { manifests: ['Cargo.toml'], executable: 'rust-analyzer', argv: [] }),
  provider('gopls', { '.go': 'go' }, { manifests: ['go.mod', 'go.work'], executable: 'gopls', argv: ['serve'] }),
  provider('clangd', {
    '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp'
  }, { manifests: ['compile_commands.json', 'CMakeLists.txt'], executable: 'clangd', argv: ['--background-index'] })
]);

function provider(id, languageByExtension, runtime) {
  return Object.freeze({
    id,
    languageByExtension: Object.freeze({ ...languageByExtension }),
    extensions: Object.freeze(Object.keys(languageByExtension)),
    ...runtime
  });
}

class LspSession {
  constructor(workspace, spec) {
    this.workspace = workspace;
    this.spec = spec;
    this.client = null;
    this.capabilities = {};
    this.openDocuments = new Map();
    this.pendingDocumentUris = new Map();
    this.publishedDiagnostics = new Map();
    this.documentQueue = Promise.resolve();
    this.lastUsedAt = 0;
    this.lastResponseMs = null;
    this.lastError = '';
    this.idleTimer = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.lifecycleController = null;
    this.documentAccessSequence = 0;
    this.state = 'idle';
    this.disposed = false;
  }

  async ensure(options = {}) {
    if (this.disposed) throw disposedSessionError(this.spec);
    this.touch();
    if (this.client?.state === 'running') return this;
    if (this.stopPromise) await this.stopPromise;
    if (this.disposed) throw disposedSessionError(this.spec);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(options).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async start(options = {}) {
    if (this.disposed) throw disposedSessionError(this.spec);
    if (!runtimeAvailable(this.spec)) throw unavailableError(this.spec);
    this.state = 'starting';
    this.lastError = '';
    this.openDocuments.clear();
    this.publishedDiagnostics.clear();
    const lifecycleController = new AbortController();
    this.lifecycleController = lifecycleController;
    const signal = combineAbortSignals(options.signal, lifecycleController.signal);
    const client = new LspClient({
      executable: this.spec.executable,
      argv: this.spec.argv,
      cwd: this.workspace.path,
      env: makeProcessEnvironment(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      name: this.spec.id
    });
    try {
      client.onNotification('textDocument/publishDiagnostics', params => {
        const key = diagnosticUriKey(params?.uri);
        if (key) this.publishedDiagnostics.set(key, params);
      });
      await client.start();
      const rootUri = pathToFileURL(this.workspace.path).href;
      const initialized = await client.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'Rel.AI MCP', version: '1' },
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: this.workspace.alias || path.basename(this.workspace.path) }],
        ...(this.spec.initializationOptions ? { initializationOptions: this.spec.initializationOptions } : {}),
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: {
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
            implementation: { dynamicRegistration: false },
            rename: { dynamicRegistration: false, prepareSupport: true },
            documentSymbol: { dynamicRegistration: false },
            diagnostic: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true, versionSupport: true, codeDescriptionSupport: true }
          }
        }
      }, { signal });
      if (this.disposed) throw disposedSessionError(this.spec);
      if (lifecycleController.signal.aborted) throw lifecycleAbortError(this.spec);
      this.client = client;
      this.capabilities = initialized?.capabilities || {};
      this.lastError = '';
      this.state = 'running';
      client.notify('initialized', {});
      return this;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = signal?.aborted ? (this.disposed ? 'disposed' : 'stopped') : 'failed';
      await client.stop().catch(() => {});
      throw error;
    } finally {
      if (this.state !== 'running' && this.lifecycleController === lifecycleController) {
        this.lifecycleController = null;
      }
    }
  }

  async request(method, params, options = {}) {
    await this.ensure(options);
    const client = this.client;
    if (!client || client.state !== 'running') throw new Error(`${this.spec.id} is not running.`);
    const started = Date.now();
    const signal = combineAbortSignals(options.signal, this.lifecycleController?.signal);
    const documentUri = String(params?.textDocument?.uri || '');
    if (documentUri) this.pendingDocumentUris.set(documentUri, Number(this.pendingDocumentUris.get(documentUri) || 0) + 1);
    try {
      const result = await client.request(method, params, { ...options, signal });
      this.lastResponseMs = Date.now() - started;
      this.lastError = '';
      this.touch();
      return result;
    } catch (error) {
      this.lastError = client.lastError || (error instanceof Error ? error.message : String(error));
      if (client.state === 'failed') this.state = 'failed';
      throw error;
    } finally {
      if (documentUri) {
        const pending = Number(this.pendingDocumentUris.get(documentUri) || 0) - 1;
        if (pending > 0) this.pendingDocumentUris.set(documentUri, pending);
        else this.pendingDocumentUris.delete(documentUri);
      }
    }
  }

  async positionParams(relativePath, line, column, options = {}) {
    const document = await this.open(relativePath, options);
    return {
      textDocument: { uri: document.uri },
      position: { line: Math.max(0, Number(line || 1) - 1), character: Math.max(0, Number(column || 1) - 1) }
    };
  }

  async open(relativePath, options = {}) {
    if (this.disposed) throw disposedSessionError(this.spec);
    const operation = this.documentQueue.then(() => this.openDocument(relativePath, options));
    this.documentQueue = operation.catch(() => {});
    return operation;
  }

  async openDocument(relativePath, options = {}) {
    if (this.disposed) throw disposedSessionError(this.spec);
    const safe = resolveSafePath(this.workspace.path, relativePath, { operation: 'read' });
    const stat = fs.statSync(safe.absolutePath);
    const current = this.openDocuments.get(safe.relativePath);
    const uri = pathToFileURL(safe.absolutePath).href;
    if (current && current.mtimeMs === stat.mtimeMs && current.size === stat.size) {
      current.lastUsedAt = Date.now();
      current.accessSequence = ++this.documentAccessSequence;
      this.touch();
      return current;
    }
    const text = fs.readFileSync(safe.absolutePath, 'utf8');
    await this.ensure(options);
    const client = this.client;
    if (!client || client.state !== 'running') throw new Error(`${this.spec.id} is not running.`);
    if (current) {
      this.closeDocument(safe.relativePath, current);
    }
    const languageId = languageIdForPath(this.spec, safe.relativePath);
    const document = {
      uri,
      text,
      languageId,
      version: (current?.version || 0) + 1,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastUsedAt: Date.now(),
      accessSequence: ++this.documentAccessSequence
    };
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: document.version, text }
    });
    this.openDocuments.set(safe.relativePath, document);
    this.evictOpenDocuments(safe.relativePath);
    this.touch();
    return document;
  }

  evictOpenDocuments(pinnedPath = '') {
    if (this.openDocuments.size <= MAX_OPEN_DOCUMENTS && this.openDocumentBytes() <= MAX_OPEN_DOCUMENT_BYTES) return;
    const candidates = [...this.openDocuments.entries()]
      .filter(([relativePath, document]) => relativePath !== pinnedPath && !this.pendingDocumentUris.has(document.uri))
      .sort(([, left], [, right]) => Number(left.accessSequence || 0) - Number(right.accessSequence || 0));
    let bytes = this.openDocumentBytes();
    for (const [relativePath, document] of candidates) {
      if (this.openDocuments.size <= MAX_OPEN_DOCUMENTS && bytes <= MAX_OPEN_DOCUMENT_BYTES) break;
      this.closeDocument(relativePath, document);
      bytes -= Math.max(0, Number(document.size || 0));
    }
  }

  openDocumentBytes() {
    let bytes = 0;
    for (const document of this.openDocuments.values()) bytes += Math.max(0, Number(document.size || 0));
    return bytes;
  }

  closeDocument(relativePath, document = this.openDocuments.get(relativePath)) {
    if (!document) return;
    this.publishedDiagnostics.delete(diagnosticUriKey(document.uri));
    if (this.client?.state === 'running') {
      this.client.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
    }
    this.openDocuments.delete(relativePath);
  }

  async diagnostics(relativePath, options = {}) {
    const document = await this.open(relativePath, options);
    return this.waitForDiagnostics(document.uri, relativePath, options);
  }

  waitForDiagnostics(uri, relativePath, options = {}) {
    const key = diagnosticUriKey(uri);
    if (this.publishedDiagnostics.has(key)) return Promise.resolve(this.publishedDiagnostics.get(key));
    const client = this.client;
    if (!client || client.state !== 'running') return Promise.reject(new Error(`${this.spec.id} is not running.`));
    const timeoutMs = Math.max(1, Math.min(DIAGNOSTIC_WAIT_MS, Number(options.timeoutMs || DIAGNOSTIC_WAIT_MS)));
    const signal = combineAbortSignals(options.signal, this.lifecycleController?.signal);
    return new Promise((resolve, reject) => {
      let timer;
      const cleanupNotification = client.onNotification('textDocument/publishDiagnostics', params => {
        if (diagnosticUriKey(params?.uri) === key) finish(resolve, params);
      });
      const onAbort = () => {
        const error = new Error(`Cancelled ${this.spec.id} diagnostics for ${relativePath}.`);
        error.name = 'AbortError';
        finish(reject, error);
      };
      const finish = (settle, value) => {
        clearTimeout(timer);
        cleanupNotification();
        signal?.removeEventListener?.('abort', onAbort);
        settle(value);
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (this.publishedDiagnostics.has(key)) {
        finish(resolve, this.publishedDiagnostics.get(key));
        return;
      }
      timer = setTimeout(() => finish(reject, new Error(`${this.spec.id} did not publish diagnostics for ${relativePath} within ${timeoutMs}ms.`)), timeoutMs);
      timer.unref?.();
    });
  }

  noteDiskChanges(paths = []) {
    const client = this.client;
    if (!client || client.state !== 'running') return;
    const changes = [];
    for (const relativePath of paths) {
      const current = this.openDocuments.get(relativePath);
      if (current) {
        this.closeDocument(relativePath, current);
      }
      try {
        const safe = resolveSafePath(this.workspace.path, relativePath, { operation: 'read' });
        changes.push({ uri: pathToFileURL(safe.absolutePath).href, type: fs.existsSync(safe.absolutePath) ? 2 : 3 });
      } catch {}
    }
    if (changes.length) client.notify('workspace/didChangeWatchedFiles', { changes });
  }

  status() {
    const clientState = this.client?.state;
    const state = clientState === 'failed' ? 'failed' : this.state;
    const error = this.lastError || this.client?.lastError || '';
    return {
      id: this.spec.id,
      available: runtimeAvailable(this.spec),
      active: state === 'running' && clientState === 'running',
      state,
      authority: 'language-server',
      capabilities: advertisedCapabilities(this.capabilities, this.publishedDiagnostics.size > 0),
      lastResponseMs: this.lastResponseMs,
      ...(error ? { error } : {})
    };
  }

  touch() {
    if (this.disposed) return;
    this.lastUsedAt = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), IDLE_EVICT_MS);
    this.idleTimer.unref?.();
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  async stopOnce() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.client && !this.startPromise && (this.state === 'stopped' || this.state === 'disposed')) return;
    this.state = 'stopping';
    this.lifecycleController?.abort();
    if (this.startPromise) await this.startPromise.catch(() => {});
    const client = this.client;
    this.client = null;
    this.openDocuments.clear();
    this.pendingDocumentUris.clear();
    this.publishedDiagnostics.clear();
    if (client) await client.stop().catch(() => {});
    this.lifecycleController = null;
    this.state = this.disposed ? 'disposed' : 'stopped';
  }

  async dispose() {
    if (this.disposed) return this.stopPromise || undefined;
    this.disposed = true;
    this.lifecycleController?.abort();
    await this.stop();
  }
}

function providerForPath(relativePath) {
  const ext = path.extname(String(relativePath || '')).toLowerCase();
  return PROVIDERS.find(item => item.extensions.includes(ext)) || null;
}

function languageIdForPath(spec, relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return spec.languageByExtension[ext] || '';
}

function sessionKey(workspace, spec) {
  const resolved = path.resolve(String(workspace.path || ''));
  const workspaceId = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `${workspaceId}\0${spec.id}`;
}

function getSession(workspace, spec) {
  const key = sessionKey(workspace, spec);
  let session = sessions.get(key);
  if (session?.disposed) {
    sessions.delete(key);
    session = null;
  }
  if (!session) {
    session = new LspSession(workspace, spec);
    sessions.set(key, session);
  }
  return session;
}

async function inspectWithLsp(workspace, args, anchor, options = {}) {
  const requestedPath = String(anchor?.path || args.path || '').replaceAll('\\', '/');
  const parsed = parseWorkspaceSourcePath(workspace, requestedPath);
  const relativePath = parsed.relativePath;
  const scopedWorkspace = sourceWorkspace(workspace, parsed.source);
  const spec = providerForPath(relativePath);
  if (!spec) return { available: false, reason: 'no-language-server-provider' };
  const session = getSession(scopedWorkspace, spec);
  if (!runtimeAvailable(spec)) return { available: false, provider: spec.id, reason: 'language-server-unavailable', status: session.status() };
  const line = Number(anchor?.line || args.line || 1);
  const column = Number(anchor?.column || args.column || 1);
  try {
    const position = await session.positionParams(relativePath, line, column, options);
    const action = String(args.action || '').toLowerCase();
    let raw;
    if (action === 'definition') raw = await session.request('textDocument/definition', position, options);
    else if (action === 'references') raw = await session.request('textDocument/references', { ...position, context: { includeDeclaration: true } }, options);
    else if (action === 'hover' || action === 'symbol') raw = await session.request('textDocument/hover', position, options);
    else if (action === 'implementation') raw = await session.request('textDocument/implementation', position, options);
    else return { available: false, provider: spec.id, reason: 'unsupported-lsp-action', status: session.status() };
    return {
      available: true,
      provider: spec.id,
      authority: 'language-server',
      path: qualifyWorkspaceSourcePath(parsed.source, relativePath),
      line,
      column,
      result: normalizeLspResult(scopedWorkspace, action, raw, parsed.source),
      status: session.status()
    };
  } catch (error) {
    return {
      available: false,
      provider: spec.id,
      reason: 'language-server-request-failed',
      error: error instanceof Error ? error.message : String(error),
      status: session.status()
    };
  }
}

async function diagnosticsWithLsp(workspace, args = {}, options = {}) {
  const requestedPath = String(args.path || '').trim().replaceAll('\\', '/');
  if (!requestedPath) return { available: false, reason: 'diagnostics-path-required' };
  const parsed = parseWorkspaceSourcePath(workspace, requestedPath);
  const relativePath = parsed.relativePath;
  const scopedWorkspace = sourceWorkspace(workspace, parsed.source);
  const spec = providerForPath(relativePath);
  if (!spec) return { available: false, reason: 'no-language-server-provider' };
  const session = getSession(scopedWorkspace, spec);
  if (!runtimeAvailable(spec)) return { available: false, provider: spec.id, reason: 'language-server-unavailable', status: session.status() };
  try {
    const published = await session.diagnostics(relativePath, options);
    return {
      available: true,
      provider: spec.id,
      authority: 'language-server',
      path: qualifyWorkspaceSourcePath(parsed.source, relativePath),
      result: normalizePublishedDiagnostics(scopedWorkspace, spec.id, published, parsed.source),
      status: session.status()
    };
  } catch (error) {
    return {
      available: false,
      provider: spec.id,
      reason: 'language-server-diagnostics-failed',
      error: error instanceof Error ? error.message : String(error),
      status: session.status()
    };
  }
}

async function planSemanticRename(workspace, semantic, options = {}) {
  const requestedPath = String(semantic?.path || '').trim().replaceAll('\\', '/');
  if (!requestedPath) throw new Error('Semantic rename requires semantic.path.');
  const parsed = parseWorkspaceSourcePath(workspace, requestedPath);
  if (!parsed.source.primary) throw new Error('Semantic rename is available only in the primary repository. Secondary source folders are read-only context.');
  const relativePath = parsed.relativePath;
  const newName = String(semantic?.newName || '').trim();
  if (!newName || newName.length > 256) throw new Error('Semantic rename requires semantic.newName between 1 and 256 characters.');
  const spec = providerForPath(relativePath);
  if (!spec) throw new Error(`No language-server provider supports semantic rename for ${relativePath}.`);
  const session = getSession(workspace, spec);
  if (!runtimeAvailable(spec)) throw unavailableError(spec);
  const position = await session.positionParams(relativePath, semantic.line, semantic.column, options);
  if (session.capabilities?.renameProvider && typeof session.capabilities.renameProvider === 'object' && session.capabilities.renameProvider.prepareProvider) {
    await session.request('textDocument/prepareRename', position, options);
  }
  const workspaceEdit = await session.request('textDocument/rename', { ...position, newName }, options);
  const edits = materializeWorkspaceEdit(workspace, workspaceEdit);
  if (!edits.length) throw new Error(`${spec.id} returned no edits for semantic rename.`);
  if (edits.length > MAX_SEMANTIC_EDIT_FILES) {
    throw new Error(`Semantic rename touches ${edits.length} files; Rel.AI accepts at most ${MAX_SEMANTIC_EDIT_FILES} files in one atomic semantic edit.`);
  }
  return {
    provider: spec.id,
    authority: 'language-server',
    operation: 'rename',
    path: relativePath,
    line: Number(semantic.line),
    column: Number(semantic.column),
    newName,
    edits
  };
}

function materializeWorkspaceEdit(workspace, workspaceEdit = {}) {
  const byUri = new Map();
  for (const [uri, textEdits] of Object.entries(workspaceEdit?.changes || {})) byUri.set(uri, [...(textEdits || [])]);
  for (const change of workspaceEdit?.documentChanges || []) {
    if (!change?.textDocument?.uri || !Array.isArray(change.edits)) {
      if (change?.kind) throw new Error(`Semantic rename refused unsupported LSP resource operation '${change.kind}'.`);
      continue;
    }
    const uri = change.textDocument.uri;
    byUri.set(uri, [...(byUri.get(uri) || []), ...change.edits]);
  }
  const edits = [];
  for (const [uri, textEdits] of byUri) {
    const relativePath = workspaceRelativeUri(workspace, uri);
    if (!relativePath) throw new Error(`Semantic rename refused language-server edit outside the active workspace: ${String(uri || 'unknown URI')}`);
    const safe = resolveSafePath(workspace.path, relativePath, { operation: 'write' });
    const original = fs.readFileSync(safe.absolutePath, 'utf8');
    const content = applyTextEdits(original, textEdits);
    if (content === original) continue;
    edits.push({ path: safe.relativePath, content, expectedSha256: sha256(original) });
  }
  return edits.sort((left, right) => left.path.localeCompare(right.path));
}

function applyTextEdits(text, edits) {
  const normalized = edits.map(edit => ({
    start: offsetAt(text, edit.range?.start),
    end: offsetAt(text, edit.range?.end),
    newText: String(edit.newText ?? '')
  })).sort((left, right) => right.start - left.start || right.end - left.end);
  let output = text;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of normalized) {
    if (edit.end > previousStart) throw new Error('Language server returned overlapping semantic rename edits.');
    output = output.slice(0, edit.start) + edit.newText + output.slice(edit.end);
    previousStart = edit.start;
  }
  return output;
}

function offsetAt(text, position = {}) {
  const targetLine = Math.max(0, Number(position.line || 0));
  const targetCharacter = Math.max(0, Number(position.character || 0));
  let offset = 0;
  let line = 0;
  while (line < targetLine && offset < text.length) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
    line += 1;
  }
  return Math.min(text.length, offset + targetCharacter);
}

function normalizePublishedDiagnostics(workspace, providerId, published = {}, source = null) {
  const relativePath = workspaceRelativeUri(workspace, published?.uri);
  if (!relativePath) return [];
  const qualifiedPath = source ? qualifyWorkspaceSourcePath(source, relativePath) : relativePath;
  return (Array.isArray(published?.diagnostics) ? published.diagnostics : []).slice(0, MAX_LSP_DIAGNOSTICS).map(item => ({
    path: qualifiedPath,
    ...normalizeRange(item?.range),
    severity: diagnosticSeverity(item?.severity),
    message: String(item?.message || '').slice(0, 2_000),
    ...(item?.code == null ? {} : { code: String(item.code).slice(0, 200) }),
    source: String(item?.source || providerId).slice(0, 120),
    provider: providerId
  }));
}

function diagnosticSeverity(value) {
  return ({ 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' })[Number(value)] || 'information';
}

function normalizeLspResult(workspace, action, raw, source = null) {
  if (action === 'hover' || action === 'symbol') return normalizeHover(raw);
  const locations = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return locations.map(item => normalizeLocation(workspace, item, source)).filter(Boolean);
}

function normalizeHover(raw) {
  if (!raw) return null;
  const contents = raw.contents;
  const values = Array.isArray(contents) ? contents : [contents];
  const text = values.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item.value === 'string') return item.value;
    return '';
  }).filter(Boolean).join('\n\n').slice(0, 12_000);
  return {
    text,
    ...(raw.range ? { range: normalizeRange(raw.range) } : {})
  };
}

function normalizeLocation(workspace, item, source = null) {
  const uri = item?.uri || item?.targetUri;
  const range = item?.range || item?.targetSelectionRange || item?.targetRange;
  const relativePath = workspaceRelativeUri(workspace, uri);
  if (!relativePath || !range) return null;
  return {
    path: source ? qualifyWorkspaceSourcePath(source, relativePath) : relativePath,
    line: Number(range.start?.line || 0) + 1,
    column: Number(range.start?.character || 0) + 1,
    endLine: Number(range.end?.line || 0) + 1,
    endColumn: Number(range.end?.character || 0) + 1,
    test: isTestPath(relativePath),
    provider: 'lsp',
    confidence: 1
  };
}

function normalizeRange(range = {}) {
  return {
    line: Number(range.start?.line || 0) + 1,
    column: Number(range.start?.character || 0) + 1,
    endLine: Number(range.end?.line || 0) + 1,
    endColumn: Number(range.end?.character || 0) + 1
  };
}

function diagnosticUriKey(uri) {
  if (!String(uri || '').startsWith('file:')) return String(uri || '');
  try {
    const absolute = path.resolve(fileURLToPath(uri));
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  } catch {
    return String(uri || '');
  }
}

function workspaceRelativeUri(workspace, uri) {
  if (!String(uri || '').startsWith('file:')) return '';
  let absolute;
  try { absolute = fileURLToPath(uri); } catch { return ''; }
  const relative = path.relative(workspace.path, absolute);
  if (!relative || relative === '.') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  return relative.replaceAll('\\', '/');
}

function providerStatuses(workspace) {
  const result = [];
  for (const source of workspaceSourceEntries(workspace)) {
    const scopedWorkspace = sourceWorkspace(workspace, source);
    for (const spec of PROVIDERS) {
      if (!sessions.has(sessionKey(scopedWorkspace, spec)) && !workspaceHintsProvider(scopedWorkspace, spec)) continue;
      const session = sessions.get(sessionKey(scopedWorkspace, spec));
      result.push({
        ...(session?.status() || {
          id: spec.id,
          available: runtimeAvailable(spec),
          active: false,
          state: 'idle',
          authority: 'language-server',
          capabilities: []
        }),
        ...(source.primary ? {} : { source: source.number })
      });
    }
  }
  return result;
}

function workspaceHintsProvider(workspace, spec) {
  if (spec.manifests.some(name => fs.existsSync(path.join(workspace.path, name)))) return true;
  return false;
}

function runtimeAvailable(spec) {
  if (path.isAbsolute(spec.executable)) {
    if (!fs.existsSync(spec.executable)) return false;
    return spec.argv.length === 0 || !path.isAbsolute(spec.argv[0]) || fs.existsSync(spec.argv[0]);
  }
  return Boolean(findExecutable(spec.executable));
}

function findExecutable(name) {
  const pathValue = String(process.env.PATH || '');
  const extensions = process.platform === 'win32'
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(directory, process.platform === 'win32' ? `${name}${ext}` : name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return '';
}

function advertisedCapabilities(capabilities = {}, publishedDiagnostics = false) {
  const mapping = [
    ['definition', 'definitionProvider'],
    ['references', 'referencesProvider'],
    ['hover', 'hoverProvider'],
    ['implementation', 'implementationProvider'],
    ['rename', 'renameProvider'],
    ['documentSymbols', 'documentSymbolProvider'],
    ['diagnostics', 'diagnosticProvider']
  ];
  const result = mapping.filter(([, key]) => Boolean(capabilities?.[key])).map(([name]) => name);
  if (publishedDiagnostics && !result.includes('diagnostics')) result.push('diagnostics');
  return result;
}

function combineAbortSignals(...signals) {
  const active = signals.filter(signal => signal && typeof signal.addEventListener === 'function');
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function disposedSessionError(spec) {
  const error = new Error(`Language server '${spec.id}' session is no longer owned by this workspace.`);
  error.code = 'LSP_SESSION_DISPOSED';
  return error;
}

function lifecycleAbortError(spec) {
  const error = new Error(`Language server '${spec.id}' startup was cancelled.`);
  error.name = 'AbortError';
  return error;
}

function unavailableError(spec) {
  const error = new Error(`Language server '${spec.id}' is unavailable.`);
  error.code = 'LSP_UNAVAILABLE';
  return error;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function noteLspMutation(workspace, paths = []) {
  const normalized = [...new Set((paths || [])
    .map(value => String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, ''))
    .filter(Boolean))];
  for (const spec of PROVIDERS) {
    const key = sessionKey(workspace, spec);
    const session = sessions.get(key);
    if (!session) continue;
    if (!normalized.length) {
      sessions.delete(key);
      void session.dispose();
      continue;
    }
    session.noteDiskChanges(normalized);
  }
}

async function disposeLspWorkspace(workspace) {
  const active = [];
  for (const source of workspaceSourceEntries(workspace)) {
    const scopedWorkspace = sourceWorkspace(workspace, source);
    for (const spec of PROVIDERS) {
      const key = sessionKey(scopedWorkspace, spec);
      const session = sessions.get(key);
      if (!session) continue;
      sessions.delete(key);
      active.push(session);
    }
  }
  await Promise.allSettled(active.map(session => session.dispose()));
}

async function shutdownLspSessions() {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map(session => session.dispose()));
}

export {
  diagnosticsWithLsp,
  disposeLspWorkspace,
  inspectWithLsp,
  noteLspMutation,
  planSemanticRename,
  providerStatuses,
  shutdownLspSessions
};
