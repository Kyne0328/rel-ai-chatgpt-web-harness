import { updateCurrentToolActivity } from '../toolActivity.js';
import { sanitizeDisplayText } from '../taskObservability.js';

function publishValidationProgress({
  checks,
  skippedChecks = [],
  results,
  currentCheck = '',
  currentIndex = 0,
  resultStatus = 'pending',
  final = false,
  activeChecks = []
}) {
  const total = checks.length;
  const completed = Math.min(completedValidationUnits(results), total);
  const passed = results.filter(item => item.ok).length;
  const failed = results.filter(item => !item.ok && !item.cancelled).length;
  const cancelled = results.some(item => item.cancelled === true) || resultStatus === 'cancelled';
  const current = sanitizeDisplayText(currentCheck, 300);
  const running = [...new Set(activeChecks.map(value => sanitizeDisplayText(value, 120)).filter(Boolean))].slice(0, 3);
  const active = running.length;
  const pending = Math.max(0, total - completed - active);
  const stage = resultStatus === 'cancelled'
    ? 'Validation cancelled'
    : resultStatus === 'failed' || resultStatus === 'timed_out'
      ? 'Validation failed'
      : final && resultStatus === 'passed'
        ? 'Validation completed'
        : active > 1
          ? `${active} checks running in parallel`
          : active === 1
            ? 'Running validation check'
            : currentIndex > 0
              ? `Validating check ${currentIndex} of ${total}`
              : 'Preparing validation';
  const activity = active > 1
    ? `${active} checks running: ${running.join(', ')}`
    : active === 1
      ? `Running ${running[0]}`
      : current
        ? `${current}${resultStatus && resultStatus !== 'pending' ? ` - ${resultStatus.replaceAll('_', ' ')}` : ''}`
        : `${completed} of ${total} checks completed`;
  updateCurrentToolActivity({
    status: 'validating',
    operation: final
      ? (resultStatus === 'passed'
          ? `Validation passed (${completed}/${total} checks)`
          : resultStatus === 'cancelled'
            ? 'Validation cancelled'
            : `Validation failed on ${current || 'check'}`)
      : active > 1
        ? `Running ${active} validation checks in parallel`
        : active === 1
          ? `Running validation: ${running[0]}`
          : currentIndex > 0
            ? `Validation ${currentIndex}/${total}: ${current || 'check'}`
            : `Preparing ${total} validation checks`,
    detail: activity,
    currentStage: stage,
    currentActivity: activity,
    progress: {
      mode: 'determinate',
      completedUnits: completed,
      totalUnits: total,
      percentage: final && resultStatus !== 'passed' && completed === total ? 99 : Math.round((completed / total) * 100),
      source: 'validation',
      label: `${completed} of ${total} checks`
    },
    activity: {
      category: 'validation',
      status: 'running',
      title: 'Run repository validation',
      summary: activity,
      metadata: {
        checkCount: total,
        passedCount: passed,
        failedCount: failed,
        skippedCount: skippedChecks.length,
        currentCheck: current,
        currentIndex,
        resultStatus,
        failedCheck: failed ? current : '',
        cancelled,
        parallelActiveCount: active,
        completedCount: completed,
        pendingCount: pending,
        running
      }
    }
  });
}

function completedValidationUnits(results) {
  return results.filter(item => item.cancelled !== true && (item.executed !== false || item.reused === true)).length;
}

function checkResultStatus(summary) {
  if (summary.cancelled) return 'cancelled';
  if (summary.timedOut || summary.queueTimedOut) return 'timed_out';
  return summary.ok ? 'passed' : 'failed';
}

function tailString(text, maxChars) {
  const value = String(text);
  if (value.length <= maxChars) return value;
  return `[rel-ai-mcp kept last ${maxChars} of ${value.length} chars]\n${value.slice(value.length - maxChars)}`;
}

function boundCheckOutput(summary, maxChars) {
  const bounded = { ...summary };
  if (typeof bounded.stdout === 'string') bounded.stdout = tailString(bounded.stdout, maxChars);
  if (typeof bounded.stderr === 'string') bounded.stderr = tailString(bounded.stderr, maxChars);
  return bounded;
}

export { boundCheckOutput, checkResultStatus, completedValidationUnits, publishValidationProgress };