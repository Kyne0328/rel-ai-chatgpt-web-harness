import { MCP_CONTENT_TYPES } from '../contracts/mcp.ts';

const DEFAULT_MAX_TOOL_RESULT_BYTES = 512 * 1024;
const DEFAULT_MAX_TOOL_TEXT_BYTES = 8 * 1024;
const MAX_TOOL_RESULT_BYTES = Number(
  process.env.REL_AI_MCP_MAX_TOOL_RESULT_BYTES
  || process.env.REL_AI_MCP_MAX_TOOL_RESULT_CHARS
  || DEFAULT_MAX_TOOL_RESULT_BYTES
);
const MAX_TOOL_TEXT_BYTES = Number(process.env.REL_AI_MCP_MAX_TOOL_TEXT_BYTES || DEFAULT_MAX_TOOL_TEXT_BYTES);

function toolResult(payload, isError, meta) {
  const { imageContents, structuredPayload } = extractToolImages(payload);
  const resourceLinkContent = toolResourceLinkContent(payload);
  const serialized = JSON.stringify(structuredPayload);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  const structuredContent = bytes > MAX_TOOL_RESULT_BYTES
    ? compactToolResult(structuredPayload, bytes)
    : structuredPayload;
  const text = conciseToolResultText(structuredPayload, {
    isError: Boolean(isError),
    originalBytes: bytes,
    structuredTruncated: bytes > MAX_TOOL_RESULT_BYTES
  });
  return {
    content: [
      { type: MCP_CONTENT_TYPES.TEXT, text: truncateUtf8Head(text, MAX_TOOL_TEXT_BYTES) },
      ...imageContents,
      ...(resourceLinkContent ? [resourceLinkContent] : [])
    ],
    structuredContent,
    isError: Boolean(isError),
    ...(meta && typeof meta === 'object' ? { _meta: meta } : {})
  };
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
      lines.push(`Structured result compacted from ${Number(options.originalBytes || 0)} bytes. Re-call with narrower limits for complete bounded data.`);
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
    lines.push(`Structured result compacted from ${Number(options.originalBytes || 0)} bytes. Re-call with narrower limits for complete bounded data.`);
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
    workspace: payload.workspace || null,
    work_id: payload.work_id || null,
    processId: payload.processId,
    status: payload.status,
    duplicate: payload.duplicate,
    mode: payload.mode,
    check: payload.check,
    exitCode: payload.exitCode,
    durationMs: payload.durationMs,
    diagnosticCount: payload.diagnosticCount,
    validationStatus: payload.validationStatus,
    completionKnown: payload.completionKnown,
    message: displayText(payload.message, 2000) || 'Result was compacted. Re-call with narrower limits.',
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
    backgroundOperations: Array.isArray(payload.backgroundOperations) ? payload.backgroundOperations.map(compactOperationResult) : undefined,
    results: compactDiagnosticResults(payload.results),
    completedOperations: Array.isArray(payload.completedOperations) ? payload.completedOperations.slice(0, 5) : undefined
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value != null));
}

function compactOperationResult(operation) {
  if (!operation || typeof operation !== 'object') return undefined;
  const result = operation.result || {};
  return {
    operationId: operation.operationId,
    work_id: operation.work_id,
    workspace: operation.workspace,
    tool: operation.tool,
    status: operation.status,
    phase: operation.phase,
    revision: operation.revision,
    error: displayText(operation.error, 1000),
    result: {
      commandSucceeded: result.commandSucceeded,
      validationStatus: result.validationStatus,
      exitCode: result.exitCode,
      stdoutOutputRef: result.stdoutOutputRef,
      stderrOutputRef: result.stderrOutputRef,
      results: compactDiagnosticResults(result.results)
    }
  };
}

function compactDiagnosticResults(results) {
  if (!Array.isArray(results) || results.length === 0) return undefined;
  return results.slice(0, 5).map(item => Object.fromEntries(Object.entries({
    command: boundedText(item?.command, 1000),
    ok: item?.ok !== false,
    exitCode: item?.exitCode,
    timedOut: item?.timedOut === true,
    signal: item?.signal,
    stdout: tailText(item?.stdout, 2000),
    stderr: tailText(item?.stderr, 4000),
    stdoutOutputRef: item?.stdoutOutputRef,
    stderrOutputRef: item?.stderrOutputRef
  }).filter(([, value]) => value != null)));
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
