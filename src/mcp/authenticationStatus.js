import { MCP_AUTH_MODE, isMcpAuthMode } from '../contracts/mcp.ts';

function readMcpAuthenticationStatus(connection = {}, options = {}) {
  const authenticatedAt = timestamp(connection.lastAuthenticatedAt);
  const failedAt = timestamp(connection.lastAuthenticationFailureAt);
  const authMode = normalizeAuthMode(connection.lastAuthMode);
  let status = 'awaiting_authentication';
  if (authenticatedAt) status = statusForAuthMode(authMode);
  else if (failedAt) status = 'authentication_failed';
  return {
    status,
    authMode,
    lastAuthenticatedAt: authenticatedAt,
    lastAuthenticationFailureAt: failedAt,
    staticBearerConfigured: options.staticBearerConfigured === true
  };
}

function statusForAuthMode(authMode) {
  if (authMode === MCP_AUTH_MODE.STATIC_BEARER) return 'bearer_authorized';
  if (authMode === MCP_AUTH_MODE.LOCAL_NO_AUTH) return 'local_authorized';
  return 'authorized';
}

function normalizeAuthMode(value) {
  return isMcpAuthMode(value) ? String(value) : '';
}

function timestamp(value) {
  const milliseconds = typeof value === 'number' ? value : Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null;
}

export { readMcpAuthenticationStatus };
