import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { supportsFormElicitation } from './elicitation.ts';
import { BROWSER_HANDOFF_TTL_MS } from '../browser/browserHandoffPolicy.ts';
import { principalFingerprint } from './principal.ts';
import { toolResult } from './results.js';

const BROWSER_HANDOFF_STATE_KIND = 'browser_handoff_v1';

type BrowserHandoffResponse = Readonly<{ completed?: boolean }>;
type BrowserHandoffContext = Readonly<{
  principal?: unknown;
  clientCapabilities?: Readonly<Record<string, unknown>>;
}>;
type BrowserHandoffRawContext = Readonly<{
  mcpReq?: Readonly<{
    inputResponses?: unknown;
    requestState?: () => unknown;
  }>;
}>;
type BrowserHandoffCodec = Readonly<{
  mint: (claims: Record<string, unknown>, rawContext: BrowserHandoffRawContext) => Promise<string> | string;
}>;
type BrowserHandoffRequest = Readonly<{
  args: Record<string, unknown>;
  context: BrowserHandoffContext;
  rawContext: BrowserHandoffRawContext;
  codec: BrowserHandoffCodec;
  execute: (action: 'handoff' | 'resume') => Promise<Record<string, unknown>>;
}>;

function browserHandoffOperationArgs(args: Record<string, unknown>, action: 'handoff' | 'resume'): Record<string, unknown> {
  const next: Record<string, unknown> = { ...args, action };
  if (action === 'resume') {
    delete next.reason;
    delete next.tabId;
  }
  return next;
}

async function requestBrowserHandoff({
  args,
  context,
  rawContext,
  codec,
  execute
}: BrowserHandoffRequest): Promise<unknown> {
  const response = acceptedContent(rawContext.mcpReq?.inputResponses as never, 'browser_handoff') as BrowserHandoffResponse | undefined;
  const state = rawContext.mcpReq?.requestState?.();
  const inputResponses = rawContext.mcpReq?.inputResponses;
  const inputResponse = isRecord(inputResponses) ? inputResponses.browser_handoff : null;
  const cancelled = isRecord(inputResponse) && ['decline', 'cancel'].includes(String(inputResponse.action || ''));

  if (response || cancelled) {
    if (!isBrowserHandoffState(state)) {
      return toolResult({ ok: false, errorCode: 'BROWSER_HANDOFF_STATE_INVALID', error: 'This browser handoff is no longer valid. Request it again.' }, true);
    }
    const mismatch = browserHandoffStateMismatch(state, args, context);
    if (mismatch) return mismatch;
    const resumed = await execute('resume');
    if (response?.completed === true) {
      return toolResult({ ...resumed, handoffCompleted: true }, false);
    }
    return toolResult({
      ...resumed,
      ok: false,
      cancelled: true,
      errorCode: 'BROWSER_HANDOFF_CANCELLED',
      error: 'The user did not complete the requested browser step.'
    }, true);
  }

  const started = await execute('handoff');
  const expiresAt = Date.now() + BROWSER_HANDOFF_TTL_MS;
  const claims = {
    kind: BROWSER_HANDOFF_STATE_KIND,
    expiresAt,
    principal: principalFingerprint(context.principal),
    workspace: String(args.workspace || ''),
    sessionId: String(args.sessionId || ''),
    reason: String(args.reason || 'sign_in')
  };
  const requestState = await codec.mint(claims, rawContext);

  if (!supportsFormElicitation(context.clientCapabilities)) {
    return toolResult({
      ...started,
      userInputRequired: true,
      nextAction: 'Rel.AI gave you control of the local Browser. Finish the requested sign-in or verification there, then call relai_browser with action "resume" for this session.'
    }, false);
  }

  return inputRequired({
    inputRequests: {
      browser_handoff: inputRequired.elicit({
        message: handoffMessage(started, claims.reason),
        requestedSchema: {
          type: 'object',
          required: ['completed'],
          additionalProperties: false,
          properties: {
            completed: {
              type: 'boolean',
              title: 'I finished in the local browser'
            }
          }
        }
      })
    },
    requestState
  });
}

function handoffMessage(started: Record<string, unknown>, reason: string): string {
  const host = safeHost(started.url);
  const action = reason === 'mfa'
    ? 'complete multi-factor verification'
    : reason === 'captcha'
      ? 'complete the CAPTCHA'
      : reason === 'user_input'
        ? 'complete the required browser step'
        : 'sign in';
  return `Rel.AI needs you to ${action}${host ? ` for ${host}` : ''} in the local Browser. Enter passwords, MFA codes, and CAPTCHA responses only in the local browser, not in ChatGPT. When finished, confirm here so ChatGPT can resume browser control.`;
}

function browserHandoffStateMismatch(
  state: Record<string, unknown>,
  args: Record<string, unknown>,
  context: BrowserHandoffContext
): unknown {
  const expiresAt = Number(state.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return toolResult({ ok: false, errorCode: 'BROWSER_HANDOFF_EXPIRED', error: 'This browser handoff expired. Request it again.' }, true);
  }
  if (String(state.principal || '') !== principalFingerprint(context.principal)) {
    return toolResult({ ok: false, errorCode: 'BROWSER_HANDOFF_PRINCIPAL_MISMATCH', error: 'This browser handoff belongs to a different authenticated client.' }, true);
  }
  if (String(state.workspace || '') !== String(args.workspace || '') || String(state.sessionId || '') !== String(args.sessionId || '')) {
    return toolResult({ ok: false, errorCode: 'BROWSER_HANDOFF_TARGET_CHANGED', error: 'The browser handoff target changed. Request it again.' }, true);
  }
  return null;
}

function isBrowserHandoffState(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.kind === BROWSER_HANDOFF_STATE_KIND;
}

function safeHost(value: unknown): string {
  try {
    const url = new URL(String(value || ''));
    return url.host;
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export {
  browserHandoffOperationArgs, requestBrowserHandoff
};
