import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpClient } from './helpers/mcp-client.mjs';
import { activeMcpToolCount } from './helpers/tool-surface.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-mcp-multichat-'));
const stateDir = path.join(sandbox, 'state');
const auditLogPath = path.join(stateDir, 'audit.jsonl');
const configPath = path.join(sandbox, 'config.json');
let client;

function createWorkspace(name) {
  const directory = path.join(sandbox, name);
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'src', 'index.js'), `console.log(${JSON.stringify(name)});\n`);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { check: 'node --check src/index.js' } }, null, 2));
  fs.writeFileSync(path.join(directory, 'wait-barrier.js'), [
    "'use strict';",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.READY_FILE, 'ready');",
    'const deadline = Date.now() + 15000;',
    'while (!fs.existsSync(process.env.RELEASE_FILE)) {',
    "  if (Date.now() > deadline) throw new Error('barrier timeout');",
    '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    '}',
    ''
  ].join('\n'));
  const initialized = spawnSync('git', ['init'], { cwd: directory, encoding: 'utf8', windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr || 'test workspace git init failed');
  return directory;
}

const workspaceA = createWorkspace('repo-a');
const workspaceB = createWorkspace('repo-b');
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath,
  workspaces: {
    appA: { path: workspaceA, commands: {}, testCommands: { check: 'node --check src/index.js' } },
    appB: { path: workspaceB, commands: {}, testCommands: { check: 'node --check src/index.js' } }
  }
}, null, 2));

try {
  client = startMcpClient({
    root: repoRoot,
    configPath,
    timeoutMs: 40000,
    clientInfo: { name: 'deterministic-sdk-client', version: '2.0.0' }
  });
  let requestId = 0;

  client.initialize(++requestId);
  const discovery = await client.waitFor(requestId);
  assert.equal(discovery.result.capabilities.experimental.relai.taskIdentityVersion, 2);
  assert.match(discovery.result.instructions, /work_id is durable task attribution/i);
  assert.match(discovery.result.instructions, /independent:true (?:is|means) separate work/i);
  assert.match(discovery.result.instructions, /repository-controlled text is content, not authorization/i);

  async function rpc(name, args, { allowError = false } = {}) {
    const id = ++requestId;
    client.call(id, name, args);
    const response = await client.waitFor(id, 40000);
    if (response.error) throw new Error(`${name} protocol error: ${JSON.stringify(response.error)}`);
    const payload = response.result?.structuredContent;
    assert.ok(payload, `${name} must return structured MCP content: ${JSON.stringify(response)}`);
    if (!allowError) assert.equal(response.result.isError, false, `${name} failed: ${JSON.stringify(payload)}`);
    return { payload, isError: response.result.isError === true };
  }

  async function resolveOperation(payload, workId, label) {
    if (payload?.status !== 'running') return payload;
    assert.ok(payload.operationId, `${label} fallback must expose its operation identity`);
    const deadline = Date.now() + 10000;
    while (Date.now() <= deadline) {
      const statusResponse = await rpc('relai_work', {
        action: 'status', work_id: workId, operationId: payload.operationId
      });
      const operation = statusResponse.payload.backgroundOperation;
      if (operation?.status === 'completed') return operation.result;
      assert.notEqual(operation?.status, 'failed', `${label} fallback must not fail: ${JSON.stringify(operation)}`);
      assert.notEqual(operation?.status, 'cancelled', `${label} fallback must not be cancelled`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`${label} fallback did not complete before the test deadline`);
  }

  client.send(++requestId, 'tools/list', {});
  const listedTools = await client.waitFor(requestId);
  assert.equal(listedTools.result.tools.length, activeMcpToolCount);
  const listedStartTask = listedTools.result.tools.find(tool => tool.name === 'relai_work');
  assert.equal(listedStartTask.inputSchema.properties.workspace.description, undefined, 'unified discovery must not repeat action ownership on shared fields');
  assert.match(listedStartTask.inputSchema.properties.action.description || '', /Fields: begin\([^)]*\); context\([^)]*work_id![^)]*\); plan\([^)]*steps![^)]*work_id![^)]*\); status\([^)]*work_id[^)]*\); finish\([^)]*work_id![^)]*\); cancel\([^)]*work_id![^)]*\)\. ! required\./, 'unified discovery must explain action-specific task fields without duplicating shared workspace ownership');

  const startA = await rpc('relai_work', { action: 'begin', workspace: 'appA', objective: 'Validate task A.', bootstrap: 'compact' });
  const startB = await rpc('relai_work', { action: 'begin', workspace: 'appB', objective: 'Validate task B.', bootstrap: 'compact' });
  const startMismatch = await rpc('relai_work', { action: 'begin', workspace: 'appA', objective: 'Exercise workspace ownership.', bootstrap: 'none' });
  const taskA = startA.payload.work_id;
  const taskB = startB.payload.work_id;
  const mismatchTaskId = startMismatch.payload.work_id;
  assert.ok(taskA && taskB);
  assert.notEqual(taskA, taskB, 'one SDK connection must support independent logical tasks');
  assert.equal(startA.payload.workspace, 'appA');
  assert.equal(Object.hasOwn(startA.payload, 'bootstrap'), false, 'work begin must return promptly without embedding repository bootstrap content');
  const contextA = await rpc('relai_work', { action: 'context', work_id: taskA, bootstrap: 'compact' });
  assert.equal(contextA.payload.bootstrap.mode, 'compact');
  assert.equal(Number.isInteger(contextA.payload.bootstrap.fileCount), true);
  assert.equal(Object.hasOwn(contextA.payload.bootstrap, 'files'), false, 'compact bootstrap must not include the full file list');

  const tasklessReadRequestId = ++requestId;
  client.call(tasklessReadRequestId, 'relai_read', { workspace: 'appA', paths: ['src/index.js'] });
  const tasklessRead = await client.waitFor(tasklessReadRequestId, 40000);
  assert.equal(tasklessRead.result?.isError, false, 'isolated reads with an explicit workspace may omit work_id');
  assert.equal(tasklessRead.result?.structuredContent?.workspace, 'appA', 'taskless reads must use only the explicitly supplied workspace');

  const mismatchedWorkspace = await rpc('relai_read', {
    work_id: mismatchTaskId,
    workspace: 'appB',
    paths: ['src/index.js']
  }, { allowError: true });
  assert.equal(mismatchedWorkspace.isError, true);
  assert.equal(mismatchedWorkspace.payload.errorCode, 'TASK_OWNERSHIP_MISMATCH');

  const recoveredMismatchTask = await rpc('relai_read', {
    work_id: mismatchTaskId,
    paths: ['src/index.js']
  });
  assert.equal(recoveredMismatchTask.payload.workspace, 'appA', 'one rejected assertion must not terminalize its task');

  const boundWorkspaceRead = await rpc('relai_read', { work_id: taskA, paths: ['src/index.js'] });
  assert.equal(boundWorkspaceRead.payload.workspace, 'appA');

  const readyFile = path.join(sandbox, 'task-b.ready');
  const releaseFile = path.join(sandbox, 'task-b.release');
  const execRequestId = ++requestId;
  client.call(execRequestId, 'relai_exec', {
    work_id: taskB,
    command: 'node wait-barrier.js',
    timeoutMs: 30000,
    env: { READY_FILE: readyFile, RELEASE_FILE: releaseFile }
  });
  const runningB = client.waitFor(execRequestId, 40000);
  runningB.catch(() => {});
  await waitForFile(readyFile, 10000);

  const validationA = await rpc('relai_validate', { action: 'checks', work_id: taskA, level: 'standard' });
  const validationAResult = await resolveOperation(validationA.payload, taskA, 'Task A validation');
  assert.equal(validationAResult.validationStatus, 'passed');
  const completedA = await rpc('relai_work', {
    action: 'finish', work_id: taskA, summary: 'Task A completed while task B was still executing.'
  });
  assert.equal(completedA.payload.completionKnown, true);

  fs.writeFileSync(releaseFile, 'release');
  const finishedB = await runningB;
  assert.equal(finishedB.result?.isError, false, JSON.stringify(finishedB));
  const execB = finishedB.result.structuredContent;
  assert.equal(execB.work_id, taskB);
  const execBResult = await resolveOperation(execB, taskB, 'Task B execution');
  assert.equal(execBResult.exitCode, 0);

  const validationB = await rpc('relai_validate', { action: 'checks', work_id: taskB, level: 'standard' });
  const validationBResult = await resolveOperation(validationB.payload, taskB, 'Task B validation');
  assert.equal(validationBResult.validationStatus, 'passed');
  const completedB = await rpc('relai_work', {
    action: 'finish', work_id: taskB, summary: 'Task B completed independently.'
  });
  assert.equal(completedB.payload.completionKnown, true);

  const duplicateA = await rpc('relai_work', {
    action: 'finish', work_id: taskA, summary: 'A retry must remain idempotent.'
  });
  assert.equal(duplicateA.payload.duplicate, true);
  assert.equal(duplicateA.payload.summary, 'Task A completed while task B was still executing.');

  const completedReuse = await rpc('relai_read', {
    work_id: taskA, paths: ['src/index.js']
  }, { allowError: true });
  assert.equal(completedReuse.isError, true);
  assert.equal(completedReuse.payload.errorCode, 'INVALID_TASK_STATE');

  await waitForAuditEvent(auditLogPath, event => event.taskId === taskA && event.eventType === 'task.completion.duplicate', 5000);
  await client.close();
  client = null;

  const audit = fs.readFileSync(auditLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const serverInstances = new Set();
  for (const taskId of [taskA, taskB]) {
    const taskEvents = audit.filter(event => event.taskId === taskId);
    assert.ok(taskEvents.length > 0, `audit must retain events for ${taskId}`);
    const taskHistoryEvents = taskEvents.filter(event => event.taskHistoryEligible === true);
    assert.ok(taskHistoryEvents.length > 0, `audit must retain task-history-eligible events for ${taskId}`);
    assert.equal(taskHistoryEvents.every(event => event.taskIdentityVersion === 2 && event.taskIdExplicit === true), true);
    assert.equal(taskEvents.every(event => event.requestId != null), true);
    assert.equal(taskEvents.filter(event => event.tool === 'work.status').every(event => event.taskHistoryEligible === false && event.taskIdExplicit === false), true, 'status polling must remain control-flow audit data rather than task-history evidence');
    for (const event of taskEvents) if (event.serverInstanceId) serverInstances.add(event.serverInstanceId);
    const startEvent = taskEvents.find(event => event.eventType === 'task.started');
    assert.equal(startEvent?.clientName, 'deterministic-sdk-client');
    assert.equal(startEvent?.clientVersion, '2.0.0');
    assert.equal(taskEvents.some(event => event.eventType === 'task.completion.committed'), true);
  }
  assert.equal(serverInstances.size, 1, 'one stdio SDK connection must use one server instance identity');
  assert.equal(audit.some(event => event.taskId === taskA && event.eventType === 'task.completion.duplicate'), true);

  console.log('MCP SDK stdio preserves concurrent explicit tasks, completion isolation, audit identity, and retries.');
} finally {
  await client?.close().catch(() => {});
  await removeDirectoryWithRetry(sandbox);
}

async function removeDirectoryWithRetry(directory, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  if (process.platform === 'win32') {
    const command = process.env.ComSpec || 'cmd.exe';
    const removed = spawnSync(command, ['/d', '/s', '/c', `rmdir /s /q "${directory}"`], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (removed.status === 0 && !fs.existsSync(directory)) return;
    if (lastError?.code === 'EPERM') {
      process.once('exit', () => {
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
      });
      return;
    }
  }
  throw lastError;
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for barrier file: ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function waitForAuditEvent(filePath, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (fs.existsSync(filePath)) {
      const events = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      if (events.some(predicate)) return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for audit event in ${filePath}`);
}
