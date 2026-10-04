import assert from 'node:assert/strict';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { browserHandoffOperationArgs, requestBrowserHandoff } from '../src/mcp/browserHandoff.ts';
import { supportsFormElicitation } from '../src/mcp/elicitation.ts';
import { resolveToolOperation } from '../src/tools/actionCatalog.ts';
import { outputSchemaFor } from '../src/tools/outputSchemas.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

const principal = { clientId: 'browser-handoff-test', subject: 'user-a', authMode: 'test' };
const args = {
  workspace: 'repo',
  action: 'handoff',
  sessionId: 'browser_abcdefghijklmnopqrstuvwx',
  reason: 'sign_in'
};

assert.equal(supportsFormElicitation({ elicitation: {} }), true);
assert.equal(supportsFormElicitation({ elicitation: { form: {} } }), true);
assert.equal(supportsFormElicitation({}), false);

const resumeArgs = browserHandoffOperationArgs({
  ...args,
  tabId: 'tab_abcdefghijklmnopqrstuvwx',
  reason: 'mfa'
}, 'resume');
assert.equal(resumeArgs.action, 'resume');
assert.equal(Object.hasOwn(resumeArgs, 'reason'), false, 'resume must not inherit the handoff-only reason field');
assert.equal(Object.hasOwn(resumeArgs, 'tabId'), false, 'resume must not inherit the handoff-only tab target');
assert.equal(resolveToolOperation('relai_browser', resumeArgs)?.action, 'resume', 'normalized handoff resume arguments must pass the public browser action contract');

const browserOutputValidator = fromJsonSchema(outputSchemaFor(OP.BROWSER))['~standard'];
for (const output of [
  { ok: true, workspace: 'repo', action: 'start', sessionId: args.sessionId, profile: 'persistent', handoff: null, frames: [] },
  { ok: true, workspace: 'repo', action: 'handoff', sessionId: args.sessionId, profile: 'persistent', handoff: { active: true, reason: 'sign_in' }, userInputRequired: true },
  { ok: true, workspace: 'repo', action: 'resume', sessionId: args.sessionId, profile: 'persistent', handoff: null, handoffCompleted: true }
]) {
  const validated = await browserOutputValidator.validate(output);
  assert.equal(validated.issues, undefined, `browser output schema must accept authenticated-flow fields: ${JSON.stringify(validated.issues || [])}`);
}

const codec = fakeCodec();
const calls = [];
const first = await requestBrowserHandoff({
  args,
  context: { principal, clientCapabilities: { elicitation: {} } },
  rawContext: rawContext(),
  codec,
  execute: executeStub(calls)
});
assert.equal(first.resultType, 'input_required');
assert.ok(first.inputRequests?.browser_handoff);
assert.equal(codec.lastClaims.kind, 'browser_handoff_v1');
assert.equal(codec.lastClaims.workspace, 'repo');
assert.equal(codec.lastClaims.sessionId, args.sessionId);
assert.equal(calls[0], 'handoff');

const resumed = await requestBrowserHandoff({
  args,
  context: { principal, clientCapabilities: { elicitation: {} } },
  rawContext: rawContext({
    inputResponses: { browser_handoff: { action: 'accept', content: { completed: true } } },
    state: codec.lastClaims
  }),
  codec,
  execute: executeStub(calls)
});
assert.equal(resumed.structuredContent?.handoffCompleted, true);
assert.equal(resumed.structuredContent?.action, 'resume');
assert.equal(calls.at(-1), 'resume');

const declinedCodec = fakeCodec();
await requestBrowserHandoff({
  args,
  context: { principal, clientCapabilities: { elicitation: {} } },
  rawContext: rawContext(),
  codec: declinedCodec,
  execute: executeStub([])
});
const declined = await requestBrowserHandoff({
  args,
  context: { principal, clientCapabilities: { elicitation: {} } },
  rawContext: rawContext({
    inputResponses: { browser_handoff: { action: 'accept', content: { completed: false } } },
    state: declinedCodec.lastClaims
  }),
  codec: declinedCodec,
  execute: executeStub([])
});
assert.equal(declined.structuredContent?.errorCode, 'BROWSER_HANDOFF_CANCELLED');

const changedPrincipalCodec = fakeCodec();
await requestBrowserHandoff({
  args,
  context: { principal, clientCapabilities: { elicitation: {} } },
  rawContext: rawContext(),
  codec: changedPrincipalCodec,
  execute: executeStub([])
});
const changedPrincipal = await requestBrowserHandoff({
  args,
  context: { principal: { ...principal, subject: 'user-b' }, clientCapabilities: { elicitation: {} } },
  rawContext: rawContext({
    inputResponses: { browser_handoff: { action: 'accept', content: { completed: true } } },
    state: changedPrincipalCodec.lastClaims
  }),
  codec: changedPrincipalCodec,
  execute: executeStub([])
});
assert.equal(changedPrincipal.structuredContent?.errorCode, 'BROWSER_HANDOFF_PRINCIPAL_MISMATCH');

const fallbackCalls = [];
const fallback = await requestBrowserHandoff({
  args,
  context: { principal, clientCapabilities: {} },
  rawContext: rawContext(),
  codec: fakeCodec(),
  execute: executeStub(fallbackCalls)
});
assert.equal(fallback.structuredContent?.userInputRequired, true);
assert.match(fallback.structuredContent?.nextAction || '', /action "resume"/);
assert.equal(fallbackCalls[0], 'handoff');

for (const action of ['decline', 'cancel']) {
  const declinedCalls = [];
  const result = await requestBrowserHandoff({
    args,
    context: { principal, clientCapabilities: { elicitation: {} } },
    rawContext: rawContext({ inputResponses: { browser_handoff: { action } }, state: codec.lastClaims }),
    codec,
    execute: executeStub(declinedCalls)
  });
  assert.equal(result.structuredContent?.errorCode, 'BROWSER_HANDOFF_CANCELLED', `${action} must terminate the pending request instead of eliciting again`);
  assert.notEqual(result.resultType, 'input_required');
  assert.deepEqual(declinedCalls, ['resume'], `${action} must release exactly the validated pending handoff`);
}
for (const patch of [
  { kind: 'invalid' },
  { expiresAt: 'invalid' },
  { expiresAt: Date.now() - 1 },
  { principal: 'another-principal' },
  { workspace: 'another-workspace' },
  { sessionId: 'another-session' }
]) {
  const invalidCalls = [];
  const result = await requestBrowserHandoff({
    args,
    context: { principal, clientCapabilities: { elicitation: {} } },
    rawContext: rawContext({ inputResponses: { browser_handoff: { action: 'cancel' } }, state: { ...codec.lastClaims, ...patch } }),
    codec,
    execute: executeStub(invalidCalls)
  });
  assert.equal(result.isError, true, 'cancel must still validate expiry, principal, workspace, and session');
  assert.deepEqual(invalidCalls, [], 'invalid state must never resume a browser or create a replacement handoff');
}
console.log('Browser sign-in handoff elicitation, fallback, cancellation, and principal binding passed.');

function executeStub(calls) {
  return async action => {
    calls.push(action);
    return {
      ok: true,
      workspace: 'repo',
      action,
      sessionId: args.sessionId,
      profile: 'persistent',
      url: 'https://example.test/login'
    };
  };
}

function rawContext({ inputResponses, state } = {}) {
  return {
    mcpReq: {
      inputResponses,
      requestState: () => state
    }
  };
}

function fakeCodec() {
  return {
    lastClaims: null,
    async mint(claims) {
      this.lastClaims = structuredClone(claims);
      return 'browser-handoff-state';
    }
  };
}
