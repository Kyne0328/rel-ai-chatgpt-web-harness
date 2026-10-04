import * as crypto from 'node:crypto';
import type { Principal, PrincipalIdentity } from '../contracts/authorization.ts';
import { canonicalJson, stableJson } from '../stableJson.js';
import { PRINCIPAL_KIND } from './contracts.ts';

type PrincipalKind = typeof PRINCIPAL_KIND[keyof typeof PRINCIPAL_KIND];
type PrincipalRecord = Readonly<Record<string, unknown>>;
type MutablePrincipalIdentity = { -readonly [K in keyof PrincipalIdentity]: PrincipalIdentity[K] };

type HttpAuthInfo = Readonly<{
  issuer?: string;
  clientId?: string;
  client_id?: string;
  subject?: string;
  sub?: string;
  tenant?: string;
  tenantId?: string;
  organization?: string;
  organizationId?: string;
  orgId?: string;
  authorizationPolicy?: unknown;
  policyContext?: unknown;
  authMode?: string;
  resource?: string;
  scopes?: readonly string[] | string;
  scope?: readonly string[] | string;
}>;

type PrincipalContext = Readonly<{ principal?: Principal }>;

const LOCAL_TRUSTED_PRINCIPAL = 'local:trusted' as const;
const CONNECTOR_ANONYMOUS_PRINCIPAL = 'connector:anonymous' as const;
const LOCAL_SESSION_AUTH_MODE = 'local_session' as const;
const STDIO_CLIENT_ID_PATTERN = /^stdio:[A-Za-z0-9_-]{16,160}$/;

const PRINCIPAL_FIELDS = Object.freeze([
  ['issuer', ['issuer']],
  ['clientId', ['clientId', 'client_id']],
  ['subject', ['subject', 'sub']],
  ['tenant', ['tenant', 'tenantId']],
  ['organization', ['organization', 'organizationId', 'orgId', 'org']],
  ['authorizationPolicy', ['authorizationPolicy', 'policyContext', 'policy']],
  ['authMode', ['authMode']],
  ['resource', ['resource']],
  ['scopes', ['scopes', 'scope']]
] as const);

function createHttpPrincipal(authInfo: HttpAuthInfo = {}, authMode = ''): Readonly<PrincipalIdentity> {
  const principal: MutablePrincipalIdentity = {};
  assignText(principal, 'issuer', authInfo.issuer);
  assignText(principal, 'clientId', authInfo.clientId ?? authInfo.client_id ?? 'unknown-client');
  assignText(principal, 'subject', authInfo.subject ?? authInfo.sub);
  assignText(principal, 'tenant', authInfo.tenant ?? authInfo.tenantId);
  assignText(principal, 'organization', authInfo.organization ?? authInfo.organizationId ?? authInfo.orgId);
  const authorizationPolicy = authInfo.authorizationPolicy ?? authInfo.policyContext;
  if (authorizationPolicy != null && authorizationPolicy !== '') principal.authorizationPolicy = authorizationPolicy;
  assignText(principal, 'authMode', authMode || authInfo.authMode || '');
  assignText(principal, 'resource', authInfo.resource);
  const scopes = normalizeScopes(authInfo.scopes ?? authInfo.scope);
  if (scopes.length > 0) principal.scopes = scopes;
  return Object.freeze(principal);
}

function createStdioPrincipal(): Readonly<PrincipalIdentity> {
  return Object.freeze({
    clientId: `stdio:${crypto.randomUUID()}`,
    authMode: LOCAL_SESSION_AUTH_MODE
  });
}

function principalIdentity(value: unknown): string {
  return normalizePrincipalKey(value);
}

function principalKind(value: unknown): PrincipalKind {
  if (!value) return PRINCIPAL_KIND.MISSING;
  if (value === LOCAL_TRUSTED_PRINCIPAL) return PRINCIPAL_KIND.LOCAL_TRUSTED;
  if (value === CONNECTOR_ANONYMOUS_PRINCIPAL) return PRINCIPAL_KIND.CONNECTOR_ANONYMOUS;
  if (isStdioSessionPrincipal(value)) return PRINCIPAL_KIND.STDIO_SESSION;
  return PRINCIPAL_KIND.AUTHENTICATED_CLIENT;
}

function principalForContext(context: PrincipalContext = {}, connector = false): Principal {
  return context.principal || (connector ? CONNECTOR_ANONYMOUS_PRINCIPAL : LOCAL_TRUSTED_PRINCIPAL);
}

function principalFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(normalizePrincipalKey(value)).digest('base64url');
}

function normalizePrincipalKey(principal: unknown): string {
  if (principal == null || principal === '') return 'anonymous';
  if (typeof principal === 'string' || typeof principal === 'number' || typeof principal === 'boolean') {
    return String(principal || 'anonymous');
  }
  if (!isRecord(principal)) {
    throw new TypeError('Authenticated principal must be a string or object.');
  }

  const normalized: Record<string, unknown> = {};
  for (const [target, candidates] of PRINCIPAL_FIELDS) {
    const value = candidates.map(key => principal[key]).find(item => item != null && item !== '');
    if (value == null || value === '') continue;
    if (target === 'scopes') {
      const scopes = Array.isArray(value) ? value : String(value).split(/\s+/);
      normalized.scopes = [...new Set(scopes.map(item => boundedText(item, 200)).filter(Boolean))].sort();
    } else if (typeof value === 'object') {
      normalized[target] = canonicalJson(value);
    } else {
      normalized[target] = boundedText(value, 1000);
    }
  }
  return stableJson(Object.keys(normalized).length ? normalized : { clientId: 'anonymous' });
}

function isStdioSessionPrincipal(value: unknown): value is PrincipalRecord {
  return isRecord(value)
    && value.authMode === LOCAL_SESSION_AUTH_MODE
    && STDIO_CLIENT_ID_PATTERN.test(String(value.clientId || ''));
}

function normalizeScopes(value: readonly string[] | string | undefined): readonly string[] {
  if (value == null || value === '') return [];
  const scopes = Array.isArray(value) ? value : String(value).split(/\s+/);
  return [...new Set(scopes.map(item => String(item).trim()).filter(Boolean))];
}

function assignText<K extends 'issuer' | 'clientId' | 'subject' | 'tenant' | 'organization' | 'authMode' | 'resource'>(
  principal: MutablePrincipalIdentity,
  key: K,
  value: string | undefined
): void {
  if (value == null || value === '') return;
  principal[key] = value;
}

function boundedText(value: unknown, maxChars: number): string {
  return String(value == null ? '' : value).trim().slice(0, maxChars);
}

function isRecord(value: unknown): value is PrincipalRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export {
  createHttpPrincipal,
  createStdioPrincipal,
  principalFingerprint,
  principalForContext,
  principalIdentity,
  principalKind
};
