import { boundResponsePayload, jsonBytes, responseByteLimit, utf8Head } from '../tools/responseBudget.js';
import { MCP_CONTENT_TYPES } from '../contracts/mcp.ts';

const DEFAULT_MAX_TOOL_RESULT_BYTES = 512 * 1024;
const DEFAULT_MAX_TOOL_TEXT_BYTES = 8 * 1024;
const MAX_TOOL_RESULT_BYTES = Number(
  process.env.REL_AI_MCP_MAX_TOOL_RESULT_BYTES
  || process.env.REL_AI_MCP_MAX_TOOL_RESULT_CHARS
  || DEFAULT_MAX_TOOL_RESULT_BYTES
);
const MAX_TOOL_TEXT_BYTES = Number(process.env.REL_AI_MCP_MAX_TOOL_TEXT_BYTES || DEFAULT_MAX_TOOL_TEXT_BYTES);

function toolResult(payload, isError, meta, options = {}) {
  const { imageContents, structuredPayload } = extractToolImages(payload);
  const resourceLinkContent = toolResourceLinkContent(payload);
  const serialized = JSON.stringify(structuredPayload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const withoutTimeline = structuredPayload?.timeline || structuredPayload?.errorDetails?.timeline
    ? { ...structuredPayload, timeline: undefined, ...(structuredPayload.errorDetails ? { errorDetails: { ...structuredPayload.errorDetails, timeline: undefined } } : {}), truncated: true, originalBytes: bytes } : null;
  const structuredContent = bytes > MAX_TOOL_RESULT_BYTES
    ? (withoutTimeline && jsonBytes(withoutTimeline) <= MAX_TOOL_RESULT_BYTES ? withoutTimeline : compactToolResult(structuredPayload, bytes))
    : structuredPayload;
  const text = conciseToolResultText(structuredPayload, {
    isError: Boolean(isError),
    originalBytes: bytes,
    structuredTruncated: bytes > MAX_TOOL_RESULT_BYTES
  });
  const result = {
    content: [
      { type: MCP_CONTENT_TYPES.TEXT, text: truncateUtf8Head(text, MAX_TOOL_TEXT_BYTES) },
      ...imageContents,
      ...(resourceLinkContent ? [resourceLinkContent] : [])
    ],
    structuredContent,
    isError: Boolean(isError),
    ...(meta && typeof meta === 'object' ? { _meta: meta } : {})
  };
  if (options.maxResponseBytes != null) {
    const limit = responseByteLimit(options.maxResponseBytes);
    result.structuredContent = { ...result.structuredContent, responseBudget: { maxResponseBytes: limit, returnedBytes: 0, complete: result.structuredContent?.truncated !== true } };
    if (jsonBytes(result) > limit - 512) {
      result.structuredContent = { ...boundResponsePayload(result.structuredContent, limit - 1024), truncated: true };
      result.content = [{ type: MCP_CONTENT_TYPES.TEXT, text: utf8Head(conciseToolResultText(result.structuredContent, { isError }), 256) }];
    }
    result.structuredContent.responseBudget = { maxResponseBytes: limit, returnedBytes: 0, complete: result.structuredContent?.truncated !== true };
    for (let pass = 0; pass < 3; pass += 1) result.structuredContent.responseBudget.returnedBytes = jsonBytes(result);
  }
  return result;
}

function extractToolImages(payload) {
  const imageContents = [];
  const seen = new WeakSet();

  function visit(value) {
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map(visit);

    const entries = [];
    for (const [key, child] of Object.entries(value)) {
      if (key === 'image') {
        const imageContent = imageContentOf(child);
        if (imageContent) {
          imageContents.push(imageContent);
          entries.push([key, stripImageData(child)]);
          continue;
        }
      }
      entries.push([key, visit(child)]);
    }
    return Object.fromEntries(entries);
  }

  return { imageContents, structuredPayload: visit(payload) };
}

function imageContentOf(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
  const data = typeof image.data === 'string' ? image.data : '';
  const mimeType = typeof image.mimeType === 'string' ? image.mimeType : '';
  if (!data || !/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)) return null;
  return { type: MCP_CONTENT_TYPES.IMAGE, data, mimeType };
}

function stripImageData(image) {
  return Object.fromEntries(Object.entries(image).filter(([key]) => key !== 'data'));
}

function toolResourceLinkContent(payload) {
  const link = payload?.resourceLink;
  if (!link || typeof link !== 'object' || Array.isArray(link)) return null;
  const uri = typeof link.uri === 'string' ? link.uri : '';
  const name = typeof link.name === 'string' ? link.name : '';
  if (!uri || !name) return null;
  return {
    type: MCP_CONTENT_TYPES.RESOURCE_LINK,
    uri,
    name,
    ...(typeof link.description === 'string' && link.description ? { description: link.description } : {}),
    ...(typeof link.mimeType === 'string' && link.mimeType ? { mimeType: link.mimeType } : {}),
    ...(Number.isSafeInteger(link.size) && link.size >= 0 ? { size: link.size } : {})
  };
}

function conciseToolResultText(payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return boundedText(String(payload ?? ''), MAX_TOOL_TEXT_BYTES) || 'Rel.AI returned no structured result.';
  }
  const success = payload.ok !== false && options.isError !== true;
  if (success) {
    const lines = ['Rel.AI operation succeeded.'];
    appendCompletionNotices(lines, payload.completedOperations);
    appendSuccessSummary(lines, payload);
    if (options.structuredTruncated) {
      lines.push(`Structured result compacted from ${Number(options.originalBytes || 0)} bytes. Use returned output references or narrower read-only requests for more detail.`);
    }
    return lines.join('\n');
  }
  const lines = ['Rel.AI operation failed.'];
  appendCompletionNotices(lines, payload.completedOperations);
  appendField(lines, 'Workspace', scalarText(payload.workspace));
  appendField(lines, 'Work session', scalarText(payload.work_id));
  appendField(lines, 'Process', scalarText(payload.processId));
  appendField(lines, 'Status', scalarText(payload.status || payload.validationStatus));
  appendField(lines, 'Summary', displayText(payload.summary, 1800));
  appendField(lines, 'Message', displayText(payload.message, 1800));
  appendField(lines, 'Error', displayText(payload.error, 2400));
  appendField(lines, 'Next action', displayText(payload.nextAction, 1600));
  appendField(lines, 'Stdout tail', tailText(payload.stdout, 1000));
  appendField(lines, 'Stderr tail', tailText(payload.stderr, 1600));
  if (options.structuredTruncated) {
    lines.push(`Structured result compacted from ${Number(options.originalBytes || 0)} bytes. Use returned output references or narrower read-only requests for more detail.`);
  }
  return lines.join('\n');
}

function appendCompletionNotices(lines, notices) {
  if (!Array.isArray(notices) || notices.length === 0) return;
  for (const notice of notices.slice(0, 5)) {
    const summary = displayText(notice?.summary, 500);
    if (summary) lines.push(`Background completion: ${summary}`);
  }
}

function appendSuccessSummary(lines, payload) {
  appendField(lines, 'Workspace', scalarText(payload.workspace));
  appendField(lines, 'Work session', scalarText(payload.work_id));
  appendField(lines, 'Process', scalarText(payload.processId));
  appendField(lines, 'Status', scalarText(payload.status || payload.validationStatus));
  appendField(lines, 'Summary', displayText(payload.summary, 1000));
  appendField(lines, 'Message', displayText(payload.message, 1000));
  const operations = payload.backgroundOperations || (payload.backgroundOperation ? [payload.backgroundOperation] : []);
  for (const operation of operations.slice(0, 10)) {
    const result = operation.result || {};
    const outcome = result.commandSucceeded === false || result.validationStatus === 'failed'
      ? 'failed'
      : operation.status === 'running' ? operation.phase || 'running' : operation.status;
    const exit = result.exitCode != null ? `; exit code ${result.exitCode}` : '';
    lines.push(`Operation ${scalarText(operation.operationId)}: ${scalarText(outcome)}${exit}`);
    if (result.stdoutOutputRef) lines.push(`Stdout reference: ${scalarText(result.stdoutOutputRef)}`);
    if (result.stderrOutputRef) lines.push(`Stderr reference: ${scalarText(result.stderrOutputRef)}`);
  }
  if (payload.exitCode != null) appendField(lines, 'Exit code', scalarText(payload.exitCode));
  appendField(lines, 'Stdout tail', tailText(payload.stdout, 1600));
  appendField(lines, 'Stderr tail', tailText(payload.stderr, 1200));

  if (Array.isArray(payload.items)) {
    for (const item of payload.items.slice(0, 2)) {
      const path = scalarText(item?.path || item?.name || item?.type);
      const content = displayText(item?.content, 1200);
      if (content) lines.push(`${path ? `Read ${path}` : 'Read result'}: ${content}`);
    }
  }

  const matches = collectSearchPreview(payload).slice(0, 5);
  for (const match of matches) {
    const path = scalarText(match?.path);
    const line = Number.isFinite(Number(match?.line)) ? `:${Number(match.line)}` : '';
    const preview = displayText(match?.text || match?.content || match?.snippet || match?.name, 500);
    if (path && preview) lines.push(`Match ${path}${line}: ${preview}`);
    else if (path) lines.push(`Match: ${path}${line}`);
  }
  if (Array.isArray(payload.changedFiles) && payload.changedFiles.length) {
    lines.push(`Changed files: ${payload.changedFiles.slice(0, 8).map(String).join(', ')}${payload.changedFiles.length > 8 ? ', …' : ''}`);
  }
  appendField(lines, 'Next action', displayText(payload.nextAction, 1000));
}

function collectSearchPreview(payload) {
  const direct = Array.isArray(payload?.matches) ? payload.matches : [];
  const ranked = Array.isArray(payload?.results)
    ? payload.results.flatMap(result => {
        if (Array.isArray(result?.matches)) return result.matches;
        if (Array.isArray(result?.results)) return result.results;
        return result?.path ? [result] : [];
      })
    : [];
  return [...direct, ...ranked].filter(item => item && typeof item === 'object' && item.path);
}

function appendField(lines, label, value) {
  if (value) lines.push(`${label}: ${value}`);
}

function scalarText(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return String(value.alias || value.path || value.id || value.name || '').trim() || undefined;
  }
  return undefined;
}

function displayText(value, maxChars) {
  if (typeof value === 'string') return boundedText(value, maxChars);
  if (value == null) return undefined;
  try {
    return boundedText(JSON.stringify(value), maxChars);
  } catch {
    return undefined;
  }
}

function truncateUtf8Head(text, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_TOOL_TEXT_BYTES;
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.length <= limit) return String(text);
  const marker = '\n[rel-ai-mcp text summary truncated]';
  const allowed = Math.max(0, limit - Buffer.byteLength(marker, 'utf8'));
  return `${buffer.subarray(0, allowed).toString('utf8').replace(/\uFFFD+$/u, '')}${marker}`;
}

function compactToolResult(payload, originalBytes) {
  if (!payload || typeof payload !== 'object') return { ok: false, truncated: true, originalBytes };
  const compact = {
    ok: payload.ok !== false,
    truncated: true,
    originalBytes,
    workspace: boundedText(scalarText(payload.workspace), 512),
    work_id: payload.work_id || null,
    processId: payload.processId,
    status: payload.status,
    duplicate: payload.duplicate,
    mode: payload.mode,
    check: payload.check,
    exitCode: payload.exitCode,
    executed: payload.executed,
    commandSucceeded: payload.commandSucceeded,
    timedOut: payload.timedOut,
    cancelled: payload.cancelled,
    rootExitConfirmed: payload.rootExitConfirmed,
    terminationConfirmed: payload.terminationConfirmed,
    forcedTermination: payload.forcedTermination,
    mutationUnknown: payload.mutationUnknown,
    cleanupPending: payload.cleanupPending,
    queueTimedOut: payload.queueTimedOut,
    stdoutBytes: payload.stdoutBytes,
    stderrBytes: payload.stderrBytes,
    stdoutTruncated: typeof payload.stdout === 'string' && payload.stdout.length > 2000 ? true : payload.stdoutTruncated,
    stderrTruncated: typeof payload.stderr === 'string' && payload.stderr.length > 4000 ? true : payload.stderrTruncated,
    stdoutSpillTruncated: payload.stdoutSpillTruncated,
    stderrSpillTruncated: payload.stderrSpillTruncated,
    durationMs: payload.durationMs,
    timeline: payload.timeline ? { phase: payload.timeline.phase, executed: payload.timeline.executed, terminationCertainty: payload.timeline.terminationCertainty, lastProgressAt: payload.timeline.lastProgressAt } : undefined,
    items: Array.isArray(payload.items) && payload.items.length === 0 ? [] : undefined,
    skipped: Array.isArray(payload.skipped) ? payload.skipped.slice(0, 2).map(item => ({ path: boundedText(item.path, 200), reason: boundedText(item.reason, 240) })) : undefined,
    errorDetails: payload.errorDetails ? { ...payload.errorDetails, timeline: undefined } : undefined,
    outputFinalizationTimedOut: payload.outputFinalizationTimedOut,
    outputFinalizationError: payload.outputFinalizationError,
    mutationOwnershipPersistenceError: payload.mutationOwnershipPersistenceError,
    diagnosticCount: payload.diagnosticCount,
    validationStatus: payload.validationStatus,
    completionKnown: payload.completionKnown,
    operationOk: payload.operationOk,
    handlerCompleted: payload.handlerCompleted,
    retryable: payload.retryable,
    operationError: displayText(payload.operationError, 2000),
    message: displayText(payload.message, 2000) || (payload.operationId ? 'Result was compacted. Retrieve the same operationId with relai_work action result or read its output references. Do not rerun the mutation.' : 'Result was compacted. Use returned output references or narrower read-only requests for more detail.'),
    error: displayText(payload.error, 4000),
    errorCode: payload.errorCode,
    level: payload.level,
    summary: displayText(payload.summary, 2000),
    nextAction: displayText(payload.nextAction, 2000),
    stdout: tailText(payload.stdout, 2000),
    stderr: tailText(payload.stderr, 4000),
    operationId: payload.operationId,
    stdoutOutputRef: payload.stdoutOutputRef,
    stderrOutputRef: payload.stderrOutputRef,
    backgroundOperation: compactOperationResult(payload.backgroundOperation),
    backgroundOperations: Array.isArray(payload.backgroundOperations) ? [] : undefined,
    results: compactDiagnosticResults(payload.results),
    completedOperations: Array.isArray(payload.completedOperations) ? payload.completedOperations.slice(0, 5).map(notice => ({
      operationId: boundedText(scalarText(notice?.operationId), 256),
      work_id: boundedText(scalarText(notice?.work_id), 256),
      status: boundedText(scalarText(notice?.status), 128),
      summary: displayText(notice?.summary, 1000)
    })) : undefined
  };
  const bounded = Object.fromEntries(Object.entries(compact).filter(([, value]) => value != null));
  // Identity/status fields are scalars, never a second copy of workspace config
  // or an arbitrary nested payload. Keep the fixed envelope bounded as well.
  for (const [key, value] of Object.entries(bounded)) {
    if (['backgroundOperation', 'backgroundOperations', 'results', 'completedOperations', 'timeline', 'items', 'skipped', 'errorDetails'].includes(key)) continue;
    if (value && typeof value === 'object') bounded[key] = boundedText(scalarText(value), 512);
    else if (typeof value === 'string' && !['message', 'error', 'summary', 'nextAction', 'stdout', 'stderr'].includes(key)) {
      bounded[key] = boundedText(value, 512);
    }
  }
  const diagnostics = Array.isArray(payload.results) ? payload.results : [];
  if (diagnostics.length > (bounded.results?.length || 0)) bounded.omittedDiagnosticCount = diagnostics.length - (bounded.results?.length || 0);
  const operations = Array.isArray(payload.backgroundOperations) ? payload.backgroundOperations : [];
  const ordered = operations.map((operation, index) => ({ operation, index })).sort((left, right) =>
    operationPriority(left.operation, payload.operationId) - operationPriority(right.operation, payload.operationId)
    || operationTime(right.operation) - operationTime(left.operation)
    || right.index - left.index
  );
  bounded.omittedOperationCount = operations.length;
  bounded.omittedUnsafeOperationCount = operations.filter(operationNeedsAttention).length;
  // Reserve space for omission metadata. At most twenty detailed candidates
  // are considered so repeated JSON sizing stays bounded even for huge history.
  const budget = Math.max(0, MAX_TOOL_RESULT_BYTES - Math.min(512, Math.ceil(MAX_TOOL_RESULT_BYTES / 32)));
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget) {
    delete bounded.timeline;
    if (!payload.message) delete bounded.message;
  }
  if (ordered.length && Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget - 128 * 1024) {
    if (bounded.backgroundOperation?.result?.results) bounded.backgroundOperation.result.results = bounded.backgroundOperation.result.results.map(withoutDiagnosticOutput);
    if (bounded.results) bounded.results = bounded.results.map(withoutDiagnosticOutput);
  }
  if (ordered.length && Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget - 128 * 1024) {
    omitDiagnosticDetails(bounded);
    omitDiagnosticDetails(bounded.backgroundOperation?.result);
  }
  for (const { operation } of ordered.slice(0, 20)) {
    const candidate = compactOperationResult(operation);
    if (candidate?.operationId && candidate.operationId === bounded.backgroundOperation?.operationId && candidate.result.results) {
      // The explicit detail already contains this operation's diagnostic text.
      // Retain its list identity, safety facts and references without duplicating output.
      candidate.result.results = candidate.result.results.map(withoutDiagnosticOutput);
    }
    bounded.backgroundOperations.push(candidate);
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget) {
      candidate.result.results = candidate.result.results?.map(withoutDiagnosticOutput);
    }
    if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget) {
      bounded.backgroundOperations.pop();
      continue;
    }
    bounded.omittedOperationCount -= 1;
    if (operationNeedsAttention(operation)) bounded.omittedUnsafeOperationCount -= 1;
  }
  // An explicitly requested single operation is always retained. If its nested
  // diagnostic text dominates the envelope, keep its safety facts and refs.
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget) {
    if (bounded.backgroundOperation?.result?.results) bounded.backgroundOperation.result.results = bounded.backgroundOperation.result.results.map(withoutDiagnosticOutput);
    if (bounded.results) bounded.results = bounded.results.map(withoutDiagnosticOutput);
  }
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget) {
    omitDiagnosticDetails(bounded);
    omitDiagnosticDetails(bounded.backgroundOperation?.result);
    for (const operation of bounded.backgroundOperations || []) omitDiagnosticDetails(operation.result);
  }
  while (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > budget && bounded.backgroundOperations?.length) {
    const omitted = bounded.backgroundOperations.pop();
    bounded.omittedOperationCount += 1;
    if (operationNeedsAttention(omitted)) bounded.omittedUnsafeOperationCount += 1;
  }
  if (!bounded.omittedOperationCount) delete bounded.omittedOperationCount;
  if (!bounded.omittedUnsafeOperationCount) delete bounded.omittedUnsafeOperationCount;
  return fitStructuredResult(bounded, MAX_TOOL_RESULT_BYTES);
}

function fitStructuredResult(value, maxBytes) {
  if (jsonBytes(value) <= maxBytes) return value;
  const result = JSON.parse(JSON.stringify(value));
  delete result.timeline;
  if (result.errorDetails) delete result.errorDetails.timeline;
  // Preserve operation identities, references and safety facts. Shrink prose
  // first, including escaped strings whose JSON size exceeds their UTF-8 size.
  const identities = /^(operationId|work_id|processId|eventId|workspace|.*OutputRef|errorCode|code)$/;
  while (jsonBytes(result) > maxBytes) {
    const candidates = [];
    const visit = object => {
      if (!object || typeof object !== 'object') return;
      for (const [key, item] of Object.entries(object)) {
        if (typeof item === 'string' && item.length > 80 && !identities.test(key)) candidates.push({ object, key, item, bytes: jsonBytes(item) });
        else if (item && typeof item === 'object') visit(item);
      }
    };
    visit(result);
    candidates.sort((left, right) => right.bytes - left.bytes);
    const next = candidates[0];
    if (!next) break;
    next.object[next.key] = utf8Head(next.item, Math.max(40, Math.floor(Buffer.byteLength(next.item, 'utf8') / 2)));
  }
  for (const field of ['completedOperations', 'backgroundOperations', 'results', 'skipped']) {
    while (jsonBytes(result) > maxBytes && result[field]?.length > 1) {
      result[field].pop();
      if (field === 'results') result.omittedDiagnosticCount = (result.omittedDiagnosticCount || 0) + 1;
    }
  }
  for (const field of ['message', 'summary', 'stdout', 'stderr', 'nextAction', 'errorDetails', 'skipped']) {
    if (jsonBytes(result) <= maxBytes) break;
    delete result[field];
  }
  if (jsonBytes(result) <= maxBytes) return result;
  // Final bounded receipt for pathological metadata: no execution success or
  // termination certainty is invented when optional detail must be omitted.
  const keys = ['ok', 'truncated', 'originalBytes', 'operationId', 'work_id', 'errorCode', 'executed', 'commandSucceeded', 'exitCode', 'timedOut', 'cancelled', 'rootExitConfirmed', 'terminationConfirmed', 'mutationUnknown', 'cleanupPending', 'stdoutOutputRef', 'stderrOutputRef'];
  const receipt = Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
  if (result.results?.[0]) {
    const first = Object.fromEntries(keys.filter(key => result.results[0][key] !== undefined).map(key => [key, result.results[0][key]]));
    receipt.results = [first];
    receipt.omittedDiagnosticCount = Math.max(0, (result.results.length - 1) + (result.omittedDiagnosticCount || 0));
  }
  if (jsonBytes(receipt) > maxBytes) {
    // Oversized identities cannot be truncated into different valid identities.
    // Keep explicit safety facts, and report unavailable details instead.
    for (const field of ['work_id', 'stdoutOutputRef', 'stderrOutputRef']) {
      if (jsonBytes(receipt) <= maxBytes) break;
      delete receipt[field];
    }
  }
  if (jsonBytes(receipt) > maxBytes) {
    for (const field of ['operationId', 'errorCode', 'originalBytes', 'results']) {
      if (jsonBytes(receipt) <= maxBytes) break;
      delete receipt[field];
    }
  }
  return jsonBytes(receipt) <= maxBytes ? receipt : { ok: false, truncated: true };
}

function operationNeedsAttention(operation) {
  const result = operation?.result || operation || {};
  return result.terminationConfirmed === false || result.cleanupPending === true
    || (Array.isArray(result.results) && result.results.some(item => item?.terminationConfirmed === false || item?.cleanupPending === true));
}

function operationPriority(operation, target) {
  if (target && operation?.operationId === target) return 0;
  if (operationNeedsAttention(operation)) return 1;
  if (operation?.status === 'running') return 2;
  if (operation?.status === 'failed' || operation?.status === 'cancelled' || operation?.result?.commandSucceeded === false || operation?.result?.validationStatus === 'failed') return 3;
  return 4;
}

function operationTime(operation) {
  const value = Date.parse(operation?.updatedAt || operation?.completedAt || operation?.startedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function withoutDiagnosticOutput(item) {
  return {
    ...item,
    ...(item.stdout ? { stdout: undefined, stdoutTruncated: true } : {}),
    ...(item.stderr ? { stderr: undefined, stderrTruncated: true } : {})
  };
}

function compactOperationResult(operation) {
  if (!operation || typeof operation !== 'object') return undefined;
  const result = operation.result || {};
  return {
    operationId: boundedText(scalarText(operation.operationId), 512),
    work_id: boundedText(scalarText(operation.work_id), 512),
    workspace: boundedText(scalarText(operation.workspace), 512),
    tool: boundedText(scalarText(operation.tool), 512),
    status: boundedText(scalarText(operation.status), 512),
    phase: boundedText(scalarText(operation.phase), 512),
    revision: boundedScalar(operation.revision),
    error: displayText(operation.error, 1000),
    result: boundedResultScalars({
      commandSucceeded: result.commandSucceeded,
      outputFinalizationTimedOut: result.outputFinalizationTimedOut,
      outputFinalizationError: result.outputFinalizationError,
      operationOk: result.operationOk,
      handlerCompleted: result.handlerCompleted,
      retryable: result.retryable,
      errorCode: result.errorCode,
      validationStatus: result.validationStatus,
      exitCode: result.exitCode,
      executed: result.executed,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      rootExitConfirmed: result.rootExitConfirmed,
      mutationOwnershipPersistenceError: result.mutationOwnershipPersistenceError,
      terminationConfirmed: result.terminationConfirmed,
      forcedTermination: result.forcedTermination,
      mutationUnknown: result.mutationUnknown,
      cleanupPending: result.cleanupPending,
      queueTimedOut: result.queueTimedOut,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutSpillTruncated: result.stdoutSpillTruncated,
      stderrSpillTruncated: result.stderrSpillTruncated,
      stdoutOutputRef: result.stdoutOutputRef,
      stderrOutputRef: result.stderrOutputRef,
      results: compactDiagnosticResults(result.results),
      ...(Array.isArray(result.results) && result.results.length > 5 ? { omittedDiagnosticCount: result.results.length - 5 } : {})
    })
  };
}

function compactDiagnosticResults(results) {
  if (!Array.isArray(results) || results.length === 0) return undefined;
  // A configured small frame must retain diagnostic status and a useful tail.
  // Scale text first so a single failure is not discarded for its output alone.
  const commandChars = Math.min(1000, Math.floor(MAX_TOOL_RESULT_BYTES / 16));
  const stdoutChars = Math.min(2000, Math.floor(MAX_TOOL_RESULT_BYTES / 16));
  const stderrChars = Math.min(4000, Math.floor(MAX_TOOL_RESULT_BYTES / 8));
  return results.map((item, index) => ({ item, index })).sort((left, right) =>
    Number(!operationNeedsAttention(left.item)) - Number(!operationNeedsAttention(right.item))
    || Number(left.item?.ok !== false) - Number(right.item?.ok !== false)
    || left.index - right.index
  ).slice(0, 5).map(({ item }) => boundedResultScalars(Object.fromEntries(Object.entries({
    command: boundedText(item?.command, commandChars),
    ok: item?.ok !== false,
    exitCode: item?.exitCode,
    executed: item?.executed,
    commandSucceeded: item?.commandSucceeded,
    timedOut: item?.timedOut,
    cancelled: item?.cancelled,
    rootExitConfirmed: item?.rootExitConfirmed,
    mutationOwnershipPersistenceError: item?.mutationOwnershipPersistenceError,
    outputFinalizationTimedOut: item?.outputFinalizationTimedOut,
    outputFinalizationError: item?.outputFinalizationError,
    terminationConfirmed: item?.terminationConfirmed,
    forcedTermination: item?.forcedTermination,
    mutationUnknown: item?.mutationUnknown,
    cleanupPending: item?.cleanupPending,
    queueTimedOut: item?.queueTimedOut,
    stdoutBytes: item?.stdoutBytes,
    stderrBytes: item?.stderrBytes,
    stdoutTruncated: typeof item?.stdout === 'string' && item.stdout.length > stdoutChars ? true : item?.stdoutTruncated,
    stderrTruncated: typeof item?.stderr === 'string' && item.stderr.length > stderrChars ? true : item?.stderrTruncated,
    stdoutSpillTruncated: item?.stdoutSpillTruncated,
    stderrSpillTruncated: item?.stderrSpillTruncated,
    signal: item?.signal,
    stdout: tailText(item?.stdout, stdoutChars),
    stderr: tailText(item?.stderr, stderrChars),
    stdoutOutputRef: item?.stdoutOutputRef,
    stderrOutputRef: item?.stderrOutputRef
  }).filter(([, value]) => value != null))));
}

function boundedScalar(value) {
  if (typeof value === 'string') return boundedText(value, 512);
  if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  return undefined;
}

function boundedResultScalars(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'results' || ['command', 'stdout', 'stderr'].includes(key) ? item : boundedScalar(item)
  ]).filter(([, item]) => item !== undefined));
}

function omitDiagnosticDetails(value) {
  if (!Array.isArray(value?.results) || !value.results.length) return;
  value.omittedDiagnosticCount = (value.omittedDiagnosticCount || 0) + value.results.length;
  const unsafe = value.results.filter(operationNeedsAttention).length;
  if (unsafe) value.omittedUnsafeDiagnosticCount = (value.omittedUnsafeDiagnosticCount || 0) + unsafe;
  value.results = [];
}

function boundedText(value, maxChars) {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}

function tailText(value, maxChars) {
  if (typeof value !== 'string' || !value) return undefined;
  return value.length <= maxChars ? value : `[kept last ${maxChars} chars]\n${value.slice(-maxChars)}`;
}

export {  toolResult };
