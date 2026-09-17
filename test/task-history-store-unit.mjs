import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearTaskHistory, getTaskHistoryDir, readCrossWorkspaceTaskEpisodes, readRecentWorkflowEvidence, readRelevantTaskEpisodes, readTaskHistory, readTaskHistorySessionRecord, recordTaskHistoryEvent, recordWorkflowEvidenceBatch } from "../src/taskHistoryStore.ts";
import { writeSession } from '../src/taskHistoryStorage.ts';
import { principalFingerprint } from '../src/mcp/principal.js';
import { assertKnownTask } from '../src/tools/task.js';

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
  assert.equal(stalePlanning.currentStage, 'Waiting for next action');
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

  clearTaskHistory(config);
  assert.equal(fs.existsSync(historyDir), false);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log('Persistent task history hard-cuts pre-current records and stores exact current task IDs.');
