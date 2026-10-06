import assert from 'node:assert/strict';
import { createTunnelRecoverySupervisor } from '../electron/tunnel-recovery-supervisor.js';

let clock = 1000;
let restartCalls = 0;
const timers = [];
const schedules = [];
const restartResults = [
  { serverRunning: true, tunnelStatus: 'degraded', errorCode: 'tunnel_connection_interrupted', error: 'still offline' },
  { serverRunning: true, tunnelStatus: 'running', errorCode: '', error: '' }
];

const supervisor = createTunnelRecoverySupervisor({
  restartConnection: async () => {
    restartCalls += 1;
    return restartResults.shift();
  },
  retryDelaysMs: [10, 20, 30],
  now: () => clock,
  setTimer(fn, delayMs) {
    const timer = { fn, delayMs, cancelled: false };
    timers.push(timer);
    return timer;
  },
  clearTimer(timer) { timer.cancelled = true; },
  onSchedule: state => schedules.push(state)
});

const degradedTimers = [];
const degradedSupervisor = createTunnelRecoverySupervisor({
  restartConnection: async () => ({ serverRunning: true, tunnelStatus: 'running', errorCode: '', error: '' }),
  retryDelaysMs: [10],
  setTimer(fn, delayMs) { const timer = { fn, delayMs, cancelled: false }; degradedTimers.push(timer); return timer; },
  clearTimer(timer) { timer.cancelled = true; }
});
const inPlace = degradedSupervisor.observe({ state: 'degraded', recoveryMode: 'in_place', errorCode: 'tunnel_command_delivery_degraded', error: 'responses dropping' });
assert.equal(inPlace.scheduled, false, 'a live tunnel-client recovering in place must not be restarted by the outer supervisor');
assert.equal(degradedTimers.length, 0);
assert.equal(degradedSupervisor.observe({ state: 'degraded', recoveryMode: 'restart', errorCode: 'tunnel_connection_interrupted', error: 'local health failed' }).scheduled, true, 'restart-worthy degraded tunnel health must still schedule recovery');
degradedSupervisor.observe({ state: 'running' });
assert.equal(degradedTimers[0].cancelled, true, 'a recovered response must cancel the pending degraded retry');

let inPlaceReconnectCalls = 0;
const inPlaceReconnectTimers = [];
const inPlaceReconnectSupervisor = createTunnelRecoverySupervisor({
  restartConnection: async () => {
    inPlaceReconnectCalls += 1;
    return { serverRunning: true, tunnelStatus: 'degraded', tunnelRecoveryMode: 'in_place', errorCode: 'tunnel_connection_interrupted', error: 'routing correction in progress' };
  },
  retryDelaysMs: [10],
  setTimer(fn, delayMs) { const timer = { fn, delayMs, cancelled: false }; inPlaceReconnectTimers.push(timer); return timer; },
  clearTimer(timer) { timer.cancelled = true; }
});
const inPlaceReconnect = await inPlaceReconnectSupervisor.retryNow();
assert.equal(inPlaceReconnect.tunnelStatus, 'degraded');
assert.equal(inPlaceReconnectCalls, 1, 'a replacement client that owns in-place recovery must not be replaced again');
assert.equal(inPlaceReconnectSupervisor.snapshot().scheduled, false);
assert.equal(inPlaceReconnectTimers.length, 0);

const first = supervisor.observe({ state: 'failed', errorCode: 'secure_tunnel_failed', error: 'tunnel-client exited' });
assert.equal(first.scheduled, true, 'unexpected tunnel failure must schedule automatic recovery');
assert.equal(first.attempt, 1);
assert.equal(first.nextRetryAt, 1010);
assert.equal(timers[0].delayMs, 10);
assert.equal(schedules[0].lastError, 'tunnel-client exited');

await fireTimer(timers[0]);
assert.equal(restartCalls, 1, 'scheduled recovery must use the canonical connection retry operation');
assert.equal(supervisor.snapshot().scheduled, true, 'a retryable failed reconnect must schedule another attempt');
assert.equal(supervisor.snapshot().attempt, 2);
assert.equal(timers[1].delayMs, 20);

clock = 1030;
await fireTimer(timers[1]);
assert.equal(restartCalls, 2);
assert.equal(supervisor.snapshot().attempt, 0, 'successful reconnect must reset retry backoff');
assert.equal(supervisor.snapshot().scheduled, false);

const timerCountBeforeFatal = timers.length;
supervisor.observe({ state: 'failed', errorCode: 'tunnel_authentication_failed', error: 'rejected key' });
assert.equal(timers.length, timerCountBeforeFatal, 'authentication failures must remain terminal and must not retry');
supervisor.observe({ state: 'failed', errorCode: 'tunnel_runtime_unavailable', error: 'bundled tunnel-client missing' });
assert.equal(timers.length, timerCountBeforeFatal, 'permanent local tunnel runtime failures must not retry forever');

supervisor.observe({ state: 'failed', errorCode: 'secure_tunnel_failed', error: 'offline again' });
const scheduledBeforeManualRetry = timers.at(-1);
restartResults.push({ serverRunning: true, tunnelStatus: 'running', errorCode: '', error: '' });
await supervisor.retryNow();
assert.equal(scheduledBeforeManualRetry.cancelled, true, 'Retry now must replace any pending automatic retry');
assert.equal(restartCalls, 3);
assert.equal(supervisor.snapshot().scheduled, false);

supervisor.observe({ state: 'failed', errorCode: 'secure_tunnel_failed', error: 'shutdown race' });
const cancelledOnStop = timers.at(-1);
supervisor.cancel();
assert.equal(cancelledOnStop.cancelled, true, 'shutdown must cancel a pending reconnect');
assert.equal(supervisor.snapshot().attempt, 0);

const inFlightGate = deferred();
const inFlightTimers = [];
const inFlightSupervisor = createTunnelRecoverySupervisor({
  restartConnection: () => inFlightGate.promise,
  retryDelaysMs: [10],
  setTimer(fn, delayMs) {
    const timer = { fn, delayMs, cancelled: false };
    inFlightTimers.push(timer);
    return timer;
  },
  clearTimer(timer) { timer.cancelled = true; }
});
const inFlightRetry = inFlightSupervisor.retryNow();
await new Promise(resolve => setImmediate(resolve));
assert.equal(inFlightSupervisor.snapshot().inFlight, true);
inFlightSupervisor.cancel();
inFlightGate.resolve({ serverRunning: true, tunnelStatus: 'degraded', errorCode: 'tunnel_connection_interrupted', error: 'still offline' });
await inFlightRetry;
assert.equal(inFlightSupervisor.snapshot().scheduled, false, 'an in-flight retry must not resurrect recovery after cancellation');
assert.equal(inFlightTimers.length, 0, 'a stale in-flight retry result must not schedule another timer after cancellation');

console.log('Secure tunnel recovery supervisor retries transient failures and stops on terminal failures.');

async function fireTimer(timer) {
  assert.equal(timer.cancelled, false, 'test attempted to fire a cancelled timer');
  timer.fn();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}


{
  let restarts = 0;
  const timers = [];
  const stoppedSupervisor = createTunnelRecoverySupervisor({
    restartConnection: async () => { restarts += 1; return { serverRunning: true, tunnelStatus: 'running' }; },
    setTimer: callback => { const timer = { callback }; timers.push(timer); return timer; },
    clearTimer: () => {}
  });
  stoppedSupervisor.cancel();
  const stopFailure = stoppedSupervisor.observe({ state: 'failed', errorCode: 'secure_tunnel_stop_failed', error: 'fixture stop unconfirmed' });
  assert.equal(stopFailure.scheduled, false, 'explicit stop failure must not schedule a background restart');
  assert.equal(timers.length, 0);
  assert.equal(restarts, 0);
  stoppedSupervisor.observe({ state: 'stopped', errorCode: '' });
  const resumed = await stoppedSupervisor.retryNow();
  assert.equal(resumed.tunnelStatus, 'running', 'manual retry must remain available after confirmed termination');
  assert.equal(restarts, 1);
  stoppedSupervisor.cancel();
}

{
  let calls = 0;
  const scheduled = [];
  const supervisor = createTunnelRecoverySupervisor({
    restartConnection: async () => { calls++; return { serverRunning: true, tunnelStatus: 'disabled' }; },
    setTimer: callback => { const timer = { callback, cancelled: false }; scheduled.push(timer); return timer; },
    clearTimer: timer => { timer.cancelled = true; }
  });
  const disabled = await supervisor.retryNow();
  assert.equal(disabled.tunnelStatus, 'disabled', 'removing the last connection completes without automatic retries');
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 0);
  supervisor.observe({ state: 'degraded', recoveryMode: 'restart' });
  assert.equal(supervisor.snapshot().scheduled, true);
  supervisor.observe({ state: 'disabled' });
  assert.equal(supervisor.snapshot().scheduled, false, 'intentional disconnection cancels an already scheduled retry');
  assert.equal(scheduled[0].cancelled, true);
  supervisor.cancel();
}
