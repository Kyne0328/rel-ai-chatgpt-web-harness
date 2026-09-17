import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultDevUserDataPath, missingElectronRuntimeFiles, shouldRestartForPath, sourceWatchTargets, watchRoots } from '../scripts/electron-dev-watch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
const desktopHostSource = fs.readFileSync(path.join(root, 'electron', 'desktop-host.js'), 'utf8');

assert.match(String(manifest.scripts['electron:dev:watch'] || ''), /electron-dev-watch\.mjs/, 'the package must expose the source dev watcher');
assert.match(String(manifest.scripts['electron:dev:watch:isolated'] || ''), /electron-dev-watch\.mjs.*--isolated/, 'the package must expose the isolated source dev watcher');
assert.deepEqual([...watchRoots], ['electron', 'src', 'public', 'bin']);
assert.equal(shouldRestartForPath('src', 'ui/features/settings/react.js'), false, 'UI source must wait for Vite output before Electron restarts');
assert.equal(shouldRestartForPath('src', 'ui/styles/app.css'), false, 'UI style source must wait for Vite output before Electron restarts');
assert.equal(shouldRestartForPath('public', 'app.js'), true);
assert.equal(shouldRestartForPath('public', 'dashboard.css'), true, 'rebuilt dashboard CSS must restart Electron after Vite finishes');
assert.equal(shouldRestartForPath('src', 'ui/react/main.js'), false, 'React source changes restart only after the generated browser bundle is ready');
assert.equal(shouldRestartForPath('public', 'dashboard-app.js'), true, 'a rebuilt production dashboard entry must restart Electron after Vite finishes');
assert.equal(shouldRestartForPath('public', 'dashboard-react.js'), true, 'a rebuilt React probe entry must restart Electron after Vite finishes');
assert.equal(shouldRestartForPath('public', 'dashboard-chunks/route-test.js'), true, 'a rebuilt lazy React chunk must restart Electron after Vite finishes');
assert.match(String(manifest.scripts['build:frontend'] || ''), /vite build/, 'the canonical production frontend build must use Vite');
assert.match(String(manifest.scripts['dev:frontend'] || ''), /\bvite\b/, 'the browser dev loop must expose the Vite HMR server');
assert.match(String(manifest.scripts['watch:frontend'] || ''), /vite build --watch/, 'the Electron dev loop must reuse Vite watch builds');
assert.equal(shouldRestartForPath('electron', 'node_modules/electron/index.js'), false);
const watchTargets = sourceWatchTargets(root);
assert.ok(watchTargets.some(target => target.rootName === 'electron' && target.recursive === false && path.resolve(target.directory) === path.join(root, 'electron')), 'the Electron package root must be watched non-recursively');
assert.ok(watchTargets.some(target => target.rootName === 'electron' && target.recursive === true && target.prefix === 'renderer/'), 'nested Electron renderer source must remain watched');
assert.equal(watchTargets.some(target => path.resolve(target.directory).startsWith(path.join(root, 'electron', 'node_modules'))), false, 'the dev watcher must never hold recursive handles inside electron/node_modules');

const incompleteElectron = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || root, 'relai-electron-runtime-'));
try {
  fs.mkdirSync(path.join(incompleteElectron, 'dist', 'resources'), { recursive: true });
  fs.writeFileSync(path.join(incompleteElectron, 'package.json'), '{}');
  fs.writeFileSync(path.join(incompleteElectron, 'path.txt'), process.platform === 'win32' ? 'electron.exe' : 'electron');
  fs.writeFileSync(path.join(incompleteElectron, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'), '');
  fs.writeFileSync(path.join(incompleteElectron, 'dist', 'resources', 'default_app.asar'), '');
  assert.deepEqual(missingElectronRuntimeFiles(incompleteElectron).map(file => path.basename(file)), ['icudtl.dat'], 'the dev watcher must reject an Electron runtime missing Chromium ICU data before launch');
} finally {
  fs.rmSync(incompleteElectron, { recursive: true, force: true });
}
assert.match(defaultDevUserDataPath('/tmp/home').replaceAll('\\', '/'), /\/tmp\/home\/\.rel-ai-mcp-dev\/electron-user-data$/);
assert.match(mainSource, /createDesktopHost/);
assert.match(desktopHostSource, /configureApplicationIdentity\(app\)/, 'the desktop host must apply the shared application identity, including the isolated dev profile');

const help = spawnSync(process.execPath, [path.join(root, 'scripts', 'electron-dev-watch.mjs'), '--help'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Runs Rel\.AI Electron directly from source/);
assert.doesNotMatch(help.stdout, /dist|electron-builder/i, 'the fast dev loop must not imply packaging');

console.log('Electron source dev watcher contracts passed.');
