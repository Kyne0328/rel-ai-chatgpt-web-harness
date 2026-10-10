import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManagedProcess, startManagedProcess, stopManagedProcess, wrappedCmdStartupIsAtPrompt, writeManagedProcess } from '../src/processManager.js';
import { hostResourceStats } from '../src/hostResourceScheduler.js';
import { WindowsProcessJob } from '../src/windowsProcessJob.ts';
import { readWindowsProcessJobArtifacts } from '../src/windowsProcessJobArtifacts.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-pty-'));
const repo = path.join(root, 'repo');
const config = { stateDir: path.join(root, 'state') };
const workspace = { alias: 'app', path: repo };
const context = { taskId: 'pty-work', principal: { clientId: 'pty-client', authMode: 'oauth' }, workspace: 'app' };
fs.mkdirSync(repo, { recursive: true });
const script = path.join(repo, 'pty-child.cjs');
const observationFile = path.join(repo, 'observed-startup.json');
const literalArgs = ['', 'two words', 'quote" and trailing\\', 'snowman \u2603'];
const sentinel = 'exact PTY environment \u2603';
fs.writeFileSync(script, `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(process.argv[2], JSON.stringify({
  args: process.argv.slice(3), cwd: process.cwd(), sentinel: process.env.REL_AI_PTY_SENTINEL,
  stdinTty: Boolean(process.stdin.isTTY), stdoutTty: Boolean(process.stdout.isTTY)
}));
process.stdout.write('TTY:' + Boolean(process.stdout.isTTY) + '\\n');
let lastSize = '';
function reportSize() {
  const size = process.stdout.getWindowSize().join(':');
  if (size !== lastSize) { lastSize = size; process.stdout.write('SIZE:' + size + '\\n'); }
}
reportSize();
setInterval(reportSize, 25);
readline.createInterface({ input: process.stdin, terminal: false })
  .on('line', value => process.stdout.write('ECHO:' + value + '\\n'));
process.on('SIGINT', () => {
  process.stdout.write('TARGET_SIGINT\\n', () => process.exit(31));
});
// A failed assertion cannot leave this synthetic target running indefinitely.
setTimeout(() => process.exit(97), 20000);
`, 'utf8');

let processId = '';
let selectedJob;
const resourceBaseline = hostResourceStats().persistent.active;
let verifiedCompanion;

// Elevated Windows runners can prepend an OSC title to the exact CMD banner.
const titleFixtureCwd = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\relai-process-pty-fixture\repo`;
const titleFixture = '\x1b]0;Administrator:  \x07\x1b[0mMicrosoft Windows [Version 10.0.26100.33438]\x1b[0K\x1b[?25l\r\n'
  + '(c) Microsoft Corporation. All rights reserved.\x1b[0K\r\n\x1b[0K\r\n'
  + `${titleFixtureCwd}>\x1b[0K\x1b[?25h`;
const titleRecord = {
  ptyWrappedStartupEligible: true, ptyLastInputSeq: 0,
  ptyLaunchCwd: titleFixtureCwd, ptyLaunchColumns: 80, columns: 80
};
const titleRange = {
  text: titleFixture, offset: 0, retainedFromOffset: 0,
  truncatedBefore: false, totalBytes: Buffer.byteLength(titleFixture)
};
assert.equal(wrappedCmdStartupIsAtPrompt(titleRecord, titleRange), true, 'exact elevated CMD startup prompt can retire');
assert.equal(wrappedCmdStartupIsAtPrompt({ ...titleRecord, ptyLastInputSeq: 1 }, titleRange), false, 'input invalidates startup-only proof');
assert.equal(wrappedCmdStartupIsAtPrompt(titleRecord, { ...titleRange, text: titleFixture.replace('Administrator:  ', 'Administrator:\x1b[0m  ') }), false,
  'embedded terminal controls cannot be hidden inside the startup title');
assert.equal(wrappedCmdStartupIsAtPrompt(titleRecord, { ...titleRange, text: `unexpected\r\n${titleFixture}` }), false,
  'a later OSC title cannot disguise arbitrary preceding output as startup');

async function startTarget(purpose) {
  const originalBind = WindowsProcessJob.prototype.bind;
  selectedJob = undefined;
  if (process.platform === 'win32') {
    // Observe the actual managed launch without changing selection or signaling.
    WindowsProcessJob.prototype.bind = function(pid) {
      const relative = path.relative(root, this.directory);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) selectedJob = this;
      return originalBind.call(this, pid);
    };
  }
  try {
    return await startManagedProcess(workspace, config, {
      executable: process.execPath,
      argv: [script, observationFile, ...literalArgs],
      env: { REL_AI_PTY_SENTINEL: sentinel },
      kind: 'interactive', purpose, pty: true, columns: 90, rows: 30, startupWaitMs: 100
    }, context);
  } finally { WindowsProcessJob.prototype.bind = originalBind; }
}

function assertSelectedCompanion() {
  if (process.platform !== 'win32') return;
  assert.ok(selectedJob, 'the actual managed PTY route uses WindowsProcessJob');
  assert.equal(selectedJob.executable, verifiedCompanion.executable, 'managed PTY selects the verified shipped companion');
  assert.equal(selectedJob.args[0], '-RequestPath', 'direct companion launch omits the PowerShell wrapper');
  assert.equal(selectedJob.receipt()?.nativeImplementation, 'executable', 'the running native receipt identifies the companion');
}

function assertNativeCleanup(snapshot, expectedExitCode) {
  assert.equal(hostResourceStats().persistent.active, resourceBaseline, 'terminal PTYs release retained-process capacity');
  if (process.platform !== 'win32') return;
  assert.equal(snapshot.terminationConfirmed, true);
  const receipt = selectedJob.receipt();
  assert.equal(receipt.final, true);
  assert.equal(receipt.commandStarted, true);
  assert.equal(receipt.rootExited, true);
  assert.equal(receipt.jobComplete, true);
  assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(receipt.activeProcesses, 0);
  assert.equal(receipt.nativeImplementation, 'executable');
  if (expectedExitCode !== undefined) assert.equal(receipt.rootExitCode, expectedExitCode);
  assert.equal(fs.existsSync(selectedJob.directory), false, 'native-zero completion removes this owned job directory');
}

try {
  if (process.platform === 'win32') verifiedCompanion = readWindowsProcessJobArtifacts(fileURLToPath(new URL('../src/', import.meta.url)));
  const started = await startTarget('Exercise pseudo-terminal input and resize behavior.');
  processId = started.processId;
  assert.equal(started.pty, true);
  assert.equal(started.columns, 90);
  assert.equal(started.rows, 30);
  assert.equal(started.status, 'running');
  assertSelectedCompanion();

  const initial = await waitFor(snapshot => snapshot.stdout.text.includes('TTY:true') && snapshot.stdout.text.includes('SIZE:90:30'));
  assert.match(initial.stdout.text, /TTY:true/);
  assert.deepEqual(JSON.parse(fs.readFileSync(observationFile, 'utf8')), {
    args: literalArgs, cwd: repo, sentinel, stdinTty: true, stdoutTty: true
  }, 'the managed PTY target sees exact arguments, environment, cwd, and terminal handles');

  const resized = await writeManagedProcess(config, {
    processId,
    input: 'hello-pty\r',
    columns: 100,
    rows: 40
  }, context);
  assert.equal(resized.acceptedBytes, 10);
  assert.equal(resized.resized, true);
  assert.equal(resized.columns, 100);
  assert.equal(resized.rows, 40);

  const echoed = await waitFor(snapshot => snapshot.stdout.text.includes('ECHO:hello-pty') && snapshot.stdout.text.includes('SIZE:100:40'));
  assert.match(echoed.stdout.text, /ECHO:hello-pty/);
  assert.match(echoed.stdout.text, /SIZE:100:40/, 'the target itself observes the resized terminal');
  assert.equal(echoed.pty, true);
  assert.equal(echoed.columns, 100);
  assert.equal(echoed.rows, 40);

  const stopped = await stopManagedProcess(config, { processId, graceMs: 500 }, context);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pty, true);
  assertNativeCleanup(stopped);
  processId = '';

  const interruptible = await startTarget('Verify Ctrl+C reaches the managed PTY target and completes its native job.');
  processId = interruptible.processId;
  assertSelectedCompanion();
  await waitFor(snapshot => snapshot.stdout.text.includes('TTY:true') && snapshot.stdout.text.includes('SIZE:90:30'));
  const interrupted = await writeManagedProcess(config, { processId, input: '\x03' }, context);
  assert.equal(interrupted.acceptedBytes, 1);
  const exited = await waitFor(snapshot => snapshot.stdout.text.includes('TARGET_SIGINT')
    && snapshot.status === 'failed' && snapshot.exitCode === 31, 10000);
  assert.equal(exited.rootExitConfirmed, true);
  assertNativeCleanup(exited, 31);
  const repeatedStop = await stopManagedProcess(config, { processId, graceMs: 0 }, context);
  assert.equal(repeatedStop.duplicate, true, 'terminal Ctrl+C completion remains confirmed on repeated stop');
  assert.equal(repeatedStop.exitCode, 31);
  assertNativeCleanup(repeatedStop, 31);
  processId = '';

  await assert.rejects(
    () => startManagedProcess(workspace, config, {
      executable: process.execPath,
      argv: [script],
      kind: 'service',
      purpose: 'Invalid PTY mode.',
      pty: true
    }, context),
    /only available for kind: interactive/i
  );

  if (process.platform === 'win32') {
    const systemCmd = fs.realpathSync(path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe'));
    // Probe actual shell behavior. Windows may render startup banners, prompts,
    // cursor controls and 8.3 paths differently without breaking the PTY.
    const waitForCmdReady = async () => {
      const token = `RELAI_CMD_READY_${processId}`;
      const input = `echo ${token}\r`;
      const written = await writeManagedProcess(config, { processId, input }, context);
      assert.equal(written.acceptedBytes, Buffer.byteLength(input));
      return waitFor(snapshot => snapshot.status === 'running' && snapshot.pty === true
        && snapshot.columns === 80 && snapshot.stdout?.text?.includes(token));
    };
    const previousIdleTimeout = process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS;
    process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS = '1000';
    const baseline = hostResourceStats();
    try {
      const idleShell = await startManagedProcess(workspace, config, {
        executable: systemCmd,
        argv: ['/D', '/Q'],
        kind: 'interactive',
        purpose: 'Verify disposable task shell prompts retire automatically.',
        lifecycle: 'task',
        pty: true, columns: 80,
        startupWaitMs: 100
      }, { ...context, requestTaskContext: { taskId: context.taskId, session: { workspace: workspace.alias } } });
      processId = idleShell.processId;
      // Do not send input to the idle-shell fixture: input changes its idle lifecycle.
      await waitFor(snapshot => snapshot.status === 'running' && snapshot.pty === true
        && snapshot.columns === 80 && snapshot.stdout?.text?.includes('>'));
      const retired = await waitFor(snapshot => snapshot.status === 'stopped', 6000);
      assert.equal(retired.status, 'stopped', 'a disposable task cmd prompt retires after the configured grace period');
      assert.equal(retired.terminationConfirmed, true);
      assert.equal(hostResourceStats().persistent.active, baseline.persistent.active, 'retired task shells return retained-process capacity');
      processId = '';

      for (const lifecycle of [undefined, 'persistent']) {
        const persistedValue = lifecycle || 'default';
        const persistentShell = await startManagedProcess(workspace, config, {
          executable: systemCmd, argv: ['/D', '/Q'],
          kind: 'interactive', purpose: `Preserve ${persistedValue} persistent shell state.`,
          ...(lifecycle ? { lifecycle } : {}), pty: true, columns: 80, startupWaitMs: 100
        }, context);
        processId = persistentShell.processId;
        await waitForCmdReady();
        await writeManagedProcess(config, { processId, input: `set RELAI_PTY_STATE=${persistedValue}\r` }, context);
        await new Promise(resolve => setTimeout(resolve, 1300));
        const idle = readManagedProcess(config, { processId }, context);
        assert.equal(idle.status, 'running', `${persistedValue} persistence must survive the idle threshold`);
        assert.equal(hostResourceStats().heavy.active, baseline.heavy.active, 'idle persistent shells hold no active-work/startup token');
        assert.equal(hostResourceStats().persistent.active, baseline.persistent.active + 1, 'live persistent shells remain counted in the bounded retained-process quota');
        await writeManagedProcess(config, { processId, input: 'echo PERSISTED:%RELAI_PTY_STATE%\r' }, context);
        await waitFor(snapshot => snapshot.stdout.text.includes(`PERSISTED:${persistedValue}`));
        const stoppedPersistent = await stopManagedProcess(config, { processId, graceMs: 500 }, context);
        assert.equal(stoppedPersistent.status, 'stopped');
        assert.equal(stoppedPersistent.terminationConfirmed, true);
        assert.equal(hostResourceStats().persistent.active, baseline.persistent.active);
        processId = '';
      }
    } finally {
      if (previousIdleTimeout === undefined) delete process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS;
      else process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS = previousIdleTimeout;
    }
  }

  console.log('Managed PTY verified companion selection, exact target arguments/environment, observed input/resize, Ctrl+C, terminal/native cleanup, idle retirement, and persistent quota tests passed.');
} finally {
  if (processId) await stopManagedProcess(config, { processId, graceMs: 0 }, context).catch(() => {});
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = readManagedProcess(config, { processId, maxBytes: 65536 }, context);
    if (predicate(snapshot)) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for PTY process output: ${JSON.stringify(snapshot)}`);
}
