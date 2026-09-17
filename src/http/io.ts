import * as crypto from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';

import { ERROR_CODES } from '../contracts/errors.ts';
import type { HttpRequestError, HttpServerOptions, JsonRecord } from './types.ts';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_SSE_QUEUE_BYTES = 1024 * 1024;

function isAuthorized(
  req: IncomingMessage,
  options: Pick<HttpServerOptions, 'token' | 'allowNoAuth'>
): boolean {
  if (!options.token && options.allowNoAuth) return true;
  const header = String(req.headers.authorization || '').trim();
  const expected = `Bearer ${String(options.token || '').trim()}`;
  return timingSafeEqual(header, expected);
}

function timingSafeEqual(a: unknown, b: unknown): boolean {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requestError(message: string, status = 400): HttpRequestError {
  const error = new Error(message) as HttpRequestError;
  error.status = status;
  error.errorCode = ERROR_CODES.REQUEST_INVALID;
  return error;
}

function normalizeMaxBodyBytes(value: unknown, fallback: unknown = DEFAULT_MAX_BODY_BYTES): number {
  const number = Number(value);
  if (Number.isSafeInteger(number) && number > 0) return number;
  const fallbackNumber = Number(fallback);
  if (Number.isSafeInteger(fallbackNumber) && fallbackNumber > 0) return fallbackNumber;
  return DEFAULT_MAX_BODY_BYTES;
}

function readRawBody(req: IncomingMessage, maxBytes: unknown): Promise<string> {
  const limit = normalizeMaxBodyBytes(maxBytes);
  return new Promise((resolve, reject) => {
    const declaredBytes = Number(req.headers['content-length']);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes >= 0 && declaredBytes > limit) {
      req.resume();
      reject(requestError(`Request body exceeds ${limit} bytes.`, 413));
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const removeAllListeners = (): void => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const fail = (
      error: Error,
      { drain = false, waitForTerminal = false }: { drain?: boolean; waitForTerminal?: boolean } = {}
    ): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      req.off('data', onData);
      req.off('aborted', onAborted);
      if (!waitForTerminal) removeAllListeners();
      if (drain) req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string | Uint8Array): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) {
        fail(requestError(`Request body exceeds ${limit} bytes.`, 413), {
          drain: true,
          waitForTerminal: true
        });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (settled) {
        removeAllListeners();
        return;
      }
      settled = true;
      removeAllListeners();
      const body = Buffer.concat(chunks, bytes).toString('utf8');
      chunks.length = 0;
      resolve(body);
    };
    const onError = (error: Error): void => {
      if (settled) {
        removeAllListeners();
        return;
      }
      fail(error);
    };
    const onAborted = (): void => {
      fail(requestError('Request body was aborted before completion.'), { waitForTerminal: true });
    };
    const onClose = (): void => {
      if (settled) {
        removeAllListeners();
        return;
      }
      if (req.complete === true) return;
      fail(requestError('Request body connection closed before completion.'));
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    req.once('close', onClose);
    if (req.aborted || (req.destroyed && req.complete !== true)) onAborted();
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes: unknown): Promise<JsonRecord> {
  const body = await readRawBody(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch (error) {
    throw requestError(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainJsonObject(parsed)) throw requestError('JSON request body must be an object.');
  return parsed;
}

function isPlainJsonObject(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fixedCorsOrigins(options: Pick<HttpServerOptions, 'port'> = {}) {
  const port = Number(options.port || 3333);
  return Object.freeze({
    loopback: `http://127.0.0.1:${port}`,
    localhost: `http://localhost:${port}`,
    ipv6Loopback: `http://[::1]:${port}`
  });
}

function allowedCorsOrigin(origin: unknown, options: Pick<HttpServerOptions, 'port'> = {}): string {
  const origins = fixedCorsOrigins(options);
  const value = String(origin || '');
  if (value === origins.loopback) return origins.loopback;
  if (value === origins.localhost) return origins.localhost;
  if (value === origins.ipv6Loopback) return origins.ipv6Loopback;
  return '';
}

function setBaseHeaders(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  options: Pick<HttpServerOptions, 'port'> = {}
): void {
  const corsOrigin = allowedCorsOrigin(req.headers.origin ?? '', options);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type, authorization, mcp-protocol-version, mcp-method, mcp-name, traceparent, tracestate, baggage'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res: ServerResponse<IncomingMessage>, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8')
  });
  res.end(body);
}

function sendSse(
  res: ServerResponse<IncomingMessage>,
  event: string,
  data: unknown,
  options: { id?: string | number } = {}
): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(frameSse(event, data, options));
}

interface SseWriterOptions {
  readonly maxQueuedBytes?: unknown;
  readonly onOverflow?: () => void;
}

interface SseWriter {
  send(event: string, data: unknown, options?: { id?: string | number }): boolean;
  comment(value: string): boolean;
  close(options?: { destroy?: boolean }): void;
  readonly queuedBytes: number;
}

/**
 * Queue dashboard events per connection and stop producing when a slow reader
 * exceeds the bounded queue. `drain` resumes FIFO delivery, preserving event
 * order and letting the dashboard reconnect and fetch a fresh snapshot.
 */
function createSseWriter(
  res: ServerResponse<IncomingMessage>,
  options: SseWriterOptions = {}
): SseWriter {
  const configuredLimit = Number(options.maxQueuedBytes);
  const maxQueuedBytes = Number.isSafeInteger(configuredLimit) && configuredLimit > 0
    ? configuredLimit
    : DEFAULT_MAX_SSE_QUEUE_BYTES;
  const queue: string[] = [];
  let queuedBytes = 0;
  let draining = false;
  let closed = false;

  const fail = (): void => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    options.onOverflow?.();
    if (!res.destroyed && !res.writableEnded) res.destroy();
  };

  const pump = (): void => {
    if (closed || draining || res.destroyed || res.writableEnded) return;
    while (queue.length) {
      const frame = queue.shift();
      if (frame == null) break;
      queuedBytes = Math.max(0, queuedBytes - Buffer.byteLength(frame, 'utf8'));
      let accepted = false;
      try {
        accepted = res.write(frame);
      } catch {
        close({ destroy: true });
        return;
      }
      if (!accepted) {
        draining = true;
        res.once('drain', () => {
          draining = false;
          pump();
        });
        return;
      }
    }
  };

  const enqueue = (frame: string): boolean => {
    if (closed || res.destroyed || res.writableEnded) return false;
    const frameBytes = Buffer.byteLength(frame, 'utf8');
    if (frameBytes > maxQueuedBytes || queuedBytes + frameBytes > maxQueuedBytes) {
      fail();
      return false;
    }
    queue.push(frame);
    queuedBytes += frameBytes;
    pump();
    return !closed;
  };

  const close = ({ destroy = false }: { destroy?: boolean } = {}): void => {
    if (closed) {
      if (destroy && !res.destroyed && !res.writableEnded) res.destroy();
      return;
    }
    closed = true;
    queue.length = 0;
    queuedBytes = 0;
    if (destroy && !res.destroyed && !res.writableEnded) res.destroy();
  };

  // A response can close independently of the request object. Release queued
  // frames in either case so a disconnected dashboard cannot retain its FIFO.
  res.once('close', () => close());
  res.once('error', () => close());

  return {
    send(event, data, sendOptions = {}) {
      return enqueue(frameSse(event, data, sendOptions));
    },
    comment(value) {
      return enqueue(`: ${String(value || '').replace(/[\r\n]/g, '')}\n\n`);
    },
    close,
    get queuedBytes() { return queuedBytes; }
  };
}

function frameSse(
  event: string,
  data: unknown,
  options: { id?: string | number } = {}
): string {
  const lines: string[] = [];
  if (options.id != null && options.id !== '') {
    lines.push(`id: ${String(options.id).replace(/[\r\n]/g, '')}`);
  }
  lines.push(`event: ${String(event || '').replace(/[\r\n]/g, '')}`);
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of String(serialized ?? '').split(/\r?\n/)) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

function sendHtml(
  res: ServerResponse<IncomingMessage>,
  status: number,
  html: string,
  headers: OutgoingHttpHeaders = {}
): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self' https://chatgpt.com; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...headers
  });
  res.end(html);
}

function contentTypeForStaticAsset(filePath: string): string {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.css')) return 'text/css';
  if (lower.endsWith('.js') || lower.endsWith('.ts')) return 'application/javascript';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

export {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_SSE_QUEUE_BYTES,
  contentTypeForStaticAsset,
  isAuthorized,
  normalizeMaxBodyBytes,
  readJsonBody,
  readRawBody,
  sendHtml,
  sendJson,
  sendSse,
  createSseWriter,
  setBaseHeaders
};
