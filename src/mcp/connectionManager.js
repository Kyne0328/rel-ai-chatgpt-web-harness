import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isMcpAuthMode } from '../contracts/mcp.ts';
import { MCP_PROTOCOL_VERSION } from '../contracts/mcp.ts';
const RECENT_ACTIVITY_MS = 2 * 60 * 1000;

class McpConnectionManager {
  constructor(options = {}) {
    this.clock = options.clock || (() => Date.now());
    this.recentActivityMs = Math.max(1, Number(options.recentActivityMs || RECENT_ACTIVITY_MS));
    this.events = new EventEmitter();
    this.eventHistory = [];
    this.metrics = emptyMetrics();
    this.revision = 0;
    this.state = 'stopped';
    this.serverInstanceId = '';
    this.credentialGeneration = 0;
    this.configurationGeneration = 0;
    this.manifest = null;
    this.lastDisconnectReason = '';
    this.lastRequestAt = null;
    this.lastRequestMethod = '';
    this.lastPrincipal = '';
    this.activeRequests = new Map();
    this.activityExpiryTimer = null;
    this.lastAuthenticatedAt = null;
    this.lastAuthenticationFailureAt = null;
    this.lastAuthMode = '';
    this.lastCompletedRequestAt = null;
    this.lastSuccessfulRequestAt = null;
    this.lastFailedRequestAt = null;
    this.lastRecoveredRequestAt = null;
    this.lastRequestSucceeded = null;
  }

  configure({ serverInstanceId, credentialGeneration, configurationGeneration, manifest }) {
    this.metrics = emptyMetrics();
    this.serverInstanceId = String(serverInstanceId || crypto.randomUUID());
    this.credentialGeneration = Number(credentialGeneration || 1);
    this.configurationGeneration = Number(configurationGeneration || 1);
    this.manifest = manifest || null;
    this.state = 'starting';
    this.lastDisconnectReason = '';
    this.lastRequestAt = null;
    this.lastRequestMethod = '';
    this.lastPrincipal = '';
    this.resetRequestState();
    this.record('mcp_server_starting', { requestModel: 'stateless' });
    return this.snapshot();
  }

  markReady() {
    this.state = 'ready';
    this.record('mcp_server_ready', { requestModel: 'stateless' });
  }

  markFailed(error) {
    this.state = 'failed';
    this.record('mcp_server_failed', { reasonCode: 'server_error', outcome: messageOf(error) });
  }

  async shutdown(reason = 'server_shutdown') {
    this.state = 'stopped';
    this.lastDisconnectReason = String(reason || 'server_shutdown');
    this.clearActivityExpiry();
    this.activeRequests.clear();
    this.record('mcp_server_stopped', { reasonCode: this.lastDisconnectReason });
  }

  beginRequest({ principal = '', method = '', authMode = '', clientInfo = {}, clientCapabilities = {} } = {}) {
    const requestId = crypto.randomUUID();
    const now = this.clock();
    const normalizedAuthMode = normalizeAuthMode(authMode);
    this.lastRequestAt = now;
    this.lastRequestMethod = String(method || '');
    this.lastPrincipal = safeId(principal);
    this.lastAuthenticatedAt = now;
    this.lastAuthMode = normalizedAuthMode;
    this.activeRequests.set(requestId, {
      method: this.lastRequestMethod,
      authMode: normalizedAuthMode,
      startedAt: now
    });
    this.metrics.requestsReceived += 1;
    if (this.lastRequestMethod === 'server/discover') this.metrics.discoveryRequests += 1;
    if (this.lastRequestMethod === 'tools/list') this.metrics.toolListRequests += 1;
    if (this.state === 'degraded') this.state = 'ready';
    this.record('mcp_request_received', {
      requestId,
      method: this.lastRequestMethod,
      principal: this.lastPrincipal,
      authMode: normalizedAuthMode,
      activeRequestCount: this.activeRequests.size,
      clientInfo: safeClientInfo(clientInfo),
      clientCapabilities: safeClientCapabilities(clientCapabilities)
    });
    return requestId;
  }

  finishRequest(requestId, { method = '', ok = true } = {}) {
    const normalizedRequestId = String(requestId || '');
    const active = this.activeRequests.get(normalizedRequestId) || null;
    if (!active) return this.snapshot();
    this.activeRequests.delete(normalizedRequestId);
    const completedAt = this.clock();
    const requestMethod = String(method || active?.method || this.lastRequestMethod || '');
    const recoveredFromFailure = ok === true
      && Boolean(this.lastFailedRequestAt)
      && (!this.lastSuccessfulRequestAt || this.lastFailedRequestAt > this.lastSuccessfulRequestAt);
    this.lastCompletedRequestAt = completedAt;
    this.lastRequestMethod = requestMethod;
    this.lastRequestSucceeded = ok === true;
    if (ok) this.metrics.requestsSucceeded += 1;
    else this.metrics.requestsFailed += 1;
    if (ok) {
      this.lastSuccessfulRequestAt = completedAt;
      if (recoveredFromFailure) {
        this.lastRecoveredRequestAt = completedAt;
        this.metrics.requestRecoveries += 1;
      }
      this.scheduleActivityExpiry();
    } else {
      this.lastFailedRequestAt = completedAt;
    }
    this.record(ok ? 'mcp_request_succeeded' : 'mcp_request_failed', {
      requestId: normalizedRequestId,
      method: requestMethod,
      activeRequestCount: this.activeRequests.size
    });
    if (recoveredFromFailure) {
      this.record('mcp_request_recovered', {
        requestId: normalizedRequestId,
        method: requestMethod,
        activeRequestCount: this.activeRequests.size
      });
    }
    return this.snapshot();
  }

  noteAuthenticationFailure(reasonCode = 'invalid_or_missing_bearer') {
    this.lastAuthenticationFailureAt = this.clock();
    this.record('authentication_failed', { reasonCode: String(reasonCode || 'authentication_failed') });
    return this.snapshot();
  }

  async observeManifest(manifest, triggerMethod = '') {
    if (!manifest) return false;
    if (this.manifest?.version === manifest.version) return false;
    const previous = this.manifest;
    this.manifest = manifest;
    this.metrics.toolManifestChanges += 1;
    this.record('tool_manifest_changed', {
      triggerMethod: String(triggerMethod || ''),
      previousToolManifestVersion: previous?.version || '',
      toolManifestVersion: manifest.version,
      activeToolCount: manifest.activeToolCount
    });
    return true;
  }

  async invalidateCredentials(nextGeneration, reason = 'approval_token_rotated') {
    this.credentialGeneration = Number(nextGeneration || this.credentialGeneration + 1);
    this.resetRequestState();
    this.record('credential_generation_changed', { reasonCode: reason });
    this.record('approval_token_rotated', { reasonCode: reason });
    return this.snapshot();
  }

  snapshot() {
    return {
      status: this.state,
      activityStatus: this.activityStatus(),
      requestModel: 'stateless',
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInstanceId: this.serverInstanceId,
      configurationGeneration: this.configurationGeneration,
      credentialGeneration: this.credentialGeneration,
      toolManifestVersion: this.manifest?.version || '',
      toolManifestHash: this.manifest?.hash || '',
      currentActiveToolCount: this.manifest?.activeToolCount || 0,
      disabledToolCount: this.manifest?.disabledToolCount || 0,
      filteredToolCount: this.manifest?.filteredToolCount || 0,
      externallyVisibleToolCount: this.manifest?.externallyVisibleToolCount || 0,
      lastDisconnectReason: this.lastDisconnectReason,
      activeRequestCount: this.activeRequests.size,
      lastRequestAt: iso(this.lastRequestAt),
      lastRequestMethod: this.lastRequestMethod,
      lastPrincipal: this.lastPrincipal,
      lastAuthenticatedAt: iso(this.lastAuthenticatedAt),
      lastAuthenticationFailureAt: iso(this.lastAuthenticationFailureAt),
      lastAuthMode: this.lastAuthMode,
      lastCompletedRequestAt: iso(this.lastCompletedRequestAt),
      lastSuccessfulRequestAt: iso(this.lastSuccessfulRequestAt),
      lastFailedRequestAt: iso(this.lastFailedRequestAt),
      lastRecoveredRequestAt: iso(this.lastRecoveredRequestAt),
      lastRequestSucceeded: this.lastRequestSucceeded,
      metrics: { ...this.metrics },
      recentEvents: this.eventHistory.slice(-50),
      revision: this.revision,
      generatedAt: new Date(this.clock()).toISOString()
    };
  }

  record(type, fields = {}) {
    const event = {
      eventId: crypto.randomUUID(),
      type,
      timestamp: new Date(this.clock()).toISOString(),
      serverInstanceId: this.serverInstanceId,
      credentialGeneration: this.credentialGeneration,
      configurationGeneration: this.configurationGeneration,
      toolManifestVersion: this.manifest?.version || '',
      ...redactFields(fields)
    };
    this.eventHistory.push(event);
    this.eventHistory = this.eventHistory.slice(-200);
    this.revision += 1;
    this.events.emit('event', event);
    if (this.events.listenerCount('change') > 0) this.events.emit('change', this.snapshot());
    return event;
  }

  onChange(listener) {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  activityStatus() {
    if (['stopped', 'starting', 'degraded', 'failed'].includes(this.state)) return this.state;
    if (this.activeRequests.size > 0) return 'active';
    if (!this.lastRequestAt) return 'no_requests';
    if (this.lastFailedRequestAt && (!this.lastSuccessfulRequestAt || this.lastFailedRequestAt > this.lastSuccessfulRequestAt)) {
      return 'request_failed';
    }
    if (this.lastSuccessfulRequestAt && this.clock() - this.lastSuccessfulRequestAt <= this.recentActivityMs) return 'recent';
    return 'idle';
  }

  resetRequestState() {
    this.clearActivityExpiry();
    this.activeRequests.clear();
    this.lastRequestAt = null;
    this.lastRequestMethod = '';
    this.lastPrincipal = '';
    this.lastAuthenticatedAt = null;
    this.lastAuthenticationFailureAt = null;
    this.lastAuthMode = '';
    this.lastCompletedRequestAt = null;
    this.lastSuccessfulRequestAt = null;
    this.lastFailedRequestAt = null;
    this.lastRecoveredRequestAt = null;
    this.lastRequestSucceeded = null;
  }

  scheduleActivityExpiry() {
    this.clearActivityExpiry();
    this.activityExpiryTimer = setTimeout(() => {
      this.activityExpiryTimer = null;
      this.revision += 1;
      if (this.events.listenerCount('change') > 0) this.events.emit('change', this.snapshot());
    }, this.recentActivityMs + 1);
    this.activityExpiryTimer.unref?.();
  }

  clearActivityExpiry() {
    if (!this.activityExpiryTimer) return;
    clearTimeout(this.activityExpiryTimer);
    this.activityExpiryTimer = null;
  }
}

function emptyMetrics() {
  return {
    requestsReceived: 0,
    requestsSucceeded: 0,
    requestsFailed: 0,
    requestRecoveries: 0,
    discoveryRequests: 0,
    toolListRequests: 0,
    toolManifestChanges: 0
  };
}

function safeId(value) {
  const text = String(value || '');
  return text ? crypto.createHash('sha256').update(text).digest('base64url').slice(0, 12) : '';
}

function normalizeAuthMode(value) {
  const mode = String(value || '');
  return isMcpAuthMode(mode) ? mode : '';
}

function safeClientCapabilities(value) {
  const extensions = value?.extensions && typeof value.extensions === 'object'
    ? Object.fromEntries(Object.keys(value.extensions).sort().map(key => [String(key).slice(0, 160), {}]))
    : {};
  return { extensions };
}

function safeClientInfo(value) {
  return {
    name: String(value?.name || '').slice(0, 120),
    version: String(value?.version || '').slice(0, 80)
  };
}

function redactFields(value) {
  const result = {};
  for (const [key, field] of Object.entries(value || {})) {
    if (/token|authorization|secret|password/i.test(key)) continue;
    if (field !== undefined) result[key] = field;
  }
  return result;
}

function iso(value) {
  const number = Number(value || 0);
  return number > 0 ? new Date(number).toISOString() : null;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

const mcpConnectionManager = new McpConnectionManager();

export {   McpConnectionManager,  mcpConnectionManager,   };
