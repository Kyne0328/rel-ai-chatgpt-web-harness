import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { smokeDesktopLifecycle } from '../scripts/smoke-desktop-lifecycle.mjs';
import { recordDesktopSmokeReadiness } from '../electron/desktop-smoke-readiness.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-desktop-smoke-contract-'));
const cases = [];
try {
  for (const [name, code] of [['early-clean-exit', 'process.exit(0)'], ['crash', 'process.exit(7)']]) {
    await assert.rejects(smokeDesktopLifecycle({ executable: process.execPath, argv: ['-e', code],
      stateDirectory: root, timeoutMs: 2000, stableMs: 10, shutdownMs: 500 }), /exited before/);
    cases.push(name);
  }
  const app = { getPath: () => root };
  const env = { REL_AI_DESKTOP_SMOKE_NONCE: 'a'.repeat(32), REL_AI_ELECTRON_DEV_USER_DATA: root };
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.isLoadingMainFrame = () => false;
  contents.getURL = () => 'file:///isolated-wizard.html';
  const BrowserWindow = { getAllWindows: () => [{ isDestroyed: () => false, webContents: contents }] };
  assert.equal(await recordDesktopSmokeReadiness({ app, BrowserWindow, env }), true);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'desktop-smoke-ready.json'), 'utf8'));
  assert.equal(receipt.ready, true);
  assert.equal(receipt.pid, process.pid);
  await assert.rejects(recordDesktopSmokeReadiness({ app, BrowserWindow: { getAllWindows: () => [] }, env }), /without a renderer/);
  contents.getURL = () => 'about:blank';
  await assert.rejects(recordDesktopSmokeReadiness({ app, BrowserWindow, env, timeoutMs: 20 }), /timed out/);
  contents.isLoadingMainFrame = () => true;
  const failed = recordDesktopSmokeReadiness({ app, BrowserWindow, env, timeoutMs: 100 });
  queueMicrotask(() => contents.emit('did-fail-load', {}, -2, 'fixture load failed', '', true));
  await assert.rejects(failed, /failed to load/);
  assert.equal(contents.listenerCount('did-finish-load'), 0);
  cases.push('loaded-renderer-receipt', 'no-window', 'blank-window', 'renderer-failure-cleanup');

  for (const mode of ['healthy', 'wrong-pid', 'wrong-nonce', 'missing', 'crash-after-ready']) {
    let child;
    const spawnImpl = (_executable, _argv, options) => {
      child = new EventEmitter();
      child.pid = 123456789;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { close(0); };
      const close = code => {
        if (child.exitCode !== null) return;
        child.exitCode = code;
        child.emit('close', code, null);
      };
      queueMicrotask(() => {
        if (mode !== 'missing') {
          fs.writeFileSync(path.join(options.env.REL_AI_ELECTRON_DEV_USER_DATA, 'desktop-smoke-ready.json'),
            JSON.stringify({ ready: true, rendererCount: 1,
              pid: mode === 'wrong-pid' ? 1 : child.pid,
              nonce: mode === 'wrong-nonce' ? 'stale' : options.env.REL_AI_DESKTOP_SMOKE_NONCE }));
        }
        if (mode === 'crash-after-ready') setTimeout(() => close(9), 10);
      });
      return child;
    };
    const options = { executable: 'synthetic-only', stateDirectory: root, spawnImpl,
      terminateImpl: target => target.kill(), timeoutMs: 80, stableMs: 30, shutdownMs: 50 };
    if (mode === 'healthy') {
      const result = await smokeDesktopLifecycle(options);
      assert.equal(result.shutdownClean, true);
    } else await assert.rejects(smokeDesktopLifecycle(options), /readiness|exited before/);
    assert.notEqual(child.exitCode, null, 'every synthetic child must be settled');
    cases.push(mode);
  }
  const manifest = JSON.parse(fs.readFileSync(new URL('../electron/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.build.files.includes('desktop-smoke-readiness.js'), 'The Electron main import must ship in the application archive.');
  cases.push('packaged-readiness-module');
  const shell = fs.readFileSync(new URL('../scripts/smoke-linux-desktop.sh', import.meta.url), 'utf8');
  assert.match(shell, /node "\$script_directory\/smoke-desktop-lifecycle\.mjs"/);
  assert.doesNotMatch(shell, /wait "\$app_pid"\s+exit \$\?/);
  console.log(JSON.stringify({ passed: cases, nativeLinuxPackageAcceptance: 'not run' }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
