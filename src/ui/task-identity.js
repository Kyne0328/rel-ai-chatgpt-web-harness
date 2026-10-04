import { isTerminalDashboardTaskStatus } from '../taskState.js';

export function taskEntityView(value = {}) {
  return {
    logicalTaskId: text(value.work_id || value.logicalTaskId || value.workSessionId || value.id),
    processId: text(value.processId || value.process?.processId || value.process?.id)
  };
}

export function workSessionStateView(value = {}) {
  const status = normalize(typeof value === 'string' ? value : value.status);
  const states = {
    queued: ['Queued', false, true, 'working'],
    planning: ['Planning', false, true, 'working'],
    running: ['Running', false, true, 'working'],
    working: ['Working', false, true, 'working'],
    validating: ['Validating', false, true, 'working'],
    waiting: ['Waiting', false, false, 'working'],
    settling: ['Settling', false, true, 'working'],
    waiting_for_approval: ['Blocked', false, false, 'warn'],
    blocked: ['Blocked', false, false, 'bad'],
    validation_failed: ['Validation failed', false, false, 'bad'],
    completed: ['Completed', true, false, 'ok'],
    failed: ['Failed', true, false, 'bad'],
    cancelled: ['Cancelled', true, false, ''],
    expired: ['Expired', true, false, ''],
    inactive: ['Inactive', false, false, '']
  };
  const inactiveContext = status === 'inactive' && typeof value === 'object'
    ? normalize(value.resumeStatus || (value.validation === 'failed' ? 'validation_failed' : ''))
    : '';
  const contextualInactive = ['validation_failed', 'blocked', 'waiting_for_approval'].includes(inactiveContext)
    ? states[inactiveContext]
    : null;
  const [label, terminal, statusActive, pillClass] = contextualInactive || states[status] || ['Unknown', isTerminalDashboardTaskStatus(status, value), false, ''];
  const activityKnown = typeof value === 'object' && value !== null
    && (Object.hasOwn(value, 'activeCalls') || Object.hasOwn(value, 'state'));
  const runtimeActive = activityKnown
    ? Number(value.activeCalls || 0) > 0 || normalize(value.state) === 'working'
    : statusActive;
  const active = status === 'inactive' ? false : statusActive && runtimeActive;
  const open = !terminal && status !== 'inactive' && !active
    && ['queued', 'planning', 'running', 'working', 'validating', 'waiting', 'settling'].includes(status);
  return { status: status || 'unknown', label, terminal: status === 'inactive' ? false : terminal, active, open, pillClass };
}

export function processStateView(process = {}) {
  const observedStatus = normalize(process.status);
  const rawStatus = observedStatus === 'unknown_after_restart' ? 'orphaned' : observedStatus;
  const states = {
    starting: ['Starting', false, true, true, 'working', 'Wait for readiness or stop the process if startup does not complete.'],
    running: ['Running', false, true, true, 'working', 'Use Stop process when this operating-system process is no longer needed.'],
    stopping: ['Stopping', false, true, false, 'working', 'Rel.AI is waiting for the process to stop.'],
    exited: ['Exited', true, false, false, 'ok', 'Review the exit code and recent output before restarting if needed.'],
    stopped: ['Stopped', true, false, false, '', 'Start a new process when the command is needed again.'],
    failed: ['Failed', true, false, false, 'bad', 'Review recent stderr, correct the command or environment, and start it again.'],
    orphaned: ['Unknown after restart', false, false, true, 'warn', 'Rel.AI cannot reconnect to this process output after a restart. Stop the process if it is still running. Then start it again.'],
    unknown: ['Unknown', false, false, false, '', 'Refresh the dashboard. If the state remains unknown, open Troubleshooting.']
  };
  const [label, terminal, active, canStop, pillClass, recovery] = states[rawStatus] || states.unknown;
  return {
    status: rawStatus || 'unknown',
    label,
    terminal,
    active,
    canStop,
    pillClass,
    recovery
  };
}

export function processOutputView(process = {}) {
  const stdoutIncluded = Object.hasOwn(process, 'stdoutTail');
  const stderrIncluded = Object.hasOwn(process, 'stderrTail');
  const stdout = String(process.stdoutTail ?? '');
  const stderr = String(process.stderrTail ?? '');
  const stdoutMeta = processOutputStreamView(process, 'stdout', stdout);
  const stderrMeta = processOutputStreamView(process, 'stderr', stderr);
  const included = stdoutIncluded || stderrIncluded;
  const hasOutput = Boolean(stdout.trim() || stderr.trim() || (included && (stdoutMeta.totalBytes || stderrMeta.totalBytes)));
  return {
    included,
    hasOutput,
    stdout,
    stderr,
    stdoutMeta,
    stderrMeta,
    message: included
      ? 'No recent stdout or stderr output was recorded.'
      : 'Recent output is not available in this dashboard snapshot.'
  };
}

function processOutputStreamView(process, stream, tail) {
  const totalBytes = nonNegativeNumber(process[`${stream}Bytes`]);
  const retainedFromOffset = Math.min(totalBytes, nonNegativeNumber(process[`${stream}RetainedFromOffset`]));
  const explicitTailStart = Number(process[`${stream}TailStartOffset`]);
  const fallbackTailStart = Math.max(retainedFromOffset, totalBytes - new TextEncoder().encode(tail).byteLength);
  const tailStartOffset = Number.isFinite(explicitTailStart)
    ? Math.min(totalBytes, Math.max(retainedFromOffset, explicitTailStart))
    : fallbackTailStart;
  return {
    totalBytes,
    retainedFromOffset,
    tailStartOffset,
    droppedBytes: nonNegativeNumber(process[`${stream}DroppedBytes`]),
    tailTruncated: tailStartOffset > retainedFromOffset,
    retentionTruncated: retainedFromOffset > 0
  };
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalize(value) {
  return text(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function text(value) {
  return String(value ?? '').trim();
}
