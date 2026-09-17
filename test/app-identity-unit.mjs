import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { configureApplicationIdentity } from '../electron/app-identity.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function fakeApp() {
  const calls = [];
  return {
    calls,
    setName(name) { calls.push(['setName', name]); },
    setPath(name, value) { calls.push(['setPath', name, value]); },
    setAppUserModelId(id) { calls.push(['setAppUserModelId', id]); }
  };
}

try {
  const previousDevUserData = process.env.REL_AI_ELECTRON_DEV_USER_DATA;
  delete process.env.REL_AI_ELECTRON_DEV_USER_DATA;
  try {
    const app = fakeApp();
    configureApplicationIdentity(app);
    assert.deepEqual(app.calls[0], ['setName', 'Rel.AI MCP']);
    if (process.platform === 'win32') {
      assert.ok(app.calls.some(([method, value]) => method === 'setAppUserModelId' && value === 'com.relai.mcp'),
        'Windows builds must keep the production app user-model identity');
    }
  } finally {
    if (previousDevUserData === undefined) delete process.env.REL_AI_ELECTRON_DEV_USER_DATA;
    else process.env.REL_AI_ELECTRON_DEV_USER_DATA = previousDevUserData;
  }

  process.env.REL_AI_ELECTRON_DEV_USER_DATA = path.join('tmp', 'relai-dev-profile');
  try {
    const app = fakeApp();
    configureApplicationIdentity(app);
    assert.deepEqual(app.calls[0], ['setName', 'Rel.AI MCP Dev']);
    assert.deepEqual(app.calls.find(([method]) => method === 'setPath'),
      ['setPath', 'userData', path.resolve('tmp', 'relai-dev-profile')],
      'dev override must redirect userData to the resolved development profile');
  } finally {
    delete process.env.REL_AI_ELECTRON_DEV_USER_DATA;
  }

  assert.throws(() => configureApplicationIdentity(null), /Electron app identity access is required/);

  const main = read('electron/main.js');
  const desktopHost = read('electron/desktop-host.js');
  const electronPackage = JSON.parse(read('electron/package.json'));

  const identityCall = main.indexOf('configureApplicationIdentity(app)');
  assert.ok(identityCall >= 0, 'electron/main.js must configure the application identity explicitly');
  const guardCall = main.indexOf('updateInstallLaunchGuard(app');
  assert.ok(guardCall >= 0, 'electron/main.js must keep the update-install launch guard');
  assert.ok(identityCall < guardCall,
    'application identity (app name / userData profile) must be set before the update guard calls app.getPath, or safeStorage resolves the package-default rel-ai-mcp-launcher profile with the wrong encryption key');

  assert.match(main, /from '\.\/app-identity\.js'/, 'electron/main.js must reuse the shared identity helper');
  assert.match(desktopHost, /from '\.\/app-identity\.js'/, 'electron/desktop-host.js must reuse the shared identity helper');
  assert.doesNotMatch(desktopHost, /function configureApplicationIdentity/,
    'application identity must have a single owner so main.js and desktop-host.js cannot drift apart');
  assert.ok(electronPackage.build.files.includes('app-identity.js'),
    'packaged desktop builds must include the shared application-identity module');

  console.log('app-identity-unit: ok');
} catch (error) {
  console.error(error);
  process.exit(1);
}
