import fs from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Windows file modes are synthetic. Check native write authority asynchronously
// before relying on the short-lived, metadata-bound result for local operations.
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$paths = @(ConvertFrom-Json -InputObject $env:RELAI_MUTATION_ACL_PATHS)",
  "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
  "$trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')",
  "$writeMask = 0x000D0156",
  "foreach ($path in $paths) {",
  "  $acl = Get-Acl -LiteralPath $path",
  "  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
  "  if ($owner -ne $me) { exit 1 }",
  "  foreach ($rule in $acl.Access) {",
  "    if ($rule.AccessControlType -ne 'Allow') { continue }",
  "    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
  "    if ($trusted -notcontains $sid -and (([int]$rule.FileSystemRights -band $writeMask) -ne 0)) { exit 1 }",
  "  }",
  "}",
  "[Console]::Out.Write('OK')"
].join('; ');

const checked = new Map();
function fingerprint(file) {
  const stat = fs.lstatSync(file);
  return [stat.dev, stat.ino, stat.ctimeMs, stat.mtimeMs, stat.size, stat.mode, stat.nlink].join(':');
}
function privatelyOwnedWindowsState(file) {
  if (process.platform !== 'win32') return false;
  try {
    const proof = checked.get(path.resolve(file));
    return Boolean(proof && Date.now() - proof.at < 5000 && proof.stamp === fingerprint(file));
  } catch { return false; }
}
async function privatelyOwnedWindowsPaths(files) {
  if (process.platform !== 'win32') return false;
  try {
    const unique = [...new Set(files.map(file => path.resolve(file)))];
    const unknown = unique.filter(file => !privatelyOwnedWindowsState(file));
    if (!unknown.length) return true;
    const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    for (let i = 0; i < unknown.length; i += 32) {
      const batch = unknown.slice(i, i + 32);
      const before = batch.map(fingerprint);
      const { stdout } = await execFileAsync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
        env: { ...process.env, RELAI_MUTATION_ACL_PATHS: JSON.stringify(batch) },
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096
      });
      if (stdout !== 'OK') return false;
      const at = Date.now();
      for (let j = 0; j < batch.length; j++) {
        if (fingerprint(batch[j]) !== before[j]) return false;
        checked.set(batch[j], { stamp: before[j], at });
      }
    }
    if (checked.size > 5000) checked.clear();
    return true;
  } catch { return false; }
}
export { privatelyOwnedWindowsState, privatelyOwnedWindowsPaths };
