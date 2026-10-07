import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateDir } from '../statePaths.js';

const TICKET_PATTERN = /^\.operation-(\d+)-[a-f0-9-]+\.lock$/;
const held = new Map();

function operationRoot(config) {
  const root = path.join(getStateDir(config), 'extensions');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.realpathSync(root);
}

function extensionOperationIsHeld(config, lease) {
  const root = operationRoot(config);
  const current = held.get(operationKey(root));
  return lease ? current === lease : Boolean(current);
}

function acquireExtensionOperation(config) {
  const root = operationRoot(config);
  const key = operationKey(root);
  if (held.has(key)) throw busyError();
  // Publish a unique ticket before checking for competitors. On a local
  // filesystem, two entrants cannot both observe no other ticket: at least
  // one sees the ticket published before its directory read and backs off.
  // Unique names also let dead-process cleanup avoid deleting a new owner.
  const ticket = path.join(root, '.operation-' + process.pid + '-' + crypto.randomUUID() + '.lock');
  fs.writeFileSync(ticket, '', { flag: 'wx', mode: 0o600 });
  let acquired = false;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const match = entry.name.match(TICKET_PATTERN);
      const candidate = path.join(root, entry.name);
      if (!match || candidate === ticket) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw busyError();
      const pid = Number(match[1]);
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { alive = error?.code !== 'ESRCH'; }
      if (alive) throw busyError();
      fs.rmSync(candidate, { force: true });
    }
    const lease = {
      release() {
        if (held.get(key) !== lease) return;
        // Retain the in-process guard if cleanup fails. Do not expose shared
        // package state to another mutation after uncertain lock release.
        fs.rmSync(ticket, { force: true });
        held.delete(key);
      }
    };
    held.set(key, lease);
    acquired = true;
    return lease;
  } finally {
    if (!acquired) fs.rmSync(ticket, { force: true });
  }
}

function operationKey(root) {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function busyError() {
  return Object.assign(new Error('Another extension installation, removal, or recovery is in progress. Retry after it finishes.'), { code: 'EXTENSION_OPERATION_BUSY' });
}

export { acquireExtensionOperation, extensionOperationIsHeld };
