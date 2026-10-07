import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { terminateProcessTree } from '../../src/process.ts';
import { prepareWindowsProcessJob } from '../../src/windowsProcessJob.ts';
import { createTestOutputTail } from './test-output-tail.mjs';

function removeUnstartedDirectory(directory) {
  if (!directory) return false;
  try { fs.rmSync(directory, { recursive: true, force: true }); return false; }
  catch { return true; }
}

export async function runTestProcess(executable, args, { cwd, timeoutMs = 300000, maxOutputBytes = 1048576,
  terminate } = {}) {
  const startedAt = Date.now();
  let job;
  let privateRoot;
  try {
    if (process.platform === 'win32') {
      privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-test-process-job-'));
      job = await prepareWindowsProcessJob({}, { executable, args, cwd, env: process.env }, privateRoot);
    }
  } catch (error) {
    const cleanupPending = removeUnstartedDirectory(privateRoot);
    return { exitCode: 1, stdout: '', stderr: '', error, timedOut: false, terminationUncertain: false, cleanupPending };
  }
  if (Date.now() - startedAt >= timeoutMs) {
    const cleanupPending = removeUnstartedDirectory(privateRoot);
    return { exitCode: 1, stdout: '', stderr: '', error: new Error('Test deadline elapsed before process startup.'),
      timedOut: true, terminationUncertain: false, cleanupPending };
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(job?.executable || executable, job?.args || args, { cwd, env: job?.environment,
        windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      job?.bind(child.pid);
    } catch (error) {
      const cleanupPending = removeUnstartedDirectory(privateRoot);
      resolve({ exitCode: null, stdout: '', stderr: '', error, terminationUncertain: false, cleanupPending });
      return;
    }
    const stdout = createTestOutputTail(maxOutputBytes);
    const stderr = createTestOutputTail(maxOutputBytes);
    let error = null;
    let settled = false;
    let closed = false;
    let timedOut = false;
    let termination = null;
    let closeResolve;
    const closePromise = new Promise(done => { closeResolve = done; });
    const waitForClose = async milliseconds => {
      let waitTimer;
      try { return await Promise.race([closePromise.then(() => true),
        new Promise(done => { waitTimer = setTimeout(() => done(false), milliseconds); })]); }
      finally { clearTimeout(waitTimer); }
    };
    const finish = async exitCode => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stopped = termination ? await termination : null;
      const noSpawn = !child.pid;
      const nativeOutcome = job && !noSpawn ? job.outcome() : null;
      const uncertain = stopped?.exited === false || nativeOutcome?.exited === false;
      const receipt = job?.receipt();
      if (uncertain && !error) error = new Error('Test process ownership is unconfirmed. Stop launching more tests.');
      if (receipt?.startupFailedBeforeCommand && !error) error = new Error(receipt.error || 'Native test startup failed before execution.');
      let cleanupPending = false;
      if (privateRoot && !uncertain) {
        if (noSpawn) cleanupPending = removeUnstartedDirectory(privateRoot);
        else if (job.cleanup()) { try { fs.rmdirSync(privateRoot); } catch { cleanupPending = true; } }
        else cleanupPending = true;
      }
      const out = stdout.snapshot();
      const err = stderr.snapshot();
      resolve({ exitCode: timedOut || uncertain ? 1 : receipt?.rootExitCode ?? exitCode,
        stdout: out.text, stderr: err.text, error, timedOut, terminationUncertain: uncertain,
        ...(cleanupPending ? { cleanupPending: true } : {}),
        stdoutTruncated: out.truncated, stderrTruncated: err.truncated,
        stdoutBytes: out.totalBytes, stderrBytes: err.totalBytes });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      error = new Error(`Test exceeded ${timeoutMs}ms; terminating its owned process tree.`);
      termination = Promise.resolve().then(async () => {
        const options = { graceMs: 1000, forceWaitMs: 2000, ownerJob: job };
        const outcome = terminate ? await terminate(child, options)
          : job ? await job.stop('timeout', 3000) : await terminateProcessTree(child, options);
        if (outcome.exited && !closed && !await waitForClose(1500)) {
          const controller = await terminateProcessTree(child, options);
          if (!controller.exited) return { ...controller, exited: false };
        }
        return outcome;
      }).catch(failure => ({ exited: false, error: failure.message }));
      void termination.then(stopped => {
        if (!stopped.exited) error = new Error('Test timed out and descendant termination is unconfirmed. Stop launching more tests.');
        child.stdout.destroy();
        child.stderr.destroy();
        if (!closed) child.unref();
        void finish(child.exitCode);
      });
    }, Math.max(1, timeoutMs - (Date.now() - startedAt)));
    child.stdout.on('data', chunk => stdout.append(chunk));
    child.stderr.on('data', chunk => stderr.append(chunk));
    child.once('error', value => { error = value; });
    child.once('close', code => { closed = true; closeResolve(); void finish(code); });
  });
}
