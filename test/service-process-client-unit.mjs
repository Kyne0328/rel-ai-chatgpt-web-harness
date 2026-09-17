import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createServiceProcessClient } from '../electron/service-process-client.js';
import { projectServiceActivityEvent, projectServiceActivitySnapshot } from '../electron/service-activity-projection.js';

const projectedTask = {
  taskId: 'task-projection',
  workspace: 'repo',
  events: [{ eventId: 'private-timeline' }],
  currentOperations: [{ id: 'private-operation' }],
  principalFingerprint: 'private-principal'
};
const projectedEvent = projectServiceActivityEvent({
  phase: 'finished',
  operationId: 'operation-42',
  task: projectedTask
});
assert.equal(projectedEvent.operationId, 'operation-42', 'service activity must preserve operation correlation across the desktop boundary');
assert.equal(Object.hasOwn(projectedEvent.task, 'events'), false, 'service activity must not serialize task timelines into Electron IPC');
assert.equal(Object.hasOwn(projectedEvent.task, 'currentOperations'), false, 'service activity must not serialize active-operation payloads into Electron IPC');
assert.equal(Object.hasOwn(projectedEvent.task, 'principalFingerprint'), false, 'service activity must not serialize principal fingerprints into Electron IPC');
assert.equal(projectServiceActivityEvent({ phase: 'progress', task: projectedTask }), null, 'high-frequency progress must be dropped before Electron IPC serialization');
assert.equal(projectServiceActivitySnapshot({ tasks: [projectedTask] }).tasks[0].taskId, 'task-projection');

class FakeUtilityProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 4321;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.sent = [];
    this.killed = false;
    this.deferStop = false;
    this.deferredStopRequest = null;
    queueMicrotask(() => this.emit('spawn'));
  }

  postMessage(message) {
    this.sent.push(message);
    if (message.type !== 'request') return;
    if (message.method === 'stop' && this.deferStop) {
      this.deferredStopRequest = message;
      return;
    }
    const responses = {
      start: { ok: true, port: 4567 },
      'dashboard-bootstrap': { ok: true, port: 4567, bootstrap: 'bootstrap-token' },
      'desktop-local-usage': { source: 'local', month: message.payload.month },
      'desktop-onboarding-handoff': { completed: false, handoffPending: true },
      'desktop-task-code-workspace': { ok: true, work_id: message.payload.taskId, files: [] },
      'desktop-task-code-diff': { ok: true, work_id: message.payload.taskId, path: message.payload.path },
      'desktop-task-code-workspace-path': '/repo',
      stop: {
        ok: true,
        cleanup: {
          clean: true,
          managedProcesses: { attempted: 0, stopped: 0, orphaned: 0 },
          localService: { closed: true, forced: false }
        }
      }
    };
    queueMicrotask(() => this.emit('message', {
      type: 'response',
      id: message.id,
      ok: true,
      result: responses[message.method]
    }));
  }

  kill() {
    this.killed = true;
  }
}

const forks = [];
let child = null;
const utilityProcess = {
  fork(modulePath, args, options) {
    child = new FakeUtilityProcess();
    forks.push({ modulePath, args, options, child });
    return child;
  }
};

const nativeCalls = [];
const logs = [];
const client = createServiceProcessClient({
  utilityProcess,
  modulePath: '/app/electron/service-process.js',
  cwd: '/app',
  nativeHandlers: {
    openFolder: payload => {
      nativeCalls.push(payload.path);
      return { ok: true };
    }
  },
  onLog: (message, options) => logs.push({ message, options })
});

client.updateContext({ status: { serverRunning: false } });
const activityEvents = [];
client.activitySource.onToolActivity(event => activityEvents.push(event));
const unsubscribeBrokenActivityListener = client.activitySource.onToolActivity(() => { throw new Error('listener boom'); });

const started = await client.start({ host: '127.0.0.1', port: 3333, token: 'secret' });
assert.equal(started.port, 4567);
assert.equal(client.isListening(), true);
assert.equal(client.port(), 4567);
assert.equal(forks.length, 1);
assert.equal(forks[0].options.serviceName, 'Rel.AI MCP Service');
assert.equal(forks[0].options.stdio, 'pipe');
assert.equal(forks[0].options.cwd, '/app');
const initialContextMessages = child.sent.filter(message => message.type === 'context');
assert.equal(initialContextMessages.length, 1, 'service startup must send the retained desktop context only once');
assert.equal(initialContextMessages[0].context.status?.serverRunning, false);

child.emit('message', {
  type: 'activity',
  event: {
    phase: 'snapshot',
    snapshot: { state: 'working', activeCalls: 1, activeTaskCount: 1, tasks: [{ id: 'task-1' }] }
  }
});
assert.equal(client.activitySource.getToolActivity().state, 'working');
assert.equal(client.activitySource.getToolActivity().tasks[0].id, 'task-1');
assert.equal(activityEvents.length, 1);
child.emit('message', {
  type: 'activity',
  event: { phase: 'snapshot', snapshot: { state: 'working', activeCalls: 1, activeTaskCount: 1, tasks: [{ id: 'task-1' }] } }
});
const subscriberFailures = logs.filter(entry => entry.options.code === 'activity_listener_failed');
assert.equal(subscriberFailures.length, 1, 'a failing subscriber must be diagnosable without log spam');
assert.equal(subscriberFailures[0].options.taskId, 'task-1', 'subscriber failures should retain task correlation when the event identifies one task');
unsubscribeBrokenActivityListener();

const unsubscribeCorrelatedFailureListener = client.activitySource.onToolActivity(() => { throw new Error('correlated listener boom'); });
child.emit('message', {
  type: 'activity',
  event: { phase: 'finished', taskId: 'task-1', operationId: 'operation-42', operation: 'Read project', workspace: 'repo', ok: false }
});
const correlatedFailure = logs.filter(entry => entry.options.code === 'activity_listener_failed').at(-1);
assert.equal(correlatedFailure.options.eventId, 'operation-42', 'subscriber diagnostics must retain the projected operation ID');
unsubscribeCorrelatedFailureListener();

client.updateContext({
  runtimeLogs: { available: true, revision: 1, count: 1, entries: [{ message: 'first' }] }
});
client.updateContext({
  runtimeLogChange: { type: 'append', revision: 2, count: 2, maxEntries: 3, entry: { message: 'second' } }
});
const logDeltaMessage = child.sent.at(-1);
assert.equal(logDeltaMessage.type, 'context');
assert.equal(logDeltaMessage.context.runtimeLogChange.entry.message, 'second');
assert.equal(Object.hasOwn(logDeltaMessage.context, 'runtimeLogs'), false, 'log changes must cross the utility-process boundary as deltas');
client.updateContext({ transportEvent: { event: 'upstream_5xx', at: '2026-09-15T06:00:01.000Z' } });
const transportContextMessage = child.sent.at(-1);
assert.equal(transportContextMessage.context.transportEvent.event, 'upstream_5xx');

child.emit('message', { type: 'native-request', id: 'native-1', method: 'openFolder', payload: { path: '/repo' } });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(nativeCalls, ['/repo']);
assert.ok(child.sent.some(message => message.type === 'native-response' && message.id === 'native-1' && message.ok === true));

child.stdout.write('service ready\n');
child.stderr.write('service warning\n');
await new Promise(resolve => setImmediate(resolve));
assert.ok(logs.some(entry => entry.message === 'service ready' && entry.options.level === 'info'));
assert.ok(logs.some(entry => entry.message === 'service warning' && entry.options.level === 'warning'));

const bootstrap = await client.dashboardBootstrap();
assert.equal(bootstrap.bootstrap, 'bootstrap-token');
assert.deepEqual(await client.getLocalUsage('2026-09'), { source: 'local', month: '2026-09' });
assert.equal((await client.markOnboardingHandoff()).handoffPending, true);
assert.deepEqual(await client.getTaskCodeWorkspace({ taskId: 'task-1' }), { ok: true, work_id: 'task-1', files: [] });
assert.deepEqual(await client.readTaskCodeDiff({ taskId: 'task-1', path: 'src/index.js' }), { ok: true, work_id: 'task-1', path: 'src/index.js' });
assert.equal(await client.getTaskCodeWorkspacePath({ taskId: 'task-1' }), '/repo');
for (const method of ['desktop-local-usage','desktop-onboarding-handoff','desktop-task-code-workspace','desktop-task-code-diff','desktop-task-code-workspace-path']) {
  assert.ok(child.sent.some(message => message.type === 'request' && message.method === method), `${method} must cross the utility-process boundary`);
}
const stopped = await client.stop();
assert.equal(stopped.cleanup.clean, true);
assert.equal(client.isListening(), false);

const exitedChild = child;
exitedChild.emit('exit', 1);
assert.equal(client.isListening(), false);
assert.equal(client.activitySource.getToolActivity().state, 'idle', 'an exited service process must not leave stale active desktop work');
assert.equal(activityEvents.at(-1).phase, 'snapshot');
assert.equal(activityEvents.at(-1).snapshot.state, 'idle');

await client.start({ host: '127.0.0.1', port: 3333, token: 'secret' });
assert.equal(forks.length, 2);
const respawnContext = child.sent.find(message => message.type === 'context');
assert.equal(respawnContext.context.runtimeLogs.revision, 2, 'a respawned service must receive the reconstructed current log snapshot');
assert.deepEqual(respawnContext.context.runtimeLogs.entries.map(entry => entry.message), ['first', 'second']);
assert.equal(Object.hasOwn(respawnContext.context, 'runtimeLogChange'), false);

child.deferStop = true;
const delayedStop = client.stop();
await new Promise(resolve => setImmediate(resolve));
assert.equal(client.isListening(), false, 'a requested stop must stop advertising the old listener before the utility response arrives');
assert.ok(child.deferredStopRequest, 'the stop request must still be in flight for the delayed-response regression case');
child.emit('message', {
  type: 'response',
  id: child.deferredStopRequest.id,
  ok: true,
  result: {
    ok: true,
    cleanup: {
      clean: true,
      managedProcesses: { attempted: 0, stopped: 0, orphaned: 0 },
      localService: { closed: true, forced: false }
    }
  }
});
await delayedStop;

await client.dispose({ stop: false });
assert.equal(child.killed, true);

class DeferredSpawnUtilityProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 8765;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  postMessage() {}

  kill() {
    this.killed = true;
  }
}

const deferredChild = new DeferredSpawnUtilityProcess();
const deferredClient = createServiceProcessClient({
  utilityProcess: { fork: () => deferredChild },
  modulePath: '/app/electron/service-process.js'
});
const deferredStart = deferredClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' });
const deferredDispose = deferredClient.dispose({ stop: false });
await assert.rejects(
  deferredStart,
  /closed during startup/i,
  'disposing before spawn must settle the pending startup instead of removing the listeners it depends on'
);
await deferredDispose;
assert.equal(deferredChild.killed, true);

let spawnWatchdogForks = 0;
const neverSpawnChild = new DeferredSpawnUtilityProcess();
const spawnWatchdogClient = createServiceProcessClient({
  utilityProcess: {
    fork() {
      spawnWatchdogForks += 1;
      return spawnWatchdogForks === 1 ? neverSpawnChild : new FakeUtilityProcess();
    }
  },
  modulePath: '/app/electron/service-process.js',
  spawnTimeoutMs: 20
});
await assert.rejects(
  () => spawnWatchdogClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' }),
  error => error?.code === 'REL_AI_SERVICE_SPAWN_TIMEOUT' && /did not spawn within/i.test(error.message),
  'a utility process that never emits spawn must be invalidated instead of blocking desktop startup forever'
);
assert.equal(neverSpawnChild.killed, true, 'the spawn watchdog must terminate the unusable child');
assert.equal((await spawnWatchdogClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' })).port, 4567,
  'a startup retry after a spawn timeout must use a fresh utility process');
assert.equal(spawnWatchdogForks, 2);
await spawnWatchdogClient.dispose({ stop: false });

class NonResponsiveStartUtilityProcess extends FakeUtilityProcess {
  postMessage(message) {
    this.sent.push(message);
    if (message.type === 'request' && message.method !== 'start') super.postMessage(message);
  }
}

let requestWatchdogForks = 0;
let invalidationExitCalls = 0;
const hungRequestChild = new NonResponsiveStartUtilityProcess();
const requestWatchdogClient = createServiceProcessClient({
  utilityProcess: {
    fork() {
      requestWatchdogForks += 1;
      return requestWatchdogForks === 1 ? hungRequestChild : new FakeUtilityProcess();
    }
  },
  modulePath: '/app/electron/service-process.js',
  startTimeoutMs: 20,
  onExit: () => { invalidationExitCalls += 1; }
});
await assert.rejects(
  () => requestWatchdogClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' }),
  error => error?.code === 'REL_AI_SERVICE_REQUEST_TIMEOUT'
    && error?.method === 'start'
    && /request timed out: start/i.test(error.message),
  'a lifecycle request timeout must terminate the child instead of leaving a poisoned lifecycle queue behind'
);
assert.equal(hungRequestChild.killed, true, 'timed-out lifecycle requests must invalidate the owned utility process');
assert.equal(invalidationExitCalls, 0, 'intentional timeout invalidation must not trigger the unexpected-exit auto-restart path');
assert.equal((await requestWatchdogClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' })).port, 4567,
  'the request after timeout must execute on a new utility process generation');
assert.equal(requestWatchdogForks, 2);
await requestWatchdogClient.dispose({ stop: false });

class UncleanStopUtilityProcess extends FakeUtilityProcess {
  postMessage(message) {
    this.sent.push(message);
    if (message.type !== 'request') return;
    const result = message.method === 'start'
      ? { ok: true, port: 4567 }
      : message.method === 'stop'
        ? { ok: false, cleanup: { clean: false, localService: { closed: false, forced: true } } }
        : null;
    if (result) queueMicrotask(() => this.emit('message', { type: 'response', id: message.id, ok: true, result }));
  }
}

let uncleanStopForks = 0;
const uncleanStopChild = new UncleanStopUtilityProcess();
const uncleanStopClient = createServiceProcessClient({
  utilityProcess: {
    fork() {
      uncleanStopForks += 1;
      return uncleanStopForks === 1 ? uncleanStopChild : new FakeUtilityProcess();
    }
  },
  modulePath: '/app/electron/service-process.js'
});
await uncleanStopClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' });
const uncleanStop = await uncleanStopClient.stop();
assert.equal(uncleanStop.cleanup.clean, false);
assert.equal(uncleanStopChild.killed, true, 'an unclean stop result must invalidate the uncertain utility process generation');
assert.equal((await uncleanStopClient.start({ host: '127.0.0.1', port: 3333, token: 'secret' })).port, 4567,
  'the next start after an unclean stop must use a fresh utility process');
assert.equal(uncleanStopForks, 2);
await uncleanStopClient.dispose({ stop: false });

console.log('Electron utility-process service bridge contracts passed.');
