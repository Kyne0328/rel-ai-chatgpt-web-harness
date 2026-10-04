function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateJsonRpcRequestEnvelope(message) {
  if (!isPlainObject(message)) {
    return envelopeError(-32600, 'One JSON-RPC request object is required; batches are not supported.');
  }
  if (message.jsonrpc !== '2.0') {
    return envelopeError(-32600, 'A valid JSON-RPC 2.0 request is required.');
  }
  if (typeof message.method !== 'string' || !message.method.trim()) {
    return envelopeError(-32600, 'JSON-RPC method must be a non-empty string.');
  }
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && !validJsonRpcId(message.id)) {
    return envelopeError(-32600, 'JSON-RPC id must be a string or finite number when present.');
  }
  if (message.params !== undefined && !isPlainObject(message.params)) {
    return envelopeError(-32602, 'JSON-RPC params must be an object when present.');
  }
  return { ok: true, notification: !hasId, id: hasId ? message.id : undefined };
}

function validJsonRpcId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function envelopeError(code, error, data) {
  return { ok: false, code, error, id: null, ...(data === undefined ? {} : { data }) };
}

export { validateJsonRpcRequestEnvelope, validJsonRpcId };
