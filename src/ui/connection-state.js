const DEFAULT_STATE = Object.freeze({
  localService: { status: 'stopped' },
  publicEndpoint: { status: 'disabled' },
  chatgptReadiness: { status: 'unavailable' },
  mcpClient: { status: 'stopped' },
  dashboardUpdates: { status: 'offline' },
  error: null
});

const LAYERS = Object.freeze([
  ['localService', 'Local Rel.AI service', { running: ['Running','ok','The local Rel.AI service is running only on this computer.'], starting: ['Starting','working','Rel.AI is starting the local service.'], stopped: ['Stopped','warn','The local Rel.AI service is stopped.'], failed: ['Failed','bad','The local Rel.AI service failed to start.'] }],
  ['publicEndpoint', 'OpenAI Secure MCP Tunnel', { available: ['Connected','ok','The Secure MCP Tunnel is ready to forward ChatGPT requests to this computer.'], connecting: ['Connecting','working','Rel.AI is establishing the Secure MCP Tunnel.'], degraded: ['Tunnel reconnecting','warn','The Secure MCP Tunnel was interrupted. Rel.AI is retrying automatically while the local service stays running.'], unavailable: ['Unavailable','bad','The Secure MCP Tunnel could not become ready.'], disabled: ['Not configured','warn','A Secure MCP Tunnel ID and runtime API key are required.'] }],
  ['chatgptReadiness', 'Ready for ChatGPT', { ready: ['Ready','ok','Rel.AI is ready for ChatGPT requests through the configured tunnel.'], unavailable: ['Unavailable','warn','Rel.AI becomes ready for ChatGPT after the local service and Secure MCP Tunnel are connected.'] }],
  ['mcpClient', 'ChatGPT requests', { stopped: ['Stopped','warn','Rel.AI is not accepting ChatGPT requests.'], starting: ['Starting','working','Rel.AI is starting the local connection.'], active: ['Active now','working','One or more ChatGPT requests are running.'], recent: ['Recently active','ok','A recent ChatGPT request completed through Rel.AI.'], connected: ['Recently active','ok','A recent ChatGPT request completed through Rel.AI.'], idle: ['Ready','ok','Rel.AI is ready for ChatGPT requests.'], no_requests: ['Ready','ok','The tunnel is ready. ChatGPT has not sent a request since Rel.AI started.'], request_failed: ['Last request failed','warn','The last ChatGPT request failed. Rel.AI is ready for another request.'], failed: ['Failed','bad','The Rel.AI connection failed.'], ready: ['Ready','ok','Rel.AI is ready for ChatGPT requests.'] }],
  ['dashboardUpdates', 'Dashboard updates', { live: ['Live','ok','This dashboard is receiving live local state updates.'], connecting: ['Updates connecting','working','The dashboard is connecting live updates.'], reconnecting: ['Updates reconnecting','working','The dashboard is restoring live updates.'], paused: ['Updates paused','warn','Live dashboard updates are paused.'], offline: ['Updates offline','bad','This dashboard is not receiving live updates.'] }]
]);

const ALLOWED = Object.freeze({
  localService: new Set(['running','starting','stopped','failed']),
  publicEndpoint: new Set(['available','connecting','degraded','unavailable','disabled']),
  chatgptReadiness: new Set(['ready','unavailable']),
  mcpClient: new Set(['stopped','starting','active','recent','connected','idle','no_requests','request_failed','failed','ready']),
  dashboardUpdates: new Set(['live','connecting','reconnecting','paused','offline'])
});

function normalizeConnectionState(state = {}) {
  return {
    localService: normalizeLayer('localService', state.localService, DEFAULT_STATE.localService.status),
    publicEndpoint: normalizeLayer('publicEndpoint', state.publicEndpoint, DEFAULT_STATE.publicEndpoint.status),
    chatgptReadiness: normalizeLayer('chatgptReadiness', state.chatgptReadiness, DEFAULT_STATE.chatgptReadiness.status),
    mcpClient: normalizeLayer('mcpClient', state.mcpClient, DEFAULT_STATE.mcpClient.status),
    dashboardUpdates: normalizeLayer('dashboardUpdates', state.dashboardUpdates, DEFAULT_STATE.dashboardUpdates.status),
    error: normalizeError(state.error)
  };
}
export function connectionStateFor(data = {}, dashboardStatus = '') {
  const desktopState = data.desktopStatus?.connectionState;
  const source = data.connectionState || desktopState || DEFAULT_STATE;
  const mcpConnection = data.mcpConnection && typeof data.mcpConnection === 'object' ? { ...data.mcpConnection, status: normalizeActivity(data.mcpConnection.activityStatus || data.mcpConnection.status) } : source.mcpClient;
  const normalized = normalizeConnectionState({ ...source, mcpClient: mcpConnection });
  normalized.mode = 'secure_tunnel';
  // Backend connection state already aggregates all enabled tunnels. Raw runtime
  // states supply presentation counts only; they never replace that authority.
  if (desktopState?.publicEndpoint) {
    normalized.localService = normalizeLayer('localService', desktopState.localService, DEFAULT_STATE.localService.status);
    normalized.publicEndpoint = normalizeLayer('publicEndpoint', desktopState.publicEndpoint, DEFAULT_STATE.publicEndpoint.status);
    normalized.error = normalizeError(desktopState.error);
  }
  const readiness = desktopState?.chatgptReadiness || source.chatgptReadiness;
  normalized.chatgptReadiness = readiness
    ? normalizeLayer('chatgptReadiness', readiness, DEFAULT_STATE.chatgptReadiness.status)
    : { status: normalized.localService.status === 'running' && normalized.publicEndpoint.status === 'available' ? 'ready' : 'unavailable' };
  if (data.desktopStatus) {
    const endpoint = { ...normalized.publicEndpoint };
    for (const key of ['connectionCount', 'availableCount', 'reconnectingCount', 'connectingCount', 'unavailableCount', 'stoppedCount', 'issueCount']) delete endpoint[key];
    normalized.publicEndpoint = endpoint;
    const rawPrimary = String(data.desktopStatus.tunnelStatus || '').trim();
    if (rawPrimary) {
      const primary = tunnelRuntimeView({ state: rawPrimary });
      const primaryConfigured = Boolean(data.desktopStatus.tunnelId || primary.status !== 'disabled');
      const peers = Array.isArray(data.desktopStatus.additionalTunnelStatuses) ? data.desktopStatus.additionalTunnelStatuses : [];
      normalized.publicEndpoint = { ...endpoint, ...tunnelEndpointCounts(primary.status, peers, primaryConfigured) };
    }
  }
  if (dashboardStatus) normalized.dashboardUpdates = { status: ALLOWED.dashboardUpdates.has(dashboardStatus) ? dashboardStatus : 'offline' };
  return normalized;
}
export function withConnectionState(data = {}, dashboardStatus = '') { return { ...data, connectionState: connectionStateFor(data, dashboardStatus) }; }
export function isMcpAuthenticationReady(state = {}) { return String(state.chatgptReadiness?.status || state.status || '') === 'ready'; }
export function hasObservedMcpConnection(connection = {}) {
  if (connection.lastRequestAt || connection.lastSuccessfulRequestAt || connection.lastFailedRequestAt) return true;
  if (Number(connection.activeRequestCount || 0) > 0) return true;
  return ['active', 'recent', 'connected', 'request_failed', 'idle'].includes(String(connection.activityStatus || connection.status || ''));
}
export function hasObservedMcpToolCall(connection = {}) {
  if (String(connection.lastRequestMethod || connection.lastMethod || '') === 'tools/call') return true;
  return Array.isArray(connection.recentEvents) && connection.recentEvents.some(event => String(event?.method || '') === 'tools/call');
}
export function connectionLayerViews(state = {}) {
  const normalized = normalizeConnectionState(state);
  return LAYERS.map(([key,title,descriptions]) => {
    const value = normalized[key];
    if (key === 'publicEndpoint' && Number(value.connectionCount || 0) > 1) {
      return { key, title: 'Secure MCP tunnels', status: value.status, ...multiTunnelLayerView(value) };
    }
    const [label,tone,description] = descriptions[value.status] || ['Unknown','warn','Connection state is unavailable.'];
    return { key,title,status:value.status,label,tone,description:key==='mcpClient'?requestDescription(value,description):description };
  });
}
export function connectionSummary(state = {}) {
  const normalized = normalizeConnectionState(state);
  const local = normalized.localService.status;
  const tunnel = normalized.publicEndpoint.status;
  const activity = normalized.mcpClient.status;
  if (local === 'failed') return summary('Rel.AI could not start', 'Needs attention', 'bad', 'Open Troubleshooting for details and recovery options.');
  if (local === 'stopped') return summary('Rel.AI is stopped', 'Stopped', 'warn', 'Start or restart Rel.AI before ChatGPT can use this computer.');
  if (local === 'starting') return summary('Starting Rel.AI', 'Starting', 'working', 'Rel.AI is getting this computer ready for ChatGPT.');
  if (tunnel === 'unavailable') return summary('ChatGPT connection unavailable', 'Needs attention', 'bad', 'Review the Connection settings for this computer or open Troubleshooting.');
  if (tunnel === 'disabled') return summary('Connect this computer', 'Setup required', 'warn', 'Set up the Secure MCP Tunnel for this computer.');
  if (tunnel === 'connecting') return summary('Connecting to ChatGPT', 'Connecting', 'working', 'Rel.AI is finishing the secure connection. No setup changes are needed while it connects.');
  if (tunnel === 'degraded') { const retry=normalized.publicEndpoint; const detail=retry.nextRetryAt?` Retry ${Math.max(1,Number(retry.retryAttempt||1))} is scheduled automatically.`:''; return summary('ChatGPT connection interrupted', 'Tunnel reconnecting', 'warn', `The local service is still running while Rel.AI retries the Secure MCP Tunnel automatically.${detail}`); }
  if (tunnel === 'available' && Number(normalized.publicEndpoint.connectionCount || 0) > 1 && Number(normalized.publicEndpoint.issueCount || 0) > 0) {
    return summary('Rel.AI is connected', 'Connected', 'warn', partialTunnelMessage(normalized.publicEndpoint));
  }
  if (activity === 'request_failed') return summary('The last ChatGPT request failed', 'Last request failed', 'warn', 'The local Rel.AI service and Secure MCP Tunnel are ready for another request. Restart Rel.AI only if a connection layer has a problem.');
  if (activity === 'active') return summary('ChatGPT is using Rel.AI', 'Active now', 'working', 'A request from ChatGPT is in progress.');
  if (activity === 'recent' || activity === 'connected') return summary('Rel.AI is available to ChatGPT', 'Recently active', 'ok', 'A recent ChatGPT request completed successfully.');
  return summary('Rel.AI is ready for ChatGPT', 'Ready', 'ok', 'This computer is connected and ready for ChatGPT.');
}
export function tunnelRuntimeView(status = {}) {
  const state = String(status?.state || status?.status || '');
  if (status?.retry?.scheduled || status?.retry?.inFlight || state === 'degraded') return { status: 'degraded', label: 'Reconnecting', tone: 'warn' };
  if (state === 'running' || state === 'available') return { status: 'available', label: 'Connected', tone: 'good' };
  if (state === 'failed' || state === 'unavailable') return { status: 'unavailable', label: 'Failed', tone: 'bad' };
  if (['starting', 'locally_ready', 'authenticating', 'connecting'].includes(state)) return { status: 'connecting', label: 'Connecting', tone: 'working' };
  return { status: 'disabled', label: 'Stopped', tone: 'neutral' };
}
function tunnelEndpointCounts(primaryStatus, additionalStatuses, primaryConfigured) {
  const states = [];
  if (primaryConfigured) states.push(primaryStatus);
  for (const status of additionalStatuses) {
    if (!status || typeof status !== 'object' || status.enabled === false) continue;
    states.push(tunnelRuntimeView(status).status);
  }
  const availableCount = states.filter(status => status === 'available').length;
  const reconnectingCount = states.filter(status => status === 'degraded').length;
  const connectingCount = states.filter(status => status === 'connecting').length;
  const unavailableCount = states.filter(status => status === 'unavailable').length;
  const stoppedCount = states.filter(status => status === 'disabled').length;
  return {
    connectionCount: states.length,
    availableCount,
    reconnectingCount,
    connectingCount,
    unavailableCount,
    stoppedCount,
    issueCount: reconnectingCount + connectingCount + unavailableCount + stoppedCount
  };
}
function multiTunnelLayerView(value) {
  const total = Number(value.connectionCount || 0);
  const connected = Number(value.availableCount || 0);
  const issues = Number(value.issueCount || 0);
  if (value.status === 'available') {
    return {
      label: issues > 0 ? `${connected} of ${total} connected` : `${connected} connected`,
      tone: issues > 0 ? 'warn' : 'ok',
      description: issues > 0 ? partialTunnelMessage(value) : 'All configured Secure MCP Tunnels are connected and ready for ChatGPT requests.'
    };
  }
  if (value.status === 'degraded') return { label: 'Tunnels reconnecting', tone: 'warn', description: 'No tunnel is currently connected. Rel.AI is retrying one or more Secure MCP Tunnels automatically.' };
  if (value.status === 'connecting') return { label: 'Tunnels connecting', tone: 'working', description: 'Rel.AI is establishing one or more Secure MCP Tunnel connections.' };
  if (value.status === 'unavailable') return { label: 'Unavailable', tone: 'bad', description: 'None of the configured Secure MCP Tunnels could become ready.' };
  return { label: 'Not connected', tone: 'warn', description: 'No configured Secure MCP Tunnel is currently connected.' };
}
function partialTunnelMessage(value) {
  const connected = Math.max(1, Number(value.availableCount || 0));
  const total = Math.max(connected, Number(value.connectionCount || connected));
  const details = [];
  const reconnecting = Number(value.reconnectingCount || 0);
  const connecting = Number(value.connectingCount || 0);
  const unavailable = Number(value.unavailableCount || 0);
  const stopped = Number(value.stoppedCount || 0);
  if (reconnecting) details.push(`${reconnecting} tunnel${reconnecting === 1 ? ' is' : 's are'} reconnecting.`);
  if (connecting) details.push(`${connecting} tunnel${connecting === 1 ? ' is' : 's are'} connecting.`);
  if (unavailable) details.push(`${unavailable} tunnel${unavailable === 1 ? ' is' : 's are'} unavailable.`);
  if (stopped) details.push(`${stopped} tunnel${stopped === 1 ? ' is' : 's are'} stopped.`);
  return `ChatGPT can still reach Rel.AI through ${connected} of ${total} configured tunnel${total === 1 ? '' : 's'}.${details.length ? ` ${details.join(' ')}` : ''}`;
}
function normalizeLayer(key,value,fallback){const source=value&&typeof value==='object'?value:{};const status=String(source.status||fallback);return{...source,status:ALLOWED[key].has(status)?status:fallback};}
function normalizeActivity(value){const status=String(value||'no_requests');if(ALLOWED.mcpClient.has(status))return status;if(status==='request_succeeded')return'recent';return'no_requests';}
function normalizeError(error){if(!error||typeof error!=='object')return null;const message=String(error.message||'').trim();return message?{code:String(error.code||'unknown'),message}:null;}
function summary(title,label,tone,message){return{title,label,tone,message};}
function requestDescription(value={},fallback){const at=value.lastRequestAt||value.lastSuccessfulRequestAt||value.lastFailedRequestAt,method=String(value.lastMethod||''),name=String(value.lastToolName||'');if(!at&&!method&&!name)return fallback;const parts=[];if(name)parts.push(`Latest tool: ${name}.`);else if(method)parts.push(`Latest request: ${method}.`);if(at)parts.push(`Observed ${new Date(at).toLocaleString()}.`);return parts.join(' ')||fallback;}
