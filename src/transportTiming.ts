import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';

const phases = new Set([
  'http_entry', 'body_complete', 'runtime_dispatch', 'call_tool_entry',
  'call_tool_return', 'call_tool_error', 'response_finished', 'delivery_interrupted',
  'request_interrupted'
]);
interface TimingScope { transportId: string; started: number; }
const timing = new AsyncLocalStorage<TimingScope>();

// Local, opt-in diagnostics only. Never serialize caller-controlled fields,
// headers, URLs, arguments, results, credentials, or exception/abort messages.
function writeTiming(scope: TimingScope, phase: string): void {
  if (!phases.has(phase)) return;
  try {
    console.error('[rel-ai-mcp:transport-timing] ' + JSON.stringify({
      transportId: scope.transportId,
      phase,
      at: new Date().toISOString(),
      elapsedMs: Math.round(Math.max(0, performance.now() - scope.started) * 1000) / 1000
    }));
  } catch { /* Diagnostics must never change the operation result. */ }
}

export function recordTransportTiming(phase: string): void {
  const scope = timing.getStore();
  if (scope) writeTiming(scope, phase);
}

export function withHttpTransportTiming<T>(
  req: IncomingMessage,
  res: ServerResponse,
  callback: () => T
): T {
  if (process.env.REL_AI_MCP_TRANSPORT_TIMING !== '1'
    || req.method !== 'POST' || String(req.url || '').split('?', 1)[0] !== '/mcp') return callback();
  const scope = { transportId: randomUUID(), started: performance.now() };
  return timing.run(scope, () => {
    writeTiming(scope, 'http_entry');
    // Node finish means the response was handed to the socket, not that the
    // remote application received it. These callbacks capture the exact scope.
    res.once('finish', () => { writeTiming(scope, 'response_finished'); });
    res.once('close', () => { if (!res.writableFinished) writeTiming(scope, 'delivery_interrupted'); });
    req.once('aborted', () => { writeTiming(scope, 'request_interrupted'); });
    return callback();
  });
}
