import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from './io.ts';

function sendMcpProtocolError(
  res: ServerResponse<IncomingMessage>,
  status: number,
  code: number,
  message: string,
  id: unknown = null,
  data?: unknown
): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) }
  });
}

function sendMcpTransportError(
  res: ServerResponse<IncomingMessage>,
  { status = 500, id = null }: { status?: number; id?: unknown } = {}
): boolean {
  if (res.headersSent || res.writableEnded || res.destroyed) return false;
  const internal = Number(status) >= 500;
  sendMcpProtocolError(
    res,
    Number(status) || 500,
    internal ? -32603 : -32600,
    internal ? 'Internal error.' : 'Request could not be accepted.',
    id
  );
  return true;
}

export { sendMcpProtocolError, sendMcpTransportError };
