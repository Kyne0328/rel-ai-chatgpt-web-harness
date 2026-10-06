import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { makeProcessEnvironment } from './processEnvironment.js';

const SAMPLE_INTERVAL_MS = 5000;
const SAMPLE_STALE_MS = 15_000;

// Memory measurements are diagnostic only and never acquire an execution lease.
async function readHostMemorySample() {
  const sample = {
    sampledAtMs: Date.now(),
    physicalTotalBytes: positiveBytes(os.totalmem()),
    physicalAvailableBytes: finiteBytes(os.freemem()),
    physicalAvailableKind: 'free',
    commitUsedBytes: null,
    commitLimitBytes: null,
    commitAvailableBytes: null,
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
        ], { windowsHide: true, timeout: 5000, maxBuffer: 8192, encoding: 'utf8',
          env: makeProcessEnvironment({ PSModulePath: path.join(path.dirname(executable), 'Modules') }, { allow: [] }) },
        (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const data = JSON.parse(String(output).replace(/^\uFEFF/, ''));
      sample.physicalAvailableBytes = finiteBytes(data.AvailableBytes);
      sample.physicalAvailableKind = 'available';
      sample.commitUsedBytes = finiteBytes(data.CommittedBytes);
      sample.commitLimitBytes = positiveBytes(data.CommitLimit);
      sample.pagesInputPerSecond = finiteBytes(data.PagesInputPersec);
      sample.pageReadsPerSecond = finiteBytes(data.PageReadsPersec);
      sample.source = 'windows-memory-counters';
    } else if (process.platform === 'linux') {
      const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
      const fields = Object.fromEntries([...meminfo.matchAll(/^(\w+):\s+(\d+)\s+kB$/gm)]
        .map(([, name, value]) => [name, Number(value) * 1024]));
      sample.physicalTotalBytes = positiveBytes(fields.MemTotal) ?? sample.physicalTotalBytes;
      sample.physicalAvailableBytes = finiteBytes(fields.MemAvailable) ?? sample.physicalAvailableBytes;
      sample.physicalAvailableKind = fields.MemAvailable == null ? 'free' : 'available';
      sample.commitUsedBytes = finiteBytes(fields.Committed_AS);
      sample.commitLimitBytes = positiveBytes(fields.CommitLimit);
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
      source: 'unavailable', error: null,
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
        source: 'node:os',
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

function finiteBytes(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function positiveBytes(value) {
  const number = finiteBytes(value);
  return number != null && number > 0 ? number : null;
}

export { createHostMemoryMonitor };
