import { performance } from 'node:perf_hooks';

import { readConfig } from '../config.js';
import { initializeKnowledgeDatabase, maintainKnowledgeDatabase } from '../knowledgeStore.js';
import { initializeStateDatabase, maintainStateDatabase } from '../stateDatabase.ts';
import { initializeTelemetry } from '../telemetry.js';
import { stopFallbackExecutionsForShutdown, verifyFallbackDurabilityForShutdown } from '../mcp/fallbackExecutions.js';

export interface RelaiCoreRuntimeOptions {
  config?: Record<string, unknown>;
  isolated?: boolean;
  stopManagedProcessesOnShutdown?: boolean;
}

export interface CoreShutdownResult {
  clean: boolean;
  fallbackResults?: Record<string, unknown>;
  managedProcesses: Record<string, unknown>;
  repositoryIntelligence: Record<string, unknown>;
  errors: Array<{ step: string; error: string }>;
  reason?: string;
}

export interface RelaiCoreRuntime {
  readonly config: Record<string, unknown>;
  readonly isolated: boolean;
  start(): Record<string, unknown>;
  shutdown(): Promise<CoreShutdownResult>;
}

export function createRelaiCoreRuntime(options: RelaiCoreRuntimeOptions = {}): RelaiCoreRuntime {
  const config = options.config || readConfig();
  const isolated = options.isolated === true;
  const stopManagedProcessesOnShutdown = options.stopManagedProcessesOnShutdown !== false;
  let startup: Record<string, unknown> | null = null;
  let shutdownPromise: Promise<CoreShutdownResult> | null = null;

  function start(): Record<string, unknown> {
    if (startup) return startup;
    const stateStarted = performance.now();
    const state = initializeStateDatabase(config);
    const stateDatabaseMs = performance.now() - stateStarted;
    const knowledgeStarted = performance.now();
    const knowledge = initializeKnowledgeDatabase(config);
    const knowledgeDatabaseMs = performance.now() - knowledgeStarted;
    const telemetryStarted = performance.now();
    const telemetry = isolated ? false : initializeTelemetry(config);
    const telemetrySetupMs = performance.now() - telemetryStarted;
    startup = {
      config,
      isolated,
      state,
      knowledge,
      telemetry,
      startupTimings: {
        stateDatabaseMs,
        knowledgeDatabaseMs,
        telemetrySetupMs
      }
    };
    return startup;
  }

  function shutdown(): Promise<CoreShutdownResult> {
    if (shutdownPromise) return shutdownPromise;
    if (!startup || isolated) {
      shutdownPromise = Promise.resolve(emptyShutdownResult(isolated ? 'isolated' : 'not_started'));
      return shutdownPromise;
    }
    shutdownPromise = shutdownCoreRuntime(config, { stopManagedProcessesOnShutdown });
    return shutdownPromise;
  }

  return Object.freeze({ config, isolated, start, shutdown });
}

async function shutdownCoreRuntime(
  config: Record<string, unknown>,
  options: { stopManagedProcessesOnShutdown: boolean }
): Promise<CoreShutdownResult> {
  try {
    const [
      auditModule,
      analyticsModule,
      browserRuntimeModule,
      processManagerModule,
      repositoryIntelligenceModule,
      taskHistoryModule,
      telemetryModule,
      webAutomationModule
    ] = await Promise.all([
      import('../audit.js'),
      import('../localAnalytics.js'),
      import('../browser/browserRuntime.ts'),
      import('../processManager.js'),
      import('../repository/intelligence/service.js'),
      import('../taskHistoryStore.ts'),
      import('../telemetry.js'),
      import('../webAutomationManager.js')
    ]);

    const managedProcessesPromise = options.stopManagedProcessesOnShutdown
      ? processManagerModule.stopAllManagedProcesses(config)
      : Promise.resolve({ attempted: 0, stopped: 0, orphaned: 0, skipped: true });
    const repositoryIntelligencePromise = repositoryIntelligenceModule.repositoryIntelligence.shutdown()
      .then(() => ({ closed: true }));
    // Stop producers first: process/browser shutdown may enqueue final audit and
    // task-history writes. A concurrent flush cannot certify those later writes.
    const producers = await Promise.allSettled([
      stopFallbackExecutionsForShutdown(config),
      managedProcessesPromise,
      browserRuntimeModule.stopAllBrowserSessions(),
      webAutomationModule.stopAllUiSessions(),
      repositoryIntelligencePromise
    ]);
    const drains = await Promise.allSettled([
      auditModule.flushAuditWrites(),
      taskHistoryModule.flushTaskHistoryPersistence(),
      analyticsModule.flushLocalAnalytics(),
      telemetryModule.shutdownTelemetry()
    ]);

    const maintenance = await Promise.allSettled([
      Promise.resolve().then(() => maintainStateDatabase(config)),
      Promise.resolve().then(() => maintainKnowledgeDatabase(config))
    ]);
    const managedProcesses = settledRecord(
      producers[1],
      { attempted: 0, stopped: 0, orphaned: 1, error: settledError(producers[1]) }
    );
    const repositoryIntelligence = settledRecord(
      producers[4],
      { closed: false, error: settledError(producers[4]) }
    );
    const producerLabels = ['fallbackResults', 'managedProcesses', 'browserSessions', 'uiSessions', 'repositoryIntelligence'];
    const drainLabels = ['audit', 'taskHistory', 'analytics', 'telemetry'];
    const errors: Array<{ step: string; error: string }> = producers.flatMap((result, index) => result.status === 'rejected'
      ? [{ step: producerLabels[index] ?? `producer-${index}`, error: errorMessage(result.reason) }]
      : []);
    errors.push(...drains.flatMap((result, index) => result.status === 'rejected'
      ? [{ step: drainLabels[index] ?? `drain-${index}`, error: errorMessage(result.reason) }]
      : []));
    const taskHistoryFlush = settledRecord(drains[1], {});
    if (drains[1]?.status === 'fulfilled' && (taskHistoryFlush.ok === false
      || Number(taskHistoryFlush.failed || 0) > 0 || Number(taskHistoryFlush.pending || 0) > 0)) {
      errors.push({
        step: 'taskHistory',
        error: `Task history persistence reported an incomplete flush: ${Number(taskHistoryFlush.failed || 0)} failed, ${Number(taskHistoryFlush.pending || 0)} pending.`
      });
    }
    const auditFlush = settledRecord(drains[0], {});
    if (drains[0]?.status === 'fulfilled' && auditFlush.ok === false) {
      errors.push({ step: 'audit',
        error: `Audit persistence remains incomplete: ${Number(auditFlush.pending || 0)} pending, ${Number(auditFlush.droppedEntries || 0)} dropped.` });
    }
    let fallbackResults: Record<string, unknown>;
    try {
      fallbackResults = verifyFallbackDurabilityForShutdown(config);
    } catch (error) {
      fallbackResults = { ok: false, error: errorMessage(error) };
    }
    if (fallbackResults.ok !== true || settledRecord(producers[0], {}).timedOut === true
      || Number(settledRecord(producers[0], {}).pending || 0) > 0) {
      errors.push({ step: 'fallbackResults',
        error: 'An operation did not reach a confirmed durable terminal state. Preserve retained receipts and inspect recovery before retrying.' });
    }
    if (maintenance[0]?.status === 'rejected') errors.push({ step: 'stateMaintenance', error: errorMessage(maintenance[0].reason) });
    if (maintenance[1]?.status === 'rejected') errors.push({ step: 'knowledgeMaintenance', error: errorMessage(maintenance[1].reason) });

    return {
      clean: errors.length === 0 && Number(managedProcesses.orphaned || 0) === 0 && repositoryIntelligence.closed !== false,
      fallbackResults,
      managedProcesses,
      repositoryIntelligence,
      errors
    };
  } catch (error) {
    return {
      clean: false,
      managedProcesses: { attempted: 0, stopped: 0, orphaned: 1, error: errorMessage(error) },
      repositoryIntelligence: { closed: false, error: errorMessage(error) },
      errors: [{ step: 'coreRuntime', error: errorMessage(error) }]
    };
  }
}

function emptyShutdownResult(reason: string): CoreShutdownResult {
  return {
    clean: true,
    managedProcesses: { attempted: 0, stopped: 0, orphaned: 0, skipped: true },
    repositoryIntelligence: { closed: true, skipped: true },
    errors: [],
    reason
  };
}

function settledRecord(result: PromiseSettledResult<unknown> | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  return result?.status === 'fulfilled' && result.value && typeof result.value === 'object'
    ? result.value as Record<string, unknown>
    : fallback;
}

function settledError(result: PromiseSettledResult<unknown> | undefined): string {
  return result?.status === 'rejected' ? errorMessage(result.reason) : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}
