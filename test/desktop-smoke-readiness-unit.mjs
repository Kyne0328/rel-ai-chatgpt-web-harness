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

  for (const mode of ['healthy', 'wrong-pid', 'wrong-nonce', 'missing', 'crash-after-ready', 'unclean-shutdown', 'signal-shutdown']) {
    let child;
    const spawnImpl = (_executable, _argv, options) => {
      child = new EventEmitter();
      child.pid = 123456789;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = signal => {
        assert.equal(signal, 'SIGTERM');
        close(mode === 'unclean-shutdown' ? 7 : mode === 'signal-shutdown' ? null : 0,
          mode === 'signal-shutdown' ? 'SIGTRAP' : null);
      };
      const close = (code, signal = null) => {
        if (child.exitCode !== null || child.signalCode) return;
        child.exitCode = code;
        child.signalCode = signal;
        child.emit('close', code, signal);
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
      terminateImpl: (target, signal) => target.kill(signal), timeoutMs: 80, stableMs: 30, shutdownMs: 50 };
    if (mode === 'healthy') {
      const result = await smokeDesktopLifecycle(options);
      assert.equal(result.shutdownClean, true);
    } else await assert.rejects(smokeDesktopLifecycle(options), /readiness|exited before|shutdown was not clean/);
    assert.ok(child.exitCode !== null || child.signalCode, 'every synthetic child must be settled');
    cases.push(mode);
  }
  if (process.platform !== 'win32') {
    const helperCode = `
      if (process.env.SMOKE_FIXTURE_MODE === 'ignore-term') process.on('SIGTERM', () => {});
      process.on('message', () => process.exit(0));
      process.send('ready');
      setInterval(() => {}, 1000);
    `;
    const fixtureCode = `
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawn } = require('node:child_process');
      const mode = process.env.SMOKE_FIXTURE_MODE;
      const profile = process.env.REL_AI_ELECTRON_DEV_USER_DATA;
      const helper = spawn(process.execPath, ['-e', ${JSON.stringify(helperCode)}],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let releasing = false;
      helper.on('exit', () => process.exit(releasing ? 0 : 42));
      process.on('SIGTERM', () => {
        if (mode === 'ignore-term') return;
        if (mode === 'orphan') process.exit(0);
        setTimeout(() => { releasing = true; helper.send('stop'); }, 100);
      });
      helper.once('message', () => {
        fs.writeFileSync(path.join(profile, 'helper-pid'), String(helper.pid));
        fs.writeFileSync(path.join(profile, 'desktop-smoke-ready.json'), JSON.stringify({
          ready: true, rendererCount: 1, pid: process.pid, nonce: process.env.REL_AI_DESKTOP_SMOKE_NONCE
        }));
      });
    `;
    for (const mode of ['healthy', 'orphan', 'ignore-term']) {
      const stateDirectory = path.join(root, mode);
      const options = { executable: process.execPath, argv: ['-e', fixtureCode], stateDirectory,
        env: { ...process.env, SMOKE_FIXTURE_MODE: mode }, timeoutMs: 3000, stableMs: 10, shutdownMs: 1000 };
      if (mode === 'healthy') {
        assert.equal((await smokeDesktopLifecycle(options)).shutdownClean, true,
          'the main process must finish its async shutdown before helpers are terminated');
      } else {
        await assert.rejects(smokeDesktopLifecycle(options), /did not finish its intentional shutdown/,
          'an exited main process or forced group cleanup must not count as a clean shutdown');
      }
      const [run] = fs.readdirSync(stateDirectory);
      const helperPid = Number(fs.readFileSync(path.join(stateDirectory, run, 'profile', 'helper-pid'), 'utf8'));
      try {
        process.kill(helperPid, 0);
        // A zombie is already terminated; its new parent is responsible for reaping.
        assert.equal(process.platform, 'linux', 'the fixture helper must not survive cleanup');
        const stat = fs.readFileSync(`/proc/${helperPid}/stat`, 'utf8');
        assert.match(stat.slice(stat.lastIndexOf(')') + 2), /^[ZX] /, 'no live helper may survive cleanup');
      } catch (error) {
        if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error;
      }
      cases.push('owned-process-' + mode);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(new URL('../electron/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.build.files.includes('desktop-smoke-readiness.js'), 'The Electron main import must ship in the application archive.');
  cases.push('packaged-readiness-module');
  const shell = fs.readFileSync(new URL('../scripts/smoke-linux-desktop.sh', import.meta.url), 'utf8');
  assert.match(shell, /node "\$script_directory\/smoke-desktop-lifecycle\.mjs"/);
  assert.doesNotMatch(shell, /wait "\$app_pid"\s+exit \$\?/);
  console.log(JSON.stringify({ passed: cases, nativeLinuxPackageAcceptance: 'not run' }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
