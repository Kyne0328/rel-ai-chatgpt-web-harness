import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../src/httpServer.ts';
import { beginConnectorToolCall, requestCurrentTaskCancellation, resetToolActivity, runWithToolActivity } from '../src/toolActivity.js';
import { runUiAction, stopAllUiSessions } from '../src/webAutomationManager.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-web-automation-'));
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previous = {
  config: process.env.REL_AI_MCP_CONFIG,
  state: process.env.REL_AI_MCP_STATE_DIR,
  isolated: process.env.REL_AI_MCP_ISOLATED
};
let taskId = '';
const dashboardToken = 'web-automation-dashboard-token';
const workspace = { alias: 'rel-ai-mcp', path: root };
let server;
let sessionId = '';

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    'rel-ai-mcp': { path: root, commands: {}, testCommands: {} }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_STATE_DIR = stateDir;
process.env.REL_AI_MCP_ISOLATED = '1';

try {
  server = startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token: dashboardToken,
    allowNoAuth: true,
    isolated: true,
    writeProfile: false,
    exitOnError: false
  });
  if (!server.listening) await once(server, 'listening');
  server.unref();
  const address = server.address();
  assert.ok(address && typeof address === 'object' && address.port > 0);

  resetToolActivity();
  const beginTask = beginConnectorToolCall({
    tool: 'relai_work', internalOperation: 'work.begin', workspace: 'rel-ai-mcp', createTask: true,
    title: 'Web automation cleanup acceptance'
  });
  taskId = beginTask.taskId;
  beginTask({ ok: true });

  const preCancelledTaskId = `${taskId}-pre-cancelled`;
  const preCancelledController = new AbortController();
  preCancelledController.abort();
  await assert.rejects(
    () => runUiAction(workspace, {}, {
      action: 'start',
      port: address.port,
      route: '/',
      work_id: preCancelledTaskId
    }, { taskId: preCancelledTaskId, publicHttpOnly: true, signal: preCancelledController.signal }),
    error => error?.code === 'UI_OPERATION_CANCELLED'
  );

  const raceTaskId = `${taskId}-race`;
  const raceContext = { taskId: raceTaskId, publicHttpOnly: true };
  const raceArgs = {
    action: 'start',
    port: address.port,
    route: `/dashboard?token=${encodeURIComponent(dashboardToken)}`,
    work_id: raceTaskId
  };
  const raceResults = await Promise.allSettled([
    runUiAction(workspace, {}, raceArgs, raceContext),
    runUiAction(workspace, {}, raceArgs, raceContext)
  ]);
  assert.equal(raceResults.filter(result => result.status === 'fulfilled').length, 1,
    'concurrent starts for one work session must create exactly one UI session');
  assert.equal(raceResults.filter(result => result.status === 'rejected' && result.reason?.code === 'UI_SESSION_ALREADY_ACTIVE').length, 1,
    'the racing UI start must be rejected while the first session is still starting');
  const racedSession = raceResults.find(result => result.status === 'fulfilled')?.value;
  assert.ok(racedSession?.sessionId);
  await runUiAction(workspace, {}, { action: 'stop', sessionId: racedSession.sessionId, work_id: raceTaskId }, raceContext);

  const context = { taskId, publicHttpOnly: true };
  const started = await runUiAction(workspace, {}, {
    action: 'start',
    port: address.port,
    route: `/dashboard?token=${encodeURIComponent(dashboardToken)}`,
    width: 1280,
    height: 800,
    work_id: taskId
  }, context);
  sessionId = started.sessionId;
  assert.equal(started.ok, true);
  assert.equal(started.statusCode, 200);
  assert.equal(started.browserEngine, 'chromium');
  assert.equal(started.url.includes('/dashboard'), true);
  assert.equal(started.url.includes(dashboardToken), false, 'UI automation results must not echo dashboard bootstrap credentials');
  assert.deepEqual(started.viewport, { width: 1280, height: 800 });

  const snapshot = await runUiAction(workspace, {}, {
    action: 'snapshot', sessionId, work_id: taskId
  }, context);
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.snapshot, /Rel\.AI|Home|Workspace/i);

  const screenshot = await runUiAction(workspace, {}, {
    action: 'screenshot', sessionId, work_id: taskId
  }, context);
  assert.equal(screenshot.image.mimeType, 'image/png');
  assert.ok(screenshot.image.bytes > 1000);
  const imageBytes = Buffer.from(screenshot.image.data, 'base64');
  assert.equal(imageBytes.subarray(1, 4).toString('ascii'), 'PNG');

  const openedSettings = await runUiAction(workspace, {}, {
    action: 'interact',
    sessionId,
    interaction: 'click',
    target: { by: 'role', value: 'link', name: 'Settings', exact: true },
    work_id: taskId
  }, context);
  assert.equal(openedSettings.ok, true);
  assert.equal(openedSettings.interaction, 'click');

  const navigated = await runUiAction(workspace, {}, {
    action: 'navigate',
    sessionId,
    route: '/dashboard#settings',
    work_id: taskId
  }, context);
  assert.equal(navigated.ok, true);
  assert.match(navigated.url, /#settings$/);

  await runUiAction(workspace, {}, {
    action: 'viewport', sessionId, width: 390, height: 844, work_id: taskId
  }, context);
  const mobileScreenshot = await runUiAction(workspace, {}, {
    action: 'screenshot', sessionId, work_id: taskId
  }, context);
  assert.deepEqual(mobileScreenshot.viewport, { width: 390, height: 844 });

  const consoleResult = await runUiAction(workspace, {}, {
    action: 'console', sessionId, maxEntries: 50, work_id: taskId
  }, context);
  assert.ok(Array.isArray(consoleResult.consoleEntries));

  const networkResult = await runUiAction(workspace, {}, {
    action: 'network', sessionId, maxEntries: 50, work_id: taskId
  }, context);
  assert.ok(Array.isArray(networkResult.networkEntries));
  assert.equal(networkResult.networkEntries.some(entry => /https?:\/\/(?!127\.0\.0\.1|localhost|\[?::1\]?)/i.test(entry.url || '') && entry.type !== 'blocked'), false);

  const cancelTask = beginConnectorToolCall({
    tool: 'relai_work', internalOperation: 'work.cancel', workspace: 'rel-ai-mcp', taskId
  });
  const cancelled = runWithToolActivity(cancelTask, () => requestCurrentTaskCancellation({
    reason: 'Verify task-owned UI session cleanup.', initiator: 'test'
  }));
  cancelTask({ ok: true });
  assert.equal(cancelled.status, 'cancelled');
  await assert.rejects(
    () => runUiAction(workspace, {}, { action: 'snapshot', sessionId, work_id: taskId }, context),
    error => error?.code === 'UI_SESSION_NOT_FOUND'
  );
  sessionId = '';
  console.log(`Rel.AI dashboard web automation passed with ${started.browserProduct}.`);
} finally {
  await stopAllUiSessions().catch(() => {});
  resetToolActivity();
  if (server?.listening) {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
    await server.waitForShutdown?.();
  }
  restoreEnv('REL_AI_MCP_CONFIG', previous.config);
  restoreEnv('REL_AI_MCP_STATE_DIR', previous.state);
  restoreEnv('REL_AI_MCP_ISOLATED', previous.isolated);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(0);

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
