const STATIC_PROGRESS_STATES = Object.freeze({
  failed: Object.freeze({ fallback: 'Task failed', state: 'Failed', className: 'terminal failed' }),
  cancelled: Object.freeze({ fallback: 'Task cancelled', state: 'Cancelled', className: 'terminal cancelled' }),
  inactive: Object.freeze({ fallback: 'Ready to resume', state: 'Inactive', className: 'paused' }),
  expired: Object.freeze({ fallback: 'Task expired', state: 'Expired', className: 'terminal cancelled' }),
  validation_failed: Object.freeze({ fallback: 'Fix the issues and run checks again', state: 'Action required', className: 'paused failed' }),
  blocked: Object.freeze({ fallback: 'Resolve the blocker to continue', state: 'Action required', className: 'paused blocked' }),
  waiting_for_approval: Object.freeze({ fallback: 'Blocked', state: 'Action required', className: 'paused blocked' })
});

export function taskProgressView(progress = {}, status = '', options = {}) {
  const compact = options.compact === true;
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (normalizedStatus === 'completed') {
    return {
      kind: 'complete',
      className: classNames('task-progress', 'complete', compact && 'compact'),
      role: 'status',
      ariaLabel: 'Task completed. 100 percent.',
      label: progress?.label || 'Complete',
      state: '100%',
      value: 100,
      progressAriaLabel: 'Task complete'
    };
  }

  const staticState = STATIC_PROGRESS_STATES[normalizedStatus];
  if (staticState) return staticProgressView(progress, staticState, compact);

  if (progress?.mode === 'determinate') {
    const value = clampPercentage(progress.percentage);
    const label = progress.label || `${progress.completedUnits || 0} of ${progress.totalUnits || 0} complete`;
    return {
      kind: 'determinate',
      className: classNames('task-progress', compact && 'compact'),
      role: '',
      ariaLabel: '',
      label,
      state: `${value}%`,
      value,
      progressAriaLabel: label
    };
  }

  const label = progress?.label || 'Workload size is not yet known';
  return {
    kind: 'indeterminate',
    className: classNames('task-progress', 'indeterminate', compact && 'compact'),
    role: compact ? '' : 'status',
    ariaLabel: label,
    label,
    state: '',
    value: null,
    progressAriaLabel: ''
  };
}

function staticProgressView(progress, state, compact) {
  const terminal = state.className.startsWith('terminal');
  const label = terminal ? state.fallback : meaningfulLabel(progress?.label, state.fallback);
  return {
    kind: 'static',
    className: classNames('task-progress', 'static', state.className, compact && 'compact'),
    role: 'status',
    ariaLabel: `${label}. ${state.state}.`,
    label,
    state: state.state,
    value: null,
    progressAriaLabel: ''
  };
}

function meaningfulLabel(value, fallback) {
  const label = String(value || '').trim();
  if (!label || /^(progress unavailable|workload size is not yet known|planning task|waiting for the next task step|approval required|waiting for approval)$/i.test(label)) return fallback;
  return label;
}

function clampPercentage(value) {
  return Math.max(0, Math.min(100, Number(value || 0)));
}

function classNames(...values) {
  return values.filter(Boolean).join(' ');
}
