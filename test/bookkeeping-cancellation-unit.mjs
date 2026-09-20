import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiExec } from '../src/bridge/exec.js';
import { createValidationFingerprint } from '../src/bridge/validationPlan.js';
import { workspaceDirtyPaths } from '../src/repo/gitOps.js';
import {
  ensureTaskBaseline,
  readTaskIntegrity,
  recordTaskIntegrityEvent
} from '../src/taskIntegrity.ts';
import { runWorkspaceOperation } from '../src/workspaceOperationQueue.js';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-bookkeeping-cancel-'));
const gitWorkspace = path.join(root, 'git-workspace');
const plainWorkspace = path.join(root, 'plain-workspace');
const stateDir = path.join(root, 'state');
fs.mkdirSync(gitWorkspace, { recursive: true });
fs.mkdirSync(plainWorkspace, { recursive: true });
fs.writeFileSync(path.join(gitWorkspace, 'tracked.txt'), 'initial\n');
fs.writeFileSync(path.join(plainWorkspace, 'existing.txt'), 'plain\n');

const git = args => execFileSync(GIT_EXECUTABLE, args, { cwd: gitWorkspace, stdio: 'ignore' });
git(['init']);
git(['config', 'user.email', 'relai@example.test']);
git(['config', 'user.name', 'RelAI Test']);
git(['add', '.']);
git(['commit', '-m', 'fixture']);

const config = {
  stateDir,
  workspaces: {
    app: { path: gitWorkspace, commands: {}, testCommands: {} },
    plain: { path: plainWorkspace, commands: {}, testCommands: {} }
  }
};
const app = { alias: 'app', path: gitWorkspace, commands: {}, testCommands: {} };
const plain = { alias: 'plain', path: plainWorkspace, commands: {}, testCommands: {} };

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

try {
  // Cancellation during the non-Git pre-exec filesystem snapshot must prevent the
  // command from starting and must release the mutation lane.
  {
    const controller = new AbortController();
    const scanStarted = deferred();
    const releaseScan = deferred();
    const originalReaddir = fs.promises.readdir;
    let intercepted = false;
    fs.promises.readdir = async function (target, options) {
      if (!intercepted && path.resolve(String(target)) === path.resolve(plainWorkspace)) {
        intercepted = true;
        scanStarted.resolve();
        await releaseScan.promise;
      }
      return originalReaddir.call(this, target, options);
    };
    try {
      const operation = runWorkspaceOperation('plain', () => relaiExec(plain, config, {
        executable: process.execPath,
        argv: ['-e', "require('node:fs').writeFileSync('should-not-run.txt','ran')"]
      }, { signal: controller.signal }), {
        mode: 'write',
        scope: 'mutation',
        taskId: 'pre-scan-cancel'
      });
      await scanStarted.promise;
      controller.abort(new Error('cancel mutation accounting'));
      releaseScan.resolve();
      const cancelled = await operation;
      assert.equal(cancelled.executed, false, 'pre-command accounting cancellation must not start the requested command');
      assert.equal(cancelled.commandSucceeded, false);
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.mutationUnknown, true);
      assert.match(cancelled.error || '', /cancel mutation accounting/);
      assert.equal(fs.existsSync(path.join(plainWorkspace, 'should-not-run.txt')), false);
    } finally {
      fs.promises.readdir = originalReaddir;
    }

    const released = await runWorkspaceOperation('plain', async () => 'released', {
      mode: 'write',
      scope: 'mutation',
      taskId: 'after-pre-scan-cancel'
    });
    assert.equal(released, 'released', 'pre-command bookkeeping cancellation must release the mutation lane');
  }

  // If cancellation arrives after the command has already completed, post-command
  // bookkeeping must stop promptly, preserve the real command outcome, and mark
  // mutation attribution as unknown rather than holding the lane.
  {
    const controller = new AbortController();
    const originalReaddir = fs.promises.readdir;
    let rootReads = 0;
    fs.promises.readdir = async function (target, options) {
      const entries = await originalReaddir.call(this, target, options);
      if (path.resolve(String(target)) === path.resolve(plainWorkspace)) {
        rootReads += 1;
        if (rootReads === 2) controller.abort(new Error('cancel post mutation accounting'));
      }
      return entries;
    };
    let result;
    try {
      result = await runWorkspaceOperation('plain', () => relaiExec(plain, config, {
        executable: process.execPath,
        argv: ['-e', "require('node:fs').writeFileSync('post-command.txt','ran')"]
      }, { signal: controller.signal }), {
        mode: 'write',
        scope: 'mutation',
        taskId: 'post-scan-cancel'
      });
    } finally {
      fs.promises.readdir = originalReaddir;
    }
    assert.equal(result.commandSucceeded, true);
    assert.equal(result.mutationUnknown, true, 'cancelled post-command accounting must report conservative unknown mutation attribution');
    assert.deepEqual(result.changedFiles, []);
    assert.equal(fs.existsSync(path.join(plainWorkspace, 'post-command.txt')), true);

    const released = await runWorkspaceOperation('plain', async () => 'released', {
      mode: 'write',
      scope: 'mutation',
      taskId: 'after-post-scan-cancel'
    });
    assert.equal(released, 'released', 'post-command bookkeeping cancellation must release the mutation lane');
  }

  // Deferred task-baseline capture must honor cancellation before running Git.
  {
    const taskId = 'cancelled-baseline';
    await recordTaskIntegrityEvent(config, {
      taskId,
      workspace: 'app',
      taskIdentityVersion: 2,
      taskHistoryEligible: true,
      tool: 'work.begin',
      deferBaseline: true,
      ok: true,
      ts: new Date().toISOString()
    });
    const controller = new AbortController();
    controller.abort(new Error('cancel baseline bookkeeping'));
    await assert.rejects(
      runWorkspaceOperation('app', () => ensureTaskBaseline(config, taskId, 'app', {
        signal: controller.signal
      }), {
        mode: 'write',
        scope: 'mutation',
        taskId
      }),
      /cancel baseline bookkeeping/
    );
    assert.equal(readTaskIntegrity(config, taskId, 'app')?.baseline?.pending, true);
    const released = await runWorkspaceOperation('app', async () => 'released', {
      mode: 'write',
      scope: 'mutation',
      taskId: 'after-baseline-cancel'
    });
    assert.equal(released, 'released');
  }

  // Validation fingerprints and completion residual-state checks share the same
  // cancellation contract, so neither can hold an admitted mutation boundary after
  // the task has been cancelled.
  {
    const fingerprintAbort = new AbortController();
    fingerprintAbort.abort(new Error('cancel validation fingerprint'));
    await assert.rejects(
      runWorkspaceOperation('app', () => createValidationFingerprint(app, config, {
        paths: ['tracked.txt'],
        signal: fingerprintAbort.signal
      }), {
        mode: 'write',
        scope: 'mutation',
        taskId: 'fingerprint-cancel'
      }),
      /cancel validation fingerprint/
    );

    const dirtyAbort = new AbortController();
    dirtyAbort.abort(new Error('cancel residual bookkeeping'));
    await assert.rejects(
      runWorkspaceOperation('app', () => workspaceDirtyPaths(app, config, ['tracked.txt'], {
        signal: dirtyAbort.signal
      }), {
        mode: 'write',
        scope: 'mutation',
        taskId: 'residual-cancel'
      }),
      /cancel residual bookkeeping/
    );

    const released = await runWorkspaceOperation('app', async () => 'released', {
      mode: 'write',
      scope: 'mutation',
      taskId: 'after-validation-cancel'
    });
    assert.equal(released, 'released');
  }

  // Fingerprinting large changed artifacts must stream asynchronously and remain
  // cancellable instead of synchronously reading the whole file into memory.
  {
    const largePath = path.join(gitWorkspace, 'large-fingerprint.bin');
    fs.writeFileSync(largePath, Buffer.alloc(1));
    fs.truncateSync(largePath, 128 * 1024 * 1024);
    const controller = new AbortController();
    const cancellation = setTimeout(() => controller.abort(new Error('cancel streaming fingerprint')), 10);
    try {
      await assert.rejects(
        createValidationFingerprint(app, config, {
          paths: ['large-fingerprint.bin'],
          status: { changedFiles: ['large-fingerprint.bin'], branch: 'main', unborn: false },
          signal: controller.signal
        }),
        error => controller.signal.aborted
          && (error === controller.signal.reason || /abort|cancel streaming fingerprint/i.test(String(error?.message || error)))
      );
    } finally {
      clearTimeout(cancellation);
      fs.rmSync(largePath, { force: true });
    }
  }

  const executionSource = fs.readFileSync(new URL('../src/tools/execution.js', import.meta.url), 'utf8');
  const completionSource = fs.readFileSync(new URL('../src/tools/completion.js', import.meta.url), 'utf8');
  const validationSource = fs.readFileSync(new URL('../src/bridge/validation.js', import.meta.url), 'utf8');
  assert.match(executionSource, /ensureTaskBaseline\(config, taskId, workspace\.alias, \{ signal: watchdog\.signal \}\)/);
  assert.match(completionSource, /workspaceDirtyPaths\(workspace, config, changedFiles, \{ signal: options\.signal \}\)/);
  assert.match(validationSource, /createValidationFingerprint\(workspace, config, \{ paths: fingerprintScope, signal \}\)/);

  console.log('Repository bookkeeping cancellation releases mutation lanes and stops follow-up scans.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
