import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS_EXTENSION_REVISION } from '../src/mcp/protocol.js';
import { createHttpMcpSession, MCP_VERSION, postMcp } from './helpers/http-mcp.mjs';
import { activeMcpToolCount } from './helpers/tool-surface.mjs';
import { startHttpTestServer, stopHttpTestServer } from './helpers/http-test-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'native-tasks-http-token';
const extensionId = 'io.modelcontextprotocol/tasks';
const eligibleTool = 'relai_exec';
const tasksCapability = { extensions: { [extensionId]: { revision: TASKS_EXTENSION_REVISION } } };
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-native-tasks-http-'));
const workspaceDir = path.join(stateDir, 'workspace');
const configPath = path.join(stateDir, 'config.json');
fs.mkdirSync(workspaceDir, { recursive: true });
fs.writeFileSync(path.join(workspaceDir, 'package.json'), `${JSON.stringify({
  name: 'relai-native-task-fixture',
  private: true,
  type: 'module'
}, null, 2)}\n`);
fs.writeFileSync(path.join(workspaceDir, 'edit-target.txt'), 'before\n');

const config = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'config.example.json'), 'utf8'));
config.stateDir = stateDir;
config.auditLogPath = path.join(stateDir, 'audit.jsonl');
config.workspaces = { repo: { ...(config.workspaces?.myapp || {}), path: workspaceDir } };
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const { child, base } = await startHttpTestServer({ root, configPath, token, stateDir });

async function callTool(client, id, name, args, capabilities = tasksCapability) {
  return client.request('tools/call', { name, arguments: args }, { id, name, capabilities });
}

async function invokeEligible(client, id, logicalTaskId, durationMs, capabilities = tasksCapability) {
  const taskCapable = Boolean(capabilities?.extensions?.[extensionId]);
  return callTool(client, id, eligibleTool, {
    work_id: logicalTaskId,
    executable: process.execPath,
    argv: ['-e', `setTimeout(() => {}, ${durationMs})`],
    timeoutMs: taskCapable ? Math.max(15000, durationMs + 2000) : Math.max(5000, durationMs + 2000),
    maxOutputBytes: 64 * 1024
  }, capabilities);
}

async function taskRequest(client, id, method, taskId, extra = {}, capabilities = tasksCapability) {
  return client.request(method, { taskId, ...extra }, { id, name: taskId, capabilities });
}

let client = null;
try {
  client = await createHttpMcpSession(base, {
    token,
    clientName: 'native-tasks-client',
    capabilities: tasksCapability
  });
  assert.equal(client.discovery.response.headers.get('mcp-session-id'), null);
  assert.deepEqual(client.discovery.body.result?.capabilities?.extensions?.[extensionId], { revision: TASKS_EXTENSION_REVISION });
  assert.deepEqual(client.discovery.body.result?.supportedVersions, [MCP_VERSION]);

  const listed = await client.request('tools/list', {}, { id: 2, capabilities: {} });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.result?.tools?.length, activeMcpToolCount);
  assert.equal(listed.body.result.tools.some(tool => tool.name === 'relai_native_tasks_probe'), false);
  assert.equal(listed.body.result.tools.some(tool => tool.name === 'relai_operation_task_get'), false);
  assert.equal(listed.body.result.tools.some(tool => tool.name === 'relai_operation_task_cancel'), false);
  assert.equal(listed.body.result.tools.some(tool => Object.hasOwn(tool, 'execution')), false);

  const started = await callTool(client, 3, 'relai_work', {
    action: 'begin',
    workspace: 'repo',
    title: 'Native Tasks HTTP integration',
    objective: 'Verify selective native task execution and bounded synchronous fallback.',
    bootstrap: 'none'
  });
  assert.equal(started.body.result?.isError, false, JSON.stringify(started.body));
  const logicalTaskId = started.body.result?.structuredContent?.work_id;
  assert.ok(logicalTaskId);

  const editCreated = await callTool(client, 300, 'relai_edit', {
    workspace: 'repo',
    work_id: logicalTaskId,
    path: 'edit-target.txt',
    oldText: 'before',
    newText: 'after'
  });
  assert.equal(editCreated.response.status, 200, JSON.stringify(editCreated.body));
  assert.equal(editCreated.body.result?.resultType, 'task', 'task-capable clients must receive a recoverable task handle for relai_edit');
  assert.ok(editCreated.body.result?.taskId, 'recoverable relai_edit must expose its native task ID');
  let completedEditTask = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const polled = await taskRequest(client, 3000 + attempt, 'tasks/get', editCreated.body.result.taskId);
    assert.equal(polled.response.status, 200, JSON.stringify(polled.body));
    if (['completed', 'failed', 'cancelled'].includes(polled.body.result?.status)) {
      completedEditTask = polled.body.result;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(completedEditTask?.status, 'completed', JSON.stringify(completedEditTask));
  assert.equal(fs.readFileSync(path.join(workspaceDir, 'edit-target.txt'), 'utf8'), 'after\n');
  const postEditStatus = await callTool(client, 420, 'relai_work', { action: 'status', work_id: logicalTaskId }, {});
  assert.equal(postEditStatus.response.status, 200, JSON.stringify(postEditStatus.body));
  assert.equal(postEditStatus.body.result?.isError, false, JSON.stringify(postEditStatus.body));

  const fallback = await invokeEligible(client, 4, logicalTaskId, 50, {});
  assert.notEqual(fallback.body.result?.resultType, 'task');
  assert.equal(fallback.body.result?.taskId, undefined);
  assert.equal(fallback.body.result?.isError, false, JSON.stringify(fallback.body));
  assert.equal(fallback.body.result?.structuredContent?.exitCode, 0);
  assert.equal(fallback.body.result?.structuredContent?.work_id, undefined, 'routine synchronous success must not echo the caller-supplied work_id');

  const releaseFile = path.join(workspaceDir, 'release-taskless-fallback');
  const tasklessFallback = await callTool(client, 40, eligibleTool, {
    workspace: 'repo',
    executable: process.execPath,
    argv: ['-e', `const fs=require('fs');const p=${JSON.stringify(releaseFile)};const end=Date.now()+12000;(function wait(){if(fs.existsSync(p))return; if(Date.now()>end)process.exit(2); setTimeout(wait,25);})();`],
    timeoutMs: 15000,
    maxOutputBytes: 64 * 1024
  }, {});
  assert.equal(tasklessFallback.response.status, 200, JSON.stringify(tasklessFallback.body));
  assert.equal(tasklessFallback.body.result?.isError, false, JSON.stringify(tasklessFallback.body));
  assert.equal(tasklessFallback.body.result?.structuredContent?.status, 'running', JSON.stringify(tasklessFallback.body));
  const tasklessOperationId = tasklessFallback.body.result?.structuredContent?.operationId;
  assert.ok(tasklessOperationId, JSON.stringify(tasklessFallback.body));

  const concurrentRead = callTool(client, 41, 'relai_read', {
    workspace: 'repo',
    paths: ['package.json']
  }, {});
  const readBeforeRelease = await Promise.race([
    concurrentRead.then(response => ({ kind: 'response', response })),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 1500))
  ]);
  fs.writeFileSync(releaseFile, 'release\n');
  assert.equal(readBeforeRelease.kind, 'response', 'a taskless background mutation must not hold the workspace writer lock');
  assert.equal(readBeforeRelease.response.response.status, 200, JSON.stringify(readBeforeRelease.response.body));
  assert.equal(readBeforeRelease.response.body.result?.isError, false, JSON.stringify(readBeforeRelease.response.body));

  let completedTasklessFallback = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = await callTool(client, 4100 + attempt, 'relai_work', {
      action: 'status',
      workspace: 'repo',
      operationId: tasklessOperationId
    }, {});
    const operation = status.body.result?.structuredContent?.backgroundOperation;
    if (operation?.status && operation.status !== 'running') {
      completedTasklessFallback = operation;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(completedTasklessFallback?.status, 'completed', JSON.stringify(completedTasklessFallback));

  const taskCapableExec = await invokeEligible(client, 5, logicalTaskId, 100);
  assert.equal(taskCapableExec.response.status, 200, JSON.stringify(taskCapableExec.body));
  assert.equal(taskCapableExec.body.result?.resultType, 'task', 'a capable modern client must receive a task handle for long eligible work');
  assert.ok(taskCapableExec.body.result?.taskId);
  let completedTask = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const polled = await taskRequest(client, 500 + attempt, 'tasks/get', taskCapableExec.body.result.taskId);
    assert.equal(polled.response.status, 200, JSON.stringify(polled.body));
    if (['completed', 'failed', 'cancelled'].includes(polled.body.result?.status)) {
      completedTask = polled.body.result;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(completedTask, 'native task must reach a terminal state');
  assert.equal(completedTask.status, 'completed', JSON.stringify(completedTask));
  assert.equal(completedTask.result?.isError, false, JSON.stringify(completedTask));
  assert.equal(completedTask.result?.structuredContent?.exitCode, 0);
  assert.equal(completedTask.result?.structuredContent?.work_id, undefined, 'native task completion must not redundantly echo the caller-supplied work_id');
  const invalid = await taskRequest(client, 250, 'tasks/get', 'task_invalid');
  assert.equal(invalid.body.error?.code, -32602);
  assert.match(invalid.body.error?.message || '', /not available to this client/);

  const protocolTaskId = 'task_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const mismatchedHeader = await client.request('tasks/get', { taskId: protocolTaskId }, {
    id: 251,
    name: 'task_wrong_header_name_12345678901234567890123456789012',
    capabilities: tasksCapability
  });
  assert.equal(mismatchedHeader.response.status, 400);
  assert.match(mismatchedHeader.body.error?.message || '', /does not match/);

  const paramHeader = await client.request('tasks/get', { taskId: protocolTaskId }, {
    id: 252,
    capabilities: tasksCapability,
    extraHeaders: { 'mcp-param-extra': 'not-declared' }
  });
  assert.equal(paramHeader.response.status, 400);
  assert.match(paramHeader.body.error?.message || '', /not declared/);

  const legacySessionHeader = await client.request('tools/list', {}, {
    id: 253,
    sessionId: 'legacy-session-id'
  });
  assert.equal(legacySessionHeader.response.status, 400);
  assert.match(legacySessionHeader.body.error?.message || '', /Mcp-Session-Id is not supported/);

  const initializeInsideModernEnvelope = await postMcp(base, {
    id: 254,
    method: 'initialize',
    token,
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ChatGPT', version: '1' } }
  });
  assert.equal(initializeInsideModernEnvelope.response.status, 400);
  assert.equal(initializeInsideModernEnvelope.body.error?.code, -32601);
} finally {
  if (client) await client.close().catch(() => {});
  await stopHttpTestServer(child);
  fs.rmSync(stateDir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 2,
    retryDelay: 100
  });
}

console.log('MCP 2026-07-28 synchronous tool execution and Tasks protocol routing passed.');
