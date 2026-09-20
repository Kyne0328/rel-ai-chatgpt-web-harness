import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildTaskContinuity } from '../src/context/taskContinuity.js';
import { ensureLearningState, knowledgeDatabasePath, learnedValidationChecks, recordTaskValidationAffinity } from '../src/knowledgeStore.js';
import { flushTaskHistoryPersistence, readTaskHistorySessionRecord } from '../src/taskHistoryStore.ts';
import { resetToolActivity } from '../src/toolActivity.js';
import { callTool as rawCallTool } from '../src/tools.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { stateExport, stateImport } from '../src/productUx.js';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-knowledge-continuity-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const previousReducedBackgroundWork = process.env.REL_AI_REDUCED_BACKGROUND_WORK;

fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
  name: 'knowledge-continuity-fixture',
  scripts: { check: 'node --check src/index.js' }
}, null, 2));
fs.writeFileSync(path.join(workspace, 'src', 'index.js'), 'export const value = 1;\n');
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspace });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });

const config = {
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  knowledge: { maxBootstrapBytes: 1024 },
  workspaces: {
    app: { path: workspace, commands: { check: 'node --check src/index.js' }, testCommands: {} }
  }
};
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_REDUCED_BACKGROUND_WORK = '1';
resetToolActivity();

try {
  const legacyConfig = { ...config, stateDir: path.join(temp, 'legacy-learning-state') };
  const legacyDbPath = knowledgeDatabasePath(legacyConfig);
  fs.mkdirSync(path.dirname(legacyDbPath), { recursive: true });
  const legacyDb = new DatabaseSync(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE knowledge_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO knowledge_meta(key,value) VALUES('schema_version','3');
    CREATE TABLE knowledge_items(id TEXT PRIMARY KEY, content TEXT NOT NULL) STRICT;
    CREATE TABLE knowledge_fts(id TEXT, content TEXT);
    CREATE TABLE validation_affinity(workspace TEXT NOT NULL, path_prefix TEXT NOT NULL, command TEXT NOT NULL, success_count INTEGER NOT NULL DEFAULT 1, last_seen_at TEXT NOT NULL, PRIMARY KEY(workspace,path_prefix,command)) WITHOUT ROWID, STRICT;
    INSERT INTO knowledge_items(id,content) VALUES('legacy-memory','removed generic memory');
  `);
  legacyDb.close();
  ensureLearningState(legacyConfig);
  const migratedDb = new DatabaseSync(legacyDbPath, { readOnly: true });
  assert.equal(migratedDb.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name IN ('knowledge_items','knowledge_fts')").get().count, 0,
    'schema v4 must hard-cut the duplicate generic Saved Memory tables');
  assert.equal(migratedDb.prepare("SELECT value FROM knowledge_meta WHERE key='schema_version'").get().value, '4');
  migratedDb.close();

  const context = { publicHttpOnly: true, conversationId: 'knowledge-continuity-chat' };
  const first = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Remember continuity marker', objective: 'Remember continuity marker',
    contextSummary: 'Host capsule alpha', bootstrap: 'compact'
  }, context);
  first.bootstrap = (await callTool('relai_work', { action: 'context', work_id: first.work_id }, context)).bootstrap;
  assert.equal(first.bootstrap.hostContextSummary, 'Host capsule alpha');
  await callTool('relai_work', { action: 'finish', workspace: 'app', work_id: first.work_id, summary: 'Continuity marker stored.' }, context);
  await flushTaskHistoryPersistence();
  const stored = readTaskHistorySessionRecord(config, first.work_id, { reconcileInactive: false });
  assert.equal(stored?.contextSummary, 'Host capsule alpha');
  assert.equal(stored?.correlation?.conversationId, 'knowledge-continuity-chat');
  const status = await callTool('relai_work', { action: 'status', workspace: 'app', work_id: first.work_id }, context);
  assert.equal(status.task?.hostContextSummary, 'Host capsule alpha');

  const second = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Continue continuity marker', objective: 'Continue continuity marker',
    contextSummary: 'Host capsule beta', bootstrap: 'compact'
  }, context);
  second.bootstrap = (await callTool('relai_work', { action: 'context', work_id: second.work_id }, context)).bootstrap;
  assert.equal(second.bootstrap.hostContextSummary, 'Host capsule beta');
  assert(second.bootstrap.conversationContinuity?.some(item => item.goal?.includes('Remember continuity marker')));
  assert(second.bootstrap.conversationContinuity?.every(item => !('workId' in item) && !('workspace' in item)));
  await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: second.work_id, reason: 'continuity regression complete' }, context);

  const retrievalSource = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Overview analytics initial mount failure',
    objective: 'Repair overview analytics initial rendering failure', bootstrap: 'none'
  }, { publicHttpOnly: true, conversationId: 'retrieval-source-chat' });
  await callTool('relai_work', {
    action: 'finish', workspace: 'app', work_id: retrievalSource.work_id,
    summary: 'Fixed the overview analytics first render so data appears without navigation.'
  }, { publicHttpOnly: true, conversationId: 'retrieval-source-chat' });
  await flushTaskHistoryPersistence();
  const retrievalConsumer = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Investigate dashboard display', objective: 'Investigate dashboard display behavior',
    contextSummary: 'The analytics panel is blank until I switch tabs.', bootstrap: 'compact'
  }, { publicHttpOnly: true, conversationId: 'retrieval-consumer-chat' });
  retrievalConsumer.bootstrap = (await callTool('relai_work', { action: 'context', work_id: retrievalConsumer.work_id }, { publicHttpOnly: true, conversationId: 'retrieval-consumer-chat' })).bootstrap;
  assert(retrievalConsumer.bootstrap?.relatedTasks?.some(item => /overview analytics/i.test(item.goal || '')),
    'task bootstrap must use host context to recall the same completed task even when title/objective wording differs');
  await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: retrievalConsumer.work_id, reason: 'retrieval bootstrap regression complete' }, { publicHttpOnly: true, conversationId: 'retrieval-consumer-chat' });

  const peerAContext = { publicHttpOnly: true, conversationId: 'peer-worker-a' };
  const peerBContext = { publicHttpOnly: true, conversationId: 'peer-worker-b' };
  const peerA = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Backend continuation worker', objective: 'Update backend continuation contract', bootstrap: 'none'
  }, peerAContext);
  const peerB = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Task UI worker', objective: 'Update task UI for continuation state', bootstrap: 'none'
  }, peerBContext);
  assert(peerB.activeRelatedWork?.some(item => item.goal?.includes('backend continuation contract')), 'a newly started peer must receive compact active sibling work');
  assert(peerB.activeRelatedWork?.every(item => !('work_id' in item) && !('principalFingerprint' in item) && !('hostContextSummary' in item)));
  const peerAStatus = await callTool('relai_work', { action: 'status', workspace: 'app', work_id: peerA.work_id }, peerAContext);
  assert(peerAStatus.activeRelatedWork?.some(item => item.goal?.includes('task UI for continuation state')), 'status must refresh active sibling work');
  await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: peerA.work_id, reason: 'peer coordination regression complete' }, peerAContext);
  await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: peerB.work_id, reason: 'peer coordination regression complete' }, peerBContext);

  const task = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Fix alpha syntax flow', objective: 'Fix alpha syntax flow safely', bootstrap: 'none'
  }, context);
  await callTool('relai_edit', {
    workspace: 'app', work_id: task.work_id, path: 'src/index.js',
    oldText: 'export const value = 1;', newText: 'export const value = 2;'
  }, context);

  const validation = await callTool('relai_validate', {
    action: 'checks', workspace: 'app', work_id: task.work_id, check: 'node --check src/index.js', complete: false
  }, context);
  assert.equal(validation.validationStatus, 'passed');

  await callTool('relai_work', { action: 'finish', workspace: 'app', work_id: task.work_id, summary: 'Updated alpha syntax flow and validated the change.' }, context);
  await flushTaskHistoryPersistence();
  const learnedChecks = learnedValidationChecks(config, 'app', ['src/index.js']);
  assert(learnedChecks.some(item => item.command === 'node --check src/index.js'), 'successful completion must retain repository-scoped validation affinity without inventing a procedure candidate');

  const portableSource = { ...config, stateDir: path.join(temp, 'portable-source') };
  const portableRestored = { ...config, stateDir: path.join(temp, 'portable-restored') };
  recordTaskValidationAffinity(portableSource, 'app', {
    changedFiles: ['src/index.js'],
    workflowEvidence: [{ kind: 'check', command: 'node --check src/index.js' }]
  }, {
    validationStatus: 'passed',
    changedFiles: ['src/index.js']
  });
  const statePayload = stateExport(portableSource).export;
  const sqliteExport = statePayload.files.find(item => item.path === 'knowledge/knowledge.sqlite');
  assert.equal(statePayload.version, 2);
  assert.equal(sqliteExport?.encoding, 'base64', 'the validation-affinity SQLite database must export losslessly');
  stateImport(portableRestored, { confirm: true, payload: statePayload });
  assert(learnedValidationChecks(portableRestored, 'app', ['src/index.js']).some(item => item.command === 'node --check src/index.js'),
    'state import must preserve validated path-to-command affinity');

  await repositoryIntelligence.ensure({ alias: 'app', path: workspace, context: {} }, config, { watch: false });
  const compactWithRepositorySummary = await callTool('relai_work', {
    action: 'begin', workspace: 'app', title: 'Inspect alpha syntax', objective: 'Inspect alpha syntax', bootstrap: 'compact'
  }, context);
  compactWithRepositorySummary.bootstrap = (await callTool('relai_work', { action: 'context', work_id: compactWithRepositorySummary.work_id }, context)).bootstrap;
  assert.equal(compactWithRepositorySummary.bootstrap?.repositoryIntelligence?.summaryOnly, true, 'compact task bootstrap must reuse the cheap cached Repository Intelligence summary when available');
  await callTool('relai_work', { action: 'cancel', workspace: 'app', work_id: compactWithRepositorySummary.work_id, reason: 'compact bootstrap regression complete' }, context);

  const continuity = buildTaskContinuity(config, { workspace: 'app', query: 'alpha syntax' });
  assert.equal(Object.hasOwn(continuity, 'relevantKnowledge'), false,
    'the removed generic Saved Memory store must not remain in task continuity');
  assert.equal(Object.hasOwn(continuity, 'suggestedProcedures'), false,
    'the removed candidate/procedure inference model must not remain in task continuity');

  console.log('Task continuity and validation-affinity regression checks passed.');
} finally {
  await flushTaskHistoryPersistence();
  await repositoryIntelligence.shutdown();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  if (previousReducedBackgroundWork == null) delete process.env.REL_AI_REDUCED_BACKGROUND_WORK;
  else process.env.REL_AI_REDUCED_BACKGROUND_WORK = previousReducedBackgroundWork;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// Nested raw tool calls can leave Windows piped stdio referenced after app resources close.
// Teardown above is complete, so exit explicitly to keep this isolated integration test deterministic.
process.exit(0);
