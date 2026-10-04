import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { localHttpFetch } from './http-test-server.mjs';

export const MCP_VERSION = '2026-07-28';

export function mcpHeaders(method, {
  token = '',
  name = '',
  sessionId = '',
  protocolVersion = MCP_VERSION,
  extra = {}
} = {}) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
    ...(method ? { 'mcp-method': method } : {}),
    ...(name ? { 'mcp-name': name } : {}),
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra
  };
}

export function mcpBody(id, method, params = {}, options = {}) {
  const clientInfo = options.clientInfo || { name: 'relai-http-test', version: '1.0.0' };
  const capabilities = options.capabilities || {};
  const protocolVersion = options.protocolVersion === undefined ? MCP_VERSION : options.protocolVersion;
  return JSON.stringify({
    jsonrpc: '2.0',
    ...(id == null ? {} : { id }),
    method,
    params: {
      ...params,
      _meta: {
        ...(params?._meta || {}),
        [PROTOCOL_VERSION_META_KEY]: protocolVersion,
        [CLIENT_INFO_META_KEY]: clientInfo,
        [CLIENT_CAPABILITIES_META_KEY]: capabilities
      }
    }
  });
}

export async function readMcpResponse(response) {
  const text = await response.text();
  if (!text.trim()) return null;
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
    const frames = text.split(/\n\n+/).map(frame => frame.trim()).filter(Boolean);
    const data = frames.flatMap(frame => frame.split(/\r?\n/))
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);
    if (!data.length) throw new Error(`MCP SSE response contained no data: ${text}`);
    return JSON.parse(data.at(-1));
  }
  return JSON.parse(text);
}

export async function postMcp(base, {
  id,
  method,
  params = {},
  token = '',
  name = '',
  sessionId = '',
  protocolVersion = MCP_VERSION,
  clientInfo,
  capabilities = {},
  extraHeaders = {}
}) {
  const response = await localHttpFetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(method, { token, name, sessionId, protocolVersion, extra: extraHeaders }),
    body: mcpBody(id, method, params, { protocolVersion, clientInfo, capabilities })
  });
  return { response, body: await readMcpResponse(response) };
}

export async function createHttpMcpSession(base, options = {}) {
  const token = String(options.token || '');
  const clientInfo = options.clientInfo || { name: options.clientName || 'relai-http-test', version: '1.0.0' };
  const capabilities = options.capabilities || {};
  let nextId = Number(options.initialRequestId || 1);
  const discovery = await postMcp(base, {
    id: nextId++,
    method: 'server/discover',
    token,
    clientInfo,
    capabilities
  });
  if (discovery.response.status !== 200 || discovery.body?.error) {
    throw new Error(`MCP server/discover failed with HTTP ${discovery.response.status}: ${JSON.stringify(discovery.body)}`);
  }

  async function request(method, params = {}, requestOptions = {}) {
    const requestCapabilities = requestOptions.capabilities === undefined
      ? capabilities
      : requestOptions.capabilities;
    const requestClientInfo = requestOptions.clientInfo || clientInfo;
    const name = requestOptions.name === undefined
      ? expectedName(method, params)
      : requestOptions.name;
    return postMcp(base, {
      id: requestOptions.id ?? nextId++,
      method,
      params,
      token,
      name,
      sessionId: requestOptions.sessionId || '',
      protocolVersion: requestOptions.protocolVersion === undefined ? MCP_VERSION : requestOptions.protocolVersion,
      clientInfo: requestClientInfo,
      capabilities: requestCapabilities,
      extraHeaders: requestOptions.extraHeaders || {}
    });
  }

  async function notify(method, params = {}, requestOptions = {}) {
    return request(method, params, { ...requestOptions, id: null });
  }

  async function close() {
    return { ok: true, stateless: true };
  }

  return {
    base,
    token,
    sessionId: '',
    initialize: discovery,
    discovery,
    clientInfo,
    capabilities,
    request,
    notify,
    close
  };
}

function expectedName(method, params) {
  if (method === 'tools/call' || method === 'prompts/get') return String(params?.name || '');
  if (['events/subscribe', 'events/unsubscribe'].includes(method)) return String(params?.name || '');
  if (['resources/read', 'resources/subscribe', 'resources/unsubscribe'].includes(method)) {
    return String(params?.uri || '');
  }
  return '';
}
