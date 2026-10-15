import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Use cgroup v2 only when the running user already owns a writable subtree.
// Commands join their leaf BEFORE exec, so setsid() cannot escape supervision.
const CGROUP_ROOT = '/sys/fs/cgroup';
const LEAF_PREFIX = 'relai-mutation-';
const LAUNCH = 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"';

function delegatedParent() {
  if (process.platform !== 'linux') return null;
  try {
    if (!fs.statSync(path.join(CGROUP_ROOT, 'cgroup.controllers')).isFile()) return null;
    const membership = fs.readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (!membership?.startsWith('/') || membership.includes('..') || membership.includes('\0')) return null;
    const parent = path.resolve(CGROUP_ROOT, '.' + membership);
    if (parent !== CGROUP_ROOT && !parent.startsWith(CGROUP_ROOT + path.sep)) return null;
    if (!fs.statSync(parent).isDirectory()) return null;
    fs.accessSync(path.join(parent, 'cgroup.procs'), fs.constants.W_OK);
    return parent;
  } catch { return null; }
}

function prepareLinuxMutationCgroup() {
  const parent = delegatedParent();
  if (!parent) return null;
  const nonce = crypto.randomBytes(16).toString('hex');
  const directory = path.join(parent, LEAF_PREFIX + nonce);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    if (!fs.statSync(path.join(directory, 'cgroup.kill')).isFile()
      || !fs.statSync(path.join(directory, 'cgroup.events')).isFile()) {
      fs.rmdirSync(directory);
      return null;
    }
    fs.accessSync(path.join(directory, 'cgroup.kill'), fs.constants.W_OK);
    return { directory, nonce };
  } catch {
    try { fs.rmdirSync(directory); } catch {}
    return null;
  }
}

function validateLinuxMutationCgroup(reference) {
  const parent = delegatedParent();
  if (!parent || !reference || typeof reference.directory !== 'string'
    || !/^[a-f0-9]{32}$/.test(String(reference.nonce || ''))
    || reference.directory !== path.join(parent, LEAF_PREFIX + reference.nonce)) return false;
  try {
    const stat = fs.lstatSync(reference.directory);
    return stat.isDirectory() && !stat.isSymbolicLink()
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch { return false; }
}

function linuxMutationCgroupEmpty(reference) {
  if (!validateLinuxMutationCgroup(reference)) return false;
  try {
    const events = fs.readFileSync(path.join(reference.directory, 'cgroup.events'), 'utf8');
    return /^populated 0$/m.test(events);
  } catch { return false; }
}

async function settleLinuxMutationCgroup(reference, waitMs = 2000) {
  if (linuxMutationCgroupEmpty(reference)) return { exited: true, forced: false };
  if (!validateLinuxMutationCgroup(reference)) {
    return { exited: false, forced: false, error: 'The owned Linux cgroup cannot be verified.' };
  }
  try {
    fs.writeFileSync(path.join(reference.directory, 'cgroup.kill'), '1');
  } catch {
    return { exited: false, forced: false, error: 'The owned Linux cgroup could not be stopped.' };
  }
  const deadline = Date.now() + Math.max(0, Math.min(30000, Number(waitMs) || 0));
  for (;;) {
    if (linuxMutationCgroupEmpty(reference)) return { exited: true, forced: true };
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { exited: false, forced: true, error: 'The owned Linux cgroup is still populated.' };
}

function cleanupLinuxMutationCgroup(reference) {
  if (!linuxMutationCgroupEmpty(reference)) return false;
  try { fs.rmdirSync(reference.directory); return true; } catch { return false; }
}

function linuxMutationCgroupCommand(reference, executable, args) {
  if (!validateLinuxMutationCgroup(reference)) throw new Error('Owned Linux cgroup was replaced.');
  return { executable: '/bin/sh', args: ['-c', LAUNCH, 'relai-cgroup', reference.directory, executable, ...args] };
}

export {
  prepareLinuxMutationCgroup, linuxMutationCgroupCommand, linuxMutationCgroupEmpty,
  settleLinuxMutationCgroup, cleanupLinuxMutationCgroup
};
