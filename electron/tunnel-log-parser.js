const MAX_BUFFER_CHARS = 256 * 1024;
const MAX_MESSAGE_CHARS = 1200;
const MAX_DETAIL_CHARS = 800;
const DEBUG_MESSAGES = new Set([
  'provided',
  'run',
  'invoking',
  'onstart hook executing',
  'onstart hook executed'
]);

function createTunnelLogParser({ onEntry = () => {}, defaultLevel = 'info', now = () => new Date().toISOString() } = {}) {
  if (typeof onEntry !== 'function') throw new TypeError('onEntry is required.');
  let buffer = '';

  function write(chunk) {
    buffer += String(chunk ?? '');
    if (buffer.length > MAX_BUFFER_CHARS) {
      const overflow = buffer.slice(0, buffer.length - MAX_BUFFER_CHARS);
      buffer = buffer.slice(-MAX_BUFFER_CHARS);
      emit(overflow);
    }
    drain(false);
  }

  function flush() {
    drain(true);
  }

  function drain(final) {
    let cursor = 0;
    while (cursor < buffer.length) {
      while (cursor < buffer.length && /\s/.test(buffer[cursor])) cursor += 1;
      if (cursor >= buffer.length) break;
      if (buffer[cursor] === '{') {
        const end = jsonObjectEnd(buffer, cursor);
        if (end < 0) break;
        emit(buffer.slice(cursor, end));
        cursor = end;
        continue;
      }
      const newline = buffer.indexOf('\n', cursor);
      const nextJson = buffer.indexOf('{', cursor);
      const end = newline >= 0 && (nextJson < 0 || newline < nextJson)
        ? newline + 1
        : nextJson >= 0
          ? nextJson
          : final
            ? buffer.length
            : -1;
      if (end < 0) break;
      emit(buffer.slice(cursor, end));
      cursor = end;
    }
    buffer = buffer.slice(cursor);
    if (final && buffer.trim()) {
      emit(buffer);
      buffer = '';
    }
  }

  function emit(record) {
    const entry = normalizeTunnelLogRecord(record, { defaultLevel, now });
    if (entry) onEntry(entry);
  }

  return Object.freeze({ write, flush });
}

function jsonObjectEnd(text, start) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function normalizeTunnelLogRecord(record, { defaultLevel = 'info', now = () => new Date().toISOString() } = {}) {
  const raw = String(record || '').trim();
  if (!raw) return null;
  let value = null;
  if (raw.startsWith('{')) {
    try { value = JSON.parse(raw); } catch {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ts: now(),
      level: normalizeTunnelLevel(defaultLevel),
      source: 'openai-tunnel',
      component: '',
      code: '',
      message: sanitizeTunnelText(raw, MAX_MESSAGE_CHARS),
      details: {}
    };
  }

  const message = sanitizeTunnelText(value.msg ?? value.message ?? '', MAX_MESSAGE_CHARS);
  const component = sanitizeTunnelField(value.component, 80);
  const error = sanitizeTunnelText(value.error, MAX_DETAIL_CHARS);
  const statusCode = numericStatus(value.status_code ?? value.statusCode);
  const failureSource = sanitizeTunnelField(value.failure_source, 80);
  const transportErrorKind = sanitizeTunnelField(value.transport_error_kind, 80);
  const upstreamResponseReceived = typeof value.upstream_response_received === 'boolean'
    ? value.upstream_response_received : undefined;
  const classification = classifyTunnelEvent({ message, component, error, statusCode, failureSource, transportErrorKind, upstreamResponseReceived });
  const details = compactTunnelDetails({
    httpStatus: statusCode || undefined,
    retryInMs: finiteTunnelNumber(value.retry_in_ms ?? value.retryInMs),
    timeoutMs: durationMilliseconds(value.timeout),
    lastError: error || undefined,
    tunnelId: value.tunnel_id,
    clientInstanceId: value.client_instance_id,
    tunnelRequestId: value.tunnel_request_id,
    method: value.rpc_method ?? value.method,
    failureSource: failureSource || undefined,
    transportErrorKind: transportErrorKind || undefined,
    upstreamResponseReceived,
    upstreamStatus: numericStatus(value.upstream_status) || undefined,
    tunnelClientVersion: value.tunnel_client_version,
    target: value.target,
    channel: value.channel,
    transport: value.transport
  });

  return {
    ts: normalizeTunnelTimestamp(value.time ?? value.ts, now),
    level: classification.level || normalizeTunnelLevel(value.level || defaultLevel),
    source: 'openai-tunnel',
    component,
    code: classification.code,
    message: classification.message || message || error || 'OpenAI tunnel event.',
    details
  };
}

function classifyTunnelEvent({ message, component, error, statusCode, failureSource, transportErrorKind, upstreamResponseReceived }) {
  const combined = `${message} ${error}`.toLowerCase();
  if (component === 'dispatcher' && statusCode >= 400 && /mcp upstream error|upstream error|posted error response/.test(combined)) {
    const cause = [failureSource, transportErrorKind].filter(Boolean).join(': ');
    return {
      level: 'warning',
      code: statusCode >= 500 ? 'tunnel_upstream_5xx' : 'tunnel_mcp_request_failed',
      message: failureSource === 'target_http' || upstreamResponseReceived === true
        ? `The local MCP server returned HTTP ${statusCode}.`
        : upstreamResponseReceived === false
          ? `The tunnel could not complete the local MCP request (HTTP ${statusCode}${cause ? `; ${cause}` : ''}).`
          : `The MCP request failed with HTTP ${statusCode}; upstream cause is unavailable.`
    };
  }
  if (statusCode === 401 || /\b401\b|unauthori[sz]ed|invalid api key/.test(combined)) {
    return { level: 'error', code: 'tunnel_authentication_failed', message: 'OpenAI rejected the tunnel runtime API key.' };
  }
  if (statusCode === 403 || /\b403\b|forbidden|access denied|permission denied/.test(combined)) {
    return { level: 'error', code: 'tunnel_access_denied', message: 'OpenAI denied this runtime key access to the tunnel.' };
  }
  if (statusCode === 404 && (component === 'controlplane' || /tunnel/.test(combined))) {
    return { level: 'error', code: 'tunnel_not_found', message: 'OpenAI could not find the configured Secure MCP Tunnel.' };
  }
  if (/command response deadline reached|dropping without posting a response/.test(combined)) {
    return { level: 'warning', code: 'tunnel_response_deadline', message: 'Tunnel response deadline expired before the MCP response could be delivered.' };
  }
  if (statusCode >= 500 && /mcp upstream error|upstream error|posted error response/.test(combined)) {
    return { level: 'warning', code: 'tunnel_upstream_5xx', message: `The tunnel received an upstream HTTP ${statusCode} response from the MCP path.` };
  }
  if (/poll failed|poll timed out|poll transport failed|unexpected eof|\bgoaway\b|context deadline exceeded|i\/o timeout|dns|no such host|connection reset|connection refused|network is unreachable/.test(combined)) {
    return { level: 'warning', code: 'tunnel_connection_interrupted', message: 'Tunnel polling was interrupted. Retrying automatically.' };
  }
  if (DEBUG_MESSAGES.has(message.toLowerCase())) return { level: 'debug', code: '', message };
  return { level: '', code: '', message };
}

function compactTunnelDetails(value) {
  const details = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) details[key] = raw;
      continue;
    }
    if (typeof raw === 'boolean') {
      details[key] = raw;
      continue;
    }
    const sanitized = sanitizeTunnelText(raw, MAX_DETAIL_CHARS);
    if (sanitized) details[key] = sanitized;
  }
  return details;
}

function sanitizeTunnelText(value, limit = MAX_DETAIL_CHARS) {
  const redacted = String(value == null ? '' : value)
    .replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
    .replace(/([?&](?:token|bootstrap|code|client_secret|api_key)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:token|secret|password|authorization|api[_-]?key|authtoken|client[_-]?secret)["']?\s*[:=]\s*)["']?[^\s,;"']+["']?/gi, '$1[redacted]');
  return Array.from(redacted)
    .filter(character => {
      const code = character.codePointAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('')
    .slice(0, Math.max(1, limit))
    .trim();
}

function sanitizeTunnelField(value, limit) {
  return sanitizeTunnelText(value, limit).replace(/\s+/g, ' ').trim();
}

function normalizeTunnelLevel(value) {
  const level = String(value || '').toLowerCase();
  if (level === 'error' || level === 'fatal') return 'error';
  if (level === 'warn' || level === 'warning') return 'warning';
  if (level === 'debug' || level === 'trace') return 'debug';
  return 'info';
}

function normalizeTunnelTimestamp(value, now) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : now();
}

function numericStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}

function finiteTunnelNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function durationMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value || '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m)$/i);
  if (!match) return undefined;
  const number = Number(match[1]);
  const factors = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000 };
  return Math.round(number * factors[match[2].toLowerCase()]);
}

export { createTunnelLogParser, normalizeTunnelLogRecord };
