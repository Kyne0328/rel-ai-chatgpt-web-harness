import { callTool as rawCallTool } from "../src/tools.js";
import { getToolActivity, resetToolActivity } from "../src/toolActivity.js";
import { readConfig } from "../src/config.js";
import { flushAuditWrites, getAuditPath, readAudit } from "../src/audit.js";
import { flushLocalAnalytics, readLocalUsageSnapshot } from "../src/localAnalytics.js";
import { repositoryIntelligence } from "../src/repository/intelligence/service.js";
import { resetTaskHistoryCaches } from "../src/taskHistoryStorage.ts";
import { flushTaskHistoryPersistence } from "../src/taskHistoryStore.ts";
import { readSessionPolicy } from "../src/policyResolver.js";
import { readTaskIntegrity } from '../src/taskIntegrity.ts';
import { withStateDatabase } from '../src/stateDatabase.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-task-completion-'));
const workspace = path.join(temp, 'workspace');
const plainWorkspace = path.join(temp, 'plain-workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;

fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.mkdirSync(path.join(plainWorkspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'src', 'index.js'), 'console.log("ready");\n', 'utf8');
fs.writeFileSync(path.join(plainWorkspace, 'src', 'index.js'), 'console.log("plain");\n', 'utf8');
fs.writeFileSync(path.join(plainWorkspace, 'package.json'), JSON.stringify({ scripts: { check: 'node --check src/index.js' } }, null, 2), 'utf8');
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
  scripts: { check: 'node --check src/index.js' }
}, null, 2), 'utf8');
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspace });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  workspaces: {
    app: {
      path: workspace,
      commands: {},
      testCommands: { check: 'npm run check' }
    },
    plain: {
      path: plainWorkspace
    }
  }
}, null, 2), 'utf8');
process.env.REL_AI_MCP_CONFIG = configPath;

try {






  async function startTask(scopeId) {
    const result = await callTool('relai_work', { action: 'begin', workspace: 'app' }, {
      publicHttpOnly: true,
      requestId: `${scopeId}:start`,
      transportType: 'test',
      transportSessionId: 'shared-test-transport'
    });
    assert.ok(result.work_id, 'task start must return an opaque work_id');
    return result.work_id;
  }

  resetToolActivity();
  const plainReadTask = await callTool('relai_work', {
    action: 'begin', workspace: 'plain', bootstrap: 'none'
  }, { publicHttpOnly: true });
  const plainReadCompletion = await callTool('relai_work', {
    action: 'finish', workspace: 'plain', work_id: plainReadTask.work_id,
    summary: 'Read-only non-Git task completed.'
  }, { publicHttpOnly: true });
  assert.equal(plainReadCompletion.completionKnown, true, 'read-only work in a non-Git project must finish normally');
  assert.equal(plainReadCompletion.residualState, 'clean');

  resetToolActivity();
  const plainEditTask = await callTool('relai_work', {
    action: 'begin', workspace: 'plain', bootstrap: 'none'
  }, { publicHttpOnly: true });
  await callTool('relai_edit', {
    workspace: 'plain', work_id: plainEditTask.work_id, path: 'src/index.js',
    content: 'console.log("plain updated");\n'
  }, { publicHttpOnly: true });
  const plainEditCompletion = await callTool('relai_validate', {
    action: 'checks', workspace: 'plain', work_id: plainEditTask.work_id,
    check: 'node --check src/index.js', complete: true,
    summary: 'Validated non-Git task completed.'
  }, { publicHttpOnly: true });
  assert.equal(plainEditCompletion.completionKnown, true, 'validated edits in a non-Git project must finish normally');
  assert.equal(plainEditCompletion.residualState, 'preserved_uncommitted');
  assert.deepEqual(plainEditCompletion.residualChangedFiles, ['src/index.js'], 'non-Git task-owned edits must be preserved conservatively');
  assert.equal(getToolActivity().lastTask?.status, 'completed');

  resetToolActivity();
  const unvalidatedTask = await startTask('completion-without-validation');
  const readOnlyCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: unvalidatedTask,
    summary: 'Read-only task completed without validation.'
  }, { publicHttpOnly: true });
  assert.equal(readOnlyCompletion.ok, true);
  assert.equal(readOnlyCompletion.work_id, unvalidatedTask);
  assert.equal(readOnlyCompletion.validationStatus, 'not_required');
  assert.equal(readOnlyCompletion.completionKnown, true);
  assert.deepEqual(readOnlyCompletion.changedFiles || [], [], 'read-only completion must not claim ambient repository changes');
  const terminalProcessList = await callTool('relai_process', {
    action: 'list',
    workspace: 'app',
    work_id: unvalidatedTask
  }, { publicHttpOnly: true });
  assert.equal(terminalProcessList.ok, true, 'safe process observation may reuse a completed work_id');
  await assert.rejects(
    () => callTool('relai_edit', {
      workspace: 'app',
      work_id: unvalidatedTask,
      path: 'src/must-not-reopen.js',
      content: 'console.log("must stay terminal");\n'
    }, { publicHttpOnly: true }),
    error => error?.code === 'INVALID_TASK_STATE'
  );

  resetToolActivity();
  const missingAuthorityTask = await startTask('missing-authority-fail-closed');
  const runtimeConfig = readConfig();
  assert.ok(readTaskIntegrity(runtimeConfig, missingAuthorityTask, 'app'), 'task start must create authoritative integrity state');
  withStateDatabase(runtimeConfig, db => {
    db.prepare('DELETE FROM task_integrity_tasks WHERE task_id=?').run(missingAuthorityTask);
  }, { transaction: true });
  assert.equal(readTaskIntegrity(runtimeConfig, missingAuthorityTask, 'app'), null, 'test sabotage must remove authoritative integrity state');
  const blockedMutationPath = path.join(workspace, 'src', 'missing-authority-mutation.js');
  await assert.rejects(
    () => callTool('relai_edit', {
      workspace: 'app',
      work_id: missingAuthorityTask,
      path: 'src/missing-authority-mutation.js',
      content: 'throw new Error("must not be written");\n'
    }, { publicHttpOnly: true }),
    error => error?.code === 'TASK_INTEGRITY_STATE_MISSING'
  );
  assert.equal(fs.existsSync(blockedMutationPath), false, 'missing authority must block mutation before handler execution');
  const missingAuthorityCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: missingAuthorityTask,
    summary: 'Missing mutation authority does not prevent closing a non-mutating durable task.'
  }, { publicHttpOnly: true });
  assert.equal(missingAuthorityCompletion.completionKnown, true);
  assert.equal(missingAuthorityCompletion.validationStatus, 'not_run');

  resetToolActivity();
  const cancelledTask = await startTask('explicit-cancellation-terminal');
  const cancellation = await callTool('relai_work', { action: 'cancel',
    workspace: 'app',
    work_id: cancelledTask,
    reason: 'Cancellation must remain terminal.'
  }, { publicHttpOnly: true });
  assert.equal(cancellation.status, 'cancelled');
  await assert.rejects(
    () => callTool('relai_work', { action: 'finish',
      workspace: 'app',
      work_id: cancelledTask,
      summary: 'A cancelled task must not transition to completed.'
    }, { publicHttpOnly: true }),
    error => error?.code === 'INVALID_TASK_STATE'
  );

  resetToolActivity();
  const lowRiskTask = await startTask('low-risk-documentation-without-validation');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: lowRiskTask,
    path: 'README.md',
    content: '# Fixture documentation\n'
  }, { publicHttpOnly: true });
  const lowRiskCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: lowRiskTask,
    summary: 'Documentation-only task completed without ceremonial validation.'
  }, { publicHttpOnly: true });
  assert.equal(lowRiskCompletion.ok, true);
  assert.equal(lowRiskCompletion.validationStatus, 'not_run');
  assert.deepEqual(lowRiskCompletion.changedFiles, ['README.md']);

  resetToolActivity();
  const failedLowRiskTask = await startTask('low-risk-documentation-with-failed-check');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: failedLowRiskTask,
    path: 'docs/failed-check.md',
    content: '# Documentation with an explicit failed check\n'
  }, { publicHttpOnly: true });
  const failedLowRiskValidation = await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: failedLowRiskTask,
    check: 'node -e "process.exit(1)"'
  }, { publicHttpOnly: true });
  assert.equal(failedLowRiskValidation.validationStatus, 'failed');
  const failedLowRiskCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: failedLowRiskTask,
    summary: 'The agent may finish while Rel.AI truthfully records the failed validation.'
  }, { publicHttpOnly: true });
  assert.equal(failedLowRiskCompletion.completionKnown, true);
  assert.equal(failedLowRiskCompletion.validationStatus, 'failed');

  resetToolActivity();
  const unvalidatedMutationTask = await startTask('mutation-without-validation');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: unvalidatedMutationTask,
    path: 'src/unvalidated.js',
    content: 'console.log("unvalidated mutation");\n'
  }, { publicHttpOnly: true });
  const unvalidatedMutationCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: unvalidatedMutationTask,
    summary: 'The agent finished this mutation without running repository validation.'
  }, { publicHttpOnly: true });
  assert.equal(unvalidatedMutationCompletion.completionKnown, true);
  assert.equal(unvalidatedMutationCompletion.validationStatus, 'not_run');
  assert.equal(getToolActivity().lastTask?.status, 'completed');

  resetToolActivity();
  const missingSummaryTask = await startTask('atomic-completion-without-summary');
  const generatedSummaryCompletion = await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: missingSummaryTask,
    level: 'standard'
  }, { publicHttpOnly: true });
  assert.equal(generatedSummaryCompletion.completionKnown, true, 'successful validation with work_id must close the durable task by default');
  assert.match(generatedSummaryCompletion.summary, /completed|validation passed/i, 'default completion must derive a non-empty summary');

  resetToolActivity();
  const failedAtomicTask = await startTask('failed-atomic-completion');
  const failedAtomic = await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: failedAtomicTask,
    check: 'node -e "process.exit(1)"',
    complete: true,
    summary: 'This failed validation must not close the task.'
  }, { publicHttpOnly: true });
  assert.equal(failedAtomic.ok, false);
  assert.equal(failedAtomic.validationStatus, 'failed');
  assert.notEqual(failedAtomic.completionKnown, true);
  const failedTaskState = getToolActivity().tasks.find(task => task.id === failedAtomicTask);
  assert.equal(failedTaskState?.status, 'validation_failed');
  assert.equal(failedTaskState?.failures, 0, 'ordinary failed checks must not terminally fail the logical task');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: failedAtomicTask,
    path: 'src/recovered-after-validation.js',
    content: 'console.log("recovered");\n'
  }, { publicHttpOnly: true });
  const recoveredFailedValidation = await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: failedAtomicTask,
    level: 'standard',
    complete: true,
    summary: 'Recovered from a failed validation under the original logical task ID.'
  }, { publicHttpOnly: true });
  assert.equal(recoveredFailedValidation.ok, true);
  assert.equal(recoveredFailedValidation.work_id, failedAtomicTask);
  assert.equal(recoveredFailedValidation.completionKnown, true);
  resetToolActivity();

  const atomicContext = { publicHttpOnly: true };
  const atomicTaskId = await startTask('shared-atomic-transport');
  const atomicCompletion = await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: atomicTaskId,
    level: 'standard',
    complete: true,
    summary: 'Validated and completed atomically.'
  }, atomicContext);
  assert.equal(atomicCompletion.ok, true);
  assert.equal(atomicCompletion.work_id, atomicTaskId);
  assert.equal(atomicCompletion.validationStatus, 'passed');
  assert.equal(atomicCompletion.completionKnown, true);
  assert.equal(atomicCompletion.endReason, 'explicit_completion');
  assert.equal(atomicCompletion.completionSource, 'relai_validate:checks');
  assert.equal(atomicCompletion.summary, 'Validated and completed atomically.');
  assert.match(atomicCompletion.nextAction, /completion was accepted/i);
  assert.equal(readSessionPolicy(readConfig(), 'app', atomicTaskId), null, 'atomic completion must clear this task ownership state');
  const atomicStatus = getToolActivity();
  assert.equal(atomicStatus.state, 'idle');
  assert.equal(atomicStatus.lastTask.status, 'completed');
  assert.equal(atomicStatus.lastTask.summary, 'Validated and completed atomically.');
  const atomicAudit = readAudit(readConfig(), { limit: 100 });
  const atomicEvent = atomicAudit.entries.find(entry => entry.taskId === atomicTaskId && entry.tool === 'validate.checks' && entry.completionSource === 'relai_validate:checks');
  assert.ok(atomicEvent, 'atomic validation completion must be persisted under the exact task ID');
  assert.equal(atomicEvent.completionKnown, true);
  assert.equal(atomicEvent.taskIdentityVersion, 2);
  assert.equal(atomicEvent.taskSummary, 'Validated and completed atomically.');

  resetToolActivity();
  const context = { publicHttpOnly: true };
  const busyTaskId = await startTask('completion-in-progress');
  const busyExec = callTool('relai_exec', {
    workspace: 'app',
    work_id: busyTaskId,
    executable: process.execPath,
    argv: ['-e', 'setTimeout(() => process.exit(0), 800)']
  }, context);
  await new Promise(resolve => setTimeout(resolve, 100));
  const busyFinishStartedAt = Date.now();
  await assert.rejects(
    callTool('relai_work', {
      action: 'finish',
      workspace: 'app',
      work_id: busyTaskId,
      summary: 'Must not wait behind this task active execution.'
    }, context),
    error => error?.code === 'TASK_COMPLETION_IN_PROGRESS' && error?.retryable === true
  );
  assert.ok(
    Date.now() - busyFinishStartedAt < 500,
    'work.finish must reject promptly when the same task still has active work instead of waiting in its workspace queue'
  );
  const busyExecResult = await busyExec;
  assert.equal(busyExecResult.commandSucceeded, true);
  const busyCompletion = await callTool('relai_work', {
    action: 'finish',
    workspace: 'app',
    work_id: busyTaskId,
    summary: 'Task completed after its active execution settled.'
  }, context);
  assert.equal(busyCompletion.completionKnown, true);

  resetToolActivity();
  const completionContext = { publicHttpOnly: true };
  const taskId = await startTask('shared-standalone-transport');
  const validation = await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: taskId,
    level: 'standard',
    complete: false
  }, completionContext);
  assert.equal(validation.ok, true);
  assert.equal(validation.work_id, taskId);
  assert.equal(validation.validationStatus, 'passed');
  assert.match(validation.nextAction, /recorded|repository state/i);

  const analyticsMonth = new Date().toISOString().slice(0, 7);
  const completedTasksBefore = readLocalUsageSnapshot(readConfig(), analyticsMonth).taskIntents.reduce((sum, row) => sum + Number(row.tasks || 0), 0);

  const completion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: taskId,
    summary: 'Implemented and validated the requested code changes.'
  }, completionContext);
  assert.equal(completion.ok, true);
  assert.equal(completion.work_id, taskId);
  assert.equal(completion.completionKnown, true);
  assert.equal(completion.endReason, 'explicit_completion');
  assert.equal(completion.validationStatus, 'passed');
  const completedTasksAfter = readLocalUsageSnapshot(readConfig(), analyticsMonth).taskIntents.reduce((sum, row) => sum + Number(row.tasks || 0), 0);
  assert.equal(completedTasksAfter, completedTasksBefore + 1, 'accepted task completion must increment local work-type analytics exactly once');
  assert.equal(readSessionPolicy(readConfig(), 'app', taskId), null, 'explicit completion must clear only this task ownership state');

  const status = getToolActivity();
  assert.equal(status.state, 'idle');
  assert.equal(status.lastTask.status, 'completed');
  assert.equal(status.lastTask.completionKnown, true);
  assert.equal(status.lastTask.endReason, 'explicit_completion');
  assert.equal(status.lastTask.summary, 'Implemented and validated the requested code changes.');

  const audit = readAudit(readConfig(), { limit: 100 });
  const completionEvent = audit.entries.find(entry => entry.taskId === taskId && entry.tool === 'work.finish' && entry.ok === true);
  assert.ok(completionEvent, 'completion must be persisted under the requested task ID');
  assert.equal(completionEvent.eventType, 'task.completion.committed');
  assert.equal(completionEvent.completionKnown, true);
  assert.equal(completionEvent.endReason, 'explicit_completion');
  assert.equal(completionEvent.taskSummary, 'Implemented and validated the requested code changes.');

  const duplicateCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: taskId,
    summary: 'A retry must not create another completion.'
  }, context);
  assert.equal(duplicateCompletion.ok, true);
  assert.equal(duplicateCompletion.work_id, taskId);
  assert.equal(duplicateCompletion.duplicate, true);
  assert.equal(duplicateCompletion.summary, 'Implemented and validated the requested code changes.');
  const completedTasksAfterDuplicate = readLocalUsageSnapshot(readConfig(), analyticsMonth).taskIntents.reduce((sum, row) => sum + Number(row.tasks || 0), 0);
  assert.equal(completedTasksAfterDuplicate, completedTasksAfter, 'duplicate completion must not inflate work-type analytics');

  resetToolActivity();
  const rotatedValidationContext = { publicHttpOnly: true };
  const restartTaskId = await startTask('validation-before-restart');
  await callTool('relai_validate', { action: 'checks',
    workspace: 'app',
    work_id: restartTaskId,
    level: 'standard',
    complete: false
  }, rotatedValidationContext);
  resetToolActivity();
  const recoveredCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: restartTaskId,
    summary: 'Recovered the same explicit task after the in-memory tracker restarted.'
  }, { publicHttpOnly: true });
  assert.equal(recoveredCompletion.ok, true);
  assert.equal(recoveredCompletion.work_id, restartTaskId);

  resetToolActivity();
  const longAuditTaskId = await startTask('completion-after-long-audit-tail');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: longAuditTaskId,
    path: 'src/long-audit.js',
    content: 'console.log("long audit");\n'
  }, { publicHttpOnly: true });
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: longAuditTaskId, level: 'standard', complete: false }, { publicHttpOnly: true });
  const filler = Array.from({ length: 10050 }, (_, index) => JSON.stringify({ ts: new Date().toISOString(), tool: 'noise', index })).join('\n');
  fs.appendFileSync(getAuditPath(readConfig()), `${filler}\n`, 'utf8');
  const longAuditCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: longAuditTaskId,
    summary: 'Completion integrity survived more than ten thousand later audit entries.'
  }, { publicHttpOnly: true });
  assert.equal(longAuditCompletion.ok, true);
  assert.deepEqual(longAuditCompletion.changedFiles, ['src/long-audit.js']);

  resetToolActivity();
  const externalMutationTaskId = await startTask('external-content-after-validation');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: externalMutationTaskId,
    path: 'src/external-fingerprint.js',
    content: 'console.log("validated content");\n'
  }, { publicHttpOnly: true });
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: externalMutationTaskId, level: 'standard', complete: false }, { publicHttpOnly: true });
  fs.writeFileSync(path.join(workspace, 'src', 'external-fingerprint.js'), 'console.log("changed outside the task ledger");\n');
  const externalCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: externalMutationTaskId,
    summary: 'The agent finished after external content changed; Rel.AI reports validation as stale.'
  }, { publicHttpOnly: true });
  assert.equal(externalCompletion.completionKnown, true);
  assert.equal(externalCompletion.validationStatus, 'stale');

  resetToolActivity();
  const changedContext = { publicHttpOnly: true };
  const changedTaskId = await startTask('changed-after-validation');
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: changedTaskId, level: 'standard', complete: false }, changedContext);
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: changedTaskId,
    path: 'src/index.js',
    oldText: 'console.log("ready");',
    newText: 'console.log("changed after validation");'
  }, changedContext);
  const changedCompletion = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: changedTaskId,
    summary: 'The agent finished after a post-validation edit; Rel.AI records stale evidence.'
  }, changedContext);
  assert.equal(changedCompletion.ok, true);
  assert.equal(changedCompletion.completionKnown, true);
  assert.equal(changedCompletion.validationStatus, 'stale');
  assert.equal(getToolActivity().lastTask?.status, 'completed');

  resetToolActivity();
  const sharedScope = { publicHttpOnly: true };
  const taskA = await startTask('one-shared-client-connection');
  const taskB = await startTask('one-shared-client-connection');
  assert.notEqual(taskA, taskB);
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: taskB,
    path: 'src/task-b.js',
    content: 'console.log("task b mutation");\n'
  }, sharedScope);
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: taskA, level: 'standard', complete: false }, sharedScope);
  const unvalidatedB = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: taskB,
    summary: 'Task B does not borrow task A validation; its own evidence remains not_run.'
  }, sharedScope);
  assert.equal(unvalidatedB.validationStatus, 'not_run');
  const completedA = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: taskA,
    summary: 'Task A completes independently.'
  }, sharedScope);
  assert.equal(completedA.work_id, taskA);
  assert.deepEqual(completedA.changedFiles || [], [], 'task A must not claim task B mutations');
  resetToolActivity();
  const sharedWorkspaceScope = { publicHttpOnly: true };
  const taskE = await startTask('shared-workspace-conflict');
  const taskF = await startTask('shared-workspace-conflict');
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: taskE, level: 'standard', complete: false }, sharedWorkspaceScope);
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: taskF,
    path: 'src/index.js',
    oldText: 'console.log("changed after validation");',
    newText: 'console.log("changed by another task");'
  }, sharedWorkspaceScope);
  const completedE = await callTool('relai_work', { action: 'finish',
    workspace: 'app',
    work_id: taskE,
    summary: 'Task E stays valid because task F changed content outside task E validation scope.'
  }, sharedWorkspaceScope);
  assert.equal(completedE.work_id, taskE);
  assert.equal(getToolActivity().tasks.some(task => task.taskId === taskF), true, 'task F must remain active after task E completes');
  await callTool('relai_work', {
    action: 'cancel', workspace: 'app', work_id: taskF, reason: 'Unrelated shared-workspace coverage complete.'
  }, sharedWorkspaceScope);

  resetToolActivity();
  const overlapScope = { publicHttpOnly: true };
  const taskG = await startTask('overlapping-task-scope');
  await callTool('relai_edit', {
    workspace: 'app', work_id: taskG, path: 'src/overlap.js', content: 'export const owner = "task-g";\n'
  }, overlapScope);
  const taskH = await startTask('overlapping-task-scope');
  await callTool('relai_validate', { action: 'checks', workspace: 'app', work_id: taskG, level: 'standard', complete: false }, overlapScope);
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: taskH,
    path: 'src/overlap.js',
    oldText: 'export const owner = "task-g";',
    newText: 'export const owner = "task-h";'
  }, overlapScope);
  const completedG = await callTool('relai_work', { action: 'finish',
    workspace: 'app', work_id: taskG,
    summary: 'Overlapping work made the previous validation stale; the agent may still close its durable session.'
  }, overlapScope);
  assert.equal(completedG.completionKnown, true);
  assert.equal(completedG.validationStatus, 'stale');
  assert.equal(getToolActivity().tasks.some(task => task.taskId === taskH), true, 'the overlapping task must remain active');
  await callTool('relai_work', {
    action: 'cancel', workspace: 'app', work_id: taskH, reason: 'Overlap reconciliation coverage complete.'
  }, overlapScope);

  console.log('Task-scoped atomic, standalone, retry, restart, unrelated-concurrency, overlap, and multi-chat completion tests passed.');
} finally {
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  await flushLocalAnalytics();
  resetToolActivity();
  await repositoryIntelligence.shutdown();
  resetTaskHistoryCaches();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
