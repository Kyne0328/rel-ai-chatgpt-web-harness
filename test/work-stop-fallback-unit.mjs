import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { resetFallbackExecutions, startFallbackExecution } from '../src/mcp/fallbackExecutions.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { callTool as rawCallTool } from '../src/tools.js';
import { resetToolActivity } from '../src/toolActivity.js';

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

  const stopped = await callTool('relai_work', {
    action: 'stop',
    workspace: 'app',
    work_id: task.work_id,
    reason: 'Stop all finite running operations.'
  });

  assert.equal(stopped.duplicate, false);
  assert.equal(stopped.stoppedOperationCount, 1, 'stop-all must count a detached fallback operation it actually stopped');
  assert.deepEqual(stopped.stoppedOperationIds, [fallback.record.operationId]);
  assert.equal(fallbackAbortObserved, true);
  assert.notEqual(stopped.status, 'cancelled', 'stopping detached finite work must keep the logical task open');

  await fallback.record.promise;

  const cancelled = await callTool('relai_work', {
    action: 'cancel',
    workspace: 'app',
    work_id: task.work_id,
    reason: 'Stop-all fallback regression complete.'
  });
  assert.equal(cancelled.status, 'cancelled');
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

console.log('relai_work stop reports detached finite fallback work and keeps the task open.');
