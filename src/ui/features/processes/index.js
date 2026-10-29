import { processOutputView, processStateView } from '../../task-identity.js';
import { formatDuration, timeAgo } from '../../utils.js';

export function processStopResult(result) {
  if (result?.ok === false) return { status: 'error', message: String(result.error || 'The stop request failed.').slice(0, 320) };
  if (result?.terminationConfirmed === true && ['stopped', 'exited', 'failed'].includes(result.status)) {
    return { status: 'success', message: '' };
  }
  return {
    status: 'error',
    message: String(result?.terminationError || result?.error || 'Rel.AI could not confirm that the process and its subprocesses stopped. Check its status before retrying.').slice(0, 320)
  };
}

export function processListView(data = {}, now = Date.now()) {
  const processes = orderProcesses(data.managedProcesses || []);
  const rows = [...processes.map(process => processRowView(process, now, data.processMemory)),
    ...(data.commandOperations || []).map(command => commandRowView(command, now))];
  rows.sort((a, b) => Number(b.state.active) - Number(a.state.active) || timestamp(b) - timestamp(a));
  const running = rows.filter(row => row.state.active && row.state.status !== 'queued').length;
  const queued = rows.filter(row => row.state.status === 'queued').length;
  const finished = rows.filter(row => row.state.terminal).length;
  return { rows, running, queued, finished };
}

function commandRowView(command, now) {
  const terminal = ['completed', 'cancelled', 'failed'].includes(command.status);
  const active = ['queued', 'running', 'stopping'].includes(command.status);
  const label = { queued: 'Queued', running: 'Running', stopping: 'Stopping', completed: 'Completed', cancelled: 'Stopped', failed: 'Failed', unknown: 'Outcome unverified' }[command.status] || 'Unknown';
  const row = processRowView({ ...command, processId: `command:${command.operationId}` }, now);
  return { ...row, elapsed: command.status === 'unknown' ? 'Completion unverified' : row.elapsed,
    lastOutputAt: typeof command.lastOutputAt === 'string' ? command.lastOutputAt : '',
    lastOutputBytes: Number.isSafeInteger(command.lastOutputBytes) && command.lastOutputBytes >= 0 ? command.lastOutputBytes : null,
    operationId: command.operationId, stopProcessId: null, taskId: command.workId,
    taskTitle: command.taskTitle || command.workId || 'Independent command',
    label: 'Command',
    state: { status: command.status, label, terminal, active,
      canStop: active && command.status !== 'stopping' && command.canStop === true,
      pillClass: active ? 'working' : command.status === 'failed' ? 'bad' : '',
      recovery: command.error || (command.status === 'unknown' ? 'The command ended, but process cleanup could not be confirmed.' : '') } };
}

function processRowView(process = {}, now = Date.now(), snapshot = null) {
  const state = processStateView(process);
  const output = processOutputView(process);
  const processId = String(process.processId || 'unknown');
  return {
    processId,
    stopProcessId: process.processId,
    label: process.label || process.commandSummary || 'Command',
    project: process.workspaceId || process.workspace || 'Unknown project',
    commandSummary: process.commandSummary || 'Unavailable',
    startedAt: process.startedAt || '',
    startedAgo: process.startedAt ? (timeAgo(process.startedAt, now) || 'now') : '',
    endedAt: process.endedAt || '',
    endedAgo: process.endedAt ? (timeAgo(process.endedAt, now) || 'now') : '',
    elapsed: process.durationKnown === false || (state.status === 'orphaned' && !process.endedAt) ? 'Duration unconfirmed' : durationFor(process, state.active, now),
    exitCode: process.exitOutcomeKnown === false ? null : process.exitCode,
    recoveryNote: state.terminal && process.exitOutcomeKnown === false ? state.recovery : '',
    recoveryArchived: Boolean(process.recoveryArchivedAt) && !state.terminal && !state.active,
    canArchiveRecovery: process.canArchiveRecovery === true,
    recoveryArchivedAt: process.recoveryArchivedAt || '',
    error: process.error || '',
    memory: processMemoryView(process, snapshot, now),
    state,
    output
  };
}

function processMemoryView(process, snapshot, now) {
  if (!processStateView(process).active || snapshot?.stale === true) return null;
  const root = snapshot?.roots?.find(root => root.processId === process.processId && root.pid === process.pid);
  const sampledAt = Date.parse(root?.sampledAt || '');
  if (root?.identityVerified !== true || root.measurementStatus !== 'measured'
    || !Number.isFinite(sampledAt) || now < sampledAt || now - sampledAt >= 5000
    || !Number.isSafeInteger(root.workingSetBytes) || root.workingSetBytes < 0) return null;
  return { workingSetBytes: root.workingSetBytes, sampledAt: root.sampledAt };
}

function durationFor(process = {}, active = false, now = Date.now()) {
  const start = Date.parse(process.startedAt || '');
  const parsedEnd = Date.parse(process.endedAt || '');
  const end = Number.isFinite(parsedEnd) ? parsedEnd : now;
  if (Number.isFinite(start)) return formatDuration(Math.max(0, end - start), active ? { live: true } : {});
  return 'Unavailable';
}

function orderProcesses(items = []) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const activeDifference = Number(processStateView(right).active) - Number(processStateView(left).active);
    if (activeDifference) return activeDifference;
    return timestamp(right) - timestamp(left) || String(left?.processId || '').localeCompare(String(right?.processId || ''));
  });
}

function timestamp(item) {
  const value = Date.parse(item?.endedAt || item?.startedAt || '');
  return Number.isFinite(value) ? value : 0;
}
