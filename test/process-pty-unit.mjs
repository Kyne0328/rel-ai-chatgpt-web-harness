import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readManagedProcess, startManagedProcess, stopManagedProcess, writeManagedProcess } from '../src/processManager.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-process-pty-'));
const repo = path.join(root, 'repo');
const config = { stateDir: path.join(root, 'state') };
const workspace = { alias: 'app', path: repo };
const context = { taskId: 'pty-work', principal: { clientId: 'pty-client', authMode: 'oauth' }, workspace: 'app' };
fs.mkdirSync(repo, { recursive: true });
const script = path.join(repo, 'pty-child.cjs');
fs.writeFileSync(script, `
process.stdout.write('TTY:' + Boolean(process.stdout.isTTY) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => process.stdout.write('ECHO:' + value));
setInterval(() => {}, 1000);
`, 'utf8');

let processId = '';
try {
  const started = await startManagedProcess(workspace, config, {
    executable: process.execPath,
    argv: [script],
    kind: 'interactive',
    purpose: 'Exercise pseudo-terminal input and resize behavior.',
    pty: true,
    columns: 90,
    rows: 30,
    startupWaitMs: 100
  }, context);
  processId = started.processId;
  assert.equal(started.pty, true);
  assert.equal(started.columns, 90);
  assert.equal(started.rows, 30);
  assert.equal(started.status, 'running');

  const initial = await waitFor(snapshot => snapshot.stdout.text.includes('TTY:true'));
  assert.match(initial.stdout.text, /TTY:true/);

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

  const echoed = await waitFor(snapshot => snapshot.stdout.text.includes('ECHO:hello-pty'));
  assert.match(echoed.stdout.text, /ECHO:hello-pty/);
  assert.equal(echoed.pty, true);
  assert.equal(echoed.columns, 100);
  assert.equal(echoed.rows, 40);

  const stopped = await stopManagedProcess(config, { processId, graceMs: 500 }, context);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.pty, true);
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
    const previousIdleTimeout = process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS;
    process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS = '1000';
    try {
      const idleShell = await startManagedProcess(workspace, config, {
        executable: process.env.ComSpec || 'cmd.exe',
        argv: ['/Q'],
        kind: 'interactive',
        purpose: 'Verify idle shell prompts retire automatically.',
        pty: true,
        startupWaitMs: 100
      }, context);
      processId = idleShell.processId;
      await waitFor(snapshot => /[A-Za-z]:\\[^\r\n>]*>/.test(snapshot.stdout.text), 5000);
      const retired = await waitFor(snapshot => snapshot.status === 'stopped', 6000);
      assert.equal(retired.status, 'stopped', 'an idle cmd prompt must retire after the configured grace period');
      processId = '';
    } finally {
      if (previousIdleTimeout === undefined) delete process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS;
      else process.env.REL_AI_MCP_INTERACTIVE_PTY_IDLE_RETIRE_MS = previousIdleTimeout;
    }
  }

  console.log('Managed PTY allocation, input, resize, idle retirement, metadata, and stop tests passed.');
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
