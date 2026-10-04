import * as crypto from 'node:crypto';
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import type { ApprovalRequirement, ApprovalResult } from '../contracts/authorization.ts';
import { stableJson } from '../stableJson.js';
import { APPROVAL_STATE_KIND, isApprovalState, type ApprovalState } from './contracts.ts';
import { supportsFormElicitation } from './elicitation.ts';
import { principalFingerprint } from './principal.ts';
import { toolResult } from './results.js';

const APPROVAL_TTL_MS = 5 * 60 * 1000;
const USED_NONCES = new Map<string, number>();

type ApprovalArguments = Record<string, unknown>;
type ApprovalClientCapabilities = Readonly<{
  elicitation?: Readonly<Record<string, unknown>>;
}>;
type ApprovalContext = Readonly<{
  principal?: unknown;
  clientCapabilities?: ApprovalClientCapabilities;
}>;
type ApprovalRawContext = Readonly<{
  mcpReq?: Readonly<{
    inputResponses?: unknown;
    requestState?: () => unknown;
  }>;
}>;
type ApprovalStateCodec = Readonly<{
  mint: (claims: ApprovalState, rawContext: ApprovalRawContext) => Promise<string> | string;
}>;
type ApprovalRequest = Readonly<{
  name: string;
  args: ApprovalArguments;
  requirement: ApprovalRequirement;
  context: ApprovalContext;
  rawContext: ApprovalRawContext;
  codec: ApprovalStateCodec;
}>;

type ApprovalResponse = Readonly<{ approved?: boolean }>;

async function requestApproval({
  name,
  args,
  requirement,
  context,
  rawContext,
  codec
}: ApprovalRequest): Promise<ApprovalResult> {
  const response = acceptedContent(rawContext.mcpReq?.inputResponses as never, 'approval') as ApprovalResponse | undefined;
  const state = rawContext.mcpReq?.requestState?.();
  const digest = approvalDigest(name, args);
  if (response && isApprovalState(state)) {
    if (state.tool !== name || state.digest !== digest) return staleApprovalResult();
    if (isNonceUsed(state.nonce)) return approvalReplayResult();
    const stale = approvalStateMismatch(state, context);
    if (stale) return stale;
    consumeNonce(state.nonce, state.expiresAt);
    if (response.approved === true) return null;
    return toolResult({
      ok: false,
      cancelled: true,
      errorCode: 'APPROVAL_DECLINED',
      error: 'The user declined this operation.'
    }, true) as ApprovalResult;
  }

  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  const claims: ApprovalState = {
    kind: APPROVAL_STATE_KIND,
    tool: name,
    digest,
    nonce: crypto.randomUUID(),
    expiresAt,
    principal: principalFingerprint(context.principal),
    workId: String(args.work_id || ''),
    workspace: String(args.workspace || ''),
    operation: String(args.action || '')
  };
  const grant = await codec.mint(claims, rawContext);

  if (supportsFormElicitation(context.clientCapabilities)) {
    return inputRequired({
      inputRequests: {
        approval: inputRequired.elicit({
          message: requirement.message,
          requestedSchema: {
            type: 'object',
            required: ['approved'],
            additionalProperties: false,
            properties: { approved: { type: 'boolean', title: 'Approve operation' } }
          }
        })
      },
      requestState: grant
    }) as ApprovalResult;
  }

  return toolResult({
    ok: false,
    errorCode: 'APPROVAL_INTERACTION_UNAVAILABLE',
    approvalRequired: true,
    operation: claims.operation || name,
    workspace: claims.workspace,
    work_id: claims.workId,
    nextAction: 'This client cannot show the approval required for this operation. Use a client that supports MCP approval elicitation, then request the operation again.'
  }, true) as ApprovalResult;
}

function approvalStateMismatch(state: ApprovalState, context: ApprovalContext): ApprovalResult {
  if (Date.now() > state.expiresAt) return expiredApprovalResult();
  if (state.principal !== principalFingerprint(context.principal)) return principalMismatchResult();
  return null;
}

function consumeNonce(nonce: string, expiresAt: number): void {
  USED_NONCES.set(nonce, expiresAt || Date.now() + APPROVAL_TTL_MS);
}

function isNonceUsed(nonce: string): boolean {
  pruneNonces();
  return USED_NONCES.has(nonce);
}

function pruneNonces(): void {
  const now = Date.now();
  for (const [nonce, expiresAt] of USED_NONCES) {
    if (expiresAt <= now) USED_NONCES.delete(nonce);
  }
}

function approvalReplayResult(): ApprovalResult {
  return toolResult({ ok: false, errorCode: 'APPROVAL_GRANT_CONSUMED', error: 'This approval was already used.' }, true) as ApprovalResult;
}

function expiredApprovalResult(): ApprovalResult {
  return toolResult({ ok: false, errorCode: 'APPROVAL_GRANT_EXPIRED', error: 'This approval expired. Request the operation again.' }, true) as ApprovalResult;
}

function staleApprovalResult(): ApprovalResult {
  return toolResult({ ok: false, errorCode: 'APPROVAL_TARGET_CHANGED', error: 'The approved repository state changed. Request approval again.' }, true) as ApprovalResult;
}

function principalMismatchResult(): ApprovalResult {
  return toolResult({ ok: false, errorCode: 'APPROVAL_PRINCIPAL_MISMATCH', error: 'This approval belongs to a different client session.' }, true) as ApprovalResult;
}

function approvalDigest(name: string, args: ApprovalArguments = {}): string {
  const safe: ApprovalArguments = { ...args };
  delete safe._deferredExecution;

  if (isRecord(safe.sensitiveAuthorization)) {
    safe.sensitiveAuthorization = { ...safe.sensitiveAuthorization, reason: '[provided]' };
  }
  return crypto.createHash('sha256').update(name).update('\0').update(stableJson(safe)).digest('base64url');
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export {
  APPROVAL_TTL_MS,
  approvalDigest,
  requestApproval,
};
export type {
  ApprovalArguments,
  ApprovalContext,
  ApprovalRawContext,
  ApprovalStateCodec
};
