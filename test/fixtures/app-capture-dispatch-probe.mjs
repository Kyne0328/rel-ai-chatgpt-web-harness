// Actual manager + public action resolver + Windows helper transport.
// Only the fresh fixture's explicit HWND is discovered or captured.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { runComputerAction } from '../../src/computerManager.js';
import { createWindowsUiaAdapter } from '../../src/computer/windowsUiaAdapter.ts';
import { resolveToolOperation } from '../../src/tools/actionCatalog.js';

export async function runOwnedDispatchAcceptance(root, scratch) {
  const started = Date.now();
  const readyPath = path.join(scratch, 'dispatch-ready.json');
  const stopPath = path.join(scratch, 'dispatch-stop');
  const output = path.join(scratch, 'dispatch-owned-windows.json');
  const fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-File',
    path.join(root, 'test/fixtures/app-capture-probe.ps1'), '-OutputPath', output,
    '-DispatchReadyPath', readyPath, '-DispatchStopPath', stopPath], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  fixture.stdout.on('data', value => { stdout = (stdout + value).slice(-8000); });
  fixture.stderr.on('data', value => { stderr = (stderr + value).slice(-8000); });
  const fixtureExit = new Promise(resolve => { fixture.once('exit', (code, signal) => resolve({ code, signal })); fixture.once('error', error => resolve({ error: error.message })); });
  const helpers = [];
  const semantic = createWindowsUiaAdapter({ platform: 'win32', spawnProcess(...args) { const child = spawn(...args); helpers.push(child); return child; } });
  const computer = { engine: 'actual-native-window-bridge',
    screenshotApp: (app, display, options) => semantic.screenshotApp(app, display, options) };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('Owned dispatch acceptance deadline exceeded.')), 15_000);
  const workspace = { alias: 'owned-native-fixture' };
  const config = { computerControl: { enabled: true } };
  const context = { computerAdapter: computer, semanticAdapter: semantic, signal: controller.signal,
    conversationId: 'owned-native-dispatch-' + fixture.pid, principal: 'owned-native-dispatch-' + fixture.pid };
  const receipt = { publicActionResolver: true, manager: true, realHelperTransport: true, osInput: false };
  const dispatch = args => {
    const resolved = resolveToolOperation('relai_computer', { workspace: workspace.alias, ...args });
    return runComputerAction(workspace, config, resolved.operationArgs, context);
  };
  let failure;
  try {
    while (!fs.existsSync(readyPath)) {
      controller.signal.throwIfAborted();
      if (fixture.exitCode !== null || fixture.signalCode !== null) throw new Error('Owned window fixture exited before ready: ' + stderr);
      await delay(20, undefined, { signal: controller.signal });
    }
    const owned = JSON.parse(fs.readFileSync(readyPath, 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(owned.processId, fixture.pid);
    receipt.owned = owned;
    await dispatch({ action: 'approve_app', app: owned.app });
    const captureStarted = Date.now();
    const image = await dispatch({ action: 'screenshot', app: owned.app, windowId: owned.windowId, windowTitle: owned.title, profile: 'detail', forceImage: true });
    assert.equal(image.capture.windowId, owned.windowId);
    assert.equal(image.capture.processId, owned.processId);
    assert.equal(image.capture.targetIdentity.windowId, owned.windowId);
    assert.equal(image.engine, image.capture.method);
    const pixels = await sharp(Buffer.from(image.image.data, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgb = (x, y) => [...pixels.data.subarray((y * pixels.info.width + x) * pixels.info.channels, (y * pixels.info.width + x) * pixels.info.channels + 3)];
    assert.deepEqual(rgb(160, 90), [210, 20, 30]);
    assert.deepEqual(rgb(310, 170), [25, 40, 220]);
    receipt.capture = { method: image.engine, durationMs: Date.now() - captureStarted, width: pixels.info.width, height: pixels.info.height, centerRgb: rgb(160, 90), markerRgb: rgb(310, 170) };
    await assert.rejects(() => dispatch({ action: 'screenshot', app: owned.app, windowId: owned.windowId, windowTitle: 'not-the-owned-fixture-title' }), error => error.code === 'COMPUTER_APP_TARGET_STALE');
    receipt.wrongTitleRejected = true;
    const aliasImage = await dispatch({ action: 'screenshot', app: 'Windows PowerShell', windowId: owned.windowId, profile: 'detail', forceImage: true });
    assert.equal(aliasImage.capture.processId, owned.processId);
    receipt.approvedCanonicalAlias = true;
    const observation = await dispatch({ action: 'observe', app: owned.app, windowId: owned.windowId, perception: 'hybrid', maxElements: 120 });
    assert.equal(observation.ocrAvailable, true, 'Native OCR must actually be available for this acceptance');
    const text = (observation.elements || []).filter(element => element.source === 'ocr').map(element => element.name).join(' ');
    assert.match(text, /APPONLY/);
    assert.doesNotMatch(text, /OTHERONLY/);
    assert.equal(observation.capture.windowId, owned.windowId);
    receipt.ocr = { text, method: observation.capture.method, processId: observation.capture.processId };
  } catch (error) { failure = error; receipt.error = error.stack || error.message; }
  finally {
    clearTimeout(deadline);
    try { await semantic.shutdown(); } catch (error) { failure ||= error; receipt.shutdownError = error.message; }
    receipt.helpers = helpers.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, exitConfirmed: child.exitCode !== null || child.signalCode !== null }));
    fs.writeFileSync(stopPath, 'stop owned fixture');
    const exited = await Promise.race([fixtureExit, delay(2500).then(() => null)]);
    if (!exited) { fixture.kill('SIGKILL'); await fixtureExit; failure ||= new Error('Owned fixture did not close gracefully.'); }
    receipt.fixtureExit = exited;
    receipt.cleanup = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '')).cleanup : [];
    receipt.durationMs = Date.now() - started;
    receipt.stderr = stderr; receipt.stdout = stdout;
    fs.writeFileSync(path.join(scratch, 'dispatch-result.json'), JSON.stringify(receipt, null, 2));
  }
  assert.ok(receipt.helpers.length > 0 && receipt.helpers.every(child => child.exitConfirmed), 'Every actual helper must confirm exit');
  assert.equal(receipt.cleanup.length, 2);
  assert.ok(receipt.cleanup.every(item => item.destroyed), 'Both fixture HWNDs must be destroyed');
  if (failure) throw failure;
  return receipt;
}
