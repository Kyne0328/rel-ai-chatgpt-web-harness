import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restoreWindowsProcessJob } from './windowsProcessJob.ts';
import { validateLinuxMutationCgroup, linuxMutationCgroupEmpty } from './linuxMutationCgroup.js';
import { getStateDir } from './statePaths.js';
import { privatelyOwnedWindowsPaths } from './mutationWindowsStateAcl.js';

const execFileAsync = promisify(execFile);
const unknown = reason => ({ status: 'unknown', reason });

async function nativeJobDirectory(config, reference) {
  const directory = path.resolve(String(reference?.directory || ''));
  const state = path.resolve(getStateDir(config));
  if (path.dirname(directory).toLowerCase() !== path.join(state, 'process-jobs').toLowerCase()
    && !path.dirname(directory).toLowerCase().startsWith(path.join(state, 'processes').toLowerCase() + path.sep)) return null;
  if (!/^job-[\w-]+$/u.test(path.basename(directory)) || !/^[a-f0-9]{64}$/u.test(reference?.nonce || '')) return null;
  const targets = [state, path.dirname(directory), directory, path.join(directory, 'request.json'), path.join(directory, 'receipt.json')];
  for (const file of targets) {
    const stat = fs.lstatSync(file);
    const json = file.endsWith('.json');
    if (stat.isSymbolicLink() || (json ? !stat.isFile() || stat.size > 262144 : !stat.isDirectory())) return null;
  }
  if (fs.realpathSync.native(directory).toLowerCase() !== directory.toLowerCase()) throw new Error('Native job storage was redirected.');
  if (!await privatelyOwnedWindowsPaths(targets)) throw new Error('Native job storage ownership could not be verified.');
  return directory;
}

function pidAbsent(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

async function inspectStoppedWsl(request, job) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'wsl.exe');
  if (path.resolve(request.executable || '').toLowerCase() !== executable.toLowerCase()) return null;
  const args = request.args;
  if (!Array.isArray(args) || !args.every(value => typeof value === 'string')) return unknown('The retained WSL invocation is invalid.');
  let distribution = '';
  for (let index = 0; index < args.length; index++) {
    if (['--', '--exec', '-e'].includes(args[index])) break;
    if (['-d', '--distribution'].includes(args[index])) { distribution = args[index + 1] || ''; break; }
    if (args[index].startsWith('--distribution=')) { distribution = args[index].slice(15); break; }
  }
  const receipt = job.receipt();
  if (!receipt || !pidAbsent(receipt.helperPid) || !pidAbsent(receipt.rootPid))
    return unknown('The original WSL launcher has not been confirmed stopped.');
  const names = async running => {
    const { stdout } = await execFileAsync(executable, ['--list', ...(running ? ['--running'] : []), '--quiet'], {
      windowsHide: true, encoding: 'buffer', timeout: 5000, maxBuffer: 65536
    });
    // wsl.exe emits UTF-16LE on Windows, including an optional BOM.
    return stdout.toString('utf16le').replace(/^\uFEFF/u, '').split(/[\r\n]+/u).map(name => name.trim().toLowerCase()).filter(Boolean);
  };
  const registered = await names(false);
  if (!distribution) {
    if (registered.length === 1) {
      distribution = registered[0];
    } else if (registered.length > 1) {
      try {
        const { stdout } = await execFileAsync(executable, ['--list'], {
          windowsHide: true, encoding: 'buffer', timeout: 5000, maxBuffer: 65536
        });
        const text = stdout.toString('utf16le').replace(/^\uFEFF/u, '');
        for (const line of text.split(/[\r\n]+/u)) {
          const match = /^\s*([^\r\n(]+?)\s*\(\s*default\s*\)/iu.exec(line);
          if (match) { distribution = match[1].trim(); break; }
        }
      } catch {}
    }
  }
  const running = await names(true);
  if (running.length === 0 && registered.length > 0 && (!distribution || registered.includes(distribution.toLowerCase()))) {
    return { status: 'stopped', reason: 'verified-wsl-distribution-stopped' };
  }
  if (!distribution) return unknown('The original WSL distribution identity was not retained.');
  if (!registered.includes(distribution.toLowerCase())) return unknown('The recorded WSL distribution cannot be identified in the current account.');
  if (!running.includes(distribution.toLowerCase())) return { status: 'stopped', reason: 'verified-wsl-distribution-stopped' };
  if (!request.guestScope || request.guestScope.nonce !== request.nonce)
    return unknown('The original WSL distribution is running, but this older execution has no independently queryable guest scope.');
  const file = path.join(job.directory, 'guest-scope.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return unknown('The retained guest scope is invalid.');
  const scope = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (scope.nonce !== request.nonce || !/^[a-f0-9-]{36}$/u.test(scope.boot || '')
    || !/^\/sys\/fs\/cgroup\/[a-zA-Z0-9_./:@-]+$/u.test(scope.directory || '')
    || scope.directory.split('/').includes('..') || !scope.directory.endsWith('/relai-mutation-' + request.nonce)) return unknown('The guest scope identity changed.');
  const { stdout } = await execFileAsync(executable, ['-d', distribution, '--exec', '/bin/sh', '-c',
    'boot=$(cat /proc/sys/kernel/random/boot_id) || exit 125; printf "%s\\n" "$boot"; [ "$boot" != "$2" ] || cat "$1/cgroup.events"', 'relai-inspect', scope.directory, scope.boot], {
    windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 8192
  });
  const [boot, ...events] = stdout.trim().split(/\r?\n/u);
  if (!/^[a-f0-9-]{36}$/u.test(boot)) return unknown('The current guest boot identity is unavailable.');
  if (boot !== scope.boot) return { status: 'stopped', reason: 'verified-wsl-guest-boot' };
  if (events.includes('populated 0')) return { status: 'stopped', reason: 'verified-wsl-cgroup-empty' };
  if (events.includes('populated 1')) return { status: 'running', reason: 'verified-wsl-cgroup-populated' };
  return unknown('The owned WSL cgroup cannot be inspected.');
}

// One recovery contract for every execution owner. Recorded status and absent
// root PIDs never substitute for kernel containment or execution-host evidence.
async function inspectOwnedExecution(config, record) {
  try {
    if (record.nativeCgroup) {
      return linuxMutationCgroupEmpty(record.nativeCgroup)
        ? { status: 'stopped', reason: 'verified-linux-cgroup-empty' }
        : validateLinuxMutationCgroup(record.nativeCgroup)
          ? { status: 'running', reason: 'verified-linux-cgroup-populated' }
          : unknown('The owned Linux cgroup cannot be inspected.');
    }
    if (!record.nativeJob) return unknown('This older execution has no independently queryable process container.');
    const directory = await nativeJobDirectory(config, record.nativeJob);
    if (!directory) return unknown('The native job reference cannot be verified.');
    const request = JSON.parse(fs.readFileSync(path.join(directory, 'request.json'), 'utf8'));
    if (request.nonce !== record.nativeJob.nonce) return unknown('The native execution identity changed.');
    let helperPid = record.pid;
    if (helperPid === 0 && record.phase === 'preparing') {
      // The parent can crash after native admission but before attaching the
      // helper PID. Its private nonce-bound receipt is the launch handshake.
      const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8'));
      if (receipt.protocol !== 1 || receipt.nonce !== request.nonce || !Number.isSafeInteger(receipt.helperPid)
        || receipt.helperPid <= 0) return unknown('The native admission handshake is unavailable.');
      helperPid = receipt.helperPid;
    }
    const job = restoreWindowsProcessJob(directory, helperPid);
    if (!job) return unknown('The retained native job control identity is invalid.');
    const observed = await job.inspect();
    if (observed.status === 'running') return observed;
    const guest = await inspectStoppedWsl(request, job);
    return guest || (observed.status === 'stopped' && observed.reason === 'verified-native-receipt'
      ? { status: 'stopped', reason: 'verified-native-job-zero' } : observed);
  } catch (error) { return unknown(`Execution inspection failed: ${String(error.message || error)}`); }
}

export { inspectOwnedExecution };
