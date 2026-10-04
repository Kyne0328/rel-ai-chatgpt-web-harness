import { importResourceModule } from './resource-path.js';

const { MAX_DESKTOP_CLIPBOARD_BYTES } = await importResourceModule('src/contracts/desktopValidation.js');

const MAX_CLIPBOARD_TEXT_BYTES = MAX_DESKTOP_CLIPBOARD_BYTES;

function createWindowGuards(BrowserWindow) {
  const isSenderWindow = (event, getWindow) => {
    if (!event?.sender) return false;
    const expectedWindow = getWindow();
    if (!expectedWindow || expectedWindow.isDestroyed?.()) return false;
    return BrowserWindow.fromWebContents(event.sender) === expectedWindow;
  };
  const isSenderAllowed = (event, getters) => getters.some(getWindow => isSenderWindow(event, getWindow));
  const windowOnly = (event, getWindow, label, action) => {
    if (!isSenderWindow(event, getWindow)) throw new Error(`${label} is not available to this renderer.`);
    return action();
  };
  const allowedWindows = (event, getters, label, action) => {
    if (!isSenderAllowed(event, getters)) throw new Error(`${label} is not available to this renderer.`);
    return action();
  };
  return { isSenderWindow, isSenderAllowed, windowOnly, allowedWindows };
}

function createContractIpcRegistrar({ ipcMain, BrowserWindow, contract, windowGetters }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('A valid ipcMain implementation is required.');
  }
  if (!contract || typeof contract !== 'object') throw new TypeError('A desktop IPC input contract is required.');

  const guards = createWindowGuards(BrowserWindow);

  function registrationSpec(channel, mode) {
    const spec = contract[channel];
    if (!spec) throw new Error(`Desktop IPC channel is missing from the input contract: ${channel}`);
    if (spec.mode !== mode) throw new Error(`Desktop IPC channel ${channel} must register with ipcMain.${spec.mode}, not ipcMain.${mode}.`);
    if (!Array.isArray(spec.windows) || spec.windows.length === 0) throw new Error(`Desktop IPC channel ${channel} has no allowed renderer surface.`);
    return spec;
  }

  function allowedGetters(channel, spec) {
    return spec.windows.map(surface => {
      const getWindow = windowGetters?.[surface];
      if (typeof getWindow !== 'function') throw new Error(`Desktop IPC channel ${channel} references unknown renderer surface: ${surface}`);
      return getWindow;
    });
  }

  function authorize(event, channel, spec, label, action) {
    const getters = allowedGetters(channel, spec);
    if (spec.failure === 'ignore' && !guards.isSenderAllowed(event, getters)) return undefined;
    return guards.allowedWindows(event, getters, label, action);
  }

  function handle(channel, label, action) {
    if (typeof action !== 'function') throw new TypeError(`Desktop IPC handler for ${channel} must be a function.`);
    const spec = registrationSpec(channel, 'handle');
    ipcMain.handle(channel, (event, ...args) => authorize(event, channel, spec, label, () => action(event, ...args)));
  }

  function on(channel, label, action) {
    if (typeof action !== 'function') throw new TypeError(`Desktop IPC listener for ${channel} must be a function.`);
    const spec = registrationSpec(channel, 'on');
    ipcMain.on(channel, (event, ...args) => authorize(event, channel, spec, label, () => action(event, ...args)));
  }

  return { handle, on, guards };
}

function logIpcFailure(error) {
  if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] secured IPC action:', error);
}

export { MAX_CLIPBOARD_TEXT_BYTES, createContractIpcRegistrar, createWindowGuards, logIpcFailure };
