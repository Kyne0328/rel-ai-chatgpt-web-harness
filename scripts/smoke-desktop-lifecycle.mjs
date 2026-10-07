import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function smokeDesktopLifecycle({ executable, argv = ['--background'], stateDirectory,
  timeoutMs = 25000, stableMs = 500, shutdownMs = 5000, env = process.env, spawnImpl = spawn, terminateImpl = terminateOwned }) {
  fs.mkdirSync(stateDirectory, { recursive: true });
  const runDirectory = fs.mkdtempSync(path.join(stateDirectory, 'desktop-smoke-'));
  const userData = path.join(runDirectory, 'profile');
  fs.mkdirSync(userData);
  const nonce = crypto.randomBytes(16).toString('hex');
  const receiptPath = path.join(userData, 'desktop-smoke-ready.json');
  const child = spawnImpl(executable, argv, {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, REL_AI_MCP_STATE_DIR: path.join(runDirectory, 'state'),
      REL_AI_ELECTRON_DEV_USER_DATA: userData, REL_AI_DESKTOP_SMOKE_NONCE: nonce,
      REL_AI_OFFICIAL_BUILD: '0', REL_AI_MAINTAINER_USAGE_ENDPOINT: '',
      REL_AI_MAINTAINER_DIAGNOSTICS_ENDPOINT: '', REL_AI_OTEL_EXPORTER_OTLP_ENDPOINT: '',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' }
  });
  let output = '';
  let exit = null;
  let spawnError = null;
  const retain = chunk => { output = (output + chunk.toString('utf8')).slice(-65536); };
  child.stdout.on('data', retain);
  child.stderr.on('data', retain);
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    exit = { code, signal };
    resolve(exit);
  }));
  const assertRunning = () => {
    if (spawnError) throw spawnError;
    if (exit || child.exitCode !== null || child.signalCode) {
      throw new Error(`Desktop exited before successful readiness/shutdown (code ${exit?.code ?? child.exitCode}).\n${output}`);
    }
  };
  let passed = false;
  let failure = null;
  let result;
  try {
    const deadline = Date.now() + timeoutMs;
    let receipt;
    while (Date.now() < deadline) {
      assertRunning();
      try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); } catch { receipt = null; }
      if (receipt?.ready === true && receipt.nonce === nonce && receipt.pid === child.pid
          && Number.isInteger(receipt.rendererCount) && receipt.rendererCount > 0) break;
      receipt = null;
      await delay(25);
    }
    if (!receipt) throw new Error(`Desktop did not report verified renderer readiness.\n${output}`);
    await delay(stableMs);
    assertRunning();
    // Ask the main process to run its shutdown coordinator. Signalling the
    // whole group first kills Chromium's zygote/GPU helpers during that work.
    child.kill('SIGTERM');
    const stopped = await boundedShutdown(closed, child, shutdownMs);
    if (!stopped) throw new Error('Desktop did not finish its intentional shutdown.');
    if (stopped.code !== 0 || stopped.signal) throw new Error(`Desktop shutdown was not clean (code ${stopped.code}, signal ${stopped.signal}).\n${output}`);
    passed = true;
    result = { ready: true, rendererCount: receipt.rendererCount, shutdownClean: true, runDirectory };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (child.pid && (!exit || ownedProcessesRunning(child))) {
        terminateImpl(child, 'SIGTERM');
        if (!await boundedShutdown(closed, child, shutdownMs)) {
          terminateImpl(child, 'SIGKILL');
          if (!await boundedShutdown(closed, child, shutdownMs)) {
            const cleanupError = new Error(`Smoke-owned child ${child.pid} termination could not be confirmed; preserve ${runDirectory}.`);
            failure = failure ? new AggregateError([failure, cleanupError], 'Desktop smoke failed and process cleanup is unconfirmed.') : cleanupError;
          }
        }
      }
    } catch (cleanupError) {
      failure = failure ? new AggregateError([failure, cleanupError], 'Desktop smoke failed during process cleanup.') : cleanupError;
    }
    if (passed && !failure) console.log('Desktop renderer readiness and clean intentional shutdown verified.');
  }
  if (failure) throw failure;
  return result;
}

function terminateOwned(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && !child.signalCode) child.kill(signal);
    }
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}
function ownedProcessesRunning(child) {
  if (!child.pid) return false;
  if (process.platform === 'win32') return child.exitCode === null && !child.signalCode;
  try { process.kill(-child.pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  // Linux can retain already-dead, reparented Chromium helpers as zombies.
  // They have exited and cannot be signalled; only live group members
  // block shutdown. A read error other than a racing process exit stays fatal.
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
      throw error;
    }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) === child.pid && state !== 'Z' && state !== 'X') return true;
  }
  return false;
}
async function boundedShutdown(closed, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const stopped = await boundedClose(closed, timeoutMs);
  if (!stopped) return null;
  while (ownedProcessesRunning(child)) {
    if (Date.now() >= deadline) return null;
    await delay(25);
  }
  return stopped;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function boundedClose(closed, timeoutMs) {
  let timer;
  try { return await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [executable, stateDirectory] = process.argv.slice(2);
  if (!executable || !stateDirectory) throw new Error('Pass the application executable and isolated smoke-state directory.');
  await smokeDesktopLifecycle({ executable, stateDirectory });
}
