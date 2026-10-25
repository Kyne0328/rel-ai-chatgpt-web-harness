import assert from 'node:assert/strict';
import { beginCommandActivity } from '../src/commandActivity.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as dashboardSessions from '../src/http/dashboardSessions.ts';
import { beginConnectorToolCall, getToolActivity, resetToolActivity } from '../src/toolActivity.js';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { mcpConnectionManager } from '../src/mcp/connectionManager.js';
import { DASHBOARD_LIVE_EVENT_TYPES } from '../src/contracts/events.ts';

const dashboardSource = fs.readFileSync(new URL('../src/http/dashboard.ts', import.meta.url), 'utf8');
const dashboardCoreSource = fs.readFileSync(new URL('../src/core/dashboard-runtime.ts', import.meta.url), 'utf8');
const eventClientSource = fs.readFileSync(new URL('../src/ui/events.js', import.meta.url), 'utf8');
const dashboardClientSource = fs.readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');

assert.match(dashboardSource, /: keepalive/, 'dashboard SSE must include a heartbeat');
assert.deepEqual(DASHBOARD_LIVE_EVENT_TYPES, ['task.updated', 'connection.updated', 'workspace.updated', 'process.updated', 'diagnostics.updated', 'dashboard.error']);
assert.match(dashboardCoreSource, /DASHBOARD_LIVE_EVENTS\./, 'Core must publish through the canonical live-event contract');
assert.match(eventClientSource, /DASHBOARD_LIVE_EVENT_TYPES/, 'client must subscribe through the canonical live-event contract');
assert.doesNotMatch(dashboardSource, /dashboard\.bootstrap/, 'SSE must not rebuild the aggregate dashboard snapshot after HTML bootstrap');
assert.doesNotMatch(eventClientSource, /dashboard\.bootstrap/, 'client must not subscribe to the deleted duplicate bootstrap event');
assert.doesNotMatch(dashboardSource, /sendSse\(res, ['"]dashboard['"]/, 'legacy broad dashboard SSE events must be deleted');
assert.match(dashboardCoreSource, /createDashboardTaskEventBatcher/, 'Core task updates must be coalesced before SSE publication');
assert.doesNotMatch(dashboardSource, /DASHBOARD_SNAPSHOT_MAX_WAIT_MS|dashboardStreamPayload|requestedDashboardRevision/);
assert.doesNotMatch(eventClientSource, /_snapshotRevision|params\.set\(['"]revision['"]/, 'client must not request legacy snapshot catch-up');
assert.doesNotMatch(eventClientSource, /token|Authorization|URLSearchParams/, 'SSE authentication must rely only on the HttpOnly dashboard session cookie');
assert.doesNotMatch(dashboardClientSource, /relai_dashboard_token|setToken|getToken/, 'dashboard renderer must never persist or read the MCP bearer token');
assert.match(eventClientSource, /removeEventListener/, 'SSE listeners must be removed when a source closes');
assert.match(eventClientSource, /function parseEventData[\s\S]*try[\s\S]*JSON\.parse[\s\S]*catch/, 'SSE payload parsing must fail safely');
assert.match(dashboardCoreSource, /sink\.onError/, 'Core application failures must be projected through the typed event subscription');
assert.match(dashboardSource, /sendSse\(res, 'dashboard\.error'/, 'HTTP must frame application failures as the canonical non-reserved dashboard error event');
assert.doesNotMatch(dashboardSource, /sendSse\(res, ['"]error['"]/, 'application-side SSE failures must not trigger transport reconnect backoff');
assert.match(dashboardClientSource, /event\.type === ['"]dashboard\.error['"][\s\S]*recoverDashboard/, 'application-side SSE failures must recover with an authoritative dashboard refresh');
assert.match(dashboardClientSource, /applyLiveEvent\(event\.type, event\.data\)/, 'browser coordinator must apply typed deltas through the canonical store');
assert.match(dashboardClientSource, /liveCatchUpRequired/, 'browser coordinator must compare ready revisions and fetch only when live events were missed');
assert.doesNotMatch(dashboardClientSource, /viewRevisionKey|syncLiveView|renderViewIfChanged/, 'typed store updates must reach React without a duplicate route invalidation renderer');
assert.doesNotMatch(dashboardClientSource, /viewFingerprint|createSnapshotGate|snapshot-order/, 'legacy snapshot ordering/fingerprinting must be removed');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-dashboard-events-'));
const previousConfigPath = process.env.REL_AI_MCP_CONFIG;
const previousStateDir = process.env.REL_AI_MCP_STATE_DIR;
const configPath = path.join(sandbox, 'config.json');
const auditPath = path.join(sandbox, 'audit.jsonl');
const token = 'dashboard-live-events-token';
const desktopStatusListeners = new Set();
let desktopStatus = {
  serverRunning: true,
  tunnelStatus: 'connecting',
  mcpUrl: '',
  error: '',
  localUrl: 'http://127.0.0.1:3333'
};

function removeSandboxAfterHandlesClose() {
  const options = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 2, retryDelay: 100 };
  try {
    fs.rmSync(sandbox, options);
    return;
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  }

  const cleanupScript = `
    const fs = require('node:fs');
    const target = process.argv[1];
    let attempts = 0;
    const remove = () => {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        process.exit(0);
      } catch {
        attempts += 1;
        if (attempts >= 50) process.exit(0);
        setTimeout(remove, 100);
      }
    };
    setTimeout(remove, 100);
  `;
  const cleanup = spawn(process.execPath, ['-e', cleanupScript, sandbox], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  cleanup.unref();
}

fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir: sandbox,
  auditLogPath: auditPath,
  workspaces: {},
  productUx: { staleHours: 24, enableStateExport: true }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_STATE_DIR = sandbox;

const { startHttpServer } = await import('../src/httpServer.ts');
const server = startHttpServer({
  host: '127.0.0.1', port: 0, token, exitOnError: false,
  getDesktopStatus: () => desktopStatus,
  onDesktopStatusChange: listener => {
    desktopStatusListeners.add(listener);
    return () => desktopStatusListeners.delete(listener);
  },
  getTaskActivity: () => getToolActivity()
});
const controller = new AbortController();
let responseReader;

try {
  await waitForListening(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  const bootstrapToken = dashboardSessions.createDashboardBootstrap(token);
  const dashboardResponse = await fetch(`http://127.0.0.1:${address.port}/dashboard?surface=desktop&bootstrap=${encodeURIComponent(bootstrapToken)}`);
  assert.equal(dashboardResponse.status, 200);
  const dashboardCookie = String(dashboardResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(dashboardCookie, /^relai_dashboard_session=/);
  const html = await dashboardResponse.text();
  assert.doesNotMatch(html, /id="initialDashboardData"/, 'HTML shell must not synchronously build the aggregate dashboard snapshot');
  const initialResponse = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/v10`, {
    headers: { cookie: dashboardCookie }
  });
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  assert.equal(initial.ok, true);
  assert.ok(initial.live?.streamId, 'authoritative bootstrap fetch must carry the live stream identity');
  assert.deepEqual(Object.keys(initial.live.revisions).sort(), ['connection', 'diagnostics', 'process', 'task', 'workspace']);
  assert.ok(Array.isArray(initial.tasks));
  assert.ok(Array.isArray(initial.managedProcesses));

  const response = await fetch(`http://127.0.0.1:${address.port}/events`, {
    headers: { cookie: dashboardCookie }, signal: controller.signal
  });
  assert.equal(response.status, 200);
  responseReader = response.body.getReader();
  const stream = createEventReader(responseReader);

  const ready = JSON.parse((await stream.nextType('ready')).data);
  assert.equal(ready.ok, true);
  assert.equal(ready.streamId, initial.live.streamId, 'SSE ready must identify the same stream as the HTML bootstrap');
  assert.deepEqual(Object.keys(ready.revisions).sort(), ['connection', 'diagnostics', 'process', 'task', 'workspace']);

  const command = beginCommandActivity({ stateDir: sandbox }, { operationId: 'dashboard-command-receipt',
    workId: 'dashboard-command-task', taskTitle: 'Read project', workspace: 'test',
    args: { executable: 'node', argv: ['read.js', '--token', 'private-command-secret'] } });
  command.phase({ phase: 'spawned', executed: true });
  command.output('stdout', Buffer.from('live command stdout'));
  const processEvent = JSON.parse((await stream.nextType('process.updated')).data);
  assert.ok(processEvent.revision > ready.revisions.process);
  assert.equal(processEvent.commandOperations[0].operationId, 'dashboard-command-receipt');
  assert.equal(processEvent.commandOperations[0].status, 'running');
  assert.equal(processEvent.commandOperations[0].stdoutTail, 'live command stdout');
  assert.ok(!JSON.stringify(processEvent).includes('private-command-secret'), 'command display must redact secrets');
  const store = await import('../src/ui/store.js');
  store.init(initial);
  assert.equal(store.applyLiveEvent('process.updated', processEvent).accepted, true);
  assert.equal(store.getSnapshot().commandOperations[0].operationId, 'dashboard-command-receipt');
  const outputUrl = `http://127.0.0.1:${address.port}/api/processes/output?operationId=dashboard-command-receipt&stream=stdout`;
  assert.notEqual((await fetch(outputUrl)).status, 200, 'command output requires the existing dashboard authentication');
  const output = await (await fetch(outputUrl, { headers: { cookie: dashboardCookie } })).json();
  assert.equal(output.range.text, 'live command stdout');
  command.output('stdout', Buffer.alloc(70 * 1024, 'x'));
  const retained = await (await fetch(`${outputUrl}&offset=0&maxBytes=1024`, { headers: { cookie: dashboardCookie } })).json();
  assert.ok(retained.range.retainedFromOffset > 0, 'live output storage must remain bounded');
  assert.equal(retained.range.offset, retained.range.retainedFromOffset);
  assert.equal(retained.range.text.length, 1024);
  assert.equal(retained.range.truncatedBefore, true, 'output eviction must be disclosed');
  command.finish({ exitCode: 0, commandSucceeded: true, terminationConfirmed: true });
  const endedCommandEvent = JSON.parse((await stream.nextType('process.updated')).data);
  assert.ok(endedCommandEvent.revision > processEvent.revision);
  assert.equal(endedCommandEvent.commandOperations[0].status, 'completed');
  store.applyLiveEvent('process.updated', endedCommandEvent);
  assert.equal(store.getSnapshot().commandOperations[0].status, 'completed');
  assert.equal(store.applyLiveEvent('process.updated', processEvent).accepted, false, 'stale command events must not revive ended work');
  const commandsSnapshot = await (await fetch(`http://127.0.0.1:${address.port}/api/dashboard/v10`, { headers: { cookie: dashboardCookie } })).json();
  assert.equal(commandsSnapshot.commandOperations[0].status, 'completed', 'aggregate reconnect snapshot must agree with live command receipts');

  const recoveryId = 'proc_dashboardarchivefixture0001';
  const recoveryDirectory = path.join(sandbox, 'processes', recoveryId);
  fs.mkdirSync(recoveryDirectory, { recursive: true });
  fs.writeFileSync(path.join(recoveryDirectory, 'metadata.json'), JSON.stringify({ schemaVersion: 4,
    runtimeId: 'historical-runtime', processId: recoveryId, workspaceId: '', lifecycle: 'persistent',
    status: 'orphaned', pid: 2000000000, windowsJobOwned: true, terminationConfirmed: false,
    startedAt: new Date().toISOString(), endedAt: '', label: 'Historical recovery fixture' }));
  const manager = await import('../src/processManager.js');
  manager.readManagedProcess({ stateDir: sandbox }, { processId: recoveryId });
  await manager.initializeManagedProcessRecovery({ stateDir: sandbox });
  assert.equal(manager.readManagedProcess({ stateDir: sandbox }, { processId: recoveryId }).canArchiveRecovery, true);
  const archiveUrl = `http://127.0.0.1:${address.port}/api/processes/recovery`;
  const archiveRequest = { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ processId: recoveryId, archived: true, expectedArchivedAt: '' }) };
  assert.notEqual((await fetch(archiveUrl, archiveRequest)).status, 200, 'archival requires dashboard authentication');
  const archivedRecord = await (await fetch(archiveUrl, { ...archiveRequest, headers: { ...archiveRequest.headers, cookie: dashboardCookie } })).json();
  assert.equal(archivedRecord.ok, true);
  assert.equal(archivedRecord.status, 'orphaned');
  assert.equal(archivedRecord.terminationConfirmed, false);
  assert.ok(archivedRecord.recoveryArchivedAt);
  const restoredRecord = await (await fetch(archiveUrl, { ...archiveRequest,
    headers: { ...archiveRequest.headers, cookie: dashboardCookie },
    body: JSON.stringify({ processId: recoveryId, archived: false, expectedArchivedAt: archivedRecord.recoveryArchivedAt }) })).json();
  assert.equal(restoredRecord.ok, true);
  assert.equal(restoredRecord.recoveryArchivedAt, undefined);

  fs.appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), event: 'tool_call', tool: 'relai_read', workspace: 'test', ok: true })}\n`);
  const finishStart = beginConnectorToolCall({
    scopeId: 'dashboard-live-events-test', tool: 'relai_work', internalOperation: 'work.begin',
    operation: 'Starting dashboard test task', workspace: 'test', createTask: true,
    objective: 'Exercise typed dashboard events'
  });
  const taskId = finishStart.taskId;
  finishStart({ ok: true });

  const taskEvent = JSON.parse((await stream.nextType('task.updated')).data);
  assert.equal(taskEvent.domain, 'task');
  assert.ok(taskEvent.revision > ready.revisions.task);
  assert.ok(taskEvent.taskUpdates.some(task => task.id === taskId));
  assert.ok(Array.isArray(taskEvent.activityEntries), 'task delta must carry only changed activity entries');
  assert.equal(Object.hasOwn(taskEvent, 'release'), false, 'task delta must not rebuild unrelated release state');

  const finishObserved = beginConnectorToolCall({
    trackTask: false,
    scopeId: 'dashboard-observed-live-test',
    tool: 'relai_read',
    internalOperation: 'read',
    operation: 'Read dashboard live state',
    workspace: 'test'
  });
  const observedOperationId = finishObserved.operationId;
  finishObserved({ ok: true });
  const observedEvent = JSON.parse((await stream.nextType('task.updated')).data);
  assert.ok(observedEvent.activityEntries.some(entry => entry.eventId === observedOperationId), 'non-task tool activity must stream into Activity without waiting for a dashboard refresh');
  assert.equal(observedEvent.activityEntries.find(entry => entry.eventId === observedOperationId)?.status, 'succeeded');
  assert.equal(observedEvent.taskUpdates.length, 0, 'observed activity must not invent a task row');
  assert.equal(Object.hasOwn(taskEvent, 'tools'), false, 'task delta must not rebuild static tool data');
  assert.equal(Object.hasOwn(taskEvent, 'managedProcesses'), false, 'task delta must not include process state');

  const requestId = mcpConnectionManager.beginRequest({
    principal: 'dashboard-live-events-client', method: 'tools/list', authMode: 'static_bearer'
  });
  const connectionEvent = JSON.parse((await stream.nextType('connection.updated')).data);
  assert.equal(connectionEvent.domain, 'connection');
  assert.equal(connectionEvent.mcpConnection.activeRequestCount, 1);
  assert.equal(Object.hasOwn(connectionEvent, 'tasks'), false, 'connection delta must not include task history');
  mcpConnectionManager.finishRequest(requestId, { method: 'tools/list', ok: true });

  desktopStatus = { ...desktopStatus, tunnelStatus: 'running', tunnelId: 'tunnel_12345678' };
  for (const listener of [...desktopStatusListeners]) listener(desktopStatus);
  let desktopConnection = null;
  for (let attempt = 0; attempt < 4 && desktopConnection?.desktopStatus?.tunnelStatus !== 'running'; attempt += 1) {
    desktopConnection = JSON.parse((await stream.nextType('connection.updated')).data);
  }
  assert.equal(desktopConnection?.desktopStatus?.tunnelStatus, 'running', 'desktop tunnel status must stream without unrelated task activity');
  assert.ok(desktopConnection.revision > connectionEvent.revision, 'desktop-only tunnel changes must advance the shared connection revision instead of being deduplicated behind the MCP revision');

  const secondController = new AbortController();
  let secondReader;
  try {
    const reconnect = await fetch(`http://127.0.0.1:${address.port}/events`, {
      headers: { cookie: dashboardCookie }, signal: secondController.signal
    });
    secondReader = reconnect.body.getReader();
    const secondStream = createEventReader(secondReader);
    const reconnectReady = JSON.parse((await secondStream.nextType('ready')).data);
    assert.equal(reconnectReady.streamId, ready.streamId, 'reconnect uses the current server event stream');
    assert.ok(reconnectReady.revisions.task >= taskEvent.revision, 'ready metadata must expose revisions needed for catch-up decisions');
    const catchUpResponse = await fetch(`http://127.0.0.1:${address.port}/api/dashboard/v10?limit=100`, {
      headers: { cookie: dashboardCookie }
    });
    assert.equal(catchUpResponse.status, 200);
    const catchUp = await catchUpResponse.json();
    assert.equal(catchUp.live.streamId, reconnectReady.streamId);
    assert.ok(catchUp.tasks.some(task => task.id === taskId), 'aggregate catch-up fetch must contain the authoritative task state');
  } finally {
    secondController.abort();
    await secondReader?.cancel().catch(() => {});
  }
} finally {
  controller.abort();
  await responseReader?.cancel().catch(() => {});
  resetToolActivity();
  resetTaskHistoryCaches();
  server.closeAllConnections?.();
  await closeServer(server);
  await server.waitForShutdown?.();
  if (previousConfigPath == null) delete process.env.REL_AI_MCP_CONFIG; else process.env.REL_AI_MCP_CONFIG = previousConfigPath;
  if (previousStateDir == null) delete process.env.REL_AI_MCP_STATE_DIR; else process.env.REL_AI_MCP_STATE_DIR = previousStateDir;
  removeSandboxAfterHandlesClose();
}

console.log('Dashboard typed live events and revision-based reconnect catch-up passed.');

function createEventReader(reader) {
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async nextType(type, timeoutMs = 6000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const event = await nextEvent(deadline - Date.now());
        if (event.event === type) return event;
      }
      throw new Error(`Timed out waiting for ${type}.`);
    }
  };
  async function nextEvent(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const eventLine = block.split('\n').find(line => line.startsWith('event:')) || '';
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        return { event: eventLine.slice(6).trim(), data };
      }
      const result = await Promise.race([reader.read(), delayReject(deadline - Date.now())]);
      if (result.done) throw new Error('Dashboard SSE stream closed unexpectedly.');
      buffer += decoder.decode(result.value, { stream: true }).replaceAll('\r\n', '\n');
    }
    throw new Error('Timed out waiting for dashboard event.');
  }
}

function delayReject(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for dashboard SSE event.')), Math.max(1, ms));
    timer.unref?.();
  });
}
function waitForListening(target) {
  if (target.listening) return Promise.resolve();
  return new Promise((resolve, reject) => { target.once('listening', resolve); target.once('error', reject); });
}
function closeServer(target) {
  return new Promise(resolve => { if (!target?.listening) return resolve(); target.close(resolve); });
}
