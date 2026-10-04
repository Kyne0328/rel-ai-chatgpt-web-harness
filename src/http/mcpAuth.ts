import type { IncomingMessage, ServerResponse } from 'node:http';

import { createLocalMcpAuthorization, type McpAuthorization } from '../core/mcp-runtime.ts';
import { MCP_AUTH_MODE, type McpAuthMode } from '../contracts/mcp.ts';
import { isAuthorized, sendJson } from './io.ts';
import type { ResolvedHttpServerOptions } from './types.ts';

function mcpAuthorization(
  req: IncomingMessage,
  options: Pick<ResolvedHttpServerOptions, 'token' | 'allowNoAuth'>
): McpAuthorization | null {
  if (isAuthorized(req, { ...options, allowNoAuth: false })) {
    return localAuthorization(MCP_AUTH_MODE.STATIC_BEARER, 'secure-tunnel');
  }
  if (!options.token && options.allowNoAuth === true) {
    return localAuthorization(MCP_AUTH_MODE.LOCAL_NO_AUTH, 'local-no-auth');
  }
  return null;
}

function localAuthorization(authMode: McpAuthMode, clientId: string): McpAuthorization {
  return createLocalMcpAuthorization(authMode, clientId);
}

function unauthorizedMcp(res: ServerResponse<IncomingMessage>): void {
  if (res.headersSent) return;
  res.setHeader('WWW-Authenticate', 'Bearer realm="rel-ai-local"');
  sendJson(res, 401, {
    ok: false,
    error: 'Authorization required. The local MCP endpoint accepts only the private Rel.AI bearer token supplied by OpenAI tunnel-client.'
  });
}

export { mcpAuthorization, unauthorizedMcp };
