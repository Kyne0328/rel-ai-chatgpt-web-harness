import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { fallbackExecutionStatus, fallbackSignature, resetFallbackExecutions, startFallbackExecution } from '../src/mcp/fallbackExecutions.js';
import { handleTransportFallbackRequest } from '../src/mcp/transportFallback.ts';
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { MCP_PROTOCOL_VERSION } from '../src/mcp/protocol.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { callTool as rawCallTool } from '../src/tools.js';
import { getToolActivity, resetToolActivity } from '../src/toolActivity.js';
import { relaiStatus } from '../src/tools/status.js';
import { runWorkspaceOperation } from '../src/workspaceOperationQueue.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-work-stop-fallback-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'work-stop-fallback-fixture' }));
fs.writeFileSync(configPath, JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

const context = { principal: 'local:trusted', publicHttpOnly: true, requestId: 'work-stop-fallback' };
const callTool = (name, args) => rawCallTool(name, args, context);

try {
  resetToolActivity();
  resetFallbackExecutions();

  // Exercise the generator, not just response compaction: a byte cap must not
  // cause compact status to gather repository or command-discovery state.
  const statusConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const detail of [undefined, 'compact']) {
    const generated = await relaiStatus(statusConfig, {
      workspace: 'app', maxBytes: 10000, ...(detail ? { detail } : {})
    }, { connector: true, principal: 'local:trusted' });
    assert.deepEqual(generated.workspace, { alias: 'app' }, 'compact status with maxBytes must stay on the cheap generation path');
  }
  const generatedFull = await relaiStatus(statusConfig, {
    workspace: 'app', detail: 'full', maxBytes: 10000
  }, { connector: true, principal: 'local:trusted' });
  assert.ok(Array.isArray(generatedFull.workspace.discoveredCommandKeys), 'explicit full status still gathers repository diagnostics');

  const task = await callTool('relai_work', {
    action: 'begin',
    workspace: 'app',
    bootstrap: 'none',
    title: 'Stop detached fallback'
  });

  let fallbackAbortObserved = false;
  const fallback = startFallbackExecution({
    config: { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') },
    workId: task.work_id,
    tool: 'relai_validate',
    workspace: 'app',
    signature: 'work-stop-fallback',
    run: signal => new Promise(resolve => {
      const finish = () => {
        fallbackAbortObserved = true;
        resolve({ isError: true, structuredContent: { ok: false, cancelled: true } });
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    })
  });

  let siblingAbortObserved = false;
  const sibling = startFallbackExecution({
    config: { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') },
    workId: task.work_id, tool: 'relai_exec', workspace: 'app', signature: 'work-stop-sibling',
    run: signal => new Promise(resolve => {
      const finish = () => {
        siblingAbortObserved = true;
        resolve({ isError: true, structuredContent: { ok: false, cancelled: true } });
      };
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    })
  });
  const status = await callTool('relai_work', { action: 'status', work_id: task.work_id });
  assert.deepEqual(new Set(status.backgroundOperations.map(operation => operation.operationId)), new Set([fallback.record.operationId, sibling.record.operationId]));
  await assert.rejects(
    callTool('relai_work', { action: 'finish', work_id: task.work_id, summary: 'Must wait for both operations.' }),
    { code: 'TASK_COMPLETION_IN_PROGRESS' },
    'task completion must include detached operations even before they acquire a tool activity lane'
  );

  const stoppedOne = await callTool('relai_work', {
    action: 'stop', work_id: task.work_id, operationId: fallback.record.operationId
  });
  assert.deepEqual(stoppedOne.stoppedOperationIds, [fallback.record.operationId]);
  await fallback.record.promise;
  assert.equal(fallbackExecutionStatus(sibling.record.operationId).status, 'running');

  const stopped = await callTool('relai_work', {
    action: 'stop',
    workspace: 'app',
    work_id: task.work_id,
    reason: 'Stop all finite running operations.'
  });

  assert.equal(stopped.duplicate, false);
  assert.equal(stopped.stoppedOperationCount, 1, 'stop-all must count a detached fallback operation it actually stopped');
  assert.deepEqual(stopped.stoppedOperationIds, [sibling.record.operationId]);
  assert.equal(fallbackAbortObserved, true);
  assert.equal(siblingAbortObserved, true);
  assert.notEqual(stopped.status, 'cancelled', 'stopping detached finite work must keep the logical task open');

  await fallback.record.promise;
  await sibling.record.promise;

  const cancelled = await callTool('relai_work', {
    action: 'cancel',
    workspace: 'app',
    work_id: task.work_id,
    reason: 'Stop-all fallback regression complete.'
  });
  assert.equal(cancelled.status, 'cancelled');

  const queueTask = await callTool('relai_work', { action: 'begin', workspace: 'app', bootstrap: 'none', title: 'Same-task resource queue' });
  const startedPath = path.join(workspace, 'queue-started');
  const releasePath = path.join(workspace, 'queue-release');
  const donePath = path.join(workspace, 'queue-done');
  const firstArgs = {
    work_id: queueTask.work_id, workspace: 'app', executable: process.execPath,
    argv: ['-e', "const fs=require('node:fs');fs.writeFileSync(process.argv[1],'started');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);fs.writeFileSync(process.argv[3],'done')}},10)", startedPath, releasePath, donePath],
    timeoutMs: 5000
  };
  const secondArgs = {
    work_id: queueTask.work_id, workspace: 'app', executable: process.execPath,
    argv: ['-e', "if(!require('node:fs').existsSync(process.argv[1]))process.exit(2);console.log('queued command completed')", donePath],
    timeoutMs: 5000
  };
  const queueConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const submit = (id, args) => handleTransportFallbackRequest(queueConfig, {
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'relai_exec', arguments: args,
      _meta: { [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} }
    }
  }, { principal: 'local:trusted', transportType: 'test', publicHttpOnly: true, synchronousFallback: false, synchronousFallbackGraceMs: 0 });
  const firstAccepted = await submit('queue-first', firstArgs);
  const secondAccepted = await submit('queue-second', secondArgs);
  assert.equal(firstAccepted.body.result.structuredContent.status, 'running', JSON.stringify(firstAccepted.body.result.structuredContent));
  assert.equal(secondAccepted.body.result.structuredContent.status, 'running', JSON.stringify(secondAccepted.body.result.structuredContent));
  const firstId = firstAccepted.body.result.structuredContent.operationId;
  const secondId = secondAccepted.body.result.structuredContent.operationId;
  assert.notEqual(firstId, secondId, 'transport responses must identify their own operations rather than the latest operation in the task');
  const deadline = Date.now() + 4000;
  while ((!fs.existsSync(startedPath) || fallbackExecutionStatus(secondId)?.phase !== 'queued') && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(startedPath), true, 'first real command must start');
  assert.equal(fallbackExecutionStatus(secondId).phase, 'queued', 'conflicting second command must wait in the resource queue');
  const activeQueueTask = getToolActivity().tasks.find(task => task.id === queueTask.work_id);
  const activeOperationIds = activeQueueTask.currentOperations.map(operation => operation.id || operation.operationId);
  assert.deepEqual(new Set(activeOperationIds), new Set([firstId, secondId]), 'live activity and background control must use the same operation identities');
  const retried = await submit('queue-first-retry', firstArgs);
  assert.equal(retried.body.result.structuredContent.operationId, firstId);
  const records = [firstArgs, secondArgs].map(args => startFallbackExecution({
    config: queueConfig, workId: queueTask.work_id, tool: 'relai_exec', workspace: 'app',
    signature: fallbackSignature('relai_exec', args), run: () => { throw new Error('Queued command duplicated'); }
  }));
  fs.writeFileSync(releasePath, 'release');
  await Promise.all(records.map(record => record.record.promise));
  assert.equal(fallbackExecutionStatus(firstId).result.exitCode, 0);
  assert.equal(fallbackExecutionStatus(secondId).result.exitCode, 0, 'queued command must start automatically after the first command releases its resource lock');
  const queueStatus = await callTool('relai_work', { action: 'status', work_id: queueTask.work_id });
  assert.equal(queueStatus.backgroundOperations.length, 2);
  const finishedQueue = await callTool('relai_work', { action: 'finish', work_id: queueTask.work_id, summary: 'Both queued commands completed.' });
  assert.equal(finishedQueue.completionKnown, true);

  // Hold a writer without creating a running fallback record. Compact status
  // must remain responsive for missing, unknown, and terminal operation IDs.
  let releaseStatusWriter;
  let statusWriterAdmitted;
  const statusWriterReady = new Promise(resolve => { statusWriterAdmitted = resolve; });
  const statusWriter = runWorkspaceOperation('app', async () => {
    statusWriterAdmitted();
    await new Promise(resolve => { releaseStatusWriter = resolve; });
  }, { mode: 'write', scope: 'workspace' });
  await statusWriterReady;
  const pendingStatuses = [];
  try {
    for (const args of [
      {},
      { detail: 'compact', maxBytes: 10000 },
      { operationId: 'fallback_unknown_status_fixture_12345' },
      { operationId: firstId },
      { operationId: fallback.record.operationId }
    ]) {
      let timer;
      const statusRequest = callTool('relai_work', { action: 'status', workspace: 'app', ...args });
      pendingStatuses.push(statusRequest);
      try {
        const result = await Promise.race([
          statusRequest,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Compact status queued behind the held workspace writer.')), 5000);
          })
        ]);
        assert.equal(result.ok, true);
        if (args.operationId === firstId) assert.equal(result.backgroundOperation.status, 'completed');
        if (args.operationId === fallback.record.operationId) assert.equal(result.backgroundOperation.status, 'cancelled');
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } finally {
    releaseStatusWriter();
    await statusWriter;
    await Promise.allSettled(pendingStatuses);
  }
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  await repositoryIntelligence.shutdown();
  resetFallbackExecutions();
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  await fs.promises.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log('Same-task background commands keep exact identities, queue conflicting resources, finish automatically, and support scoped stop and completion.');
