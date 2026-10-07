import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { WindowsProcessJob } from '../../src/windowsProcessJob.ts';

// Isolated test/benchmark instrumentation. Production Git sanitizes GIT_TRACE,
// so count real direct spawns and validated native target-start receipts instead
// of weakening environment protections or counting controller requests as Git.
async function withGitProcessCounts(run) {
  const original = childProcess.spawn;
  const originalReceipt = WindowsProcessJob.prototype.receipt;
  const nativeLaunches = new Map();
  const countedNativeLaunches = new Set();
  const counts = { status: 0, head: 0, total: 0 };
  let incompleteNativeCounts = 0;
  const count = args => {
    counts.total += 1;
    if (Array.isArray(args) && args.includes('status')) counts.status += 1;
    if (Array.isArray(args) && args.includes('rev-parse') && args.includes('HEAD')) counts.head += 1;
  };
  childProcess.spawn = function(command, args, ...rest) {
    if (/^git(?:\.exe)?$/i.test(path.basename(String(command)))) count(args);
    const child = original.call(this, command, args, ...rest);
    const requestFlag = process.platform === 'win32' && Array.isArray(args) ? args.indexOf('-RequestPath') : -1;
    if (requestFlag >= 0 && Number.isSafeInteger(child.pid) && child.pid > 0) {
      try {
        const request = readNativeRequest(path.dirname(args[requestFlag + 1]));
        if (request.protocol !== 1 || !/^[a-f0-9]{64}$/.test(request.nonce)
          || !Array.isArray(request.args)) throw new Error('Invalid native request identity.');
        nativeLaunches.set(request.nonce + ':' + child.pid, request);
      } catch { incompleteNativeCounts += 1; }
    }
    return child;
  };
  WindowsProcessJob.prototype.receipt = function(...args) {
    const receipt = originalReceipt.apply(this, args);
    const key = receipt?.nonce + ':' + receipt?.helperPid;
    const request = nativeLaunches.get(key);
    if (request && !countedNativeLaunches.has(key) && receipt?.commandStarted === true) {
      countedNativeLaunches.add(key);
      if (request.protocol !== receipt.protocol
        || !Number.isSafeInteger(receipt.rootPid) || receipt.rootPid <= 0) {
        incompleteNativeCounts += 1;
      } else if (/^git(?:\.exe)?$/i.test(path.basename(String(request.executable)))) count(request.args);
    }
    return receipt;
  };
  syncBuiltinESMExports();
  try {
    const result = await run();
    if (incompleteNativeCounts) throw new Error('Native Git process counting was incomplete for ' + incompleteNativeCounts + ' job(s).');
    return { result, counts };
  } finally {
    childProcess.spawn = original;
    WindowsProcessJob.prototype.receipt = originalReceipt;
    syncBuiltinESMExports();
  }
}

function readNativeRequest(directory) {
  const limit = 256 * 1024;
  const fd = fs.openSync(path.join(directory, 'request.json'), 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > limit) throw new Error('Native request metadata exceeds the counter budget.');
    return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

export { withGitProcessCounts };
