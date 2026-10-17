import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { buildGoalEvaluatorPacket, buildGoalEvaluatorPrompt, validateGoalEvaluatorDecision, evaluateGoalDecision } from '../src/chatgptGoalEvaluator.js';
import { configureGoalBrowserTransport } from '../src/chatgptGoalProtocol.js';
import { goalHelperExpression, runGoalHelperBrowser } from '../electron/chatgpt-goal-helper.js';
import { createBrowserSurfaceHost } from '../electron/browser-surface-host.js';

const goal = { revision: 7, objective: 'Repair the export and verify its tests.', mode: 'goal' };
const evidence = {
  stateRevision: 7, workId: 'fixture-work', fingerprint: 'a'.repeat(64), objective: goal.objective,
  items: [
    { id: 'operation:export', kind: 'operation_receipt', verified: true, successful: true, settled: true },
    { id: 'validation:current', kind: 'validation', verified: true, current: true, status: 'passed' },
    { id: 'operation:failed', kind: 'operation_receipt', verified: true, successful: false },
    { id: 'claim:done', kind: 'claim', verified: false, text: 'Everything is done.' }
  ], completion: { eligible: true, gaps: [] }, successCriteria: []
};
const packet = buildGoalEvaluatorPacket(goal, evidence);
function decision(overrides = {}) {
  return { action: 'continue', reason: 'Export exists; verify the new edge case.', nextPrompt: 'Run the focused export regression and inspect its result.',
    expectedRevision: goal.revision, evidenceFingerprint: evidence.fingerprint,
    evidenceRefs: ['operation:export'], ...overrides };
}
const transport = value => async () => ({ ok: true, text: JSON.stringify(value) });

test('bounded evidence projection includes the original loop brief and redacts secrets', () => {
  const input = { ...evidence, raw: 'private raw conversation',
    items: [...evidence.items, { id: 'claim:secret', kind: 'claim', verified: false,
      text: 'authorization: Bearer fixture_secret_value password=secret-value' }] };
  const value = buildGoalEvaluatorPacket({ ...goal, mode: 'loop', brief: 'Review only the export behavior.' }, input);
  assert.equal(value.brief, 'Review only the export behavior.');
  assert.equal(value.mode, 'loop');
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /secret-value|fixture_secret_value|private raw conversation/);
  assert.ok(Buffer.byteLength(serialized) <= 32 * 1024);
  assert.doesNotThrow(() => buildGoalEvaluatorPrompt(value));
  assert.equal(input.items.at(-1).text.includes('secret-value'), true, 'projection must not mutate source evidence');
});

test('all four semantic actions are accepted only with their required fields', async () => {
  for (const action of ['continue', 'achieved', 'blocked', 'wait']) {
    const input = decision({ action, nextPrompt: action === 'continue' ? 'Verify the edge case.' : '' });
    const result = await evaluateGoalDecision({ goal, evidence, transport: transport(input) });
    assert.equal(result.action, action);
    assert.equal(result.expectedRevision, goal.revision);
    assert.equal(result.evidenceFingerprint, evidence.fingerprint);
  }
});

test('malformed, stale, invented, failed, and authority-expanding decisions are rejected', () => {
  for (const input of [
    '{not JSON}', decision({ expectedRevision: 6 }), decision({ evidenceFingerprint: 'b'.repeat(64) }),
    decision({ evidenceRefs: ['invented'] }), decision({ evidenceRefs: ['operation:export', 'operation:export'] }),
    decision({ nextPrompt: '' }), decision({ action: 'wait' }), decision({ tools: ['execute'] }),
    decision({ continuationBudget: 1000 }), decision({ action: 'achieved', nextPrompt: '', evidenceRefs: ['claim:done'] }),
    decision({ action: 'achieved', nextPrompt: '', evidenceRefs: ['operation:failed'] }),
    decision({ reason: 'x'.repeat(1201) }), 'x'.repeat(8193)
  ]) {
    assert.throws(() => validateGoalEvaluatorDecision(input, packet), /Evaluator/);
  }
  const achieved = decision({ action: 'achieved', nextPrompt: '' });
  assert.throws(() => validateGoalEvaluatorDecision(achieved, { ...packet, mode: 'loop' }), /completion/);
  assert.throws(() => validateGoalEvaluatorDecision(achieved, {
    ...packet, evidence: { ...packet.evidence, completion: { eligible: false } }
  }), /completion/);
});

test('every success criterion requires specific successful current references', () => {
  const criteria = [
    { id: 'criterion:export', text: 'Export is repaired.', status: 'requires_semantic_review' },
    { id: 'criterion:tests', text: 'Tests pass for the repair.', status: 'requires_semantic_review', requiresValidation: true }
  ];
  const value = buildGoalEvaluatorPacket(goal, { ...evidence, successCriteria: criteria });
  const achieved = decision({ action: 'achieved', nextPrompt: '', criterionResults: [
    { criterionId: criteria[0].id, status: 'supported', evidenceRefs: ['operation:export'] },
    { criterionId: criteria[1].id, status: 'supported', evidenceRefs: ['validation:current'] }
  ] });
  assert.equal(validateGoalEvaluatorDecision(achieved, value).action, 'achieved');
  for (const results of [
    achieved.criterionResults.slice(0, 1),
    [achieved.criterionResults[0], { ...achieved.criterionResults[1], status: 'unverified', evidenceRefs: [] }],
    [achieved.criterionResults[0], { ...achieved.criterionResults[1], evidenceRefs: ['operation:export'] }],
    [achieved.criterionResults[0], { ...achieved.criterionResults[1], evidenceRefs: ['operation:failed'] }]
  ]) assert.throws(() => validateGoalEvaluatorDecision({ ...achieved, criterionResults: results }, value), /completion/);
  assert.throws(() => validateGoalEvaluatorDecision(achieved, { ...value, evidence: { ...value.evidence,
    items: value.evidence.items.map(item => item.kind === 'validation' ? { ...item, current: false } : item)
  } }), /completion/);
});

test('unavailable, quota and busy states stay explicit instead of fabricating a semantic result', async () => {
  configureGoalBrowserTransport(null);
  assert.equal((await evaluateGoalDecision({ goal, evidence })).code, 'GOAL_EVALUATOR_UNAVAILABLE');
  for (const [result, code] of [
    [{ ok: false, status: 429, retryAfterMs: 300000 }, 'GOAL_EVALUATOR_QUOTA'],
    [{ ok: false, busy: true }, 'GOAL_EVALUATOR_BUSY'],
    [{ ok: false, status: 401 }, 'GOAL_EVALUATOR_NEEDS_USER'],
    [{ ok: false, reason: 'verification' }, 'GOAL_EVALUATOR_NEEDS_USER'],
    [{ ok: true, text: 'I think it is done.' }, 'GOAL_EVALUATOR_INVALID'],
    [{ ok: true, text: JSON.stringify(decision({ expectedRevision: 1 })) }, 'GOAL_EVALUATOR_STALE']
  ]) {
    const value = await evaluateGoalDecision({ goal, evidence, transport: async () => result });
    assert.equal(value.action, 'unavailable');
    assert.equal(value.code, code);
    assert.equal(value.expectedRevision, goal.revision);
  }
});

test('timeout aborts the one attempt and cancellation never becomes a fallback decision', async () => {
  let calls = 0;
  let capturedSignal;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pendingTransport = (_packet, options) => {
    calls++;
    capturedSignal = options.signal;
    entered();
    return new Promise(() => {});
  };
  const timedOut = await evaluateGoalDecision({ goal, evidence, timeoutMs: 5, transport: pendingTransport });
  assert.equal(timedOut.code, 'GOAL_EVALUATOR_TIMEOUT');
  assert.equal(capturedSignal.aborted, true);
  assert.equal(calls, 1);
  const controller = new AbortController();
  const cancelled = evaluateGoalDecision({ goal, evidence, signal: controller.signal, transport: pendingTransport });
  await started;
  await Promise.resolve();
  controller.abort(new DOMException('Stopped by user.', 'AbortError'));
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(capturedSignal.aborted, true);
});

test('invalid or oversized evidence never invokes the helper and retains its revision fence', async () => {
  let calls = 0;
  const huge = { ...evidence, items: Array.from({ length: 80 }, (_, index) => ({ id: String(index), text: 'x'.repeat(4000) })) };
  const result = await evaluateGoalDecision({ goal, evidence: huge, transport: async () => { calls++; } });
  assert.equal(result.action, 'unavailable');
  assert.equal(result.expectedRevision, goal.revision);
  assert.equal(result.evidenceFingerprint, evidence.fingerprint);
  assert.equal(calls, 0);
});

function element(text = '', attributes = {}) {
  return {
    isConnected: true, innerText: text, textContent: text, disabled: false,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    getAttribute: name => attributes[name] ?? null,
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    focus() {}
  };
}

// Minimal rendered-DOM fixture: probes execute their real expression in a VM.
// Browser input and account requests are fake; no network or live account is used.
function helperWindow(options = {}) {
  const page = { temporary: options.temporary !== false, submitted: false, input: '', closed: false,
    sendCount: 0, toggleCount: 0, focused: '', stage: '', ...options };
  const win = new EventEmitter();
  const wc = new EventEmitter();
  const button = element('Temporary', { 'data-testid': 'temporary-chat-button' });
  button.getAttribute = name => name === 'aria-pressed' ? String(page.temporary) : name === 'data-testid' ? 'temporary-chat-button' : null;
  button.focus = () => { document.activeElement = button; page.focused = 'temporary'; };
  const user = () => element(page.receiptMismatch ? 'Another message' : page.input);
  const assistant = () => {
    const result = element(page.output || JSON.stringify(decision()));
    result.querySelector = () => result;
    result.closest = selector => selector.includes('article') ? { querySelectorAll: () => page.neverSettles ? [] : [element('Copy')] } : null;
    return result;
  };
  const document = {
    activeElement: null,
    querySelector: selector => {
      if (selector.includes('challenges.cloudflare.com')) return page.verification ? element() : null;
      if (selector.includes('data-tool-name')) return page.toolSelected ? element() : null;
      return null;
    },
    querySelectorAll: selector => {
      if (selector === '[data-message-author-role="user"]') return page.submitted ? [user()] : [];
      if (selector === '[data-message-author-role="assistant"]') return page.submitted && !page.pending ? [assistant()] : [];
      if (selector.includes('[role="alert"]')) return page.quota && page.submitted ? [element('You have reached your message limit.')] : [];
      if (selector.includes('stop-button')) return page.neverSettles ? [element('Stop')] : [];
      if (selector.includes('temporary-chat-button')) return page.noTemporaryControl ? [] : [button];
      return [];
    }
  };
  wc.isDestroyed = () => page.closed;
  wc.getURL = () => page.url;
  wc.setWindowOpenHandler = handler => { page.popupHandler = handler; };
  wc.executeJavaScript = async script => {
    if (script.includes('relai-goal-composer')) {
      if (script.includes('if ("probe"')) return { state: 'ready', occupied: Boolean(page.occupied) };
      if (script.includes('if ("focus"')) { page.focused = 'composer'; return { state: 'focused' }; }
      page.focused = 'send';
      return { state: page.textMismatch ? 'text_mismatch' : 'send_ready' };
    }
    return vm.runInNewContext(script, { document, location: { origin: page.origin || 'https://chatgpt.com', pathname: '/' },
      getComputedStyle: () => ({ visibility: 'visible' }) });
  };
  const debuggerApi = { sendCommand: async (method, params) => {
    if (method === 'Input.insertText') { page.input = params.text; page.afterDraft?.(); }
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'Enter') {
      if (page.focused === 'temporary') { page.temporary = true; page.toggleCount++; }
      else if (page.focused === 'send') {
        page.submitted = true; page.sendCount++;
        if (page.failOnSubmit) throw new Error('Fixture transport interrupted after submit.');
      }
    }
  } };
  wc.debugger = { isAttached: () => true, ...debuggerApi };
  win.webContents = wc;
  win.loadURL = async url => { page.url = url; if (page.hangNavigation) return new Promise(() => {}); };
  win.isDestroyed = () => page.closed;
  win.close = () => { if (!page.closed) { page.closed = true; win.emit('closed'); } };
  return { win, page, debuggerApi, document };
}
const runFixture = fixture => runGoalHelperBrowser(fixture.win, 'A bounded fixture review prompt.', {
  attachedDebugger: async () => fixture.debuggerApi, pollMs: 1, timeoutMs: 1000
});

test('helper uses one fresh verified Temporary Chat and submits once through the normal composer', async () => {
  const fixture = helperWindow({ temporary: false });
  const result = await runFixture(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.helper, 'fresh_temporary_chat');
  assert.equal(fixture.page.toggleCount, 1);
  assert.equal(fixture.page.sendCount, 1);
  assert.equal(fixture.page.closed, true);
  assert.deepEqual(fixture.page.popupHandler(), { action: 'deny' });
});

test('helper does not send through a draft, verification, tool selection, or changed temporary mode', async () => {
  for (const options of [{ occupied: true }, { verification: true }, { toolSelected: true }, { textMismatch: true }]) {
    const fixture = helperWindow(options);
    const result = await runFixture(fixture);
    assert.equal(result.ok, false);
    assert.equal(result.notSent, true);
    assert.equal(fixture.page.sendCount, 0);
    assert.equal(fixture.page.closed, true);
  }
  const changed = helperWindow();
  changed.page.afterDraft = () => { changed.page.temporary = false; };
  assert.equal((await runFixture(changed)).notSent, true);
  assert.equal(changed.page.sendCount, 0);
});

test('missing Temporary Chat controls never fall back to sending an ordinary chat', async () => {
  const fixture = helperWindow({ temporary: false, noTemporaryControl: true });
  const result = await runGoalHelperBrowser(fixture.win, 'Fixture', {
    attachedDebugger: async () => fixture.debuggerApi, timeoutMs: 10, pollMs: 1
  });
  assert.equal(result.ok, false);
  assert.equal(fixture.page.input, '');
  assert.equal(fixture.page.sendCount, 0);
  assert.equal(fixture.page.closed, true);
});

test('helper verifies the exact user receipt, quota, and uncertain sends without retrying', async () => {
  for (const [options, reason] of [
    [{ receiptMismatch: true }, 'receipt_mismatch'], [{ quota: true }, 'quota'], [{ failOnSubmit: true }, 'helper_unavailable']
  ]) {
    const fixture = helperWindow(options);
    const result = await runFixture(fixture);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.uncertain, true);
    assert.equal(fixture.page.sendCount, 1);
    assert.equal(fixture.page.closed, true);
    if (reason === 'quota') assert.equal(result.status, 429);
  }
});

test('helper cancellation and deadline close its window even while navigation never settles', async () => {
  const fixture = helperWindow({ hangNavigation: true });
  const controller = new AbortController();
  const running = runGoalHelperBrowser(fixture.win, 'Fixture', { signal: controller.signal,
    attachedDebugger: async () => fixture.debuggerApi, timeoutMs: 1000 });
  controller.abort(new DOMException('Stop.', 'AbortError'));
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(fixture.page.closed, true);
  assert.equal(fixture.page.sendCount, 0);
  const timed = helperWindow({ hangNavigation: true });
  const result = await runGoalHelperBrowser(timed.win, 'Fixture', {
    attachedDebugger: async () => timed.debuggerApi, timeoutMs: 5 });
  assert.equal(result.timeout, true);
  assert.equal(timed.page.closed, true);
});

test('temporary label alone cannot prove active mode and response text cannot spoof a fresh chat', () => {
  const fixture = helperWindow({ temporary: false });
  const evaluate = script => vm.runInNewContext(script, { document: fixture.document,
    location: { origin: 'https://chatgpt.com', pathname: '/' }, getComputedStyle: () => ({ visibility: 'visible' }) });
  assert.equal(evaluate(goalHelperExpression('probe')).state, 'temporary_available');
  fixture.page.submitted = true;
  fixture.page.input = 'Temporary Chat';
  assert.equal(evaluate(goalHelperExpression('probe')).state, 'not_fresh');
});

test('native integration isolates the configured account and creates and closes a fresh window per evaluation', async () => {
  const windows = [];
  const sessions = new Map();
  const requests = [];
  const conversationId = 'ca32ef5a-77b0-49f0-983d-b39c12c45ff2';
  let revision = goal.revision;
  let stopOnDraft = false;
  const browserSession = directory => {
    if (!sessions.has(directory)) sessions.set(directory, {
      fetch: async url => {
        requests.push(String(url));
        return new Response(JSON.stringify(String(url).includes('/api/auth/session')
          ? { user: { id: 'fixture-account' }, accessToken: 'fixture-not-a-real-token' }
          : { conversation_id: conversationId, current_node: 'a', mapping: {
            u: { id: 'u', parent: null, children: ['a'], message: { id: 'user', author: { role: 'user' }, content: { parts: ['Fixture'] } } },
            a: { id: 'a', parent: 'u', children: [], message: { id: 'assistant', author: { role: 'assistant' }, end_turn: true, content: { parts: ['Settled'] } } }
          } }));
      }
    });
    return sessions.get(directory);
  };
  class FakeWindow {
    constructor(options) {
      const fixture = helperWindow();
      fixture.page.afterDraft = () => { if (stopOnDraft) revision++; };
      fixture.options = options;
      windows.push(fixture);
      return fixture.win;
    }
  }
  const host = createBrowserSurfaceHost({
    BrowserWindow: FakeWindow, WebContentsView: class {},
    session: { fromPath: browserSession, fromPartition: browserSession },
    getDashboardWindow: () => null, goalLoginProfileDirectory: path.resolve('fixture-goal-profile'),
    getGoalConnections: () => [{ tunnelId: 'tunnel_fixture12345', enabled: true }],
    assertGoalCurrent: fence => {
      if (fence.workId !== evidence.workId || fence.conversationId !== conversationId
        || fence.expectedGoalRevision !== revision || fence.tunnelId !== 'tunnel_fixture12345') {
        throw Object.assign(new Error('Fixture stop changed the durable revision.'), { code: 'GOAL_REVISION_STALE', notSent: true });
      }
    }
  });
  const fence = { workId: evidence.workId, expectedGoalRevision: goal.revision, conversationId, tunnelId: 'tunnel_fixture12345' };
  await assert.rejects(() => host.goalProtocolRequest({ action: 'evaluate', packet }), { code: 'GOAL_REVISION_STALE' });
  for (let index = 0; index < 2; index++) {
    const result = await host.goalProtocolRequest({ action: 'evaluate', packet, ...fence });
    assert.equal(result.ok, true);
  }
  assert.equal(windows.length, 2);
  assert.notEqual(windows[0].win, windows[1].win);
  assert.equal(windows[0].options.webPreferences.session, windows[1].options.webPreferences.session);
  assert.ok(windows.every(fixture => fixture.page.closed && fixture.page.sendCount === 1));
  assert.ok(requests.every(url => url === 'https://chatgpt.com/api/auth/session'), 'helper must not invent or call generation endpoints');
  stopOnDraft = true;
  const staleHelper = await host.goalProtocolRequest({ action: 'evaluate', packet, ...fence });
  assert.equal(staleHelper.ok, false);
  assert.equal(windows.at(-1).page.sendCount, 0, 'cross-process Stop before helper Send must prevent submission');
  revision = goal.revision;
  const staleContinuation = await host.goalProtocolRequest({ action: 'continue', ...fence,
    expectedNodeId: 'a', parentMessageId: 'assistant', prompt: 'Continue the exact fixture work.' });
  assert.equal(staleContinuation.notSent, true);
  assert.equal(windows.at(-1).page.sendCount, 0, 'cross-process Stop during composer preparation must prevent native continuation Send');
  assert.equal(windows.at(-1).page.closed, true);
  await host.closeAll();
});
