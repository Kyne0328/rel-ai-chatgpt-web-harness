import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

// The kernel/bootloader boot GUID is a version-sensitive Windows API.
// A failed probe is never treated as evidence of a reboot.
const SCRIPT = "$ErrorActionPreference = 'Stop'\n$source = @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class RelaiBootSession {\n  [DllImport(\"ntdll.dll\", ExactSpelling=true)]\n  private static extern int NtQuerySystemInformation(int informationClass, IntPtr buffer, int length, out int used);\n  public static string GetBootIdentifier() {\n    IntPtr buffer = Marshal.AllocHGlobal(32);\n    try {\n      int used;\n      int status = NtQuerySystemInformation(90, buffer, 32, out used);\n      if (status < 0 || used < 16) throw new InvalidOperationException(\"Native boot identity unavailable\");\n      byte[] bytes = new byte[16];\n      Marshal.Copy(buffer, bytes, 0, bytes.Length);\n      return new Guid(bytes).ToString(\"D\");\n    } finally {\n      Marshal.FreeHGlobal(buffer);\n    }\n  }\n}\n'@\nAdd-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop\n$machine = (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid\n$boot = [RelaiBootSession]::GetBootIdentifier()\n[Console]::Out.Write(\"$machine|$boot\")";

async function readWindowsBootIdentifiers() {
  if (process.platform !== 'win32') return null;
  try {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 1024
    });
    const output = stdout.trim();
    const parts = output.split('|');
    if (parts.length !== 2) return null;
    return { host: parts[0], boot: parts[1] };
  } catch {
    return null;
  }
}
export { readWindowsBootIdentifiers };
