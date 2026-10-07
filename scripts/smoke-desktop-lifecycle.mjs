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
    terminateImpl(child, 'SIGTERM');
    const stopped = await boundedClose(closed, shutdownMs);
    if (!stopped) throw new Error('Desktop did not finish its intentional shutdown.');
    if (stopped.code !== 0) throw new Error(`Desktop shutdown was not clean (code ${stopped.code}, signal ${stopped.signal}).\n${output}`);
    passed = true;
    result = { ready: true, rendererCount: receipt.rendererCount, shutdownClean: true, runDirectory };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (!exit && child.pid) {
        terminateImpl(child, 'SIGTERM');
        if (!await boundedClose(closed, shutdownMs)) {
          terminateImpl(child, 'SIGKILL');
          if (!await boundedClose(closed, shutdownMs)) {
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
  if (!child.pid || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
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
