import { clearAuditHistory, readAudit } from '../audit.js';
import { readConfig } from '../config.js';
import * as connection from '../connectionProfile.js';
import { deriveConnectionState } from '../contracts/connection.ts';
import type { DiagnosticResetTarget } from '../contracts/diagnostics.ts';
import { ERROR_CODES } from '../contracts/errors.ts';
import { buildDiagnosticReport } from '../diagnostics.js';
import { hostResourceDiagnosticSnapshot, refreshHostResourceDiagnostics } from '../hostResourceScheduler.js';
import { resourceDiagnosticsSnapshot } from '../resourceDiagnostics.js';
import { cacheStats } from '../sessionCache.js';
import { sampleManagedProcessMemory } from '../processManager.js';
import { clearLocalAnalytics } from '../localAnalytics.js';
import * as productUx from '../productUx.js';
import { taskHistoryPersistenceSnapshot } from '../taskHistoryStore.ts';
import { activeLogicalTaskCount } from '../taskState.js';

export interface DiagnosticsRuntimeOptions {
  host?: string;
  port?: number;
  token?: string;
  getDesktopStatus?: () => Record<string, unknown>;
  getTaskActivity?: () => Record<string, unknown>;
  getRuntimeLogs?: (options?: { limit?: number }) => Record<string, unknown>;
  resetTaskActivity?: () => Record<string, unknown>;
  clearRuntimeLogs?: () => Promise<unknown> | unknown;
}

interface DiagnosticResetFailure {
  ok: false;
  category: 'conflict';
  errorCode: string;
  error: string;
}

interface DiagnosticResetSuccess {
  ok: true;
  target: DiagnosticResetTarget;
  history: unknown | null;
  runtimeLogs: unknown | null;
  analytics: unknown | null;
  message: string;
}

export type DiagnosticResetOutcome = DiagnosticResetFailure | DiagnosticResetSuccess;

export async function getDiagnosticsReport(
  options: DiagnosticsRuntimeOptions,
  workspace = '',
  { includeManagedProcessMemory = false, refreshResources = false }: { includeManagedProcessMemory?: boolean; refreshResources?: boolean } = {}
): Promise<Record<string, unknown>> {
  const config = readConfig();
  const hostResources = refreshResources ? await refreshHostResourceDiagnostics() : hostResourceDiagnosticSnapshot();
  // Only the authenticated local dashboard route opts into owned-root details.
  // This report is not an automatic telemetry or public MCP response.
  let managedRoots = null;
  if (includeManagedProcessMemory) {
    try {
      managedRoots = await sampleManagedProcessMemory(config, { workspace, limit: 20 }, { internal: true });
    } catch {
      managedRoots = {
        scope: 'managed_roots_only', roots: [], sampledAt: null, cacheAgeMs: null,
        totalRootCount: null, omittedRootCount: null, stale: true,
        descendantAttribution: 'unknown', reason: 'Managed-root memory is unavailable for this authorized scope.'
      };
    }
  }
  const profile = connection.readConnectionProfile();
  const connectionSummary = connection.buildConnectionSummary({
    host: profile.host || options.host || '127.0.0.1',
    port: profile.port || options.port || 3333,
    token: options.token,
    tunnelId: profile.tunnelId || '',
    tunnelProvider: 'openai-secure-mcp',
    showToken: false,
    includeTokenInUrls: false
  });
  const desktopStatus = typeof options.getDesktopStatus === 'function' ? options.getDesktopStatus() : null;
  const desktopBuildStatus = desktopStatus?.buildStatus;
  const buildId = desktopBuildStatus && typeof desktopBuildStatus === 'object' && !Array.isArray(desktopBuildStatus)
    ? String((desktopBuildStatus as Record<string, unknown>).buildId || '').trim()
    : '';
  const connectionState = desktopStatus?.connectionState || deriveConnectionState(desktopStatus || {
    serverRunning: false,
    tunnelStatus: 'stopped'
  });
  const activity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : {};
  const runtimeLogs = typeof options.getRuntimeLogs === 'function'
    ? options.getRuntimeLogs({ limit: 100 })
    : { available: false, count: 0, entries: [] };
  const auditLogs = readAudit(config, { limit: 200, ...(workspace ? { workspace } : {}) });
  return buildDiagnosticReport({
    workspace,
    application: { version: String(desktopStatus?.version || '').trim(), build: buildId },
    health: productUx.healthMonitor(config),
    cautionData: productUx.cautionSummary(config, { windowHours: 24, limit: 500 }),
    connection: connectionSummary,
    connectionState,
    tunnelHealth: desktopStatus?.tunnelHealth || null,
    resourceDiagnostics: resourceDiagnosticsSnapshot(hostResources, cacheStats(), managedRoots),
    runtimeLogs,
    auditLogs,
    taskHistoryPersistence: taskHistoryPersistenceSnapshot(),
    activeTaskCount: activeLogicalTaskCount(activity)
  });
}

export async function resetDiagnostics(
  target: DiagnosticResetTarget,
  options: DiagnosticsRuntimeOptions
): Promise<DiagnosticResetOutcome> {
  const activity = typeof options.getTaskActivity === 'function' ? options.getTaskActivity() : {};
  const activeTasks = activeLogicalTaskCount(activity);
  if ((target === 'history' || target === 'analytics') && activeTasks > 0) {
    const noun = activeTasks === 1 ? 'task is' : 'tasks are';
    const data = target === 'analytics' ? 'analytics' : 'session and activity history';
    return failure(`Cannot clear ${data} while ${activeTasks} Rel.AI ${noun} still active.`);
  }
  if (target === 'runtime_logs' && typeof options.clearRuntimeLogs !== 'function') {
    return failure('Service logs can be cleared only in the Rel.AI desktop app.');
  }

  const result: DiagnosticResetSuccess = { ok: true, target, history: null, runtimeLogs: null, analytics: null, message: resetMessage(target) };
  if (target === 'history') {
    const history = await clearHistory(options);
    if (!history.ok) return history;
    result.history = history.value;
  }
  if (target === 'runtime_logs') result.runtimeLogs = await options.clearRuntimeLogs!();
  if (target === 'analytics') result.analytics = await clearLocalAnalytics(readConfig());
  return result;
}

async function clearHistory(options: DiagnosticsRuntimeOptions): Promise<{ ok: true; value: { removedFiles: number; removedBytes: number } } | DiagnosticResetFailure> {
  if (typeof options.resetTaskActivity === 'function') {
    const reset = options.resetTaskActivity();
    if (reset?.ok === false) return failure(typeof reset.error === 'string' ? reset.error : 'Session history could not be cleared.');
  }
  const cleared = await clearAuditHistory(readConfig());
  return { ok: true, value: { removedFiles: cleared.removedFiles, removedBytes: cleared.removedBytes } };
}

function failure(error: string): DiagnosticResetFailure {
  return { ok: false, category: 'conflict', errorCode: ERROR_CODES.STATE_RESET_FAILED, error };
}

function resetMessage(target: DiagnosticResetTarget): string {
  if (target === 'history') return 'Session and activity history cleared.';
  if (target === 'runtime_logs') return 'Persistent service log cleared.';
  return 'Local analytics cleared.';
}
