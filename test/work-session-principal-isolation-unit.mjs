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
  const { createLocalAdminPolicy } = await import('../src/mcp/authorizationPolicy.ts');
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

  const { bindWorkspaceOperationIdentity, runWorkspaceOperation } = await import('../src/workspaceOperationQueue.js');
  // Match real public admission: bind the physical workspace before taking a
  // direct internal queue lock. An alias-only lock cannot establish root identity.
  bindWorkspaceOperationIdentity('repo', workspacePath);
  bindWorkspaceOperationIdentity('other', otherWorkspacePath);
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

  // Exercise physical WAL contention with no pending in-memory task snapshot.
  // A separate state directory avoids the suite's live analytics connection.
  await taskHistoryStore.flushTaskHistoryPersistence();
  await localAnalyticsModule.flushLocalAnalytics();
  const { DatabaseSync } = await import('node:sqlite');
  const { getTaskHistoryDir, writeSession } = await import('../src/taskHistoryStorage.ts');
  const { stateDatabasePath } = await import('../src/stateDatabase.ts');
  const { assertKnownTask } = await import('../src/tools/task.js');
  const { principalFingerprint } = await import('../src/mcp/principal.ts');
  const { OPERATION_IDS: OP } = await import('../src/tools/operationIds.js');
  const { handleTransportFallbackRequest } = await import('../src/mcp/transportFallback.ts');
  const { fallbackExecutionsStatus } = await import('../src/mcp/fallbackExecutions.js');
  const { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } = await import('@modelcontextprotocol/server');
  const { MCP_PROTOCOL_VERSION } = await import('../src/mcp/protocol.js');
  const previousLockState = process.env.REL_AI_MCP_STATE_DIR;
  const lockStateDir = path.join(root, 'history-read-contention');
  process.env.REL_AI_MCP_STATE_DIR = lockStateDir;
  const lockConfig = { stateDir: lockStateDir, workspaces: { repo: { path: workspacePath, commands: {}, testCommands: {} } } };
  const lockTaskId = 'history-read-lock-fixture';
  const lockDatabase = stateDatabasePath(lockConfig);
  const lookup = (principal = owner.principal, options = {}) =>
    assertKnownTask(lockConfig, lockTaskId, 'repo', OP.READ, principal, {}, options);
  const busy = error => (Number(error?.errcode) & 0xff) === 5;
  const withReadLock = async run => {
    const database = new DatabaseSync(lockDatabase);
    let released = false;
    const releaseLock = () => {
      if (released) return;
      database.exec('ROLLBACK');
      database.close();
      released = true;
    };
    try {
      database.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
      assert.throws(() => readTaskHistorySessionRecord(lockConfig, lockTaskId, { strict: true }), busy,
        'the fixture must physically block a strict task-history read');
      return await run(releaseLock);
    } finally { releaseLock(); }
  };
  try {
    writeSession(getTaskHistoryDir(lockConfig), {
      id: lockTaskId, workspace: 'repo', status: 'planning',
      principalFingerprint: principalFingerprint(owner.principal),
      plan: { revision: 1, steps: [{ id: 'read', title: 'Read the fixture', status: 'in_progress' }] },
      startedAt: new Date().toISOString(), events: []
    });
    assert.equal(readTaskHistorySessionRecord(lockConfig, lockTaskId, { strict: true }).id, lockTaskId);
    await withReadLock(async releaseLock => {
      let releasedByTimer = false;
      const timer = setTimeout(() => { releasedByTimer = true; releaseLock(); }, 0);
      try {
        assert.equal((await lookup()).id, lockTaskId, 'a transient busy read must recover the same task');
        assert.equal(releasedByTimer, true, 'lookup recovery must yield so the lock release timer can run');
      } finally { clearTimeout(timer); }
    });
    await withReadLock(async () => {
      const watchdog = new AbortController();
      const timer = setTimeout(() => watchdog.abort(new Error('Task lookup exceeded its bounded retry window')), 2000);
      try {
        await assert.rejects(lookup(owner.principal, { signal: watchdog.signal }),
          error => error.code === 'TASK_HISTORY_UNAVAILABLE' && error.retryable === true && busy(error.cause),
          'persistent BUSY must preserve its cause and never masquerade as an unknown task');
      } finally { clearTimeout(timer); }
    });
    await withReadLock(async () => {
      const controller = new AbortController();
      const reason = new Error('Owner cancelled locked task admission');
      const timer = setTimeout(() => controller.abort(reason), 0);
      try {
        await assert.rejects(lookup(owner.principal, { signal: controller.signal }), error => error === reason,
          'owner cancellation must interrupt history retry without changing its reason');
      } finally { clearTimeout(timer); }
    });
    await withReadLock(async () => {
      await assert.rejects(lookup(owner.principal, { deadlineAtMs: Date.now() + 10 }),
        error => error.name === 'TimeoutError', 'a real admission deadline must interrupt a held lock');
    });
    await withReadLock(async releaseLock => {
      const timer = setTimeout(releaseLock, 0);
      try {
        await assert.rejects(lookup(otherOwner.principal), error => error.code === 'TASK_NOT_FOUND',
          'transient recovery must still enforce the original task principal');
      } finally { clearTimeout(timer); }
    });
    await assert.rejects(assertKnownTask(lockConfig, 'genuinely-missing-task', 'repo', OP.READ, owner.principal),
      error => error.code === 'TASK_NOT_FOUND', 'genuine absence must retain its distinct result');

    const database = new DatabaseSync(lockDatabase);
    const originalPayload = database.prepare('SELECT payload FROM task_history WHERE id=?').get(lockTaskId).payload;
    const invalidPayloads = [
      JSON.stringify({ ...JSON.parse(originalPayload), version: 999, recoveryMarker: 'preserve-original-bytes' }),
      '{"recoveryMarker":"preserve-malformed-bytes",'
    ];
    try {
      for (const invalidPayload of invalidPayloads) {
        database.prepare('UPDATE task_history SET payload=? WHERE id=?').run(invalidPayload, lockTaskId);
        await assert.rejects(lookup(),
          error => error.code === 'TASK_HISTORY_UNAVAILABLE' && error.retryable === false && /invalid/.test(error.cause?.message || ''),
          'an invalid stored record is unavailable rather than absent or retryable');
        assert.equal(database.prepare('SELECT payload FROM task_history WHERE id=?').get(lockTaskId).payload, invalidPayload,
          'failed admission must preserve unsupported and malformed history bytes for recovery');
      }
    } finally {
      database.prepare('UPDATE task_history SET payload=? WHERE id=?').run(originalPayload, lockTaskId);
      database.close();
    }

    const marker = path.join(workspacePath, 'locked-admission-must-not-run.txt');
    for (const interruption of ['deadline', 'abort', 'transport', 'busy']) {
      await withReadLock(async () => {
        const controller = new AbortController();
        const reason = new Error('Owner stopped transport admission');
        if (interruption === 'transport') reason.code = 'HTTP_MCP_REQUEST_INTERRUPTED';
        const timer = ['abort', 'transport'].includes(interruption)
          ? setTimeout(() => controller.abort(reason), 0) : null;
        try {
          const response = await handleTransportFallbackRequest(lockConfig, {
            jsonrpc: '2.0', id: `locked-${interruption}`, method: 'tools/call',
            params: {
              name: 'relai_exec',
              arguments: {
                workspace: 'repo', work_id: lockTaskId, executable: process.execPath,
                argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
                timeoutMs: 1000
              },
              _meta: { [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} }
            }
          }, { principal: owner.principal, transportType: 'streamable-http', signal: controller.signal,
            ...(interruption === 'deadline' ? { deadlineAtMs: Date.now() + 10 } : {}),
            synchronousFallback: false, synchronousFallbackGraceMs: 0 });
          const rejected = response.body.result.structuredContent;
          assert.equal(response.body.result.isError, true);
          assert.equal(rejected.ok, false);
          assert.equal(rejected.errorCode, { deadline: 'TIMEOUT', abort: 'CANCELLED', transport: 'TRANSPORT_INTERRUPTED', busy: 'TASK_HISTORY_UNAVAILABLE' }[interruption], JSON.stringify(rejected));
          assert.equal(rejected.executed, false);
          assert.equal(rejected.errorDetails.retryable, interruption === 'busy', 'only unavailable storage may invite a retry');
          if (interruption === 'busy') assert.match(rejected.errorDetails.allowedAlternatives.join(' '), /same work_id/);
          else assert.deepEqual(rejected.errorDetails.allowedAlternatives, [], 'interrupted admission must not suggest fresh work');
          assert.equal(rejected.operationId, undefined, 'interruption before admission must not create a receipt');
          assert.equal(fs.existsSync(marker), false, 'interruption while reading history must not execute the handler');
          assert.deepEqual(fallbackExecutionsStatus(lockTaskId), [], 'no live fallback may be accepted while task ownership is unreadable');
        } finally { if (timer) clearTimeout(timer); }
      });
    }
    assert.deepEqual(readTaskHistorySessionRecord(lockConfig, lockTaskId, { strict: true }).backgroundOperations || [], [],
      'deadline rejection must not leave a durable phantom receipt');
    const journalDirectory = path.join(lockStateDir, 'fallback-executions');
    assert.deepEqual(fs.existsSync(journalDirectory) ? fs.readdirSync(journalDirectory) : [], [],
      'deadline rejection must not create an operation journal');
  } finally {
    if (previousLockState == null) delete process.env.REL_AI_MCP_STATE_DIR;
    else process.env.REL_AI_MCP_STATE_DIR = previousLockState;
  }

  // Real callTool error bookkeeping must preserve unreadable evidence even
  // when the rejected request names a genuine task with integrity state.
  await taskHistoryStore.flushTaskHistoryPersistence();
  await auditModule.flushAuditWrites();
  const genuineMarker = path.join(workspacePath, 'unreadable-task-must-not-execute.txt');
  const genuineDatabase = new DatabaseSync(stateDatabasePath({ stateDir, auditLogPath }));
  const genuineOriginal = genuineDatabase.prepare('SELECT payload FROM task_history WHERE id=?').get(started.work_id).payload;
  const rejectionAudits = () => fs.readFileSync(auditLogPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.taskId === started.work_id && entry.errorCode === 'TASK_HISTORY_UNAVAILABLE');
  const genuineInvalid = [
    JSON.stringify({ ...JSON.parse(genuineOriginal), version: 999, recoveryMarker: 'preserve-real-task-bytes' }),
    '{"recoveryMarker":"preserve-real-malformed-task",'
  ];
  try {
    for (const invalidPayload of genuineInvalid) {
      const priorRejections = rejectionAudits().length;
      genuineDatabase.prepare('UPDATE task_history SET payload=? WHERE id=?').run(invalidPayload, started.work_id);
      await assert.rejects(callTool('relai_exec', {
        work_id: started.work_id, executable: process.execPath,
        argv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(genuineMarker)}, 'executed')`]
      }, sameOwner), error => error.code === 'TASK_HISTORY_UNAVAILABLE' && error.executed === false && error.retryable === false,
      'an unreadable genuine task must fail before handler admission');
      assert.equal(genuineDatabase.prepare('SELECT payload FROM task_history WHERE id=?').get(started.work_id).payload, invalidPayload,
        'failed real-call admission must preserve exact invalid history bytes instead of auditing an empty replacement');
      assert.equal(fs.existsSync(genuineMarker), false, 'unreadable task ownership must not admit a real command');
      await auditModule.flushAuditWrites();
      const rejectedAudits = rejectionAudits();
      assert.equal(rejectedAudits.length, priorRejections + 1, 'the rejected request must remain visible in ordinary audit history');
      assert.equal(rejectedAudits.at(-1).taskIdentityVersion, 0);
      assert.equal(rejectedAudits.at(-1).taskIdExplicit, false);
      assert.equal(rejectedAudits.at(-1).taskHistoryEligible, false, 'unadmitted rejection must not project into task history');
    }
  } finally {
    genuineDatabase.prepare('UPDATE task_history SET payload=? WHERE id=?').run(genuineOriginal, started.work_id);
    genuineDatabase.close();
  }
} finally {
  if (repositoryIntelligenceModule) await repositoryIntelligenceModule.repositoryIntelligence.shutdown();
  if (localAnalyticsModule) await localAnalyticsModule.flushLocalAnalytics();
  if (taskHistoryStore) {
    await taskHistoryStore.flushTaskHistoryPersistence();
    await taskHistoryStore.clearTaskHistory({ stateDir, auditLogPath });
  }
  if (auditModule) await auditModule.clearAuditHistory({ stateDir, auditLogPath });
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  if (previousState == null) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousState;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

console.log('Work sessions are principal-bound, reconnectable by the same identity, and private ownership is not exposed.');
