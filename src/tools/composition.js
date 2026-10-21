import { Worker } from 'node:worker_threads';
import { randomUUID, createHash } from 'node:crypto';
import { combineAbortSignals } from '../abortSignals.js';
import { getToolSchemas } from './schema.js';
import { resolveToolOperation } from './actionCatalog.js';
import { serializeToolError } from './errors.js';
import { resolveWorkspace } from '../config.js';
import { principalFingerprint } from '../mcp/principal.ts';
import { outputSpillOwner, retainOutputStreams } from '../outputSpill.js';

export const COMPOSITION_LIMITS = Object.freeze({
  sourceBytes: 128 * 1024, memoryBytes: 64 * 1024 * 1024, cpuMs: 2000,
  wallMs: 120_000, calls: 64, concurrentCalls: 8, argumentBytes: 1024 * 1024,
  resultBytes: 8 * 1024 * 1024, totalResultBytes: 32 * 1024 * 1024,
  textBytes: 128 * 1024, outputBytes: 12 * 1024 * 1024, outputItems: 64, images: 4,
  activeRuns: 4, principalRuns: 2, settlementMs: 5000
});
const leases = new Map();
const WORK_ACTIONS = new Set(['context', 'status', 'result', 'history', 'plan']);
const RECEIPT_FIELDS = ['operationId', 'processId', 'stdoutOutputRef', 'stderrOutputRef', 'mutationEffect', 'mutationUnknown', 'executed', 'commandSucceeded', 'exitCode', 'timedOut', 'cancelled', 'rootExitConfirmed', 'terminationConfirmed', 'validationStatus', 'committed', 'completionKnown', 'handlerCompleted', 'operationOk'];

function failure(code, message) { return { ok: false, errorCode: code, error: message, retryable: false }; }
function bytes(value) { return Buffer.byteLength(value, 'utf8'); }
function imageKey(value) {
  if (!value || typeof value !== 'object' || typeof value.data !== 'string' || typeof value.mimeType !== 'string') return '';
  return createHash('sha256').update(value.mimeType).update('\0').update(value.data).digest('hex');
}
function visitImages(value, remember, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 30) return;
  if (value.image) { const key = imageKey(value.image); if (key) remember(key); }
  if (value.type === 'image') { const key = imageKey(value); if (key) remember(key); }
  for (const child of Object.values(value)) visitImages(child, remember, depth + 1);
}

// No new durable lifecycle: the outer call uses ordinary operation receipts; every
// child re-enters callTool and retains its existing authority and execution owner.
export async function composeTools(config, args = {}, context = {}) {
  if (typeof context.invokeTool !== 'function') return failure('COMPOSITION_DISPATCH_UNAVAILABLE', 'Composition requires the canonical tool dispatcher.');
  if (typeof args.code !== 'string' || !args.code.trim() || bytes(args.code) > COMPOSITION_LIMITS.sourceBytes) {
    return failure('COMPOSITION_SOURCE_LIMIT', 'Provide nonempty JavaScript within the source byte limit.');
  }
  const principal = principalFingerprint(context.principal);
  const total = [...leases.values()].reduce((sum, count) => sum + count, 0);
  if (total >= COMPOSITION_LIMITS.activeRuns || (leases.get(principal) || 0) >= COMPOSITION_LIMITS.principalRuns) {
    return failure('COMPOSITION_BUSY', 'Composition capacity is occupied by active scripts or unsettled child calls.');
  }
  const controller = new AbortController();
  const signal = combineAbortSignals(context.signal, controller.signal);
  const compositionId = `compose_${randomUUID()}`;
  const started = Date.now();
  const wallMs = Math.min(COMPOSITION_LIMITS.wallMs, Number(args.timeoutMs) || 60_000,
    context.deadlineAtMs ? Math.max(1, context.deadlineAtMs - started) : COMPOSITION_LIMITS.wallMs);
  const deadlineAtMs = started + wallMs;
  const outputs = [], calls = [], pending = new Set(), authorizedImages = new Set();
  let worker, ended = false, finishRun, resultBytes = 0, outputBytes = 0, textBytes = 0, images = 0, outputCount = 0;
  leases.set(principal, (leases.get(principal) || 0) + 1);
  const release = () => {
    const remaining = (leases.get(principal) || 1) - 1;
    if (remaining) leases.set(principal, remaining); else leases.delete(principal);
  };
  const done = new Promise(resolve => { finishRun = resolve; });
  const finish = (code = '', message = '') => {
    if (ended) return;
    ended = true;
    finishRun(code ? failure(code, message || code) : { ok: true });
    // A script exit cannot roll back dispatched actions. Request normal child
    // cancellation, retain their receipts, and keep capacity until they settle.
    if (code || pending.size) controller.abort(new Error(code || 'Composition finished.'));
  };
  const onAbort = () => finish(signal?.reason?.name === 'TimeoutError' ? 'COMPOSITION_TIME_LIMIT' : 'COMPOSITION_CANCELLED',
    'Composition was cancelled or reached its deadline. Inspect child receipts before retrying.');
  const timer = setTimeout(() => finish('COMPOSITION_TIME_LIMIT', 'Composition wall-clock deadline exceeded.'), wallMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    if (!ended) {
      const tools = getToolSchemas().filter(tool => tool.name !== 'relai_compose').map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
      worker = new Worker(new URL('./compositionWorker.js', import.meta.url), {
        workerData: { code: args.code, tools, limits: COMPOSITION_LIMITS },
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        // A host --inspect or preload must not become part of the interpreter Worker.
        execArgv: []
      });
      worker.on('error', () => finish('COMPOSITION_RUNTIME_ERROR', 'The isolated JavaScript worker failed.'));
      worker.on('exit', () => { if (!ended) finish('COMPOSITION_RUNTIME_ERROR', 'The JavaScript worker exited before returning a result.'); });
      worker.on('message', message => {
        if (ended) return;
        if (Date.now() >= deadlineAtMs) { finish('COMPOSITION_TIME_LIMIT', 'Composition deadline exceeded.'); return; }
        if (message.type === 'done') { finish(message.errorCode, message.error); return; }
        if (message.type === 'emit') {
          const size = typeof message.json === 'string' ? bytes(message.json) : Infinity;
          if (++outputCount > COMPOSITION_LIMITS.outputItems || (outputBytes += size) > COMPOSITION_LIMITS.outputBytes) {
            finish('COMPOSITION_OUTPUT_LIMIT', 'Composition output budget exceeded.'); return;
          }
          if (message.kind === 'text') {
            if ((textBytes += size) > COMPOSITION_LIMITS.textBytes) { finish('COMPOSITION_OUTPUT_LIMIT', 'Text output budget exceeded. Filter results before emitting.'); return; }
            outputs.push({ type: 'text', text: message.json });
          } else if (message.kind === 'image') {
            try {
              const value = JSON.parse(message.json);
              const candidate = value?.image || value;
              if (++images > COMPOSITION_LIMITS.images || !authorizedImages.has(imageKey(candidate))) throw new Error('Image was not returned by an authorized child tool.');
              outputs.push({ type: 'image', image: { data: candidate.data, mimeType: candidate.mimeType } });
            } catch { finish('COMPOSITION_IMAGE_INVALID', 'image() requires an image returned by a child tool, within the image limit.'); }
          } else finish('COMPOSITION_BRIDGE_ERROR', 'Unknown output kind.');
          return;
        }
        if (message.type !== 'call' || !Number.isSafeInteger(message.id) || message.id !== calls.length + 1
          || typeof message.name !== 'string' || typeof message.json !== 'string') {
          finish('COMPOSITION_BRIDGE_ERROR', 'Invalid nested tool request.'); return;
        }
        if (calls.length >= COMPOSITION_LIMITS.calls || pending.size >= COMPOSITION_LIMITS.concurrentCalls) {
          finish('COMPOSITION_CALL_LIMIT', 'Nested tool call or concurrency limit exceeded.'); return;
        }
        if (bytes(message.json) > COMPOSITION_LIMITS.argumentBytes) { finish('COMPOSITION_ARGUMENT_LIMIT', 'Nested arguments exceed the byte limit.'); return; }
        const receipt = { id: message.id, tool: message.name, status: 'pending' };
        calls.push(receipt);
        const operation = Promise.resolve().then(async () => {
          // A synchronous admission fence closes the interval between receiving
          // the request and entering the canonical dispatcher.
          if (ended || signal?.aborted) return failure('COMPOSITION_CANCELLED', 'Nested call was not dispatched.');
          let childArgs;
          try {
            childArgs = JSON.parse(message.json);
            if (!childArgs || typeof childArgs !== 'object' || Array.isArray(childArgs)) throw new Error('Nested arguments must be an object.');
            if (message.name === 'relai_compose') throw new Error('Recursive composition is unavailable.');
            const resolved = resolveToolOperation(message.name, childArgs);
            if (!resolved) throw new Error('Only public Rel.AI tools are available.');
            receipt.action = resolved.action;
            if (message.name === 'relai_work' && !WORK_ACTIONS.has(resolved.action)
              || message.name === 'relai_validate' && childArgs.complete === true) {
              throw new Error('Task/Goal lifecycle controls and validate complete:true require direct calls outside composition.');
            }
            const parentTask = String(args.work_id || context.taskId || '');
            if (childArgs.work_id != null && childArgs.work_id !== parentTask || parentTask && childArgs.independent === true) {
              throw new Error('Nested calls must retain the composition work_id.');
            }
            if (args.workspace && childArgs.workspace && resolveWorkspace(config, childArgs.workspace).alias !== args.workspace) {
              throw new Error('Nested calls must retain the composition workspace.');
            }
            childArgs = { ...(args.workspace ? { workspace: args.workspace } : {}), ...childArgs,
              ...(parentTask ? { work_id: parentTask } : args.independent === true ? { independent: true } : {}) };
            receipt.dispatched = true;
            return await context.invokeTool(message.name, childArgs, { signal, deadlineAtMs, requestId: `${compositionId}:${message.id}` });
          } catch (error) { return serializeToolError(message.name, error); }
        }).then(value => {
          receipt.toolOk = value?.ok !== false;
          receipt.ok = receipt.toolOk && value?.commandSucceeded !== false && value?.validationStatus !== 'failed';
          receipt.status = receipt.ok ? 'completed' : 'failed';
          if (typeof value?.errorCode === 'string') receipt.errorCode = value.errorCode;
          for (const key of RECEIPT_FIELDS) if (['string', 'number', 'boolean'].includes(typeof value?.[key]) || value?.[key] === null) receipt[key] = value[key];
          if (ended) return;
          const json = JSON.stringify(value);
          const size = bytes(json);
          if (size > COMPOSITION_LIMITS.resultBytes || (resultBytes += size) > COMPOSITION_LIMITS.totalResultBytes) {
            finish('COMPOSITION_RESULT_LIMIT', 'Nested result budget exceeded. Use narrower reads and inspect existing receipts before retrying.'); return;
          }
          visitImages(value, key => authorizedImages.add(key));
          worker.postMessage({ type: 'result', id: message.id, json });
        }).catch(() => { finish('COMPOSITION_BRIDGE_ERROR', 'A child result could not be serialized. Inspect its existing receipt.'); });
        pending.add(operation);
        void operation.finally(() => pending.delete(operation));
      });
    }
    const outcome = await done;
    clearTimeout(timer);
    if (worker) await worker.terminate();
    if (pending.size) {
      let settlementTimer;
      await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { settlementTimer = setTimeout(resolve, COMPOSITION_LIMITS.settlementMs); })]);
      clearTimeout(settlementTimer);
    }
    const receipts = calls.map(call => ({ ...call }));
    const failedCalls = receipts.filter(call => call.ok === false).length;
    const pendingCalls = receipts.filter(call => call.status === 'pending').length;
    let nestedOutcome = outcome.ok && failedCalls ? failure('COMPOSITION_CHILD_FAILED', 'One or more nested tools failed. Inspect calls and emitted output.') : outcome;
    // Keep user-selected output out of durable task history. Reuse its private,
    // owner-authorized output store for the complete JSON result and receipts.
    const owner = outputSpillOwner({ taskId: args.work_id || context.taskId, workspace: args.workspace, principal: context.principal });
    let compositionOutputRef;
    if (owner && (outputs.length || receipts.length)) {
      const retained = { stdout: JSON.stringify({ version: 1, compositionId, ...nestedOutcome, outputs, calls: receipts }) };
      await retainOutputStreams(config, owner, retained);
      compositionOutputRef = retained.stdoutOutputRef;
      if (!compositionOutputRef || retained.stdoutSpillTruncated || retained.outputFinalizationTimedOut) {
        nestedOutcome = failure('COMPOSITION_OUTPUT_RETENTION_FAILED', 'Complete composition output could not be retained. Inspect the returned effects and receipts before retrying.');
      }
    }
    return { ...nestedOutcome, compositionId, ...(args.workspace ? { workspace: args.workspace } : {}),
      ...(compositionOutputRef ? { compositionOutputRef } : {}),
      outputs, calls: receipts, durationMs: Date.now() - started,
      summary: `${receipts.length} nested calls; ${failedCalls} failed; ${pendingCalls} unsettled.`,
      unsettledCalls: pendingCalls,
      ...(nestedOutcome.ok ? {} : { nextAction: 'Already-dispatched actions are not rolled back. Inspect child receipts and current state before retrying.' }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (worker) await worker.terminate();
    if (pending.size) void Promise.allSettled([...pending]).then(release); else release();
  }
}
