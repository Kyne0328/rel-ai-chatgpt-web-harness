import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  beginExtensionInstallTransaction,
  markExtensionInstallCommitted,
  recoverInterruptedExtensionInstalls
} from '../src/extensions/installTransaction.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extension-install-tx-'));
const config = { stateDir: root };
const extensions = path.join(root, 'extensions');
fs.mkdirSync(extensions, { recursive: true });

try {
  const target = path.join(extensions, 'demo');
  const staging = path.join(extensions, '.install-demo-stage');
  const backup = path.join(extensions, '.backup-demo-old');
  fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'version.txt'), 'old');
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'version.txt'), 'new');
  beginExtensionInstallTransaction(config, { id: 'demo', target, staging, backup, targetExisted: true, entries: [] });
  fs.renameSync(target, backup);
  fs.renameSync(staging, target);
  let recovered = recoverInterruptedExtensionInstalls(config);
  assert.equal(recovered.ok, true);
  assert.equal(fs.readFileSync(path.join(target, 'version.txt'), 'utf8'), 'old', 'prepared transaction must roll back after interruption');

  fs.renameSync(target, backup);
  fs.mkdirSync(staging); fs.writeFileSync(path.join(staging, 'version.txt'), 'new');
  fs.renameSync(staging, target);
  beginExtensionInstallTransaction(config, { id: 'demo', target, staging, backup, targetExisted: true, entries: [] });
  markExtensionInstallCommitted(config, 'demo');
  recovered = recoverInterruptedExtensionInstalls(config);
  assert.equal(recovered.ok, true);
  assert.equal(fs.readFileSync(path.join(target, 'version.txt'), 'utf8'), 'new', 'committed transaction must keep the promoted extension');
  assert.equal(fs.existsSync(backup), false, 'committed recovery must remove obsolete backups');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Interrupted extension installation recovers to one coherent package state.');
