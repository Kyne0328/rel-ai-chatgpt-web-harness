export const CONNECTION_STATE_VALUES = Object.freeze({
  localService: Object.freeze(['running', 'starting', 'stopped', 'failed'] as const),
  publicEndpoint: Object.freeze(['available', 'connecting', 'degraded', 'unavailable', 'disabled'] as const),
  chatgptReadiness: Object.freeze(['ready', 'unavailable'] as const),
  dashboardUpdates: Object.freeze(['live', 'connecting', 'reconnecting', 'paused', 'offline'] as const)
});

export type LocalServiceStatus = typeof CONNECTION_STATE_VALUES.localService[number];
export type PublicEndpointStatus = typeof CONNECTION_STATE_VALUES.publicEndpoint[number];
export type ChatgptReadinessStatus = typeof CONNECTION_STATE_VALUES.chatgptReadiness[number];
export type DashboardUpdateStatus = typeof CONNECTION_STATE_VALUES.dashboardUpdates[number];

export interface ConnectionStateDto {
  localService: { status: LocalServiceStatus };
  publicEndpoint: { status: PublicEndpointStatus; retryAttempt: number; nextRetryAt: string | null };
  chatgptReadiness: { status: ChatgptReadinessStatus };
  dashboardUpdates: { status: DashboardUpdateStatus };
  error: { code: string; message: string } | null;
}

import { ERROR_CODES, normalizeErrorCode } from './errors.ts';

const localFailureCodes = new Set<string>([
  ERROR_CODES.CONFIGURATION_INVALID,
  ERROR_CODES.LOCAL_SERVICE_START_FAILED,
  ERROR_CODES.LOCAL_SERVICE_STOP_FAILED,
  ERROR_CODES.LOCAL_PORT_IN_USE
]);

function normalizeDashboardUpdateStatus(value: unknown): DashboardUpdateStatus {
  const state = String(value || '').trim();
  if ((CONNECTION_STATE_VALUES.dashboardUpdates as readonly string[]).includes(state)) return state as DashboardUpdateStatus;
  return 'offline';
}

export function deriveConnectionState(status: Record<string, unknown> = {}): ConnectionStateDto {
  const errorCode = normalizeErrorCode(status.errorCode);
  const localServiceStatus: LocalServiceStatus = status.serverRunning === true
    ? 'running'
    : status.starting === true
      ? 'starting'
      : localFailureCodes.has(errorCode)
        ? 'failed'
        : 'stopped';

  const tunnelStatus = typeof status.tunnelStatus === 'string' ? status.tunnelStatus : '';
  const peers = Array.isArray(status.additionalTunnelStatuses)
    ? status.additionalTunnelStatuses.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && item.enabled !== false)
    : [];
  const tunnelStates = [tunnelStatus, ...peers.map(item => String(item.state || ''))];
  let publicEndpointStatus: PublicEndpointStatus = 'disabled';
  if (tunnelStates.includes('running')) publicEndpointStatus = 'available';
  else if (tunnelStates.includes('degraded')) publicEndpointStatus = 'degraded';
  else if (tunnelStates.some(value => ['starting', 'locally_ready', 'authenticating', 'connecting'].includes(value))) publicEndpointStatus = 'connecting';
  else if (tunnelStates.includes('failed')) publicEndpointStatus = 'unavailable';

  const chatgptReadinessStatus: ChatgptReadinessStatus = localServiceStatus === 'running' && publicEndpointStatus === 'available'
    ? 'ready'
    : 'unavailable';
  const message = String(status.error || '').trim();
  return {
    localService: { status: localServiceStatus },
    publicEndpoint: {
      status: publicEndpointStatus,
      retryAttempt: publicEndpointStatus === 'available' ? 0 : Math.max(0, Number(status.tunnelRetryAttempt || 0)),
      nextRetryAt: publicEndpointStatus !== 'available' && typeof status.tunnelNextRetryAt === 'string' ? status.tunnelNextRetryAt : null
    },
    chatgptReadiness: { status: chatgptReadinessStatus },
    dashboardUpdates: { status: normalizeDashboardUpdateStatus(status.dashboardUpdateStatus) },
    error: message && !(chatgptReadinessStatus === 'ready' && !localFailureCodes.has(errorCode))
      ? { code: errorCode || ERROR_CODES.UNKNOWN, message } : null
  };
}
