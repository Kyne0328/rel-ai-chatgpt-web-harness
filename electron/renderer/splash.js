'use strict';

const status = document.getElementById('startupStatus');
window.relaiSplash?.onStatus(next => {
  if (typeof next === 'string') status.textContent = next;
});
