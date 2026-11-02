import { spawn } from 'node:child_process';
import {
  CancellationTokenSource,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection
} from 'vscode-jsonrpc/node';

import { terminateProcessTree } from '../process.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 5_000;
const STOP_REQUEST_TIMEOUT_MS = 2_000;
const MAX_STDERR_BYTES = 32 * 1024;

class LspClient {
  constructor({ executable, argv = [], cwd, env = process.env, name = 'language-server', requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.executable = executable;
    this.argv = argv;
    this.cwd = cwd;
    this.env = env;
    this.name = name;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.connection = null;
    this.notifications = new Map();
    this.notificationDisposables = new Map();
    this.activeRequests = new Set();
    this.stderr = '';
    this.closed = true;
    this.state = 'idle';
    this.lastError = '';
    this.lifecycleId = 0;
    this.startPromise = null;
    this.stopPromise = null;
  }

  async start() {
    if (this.state === 'running' && this.child && this.connection) return this;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    this.startPromise = this.startOnce().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startOnce() {
    const lifecycleId = ++this.lifecycleId;
    this.closed = false;
    this.state = 'starting';
    this.lastError = '';
    this.stderr = '';
    const child = spawn(this.executable, this.argv, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      // Unix process-tree termination uses the child PID as the process-group ID.
      // Give each LSP server its own group so shutdown can actually stop it.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    child.once('error', error => {
      if (this.child !== child || this.lifecycleId !== lifecycleId) return;
      this.failConnection(error);
    });
    child.once('exit', (code, signal) => {
      if (this.child !== child || this.lifecycleId !== lifecycleId) return;
      if (this.state === 'stopping' || this.state === 'stopped') return;
      const suffix = signal ? ` signal ${signal}` : ` code ${code ?? 'unknown'}`;
      this.failConnection(new Error(`${this.name} exited with${suffix}.`));
    });

    try {
      await waitForSpawn(child, this.name);
      if (this.lifecycleId !== lifecycleId || this.state !== 'starting' || this.child !== child) {
        throw lifecycleAbortError(this.name);
      }

      const connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
      );
      this.connection = connection;
      connection.onRequest((method, params) => clientRequestResult(method, params));
      connection.onClose(() => {
        if (this.state === 'running' || this.state === 'starting') {
          this.failConnection(new Error(`${this.name} JSON-RPC connection closed.`));
        }
      });
      connection.onError(error => {
        if (process.env.REL_AI_MCP_DEBUG) console.error(`[rel-ai-mcp] ${this.name} JSON-RPC:`, error);
      });
      for (const method of this.notifications.keys()) this.registerNotificationMethod(method);
      connection.listen();
      this.state = 'running';
      return this;
    } catch (error) {
      if (this.state !== 'failed' && this.state !== 'stopping' && this.state !== 'stopped') {
        this.state = 'failed';
        this.closed = true;
        this.lastError = errorMessage(error);
      }
      if (this.child === child) this.child = null;
      await terminateProcessTree(child, { graceMs: 250, forceWaitMs: 750 }).catch(() => {});
      throw error;
    }
  }

  request(method, params, options = {}) {
    const connection = this.connection;
    if (!this.child || !connection || this.closed || this.state !== 'running') {
      return Promise.reject(new Error(`${this.name} is not running.`));
    }
    return this.requestOnConnection(connection, method, params, options);
  }

  requestOnConnection(connection, method, params, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(abortError(this.name, method));
    const timeoutMs = resolveTimeoutMs(options.timeoutMs, this.requestTimeoutMs);
    const cancellation = new CancellationTokenSource();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      let requestRecord;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        cancellation.dispose?.();
        if (requestRecord) this.activeRequests.delete(requestRecord);
        handler(value);
      };
      const cancel = error => {
        cancellation.cancel();
        finish(reject, error);
      };
      const onAbort = () => cancel(abortError(this.name, method));
      requestRecord = { fail: error => finish(reject, error) };
      this.activeRequests.add(requestRecord);
      timer = setTimeout(() => cancel(new Error(`${this.name} request timed out: ${method}`)), timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      try {
        connection.sendRequest(method, params, cancellation.token).then(
          value => finish(resolve, value),
          error => finish(reject, normalizeRpcError(error, this.name))
        );
      } catch (error) {
        finish(reject, normalizeRpcError(error, this.name));
      }
    });
  }

  notify(method, params) {
    if (!this.connection || this.closed || this.state !== 'running') return;
    this.connection.sendNotification(method, params);
  }

  onNotification(method, listener) {
    if (!this.notifications.has(method)) this.notifications.set(method, new Set());
    const listeners = this.notifications.get(method);
    listeners.add(listener);
    this.registerNotificationMethod(method);
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      this.notifications.delete(method);
      this.notificationDisposables.get(method)?.dispose?.();
      this.notificationDisposables.delete(method);
    };
  }

  registerNotificationMethod(method) {
    if (!this.connection || this.notificationDisposables.has(method)) return;
    const disposable = this.connection.onNotification(method, params => {
      for (const listener of this.notifications.get(method) || []) {
        try { listener(params); } catch {}
      }
    });
    this.notificationDisposables.set(method, disposable);
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async stopOnce() {
    const child = this.child;
    const connection = this.connection;
    ++this.lifecycleId;
    if (!child && !connection) {
      this.cancelActiveRequests(new Error(`${this.name} stopped.`));
      this.closed = true;
      this.state = 'stopped';
      return;
    }

    this.state = 'stopping';
    if (connection && !this.closed) {
      try {
        await this.requestOnConnection(connection, 'shutdown', null, { timeoutMs: STOP_REQUEST_TIMEOUT_MS });
      } catch {}
      try { connection.sendNotification('exit', null); } catch {}
    }

    this.closed = true;
    this.child = null;
    this.connection = null;
    this.cancelActiveRequests(new Error(`${this.name} stopped.`));
    this.disposeNotificationMethods();
    await terminateProcessTree(child, { graceMs: 1_000, forceWaitMs: 1_000 }).catch(() => {});
    connection?.dispose();
    this.state = 'stopped';
  }

  failConnection(error) {
    if (this.state === 'failed' || this.state === 'stopping' || this.state === 'stopped') return;
    const failure = error instanceof Error ? error : new Error(String(error || `${this.name} connection failed.`));
    const child = this.child;
    const connection = this.connection;
    ++this.lifecycleId;
    this.closed = true;
    this.state = 'failed';
    this.lastError = errorMessage(failure);
    this.child = null;
    this.connection = null;
    this.cancelActiveRequests(failure);
    this.disposeNotificationMethods();
    connection?.dispose();
    if (child) void terminateProcessTree(child, { graceMs: 250, forceWaitMs: 750 }).catch(() => {});
  }

  cancelActiveRequests(error) {
    for (const request of [...this.activeRequests]) request.fail(error);
    this.activeRequests.clear();
  }

  disposeNotificationMethods() {
    for (const disposable of this.notificationDisposables.values()) disposable.dispose?.();
    this.notificationDisposables.clear();
  }
}

function waitForSpawn(child, name) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => finish(resolve);
    const onError = error => finish(() => reject(error));
    const timer = setTimeout(() => finish(() => reject(new Error(`${name} did not start in time.`))), START_TIMEOUT_MS);
    timer.unref?.();
    const finish = action => {
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      action();
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

function resolveTimeoutMs(value, fallback) {
  const requested = Number(value);
  if (Number.isFinite(requested) && requested > 0) return requested;
  const defaultValue = Number(fallback);
  return Number.isFinite(defaultValue) && defaultValue > 0 ? defaultValue : DEFAULT_REQUEST_TIMEOUT_MS;
}

function abortError(name, method) {
  const error = new Error(`Cancelled ${name} request: ${method}`);
  error.name = 'AbortError';
  return error;
}

function lifecycleAbortError(name) {
  const error = new Error(`${name} start was cancelled.`);
  error.name = 'AbortError';
  return error;
}

function normalizeRpcError(value, name) {
  const error = value instanceof Error ? value : new Error(String(value?.message || `${name} request failed.`));
  if (value?.code != null) error.code = String(value.code);
  return error;
}

function errorMessage(value) {
  return value instanceof Error ? value.message : String(value || 'Language server failure.');
}

function clientRequestResult(method, params = {}) {
  if (method === 'workspace/configuration') {
    return Array.isArray(params?.items) ? params.items.map(() => null) : [];
  }
  if (method === 'workspace/applyEdit') {
    return { applied: false, failureReason: 'Rel.AI retains workspace mutation authority.' };
  }
  if (method === 'workspace/workspaceFolders') return null;
  return null;
}

export { LspClient };
