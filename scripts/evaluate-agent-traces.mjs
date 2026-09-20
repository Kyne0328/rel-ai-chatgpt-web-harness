import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function evaluateAgentTraces(expectations, traces) {
  if (!Array.isArray(expectations) || !Array.isArray(traces)) throw new Error('Agent trace expectations and traces must be JSON arrays.');
  const byId = new Map(traces.map(trace => [String(trace?.id || '').trim(), normalizeTrace(trace)]));
  const failures = [];

  for (const raw of expectations) {
    const item = normalizeExpectation(raw);
    const trace = byId.get(item.id);
    if (!trace) {
      failures.push(failure(item.id, 'missing_trace', 'No independently recorded trace matched this scenario.'));
      continue;
    }
    for (const field of ['model', 'instructionVersion', 'toolSurfaceVersion']) {
      if (!trace.metadata[field]) failures.push(failure(item.id, 'missing_version', `Recorded trace is missing ${field}.`));
    }
    if (trace.completed !== true) failures.push(failure(item.id, 'incomplete', 'Recorded task did not complete successfully.'));
    if (item.maxCalls != null && trace.calls.length > item.maxCalls) {
      failures.push(failure(item.id, 'excessive_calls', `Observed ${trace.calls.length} calls; scenario limit is ${item.maxCalls}.`));
    }
    const duplicateCalls = consecutiveDuplicateCalls(trace.calls);
    if (item.maxDuplicateCalls != null && duplicateCalls > item.maxDuplicateCalls) {
      failures.push(failure(item.id, 'duplicate_calls', `Observed ${duplicateCalls} avoidable consecutive duplicate calls; scenario limit is ${item.maxDuplicateCalls}.`));
    }
    if (item.minPollIntervalMs != null) {
      const intervals = pollIntervals(trace.calls);
      if (intervals.some(value => value < item.minPollIntervalMs)) {
        failures.push(failure(item.id, 'poll_interval', `Observed polling faster than the ${item.minPollIntervalMs} ms scenario minimum.`));
      }
    }
    const totalResultBytes = trace.calls.reduce((sum, call) => sum + call.resultBytes, 0);
    if (item.maxResultBytes != null && totalResultBytes > item.maxResultBytes) {
      failures.push(failure(item.id, 'result_bytes', `Observed ${totalResultBytes} result bytes; scenario limit is ${item.maxResultBytes}.`));
    }
    if (item.maxLatencyMs != null && trace.durationMs > item.maxLatencyMs) {
      failures.push(failure(item.id, 'latency', `Observed ${trace.durationMs} ms latency; scenario limit is ${item.maxLatencyMs} ms.`));
    }
    const beginCalls = trace.calls.filter(call => call.tool === 'relai_work' && call.action === 'begin').length;
    if (item.taskMode === 'required' && beginCalls !== 1) failures.push(failure(item.id, 'task_setup', 'Scenario requires exactly one durable task begin.'));
    if (item.taskMode === 'forbidden' && beginCalls !== 0) failures.push(failure(item.id, 'task_setup', 'Scenario must not create a durable task.'));
    const usedTools = new Set(trace.calls.map(call => call.tool));
    for (const tool of item.requiredTools) if (!usedTools.has(tool)) failures.push(failure(item.id, 'missing_tool', `Recorded trace did not use required tool ${tool}.`));
    for (const tool of item.forbiddenTools) if (usedTools.has(tool)) failures.push(failure(item.id, 'forbidden_tool', `Recorded trace used forbidden tool ${tool}.`));
  }

  const failed = new Set(failures.map(item => item.id));
  return { ok: failures.length === 0, evaluated: expectations.length, passed: expectations.length - failed.size, failed: failed.size, failures };
}

function normalizeExpectation(raw) {
  const id = String(raw?.id || '').trim();
  if (!id) throw new Error('Agent trace expectation requires id.');
  const taskMode = String(raw.taskMode || 'optional').trim().toLowerCase();
  if (!['required', 'forbidden', 'optional'].includes(taskMode)) throw new Error(`Agent trace expectation ${id} has invalid taskMode.`);
  return {
    id,
    taskMode,
    requiredTools: stringArray(raw.requiredTools),
    forbiddenTools: stringArray(raw.forbiddenTools),
    maxCalls: optionalLimit(raw.maxCalls, `${id} maxCalls`),
    maxDuplicateCalls: optionalLimit(raw.maxDuplicateCalls, `${id} maxDuplicateCalls`),
    minPollIntervalMs: optionalLimit(raw.minPollIntervalMs, `${id} minPollIntervalMs`),
    maxResultBytes: optionalLimit(raw.maxResultBytes, `${id} maxResultBytes`),
    maxLatencyMs: optionalLimit(raw.maxLatencyMs, `${id} maxLatencyMs`)
  };
}

function normalizeTrace(raw) {
  const calls = Array.isArray(raw?.calls) ? raw.calls.map(call => ({
    tool: String(call?.tool || '').trim(),
    action: String(call?.action || '').trim(),
    signature: String(call?.signature || '').trim(),
    startedAtMs: Math.max(0, Number(call?.startedAtMs || 0)),
    resultBytes: Math.max(0, Number(call?.resultBytes || 0))
  })).filter(call => call.tool) : [];
  return {
    id: String(raw?.id || '').trim(),
    metadata: {
      model: String(raw?.metadata?.model || '').trim(),
      instructionVersion: String(raw?.metadata?.instructionVersion || '').trim(),
      toolSurfaceVersion: String(raw?.metadata?.toolSurfaceVersion || '').trim()
    },
    completed: raw?.completed === true,
    durationMs: Math.max(0, Number(raw?.durationMs || 0)),
    calls
  };
}

function consecutiveDuplicateCalls(calls) {
  let duplicates = 0;
  for (let index = 1; index < calls.length; index += 1) {
    if (isPoll(calls[index])) continue;
    if (callSignature(calls[index]) === callSignature(calls[index - 1])) duplicates += 1;
  }
  return duplicates;
}

function pollIntervals(calls) {
  const polls = calls.filter(isPoll).map(call => call.startedAtMs).filter(value => value > 0);
  return polls.slice(1).map((value, index) => value - polls[index]);
}

function isPoll(call) {
  return call.tool === 'relai_work' && call.action === 'status';
}

function callSignature(call) {
  return call.signature || `${call.tool}\0${call.action}`;
}

function optionalLimit(value, label) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number.`);
  return number;
}

function stringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function failure(id, kind, message) { return { id, kind, message }; }
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const expectationFile = process.argv[2];
  const traceFile = process.argv[3];
  if (!expectationFile || !traceFile) {
    console.error('Usage: node scripts/evaluate-agent-traces.mjs <scenario-bounds.json> <recorded-agent-traces.json>');
    process.exitCode = 2;
  } else {
    const report = evaluateAgentTraces(readJson(expectationFile), readJson(traceFile));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

export { evaluateAgentTraces };
