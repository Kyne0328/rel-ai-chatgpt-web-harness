import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeProcessEnvironment } from './processEnvironment.js';

const MIB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 5000;
const SAMPLE_STALE_MS = 15_000;

// This sampler never calls runProcess or acquires a host lease: doing either
// would make the pressure gate wait for a probe queued behind that same gate.
async function readHostMemorySample() {
  const sample = {
    sampledAtMs: Date.now(),
    physicalTotalBytes: positiveBytes(os.totalmem()),
    physicalAvailableBytes: finiteBytes(os.freemem()),
    physicalAvailableKind: 'free',
    commitUsedBytes: null,
    commitLimitBytes: null,
    commitAvailableBytes: null,
    commitEnforced: false,
    pagesInputPerSecond: null, pageReadsPerSecond: null,
    pagingMeaning: 'Sampled page-in and disk-read rates; not evidence of sustained thrashing.',
    source: 'node:os',
    error: null
  };
  try {
    if (process.platform === 'win32') {
      const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
      const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const output = await new Promise((resolve, reject) => {
        execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          '$m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop; [Console]::Out.Write(($m | Select-Object AvailableBytes,CommittedBytes,CommitLimit,PagesInputPersec,PageReadsPersec | ConvertTo-Json -Compress))'
        ], { windowsHide: true, timeout: 2000, maxBuffer: 8192, encoding: 'utf8',
          env: makeProcessEnvironment({ PSModulePath: path.join(path.dirname(executable), 'Modules') }, { allow: [] }) },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const data = JSON.parse(String(output).replace(/^\uFEFF/, ''));
      sample.physicalAvailableBytes = finiteBytes(data.AvailableBytes);
      sample.physicalAvailableKind = 'available';
      sample.commitUsedBytes = finiteBytes(data.CommittedBytes);
      sample.commitLimitBytes = positiveBytes(data.CommitLimit);
      sample.commitEnforced = true;
      sample.pagesInputPerSecond = finiteBytes(data.PagesInputPersec);
      sample.pageReadsPerSecond = finiteBytes(data.PageReadsPersec);
      sample.source = 'windows-memory-counters';
    } else if (process.platform === 'linux') {
      const [meminfo, overcommit] = await Promise.all([
        fs.readFile('/proc/meminfo', 'utf8'),
        fs.readFile('/proc/sys/vm/overcommit_memory', 'utf8').catch(() => '')
      ]);
      const fields = Object.fromEntries([...meminfo.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)]
        .map(([, name, value]) => [name, Number(value) * 1024]));
      sample.physicalTotalBytes = positiveBytes(fields.MemTotal) ?? sample.physicalTotalBytes;
      sample.physicalAvailableBytes = finiteBytes(fields.MemAvailable) ?? sample.physicalAvailableBytes;
      sample.physicalAvailableKind = fields.MemAvailable == null ? 'free' : 'available';
      sample.commitUsedBytes = finiteBytes(fields.Committed_AS);
      sample.commitLimitBytes = positiveBytes(fields.CommitLimit);
      // Linux permits Committed_AS > CommitLimit in normal overcommit modes.
      // Only strict accounting (mode 2) makes this a hard admission constraint.
      sample.commitEnforced = overcommit.trim() === '2';
      sample.source = 'linux-proc-meminfo';
    }
    if (sample.commitUsedBytes != null && sample.commitLimitBytes != null) {
      sample.commitAvailableBytes = Math.max(0, sample.commitLimitBytes - sample.commitUsedBytes);
    }
    if (sample.physicalAvailableBytes == null || sample.physicalTotalBytes == null) {
      sample.error = 'Physical memory counters are unavailable.';
    }
  } catch (error) {
    sample.error = String(error?.message || 'Memory probe failed.').slice(0, 240);
    sample.physicalTotalBytes = positiveBytes(os.totalmem());
    sample.physicalAvailableBytes = finiteBytes(os.freemem());
    sample.physicalAvailableKind = 'free';
    // Failure must not turn last-known commit headroom into a current guarantee.
    sample.commitEnforced = process.platform === 'win32';
  }
  sample.sampledAtMs = Date.now();
  return sample;
}

function createHostMemoryMonitor({
  sample = readHostMemorySample,
  now = Date.now,
  intervalMs = SAMPLE_INTERVAL_MS,
  staleMs = SAMPLE_STALE_MS,
  onSample = () => {}
} = {}) {
  let latest = null;
  let inFlight = null;
  let lastAttemptAt = -Infinity;
  let enabled = false;
  let timer = null;
  let disposed = false;

  function snapshot() {
    const ageMs = latest ? Math.max(0, now() - latest.sampledAtMs) : null;
    return {
      physicalTotalBytes: null, physicalAvailableBytes: null,
      physicalAvailableKind: 'unknown', commitUsedBytes: null,
      commitLimitBytes: null, commitAvailableBytes: null,
      pagesInputPerSecond: null, pageReadsPerSecond: null,
      pagingMeaning: 'Sampled page-in and disk-read rates; not evidence of sustained thrashing.',
      commitEnforced: process.platform === 'win32', source: 'unavailable', error: null,
      ...latest, sampledAtMs: latest?.sampledAtMs ?? null, ageMs,
      stale: ageMs == null || ageMs > staleMs,
      sampling: inFlight != null
    };
  }

  function schedule() {
    if (!enabled || disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, Math.max(1, intervalMs - (now() - lastAttemptAt)));
    timer.unref?.();
  }

  function refresh() {
    if (disposed) return Promise.resolve(snapshot());
    if (inFlight) return inFlight;
    if (now() - lastAttemptAt < intervalMs) {
      schedule();
      return Promise.resolve(snapshot());
    }
    lastAttemptAt = now();
    inFlight = Promise.resolve().then(sample).then(value => {
      latest = {
        ...value,
        sampledAtMs: Number.isFinite(value?.sampledAtMs) ? value.sampledAtMs : now()
      };
    }, error => {
      latest = {
        sampledAtMs: now(), physicalTotalBytes: positiveBytes(os.totalmem()),
        physicalAvailableBytes: finiteBytes(os.freemem()), physicalAvailableKind: 'free',
        commitUsedBytes: null, commitLimitBytes: null, commitAvailableBytes: null,
        commitEnforced: process.platform === 'win32', source: 'node:os',
        error: String(error?.message || error).slice(0, 240)
      };
    }).finally(() => {
      inFlight = null;
      if (!disposed) {
        try { onSample(snapshot()); } catch {}
        schedule();
      }
    }).then(snapshot);
    return inFlight;
  }

  function setEnabled(value) {
    enabled = Boolean(value);
    if (!enabled && timer) { clearTimeout(timer); timer = null; }
    if (enabled) void refresh();
  }

  function dispose() {
    disposed = true;
    enabled = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return Object.freeze({ snapshot, refresh, setEnabled, dispose });
}

function createMemoryAdmissionController({
  monitor,
  now = Date.now,
  reservationBytes = 128 * MIB,
  recoverySamples = 2,
  diagnosticIntervalMs = 10_000,
  startupSettlingMs = 5000
} = {}) {
  let reservedBytes = 0;
  let activeReservations = 0;
  const settlingReservations = [];
  let pressureLatched = false;
  let recoveryCount = 0;
  let evaluatedSample = null;
  let state = 'unknown';
  let reason = 'Waiting for the first memory sample.';
  let lastDiagnosticAt = -Infinity;
  let lastDiagnosticState = '';
  const recentDecisions = [];

  function evaluate() {
    const memory = monitor.snapshot();
    // Readiness can precede large allocations. Return the heavy slot, but
    // retain the startup estimate until a fresh post-settling physical sample.
    // Commit headroom is still checked separately by the normal admission gate.
    if (!memory.stale && memory.physicalTotalBytes > 0 && memory.physicalAvailableBytes != null) {
      for (let index = settlingReservations.length - 1; index >= 0; index -= 1) {
        const credit = settlingReservations[index];
        if (memory.sampledAtMs >= credit.afterMs) {
          reservedBytes = Math.max(0, reservedBytes - credit.bytes);
          settlingReservations.splice(index, 1);
        }
      }
    }
    const physicalFloor = Math.max(256 * MIB, (memory.physicalTotalBytes || 0) * 0.08);
    const physicalRecovery = physicalFloor + 64 * MIB;
    const commitFloor = Math.max(512 * MIB, (memory.commitLimitBytes || 0) * 0.08);
    const commitRecovery = commitFloor + 128 * MIB;
    const physicalKnown = memory.physicalAvailableBytes != null && memory.physicalTotalBytes > 0 && !memory.stale;
    const commitKnown = memory.commitAvailableBytes != null && !memory.stale;
    const lowPhysical = physicalKnown && memory.physicalAvailableBytes <= physicalFloor;
    const lowCommit = memory.commitEnforced && commitKnown && memory.commitAvailableBytes <= commitFloor;
    if (lowPhysical || lowCommit) {
      pressureLatched = true;
      recoveryCount = 0;
    }
    if (memory.sampledAtMs !== evaluatedSample) {
      evaluatedSample = memory.sampledAtMs;
      const recovered = physicalKnown && memory.physicalAvailableBytes >= physicalRecovery
        && (!memory.commitEnforced || (commitKnown && memory.commitAvailableBytes >= commitRecovery));
      if (pressureLatched && recovered) recoveryCount += 1;
      else if (pressureLatched) recoveryCount = 0;
      if (recoveryCount >= recoverySamples) { pressureLatched = false; recoveryCount = 0; }
    }
    state = pressureLatched ? 'pressured'
      : (!physicalKnown || (memory.commitEnforced && !commitKnown)) ? 'unknown' : 'normal';
    reason = pressureLatched
      ? lowCommit ? 'System commit headroom is low.' : lowPhysical ? 'Physical memory headroom is low.' : 'Waiting for sustained memory recovery.'
      : state === 'unknown' ? memory.stale ? 'Memory metrics are unavailable or stale.' : 'Commit headroom is unknown; heavy concurrency is limited to one.'
        : 'Memory headroom permits bounded heavy work.';
    if (state !== lastDiagnosticState && now() - lastDiagnosticAt >= diagnosticIntervalMs) {
      recentDecisions.push({ atMs: now(), state, reason });
      if (recentDecisions.length > 20) recentDecisions.shift();
      lastDiagnosticState = state;
      lastDiagnosticAt = now();
    }
    return { ...memory, state, reason, reservedBytes, activeReservations, reservationBytes,
      settlingReservedBytes: settlingReservations.reduce((total, credit) => total + credit.bytes, 0),
      settlingReservationCount: settlingReservations.length, startupSettlingMs,
      oldestSettlingMs: settlingReservations.length ? Math.max(0, ...settlingReservations.map(credit => now() - credit.releasedAtMs)) : 0,
      settlingReason: settlingReservations.length ? 'Startup estimates await a fresh physical sample after the settling interval.' : null,
      reservationPolicy: 'conservative-until-release', reservationScope: 'finite-operation-or-startup',
      physicalFloorBytes: physicalFloor, physicalRecoveryBytes: physicalRecovery,
      commitFloorBytes: commitFloor, commitRecoveryBytes: commitRecovery, recoveryCount };
  }

  function estimate(options = {}) {
    const requested = positiveBytes(options.reservationBytes);
    // Callers may reserve more than the conservative default, never less.
    return Math.max(reservationBytes, requested || 0);
  }

  function canAdmit(resources, options) {
    if (!resources.includes('heavy')) return { allowed: true };
    const snapshot = evaluate();
    if (snapshot.sampledAtMs == null || snapshot.stale || !(snapshot.physicalTotalBytes > 0)) {
      return { allowed: false, reason: 'Fresh physical memory headroom is unavailable.' };
    }
    if (snapshot.state === 'pressured') return { allowed: false, reason: snapshot.reason };
    if (snapshot.state === 'unknown' && activeReservations >= 1) return { allowed: false, reason: snapshot.reason };
    const reservation = estimate(options);
    if (snapshot.physicalAvailableBytes == null
      || snapshot.physicalAvailableBytes - reservedBytes - reservation < snapshot.physicalFloorBytes) {
      return { allowed: false, reason: 'Heavy memory reservations would consume protected physical headroom.' };
    }
    if (snapshot.commitEnforced && snapshot.commitAvailableBytes != null && !snapshot.stale
      && snapshot.commitAvailableBytes - reservedBytes - reservation < snapshot.commitFloorBytes) {
      return { allowed: false, reason: 'Heavy memory reservations would consume protected commit headroom.' };
    }
    return { allowed: true };
  }

  function reserve(resources, options) {
    if (!resources.includes('heavy')) return () => {};
    const bytes = estimate(options);
    reservedBytes += bytes;
    activeReservations += 1;
    let released = false;
    let settlingCredit = null;
    return ({ settleUntilFreshSample = false, confirmedStopped = false } = {}) => {
      if (released) {
        // An explicit later tree-exit proof can retire only this lease's
        // portion of a settling credit. Generic release remains conservative.
        if (confirmedStopped === true && settlingCredit) {
          const index = settlingReservations.indexOf(settlingCredit);
          if (index >= 0) {
            const ownedBytes = Math.min(bytes, settlingCredit.bytes);
            settlingCredit.bytes -= ownedBytes;
            reservedBytes = Math.max(0, reservedBytes - ownedBytes);
            if (settlingCredit.bytes === 0) settlingReservations.splice(index, 1);
          }
          settlingCredit = null;
        }
        return;
      }
      released = true;
      activeReservations = Math.max(0, activeReservations - 1);
      if (settleUntilFreshSample && confirmedStopped !== true) {
        const releasedAtMs = now();
        const afterMs = releasedAtMs + startupSettlingMs;
        // Keep bookkeeping bounded without losing per-lease release ownership.
        if (settlingReservations.length >= 64) {
          const last = settlingReservations[settlingReservations.length - 1];
          last.bytes += bytes;
          last.afterMs = Math.max(last.afterMs, afterMs);
          settlingCredit = last;
        } else {
          settlingCredit = { bytes, afterMs, releasedAtMs };
          settlingReservations.push(settlingCredit);
        }
      } else reservedBytes = Math.max(0, reservedBytes - bytes);
    };
  }
  function diagnostics() {
    return { ...evaluate(), recentDecisions: recentDecisions.map(entry => ({ ...entry })) };
  }

  return Object.freeze({ canAdmit, reserve, diagnostics,
    hasPendingSettlements: () => settlingReservations.length > 0 });
}

function finiteBytes(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function positiveBytes(value) {
  const number = finiteBytes(value);
  return number != null && number > 0 ? number : null;
}

// Initial headroom estimates only. These do not establish mutation safety,
// bound descendants, or promise the process will stay within the reservation.
function estimateProcessReservationBytes(command, args = [], options = {}) {
  const executable = path.basename(String(command || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const text = [executable, ...(Array.isArray(args) ? args : []), options.commandString || ''].join(' ').toLowerCase().replace(/["']/g, '');
  if (/^(?:emulator|qemu-system.*)$/.test(executable) || /(?:^|[\s/\\])(?:emulator|qemu-system[-\w]*)(?:\.exe)?(?:\s|$)/.test(text)) return 1024 * MIB;
  if (/^(?:gradle|gradlew|mvn|mvnw|javac|java|tsc|webpack|vite|make|cmake|ninja|msbuild|dotnet|cargo|rustc|gcc|g\+\+|clang|clang\+\+)$/.test(executable)) return 768 * MIB;
  if (/(?:^|[\s/\\])(?:gradle|gradlew|mvn|mvnw|javac|tsc|webpack|vite|make|cmake|ninja|msbuild|cargo|rustc)(?:\.(?:cmd|bat|exe))?(?:\s|$)/.test(text)) return 768 * MIB;
  if (/(?:^|[\s/\\])(?:npm|pnpm|yarn|bun|npx)(?:\.(?:cmd|exe))?\s.*\b(?:run|build|test|check|typecheck|lint|tsc|vite|webpack)\b/.test(text)) return 768 * MIB;
  if (/(?:^|[\s/\\])node(?:\.exe)?\s.*(?:test[/\\]|run-tests|build[-./\\]|benchmark[-./\\])/.test(text)) return 768 * MIB;
  return (options.persistent ? 256 : 128) * MIB;
}

export {
  createHostMemoryMonitor, createMemoryAdmissionController,
  estimateProcessReservationBytes
};
