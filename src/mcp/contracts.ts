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

export const APPROVAL_STATE_KIND = 'relai_approval' as const;

export type ApprovalState = Readonly<{
  kind: typeof APPROVAL_STATE_KIND;
  tool: string;
  digest: string;
  nonce: string;
  expiresAt: number;
  principal: string;
  workId: string;
  workspace: string;
  operation: string;
}>;

export function isApprovalState(value: unknown): value is ApprovalState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<ApprovalState>;
  return state.kind === APPROVAL_STATE_KIND
    && typeof state.tool === 'string'
    && typeof state.digest === 'string'
    && typeof state.nonce === 'string'
    && Number.isFinite(state.expiresAt)
    && typeof state.principal === 'string'
    && typeof state.workId === 'string'
    && typeof state.workspace === 'string'
    && typeof state.operation === 'string';
}

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
