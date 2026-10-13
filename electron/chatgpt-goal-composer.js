// Read-only DOM probes for ChatGPT's normal composer. No network APIs, token
// access, or challenge execution is injected into the page.
const EDITOR = [
  '#prompt-textarea[contenteditable="true"]',
  '[data-testid="composer-text-input"][contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]'
].join(', ');
const SEND = [
  '#composer-submit-button',
  'button[data-testid="send-button"]',
  'button[data-testid="composer-send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[type="submit"]'
].join(', ');

function goalComposerExpression(action, expectedText = '') {
  if (!['probe', 'focus', 'send'].includes(action)) throw new Error('Unsupported Goal Mode composer probe.');
  return `(() => {
    /* relai-goal-composer */
    const editor = document.querySelector(${JSON.stringify(EDITOR)});
    const challenge = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], #challenge-stage, #cf-challenge-running');
    if (challenge || location.pathname.startsWith('/cdn-cgi/')) return { state: 'verification' };
    if (!editor || !editor.isConnected) return { state: 'loading' };
    const clean = value => String(value || '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ').trim();
    const texts = [editor.value, editor.textContent, editor.innerText].map(clean);
    if (${JSON.stringify(action)} === 'probe') return { state: 'ready', occupied: texts.some(Boolean) };
    if (${JSON.stringify(action)} === 'focus') {
      editor.focus();
      return { state: document.activeElement === editor ? 'focused' : 'unavailable' };
    }
    if (!texts.includes(clean(${JSON.stringify(expectedText)}))) return { state: 'text_mismatch' };
    const root = editor.closest('form') || document;
    const candidates = Array.from(root.querySelectorAll(${JSON.stringify(SEND)}));
    const button = candidates.find(candidate => {
      if (candidate.disabled || candidate.getAttribute('aria-disabled') === 'true') return false;
      const rect = candidate.getBoundingClientRect();
      return rect.width >= 1 && rect.height >= 1;
    });
    if (!button) return { state: 'send_unavailable' };
    // Focus the actual Send control, not a point in a hidden window. A native
    // Enter key then activates the button without relying on screen geometry.
    button.focus();
    if (document.activeElement !== button) return { state: 'send_unavailable' };
    return { state: 'send_ready' };
  })()`;
}

// Stop only the exact ChatGPT generation control in the active composer.
// Never use a generic text search that could hit unrelated page actions.
function goalStopExpression() {
  return `(() => {
    /* relai-goal-stop */
    const challenge = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], #challenge-stage, #cf-challenge-running');
    if (challenge || location.pathname.startsWith('/cdn-cgi/')) return { state: 'verification' };
    const editor = document.querySelector('#prompt-textarea[contenteditable="true"], [data-testid="composer-text-input"][contenteditable="true"], [contenteditable="true"][role="textbox"]');
    if (!editor) return { state: 'loading' };
    const root = editor.closest('form') || document;
    const buttons = [...root.querySelectorAll('button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop response"], button[aria-label="Stop"]')].filter(button => {
      const rect = button.getBoundingClientRect();
      return !button.disabled && button.getAttribute('aria-disabled') !== 'true' && rect.width >= 1 && rect.height >= 1;
    });
    if (buttons.length !== 1) return { state: buttons.length ? 'ambiguous' : 'not_running' };
    buttons[0].focus();
    return { state: document.activeElement === buttons[0] ? 'stop_ready' : 'unavailable' };
  })()`;
}

function goalMessageExists(conversation, expectedText, expectedParentNode) {
  const nodes = conversation?.mapping;
  let nodeId = conversation?.current_node;
  const seen = new Set();
  let found = false;
  while (nodeId && nodes?.[nodeId] && !seen.has(nodeId) && seen.size < 50) {
    if (nodeId === expectedParentNode) return found;
    seen.add(nodeId);
    const message = nodes[nodeId].message;
    if (message?.author?.role === 'user' && Array.isArray(message.content?.parts)
      && message.content.parts.join('\n').trim() === expectedText) found = true;
    nodeId = nodes[nodeId].parent;
  }
  return false;
}

function goalAssistantComplete(conversation) {
  const message = conversation?.mapping?.[conversation?.current_node]?.message;
  return message?.author?.role === 'assistant'
    && message.end_turn === true && message.status === 'finished_successfully';
}

export { goalComposerExpression, goalStopExpression, goalMessageExists, goalAssistantComplete };
