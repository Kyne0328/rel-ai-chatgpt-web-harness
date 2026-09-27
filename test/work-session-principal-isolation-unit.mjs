import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-work-principal-'));
const workspacePath = path.join(root, 'workspace');
const otherWorkspacePath = path.join(root, 'other-workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const auditLogPath = path.join(stateDir, 'audit.jsonl');
fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(otherWorkspacePath, { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'probe.txt'), 'principal-bound work session\n');
fs.writeFileSync(path.join(otherWorkspacePath, 'probe.txt'), 'other authorized workspace\n');
fs.writeFileSync(configPath, `${JSON.stringify({
  version: 3,
  stateDir,
  auditLogPath,
  workspaces: {
    repo: {
      path: workspacePath,
      commands: {},
      testCommands: {},
      context: { excludePaths: ['.git', 'node_modules'] }
    },
    other: {
      path: otherWorkspacePath,
      commands: {},
      testCommands: {},
      context: { excludePaths: ['.git', 'node_modules'] }
    }
  }
}, null, 2)}\n`);

const previousConfig = process.env.REL_AI_MCP_CONFIG;
const previousState = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_STATE_DIR = stateDir;

let taskHistoryStore = null;
let auditModule = null;
let repositoryIntelligenceModule = null;
let localAnalyticsModule = null;
try {
  const { callTool } = await import('../src/tools.js');
  taskHistoryStore = await import('../src/taskHistoryStore.ts');
  repositoryIntelligenceModule = await import('../src/repository/intelligence/service.js');
  localAnalyticsModule = await import('../src/localAnalytics.ts');
  auditModule = await import('../src/audit.js');
  const { readTaskHistorySession, readTaskHistorySessionRecord } = taskHistoryStore;
  const { createLocalAdminPolicy } = await import('../src/mcp/authorizationPolicy.js');
  const authorizationPolicy = createLocalAdminPolicy();
  const owner = {
    conversationId: 'work-continuity-regression',
    publicHttpOnly: true,
    transportType: 'test',
    principal: { issuer: 'https://issuer.example', clientId: 'client-a', subject: 'user-a', authMode: 'oauth', scopes: ['mcp'], authorizationPolicy }
  };
  const sameOwner = {
    ...owner,
    principal: { scopes: ['mcp'], subject: 'user-a', clientId: 'client-a', issuer: 'https://issuer.example', authMode: 'oauth', authorizationPolicy }
  };
  const otherOwner = {
    ...owner,
    principal: { issuer: 'https://issuer.example', clientId: 'client-a', subject: 'user-b', authMode: 'oauth', scopes: ['mcp'], authorizationPolicy }
  };

  const projectlessOwner = { ...sameOwner, conversationId: 'projectless-goal-regression' };
  const projectless = await callTool('relai_work', {
    action: 'begin',
    title: 'Projectless goal',
    objective: 'Track a meaningful goal before choosing a project'
  }, projectlessOwner);
  assert.ok(projectless.work_id);
  assert.equal(projectless.workspace, undefined, 'a logical goal may begin without a project');
  assert.match(projectless.nextAction, /No project is bound yet/i);
  const projectlessPlan = await callTool('relai_work', {
    action: 'plan',
    work_id: projectless.work_id,
    steps: [{ id: 'decide', title: 'Decide whether a project is needed', status: 'in_progress' }]
  }, projectlessOwner);
  assert.equal(projectlessPlan.workspace, undefined, 'planning must not force a project binding');
  assert.equal(projectlessPlan.plan.steps.length, 1);
  const projectlessFinished = await callTool('relai_work', {
    action: 'finish',
    workspace: 'repo',
    work_id: projectless.work_id,
    summary: 'Finished without needing local project access.'
  }, projectlessOwner);
  assert.equal(projectlessFinished.completionKnown, true);
  assert.equal(projectlessFinished.validationStatus, 'not_required');
  assert.equal(projectlessFinished.workspace, undefined, 'finish must not bind a projectless goal merely because a workspace argument was supplied');
  assert.equal(readTaskHistorySession({ stateDir, auditLogPath }, projectless.work_id)?.workspace || '', '', 'projectless completion must stay projectless in durable history');

  const projectlessCancelOwner = { ...sameOwner, conversationId: 'projectless-cancel-regression' };
  const projectlessCancel = await callTool('relai_work', {
    action: 'begin',
    title: 'Projectless cancel goal',
    objective: 'Cancel without ever binding a project'
  }, projectlessCancelOwner);
  await callTool('relai_work', {
    action: 'cancel',
    workspace: 'repo',
    work_id: projectlessCancel.work_id,
    reason: 'projectless cancellation regression'
  }, projectlessCancelOwner);
  assert.equal(readTaskHistorySession({ stateDir, auditLogPath }, projectlessCancel.work_id)?.workspace || '', '', 'cancel must not bind a projectless goal merely because a workspace argument was supplied');

  const { runWorkspaceOperation } = await import('../src/workspaceOperationQueue.js');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const busyWorkspace = runWorkspaceOperation('repo', async () => {
    entered.resolve();
    await release.promise;
  }, { scope: 'workspace', mode: 'write' });
  await entered.promise;
  let started;
  let deadline;
  try {
    started = await Promise.race([
      callTool('relai_work', { action: 'begin', workspace: 'repo', title: 'Principal ownership', bootstrap: 'full' }, owner),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('begin waited on an unrelated workspace operation')), 5000); })
    ]);
  } finally {
    clearTimeout(deadline);
    release.resolve();
    await busyWorkspace;
  }
  assert.ok(started.work_id);
  assert.equal(started.identity, 'work_session');
  assert.equal(started.workspace, 'repo');
  assert.equal(started.workspaceBinding, undefined, 'compact begin omits a duplicate workspace binding');
  assert.equal(started.bootstrap, undefined, 'even an explicit full bootstrap must not delay delivery of the task ID');
  assert.match(started.nextAction, /work_id.*durable plan.*multi-step tracking/i);
  const { readTaskIntegrity } = await import('../src/taskIntegrity.ts');
  assert.equal(readTaskIntegrity({ stateDir }, started.work_id).baseline.pending, true, 'begin must not wait for Git baseline probes');

  const bindingOwner = { ...sameOwner, conversationId: 'projectless-binding-regression' };
  const unbound = await callTool('relai_work', {
    action: 'begin',
    title: 'Bind project later',
    objective: 'Start projectless and bind only when repository access becomes necessary'
  }, bindingOwner);
  assert.equal(readTaskIntegrity({ stateDir }, unbound.work_id), null, 'projectless begin must not create repository integrity state');
  const boundRead = await callTool('relai_read', {
    workspace: 'repo',
    work_id: unbound.work_id,
    paths: ['probe.txt'],
    guidanceMode: 'none'
  }, bindingOwner);
  assert.equal(boundRead.items[0].content, 'principal-bound work session\n');
  assert.equal(readTaskIntegrity({ stateDir }, unbound.work_id, 'repo')?.baseline?.pending, true, 'first explicit project operation must bind the task before repository work');
  const boundSession = readTaskHistorySession({ stateDir, auditLogPath }, unbound.work_id);
  assert.equal(boundSession.workspace, 'repo', 'the first authorized project operation must persist the one-time task binding');
  const boundFinished = await callTool('relai_work', {
    action: 'finish',
    work_id: unbound.work_id,
    summary: 'Project binding verified.'
  }, bindingOwner);
  assert.equal(boundFinished.workspace, 'repo');

  const mutationOwner = { ...sameOwner, conversationId: 'projectless-mutation-binding-regression' };
  const unboundMutation = await callTool('relai_work', {
    action: 'begin',
    title: 'Bind before first mutation',
    objective: 'Prove projectless work binds before its first repository write'
  }, mutationOwner);
  assert.equal(readTaskIntegrity({ stateDir }, unboundMutation.work_id), null);
  await callTool('relai_edit', {
    workspace: 'repo',
    work_id: unboundMutation.work_id,
    path: 'projectless-mutation.txt',
    content: 'bound before write\n'
  }, mutationOwner);
  const mutationIntegrity = readTaskIntegrity({ stateDir }, unboundMutation.work_id, 'repo');
  assert.ok(mutationIntegrity, 'first explicit mutation must establish task integrity for the selected workspace');
  assert.equal(mutationIntegrity.baseline.pending, undefined, 'the repository baseline must be captured before the first projectless-task mutation');
  assert.equal(readTaskHistorySession({ stateDir, auditLogPath }, unboundMutation.work_id).workspace, 'repo');
  await assert.rejects(() => callTool('relai_read', {
    workspace: 'other',
    work_id: unboundMutation.work_id,
    paths: ['probe.txt'],
    guidanceMode: 'none'
  }, mutationOwner), error => error.code === 'TASK_OWNERSHIP_MISMATCH', 'a bound projectless task must not switch to another authorized workspace');
  await callTool('relai_work', { action: 'cancel', work_id: unboundMutation.work_id, reason: 'binding regression complete' }, mutationOwner);

  const { resetToolActivity } = await import('../src/toolActivity.js');
  await taskHistoryStore.flushTaskHistoryPersistence();
  resetToolActivity();
  const replayed = await callTool('relai_work', { action: 'begin', workspace: 'repo', title: 'Principal ownership' }, sameOwner);
  assert.equal(replayed.work_id, started.work_id, 'a lost begin response must be recoverable after live state is reset');
  const concurrent = await Promise.all([1, 2].map(() => callTool('relai_work', { action: 'begin', workspace: 'repo', title: 'Concurrent retry' }, sameOwner)));
  assert.equal(concurrent[0].work_id, concurrent[1].work_id, 'simultaneous retries must share one durable ID');
  await callTool('relai_work', { action: 'cancel', work_id: concurrent[0].work_id }, sameOwner);
  const detachedRead = await callTool('relai_read', { workspace: 'repo', paths: ['probe.txt'] }, sameOwner);
  assert.equal(detachedRead.work_id, undefined, 'recovery hints must not infer attribution');
  assert.ok(detachedRead.warning.includes(started.work_id));
  const detachedOther = await callTool('relai_read', { workspace: 'repo', paths: ['probe.txt'] }, otherOwner);
  assert.equal(detachedOther.warning, undefined, 'other principals must not receive task IDs');
  const detachedChat = await callTool('relai_read', { workspace: 'repo', paths: ['probe.txt'] }, { ...owner, conversationId: 'separate-chat' });
  assert.equal(detachedChat.warning, undefined, 'other conversations must not receive task IDs');
  await assert.rejects(() => callTool('relai_edit', { workspace: 'repo', path: 'blocked.txt', content: 'must not write' }, sameOwner), error => error.code === 'TASK_ATTRIBUTION_REQUIRED' && error.message.includes(started.work_id));
  assert.equal(fs.existsSync(path.join(workspacePath, 'blocked.txt')), false);
  await callTool('relai_edit', { workspace: 'repo', independent: true, path: 'independent.txt', content: 'separate work' }, sameOwner);
  assert.equal(fs.readFileSync(path.join(workspacePath, 'independent.txt'), 'utf8'), 'separate work');
  await assert.rejects(() => callTool('relai_read', { work_id: started.work_id, independent: true, paths: ['probe.txt'] }, sameOwner), error => error.code === 'TASK_SCOPE_CONFLICT');
  await callTool('relai_edit', { work_id: started.work_id, path: 'linked.txt', content: 'task work' }, sameOwner);
  assert.equal(readTaskIntegrity({ stateDir }, started.work_id).baseline.pending, undefined, 'baseline must be captured before attributed mutations');

  const continued = await callTool('relai_read', {
    work_id: started.work_id,
    paths: ['probe.txt'],
    guidanceMode: 'none'
  }, sameOwner);
  assert.equal(continued.items[0].content, 'principal-bound work session\n');

  await assert.rejects(
    () => callTool('relai_read', {
      work_id: started.work_id,
      paths: ['probe.txt'],
      guidanceMode: 'none'
    }, otherOwner),
    error => error?.code === 'TASK_NOT_FOUND'
  );

  const privateRecord = readTaskHistorySessionRecord({ stateDir, auditLogPath }, started.work_id);
  assert.match(privateRecord.principalFingerprint, /^[A-Za-z0-9_-]{43}$/);
  const publicRecord = readTaskHistorySession({ stateDir, auditLogPath }, started.work_id);
  assert.equal(Object.hasOwn(publicRecord, 'principalFingerprint'), false);
} finally {
  if (repositoryIntelligenceModule) await repositoryIntelligenceModule.repositoryIntelligence.shutdown();
  if (localAnalyticsModule) await localAnalyticsModule.flushLocalAnalytics();
  if (taskHistoryStore) {
    await taskHistoryStore.flushTaskHistoryPersistence();
    taskHistoryStore.clearTaskHistory({ stateDir, auditLogPath });
  }
  if (auditModule) await auditModule.clearAuditHistory({ stateDir, auditLogPath });
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  if (previousState == null) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('Work sessions are principal-bound, reconnectable by the same identity, and private ownership is not exposed.');
