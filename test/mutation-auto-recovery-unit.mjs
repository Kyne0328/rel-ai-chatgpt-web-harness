import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runWithMutationProcessOwnership, recordCurrentMutationProcess, listMutationProcessRecords, workspaceMutationSafetySummary } from '../src/mutationProcessOwnership.js';
import { assertNoRecoveredMutationProcess } from '../src/tools/execution.js';
import { recoverMutationRecordsAtStartup } from '../src/mutationAutoRecovery.js';
import { currentMutationBootIdentity } from '../src/mutationBootIdentity.js';

const fixtureParent = process.platform === 'win32' ? os.homedir() : os.tmpdir();
const root = fs.mkdtempSync(path.join(fixtureParent, 'relai-auto-mutation-recovery-'));
const native = await currentMutationBootIdentity();
const base = native || { platform: 'linux', host: 'host-fixture', boot: 'boot-one' };
const next = { ...base, boot: 'new-kernel-boot-fixture' };
let counter = 0;
function scenario() {
  const id = ++counter;
  const folder = path.join(root, 'workspace-' + id);
  fs.mkdirSync(folder, { recursive: true });
  const config = { stateDir: path.join(root, 'state-' + id), workspaces: { alpha: { path: folder } } };
  const file = runWithMutationProcessOwnership(config, 'alpha', () => recordCurrentMutationProcess(400000 + id), folder);
  return { config, file, folder };
}
try {
  // The same boot and a missing original PID must NEVER unlock.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    assert.ok(fs.existsSync(file));
    const cp = path.join(config.stateDir, 'mutation-auto-recovery');
    assert.equal(fs.existsSync(cp), true, 'uncertain same-boot record receives future recovery evidence');
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 1);
    assert.deepEqual(listMutationProcessRecords(config, 'alpha', config.workspaces.alpha.path), []);
  }
  // A new-format record containing original boot identity recovers without a checkpoint.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 1);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 0);
  }
  // Legacy records must collect a checkpoint on this boot and only recover on a later boot.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: base })).released, 0);
    assert.ok(fs.existsSync(file));
    assert.equal((await recoverMutationRecordsAtStartup(config, { bootIdentity: next })).released, 1);
    assert.equal(fs.existsSync(file), false);
    // A finished checkpoint must never poison a subsequent independent crash.
    const fresh = runWithMutationProcessOwnership(config, 'alpha',
      () => recordCurrentMutationProcess(499996), config.workspaces.alpha.path);
    const future = (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    assert.equal(future.pending, 1);
    assert.ok(fs.existsSync(fresh));
  }
  // Tampering after checkpoint must preserve the lock.
  {
    const { config, file } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    fs.appendFileSync(file, ' ');
    const outcome = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(outcome.released, 0);
    assert.equal(outcome.errors.length, 1);
    assert.ok(fs.existsSync(file));
  }
  // A missing record is not safe merely because the active directory is empty.
  {
    const { config, file, folder } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    fs.rmSync(file);
    const failed = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(failed.released, 0);
    assert.equal(failed.errors.length, 1);
    assert.equal(workspaceMutationSafetySummary(config, 'alpha', folder)?.code,
      'WORKSPACE_MUTATION_RECOVERY_STATE_INVALID');
    assert.throws(() => assertNoRecoveredMutationProcess(config, 'alpha', folder),
      error => error.code === 'WORKSPACE_MUTATION_RECOVERY_STATE_INVALID');
  }
  // New writers after checkpoint preparation invalidate the prior inventory.
  {
    const { config, file, folder } = scenario();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete record.bootIdentity;
    fs.writeFileSync(file, JSON.stringify(record));
    (await recoverMutationRecordsAtStartup(config, { bootIdentity: base }));
    const another = runWithMutationProcessOwnership(config, 'alpha',
      () => recordCurrentMutationProcess(499997), folder);
    const failed = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(failed.released, 0);
    assert.ok(fs.existsSync(file));
    assert.ok(fs.existsSync(another));
  }
  // Windows recovery requires a full native-zero Job Object receipt.
  if (process.platform === 'win32') {
    for (const complete of [false, true]) {
      const { config, file } = scenario();
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete record.bootIdentity;
      const job = path.join(config.stateDir, 'process-jobs', 'job-synthetic');
      fs.mkdirSync(job, { recursive: true });
      const nonce = 'a'.repeat(64);
      record.nativeJob = { directory: job, nonce };
      fs.writeFileSync(file, JSON.stringify(record));
      fs.writeFileSync(path.join(job, 'request.json'), JSON.stringify({ protocol: 1, nonce }));
      fs.writeFileSync(path.join(job, 'receipt.json'), JSON.stringify({
        protocol: 1, nonce, helperPid: record.pid, final: true,
        jobComplete: true, cleanupConfirmed: complete, activeProcesses: 0,
        commandStarted: true, rootExited: true
      }));
      const outcome = (await recoverMutationRecordsAtStartup(config, { bootIdentity: null }));
      assert.equal(outcome.released, complete ? 1 : 0);
      assert.equal(fs.existsSync(file), !complete);
    }
  }
  // An unbound legacy record prevents automatic restoration.
  {
    const { config, file } = scenario();
    const legacy = path.join(config.stateDir, 'active-mutations', 'foreign');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'legacy.json'), JSON.stringify({
      schemaVersion: 2, workspace: 'alpha', runtimeId: 'unbound',
      pid: 1234, phase: 'active', terminationUncertain: true
    }));
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...record, bootIdentity: base }));
    const outcome = (await recoverMutationRecordsAtStartup(config, { bootIdentity: next }));
    assert.equal(outcome.released, 0);
    assert.ok(fs.existsSync(file));
  }
  console.log('Automatic mutation restart and reboot recovery gates passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
