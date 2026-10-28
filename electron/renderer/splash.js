'use strict';

const status = document.getElementById('startupStatus');
const settings = document.getElementById('startupSettings');
window.relaiSplash?.onStatus(next => {
  if (!next || typeof next.text !== 'string') return;
  status.textContent = next.text;
  settings.hidden = next.blocked !== true;
});
settings.addEventListener('click', () => { void window.relaiSplash?.openSetup(); });
