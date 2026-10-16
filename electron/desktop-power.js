import { createTaskActivityRuntime } from './tool-sleep-blocker.js';

function createDesktopPowerIntegration(options = {}) {
  const {
    powerMonitor,
    powerSaveBlocker,
    toolActivity,
    notify = () => false,
    onTaskCompleted = () => {},
    onStatusChange = () => {},
    onResume = () => {},
    onError = () => {}
  } = options;
  if (!powerMonitor || typeof powerMonitor.on !== 'function') {
    throw new TypeError('A valid Electron powerMonitor is required.');
  }

  const activityRuntime = createTaskActivityRuntime({
    toolActivity,
    powerSaveBlocker,
    notify,
    onTaskCompleted,
    onStatusChange
  });
  let resumeBound = false;
  let stopped = false;

  function handleResume() {
    try {
      const result = onResume();
      if (result && typeof result.then === 'function') void result.catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  function start() {
    if (resumeBound) return false;
    activityRuntime.start();
    stopped = false;
    powerMonitor.on('resume', handleResume);
    resumeBound = true;
    return true;
  }

  function stop() {
    if (stopped) return false;
    stopped = true;
    if (resumeBound) {
      if (typeof powerMonitor.off === 'function') powerMonitor.off('resume', handleResume);
      else powerMonitor.removeListener?.('resume', handleResume);
      resumeBound = false;
    }
    activityRuntime.stop();
    return true;
  }

  return {
    start,
    stop,
    getStatus: activityRuntime.getStatus,
    resetHistory: activityRuntime.resetHistory,
    setKeepAwakeEnabled: activityRuntime.setKeepAwakeEnabled
  };
}

export { createDesktopPowerIntegration };
