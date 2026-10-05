// Deliberately adverse fixture, never a production pressure bypass.
import os from 'node:os';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

export function installForcedLowHostMemory() {
  const originals = { totalmem: os.totalmem, freemem: os.freemem, readFile: fs.readFile, execFile: childProcess.execFile };
  os.totalmem = () => 16 * 1024 ** 3;
  os.freemem = () => 64 * 1024 ** 2;
  fs.readFile = function (file, ...args) {
    if (String(file) === '/proc/meminfo') return Promise.resolve('MemTotal: 16777216 kB\nMemAvailable: 65536 kB\nCommitted_AS: 5242880 kB\nCommitLimit: 16777216 kB\n');
    if (String(file) === '/proc/sys/vm/overcommit_memory') return Promise.resolve('0\n');
    return originals.readFile.call(this, file, ...args);
  };
  childProcess.execFile = function (file, args, options, callback) {
    if (Array.isArray(args) && args.some(value => String(value).includes('Win32_PerfFormattedData_PerfOS_Memory'))) {
      queueMicrotask(() => callback(null, JSON.stringify({ AvailableBytes: 64 * 1024 ** 2, CommittedBytes: 5 * 1024 ** 3, CommitLimit: 16 * 1024 ** 3 }), ''));
      return { kill() { return true; } };
    }
    return originals.execFile.call(this, file, args, options, callback);
  };
  syncBuiltinESMExports();
  return () => {
    os.totalmem = originals.totalmem;
    os.freemem = originals.freemem;
    fs.readFile = originals.readFile;
    childProcess.execFile = originals.execFile;
    syncBuiltinESMExports();
  };
}
