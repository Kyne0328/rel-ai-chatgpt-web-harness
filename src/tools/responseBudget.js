// UTF-8 JSON budgets are separate from repository and output-stream limits.
const DEFAULT_CONTROL_RESPONSE_BYTES = 16 * 1024;
const MIN_RESPONSE_BYTES = 2048;
function responseByteLimit(value, fallback = DEFAULT_CONTROL_RESPONSE_BYTES) {
  const number = Number(value);
  return Number.isFinite(number) && number >= MIN_RESPONSE_BYTES
    ? Math.min(512 * 1024, Math.floor(number)) : fallback;
}
function jsonBytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function utf8Head(value, bytes) {
  const buffer = Buffer.from(String(value || ''), 'utf8');
  return buffer.length <= bytes ? String(value || '') : buffer.subarray(0, Math.max(0, bytes)).toString('utf8').replace(/\uFFFD+$/u, '');
}
function smallReceipt(value) {
  if (!value || typeof value !== 'object') return value;
  const keys = ['operationId', 'work_id', 'eventId', 'workspace', 'status', 'tool', 'phase', 'startedAt', 'updatedAt', 'timestamp', 'revision', 'resultAvailable', 'resultTruncated', 'resultSource', 'cursor', 'executed', 'terminationConfirmed', 'mutationUnknown'];
  const result = { receiptTruncated: true };
  for (const key of keys) if (value[key] !== undefined) result[key] = typeof value[key] === 'string' && key !== 'cursor' ? utf8Head(value[key], 160) : value[key];
  if (value.resultRetention) result.resultRetention = { complete: value.resultRetention.complete, compacted: value.resultRetention.compacted };
  if (value.resultSummary) result.resultSummary = value.resultSummary;
  if (value.timeline) result.timeline = { phase: value.timeline.phase, executed: value.timeline.executed, terminationCertainty: value.timeline.terminationCertainty, lastProgressAt: value.timeline.lastProgressAt };
  return result;
}
function boundResponsePayload(value, maxBytes) {
  if (jsonBytes(value) <= maxBytes) return value;
  const result = { ...value, truncated: true, originalBytes: jsonBytes(value) };
  if (result.backgroundOperation?.result) {
    result.backgroundOperation = { ...result.backgroundOperation, result: undefined, resultTruncated: true };
    result.nextAction = result.backgroundOperation.resultSource === 'retained' && result.backgroundOperation.resultRetention?.complete === false
      ? 'Only a compacted retained result remains. Read output references or inspect artifacts read-only; a larger budget cannot restore omitted data. Do not rerun the mutation.'
      : 'Retrieve the same operationId with relai_work action result and a larger maxResponseBytes, or read its output references. Do not rerun the mutation.';
  }
  for (const field of ['backgroundOperations', 'tasks', 'entries']) {
    if (!Array.isArray(result[field])) continue;
    result[field] = result[field].map(item => jsonBytes(item) > maxBytes / 2 ? smallReceipt(item) : item);
    while (result[field].length > 1 && jsonBytes(result) > maxBytes) {
      result[field].pop();
      if (field === 'backgroundOperations') {
        result.operationCursor = result[field].at(-1)?.cursor;
        result.operationsHasMore = true;
      } else { result.cursor = result[field].at(-1)?.cursor; result.hasMore = true; }
    }
  }
  if (jsonBytes(result) <= maxBytes) return result;
  const compact = { ok: result.ok !== false, truncated: true, originalBytes: result.originalBytes };
  for (const key of ['work_id', 'operationId', 'kind', 'errorCode']) if (result[key] !== undefined) compact[key] = utf8Head(result[key], 160);
  const alias = typeof result.workspace === 'object' ? result.workspace?.alias : result.workspace;
  if (alias) compact.workspace = utf8Head(alias, 160);
  if (result.error) compact.error = utf8Head(result.error, 160);
  if (result.nextAction) compact.nextAction = utf8Head(result.nextAction, 320);
  if (result.timeline) compact.timeline = { phase: result.timeline.phase, executed: result.timeline.executed, terminationCertainty: result.timeline.terminationCertainty, lastProgressAt: result.timeline.lastProgressAt };
  if (result.backgroundOperation) compact.backgroundOperation = smallReceipt(result.backgroundOperation);
  for (const field of ['backgroundOperations', 'tasks', 'entries']) {
    if (!Array.isArray(result[field])) continue;
    const item = result[field][0] ? smallReceipt(result[field][0]) : null;
    const operationPage = field === 'backgroundOperations';
    const cursorKey = operationPage ? 'operationCursor' : 'cursor';
    const moreKey = operationPage ? 'operationsHasMore' : 'hasMore';
    compact[field] = item ? [item] : [];
    compact[cursorKey] = item?.cursor || null;
    compact[moreKey] = Boolean(item || result[moreKey]);
    if (jsonBytes(compact) > maxBytes) {
      // Never advance past an item that could not fit. Restarting may repeat
      // already-seen rows, but cannot silently skip an undelivered row.
      compact[field] = [];
      compact[cursorKey] = null;
      compact[moreKey] = true;
      compact.nextAction = 'Page cannot fit. Increase maxResponseBytes and restart without cursor.';
    }
  }
  if (jsonBytes(compact) > maxBytes && compact.backgroundOperation) {
    compact.operationId ||= compact.backgroundOperation.operationId;
    delete compact.backgroundOperation;
    compact.nextAction = 'Receipt cannot fit. Retrieve this operationId with larger maxResponseBytes; do not rerun the mutation.';
  }
  if (jsonBytes(compact) > maxBytes) {
    for (const field of ['backgroundOperations', 'tasks', 'entries']) {
      if (!Array.isArray(compact[field])) continue;
      compact[field] = [];
      compact[field === 'backgroundOperations' ? 'operationCursor' : 'cursor'] = null;
      compact[field === 'backgroundOperations' ? 'operationsHasMore' : 'hasMore'] = true;
    }
    compact.nextAction = 'Increase maxResponseBytes and restart without cursor; no omitted item was acknowledged.';
  }
  return compact;
}
export { responseByteLimit, jsonBytes, utf8Head, boundResponsePayload };
