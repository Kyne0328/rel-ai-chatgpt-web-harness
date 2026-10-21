// The host Worker owns QuickJS handles; supplied code only runs inside QuickJS/WASM.
import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';

const { code, tools, limits } = workerData;
const module = await newQuickJSWASMModuleFromVariant(variant);
const runtime = module.newRuntime();
runtime.setMemoryLimit(limits.memoryBytes);
runtime.setMaxStackSize(512 * 1024);
const vm = runtime.newContext();
const deferred = new Map();
let nextId = 0, activeMs = 0, activeSince = 0, ended = false, root;
runtime.setInterruptHandler(() => activeMs + performance.now() - activeSince > limits.cpuMs);

function active(callback) {
  activeSince = performance.now();
  try { return callback(); }
  finally { activeMs += performance.now() - activeSince; }
}

function finish(errorCode = '', error = '') {
  if (ended) return;
  ended = true;
  parentPort.postMessage({ type: 'done', errorCode, error });
  parentPort.close();
  // Termination by the host also releases outstanding deferred handles after errors.
}

function errorText(handle) {
  const value = vm.dump(handle);
  return String(value?.message || value || 'JavaScript execution failed.').slice(0, 2000);
}

function pump() {
  if (ended) return;
  try {
    active(() => {
      // Bound each job batch and check CPU between batches. The host thread
      // independently owns wall-clock termination of this worker.
      while (runtime.hasPendingJob()) {
        const jobs = runtime.executePendingJobs(64);
        if (jobs.error) {
          const error = errorText(jobs.error); jobs.error.dispose();
          finish('COMPOSITION_SCRIPT_ERROR', error); return;
        }
        if (activeMs + performance.now() - activeSince > limits.cpuMs) {
          finish('COMPOSITION_CPU_LIMIT', 'Active JavaScript CPU budget exceeded.'); return;
        }
      }
      const state = vm.getPromiseState(root);
      if (state.type === 'rejected') {
        const message = errorText(state.error); state.error.dispose();
        finish(activeMs + performance.now() - activeSince > limits.cpuMs ? 'COMPOSITION_CPU_LIMIT' : 'COMPOSITION_SCRIPT_ERROR', message);
      } else if (state.type === 'fulfilled') {
        state.value.dispose();
        finish(deferred.size ? 'COMPOSITION_UNAWAITED_CALLS' : '', deferred.size ? 'Await every nested tool call before returning.' : '');
      } else if (!deferred.size) {
        finish('COMPOSITION_UNRESOLVED_PROMISE', 'The script is waiting on a promise with no pending tool call.');
      }
    });
  } catch (error) { finish('COMPOSITION_RUNTIME_ERROR', String(error?.message || error).slice(0, 2000)); }
}

try {
  const call = vm.newFunction('__call', (name, args) => {
    const id = ++nextId;
    const promise = vm.newPromise();
    deferred.set(id, promise);
    parentPort.postMessage({ type: 'call', id, name: vm.getString(name), json: vm.getString(args) });
    return promise.handle;
  });
  vm.setProp(vm.global, '__call', call); call.dispose();
  const emit = vm.newFunction('__emit', (kind, json) => {
    const serialized = vm.getString(json);
    if (serialized.length > limits.outputBytes) throw new Error('COMPOSITION_OUTPUT_LIMIT');
    parentPort.postMessage({ type: 'emit', kind: vm.getString(kind), json: serialized });
    return vm.undefined;
  });
  vm.setProp(vm.global, '__emit', emit); emit.dispose();
  const bootstrap = active(() => vm.evalCode(`
    (() => {
      const invoke = globalThis.__call, emit = globalThis.__emit;
      delete globalThis.__call; delete globalThis.__emit;
      const stringify = JSON.stringify, parse = JSON.parse;
      const freeze = value => {
        if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
        return value;
      };
      const definitions = freeze(${JSON.stringify(tools)});
      const methods = Object.create(null);
      for (const tool of definitions) methods[tool.name] = async (args = {}) => {
        const json = stringify(args);
        if (typeof json !== 'string' || json.length > ${limits.argumentBytes}) throw new Error('COMPOSITION_ARGUMENT_LIMIT');
        return parse(await invoke(tool.name, json));
      };
      Object.defineProperties(globalThis, {
        ALL_TOOLS: { value: definitions }, tools: { value: Object.freeze(methods) },
        LIMITS: { value: freeze(${JSON.stringify(limits)}) },
        text: { value: value => {
          const result = typeof value === 'string' ? value : stringify(value);
          if (typeof result !== 'string') throw new TypeError('text requires a JSON-serializable value.');
          emit('text', result);
        } },
        image: { value: value => emit('image', stringify(value)) }
      });
    })();
  `, 'relai-composition-bootstrap.js'));
  if (bootstrap.error) { const error = errorText(bootstrap.error); bootstrap.error.dispose(); throw new Error(error); }
  bootstrap.value.dispose();
  parentPort.on('message', message => {
    if (ended || message.type !== 'result') return;
    const promise = deferred.get(message.id);
    if (!promise) return finish('COMPOSITION_BRIDGE_ERROR', 'Unknown tool response.');
    deferred.delete(message.id);
    active(() => {
      const result = vm.newString(message.json);
      promise.resolve(result); result.dispose(); promise.dispose();
    });
    pump();
  });
  const result = active(() => vm.evalCode(`(async () => {\n${code}\n})()`, 'relai-composition.js'));
  if (result.error) {
    const error = errorText(result.error); result.error.dispose();
    finish(activeMs >= limits.cpuMs ? 'COMPOSITION_CPU_LIMIT' : 'COMPOSITION_SCRIPT_ERROR', error);
  } else { root = result.value; pump(); }
} catch (error) { finish('COMPOSITION_RUNTIME_ERROR', String(error?.message || error).slice(0, 2000)); }
