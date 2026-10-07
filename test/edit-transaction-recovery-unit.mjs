import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { planEdit } from '../src/executionPlanner.ts';
import { workspaceWrite, readStagedPayload } from '../src/localRepoBridge.ts';
import { executeToolCall } from '../src/tools/execution.js';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { validateToolOutput } from '../src/tools/outputValidation.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { recoverStructuredPatchTransaction } from '../src/structuredPatchTransaction.js';

const originals = { rename: fs.renameSync, rm: fs.rmSync, fetch: globalThis.fetch, open: fs.promises.open, rmAsync: fs.promises.rm };
const thisFile = fileURLToPath(import.meta.url);
function fixture(root) {
  const workspace = { alias: path.basename(root), path: path.join(root, 'repo') };
  fs.mkdirSync(workspace.path, { recursive: true });
  const config = { stateDir: path.join(root, 'state'), workspaces: { [workspace.alias]: { path: workspace.path, commands: {}, testCommands: {} } } };
  const run = async (args, signal) => {
    const effectiveArgs = { workspace: workspace.alias, returnDiff: false, ...args };
    const result = await executeToolCall({
      config, name: OP.EDIT, executionName: OP.EDIT,
      effectiveArgs,
      context: signal ? { signal } : {},
      definition: { behavior: { concurrencyScope: 'mutation' }, handler: (_config, input, context) => planEdit(workspace, config, input, context) },
      started: Date.now()
    });
    const publicResult = serializeConnectorResult({ publicName: 'relai_edit', action: '', operationName: OP.EDIT, value: result.value, args: effectiveArgs });
    await validateToolOutput(config, 'relai_edit', effectiveArgs, publicResult);
    if (result.value.transaction) assert.deepEqual(publicResult.transaction, result.value.transaction, 'public serialization must retain durable commit and cleanup facts');
    if (result.value.cleanupPending !== undefined) assert.equal(publicResult.cleanupPending, result.value.cleanupPending);
    if (result.value.rollback) assert.deepEqual(publicResult.rollback, result.value.rollback, 'public serialization must retain rollback and recovery-pending facts');
    for (const field of ['preflightAtomic', 'rollbackAtomic']) {
      if (result.value[field] !== undefined) assert.equal(publicResult[field], result.value[field], 'public serialization must retain ' + field);
    }
    return result;
  };
  return { workspace, config, run, file: name => path.join(workspace.path, name) };
}
const batch = { edits: [{ path: 'a.txt', content: 'new-a\n' }, { path: 'b.txt', content: 'new-b\n' }] };
function restoreHooks() {
  fs.renameSync = originals.rename;
  fs.rmSync = originals.rm;
  globalThis.fetch = originals.fetch;
  fs.promises.open = originals.open;
  fs.promises.rm = originals.rmAsync;
  syncBuiltinESMExports();
}
if (process.argv[2] === 'recover') {
  const f = fixture(process.argv[3]);
  assert.equal((await f.run({ path: 'fresh-process.txt', content: 'ok' })).value.ok, true);
  console.log(JSON.stringify({ a: fs.readFileSync(f.file('a.txt'), 'utf8') }));
} else if (process.argv[2] === 'crash-batch' || process.argv[2] === 'crash-append') {
  const f = fixture(process.argv[3]);
  const mode = process.argv[2];
  fs.renameSync = function (source, destination, ...args) {
    if (mode === 'crash-append' && String(destination).endsWith(process.argv[4] + '.json')) process.exit(73);
    const result = originals.rename.call(this, source, destination, ...args);
    if (mode === 'crash-batch' && path.resolve(String(destination)) === f.file('a.txt')) process.exit(73);
    return result;
  };
  syncBuiltinESMExports();
  if (mode === 'crash-batch') await f.run(batch);
  else await f.run({ stage: 'append', writeId: process.argv[4], content: 'B' });
  throw new Error('Crash fixture did not reach its barrier.');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-recovery-'));
  let passed = 0;
  async function check(name, fn) {
    const f = fixture(path.join(root, name));
    try { await fn(f); passed += 1; console.log('PASS ' + name); } finally { restoreHooks(); }
  }
  const read = (f, name) => fs.readFileSync(f.file(name), 'utf8');
  const seed = f => { fs.writeFileSync(f.file('a.txt'), 'old-a\n'); fs.writeFileSync(f.file('b.txt'), 'old-b\n'); };
  const marker = f => path.join(f.config.stateDir, 'structured-patch-transactions');
  const runChild = (mode, f, extra = []) => {
    const result = spawnSync(process.execPath, [thisFile, mode, path.dirname(f.workspace.path), ...extra], { env: process.env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 73, result.stderr || result.error?.message);
  };
  try {
    await check('committed-cleanup-failure', async f => {
      fs.writeFileSync(f.file('a.txt'), 'old\n');
      fs.rmSync = function (file, ...args) {
        if (String(file).includes('structured-patch-transactions') && String(file).endsWith('.json')) throw Object.assign(new Error('marker unlink denied'), { code: 'EACCES' });
        return originals.rm.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      const first = await f.run({ updateText: '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch' });
      assert.equal(first.value.ok, true);
      assert.equal(first.value.transaction.committed, true);
      assert.equal(first.value.transaction.cleanupPending, true);
      const record = JSON.parse(fs.readFileSync(path.join(marker(f), fs.readdirSync(marker(f))[0]), 'utf8'));
      assert.equal(record.status, 'committed');
      assert.equal(recoverStructuredPatchTransaction(f.config, f.workspace).committed, true);
      assert.equal(read(f, 'a.txt'), 'new\n');
      restoreHooks();
      const reopened = spawnSync(process.execPath, [thisFile, 'recover', path.dirname(f.workspace.path)], { env: process.env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
      assert.equal(reopened.status, 0, reopened.stderr || reopened.error?.message);
      assert.equal(JSON.parse(reopened.stdout).a, 'new\n');
      assert.equal((await f.run({ path: 'next.txt', content: 'next' })).value.ok, true);
      assert.equal(read(f, 'a.txt'), 'new\n');
    });
    await check('commit-persistence-failure', async f => {
      fs.writeFileSync(f.file('a.txt'), 'old\n');
      let injected = false;
      fs.renameSync = function (source, destination, ...args) {
        if (!injected && String(destination).includes('structured-patch-transactions') && String(destination).endsWith('.json')
          && JSON.parse(fs.readFileSync(source, 'utf8')).status === 'committed') {
          injected = true;
          throw new Error('commit persistence denied');
        }
        return originals.rename.call(this, source, destination, ...args);
      };
      syncBuiltinESMExports();
      const result = await f.run({ updateText: '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch' });
      assert.equal(injected, true);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.rollback.ok, true);
      assert.equal(read(f, 'a.txt'), 'old\n');
    });
    await check('empty-file-forms', async f => {
      const preview = await f.run({ path: 'dry.txt', content: '', dryRun: true });
      assert.equal(preview.value.result.changed, true);
      assert.equal(fs.existsSync(f.file('dry.txt')), false);
      const direct = await f.run({ path: 'empty.txt', content: '' });
      assert.deepEqual(direct.value.changedFiles, ['empty.txt']);
      assert.equal(fs.statSync(f.file('empty.txt')).size, 0);
      assert.deepEqual((await f.run({ path: 'empty.txt', content: '' })).value.changedFiles, []);
      const start = await f.run({ stage: 'start', path: 'staged.txt', content: '' });
      const commit = await f.run({ stage: 'commit', writeId: start.value.writeId });
      assert.deepEqual(commit.value.changedFiles, ['staged.txt']);
      assert.equal(fs.statSync(f.file('staged.txt')).size, 0);
      assert.equal((await f.run({ edits: [{ path: 'batch.txt', content: '' }] })).value.ok, true);
      assert.equal(fs.statSync(f.file('batch.txt')).size, 0);
    });
    await check('artifact-concurrent-destination', async f => {
      const content = Buffer.from('legitimate concurrent file');
      globalThis.fetch = async () => { fs.writeFileSync(f.file('import.bin'), content); return new Response(new Uint8Array([1, 2, 3])); };
      await assert.rejects(() => f.run({ path: 'import.bin', file: { download_url: 'https://files.oaiusercontent.com/fixture', file_id: 'fixture', size: 3 } }), /EEXIST/);
      assert.deepEqual(fs.readFileSync(f.file('import.bin')), content);
      assert.deepEqual(fs.readdirSync(f.workspace.path), ['import.bin']);
    });
    await check('artifact-open-failure', async f => {
      globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
      fs.promises.open = async function (file, ...args) {
        if (String(file).includes('.relai-import-')) { fs.writeFileSync(f.file('import.bin'), 'external'); throw Object.assign(new Error('stage denied'), { code: 'EACCES' }); }
        return originals.open.call(this, file, ...args);
      };
      await assert.rejects(() => f.run({ path: 'import.bin', file: { download_url: 'https://files.oaiusercontent.com/fixture', file_id: 'fixture' } }), /stage denied/);
      assert.equal(read(f, 'import.bin'), 'external');
    });
    await check('cancel-between-edits', async f => {
      seed(f);
      const controller = new AbortController();
      let injected = false;
      fs.renameSync = function (source, destination, ...args) {
        const result = originals.rename.call(this, source, destination, ...args);
        if (!injected && path.resolve(String(destination)) === f.file('a.txt')) { injected = true; controller.abort(new Error('cancel after first promotion')); }
        return result;
      };
      syncBuiltinESMExports();
      const result = await f.run(batch, controller.signal);
      assert.equal(injected, true);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.rollback.ok, true);
      assert.equal(read(f, 'a.txt'), 'old-a\n');
      assert.equal(read(f, 'b.txt'), 'old-b\n');
      restoreHooks();
      assert.equal((await f.run({ path: 'next.txt', content: 'ok' })).value.ok, true);
      assert.equal(read(f, 'a.txt'), 'old-a\n');
    });
    await check('exception-after-promotion', async f => {
      seed(f);
      let injected = false;
      fs.renameSync = function (source, destination, ...args) {
        const result = originals.rename.call(this, source, destination, ...args);
        if (!injected && path.resolve(String(destination)) === f.file('a.txt')) { injected = true; throw new Error('post-promotion failure'); }
        return result;
      };
      syncBuiltinESMExports();
      const result = await f.run(batch);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.rollback.ok, true);
      assert.equal(read(f, 'a.txt'), 'old-a\n');
      assert.equal(read(f, 'b.txt'), 'old-b\n');
    });
    await check('external-write-conflict', async f => {
      seed(f);
      const controller = new AbortController();
      let injected = false;
      fs.renameSync = function (source, destination, ...args) {
        const result = originals.rename.call(this, source, destination, ...args);
        if (!injected && path.resolve(String(destination)) === f.file('a.txt')) {
          injected = true;
          fs.writeFileSync(f.file('a.txt'), 'external\n');
          controller.abort(new Error('cancel with external write'));
        }
        return result;
      };
      syncBuiltinESMExports();
      const result = await f.run(batch, controller.signal);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.rollback.ok, false);
      assert.equal(result.value.rollback.recoveryPending, true);
      assert.equal(read(f, 'a.txt'), 'external\n');
      assert.equal(fs.readdirSync(marker(f)).length, 1);
      restoreHooks();
      await assert.rejects(() => f.run({ path: 'next.txt', content: 'must not run' }), /changed after the interrupted patch/);
      assert.equal(fs.existsSync(f.file('next.txt')), false);
      assert.equal(read(f, 'a.txt'), 'external\n');
    });
    await check('abrupt-exit-reopen', async f => {
      seed(f);
      runChild('crash-batch', f);
      assert.equal(read(f, 'a.txt'), 'new-a\n');
      assert.equal(read(f, 'b.txt'), 'old-b\n');
      assert.equal(fs.readdirSync(marker(f)).length, 1);
      assert.equal((await f.run({ path: 'next.txt', content: 'ok' })).value.ok, true);
      assert.equal(read(f, 'a.txt'), 'old-a\n');
      assert.equal(read(f, 'b.txt'), 'old-b\n');
      assert.equal(recoverStructuredPatchTransaction(f.config, f.workspace).recovered, false);
    });
    await check('crlf-preservation', async f => {
      fs.writeFileSync(f.file('crlf.txt'), 'keep\r\nold\r\nlast\r\n');
      const result = await f.run({ updateText: '*** Begin Patch\n*** Update File: crlf.txt\n@@\n-old\n+new\n*** End Patch' });
      assert.equal(result.value.ok, true);
      assert.equal(read(f, 'crlf.txt'), 'keep\r\nnew\r\nlast\r\n');
    });
    await check('append-metadata-failure', async f => {
      const start = workspaceWrite(f.workspace, f.config, { stage: 'start', path: 'joined.txt', content: 'A' });
      let injected = false;
      fs.renameSync = function (source, destination, ...args) {
        if (!injected && String(destination).endsWith(start.writeId + '.json')) { injected = true; throw new Error('metadata denied'); }
        return originals.rename.call(this, source, destination, ...args);
      };
      syncBuiltinESMExports();
      await assert.rejects(() => f.run({ stage: 'append', writeId: start.writeId, content: 'B' }), /persist state file/);
      restoreHooks();
      assert.equal(readStagedPayload(f.config, f.workspace, start.writeId).bytes, 1);
      await f.run({ stage: 'append', writeId: start.writeId, content: 'B' });
      await f.run({ stage: 'commit', writeId: start.writeId });
      assert.equal(read(f, 'joined.txt'), 'AB');
    });
    await check('append-abrupt-exit-reopen', async f => {
      const start = workspaceWrite(f.workspace, f.config, { stage: 'start', path: 'joined.txt', content: 'A' });
      runChild('crash-append', f, [start.writeId]);
      assert.equal(readStagedPayload(f.config, f.workspace, start.writeId).bytes, 1);
      await f.run({ stage: 'append', writeId: start.writeId, content: 'B' });
      await f.run({ stage: 'commit', writeId: start.writeId });
      assert.equal(read(f, 'joined.txt'), 'AB');
    });
    await check('rollback-promotion-failure', async f => {
      seed(f);
      const controller = new AbortController();
      let promotions = 0;
      fs.renameSync = function (source, destination, ...args) {
        if (path.resolve(String(destination)) === f.file('a.txt') && ++promotions === 2) throw new Error('rollback promotion denied');
        const result = originals.rename.call(this, source, destination, ...args);
        if (path.resolve(String(destination)) === f.file('a.txt') && promotions === 1) controller.abort(new Error('cancel'));
        return result;
      };
      syncBuiltinESMExports();
      const result = await f.run(batch, controller.signal);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.rollback.ok, false);
      assert.equal(read(f, 'a.txt'), 'new-a\n', 'failed atomic restore must not leave torn original bytes');
      assert.equal(fs.readdirSync(marker(f)).length, 1);
      restoreHooks();
      assert.equal((await f.run({ path: 'next.txt', content: 'ok' })).value.ok, true);
      assert.equal(read(f, 'a.txt'), 'old-a\n');
      assert.equal(read(f, 'b.txt'), 'old-b\n');
    });
    await check('external-write-during-rollback', async f => {
      seed(f);
      const controller = new AbortController();
      let cancelled = false;
      fs.renameSync = function (source, destination, ...args) {
        const result = originals.rename.call(this, source, destination, ...args);
        if (!cancelled && path.resolve(String(destination)) === f.file('b.txt')) { cancelled = true; controller.abort(new Error('cancel after both writes')); }
        else if (cancelled && path.resolve(String(destination)) === f.file('a.txt')) fs.writeFileSync(f.file('b.txt'), 'external-during-rollback\n');
        return result;
      };
      syncBuiltinESMExports();
      const result = await f.run(batch, controller.signal);
      assert.equal(result.value.rollback.ok, false);
      assert.equal(read(f, 'a.txt'), 'old-a\n');
      assert.equal(read(f, 'b.txt'), 'external-during-rollback\n');
      assert.equal(fs.readdirSync(marker(f)).length, 1);
    });
    await check('staged-patch-append', async f => {
      fs.writeFileSync(f.file('patch.txt'), 'old\n');
      const start = await f.run({ stage: 'start', updateText: '*** Begin Patch\n*** Update File: patch.txt\n' });
      await f.run({ stage: 'append', writeId: start.value.writeId, updateText: '@@\n-old\n+new\n*** End Patch' });
      assert.equal((await f.run({ stage: 'commit', writeId: start.value.writeId })).value.ok, true);
      assert.equal(read(f, 'patch.txt'), 'new\n');
    });
    await check('byte-exact-batch-rollback', async f => {
      const original = Buffer.from([0xff, 0x00, 0x80, 0x0a]);
      fs.writeFileSync(f.file('a.txt'), original);
      fs.writeFileSync(f.file('b.txt'), 'old-b\n');
      const controller = new AbortController();
      let injected = false;
      fs.renameSync = function (source, destination, ...args) {
        const result = originals.rename.call(this, source, destination, ...args);
        if (!injected && path.resolve(String(destination)) === f.file('a.txt')) { injected = true; controller.abort(new Error('cancel binary conversion')); }
        return result;
      };
      syncBuiltinESMExports();
      const result = await f.run(batch, controller.signal);
      assert.equal(injected, true);
      assert.equal(result.value.ok, false);
      assert.equal(result.value.rollback.ok, true);
      assert.deepEqual(fs.readFileSync(f.file('a.txt')), original);
    });
    await check('artifact-cleanup-pending-contract', async f => {
      globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
      fs.promises.rm = async function (file, ...args) {
        if (String(file).includes('.relai-import-')) throw new Error('staging cleanup denied');
        return originals.rmAsync.call(this, file, ...args);
      };
      const result = await f.run({ path: 'import.bin', file: { download_url: 'https://files.oaiusercontent.com/fixture', file_id: 'fixture', size: 3 } });
      assert.equal(result.value.ok, true);
      assert.equal(result.value.cleanupPending, true);
      assert.deepEqual([...fs.readFileSync(f.file('import.bin'))], [1, 2, 3]);
    });
    await check('strict-transaction-output-contract', async () => {
      const args = { workspace: 'repo', path: 'fixture.txt', content: 'fixture' };
      const output = transaction => ({ ok: true, workspace: 'repo', transaction });
      await assert.rejects(() => validateToolOutput({}, 'relai_edit', args, output({ committed: true, cleanupPending: false, unexpected: true })), /Output validation error/);
      await assert.rejects(() => validateToolOutput({}, 'relai_edit', args, output({ committed: true, cleanupPending: 'false' })), /Output validation error/);
      await assert.rejects(() => validateToolOutput({}, 'relai_edit', args, output({ committed: true })), /Output validation error/);
    });
    console.log('Edit transaction recovery regressions passed: ' + passed + '.');
  } finally {
    restoreHooks();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
