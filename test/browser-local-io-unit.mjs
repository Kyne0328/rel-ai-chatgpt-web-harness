import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { createBrowserRuntime } from '../src/browser/browserRuntime.ts';
import {
  browserProfileDirectory,
  clearPersistentBrowserProfiles,
  persistentBrowserProfileRoot
} from '../src/browser/browserProfile.ts';
import { principalFingerprint } from '../src/mcp/principal.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-browser-local-io-'));
const primary = path.join(temp, 'downloads-workspace');
const uploadSource = path.join(temp, 'upload-source');
const outside = path.join(temp, 'outside');
const stateDir = path.join(temp, 'state');
fs.mkdirSync(primary, { recursive: true });
fs.mkdirSync(uploadSource, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(uploadSource, 'invoice.pdf'), 'authorized invoice');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');

const workspace = { alias: 'files', path: primary, sourcePaths: [primary, uploadSource] };
const principal = { clientId: 'browser-io-test', subject: 'user-a', authMode: 'test' };
const task = { taskId: 'work_browser_io_a', principal };
const fake = createFakeBrowserHarness();
const runtime = createBrowserRuntime({
  launch: fake.launch,
  getProfileConfig: () => ({ stateDir })
});

try {
  const started = await runtime.start(workspace, { url: 'http://127.0.0.1:3000/', work_id: task.taskId }, task);
  assert.equal(started.profile, 'persistent', 'local browser sessions must reuse the principal-isolated Rel.AI profile by default');
  assert.ok(
    fake.state.launchOptions.at(-1).profileDirectory.startsWith(persistentBrowserProfileRoot({ stateDir })),
    'the default persistent browser must use Rel.AI-owned profile storage rather than an external Chrome profile'
  );
  const sessionId = started.sessionId;

  const uploaded = await runtime.upload(workspace, {
    sessionId,
    path: 'source:2/invoice.pdf',
    target: { by: 'label', value: 'Invoice' },
    work_id: task.taskId
  }, task);
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.path, 'source:2/invoice.pdf');
  assert.equal(uploaded.bytes, Buffer.byteLength('authorized invoice'));
  assert.equal(fake.state.uploadPaths.at(-1), path.join(uploadSource, 'invoice.pdf'));

  const uploadCalls = fake.state.uploadPaths.length;
  await assert.rejects(
    () => runtime.upload(workspace, {
      sessionId,
      path: '../outside/secret.txt',
      target: { by: 'label', value: 'Invoice' },
      work_id: task.taskId
    }, task),
    /traversal|relative|workspace/i
  );
  assert.equal(fake.state.uploadPaths.length, uploadCalls, 'unauthorized upload must fail before browser file assignment');

  fake.state.failUpload = true;
  await assert.rejects(
    () => runtime.upload(workspace, {
      sessionId,
      path: 'source:2/invoice.pdf',
      target: { by: 'label', value: 'Invoice' },
      work_id: task.taskId
    }, task),
    /simulated upload failure/
  );
  fake.state.failUpload = false;
  assert.equal(fs.readFileSync(path.join(uploadSource, 'invoice.pdf'), 'utf8'), 'authorized invoice');

  fake.state.downloadMode = 'success';
  fake.state.downloadBytes = Buffer.from('generated report');
  const downloaded = await runtime.download(workspace, {
    sessionId,
    path: 'reports/report.txt',
    interaction: 'click',
    target: { by: 'role', value: 'link', name: 'Download report' },
    work_id: task.taskId
  }, task);
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.path, 'reports/report.txt');
  assert.equal(downloaded.suggestedFilename, 'server-report.txt');
  assert.equal(fs.readFileSync(path.join(primary, 'reports', 'report.txt'), 'utf8'), 'generated report');
  assert.equal(downloaded.bytes, Buffer.byteLength('generated report'));
  assert.match(downloaded.sha256, /^[a-f0-9]{64}$/);

  const beginDownloads = fake.state.beginDownloadCount;
  await assert.rejects(
    () => runtime.download(workspace, {
      sessionId,
      path: 'reports/report.txt',
      interaction: 'click',
      target: { by: 'text', value: 'Download report' },
      work_id: task.taskId
    }, task),
    /already exists/i
  );
  assert.equal(fake.state.beginDownloadCount, beginDownloads, 'duplicate destination must fail before browser download starts');
  assert.equal(fs.readFileSync(path.join(primary, 'reports', 'report.txt'), 'utf8'), 'generated report');

  await assert.rejects(
    () => runtime.download(workspace, {
      sessionId,
      path: '../escape.txt',
      interaction: 'click',
      target: { by: 'text', value: 'Download report' },
      work_id: task.taskId
    }, task),
    /traversal|relative|workspace/i
  );
  assert.equal(fs.existsSync(path.join(temp, 'escape.txt')), false);

  fake.state.downloadMode = 'pending';
  const cancel = new AbortController();
  const cancelled = runtime.download(workspace, {
    sessionId,
    path: 'reports/cancelled.txt',
    interaction: 'click',
    target: { by: 'text', value: 'Download slow report' },
    work_id: task.taskId
  }, task, { signal: cancel.signal });
  setImmediate(() => cancel.abort(new Error('cancel browser download')));
  await assert.rejects(cancelled, error => error?.code === 'BROWSER_OPERATION_CANCELLED');
  assert.equal(fs.existsSync(path.join(primary, 'reports', 'cancelled.txt')), false);
  assert.deepEqual(findTransferTemps(primary), [], 'cancelled download must not leave transfer temp files');
  assert.ok(fake.state.downloadCancelCount >= 1);
  assert.ok(fake.state.downloadDeleteCount >= 1);

  fake.state.downloadMode = 'crash';
  await assert.rejects(
    () => runtime.download(workspace, {
      sessionId,
      path: 'reports/crashed.txt',
      interaction: 'click',
      target: { by: 'text', value: 'Download crashing report' },
      work_id: task.taskId
    }, task),
    /simulated browser download crash/
  );
  assert.equal(fs.existsSync(path.join(primary, 'reports', 'crashed.txt')), false);
  assert.deepEqual(findTransferTemps(primary), [], 'failed download must not leave transfer temp files');

  await assert.rejects(
    () => runtime.upload(workspace, {
      sessionId,
      path: 'source:2/invoice.pdf',
      target: { by: 'label', value: 'Invoice' },
      work_id: 'work_browser_io_other'
    }, { ...task, taskId: 'work_browser_io_other' }),
    error => error?.code === 'BROWSER_SESSION_TASK_MISMATCH'
  );

  await runtime.stop(workspace, { sessionId, work_id: task.taskId }, task);

  const persistentA = await runtime.start(workspace, {
    url: 'http://127.0.0.1:3000/',
    profile: 'persistent',
    work_id: 'work_profile_a'
  }, { taskId: 'work_profile_a', principal });
  assert.equal(persistentA.profile, 'persistent');
  const firstProfilePath = fake.state.launchOptions.at(-1).profileDirectory;
  assert.ok(firstProfilePath.startsWith(persistentBrowserProfileRoot({ stateDir })));

  await assert.rejects(
    () => runtime.start(workspace, {
      url: 'http://127.0.0.1:3000/',
      profile: 'persistent',
      work_id: 'work_profile_b'
    }, { taskId: 'work_profile_b', principal }),
    error => error?.code === 'BROWSER_PROFILE_ALREADY_ACTIVE'
  );
  await runtime.stop(workspace, { sessionId: persistentA.sessionId, work_id: 'work_profile_a' }, { taskId: 'work_profile_a', principal });

  const restartedHarness = createFakeBrowserHarness();
  const restartedRuntime = createBrowserRuntime({
    launch: restartedHarness.launch,
    getProfileConfig: () => ({ stateDir })
  });
  const persistentAfterRestart = await restartedRuntime.start(workspace, {
    url: 'http://127.0.0.1:3000/',
    profile: 'persistent',
    work_id: 'work_profile_after_restart'
  }, { taskId: 'work_profile_after_restart', principal });
  assert.equal(restartedHarness.state.launchOptions.at(-1).profileDirectory, firstProfilePath, 'persistent profile location must survive runtime restart');

  const otherPrincipal = { clientId: 'browser-io-test', subject: 'user-b', authMode: 'test' };
  const persistentOther = await restartedRuntime.start(workspace, {
    url: 'http://127.0.0.1:3000/',
    profile: 'persistent',
    work_id: 'work_profile_other'
  }, { taskId: 'work_profile_other', principal: otherPrincipal });
  const otherProfilePath = restartedHarness.state.launchOptions.at(-1).profileDirectory;
  assert.notEqual(otherProfilePath, firstProfilePath, 'different principals must not share browser profile storage');
  await restartedRuntime.stop(workspace, { sessionId: persistentOther.sessionId, work_id: 'work_profile_other' }, { taskId: 'work_profile_other', principal: otherPrincipal });
  await restartedRuntime.stop(workspace, { sessionId: persistentAfterRestart.sessionId, work_id: 'work_profile_after_restart' }, { taskId: 'work_profile_after_restart', principal });
  const clearedPrincipal = await restartedRuntime.clearProfile(workspace, { work_id: 'work_profile_clear' }, { taskId: 'work_profile_clear', principal });
  assert.equal(clearedPrincipal.cleared, true, 'clear_profile must remove the current authenticated client\'s saved browser state');
  assert.equal(fs.existsSync(firstProfilePath), false);
  assert.equal(fs.existsSync(otherProfilePath), true, 'clearing one authenticated client must not erase another client\'s browser profile');

  const corruptPrincipal = { clientId: 'browser-io-test', subject: 'corrupt-user', authMode: 'test' };
  const corruptPath = browserProfileDirectory({ stateDir }, principalFingerprint(corruptPrincipal));
  fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
  fs.writeFileSync(corruptPath, 'not a directory');
  const corruptionRuntime = createBrowserRuntime({ launch: fake.launch, getProfileConfig: () => ({ stateDir }) });
  await assert.rejects(
    () => corruptionRuntime.start(workspace, {
      url: 'http://127.0.0.1:3000/',
      profile: 'persistent',
      work_id: 'work_profile_corrupt'
    }, { taskId: 'work_profile_corrupt', principal: corruptPrincipal }),
    /profile path is not a directory/i
  );

  const redirectedPrincipal = { clientId: 'browser-io-test', subject: 'redirected-user', authMode: 'test' };
  const redirectedPath = browserProfileDirectory({ stateDir }, principalFingerprint(redirectedPrincipal));
  const redirectedPrincipalDirectory = path.dirname(redirectedPath);
  const redirectedTarget = path.join(outside, 'redirected-profile');
  fs.mkdirSync(redirectedTarget, { recursive: true });
  fs.symlinkSync(redirectedTarget, redirectedPrincipalDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const redirectedRuntime = createBrowserRuntime({ launch: fake.launch, getProfileConfig: () => ({ stateDir }) });
  await assert.rejects(
    () => redirectedRuntime.start(workspace, {
      url: 'http://127.0.0.1:3000/',
      profile: 'persistent',
      work_id: 'work_profile_redirected'
    }, { taskId: 'work_profile_redirected', principal: redirectedPrincipal }),
    /symbolic link|profile path/i
  );
  assert.equal(fs.existsSync(path.join(redirectedTarget, 'default')), false, 'persistent profile creation must not follow a redirected principal directory');

  const cleared = await clearPersistentBrowserProfiles({ stateDir });
  assert.equal(cleared.cleared, true);
  assert.equal(fs.existsSync(persistentBrowserProfileRoot({ stateDir })), false);

  console.log('Browser local upload/download authorization, cleanup, ownership, and persistent profile behavior passed.');
} finally {
  await runtime.shutdown().catch(() => {});
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function createFakeBrowserHarness() {
  const state = {
    launchOptions: [],
    uploadPaths: [],
    failUpload: false,
    downloadMode: 'success',
    downloadBytes: Buffer.from('download'),
    beginDownloadCount: 0,
    downloadCancelCount: 0,
    downloadDeleteCount: 0
  };

  async function launch(options = {}) {
    state.launchOptions.push({ ...options });
    let disconnected;
    return {
      browserProduct: 'Fake Local Chromium',
      async createPage() {
        let url = 'about:blank';
        let closed;
        let crashed;
        return {
          async describe() { return { url, title: 'Fake browser page' }; },
          async navigate(next) { url = next; return { url, title: 'Fake browser page', statusCode: 200 }; },
          async snapshot() { return { url, title: 'Fake browser page', snapshot: `snapshot:${url}`, truncated: false }; },
          async interact(args) { return { url, interaction: args.interaction, target: args.target }; },
          async screenshot() { return { url, image: { mimeType: 'image/png', data: 'ZmFrZQ==', bytes: 4, width: 800, height: 600 } }; },
          async upload(_args, filePath) {
            state.uploadPaths.push(filePath);
            if (state.failUpload) throw new Error('simulated upload failure');
            return { url, interaction: 'upload' };
          },
          async beginDownload() {
            state.beginDownloadCount += 1;
            let stream;
            if (state.downloadMode === 'pending') {
              let sent = false;
              stream = new Readable({
                read() {
                  if (sent) return;
                  sent = true;
                  this.push(Buffer.from('partial'));
                }
              });
            } else if (state.downloadMode === 'crash') {
              let sent = false;
              stream = new Readable({
                read() {
                  if (sent) return;
                  sent = true;
                  this.push(Buffer.from('partial'));
                  queueMicrotask(() => this.destroy(new Error('simulated browser download crash')));
                }
              });
            } else {
              stream = Readable.from([state.downloadBytes]);
            }
            return {
              suggestedFilename: '../unsafe/server-report.txt',
              async createReadStream() { return stream; },
              async cancel() {
                state.downloadCancelCount += 1;
                stream.destroy(new Error('download cancelled'));
              },
              async delete() { state.downloadDeleteCount += 1; }
            };
          },
          async close() { closed?.(); },
          onClosed(listener) { closed = listener; },
          onCrashed(listener) { crashed = listener; },
          crash() { crashed?.(); }
        };
      },
      async close() {},
      onDisconnected(listener) { disconnected = listener; },
      disconnect() { disconnected?.(); }
    };
  }

  return { state, launch };
}

function findTransferTemps(root) {
  const found = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.relai-download')) found.push(full);
    }
  }
  return found;
}
