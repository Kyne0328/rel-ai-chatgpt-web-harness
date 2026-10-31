import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flushLocalAnalytics } from '../src/localAnalytics.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-dashboard-actions-cutover-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'index.js'), 'export const ready = true;\n');
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
  name: 'dashboard-validation-fixture',
  version: '1.0.0',
  type: 'module',
  scripts: { test: 'node --check index.js' }
}, null, 2));
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    repo: {
      path: workspace,
      commands: {},
      testCommands: { test: 'node --check index.js' }
    }
  }
}, null, 2));

const previousConfig = process.env.REL_AI_MCP_CONFIG;
const previousState = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_STATE_DIR = stateDir;

try {
  const { handleTaskControl, handleWorkspaceChecks } = await import('../src/http/dashboardActions.ts');
  const { callTool } = await import('../src/tools.js');
  const req = Readable.from([Buffer.from(JSON.stringify({ workspace: 'repo' }))]);
  req.headers = { 'content-type': 'application/json' };
  const response = responseRecorder();
  await handleWorkspaceChecks({
    req,
    res: response.res,
    ae: '',
    options: { maxBodyBytes: 1024 * 1024 }
  });
  const result = response.json();
  assert.equal(response.status(), 200);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.completionKnown, true);
  assert.equal(result.validationStatus, 'passed');
  assert.match(result.work_id || '', /^[0-9a-f-]{36}$/i);
  assert.match(result.summary || '', /Dashboard validation completed for repo/);

  const activeTask = await callTool('relai_work', { mode: 'normal',
    action: 'begin', workspace: 'repo', bootstrap: 'none', title: 'Dashboard cancellation fixture'
  }, { publicHttpOnly: false });
  const cancelReq = Readable.from([Buffer.from(JSON.stringify({ action: 'cancel', work_id: activeTask.work_id }))]);
  cancelReq.headers = { 'content-type': 'application/json' };
  const cancelResponse = responseRecorder();
  await handleTaskControl({
    req: cancelReq,
    res: cancelResponse.res,
    ae: '',
    options: { maxBodyBytes: 1024 * 1024 }
  });
  const cancelled = cancelResponse.json();
  assert.equal(cancelResponse.status(), 200);
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(cancelled.status, 'cancelled', 'dashboard task control may commit immediately when no owned operation or fallback work remains to drain');
  const committedCancellation = await callTool('relai_work', {
    action: 'cancel', workspace: 'repo', work_id: activeTask.work_id, reason: 'Verify dashboard cancellation committed.'
  }, { publicHttpOnly: false });
  assert.equal(committedCancellation.status, 'cancelled');
  assert.equal(committedCancellation.duplicate, true);

  const { createLocalAdminPolicy } = await import('../src/mcp/authorizationPolicy.ts');
  const { principalFingerprint } = await import('../src/mcp/principal.ts');
  const { readTaskHistorySessionRecord } = await import('../src/taskHistoryStore.ts');
  const clientPrincipal = {
    clientId: 'dashboard-control-client',
    subject: 'task-owner',
    authMode: 'oauth',
    authorizationPolicy: createLocalAdminPolicy()
  };
  const clientTask = await callTool('relai_work', { mode: 'goal',
    action: 'begin', workspace: 'repo', bootstrap: 'none', title: 'Client-owned dashboard cancellation fixture',
    objective: 'Verify Goal Mode stop is separate from task cancellation', goal: true
  }, { principal: clientPrincipal, publicHttpOnly: false });
  await assert.rejects(
    () => callTool('relai_work', { action: 'cancel', work_id: clientTask.work_id }, { publicHttpOnly: false }),
    error => error?.code === 'TASK_NOT_FOUND',
    'ordinary local tool calls must retain principal ownership checks'
  );
  await assert.rejects(
    () => callTool('relai_work', { action: 'cancel', work_id: clientTask.work_id }, {
      principal: { ...clientPrincipal, subject: 'different-owner' },
      publicHttpOnly: false,
      trustedLocalTaskControl: true
    }),
    error => error?.code === 'TASK_NOT_FOUND',
    'a different MCP client must not use dashboard control authority'
  );
  const { dashboardGoalStatus } = await import('../src/chatgptGoalMode.js');
  const { dashboardTaskSession } = await import('../src/core/dashboard-runtime.ts');
  assert.equal(dashboardGoalStatus({ stateDir }, clientTask.work_id)?.goalActive, true);
  assert.equal(dashboardTaskSession(clientTask.work_id)?.session?.goalMode?.goalActive, true,
    'selected task detail must expose whether Goal Mode is active');
  assert.equal(dashboardTaskSession(clientTask.work_id, { activityOnly: true })?.goalMode?.goalActive, true,
    'lightweight task activity must carry Goal Mode state for the task inspector');
  const goalStopReq = Readable.from([Buffer.from(JSON.stringify({ action: 'goal_stop', work_id: clientTask.work_id }))]);
  goalStopReq.headers = { 'content-type': 'application/json' };
  const goalStopResponse = responseRecorder();
  await handleTaskControl({ req: goalStopReq, res: goalStopResponse.res, options: { maxBodyBytes: 1024 * 1024 } });
  assert.equal(goalStopResponse.status(), 200);
  assert.equal(goalStopResponse.json().goalActive, false);
  assert.equal(goalStopResponse.json().state, 'stopped');
  assert.equal(dashboardTaskSession(clientTask.work_id)?.session?.goalMode?.goalActive, false);
  assert.equal(dashboardTaskSession(clientTask.work_id, { activityOnly: true })?.goalMode?.goalActive, false,
    'lightweight task activity must reflect a stopped Goal Mode');
  const ownerGoal = await callTool('relai_work', { action: 'goal_status', work_id: clientTask.work_id },
    { principal: clientPrincipal, publicHttpOnly: false });
  assert.equal(ownerGoal.state, 'stopped', 'the original MCP owner must still inspect Goal Mode');
  assert.notEqual(readTaskHistorySessionRecord({ stateDir }, clientTask.work_id)?.status, 'cancelled',
    'Stop Goal must not cancel the underlying task');

  const stopReq = Readable.from([Buffer.from(JSON.stringify({ action: 'stop', work_id: clientTask.work_id }))]);
  stopReq.headers = { 'content-type': 'application/json' };
  const stopResponse = responseRecorder();
  await handleTaskControl({
    req: stopReq,
    res: stopResponse.res,
    ae: '',
    options: { maxBodyBytes: 1024 * 1024 }
  });
  assert.equal(stopResponse.json().ok, true, JSON.stringify(stopResponse.json()));
  const clientCancelReq = Readable.from([Buffer.from(JSON.stringify({ action: 'cancel', work_id: clientTask.work_id }))]);
  clientCancelReq.headers = { 'content-type': 'application/json' };
  const clientCancelResponse = responseRecorder();
  await handleTaskControl({
    req: clientCancelReq,
    res: clientCancelResponse.res,
    ae: '',
    options: { maxBodyBytes: 1024 * 1024 }
  });
  const clientCancelled = clientCancelResponse.json();
  assert.equal(clientCancelled.ok, true, JSON.stringify(clientCancelled));
  assert.equal(clientCancelled.status, 'cancelled');
  assert.equal(
    readTaskHistorySessionRecord({ stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') }, clientTask.work_id)?.principalFingerprint,
    principalFingerprint(clientPrincipal),
    'dashboard cancellation must preserve the task owner'
  );
  const ownerRetry = await callTool('relai_work', {
    action: 'cancel', work_id: clientTask.work_id
  }, { principal: clientPrincipal, publicHttpOnly: false });
  assert.equal(ownerRetry.duplicate, true, 'the original client must retain access to its cancelled task');

  const linkingTask = await callTool('relai_work', { mode: 'goal', action: 'begin', workspace: 'repo',
    title: 'Link recovery', objective: 'Verify exact chat recovery', goal: true },
  { principal: clientPrincipal, publicHttpOnly: false });
  const linkingRequest = Readable.from([Buffer.from(JSON.stringify({ action: 'goal_retry_link',
    work_id: linkingTask.work_id, conversationUrl: 'https://chatgpt.com/c/b5b9731a-8496-4a92-9b44-55d080038c7d' }))]);
  linkingRequest.headers = { 'content-type': 'application/json' };
  const linkingResponse = responseRecorder();
  await handleTaskControl({ req: linkingRequest, res: linkingResponse.res, options: { maxBodyBytes: 4096 } });
  assert.equal(linkingResponse.json().ok, false);
  assert.equal(linkingResponse.json().error, 'Unknown task control action.');
  const linkingStatus = await callTool('relai_work', { action: 'goal_status', work_id: linkingTask.work_id },
    { principal: clientPrincipal, publicHttpOnly: false });
  assert.equal(linkingStatus.continuationCount, 0, 'a removed action must not send a continuation');
  assert.equal(linkingStatus.conversationId, null, 'a removed action cannot choose a chat');
  assert.equal(linkingStatus.chatLink.state, 'finding_chat', 'linking remains automatic');
  assert.equal(readTaskHistorySessionRecord({ stateDir }, linkingTask.work_id).principalFingerprint,
    principalFingerprint(clientPrincipal), 'link recovery must preserve the original task owner');

  const adapterSource = fs.readFileSync(new URL('../src/http/dashboardActions.ts', import.meta.url), 'utf8');
  const coreSource = fs.readFileSync(new URL('../src/core/dashboard-actions.ts', import.meta.url), 'utf8');
  assert.match(adapterSource, /runWorkspaceValidation\(workspace\)/, 'HTTP must delegate validation to the Core operation');
  assert.doesNotMatch(adapterSource, /callTool\(/, 'HTTP must not own tool orchestration after the Core cutover');
  assert.doesNotMatch(coreSource, /callTool\('relai_run_checks'/);
  assert.match(coreSource, /callTool\('relai_work'/);
  assert.match(coreSource, /callTool\('relai_validate'/);
  console.log('Dashboard validation delegates to the Core begin/validate workflow after the hard cutover.');
} finally {
  await flushLocalAnalytics();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  if (previousState == null) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousState;
  cleanupTempDirectory(temp);
}

function cleanupTempDirectory(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    process.once('exit', () => {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    });
  }
}

function responseRecorder() {
  let statusCode = 0;
  let body = Buffer.alloc(0);
  const headers = new Map();
  const res = {
    headersSent: false,
    destroyed: false,
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    writeHead(status, values = {}) {
      statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value);
    },
    end(value = Buffer.alloc(0)) { body = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); }
  };
  return {
    res,
    status: () => statusCode,
    json: () => JSON.parse(body.toString('utf8'))
  };
}
