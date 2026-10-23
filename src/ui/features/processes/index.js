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
  const rows = processes.map(process => processRowView(process, now));
  const running = rows.filter(row => row.state.active).length;
  const finished = rows.filter(row => row.state.terminal).length;
  return { rows, running, finished };
}

function processRowView(process = {}, now = Date.now()) {
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
    elapsed: durationFor(process, state.active, now),
    exitCode: process.exitCode,
    error: process.error || '',
    memory: process.memoryBytes ?? process.memory ?? process.rssBytes ?? process.rss ?? null,
    state,
    output
  };
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
