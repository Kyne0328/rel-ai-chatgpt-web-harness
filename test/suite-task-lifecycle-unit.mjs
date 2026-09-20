// Consolidated task lifecycle coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly task-code-ide-unit.mjs
async function case_task_code_ide_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/task-code-ide.js");
    const { createTaskCodeIdeLauncher, detectEditors } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-code-ide-'));
  const local = path.join(root, 'local');
  const programFiles = path.join(root, 'program-files');
  const code = path.join(programFiles, 'Microsoft VS Code', 'Code.exe');
  const cursor = path.join(local, 'Programs', 'Cursor', 'Cursor.exe');
  fs.mkdirSync(path.dirname(code), { recursive: true });
  fs.mkdirSync(path.dirname(cursor), { recursive: true });
  fs.writeFileSync(code, 'fixture');
  fs.writeFileSync(cursor, 'fixture');
  
  try {
    const editors = detectEditors({
      platform: 'win32',
      env: { LOCALAPPDATA: local, ProgramFiles: programFiles }
    });
    assert.deepEqual(editors.map(editor => editor.id), ['vscode', 'cursor']);
    assert.equal(editors.find(editor => editor.id === 'vscode')?.executable, code, 'IDE detection must continue to the Program Files candidate when the LocalAppData candidate is absent');
    assert.equal(new Set(editors.map(editor => editor.id)).size, editors.length, 'IDE detection must not return duplicate editor IDs');
  
    const launcher = createTaskCodeIdeLauncher({
      shell: { openPath: async () => '' },
      platform: 'win32',
      env: { LOCALAPPDATA: local, ProgramFiles: programFiles }
    });
    fs.rmSync(code);
    await assert.rejects(
      () => launcher.open(root, 'vscode'),
      /ENOENT|spawn/i,
      'IDE launch must reject when the detected executable disappears before spawn'
    );
  
    console.log('Task code IDE detection and launch failure propagation passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_task_code_ide_unit();

// Formerly task-completion-notifier-unit.mjs
async function case_task_completion_notifier_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/toolActivity.js");
    const { createToolActivityTracker } = __m1;
  
    const __m2 = await import("../electron/tool-sleep-blocker.js");
    const { createTaskActivityRuntime } = __m2;
  
  let nowValue = 1000;
  let timerId = 0;
  const timers = new Map();
  const notifications = [];
  const statuses = [];
  const completedIndicators = [];
  const startedBlockers = new Set();
  let nextBlocker = 1;
  
  
  const tracker = createToolActivityTracker({
    idleMs: 60_000,
    now: () => nowValue,
    setTimer(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); }
  });
  const runtime = createTaskActivityRuntime({
    toolActivity: tracker,
    powerSaveBlocker: {
      start(type) {
        assert.equal(type, 'prevent-app-suspension');
        const id = nextBlocker++;
        startedBlockers.add(id);
        return id;
      },
      isStarted(id) { return startedBlockers.has(id); },
      stop(id) { return startedBlockers.delete(id); }
    },
    notify: (category, content) => {
      notifications.push({ category, options: content });
      return true;
    },
    onTaskCompleted: task => completedIndicators.push(structuredClone(task)),
    onStatusChange: status => statuses.push(structuredClone(status))
  });
  
  function startTask(workspace, scopeId) {
    const finish = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      operation: 'Starting task',
      workspace,
      scopeId,
      createTask: true
    });
    const taskId = finish.taskId;
    finish({ ok: true });
    return taskId;
  }
  
  const taskA = startTask('repo', 'conversation-a');
  const taskB = startTask('other', 'conversation-b');
  const finishRead = tracker.beginConnectorToolCall({
    tool: 'relai_read',
    operation: 'Reading src/app.js',
    workspace: 'repo',
    scopeId: 'conversation-a',
    taskId: taskA
  });
  const finishOther = tracker.beginConnectorToolCall({
    tool: 'relai_read',
    operation: 'Reading README.md',
    workspace: 'other',
    scopeId: 'conversation-b',
    taskId: taskB
  });
  assert.equal(runtime.getStatus().state, 'working');
  assert.equal(runtime.getStatus().activeTaskCount, 2);
  assert.equal(runtime.getStatus().activeCalls, 2);
  assert.equal(startedBlockers.size, 1);
  finishRead();
  finishOther();
  assert.equal(runtime.getStatus().state, 'waiting');
  assert.equal(runtime.getStatus().activeTaskCount, 2);
  assert.equal(startedBlockers.size, 1, 'open logical work must keep the app eligible to continue across reasoning and approval gaps');
  assert.equal(notifications.length, 0, 'successful tool calls must not be presented as completed ChatGPT tasks');
  
  nowValue = 91_000;
  for (const [id, timer] of [...timers]) {
    timers.delete(id);
    timer.callback();
  }
  const inactive = runtime.getStatus();
  assert.equal(inactive.state, 'idle');
  assert.equal(inactive.activeTaskCount, 0);
  assert.equal(startedBlockers.size, 0, 'the sleep blocker must stop when no work session remains active');
  assert.equal(inactive.lastTask.status, 'inactive');
  assert.equal(inactive.lastTask.endReason || '', '');
  assert.ok(inactive.lastTask.inactiveAt);
  assert.equal(notifications.length, 0, 'inactivity must not generate a false task-completed notification');
  
  const failedTask = startTask('repo', 'conversation-c');
  const finishFailed = tracker.beginConnectorToolCall({
    tool: 'relai_validate', internalOperation: 'validate.checks',
    operation: 'Running validation 1/2: npm run check',
    workspace: 'repo',
    scopeId: 'conversation-c',
    taskId: failedTask
  });
  finishFailed({ ok: false, error: 'internal diagnostic detail' });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.title, 'Project action failed');
  assert.match(notifications[0].options.body, /Running validation 1\/2: npm run check failed in repo/);
  assert.match(notifications[0].options.body, /Open Rel\.AI for details and recovery options\./);
  assert.doesNotMatch(notifications[0].options.body, /internal diagnostic detail/, 'native notifications should keep technical error detail in Activity and Diagnostics');
  assert.equal(notifications[0].category, 'errors');
  
  nowValue = 152_000;
  for (const [id, timer] of [...timers]) {
    timers.delete(id);
    timer.callback();
  }
  assert.equal(runtime.getStatus().lastTask.status, 'inactive', 'a failed validation remains recoverable after the inactivity window');
  assert.equal(runtime.getStatus().lastTask.failures, 1);
  
  const completedTask = startTask('repo', 'conversation-completed');
  const finishCompleted = tracker.beginConnectorToolCall({
    tool: 'relai_work', internalOperation: 'work.finish',
    operation: 'Reporting task completion',
    workspace: 'repo',
    scopeId: 'conversation-completed',
    taskId: completedTask
  });
  finishCompleted.requestCompletion({
    summary: 'Implemented and validated the requested changes.',
    validationStatus: 'passed',
    validationLevel: 'standard',
    validationAt: '2026-07-11T09:30:00.000Z',
    changedFiles: ['src/app.js']
  });
  finishCompleted();
  assert.equal(runtime.getStatus().state, 'idle');
  assert.equal(runtime.getStatus().lastTask.status, 'completed');
  assert.equal(runtime.getStatus().lastTask.completionKnown, true);
  assert.equal(runtime.getStatus().lastTask.endReason, 'explicit_completion');
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].options.title, 'Task completed');
  assert.match(notifications[1].options.body, /Implemented and validated the requested changes\./);
  assert.match(notifications[1].options.body, /Project: repo\./);
  assert.match(notifications[1].options.body, /Final standard checks passed\./);
  assert.doesNotMatch(notifications[1].options.body, /completion reported|ChatGPT explicitly/i);
  assert.equal(notifications[1].category, 'taskCompleted');
  assert.equal(completedIndicators.length, 1);
  assert.equal(completedIndicators[0].taskId, completedTask);
  
  assert.ok(statuses.some(status => status.activeTaskCount === 2 && status.activeCalls === 2));
  assert.ok(statuses.some(status => status.state === 'waiting'));
  assert.ok(statuses.some(status => status.lastTask?.status === 'inactive'));
  assert.ok(statuses.some(status => status.lastTask?.status === 'completed' && status.lastTask?.completionKnown === true));
  runtime.stop();
  
  console.log('Exact tool activity, failure, and explicit completion notification tests passed.');
}
await case_task_completion_notifier_unit();

// Formerly task-events-unit.mjs
async function case_task_events_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/taskEvents.js");
    const { TASK_RUNTIME_EVENT_PHASES,
    TASK_RUNTIME_TERMINAL_PHASES,
    eventIdentityKey,
    eventTimestampMs,
    eventTimestampValue,
    isoTimestamp,
    terminalTaskTimestamp,
    terminalTaskTimestampValue,
    timestampMs } = __m1;
  
  assert.deepEqual(TASK_RUNTIME_EVENT_PHASES, [
    'started', 'progress', 'completion_requested', 'finished', 'cancelled', 'inactive', 'completed'
  ]);
  assert.deepEqual([...TASK_RUNTIME_TERMINAL_PHASES], ['completed', 'cancelled', 'inactive']);
  
  assert.equal(timestampMs('2026-08-05T10:00:00.000Z'), Date.parse('2026-08-05T10:00:00.000Z'));
  assert.equal(timestampMs('invalid'), 0);
  assert.equal(isoTimestamp('2026-08-05T10:00:00.000Z'), '2026-08-05T10:00:00.000Z');
  assert.equal(isoTimestamp('invalid'), '');
  const event = {
    eventId: 'event-1',
    operationId: 'operation-1',
    timestamp: '2026-08-05T10:00:00.000Z',
    ts: '2026-08-05T09:00:00.000Z'
  };
  assert.equal(eventTimestampValue(event), event.timestamp);
  assert.equal(eventTimestampMs(event), Date.parse(event.timestamp));
  assert.equal(eventIdentityKey(event), 'event-1');
  assert.equal(eventIdentityKey({ ...event, eventId: '' }), 'operation-1');
  assert.equal(eventIdentityKey({ ts: event.ts, tool: 'relai_read' }, 2), eventIdentityKey({ ts: event.ts, tool: 'relai_read' }, 2));
  assert.notEqual(eventIdentityKey({ ts: event.ts, tool: 'relai_read' }, 2), eventIdentityKey({ ts: event.ts, tool: 'relai_read' }, 3));
  const task = {
    endedAt: '2026-08-05T12:00:00.000Z',
    completedAt: '2026-08-05T11:00:00.000Z',
    updatedAt: '2026-08-05T10:00:00.000Z'
  };
  assert.equal(terminalTaskTimestampValue(task), task.endedAt);
  assert.equal(terminalTaskTimestamp(task), Date.parse(task.endedAt));
  console.log('Task event identity and timestamp helpers passed.');
}
await case_task_events_unit();

// Formerly task-history-live-unit.mjs
async function case_task_history_live_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/taskHistoryStore.ts");
    const { clearTaskHistory, flushTaskHistoryPersistence, readTaskHistorySession, recordTaskActivityEvent, recordTaskHistoryEvent, taskHistoryPersistenceSnapshot } = __m4;
  
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-history-live-'));
  const config = { stateDir: sandbox, auditLogPath: path.join(sandbox, 'audit.jsonl') };
  fs.writeFileSync(config.auditLogPath, '', 'utf8');
  
  const baseTask = {
    id: 'task-live',
    taskId: 'task-live',
    sessionId: 'task-live',
    title: 'Inspect session activity model',
    objective: 'Trace and improve task activity persistence.',
    status: 'running',
    progress: { mode: 'indeterminate', label: 'Inspecting repository' },
    currentStage: 'Inspecting repository',
    currentActivity: 'Reading session storage code.',
    calls: 1,
    toolCallCount: 1,
    successfulToolCallCount: 0,
    failedToolCallCount: 0,
    failures: 0,
    workspace: 'repo',
    startedAt: Date.parse('2026-07-28T10:00:00.000Z'),
    startedAtIso: '2026-07-28T10:00:00.000Z',
    updatedAt: '2026-07-28T10:00:01.000Z',
    activeCalls: 1,
    currentOperations: []
  };
  
  const runningEvent = {
    eventId: 'operation-1',
    taskId: 'task-live',
    sessionId: 'task-live',
    sequence: 1,
    timestamp: '2026-07-28T10:00:01.000Z',
    category: 'tool',
    action: 'read',
    status: 'running',
    title: 'Read session storage code',
    summary: 'Reading 2 repository files.',
    startedAt: '2026-07-28T10:00:01.000Z',
    tool: { name: 'relai_read', operation: 'Read repository files', invocationId: 'operation-1' },
    metadata: { pathCount: 2 }
  };
  
  try {
    recordTaskActivityEvent(config, { taskId: 'task-live', task: baseTask, activityEvent: runningEvent });
    recordTaskHistoryEvent(config, {
      id: 'audit-1',
      ts: '2026-07-28T10:00:01.000Z',
      taskId: 'task-live',
      taskIdentityVersion: 2,
      taskIdExplicit: true,
      taskHistoryEligible: true,
      operationId: 'operation-1',
      tool: 'relai_read',
      workspace: 'repo',
      operation: 'Read repository files',
      ok: true,
      ms: 500
    });
  
    const completedEvent = {
      ...runningEvent,
      timestamp: '2026-07-28T10:00:02.000Z',
      status: 'succeeded',
      summary: 'Read 2 repository files.',
      completedAt: '2026-07-28T10:00:02.000Z',
      durationMs: 1000,
      result: { outcome: 'Read 2 items', affectedItemCount: 2 }
    };
    recordTaskActivityEvent(config, {
      taskId: 'task-live',
      task: {
        ...baseTask,
        status: 'planning',
        progress: { mode: 'indeterminate', label: 'Waiting for the next task step' },
        currentStage: 'Planning next step',
        currentActivity: 'Read 2 repository files.',
        successfulToolCallCount: 1,
        updatedAt: '2026-07-28T10:00:02.000Z',
        activeCalls: 0
      },
      activityEvent: completedEvent
    });
  
    let session = readTaskHistorySession(config, 'task-live');
    assert.equal(session.calls, 1, 'audit enrichment must not double-count a represented tool invocation');
    assert.equal(session.toolCallCount, 1);
    assert.equal(session.successfulToolCallCount, 1);
    assert.equal(session.events.length, 1, 'running and completed updates must upsert one lifecycle event');
    assert.equal(session.events[0].status, 'succeeded');
    assert.equal(session.events[0].durationMs, 1000);
    assert.equal(session.status, 'planning');
  
    recordTaskActivityEvent(config, {
      taskId: 'task-live',
      task: {
        ...baseTask,
        status: 'completed',
        completionKnown: true,
        progress: { mode: 'complete', percentage: 100, label: 'Task completed' },
        currentStage: 'Completed',
        currentActivity: 'Task completed successfully.',
        resultSummary: 'Task completed successfully.',
        successfulToolCallCount: 1,
        updatedAt: '2026-07-28T10:00:03.000Z',
        completedAtIso: '2026-07-28T10:00:03.000Z',
        activeCalls: 0
      }
    });
    recordTaskActivityEvent(config, {
      taskId: 'task-live',
      task: {
        ...baseTask,
        status: 'running',
        updatedAt: '2026-07-28T10:00:02.500Z'
      }
    });
  
    session = readTaskHistorySession(config, 'task-live');
    assert.equal(session.status, 'completed', 'a stale running update must not regress a terminal task');
    assert.equal(session.progress.mode, 'complete');
    assert.equal(session.progress.percentage, 100);
  
    recordTaskHistoryEvent(config, {
      id: 'audit-rich',
      ts: '2026-07-28T10:01:00.000Z',
      taskId: 'task-audit-only',
      taskIdentityVersion: 2,
      taskIdExplicit: true,
      taskHistoryEligible: true,
      operationId: 'operation-rich',
      tool: 'relai_search',
      workspace: 'repo',
      operation: 'Search repository',
      category: 'tool',
      action: 'search',
      status: 'succeeded',
      title: 'Search repository',
      summary: 'Found 3 matching references.',
      result: { outcome: 'Found 3 matches', affectedItemCount: 3 },
      metadata: { matchCount: 3 },
      ok: true,
      ms: 25
    });
    const auditOnly = readTaskHistorySession(config, 'task-audit-only');
    assert.equal(auditOnly.events[0].title, 'Search repository');
    assert.equal(auditOnly.events[0].summary, 'Found 3 matching references.');
    assert.equal(auditOnly.events[0].result.outcome, 'Found 3 matches');
    assert.equal(auditOnly.events[0].metadata.matchCount, 3);
  
    const failureState = path.join(sandbox, 'persistence-failure');
    const failureConfig = { stateDir: failureState, auditLogPath: path.join(failureState, 'audit.jsonl') };
    recordTaskActivityEvent(failureConfig, { taskId: 'task-persistence', task: { ...baseTask, id: 'task-persistence', taskId: 'task-persistence', sessionId: 'task-persistence' } });
    const failureDatabase = path.join(failureState, 'durable-state.sqlite');
    recordTaskActivityEvent(failureConfig, {
      taskId: 'task-persistence',
      task: { ...baseTask, id: 'task-persistence', taskId: 'task-persistence', sessionId: 'task-persistence', updatedAt: '2026-07-28T10:02:00.000Z' }
    }, { defer: true });
    fs.rmSync(failureDatabase, { recursive: true, force: true });
    fs.mkdirSync(failureDatabase);
    const flushResult = await flushTaskHistoryPersistence();
    assert.equal(flushResult.ok, false, 'shutdown flush must stop after a failed persistence attempt instead of retrying forever');
    assert.equal(flushResult.failed, 1);
    assert.equal(taskHistoryPersistenceSnapshot().healthy, false, 'task-history persistence failures must remain observable');
    assert.ok(taskHistoryPersistenceSnapshot().lastError);
    fs.rmSync(failureDatabase, { recursive: true, force: true });
    clearTaskHistory(failureConfig);
    assert.equal(taskHistoryPersistenceSnapshot().healthy, true, 'clearing the failed history should clear its persistence warning');
  
    const stormState = path.join(sandbox, 'persistence-storm');
    const stormConfig = { stateDir: stormState, auditLogPath: path.join(stormState, 'audit.jsonl') };
    recordTaskActivityEvent(stormConfig, {
      taskId: 'storm-seed',
      task: { ...baseTask, id: 'storm-seed', taskId: 'storm-seed', sessionId: 'storm-seed' }
    });
    const stormDatabase = path.join(stormState, 'durable-state.sqlite');
    for (let index = 0; index < 50; index += 1) {
      const taskId = `storm-${index}`;
      recordTaskActivityEvent(stormConfig, {
        taskId,
        task: { ...baseTask, id: taskId, taskId, sessionId: taskId, updatedAt: '2026-07-28T10:03:00.000Z' }
      }, { defer: true });
    }
    fs.rmSync(stormDatabase, { recursive: true, force: true });
    fs.mkdirSync(stormDatabase);
    assert.equal(taskHistoryPersistenceSnapshot().pending, 50);
    assert.equal(taskHistoryPersistenceSnapshot().scheduledFlushes, 1, 'many pending sessions in one state directory must share one persistence timer');
    const stormFlush = await flushTaskHistoryPersistence();
    assert.equal(stormFlush.ok, false);
    assert.equal(stormFlush.failed, 1, 'a broken shared history directory must fail once per explicit flush instead of once per pending session');
    assert.equal(stormFlush.pending, 50);
    assert.equal(taskHistoryPersistenceSnapshot().scheduledFlushes, 1, 'failed shared storage must retain only one backoff retry timer');
    fs.rmSync(stormDatabase, { recursive: true, force: true });
    clearTaskHistory(stormConfig);
    assert.equal(taskHistoryPersistenceSnapshot().scheduledFlushes, 0);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  
  console.log('Live task history is idempotent, lifecycle-aware, and terminal-state safe.');
}
await case_task_history_live_unit();

// Formerly task-history-storage-unit.mjs
async function case_task_history_storage_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/taskHistoryStorage.ts");
    const { listRecentSessionEvents, listSessionSummaries, listSessions, readSession, resetTaskHistoryCaches, writeSession, writeSessionAsync } = __m4;
  
    const __m5 = await import("../src/stateDatabase.ts");
    const { openStateDatabase, stateDatabasePath, withStateDatabase } = __m5;
  
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-history-storage-'));
  const directory = path.join(stateDir, 'sessions');
  const config = { stateDir };
  
  try {
    const id = 'shared-task';
    writeSession(directory, { id, workspace: 'repo', summary: 'before' });
    assert.equal(listSessions(directory, 10)[0]?.summary, 'before');
    assert.equal(fs.existsSync(stateDatabasePath(config)), true, 'task history must use the shared SQLite state database');
    assert.equal(fs.existsSync(path.join(directory, `${id}.json`)), false, 'task history must not create canonical JSON session files');
  
    withStateDatabase(config, db => {
      const row = db.prepare('SELECT payload FROM task_history WHERE id=?').get(id);
      const session = JSON.parse(row.payload);
      session.summary = 'after!';
      db.prepare('UPDATE task_history SET updated_at_ms=?,payload=? WHERE id=?').run(Date.now() + 1, JSON.stringify(session), id);
    }, { transaction: true });
    assert.equal(listSessions(directory, 10)[0]?.summary, 'after!', 'SQLite readers must observe another process durable update immediately');
    assert.equal(readSession(directory, id)?.summary, 'after!');
  
    const lock = openStateDatabase(config);
    assert.ok(lock, 'task-history async-write test requires the state database');
    lock.exec('BEGIN IMMEDIATE');
    try {
      const pendingWrite = writeSessionAsync(directory, { id: 'worker-write', workspace: 'repo', summary: 'worker' });
      const firstSettled = await Promise.race([
        pendingWrite.then(() => 'write'),
        new Promise(resolve => setTimeout(() => resolve('timer'), 25))
      ]);
      assert.equal(firstSettled, 'timer', 'a locked SQLite write must wait in the storage worker without stalling the service event loop');
      lock.exec('ROLLBACK');
      await pendingWrite;
    } finally {
      if (lock.isTransaction) lock.exec('ROLLBACK');
      lock.close();
    }
    assert.equal(readSession(directory, 'worker-write')?.summary, 'worker', 'worker-backed async writes must preserve durability acknowledgements');
  
    const completedId = 'completed-task';
    writeSession(directory, {
      id: completedId,
      status: 'completed',
      summary: 'Completed work.',
      progress: { mode: 'indeterminate', label: 'Waiting for the next task step' }
    });
    const completed = readSession(directory, completedId);
    assert.equal(completed?.progress?.mode, 'complete');
    assert.equal(completed?.progress?.percentage, 100);
    assert.equal(completed?.resultSummary, 'Completed work.');
  
    const summaryId = 'summary-task';
    writeSession(directory, {
      id: summaryId,
      workspace: 'repo',
      status: 'completed',
      summary: 'Summary remains available.',
      backgroundOperation: { status: 'running', signature: 'detail-signature' },
      currentOperations: [{ operationId: 'op-1', status: 'running' }],
      workflowEvidence: Array.from({ length: 40 }, (_, index) => ({ kind: 'check', marker: `large-detail-${index}`, detail: 'e'.repeat(1000) })),
      events: Array.from({ length: 50 }, (_, index) => ({
        eventId: `summary-${index}`,
        tool: index % 2 ? 'edit' : 'read',
        timestamp: new Date(Date.parse('2026-08-01T00:00:00.000Z') + index * 1000).toISOString(),
        summary: `Event ${index} ${'x'.repeat(1000)}`
      }))
    });
    const summary = listSessionSummaries(directory, 10).find(session => session.id === summaryId);
    const fullSummary = readSession(directory, summaryId);
    assert.equal(summary?.summary, 'Summary remains available.');
    assert.deepEqual(summary?.events, [], 'summary reads must not materialize multi-event history payloads');
    assert.equal(summary?.workflowEvidence, undefined, 'summary reads must omit dedicated detail-only workflow evidence');
    assert.equal(summary?.backgroundOperation?.status, 'running', 'summary reads must preserve task-state fields used by dashboard projections');
    assert.equal(summary?.currentOperations?.length, 1, 'summary reads must preserve current operation state');
    assert.equal(fullSummary?.events?.length, 50, 'full task detail must remain available through the canonical record');
    assert.ok(JSON.stringify(summary).length * 4 < JSON.stringify(fullSummary).length,
      'summary reads must materially reduce the task-history payload instead of only hiding fields after parsing');
    const recentEvents = listRecentSessionEvents(directory, 2);
    assert.deepEqual(recentEvents.map(event => event.eventId), ['summary-49', 'summary-48'],
      'recent-event reads must retain the newest task activity without materializing every task payload');
    assert.equal(recentEvents[0]?.workspace, 'repo');
    assert.equal(recentEvents[0]?.taskId, summaryId);
    assert.equal(recentEvents[0]?.sessionId, summaryId);
  
    const corruptId = 'corrupt-summary-row';
    withStateDatabase(config, db => {
      db.prepare('INSERT INTO task_history(id,updated_at_ms,payload) VALUES(?,?,?)').run(corruptId, Date.now() + 10_000, '{not-json');
    }, { transaction: true });
    assert.doesNotThrow(() => listRecentSessionEvents(directory, 10), 'recent-event reads must ignore malformed task-history rows');
    assert.doesNotThrow(() => listSessionSummaries(directory, 10), 'summary reads must preserve corrupt-record quarantine behavior');
    const corruptCount = withStateDatabase(config, db => db.prepare('SELECT COUNT(*) AS count FROM task_history WHERE id=?').get(corruptId).count);
    assert.equal(Number(corruptCount), 0, 'invalid task-history rows must still be removed by summary reads');
  
    const singleEventId = 'single-event-summary';
    writeSession(directory, {
      id: singleEventId,
      status: 'inactive',
      events: [{ eventId: 'single-begin', tool: 'work.begin', timestamp: '2026-08-01T00:00:00.000Z' }]
    });
    assert.equal(listSessionSummaries(directory, 10).find(session => session.id === singleEventId)?.events?.[0]?.tool, 'work.begin',
      'summary reads must retain a lone begin event so stale-noise reconciliation keeps its existing behavior');
  
    const legacyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-history-legacy-'));
    try {
      const legacyDirectory = path.join(legacyStateDir, 'sessions');
      fs.mkdirSync(legacyDirectory, { recursive: true });
      fs.writeFileSync(path.join(legacyDirectory, 'legacy.json'), JSON.stringify({
        version: 3,
        id: 'legacy-task',
        taskId: 'legacy-task',
        sessionId: 'legacy-task',
        workspace: 'repo',
        status: 'completed',
        title: 'Legacy task',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:01:00.000Z',
        summary: 'legacy history'
      }));
      const policyFile = path.join(legacyDirectory, 'repo--task-policy-policy.json');
      fs.writeFileSync(policyFile, JSON.stringify({ workspace: 'repo', taskId: 'task-policy' }));
      assert.equal(listSessions(legacyDirectory, 10)[0]?.summary, 'legacy history');
      assert.equal(fs.existsSync(path.join(legacyDirectory, 'legacy.json')), false, 'legacy task-history JSON must be removed after migration');
      assert.equal(fs.existsSync(policyFile), true, 'task-history migration must leave legacy policy JSON for the policy migrator');
    } finally {
      fs.rmSync(legacyStateDir, { recursive: true, force: true });
    }
  
    console.log('Task-history SQLite persistence, migration, and completed-state normalization passed.');
  } finally {
    resetTaskHistoryCaches();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}
await case_task_history_storage_unit();

// Formerly task-history-store-unit.mjs
async function case_task_history_store_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/taskHistoryStore.ts");
    const { clearTaskHistory, flushTaskHistoryPersistence, getTaskHistoryDir, readCrossWorkspaceTaskEpisodes, readRecentTaskHistoryEvents, readRecentWorkflowEvidence, readRelevantTaskEpisodes, readTaskHistory, readTaskHistorySessionRecord, recordTaskActivityEvent, recordTaskHistoryEvent, recordWorkflowEvidenceBatch } = __m4;
  
    const __m5 = await import("../src/taskHistoryStorage.ts");
    const { writeSession } = __m5;
  
    const __m6 = await import("../src/stateDatabase.ts");
    const { withStateDatabase } = __m6;
  
    const __m7 = await import("../src/mcp/principal.js");
    const { principalFingerprint } = __m7;
  
    const __m8 = await import("../src/tools/task.js");
    const { assertKnownTask } = __m8;
  
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-history-store-'));
  const config = { stateDir: sandbox, auditLogPath: path.join(sandbox, 'audit.jsonl') };
  fs.writeFileSync(config.auditLogPath, '', 'utf8');
  
  function currentEvent(taskId, values = {}) {
    return {
      taskId,
      taskIdentityVersion: 2,
      taskIdExplicit: true,
      taskHistoryEligible: true,
      workspace: 'repo',
      ok: true,
      ...values
    };
  }
  
  try {
    const historyDir = getTaskHistoryDir(config);
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'legacy.json'), JSON.stringify({ id: 'legacy-task' }));
  
    const base = Date.parse('2026-07-25T00:00:00.000Z');
    for (let index = 0; index < 251; index += 1) {
      recordTaskHistoryEvent(config, currentEvent(`task-${String(index).padStart(3, '0')}`, {
        ts: new Date(base + index * 1000).toISOString(),
        tool: 'read',
        operation: `Reading task ${index}`,
        ms: 5
      }));
    }
    assert.equal(fs.existsSync(path.join(sandbox, 'durable-state.sqlite')), true, 'current task history must be persisted in the shared SQLite store');
    assert.equal(fs.existsSync(path.join(sandbox, '.task-history-v3')), false, 'obsolete task-history format markers must not be recreated');
    const eventProjection = withStateDatabase(config, db => ({
      count: Number(db.prepare('SELECT COUNT(*) AS count FROM task_history_events').get()?.count || 0),
      plan: db.prepare(`EXPLAIN QUERY PLAN
        SELECT task_id,payload FROM task_history_events
        ORDER BY event_timestamp DESC,task_updated_at_ms DESC,task_id ASC,event_index DESC LIMIT ?`).all(20)
    }));
    assert.equal(eventProjection.count, 251, 'retained events must be maintained in the indexed history projection');
    assert.match(eventProjection.plan.map(item => String(item.detail || '')).join('\n'), /task_history_events_recent_idx/,
      'recent event reads must use the indexed event projection instead of expanding every retained timeline');
  
    let sessions = readTaskHistory(config, { state: 'idle' }, { limit: 500 });
    assert.equal(sessions.length, 251);
    assert.equal(sessions[0].id, 'task-250');
    assert.equal(sessions.some(session => session.id === 'legacy-task'), false, 'pre-current session records must not be interpreted');
    assert.equal(fs.existsSync(path.join(historyDir, 'legacy.json')), false, 'pre-current session records must be removed on read');
  
    recordTaskHistoryEvent(config, currentEvent('exact-task', {
      ts: new Date(base + 300000).toISOString(), tool: 'validate.checks', validationStatus: 'passed'
    }));
    recordTaskHistoryEvent(config, currentEvent('exact-task', {
      ts: new Date(base + 301000).toISOString(), tool: 'work.finish', completionKnown: true, taskSummary: 'Completed exactly.'
    }));
    assert.equal(readTaskHistorySessionRecord(config, 'exact-task')?.resultSummary, 'Completed exactly.', 'audit-only completion must retain the final result summary');
    assert.equal(recordWorkflowEvidenceBatch(config, 'exact-task', [
      { kind: 'check', marker: 'durable-1' },
      { kind: 'check', marker: 'durable-2' }
    ]).length, 2);
    assert.deepEqual(
      readRecentWorkflowEvidence(config, 'exact-task', 3).map(item => item.marker),
      ['durable-1', 'durable-2'],
      'factual evidence must use the durable task-history path without a duplicate volatile store'
    );
  
    recordTaskHistoryEvent(config, currentEvent('separate-task', {
      ts: new Date(base + 302000).toISOString(), tool: 'work.finish', completionKnown: true,
      relatedTaskIds: ['exact-task'], taskSummary: 'Must remain separate.'
    }));
    recordTaskHistoryEvent(config, currentEvent('connector-timeout-fix', {
      ts: new Date(base + 302500).toISOString(), tool: 'work.finish', completionKnown: true,
      taskSummary: 'Fixed connector timeout recovery without changing unrelated behavior.', changedFiles: ['src/connector.js']
    }));
    for (let index = 0; index < 85; index += 1) {
      recordTaskHistoryEvent(config, currentEvent(`other-workspace-${String(index).padStart(2, '0')}`, {
        workspace: 'other-workspace',
        ts: new Date(base + 400000 + index * 1000).toISOString(),
        tool: 'work.finish',
        completionKnown: true,
        taskSummary: `Completed unrelated other-workspace task ${index}.`
      }));
    }
    recordTaskHistoryEvent(config, currentEvent('atomic-completion', {
      ts: new Date(base + 303000).toISOString(), tool: 'validate.checks', validationStatus: 'passed',
      completionKnown: true, completionSource: 'relai_validate:checks', taskSummary: 'Validated atomically.', changedFiles: ['src/atomic.js']
    }));
    recordTaskHistoryEvent(config, currentEvent('draft-task', {
      ts: new Date(base + 304000).toISOString(), tool: 'publish.draft_pr'
    }));
    recordTaskHistoryEvent(config, currentEvent('abandoned-start', {
      ts: '2020-01-01T00:00:00.000Z', eventType: 'task.started', tool: 'work.begin'
    }));
    recordTaskHistoryEvent(config, { taskId: 'legacy-event', tool: 'read', ok: true });
    const stalePlanningUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeSession(historyDir, {
      id: 'stale-planning-session',
      taskId: 'stale-planning-session',
      sessionId: 'stale-planning-session',
      version: 3,
      title: 'Stale planning session',
      status: 'planning',
      state: 'waiting',
      completionKnown: false,
      progress: { mode: 'indeterminate', label: 'Waiting for the next task step' },
      currentStage: 'Planning next step',
      currentActivity: 'Last command completed successfully.',
      activeCalls: 0,
      currentOperations: [{ operationId: 'stale-running-op', tool: 'exec', label: 'Running old command', startedAt: Date.now() - 11 * 60_000 }],
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      updatedAt: stalePlanningUpdatedAt,
      lastActivityAt: Date.parse(stalePlanningUpdatedAt),
      lastOutcome: 'succeeded',
      operation: 'Running old command'
    });
    writeSession(historyDir, {
      id: 'terminal-with-stale-operation',
      taskId: 'terminal-with-stale-operation',
      sessionId: 'terminal-with-stale-operation',
      version: 3,
      title: 'Failed task with stale operation',
      status: 'failed',
      state: 'ended',
      completionKnown: false,
      progress: { mode: 'indeterminate', label: 'Running command' },
      activeCalls: 1,
      currentOperations: [{ operationId: 'stale-op', tool: 'exec', label: 'Running command', startedAt: Date.now() - 1000 }],
      startedAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:01:00.000Z',
      endedAt: '2026-07-25T00:01:00.000Z',
      completedAt: '2026-07-25T00:01:00.000Z'
    });
  
    const explicitCompletionAt = new Date(Date.now() - 9 * 60_000).toISOString();
    writeSession(historyDir, {
      id: 'inactive-explicit-completion', taskId: 'inactive-explicit-completion', sessionId: 'inactive-explicit-completion', version: 3,
      title: 'Explicitly completed historical task', status: 'inactive', state: 'inactive', completionKnown: false,
      workflow: { stage: 'complete', recommendedAction: 'Workflow complete' },
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), updatedAt: explicitCompletionAt, inactiveAt: explicitCompletionAt,
      events: [{ eventId: 'inactive-explicit-completion-finish', taskId: 'inactive-explicit-completion', timestamp: explicitCompletionAt, tool: 'work.finish', ok: true, completionKnown: true, endReason: 'explicit_completion', taskSummary: 'Finished explicitly.' }]
    });
    writeSession(historyDir, {
      id: 'inactive-workflow-complete', taskId: 'inactive-workflow-complete', sessionId: 'inactive-workflow-complete', version: 3,
      title: 'Workflow-confirmed completed task', status: 'inactive', state: 'inactive', completionKnown: false,
      workflow: { stage: 'complete', completion: { hardReady: true, blockers: [], recommendations: [] } },
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), updatedAt: explicitCompletionAt, inactiveAt: explicitCompletionAt,
      events: []
    });
    writeSession(historyDir, {
      id: 'inactive-advisory-complete', taskId: 'inactive-advisory-complete', sessionId: 'inactive-advisory-complete', version: 3,
      title: 'Advisory complete but still open', status: 'inactive', state: 'inactive', completionKnown: false,
      workflow: { stage: 'complete', recommendedAction: 'Workflow complete' },
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), updatedAt: explicitCompletionAt, inactiveAt: explicitCompletionAt,
      events: []
    });
  
    sessions = readTaskHistory(config, { state: 'idle' }, { limit: 500 });
    assert.equal(sessions.some(session => session.id === 'legacy-event'), false);
    assert.equal(sessions.some(session => session.id === 'abandoned-start'), false);
    assert.equal(readTaskHistorySessionRecord(config, 'abandoned-start'), null, 'start-only abandoned sessions must be deleted after the stale retention window');
    const recoveredCompletion = sessions.find(session => session.id === 'inactive-explicit-completion');
    assert.equal(recoveredCompletion.status, 'completed', 'explicit completion evidence must outrank a stale inactive projection');
    assert.equal(recoveredCompletion.completionKnown, true, 'explicit completion evidence must be recovered instead of erased by inactivity');
    assert.equal(recoveredCompletion.progress.mode, 'complete');
    const workflowCompleted = sessions.find(session => session.id === 'inactive-workflow-complete');
    assert.equal(workflowCompleted.status, 'inactive', 'workflow readiness must not substitute for explicit lifecycle completion');
    assert.equal(workflowCompleted.completionKnown, false);
    assert.equal(workflowCompleted.endReason || '', '');
    assert.equal(sessions.find(session => session.id === 'inactive-advisory-complete').status, 'inactive', 'workflow stage alone must not fabricate completion');
    writeSession(historyDir, {
      id: 'workflow-complete-with-inactive-tracker', taskId: 'workflow-complete-with-inactive-tracker', sessionId: 'workflow-complete-with-inactive-tracker', version: 3,
      title: 'Workflow complete with stale tracker row', status: 'inactive', state: 'inactive', completionKnown: false,
      workflow: { stage: 'complete', completion: { hardReady: true, blockers: [], recommendations: [] } },
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), updatedAt: explicitCompletionAt, inactiveAt: explicitCompletionAt,
      events: []
    });
    const trackerInactive = readTaskHistory(config, { tasks: [{ id: 'workflow-complete-with-inactive-tracker', taskId: 'workflow-complete-with-inactive-tracker', status: 'inactive', state: 'inactive', activeCalls: 0, completionKnown: false, startedAt: new Date(Date.now() - 20 * 60_000).toISOString() }] }, { limit: 500 });
    const trackerOverlayCompletion = trackerInactive.find(session => session.id === 'workflow-complete-with-inactive-tracker');
    assert.equal(trackerOverlayCompletion.status, 'inactive', 'an inactive tracker snapshot must remain resumable until explicit lifecycle completion');
    assert.equal(trackerOverlayCompletion.completionKnown, false);
    const exact = sessions.find(session => session.id === 'exact-task');
    assert.equal(exact.calls, 2);
    assert.equal(exact.status, 'completed');
    assert.equal(exact.summary, 'Completed exactly.');
    const relatedEpisodes = readRelevantTaskEpisodes(config, 'repo', 'Investigate connector timeout recovery', { limit: 3 });
    assert.equal(relatedEpisodes[0].outcome, 'Fixed connector timeout recovery without changing unrelated behavior.', 'newer tasks from another workspace must not consume this workspace scan window');
    assert.deepEqual(relatedEpisodes[0].changes, ['src/connector.js']);
    assert.deepEqual(readRelevantTaskEpisodes(config, 'other-workspace', 'connector timeout recovery'), [], 'episodic retrieval must remain workspace-local');
  
    writeSession(historyDir, {
      id: 'portable-single-match', taskId: 'portable-single-match', sessionId: 'portable-single-match', version: 3,
      workspace: 'portable-a', title: 'Repository migration', objective: 'Repository migration', resultSummary: 'Migrated safely.',
      status: 'completed', completionKnown: true, startedAt: new Date(base + 500000).toISOString(), updatedAt: new Date(base + 501000).toISOString()
    });
    writeSession(historyDir, {
      id: 'portable-strong-match', taskId: 'portable-strong-match', sessionId: 'portable-strong-match', version: 3,
      workspace: 'portable-b', title: 'Connector timeout recovery', objective: 'Connector timeout recovery', resultSummary: 'Fixed connector timeout recovery.',
      status: 'completed', completionKnown: true, startedAt: new Date(base + 502000).toISOString(), updatedAt: new Date(base + 503000).toISOString()
    });
    assert.deepEqual(readCrossWorkspaceTaskEpisodes(config, 'repo', 'repository cleanup', { limit: 4 }), [],
      'one generic lexical overlap must not inject unrelated cross-workspace history');
    assert.match(readCrossWorkspaceTaskEpisodes(config, 'repo', 'connector timeout recovery', { limit: 4 })[0]?.goal || '', /Connector timeout recovery/i,
      'multiple meaningful overlaps must still allow portable cross-workspace continuity');
  
    assert.equal(sessions.some(session => session.id === 'separate-task'), true, 'relatedTaskIds must not merge distinct task IDs');
    const atomic = sessions.find(session => session.id === 'atomic-completion');
    assert.equal(atomic.validation, 'passed');
    assert.deepEqual(atomic.changedFiles, ['src/atomic.js']);
    assert.equal(sessions.find(session => session.id === 'draft-task').prDrafted, true);
    const stalePlanning = sessions.find(session => session.id === 'stale-planning-session');
    assert.equal(stalePlanning.status, 'inactive', 'persisted nonterminal sessions must become resumable after the inactivity window');
    assert.equal(stalePlanning.resumeStatus, 'planning', 'inactivity must preserve the last meaningful resumable state');
    assert.equal(stalePlanning.endReason || '', '');
    assert.equal(stalePlanning.activeCalls, 0);
    assert.deepEqual(stalePlanning.currentOperations, []);
    assert.equal(stalePlanning.currentStage, 'Inactive');
    assert.equal(stalePlanning.endedAt == null, true, 'inactive sessions must not receive a terminal timestamp');
    assert.ok(stalePlanning.inactiveAt, 'inactive sessions must retain the inactivity transition time');
    assert.equal(readTaskHistorySessionRecord(config, 'stale-planning-session').status, 'inactive', 'reconciliation must persist the resumable inactive state');
    writeSession(historyDir, {
      id: 'stale-task-access',
      taskId: 'stale-task-access',
      sessionId: 'stale-task-access',
      version: 3,
      title: 'Expired task access',
      status: 'planning',
      workspace: 'repo',
      startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      lastOutcome: 'succeeded',
      activeCalls: 0,
      principalFingerprint: principalFingerprint('anonymous')
    });
    const resumable = assertKnownTask(config, 'stale-task-access', 'repo', 'relai_read', 'anonymous');
    assert.equal(resumable.status, 'inactive', 'authorized same-workspace task access must accept a resumable inactive work session');
    assert.equal(readTaskHistorySessionRecord(config, 'stale-task-access').status, 'inactive');
    const staleTerminal = sessions.find(session => session.id === 'terminal-with-stale-operation');
    assert.equal(staleTerminal.activeCalls, 0, 'terminal history must not expose stale active calls');
    assert.deepEqual(staleTerminal.currentOperations, [], 'terminal history must not expose stale running operations');
    assert.equal(staleTerminal.progress.mode, 'indeterminate', 'historical progress may remain indeterminate because rendering is status-aware');
  
    recordTaskActivityEvent(config, {
      task: { id: 'worker-projection-task', taskId: 'worker-projection-task', workspace: 'repo', status: 'planning' },
      activityEvent: { eventId: 'worker-projection-event', timestamp: new Date(Date.now() + 1).toISOString(), tool: 'read', status: 'succeeded', summary: 'Worker persisted event.' }
    }, { defer: true });
    const flushed = await flushTaskHistoryPersistence();
    assert.equal(flushed.ok, true, 'deferred task-history worker write must complete before projection read');
    assert.equal(readRecentTaskHistoryEvents(config, 1)[0]?.eventId, 'worker-projection-event',
      'task-history worker writes must update the indexed recent-event projection through SQLite triggers');
  
    clearTaskHistory(config);
    assert.equal(fs.existsSync(historyDir), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  
  console.log('Persistent task history hard-cuts pre-current records and stores exact current task IDs.');
}
await case_task_history_store_unit();

// Formerly task-identity-unit.mjs
async function case_task_identity_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/task-identity.js");
    const { taskEntityView } = __m1;
  
  assert.deepEqual(taskEntityView({ work_id: 'logical-1', nativeTaskId: 'native-1', processId: 42 }), {
    logicalTaskId: 'logical-1',
    nativeTaskId: 'native-1',
    processId: '42'
  });
  console.log('Dashboard task identity contracts passed.');
}
await case_task_identity_unit();

// Formerly task-inactivity-recovery-unit.mjs
async function case_task_inactivity_recovery_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/toolActivity.js");
    const { createToolActivityTracker } = __m1;
  
  function createHarness() {
    let now = 1_000;
    let nextTimerId = 0;
    const timers = new Map();
    const tracker = createToolActivityTracker({
      idleMs: 300_000,
      now: () => now,
      setTimer(callback, delay) {
        const id = ++nextTimerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimer(id) {
        timers.delete(id);
      }
    });
  
    return {
      tracker,
      advanceToInactivity() {
        now += 300_000;
        const pending = [...timers.values()];
        timers.clear();
        for (const timer of pending) timer.callback();
      },
      advanceWithoutFiringTimers() {
        now += 300_000;
      },
      advance(milliseconds) {
        now += milliseconds;
      }
    };
  }
  
  {
    const { tracker, advanceToInactivity } = createHarness();
    const start = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      workspace: 'repo',
      createTask: true
    });
    const taskId = start.taskId;
    start({ ok: true });
  
    const failedSearch = tracker.beginConnectorToolCall({
      tool: 'relai_search',
      workspace: 'repo',
      taskId
    });
    failedSearch({ ok: false, error: 'Malformed regular expression.' });
  
    let active = tracker.getToolActivity().tasks.find(task => task.taskId === taskId);
    assert.equal(active?.failures, 1);
    assert.equal(active?.lastOutcome, 'failed');
    assert.match(active?.errorSummary || '', /Malformed regular expression/);
  
    const recoveredRead = tracker.beginConnectorToolCall({
      tool: 'relai_read',
      workspace: 'repo',
      taskId
    });
    recoveredRead({ ok: true });
  
    active = tracker.getToolActivity().tasks.find(task => task.taskId === taskId);
    assert.equal(active?.failures, 1, 'historical failure accounting must be retained');
    assert.equal(active?.lastOutcome, 'succeeded');
    assert.equal(active?.errorSummary, '', 'a successful follow-up must clear the stale active error');
  
    advanceToInactivity();
    const inactive = tracker.getToolActivity().lastTask;
    assert.equal(inactive?.taskId, taskId);
    assert.equal(inactive?.status, 'inactive', 'a recovered historical failure must remain resumable after inactivity');
    assert.equal(inactive?.failedToolCallCount, 1);
    assert.equal(inactive?.endedAt == null, true);
    assert.ok(inactive?.inactiveAt);
  }
  
  {
    const { tracker, advanceToInactivity } = createHarness();
    const start = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      workspace: 'repo',
      createTask: true
    });
    const taskId = start.taskId;
    start({ ok: true });
  
    const failedSearch = tracker.beginConnectorToolCall({
      tool: 'relai_search',
      workspace: 'repo',
      taskId
    });
    failedSearch({ ok: false, error: 'Malformed regular expression.' });
  
    advanceToInactivity();
    const inactive = tracker.getToolActivity().lastTask;
    assert.equal(inactive?.taskId, taskId);
    assert.equal(inactive?.status, 'inactive');
    assert.equal(inactive?.resumeStatus, 'planning', 'inactivity must retain the state the task will resume from');
    assert.equal(inactive?.failedToolCallCount, 1);
    assert.match(inactive?.errorSummary || '', /Malformed regular expression/);
  }
  
  {
    const { tracker, advanceWithoutFiringTimers } = createHarness();
    const start = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      workspace: 'repo',
      createTask: true
    });
    const taskId = start.taskId;
    start({ ok: true });
  
    advanceWithoutFiringTimers();
    const status = tracker.getToolActivity();
    assert.equal(status.activeTaskCount, 0, 'status reads must reap an overdue task even when its timer was delayed');
    assert.equal(status.lastTask?.taskId, taskId);
    assert.equal(status.lastTask?.status, 'inactive');
    assert.equal(status.lastTask?.endReason || '', '');
    assert.ok(status.lastTask?.inactiveAt);
  }
  
  {
    const { tracker, advance } = createHarness();
    const start = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      workspace: 'repo',
      createTask: true
    });
    const taskId = start.taskId;
    start({ ok: true });
  
    for (let poll = 0; poll < 100; poll += 1) {
      const status = tracker.beginConnectorToolCall({
        tool: 'relai_work', internalOperation: 'work.status',
        workspace: 'repo', taskId, trackTask: false
      });
      status({ ok: true });
      advance(3_000);
    }
  
    const inactive = tracker.getToolActivity();
    assert.equal(inactive.activeTaskCount, 0, 'monitor-only status polling must not keep an abandoned task alive');
    assert.equal(inactive.lastTask?.taskId, taskId);
    assert.equal(inactive.lastTask?.status, 'inactive');
  }
  
  {
    const { tracker } = createHarness();
    const start = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      workspace: 'repo',
      createTask: true
    });
    const taskId = start.taskId;
    start({ ok: false, error: "Workspace 'repo' is not configured." });
  
    const status = tracker.getToolActivity();
    assert.equal(status.activeTaskCount, 0, 'a rejected work-session start must never remain open');
    assert.equal(status.lastTask?.taskId, taskId);
    assert.equal(status.lastTask?.status, 'failed');
    assert.equal(status.lastTask?.endReason, 'task_start_rejected');
    assert.match(status.lastTask?.terminalReason || '', /not configured/i);
  }
  
  console.log('Task inactivity recovery tests passed.');
}
await case_task_inactivity_recovery_unit();

// Formerly task-inactivity-resume-unit.mjs
async function case_task_inactivity_resume_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/taskState.js");
    const { CANONICAL_TASK_STATUSES,
    canTransitionTaskStatus,
    isTerminalTaskStatus,
    normalizeHistoricalTaskStatus } = __m1;
  
    const __m2 = await import("../src/policyResolver.js");
    const { SESSION_IDLE_TTL_MS } = __m2;
  
    const __m3 = await import("../src/toolActivity.js");
    const { createToolActivityTracker, DEFAULT_TASK_IDLE_MS } = __m3;
  
  assert.equal(CANONICAL_TASK_STATUSES.includes('inactive'), true);
  assert.equal(isTerminalTaskStatus('inactive'), false);
  for (const status of ['planning', 'running', 'blocked', 'validating', 'validation_failed']) {
    assert.equal(canTransitionTaskStatus(status, 'inactive'), true, `${status} must be able to become inactive`);
  }
  for (const status of ['planning', 'running', 'blocked', 'validating']) {
    assert.equal(canTransitionTaskStatus('inactive', status), true, `inactive must resume as ${status}`);
  }
  assert.equal(canTransitionTaskStatus('completed', 'inactive'), false);
  assert.equal(canTransitionTaskStatus('cancelled', 'inactive'), false);
  assert.equal(canTransitionTaskStatus('failed', 'inactive'), false);
  assert.equal(normalizeHistoricalTaskStatus('cancelled', { completionKnown: false, endReason: 'inactivity_window' }), 'inactive');
  assert.equal(normalizeHistoricalTaskStatus('failed', { completionKnown: false, endReason: 'inactivity_window' }), 'inactive');
  assert.equal(normalizeHistoricalTaskStatus('cancelled', { completionKnown: false, endReason: 'explicit_cancellation' }), 'cancelled');
  assert.equal(normalizeHistoricalTaskStatus('completed', { completionKnown: true, endReason: 'explicit_completion' }), 'completed');
  assert.ok(DEFAULT_TASK_IDLE_MS < SESSION_IDLE_TTL_MS, 'activity inactivity must age out before durable session ownership expires');
  
  let now = 1_000;
  let timerId = 0;
  const timers = new Map();
  const events = [];
  const tracker = createToolActivityTracker({
    idleMs: 20_000,
    now: () => now,
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); }
  });
  tracker.onToolActivity(event => events.push(event));
  const begin = tracker.beginConnectorToolCall({ tool: 'relai_work', internalOperation: 'work.begin', workspace: 'repo', createTask: true, title: 'Resume me', objective: 'Preserve task identity.' });
  const taskId = begin.taskId;
  begin({ ok: true });
  const failed = tracker.beginConnectorToolCall({ tool: 'relai_search', workspace: 'repo', taskId });
  failed({ ok: false, error: 'Recoverable probe failed.' });
  now += 10_000;
  const stillOpen = tracker.getToolActivity().tasks.find(task => task.taskId === taskId);
  assert.equal(stillOpen?.status, 'planning', 'idle work must stay open before the stale threshold');
  assert.equal(stillOpen?.activeCalls, 0);
  now += 10_000;
  for (const timer of [...timers.values()]) timer.callback();
  timers.clear();
  const inactive = tracker.getToolActivity().lastTask;
  assert.equal(inactive?.taskId, taskId);
  assert.equal(inactive?.status, 'inactive');
  assert.equal(inactive?.failures, 1);
  assert.ok(inactive?.inactiveAt);
  assert.equal(inactive?.endedAt == null, true);
  assert.equal(inactive?.completedAt == null, true);
  assert.equal(inactive?.cancelledAt == null, true);
  assert.equal(events.some(event => event.phase === 'cancelled' || event.phase === 'failed' || event.phase === 'completed'), false, 'inactivity must not emit a false terminal notification');
  assert.equal(events.some(event => event.phase === 'inactive'), true);
  
  const resumed = tracker.beginConnectorToolCall({ tool: 'relai_read', workspace: 'repo', taskId, resumeTask: inactive });
  assert.equal(resumed.taskId, taskId);
  resumed({ ok: true });
  const resumedTask = tracker.getToolActivity().tasks.find(task => task.taskId === taskId);
  assert.equal(resumedTask?.taskId, taskId);
  assert.equal(resumedTask?.status, 'planning');
  assert.equal(resumedTask?.title, 'Resume me');
  assert.equal(resumedTask?.objective, 'Preserve task identity.');
  assert.equal(resumedTask?.toolCallCount, 3, 'resuming must continue the existing call count instead of presenting a new task');
  assert.equal(resumedTask?.failedToolCallCount, 1, 'resuming must preserve prior failure accounting');
  assert.equal(resumedTask?.startedAt, 1_000, 'resuming must preserve the original task start time');
  
  console.log('Resumable inactivity lifecycle tests passed.');
}
await case_task_inactivity_resume_unit();

// Formerly task-lifecycle-activity-unit.mjs
async function case_task_lifecycle_activity_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/toolActivity.js");
    const { createToolActivityTracker } = __m1;
  
  const tracker = createToolActivityTracker({ idleMs: 60_000 });
  const events = [];
  tracker.onToolActivity(event => events.push(event));
  
  const start = tracker.beginConnectorToolCall({
    tool: 'relai_work', internalOperation: 'work.begin',
    workspace: 'repo',
    scopeId: 'lifecycle-activity',
    createTask: true,
    objective: 'Add compact task lifecycle events'
  });
  const taskId = start.taskId;
  start.update({ operation: 'Inspecting lifecycle state' });
  start();
  
  assert.ok(events.length >= 3);
  assert.equal(events.every(event => !Object.hasOwn(event, 'tasks')), true, 'activity notifications must not rematerialize the full task list');
  assert.equal(events.every(event => Array.isArray(event.changedFields)), true);
  assert.equal(events.every(event => event.revision > 0), true);
  assert.equal(events.some(event => event.taskId === taskId && event.changedFields.includes('operation')), true);
  
  const snapshot = tracker.getToolActivity();
  assert.equal(snapshot.tasks.length, 1, 'explicit snapshot reads still materialize the full task projection');
  assert.equal(snapshot.tasks[0].id, taskId);
  assert.equal(snapshot.tasks[0].intent, 'feature');
  
  tracker.reset();
  console.log('Task activity notifications use compact lifecycle deltas while snapshot reads remain complete.');
}
await case_task_lifecycle_activity_unit();

// Formerly task-observability-security-unit.mjs
async function case_task_observability_security_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
  const {
    buildSafeActivityProjection,
    sanitizeCompletionSummary,
    sanitizeDisplayText
  } = await import('../src/taskObservability.js');
  const { createToolActivityTracker } = await import('../src/toolActivity.js');
  const {
    getTaskHistoryDir,
    readTaskHistorySession,
    recordTaskActivityEvent
  } = await import('../src/taskHistoryStore.ts');
  const { mergeDashboardActivity } = await import('../src/core/dashboard-data.ts');
  const { withStateDatabase } = await import('../src/stateDatabase.ts');
  
  const syntheticSecrets = [
    'Authorization: Bearer relai_test_bearer_123456',
    'authorization: Basic dXNlcjpwYXNz',
    'password=hunter2-synthetic',
    'CLIENT_SECRET="client-secret-synthetic"',
    'api_key=api-key-synthetic',
    'ACCESS_TOKEN=access-token-synthetic',
    'refresh_token=refresh-token-synthetic',
    'Cookie: session=session-secret-synthetic',
    'Set-Cookie: auth=cookie-secret-synthetic; HttpOnly',
    'https://user:pass@example.test/path?token=query-secret&safe=value',
    'approval_code=approval-secret-synthetic'
  ];
  for (const value of syntheticSecrets) {
    const sanitized = sanitizeCompletionSummary(`Completed work. ${value}`);
    assert.doesNotMatch(sanitized, /(?:hunter2|synthetic|query-secret|dXNlcjpwYXNz|relai_test_bearer)/i, value);
    assert.match(sanitized, /redacted/i, value);
  }
  assert.equal(
    sanitizeCompletionSummary('Updated the tokenizer and documented the authorization flow.'),
    'Updated the tokenizer and documented the authorization flow.'
  );
  assert.equal(sanitizeDisplayText('safe=value and version=0.24.0', 200), 'safe=value and version=0.24.0');
  assert.throws(() => sanitizeCompletionSummary({ summary: 'not a primitive' }), /string/);
  assert.throws(() => sanitizeCompletionSummary('   '), /required/);
  const long = sanitizeCompletionSummary(`${'a'.repeat(2500)} password=secret-at-tail`, 2000);
  assert.equal(long.length, 2000);
  
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-observability-security-'));
  const config = { stateDir: sandbox, auditLogPath: path.join(sandbox, 'audit.jsonl') };
  fs.writeFileSync(config.auditLogPath, '', 'utf8');
  const tracker = createToolActivityTracker({ idleMs: 60_000 });
  tracker.onToolActivity(event => recordTaskActivityEvent(config, event));
  const originalSecret = 'production-path-secret-123456';
  try {
    const start = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.begin',
      operation: 'Starting security regression task',
      workspace: 'repo',
      createTask: true
    });
    const taskId = start.taskId;
    start({ ok: true });
  
    const complete = tracker.beginConnectorToolCall({
      tool: 'relai_work', internalOperation: 'work.finish',
      operation: 'Reporting task completion',
      workspace: 'repo',
      taskId
    });
    complete.requestCompletion({
      summary: `Implemented safely. Authorization: Bearer ${originalSecret}\npassword=${originalSecret}`,
      validationStatus: 'passed'
    });
    complete({ ok: true });
  
    const session = readTaskHistorySession(config, taskId);
    assert.equal(session.status, 'completed');
    const dashboard = mergeDashboardActivity({ entries: [] }, [session], 500);
    const safeCopy = buildSafeActivityProjection(dashboard.entries.at(-1) || {});
    const inspected = JSON.stringify({ tracker: tracker.getToolActivity(), session, dashboard, safeCopy });
    assert.equal(inspected.includes(originalSecret), false, inspected);
    assert.match(inspected, /redacted/i);
  
    const rawHistory = withStateDatabase(config, db => db.prepare('SELECT payload FROM task_history').all()
      .map(row => String(row.payload || ''))
      .join('\n'));
    assert.equal(rawHistory.includes(originalSecret), false, rawHistory);
  
    const historicalTaskId = 'historical-unsafe-task';
    const legacyConfig = { stateDir: path.join(sandbox, 'legacy-state'), auditLogPath: path.join(sandbox, 'legacy-audit.jsonl') };
    const legacyHistoryDir = getTaskHistoryDir(legacyConfig);
    fs.mkdirSync(legacyHistoryDir, { recursive: true });
    const historicalFile = path.join(
      legacyHistoryDir,
      `${crypto.createHash('sha256').update(historicalTaskId).digest('hex')}.json`
    );
    fs.writeFileSync(historicalFile, JSON.stringify({
      id: historicalTaskId,
      taskId: historicalTaskId,
      status: 'inactive',
      summary: `token=${originalSecret}`,
      resultSummary: `Authorization: Bearer ${originalSecret}`,
      endedAt: new Date().toISOString(),
      events: [{ eventId: 'legacy-event', summary: `password=${originalSecret}` }]
    }));
    const historical = readTaskHistorySession(legacyConfig, historicalTaskId);
    assert.equal(historical, null, 'hard cutover must not load unsupported pre-v3 task-history records');
    assert.equal(fs.existsSync(historicalFile), false, 'unsupported secret-bearing task history must be removed during hard cutover');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  
  console.log('Completion-summary privacy is enforced across tracker, persistence, dashboard, SSE projection, and copy-safe JSON.');
}
await case_task_observability_security_unit();

// Formerly task-observability-unit.mjs
async function case_task_observability_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/taskObservability.js");
    const { buildToolActivityDetails, createActivityEvent, deriveTaskTitle, determinateProgress, incompleteProgress, normalizeTaskProgress, sanitizeActivityMetadata } = __m1;
  
  assert.equal(deriveTaskTitle({ title: 'Audit dashboard activity model' }), 'Audit dashboard activity model');
  assert.equal(deriveTaskTitle({ title: 'Inspect token=super-secret dashboard' }), 'Inspect token=[redacted] dashboard');
  assert.equal(deriveTaskTitle({ title: 'Task', tool: 'read', paths: ['src/taskHistory.js'] }), 'Read src/taskHistory.js');
  assert.equal(deriveTaskTitle({ objective: 'inspect session persistence. Then report findings.' }), 'Inspect session persistence');
  assert.equal(deriveTaskTitle({ tool: 'validate.checks' }), 'Run repository validation');
  
  const metadata = sanitizeActivityMetadata({
    waitMs: 1800,
    changedFiles: ['src/app.js'],
    token: 'secret',
    approvalSecret: 'secret',
    environment: { API_KEY: 'secret' },
    stdout: 'private output',
    resourceUri: 'https://user:pass@example.com/private?token=secret',
    retryable: true
  });
  assert.deepEqual(metadata, {
    waitMs: 1800,
    changedFiles: ['src/app.js'],
    retryable: true
  });
  
  const readRunning = buildToolActivityDetails('read', { paths: ['src/a.js', 'src/b.js', 'src/c.js'] }, null, null, { phase: 'running' });
  assert.equal(readRunning.progress.mode, 'determinate');
  assert.equal(readRunning.progress.completedUnits, 0);
  assert.equal(readRunning.progress.totalUnits, 3);
  assert.equal(readRunning.category, 'tool');
  
  const readCompleted = buildToolActivityDetails('read', { paths: ['src/a.js', 'src/b.js', 'src/c.js'] }, { items: [{}, {}, {}] }, null, { phase: 'complete' });
  assert.equal(readCompleted.progress.percentage, 100);
  assert.equal(readCompleted.result.affectedItemCount, 3);
  assert.match(readCompleted.summary, /Read 3 repository items/);
  
  const exactCommand = 'Write-Host "one  two"\nGet-ChildItem';
  const execCompleted = buildToolActivityDetails('exec', { command: exactCommand }, { exitCode: 0 }, null, { phase: 'complete' });
  assert.equal(execCompleted.command, exactCommand, 'exec activity must retain the command text shown to the user');
  const execEvent = createActivityEvent({
    eventId: 'exec-command-1',
    taskId: 'task-command-1',
    status: 'succeeded',
    ...execCompleted
  });
  assert.equal(execEvent.command, exactCommand, 'activity events must retain the visible exec command');
  
  const secretCommand = buildToolActivityDetails('exec', { command: 'npm test --token super-secret OPENAI_API_KEY=also-secret' }, { exitCode: 0 }, null, { phase: 'complete' });
  assert.doesNotMatch(secretCommand.command, /super-secret|also-secret/);
  assert.match(secretCommand.command, /\[REDACTED\]/);
  
  const directCommand = buildToolActivityDetails('exec', { executable: 'pwsh', argv: ['-Command', 'Write-Host "a b"'] }, { exitCode: 0 }, null, { phase: 'complete' });
  assert.equal(directCommand.command, '"pwsh" "-Command" "Write-Host \\"a b\\""');
  
  const failed = buildToolActivityDetails('exec', { command: 'npm test' }, null, { code: 'WORKSPACE_UNAVAILABLE', message: 'Workspace path was unavailable.', retryable: true }, { phase: 'complete' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.retryable, true);
  assert.match(failed.summary, /Workspace path was unavailable/);
  const blocked = buildToolActivityDetails('edit', {}, null, { code: 'APPROVAL_REQUIRED', message: 'Authorization: Bearer abc.def is required.' }, { phase: 'complete' });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.currentStage, 'Blocked');
  assert.doesNotMatch(blocked.error.message, /abc\.def/);
  
  assert.deepEqual(determinateProgress(4, 7, 'plan', '4 of 7 planned steps'), {
    mode: 'determinate',
    completedUnits: 4,
    totalUnits: 7,
    percentage: 57,
    source: 'plan',
    label: '4 of 7 planned steps'
  });
  assert.equal(normalizeTaskProgress({ mode: 'determinate', completedUnits: 2, totalUnits: 5 }, 'failed').percentage, 40);
  assert.deepEqual(normalizeTaskProgress({ mode: 'determinate', completedUnits: 2, totalUnits: 5 }, 'completed'), {
    mode: 'complete', percentage: 100, label: 'Complete'
  });
  assert.equal(
    normalizeTaskProgress({ mode: 'determinate', completedUnits: 1, totalUnits: 1, percentage: 100 }, 'validating').percentage,
    99,
    'non-completed task states must not claim 100% task completion'
  );
  assert.equal(
    normalizeTaskProgress({ mode: 'complete', percentage: 100, label: 'Validation complete' }, 'planning').mode,
    'indeterminate',
    'operation completion must not be projected as task completion while the task remains open'
  );
  assert.deepEqual(incompleteProgress({
    mode: 'determinate',
    completedUnits: 5,
    totalUnits: 5,
    percentage: 100
  }, 'validation_failed', 'Fix issues and revalidate'), {
    mode: 'determinate',
    completedUnits: 5,
    totalUnits: 5,
    percentage: 99,
    source: 'tool',
    label: 'Fix issues and revalidate'
  });
  assert.deepEqual(incompleteProgress({ mode: 'indeterminate', label: 'Checking' }, 'blocked', 'Action required'), {
    mode: 'indeterminate',
    label: 'Action required'
  });
  
  const event = createActivityEvent({
    eventId: 'operation-1',
    taskId: 'task-1',
    sequence: 2,
    category: 'validation',
    action: 'run.checks',
    status: 'succeeded',
    title: 'Run repository validation',
    summary: 'Ran 42 unit tests; 42 passed.',
    tool: { name: 'validate.checks', operation: 'Workspace checks' },
    target: { workspaceRelativePath: 'test' },
    result: { affectedItemCount: 42 },
    metadata: { passedCount: 42, token: 'secret' }
  });
  assert.equal(event.eventId, 'operation-1');
  assert.equal(event.sessionId, 'task-1');
  assert.equal(event.sequence, 2);
  assert.deepEqual(event.metadata, { passedCount: 42 });
  assert.equal(event.tool.invocationId, 'operation-1');
  
  console.log('Task observability title, progress, summary, and redaction tests passed.');
}
await case_task_observability_unit();

// Formerly task-progress-unit.mjs
async function case_task_progress_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/components/task-progress.js");
    const { taskProgressView } = __m1;
  
  const indeterminate = { mode: 'indeterminate', label: 'Running command' };
  
  for (const [status, className, state, fallback] of [
    ['failed', 'static terminal failed', 'Failed', 'Task failed'],
    ['cancelled', 'static terminal cancelled', 'Cancelled', 'Task cancelled'],
    ['expired', 'static terminal cancelled', 'Expired', 'Task expired']
  ]) {
    const view = taskProgressView(indeterminate, status);
    assert.equal(view.kind, 'static');
    assert.match(view.className, new RegExp(className.replaceAll(' ', '\\s+')));
    assert.equal(view.state, state);
    assert.equal(view.label, fallback);
    assert.equal(view.value, null);
  }
  
  const inactive = taskProgressView({ mode: 'indeterminate', label: 'Waiting for the next task step' }, 'inactive');
  assert.equal(inactive.kind, 'static');
  assert.match(inactive.className, /static paused/);
  assert.equal(inactive.state, 'Inactive');
  assert.equal(inactive.label, 'Ready to resume');
  
  for (const [status, className] of [
    ['validation_failed', 'static paused failed'],
    ['blocked', 'static paused blocked'],
    ['waiting_for_approval', 'static paused blocked']
  ]) {
    const view = taskProgressView({ mode: 'indeterminate', label: 'Approval required' }, status, { compact: true });
    assert.equal(view.kind, 'static');
    assert.match(view.className, new RegExp(className.replaceAll(' ', '\\s+')));
    assert.equal(view.state, 'Action required');
    assert.match(view.className, /compact/);
  }
  
  const running = taskProgressView(indeterminate, 'running');
  assert.equal(running.kind, 'indeterminate');
  assert.match(running.className, /task-progress indeterminate/);
  assert.equal(running.role, 'status');
  assert.equal(running.label, 'Running command');
  
  const determinate = taskProgressView({ mode: 'determinate', label: 'Checking files', percentage: 37 }, 'running');
  assert.equal(determinate.kind, 'determinate');
  assert.equal(determinate.value, 37);
  assert.equal(determinate.state, '37%');
  assert.equal(determinate.progressAriaLabel, 'Checking files');
  
  const completed = taskProgressView({ mode: 'complete', label: 'Complete' }, 'completed');
  assert.equal(completed.kind, 'complete');
  assert.match(completed.className, /task-progress complete/);
  assert.equal(completed.value, 100);
  assert.equal(completed.role, 'status');
  
  const completedWithoutProgress = taskProgressView({}, 'completed');
  assert.equal(completedWithoutProgress.kind, 'complete');
  assert.equal(completedWithoutProgress.label, 'Complete');
  assert.match(completedWithoutProgress.ariaLabel, /Task completed/);
  
  console.log('Task progress view models terminal, paused, determinate, and indeterminate states without HTML rendering.');
}
await case_task_progress_unit();

// Formerly task-retrieval-quality-unit.mjs
async function case_task_retrieval_quality_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/context/taskContinuity.js");
    const { rankBootstrapGroups } = __m4;
  
    const __m5 = await import("../src/taskHistoryStore.ts");
    const { getTaskHistoryDir, readCrossWorkspaceTaskEpisodes, readRelevantTaskEpisodes } = __m5;
  
    const __m6 = await import("../src/taskHistoryStorage.ts");
    const { writeSession } = __m6;
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-retrieval-quality-'));
  const config = { stateDir: temp, auditLogPath: path.join(temp, 'audit.jsonl') };
  const historyDir = getTaskHistoryDir(config);
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  
  function completed(id, values = {}) {
    return {
      id,
      taskId: id,
      sessionId: id,
      version: 3,
      workspace: 'repo',
      title: id,
      objective: id,
      resultSummary: `Completed ${id}.`,
      status: 'completed',
      completionKnown: true,
      validation: 'passed',
      startedAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString(),
      completedAt: new Date(base).toISOString(),
      ...values
    };
  }
  
  try {
    writeSession(historyDir, completed('analytics-initial-render', {
      title: 'Overview analytics fails during initial mount',
      objective: 'Repair the overview analytics initial rendering failure',
      resultSummary: 'Fixed the analytics overview so its first mount renders data without requiring navigation.',
      changedFiles: [
        'src/ui/features/usage/react.js',
        ...Array.from({ length: 7 }, (_, index) => `src/ui/features/usage/${'nested-segment-'.repeat(20)}${index}.js`)
      ],
      updatedAt: new Date(base + 1_000).toISOString()
    }));
    writeSession(historyDir, completed('module-loader-error', {
      title: 'Repair browser module loader failure',
      objective: 'Fix production dashboard module resolution',
      resultSummary: 'Resolved ERR_MODULE_NOT_FOUND for QueryClient during dashboard startup.',
      changedFiles: ['src/ui/api.js'],
      updatedAt: new Date(base + 2_000).toISOString()
    }));
    writeSession(historyDir, completed('connector-timeout-recovery', {
      title: 'Secure connector timeout recovery',
      objective: 'Recover connector requests that exceed their deadline',
      resultSummary: 'Fixed connector timeout handling without changing unrelated connection behavior.',
      changedFiles: ['src/bridge/semanticSearch.js'],
      updatedAt: new Date(base + 3_000).toISOString()
    }));
    writeSession(historyDir, completed('deep-event-signature', {
      title: 'Repair production startup regression',
      objective: 'Restore production startup behavior',
      resultSummary: 'Restored startup behavior without unrelated changes.',
      changedFiles: ['src/runtime/startup.js'],
      events: [
        { eventId: 'deep-event-start', tool: 'relai_work', status: 'succeeded', summary: 'Started task.' },
        { eventId: 'deep-event-failure', tool: 'relai_exec', status: 'failed', summary: 'Command failed.', error: { code: 'UNIQUE_BOOTSTRAP_SENTINEL', message: 'Synthetic historical failure.' } }
      ],
      updatedAt: new Date(base + 3_500).toISOString()
    }));
    writeSession(historyDir, {
      ...completed('inactive-exact-words', {
        title: 'Analytics panel blank until switching tabs',
        objective: 'Analytics panel blank until switching tabs',
        resultSummary: 'This work was never explicitly completed.',
        updatedAt: new Date(base + 4_000).toISOString()
      }),
      status: 'inactive',
      completionKnown: false,
      completedAt: null
    });
  
    for (let index = 0; index < 100; index += 1) {
      writeSession(historyDir, completed(`newer-unrelated-${String(index).padStart(3, '0')}`, {
        title: `Update unrelated workspace preference ${index}`,
        objective: `Adjust unrelated settings preference number ${index}`,
        resultSummary: `Updated an unrelated preference safely for case ${index}.`,
        changedFiles: [`src/settings/preference-${index}.js`],
        updatedAt: new Date(base + 10_000 + index * 1_000).toISOString()
      }));
    }
    writeSession(historyDir, completed('lexical-distractor', {
      title: 'Polish analytics tab switch animation',
      objective: 'Improve analytics panel tab switching animation and styling',
      resultSummary: 'Updated the visual transition only; data loading behavior was unchanged.',
      changedFiles: ['src/ui/features/usage/styles.css'],
      updatedAt: new Date(base + 200_000).toISOString()
    }));
    writeSession(historyDir, completed('portable-secondary-noise', {
      workspace: 'portfolio',
      title: 'Refresh portfolio colors and button contrast',
      objective: 'Apply a new portfolio color palette without changing layout',
      resultSummary: 'Updated the portfolio appearance. A handoff also mentioned Rel.AI MCP model context skill behavior from unrelated work.',
      contextSummary: 'Unrelated notes referenced Rel.AI MCP model context optimization.',
      changedFiles: ['src/styles/theme.css'],
      updatedAt: new Date(base + 201_000).toISOString()
    }));
    writeSession(historyDir, completed('portable-primary-signal', {
      workspace: 'other-runtime',
      title: 'Repair UNIQUE_PORTABLE_SENTINEL connector timeout',
      objective: 'Fix UNIQUE_PORTABLE_SENTINEL connector timeout handling',
      resultSummary: 'Fixed the portable connector timeout failure.',
      changedFiles: ['src/connector/timeout.js'],
      updatedAt: new Date(base + 202_000).toISOString()
    }));
  
    const cases = [
      {
        query: 'The analytics panel is blank until I switch tabs',
        expected: 'analytics-initial-render'
      },
      {
        query: 'Dashboard startup fails with ERR_MODULE_NOT_FOUND for QueryClient',
        expected: 'module-loader-error'
      },
      {
        query: 'Initial display is broken in src/ui/features/usage/react.js',
        expected: 'analytics-initial-render'
      },
      {
        query: 'Blank content in src/ui/features/usage/metrics-loader.js',
        expected: 'analytics-initial-render'
      },
      {
        query: 'Connector request keeps hitting its timeout deadline',
        expected: 'connector-timeout-recovery'
      },
      {
        query: 'Investigate UNIQUE_BOOTSTRAP_SENTINEL',
        expected: 'deep-event-signature'
      }
    ];
  
    let top1 = 0;
    let top3 = 0;
    for (const item of cases) {
      const results = readRelevantTaskEpisodes(config, 'repo', item.query, { limit: 3 });
      const goals = results.map(result => result.goal || '');
      const expectedIndex = goals.findIndex(goal => {
        if (item.expected === 'analytics-initial-render') return /overview analytics/i.test(goal);
        if (item.expected === 'module-loader-error') return /production dashboard module resolution/i.test(goal);
        if (item.expected === 'deep-event-signature') return /production startup behavior/i.test(goal);
        return /connector requests that exceed/i.test(goal);
      });
      if (expectedIndex === 0) top1 += 1;
      if (expectedIndex >= 0 && expectedIndex < 3) top3 += 1;
      assert.notEqual(expectedIndex, -1, `expected ${item.expected} in top 3 for: ${item.query}`);
    }
  
    assert.equal(top1, cases.length, 'adversarial retrieval fixtures should rank the correct completed task first');
    assert.equal(top3, cases.length, 'adversarial retrieval fixtures should always contain the correct task in the top three');
  
    const paraphrase = readRelevantTaskEpisodes(config, 'repo', 'The analytics panel is blank until I switch tabs', { limit: 3 });
    assert.match(paraphrase[0]?.goal || '', /overview analytics/i, 'same underlying task must survive substantially different wording');
    assert.equal(paraphrase.some(item => /animation/i.test(item.goal || '')), false, 'shared navigation vocabulary must not outrank the matching failure symptom');
    assert.equal(paraphrase.some(item => /blank until switching tabs/i.test(item.goal || '')), false, 'inactive work must not be presented as a proven completed solution');
    assert(['medium', 'strong'].includes(paraphrase[0]?.matchStrength), 'paraphrase retrieval should have at least medium confidence');
    assert(paraphrase[0]?.confidence >= 0.4);
    assert(paraphrase[0]?.matchReasons?.some(reason => /shared intent/i.test(reason)));
    assert((paraphrase[0]?.changes || []).length <= 6, 'retrieved task context must keep changed-file evidence bounded');
    assert((paraphrase[0]?.changes || []).every(file => file.length <= 160), 'retrieved task paths must be compact enough for bootstrap context');
    assert.equal(rankBootstrapGroups('analytics blank first render', { relatedTasks: [paraphrase[0]] }, 4096).relatedTasks?.length, 1,
      'the strongest real historical task should fit the normal bootstrap budget even when the stored task changed many long paths');
  
    const oldMatch = readRelevantTaskEpisodes(config, 'repo', 'Overview analytics initial rendering failure', { limit: 3 });
    assert.match(oldMatch[0]?.goal || '', /overview analytics/i, 'a correct task older than 80 newer same-workspace tasks must remain retrievable');
  
    const renamedFile = readRelevantTaskEpisodes(config, 'repo', 'Blank content in src/ui/features/usage/metrics-loader.js', { limit: 3 });
    assert.match(renamedFile[0]?.goal || '', /overview analytics/i, 'same-subsystem evidence must survive a renamed or different file in the same feature area');
    assert(renamedFile[0]?.matchReasons?.some(reason => /same area/i.test(reason)), 'same-subsystem retrieval should explain the matching directory evidence');
  
    const deepEvent = readRelevantTaskEpisodes(config, 'repo', 'Investigate UNIQUE_BOOTSTRAP_SENTINEL', { limit: 3 });
    assert.match(deepEvent[0]?.goal || '', /production startup behavior/i, 'exact error or test evidence must remain searchable even when compact full-history summaries omit event arrays');
    assert(deepEvent[0]?.matchReasons?.some(reason => /same identifier/i.test(reason)), 'exact event evidence should explain the identifier match');
  
    const generic = readRelevantTaskEpisodes(config, 'repo', 'update analytics styling', { limit: 3 });
    assert.equal(generic.some(item => /overview analytics/i.test(item.goal || '')), false, 'one shared domain word must not create a false positive');
  
    const portableNoise = readCrossWorkspaceTaskEpisodes(config, 'repo', 'Optimize Rel.AI MCP model context skill behavior', { limit: 4 });
    assert.equal(portableNoise.some(item => /portfolio color palette/i.test(item.goal || '')), false,
      'secondary handoff/context vocabulary must not turn unrelated cross-workspace work into portable task evidence');
    const portableSignal = readCrossWorkspaceTaskEpisodes(config, 'repo', 'Investigate UNIQUE_PORTABLE_SENTINEL connector timeout', { limit: 4 });
    assert.match(portableSignal[0]?.goal || '', /UNIQUE_PORTABLE_SENTINEL/i,
      'distinctive primary cross-workspace evidence must remain portable');
  
    for (const unrelatedQuery of [
      'Rename analytics tab label',
      'Optimize chart rendering performance',
      'Change analytics navigation route',
      'Add analytics navigation breadcrumb',
      'Change analytics empty-state copy',
      'Add keyboard navigation to analytics tabs'
    ]) {
      const unrelated = readRelevantTaskEpisodes(config, 'repo', unrelatedQuery, { limit: 3 });
      assert.equal(unrelated.some(item => /overview analytics/i.test(item.goal || '')), false,
        `presentation or optimization work must not retrieve the historical blank-render bug: ${unrelatedQuery}`);
    }
  
    const softerParaphrase = readRelevantTaskEpisodes(config, 'repo', 'Improve analytics initial load behavior', { limit: 3 });
    assert.match(softerParaphrase[0]?.goal || '', /overview analytics/i,
      'mode-aware ranking must still allow a softer paraphrase of the same initial-load problem');
  
    const reserved = rankBootstrapGroups('analytics blank first render', {
      suggestedSkills: [
        { name: 'analytics-review', reason: 'analytics '.repeat(45) },
        { name: 'render-review', reason: 'render '.repeat(45) }
      ],
      relatedTasks: [{
        goal: 'Overview analytics initial render',
        outcome: 'Fixed initial rendering.',
        confidence: 0.91,
        matchStrength: 'strong',
        matchReasons: ['same path: src/ui/features/usage/react.js']
      }]
    }, 700);
    assert.equal(reserved.relatedTasks?.length, 1, 'a strong historical task match must receive bootstrap budget before lower-value supplemental context');
  
    console.log(`Task retrieval quality: top1=${top1}/${cases.length}, top3=${top3}/${cases.length}; full 500-task retained history is eligible for ranking.`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
await case_task_retrieval_quality_unit();

// Formerly task-semantic-progress-unit.mjs
async function case_task_semantic_progress_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/core/dashboard-data.ts");
    const { summarizeDashboardTask } = __m1;
  
    const __m2 = await import("../src/taskSemanticProgress.js");
    const { buildTaskSemanticProgress, classifyTaskChangedFiles, semanticMilestoneForEvent } = __m2;
  
  const files = classifyTaskChangedFiles([
    'tools/apktool.jar',
    'decoded/smali/com/example/PremiumGate.smali',
    '.relai/cache/native-index.bin'
  ]);
  assert.deepEqual(files.productFiles, ['decoded/smali/com/example/PremiumGate.smali']);
  assert.deepEqual(files.supportArtifacts, ['tools/apktool.jar', '.relai/cache/native-index.bin']);
  
  const nativeInspection = semanticMilestoneForEvent({
    timestamp: '2026-08-29T12:00:00.000Z',
    status: 'succeeded',
    tool: { name: 'exec' },
    summary: 'Ran powershell.exe -NoProfile -Command "$b=[IO.File]::ReadAllBytes(\'C:\\\\Dev\\\\instaprime-bypass\\\\decoded\\\\lib\\\\arm64-v8a\\\\libprimemods.so\'); $s=[Text.Encoding]::ASCII.GetString($b)". Exit code 0.'
  });
  assert.equal(nativeInspection?.label, 'Inspected native binary');
  assert.equal(nativeInspection?.detail, 'libprimemods.so');
  assert.doesNotMatch(nativeInspection?.label || '', /powershell/i);
  
  const task = buildTaskSemanticProgress({
    status: 'planning',
    activeCalls: 0,
    currentStage: 'Planning next step',
    currentActivity: 'Waiting for the next task step',
    changedFiles: ['tools/apktool.jar'],
    events: [
      {
        timestamp: '2026-08-29T11:55:00.000Z',
        status: 'succeeded',
        tool: { name: 'snapshot' },
        summary: 'Read repository and workspace status.'
      },
      {
        timestamp: '2026-08-29T11:57:00.000Z',
        status: 'succeeded',
        tool: { name: 'exec' },
        summary: 'Ran java -jar tools/apktool.jar d "InstaPrime V7.2 64bit UnClone.apk" -o decoded. Exit code 0.'
      },
      {
        timestamp: '2026-08-29T12:00:00.000Z',
        status: 'succeeded',
        tool: { name: 'exec' },
        summary: 'Ran powershell.exe -NoProfile -Command "$b=[IO.File]::ReadAllBytes(\'C:\\\\Dev\\\\instaprime-bypass\\\\decoded\\\\lib\\\\arm64-v8a\\\\libprimemods.so\')". Exit code 0.'
      },
      {
        timestamp: '2026-08-29T12:01:00.000Z',
        status: 'succeeded',
        tool: { name: 'work.status' },
        summary: 'Reading workspace and repository status for instaprime-bypass.'
      }
    ]
  });
  
  assert.equal(task.currentStage, 'Latest meaningful progress');
  assert.equal(task.currentActivity, 'Inspected native binary · libprimemods.so');
  assert.equal(task.productChangedFileCount, 0);
  assert.equal(task.supportArtifactCount, 1);
  assert.deepEqual(task.milestones.map(item => item.label), [
    'Inventoried project structure',
    'Decompiled application artifact',
    'Inspected native binary'
  ]);
  assert.equal(task.milestones.some(item => /repository status|powershell/i.test(`${item.label} ${item.detail || ''}`)), false);
  
  const projectEdit = semanticMilestoneForEvent({
    timestamp: '2026-08-29T12:02:00.000Z',
    status: 'succeeded',
    tool: { name: 'edit' },
    metadata: { changedFiles: ['src/app.js'], internalOperation: 'edit' }
  });
  assert.equal(projectEdit?.label, 'Updated project file');
  assert.equal(projectEdit?.tool, 'relai_edit');
  
  const relationshipInspection = semanticMilestoneForEvent({
    timestamp: '2026-08-29T12:03:00.000Z',
    status: 'succeeded',
    tool: { name: 'inspect.references' },
    metadata: { internalOperation: 'inspect.references', publicAction: 'references' }
  });
  assert.equal(relationshipInspection?.tool, 'relai_inspect');
  assert.equal(relationshipInspection?.action, 'references');
  
  const genericCommand = 'Write-Host "one  two"\nGet-ChildItem';
  const commandWithoutDetails = semanticMilestoneForEvent({
    eventId: 'exec-generic',
    timestamp: '2026-08-29T12:04:00.000Z',
    status: 'succeeded',
    tool: { name: 'exec' },
    command: genericCommand,
    summary: 'Ran repository command. Exit code 0.'
  });
  assert.equal(commandWithoutDetails?.label, 'Ran project command');
  assert.equal(Object.hasOwn(commandWithoutDetails || {}, 'command'), false, 'compact semantic summaries must omit command text');
  const commandWithDetails = semanticMilestoneForEvent({
    eventId: 'exec-generic',
    timestamp: '2026-08-29T12:04:00.000Z',
    status: 'succeeded',
    tool: { name: 'exec' },
    command: genericCommand,
    summary: 'Ran repository command. Exit code 0.'
  }, { includeCommands: true });
  assert.equal(commandWithDetails?.command, genericCommand, 'detail semantics must expose the recorded command');
  assert.equal(commandWithDetails?.tool, 'relai_exec');
  
  const projected = summarizeDashboardTask({
    taskId: 'task-semantic',
    status: 'planning',
    activeCalls: 0,
    currentStage: 'Planning next step',
    currentActivity: 'Waiting for the next task step',
    changedFiles: ['tools/apktool.jar'],
    events: [{
      timestamp: '2026-08-29T12:00:00.000Z',
      status: 'succeeded',
      tool: { name: 'exec' },
      summary: 'Ran powershell.exe -NoProfile -Command "$b=[IO.File]::ReadAllBytes(\'C:\\\\Dev\\\\instaprime-bypass\\\\decoded\\\\lib\\\\arm64-v8a\\\\libprimemods.so\')". Exit code 0.'
    }]
  });
  assert.equal(Object.hasOwn(projected, 'events'), false, 'dashboard summaries must stay compact and omit raw event timelines');
  assert.equal(projected.semanticProgress.currentActivity, 'Inspected native binary · libprimemods.so');
  assert.equal(projected.semanticProgress.productChangedFileCount, 0);
  assert.equal(projected.semanticProgress.supportArtifactCount, 1);
  
  console.log('Semantic task progress promotes meaningful work and keeps raw tool telemetry out of the task card.');
}
await case_task_semantic_progress_unit();

// Formerly task-state-unit.mjs
async function case_task_state_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
  const {
    CANONICAL_TASK_STATUSES,
    NATIVE_TASK_STATUSES,
    TASK_TRANSITIONS,
    assertTaskStatusTransition,
    canTransitionTaskStatus,
    internalStatusToDashboardStatus,
    isCanonicalTaskStatus,
    isNativeTaskStatus,
    isTerminalDashboardTaskStatus,
    isTerminalNativeTaskStatus,
    isTerminalTaskStatus,
    nativeStatusToInternalStatus,
    normalizeHistoricalTaskStatus,
    normalizeLiveTaskStatus,
    transitionTaskStatus
  } = await import('../src/taskState.js');
  
  assert.deepEqual(CANONICAL_TASK_STATUSES, [
    'queued', 'planning', 'running', 'waiting_for_approval', 'blocked', 'validating',
    'validation_failed', 'inactive', 'completed', 'failed', 'cancelled'
  ]);
  for (const status of CANONICAL_TASK_STATUSES) assert.equal(isCanonicalTaskStatus(status), true, status);
  assert.deepEqual(NATIVE_TASK_STATUSES, ['working', 'input_required', 'completed', 'failed', 'cancelled']);
  for (const status of NATIVE_TASK_STATUSES) assert.equal(isNativeTaskStatus(status), true, status);
  assert.equal(isNativeTaskStatus('running'), false, 'internal and native protocol status vocabularies remain distinct');
  assert.equal(nativeStatusToInternalStatus('working'), 'running');
  assert.equal(nativeStatusToInternalStatus('input_required'), 'blocked');
  assert.equal(nativeStatusToInternalStatus('completed'), 'completed');
  assert.equal(nativeStatusToInternalStatus('unknown'), '');
  assert.equal(isTerminalNativeTaskStatus('completed'), true);
  assert.equal(isTerminalNativeTaskStatus('working'), false);
  assert.equal(isTerminalNativeTaskStatus('unknown'), false);
  assert.equal(normalizeLiveTaskStatus('blocked', {}, { blockedMeansApproval: true }), 'waiting_for_approval');
  assert.equal(normalizeLiveTaskStatus('blocked'), 'blocked');
  assert.equal(normalizeLiveTaskStatus('working'), 'running');
  assert.equal(internalStatusToDashboardStatus('completed_with_warnings'), 'completed');
  assert.equal(internalStatusToDashboardStatus('inactive', { failures: 1 }), 'inactive');
  assert.equal(isTerminalDashboardTaskStatus('expired'), false);
  assert.equal(isTerminalDashboardTaskStatus('running'), false);
  for (const status of ['completed', 'failed', 'cancelled']) assert.equal(isTerminalTaskStatus(status), true, status);
  assert.equal(isCanonicalTaskStatus('completed_with_warnings'), false, 'legacy warning status is not canonical');
  for (const status of ['queued', 'planning', 'running', 'waiting_for_approval', 'blocked', 'validating', 'validation_failed', 'inactive']) assert.equal(isTerminalTaskStatus(status), false, status);
  
  for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
    for (const target of targets) {
      assert.equal(canTransitionTaskStatus(from, target), true, `${from} -> ${target}`);
      assert.equal(assertTaskStatusTransition(from, target), target);
    }
  }
  assert.equal(canTransitionTaskStatus('completed', 'running'), false);
  assert.equal(canTransitionTaskStatus('failed', 'planning'), false);
  assert.equal(canTransitionTaskStatus('validation_failed', 'running'), true);
  assert.equal(canTransitionTaskStatus('validation_failed', 'validating'), true);
  assert.equal(canTransitionTaskStatus('validating', 'planning'), true);
  assert.equal(canTransitionTaskStatus('cancelled', 'validating'), false);
  assert.throws(() => assertTaskStatusTransition('completed', 'running'), error => error?.code === 'INVALID_TASK_STATE');
  
  const explicitRuntime = { status: 'queued' };
  assert.equal(transitionTaskStatus(explicitRuntime, 'running'), 'running');
  assert.equal(transitionTaskStatus(explicitRuntime, 'validating'), 'validating');
  assert.equal(transitionTaskStatus(explicitRuntime, 'completed'), 'completed');
  assert.equal(explicitRuntime.status, 'completed');
  assert.throws(() => transitionTaskStatus(explicitRuntime, 'running'), error => error?.code === 'INVALID_TASK_STATE');
  assert.equal(explicitRuntime.status, 'completed', 'invalid transitions must not mutate terminal task state');
  
  assert.equal(normalizeHistoricalTaskStatus('working'), 'running');
  assert.equal(normalizeHistoricalTaskStatus('waiting'), 'planning');
  assert.equal(normalizeHistoricalTaskStatus('awaiting_approval'), 'waiting_for_approval');
  assert.equal(normalizeHistoricalTaskStatus('attention', { failures: 1 }), 'failed');
  assert.equal(normalizeHistoricalTaskStatus('attention', { completionKnown: true, failures: 1 }), 'completed');
  assert.equal(normalizeHistoricalTaskStatus('inactive', { endedAt: Date.now() }), 'inactive');
  assert.equal(normalizeHistoricalTaskStatus('inactive', { failures: 1, errorSummary: 'failed' }), 'inactive');
  assert.equal(normalizeHistoricalTaskStatus('inactive', { completionKnown: true }), 'completed');
  assert.equal(normalizeHistoricalTaskStatus('inactive', { completionKnown: true, failures: 1 }), 'completed');
  assert.equal(normalizeHistoricalTaskStatus('completed_with_warnings', { completionKnown: true, failures: 1 }), 'completed');
  assert.equal(normalizeHistoricalTaskStatus('cancelled', { completionKnown: false, endReason: 'inactivity_window' }), 'inactive');
  assert.equal(normalizeHistoricalTaskStatus('failed', { completionKnown: false, endReason: 'inactivity_window' }), 'inactive');
  assert.equal(normalizeHistoricalTaskStatus('cancelled', { completionKnown: false, endReason: 'explicit_cancellation', cancellationInitiator: 'user' }), 'cancelled');
  assert.equal(normalizeHistoricalTaskStatus('inactive', { completionKnown: false, endReason: 'terminal_failure', terminal: true }), 'failed');
  assert.equal(normalizeHistoricalTaskStatus('unknown-terminal', { endedAt: Date.now() }), 'cancelled');
  assert.equal(normalizeHistoricalTaskStatus('unknown-active', {}), 'planning');
  
  const { workSessionStateView } = await import('../src/ui/task-identity.js');
  const { isOngoingSession, sessionSummary } = await import('../src/ui/features/sessions/index.js');
  const runningView = workSessionStateView({ status: 'running', state: 'working', activeCalls: 1 });
  assert.equal(runningView.active, true);
  assert.equal(runningView.open, false);
  const openPlanningView = workSessionStateView({ status: 'planning', state: 'waiting', activeCalls: 0 });
  assert.equal(openPlanningView.active, false, 'an idle planning task must not be counted as actively running');
  assert.equal(openPlanningView.open, true, 'an idle planning task must remain explicitly open and resumable');
  assert.equal(isOngoingSession({ status: 'planning', state: 'waiting', activeCalls: 0 }), true, 'open idle work remains ongoing for session rendering');
  assert.equal(workSessionStateView({ status: 'cancelled', activeCalls: 0 }).open, false);
  assert.equal(
    sessionSummary([
      { status: 'running', state: 'working', activeCalls: 1 },
      { status: 'planning', state: 'waiting', activeCalls: 0 },
      { status: 'inactive', activeCalls: 0 },
      { status: 'completed', activeCalls: 0 },
      { status: 'cancelled', activeCalls: 0 }
    ]),
    '1 active · 1 open · 1 inactive · 1 completed · 1 cancelled',
    'session counts must keep running, open idle, inactive, completed, and cancelled work distinct'
  );
  
  console.log('Canonical task-state vocabulary, transitions, terminal protection, historical normalization, and open-idle counting passed.');
}
await case_task_state_unit();

// Formerly task-trace-unit.mjs
async function case_task_trace_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/features/sessions/index.js");
    const { taskTraceJsonl } = __m1;
  
  const session = {
    trace: {
      entries: [
        { auditId: 'a1', taskId: 'task-1', tool: 'read', ok: true },
        { auditId: 'a2', taskId: 'task-1', tool: 'exec', ok: false, error: 'failed' }
      ]
    }
  };
  const jsonl = taskTraceJsonl(session);
  const rows = jsonl.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows, session.trace.entries);
  assert.equal(taskTraceJsonl({}), '');
  console.log('Task trace JSONL export tests passed.');
}
await case_task_trace_unit();

// Formerly taskbar-completion-badge-unit.mjs
async function case_taskbar_completion_badge_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/taskbar-completion-badge.js");
    const { MAX_BADGE_COUNT, createBadgeImage, createTaskbarCompletionBadge } = __m1;
  
  const overlays = [];
  const images = [];
  const badgeBuffers = [];
  const badgeRepresentations = [];
  let legacyDataUrlCalls = 0;
  let applicationOpen = false;
  const win = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    setOverlayIcon(image, description) { overlays.push({ image, description }); }
  };
  const nativeImage = {
    createFromDataURL(dataUrl) {
      legacyDataUrlCalls += 1;
      return {
        dataUrl,
        isEmpty() { return true; },
        resize(options) { this.resizeOptions = options; return this; }
      };
    },
    createFromBuffer(buffer) {
      badgeBuffers.push(buffer);
      const image = {
        buffer,
        isEmpty() { return false; },
        addRepresentation(options) { badgeRepresentations.push(options); }
      };
      images.push(image);
      return image;
    }
  };
  const badge = createTaskbarCompletionBadge({
    nativeImage,
    platform: 'win32',
    getWindow: () => win,
    isApplicationOpen: () => applicationOpen
  });
  
  assert.deepEqual(badge.getStatus(), { count: 0, visible: false, supported: true });
  badge.markCompleted({ taskId: 'task-1' });
  assert.equal(badge.getStatus().count, 1);
  assert.equal(overlays.at(-1).description, '1 completed task waiting to be viewed');
  assert.ok(overlays.at(-1).image);
  assert.equal(overlays.at(-1).image.isEmpty(), false, 'Windows must receive a decodable overlay image');
  assert.equal(legacyDataUrlCalls, 0, 'Electron badge overlays must use a supported PNG buffer, not an SVG data URL');
  assert.equal(badgeBuffers.length, 1);
  assert.deepEqual([...badgeBuffers[0].subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(badgeRepresentations.length, 6, 'Windows badge must include high-DPI representations instead of stretching one 16px raster');
  assert.deepEqual(badgeRepresentations.map(item => item.scaleFactor), [1.25, 1.5, 1.75, 2, 2.5, 3]);
  assert.deepEqual(badgeRepresentations.map(item => item.buffer.readUInt32BE(16)), [20, 24, 28, 32, 40, 48]);
  
  badge.markCompleted({ taskId: 'task-1' });
  assert.equal(badge.getStatus().count, 1, 'duplicate completion must not increase unread count');
  badge.markCompleted({ taskId: 'task-2' });
  assert.equal(badge.getStatus().count, 2);
  assert.notEqual(Buffer.compare(badgeBuffers[0], badgeBuffers.at(-1)), 0, 'different counts must render different badge images');
  
  badge.clear();
  assert.equal(badge.getStatus().count, 0);
  assert.equal(overlays.at(-1).image, null);
  assert.equal(overlays.at(-1).description, '');
  badge.markCompleted({ taskId: 'task-2' });
  assert.equal(badge.getStatus().count, 0, 'a duplicate event must not recreate a cleared badge');
  
  applicationOpen = true;
  badge.markCompleted({ taskId: 'task-3' });
  assert.equal(badge.getStatus().count, 0, 'visible focused application work is not unread');
  applicationOpen = false;
  for (let index = 4; index < 120; index += 1) badge.markCompleted({ taskId: `task-${index}` });
  assert.equal(badge.getStatus().count, MAX_BADGE_COUNT);
  assert.notEqual(Buffer.compare(badgeBuffers[0], badgeBuffers.at(-1)), 0, 'the capped count must still render its numeric badge');
  assert.equal(badgeBuffers.length, 10, 'Windows must rasterize only the nine digit badges plus one shared 9+ image');
  const rendersAtCap = badgeBuffers.length;
  badge.markCompleted({ taskId: 'task-over-cap' });
  assert.equal(badgeBuffers.length, rendersAtCap, 'additional completions at the 99 cap must not regenerate an identical overlay');
  
  const direct = createBadgeImage(nativeImage, 7);
  assert.ok(direct);
  assert.equal(direct.isEmpty(), false);
  
  const repeated = createBadgeImage(nativeImage, 7);
  assert.equal(Buffer.compare(direct.buffer, repeated.buffer), 0, 'the same unread count must render a stable taskbar badge image');
  
  const overflowBadge = createBadgeImage(nativeImage, 10);
  const cappedOverflowBadge = createBadgeImage(nativeImage, MAX_BADGE_COUNT);
  assert.equal(
    Buffer.compare(overflowBadge.buffer, cappedOverflowBadge.buffer),
    0,
    'double-digit unread counts must share the compact 9+ badge instead of squeezing two digits into the overlay'
  );
  
  const linuxBadgeCounts = [];
  const linuxBadge = createTaskbarCompletionBadge({
    app: {
      setBadgeCount(count) {
        linuxBadgeCounts.push(count);
        return true;
      }
    },
    nativeImage,
    platform: 'linux',
    getWindow: () => win
  });
  linuxBadge.markCompleted({ taskId: 'linux-task' });
  assert.deepEqual(linuxBadge.getStatus(), { count: 1, visible: true, supported: true });
  assert.deepEqual(linuxBadgeCounts, [1], 'Linux launcher badge must receive the unread count');
  linuxBadge.clear();
  assert.deepEqual(linuxBadge.getStatus(), { count: 0, visible: false, supported: true });
  assert.deepEqual(linuxBadgeCounts, [1, 0], 'opening the app must explicitly clear the Linux launcher badge');
  
  console.log('Cross-platform task completion badge count, rendering, deduplication, and clearing tests passed.');
}
await case_taskbar_completion_badge_unit();
