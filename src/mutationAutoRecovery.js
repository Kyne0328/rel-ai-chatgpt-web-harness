import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { getStateDir } from './statePaths.js';
import { currentMutationBootIdentity } from './mutationBootIdentity.js';
import { persistedWindowsJobComplete } from './windowsProcessJob.ts';
import { privatelyOwnedWindowsState, privatelyOwnedWindowsPaths } from './mutationWindowsStateAcl.js';
import { canonicalWorkspaceAuthority, bindWorkspaceOperationIdentity, blockWorkspaceMutations, clearOwnedWorkspaceMutationBlock } from './workspaceOperationQueue.js';
import { listMutationProcessRecords, notifyRecoveryChange, onMutationProcessRecoveryChange } from './mutationProcessOwnership.js';

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const MAX_RECORD_BYTES = 65536;
const MAX_RECORDS = 1000;
const entryKey = e => hash(e.authority) + '--' + e.filename;

function privatelyOwned(file, stat) {
  return process.platform === 'win32'
    ? privatelyOwnedWindowsState(file)
    : (stat.mode & 0o022) === 0
      && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}
function safeDir(dir, create = false) {
  if (create) fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || !privatelyOwned(dir, s))
    throw new Error('Recovery directory is not private.');
}
function safeFile(file, expected = null) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || !privatelyOwned(file, s)
    || s.size > MAX_RECORD_BYTES) throw new Error('Unsafe recovery record.');
  const bytes = fs.readFileSync(file);
  const post = fs.lstatSync(file);
  if (s.ino !== post.ino || s.dev !== post.dev || s.size !== bytes.length
    || s.size !== post.size) throw new Error('Recovery file changed during verification.');
  const digest = hash(bytes);
  if (expected && (digest !== expected.digest || String(s.ino) !== expected.ino
    || (s.mode & 0o777) !== expected.mode || s.uid !== expected.uid
    || s.gid !== expected.gid)) throw new Error('Recovery record does not match checkpoint.');
  return { digest, ino: String(s.ino), mode: s.mode & 0o777, uid: s.uid, gid: s.gid };
}
function recordFile(state, e) {
  return path.join(state, 'active-mutations-v3', hash(e.authority), e.filename);
}
async function inventory(config, alias, directory, authorities, state) {
  const records = listMutationProcessRecords(config, alias, directory);
  if (records.length > MAX_RECORDS) throw new Error('Recovery inventory too large.');
  if (process.platform === 'win32' && records.length) {
    const paths = new Set([state, path.join(state, 'active-mutations-v3')]);
    for (const record of records) {
      const filename = path.basename(record.file || '');
      if (record.invalid || record.incomplete || record.legacyAuthorityUnknown
        || record.schemaVersion !== 3 || record.authorityStatus !== 'bound'
        || !authorities.includes(record.authority) || !/^[\w-]{1,200}\.json$/u.test(filename)
        || path.resolve(record.file) !== path.join(state, 'active-mutations-v3', hash(record.authority), filename))
        throw new Error('Recovery inventory cannot be validated.');
      paths.add(path.dirname(record.file));
      paths.add(record.file);
    }
    if (!await privatelyOwnedWindowsPaths([...paths])) throw new Error('Recovery state ACL cannot be verified.');
  }
  const keys = new Set();
  return records.map(record => {
    if (record.invalid || record.incomplete || record.legacyAuthorityUnknown
      || record.schemaVersion !== 3 || record.authorityStatus !== 'bound'
      || record.terminationUncertain !== true || !authorities.includes(record.authority)) {
      throw new Error('Recovery inventory includes an unverified record.');
    }
    const filename = path.basename(record.file);
    if (!/^[\w-]{1,200}\.json$/u.test(filename)
      || path.resolve(record.file) !== path.join(state, 'active-mutations-v3', hash(record.authority), filename)) {
      throw new Error('Unexpected mutation record path.');
    }
    safeDir(state);
    safeDir(path.join(state, 'active-mutations-v3'));
    safeDir(path.dirname(record.file));
    const e = { authority: record.authority, filename,
      ...safeFile(record.file), bootIdentity: record.bootIdentity || null,
      nativeJob: record.nativeJob || null, pid: record.pid };
    const key = entryKey(e);
    if (keys.has(key)) throw new Error('Duplicate mutation records.');
    keys.add(key);
    return e;
  }).sort((a,b) => entryKey(a).localeCompare(entryKey(b)));
}
async function archiveOne(state, root, item, evidence) {
  if (process.platform === 'win32') {
    const archive = path.join(root, 'archive');
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    if (!await privatelyOwnedWindowsPaths([root, archive]))
      throw new Error('Recovery archive ACL cannot be verified.');
  }
  safeDir(root, true);
  const archivedDir = path.join(root, 'archive');
  safeDir(archivedDir, true);
  const origin = recordFile(state, item);
  const destination = path.join(archivedDir, entryKey(item));
  if (fs.existsSync(destination)) {
    if (fs.existsSync(origin)) throw new Error('Duplicate original and archived record.');
    safeFile(destination, item);
    return false;
  }
  safeFile(origin, item);
  const auditPath = path.join(root, 'audit-' + entryKey(item) + '.json');
  if (fs.existsSync(auditPath)) {
    const audit = readJsonFile(auditPath);
    if (audit?.digest !== item.digest || audit?.evidence !== evidence) throw new Error('Recovery audit changed.');
  } else {
    writeJsonAtomic(auditPath, { version: 1, entry: entryKey(item), digest: item.digest,
      evidence, recordedAt: new Date().toISOString() }, { mode: 0o600 });
  }
  safeFile(origin, item);
  if (fs.statSync(origin).dev !== fs.statSync(archivedDir).dev)
    throw new Error('Recovery archive crosses a filesystem.');
  fs.renameSync(origin, destination);
  notifyRecoveryChange();
  return true;
}
function previousBoot(e, current) {
  return e.bootIdentity?.platform === current.platform
    && e.bootIdentity.host === current.host && e.bootIdentity.boot !== current.boot
    && typeof e.bootIdentity.boot === 'string';
}
async function reconcileLegacy(state, root, current, entries) {
  if (process.platform === 'win32') {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!await privatelyOwnedWindowsPaths([root])) throw new Error('Recovery checkpoint ACL cannot be verified.');
  }
  safeDir(root, true);
  const checkpointPath = path.join(root, 'checkpoint.json');
  if (!fs.existsSync(checkpointPath)) {
    writeJsonAtomic(checkpointPath, { version: 1, bootIdentity: current,
      entries, capturedAt: new Date().toISOString() }, { mode: 0o600 });
    return 0;
  }
  const checkpointStat = fs.lstatSync(checkpointPath);
  if (!checkpointStat.isFile() || checkpointStat.isSymbolicLink()
    || checkpointStat.size > 1048576) throw new Error('Recovery checkpoint is unsafe.');
  const checkpoint = readJsonFile(checkpointPath);
  if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.entries)
    || checkpoint.entries.length > MAX_RECORDS
    || checkpoint.bootIdentity?.platform !== current.platform
    || checkpoint.bootIdentity?.host !== current.host) throw new Error('Recovery checkpoint invalid.');
  const sameBoot = checkpoint.bootIdentity.boot === current.boot;
  const expected = new Map();
  for (const item of checkpoint.entries) {
    if (!item || typeof item.authority !== 'string' || typeof item.filename !== 'string'
      || !/^[\w-]{1,200}\.json$/u.test(item.filename)) throw new Error('Recovery checkpoint has an invalid record.');
    const key = entryKey(item);
    if (expected.has(key)) throw new Error('Recovery checkpoint duplicated a record.');
    expected.set(key, item);
  }
  const actual = new Set(entries.map(entryKey));
  if ([...actual].some(key => !expected.has(key))) throw new Error('New recovery records appeared after checkpoint.');
  const archivedDir = path.join(root, 'archive');
  if (process.platform === 'win32') {
    const aclTargets = [root, checkpointPath];
    if (fs.existsSync(archivedDir)) aclTargets.push(archivedDir);
    for (const [key] of expected) {
      const archivedFile = path.join(archivedDir, key);
      if (fs.existsSync(archivedFile)) aclTargets.push(archivedFile);
    }
    if (!await privatelyOwnedWindowsPaths(aclTargets)) throw new Error('Recovery checkpoint ACL cannot be verified.');
  }
  if (fs.existsSync(archivedDir)) safeDir(archivedDir);
  if (fs.existsSync(archivedDir)) {
    for (const name of fs.readdirSync(archivedDir)) {
      if (!expected.has(name)) throw new Error('Unexpected archived recovery record.');
    }
  }
  // Inspect the complete original+archived inventory before the first mutation.
  for (const [key, item] of expected) {
    const original = recordFile(state, item);
    const archived = path.join(archivedDir, key);
    const hasOriginal = fs.existsSync(original), hasArchived = fs.existsSync(archived);
    if (hasOriginal === hasArchived || hasOriginal !== actual.has(key)) {
      throw new Error('Recovery checkpoint record missing or replaced.');
    }
    safeFile(hasOriginal ? original : archived, item);
  }
  if (sameBoot) return 0;
  let released = 0;
  for (const item of expected.values()) {
    if (fs.existsSync(recordFile(state, item)) && await archiveOne(state, root, item, 'verified-checkpoint-boot')) released++;
  }
  // Move the complete checkpoint and its audits out of the active recovery
  // directory atomically. Future interruptions can create a fresh checkpoint;
  // normal dashboard reads never rescan historical, already-proven archives.
  const completed = path.join(path.dirname(root), 'completed-' + crypto.randomBytes(12).toString('hex'));
  fs.renameSync(root, completed);
  return released;
}
async function reconcileWorkspaceMutationRecords(config, alias, workspacePath, bootIdentity = undefined) {
  const state = path.resolve(getStateDir(config));
  const canonical = canonicalWorkspaceAuthority(workspacePath);
  const physical = fs.realpathSync.native(path.resolve(workspacePath));
  const authorities = [...new Set([canonical, 'path:' + (process.platform === 'win32' ? physical.toLowerCase() : physical)])];
  const entries = await inventory(config, alias, workspacePath, authorities, state);
  const workspaceRoot = path.join(state, 'mutation-auto-recovery', hash(canonical));
  const legacyRoot = path.join(workspaceRoot, 'legacy');
  const hasCheckpoint = fs.existsSync(path.join(legacyRoot, 'checkpoint.json'));
  if (!entries.length && !hasCheckpoint) return { released: 0, pending: false };
  // Probing native boot identity can require process startup on Windows; only
  // perform it when durable mutation ownership actually needs reconciliation.
  const boot = bootIdentity === undefined ? await currentMutationBootIdentity() : bootIdentity;
  // A prior checkpoint owns its complete inventory until archival finishes.
  if (hasCheckpoint) {
    if (!boot) throw new Error('Recovery checkpoint cannot be verified without native boot identity.');
    const released = await reconcileLegacy(state, legacyRoot, boot, entries);
    return { released, pending: entries.length > released };
  }
  let released = 0;
  for (const entry of entries) {
    if (boot && previousBoot(entry, boot)) {
      if (await archiveOne(state, path.join(workspaceRoot, 'native-boot'), entry, 'verified-record-boot')) released++;
    } else if (entry.nativeJob && persistedWindowsJobComplete(config, entry.nativeJob, entry.pid)) {
      if (await archiveOne(state, path.join(workspaceRoot, 'native-job'), entry, 'verified-native-job-zero')) released++;
    }
  }
  const remaining = await inventory(config, alias, workspacePath, authorities, state);
  if (remaining.length && boot) await reconcileLegacy(state, legacyRoot, boot, remaining);
  return { released, pending: remaining.length > 0 };
}
function mutationAutoRecoveryCheckpointInvalid(config, alias, workspacePath = '') {
  workspacePath ||= config?.workspaces?.[alias]?.path || '';
  if (!workspacePath) return false;
  try {
    const state = path.resolve(getStateDir(config));
    const authority = canonicalWorkspaceAuthority(workspacePath);
    const root = path.join(state, 'mutation-auto-recovery', hash(authority), 'legacy');
    const checkpointFile = path.join(root, 'checkpoint.json');
    if (!fs.existsSync(checkpointFile)) return false;
    safeDir(root);
    const checkpoint = readJsonFile(checkpointFile);
    if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.entries)
      || checkpoint.entries.length > MAX_RECORDS) return true;
    const expected = new Set();
    for (const item of checkpoint.entries) {
      if (typeof item?.authority !== 'string' || typeof item?.filename !== 'string'
        || !/^[\w-]{1,200}\.json$/u.test(item.filename)
        || (item.authority !== authority
          && item.authority !== 'path:' + fs.realpathSync.native(path.resolve(workspacePath)).toLowerCase()
          && item.authority !== 'path:' + fs.realpathSync.native(path.resolve(workspacePath)))) return true;
      const key = entryKey(item);
      if (expected.has(key)) return true;
      expected.add(key);
      const original = recordFile(state, item);
      const archived = path.join(root, 'archive', key);
      if (fs.existsSync(original) === fs.existsSync(archived)) return true;
      safeFile(fs.existsSync(original) ? original : archived, item);
      if (fs.existsSync(archived)) {
        const audit = readJsonFile(path.join(root, 'audit-' + key + '.json'));
        if (audit?.digest !== item.digest || audit.evidence !== 'verified-checkpoint-boot') return true;
      }
    }
    if (fs.existsSync(path.join(root, 'archive'))) {
      for (const name of fs.readdirSync(path.join(root, 'archive'))) {
        if (!expected.has(name)) return true;
      }
    }
    return false;
  } catch { return true; }
}

async function recoverMutationRecordsAtStartup(config, options = {}) {
  const result = { released: 0, pending: 0, errors: [] };
  for (const [alias, workspace] of Object.entries(config.workspaces || {})) {
    if (!workspace?.path) continue;
    try {
      const report = await reconcileWorkspaceMutationRecords(config, alias, workspace.path, options.bootIdentity);
      result.released += report.released;
      if (report.pending) result.pending++;
    } catch (error) {
      result.pending++;
      result.errors.push({ workspace: alias, reason: String(error?.message || error) });
    }
  }
  return result;
}

// Only workspaces with durable uncertainty acquire a startup barrier. Healthy
// workspaces have no recovery timer or polling work.
function startAutomaticMutationRecovery(config, options = {}) {
  const groups = new Map();
  const retryMs = options.retryMs || [5000, 15000, 60000, 300000];
  let stopped = false;
  let unsubscribe = () => {};

  const trackWorkspace = (alias, workspace) => {
    if (!workspace?.path) return null;
    try {
      const authority = canonicalWorkspaceAuthority(workspace.path);
      const records = listMutationProcessRecords(config, alias, workspace.path);
      const checkpoint = path.join(getStateDir(config), 'mutation-auto-recovery', hash(authority), 'legacy', 'checkpoint.json');
      if (!records.length && !fs.existsSync(checkpoint)) return null;
      bindWorkspaceOperationIdentity(alias, workspace.path);
      let group = groups.get(authority);
      if (!group) {
        const owner = blockWorkspaceMutations(alias, 'Checking persisted mutation ownership.');
        group = { alias, members: [], owner, attempt: 0, pending: true, running: null, timer: null };
        groups.set(authority, group);
      }
      if (!group.members.some(member => member.alias === alias)) group.members.push({ alias, path: workspace.path });
      return group;
    } catch (error) {
      const existing = groups.get('unverified:' + alias);
      if (existing) return existing;
      const owner = blockWorkspaceMutations(alias, 'Mutation recovery evidence could not be read.');
      const group = {
        alias, members: [], owner, attempt: 0, pending: true, running: null, timer: null,
        failure: String(error?.message || error)
      };
      groups.set('unverified:' + alias, group);
      return group;
    }
  };
  for (const [alias, workspace] of Object.entries(config.workspaces || {})) trackWorkspace(alias, workspace);

  const recheck = group => {
    if (stopped || !group.pending) return Promise.resolve();
    if (group.running) return group.running;
    if (group.timer) { clearTimeout(group.timer); group.timer = null; }
    group.running = (async () => {
      if (group.failure) return { pending: true, errors: [{ workspace: group.alias, reason: group.failure }] };
      let pending = false;
      let couldSettleThisBoot = false;
      const errors = [];
      let released = 0;
      for (const member of group.members) {
        try {
          const outcome = await reconcileWorkspaceMutationRecords(config, member.alias, member.path, options.bootIdentity);
          released += outcome.released;
          pending ||= outcome.pending;
          if (outcome.pending) {
            const remaining = listMutationProcessRecords(config, member.alias, member.path);
            couldSettleThisBoot ||= remaining.some(record => record.nativeJob && !record.invalid && !record.incomplete);
          }
        } catch (error) {
          pending = true;
          errors.push({ workspace: member.alias, reason: String(error?.message || error) });
        }
      }
      group.pending = pending;
      group.nextEventAt = Date.now() + (options.eventMinMs ?? 5000);
      if (!pending) {
        for (const [key, value] of groups) if (value === group) groups.delete(key);
        if (group.timer) { clearTimeout(group.timer); group.timer = null; }
        if (group.owner?.created) clearOwnedWorkspaceMutationBlock(group.alias, group.owner.token);
      } else if (couldSettleThisBoot && !errors.length && !stopped) {
        const delay = retryMs[Math.min(group.attempt++, retryMs.length - 1)];
        group.timer = setTimeout(() => { group.timer = null; void recheck(group); }, delay);
        group.timer.unref?.();
      }
      return { released, pending, errors };
    })().finally(() => { group.running = null; });
    return group.running;
  };

  // An idle service has one lightweight event listener but no timers or scans.
  // Newly uncertain commands join the monitor synchronously before verification.
  unsubscribe = onMutationProcessRecoveryChange(change => {
    if (stopped) return;
    let newlyTracked = null;
    if (change?.kind === 'uncertain' && typeof change.workspace === 'string') {
      newlyTracked = trackWorkspace(change.workspace, config.workspaces?.[change.workspace]);
      if (newlyTracked) void recheck(newlyTracked);
    }
    for (const group of groups.values()) {
      if (group === newlyTracked) continue;
      if (!group.pending || group.timer?.eventWake || Date.now() < (group.nextEventAt || 0)) continue;
      if (group.timer) clearTimeout(group.timer);
      group.timer = setTimeout(() => { group.timer = null; void recheck(group); }, 250);
      group.timer.eventWake = true;
      group.timer.unref?.();
    }
  });

  const initial = Promise.all([...groups.values()].map(recheck)).then(reports => ({
    released: reports.reduce((sum, report) => sum + (report?.released || 0), 0),
    pending: [...groups.values()].filter(group => group.pending).length,
    errors: reports.flatMap(report => report?.errors || [])
  }));
  return {
    initial,
    pendingCount: () => [...groups.values()].filter(group => group.pending).length,
    stop() {
      stopped = true;
      unsubscribe();
      for (const group of groups.values()) {
        if (group.timer) clearTimeout(group.timer);
        group.timer = null;
      }
    }
  };
}

export { mutationAutoRecoveryCheckpointInvalid, recoverMutationRecordsAtStartup, startAutomaticMutationRecovery };
