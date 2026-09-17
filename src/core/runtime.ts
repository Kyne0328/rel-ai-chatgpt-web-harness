import { performance } from 'node:perf_hooks';

import { readConfig } from '../config.js';
import { initializeKnowledgeDatabase, maintainKnowledgeDatabase } from '../knowledgeStore.js';
import { pruneNativeToolTasks } from '../mcp/nativeToolTasks.js';
import { initializeStateDatabase, maintainStateDatabase } from '../stateDatabase.ts';
import { initializeTelemetry } from '../telemetry.js';

export interface RelaiCoreRuntimeOptions {
  config?: Record<string, unknown>;
  isolated?: boolean;
  stopManagedProcessesOnShutdown?: boolean;
}

export interface CoreShutdownResult {
  clean: boolean;
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
    const pruneStarted = performance.now();
    if (!isolated) pruneNativeToolTasks(config);
    const nativeTaskPruneMs = performance.now() - pruneStarted;
    startup = {
      config,
      isolated,
      state,
      knowledge,
      telemetry,
      startupTimings: {
        stateDatabaseMs,
        knowledgeDatabaseMs,
        telemetrySetupMs,
        nativeTaskPruneMs
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
    const labels = [
      'audit',
      'taskHistory',
      'analytics',
      'managedProcesses',
      'browserSessions',
      'uiSessions',
      'telemetry',
      'repositoryIntelligence'
    ] as const;
    const settled = await Promise.allSettled([
      auditModule.flushAuditWrites(),
      taskHistoryModule.flushTaskHistoryPersistence(),
      analyticsModule.flushLocalAnalytics(),
      managedProcessesPromise,
      browserRuntimeModule.stopAllBrowserSessions(),
      webAutomationModule.stopAllUiSessions(),
      telemetryModule.shutdownTelemetry(),
      repositoryIntelligencePromise
    ]);

    const maintenance = await Promise.allSettled([
      Promise.resolve().then(() => maintainStateDatabase(config)),
      Promise.resolve().then(() => maintainKnowledgeDatabase(config))
    ]);
    const managedProcesses = settledRecord(
      settled[3],
      { attempted: 0, stopped: 0, orphaned: 1, error: settledError(settled[3]) }
    );
    const repositoryIntelligence = settledRecord(
      settled[7],
      { closed: false, error: settledError(settled[7]) }
    );
    const errors: Array<{ step: string; error: string }> = settled.flatMap((result, index) => result.status === 'rejected'
      ? [{ step: labels[index] ?? `step-${index}`, error: errorMessage(result.reason) }]
      : []);
    if (maintenance[0]?.status === 'rejected') errors.push({ step: 'stateMaintenance', error: errorMessage(maintenance[0].reason) });
    if (maintenance[1]?.status === 'rejected') errors.push({ step: 'knowledgeMaintenance', error: errorMessage(maintenance[1].reason) });

    return {
      clean: errors.length === 0 && Number(managedProcesses.orphaned || 0) === 0 && repositoryIntelligence.closed !== false,
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
