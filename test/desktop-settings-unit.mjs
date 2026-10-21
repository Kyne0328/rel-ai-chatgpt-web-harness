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

  for (const change of [
    { tunnelId: 'tunnel_localreplacement123', tunnelApiKey: 'sk-runtime-new-local-123456' },
    { port: 4445 },
  ]) {
    saveLauncherConfig({ port: 3333, token: 'local-only-token', tunnelId: '' }, { allowLocalOnly: true });
    storedApiKey = '';
    let attempts = 0;
    await assert.rejects(() => saveDesktopSettings(change, {
      ...runtimeActions,
      restartDesktop: async () => ++attempts === 1 ? { serverRunning: false, error: 'fixture restart failed' } : { serverRunning: true }
    }), /fixture restart failed.*Previous connection settings were restored/);
    assert.deepEqual(readGuiConfig(), { port: 3333, token: 'local-only-token', tunnelId: '' });
    assert.equal(storedApiKey, '', 'rollback restores the absent local-only credential');
    assert.equal(readDesktopSettings({ tunnelApiKeyConfigured: Boolean(storedApiKey) }).tunnelApiKeyConfigured, false);
    const { readLaunchEnv } = await import('../src/connectionProfile.js');
    assert.equal(readLaunchEnv().REL_AI_MCP_LOCAL_ONLY, '1');
    assert.equal(attempts, 2);
  }
  await assert.rejects(() => saveDesktopSettings({ port: 4445 }, {
    ...runtimeActions, restartDesktop: async () => ({ serverRunning: false, error: 'fixture remains offline' })
  }), /could not fully restore/);
  let unsafeRollbackStarts = 0;
  await assert.rejects(() => saveDesktopSettings({ tunnelApiKey: 'sk-runtime-new-local-123456' }, {
    ...runtimeActions,
    clearTunnelApiKey: () => { throw new Error('fixture credential restoration failed'); },
    restartDesktop: async () => { unsafeRollbackStarts += 1; return { serverRunning: false, error: 'fixture offline' }; }
  }), /could not fully restore/);
  assert.equal(unsafeRollbackStarts, 1, 'failed credential restoration must not reconnect inconsistent settings');
  assert.deepEqual(readGuiConfig(), { port: 3333, token: 'local-only-token', tunnelId: '' });

  // A damaged encrypted record must be replaceable without decrypting it, and
  // an unrelated local restart failure must restore the original encrypted bytes.
  {
    const { createTunnelCredentialStore } = await import('../electron/tunnel-credentials.js');
    const store = createTunnelCredentialStore({ stateDir: root, safeStorage: {
      isEncryptionAvailable: () => true, encryptString: value => Buffer.from('encrypted:' + value),
      decryptString: value => value.toString().replace(/^encrypted:/, '')
    } });
    const corrupt = Buffer.from('{unreadable encrypted record');
    const credentialActions = { ...runtimeActions, getCurrentStatus: () => ({ serverRunning: true }),
      setTunnelApiKey: store.setApiKey, getTunnelApiKey: store.getApiKey,
      clearTunnelApiKey: store.clear, captureTunnelApiKey: store.capture, restoreTunnelApiKey: store.restore,
      restartConnection: async () => ({ serverRunning: true, tunnelStatus: 'running' }) };
    saveLauncherConfig({ port: 3333, token: 'fixture-token', tunnelId: 'tunnel_repairfixture123' });
    fs.writeFileSync(store.statePath(), corrupt);
    const repaired = await saveDesktopSettings({ tunnelApiKey: 'fixture-repaired-key' }, credentialActions);
    assert.equal(repaired.ok, true);
    assert.equal(store.getApiKey(), 'fixture-repaired-key');
    fs.writeFileSync(store.statePath(), corrupt);
    let calls = 0;
    await assert.rejects(() => saveDesktopSettings({ tunnelApiKey: 'fixture-replacement-key' }, {
      ...credentialActions, restartConnection: async () => ++calls === 1
        ? { serverRunning: false, error: 'fixture local failure' }
        : { serverRunning: true, tunnelStatus: 'failed', error: 'original credential remains unreadable' }
    }), /fixture local failure/);
    assert.deepEqual(fs.readFileSync(store.statePath()), corrupt, 'rollback preserves exact encrypted evidence even when it cannot decrypt');
  }

  {
    const { createTunnelRecoverySupervisor } = await import('../electron/tunnel-recovery-supervisor.js');
    const scheduled = [];
    const supervisor = createTunnelRecoverySupervisor({
      restartConnection: async () => ({ serverRunning: true, tunnelStatus: 'degraded', errorCode: 'tunnel_connection_interrupted' }),
      setTimer(fn) { const timer = { fn }; scheduled.push(timer); return timer; }, clearTimer() {}
    });
    try {
      const result = await saveDesktopSettings({ tunnelApiKey: 'fixture-offline-key' }, {
        ...runtimeActions, getCurrentStatus: () => ({ serverRunning: true }), restartConnection: supervisor.retryNow
      });
      assert.equal(result.status.tunnelStatus, 'degraded');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(supervisor.snapshot().scheduled, true, 'a completed save must keep offline recovery scheduled');
    } finally { supervisor.cancel(); }
  }

} finally {
  if (previousStateDir === undefined) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousStateDir;
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Desktop secure tunnel settings unit tests passed.');
