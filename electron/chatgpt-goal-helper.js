// Fresh Temporary Chat in the existing signed-in browser profile, using only
// the normal composer and visible response DOM. No helper tool dispatch or
// private generation endpoints; every attempt owns and closes its own window.
// This does not create a server-side tool sandbox. We never enable apps/tools,
// instruct the helper not to use them, and reject observed tool selection/output.
// Live ChatGPT UI availability and platform-side tool policy require acceptance.
import { goalComposerExpression } from './chatgpt-goal-composer.js';

function goalHelperExpression(action, expectedPrompt = '') {
  if (!['probe', 'temporary', 'response'].includes(action)) throw new Error('Unsupported helper probe.');
  return `(() => {
    /* relai-goal-helper */
    const action = ${JSON.stringify(action)};
    const clean = value => String(value || '').replace(/[\\u200b-\\u200d\\ufeff]/g, '').replace(/\\u00a0/g, ' ').trim();
    if (location.origin !== 'https://chatgpt.com') return { state: 'wrong_origin' };
    const challenge = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], #challenge-stage, #cf-challenge-running');
    if (challenge || location.pathname.startsWith('/cdn-cgi/')) return { state: 'verification' };
    const visible = element => {
      if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const users = [...document.querySelectorAll('[data-message-author-role="user"]')].filter(visible);
    const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    const toolOutput = document.querySelector('[data-message-author-role="tool"], [data-tool-name], [data-testid="tool-call"], [data-testid="tool-result"]');
    const attached = document.querySelector('[data-testid="composer-attachment"], [data-testid="file-thumbnail"], [data-testid="connector-chip"], [data-testid="app-chip"]');
    const selectedTools = [...document.querySelectorAll('[aria-pressed="true"], [data-state="on"]')]
      .filter(visible).some(element => /^(?:search|deep research|agent mode|apps|connectors|use tools)$/i.test(clean(element.getAttribute('aria-label') || element.textContent)));
    if (toolOutput || attached || selectedTools) return { state: 'tools_unavailable' };
    const alerts = [...document.querySelectorAll('[role="alert"], [data-testid="conversation-turn-error"]')]
      .filter(visible).map(element => clean(element.textContent)).join(' ');
    if (/usage limit|rate limit|message limit|reached.{0,30}limit|too many requests|try again later/i.test(alerts)) return { state: 'quota' };
    if (alerts) return { state: 'response_error' };
    if (action === 'response') {
      if (users.length !== 1 || clean(users[0].innerText || users[0].textContent) !== clean(${JSON.stringify(expectedPrompt)})) {
        return { state: users.length ? 'receipt_mismatch' : 'pending' };
      }
      if (assistants.length > 1) return { state: 'receipt_mismatch' };
      if (!assistants.length) return { state: 'pending' };
      const assistant = assistants[0];
      const running = [...document.querySelectorAll('button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop response"], [data-is-streaming="true"], .result-streaming')].some(visible);
      const turn = assistant.closest('article, [data-testid^="conversation-turn-"]') || assistant.parentElement;
      const finalControl = [...(turn?.querySelectorAll('button[data-testid="copy-turn-action-button"], button[aria-label="Copy"], button[aria-label="Copy response"]') || [])].some(visible);
      if (running || !finalControl) return { state: 'pending' };
      const markdown = assistant.querySelector('.markdown');
      const text = clean((markdown || assistant).innerText || (markdown || assistant).textContent);
      if (!text || text.length > 8192) return { state: 'invalid_response' };
      return { state: 'complete', text };
    }
    // An existing conversation never becomes a helper.
    if (users.length || assistants.length || location.pathname !== '/') return { state: 'not_fresh' };
    const candidates = [...document.querySelectorAll('button[data-testid="temporary-chat-button"], button[aria-label="Temporary chat"], button[aria-label="Turn on temporary chat"], button[aria-label="Turn off temporary chat"], button')].filter(visible)
      .filter(button => button.getAttribute('data-testid') === 'temporary-chat-button'
        || /^(?:temporary(?: chat)?|turn (?:on|off) temporary chat)$/i.test(clean(button.getAttribute('aria-label') || button.textContent)));
    const active = candidates.some(button => button.getAttribute('aria-pressed') === 'true'
      || button.getAttribute('data-state') === 'on'
      || /^turn off temporary chat$/i.test(clean(button.getAttribute('aria-label'))))
      || [...document.querySelectorAll('h1, h2, [role="heading"]')].filter(visible)
        .some(heading => /^temporary chat$/i.test(clean(heading.textContent)));
    if (active) return { state: 'temporary_ready' };
    if (action === 'temporary') {
      if (candidates.length !== 1 || candidates[0].disabled || candidates[0].getAttribute('aria-disabled') === 'true') return { state: 'temporary_unavailable' };
      candidates[0].focus();
      return { state: document.activeElement === candidates[0] ? 'temporary_focused' : 'temporary_unavailable' };
    }
    return { state: candidates.length ? 'temporary_available' : 'loading' };
  })()`;
}

function cancelled(signal) {
  signal?.throwIfAborted();
}

function wait(milliseconds, signal) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runGoalHelperBrowser(win, prompt, { signal, attachedDebugger, assertAvailable = () => {},
  timeoutMs = 85_000, pollMs = 350 } = {}) {
  if (typeof prompt !== 'string' || !prompt || Buffer.byteLength(prompt) > 40 * 1024
    || typeof attachedDebugger !== 'function') {
    if (!win.isDestroyed?.()) win.close();
    return { ok: false, notSent: true, reason: 'invalid_request' };
  }
  const controller = new AbortController();
  const parentAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Helper timed out.'), { code: 'GOAL_EVALUATOR_TIMEOUT' })),
    Math.max(1, Math.min(85_000, Number(timeoutMs) || 85_000)));
  let submitted = false;
  let stage = 'navigation';
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  const check = () => {
    cancelled(signal);
    cancelled(controller.signal);
    assertAvailable();
    if (win.isDestroyed?.() || win.webContents.isDestroyed?.()) throw new Error('Helper browser closed.');
  };
  const operation = async perform => {
    check();
    const result = await Promise.race([perform(), aborted]);
    check();
    return result;
  };
  const probe = action => operation(() => win.webContents.executeJavaScript(goalHelperExpression(action, prompt), true));
  const fail = reason => ({ ok: false, notSent: !submitted, uncertain: submitted, stage, reason,
    ...(reason === 'quota' ? { status: 429, retryAfterMs: 60_000 } : {}) });
  const enter = async debuggerApi => {
    check();
    await operation(() => debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'
    }));
    await operation(() => debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
    }));
  };
  // No popups or external navigation are needed to evaluate text.
  win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  const navigation = (event, url) => {
    try { if (new URL(url).origin !== 'https://chatgpt.com') event.preventDefault(); }
    catch { event.preventDefault(); }
  };
  win.webContents.on?.('will-navigate', navigation);
  try {
    check();
    await operation(() => win.loadURL('https://chatgpt.com/'));
    stage = 'temporary_chat';
    let temporary;
    const readyUntil = Date.now() + 14_000;
    do {
      temporary = await probe('probe');
      if (temporary?.state !== 'loading') break;
      await wait(pollMs, controller.signal);
    } while (Date.now() < readyUntil);
    if (!['temporary_ready', 'temporary_available'].includes(temporary?.state)) return fail(temporary?.state || 'temporary_unavailable');
    const debuggerApi = await operation(() => attachedDebugger(win.webContents));
    if (temporary.state !== 'temporary_ready') {
      const focused = await probe('temporary');
      if (focused?.state !== 'temporary_focused') return fail('temporary_unavailable');
      await enter(debuggerApi);
      const activatedUntil = Date.now() + 8_000;
      do {
        temporary = await probe('probe');
        if (temporary?.state === 'temporary_ready') break;
        if (['verification', 'not_fresh', 'tools_unavailable'].includes(temporary?.state)) return fail(temporary.state);
        await wait(pollMs, controller.signal);
      } while (Date.now() < activatedUntil);
    }
    if (temporary?.state !== 'temporary_ready') return fail('temporary_unavailable');
    stage = 'composer';
    let composer;
    const composerUntil = Date.now() + 8_000;
    do {
      composer = await operation(() => win.webContents.executeJavaScript(goalComposerExpression('probe'), true));
      if (composer?.state === 'ready' || composer?.state === 'verification') break;
      await wait(pollMs, controller.signal);
    } while (Date.now() < composerUntil);
    if (composer?.state !== 'ready' || composer.occupied) return fail(composer?.occupied ? 'draft_present' : 'composer_unavailable');
    stage = 'draft';
    if ((await operation(() => win.webContents.executeJavaScript(goalComposerExpression('focus'), true)))?.state !== 'focused') return fail('focus_unavailable');
    // Fresh and verified empty: do not replace any user or restored draft.
    await operation(() => debuggerApi.sendCommand('Input.insertText', { text: prompt }));
    stage = 'send_button';
    let send;
    const sendUntil = Date.now() + 6_000;
    do {
      send = await operation(() => win.webContents.executeJavaScript(goalComposerExpression('send', prompt), true));
      if (send?.state === 'send_ready' || send?.state === 'text_mismatch' || send?.state === 'verification') break;
      await wait(pollMs, controller.signal);
    } while (Date.now() < sendUntil);
    if (send?.state !== 'send_ready') return fail(send?.state || 'send_unavailable');
    if ((await probe('probe'))?.state !== 'temporary_ready') return fail('temporary_unavailable');
    // This read-only probe leaves the verified Send button focused.
    check();
    stage = 'submit';
    submitted = true; // A single attempt; ambiguous outcomes are never resent.
    await enter(debuggerApi);
    stage = 'response';
    let previousText = '';
    for (;;) {
      const response = await probe('response');
      if (response?.state === 'complete') {
        if (response.text === previousText) return { ok: true, text: response.text, helper: 'fresh_temporary_chat' };
        previousText = response.text;
      } else {
        previousText = '';
        if (response?.state !== 'pending') return fail(response?.state || 'invalid_response');
      }
      await wait(pollMs, controller.signal);
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error?.code === 'GOAL_EVALUATOR_TIMEOUT') return { ...fail('timeout'), timeout: true };
    if (error?.code === 'GOAL_ACCOUNT_UNAVAILABLE') return { ...fail('account_unavailable'), needsUser: true };
    return fail('helper_unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', parentAbort);
    controller.signal.removeEventListener('abort', onAbort);
    win.webContents.removeListener?.('will-navigate', navigation);
    if (!win.isDestroyed?.()) win.close();
  }
}

export { goalHelperExpression, runGoalHelperBrowser };
