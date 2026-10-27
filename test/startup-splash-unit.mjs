import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStartupSplashManager } from '../electron/startup-splash.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rendererUrl = 'relai-app://renderer/splash.html';
const windows = [];
const sent = [];
let installed = 0;
let quitting = false;
let failure = null;

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.shown = false;
    this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.session = { protocol: {} };
    this.webContents.send = (...message) => sent.push(message);
    this.webContents.setWindowOpenHandler = handler => { this.windowOpenHandler = handler; };
    windows.push(this);
  }
  loadURL(url) { this.url = url; return failure ? Promise.reject(failure) : Promise.resolve(); }
  show() { this.shown = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  isDestroyed() { return this.destroyed; }
}

const errors = [];
const manager = createStartupSplashManager({
  BrowserWindow: FakeWindow,
  rendererUrl,
  preloadPath: 'preload.cjs',
  iconPath: 'app-icon.png',
  installProtocol: () => { installed += 1; },
  isQuitting: () => quitting,
  onError: error => errors.push(error.message)
});
const first = manager.show();
assert.equal(manager.show(), first, 'repeated start calls must reuse the splash');
assert.equal(installed, 1);
assert.equal(first.options.show, false, 'never show an unpainted splash window');
assert.equal(first.options.frame, false);
assert.equal(first.options.webPreferences.sandbox, true);
assert.equal(first.options.webPreferences.nodeIntegration, false);
assert.equal(first.options.webPreferences.contextIsolation, true);
assert.deepEqual(first.options.webPreferences.additionalArguments, ['--relai-preload-surface=splash']);
assert.equal(first.url, rendererUrl);
assert.deepEqual(first.windowOpenHandler(), { action: 'deny' });

manager.update('Starting local service…');
assert.deepEqual(sent, [], 'status must wait until splash renderer has subscribed');
first.webContents.emit('did-finish-load');
assert.deepEqual(sent.pop(), ['startup:status', 'Starting local service…']);
manager.update('Opening dashboard…');
assert.deepEqual(sent.pop(), ['startup:status', 'Opening dashboard…']);
first.emit('ready-to-show');
assert.equal(first.shown, true, 'only a painted splash becomes visible');

manager.hide();
assert.equal(first.destroyed, true);
assert.equal(manager.getWindow(), null);
const shownBefore = first.shown;
first.emit('ready-to-show');
assert.equal(first.shown, shownBefore, 'late ready event must not resurrect the splash');
assert.equal(manager.show(), windows.at(-1));
assert.equal(windows.length, 2, 'a later startup may create a new window');
const second = windows.at(-1);
manager.hide();
second.emit('ready-to-show');
assert.equal(second.shown, false, 'a dismissed splash cannot appear above the dashboard');

quitting = true;
assert.equal(manager.show(), null, 'a quit-in-progress cannot create startup UI');
quitting = false;
failure = new Error('renderer unavailable');
const failed = manager.show();
await new Promise(resolve => setImmediate(resolve));
assert.equal(failed.destroyed, true, 'renderer failure removes the splash instead of leaving a blank window');
assert.equal(manager.getWindow(), null);
assert.match(errors.at(-1), /Startup splash could not load: renderer unavailable/);

const html = fs.readFileSync(path.join(root, 'electron/renderer/splash.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'electron/renderer/splash.css'), 'utf8');
assert.match(html, /src="relai-logo\.png"/, 'splash must use the existing application logo');
assert.match(html, /role="status" aria-live="polite"/, 'current startup stage must be announced accessibly');
assert.match(css, /prefers-reduced-motion: no-preference/, 'nonessential animation must respect reduced motion');
assert.match(fs.readFileSync(path.join(root, 'electron/package.json'), 'utf8'), /"startup-splash\.js"/, 'native packaging must include splash manager');

console.log('startup splash unit tests passed');
