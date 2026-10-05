import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';
import { principalFingerprint } from '../src/mcp/principal.ts';
import { activeProcessesForWorkSession, readManagedProcess, sampleManagedProcessMemory, startManagedProcess, stopManagedProcess } from '../src/processManager.js';

const restoreMemory = installDeterministicHostMemory();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-root-memory-'));
const config = { stateDir: path.join(root, 'state') };
const workspace = { alias: 'app', path: path.join(root, 'workspace') };
const context = { taskId: 'root-memory-fixture', principal: 'owner-a', workspace: 'app' };
fs.mkdirSync(workspace.path);
let managed;
let restoreProbe = () => {};
const previousSecret = process.env.RELAI_ROOT_SAMPLE_SECRET;
const previousModulePath = process.env.PSModulePath;
const realNow = Date.now;
let clockOffset = 0;
const advanceSampleWindow = () => { clockOffset += 6000; };
try {
  managed = await startManagedProcess(workspace, config, {
    executable: process.execPath, argv: ['-e', 'const RAW_COMMAND_SENTINEL = true; setInterval(() => {}, 1000)'],
    kind: 'service', purpose: 'RAW_PURPOSE_SENTINEL', label: 'Explicit safe fixture label', startupWaitMs: 20
  }, context);
  const metadata = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'processes', managed.processId, 'metadata.json'), 'utf8'));
  process.env.RELAI_ROOT_SAMPLE_SECRET = 'fixture-only-sensitive-value';
  process.env.PSModulePath = 'fixture-untrusted-module-path';
  if (process.platform === 'win32') {
    const native = await sampleManagedProcessMemory(config, { workspace: 'app' }, context);
    assert.equal(native.sampledRootCount, 1, 'the actual bounded Windows probe must measure the disposable owned fixture');
    assert.equal(native.roots[0].processId, managed.processId);
    assert.ok(Number.isSafeInteger(native.roots[0].privateBytes));
    assert.ok(Number.isSafeInteger(native.roots[0].workingSetBytes));
    assert.ok(native.roots[0].sampledAt);
  }
  const fixture = (suffix, fields = {}, targetConfig = config) => {
    const processId = 'proc_' + suffix.padEnd(24, '_');
    const directory = path.join(targetConfig.stateDir, 'processes', processId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'stdout.log'), '');
    fs.writeFileSync(path.join(directory, 'stderr.log'), '');
    const data = {
      ...metadata, processId, runtimeId: 'previous-runtime',
      label: 'RAW_COMMAND_FALLBACK_SENTINEL', diagnosticLabel: '',
      ...fields
    };
    fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(data));
    readManagedProcess(targetConfig, { processId }, { internal: true });
    return processId;
  };
  const legacyId = fixture('legacy');
  const foreignId = fixture('foreign', {
    principalKey: principalFingerprint('owner-b'), pid: process.pid,
    processCreationIdentity: 'win32:638999999999999999'
  });
  fixture('otherworkspace', { workspaceId: 'other', workspacePath: path.join(root, 'other'), pid: process.pid });

  await assert.rejects(() => sampleManagedProcessMemory(config), error => error.code === 'PROCESS_ACCESS_DENIED');
  await assert.rejects(() => sampleManagedProcessMemory(config, { workspace: 'other' }, context),
    error => error.code === 'PROCESS_WORKSPACE_MISMATCH');

  if (process.platform !== 'win32') {
    const unsupported = await sampleManagedProcessMemory(config, { workspace: 'app' }, context);
    assert.equal(unsupported.sampledRootCount, 0);
    assert.ok(unsupported.roots.every(item => item.privateBytes === null && item.workingSetBytes === null));
    assert.equal(unsupported.descendantAttribution, 'unknown');
    console.log('Managed-root diagnostic authorization and unsupported-platform unknown states passed.');
  } else {
    const originalExecFile = childProcess.execFile;
    let probes = 0;
    let reply;
    let probeError = null;
    let duringProbe = null;
    childProcess.execFile = function (executable, args, options, callback) {
      if (!Array.isArray(args) || !args.some(value => String(value).includes('RelAiManagedRootMemoryV1'))) {
        return originalExecFile.call(this, executable, args, options, callback);
      }
      probes += 1;
      const script = args.at(-1);
      assert.match(script, new RegExp('\\$targets = @\\(' + managed.pid + '\\)'));
      assert.doesNotMatch(script, /CommandLine|RAW_COMMAND|RAW_PURPOSE|Get-CimInstance|Win32_Process/);
      assert.equal(options.timeout, 2000);
      assert.equal(options.maxBuffer, 32768);
      assert.equal(Object.hasOwn(options.env, 'RELAI_ROOT_SAMPLE_SECRET'), false);
      assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
      assert.equal(options.env.PSModulePath, path.join(path.dirname(executable), 'Modules'));
      assert.notEqual(options.env.PSModulePath, process.env.PSModulePath);
      assert.match(script, /-notcontains \$beforeIdentity/);
      queueMicrotask(() => {
        duringProbe?.();
        callback(probeError, JSON.stringify(reply), '');
      });
      return { kill() { return true; } };
    };
    syncBuiltinESMExports();
    restoreProbe = () => { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); };
    Date.now = () => realNow() + clockOffset;
    advanceSampleWindow();
    const measuredRow = () => ({
      pid: managed.pid, beforeIdentity: metadata.processCreationIdentity, afterIdentity: metadata.processCreationIdentity,
      privateBytes: 123456, workingSetBytes: 234567, sampledAt: new Date().toISOString()
    });
    reply = [measuredRow()];
    const [first, joined] = await Promise.all([
      sampleManagedProcessMemory(config, { workspace: 'app' }, context),
      sampleManagedProcessMemory(config, { workspace: 'app' }, context)
    ]);
    assert.equal(probes, 1, 'concurrent diagnostics must share one bounded probe');
    assert.equal(first.roots.length, 2, 'only authorized same-workspace roots enter the sample');
    assert.equal(first.sampledRootCount, 2);
    assert.equal(joined.roots[0].privateBytes, 123456);
    assert.equal(first.roots.find(item => item.processId === managed.processId).label, 'Explicit safe fixture label');
    assert.equal(first.roots.find(item => item.processId === legacyId).label, undefined, 'legacy command-derived labels lack explicit provenance');
    assert.doesNotMatch(JSON.stringify(first), /RAW_COMMAND|RAW_PURPOSE|beforeIdentity|afterIdentity/);
    const cached = await sampleManagedProcessMemory(config, { workspace: 'app' }, context);
    assert.equal(cached.cached, true);
    assert.equal(probes, 1);

    const foreign = await sampleManagedProcessMemory(config, { workspace: 'app' }, { principal: 'owner-b', workspace: 'app' });
    assert.deepEqual(foreign.roots.map(item => item.processId), [foreignId]);
    assert.equal(foreign.roots[0].privateBytes, null, 'another principal must not inherit cached measurements');
    assert.equal(foreign.roots[0].reason, 'sampling_rate_limited');
    const otherConfig = { stateDir: path.join(root, 'other-state') };
    fixture('otherconfig', {}, otherConfig);
    const isolated = await sampleManagedProcessMemory(otherConfig, { workspace: 'app' }, context);
    assert.equal(isolated.roots[0].privateBytes, null, 'state/config namespaces must not share measurement caches');
    assert.equal(probes, 1);

    for (const field of ['beforeIdentity', 'afterIdentity']) {
      advanceSampleWindow();
      reply = [{ ...measuredRow(), [field]: 'win32:' + (BigInt(metadata.processCreationIdentity.slice(6)) + 1n) }];
      const mismatch = await sampleManagedProcessMemory(config, { workspace: 'app' }, context);
      assert.ok(mismatch.roots.every(item => item.reason === 'identity_mismatch' && item.privateBytes === null));
    }
    advanceSampleWindow();
    reply = [{ ...measuredRow(), beforeIdentity: Number(metadata.processCreationIdentity.slice(6)) }];
    assert.ok((await sampleManagedProcessMemory(config, { workspace: 'app' }, context)).roots.every(item => item.reason === 'identity_mismatch'),
      'numeric conversion of DateTime ticks must never be accepted as verified identity');
    advanceSampleWindow();
    reply = [{ ...measuredRow(), privateBytes: null }];
    assert.ok((await sampleManagedProcessMemory(config, { workspace: 'app' }, context)).roots.every(item => item.reason === 'invalid_measurement' && item.privateBytes === null));
    advanceSampleWindow();
    reply = [{ pid: managed.pid, unavailable: true }];
    assert.ok((await sampleManagedProcessMemory(config, { workspace: 'app' }, context)).roots.every(item => item.reason === 'root_unavailable'));
    advanceSampleWindow();
    probeError = Object.assign(new Error('simulated bounded timeout'), { code: 'ETIMEDOUT' });
    assert.ok((await sampleManagedProcessMemory(config, { workspace: 'app' }, context)).roots.every(item => item.reason === 'probe_failed_or_timed_out'));
    probeError = null;

    advanceSampleWindow();
    reply = [measuredRow()];
    const current = activeProcessesForWorkSession(config, 'app', context.taskId).find(item => item.processId === managed.processId);
    assert.ok(current);
    duringProbe = () => { current.processCreationIdentity = 'win32:638111111111111111'; };
    const changed = await sampleManagedProcessMemory(config, { workspace: 'app' }, context);
    current.processCreationIdentity = metadata.processCreationIdentity;
    duringProbe = null;
    assert.equal(changed.roots.find(item => item.processId === managed.processId).reason, 'record_changed_during_sample');
    assert.equal(changed.roots.find(item => item.processId === managed.processId).privateBytes, null);

    for (let index = 0; index < 25; index += 1) fixture('bounded_' + index);
    const bounded = await sampleManagedProcessMemory(config, { workspace: 'app', limit: 1000 }, context);
    assert.equal(bounded.roots.length, 20);
    assert.ok(bounded.omittedRootCount >= 7);
    assert.equal(bounded.descendantAttribution, 'unknown');
    assert.ok(!Object.hasOwn(bounded, 'totalPrivateBytes'), 'partial managed-root samples must not imply a process-family total');
    console.log('Managed-root sampling identity/PID reuse, authorization-before-probe, null/error states, bounded cache isolation, label provenance, and root cap tests passed.');
  }
} finally {
  Date.now = realNow;
  restoreProbe();
  if (previousSecret === undefined) delete process.env.RELAI_ROOT_SAMPLE_SECRET;
  else process.env.RELAI_ROOT_SAMPLE_SECRET = previousSecret;
  if (previousModulePath === undefined) delete process.env.PSModulePath;
  else process.env.PSModulePath = previousModulePath;
  // Only the exact child created by this fixture may be stopped. Synthetic
  // metadata intentionally includes the runner PID and must never be signalled.
  if (managed) await stopManagedProcess(config, { processId: managed.processId, graceMs: 0 }, { internal: true });
  restoreMemory();
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
