// Test-only bridge. No ipcRenderer, production preload, clipboard, shell or service calls.
const { contextBridge } = require('electron');
const calls = [];
const outcomes = new Map();
const pending = new Map();
let statusListener;
let pulseListener;
let logListener;

async function invoke(method, payload) {
  calls.push({ method, payload });
  const queue = outcomes.get(method) || [];
  const outcome = queue.shift() || { value: { ok: true } };
  if (outcome.pending) return new Promise((resolve, reject) => pending.set(method, { resolve, reject }));
  if (outcome.reject) throw new Error(outcome.reject);
  return outcome.value;
}

contextBridge.exposeInMainWorld('nativeFixture', {
  queue(method, values) { outcomes.set(method, values); },
  calls(method) { return calls.filter(call => !method || call.method === method); },
  release(method, outcome) {
    const operation = pending.get(method);
    if (!operation) throw new Error('No pending fixture operation: ' + method);
    pending.delete(method);
    if (outcome.reject) operation.reject(new Error(outcome.reject));
    else operation.resolve(outcome.value);
  },
  status(value) { statusListener?.(value); },
  pulse(value) { pulseListener?.(value); },
  log(value) { logListener?.(value); }
});

contextBridge.exposeInMainWorld('electronAPI', {
  async getRecoveryConfig() {
    calls.push({ method: 'getRecoveryConfig' });
    return new URLSearchParams(globalThis.location.search).get('recovery') === '1'
      ? { port: 4444, tunnelId: 'tunnel_synthetic_recovery', tunnelApiKeyConfigured: true }
      : {};
  },
  wizardDone: value => invoke('wizardDone', value),
  closeWizard: () => invoke('closeWizard'),
  openOpenAISetup: value => invoke('openOpenAISetup', value),
  onServerStatus(listener) { statusListener = listener; },
  onServerLog(listener) { logListener = listener; },
  fitWindowToContent() {},
  copyUrl: value => invoke('copyUrl', value),
  openDashboard: () => invoke('openDashboard'),
  openRecoverySetup: () => invoke('openRecoverySetup'),
  startServer: () => invoke('startServer'),
  stopServer: () => invoke('stopServer'),
  restartConnection: () => invoke('restartConnection'),
  relaunchApp: () => invoke('relaunchApp')
});

contextBridge.exposeInMainWorld('relaiPulse', {
  onState(listener) { pulseListener = listener; },
  setExpanded: value => invoke('setExpanded', value),
  openDashboard: () => invoke('openDashboard')
});
