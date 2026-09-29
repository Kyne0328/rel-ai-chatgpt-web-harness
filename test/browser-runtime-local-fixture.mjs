import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createBrowserRuntime } from '../src/browser/browserRuntime.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-browser-fixture-'));
const stateDir = path.join(temp, 'state');
const workspacePath = path.join(temp, 'workspace');
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'invoice.pdf'), 'fixture invoice');

const server = http.createServer((req, res) => {
  if (req.url === '/auth/login') {
    res.statusCode = 200;
    res.setHeader('set-cookie', 'relai_auth=ok; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Login complete</title><main><h1>Login complete</h1></main>');
    return;
  }
  if (req.url === '/auth/protected') {
    const authenticated = String(req.headers.cookie || '').includes('relai_auth=ok');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Protected</title><main><h1>${authenticated ? 'Authenticated session' : 'Anonymous session'}</h1></main>`);
    return;
  }
  if (req.url === '/frame-content') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Sign-in frame</title><label>Frame user <input aria-label="Frame user"></label><button type="button" onclick="document.body.dataset.saved=document.querySelector(\'[aria-label=&quot;Frame user&quot;]\').value">Frame save</button><p id="frame-result"></p><script>new MutationObserver(() => document.querySelector(\'#frame-result\').textContent = document.body.dataset.saved ? `Frame saved ${document.body.dataset.saved}` : ``).observe(document.body,{attributes:true})</script>');
    return;
  }
  if (req.url === '/download') {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="generated-report.txt"');
    res.end('generated local browser report');
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/second') {
    res.end('<!doctype html><title>Second tab</title><main><h1>Second local page</h1></main>');
    return;
  }
  res.end(`<!doctype html>
    <title>Local browser fixture</title>
    <main>
      <h1>Local browser fixture</h1>
      <label>Name <input aria-label="Name" value=""></label>
      <button type="button" id="save">Save</button>
      <p id="result" aria-live="polite">Not saved</p>
      <label>Invoice <input type="file" aria-label="Invoice"></label>
      <p id="upload-result" aria-live="polite">No upload</p>
      <a href="/download">Download report</a>
      <button type="button" id="remember">Remember profile</button>
      <p id="profile-result" aria-live="polite"></p>
      <iframe name="signin-frame" src="/frame-content" title="Sign-in frame"></iframe>
      <script>
        document.querySelector('#save').addEventListener('click', () => {
          document.querySelector('#result').textContent = 'Saved ' + document.querySelector('[aria-label="Name"]').value;
        });
        document.querySelector('[aria-label="Invoice"]').addEventListener('change', event => {
          document.querySelector('#upload-result').textContent = 'Uploaded ' + (event.target.files[0]?.name || 'nothing');
        });
        const profileResult = document.querySelector('#profile-result');
        const renderProfile = () => {
          profileResult.textContent = localStorage.getItem('relai-browser-profile') || 'Profile empty';
        };
        document.querySelector('#remember').addEventListener('click', () => {
          localStorage.setItem('relai-browser-profile', 'Remembered profile');
          renderProfile();
        });
        renderProfile();
      </script>
    </main>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
server.unref();
const address = server.address();
assert.ok(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const workspace = { alias: 'repo', path: workspacePath };
const context = { taskId: 'work_browser_fixture' };
const runtime = createBrowserRuntime({ getProfileConfig: () => ({ stateDir }) });

try {
  const started = await runtime.start(workspace, { url: origin, profile: 'ephemeral', work_id: context.taskId }, context);
  const sessionId = started.sessionId;
  assert.equal(started.ok, true);
  assert.equal(started.statusCode, 200);
  assert.equal(started.profile, 'ephemeral');
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:/);

  const initial = await runtime.snapshot(workspace, { sessionId, work_id: context.taskId }, context);
  assert.equal(initial.detail, 'semantic');
  assert.match(initial.snapshot, /Local browser fixture/);
  const layout = await runtime.snapshot(workspace, { sessionId, detail: 'layout', work_id: context.taskId }, context);
  assert.equal(layout.detail, 'layout');
  assert.match(layout.snapshot, /^viewport \d+x\d+ scroll /);
  assert.match(layout.snapshot, /input|button|main|form/);

  await runtime.interact(workspace, {
    sessionId,
    interaction: 'fill',
    target: { by: 'label', value: 'Name' },
    input: 'Rel.AI',
    work_id: context.taskId
  }, context);
  await runtime.interact(workspace, {
    sessionId,
    interaction: 'click',
    target: { by: 'role', value: 'button', name: 'Save' },
    work_id: context.taskId
  }, context);
  const after = await runtime.snapshot(workspace, { sessionId, work_id: context.taskId }, context);
  assert.match(after.snapshot, /Saved Rel\.AI/);
  assert.ok(Array.isArray(after.frames) && after.frames.some(frame => frame.name === 'signin-frame'), 'semantic browser results must expose child frame metadata');
  await runtime.interact(workspace, {
    sessionId,
    interaction: 'fill',
    target: { by: 'label', value: 'Frame user', frame: { by: 'name', value: 'signin-frame', exact: true } },
    input: 'Frame User',
    work_id: context.taskId
  }, context);
  await runtime.interact(workspace, {
    sessionId,
    interaction: 'click',
    target: { by: 'role', value: 'button', name: 'Frame save', frame: { by: 'name', value: 'signin-frame', exact: true } },
    work_id: context.taskId
  }, context);
  const afterFrame = await runtime.snapshot(workspace, { sessionId, work_id: context.taskId }, context);
  assert.match(afterFrame.snapshot, /Frame saved Frame User/, 'structured interactions must work inside a named iframe');

  const upload = await runtime.upload(workspace, {
    sessionId,
    path: 'invoice.pdf',
    target: { by: 'label', value: 'Invoice' },
    work_id: context.taskId
  }, context);
  assert.equal(upload.path, 'invoice.pdf');
  const afterUpload = await runtime.snapshot(workspace, { sessionId, work_id: context.taskId }, context);
  assert.match(afterUpload.snapshot, /Uploaded invoice\.pdf/);

  const download = await runtime.download(workspace, {
    sessionId,
    path: 'downloads/generated-report.txt',
    interaction: 'click',
    target: { by: 'role', value: 'link', name: 'Download report' },
    work_id: context.taskId
  }, context);
  assert.equal(download.suggestedFilename, 'generated-report.txt');
  assert.equal(fs.readFileSync(path.join(workspacePath, 'downloads', 'generated-report.txt'), 'utf8'), 'generated local browser report');

  const second = await runtime.openTab(workspace, { sessionId, url: `${origin}/second`, work_id: context.taskId }, context);
  assert.match(second.url, /\/second$/);
  const tabs = await runtime.listTabs(workspace, { sessionId, work_id: context.taskId }, context);
  assert.equal(tabs.count, 2);
  assert.ok(tabs.tabs.some(tab => /Second tab/.test(tab.title || '')));

  const screenshot = await runtime.screenshot(workspace, { sessionId, tabId: second.tabId, work_id: context.taskId }, context);
  assert.equal(screenshot.image.mimeType, 'image/png');
  assert.ok(screenshot.image.bytes > 1000);

  const stopped = await runtime.stop(workspace, { sessionId, work_id: context.taskId }, context);
  assert.equal(stopped.ok, true);
  assert.equal(runtime.activeSessionCount(), 0);

  const persistentPrincipal = { clientId: 'fixture-client', subject: 'fixture-user', authMode: 'test' };
  const persistentTask = { taskId: 'work_browser_profile_1', principal: persistentPrincipal };
  const persistentRuntime = createBrowserRuntime({ getProfileConfig: () => ({ stateDir }) });
  const persistent = await persistentRuntime.start(workspace, {
    url: origin,
    work_id: persistentTask.taskId
  }, persistentTask);
  assert.equal(persistent.profile, 'persistent');
  await persistentRuntime.interact(workspace, {
    sessionId: persistent.sessionId,
    interaction: 'click',
    target: { by: 'role', value: 'button', name: 'Remember profile' },
    work_id: persistentTask.taskId
  }, persistentTask);
  const remembered = await persistentRuntime.snapshot(workspace, {
    sessionId: persistent.sessionId,
    work_id: persistentTask.taskId
  }, persistentTask);
  assert.match(remembered.snapshot, /Remembered profile/);
  await persistentRuntime.navigate(workspace, {
    sessionId: persistent.sessionId,
    url: `${origin}/auth/login`,
    work_id: persistentTask.taskId
  }, persistentTask);
  await persistentRuntime.stop(workspace, {
    sessionId: persistent.sessionId,
    work_id: persistentTask.taskId
  }, persistentTask);

  const restartTask = { taskId: 'work_browser_profile_2', principal: persistentPrincipal };
  const afterRestartRuntime = createBrowserRuntime({ getProfileConfig: () => ({ stateDir }) });
  const afterRestart = await afterRestartRuntime.start(workspace, {
    url: origin,
    work_id: restartTask.taskId
  }, restartTask);
  const restored = await afterRestartRuntime.snapshot(workspace, {
    sessionId: afterRestart.sessionId,
    work_id: restartTask.taskId
  }, restartTask);
  assert.match(restored.snapshot, /Remembered profile/, 'persistent site state must survive a new Rel.AI browser runtime instance');
  const protectedPage = await afterRestartRuntime.navigate(workspace, {
    sessionId: afterRestart.sessionId,
    url: `${origin}/auth/protected`,
    work_id: restartTask.taskId
  }, restartTask);
  assert.match(protectedPage.url, /\/auth\/protected$/);
  const authenticated = await afterRestartRuntime.snapshot(workspace, {
    sessionId: afterRestart.sessionId,
    work_id: restartTask.taskId
  }, restartTask);
  assert.match(authenticated.snapshot, /Authenticated session/, 'persistent browser profiles must retain HTTP authentication cookies across runtime restart');
  await afterRestartRuntime.stop(workspace, {
    sessionId: afterRestart.sessionId,
    work_id: restartTask.taskId
  }, restartTask);

  console.log(`General local browser fixture passed upload, download, iframe interaction, and persistent cookie/profile flows with ${started.browserProduct}.`);
} finally {
  await runtime.shutdown().catch(() => {});
  server.closeAllConnections?.();
  server.close();
  await once(server, 'close');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
}
