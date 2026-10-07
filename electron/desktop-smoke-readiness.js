import fs from 'node:fs';
import path from 'node:path';

// This receipt is diagnostic-only. It grants no application capability.
export async function recordDesktopSmokeReadiness({ app, BrowserWindow, env = process.env, timeoutMs = 10000 }) {
  const nonce = String(env.REL_AI_DESKTOP_SMOKE_NONCE || '');
  if (!nonce) return false;
  if (!/^[a-f0-9]{32}$/.test(nonce) || !env.REL_AI_ELECTRON_DEV_USER_DATA
      || path.resolve(app.getPath('userData')) !== path.resolve(env.REL_AI_ELECTRON_DEV_USER_DATA)) {
    throw new Error('Desktop smoke readiness requires a unique isolated user-data directory.');
  }
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
  if (!windows.length) throw new Error('Desktop started without a renderer window.');
  await Promise.all(windows.map(window => waitForRenderer(window.webContents, timeoutMs)));
  const receipt = { ready: true, nonce, pid: process.pid, rendererCount: windows.length };
  const target = path.join(app.getPath('userData'), 'desktop-smoke-ready.json');
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
  return true;
}

function waitForRenderer(contents, timeoutMs) {
  if (contents.isDestroyed()) return Promise.reject(new Error('Desktop renderer was destroyed before readiness.'));
  if (!contents.isLoadingMainFrame() && contents.getURL() && contents.getURL() !== 'about:blank') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', loaded);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('destroyed', destroyed);
      if (error) reject(error); else resolve();
    };
    const loaded = () => finish();
    const failed = (_event, code, description, _url, mainFrame) => {
      if (mainFrame !== false) finish(new Error(`Desktop renderer failed to load (${code}): ${description}`));
    };
    const destroyed = () => finish(new Error('Desktop renderer was destroyed before readiness.'));
    const timer = setTimeout(() => finish(new Error('Desktop renderer readiness timed out.')), timeoutMs);
    contents.once('did-finish-load', loaded);
    contents.on('did-fail-load', failed);
    contents.once('destroyed', destroyed);
    if (contents.isDestroyed()) destroyed();
    else if (!contents.isLoadingMainFrame() && contents.getURL() && contents.getURL() !== 'about:blank') loaded();
  });
}
