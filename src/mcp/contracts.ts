export const PRINCIPAL_KIND = Object.freeze({
  LOCAL_TRUSTED: 'local_trusted',
  CONNECTOR_ANONYMOUS: 'connector_anonymous',
  STDIO_SESSION: 'stdio_session',
  AUTHENTICATED_CLIENT: 'authenticated_client',
  MISSING: 'missing'
} as const);

export const AUTHORIZATION_POLICY_KIND = Object.freeze({
  LOCAL_ADMIN: 'local_admin',
  CLIENT_GRANT: 'client_grant'
} as const);

export const FALLBACK_EXECUTION_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted'
} as const);

export const TRANSPORT_OPERATION = Object.freeze({
  TOOL_CALL: 'tools/call'
} as const);
