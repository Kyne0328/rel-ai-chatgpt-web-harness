function createShutdownCoordinator(options = {}) {
  const {
    stopService = async () => ({ cleanup: { clean: true } }),
    stopUpdater = () => {},
    stopActivity = () => {},
    closeWindows = () => {},
    removeRuntimeMarker = () => {},
    shutdownTelemetry = async () => {},
    markCleanShutdown = () => {},
    flushLogs = async () => {},
    onLog = () => {},
    stepTimeoutMs = 10_000,
    serviceTimeoutMs = 35_000,
    flushTimeoutMs = 5_000
  } = options;
  let shutdownPromise = null;
  let prepared = false;

  function prepare(reason = 'quit') {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const errors = [];
      runStep(stopUpdater, 'updater', errors);
      runStep(stopActivity, 'activity runtime', errors);
      await runStepAsync(closeWindows, 'windows', errors, stepTimeoutMs);

      let serviceResult = null;
      try {
        serviceResult = await withTimeout(stopService(), serviceTimeoutMs, 'service shutdown');
      } catch (error) {
        errors.push(stepError('service', error));
      }
      try {
        await withTimeout(shutdownTelemetry(), stepTimeoutMs, 'telemetry shutdown');
      } catch (error) {
        errors.push(stepError('telemetry', error));
      }
      await runStepAsync(removeRuntimeMarker, 'runtime marker', errors, stepTimeoutMs);

      const serviceClean = serviceResult?.cleanup?.clean !== false;
      if (errors.length === 0 && serviceClean) await runStepAsync(markCleanShutdown, 'lifecycle marker', errors, stepTimeoutMs);

      for (const item of errors) {
        onLog(`Shutdown ${item.step} failed: ${item.message}`, {
          source: 'desktop-shutdown',
          level: 'warning',
          code: 'shutdown_cleanup_failed'
        });
      }
      if (!serviceClean) {
        onLog('Shutdown cleanup could not confirm that every owned process exited.', {
          source: 'desktop-shutdown',
          level: 'warning',
          code: 'shutdown_process_exit_unconfirmed'
        });
      }
      await runStepAsync(flushLogs, 'logs', errors, flushTimeoutMs);
      const clean = errors.length === 0 && serviceClean;
      prepared = true;
      return { ok: clean && errors.length === 0, clean, reason, errors, serviceResult };
    })();
    return shutdownPromise;
  }

  function isPrepared() {
    return prepared;
  }

  function reset() {
    shutdownPromise = null;
    prepared = false;
  }

  return { prepare, isPrepared, reset };
}

function closeHttpServer(server, options = {}) {
  if (!server) return Promise.resolve({ closed: true, forced: false });
  const timeoutMs = Number(options.timeoutMs || 2500);
  return new Promise(resolve => {
    let settled = false;
    let forced = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      forced = true;
      try { server.closeAllConnections?.(); } catch {}
      finish({
        closed: false,
        forced: true,
        error: `Local HTTP server did not close within ${formatSeconds(timeoutMs)} seconds.`
      });
    }, timeoutMs);
    try {
      server.close(error => finish({
        closed: !error,
        forced,
        ...(error ? { error: errorMessage(error) } : {})
      }));
      server.closeIdleConnections?.();
    } catch (error) {
      finish({ closed: false, forced, error: errorMessage(error) });
    }
  });
}

function runStep(action, step, errors) {
  try {
    action();
  } catch (error) {
    errors.push(stepError(step, error));
  }
}

async function runStepAsync(action, step, errors, timeoutMs = 10_000) {
  try {
    await withTimeout(Promise.resolve().then(action), timeoutMs, step);
  } catch (error) {
    errors.push(stepError(step, error));
  }
}

function withTimeout(promise, timeoutMs, label) {
  const waitMs = Math.max(1, Number(timeoutMs || 1));
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${formatSeconds(waitMs)} seconds.`)), waitMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatSeconds(timeoutMs) {
  return Math.round(Number(timeoutMs || 0) / 100) / 10;
}

function stepError(step, error) {
  return {
    step,
    message: error instanceof Error ? error.message : String(error || 'Unknown error')
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export { closeHttpServer, createShutdownCoordinator };
