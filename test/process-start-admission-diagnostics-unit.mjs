import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installDeterministicHostMemory } from './helpers/deterministic-host-memory.mjs';
import { acquireHostResource, hostResourceStats } from '../src/hostResourceScheduler.js';
import { listManagedProcesses, startManagedProcess } from '../src/processManager.js';

const restoreMemory = installDeterministicHostMemory();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-start-admission-diagnostics-'));
const config = { stateDir: path.join(root, 'state') };
const workspace = { alias: 'fixture', path: root };
const leases = [];
const args = { executable: process.execPath, argv: ['-e', 'setInterval(() => {}, 1000)'], kind: 'service', purpose: 'Admission diagnostic fixture.', reuseExisting: false };
try {
  const limit = hostResourceStats().heavy.limit;
  for (let index = 0; index < limit; index += 1) leases.push(await acquireHostResource('heavy', 'diagnostic-fixture'));
  assert.equal(hostResourceStats().persistent.active, 0);
  await assert.rejects(() => startManagedProcess(workspace, config, args, { coordinationTimeoutMs: 30 }),
    error => {
      assert.equal(error.code, 'PROCESS_START_COORDINATION_TIMEOUT', 'internal admission expiry is not a user cancellation');
      assert.equal(error.blockedResource, 'heavy');
      assert.match(error.message, /Heavy-work capacity is full/);
      assert.doesNotMatch(error.message, /Persistent process capacity remained full|Stop a persistent process/);
      return true;
    });
  const abort = new AbortController();
  const pending = startManagedProcess(workspace, config, args, { signal: abort.signal, coordinationTimeoutMs: 1000 });
  const timer = setTimeout(() => abort.abort(new Error('Fixture caller cancellation.')), 20);
  try { await assert.rejects(pending, error => error.code === 'TASK_CANCELLED'); }
  finally { clearTimeout(timer); }
  assert.equal(listManagedProcesses(config).count, 0, 'blocked starts must not launch children');
  console.log('Managed startup diagnostics distinguish heavy saturation, internal timeout, and genuine caller cancellation.');
} finally {
  for (const lease of leases) lease.release();
  restoreMemory();
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
