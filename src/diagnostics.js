

import { ERROR_CODES, errorGuidance, normalizeErrorCode } from "./desktopUxContracts.js";

const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|authtoken|client[_-]?secret|bootstrap/i;
const SECRET_TEXT_REPLACEMENTS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{0,50000}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, '[redacted-private-key]'],
  [/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]'],
  [/([?&](?:token|bootstrap|code|client_secret)=)[^&#\s]+/gi, '$1[redacted]'],
  [/(["']?(?:token|secret|password|authorization|api[_-]?key|authtoken|client[_-]?secret)["']?\s*:\s*)["'][^"']*["']/gi, '$1"[redacted]"'],
  [/\b(token|secret|password|authorization|api[_-]?key|authtoken|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]'],
  [/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH_CODE|CLIENT_SECRET)[A-Z0-9_]*)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, '$1=[redacted]']
];

function sanitizeText(value, maxLength = 4000) {
  let text = String(value == null ? '' : value);
  for (const [pattern, replacement] of SECRET_TEXT_REPLACEMENTS) text = text.replace(pattern, replacement);
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}\n[diagnostic text truncated]`;
  return text;
}

function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 8) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeDiagnosticValue(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? sanitizeText(value) : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeDiagnosticValue(item, depth + 1);
  }
  return out;
}

function buildDiagnosticReport(input = {}) {
  const workspace = String(input.workspace || '');
  const runtime = normalizeRuntimeLogs(input.runtimeLogs);
  const findings = [
    ...healthFindings(input.health, workspace),
    ...connectionFindings(input.connection, input.connectionState),
    ...cautionFindings(input.cautionData, workspace),
    ...auditPersistenceFindings(input.auditLogs),
    ...taskHistoryPersistenceFindings(input.taskHistoryPersistence),
    ...runtimeLogPersistenceFindings(runtime)
  ];
  const ordered = dedupeFindings(findings).sort(compareDiagnosticFindings);
  const failedActivity = normalizeFailedActivity(input.auditLogs);
  const application = {
    version: sanitizeText(input.application?.version || '', 120).trim(),
    build: sanitizeText(input.application?.build || '', 120).trim()
  };
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    scope: workspace ? { workspace } : { workspace: '' },
    application,
    summary: countFindings(ordered),
    findings: ordered,
    tunnelHealth: normalizeTunnelHealth(input.tunnelHealth),
    resourceDiagnostics: normalizeResourceDiagnostics(input.resourceDiagnostics),
    logs: { runtime, failedActivity }
  };
  report.reportText = formatDiagnosticReport(report);
  return report;
}

function normalizeResourceDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const select = (item, keys) => Object.fromEntries(keys.filter(key => item != null && Object.hasOwn(item, key)).map(key => [key, item[key]]));
  const memoryKeys = ['sampledAtMs', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes', 'heapLimitBytes'];
  const host = value.host || {};
  const pressure = select(host.pressure, [
    'state', 'reason', 'physicalTotalBytes', 'physicalAvailableBytes', 'physicalAvailableKind',
    'commitUsedBytes', 'commitLimitBytes', 'commitAvailableBytes', 'commitEnforced',
    'source', 'error', 'sampledAtMs', 'ageMs', 'stale', 'sampling', 'reservedBytes',
    'activeReservations', 'reservationBytes', 'physicalFloorBytes', 'physicalRecoveryBytes',
    'commitFloorBytes', 'commitRecoveryBytes', 'recoveryCount',
    'pagesInputPerSecond', 'pageReadsPerSecond', 'pagingMeaning',
    'settlingReservedBytes', 'settlingReservationCount', 'startupSettlingMs', 'oldestSettlingMs', 'settlingReason'
  ]);
  pressure.recentDecisions = (Array.isArray(host.pressure?.recentDecisions) ? host.pressure.recentDecisions : [])
    .slice(-20).map(item => select(item, ['atMs', 'state', 'reason']));
  const lanes = Object.fromEntries(Object.entries(host.lanes || {}).slice(0, 10)
    .map(([name, lane]) => [name, select(lane, ['limit', 'active', 'queued', 'queuedOwners'])]));
  const queues = Object.fromEntries(Object.entries(host.queues || {}).slice(0, 10)
    .map(([name, queue]) => [name, select(queue, ['oldestWaitMs', 'blockedReason', 'maxQueued', 'maxQueuedPerOwner'])]));
  const node = select(value.node, ['available', 'scope', 'pid', 'source', 'sampledAtMs', 'ageMs', 'stale', 'error', 'interpretation']);
  node.current = value.node?.current ? select(value.node.current, memoryKeys) : null;
  node.sampling = select(value.node?.sampling, ['intervalMs', 'maxSamples', 'mode', 'retainedSamples']);
  node.samples = (Array.isArray(value.node?.samples) ? value.node.samples : []).slice(-60).map(item => select(item, memoryKeys));
  node.trend = select(value.node?.trend, ['status', 'sampleCount', 'baselineAtMs', 'latestAtMs', 'durationMs', 'method']);
  node.trend.baseline = select(value.node?.trend?.baseline, memoryKeys);
  node.trend.deltaBytes = select(value.node?.trend?.deltaBytes, memoryKeys);
  node.trend.slopeBytesPerMinute = select(value.node?.trend?.slopeBytesPerMinute, memoryKeys);
  const managedRoots = select(value.managedRoots, ['scope', 'platform', 'sampledAt', 'cacheAgeMs', 'totalRootCount', 'omittedRootCount', 'descendantAttribution', 'stale', 'cached', 'sampledRootCount', 'error', 'reason']);
  managedRoots.roots = (Array.isArray(value.managedRoots?.roots) ? value.managedRoots.roots : []).slice(0, 20).map(item => {
    const root = select(item, ['processId', 'pid', 'label', 'kind', 'workspace', 'workSessionId', 'lifecycle', 'status', 'privateBytes', 'workingSetBytes', 'sampledAt', 'identityVerified', 'measurementStatus', 'reason']);
    root.label = sanitizeText(root.label || '', 120);
    const stale = managedRoots.stale === true || (typeof managedRoots.cacheAgeMs === 'number' && managedRoots.cacheAgeMs >= 5_000);
    if (root.identityVerified !== true || root.measurementStatus !== 'measured' || stale) {
      if (stale) { root.measurementStatus = 'unknown'; root.reason = 'Cached root sample is stale; refresh for current identity verification.'; }
      root.privateBytes = null;
      root.workingSetBytes = null;
    }
    return root;
  });
  return sanitizeDiagnosticValue({
    host: { lanes, pressure, queues },
    node,
    children: select(value.children, ['measured', 'source', 'reason']),
    caches: { fileReads: select(value.caches?.fileReads, ['entries', 'metadataEntries', 'retainedBytes', 'maxRetainedBytes', 'evictions']) },
    managedRoots
  });
}

function normalizeTunnelHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sanitized = sanitizeDiagnosticValue(value);
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : null;
}

function healthFindings(health, workspace) {
  return (health?.findings || [])
    .filter(finding => !workspace || !finding.workspace || finding.workspace === workspace)
    .map(finding => {
      const code = normalizeHealthCode(finding.code);
      const alias = String(finding.workspace || '');
      return diagnosticFinding({
        severity: normalizedSeverity(finding.severity),
        code,
        title: humanize(finding.code || errorGuidance(code).title),
        impact: alias ? `Workspace ${alias} may be unavailable or unreliable.` : 'The local bridge may not operate as expected.',
        recommendation: recommendationForHealth(finding, code),
        action: alias
          ? { label: 'Review workspace', href: `#workspaces?workspace=${encodeURIComponent(alias)}` }
          : actionFromGuidance(code),
        details: finding
      });
    });
}

function connectionFindings(connection, state) {
  const findings = [];
  const endpointStatus = String(state?.publicEndpoint?.status || '');
  const tunnelConfigured = Boolean(String(connection?.tunnelId || '').trim());
  if (endpointStatus === 'unavailable' || endpointStatus === 'disabled' || (!endpointStatus && !tunnelConfigured)) {
    findings.push(findingFromCode(
      ERROR_CODES.PUBLIC_ENDPOINT_FAILED,
      'warning',
      'The local dashboard works, but the OpenAI Secure MCP Tunnel is not available for ChatGPT requests.',
      { ...connection, endpointStatus }
    ));
  }
  if (connection?.token !== 'set') {
    findings.push(findingFromCode(
      ERROR_CODES.CONFIGURATION_INVALID,
      'error',
      'The private local MCP bearer credential is missing.',
      connection
    ));
  }
  const connectionError = state?.error;
  if (connectionError?.message) {
    const severity = connectionError.code === ERROR_CODES.TUNNEL_CONNECTION_INTERRUPTED ? 'warning' : 'error';
    findings.push(findingFromCode(connectionError.code, severity, connectionError.message, connectionError));
  }
  return findings;
}

function cautionFindings(cautionData, workspace) {
  return (cautionData?.workspaces || [])
    .filter(item => Number(item.count || 0) > 0)
    .filter(item => !workspace || item.alias === workspace)
    .map(item => {
      const alias = item.alias === '__unknown__' ? '' : item.alias;
      const count = Number(item.count || 0);
      return diagnosticFinding({
        severity: 'info',
        code: 'protected_configuration_changes',
        title: `Protected configuration ${count === 1 ? 'change' : 'changes'}${alias ? ` in ${alias}` : ''}`,
        impact: `${count} recorded in the last ${cautionData.windowHours || 24} hours.`,
        recommendation: 'Open Activity and confirm the recorded changes were expected.',
        action: { label: 'Open Activity', href: alias ? `#activity?workspace=${encodeURIComponent(alias)}&time=24h` : '#activity?time=24h' },
        context: item.recent || [],
        details: item
      });
    });
}

function auditPersistenceFindings(auditLogs = {}) {
  const persistence = auditLogs?.persistence || {};
  const activeFailure = Boolean(String(persistence.lastError || '').trim());
  const droppedEntries = Math.max(0, Number(persistence.droppedEntries || 0));
  if (!activeFailure && droppedEntries === 0) return [];
  const pending = Math.max(0, Number(persistence.pending || 0));
  const impact = activeFailure
    ? `Rel.AI cannot currently save activity history to disk. ${pending ? `${pending} recent ${pending === 1 ? 'entry is' : 'entries are'} being kept in memory while saving is retried.` : 'Saving will be retried automatically.'}`
    : `${droppedEntries} older ${droppedEntries === 1 ? 'activity entry was' : 'activity entries were'} not saved during an earlier storage failure.`;
  return [diagnosticFinding({
    severity: 'warning',
    code: 'local_history_persistence_failed',
    title: activeFailure ? 'Activity history is not being saved' : 'Some activity history was not saved',
    impact,
    recommendation: 'Check available disk space and write permissions for the Rel.AI local data folder. If saving does not recover, restart Rel.AI and review Troubleshooting again.',
    action: { label: 'Review troubleshooting', href: '#diagnostics' },
    details: persistence
  })];
}

function taskHistoryPersistenceFindings(persistence = {}) {
  if (persistence.healthy !== false) return [];
  const pending = Math.max(0, Number(persistence.pending || 0));
  return [diagnosticFinding({
    severity: 'warning',
    code: 'task_history_persistence_failed',
    title: 'Task history is not being saved',
    impact: `Rel.AI cannot currently save task details to disk.${pending ? ` ${pending} ${pending === 1 ? 'task update remains' : 'task updates remain'} queued in memory while saving is retried.` : ''}`,
    recommendation: 'Check available disk space and write permissions for the Rel.AI local data folder. Rel.AI retries with bounded backoff and keeps the current in-memory task state available.',
    action: { label: 'Review troubleshooting', href: '#diagnostics' },
    details: persistence
  })];
}

function runtimeLogPersistenceFindings(runtime = {}) {
  const persistence = runtime.persistence || {};
  if (runtime.persistent !== true || persistence.healthy !== false) return [];
  return [diagnosticFinding({
    severity: 'warning',
    code: 'runtime_log_persistence_failed',
    title: 'App log is not being saved',
    impact: 'Troubleshooting messages remain available in memory for this app session, but recent app-log detail could be lost after restart.',
    recommendation: 'Check available disk space and write permissions for the Rel.AI local data folder. Rel.AI will resume saving automatically when the storage problem is resolved.',
    action: { label: 'Review troubleshooting', href: '#diagnostics' },
    details: persistence
  })];
}

function findingFromCode(code, severity, impact, details) {
  const normalized = normalizeErrorCode(code) || ERROR_CODES.UNKNOWN;
  const guidance = errorGuidance(normalized);
  return diagnosticFinding({
    severity,
    code: normalized,
    title: guidance.title,
    impact,
    recommendation: guidance.recovery,
    action: actionFromGuidance(normalized),
    details
  });
}

function diagnosticFinding(value) {
  return {
    id: findingId(value),
    severity: normalizedSeverity(value.severity),
    code: String(value.code || ERROR_CODES.UNKNOWN),
    title: sanitizeText(value.title || 'Diagnostic finding', 240),
    impact: sanitizeText(value.impact || '', 1000),
    recommendation: sanitizeText(value.recommendation || '', 1000),
    action: value.action || { label: 'Open Diagnostics', href: '#diagnostics' },
    context: sanitizeDiagnosticValue(value.context || []),
    details: sanitizeDiagnosticValue(value.details || {})
  };
}

function normalizeRuntimeLogs(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : [];
  const ordered = [...entries].sort(compareChronological).slice(-100);
  return {
    available: value?.available === true,
    persistent: value?.persistent === true,
    persistence: {
      healthy: value?.persistence?.healthy !== false,
      failureCount: Math.max(0, Number(value?.persistence?.failureCount || 0)),
      lastFailureAt: value?.persistence?.lastFailureAt || null,
      lastError: sanitizeText(value?.persistence?.lastError || '', 500)
    },
    revision: Number.isFinite(Number(value?.revision)) ? Math.max(0, Number(value.revision)) : 0,
    count: Number(value?.count ?? entries.length),
    entries: ordered.map(entry => ({
      ts: entry.ts || null,
      lastTs: entry.lastTs || null,
      level: ['error', 'warning', 'info', 'debug'].includes(entry.level) ? entry.level : 'info',
      source: sanitizeText(entry.source || 'desktop', 80),
      component: sanitizeText(entry.component || '', 100),
      code: sanitizeText(entry.code || '', 120),
      message: sanitizeText(entry.message || '', 2000),
      details: sanitizeDiagnosticValue(entry.details || {}),
      repeatCount: Math.max(0, Math.floor(Number(entry.repeatCount || 0))),
      taskId: sanitizeText(entry.taskId || '', 160),
      eventId: sanitizeText(entry.eventId || '', 160),
      workspace: sanitizeText(entry.workspace || '', 120),
      tool: sanitizeText(entry.tool || '', 120),
      operation: sanitizeText(entry.operation || '', 240)
    }))
  };
}

function normalizeFailedActivity(value) {
  const entries = Array.isArray(value?.entries) ? value.entries : Array.isArray(value) ? value : [];
  return entries
    .filter(entry => entry?.ok === false || entry?.error)
    .sort(compareChronological)
    .slice(-20)
    .map(entry => sanitizeDiagnosticValue({
      ts: entry.ts || entry.at || entry.createdAt || null,
      eventId: entry.eventId || entry.operationId || entry.id || '',
      taskId: entry.taskId || entry.sessionId || '',
      tool: entry.tool || entry.type || 'activity',
      workspace: entry.workspace || '',
      errorCode: sanitizeText(entry.errorCode || '', 120),
      error: entry.error || entry.message || 'Failed activity'
    }));
}

function logContext(entry = {}, fields = []) {
  const labels = { code: 'code', errorCode: 'code', workspace: 'workspace', taskId: 'task', eventId: 'event', tool: 'tool', operation: 'operation' };
  const context = fields
    .map(field => entry[field] ? `${labels[field] || field}=${entry[field]}` : '')
    .filter(Boolean);
  return context.length ? ` [${context.join(' ')}]` : '';
}

function formatDiagnosticReport(report) {
  const lines = [
    'Rel.AI MCP diagnostic report',
    `Generated: ${report.generatedAt}`,
    `Scope: ${report.scope.workspace || 'all workspaces'}`
  ];
  if (report.application?.version) lines.push(`Version: ${report.application.version}`);
  if (report.application?.build) lines.push(`Build: ${report.application.build}`);
  if (report.tunnelHealth) {
    lines.push('Secure tunnel health:');
    for (const [name, component] of [['control-plane', report.tunnelHealth.controlPlane], ['response-delivery', report.tunnelHealth.responseDelivery]]) {
      if (!component) continue;
      lines.push(`  ${name}: ${component.status || 'unknown'} / ${component.state || 'unknown'}${component.reasonCode ? ` (${component.reasonCode})` : ''}`);
    }
  }
  if (report.resourceDiagnostics) {
    const { host = {}, node = {}, children = {} } = report.resourceDiagnostics;
    const pressure = host?.pressure || {};
    lines.push('', 'Host resources (cached admission snapshot):',
      `  Pressure: ${pressure.state || 'unknown'}; reason: ${pressure.reason || 'unavailable'}; stale: ${pressure.stale !== false}`,
      `  Physical available bytes: ${diagnosticNumber(pressure.physicalAvailableBytes)}; total bytes: ${diagnosticNumber(pressure.physicalTotalBytes)}`,
      `  Commit used / limit / available bytes: ${diagnosticNumber(pressure.commitUsedBytes)} / ${diagnosticNumber(pressure.commitLimitBytes)} / ${diagnosticNumber(pressure.commitAvailableBytes)}; enforced: ${pressure.commitEnforced === true}`,
      `  Reserved bytes: ${diagnosticNumber(pressure.reservedBytes)}; source: ${pressure.source || 'unknown'}; sampled at: ${diagnosticNumber(pressure.sampledAtMs)}; age ms: ${diagnosticNumber(pressure.ageMs)}`);
    lines.push(`  Startup settling: ${diagnosticNumber(pressure.settlingReservedBytes)} reserved bytes, ${diagnosticNumber(pressure.settlingReservationCount)} reservations; oldest / minimum window ms: ${diagnosticNumber(pressure.oldestSettlingMs)} / ${diagnosticNumber(pressure.startupSettlingMs)}; ${pressure.settlingReason || 'no settling reason reported'}`);
    lines.push(`  Pages in / disk reads per second: ${diagnosticRate(pressure.pagesInputPerSecond)} / ${diagnosticRate(pressure.pageReadsPerSecond)}; ${pressure.pagingMeaning || 'Paging rates unavailable; a sampled rate does not establish sustained memory thrashing.'}`);
    for (const [name, lane] of Object.entries(host?.lanes || {}).slice(0, 10)) {
      const queue = host?.queues?.[name] || {};
      lines.push(`  ${name}: active ${diagnosticNumber(lane.active)} / limit ${diagnosticNumber(lane.limit)}, queued ${diagnosticNumber(lane.queued)}, oldest wait ms ${diagnosticNumber(queue.oldestWaitMs)}; ${queue.blockedReason || 'no queued blocker'}`);
    }
    const managed = report.resourceDiagnostics.managedRoots || {};
    lines.push(`  Managed roots: ${managed.roots?.length || 0} shown / ${diagnosticNumber(managed.totalRootCount)} in authorized scope; cache age ms: ${diagnosticNumber(managed.cacheAgeMs)}; detached descendants: ${managed.descendantAttribution || 'unknown'}`);
    for (const root of managed.roots || []) {
      lines.push(`    ${root.label || root.processId || 'Managed process'}: PID ${diagnosticNumber(root.pid)}, ${root.status || 'unknown'}, lifecycle ${root.lifecycle || 'unknown'}; private bytes ${diagnosticNumber(root.privateBytes)}, working set bytes ${diagnosticNumber(root.workingSetBytes)}; sampled ${root.sampledAt || 'unknown'}; ${root.measurementStatus || 'unknown'}`);
    }
    const cache = report.resourceDiagnostics.caches?.fileReads || {};
    lines.push(`  File-read cache: ${diagnosticNumber(cache.retainedBytes)} / ${diagnosticNumber(cache.maxRetainedBytes)} UTF-8 content bytes; entries ${diagnosticNumber(cache.entries)}; metadata ${diagnosticNumber(cache.metadataEntries)}; evictions ${diagnosticNumber(cache.evictions)} (not JS heap overhead)`);
    const current = node?.current || {};
    lines.push('Current Node process memory (separate from host pressure):',
      `  RSS / heap used / heap total / external / ArrayBuffers bytes: ${diagnosticNumber(current.rssBytes)} / ${diagnosticNumber(current.heapUsedBytes)} / ${diagnosticNumber(current.heapTotalBytes)} / ${diagnosticNumber(current.externalBytes)} / ${diagnosticNumber(current.arrayBuffersBytes)}`,
      `  Measurement status: ${node?.available === true ? 'available' : 'unavailable'}; sampled at: ${diagnosticNumber(node?.sampledAtMs)}; age ms: ${diagnosticNumber(node?.ageMs)}`,
      `  Retained samples: ${diagnosticNumber(node?.trend?.sampleCount)}; window ms: ${diagnosticNumber(node?.trend?.durationMs)}; trend: ${node?.trend?.status || 'unavailable'}`);
    if (node?.trend?.status === 'observed') {
      lines.push(`  Observed first-to-last change bytes/minute: RSS ${diagnosticNumber(node.trend.slopeBytesPerMinute?.rssBytes)}, heap ${diagnosticNumber(node.trend.slopeBytesPerMinute?.heapUsedBytes)}, external ${diagnosticNumber(node.trend.slopeBytesPerMinute?.externalBytes)}`);
    }
    lines.push(`  ${node?.interpretation || 'These values do not measure the full Rel.AI process family or establish a memory leak.'}`,
      `  Children: ${children?.reason || 'Memory not measured.'}`);
  }
  lines.push(`Findings: ${report.summary.blocking} blocking, ${report.summary.warnings} warnings, ${report.summary.recommendations} recommendations`);
  for (const finding of report.findings) {
    lines.push('', `[${finding.severity.toUpperCase()}] ${finding.code}`, finding.title, `Impact: ${finding.impact}`, `Action: ${finding.recommendation}`);
  }
  if (report.logs.runtime.entries.length) {
    lines.push('', 'Recent service logs:');
    for (const entry of report.logs.runtime.entries.slice(-20)) {
      const context = logContext(entry, ['code', 'workspace', 'taskId', 'eventId', 'tool', 'operation']);
      lines.push(`${entry.ts || ''} ${entry.level.toUpperCase()} ${entry.source}${context}: ${entry.message}`.trim());
    }
  }
  if (report.logs.failedActivity.length) {
    lines.push('', 'Recent failed activity:');
    for (const entry of report.logs.failedActivity) {
      const context = logContext(entry, ['errorCode', 'workspace', 'taskId', 'eventId']);
      lines.push(`${entry.ts || ''} ${entry.tool || 'activity'}${context}: ${entry.error}`.trim());
    }
  }
  return sanitizeText(lines.join('\n'), 30000);
}

function diagnosticRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toFixed(1) : 'unknown';
}

function diagnosticNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : 'unknown';
}

function dedupeFindings(findings) {
  const byId = new Map();
  for (const finding of findings) if (!byId.has(finding.id)) byId.set(finding.id, finding);
  return [...byId.values()];
}

function countFindings(findings) {
  const summary = { blocking: 0, warnings: 0, recommendations: 0, total: findings.length };
  for (const finding of findings) {
    if (finding.severity === 'error') summary.blocking += 1;
    else if (finding.severity === 'warning') summary.warnings += 1;
    else summary.recommendations += 1;
  }
  return summary;
}

function findingId(value) {
  const details = value.details || {};
  return [value.code || 'finding', details.workspace || details.alias || '', details.path || ''].join(':');
}

function normalizeHealthCode(value) {
  if (value === 'workspace_unavailable') return ERROR_CODES.WORKSPACE_UNAVAILABLE;
  return ERROR_CODES.CONFIGURATION_INVALID;
}

function recommendationForHealth(finding, code) {
  if (finding.code === 'workspace_unavailable') return errorGuidance(ERROR_CODES.WORKSPACE_UNAVAILABLE).recovery;
  if (String(finding.code || '').includes('stateDir')) return 'Confirm that the Rel.AI state directory exists and is writable.';
  return sanitizeText(finding.message || errorGuidance(code).recovery, 1000);
}

function actionFromGuidance(code) {
  const guidance = errorGuidance(code);
  if ([ERROR_CODES.SECURE_TUNNEL_FAILED, ERROR_CODES.PUBLIC_ENDPOINT_FAILED, ERROR_CODES.TUNNEL_CONNECTION_INTERRUPTED].includes(code)) {
    return { kind: 'restart_connection', label: 'Retry now', href: guidance.href || '#settings/connection' };
  }
  return { label: guidance.actionLabel, href: guidance.href || '#diagnostics' };
}

function normalizedSeverity(value) {
  if (value === 'error') return 'error';
  if (value === 'warning') return 'warning';
  return 'info';
}

function severityRank(value) {
  if (value === 'error') return 0;
  if (value === 'warning') return 1;
  return 2;
}

function compareDiagnosticFindings(left, right) {
  return severityRank(left?.severity) - severityRank(right?.severity)
    || findingWorkspace(left).localeCompare(findingWorkspace(right), 'en-US', { numeric: true, sensitivity: 'base' })
    || String(left?.code || '').localeCompare(String(right?.code || ''), 'en-US', { numeric: true, sensitivity: 'base' })
    || String(left?.title || '').localeCompare(String(right?.title || ''), 'en-US', { numeric: true, sensitivity: 'base' });
}

function findingWorkspace(finding) {
  return String(finding?.details?.workspace || finding?.details?.alias || '');
}

function compareChronological(left, right) {
  const timestampDifference = diagnosticTimestamp(left) - diagnosticTimestamp(right);
  if (timestampDifference) return timestampDifference;
  return String(left?.source || left?.tool || left?.type || '').localeCompare(String(right?.source || right?.tool || right?.type || ''), 'en-US', { numeric: true, sensitivity: 'base' });
}

function diagnosticTimestamp(entry) {
  const timestamp = Date.parse(entry?.ts || entry?.at || entry?.createdAt || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function humanize(value) {
  const text = String(value || '').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export { sanitizeText, sanitizeDiagnosticValue, buildDiagnosticReport,  };
