// User-invoked, one-shot Windows launcher. It never quits or kills the app.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const flag = 'REL_AI_MCP_TRANSPORT_TIMING';
const args = new Set(process.argv.slice(2));
for (const arg of args) if (!['--check', '--without-timing'].includes(arg)) throw new Error('Use --check or --without-timing only.');
if (process.platform !== 'win32') throw new Error('This launcher is for the verified Windows installation.');
if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is unavailable.');
const executable = path.join(process.env.LOCALAPPDATA, 'Programs', 'Rel.AI MCP', 'Rel.AI MCP.exe');
if (!fs.statSync(executable).isFile()) throw new Error('The verified Rel.AI MCP installation is unavailable.');

const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const output = execFileSync(powershell, [
  '-NoProfile', '-NonInteractive', '-Command',
  "Get-CimInstance Win32_Process -Filter \"Name='Rel.AI MCP.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 }).trim();
const parsed = output ? JSON.parse(output) : [];
const processes = Array.isArray(parsed) ? parsed : [parsed];
const withoutTiming = args.has('--without-timing');
if (args.has('--check')) {
  console.log(JSON.stringify({ executableExists: true, readyToLaunch: processes.length === 0, runningProcesses: processes.length, timingEnabledForNewApp: !withoutTiming, launched: false }));
} else {
  if (processes.length) throw new Error('Rel.AI MCP is still running. Choose Quit Rel.AI MCP from its tray menu, then run this command again. No app was launched.');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === flag) delete env[key];
  if (!withoutTiming) env[flag] = '1';
  // The flag exists only in the new app environment. No registry, profile,
  // scheduled task, startup setting, watcher, or persistent launcher is created.
  const child = spawn(executable, [], { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.once('error', error => { console.error('Rel.AI launch failed: ' + error.message); process.exitCode = 1; });
  child.once('spawn', () => {
    console.log(withoutTiming ? 'Rel.AI MCP launched without transport timing.' : 'Rel.AI MCP launched with transport timing enabled for this run.');
    child.unref();
  });
}
