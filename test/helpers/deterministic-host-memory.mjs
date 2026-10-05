// Lifecycle tests must be independent of unrelated host workloads. Resource
// pressure/admission policy is covered separately with synthetic samples.
import os from 'node:os';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export function installDeterministicHostMemory() {
  const totalmem = os.totalmem;
  const freemem = os.freemem;
  const readFile = fs.readFile;
  const execFile = childProcess.execFile;
  const gib = 1024 ** 3;
  os.totalmem = () => 16 * gib;
  os.freemem = () => 12 * gib;
  fs.readFile = function (file, ...args) {
    if (String(file) === '/proc/meminfo') return Promise.resolve('MemTotal: 16777216 kB\nMemAvailable: 12582912 kB\nCommitted_AS: 1048576 kB\nCommitLimit: 16777216 kB\n');
    if (String(file) === '/proc/sys/vm/overcommit_memory') return Promise.resolve('0\n');
    return readFile.call(this, file, ...args);
  };
  childProcess.execFile = function (file, args, options, callback) {
    if (Array.isArray(args) && args.some(value => String(value).includes('Win32_PerfFormattedData_PerfOS_Memory'))) {
      queueMicrotask(() => callback(null, JSON.stringify({ AvailableBytes: 12 * gib, CommittedBytes: gib, CommitLimit: 16 * gib }), ''));
      return { kill() { return true; } };
    }
    return execFile.call(this, file, args, options, callback);
  };
  syncBuiltinESMExports();
  return () => {
    os.totalmem = totalmem;
    os.freemem = freemem;
    fs.readFile = readFile;
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
  };
}
