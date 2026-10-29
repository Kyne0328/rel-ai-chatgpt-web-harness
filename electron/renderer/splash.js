'use strict';

const status = document.getElementById('startupStatus');
const settings = document.getElementById('startupSettings');
const splash = document.querySelector('.splash');
window.relaiSplash?.onStatus(next => {
  if (!next || typeof next.text !== 'string') return;
  status.textContent = next.text;
  settings.hidden = next.blocked !== true;
  splash.dataset.phase = next.blocked ? 'blocked' : next.phase === 'recovering' ? 'recovering' : 'working';
});
settings.addEventListener('click', async () => {
  if (settings.disabled) return;
  settings.disabled = true;
  settings.setAttribute('aria-busy', 'true');
  try {
    const result = await window.relaiSplash?.openSetup();
    if (result?.ok === false) status.textContent = result.error || 'Connection settings unavailable.';
  } catch {
    status.textContent = 'Connection settings unavailable.';
  } finally {
    settings.disabled = false;
    settings.removeAttribute('aria-busy');
  }
});
