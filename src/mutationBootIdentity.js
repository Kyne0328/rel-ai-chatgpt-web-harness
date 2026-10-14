import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { readWindowsBootIdentifiers } from './windowsBootIdentity.js';

// Read once per runtime: a process cannot outlive a kernel reboot. Neither
// uptime nor an absent PID is proof of a reboot.
let cached;
let pending = null;
async function readMutationBootIdentity() {
  if (cached !== undefined) return cached;
  try {
    let host = '';
    let boot = '';
    if (process.platform === 'linux') {
      host = fs.readFileSync('/etc/machine-id', 'utf8').trim();
      boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } else if (process.platform === 'darwin') {
      const { stdout: registry } = await execFileAsync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024
      });
      host = /"IOPlatformUUID"\s*=\s*"([\da-f-]+)"/iu.exec(registry)?.[1] || '';
      for (const key of ['kern.bootsessionuuid', 'kern.bootuuid']) {
        try {
          const { stdout } = await execFileAsync('/usr/sbin/sysctl', ['-n', key], {
            encoding: 'utf8', timeout: 5000, maxBuffer: 1024
          });
          boot = stdout.trim();
          if (/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(boot)) break;
          boot = '';
        } catch { boot = ''; }
      }
    } else if (process.platform === 'win32') {
      const native = await readWindowsBootIdentifiers();
      if (!native) return (cached = null);
      host = native.host;
      boot = native.boot;
    } else {
      return (cached = null);
    }
    const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
    const hostValid = process.platform === 'linux' ? /^[\da-f]{32}$/iu.test(host) : uuid.test(host);
    if (!hostValid || !uuid.test(boot) || /^0+$/.test(host.replaceAll('-', ''))
      || /^0+$/.test(boot.replaceAll('-', ''))) return (cached = null);
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    return (cached = Object.freeze({
      platform: process.platform,
      host: hash(process.platform + ':' + host.toLowerCase()),
      boot: hash(process.platform + ':' + boot.toLowerCase())
    }));
  } catch {
    return (cached = null);
  }
}
function currentMutationBootIdentity() {
  if (cached !== undefined) return Promise.resolve(cached);
  if (!pending) pending = readMutationBootIdentity().finally(() => { pending = null; });
  return pending;
}
export { currentMutationBootIdentity };
