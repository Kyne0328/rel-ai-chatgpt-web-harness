import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

const PAGE_UNITS = 2048;
const PAGE_BYTES = 16 * 1024 * 1024;
const PAGE_MS = 250;
const SESSION_TTL_MS = 60_000;
const MAX_SESSIONS = 8;
const CANDIDATE_WINDOW = 128;
const READ_CHUNK_BYTES = 64 * 1024;
const sessions = new Map();
const restarts = new Map();

function scanError(reason, message = reason) {
  return Object.assign(new Error(message), { code: 'SKILL_DISCOVERY_INCOMPLETE', reason });
}

function assertScanActive(options = {}) {
  options.signal?.throwIfAborted?.();
  if (Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt) {
    throw scanError('deadline', 'Skill discovery did not finish before the operation deadline. Retry the request.');
  }
}

function fileSignature(stat) {
  return stat ? [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':') : 'missing';
}

function rootIdentity(root) {
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw scanError('unsafe-source', 'Skill source is not a regular directory.');
  const actual = fs.realpathSync(root);
  // Resolve ancestor aliases (for example macOS /var -> /private/var), while
  // rejecting a symlink at the skill root itself. A changed target restarts it.
  return actual + ':' + fileSignature(stat);
}

function* scanStat(file) {
  yield { units: 1 };
  try { return fs.lstatSync(file); } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function* scanEntries(root) {
  yield { units: 1 };
  let directory;
  try {
    directory = fs.opendirSync(root, { bufferSize: 1 });
    while (true) {
      yield { units: 1 };
      const entry = directory.readSync();
      if (!entry) return;
      yield { entry };
    }
  } finally {
    directory?.closeSync();
  }
}

// Reads never use readFile after a size check: an in-place growth cannot turn
// one bounded step into an arbitrarily large allocation or checksum operation.
function* scanFile(file, stat, maximum, hashOnly = false) {
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw scanError('unsafe-file', 'Skill file is missing, oversized, or unsafe.');
  yield { units: 1 };
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (fileSignature(fs.fstatSync(fd)) !== fileSignature(stat)) throw scanError('source-changed', 'Skill file changed while discovery was running.');
    const hash = hashOnly ? crypto.createHash('sha256') : null;
    const chunks = hashOnly ? null : [];
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, stat.size + 1));
    let total = 0;
    while (true) {
      const length = Math.min(buffer.length, stat.size + 1 - total);
      yield { units: 1, bytes: length };
      const count = fs.readSync(fd, buffer, 0, length, null);
      if (!count) break;
      total += count;
      if (total > stat.size) throw scanError('source-changed', 'Skill file grew while discovery was running.');
      if (hash) hash.update(buffer.subarray(0, count));
      else chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    if (total !== stat.size || fileSignature(fs.fstatSync(fd)) !== fileSignature(stat)) throw scanError('source-changed', 'Skill file changed while discovery was running.');
    return hash ? hash.digest('hex') : Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function digestAccumulator() {
  const value = Buffer.alloc(32);
  let count = 0;
  return {
    add(name, signature) {
      const hash = crypto.createHash('sha256').update(JSON.stringify([name, signature])).digest();
      for (let index = 0; index < value.length; index += 1) value[index] ^= hash[index];
      count += 1;
    },
    value() { return count + ':' + value.toString('hex'); }
  };
}

function candidateEntry(entry) {
  return entry.isDirectory() && !entry.isSymbolicLink();
}

function compareNames(left, right) {
  return left.localeCompare(right) || (left < right ? -1 : left > right ? 1 : 0);
}

function* candidateBatch(source, after) {
  const selected = [];
  let count = 0;
  for (const event of scanEntries(source.root)) {
    if (!event.entry) { yield event; continue; }
    source.preflight?.(event.entry);
    if (!candidateEntry(event.entry) || source.accept?.(event.entry) === false || compareNames(event.entry.name, after) <= 0) continue;
    count += 1;
    const name = event.entry.name;
    let low = 0;
    let high = selected.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareNames(selected[middle], name) < 0) low = middle + 1;
      else high = middle;
    }
    if (low < CANDIDATE_WINDOW) selected.splice(low, 0, name);
    if (selected.length > CANDIDATE_WINDOW) selected.pop();
  }
  return { names: selected, exhausted: count <= CANDIDATE_WINDOW };
}

function* validateSource(source, summary, context) {
  if (rootIdentity(source.root) !== summary.identity) throw scanError('source-changed');
  if (summary.identity === 'missing') return;
  const digest = digestAccumulator();
  for (const event of scanEntries(source.root)) {
    if (!event.entry) { yield event; continue; }
    source.preflight?.(event.entry);
    if (!candidateEntry(event.entry) || source.accept?.(event.entry) === false || compareNames(event.entry.name, summary.cutoff) > 0) continue;
    const signature = yield* source.observe(event.entry.name, context);
    digest.add(event.entry.name, signature);
  }
  if (rootIdentity(source.root) !== summary.identity || digest.value() !== summary.digest) throw scanError('source-changed');
}

function* inventorySteps(state) {
  const summaries = [];
  for (const source of state.sources) {
    state.source = source.name;
    const identity = rootIdentity(source.root);
    state.visited.add(source.root);
    state.identities[state.sources.indexOf(source)] = identity;
    const pending = new Map();
    const digest = digestAccumulator();
    let cutoff = '';
    let exhausted = identity === 'missing';
    while (!exhausted && state.records.size + pending.size < state.limit) {
      const batch = yield* candidateBatch(source, cutoff);
      if (rootIdentity(source.root) !== identity) throw scanError('source-changed');
      exhausted = batch.exhausted;
      for (const name of batch.names) {
        const observed = yield* source.inspect(name, state.context);
        digest.add(name, observed.signature);
        cutoff = name;
        const record = observed.record;
        if (record && !state.records.has(record.name) && !pending.has(record.name)) pending.set(record.name, record);
        if (state.records.size + pending.size >= state.limit) {
          state.limited = true;
          break;
        }
      }
    }
    const summary = { identity, cutoff, digest: digest.value() };
    yield* validateSource(source, summary, state.context);
    summaries.push({ source, summary });
    for (const [name, record] of pending) state.records.set(name, record);
    if (state.records.size >= state.limit) break;
  }
  // A lower-priority source can take several pages. Recheck completed higher
  // sources before publishing the final inventory, with the same page budget.
  if (summaries.length > 1) {
    for (const { source, summary } of summaries) {
      state.source = source.name;
      yield* validateSource(source, summary, state.context);
    }
  }
  state.source = '';
}

function closeSession(key, reason) {
  const state = sessions.get(key);
  if (!state) return;
  sessions.delete(key);
  clearTimeout(state.timer);
  state.iterator.return();
  if (reason) {
    restarts.delete(key);
    restarts.set(key, reason);
    while (restarts.size > MAX_SESSIONS) restarts.delete(restarts.keys().next().value);
  }
}

function discardSkillScan(key) {
  closeSession(key);
}

function refreshExpiry(key, state, ttl) {
  clearTimeout(state.timer);
  state.expiresAt = Date.now() + ttl;
  state.timer = setTimeout(() => closeSession(key, 'expired'), ttl);
  state.timer.unref?.();
}

function observationMetadata(state) {
  return {
    consistency: 'sequential-observations',
    observationStartedAt: state.observationStartedAt,
    observationEndedAt: new Date(Date.now()).toISOString()
  };
}

function boundedInventory(key, sources, options = {}) {
  // A cancelled observer never owns or destroys another observer's progress.
  assertScanActive(options);
  const now = Date.now();
  for (const [otherKey, state] of sessions) if (state.expiresAt <= now) closeSession(otherKey, 'expired');
  let state = sessions.get(key);
  let restartReason = restarts.get(key);
  restarts.delete(key);
  const identities = sources.map(source => {
    try { return rootIdentity(source.root); }
    catch (error) { return 'unavailable:' + (error.reason || error.code || 'source-unreadable'); }
  });
  // An irrelevant lower-priority source must neither invalidate progress nor
  // hide a complete higher-priority result. Validate it when it is first needed.
  if (state && sources.some((source, index) => state.visited.has(source.root) && identities[index] !== state.identities[index])) {
    closeSession(key);
    state = null;
    restartReason = 'source-changed';
  }
  const resumed = Boolean(state);
  if (!state) {
    if (sessions.size >= MAX_SESSIONS) return { records: [], discovery: { complete: false, resumable: true, truncated: true, reason: 'busy', next: 'Finish another skill scan or retry after its 60-second idle expiry.' } };
    state = { id: crypto.randomUUID(), observationStartedAt: new Date(now).toISOString(), sources, identities, visited: new Set(), context: {}, records: new Map(), limit: options.limit || 100, limited: false, source: '', pending: null, totalUnits: 0, totalBytes: 0 };
    state.iterator = inventorySteps(state);
    sessions.set(key, state);
  }
  state.context.metrics = options.metrics;
  const limits = options.scanLimits || {};
  const maxUnits = Math.max(1, Math.min(PAGE_UNITS, Number(limits.units ?? limits.maxWorkUnits ?? limits.maxEntries) || PAGE_UNITS));
  const maxBytes = Math.max(READ_CHUNK_BYTES, Math.min(PAGE_BYTES, Number(limits.bytes ?? limits.maxBytes) || PAGE_BYTES));
  const maxMs = Math.max(1, Math.min(PAGE_MS, Number(limits.milliseconds ?? limits.maxDurationMs) || PAGE_MS));
  const ttl = Math.max(1, Math.min(SESSION_TTL_MS, Number(limits.ttlMs) || SESSION_TTL_MS));
  refreshExpiry(key, state, ttl);
  let units = 0;
  let bytes = 0;
  let complete = false;
  let reason = 'work-budget';
  let callerStopped = false;
  try {
    while (Date.now() - now < maxMs) {
      try { assertScanActive(options); }
      catch (error) { callerStopped = true; throw error; }
      const next = state.pending || state.iterator.next();
      state.pending = next;
      if (next.done) { complete = true; break; }
      const cost = next.value;
      if (units + (cost.units || 0) > maxUnits || bytes + (cost.bytes || 0) > maxBytes) break;
      units += cost.units || 0;
      bytes += cost.bytes || 0;
      // Execute the credited step in this page, then park before the next cost.
      // Otherwise a paid read could spill into the following page's allowance.
      state.pending = state.iterator.next();
      if (state.pending.done) { complete = true; break; }
    }
    if (!complete && Date.now() - now >= maxMs) reason = 'time-budget';
  } catch (error) {
    if (callerStopped) {
      // A page observer owns its deadline, not the shared continuation. Named
      // lookups have a private scan and must still release their handles.
      const shared = !options.lookupId && !options.requestedName;
      if (!shared) closeSession(key);
      if (options.signal?.aborted) throw error;
      return { records: [...state.records.values()], discovery: {
        ...observationMetadata(state),
        complete: false, resumable: shared, truncated: true, reason: 'deadline', source: state.source,
        ...(shared ? { scanId: state.id, expiresAt: new Date(state.expiresAt).toISOString() } : {}),
        next: 'Repeat the request with an active deadline to continue skill discovery.',
        work: { units, bytes, totalUnits: state.totalUnits + units, totalBytes: state.totalBytes + bytes }
      } };
    }
    if (options.signal?.aborted) {
      closeSession(key);
      throw error;
    }
    reason = error.reason || 'source-unreadable';
    const records = reason === 'source-changed' ? [] : [...state.records.values()];
    closeSession(key, reason === 'source-changed' ? reason : undefined);
    return { records, discovery: { ...observationMetadata(state), complete: false, resumable: reason === 'source-changed', truncated: true, reason, source: state.source, next: 'Repeat relai_snapshot after the source is stable or extension recovery completes.' } };
  } finally {
    state.totalUnits += units;
    state.totalBytes += bytes;
  }
  const records = [...state.records.values()];
  const discovery = {
    ...observationMetadata(state),
    complete,
    resumable: !complete,
    truncated: !complete || state.limited,
    ...(state.limited ? { truncated: true, limit: state.limit } : {}),
    ...(!complete ? { reason, source: state.source, scanId: state.id, expiresAt: new Date(state.expiresAt).toISOString(), next: 'Repeat relai_snapshot with the same workspace to continue skill discovery.' } : {}),
    ...(resumed ? { resumed: true } : {}),
    ...(restartReason ? { restartReason } : {}),
    work: { units, bytes, totalUnits: state.totalUnits, totalBytes: state.totalBytes }
  };
  if (complete) closeSession(key);
  return { records, discovery };
}

async function runScanAsync(iterator, options = {}) {
  const deadlineAt = Number.isFinite(options.deadlineAt) ? options.deadlineAt : Date.now() + 60_000;
  let units = 0;
  let bytes = 0;
  try {
    while (true) {
      assertScanActive({ ...options, deadlineAt });
      const next = iterator.next();
      if (next.done) return next.value;
      units += next.value.units || 0;
      bytes += next.value.bytes || 0;
      if (units >= 32 || bytes >= 1024 * 1024) {
        await new Promise(resolve => setImmediate(resolve));
        units = 0;
        bytes = 0;
      }
    }
  } finally {
    iterator.return();
  }
}

export { assertScanActive, boundedInventory, discardSkillScan, fileSignature, runScanAsync, scanError, scanFile, scanStat };
