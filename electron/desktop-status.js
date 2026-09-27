import { importResourceModule } from './resource-path.js';

const { deriveConnectionState } = await importResourceModule('src/desktopUxContracts.js');
const { createEmptyTaskActivity } = await importResourceModule('src/contracts/tasks.ts');
const { classifyTaskActivity } = await importResourceModule('src/taskActivityPresentation.js');

function initialDesktopStatus(version = '', buildStatus = {}) {
  return normalizeDesktopStatus({
    serverRunning: false,
    tunnelStatus: 'stopped',
    tunnelId: '',
    tunnelHealthUrl: '',
    tunnelRecoveryMode: '',
    tunnelHealth: null,
    mcpUrl: '',
    localMcpUrl: '',
    error: '',
    errorCode: '',
    localUrl: '',
    version,
    buildStatus: normalizeBuildStatus(buildStatus),
    taskActivity: createEmptyTaskActivity()
  });
}

function normalizeDesktopStatus(status = {}) {
  const task = classifyTaskActivity(status.taskActivity);
  return {
    ...status,
    connectionState: deriveConnectionState(status),
    taskActivityPresentation: {
      category: task.category,
      activityState: task.activityState,
      activeCalls: task.activeCalls,
      taskCount: task.taskCount,
      actionRequired: task.actionRequired,
      reason: task.reason
    }
  };
}

function normalizeBuildStatus(value = {}) {
  const state = ['recorded', 'development', 'unavailable'].includes(value?.state)
    ? value.state
    : 'unavailable';
  return { ...value, state };
}

function desktopStatusFailure(errorCode, error, next = {}) {
  return { ...next, error: formatDesktopError(error), errorCode };
}

function formatDesktopError(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export { desktopStatusFailure, initialDesktopStatus, normalizeDesktopStatus };
