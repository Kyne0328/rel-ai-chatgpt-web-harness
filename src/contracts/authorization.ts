
export type AuthorizationPolicyKind = 'local_admin' | 'client_grant';

export interface AuthorizationPolicy {
  readonly version: number;
  readonly kind: AuthorizationPolicyKind;
  readonly capabilities: readonly string[];
  readonly workspaces: readonly string[];
}

export interface PrincipalIdentity {
  readonly issuer?: string;
  readonly clientId?: string;
  readonly subject?: string;
  readonly tenant?: string;
  readonly organization?: string;
  readonly authorizationPolicy?: unknown;
  readonly authMode?: string;
  readonly resource?: string;
  readonly scopes?: readonly string[];
}

export type Principal = string | Readonly<PrincipalIdentity>;

// Successful authorization returns the normalized policy. Denials are exceptions.
export type AuthorizationResult = Readonly<AuthorizationPolicy>;
