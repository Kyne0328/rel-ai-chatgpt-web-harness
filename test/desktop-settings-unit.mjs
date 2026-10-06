import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-desktop-settings-'));
const previousStateDir = process.env.REL_AI_MCP_STATE_DIR;
const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_STATE_DIR = root;
process.env.REL_AI_MCP_CONFIG = path.join(root, 'config.json');

const { saveLauncherConfig } = await import('../electron/launcher-config.js');
const { readGuiConfig } = await import('../electron/launcher-utils.js');
const { readDesktopSettings, saveDesktopSettings } = await import('../electron/desktop-settings.js');

let notificationsEnabled = true;
let restarts = 0;
let storedApiKey = 'sk-runtime-original-123456';

try {
  saveLauncherConfig({ port: 3333, token: 'preserved-token', tunnelId: 'tunnel_example123456' });
  assert.deepEqual(readDesktopSettings({ tunnelApiKeyConfigured: true, notificationsEnabled }), {
    ok: true,
    port: 3333,
    tunnelId: 'tunnel_example123456',
    tunnelApiKey: '',
    tunnelApiKeyConfigured: true,
    notificationsEnabled: true,
    tunnelErrorCode: '',
    tunnelError: ''
  });

  const runtimeActions = {
    setNotificationsEnabled(value) { notificationsEnabled = value; },
    getNotificationsEnabled() { return notificationsEnabled; },
    setTunnelApiKey(value) { storedApiKey = value; },
    getTunnelApiKey() { return storedApiKey; },
    clearTunnelApiKey() { storedApiKey = ''; },
    canRestart() { return ''; },
    async restartDesktop() { restarts += 1; return { serverRunning: true }; }
  };

  const result = await saveDesktopSettings({
    port: 4444,
    tunnelId: 'tunnel_replacement123',
    tunnelApiKey: 'sk-runtime-replacement-123456',
    notificationsEnabled: false
  }, runtimeActions);
  assert.equal(result.ok, true);
  assert.deepEqual(readGuiConfig(), { port: 4444, token: 'preserved-token', tunnelId: 'tunnel_replacement123' });
  assert.equal(storedApiKey, 'sk-runtime-replacement-123456');
  assert.equal(notificationsEnabled, false);
  assert.equal(restarts, 1);

  let tunnelRestarts = 0;
  const tunnelOnly = await saveDesktopSettings({ tunnelApiKey: 'sk-runtime-tunnel-only-123456' }, {
    ...runtimeActions,
    getCurrentStatus: () => ({ serverRunning: true, tunnelStatus: 'running' }),
    canRestart: () => 'An active task blocks a full service restart.',
    restartConnection: async () => { tunnelRestarts += 1; return { serverRunning: true, tunnelStatus: 'running' }; }
  });
  assert.equal(tunnelOnly.ok, true);
  assert.equal(tunnelRestarts, 1, 'runtime-key replacement must restart only the tunnel when the local service is healthy');
  assert.equal(restarts, 1, 'tunnel-only reconnect must not restart the local service');
  assert.equal(storedApiKey, 'sk-runtime-tunnel-only-123456');

  const rejected = await saveDesktopSettings({ tunnelApiKey: 'sk-runtime-rejected-123456' }, {
    ...runtimeActions,
    getCurrentStatus: () => ({ serverRunning: true, tunnelStatus: 'running' }),
    restartConnection: async () => ({
      serverRunning: true,
      tunnelStatus: 'failed',
      errorCode: 'tunnel_authentication_failed',
      error: 'OpenAI rejected the tunnel runtime API key.'
    })
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.saved, true);
  assert.equal(rejected.errorCode, 'tunnel_authentication_failed');
  assert.equal(storedApiKey, 'sk-runtime-rejected-123456', 'a rejected replacement key stays saved so the user can explicitly replace it');

  storedApiKey = 'sk-runtime-tunnel-only-123456';
  let failingRestarts = 0;
  await assert.rejects(
    () => saveDesktopSettings({ port: 5555, tunnelId: 'tunnel_failed12345', tunnelApiKey: 'sk-runtime-failed-123456', notificationsEnabled: true }, {
      setNotificationsEnabled(value) { notificationsEnabled = value; },
      getNotificationsEnabled() { return notificationsEnabled; },
      setTunnelApiKey(value) { storedApiKey = value; },
      getTunnelApiKey() { return storedApiKey; },
      clearTunnelApiKey() { storedApiKey = ''; },
      canRestart() { return ''; },
      restartDesktop: async () => {
        failingRestarts += 1;
        return failingRestarts === 1 ? { serverRunning: false, error: 'restart failed' } : { serverRunning: true };
      }
    }),
    /restart failed.*restored/i
  );
  assert.deepEqual(readGuiConfig(), { port: 4444, token: 'preserved-token', tunnelId: 'tunnel_replacement123' }, 'failed reconnect must restore launcher config');
  assert.equal(storedApiKey, 'sk-runtime-tunnel-only-123456', 'failed full reconnect must restore the previous encrypted key');
  assert.equal(notificationsEnabled, false, 'failed reconnect must restore notification preferences');
  assert.equal(failingRestarts, 2, 'rollback must restart the restored configuration');

  await assert.rejects(
    () => saveDesktopSettings({ port: 6666 }, { setTunnelApiKey() {}, canRestart: () => 'Finish or cancel the active Rel.AI task before saving connection settings.', restartDesktop: async () => ({ serverRunning: true }) }),
    /active Rel\.AI task/
  );
  await assert.rejects(() => saveDesktopSettings({}, { setTunnelApiKey() {} }), /restartDesktop is required/);
} finally {
  if (previousStateDir === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousStateDir;
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Desktop secure tunnel settings unit tests passed.');
