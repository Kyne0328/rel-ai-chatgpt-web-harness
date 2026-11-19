import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginStructuredPatchTransaction,
  completeStructuredPatchTransaction,
  recoverStructuredPatchTransaction,
  inspectStructuredPatchTransaction
} from '../src/structuredPatchTransaction.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-structured-patch-tx-'));
const workspacePath = path.join(root, 'workspace');
const config = { stateDir: path.join(root, 'state') };
const workspace = { alias: 'repo', path: workspacePath };
fs.mkdirSync(workspacePath, { recursive: true });

try {
  const existing = path.join(workspacePath, 'existing.txt');
  const added = path.join(workspacePath, 'added.txt');
  fs.writeFileSync(existing, 'old\n');
  const mode = fs.statSync(existing).mode;
  beginStructuredPatchTransaction(config, workspace, [
    { path: 'existing.txt', exists: true, content: Buffer.from('old\n'), mode },
    { path: 'added.txt', exists: false, content: null, mode: null }
  ], [
    { path: 'existing.txt', exists: true, text: 'new\n' },
    { path: 'added.txt', exists: true, text: 'added\n' }
  ]);
  fs.writeFileSync(existing, 'new\n');
  fs.writeFileSync(added, 'added\n');
  const recovered = recoverStructuredPatchTransaction(config, workspace);
  assert.equal(recovered.recovered, true);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'old\n');
  assert.equal(fs.existsSync(added), false);
  assert.equal(recoverStructuredPatchTransaction(config, workspace).recovered, false, 'recovery must be idempotent after the marker is cleared');

  beginStructuredPatchTransaction(
    config,
    workspace,
    [{ path: 'existing.txt', exists: true, content: Buffer.from('old\n'), mode }],
    [{ path: 'existing.txt', exists: true, text: 'new\n' }]
  );
  fs.writeFileSync(existing, 'external-change\n');
  assert.throws(
    () => recoverStructuredPatchTransaction(config, workspace),
    /changed after the interrupted patch/,
    'recovery must not overwrite a file changed independently after the crash'
  );
  assert.equal(fs.readFileSync(existing, 'utf8'), 'external-change\n');
  completeStructuredPatchTransaction(config, workspace);
  fs.writeFileSync(existing, 'old\n');

  beginStructuredPatchTransaction(config, workspace, [{ path: 'existing.txt', exists: true, content: Buffer.from('old\n'), mode }]);
  fs.writeFileSync(existing, 'committed\n');
  completeStructuredPatchTransaction(config, workspace);
  assert.equal(recoverStructuredPatchTransaction(config, workspace).recovered, false);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'committed\n');

  const nested = { alias: 'nested', path: path.join(workspacePath, 'nested') };
  const independent = { alias: 'independent', path: path.join(root, 'independent') };
  fs.mkdirSync(nested.path);
  fs.mkdirSync(independent.path);
  const nestedFile = path.join(nested.path, 'file.txt');
  fs.writeFileSync(nestedFile, 'before');
  beginStructuredPatchTransaction(config, workspace,
    [{ path: 'nested/file.txt', exists: true, content: Buffer.from('before') }],
    [{ path: 'nested/file.txt', exists: true, text: 'partial' }]);
  fs.writeFileSync(nestedFile, 'partial');
  assert.throws(() => recoverStructuredPatchTransaction(config, nested),
    error => error.code === 'WORKSPACE_EDIT_RECOVERY_PENDING',
    'nested roots must not bypass their parent recovery record');
  assert.throws(() => inspectStructuredPatchTransaction(config, nested),
    error => error.code === 'WORKSPACE_EDIT_RECOVERY_PENDING');
  assert.throws(() => beginStructuredPatchTransaction(config, nested, []),
    error => error.code === 'WORKSPACE_EDIT_RECOVERY_PENDING');
  assert.equal(recoverStructuredPatchTransaction(config, independent).recovered, false);
  assert.equal(fs.readFileSync(nestedFile, 'utf8'), 'partial');
  assert.equal(recoverStructuredPatchTransaction(config, workspace).recovered, true);
  assert.equal(fs.readFileSync(nestedFile, 'utf8'), 'before');
  beginStructuredPatchTransaction(config, nested,
    [{ path: 'file.txt', exists: true, content: Buffer.from('before') }],
    [{ path: 'file.txt', exists: true, text: 'partial' }]);
  fs.writeFileSync(nestedFile, 'partial');
  assert.throws(() => recoverStructuredPatchTransaction(config, workspace),
    error => error.code === 'WORKSPACE_EDIT_RECOVERY_PENDING',
    'parent roots must not bypass their nested recovery record');
  recoverStructuredPatchTransaction(config, nested);

  if (process.platform === 'win32') {
    const alias = { alias: 'new-label', path: path.join(root, 'WORKSPACE') };
    const marker = beginStructuredPatchTransaction(config, workspace,
      [{ path: 'existing.txt', exists: true, content: Buffer.from('old\n'), mode }],
      [{ path: 'existing.txt', exists: true, text: 'interrupted\n' }]);
    fs.writeFileSync(existing, 'interrupted\n');
    if (fs.existsSync(alias.path) && fs.realpathSync.native(alias.path) === fs.realpathSync.native(workspace.path)) {
      assert.equal(inspectStructuredPatchTransaction(config, alias).pending, true, 'same Windows directory must find its original journal');
      const duplicate = path.join(path.dirname(marker), createHash('sha256').update(path.resolve(alias.path)).digest('hex') + '.json');
      const record = JSON.parse(fs.readFileSync(marker, 'utf8'));
      fs.writeFileSync(duplicate, JSON.stringify({ ...record, workspaceRoot: alias.path }), { flag: 'wx' });
      assert.throws(() => recoverStructuredPatchTransaction(config, alias), error => error.code === 'WORKSPACE_EDIT_RECOVERY_PENDING');
      assert.equal(fs.readFileSync(existing, 'utf8'), 'interrupted\n');
      fs.unlinkSync(duplicate);
      assert.equal(recoverStructuredPatchTransaction(config, alias).recovered, true);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(recoverStructuredPatchTransaction(config, alias).recovered, false);
    } else {
      // Windows also permits case-sensitive folders. A different directory has no authority.
      fs.mkdirSync(alias.path, { recursive: true });
      assert.throws(() => recoverStructuredPatchTransaction(config, alias), error => error.code === 'WORKSPACE_EDIT_RECOVERY_PENDING');
      assert.equal(fs.readFileSync(existing, 'utf8'), 'interrupted\n');
      assert.equal(recoverStructuredPatchTransaction(config, workspace).recovered, true);
    }
    assert.equal(fs.readFileSync(existing, 'utf8'), 'old\n');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Structured multi-file patch transactions recover interrupted edits atomically.');
