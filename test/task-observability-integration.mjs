import { callTool as rawCallTool } from "../src/tools.js";
import { flushAuditWrites } from '../src/audit.js';
import { flushLocalAnalytics } from '../src/localAnalytics.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence, readTaskHistorySession } from "../src/taskHistoryStore.ts";
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { resetToolActivity } from '../src/toolActivity.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });

async function readCompletedSession(config, taskId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const session = readTaskHistorySession(config, taskId);
    if (session?.status === 'completed' && session.progress?.mode === 'complete') return session;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return readTaskHistorySession(config, taskId);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-observability-integration-'));
const workspacePath = path.join(sandbox, 'repo');
const stateDir = path.join(sandbox, 'state');
const configPath = path.join(sandbox, 'config.json');
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({ name: 'fixture' }, null, 2));
fs.writeFileSync(path.join(workspacePath, 'src.txt'), 'session activity model\n');
const skillDir = path.join(workspacePath, '.agents', 'skills', 'session-review');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: session-review\ndescription: Review session activity persistence.\n---\n\nReview persisted session behavior.\n');
execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspacePath });
execFileSync('git', ['add', '.'], { cwd: workspacePath });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspacePath, stdio: 'ignore' });
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { repo: { path: workspacePath } }
}, null, 2));

const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  const context = { publicHttpOnly: true, requestId: 'request-1', serverInstanceId: 'server-1', transportType: 'streamable-http', conversationId: 'task-observability-chat' };

  const taskArgs = {
    action: 'begin',
    workspace: 'repo',
    title: 'Inspect session activity model',
    objective: 'Verify canonical task and activity persistence.'
  };
  const started = await callTool('relai_work', taskArgs, context);
  assert.ok(started.work_id);
  assert.equal(started.title, 'Inspect session activity model');
  const duplicateStart = await callTool('relai_work', taskArgs, { ...context, requestId: 'request-duplicate-start' });
  assert.equal(duplicateStart.work_id, started.work_id, 'same-conversation retries of the same active goal must reuse the existing logical task');

  const read = await callTool('relai_read', {
    workspace: 'repo',
    work_id: started.work_id,
    paths: ['package.json', 'src.txt']
  }, { ...context, requestId: 'request-2' });
  assert.equal(read.ok, true);

  const status = await callTool('relai_work', {
    action: 'status',
    workspace: 'repo',
    work_id: started.work_id
  }, { ...context, requestId: 'request-3' });
  assert.equal(status.task?.current?.tool, 'relai_read', 'status must observe rather than overwrite the preceding task activity');
  assert.equal(status.task?.recentEvidence?.at(-1)?.tool, 'relai_read', 'status recovery must include persisted recent task activity');
  assert.match(status.task?.recentEvidence?.at(-1)?.summary || '', /Read/i);

  await callTool('relai_work', { action: 'finish',
    workspace: 'repo',
    work_id: started.work_id,
    summary: 'Inspected and verified session activity persistence.'
  }, { ...context, requestId: 'request-4' });

  const historyConfig = { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl') };
  const session = await readCompletedSession(historyConfig, started.work_id);
  assert.equal(session.title, 'Inspect session activity model');
  assert.equal(session.objective, 'Verify canonical task and activity persistence.');
  assert.equal(session.status, 'completed');
  assert.equal(session.progress.mode, 'complete');
  assert.equal(session.progress.percentage, 100);
  assert.equal(session.toolCallCount, 4);
  assert.equal(session.failedToolCallCount, 0);
  assert.equal(session.resultSummary, 'Inspected and verified session activity persistence.');
  assert.equal(session.correlation.requestId, 'request-1');
  assert.equal(session.correlation.workspaceId, 'repo');
  assert.equal(session.correlation.conversationId, 'task-observability-chat');
  assert.equal(session.events.length, 4, 'one canonical lifecycle event must be persisted per tool call without creating a duplicate logical task');
  assert.deepEqual(session.events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.equal(session.events.every(event => event.taskId === started.work_id && event.sessionId === started.work_id), true);
  assert.equal(session.events.find(event => event.tool?.name === 'relai_read')?.result?.affectedItemCount, 2);
  assert.equal(session.events.at(-1)?.status, 'succeeded');
  assert.match(session.events[0]?.summary, /Started logical task/);

  await flushTaskHistoryPersistence();
  const contextual = await callTool('relai_work', {
    action: 'begin',
    workspace: 'repo',
    title: 'Review session persistence',
    objective: 'Review canonical session activity persistence.'
  }, { ...context, requestId: 'request-5' });
  const loadedContext = await callTool('relai_work', { action: 'context', work_id: contextual.work_id }, { ...context, requestId: 'request-context' });
  assert.equal(loadedContext.bootstrap?.suggestedSkills?.[0]?.name, 'session-review', 'relai_work context must expose the relevant discovered skill');
  assert.match(loadedContext.bootstrap?.relatedTasks?.[0]?.outcome || '', /Inspected and verified session activity persistence/i, 'relai_work context must expose relevant completed task context');
  await callTool('relai_work', {
    action: 'finish',
    workspace: 'repo',
    work_id: contextual.work_id,
    summary: 'Verified contextual bootstrap retrieval.'
  }, { ...context, requestId: 'request-6' });
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  await repositoryIntelligence.shutdown();
  resetTaskHistoryCaches();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

console.log('End-to-end tool execution persists canonical task and activity lifecycle records.');
